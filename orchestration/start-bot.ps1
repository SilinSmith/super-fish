# 机器人栈唯一显式启动入口 —— 只在你手动运行时执行。
# 已取消所有开机 / 登录 / 空闲 / 定时触发：不跑这个入口，栈不会自己起来；
# 也不创建 / 启用任何计划任务（两个旧任务保持 0 触发器 + Disabled）。
#
# 两种模式：
#   默认（仅基础设施）：1) ninfer 引擎 8094   2) persona proxy 1240   3) qq-console 1242
#   接流量（-ConnectTraffic）额外要求：
#       4) OneBot 协议端 3001（需自备，入口只探测不拉起）   5) AstrBot 6299/6199   6) DeepSeek Harness 宿主 + dsh-onebot 插件
# 两种模式都会探测 ComfyUI(8188)，但只探测：用户自管，不拉起 / 不重启 / 不结束。
#
# 接流量前 start-dsh.ps1 会校验 bridge-mode.json（mode=old 或 one-group 缺 group_id 直接拒绝），
# 因为 bridge 只在进程启动时读该文件，宿主起来后再改必须重启宿主才生效。
#
# 幂等：先逐项真实探测；全部就绪就直接返回 0，不重复拉起。
# 超时：每一步都有独立上限（见 $Steps）；拉起阶段由 start-dsh.ps1 -FailFast 逐组件超时。
# 窗口：核心组件经既有隐藏链拉起；AstrBot/bridge 经 hidden-launch.ps1 -HiddenConsole 拉起，均无可见窗口。
#
# 用法：
#   双击 Y:\dsh\start-dsh.vbs（仅基础设施）
#   接流量：powershell -ExecutionPolicy Bypass -File Y:\dsh\start-bot.ps1 -ConnectTraffic
#   或：powershell -ExecutionPolicy Bypass -File Y:\dsh\start-bot.ps1
#       ... -DryRun              只打印模式、步骤与当前就绪状态，不启动任何进程
#       ... -ConnectTraffic      接 QQ 流量（默认不接）
#
# 退出码：0 全部就绪 / 10 有组件未就绪或启动被拒绝（fail-closed）
# 日志：Y:\dsh\2026-11-10\qqbot-ninfer-bridge\work\start-bot.log
#
# 停机走 Y:\dsh\stop-dsh.ps1（先落守护停机标记再停守护，停完不会自己复活）。

param(
    [switch]$ConnectTraffic,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$Root = 'Y:\dsh'
# 本脚本所在目录：同目录的 start/stop/watchdog 从这里找，仓库放到任何位置都能用。
$Here = $PSScriptRoot
$StartScript = Join-Path $Here 'start-dsh.ps1'
$StopScript = Join-Path $Here 'stop-dsh.ps1'
$LogPath = Join-Path $Root '2026-11-10\qqbot-ninfer-bridge\work\start-bot.log'
$script:PluginLog = Join-Path $Root 'home\qq-onebot-plugin\logs\s0.log'
$script:PluginOffset = 0
$script:ModelId = 'bonsai-2-27b'
$script:LaunchTimeoutMs = 900000

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null

function Say {
    param(
        [ValidateSet('INFO', 'PASS', 'WARN', 'ERROR')][string]$Level = 'INFO',
        [string]$Text
    )
    $line = '[{0}] [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Text
    try { Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8 } catch { }
    switch ($Level) {
        'PASS' { Write-Host $Text -ForegroundColor Green }
        'WARN' { Write-Host $Text -ForegroundColor Yellow }
        'ERROR' { Write-Host $Text -ForegroundColor Red }
        default { Write-Host $Text }
    }
}

function Get-PortOwner {
    param([int]$Port)
    $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($connection) { return [int]$connection.OwningProcess }
    return 0
}

function Test-HttpOk {
    param([string]$Url, [int]$TimeoutSec = 3)
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec -ErrorAction Stop
        return ([int]$response.StatusCode -eq 200)
    }
    catch {
        if ($_.Exception.Response) {
            try { return ([int]$_.Exception.Response.StatusCode -eq 200) } catch { return $false }
        }
        return $false
    }
}

# === 逐组件真实探测（不是看进程在不在） ===

function Test-Engine {
    try {
        $models = Invoke-RestMethod -Uri 'http://127.0.0.1:8094/v1/models' -TimeoutSec 4 -ErrorAction Stop
        $ids = @($models.data | ForEach-Object { [string]$_.id })
        if ($ids -notcontains $script:ModelId) {
            return @{ ok = $false; detail = "models=[$($ids -join ', ')]，缺少 $($script:ModelId)" }
        }
        return @{ ok = $true; detail = "models=[$($ids -join ', ')]" }
    }
    catch {
        return @{ ok = $false; detail = "GET /v1/models 失败：$($_.Exception.Message)" }
    }
}

