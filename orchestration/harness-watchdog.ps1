# harness-watchdog.ps1 -- DeepSeek Harness（dsh-onebot 宿主）崩溃自愈 + 崩溃留证。
#
# 背景：宿主进程会无声消失（2026-11-12 15:00:35 那次），当时没有退出码、没有崩溃报告，
# 只能靠人发现面板 state=down。本脚本不做别的，只负责这一件事：
#   1. 宿主不在就拉起；每次重启前按 30/60/120/300 秒退避，正常跑满 10 分钟才清零退避；
#   2. 10 分钟内异常退出 ≥ MaxRestart 次判定为崩溃循环，停止重启并报出来（弹窗 + 状态文件），
#      之后如果宿主被人工拉起，自动解除限制继续守护；
#   3. 每次启动都把 stdout/stderr 落盘（上一轮转存为 *.prev.log），退出时记录退出码、
#      十六进制码、存活时长和退出原因分类，直接区分「正常退出 / 被结束 / 崩溃」；
#   4. 状态写入 harness.watchdog.state.json，供 qq-console 状态页读取；
#   5. 停机时 stop-dsh 只需放置 harness.watchdog.pause 标记（或直接结束本守护），
#      守护看到标记就退出，不会把正在关闭的宿主又拉起来。
#
# 启动方式（start-dsh.ps1）：wscript //B run-detached.vbs -> 本脚本，全程无窗口。
# 手动：powershell -ExecutionPolicy Bypass -File Y:\dsh\harness-watchdog.ps1
#       ... -Once        只检查一次并打印状态（不拉起、不常驻），用于排查
param(
    [string]$Harness = 'D:\dsh\DeepSeek Harness.exe',
    [string]$LogDir = 'Y:\dsh\2026-11-10\qqbot-ninfer-bridge\work',
    [int]$IntervalSec = 5,
    [int]$MaxRestart = 3,
    [int]$CrashWindowMin = 10,
    [int]$BaseBackoffSec = 30,
    [int]$MaxBackoffSec = 300,
    [int]$BootGraceSec = 120,
    [int]$CooldownMin = 2,
    [string]$Python = 'K:\python\311\python.exe',
    [string[]]$HarnessArguments = @(),
    # ComfyUI 相关参数保留只为兼容既有调用；8188 由用户自管，本守护不拉起、不重启、不结束。
    [string]$ComfyPython = 'K:\python\311\python.exe',
    [string]$ComfyCwd = 'E:\ComfyUI',
    # 用数组而不是一整串：Start-Process 的 -ArgumentList 按元素传参，避免参数被再次拆分。
    [string[]]$ComfyArguments = @('-u', 'main.py', '--port', '8188', '--listen', '127.0.0.1', '--disable-auto-launch'),
    [int]$ComfyPort = 8188,
    [string]$ComfyLogDir = 'Y:\dsh\home\qq-persona',
    [int]$ComfyBootGraceSec = 180,
    [switch]$NoComfy,
    [switch]$NoNotify,
    [switch]$Once
)

$ErrorActionPreference = 'Continue'

$processName = [System.IO.Path]::GetFileNameWithoutExtension($Harness)
$outLog = Join-Path $LogDir 'harness.out.log'
$errLog = Join-Path $LogDir 'harness.err.log'
$watchLog = Join-Path $LogDir 'harness.watchdog.log'
$statePath = Join-Path $LogDir 'harness.watchdog.state.json'
$pidFile = Join-Path $LogDir 'harness.watchdog.pid'
$pauseMarker = Join-Path $LogDir 'harness.watchdog.pause'
# 崩溃标记：宿主每次退出写一份（时间戳 + 摘要 + 退出码 + 日志尾部），供巡检直接读。
$crashMarkerPath = Join-Path $LogDir 'harness.crash.marker.json'

# 宿主自己的现场目录：崩溃报告、cookie 库、自动更新缓存。
$userData = Join-Path $env:APPDATA '@deepseek-ai\dsh-desktop'
$crashLogDir = Join-Path $userData 'logs'
$cookieDb = Join-Path $userData 'Network\Cookies'
$updaterRoot = Join-Path $env:LOCALAPPDATA '@deepseek-aidsh-desktop-updater'

if (-not (Test-Path -LiteralPath $LogDir)) {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
}

function Write-WatchLog([string]$Level, [string]$Message) {
    $line = '[{0}] [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    try { Add-Content -LiteralPath $watchLog -Value $line -Encoding UTF8 } catch { }
}

function Write-State {
    param([hashtable]$Extra)
    $state = [ordered]@{
        updatedAt = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
        mode = 'unknown'
        pid = 0
        since = $null
        restarts = 0
        crashesInWindow = 0
        maxRestart = $MaxRestart
        crashWindowMin = $CrashWindowMin
        backoffUntil = $null
        cooldownUntil = $null
        cooldownRounds = 0
        lastExit = $null
        note = ''
    }
    if (Test-Path -LiteralPath $statePath) {
        try {
            $old = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
            foreach ($key in @($state.Keys)) {
                if ($old.PSObject.Properties.Name -contains $key) { $state[$key] = $old.$key }
            }
        }
        catch { }
    }
    foreach ($key in $Extra.Keys) { $state[$key] = $Extra[$key] }
    $state.updatedAt = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    try {
        # 必须不带 BOM：qq-console 用 JSON.parse 读，PS 5.1 的 Out-File utf8 会写 BOM 导致解析失败。
        $json = $state | ConvertTo-Json -Depth 5
        [System.IO.File]::WriteAllText($statePath, $json, (New-Object System.Text.UTF8Encoding($false)))
    }
    catch { }
    return $state
}

# 退出码 → 人话。.NET 给的是 int32，0xC0000005 之类会呈现成负数。
function Describe-Exit([int]$Code) {
    $hex = '0x{0:X8}' -f [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$Code), 0)
    switch ($Code) {
        0 { return @{ kind = 'normal'; text = '正常退出（退出码 0）' } }
        -1 { return @{ kind = 'killed'; text = "被强制结束（$hex）" } }
        -1073741510 { return @{ kind = 'killed'; text = "被关闭窗口 / CTRL_CLOSE 终止（$hex）" } }
        -1073741515 { return @{ kind = 'crash'; text = "DLL 缺失、进程无法启动（$hex）" } }
        -1073741819 { return @{ kind = 'crash'; text = "访问冲突，进程崩溃（$hex）" } }
        -1073741571 { return @{ kind = 'crash'; text = "栈溢出，进程崩溃（$hex）" } }
        -1073740791 { return @{ kind = 'crash'; text = "异常终止（$hex，常见于显存/内存不足）" } }
        -1073741822 { return @{ kind = 'crash'; text = "运行时致命错误（$hex）" } }
        default { return @{ kind = 'crash'; text = "异常退出（$hex）" } }
    }
}

