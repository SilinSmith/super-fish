/**
 * 低负载主动刷 B 站 + 主动分享。
 *
 * 只在「完全没人用它」的时候动一下：一次 1 个视频、720p、最多 12 帧、打标沿用 1.2s 间隔；
 * 一旦有真实对话或 GPU 被占用立刻让路（下载中直接中断，帧处理阶段直接丢掉不排队）。
 *
 * 冷却与配额沿用宿主已有的主动事件机制：读 proactive-state.json 的 lastSelfActionAt 当全局冷却；
 * 自己的 30 分钟间隔 / 每小时 2 条 / 分享配额与去重写在 bili-proactive.json（宿主不写这个文件，
 * 避免两边同时改同一个文件互相覆盖）。
 */
import { readFileSync } from 'node:fs';
import { appendFile, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { diskStatus, localDay, pickProactive, watch } from './bili.mjs';
import { readLease } from './gpu-lease.mjs';
import { createTask, readTasks, writeTasks } from './tasks-store.mjs';

const HOME = 'Y:\\dsh\\home\\qq-persona';
const PROXY_QUEUE_URL = process.env.QQ_PROXY_QUEUE_URL ?? 'http://127.0.0.1:1240/internal/queue';
const DEFER_PATH = process.env.QQ_DEFER_PATH ?? join(HOME, 'defer-queue.json');
const VISION_STATE_PATH = process.env.QQ_VISION_STATE ?? join(HOME, 'vision-state.json');
const HOST_PROACTIVE_STATE = process.env.QQ_PROACTIVE_STATE ?? join(HOME, 'proactive-state.json');
const BILI_STATE_PATH = process.env.QQ_BILI_STATE ?? join(HOME, 'bili-state.json');
const PREFS_PATH = process.env.QQ_BILI_PREFS ?? join(HOME, 'bili-prefs.json');
const STATE_PATH = process.env.QQ_BILI_PROACTIVE_STATE ?? join(HOME, 'bili-proactive.json');
const LOG_PATH = process.env.QQ_BILI_PROACTIVE_LOG ?? join(HOME, 'bili-proactive.jsonl');

const MIN_GAP_MS = 30 * 60_000;
const MAX_PER_HOUR = 2;
const VISION_QUIET_MS = 30_000;
const YIELD_POLL_MS = 3_000;
const TAG_TIMEOUT_MS = 150_000;
const HISTORY_VIDEOS_LIMIT = 300;

const DEFAULT_TARGETS = [
    { kind: 'group', id: '100000004', name: 'AIVC（学生自发团队）', perDay: 1 },
    { kind: 'group', id: '100000001', name: '商用大肥鱼交流群', perDay: 0 },
    { kind: 'private', id: '10000', name: '主人', perDay: 1 },
];

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return null;
    }
}

async function readState() {
    const parsed = readJson(STATE_PATH);
    const today = localDay();
    const state = {
        day: String(parsed?.day ?? ''),
        count: Number(parsed?.count ?? 0),
        bytes: Number(parsed?.bytes ?? 0),
        totalMs: Number(parsed?.totalMs ?? 0),
        hourly: Array.isArray(parsed?.hourly) ? parsed.hourly.filter(item => typeof item === 'string') : [],
        lastAt: String(parsed?.lastAt ?? ''),
        lastRun: parsed?.lastRun ?? null,
        lastAbort: parsed?.lastAbort ?? null,
        lastGate: parsed?.lastGate ?? null,
        lastShare: parsed?.lastShare ?? null,
        lastShareTarget: String(parsed?.lastShareTarget ?? ''),
        paused: parsed?.paused === true,
        shares: {
            day: String(parsed?.shares?.day ?? ''),
            byChat: parsed?.shares?.byChat !== null && typeof parsed?.shares?.byChat === 'object'
                ? { ...parsed.shares.byChat }
                : {},
            videos: parsed?.shares?.videos !== null && typeof parsed?.shares?.videos === 'object'
                ? { ...parsed.shares.videos }
                : {},
        },
    };
    if (state.day !== today) {
        state.day = today;
        state.count = 0;
        state.bytes = 0;
        state.totalMs = 0;
    }
    if (state.shares.day !== today) {
        state.shares.day = today;
        state.shares.byChat = {};
    }
    return state;
}

async function writeState(state) {
    const payload = JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2) + '\n';
    await mkdir(dirname(STATE_PATH), { recursive: true });
    await writeFile(STATE_PATH + '.tmp', payload, 'utf8');
    await rename(STATE_PATH + '.tmp', STATE_PATH);
}