function Test-Proxy {
    if (Test-HttpOk -Url 'http://127.0.0.1:1240/health') {
        return @{ ok = $true; detail = 'GET /health 200' }
    }
    return @{ ok = $false; detail = 'GET http://127.0.0.1:1240/health 非 200 / 未监听' }
}

function Test-OneBotEndpoint {
    $wsPort = Get-PortOwner 3001
    if ($wsPort -eq 0) {
        return @{ ok = $false; detail = '3001 未监听（外部 OneBot 协议端未启动或未登录）' }
    }
    $httpPort = Get-PortOwner 3000
    $extra = if ($httpPort -eq 0) { '；3000 未监听（OneBot HTTP）' } else { '；3000 在监听（OneBot HTTP）' }
    return @{ ok = $true; detail = ("3001 监听中 pid=$wsPort" + $extra) }
}

function Test-AstrBot {
    $dashboard = Test-HttpOk -Url 'http://127.0.0.1:6299/' -TimeoutSec 4
    $port6199 = Get-PortOwner 6199
    if ($dashboard -and $port6199 -ne 0) {
        return @{ ok = $true; detail = "6299 GET / 200；6199 监听中 pid=$port6199" }
    }
    $parts = @()
    if (-not $dashboard) { $parts += '6299 GET / 非 200 / 未监听' }
    if ($port6199 -eq 0) { $parts += '6199 未监听' }
    return @{ ok = $false; detail = ($parts -join '；') }
}

function Test-Console {
    if (Test-HttpOk -Url 'http://127.0.0.1:1242/api/health') {
        return @{ ok = $true; detail = 'GET /api/health 200' }
    }
    return @{ ok = $false; detail = 'GET http://127.0.0.1:1242/api/health 非 200 / 未监听' }
}

function Test-Host {
    param([switch]$RequireFresh)

    $mains = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch '--expose-internals' })
    if ($mains.Count -eq 0) {
        return @{ ok = $false; detail = '未发现宿主主进程（DeepSeek Harness.exe）' }
    }
    $pids = ($mains | ForEach-Object { $_.ProcessId }) -join ','

    $text = ''
    if (Test-Path -LiteralPath $script:PluginLog) {
        try {
            $stream = [System.IO.File]::Open($script:PluginLog, 'Open', 'Read', 'ReadWrite')
            try {
                $from = if ($RequireFresh) { $script:PluginOffset } else { [Math]::Max(0, $stream.Length - 8000) }
                if ($stream.Length -gt $from) {
                    [void]$stream.Seek($from, 'Begin')
                    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
                    $text = $reader.ReadToEnd()
                }
            }
            finally { $stream.Dispose() }
        }
        catch { }
    }
    if ($text -notmatch 'WS 已连接') {
        $scope = if ($RequireFresh) { '本轮新增日志' } else { '最近日志' }
        return @{ ok = $false; detail = "宿主 pid=$pids 在跑，但插件$scope无「WS 已连接」（dsh-onebot 未挂载或未连上 3001）" }
    }
    return @{ ok = $true; detail = "宿主 pid=$pids，dsh-onebot 插件已连上 3001（WS 已连接）" }
}

# [约束 2026-11-14] ComfyUI(8188) 由用户自行占用：只探测状态，绝不拉起、重启或结束。
function Get-ComfyStatus {
    $comfyPid = Get-PortOwner 8188
    if ($comfyPid -eq 0) {
        return @{ running = $false; detail = '8188 未监听（ComfyUI 由用户自管，本脚本不拉起）' }
    }
    $healthy = Test-HttpOk -Url 'http://127.0.0.1:8188/system_stats'
    $extra = if ($healthy) { '/system_stats 200' } else { '/system_stats 非 200' }
    return @{ running = $true; detail = "8188 在监听 pid=$comfyPid（$extra），ComfyUI 由用户占用，跳过，不管理" }
}

