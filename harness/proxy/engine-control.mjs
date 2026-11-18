/**
 * 聊天引擎生命周期控制：出图前释放显存，出图后恢复。
 *
 * 引擎启停统一走 llm-backend.json 的 engineControl：卸载只递意图给
 * Y:\workspace\ninfer\engine-control.ps1（它再调 stop-ninfer.ps1 写 engine.stop），
 * 恢复也走同一个脚本（它再调 start-ninfer.ps1）。
 * 未配置启动命令时拒绝在出图前杀引擎，避免图生成完聊天模型回不来。
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { LLM, healthUrl } from './llm-config.mjs';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function logWith(logger, level, message) {
    try {
        logger?.(level, message);
    }
    catch {
        // 日志不能影响出图主流程
    }
}

async function engineReachable(timeoutMs = 2_500) {
    // 只要 HTTP 有响应就算进程还在（503 = 模型加载中，同样不能重复拉起）。
    try {
        await fetch(healthUrl(), { signal: AbortSignal.timeout(timeoutMs) });
        return true;
    }
    catch {
        return false;
    }
}

async function engineReady(timeoutMs = 2_500) {
    try {
        const response = await fetch(healthUrl(), { signal: AbortSignal.timeout(timeoutMs) });
        return response.ok;
    }
    catch {
        return false;
    }
}

function controlScriptOf(control) {
    const script = typeof control.controlScript === 'string' ? control.controlScript : '';
    return script !== '' && existsSync(script) ? script : '';
}

/**
 * 只递“请求卸载”的意图：具体怎么停由 engine-control.ps1 决定，engine.stop 也只是
 * 由它内部调用的 stop-ninfer.ps1 写。脚本会先落 engine.pending-restore.json，
 * 宿主若在这期间死掉，engine-restore-watchdog.ps1 会兜底拉回引擎。
 */
function runUnloadScript(control, logger) {
    const script = controlScriptOf(control);
    if (script === '')
        return false;
    const args = [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-Action', 'unload',
        '-Owner', 'qq_draw', '-OwnerPid', String(process.pid), '-Reason', 'MOSS 出图',
    ];
    const result = spawnSync('powershell.exe', args, {
        cwd: control.controlWorkingDirectory || undefined,
        encoding: 'utf8',
        // 脚本自己会等 stopWaitMs 再返回，这里多留 30 秒余量。
        timeout: (control.stopWaitMs ?? 30_000) + 30_000,
        windowsHide: true,
    });
    if (result.status !== 0) {
        logWith(logger, 'warn', 'engine unload request failed: '
            + String(result.stderr || result.stdout || '').slice(0, 300));
        return false;
    }
    return true;
}

async function releaseExternal(logger) {
    const control = LLM.engineControl;
    const script = controlScriptOf(control);
    // 没有任何恢复手段就绝不能先杀引擎：图生成完聊天模型回不来，bot 会直接失联。
    if (control.startCommand === '' && script === '') {
        if (control.allowConcurrent === true) {
            logWith(logger, 'warn', '未配置引擎启停命令，按 allowConcurrent 继续出图；显存可能不足');
            return { released: false, concurrent: true };
        }
        throw new Error('未配置 ninfer 启动命令，无法在出图后恢复聊天引擎，已拒绝停止引擎；'
            + '请在 llm-backend.json 的 engineControl.startCommand 中配置');
    }
    // 只递“请求卸载”的意图：controlScript 不存在就不许自己动手，避免绕过
    // engine.pending-restore.json 的记账直接写 engine.stop。
    if (script === '')
        throw new Error('未配置 engineControl.controlScript（engine-control.ps1），无法在出图前请求卸载引擎');
    if (!runUnloadScript(control, logger))
        throw new Error('请求卸载引擎失败（engine-control.ps1 unload），已放弃出图以免聊天模型回不来');
    const deadline = Date.now() + control.stopWaitMs;
    while (Date.now() < deadline) {
        if (!(await engineReachable()))
            return { released: true };
        await sleep(1000);
    }
    throw new Error('引擎仍在运行，无法在出图前释放显存：' + LLM.baseUrl);
}

function startExternal(control) {
    // 官方启动器是 VBS（内部再用 pythonw 拉起引擎，全程无控制台窗口）。
    // 同时兼容 ps1 / cmd / bat / exe，方便以后换脚本。
    const command = control.startCommand;
    let executable = command;
    let args = [...control.startArguments];
    if (/\.(cmd|bat)$/iu.test(command)) {
        executable = process.env.ComSpec ?? 'cmd.exe';
        args = ['/d', '/s', '/c', command, ...args];
    }
    else if (/\.ps1$/iu.test(command)) {
        executable = 'powershell.exe';
        args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', command, ...args];
    }
    else if (/\.vbs$/iu.test(command)) {
        executable = 'wscript.exe';
        args = [command, ...args];
    }
    let stdio = 'ignore';
    let outFd;
    let errFd;
    if (control.startLogPath !== '') {
        // 冷启动失败时要能看到引擎自己的报错，不能再把输出丢掉。
        mkdirSync(dirname(control.startLogPath), { recursive: true });
        outFd = openSync(control.startLogPath, 'a');
        errFd = openSync(control.startLogPath, 'a');
        stdio = ['ignore', outFd, errFd];
    }
    const child = spawn(executable, args, {
        cwd: control.startWorkingDirectory || undefined,
        env: { ...process.env, ...control.startEnv },
        detached: true,
        stdio,
        windowsHide: true,
    });
    child.unref();
    if (outFd !== undefined) {
        closeSync(outFd);
        closeSync(errFd);
    }
}

