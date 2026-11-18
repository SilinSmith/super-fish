// 全局单调度器：代理进程内唯一的周期性任务时钟。
//
// 设计约束（对应启停契约 / 优化清单）：
//   - 只有这里允许持有 setInterval；业务模块不再各自散落定时器。
//   - 单调时钟（process.hrtime.bigint）计时，不受系统改时间、休眠唤醒影响。
//   - 最小堆按 dueAt 排序，30 秒一次 tick 统一派发（QQ_SCHED_TICK_MS 可调）。
//   - 每个任务的 lastRunAt 落盘到 scheduler-state.json：进程重启后按「上次完成时间」
//     判断错过多少周期，并在启动时立即补跑一次，不依赖 Windows 计划任务。
//   - 状态文件原子写（tmp + fsync + rename，写前写后校验），
//     坏文件隔离成 .corrupt-<时间戳> 并回退到 .snapshot 上一快照，不整份删除。
//   - 任务异常/超时只记录，不让代理进程退出；上一轮未结束则跳过本轮并记一行。

import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_TIMEOUT_MS = 120_000;

/** 二叉最小堆：元素 { due, seq, id }。 */
class MinHeap {
    constructor() { this.items = []; }
    get size() { return this.items.length; }
    peek() { return this.items[0]; }
    push(item) {
        const items = this.items;
        items.push(item);
        let i = items.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.#less(items[i], items[parent]) === false) break;
            [items[i], items[parent]] = [items[parent], items[i]];
            i = parent;
        }
    }
    pop() {
        const items = this.items;
        if (items.length === 0) return undefined;
        const top = items[0];
        const last = items.pop();
        if (items.length > 0 && last !== undefined) {
            items[0] = last;
            let i = 0;
            for (;;) {
                const left = i * 2 + 1;
                const right = left + 1;
                let smallest = i;
                if (left < items.length && this.#less(items[left], items[smallest])) smallest = left;
                if (right < items.length && this.#less(items[right], items[smallest])) smallest = right;
                if (smallest === i) break;
                [items[i], items[smallest]] = [items[smallest], items[i]];
                i = smallest;
            }
        }
        return top;
    }
    #less(a, b) {
        if (a.due !== b.due) return a.due < b.due;
        return a.seq < b.seq;
    }
}

function sleepSync(ms) {
    // 只用于写盘失败后的极短退避，避免把调度线程卡太久。
    const until = Date.now() + ms;
    while (Date.now() < until) { /* spin */ }
}

/**
 * @param {object} options
 * @param {string} options.statePath  scheduler-state.json 的绝对路径
 * @param {number} [options.tickMs]   统一 tick 间隔（默认 30s）
 * @param {(level:string,message:string)=>void} [options.log]
 * @param {(path:string,data:object)=>void} [options.onPersist] 测试/遥测钩子
 */