# 无窗口启动 + 文件句柄继承（不能退回匿名管道：管道读端随守护消失会让宿主 EPIPE）。
if (-not ('HarnessNativeChild' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class HarnessNativeChild
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit,
        uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    IntPtr hProcess;
    public int Pid;
    public bool HasExited { get { return WaitForSingleObject(hProcess, 0) == 0; } }
    public int ExitCode { get { uint c; GetExitCodeProcess(hProcess, out c); return unchecked((int)c); } }
    public void Close() { if (hProcess != IntPtr.Zero) { CloseHandle(hProcess); hProcess = IntPtr.Zero; } }

    // CREATE_NO_WINDOW：进程完全没有控制台窗口。
    // STARTF_USESTDHANDLES + 可继承文件句柄：宿主自己持有句柄，守护退出不会造成 EPIPE。
    public static HarnessNativeChild Start(string exe, string args, string outPath, string errPath, string cwd)
    {
        SECURITY_ATTRIBUTES sec = new SECURITY_ATTRIBUTES();
        sec.nLength = Marshal.SizeOf(sec);
        sec.bInheritHandle = 1;
        IntPtr psec = Marshal.AllocHGlobal(sec.nLength);
        Marshal.StructureToPtr(sec, psec, false);
        IntPtr hOut = IntPtr.Zero, hErr = IntPtr.Zero, hIn = IntPtr.Zero;
        try
        {
            hOut = CreateFile(outPath, 0x40000000u, 7u, psec, 4u, 0x80u, IntPtr.Zero);
            hErr = CreateFile(errPath, 0x40000000u, 7u, psec, 4u, 0x80u, IntPtr.Zero);
            hIn = CreateFile("NUL", 0xC0000000u, 7u, psec, 3u, 0x80u, IntPtr.Zero);
            if (hOut == new IntPtr(-1) || hErr == new IntPtr(-1) || hIn == new IntPtr(-1))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "打开日志句柄失败");

            STARTUPINFO si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(si);
            si.dwFlags = 0x100;
            si.hStdInput = hIn;
            si.hStdOutput = hOut;
            si.hStdError = hErr;

            StringBuilder cmd = new StringBuilder("\"" + exe + "\"" + (String.IsNullOrEmpty(args) ? "" : " " + args));
            PROCESS_INFORMATION pi;
            bool ok = CreateProcess(exe, cmd, IntPtr.Zero, IntPtr.Zero, true, 0x08000000u, IntPtr.Zero, cwd, ref si, out pi);
            int err = Marshal.GetLastWin32Error();
            if (!ok) throw new System.ComponentModel.Win32Exception(err, "CreateProcess 失败");
            CloseHandle(pi.hThread);
            HarnessNativeChild child = new HarnessNativeChild();
            child.hProcess = pi.hProcess;
            child.Pid = pi.dwProcessId;
            return child;
        }
        finally
        {
            if (hOut != IntPtr.Zero && hOut != new IntPtr(-1)) CloseHandle(hOut);
            if (hErr != IntPtr.Zero && hErr != new IntPtr(-1)) CloseHandle(hErr);
            if (hIn != IntPtr.Zero && hIn != new IntPtr(-1)) CloseHandle(hIn);
            Marshal.FreeHGlobal(psec);
        }
    }
}
'@ -Language CSharp
}

function Get-HarnessProcesses {
    return @(Get-Process -Name $processName -ErrorAction SilentlyContinue)
}

function Show-Alert([string]$Title, [string]$Text) {
    if ($NoNotify) { return }
    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $icon = New-Object System.Windows.Forms.NotifyIcon
        $icon.Icon = [System.Drawing.SystemIcons]::Warning
        $icon.Visible = $true
        $icon.ShowBalloonTip(10000, $Title, $Text, [System.Windows.Forms.ToolTipIcon]::Warning)
        Start-Sleep -Seconds 3
        $icon.Visible = $false
        $icon.Dispose()
    }
    catch {
        # 无桌面会话时弹不出来，日志里已经有记录
    }
}

function Get-ErrTail([int]$Lines = 6) {
    try {
        if (-not (Test-Path -LiteralPath $errLog)) { return '' }
        $tail = @(Get-Content -LiteralPath $errLog -Tail $Lines -ErrorAction SilentlyContinue)
        return ($tail -join ' | ')
    }
    catch { return '' }
}

function Get-LogTailText([string]$Path, [int]$Lines = 20) {
    try {
        if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return '' }
        return (@(Get-Content -LiteralPath $Path -Tail $Lines -ErrorAction SilentlyContinue) -join ' | ')
    }
    catch { return '' }
}