let logChain = Promise.resolve();

/** 结构化日志：每个动作一行，面板/排查直接看这个文件。 */
export function logEvent(entry) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    logChain = logChain.then(async () => {
        await mkdir(dirname(LOG_PATH), { recursive: true });
        await appendFile(LOG_PATH, line, 'utf8');
    }).catch(() => undefined);
    return logChain;
}

async function prefs() {
    return readJson(PREFS_PATH) ?? {};
}

function shareTargets(doc) {
    const list = Array.isArray(doc?.shareTargets) ? doc.shareTargets : DEFAULT_TARGETS;
    return list
        .filter(item => item !== null && typeof item === 'object')
        .map(item => ({
            kind: item.kind === 'private' ? 'private' : 'group',
            id: String(item.id ?? '').trim(),
            name: String(item.name ?? ''),
            perDay: Math.max(0, Number(item.perDay) || 0),
        }))
        .filter(item => /^\d{5,12}$/u.test(item.id));
}

function chatKeyOf(target) {
    return target.kind + ':' + target.id;
}

/** 模型回合 / defer / GPU：这三个是「立刻让路」的信号，也用于开刷前判定。 */
async function activityProbe() {
    const reasons = [];
    let queueOk = true;
    try {
        const response = await fetch(PROXY_QUEUE_URL, { signal: AbortSignal.timeout(2500) });
        const data = await response.json();
        if (Number(data?.active ?? 0) > 0)
            reasons.push('有进行中的模型回合（' + data.active + '）');
        if (Number(data?.waiting ?? 0) > 0)
            reasons.push('模型请求排队（' + data.waiting + '）');
    }
    catch {
        queueOk = false;
        reasons.push('模型网关不可达，无法确认空闲');
    }
    const defer = readJson(DEFER_PATH);
    const deferred = Object.values(defer?.groups ?? {})
        .reduce((total, group) => total + (Array.isArray(group?.items) ? group.items.length : 0), 0);
    if (deferred > 0)
        reasons.push('defer 队列还有 ' + deferred + ' 条');
    const lease = await readLease();
    if (lease !== undefined)
        reasons.push('GPU 租约在 ' + String(lease.owner ?? '别人') + ' 手上');
    return { ok: reasons.length === 0, reasons, queueOk, deferred };
}

async function visionQuiet() {
    try {
        const info = await stat(VISION_STATE_PATH);
        const age = Date.now() - info.mtimeMs;
        if (age < VISION_QUIET_MS)
            return { quiet: false, reason: '视觉队列刚有活动（' + Math.round(age / 1000) + 's 前）' };
        return { quiet: true, reason: '' };
    }
    catch {
        // 还没有 vision-state 文件 = 从没打过标，算安静。
        return { quiet: true, reason: '' };
    }
}

async function hostLastSelfActionAt() {
    const doc = readJson(HOST_PROACTIVE_STATE);
    const value = Number(doc?.lastSelfActionAt ?? 0);
    return Number.isFinite(value) ? value : 0;
}

/** 开刷前的完整闸门；force 只跳过「间隔 / 每小时配额」，负载类闸门一律不跳。 */
export async function gateStatus({ force = false } = {}) {
    const state = await readState();
    const doc = await prefs();
    const reasons = [];
    const now = Date.now();
    if (state.paused)
        reasons.push('主动刷已暂停');
    const activity = await activityProbe();
    reasons.push(...activity.reasons);
    const vision = await visionQuiet();
    if (!vision.quiet)
        reasons.push(vision.reason);
    const disk = await diskStatus();
    if (disk.paused)
        reasons.push(disk.reason);
    const last = Math.max(
        state.lastAt === '' ? 0 : Date.parse(state.lastAt) || 0,
        await hostLastSelfActionAt(),
    );
    if (!force && last > 0 && now - last < MIN_GAP_MS)
        reasons.push('距上次主动动作不足 30 分钟（还要 '
            + Math.ceil((MIN_GAP_MS - (now - last)) / 60_000) + ' 分钟）');
    state.hourly = state.hourly.filter(item => now - Date.parse(item) < 3600_000);
    if (!force && state.hourly.length >= MAX_PER_HOUR)
        reasons.push('这一小时已经主动刷了 ' + state.hourly.length + ' 条');
    return {
        ok: reasons.length === 0,
        reasons,
        disk,
        activity,
        vision,
        hourly: state.hourly.length,
        lastActionAt: last > 0 ? new Date(last).toISOString() : '',
        targets: shareTargets(doc),
        state,
    };
}

