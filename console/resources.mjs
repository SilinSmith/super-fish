/**
 * 资源占用采样：进程 CPU%/工作集 + 整机 CPU/内存/显存/磁盘。
 *
 * 数据全部来自 Windows 自带计数器和进程表，不做估算：
 *   - 进程 CPU：Get-Process TotalProcessorTime 前后两次采样的差值 / 采样间隔 / 逻辑核数
 *   - 整机 CPU：同一窗口内所有进程 CPU 时间差之和 / 采样间隔 / 逻辑核数
 *   - 进程内存：Get-Process WorkingSet64（工作集）
 *   - 整机内存：Win32_OperatingSystem
 *   - 端口 → PID：netstat -ano（比 Get-NetTCPConnection 快一个数量级）
 *   - 显存：nvidia-smi（存在才取）
 *   - 磁盘：Win32_LogicalDisk（工作盘 Y:）
 *
 * 一次采样只起一个 powershell 进程，结果缓存 8 秒；刷新间隔 10 秒，
 * 不会每次刷新都重新初始化日志/计数器。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CACHE_MS = 8000;

const PROC_SAMPLE = '[pscustomobject]@{id=$_.Id;name=$_.ProcessName;ws=[double]$_.WorkingSet64;'
    + 'cpuMs=[double]$_.TotalProcessorTime.TotalMilliseconds}';

const SCRIPT = [
    "$ErrorActionPreference='SilentlyContinue'",
    '$ports=@(8094,1240,1242,3001,8188,6199,6299)',
    '$listen=@(foreach($line in @(netstat -ano)){'
        + '$p=@($line.Trim() -split \'\\s+\');'
        + 'if($p.Count -ge 5 -and $p[0] -eq \'TCP\'){'
        + '$m=[regex]::Match($p[1],":(\\d+)$");'
        + 'if($m.Success -and ($ports -contains [int]$m.Groups[1].Value)){'
        + '[pscustomobject]@{port=[int]$m.Groups[1].Value;pid=[int]$p[4]} } } })',
    '$t1=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    '$proc1=@(Get-Process | ForEach-Object { ' + PROC_SAMPLE + ' })',
    'Start-Sleep -Milliseconds 700',
    '$proc2=@(Get-Process | ForEach-Object { ' + PROC_SAMPLE + ' })',
    '$t2=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    '$os=Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory,NumberOfLogicalProcessors',
    "$disk=Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='Y:'\" | Select-Object Size,FreeSpace",
    "$wd=@(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -match 'watchdog' } | Select-Object ProcessId)",
    "$hosts=@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'dsh-onebot|profiles.desktop|qq-persona' } | Select-Object ProcessId)",
    "$gpu=(& nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader,nounits 2>$null) -join ';'",
    '[pscustomobject]@{listen=$listen;proc1=$proc1;proc2=$proc2;t1=$t1;t2=$t2;os=$os;disk=$disk;'
        + 'cores=[Environment]::ProcessorCount;'
        + 'watchdogPids=@($wd.ProcessId);hostPids=@($hosts.ProcessId);gpu=$gpu}'
        + ' | ConvertTo-Json -Compress -Depth 4',
].join('; ');

let cache = { at: 0, data: null, promise: null };

const round1 = value => Math.round(Number(value || 0) * 10) / 10;
const toMb = bytes => Math.round(Number(bytes || 0) / 1048576);
const list = value => (Array.isArray(value) ? value : (value ? [value] : []));

function emptyResult(error) {
    return {
        ok: false,
        error,
        sampledAt: new Date().toISOString(),
        sampleMs: 0,
        machine: null,
        byNode: {},
    };
}

async function collect() {
    const started = Date.now();
    const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT,
    ], { windowsHide: true, timeout: 12000, maxBuffer: 16 * 1024 * 1024 });
    const raw = JSON.parse(String(stdout ?? '').trim() || '{}');
    const sampleMs = Date.now() - started;

    const before = new Map();
    for (const row of list(raw.proc1))
        before.set(Number(row.id), row);
    const after = new Map();
    for (const row of list(raw.proc2))
        after.set(Number(row.id), row);

    const os = raw.os ?? {};
    // 这台机器的 Win32_OperatingSystem.NumberOfLogicalProcessors 返回 null，用 PowerShell 自带计数兜底。
    const cores = Number(raw.cores) || Number(os.NumberOfLogicalProcessors) || 1;
    // 用同一对时间戳算采样窗口，进程和整机 CPU 共用，保持一致。
    const elapsedSec = (Number(raw.t2 ?? 0) - Number(raw.t1 ?? 0)) / 1000;

    const usage = pids => {
        const unique = [...new Set(pids.map(Number).filter(pid => pid > 0))];
        let cpuMs = 0;
        let memBytes = 0;
        let matched = 0;
        for (const pid of unique) {
            const a = before.get(pid);
            const b = after.get(pid);
            if (!b)
                continue;
            matched += 1;
            memBytes += Number(b.ws ?? 0);
            if (a)
                cpuMs += Math.max(0, Number(b.cpuMs ?? 0) - Number(a.cpuMs ?? 0));
        }
        return {
            cpu: elapsedSec > 0 ? round1(cpuMs / 1000 / elapsedSec / cores * 100) : 0,
            memMB: toMb(memBytes),
            pids: matched,
        };
    };

    const listeners = list(raw.listen);
    const portPid = port => Number(listeners.find(item => Number(item.port) === port)?.pid) || 0;
    const hostPids = list(raw.hostPids).map(Number).filter(Number.isFinite);
    const watchdogPids = list(raw.watchdogPids).map(Number).filter(Number.isFinite);
    const harnessPids = [...after.values()]
        .filter(row => String(row.name ?? '').startsWith('DeepSeek Harness'))
        .map(row => Number(row.id));

    const byNode = {
        'harness-process': usage([...harnessPids, ...hostPids]),
        'proxy-port': usage([portPid(1240)]),
        'engine-port': usage([portPid(8094)]),
        'snowluma-port': usage([portPid(3001)]),
        'console-port': usage([portPid(1242)]),
        'comfyui-port': usage([portPid(8188)]),
        'webui': usage([portPid(6299), portPid(6199)]),
        'watchdog-module': usage(watchdogPids),
    };

    let totalCpuMs = 0;
    for (const [pid, b] of after) {
        const a = before.get(pid);
        if (a)
            totalCpuMs += Math.max(0, Number(b.cpuMs ?? 0) - Number(a.cpuMs ?? 0));
    }
    const cpuPercent = elapsedSec > 0
        ? round1(Math.min(100, totalCpuMs / 1000 / elapsedSec / cores * 100))
        : 0;

    const memTotalMB = Math.round(Number(os.TotalVisibleMemorySize || 0) / 1024);
    const memUsedMB = Math.round((Number(os.TotalVisibleMemorySize || 0) - Number(os.FreePhysicalMemory || 0)) / 1024);
    const diskTotalGB = Math.round(Number(raw.disk?.Size || 0) / 1073741824);
    const diskFreeGB = Math.round(Number(raw.disk?.FreeSpace || 0) / 1073741824);

    let gpu = null;
    const gpuText = String(raw.gpu ?? '').trim();
    if (gpuText) {
        const [name, used, total] = gpuText.split(',').map(part => part.trim());
        if (Number(used) > 0 || Number(total) > 0)
            gpu = { name: name || 'GPU', usedMB: Number(used) || 0, totalMB: Number(total) || 0 };
    }

    return {
        ok: true,
        sampledAt: new Date().toISOString(),
        sampleMs,
        machine: {
            cpuPercent,
            windowMs: Math.round(elapsedSec * 1000),
            cpuMs: Math.round(totalCpuMs),
            memUsedMB,
            memTotalMB,
            memPercent: memTotalMB ? round1((memUsedMB / memTotalMB) * 100) : 0,
            gpu,
            disk: { mount: 'Y:', freeGB: diskFreeGB, totalGB: diskTotalGB, usedPercent: diskTotalGB ? round1(((diskTotalGB - diskFreeGB) / diskTotalGB) * 100) : 0 },
        },
        byNode,
    };
}

export async function resourceSnapshot() {
    const now = Date.now();
    if (cache.data && now - cache.at < CACHE_MS)
        return cache.data;
    if (cache.promise)
        return cache.promise;
    cache.promise = collect()
        .then(data => {
            cache = { at: Date.now(), data, promise: null };
            return data;
        })
        .catch(error => {
            const data = cache.data ?? emptyResult(String(error?.message ?? error));
            cache = { at: Date.now(), data, promise: null };
            return data;
        });
    return cache.promise;
}
