# QQ Bot 启动脚本。两种模式（默认只起基础设施，绝不接流量）：
#   基础设施（默认）：看护层/计划任务 -> 引擎恢复守护 -> ninfer 引擎 -> TTS -> persona proxy -> qq-console
#   接流量（-ConnectTraffic）：在上面基础上按顺序补齐 SnowLuma + QQ 客户端 -> bridge -> AstrBot -> DeepSeek Harness
#
# 严格顺序（编号即执行顺序，共 9 步）：
#   [0/9] 看护层/计划任务 -> [1/9] 引擎恢复守护 -> [2/9] ninfer 引擎(8094) -> [3/9] TTS(5000)
#   -> [4/9] persona proxy(1240) -> [5/9] SnowLuma(3001) + QQ 客户端(注入宿主)
#   -> [6/9] bridge -> AstrBot(6299/6199) -> [7/9] qq-console(1242) -> [8/9] DeepSeek Harness
# 每一步都是「未监听才拉起」，随后按端口/健康请求等待就绪，各自有独立超时；
# 超时只记「失败/警告」，不中断整轮，最后统一汇总。
#
# 幂等：已在运行的组件跳过；只有端口没人监听时才拉起新进程。
# 接流量前必须校验 bridge-mode.json：mode=old（不转发）或 one-group 缺 group_id 时直接拒绝启动，
# 因为 bridge 只在进程启动时读该文件，宿主（Harness）起来后再改就得重启宿主才生效。
# QQ 客户端（D:\NewPrograms\QQ NT\QQ.exe）是 SnowLuma 的注入宿主：接流量时若未运行就拉起，
# 已在运行则跳过（绝不重复起）。拉起后等 3000/3001 就绪再继续 bridge/AstrBot/Harness：
# 3001 = OneBot WS，3000 = OneBot HTTP。QQ 起来了但 3000/3001 一直不监听 =
# 白名单账号（SNOWLUMA_HOOK_AUTOLOAD_UINS，默认 10001）还没登录，按警告项处理：
# 写清原因，不改变退出码。
# 所有子进程都通过 WMI Win32_Process.Create 启动 wscript.exe（GUI 子系统，无控制台），
# 再由 run-detached.vbs 以隐藏样式拉起真正的目标进程；既脱离调用方终端作业，
# 也不会留下任何可被用户关掉的可见控制台窗口（关掉它会把 node 一起杀死）。
# ComfyUI(8188) 不在本脚本范围内：不探测、不拉起、不进退出码与摘要，由用户自管。
#
# 用法： powershell -ExecutionPolicy Bypass -File Y:\dsh\start-dsh.ps1
#        ... -ConnectTraffic  接 QQ 流量（SnowLuma + QQ 客户端 + bridge/AstrBot + Harness）；默认不接
#        ... -SkipEngine      只检查引擎，不拉起
#        ... -SkipTTS         不拉起 TTS（5000）
#        ... -SkipProxy       只检查 proxy，不拉起
#        ... -SkipQQ          不尝试启动 SnowLuma / QQ 客户端与 DeepSeek Harness（与 -ConnectTraffic 互斥）
#        ... -SkipConsole     不拉起 qq-console（1242 状态面板）
#        ... -FailFast        核心项未就绪立即中止并 exit 10（启动入口 start-bot.ps1 用这个开关；警告项不中止）
#        ... -DryRun          只读探测：打印模式、每个组件当前状态与将执行的动作，不拉起任何进程
#
# 退出码口径（核心项 / 警告项）：
#   核心项失败才返回非 0。核心项 = 引擎 8094、TTS 5000、proxy 1240、bridge、AstrBot 6199/6299、qq-console 1242。
#   警告项（只写 WARN 日志并列入收尾摘要，不改变退出码）= QQ/SnowLuma（3000/3001）、由此导致的插件 WS 未连、
#   DeepSeek Harness 宿主未出现。
#   桌面快捷方式走隐藏窗口看不到控制台，因此警告/跳过必须落在日志与收尾摘要里。
# 退出码：0 = 核心项全部就绪（允许有警告项/跳过项）/ 1 = 有核心项失败 / 2 = 配置或参数错误 /
#         3 = 引擎（-SkipEngine 但端口没监听）/ 4 = proxy / 5 = QQ 配置 / 6 = Harness 路径或守护脚本缺失 /
#         7 = bridge-mode.json 不合格 / 10 = -FailFast 下核心项失败（警告项不中止）
# 日志：Y:\dsh\2026-11-10\qqbot-ninfer-bridge\work\start-dsh.log
# 桌面快捷方式：Y:\dsh\start-dsh.vbs（失败时弹窗提示日志位置）

param(
    [switch]$ConnectTraffic,
    [switch]$SkipEngine,
    [switch]$SkipTTS,
    [switch]$SkipProxy,
    [switch]$SkipQQ,
    [switch]$SkipConsole,
    [switch]$FailFast,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$Root = 'Y:\dsh'
# 本脚本所在目录：同目录的 run-detached/watchdog/window-check 从这里找。
$Here = $PSScriptRoot
$PersonaRoot = Join-Path $Root 'home\qq-persona'
$WorkDir = Join-Path $Root '2026-11-10\qqbot-ninfer-bridge\work'
$LogPath = Join-Path $WorkDir 'start-dsh.log'
$ConfigPath = if ($env:QQ_LLM_CONFIG) { $env:QQ_LLM_CONFIG } else { Join-Path $PersonaRoot 'llm-backend.json' }
# QQ 客户端 = SnowLuma 注入的宿主；按实际安装路径（注册表 DisplayIcon 同源）拉起。
$QqClientPath = 'D:\NewPrograms\QQ NT\QQ.exe'

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

# 本次启动的计时起点，以及三类结果清单：
# 核心项失败 -> $script:Failures（决定退出码 1）；非核心项未就绪 -> $script:Warnings（只写 WARN，不影响退出码）；
# 显式跳过的组件 -> $script:Skipped（只记录）。某个组件超时只记账，其余组件照常继续，最后统一汇报。
$script:StartTs = Get-Date
$script:Failures = New-Object System.Collections.ArrayList
$script:Warnings = New-Object System.Collections.ArrayList
$script:Skipped = New-Object System.Collections.ArrayList

function Write-Log {
    param(
        [ValidateSet('INFO', 'WARN', 'ERROR')][string]$Level,
        [string]$Message
    )
    $line = '[{0}] [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    # 用 $script: 显式限定：Start-ScriptCommand 也有一个 $LogPath 形参，
    # 不限定的话这里的日志会被写进被调脚本的日志文件里。
    try { Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8 } catch { }
    switch ($Level) {
        'ERROR' { Write-Host $Message -ForegroundColor Red }
        'WARN' { Write-Host $Message -ForegroundColor Yellow }
        default { Write-Host $Message }
    }
}

function Fail {
    param([int]$Code, [string]$Message)
    Write-Log ERROR $Message
    Write-Log ERROR "完整日志：$script:LogPath"
    exit $Code
}

# 接流量前的硬校验：bridge.py 只在启动时读一次 bridge-mode.json，
# mode=old 等于「桥不转发」，one-group 缺 group_id / groups 缺 group_ids 等于「一条也不转发」。
# 这三类都必须在这里拒绝，否则表面上「启动成功」，实际消息全丢。
# 合法值（与 bridge.py 的 current_mode/_group_ids 一致）：private / one-group / groups / all。
function Assert-BridgeModeReady {
    $path = Join-Path $Root 'home\qq-cutover\bridge-mode.json'
    if (-not (Test-Path -LiteralPath $path)) {
        Fail 7 "找不到 $path。接流量前必须先创建并写入 mode（private / one-group / groups / all）。"
    }
    try {
        $bridgeMode = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
    }
    catch {
        Fail 7 "bridge-mode.json 不是合法 JSON：$path（$($_.Exception.Message)）"
    }
    $mode = [string]$bridgeMode.mode
    if (-not $mode -or $mode -eq 'old') {
        Fail 7 "bridge-mode.json 的 mode='$mode'（等于不转发）。接流量前请改为 private / one-group / groups / all：$path"
    }
    if (@('private', 'one-group', 'groups', 'all') -notcontains $mode) {
        Fail 7 "bridge-mode.json 的 mode='$mode' 不是已知值（private / one-group / groups / all）：$path"
    }
    if ($mode -eq 'one-group' -and -not [string]$bridgeMode.group_id) {
        Fail 7 "bridge-mode.json mode=one-group 但 group_id 为空，一条也不会转发：$path"
    }
    if ($mode -eq 'groups' -and @($bridgeMode.group_ids | Where-Object { $_ }).Count -eq 0) {
        Fail 7 "bridge-mode.json mode=groups 但 group_ids 为空，一条也不会转发：$path"
    }
    Write-Log INFO "  bridge-mode.json 校验通过：mode=$mode（$path）"
}

if ($SkipQQ -and $ConnectTraffic) {
    Fail 2 '-SkipQQ 与 -ConnectTraffic 互斥：-SkipQQ 表示不启动 QQ 相关组件，不能同时要求接流量。'
}

function Get-HttpStatus {
    param([string]$Url, [int]$TimeoutSec = 3)
    if (-not $Url) { return 0 }
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec -ErrorAction Stop
        return [int]$response.StatusCode
    }
    catch {
        if ($_.Exception.Response) {
            try { return [int]$_.Exception.Response.StatusCode } catch { return 0 }
        }
        return 0
    }
}

