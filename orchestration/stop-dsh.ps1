# stop-dsh.ps1 -- DSH / QQ Bot 全栈有序关停（可重复执行、幂等、无残留）。
#
# 顺序（不能调换）：
#   [1] 自愈层：先落停机标记，再注销计划任务，最后结束看护/探针/reload watcher。
#       先停自愈层，否则停业务进程时会立刻被 watchdog 重新拉起。
#   [2] 业务层：按依赖关系结束进程树（Harness -> bridge -> AstrBot -> console
#       -> proxy -> TTS -> ninfer 启动器/引擎）。先子后父，避免留下孤儿。
#   [3] 双向复核：逐端口打印是否仍 LISTEN；逐组件按规则重扫，打印每个 pid 是否消失。
#   [4] 残留扫描：枚举 node/python/pythonw/powershell/wscript/cmd，凡命令行指向本项目目录的
#       一律列出并尝试结束；杀不掉的打印原因，不静默跳过。
#
# 幂等：本来就没运行的项直接打印「未运行」，不报错、不对不存在的 pid 发任何信号。
#
# 外部 OneBot 协议端与 QQ 客户端都不在关停范围：它们由用户自行管理，
# 本脚本不结束其进程，只在收尾摘要里如实打印 3000/3001 的占用情况。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File Y:\dsh\stop-dsh.ps1
#   ... -DryRun           只打印将结束的 pid 与端口状态，不发任何终止信号、不改任何标记/任务
#   ... -PauseOnExit      结束时等回车再关窗口（桌面「关闭 DSH」快捷方式用；自动调用不要带）
#
# 退出码：0 = 已全部停止（或本来就没运行）；1 = 有杀不掉的残留
# 日志：Y:\dsh\2026-11-10\qqbot-ninfer-bridge\work\stop-dsh.log

param(
    [switch]$DryRun,
    [switch]$PauseOnExit
)

$ErrorActionPreference = 'Continue'

$Root = 'Y:\dsh'
# 本脚本所在目录：同目录的 watchdog 从这里找。
$Here = $PSScriptRoot
$WorkDir = Join-Path $Root '2026-11-10\qqbot-ninfer-bridge\work'
$LogPath = Join-Path $WorkDir 'stop-dsh.log'
$TaskArchive = Join-Path $Root '归档\scheduled-tasks-20261116'

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

$script:Remaining = New-Object System.Collections.ArrayList
$script:Touched = New-Object System.Collections.ArrayList

function Write-Log {
    param([ValidateSet('INFO', 'WARN', 'ERROR', 'STEP')][string]$Level, [string]$Message)
    $line = '[{0}] [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    try { Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8 } catch { }
    switch ($Level) {
        'ERROR' { Write-Host $Message -ForegroundColor Red }
        'WARN' { Write-Host $Message -ForegroundColor Yellow }
        'STEP' { Write-Host ''; Write-Host $Message -ForegroundColor Cyan }
        default { Write-Host $Message }
    }
}

# ---------------------------------------------------------------- 公共设施

function Get-PortOwner {
    param([int]$Port)
    $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($connection) { return [int]$connection.OwningProcess }
    return 0
}

# 受保护进程：当前脚本自身、它的全部祖先（含 Trae 扩展宿主）、以及所有 Trae 主进程。
# 这些 pid 在任何阶段都不允许被结束。
function Get-ProtectedPids {
    $set = New-Object 'System.Collections.Generic.HashSet[int]'
    $current = $PID
    while ($current -and $current -gt 0) {
        [void]$set.Add([int]$current)
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$current" -ErrorAction SilentlyContinue
        if (-not $proc) { break }
        $current = [int]$proc.ParentProcessId
    }
    foreach ($proc in @(Get-CimInstance Win32_Process -Filter "Name='Trae CN.exe'" -ErrorAction SilentlyContinue)) {
        [void]$set.Add([int]$proc.ProcessId)
    }
    return $set
}

function Get-MatchingProcesses {
    param([string]$ExePattern, [string]$ClPattern, $Protected)
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    return @($all | Where-Object {
            $_.Name -and ($_.Name -match $ExePattern) -and
            (-not $Protected.Contains([int]$_.ProcessId)) -and
            ($ClPattern -eq '' -or ($_.CommandLine -and $_.CommandLine -match $ClPattern))
        })
}

