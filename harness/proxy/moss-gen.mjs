/**
 * MOSS 出图编排。
 *
 * 参考工作流是 `E:\ComfyUI\user\default\workflows\MOSS 全功能整合.json`，
 * 那个文件只读、不修改；这里用同一套模型/权重单独拼一份 API 格式的图：
 *
 *   UNET(int8 SFT) → AuraFlow shift 5 → 细节/质量/年龄/胸部/体重/光照滑块
 *   → 风格 LoRA → 8 步 DMD LoRA → SkipLayerGuidance → KSampler 8 步
 *   CLIP(qwen3.5 9b int8, type=moss_image) → 正/负提示词
 *   flux2 VAE → SaveImage
 *
 * 显存只有 16GB，聊天模型和 MOSS 不能同时驻留，所以整个流程是：
 *   拿租约 → 确保 ComfyUI → 释放聊天模型 → 提交 → 取图 → 释放 ComfyUI 显存
 *   → 恢复聊天模型 → 放租约
 * 无论中间哪一步失败，finally 都会尽量把聊天模型装回来。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLease, releaseLease } from './gpu-lease.mjs';
import { releaseChatEngine, restoreChatEngine, chatEngineResident } from './engine-control.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const COMFY_HOST = '127.0.0.1';
const COMFY_PORT = 8188;
const COMFY_OUTPUT = 'E:\\ComfyUI\\output';

const COMBO = 'moss\\';
const MODELS = {
    unet: COMBO + 'moss_image_sft_int8_convrot.safetensors',
    clip: COMBO + 'qwen3.5_9b_int8_convrot.safetensors',
    vae: COMBO + 'flux2-vae.safetensors',
    dmd: COMBO + '加速\\02-8步加速当前.safetensors',
};

const SLIDERS = {
    detail: { file: COMBO + '滑块\\01-细节.safetensors', value: 0.2, label: '细节' },
    quality: { file: COMBO + '滑块\\02-质量.safetensors', value: 0.25, label: '质量' },
    age: { file: COMBO + '滑块\\03-年龄.safetensors', value: -1.0, label: '年龄' },
    chest: { file: COMBO + '滑块\\04-胸部.safetensors', value: -2.4, label: '胸部' },
    weight: { file: COMBO + '滑块\\05-体重.safetensors', value: -1.5, label: '体重' },
    light: { file: COMBO + '滑块\\06-光照.safetensors', value: 0.5, label: '光照' },
};

/** 风格 LoRA：键是给模型看的中文名，值是参考工作流里的权重文件。 */
export const STYLES = {
    '动漫写实': COMBO + '风格\\01-Anireal动漫写实.safetensors',
    'BunnySlop': COMBO + '风格\\02-BunnySlop.safetensors',
    'Kzmynon': COMBO + '风格\\03-Kzmynon.safetensors',
    '鬼针草v2': COMBO + '风格\\04-鬼针草v2.safetensors',
    'Silvana': COMBO + '风格\\05-Silvana.safetensors',
    'ningenmame': COMBO + '风格\\06-ningenmame.safetensors',
    'cunnyfunky': COMBO + '风格\\07-cunnyfunky.safetensors',
    '厚涂2.5D': COMBO + '风格\\08-厚涂2.5D.safetensors',
    '奶蛙': COMBO + '风格\\09-奶蛙.safetensors',
    '赛璐珞': COMBO + '风格\\10-赛璐珞.safetensors',
    '鬼针草Anima': COMBO + '风格\\11-鬼针草Anima.safetensors',
    'shionnnk': COMBO + '风格\\12-shionnnk.safetensors',
    '鲸鱼娘': COMBO + '风格\\13-鲸鱼娘.safetensors',
};