# 在调用方终端作业之外创建进程；这是脚本能在快捷方式/终端退出后继续存活的关键。
function Get-PortStatus {
    param([int]$Port)
    $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($connection) { return [int]$connection.OwningProcess }
    return 0
}

# 就绪判定必须是真实探测：端口在监听 + （可选）一次健康请求返回 200。
# 只看进程存在会把「进程刚起来、还没监听」误判成已就绪。
function Test-ComponentReady {
    param([int]$Port, [string]$HealthUrl)
    if ($Port -gt 0 -and (Get-PortStatus $Port) -eq 0) { return $false }
    if ($HealthUrl) { return ((Get-HttpStatus -Url $HealthUrl -TimeoutSec 2) -eq 200) }
    return $true
}

# 等一个组件就绪；超时只返回 $false，由调用方记入失败/警告桶，不再让整轮 abort。
function Wait-ComponentReady {
    param([string]$Name, [int]$Port, [string]$HealthUrl, [int]$TimeoutMs = 60000)
    $startedAt = Get-Date
    $deadline = $startedAt.AddMilliseconds($TimeoutMs)
    $probe = '端口 ' + $Port + ' 在监听'
    if ($HealthUrl) { $probe += ' + 健康请求 200' }
    while ((Get-Date) -lt $deadline) {
        if (Test-ComponentReady -Port $Port -HealthUrl $HealthUrl) {
            Write-Log INFO ("  {0} 已就绪（{1:N1}s，{2}）" -f $Name, ((Get-Date) - $startedAt).TotalSeconds, $probe)
            return $true
        }
        Start-Sleep -Milliseconds 400
    }
    return $false
}

function Set-NotReady {
    param([string]$Name, [string]$Reason = '', [switch]$Warning)
    $text = if ($Reason) { $Reason } else { '见上方日志' }
    # -Warning：非核心项（QQ/SnowLuma、插件 WS、Harness 宿主）。
    # 只写 WARN 并进警告桶，不影响退出码；桌面快捷方式看不到退出码，口径必须落在日志里。
    if ($Warning) {
        if ($script:Warnings -notcontains $Name) { [void]$script:Warnings.Add($Name) }
        Write-Log WARN ("[WARN] {0} 未就绪（警告项，不影响退出码）：{1}" -f $Name, $text)
        return
    }
    # 核心项失败：进失败桶，最终退出码 1。
    if ($script:Failures -notcontains $Name) { [void]$script:Failures.Add($Name) }
    Write-Log ERROR ("[FAIL] {0} 未就绪（核心项）：{1}" -f $Name, $text)
    # -FailFast（启动入口 start-bot.ps1 使用）：核心项未就绪立即 fail-closed 退出，
    # 避免半栈运行被误当成启动成功；警告项不中止。
    if ($FailFast) {
        Write-Log ERROR ("fail-closed：启动中止，后续组件不再拉起。日志：{0}" -f $script:LogPath)
        exit 10
    }
}

# 显式跳过的组件（-Skip* 开关，或默认模式下不接流量的组件）：只进跳过桶，供收尾摘要分行列出。
function Add-Skipped {
    param([string]$Name, [string]$Reason = '')
    if ($script:Skipped -notcontains $Name) { [void]$script:Skipped.Add($Name) }
    if ($Reason) { Write-Log INFO ("[SKIP] {0}：{1}" -f $Name, $Reason) }
}

# === 白名单 QQ 账号在线判定 ===
# SnowLuma 只给白名单账号注入 hook（Y:\SnowLuma\index.mjs：shouldAutoLoadUin 读
# SNOWLUMA_HOOK_AUTOLOAD_UINS，默认 "10001"；非白名单账号打 auto-load skip 后直接放弃）。
# 这里取同一份 UIN 列表，口径与 SnowLuma 一致，不能只看「有没有 QQ 登录了」。
function Get-WhitelistUins {
    $raw = $env:SNOWLUMA_HOOK_AUTOLOAD_UINS
    if (-not $raw) { $raw = '10001' }
    return @($raw.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\d+$' })
}

function Get-OneBotToken {
    param([string]$Uin)
    $path = Join-Path 'Y:\SnowLuma\config' ("onebot_$Uin.json")
    if (-not (Test-Path -LiteralPath $path)) { return '' }
    try {
        $onebot = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
        $server = @($onebot.networks.httpServers)[0]
        if ($server -and $server.accessToken) { return [string]$server.accessToken }
    }
    catch { }
    return ''
}

# 真实探测：OneBot HTTP /get_login_info 的 user_id 就是 SnowLuma 当前挂上的账号。
# 3000 不监听（SnowLuma 还没注入）或返回值不是白名单账号（登录的是别的号）都算离线。
function Test-WhitelistQqOnline {
    $uins = @(Get-WhitelistUins)
    if ($uins.Count -eq 0) { return $false }
    foreach ($uin in $uins) {
        $token = Get-OneBotToken -Uin $uin
        $headers = @{}
        if ($token) { $headers['Authorization'] = 'Bearer ' + $token }
        try {
            $info = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/get_login_info' -Headers $headers -TimeoutSec 2 -ErrorAction Stop
            $self = [string]$info.data.user_id
            if ($self -and ($uins -contains $self)) {
                Write-Log INFO "  白名单 QQ 已在线（uin=$self，OneBot 3000 应答）"
                return $true
            }
            if ($self) { Write-Log INFO "  QQ 当前登录账号 $self 不在白名单（$($uins -join ',')）" }
        }
        catch { }
    }
    return $false
}

# === QQ 客户端（SnowLuma 注入宿主） ===
# 注入本身由 SnowLuma 完成：node 起来后自行枚举 QQ.exe 并按白名单账号注入，
# 因此脚本只需保证宿主在跑 —— 未运行就按实际安装路径拉起，已在运行则跳过。
function Test-QqClientRunning {
    return (@(Get-Process -Name 'QQ' -ErrorAction SilentlyContinue).Count -gt 0)
}

function Start-QqClientIfNeeded {
    if (Test-QqClientRunning) { return 'running' }
    if (-not (Test-Path -LiteralPath $QqClientPath)) { return 'missing' }
    Write-Log INFO "  启动 QQ 客户端（SnowLuma 注入宿主）：$QqClientPath"
    # -Visible：QQ 是 GUI 程序，style 0 会把主窗口一起隐藏；这里按 GUI 正常显示拉起。
    Start-ScriptCommand -Command $QqClientPath -WorkingDirectory (Split-Path -Parent $QqClientPath) -Visible
    return 'launched'
}

# QQ/SnowLuma 就绪口径：3000（OneBot HTTP）与 3001（OneBot WS）都在监听，
# 且 SnowLuma 自己的 WebUI 5099 应答。只看 3001 会把「端口刚开、OneBot 还没挂上」当就绪；
# 只看端口会把「QQ 没登录」当就绪。
function Wait-QqAndSnowLumaReady {
    param([int]$TimeoutMs = 60000)
    $startedAt = Get-Date
    $deadline = $startedAt.AddMilliseconds($TimeoutMs)
    while ((Get-Date) -lt $deadline) {
        if ((Get-PortStatus 3000) -ne 0 -and (Get-PortStatus 3001) -ne 0 -and
            (Test-ComponentReady -Port 0 -HealthUrl 'http://127.0.0.1:5099/')) {
            Write-Log INFO ("  QQ/SnowLuma 已就绪（{0:N1}s：3000/3001 在监听 + 5099 应答）" -f ((Get-Date) - $startedAt).TotalSeconds)
            return $true
        }
        Start-Sleep -Milliseconds 400
    }
    return $false
}

function Start-Detached {
    param([string]$CommandLine, [string]$WorkingDirectory)
    $arguments = @{ CommandLine = $CommandLine }
    if ($WorkingDirectory) { $arguments.CurrentDirectory = $WorkingDirectory }
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $arguments
    if ($result.ReturnValue -ne 0) {
        throw "Win32_Process.Create 失败（ReturnValue=$($result.ReturnValue)）：$CommandLine"
    }
    Write-Log INFO "  已创建后台进程 pid=$($result.ProcessId)：$CommandLine"
}

function Quote([string]$Value) {
    return '"' + $Value + '"'
}

# 只取日志里「本次启动之后」新增的部分。start.log 是追加写的，
# 不按偏移量截取会把上一轮的失败信息当成这一轮的。
function Get-LogTailFrom {
    param([string]$Path, [long]$Offset)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return '' }
    try {
        $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            if ($stream.Length -le $Offset) { return '' }
            $null = $stream.Seek($Offset, [System.IO.SeekOrigin]::Begin)
            $buffer = New-Object byte[] ($stream.Length - $Offset)
            $read = $stream.Read($buffer, 0, $buffer.Length)
            return [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
        }
        finally { $stream.Dispose() }
    }
    catch { return '' }
}

