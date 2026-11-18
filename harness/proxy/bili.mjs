/**
 * B 站观看：取流 → 关键帧基线 → 可疑 GOP 定点场景兜底 → 选帧 → 交给视觉。
 *
 * 设计边界：
 * - 只做「取内容 / 取画面 / 记账」，不管回复策略与发消息。
 * - 只用系统 ffmpeg/ffprobe，不引入 PyAV。
 * - 临时视频与未入选帧在本次任务结束前删掉；入选帧由 vision 打完标后删除。
 * - 保留的上限：单视频 ≤300MB / ≤20 分钟；临时目录 6 小时 TTL 清扫；
 *   工作盘可用空间低于 10GB 时暂停新下载（恢复后自动继续）。
 * - 不设每日条数上限，只按天累计条数 / 流量 / 平均耗时供面板查看。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { cookieHeaderValue, currentAccount, ensureAccount, markInvalid } from './bili-account.mjs';
import { analyzeStructure, extractAudio, transcribe } from './bili-audio.mjs';
import { collectDanmaku } from './bili-danmaku.mjs';
import { apiHeaders, mediaHeaders, navigateHeaders } from './bili-fingerprint.mjs';
import { aboutSelfForKeyword, detectAboutSelf, loadPool } from './bili-pool-config.mjs';
import { summarizeVideo } from './bili-summary.mjs';
import { listUploads } from './bili-uploads.mjs';
import { collectFrames, grabFrame, planAdaptiveSampling, probeVideo, sceneCuts } from './video-frames.mjs';
import { observeFrames, VISION_STATE_PATH } from './vision.mjs';

const HOME = 'Y:\\dsh\\home\\qq-persona';
export const BILI_ROOT = process.env.QQ_BILI_ROOT ?? join(HOME, 'tmp', 'bili');
export const BILI_STATE_PATH = process.env.QQ_BILI_STATE ?? join(HOME, 'bili-state.json');
const FEED_PATH = process.env.QQ_CONVERSATION_FEED ?? join(HOME, 'conversation-feed.jsonl');
const NOTEBOOK_PATH = process.env.QQ_NOTEBOOK ?? join(HOME, 'notebook.json');
const PREFS_PATH = process.env.QQ_BILI_PREFS ?? join(HOME, 'bili-prefs.json');
const POOL_STATE_PATH = process.env.QQ_BILI_POOL_STATE ?? join(HOME, 'bili-pool-state.json');

const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
const MAX_DURATION_SEC = 20 * 60;
// 主动刷的 ASR 档位分界：实测 medium@4 的 RTF 在 0.25–0.40 之间，
// 600s 以内最坏约 4 分钟；超过就换 small（同机 RTF 约为 medium 的一半），
// 这样 20 分钟硬上限的片子转写也不会超过 4 分钟，不会把一轮主动刷占满。
const PROACTIVE_MEDIUM_MAX_SEC = 10 * 60;
// 工作盘可用空间低于 10GB 时暂停新下载（可用环境变量临时调低做测试）。
const MIN_FREE_BYTES = Number(process.env.QQ_BILI_MIN_FREE_BYTES) || 10 * 1024 ** 3;
const MAX_FRAMES = 12;
// 没有字幕时的降级路径：自适应采样，但视觉调用/帧数/耗时都封顶。
const SUMMARY_FRAME_BUDGET = Number(process.env.QQ_BILI_SUMMARY_FRAMES) || 30;
const SUMMARY_TIME_BUDGET_MS = Number(process.env.QQ_BILI_SUMMARY_TIME_MS) || 300_000;
const TMP_TTL_MS = 6 * 3600_000;
// 观看记录硬上限：面板可翻，但不让它无限长。
const HISTORY_LIMIT = 500;

const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

let navCache;
let chain = Promise.resolve();

function nowSec() {
    return Math.floor(Date.now() / 1000);
}

function keyOf(url) {
    return String(url).split('/').at(-1).split('.')[0];
}

export function signWbi(params, images, now = Date.now()) {
    const raw = keyOf(images?.img_url ?? '') + keyOf(images?.sub_url ?? '');
    if (raw.length !== 64)
        throw new Error('WBI 密钥缺失');
    const key = MIXIN.map(index => raw[index]).join('').slice(0, 32);
    const values = { ...params, wts: Math.floor(now / 1000) };
    delete values.w_rid;
    const query = Object.keys(values).sort()
        .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(String(values[k]).replace(/[!'()*]/gu, '')))
        .join('&');
    return query + '&w_rid=' + createHash('md5').update(query + key).digest('hex');
}

async function fetchJson(url, { signed = false, timeoutMs = 20_000, retried = false } = {}) {
    let target = url;
    if (signed) {
        navCache ??= await (async () => {
            // 取 WBI 公钥的 nav 刻意不带 cookie：失效 cookie 会让 nav 直接 -101，连带 WBI 签名一起挂。
            const response = await fetch('https://api.bilibili.com/x/web-interface/nav', {
                headers: apiHeaders(),
                signal: AbortSignal.timeout(timeoutMs),
            });
            const data = await response.json();
            return { images: data?.data?.wbi_img, at: Date.now() };
        })();
        if (Date.now() - navCache.at > 5 * 60_000) {
            navCache = undefined;
            return fetchJson(url, { signed, timeoutMs, retried });
        }
        const query = new URL(target).searchParams;
        const params = Object.fromEntries(query.entries());
        target = target.split('?')[0] + '?' + signWbi(params, navCache.images);
    }
    // 只有显式绑定且校验通过时才带 SESSDATA；指纹 cookie 一直带，和浏览器保持一致。
    const headers = apiHeaders();
    const cookie = await cookieHeaderValue();
    if (cookie !== null)
        headers.cookie = cookie;
    const response = await fetch(target, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 412 || response.status === 429)
        throw new Error('BILI_RISK_' + response.status);
    if (!response.ok)
        throw new Error('BILI_HTTP_' + response.status);
    const data = await response.json();
    if (data?.code !== 0) {
        // 带着 cookie 却被判未登录：标记失效并立刻去掉 cookie 重试一次（明确降级，不静默当已登录）。
        if (Number(data?.code) === -101 && cookie !== null && !retried) {
            await markInvalid('-101 账号未登录（SESSDATA 已失效）');
            return fetchJson(url, { signed, timeoutMs, retried: true });
        }
        throw new Error('BILI_CODE_' + data?.code + ':' + (data?.message ?? ''));
    }
    return data.data;
}

export function parseRef(text) {
    const input = String(text ?? '');
    const bv = /BV[0-9A-Za-z]{10}/u.exec(input)?.[0];
    const av = /av(\d{1,12})/iu.exec(input);
    const page = /[?&]p=(\d{1,3})/u.exec(input);
    return {
        bvid: bv ?? (av ? 'av' + av[1] : undefined),
        page: page ? Number(page[1]) : 1,
        short: /b23\.tv|bili2233\.cn/u.test(input),
        raw: input.trim(),
    };
}

async function resolveShort(url) {
    const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: navigateHeaders(),
        signal: AbortSignal.timeout(15_000),
    });
    return response.url;
}

export async function videoInfo(ref) {
    let parsed = parseRef(ref);
    if (parsed.bvid === undefined && parsed.short) {
        const url = /https?:\/\/[^\s]+/u.exec(parsed.raw)?.[0];
        if (url === undefined)
            throw new Error('没有识别到 B 站链接');
        parsed = { ...parsed, ...parseRef(await resolveShort(url)) };
    }
    if (parsed.bvid === undefined)
        throw new Error('没有识别到 BV/av 号');
    const query = parsed.bvid.startsWith('av') ? 'aid=' + parsed.bvid.slice(2) : 'bvid=' + parsed.bvid;
    const data = await fetchJson('https://api.bilibili.com/x/web-interface/view?' + query, { signed: true });
    const pages = Array.isArray(data.pages) ? data.pages : [];
    const page = pages[Math.max(0, Math.min(parsed.page - 1, pages.length - 1))] ?? pages[0];
    return {
        bvid: data.bvid,
        aid: data.aid,
        title: String(data.title ?? ''),
        duration: Number(data.duration ?? 0),
        owner: String(data.owner?.name ?? ''),
        desc: String(data.desc ?? '').slice(0, 300),
        cover: String(data.pic ?? ''),
        cid: Number(page?.cid ?? data.cid ?? 0),
        part: String(page?.part ?? ''),
        page: parsed.page,
        pages: pages.length,
    };
}

/** DASH 1080P：只取视频轨（音频轨另走 audio 字段，视觉用不上，不浪费带宽）。 */
async function dashVideo(bvid, cid) {
    const params = new URLSearchParams({
        bvid,
        cid: String(cid),
        qn: '80',
        fnval: '16',
        fnver: '0',
        fourk: '0',
        platform: 'pc',
        high_quality: '1',
    });
    const data = await fetchJson('https://api.bilibili.com/x/player/playurl?' + params.toString(), { signed: true });
    const videos = Array.isArray(data?.dash?.video) ? data.dash.video : [];
    // id 最高的一路；同 id 再按码率挑。
    const best = videos
        .filter(item => (item.baseUrl ?? item.base_url) !== undefined)
        .sort((left, right) => Number(right.id) - Number(left.id) || Number(right.bandwidth) - Number(left.bandwidth))[0];
    if (best === undefined)
        return undefined;
    const urls = [best.baseUrl ?? best.base_url, ...(best.backupUrl ?? best.backup_url ?? [])].filter(Boolean);
    return {
        urls,
        // DASH 接口不保证给 size，没有就靠下载时的字节上限兜底。
        size: Number(best.size ?? 0),
        quality: Number(best.id),
        height: Number(best.height ?? 0),
        mode: 'dash',
    };
}

