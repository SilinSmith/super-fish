# 只重启 dsh-onebot 宿主（DeepSeek Harness），不碰 OneBot 协议端(3001)、引擎(8094)、
# ComfyUI(8188)、persona proxy(1240)、qq-console(1242)。
# 流程：写 watchdog pause 标记 -> 停 watchdog -> 杀宿主进程树 -> 清标记 ->
#       走 start-dsh.ps1（幂等，只起基础设施）-> 本脚本自己经 hidden-launch 拉起 harness-watchdog。
# 注意：start-dsh.ps1 的 [3.6] bot-child 与 [5/5] 宿主现在都只在 -ConnectTraffic 下执行，
#       本脚本不接流量，所以不能依赖 start-dsh 拉起宿主守护，AstrBot/bridge 也不由本脚本负责。
# 所有子进程沿用现有 wscript //B / 隐藏启动路径，不产生可见控制台。
param(
    [int]$WaitSeconds = 150
)

$ErrorActionPreference = 'Stop'
$Root = 'Y:\dsh'
$Work = Join-Path $Root '2026-11-10\qqbot-ninfer-bridge\work'
$PauseMarker = Join-Path $Work 'harness.watchdog.pause'
$WatchdogPid = Join-Path $Work 'harness.watchdog.pid'
$LogPath = Join-Path $Work 'harness.out.log'

function Say([string]$Level, [string]$Text) {
    Write-Output ("[{0}] [{1}] {2}" -f (Get-Date -Format 'HH:mm:ss'), $Level, $Text)
}

New-Item -ItemType Directory -Force -Path $Work | Out-Null
Say INFO 'restart-host: 写 watchdog pause 标记'
Set-Content -LiteralPath $PauseMarker -Value ("restart-host " + (Get-Date -Format 's')) -Encoding ascii

if (Test-Path -LiteralPath $WatchdogPid) {
    $wd = 0
    try { $wd = [int]((Get-Content -LiteralPath $WatchdogPid -Raw).Trim()) } catch { $wd = 0 }
    if ($wd -and (Get-Process -Id $wd -ErrorAction SilentlyContinue)) {
        Say INFO "停 watchdog pid=$wd"
        Stop-Process -Id $wd -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 800
    }
}

$hostProcs = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
Say INFO ("杀宿主进程: " + (($hostProcs | ForEach-Object { $_.Id }) -join ','))
$hostProcs | Stop-Process -Force -ErrorAction SilentlyContinue
$deadline = (Get-Date).AddSeconds(25)
while ((Get-Date) -lt $deadline) {
    if (-not (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
}
$left = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
if ($left.Count -gt 0) {
    Say WARN ("仍有宿主进程未退出: " + (($left | ForEach-Object { $_.Id }) -join ','))
}

Remove-Item -LiteralPath $PauseMarker -Force -ErrorAction SilentlyContinue
Say INFO '启动 watchdog（start-dsh.ps1 幂等路径）'
$out = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
    -File (Join-Path $Root 'start-dsh.ps1') -SkipEngine -SkipProxy -SkipConsole 2>&1
foreach ($line in @($out)) { Say INFO ("  " + [string]$line) }

# start-dsh 不带 -ConnectTraffic 时不会起宿主守护（[5/5] 被门控），而本脚本的职责就是重启宿主。
# 单独经 hidden-launch 拉起 harness-watchdog，避免依赖 start-dsh 的接流量分支。
$harnessWatchdog = Join-Path $Root 'harness-watchdog.ps1'
$hiddenLauncher = Join-Path $Root 'hidden-launch.ps1'
$wdPidFile = Join-Path $Work 'harness.watchdog.pid'
$wdAlive = $false
if (Test-Path -LiteralPath $wdPidFile) {
    $wdPid = 0
    try { $wdPid = [int]((Get-Content -LiteralPath $wdPidFile -Raw).Trim()) } catch { $wdPid = 0 }
    if ($wdPid -and (Get-Process -Id $wdPid -ErrorAction SilentlyContinue)) { $wdAlive = $true }
}
if ($wdAlive) {
    Say INFO "宿主守护已在运行（pid $wdPid），不重复拉起"
}
elseif (-not (Test-Path -LiteralPath $harnessWatchdog) -or -not (Test-Path -LiteralPath $hiddenLauncher)) {
    Say ERROR "找不到 harness-watchdog.ps1 或 hidden-launch.ps1，无法拉起宿主守护"
    exit 10
}
else {
    Say INFO '宿主守护未在跑 -> 经 hidden-launch 拉起 harness-watchdog.ps1'
    try {
        $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $wdArgs = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $harnessWatchdog + '"'
        $wdLine = & $hiddenLauncher -FilePath $psExe -Arguments $wdArgs -WorkingDirectory $Root `
            -OutLog (Join-Path $Work 'harness.watchdog.out.log') `
            -ErrLog (Join-Path $Work 'harness.watchdog.err.log') -HiddenConsole -Append
        Say INFO ("  hidden-launch: " + [string]$wdLine)
    }
    catch {
        Say ERROR ("拉起宿主守护失败：{0}" -f $_.Exception.Message)
        exit 10
    }
}

Say INFO '等待宿主起来'
$started = Get-Date
$rootPid = 0
while (((Get-Date) - $started).TotalSeconds -lt $WaitSeconds) {
    $procs = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
    if ($procs.Count -gt 0) {
        $cim = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue)
        $ids = @($cim | ForEach-Object { [int]$_.ProcessId })
        $root = $cim | Where-Object { $ids -notcontains [int]$_.ParentProcessId } | Select-Object -First 1
        $rootPid = if ($root) { [int]$root.ProcessId } else { [int]$procs[0].Id }
        break
    }
    Start-Sleep -Milliseconds 800
}

if (-not $rootPid) {
    Say ERROR ("宿主在 {0}s 内未起来" -f $WaitSeconds)
    exit 10
}

$elapsed = [Math]::Round(((Get-Date) - $started).TotalSeconds, 1)
$conns = @(Get-NetTCPConnection -RemotePort 3001 -State Established -ErrorAction SilentlyContinue)
$hostPids = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.Id })
$hostConns = @($conns | Where-Object { $hostPids -contains [int]$_.OwningProcess })
Say PASS ("宿主已起来 pid={0} 用时 {1}s；到 3001 的连接数={2}（宿主进程 {3} 条）" -f $rootPid, $elapsed, $conns.Count, $hostConns.Count)
Write-Output ("RESTART_HOST_OK pid={0} elapsed={1}s conns3001={2} hostConns={3}" -f $rootPid, $elapsed, $conns.Count, $hostConns.Count)
exit 0
