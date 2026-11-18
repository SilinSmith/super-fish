# 控制台守护：健康检查失败才拉起 node，进程退出后自动重启。
# 由 wscript.exe + run-detached.vbs 以隐藏窗口启动，不产生任何可见控制台。
# 日志：
#   console.out.log / console.err.log  node 自身输出（每次启动重写；启动行带 pid）
#   console.watchdog.log               启动命令、退出码、存活秒数、stderr 尾部（追加）
$ErrorActionPreference = 'Continue'

$Root = 'Y:\dsh\home\qq-console'
$Node = 'D:\Program Files\nodejs\node.exe'
$Server = Join-Path $Root 'server.mjs'
$OutLog = Join-Path $Root 'console.out.log'
$ErrLog = Join-Path $Root 'console.err.log'
$WatchLog = Join-Path $Root 'console.watchdog.log'
# 无窗口启动器：CreateProcess + CREATE_NO_WINDOW + 文件句柄继承。
$Launcher = 'Y:\dsh\hidden-launch.ps1'

function Write-Watch {
    param([string]$Message)
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    try { Add-Content -LiteralPath $WatchLog -Value $line -Encoding UTF8 } catch { }
}

function Test-ConsoleHealth {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:1242/api/health' -TimeoutSec 2
        return ([int]$response.StatusCode -eq 200)
    }
    catch { return $false }
}

Write-Watch ("watchdog start pid=$PID server=$Server node=$Node")

while ($true) {
    if (Test-ConsoleHealth) {
        Start-Sleep -Seconds 2
        continue
    }

    # 必须无窗口：Start-Process 会给 node 一个真实控制台，Win11 默认终端（Windows Terminal）
    # 会把它接管成用户能点掉的窗口，点掉窗口就等于向进程组发 CTRL_CLOSE_EVENT，node 会被杀。
    # 日志走继承给 node 的文件句柄（不是匿名管道），本守护退出也不会让 node 写 stdout 时 EPIPE。
    Write-Watch ("starting node: " + $Node + " " + $Server)
    $startedAt = Get-Date
    $result = ''
    try {
        $result = (& $Launcher -FilePath $Node -Arguments ('"' + $Server + '"') `
            -WorkingDirectory $Root -OutLog $OutLog -ErrLog $ErrLog -Wait -HiddenConsole) -join ' '
    }
    catch {
        Write-Watch ("node start failed: " + $_.Exception.Message)
        Start-Sleep -Seconds 5
        continue
    }

    $nodePid = 0
    $exitCode = 'unknown'
    if ($result -match 'pid=(\d+)') { $nodePid = [int]$Matches[1] }
    if ($result -match 'exit=(-?\d+)') { $exitCode = [int]$Matches[1] }
    $lived = [int]((Get-Date) - $startedAt).TotalSeconds

    $tail = ''
    try {
        if (Test-Path -LiteralPath $ErrLog) {
            $lines = @(Get-Content -LiteralPath $ErrLog -Tail 20 -ErrorAction SilentlyContinue)
            if ($lines.Count -gt 0) { $tail = ($lines -join ' | ') }
        }
    }
    catch { }
    Write-Watch ("node exited pid=" + $nodePid + " code=" + $exitCode + " lived=${lived}s stderr=" + $tail)

    # 连续秒退时放慢重启，避免刷爆日志。
    if ($lived -lt 5) { Start-Sleep -Seconds 5 }
}
