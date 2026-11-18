/**
 * 伪实时视觉：群里没人叫机器人时，后台把新图看一眼并写成一句话。
 *
 * 约束：
 * - 不保存任何图片副本；做完标记立刻删掉插件的临时媒体文件。
 * - 唯一的落盘文件是 vision-state.json，纯文字，滚动保留 40 条 / 60 分钟。
 * - 与出图共用显卡：GPU 租约有效时暂停，租约释放后再继续。
 */
import { readFileSync } from 'node:fs';
import { readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { readLease } from './gpu-lease.mjs';
import { annotateEntry, candidateSuffix } from './identity-index.mjs';
import { LLM, chatCompletionsPath, normalizePayload } from './llm-config.mjs';

export const VISION_STATE_PATH = process.env.QQ_VISION_STATE ?? 'Y:\\dsh\\home\\qq-persona\\vision-state.json';
const VISION_URL = process.env.QQ_VISION_URL ?? (new URL(LLM.baseUrl).origin + chatCompletionsPath());
const VISION_MODEL = process.env.QQ_VISION_MODEL ?? LLM.model;
const SHARP_PATH = process.env.QQ_VISION_SHARP
    ?? 'C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\sharp\\dist\\index.mjs';

// 看过的图要能在压缩之后回想：保留 60 分钟、40 条，注入窗口 30 分钟。
const ENTRY_TTL_MS = 60 * 60_000;
const MAX_ENTRIES = 40;
const NOTE_AGE_MS = 30 * 60_000;
const MAX_NOTE_ENTRIES = 3;
// 打标分辨率（长边像素）。768 会把 logo、花纹这类小细节糊掉，可按实测覆盖。
const MAX_EDGE = Number(process.env.QQ_VISION_MAX_EDGE) || 768;
const MIN_GAP_MS = 8_000;
// B 站一批 12 帧是同一个场景的连续观察，按批内 1.2s 连发，别让 8s 间隔把一批拖成两分钟。
const BATCH_GAP_MS = 1_200;
const MAX_QUEUE = 32;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const SEEN_TTL_MS = 5 * 60_000;

const queue = [];
const seen = new Map();
let running = false;
let lastRunAt = 0;
let sharpPromise;
let stateCache;
let stateCacheMtime = -1;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function loadSharp() {
    sharpPromise ??= import('file:///' + SHARP_PATH.replace(/\\/gu, '/').replace(/^\/+/u, ''))
        .then(module => module.default ?? module)
        .catch(() => undefined);
    return sharpPromise;
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

async function readState() {
    let mtime = -1;
    try {
        mtime = (await stat(VISION_STATE_PATH)).mtimeMs;
    }
    catch {
        mtime = -1;
    }
    // 宿主和代理都能写这份文件：mtime 变了就重读，别拿旧快照把别人刚写的记录覆盖掉。
    if (stateCache !== undefined && mtime === stateCacheMtime)
        return stateCache;
    try {
        const parsed = JSON.parse(await readFile(VISION_STATE_PATH, 'utf8'));
        const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
        stateCache = { entries };
    }
    catch {
        stateCache = { entries: [] };
    }
    stateCacheMtime = mtime;
    return stateCache;
}

function prune(entries, now) {
    return entries
        .filter(entry => Number.isFinite(entry?.at) && now - entry.at <= ENTRY_TTL_MS)
        .slice(-MAX_ENTRIES);
}

async function writeState(entries) {
    stateCache = { entries };
    const payload = JSON.stringify({ updatedAt: new Date().toISOString(), entries }, null, 2) + '\n';
    const temp = VISION_STATE_PATH + '.tmp';
    await writeFile(temp, payload, 'utf8');
    await rename(temp, VISION_STATE_PATH);
}

function localTime(at) {
    return new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
}

/** 给下一轮对话准备一段“刚看到的图”。同一会话只取最近 3 条。 */
export async function noteForChat(chatId) {
    if (typeof chatId !== 'string' || chatId === '')
        return '';
    const now = Date.now();
    const doc = await readState();
    const entries = prune(doc.entries, now)
        .filter(entry => entry.chatId === chatId && now - entry.at <= NOTE_AGE_MS);
    if (entries.length === 0)
        return '';
    const chatImages = entries.filter(entry => entry.source !== 'bili' && entry.source !== 'qqvideo').slice(-MAX_NOTE_ENTRIES);
    const biliFrames = entries.filter(entry => entry.source === 'bili').slice(-MAX_NOTE_ENTRIES);
    const videoFrames = entries.filter(entry => entry.source === 'qqvideo').slice(-MAX_NOTE_ENTRIES);
    const lines = [];
    if (chatImages.length > 0) {
        lines.push('【你刚看到的图（别人发的，不要逐条复述，只在你需要时参考）】');
        lines.push(...chatImages.map(entry => '- ' + localTime(entry.at) + ' ' + entry.text + candidateSuffix(entry)));
    }
    if (videoFrames.length > 0) {
        lines.push('【群里的视频（自动看过一遍，不要逐条复述；要细节再调 qq_read_video）】');
        lines.push(...videoFrames.map(entry => '- ' + localTime(entry.at) + ' 视频：' + entry.text + candidateSuffix(entry)));
    }
    if (biliFrames.length > 0) {
        lines.push('【你刚刷到的 B 站画面（不要逐条复述，聊到相关内容时再自然引用）】');
        lines.push(...biliFrames.map(entry => {
            const where = entry.video ? '《' + entry.video + '》' : 'B 站视频';
            return '- ' + localTime(entry.at) + ' ' + where + '：' + entry.text + candidateSuffix(entry);
        }));
    }
    return lines.join('\n') + '\n';
}

/** 把一张图放进观察队列；deleteAfter 会在打标后删掉临时文件。
 *  references 是可选的标志参考图（[{label,path}]），不传就与原先完全一致。 */
export function observeImage({ path, chatId, deleteAfter = true, source = 'chat', hint, batch = false, references } = {}) {
    if (typeof path !== 'string' || path === '')
        return;
    const now = Date.now();
    const key = String(chatId ?? '') + '|' + path;
    const last = seen.get(key);
    if (last !== undefined && now - last < SEEN_TTL_MS)
        return;
    seen.set(key, now);
    for (const [entryKey, at] of seen) {
        if (now - at > SEEN_TTL_MS * 2)
            seen.delete(entryKey);
    }
    if (queue.length >= MAX_QUEUE) {
        const dropped = queue.shift();
        if (dropped?.deleteAfter === true)
            void removeMedia(dropped.path);
    }
    queue.push({
        path, chatId: String(chatId ?? 'unknown'), deleteAfter, enqueuedAt: now,
        source, hint, batch,
        references: Array.isArray(references) && references.length > 0 ? references : undefined,
    });
    void startWorker();
}

/** B 站一批帧：同一支视频的画面作为一批观察，批内不按 8s 间隔排队。 */
export function observeFrames({ paths, chatId, hint, source = 'bili' } = {}) {
    if (!Array.isArray(paths))
        return 0;
    paths.forEach((path, index) => {
        observeImage({
            path,
            chatId,
            source,
            hint: hint === undefined ? undefined : { ...hint, at: Array.isArray(hint.pts) ? hint.pts[index] : undefined },
            batch: true,
        });
    });
    return paths.length;
}

/** 只写一条纯文字观察（例如抽帧超时），不经过视觉模型。 */
export async function observeText({ chatId, text, source = 'qqvideo' } = {}) {
    const value = String(text ?? '').trim();
    if (value === '')
        return;
    const doc = await readState();
    const entries = prune(doc.entries, Date.now());
    entries.push({
        at: Date.now(),
        chatId: String(chatId ?? 'unknown'),
        text: value.slice(0, 160),
        source,
    });
    await writeState(entries);
}

/** 等视觉队列跑空（测试/工具里用），返回是否在超时前完成。 */
export async function waitForVisionIdle(timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!running && queue.length === 0)
            return true;
        await sleep(250);
    }
    return !running && queue.length === 0;
}