# 递归收集子孙 pid（返回顺序不保证，调用方自己按需排序）。
function Get-Descendants {
    param([int]$RootPid)
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $children = @{}
    foreach ($proc in $all) {
        $ppid = [int]$proc.ParentProcessId
        if (-not $children.ContainsKey($ppid)) { $children[$ppid] = New-Object System.Collections.ArrayList }
        [void]$children[$ppid].Add([int]$proc.ProcessId)
    }
    $result = New-Object System.Collections.ArrayList
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($RootPid)
    while ($queue.Count -gt 0) {
        $current = [int]$queue.Dequeue()
        if (-not $children.ContainsKey($current)) { continue }
        foreach ($child in @($children[$current])) {
            if (-not $result.Contains($child)) {
                [void]$result.Add($child)
                $queue.Enqueue($child)
            }
        }
    }
    return @($result)
}

# 结束一整棵进程树：先子孙（深的先），最后父进程。
# 返回 @{ ok; reason }；杀不掉的把原因收集起来，绝不静默忽略。
function Stop-Tree {
    param([int]$ProcessId, $Protected)

    if ($Protected.Contains($ProcessId)) {
        return @{ ok = $false; reason = '受保护（Trae 或本脚本自身进程链）' }
    }

    # QQ 客户端不在关停范围：即使它出现在某个目标进程树里，也绝不结束、不计入失败/残留。
    $target = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($target -and $target.ProcessName -match '^(QQ|QQEX)$') {
        return @{ ok = $true; reason = '' }
    }

    $descendants = @(Get-Descendants -RootPid $ProcessId)
    # 深度优先：按 list 顺序反向（子孙的子孙在后面）逐个结束。
    $order = @()
    [array]::Reverse($descendants)
    $order += $descendants
    $order += $ProcessId

    $failures = @()
    foreach ($id in $order) {
        if ($Protected.Contains([int]$id)) {
            $failures += "pid=$id 受保护"
            continue
        }
        # 同上：进程树里混进的 QQ 进程一律跳过。
        $child = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($child -and $child.ProcessName -match '^(QQ|QQEX)$') { continue }
        try {
            Stop-Process -Id $id -Force -ErrorAction Stop
            if (-not $script:Touched.Contains([int]$id)) { [void]$script:Touched.Add([int]$id) }
        }
        catch {
            if (Get-Process -Id $id -ErrorAction SilentlyContinue) {
                $message = $_.Exception.Message
                if ($message -match '拒绝访问|Access is denied|denied') {
                    $failures += "pid=$id 拒绝访问（权限不足）"
                }
                else {
                    $failures += "pid=$id $message"
                }
            }
        }
    }
    Start-Sleep -Milliseconds 500
    return @{ ok = ($failures.Count -eq 0); reason = ($failures -join '；') }
}

# 一个组件的关停：规则命中的进程 + 端口 owner，去重后逐个树杀。
function Stop-Group {
    param([string]$Name, $Procs, [int[]]$Ports = @(), $Protected)

    $targets = New-Object System.Collections.ArrayList
    foreach ($proc in @($Procs)) {
        if ($null -eq $proc) { continue }
        $procId = [int]$proc.ProcessId
        if (-not $targets.Contains($procId)) { [void]$targets.Add($procId) }
    }
    foreach ($port in @($Ports)) {
        $owner = Get-PortOwner $port
        if ($owner -gt 0 -and -not $targets.Contains($owner) -and -not $Protected.Contains($owner)) {
            [void]$targets.Add($owner)
        }
    }

    if ($targets.Count -eq 0) {
        Write-Log INFO ("  {0}：未运行" -f $Name)
        return
    }

    $desc = ($targets | ForEach-Object { "pid=$($_)" }) -join ', '
    if ($DryRun) {
        Write-Log INFO ("  {0}：正在运行（{1}）-> DryRun，不结束" -f $Name, $desc)
        return
    }

    Write-Log INFO ("  {0}：结束 {1}" -f $Name, $desc)
    foreach ($id in @($targets)) {
        $result = Stop-Tree -ProcessId $id -Protected $Protected
        if (-not $result.ok) {
            Write-Log WARN ("  {0}：pid={1} 未完全结束：{2}" -f $Name, $id, $result.reason)
        }
    }
}

# ---------------------------------------------------------------- 组件定义