const DEFAULT_NEGATIVE = 'worst quality, bad anatomy, watermark, jpeg artifact, blurry, lowres';
const ASPECT_RATIOS = {
    '1:1': [1, 1],
    '2:3': [2, 3],
    '3:2': [3, 2],
    '3:4': [3, 4],
    '4:3': [4, 3],
    '9:16': [9, 16],
    '16:9': [16, 9],
    '21:9': [21, 9],
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function logWith(logger, level, message) {
    try {
        logger?.(level, message);
    }
    catch {
        // logging must never break generation
    }
}

/** 按参考工作流的 ResolutionSelector 公式算尺寸（1MP ≈ 1024×1024）。 */
export function resolutionFor(aspect, megapixels) {
    const pair = ASPECT_RATIOS[aspect] ?? ASPECT_RATIOS['1:1'];
    const mp = Math.min(2.0, Math.max(0.4, Number(megapixels) || 1.0));
    const scale = Math.sqrt((mp * 1024 * 1024) / (pair[0] * pair[1]));
    const round8 = value => Math.max(64, Math.round(value / 8) * 8);
    return { width: round8(pair[0] * scale), height: round8(pair[1] * scale) };
}

function buildWorkflow(options) {
    // 只走 8 步加速线：50 步收益很小、还容易把一次 QQ 回复拖到两三分钟。
    // 想要细节/质感就调 LoRA 滑块与风格，而不是换采样线。
    const steps = 8;
    const seed = Number.isFinite(Number(options.seed)) && Number(options.seed) > 0
        ? Math.floor(Number(options.seed))
        : Math.floor(Math.random() * 1e15);
    const styleFile = options.style === '无' ? undefined : (STYLES[options.style] ?? STYLES['动漫写实']);
    const positive = ('best quality, highres, ' + String(options.prompt ?? '')).trim();
    const negative = String(options.negative ?? '').trim() || DEFAULT_NEGATIVE;
    const { width, height } = resolutionFor(options.aspect, options.megapixels);
    const workflow = {
        '13': { class_type: 'UNETLoader', inputs: { unet_name: MODELS.unet, weight_dtype: 'default' } },
        '1328': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['13', 0], shift: 5.0, sampling: 'flow' } },
        '2': { class_type: 'CLIPLoader', inputs: { clip_name: MODELS.clip, type: 'moss_image', device: 'default' } },
        '4': { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['2', 0] } },
        '5': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['2', 0] } },
        '7': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
        '3': { class_type: 'VAELoader', inputs: { vae_name: MODELS.vae } },
        '1311': {
            class_type: 'KSampler',
            inputs: {
                model: ['1529', 0], seed, steps,
                cfg: 1.0,
                sampler_name: 'euler', scheduler: 'simple',
                positive: ['4', 0], negative: ['5', 0], latent_image: ['7', 0], denoise: 1.0,
            },
        },
        '1312': { class_type: 'VAEDecode', inputs: { samples: ['1311', 0], vae: ['3', 0] } },
        '1313': { class_type: 'SaveImage', inputs: { images: ['1312', 0], filename_prefix: 'qq_draw_' + Date.now() } },
    };
    // 滑块链：按参考工作流的默认值，detail/quality/light 可由调用方覆盖。
    const clamp = (value, min, max, fallback) => {
        const number = Number(value);
        if (!Number.isFinite(number))
            return fallback;
        return Math.min(max, Math.max(min, number));
    };
    let previous = '1328';
    const sliders = [
        ['20', SLIDERS.detail.file, clamp(options.detail, -0.75, 0.75, SLIDERS.detail.value)],
        ['21', SLIDERS.quality.file, clamp(options.quality, 0, 1, SLIDERS.quality.value)],
        ['22', SLIDERS.age.file, SLIDERS.age.value],
        ['23', SLIDERS.chest.file, SLIDERS.chest.value],
        ['24', SLIDERS.weight.file, SLIDERS.weight.value],
        ['25', SLIDERS.light.file, clamp(options.light, 0, 1, SLIDERS.light.value)],
    ];
    for (const [id, lora, strength] of sliders) {
        workflow[id] = { class_type: 'LoraLoaderModelOnly', inputs: { model: [previous, 0], lora_name: lora, strength_model: strength } };
        previous = id;
    }
    if (styleFile !== undefined) {
        workflow['26'] = { class_type: 'LoraLoaderModelOnly', inputs: { model: [previous, 0], lora_name: styleFile, strength_model: 0.7 } };
        previous = '26';
    }
    workflow['27'] = { class_type: 'LoraLoaderModelOnly', inputs: { model: [previous, 0], lora_name: MODELS.dmd, strength_model: 0.7 } };
    previous = '27';
    workflow['1529'] = {
        class_type: 'SkipLayerGuidanceDiTSimple',
        inputs: { model: [previous, 0], double_layers: '', single_layers: '22', start_percent: 0.0, end_percent: 0.5 },
    };
    return { workflow, seed, steps, width, height, style: styleFile === undefined ? '无' : (options.style ?? '动漫写实'), positive, negative };
}

async function comfyUp() {
    try {
        const response = await fetch(`http://${COMFY_HOST}:${COMFY_PORT}/system_stats`, { signal: AbortSignal.timeout(2000) });
        return response.ok;
    }
    catch {
        return false;
    }
}

