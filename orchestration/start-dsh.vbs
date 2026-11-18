Option Explicit
' QQ Bot 启动器（桌面「启动 QQ Bot」快捷方式指向这里）：
' 隐藏窗口运行 start-bot.ps1 —— 默认只起基础设施（引擎 8094 / proxy 1240 / console 1242），
' 不接 QQ 流量。需要接流量时手动运行：start-bot.ps1 -ConnectTraffic。
' 失败时把日志末尾的 [FAIL] 行弹出来，明确是哪个组件、什么原因。
Dim sh, code, logPath, here
logPath = "Y:\dsh\2026-11-10\qqbot-ninfer-bridge\work\start-bot.log"
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
code = sh.Run("powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & here & "\start-bot.ps1""", 0, True)
If code <> 0 Then
    MsgBox "QQ Bot 启动失败（退出码 " & code & "）。" & vbCrLf & vbCrLf & _
           "日志末尾：" & vbCrLf & Tail(logPath, 900) & vbCrLf & vbCrLf & _
           "完整日志：" & vbCrLf & logPath, vbCritical, "QQ Bot 启动失败"
End If

Function Tail(path, maxChars)
    Dim fso, f, s
    Set fso = CreateObject("Scripting.FileSystemObject")
    If Not fso.FileExists(path) Then
        Tail = "(日志不存在：)" & path
        Exit Function
    End If
    Set f = fso.OpenTextFile(path, 1)
    s = f.ReadAll
    f.Close
    If Len(s) > maxChars Then s = Mid(s, Len(s) - maxChars + 1)
    Tail = s
End Function