# 业务层组件（按关停顺序）。启动顺序的逆序：先断宿主/转发，再断数据源。
$Groups = @(
    [pscustomobject]@{ Name = 'DeepSeek Harness'; Exe = '^DeepSeek Harness\.exe$'; Cl = ''; Ports = @() },
    [pscustomobject]@{ Name = 'bridge'; Exe = '^python(w)?\.exe$'; Cl = 'qq-cutover[\\/]bridge\.py'; Ports = @() },
    [pscustomobject]@{ Name = 'AstrBot 宿主/服务'; Exe = '^python(w)?\.exe$'; Cl = 'astrbot'; Ports = @(6199, 6299) },
    [pscustomobject]@{ Name = 'qq-console'; Exe = '^node\.exe$'; Cl = 'qq-console[\\/]server\.mjs'; Ports = @(1242) },
    # start-proxy.cmd 是 :run 死循环（node 退出后 2 秒重拉，还每 5 秒起一个 health 检查），
    # 必须先杀掉循环壳，否则只杀 node 会被立刻重启。
    [pscustomobject]@{ Name = 'proxy 启动循环'; Exe = '^cmd\.exe$'; Cl = 'start-proxy\.cmd'; Ports = @() },
    [pscustomobject]@{ Name = 'persona proxy'; Exe = '^node\.exe$'; Cl = 'qq-persona'; Ports = @(1240) },
    [pscustomobject]@{ Name = 'TTS 启动循环'; Exe = '^cmd\.exe$'; Cl = 'start-tts\.cmd'; Ports = @() },
    [pscustomobject]@{ Name = 'TTS 服务'; Exe = '^python(w)?\.exe$'; Cl = 'server_fastapi\.py'; Ports = @(5000) },
    [pscustomobject]@{ Name = 'TTS pyopenjtalk worker'; Exe = '^python(w)?\.exe$'; Cl = 'pyopenjtalk_worker'; Ports = @(7861) },
    [pscustomobject]@{ Name = 'ninfer 启动器'; Exe = '^python(w)?\.exe$'; Cl = 'serve-ninfer\.pyw'; Ports = @() },
    [pscustomobject]@{ Name = 'ninfer 引擎'; Exe = '^ninfer-serve-.*\.exe$'; Cl = ''; Ports = @(8094) }
)

# 自愈层：按脚本全路径精确匹配（避免把命令行里恰好提到这个名字的 Trae shell 当成看护进程）。
$WatchdogScripts = @(
    @{ Name = 'harness 看护'; Path = (Join-Path $Here 'harness-watchdog.ps1') },
    @{ Name = 'AstrBot/bridge 看护'; Path = (Join-Path $Here 'bot-child-watchdog.ps1') },
    @{ Name = '引擎恢复看护'; Path = (Join-Path $Here 'engine-restore-watchdog.ps1') },
    @{ Name = 'qq-console 看护'; Path = (Join-Path $Root 'home\qq-console\watchdog.ps1') },
    @{ Name = '日志监看'; Path = (Join-Path $Root 'home\qq-persona\watch-logs.ps1') },
    @{ Name = 'xzy 宿主看护'; Path = 'E:\Bonsai\astrbot-eval\tools\xzy_host_watchdog.ps1' }
)

$ScheduledTasks = @(
    @{ Name = 'xzy-host-watchdog'; Xml = 'xzy-host-watchdog.xml' },
    @{ Name = 'DSH-Start-AtLogon'; Xml = 'DSH-Start-AtLogon.xml' },
    @{ Name = 'DSH Sticker Maintenance'; Xml = 'DSH_Sticker_Maintenance.xml' }
)

$AllPorts = @(1240, 1242, 3000, 3001, 5000, 6199, 6299, 7861, 8094)

# ---------------------------------------------------------------- 开始

$Protected = Get-ProtectedPids

Write-Log STEP '=== stop-dsh: 有序关停开始 ==='
Write-Log INFO ("  模式：{0}" -f $(if ($DryRun) { 'DryRun（只读，不发终止信号）' } else { '真实执行' }))
Write-Log INFO ("  受保护进程（不会结束）：{0}" -f (($Protected | Sort-Object) -join ', '))

# ============ [1] 自愈层 ============
Write-Log STEP '[1/4] 自愈层（停机标记 -> 计划任务 -> 看护/探针）'