/** 只挑一条：排除看过的 bvid，按 UP 权重 + 关注加成 + 标题权重排序。 */
async function chooseVideo() {
    const biliState = readJson(BILI_STATE_PATH);
    const history = Array.isArray(biliState?.history)
        ? biliState.history
        : (Array.isArray(biliState?.recent) ? biliState.recent : []);
    const watched = history.map(row => String(row?.bvid ?? '')).filter(Boolean);
    return pickProactive({ exclude: watched });
}

/* ------------------------------------------------------------------ 交付给人格 */

/**
 * 主动分享不再由本模块发消息：把「刚看完什么」交给宿主已有的续跑回合，
 * 由人格自己决定说不说、怎么说。走的是同一条 agent 会话与 outbound，不是新通道。
 */
async function handToPersona({ target, bvid, title, summary, captions }) {
    const doc = await readTasks();
    const material = [
        String(summary ?? '').trim() === ''
            ? ''
            : '视频讲了：' + String(summary).replace(/\s+/gu, ' ').trim().slice(0, 260),
        captions.length > 0
            ? '你看到的画面：' + captions.filter(Boolean).slice(0, 4).join('；')
            : '',
    ].filter(Boolean).join('\n');
    const task = createTask(doc, {
        chatId: chatKeyOf(target),
        title: '刚看完《' + String(title ?? '').slice(0, 40) + '》，想提就随口说一句',
        brief: '这不是工作项，也不用报进度。你刚看完这条 B 站视频（' + bvid + '），没有人点你。\n'
            + (material === '' ? '' : material + '\n')
            + '想提就用你自己的话说一两句：别贴链接、别念标题、别像播报；不想提就只输出【内心】…，这条就算了。',
        ownerRole: 'admin',
        ownerName: '主人',
        maxRuns: 1,
        maxAgeHours: 2,
    });
    await writeTasks(doc);
    return task;
}

// 降级声明（「（UP 没提供字幕，总结来自本地语音转写）」这类）只留给面板和记录，
// 由 summarySource 表达；群消息里只留标题、讲了什么、值得看的点、适合谁。
const DEGRADE_NOTE = /^（UP 没提供[\s\S]*）$/u;

function stripDegradeNote(summary) {
    return String(summary ?? '')
        .replace(/\r\n?/gu, '\n')
        .split('\n')
        .filter(line => !DEGRADE_NOTE.test(line.trim()))
        .join('\n')
        .trim();
}

/**
 * 分享文案：优先用视频级总结（讲了什么 / 值得看的点 / 适合谁看）；
 * 没有总结才退回画面描述。不贴链接、不搬简介。
 */
export function buildShareText({ title, captions, summary }) {
    const digest = stripDegradeNote(summary);
    if (digest !== '') {
        const text = '《' + String(title ?? 'B 站视频') + '》\n' + digest;
        return text.length > 360 ? text.slice(0, 358) + '…' : text;
    }
    const seen = new Set();
    const lines = [];
    for (const text of captions) {
        const clean = String(text ?? '').replace(/\s+/gu, ' ').trim()
            .replace(/^(画面里|画面中|图中)/u, '')
            .replace(/[。；;]+$/u, '');
        if (clean === '' || seen.has(clean))
            continue;
        seen.add(clean);
        lines.push(clean);
        if (lines.length >= 2)
            break;
    }
    const body = lines.length > 0
        ? '画面里' + lines[0] + (lines[1] ? '；' + lines[1] : '')
        : '画面挺有意思';
    const text = '《' + String(title ?? 'B 站视频') + '》值得看：' + body + '。';
    return text.length > 120 ? text.slice(0, 118) + '。' : text;
}

/**
 * 对话里带出刚看过的视频：复用 share(mode='contextual') 的构造，只记一条上下文提及、不发消息。
 * 调用点是 qq_bili_watch（用户让看一条视频之后），不另起一套文案或发送逻辑。
 */
export async function mentionWatched(manifest, { relevance = '' } = {}) {
    if (manifest?.ok !== true || String(manifest?.bvid ?? '') === '')
        return { ok: false, kind: 'contextual-mention', reason: '没有可带出的观看产物' };
    return share({
        bvid: manifest.bvid,
        title: manifest.title,
        summary: manifest.summary?.text ?? '',
        mode: 'contextual',
        relevance: String(relevance).trim() || '刚刚在对话里看过这条视频',
    });
}