# === 崩溃标记 ===
# 33328 那次「无声消失」定不了案，唯一原因就是没有句柄、也没有留下任何独立现场：
# 进程没了、退出码没有、日志被下一次启动覆盖。这里把每次退出的硬证据写成一份标记文件，
# 巡检只要读 harness.crash.marker.json 就知道「几点、哪个 pid、退出码多少、活了多久、最后打了什么」。
function Write-CrashMarker {
    param(
        # 不能叫 $Pid：$PID 是 PowerShell 只读自动变量，参数绑定会直接抛 VariableNotWritable。
        [int]$ProcessId,
        $Code,
        [string]$Kind,
        [string]$Text,
        [int]$LivedSec,
        $StartedAt,
        [string]$Note = ''
    )
    $at = Get-Date
    $stamp = $at.ToString('yyyyMMdd-HHmmss')
    # 退出现场原样留一份：下一次 Start-Process 重定向会把 harness.out.log / harness.err.log 清空。
    $outCopy = ''
    $errCopy = ''
    try {
        if (Test-Path -LiteralPath $outLog) {
            $outCopy = Join-Path $LogDir ('harness.out.exit-{0}.log' -f $stamp)
            Copy-Item -LiteralPath $outLog -Destination $outCopy -Force
        }
        if (Test-Path -LiteralPath $errLog) {
            $errCopy = Join-Path $LogDir ('harness.err.exit-{0}.log' -f $stamp)
            Copy-Item -LiteralPath $errLog -Destination $errCopy -Force
        }
    }
    catch { }
    $hex = if ($null -eq $Code) { '—' } else { '0x{0:X8}' -f [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$Code), 0) }
    $codeText = if ($null -eq $Code) { 'null' } else { ('{0}({1})' -f $Code, $hex) }
    $summary = '{0} pid={1} code={2} kind={3} lived={4}s' -f $at.ToString('yyyy-MM-dd HH:mm:ss'), $ProcessId, $codeText, $Kind, $LivedSec
    $marker = [ordered]@{
        at = $at.ToString('yyyy-MM-dd HH:mm:ss')
        summary = $summary
        pid = $ProcessId
        code = $Code
        hex = $hex
        kind = $Kind
        text = $Text
        livedSec = $LivedSec
        startedAt = $(if ($StartedAt) { ([datetime]$StartedAt).ToString('yyyy-MM-dd HH:mm:ss') } else { $null })
        outTail = (Get-LogTailText $outLog 20)
        errTail = (Get-LogTailText $errLog 20)
        prevOutTail = (Get-LogTailText ($outLog -replace '\.log$', '.prev.log') 20)
        prevErrTail = (Get-LogTailText ($errLog -replace '\.log$', '.prev.log') 20)
        outCopy = $outCopy
        errCopy = $errCopy
        watchdogPid = $PID
        note = $Note
    }
    try {
        [System.IO.File]::WriteAllText($crashMarkerPath, ($marker | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
    }
    catch { }
    try {
        Add-Content -LiteralPath (Join-Path $LogDir 'harness.crash.log') -Value ('[{0}] {1}' -f $at.ToString('yyyy-MM-dd HH:mm:ss'), $summary) -Encoding UTF8
    }
    catch { }
    Write-WatchLog 'WARN' ('崩溃标记已写入：{0}' -f $summary)
    return $marker
}

# 拉起成功后把「谁把它拉回来的」补进同一份标记，巡检能看出「退出 → 多久后恢复」。
function Add-CrashRelaunch([int]$ProcessId) {
    try {
        if (-not (Test-Path -LiteralPath $crashMarkerPath)) { return }
        $marker = Get-Content -LiteralPath $crashMarkerPath -Raw | ConvertFrom-Json
        $exitAt = $null
        try { $exitAt = [datetime]::ParseExact([string]$marker.at, 'yyyy-MM-dd HH:mm:ss', $null) } catch { }
        if ($exitAt -and ((Get-Date) - $exitAt).TotalMinutes -gt 30) { return }   # 旧标记不再追写
        $relaunch = [ordered]@{
            at = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
            pid = $ProcessId
            sinceExitSec = $(if ($exitAt) { [int]((Get-Date) - $exitAt).TotalSeconds } else { $null })
        }
        $marker | Add-Member -Force -NotePropertyName relaunch -NotePropertyValue $relaunch
        [System.IO.File]::WriteAllText($crashMarkerPath, ($marker | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
    }
    catch { }
}

# 外部启动的宿主没有进程句柄，.NET 的 Process.ExitCode 读不到（实测返回空）。
# 用 OpenProcess(SYNCHRONIZE | QUERY_LIMITED_INFORMATION) 自己拿句柄，退出后就能读退出码——
# 这是上次「接管外部宿主」分支只能记 unknown 的直接原因。
if (-not ('HarnessAdoptedHandle' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class HarnessAdoptedHandle
{
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    IntPtr h;
    public int Pid;
    public bool Ok { get { return h != IntPtr.Zero; } }
    public bool HasExited { get { return Ok && WaitForSingleObject(h, 0) == 0; } }
    public int ExitCode { get { uint c; GetExitCodeProcess(h, out c); return unchecked((int)c); } }
    public void Close() { if (h != IntPtr.Zero) { CloseHandle(h); h = IntPtr.Zero; } }

    // 只要等退出 + 读退出码所需的最小权限，不要 PROCESS_ALL_ACCESS。
    public static HarnessAdoptedHandle Open(int pid)
    {
        HarnessAdoptedHandle result = new HarnessAdoptedHandle();
        result.Pid = pid;
        result.h = OpenProcess(0x00100000u | 0x1000u, false, pid);
        return result;
    }
}
'@ -Language CSharp
}

# === 宿主进程识别 ===
# 宿主不是一个进程：主进程 + --type= 的 Chromium 子进程 + --expose-internals 的 desktop host 子进程，
# 进程名都叫 DeepSeek Harness.exe。只看进程名会把子进程当成宿主本体，主进程被强杀后
# 残余子进程还会让新实例抢不到 userData。
function Get-HarnessCimAll {
    try { return @(Get-CimInstance Win32_Process -Filter ("Name='{0}.exe'" -f $processName) -ErrorAction SilentlyContinue) }
    catch { return @() }
}

function Get-HarnessMainCim {
    return @(Get-HarnessCimAll | Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch '--expose-internals' })
}

function Get-HarnessRootPid {
    $mains = @(Get-HarnessMainCim)
    if ($mains.Count -eq 0) { return 0 }
    $ids = @($mains | ForEach-Object { [int]$_.ProcessId })
    foreach ($item in $mains) {
        if ($ids -notcontains [int]$item.ParentProcessId) { return [int]$item.ProcessId }
    }
    return [int]$mains[0].ProcessId
}

function Stop-HarnessLeftovers {
    foreach ($item in @(Get-HarnessCimAll)) {
        try { Stop-Process -Id ([int]$item.ProcessId) -Force -ErrorAction SilentlyContinue } catch { }
    }
}

# === 根因修复：认证 cookie 累积 ===
# 壳每次启动都会往 127.0.0.1 写一个 dsh-auth-<token> 的持久 cookie。启动次数多了就累积一大堆
# （2026-11-12 现场实测 71 个）。壳启动时用 credentials:'include' 把整组 cookie 发过去，
# 宿主只认自己那一个，取到历史 cookie 就回非 2xx，于是 connectDesktopWelcome 抛
# "desktop welcome: Web authentication failed"，窗口永远打不开、进程 2 分钟后退出。
# 实测：把 Network\Cookies 重置（备份为 Cookies.bak-*）后下一次启动立即成功。
# 这里只在宿主未运行时删 dsh-auth-* 这一族，不碰 deepseek.com 的登录 cookie。
function Repair-HarnessCookieJar {
    if (@(Get-HarnessCimAll).Count -gt 0) { return }      # 宿主在跑，cookie 库被占用，跳过
    if (-not (Test-Path -LiteralPath $cookieDb)) { return }
    if (-not (Test-Path -LiteralPath $Python)) {
        Write-WatchLog 'WARN' "找不到 python（$Python），跳过历史认证 cookie 清理"
        return
    }
    $pruneScript = Join-Path $env:TEMP 'dsh-prune-auth-cookies.py'
    try {
        if (-not (Test-Path -LiteralPath $pruneScript)) {
            $lines = @(
                'import sqlite3, sys',
                'con = sqlite3.connect(sys.argv[1])',
                'cur = con.cursor()',
                'where = "host_key=? and name like ?"',
                'args = ("127.0.0.1", "dsh-auth-%")',
                'n = cur.execute("select count(*) from cookies where " + where, args).fetchone()[0]',
                'cur.execute("delete from cookies where " + where, args)',
                'con.commit()',
                'con.close()',
                'print(n)'
            )
            [System.IO.File]::WriteAllText($pruneScript, ($lines -join "`n"), (New-Object System.Text.UTF8Encoding($false)))
        }
        $raw = & $Python $pruneScript $cookieDb 2>&1 | Select-Object -Last 1
        if ("$raw" -match '^\d+$' -and [int]$raw -gt 0) {
            Write-WatchLog 'INFO' "清理历史认证 cookie：dsh-auth-* x$raw（累积后宿主会拒绝，壳启动即失败）"
        }
    }
    catch {
        Write-WatchLog 'WARN' ("清理历史认证 cookie 失败：" + $_.Exception.Message)
    }
}

# 壳启动失败会在 userData\logs 落一份 crash-*-host.log，第一行 Error: 就是签名。
function Get-NewCrashReport([datetime]$Since) {
    try {
        if (-not (Test-Path -LiteralPath $crashLogDir)) { return $null }
        $hit = Get-ChildItem -LiteralPath $crashLogDir -Filter 'crash-*-host.log' -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -gt $Since } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $hit) { return $null }
        $text = Get-Content -LiteralPath $hit.FullName -Raw -ErrorAction SilentlyContinue
        $signature = ''
        if ($text -match '(?m)^Error: ([^\r\n]+)') { $signature = $Matches[1] }
        return [pscustomobject]@{ Path = $hit.FullName; Signature = $signature }
    }
    catch { return $null }
}

# 更新缓存的写入证据：只读目录，不扫进程，供「宿主还在跑」的轮询复用。
# 返回带包名和时间的一句话，写进日志/状态后能一眼看出这次是哪个版本、什么时候下的。
function Get-UpdatePackage([datetime]$Since) {
    try {
        if (-not (Test-Path -LiteralPath $updaterRoot)) { return '' }
        $recent = Get-ChildItem -LiteralPath $updaterRoot -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -gt $Since } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $recent) { return '' }
        $name = $recent.Name
        $infoPath = Join-Path $updaterRoot 'pending\update-info.json'
        if (Test-Path -LiteralPath $infoPath) {
            try {
                $pkg = [string](Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json).fileName
                if ($pkg) { $name = $pkg }
            }
            catch { }
        }
        return ("更新包 {0}（{1} 写入）" -f $name, $recent.LastWriteTime.ToString('HH:mm:ss'))
    }
    catch { return '' }
}