# 接流量前校验 bridge-mode.json：mode=old 等于不转发，one-group 缺 group_id 等于一条也不转发。
# 与 start-dsh.ps1 的同名校验保持同一口径（两处都会拦，避免只走其中一条路径时漏检）。
function Assert-BridgeMode {
    $path = Join-Path $Root 'home\qq-cutover\bridge-mode.json'
    if (-not (Test-Path -LiteralPath $path)) {
        Say ERROR "接流量被拒绝：找不到 $path（需要 mode=private / one-group / all）。"
        exit 10
    }
    try { $bridgeMode = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json }
    catch {
        Say ERROR "接流量被拒绝：bridge-mode.json 不是合法 JSON（$path）。"
        exit 10
    }
    $mode = [string]$bridgeMode.mode
    if (-not $mode -or $mode -eq 'old') {
        Say ERROR "接流量被拒绝：bridge-mode.json 的 mode='$mode'（等于不转发）。请改为 private / one-group / all：$path"
        exit 10
    }
    if (@('private', 'one-group', 'all') -notcontains $mode) {
        Say ERROR "接流量被拒绝：bridge-mode.json 的 mode='$mode' 不是已知值（private / one-group / all）。"
        exit 10
    }
    if ($mode -eq 'one-group' -and -not [string]$bridgeMode.group_id) {
        Say ERROR "接流量被拒绝：mode=one-group 但 group_id 为空，一条也不会转发：$path"
        exit 10
    }
    Say INFO "  bridge-mode.json 校验通过：mode=$mode"
}


# 顺序即契约顺序。基础设施三个步骤两种模式都必须过；
# OneBot 协议端 / AstrBot / 宿主只在 -ConnectTraffic 时进入契约（默认不接 QQ 流量）。
$infraSteps = @(
    @{ name = 'ninfer 引擎(8094)'; probe = { Test-Engine }; timeoutSec = 600; action = 'engine-control.ps1 -Action restore（supervisor 隐藏拉起）' },
    @{ name = 'persona proxy(1240)'; probe = { Test-Proxy }; timeoutSec = 90; action = 'start-dsh.ps1 内 start-proxy.cmd 看护循环（隐藏链）' },
    @{ name = 'qq-console(1242)'; probe = { Test-Console }; timeoutSec = 60; action = 'start-dsh.ps1 内 qq-console 启动链（隐藏链）' }
)
$trafficSteps = @(
    @{ name = 'OneBot 协议端(3001)'; probe = { Test-OneBotEndpoint }; timeoutSec = 120; action = '外部依赖：需自行启动，只探测 3000/3001' },
    @{ name = 'AstrBot(6299/6199)'; probe = { Test-AstrBot }; timeoutSec = 120; action = 'bot-child-watchdog.ps1 经 hidden-launch.ps1 -HiddenConsole 拉起 venv python -m astrbot.cli run -p 6299' },
    @{ name = 'DeepSeek Harness + dsh-onebot 插件'; probe = { Test-Host }; timeoutSec = 90; action = 'start-dsh.ps1 内 Harness 宿主 + dsh-onebot 插件（隐藏链）' }
)
# 按契约顺序插入：引擎 -> proxy -> OneBot 协议端 -> AstrBot -> console -> 宿主。
$Steps = @($infraSteps[0], $infraSteps[1])
if ($ConnectTraffic) { $Steps += @($trafficSteps[0], $trafficSteps[1]) }
$Steps += $infraSteps[2]
if ($ConnectTraffic) { $Steps += $trafficSteps[2] }
# ComfyUI(8188) 不在步骤里：用户自管，只探测、不列入启动契约。

function Invoke-StepProbe {
    param($Step, [switch]$RequireFresh)
    # 宿主判断分两种口径：拉起前看最近日志（幂等预检），拉起后只认本轮新增（防止旧行冒充）。
    if ($RequireFresh -and $Step.name -like 'DeepSeek Harness*') { return (Test-Host -RequireFresh) }
    return (& $Step.probe)
}

# 等一个步骤就绪；超时返回最后一次探测结果，由调用方 fail-closed 处理。
function Wait-Step {
    param($Step)
    $startedAt = Get-Date
    $deadline = $startedAt.AddSeconds([int]$Step.timeoutSec)
    $last = @{ ok = $false; detail = '未探测' }
    while ($true) {
        $last = Invoke-StepProbe -Step $Step -RequireFresh
        if ($last.ok) { break }
        if ((Get-Date) -ge $deadline) { break }
        Start-Sleep -Milliseconds 800
    }
    $last.elapsedSec = [Math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1)
    return $last
}

# === 预检：幂等 + DryRun ===
Say INFO ''
$modeText = if ($ConnectTraffic) { '接流量（基础设施 + OneBot 协议端 + AstrBot/bridge + Harness）' } else { '仅基础设施（默认，不接 QQ 流量）' }
Say INFO ("=== start-bot: 幂等预检（逐项真实探测） | 模式：{0} ===" -f $modeText)
# 接流量前先验证 bridge-mode.json：不合格就不要动任何组件。
if ($ConnectTraffic) { Assert-BridgeMode }
$precheck = @()
foreach ($step in $Steps) {
    $result = Invoke-StepProbe -Step $step
    $precheck += [pscustomobject]@{ step = $step; result = $result }
    $flag = if ($result.ok) { 'PASS' } else { '----' }
    Say INFO ("  [{0}] {1}：{2}" -f $flag, $step.name, $result.detail)
}
# ComfyUI 只探测，不进步骤、不参与失败判定。
$comfyStatus = Get-ComfyStatus
Say INFO ("  [SKIP] ComfyUI(8188)：{0}" -f $comfyStatus.detail)