/**
 * 分享决策：主动分享走配额 + 全局同视频只提一次；
 * 对话中带出（mode='contextual'）只做相关性判断，不做次数拦截。
 */
export async function share({ bvid, title, captions = [], summary = '', mode = 'proactive', relevance = '', only = '' } = {}) {
    const state = await readState();
    const doc = await prefs();
    const targets = shareTargets(doc);
    const text = buildShareText({ title, captions, summary });
    const key = String(bvid ?? '');
    if (mode === 'contextual') {
        if (String(relevance).trim() === '')
            return { ok: false, kind: 'contextual-mention', reason: '没有相关性依据，不提' };
        await logEvent({
            kind: 'contextual-mention',
            bvid: key,
            title,
            relevance: String(relevance).slice(0, 120),
            text,
            note: '对话中带出：不受分享配额与同视频去重限制',
        });
        return { ok: true, kind: 'contextual-mention', text };
    }
    if (key === '')
        return { ok: false, kind: 'proactive-share', reason: '没有 bvid' };
    if (state.shares.videos[key] !== undefined)
        return { ok: false, kind: 'proactive-share', reason: '同一视频已经主动分享过（全局只提一次）', sharedAt: state.shares.videos[key] };
    const eligible = targets.filter(target => {
        if (only !== '' && chatKeyOf(target) !== only)
            return false;
        const used = Number(state.shares.byChat[chatKeyOf(target)] ?? 0);
        return target.perDay === 0 || used < target.perDay;
    });
    if (eligible.length === 0)
        return { ok: false, kind: 'proactive-share', reason: '没有可用分享目标（配额用完或目标不可用）' };
    // 轮转：从上次分享目标的下一个开始，AIVC / 大肥鱼 / 主人 都有机会。
    const order = targets.map(target => chatKeyOf(target));
    const start = Math.max(0, order.indexOf(state.lastShareTarget) + 1) % targets.length;
    const rotated = [...targets.slice(start), ...targets.slice(0, start)];
    const target = rotated.find(item => eligible.includes(item));
    if (target === undefined)
        return { ok: false, kind: 'proactive-share', reason: '没有可用分享目标' };
    let task;
    try {
        task = await handToPersona({ target, bvid: key, title, summary, captions });
    }
    catch (error) {
        await logEvent({
            kind: 'proactive-share',
            bvid: key,
            title,
            target: chatKeyOf(target),
            ok: false,
            error: String(error?.message ?? error),
        });
        return { ok: false, kind: 'proactive-share', reason: String(error?.message ?? error) };
    }
    const at = new Date().toISOString();
    state.shares.videos[key] = { at, chat: chatKeyOf(target), name: target.name };
    state.shares.byChat[chatKeyOf(target)] = Number(state.shares.byChat[chatKeyOf(target)] ?? 0) + 1;
    state.lastShareTarget = chatKeyOf(target);
    state.lastShare = { at, bvid: key, title, target: chatKeyOf(target), name: target.name, taskId: task.id, material: text };
    const videos = Object.entries(state.shares.videos);
    if (videos.length > HISTORY_VIDEOS_LIMIT)
        state.shares.videos = Object.fromEntries(videos.slice(-HISTORY_VIDEOS_LIMIT));
    await writeState(state);
    await logEvent({
        kind: 'proactive-share',
        bvid: key,
        title,
        target: chatKeyOf(target),
        name: target.name,
        ok: true,
        handoff: 'task:' + task.id,
        text,
    });
    return { ok: true, kind: 'proactive-share', target: chatKeyOf(target), name: target.name, taskId: task.id };
}

/* ------------------------------------------------------------------ 等待打标 */

async function collectCaptions({ title, since, expect }) {
    const deadline = Date.now() + TAG_TIMEOUT_MS;
    let captions = [];
    while (Date.now() < deadline) {
        const doc = readJson(VISION_STATE_PATH);
        const entries = Array.isArray(doc?.entries) ? doc.entries : [];
        captions = entries
            .filter(entry => entry?.source === 'bili' && entry.video === title && Number(entry.at ?? 0) >= since)
            .map(entry => String(entry.text ?? ''));
        if (captions.length >= expect)
            return { captions, timedOut: false };
        await sleep(1_500);
    }
    return { captions, timedOut: true };
}

