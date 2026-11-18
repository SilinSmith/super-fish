/**
 * QQ 控制台：独立本地 WebUI，只监听 127.0.0.1:1242。
 *
 * 设计约束：
 *   - 只绑回环地址，请求方不是本机一律 403；不做登录体系。
 *   - 静态资源全部来自 public/，不引用任何 CDN，断网可用。
 *   - 配置读写直接复用插件 src/config.js 的 validateConfig / writeJsonAtomic，
 *     保证和热重载是同一套规则，不复制第二份实现。
 *   - 启停只调用现有 ps1，不重写进程管理。
 *   - 日志只读文件尾部，避免把超大文件整体读进内存。
 */
import { spawn } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, readFileSync, readdirSync, statSync, statfsSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    DEFAULTS,
    TRIGGER_MODES,
    loadConfigFile,
    validateConfig,
    writeJsonAtomic,
} from '../qq-channel/onebot-plugin/src/config.js';
import { accountStatus, bindAccount, unbindAccount } from '../harness/proxy/bili-account.mjs';
// 自迭代模块：仓库内放在 harness/self-iter，状态仍由 xzy 插件写入 AstrBot 数据根。
import * as selfIter from '../harness/self-iter/index.mjs';
import { summarizeUpstream } from './upstream-state.mjs';
import { resourceSnapshot } from './resources.mjs';

const HOST = '127.0.0.1';
// 默认 1242；允许临时换端口做冒烟测试，不影响正在跑的那一份。
const PORT = Number(process.env.QQ_CONSOLE_PORT ?? 1242);
const CONSOLE_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(CONSOLE_DIR, 'public');
const BACKUP_DIR = join(CONSOLE_DIR, 'backups');

const DSH_ROOT = process.env.QQ_DSH_ROOT || 'Y:\\dsh';
const PLUGIN_DIR = join(DSH_ROOT, 'home', 'qq-onebot-plugin');
const PERSONA_DIR = join(DSH_ROOT, 'home', 'qq-persona');
// AstrBot 自管数据根：人格/记忆/自迭代/出图/B 站状态读这里。
const ASTRBOT_PERSONA_DIR = process.env.XZY_PERSONA_DIR
    || 'E:\\Bonsai\\astrbot-eval\\inst\\data\\xzy\\persona';
const SELF_ITER_DIR = join(ASTRBOT_PERSONA_DIR, 'self-iter');

// 自迭代：插件侧（xzy/self_iter.py）只写 auto-state.json / ledger.jsonl / proposals/*.json，
// 旧 Node 模块的 state.json（lastRunAt/runsToday）不会随自动触发更新。这里以插件落盘为准，
// 旧模块的 metrics 仍保留给「最近运行」明细；两侧都没有数据时才报 missing/never，不报「未知」。
function readJsonQuiet(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return null;
    }
}

function dayKeyLocal(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime()))
        return '';
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function readJsonlLinesQuiet(path, max = 600) {
    try {
        return readFileSync(path, 'utf8')
            .split(/\r?\n/)
            .filter(Boolean)
            .slice(-max)
            .map(line => {
                try {
                    return JSON.parse(line);
                }
                catch {
                    return null;
                }
            })
            .filter(Boolean);
    }
    catch {
        return [];
    }
}

function pluginSelfIterSnapshot() {
    const statePath = join(SELF_ITER_DIR, 'auto-state.json');
    const ledgerPath = join(SELF_ITER_DIR, 'ledger.jsonl');
    const autoState = readJsonQuiet(statePath);
    const ledger = readJsonlLinesQuiet(ledgerPath);
    const today = dayKeyLocal(new Date());
    const autoRows = ledger.filter(row => row.action === 'auto-run' || row.action === 'auto-skip');
    const lastDecision = autoRows[autoRows.length - 1] ?? null;
    const runsToday = ledger.filter(row => row.action === 'auto-run' && dayKeyLocal(row.ts) === today).length;
    const pending = [];
    try {
        for (const name of readdirSync(join(SELF_ITER_DIR, 'proposals'))) {
            if (!name.endsWith('.json'))
                continue;
            const item = readJsonQuiet(join(SELF_ITER_DIR, 'proposals', name));
            if (item?.status !== 'pending')
                continue;
            pending.push({ id: item.id ?? name.replace(/\.json$/, ''), title: item.title ?? '', kind: item.kind ?? '', ts: item.ts ?? '' });
        }
    }
    catch {
        // proposals 目录不存在 = 还没有提案，不算读失败
    }
    const lastRunMs = Number(autoState?.lastRunMs ?? 0) || 0;
    const gapHours = 3; // xzy.DEFAULT_CONFIG.self_iter.auto.gapHours；auto-state 未落该值，按默认口径推算
    return {
        source: 'plugin',
        state: !autoState && ledger.length === 0 ? 'missing' : lastDecision ? 'ran' : 'never',
        today,
        lastRunAt: lastRunMs > 0 ? new Date(lastRunMs).toISOString() : '',
        lastResult: autoState?.lastResult ?? '',
        lastSkipReason: autoState?.lastSkipReason ?? '',
        lastSkipAt: Number(autoState?.lastSkipMs ?? 0) > 0 ? new Date(Number(autoState.lastSkipMs)).toISOString() : '',
        lastDecision: lastDecision
            ? {
                ts: lastDecision.ts ?? '',
                status: lastDecision.action === 'auto-run' ? 'ok' : 'skipped',
                action: lastDecision.action ?? '',
                ok: lastDecision.ok,
                reason: lastDecision.reason ?? '',
                todayCount: lastDecision.todayCount,
            }
            : null,
        runsToday,
        gapHours,
        nextEarliestAt: lastRunMs > 0 ? new Date(lastRunMs + gapHours * 3600_000).toISOString() : '',
        pending,
        pendingCount: pending.length,
    };
}

const CONFIG_PATH = join(PLUGIN_DIR, 'config.json');
const SHADOW_PATH = join(PLUGIN_DIR, 'logs', 'shadow.jsonl');
// R6 自动对账脚本写出的最近一次结论（watch-r6.mjs），影子页只读展示。
const R6_RESULT_PATH = join(DSH_ROOT, '归档', '2026-11-11', 'onebot-plugin', 'work', 'r6-reconciliation.json');
const CHARACTER_PATH = join(ASTRBOT_PERSONA_DIR, 'character.md');
const ENGINE_START_SCRIPT = 'Y:\\workspace\\ninfer\\start-ninfer.ps1';
const COMPARE_SCRIPT = join(DSH_ROOT, '归档', '2026-11-11', 'onebot-plugin', 'work', 'compare-shadow.mjs');
// 面板按钮只允许调这两个入口脚本，不允许自己 kill 任何进程：
//   start-bot.ps1  唯一启动入口（幂等 / 逐项超时 / fail-closed）
//   stop-dsh.ps1   反向停机（先落 pause 标记再停守护）
const START_PS1 = join(DSH_ROOT, 'start-bot.ps1');
const STOP_PS1 = join(DSH_ROOT, 'stop-dsh.ps1');
const BRIDGE_WORK = join(DSH_ROOT, '2026-11-10', 'qqbot-ninfer-bridge', 'work');
const ENGINE_LOG_DIR = join(DSH_ROOT, '2026-11-10', 'infer-deploy', 'work', 'logs');
// 引擎健康只看 /health：闩锁时 8094 在听、/v1/models 仍 200，但所有 completion 都是 503。
const ENGINE_HEALTH_URL = 'http://127.0.0.1:8094/health';
const ENGINE_CONTROL_SCRIPT = 'Y:\\workspace\\ninfer\\engine-control.ps1';
const ENGINE_LATCH_MARK = 'worker crash: Paged KV single-page materialization exceeds reservation';
const ENGINE_WATCHDOG_STATE = join(ENGINE_LOG_DIR, 'engine-restore-watchdog.state.json');
const ENGINE_WATCHDOG_PID = join(ENGINE_LOG_DIR, 'engine-restore-watchdog.pid');
const HARNESS_WATCHDOG_PID = join(BRIDGE_WORK, 'harness.watchdog.pid');
// 真实会话映射在插件的媒体目录；插件 state 下那份停在 11-11，不再作为数据源。
const MEDIA_SESSIONS_PATH = 'C:\\Users\\user\\.dsh\\media\\onebot\\chat-sessions.json';
const SCHEDULER_STATE_PATH = join(PERSONA_DIR, 'scheduler-state.json');
const SCHEDULER_TASKS = ['defer.sweep', 'groupState.compact', 'presence.decay', 'heartbeat.persist', 'comfy.idleFree', 'health.probe', 'sticker.maintain'];
// 外部 OneBot 协议端的日志目录：协议端需自备，目录通过环境变量按需指定（可留空）。
const ONEBOT_LOG_DIR = process.env.QQ_CONSOLE_ONEBOT_LOG_DIR ?? '';
const ONEBOT_OUT_LOG = join(BRIDGE_WORK, 'onebot.out.log');
// 可见控制台窗口自检脚本（EnumWindows 实现，见脚本头部注释）。
const WINDOW_CHECK_SCRIPT = join(DSH_ROOT, 'window-check.ps1');
// 宿主守护（harness-watchdog.ps1）写出的状态与日志：面板据此展示「挂了多久、死因」。
const HARNESS_WATCHDOG_STATE = join(BRIDGE_WORK, 'harness.watchdog.state.json');
const HARNESS_WATCHDOG_LOG = join(BRIDGE_WORK, 'harness.watchdog.log');
// ComfyUI 也由 harness-watchdog 看守（掉了拉起、记录 pid 与退出码）。
const COMFY_WATCHDOG_STATE = join(BRIDGE_WORK, 'comfy.watchdog.state.json');
const COMFY_WATCHDOG_LOG = join(BRIDGE_WORK, 'comfy.watchdog.log');
// 组件降级起始时间 / 最近一次桌面提醒：跨重启保留，避免刚才挂过又归零。
const HEALTH_STATE_PATH = join(CONSOLE_DIR, 'state', 'health-state.json');
// 真实流量切换状态由迁移侧写；只读，不在这里生成或修正。
const CUTOVER_PATH = join(CONSOLE_DIR, 'state', 'cutover.json');
const CUTOVER_STALE_MS = 10 * 60_000;
const HEALTH_MONITOR_MS = 30 * 1000;
const HEALTH_ALERT_GRACE_MS = 60 * 1000;
const HEALTH_ALERT_REPEAT_MS = 15 * 60 * 1000;
const HEALTH_CRITICAL = new Set(['engine', 'proxy', 'harness', 'plugin']);

// 拓扑视图的数据源：全部是上面这些组件已经在读的同一批文件，不另造状态。
const FEED_PATH = join(PERSONA_DIR, 'conversation-feed.jsonl');
const SHARED_FEED_PATH = join(PERSONA_DIR, 'shared-feed.jsonl');
const GROUP_STATE_DIR = join(PERSONA_DIR, 'group-state');
const FAULTS_PATH = join(PERSONA_DIR, 'upstream-faults.jsonl');
const PERSONA_STATE_PATH = join(ASTRBOT_PERSONA_DIR, 'state.json');
const CONSOLE_WATCHDOG_LOG = join(CONSOLE_DIR, 'console.watchdog.log');
const ENGINE_WATCHDOG_LOG = join(ENGINE_LOG_DIR, 'engine-restore-watchdog.log');

// AstrBot 迁移栈：并行实例（6299 面板 / 6199 OneBot 反向 WS）。8094 引擎同机共用，
// 但真实 QQ 流量的服务方只认 state/cutover.json，不按进程存活推断。
// 进度数字不靠手填：能力清单读 spec §6 功能对照表，工具数读 evidence/tools.md，
// 运行时注册数读实例日志；任何一项读不到就返回 ok:false，前端显示「未知」。
const ASTRBOT_ROOT = 'E:\\Bonsai\\astrbot-eval';
const ASTRBOT_DATA_DIR = join(ASTRBOT_ROOT, 'inst', 'data');
const ASTRBOT_CONFIG_PATH = join(ASTRBOT_DATA_DIR, 'cmd_config.json');
const ASTRBOT_AUDIT_DIR = join(ASTRBOT_DATA_DIR, 'xzy', 'audit');
const ASTRBOT_LOG_PATH = join(ASTRBOT_DATA_DIR, 'logs', 'astrbot.log');
// 主动刷的权威源是 AstrBot 插件（bili_proactive.py）：配置在 xzy-config，状态在 persona 根。
// 旧 Node 引擎 qq-persona/bili-proactive.mjs 已停用，不再作为数据源，也不在控制台里运行。
const BILI_PROACTIVE_STATE_PATH = join(ASTRBOT_PERSONA_DIR, 'bili-proactive.json');
const BILI_PROACTIVE_LOG_PATH = join(ASTRBOT_PERSONA_DIR, 'bili-proactive.jsonl');
// TTS（5000）也是启停脚本的核心项，控制台补一张只读卡。
const TTS_DIR = 'Y:\\Style-Bert-VITS2-CUDA';
const TTS_LOG_PATH = join(TTS_DIR, 'tts.stdout.log');
// AstrBot 侧链路实况：判定规则、防抖参数、去重/幂等、记忆注入、空@配置都从这些文件现读。
const XZY_CONFIG_PATH = join(ASTRBOT_DATA_DIR, 'xzy', 'xzy-config.json');
const XZY_PLUGIN_DIR = join(ASTRBOT_DATA_DIR, 'plugins', 'xzy');
const ENGINE_SWITCH_LOG = join(ASTRBOT_PERSONA_DIR, 'media', 'state', 'engine-switch.jsonl');
const MIGRATION_SPEC_PATH = join(DSH_ROOT, '.trae', 'specs', 'migrate-qq-to-astrbot', 'spec.md');
const MIGRATION_TOOLS_PATH = join(DSH_ROOT, '.trae', 'specs', 'migrate-qq-to-astrbot', 'evidence', 'tools.md');

/* ------------------------------------------------------------------ 基础工具 */

function safeStat(path) {
    try {
        const st = statSync(path);
        return { exists: true, size: st.size, mtime: st.mtimeMs };
    }
    catch {
        return { exists: false, size: 0, mtime: 0 };
    }
}

/** 只读文件尾部 maxBytes，返回完整行（丢掉被截断的首行）。 */
function readTailText(path, maxBytes = 512 * 1024) {
    const st = safeStat(path);
    if (!st.exists)
        throw new Error('文件不存在: ' + path);
    const start = Math.max(0, st.size - maxBytes);
    const length = st.size - start;
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, 'r');
    try {
        readSync(fd, buffer, 0, length, start);
    }
    finally {
        closeSync(fd);
    }
    let text = buffer.toString('utf8');
    if (start > 0) {
        const nl = text.indexOf('\n');
        text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return { text, bytes: length, truncated: start > 0, size: st.size };
}

function tailLines(path, count) {
    try {
        const { text } = readTailText(path, 256 * 1024);
        const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
        return lines.slice(-count);
    }
    catch {
        return [];
    }
}

function readJsonSafe(path) {
    try {
        // 现场不少配置是 PowerShell 写的，带 UTF-8 BOM；JSON.parse 不认 BOM，先剥掉。
        return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    }
    catch {
        return null;
    }
}

const BILI_MIN_FREE_BYTES = 10 * 1024 ** 3;

// 与 bili.mjs 的 localDay() 同一口径：按 Asia/Shanghai 换天，不用 UTC。
function localDayKey(date = new Date()) {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(date);
}

// 夜间静默：配置在 xzy-config.json 的 night_quiet，拦截/降级记录落 audit/night-quiet.jsonl。
// 「现在是否在窗口内」由这里按配置里的时区现算，前端不自己猜时间。
const NIGHT_QUIET_AUDIT_PATH = join(ASTRBOT_AUDIT_DIR, 'night-quiet.jsonl');

function localClock(timeZone, date = new Date()) {
    // sv-SE 输出 YYYY-MM-DD HH:mm:ss，直接切字段，不做任何时区推断。
    const text = new Intl.DateTimeFormat('sv-SE', {
        timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    }).format(date);
    const [day, time] = text.split(' ');
    return { day: day ?? null, time: time ?? null, hhmm: (time ?? '').slice(0, 5) };
}

function minutesOfClock(hhmm) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? ''));
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

// 跨零点的窗口（23:30–06:00）走「大于等于 start 或小于 end」；start === end 视为不生效。
function insideNightWindow(nowMin, startMin, endMin) {
    if (nowMin === null || startMin === null || endMin === null)
        return null;
    if (startMin === endMin)
        return false;
    return startMin < endMin
        ? nowMin >= startMin && nowMin < endMin
        : nowMin >= startMin || nowMin < endMin;
}

function nightQuietPayload(limit = 20) {
    const cfg = readJsonSafe(XZY_CONFIG_PATH);
    const quiet = cfg !== null && cfg !== undefined ? cfg.night_quiet ?? null : null;
    const zone = quiet?.timezone || 'Asia/Shanghai';
    const clock = localClock(zone);
    const audit = safeStat(NIGHT_QUIET_AUDIT_PATH);
    // 只读尾部：历史行长不限，但只取最近 limit 条，倒序给前端。
    const rows = audit.exists
        ? readJsonlLinesQuiet(NIGHT_QUIET_AUDIT_PATH, Math.max(limit * 5, 200)).slice(-limit).reverse()
        : [];
    return {
        ok: quiet !== null,
        configPath: XZY_CONFIG_PATH,
        found: quiet !== null,
        config: quiet === null ? null : {
            enabled: quiet.enabled === true,
            start: quiet.start ?? null,
            end: quiet.end ?? null,
            timezone: quiet.timezone ?? null,
            longVideoSec: quiet.longVideoSec ?? null,
            auditCooldownSec: quiet.auditCooldownSec ?? null,
        },
        now: {
            localAt: clock.time,
            day: clock.day,
            hhmm: clock.hhmm,
            timezone: zone,
            inWindow: quiet === null
                ? null
                : insideNightWindow(minutesOfClock(clock.hhmm), minutesOfClock(quiet.start), minutesOfClock(quiet.end)),
        },
        source: NIGHT_QUIET_AUDIT_PATH,
        exists: audit.exists,
        mtime: audit.mtime,
        rows,
    };
}

// bili-state.json 有两份记录：history（旧 bili.mjs 写，at 是真 UTC）
// 和 recent（插件 media_bili 写，at 是本地墙钟时间却带 Z 后缀）。
// 两边合并、把 recent 的 at 归一回真 UTC，否则「最近看片」会一直停在旧记录上。
function biliRows(doc, proactive = null) {
    const normalizeAt = row => {
        const raw = String(row?.at ?? '');
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(raw))
            return row;
        const wallClock = new Date(raw.slice(0, 19));
        return Number.isNaN(wallClock.getTime()) ? row : { ...row, at: wallClock.toISOString() };
    };
    const proactiveBvids = new Set();
    if (proactive !== null) {
        if (proactive.lastRun?.bvid)
            proactiveBvids.add(String(proactive.lastRun.bvid));
        for (const bvid of proactive.shareVideoBvids ?? [])
            proactiveBvids.add(String(bvid));
    }
    const merged = new Map();
    const add = row => {
        const bvid = String(row?.bvid ?? '');
        const at = String(row?.at ?? '');
        if (bvid === '')
            return;
        const key = bvid + '|' + Math.round((Date.parse(at) || 0) / 60_000);
        if (merged.has(key))
            return;
        merged.set(key, row.mode === undefined && proactiveBvids.has(bvid) ? { ...row, mode: 'proactive' } : row);
    };
    for (const row of Array.isArray(doc?.history) ? doc.history : [])
        add(row);
    for (const row of Array.isArray(doc?.recent) ? doc.recent : [])
        add(normalizeAt(row));
    return [...merged.values()].sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
}

// 当天统计按合并后的记录算（旧 day/today 字段停更在 11-13，不能再用）。
function biliTodayFromRows(rows) {
    const day = localDayKey();
    const today = rows.filter(row => {
        const at = new Date(row?.at);
        return Number.isFinite(at.getTime()) && localDayKey(at) === day;
    });
    const bytes = today.reduce((total, row) => total + Number(row?.bytes ?? 0), 0);
    const totalMs = today.reduce((total, row) => total + Number(row?.totalMs ?? 0), 0);
    return {
        count: today.length,
        bytes,
        totalMs,
        avgMs: today.length > 0 ? Math.round(totalMs / today.length) : 0,
    };
}

/**
 * 主动刷实况：读 AstrBot 插件的状态文件 + xzy-config 的 bili_proactive。
 * 面板不推测、不运行旧引擎：enabled / 闸门 / 退避 / 上次结果全部取插件落盘值。
 */
function biliProactiveLive() {
    const xzy = readJsonSafe(XZY_CONFIG_PATH) ?? {};
    const bp = xzy.bili_proactive ?? {};
    const state = readJsonSafe(BILI_PROACTIVE_STATE_PATH) ?? {};
    const day = localDayKey();
    const sameDay = String(state.day ?? '') === day;
    const count = sameDay ? Number(state.count ?? 0) : 0;
    const bytes = sameDay ? Number(state.bytes ?? 0) : 0;
    const totalMs = sameDay ? Number(state.totalMs ?? 0) : 0;
    const failStreak = Number(state.failStreak ?? 0) || 0;
    const backoffUntil = String(state.backoffUntil ?? '');
    const backoffAt = Date.parse(backoffUntil);
    const backoffActive = Number.isFinite(backoffAt) && backoffAt > Date.now();
    const lastAbort = state.lastAbort ?? null;
    let backoffSec = Number(state.backoffSec ?? lastAbort?.backoffSec ?? 0) || 0;
    if (backoffSec === 0 && failStreak > 0)
        backoffSec = Math.min(3600, 600 * 2 ** (failStreak - 1));
    const hourly = Array.isArray(state.hourly) ? state.hourly : [];
    const hourAgo = Date.now() - 60 * 60 * 1000;
    const hourlyCount = hourly.filter(at => {
        const ms = Date.parse(String(at));
        return Number.isFinite(ms) && ms > hourAgo;
    }).length;
    const shares = state.shares ?? {};
    const sharesToday = String(shares.day ?? '') === day
        ? Object.values(shares.byChat ?? {}).reduce((sum, n) => sum + (Number(n) || 0), 0)
        : 0;
    const shareVideos = String(shares.day ?? '') === day ? Object.keys(shares.videos ?? {}).length : 0;
    const targets = (Array.isArray(bp.targets) ? bp.targets : []).map(item => {
        const kind = item?.kind === 'private' ? 'private' : 'group';
        const id = String(item?.id ?? '');
        const key = kind + ':' + id;
        const used = String(shares.day ?? '') === day ? Number(shares.byChat?.[key] ?? 0) : 0;
        const perDay = Number(item?.perDay ?? 0) || 0;
        return {
            key,
            name: String(item?.name ?? key),
            perDay,
            used,
            remaining: perDay > 0 ? Math.max(0, perDay - used) : null,
        };
    });
    const lastRun = state.lastRun ?? null;
    const lastAt = lastRun?.at ? Date.parse(lastRun.at) : 0;
    const gapMs = (Number(bp.minGapMinutes ?? 30) || 30) * 60 * 1000;
    return {
        source: 'AstrBot 插件 · ' + BILI_PROACTIVE_STATE_PATH,
        enabled: bp.enabled === true,
        paused: state.paused === true,
        running: false,
        pollSeconds: Number(bp.pollSeconds ?? 60) || 60,
        idleMinutes: Number(bp.idleMinutes ?? 10) || 10,
        minGapMinutes: Number(bp.minGapMinutes ?? 30) || 30,
        maxPerHour: Number(bp.maxPerHour ?? 2) || 2,
        today: { count, bytes, totalMs, avgMs: count > 0 ? Math.round(totalMs / count) : 0 },
        hourly: hourlyCount,
        nextEligibleAt: lastAt ? new Date(lastAt + gapMs).toISOString() : null,
        targets,
        sharesToday,
        shareVideos,
        shareVideoBvids: String(shares.day ?? '') === day ? Object.keys(shares.videos ?? {}) : [],
        failStreak,
        backoffSec,
        backoffUntil: backoffActive ? backoffUntil : '',
        backoffActive,
        lastRun,
        lastAbort,
        lastGate: state.lastGate ?? null,
        lastShare: state.lastShare ?? null,
        lastShareTarget: state.lastShareTarget ?? null,
        statePath: BILI_PROACTIVE_STATE_PATH,
        logPath: BILI_PROACTIVE_LOG_PATH,
        updatedAt: state.updatedAt ?? null,
    };
}