const BROKER_URL = 'http://127.0.0.1:1240';

// ComfyUI 熔断状态：一次失败就停手，冷却后最多再试一次，避免每个出图请求都去拉一遍进程。
const COMFY_BREAKER = join(ROOT, 'comfy-breaker.json');
const COMFY_COOLDOWN_MS = 5 * 60_000;
const COMFY_COOLDOWN_MAX_MS = 15 * 60_000;

function readComfyBreaker() {
    try {
        return JSON.parse(readFileSync(COMFY_BREAKER, 'utf8'));
    }
    catch {
        return {};
    }
}

function writeComfyBreaker(state) {
    try {
        writeFileSync(COMFY_BREAKER, JSON.stringify(state, null, 2), 'utf8');
    }
    catch {
        // 状态写不进去只会退化成每次重试，不影响出图
    }
}

function clearComfyBreaker() {
    const state = readComfyBreaker();
    if (Number(state.failures) > 0 || state.cooldownUntil !== undefined)
        writeComfyBreaker({ failures: 0, clearedAt: new Date().toISOString() });
}

async function ensureComfy(logger) {
    if (await comfyUp()) {
        clearComfyBreaker();
        return;
    }
    const now = Date.now();
    const breaker = readComfyBreaker();
    const failures = Number(breaker.failures) || 0;
    const cooldownUntil = Number(breaker.cooldownUntil) || 0;
    if (cooldownUntil > now) {
        const leftSec = Math.ceil((cooldownUntil - now) / 1000);
        logWith(logger, 'warn', `ComfyUI 冷却中，跳过启动（剩 ${leftSec} 秒，上次失败：${String(breaker.lastError ?? '未知')}）`);
        throw new Error(`ComfyUI 刚启动失败过，${Math.ceil(leftSec / 60)} 分钟内不再重试`);
    }
    // 先记账再发起启动：即使这次请求中途被打断/进程被杀，下一次请求也不会立刻再拉一遍。
    const nextFailures = failures + 1;
    const cooldownMs = Math.min(COMFY_COOLDOWN_MAX_MS, COMFY_COOLDOWN_MS * 2 ** Math.max(0, nextFailures - 1));
    const attemptAt = new Date(now).toISOString();
    writeComfyBreaker({
        failures: nextFailures,
        lastAttemptAt: attemptAt,
        cooldownUntil: now + cooldownMs,
        lastError: '启动中',
    });
    // 不要在 DSH 的 workspace-write 沙箱里直接 spawn：ComfyUI 会继承限制，
    // 读 F:\ 的模型会报 read_file_slice failed，写 E:\ComfyUI\output 会报
    // Permission denied。改由沙箱外的 persona proxy 拉起。
    logWith(logger, 'info', 'ComfyUI 未运行，请求 proxy 在沙箱外启动（本轮只试这一次）');
    let reason = '';
    try {
        const response = await fetch(BROKER_URL + '/comfy/ensure', {
            method: 'POST',
            signal: AbortSignal.timeout(100_000),
        });
        const result = await response.json().catch(() => ({}));
        if (result?.ok === true && await comfyUp()) {
            clearComfyBreaker();
            logWith(logger, 'info', 'ComfyUI ready（由 proxy 启动）');
            return;
        }
        reason = String(result?.error ?? ('HTTP ' + response.status));
    }
    catch (error) {
        reason = error instanceof Error ? error.message : String(error);
    }
    writeComfyBreaker({
        failures: nextFailures,
        lastAttemptAt: attemptAt,
        cooldownUntil: Date.now() + cooldownMs,
        lastError: reason.slice(0, 200),
    });
    logWith(logger, 'warn', `ComfyUI 启动失败，停止重试 ${Math.ceil(cooldownMs / 60_000)} 分钟：${reason}`);
    throw new Error(`ComfyUI 没起来（${reason}），${Math.ceil(cooldownMs / 60_000)} 分钟内不再重试`);
}

/** 出图后把图像模型从显存里放掉：ComfyUI 常驻，显存不能跟着常驻。
 * 只卸模型、不关进程——下一次出图重新加载权重（几秒），省掉几十秒的进程冷启动。 */
