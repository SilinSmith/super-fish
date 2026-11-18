/**
 * 出图自审：生成完先看一眼，再决定发不发。
 *
 * 约束（来自实际使用）：
 * - 单通道串行，最多排队 4 张；排满直接拦下，不无限堆积。
 * - 每张 20 秒超时。超时是唯一允许降级放行的失败：图可能没问题，
 *   只是引擎忙着别的请求；标注 degraded=timeout 后照发。
 * - 模型报错 / 返回不是合法 JSON：拦下不发，记日志。
 * - 提示词短、只做判定，不注入 character.md，避免它开始“演人格”。
 * - 审图请求直接打 8094，不经过 persona proxy：这条链不需要人格与记忆，
 *   走 proxy 会多读一遍盘、多拼一段 system。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { LLM, chatCompletionsPath, normalizePayload } from './llm-config.mjs';

export const LOG_PATH = process.env.QQ_DRAW_REVIEW_LOG ?? 'Y:\\dsh\\home\\qq-persona\\draw-review.jsonl';
const REVIEW_TIMEOUT_MS = Number(process.env.QQ_DRAW_REVIEW_TIMEOUT_MS ?? 20_000);
// 请求失败（引擎重启、瞬时拒绝）要重试：默认总共 3 次调用，即首次 + 2 次重试。
const REVIEW_ATTEMPTS = Math.max(3, Number(process.env.QQ_DRAW_REVIEW_ATTEMPTS ?? 3));
const REVIEW_BACKOFF_MS = Number(process.env.QQ_DRAW_REVIEW_BACKOFF_MS ?? 800);
const MAX_QUEUE = Number(process.env.QQ_DRAW_REVIEW_QUEUE ?? 4);
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const SHARP_PATH = process.env.QQ_DRAW_REVIEW_SHARP
    ?? 'C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\sharp\\dist\\index.mjs';
const API_URL = process.env.QQ_DRAW_REVIEW_URL
    ?? (new URL(LLM.baseUrl).origin + chatCompletionsPath());

const SYSTEM_PROMPT = '你是图像质检员，只做判定。不聊天、不扮演任何角色、不寒暄、不解释过程。只输出一段 JSON。';

const RUBRIC = `检查这张图，逐项判断：
1. hands_ok：手指数量与形状是否正常（多指、少指、粘连、断手都算 false）
2. limbs_ok：四肢是否错位、缺失、重复（多手多脚、肢体反关节都算 false）
3. face_ok：脸部是否崩坏、五官错位、眼睛不对称
4. text_ok：图中文字是否清楚可读；没有任何文字时算 true
5. composition_ok：主体是否完整、不糊、没有大片空白或被裁掉
6. noise_ok：没有明显噪点、色块、拼接伪影
最后给 score（0-100）和 defects（中文短句，没有就空数组）。
任一 *_ok 为 false 或 score < 60 时 verdict 必须是 "fail"，否则 "pass"。
只输出 JSON，不要代码块，不要解释：
{"hands_ok":true,"limbs_ok":true,"face_ok":true,"text_ok":true,"composition_ok":true,"noise_ok":true,"score":80,"defects":[],"verdict":"pass"}`;

const FIELDS = ['hands_ok', 'limbs_ok', 'face_ok', 'text_ok', 'composition_ok', 'noise_ok'];
const FIELD_LABEL = {
    hands_ok: '手',
    limbs_ok: '四肢',
    face_ok: '脸',
    text_ok: '文字',
    composition_ok: '构图',
    noise_ok: '噪点',
};

const queue = [];
let running = false;
let sequence = 0;
let sharpPromise;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function loadSharp() {
    sharpPromise ??= import('file:///' + SHARP_PATH.replace(/\\/gu, '/').replace(/^\/+/u, ''))
        .then(module => module.default ?? module)
        .catch(() => undefined);
    return sharpPromise;
}

function sniffMime(bytes) {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
        return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
        return 'image/jpeg';
    if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
        return 'image/webp';
    return undefined;
}

/** 长边压到 768：审图只看结构，原图 1024 以上对 20 秒预算太贵。 */
async function preparePng(bytes) {
    const mime = sniffMime(bytes);
    if (mime === undefined)
        return undefined;
    const sharp = await loadSharp();
    if (sharp === undefined)
        return mime === 'image/png' ? bytes : undefined;
    try {
        return await sharp(bytes, { animated: false })
            .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
            .png({ compressionLevel: 9 })
            .toBuffer();
    }
    catch {
        return undefined;
    }
}

function extractJson(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start)
        return undefined;
    try {
        const value = JSON.parse(text.slice(start, end + 1));
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
}