async function startWorker() {
    if (running)
        return;
    running = true;
    try {
        while (queue.length > 0) {
            if ((await readLease()) !== undefined) {
                await sleep(30_000);
                continue;
            }
            const job = queue.shift();
            if (job === undefined)
                break;
            const gap = job.batch === true ? BATCH_GAP_MS : MIN_GAP_MS;
            const wait = gap - (Date.now() - lastRunAt);
            if (wait > 0)
                await sleep(wait);
            lastRunAt = Date.now();
            await runJob(job);
        }
    }
    finally {
        running = false;
    }
}

function sniffMime(bytes) {
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
        return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
        return 'image/jpeg';
    if (bytes.length >= 6 && bytes.toString('ascii', 0, 3) === 'GIF')
        return 'image/gif';
    if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
        return 'image/webp';
    return undefined;
}

async function preparePng(bytes) {
    const mime = sniffMime(bytes);
    if (mime === undefined)
        return undefined;
    const sharp = await loadSharp();
    if (sharp === undefined) {
        // 压缩不可用时不能退回原图：大图会按原分辨率进模型，直接吃掉上百页 KV。
        // 这一张按“没图”处理，聊天回合继续，不因为压缩失败而整轮失败。
        return undefined;
    }
    try {
        return await sharp(bytes, { animated: false })
            .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
            .png({ compressionLevel: 9 })
            .toBuffer();
    }
    catch {
        return undefined;
    }
}