async function freeComfyVram(logger, label) {
    try {
        const response = await fetch(`http://${COMFY_HOST}:${COMFY_PORT}/free`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ unload_models: true, free_memory: true }),
            signal: AbortSignal.timeout(10_000),
        });
        logWith(logger, 'info', `ComfyUI /free (${label}) status=${response.status}`);
        return response.ok;
    }
    catch (error) {
        // ComfyUI 已经退出也无所谓，聊天模型照样要装回来
        logWith(logger, 'warn', 'ComfyUI /free failed: ' + String(error));
        return false;
    }
}

async function queueHasPrompt(promptId) {
    try {
        const queue = await (await fetch(`http://${COMFY_HOST}:${COMFY_PORT}/queue`, { signal: AbortSignal.timeout(5000) })).json();
        const lists = [queue?.queue_running, queue?.queue_pending].filter(Array.isArray);
        return lists.some(list => list.some(item => Array.isArray(item) && item.includes(promptId)));
    }
    catch {
        return true; // 查询失败时不要误判为任务丢失
    }
}

/** 队列里是否有别人的任务。QQ 出图是直接提交的，如果这时 ComfyUI 正在跑
 * 别的东西（比如 H3 长视频），两边会一起抢 16GB 显存，轻则排队几十分钟，
 * 重则把整个 ComfyUI 进程弄崩。先礼让，让调用方回一句稍后再画。 */
async function comfyQueueBusy() {
    try {
        const queue = await (await fetch(`http://${COMFY_HOST}:${COMFY_PORT}/queue`, { signal: AbortSignal.timeout(5_000) })).json();
        const running = Array.isArray(queue?.queue_running) ? queue.queue_running.length : 0;
        const pending = Array.isArray(queue?.queue_pending) ? queue.queue_pending.length : 0;
        return running + pending > 0;
    }
    catch {
        return false;
    }
}