if ($DryRun) {
    Say INFO ''
    Say INFO '[DryRun] 逐项动作（只读探测，不启动任何进程）：'
    for ($i = 0; $i -lt $Steps.Count; $i++) {
        $step = $Steps[$i]
        $cur = ($precheck | Where-Object { $_.step.name -eq $step.name } | Select-Object -First 1).result
        if ($cur.ok) {
            Say INFO ("  {0}. {1}：已就绪，跳过（{2}）" -f ($i + 1), $step.name, $cur.detail)
        }
        else {
            Say INFO ("  {0}. {1}：未就绪 -> {2}；最多等 {3}s（当前：{4}）" -f ($i + 1), $step.name, $step.action, $step.timeoutSec, $cur.detail)
        }
    }
    if ($ConnectTraffic) {
        Say INFO '[DryRun] AstrBot/bridge 由 bot-child-watchdog.ps1 用 hidden-launch.ps1 -HiddenConsole 守卫拉起（start-dsh 缺核心组件时也会确保该守护在跑）。'
        Say INFO '[DryRun] 核心组件有缺项时调用 start-dsh.ps1 -FailFast -ConnectTraffic；仅 AstrBot 缺项时不重启其它组件。'
    }
    else {
        Say INFO '[DryRun] 默认模式不接流量：不会拉起 OneBot 协议端 / AstrBot / bridge / Harness，也不会清任何 pause 标记。'
        Say INFO '[DryRun] 核心组件有缺项时调用 start-dsh.ps1 -FailFast（不带 -ConnectTraffic）。'
    }
    Say INFO '[DryRun] ComfyUI(8188) 由用户自管：只探测，不拉起、不重启、不结束。'
    Say INFO '[DryRun] 任一项最终未就绪 -> exit 10，并列出组件名与原因。'
    exit 0
}

$notReady = @($precheck | Where-Object { -not $_.result.ok })
if ($notReady.Count -eq 0) {
    Say PASS ''
    if ($ConnectTraffic) { Say PASS '接流量所需组件全部在运行且逐项验证通过（幂等，不重复拉起）。' }
    else { Say PASS '基础设施全部在运行且逐项验证通过（幂等，不重复拉起；未接 QQ 流量）。' }
    exit 0
}
# 记录插件日志起点：拉起后只认本轮新增的「WS 已连接」。
if (Test-Path -LiteralPath $script:PluginLog) {
    try { $script:PluginOffset = (Get-Item -LiteralPath $script:PluginLog).Length } catch { $script:PluginOffset = 0 }
}

# === 拉起 ===
$coreMissing = @($precheck | Where-Object { -not $_.result.ok -and $_.step.name -notlike 'AstrBot*' })
$astrMissing = @($precheck | Where-Object { -not $_.result.ok -and $_.step.name -like 'AstrBot*' })