$PauseMarkers = @(
    (Join-Path $WorkDir 'harness.watchdog.pause'),
    (Join-Path $WorkDir 'bot-child.watchdog.pause')
)
foreach ($marker in $PauseMarkers) {
    $exists = Test-Path -LiteralPath $marker
    if ($DryRun) {
        Write-Log INFO ("  停机标记 {0}：{1} -> DryRun，不写入" -f (Split-Path -Leaf $marker), $(if ($exists) { '已存在' } else { '不存在' }))
        continue
    }
    try {
        Set-Content -LiteralPath $marker -Value ('stop-dsh ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding ascii
        Write-Log INFO ("  停机标记 {0}：已写入（守护看到后不会再把组件拉起来）" -f (Split-Path -Leaf $marker))
    }
    catch {
        Write-Log WARN ("  停机标记 {0} 写入失败：{1}" -f (Split-Path -Leaf $marker), $_.Exception.Message)
    }
}

foreach ($task in $ScheduledTasks) {
    $registered = Get-ScheduledTask -TaskName $task.Name -ErrorAction SilentlyContinue
    if (-not $registered) {
        Write-Log INFO ("  计划任务 {0}：未注册（无需处理）" -f $task.Name)
        continue
    }
    if ($DryRun) {
        Write-Log INFO ("  计划任务 {0}：存在（state={1}）-> DryRun，不注销" -f $task.Name, $registered.State)
        continue
    }
    # 注销前确保定义已归档（归档是恢复的唯一来源，不能丢）。
    $xmlPath = Join-Path $TaskArchive $task.Xml
    if (-not (Test-Path -LiteralPath $xmlPath)) {
        try {
            New-Item -ItemType Directory -Force -Path $TaskArchive | Out-Null
            Export-ScheduledTask -TaskName $task.Name | Set-Content -LiteralPath $xmlPath -Encoding UTF8
            Write-Log INFO ("  计划任务 {0}：定义已归档到 {1}" -f $task.Name, $xmlPath)
        }
        catch {
            Write-Log WARN ("  计划任务 {0}：归档失败（{1}），仍继续注销" -f $task.Name, $_.Exception.Message)
        }
    }
    try {
        Unregister-ScheduledTask -TaskName $task.Name -Confirm:$false -ErrorAction Stop
        Write-Log INFO ("  计划任务 {0}：已注销（状态 {1}，定义在 {2}）" -f $task.Name, $registered.State, $xmlPath)
    }
    catch {
        Write-Log WARN ("  计划任务 {0}：注销失败：{1}" -f $task.Name, $_.Exception.Message)
        [void]$script:Remaining.Add("计划任务 $($task.Name) 仍注册")
    }
}

foreach ($watchdog in $WatchdogScripts) {
    $pattern = [regex]::Escape($watchdog.Path)
    $procs = @(Get-MatchingProcesses -ExePattern '^(powershell|pwsh|wscript)\.exe$' -ClPattern $pattern -Protected $Protected)
    if ($procs.Count -eq 0) {
        Write-Log INFO ("  {0}：未运行" -f $watchdog.Name)
        continue
    }
    if ($DryRun) {
        Write-Log INFO ("  {0}：正在运行（{1}）-> DryRun，不结束" -f $watchdog.Name, (($procs | ForEach-Object { "pid=$($_.ProcessId)" }) -join ', '))
        continue
    }
    Write-Log INFO ("  {0}：结束 {1}" -f $watchdog.Name, (($procs | ForEach-Object { "pid=$($_.ProcessId)" }) -join ', '))
    foreach ($proc in $procs) {
        $result = Stop-Tree -ProcessId ([int]$proc.ProcessId) -Protected $Protected
        if (-not $result.ok) {
            Write-Log WARN ("  {0}：pid={1} 未完全结束：{2}" -f $watchdog.Name, $proc.ProcessId, $result.reason)
        }
    }
}

# 健康探针：只知道 pidfile 位置，脚本名按命令行里的 health-window 兜底匹配。
$healthPidFile = Join-Path $Root 'logs\health-window\health-window.pid'
$healthProcs = @(Get-MatchingProcesses -ExePattern '^(powershell|pwsh|python|pythonw|wscript)\.exe$' -ClPattern 'health-window' -Protected $Protected)
if ($healthProcs.Count -eq 0) {
    Write-Log INFO ("  健康探针 health-window：未运行（pidfile {0}）" -f $(if (Test-Path -LiteralPath $healthPidFile) { '存在' } else { '不存在' }))
}
elseif ($DryRun) {
    Write-Log INFO ("  健康探针 health-window：正在运行（{0}）-> DryRun，不结束" -f (($healthProcs | ForEach-Object { "pid=$($_.ProcessId)" }) -join ', '))
}
else {
    Write-Log INFO ("  健康探针 health-window：结束 {0}" -f (($healthProcs | ForEach-Object { "pid=$($_.ProcessId)" }) -join ', '))
    foreach ($proc in $healthProcs) {
        $result = Stop-Tree -ProcessId ([int]$proc.ProcessId) -Protected $Protected
        if (-not $result.ok) { Write-Log WARN ("  健康探针：pid={0} 未完全结束：{1}" -f $proc.ProcessId, $result.reason) }
    }
}

# 看护层复核：上面规则再扫一遍，仍存在的直接点名。
$leftoverWatchdogs = @()
foreach ($watchdog in $WatchdogScripts) {
    $pattern = [regex]::Escape($watchdog.Path)
    $leftoverWatchdogs += @(Get-MatchingProcesses -ExePattern '^(powershell|pwsh|wscript)\.exe$' -ClPattern $pattern -Protected $Protected)
}
if ($leftoverWatchdogs.Count -gt 0 -and -not $DryRun) {
    foreach ($proc in $leftoverWatchdogs) {
        Write-Log WARN ("  自愈层残留：pid={0} {1}" -f $proc.ProcessId, $proc.CommandLine)
        [void]$script:Remaining.Add("看护进程 pid=$($proc.ProcessId) 仍在运行")
    }
}

# 看护自己的单实例 pid 文件同步清掉，避免下次启动把陈旧 pid 当成「已在运行」。
foreach ($pidFile in @('harness.watchdog.pid', 'bot-child.watchdog.pid')) {
    $path = Join-Path $WorkDir $pidFile
    if ($DryRun) { continue }
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        Write-Log INFO ("  已清理陈旧 pid 文件：{0}" -f $pidFile)
    }
}