/* ------------------------------------------------------------------ 主流程 */

let running = false;

export async function runOnce({ force = false } = {}) {
    if (running)
        return { ok: false, reason: '已经有一次主动刷在跑' };
    running = true;
    const startedAt = Date.now();
    try {
        const gate = await gateStatus({ force });
        if (!gate.ok) {
            const reason = gate.reasons.join('；');
            const state = gate.state;
            const stamp = new Date().toISOString();
            const changed = state.lastGate?.reason !== reason;
            state.lastGate = { at: stamp, reason, ok: false };
            await writeState(state);
            if (changed)
                await logEvent({ kind: 'gate-block', reasons: gate.reasons });
            return { ok: false, reason, reasons: gate.reasons };
        }
        const choice = await chooseVideo();
        if (choice.picked === null) {
            await logEvent({ kind: 'pick-empty', pool: choice.pool });
            return { ok: false, reason: '热门池里没有可选的视频' };
        }
        const video = choice.picked;
        await logEvent({
            kind: 'pick',
            bvid: video.bvid,
            title: video.title,
            owner: video.owner,
            score: video.score,
            reason: video.score > 0 ? 'UP/关键词加权靠前' : '热门靠前',
            candidates: choice.candidates,
        });

        // 让路信号每 3 秒刷一次；watch 内部在下载/场景兜底/打标前读缓存决定是否中断。
        let busyReason = '';
        const probeTimer = setInterval(() => {
            void activityProbe().then(result => {
                busyReason = result.ok ? '' : result.reasons[0] ?? '有人在用';
            }).catch(() => undefined);
        }, YIELD_POLL_MS);
        probeTimer.unref?.();

        let manifest;
        try {
            manifest = await watch(video.bvid, {
                chatId: 'bili:proactive',
                maxFrames: 12,
                observe: true,
                triggeredBy: 'proactive',
                mode: 'proactive',
                summarize: true,
                shouldYield: () => (busyReason === '' ? false : busyReason),
            });
        }
        catch (error) {
            clearInterval(probeTimer);
            const stamp = new Date().toISOString();
            const state = await readState();
            if (error?.code === 'BILI_YIELD') {
                state.lastAbort = { at: stamp, reason: error.reason, where: error.where, bvid: video.bvid, title: video.title };
                await writeState(state);
                await logEvent({
                    kind: 'yield',
                    bvid: video.bvid,
                    title: video.title,
                    where: error.where,
                    reason: error.reason,
                    elapsedMs: Date.now() - startedAt,
                });
                return { ok: false, reason: '让路：' + error.reason, where: error.where };
            }
            throw error;
        }
        clearInterval(probeTimer);

        const state = await readState();
        const stamp = new Date().toISOString();
        state.count += 1;
        state.bytes += Number(manifest.videoBytes ?? 0);
        state.totalMs += Number(manifest.timing?.total ?? 0);
        state.lastAt = stamp;
        state.hourly = [...state.hourly, stamp].slice(-24);
        state.lastRun = {
            at: stamp,
            bvid: manifest.bvid,
            title: manifest.title,
            owner: manifest.owner,
            bytes: Number(manifest.videoBytes ?? 0),
            totalMs: Number(manifest.timing?.total ?? 0),
            frames: manifest.frames.length,
            summary: manifest.summary?.text ?? '',
            summarySource: manifest.summary?.source ?? '',
            summaryDegraded: manifest.summary?.degraded ?? '',
            sampling: manifest.sampling?.mode ?? '',
            keptFrames: manifest.sampling?.kept ?? 0,
            trimmedFrames: manifest.sampling?.trimmed ?? 0,
        };
        state.lastGate = { at: stamp, reason: '', ok: true };
        await writeState(state);
        await logEvent({
            kind: 'watched',
            bvid: manifest.bvid,
            title: manifest.title,
            owner: manifest.owner,
            frames: manifest.frames.length,
            bytes: manifest.videoBytes,
            timing: manifest.timing,
            subtitle: manifest.subtitle,
            sampling: manifest.sampling,
            summaryChars: manifest.summary?.chars ?? 0,
            summarySource: manifest.summary?.source ?? '',
            summaryDegraded: manifest.summary?.degraded ?? '',
            summaryMs: manifest.summary?.ms ?? 0,
        });

        // 总结层已经等过这批帧打完标，这里只在没有总结时兜底等画面描述。
        const tagging = manifest.summary?.ok === true
            ? { captions: [], timedOut: false }
            : await collectCaptions({
                title: manifest.title,
                since: startedAt - 5_000,
                expect: manifest.frames.length,
            });
        // 打标期间如果有人开始说话，就不在这个节骨眼上主动分享。
        const after = await activityProbe();
        if (!after.ok) {
            await logEvent({
                kind: 'share-skip',
                bvid: manifest.bvid,
                reason: '打标后有人在使用：' + after.reasons.join('；'),
            });
            return { ok: true, manifest, tagging, share: null };
        }
        const result = await share({
            bvid: manifest.bvid,
            title: manifest.title,
            captions: tagging.captions,
            summary: manifest.summary?.text ?? '',
            mode: 'proactive',
        });
        await logEvent({
            kind: result.ok ? 'share-done' : 'share-skip',
            bvid: manifest.bvid,
            title: manifest.title,
            target: result.target ?? null,
            reason: result.reason ?? '',
            captions: tagging.captions.length,
            taggingTimedOut: tagging.timedOut,
            summarySource: manifest.summary?.source ?? '',
            summaryChars: manifest.summary?.chars ?? 0,
            sampling: manifest.sampling?.mode ?? '',
        });
        return { ok: true, manifest, tagging, share: result };
    }
    finally {
        running = false;
    }
}