/**
 * 取播放地址。
 * quality='high'：先试 DASH 1080P，失败或没有 dash.video 就回落 720p（有日志）；
 * quality='default'：维持原来的 fnval=1 / qn=80，即 720p 单文件。
 */
export async function playUrl(bvid, cid, { quality = 'default' } = {}) {
    if (quality === 'high') {
        try {
            const dash = await dashVideo(bvid, cid);
            if (dash !== undefined)
                return dash;
            console.warn('[bili] DASH 没有可用的视频流（可能未登录/无 1080P），回落 720p: ' + bvid);
        }
        catch (error) {
            console.warn('[bili] DASH 1080P 请求失败，回落 720p: ' + bvid + ' ' + (error?.message ?? String(error)));
        }
    }
    const params = new URLSearchParams({
        bvid,
        cid: String(cid),
        qn: '80',
        fnval: '1',
        fnver: '0',
        fourk: '0',
        platform: 'pc',
        high_quality: '1',
    });
    const data = await fetchJson('https://api.bilibili.com/x/player/playurl?' + params.toString(), { signed: true });
    const durl = data?.durl?.[0];
    if (durl?.url === undefined)
        throw new Error('没有拿到可下载的播放地址');
    const hosts = [durl.url, ...(Array.isArray(durl.backup_url) ? durl.backup_url : [])];
    return {
        urls: hosts,
        size: Number(durl.size ?? 0),
        quality: Number(data.quality ?? 0),
        height: 0,
        mode: 'durl',
    };
}

/** 视觉抽帧优先 1080P；回填/补课默认 720p，可用环境变量或 bili-prefs.json 显式切。 */
async function qualityForMode(mode) {
    if (mode !== 'backfill' && mode !== 'gap')
        return 'high';
    if (process.env.QQ_BILI_BACKFILL_1080P === '1')
        return 'high';
    const doc = await prefs();
    return doc?.backfillQuality === '1080p' ? 'high' : 'default';
}

async function downloadTo(urls, dest, limitBytes = MAX_VIDEO_BYTES, onProgress) {
    let lastError;
    for (const url of urls) {
        try {
            const response = await fetch(url, {
                headers: mediaHeaders(),
                signal: AbortSignal.timeout(180_000),
            });
            if (!response.ok)
                throw new Error('HTTP ' + response.status);
            const chunks = [];
            let total = 0;
            let nextCheck = 2 * 1024 * 1024;
            for await (const chunk of response.body) {
                total += chunk.length;
                if (total > limitBytes)
                    throw new Error('VIDEO_TOO_LARGE');
                if (total >= nextCheck) {
                    // 下载途中每 2MB 给一次让路检查点：主动刷被真实对话打断时立刻停。
                    nextCheck = total + 2 * 1024 * 1024;
                    onProgress?.(total);
                }
                chunks.push(chunk);
            }
            await writeFile(dest, Buffer.concat(chunks));
            return total;
        }
        catch (error) {
            lastError = error;
            if (error?.message === 'VIDEO_TOO_LARGE')
                throw error;
        }
    }
    throw lastError ?? new Error('下载失败');
}

async function readState() {
    try {
        const parsed = JSON.parse(await readFile(BILI_STATE_PATH, 'utf8'));
        // 旧文件只有 recent；迁移成 history，免得历史记录凭空消失。
        const history = Array.isArray(parsed?.history)
            ? parsed.history
            : (Array.isArray(parsed?.recent) ? parsed.recent : []);
        // 旧文件只有 day/count，没有流量与耗时；迁移成 today 结构，首次写入时补齐。
        const today = parsed?.today !== null && typeof parsed?.today === 'object'
            ? parsed.today
            : { count: Number(parsed?.count ?? 0), bytes: 0, totalMs: 0 };
        return {
            day: String(parsed?.day ?? ''),
            today: {
                count: Number(today.count ?? 0),
                bytes: Number(today.bytes ?? 0),
                totalMs: Number(today.totalMs ?? 0),
            },
            history,
            // 「我正在做什么」：最近几次观看的现状描述，供人格上下文读取。
            activity: Array.isArray(parsed?.activity) ? parsed.activity : [],
        };
    }
    catch {
        return { day: '', today: { count: 0, bytes: 0, totalMs: 0 }, history: [], activity: [] };
    }
}

async function writeState(state) {
    const history = state.history.slice(-HISTORY_LIMIT);
    const { count, bytes, totalMs } = state.today;
    const payload = JSON.stringify({
        updatedAt: new Date().toISOString(),
        day: state.day,
        // 当天统计：条数 / 总流量 / 平均耗时（avgMs 由 totalMs/count 算出）
        today: {
            count,
            bytes,
            totalMs,
            avgMs: count > 0 ? Math.round(totalMs / count) : 0,
        },
        // recent 保留给旧读取方；面板翻页用 history。
        recent: history.slice(-20),
        history,
        // 只留最近 5 条，第一人称描述由 proxy 的 dynamicSections 生成。
        activity: (state.activity ?? []).slice(-5),
    }, null, 2) + '\n';
    await mkdir(dirname(BILI_STATE_PATH), { recursive: true });
    await writeFile(BILI_STATE_PATH + '.tmp', payload, 'utf8');
    await rename(BILI_STATE_PATH + '.tmp', BILI_STATE_PATH);
}

/** 当天（Asia/Shanghai）日期键；跨零点按本地日期清零，不用 UTC 免得早上 8 点才换天。 */
export function localDay(date = new Date()) {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(date);
}

