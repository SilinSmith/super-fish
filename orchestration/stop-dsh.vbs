Option Explicit
' QQ Bot 关闭器（桌面快捷方式指向这里）：隐藏窗口运行 stop-dsh.ps1，失败时弹窗提示日志位置。
Dim sh, code, logPath, here
logPath = "Y:\dsh\2026-11-10\qqbot-ninfer-bridge\work\stop-dsh.log"
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
code = sh.Run("powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & here & "\stop-dsh.ps1""", 0, True)
If code <> 0 Then
    MsgBox "QQ Bot 关闭未完全成功（退出码 " & code & "）。" & vbCrLf & vbCrLf & _
           "请查看日志：" & vbCrLf & logPath, vbExclamation, "QQ Bot 关闭提示"
End If