/**
 * 统一特征词表：bili / chat / qqvideo 三路共用同一套，
 * 只允许从这里取值，模型自由发挥的词一律丢弃。
 */
const BASE_MARKERS = ['星星', '月亮', '花饰', '王冠', '发带', '蝴蝶结', '缎带', '十字', '齿轮', '羽毛', '锁链', '心形'];

/** 标志物参考集是配置，不是代码：形态与判别依据都写在 marker-catalog.json。 */
export const MARKER_CATALOG_PATH = process.env.QQ_MARKER_CATALOG
    ?? 'Y:\\dsh\\home\\qq-persona\\marker-catalog.json';

function loadMarkerCatalog() {
    try {
        const raw = JSON.parse(readFileSync(MARKER_CATALOG_PATH, 'utf8'));
        const markers = Array.isArray(raw?.markers)
            ? raw.markers.filter(item => typeof item?.label === 'string' && item.label !== '')
            : [];
        const generic = Array.isArray(raw?.generic)
            ? raw.generic.filter(item => typeof item?.label === 'string' && item.label !== '')
            : [];
        const guards = Array.isArray(raw?.guards)
            ? raw.guards.filter(item => typeof item === 'string' && item !== '')
            : [];
        return { markers, generic, guards };
    }
    catch {
        return { markers: [], generic: [], guards: [] };
    }
}

const MARKER_CATALOG = loadMarkerCatalog();
/** 别名（OpenAI标志 / OpenAI logo 等）→ 词表里的唯一值，避免模型换一种写法就被丢掉。 */
const MARKER_ALIASES = new Map();
for (const marker of MARKER_CATALOG.markers) {
    for (const alias of [marker.label, ...(marker.aliases ?? [])])
        MARKER_ALIASES.set(String(alias).trim().toLowerCase(), marker.label);
}
const CATALOG_MARKERS = MARKER_CATALOG.markers.map(item => item.label);
/** 标志参考图（few-shot）默认不启用：只有调用方显式传 references 时才读图，现有链路行为不变。 */
const MARKER_REFERENCE_DIR = dirname(MARKER_CATALOG_PATH);

export function markerReferences(labels) {
    const wanted = Array.isArray(labels) && labels.length > 0 ? new Set(labels) : undefined;
    return MARKER_CATALOG.markers
        .filter(item => typeof item.reference === 'string' && item.reference !== '')
        .filter(item => wanted === undefined || wanted.has(item.label))
        .map(item => ({ label: item.label, path: join(MARKER_REFERENCE_DIR, item.reference) }));
}
/** 给 prompt 的判别说明：形态 + 判据 + 容易混成什么。 */
const MARKER_GUIDE = [
    ...MARKER_CATALOG.markers.map(item => item.label + '=' + item.form
        + (Array.isArray(item.discriminators) && item.discriminators.length > 0
            ? '（判据：' + item.discriminators.join('；') + '）'
            : '')
        + (typeof item.notThis === 'string' && item.notThis !== '' ? '（不要混成：' + item.notThis + '）' : '')),
    ...MARKER_CATALOG.generic.map(item => item.label + '=' + item.form
        + (typeof item.rule === 'string' && item.rule !== '' ? '（' + item.rule + '）' : '')),
    ...MARKER_CATALOG.guards,
].join('；');

