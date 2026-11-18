/**
 * 历史回填：按 mid 拉近 12 个月的投稿，逐条走「下载 → 帧 → 音频结构 → ASR → 总结」，
 * 只写视频库（不分享、不进群消息、不写 bili-state 的观看历史）。
 *
 * 用法：
 *   node bili-backfill.mjs list                 只数清单并估算耗时
 *   node bili-backfill.mjs run [--limit N]      串行回填，可断点续跑
 *   node bili-backfill.mjs run --long [--limit N]  只跑用户放行的长视频批次（90 分钟上限）
 *   node bili-backfill.mjs query [--up 名] [--q 词] [--from 日期] [--to 日期]
 *
 * 状态文件：bili-backfill.json（进度与跳过项）、bili-backfill-plan.json（清单缓存）。
 * 视频库：bili-library.jsonl，一行一条，按 UP / 发布时间 / 关键词都能查。
 */
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { videoInfo, watch } from './bili.mjs';
import { LIBRARY_PATH, appendLibraryRow } from './bili-library.mjs';
import { enqueueDigest } from './video-memory-ledger.mjs';
import { mineMemes } from './bili-memes.mjs';
import { longBatchConfig, loadPool } from './bili-pool-config.mjs';
import { listUploads } from './bili-uploads.mjs';
import { externalBusyWithLease, readJson, setLowPriority, sleep, yieldReason } from './bili-worker.mjs';

const HOME = 'Y:\\dsh\\home\\qq-persona';
const PLAN_PATH = join(HOME, 'bili-backfill-plan.json');
const STATE_PATH = join(HOME, 'bili-backfill.json');
const PROACTIVE_STATE = join(HOME, 'bili-proactive.json');
const MEME_DROPS_PATH = join(HOME, 'meme-drops.jsonl');

const UPS = [
    { mid: 946974, name: '影视飓风' },
    { mid: 25876945, name: '极客湾Geekerwan' },
];
const MONTHS = 12;
// 全局硬上限：自动路径和普通回填都只吃 20 分钟以内的片子。
const MAX_DURATION_SEC = 20 * 60;
// 长视频批次：只处理 allowlist 的 UP，单独抬到 90 分钟 / 2.5GB，不影响全局上限。
const LONG_MAX_BYTES = 2.5 * 1024 ** 3;
// 让路时的复查间隔：不再固定睡 3 分钟，问到空闲就继续，仍受时间预算约束。
const YIELD_POLL_MS = 15_000;

function estimateOneSec(item) {
    const duration = Number(item.duration) || 0;
    const rtf = duration > 600 ? 0.18 : 0.32;
    // 下载 ≈ 时长/10、抽帧 ≈ 6s、音轨+结构 ≈ 时长×0.01+1、ASR = 时长×RTF、总结 ≈ 4s
    return duration / 10 + 6 + duration * 0.01 + 1 + duration * rtf + 4;
}

