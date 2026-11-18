/**
 * 「问主人」闸门：私聊里允许小助手向主人提一个问题，但门槛全在代码里判，
 * 不靠提示词自觉。每次尝试（放行或拒绝）都落一行 asks.jsonl，这是以后调门槛的
 * 唯一依据。
 *
 * 规则（任一不满足即拒）：
 * - 只在私聊；群聊由 proxy 侧的 QQ_HOST_TOOL_PRIVATE_ONLY / denyHostTool 拦，这里再判一次。
 * - 每小时最多 1 次、每天最多 2 次。
 * - 必须带 checked：声明已查过梗库/记忆/全站搜索且都为空；空或缺失视为没查。
 * - 必须带 hypothesis：要能看出「猜什么、凭什么」，不能只有一句「这是什么」。
 * - 同一话题 7 天内不重复问（话题按归一化关键词的重合度判，不做原文匹配）。
 * - 被忽略（问过 48h 仍未回答）达 3 次的话题永久降权，不再问。
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.env.QQ_PROXY_ROOT ?? 'Y:\\dsh\\home\\qq-persona';
export const ASKS_PATH = join(ROOT, 'asks.jsonl');

export const ASK_MASTER_TOOL = 'qq_ask_master';
const DAILY_LIMIT = 2;
const HOURLY_LIMIT = 1;
const TOPIC_WINDOW_MS = 7 * 24 * 3600_000;
/** 超过这个时长还没被回答，就算「被忽略」。 */
const IGNORED_AFTER_MS = 48 * 3600_000;
const IGNORED_LIMIT = 3;
const SIMILARITY = 0.5;
const HYPOTHESIS_MARKERS = ['因为', '由于', '估计', '可能', '应该', '大概', '也许', '怀疑', 'because', 'probably'];

const CJK_RE = /[\u4e00-\u9fff]+/gu;
/** 泛问词不进话题键，否则「这是什么」和「那是什么」会被当成同一个话题。 */
const STOP_BIGRAMS = new Set([
    '什么', '怎么', '这个', '那个', '可以', '为什', '么样', '是不', '不是', '我们',
    '你们', '他们', '一个', '现在', '然后', '还是', '就是', '没有', '知道', '时候',
    '东西', '事情', '为什', '是否', '为何',
]);
const STOP_WORDS = new Set(['the', 'and', 'what', 'why', 'how', 'that', 'this', 'you', 'your']);

/** 归一化关键词：中文取二元组、英文取长度≥3 的词，丢掉泛问词。 */
export function topicTokens(text) {
    const lower = String(text ?? '').toLowerCase();
    const tokens = new Set();
    for (const run of lower.match(CJK_RE) ?? []) {
        if (run.length < 2)
            continue;
        for (let index = 0; index + 1 < run.length; index += 1) {
            const bigram = run.slice(index, index + 2);
            if (!STOP_BIGRAMS.has(bigram))
                tokens.add(bigram);
        }
    }
    for (const word of lower.split(/[^a-z0-9]+/u)) {
        if (word.length >= 3 && !STOP_WORDS.has(word))
            tokens.add(word);
    }
    return tokens;
}

function topicKeyOf(tokens) {
    return [...tokens].sort().slice(0, 12).join(',');
}

/** 重合度用「交集 / 较小集合」，短问题和长假设之间也能判同话题。 */
export function topicSimilarity(a, b) {
    if (a.size === 0 || b.size === 0)
        return 0;
    let shared = 0;
    for (const token of a) {
        if (b.has(token))
            shared += 1;
    }
    return shared / Math.min(a.size, b.size);
}