/**
 * 跑一段恢复脚本并等它真的跑完。
 * 以前的 detached + unref 会留下"日志文件建好了、脚本一行都没执行、外面却还在
 * 傻等 600 秒"的坑（2026-11-12 17:37 / 17:47 两次都是这样，bot 哑了 10 分钟）。
 * 现在改成前台等待：退出码和耗时都记下来，失败立刻能看见。
 */
function runScriptAndWait(script, args, control, timeoutMs = 180_000) {
    return new Promise(resolvePromise => {
        let executable = script;
        let spawnArgs = [...args];
        if (/\.(cmd|bat)$/iu.test(script)) {
            executable = process.env.ComSpec ?? 'cmd.exe';
            spawnArgs = ['/d', '/s', '/c', script, ...args];
        }
        else if (/\.ps1$/iu.test(script)) {
            executable = 'powershell.exe';
            spawnArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args];
        }
        const logPath = control.restoreLogPath || control.startLogPath || '';
        let outFd;
        let errFd;
        let stdio = 'ignore';
        try {
            if (logPath !== '') {
                mkdirSync(dirname(logPath), { recursive: true });
                outFd = openSync(logPath, 'a');
                errFd = openSync(logPath, 'a');
                stdio = ['ignore', outFd, errFd];
            }
        }
        catch {
            stdio = 'ignore';
        }
        const startedAt = Date.now();
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            try {
                if (outFd !== undefined)
                    closeSync(outFd);
                if (errFd !== undefined)
                    closeSync(errFd);
            }
            catch {
                // 关句柄失败不影响结论
            }
            resolvePromise(result);
        };
        let child;
        try {
            child = spawn(executable, spawnArgs, {
                cwd: control.controlWorkingDirectory || undefined,
                env: { ...process.env },
                stdio,
                windowsHide: true,
            });
        }
        catch (error) {
            finish({ code: null, ms: 0, error: 'spawn 失败: ' + String(error?.message ?? error) });
            return;
        }
        const timer = setTimeout(() => {
            try {
                child.kill();
            }
            catch {
                // 杀不掉就让系统回收
            }
            finish({ code: null, ms: Date.now() - startedAt, error: '超时未结束（>' + timeoutMs + 'ms）' });
        }, timeoutMs);
        timer.unref?.();
        child.once('error', error => {
            clearTimeout(timer);
            finish({ code: null, ms: Date.now() - startedAt, error: 'spawn 失败: ' + String(error?.message ?? error) });
        });
        child.once('exit', code => {
            clearTimeout(timer);
            finish({ code, ms: Date.now() - startedAt, error: '' });
        });
    });
}

async function restoreExternal(logger) {
    const control = LLM.engineControl;
    const script = controlScriptOf(control);
    if (script !== '') {
        // 恢复也走 engine-control.ps1：它内部才调 start-ninfer.ps1，成功后删掉
        // engine.pending-restore.json；脚本自己也会等就绪，这里再同步轮询一遍。
        logWith(logger, 'info', 'restoring chat engine via ' + script);
        const outcome = await runScriptAndWait(script, ['-Action', 'restore'], control);
        if (outcome.error !== '')
            logWith(logger, 'error', 'restore script failed: ' + outcome.error + ' (' + outcome.ms + 'ms)');
        else
            logWith(logger, 'info', 'restore script exited code=' + outcome.code + ' in ' + outcome.ms + 'ms');
        // 脚本没成功就别继续傻等整段就绪超时：直接走一次普通启动命令兜底。
        if (!(await engineReady()) && control.startCommand !== '') {
            logWith(logger, 'warn', 'restore script did not bring engine up; falling back to startCommand');
            startExternal(control);
        }
    }
    else if (control.startCommand === '') {
        logWith(logger, 'error', '未配置 ninfer 启动命令，无法自动恢复聊天引擎；'
            + '请在 llm-backend.json 的 engineControl.startCommand 中配置');
        return false;
    }
    else {
        logWith(logger, 'info', 'starting chat engine: ' + control.startCommand);
        startExternal(control);
    }
    const deadline = Date.now() + control.readyTimeoutMs;
    let nextNotice = Date.now() + 15_000;
    while (Date.now() < deadline) {
        if (await engineReady())
            return true;
        if (Date.now() >= nextNotice) {
            logWith(logger, 'info', 'chat engine still loading: ' + LLM.baseUrl);
            nextNotice = Date.now() + 15_000;
        }
        await sleep(2000);
    }
    logWith(logger, 'error', 'chat engine did not become ready before timeout: ' + LLM.baseUrl);
    return false;
}

/** 出图前调用：释放聊天引擎占用的显存。 */
export async function releaseChatEngine(logger) {
    return releaseExternal(logger);
}

/** 出图后调用：把聊天引擎装回来。 */
export async function restoreChatEngine(logger) {
    return restoreExternal(logger);
}

/** 生成期间兜底检查：外部引擎不在进程内，无法同步探测显存占用。 */
export function chatEngineResident() {
    return false;
}
