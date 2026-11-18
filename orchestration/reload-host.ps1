# reload-host.ps1 -- 受控重载宿主（唯一推荐姿势）。
#
# 为什么需要它：直接 Stop-Process 杀宿主会被 harness-watchdog 当成崩溃，进入 30/60/120/300 秒退避，
# 用户侧就是几分钟不回话；而从终端 Start-Process 起的宿主会在命令结束时被作业回收
# （2026-11-13 的 9300/12860/28776/236 都是）。本脚本把「暂停守护 -> 只杀宿主 -> 交给守护拉起 -> 等就绪」
# 串成一步，并在 harness.crash.log 里写独立的 [RELOAD] 标记，不污染崩溃统计。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File Y:\dsh\reload-host.ps1
#   ... -TimeoutSec 150   等待就绪的上限（默认 120）
#   ... -DryRun           只打印将要做什么，不改动任何进程
#
# 退出码：0=重载成功且已就绪；2=超时/失败（守护已恢复，证据留在日志里）；3=已有重载在进行
param(
    [int]$TimeoutSec = 120,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$Root = 'Y:\dsh'
$Here = $PSScriptRoot
$WorkDir = Join-Path $Root '2026-11-10\qqbot-ninfer-bridge\work'
$pauseMarker = Join-Path $WorkDir 'harness.watchdog.pause'
$watchdogPidFile = Join-Path $WorkDir 'harness.watchdog.pid'
$watchLog = Join-Path $WorkDir 'harness.watchdog.log'
$crashLog = Join-Path $WorkDir 'harness.crash.log'
$statePath = Join-Path $WorkDir 'harness.watchdog.state.json'
$pluginLog = Join-Path $Root 'home\qq-onebot-plugin\logs\s0.log'
$lockFile = Join-Path $WorkDir 'reload-host.lock'

function Say([string]$Text) {
    Write-Host ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $Text)
}

function Append-CrashLog([string]$Line) {
    try { Add-Content -LiteralPath $crashLog -Value $Line -Encoding UTF8 } catch { }
}

function Get-HostProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue)
}

# 主进程 = 父进程不在同一个 DeepSeek Harness 集合里的那个；其余都算它的子进程。
function Get-HostMainProcess($procs) {
    $ids = @($procs | ForEach-Object { [int]$_.ProcessId })
    $procs | Where-Object { $ids -notcontains [int]$_.ParentProcessId } | Select-Object -First 1
}

function Test-WatchdogAlive {
    if (-not (Test-Path -LiteralPath $watchdogPidFile)) { return $false }
    $wp = (Get-Content -LiteralPath $watchdogPidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if (-not $wp) { return $false }
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$wp)" -ErrorAction SilentlyContinue
    if (-not $p) { return $false }
    return ($p.CommandLine -match 'harness-watchdog\.ps1')
}

