# bot-child-watchdog.ps1 —— AstrBot(6299/6199) 与 qq-cutover bridge 的独立守护。
#
# 为什么需要它：
#   1) AstrBot 以前是从某个终端命令直接拉起的，进程父是终端，终端结束可能被一起带走，
#      而且全链路没有守护；这里用 hidden-launch.ps1（CreateProcess + 隐藏控制台）独立拉起，
#      与调用者终端解耦。
#   2) bridge.py 死了没人管，AstrBot 收不到消息。这里按进程存在性看守，消失即按退避拉起；
#      bridge.py 自带 upstream_loop / ab_loop 重连循环（2 秒重试），重启后会自动重连 3001 与 6199。
#
# 单实例：bot-child.watchdog.pid；停机标记：bot-child.watchdog.pause（存在则退出）。
# 日志：<WorkDir>\bot-child.watchdog.log；状态：<WorkDir>\bot-child.watchdog.state.json。
#
# 谁守护守护自己：没有上级守护。start-dsh.ps1 / start-bot.ps1 每次启动时会确保本守护单实例在跑；
# 如果它自己被 kill，两个孩子会继续运行但不再自愈，直到下一次手动启动。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File Y:\dsh\bot-child-watchdog.ps1
#   ... -DryRun   只打印状态与将执行的动作，不拉起任何进程
#   ... -Once     跑一轮（会拉起缺失组件）后退出
param(
    [string]$Root = 'Y:\dsh',
    [int]$IntervalSec = 5,
    [int]$BaseBackoffSec = 10,
    [int]$MaxBackoffSec = 120,
    [int]$LaunchWaitSec = 15,
    [int]$SettleSec = 10,
    [switch]$DryRun,
    [switch]$Once
)

$ErrorActionPreference = 'Stop'

$Here = $PSScriptRoot
$WorkDir = Join-Path $Root '2026-11-10\qqbot-ninfer-bridge\work'
$LogPath = Join-Path $WorkDir 'bot-child.watchdog.log'
$StatePath = Join-Path $WorkDir 'bot-child.watchdog.state.json'
$PidPath = Join-Path $WorkDir 'bot-child.watchdog.pid'
$PauseMarker = Join-Path $WorkDir 'bot-child.watchdog.pause'
$Launcher = Join-Path $Here 'hidden-launch.ps1'

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

function Write-WatchLog {
    param([string]$Level, [string]$Message)
    $line = '[{0}] [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    try { Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8 } catch { }
    if ($DryRun) { Write-Host $line }
}

# 两个组件的启动参数。pattern 用于按命令行识别「是不是同一个服务」。
# 数组顺序 = 拉起顺序 = start-dsh 的启动顺序（bridge 先、AstrBot 后）。
# bridge.py 自带 upstream_loop / ab_loop 重连循环，先起它不会因为 AstrBot 还没监听而失败。
$Components = @(
    [pscustomobject]@{
        name      = 'bridge'
        exe       = '^python(w)?\.exe$'
        pattern   = 'qq-cutover[\\/]bridge\.py'
        filePath  = 'E:\Bonsai\astrbot-eval\venv\Scripts\pythonw.exe'
        arguments = '"Y:\dsh\home\qq-cutover\bridge.py"'
        cwd       = 'Y:\dsh\home\qq-cutover'
        outLog    = 'Y:\dsh\home\qq-cutover\bridge.watchdog.out.log'
        errLog    = 'Y:\dsh\home\qq-cutover\bridge.watchdog.err.log'
        port      = 0
    },
    [pscustomobject]@{
        name      = 'AstrBot'
        exe       = '^python(w)?\.exe$'
        pattern   = 'astrbot\.cli\.__main__ run -p 6299'
        filePath  = 'E:\Bonsai\astrbot-eval\venv\Scripts\python.exe'
        arguments = '-m astrbot.cli.__main__ run -p 6299'
        # AstrBot 的根目录判定是 Path.cwd() + 必须存在 .astrbot（cli/utils/basic.py），
        # 实际实例目录是 inst，不是 venv 所在的 astrbot-eval 根。
        cwd       = 'E:\Bonsai\astrbot-eval\inst'
        # 根目录预检：AstrBot 以 cwd 为根，缺 .astrbot 会直接抛 ClickException 退出。
        # 预检放在拉起之前，错配置不再靠「10 秒存活观察」兜底，也不会反复 spawn python。
        requiredPaths = @('.astrbot', 'data\cmd_config.json')
        outLog    = 'E:\Bonsai\astrbot-eval\logs\run-hidden.out.log'
        errLog    = 'E:\Bonsai\astrbot-eval\logs\run-hidden.err.log'
        port      = 6299
    }
)