// 与 bili.mjs 的磁盘兜底同一套判定，只读不写。
function biliDiskStatus() {
    const root = join(PERSONA_DIR, 'tmp', 'bili');
    try {
        mkdirSync(root, { recursive: true });
        const info = statfsSync(root);
        const freeBytes = Number(info.bavail) * Number(info.bsize);
        const paused = freeBytes < BILI_MIN_FREE_BYTES;
        return {
            root,
            freeBytes,
            thresholdBytes: BILI_MIN_FREE_BYTES,
            paused,
            reason: paused
                ? '可用 ' + (freeBytes / 1024 ** 3).toFixed(1) + 'GB，低于 '
                    + (BILI_MIN_FREE_BYTES / 1024 ** 3).toFixed(0) + 'GB 阈值，已暂停新的下载'
                : '',
        };
    }
    catch (error) {
        return {
            root,
            freeBytes: null,
            thresholdBytes: BILI_MIN_FREE_BYTES,
            paused: false,
            reason: '磁盘空间检测失败：' + String(error?.message ?? error),
        };
    }
}

function ageText(mtimeMs) {
    if (!mtimeMs)
        return '未知';
    const diff = Date.now() - mtimeMs;
    if (diff < 0)
        return '刚刚';
    const sec = Math.floor(diff / 1000);
    if (sec < 60)
        return sec + ' 秒前';
    const min = Math.floor(sec / 60);
    if (min < 60)
        return min + ' 分钟前';
    const hour = Math.floor(min / 60);
    if (hour < 24)
        return hour + ' 小时前';
    return Math.floor(hour / 24) + ' 天前';
}

function fact(label, value) {
    return { label, value: value === undefined || value === null || value === '' ? '—' : String(value) };
}

// 时长（用于「已挂多久」），和 ageText 的「几分钟前」区分开。
function durationText(ms) {
    const sec = Math.max(0, Math.floor(Number(ms) / 1000));
    if (sec < 60)
        return sec + ' 秒';
    const min = Math.floor(sec / 60);
    if (min < 60)
        return min + ' 分钟';
    const hour = Math.floor(min / 60);
    if (hour < 24)
        return hour + ' 小时 ' + (min % 60) + ' 分';
    return Math.floor(hour / 24) + ' 天 ' + (hour % 24) + ' 小时';
}

// 桌面提醒：独立隐藏 powershell 弹气球，不依赖用户打开面板。
function desktopNotify(title, body) {
    const quote = text => "'" + String(text).replace(/'/g, "''") + "'";
    const script = 'Add-Type -AssemblyName System.Windows.Forms;'
        + 'Add-Type -AssemblyName System.Drawing;'
        + '$n = New-Object System.Windows.Forms.NotifyIcon;'
        + '$n.Icon = [System.Drawing.SystemIcons]::Warning;'
        + '$n.Visible = $true;'
        + '$n.ShowBalloonTip(10000, ' + quote(title) + ', ' + quote(body) + ', [System.Windows.Forms.ToolTipIcon]::Warning);'
        + 'Start-Sleep -Seconds 3; $n.Visible = $false; $n.Dispose()';
    try {
        spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
        }).unref();
    }
    catch {
        // 弹不出来不影响面板
    }
}

function loadHealthState() {
    const state = readJsonSafe(HEALTH_STATE_PATH);
    if (state && typeof state === 'object' && state.components && typeof state.components === 'object')
        return state;
    return { components: {} };
}

function saveHealthState(state) {
    try {
        mkdirSync(dirname(HEALTH_STATE_PATH), { recursive: true });
        writeJsonAtomic(HEALTH_STATE_PATH, state);
    }
    catch {
        // 写不进去只影响「挂了多久」的连续性
    }
}

/**
 * 给每个组件补上 downSince / downForText，并在 monitor 模式下发桌面提醒。
 * monitor=false（页面轮询）只记录时间，不发提醒，避免同一故障被轮询刷出来。
 */
function applyHealthTracking(components, { monitor = false } = {}) {
    const state = loadHealthState();
    const previous = state.components;
    const next = {};
    const now = Date.now();
    for (const comp of components) {
        const record = Object.assign({}, previous[comp.id] ?? {});
        if (comp.state === 'ok' || comp.state === 'disabled') {
            if (record.since) {
                record.recoveredAt = new Date(now).toISOString();
                if (monitor && record.lastAlertAt) {
                    desktopNotify('已恢复：' + comp.label, '累计影响 ' + durationText(now - Date.parse(record.since)));
                }
                record.since = null;
            }
            delete record.lastAlertAt;
            record.lastOkAt = new Date(now).toISOString();
            comp.downSince = null;
            comp.downForText = '';
        }
        else {
            if (!record.since)
                record.since = new Date(now).toISOString();
            const downMs = now - Date.parse(record.since);
            comp.downSince = record.since;
            comp.downForText = durationText(downMs);
            if (comp.state === 'down')
                comp.summary = comp.summary + '（已挂 ' + comp.downForText + '）';
            const lastAlert = record.lastAlertAt ? Date.parse(record.lastAlertAt) : 0;
            if (monitor && HEALTH_CRITICAL.has(comp.id) && comp.state === 'down'
                && downMs >= HEALTH_ALERT_GRACE_MS && now - lastAlert >= HEALTH_ALERT_REPEAT_MS) {
                desktopNotify('组件挂了：' + comp.label, '已挂 ' + comp.downForText + '。' + comp.role);
                record.lastAlertAt = new Date(now).toISOString();
            }
        }
        next[comp.id] = record;
    }
    state.components = next;
    state.updatedAt = new Date(now).toISOString();
    saveHealthState(state);
    return state;
}

function tcpAlive(port, timeoutMs = 800) {
    return new Promise(resolvePromise => {
        const socket = net.connect({ host: '127.0.0.1', port });
        let done = false;
        const finish = ok => {
            if (done)
                return;
            done = true;
            socket.destroy();
            resolvePromise(ok);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
    });
}

async function httpJson(url, timeoutMs = 3000) {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    let data = null;
    try {
        data = JSON.parse(text);
    }
    catch {
        throw new Error('返回内容不是 JSON（HTTP ' + response.status + '）：' + text.slice(0, 120));
    }
    if (!response.ok)
        throw new Error('HTTP ' + response.status);
    return data;
}

function runCommand(command, args, { timeoutMs = 20000, cwd } = {}) {
    return new Promise(resolvePromise => {
        let child;
        try {
            child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        }
        catch (error) {
            resolvePromise({ code: -1, stdout: '', stderr: String(error?.message ?? error), timedOut: false });
            return;
        }
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        const timer = setTimeout(() => {
            timedOut = true;
            try {
                child.kill();
            }
            catch {
                // ignore
            }
        }, timeoutMs);
        const append = (target, chunk) => {
            const next = target + chunk.toString('utf8');
            return next.length > 300000 ? next.slice(-200000) : next;
        };
        child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
        child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
        child.on('error', error => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolvePromise({ code: -1, stdout, stderr: stderr + String(error?.message ?? error), timedOut });
        });
        child.on('close', code => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolvePromise({ code: code ?? -1, stdout, stderr, timedOut });
        });
    });
}

/* -------------------------------------------------------------- 进程与引擎信息 */

let procCache = { at: 0, list: [] };

async function processList() {
    if (Date.now() - procCache.at < 4000)
        return procCache.list;
    const out = await runCommand('tasklist', ['/NH', '/FO', 'CSV'], { timeoutMs: 8000 });
    const list = [];
    for (const line of out.stdout.split(/\r?\n/)) {
        const match = line.match(/^"([^"]+)","(\d+)"/);
        if (match)
            list.push({ name: match[1], pid: Number(match[2]) });
    }
    if (list.length > 0)
        procCache = { at: Date.now(), list };
    return list;
}

let launchCache = { at: 0, value: null };

/** 引擎启动脚本里的 KV/上下文参数（引擎 API 不暴露 KV 类型，只能读启动参数）。 */
function engineLaunchFacts() {
    if (Date.now() - launchCache.at < 30000)
        return launchCache.value;
    let value = null;
    try {
        const text = readFileSync(ENGINE_START_SCRIPT, 'utf8');
        const pick = re => {
            const match = text.match(re);
            return match ? match[1] : null;
        };
        value = {
            kvDtype: pick(/\$KvDtype\s*=\s*"([^"]+)"/),
            kvCapacity: pick(/\$KvCapacity\s*=\s*"?(\d+)"?/),
            maxContext: pick(/\$MaxContext\s*=\s*(\d+)/),
            hostKvMib: pick(/\$HostKvMib\s*=\s*(\d+)/),
            maxConcurrency: pick(/\$MaxConcurrency\s*=\s*(\d+)/),
            spec: pick(/\$Spec\s*=\s*"([^"]+)"/),
            draftTokens: pick(/\$DraftTokens\s*=\s*(\d+)/),
            source: ENGINE_START_SCRIPT,
        };
    }
    catch {
        value = null;
    }
    launchCache = { at: Date.now(), value };
    return value;
}

/** 目录里最新的一个 .log（按 mtime），没有就返回 null。 */
function newestLogIn(dir) {
    let files = [];
    try {
        files = readdirSync(dir)
            .filter(name => name.endsWith('.log'))
            .map(name => ({ name, ...safeStat(join(dir, name)) }))
            .filter(item => item.exists);
    }
    catch {
        return null;
    }
    files.sort((a, b) => b.mtime - a.mtime);
    return files[0] ?? null;
}

/** 插件日志固定读 s0.log；只有它不存在时才回退到目录里最新的 .log。
 *  不能反过来取"目录里最新"：日志轮转后 s0.log.prev 的 mtime 更新，会把旧文件当成当前日志。 */
function newestPluginLog() {
    const fixed = join(PLUGIN_DIR, 'logs', 's0.log');
    const fixedStat = safeStat(fixed);
    if (fixedStat.exists)
        return { name: 's0.log', ...fixedStat };
    return newestLogIn(join(PLUGIN_DIR, 'logs'));
}

/** 组件卡片上的日志入口：label 直接展示路径，id 非空时点一下跳到日志页。 */
function logRef(id, label) {
    return { id: id ?? '', label };
}

function lastLogLine(path) {
    try {
        const { text } = readTailText(path, 128 * 1024);
        const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
        for (let index = lines.length - 1; index >= 0; index -= 1) {
            try {
                return JSON.parse(lines[index]);
            }
            catch {
                // 继续往前找
            }
        }
    }
    catch {
        // ignore
    }
    return null;
}

/* ------------------------------------------- QQ 通道活性（活性证据，不看日志新鲜度） */

/* 判定 qq-onebot 是否健康，用三条活性证据：
 *   1) 宿主进程存活（调用方传入 harnessCount）；
 *   2) 3001 上有 Established 连接（插件确实连着）；
 *   3) get_status 往返 retcode=0 且 data.online=true。
 * 日志新鲜度只做展示：插件只在事件时写 s0.log，夜间静默一小时是正常现象。
 * status 页 10 秒刷一次，get_status 必须缓存 60 秒，避免每次刷新都发 WS 请求。 */
const ONEBOT_WS_URL = process.env.QQ_CONSOLE_ONEBOT_WS ?? 'ws://127.0.0.1:3001';
const ONEBOT_PORT = Number(process.env.QQ_CONSOLE_ONEBOT_PORT ?? 3001);
const LIVENESS_TTL_MS = 60_000;
const LIVENESS_PROBE_TIMEOUT_MS = 1500;

let livenessCache = { at: 0, value: null, pending: null };

/** 通过现成的 OneBot WS 通道问一次 get_status；不依赖 OneBot 协议端 的 HTTP 鉴权。 */
function readOneBotStatus(timeoutMs = LIVENESS_PROBE_TIMEOUT_MS) {
    return new Promise(resolvePromise => {
        let socket;
        let settled = false;
        const finish = value => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            try {
                socket?.close();
            }
            catch {
                // ignore
            }
            resolvePromise(value);
        };
        const timer = setTimeout(() => finish({ ok: false, error: 'get_status 超时（' + timeoutMs + 'ms）' }), timeoutMs);
        try {
            socket = new WebSocket(ONEBOT_WS_URL);
        }
        catch (error) {
            finish({ ok: false, error: 'WS 建立失败：' + (error?.message ?? error) });
            return;
        }
        socket.addEventListener('open', () => {
            try {
                socket.send(JSON.stringify({ action: 'get_status', params: {}, echo: 'console-liveness' }));
            }
            catch (error) {
                finish({ ok: false, error: 'WS 发送失败：' + (error?.message ?? error) });
            }
        });
        socket.addEventListener('message', event => {
            let payload;
            try {
                payload = JSON.parse(String(event.data ?? ''));
            }
            catch {
                return;
            }
            if (payload?.echo !== 'console-liveness')
                return;
            finish({
                ok: true,
                retcode: payload.retcode ?? null,
                online: payload?.data?.online === true,
                good: payload?.data?.good === true,
                serverTime: payload?.data?.time ?? null,
            });
        });
        socket.addEventListener('error', () => finish({ ok: false, error: 'WS 连接错误（OneBot 协议端 可能未运行）' }));
        socket.addEventListener('close', () => finish({ ok: false, error: 'WS 在应答前关闭' }));
    });
}

/** 数一下本机到 OneBot 端口的 Established 连接（netstat 比 PowerShell 轻）。 */
async function establishedTo(port) {
    const { stdout } = await runCommand('netstat', ['-ano', '-p', 'tcp'], { timeoutMs: 5000 });
    const suffix = ':' + port;
    let count = 0;
    for (const line of stdout.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/u);
        if (parts.length < 5 || parts[0] !== 'TCP')
            continue;
        if (!parts[2].endsWith(suffix))
            continue;
        if (parts[3] === 'ESTABLISHED')
            count += 1;
    }
    return count;
}

/** 一次探针 = netstat + get_status，结果缓存 60 秒；并发请求共用同一个 promise。 */
async function qqLiveness(force = false) {
    if (!force && livenessCache.value && Date.now() - livenessCache.at < LIVENESS_TTL_MS)
        return livenessCache.value;
    if (livenessCache.pending)
        return livenessCache.pending;
    livenessCache.pending = (async () => {
        const [established, status] = await Promise.all([
            establishedTo(ONEBOT_PORT).catch(() => 0),
            readOneBotStatus().catch(error => ({ ok: false, error: String(error?.message ?? error) })),
        ]);
        const value = { established, status, at: Date.now() };
        livenessCache = { at: value.at, value, pending: null };
        return value;
    })();
    return livenessCache.pending;
}

/* ---------------------------------------------------------- 可见窗口自检（指标） */

// 结果缓存 15 秒：状态页每 10 秒刷一次，没必要每次都起一个 PowerShell。
let windowCache = { at: 0, value: null };

async function windowCheck(force = false) {
    if (!force && windowCache.value && Date.now() - windowCache.at < 15000)
        return windowCache.value;
    if (!existsSync(WINDOW_CHECK_SCRIPT)) {
        return {
            ok: false,
            error: '找不到窗口自检脚本：' + WINDOW_CHECK_SCRIPT,
            visibleConsoleCount: null,
            violations: [],
            targets: [],
        };
    }
    const result = await runCommand('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WINDOW_CHECK_SCRIPT,
    ], { timeoutMs: 20000 });
    const text = result.stdout.trim();
    const begin = text.indexOf('{');
    let payload = null;
    if (begin >= 0) {
        try {
            payload = JSON.parse(text.slice(begin));
        }
        catch {
            payload = null;
        }
    }
    if (!payload) {
        return {
            ok: false,
            error: '窗口自检没有返回 JSON（退出码 ' + result.code + '）：'
                + (result.stderr.trim() || text).slice(0, 300),
            visibleConsoleCount: null,
            violations: [],
            targets: [],
        };
    }
    windowCache = { at: Date.now(), value: payload };
    return payload;
}

/** 延迟队列积压：低专注时攒起来的群消息，状态页单独展示。 */
function deferSnapshot() {
    const path = join(PERSONA_DIR, 'defer-queue.json');
    const groups = {};
    let totalPending = 0;
    let oldestAgeMs = 0;
    try {
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        const stamp = Date.now();
        for (const [groupId, group] of Object.entries(raw?.groups ?? {})) {
            const items = Array.isArray(group?.items) ? group.items : [];
            if (items.length === 0)
                continue;
            const age = Math.max(0, stamp - Number(items[0]?.at ?? stamp));
            groups[groupId] = { pending: items.length, oldestAgeMs: age };
            totalPending += items.length;
            oldestAgeMs = Math.max(oldestAgeMs, age);
        }
    }
    catch {
        // 没有队列文件就是空。
    }
    return { groups, totalPending, oldestAgeMs };
}

/** 按群攒批的状态：pending 是还没投出去的连发，lastBatch 是最近一次合批。 */
function batchSnapshot() {
    const path = join(PERSONA_DIR, 'inbound-batch.json');
    const empty = { groups: {}, totalPending: 0, oldestWaitMs: 0, lastBatch: null, updatedAt: null };
    try {
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        const groups = {};
        let totalPending = 0;
        let oldestWaitMs = 0;
        for (const [chatId, entry] of Object.entries(raw?.groups ?? {})) {
            const pending = Number(entry?.pending ?? 0);
            if (pending <= 0)
                continue;
            const waitMs = Math.max(0, Number(entry?.waitMs ?? 0));
            groups[chatId] = { pending, waitMs };
            totalPending += pending;
            oldestWaitMs = Math.max(oldestWaitMs, waitMs);
        }
        return {
            groups,
            totalPending,
            oldestWaitMs,
            lastBatch: raw?.lastBatch ?? null,
            updatedAt: raw?.updatedAt ?? null,
        };
    }
    catch {
        // 没有状态文件就是还没攒过批。
        return empty;
    }
}

/** 引擎 /health 探针：只有它才算「能推理」。返回真实状态码，失败不抛。 */
async function engineHealthProbe() {
    const checkedAt = new Date().toISOString();
    try {
        const response = await fetch(ENGINE_HEALTH_URL, { signal: AbortSignal.timeout(2000) });
        let body = null;
        try {
            body = await response.json();
        }
        catch {
            body = null;
        }
        return { ok: response.ok, httpStatus: response.status, status: body?.status ?? null, error: null, checkedAt };
    }
    catch (error) {
        return { ok: false, httpStatus: 0, status: 'unreachable', error: String(error?.message ?? error), checkedAt };
    }
}

/** 引擎自己写下的闩锁证据：最近一条 worker crash 原文（含时间戳）。 */
function engineLatchEvidence() {
    const file = join(ENGINE_LOG_DIR, 'engine.err.log');
    const last = tailLines(file, 4000).filter(line => line.includes(ENGINE_LATCH_MARK)).at(-1) ?? null;
    return last === null ? null : { line: last, log: file };
}

function readTextSafe(path) {
    try {
        return readFileSync(path, 'utf8').trim();
    }
    catch {
        return '';
    }
}

/** 计划任务实况：启停只有脚本；xzy-host-watchdog 是唯一被允许启用的宿主守护任务。缓存 60 秒，避免 10 秒轮询反复起 PowerShell。 */
let scheduledTaskCache = { at: 0, value: null };
async function scheduledTaskFacts() {
    if (scheduledTaskCache.value !== null && Date.now() - scheduledTaskCache.at < 60000)
        return scheduledTaskCache.value;
    let value = null;
    try {
        const script = 'Get-ScheduledTask -TaskName "DSH-Start-AtLogon","DSH Sticker Maintenance","xzy-host-watchdog" -ErrorAction Stop | ForEach-Object { "$($_.TaskName)|$($_.State)|$(($_.Triggers | Measure-Object).Count)" }';
        const result = await runCommand('powershell.exe',
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
            { timeoutMs: 10000 });
        const rows = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
            const [name, state, triggers] = line.split('|');
            return { name, state: state ?? '未知', triggers: Number(triggers) || 0 };
        });
        value = rows.length > 0 ? rows : null;
    }
    catch {
        value = null;
    }
    scheduledTaskCache = { at: Date.now(), value };
    return value;
}