# 自动更新：安装器进程在跑，或更新缓存自 $Since 起有新写入，都说明正在装新版本。
# 这时拉起宿主等于拉起一个半新半旧的实例（22:26~22:48 那批崩溃期间就在反复装）。
function Get-UpdateActivity([datetime]$Since) {
    try {
        $installing = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^(installer|Un_A[^\\]*|[^\\]*-win-x64)\.exe$' })
        if ($installing.Count -gt 0) {
            return ("安装器进程 pid=" + (($installing | ForEach-Object { $_.ProcessId }) -join ','))
        }
        $pkg = Get-UpdatePackage $Since
        if ($pkg) { return $pkg }
    }
    catch { }
    return ''
}


if ($Once) {
    $procs = Get-HarnessProcesses
    $rootPid = Get-HarnessRootPid
    $state = Write-State @{ mode = $(if ($procs.Count -gt 0) { 'running' } else { 'down' }); pid = $rootPid; note = 'once-check' }
    $procs | ForEach-Object {
        Write-Output ("harness process pid={0} start={1}" -f $_.Id, $_.StartTime)
    }
    if ($procs.Count -eq 0) { Write-Output 'harness not running' }
    Write-Output ("root pid: " + $rootPid)
    Write-Output ("state: " + (Join-Path $LogDir 'harness.watchdog.state.json'))
    exit 0
}

# 单实例：上一个守护还活着就不再起第二个。
if (Test-Path -LiteralPath $pidFile) {
    $oldPid = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($oldPid -and (Get-Process -Id ([int]$oldPid) -ErrorAction SilentlyContinue)) {
        Write-WatchLog 'INFO' "another watchdog is alive (pid $oldPid), exit"
        exit 0
    }
}
Set-Content -LiteralPath $pidFile -Value $PID -Encoding ascii

if (-not (Test-Path -LiteralPath $Harness)) {
    Write-WatchLog 'ERROR' "找不到宿主程序：$Harness"
    Write-State @{ mode = 'misconfigured'; note = "missing exe: $Harness" } | Out-Null
    exit 2
}

Write-WatchLog 'INFO' "watchdog started pid=$PID exe=$Harness interval=${IntervalSec}s maxRestart=$MaxRestart window=${CrashWindowMin}min"

# === ComfyUI(8188) 状态记录 ===
# [约束 2026-11-14] 8188 由用户自行启动与维护：本守护只记一次状态（在跑/没在跑），
# 不拉起、不重启、不结束、不代理 /free，也不写 comfy.watchdog.state.json。
# 历史上这里曾有一套自动拉起 + 判卡死结束的逻辑，已整体删除，不要再加回来。
$comfyStatePath = Join-Path $LogDir 'comfy.watchdog.state.json'
$comfyLog = Join-Path $LogDir 'comfy.watchdog.log'
$comfyOutLog = Join-Path $ComfyLogDir 'comfyui.out.log'
$comfyErrLog = Join-Path $ComfyLogDir 'comfyui.err.log'
$comfyPythonName = [System.IO.Path]::GetFileName($ComfyPython)

function Write-ComfyLog([string]$Level, [string]$Message) {
    $line = '[{0}] [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    try { Add-Content -LiteralPath $comfyLog -Value $line -Encoding UTF8 } catch { }
}

