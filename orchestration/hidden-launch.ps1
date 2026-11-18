# hidden-launch.ps1 -- 无窗口启动控制台程序（CreateProcess + CREATE_NO_WINDOW + 文件句柄继承）。
#
# 为什么需要它：
#   1) WMI Win32_Process.Create / Start-Process 直接创建控制台程序时，进程会拿到真实控制台；
#      Win11 默认终端是 Windows Terminal，会把控制台接管成一个窗口（即便最小化也能被用户点掉），
#      而关掉窗口 = 向进程组发 CTRL_CLOSE_EVENT，node 会被一起带走。
#   2) 用管道重定向（RedirectStandardOutput 走匿名管道）会引入 EPIPE：读端一死，下一次写就崩。
#      所以 stdout/stderr 必须是「继承给子进程的文件句柄」。
#
# 输出：一行 "pid=<pid>"；加 -Wait 时在子进程退出后输出 "pid=<pid> exit=<code>"。
#
# 用法：
#   & Y:\dsh\hidden-launch.ps1 -FilePath node.exe -Arguments '"Y:\x.mjs"' -OutLog a.log -ErrLog b.log
#   & Y:\dsh\hidden-launch.ps1 -SpecFile spec.json     # 参数太长或要经 WMI 转发时用
param(
    [string]$FilePath,
    [string]$Arguments = '',
    [string]$WorkingDirectory = '',
    [string]$OutLog = '',
    [string]$ErrLog = '',
    [switch]$Append,
    [switch]$Wait,
    # 隐藏控制台：仍不显示窗口，但进程拥有自己的控制台。
    # 用于那些在 CREATE_NO_WINDOW 下会卡死的程序（实测 ComfyUI 会卡在自定义节点导入前，
    # CPU 空转、端口永不监听）；CREATE_NEW_CONSOLE + SW_HIDE 两者兼得，且保留 breakaway。
    [switch]$HiddenConsole,
    [string]$SpecFile
)

$ErrorActionPreference = 'Stop'

if ($SpecFile) {
    $spec = Get-Content -Raw -LiteralPath $SpecFile | ConvertFrom-Json
    if ($spec.filePath) { $FilePath = [string]$spec.filePath }
    if ($null -ne $spec.arguments) { $Arguments = [string]$spec.arguments }
    if ($spec.workingDirectory) { $WorkingDirectory = [string]$spec.workingDirectory }
    if ($spec.outLog) { $OutLog = [string]$spec.outLog }
    if ($spec.errLog) { $ErrLog = [string]$spec.errLog }
    if ($spec.append) { $Append = [bool]$spec.append }
    if ($spec.wait) { $Wait = [bool]$spec.wait }
}

if (-not $FilePath) {
    throw '缺少 -FilePath（或 -SpecFile 中的 filePath）'
}

# CreateProcess 的 lpApplicationName 必须是完整路径，只给 exe 名会失败（错误码 2）。
if ($FilePath -notmatch '[\\/]') {
    $resolved = Get-Command $FilePath -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $resolved -or -not $resolved.Source) {
        throw "找不到可执行文件：$FilePath"
    }
    $FilePath = $resolved.Source
}
elseif (-not (Test-Path -LiteralPath $FilePath)) {
    throw "可执行文件不存在：$FilePath"
}

