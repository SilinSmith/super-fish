# reload-xzy.ps1 - controlled reload of the AstrBot plugin `xzy` (spec 15.4)
# No new scheduled task. If the reload cannot be verified, the AstrBot process is
# stopped on purpose so bot-child-watchdog.ps1 brings it back (5s poll + settle).
# Zero window: this script never spawns a console.

param(
    [int]$TimeoutSec = 40,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$cfgPath = 'E:\Bonsai\astrbot-eval\inst\data\cmd_config.json'
$logDir = 'E:\Bonsai\astrbot-eval\logs'
$auditPath = 'Y:\dsh\2026-11-10\qqbot-ninfer-bridge\work\reload-audit.jsonl'

function Write-Audit {
    param([hashtable]$Fields)
    $row = [ordered]@{ at = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'); pid = $PID }
    foreach ($k in $Fields.Keys) { $row[$k] = $Fields[$k] }
    $json = ($row | ConvertTo-Json -Compress -Depth 5)
    $dir = Split-Path $auditPath -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Add-Content -Path $auditPath -Value $json -Encoding UTF8
}

function Get-AstrBotPids {
    # Prefer the 6199 listener + its parent/children (venv launcher -> real python).
    $pids = @()
    $listener = Get-NetTCPConnection -LocalPort 6199 -State Listen -ErrorAction SilentlyContinue
    if ($listener) {
        $lpid = [int]$listener.OwningProcess
        $pids += $lpid
        $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $lpid" -ErrorAction SilentlyContinue
        if ($cim -and $cim.ParentProcessId) { $pids += [int]$cim.ParentProcessId }
        Get-CimInstance Win32_Process -Filter "ParentProcessId = $lpid" -ErrorAction SilentlyContinue |
            ForEach-Object { $pids += [int]$_.ProcessId }
    }
    if ($pids.Count -eq 0) {
        Get-CimInstance Win32_Process -Filter "Name like 'python%'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine -match 'astrbot-eval\\venv|astrbot-eval\\inst' } |
            ForEach-Object { $pids += [int]$_.ProcessId }
    }
    return ($pids | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
}

function Stop-AstrBot {
    param([string]$Reason)
    $pids = Get-AstrBotPids
    Write-Audit @{ event = 'fallback-kill'; reason = $Reason; targets = ($pids -join ',') }
    foreach ($p in $pids) {
        try { Stop-Process -Id $p -Force -ErrorAction Stop; Write-Host "[kill] $p" }
        catch { Write-Host "[kill-failed] $p : $($_.Exception.Message)" }
    }
}

if (-not (Test-Path $cfgPath)) {
    Write-Audit @{ event = 'abort'; reason = 'cmd_config.json missing' }
    Write-Host '[FAIL] cmd_config.json missing'
    exit 2
}

$cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$port = [int]$cfg.dashboard.port
$base = "http://127.0.0.1:$port"

# 1) AstrBot must be up before we touch anything.
$up = $false
try {
    $r = Invoke-WebRequest -Uri "$base/" -UseBasicParsing -TimeoutSec 5
    $up = ($r.StatusCode -eq 200)
} catch {
    $up = $false
}
if (-not $up) {
    Write-Audit @{ event = 'skip'; reason = 'dashboard not reachable' }
    Write-Host '[SKIP] dashboard not reachable; nothing to reload'
    exit 3
}

$before = (Get-AstrBotPids) -join ','
$log = Get-ChildItem -Path $logDir -Filter 'run-*.log' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime | Select-Object -Last 1
$logOffset = 0
if ($log) { $logOffset = (Get-Item $log.FullName).Length }

if ($DryRun) {
    Write-Audit @{ event = 'dry-run'; pids = $before; log = $(if ($log) { $log.Name } else { '' }) }
    Write-Host "[DRY] would reload xzy on $base (pids=$before)"
    exit 0
}

# 2) Login (dashboard password is stored as md5 in cmd_config.json).
$token = ''
try {
    $body = @{ username = $cfg.dashboard.username; password = $cfg.dashboard.password } |
        ConvertTo-Json -Compress
    $resp = Invoke-RestMethod -Uri "$base/api/auth/login" -Method Post -Body $body `
        -ContentType 'application/json' -TimeoutSec 10
    if ($resp.status -ne 'ok') { throw "login status=$($resp.status) message=$($resp.message)" }
    $token = $resp.data.token
} catch {
    Write-Audit @{ event = 'login-failed'; error = $_.Exception.Message }
    Write-Host "[FAIL] login: $($_.Exception.Message)"
    exit 4
}
$headers = @{ Authorization = "Bearer $token" }

# 3) Reload.
try {
    $body = '{"name":"xzy"}'
    $resp = Invoke-RestMethod -Uri "$base/api/plugin/reload" -Method Post -Body $body `
        -Headers $headers -ContentType 'application/json' -TimeoutSec 30
    if ($resp.status -ne 'ok') { throw "reload status=$($resp.status) message=$($resp.message)" }
    Write-Host "[OK] reload requested: $($resp.message)"
} catch {
    Write-Audit @{ event = 'reload-failed'; error = $_.Exception.Message; pids = $before }
    Write-Host "[FAIL] reload: $($_.Exception.Message)"
    Stop-AstrBot 'reload-request-failed'
    exit 10
}

# 4) Verify: plugin listed + initialize line in the log (after our offset).
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$listed = $false
$initialized = $false
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    try {
        $plugs = Invoke-RestMethod -Uri "$base/api/plugin/get" -Headers $headers -TimeoutSec 5
        $names = @($plugs.data | ForEach-Object { $_.name })
        $listed = ($names -contains 'xzy')
    } catch { $listed = $false }
    if ($log -and -not $initialized) {
        try {
            $fs = [System.IO.File]::Open($log.FullName, 'Open', 'Read', 'ReadWrite')
            $fs.Seek($logOffset, 'Begin') | Out-Null
            $reader = New-Object System.IO.StreamReader($fs)
            $tail = $reader.ReadToEnd()
            $reader.Close(); $fs.Close()
            if ($tail -match '\[xzy\] initialize') { $initialized = $true }
        } catch { }
    }
    if ($listed -and $initialized) { break }
}

$after = (Get-AstrBotPids) -join ','
Write-Audit @{
    event = 'reload'; ok = ($listed -and $initialized); listed = $listed
    initialized = $initialized; pidBefore = $before; pidAfter = $after
    log = $(if ($log) { $log.Name } else { '' })
}

if ($listed -and $initialized) {
    Write-Host '[OK] xzy listed and initialized'
    exit 0
}

Write-Host "[FAIL] listed=$listed initialized=$initialized -> hand over to watchdog"
Stop-AstrBot 'reload-unverified'
exit 11