async function componentStatus(options = {}) {
    const [engineHttp, proxyHttp, onebotTcp, comfyTcp, processes, windowReport] = await Promise.all([
        httpJson('http://127.0.0.1:8094/v1/models', 3000).catch(error => ({ __error: error?.message ?? String(error) })),
        httpJson('http://127.0.0.1:1240/health', 2500).catch(error => ({ __error: error?.message ?? String(error) })),
        tcpAlive(3001),
        tcpAlive(8188),
        processList(),
        windowCheck(),
    ]);

    const launch = engineLaunchFacts();
    const harnessCount = processes.filter(item => item.name === 'DeepSeek Harness.exe').length;

    /* 引擎：/v1/models 只说明加载完了，能不能推理要看 /health */
    const enginePort = await tcpAlive(8094);
    const engineModel = Array.isArray(engineHttp?.data) ? engineHttp.data[0] : null;
    const engineLogFile = newestLogIn(ENGINE_LOG_DIR);
    const engineHealth = await engineHealthProbe();
    // 闩锁判定必须同时满足：/health 非 200 + 引擎日志里有那条 worker crash。
    const latchEvidence = engineHealth.httpStatus === 503 ? engineLatchEvidence() : null;
    const latched = latchEvidence !== null;
    const engineState = latched ? 'down'
        : (!engineHealth.ok ? (enginePort ? 'warn' : 'down') : 'ok');
    const engineSummary = latched
        ? '已闩锁：等自愈无效，需重启引擎'
        : (engineHealth.ok
            ? '模型已加载 · /health 200'
            : (enginePort ? '端口在听，但 /health ' + (engineHealth.httpStatus || '不可达') : '未运行'));
    const engine = {
        id: 'engine',
        label: 'ninfer 引擎',
        role: '8094 · OpenAI 兼容推理服务',
        state: engineState,
        summary: engineSummary,
        facts: [
            fact('GET /health', engineHealth.httpStatus === 0
                ? '不可达 · ' + (engineHealth.error ?? '')
                : engineHealth.httpStatus + (engineHealth.status ? ' · ' + engineHealth.status : '')),
            fact('模型', engineModel?.id ?? '—'),
            fact('上下文', engineModel?.context_window ? engineModel.context_window + ' tokens' : '—'),
            fact('KV 类型', launch?.kvDtype ?? '未知'),
            fact('KV 容量', launch?.kvCapacity ? launch.kvCapacity + ' tokens' : '未知'),
            fact('闩锁', latched ? '是（有 worker crash 记录）' : '否'),
            fact('启停口径', '核心项（未就绪 -> 退出码 1）'),
        ],
        detail: latched
            ? '闩锁：' + latchEvidence.line + '。此时 8094 在听、/v1/models 仍 200，但所有 completion 都是 503；'
                + '不会自愈，必须重启引擎（' + ENGINE_CONTROL_SCRIPT + ' -Action restart），面板顶部已给入口。'
            : (engineHealth.ok
                ? '健康检查：' + ENGINE_HEALTH_URL + '（' + engineHealth.checkedAt + '）；模型/上下文来自 /v1/models；KV 类型来自 ' + ENGINE_START_SCRIPT + ' 的默认参数。'
                : '健康检查：' + ENGINE_HEALTH_URL + ' 返回 ' + (engineHealth.httpStatus || '不可达') + '；日志里没有 worker crash 记录。'),
        log: engineLogFile
            ? logRef('engine/' + engineLogFile.name, join(ENGINE_LOG_DIR, engineLogFile.name))
            : logRef('', ENGINE_LOG_DIR),
    };

    /* proxy */
    const proxyPort = await tcpAlive(1240);
    const proxyLogFile = ['proxy.stdout.log', 'proxy.stderr.log', 'proxy.log']
        .map(name => ({ name, ...safeStat(join(PERSONA_DIR, name)) }))
        .filter(item => item.exists)
        .sort((a, b) => b.mtime - a.mtime)[0] ?? null;
    const proxyDegraded = proxyHttp?.__error ? null : (proxyHttp?.degraded === true);
    const proxy = {
        id: 'proxy',
        label: 'persona proxy',
        role: '1240 · /health + /decide · 启停脚本核心项',
        state: proxyPort ? 'ok' : 'down',
        summary: proxyPort
            ? '监听中 · ' + (proxyHttp?.__error ? '/health 查询失败' : '/health 200')
                + (proxyDegraded ? ' · 引擎降级' : '')
            : '未运行',
        facts: [
            fact('状态', proxyPort ? '1240 监听中' : '未运行'),
            fact('健康', !proxyPort ? '未监听' : (proxyHttp?.__error ? '查询失败：' + proxyHttp.__error : 'GET /health 200')),
            fact('上游引擎', !proxyPort || proxyHttp?.__error ? '—'
                : (proxyHttp?.engineHealth?.ok
                    ? '可用 · ' + String(proxyHttp.engineHealth.status ?? 'ok') + ' · ' + String(proxyHttp.model ?? '')
                    : '不可用 · ' + String(proxyHttp?.engineHealth?.httpStatus || '不可达'))),
            fact('降级', proxyDegraded === null ? '—' : (proxyDegraded ? '是（引擎不可用）' : '否')),
            fact('启停口径', '核心项（未就绪 -> 退出码 1）'),
        ],
        detail: proxyPort
            ? 'start-dsh.ps1 把 1240 列为核心项并等待 /health；人格与记忆注入仍由 AstrBot 插件承接，proxy 负责 judge/调度等兼容链路。'
            : '1240 未监听：若刚执行过 start-dsh，这属于核心项失败（退出码 1）。人格与记忆注入本身仍由 AstrBot 承接，不代表人格能力缺失。',
        log: proxyLogFile
            ? logRef('proxy/' + proxyLogFile.name, join(PERSONA_DIR, proxyLogFile.name))
            : logRef('proxy/proxy.stdout.log', join(PERSONA_DIR, 'proxy.stdout.log')),
    };

    /* TTS（5000）：start-dsh 的核心项之一 */
    const ttsTcp = await tcpAlive(5000);
    const ttsLogStat = safeStat(TTS_LOG_PATH);
    const tts = {
        id: 'tts',
        label: 'TTS',
        role: '5000 · 语音合成 · 启停脚本核心项',
        state: ttsTcp ? 'ok' : 'down',
        summary: ttsTcp ? '端口 5000 监听中' : '未运行',
        facts: [
            fact('端口 5000', ttsTcp ? '监听中' : '未监听'),
            fact('启停口径', '核心项（未就绪 -> 退出码 1）'),
            fact('日志', ttsLogStat.exists ? new Date(ttsLogStat.mtime).toISOString() : '未找到 tts.stdout.log'),
        ],
        detail: '由 start-dsh.ps1 在引擎之后拉起，并等待 5000 监听；未就绪算核心项失败。仅探测端口存活，未做语音合成试听。',
        log: logRef('tts/tts.stdout.log', TTS_LOG_PATH),
    };

    /* OneBot 协议端 */
    const onebotLogFile = newestLogIn(ONEBOT_LOG_DIR);
    const onebot = {
        id: 'onebot',
        label: 'OneBot 协议端',
        role: '3001 · OneBot 11 WebSocket',
        state: onebotTcp ? 'ok' : 'down',
        summary: onebotTcp ? 'WS 端口监听中' : '未运行',
        facts: [
            fact('OneBot WS', 'ws://127.0.0.1:3001'),
            fact('端口', onebotTcp ? '监听' : '未监听'),
            fact('启停口径', '外部依赖（需自行启动；未就绪不影响退出码）'),
        ],
        detail: onebotTcp ? '仅探测端口存活，未做协议握手。' : '请先自行启动你的 OneBot 11 协议端（需提供 3000/3001）。',
        log: onebotLogFile
            ? logRef('onebot/' + onebotLogFile.name, join(ONEBOT_LOG_DIR, onebotLogFile.name))
            : logRef('script/onebot.out.log', ONEBOT_OUT_LOG),
    };

    /* Harness */
    const harnessWatch = readJsonSafe(HARNESS_WATCHDOG_STATE) ?? {};
    const watchMode = String(harnessWatch.mode ?? '');
    const watchModeText = {
        running: '守护中',
        down: '宿主已退出，等待拉起',
        backoff: '退避中，稍后重启',
        'crash-loop': '崩溃循环，已停止重启',
        cooldown: '冷却中（崩溃循环，到点自动探测拉起）',
        'cooldown-relaunch': '冷却结束，正在探测拉起',
        stopped: '冷却重启达上限，等待人工拉起',
        paused: '已停机（stop-dsh）',
        misconfigured: '守护配置错误',
    }[watchMode] ?? (watchMode === '' ? '守护未启动' : watchMode);
    const lastExit = harnessWatch.lastExit ?? null;
    const harnessDown = harnessCount === 0;
    const harness = {
        id: 'harness',
        label: 'DeepSeek Harness',
        role: 'dsh-onebot 宿主 · 由 harness-watchdog 看守',
        state: harnessDown ? 'down' : 'ok',
        summary: harnessDown
            ? (watchMode === 'stopped' ? '未运行 · 冷却重启达上限，等待人工拉起'
                : watchMode === 'cooldown' ? '未运行 · 崩溃循环冷却中，到点自动探测拉起'
                    : '未运行')
            : '运行中（' + harnessCount + ' 进程）',
        facts: [
            fact('进程数', harnessCount),
            fact('守护', watchModeText),
            fact('自动重启', String(harnessWatch.restarts ?? 0) + ' 次'),
            fact('10 分钟内异常退出', String(harnessWatch.crashesInWindow ?? 0) + ' 次（上限 ' + (harnessWatch.maxRestart ?? 3) + '）'),
            fact('最近退出', lastExit
                ? lastExit.text + ' · 存活 ' + lastExit.livedSec + ' 秒 · ' + lastExit.at
                : '本次启动后未记录'),
            fact('启停口径', '警告项（宿主未出现不影响退出码；插件 WS 未连同样只记警告）'),
        ],
        detail: [
            harnessDown ? '宿主不在时插件不工作：网页本身仍可用，但收不到 QQ 消息。' : '',
            watchMode === 'crash-loop' ? '已停止自动重启，先看 harness.watchdog.log 里的退出码，处理完手动启动宿主即可解除限制。' : '',
            watchMode === 'cooldown' ? ('崩溃循环进入冷却：' + String(harnessWatch.cooldownUntil ?? '稍后') + ' 自动探测拉起一次（已尝试 ' + String(harnessWatch.cooldownRounds ?? 0) + '/6）；守护本身仍在运行，不是死了。') : '',
            watchMode === 'stopped' ? '冷却重启已达上限，停止自动拉起；手动启动宿主即可解除。' : '',
            lastExit?.stderrTail ? '最近 stderr：' + String(lastExit.stderrTail).slice(0, 300) : '',
        ].filter(Boolean).join(' '),
        log: logRef('harness/watchdog.log', HARNESS_WATCHDOG_LOG),
    };

    /* ComfyUI（8188，常驻出图服务，由 harness-watchdog 看守） */
    const comfyWatch = readJsonSafe(COMFY_WATCHDOG_STATE) ?? {};
    // 状态文件读不到 ≠ 守护没跑：区分「文件缺失（未核实）」和「文件写明没启动」。
    const comfyWatchReadable = safeStat(COMFY_WATCHDOG_STATE).exists;
    const comfyMode = String(comfyWatch.mode ?? '');
    const comfyModeText = {
        running: '守护中',
        starting: '启动中（等待监听）',
        hung: '进程在但端口未监听（启动卡死）',
        down: '已掉线，等待拉起',
        backoff: '退避中，稍后重启',
        cooldown: '崩溃循环，冷却中',
    }[comfyMode] ?? (comfyWatchReadable ? (comfyMode === '' ? '状态文件无 mode 字段' : comfyMode) : '未核实（状态文件不存在）');
    const comfyLastExit = comfyWatch.lastExit ?? null;
    const comfy = {
        id: 'comfyui',
        label: 'ComfyUI',
        role: '8188 · 本地出图服务 · 由 harness-watchdog 看守',
        state: comfyTcp ? 'ok' : 'down',
        summary: comfyTcp
            ? '监听中'
            : (comfyMode === 'starting' ? '启动中，尚未监听'
                : comfyMode === 'hung' ? '进程在但端口未监听（启动卡死）'
                    : comfyMode === 'backoff' || comfyMode === 'cooldown' ? '未运行 · ' + comfyModeText
                        : '未运行'),
        facts: [
            fact('端口 8188', comfyTcp ? '监听中' : '未监听'),
            fact('守护', comfyModeText),
            fact('自动重启', comfyWatchReadable ? String(comfyWatch.restarts ?? 0) + ' 次' : '未核实（状态文件不存在）'),
            fact('当前 pid', comfyWatchReadable ? (String(comfyWatch.pid ?? '') || '未记录') : '未核实（状态文件不存在）'),
            fact('最近退出', comfyLastExit
                ? String(comfyLastExit.text ?? '') + ' · pid ' + String(comfyLastExit.pid ?? '—')
                    + ' · 存活 ' + String(comfyLastExit.livedSec ?? '—') + ' 秒 · ' + String(comfyLastExit.at ?? '')
                : (comfyWatchReadable ? '本次启动后未记录' : '未核实（状态文件不存在）')),
            fact('启停口径', '警告项（8188 未就绪不影响退出码）'),
        ],
        detail: comfyTcp
            ? '出图链路：qq_draw → moss-gen → 127.0.0.1:8188（/prompt、/history、/free）。常驻，出图后只卸显存不关进程。'
            : 'ComfyUI 不在时 qq_draw 会先请求 proxy 拉起（ensureComfy 最多等 90 秒，见 proxy.mjs），失败则报错；不会静默丢图。',
        log: logRef('comfyui/comfyui.err.log', join(PERSONA_DIR, 'comfyui.err.log')),
    };

    /* 新插件 */
    const cfg = loadConfigFile(CONFIG_PATH);
    const cfgMtime = safeStat(CONFIG_PATH).mtime;
    const logFile = newestPluginLog();
    const lastLine = logFile ? lastLogLine(join(PLUGIN_DIR, 'logs', logFile.name)) : null;
    const lastTs = lastLine?.ts ? Date.parse(lastLine.ts) : 0;
    // 会话映射只认真实链路（插件媒体目录）；插件 state 下那份停在 11-11，不再展示。
    const sessionsRaw = readJsonSafe(MEDIA_SESSIONS_PATH);
    const sessionsOk = sessionsRaw !== null && typeof sessionsRaw === 'object';
    const sessionCount = sessionsOk ? Object.keys(sessionsRaw.chats ?? sessionsRaw).length : 0;
    const sessionsMtime = safeStat(MEDIA_SESSIONS_PATH).mtime;
    // 活性证据（宿主进程 / Established 连接 / get_status），结果缓存 60 秒。
    const liveness = await qqLiveness();
    const oneBot = liveness.status;
    const oneBotOk = oneBot.ok === true && oneBot.retcode === 0 && oneBot.online === true;
    const liveFails = [];
    if (harnessCount === 0)
        liveFails.push('宿主进程未运行');
    if (!(liveness.established > 0))
        liveFails.push('127.0.0.1:' + ONEBOT_PORT + ' 无 Established 连接');
    if (!oneBotOk)
        liveFails.push(oneBot.ok
            ? 'get_status retcode=' + String(oneBot.retcode) + ' · online=' + String(oneBot.online)
            : 'get_status 失败：' + (oneBot.error ?? '未知错误'));
    const pluginAlive = liveFails.length === 0;
    const pluginState = harnessCount === 0 ? 'down' : (pluginAlive ? 'ok' : 'warn');
    const plugin = {
        id: 'plugin',
        label: 'qq-onebot 插件',
        role: '自研 OneBot 通道 · 影子模式',
        state: pluginState,
        summary: pluginState === 'down'
            ? '宿主未运行'
            : (pluginAlive ? '影子判定中 · OneBot 在线' : '活性证据不足：' + liveFails.join('；')),
        facts: [
            fact('模型', cfg.config?.runtime?.model ?? cfg.raw?.runtime?.model ?? '—'),
            fact('上下文', cfg.config
                ? cfg.config.default.context.budgetTokens + ' tokens / ' + cfg.config.default.context.maxMessages + ' 条'
                : '—'),
            fact('KV 类型', launch?.kvDtype ?? '未知'),
            fact('OneBot 连接', liveness.established + ' 条 Established'),
            fact('get_status', oneBotOk ? 'online=true · retcode=0' : (oneBot.ok ? 'retcode=' + String(oneBot.retcode) + ' · online=' + String(oneBot.online) : '失败')),
            fact('探测缓存', ageText(liveness.at) + '（60 秒有效）'),
            fact('最后一条日志', ageText(lastTs || logFile?.mtime) + '（仅展示）'),
            fact('影子', cfg.config
                ? (cfg.config.shadow.enabled ? '开' : '关') + (cfg.config.shadow.dryRunModel ? ' · 只判定不发送' : ' · 允许模型回合')
                : '—'),
            fact('会话映射', sessionsOk ? sessionCount + ' 个 chat' : '未知（读不到 ' + MEDIA_SESSIONS_PATH + '）'),
            fact('会话来源', MEDIA_SESSIONS_PATH),
            fact('会话文件写入', sessionsOk ? ageText(sessionsMtime) : '未知'),
            fact('启停口径', '非启停核心项（旧栈影子，不影响退出码）'),
            fact('配置', cfg.ok ? '有效 · ' + ageText(cfgMtime) : '校验失败'),
        ],
        detail: (logFile ? '日志：' + logFile.name + ' · 最后写入 ' + ageText(lastTs || logFile.mtime) + '（插件只在事件时写日志，空闲不影响判定）' : '未找到插件日志')
            + (liveFails.length > 0 ? '；不满足：' + liveFails.join('；') : '')
            + '；判定依据：宿主进程 + 3001 Established + get_status(online/retcode)，日志新鲜度不参与 state。'
            + (cfg.ok ? '' : '；配置错误：' + cfg.errors.join('；')),
        log: logFile
            ? logRef('plugin/' + logFile.name, join(PLUGIN_DIR, 'logs', logFile.name))
            : logRef('', join(PLUGIN_DIR, 'logs')),
    };

    /* 安全事件：陌生 ID / 机器人尝试主人级操作 */
    const securityFile = join(PLUGIN_DIR, 'logs', 'security.jsonl');
    let securityEvents = [];
    try {
        const { text } = readTailText(securityFile, 64 * 1024);
        securityEvents = text.split(/\r?\n/)
            .filter(line => line.trim() !== '')
            .map(line => {
                try {
                    return JSON.parse(line);
                }
                catch {
                    return null;
                }
            })
            .filter(item => item !== null)
            .slice(-200)
            .reverse();
    }
    catch {
        securityEvents = [];
    }
    // 失效规则一（配置已修）：bot-master-command 来自 bot.knownBots 的成员判断，
    // 该 QQ 已不在名单里说明配置已改对，这条只是留档。
    // 失效规则二：sceneKey 对应的群已经不在配置里，记录同样算历史残留。
    const securityConfig = readJsonSafe(CONFIG_PATH) ?? {};
    const configuredBots = new Set((securityConfig.bot?.knownBots ?? []).map(String));
    // 群白名单现在只认真实链路（cordis.patch.yml），这里一并算进去，避免把生效中的群判成历史残留。
    const realGroupAccess = groupAccessPayload();
    const configuredGroups = new Set([
        ...Object.keys(securityConfig.groups ?? {}),
        ...(securityConfig.access?.allowGroups ?? []).map(String),
        ...(realGroupAccess.ok ? realGroupAccess.groups : []).map(String),
    ]);
    const sceneGroupId = event => {
        const match = /^group:(\d+)$/.exec(String(event?.sceneKey ?? ''));
        return match ? match[1] : null;
    };
    const isStaleSecurityEvent = event => {
        if (event?.kind === 'bot-master-command' && !configuredBots.has(String(event.sender ?? '')))
            return true;
        const groupId = sceneGroupId(event);
        return groupId !== null && configuredGroups.size > 0 && !configuredGroups.has(groupId);
    };
    const activeSecurityEvents = securityEvents.filter(event => !isStaleSecurityEvent(event));
    const staleSecurityCount = securityEvents.length - activeSecurityEvents.length;

    // 越权尝试被拦下 = 安全控制正常生效，属于 info，不参与健康度。
    // 只有短时间内高频尝试才升级为 warn（有人在试探）：同一 sender 10 分钟 ≥5 次，或全系统 10 分钟 ≥20 次。
    const COMMAND_KINDS = new Set(['bot-master-command', 'unknown-master-command', 'admin-master-command']);
    const ESCALATE_WINDOW_MS = 10 * 60 * 1000;
    const PER_SENDER_LIMIT = 5;
    const GLOBAL_LIMIT = 20;
    const INFO_WINDOW_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const blockedEvents = activeSecurityEvents.filter(event => COMMAND_KINDS.has(event.kind));
    const infoCount = blockedEvents.filter(event => {
        const at = Date.parse(event.ts ?? '');
        return Number.isFinite(at) && now - at < INFO_WINDOW_MS;
    }).length;
    const recentBlocked = blockedEvents.filter(event => {
        const at = Date.parse(event.ts ?? '');
        return Number.isFinite(at) && now - at < ESCALATE_WINDOW_MS;
    });
    const perSender = new Map();
    for (const event of recentBlocked) {
        const key = String(event.sender ?? '');
        perSender.set(key, (perSender.get(key) ?? 0) + 1);
    }
    const hotSender = [...perSender.entries()].find(([, count]) => count >= PER_SENDER_LIMIT) ?? null;
    const escalated = recentBlocked.length >= GLOBAL_LIMIT || hotSender !== null;

    const latestSecurity = activeSecurityEvents[0] ?? null;
    const security = {
        id: 'security',
        label: '安全事件',
        role: '越权尝试的拦截记录（拦下即正常，不计故障）',
        state: escalated ? 'warn' : 'ok',
        summary: escalated
            ? '10 分钟内越权尝试 ' + recentBlocked.length + ' 次'
                + (hotSender ? '（' + hotSender[0] + ' 连续 ' + hotSender[1] + ' 次）' : '')
                + '，疑似有人在试探'
            : latestSecurity === null
                ? (staleSecurityCount > 0
                    ? '最近 ' + staleSecurityCount + ' 条记录对应的配置已移除，不再告警（记录仍保留）'
                    : '无陌生账号尝试主人级操作')
                : '最近一条：' + (latestSecurity.kind ?? 'unknown') + ' · ' + (latestSecurity.sender ?? '—')
                    + '（已拦下，仅记 info）',
        facts: [
            fact('最近事件', latestSecurity?.ts ?? '—'),
            fact('来源', latestSecurity
                ? (latestSecurity.sender ?? '—') + ' / ' + (latestSecurity.role ?? '—')
                : '—'),
            fact('近 24h 拦下', infoCount + ' 次'),
            fact('近 10 分钟', recentBlocked.length + ' 次（升级阈值 单人 5 / 全局 20）'),
            fact('已失效（配置已修）', staleSecurityCount + ' 条'),
        ],
        detail: latestSecurity
            ? String(latestSecurity.detail ?? '') + '（完整记录见 security.jsonl）'
            : '陌生 ID 或机器人账号尝试 /撤回 等主人级操作会被拦下并记一条 info；只有短时间内高频尝试才升级为 warn。',
        log: safeStat(securityFile).exists
            ? logRef('plugin/security.jsonl', securityFile)
            : logRef('', join(PLUGIN_DIR, 'logs')),
    };

    /* 出图审图：读 draw-review.jsonl 尾部，只展示最近几次结论 */
    const drawReviewPath = join(ASTRBOT_PERSONA_DIR, 'draw-review.jsonl');
    const drawReviewRows = tailLines(drawReviewPath, 8)
        .map(line => {
            try {
                return JSON.parse(line);
            }
            catch {
                return null;
            }
        })
        .filter(row => row !== null && row.event !== 'summary');
    const latestDraw = drawReviewRows[drawReviewRows.length - 1] ?? null;
    const drawLabel = row => row.decision === 'pass' ? '通过'
        : row.decision === 'pass-timeout' ? '超时放行'
            : '拦下';
    // 「拦下」是审图的正常工作结果（模型真判了不合格），只算 info，不拉低健康度。
    // 真正要拉红的是审图自身没跑成功：请求失败、超时放行，或连续多张被拦
    // （连续拦更像是提示词或出图链路出了问题）。判定依据：正常判定一定会带分数。
    const drawFailed = row => row.decision !== 'pass'
        && (row.decision === 'pass-timeout' || typeof row.score !== 'number');
    const drawFresh = row => {
        const at = Date.parse(String(row?.at ?? ''));
        return Number.isFinite(at) && (Date.now() - at) < 10 * 60 * 1000;
    };
    const consecutiveBlocks = (() => {
        let n = 0;
        for (let i = drawReviewRows.length - 1; i >= 0; i -= 1) {
            if (drawReviewRows[i].decision === 'pass') break;
            n += 1;
        }
        return n;
    })();
    const drawState = latestDraw === null ? 'ok'
        // 只认「最近 10 分钟内」的异常：一张旧图的失败不该让健康度永久变红。
        : ((drawFailed(latestDraw) || consecutiveBlocks >= 3) && drawFresh(latestDraw)) ? 'warn' : 'ok';
    const drawReason = row => (typeof row.reason === 'string' && row.reason !== '') ? ' · ' + row.reason : '';
    const drawReview = {
        id: 'draw-review',
        label: '出图审图',
        role: 'draw-review.jsonl · 单通道异步审图',
        state: drawState,
        summary: latestDraw === null
            ? '还没有审图记录'
            : drawLabel(latestDraw) + (latestDraw.score === undefined ? '' : ' · ' + latestDraw.score + ' 分')
                + (latestDraw.reviewMs === undefined ? '' : ' · ' + latestDraw.reviewMs + 'ms')
                + drawReason(latestDraw),
        facts: drawReviewRows.slice(-3).reverse().map(row => fact(
            '#' + row.id + ' · 第' + row.attempt + ' 次',
            drawLabel(row) + (row.score === undefined ? '' : ' · ' + row.score + ' 分')
                + (row.reviewMs === undefined ? '' : ' · ' + row.reviewMs + 'ms')
                + (Array.isArray(row.defects) && row.defects.length > 0 ? ' · ' + row.defects.join('；') : '')
                + drawReason(row),
        )),
        detail: latestDraw === null
            ? 'ComfyUI 出图后先落在本地，审图通过才发送；只有超时降级放行，模型报错或重画一次仍不过都丢弃。'
            : (latestDraw.path ? '最近：' + latestDraw.path : '')
                + '（拦下属设计内结果，只记 info 不计故障；审图请求失败/超时或连续 3 张拦下才算 warn。完整记录见 draw-review.jsonl）',
        log: safeStat(drawReviewPath).exists
            ? logRef('draw/draw-review.jsonl', drawReviewPath)
            : logRef('', drawReviewPath),
    };

    /* B 站 */
    const biliStatePath = join(ASTRBOT_PERSONA_DIR, 'bili-state.json');
    const biliDoc = readJsonSafe(biliStatePath) ?? {};
    // 主动刷状态以 AstrBot 插件落盘为准（旧 Node 状态文件已废弃，不再读）。
    const biliProactive = biliProactiveLive();
    const biliHistory = biliRows(biliDoc, biliProactive);
    const biliLatest = biliHistory.at(-1) ?? null;
    const biliToday = biliTodayFromRows(biliHistory);
    const biliDisk = biliDiskStatus();
    const biliAccount = readJsonSafe(join(PERSONA_DIR, 'bili-account.json'));
    const biliAccountText = biliAccount === null || typeof biliAccount !== 'object'
        ? '未绑定（匿名 720p）'
        : (biliAccount.status === 'ok'
            ? String(biliAccount.uname || '已绑定') + ' · mid ' + String(biliAccount.mid ?? '—')
            : 'SESSDATA 已失效（已降级）');
    const biliBackoffMinutes = biliProactive.backoffActive
        ? Math.max(1, Math.ceil((Date.parse(biliProactive.backoffUntil) - Date.now()) / 60_000))
        : 0;
    const biliProactiveText = !biliProactive.enabled
        ? '已关闭（bili_proactive.enabled=false）'
        : biliProactive.paused
            ? '已暂停（状态文件 paused=true）'
            : biliProactive.backoffActive
                ? '退避中 · 剩 ' + biliBackoffMinutes + ' 分钟（连续失败 ' + biliProactive.failStreak + ' 次）'
                : '已开启 · 今日 ' + biliProactive.today.count + ' 条 · 这一小时 '
                    + biliProactive.hourly + '/' + biliProactive.maxPerHour;
    const biliProactiveLast = biliProactive.lastRun
        ? new Date(biliProactive.lastRun.at).toLocaleTimeString('zh-CN', { hour12: false })
            + ' · ' + String(biliProactive.lastRun.bvid ?? '—')
            + ' · ' + Number(biliProactive.lastRun.frames ?? 0) + ' 帧 · '
            + (Number(biliProactive.lastRun.totalMs ?? 0) / 1000).toFixed(1) + 's'
        : '还没有记录';
    const biliProactiveResult = biliProactive.lastShare?.ok === true
        ? '已分享 ' + String(biliProactive.lastShare.target ?? '—')
            + ' · ' + String(biliProactive.lastShare.text ?? '').length + ' 字'
        : biliProactive.lastAbort
            ? '中止：' + String(biliProactive.lastAbort.reason ?? '—')
            : biliProactive.lastGate
                ? '待闸门：' + String(biliProactive.lastGate.reason ?? '—')
                : '还没有记录';
    const bili = {
        id: 'bili',
        label: 'B 站',
        role: 'bili.mjs · 关键帧基线 + 可疑 GOP 场景兜底',
        state: biliDisk.paused || (biliAccount !== null && typeof biliAccount === 'object' && biliAccount.status !== 'ok') ? 'warn' : 'ok',
        summary: biliLatest === null
            ? '还没刷过'
            : '最近：' + String(biliLatest.title ?? biliLatest.bvid ?? '—')
                + ' · ' + (biliLatest.frames ?? 0) + ' 帧 / 救回 ' + (biliLatest.rescued ?? 0),
        facts: [
            fact('今日已看', biliToday.count + ' 条'),
            fact('今日流量', (biliToday.bytes / 1024 / 1024).toFixed(0) + 'MB'),
            fact('平均耗时', biliToday.avgMs > 0 ? (biliToday.avgMs / 1000).toFixed(1) + 's' : '—'),
            fact('主动刷', biliProactiveText),
            fact('上次主动刷', biliProactiveLast),
            fact('上次结果', biliProactiveResult),
            fact('磁盘兜底', biliDisk.freeBytes === null
                ? '检测失败'
                : (biliDisk.paused ? '暂停（剩 ' : '正常（剩 ') + (biliDisk.freeBytes / 1024 ** 3).toFixed(1) + 'GB）'),
            fact('累计记录', biliHistory.length + ' 条'),
            fact('账号', biliAccountText),
            ...biliHistory.slice(-2).reverse().map(row => fact(
                String(row.bvid ?? '—'),
                String(row.title ?? '') + ' · ' + (row.frames ?? 0) + ' 帧'
                    + (row.rescued > 0 ? ' · 救回 ' + row.rescued : '')
                    + (row.totalMs === undefined ? '' : ' · ' + Math.round(Number(row.totalMs) / 1000) + 's'),
            )),
        ],
        detail: '单视频 ≤300MB / 20 分钟；临时视频与未入选帧用完即删，'
            + '入选帧由视觉打标后删除。工作盘可用低于 10GB 时暂停新下载，恢复后自动继续。'
            + '主动刷一次只刷 1 条（720p / ≤12 帧），间隔 ≥30 分钟、每小时 ≤2 条，'
            + '有真实对话或 GPU 被占用立即让路。当天条数 / 流量 / 平均耗时见「B 站」页顶部。',
        log: logRef('persona/bili-state.json', biliStatePath),
    };

    /* 调度任务：7 个任务的 runs / lastOk / lastError 全部来自 scheduler-state.json */
    const schedulerState = readJsonSafe(SCHEDULER_STATE_PATH) ?? {};
    const schedulerRows = SCHEDULER_TASKS.map(name => {
        const row = schedulerState.tasks?.[name] ?? null;
        return {
            name,
            runs: Number.isFinite(row?.runs) ? row.runs : null,
            lastOk: typeof row?.lastOk === 'boolean' ? row.lastOk : null,
            lastRunAtMs: Number.isFinite(row?.lastRunAtMs) ? row.lastRunAtMs : null,
            lastMs: Number.isFinite(row?.lastMs) ? row.lastMs : null,
            lastError: typeof row?.lastError === 'string' && row.lastError !== '' ? row.lastError : null,
        };
    });
    const schedulerMissing = schedulerRows.filter(item => item.runs === null).map(item => item.name);
    const schedulerFailing = schedulerRows.filter(item => item.lastOk === false).map(item => item.name);
    const schedulerProxyDown = !proxyPort;
    const scheduler = {
        id: 'scheduler',
        label: '调度任务',
        role: 'proxy 进程内调度 · ' + SCHEDULER_TASKS.length + ' 个任务',
        state: schedulerProxyDown ? 'warn'
            : (schedulerMissing.length === SCHEDULER_TASKS.length ? 'down'
                : (schedulerFailing.length > 0 || schedulerMissing.length > 0 ? 'warn' : 'ok')),
        summary: schedulerProxyDown
            ? 'proxy 1240 未监听：调度不在运行（下列为上次记录）'
            : (schedulerMissing.length === SCHEDULER_TASKS.length
                ? '读不到 ' + SCHEDULER_STATE_PATH
                : (schedulerFailing.length > 0
                    ? '有任务上次失败：' + schedulerFailing.join('、')
                    : (schedulerMissing.length > 0 ? '缺 ' + schedulerMissing.length + ' 个任务的记录' : SCHEDULER_TASKS.length + ' 个任务均有记录'))),
        facts: [
            fact('依赖', 'persona proxy 1240（启停核心项 · ' + (schedulerProxyDown ? '未监听' : '监听中') + '）'),
            ...schedulerRows.map(item => fact(item.name, item.runs === null
                ? '无记录'
                : (item.runs + ' 次 · 上次' + (item.lastOk === false ? '失败' : '成功')
                    + (item.lastRunAtMs ? ' · ' + ageText(item.lastRunAtMs) : '')
                    + (item.lastMs !== null ? ' · ' + item.lastMs + 'ms' : '')
                    + (item.lastError ? ' · ' + item.lastError : '')))),
        ],
        detail: '数据源：' + SCHEDULER_STATE_PATH + '（lastTickAt=' + (schedulerState.lastTickAt ?? '未知')
            + '）。任务由 proxy 单调度器派发，页面只读状态文件，不主动触发。'
            + (schedulerProxyDown ? ' 当前 1240 未监听，调度不会执行；上面的任务是上次落盘记录。' : ''),
        log: logRef('state/scheduler-state.json', SCHEDULER_STATE_PATH),
    };

    /* 守护：两个独立 PowerShell 守护，pid 取自各自的 pid 文件，模式/退避取自状态文件 */
    const engineWdPid = Number(readTextSafe(ENGINE_WATCHDOG_PID)) || null;
    const engineWdAlive = engineWdPid !== null && processes.some(item => Number(item.pid) === engineWdPid);
    const engineWdState = readJsonSafe(ENGINE_WATCHDOG_STATE) ?? {};
    const engineWdMode = String(engineWdState.mode ?? '');
    const engineWatchdog = {
        id: 'watchdog-engine',
        label: '引擎守护',
        role: 'engine-restore-watchdog.ps1',
        state: engineWdPid === null ? 'down' : (engineWdAlive ? (engineWdMode === 'backoff' ? 'warn' : 'ok') : 'down'),
        summary: engineWdPid === null
            ? '未见 pid 文件'
            : (engineWdAlive
                ? ('运行中 · ' + (engineWdMode || '状态未上报'))
                : ('pid ' + engineWdPid + ' 已不存在（守护未运行）')),
        facts: [
            fact('pid', engineWdPid === null ? '未知' : String(engineWdPid) + (engineWdAlive ? ' · 存活' : ' · 已退出')),
            fact('模式', engineWdMode || '未知'),
            fact('连续失败', engineWdState.healthFails === undefined ? '未知' : engineWdState.healthFails + ' / ' + (engineWdState.threshold ?? '未知')),
            fact('退避', engineWdState.backoffSec === undefined ? '未知' : '当前 ' + engineWdState.backoffSec + 's'),
            fact('下次允许重启', engineWdState.nextRestartAt ?? '未在退避'),
            fact('状态写入', engineWdState.updatedAt ? ageText(Date.parse(engineWdState.updatedAt)) : '未知'),
        ],
        detail: '阈值 12 次 / 5 秒一次（60 秒）才重启，退避 120s 起 ×2 封顶 900s；触发走 ' + ENGINE_CONTROL_SCRIPT + ' -Action restart。状态文件：' + ENGINE_WATCHDOG_STATE,
        log: logRef('engine/watchdog.log', ENGINE_WATCHDOG_LOG),
    };
    const harnessWdPid = Number(readTextSafe(HARNESS_WATCHDOG_PID)) || null;
    const harnessWdAlive = harnessWdPid !== null && processes.some(item => Number(item.pid) === harnessWdPid);
    const harnessWdState = readJsonSafe(HARNESS_WATCHDOG_STATE) ?? {};
    const harnessWdBackoff = harnessWdState.backoffUntil ?? null;
    const harnessWatchdog = {
        id: 'watchdog-harness',
        label: '宿主守护',
        role: 'harness-watchdog.ps1',
        state: harnessWdPid === null ? 'down' : (harnessWdAlive ? 'ok' : 'down'),
        summary: harnessWdPid === null
            ? '未见 pid 文件'
            : (harnessWdAlive ? ('运行中 · ' + String(harnessWdState.mode ?? '未知')) : ('pid ' + harnessWdPid + ' 已不存在（守护未运行）')),
        facts: [
            fact('pid', harnessWdPid === null ? '未知' : String(harnessWdPid) + (harnessWdAlive ? ' · 存活' : ' · 已退出')),
            fact('模式', String(harnessWdState.mode ?? '未知')),
            fact('看守对象', harnessWdState.pid ? '宿主 pid ' + harnessWdState.pid : '未知'),
            fact('退避截止', harnessWdBackoff === null
                ? '未在退避'
                : (Date.parse(harnessWdBackoff) > Date.now() ? harnessWdBackoff : '未在退避（上次 ' + harnessWdBackoff + '）')),
            fact('监视自', harnessWdState.since ? ageText(Date.parse(harnessWdState.since)) : '未知'),
        ],
        detail: '数据源：' + HARNESS_WATCHDOG_STATE + ' 与 harness.watchdog.pid；页面只读，不参与重启决策。',
        log: logRef('harness/harness.watchdog.log', HARNESS_WATCHDOG_LOG),
    };

    const components = [engine, tts, proxy, onebot, comfy, harness, plugin, scheduler, engineWatchdog, harnessWatchdog, security, drawReview, bili];
    // 「挂了多久」记录下来，monitor 模式（后台定时器）才会弹桌面提醒。
    applyHealthTracking(components, options);
    const bad = components.filter(item => item.state === 'down').length;
    const warn = components.filter(item => item.state === 'warn').length;
    const visibleConsoleCount = Number.isInteger(windowReport?.visibleConsoleCount)
        ? windowReport.visibleConsoleCount
        : null;
    return {
        // ok 只表示「这次请求成功返回」，健康度看 healthy / counts。
        // 组件告警是页面正文要展示的内容，不能当成请求失败。
        ok: true,
        healthy: bad === 0 && warn === 0 && visibleConsoleCount === 0,
        generatedAt: new Date().toISOString(),
        counts: { total: components.length, down: bad, warn, info: infoCount },
        // 闩锁结论必须是「/health 503 + 日志里有那条 worker crash」两条同时成立，缺一不报。
        latch: {
            active: latched,
            evidence: latchEvidence?.line ?? null,
            log: latchEvidence?.log ?? null,
            control: ENGINE_CONTROL_SCRIPT + ' -Action restart',
            action: 'engine-restart',
            engineHealth,
        },
        // 启停只有一个入口：脚本。计划任务实况每次现查（60 秒缓存），不写死。
        launchPolicy: {
            mode: 'script-only',
            autostart: false,
            startScript: START_PS1,
            stopScript: STOP_PS1,
            scheduledTasks: await scheduledTaskFacts(),
            scheduledTasksCheckedAt: new Date(scheduledTaskCache.at || Date.now()).toISOString(),
        },
        defer: deferSnapshot(),
        batch: batchSnapshot(),
        components,
        windows: {
            ok: visibleConsoleCount === 0,
            checkedAt: windowReport?.checkedAt ?? null,
            visibleConsoleCount,
            targets: (windowReport?.targets ?? []).map(item => ({
                name: item.name,
                pid: item.pid,
                running: item.running,
                hasVisibleConsole: item.hasVisibleConsole,
            })),
            violations: (windowReport?.violations ?? []).map(item => ({
                name: item.name,
                pid: item.pid,
                windowClass: item.windowClass,
                title: item.title,
                commandLine: item.commandLine,
            })),
            error: windowReport?.error ?? null,
        },
    };
}