async function remember(entry) {
    const state = await readState();
    const day = localDay();
    if (state.day !== day) {
        state.day = day;
        state.today = { count: 0, bytes: 0, totalMs: 0 };
    }
    state.today.count += 1;
    state.today.bytes += Number(entry.bytes ?? 0);
    state.today.totalMs += Number(entry.totalMs ?? 0);
    state.history = [...state.history, entry].slice(-HISTORY_LIMIT);
    // 「我正在做什么」不是事后统计：把这次观看压成一条第一人称可用的现状记录。
    state.activity = [...(state.activity ?? []), {
        bvid: entry.bvid,
        title: entry.title,
        owner: entry.owner ?? '',
        duration: Number(entry.duration ?? 0),
        source: entry.source ?? 'explicit',
        reason: entry.reason ?? '',
        chatId: entry.chatId ?? '',
        at: entry.at,
        // 摘要只留开头一小段做“我记住了什么”，不整段塞回上下文。
        summary: String(entry.summary ?? '').replace(/\s+/gu, ' ').trim().slice(0, 180),
    }].slice(-5);
    await writeState(state);
}

function appendFeed(entry) {
    const line = JSON.stringify({ ts: Date.now(), ...entry }) + '\n';
    chain = chain.then(async () => {
        await mkdir(dirname(FEED_PATH), { recursive: true });
        await appendFile(FEED_PATH, line, 'utf8');
    }).catch(() => undefined);
    return chain;
}

async function sweepTemp(now = Date.now()) {
    try {
        for (const name of await readdir(BILI_ROOT)) {
            const path = join(BILI_ROOT, name);
            const info = await stat(path).catch(() => undefined);
            if (info !== undefined && now - info.mtimeMs > TMP_TTL_MS)
                await rm(path, { recursive: true, force: true });
        }
    }
    catch {
        // 目录不存在说明第一次跑
    }
}

/**
 * 磁盘兜底：工作盘可用空间低于阈值就暂停新下载。
 * 只在每次下载前现算，不落盘旗标，所以空间恢复后下一次自动继续。
 */
export async function diskStatus() {
    const gb = bytes => (Number(bytes) / 1024 ** 3).toFixed(1);
    try {
        await mkdir(BILI_ROOT, { recursive: true });
        const info = await statfs(BILI_ROOT);
        const freeBytes = Number(info.bavail) * Number(info.bsize);
        const paused = freeBytes < MIN_FREE_BYTES;
        return {
            root: BILI_ROOT,
            freeBytes,
            thresholdBytes: MIN_FREE_BYTES,
            paused,
            reason: paused
                ? '可用 ' + gb(freeBytes) + 'GB，低于 ' + gb(MIN_FREE_BYTES) + 'GB 阈值，已暂停新的下载'
                : '',
        };
    }
    catch (error) {
        // 量不到空间时不拦下载，但把原因暴露给面板，避免静默。
        return {
            root: BILI_ROOT,
            freeBytes: null,
            thresholdBytes: MIN_FREE_BYTES,
            paused: false,
            reason: '磁盘空间检测失败：' + String(error?.message ?? error),
        };
    }
}

async function prefs() {
    try {
        const parsed = JSON.parse(await readFile(PREFS_PATH, 'utf8'));
        return parsed !== null && typeof parsed === 'object' ? parsed : {};
    }
    catch {
        return {};
    }
}

let followingCache;

/** 关注列表（只有绑定账号才查得到）；失败就当空集，不拦选片。 */
async function followingNames() {
    if (followingCache !== undefined && Date.now() - followingCache.at < 10 * 60_000)
        return followingCache.names;
    const names = new Set();
    try {
        const account = await currentAccount();
        if (account?.status === 'ok' && account.mid) {
            for (let pn = 1; pn <= 2; pn += 1) {
                const data = await fetchJson('https://api.bilibili.com/x/relation/followings?vmid='
                    + account.mid + '&pn=' + pn + '&ps=50&order=desc', { signed: true });
                const list = Array.isArray(data?.list) ? data.list : [];
                for (const row of list)
                    names.add(String(row.uname ?? ''));
                if (list.length < 50)
                    break;
            }
        }
    }
    catch {
        // 关注列表拉不到不影响热门候选
    }
    followingCache = { names, at: Date.now() };
    return names;
}

/**
 * 选片打分：UP 权重（可配置）+ 关注列表加成 + 标题关键词权重。
 * 配置格式见 bili-prefs.json；旧的「关键词→权重」平铺格式仍当作 titleWeights。
 */
function scoreItem(item, prefsDoc, followed) {
    const title = String(item.title ?? '');
    const owner = String(item.owner ?? '');
    const titleWeights = prefsDoc?.titleWeights ?? prefsDoc?.weights ?? {};
    let score = 0;
    for (const [keyword, weight] of Object.entries(titleWeights)) {
        if (keyword !== '' && title.includes(keyword))
            score += Number(weight) || 0;
    }
    for (const [up, weight] of Object.entries(prefsDoc?.upWeights ?? {})) {
        if (up !== '' && owner.includes(up))
            score += Number(weight) || 0;
    }
    if (followed?.has(owner))
        score += Number(prefsDoc?.followedBonus ?? 0);
    if ((prefsDoc?.exclude ?? []).some(word => word !== '' && title.includes(word)))
        score -= 1000;
    return score;
}

function normalizeItem(item, prefsDoc, followed) {
    const title = String(item.title ?? '').replace(/<[^>]+>/gu, '');
    return {
        bvid: String(item.bvid ?? ''),
        title,
        owner: String(item.owner?.name ?? item.author ?? ''),
        play: Number(item.play ?? item.stat?.view ?? 0),
        duration: Number(item.duration ?? item.stat?.duration ?? 0),
        score: scoreItem({ title, owner: String(item.owner?.name ?? item.author ?? '') }, prefsDoc, followed),
    };
}

async function notebookEntriesForActivity() {
    try {
        const doc = JSON.parse(await readFile(NOTEBOOK_PATH, 'utf8'));
        return Array.isArray(doc?.entries) ? doc.entries : [];
    }
    catch {
        // 没记过记忆或文件损坏都只是“没有关联”，不影响查看观看记录。
        return [];
    }
}

/** 我最近看了什么：在本地把 activity 和记忆条目对上，形成可追踪的 bvid → memoryIds。 */
async function recentActivity() {
    const state = await readState();
    const entries = await notebookEntriesForActivity();
    const items = (state.activity ?? []).slice(-5).reverse().map(item => {
        const title = String(item.title ?? '');
        const bvid = String(item.bvid ?? '');
        const matched = entries.filter(entry => {
            const blob = JSON.stringify(entry);
            return (bvid !== '' && blob.includes(bvid))
                || (title.length >= 4 && blob.includes(title));
        });
        return {
            bvid,
            title,
            owner: item.owner ?? '',
            duration: Number(item.duration ?? 0),
            at: item.at ?? '',
            source: item.source ?? '',
            reason: item.reason ?? '',
            summary: item.summary ?? '',
            // 这条视频实际留下的记忆；空数组表示还没影响记忆。
            memoryIds: matched.map(entry => entry.id),
            memoryNotes: matched.map(entry => String(entry.text ?? '').slice(0, 60)).slice(0, 3),
        };
    });
    return { kind: 'recent', count: items.length, items };
}

export async function feed({ kind = 'hot', query = '', limit = 6 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 6, 12));
    // recent 不联网：只回我自己最近看了什么、为什么看、留下了什么记忆。
    if (kind === 'recent')
        return recentActivity();
    let url;
    if (kind === 'search') {
        if (String(query).trim() === '')
            throw new Error('搜索需要关键词');
        url = 'https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=video&page=1&page_size='
            + safeLimit + '&keyword=' + encodeURIComponent(String(query).trim());
    }
    else if (kind === 'rank') {
        url = 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all';
    }
    else {
        url = 'https://api.bilibili.com/x/web-interface/popular?pn=1&ps=' + safeLimit;
    }
    const data = await fetchJson(url, { signed: true });
    const raw = kind === 'search' ? (data?.result ?? []) : (data?.list ?? []);
    const prefsDoc = await prefs();
    const followed = await followingNames();
    const items = raw.map(item => normalizeItem(item, prefsDoc, followed)).filter(item => item.bvid !== '');
    items.sort((a, b) => b.score - a.score);
    return { kind, count: items.length, items: items.slice(0, safeLimit) };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 拉 CC 字幕（player/v2 的字幕列表 + 字幕 json 正文）。
 * 拿不到（UP 没传 / 需登录 / 只有不可用的 AI 字幕）就返回 ok:false，由调用方走降级。
 */