# 统一经 wscript.exe（GUI 子系统）-> run-detached.vbs 拉起：wscript 自身没有控制台，
# 子进程用 WshShell.Run 的隐藏样式创建，不会出现用户能点掉的 cmd/控制台窗口。
# 注意：Win32_Process.Create 直接创建控制台程序时会给它一个真实控制台窗口，
# 用户关掉该窗口会向整个进程组发 CTRL_CLOSE_EVENT，node 会跟着被杀（1006 断连根因），
# 所以除了 Harness（GUI 程序，-Visible）之外一律不直接创建控制台程序。
function Start-ScriptCommand {
    param(
        [string]$Command,
        [string[]]$Arguments,
        [string]$WorkingDirectory,
        [string]$LogPath,
        [switch]$Visible
    )

    $runner = Join-Path $Here 'run-detached.vbs'
    $style = if ($Visible) { 1 } else { 0 }
    $suffix = [System.IO.Path]::GetExtension($Command).ToLowerInvariant()
    $extra = @()
    if ($Arguments) { $extra = @($Arguments | ForEach-Object { [string]$_ }) }

    # .vbs 本身就是 wscript 脚本，直接交给 wscript，任何情况下都不会有控制台窗口。
    if ($suffix -eq '.vbs') {
        $line = 'wscript.exe //B //Nologo ' + (Quote $Command)
        if ($extra.Count -gt 0) {
            $line += ' ' + (($extra | ForEach-Object { Quote $_ }) -join ' ')
        }
        Start-Detached -CommandLine $line -WorkingDirectory $WorkingDirectory
        return
    }

    $exe = $Command
    $argv = $extra
    $vbsLog = $LogPath

    if ($suffix -eq '.ps1') {
        $exe = 'powershell.exe'
        if ($LogPath) {
            # 输出让 PowerShell 自己 Out-File（utf8）：cmd 的 >> 会用 ANSI 代码页，中文日志会乱码。
            # 这段只含单引号，作为单个参数传给 wscript 不会被再拆分。
            #
            # 关键：参数名不能加引号。'-Model' 在 -Command 里是「字符串值」不是「参数名」，
            # 会按位置参数喂给脚本（$Model 拿到字面量 "-Model"，后面的值整体错位），
            # start-ninfer.ps1 因此以 REFUSE / 参数转换异常退出 —— 这就是冷启动拉不起引擎的根因。
            # 只有「值」才用单引号包裹（保持字面量，不被 $ 展开）。
            $rendered = @($argv | ForEach-Object {
                $item = [string]$_
                if ($item -match '^-{1,2}[A-Za-z]') { $item } else { "'" + ($item -replace "'", "''") + "'" }
            })
            $call = "& '" + $Command + "'"
            if ($rendered.Count -gt 0) { $call += ' ' + ($rendered -join ' ') }
            # 第二个坑：throw 是终止性错误，会直接终结管道，*>&1 也留不住它 ——
            # 被调脚本一旦 throw，日志就是 0 字节，调用方只能干等到超时。
            # 用内层 try/catch 把它转成普通输出，保证失败原因一定落盘。
            # 注意这里只能用单引号：整段要作为「一个双引号参数」传给 wscript，里面不能再有双引号。
            $inner = '& { try { ' + $call + ' } catch { ''[ERROR] '' + ($_ | Out-String) } }' +
                     ' *>&1 | Out-File -FilePath ' + ("'" + $LogPath + "'") + ' -Encoding utf8 -Append'
            $argv = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', $inner)
            $vbsLog = ''
        }
        else {
            $argv = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $Command) + $argv
        }
    }
    elseif ($suffix -eq '.cmd' -or $suffix -eq '.bat') {
        $exe = 'cmd.exe'
        $argv = @('/d', '/s', '/c', $Command) + $argv
    }

    if ($vbsLog) {
        $logDir = Split-Path -Parent $vbsLog
        if ($logDir) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
    }

    $parts = @('wscript.exe', '//B', '//Nologo', (Quote $runner), (Quote $WorkingDirectory), (Quote $vbsLog), [string]$style, (Quote $exe))
    foreach ($item in $argv) { $parts += (Quote $item) }
    Start-Detached -CommandLine ($parts -join ' ') -WorkingDirectory $WorkingDirectory
}

# 拉起与等待分开写：SnowLuma（要等 QQ 注入）和面板（node 冷启动）都慢，
# 由各自阶段内的 Wait-ComponentReady 负责等待，本函数只负责「未监听才发起」。
function Start-SnowLumaIfNeeded {
    if ($SkipQQ) { return 'skipped' }
    if (-not ($config.qq -and $config.qq.startCommand)) { return 'no-config' }
    $port = if ($config.qq.healthPort) { [int]$config.qq.healthPort } else { 3001 }
    if ((Get-PortStatus $port) -ne 0) { return 'running' }
    # 两段式进程树：监督进程不监听端口，只看端口会在「树已起、端口未起」的窗口里重复拉起。
    $trees = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'SnowLuma[\\/]index\.mjs' })
    if ($trees.Count -gt 0) {
        $treePids = ($trees | ForEach-Object { $_.ProcessId }) -join ','
        Write-Log INFO "  SnowLuma 进程树已在运行（pid $treePids），$port 尚未监听；只等待，不重复拉起。"
        return 'running'
    }
    $qqArgs = if ($config.qq.startArguments) { @($config.qq.startArguments) } else { @() }
    $qqLog = if ($config.qq.startLogPath) { [string]$config.qq.startLogPath } else { '' }
    Write-Log INFO "  启动 SnowLuma：$($config.qq.startCommand) $($qqArgs -join ' ')"
    Start-ScriptCommand -Command ([string]$config.qq.startCommand) -Arguments $qqArgs -WorkingDirectory ([string]$config.qq.startWorkingDirectory) -LogPath $qqLog
    return 'launched'
}

function Start-ConsoleIfNeeded {
    if ($SkipConsole) { return 'skipped' }
    if ((Get-PortStatus 1242) -ne 0) { return 'running' }
    $consoleRoot = Join-Path $Root 'home\qq-console'
    $watcher = Join-Path $consoleRoot 'watchdog.ps1'
    if (-not (Test-Path -LiteralPath $watcher)) { throw "找不到 qq-console 守护脚本：$watcher" }
    Write-Log INFO '  启动 qq-console（watchdog.ps1 守护循环）...'
    Start-ScriptCommand -Command $watcher -WorkingDirectory $consoleRoot
    return 'launched'
}

# 按脚本全路径精确匹配守护进程（避免把命令行里恰好提到该名字的其它 shell 当成守护）。
function Get-ScriptProcesses {
    param([string]$ScriptPath)
    $pattern = [regex]::Escape($ScriptPath)
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
            $_.Name -and ($_.Name -match '^(powershell|pwsh|wscript)\.exe$') -and
            $_.CommandLine -and ($_.CommandLine -match $pattern)
        })
}