/* -------------------------------------------------------------------- 拓扑 */

// 拓扑只做聚合，不新增任何采集：节点状态来自 /api/status 同一批探测，
// 连线流量来自 persona 目录里实际在写的 feed / 故障 / 队列文件。
const TOPO_WINDOW_MS = 15 * 60 * 1000;
const TOPO_SLOW_MS = 60 * 60 * 1000;

function readJsonlTail(path, maxBytes = 512 * 1024) {
    try {
        const { text } = readTailText(path, maxBytes);
        const rows = [];
        for (const line of text.split(/\r?\n/)) {
            if (line.trim() === '')
                continue;
            try {
                rows.push(JSON.parse(line));
            }
            catch {
                // 半行/坏行跳过，不影响统计
            }
        }
        return rows;
    }
    catch {
        return [];
    }
}

function rowTs(row) {
    const raw = row?.ts;
    if (typeof raw === 'number' && Number.isFinite(raw))
        return raw;
    const parsed = Date.parse(String(raw ?? ''));
    return Number.isFinite(parsed) ? parsed : 0;
}

function countRows(rows, fromMs, toMs, predicate) {
    let count = 0;
    for (const row of rows) {
        const at = rowTs(row);
        if (at >= fromMs && at <= toMs && predicate(row))
            count += 1;
    }
    return count;
}

/* ------------------------------------------------------- 迁移进度（只读文件） */

// spec 功能对照表的状态只允许三档；这里把“已实现（原生）/ 已切群（验证待真实消息）”归一成机读值。
function normalizeCapStatus(raw) {
    const text = String(raw ?? '');
    if (text.includes('未验证'))
        return 'unverified';
    if (text.includes('未实现'))
        return 'missing';
    if (text.includes('部分'))
        return 'partial';
    // 「已切群（验证待真实消息）」= 已切换但只能等真实消息确认，落到未验证档。
    if (text.includes('已切') && text.includes('验证'))
        return 'unverified';
    if (text.includes('已实现') || text.includes('已切'))
        return 'done';
    return 'unknown';
}

/** 能力清单来自 spec.md 的「功能对照表」小节：| # | 能力 | 来源 | 状态 | 证据 | */
/**
 * 迁移表的运行时核对（只展示事实，不改 spec）：
 * default_personality 已清空、media_roots 含 data\\temp（入站单图 read_image 可用）、
 * 带 tool_calls 的 content 全部 dropped 且不占幂等键。
 */