export async function subtitleText(bvid, cid) {
    try {
        const fetchTracks = async () => {
            const data = await fetchJson('https://api.bilibili.com/x/player/v2?bvid=' + encodeURIComponent(bvid)
                + '&cid=' + encodeURIComponent(String(cid)), { signed: true });
            return Array.isArray(data?.subtitle?.subtitles) ? data.subtitle.subtitles : [];
        };
        const pickTrack = list => list.find(track => /^zh/iu.test(String(track?.lan ?? '')))
            ?? list.find(track => /zh|ai-zh/u.test(String(track?.lan ?? '')))
            ?? list[0];
        let tracks = await fetchTracks();
        if (tracks.length === 0)
            return { ok: false, reason: '没有字幕轨道', tracks: 0 };
        let pick = pickTrack(tracks);
        let raw = String(pick?.subtitle_url ?? '');
        // 字幕列表偶尔先返回轨道、地址后到：带退避重取同一接口，仍为空才走降级。
        let retried = 0;
        for (const delay of [800, 1600]) {
            if (raw !== '')
                break;
            await sleep(delay);
            retried += 1;
            try {
                tracks = await fetchTracks();
                pick = pickTrack(tracks);
                raw = String(pick?.subtitle_url ?? '');
            }
            catch {
                // 重取失败也继续退避一次；两次都拿不到才降级。
            }
        }
        if (raw === '')
            return { ok: false, reason: '字幕地址为空（重取 ' + retried + ' 次后仍为空）', tracks: tracks.length };
        const url = raw.startsWith('//') ? 'https:' + raw : raw;
        const response = await fetch(url, {
            headers: mediaHeaders((await cookieHeaderValue()) ?? undefined),
            signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok)
            return { ok: false, reason: '字幕下载 HTTP ' + response.status, tracks: tracks.length };
        const doc = await response.json();
        const body = Array.isArray(doc?.body) ? doc.body : [];
        const lines = [];
        for (const row of body) {
            const content = String(row?.content ?? '').replace(/\s+/gu, ' ').trim();
            // 纯音效标记（[音乐]、[掌声]）对总结没用，去掉。
            if (content === '' || /^\[[^\]]+\]$/u.test(content))
                continue;
            const at = Math.max(0, Number(row?.from ?? 0));
            lines.push('[' + String(Math.floor(at / 60)).padStart(2, '0') + ':'
                + String(Math.floor(at % 60)).padStart(2, '0') + '] ' + content);
        }
        const text = lines.join('\n');
        return {
            ok: text.length > 0,
            lang: String(pick?.lan_doc || pick?.lan || ''),
            chars: text.length,
            text,
            tracks: tracks.length,
            reason: text.length > 0 ? '' : '字幕正文为空',
        };
    }
    catch (error) {
        return { ok: false, reason: String(error?.message ?? error), tracks: 0 };
    }
}

/** 等这一批帧打完标，读回画面描述；超时就用已有的。 */
async function collectVisionCaptions({ title, since, expect, deadlineMs = 150_000 }) {
    const deadline = Date.now() + deadlineMs;
    let captions = [];
    let lastCount = 0;
    let stagnant = 0;
    // vision-state 只留最近 20 条：等够一部分且连续几轮不再增长就收手。
    const cap = Math.min(expect, 18);
    while (true) {
        try {
            const parsed = JSON.parse(await readFile(VISION_STATE_PATH, 'utf8'));
            const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
            captions = entries
                .filter(entry => entry?.source === 'bili' && entry.video === title && Number(entry.at ?? 0) >= since)
                .map(entry => String(entry.text ?? ''))
                .filter(Boolean);
        }
        catch {
            // 还没有 vision-state 就继续等
        }
        if (captions.length >= cap || Date.now() >= deadline)
            return captions;
        if (captions.length > 0 && captions.length === lastCount)
            stagnant += 1;
        else if (captions.length > 0)
            stagnant = 0;
        lastCount = captions.length;
        if (stagnant >= 4)
            return captions;
        await sleep(1_500);
    }
}

/** 搜索接口的时长是 "mm:ss" 或 "hh:mm:ss"；Number() 会 NaN，统一解析成秒。 */
export function parseDurationText(value) {
    const text = String(value ?? '').trim();
    if (/^\d+$/u.test(text))
        return Number(text);
    const parts = text.split(':');
    if (parts.length < 2 || parts.length > 3)
        return 0;
    const nums = parts.map(part => Number(part));
    if (nums.some(num => !Number.isFinite(num) || num < 0))
        return 0;
    return nums.reduce((total, num) => total * 60 + num, 0);
}

/** 全站搜索（WBI 签名）；order=totalrank 综合 / click 播放量。 */
export async function searchVideos({ query = '', order = 'totalrank', limit = 6, timeoutMs = 20_000 } = {}) {
    const keyword = String(query).trim();
    if (keyword === '')
        throw new Error('搜索需要关键词');
    const safe = Math.max(1, Math.min(Number(limit) || 6, 20));
    const url = 'https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=video&page=1&page_size='
        + safe + '&order=' + encodeURIComponent(String(order)) + '&keyword=' + encodeURIComponent(keyword);
    const data = await fetchJson(url, { signed: true, timeoutMs });
    const raw = Array.isArray(data?.result) ? data.result : [];
    return raw.map(row => {
        const bvid = String(row?.bvid ?? '') || (/BV[0-9A-Za-z]{10}/u.exec(String(row?.arcurl ?? ''))?.[0] ?? '');
        return {
            bvid,
            title: String(row?.title ?? '').replace(/<[^>]+>/gu, ''),
            owner: String(row?.author ?? ''),
            play: Number(row?.play ?? 0),
            duration: parseDurationText(row?.duration),
            pubdate: Number(row?.pubdate ?? 0),
            query: keyword,
            order: String(order),
        };
    }).filter(item => item.bvid !== '' && item.duration > 0);
}

/** 二创关键词轮转：每次取 perRun 个，偏移持久化在 bili-pool-state.json，几轮能覆盖全表。 */
async function rotateKeywords(doc, count) {
    const all = (Array.isArray(doc?.keywords) ? doc.keywords : []).map(item => String(item)).filter(Boolean);
    if (all.length === 0)
        return { keywords: [], state: {} };
    let offset = 0;
    try {
        offset = Number(JSON.parse(await readFile(POOL_STATE_PATH, 'utf8'))?.searchOffset ?? 0) || 0;
    }
    catch {
        offset = 0;
    }
    const size = Math.max(1, Math.min(Number(count) || 4, all.length));
    const keywords = [];
    for (let index = 0; index < size; index += 1)
        keywords.push(all[(offset + index) % all.length]);
    return { keywords, state: { searchOffset: (offset + size) % all.length } };
}

async function readPoolState() {
    try {
        return JSON.parse(await readFile(POOL_STATE_PATH, 'utf8'));
    }
    catch {
        return {};
    }
}

async function writePoolState(patch) {
    const current = await readPoolState();
    const payload = JSON.stringify({ ...current, ...patch, updatedAt: new Date().toISOString() }, null, 2) + '\n';
    try {
        await writeFile(POOL_STATE_PATH + '.tmp', payload, 'utf8');
        await rename(POOL_STATE_PATH + '.tmp', POOL_STATE_PATH);
    }
    catch {
        // 轮转状态写不进去只影响下一轮起点，不拦选片。
    }
}

