# 一键回滚到旧栈。
#   powershell -NoProfile -ExecutionPolicy Bypass -File "Y:\dsh\home\qq-cutover\rollback.ps1" [-Note "..."]
# 动作：互斥锁 -> 停 bridge -> 用 backup\cordis.patch.yml.original 覆盖 live -> 重启宿主 ->
#       bridge-mode=old -> 自检 -> 原子写 cutover.json(stage=rolled-back) -> 打印原文。
# 失败保护：任一步失败不写 rolled-back；写 stage=rollback-failed 并 exit 10。
param(
    [string]$Note = '',
    [switch]$LockHeld
)
$ErrorActionPreference = 'Stop'
$CutRoot = 'Y:\dsh\home\qq-cutover'
$LiveYml = 'C:\Users\user\.dsh\profiles\desktop\cordis.patch.yml'
$OrigYml = Join-Path $CutRoot 'backup\cordis.patch.yml.original'
$BridgePid = Join-Path $CutRoot 'bridge.pid'
$ModeFile = Join-Path $CutRoot 'bridge-mode.json'
$LockFile = Join-Path $CutRoot 'cutover.lock'
$StateDir = 'Y:\dsh\home\qq-console\state'
$StateFile = Join-Path $StateDir 'cutover.json'
$RollbackCmd = 'powershell -NoProfile -ExecutionPolicy Bypass -File "Y:\dsh\home\qq-cutover\rollback.ps1"'
$script:LockStream = $null

function Say([string]$Level, [string]$Text) {
    Write-Output ("[{0}] [{1}] {2}" -f (Get-Date -Format 'HH:mm:ss'), $Level, $Text)
}

function Enter-CutoverLock {
    $deadline = (Get-Date).AddSeconds(120)
    while ($true) {
        try {
            $stream = [IO.File]::Open($LockFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $script:LockStream = $stream
            $bytes = [Text.Encoding]::UTF8.GetBytes(("{0}|{1}" -f $PID, (Get-Date -Format o)))
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush()
            Say INFO ("已获取互斥锁 pid={0}" -f $PID)
            return
        } catch [System.IO.IOException] {
            $owner = ''
            try { $owner = (Get-Content -LiteralPath $LockFile -Raw).Trim() } catch { }
            $ownerPid = 0
            if ($owner -match '^(\d+)\|') { $ownerPid = [int]$Matches[1] }
            $alive = $ownerPid -and (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)
            if (-not $alive) {
                Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
                continue
            }
            if ((Get-Date) -gt $deadline) {
                throw ("另一个 cutover/rollback 正在运行 pid={0}，等待 120s 仍被占用" -f $ownerPid)
            }
            Start-Sleep -Seconds 1
        }
    }
}

function Exit-CutoverLock {
    if ($script:LockStream) {
        $script:LockStream.Dispose()
        $script:LockStream = $null
    }
    try {
        $owner = (Get-Content -LiteralPath $LockFile -Raw).Trim()
        if ($owner -match ('^' + $PID + '\|')) {
            Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
        }
    } catch { }
}

function Test-OldDisabled {
    if (-not (Test-Path -LiteralPath $LiveYml)) { return $false }
    $lines = @(Get-Content -LiteralPath $LiveYml)
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^\s*-\s*id:\s*dsh-onebot\s*$') {
            for ($j = $i + 1; $j -lt [Math]::Min($i + 40, $lines.Count); $j++) {
                if ($lines[$j] -match '^\s*-\s*id:') { break }
                if ($lines[$j] -match '^\s*disabled:\s*true\s*$') { return $true }
            }
            return $false
        }
    }
    return $false
}

