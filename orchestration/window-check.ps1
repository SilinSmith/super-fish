# 窗口自检：统计由本项目拉起的进程里，有多少个拥有“可见的控制台窗口”。
# 只读，不改任何进程；输出 JSON（stdout），供 start-dsh.ps1 与 WebUI 状态页使用。
#
# 判定方式（不是看代码推断）：
#   1) EnumWindows 枚举所有顶层窗口，GetWindowThreadProcessId 取属主 PID；
#   2) GetClassName 识别 ConsoleWindowClass / CASCADIA_HOSTING_WINDOW_CLASS / PseudoConsoleWindow；
#   3) IsWindowVisible 判断是否真的可见；
#   4) 经典控制台窗口属主是 conhost.exe，按 ParentProcessId 归到真正的目标进程；
#   5) 目标进程用命令行特征匹配（proxy / console / watch-r6 / 引擎）。外部 OneBot 协议端不纳入。
# Harness 是 GUI 程序，本身有正常窗口，只把控制台类窗口算违规。

param(
    # 短命窗口轮询秒数：>0 时每 1 秒采样一次，记录整段期间出现过的可见控制台窗口。
    [int]$WatchSec = 0
)

$ErrorActionPreference = 'SilentlyContinue'

# stdout 被重定向给 Node 读取时，按 UTF-8 写出，避免中文标题变乱码。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class DshWindows {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder buffer, int size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder buffer, int size);
}
'@

$CONSOLE_CLASSES = @(
    'ConsoleWindowClass',
    'CASCADIA_HOSTING_WINDOW_CLASS',
    'PseudoConsoleWindow',
    'OpenConsoleWindowClass'
)
$CONSOLE_HOSTS = @('conhost.exe', 'OpenConsole.exe', 'WindowsTerminal.exe')

# 目标进程：name/exe/pattern/expectGui。
# 先用进程名（exe 正则）锁定“核心进程”，再用命令行 pattern 精确定位；
# 核心进程的启动包装链（cmd/powershell/wscript/pythonw）单独按“祖先”归到同一目标，
# 这样既不会把日志路径里带 ninfer 字样的包装进程误标成引擎，也不会漏掉包装进程可能弹出的控制台窗口。
$TARGETS = @(
    @{ name = 'persona proxy'; exe = '^node\.exe$'; pattern = 'qq-persona[\\/]proxy\.mjs'; expectGui = $false },
    @{ name = 'console'; exe = '^node\.exe$'; pattern = 'qq-console[\\/]server\.mjs'; expectGui = $false },
    @{ name = 'r6 watcher'; exe = '^node\.exe$'; pattern = 'watch-r6\.mjs'; expectGui = $false },
    @{ name = 'harness watchdog'; exe = '^powershell\.exe$'; pattern = 'harness-watchdog\.ps1'; expectGui = $false },
    @{ name = 'engine restore watchdog'; exe = '^powershell\.exe$'; pattern = 'engine-restore-watchdog\.ps1'; expectGui = $false },
    @{ name = 'qq-console watchdog'; exe = '^powershell\.exe$'; pattern = 'qq-console[\\/]watchdog\.ps1'; expectGui = $false },
    @{ name = 'bot-child watchdog'; exe = '^powershell\.exe$'; pattern = 'bot-child-watchdog\.ps1'; expectGui = $false },
    @{ name = 'ComfyUI'; exe = '^python\.exe$'; pattern = 'main\.py.*8188'; expectGui = $false },
    @{ name = 'ninfer engine'; exe = '^ninfer-serve-[\w.-]+\.exe$'; pattern = ''; expectGui = $false },
    @{ name = 'ninfer supervisor'; exe = '^pythonw?\.exe$'; pattern = 'ninfer-serve|serve-ninfer\.pyw'; expectGui = $false },
    @{ name = 'DeepSeek Harness'; exe = '^DeepSeek Harness\.exe$'; pattern = ''; expectGui = $true }
)