function normalizeVerdict(parsed) {
    const fields = {};
    let missing = false;
    for (const name of FIELDS) {
        if (typeof parsed[name] === 'boolean')
            fields[name] = parsed[name];
        else {
            fields[name] = false;
            missing = true;
        }
    }
    const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score))));
    const safeScore = Number.isFinite(score) ? score : 0;
    const defects = (Array.isArray(parsed.defects) ? parsed.defects : [])
        .map(item => String(item).replace(/\s+/gu, ' ').trim())
        .filter(item => item !== '')
        .slice(0, 8);
    // 判定以逐项字段为准：模型自报 verdict=pass 但某只手画坏了，也按 fail 处理。
    const allOk = FIELDS.every(name => fields[name] === true);
    const pass = !missing && allOk && safeScore >= 60;
    if (!pass && defects.length === 0) {
        for (const name of FIELDS) {
            if (fields[name] === false)
                defects.push(FIELD_LABEL[name] + '不合格');
        }
        if (defects.length === 0)
            defects.push(missing ? '评分表不完整' : '总分偏低（' + safeScore + '）');
    }
    return { fields, score: safeScore, defects, verdict: pass ? 'pass' : 'fail' };
}

async function callReview(png, prompt) {
    const dataUrl = 'data:image/png;base64,' + png.toString('base64');
    const headers = { 'content-type': 'application/json' };
    if (LLM.apiKey !== '')
        headers.authorization = 'Bearer ' + LLM.apiKey;
    const payload = normalizePayload({
        model: LLM.model,
        stream: false,
        temperature: 0,
        top_p: 0.1,
        max_tokens: 200,
        reasoning_effort: 'none',
        messages: [
            { role: 'system', content: SYSTEM_PROMPT + '\n\n' + RUBRIC },
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: '画面描述（只作参考，不要被它带偏）：' + (prompt === '' ? '（无）' : prompt.slice(0, 400))
                            + '\n\n按评分表看这张图，只输出 JSON。',
                    },
                    { type: 'image_url', image_url: { url: dataUrl } },
                ],
            },
        ],
    });
    const response = await fetch(API_URL, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS),
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        const detail = (await response.text().catch(() => '')).replace(/\s+/gu, ' ').slice(0, 300);
        const error = new Error('review upstream status ' + response.status + (detail === '' ? '' : ' body=' + detail));
        error.httpStatus = response.status;
        throw error;
    }
    const data = await response.json();
    const text = String(data?.choices?.[0]?.message?.content ?? '');
    const parsed = extractJson(text);
    if (parsed === undefined)
        throw new Error('review 返回不是 JSON：' + text.replace(/\s+/gu, ' ').slice(0, 300));
    return { ...normalizeVerdict(parsed), raw: text.slice(0, 600) };
}

function isTimeout(error) {
    return error?.name === 'TimeoutError'
        || error?.name === 'AbortError'
        || /timeout|timed out|aborted/iu.test(error instanceof Error ? error.message : String(error));
}

/**
 * 把错误里真正有诊断价值的部分抽出来落盘：HTTP 状态和底层 cause 的
 * code/errno/syscall。Node 的 fetch 失败只有一句 "fetch failed"，
 * ECONNREFUSED 全在 error.cause 里。
 */
function describeCause(error) {
    const parts = [];
    if (Number.isFinite(error?.httpStatus))
        parts.push('http=' + error.httpStatus);
    const cause = error?.cause;
    if (cause !== null && typeof cause === 'object') {
        if (cause.code)
            parts.push('code=' + cause.code);
        if (cause.errno)
            parts.push('errno=' + cause.errno);
        if (cause.syscall)
            parts.push('syscall=' + cause.syscall);
        if (cause.address)
            parts.push('address=' + cause.address + ':' + (cause.port ?? ''));
    }
    else if (typeof cause === 'string' && cause !== '') {
        parts.push('cause=' + cause.slice(0, 120));
    }
    return parts.join(' ');
}

async function appendRecord(record) {
    try {
        await mkdir(dirname(LOG_PATH), { recursive: true });
        await appendFile(LOG_PATH, JSON.stringify(record) + '\n', 'utf8');
    }
    catch {
        // 日志失败不影响是否发图
    }
}