/** 面板用：当天主动刷统计 + 上次结果 + 分享配额。 */
export async function status() {
    const state = await readState();
    const doc = await prefs();
    const targets = shareTargets(doc).map(target => ({
        ...target,
        usedToday: Number(state.shares.byChat[chatKeyOf(target)] ?? 0),
        remaining: target.perDay === 0
            ? null
            : Math.max(0, target.perDay - Number(state.shares.byChat[chatKeyOf(target)] ?? 0)),
    }));
    const last = state.lastAt === '' ? 0 : Date.parse(state.lastAt) || 0;
    const hostLast = await hostLastSelfActionAt();
    const anchor = Math.max(last, hostLast);
    return {
        day: state.day,
        today: {
            count: state.count,
            bytes: state.bytes,
            totalMs: state.totalMs,
            avgMs: state.count > 0 ? Math.round(state.totalMs / state.count) : 0,
        },
        hourly: state.hourly.length,
        maxPerHour: MAX_PER_HOUR,
        paused: state.paused,
        running,
        lastAt: state.lastAt,
        lastRun: state.lastRun,
        lastAbort: state.lastAbort,
        lastGate: state.lastGate,
        lastShare: state.lastShare,
        nextEligibleAt: anchor > 0 ? new Date(anchor + MIN_GAP_MS).toISOString() : '',
        targets,
        sharesToday: Object.values(state.shares.byChat).reduce((total, value) => total + Number(value ?? 0), 0),
        shareVideos: Object.keys(state.shares.videos).length,
        statePath: STATE_PATH,
        logPath: LOG_PATH,
        prefsPath: PREFS_PATH,
    };
}

export async function setPaused(paused) {
    const state = await readState();
    state.paused = paused === true;
    await writeState(state);
    await logEvent({ kind: paused === true ? 'paused' : 'resumed' });
    return state.paused;
}

/**
 * 控制台进程里的 60 秒 tick；与宿主 proactive 的 60 秒节奏一致。
 * 真正决定刷不刷的还是 gateStatus()，这里只负责到点问一次。
 */
export function createWatcher({ log = () => undefined, intervalMs = 60_000 } = {}) {
    let timer = null;
    let tickBusy = false;
    const tick = async () => {
        if (tickBusy)
            return;
        tickBusy = true;
        try {
            const result = await runOnce();
            if (result.ok === false && result.reason)
                log('debug', '主动刷跳过：' + result.reason);
            else if (result.ok === true)
                log('info', '主动刷完成：' + (result.manifest?.title ?? '') + '（' + (result.manifest?.timing?.total ?? 0) + 'ms）');
        }
        catch (error) {
            log('warn', '主动刷失败：' + String(error?.message ?? error));
        }
        finally {
            tickBusy = false;
        }
    };
    return {
        start() {
            if (timer !== null || process.env.QQ_BILI_PROACTIVE === '0')
                return;
            timer = setInterval(() => void tick(), intervalMs);
            timer.unref?.();
            setTimeout(() => void tick(), 20_000).unref?.();
        },
        stop() {
            if (timer !== null)
                clearInterval(timer);
            timer = null;
        },
        tick,
    };
}