if (-not (Test-Path -LiteralPath $ConfigPath)) {
    Fail 2 "找不到后端配置：$ConfigPath"
}
try {
    $config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
}
catch {
    Fail 2 "后端配置不是合法 JSON：$ConfigPath（$($_.Exception.Message)）"
}

$BaseUrl = if ($env:QQ_LLM_BASE_URL) { $env:QQ_LLM_BASE_URL } else { $config.baseUrl }
$Model = if ($env:QQ_LLM_MODEL) { $env:QQ_LLM_MODEL } else { $config.model }
$HealthPath = if ($config.healthPath) { $config.healthPath } else { '/v1/models' }
if ($config.engineControl -and $config.engineControl.healthUrl) {
    $HealthUrl = $config.engineControl.healthUrl
} elseif ($HealthPath.StartsWith('/')) {
    $baseUri = [Uri]$BaseUrl
    $HealthUrl = $baseUri.Scheme + '://' + $baseUri.Authority + $HealthPath
} else {
    $HealthUrl = ($BaseUrl.TrimEnd('/')) + '/' + $HealthPath
}
$ProxyPort = if ($config.proxy -and $config.proxy.port) { [int]$config.proxy.port } else { 1240 }
$ProxyHealthUrl = "http://127.0.0.1:$ProxyPort/health"
$ReadyTimeoutMs = if ($config.engineControl -and $config.engineControl.readyTimeoutMs) { [int]$config.engineControl.readyTimeoutMs } else { 600000 }

Write-Log INFO ''
Write-Log INFO '=== start-dsh: 看护层 -> 引擎 -> TTS -> proxy -> SnowLuma/QQ -> bridge/AstrBot -> console -> Harness ==='
Write-Log INFO "  后端：$BaseUrl  模型：$Model"
Write-Log INFO "  配置：$ConfigPath"
$modeText = if ($ConnectTraffic) { '接流量（基础设施 + SnowLuma/QQ 客户端 + bridge/AstrBot + Harness）' } else { '仅基础设施（默认，不接 QQ 流量）' }
Write-Log INFO "  模式：$modeText"

# 只读自检：只探测、只打印计划，不创建任何进程、不注册计划任务、不改任何标记。
if ($DryRun) {
    Write-Log INFO ''
    Write-Log INFO '=== DryRun（只读探测，不拉起任何进程） ==='

    foreach ($taskName in @('xzy-host-watchdog', 'DSH-Start-AtLogon', 'DSH Sticker Maintenance')) {
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Write-Log INFO ("  [0/9] 计划任务 {0}：{1}；{2}" -f $taskName,
            $(if ($task) { "已注册（state=$($task.State)）" } else { '未注册' }),
            $(if ($task) { '不重复注册' } else { '将按归档 XML 注册（真实执行时）' }))
    }
    foreach ($markerName in @('harness.watchdog.pause', 'bot-child.watchdog.pause')) {
        $markerPath = Join-Path $WorkDir $markerName
        Write-Log INFO ("  [0/9] 停机标记 {0}：{1}" -f $markerName,
            $(if (Test-Path -LiteralPath $markerPath) { '存在（接流量时清除）' } else { '不存在' }))
    }

    $restoreWatcher = Join-Path $Here 'engine-restore-watchdog.ps1'
    $restoreProcs = @(Get-ScriptProcesses $restoreWatcher)
    Write-Log INFO ("  [1/9] 引擎恢复守护：{0}；{1}" -f `
        $(if ($restoreProcs.Count -gt 0) { "已在运行（pid $((($restoreProcs | ForEach-Object { $_.ProcessId }) -join ','))）" } else { '未运行' }),
        $(if ($restoreProcs.Count -gt 0) { '跳过' } else { '将拉起（单实例）' }))

    $engineStatus = Get-HttpStatus -Url $HealthUrl -TimeoutSec 3
    $enginePlan = if ($SkipEngine) { '按 -SkipEngine 只检查' }
                  elseif ($engineStatus -eq 200) { '已就绪，跳过' }
                  elseif ($engineStatus -eq 0) { '未监听 -> 将调用 engineControl.startCommand 拉起' }
                  else { "HTTP $engineStatus -> 只等待模型就绪" }
    Write-Log INFO ("  [2/9] ninfer 引擎(8094)：HTTP {0}；{1}" -f $engineStatus, $enginePlan)

    $ttsPid = Get-PortStatus 5000
    Write-Log INFO ("  [3/9] TTS(5000)：pid={0}；{1}" -f $ttsPid,
        $(if ($SkipTTS) { '按 -SkipTTS 跳过' } elseif ($ttsPid -ne 0) { '已监听，跳过' } else { '未监听 -> 将通过 start-tts.vbs 隐藏链拉起' }))

    $proxyPid = Get-PortStatus $ProxyPort
    $proxyStatus = Get-HttpStatus -Url $ProxyHealthUrl -TimeoutSec 2
    $proxyPlan = if ($SkipProxy) { '按 -SkipProxy 只检查' }
                 elseif ($proxyStatus -eq 200) { '已就绪，跳过' }
                 elseif ($proxyPid -ne 0) { "端口在监听(pid=$proxyPid)但 /health 非 200 -> 等待就绪" }
                 else { '未监听 -> 将通过 start-proxy.vbs 隐藏链拉起' }
    Write-Log INFO ("  [4/9] persona proxy({0})：pid={1} HTTP={2}；{3}" -f $ProxyPort, $proxyPid, $proxyStatus, $proxyPlan)

    if (-not $ConnectTraffic) {
        Write-Log INFO '  [5/9] SnowLuma / QQ 客户端：跳过（默认不接流量，需要时加 -ConnectTraffic）。'
    }
    else {
        Assert-BridgeModeReady
        $qqPort = if ($config.qq -and $config.qq.healthPort) { [int]$config.qq.healthPort } else { 3001 }
        $qqPid = Get-PortStatus $qqPort
        $qqPlan = if ($qqPid -ne 0 -and (Get-PortStatus 3000) -ne 0) { '3000/3001 已监听，跳过等待' } else { '未就绪 -> 将通过 SnowLuma 启动链拉起并等待 3000/3001' }
        $qqClientPlan = if (Test-QqClientRunning) { 'QQ 客户端已在运行，跳过拉起' }
                        elseif (Test-Path -LiteralPath $QqClientPath) { "未运行 -> 将拉起 $QqClientPath" }
                        else { "未运行且找不到 $QqClientPath（将记警告）" }
        Write-Log INFO ("  [5/9] SnowLuma({0})：pid={1}；{2}；QQ：{3}" -f $qqPort, $qqPid, $qqPlan, $qqClientPlan)
    }

    if (-not $ConnectTraffic) {
        Write-Log INFO '  [6/9] bridge / AstrBot：跳过（默认不接流量，需要时加 -ConnectTraffic）。'
    }
    else {
        $astrPid = Get-PortStatus 6299
        $bridgeProcs = @(Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine -match 'qq-cutover[\\/]bridge\.py' })
        $botChildWatcher = Join-Path $Here 'bot-child-watchdog.ps1'
        $botChildProcs = @(Get-ScriptProcesses $botChildWatcher)
        Write-Log INFO ("  [6/9] bridge：{0}；AstrBot(6299)：pid={1}；bot-child 守护：{2} -> {3}" -f `
            $(if ($bridgeProcs.Count -gt 0) { "已在运行（pid $((($bridgeProcs | ForEach-Object { $_.ProcessId }) -join ','))）" } else { '未运行' }),
            $astrPid,
            $(if ($botChildProcs.Count -gt 0) { "已在运行（pid $((($botChildProcs | ForEach-Object { $_.ProcessId }) -join ','))）" } else { '未运行' }),
            $(if ($bridgeProcs.Count -gt 0 -and $astrPid -ne 0 -and $botChildProcs.Count -gt 0) { '跳过' } else { '将清 pause 标记并确保守护单实例在跑（顺序：bridge -> AstrBot）' }))
    }

    $consolePid = Get-PortStatus 1242
    Write-Log INFO ("  [7/9] qq-console(1242)：pid={0}；{1}" -f $consolePid,
        $(if ($SkipConsole) { '按 -SkipConsole 跳过' } elseif ($consolePid -ne 0) { '已监听，跳过' } else { '未监听 -> 将通过 console 守护拉起' }))
    Write-Log INFO ("  WebUI 地址：http://127.0.0.1:1242（{0}）" -f $(if ($consolePid -ne 0) { "监听中 pid=$consolePid" } elseif ($SkipConsole) { '本次 -SkipConsole，不会拉起' } else { '真实执行时将拉起' }))

    if (-not $ConnectTraffic) {
        Write-Log INFO '  [8/9] DeepSeek Harness：跳过（默认不接流量，需要时加 -ConnectTraffic）。'
    }
    else {
        $harnessCount = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count
        Write-Log INFO ("  [8/9] DeepSeek Harness：{0}；{1}" -f `
            $(if ($harnessCount -gt 0) { "$harnessCount 个进程在跑" } else { '未运行' }), `
            $(if ($harnessCount -gt 0) { '由 harness-watchdog 接管' } else { '将清 pause 标记并拉起 harness-watchdog' }))
    }

    Write-Log INFO '[DryRun] 未创建任何进程、未注册计划任务、未删除任何标记文件；真实执行会走 hidden-launch/run-detached 隐藏链。'
    exit 0
}