function migrationLiveFacts() {
    const astrbotCfg = readJsonSafe(ASTRBOT_CONFIG_PATH) ?? {};
    const xzy = readJsonSafe(XZY_CONFIG_PATH) ?? {};
    const roots = Array.isArray(xzy.media_roots) ? xzy.media_roots.map(String) : [];
    const tempRootIncluded = roots.some(p => /(^|[\\/])data[\\/]temp[\\/]?$/i.test(p));
    let toolRounds = null;
    try {
        const lines = readFileSync(join(ASTRBOT_AUDIT_DIR, 'tool_round.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
        let dropped = 0;
        let lastAt = '';
        for (const line of lines) {
            try {
                const row = JSON.parse(line);
                if (row?.action === 'dropped') dropped += 1;
                if (row?.wall) lastAt = String(row.wall);
            }
            catch { }
        }
        toolRounds = { total: lines.length, dropped, lastAt };
    }
    catch { }
    let imagePrep = null;
    try {
        const { text } = readTailText(join(ASTRBOT_AUDIT_DIR, 'image_prep.jsonl'), 16 * 1024);
        const line = text.split(/\r?\n/).filter(Boolean).pop();
        if (line) {
            const row = JSON.parse(line);
            imagePrep = { at: String(row.wall ?? ''), result: String(row.result ?? '') };
        }
    }
    catch { }
    return {
        defaultPersonality: String(astrbotCfg.default_personality ?? ''),
        mediaRoots: roots,
        tempRootIncluded,
        toolRounds,
        imagePrep,
    };
}

function parseMigrationCapabilities() {
    const stat = safeStat(MIGRATION_SPEC_PATH);
    if (!stat.exists)
        return { ok: false, error: '读不到 ' + MIGRATION_SPEC_PATH, source: MIGRATION_SPEC_PATH };
    let text = '';
    try {
        text = readFileSync(MIGRATION_SPEC_PATH, 'utf8');
    }
    catch (error) {
        return { ok: false, error: String(error?.message ?? error), source: MIGRATION_SPEC_PATH };
    }
    const items = [];
    let inCapTable = false;
    for (const line of text.split(/\r?\n/)) {
        // 按标题文字定位「功能对照表」所在小节，不押注小节编号（本规格是 §6）。
        if (/^##\s/.test(line)) {
            inCapTable = /功能对照表/.test(line);
            continue;
        }
        if (!inCapTable || !line.startsWith('|'))
            continue;
        const cells = line.split('|').map(cell => cell.trim());
        const id = Number(cells[1]);
        if (!Number.isInteger(id) || id <= 0 || id > 99 || cells.length < 6)
            continue;
        if (!cells[4])
            continue;
        items.push({
            id,
            name: cells[2],
            origin: cells[3],
            status: normalizeCapStatus(cells[4]),
            rawStatus: cells[4],
            evidence: cells[5] ?? '',
        });
    }
    if (items.length === 0)
        return { ok: false, error: 'spec.md 里没有解析到 §6 功能对照表', source: MIGRATION_SPEC_PATH };
    const counts = { done: 0, partial: 0, missing: 0, unverified: 0, unknown: 0 };
    for (const item of items)
        counts[item.status] += 1;
    return {
        ok: true,
        total: items.length,
        counts,
        items,
        source: MIGRATION_SPEC_PATH,
        mtime: new Date(stat.mtime).toISOString(),
    };
}

/** 工具总数/实现数/真机验证数来自 evidence/tools.md §3、§6.6、§8.6；解析失败就整块显示未知。 */
function parseToolEvidence() {
    const stat = safeStat(MIGRATION_TOOLS_PATH);
    if (!stat.exists)
        return { ok: false, error: '读不到 ' + MIGRATION_TOOLS_PATH, source: MIGRATION_TOOLS_PATH };
    let text = '';
    try {
        text = readFileSync(MIGRATION_TOOLS_PATH, 'utf8');
    }
    catch (error) {
        return { ok: false, error: String(error?.message ?? error), source: MIGRATION_TOOLS_PATH };
    }
    const number = re => {
        const match = text.match(re);
        return match ? Number(match[1]) : null;
    };
    // 同一份证据里 §4 记的是第一批时点、§6.6/§8.6 记的是最新时点；取最后一次出现，避免把旧数字当现状。
    const lastNumber = (re, group = 1) => {
        const matches = [...text.matchAll(re)];
        return matches.length > 0 ? Number(matches.at(-1)[group]) : null;
    };
    const lastPair = re => {
        const matches = [...text.matchAll(re)];
        if (matches.length === 0)
            return null;
        const match = matches.at(-1);
        return { done: Number(match[1]), total: Number(match[2]) };
    };
    // 取最后一条含关键词的行里的 `工具名`，用于「未验证分类」。
    const namesInLastLine = keyword => {
        const lines = text.split(/\r?\n/).filter(line => line.includes(keyword));
        if (lines.length === 0)
            return [];
        const names = [];
        for (const match of lines.at(-1).matchAll(/`([a-z][a-z0-9_]+)`/g)) {
            if (!names.includes(match[1]))
                names.push(match[1]);
        }
        return names;
    };
    // 33 个业务工具：只取 §3 正文（到「补充：」为止），避免把 qq_ask_master 等额外工具算进来。
    const section = text.slice(text.indexOf('## 3.'), text.indexOf('## 4.'));
    const body = section.includes('补充：') ? section.slice(0, section.indexOf('补充：')) : section;
    const catalog = [];
    for (const match of body.matchAll(/`([a-z][a-z0-9_]+)`/g)) {
        if (!catalog.includes(match[1]))
            catalog.push(match[1]);
    }
    const total = number(/共\s*(\d+)\s*个/);
    // 三个字段相互独立，不相加、不互相替代（tools.md §6.6/§8.6 的明确定义）。
    const implementedPair = lastPair(/实现数[^\n]*?\*\*\s*(\d+)\s*\/\s*(\d+)\s*\*\*/g);
    const verifiedPair = lastPair(/真机成功路径[^\n]*?\*\*\s*(\d+)\s*\/\s*(\d+)\s*\*\*/g);
    // §8.6 记「§8.5 记账 27 + 补验 3」；旧文件没有“记账”时，回退到最后一处「成功路径 **N**」。
    const recordedVerified = lastNumber(/记账\s*(\d+)/g)
        ?? lastNumber(/成功路径\s*\*\*\s*(\d+)\s*\*\*/g);
    const partialCount = lastNumber(/部分验证[^\n]*?\*\*\s*(\d+)\s*\*\*/g);
    const pendingAuthCount = lastNumber(/待授权写操作[^\n]*?\*\*\s*(\d+)\s*\*\*/g);
    const deferredCount = lastNumber(/暂缓[^\n]*?\*\*\s*(\d+)\s*\*\*/g);
    const declared = lastNumber(/注册数\s*=\s*声明数[^\n]*?\*\*\s*(\d+)\s*\*\*/g)
        ?? lastNumber(/声明数\s*=\s*注册数[^\n]*?\*\*\s*(\d+)\s*\*\*/g);
    const stampMatches = [...text.matchAll(/（(\d{4}-\d{2}-\d{2} \d{2}:\d{2}[–-]\d{2}:\d{2})[^）]*）/g)];
    const stampMatch = stampMatches.length > 0
        ? stampMatches.at(-1)
        : text.match(/## 4\. 当前注册状态（([^）]+)）/);
    if (total === null && catalog.length === 0)
        return { ok: false, error: 'tools.md 里没有解析到工具清单与总数', source: MIGRATION_TOOLS_PATH };
    const verifiedDone = verifiedPair ? verifiedPair.done : recordedVerified;
    return {
        ok: true,
        total: total ?? catalog.length,
        catalog,
        implemented: implementedPair ?? (total !== null ? { done: total, total } : null),
        verified: verifiedDone !== null
            ? { done: verifiedDone, total: verifiedPair?.total ?? total, recorded: recordedVerified }
            : null,
        verifiedExtra: namesInLastLine('本轮额外真机通过'),
        partial: { count: partialCount, names: namesInLastLine('部分验证') },
        pendingAuth: { count: pendingAuthCount, names: namesInLastLine('待授权写操作') },
        deferred: { count: deferredCount, names: namesInLastLine('暂缓') },
        evidencedRegistered: declared,
        stamp: stampMatch ? stampMatch[1] : null,
        source: MIGRATION_TOOLS_PATH,
        mtime: new Date(stat.mtime).toISOString(),
    };
}

/** 运行时注册工具：实例日志里最后一条 [xzy] 工具注册: 声明=N 名称=[…]。 */
function astrbotToolRegistry() {
    const stat = safeStat(ASTRBOT_LOG_PATH);
    if (!stat.exists)
        return { ok: false, error: '读不到 ' + ASTRBOT_LOG_PATH, source: ASTRBOT_LOG_PATH };
    let text = '';
    try {
        text = readTailText(ASTRBOT_LOG_PATH, 4 * 1024 * 1024).text;
    }
    catch (error) {
        return { ok: false, error: String(error?.message ?? error), source: ASTRBOT_LOG_PATH };
    }
    let found = null;
    for (const line of text.split(/\r?\n/)) {
        // 两种格式：早期「声明=13 名称=[…]」，批次 C 之后「声明=36 注册=36 名称=[…]」。
        const match = line.match(/^\[([^\]]+)\][\s\S]*\[xzy\] 工具注册: 声明=(\d+)\s*(?:注册=\d+\s*)?名称=\[([^\]]*)\]/);
        if (!match)
            continue;
        found = {
            at: match[1],
            declared: Number(match[2]),
            names: [...match[3].matchAll(/'([^']+)'/g)].map(item => item[1]),
        };
    }
    if (!found)
        return { ok: false, error: 'astrbot.log 里没有 [xzy] 工具注册 记录', source: ASTRBOT_LOG_PATH };
    return { ok: true, ...found, source: ASTRBOT_LOG_PATH };
}

/** xzy 审计目录：实例是否真的在跑回合，以 JSONL 的 wall 时间为准。 */
function astrbotAuditSnapshot(now) {
    const dirStat = safeStat(ASTRBOT_AUDIT_DIR);
    if (!dirStat.exists)
        return { ok: false, error: '读不到 ' + ASTRBOT_AUDIT_DIR, source: ASTRBOT_AUDIT_DIR };
    const names = ['inbound', 'outbound', 'turns', 'llm_request', 'sent', 'history_writeback', 'persona', 'presence_decay', 'memory'];
    const files = {};
    for (const name of names) {
        const path = join(ASTRBOT_AUDIT_DIR, name + '.jsonl');
        const stat = safeStat(path);
        if (!stat.exists) {
            files[name] = { exists: false, lastAt: 0, in15: 0, mtime: 0 };
            continue;
        }
        let lastAt = 0;
        let in15 = 0;
        for (const row of readJsonlTail(path, 192 * 1024)) {
            const at = Date.parse(String(row?.wall ?? ''));
            if (!Number.isFinite(at))
                continue;
            lastAt = Math.max(lastAt, at);
            if (now - at < TOPO_WINDOW_MS)
                in15 += 1;
        }
        files[name] = { exists: true, lastAt, in15, mtime: stat.mtime };
    }
    const latestAt = Math.max(0, ...Object.values(files).map(file => file.lastAt));
    // 目录里实际有多少份 JSONL：白名单只用于逐项状态，页面上的「写入 N 个文件」按真实目录算。
    let actualFiles = [];
    try {
        actualFiles = readdirSync(ASTRBOT_AUDIT_DIR).filter(name => name.endsWith('.jsonl'));
    }
    catch {
        actualFiles = [];
    }
    return {
        ok: true,
        files,
        actualFiles,
        latestAt,
        inbound15: files.inbound.in15,
        outbound15: files.outbound.in15,
        turns15: files.turns.in15,
        llm15: files.llm_request.in15,
        source: ASTRBOT_AUDIT_DIR,
    };
}

/**
 * 真实流量切换状态：只读迁移侧写的 state/cutover.json。
 * 这是手动写的一次性快照，没有心跳语义：updatedAt 只作说明，不参与“是不是过期”的判定。
 * 只有文件缺失 / JSON 损坏 / 关键字段缺失才 effective='unknown'；读不到就不猜，绝不写成“没在跑”。
 */
function cutoverSnapshot() {
    const stat = safeStat(CUTOVER_PATH);
    const base = {
        source: CUTOVER_PATH,
        exists: stat.exists,
        effective: 'unknown',
        stale: true,
        serving: { old: 'unknown', astrbot: 'unknown' },
    };
    if (!stat.exists)
        return { ...base, ok: false, state: 'missing', error: 'cutover.json 不存在（迁移侧尚未写入）' };
    let doc = null;
    try {
        const text = readFileSync(CUTOVER_PATH, 'utf8').trim();
        if (text === '')
            return { ...base, ok: false, state: 'invalid', error: 'cutover.json 是空文件' };
        doc = JSON.parse(text);
    }
    catch (error) {
        return { ...base, ok: false, state: 'invalid', error: 'JSON 解析失败：' + String(error?.message ?? error) };
    }
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc))
        return { ...base, ok: false, state: 'invalid', error: 'cutover.json 不是对象' };

    // mode 既可能是切换模式（old/split/astrbot/none），迁移侧也可能直接写阶段名（private=仅私聊已切）。
    const mode = ['old', 'split', 'astrbot', 'none', 'private'].includes(String(doc.mode))
        ? String(doc.mode)
        : null;
    const stage = ['prepare', 'private', 'one-group', 'all', 'done', 'paused', 'rolled-back', 'rollback-failed']
        .includes(String(doc.stage))
        ? String(doc.stage)
        : null;
    const oldStackServing = typeof doc.oldStackServing === 'boolean' ? doc.oldStackServing : null;
    const updatedMs = Date.parse(String(doc.updatedAt ?? ''));
    const ageMs = Number.isFinite(updatedMs) ? Date.now() - updatedMs : null;
    // stale 只用于界面提示“这个快照是多久前写的”，不再参与 unknown 判定。
    const stale = ageMs === null || ageMs > CUTOVER_STALE_MS;
    const missing = [];
    if (mode === null)
        missing.push('mode');
    if (stage === null)
        missing.push('stage');
    if (oldStackServing === null)
        missing.push('oldStackServing');
    const astrbotPid = Number.isInteger(doc.astrbotPid) && doc.astrbotPid > 0 ? doc.astrbotPid : null;
    const rollbackCommand = typeof doc.rollbackCommand === 'string' && doc.rollbackCommand.trim() !== ''
        ? doc.rollbackCommand.trim()
        : null;
    const note = typeof doc.note === 'string' ? doc.note : null;
    // stage=rolled-back / rollback-failed 优先于 mode：回滚后即使 mode 还停在 astrbot，也必须显示“已回滚”；
    // 回滚失败时服务方未知，不能落回 mode 显示成“正常”。
    const declared = stage === 'rolled-back'
        ? 'rolled-back'
        : stage === 'rollback-failed'
            ? 'rollback-failed'
            // stage=paused 是“手动全停”，即使 mode 还停在 astrbot 也不能显示成已切换
            : stage === 'paused'
                ? 'none'
                : mode;
    const effective = (missing.length > 0 || declared === null) ? 'unknown' : declared;
    const error = missing.length > 0
        ? '字段缺失：' + missing.join(' / ')
        : null;
    const serving = effective === 'unknown' || effective === 'rollback-failed'
        ? { old: 'unknown', astrbot: 'unknown' }
        : effective === 'split'
            ? { old: oldStackServing === false ? 'no' : 'partial', astrbot: 'partial' }
            : effective === 'private'
                ? { old: oldStackServing === false ? 'no' : 'partial', astrbot: 'partial' }
                : effective === 'astrbot'
                    ? { old: oldStackServing === true ? 'partial' : 'no', astrbot: 'yes' }
                    : effective === 'none'
                        ? { old: oldStackServing === true ? 'yes' : 'no', astrbot: 'no' }
                        : { old: oldStackServing === true ? 'yes' : 'unknown', astrbot: 'no' };
    return {
        ...base,
        ok: missing.length === 0,
        state: missing.length > 0 ? 'partial' : 'ok',
        updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : null,
        updatedMs,
        ageMs,
        stale,
        mode,
        stage,
        oldStackServing,
        astrbotPid,
        rollbackCommand,
        note,
        effective,
        serving,
        error,
    };
}

/**
 * AstrBot 侧链路实况：每个数字都从当前文件读，读不到返回 null（前端显示“未核实”），
 * 不缓存、不写死，避免把旧配置当现状。
 */
function astrbotRuntime(comfyPort = null) {
    const xzy = readJsonSafe(XZY_CONFIG_PATH);
    const core = readJsonSafe(ASTRBOT_CONFIG_PATH);
    const debounce = xzy?.debounce ?? null;
    const judge = xzy?.judge ?? null;
    const memory = xzy?.memory_inject ?? null;
    const platform = core?.platform_settings ?? null;
    const launch = engineLaunchFacts();
    const kvCapacity = launch && Number.isFinite(Number(launch.kvCapacity)) ? Number(launch.kvCapacity) : null;

    // 规则表来源：continuation.py 里是否还有 R1–R5 这五条判定结果标记。
    const RULES = ['R1:addressed-elsewhere', 'R2:continuation', 'R3:stale-window', 'R4:no-ago', 'R5:model'];
    let ruleHits = 0;
    try {
        const src = readFileSync(join(XZY_PLUGIN_DIR, 'continuation.py'), 'utf8');
        ruleHits = RULES.filter(tag => src.includes(tag)).length;
    }
    catch {
        ruleHits = 0;
    }

    // 出图链路：读最近一轮的 phase 顺序，核对“先卸引擎、再让 TTS 让路”的硬序。
    let draw = null;
    try {
        const { text } = readTailText(ENGINE_SWITCH_LOG, 128 * 1024);
        const rows = text.split(/\r?\n/).filter(line => line.trim() !== '')
            .map(line => { try { return JSON.parse(line); } catch { return null; } })
            .filter(Boolean);
        const lastUnload = rows.map(row => row.phase).lastIndexOf('unloaded');
        const round = lastUnload >= 0 ? rows.slice(lastUnload) : [];
        const steady = [...rows].reverse().find(row => row.phase === 'tts-restored') ?? null;
        const steadyMatch = steady ? [...String(steady.detail ?? '').matchAll(/used=(\d+) MiB free=(\d+) MiB/g)].pop() : null;
        const startMs = round[0] ? Date.parse(round[0].ts) : NaN;
        const endMs = round.at(-1) ? Date.parse(round.at(-1).ts) : NaN;
        draw = {
            phases: round.map(row => row.phase),
            at: round[0]?.ts ?? null,
            roundSeconds: Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.round((endMs - startMs) / 1000) : null,
            steadyUsedMb: steadyMatch ? Number(steadyMatch[1]) : null,
            steadyFreeMb: steadyMatch ? Number(steadyMatch[2]) : null,
            steadyAt: steady?.ts ?? null,
            source: ENGINE_SWITCH_LOG,
        };
    }
    catch {
        draw = null;
    }

    return {
        ok: Boolean(xzy || core),
        source: { xzy: XZY_CONFIG_PATH, cmd: ASTRBOT_CONFIG_PATH, engine: ENGINE_START_SCRIPT, audit: ENGINE_SWITCH_LOG },
        debounce: debounce
            ? {
                enabled: debounce.enabled === true,
                profile: xzy?.debounce_profile ?? null,
                baseMs: debounce.baseMs ?? null,
                groupMs: debounce.groupMs ?? null,
                imageMs: debounce.imageMs ?? null,
                emptyMentionMs: debounce.emptyMentionMs ?? null,
            }
            : null,
        judge: judge
            ? { windowMs: judge.continuationWindowMs ?? null, staleMs: judge.continuationStaleMs ?? null }
            : null,
        rules: { hits: ruleHits, total: RULES.length },
        dedup: xzy
            ? {
                windowSec: xzy.dedupWindowSec ?? null,
                ledger: existsSync(join(XZY_PLUGIN_DIR, 'answer_ledger.py')),
                ledgerPairs: (() => {
                    try {
                        return Object.keys(readJsonSafe(join(XZY_PLUGIN_DIR, 'answer_ledger.json')) ?? {}).length;
                    }
                    catch {
                        return null;
                    }
                })(),
            }
            : null,
        memory: memory
            ? {
                notebook: Boolean(xzy?.notebook_path) || existsSync(join(ASTRBOT_PERSONA_DIR, 'notebook.json')),
                diary: memory.diary_enabled === true,
                limit: memory.detail_limit ?? null,
            }
            : null,
        emptyMentionWaiting: platform && typeof platform.empty_mention_waiting === 'boolean'
            ? platform.empty_mention_waiting
            : null,
        engine: { kvCapacity, pageTokens: 64, pages: kvCapacity ? Math.round(kvCapacity / 64) : null },
        draw,
        comfy: {
            port8188: comfyPort === true ? 'listening' : comfyPort === false ? 'down' : 'unverified',
            port8299: 'unverified',
            note: 'ComfyUI 归用户自管，脚本不 kill',
        },
    };
}