if (-not ('HiddenChildV2' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class HiddenChildV2
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

    public int WaitExit(uint ms)
    {
        WaitForSingleObject(hProcess, ms);
        uint code; GetExitCodeProcess(hProcess, out code);
        return unchecked((int)code);
    }

    public void Close() { if (hProcess != IntPtr.Zero) { CloseHandle(hProcess); hProcess = IntPtr.Zero; } }

    public static HiddenChildV2 Start(string exe, string args, string outPath, string errPath, string cwd,
        bool append, bool breakaway, bool hiddenConsole)
    {
        try
        {
            return StartCore(exe, args, outPath, errPath, cwd, append, breakaway, hiddenConsole);
        }
        catch (System.ComponentModel.Win32Exception ex)
        {
            // 父进程所在的作业对象不允许 breakaway 时（ERROR_ACCESS_DENIED）退回普通创建。
            if (breakaway && ex.NativeErrorCode == 5)
                return StartCore(exe, args, outPath, errPath, cwd, append, false, hiddenConsole);
            throw;
        }
    }

    static HiddenChildV2 StartCore(string exe, string args, string outPath, string errPath, string cwd,
        bool append, bool breakaway, bool hiddenConsole)
    {
        SECURITY_ATTRIBUTES sec = new SECURITY_ATTRIBUTES();
        sec.nLength = Marshal.SizeOf(sec);
        sec.bInheritHandle = 1;
        IntPtr psec = Marshal.AllocHGlobal(sec.nLength);
        Marshal.StructureToPtr(sec, psec, false);

        // 追加用 FILE_APPEND_DATA+OPEN_ALWAYS；覆盖用 GENERIC_WRITE+CREATE_ALWAYS（与 Start-Process 一致）。
        uint access = append ? 0x4u : 0x40000000u;
        uint disp = append ? 4u : 2u;

        IntPtr hOut = IntPtr.Zero, hErr = IntPtr.Zero, hIn = IntPtr.Zero;
        try
        {
            hOut = CreateFile(outPath, access, 7u, psec, disp, 0x80u, IntPtr.Zero);
            hErr = CreateFile(errPath, access, 7u, psec, disp, 0x80u, IntPtr.Zero);
            hIn = CreateFile("NUL", 0xC0000000u, 7u, psec, 3u, 0x80u, IntPtr.Zero);
            if (hOut == new IntPtr(-1) || hErr == new IntPtr(-1) || hIn == new IntPtr(-1))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "打开日志句柄失败");

            STARTUPINFO si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(si);
            si.dwFlags = 0x100; // STARTF_USESTDHANDLES
            if (hiddenConsole)
            {
                si.dwFlags |= 0x1; // STARTF_USESHOWWINDOW
                si.wShowWindow = 0; // SW_HIDE
            }
            si.hStdInput = hIn;
            si.hStdOutput = hOut;
            si.hStdError = hErr;

            // 默认 CREATE_NO_WINDOW：完全不创建控制台，Windows Terminal 也就没有可接管的对象。
            // HiddenConsole 时改用 CREATE_NEW_CONSOLE：有独立控制台但窗口被 SW_HIDE 隐藏，
            // 用于绕过「无控制台就卡死」的程序（如 ComfyUI 的自定义节点导入）。
            // CREATE_BREAKAWAY_FROM_JOB：脱离调用方终端作业，命令结束后不被回收。
            uint flags = hiddenConsole ? 0x00000010u : 0x08000000u;
            if (breakaway) flags |= 0x01000000u;

            StringBuilder cmd = new StringBuilder("\"" + exe + "\"" + (String.IsNullOrEmpty(args) ? "" : " " + args));
            PROCESS_INFORMATION pi;
            bool ok = CreateProcess(exe, cmd, IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, cwd, ref si, out pi);
            int err = Marshal.GetLastWin32Error();
            if (!ok) throw new System.ComponentModel.Win32Exception(err, "CreateProcess 失败（错误码 " + err + "）");
            CloseHandle(pi.hThread);
            HiddenChildV2 child = new HiddenChildV2();
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

$outPath = if ($OutLog) { $OutLog } else { 'NUL' }
$errPath = if ($ErrLog) { $ErrLog } else { 'NUL' }
$cwd = if ($WorkingDirectory) { $WorkingDirectory } else { (Get-Location).Path }
if ($cwd -and -not (Test-Path -LiteralPath $cwd)) {
    throw "工作目录不存在：$cwd"
}

$child = [HiddenChildV2]::Start($FilePath, $Arguments, $outPath, $errPath, $cwd, [bool]$Append, $true, [bool]$HiddenConsole)
$childPid = $child.Pid

if ($Wait) {
    $code = $child.WaitExit([uint32]::MaxValue)
    $child.Close()
    Write-Output ("pid={0} exit={1}" -f $childPid, $code)
}
else {
    $child.Close()
    Write-Output ("pid={0}" -f $childPid)
}