export const FEATURE_ENUMS = {
    hairColor: ['银白', '浅紫', '紫', '蓝紫', '蓝', '青绿', '绿', '金', '橙', '红', '棕', '黑', '粉', '灰'],
    hairStyle: ['长直', '长卷', '双马尾', '单马尾', '短发', '丸子头', '双丸子', '齐肩'],
    earType: ['无', '猫耳', '狐耳', '兔耳', '精灵耳', '恶魔角', '羊角', '龙角', '其他兽耳'],
    eyeColor: ['红', '橙金', '黄', '绿', '蓝', '紫', '粉', '异色瞳'],
    proportion: ['正常', 'Q版'],
    palette: ['暖橙', '冷紫', '白金', '蓝紫', '黑白', '红黑', '粉白'],
    markers: [...BASE_MARKERS, ...CATALOG_MARKERS.filter(label => !BASE_MARKERS.includes(label))],
};

const ENUM_HINT = Object.entries(FEATURE_ENUMS)
    .map(([key, values]) => key + '=' + values.join('/'))
    .join('；');

function pickEnum(value, allowed) {
    return Array.isArray(value)
        ? [...new Set(value.filter(item => typeof item === 'string' && allowed.includes(item)))].slice(0, 3)
        : [];
}

/** 校验并裁剪 observed 栏；不合法字段直接丢掉，不整条丢弃。 */
export function normalizeObserved(raw) {
    if (raw === null || typeof raw !== 'object')
        return undefined;
    const observed = {};
    for (const [key, allowed] of Object.entries(FEATURE_ENUMS)) {
        // markers 先按配置里的别名归一（OpenAI标志/OpenAI logo → GPT标志），再过滤。
        const incoming = key === 'markers' && Array.isArray(raw[key])
            ? raw[key].map(value => (typeof value === 'string'
                ? (MARKER_ALIASES.get(value.trim().toLowerCase()) ?? value.trim())
                : value))
            : raw[key];
        observed[key] = pickEnum(incoming, allowed);
    }
    observed.role = typeof raw.role === 'string' ? raw.role.trim().slice(0, 20) : '';
    observed.ocrText = typeof raw.ocrText === 'string' ? raw.ocrText.trim().slice(0, 60) : '';
    const hasAny = observed.role !== '' || observed.ocrText !== ''
        || Object.keys(FEATURE_ENUMS).some(key => observed[key].length > 0);
    return hasAny ? observed : undefined;
}

/** 校验 inferred 栏：必须带 basis 与 confidence，否则整条丢弃。 */
export function normalizeInferred(raw) {
    if (!Array.isArray(raw))
        return undefined;
    const inferred = [];
    for (const item of raw) {
        if (item === null || typeof item !== 'object')
            continue;
        const claim = typeof item.claim === 'string' ? item.claim.trim().slice(0, 40) : '';
        const basis = Array.isArray(item.basis)
            ? item.basis.filter(tag => typeof tag === 'string' && tag.trim() !== '').map(tag => tag.trim().slice(0, 20)).slice(0, 4)
            : [];
        const confidence = Number(item.confidence);
        if (claim === '' || basis.length === 0 || !Number.isFinite(confidence))
            continue;
        inferred.push({ claim, basis, confidence: Math.min(1, Math.max(0, confidence)) });
        if (inferred.length >= 3)
            break;
    }
    return inferred.length > 0 ? inferred : undefined;
}

/** 0..1 置信度；拿不到就 0，不猜。 */
function clampConfidence(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0;
}

/** 标签列表：[{value,confidence}]；不允许空值、重复、超量。 */
function normalizeTagList(raw, { limit = 3, maxLength = 12 } = {}) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const item of raw) {
        const value = typeof item === 'string' ? item : item?.value;
        if (typeof value !== 'string' || value.trim() === '')
            continue;
        const text = value.trim().slice(0, maxLength);
        if (out.some(existing => existing.value === text))
            continue;
        out.push({
            value: text,
            confidence: clampConfidence(typeof item === 'object' ? item?.confidence : 0),
        });
        if (out.length >= limit)
            break;
    }
    return out;
}

/**
 * 表情包结构化打标：情绪/场景/强度/图上文字/忌用场景，每项带置信度。
 * 只做形状与范围校验，不做词表校验（词表在 sticker-lib 落库时统一裁）。
 */