async function buildPlan() {
    const cached = readJson(PLAN_PATH, null);
    // v2：加入梗指南常驻主来源 + 历史高播放补录，旧缓存直接作废。
    const fresh = Number(cached?.v ?? 0) === 2 && Date.now() - Number(cached?.at ?? 0) < 6 * 3600_000;
    if (cached && fresh && Array.isArray(cached.items)) {
        const ageMin = Math.round((Date.now() - Number(cached.at)) / 60_000);
        return { ...cached, cached: true, ageMin };
    }
    const meme = loadPool().memeSource;
    const sources = [...UPS];
    if (meme?.enabled !== false && Number(meme?.mid) > 0) {
        sources.push({
            mid: Number(meme.mid),
            name: String(meme.name ?? '梗指南'),
            days: Number(meme.days) || MONTHS * 30,
            pages: Number(meme.pages) || 10,
            hotPlay: Number(meme.hotPlay) || 0,
            archiveDays: Number(meme.archiveDays) || 3650,
            archivePages: Number(meme.archivePages) || 32,
        });
    }
    const byBv = new Map();
    const perUp = [];
    for (const up of sources) {
        const days = Number(up.days) || MONTHS * 30;
        const list = await listUploads(up.mid, { days, ps: 20, pages: up.pages ?? 40 });
        const entry = { mid: up.mid, name: up.name, count: list.items.length, reason: list.ok ? '' : list.reason };
        perUp.push(entry);
        for (const item of list.items) {
            if (!byBv.has(item.bvid))
                byBv.set(item.bvid, { ...item, owner: item.owner || up.name, source: 'up' });
        }
        // 梗指南的历史高播放：同一 cursor 接口继续翻页，只多一次拉取，不另建采集链路。
        if (Number(up.hotPlay) > 0) {
            const deep = await listUploads(up.mid, { days: up.archiveDays, ps: 20, pages: up.archivePages });
            const since = Date.now() - days * 86400_000;
            const extra = deep.items.filter(item => Date.parse(item.pubdate) < since && Number(item.play) >= Number(up.hotPlay));
            entry.archive = { hotPlay: Number(up.hotPlay), count: extra.length };
            for (const item of extra) {
                if (!byBv.has(item.bvid))
                    byBv.set(item.bvid, { ...item, owner: item.owner || up.name, source: 'meme-archive' });
            }
        }
    }
    const plan = { v: 2, at: Date.now(), months: MONTHS, perUp, items: [...byBv.values()] };
    writeFileSync(PLAN_PATH, JSON.stringify(plan, null, 2) + '\n', 'utf8');
    return { ...plan, cached: false };
}

/** 用户放行的长视频：只在 allowlist 的 UP 名下、且不超过单独抬高的上限。 */
function isLongAllowed(item) {
    const conf = longBatchConfig();
    if (Number(item.duration) <= MAX_DURATION_SEC)
        return false;
    if (Number(item.duration) > Number(conf.maxDurationSec))
        return false;
    return (conf.ups ?? []).some(name => name !== '' && String(item.owner ?? '').includes(name));
}

function reportPlan(plan) {
    const longAllowed = plan.items.filter(isLongAllowed);
    const dropped = plan.items.filter(item => item.duration > MAX_DURATION_SEC && !isLongAllowed(item));
    const candidates = plan.items.filter(item => item.duration <= MAX_DURATION_SEC);
    const totalSec = candidates.reduce((sum, item) => sum + item.duration, 0);
    const estimateSec = candidates.reduce((sum, item) => sum + estimateOneSec(item), 0);
    const longSec = longAllowed.reduce((sum, item) => sum + item.duration, 0);
    console.log('清单' + (plan.cached ? '（缓存 ' + plan.ageMin + ' 分钟前）' : '') + '：');
    for (const up of plan.perUp) {
        const mine = plan.items.filter(item => item.mid === up.mid);
        const usable = mine.filter(item => item.duration <= MAX_DURATION_SEC);
        console.log('  ' + up.name + '（mid ' + up.mid + '）：共 ' + mine.length + ' 条，可处理 '
            + usable.length + ' 条，超 20 分钟 ' + (mine.length - usable.length) + ' 条');
        if (up.archive)
            console.log('     └ 近一年之外、播放 ≥' + up.archive.hotPlay + '：' + up.archive.count + ' 条（补录进消化队列）');
    }
    console.log('合计 ' + plan.items.length + ' 条；可处理 ' + candidates.length + ' 条，超 20 分钟 '
        + (longAllowed.length + dropped.length) + ' 条');
    console.log('可处理总时长 ' + (totalSec / 3600).toFixed(2) + ' 小时（'
        + Math.floor(totalSec / 60) + ' 分钟）');
    console.log('预计耗时 ' + (estimateSec / 3600).toFixed(2) + ' 小时（'
        + Math.round(estimateSec / 60) + ' 分钟），按 medium@4 RTF≈0.32 / small≈0.18 估');
    console.log('长视频批次（用户放行，--long）：' + longAllowed.length + ' 条，'
        + (longSec / 3600).toFixed(2) + ' 小时，单条上限 '
        + Math.round(Number(longBatchConfig().maxDurationSec) / 60) + ' 分钟');
    for (const item of longAllowed)
        console.log('  ' + Math.round(item.duration / 60) + ' 分钟  ' + item.owner + '  ' + item.bvid + '  ' + item.title.slice(0, 44));
    console.log('其余超长（dropped-by-user，不再排队）：' + dropped.length + ' 条');
    for (const item of dropped)
        console.log('  ' + Math.round(item.duration / 60) + ' 分钟  ' + item.owner + '  ' + item.bvid + '  ' + item.title.slice(0, 44));
    return { candidates, longAllowed, dropped, totalSec, estimateSec };
}