async function topologySnapshot() {
    const now = Date.now();
    const cutover = cutoverSnapshot();
    // 服务方文案优先用文件里写明的 mode/stage；过期只提示，不把已写内容抹成未知。
    const servingKey = cutover.stage === 'rolled-back'
        ? 'rolled-back'
        : cutover.stage === 'rollback-failed'
            ? 'rollback-failed'
            : cutover.stage === 'paused'
                ? 'none'
                : cutover.mode;
    // 分工文案跟 oldStackServing 一起看：split 且旧栈已停时，不能再写「旧栈 + AstrBot」。
    const splitText = cutover.oldStackServing === false
        ? 'AstrBot（部分会话；旧栈未服务）'
        : cutover.oldStackServing === true
            ? '旧栈 + AstrBot（部分会话）'
            : 'AstrBot 与旧栈分工未核实（oldStackServing 不可解析）';
    const servingText = (servingKey === 'split' ? splitText : null) ?? {
        old: '旧栈',
        split: '旧栈 + AstrBot（部分会话）',
        private: 'AstrBot（仅私聊）',
        astrbot: 'AstrBot',
        none: '无（手动全停）',
        'rolled-back': '旧栈（已回滚）',
        'rollback-failed': '未知（回滚失败，需人工确认）',
    }[servingKey] ?? '未知';
    const snapshotNote = cutover.stale
        ? ' · 快照 ' + (cutover.ageMs === null ? '时间未知' : Math.round(cutover.ageMs / 60_000) + ' 分钟前写入')
            + '（静态快照，不按新鲜度判未知）'
        : '';
    const servingFact = servingKey
        ? servingText + '（阶段 ' + (cutover.stage ?? '未知') + snapshotNote + '）'
        : '未知（' + (cutover.error ?? 'cutover.json 不可用') + '）';
    // 边标签用的短口径：同样只依据 cutover.json 已写明的 mode/stage，不做推测。
    const servingShort = cutover.state === 'missing' || cutover.state === 'invalid'
        ? '未核实'
        : cutover.stage === 'rolled-back'
            ? '已回滚'
            : cutover.stage === 'rollback-failed'
                ? '回滚失败'
                : cutover.stage === 'paused' || cutover.mode === 'none'
                    ? '已全停'
                    : cutover.mode === 'private'
                        ? '仅私聊已切'
                        : cutover.mode === 'split'
                            ? '部分已切'
                            : cutover.mode === 'astrbot'
                                ? '已切 AstrBot'
                                : cutover.mode === 'old'
                                    ? '未切换'
                                    : '未核实';
    const astrbotConfig = readJsonSafe(ASTRBOT_CONFIG_PATH);
    const dashboardPort = Number(astrbotConfig?.dashboard?.port) || null;
    const aiocqPlatform = Array.isArray(astrbotConfig?.platform)
        ? astrbotConfig.platform.find(item => item?.type === 'aiocqhttp') ?? null
        : null;
    const reversePort = Number(aiocqPlatform?.ws_reverse_port) || null;
    const toolCallTimeout = Number(astrbotConfig?.provider_settings?.tool_call_timeout) || null;
    const providerModel = String(
        astrbotConfig?.provider?.[0]?.model_config?.model
        ?? astrbotConfig?.provider?.[0]?.model
        ?? '',
    ) || null;
    const astrbotRootExists = safeStat(ASTRBOT_ROOT).exists;

    const migration = parseMigrationCapabilities();
    const toolEvidence = parseToolEvidence();
    const registry = astrbotToolRegistry();
    const audit = astrbotAuditSnapshot(now);

    const [engineHttp, enginePort, comfyPort, dashboardAlive, reverseAlive] = await Promise.all([
        httpJson('http://127.0.0.1:8094/v1/models', 3000).catch(error => ({ __error: error?.message ?? String(error) })),
        tcpAlive(8094),
        tcpAlive(8188),
        dashboardPort ? tcpAlive(dashboardPort) : Promise.resolve(null),
        reversePort ? tcpAlive(reversePort) : Promise.resolve(null),
    ]);

    // 旧栈流量只用来给「真实入口尚未切换」这枚标记提供事实依据，不画旧栈节点。
    const conversation = readJsonlTail(FEED_PATH, 256 * 1024);
    const oldInbound15 = countRows(conversation, now - TOPO_WINDOW_MS, now, row => row.role === 'user');
    const oldLastInboundAt = conversation.reduce((max, row) => (row.role === 'user' ? Math.max(max, rowTs(row)) : max), 0);

    const engineModel = Array.isArray(engineHttp?.data) ? engineHttp.data[0] : null;
    const engineState = enginePort ? (engineHttp?.__error ? 'warn' : 'ok') : 'down';
    // 运行时证据：媒体 / 记忆是否真的注册、实现文件是否在，全部现读，不写死。
    const runtimeFacts = astrbotRuntime(comfyPort);
    const mediaToolNames = ['qq_draw', 'qq_send_image', 'qq_send_video', 'qq_send_sticker', 'qq_bili_feed', 'qq_bili_watch'];
    const mediaTools = registry.ok ? mediaToolNames.filter(name => registry.names.includes(name)) : [];
    const mediaDrawExists = safeStat(join(ASTRBOT_DATA_DIR, 'plugins', 'xzy', 'media_draw.py')).exists;
    const memorySearch = registry.ok && registry.names.includes('memory_search');
    const selfIterCount = registry.ok ? registry.names.filter(name => name.startsWith('self_iter_')).length : null;
    // 注册名按前缀分桶，数字全部从 astrbot.log 现算，不用文档里的历史口径。
    const qqToolCount = registry.ok ? registry.names.filter(name => name.startsWith('qq_')).length : null;
    const otherToolCount = registry.ok
        ? registry.names.filter(name => !name.startsWith('qq_') && name !== 'memory_search' && !name.startsWith('self_iter_')).length
        : null;
    const auditFresh = audit.ok && audit.latestAt > 0 && now - audit.latestAt < TOPO_WINDOW_MS;
    const auditFileState = name => {
        if (!audit.ok)
            return 'unknown';
        const file = audit.files[name];
        if (!file?.exists)
            return 'unknown';
        // 文件存在但 15 分钟内没新写入 = 静默（没流量），不是告警。
        return file.lastAt && now - file.lastAt < TOPO_WINDOW_MS ? 'ok' : 'idle';
    };

    const nodeStates = {
        // 真实入站先看 AstrBot 审计；旧栈零出站是 cutover 的既定状态，没有入站是静默，不是告警。
        qq: (audit.ok && audit.inbound15 > 0) || oldInbound15 > 0
            ? 'ok'
            : (cutover.ok && cutover.oldStackServing === false ? 'idle' : (oldLastInboundAt ? 'warn' : 'unknown')),
        onebot: reverseAlive === null ? 'unknown' : (reverseAlive ? 'ok' : 'down'),
        webui: dashboardAlive === null ? 'unknown' : (dashboardAlive ? 'ok' : 'down'),
        ingress: audit.ok ? (auditFresh ? 'ok' : 'idle') : 'unknown',
        policy: auditFileState('turns'),
        tools: registry.ok ? 'ok' : 'unknown',
        engine: engineState,
        outbound: auditFileState('outbound'),
        persona: auditFileState('persona'),
        context: auditFileState('history_writeback'),
        memory: registry.ok ? (memorySearch ? 'ok' : 'warn') : 'unknown',
        media: registry.ok
            ? (mediaTools.length > 0 && mediaDrawExists ? (comfyPort === true ? 'ok' : 'warn') : 'warn')
            : 'unknown',
        audit: audit.ok ? (auditFresh ? 'ok' : 'idle') : 'unknown',
    };

    /* 入口徽标跟 cutover.json 联动：文件内容可解析就按 mode/stage 判定；
       只有缺失 / JSON 坏掉才 unknown。过期只加在依据里，不改变已写明的 stage。 */
    const cutoverMigration = () => {
        if (cutover.state === 'missing' || cutover.state === 'invalid')
            return { state: 'unknown', source: 'state/cutover.json 不可用：' + (cutover.error ?? '未知原因') };
        const staleNote = cutover.stale
            ? ' · 快照 ' + (cutover.ageMs === null ? '时间未知' : Math.round(cutover.ageMs / 60_000) + ' 分钟前写入')
                + '（静态快照，不据此判未知）'
            : '';
        if (cutover.stage === 'rolled-back')
            return { state: 'missing', source: 'state/cutover.json stage=rolled-back（旧栈重新接管）' + staleNote };
        if (cutover.mode === 'none' || cutover.stage === 'paused')
            return {
                state: 'missing',
                source: 'state/cutover.json mode=' + (cutover.mode ?? '未知') + ' · stage=' + (cutover.stage ?? '未知')
                    + '（文件写明无一方在服务真实流量）' + staleNote,
            };
        if (cutover.stage === 'rollback-failed')
            return { state: 'unknown', source: 'state/cutover.json stage=rollback-failed（回滚失败，服务方未知，需人工确认）' + staleNote };
        if (cutover.mode === 'astrbot')
            return { state: 'done', source: 'state/cutover.json mode=astrbot（真实 QQ 已由 AstrBot 服务）' + staleNote };
        if (cutover.mode === 'split')
            return {
                state: 'partial',
                source: 'state/cutover.json mode=split · stage=' + (cutover.stage ?? '未知')
                    + (cutover.oldStackServing === false
                        ? '（私聊 + 已切群由 AstrBot 服务，旧栈未服务；未放行群见 note）'
                        : '（旧栈与 AstrBot 分工见 note）') + staleNote,
            };
        if (cutover.mode === 'private')
            return {
                state: 'partial',
                source: 'state/cutover.json mode=private · stage=' + (cutover.stage ?? '未知')
                    + '（仅私聊已切 AstrBot；旧栈 oldStackServing=' + (cutover.oldStackServing === null ? '未知' : cutover.oldStackServing) + '）' + staleNote,
            };
        if (cutover.mode === 'old')
            return { state: 'missing', source: 'state/cutover.json mode=old（旧栈仍在服务真实流量）' + staleNote };
        return { state: 'unknown', source: 'state/cutover.json 缺少 mode / stage 字段' };
    };
    const onebotMigration = () => {
        if (reversePort === null)
            return { state: 'unknown', source: 'cmd_config.json 读不到 aiocqhttp.ws_reverse_port' };
        if (reverseAlive === true)
            return { state: 'done', source: 'cmd_config.json ws_reverse_port=' + reversePort + ' · tcp 监听中' };
        if (reverseAlive === false)
            return { state: 'partial', source: 'cmd_config.json ws_reverse_port=' + reversePort + ' · tcp 未监听' };
        return { state: 'unknown', source: 'cmd_config.json ws_reverse_port=' + reversePort + ' · tcp 探测失败' };
    };
    // 以下徽标全部以运行时探针为准；探针读不到就是 unknown，不用 spec 的历史状态冒充现状。
    const auditFileMigration = name => {
        if (!audit.ok)
            return { state: 'unknown', source: 'xzy/audit 读不到：' + (audit.error ?? '未知原因') };
        const file = audit.files[name];
        if (!file?.exists)
            return { state: 'missing', source: 'xzy/audit/' + name + '.jsonl 未写入' };
        return {
            state: 'done',
            source: 'xzy/audit/' + name + '.jsonl 已写入'
                + (file.lastAt ? '（' + new Date(file.lastAt).toLocaleString('zh-CN', { hour12: false }) + '）' : ''),
        };
    };
    const engineMigration = enginePort
        ? (engineModel
            ? { state: 'done', source: 'tcp 8094 + /v1/models 返回 ' + engineModel.id }
            : { state: 'partial', source: 'tcp 8094 在听，/v1/models 读不到' })
        : { state: 'unknown', source: 'tcp 8094 未监听（无法判断引擎链路）' };
    const webuiMigration = dashboardAlive === null
        ? { state: 'unknown', source: 'cmd_config.json 读不到 dashboard.port' }
        : dashboardAlive
            ? { state: 'done', source: 'cmd_config.json dashboard.port=' + dashboardPort + ' · tcp 监听中' }
            : { state: 'unknown', source: 'dashboard.port=' + dashboardPort + ' · tcp 未监听（无法判断）' };
    const rules = runtimeFacts.rules ?? {};
    const policyMigration = rules.total > 0 && rules.hits === rules.total
        ? { state: 'done', source: 'continuation.py R1–R5 全部可读（' + rules.hits + '/' + rules.total + '）' }
        : { state: 'unknown', source: 'continuation.py 规则表未完整读到（' + (rules.hits ?? 0) + '/' + (rules.total ?? 5) + '）' };
    const memoryMigration = !registry.ok
        ? { state: 'unknown', source: 'astrbot.log 无工具注册记录' }
        : memorySearch
            ? { state: 'done', source: 'astrbot.log 工具注册含 memory_search；无专用检索审计文件' }
            : { state: 'missing', source: 'astrbot.log 工具注册不含 memory_search' };
    const mediaMigration = !registry.ok
        ? { state: 'unknown', source: 'astrbot.log 无工具注册记录' }
        : (mediaTools.length > 0 && mediaDrawExists
            ? { state: 'done', source: 'astrbot.log 注册 ' + mediaTools.join('/') + ' · media_draw.py 在' }
            : {
                state: mediaTools.length > 0 ? 'partial' : 'missing',
                source: mediaTools.length > 0
                    ? '工具已注册（' + mediaTools.join('/') + '），但 media_draw.py 不存在'
                    : 'astrbot.log 工具注册不含媒体工具',
            });
    const toolsMigration = () => {
        if (!toolEvidence.ok)
            return { state: 'unknown', source: 'evidence/tools.md 读取失败：' + (toolEvidence.error ?? '未知原因') };
        const imp = toolEvidence.implemented;
        const ver = toolEvidence.verified;
        if (!imp || !ver)
            return { state: 'unknown', source: 'evidence/tools.md 缺少实现数或真机验证字段' };
        const reg = registry.ok ? registry.declared : null;
        const source = 'evidence/tools.md §6.6/§8.6：实现 ' + imp.done + '/' + imp.total
            + ' · 真机 ' + ver.done + '/' + ver.total
            + (reg !== null ? '；运行时注册 ' + reg + '（astrbot.log）' : '；运行时注册数未核实');
        if (imp.done === imp.total && ver.done === ver.total)
            return { state: 'done', source };
        if (imp.done > 0 || ver.done > 0)
            return { state: 'partial', source };
        return { state: 'missing', source };
    };
    // 审计节点看实际写入，不看 spec #18（那条是运维重载/守护，与审计 JSONL 不是一回事）。
    const auditMigration = () => {
        if (!audit.ok)
            return { state: 'unknown', source: 'xzy/audit 目录不可读：' + (audit.error ?? '未知原因') };
        const files = Object.entries(audit.files ?? {}).filter(([, item]) => item?.exists).map(([name]) => name);
        const actual = (audit.actualFiles ?? []).map(name => name.replace(/\.jsonl$/, ''));
        if (files.length === 0)
            return { state: 'partial', source: 'xzy/audit 目录可读，但没有 JSONL 写入' };
        return {
            state: 'done',
            source: 'xzy/audit 目录实际 ' + actual.length + ' 份 JSONL（' + actual.join('/') + '）· 关键 ' + files.length
                + ' 项有写入 · 最新 ' + (audit.latestAt ? ageText(audit.latestAt) : '未知'),
        };
    };
    const nodeMigration = {
        qq: cutoverMigration(),
        onebot: onebotMigration(),
        tools: toolsMigration(),
        ingress: auditFileMigration('inbound'),
        policy: policyMigration,
        engine: engineMigration,
        outbound: auditFileMigration('outbound'),
        persona: auditFileMigration('persona'),
        context: auditFileMigration('history_writeback'),
        memory: memoryMigration,
        media: mediaMigration,
        audit: auditMigration(),
        webui: webuiMigration,
    };

    // 工具层：总数读 tools.md，运行时注册读实例日志；两份口径都展示，避免把文档时间点当现状。
    const catalog = toolEvidence.ok ? toolEvidence.catalog : [];
    const registeredNames = registry.ok ? registry.names : [];
    const registeredInCatalog = catalog.filter(name => registeredNames.includes(name));
    const missingTools = catalog.filter(name => !registeredNames.includes(name));

    /* 布局：主链自上而下单向；旁路能力在右侧独立列；回流统一走最左廊道。 */
    const LAYOUT = {
        width: 900, height: 790,
        nodeW: 200, nodeH: 70,
        mainX: 420, sideX: 760, corridorX: 25,
        entryTop: 15,
        qqX: 150,
        y: { entry: 70, ingress: 160, policy: 260, tools: 360, engine: 460, outbound: 560 },
        sideY: { audit: 260, webui: 360, media: 460, memory: 550, persona: 640, context: 730 },
    };
    // 画布尺寸必须包住所有节点：旁路列右边 760+200=960、最底部 730+70=800，
    // 写死 900×790 会把右侧和底部裁掉。这里按内容外扩 24，前端再负责缩放/平移。
    const CANVAS_PAD = 24;
    const viewBox = {
        width: Math.max(LAYOUT.width, LAYOUT.sideX + LAYOUT.nodeW + CANVAS_PAD),
        height: Math.max(LAYOUT.height, Math.max(...Object.values(LAYOUT.sideY)) + LAYOUT.nodeH + CANVAS_PAD),
    };

    const node = (id, layer, label, role, state, x, y, metrics, log, source) => {
        // 迁移态只从 nodeMigration 取；缺项就是 unknown，不写死 missing。
        const mig = nodeMigration[id] ?? { state: 'unknown', source: '没有对应的迁移数据源' };
        return {
            id, layer, label, role, state, x, y,
            w: LAYOUT.nodeW, h: LAYOUT.nodeH,
            migration: mig.state,
            migrationSource: mig.source,
            metrics: metrics.filter(Boolean),
            log,
            source,
        };
    };
    const engineLog = newestLogIn(ENGINE_LOG_DIR);

    const nodes = [
        /* ① 入口层：目标形态是 OneBot 反向 WS 直连；真实 QQ 按 cutover 显示服务方。 */
        node('qq', 'entry', 'QQ（真实消息源）', '群 / 私聊 · 服务方 ' + servingText,
            nodeStates.qq, LAYOUT.qqX, LAYOUT.y.entry, [
                fact('AstrBot 真实入站（15m）', audit.ok ? audit.inbound15 + ' 条' : '未核实（审计目录读不到）'),
                fact('旧栈入站（15m）', oldInbound15 + ' 条（旧栈口径）'),
                fact('旧栈最后入站', oldLastInboundAt ? ageText(oldLastInboundAt) : '未记录'),
                fact('真实流量服务方', servingFact),
            ], logRef('state/conversation-feed.jsonl', FEED_PATH), 'conversation-feed.jsonl + cutover.json'),
        node('onebot', 'entry', 'OneBot 反向 WS', 'aiocqhttp · 端口 ' + (reversePort ?? '未知'),
            nodeStates.onebot, LAYOUT.mainX, LAYOUT.y.entry, [
                fact('端口', reversePort ? (reverseAlive ? reversePort + ' 监听中' : reversePort + ' 未监听') : '未知（配置读不到）'),
                fact('平台 ID', aiocqPlatform?.id ?? '未知'),
                fact('客户端来源', '未核实（astrbot.log 未记录连接来源）'),
            ], registry.ok ? logRef('astrbot-log/astrbot.log', ASTRBOT_LOG_PATH) : logRef('', ASTRBOT_LOG_PATH), 'cmd_config.json + tcp ' + (reversePort ?? '?')),

        /* ② 主链路：自上而下单向，节点上的圆点是运行时事实，徽标是迁移状态。 */
        node('ingress', 'pipeline', '消息入口', 'OneBot 事件 → MessageChain → 唤醒',
            nodeStates.ingress, LAYOUT.mainX, LAYOUT.y.ingress, [
                fact('迁移依据', nodeMigration.ingress.source),
                fact('评测入站（15m）', audit.ok ? audit.inbound15 + ' 条' : '未知'),
                fact('审计最新写入', audit.ok && audit.latestAt ? ageText(audit.latestAt) : '未知'),
                fact('真实入口', servingFact),
            ], logRef('astrbot/inbound.jsonl', join(ASTRBOT_AUDIT_DIR, 'inbound.jsonl')), 'xzy/audit/inbound.jsonl'),
        node('policy', 'pipeline', '判定 / 防抖', '群 × 人二维 · 规则 + 模型判定',
            nodeStates.policy, LAYOUT.mainX, LAYOUT.y.policy, [
                fact('迁移依据', nodeMigration.policy.source),
                fact('评测回合（15m）', audit.ok ? audit.turns15 + ' 条' : '未知'),
            ], logRef('astrbot/turns.jsonl', join(ASTRBOT_AUDIT_DIR, 'turns.jsonl')), 'continuation.py + xzy-config.json + xzy/audit/turns.jsonl'),
        node('tools', 'pipeline', '工具层（注册 ' + (registry.ok ? registry.declared : '未核实') + '）',
            registry.ok
                ? registry.declared + ' 个：' + qqToolCount + ' 个 qq_* + ' + otherToolCount + ' 个其它 + memory_search + '
                    + selfIterCount + ' 个 self_iter_*'
                : '工具注册数未核实（astrbot.log 无注册行）',
            nodeStates.tools, LAYOUT.mainX, LAYOUT.y.tools, [
                fact('迁移依据', nodeMigration.tools.source),
                fact('实现数', toolEvidence.ok && toolEvidence.implemented
                    ? toolEvidence.implemented.done + ' / ' + toolEvidence.implemented.total + '（tools.md）'
                    : '未知'),
                fact('真机验证', toolEvidence.ok && toolEvidence.verified
                    ? toolEvidence.verified.done + ' / ' + toolEvidence.verified.total
                        + (toolEvidence.partial?.count ? ' · 部分 ' + toolEvidence.partial.count : '')
                        + (toolEvidence.pendingAuth?.count ? ' · 待授权写 ' + toolEvidence.pendingAuth.count : '')
                    : '未知'),
                fact('工具清单', toolEvidence.ok ? toolEvidence.total + ' 个（tools.md）' : '未知'),
                fact('注册数', registry.ok
                    ? registry.declared + '（声明 = 注册；含 ' + qqToolCount + ' 个 qq_*、'
                        + otherToolCount + ' 个其它、memory_search、' + selfIterCount + ' 个 self_iter_*）'
                    : '未知'),
                fact('实例日志快照', registry.ok ? registry.declared + ' 个 @' + registry.at : '未知'),
                fact('仍未注册', registry.ok ? missingTools.length + ' 个' : '未知'),
            ], registry.ok ? logRef('astrbot-log/astrbot.log', ASTRBOT_LOG_PATH) : logRef('', ASTRBOT_LOG_PATH), 'evidence/tools.md §8.6 + astrbot.log'),
        node('engine', 'pipeline', '引擎', 'ninfer 8094 · AstrBot 在用（旧栈未服务）',
            nodeStates.engine, LAYOUT.mainX, LAYOUT.y.engine, [
                fact('迁移依据', nodeMigration.engine.source),
                fact('模型', engineModel?.id ?? providerModel ?? '—'),
                fact('上下文', engineModel?.context_window ? engineModel.context_window + ' tokens' : '—'),
                fact('端口', enginePort ? '8094 监听中' : '8094 未监听'),
            ], engineLog ? logRef('engine/' + engineLog.name, join(ENGINE_LOG_DIR, engineLog.name)) : logRef('', ENGINE_LOG_DIR), '/v1/models + tcp 8094'),
        node('outbound', 'pipeline', '出站 / 二审', '清洗 · 拆分 · 二次审校 · 发送',
            nodeStates.outbound, LAYOUT.mainX, LAYOUT.y.outbound, [
                fact('迁移依据', nodeMigration.outbound.source),
                fact('评测出站（15m）', audit.ok ? audit.outbound15 + ' 条' : '未知'),
                fact('真实发送', servingFact),
            ], logRef('astrbot/outbound.jsonl', join(ASTRBOT_AUDIT_DIR, 'outbound.jsonl')), 'xzy/audit/outbound.jsonl + cutover.json'),

        /* ③ 旁路能力：右侧独立列，按所服务的环节自上而下排列。 */
        node('audit', 'support', '审计 JSONL', '入站 · 回合 · 出站 · 请求',
            nodeStates.audit, LAYOUT.sideX, LAYOUT.sideY.audit, [
                fact('迁移依据', nodeMigration.audit.source),
                fact('审计目录', audit.ok ? '可读' : (audit.error ?? '未知')),
                fact('最新写入', audit.ok && audit.latestAt ? ageText(audit.latestAt) : '未知'),
                fact('15m 入站 / 出站', audit.ok ? audit.inbound15 + ' / ' + audit.outbound15 + ' 条' : '未知'),
            ], logRef('astrbot/xzy/audit', ASTRBOT_AUDIT_DIR), ASTRBOT_AUDIT_DIR),
        node('webui', 'support', 'AstrBot WebUI', '实例面板 · 端口 ' + (dashboardPort ?? '未知'),
            nodeStates.webui, LAYOUT.sideX, LAYOUT.sideY.webui, [
                fact('迁移依据', nodeMigration.webui.source),
                fact('端口', dashboardPort ? (dashboardAlive ? dashboardPort + ' 监听中' : dashboardPort + ' 未监听') : '未知（配置读不到）'),
                fact('实例根目录', astrbotRootExists ? ASTRBOT_ROOT : '不存在'),
            ], logRef('astrbot-log/astrbot.log', ASTRBOT_LOG_PATH), 'cmd_config.json + tcp ' + (dashboardPort ?? '?')),
        node('media', 'support', '媒体能力', '表情 / 视频 / B 站 / 出图',
            nodeStates.media, LAYOUT.sideX, LAYOUT.sideY.media, [
                fact('迁移依据', nodeMigration.media.source),
                fact('AstrBot 媒体工具', registry.ok
                    ? mediaTools.length + ' / ' + mediaToolNames.length + ' 已注册'
                        + (mediaTools.length ? '（' + mediaTools.join(' / ') + '）' : '')
                    : '未核实（astrbot.log 无工具注册记录）'),
                fact('ComfyUI 8188', comfyPort === true
                    ? '在监听（出图后端，AstrBot 使用；旧栈已不服务）'
                    : comfyPort === false ? '未监听（出图不可用）' : '未核实（tcp 探测失败）'),
                fact('出图实现', mediaDrawExists ? 'media_draw.py 在' : '未找到 media_draw.py'),
            ], logRef('astrbot-log/astrbot.log', ASTRBOT_LOG_PATH), 'astrbot.log 工具注册 + media_draw.py + tcp 8188'),
        node('memory', 'support', '记忆 / notebook', '持久记忆 · 检索注入',
            nodeStates.memory, LAYOUT.sideX, LAYOUT.sideY.memory, [
                fact('迁移依据', nodeMigration.memory.source),
                fact('检索工具', registry.ok
                    ? (memorySearch ? 'memory_search 已注册' : 'memory_search 未注册')
                    : '未核实（astrbot.log 无工具注册记录）'),
                fact('记忆审计', audit.ok
                    ? (audit.files.memory?.exists
                        ? 'memory.jsonl 已写入'
                        : '无 memory_search 专用审计文件（调用记录未留痕）')
                    : '未核实（审计目录读不到）'),
            ], logRef('', ASTRBOT_AUDIT_DIR), 'astrbot.log 工具注册 + xzy/audit + xzy-config.json'),
        node('persona', 'support', '人格', 'character.md · 提示词装配',
            nodeStates.persona, LAYOUT.sideX, LAYOUT.sideY.persona, [
                fact('迁移依据', nodeMigration.persona.source),
                fact('审计文件', !audit.ok ? '未核实（审计目录读不到）'
                    : (audit.files.persona?.exists ? 'persona.jsonl 已写入' : 'persona.jsonl 未写入（目录可读）')),
            ], logRef('astrbot/persona.jsonl', join(ASTRBOT_AUDIT_DIR, 'persona.jsonl')), 'xzy/audit/persona.jsonl'),
        node('context', 'support', '上下文 / 压缩', '预算 · 折叠 · 历史卫生',
            nodeStates.context, LAYOUT.sideX, LAYOUT.sideY.context, [
                fact('迁移依据', nodeMigration.context.source),
                fact('回写审计', !audit.ok ? '未核实（审计目录读不到）'
                    : (audit.files.history_writeback?.exists ? 'history_writeback.jsonl 已写入' : 'history_writeback.jsonl 未写入（目录可读）')),
            ], logRef('astrbot/history_writeback.jsonl', join(ASTRBOT_AUDIT_DIR, 'history_writeback.jsonl')), 'xzy/audit/history_writeback.jsonl'),
    ];
    const nodeById = new Map(nodes.map(item => [item.id, item]));
    const resources = await resourceSnapshot();
    for (const item of nodes)
        item.resource = resources.byNode[item.id] ?? null;

    const edge = (from, to, kind, flow, label, options = {}) => {
        const fromNode = nodeById.get(from);
        const toNode = nodeById.get(to);
        const state = options.state
            ?? ((fromNode?.state === 'down' || toNode?.state === 'down')
                ? 'down'
                : (flow > 0 ? 'ok' : 'idle'));
        return {
            from, to, kind, flow,
            label,
            state,
            // 正交折线：points 由布局常量算出；labelAt 固定标注点，避免压节点。
            points: options.points ?? [],
            labelAt: options.labelAt ?? null,
            detail: options.detail ?? '',
            degrade: null,
        };
    };
    const evalInbound = audit.ok ? audit.inbound15 : null;
    const evalTurns = audit.ok ? audit.turns15 : null;
    const evalLlm = audit.ok ? audit.llm15 : null;
    const evalOutbound = audit.ok ? audit.outbound15 : null;
    const unscoped = value => (value === null ? '未知' : value + ' 条/15m');
    const edges = [
        edge('qq', 'ingress', 'ingress', (audit.ok ? audit.inbound15 : 0) + oldInbound15,
            '真实流量 ' + (audit.ok ? audit.inbound15 : '未知') + ' 条/15m（AstrBot 审计）· ' + servingShort, {
                state: !cutover.ok ? 'unknown'
                    : ((audit.ok && audit.inbound15 > 0) || oldInbound15 > 0 ? 'ok'
                        : (cutover.oldStackServing === true ? 'warn' : 'idle')),
            detail: cutover.ok
                ? 'cutover.json：mode=' + (cutover.mode ?? '未知') + ' · stage=' + (cutover.stage ?? '未知')
                    + ' · oldStackServing=' + (cutover.oldStackServing === null ? '未知' : cutover.oldStackServing)
                    + '；真实归属以该快照为准'
                : 'cutover.json 不可用：' + (cutover.error ?? '未知原因'),
            points: [[150, 105], [150, 115], [420, 115], [420, 125]],
            labelAt: [205, 118],
        }),
        edge('onebot', 'ingress', 'ingress', evalInbound ?? 0, '评测入站 ' + unscoped(evalInbound), {
            state: audit.ok ? (evalInbound > 0 ? 'ok' : 'idle') : 'unknown',
            points: [[420, 105], [420, 125]],
            labelAt: [432, 115],
        }),
        edge('ingress', 'policy', 'request', evalInbound ?? 0, '入站 ' + unscoped(evalInbound), {
            state: audit.ok ? (evalInbound > 0 ? 'ok' : 'idle') : 'unknown',
            points: [[420, 195], [420, 225]],
            labelAt: [432, 210],
        }),
        edge('policy', 'tools', 'request', evalTurns ?? 0, '回合 ' + unscoped(evalTurns), {
            state: audit.ok ? (evalTurns > 0 ? 'ok' : 'idle') : 'unknown',
            points: [[420, 295], [420, 325]],
            labelAt: [432, 310],
        }),
        edge('tools', 'engine', 'upstream', evalLlm ?? 0, '模型请求 ' + unscoped(evalLlm), {
            state: audit.ok ? (evalLlm > 0 ? 'ok' : 'idle') : 'unknown',
            points: [[420, 395], [420, 425]],
            labelAt: [432, 410],
        }),
        edge('engine', 'outbound', 'response', evalOutbound ?? 0, '出站 ' + unscoped(evalOutbound), {
            state: audit.ok ? (evalOutbound > 0 ? 'ok' : 'idle') : 'unknown',
            points: [[420, 495], [420, 525]],
            labelAt: [432, 510],
        }),
        edge('policy', 'audit', 'observe', evalTurns ?? 0, '回合审计 ' + unscoped(evalTurns), {
            state: audit.ok ? (evalTurns > 0 ? 'ok' : 'idle') : 'unknown',
            points: [[520, 260], [660, 260]],
            labelAt: [590, 252],
        }),
        // 回流统一走最左侧专用廊道：出站 → 回到 QQ 入口，所有回发共用这一条。
        edge('outbound', 'qq', 'response', evalOutbound ?? 0, '评测回发 ' + unscoped(evalOutbound) + ' · 评测口径', {
            state: audit.ok ? (evalOutbound > 0 ? 'ok' : 'idle') : 'unknown',
            detail: '真实发送归属：' + servingFact,
            points: [[320, 560], [25, 560], [25, 15], [150, 15], [150, 35]],
            labelAt: [150, 290],
        }),
        edge('persona', 'engine', 'config', null, '人格注入', {
            state: nodeStates.persona === 'unknown' ? 'unknown' : 'idle',
            points: [[660, 640], [600, 640], [600, 430], [520, 430]],
            labelAt: [575, 422],
        }),
        edge('context', 'engine', 'config', null, '上下文预算', {
            state: nodeStates.context === 'unknown' ? 'unknown' : 'idle',
            points: [[660, 730], [580, 730], [580, 490], [520, 490]],
            labelAt: [566, 482],
        }),
        edge('memory', 'tools', 'tool', null, 'memory_search', {
            state: nodeStates.memory === 'ok' ? 'ok' : (nodeStates.memory === 'unknown' ? 'unknown' : 'warn'),
            points: [[660, 550], [630, 550], [630, 390], [520, 390]],
            labelAt: [586, 382],
        }),
        edge('media', 'tools', 'tool', null, '媒体工具', {
            state: nodeStates.media === 'ok' ? 'ok' : (nodeStates.media === 'unknown' ? 'unknown' : 'warn'),
            points: [[660, 460], [650, 460], [650, 330], [520, 330]],
            labelAt: [588, 322],
        }),
        edge('webui', 'audit', 'observe', null, '只读观测', {
            state: nodeStates.webui === 'ok' ? 'idle' : 'unknown',
            points: [[760, 325], [760, 295]],
            labelAt: [770, 310],
        }),
    ];

    const counts = { nodes: nodes.length, edges: edges.length };
    for (const state of ['ok', 'warn', 'idle', 'down', 'unknown'])
        counts[state] = nodes.filter(item => item.state === state).length;
    for (const state of ['done', 'partial', 'missing', 'unverified', 'unknown'])
        counts['migration_' + state] = nodes.filter(item => item.migration === state).length;

    return {
        ok: true,
        generatedAt: new Date().toISOString(),
        windowMs: TOPO_WINDOW_MS,
        nodeSize: { w: LAYOUT.nodeW, h: LAYOUT.nodeH },
        viewBox,
        // 真实流量服务方完全由迁移侧的 state/cutover.json 决定；读不到就 unknown，不写死。
        // display 用于配色：文件内容可解析时按 mode/stage 上色（过期只在依据里标注）。
        cutover: { ...cutover, display: servingKey },
        // 目标架构单栈视图：旧栈不进图，流量归属见 cutover 与入口节点。
        target: {
            name: 'AstrBot 4.14.6',
            note: '本图是迁移目标形态，真实流量服务方以 cutover.json 为准。',
            root: ASTRBOT_ROOT,
            rootExists: astrbotRootExists,
            dashboardPort,
            reversePort,
            platformId: aiocqPlatform?.id ?? null,
            providerModel,
        },
        bands: [
            { kind: 'text', text: '主链 · 自上而下', x: 420, y: 24 },
            { kind: 'text', text: '旁路能力 · 按服务环节排列', x: 660, y: 24 },
            { kind: 'text', text: '回流廊道', x: 36, y: 300 },
        ],
        astrbotRuntime: runtimeFacts,
        resources: {
            ok: resources.ok,
            error: resources.error ?? null,
            sampledAt: resources.sampledAt,
            sampleMs: resources.sampleMs,
            machine: resources.machine,
        },
        counts,
        traffic: {
            oldInbound15,
            oldLastInboundAt: oldLastInboundAt || null,
            evalInbound15: evalInbound,
            evalTurns15: evalTurns,
            evalLlm15: evalLlm,
            evalOutbound15: evalOutbound,
            lastEvalAt: audit.ok && audit.latestAt ? audit.latestAt : null,
        },
        migration: {
            ...migration,
            // 运行时核对：不依赖 spec 的静态证据，直接读当前配置/审计，避免把已修项显示成未修。
            live: migrationLiveFacts(),
            deployment: {
                toolCallTimeout,
                suggestedMinSec: 300,
                note: toolCallTimeout === null
                    ? 'tool_call_timeout 读不到（cmd_config.json 无该字段），长任务是否被截断未核实'
                    : 'AstrBot 的 tool_call_timeout=' + toolCallTimeout
                        + ' 秒，超过该时长的工具调用会被截断；出图 / B 站视频耗时未核实，若被截断就调大此值。',
                source: ASTRBOT_CONFIG_PATH,
            },
            tools: {
                ok: toolEvidence.ok && registry.ok,
                error: toolEvidence.ok ? (registry.ok ? null : registry.error) : toolEvidence.error,
                total: toolEvidence.ok ? toolEvidence.total : null,
                catalog: catalog.length,
                // 三个独立字段：实现数 / 真机验证数 / 未验证分类，读不到各自为 null。
                implementedDone: toolEvidence.ok ? (toolEvidence.implemented?.done ?? null) : null,
                implementedTotal: toolEvidence.ok ? (toolEvidence.implemented?.total ?? null) : null,
                verifiedDone: toolEvidence.ok ? (toolEvidence.verified?.done ?? null) : null,
                verifiedTotal: toolEvidence.ok ? (toolEvidence.verified?.total ?? null) : null,
                verifiedRecorded: toolEvidence.ok ? (toolEvidence.verified?.recorded ?? null) : null,
                verifiedExtra: toolEvidence.ok ? toolEvidence.verifiedExtra : [],
                partial: toolEvidence.ok ? toolEvidence.partial : null,
                pendingAuth: toolEvidence.ok ? toolEvidence.pendingAuth : null,
                deferred: toolEvidence.ok ? toolEvidence.deferred : null,
                // 注册数口径来自 tools.md §8.6（声明=注册）；实例日志只作为运行时快照单独展示。
                declaredEvidence: toolEvidence.ok ? (toolEvidence.evidencedRegistered ?? null) : null,
                runtimeOutOfCatalog: registry.ok
                    ? registry.names.filter(name => !catalog.includes(name))
                    : [],
                stamp: toolEvidence.ok ? toolEvidence.stamp : null,
                runtimeDeclared: registry.ok ? registry.declared : null,
                runtimeInCatalog: registry.ok ? registeredInCatalog.length : null,
                runtimeMissing: registry.ok ? missingTools.length : null,
                runtimeAt: registry.ok ? registry.at : null,
                source: toolEvidence.source,
                runtimeSource: registry.source ?? null,
            },
        },
        nodes,
        edges,
        sources: {
            status: '/api/status',
            spec: MIGRATION_SPEC_PATH,
            tools: MIGRATION_TOOLS_PATH,
            astrbotConfig: ASTRBOT_CONFIG_PATH,
            astrbotAudit: ASTRBOT_AUDIT_DIR,
            astrbotLog: ASTRBOT_LOG_PATH,
            engine: '/v1/models + tcp 8094',
        },
    };
}