if ($coreMissing.Count -gt 0) {
    # 唯一入口 -> start-dsh.ps1 -FailFast（接流量时把 -ConnectTraffic 透传下去）
    Say INFO ''
    Say INFO ("=== 启动机器人栈（{0}） ===" -f $modeText)
    if (-not (Test-Path -LiteralPath $StartScript)) {
        Say ERROR "找不到启动脚本：$StartScript"
        exit 10
    }

    $startArgs = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $StartScript, '-FailFast')
    if ($ConnectTraffic) { $startArgs += '-ConnectTraffic' }
    $launchOutput = & powershell.exe @startArgs 2>&1
    $launchCode = $LASTEXITCODE
    foreach ($line in @($launchOutput)) {
        Say INFO ("  " + [string]$line)
    }

    $failText = ($launchOutput | Where-Object { [string]$_ -match '^\s*\[FAIL\]' } | Select-Object -First 1)
    if ($launchCode -ne 0) {
        Say ERROR ''
        if ($failText) { Say ERROR ("启动被拒绝（fail-closed）：" + [string]$failText) }
        else { Say ERROR ("启动脚本异常退出，退出码=$launchCode") }
        Say ERROR ("完整日志：{0}" -f (Join-Path $Root '2026-11-10\qqbot-ninfer-bridge\work\start-dsh.log'))
        Say ERROR ("已启动的组件保持运行；如需全部停止：powershell -ExecutionPolicy Bypass -File `"{0}`"" -f $StopScript)
        exit 10
    }
}
else {
    Say INFO '核心组件均已就绪，跳过 start-dsh.ps1（幂等）。'
}

if ($astrMissing.Count -gt 0) {
    Say INFO ''
    Say INFO '=== 启动 AstrBot + bridge（bot-child-watchdog.ps1，独立隐藏链） ==='
    $botChildWatcher = Join-Path $Here 'bot-child-watchdog.ps1'
    $botChildWorkDir = Join-Path $Root '2026-11-10\qqbot-ninfer-bridge\work'
    $botChildPause = Join-Path $botChildWorkDir 'bot-child.watchdog.pause'
    $botChildPidFile = Join-Path $botChildWorkDir 'bot-child.watchdog.pid'
    if (-not (Test-Path -LiteralPath $botChildWatcher)) {
        Say ERROR "找不到 AstrBot/bridge 守护：$botChildWatcher"
        exit 10
    }
    New-Item -ItemType Directory -Force -Path $botChildWorkDir | Out-Null
    Remove-Item -LiteralPath $botChildPause -Force -ErrorAction SilentlyContinue
    $watchdogAlive = $false
    $oldPid = $null
    if (Test-Path -LiteralPath $botChildPidFile) {
        $oldPid = Get-Content -LiteralPath $botChildPidFile -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($oldPid -and (Get-Process -Id ([int]$oldPid) -ErrorAction SilentlyContinue)) { $watchdogAlive = $true }
    }
    if ($watchdogAlive) {
        Say INFO "  AstrBot/bridge 守护已在运行（pid $oldPid），由它拉起缺失组件。"
    }
    else {
        $hiddenLauncher = Join-Path $Here 'hidden-launch.ps1'
        if (-not (Test-Path -LiteralPath $hiddenLauncher)) {
            Say ERROR "找不到无窗口启动器：$hiddenLauncher"
            exit 10
        }
        try {
            $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            $watchdogArgs = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $botChildWatcher + '"'
            $line = & $hiddenLauncher -FilePath $psExe -Arguments $watchdogArgs -WorkingDirectory $Root `
                -OutLog (Join-Path $botChildWorkDir 'bot-child.watchdog.out.log') `
                -ErrLog (Join-Path $botChildWorkDir 'bot-child.watchdog.err.log') -HiddenConsole -Append
            Say INFO ("  hidden-launch: " + [string]$line)
        }
        catch {
            Say ERROR ("AstrBot/bridge 守护拉起失败：{0}" -f $_.Exception.Message)
            exit 10
        }
    }
}

# === 拉起后按契约顺序逐项复核（每项独立超时） ===
Say INFO ''
Say INFO '=== 逐项复核（真实接口 / 端口 / 日志证据） ==='
$failures = @()
for ($i = 0; $i -lt $Steps.Count; $i++) {
    $step = $Steps[$i]
    $result = Wait-Step -Step $step
    if ($result.ok) {
        Say PASS ("  [{0}/{1}] PASS  {2}  {3}s  {4}" -f ($i + 1), $Steps.Count, $step.name, $result.elapsedSec, $result.detail)
    }
    else {
        $msg = ("  [{0}/{1}] FAIL  {2}  {3}s  {4}" -f ($i + 1), $Steps.Count, $step.name, $result.elapsedSec, $result.detail)
        Say ERROR $msg
        $failures += ("{0}：{1}" -f $step.name, $result.detail)
    }
}

Say INFO ''
if ($failures.Count -gt 0) {
    Say ERROR ("启动未完成（fail-closed）。未就绪：" + ($failures -join '；'))
    Say ERROR ("完整日志：{0}" -f $LogPath)
    Say ERROR ("如需全部停止：powershell -ExecutionPolicy Bypass -File `"{0}`"" -f $StopScript)
    exit 10
}

if ($ConnectTraffic) {
    Say PASS '启动完成：引擎 8094 / proxy 1240 / OneBot 协议端 3001 / AstrBot 6299+6199 / console 1242 / 宿主+dsh-onebot 插件 全部就绪。'
}
else {
    Say PASS '启动完成（仅基础设施）：引擎 8094 / proxy 1240 / console 1242 全部就绪；未接 QQ 流量（需要时加 -ConnectTraffic）。'
}
Say PASS ("ComfyUI(8188)：{0}" -f $comfyStatus.detail)
Say PASS ("完整日志：{0}" -f $LogPath)
exit 0