export function normalizeStickerTags(raw) {
    if (raw === null || typeof raw !== 'object')
        return undefined;
    const emotionValue = typeof raw.emotion === 'object' ? raw.emotion?.value : raw.emotion;
    const emotion = typeof emotionValue === 'string' && emotionValue.trim() !== ''
        ? {
            value: emotionValue.trim().slice(0, 12),
            confidence: clampConfidence(raw.emotion?.confidence),
        }
        : undefined;
    const scenes = normalizeTagList(raw.scenes, { limit: 3 });
    const intensityValue = typeof raw.intensity === 'object' && raw.intensity !== null
        ? raw.intensity?.value
        : raw.intensity;
    const intensityNumber = intensityValue === null || intensityValue === undefined
        ? null
        : Math.trunc(Number(intensityValue));
    const intensity = Number.isFinite(intensityNumber) && intensityNumber >= 1 && intensityNumber <= 5
        ? { value: intensityNumber, confidence: clampConfidence(raw.intensity?.confidence) }
        : undefined;
    const textOnImage = Array.isArray(raw.textOnImage)
        ? raw.textOnImage
            .map(item => {
                const text = typeof item === 'string' ? item : item?.text;
                if (typeof text !== 'string' || text.trim() === '')
                    return undefined;
                return {
                    text: text.trim().slice(0, 40),
                    confidence: clampConfidence(typeof item === 'object' ? item?.confidence : 0),
                };
            })
            .filter(item => item !== undefined)
            .slice(0, 5)
        : [];
    const taboo = normalizeTagList(raw.taboo, { limit: 3 });
    const hasAny = emotion !== undefined || scenes.length > 0 || intensity !== undefined
        || textOnImage.length > 0 || taboo.length > 0 || raw.ocrUnreadable === true;
    if (!hasAny)
        return undefined;
    return {
        ...(emotion ? { emotion } : {}),
        scenes,
        ...(intensity ? { intensity } : {}),
        textOnImage,
        taboo,
        ocrUnreadable: raw.ocrUnreadable === true,
    };
}

/** 版面：整图是几格。只做范围校验，不做几何检测。 */
function normalizeLayout(raw) {
    if (raw === null || typeof raw !== 'object')
        return undefined;
    const panels = Math.trunc(Number(raw.panels));
    if (!Number.isFinite(panels) || panels < 1 || panels > 6)
        return undefined;
    const rows = Math.trunc(Number(raw.rows));
    const cols = Math.trunc(Number(raw.cols));
    return {
        panels,
        rows: Number.isFinite(rows) && rows >= 1 && rows <= 3 ? rows : 1,
        cols: Number.isFinite(cols) && cols >= 1 && cols <= 3 ? cols : 1,
    };
}

/** 分格结果：每格自带 observed / inferred，索引与注入都复用同一套结构。 */
function normalizePanels(raw) {
    if (!Array.isArray(raw))
        return undefined;
    const panels = [];
    for (const item of raw) {
        if (item === null || typeof item !== 'object')
            continue;
        const index = Math.trunc(Number(item.index));
        const observed = normalizeObserved(item.observed);
        const inferred = normalizeInferred(item.inferred);
        const sticker = normalizeStickerTags(item.sticker);
        if (observed === undefined && inferred === undefined && sticker === undefined)
            continue;
        panels.push({
            index: Number.isFinite(index) && index >= 1 && index <= 6 ? index : panels.length + 1,
            ...(observed ? { observed } : {}),
            ...(inferred ? { inferred } : {}),
            ...(sticker ? { sticker } : {}),
        });
        if (panels.length >= 6)
            break;
    }
    return panels.length > 0 ? panels : undefined;
}

/** 从坏掉的 JSON 里只捞 desc；捞不到就返回空串，绝不把原始 JSON 当描述。 */
function salvageDesc(text) {
    const match = /"desc"\s*:\s*"((?:[^"\\]|\\.)*)"/u.exec(text);
    if (match === null)
        return '';
    try {
        return JSON.parse('"' + match[1] + '"').replace(/\s+/gu, ' ').trim().slice(0, 120);
    }
    catch {
        return '';
    }
}