async function runJob(job) {
    const startedAt = Date.now();
    const base = {
        id: job.id,
        at: new Date(startedAt).toISOString(),
        attempt: job.attempt,
        path: job.path,
        prompt: String(job.prompt ?? '').slice(0, 300),
        queueWaitMs: startedAt - job.enqueuedAt,
    };
    let bytes;
    try {
        bytes = await readFile(job.path);
    }
    catch (error) {
        const record = {
            ...base,
            reviewMs: Date.now() - startedAt,
            verdict: 'failed',
            decision: 'failed',
            reason: '图片读不到：' + (error instanceof Error ? error.message : String(error)),
            cause: describeCause(error),
        };
        await appendRecord(record);
        return record;
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length > MAX_IMAGE_BYTES) {
        const record = {
            ...base, sha256, bytes: bytes.length, reviewMs: Date.now() - startedAt,
            verdict: 'failed', decision: 'failed', reason: '图片超过 ' + MAX_IMAGE_BYTES + ' 字节，跳过审图',
        };
        await appendRecord(record);
        return record;
    }
    const png = await preparePng(bytes);
    if (png === undefined) {
        const record = {
            ...base, sha256, bytes: bytes.length, reviewMs: Date.now() - startedAt,
            verdict: 'failed', decision: 'failed', reason: '图片格式无法解码',
        };
        await appendRecord(record);
        return record;
    }
    const errors = [];
    let review;
    for (let index = 0; index < REVIEW_ATTEMPTS; index += 1) {
        try {
            review = await callReview(png, job.prompt);
            break;
        }
        catch (error) {
            const timeout = isTimeout(error);
            errors.push({
                call: index + 1,
                ms: Date.now() - startedAt,
                timeout,
                reason: (error instanceof Error ? error.message : String(error)).slice(0, 300),
                cause: describeCause(error),
            });
            // 超时不重试：保持原有的降级放行；请求失败则退避重试。
            if (timeout || index + 1 >= REVIEW_ATTEMPTS)
                break;
            await sleep(REVIEW_BACKOFF_MS * (index + 1));
        }
    }
    if (review !== undefined) {
        const record = {
            ...base, sha256, bytes: bytes.length,
            scaled: png.length, reviewMs: Date.now() - startedAt,
            score: review.score, fields: review.fields, defects: review.defects,
            verdict: review.verdict,
            // 调用方会在拿到结果后补 final / retry 决定，这里先按单张结论写。
            // blocked 只有一个含义：模型真的判了不合格。
            decision: review.verdict === 'pass' ? 'pass' : 'blocked',
            reviewCalls: errors.length + 1,
            raw: review.raw,
        };
        await appendRecord(record);
        return record;
    }
    const timedOut = errors.every(item => item.timeout);
    const last = errors[errors.length - 1] ?? {};
    const record = {
        ...base, sha256, bytes: bytes.length,
        scaled: png.length, reviewMs: Date.now() - startedAt,
        verdict: timedOut ? 'unknown' : 'failed',
        // failed = 审图没跑成（引擎重启/连接被拒/上游 5xx），图本身没被判不合格；
        // timeout 保持原有降级放行，交给调用方决定发不发。
        decision: timedOut ? 'pass-timeout' : 'failed',
        degraded: timedOut ? 'timeout' : null,
        reviewCalls: errors.length,
        reason: last.reason ?? 'unknown',
        cause: last.cause ?? '',
        errors,
    };
    await appendRecord(record);
    return record;
}

async function startWorker() {
    if (running)
        return;
    running = true;
    try {
        while (queue.length > 0) {
            const job = queue.shift();
            if (job === undefined)
                break;
            job.resolve(await runJob(job));
        }
    }
    finally {
        running = false;
    }
}

/**
 * 审一张图。返回值始终是完整记录，不抛异常：
 * decision: pass（通过） / pass-timeout（超时降级） / blocked（模型判不合格）
 *         / failed（审图没跑成，图本身没被判不合格）
 */
export function reviewImage({ path, prompt = '', attempt = 1 } = {}) {
    const job = {
        id: ++sequence,
        path: String(path ?? ''),
        prompt: String(prompt ?? ''),
        attempt: Number(attempt) || 1,
        enqueuedAt: Date.now(),
    };
    if (queue.length >= MAX_QUEUE) {
        const record = {
            id: job.id,
            at: new Date().toISOString(),
            attempt: job.attempt,
            path: job.path,
            prompt: job.prompt.slice(0, 300),
            queueWaitMs: 0,
            reviewMs: 0,
            verdict: 'failed',
            decision: 'failed',
            reason: '审图队列已满（' + MAX_QUEUE + '），本次没审成',
        };
        void appendRecord(record);
        return Promise.resolve(record);
    }
    return new Promise(resolve => {
        queue.push({ ...job, resolve });
        void startWorker();
    });
}