function Get-ComponentProcesses {
    param($Component)
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -and ($_.Name -match $Component.exe) -and
        $_.CommandLine -and ($_.CommandLine -match $Component.pattern)
    })
}

function Get-ErrTail {
    param([string]$Path, [int]$Lines = 6)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return '' }
    return (@(Get-Content -LiteralPath $Path -Tail $Lines -ErrorAction SilentlyContinue) -join ' | ')
}

function Invoke-Launch {
    param($Component)
    if (-not (Test-Path -LiteralPath $Component.filePath)) {
        return @{ ok = $false; detail = "可执行文件不存在：$($Component.filePath)" }
    }
    if (-not (Test-Path -LiteralPath $Launcher)) {
        return @{ ok = $false; detail = "找不到无窗口启动器：$Launcher" }
    }
    foreach ($rel in @($Component.requiredPaths)) {
        if (-not $rel) { continue }
        $full = Join-Path $Component.cwd $rel
        if (-not (Test-Path -LiteralPath $full)) {
            return @{ ok = $false; detail = "根目录预检失败：缺少 $full（cwd=$($Component.cwd)，未拉起进程）" }
        }
    }
    try {
        $line = (& $Launcher -FilePath $Component.filePath -Arguments $Component.arguments `
            -WorkingDirectory $Component.cwd -OutLog $Component.outLog -ErrLog $Component.errLog `
            -HiddenConsole -Append | Out-String).Trim()
        $match = [regex]::Match($line, 'pid=(\d+)')
        if (-not $match.Success) {
            return @{ ok = $false; detail = "hidden-launch 未返回 pid：$line" }
        }
        $launchedPid = [int]$match.Groups[1].Value

        # 等进程真的出现在命令行匹配里；起不来就带着 stderr 末尾报错。
        $deadline = (Get-Date).AddSeconds($LaunchWaitSec)
        $foundPid = 0
        while ((Get-Date) -lt $deadline) {
            $procs = @(Get-ComponentProcesses $Component)
            if ($procs.Count -gt 0) { $foundPid = [int]$procs[0].ProcessId; break }
            Start-Sleep -Milliseconds 500
        }
        if ($foundPid -eq 0) {
            $tail = Get-ErrTail $Component.errLog
            $suffix = if ($tail) { "；stderr 末尾：$tail" } else { '' }
            return @{ ok = $false; detail = "已创建 launcher pid=$launchedPid，但 $LaunchWaitSec 秒内未出现在进程列表$suffix" }
        }

        # 「出现」不等于「能活」：配置错误时 python 通常 1-2 秒内就退出。
        # 不观察存活会把「刚起来就死」当成成功，fails 永远归零，守护每轮（IntervalSec）重拉一次，
        # 形成重试风暴（2026-11-15 AstrBot 因根目录 cwd 错误每 6 秒重拉一次）。
        $settleDeadline = (Get-Date).AddSeconds($SettleSec)
        while ((Get-Date) -lt $settleDeadline) {
            if (@(Get-ComponentProcesses $Component).Count -eq 0) {
                $tail = Get-ErrTail $Component.errLog
                $suffix = if ($tail) { "；stderr 末尾：$tail" } else { '' }
                return @{ ok = $false; detail = "pid=$foundPid 启动后 $SettleSec 秒内退出$suffix" }
            }
            Start-Sleep -Milliseconds 500
        }
        return @{ ok = $true; detail = "已拉起 pid=$foundPid（launcher pid=$launchedPid，存活 $SettleSec 秒）" }
    }
    catch {
        $tail = Get-ErrTail $Component.errLog
        $suffix = if ($tail) { "；stderr 末尾：$tail" } else { '' }
        return @{ ok = $false; detail = ("拉起异常：" + $_.Exception.Message + $suffix) }
    }
}

# 单实例（DryRun 不写 pid 文件）
if (-not $DryRun) {
    if (Test-Path -LiteralPath $PidPath) {
        $oldPid = Get-Content -LiteralPath $PidPath -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($oldPid -and (Get-Process -Id ([int]$oldPid) -ErrorAction SilentlyContinue)) {
            Write-WatchLog INFO "已有实例在运行（pid $oldPid），本次退出。"
            exit 0
        }
    }
    Set-Content -LiteralPath $PidPath -Value ([string]$PID) -Encoding ascii
}

$state = @{}
foreach ($component in $Components) {
    $state[$component.name] = [pscustomobject]@{
        name      = $component.name
        running   = $false
        pid       = 0
        fails     = 0
        nextRetry = [datetime]::MinValue
        lastError = ''
    }
}

