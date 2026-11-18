/**
 * B 站弹幕：只读抓取 + 按时间轴分桶，取「重复度最高」的弹幕。
 *
 * 边界：
 * - 只读：只调 x/v1/dm/list.so，匿名可用（不带 SESSDATA），不发弹幕/不点赞/不投币。
 * - 取不到就如实返回 ok:false + reason，不编造、不拿空结果冒充「没有弹幕」。
 * - 单条视频硬上限：≤6MB / ≤6000 行 / ≤80 桶 / 每桶 ≤6 条，防止几十万条弹幕撑爆内存与上下文。
 * - 分桶宽度 10–20 秒，超出 80 桶（20 分钟视频）时自动放宽到 20 秒。
 *
 * 重复度：同一桶内先按「归一化后的文本」精确计数；连续重复字符折叠（哈哈哈哈哈 → 哈哈、
 * 233333 → 233）后仍按同一簇计数，但对外露出出现次数最多的那个原始写法。
 */
import { apiHeaders } from './bili-fingerprint.mjs';

export const DANMAKU_LIMITS = Object.freeze({
    maxBytes: 6 * 1024 * 1024,
    maxRows: 6000,
    perBucket: 6,
    minBucketSec: 10,
    maxBucketSec: 20,
    maxBuckets: 80,
});

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };

function decodeXml(text) {
    return String(text).replace(/&(#x?[0-9a-f]+|[a-z]+);/giu, (whole, body) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X'
                ? Number.parseInt(body.slice(2), 16)
                : Number.parseInt(body.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
        }
        return ENTITY[body.toLowerCase()] ?? whole;
    });
}