function Write-State([string]$StageName, [string]$ModeName, [string]$StateNote) {
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    $hostRunning = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count -gt 0
    $abPid = 0
    $ab = @(Get-NetTCPConnection -LocalPort 6199 -State Listen -ErrorAction SilentlyContinue)
    if ($ab.Count -gt 0) { $abPid = [int]$ab[0].OwningProcess }
    $obj = [ordered]@{
        updatedAt       = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' +0800'
        stage           = $StageName
        mode            = $ModeName
        astrbotPid      = $abPid
        oldStackServing = ($hostRunning -and -not (Test-OldDisabled))
        rollbackCommand = $RollbackCmd
        note            = $StateNote
    }
    $tmp = Join-Path $StateDir ('cutover.json.tmp-' + $PID)
    [IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $StateFile -Force
    Say PASS ("cutover.json: stage={0} mode={1} oldStackServing={2} astrbotPid={3}" -f $obj.stage, $obj.mode, $obj.oldStackServing, $obj.astrbotPid)
}

function Stop-Bridge {
    $killed = @()
    if (Test-Path -LiteralPath $BridgePid) {
        try {
            $bp = [int]((Get-Content -LiteralPath $BridgePid -Raw).Trim())
            if ($bp -and (Get-Process -Id $bp -ErrorAction SilentlyContinue)) {
                Stop-Process -Id $bp -Force -ErrorAction SilentlyContinue
                $killed += $bp
            }
        } catch { }
    }
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*qq-cutover\bridge.py*' })
    foreach ($p in $procs) {
        Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction SilentlyContinue
        $killed += [int]$p.ProcessId
    }
    Start-Sleep -Milliseconds 600
    Remove-Item -LiteralPath $BridgePid -Force -ErrorAction SilentlyContinue
    Say INFO ("停 bridge: " + $(if ($killed.Count) { ($killed | Select-Object -Unique) -join ',' } else { '无运行实例' }))
}

$failure = $null
$liveHash = ''
$hostConns = @()
$bridgeProcs = @()
$abConns = @()
try {
    if (-not $LockHeld) { Enter-CutoverLock }
    Say INFO '=== rollback: 开始 ==='
    Stop-Bridge

    if (-not (Test-Path -LiteralPath $OrigYml)) {
        throw "缺少原始备份：$OrigYml"
    }
    $origHash = (Get-FileHash -LiteralPath $OrigYml -Algorithm SHA256).Hash
    $tmp = $LiveYml + '.rollback-tmp'
    [IO.File]::WriteAllBytes($tmp, [IO.File]::ReadAllBytes($OrigYml))
    Move-Item -LiteralPath $tmp -Destination $LiveYml -Force
    $liveHash = (Get-FileHash -LiteralPath $LiveYml -Algorithm SHA256).Hash
    if ($origHash -ne $liveHash) {
        throw ("配置恢复后哈希不一致 orig={0} live={1}" -f $origHash, $liveHash)
    }
    Say PASS ("配置已恢复 sha256={0}" -f $liveHash)

    Say INFO '重启宿主（恢复旧栈全量）'
    $out = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $CutRoot 'restart-host.ps1') 2>&1
    foreach ($line in @($out)) { Say INFO ("  " + [string]$line) }
    if ($LASTEXITCODE -ne 0) {
        throw ("restart-host 失败 exit={0}" -f $LASTEXITCODE)
    }

    $modeTmp = Join-Path $CutRoot 'bridge-mode.json.rb-tmp'
    [IO.File]::WriteAllText($modeTmp, "{`n  `"mode`": `"old`",`n  `"group_id`": `"`"`n}`n",
        (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $modeTmp -Destination $ModeFile -Force

    # ---- 自检：旧栈两条 WS（dsh-onebot + qq-onebot）应回到 3001；6199 不应有桥连接 ----
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline) {
        $hostPids = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.Id })
        $hostConns = @(Get-NetTCPConnection -RemotePort 3001 -State Established -ErrorAction SilentlyContinue |
            Where-Object { $hostPids -contains [int]$_.OwningProcess })
        if ($hostConns.Count -ge 2) { break }
        Start-Sleep -Milliseconds 800
    }
    $bridgeProcs = @(Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*qq-cutover\bridge.py*' })
    $abConns = @(Get-NetTCPConnection -RemotePort 6199 -State Established -ErrorAction SilentlyContinue)

    Say INFO ("自检：宿主->3001 连接数={0}；bridge 进程数={1}；6199 ESTABLISHED={2}" -f $hostConns.Count, $bridgeProcs.Count, $abConns.Count)
    if ($hostConns.Count -lt 2) {
        throw '旧栈未恢复：宿主到 3001 的连接少于 2 条（dsh-onebot 可能未加载）'
    }
    if ($bridgeProcs.Count -gt 0) {
        throw 'bridge 仍在运行，回滚不完整'
    }
    if ($abConns.Count -gt 0) {
        throw '6199 仍有反连连接，回滚不完整'
    }

    $stateNote = $(if ($Note) { $Note + '；' } else { '' }) +
        '已回滚：cordis.patch.yml 恢复原始哈希，宿主重启，旧栈 dsh-onebot 回连 3001；AstrBot 桥已停；旧栈恢复全量出站'
    Write-State 'rolled-back' 'old' $stateNote
} catch {
    $failure = $_.Exception.Message
    Say ERROR ("回滚失败：{0}" -f $failure)
} finally {
    if (-not $LockHeld) { Exit-CutoverLock }
}

if ($failure) {
    try {
        Write-State 'rollback-failed' 'unknown' ("回滚失败：{0}；旧栈可能未恢复，需人工确认后再操作" -f $failure)
    } catch {
        Say ERROR ("写 rollback-failed 状态也失败：{0}" -f $_.Exception.Message)
    }
    exit 10
}

Say PASS '=== rollback: 通过 ==='
Write-Output ("ROLLBACK_OK sha256={0} hostConns3001={1} bridgeProcs={2} abConns={3}" -f $liveHash, $hostConns.Count, $bridgeProcs.Count, $abConns.Count)
Get-Content -LiteralPath $StateFile -Raw
exit 0
