/**
 * 表情包库：入库、哈希去重、确定性标签、jsonl 索引、召回、健康自检、自维护。
 *
 * 边界：
 * - 只有 sticker / custom-face / 显式 manual 导入会进入本库；普通聊天图片不进。
 * - 所有删除都是软删（flags.deleted），保留期内可 restore。
 * - 维护任务只做确定性动作，不调用模型。
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
    appendFile, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile,
} from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

export const LIB_ROOT = process.env.QQ_STICKER_ROOT
    ?? 'C:\\Users\\user\\.dsh\\media\\onebot\\stickers';
export const BLOB_DIR = join(LIB_ROOT, 'blobs');
export const INDEX_PATH = join(LIB_ROOT, 'index.jsonl');
export const META_PATH = join(LIB_ROOT, 'meta.json');
export const AUDIT_PATH = join(LIB_ROOT, 'audit.jsonl');
export const TOMBSTONE_PATH = join(LIB_ROOT, 'tombstones.jsonl');
export const PURGED_PATH = join(LIB_ROOT, 'purged.jsonl');
export const DENY_PATH = join(LIB_ROOT, 'sticker-deny.jsonl');
export const MAINT_LOG_PATH = join(LIB_ROOT, 'maintenance.jsonl');
export const BACKUP_ROOT = process.env.QQ_STICKER_BACKUP
    ?? 'E:\\Bonsai\\astrbot-eval\\inst\\data\\xzy\\persona\\sticker-backup';
export const WORK_DIR = process.env.QQ_STICKER_WORK
    ?? 'E:\\Bonsai\\astrbot-eval\\inst\\data\\xzy\\persona\\sticker-work';
export const HARVEST_DIR = join(WORK_DIR, 'downloads');
export const HARVEST_MANIFEST = join(WORK_DIR, 'harvest.json');
export const PATCH_MANIFEST_PATH = join(WORK_DIR, 'plugin-patch', 'patch-manifest.json');

const SHARP_PATH = process.env.QQ_VISION_SHARP
    ?? 'C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\sharp\\dist\\index.mjs';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 20_000_000;
const SCHEMA_VERSION = 1;
const NEAR_DUP_DISTANCE = 6;
const BACKUP_KEEP = 14;
const DEFAULT_POLICY = Object.freeze({
    staleDays: 120,
    retentionDays: 30,
    lowSelectionMinRecalls: 20,
    lowSelectionRate: 0.05,
    lowSelectionDays: 60,
    tagCapPerHour: 30,
});
export const EMOTION_ORDER = [
    '开心', '好笑', '无语', '震惊', '难过', '生气', '害羞', '期待', '赞同',
    '嫌弃', '疲惫', '困惑', '无奈', '得意', '敷衍', '其他',
];
export const SCENE_ORDER = [
    '打招呼', '道谢', '道别', '安慰', '庆祝', '吐槽', '反驳', '装傻', '求饶',
    '催促', '接梗', '自嘲', '回应夸奖', '敷衍',
];
export const TABOO_OPTIONS = Object.freeze(['安慰', '正式场合', '陌生人']);
/** 判不出来时的显式结果：不是兜底标签，选图时必须跳过。 */
export const UNKNOWN_EMOTION = '不确定';
/** 打标词表（传给 vision 的 prompt 用，与库内校验共用一套）。 */
export const STICKER_EMOTIONS = Object.freeze(EMOTION_ORDER.filter(value => value !== '其他'));

const POP4 = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

let sharpPromise;
function loadSharp() {
    sharpPromise ??= import('file:///' + SHARP_PATH.replace(/\\/gu, '/').replace(/^\/+/u, ''))
        .then(module => module.default ?? module);
    return sharpPromise;
}

function nowIso() {
    return new Date().toISOString();
}

function localDateStamp(date = new Date()) {
    const pad = value => String(value).padStart(2, '0');
    return String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate());
}

function toBytesText(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MiB';
}

function uniqueBy(list, keyOf) {
    const seen = new Set();
    const out = [];
    for (const item of list) {
        const key = keyOf(item);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

function safeJson(line) {
    try {
        return JSON.parse(line);
    }
    catch {
        return undefined;
    }
}

async function readJson(path, fallback) {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    }
    catch {
        return fallback;
    }
}

/**
 * 原子写：临时文件名带 pid + 序号，避免插件进程与本进程同时写同一个 .tmp
 * 触发 Windows EPERM；被锁时短暂重试。
 */
async function writeAtomic(path, text) {
    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const temp = path + '.' + process.pid + '.' + attempt + '.tmp';
        try {
            await writeFile(temp, text, 'utf8');
            await rename(temp, path);
            return;
        }
        catch (error) {
            lastError = error;
            await rm(temp, { force: true }).catch(() => undefined);
            await new Promise(resolve => setTimeout(resolve, 60 * (attempt + 1)));
        }
    }
    throw lastError;
}

async function readLines(path) {
    try {
        const text = await readFile(path, 'utf8');
        return text.split(/\r?\n/u).filter(line => line.trim() !== '');
    }
    catch {
        return [];
    }
}

export async function ensureLayout() {
    await mkdir(BLOB_DIR, { recursive: true });
    await mkdir(WORK_DIR, { recursive: true });
    await mkdir(BACKUP_ROOT, { recursive: true });
    try {
        await stat(META_PATH);
    }
    catch {
        await writeAtomic(META_PATH, JSON.stringify({
            schemaVersion: SCHEMA_VERSION,
            createdAt: nowIso(),
            updatedAt: nowIso(),
            policy: { ...DEFAULT_POLICY },
            tagBudget: { windowStart: nowIso(), count: 0 },
        }, null, 2) + '\n');
    }
}

async function readMeta() {
    const meta = await readJson(META_PATH, undefined);
    return {
        schemaVersion: SCHEMA_VERSION,
        policy: { ...DEFAULT_POLICY, ...(meta?.policy ?? {}) },
        tagBudget: meta?.tagBudget ?? { windowStart: nowIso(), count: 0 },
        ...meta,
    };
}

async function writeMeta(meta) {
    meta.updatedAt = nowIso();
    await writeAtomic(META_PATH, JSON.stringify(meta, null, 2) + '\n');
}

export async function audit(event) {
    await ensureLayout();
    await appendFile(AUDIT_PATH, JSON.stringify({ ts: nowIso(), ...event }) + '\n', 'utf8');
}

/** 读取活跃记录。jsonl 后写覆盖先写；软删记录不在活跃集里。 */
export async function loadRecords() {
    const map = new Map();
    for (const line of await readLines(INDEX_PATH)) {
        const record = safeJson(line);
        if (record === undefined || typeof record?.id !== 'string') continue;
        map.set(record.id, record);
    }
    return [...map.values()].filter(record => record.flags?.deleted !== true);
}

async function loadAllIndexed() {
    const map = new Map();
    for (const line of await readLines(INDEX_PATH)) {
        const record = safeJson(line);
        if (record !== undefined && typeof record.id === 'string') map.set(record.id, record);
    }
    return [...map.values()];
}

async function writeIndex(records) {
    await ensureLayout();
    const text = records.map(record => JSON.stringify(record)).join('\n');
    await writeAtomic(INDEX_PATH, text === '' ? '' : text + '\n');
}

/**
 * 索引写锁：插件进程入库、tag 子进程回写、维护任务可能同时改 index.jsonl，
 * 读改写必须串行，否则后写的会覆盖先写的记录。
 */
const INDEX_LOCK_PATH = INDEX_PATH + '.lock';
let lockChain = Promise.resolve();

async function acquireIndexLock(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            await writeFile(INDEX_LOCK_PATH, String(process.pid), { flag: 'wx' });
            return;
        }
        catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            try {
                const info = await stat(INDEX_LOCK_PATH);
                if (Date.now() - info.mtimeMs > 15_000)
                    await rm(INDEX_LOCK_PATH, { force: true });
            }
            catch {
                // 锁文件刚好被释放，重试即可
            }
            if (Date.now() > deadline)
                throw new Error('索引写锁等待超时: ' + INDEX_LOCK_PATH);
            await new Promise(resolve => setTimeout(resolve, 40));
        }
    }
}

function withIndexLock(run) {
    const task = lockChain.then(async () => {
        await acquireIndexLock();
        try {
            return await run();
        }
        finally {
            await rm(INDEX_LOCK_PATH, { force: true }).catch(() => undefined);
        }
    });
    lockChain = task.then(() => undefined, () => undefined);
    return task;
}

export async function loadTombstones() {
    const map = new Map();
    for (const line of await readLines(TOMBSTONE_PATH)) {
        const record = safeJson(line);
        if (record !== undefined && typeof record.id === 'string') map.set(record.id, record);
    }
    return [...map.values()];
}

async function writeTombstones(records) {
    const text = records.map(record => JSON.stringify(record)).join('\n');
    await writeAtomic(TOMBSTONE_PATH, text === '' ? '' : text + '\n');
}

async function sha256File(path) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
}

/** 64 位 pHash：32×32 灰度做 DCT，取左上 8×8 低频系数与中位数比较。 */
async function phashFile(path) {
    const sharp = await loadSharp();
    const { data, info } = await sharp(path, { animated: false, pages: 1 })
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .greyscale()
        .resize(32, 32, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true });
    const channels = Math.max(1, info.channels ?? 1);
    const gray = new Float64Array(32 * 32);
    for (let i = 0; i < gray.length; i += 1) gray[i] = data[i * channels];

    const coeff = new Float64Array(64);
    for (let u = 0; u < 8; u += 1) {
        for (let v = 0; v < 8; v += 1) {
            let sum = 0;
            for (let y = 0; y < 32; y += 1) {
                for (let x = 0; x < 32; x += 1) {
                    sum += gray[y * 32 + x]
                        * Math.cos(((2 * x + 1) * u * Math.PI) / 64)
                        * Math.cos(((2 * y + 1) * v * Math.PI) / 64);
                }
            }
            coeff[u * 8 + v] = sum
                * (u === 0 ? 1 / Math.SQRT2 : 1)
                * (v === 0 ? 1 / Math.SQRT2 : 1);
        }
    }
    const median = [...coeff].slice(1).sort((a, b) => a - b)[31];
    let hex = '';
    for (let i = 0; i < 64; i += 4) {
        let nibble = 0;
        for (let j = 0; j < 4; j += 1)
            nibble = (nibble << 1) | (coeff[i + j] > median ? 1 : 0);
        hex += nibble.toString(16);
    }
    return hex;
}