function libraryBvids() {
    if (!existsSync(LIBRARY_PATH))
        return new Set();
    const set = new Set();
    for (const line of readFileSync(LIBRARY_PATH, 'utf8').split('\n')) {
        if (line.trim() === '')
            continue;
        try {
            const row = JSON.parse(line);
            if (row?.bvid)
                set.add(String(row.bvid));
        }
        catch {
            // 坏行跳过
        }
    }
    return set;
}

function readVisionCaptions(title, since) {
    try {
        const parsed = JSON.parse(readFileSync(join(HOME, 'vision-state.json'), 'utf8'));
        const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
        return entries
            .filter(entry => entry?.source === 'bili' && entry.video === title && Number(entry.at ?? 0) >= since)
            .map(entry => String(entry.text ?? ''))
            .filter(Boolean);
    }
    catch {
        return [];
    }
}

/** 视觉打标是异步落库的，等它几秒再取，避免回填记录里没有画面描述。 */
async function waitVisionCaptions(title, since, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const captions = readVisionCaptions(title, since);
        if (captions.length > 0)
            return captions;
        await sleep(2_000);
    }
    return [];
}

function writeState(state) {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/**
 * 被每日新增上限拦掉的候选：单独一行日志 + 追加一条到 meme-drops.jsonl。
 * 只记账，不改上限/采集节奏；口径是「今天已拦下多少条」，方便以后判断要不要抬上限。
 */
function logMemeDrops(info, memes) {
    const at = new Date().toISOString();
    const today = at.slice(0, 10);
    let droppedToday = 0;
    if (existsSync(MEME_DROPS_PATH)) {
        for (const line of readFileSync(MEME_DROPS_PATH, 'utf8').split('\n')) {
            if (line.trim() === '')
                continue;
            try {
                const row = JSON.parse(line);
                if (String(row?.at ?? '').slice(0, 10) === today)
                    droppedToday += Number(row?.dropped) || 0;
            }
            catch {
                // 坏行跳过，不让记账影响回填
            }
        }
    }
    droppedToday += memes.dropped.length;
    try {
        appendFileSync(MEME_DROPS_PATH, JSON.stringify({
            at,
            bvid: info.bvid,
            dropped: memes.dropped.length,
            terms: memes.dropped.slice(0, 10),
            addedToday: memes.addedToday,
            cap: memes.cap,
            droppedToday,
        }) + '\n', 'utf8');
    }
    catch (error) {
        console.log('[梗·上限] 记账失败：' + String(error?.message ?? error).slice(0, 120));
    }
    console.log('[梗·上限] ' + at + ' ' + info.bvid + ' 拦下 ' + memes.dropped.length
        + ' 条（今日新增 ' + memes.addedToday + '/' + memes.cap
        + '，当日累计 dropped ' + droppedToday + '）：'
        + memes.dropped.slice(0, 5).join('、'));
}

/** 用户没放行的超长条目统一标 dropped-by-user，之后不再出现在待处理里。 */
function migrateDropped(state, plan) {
    let migrated = 0;
    const byBvid = new Map(plan.items.map(item => [item.bvid, item]));
    for (const [bvid, info] of Object.entries(state.skipped ?? {})) {
        if (info?.reason !== 'too-long')
            continue;
        const item = byBvid.get(bvid);
        if (item === undefined)
            continue;
        if (!isLongAllowed(item)) {
            state.skipped[bvid] = { ...info, reason: 'dropped-by-user', migratedAt: new Date().toISOString() };
            migrated += 1;
        }
    }
    if (migrated > 0) {
        writeState(state);
        console.log('[迁移] ' + migrated + ' 条非放行超长 → dropped-by-user');
    }
    return migrated;
}

/**
 * 让路：QQ 有请求（入站 defer / 模型队列 active 或 waiting / GPU 租约）就暂停，
 * 每 15 秒复查一次，空闲立刻继续；超过时间预算返回 -1，由调用方收尾。
 */
async function waitForFree(reason, deadline, stats, label = '') {
    const startedAt = Date.now();
    stats.yields += 1;
    console.log('[让路] ' + (label === '' ? '' : label + '：') + reason + '，每 ' + (YIELD_POLL_MS / 1000) + ' 秒复查');
    while (true) {
        if (deadline > 0 && Date.now() >= deadline)
            return -1;
        const remain = deadline > 0 ? deadline - Date.now() : YIELD_POLL_MS;
        await sleep(Math.max(1_000, Math.min(YIELD_POLL_MS, remain)));
        if (deadline > 0 && Date.now() >= deadline)
            return -1;
        const next = await yieldReason();
        if (next === '') {
            const waited = Date.now() - startedAt;
            stats.yieldMs += waited;
            stats.yieldEvents.push({ label, reason, ms: waited });
            console.log('[让路结束] 等了 ' + Math.round(waited / 1000) + 's，继续');
            return waited;
        }
    }
}

const ENGINE_HEALTH = 'http://127.0.0.1:8094/health';
const ENGINE_WAIT_MS = 15 * 60_000;

/** 只探引擎健康，用来区分「视频本身失败」和「引擎闩死」。 */
async function engineStatus() {
    try {
        const response = await fetch(ENGINE_HEALTH, { signal: AbortSignal.timeout(5_000) });
        return response.ok ? 'ok' : 'http-' + response.status;
    }
    catch {
        return 'unreachable';
    }
}

/** 引擎不健康时等它恢复（最多 15 分钟），恢复后重试同一条。 */
async function waitEngineHealthy(deadline, startedAt) {
    const until = Date.now() + ENGINE_WAIT_MS;
    console.log('[引擎] /health 不健康，等待恢复后重试同一条（最多 ' + Math.round(ENGINE_WAIT_MS / 60_000) + ' 分钟）');
    while (Date.now() < until) {
        if (deadline > 0 && Date.now() >= deadline)
            return false;
        await sleep(30_000);
        const status = await engineStatus();
        console.log('[引擎] /health=' + status + '（已等 ' + Math.round((Date.now() - startedAt) / 1000) + 's）');
        if (status === 'ok')
            return true;
    }
    return false;
}

async function run({ limit = 0, long = false, minutes = 0 } = {}) {
    const plan = await buildPlan();
    const state = readJson(STATE_PATH, { done: {}, skipped: {}, failed: {} });
    state.done ??= {};
    state.skipped ??= {};
    state.failed ??= {};
    const conf = longBatchConfig();
    const itemMaxDuration = long ? Number(conf.maxDurationSec) || 5400 : MAX_DURATION_SEC;
    const startedAt = Date.now();
    const budgetMs = minutes > 0 ? minutes * 60_000 : 0;
    const deadline = budgetMs > 0 ? startedAt + budgetMs : 0;
    const stats = { yields: 0, yieldMs: 0, yieldEvents: [] };

    migrateDropped(state, plan);

    const applied = setLowPriority();
    console.log('[低优先级] ' + (applied ? '进程已降到 BelowNormal' : '设置优先级失败，仍按单条串行')
        + (long
            ? '；ASR 2 线程、720p、单条上限 ' + Math.round(itemMaxDuration / 60) + ' 分钟'
            : '；ASR 4 线程、单条上限 ' + Math.round(itemMaxDuration / 60) + ' 分钟')
        + '；QQ 有请求时让路' + (budgetMs > 0 ? '；本轮时间预算 ' + minutes + ' 分钟' : ''));

    // 长视频批次不看 skipped（它们正躺在那里面），成功后从 skipped 移入 done。
    const seen = long
        ? new Set([...libraryBvids(), ...Object.keys(state.done)])
        : new Set([...libraryBvids(), ...Object.keys(state.done), ...Object.keys(state.skipped)]);
    let queue = plan.items
        .filter(item => !seen.has(item.bvid))
        .sort((a, b) => Date.parse(b.pubdate) - Date.parse(a.pubdate));
    if (long)
        queue = queue.filter(isLongAllowed);
    const todo = limit > 0 ? queue.slice(0, limit) : queue;
    console.log((long ? '长视频批次待处理 ' : '待处理 ') + queue.length + ' 条，本轮 ' + todo.length + ' 条，串行执行');
    let ok = 0;
    let skipped = 0;
    let failed = 0;
    for (let index = 0; index < todo.length; index += 1) {
        if (deadline > 0 && Date.now() >= deadline) {
            console.log('[时间到] 已用 ' + Math.round((Date.now() - startedAt) / 1000) + 's，不再取新条目');
            break;
        }
        const item = todo[index];
        const itemStartedAt = Date.now();
        const reason = await yieldReason();
        if (reason !== '') {
            const waited = await waitForFree(reason, deadline, stats, item.bvid);
            writeState(state);
            if (waited < 0) {
                console.log('[时间到] 让路期间用尽时间预算，停止');
                break;
            }
            index -= 1;
            continue;
        }
        if (item.duration > itemMaxDuration) {
            state.skipped[item.bvid] = { reason: 'too-long', duration: item.duration, title: item.title, at: new Date().toISOString() };
            writeState(state);
            skipped += 1;
            console.log('[跳过] ' + Math.round(item.duration / 60) + ' 分钟  ' + item.bvid + '  ' + item.title.slice(0, 40));
            continue;
        }
        // 条目处理中途只盯外部信号（defer / GPU 租约），命中就让 watch 在下一个检查点抛 BILI_YIELD。
        let interrupt = '';
        const timer = setInterval(async () => {
            if (interrupt !== '')
                return;
            const reason = await externalBusyWithLease();
            if (reason !== '')
                interrupt = reason;
        }, 10_000);
        try {
            const info = await videoInfo(item.bvid);
            const since = itemStartedAt - 5_000;
            const manifest = await watch(item.bvid, {
                chatId: 'bili:library',
                mode: 'backfill',
                triggeredBy: long ? 'backfill-long' : 'backfill',
                summarize: true,
                record: false,
                shouldYield: () => interrupt,
                maxDurationSec: itemMaxDuration,
                maxVideoBytes: long ? LONG_MAX_BYTES : undefined,
                asrThreads: long ? 2 : 4,
            });
            const captions = await waitVisionCaptions(info.title, since);
            const record = {
                bvid: info.bvid,
                title: info.title,
                owner: info.owner,
                mid: item.mid,
                pubdate: item.pubdate,
                duration: info.duration,
                pages: Number(info.pages ?? 1),
                p1Title: String(info.part ?? ''),
                processedAt: new Date().toISOString(),
                summarySource: manifest.summary?.source ?? '',
                summaryDegraded: manifest.summary?.degraded ?? '',
                summaryChars: Number(manifest.summary?.chars ?? 0),
                summary: manifest.summary?.text ?? '',
                asrModel: manifest.asr?.model ?? '',
                asrChars: Number(manifest.asr?.chars ?? 0),
                asrMs: Number(manifest.asr?.wallMs ?? 0),
                transcriptPath: manifest.asr?.transcriptPath ?? '',
                audioHints: (manifest.structure?.hints ?? []).join('；'),
                audioCoverage: manifest.structure?.coveragePct ?? null,
                audioSegments: Number(manifest.structure?.segments ?? 0),
                captions,
                totalMs: Number(manifest.timing?.total ?? 0),
                // 弹幕只读采集：原始条数 / 分桶后保留数 / 取不到的原因。
                danmakuTotal: Number(manifest.danmaku?.total ?? 0),
                danmakuKept: Number(manifest.danmaku?.kept ?? 0),
                danmakuBucketSec: Number(manifest.danmaku?.bucketSec ?? 0),
                danmakuReason: manifest.danmaku?.ok === true ? '' : String(manifest.danmaku?.reason ?? ''),
            };
            appendLibraryRow(record);
            // 看完即入消化队列（独立文件）；插件在真实回合结束后用静音回合消化。
            try {
                enqueueDigest({
                    bvid: record.bvid,
                    title: record.title,
                    owner: record.owner,
                    duration: record.duration,
                    summary: record.summary,
                    captions,
                    source: long ? 'long' : 'backfill',
                });
            }
            catch (error) {
                console.log('[消化] 入队失败：' + String(error?.message ?? error).slice(0, 120));
            }
            state.done[item.bvid] = { at: record.processedAt, totalMs: record.totalMs, summarySource: record.summarySource };
            // 长视频批次成功后就从 skipped 里移走，断点续跑不会再把它当待处理。
            if (long)
                delete state.skipped[item.bvid];
            writeState(state);
            // 梗候选：字幕/转写 + 画面打标 + 弹幕簇 → 独立 memes.jsonl。
            // 失败只记日志，不影响这条视频已经完成的入库。
            try {
                const memes = await mineMemes({
                    bvid: info.bvid,
                    title: info.title,
                    owner: info.owner,
                    duration: info.duration,
                    cid: info.cid,
                    summaryText: record.summary,
                    captions,
                    transcriptPath: record.transcriptPath,
                    danmaku: manifest.danmaku,
                    limit: 5,
                    write: true,
                });
                console.log(memes.ok
                    ? '[梗] ' + info.bvid + ' 候选 ' + memes.candidates.length
                        + '，新增 ' + memes.added.length + '，合并 ' + memes.merged.length
                        + '，dropped ' + memes.dropped.length
                        + '（今日 ' + memes.addedToday + '/' + memes.cap + '）'
                        + '，弹幕 ' + memes.danmaku.total + ' 条/留 ' + memes.danmaku.kept
                        + '，' + memes.ms + 'ms'
                    : '[梗] ' + info.bvid + ' 未产出：' + memes.reason);
                if (memes.ok && memes.dropped.length > 0)
                    logMemeDrops(info, memes);
            }
            catch (error) {
                console.log('[梗] ' + info.bvid + ' 异常：' + String(error?.message ?? error).slice(0, 160));
            }
            // 媒体在 watch 里已清，这里把空壳工作目录也收掉。
            try {
                rmSync(String(manifest.workDir ?? ''), { recursive: true, force: true });
            }
            catch {
                // 目录可能已经不在
            }
            ok += 1;
            const wall = Math.round((Date.now() - itemStartedAt) / 1000);
            console.log('[完成] ' + (index + 1) + '/' + todo.length + ' ' + item.bvid
                + ' ' + info.duration + 's ' + record.summarySource + ' 转写'
                + record.asrChars + ' 字 ' + Math.round(record.asrMs / 1000) + 's'
                + ' 总 ' + wall + 's RTF ' + (record.asrMs / 1000 / Math.max(1, info.duration)).toFixed(3));
        }
        catch (error) {
            const code = String(error?.code ?? '');
            const message = String(error?.message ?? error);
            if (code === 'BILI_YIELD') {
                const waited = await waitForFree(message, deadline, stats, item.bvid);
                writeState(state);
                if (waited < 0) {
                    console.log('[时间到] 让路期间用尽时间预算，停止');
                    break;
                }
                index -= 1;
                continue;
            }
            if (message.startsWith('视频过长')) {
                state.skipped[item.bvid] = { reason: 'too-long', duration: item.duration, title: item.title, at: new Date().toISOString() };
                writeState(state);
                skipped += 1;
                console.log('[跳过] 视频过长 ' + item.bvid);
                continue;
            }
            if (message.startsWith('文件过大')) {
                state.skipped[item.bvid] = { reason: 'too-large', duration: item.duration, title: item.title, at: new Date().toISOString() };
                writeState(state);
                skipped += 1;
                console.log('[跳过] 文件过大 ' + item.bvid);
                continue;
            }
            // 失败先探引擎健康：凌晨那种 Paged KV 503 是引擎闩死，不是视频的问题，
            // 等 /health 恢复后重试同一条，别把它记成失败。
            const health = await engineStatus();
            if (health !== 'ok') {
                console.log('[引擎] ' + item.bvid + ' 失败时 /health=' + health + '：' + message.slice(0, 120));
                const recovered = await waitEngineHealthy(deadline, itemStartedAt);
                if (recovered) {
                    writeState(state);
                    index -= 1;
                    continue;
                }
            }
            failed += 1;
            state.failed[item.bvid] = { error: message.slice(0, 200), health, at: new Date().toISOString() };
            writeState(state);
            console.log('[失败] ' + item.bvid + '：' + message.slice(0, 160));
        }
        finally {
            clearInterval(timer);
        }
    }
    console.log('本轮完成：成功 ' + ok + '，跳过 ' + skipped + '，失败 ' + failed);
}

function queryLibrary({ up = '', keyword = '', from = '', to = '' } = {}) {
    if (!existsSync(LIBRARY_PATH)) {
        console.log('视频库还没有内容');
        return;
    }
    const rows = readFileSync(LIBRARY_PATH, 'utf8').split('\n').filter(Boolean).map(line => {
        try {
            return JSON.parse(line);
        }
        catch {
            return null;
        }
    }).filter(Boolean);
    const fromTs = from === '' ? 0 : Date.parse(from);
    const toTs = to === '' ? Infinity : Date.parse(to);
    const hits = rows.filter(row => {
        if (up !== '' && !String(row.owner).includes(up))
            return false;
        const ts = Date.parse(row.pubdate);
        if (ts < fromTs || ts > toTs)
            return false;
        if (keyword !== '' && !(String(row.title) + '\n' + String(row.summary) + '\n' + (row.captions ?? []).join('\n')).includes(keyword))
            return false;
        return true;
    });
    console.log('命中 ' + hits.length + ' 条');
    for (const row of hits) {
        console.log(new Date(row.pubdate).toLocaleDateString('zh-CN') + '  ' + row.owner + '  ' + row.title);
        if (row.summary)
            console.log('  ' + row.summary.replace(/\n/gu, ' ').slice(0, 160));
    }
}

const [command = 'list', ...rest] = process.argv.slice(2);
const flags = {};
for (let index = 0; index < rest.length; index += 1) {
    if (rest[index].startsWith('--'))
        flags[rest[index].slice(2)] = rest[index + 1] ?? '';
}
if (command === 'list') {
    reportPlan(await buildPlan());
}
else if (command === 'migrate') {
    const plan = await buildPlan();
    const state = readJson(STATE_PATH, { done: {}, skipped: {}, failed: {} });
    state.skipped ??= {};
    state.done ??= {};
    state.failed ??= {};
    const count = migrateDropped(state, plan);
    console.log('迁移完成：' + count + ' 条 → dropped-by-user；skipped 现有 ' + Object.keys(state.skipped).length + ' 条');
}
else if (command === 'run') {
    // 回填与主动刷互斥：借现有的 paused 开关，跑完（或异常退出）就放开。
    const doc = readJson(PROACTIVE_STATE, {}) ?? {};
    const wasPaused = doc.paused === true;
    if (!wasPaused) {
        writeFileSync(PROACTIVE_STATE, JSON.stringify({ ...doc, paused: true }, null, 2) + '\n', 'utf8');
        console.log('回填期间暂停主动刷');
    }
    try {
        await run({
            limit: Number(flags.limit ?? 0),
            long: process.argv.includes('--long'),
            minutes: Number(flags.minutes ?? 0),
        });
    }
    finally {
        if (!wasPaused) {
            const after = readJson(PROACTIVE_STATE, {}) ?? {};
            writeFileSync(PROACTIVE_STATE, JSON.stringify({ ...after, paused: false }, null, 2) + '\n', 'utf8');
            console.log('回填结束，恢复主动刷');
        }
    }
}
else if (command === 'query') {
    queryLibrary({ up: flags.up ?? '', keyword: flags.q ?? '', from: flags.from ?? '', to: flags.to ?? '' });
}
else {
    console.log('未知命令：' + command);
}
