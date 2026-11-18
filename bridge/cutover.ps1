# 切换阶段控制 + 机读状态落盘。
#   -Stage prepare|private|one-group|all|done|paused|rolled-back [-Group <gid>] [-Note "..."] [-NoRestart]
# private  ：旧栈整插件 disabled -> 重启宿主一次 -> 私聊过滤启动 bridge
# one-group：只改 bridge-mode.json（不重启宿主/桥）
# all      ：只改 bridge-mode.json（不重启宿主/桥）
# paused   ：只写状态文件（手动全停，无任何一方服务真实流量）
# 状态文件：Y:\dsh\home\qq-console\state\cutover.json（临时文件 + Move-Item 原子替换）
# 互斥：cutover.lock；失败保护：private/one-group/all/done 任一步失败自动调用 rollback.ps1
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('prepare', 'private', 'one-group', 'all', 'done', 'paused', 'rolled-back')]
    [string]$Stage,
    [string]$Group = '100000001',
    [string]$Note = '',
    [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'
$CutRoot = 'Y:\dsh\home\qq-cutover'
$Backup = Join-Path $CutRoot 'backup'
$LockFile = Join-Path $CutRoot 'cutover.lock'
$script:LockStream = $null
$LiveYml = 'C:\Users\user\.dsh\profiles\desktop\cordis.patch.yml'
$OrigYml = Join-Path $Backup 'cordis.patch.yml.original'
$OffYml = Join-Path $Backup 'cordis.patch.yml.off'
$ModeFile = Join-Path $CutRoot 'bridge-mode.json'
$StateDir = 'Y:\dsh\home\qq-console\state'
$StateFile = Join-Path $StateDir 'cutover.json'
$BridgePy = Join-Path $CutRoot 'bridge.py'
$BridgePid = Join-Path $CutRoot 'bridge.pid'
$BridgeLog = Join-Path $CutRoot 'bridge.log'
$PythonW = 'E:\Bonsai\astrbot-eval\venv\Scripts\pythonw.exe'
$RollbackCmd = 'powershell -NoProfile -ExecutionPolicy Bypass -File "Y:\dsh\home\qq-cutover\rollback.ps1"'

function Say([string]$Level, [string]$Text) {
    Write-Output ("[{0}] [{1}] {2}" -f (Get-Date -Format 'HH:mm:ss'), $Level, $Text)
}

function Get-AstrbotPid {
    $c = Get-NetTCPConnection -LocalPort 6199 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { return [int]$c.OwningProcess }
    return 0
}

function Test-OldDisabled {
    if (-not (Test-Path -LiteralPath $LiveYml)) { return $false }
    $lines = @(Get-Content -LiteralPath $LiveYml)
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^\s*-\s*id:\s*dsh-onebot\s*$') {
            for ($j = $i + 1; $j -lt [Math]::Min($i + 40, $lines.Count); $j++) {
                if ($lines[$j] -match '^\s*-\s*id:') { break }
                if ($lines[$j] -match '^\s*disabled:\s*true\s*$') { return $true }
            }
            return $false
        }
    }
    return $false
}