# 允许被归入目标进程的启动包装链进程名（只向上追溯这些，避免把 explorer / services 也算进来）。
$WRAPPER_NAMES = @('cmd.exe', 'powershell.exe', 'pwsh.exe', 'wscript.exe', 'cscript.exe', 'pythonw.exe', 'python.exe')

$processes = @(Get-CimInstance Win32_Process)
$byPid = @{}
foreach ($process in $processes) {
    $byPid[[int]$process.ProcessId] = $process
}

# 枚举顶层窗口
$windows = New-Object System.Collections.ArrayList
$callback = {
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    $ownerPid = 0
    [void][DshWindows]::GetWindowThreadProcessId($hWnd, [ref]$ownerPid)
    $classBuffer = New-Object System.Text.StringBuilder 256
    [void][DshWindows]::GetClassName($hWnd, $classBuffer, 256)
    $titleBuffer = New-Object System.Text.StringBuilder 512
    [void][DshWindows]::GetWindowText($hWnd, $titleBuffer, 512)
    $visible = [DshWindows]::IsWindowVisible($hWnd)
    [void]$windows.Add([pscustomobject]@{
        Handle  = [int64]$hWnd
        OwnerPid = [int]$ownerPid
        Class   = $classBuffer.ToString()
        Title   = $titleBuffer.ToString()
        Visible = [bool]$visible
    })
    return $true
}
[void][DshWindows]::EnumWindows($callback, [IntPtr]::Zero)

# 把控制台宿主窗口归到真正的目标进程
function Get-EffectiveOwner([int]$ownerPid) {
    $owner = $byPid[$ownerPid]
    if (-not $owner) { return $ownerPid }
    if ($CONSOLE_HOSTS -contains $owner.Name) {
        return [int]$owner.ParentProcessId
    }
    return $ownerPid
}

# 向上追溯启动包装链（cmd / powershell / wscript / pythonw），用于把包装进程的控制台窗口归到目标进程。
function Get-WrapperPids([int]$startPid) {
    $result = New-Object System.Collections.ArrayList
    $cursor = $startPid
    for ($depth = 0; $depth -lt 6; $depth++) {
        $node = $byPid[$cursor]
        if (-not $node) { break }
        $parent = $byPid[[int]$node.ParentProcessId]
        if (-not $parent) { break }
        if ($WRAPPER_NAMES -notcontains $parent.Name) { break }
        $parentPid = [int]$parent.ProcessId
        if ($result -contains $parentPid) { break }
        [void]$result.Add($parentPid)
        $cursor = $parentPid
    }
    return @($result)
}

$resultTargets = New-Object System.Collections.ArrayList
$violations = New-Object System.Collections.ArrayList

foreach ($target in $TARGETS) {
    $matched = @($processes | Where-Object {
        $_.Name -and ($_.Name -match $target.exe) -and
        (($target.pattern -eq '') -or ($_.CommandLine -and ($_.CommandLine -match $target.pattern)))
    })

    if ($matched.Count -eq 0) {
        [void]$resultTargets.Add([pscustomobject]@{
            name = $target.name; pid = $null; running = $false
            hasVisibleConsole = $false; windows = @()
        })
        continue
    }

    foreach ($process in $matched) {
        $pidValue = [int]$process.ProcessId
        $wrapperPids = @(Get-WrapperPids $pidValue)
        $allPids = @($pidValue) + $wrapperPids
        $owned = @($windows | Where-Object {
            $_.Visible -and ($allPids -contains (Get-EffectiveOwner $_.OwnerPid))
        })
        $consoleWindows = @($owned | Where-Object { $CONSOLE_CLASSES -contains $_.Class })
        $hasVisibleConsole = $consoleWindows.Count -gt 0
        if ($hasVisibleConsole) {
            foreach ($window in $consoleWindows) {
                [void]$violations.Add([pscustomobject]@{
                    name = $target.name
                    pid = $pidValue
                    ownerPid = (Get-EffectiveOwner $window.OwnerPid)
                    exe = $process.Name
                    windowClass = $window.Class
                    title = $window.Title
                    commandLine = $process.CommandLine
                })
            }
        }
        [void]$resultTargets.Add([pscustomobject]@{
            name = $target.name
            pid = $pidValue
            running = $true
            expectGui = [bool]$target.expectGui
            hasVisibleConsole = $hasVisibleConsole
            consoleTitles = @($consoleWindows | ForEach-Object { $_.Title })
            visibleWindowCount = $owned.Count
            wrapperPids = $wrapperPids
            commandLine = $process.CommandLine
        })
    }
}