# ============ [2] 业务层 ============
Write-Log STEP '[2/4] 业务层（按依赖逆序树杀）'
foreach ($group in $Groups) {
    $procs = @(Get-MatchingProcesses -ExePattern $group.Exe -ClPattern $group.Cl -Protected $Protected)
    Stop-Group -Name $group.Name -Procs $procs -Ports $group.Ports -Protected $Protected
}

# ============ [3] 双向复核 ============
Write-Log STEP '[3/4] 双向复核（端口 + 进程）'

Write-Log INFO '  端口：'
foreach ($port in $AllPorts) {
    $owner = Get-PortOwner $port
    if ($owner -gt 0) {
        Write-Log WARN ("    {0,-5} 仍 LISTEN(pid={1})" -f $port, $owner)
        if (-not $DryRun) { [void]$script:Remaining.Add("端口 $port 仍被 pid=$owner 占用") }
    }
    else {
        Write-Log INFO ("    {0,-5} 已释放" -f $port)
    }
}

Write-Log INFO '  组件进程：'
foreach ($group in $Groups) {
    $procs = @(Get-MatchingProcesses -ExePattern $group.Exe -ClPattern $group.Cl -Protected $Protected)
    if ($procs.Count -eq 0) {
        Write-Log INFO ("    {0}：已消失" -f $group.Name)
    }
    else {
        $detail = ($procs | ForEach-Object { "pid=$($_.ProcessId)" }) -join ', '
        Write-Log WARN ("    {0}：仍存在 {1}" -f $group.Name, $detail)
        if (-not $DryRun) { [void]$script:Remaining.Add("$($group.Name) 仍存在 $detail") }
    }
}