/** 从模型输出里拆出描述与两栏 JSON。整段就是 JSON；坏掉时只捞 desc，不拿 JSON 片段冒充描述。 */
function splitCaption(raw) {
    const text = String(raw ?? '').replace(/【内心】/gu, '').replace(/```(?:json)?/gu, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    const plain = (start > 0 ? text.slice(0, start) : '').replace(/\s+/gu, ' ').trim().slice(0, 120);
    if (start < 0 || end <= start)
        return { text: plain, observed: undefined, inferred: undefined, parseError: plain === '' };
    let parsed;
    try {
        parsed = JSON.parse(text.slice(start, end + 1));
    }
    catch {
        const desc = salvageDesc(text.slice(start)) || plain;
        return { text: desc, observed: undefined, inferred: undefined, parseError: true };
    }
    const desc = typeof parsed?.desc === 'string' ? parsed.desc.trim().slice(0, 120) : '';
    return {
        text: desc !== '' ? desc : plain,
        observed: normalizeObserved(parsed?.observed),
        inferred: normalizeInferred(parsed?.inferred),
        layout: normalizeLayout(parsed?.layout),
        panels: normalizePanels(parsed?.panels),
        sticker: normalizeStickerTags(parsed?.sticker),
    };
}

async function captionImage(png, job = {}, references = []) {
    const dataUrl = 'data:image/png;base64,' + png.toString('base64');
    const referenceNote = references.length > 0
        ? '后面的 ' + references.length + ' 张依次是 ' + references.map(item => item.label).join('、')
            + ' 的参考样例；先看样例形态，再与画面里的标志逐一对照，只有结构吻合才写对应枚举，'
            + '只是像花、像星星但结构不符，就留空数组（markers: []），不要写“花饰”占位。'
        : '';
    const headers = { 'content-type': 'application/json' };
    if (LLM.apiKey !== '')
        headers.authorization = 'Bearer ' + LLM.apiKey;
    const hint = job.hint ?? {};
    const stickerMode = job.source === 'sticker';
    const scene = job.source === 'bili'
        ? '这是一支 B 站视频里的画面'
            + (hint.title ? '《' + hint.title + '》' : '')
            + (Number.isFinite(hint.at) ? '，大约第 ' + Math.round(hint.at) + ' 秒' : '')
            + '。'
        : job.source === 'qqvideo'
            ? '这是群聊里一支视频的画面'
                + (Number.isFinite(hint.at) ? '，大约第 ' + Math.round(hint.at) + ' 秒' : '')
                + '。'
            : stickerMode
                ? '这是群聊里的一张表情包图片。'
                : '这是群聊里的一张图片。';
    const stickerEmotions = Array.isArray(hint.stickerEmotions) && hint.stickerEmotions.length > 0
        ? hint.stickerEmotions
        : ['开心', '好笑', '无语', '震惊', '难过', '生气', '害羞', '期待', '赞同', '嫌弃', '疲惫', '困惑', '无奈', '得意', '敷衍'];
    const stickerScenes = Array.isArray(hint.stickerScenes) ? hint.stickerScenes : [];
    const stickerTaboo = Array.isArray(hint.stickerTaboo) ? hint.stickerTaboo : [];
    const stickerPrompt = stickerMode
        ? '另外这是表情包素材，必须再加一个 "sticker" 对象：'
            + '{"emotion":{"value":"' + stickerEmotions.join('|') + '|不确定","confidence":0.0},'
            + '"scenes":[{"value":"' + stickerScenes.join('|') + '","confidence":0.0}],'
            + '"intensity":{"value":1到5的整数或null,"confidence":0.0},'
            + '"textOnImage":[{"text":"图上文字","confidence":0.0}],'
            + '"taboo":[{"value":"' + stickerTaboo.join('|') + '","confidence":0.0}],'
            + '"ocrUnreadable":false}。'
            + '没有依据就 emotion 写 "不确定"、intensity 写 null、数组留空、置信度写 0；禁止用默认值或猜测补位。'
            + '图上文字逐条列出，不要合并，没有就空数组；认不出但确定有字时 ocrUnreadable 写 true。'
            + 'textOnImage 整图最多 3 条、每格最多 2 条，只写最有信息量的；不要罗列所有气泡、拟声词或水印。'
            + '多格图的每格 panels 里除现有字段外也加同样的 "sticker"；整图 sticker 只写各格一致的结论，不一致时 emotion 写 "不确定"。'
            + '多格时每格 observed 的每个数组最多 2 个值、inferred 最多 1 条，必须保证 JSON 能写完闭合。'
            + (stickerTaboo.length > 0 ? 'taboo 只能从给定值里选。' : '')
        : '';
    const payload = normalizePayload({
        model: VISION_MODEL,
        stream: false,
        temperature: 0,
        // 结构化打标要输出整图 + 每格两栏 + 每格 sticker；密集四格图实测 >6k。
        max_tokens: stickerMode ? 8000 : 1100,
        reasoning_effort: 'none',
        messages: [{
            role: 'user',
            content: [
                {
                    type: 'text',
                    text: '你是视觉观察员。' + scene
                        + '只输出一个 JSON 对象，不要输出 JSON 以外的任何文字，不要代码块围栏。字段固定为：'
                        + '{"desc":"一句中文描述，不超过40字：画面主体、在做什么、有文字就抄下来",'
                        + '"layout":{"panels":1,"rows":1,"cols":1},'
                        + '"observed":{"role":"角色形象一句话概括，没有就填空串",'
                        + '"hairColor":[],"hairStyle":[],"earType":[],"eyeColor":[],"palette":[],"proportion":[],"markers":[],'
                        + '"ocrText":"画面上的文字原样，没有就填空串"},'
                        + '"inferred":[{"claim":"推测，比如像是某角色的拟人形象","basis":["依据的 observed 特征，如 hairColor=蓝紫"],"confidence":0.0}],'
                        + '"panels":[]}。'
                        + '如果画面是多格拼图（2x2、上下、左右等），layout 写真实格数，panels 按从左到右、从上到下逐格输出，'
                        + '每格是 {"index":1,"observed":{…},"inferred":[…] }，整图 observed 写各格共同点；单格图 panels 留空数组。'
                        + 'observed 只写看得见的，错了就是错，必须诚实；数组字段只能从这些值里选（可多选，没有就空数组，不许造词）：'
                        + ENUM_HINT + '。'
                        + (MARKER_GUIDE !== ''
                            ? '画面里出现标志物时，按形态判据逐个核对，只有符合的才写进 markers；认不出品牌就留空数组，不要用“花饰”兜底；只有画面里确实存在装饰性花朵（花瓣、花心、花蕊、枝叶）时才写“花饰”；发饰、服装花纹、背景装饰里的花形或结形纹样不得升级成品牌标志，品牌标志只记独立出现的（屏幕、水印、贴纸、成品 logo）：' + MARKER_GUIDE + '。'
                            : '画面里如果出现品牌 logo，按已知形态把对应标志写进 markers；认不出就留空。')
                        + referenceNote
                        + 'logo 旁边的文字写进 ocrText。'
                        + '头上的角也算 earType（龙角/恶魔角/羊角），尖耳朵写精灵耳。'
                        + 'proportion 只写 "正常"（正常身高比例）或 "Q版"（二头身、大头娃娃），拿不准就留空数组；'
                        + '只按画面主体的角色判断，怀里/背景的Q版娃娃、挂件、表情包小人都不算，所以这里只写一个值。'
                        + '不要从画风推断模型型号、版本或 pro/flash 这类标签，图里没写就不写。'
                        + 'inferred 允许推测，可以空数组；每条必须写清依据和 0 到 1 的置信度，没把握就给低分。'
                        + '整图 inferred 最多 2 条，每格 inferred 最多 1 条；observed 的每个数组最多 3 个值，保证 JSON 完整。'
                        + stickerPrompt,
                },
                { type: 'image_url', image_url: { url: dataUrl } },
                // 参考样例跟在待识别图后面，标签与图片成对出现；没有 references 时内容与原先完全一致。
                ...references.flatMap(item => [
                    { type: 'text', text: '参考样例：' + item.label + '（只支持形态对照，不表示画面里出现了它）' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,' + item.png.toString('base64') } },
                ]),
            ],
        }],
    });
    // 表情包结构化输出比一句话描述长得多（四格图实测 >4k token），
    // 沿用 20s 的聊天观察超时会必然中断，这里单独放宽。
    const requestTimeoutMs = stickerMode
        ? Math.max(LLM.visionTimeoutMs, 180_000)
        : LLM.visionTimeoutMs;
    const callOnce = async (attempt) => {
        let response;
        try {
            response = await fetch(VISION_URL, {
                method: 'POST',
                headers,
                signal: AbortSignal.timeout(requestTimeoutMs),
                body: JSON.stringify(payload),
            });
        }
        catch (error) {
            console.error('[vision] request failed #' + attempt + ': ' + (error?.message ?? error));
            return undefined;
        }
        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            console.error('[vision] http ' + response.status + ' #' + attempt + ' ' + detail.slice(0, 300));
            return undefined;
        }
        const data = await response.json();
        const raw = data?.choices?.[0]?.message?.content;
        if (process.env.QQ_VISION_DEBUG === '1')
            console.log('[vision raw#' + attempt + '] ' + JSON.stringify(raw).slice(0, 1200));
        if (process.env.QQ_VISION_DEBUG_FILE)
            await writeFile(process.env.QQ_VISION_DEBUG_FILE
                + (attempt > 1 ? '.' + attempt : ''), String(raw ?? ''), 'utf8');
        return splitCaption(raw);
    };

    const first = await callOnce(1);
    if (first === undefined)
        return { text: '', observed: undefined, inferred: undefined };
    // 结构化打标要求 JSON 完整；解析失败时按同一 prompt 再试一次，仍失败就诚实返回。
    if (!stickerMode || first.sticker !== undefined || first.parseError !== true)
        return first;
    const second = await callOnce(2);
    return second?.sticker !== undefined ? second : first;
}

async function removeMedia(path) {
    try {
        const dir = dirname(path);
        const name = basename(path);
        const shrunk = /^(.+)-c\d+(\.[A-Za-z0-9]+)$/u.exec(name);
        const base = shrunk === null ? name.replace(/[^.]+$/u, '').replace(/\.$/u, '') : shrunk[1];
        const pattern = new RegExp('^' + escapeRegExp(base) + '\\.(png|jpg|jpeg|webp|gif|bmp)$', 'iu');
        for (const entry of await readdir(dir)) {
            if (entry === name || pattern.test(entry))
                await rm(join(dir, entry), { force: true });
        }
    }
    catch {
        // 文件已经不在或目录不可读，忽略
    }
}

async function runJob(job) {
    // 引擎未启用 vision 时直接跳过打标，既省一次必然失败的请求，也避免
    // 图片继续堆在临时目录里。
    if (!LLM.supportsVision) {
        if (job.deleteAfter === true)
            await removeMedia(job.path);
        return;
    }
    let bytes;
    try {
        bytes = await readFile(job.path);
    }
    catch {
        return;
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
        if (job.deleteAfter === true)
            await removeMedia(job.path);
        return;
    }
    try {
        const png = await preparePng(bytes);
        if (png !== undefined) {
            // 参考图只在显式传了 references 时读取；读失败就跳过该样例，不影响主图打标。
            const references = [];
            for (const item of job.references ?? []) {
                try {
                    const refPng = await preparePng(await readFile(item.path));
                    if (refPng !== undefined)
                        references.push({ label: String(item.label ?? ''), png: refPng });
                }
                catch {
                    // 样例缺失就退回纯文字判据
                }
            }
            const caption = await captionImage(png, job, references);
            if (caption.text !== '') {
                const doc = await readState();
                const entries = prune(doc.entries, Date.now());
                const record = {
                    at: Date.now(),
                    chatId: job.chatId,
                    text: caption.text,
                    source: job.source ?? 'chat',
                    ...(caption.observed ? { observed: caption.observed } : {}),
                    ...(caption.inferred ? { inferred: caption.inferred } : {}),
                    ...(caption.layout ? { layout: caption.layout } : {}),
                    ...(caption.panels ? { panels: caption.panels } : {}),
                    ...(caption.sticker ? { sticker: caption.sticker } : {}),
                    ...(job.path ? { frame: job.path } : {}),
                    ...(job.source === 'bili' && job.hint?.title ? { video: job.hint.title } : {}),
                };
                entries.push(await annotateEntry(record));
                await writeState(entries);
            }
        }
    }
    catch {
        // 打标失败不重试；文件交给插件自身的 6 小时清理
    }
    if (job.deleteAfter === true)
        await removeMedia(job.path);
}
