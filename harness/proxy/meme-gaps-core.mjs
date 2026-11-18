/**
 * 待解释队列（meme-gaps.jsonl）：只负责「记账」，不碰下载/抽梗，避免和 bili-memes.mjs 循环依赖。
 *
 * 两种入队来源：
 * 1) 抽梗置信度 ≤ 阈值（默认 0.6，「真串子」就是 0.6）；
 * 2) 群里出现、梗库查不到的新词（由宿主以后调用 enqueueUnknownTerm）。
 *
 * 每次变更追加一行，读取时后写覆盖先写（和 memes.jsonl 同一套约定）。
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOME = 'Y:\\dsh\\home\\qq-persona';
export const GAPS_PATH = process.env.QQ_MEME_GAPS_PATH ?? join(HOME, 'meme-gaps.jsonl');
export const GAPS_LOG_PATH = process.env.QQ_MEME_GAPS_LOG ?? join(HOME, 'meme-gaps-log.jsonl');

function normalizeKey(term) {
    return String(term ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function gapId(key) {
    return 'gap-' + createHash('md5').update(key).digest('hex').slice(0, 8);
}

function readJsonLines(path) {
    if (!existsSync(path))
        return [];
    const rows = [];
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
        if (line.trim() === '')
            continue;
        try {
            rows.push(JSON.parse(line));
        }
        catch {
            // 坏行跳过，别让一条脏数据堵住整个队列。
        }
    }
    return rows;
}

/** 后写覆盖先写；按 id 去重。 */
export function loadGaps() {
    const map = new Map();
    for (const row of readJsonLines(GAPS_PATH)) {
        if (typeof row?.id === 'string' && row.id !== '')
            map.set(row.id, row);
    }
    return [...map.values()];
}

export function saveGap(record) {
    const payload = { ...record, updatedAt: new Date().toISOString() };
    appendFileSync(GAPS_PATH, JSON.stringify(payload) + '\n', 'utf8');
    return payload;
}

export function logGap(entry) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    appendFileSync(GAPS_LOG_PATH, line, 'utf8');
}

/**
 * 入队前的硬判定：深度 ≥1 的补课视频一律不入队（防套娃），置信度高于阈值也不入。
 * 放在 core 里，mineMemes 必须调用它，调用方绕不过去。
 */
export function shouldEnqueueGap({ gapDepth = 0, confidence = 0, maxConfidence = 0.6 } = {}) {
    if (Number(gapDepth) >= 1)
        return { ok: false, reason: 'depth-limit' };
    if (Number(confidence) > Number(maxConfidence))
        return { ok: false, reason: 'confidence-above-threshold' };
    return { ok: true, reason: '' };
}

/**
 * 入队。已 pending/closed 的不重复入；gave-up 的不再复活（最多尝试次数是硬约束）。
 * 返回 {queued, record, reason}。
 */
export function enqueueGap({
    term,
    category = '',
    confidence = 0,
    scene = 'video',
    bvid = '',
    title = '',
    aboutSelf = '',
    reason = '',
} = {}) {
    const key = normalizeKey(term);
    if (key === '')
        return { queued: false, record: null, reason: '空词' };
    const id = gapId(key);
    const existing = loadGaps().find(row => row.id === id);
    if (existing !== undefined) {
        if (existing.status === 'gave-up')
            return { queued: false, record: existing, reason: 'gave-up（已用尽尝试次数）' };
        return { queued: false, record: existing, reason: existing.status };
    }
    const now = new Date().toISOString();
    const record = saveGap({
        id,
        term: String(term),
        key,
        category: String(category ?? ''),
        firstSeen: now,
        lastSeen: now,
        scene: scene === 'group' ? 'group' : 'video',
        candidates: [],
        attempts: 0,
        status: 'pending',
        aboutSelf: String(aboutSelf ?? ''),
        sources: [{ scene: scene === 'group' ? 'group' : 'video', bvid: String(bvid ?? ''), title: String(title ?? ''), at: now }],
        enqueueReason: String(reason || (confidence > 0 ? 'confidence=' + confidence : '')),
    });
    logGap({ gap: id, term: record.term, step: 'enqueue', scene: record.scene, reason: record.enqueueReason });
    return { queued: true, record, reason: '' };
}

/** 群里出现、梗库查不到的新词：语义上和低置信度入队同一队列。 */
export function enqueueUnknownTerm(term, context = {}) {
    return enqueueGap({ term, scene: context.scene ?? 'group', reason: context.reason ?? 'not-in-library', ...context });
}

export function updateGap(record) {
    return saveGap(record);
}

/** pending 数、闭合率、平均尝试次数——「看不看得懂」可统计。 */
export function gapStats() {
    const rows = loadGaps();
    const pending = rows.filter(row => row.status === 'pending').length;
    const closed = rows.filter(row => row.status === 'closed').length;
    const gaveUp = rows.filter(row => row.status === 'gave-up').length;
    const total = rows.length;
    const attempts = closed + gaveUp;
    return {
        total,
        pending,
        closed,
        gaveUp,
        closedRate: attempts === 0 ? 0 : Number((closed / attempts).toFixed(3)),
        avgAttempts: attempts === 0
            ? 0
            : Number((rows.filter(row => row.status !== 'pending').reduce((sum, row) => sum + Number(row.attempts ?? 0), 0) / attempts).toFixed(2)),
    };
}