function Write-ComfyState {
    param([hashtable]$Extra)
    $state = [ordered]@{
        updatedAt = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
        mode = 'unknown'
        pid = 0
        port = $ComfyPort
        since = $null
        restarts = 0
        crashesInWindow = 0
        maxRestart = $MaxRestart
        crashWindowMin = $CrashWindowMin
        backoffUntil = $null
        cooldownUntil = $null
        lastExit = $null
        note = ''
    }
    if (Test-Path -LiteralPath $comfyStatePath) {
        try {
            $old = Get-Content -LiteralPath $comfyStatePath -Raw | ConvertFrom-Json
            foreach ($key in @($state.Keys)) {
                if ($old.PSObject.Properties.Name -contains $key) { $state[$key] = $old.$key }
            }
        }
        catch { }
    }
    foreach ($key in $Extra.Keys) { $state[$key] = $Extra[$key] }
    $state.updatedAt = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    try {
        [System.IO.File]::WriteAllText($comfyStatePath, ($state | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
    }
    catch { }
}

# 只认「python + main.py + --port 8188」这条命令行：进程名相同不代表是同一个服务。
function Get-ComfyProcesses {
    return @(Get-CimInstance Win32_Process -Filter ("Name='{0}'" -f $comfyPythonName) -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'main\.py' -and $_.CommandLine -match ('--port\s+' + $ComfyPort) })
}

function Get-ComfyPortOwner {
    $connection = Get-NetTCPConnection -LocalPort $ComfyPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($connection) { return [int]$connection.OwningProcess }
    return 0
}

function Get-ComfyErrTail([int]$Lines = 6) {
    try {
        if (-not (Test-Path -LiteralPath $comfyErrLog)) { return '' }
        return (@(Get-Content -LiteralPath $comfyErrLog -Tail $Lines -ErrorAction SilentlyContinue) -join ' | ')
    }
    catch { return '' }
}

$comfyProc = $null                 # 本守护拉起、可拿到退出码的进程
$comfyPid = 0
$comfySince = $null
$comfyRestarts = 0
$comfyExitTimes = New-Object System.Collections.ArrayList
$comfyRapidFails = 0
$comfyBackoffUntil = [datetime]::MinValue
$comfyTripped = $false
$comfyCooldownUntil = [datetime]::MinValue
$comfyCooldownRounds = 0
$comfyMaxCooldownRounds = 30
$comfyAdoptedPid = 0
$comfyAdoptedStart = $null
$comfyNextProbe = [datetime]::MinValue
$comfyHungNoted = $false

function Invoke-ComfyGuard {
    # [约束 2026-11-14] ComfyUI(8188) 由用户自行占用：本守护只做一次性状态记录，
    # 不拉起、不重启、不结束、不代理 /free，也不写入 comfy.watchdog.state.json。
    if (-not $script:comfyUserOwnedNoted) {
        $script:comfyUserOwnedNoted = $true
        $owner = Get-ComfyPortOwner
        if ($owner -ne 0) {
            Write-ComfyLog INFO "ComfyUI(8188) 由用户占用（pid=$owner），跳过，不由本守护管理。"
        }
        else {
            Write-ComfyLog INFO 'ComfyUI(8188) 未运行：由用户自管，本守护不拉起、不重启、不结束。'
        }
    }
    return
}

$exitTimes = New-Object System.Collections.ArrayList
$rapidFails = 0
$backoffUntil = [datetime]::MinValue
$tripped = $false
# 崩溃循环不再永久停：进入冷却，每隔 $CooldownMin 分钟探测拉起一次；
# 冷却轮次用尽也不停，转为 5 分钟一次的慢速重试（仍然全自动，不需要人点）。
# 理由：10 分钟窗内 3 次崩通常是"改完代码连着重启"或短时依赖抖动，
# 长时间空窗等于「崩了没人管」，与自愈目标相反。
$MaxCooldownRounds = 30
$cooldownUntil = [datetime]::MinValue
$cooldownRounds = 0
$lastTripNotice = [datetime]::MinValue
$lastUpdNotice = [datetime]::MinValue
$updNote = ''
$orphanSince = $null
$restartCount = 0
$proc = $null                 # 本守护拉起、正在等待退出的进程
$adoptedPid = 0               # 外部启动、只能监视存活的宿主
$adoptedStart = $null
$adoptedHandle = $null        # 外部宿主的进程句柄：退出后靠它读退出码

while ($true) {
    # 停机标记：stop-dsh 正在收尾，守护必须让路，不能把宿主又拉起来。
    if (Test-Path -LiteralPath $pauseMarker) {
        Write-WatchLog 'INFO' 'pause marker found, watchdog exit'
        Write-State @{ mode = 'paused'; note = 'stop requested' } | Out-Null
        break
    }

    # ComfyUI 与宿主各管各的：先看一眼它，再走宿主状态机（内部有 10 秒节流，不会每次空转）。
    if (-not $NoComfy) { Invoke-ComfyGuard }

    $procs = Get-HarnessProcesses
    $rootPid = Get-HarnessRootPid

    # 只剩 Chromium/desktop host 子进程、主进程已经没了：这是被强杀后的残留。
    # 它们占着 userData，新实例起来会抢不到锁（cookie 库/缓存拒绝访问）→ 启动即认证失败。
    if ($procs.Count -gt 0 -and $rootPid -eq 0) {
        if ($null -eq $orphanSince) {
            $orphanSince = Get-Date
            Write-WatchLog 'WARN' ("发现无主的宿主子进程 {0} 个，观察 20 秒后清理" -f $procs.Count)
        }
        elseif (((Get-Date) - $orphanSince).TotalSeconds -ge 20) {
            Write-WatchLog 'WARN' '清理无主宿主子进程（避免与新实例抢 userData）'
            Stop-HarnessLeftovers
            $orphanSince = $null
            Start-Sleep -Seconds 3
        }
        Write-State @{ mode = 'orphan'; pid = 0; note = '宿主主进程已退出，残留子进程待清理' } | Out-Null
        Start-Sleep -Seconds $IntervalSec
        continue
    }
    $orphanSince = $null

    if ($procs.Count -gt 0) {
        if ($tripped) {
            $tripped = $false
            $rapidFails = 0
            $exitTimes.Clear()
            Write-WatchLog 'INFO' "harness is back (pid $rootPid); crash-loop guard cleared"
            Show-Alert 'DeepSeek Harness 已恢复' '宿主进程重新出现，自愈守护继续正常工作。'
        }
        # 不是本守护拉起的进程（启动脚本/人工打开）：接管并自己开一个句柄，
        # 这样它退出时仍然能读到退出码（没有句柄就只能记 unknown，33328 那次就是这么失明的）。
        if ($null -eq $proc -and $adoptedPid -ne $rootPid) {
            if ($adoptedHandle) { try { $adoptedHandle.Close() } catch { } }
            $adoptedPid = $rootPid
            try { $adoptedStart = (Get-Process -Id $rootPid -ErrorAction Stop).StartTime } catch { $adoptedStart = $null }
            $adoptedHandle = [HarnessAdoptedHandle]::Open($rootPid)
            # 记版本：自动更新后安装器拉起的是新版本，这里能看到版本号前后的变化。
            $hostVer = ''
            try { $hostVer = (Get-Item -LiteralPath $Harness).VersionInfo.FileVersion } catch { }
            Write-WatchLog 'INFO' ("接管外部启动的宿主 pid={0} 版本={1} 句柄={2}（退出时按句柄读退出码）" -f $adoptedPid, $hostVer, $(if ($adoptedHandle.Ok) { 'ok' } else { '打开失败，退出时无退出码' }))
        }
        # 稳定运行超过 5 分钟视为自愈成功，冷却重启计数清零。
        try {
            if ($cooldownRounds -gt 0 -and ((Get-Date) - $procs[0].StartTime).TotalMinutes -ge 5) {
                Write-WatchLog 'INFO' 'harness 稳定运行 5 分钟，冷却重启计数清零'
                $cooldownRounds = 0
            }
        }
        catch { }
        # 后台更新下载：更新缓存有新写入时先在状态里记一条，这样「壳过一会儿会以 0 退出再重启」
        # 在日志/面板里就有前因（22:55 那次更新就是这样：00 秒下载、36 秒退出，看起来像崩了）。
        $updPkg = Get-UpdatePackage (Get-Date).AddSeconds(-120)
        if ($updPkg) {
            $updNote = "自动更新下载中：$updPkg"
            if (((Get-Date) - $lastUpdNotice).TotalSeconds -ge 30) {
                Write-WatchLog 'INFO' ("检测到自动更新下载（{0}）；安装时壳会以退出码 0 退出并自动重启，属正常升级，不是崩溃" -f $updPkg)
                $lastUpdNotice = Get-Date
            }
        }
        else { $updNote = '' }
        Write-State @{ mode = 'running'; pid = $rootPid; note = $updNote } | Out-Null
        Start-Sleep -Seconds $IntervalSec
        continue
    }

    # 进程不在：先处理「外部启动的宿主消失」——这种进程不是本守护创建的，
    # 但接管时已经自己开了句柄，所以退出码照样能读到；读不到时如实记 null，不再一律 unknown。
    if ($adoptedPid -ne 0) {
        $livedSec = -1
        if ($adoptedStart) { try { $livedSec = [int]((Get-Date) - $adoptedStart).TotalSeconds } catch { } }
        $exitAt = Get-Date
        $exitCode = $null
        $handleNote = '句柄不可用'
        if ($adoptedHandle -and $adoptedHandle.Ok) {
            try {
                if ($adoptedHandle.HasExited) { $exitCode = [int]$adoptedHandle.ExitCode; $handleNote = '句柄读取' }
                else { $handleNote = '句柄未报告退出' }
            }
            catch { $handleNote = '句柄读退出码失败' }
            try { $adoptedHandle.Close() } catch { }
        }
        $info = if ($null -ne $exitCode) { Describe-Exit $exitCode }
                else { @{ kind = 'unknown'; text = "外部启动的宿主消失，未能取得退出码（$handleNote）" } }
        $exitTimes.Add($exitAt) | Out-Null
        $rapidFails++
        $wait = [Math]::Min($MaxBackoffSec, $BaseBackoffSec * [Math]::Pow(2, [Math]::Max(0, $rapidFails - 1)))
        $backoffUntil = $exitAt.AddSeconds($wait)
        $exitRecord = [ordered]@{
            at = $exitAt.ToString('yyyy-MM-dd HH:mm:ss')
            pid = $adoptedPid
            code = $exitCode
            hex = $(if ($null -eq $exitCode) { '—' } else { '0x{0:X8}' -f [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$exitCode), 0) })
            kind = $info.kind
            text = $info.text
            livedSec = $livedSec
            stderrTail = (Get-ErrTail)
        }
        Write-WatchLog 'WARN' ("接管中的宿主消失 pid={0} {1} lived={2}s（{3}）；退避 {4}s 后重启" -f $adoptedPid, $info.text, $livedSec, $handleNote, $wait)
        Write-State @{ mode = 'down'; pid = 0; crashesInWindow = $exitTimes.Count; lastExit = $exitRecord; note = $info.text } | Out-Null
        # 证据采集绝不能反过来把守护带走：任何异常都只记日志。
        try { Write-CrashMarker -ProcessId $adoptedPid -Code $exitCode -Kind $info.kind -Text $info.text -LivedSec $livedSec -StartedAt $adoptedStart -Note $handleNote | Out-Null }
        catch { Write-WatchLog 'ERROR' ('崩溃标记写入失败：' + $_.Exception.Message) }
        Show-Alert 'DeepSeek Harness 已退出' ("宿主进程消失（{0}），存活 {1} 秒，{2} 秒后自动拉起。" -f $info.text, $livedSec, $wait)
        if ($exitTimes.Count -ge $MaxRestart) {
            $tripped = $true
            $cooldownUntil = (Get-Date).AddMinutes($CooldownMin)
            $lastTripNotice = Get-Date
            Write-WatchLog 'ERROR' "崩溃循环：$CrashWindowMin 分钟内异常退出 $($exitTimes.Count) 次（上限 $MaxRestart），进入 $CooldownMin 分钟冷却，之后探测拉起。"
            Show-Alert 'DeepSeek Harness 崩溃循环' "改为冷却自愈：$CooldownMin 分钟后自动探测拉起一次（已尝试 $cooldownRounds/$MaxCooldownRounds）。"
            Write-State @{ mode = 'cooldown'; pid = 0; cooldownUntil = $cooldownUntil.ToString('yyyy-MM-dd HH:mm:ss'); cooldownRounds = $cooldownRounds; note = "崩溃循环，冷却 $CooldownMin 分钟" } | Out-Null
        }
        $adoptedPid = 0
        $adoptedStart = $null
        $adoptedHandle = $null
        continue
    }

    # 进程不在
    if ($tripped) {
        $remain = [int]($cooldownUntil - (Get-Date)).TotalSeconds
        if ($remain -gt 0) {
            Write-State @{
                mode = 'cooldown'
                pid = 0
                cooldownUntil = $cooldownUntil.ToString('yyyy-MM-dd HH:mm:ss')
                cooldownRounds = $cooldownRounds
                note = "崩溃循环冷却中，$remain 秒后探测一次（已重启 $cooldownRounds/$MaxCooldownRounds）"
            } | Out-Null
            if (((Get-Date) - $lastTripNotice).TotalMinutes -ge 5) {
                Write-WatchLog 'WARN' ("crash-loop cooldown: {0}s 后探测拉起（已重启 {1}/{2}）" -f $remain, $cooldownRounds, $MaxCooldownRounds)
                $lastTripNotice = Get-Date
            }
            Start-Sleep -Seconds 30
            continue
        }
        if ($cooldownRounds -ge $MaxCooldownRounds) {
            # 不转 stopped：冷却轮次用尽后改为 5 分钟间隔的慢速重试，仍然全自动。
            $cooldownRounds = 0
            $cooldownUntil = (Get-Date).AddSeconds(300)
            Write-WatchLog 'WARN' "冷却重启 $MaxCooldownRounds 轮仍然崩，转 5 分钟间隔慢速重试（仍自动拉起，不等人工）"
            Write-State @{ mode = 'slow-retry'; pid = 0; cooldownUntil = $cooldownUntil.ToString('yyyy-MM-dd HH:mm:ss'); note = '慢速重试：每 5 分钟探测拉起一次' } | Out-Null
            continue
        }
        $cooldownRounds++
        $tripped = $false
        $rapidFails = 0
        $exitTimes.Clear()
        $backoffUntil = [datetime]::MinValue
        Write-WatchLog 'WARN' ("冷却结束，探测并尝试拉起（第 {0}/{1} 次）" -f $cooldownRounds, $MaxCooldownRounds)
        Write-State @{ mode = 'cooldown-relaunch'; pid = 0; cooldownRounds = $cooldownRounds; note = '冷却结束，探测拉起' } | Out-Null
        # 不 continue：落到下面的正常启动流程
    }

    if ((Get-Date) -lt $backoffUntil) {
        Write-State @{ mode = 'backoff'; pid = 0; backoffUntil = $backoffUntil.ToString('yyyy-MM-dd HH:mm:ss'); note = '退避中' } | Out-Null
        Start-Sleep -Seconds $IntervalSec
        continue
    }

    # 自动更新窗口：安装器在跑、或更新缓存刚写入时不要拉起，否则拉起的是半新半旧的实例。
    $upd = Get-UpdateActivity (Get-Date).AddSeconds(-120)
    if ($upd) {
        Write-State @{ mode = 'updating'; pid = 0; note = $upd } | Out-Null
        if (((Get-Date) - $lastUpdNotice).TotalSeconds -ge 30) {
            Write-WatchLog 'INFO' ("自动更新进行中（{0}），本轮不拉起，等安装完成" -f $upd)
            $lastUpdNotice = Get-Date
        }
        Start-Sleep -Seconds 10
        continue
    }

    # 根因修复：宿主未运行时先清掉历史 dsh-auth-* cookie，再拉起（累积会让宿主回非 2xx）。
    Repair-HarnessCookieJar

    # 启动前把上一轮日志转存，保留死因现场（Start-Process 重定向会清空目标文件）。
    foreach ($pair in @(@($outLog, ($outLog -replace '\.log$', '.prev.log')), @($errLog, ($errLog -replace '\.log$', '.prev.log')))) {
        if (Test-Path -LiteralPath $pair[0]) {
            try { Move-Item -LiteralPath $pair[0] -Destination $pair[1] -Force } catch { }
        }
    }

    Write-WatchLog 'WARN' 'harness 不在运行，开始拉起'
    $startedAt = Get-Date
    $proc = $null
    $harnessPid = 0
    try {
        # 启动方式的两个硬约束：
        #   1. 完全无窗口：用 Win32 CreateProcess + CREATE_NO_WINDOW，不经 cmd /c（cmd 壳会在部分环境闪窗）；
        #   2. stdout/stderr 绑的是**继承给宿主的文件句柄**，不是匿名管道。
        #      Harness 主进程会把 desktop host 的 stdout pipe 到自己的 process.stdout；
        #      管道读端由本守护持有，守护一死就断，宿主写 stdout 直接 EPIPE 并弹 JS 错误窗。
        #      文件句柄由宿主自己持有，守护死掉也不受影响，日志同时实时落盘。
        $argLine = ''
        if ($HarnessArguments.Count -gt 0) {
            $argLine = (($HarnessArguments | ForEach-Object {
                $item = [string]$_
                if ($item -match '\s') { '"' + $item + '"' } else { $item }
            }) -join ' ')
        }
        $proc = [HarnessNativeChild]::Start($Harness, $argLine, $outLog, $errLog, (Split-Path -Parent $Harness))

        # 等宿主主进程出现，状态里报主进程 pid（排除 --type= 的 Chromium 子进程和 --expose-internals 的 host 子进程）。
        Start-Sleep -Milliseconds 1200
        $harnessPid = Get-HarnessRootPid
        if ($harnessPid -eq 0) { $harnessPid = $proc.Pid }
    }
    catch {
        Write-WatchLog 'ERROR' ("拉起失败：" + $_.Exception.Message)
        $rapidFails++
        $exitTimes.Add((Get-Date)) | Out-Null
        $wait = [Math]::Min($MaxBackoffSec, $BaseBackoffSec * [Math]::Pow(2, [Math]::Max(0, $rapidFails - 1)))
        $backoffUntil = (Get-Date).AddSeconds($wait)
        Write-State @{ mode = 'down'; pid = 0; note = '拉起失败：' + $_.Exception.Message } | Out-Null
        if ($exitTimes.Count -ge $MaxRestart) {
            $tripped = $true
            $cooldownUntil = (Get-Date).AddMinutes($CooldownMin)
            $lastTripNotice = Get-Date
            Write-WatchLog 'ERROR' "崩溃循环：$CrashWindowMin 分钟内失败 $($exitTimes.Count) 次，进入 $CooldownMin 分钟冷却，之后探测拉起。"
            Show-Alert 'DeepSeek Harness 反复拉起失败' "改为冷却自愈：$CooldownMin 分钟后自动探测拉起一次。详见 harness.watchdog.log。"
        }
        continue
    }

    $restartCount++
    Write-WatchLog 'INFO' ("已拉起 pid={0}（无窗口，日志 >> {1}）" -f $harnessPid, $outLog)
    Write-State @{ mode = 'running'; pid = $harnessPid; restarts = $restartCount; since = $startedAt.ToString('yyyy-MM-dd HH:mm:ss'); note = '' } | Out-Null
    try { Add-CrashRelaunch -ProcessId $harnessPid } catch { }

    # 等它退出。只轮询 HasExited：不调用无参 WaitForExit（子进程可能继承管道句柄）。
    # 同时盯启动宽限期内的崩溃报告：壳死在认证握手时窗口永远不会出现，进程却会挂两分钟，
    # 光等 HasExited 会让「崩了没人知道」变成常态。
    $bootFail = $null
    $bootDeadline = $startedAt.AddSeconds($BootGraceSec)
    while (-not $proc.HasExited) {
        if (Test-Path -LiteralPath $pauseMarker) { break }
        if ($null -eq $bootFail -and (Get-Date) -lt $bootDeadline) {
            $report = Get-NewCrashReport $startedAt
            if ($report) {
                $bootFail = $report
                Write-WatchLog 'ERROR' ("壳启动失败签名：{0}（{1}）" -f $report.Signature, (Split-Path -Leaf $report.Path))
                Write-State @{ mode = 'boot-fail'; pid = $harnessPid; signature = $report.Signature; note = '壳启动期崩溃，清理残留后重启' } | Out-Null
                Show-Alert 'DeepSeek Harness 启动失败' ("{0}；已自动清理并重启。" -f $report.Signature)
                # 这种实例不会出窗口，立即清掉进程树，别让它占着 userData 挡下一次启动。
                Stop-HarnessLeftovers
                $killDeadline = (Get-Date).AddSeconds(15)
                while (-not $proc.HasExited -and (Get-Date) -lt $killDeadline) { Start-Sleep -Milliseconds 300 }
            }
        }
        Start-Sleep -Seconds 2
        try {
            if ($proc.HasExited) { break }
        }
        catch { break }
    }

    if (-not $proc.HasExited) {
        # 停机标记触发：不记账、不重启，直接退出循环。
        Write-WatchLog 'INFO' "pause marker during run (pid $($proc.Pid))，守护退出，宿主保持运行由 stop-dsh 处理"
        Write-State @{ mode = 'paused'; note = 'stop requested while running' } | Out-Null
        break
    }

    # 退出码：这是「崩溃还是被结束」的唯一硬证据。cmd /c 会透传宿主的退出码。
    $exitCode = -1
    try { $exitCode = [int]$proc.ExitCode } catch { $exitCode = -1 }

    $livedSec = [int]((Get-Date) - $startedAt).TotalSeconds
    $info = Describe-Exit $exitCode
    $tail = Get-ErrTail
    $exitAt = Get-Date
    $exitTimes.Add($exitAt) | Out-Null

    $exitRecord = [ordered]@{
        at = $exitAt.ToString('yyyy-MM-dd HH:mm:ss')
        pid = $harnessPid
        code = $exitCode
        hex = ('0x{0:X8}' -f [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$exitCode), 0))
        kind = $info.kind
        text = $info.text
        livedSec = $livedSec
        signature = $(if ($bootFail) { $bootFail.Signature } else { '' })
        stderrTail = $tail
    }

    Write-WatchLog 'WARN' ("harness exited pid={0} {1} lived={2}s stderr={3}" -f $harnessPid, $info.text, $livedSec, $tail)
    try { Write-CrashMarker -ProcessId $harnessPid -Code $exitCode -Kind $info.kind -Text $info.text -LivedSec $livedSec -StartedAt $startedAt -Note $(if ($bootFail) { '启动期失败：' + $bootFail.Signature } else { '' }) | Out-Null }
    catch { Write-WatchLog 'ERROR' ('崩溃标记写入失败：' + $_.Exception.Message) }
    try { $proc.Close() } catch { }
    $proc = $null   # 已结清，之后如果出现进程就按「外部启动」接管

    if ($info.kind -ne 'normal') {
        $rapidFails++
    }
    elseif ($livedSec -ge 600) {
        $rapidFails = 0
    }

    # 只保留窗口内的异常退出
    $windowStart = (Get-Date).AddMinutes(-$CrashWindowMin)
    $recent = @($exitTimes | Where-Object { $_ -gt $windowStart })
    $exitTimes.Clear()
    foreach ($item in $recent) { $exitTimes.Add($item) | Out-Null }

    Write-State @{ mode = 'down'; pid = 0; crashesInWindow = $exitTimes.Count; lastExit = $exitRecord; note = '' } | Out-Null

    if ($info.kind -eq 'normal') {
        $upd = Get-UpdateActivity $startedAt
        if ($upd) {
            # 自动更新装完会让进程以 0 退出，再由安装器拉起新实例；这时自己再拉一个就是并发实例。
            $wait = 30
            Write-WatchLog 'INFO' ("正常退出且检测到自动更新（{0}）：先等安装器拉起新实例，{1}s 后仍未出现再自行拉起" -f $upd, $wait)
            Write-State @{ mode = 'updating'; pid = 0; lastExit = $exitRecord; note = '自动更新安装中，等待安装器重启' } | Out-Null
        }
        else {
            $wait = 60
            Write-WatchLog 'INFO' "正常退出：60 秒后自动拉起（如果这是人工关闭，请改用 stop-dsh.ps1）"
        }
    }
    elseif ($bootFail) {
        # 启动期失败（认证握手）：退避没有意义，清干净后快速重试；修 cookie 由下一轮拉起前完成。
        $wait = 15
        Write-WatchLog 'WARN' ("启动期失败（{0}），15 秒后重试（下一轮拉起前会清理历史认证 cookie）" -f $bootFail.Signature)
    }
    else {
        Show-Alert 'DeepSeek Harness 异常退出' ("{0}，存活 {1} 秒。{2}" -f $info.text, $livedSec, $(if ($tail) { 'stderr：' + $tail } else { 'stderr 为空' }))
        $wait = [Math]::Min($MaxBackoffSec, $BaseBackoffSec * [Math]::Pow(2, [Math]::Max(0, $rapidFails - 1)))
        Write-WatchLog 'WARN' "退避 ${wait}s 后重启"
    }
    $backoffUntil = (Get-Date).AddSeconds($wait)

    if ($exitTimes.Count -ge $MaxRestart) {
        $tripped = $true
        $cooldownUntil = (Get-Date).AddMinutes($CooldownMin)
        $lastTripNotice = Get-Date
        Write-WatchLog 'ERROR' "崩溃循环：$CrashWindowMin 分钟内异常退出 $($exitTimes.Count) 次（上限 $MaxRestart），进入 $CooldownMin 分钟冷却，之后探测拉起。"
        Show-Alert 'DeepSeek Harness 崩溃循环' "改为冷却自愈：$CooldownMin 分钟后自动探测拉起一次（已尝试 $cooldownRounds/$MaxCooldownRounds）。"
        Write-State @{ mode = 'cooldown'; pid = 0; cooldownUntil = $cooldownUntil.ToString('yyyy-MM-dd HH:mm:ss'); cooldownRounds = $cooldownRounds; note = "崩溃循环，冷却 $CooldownMin 分钟" } | Out-Null
    }
}

try { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue } catch { }
Write-WatchLog 'INFO' 'watchdog stopped'