function Write-CutoverState([string]$Mode, [string]$StateNote) {
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    $hostRunning = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count -gt 0
    $obj = [ordered]@{
        updatedAt        = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' +0800'
        stage            = $Stage
        mode             = $Mode
        astrbotPid       = (Get-AstrbotPid)
        oldStackServing  = ($hostRunning -and -not (Test-OldDisabled))
        rollbackCommand  = $RollbackCmd
        note             = $StateNote
    }
    $tmp = Join-Path $StateDir ('cutover.json.tmp-' + $PID)
    [IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $StateFile -Force
    Say PASS ("cutover.json: stage={0} mode={1} oldStackServing={2} astrbotPid={3}" -f $obj.stage, $obj.mode, $obj.oldStackServing, $obj.astrbotPid)
}

function Set-BridgeMode([string]$Mode, [string]$Gid = '') {
    $obj = [ordered]@{ mode = $Mode; group_id = $Gid }
    $tmp = Join-Path $CutRoot ('bridge-mode.json.tmp-' + $PID)
    [IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $ModeFile -Force
    Say INFO ("bridge-mode.json -> mode={0} group_id={1}" -f $Mode, $Gid)
}

function Stop-Bridge {
    $killed = @()
    if (Test-Path -LiteralPath $BridgePid) {
        try {
            $bp = [int]((Get-Content -LiteralPath $BridgePid -Raw).Trim())
            if ($bp -and (Get-Process -Id $bp -ErrorAction SilentlyContinue)) {
                Stop-Process -Id $bp -Force -ErrorAction SilentlyContinue
                $killed += $bp
            }
        } catch { }
    }
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*qq-cutover\bridge.py*' })
    foreach ($p in $procs) {
        Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction SilentlyContinue
        $killed += [int]$p.ProcessId
    }
    Start-Sleep -Milliseconds 500
    if ($killed.Count -gt 0) { Say INFO ("已停 bridge pid=" + (($killed | Select-Object -Unique) -join ',')) }
}

function Start-Bridge {
    if (Test-Path -LiteralPath $BridgePid) {
        try {
            $old = [int]((Get-Content -LiteralPath $BridgePid -Raw).Trim())
            if ($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) {
                Say INFO "bridge 已在运行 pid=$old"
                return $true
            }
        } catch { }
    }
    if (-not (Test-Path -LiteralPath $PythonW)) { throw "找不到 pythonw: $PythonW" }
    # 必须用 WMI Win32_Process.Create 拉起 wscript：Start-Process 一类的子进程属于调用方作业，
    # 调用方一退出就被回收（之前 bridge 连上后立刻消失就是这个原因）。
    $Vbs = 'Y:\dsh\run-detached.vbs'
    $ConsoleLog = Join-Path $CutRoot 'bridge.console.log'
    $q = '"'
    $cmdLine = 'wscript.exe //B //Nologo ' + $q + $Vbs + $q + ' ' + $q + $CutRoot + $q + ' ' +
               $q + $ConsoleLog + $q + ' 0 ' + $q + $PythonW + $q + ' ' + $q + $BridgePy + $q
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdLine }
    if ($r.ReturnValue -ne 0) { throw ("Win32_Process.Create 失败 ReturnValue={0}" -f $r.ReturnValue) }
    $deadline = (Get-Date).AddSeconds(20)
    $bp = 0
    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $BridgePid) {
            try { $bp = [int]((Get-Content -LiteralPath $BridgePid -Raw).Trim()) } catch { $bp = 0 }
            if ($bp -and (Get-Process -Id $bp -ErrorAction SilentlyContinue)) { break }
        }
        Start-Sleep -Milliseconds 400
    }
    if (-not $bp) { throw 'bridge 启动后 20s 内没有写 pid' }
    Start-Sleep -Seconds 3
    if (-not (Get-Process -Id $bp -ErrorAction SilentlyContinue)) {
        throw ("bridge pid={0} 启动后 3s 内退出；看 {1}" -f $bp, $ConsoleLog)
    }
    $deadline = (Get-Date).AddSeconds(25)
    while ((Get-Date) -lt $deadline) {
        $c3001 = @(Get-NetTCPConnection -State Established -RemotePort 3001 -ErrorAction SilentlyContinue |
            Where-Object { [int]$_.OwningProcess -eq $bp })
        $c6199 = @(Get-NetTCPConnection -State Established -RemotePort 6199 -ErrorAction SilentlyContinue |
            Where-Object { [int]$_.OwningProcess -eq $bp })
        if ($c3001.Count -gt 0 -and $c6199.Count -gt 0) {
            Say PASS ("bridge 已连上 3001 与 6199 pid={0}" -f $bp)
            return $true
        }
        Start-Sleep -Milliseconds 600
    }
    throw 'bridge 25s 内未同时连上 3001 与 6199'
}

function Install-LiveConfig([string]$Src) {
    $bytes = [IO.File]::ReadAllBytes($Src)
    $tmp = $LiveYml + '.cutover-tmp'
    [IO.File]::WriteAllBytes($tmp, $bytes)
    Move-Item -LiteralPath $tmp -Destination $LiveYml -Force
    Say INFO ("已替换 live 配置 <- {0}" -f (Split-Path -Leaf $Src))
}