export function readAsks() {
    try {
        return readFileSync(ASKS_PATH, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map(line => {
                try { return JSON.parse(line); }
                catch { return null; }
            })
            .filter(entry => entry !== null && typeof entry === 'object');
    }
    catch {
        return [];
    }
}

function appendAsk(entry) {
    try {
        appendFileSync(ASKS_PATH, JSON.stringify(entry) + '\n', 'utf8');
    }
    catch { /* 审计写不进去也不能拦回话 */ }
}

function textField(value) {
    if (typeof value === 'string')
        return value.trim();
    if (Array.isArray(value))
        return value.filter(item => typeof item === 'string' && item.trim() !== '').join('；').trim();
    return '';
}

/**
 * 判定一次提问。
 * @returns {{ok:boolean, reason:string, detail:string, topicKey:string, entry:object}}
 */
export function evaluateAsk({ args, ctx, now = Date.now() }) {
    const question = textField(args?.question ?? args?.q);
    const hypothesis = textField(args?.hypothesis);
    const checked = textField(args?.checked);
    const chatKind = String(ctx?.chatKind ?? '');
    const chatId = String(ctx?.chatId ?? '');
    const tokens = topicTokens(question + ' ' + hypothesis);
    const topicKey = topicKeyOf(tokens);
    const history = readAsks();
    const asked = history.filter(entry => entry?.status === 'asked' && typeof entry?.askedAt === 'number');

    const entry = {
        askedAt: now,
        at: new Date(now).toISOString(),
        chat: chatId,
        kind: chatKind,
        question,
        hypothesis,
        checked,
        topicKey,
        answered: false,
        status: 'asked',
        reason: '',
        repeatsTopicOf: null,
    };
    const reject = (reason, detail = '') => {
        appendAsk({ ...entry, status: 'rejected', reason, detail });
        return { ok: false, reason, detail, topicKey, entry };
    };

    if (chatKind !== 'private')
        return reject('group-chat');
    if (question === '')
        return reject('empty-question');
    if (checked === '')
        return reject('missing-checked');
    if (hypothesis === '')
        return reject('missing-hypothesis');
    if (hypothesis.length < 6 || hypothesis === question)
        return reject('weak-hypothesis');
    if (!HYPOTHESIS_MARKERS.some(marker => hypothesis.toLowerCase().includes(marker)))
        return reject('weak-hypothesis', 'no-reasoning-marker');

    // 队列不是绕过门槛的通道：除了复用已有答案，其余都要过上面的频次/自查/假设判定。
    // 已有答案且未过期 → 直接复用，不占额度、不入队；已有 pending → 不许重复入队。
    const match = findQueueMatch(tokens, chatId, now);
    if (match.answer !== undefined) {
        appendAsk({ ...entry, status: 'reused', reason: 'answered-reuse', detail: String(match.id) });
        return { ok: true, reuse: true, id: match.id, answer: match.answer, reason: 'answered-reuse', detail: '', topicKey, entry };
    }
    if (match.pendingId !== undefined)
        return reject('duplicate-pending', String(match.pendingId));

    const dayStart = now - 24 * 3600_000;
    if (asked.filter(item => item.askedAt >= dayStart).length >= DAILY_LIMIT)
        return reject('daily-limit');
    if (asked.filter(item => item.askedAt >= now - 3600_000).length >= HOURLY_LIMIT)
        return reject('hourly-limit');

    // 同话题：7 天内不重复问；被忽略 3 次以上永久降权。
    const sameTopic = asked.filter(item => topicSimilarity(tokens, topicTokens(String(item.question ?? '') + ' ' + String(item.hypothesis ?? ''))) >= SIMILARITY);
    const recent = sameTopic
        .filter(item => now - item.askedAt <= TOPIC_WINDOW_MS)
        .sort((left, right) => right.askedAt - left.askedAt)[0];
    if (recent !== undefined)
        return reject('topic-recent', 'repeat-of ' + String(recent.at ?? recent.askedAt));
    const ignored = sameTopic.filter(item => item.answered !== true && now - item.askedAt >= IGNORED_AFTER_MS);
    if (ignored.length >= IGNORED_LIMIT)
        return reject('topic-abandoned', 'ignored ' + ignored.length + ' times');

    const id = nextId(now);
    enqueueAsk({ id, chat: chatId, question, hypothesis, checked, topicKey, now });
    appendAsk({ ...entry, id, status: 'asked' });
    return { ok: true, reuse: false, id, reason: '', detail: '', topicKey, entry: { ...entry, id } };
}

/* ------------------------------------------------------------------ */
/* 第二层：TRAE 侧慢通道（队列 + 回写 + 读取端）                       */
/* 代理只做四件事：入队、读答案、标 consumed、按 TTL 判过期。          */
/* 派会话查证、回写 answer、超时标 expired 都由 cron 侧做。             */
/* ------------------------------------------------------------------ */
export const ASK_QUEUE_PATH = join(ROOT, 'ask-queue.jsonl');
export const ASK_ANSWERS_PATH = join(ROOT, 'ask-answers.jsonl');
export const QUEUE_TTL_MS = 2 * 3600_000;

/* 调度侧每 30 分钟直接读这两个文件。空的队列和「文件不存在」必须能区分开，
 * 否则一次都没入队时会被当成故障。首次加载时把文件建出来，之后只追加。 */
for (const path of [ASK_QUEUE_PATH, ASK_ANSWERS_PATH]) {
    try {
        writeFileSync(path, '', { flag: 'a' });
    }
    catch { /* 建不出来不影响回话 */ }
}

let idSeq = 0;
function nextId(now) {
    idSeq += 1;
    return 'ask-' + now.toString(36) + '-' + idSeq.toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

function readJsonl(path) {
    try {
        return readFileSync(path, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map(line => {
                try { return JSON.parse(line); }
                catch { return null; }
            })
            .filter(item => item !== null && typeof item === 'object');
    }
    catch {
        return [];
    }
}

function appendJsonl(path, item) {
    try {
        appendFileSync(path, JSON.stringify(item) + '\n', 'utf8');
    }
    catch { /* 队列写不进去也不能拦回话 */ }
}

export function readQueueEvents() {
    return readJsonl(ASK_QUEUE_PATH);
}

export function readAnswers() {
    return readJsonl(ASK_ANSWERS_PATH);
}

/** 折叠队列事件：同 id 后写覆盖前写（cron 只追加，不改写历史行）。 */
export function foldQueue() {
    const folded = new Map();
    for (const event of readQueueEvents()) {
        if (typeof event?.id !== 'string')
            continue;
        folded.set(event.id, { ...(folded.get(event.id) ?? {}), ...event });
    }
    return [...folded.values()];
}

function answerMap() {
    const map = new Map();
    for (const event of readAnswers()) {
        if (typeof event?.id === 'string' && typeof event?.answer === 'string')
            map.set(event.id, { ...(map.get(event.id) ?? {}), ...event });
    }
    return map;
}

function enqueueAsk({ id, chat, question, hypothesis, checked, topicKey, now }) {
    appendJsonl(ASK_QUEUE_PATH, {
        id,
        type: 'enqueue',
        ts: now,
        at: new Date(now).toISOString(),
        chat,
        question,
        hypothesis,
        checked,
        topicKey,
        status: 'pending',
        ttlAt: now + QUEUE_TTL_MS,
    });
}

/** 同一话题的队列命中：已作答未过期→复用；仍在 pending→不许重复入队。 */
export function findQueueMatch(tokens, chat, now = Date.now()) {
    const answers = answerMap();
    for (const entry of foldQueue()) {
        if (entry.chat !== chat)
            continue;
        const similar = topicSimilarity(tokens, topicTokens(String(entry.question ?? '') + ' ' + String(entry.hypothesis ?? ''))) >= SIMILARITY;
        if (!similar)
            continue;
        if (entry.status === 'pending' && now <= Number(entry.ttlAt ?? 0))
            return { pendingId: entry.id };
        if (entry.status === 'answered' && now <= Number(entry.ttlAt ?? 0)) {
            const answer = answers.get(entry.id);
            if (answer !== undefined)
                return { id: entry.id, answer };
        }
    }
    return {};
}

/**
 * 读取端：本会话已作答、未过期、未消费的条目。
 * 只提供上下文，不替模型生成回复。
 */
export function pendingAnswersFor(chat, now = Date.now()) {
    const answers = answerMap();
    const out = [];
    for (const entry of foldQueue()) {
        if (entry.chat !== chat || entry.status !== 'answered')
            continue;
        if (now > Number(entry.ttlAt ?? 0))
            continue; // TTL 超时后读不到答案（cron 会标 expired）
        const answer = answers.get(entry.id);
        if (answer === undefined || answer.consumedAt !== undefined)
            continue;
        out.push({
            id: entry.id,
            question: String(entry.question ?? ''),
            answer: answer.answer,
            sources: Array.isArray(answer.sources) ? answer.sources : [],
            certainty: answer.certainty === 'confident' ? 'confident' : 'uncertain',
        });
    }
    return out;
}

/** 读完标 consumed，避免反复注入。 */
export function markConsumed(ids, now = Date.now()) {
    for (const id of ids) {
        appendJsonl(ASK_QUEUE_PATH, {
            id,
            type: 'status',
            status: 'consumed',
            consumedAt: now,
            at: new Date(now).toISOString(),
        });
    }
}

/** 给 system 段用的答案上下文。 */
export function answersSection(items) {
    if (!Array.isArray(items) || items.length === 0)
        return '';
    const lines = ['## 主人回答过你的提问'];
    for (const item of items) {
        const sources = item.sources.length > 0 ? '；来源：' + item.sources.join('、') : '';
        const certainty = item.certainty === 'confident' ? '确定' : '不确定';
        lines.push('- 问：' + item.question);
        lines.push('  答：' + item.answer + '（' + certainty + sources + '）');
    }
    lines.push('用不用、怎么用由你决定；不要说队列、工具、系统或“主人回答了你的提问”这类话。');
    return lines.join('\n');
}

/** 给模型看的工具定义（只在私聊注入）。 */
export function askMasterToolDefinition() {
    return {
        type: 'function',
        function: {
            name: ASK_MASTER_TOOL,
            description: '向主人提一个自己查不到答案的问题（仅私聊）。调用前必须真的查过梗库/记忆/全站搜索；要带上你的猜测和猜测依据。每小时最多 1 次、每天最多 2 次，同话题 7 天内不重复问。',
            parameters: {
                type: 'object',
                properties: {
                    question: { type: 'string', description: '要问主人的那一句话，别写成系统工单。' },
                    checked: { type: 'string', description: '已查过哪些地方、结果如何（如「梗库无；记忆无；全站搜索无」）。空着=没查，会被拒。' },
                    hypothesis: { type: 'string', description: '你的猜测和依据，形如「我猜是 X，因为看到 Y」。只有一句「这是什么」会被拒。' },
                },
                required: ['question', 'checked', 'hypothesis'],
            },
        },
    };
}