# 生产链路：WMI -> wscript -> run-detached.vbs -> 隐藏 powershell。
# 不经终端作业，所以脚本退出后守护不会被回收。
function Start-WatchdogDetached {
    $vbs = Join-Path $Here 'run-detached.vbs'
    $outLog = Join-Path $WorkDir 'harness.watchdog.out.log'
    $cmd = 'wscript.exe //B //Nologo "{0}" "{1}" "{2}" 0 "powershell.exe" "-NoLogo" "-NoProfile" "-NonInteractive" "-ExecutionPolicy" "Bypass" "-File" "{3}"' -f `
        $vbs, $Here, $outLog, (Join-Path $Here 'harness-watchdog.ps1')
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $Root }
    if ($result.ReturnValue -ne 0) { throw "启动守护失败（Win32_Process.Create ReturnValue=$($result.ReturnValue)）" }
    return [int]$result.ProcessId
}

# 只看本轮新增的插件日志：旧行里的「WS 已连接」不能算数。
function Get-PluginLogOffset {
    if (-not (Test-Path -LiteralPath $pluginLog)) { return 0 }
    return (Get-Item -LiteralPath $pluginLog).Length
}

function Get-PluginLogDelta([long]$Offset) {
    if (-not (Test-Path -LiteralPath $pluginLog)) { return '' }
    try {
        $stream = [System.IO.File]::Open($pluginLog, 'Open', 'Read', 'ReadWrite')
        try {
            if ($stream.Length -le $Offset) { return '' }
            [void]$stream.Seek($Offset, 'Begin')
            $buffer = New-Object byte[] ($stream.Length - $Offset)
            $read = $stream.Read($buffer, 0, $buffer.Length)
            return [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
        }
        finally { $stream.Dispose() }
    }
    catch { return '' }
}

# === 0. 互斥：并发会话同时跑会互相杀，必须只允许一个 ===
if (Test-Path -LiteralPath $lockFile) {
    $age = ((Get-Date) - (Get-Item -LiteralPath $lockFile).LastWriteTime).TotalSeconds
    if ($age -lt 300) {
        Say "已有一次重载在进行（锁文件 $([int]$age) 秒前创建），本次退出。"
        exit 3
    }
    Say '清理过期锁文件'
    Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
}

$oldProcs = Get-HostProcesses
$oldMain = Get-HostMainProcess $oldProcs
$oldPid = if ($oldMain) { [int]$oldMain.ProcessId } else { 0 }
$oldStart = if ($oldMain) { $oldMain.CreationDate } else { $null }
$oldLived = if ($oldStart) { [int]((Get-Date) - $oldStart).TotalSeconds } else { 0 }

Say ("当前宿主主进程 pid={0}（共 {1} 个进程）" -f $(if ($oldPid) { $oldPid } else { '无' }), $oldProcs.Count)
if ($DryRun) {
    Say 'DryRun：将暂停守护 -> 结束宿主 -> 由守护重新拉起 -> 等待插件挂载与 WS 连接'
    exit 0
}

Set-Content -LiteralPath $lockFile -Value (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') -Encoding ascii
try {
    $t0 = Get-Date

    # === 1. 暂停守护：放标记后守护会在轮询里退出，且不会把随后的退出记账 ===
    if (Test-WatchdogAlive) {
        Set-Content -LiteralPath $pauseMarker -Value 'reload-host' -Encoding ascii
        $deadline = (Get-Date).AddSeconds(20)
        while ((Get-Date) -lt $deadline -and (Test-WatchdogAlive)) { Start-Sleep -Milliseconds 300 }
        if (Test-WatchdogAlive) {
            Say '守护 20 秒内没有退出，放弃本次重载（不动宿主）。'
            Remove-Item -LiteralPath $pauseMarker -Force -ErrorAction SilentlyContinue
            exit 2
        }
        Say '守护已暂停并退出'
    }
    else {
        Say '守护当前不在运行，跳过暂停'
    }
    # 标记必须清掉：否则接下来拉起的守护会立刻退出。
    Remove-Item -LiteralPath $pauseMarker -Force -ErrorAction SilentlyContinue

    # === 2. 只结束宿主主进程与它的子进程（不碰 proxy / console / 引擎 / SnowLuma）===
    $offset = Get-PluginLogOffset
    if ($oldProcs.Count -gt 0) {
        if ($oldPid) { Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue }
        $killDeadline = (Get-Date).AddSeconds(10)
        while ((Get-Date) -lt $killDeadline -and (Get-HostProcesses).Count -gt 0) {
            foreach ($p in (Get-HostProcesses)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
            Start-Sleep -Milliseconds 300
        }
        Say ("已结束宿主 pid={0}（存活 {1}s），剩余宿主进程 {2} 个" -f $oldPid, $oldLived, (Get-HostProcesses).Count)
    }
    else {
        Say '宿主本来就没在运行，直接拉起'
    }

    # === 3. 主动重载标记（独立行，不进崩溃统计）===
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Append-CrashLog ("[{0}] [RELOAD] 主动重载 pid={1} lived={2}s 由 reload-host.ps1 发起（非崩溃，不计入退避）" -f $stamp, $oldPid, $oldLived)

    # === 4. 恢复守护：由它按自己的启动流程拉起宿主（含 cookie 清理、无窗口、文件句柄）===
    $wdPid = Start-WatchdogDetached
    Say "已重新拉起守护（wscript pid=$wdPid），等待宿主就绪…"

    # === 5. 等就绪：宿主进程 + 插件挂载 + WS 已连接，三者都出现才算能用 ===
    $newMain = 0
    $mounted = $false
    $wsOk = $false
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $now = Get-HostProcesses
        if (-not $newMain -and $now.Count -gt 0) {
            $m = Get-HostMainProcess $now
            if ($m) { $newMain = [int]$m.ProcessId }
        }
        $delta = Get-PluginLogDelta $offset
        if ($delta -match '插件已挂载') { $mounted = $true }
        if ($delta -match 'WS 已连接') { $wsOk = $true }
        if ($newMain -and $mounted -and $wsOk) { break }
        Start-Sleep -Milliseconds 500
    }
    $readySec = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)

    if (-not ($newMain -and $mounted -and $wsOk)) {
        $why = @()
        if (-not $newMain) { $why += '宿主进程未出现' }
        if (-not $mounted) { $why += '插件未挂载' }
        if (-not $wsOk) { $why += 'WS 未连接' }
        $msg = $why -join '、'
        Append-CrashLog ("[{0}] [RELOAD-FAIL] 主动重载失败：{1}（{2}s），守护保持运行" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg, $readySec)
        Say "重载失败：$msg（已等 $readySec 秒）。守护仍在前台，会按自身策略继续拉起。"
        Say '--- harness.watchdog.log 尾部 ---'
        Get-Content -LiteralPath $watchLog -Tail 8 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
        exit 2
    }

    # === 6. 成功：补一行带新 pid 与耗时的标记 ===
    $state = if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } else { $null }
    $mode = if ($state) { $state.mode } else { 'unknown' }
    # 退避时间可能是上一轮留下的过期值，只有落在未来才算「这次进了退避」。
    $backoff = ''
    if ($state -and $state.backoffUntil) {
        $parsed = [datetime]::MinValue
        if ([datetime]::TryParse([string]$state.backoffUntil, [ref]$parsed) -and $parsed -gt (Get-Date)) {
            $backoff = [string]$state.backoffUntil
        }
    }
    Append-CrashLog ("[{0}] [RELOAD-OK] 新宿主 pid={1} 就绪耗时={2}s 插件已挂载+WS已连接" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $newMain, $readySec)

    Say ("重载完成：pid {0} -> {1}，就绪耗时 {2}s" -f $oldPid, $newMain, $readySec)
    Say ("守护状态：mode={0} backoffUntil={1}" -f $mode, $(if ($backoff) { $backoff } else { '（无，未进入退避）' }))
    exit 0
}
finally {
    Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
}