# ------------------------------------------------------------- 互斥
function Enter-CutoverLock {
    $deadline = (Get-Date).AddSeconds(120)
    while ($true) {
        try {
            $stream = [IO.File]::Open($LockFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $script:LockStream = $stream
            $bytes = [Text.Encoding]::UTF8.GetBytes(("{0}|{1}" -f $PID, (Get-Date -Format o)))
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush()
            Say INFO ("已获取互斥锁 pid={0}" -f $PID)
            return
        } catch [System.IO.IOException] {
            $owner = ''
            try { $owner = (Get-Content -LiteralPath $LockFile -Raw).Trim() } catch { }
            $ownerPid = 0
            if ($owner -match '^(\d+)\|') { $ownerPid = [int]$Matches[1] }
            $alive = $ownerPid -and (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)
            if (-not $alive) {
                Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
                continue
            }
            if ((Get-Date) -gt $deadline) {
                throw ("另一个 cutover/rollback 正在运行 pid={0}，等待 120s 仍被占用" -f $ownerPid)
            }
            Start-Sleep -Seconds 1
        }
    }
}

function Exit-CutoverLock {
    if ($script:LockStream) {
        $script:LockStream.Dispose()
        $script:LockStream = $null
    }
    try {
        $owner = (Get-Content -LiteralPath $LockFile -Raw).Trim()
        if ($owner -match ('^' + $PID + '\|')) {
            Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
        }
    } catch { }
}

# ------------------------------------------------------------------ stage
$failure = $null
try {
    Enter-CutoverLock
    switch ($Stage) {
        'prepare' {
            Write-CutoverState 'old' ($(if ($Note) { $Note } else { 'P0 准备中：旧栈全量出站，未切换会话无空窗' }))
        }
        'private' {
            if (-not (Test-Path -LiteralPath $OrigYml)) { throw "缺少原始备份 $OrigYml" }
            if (-not (Test-Path -LiteralPath $OffYml)) { throw "缺少 disabled 变体 $OffYml" }
            Stop-Bridge
            Install-LiveConfig $OffYml
            if (-not $NoRestart) {
                Say INFO '重启宿主（旧栈插件将不再加载）'
                $out = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $CutRoot 'restart-host.ps1') 2>&1
                foreach ($line in @($out)) { Say INFO ("  " + [string]$line) }
                if ($LASTEXITCODE -ne 0) { throw "restart-host 失败 exit=$LASTEXITCODE" }
            }
            Set-BridgeMode 'private' ''
            [void](Start-Bridge)
            $defaultNote = 'P1：私聊已切 AstrBot；旧栈停挂，群 100000001/100000002/100000003/100000004 处于空窗，预计 P2 扩群前结束（约数分钟）'
            Write-CutoverState 'split' ($(if ($Note) { $Note } else { $defaultNote }))
        }
        'one-group' {
            Set-BridgeMode 'one-group' $Group
            $others = @('100000001', '100000002', '100000003', '100000004') | Where-Object { $_ -ne $Group }
            $defaultNote = ("P2：私聊+群 {0} 已切 AstrBot；旧栈停挂，群 {1} 处于空窗，预计 P3 前结束（约数分钟）" -f $Group, ($others -join '/'))
            Write-CutoverState 'split' ($(if ($Note) { $Note } else { $defaultNote }))
        }
        'all' {
            Set-BridgeMode 'all' ''
            Write-CutoverState 'astrbot' ($(if ($Note) { $Note } else { 'P3：全部会话已切 AstrBot；旧栈停挂，空窗结束' }))
        }
        'done' {
            Write-CutoverState 'astrbot' ($(if ($Note) { $Note } else { '切换完成：全部真实消息由 AstrBot 出站' }))
        }
        'paused' {
            Write-CutoverState 'none' ($(if ($Note) { $Note } else { '已暂停：没有任何一方服务真实流量' }))
        }
        'rolled-back' {
            Set-BridgeMode 'old' ''
            Write-CutoverState 'old' ($(if ($Note) { $Note } else { '已回滚：旧栈恢复全量出站，AstrBot 桥已停' }))
        }
    }
} catch {
    $failure = $_.Exception.Message
    Say ERROR ("阶段 {0} 失败：{1}" -f $Stage, $failure)
} finally {
    Exit-CutoverLock
}

if ($failure) {
    if ($Stage -in @('prepare', 'paused', 'rolled-back')) {
        # 这三档没有动宿主/桥，没有"两边都没人"的风险
        Say ERROR '该阶段未改动宿主或 bridge，不触发自动回滚'
        exit 12
    }
    Say WARN '失败保护：自动回滚到旧栈'
    $rbNote = ("自动回滚：{0} 阶段失败：{1}" -f $Stage, $failure)
    $rbOut = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $CutRoot 'rollback.ps1') -Note $rbNote 2>&1
    foreach ($line in @($rbOut)) { Say INFO ("  " + [string]$line) }
    if ($LASTEXITCODE -ne 0) {
        Say ERROR ("自动回滚失败 exit={0}；状态已写 rollback-failed，需人工确认后再说" -f $LASTEXITCODE)
        exit 13
    }
    Say PASS '自动回滚完成：旧栈已恢复服务'
    exit 12
}
exit 0