/* ------------------------------------------------------------------ 影子日志 */

const sceneKind = sceneKey => (String(sceneKey ?? '').startsWith('group:') ? 'group' : 'dm');

function readShadowRows(maxBytes = 4 * 1024 * 1024) {
    if (!existsSync(SHADOW_PATH))
        return { rows: [], badLines: 0, truncated: false };
    const { text, truncated } = readTailText(SHADOW_PATH, maxBytes);
    const rows = [];
    let badLines = 0;
    for (const line of text.split(/\r?\n/)) {
        if (line.trim() === '')
            continue;
        try {
            const row = JSON.parse(line);
            if (row && typeof row.type === 'string')
                rows.push(row);
            else
                badLines += 1;
        }
        catch {
            badLines += 1;
        }
    }
    return { rows, badLines, truncated };
}

function joinShadowRows(rows) {
    const map = new Map();
    for (const row of rows) {
        if (typeof row.id !== 'string' || row.id === '')
            continue;
        const record = map.get(row.id) ?? { id: row.id, decision: null, wouldReply: null, legacy: null };
        if (row.type === 'decision')
            record.decision = row;
        else if (row.type === 'would_reply')
            record.wouldReply = row;
        else if (row.type === 'legacy_observe')
            record.legacy = row;
        map.set(row.id, record);
    }
    return [...map.values()];
}

function ratio(numerator, denominator) {
    return denominator > 0 ? numerator / denominator : null;
}

function shadowOverview({ limit = 30, scope = 'all', chatId = '', excludeSamples = false }) {
    const { rows, badLines, truncated } = readShadowRows();
    const records = joinShadowRows(rows);
    const decisions = records.filter(record => record.decision !== null);
    const kept = excludeSamples ? decisions.filter(record => record.decision.sample !== true) : decisions;

    const ruleMap = new Map();
    let replyCount = 0;
    let groupCount = 0;
    let dmCount = 0;
    for (const record of kept) {
        const decision = record.decision.decision ?? {};
        const rule = String(decision.rule ?? '(缺失)');
        const entry = ruleMap.get(rule) ?? { rule, total: 0, reply: 0, noReply: 0 };
        entry.total += 1;
        if (decision.reply === true) {
            entry.reply += 1;
            replyCount += 1;
        }
        else {
            entry.noReply += 1;
        }
        ruleMap.set(rule, entry);
        if (sceneKind(record.decision.sceneKey) === 'group')
            groupCount += 1;
        else
            dmCount += 1;
    }

    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    let observed = 0;
    for (const record of kept) {
        const replied = record.legacy?.legacy?.replied;
        if (typeof replied !== 'boolean')
            continue;
        observed += 1;
        const newReply = record.decision.decision?.reply === true;
        if (newReply && replied)
            tp += 1;
        else if (newReply && !replied)
            fp += 1;
        else if (!newReply && replied)
            fn += 1;
        else
            tn += 1;
    }

    const wouldRows = kept.map(record => record.wouldReply).filter(Boolean);
    const avgMs = wouldRows.length > 0
        ? Math.round(wouldRows.reduce((sum, row) => sum + (Number(row.ms) || 0), 0) / wouldRows.length)
        : null;
    const failed = wouldRows.filter(row => row.error !== null && row.error !== undefined && row.error !== '').length;

    const filtered = kept.filter(record => {
        const kind = sceneKind(record.decision.sceneKey);
        if (scope !== 'all' && kind !== scope)
            return false;
        if (chatId !== '' && String(record.decision.chatId ?? '') !== chatId)
            return false;
        return true;
    });
    filtered.sort((a, b) => String(b.decision.ts).localeCompare(String(a.decision.ts)));

    const items = filtered.slice(0, Math.min(Math.max(limit, 1), 200)).map(record => {
        const decision = record.decision;
        const body = decision.decision ?? {};
        return {
            id: record.id,
            ts: decision.ts ?? '',
            sceneKey: decision.sceneKey ?? '',
            kind: sceneKind(decision.sceneKey),
            chatId: String(decision.chatId ?? ''),
            sender: decision.sender ?? {},
            rule: String(body.rule ?? ''),
            reason: String(body.reason ?? ''),
            reply: body.reply === true,
            addressed: body.details?.addressed === true,
            sample: decision.sample === true,
            textPreview: String(decision.textPreview ?? ''),
            messageCount: Array.isArray(decision.messageIds) ? decision.messageIds.length : 0,
            wouldReply: record.wouldReply
                ? {
                    text: String(record.wouldReply.text ?? ''),
                    ms: Number(record.wouldReply.ms) || 0,
                    error: record.wouldReply.error ?? null,
                    reason: record.wouldReply.reason ?? '',
                }
                : null,
            legacy: record.legacy?.legacy
                ? {
                    replied: record.legacy.legacy.replied === true
                        ? true
                        : (record.legacy.legacy.replied === false ? false : null),
                    textPreview: record.legacy.legacy.textPreview ?? null,
                }
                : null,
        };
    });

    return {
        ok: true,
        path: SHADOW_PATH,
        exists: existsSync(SHADOW_PATH),
        truncated,
        badLines,
        stats: {
            decisions: kept.length,
            allDecisions: decisions.length,
            samples: decisions.filter(record => record.decision.sample === true).length,
            reply: replyCount,
            noReply: kept.length - replyCount,
            group: groupCount,
            dm: dmCount,
            observed,
            coverage: ratio(observed, kept.length),
            tp,
            fp,
            fn,
            tn,
            consistency: ratio(tp + tn, observed),
            fnRate: ratio(fn, tp + fn),
            fpRate: ratio(fp, tp + fp),
            wouldReply: wouldRows.length,
            wouldReplyFailed: failed,
            avgMs,
        },
        rules: [...ruleMap.values()].sort((a, b) => b.total - a.total || a.rule.localeCompare(b.rule)),
        returned: items.length,
        matched: filtered.length,
        items,
    };
}

let compareCache = { at: 0, key: '', value: null };

async function runCompare(excludeSamples) {
    const key = excludeSamples ? 'exclude' : 'all';
    if (Date.now() - compareCache.at < 10000 && compareCache.key === key)
        return compareCache.value;
    if (!existsSync(COMPARE_SCRIPT))
        throw new Error('找不到比对脚本：' + COMPARE_SCRIPT);
    if (!existsSync(SHADOW_PATH))
        throw new Error('找不到影子日志：' + SHADOW_PATH + '（还没有任何判定）');
    const outPath = join(tmpdir(), 'qq-console-compare-' + Date.now() + '.json');
    const args = [COMPARE_SCRIPT, SHADOW_PATH, '--json', outPath];
    if (excludeSamples)
        args.push('--exclude-samples');
    const result = await runCommand(process.execPath, args, { timeoutMs: 30000 });
    if (result.code !== 0) {
        try {
            unlinkSync(outPath);
        }
        catch {
            // ignore
        }
        throw new Error('compare-shadow.mjs 退出码 ' + result.code + '：'
            + (result.stderr || result.stdout).trim().slice(0, 600));
    }
    let report = null;
    try {
        report = JSON.parse(readFileSync(outPath, 'utf8'));
    }
    finally {
        try {
            unlinkSync(outPath);
        }
        catch {
            // ignore
        }
    }
    const markdown = result.stdout.replace(/^JSON 已写入：.*$/m, '').trim();
    const value = { ok: true, report, markdown, generatedAt: new Date().toISOString() };
    compareCache = { at: Date.now(), key, value };
    return value;
}

/* -------------------------------------------------------------------- 配置 */

function configPayload() {
    const file = loadConfigFile(CONFIG_PATH);
    const st = safeStat(CONFIG_PATH);
    return {
        ok: true,
        path: CONFIG_PATH,
        exists: st.exists,
        mtime: st.mtime,
        size: st.size,
        validation: { ok: file.ok, errors: file.errors, warnings: file.warnings },
        raw: file.raw ?? readJsonSafe(CONFIG_PATH),
        effective: file.config,
        defaults: DEFAULTS,
        triggerModes: TRIGGER_MODES,
    };
}

function backupConfig() {
    try {
        mkdirSync(BACKUP_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const target = join(BACKUP_DIR, 'config-' + stamp + '.json');
        copyFileSync(CONFIG_PATH, target);
        return target;
    }
    catch {
        return null;
    }
}

function saveConfig(body) {
    const raw = body?.config;
    if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw))
        return { status: 400, payload: { ok: false, error: '请求体缺少 config 对象' } };

    const result = validateConfig(raw);
    if (body.dryRun === true) {
        return {
            status: 200,
            payload: {
                ok: result.ok,
                dryRun: true,
                errors: result.errors,
                warnings: result.warnings,
                error: result.ok ? undefined : '校验未通过（未写入）',
            },
        };
    }
    if (!result.ok) {
        return {
            status: 400,
            payload: {
                ok: false,
                error: '配置校验未通过，已拒绝写入',
                errors: result.errors,
                warnings: result.warnings,
            },
        };
    }

    const previous = loadConfigFile(CONFIG_PATH).raw ?? {};
    const changed = [...new Set([...Object.keys(previous), ...Object.keys(raw)])]
        .filter(key => JSON.stringify(previous[key]) !== JSON.stringify(raw[key]));
    const backup = backupConfig();
    if (!writeJsonAtomic(CONFIG_PATH, raw))
        return { status: 500, payload: { ok: false, error: '原子写入失败（临时文件或重命名出错）：' + CONFIG_PATH } };

    return {
        status: 200,
        payload: {
            ok: true,
            message: '已原子写入，插件 watch 会自动热重载（约 0.3 秒）',
            path: CONFIG_PATH,
            changed,
            warnings: result.warnings,
            backup,
            mtime: safeStat(CONFIG_PATH).mtime,
        },
    };
}

/* ------------------------------------------------------- 群白名单（真实链路） */
/**
 * 只认 cordis.patch.yml 里 dsh-onebot 条目的 groupPolicy / groupAllowFrom。
 * 没有 yaml 依赖，按行定位这一条 entry，改完其余字节不动；写前备份、写时原子替换。
 */
const CORDIS_PATCH_PATH = 'C:\\Users\\user\\.dsh\\profiles\\desktop\\cordis.patch.yml';
const GROUP_POLICIES = ['open', 'allowlist', 'disabled'];