# [0/9] 看护层：计划任务。缺失的按归档 XML 原样恢复（启用/禁用状态随 XML，不新建定义）。
Write-Log INFO ''
Write-Log INFO '[0/9] 看护层 / 计划任务'
$taskArchive = Join-Path $Root '归档\scheduled-tasks-20261116'
$taskArchiveItems = @(
    @{ Name = 'xzy-host-watchdog'; Xml = 'xzy-host-watchdog.xml' },
    @{ Name = 'DSH-Start-AtLogon'; Xml = 'DSH-Start-AtLogon.xml' },
    @{ Name = 'DSH Sticker Maintenance'; Xml = 'DSH_Sticker_Maintenance.xml' }
)
foreach ($item in $taskArchiveItems) {
    $task = Get-ScheduledTask -TaskName $item.Name -ErrorAction SilentlyContinue
    if ($task) {
        Write-Log INFO ("  计划任务 {0}：已注册（state={1}），保持不动。" -f $item.Name, $task.State)
        continue
    }
    $xmlPath = Join-Path $taskArchive $item.Xml
    if (-not (Test-Path -LiteralPath $xmlPath)) {
        Write-Log WARN ("  计划任务 {0}：未注册，且归档 XML 不存在（{1}），跳过。" -f $item.Name, $xmlPath)
        continue
    }
    try {
        $xmlText = Get-Content -Raw -LiteralPath $xmlPath
        Register-ScheduledTask -TaskName $item.Name -Xml $xmlText -Force -ErrorAction Stop | Out-Null
        $restored = Get-ScheduledTask -TaskName $item.Name -ErrorAction SilentlyContinue
        Write-Log INFO ("  计划任务 {0}：已按归档恢复（state={1}）。" -f $item.Name, $(if ($restored) { $restored.State } else { '未知' }))
    }
    catch {
        Write-Log WARN ("  计划任务 {0}：注册失败：{1}" -f $item.Name, $_.Exception.Message)
    }
}

