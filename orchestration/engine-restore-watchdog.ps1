# engine-restore-watchdog.ps1 -- 引擎恢复守护（独立于 Harness）。
#
# 出图前 engine-control.ps1 unload 会落一个 engine.pending-restore.json。
# 正常情况由出图链路自己 restore 并删标记；下面三种情况则由本守护兜底：
#   1. 宿主进程死了（ownerPid 不存在）—— 出图的 finally 永远不会跑；
#   2. 工具异常/被中断，restore 没执行；
#   3. 出图卡死超过 maxDrawMs（默认 15 分钟）。
# 拉起引擎统一走 engine-control.ps1 -Action restore，它内部只调用
# start-ninfer.ps1；engine.stop 仍然只由 stop-ninfer.ps1 写。
#
# 2026-11-14 增加 completion 判据：/health 200 但真实 completion 连续失败时也要重启。
#   - 与 /health 完全独立的一套阈值/退避参数（Completion*）；
#   - 只在「端口在听 + /health 200 + 距引擎最近一次 up 已过 CompletionWarmupSec」时探测，
#     模型加载期的 503 落在 warmup 内，不会被误判；
#   - 4xx（模型名/参数错误）只记日志，不计入重启阈值；
#   - 任一判据触发重启后，另一判据共享冷却，避免同一时刻重复重启。
#
# 启动方式（start-dsh.ps1 里）：wscript //B run-detached.vbs -> 本脚本，全程无窗口。
param(
    [string]$LogDir = 'Y:\dsh\2026-11-10\infer-deploy\work\logs',
    [int]$IntervalSec = 5,
    [int]$Port = 8094,
    [int]$MaxDrawSec = 900,
    [int]$HealthFailThreshold = 12,
    [int]$HealthTimeoutSec = 3,
    [int]$RestartBackoffSec = 120,
    [int]$RestartBackoffMaxSec = 900,
    # === completion 判据（与 /health 分开） ===
    [int]$CompletionFailThreshold = 4,
    [int]$CompletionProbeIntervalSec = 30,
    [int]$CompletionTimeoutSec = 20,
    [int]$CompletionWarmupSec = 180,
    [int]$CompletionBackoffSec = 120,
    [int]$CompletionBackoffMaxSec = 900,
    [string]$CompletionModel = 'bonsai-2-27b',
    [int]$CompletionMaxTokens = 1,
    [switch]$Once,
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$PowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$controlScript = 'Y:\workspace\ninfer\engine-control.ps1'
$marker = Join-Path $LogDir 'engine.pending-restore.json'
$logFile = Join-Path $LogDir 'engine-restore-watchdog.log'
$pidFile = Join-Path $LogDir 'engine-restore-watchdog.pid'
$stateFile = Join-Path $LogDir 'engine-restore-watchdog.state.json'

if (-not (Test-Path -LiteralPath $LogDir)) {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
}

function Write-WatchLog([string]$Line) {
    try {
        "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Line" |
            Out-File -FilePath $logFile -Encoding utf8 -Append
    }
    catch {
        # 日志失败不影响守护
    }
}

# 单实例：pid 文件里那个进程还活着就不再起第二个。
if (-not $Once -and -not $DryRun) {
    if (Test-Path -LiteralPath $pidFile) {
        $oldPid = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($oldPid -and (Get-Process -Id ([int]$oldPid) -ErrorAction SilentlyContinue)) {
            Write-WatchLog "another instance is alive (pid $oldPid), exit"
            exit 0
        }
    }
    Set-Content -LiteralPath $pidFile -Value $PID -Encoding ascii
}

function Test-EngineUp {
    try {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1
        return ($null -ne $conn)
    }
    catch {
        return $false
    }
}

# 健康探针：只看 /health。端口在听不等于能推理：2026-11-14 02:02Z 起引擎进入
# unavailable 闩锁，8094 在听、/v1/models 200，但所有 completion 都是 503。
function Get-EngineHealthCode {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec $HealthTimeoutSec -Uri "http://127.0.0.1:$Port/health"
        return [int]$r.StatusCode
    }
    catch {
        try {
            if ($null -ne $_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        }
        catch { }
        return 0
    }
}

# 真实 completion 探针：不只看 /health，直接打一次最小推理请求。
# 200 = 健康；5xx / 超时 = 失败（计入阈值）；4xx = 配置问题，不计入重启阈值。
function Invoke-CompletionProbe {
    $body = @{
        model      = $CompletionModel
        messages   = @(@{ role = 'user'; content = 'ping' })
        max_tokens = $CompletionMaxTokens
        temperature = 0
        stream     = $false
    } | ConvertTo-Json -Depth 6 -Compress
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Method Post -TimeoutSec $CompletionTimeoutSec `
            -Uri "http://127.0.0.1:$Port/v1/chat/completions" `
            -ContentType 'application/json' -Body $body -ErrorAction Stop
        return @{ ok = $true; code = [int]$r.StatusCode; detail = 'completion 200' }
    }
    catch {
        $code = 0
        try {
            if ($null -ne $_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        }
        catch { }
        $detail = if ($code -eq 0) { "completion 超时/连接失败：$($_.Exception.Message)" } else { "completion HTTP $code" }
        return @{ ok = $false; code = $code; detail = $detail }
    }
}

if ($DryRun) {
    $up = Test-EngineUp
    $healthCode = if ($up) { Get-EngineHealthCode } else { 0 }
    $probe = $null
    if ($up -and $healthCode -eq 200) { $probe = Invoke-CompletionProbe }
    [pscustomobject]@{
        port         = $Port
        engineUp     = $up
        healthCode   = $healthCode
        pendingMarker = (Test-Path -LiteralPath $marker)
        health       = [ordered]@{
            failThreshold = $HealthFailThreshold
            timeoutSec    = $HealthTimeoutSec
            backoffSec    = $RestartBackoffSec
            backoffMaxSec = $RestartBackoffMaxSec
        }
        completion   = [ordered]@{
            failThreshold  = $CompletionFailThreshold
            intervalSec    = $CompletionProbeIntervalSec
            timeoutSec     = $CompletionTimeoutSec
            warmupSec      = $CompletionWarmupSec
            backoffSec     = $CompletionBackoffSec
            backoffMaxSec  = $CompletionBackoffMaxSec
            model          = $CompletionModel
            maxTokens      = $CompletionMaxTokens
        }
        completionProbe = $probe
        note         = 'DryRun：不重启、不写标记、不写 pid；引擎未运行时 completionProbe 为 null。'
    } | ConvertTo-Json -Depth 6
    exit 0
}

function Test-Tick {
    if (-not (Test-Path -LiteralPath $marker)) {
        return $false
    }
    $info = $null
    try {
        $info = Get-Content -LiteralPath $marker -Raw -ErrorAction Stop | ConvertFrom-Json
    }
    catch {
        # 标记写坏了：按文件时间兜底，超过 MaxDrawSec 就恢复。
        try {
            $ageMs = ((Get-Date) - (Get-Item -LiteralPath $marker).LastWriteTime).TotalMilliseconds
            $info = [pscustomobject]@{ ownerPid = 0; createdAt = $null; maxDrawMs = $MaxDrawSec * 1000; ageMs = $ageMs }
        }
        catch {
            return $false
        }
    }
    $ownerPid = 0
    try { $ownerPid = [int]$info.ownerPid } catch { $ownerPid = 0 }
    $maxDrawMs = $MaxDrawSec * 1000
    try { if ($info.maxDrawMs) { $maxDrawMs = [int]$info.maxDrawMs } } catch { }
    $ageMs = 0
    if ($info.PSObject.Properties.Name -contains 'ageMs') {
        $ageMs = [double]$info.ageMs
    }
    elseif ($info.createdAt) {
        try { $ageMs = ((Get-Date) - [datetime]::Parse([string]$info.createdAt)).TotalMilliseconds } catch { $ageMs = 0 }
    }
    else {
        try { $ageMs = ((Get-Date) - (Get-Item -LiteralPath $marker).LastWriteTime).TotalMilliseconds } catch { $ageMs = 0 }
    }
    $ownerAlive = $false
    if ($ownerPid -gt 0) {
        $ownerAlive = $null -ne (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)
    }
    # 出图还在跑（owner 活着且没超时）就不动，避免抢显存把图打断。
    if ($ownerAlive -and $ageMs -lt $maxDrawMs) {
        return $false
    }
    if (Test-EngineUp) {
        # 卸载进行中：stop-ninfer 已写 engine.stop，但引擎还没退干净。这时删标记会
        # 丢掉"待恢复"的记账（宿主正好在这几秒里死了就再也拉不回来），先等下一 tick。
        $stopFlag = Join-Path $LogDir 'engine.stop'
        if ((Test-Path -LiteralPath $stopFlag) -and $ageMs -lt 120000) {
            return $false
        }
        Remove-Item -LiteralPath $marker -ErrorAction SilentlyContinue
        Write-WatchLog "engine already up; cleared stale marker (owner=$($info.owner) pid=$ownerPid age=${ageMs}ms)"
        return $false
    }
    Write-WatchLog "restoring engine (owner=$($info.owner) pid=$ownerPid alive=$ownerAlive age=${ageMs}ms reason=$($info.reason))"
    & $PowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $controlScript `
        -Action restore -LogDir $LogDir -Port $Port -Owner 'engine-restore-watchdog'
    $ok = ($LASTEXITCODE -eq 0)
    Write-WatchLog ("restore " + $(if ($ok) { 'OK' } else { "FAILED (exit $LASTEXITCODE)" }))
    return (-not $ok)
}

if ($Once) {
    $needRetry = Test-Tick
    exit $(if ($needRetry) { 1 } else { 0 })
}

Write-WatchLog "watchdog started pid=$PID interval=${IntervalSec}s health-threshold=$HealthFailThreshold completion-threshold=$CompletionFailThreshold/${CompletionProbeIntervalSec}s warmup=${CompletionWarmupSec}s"
$retryAt = [datetime]::MinValue
$healthFails = 0
$healthyStreak = 0
$backoffSec = 0
$nextRestartAt = [datetime]::MinValue
# completion 判据状态：与 /health 的计数和退避完全分开。
$completionFails = 0
$completionHealthyStreak = 0
$completionBackoffSec = 0
$nextCompletionRestartAt = [datetime]::MinValue
$nextCompletionProbeAt = [datetime]::MinValue
$engineUpSince = $null
$lastCompletionCode = 0
$lastCompletionDetail = ''
while ($true) {
    try {
        if ((Get-Date) -ge $retryAt) {
            if (Test-Tick) {
                # 失败后 60 秒再试，避免疯狂拉起。
                $retryAt = (Get-Date).AddSeconds(60)
            }
        }
        # 健康闩锁兜底：只在"端口在听 + 无出图标记 + 不在退避期"时探 /health。
        # 连续 N 次非 200 才重启。N=12 × 5s = 60s：今天实测模型加载期间 /health
        # 会 503 约 25s（11:38:44→11:39:09），60s 留了 2 倍余量，不会把正常加载当故障。
        if ((Get-Date) -ge $nextRestartAt -and -not (Test-Path -LiteralPath $marker) -and (Test-EngineUp)) {
            $code = Get-EngineHealthCode
            if ($code -eq 200) {
                $healthFails = 0
                $healthyStreak++
                if ($healthyStreak -ge 3 -and $backoffSec -gt 0) {
                    Write-WatchLog "engine health recovered; reset restart backoff"
                    $backoffSec = 0
                }
            }
            else {
                $healthyStreak = 0
                $healthFails++
                if ($healthFails -eq 1 -or $healthFails -ge $HealthFailThreshold) {
                    Write-WatchLog "engine health code=$code streak=$healthFails/$HealthFailThreshold"
                }
                if ($healthFails -ge $HealthFailThreshold) {
                    if ($backoffSec -le 0) { $backoffSec = $RestartBackoffSec }
                    else { $backoffSec = [Math]::Min($backoffSec * 2, $RestartBackoffMaxSec) }
                    Write-WatchLog "engine unhealthy ${healthFails} ticks; restarting (backoff ${backoffSec}s)"
                    & $PowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $controlScript `
                        -Action restart -LogDir $LogDir -Port $Port -Owner 'engine-restore-watchdog'
                    Write-WatchLog ("health-restart exit=$LASTEXITCODE")
                    $healthFails = 0
                    $nextRestartAt = (Get-Date).AddSeconds($backoffSec)
                    $retryAt = (Get-Date).AddSeconds(60)
                }
            }
        }

        # completion 判据：只在「引擎在听 + 已过 warmup + /health 200 + 无出图标记 + 不在退避期」时探测。
        # warmup 用来避开模型加载期的 503；4xx 视为配置问题，不计入重启阈值。
        $engineUpNow = Test-EngineUp
        if (-not $engineUpNow) {
            $engineUpSince = $null
            $completionFails = 0
            $completionHealthyStreak = 0
        }
        else {
            if ($null -eq $engineUpSince) {
                $engineUpSince = Get-Date
                $nextCompletionProbeAt = $engineUpSince.AddSeconds($CompletionWarmupSec)
            }
            $warmedUp = ((Get-Date) - $engineUpSince).TotalSeconds -ge $CompletionWarmupSec
            if ($warmedUp -and (Get-Date) -ge $nextCompletionProbeAt `
                -and (Get-Date) -ge $nextCompletionRestartAt `
                -and -not (Test-Path -LiteralPath $marker) `
                -and (Get-EngineHealthCode) -eq 200) {
                $nextCompletionProbeAt = (Get-Date).AddSeconds($CompletionProbeIntervalSec)
                $previousCode = $lastCompletionCode
                $probe = Invoke-CompletionProbe
                $lastCompletionCode = [int]$probe.code
                $lastCompletionDetail = [string]$probe.detail
                if ($probe.ok) {
                    $completionFails = 0
                    $completionHealthyStreak++
                    if ($completionHealthyStreak -ge 3 -and $completionBackoffSec -gt 0) {
                        Write-WatchLog "engine completion recovered; reset completion backoff"
                        $completionBackoffSec = 0
                    }
                }
                elseif ($probe.code -ge 500 -or $probe.code -eq 0) {
                    $completionHealthyStreak = 0
                    $completionFails++
                    if ($completionFails -eq 1 -or $completionFails -ge $CompletionFailThreshold) {
                        Write-WatchLog "engine completion code=$($probe.code) streak=$completionFails/$CompletionFailThreshold ($($probe.detail))"
                    }
                    if ($completionFails -ge $CompletionFailThreshold) {
                        if ($completionBackoffSec -le 0) { $completionBackoffSec = $CompletionBackoffSec }
                        else { $completionBackoffSec = [Math]::Min($completionBackoffSec * 2, $CompletionBackoffMaxSec) }
                        Write-WatchLog "engine completion failing ${completionFails} probes; restarting (completion-backoff ${completionBackoffSec}s)"
                        & $PowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $controlScript `
                            -Action restart -LogDir $LogDir -Port $Port -Owner 'engine-restore-watchdog'
                        Write-WatchLog ("completion-restart exit=$LASTEXITCODE")
                        $completionFails = 0
                        $nextCompletionRestartAt = (Get-Date).AddSeconds($completionBackoffSec)
                        # 与 health 判据共享冷却，避免同一轮对引擎再打一次 restart。
                        $nextRestartAt = $nextCompletionRestartAt
                        $engineUpSince = $null
                        $retryAt = (Get-Date).AddSeconds(60)
                    }
                }
                else {
                    # 4xx：模型名/参数/路由问题，不是引擎死；只在状态码变化时记一次。
                    if ($previousCode -ne $probe.code) {
                        Write-WatchLog "engine completion code=$($probe.code) ignored (4xx): $($probe.detail)"
                    }
                }
            }
        }
    }
    catch {
        Write-WatchLog ("tick error: " + $_.Exception.Message)
        $retryAt = (Get-Date).AddSeconds(30)
    }
    # 给 WebUI 一个可读的守护状态（pid/模式/失败计数/退避截止）。写失败不影响守护。
    $stateMode = 'running'
    if (Test-Path -LiteralPath $marker) { $stateMode = 'restore-pending' }
    elseif ((Get-Date) -lt $nextRestartAt) { $stateMode = 'backoff' }
    elseif ($healthFails -gt 0) { $stateMode = 'health-failing' }
    elseif ($completionFails -gt 0) { $stateMode = 'completion-failing' }
    $state = [ordered]@{
        pid           = $PID
        mode          = $stateMode
        healthFails   = $healthFails
        threshold     = $HealthFailThreshold
        backoffSec    = $backoffSec
        nextRestartAt = $(if ($nextRestartAt -eq [datetime]::MinValue) { $null } else { $nextRestartAt.ToString('yyyy-MM-dd HH:mm:ss') })
        completionFails          = $completionFails
        completionThreshold      = $CompletionFailThreshold
        completionBackoffSec     = $completionBackoffSec
        nextCompletionRestartAt  = $(if ($nextCompletionRestartAt -eq [datetime]::MinValue) { $null } else { $nextCompletionRestartAt.ToString('yyyy-MM-dd HH:mm:ss') })
        lastCompletionCode       = $lastCompletionCode
        lastCompletionDetail     = $lastCompletionDetail
        engineUpSince            = $(if ($null -eq $engineUpSince) { $null } else { $engineUpSince.ToString('yyyy-MM-dd HH:mm:ss') })
        updatedAt     = (Get-Date).ToString('o')
    }
    try {
        # 不带 BOM：WebUI 侧是 JSON.parse，PS5 的 UTF8 会写 BOM 导致解析失败。
        [System.IO.File]::WriteAllText($stateFile, ($state | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
    }
    catch { }
    Start-Sleep -Seconds $IntervalSec
}