async function submitAndWait(workflow, logger, timeoutMs = 180_000) {
    const clientId = randomUUID();
    const response = await fetch(`http://${COMFY_HOST}:${COMFY_PORT}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: clientId }),
        signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.prompt_id === undefined) {
        const detail = body?.error?.message ?? JSON.stringify(body?.node_errors ?? body).slice(0, 400);
        throw new Error('ComfyUI 拒绝了工作流：' + detail);
    }
    const promptId = body.prompt_id;
    const deadline = Date.now() + timeoutMs;
    let missing = 0;
    while (Date.now() < deadline) {
        await sleep(1500);
        let history;
        for (let attempt = 0; attempt < 3 && history === undefined; attempt += 1) {
            try {
                history = await (await fetch(`http://${COMFY_HOST}:${COMFY_PORT}/history/${promptId}`, { signal: AbortSignal.timeout(10_000) })).json();
            }
            catch {
                await sleep(700);
            }
        }
        if (history === undefined)
            throw new Error('ComfyUI 在处理时崩溃了（显存被其他任务抢占时常见），等它恢复后再画');
        const entry = history?.[promptId];
        if (entry !== undefined) {
            const status = entry.status ?? {};
            if (status.status_str === 'error') {
                const messages = (status.messages ?? [])
                    .map(item => Array.isArray(item) ? item[1]?.message ?? item[0] : String(item))
                    .filter(Boolean)
                    .join('; ');
                throw new Error('MOSS 生成失败：' + (messages || '未知错误').slice(0, 400));
            }
            const image = entry.outputs?.['1313']?.images?.[0];
            if (image !== undefined)
                return { promptId, image };
            continue;
        }
        // 历史里没有：确认任务还在队列里，连续几次都不在就认为丢了。
        if (await queueHasPrompt(promptId)) {
            missing = 0;
        }
        else {
            missing += 1;
            if (missing >= 3)
                throw new Error('任务从 ComfyUI 队列里消失了（进程可能崩溃）');
        }
    }
    // 超时：先把任务打断，避免它继续占着显存，后面还要装回聊天模型。
    await fetch(`http://${COMFY_HOST}:${COMFY_PORT}/interrupt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5000),
    }).catch(() => {});
    throw new Error('MOSS 生成超时（' + Math.round(timeoutMs / 1000) + 's）');
}

/**
 * 生成一张图并返回本地路径。所有显存切换都在这里闭环。
 * @returns {{path: string, width: number, height: number, seed: number, seconds: number, steps: number, style: string, aspect: string}}
 */
export async function generateImage(options = {}) {
    const logger = typeof options.log === 'function' ? options.log : undefined;
    // 图一落盘就回调（在 finally 之前）：这一轮若被 interrupted，结果也不会丢。
    const onImage = typeof options.onImage === 'function' ? options.onImage : undefined;
    const prompt = String(options.prompt ?? '').trim();
    if (prompt === '')
        throw new Error('画面描述不能为空');
    if (prompt.length > 1200)
        throw new Error('画面描述太长（最多 1200 字符）');
    const aspect = Object.hasOwn(ASPECT_RATIOS, options.aspect) ? options.aspect : '1:1';
    const mediaDir = String(options.mediaDir ?? 'Y:\\dsh\\home\\qq-persona\\media\\draw');
    // 先确认 ComfyUI 真的能起来，再拿租约。租约的含义从此是「机器已就绪、
    // 正在出图」，不再是「我想画」：起不来就不占位，也不对外说在画图。
    await ensureComfy(logger);
    if (await comfyQueueBusy())
        throw new Error('ComfyUI 正在跑别的任务（可能是长视频），等它跑完再画');
    const lease = await acquireLease({ owner: 'qq_draw', reason: 'MOSS 出图', ttlMs: 15 * 60_000 });
    if (!lease.ok) {
        const busy = lease.lease?.reason ? '（' + lease.lease.reason + '）' : '';
        throw new Error('显卡正在被占用' + busy + '，等这次结束再画');
    }
    const startedAt = Date.now();
    const built = buildWorkflow({ ...options, aspect });
    // 真正开始出图时通知调用方（工具侧据此在群里说一句「在画图」）。
    const onReady = typeof options.onReady === 'function' ? options.onReady : undefined;
    let outcome;
    let restored = false;
    let guard;
    let switched = false;
    let submitted = false;
    try {
        switched = true;
        try {
            onReady?.();
        }
        catch {
            // 提示发不出去不影响出图
        }
        const engineRelease = await releaseChatEngine(logger);
        switched = engineRelease.released;
        // 兜底：如果有请求绕过租约让引擎又把聊天模型冷加载回来，
        // 生成期间每 10 秒检查一次并重新释放，绝不让两个模型同时占显存。
        guard = setInterval(() => {
            try {
                if (chatEngineResident()) {
                    logWith(logger, 'warn', 'chat model reappeared during generation; releasing again');
                    releaseChatEngine(logger).catch(() => {});
                }
            }
            catch {
                // 检查失败不影响生成
            }
        }, 10_000);
        guard.unref?.();
        logWith(logger, 'info', `MOSS submit ${built.width}x${built.height} steps=${built.steps} seed=${built.seed}`);
        submitted = true;
        const { image } = await submitAndWait(built.workflow, logger, 180_000);
        const source = join(COMFY_OUTPUT, image.subfolder ?? '', image.filename);
        const info = await stat(source);
        if (info.size <= 0)
            throw new Error('生成的图片是空文件');
        await mkdir(mediaDir, { recursive: true });
        const target = join(mediaDir, 'draw_' + Date.now() + '_' + built.seed + '.png');
        await copyFile(source, target);
        outcome = {
            path: target,
            width: built.width,
            height: built.height,
            seed: built.seed,
            steps: built.steps,
            style: built.style,
            aspect,
            seconds: Math.round((Date.now() - startedAt) / 1000),
            bytes: info.size,
        };
        try {
            onImage?.(outcome);
        }
        catch {
            // 记账失败不影响出图
        }
    }
    finally {
        if (guard !== undefined)
            clearInterval(guard);
        // 只要这一轮真的提交过工作流（成功/失败都算），就把图像模型卸掉：
        // ComfyUI 常驻，显存不能常驻。先 /free 再装回聊天模型，避免两边抢显存。
        // 队列里有别人的任务、或还没提交就提前退出时，不碰对方的显存。
        if (submitted) {
            try {
                await freeComfyVram(logger, 'after draw');
            }
            catch (error) {
                logWith(logger, 'warn', 'ComfyUI free failed: ' + String(error));
            }
        }
        if (switched) {
            // 无论如何都要把聊天模型装回来，否则 bot 自己就没法说话了。
            restored = await restoreChatEngine(logger);
            if (!restored) {
                // 恢复失败一次就立刻重试：引擎没装回=bot 静默，不能等下一次出图才发现。
                logWith(logger, 'warn', 'chat model reload failed; retrying once in 3s');
                await sleep(3000);
                restored = await restoreChatEngine(logger);
            }
            if (!restored)
                logWith(logger, 'error', 'chat model reload FAILED after image generation');
        }
        await releaseLease(lease.lease.id);
    }
    if (outcome !== undefined)
        outcome.restored = restored;
    return outcome;
}

export const __internal = { buildWorkflow, resolutionFor, STYLES };
