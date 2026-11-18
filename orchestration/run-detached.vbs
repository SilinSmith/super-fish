' 隐藏启动器：由 wscript.exe //B 调用，自身没有控制台窗口。
' 用法：
'   wscript.exe //B //Nologo run-detached.vbs "<cwd>" "<logFile>" <0|1> "<exe>" ["<arg>" ...]
'   <logFile> 为空表示不重定向；非空时用隐藏的 cmd 追加输出到日志。
'   <0|1> 是窗口样式：0=隐藏（控制台程序），1=正常显示（GUI 程序，例如 Harness）。
Option Explicit

Dim args, cwd, logFile, style, exe, cmd, i, sh, q

Set args = WScript.Arguments
If args.Count < 4 Then
    WScript.Quit 2
End If

cwd = args(0)
logFile = args(1)
style = CLng(args(2))
exe = args(3)
q = Chr(34)

cmd = q & exe & q
For i = 4 To args.Count - 1
    Dim item
    item = args(i)
    ' cmd.exe 不接受带引号的开关（"/c" 会被当成命令），只有它的参数需要保持原样。
    If LCase(Right(exe, 7)) = "cmd.exe" And Left(item, 1) = "/" Then
        cmd = cmd & " " & item
    Else
        cmd = cmd & " " & q & item & q
    End If
Next

Set sh = CreateObject("WScript.Shell")
If cwd <> "" Then
    sh.CurrentDirectory = cwd
End If

If logFile <> "" Then
    ' cmd 只在隐藏窗口里做重定向，不会弹出可见控制台。
    sh.Run "cmd.exe /d /s /c " & q & cmd & " >> " & q & logFile & q & " 2>&1" & q, style, False
Else
    sh.Run cmd, style, False
End If