export function createScheduler({ statePath, tickMs = 30_000, log = () => undefined, tasks = [], now = () => Date.now(), maxTimeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const monoBase = process.hrtime.bigint();
    const mono = () => Number(process.hrtime.bigint() - monoBase) / 1e6;
    const wallAtStart = now();
    const monoAtStart = mono();

    const entries = new Map();   // id -> { id, intervalMs, run, timeoutMs, catchUp, running, due }
    const heap = new MinHeap();
    const state = loadState(statePath, log);
    let seq = 0;
    let timer = null;
    let ticks = 0;
    let tickBusy = false;
    let lastTickAt = null;
    let started = false;

    function scheduleAt(entry, dueMono) {
        entry.due = dueMono;
        heap.push({ due: dueMono, seq: ++seq, id: entry.id });
    }

    /** 注册任务；重复注册同 id 视为更新（先删旧堆项，由 tick 时按 id 丢弃过期条目）。 */
    function register(task) {
        const id = String(task.id ?? '').trim();
        if (id === '') throw new Error('scheduler.register: task.id 不能为空');
        if (typeof task.run !== 'function') throw new Error(`scheduler.register: ${id} 缺少 run()`);
        const intervalMs = Math.max(1_000, Number(task.intervalMs ?? 60_000));
        const entry = {
            id,
            intervalMs,
            run: task.run,
            timeoutMs: Math.max(1_000, Number(task.timeoutMs ?? Math.min(maxTimeoutMs, intervalMs))),
            catchUp: task.catchUp !== false,
            running: false,
            due: 0,
        };
        entries.set(id, entry);

        const prev = Number(state.tasks?.[id]?.lastRunAtMs ?? 0);
        const prevIso = Number.isFinite(prev) && prev > 0 ? new Date(prev).toISOString() : '';
        let targetWall = prev > 0 ? prev + intervalMs : wallAtStart;
        if (task.catchUp === false && targetWall < wallAtStart) targetWall = wallAtStart + intervalMs;
        const missed = prev > 0 ? Math.max(0, Math.floor((wallAtStart - (prev + intervalMs)) / intervalMs)) : 0;
        const dueMono = Math.max(mono() + (prev > 0 ? 0 : 0), monoAtStart + (targetWall - wallAtStart));
        scheduleAt(entry, Math.max(mono(), dueMono));
        if (missed > 0) {
            log('info', `补跑 ${id}：上次完成 ${prevIso}，重启间隔超过 ${missed} 个周期（共 ${intervalMs}ms/周期）`);
        }
        return entry;
    }

    function runEntry(entry) {
        if (entry.running) {
            log('warn', `跳过 ${entry.id}：上一轮尚未结束`);
            state.tasks[entry.id] = { ...(state.tasks[entry.id] ?? {}), lastSkipAtMs: now(), skips: Number(state.tasks?.[entry.id]?.skips ?? 0) + 1 };
            return;
        }
        entry.running = true;
        const startedMono = mono();
        let settled = false;
        const finish = (ok, detail) => {
            if (settled) return;
            settled = true;
            entry.running = false;
            const durationMs = Math.round(mono() - startedMono);
            const prev = state.tasks?.[entry.id] ?? {};
            state.tasks[entry.id] = {
                ...prev,
                lastRunAtMs: ok ? now() : Number(prev.lastRunAtMs ?? 0),
                lastAttemptAtMs: now(),
                lastOk: ok,
                lastDurationMs: durationMs,
                runs: Number(prev.runs ?? 0) + 1,
                failures: Number(prev.failures ?? 0) + (ok ? 0 : 1),
                lastError: ok ? '' : String(detail ?? ''),
            };
            scheduleAt(entry, mono() + entry.intervalMs);
        };

        const guard = setTimeout(() => {
            if (!entry.running) return;
            log('warn', `任务 ${entry.id} 超过 ${entry.timeoutMs}ms 未结束（不中断线程，只记录并等待）`);
        }, entry.timeoutMs);
        guard.unref?.();

        Promise.resolve()
            .then(() => entry.run({ now, mono }))
            .then(() => { clearTimeout(guard); finish(true); })
            .catch(error => {
                clearTimeout(guard);
                const message = String(error?.message ?? error);
                log('warn', `任务 ${entry.id} 失败：${message}`);
                finish(false, message);
            });
    }

    function tick() {
        if (tickBusy) return;
        tickBusy = true;
        try {
            const current = mono();
            let dispatched = 0;
            for (;;) {
                const head = heap.peek();
                if (head === undefined || head.due > current) break;
                heap.pop();
                const entry = entries.get(head.id);
                // 同一 id 的旧堆项（重复注册后）直接丢弃。
                if (entry === undefined || entry.due !== head.due) continue;
                runEntry(entry);
                dispatched += 1;
            }
            ticks += 1;
            lastTickAt = new Date(now()).toISOString();
            persist(statePath, state, lastTickAt, log);
            if (dispatched > 0) log('debug', `tick #${ticks}：派发 ${dispatched} 个任务`);
        }
        finally {
            tickBusy = false;
        }
    }

    function start() {
        if (started) return;
        started = true;
        log('info', `调度器启动：tick=${tickMs}ms 任务=${entries.size} 状态=${statePath} 上次 tick=${state.lastTickAt || '（无）'}`);
        tick();
        timer = setInterval(tick, tickMs);
        timer.unref?.();
    }

    function stop() {
        if (timer !== null) clearInterval(timer);
        timer = null;
        started = false;
        persist(statePath, state, lastTickAt, log);
    }

    for (const task of tasks) register(task);

    return {
        start,
        stop,
        register,
        tick,
        snapshot: () => ({
            tickMs,
            ticks,
            lastTickAt,
            lastTickAtMs: state.lastTickAtMs ?? null,
            tasks: [...entries.values()].map(entry => ({
                id: entry.id,
                intervalMs: entry.intervalMs,
                running: entry.running,
                ...(state.tasks?.[entry.id] ?? {}),
            })),
        }),
    };
}

/* ------------------------------------------------------------------ */
/* 状态持久化：原子写 + 校验 + 坏文件隔离                                 */
/* ------------------------------------------------------------------ */

function emptyState() {
    return { version: 1, lastTickAt: '', lastTickAtMs: 0, tasks: {} };
}

function parseStateFile(path) {
    const text = readFileSync(path, 'utf8');
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || typeof data.tasks !== 'object' || data.tasks === null)
        throw new Error('结构不符（缺少 tasks 对象）');
    return { ...emptyState(), ...data };
}

/** 读到坏文件时：改名隔离为 .corrupt-<ts>，再回退上一快照；都失败就用空状态继续。 */
function loadState(path, log) {
    if (!existsSync(path)) return emptyState();
    try {
        return parseStateFile(path);
    }
    catch (error) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const corrupt = `${path}.corrupt-${stamp}`;
        try {
            renameSync(path, corrupt);
            log('warn', `调度器状态损坏，已隔离为 ${corrupt}（${String(error?.message ?? error)}）`);
        }
        catch (renameError) {
            log('warn', `调度器状态损坏且无法隔离：${String(renameError?.message ?? renameError)}`);
        }
    }
    const snapshot = `${path}.snapshot`;
    if (existsSync(snapshot)) {
        try {
            const data = parseStateFile(snapshot);
            log('info', `调度器状态已回退到上一快照 ${snapshot}（lastTick=${data.lastTickAt || '（无）'}）`);
            return data;
        }
        catch (error) {
            log('warn', `上一快照也不可用：${String(error?.message ?? error)}`);
        }
    }
    return emptyState();
}

function persist(path, state, lastTickAt, log) {
    state.lastTickAt = lastTickAt ?? state.lastTickAt ?? '';
    state.lastTickAtMs = lastTickAt ? Date.parse(lastTickAt) : Number(state.lastTickAtMs ?? 0);
    const tmp = `${path}.tmp-${process.pid}`;
    const body = JSON.stringify(state, null, 2);
    try {
        mkdirSync(dirname(path), { recursive: true });
        // 写前再校验一次序列化结果，避免把半截 JSON 换上正式文件。
        JSON.parse(body);
        const fd = openSync(tmp, 'w');
        try {
            writeSync(fd, body);
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        // 上一份好文件留作快照，再原子替换。
        if (existsSync(path)) {
            try { copyFileSync(path, `${path}.snapshot`); } catch { /* 快照失败不阻塞主流程 */ }
        }
        renameSync(tmp, path);
    }
    catch (error) {
        log('warn', `调度器状态落盘失败：${String(error?.message ?? error)}`);
        try { writeFileSync(`${path}.last-error`, body); } catch { /* 忽略 */ }
    }
}