/**
 * 主动刷选片：热门 + 固定名单 UP 投稿 + 二创关键词搜索，按 BV 去重后统一打分。
 * 一次只返回一条；pool 里带每个来源的原始数 / 去重后数 / 入选贡献，供日志排查。
 */
export async function pickProactive({ exclude = [], poolSize = 36, withSearch = true } = {}) {
    const prefsDoc = await prefs();
    const poolDoc = loadPool();
    const followed = await followingNames();
    const seen = new Set(exclude.map(item => String(item)));
    const stats = {
        hot: { raw: 0, kept: 0 },
        up: { raw: 0, kept: 0, perUp: [] },
        search: { raw: 0, kept: 0, keywords: [], perKeyword: [] },
    };
    const merged = new Map();

    const add = (item, origin) => {
        if (item.bvid === '' || seen.has(item.bvid))
            return false;
        const current = merged.get(item.bvid);
        if (current !== undefined) {
            current.alsoIn = [...new Set([...(current.alsoIn ?? []), origin])];
            current.score = Math.max(current.score, item.score);
            return false;
        }
        merged.set(item.bvid, { ...item, origin, alsoIn: [] });
        return true;
    };

    // 1) 热门（保持现状）
    let hotRaw = [];
    try {
        const data = await fetchJson('https://api.bilibili.com/x/web-interface/popular?pn=1&ps='
            + Math.max(10, Math.min(Number(poolSize) || 36, 50)));
        hotRaw = Array.isArray(data?.list) ? data.list : [];
    }
    catch (error) {
        stats.hot.error = String(error?.message ?? error).slice(0, 120);
    }
    stats.hot.raw = hotRaw.length;
    for (const raw of hotRaw) {
        const item = normalizeItem(raw, prefsDoc, followed);
        if (item.duration < 60 || item.duration > MAX_DURATION_SEC)
            continue;
        if (add(item, 'hot'))
            stats.hot.kept += 1;
    }

    // 2) 固定名单 UP 投稿（App cursor 接口，近 N 天）；梗指南（memeSource）是常驻主来源，
    //    除近一年全量外还带一批「历史高播放」——两者复用同一套分页/去重/合并，不是第二条链路。
    const upPool = [...(Array.isArray(poolDoc.upPool) ? poolDoc.upPool : [])];
    if (poolDoc.memeSource?.enabled !== false && Number(poolDoc.memeSource?.mid) > 0)
        upPool.push(poolDoc.memeSource);
    for (const up of upPool) {
        const windowDays = Number(up.days) || 7;
        const list = await listUploads(up.mid, {
            days: windowDays,
            ps: Number(up.ps) || 12,
            pages: Number(up.pages) || 2,
        });
        const entry = {
            mid: Number(up.mid),
            name: String(up.name ?? ''),
            count: list.items.length,
            kept: 0,
            reason: list.ok ? '' : String(list.reason ?? ''),
        };
        stats.up.raw += list.items.length;
        for (const raw of list.items) {
            const item = {
                bvid: raw.bvid,
                title: String(raw.title ?? ''),
                owner: String(raw.owner ?? up.name ?? ''),
                play: Number(raw.play ?? 0),
                duration: Number(raw.duration ?? 0),
                upName: entry.name,
                source: 'up',
            };
            item.score = scoreItem(item, prefsDoc, followed);
            if (item.duration < 60 || item.duration > MAX_DURATION_SEC)
                continue;
            if (add(item, 'up')) {
                entry.kept += 1;
                stats.up.kept += 1;
            }
        }
        // 历史高播放补录：同一接口拉深分页，按播放阈值筛，结果缓存 7 天，不每轮重扫。
        const hotPlay = Number(up.hotPlay) || 0;
        if (hotPlay > 0) {
            const cacheHours = Number(up.archiveRefreshHours) || 168;
            const state = await readPoolState();
            const cached = state.archive?.[String(up.mid)];
            let archived = Array.isArray(cached?.items) ? cached.items : [];
            const fresh = cached !== undefined && Date.now() - Number(cached.at ?? 0) < cacheHours * 3600_000;
            if (!fresh) {
                const deep = await listUploads(up.mid, {
                    days: Number(up.archiveDays) || 3650,
                    ps: Number(up.ps) || 50,
                    pages: Number(up.archivePages) || 32,
                });
                const since = Date.now() - windowDays * 86400_000;
                archived = deep.items
                    .filter(item => Date.parse(item.pubdate) < since && Number(item.play) >= hotPlay)
                    .map(item => ({
                        bvid: item.bvid,
                        title: item.title,
                        owner: item.owner,
                        play: item.play,
                        duration: item.duration,
                        pubdate: item.pubdate,
                        source: 'up-archive',
                    }));
                await writePoolState({
                    archive: {
                        ...(state.archive ?? {}),
                        [String(up.mid)]: { at: Date.now(), hotPlay, windowDays, items: archived },
                    },
                });
            }
            entry.archive = { hotPlay, windowDays, count: archived.length, kept: 0, refreshed: !fresh };
            stats.up.raw += archived.length;
            for (const raw of archived) {
                const item = {
                    bvid: raw.bvid,
                    title: String(raw.title ?? ''),
                    owner: String(raw.owner ?? up.name ?? ''),
                    play: Number(raw.play ?? 0),
                    duration: Number(raw.duration ?? 0),
                    upName: entry.name,
                    source: 'up-archive',
                };
                item.score = scoreItem(item, prefsDoc, followed);
                if (item.duration < 60 || item.duration > MAX_DURATION_SEC)
                    continue;
                if (add(item, 'up')) {
                    entry.archive.kept += 1;
                    entry.kept += 1;
                    stats.up.kept += 1;
                }
            }
            await sleep(600);
        }
        stats.up.perUp.push(entry);
        await sleep(600);
    }

    // 3) 关键词搜索（二创拟人词轮转；综合 + 播放量两种排序）
    if (withSearch) {
        const keywordsDoc = poolDoc.selfKeywords ?? {};
        const rotation = await rotateKeywords(keywordsDoc, Number(keywordsDoc.perRun) || 4);
        stats.search.keywords = rotation.keywords;
        const orders = Array.isArray(poolDoc.search?.orders) && poolDoc.search.orders.length > 0
            ? poolDoc.search.orders
            : ['totalrank', 'click'];
        const topN = Number(poolDoc.search?.topN) || 6;
        for (const keyword of rotation.keywords) {
            const per = { keyword, raw: 0, kept: 0, orders: [] };
            for (const order of orders) {
                let list = [];
                try {
                    list = await searchVideos({ query: keyword, order, limit: topN });
                }
                catch (error) {
                    per.orders.push({ order, count: 0, error: String(error?.message ?? error).slice(0, 80) });
                    continue;
                }
                per.orders.push({ order, count: list.length });
                per.raw += list.length;
                for (const raw of list) {
                    // 标题里明确写了哪个模型就听标题的，否则沿用搜索关键词对应的模型。
                    const detected = detectAboutSelf(keywordsDoc, raw.title);
                    const item = {
                        ...raw,
                        score: scoreItem(raw, prefsDoc, followed),
                        aboutSelf: detected.aboutSelf || aboutSelfForKeyword(keywordsDoc, keyword),
                        aboutSelfSource: detected.aboutSelf !== '' ? 'title' : 'keyword',
                    };
                    if (item.duration < 60 || item.duration > MAX_DURATION_SEC)
                        continue;
                    if (add(item, 'search'))
                        per.kept += 1;
                }
                await sleep(300);
            }
            stats.search.raw += per.raw;
            stats.search.kept += per.kept;
            stats.search.perKeyword.push(per);
        }
        await writePoolState(rotation.state);
    }

    const items = [...merged.values()]
        .filter(item => item.score > -500)
        .sort((a, b) => b.score - a.score || b.play - a.play);
    const top = items.slice(0, 5);
    const selectedBySource = { hot: 0, up: 0, search: 0 };
    for (const item of top)
        selectedBySource[item.origin] = (selectedBySource[item.origin] ?? 0) + 1;
    return {
        picked: items[0] ?? null,
        candidates: top.map(item => ({
            bvid: item.bvid,
            title: item.title,
            owner: item.owner,
            score: item.score,
            origin: item.origin,
            aboutSelf: item.aboutSelf ?? '',
        })),
        pool: stats,
        dedupe: {
            before: stats.hot.raw + stats.up.raw + stats.search.raw,
            after: merged.size,
        },
        selectedBySource,
    };
}