function Get-StateSnapshot {
    $items = @()
    foreach ($component in $Components) {
        $procs = @(Get-ComponentProcesses $component)
        $running = $procs.Count -gt 0
        $pidValue = if ($running) { [int]$procs[0].ProcessId } else { 0 }
        $items += [pscustomobject]@{
            name      = $component.name
            running   = $running
            pid       = $pidValue
            fails     = $state[$component.name].fails
            nextRetry = $state[$component.name].nextRetry
            lastError = $state[$component.name].lastError
        }
    }
    return @($items)
}

if ($DryRun) {
    Write-WatchLog INFO ''
    Write-WatchLog INFO '=== bot-child-watchdog DryRun（只读探测，不拉起任何进程） ==='
    foreach ($component in $Components) {
        $procs = @(Get-ComponentProcesses $component)
        if ($procs.Count -gt 0) {
            Write-WatchLog INFO ("  {0}：已运行 pid={1}，守护只监控，不重复拉起。" -f $component.name, $procs[0].ProcessId)
        }
        else {
            Write-WatchLog INFO ("  {0}：未运行 -> 将通过 hidden-launch.ps1 -HiddenConsole 拉起：`"{1}`" {2}（cwd={3}）" -f `
                $component.name, $component.filePath, $component.arguments, $component.cwd)
        }
    }
    $pause = Test-Path -LiteralPath $PauseMarker
    Write-WatchLog INFO ("  停机标记 bot-child.watchdog.pause：{0}" -f $(if ($pause) { '存在（真实运行会立刻退出）' } else { '不存在' }))
    Write-WatchLog INFO '  单实例 pid 文件：DryRun 不写入。'
    Write-WatchLog INFO '  守护自身无人看守：它被 kill 后两个孩子继续跑但不再自愈，需下次 start-dsh/start-bot 确保它回来。'
    exit 0
}

Write-WatchLog INFO ''
Write-WatchLog INFO '=== bot-child-watchdog 启动（AstrBot + bridge） ==='

while ($true) {
    if (Test-Path -LiteralPath $PauseMarker) {
        Write-WatchLog INFO '检测到停机标记 bot-child.watchdog.pause，守护退出（不会拉起任何组件）。'
        break
    }

    foreach ($component in $Components) {
        $entry = $state[$component.name]
        $procs = @(Get-ComponentProcesses $component)
        if ($procs.Count -gt 0) {
            if (-not $entry.running) {
                Write-WatchLog INFO ("{0}：已运行 pid={1}，接管监控。" -f $component.name, $procs[0].ProcessId)
            }
            $entry.running = $true
            $entry.pid = [int]$procs[0].ProcessId
            $entry.fails = 0
            $entry.nextRetry = [datetime]::MinValue
            $entry.lastError = ''
            continue
        }

        if ($entry.running) {
            Write-WatchLog WARN ("{0}：进程已消失（原 pid={1}），准备拉起。" -f $component.name, $entry.pid)
        }
        $entry.running = $false
        $entry.pid = 0

        if ((Get-Date) -lt $entry.nextRetry) { continue }

        $result = Invoke-Launch $component
        if ($result.ok) {
            Write-WatchLog INFO ("{0}：{1}" -f $component.name, $result.detail)
            $entry.fails = 0
            $entry.nextRetry = [datetime]::MinValue
            $entry.lastError = ''
        }
        else {
            $entry.fails++
            $delay = [int][Math]::Min($MaxBackoffSec, $BaseBackoffSec * [Math]::Pow(2, [Math]::Min(6, $entry.fails - 1)))
            $entry.nextRetry = (Get-Date).AddSeconds($delay)
            $entry.lastError = $result.detail
            Write-WatchLog ERROR ("{0}：拉起失败（连续 {1} 次，{2} 秒后重试）：{3}" -f $component.name, $entry.fails, $delay, $result.detail)
        }
    }

    # 状态落盘（只读展示用，不参与启停决策）。
    try {
        $snapshot = [pscustomobject]@{
            updatedAt = (Get-Date).ToString('o')
            watchdogPid = $PID
            components = @(Get-StateSnapshot)
        }
        [System.IO.File]::WriteAllText($StatePath, ($snapshot | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
    }
    catch { }

    if ($Once) { break }
    Start-Sleep -Seconds $IntervalSec
}

if (-not $DryRun) {
    $current = Get-Content -LiteralPath $PidPath -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($current -and [int]$current -eq $PID) {
        Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
    }
}