/** 归一化：全角→半角、去首尾空白、压缩空白。用于计数粒度，不改变展示写法。 */
function normalizeText(value) {
    return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

/** 重复簇的 key：折叠 3 个以上的连续同字符（哈哈哈哈→哈哈、233333→233）。 */
function repeatKey(text) {
    return normalizeText(text).replace(/(.)\1{2,}/gu, '$1$1');
}

function isNoise(text) {
    if (text === '' || text.length > 80)
        return true;
    return /^[\s\p{P}\p{S}]+$/u.test(text);
}

/**
 * 解析 list.so 的 XML。<d p="t,mode,size,color,ts,pool,uid,dmid,weight">text</d>
 * pool=1 是字幕弹幕池，等同 UP 字幕，直接丢掉（字幕另有通路）。
 */
export function parseDanmakuXml(xml) {
    const rows = [];
    const pattern = /<d p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/gu;
    for (const match of String(xml).matchAll(pattern)) {
        const parts = match[1].split(',');
        const at = Number(parts[0]);
        const mode = Number(parts[1] ?? 0);
        const pool = Number(parts[5] ?? 0);
        if (!Number.isFinite(at) || pool === 1)
            continue;
        // mode 7/8 是高级弹幕/代码弹幕，文本没有复用价值。
        if (mode === 7 || mode === 8)
            continue;
        const text = normalizeText(decodeXml(match[2]));
        if (isNoise(text))
            continue;
        rows.push({ at, mode, pool, text });
    }
    return rows;
}

function pickSurface(surfaces) {
    let best = '';
    let bestCount = -1;
    for (const [text, count] of surfaces) {
        if (count > bestCount || (count === bestCount && text.length < best.length)) {
            best = text;
            bestCount = count;
        }
    }
    return best;
}

function round1(value) {
    return Number(Number(value).toFixed(1));
}

/**
 * 按时间轴分桶，每桶取重复度最高的若干条；跨桶重复的文本只保留一次并记 alsoAt。
 * @param {{at:number,text:string}[]} rows
 */
export function bucketDanmaku(rows, {
    duration = 0,
    bucketSec = 0,
    perBucket = DANMAKU_LIMITS.perBucket,
    maxBuckets = DANMAKU_LIMITS.maxBuckets,
} = {}) {
    const span = Math.max(Number(duration) || 0, ...rows.map(row => row.at), 1);
    const sec = bucketSec > 0
        ? bucketSec
        : Math.min(DANMAKU_LIMITS.maxBucketSec, Math.max(DANMAKU_LIMITS.minBucketSec, Math.ceil(span / maxBuckets)));
    const total = Math.max(1, Math.min(maxBuckets, Math.ceil(span / sec)));
    const buckets = Array.from({ length: total }, (_, index) => ({
        from: index * sec,
        to: (index + 1) * sec,
        raw: 0,
        keys: new Map(),
    }));
    for (const row of rows) {
        const index = Math.max(0, Math.min(total - 1, Math.floor(row.at / sec)));
        const bucket = buckets[index];
        bucket.raw += 1;
        const key = repeatKey(row.text);
        if (key === '')
            continue;
        const entry = bucket.keys.get(key)
            ?? { key, count: 0, surfaces: new Map(), firstAt: row.at };
        entry.count += 1;
        entry.surfaces.set(row.text, (entry.surfaces.get(row.text) ?? 0) + 1);
        if (row.at < entry.firstAt)
            entry.firstAt = row.at;
        bucket.keys.set(key, entry);
    }

    const seen = new Map();
    const out = [];
    let kept = 0;
    for (const bucket of buckets) {
        const ranked = [...bucket.keys.values()].sort((left, right) => right.count - left.count
            || left.firstAt - right.firstAt
            || pickSurface(left.surfaces).length - pickSurface(right.surfaces).length);
        const top = [];
        for (const entry of ranked) {
            const existing = seen.get(entry.key);
            if (existing !== undefined) {
                existing.total += entry.count;
                if (existing.alsoAt.length < 5 && !existing.alsoAt.includes(round1(bucket.from)))
                    existing.alsoAt.push(round1(bucket.from));
                continue;
            }
            if (top.length >= perBucket)
                break;
            // count 是「本桶内」的次数，total 是整条视频累计的次数；渲染只看桶内，抽梗看 total。
            const item = {
                text: pickSurface(entry.surfaces),
                count: entry.count,
                total: entry.count,
                at: round1(entry.firstAt),
                alsoAt: [],
            };
            seen.set(entry.key, item);
            top.push(item);
            out.push(item);
        }
        bucket.top = top;
        bucket.unique = bucket.keys.size;
        delete bucket.keys;
        kept += top.length;
    }
    return { bucketSec: sec, buckets, total, kept };
}

function fmt(sec) {
    const value = Math.max(0, Math.round(Number(sec) || 0));
    return String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
}

/** 渲染成给模型看的时间轴：每桶一行，×N 表示同一簇被刷的次数。 */
export function renderTimeline(result, { maxChars = 4000, perBucket = 4 } = {}) {
    if (result?.ok !== true)
        return '';
    const lines = [];
    for (const bucket of result.buckets ?? []) {
        if (!Array.isArray(bucket.top) || bucket.top.length === 0)
            continue;
        // 优先只列「重复过」的（同一条被刷 ≥2 次才是梗信号）；整桶没人重复时退化成 2 条上下文。
        const repeated = bucket.top.filter(item => item.count >= 2);
        const picked = repeated.length > 0 ? repeated.slice(0, perBucket) : bucket.top.slice(0, Math.min(2, perBucket));
        const items = picked.map(item => item.text + '×' + item.count).join('、');
        lines.push(fmt(bucket.from) + '-' + fmt(bucket.to) + ' ' + bucket.raw + ' 条 | ' + items);
    }
    let text = lines.join('\n');
    if (text.length > maxChars)
        text = text.slice(0, maxChars) + '\n……（弹幕时间轴已截断）';
    return text;
}

/** 把入选帧的时间点映射到所在桶，得到「这个时间点画面是什么、弹幕在刷什么」的对照。 */
export function alignFrames(result, frames) {
    if (result?.ok !== true || !Array.isArray(frames))
        return [];
    const buckets = result.buckets ?? [];
    return frames.map(frame => {
        const at = Number(frame?.at ?? 0);
        const bucket = buckets[Math.max(0, Math.min(buckets.length - 1, Math.floor(at / (result.bucketSec || 1))))];
        const top = Array.isArray(bucket?.top) ? bucket.top.slice(0, 3).map(item => item.text) : [];
        return {
            at: round1(at),
            window: bucket === undefined ? '' : fmt(bucket.from) + '-' + fmt(bucket.to),
            danmaku: top,
        };
    });
}

/**
 * 抓取并分桶。任何失败都返回 ok:false + reason（如 DANMAKU_HTTP_412 / DANMAKU_TOO_LARGE），
 * 由调用方写进 manifest，不阻断视频本身的处理。
 */
export async function collectDanmaku({
    cid,
    duration = 0,
    bucketSec = 0,
    perBucket = DANMAKU_LIMITS.perBucket,
    maxBuckets = DANMAKU_LIMITS.maxBuckets,
    maxRows = DANMAKU_LIMITS.maxRows,
    maxBytes = DANMAKU_LIMITS.maxBytes,
    timeoutMs = 20_000,
} = {}) {
    const started = Date.now();
    const base = {
        ok: false,
        reason: '',
        cid: Number(cid) || 0,
        total: 0,
        unique: 0,
        kept: 0,
        bytes: 0,
        ms: 0,
        bucketSec: 0,
        buckets: [],
        truncated: false,
    };
    if (!Number(cid)) {
        return { ...base, reason: '没有 cid，取不到弹幕', ms: Date.now() - started };
    }
    let buffer;
    try {
        const response = await fetch('https://api.bilibili.com/x/v1/dm/list.so?oid=' + encodeURIComponent(String(cid)), {
            headers: apiHeaders(),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status === 412 || response.status === 429)
            return { ...base, reason: 'DANMAKU_RISK_' + response.status, ms: Date.now() - started };
        if (!response.ok)
            return { ...base, reason: 'DANMAKU_HTTP_' + response.status, ms: Date.now() - started };
        const declared = Number(response.headers.get('content-length') ?? 0);
        if (declared > maxBytes)
            return { ...base, reason: 'DANMAKU_TOO_LARGE_' + declared, bytes: declared, ms: Date.now() - started };
        buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > maxBytes)
            return { ...base, reason: 'DANMAKU_TOO_LARGE_' + buffer.length, bytes: buffer.length, ms: Date.now() - started };
    }
    catch (error) {
        return { ...base, reason: String(error?.message ?? error), ms: Date.now() - started };
    }
    const xml = buffer.toString('utf8');
    if (!xml.includes('<d p='))
        return { ...base, reason: 'DANMAKU_EMPTY', bytes: buffer.length, ms: Date.now() - started };

    const rows = parseDanmakuXml(xml);
    const truncated = rows.length > maxRows;
    const sliced = truncated ? rows.slice(0, maxRows) : rows;
    const result = bucketDanmaku(sliced, { duration, bucketSec, perBucket, maxBuckets });
    return {
        ...base,
        ok: true,
        total: rows.length,
        unique: new Set(rows.map(row => row.text)).size,
        kept: result.kept,
        bytes: buffer.length,
        ms: Date.now() - started,
        bucketSec: result.bucketSec,
        buckets: result.buckets,
        truncated,
    };
}