/**
 * 看一条视频：基线关键帧 + 可疑 GOP 场景兜底，选出 ≤12 帧交给 vision。
 * observe=false 时只产出帧与 manifest，不喂视觉（用于离线验证）。
 */
export async function watch(ref, {
    chatId = 'bili:local',
    maxFrames = MAX_FRAMES,
    observe = true,
    triggeredBy = '',
    mode = 'requested',
    shouldYield,
    summarize = false,
    // 弹幕只读采集（匿名接口，一次请求）；失败只记 manifest，不影响视频本身。
    withDanmaku = true,
    // 回填只要产物，不写观看历史、不喂人格 feed。
    record = true,
    // 长视频批次单独抬高；默认仍是全局 20 分钟 / 300MB 硬上限。
    maxDurationSec = MAX_DURATION_SEC,
    maxVideoBytes = MAX_VIDEO_BYTES,
    asrThreads = 4,
    // 这次为什么看：explicit（用户点名）/ feed（刷到）/ proactive（自己刷）/ backfill。
    source = '',
    reason = '',
} = {}) {
    await sweepTemp();
    const disk = await diskStatus();
    if (disk.paused) {
        throw new Error('磁盘可用空间不足（' + (Number(disk.freeBytes) / 1024 ** 3).toFixed(1)
            + 'GB < ' + (MIN_FREE_BYTES / 1024 ** 3).toFixed(0) + 'GB），已暂停新的 B 站下载，清理空间后自动恢复');
    }
    const startedAt = Date.now();
    const timing = {};
    // 让路检查点：主动刷时一旦有真实对话/GPU 被占用就抛 BILI_YIELD，由调用方按放弃记录。
    const checkYield = (where) => {
        if (typeof shouldYield !== 'function')
            return;
        const reason = shouldYield();
        if (reason === false || reason === undefined || reason === null || reason === '')
            return;
        const error = new Error('BILI_YIELD:' + String(reason) + '（' + where + '）');
        error.code = 'BILI_YIELD';
        error.reason = String(reason);
        error.where = where;
        throw error;
    };
    checkYield('取信息前');
    // 失效会在这一步落盘 invalid，后续请求自动去掉 cookie（降级为未登录），不会静默当已登录。
    const account = await ensureAccount();

    let stepAt = Date.now();
    const info = await videoInfo(ref);
    timing.meta = Date.now() - stepAt;
    if (info.duration > maxDurationSec)
        throw new Error('视频过长（' + info.duration + 's > ' + maxDurationSec + 's），拒绝下载');

    // 弹幕：一次匿名只读请求 + 时间轴分桶。取不到只记原因，不影响视频本身。
    let danmaku = null;
    if (withDanmaku) {
        stepAt = Date.now();
        danmaku = await collectDanmaku({ cid: info.cid, duration: info.duration });
        timing.danmaku = Date.now() - stepAt;
        if (!danmaku.ok)
            console.warn('[bili] 弹幕取不到（' + danmaku.reason + '）：' + info.bvid);
    }

    stepAt = Date.now();
    // 视觉抽帧优先 1080P（DASH 视频轨）；回填默认 720p，显式开关才切。
    const wantedQuality = await qualityForMode(mode);
    let play = await playUrl(info.bvid, info.cid, { quality: wantedQuality });
    timing.playurl = Date.now() - stepAt;
    // 1080P 更容易顶到 300MB：先按声明体积降级，降级失败才拒收，不整条丢。
    if (play.size > maxVideoBytes && play.quality > 64) {
        console.warn('[bili] ' + play.quality + 'P 体积 ' + play.size + 'B 超上限，降级 720p: ' + info.bvid);
        play = await playUrl(info.bvid, info.cid, { quality: 'default' });
        timing.qualityFallback = true;
    }
    if (play.size > maxVideoBytes)
        throw new Error('文件过大（' + play.size + 'B），拒绝下载');

    checkYield('下载前');
    const work = join(BILI_ROOT, 'bili-' + info.bvid + '-' + Date.now());
    await mkdir(work, { recursive: true });
    const video = join(work, 'video.mp4');
    stepAt = Date.now();
    let bytes;
    try {
        bytes = await downloadTo(play.urls, video, maxVideoBytes, () => checkYield('下载中'));
    }
    catch (error) {
        // 1080P 下载途中撞上限：降级 720p 重下一次，而不是把整条丢掉。
        if (error?.message === 'VIDEO_TOO_LARGE' && play.quality > 64) {
            console.warn('[bili] ' + play.quality + 'P 下载超过 ' + maxVideoBytes + 'B，降级 720p 重下: ' + info.bvid);
            timing.qualityFallback = true;
            try {
                play = await playUrl(info.bvid, info.cid, { quality: 'default' });
                bytes = await downloadTo(play.urls, video, maxVideoBytes, () => checkYield('下载中'));
            }
            catch (retryError) {
                await rm(work, { recursive: true, force: true });
                throw retryError;
            }
        }
        else {
            // 半截视频不留在盘上：主动刷被打断也不占空间。
            await rm(work, { recursive: true, force: true });
            throw error;
        }
    }
    timing.download = Date.now() - stepAt;

    stepAt = Date.now();
    const meta = await probeVideo(video);
    timing.probe = Date.now() - stepAt;

    checkYield('取帧前');
    stepAt = Date.now();
    // 抽帧链路与 QQ 视频共用同一份实现（video-frames.mjs）。
    const frames = await collectFrames({
        file: video,
        workDir: work,
        maxFrames: Math.min(maxFrames, MAX_FRAMES),
        duration: meta.duration,
        onYield: checkYield,
    });
    const { chosen, keys, rescueCandidates, medianBytes } = frames;
    const sceneHits = frames.sceneHits;
    timing.keyframes = frames.timing.keyframes;
    timing.sceneRescue = frames.timing.sceneRescue;
    timing.grabRescue = frames.timing.grabRescue;
    // 总结优先用字幕；没有字幕就本地转写；两者都拿不到才按自适应密度补帧（降级路径）。
    let subtitle = { ok: false, reason: '未请求总结', tracks: 0 };
    let sampling = null;
    let asr = null;
    let structure = null;
    if (summarize) {
        stepAt = Date.now();
        subtitle = await subtitleText(info.bvid, info.cid);
        timing.subtitle = Date.now() - stepAt;
        // 音轨只抽一份，ASR 与结构分析共用；字幕可用时也要，结构信息照样进总结。
        try {
            checkYield('抽音轨前');
            stepAt = Date.now();
            const wav = join(work, 'audio16k.wav');
            await extractAudio(video, wav);
            timing.audioExtract = Date.now() - stepAt;
            // 音频结构与视觉/ASR 串行，共用同一套让路判定。
            checkYield('音频结构前');
            stepAt = Date.now();
            structure = await analyzeStructure(wav, join(work, 'structure.json'));
            timing.structure = Date.now() - stepAt;
            if (!subtitle.ok) {
                // 后台主动刷与回填默认 medium，但长片降成 small：单次转写控制在一轮窗口内。
                const asrModel = !(mode === 'proactive' || mode === 'backfill')
                    ? 'small'
                    : ((Number(info.duration) || 0) > PROACTIVE_MEDIUM_MAX_SEC ? 'small' : 'medium');
                checkYield('ASR 前');
                stepAt = Date.now();
                asr = await transcribe({
                    wav,
                    model: asrModel,
                    threads: Math.max(1, Number(asrThreads) || 4),
                    initialPrompt: 'UP 主：' + info.owner + '。视频标题：' + info.title + '。',
                    out: join(work, 'asr.json'),
                    cancelFile: join(work, 'asr.cancel'),
                    shouldYield: () => (typeof shouldYield === 'function' ? shouldYield() : ''),
                });
                timing.asr = Date.now() - stepAt;
                if (asr?.ok === true) {
                    // 转写稿留档（可复查）：临时目录会被清掉，这里另存一份按 bvid 命名。
                    const archive = join(HOME, 'asr-transcripts', info.bvid + '.json');
                    try {
                        await mkdir(dirname(archive), { recursive: true });
                        await copyFile(join(work, 'asr.json'), archive);
                        asr.transcriptPath = archive;
                    }
                    catch {
                        // 留档失败不影响总结
                    }
                }
            }
        }
        catch (error) {
            await rm(work, { recursive: true, force: true });
            throw error;
        }
        if (!subtitle.ok && asr?.ok !== true) {
            checkYield('采样补帧前');
            stepAt = Date.now();
            try {
                const cuts = await sceneCuts(video);
                timing.sceneCuts = Date.now() - stepAt;
                const plan = planAdaptiveSampling({
                    duration: meta.duration,
                    cuts,
                    budgetFrames: SUMMARY_FRAME_BUDGET,
                });
                const dir = join(work, 'adaptive');
                await mkdir(dir, { recursive: true });
                let grabbed = 0;
                let covered = false;
                for (const target of plan.targets) {
                    if (Date.now() - stepAt > SUMMARY_TIME_BUDGET_MS) {
                        covered = true;
                        plan.stats.trimmed += plan.targets.length - grabbed;
                        plan.stats.degraded.push({
                            from: Math.round(target.at),
                            to: Math.round(meta.duration),
                            reason: '时间预算用完',
                        });
                        break;
                    }
                    checkYield('采样补帧中');
                    const path = join(dir, 'a-' + Math.round(target.at * 1000) + '.jpg');
                    try {
                        const size = await grabFrame(video, target.at, path);
                        chosen.push({ at: target.at, path, why: 'adaptive', bytes: size });
                        grabbed += 1;
                    }
                    catch {
                        // 个别时间点抓不到就跳过
                    }
                }
                chosen.sort((first, second) => first.at - second.at);
                timing.adaptive = Date.now() - stepAt;
                sampling = {
                    mode: 'adaptive',
                    cuts: cuts.length,
                    ...plan.stats,
                    grabbed,
                    timeTrimmed: covered,
                    elapsedMs: timing.adaptive,
                    budgetMs: SUMMARY_TIME_BUDGET_MS,
                    budgetFrames: SUMMARY_FRAME_BUDGET,
                };
            }
            catch (error) {
                await rm(work, { recursive: true, force: true });
                throw error;
            }
        }
        else if (subtitle.ok) {
            sampling = { mode: 'subtitle', tracks: subtitle.tracks ?? 0 };
        }
        else {
            // 有转写就不需要加密抽帧：保持关键帧规模，画面只做辅助证据。
            sampling = {
                mode: 'asr',
                model: asr.model,
                threads: asr.threads,
                chars: asr.chars,
                segments: asr.segments,
                wallMs: asr.wallMs,
                rtf: asr.rtf,
            };
        }
    }
    for (const frame of chosen)
        frame.bytes = await stat(frame.path).then(info => info.size).catch(() => 0);

    // 视频本体用完即删；画面只看入选帧。
    await rm(video, { force: true });

    if (observe && chosen.length > 0) {
        try {
            // 帧已经落盘但还没开始打标：这时让路就直接丢掉，把后续帧处理挂起（不占 vision 队列）。
            checkYield('打标前');
        }
        catch (error) {
            await rm(work, { recursive: true, force: true });
            throw error;
        }
        observeFrames({
            paths: chosen.map(frame => frame.path),
            chatId,
            source: 'bili',
            hint: {
                bvid: info.bvid,
                title: info.title,
                owner: info.owner,
                duration: info.duration,
                pts: chosen.map(frame => frame.at),
            },
        });
    }

    // 有字幕/转写就用文本总结；都没有才等这批均匀帧打完标，用画面观察做降级总结。
    let summary = null;
    // 画面观察文本是本次实际产物之一，落进观看记录，面板/后续抽取都能复用。
    let summaryCaptions = [];
    if (summarize) {
        stepAt = Date.now();
        const useText = subtitle.ok || asr?.ok === true;
        summaryCaptions = useText ? [] : await collectVisionCaptions({
            title: info.title,
            since: startedAt - 5_000,
            expect: chosen.length,
        });
        summary = await summarizeVideo({
            title: info.title,
            owner: info.owner,
            duration: info.duration,
            subtitle,
            asr,
            structure,
            captions: summaryCaptions,
        });
        timing.summary = Date.now() - stepAt;
    }

    const manifest = {
        ok: true,
        bvid: info.bvid,
        title: info.title,
        owner: info.owner,
        duration: info.duration,
        // 总结与来源（字幕 / 降级画面采样）一起落盘，面板能回看当时总结出了什么。
        summary: summary === null ? null : {
            ok: summary.ok === true,
            source: summary.source,
            degraded: summary.degraded ?? '',
            text: summary.text,
            chars: summary.chars,
            ms: summary.ms,
            reason: summary.reason ?? '',
            subtitleLang: summary.subtitleLang ?? '',
            subtitleChars: summary.subtitleChars ?? 0,
            asrModel: summary.asrModel ?? '',
            asrChars: summary.asrChars ?? 0,
        },
        subtitle: {
            ok: subtitle.ok === true,
            lang: subtitle.lang ?? '',
            chars: subtitle.chars ?? 0,
            tracks: subtitle.tracks ?? 0,
            reason: subtitle.reason ?? '',
        },
        // 转写档位与耗时：面板能看出这条是「字幕」还是「medium/small 转写」跑出来的。
        asr: asr === null ? null : {
            ok: asr.ok === true,
            model: asr.model ?? '',
            threads: asr.threads ?? 0,
            chars: asr.chars ?? 0,
            segments: asr.segments ?? 0,
            wallMs: asr.wallMs ?? 0,
            rtf: asr.rtf ?? null,
            reason: asr.reason ?? '',
            transcriptPath: asr.transcriptPath ?? '',
        },
        // 音频结构：分段占比 + 可读的结构线，作为「值得看」的依据。
        structure: structure === null ? null : {
            ok: structure.ok === true,
            coveragePct: structure.coveragePct ?? {},
            segments: structure.segments ?? 0,
            musicBlocks: structure.musicBlocks ?? 0,
            silenceCount: structure.silenceCount ?? 0,
            hints: structure.hints ?? [],
            timingMs: structure.timingMs ?? 0,
        },
        // 采样档位与密度：事后能看出这条是「字幕」还是「自适应 1fps↔8fps」跑出来的。
        sampling: sampling ?? { mode: summarize ? 'subtitle' : 'none' },
        // 弹幕：原始条数 / 保留数 / 桶宽 / 每桶重复度最高的条目；取不到时 ok:false + reason。
        danmaku: danmaku === null ? null : {
            ok: danmaku.ok,
            reason: danmaku.reason,
            cid: danmaku.cid,
            total: danmaku.total,
            unique: danmaku.unique,
            kept: danmaku.kept,
            bytes: danmaku.bytes,
            bucketSec: danmaku.bucketSec,
            truncated: danmaku.truncated,
            ms: danmaku.ms,
            buckets: danmaku.buckets,
        },
        // 画面观察原文（只在没有字幕/转写时产生），和 summary 一起作为本次实际产物。
        visionCaptions: summaryCaptions.slice(0, 12),
        quality: play.quality,
        // 实际走的取流方式：dash=1080P 视频轨，durl=720p 单文件；降级过会带 qualityFallback。
        stream: play.mode ?? 'durl',
        qualityFallback: timing.qualityFallback === true,
        // 本次实际用的身份；invalid 表示 SESSDATA 已判定失效、已降级为未登录。
        account: {
            status: account.status,
            mid: account.mid ?? null,
            uname: account.uname ?? '',
            error: account.error ?? '',
        },
        videoBytes: bytes,
        videoProbe: meta,
        gop: {
            keyframes: keys.length,
            avgSec: keys.length > 1 ? Number(((keys.at(-1).at - keys[0].at) / (keys.length - 1)).toFixed(2)) : 0,
            medianKeyBytes: medianBytes,
        },
        frames: chosen.map(frame => ({ at: frame.at, why: frame.why, path: frame.path, bytes: frame.bytes })),
        rescue: {
            gopsChecked: frames.picked,
            sceneHits: sceneHits.length,
            kept: chosen.filter(frame => frame.why === 'scene').length,
            missedByKeyframeOnly: rescueCandidates.filter(frame => {
                const nearest = keys.reduce((best, key) => Math.abs(key.at - frame.at) < Math.abs(best - frame.at) ? key : best, keys[0]);
                return Math.abs(nearest.at - frame.at) > 1;
            }).length,
        },
        timing: { ...timing, total: Date.now() - startedAt },
        chatId,
        at: new Date().toISOString(),
    };
    await writeFile(join(work, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    manifest.workDir = work;

    // 回填只回 manifest，不写观看历史与 feed。
    if (!record)
        return manifest;

    appendFeed({
        kind: 'bili',
        role: 'system',
        chat: String(chatId).startsWith('group:') ? chatId : 'bili:local',
        chatId,
        sender: 'bili',
        text: '[B站] 看了《' + info.title + '》（' + info.bvid + '）'
            + '，取 ' + chosen.length + ' 帧，场景兜底救回 ' + manifest.rescue.kept + ' 帧'
            + (account.status === 'invalid' ? '（SESSDATA 已失效，本次按未登录 720p 取流）' : ''),
        summary: summary?.ok === true ? summary.text : '',
        bvid: info.bvid,
        title: info.title,
        duration: info.duration,
        frames: chosen.length,
        rescued: manifest.rescue.kept,
        totalMs: manifest.timing.total,
    });
    await remember({
        at: new Date().toISOString(),
        bvid: info.bvid,
        title: info.title,
        owner: info.owner,
        duration: info.duration,
        quality: play.quality,
        frames: chosen.length,
        keyframes: keys.length,
        rescued: manifest.rescue.kept,
        totalMs: manifest.timing.total,
        bytes,
        chatId,
        triggeredBy: String(triggeredBy === '' ? chatId : triggeredBy),
        mode: mode === 'proactive' ? 'proactive' : 'requested',
        source: source !== '' ? String(source) : (mode === 'proactive' ? 'proactive' : 'explicit'),
        reason: String(reason ?? '').slice(0, 200),
        account: account.status,
        // 面板要能回看当时总结出了什么，以及来源是字幕还是降级采样。
        summary: summary?.ok === true ? summary.text : '',
        summarySource: summary?.source ?? '',
        summaryChars: Number(summary?.chars ?? 0),
        summaryMs: Number(summary?.ms ?? 0),
        summaryReason: summary?.ok === true ? '' : (summary?.reason ?? ''),
        // 只有真降级才有值：frames-only / asr-short，供面板显示，不进给模型的文本。
        summaryDegraded: summary?.ok === true ? (summary.degraded ?? '') : '',
        subtitleChars: Number(subtitle?.chars ?? 0),
        sampling: manifest.sampling,
        // 面板补一栏：ASR 档位/字数/耗时 + 音频结构摘要，事后能看清这条是怎么总结出来的。
        asrModel: asr?.model ?? '',
        asrThreads: Number(asr?.threads ?? 0),
        asrChars: Number(asr?.chars ?? 0),
        asrSegments: Number(asr?.segments ?? 0),
        asrMs: Number(asr?.wallMs ?? 0),
        asrReason: asr?.ok === true ? '' : (asr?.reason ?? ''),
        audioCoverage: structure?.coveragePct ?? null,
        audioHints: (structure?.hints ?? []).slice(0, 8).join('；'),
        audioMs: Number(structure?.timingMs ?? 0),
        // 弹幕只读采集的结果：面板能看出这条视频拿到多少条、分桶后留了多少。
        danmakuTotal: Number(danmaku?.total ?? 0),
        danmakuKept: Number(danmaku?.kept ?? 0),
        danmakuReason: danmaku?.ok === true ? '' : String(danmaku?.reason ?? ''),
        // 实际观看产物：面板/复盘能顺藤摸到本次的帧、转写、manifest 与画面观察原文。
        workDir: work,
        manifestPath: join(work, 'manifest.json'),
        framePaths: chosen.map(frame => frame.path),
        transcriptPath: asr?.transcriptPath ?? '',
        visionCaptions: summaryCaptions.slice(0, 12),
        danmakuBuckets: Array.isArray(danmaku?.buckets) ? danmaku.buckets.length : 0,
        subtitleLang: subtitle?.lang ?? '',
    });
    return manifest;
}

/** WebUI / 状态页用：当天统计 + 磁盘兜底 + 账号 + 可翻页的观看记录。 */
export async function snapshot({ page = 1, size = 20 } = {}) {
    const state = await readState();
    const account = await currentAccount();
    const disk = await diskStatus();
    const day = localDay();
    const fresh = state.day === day ? state.today : { count: 0, bytes: 0, totalMs: 0 };
    const all = [...state.history].reverse();
    const safeSize = Math.max(5, Math.min(Number(size) || 20, 100));
    const pages = Math.max(1, Math.ceil(all.length / safeSize));
    const safePage = Math.max(1, Math.min(Number(page) || 1, pages));
    const start = (safePage - 1) * safeSize;
    // 当天按触发方式拆分：主动刷 / 被要求刷，面板分开显示。
    const sumOf = rows => ({
        count: rows.length,
        bytes: rows.reduce((total, row) => total + Number(row.bytes ?? 0), 0),
        totalMs: rows.reduce((total, row) => total + Number(row.totalMs ?? 0), 0),
    });
    const todayRows = state.history.filter(entry => {
        const at = new Date(entry.at);
        return Number.isFinite(at.getTime()) && localDay(at) === day;
    });
    return {
        day,
        today: {
            count: fresh.count,
            bytes: fresh.bytes,
            totalMs: fresh.totalMs,
            avgMs: fresh.count > 0 ? Math.round(fresh.totalMs / fresh.count) : 0,
        },
        byMode: {
            proactive: sumOf(todayRows.filter(entry => entry.mode === 'proactive')),
            requested: sumOf(todayRows.filter(entry => entry.mode !== 'proactive')),
        },
        disk,
        account,
        total: all.length,
        page: safePage,
        size: safeSize,
        pages,
        items: all.slice(start, start + safeSize),
        recent: all.slice(0, 10),
        root: BILI_ROOT,
    };
}