# 全局兜底：不依赖目标匹配，直接统计整机所有可见的控制台类顶层窗口。
# 这样即使窗口被 Windows Terminal（属主是 WindowsTerminal.exe，挂在 smss 下）托管、
# parent 链已经断了，也能被这里抓到。
$globalConsole = New-Object System.Collections.ArrayList
foreach ($window in @($windows | Where-Object { $_.Visible -and ($CONSOLE_CLASSES -contains $_.Class) })) {
    $owner = $byPid[$window.OwnerPid]
    $ownerName = $null
    $ownerCmd = $null
    if ($owner) { $ownerName = $owner.Name; $ownerCmd = $owner.CommandLine }
    [void]$globalConsole.Add([pscustomobject]@{
        ownerPid     = $window.OwnerPid
        ownerProcess = $ownerName
        commandLine  = $ownerCmd
        windowClass  = $window.Class
        title        = $window.Title
    })
}

# 短命窗口轮询：-WatchSec N 时每 1 秒枚举一次，记录整段期间出现过的可见控制台窗口
# （包括刚弹出就消失的）。默认 0 不采样，保持原有一次快照行为。
$watchWindows = New-Object System.Collections.ArrayList
$watchSeen = @{}
$watchSamples = 0
if ($WatchSec -gt 0) {
    $watchDeadline = (Get-Date).AddSeconds($WatchSec)
    while ((Get-Date) -lt $watchDeadline) {
        $watchSamples++
        $sampleList = New-Object System.Collections.ArrayList
        $sampleCallback = {
            param([IntPtr]$hWnd, [IntPtr]$lParam)
            if (-not [DshWindows]::IsWindowVisible($hWnd)) { return $true }
            $classBuffer = New-Object System.Text.StringBuilder 256
            [void][DshWindows]::GetClassName($hWnd, $classBuffer, 256)
            $className = $classBuffer.ToString()
            if ($script:CONSOLE_CLASSES -notcontains $className) { return $true }
            $ownerPid = 0
            [void][DshWindows]::GetWindowThreadProcessId($hWnd, [ref]$ownerPid)
            $titleBuffer = New-Object System.Text.StringBuilder 512
            [void][DshWindows]::GetWindowText($hWnd, $titleBuffer, 512)
            [void]$sampleList.Add([pscustomobject]@{
                handle      = [int64]$hWnd
                ownerPid    = [int]$ownerPid
                windowClass = $className
                title       = $titleBuffer.ToString()
                seenAt      = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
            })
            return $true
        }
        [void][DshWindows]::EnumWindows($sampleCallback, [IntPtr]::Zero)
        foreach ($window in @($sampleList)) {
            $key = [string]$window.handle
            if (-not $watchSeen.ContainsKey($key)) {
                $watchSeen[$key] = $window
                [void]$watchWindows.Add($window)
            }
        }
        Start-Sleep -Milliseconds 1000
    }
}

$payload = [pscustomobject]@{
    ok = ($violations.Count -eq 0 -and $globalConsole.Count -eq 0 -and $watchWindows.Count -eq 0)
    checkedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    method = 'EnumWindows + GetWindowThreadProcessId + IsWindowVisible + GetClassName；conhost 窗口按 ParentProcessId 归到目标进程；另统计整机可见控制台窗口兜底；可选 1 秒轮询抓短命窗口'
    visibleConsoleCount = $violations.Count
    globalVisibleConsoleCount = $globalConsole.Count
    globalConsoleWindows = @($globalConsole)
    watchSec = $WatchSec
    watchSamples = $watchSamples
    watchVisibleCount = $watchWindows.Count
    watchWindows = @($watchWindows)
    violations = @($violations)
    targets = @($resultTargets)
}

$payload | ConvertTo-Json -Depth 6