# 本轮下过手的 pid 逐个确认：进程对象彻底没了才算消失。
$aliveTouched = @()
foreach ($id in @($script:Touched)) {
    if (Get-Process -Id $id -ErrorAction SilentlyContinue) { $aliveTouched += $id }
}
if ($script:Touched.Count -eq 0) {
    if ($DryRun) { Write-Log INFO '  DryRun：未结束任何进程。' }
    else { Write-Log INFO '  本轮未结束任何进程（全部本来就没运行）。' }
}
elseif ($aliveTouched.Count -eq 0) {
    Write-Log INFO ("  本轮结束的 {0} 个 pid 均已消失。" -f $script:Touched.Count)
}
else {
    foreach ($id in $aliveTouched) {
        $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
        $reason = '结束信号已发出但进程仍在：可能是服务自身还在做收尾，或需要更高权限'
        Write-Log WARN ("    pid={0}（{1}）仍在：{2}" -f $id, $proc.ProcessName, $reason)
        [void]$script:Remaining.Add("pid=$id $($proc.ProcessName) 结束后仍存在")
    }
}

# ============ [4] 残留扫描 ============
Write-Log STEP '[4/4] 残留扫描（命令行指向本项目目录的 node/python/pythonw/powershell/wscript）'

$ProjectRoots = @(
    'Y:\\dsh',
    'Y:\\Style-Bert-VITS2-CUDA',
    'E:\\Bonsai\\astrbot-eval',
    'Y:\\workspace\\ninfer'
)
$rootRegex = ($ProjectRoots -join '|')

$sweep = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -and ($_.Name -match '^(node|python|pythonw|powershell|pwsh|wscript|cmd)\.exe$') -and
        $_.CommandLine -and ($_.CommandLine -match $rootRegex) -and
        (-not $Protected.Contains([int]$_.ProcessId)) -and
        # Trae 自己的命令壳：命令行里会内嵌整段脚本文本（含 Y:\dsh 路径），必须排除。
        ($_.CommandLine -notmatch 'TRAE_CHAT_SESSION_ID|__TRAE_PATH_')
    })

if ($sweep.Count -eq 0) {
    Write-Log INFO '  残留扫描：无'
}
else {
    foreach ($proc in $sweep) {
        Write-Log WARN ("  残留：pid={0} {1} :: {2}" -f $proc.ProcessId, $proc.Name, $proc.CommandLine)
        if ($DryRun) { continue }
        $result = Stop-Tree -ProcessId ([int]$proc.ProcessId) -Protected $Protected
        Start-Sleep -Milliseconds 300
        if (Get-Process -Id ([int]$proc.ProcessId) -ErrorAction SilentlyContinue) {
            $reason = if ($result.reason) { $result.reason } else { '结束信号已发出但进程仍在' }
            Write-Log WARN ("    pid={0} 仍存在：{1}" -f $proc.ProcessId, $reason)
            [void]$script:Remaining.Add("残留 pid=$($proc.ProcessId) 无法结束")
        }
        else {
            Write-Log INFO ("    pid={0} 已结束" -f $proc.ProcessId)
        }
    }
}

# ---------------------------------------------------------------- 汇总

Write-Log STEP '=== stop-dsh: 结果 ==='
if ($DryRun) {
    Write-Log INFO 'DryRun：未发送任何终止信号、未注销任务、未写停机标记。'
}

# 外部 OneBot 协议端与 QQ 客户端只陈述现状：不探测、不结束、不计入残留。
$onebotOwners = @(foreach ($p in @(3000, 3001)) {
        $o = Get-PortOwner $p
        if ($o -gt 0) { "端口 $p pid=$o" }
    })
Write-Log INFO '外部 OneBot 协议端 / QQ 客户端：保留（不在关停范围：未结束、不计入残留）'
if ($onebotOwners.Count -gt 0) {
    Write-Log INFO ("一步提醒：3000/3001 仍被占用（{0}），由你的协议端自行管理。" -f ($onebotOwners -join '、'))
}
else {
    Write-Log INFO '3000/3001 当前未被占用。'
}

if ($DryRun) {
    Write-Log INFO 'DryRun：以上为将结束的目标，未发送任何信号；不计为残留。'
}
elseif ($script:Remaining.Count -eq 0) {
    Write-Log INFO 'stop-dsh: 已全部停止，端口与进程均无残留。'
}
else {
    Write-Log ERROR 'stop-dsh: 仍有残留，逐项如下：'
    foreach ($item in $script:Remaining) { Write-Log ERROR ("  - " + $item) }
}
$exitCode = if ($DryRun) { 0 } elseif ($script:Remaining.Count -eq 0) { 0 } else { 1 }
Write-Log INFO ("日志：{0}" -f $LogPath)

if ($PauseOnExit) {
    try { [void](Read-Host '按回车关闭窗口') } catch { }
}

exit $exitCode