# [1/9] 引擎恢复守护：出图会临时卸载聊天引擎，宿主若在这期间死掉，由它兜底拉回。
#     独立于 Harness，走同一条 wscript //B -> run-detached.vbs 隐藏链路，不弹窗。
Write-Log INFO ''
Write-Log INFO '[1/9] 引擎恢复守护（engine-restore-watchdog.ps1）'
$restoreWatcher = Join-Path $Here 'engine-restore-watchdog.ps1'
if (-not (Test-Path -LiteralPath $restoreWatcher)) {
    Write-Log WARN "  找不到引擎恢复守护脚本：$restoreWatcher（出图期间宿主死掉将无法自愈）"
}
else {
    $restoreProcs = @(Get-ScriptProcesses $restoreWatcher)
    if ($restoreProcs.Count -gt 0) {
        Write-Log INFO ("  已在运行（pid {0}），跳过。" -f (($restoreProcs | ForEach-Object { $_.ProcessId }) -join ','))
    }
    else {
        try {
            Start-ScriptCommand -Command $restoreWatcher -WorkingDirectory $Root `
                -LogPath 'Y:\dsh\2026-11-10\infer-deploy\work\logs\engine-restore-watchdog.out.log'
            Write-Log INFO '  已拉起引擎恢复守护（单实例，重复启动会自行退出）。'
        }
        catch {
            Write-Log WARN "  拉起引擎恢复守护失败：$($_.Exception.Message)"
        }
    }
}

# 2. ninfer 引擎
Write-Log INFO ''
Write-Log INFO '[2/9] ninfer 引擎'
$engineStatus = Get-HttpStatus -Url $HealthUrl -TimeoutSec 3
$engineGaveUp = $false
if ($engineStatus -eq 200) {
    Write-Log INFO '  已就绪，跳过启动。'
} else {
    # HTTP 0 = 端口没人监听；503 = 进程在、模型还在加载；其他 = 端点异常。
    # 只有 0 才拉起，否则会撞端口起第二个实例。
    $needsStart = ($engineStatus -eq 0)
    if ($SkipEngine) {
        if ($needsStart) { Fail 3 "-SkipEngine 已指定，但引擎端口没有监听：$HealthUrl" }
        Write-Log INFO "  引擎已监听（HTTP $engineStatus），等待模型就绪..."
    }
    elseif ($needsStart) {
        $control = $config.engineControl
        if (-not $control -or -not $control.startCommand) {
            Fail 3 "ninfer 没有运行，且 llm-backend.json 未配置 engineControl.startCommand。请填写官方启动脚本路径。"
        }
        # 引擎参数与 start-ninfer.ps1 的默认值保持单一口径：这里只做显式确认，
        # 不再重复传 start-ninfer.ps1 已经默认追加的开关（vision overlay / recency-eviction /
        # auto-prefix-grid / kv-lease-growth / max-shared-prefixes），也不覆盖它的并发默认值。
        # 两处若出现同一个参数的不同值，冷启动就会静默盖掉对方的默认，这是之前的坑。
        # 2026-11-13 夜间记录：该缺陷（shared candidates 超界 500 / 9.6k 时 0xC0000005）与
        # max-shared-prefixes 取值强相关；置 0 会让 analysis+reply 两条腿的请求也 500。
        # 目前沿用 start-ninfer.ps1 默认 3，出现密集 500 时优先重启引擎（见 nightly-log）。
        $engineArgDefaults = @(
            '-Model', 'E:\Bonsai\Ternary-Bonsai-2-27B-ninfer-v3.ninfer',
            '-Port', '8094',
            '-ModelId', 'bonsai-2-27b',
            '-MaxContext', '32768',
            '-KvCapacity', '57344',
            '-KvDtype', 'int8',
            '-HostKvMib', '16384',
            '-PrefillChunk', '1024',
            '-Spec', 'dflash2',
            '-DraftTokens', '4',
            '-MaxConcurrency', '3'
        )
        $startArgs = if ($control.startArguments) { @($control.startArguments) } else { $engineArgDefaults }
        # 引擎启停已收敛到 engine-control.ps1：start-ninfer.ps1 / stop-ninfer.ps1 带单出口守卫，
        # 没有 NINFER_VIA_CONTROL=1 且不带 -AllowDirect 会直接 exit 3。冷启动是本脚本的合法例外。
        if (([string]$control.startCommand) -match 'start-ninfer\.ps1$' -and $startArgs -notcontains '-AllowDirect') {
            $startArgs = @('-AllowDirect') + $startArgs
        }
        $startLog = if ($control.startLogPath) { [string]$control.startLogPath } else { '' }
        # 记录启动前的日志长度：之后只看这之后新增的内容，避免把上一轮的报错当成本轮的。
        $logOffset = if ($startLog -and (Test-Path -LiteralPath $startLog)) { (Get-Item -LiteralPath $startLog).Length } else { 0 }
        try {
            Start-ScriptCommand -Command ([string]$control.startCommand) -Arguments $startArgs -WorkingDirectory ([string]$control.startWorkingDirectory) -LogPath $startLog
        }
        catch {
            Write-Log WARN "  拉起 ninfer 失败：$($_.Exception.Message)"
            Set-NotReady 'ninfer 引擎' -Reason ("拉起失败：" + $_.Exception.Message)
            $engineGaveUp = $true
        }
    }
    else {
        Write-Log INFO "  引擎已监听（HTTP $engineStatus），等待模型就绪..."
    }

    $deadline = (Get-Date).AddMilliseconds($ReadyTimeoutMs)
    $noOutputDeadline = (Get-Date).AddSeconds(120)
    $nextNotice = Get-Date
    $sawLaunchOutput = $false
    $ready = $false
    while ((Get-Date) -lt $deadline -and -not $engineGaveUp) {
        $status = Get-HttpStatus -Url $HealthUrl -TimeoutSec 2
        if ($status -eq 200) { $ready = $true; break }

        # 自检①：拉起脚本一旦报错（REFUSE / 参数绑定失败 / 抛异常），立刻带出原因，不静默等满 600 秒。
        if ($startLog) {
            $delta = Get-LogTailFrom -Path $startLog -Offset $logOffset
            if ($delta) {
                $sawLaunchOutput = $true
                # 只在行首匹配：命令行回显里也带着 '[ERROR] ' 这串字面量，不能当失败信号。
                $hits = @($delta -split "`r?`n" | Where-Object { $_ -match '^\s*(\[ERROR\]|\[FAIL\]|REFUSE:)' })
                if ($hits.Count -gt 0) {
                    Write-Log WARN ("  引擎拉起失败（$startLog）：" + (($hits | Select-Object -First 4) -join ' | '))
                    Set-NotReady 'ninfer 引擎' -Reason ("启动脚本报错（" + $startLog + "）：" + (($hits | Select-Object -First 2) -join ' | '))
                    $engineGaveUp = $true
                    break
                }
            }
        }
        # 自检②：两分钟里既没监听、启动脚本又一行都没输出 —— 说明它根本没跑起来。
        if ($status -eq 0 -and -not $sawLaunchOutput -and (Get-Date) -gt $noOutputDeadline) {
            Write-Log WARN "  引擎启动脚本在 120 秒内没有任何输出，端口也没有监听。请检查 $startLog 与 start-ninfer.ps1。"
            Set-NotReady 'ninfer 引擎' -Reason ("启动脚本 120 秒无输出且端口未监听（" + $startLog + "）")
            $engineGaveUp = $true
            break
        }

        if (((Get-Date) - $nextNotice).TotalSeconds -ge 15) {
            if ($status -eq 503) { Write-Log INFO "  引擎已监听，模型仍在加载（HTTP 503）：$HealthUrl" }
            elseif ($status -eq 0) { Write-Log INFO "  等待引擎监听：$HealthUrl" }
            else { Write-Log INFO "  等待引擎就绪：$HealthUrl 返回 HTTP $status" }
            $nextNotice = Get-Date
        }
        Start-Sleep -Seconds 2
    }
    if (-not $ready) {
        if (-not $engineGaveUp) {
            Write-Log WARN "  等待引擎就绪超时（$([int]($ReadyTimeoutMs / 1000)) 秒）：$HealthUrl。超时只影响引擎，其余组件继续启动。"
        }
        Set-NotReady 'ninfer 引擎' -Reason ("$([int]($ReadyTimeoutMs / 1000)) 秒内未返回 200：$HealthUrl")
    }
    else {
        Write-Log INFO '  引擎已就绪。'
    }
}

try {
    $models = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 5
    $ids = @()
    if ($models.data) { $ids = @($models.data | ForEach-Object { $_.id }) }
    if ($ids.Count -gt 0 -and ($ids -notcontains $Model)) {
        Write-Log WARN "  引擎暴露的模型名与配置不一致：配置 '$Model'，实际 '$($ids -join ', ')'"
    }
}
catch {
    Write-Log WARN "  无法读取模型列表：$($_.Exception.Message)"
}

# [3/9] TTS（Style-Bert-VITS2，5000）：独立于聊天链路，起不来只影响语音。
Write-Log INFO ''
Write-Log INFO '[3/9] TTS（Style-Bert-VITS2 5000）'
if ($SkipTTS) {
    Write-Log INFO '  -SkipTTS 已指定，跳过。'
    Add-Skipped 'TTS' '-SkipTTS 已指定'
}
elseif ((Get-PortStatus 5000) -ne 0) {
    Write-Log INFO '  5000 已在监听，跳过启动。'
}
else {
    $ttsLauncher = 'Y:\Style-Bert-VITS2-CUDA\start-tts.vbs'
    if (-not (Test-Path -LiteralPath $ttsLauncher)) {
        Write-Log WARN "  找不到 TTS 启动脚本：$ttsLauncher"
        Set-NotReady 'TTS' -Reason "缺少 $ttsLauncher"
    }
    else {
        Write-Log INFO '  启动 TTS（start-tts.vbs：cmd 重启循环，进程死掉会自动重起）...'
        try {
            Start-ScriptCommand -Command $ttsLauncher -WorkingDirectory 'Y:\Style-Bert-VITS2-CUDA'
        }
        catch {
            Write-Log WARN "  拉起 TTS 失败：$($_.Exception.Message)"
            Set-NotReady 'TTS' -Reason ("拉起失败：" + $_.Exception.Message)
        }
        # 就绪 = 5000 在监听。模型是懒加载（首个 /voice 才真正载入），这里不等推理。
        if (-not (Wait-ComponentReady -Name 'TTS(5000)' -Port 5000 -TimeoutMs 180000)) {
            Write-Log WARN '  TTS 在 180 秒内没有监听 5000。超时只影响语音，其余组件继续。'
            Set-NotReady 'TTS' -Reason '180 秒内 5000 未监听'
        }
    }
}

# 4. persona proxy
Write-Log INFO ''
Write-Log INFO '[4/9] qq-persona proxy'
if ($SkipProxy) {
    Write-Log INFO '  -SkipProxy 已指定，跳过。'
    Add-Skipped 'persona proxy' '-SkipProxy 已指定'
}
elseif ((Get-HttpStatus -Url $ProxyHealthUrl -TimeoutSec 2) -eq 200) {
    Write-Log INFO "  已就绪（127.0.0.1:$ProxyPort），跳过启动。"
}
else {
    $proxyStarter = Join-Path $PersonaRoot 'start-proxy.vbs'
    if (-not (Test-Path -LiteralPath $proxyStarter)) {
        Fail 4 "找不到 proxy 启动脚本：$proxyStarter"
    }
    Write-Log INFO '  启动 proxy（start-proxy.vbs 守护循环）...'
    try {
        Start-ScriptCommand -Command $proxyStarter -Arguments @() -WorkingDirectory $PersonaRoot
    }
    catch {
        Write-Log WARN "  拉起 proxy 失败：$($_.Exception.Message)"
        Set-NotReady 'persona proxy' -Reason ("拉起失败：" + $_.Exception.Message)
    }
    # 就绪 = 1240 在监听 + /health 返回 200。
    if (-not (Wait-ComponentReady -Name 'proxy(1240)' -Port $ProxyPort -HealthUrl $ProxyHealthUrl -TimeoutMs 60000)) {
        Write-Log WARN "  proxy 在 60 秒内没有就绪：$ProxyHealthUrl。超时只影响 proxy，其余组件继续。日志：$PersonaRoot\proxy.stdout.log / proxy.stderr.log"
        Set-NotReady 'persona proxy' -Reason ("60 秒内 $ProxyPort 未监听或 /health 未返回 200")
    }
}

# 5. SnowLuma（QQ 客户端内注入 + OneBot WS 3001）
Write-Log INFO ''
Write-Log INFO '[5/9] SnowLuma（OneBot WS 3001）+ QQ 客户端（注入宿主）'
if (-not $ConnectTraffic) {
    Write-Log INFO '  未指定 -ConnectTraffic：跳过（默认只起基础设施，不接 QQ 流量）。'
    Add-Skipped 'QQ/SnowLuma' '未指定 -ConnectTraffic'
}
elseif (-not ($config.qq -and $config.qq.startCommand)) {
    Fail 5 '【缺少配置】qq.startCommand 为空，无法启动 SnowLuma（3001）。'
}
else {
    $qqPort = if ($config.qq.healthPort) { [int]$config.qq.healthPort } else { 3001 }
    $qqTimeout = if ($config.qq.readyTimeoutMs) { [int]$config.qq.readyTimeoutMs } else { 60000 }
    $qqClientState = if (Test-QqClientRunning) { 'running' } else { 'not-running' }
    if ((Get-PortStatus $qqPort) -ne 0 -and (Get-PortStatus 3000) -ne 0 -and $qqClientState -eq 'running') {
        Write-Log INFO "  SnowLuma 已就绪（3000/3001 已监听），QQ 客户端已在运行，跳过拉起与等待。"
    }
    else {
        # 先起 SnowLuma（注入方），再确保 QQ 宿主在跑；SnowLuma 会自行发现 QQ.exe 并注入白名单账号。
        if ((Get-PortStatus $qqPort) -eq 0) {
            try { [void](Start-SnowLumaIfNeeded) }
            catch { Write-Log WARN "  拉起 SnowLuma 失败：$($_.Exception.Message)"; Set-NotReady 'QQ/SnowLuma' -Warning -Reason ("拉起失败：" + $_.Exception.Message) }
        }
        if ($qqClientState -ne 'running') {
            try {
                $qqClientState = Start-QqClientIfNeeded
                if ($qqClientState -eq 'running') {
                    Write-Log INFO '  QQ 客户端已在运行，跳过拉起。'
                }
                elseif ($qqClientState -eq 'missing') {
                    Write-Log WARN "  找不到 QQ 客户端：$QqClientPath（没有注入宿主，3000/3001 不会监听）"
                    Set-NotReady 'QQ 客户端' -Warning -Reason "未安装或路径不存在：$QqClientPath"
                }
                else {
                    Write-Log INFO '  QQ 客户端已拉起（SnowLuma 会自动发现并注入白名单账号）。'
                }
            }
            catch {
                $qqClientState = 'launch-failed'
                Write-Log WARN "  拉起 QQ 客户端失败：$($_.Exception.Message)"
                Set-NotReady 'QQ 客户端' -Warning -Reason ("拉起失败：" + $_.Exception.Message)
            }
        }
        if ($qqClientState -in @('running', 'launched')) {
            # 就绪 = 3000 + 3001 都在监听 + SnowLuma WebUI 5099 应答。
            # 等不到 = QQ 起来了但白名单账号没登录（用户侧状态），记为警告项：写清原因，不影响退出码。
            if (-not (Wait-QqAndSnowLumaReady -TimeoutMs $qqTimeout)) {
                $reason = "$([int]($qqTimeout / 1000)) 秒内 3000/3001 未就绪：QQ 客户端已在运行，但白名单账号（$((Get-WhitelistUins) -join ',')）可能未登录，SnowLuma 未完成注入"
                Write-Log WARN "  $reason。超时只影响 QQ/SnowLuma，其余组件继续。SnowLuma 日志：$($config.qq.startLogPath)"
                Set-NotReady 'QQ/SnowLuma' -Warning -Reason $reason
            }
        }
        else {
            Write-Log WARN '  QQ 客户端不可用（缺失或拉起失败），跳过 3000/3001 等待；其余组件继续。'
        }
    }
}

# 6. bridge -> AstrBot：两者都走 hidden-launch 独立隐藏链，进程消失按退避拉起。
#     这是「接流量」动作：bridge 把消息转发给宿主，AstrBot 连 3001，默认绝不执行。
#     拉起顺序由 bot-child-watchdog.ps1 的 $Components 决定（bridge 在前、AstrBot 在后）。
Write-Log INFO ''
Write-Log INFO '[6/9] bridge -> AstrBot（bot-child-watchdog.ps1）'
$botChildWatcher = Join-Path $Here 'bot-child-watchdog.ps1'
$botChildWorkDir = Join-Path $Root '2026-11-10\qqbot-ninfer-bridge\work'
$botChildPauseMarker = Join-Path $botChildWorkDir 'bot-child.watchdog.pause'
if (-not $ConnectTraffic) {
    Write-Log INFO '  未指定 -ConnectTraffic：跳过（不会拉起 bridge/AstrBot，也不会清 pause 标记）。'
    Add-Skipped 'bridge/AstrBot' '未指定 -ConnectTraffic'
}
elseif (-not (Test-Path -LiteralPath $botChildWatcher)) {
    Write-Log WARN "  找不到 bridge/AstrBot 守护脚本：$botChildWatcher（两者将没有自愈）"
    Set-NotReady 'bridge/AstrBot' -Reason "找不到守护脚本 $botChildWatcher"
}
else {
    New-Item -ItemType Directory -Force -Path $botChildWorkDir | Out-Null
    # 上次停机留下的标记会让守护一启动就退出，先清掉（仅在明确接流量时）。
    Remove-Item -LiteralPath $botChildPauseMarker -Force -ErrorAction SilentlyContinue
    $botChildProcs = @(Get-ScriptProcesses $botChildWatcher)
    if ($botChildProcs.Count -gt 0) {
        Write-Log INFO ("  守护已在运行（pid {0}），不重复拉起。" -f (($botChildProcs | ForEach-Object { $_.ProcessId }) -join ','))
    }
    else {
        try {
            Start-ScriptCommand -Command $botChildWatcher -WorkingDirectory $Root `
                -LogPath (Join-Path $botChildWorkDir 'bot-child.watchdog.out.log')
            Write-Log INFO '  已拉起 bridge + AstrBot 守护（单实例，重复启动会自行退出）。'
        }
        catch {
            Write-Log WARN "  拉起 bridge + AstrBot 守护失败：$($_.Exception.Message)"
        }
    }

    # 6.1 等 bridge 进程出现：pythonw 无监听端口，只能按命令行识别。
    $bridgeDeadline = (Get-Date).AddSeconds(30)
    $bridgeFound = $false
    while ((Get-Date) -lt $bridgeDeadline) {
        $bridgeProcs = @(Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine -match 'qq-cutover[\\/]bridge\.py' })
        if ($bridgeProcs.Count -gt 0) { $bridgeFound = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if ($bridgeFound) {
        Write-Log INFO '  bridge 已启动（pythonw 在跑）。'
    }
    else {
        Write-Log WARN '  bridge 在 30 秒内没有出现。日志：Y:\dsh\home\qq-cutover\bridge.watchdog.err.log'
        Set-NotReady 'bridge' -Reason '30 秒内未出现 bridge.py 进程'
    }

    # 6.2 再等 AstrBot 监听 6299（消息转发必须真正监听，不是进程在就算）。
    if (-not (Wait-ComponentReady -Name 'AstrBot(6299)' -Port 6299 -TimeoutMs 180000)) {
        Write-Log WARN '  AstrBot 在 180 秒内没有监听 6299。日志：E:\Bonsai\astrbot-eval\logs\run-hidden.err.log'
        Set-NotReady 'AstrBot' -Reason '180 秒内 6299 未监听'
    }
}

# 7. qq-console（1242 状态面板）：由 watchdog.ps1 守护，node 退出后自动重启。
Write-Log INFO ''
Write-Log INFO '[7/9] qq-console（状态面板 1242）'
if ($SkipConsole) {
    Write-Log INFO '  -SkipConsole 已指定，跳过。'
    Add-Skipped 'qq-console' '-SkipConsole 已指定'
}
else {
    $consoleRoot = Join-Path $Root 'home\qq-console'
    $consolePort = 1242
    $consoleHealth = 'http://127.0.0.1:1242/api/health'
    if ((Get-PortStatus $consolePort) -ne 0) {
        # 端口开着也要过一遍健康请求：「端口在、API 假死」不能算就绪。
        if (Test-ComponentReady -Port 0 -HealthUrl $consoleHealth) {
            Write-Log INFO "  已就绪（127.0.0.1:$consolePort 在监听 + /api/health 200），跳过启动。"
        }
        else {
            Write-Log WARN "  $consolePort 在监听但 /api/health 不通，按未就绪处理（守护会自动重启 node）。"
            Set-NotReady 'qq-console' -Reason "1242 在监听但 /api/health 未返回 200"
        }
    }
    else {
        try { [void](Start-ConsoleIfNeeded) }
        catch { Write-Log WARN "  拉起 qq-console 失败：$($_.Exception.Message)"; Set-NotReady 'qq-console' -Reason ("拉起失败：" + $_.Exception.Message) }
        if (-not (Wait-ComponentReady -Name 'qq-console(1242)' -Port $consolePort -HealthUrl $consoleHealth -TimeoutMs 30000)) {
            Write-Log WARN "  qq-console 30 秒内未就绪。超时只影响面板，其余组件继续。日志：$consoleRoot\console.watchdog.log"
            Set-NotReady 'qq-console' -Reason "30 秒内 1242 未监听或 /api/health 未返回 200"
        }
    }
}

# 8. DeepSeek Harness（dsh-onebot 宿主）：依赖 3001 与 1240 都已就绪，排在基础设施之后。
Write-Log INFO ''
Write-Log INFO '[8/9] DeepSeek Harness（dsh-onebot 宿主）'
if (-not $ConnectTraffic) {
    Write-Log INFO '  未指定 -ConnectTraffic：跳过（默认只起基础设施，不接 QQ 流量）。'
    Add-Skipped 'DeepSeek Harness' '未指定 -ConnectTraffic'
}
else {
    $harness = if ($config.qq -and $config.qq.harnessCommand) { [string]$config.qq.harnessCommand } else { '' }
    $harnessRunning = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count -gt 0
    # 插件日志的当前长度：后面只看这之后新增的内容，避免把上一轮的「WS 已连接」当成这一轮的。
    $pluginLog = Join-Path $Root 'home\qq-onebot-plugin\logs\s0.log'
    $pluginOffset = 0
    if (Test-Path -LiteralPath $pluginLog) { $pluginOffset = (Get-Item -LiteralPath $pluginLog).Length }
    # 宿主统一由 harness-watchdog.ps1 拉起并看守：崩溃后按退避自动重启，崩溃循环会停下来报错。
    # 这里不再直接 Start-Detached 宿主，否则守护看到宿主消失会立刻再拉一个，形成两套拉起逻辑。
    $harnessWatchdog = Join-Path $Here 'harness-watchdog.ps1'
    $harnessWorkDir = Join-Path $Root '2026-11-10\qqbot-ninfer-bridge\work'
    $harnessPauseMarker = Join-Path $harnessWorkDir 'harness.watchdog.pause'
    $harnessPidFile = Join-Path $harnessWorkDir 'harness.watchdog.pid'
    if (-not $harness) {
        Write-Log WARN '  qq.harnessCommand 未配置：dsh-onebot 宿主（DeepSeek Harness）需要你自己打开，否则机器人收到消息也不会回。'
        Set-NotReady 'DeepSeek Harness' -Warning -Reason 'qq.harnessCommand 未配置'
    }
    elseif (-not (Test-Path -LiteralPath $harness)) {
        Fail 6 "找不到 DeepSeek Harness：$harness"
    }
    elseif (-not (Test-Path -LiteralPath $harnessWatchdog)) {
        Fail 6 "找不到宿主守护脚本：$harnessWatchdog"
    }
    else {
        # 上次 stop-dsh 留下的停机标记会让守护一启动就退出，先清掉。
        Remove-Item -LiteralPath $harnessPauseMarker -Force -ErrorAction SilentlyContinue
        $watchdogAlive = $false
        if (Test-Path -LiteralPath $harnessPidFile) {
            $oldPid = Get-Content -LiteralPath $harnessPidFile -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($oldPid -and (Get-Process -Id ([int]$oldPid) -ErrorAction SilentlyContinue)) { $watchdogAlive = $true }
        }
        if ($watchdogAlive) {
            Write-Log INFO "  宿主守护已在运行（pid $oldPid），不重复拉起。"
        }
        else {
            try {
                Start-ScriptCommand -Command $harnessWatchdog -WorkingDirectory $Root `
                    -LogPath (Join-Path $harnessWorkDir 'harness.watchdog.out.log')
                Write-Log INFO '  已拉起宿主守护（harness-watchdog.ps1，单实例）。'
            }
            catch {
                Fail 6 "拉起宿主守护失败：$($_.Exception.Message)"
            }
        }
        if ($harnessRunning) {
            Write-Log INFO '  DeepSeek Harness 已在运行，由守护接管监控。'
        }
        else {
            # 守护每 5 秒检查一次，正常几秒内就能看到进程；首次启动较慢，给 30 秒。
            $harnessDeadline = (Get-Date).AddSeconds(30)
            while ((Get-Date) -lt $harnessDeadline -and
                @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count -eq 0) {
                Start-Sleep -Milliseconds 500
            }
            $harnessNow = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
            if ($harnessNow.Count -eq 0) {
                Write-Log WARN "  30 秒内没看到宿主进程；守护会继续按退避拉起，详见 $harnessWorkDir\harness.watchdog.log"
                Set-NotReady 'DeepSeek Harness' -Warning -Reason "30 秒内未出现宿主进程（守护继续按退避拉起）"
            }
            else {
                Write-Log INFO "  DeepSeek Harness 已由守护拉起（pid $(($harnessNow | ForEach-Object { $_.Id }) -join ',')）。"
                # 进程存在只算「起来了」；插件真正连上 3001 才算「能用」。只看本轮新增的日志，避免命中旧行。
                $wsOk = $false
                $wsDeadline = (Get-Date).AddSeconds(25)
                while ((Get-Date) -lt $wsDeadline) {
                    if (Test-Path -LiteralPath $pluginLog) {
                        $stream = [System.IO.File]::Open($pluginLog, 'Open', 'Read', 'ReadWrite')
                        try {
                            if ($stream.Length -gt $pluginOffset) {
                                [void]$stream.Seek($pluginOffset, 'Begin')
                                $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
                                $delta = $reader.ReadToEnd()
                                if ($delta -match 'WS 已连接') { $wsOk = $true }
                            }
                        }
                        finally { $stream.Dispose() }
                    }
                    if ($wsOk) { break }
                    Start-Sleep -Milliseconds 500
                }
                if ($wsOk) {
                    Write-Log INFO '  插件已连上 3001（WS 已连接）。'
                }
                else {
                    Write-Log WARN "  25 秒内没在插件日志里看到「WS 已连接」：宿主起来了但没连上 3001，机器人不会回复。日志：$pluginLog"
                    Set-NotReady '插件 WS' -Warning -Reason "宿主已起，但 25 秒内插件日志无「WS 已连接」"
                }
            }
        }
    }
}

Write-Log INFO ''
$elapsed = [int]((Get-Date) - $script:StartTs).TotalSeconds
$modeText = if ($ConnectTraffic) { '接流量模式' } else { '基础设施模式，未接 QQ 流量' }
Write-Log INFO ("start-dsh: 完成，耗时 {0} 秒（{1}）。" -f $elapsed, $modeText)

# 收尾摘要固定三行：失败项决定退出码；警告项与跳过项只记录，不影响退出码。
if ($script:Failures.Count -gt 0) {
    Write-Log ERROR ("失败项：{0}（核心项失败，退出码 1）" -f ($script:Failures -join '、'))
}
else {
    Write-Log INFO '失败项：无（核心项全部就绪）'
}
if ($script:Warnings.Count -gt 0) {
    Write-Log WARN ("警告项：{0}（不影响退出码，详见上方各组件行与日志）" -f ($script:Warnings -join '、'))
}
else {
    Write-Log INFO '警告项：无'
}
if ($script:Skipped.Count -gt 0) {
    Write-Log INFO ("跳过项：{0}" -f ($script:Skipped -join '、'))
}
else {
    Write-Log INFO '跳过项：无'
}

# WebUI（qq-console 1242）必须出现在收尾摘要里：桌面快捷方式看不到控制台，地址只能靠日志/摘要。
$consolePid = Get-PortStatus 1242
$webUiState = if ($consolePid -ne 0) { "监听中 pid=$consolePid" }
              elseif ($SkipConsole) { '本次 -SkipConsole，未拉起' }
              else { '未就绪（见上方 qq-console 行）' }
Write-Log INFO ("WebUI 地址：http://127.0.0.1:1242（{0}）" -f $webUiState)

# 收尾自检：真实枚举顶层窗口，统计本脚本拉起的进程里还有几个可见控制台窗口。
# 判定依据是 EnumWindows/IsWindowVisible，不是看代码推断。
$checker = Join-Path $Here 'window-check.ps1'
if (Test-Path -LiteralPath $checker) {
    try {
        $raw = (& $checker | Out-String)
        $report = $raw | ConvertFrom-Json
        if ([int]$report.visibleConsoleCount -gt 0) {
            Write-Log WARN "窗口自检：$($report.visibleConsoleCount) 个目标进程仍有可见控制台窗口（用户可关掉它们）"
            foreach ($item in @($report.violations)) {
                Write-Log WARN "  - $($item.name) pid=$($item.pid) 窗口=$($item.windowClass) 标题='$($item.title)' 命令行=$($item.commandLine)"
            }
        }
        else {
            Write-Log INFO '窗口自检：本脚本拉起的进程均无可见控制台窗口。'
        }
    }
    catch {
        Write-Log WARN "窗口自检执行失败：$($_.Exception.Message)"
    }
}

Write-Log INFO ''
# 只有核心项失败才返回 1；警告项（QQ/SnowLuma、插件 WS、Harness 宿主）与跳过项不污染退出码。
if ($script:Failures.Count -gt 0) { exit 1 }
