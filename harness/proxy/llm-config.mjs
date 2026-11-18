/**
 * 统一 LLM 后端配置（OpenAI 兼容端点）。
 *
 * 优先级：环境变量 > llm-backend.json > 内置默认值。
 * 默认值对应本机 ninfer 引擎；端口、模型名、超时都只在这里出现，
 * 业务代码（proxy / vision / moss-gen）不再写死。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.QQ_PROXY_ROOT ?? HERE;
const CONFIG_PATH = process.env.QQ_LLM_CONFIG ?? join(ROOT, 'llm-backend.json');

function readConfigFile() {
    try {
        const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    }
    catch {
        return {};
    }
}

const file = readConfigFile();

function envText(name) {
    const value = process.env[name];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function fileText(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function envBool(name) {
    const value = envText(name);
    if (value === undefined)
        return undefined;
    return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
}

function fileBool(value) {
    return typeof value === 'boolean' ? value : undefined;
}

function numberFrom(...values) {
    for (const value of values) {
        if (value === undefined || value === null || value === '')
            continue;
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0)
            return parsed;
    }
    return undefined;
}

function resolveBaseUrl() {
    // 兼容旧测试脚本：它们只改 QQ_PROXY_UPSTREAM_HOST/PORT。
    const explicit = envText('QQ_LLM_BASE_URL') ?? fileText(file.baseUrl);
    if (explicit !== undefined)
        return explicit;
    const host = envText('QQ_PROXY_UPSTREAM_HOST') ?? '127.0.0.1';
    const port = envText('QQ_PROXY_UPSTREAM_PORT') ?? '8094';
    return `http://${host}:${port}/v1`;
}

const baseUrl = resolveBaseUrl().replace(/\/+$/u, '');
let parsedUrl;
try {
    parsedUrl = new URL(baseUrl);
}
catch {
    throw new Error('llm-backend.json: baseUrl 不是合法 URL: ' + baseUrl);
}

const engineControlFile = file.engineControl && typeof file.engineControl === 'object' ? file.engineControl : {};

export const LLM = Object.freeze({
    engine: envText('QQ_LLM_ENGINE') ?? fileText(file.engine) ?? 'ninfer',
    baseUrl,
    protocol: parsedUrl.protocol,
    host: parsedUrl.hostname,
    port: Number(parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80)),
    basePath: parsedUrl.pathname.replace(/\/+$/u, ''),
    apiKey: envText('QQ_LLM_API_KEY') ?? fileText(file.apiKey) ?? '',
    model: envText('QQ_LLM_MODEL') ?? fileText(file.model) ?? 'bonsai-2-27b',
    healthPath: envText('QQ_LLM_HEALTH_PATH') ?? fileText(file.healthPath) ?? '/v1/models',
    forwardClientAuth: envBool('QQ_LLM_FORWARD_CLIENT_AUTH') ?? fileBool(file.forwardClientAuth) ?? false,
    supportsChatTemplateKwargs: envBool('QQ_LLM_CHAT_TEMPLATE_KWARGS')
        ?? fileBool(file.supportsChatTemplateKwargs)
        ?? false,
    supportsVision: envBool('QQ_LLM_VISION')
        ?? fileBool(file.supportsVision)
        ?? true,
    requestTimeoutMs: numberFrom(envText('QQ_LLM_TIMEOUT_MS'), file.requestTimeoutMs, 300_000),
    analyzeTimeoutMs: numberFrom(envText('QQ_LLM_ANALYZE_TIMEOUT_MS'), file.analyzeTimeoutMs, 5_000),
    reviewTimeoutMs: numberFrom(envText('QQ_LLM_REVIEW_TIMEOUT_MS'), file.reviewTimeoutMs, 120_000),
    visionTimeoutMs: numberFrom(envText('QQ_LLM_VISION_TIMEOUT_MS'), file.visionTimeoutMs, 20_000),
    maxTokens: numberFrom(envText('QQ_MAX_TOKENS'), file.maxTokens, 1_024),
    // 分析腿单独的预算：只输出一行 JSON，不能和回复共用 1024。
    analyzeMaxTokens: numberFrom(envText('QQ_LLM_ANALYZE_MAX_TOKENS'), file.analyzeMaxTokens, 160),
    // 回复腿的历史预算（token，不是字符）：中文 1 字符≈1 token，按字符算会
    // 把 11k 字当成 11k token 以下的量，实际接近窗口上限。预算按 token 估，
    // 再由 proxy 的整窗兜底保证 system+历史+工具+输出不顶穿 contextWindowTokens。
    budgetTokens: numberFrom(envText('QQ_LLM_BUDGET_TOKENS'), file.budgetTokens, 8_000),
    replyHistoryMessages: numberFrom(envText('QQ_LLM_REPLY_HISTORY_MESSAGES'), file.replyHistoryMessages, 40),
    // 引擎的上下文窗口；32768 是 ninfer 当前配置，换模型时改这里。
    contextWindowTokens: numberFrom(envText('QQ_LLM_CONTEXT_WINDOW_TOKENS'), file.contextWindowTokens, 32_768),
    // prompt 超过这个 token 数就不跑分析腿：再叠一份 KV 只会把自己挤爆。
    analyzeMaxPromptTokens: numberFrom(envText('QQ_LLM_ANALYZE_MAX_PROMPT_TOKENS'), file.analyzeMaxPromptTokens, 6_000),
    engineControl: Object.freeze({
        mode: engineControlFile.mode ?? 'external',
        startCommand: engineControlFile.startCommand ?? '',
        startArguments: Array.isArray(engineControlFile.startArguments) ? engineControlFile.startArguments : [],
        startWorkingDirectory: engineControlFile.startWorkingDirectory ?? '',
        startLogPath: engineControlFile.startLogPath ?? '',
        startEnv: engineControlFile.startEnv && typeof engineControlFile.startEnv === 'object' ? engineControlFile.startEnv : {},
        stopCommand: engineControlFile.stopCommand ?? '',
        stopArguments: Array.isArray(engineControlFile.stopArguments) ? engineControlFile.stopArguments : [],
        stopWorkingDirectory: engineControlFile.stopWorkingDirectory ?? '',
        stopProcess: engineControlFile.stopProcess ?? 'ninfer-serve-*.exe',
        // 引擎卸载/恢复的唯一入口（engine-control.ps1）；配了它就不再直连 stop-ninfer.ps1。
        controlScript: engineControlFile.controlScript ?? '',
        controlWorkingDirectory: engineControlFile.controlWorkingDirectory ?? '',
        restoreLogPath: engineControlFile.restoreLogPath ?? '',
        healthUrl: engineControlFile.healthUrl ?? '',
        readyTimeoutMs: numberFrom(engineControlFile.readyTimeoutMs, 600_000),
        stopWaitMs: numberFrom(engineControlFile.stopWaitMs, 30_000),
        allowConcurrent: engineControlFile.allowConcurrent === true,
    }),
});

/**
 * 窗口 / 历史 / 分析腿预算的唯一计算处。
 * proxy、影子插件都只引用这里，不再各自写死数字或比例。
 */
