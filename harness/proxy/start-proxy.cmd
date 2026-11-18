@echo off
setlocal
rem Node 路径可用 NODE_EXE 覆盖；缺省走 PATH 里的 node。
set "NODE=%NODE_EXE%"
if not defined NODE set "NODE=node"
rem 以脚本所在目录为根，避免写死部署路径。
set "ROOT=%~dp0"
rem Engine KV pool: 896 pages (57344 tokens); 3 x 12k histories tested without exhaustion.
set "QQ_UPSTREAM_MAX_CONCURRENCY=3"
set "QQ_UPSTREAM_QUEUE_LIMIT=8"

:wait
if not exist "%ROOT%proxy.mjs" (
  ping -n 6 127.0.0.1 >nul
  goto wait
)

:run
powershell.exe -NoLogo -NoProfile -NonInteractive -Command "try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:1240/health'; if ($r.StatusCode -eq 200) { exit 0 } } catch { }; exit 1" >nul 2>&1
if not errorlevel 1 (
  ping -n 6 127.0.0.1 >nul
  goto run
)
"%NODE%" "%ROOT%proxy.mjs" >> "%ROOT%proxy.stdout.log" 2>> "%ROOT%proxy.stderr.log"
ping -n 4 127.0.0.1 >nul
goto run