/** 返回 dsh-onebot 条目在行数组里的范围（到下一条顶层 `- id:` 为止）。 */
function onebotEntryRange(lines) {
    const start = lines.findIndex(line => /^-\s+id:\s*['"]?dsh-onebot['"]?\s*(?:#.*)?$/.test(line));
    if (start === -1)
        return null;
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
        if (/^-\s+/.test(lines[index])) {
            end = index;
            break;
        }
    }
    return { start, end };
}

function readGroupsFromLines(lines, range) {
    let policy = '';
    const groups = [];
    for (let index = range.start + 1; index < range.end; index += 1) {
        const line = lines[index];
        const policyMatch = /^\s+groupPolicy:\s*['"]?([A-Za-z]+)['"]?\s*$/.exec(line);
        if (policyMatch !== null) {
            policy = policyMatch[1];
            continue;
        }
        const head = /^(\s+)groupAllowFrom:\s*(.*)$/.exec(line);
        if (head === null)
            continue;
        const inline = head[2].trim();
        if (inline !== '') {
            const inner = inline.startsWith('[') && inline.endsWith(']') ? inline.slice(1, -1) : inline;
            for (const item of inner.split(',')) {
                const value = item.trim().replace(/^['"]|['"]$/g, '');
                if (value !== '')
                    groups.push(value);
            }
            continue;
        }
        const indent = head[1].length;
        for (let cursor = index + 1; cursor < range.end; cursor += 1) {
            const item = /^(\s+)-\s*(.*)$/.exec(lines[cursor]);
            if (item === null || item[1].length <= indent)
                break;
            const value = item[2].trim().replace(/^['"]|['"]$/g, '');
            if (value !== '')
                groups.push(value);
            index = cursor;
        }
    }
    return { policy, groups };
}

function groupAccessPayload() {
    const st = safeStat(CORDIS_PATCH_PATH);
    if (!st.exists)
        return { ok: false, error: '找不到真实链路配置：' + CORDIS_PATCH_PATH, path: CORDIS_PATCH_PATH };
    const lines = readFileSync(CORDIS_PATCH_PATH, 'utf8').split(/\r?\n/);
    const range = onebotEntryRange(lines);
    if (range === null)
        return { ok: false, error: 'cordis.patch.yml 里没有 dsh-onebot 条目', path: CORDIS_PATCH_PATH };
    const { policy, groups } = readGroupsFromLines(lines, range);
    // 这张表只写旧栈 cordis.patch.yml；当前真实流量服务方以 cutover.json 为准，一起带上避免页面按旧口径描述。
    const cut = cutoverSnapshot();
    return {
        ok: true,
        path: CORDIS_PATCH_PATH,
        mtime: st.mtime,
        size: st.size,
        policy: policy === '' ? 'allowlist' : policy,
        groups,
        policies: GROUP_POLICIES,
        restartRequired: true,
        cutover: {
            mode: cut?.mode ?? null,
            stage: cut?.stage ?? null,
            oldStackServing: cut?.oldStackServing ?? null,
            note: cut?.note ?? '',
        },
    };
}

function saveGroupAccess(body) {
    const policy = String(body?.policy ?? '').trim();
    if (!GROUP_POLICIES.includes(policy))
        return { status: 400, payload: { ok: false, error: 'groupPolicy 只能是 ' + GROUP_POLICIES.join(' / ') } };
    const input = Array.isArray(body?.groups) ? body.groups : String(body?.groups ?? '').split(/[\s,，]+/u);
    const groups = [];
    const invalid = [];
    for (const item of input) {
        const value = String(item ?? '').trim();
        if (value === '')
            continue;
        if (!/^\d{5,12}$/u.test(value)) {
            invalid.push(value);
            continue;
        }
        if (!groups.includes(value))
            groups.push(value);
    }
    if (invalid.length > 0)
        return { status: 400, payload: { ok: false, error: '群号必须是 5-12 位数字：' + invalid.slice(0, 5).join('、') } };
    if (groups.length > 200)
        return { status: 400, payload: { ok: false, error: '群号最多 200 个' } };

    const st = safeStat(CORDIS_PATCH_PATH);
    if (!st.exists)
        return { status: 404, payload: { ok: false, error: '找不到 ' + CORDIS_PATCH_PATH } };
    const text = readFileSync(CORDIS_PATCH_PATH, 'utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const range = onebotEntryRange(lines);
    if (range === null)
        return { status: 400, payload: { ok: false, error: 'cordis.patch.yml 里没有 dsh-onebot 条目' } };
    const configIndex = lines.findIndex((line, index) => index > range.start && index < range.end && /^(\s+)config:\s*$/.test(line));
    if (configIndex === -1)
        return { status: 400, payload: { ok: false, error: 'dsh-onebot 条目没有独立的 config 块，拒绝按行改写' } };

    const configIndent = /^(\s*)config:/.exec(lines[configIndex])[1];
    const fallbackIndent = configIndent + '  ';

    // 优先原位替换：保住原有行位置和缩进，改回原值后文件才能逐字节一致。
    let policyIndex = -1;
    let allowIndex = -1;
    let allowEnd = -1;
    for (let index = range.start + 1; index < range.end; index += 1) {
        const line = lines[index];
        if (policyIndex === -1 && /^\s+groupPolicy:\s*/.test(line))
            policyIndex = index;
        if (allowIndex !== -1)
            continue;
        const head = /^(\s+)groupAllowFrom:\s*(.*)$/.exec(line);
        if (head === null)
            continue;
        allowIndex = index;
        allowEnd = index;
        if (head[2].trim() !== '')
            continue;
        const indent = head[1].length;
        for (let cursor = index + 1; cursor < range.end; cursor += 1) {
            const item = /^(\s+)-\s*/.exec(lines[cursor]);
            if (item === null || item[1].length <= indent)
                break;
            allowEnd = cursor;
        }
    }

    const policyIndent = policyIndex === -1
        ? (allowIndex === -1 ? fallbackIndent : /^\s*/.exec(lines[allowIndex])[0])
        : /^\s*/.exec(lines[policyIndex])[0];
    const allowIndent = allowIndex === -1 ? policyIndent : /^\s*/.exec(lines[allowIndex])[0];
    const policyLines = [policyIndent + 'groupPolicy: ' + policy];
    const groupLines = groups.length === 0
        ? [allowIndent + 'groupAllowFrom: []']
        : [allowIndent + 'groupAllowFrom:', ...groups.map(gid => allowIndent + '  - "' + gid + '"')];

    if (policyIndex === -1 && allowIndex === -1) {
        // 两行都不存在时才新建，位置在 config 行之后。
        lines.splice(configIndex + 1, 0, ...policyLines, ...groupLines);
    }
    else if (policyIndex !== -1 && allowIndex !== -1) {
        // 从后往前替换，避免前面的改动挤动后面的索引。
        const edits = [
            { start: policyIndex, end: policyIndex, payload: policyLines },
            { start: allowIndex, end: allowEnd, payload: groupLines },
        ].sort((a, b) => b.start - a.start);
        for (const edit of edits)
            lines.splice(edit.start, edit.end - edit.start + 1, ...edit.payload);
    }
    else if (policyIndex !== -1) {
        lines.splice(policyIndex, 1, ...policyLines);
        lines.splice(policyIndex + 1, 0, ...groupLines);
    }
    else {
        lines.splice(allowIndex, allowEnd - allowIndex + 1, ...policyLines, ...groupLines);
    }
    const next = lines;

    let backup = null;
    try {
        mkdirSync(BACKUP_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        backup = join(BACKUP_DIR, 'cordis.patch-' + stamp + '.yml');
        copyFileSync(CORDIS_PATCH_PATH, backup);
        const temporary = CORDIS_PATCH_PATH + '.tmp-' + process.pid;
        writeFileSync(temporary, next.join(eol), 'utf8');
        renameSync(temporary, CORDIS_PATCH_PATH);
    }
    catch (error) {
        return { status: 500, payload: { ok: false, error: '写入失败：' + String(error?.message ?? error) } };
    }

    return {
        status: 200,
        payload: {
            ok: true,
            message: '已写入 cordis.patch.yml，重启 dsh 后生效',
            restartRequired: true,
            path: CORDIS_PATCH_PATH,
            policy,
            groups,
            backup,
            mtime: safeStat(CORDIS_PATCH_PATH).mtime,
        },
    };
}

/* -------------------------------------------------------------------- 日志 */

const LOG_GROUPS = {
    plugin: { label: 'qq-onebot 插件（旧栈）', dir: join(PLUGIN_DIR, 'logs'), dynamic: true },
    onebot: { label: 'OneBot 协议端', dir: ONEBOT_LOG_DIR, dynamic: true },
    proxy: { label: 'persona proxy', dir: PERSONA_DIR, files: ['proxy.log', 'proxy.stdout.log', 'proxy.stderr.log'] },
    script: { label: '启停脚本', dir: BRIDGE_WORK, files: ['start-dsh.log', 'stop-dsh.log', 'onebot.out.log'] },
    engine: { label: 'ninfer 引擎', dir: ENGINE_LOG_DIR, dynamic: true },
    harness: { label: '宿主守护', dir: BRIDGE_WORK, files: ['harness.watchdog.log', 'onebot.out.log'] },
    console: { label: '控制台', dir: CONSOLE_DIR, files: ['console.watchdog.log', 'console.out.log', 'console.err.log'] },
    comfyui: { label: 'ComfyUI', dir: PERSONA_DIR, files: ['comfyui.log', 'comfyui.out.log', 'comfyui.err.log'] },
    state: {
        label: '状态文件',
        dir: PERSONA_DIR,
        files: ['conversation-feed.jsonl', 'shared-feed.jsonl', 'defer-queue.json', 'state.json', 'upstream-faults.jsonl', 'bili-state.json', 'scheduler-state.json'],
    },
    memory: { label: '记忆访问', dir: PERSONA_DIR, files: ['memory-access.jsonl'] },
    draw: { label: '出图审图', dir: ASTRBOT_PERSONA_DIR, files: ['draw-review.jsonl'] },
    astrbot: {
        label: 'AstrBot 审计',
        dir: ASTRBOT_AUDIT_DIR,
        files: ['inbound.jsonl', 'turns.jsonl', 'outbound.jsonl', 'llm_request.jsonl', 'persona.jsonl', 'history_writeback.jsonl', 'sent.jsonl'],
    },
    'astrbot-log': { label: 'AstrBot 日志', dir: join(ASTRBOT_DATA_DIR, 'logs'), files: ['astrbot.log'] },
};

function listLogComponents() {
    const out = [];
    for (const [groupId, spec] of Object.entries(LOG_GROUPS)) {
        let names = spec.files ?? [];
        if (spec.dynamic) {
            try {
                names = readdirSync(spec.dir).filter(name => name.endsWith('.log'));
            }
            catch {
                names = [];
            }
        }
        for (const name of names) {
            const path = join(spec.dir, name);
            const st = safeStat(path);
            out.push({
                id: groupId + '/' + name,
                label: spec.label + ' · ' + name,
                path,
                exists: st.exists,
                size: st.size,
                mtime: st.mtime,
            });
        }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
}

function resolveLogComponent(id) {
    if (typeof id !== 'string' || !id.includes('/'))
        return null;
    const slash = id.indexOf('/');
    const groupId = id.slice(0, slash);
    const name = id.slice(slash + 1);
    const spec = LOG_GROUPS[groupId];
    if (!spec || name === '' || name.includes('/') || name.includes('\\'))
        return null;
    const path = join(spec.dir, name);
    if (resolve(dirname(path)) !== resolve(spec.dir))
        return null;
    return { id, label: spec.label + ' · ' + name, path };
}

function logContent(id, lines, keyword) {
    const target = resolveLogComponent(id);
    if (!target)
        throw new Error('未知日志组件: ' + String(id));
    const st = safeStat(target.path);
    if (!st.exists)
        throw new Error('日志文件不存在: ' + target.path);
    const { text, bytes, truncated, size } = readTailText(target.path, 512 * 1024);
    let all = text.split(/\r?\n/).filter(line => line !== '');
    const total = all.length;
    const needle = String(keyword ?? '').trim().toLowerCase();
    if (needle !== '')
        all = all.filter(line => line.toLowerCase().includes(needle));
    const matched = all.length;
    const take = Math.min(Math.max(Number(lines) || 200, 10), 2000);
    const selected = all.slice(-take);
    return {
        ok: true,
        id: target.id,
        label: target.label,
        path: target.path,
        size,
        mtime: st.mtime,
        readBytes: bytes,
        fileTruncated: truncated,
        totalInWindow: total,
        matched,
        returned: selected.length,
        text: selected.join('\n'),
    };
}

/* -------------------------------------------------------------------- 人格 */

function characterPayload() {
    const st = safeStat(CHARACTER_PATH);
    if (!st.exists)
        throw new Error('人格文件不存在: ' + CHARACTER_PATH);
    return {
        ok: true,
        path: CHARACTER_PATH,
        mtime: st.mtime,
        size: st.size,
        text: readFileSync(CHARACTER_PATH, 'utf8'),
    };
}

function saveCharacter(body) {
    if (body?.confirm !== true)
        return { status: 400, payload: { ok: false, error: '缺少 confirm:true，未写入' } };
    if (typeof body.text !== 'string' || body.text.trim() === '')
        return { status: 400, payload: { ok: false, error: '内容不能为空' } };
    const st = safeStat(CHARACTER_PATH);
    if (!st.exists)
        return { status: 404, payload: { ok: false, error: '人格文件不存在: ' + CHARACTER_PATH } };
    try {
        mkdirSync(BACKUP_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        copyFileSync(CHARACTER_PATH, join(BACKUP_DIR, 'character-' + stamp + '.md'));
        const tmp = CHARACTER_PATH + '.tmp-' + process.pid;
        writeFileSync(tmp, body.text, 'utf8');
        renameSync(tmp, CHARACTER_PATH);
    }
    catch (error) {
        return { status: 500, payload: { ok: false, error: '写入失败: ' + String(error?.message ?? error) } };
    }
    const next = safeStat(CHARACTER_PATH);
    return {
        status: 200,
        payload: {
            ok: true,
            message: '人格文件已保存（旧版本已备份到 backups/）',
            path: CHARACTER_PATH,
            size: next.size,
            mtime: next.mtime,
        },
    };
}

/* -------------------------------------------------------------------- 操作 */

const ACTIONS = {
    start: { label: '启动', steps: [{ ps1: START_PS1, args: [], timeoutMs: 900000 }], log: join(BRIDGE_WORK, 'start-bot.log') },
    stop: { label: '停止', steps: [{ ps1: STOP_PS1, args: [], timeoutMs: 180000 }], log: join(BRIDGE_WORK, 'stop-dsh.log') },
    restart: {
        label: '重启',
        steps: [
            { ps1: STOP_PS1, args: [], timeoutMs: 180000 },
            { ps1: START_PS1, args: [], timeoutMs: 900000 },
        ],
        log: join(BRIDGE_WORK, 'start-bot.log'),
    },
    // 只重启引擎，不动 proxy / 宿主：闩锁恢复走这条，和手工命令完全同一条出口。
    'engine-restart': {
        label: '重启引擎',
        steps: [{ ps1: ENGINE_CONTROL_SCRIPT, args: ['-Action', 'restart'], timeoutMs: 600000 }],
        log: join(ENGINE_LOG_DIR, 'engine-control.log'),
    },
};

let actionBusy = null;

async function runAction(name) {
    if (actionBusy !== null)
        return { status: 409, payload: { ok: false, error: '已有操作在执行：' + actionBusy + '，请等它结束' } };

    if (name === 'reload') {
        actionBusy = 'reload';
        try {
            const file = loadConfigFile(CONFIG_PATH);
            if (!file.ok)
                return {
                    status: 400,
                    payload: { ok: false, error: '配置本身不合法，拒绝热重载', errors: file.errors },
                };
            if (!writeJsonAtomic(CONFIG_PATH, file.raw))
                return { status: 500, payload: { ok: false, error: '原子写入失败，插件不会重载' } };
            await new Promise(resolvePromise => setTimeout(resolvePromise, 900));
            const logFile = newestPluginLog();
            const tail = logFile ? tailLines(join(PLUGIN_DIR, 'logs', logFile.name), 20) : [];
            const reloaded = tail.some(line => line.includes('配置已加载') || line.includes('热重载'));
            return {
                status: 200,
                payload: {
                    ok: true,
                    action: 'reload',
                    message: reloaded
                        ? '已原子重写 config.json，插件日志已出现热重载记录'
                        : '已原子重写 config.json；插件 watch 会在 0.3 秒内重载（日志暂无记录）',
                    durationMs: 900,
                    output: tail.join('\n'),
                    log: logFile ? 'plugin/' + logFile.name : '',
                },
            };
        }
        finally {
            actionBusy = null;
        }
    }

    const action = ACTIONS[name];
    if (!action)
        return { status: 400, payload: { ok: false, error: '未知操作: ' + String(name) } };

    actionBusy = name;
    const startedAt = Date.now();
    const chunks = [];
    try {
        for (const step of action.steps) {
            if (!existsSync(step.ps1)) {
                chunks.push('[失败] 找不到脚本: ' + step.ps1);
                return {
                    status: 500,
                    payload: {
                        ok: false,
                        action: name,
                        error: '找不到脚本: ' + step.ps1,
                        output: chunks.join('\n'),
                        durationMs: Date.now() - startedAt,
                    },
                };
            }
            chunks.push('> powershell -ExecutionPolicy Bypass -File "' + step.ps1 + '"');
            const result = await runCommand('powershell.exe', [
                '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', step.ps1,
                ...step.args,
            ], { timeoutMs: step.timeoutMs });
            if (result.stdout.trim() !== '')
                chunks.push(result.stdout.trim());
            if (result.stderr.trim() !== '')
                chunks.push('[stderr] ' + result.stderr.trim());
            if (result.timedOut)
                chunks.push('[超时] ' + step.ps1 + ' 超过 ' + Math.round(step.timeoutMs / 1000) + ' 秒');
            if (result.code !== 0) {
                const tail = tailLines(action.log, 25);
                return {
                    status: 500,
                    payload: {
                        ok: false,
                        action: name,
                        error: basename(step.ps1) + ' 退出码 ' + result.code + (result.timedOut ? '（超时）' : ''),
                        output: chunks.join('\n'),
                        logTail: tail.join('\n'),
                        log: 'script/' + basename(action.log),
                        durationMs: Date.now() - startedAt,
                    },
                };
            }
        }
        const tail = tailLines(action.log, 25);
        return {
            status: 200,
            payload: {
                ok: true,
                action: name,
                message: action.label + '完成',
                output: chunks.join('\n'),
                logTail: tail.join('\n'),
                log: 'script/' + basename(action.log),
                durationMs: Date.now() - startedAt,
            },
        };
    }
    finally {
        actionBusy = null;
    }
}

/* -------------------------------------------------------------------- HTTP */

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
};

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
    });
    res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
    res.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(text),
    });
    res.end(text);
}

function readBody(req, limit = 2 * 1024 * 1024) {
    return new Promise((resolvePromise, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > limit) {
                reject(new Error('请求体超过 2MB'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (text.trim() === '')
                return resolvePromise({});
            try {
                resolvePromise(JSON.parse(text));
            }
            catch (error) {
                reject(new Error('请求体不是合法 JSON: ' + (error?.message ?? String(error))));
            }
        });
        req.on('error', reject);
    });
}

function serveStatic(res, pathname) {
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const target = resolve(join(PUBLIC_DIR, relative));
    if (resolve(PUBLIC_DIR) !== dirname(target) && !target.startsWith(resolve(PUBLIC_DIR) + '\\'))
        return sendText(res, 403, '禁止访问');
    const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
    if (!existsSync(target) || !statSync(target).isFile()) {
        return sendText(res, 404, '页面不存在: ' + pathname + '\n如果你刚改过前端文件，请刷新或重启控制台。', 'text/plain; charset=utf-8');
    }
    return sendText(res, 200, readFileSync(target), type);
}

function isLoopback(req) {
    const address = req.socket.remoteAddress ?? '';
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

const server = http.createServer(async (req, res) => {
    if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: '只允许本机访问' });
        return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    try {
        if (!pathname.startsWith('/api/')) {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                sendJson(res, 405, { ok: false, error: '静态资源只支持 GET' });
                return;
            }
            serveStatic(res, pathname);
            return;
        }

        if (pathname === '/api/health' && req.method === 'GET') {
            sendJson(res, 200, { ok: true, service: 'qq-console', host: HOST, port: PORT, now: new Date().toISOString() });
            return;
        }

        if (pathname === '/api/cutover' && req.method === 'GET') {
            const cutoverPath = join(CONSOLE_DIR, 'state', 'cutover.json');
            try {
                if (!existsSync(cutoverPath)) {
                    sendJson(res, 503, { ok: false, error: 'cutover.json missing' });
                    return;
                }
                const raw = readFileSync(cutoverPath, 'utf8');
                res.writeHead(200, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': 'no-store',
                });
                res.end(raw);
            } catch (err) {
                sendJson(res, 503, { ok: false, error: 'cutover.json unreadable', detail: String(err && err.message || err) });
            }
            return;
        }

        if (pathname === '/api/status' && req.method === 'GET') {
            sendJson(res, 200, await componentStatus());
            return;
        }

        if (pathname === '/api/topology' && req.method === 'GET') {
            sendJson(res, 200, await topologySnapshot());
            return;
        }

        if (pathname === '/api/windows' && req.method === 'GET') {
            const report = await windowCheck(url.searchParams.get('fresh') === '1');
            sendJson(res, 200, {
                script: WINDOW_CHECK_SCRIPT,
                ...report,
                ok: true,
                healthy: report.ok !== false,
            });
            return;
        }

        if (pathname === '/api/shadow' && req.method === 'GET') {
            const limit = Number(url.searchParams.get('limit') ?? '30');
            const scope = url.searchParams.get('scope') ?? 'all';
            const chatId = url.searchParams.get('chatId') ?? '';
            const excludeSamples = url.searchParams.get('excludeSamples') === '1';
            sendJson(res, 200, shadowOverview({ limit, scope, chatId, excludeSamples }));
            return;
        }

        if (pathname === '/api/r6' && req.method === 'GET') {
            const result = readJsonSafe(R6_RESULT_PATH);
            sendJson(res, 200, {
                ok: true,
                exists: result !== null,
                path: R6_RESULT_PATH,
                result,
            });
            return;
        }

        if (pathname === '/api/shadow/compare' && req.method === 'POST') {
            const body = await readBody(req);
            sendJson(res, 200, await runCompare(body?.excludeSamples === true));
            return;
        }

        if (pathname === '/api/groups' && req.method === 'GET') {
            const payload = groupAccessPayload();
            sendJson(res, payload.ok ? 200 : 404, payload);
            return;
        }

        if (pathname === '/api/groups' && req.method === 'POST') {
            const body = await readBody(req);
            const result = saveGroupAccess(body);
            sendJson(res, result.status, result.payload);
            return;
        }

        if (pathname === '/api/config' && req.method === 'GET') {
            sendJson(res, 200, configPayload());
            return;
        }

        if (pathname === '/api/config' && req.method === 'POST') {
            const body = await readBody(req);
            const result = saveConfig(body);
            sendJson(res, result.status, result.payload);
            return;
        }

        if (pathname === '/api/logs' && req.method === 'GET') {
            sendJson(res, 200, { ok: true, components: listLogComponents() });
            return;
        }

        if (pathname === '/api/logs/content' && req.method === 'GET') {
            const id = url.searchParams.get('id') ?? '';
            const lines = Number(url.searchParams.get('lines') ?? '200');
            const keyword = url.searchParams.get('q') ?? '';
            sendJson(res, 200, logContent(id, lines, keyword));
            return;
        }

        if (pathname === '/api/character' && req.method === 'GET') {
            sendJson(res, 200, characterPayload());
            return;
        }

        if (pathname === '/api/character' && req.method === 'PUT') {
            const body = await readBody(req);
            const result = saveCharacter(body);
            sendJson(res, result.status, result.payload);
            return;
        }

        if (pathname === '/api/night-quiet' && req.method === 'GET') {
            // 夜间静默窗口：配置读 xzy-config 的 night_quiet，记录读 audit/night-quiet.jsonl。
            const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') ?? '20') || 20, 100));
            sendJson(res, 200, nightQuietPayload(limit));
            return;
        }

        if (pathname === '/api/media-video' && req.method === 'GET') {
            // 群内本地视频的结构化阅读记录（qq_read_video 成功/失败都写一行）
            const path = join(ASTRBOT_AUDIT_DIR, 'media_video.jsonl');
            const stat = safeStat(path);
            if (!stat) {
                sendJson(res, 200, { ok: false, error: '查不到 ' + path, source: path, rows: [] });
                return;
            }
            const rows = readJsonlLinesQuiet(path, 100).reverse();
            sendJson(res, 200, { ok: true, source: path, mtime: stat.mtime, rows });
            return;
        }

        if (pathname === '/api/bili' && req.method === 'GET') {
            // verify=1 才会真的去问 B 站；普通轮询只用缓存状态，不反复打接口。
            const verify = url.searchParams.get('verify') === '1';
            const state = readJsonSafe(join(ASTRBOT_PERSONA_DIR, 'bili-state.json')) ?? {};
            const proactiveLive = biliProactiveLive();
            const history = biliRows(state, proactiveLive);
            const today = biliTodayFromRows(history);
            // 当日按触发方式拆分：主动刷直接取插件状态，剩下的算被要求刷。
            const byMode = {
                proactive: {
                    count: proactiveLive.today.count,
                    bytes: proactiveLive.today.bytes,
                    totalMs: proactiveLive.today.totalMs,
                },
                requested: {
                    count: Math.max(0, today.count - proactiveLive.today.count),
                    bytes: Math.max(0, today.bytes - proactiveLive.today.bytes),
                    totalMs: Math.max(0, today.totalMs - proactiveLive.today.totalMs),
                },
            };
            const all = [...history].reverse();
            const size = Math.max(5, Math.min(Number(url.searchParams.get('size') ?? '20') || 20, 100));
            const pages = Math.max(1, Math.ceil(all.length / size));
            const page = Math.max(1, Math.min(Number(url.searchParams.get('page') ?? '1') || 1, pages));
            const account = await accountStatus({ fresh: verify });
            sendJson(res, 200, {
                ok: true,
                today,
                byMode,
                proactive: proactiveLive,
                disk: biliDiskStatus(),
                account,
                total: all.length,
                page,
                size,
                pages,
                items: all.slice((page - 1) * size, page * size),
                statePath: join(ASTRBOT_PERSONA_DIR, 'bili-state.json'),
                accountPath: join(PERSONA_DIR, 'bili-account.json'),
            });
            return;
        }

        if (pathname === '/api/bili/account' && req.method === 'POST') {
            const body = await readBody(req);
            try {
                const account = await bindAccount(body?.sessdata);
                sendJson(res, 200, {
                    ok: true,
                    message: '绑定成功：' + (account.uname || '未知') + '（mid ' + (account.mid ?? '—') + '）',
                    account,
                });
            }
            catch (error) {
                // 失效/无效的 SESSDATA 明确报错，不写盘、不冒充已登录。
                sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
            }
            return;
        }

        if (pathname === '/api/bili/account' && req.method === 'DELETE') {
            await unbindAccount();
            sendJson(res, 200, { ok: true, message: '已解绑，回到未登录（720p）' });
            return;
        }

        if (pathname === '/api/bili/account/verify' && req.method === 'POST') {
            const account = await accountStatus({ fresh: true });
            if (account.warning) {
                sendJson(res, 502, { ok: false, error: account.warning, account });
            }
            else if (account.status === 'ok') {
                sendJson(res, 200, { ok: true, message: '当前身份：' + account.uname + '（mid ' + account.mid + '）', account });
            }
            else if (account.status === 'anonymous') {
                sendJson(res, 400, { ok: false, error: '还没有绑定 B 站账号（当前未登录，720p 上限）', account });
            }
            else {
                sendJson(res, 400, { ok: false, error: 'SESSDATA 已失效：' + (account.error || '账号未登录'), account });
            }
            return;
        }

        if (pathname === '/api/bili/proactive' && req.method === 'POST') {
            // 主动刷引擎已迁到 AstrBot 插件（bili_proactive.py）。控制台只展示插件落盘状态，
            // 暂停/恢复写回同一份状态文件（插件每个 tick 会重新读取），不再另起旧 Node 引擎，
            // 否则两套引擎会各自计数、各自下载。
            const body = await readBody(req);
            const action = String(body?.action ?? 'run');
            if (action === 'pause' || action === 'resume') {
                const state = readJsonSafe(BILI_PROACTIVE_STATE_PATH);
                if (state === null || typeof state !== 'object') {
                    sendJson(res, 409, { ok: false, error: '读不到主动刷状态文件：' + BILI_PROACTIVE_STATE_PATH });
                    return;
                }
                state.paused = action === 'pause';
                state.updatedAt = new Date().toISOString();
                if (!writeJsonAtomic(BILI_PROACTIVE_STATE_PATH, state)) {
                    sendJson(res, 500, { ok: false, error: '写主动刷状态文件失败，未能' + (action === 'pause' ? '暂停' : '恢复') });
                    return;
                }
                sendJson(res, 200, { ok: true, paused: state.paused, proactive: biliProactiveLive() });
                return;
            }
            if (action !== 'run') {
                sendJson(res, 400, { ok: false, error: '未知动作：' + action });
                return;
            }
            sendJson(res, 409, {
                ok: false,
                error: '主动刷由 AstrBot 插件调度（bili_proactive.enabled 控制），控制台不再另起旧引擎；面板只读，暂停/恢复可用。',
                proactive: biliProactiveLive(),
            });
            return;
        }

        if (pathname === '/api/self-iter' && req.method === 'GET') {
            // plugin 字段是自动触发的真实落盘（auto-state/ledger/proposals）；
            // 顶层仍给旧模块结构，避免「最近运行」明细断掉。
            sendJson(res, 200, { ...(await selfIter.status()), plugin: pluginSelfIterSnapshot() });
            return;
        }

        if (pathname === '/api/self-iter' && req.method === 'POST') {
            const body = await readBody(req);
            const action = String(body?.action ?? 'run');
            if (action === 'pause' || action === 'resume') {
                await selfIter.updateConfig({ enabled: action === 'resume' });
                sendJson(res, 200, { ok: true, ...(await selfIter.status()) });
                return;
            }
            if (action === 'run') {
                const result = await selfIter.runOnce({ force: body?.force === true, trigger: 'manual' });
                sendJson(res, result.ok ? 200 : 409, { ...result, status: await selfIter.status() });
                return;
            }
            if (action === 'approve' || action === 'reject' || action === 'rollback') {
                const id = String(body?.id ?? '');
                const result = action === 'approve'
                    ? await selfIter.approveProposal(id, 'master')
                    : (action === 'reject'
                        ? await selfIter.rejectProposalById(id, 'master', String(body?.reason ?? 'manual'))
                        : await selfIter.rollbackProposalById(id, 'master'));
                sendJson(res, result.ok ? 200 : 409, { ...result, status: await selfIter.status() });
                return;
            }
            sendJson(res, 400, { ok: false, error: '未知动作：' + action });
            return;
        }

        if (pathname === '/api/self-iter/config' && req.method === 'PUT') {
            const body = await readBody(req);
            const config = await selfIter.updateConfig(body ?? {});
            sendJson(res, 200, { ok: true, config });
            return;
        }

        if (pathname === '/api/action' && req.method === 'POST') {
            const body = await readBody(req);
            const result = await runAction(String(body?.name ?? ''));
            sendJson(res, result.status, result.payload);
            return;
        }

        sendJson(res, 404, { ok: false, error: '接口不存在: ' + pathname });
    }
    catch (error) {
        const message = error?.message ?? String(error);
        if (!res.headersSent) {
            sendJson(res, 500, { ok: false, error: message });
        }
        else {
            try {
                res.end();
            }
            catch {
                // ignore
            }
        }
    }
});

server.on('error', error => {
    console.error('[qq-console] 服务启动失败：' + (error?.message ?? String(error)));
    process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
    console.log('[qq-console] 已启动：http://' + HOST + ':' + PORT + ' pid=' + process.pid);
    console.log('[qq-console] 配置：' + CONFIG_PATH);
    console.log('[qq-console] 影子：' + SHADOW_PATH);
    // 后台健康巡检：不用打开面板也能收到「组件挂了 / 恢复」的桌面提醒。
    // 同一故障 60 秒宽限后提醒一次，之后每 15 分钟重复一次，恢复时再提醒一次。
    setInterval(async () => {
        try {
            await componentStatus({ monitor: true });
        }
        catch (error) {
            console.error('[qq-console] 健康巡检失败：' + (error instanceof Error ? error.message : String(error)));
        }
    }, HEALTH_MONITOR_MS).unref();
    // 主动刷已由 AstrBot 插件内置调度执行；控制台不再启动旧 Node 引擎，避免双引擎重复选片/下载。
    // 面板只读，暂停/恢复通过 /api/bili/proactive 写回插件状态文件。
    // 闲时自迭代：独立 60 秒 tick，不依赖任何 QQ 消息；关掉用配置 enabled=false。
    const selfIterWatcher = selfIter.createWatcher({
        log: message => console.log('[qq-console] ' + message),
    });
    selfIterWatcher.start();
});