export const BUDGET = Object.freeze({
    contextWindowTokens: LLM.contextWindowTokens,
    // 回复腿历史预算（token）。
    replyHistoryTokens: LLM.budgetTokens,
    replyHistoryMessages: LLM.replyHistoryMessages,
    // DSH 侧请求历史的裁剪预算；环境变量/配置文件可覆盖，默认 12000。
    dshHistoryTokens: numberFrom(envText('QQ_DSH_HISTORY_TOKENS'), file.dshHistoryTokens, 12_000),
    // 语义解析腿：至少 analyzeMaxPromptTokens，且不少于窗口的这个比例。
    analyzePromptRatio: 0.6,
    outputReserveTokens: LLM.maxTokens + LLM.analyzeMaxTokens,
});

/** 解析腿允许的 prompt 上限（保留 40% 窗口给回复腿）。 */
export const ANALYSIS_PROMPT_BUDGET = Math.max(
    LLM.analyzeMaxPromptTokens,
    Math.floor(BUDGET.contextWindowTokens * BUDGET.analyzePromptRatio),
);

function stripImageParts(messages) {
    if (!Array.isArray(messages))
        return;
    for (const message of messages) {
        if (!Array.isArray(message?.content))
            continue;
        const next = [];
        for (const part of message.content) {
            const type = typeof part?.type === 'string' ? part.type : '';
            const isImage = type === 'image' || type === 'image_url' || type === 'input_image'
                || part?.image_url !== undefined || part?.source?.type === 'base64';
            next.push(isImage ? { type: 'text', text: '[图片]' } : part);
        }
        message.content = next;
    }
}

/** 客户端请求里的 model 一律映射到后端真实模型名。 */
export function normalizePayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return payload;
    payload.model = LLM.model;
    // chat_template_kwargs 是 llama.cpp/LM Studio 扩展，ninfer 不认就删掉，
    // 避免上游 400。是否保留由配置决定。
    if (!LLM.supportsChatTemplateKwargs)
        delete payload.chat_template_kwargs;
    // 引擎没开 vision 时，任何路径（QQ、桌面、review）都不能把图片 part
    // 发给上游，否则整轮 400。统一降级成文字占位。
    if (!LLM.supportsVision)
        stripImageParts(payload.messages);
    return payload;
}

/** 把客户端路径映射到 baseUrl 自带的路径前缀下。 */
export function upstreamPath(path) {
    const value = typeof path === 'string' && path !== '' ? path : '/';
    const suffixIndex = value.indexOf('?');
    const pathname = suffixIndex === -1 ? value : value.slice(0, suffixIndex);
    const search = suffixIndex === -1 ? '' : value.slice(suffixIndex);
    if (LLM.basePath === '')
        return value;
    if (pathname === LLM.basePath || pathname.startsWith(LLM.basePath + '/'))
        return value;
    if (pathname === '/v1' || pathname.startsWith('/v1/'))
        return LLM.basePath + pathname.slice('/v1'.length) + search;
    return LLM.basePath + (pathname.startsWith('/') ? pathname : '/' + pathname) + search;
}

export function chatCompletionsPath() {
    return upstreamPath('/v1/chat/completions');
}

export function healthUrl() {
    const control = LLM.engineControl.healthUrl;
    if (typeof control === 'string' && control !== '')
        return control;
    // healthPath 是相对站点根目录的绝对路径（例如 /v1/models），
    // 不能直接拼在已经带 /v1 的 baseUrl 后面。
    if (LLM.healthPath.startsWith('/'))
        return parsedUrl.origin + LLM.healthPath;
    return LLM.baseUrl + '/' + LLM.healthPath;
}

export const CONFIG_SOURCE = {
    path: CONFIG_PATH,
    exists: Object.keys(file).length > 0,
};