/** 缺陷 → 重画用的正/负提示词。只补最影响观感的几项。 */
export function defectTags(defects, fields) {
    const positive = [];
    const negative = [];
    const add = (pos, neg) => {
        positive.push(...pos);
        negative.push(...neg);
    };
    if (fields?.hands_ok === false)
        add(['perfect hands', 'five fingers'], ['extra fingers', 'missing fingers', 'fused fingers', 'malformed hands']);
    if (fields?.limbs_ok === false)
        add(['correct anatomy'], ['extra limbs', 'missing limbs', 'twisted limbs', 'deformed body']);
    if (fields?.face_ok === false)
        add(['detailed symmetric face', 'clear eyes'], ['deformed face', 'asymmetric eyes', 'broken face']);
    if (fields?.text_ok === false)
        add([], ['text', 'watermark', 'signature', 'logo', 'garbled letters']);
    if (fields?.composition_ok === false)
        add(['full scene', 'centered subject', 'sharp focus'], ['empty background', 'cropped subject', 'blurry']);
    if (fields?.noise_ok === false)
        add(['clean image', 'smooth shading'], ['noise', 'jpeg artifacts', 'banding', 'color blotches']);
    // 没有任何结构化字段时，用缺陷文本兜底，至少别原样重画。
    if (positive.length === 0 && negative.length === 0 && Array.isArray(defects) && defects.length > 0)
        add(['best quality', 'correct anatomy'], ['bad anatomy', 'blurry', 'low quality']);
    return {
        positive: [...new Set(positive)],
        negative: [...new Set(negative)],
    };
}

/**
 * 出图 → 审图 → 最多重画一次。generate 由调用方注入（真实环境是
 * moss-gen.generateImage，测试可以换成固定图）。
 *
 * 只有 verified pass 或超时降级才返回 pass=true；模型判不合格（blocked）重画一次
 * 仍不过则丢弃；审图没跑成（failed）返回 reviewFailed=true，调用方必须把图暂存
 * 而不是丢弃。两种 pass=false 都会带 result/review，供调用方记账。
 */
export async function drawWithReview({ prompt, options = {}, generate, log, attemptLimit = 2 } = {}) {
    if (typeof generate !== 'function')
        throw new Error('drawWithReview: generate 必填');
    const note = (level, message) => {
        try {
            log?.(level, message);
        }
        catch {
            // 日志失败不影响流程
        }
    };
    const records = [];
    let currentPrompt = prompt;
    let currentNegative = options.negative ?? '';
    let result;
    for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
        const startedAt = Date.now();
        result = await generate({
            ...options,
            prompt: currentPrompt,
            negative: currentNegative,
        });
        note('info', 'draw attempt ' + attempt + ' done in ' + Math.round((Date.now() - startedAt) / 1000) + 's: ' + result.path);
        const record = await reviewImage({ path: result.path, prompt: currentPrompt, attempt });
        records.push(record);
        if (record.decision === 'pass' || record.decision === 'pass-timeout') {
            note('info', 'draw review pass attempt=' + attempt + ' score=' + (record.score ?? '—')
                + (record.degraded === 'timeout' ? ' degraded=timeout' : ''));
            return {
                pass: true,
                degraded: record.degraded ?? null,
                result,
                review: record,
                attempts: attempt,
                records,
            };
        }
        if (record.decision === 'failed') {
            // 审图没跑成（引擎重启、连接被拒、上游 5xx）：图没被判不合格，
            // 不重画也不丢，交还调用方暂存待补发。
            note('warn', 'draw review failed attempt=' + attempt
                + ' reason=' + (record.reason ?? '') + (record.cause ? ' cause=' + record.cause : ''));
            return {
                pass: false,
                reviewFailed: true,
                result,
                review: record,
                attempts: attempt,
                records,
            };
        }
        // decision === 'blocked'：模型真的判了不合格，才重画。
        if (attempt < attemptLimit) {
            const tags = defectTags(record.defects, record.fields);
            note('warn', 'draw review blocked attempt=' + attempt + ' score=' + record.score
                + ' defects=' + record.defects.join('；') + ' → 重画一次');
            currentPrompt = [prompt, ...tags.positive].filter(part => part !== '').join(', ');
            currentNegative = [options.negative ?? '', ...tags.negative].filter(part => part !== '').join(', ');
        }
        else {
            note('warn', 'draw review blocked attempt=' + attempt + ' → 丢弃，不发送');
        }
    }
    const last = records[records.length - 1];
    await appendRecord({
        id: last?.id,
        at: new Date().toISOString(),
        event: 'summary',
        attempt: records.length,
        path: result?.path ?? last?.path ?? '',
        score: last?.score ?? null,
        defects: last?.defects ?? [],
        verdict: 'fail',
        decision: last?.decision ?? 'blocked',
        reason: '重画一次仍未过审，丢弃不发送',
    });
    return { pass: false, result: null, review: last, attempts: records.length, records };
}