export function hammingHex(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0
        || a.length !== b.length || a.length % 2 !== 0)
        return 999;
    let distance = 0;
    for (let i = 0; i < a.length; i += 1)
        distance += POP4[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
    return distance;
}

async function probeImage(path) {
    const sharp = await loadSharp();
    const meta = await sharp(path, { animated: true, pages: 1 }).metadata();
    const width = Number(meta.width) || 0;
    const height = Number(meta.height) || 0;
    if (width * height > MAX_IMAGE_PIXELS)
        throw new Error('图片像素过大: ' + width + 'x' + height);
    return {
        width,
        height,
        format: String(meta.format ?? ''),
        pages: Number(meta.pages ?? 1),
        animated: Number(meta.pages ?? 1) > 1,
    };
}

function normalizeText(value) {
    return String(value ?? '').toLowerCase().replace(/\s+/gu, ' ').trim();
}

function hasHit(text, raw) {
    const word = String(raw).toLowerCase();
    if (word === '') return false;
    if (/^[a-z0-9_]+$/u.test(word)) {
        const escaped = word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        return new RegExp('\\b' + escaped + '\\b', 'u').test(text);
    }
    return text.includes(word);
}

function countHits(text, words) {
    return words.reduce((score, word) => score + (hasHit(text, word) ? 1 : 0), 0);
}

const FILENAME_EMOTION = {
    happy: '开心', smile: '开心', laugh: '好笑', funny: '好笑',
    speechless: '无语', speechless_face: '无语', whatever: '无语',
    like: '赞同', thumbsup: '赞同', ok: '赞同',
    think: '困惑', thinking: '困惑', confused: '困惑',
    sad: '难过', cry: '难过', angry: '生气', mad: '生气',
    shy: '害羞', blush: '害羞', tired: '疲惫', sleepy: '疲惫',
};

const EMOTION_RULES = [
    ['开心', ['开心', '高兴', '愉快', '欢乐', '笑', '哈哈', '乐', '兴奋', '可爱', '憨', '绷不住', '笑死', '滑稽']],
    ['好笑', ['好笑', '搞笑', '爆笑', '笑死', '绷不住', '幽默', '逗', '乐子']],
    ['无语', ['无语', '沉默', '无奈', '翻白眼', '扶额', '汗', '离谱', '服了', '醉了', '难绷', '什么鬼', '摊手']],
    ['震惊', ['震惊', '吃惊', '惊讶', '瞪', '目瞪口呆', '震', '惊']],
    ['难过', ['难过', '伤心', '哭', '泪', '委屈', '沮丧', '失落', '悲伤']],
    ['生气', ['生气', '愤怒', '怒', '火', '气死', '拍桌', '凶']],
    ['害羞', ['害羞', '脸红', '捂脸', '不好意思', '羞涩', '娇羞']],
    ['期待', ['期待', '星星眼', '渴望', '搓手', '盼望', '等不及']],
    ['赞同', ['赞同', '点赞', '大拇指', '竖拇指', '牛', '棒', '优秀', '强', '无敌', '可以', '好耶', '支持', 'ok']],
    ['嫌弃', ['嫌弃', '恶心', '皱眉', '厌恶', '鄙视', '嫌']],
    ['疲惫', ['疲惫', '累', '困', '瘫', '摆烂', '虚脱', '没力气']],
    ['困惑', ['困惑', '疑惑', '问号', '懵', '不解', '思考', '想']],
    ['无奈', ['无奈', '没办法', '叹气', '摊手', '算了', '随便']],
    ['得意', ['得意', '叉腰', '骄傲', '哼哼', '炫耀', '神气']],
    ['敷衍', ['敷衍', '哦', '嗯', '随便', '行吧', '懒得']],
];

const SCENE_RULES = [
    ['打招呼', ['你好', '嗨', '挥手', '早安', '晚安', 'hello', 'hi']],
    ['道谢', ['谢谢', '感谢', '多谢', '鞠躬']],
    ['道别', ['再见', '拜拜', '溜了', '走了', '晚安']],
    ['安慰', ['抱抱', '摸摸', '别哭', '安慰', '乖', '不哭', '拍拍']],
    ['庆祝', ['庆祝', '撒花', '烟花', '干杯', '恭喜', '生日']],
    ['吐槽', ['吐槽', '无语', '翻白眼', '离谱', '服了', '醉了', '什么鬼', '难绷']],
    ['反驳', ['反驳', '才不是', '不对', '拒绝']],
    ['装傻', ['装傻', '无辜', '摊手', '茫然', '装死']],
    ['求饶', ['求饶', '饶命', '放过', '拜托', '求求']],
    ['催促', ['催', '快点', '搞快点', '赶紧', '急']],
    ['接梗', ['梗', '接梗', '钓鱼', '哈哈', '笑死']],
    ['自嘲', ['自嘲', '我菜', '废物', '小丑', '丢人', '笨']],
    ['回应夸奖', ['夸奖', '厉害', '无敌', '牛', '棒', '优秀', '强']],
    ['敷衍', ['敷衍', '哦', '嗯', '随便', '行吧', '懒得']],
];

const STRONG_WORDS = ['爆笑', '笑死', '崩溃', '极度', '非常', '超级', '无敌', '爆炸', '大哭', '大怒'];
const MILD_WORDS = ['微笑', '轻轻', '稍微', '有点', '微微'];
const TABOO_RULES = [
    { words: ['嘲讽', '阴阳', '骂', '攻击', '滚', '死', '蠢', '垃圾'], taboo: ['安慰', '正式场合', '陌生人'] },
    { words: ['嫌弃', '恶心', '鄙视'], taboo: ['安慰'] },
    { words: ['敷衍', '随便', '懒得'], taboo: ['正式场合', '安慰'] },
];

function extractTextItems(caption) {
    const quoted = [...String(caption ?? '').matchAll(/[「『“"]([^」』”"]{1,40})[」』”"]/gu)]
        .map(match => match[1].trim())
        .filter(Boolean);
    if (quoted.length > 0) return [...new Set(quoted)].slice(0, 5);
    const written = /写着[：: ]?([^\s，。；]{1,20})/u.exec(caption ?? '');
    return written === null ? [] : [written[1]];
}

/** 词表校验：模型给的值必须落在词表里，否则一律“不确定”，不猜。 */
function pickTagValue(raw, allowed) {
    const value = typeof raw === 'object' && raw !== null ? raw?.value : raw;
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return allowed.includes(trimmed) ? trimmed : undefined;
}

function clampUnit(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(1, Math.max(0, Number(number.toFixed(2)))) : 0;
}

/**
 * 把 vision 的结构化 sticker 结果转成落库字段。
 * 规则：词表命中才落原值；没给/给错/判不出 → emotion“不确定”、intensity null、数组空。
 */
export function normalizeStickerResult(sticker) {
    if (sticker === null || typeof sticker !== 'object')
        return undefined;
    const rawEmotion = typeof sticker.emotion === 'object' && sticker.emotion !== null
        ? sticker.emotion
        : { value: sticker.emotion, confidence: 0 };
    let emotion = pickTagValue(rawEmotion, STICKER_EMOTIONS);
    let emotionConfidence = emotion === undefined ? 0 : clampUnit(rawEmotion?.confidence);
    if (emotion === undefined && String(rawEmotion?.value ?? '').trim() === UNKNOWN_EMOTION) {
        emotion = UNKNOWN_EMOTION;
        emotionConfidence = clampUnit(rawEmotion?.confidence);
    }
    emotion ??= UNKNOWN_EMOTION;

    const scenes = [];
    const sceneConfidences = [];
    for (const item of Array.isArray(sticker.scenes) ? sticker.scenes : []) {
        const scene = pickTagValue(item, SCENE_ORDER);
        if (scene === undefined || scenes.includes(scene)) continue;
        scenes.push(scene);
        sceneConfidences.push(clampUnit(item?.confidence));
        if (scenes.length >= 3) break;
    }

    const rawIntensity = sticker.intensity;
    const intensityValue = typeof rawIntensity === 'object' && rawIntensity !== null
        ? rawIntensity?.value
        : rawIntensity;
    const intensityNumber = intensityValue === null || intensityValue === undefined
        ? NaN
        : Math.trunc(Number(intensityValue));
    const intensity = Number.isFinite(intensityNumber) && intensityNumber >= 1 && intensityNumber <= 5
        ? intensityNumber
        : null;
    const intensityConfidence = intensity === null ? 0 : clampUnit(rawIntensity?.confidence);

    const textOnImageItems = [];
    for (const item of Array.isArray(sticker.textOnImage) ? sticker.textOnImage : []) {
        const text = typeof item === 'string' ? item : item?.text;
        if (typeof text !== 'string' || text.trim() === '') continue;
        const value = text.trim().slice(0, 40);
        if (textOnImageItems.some(exist => exist.text === value)) continue;
        textOnImageItems.push({ text: value, confidence: clampUnit(item?.confidence) });
        if (textOnImageItems.length >= 5) break;
    }

    const taboo = [];
    const tabooConfidences = [];
    for (const item of Array.isArray(sticker.taboo) ? sticker.taboo : []) {
        const value = pickTagValue(item, TABOO_OPTIONS);
        if (value === undefined || taboo.includes(value)) continue;
        taboo.push(value);
        tabooConfidences.push(clampUnit(item?.confidence));
        if (taboo.length >= 3) break;
    }

    return {
        emotion,
        emotionConfidence,
        scenes,
        sceneConfidences,
        intensity,
        intensityConfidence,
        textOnImage: textOnImageItems.map(item => item.text).join('/'),
        textOnImageItems,
        taboo,
        tabooConfidences,
        // 只有模型明确说“有字但读不出”才算缺 OCR；没字是结论，不是缺失。
        ocrMissing: sticker.ocrUnreadable === true && textOnImageItems.length === 0,
        tagSource: 'vision-structured',
        tagRuleVersion: 'vision-v2',
    };
}

/**
 * 确定性标签：同一段文本永远得到同一组标签。
 * 文件名只在命中已知词根时加权，入站哈希文件名不会误伤。
 */
export function deriveTags({ caption = '', filename = '', desc = '' } = {}) {
    const filenameStem = String(filename).toLowerCase().replace(/\.[^.]+$/u, '');
    const text = normalizeText([desc, caption, filenameStem].join(' '));
    const captionText = normalizeText(caption);

    const emotionScores = new Map();
    for (const [emotion, words] of EMOTION_RULES) {
        const score = countHits(text, words);
        if (score > 0) emotionScores.set(emotion, score * 2);
    }
    for (const [stem, emotion] of Object.entries(FILENAME_EMOTION)) {
        if (filenameStem === stem || filenameStem.includes(stem))
            emotionScores.set(emotion, (emotionScores.get(emotion) ?? 0) + 6);
    }
    // 命中词表才算识别出情绪；一个都没命中就是“不确定”，不拿“其他”冒充结果。
    let emotion = UNKNOWN_EMOTION;
    let best = 0;
    for (const candidate of EMOTION_ORDER) {
        const score = emotionScores.get(candidate) ?? 0;
        if (score > best) {
            best = score;
            emotion = candidate;
        }
    }
    // 置信度跟着证据量走：命中越多越可信，封顶 0.8（文本规则永远不声称确定）。
    const emotionConfidence = best > 0 ? Math.min(0.8, 0.3 + best * 0.05) : 0;

    const sceneScores = new Map();
    for (const [scene, words] of SCENE_RULES) {
        const score = countHits(text, words);
        if (score > 0) sceneScores.set(scene, score * 2);
    }
    const scenes = [...sceneScores.entries()]
        .filter(([, score]) => score >= 2)
        .sort((a, b) => (b[1] - a[1]) || SCENE_ORDER.indexOf(a[0]) - SCENE_ORDER.indexOf(b[0]))
        .slice(0, 2)
        .map(([scene]) => scene);
    // 场景没命中就留空；旧版按情绪补“接梗”，那是编造，已去掉。
    const sceneConfidences = scenes.map(scene =>
        Math.min(0.8, 0.3 + (sceneScores.get(scene) ?? 0) * 0.05));

    let intensity = null;
    let intensityConfidence = 0;
    if (countHits(captionText, STRONG_WORDS) > 0) {
        intensity = 4;
        intensityConfidence = 0.4;
    }
    if (countHits(captionText, MILD_WORDS) > 0) {
        intensity = 2;
        intensityConfidence = 0.4;
    }
    if (intensity !== null && (emotion === '生气' || emotion === '震惊')) {
        intensity = Math.min(5, intensity + 1);
        intensityConfidence = Math.min(0.8, intensityConfidence + 0.1);
    }

    const taboo = [];
    const tabooConfidences = [];
    for (const rule of TABOO_RULES) {
        if (countHits(text, rule.words) === 0) continue;
        for (const value of rule.taboo) {
            if (taboo.includes(value)) continue;
            taboo.push(value);
            tabooConfidences.push(0.4);
        }
    }

    const textItems = extractTextItems(caption);
    const textOnImage = textItems.join('/');
    const textOnImageItems = textItems.map(text => ({ text, confidence: 0.5 }));
    // 只有“明确说有字但读不出”才算 OCR 缺失；“画面无文字”是结论，不是缺失。
    const ocrMissing = textItems.length === 0
        && /(?:文字|字迹|字样)(?:模糊|不清|无法辨认|难以辨认|看不清)|看不清(?:文字|字迹|写的)|无法辨认/u.test(String(caption ?? ''));
    const winnerWords = (EMOTION_RULES.find(([name]) => name === emotion)?.[1] ?? [])
        .filter(word => hasHit(text, word));
    const sceneWords = scenes.flatMap(scene => (SCENE_RULES.find(([name]) => name === scene)?.[1] ?? []))
        .filter(word => hasHit(text, word));
    const matchedWords = [...new Set([...winnerWords, ...sceneWords])].slice(0, 8);

    const descriptionParts = [];
    if (String(desc ?? '').trim() !== '') descriptionParts.push(String(desc).trim());
    if (String(caption ?? '').trim() !== '') descriptionParts.push(String(caption).trim());
    if (textOnImage !== '') descriptionParts.push('图上文字「' + textOnImage + '」');
    const description = descriptionParts.length > 0
        ? descriptionParts.join(' ')
        : (filenameStem !== '' ? filenameStem : '无描述');

    return {
        emotion,
        emotionConfidence,
        scenes,
        sceneConfidences,
        intensity,
        intensityConfidence,
        taboo,
        tabooConfidences,
        textOnImage,
        textOnImageItems,
        ocrMissing,
        description,
        matchedWords,
        tagSource: caption !== '' ? 'caption' : (desc !== '' ? 'desc' : 'filename'),
        tagRuleVersion: 'lex-v2',
    };
}

function tokenize(value) {
    const text = normalizeText(value);
    const tokens = new Set();
    for (const word of text.match(/[a-z0-9_]{2,}/gu) ?? [])
        tokens.add(word);
    for (const run of text.match(/[\u4e00-\u9fff]+/gu) ?? []) {
        if (run.length === 1) {
            tokens.add(run);
            continue;
        }
        for (let i = 0; i < run.length - 1; i += 1)
            tokens.add(run.slice(i, i + 2));
    }
    for (const stop of ['的', '了', '是', '我', '你', '他', '她', '它', '在', '有', '就', '不', '也', '都', '和', '与', '这', '那', '一个', '一下', '什么', '怎么', '还是', '就是', '然后', '现在', '可以', '没有', '不是', '这个', '那个'])
        tokens.delete(stop);
    return tokens;
}

/**
 * 内置黑名单兜底：blocklist.json 缺失时仍然拦“思考/犹豫”类。
 * 只做黑名单，不参与选图；选图仍然只有 recall 一套。
 */
const BUILTIN_BLOCKLIST = Object.freeze({
    ids: ['思考', 'think', 'think.png'],
    keywords: ['思考', '想想', '让我想想', '犹豫', '想一下', 'thinking', 'think', 'ponder'],
});

async function readBlocklist() {
    const parsed = await readJson(join(LIB_ROOT, 'blocklist.json'), {});
    return {
        ids: [...new Set([...BUILTIN_BLOCKLIST.ids, ...(Array.isArray(parsed?.ids) ? parsed.ids : [])]
            .map(item => String(item).toLowerCase()))],
        keywords: [...new Set([...BUILTIN_BLOCKLIST.keywords, ...(Array.isArray(parsed?.keywords) ? parsed.keywords : [])]
            .map(item => String(item).toLowerCase()))],
    };
}

/** 给入站链路用：任何文本是否命中 blocklist；命中返回关键词。 */
export async function blocklistMatch(text) {
    return blockedBy(text, await readBlocklist());
}

function blockedBy(text, blocklist) {
    const value = String(text ?? '').toLowerCase();
    if (value === '') return undefined;
    for (const id of blocklist.ids) {
        if (value.includes(id)) return id;
    }
    for (const keyword of blocklist.keywords) {
        if (value.includes(keyword)) return keyword;
    }
    return undefined;
}

/**
 * 黑名单只吃情绪/描述/文件名，不吃图上文字。
 * 引号里的内容多半是 OCR 抄下来的界面文案（如“已思考（用时4秒）”），先剔掉再匹配。
 */
function withoutQuotedText(text) {
    return String(text ?? '')
        .replace(/[「『“"]([^」』”"]*)[」』”"]/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

/** 拒收名单：按内容哈希拦截，命中后从任何入口都不入库。 */
const DENY_PHASH_DISTANCE = 2;

export async function loadDenyList() {
    return (await readLines(DENY_PATH)).map(safeJson).filter(Boolean);
}

/** 计算一个文件的入库哈希（sha256 + pHash），入库与拒收名单共用。 */
export async function hashFile(path) {
    const sha256 = await sha256File(path);
    try {
        return { sha256, phash: await phashFile(path) };
    }
    catch {
        return { sha256 };
    }
}

/** 命中拒收名单返回条目（含匹配方式）；未命中返回 undefined。 */
export async function matchDeny({ sha256 = '', phash = '' } = {}) {
    const entries = await loadDenyList();
    for (const entry of entries) {
        if (sha256 !== '' && entry.sha256 === sha256)
            return { ...entry, match: 'sha256', distance: 0 };
        if (phash !== '' && typeof entry.phash === 'string' && entry.phash !== '') {
            const distance = hammingHex(entry.phash, phash);
            if (distance <= DENY_PHASH_DISTANCE)
                return { ...entry, match: 'phash', distance };
        }
    }
    return undefined;
}

export async function addDeny({ sha256, phash, name = '', reason = '', by = 'manual', note = '' }) {
    await ensureLayout();
    if (typeof sha256 !== 'string' || sha256.length !== 64)
        throw new Error('addDeny: sha256 不合法');
    const entries = await loadDenyList();
    if (entries.some(entry => entry.sha256 === sha256))
        return { ok: true, duplicate: true };
    const entry = {
        sha256, ...(typeof phash === 'string' && phash !== '' ? { phash } : {}),
        name, reason, by, note, addedAt: nowIso(),
    };
    await appendFile(DENY_PATH, JSON.stringify(entry) + '\n', 'utf8');
    await audit({ event: 'deny-add', ...entry });
    return { ok: true, entry };
}

/** 物理清除记录：index、blob、墓碑、pick-state 历史一起清，不可恢复。 */
export async function purgeRecords(ids = [], { reason = 'manual' } = {}) {
    const targets = new Set(ids);
    if (targets.size === 0) return { purged: [], pickStateChatsCleaned: 0 };
    return withIndexLock(async () => {
        const all = await loadAllIndexed();
        const keep = [];
        const purged = [];
        for (const record of all) {
            if (!targets.has(record.id)) {
                keep.push(record);
                continue;
            }
            try {
                await rm(record.blobPath, { force: true });
            }
            catch {
                // blob 已不在也继续清索引
            }
            await appendFile(PURGED_PATH, JSON.stringify({
                ...record, purgedAt: nowIso(), purgeReason: reason,
            }) + '\n', 'utf8');
            purged.push(record.id);
        }
        if (purged.length === 0) return { purged: [], pickStateChatsCleaned: 0 };
        await writeIndex(keep);
        await writeTombstones((await loadTombstones()).filter(item => !targets.has(item.id)));

        const state = await loadPickState();
        let cleaned = 0;
        for (const [chatId, value] of Object.entries(state.chats ?? {})) {
            const history = (Array.isArray(value?.history) ? value.history : []);
            const alive = history.filter(item => !targets.has(String(item?.id ?? '')));
            if (alive.length === history.length) continue;
            cleaned += 1;
            if (alive.length === 0) delete state.chats[chatId];
            else state.chats[chatId] = { ...value, history: alive };
        }
        if (cleaned > 0) await savePickState(state);
        await audit({ event: 'sticker-purge', ids: purged, reason, pickStateChatsCleaned: cleaned });
        return { purged, pickStateChatsCleaned: cleaned };
    });
}

/**
 * 按当前黑名单规则重算 flags.blocked（不调用模型）。
 * 规则收窄（例如不再看 OCR 文案）后用它把误判的记录放出来。
 */
export async function recheckBlocks() {
    return withIndexLock(async () => {
        const records = await loadRecords();
        const blocklist = await readBlocklist();
        const changed = [];
        for (const record of records) {
            const text = withoutQuotedText([
                record.emotion, ...(record.scenes ?? []), record.description,
                record.descHint, basename(record.blobPath ?? ''),
            ].filter(Boolean).join(' '));
            const reason = blockedBy(text, blocklist);
            const wasBlocked = record.flags?.blocked === true;
            const nowBlocked = reason !== undefined;
            if (wasBlocked === nowBlocked && (record.blockReason ?? null) === (reason ?? null))
                continue;
            record.flags = { ...(record.flags ?? {}), blocked: nowBlocked };
            record.blockReason = reason;
            record.updatedAt = nowIso();
            changed.push({ id: record.id, wasBlocked, blocked: nowBlocked, reason: reason ?? null });
        }
        if (changed.length > 0) await writeIndex(records);
        await audit({ event: 'blocklist-recheck', changed });
        return changed;
    });
}

/**
 * 按 id 批量修正来源字段（归属复核用），只改 sources，不动打标。
 * patches 形如 { [id]: { chatId, groupId, provenance, chatCorrected } }。
 */
export async function patchSources(patches = {}) {
    return withIndexLock(async () => {
        const records = await loadRecords();
        const changed = [];
        for (const record of records) {
            const patch = patches[record.id];
            if (patch === undefined) continue;
            record.sources = (record.sources ?? []).map((source, index) =>
                (index === 0 ? { ...source, ...patch } : source));
            record.updatedAt = nowIso();
            changed.push(record.id);
        }
        if (changed.length > 0) await writeIndex(records);
        await audit({ event: 'source-patched', ids: changed });
        return changed;
    });
}

function isProtected(record) {
    if (record.flags?.pinned === true) return true;
    const sources = Array.isArray(record.sources) ? record.sources : [];
    return sources.some(source => source.kind === 'manual'
        || (source.kind === 'local-import' && source.protected === true));
}

function isManualImport(record) {
    return (record.sources ?? []).some(source => source.kind === 'manual'
        || (source.kind === 'local-import' && source.protected === true));
}

/** 入库一个文件。返回 added / exact-duplicate / near-duplicate / rejected。 */
export async function ingestFile(options = {}) {
    return withIndexLock(() => ingestFileInner(options));
}

async function ingestFileInner({
    sourcePath, source = {}, dryRun = false, protect = false, descHint = '',
} = {}) {
    await ensureLayout();
    if (typeof sourcePath !== 'string' || sourcePath === '')
        throw new Error('ingestFile: sourcePath 必填');
    const info = await stat(sourcePath);
    if (!info.isFile())
        throw new Error('不是文件: ' + sourcePath);
    if (info.size > MAX_FILE_BYTES)
        return { status: 'rejected', reason: 'too-large', bytes: info.size, path: sourcePath };
    if (info.size === 0)
        return { status: 'rejected', reason: 'empty', bytes: 0, path: sourcePath };

    const sha256 = await sha256File(sourcePath);
    const records = await loadRecords();
    const exact = records.find(record => record.sha256 === sha256);

    let probe;
    let phash;
    try {
        probe = await probeImage(sourcePath);
        phash = await phashFile(sourcePath);
    }
    catch (error) {
        return { status: 'rejected', reason: 'bad-image', detail: String(error?.message ?? error), path: sourcePath };
    }

    // 拒收名单优先于去重：命中后不新增来源、不入库，只留审计。
    const denied = await matchDeny({ sha256, phash });
    if (denied !== undefined) {
        if (!dryRun) {
            await audit({
                event: 'sticker-intake', status: 'blocked', reason: 'denylist',
                sha256, phash, match: denied.match, distance: denied.distance ?? null,
                entryReason: denied.reason ?? null, source,
            });
        }
        return { status: 'denylisted', reason: 'denylist', sha256, path: sourcePath };
    }

    if (exact !== undefined) {
        if (!dryRun) {
            exact.sources = uniqueBy([
                ...(exact.sources ?? []),
                { at: nowIso(), ...source, sha256 },
            ], item => [item.kind, item.groupId, item.messageId, item.emojiId, item.path].join('|'));
            exact.updatedAt = nowIso();
            await writeIndex([...records.filter(item => item.id !== exact.id), exact]);
            await audit({ event: 'ingest-duplicate-exact', id: exact.id, sha256, source });
        }
        return { status: 'exact-duplicate', id: exact.id, sha256, path: sourcePath };
    }

    const near = records
        .map(record => ({ record, distance: hammingHex(record.phash, phash) }))
        .filter(item => item.distance <= NEAR_DUP_DISTANCE)
        .sort((a, b) => a.distance - b.distance)[0];

    if (near !== undefined) {
        if (!dryRun) {
            near.record.aliases = uniqueBy([
                ...(near.record.aliases ?? []),
                { sha256, phash, bytes: info.size, width: probe.width, height: probe.height, path: sourcePath },
            ], item => item.sha256);
            near.record.sources = uniqueBy([
                ...(near.record.sources ?? []),
                { at: nowIso(), ...source, sha256, alias: true },
            ], item => [item.kind, item.groupId, item.messageId, item.emojiId, item.path].join('|'));
            near.record.updatedAt = nowIso();
            await writeIndex([...records.filter(item => item.id !== near.record.id), near.record]);
            await audit({
                event: 'ingest-duplicate-near', id: near.record.id, sha256,
                distance: near.distance, source,
            });
        }
        return {
            status: 'near-duplicate', id: near.record.id, sha256,
            distance: near.distance, path: sourcePath,
        };
    }

    if (dryRun)
        return { status: 'new', sha256, phash, probe, path: sourcePath };

    const extension = probe.format === 'jpeg' ? '.jpg'
        : probe.format === 'png' ? '.png'
            : probe.format === 'gif' ? '.gif'
                : probe.format === 'webp' ? '.webp'
                    : extname(sourcePath).toLowerCase() || '.bin';
    const id = 'st_' + sha256.slice(0, 12);
    const relative = join(sha256.slice(0, 2), sha256 + extension);
    const blobPath = join(BLOB_DIR, relative);
    await mkdir(join(BLOB_DIR, sha256.slice(0, 2)), { recursive: true });
    await copyFile(sourcePath, blobPath);

    const blocklist = await readBlocklist();
    const blockHit = blockedBy([sourcePath, descHint, source.name].filter(Boolean).join(' '), blocklist);
    const record = {
        id,
        schemaVersion: SCHEMA_VERSION,
        sha256,
        phash,
        bytes: info.size,
        width: probe.width,
        height: probe.height,
        format: probe.format,
        animated: probe.animated,
        blob: 'blobs/' + relative.replace(/\\/gu, '/'),
        blobPath,
        descHint: String(descHint ?? ''),
        sources: [{ at: nowIso(), ...source, sha256, protected: protect === true }],
        aliases: [],
        // 未打标前不填任何“像标签”的值：情绪“不确定”、强度 null、数组空。
        emotion: UNKNOWN_EMOTION,
        emotionConfidence: 0,
        scenes: [],
        sceneConfidences: [],
        intensity: null,
        intensityConfidence: 0,
        taboo: [],
        tabooConfidences: [],
        textOnImage: '',
        textOnImageItems: [],
        description: '',
        panels: [],
        tagged: false,
        tagSource: '',
        tagRuleVersion: '',
        promptVersion: '',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        lastUsedAt: null,
        lastRecalledAt: null,
        useCount: 0,
        recallCount: 0,
        selectCount: 0,
        flags: {
            pinned: false,
            protected: protect === true,
            blocked: blockHit !== undefined,
            deleted: false,
        },
        blockReason: blockHit,
    };
    await appendFile(INDEX_PATH, JSON.stringify(record) + '\n', 'utf8');
    await audit({ event: 'ingest-added', id, sha256, phash, source, protected: protect === true });
    return { status: 'added', id, sha256, phash, blobPath, path: sourcePath };
}

/**
 * 把 observeImage 的 caption 写回记录。
 * 有结构化 sticker 就原样落库（唯一打标路径的产物，含每项置信度）；
 * 没有才退回文本规则，且同样不填兜底默认值。
 */
export async function attachCaption(id, caption, options = {}) {
    return withIndexLock(() => attachCaptionInner(id, caption, options));
}

async function attachCaptionInner(id, caption, {
    error, extraDesc, sticker, panels, layout, promptVersion,
} = {}) {
    const records = await loadRecords();
    const record = records.find(item => item.id === id);
    if (record === undefined)
        throw new Error('attachCaption: 记录不存在 ' + id);
    const originalName = (record.sources ?? [])
        .map(source => String(source.name ?? ''))
        .find(name => name !== '') ?? basename(record.blobPath ?? '');
    const captionText = String(caption ?? '');
    const structured = normalizeStickerResult(sticker);
    const tags = structured ?? deriveTags({
        caption: captionText,
        filename: originalName,
        desc: [record.descHint, extraDesc].filter(Boolean).join(' '),
    });
    Object.assign(record, tags, {
        captionRaw: captionText,
        tagged: true,
        taggedAt: nowIso(),
        tagError: error ?? null,
        promptVersion: promptVersion ?? record.promptVersion ?? '',
        ...(layout !== undefined ? { layout } : {}),
        panels: Array.isArray(panels)
            ? panels.map(panel => ({
                ...panel,
                ...(panel?.sticker ? { sticker: normalizeStickerResult(panel.sticker) } : {}),
            }))
            : (record.panels ?? []),
        updatedAt: nowIso(),
    });
    if (structured) {
        record.description = [record.descHint, captionText, extraDesc]
            .filter(value => String(value ?? '').trim() !== '').join(' ').trim() || '无描述';
        record.matchedWords = [];
    }
    // 黑名单只看情绪/场景/描述/文件名；引号里的 OCR 文案不参与匹配。
    const blockText = withoutQuotedText([
        record.emotion, ...(record.scenes ?? []), record.description,
        record.descHint, basename(record.blobPath ?? ''),
    ].filter(Boolean).join(' '));
    const blockHit = blockedBy(blockText, await readBlocklist());
    record.flags = { ...(record.flags ?? {}), blocked: blockHit !== undefined };
    record.blockReason = blockHit;
    await writeIndex([...records.filter(item => item.id !== record.id), record]);
    await audit({
        event: 'tag-attached', id, caption: captionText, error: error ?? null,
        emotion: record.emotion ?? null, emotionConfidence: record.emotionConfidence ?? 0,
        scenes: record.scenes ?? [], intensity: record.intensity ?? null,
        textOnImage: record.textOnImage ?? '', ocrMissing: record.ocrMissing === true,
        uncertain: record.emotion === UNKNOWN_EMOTION,
        panelCount: Array.isArray(record.panels) ? record.panels.length : 0,
        tagSource: record.tagSource, tagRuleVersion: record.tagRuleVersion,
        promptVersion: record.promptVersion,
    });
    return record;
}

export async function listPendingTag(limit = 1000) {
    const records = await loadRecords();
    return records.filter(record => record.tagged !== true).slice(0, limit);
}

/**
 * 把指定记录改回待打标状态（重跑模型前用）。
 * 只清打标字段，不动来源、哈希、使用统计；写审计便于回溯。
 */
export async function resetTag(ids = []) {
    const targets = new Set(ids);
    return withIndexLock(async () => {
        const records = await loadRecords();
        const touched = [];
        for (const record of records) {
            if (!targets.has(record.id)) continue;
            record.tagged = false;
            record.tagSource = '';
            record.tagRuleVersion = '';
            record.emotion = UNKNOWN_EMOTION;
            record.emotionConfidence = 0;
            record.scenes = [];
            record.sceneConfidences = [];
            record.intensity = null;
            record.intensityConfidence = 0;
            record.taboo = [];
            record.tabooConfidences = [];
            record.textOnImage = '';
            record.textOnImageItems = [];
            record.description = '';
            record.panels = [];
            record.tagError = null;
            record.updatedAt = nowIso();
            touched.push(record.id);
        }
        if (touched.length > 0) await writeIndex(records);
        await audit({ event: 'tag-reset', ids: touched });
        return touched;
    });
}

/** 读取/推进每小时打标配额。backfill=true 时只记录不拦截。 */
export async function reserveTagBudget({ backfill = false, count = 1 } = {}) {
    const meta = await readMeta();
    const now = Date.now();
    const start = Date.parse(meta.tagBudget?.windowStart ?? '') || 0;
    if (now - start >= 3600_000) {
        meta.tagBudget = { windowStart: new Date(now).toISOString(), count: 0 };
    }
    const used = Number(meta.tagBudget.count) || 0;
    const cap = Number(meta.policy?.tagCapPerHour) || DEFAULT_POLICY.tagCapPerHour;
    if (!backfill && used + count > cap) {
        await writeMeta(meta);
        return { allowed: false, used, cap };
    }
    meta.tagBudget.count = used + count;
    await writeMeta(meta);
    return { allowed: true, used: meta.tagBudget.count, cap };
}

export async function markSelected(id, chatId) {
    const records = await loadRecords();
    const record = records.find(item => item.id === id);
    if (record === undefined) return false;
    record.useCount = (record.useCount ?? 0) + 1;
    record.selectCount = (record.selectCount ?? 0) + 1;
    record.lastUsedAt = nowIso();
    record.lastSelectedAt = nowIso();
    record.lastChatId = chatId ?? null;
    record.updatedAt = nowIso();
    await writeIndex([...records.filter(item => item.id !== record.id), record]);
    await audit({ event: 'sticker-selected', id, chatId: chatId ?? null });
    return true;
}

/** 召回：标签 + 全文，返回候选和“为什么选这个”。 */
export async function recall({
    text = '', emotion = '', limit = 3, recordHits = true, excludeRecentIds = [],
} = {}) {
    const records = (await loadRecords()).filter(record => record.tagged === true
        && record.flags?.blocked !== true
        && record.flags?.deleted !== true
        && !excludeRecentIds.includes(record.id));
    if (records.length === 0)
        return { query: text, candidates: [], reason: '库里没有可用记录' };

    const queryTags = deriveTags({ caption: String(text) });
    const queryEmotion = emotion !== '' ? emotion : queryTags.emotion;
    // “不确定/其他”不是情绪，不能拿它去和记录里的“不确定”互相加分。
    const queryUnknown = queryEmotion === '' || queryEmotion === '其他' || queryEmotion === UNKNOWN_EMOTION;
    // 依据用的词面只从对话正文来（不含调用方给的 emotion 提示），
    // 且排除情绪/场景枚举本身——那两个由 emotion/scene 依据单独负责。
    const conversationTokens = tokenize(String(text));
    const tagTokens = new Set([...EMOTION_ORDER, ...SCENE_ORDER, UNKNOWN_EMOTION, '其他']);
    const queryTokens = tokenize([text, emotion, queryTags.emotion, ...queryTags.scenes].join(' '));

    const docs = records.map(record => ({
        record,
        tokens: tokenize([
            record.description, record.textOnImage, record.emotion,
            ...(record.textOnImageItems ?? []).map(item => item?.text ?? ''),
            ...(record.scenes ?? []), basename(record.blobPath ?? ''),
        ].filter(Boolean).join(' ')),
    }));
    const df = new Map();
    for (const doc of docs) {
        for (const token of doc.tokens)
            df.set(token, (df.get(token) ?? 0) + 1);
    }
    const total = docs.length;
    const idf = token => Math.log((total + 1) / ((df.get(token) ?? 0) + 1)) + 1;
    const queryWeight = [...queryTokens].reduce((sum, token) => sum + idf(token), 0) || 1;
    const now = Date.now();

    const scored = [];
    for (const doc of docs) {
        const record = doc.record;
        let score = 0;
        const why = [];

        const overlap = [...queryTokens].filter(token => doc.tokens.has(token));
        if (overlap.length > 0) {
            const weight = overlap.reduce((sum, token) => sum + idf(token), 0);
            score += Math.min(1, weight / queryWeight) * 4;
        }
        const emotionHit = !queryUnknown && record.emotion === queryEmotion;
        if (emotionHit) {
            score += emotion !== '' ? 3 : 2.2;
            const hitWords = (queryTags.matchedWords ?? []).slice(0, 2);
            why.push((hitWords.length > 0 ? '命中词「' + hitWords.join('、') + '」→ ' : '')
                + '情绪「' + queryEmotion + '」一致');
        }
        const commonScenes = (record.scenes ?? []).filter(scene => queryTags.scenes.includes(scene));
        if (commonScenes.length > 0) {
            score += Math.min(3, commonScenes.length * 1.5);
            why.push('场景「' + commonScenes.join('、') + '」命中');
        }
        if (!emotionHit && commonScenes.length === 0 && overlap.length > 0)
            why.push('描述命中 ' + overlap.slice(0, 3).join('、'));
        // 图上文字逐条比对；老记录的 textOnImage 是整串，留作兜底。
        const textHit = (record.textOnImageItems ?? [])
            .find(item => typeof item?.text === 'string' && item.text !== ''
                && String(text).includes(item.text))
            ?? (record.textOnImage && String(text).includes(record.textOnImage)
                ? { text: record.textOnImage }
                : undefined);
        if (textHit !== undefined) {
            score += 2;
            why.push('图上文字「' + textHit.text + '」与消息重合');
        }
        // 选中依据必须来自对话本身：情绪是文本判出来的、场景重合、图上原话、词面重合。
        // 调用方给的 emotion 提示只参与排序，不构成依据（否则随便给个「开心」就能发图）。
        const evidence = [];
        if (queryTags.emotion !== UNKNOWN_EMOTION && queryTags.emotion !== '其他'
            && record.emotion === queryTags.emotion)
            evidence.push('emotion');
        if (commonScenes.length > 0)
            evidence.push('scene');
        if (textHit !== undefined)
            evidence.push('text');
        if ([...conversationTokens].some(token => !tagTokens.has(token) && doc.tokens.has(token)))
            evidence.push('keyword');
        // 强度只有两边都判出来才比较；null 不当作 3 参与打分。
        const recordIntensity = record.intensity === null || record.intensity === undefined
            ? null
            : Number(record.intensity);
        const queryIntensity = queryTags.intensity === null || queryTags.intensity === undefined
            ? null
            : Number(queryTags.intensity);
        if (recordIntensity !== null && queryIntensity !== null
            && Math.abs(recordIntensity - queryIntensity) <= 1)
            score += 0.5;
        if (!record.lastUsedAt) score += 0.3;
        else if (now - Date.parse(record.lastUsedAt) < 7 * 864e5) score -= 0.2;

        if ((record.taboo ?? []).includes('安慰') && /安慰|别哭|难过|抱抱|摸摸/u.test(String(text))) {
            score -= 1000;
            why.push('禁忌：不适合安慰');
        }
        if (record.flags?.blocked === true)
            score -= 1000;

        const reason = why.length > 0 ? why.slice(0, 3).join('；') : '按标签相近度入选';
        const caution = (record.taboo ?? []).length > 0
            ? '；注意不适合：' + record.taboo.join('、')
            : '';
        const weak = score < 1.5 ? '弱相关；' : '';
        scored.push({
            record,
            score,
            evidence,
            reason: weak + reason + caution
                + (recordIntensity === null ? '；强度未判' : '；强度 ' + recordIntensity + '/5'),
        });
    }

    scored.sort((a, b) => b.score - a.score);
    const picked = [];
    for (const item of scored) {
        if (item.score <= -500) continue;
        if (picked.some(chosen => hammingHex(chosen.record.phash, item.record.phash) <= NEAR_DUP_DISTANCE))
            continue;
        picked.push(item);
        if (picked.length >= Math.max(1, Math.min(10, Number(limit) || 3))) break;
    }

    if (recordHits && picked.length > 0) {
        const ids = new Set(picked.map(item => item.record.id));
        const all = await loadRecords();
        for (const record of all) {
            if (!ids.has(record.id)) continue;
            record.recallCount = (record.recallCount ?? 0) + 1;
            record.lastRecalledAt = nowIso();
            record.updatedAt = nowIso();
        }
        await writeIndex(all);
    }

    return {
        query: text,
        queryTags: {
            emotion: queryTags.emotion, emotionConfidence: queryTags.emotionConfidence ?? 0,
            scenes: queryTags.scenes, intensity: queryTags.intensity,
        },
        candidates: picked.map(item => ({
            id: item.record.id,
            score: Number(item.score.toFixed(2)),
            emotion: item.record.emotion,
            emotionConfidence: item.record.emotionConfidence ?? 0,
            scenes: item.record.scenes ?? [],
            sceneConfidences: item.record.sceneConfidences ?? [],
            intensity: item.record.intensity ?? null,
            intensityConfidence: item.record.intensityConfidence ?? 0,
            textOnImage: item.record.textOnImage ?? '',
            textOnImageItems: item.record.textOnImageItems ?? [],
            taboo: item.record.taboo ?? [],
            ocrMissing: item.record.ocrMissing === true,
            panels: item.record.panels ?? [],
            description: item.record.description,
            evidence: item.evidence ?? [],
            reason: item.reason,
        })),
    };
}

/* ------------------------------------------------------------------ */
/* 发送侧选图：recall 负责打分，这里只加冷却/去重/按会话隔离/黑名单     */
/* ------------------------------------------------------------------ */

/**
 * 选图策略。排序只有 recall 一套；本层不重新打分，只做过滤和去重。
 * - minScore: recall 标为“弱相关”（<1.5）的不要，宁可不发也不乱发。
 * - globalCooldownMs: 同一张图跨会话 10 分钟内不再出现。
 * - chatCooldownMs + recentPerChat: 同一会话最近 3 张在 2 小时内排除，保证不连发同一张。
 */
export const PICK_POLICY = Object.freeze({
    minScore: 1.5,
    candidateLimit: 50,
    globalCooldownMs: 10 * 60_000,
    chatCooldownMs: 2 * 60 * 60_000,
    recentPerChat: 3,
});

const PICK_STATE_PATH = join(WORK_DIR, 'pick-state.json');
const PICK_STATE_KEEP_MS = 7 * 864e5;

async function loadPickState() {
    const parsed = await readJson(PICK_STATE_PATH, {});
    const chats = parsed?.chats && typeof parsed.chats === 'object' ? parsed.chats : {};
    return { version: 1, chats };
}

async function savePickState(state) {
    await mkdir(WORK_DIR, { recursive: true });
    const temporary = PICK_STATE_PATH + '.' + process.pid + '.tmp';
    await writeFile(temporary, JSON.stringify(state), 'utf8');
    await rename(temporary, PICK_STATE_PATH);
}

/**
 * 按当前对话选一张图。
 * @returns {{ok:boolean, reason:string, chosen?:object, candidates:object[]}}
 */

/* 含义闸：标签、描述、对话依据三者齐全才算「能保证理解」。
 * 只看分数不够——keyword 单命中也能凑出 evidence，那种情况下模型并不知道
 * 这张图在这个语境里是什么意思，宁可不发（主人要求：没把握就退回文字）。 */
function meaningVerified(chosen, record) {
    if (chosen === undefined || chosen.id === undefined || record === undefined)
        return false;
    if (record.tagged !== true)
        return false;
    if (record.emotion === undefined || record.emotion === null || record.emotion === ''
        || record.emotion === UNKNOWN_EMOTION || record.emotion === '其他')
        return false;
    if (String(chosen.description ?? '').trim() === '')
        return false;
    // 只认对话正文判出来的 emotion / scene / text；只有 keyword 不算。
    if (!(Array.isArray(chosen.evidence)
        && chosen.evidence.some(kind => kind === 'emotion' || kind === 'scene' || kind === 'text')))
        return false;
    if (!(Number(chosen.score) >= PICK_POLICY.minScore))
        return false;
    if (record.flags?.blocked === true || record.flags?.deleted === true)
        return false;
    return true;
}

export async function pickSticker({
    text = '', emotion = '', chatId = '', turnId = '', now = Date.now(), dryRun = false,
} = {}) {
    const conversationText = String(text ?? '');
    const queryText = [conversationText, String(emotion ?? '')]
        .filter(value => value.trim() !== '')
        .join('\n');
    if (queryText.trim() === '')
        return { ok: false, reason: 'empty-query', candidates: [] };

    // 标签与依据只从对话正文来：emotion 只是排序提示，不能把「开心」这类词
    // 塞进待匹配文本里冒充对话内容（历史上就是这么一路发歪的）。
    const recalled = await recall({
        text: conversationText,
        emotion: String(emotion ?? ''),
        limit: PICK_POLICY.candidateLimit,
        recordHits: false,
    });
    if (recalled.candidates.length === 0)
        return { ok: false, reason: recalled.reason ?? 'no-record', candidates: [] };

    const byId = new Map((await loadRecords()).map(record => [record.id, record]));
    const state = dryRun ? { version: 1, chats: {} } : await loadPickState();
    const chat = state.chats[chatId] ?? {};
    // 一次回复最多一张：同一轮已经发过就直接拒，不再选第二张。
    const turnKey = String(turnId ?? '').trim();
    if (!dryRun && turnKey !== '' && chat.lastTurnId === turnKey)
        return { ok: false, reason: 'already-sent-this-turn', candidates: [] };
    const history = (Array.isArray(chat.history) ? chat.history : [])
        .filter(item => now - Number(item.at) < PICK_POLICY.chatCooldownMs)
        .slice(-PICK_POLICY.recentPerChat);
    const recentIds = new Set(history.map(item => item.id));
    const blocklist = await readBlocklist();
    // 当前在说“让我想想/犹豫”时不发表情包：黑名单对上下文同样生效。
    const queryBlocked = blockedBy(queryText, blocklist);
    if (queryBlocked !== undefined)
        return { ok: false, reason: 'query-blocked:' + queryBlocked, candidates: [] };
    // 没有可识别情绪、模型也没给明确提示时宁可不发，避免“在吗”也甩一张图。
    // 例外：消息里出现了某张图上的原话（≥3 字），这本身就是足够强的依据。
    const queryEmotion = String(recalled.queryTags?.emotion ?? UNKNOWN_EMOTION);
    const hint = String(emotion ?? '').trim();
    const hintMatched = hint !== '' && recalled.candidates.some(candidate =>
        candidate.emotion === hint || (candidate.scenes ?? []).includes(hint));
    const literalHit = recalled.candidates.some(candidate =>
        (candidate.textOnImageItems ?? []).some(item =>
            typeof item?.text === 'string' && item.text.length >= 3 && conversationText.includes(item.text)));
    if ((queryEmotion === '其他' || queryEmotion === UNKNOWN_EMOTION) && !hintMatched && !literalHit)
        return { ok: false, reason: 'no-emotion', candidates: [] };

    const evaluated = [];
    for (const candidate of recalled.candidates) {
        const record = byId.get(candidate.id);
        if (record === undefined)
            continue;
        if (record.flags?.deleted === true || record.flags?.blocked === true)
            continue;
        // “其他/不确定”都不是情绪，永远不拿它们当选中理由。
        if (record.emotion === '其他' || record.emotion === UNKNOWN_EMOTION)
            continue;
        // 黑名单：id/情绪/描述/文件名 任一命中就排除；图上 OCR 文案不算。
        const haystack = withoutQuotedText([
            record.id, record.emotion, record.description, basename(record.blobPath ?? ''),
        ].filter(Boolean).join(' '));
        const blocked = blockedBy(haystack, blocklist);
        const usedAt = Date.parse(String(record.lastUsedAt ?? ''));
        const globalCooling = !dryRun && Number.isFinite(usedAt)
            && now - usedAt < PICK_POLICY.globalCooldownMs;
        const chatRecent = !dryRun && recentIds.has(record.id);
        const weak = Number(candidate.score) < PICK_POLICY.minScore;
        // 没有任何来自对话的依据 → 不选。只有“情绪=提示词”这一条不算依据，
        // 否则随口给个「开心」就能把库里所有开心图发一遍。
        const evidence = Array.isArray(candidate.evidence) ? candidate.evidence : [];
        const status = blocked !== undefined ? 'blocked:' + blocked
            : weak ? 'weak'
                : evidence.length === 0 ? 'no-match'
                    : globalCooling ? 'cooldown'
                        : chatRecent ? 'chat-recent'
                            : 'ok';
        evaluated.push({
            id: record.id,
            score: candidate.score,
            emotion: record.emotion,
            scenes: record.scenes ?? [],
            description: record.description ?? '',
            textOnImage: record.textOnImage ?? '',
            blobPath: record.blobPath ?? '',
            evidence,
            reason: candidate.reason,
            status,
        });
    }

    if (evaluated.length === 0)
        return { ok: false, reason: 'all-filtered', candidates: [] };
    const chosen = evaluated.find(item => item.status === 'ok');
    if (chosen === undefined) {
        return { ok: false, reason: 'no-eligible', candidates: evaluated.slice(0, 8) };
    }
    // 发送前硬闸：理解不了含义就不发，退回文字；候选摘要留给插件记账。
    if (!meaningVerified(chosen, byId.get(chosen.id))) {
        return { ok: false, reason: 'meaning-unverified', candidates: evaluated.slice(0, 8) };
    }
    // 不在选图时记账：插件发送成功后才调用 noteStickerSelected，避免发失败也占冷却。
    return { ok: true, reason: '', chosen, candidates: evaluated.slice(0, 8) };
}

/** 记录一次实际发送：会话最近记录 + 索引里的 lastUsedAt（全局冷却依据）。 */
export async function noteStickerSelected(id, chatId, now = Date.now(), turnId = '') {
    const state = await loadPickState();
    const chat = state.chats[chatId] ?? {};
    const history = (Array.isArray(chat.history) ? chat.history : [])
        .filter(item => now - Number(item.at) < PICK_STATE_KEEP_MS);
    history.push({ id, at: now });
    state.chats[chatId] = { history: history.slice(-50) };
    for (const [key, value] of Object.entries(state.chats)) {
        const alive = (Array.isArray(value?.history) ? value.history : [])
            .filter(item => now - Number(item.at) < PICK_STATE_KEEP_MS);
        if (alive.length === 0)
            delete state.chats[key];
        else
            state.chats[key] = { ...value, history: alive.slice(-50) };
    }
    const turnKey = String(turnId ?? '').trim();
    if (turnKey !== '')
        state.chats[chatId].lastTurnId = turnKey;
    await savePickState(state);
    await markSelected(id, chatId);
}

function clusterByPhash(records, distance = NEAR_DUP_DISTANCE) {
    const clusters = [];
    for (const record of records) {
        let placed = false;
        for (const cluster of clusters) {
            if (hammingHex(cluster[0].phash, record.phash) <= distance) {
                cluster.push(record);
                placed = true;
                break;
            }
        }
        if (!placed) clusters.push([record]);
    }
    return clusters;
}

function recordArea(record) {
    return (Number(record.width) || 0) * (Number(record.height) || 0);
}

function chooseSurvivor(cluster) {
    const protectedRecords = cluster.filter(isProtected);
    const pool = protectedRecords.length > 0 ? protectedRecords : cluster;
    return [...pool].sort((a, b) => {
        const areaDiff = recordArea(b) - recordArea(a);
        if (areaDiff !== 0) return areaDiff;
        if ((a.bytes ?? 0) !== (b.bytes ?? 0)) return (a.bytes ?? 0) - (b.bytes ?? 0);
        return String(a.createdAt).localeCompare(String(b.createdAt));
    })[0];
}

function lastActivityAt(record) {
    const values = [record.lastUsedAt, record.lastRecalledAt, record.createdAt]
        .map(value => Date.parse(value ?? ''))
        .filter(value => Number.isFinite(value));
    return values.length > 0 ? Math.max(...values) : 0;
}

function mergeInto(survivor, other) {
    survivor.sources = uniqueBy([
        ...(survivor.sources ?? []), ...(other.sources ?? []),
    ], item => [item.kind, item.groupId, item.messageId, item.emojiId, item.path].join('|'));
    survivor.aliases = uniqueBy([
        ...(survivor.aliases ?? []),
        { sha256: other.sha256, phash: other.phash, bytes: other.bytes, width: other.width, height: other.height, path: other.blobPath },
        ...(other.aliases ?? []),
    ], item => item.sha256);
    survivor.useCount = (survivor.useCount ?? 0) + (other.useCount ?? 0);
    survivor.recallCount = (survivor.recallCount ?? 0) + (other.recallCount ?? 0);
    survivor.selectCount = (survivor.selectCount ?? 0) + (other.selectCount ?? 0);
    survivor.updatedAt = nowIso();
}

function softDelete(record, reason, extra = {}) {
    record.flags = { ...(record.flags ?? {}), deleted: true };
    record.deletedAt = nowIso();
    record.deleteReason = reason;
    record.purgeAfter = new Date(Date.now() + (Number(extra.retentionDays) || DEFAULT_POLICY.retentionDays) * 864e5).toISOString();
    Object.assign(record, extra.patch ?? {});
}

/**
 * 自检：入站表情包补丁是否还在。
 * applied=已打上；not-applied=还没应用（重启前属正常）；
 * modified=目标文件被插件升级或他人改动覆盖，需要重新应用；unknown=清单缺失。
 */
export async function checkPatch() {
    const manifest = await readJson(PATCH_MANIFEST_PATH, undefined);
    if (manifest === undefined || typeof manifest?.target !== 'string')
        return { state: 'unknown', detail: '缺少 patch-manifest.json', manifestPath: PATCH_MANIFEST_PATH };
    let actual;
    try {
        actual = await sha256File(manifest.target);
    }
    catch {
        return { state: 'missing-file', target: manifest.target, appliedAt: manifest.appliedAt ?? null };
    }
    const state = actual === manifest.patchedSha256 ? 'applied'
        : actual === manifest.baselineSha256 ? 'not-applied'
            : 'modified';
    return {
        state,
        target: manifest.target,
        actualSha256: actual,
        expectedPatched: manifest.patchedSha256,
        appliedAt: manifest.appliedAt ?? null,
    };
}

/** 健康自检：回答“这个库现在健康吗”。 */
export async function getHealth() {
    const active = await loadRecords();
    const tombstones = await loadTombstones();
    const byEmotion = Object.fromEntries(EMOTION_ORDER.map(emotion => [emotion, 0]));
    const byScene = Object.fromEntries(SCENE_ORDER.map(scene => [scene, 0]));
    let bytes = 0;
    let broken = 0;
    let oldestUnusedDays = 0;
    let tagged = 0;
    let blocked = 0;
    const now = Date.now();
    for (const record of active) {
        bytes += Number(record.bytes) || 0;
        if (record.tagged === true) tagged += 1;
        if (record.flags?.blocked === true) blocked += 1;
        if (byEmotion[record.emotion] !== undefined) byEmotion[record.emotion] += 1;
        for (const scene of record.scenes ?? []) {
            if (byScene[scene] !== undefined) byScene[scene] += 1;
        }
        const activity = lastActivityAt(record);
        if (activity > 0) oldestUnusedDays = Math.max(oldestUnusedDays, Math.floor((now - activity) / 864e5));
    }
    for (const record of active) {
        try {
            const info = await stat(record.blobPath);
            if (!info.isFile() || info.size === 0) broken += 1;
        }
        catch {
            broken += 1;
        }
    }
    const clusters = clusterByPhash(active);
    const duplicateClusters = clusters.filter(cluster => cluster.length > 1);
    const duplicateRate = active.length === 0 ? 0 : duplicateClusters.length / active.length;
    const thinScenes = SCENE_ORDER.filter(scene => byScene[scene] < 2);
    const lastMaintenance = (await readLines(MAINT_LOG_PATH)).map(safeJson).filter(Boolean).at(-1) ?? null;
    return {
        total: active.length,
        tombstones: tombstones.length,
        bytes,
        bytesText: toBytesText(bytes),
        tagged,
        taggedCoverage: active.length === 0 ? 0 : Number((tagged / active.length).toFixed(3)),
        blocked,
        broken,
        byEmotion,
        byScene,
        duplicateClusters: duplicateClusters.length,
        duplicateRecords: duplicateClusters.reduce((sum, cluster) => sum + cluster.length - 1, 0),
        duplicateRate: Number(duplicateRate.toFixed(3)),
        oldestUnusedDays,
        thinScenes,
        lastMaintenance,
        patch: await checkPatch(),
    };
}

/** 自维护：坏图、精确/近似合并、陈旧清理、墓碑压缩、过期清除。 */
export async function runMaintenance({
    dryRun = false, policy = {}, sendingEnabled = false,
} = {}) {
    await ensureLayout();
    const patch = await checkPatch();
    const meta = await readMeta();
    const effective = { ...meta.policy, ...policy };
    const startedAt = nowIso();
    const all = await loadAllIndexed();
    let active = all.filter(record => record.flags?.deleted !== true);
    const tombstones = await loadTombstones();
    const actions = {
        scanned: active.length,
        exactMerged: 0,
        nearMerged: 0,
        tombstoned: 0,
        purged: 0,
        broken: 0,
        stale: 0,
        lowSelection: 0,
        skippedProtected: 0,
        keptLastOfEmotion: 0,
    };
    const reasons = [];
    const newlyDeleted = [];
    const now = Date.now();

    const deleteSafely = (record, reason, detail) => {
        if (isProtected(record)) {
            actions.skippedProtected += 1;
            reasons.push({ id: record.id, action: 'keep', reason: 'protected' });
            return false;
        }
        const activeSameEmotion = active.filter(item => item.emotion === record.emotion).length;
        if (activeSameEmotion <= 1 && reason !== 'blob-missing' && reason !== 'blob-corrupt') {
            actions.keptLastOfEmotion += 1;
            reasons.push({ id: record.id, action: 'keep', reason: 'last-of-emotion:' + record.emotion });
            return false;
        }
        softDelete(record, reason, { retentionDays: effective.retentionDays });
        newlyDeleted.push(record);
        actions.tombstoned += 1;
        reasons.push({ id: record.id, action: 'soft-delete', reason, detail: detail ?? null });
        return true;
    };

    // 1) 坏图：blob 丢失/为空/无法解码
    for (const record of [...active]) {
        let bad = false;
        let detail = '';
        try {
            const info = await stat(record.blobPath);
            if (!info.isFile() || info.size === 0) {
                bad = true;
                detail = 'missing-or-empty';
            }
            else {
                await probeImage(record.blobPath);
            }
        }
        catch (error) {
            bad = true;
            detail = String(error?.message ?? error);
        }
        if (!bad) continue;
        actions.broken += 1;
        if (!dryRun && deleteSafely(record, 'blob-missing-or-corrupt', detail))
            active = active.filter(item => item.id !== record.id);
    }

    // 2) 精确重复：同 sha256 只留一条
    const bySha = new Map();
    for (const record of active) {
        const list = bySha.get(record.sha256) ?? [];
        list.push(record);
        bySha.set(record.sha256, list);
    }
    for (const group of bySha.values()) {
        if (group.length <= 1) continue;
        const survivor = chooseSurvivor(group);
        for (const record of group) {
            if (record.id === survivor.id) continue;
            if (dryRun) {
                actions.exactMerged += 1;
                continue;
            }
            if (deleteSafely(record, 'duplicate-sha', 'merged-into:' + survivor.id)) {
                mergeInto(survivor, record);
                active = active.filter(item => item.id !== record.id);
                actions.exactMerged += 1;
            }
        }
    }

    // 3) 近似重复：pHash 聚类只留最优
    const clusters = clusterByPhash(active);
    for (const cluster of clusters) {
        if (cluster.length <= 1) continue;
        const survivor = chooseSurvivor(cluster);
        for (const record of cluster) {
            if (record.id === survivor.id) continue;
            if (dryRun) {
                actions.nearMerged += 1;
                continue;
            }
            if (deleteSafely(record, 'duplicate-near', 'merged-into:' + survivor.id)) {
                mergeInto(survivor, record);
                active = active.filter(item => item.id !== record.id);
                actions.nearMerged += 1;
            }
        }
    }

    // 4) 陈旧清理：按 lastActivity（用/被召回/入库）判断
    for (const record of [...active]) {
        const activity = lastActivityAt(record);
        const ageDays = (now - activity) / 864e5;
        if (ageDays <= effective.staleDays) continue;
        actions.stale += 1;
        if (!dryRun && deleteSafely(record, 'stale-unused', 'idle-days:' + Math.floor(ageDays)))
            active = active.filter(item => item.id !== record.id);
    }

    // 5) 低命中率修剪：只有发送打开、且确实有选择样本时才生效
    if (sendingEnabled) {
        for (const record of [...active]) {
            const recalls = Number(record.recallCount) || 0;
            const selects = Number(record.selectCount) || 0;
            if (recalls < effective.lowSelectionMinRecalls) continue;
            const rate = selects / recalls;
            const idleDays = (now - Date.parse(record.lastSelectedAt ?? record.createdAt ?? '')) / 864e5;
            if (rate >= effective.lowSelectionRate || idleDays <= effective.lowSelectionDays) continue;
            actions.lowSelection += 1;
            if (!dryRun && deleteSafely(record, 'low-selection', 'rate:' + rate.toFixed(3)))
                active = active.filter(item => item.id !== record.id);
        }
    }

    // 6) 墓碑压缩 + 过期清除
    const closed = uniqueBy([
        ...all.filter(record => record.flags?.deleted === true),
        ...newlyDeleted,
    ], record => record.id);
    const keptOpen = active.filter(record => record.flags?.deleted !== true);
    const recentTombstones = [...tombstones];
    for (const record of closed) {
        if (recentTombstones.some(item => item.id === record.id)) continue;
        recentTombstones.push(record);
    }
    const survivorsForPurge = [];
    for (const record of recentTombstones) {
        const purgeAt = Date.parse(record.purgeAfter ?? '');
        if (!Number.isFinite(purgeAt) || purgeAt > now) {
            survivorsForPurge.push(record);
            continue;
        }
        actions.purged += 1;
        reasons.push({ id: record.id, action: 'purge', reason: record.deleteReason ?? 'retention-expired' });
        if (dryRun) {
            survivorsForPurge.push(record);
            continue;
        }
        try {
            await rm(record.blobPath, { force: true });
        }
        catch {
            // blob 已经不在，不阻塞
        }
        await appendFile(PURGED_PATH, JSON.stringify({
            ...record, purgedAt: nowIso(),
        }) + '\n', 'utf8');
    }

    const summary = {
        at: startedAt,
        finishedAt: nowIso(),
        dryRun,
        policy: effective,
        sendingEnabled,
        before: { active: all.filter(record => record.flags?.deleted !== true).length },
        after: { active: keptOpen.length },
        actions,
        reasons: reasons.slice(0, 200),
        bytes: keptOpen.reduce((sum, record) => sum + (Number(record.bytes) || 0), 0),
        patch,
    };

    if (!dryRun) {
        await writeIndex(keptOpen);
        await writeTombstones(survivorsForPurge);
        await appendFile(MAINT_LOG_PATH, JSON.stringify(summary) + '\n', 'utf8');
        await audit({ event: 'maintenance-run', actions, dryRun, patchState: patch.state });
        if (patch.state === 'modified' || patch.state === 'missing-file' || patch.state === 'unknown')
            await audit({ event: 'sticker-patch-warning', state: patch.state, target: patch.target ?? null });
    }
    return summary;
}

export async function readMaintenanceHistory(limit = 5) {
    return (await readLines(MAINT_LOG_PATH)).map(safeJson).filter(Boolean).slice(-limit);
}

/** 从墓碑恢复一条记录（保留期内）。 */
export async function restoreRecord(id) {
    await ensureLayout();
    const tombstones = await loadTombstones();
    const record = tombstones.find(item => item.id === id);
    if (record === undefined) return { ok: false, reason: 'not-found' };
    try {
        await stat(record.blobPath);
    }
    catch {
        return { ok: false, reason: 'blob-purged' };
    }
    record.flags = { ...(record.flags ?? {}), deleted: false };
    delete record.deletedAt;
    delete record.deleteReason;
    delete record.purgeAfter;
    record.updatedAt = nowIso();
    const rest = tombstones.filter(item => item.id !== id);
    await writeTombstones(rest);
    const records = await loadRecords();
    await writeIndex([...records.filter(item => item.id !== id), record]);
    await audit({ event: 'maintenance-restore', id });
    return { ok: true, record };
}

async function copyDir(src, dst, filter) {
    let count = 0;
    let bytes = 0;
    let entries;
    try {
        entries = await readdir(src, { withFileTypes: true });
    }
    catch {
        return { count, bytes };
    }
    await mkdir(dst, { recursive: true });
    for (const entry of entries) {
        const from = join(src, entry.name);
        const to = join(dst, entry.name);
        if (entry.isDirectory()) {
            const nested = await copyDir(from, to, filter);
            count += nested.count;
            bytes += nested.bytes;
        }
        else if (entry.isFile() && filter(entry.name)) {
            await copyFile(from, to);
            const info = await stat(to);
            count += 1;
            bytes += info.size;
        }
    }
    return { count, bytes };
}

/** 每日备份：只拷 blobs + index.jsonl，不碰推理缓存。 */
export async function ensureDailyBackup({ force = false } = {}) {
    await ensureLayout();
    const stamp = localDateStamp();
    const target = join(BACKUP_ROOT, stamp);
    const manifestPath = join(target, 'manifest.json');
    if (!force) {
        const existing = await readJson(manifestPath, undefined);
        if (existing !== undefined)
            return { created: false, target, manifest: existing };
    }
    await mkdir(target, { recursive: true });
    const blobs = await copyDir(BLOB_DIR, join(target, 'blobs'), name => /\.(png|jpe?g|gif|webp)$/iu.test(name));
    let indexBytes = 0;
    try {
        const info = await stat(INDEX_PATH);
        await copyFile(INDEX_PATH, join(target, 'index.jsonl'));
        indexBytes = info.size;
    }
    catch {
        // 空库也允许备份
    }
    const records = await loadRecords();
    const manifest = {
        createdAt: nowIso(),
        source: LIB_ROOT,
        date: stamp,
        records: records.length,
        blobFiles: blobs.count,
        blobBytes: blobs.bytes,
        indexBytes,
        note: 'only blobs + index.jsonl',
    };
    await writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const dirs = (await readdir(BACKUP_ROOT, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && /^\d{8}$/u.test(entry.name))
        .map(entry => entry.name)
        .sort();
    for (const old of dirs.slice(0, Math.max(0, dirs.length - BACKUP_KEEP)))
        await rm(join(BACKUP_ROOT, old), { recursive: true, force: true });
    await audit({ event: 'backup-created', target, manifest });
    return { created: true, target, manifest };
}

export { toBytesText, MAX_FILE_BYTES, DEFAULT_POLICY };
