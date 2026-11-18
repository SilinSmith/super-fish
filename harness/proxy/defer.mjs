/**
 * 延迟队列：专注度低时把消息攒起来，晚点再看。
 *
 * 设计要点：
 *   - 默认什么都不发（batch:silent）；攒批的价值是"它知道发生过什么"。
 *   - 唯一允许补一句的情况：批里有一个具体问题、没问别人、没人回答、话题仍在延续，
 *     且判定器确认"答不上来"。每群 6 小时最多追问一次。
 *   - 30 分钟有效期，过期直接丢（batch:expired），不翻旧账。
 *   - 处理前查 proxy 队列，waiting >= 3 时不处理、不清队（batch:deferred）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { bigramSimilarity } from './memory.mjs';

export const DEFAULT_DEFER_PATH = 'Y:\\dsh\\home\\qq-persona\\defer-queue.json';
export const DEFAULT_DEFER_SHADOW_PATH = 'Y:\\dsh\\home\\qq-onebot-plugin\\logs\\shadow.jsonl';

export const BATCH_RULES = Object.freeze({
    SILENT: 'batch:silent',
    FOLLOWUP: 'batch:followup',
    EXPIRED: 'batch:expired',
    DEFERRED: 'batch:deferred',
});

export const DEFER_DEFAULTS = Object.freeze({
    ttlMin: 30,
    sizeLimit: 8,
    maxWaitMin: 10,
    idleMin: 10,
    realtimeFocusAt: 60,
    followupCooldownMin: 360,
    groupCap: 50,
    maxChars: 60,
});

const QUESTION_RE = /[？?]|吗|呢|怎么|为什么|为啥|有没有|行不行|定了吗|怎么办|是不是|什么时候|在哪/u;
const GREETING_RE = /^(?:早|早安|早上好|晚安|在吗|有人在吗|hi|hello|哈喽|嗨)[\s!！。.？?~～]*$/iu;
const SUMMARY_TONE_RE = /以下|三点|总结|综上|首先|其次|另外|建议|梳理/u;
const MINUTE = 60_000;

function readState(path) {
    try {
        if (!existsSync(path))
            return null;
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return null;
    }
}

function freshState() {
    return { version: 1, groups: {} };
}

function shorten(value, max) {
    const chars = [...String(value ?? '').replace(/\s+/gu, ' ').trim()];
    return chars.length <= max ? chars.join('') : chars.slice(0, max).join('') + '…';
}

function textOf(message) {
    if (typeof message?.content === 'string')
        return message.content;
    if (Array.isArray(message?.content))
        return message.content.map(part => (typeof part?.text === 'string' ? part.text : '')).join(' ');
    return '';
}

function extractJson(text) {
    const raw = String(text ?? '');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start)
        return null;
    try {
        return JSON.parse(raw.slice(start, end + 1));
    }
    catch {
        return null;
    }
}

const BATCH_SYSTEM = '你在看一段被攒起来的群聊记录。默认不要说话。\n'
    + '只有当批里有一个具体问题、既没人回答、上下文里也找不到答案，而且这个话题现在还在继续时，'
    + '才允许追问一句，帮它把话接上。\n'
    + '追问必须短、口语化，像人随口问的（例如"那个方案最后定了吗"），不能是总结或建议。\n'
    + '只输出 JSON：{"followup":true,"question":"一句追问"} 或 {"followup":false,"reason":"为什么不说"}。';

export function createDeferRuntime(options = {}) {
    const statePath = options.statePath ?? DEFAULT_DEFER_PATH;
    const shadowPath = options.shadowPath ?? DEFAULT_DEFER_SHADOW_PATH;
    const proxyBase = String(options.proxyBase ?? 'http://127.0.0.1:1240').replace(/\/+$/u, '');
    const now = options.now ?? (() => Date.now());
    const log = options.log ?? (() => {});
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = Math.max(500, Number(options.timeoutMs) || 3000);

    const notebookPath = options.notebookPath ?? 'Y:\\dsh\\home\\qq-persona\\notebook.json';
    const notebookCache = { mtimeMs: -1, entries: [] };
    const processing = new Set();

    let settings = {
        ttlMin: Number(options.ttlMin) > 0 ? Number(options.ttlMin) : DEFER_DEFAULTS.ttlMin,
        sizeLimit: Number(options.sizeLimit) > 0 ? Number(options.sizeLimit) : DEFER_DEFAULTS.sizeLimit,
        maxWaitMin: Number(options.maxWaitMin) > 0 ? Number(options.maxWaitMin) : DEFER_DEFAULTS.maxWaitMin,
        idleMin: Number(options.idleMin) > 0 ? Number(options.idleMin) : DEFER_DEFAULTS.idleMin,
        realtimeFocusAt: Number(options.realtimeFocusAt) >= 0
            ? Number(options.realtimeFocusAt)
            : DEFER_DEFAULTS.realtimeFocusAt,
        followupCooldownMin: Number(options.followupCooldownMin) >= 0
            ? Number(options.followupCooldownMin)
            : DEFER_DEFAULTS.followupCooldownMin,
        groupCap: Number(options.groupCap) > 0 ? Number(options.groupCap) : DEFER_DEFAULTS.groupCap,
        maxChars: Number(options.maxChars) > 0 ? Number(options.maxChars) : DEFER_DEFAULTS.maxChars,
        queueLimit: Number(options.queueLimit) > 0 ? Number(options.queueLimit) : 3,
    };

    const loaded = readState(statePath);
    let state = loaded !== null && typeof loaded === 'object' ? loaded : freshState();
    if (state.groups === null || typeof state.groups !== 'object')
        state.groups = {};

    function save() {
        try {
            mkdirSync(dirname(statePath), { recursive: true });
            const tmp = statePath + '.tmp';
            writeFileSync(tmp, JSON.stringify(state), 'utf8');
            renameSync(tmp, statePath);
        }
        catch (error) {
            log('warn', '延迟队列写入失败: ' + (error?.message ?? String(error)));
        }
    }

    function shadow(row) {
        try {
            mkdirSync(dirname(shadowPath), { recursive: true });
            appendFileSync(shadowPath, JSON.stringify({ ts: new Date(now()).toISOString(), mode: 'batch', ...row }) + '\n', 'utf8');
        }
        catch (error) {
            log('warn', 'shadow 写入失败: ' + (error?.message ?? String(error)));
        }
    }

    function groupState(groupId) {
        const key = String(groupId ?? '');
        if (key === '')
            return null;
        const existing = state.groups[key];
        if (existing !== undefined && existing !== null)
            return existing;
        const created = { items: [], lastInboundAt: 0, lastProcessedAt: 0, lastFollowupAt: 0, asked: [] };
        state.groups[key] = created;
        return created;
    }

    /**
     * 专注度路由。主人/私聊/@/外部事件/手动 activity 永远实时。
     */
    function route(focus, context = {}) {
        if (context.mentioned === true || context.isMaster === true || context.chatKind === 'private')
            return 'realtime';
        if (context.unprompted === true || context.activity === true)
            return 'realtime';
        return Number(focus) >= settings.realtimeFocusAt ? 'realtime' : 'defer';
    }

    function touch(groupId) {
        const group = groupState(groupId);
        if (group === null)
            return;
        group.lastInboundAt = now();
        save();
    }

    function enqueue(entry) {
        const group = groupState(entry?.groupId);
        if (group === null)
            return { ok: false, pending: 0 };
        const stamp = now();
        group.items.push({
            messageId: entry.messageId ?? null,
            userId: String(entry.userId ?? ''),
            nickname: entry.nickname ?? '',
            text: String(entry.text ?? '').slice(0, 500),
            at: Number.isFinite(entry.at) ? entry.at : stamp,
            addressed: entry.addressed === true,
        });
        group.lastInboundAt = stamp;
        if (group.items.length > settings.groupCap) {
            const dropped = group.items.shift();
            shadow({
                groupId: entry.groupId,
                rule: BATCH_RULES.EXPIRED,
                reason: '延迟队列超限，丢弃最老一条',
                details: {
                    batchSize: group.items.length,
                    oldestAgeMs: dropped === undefined ? 0 : stamp - dropped.at,
                    focus: entry.focus ?? null,
                },
            });
        }
        save();
        return { ok: true, pending: group.items.length };
    }

    /** 三条触发条件任一成立。 */
    function due(groupId, options = {}) {
        const group = state.groups[String(groupId ?? '')];
        if (group === undefined || !Array.isArray(group.items) || group.items.length === 0)
            return false;
        const stamp = Number.isFinite(options.now) ? options.now : now();
        if (group.items.length >= settings.sizeLimit)
            return true;
        if (stamp - group.items[0].at >= settings.maxWaitMin * MINUTE)
            return true;
        const idleFrom = Number(group.lastInboundAt ?? 0) || group.items[group.items.length - 1].at;
        return options.busy !== true && stamp - idleFrom >= settings.idleMin * MINUTE;
    }

    /** 剔除过期条目；返回仍在有效期内的条目。 */
    function takeValid(groupId, focus) {
        const group = state.groups[String(groupId ?? '')];
        if (group === undefined || !Array.isArray(group.items) || group.items.length === 0)
            return [];
        const stamp = now();
        const ttlMs = settings.ttlMin * MINUTE;
        const valid = [];
        let expired = 0;
        let oldestExpiredAge = 0;
        for (const item of group.items) {
            const age = stamp - Number(item.at ?? stamp);
            if (age > ttlMs) {
                expired += 1;
                oldestExpiredAge = Math.max(oldestExpiredAge, age);
                continue;
            }
            valid.push(item);
        }
        if (expired > 0) {
            shadow({
                groupId,
                rule: BATCH_RULES.EXPIRED,
                reason: '超过有效期，丢弃不再追问',
                details: { batchSize: expired, oldestAgeMs: oldestExpiredAge, focus: focus ?? null },
            });
            group.items = valid;
            save();
        }
        return valid;
    }

    function clear(groupId) {
        const group = groupState(groupId);
        if (group === null)
            return;
        group.items = [];
        group.lastProcessedAt = now();
        save();
    }

    /**
     * 本地硬过滤：找"具体的、没问别人、没人回答、仍在延续"的问题。
     * 返回候选消息或 null；只有候选存在时才值得调一次判定器。
     */
    function pickQuestion(items) {
        if (!Array.isArray(items) || items.length === 0)
            return null;
        const latest = items[items.length - 1];
        for (let index = items.length - 1; index >= 0; index -= 1) {
            const item = items[index];
            const text = String(item.text ?? '');
            if (item.addressed === true)
                continue;
            if (!QUESTION_RE.test(text) || GREETING_RE.test(text.trim()))
                continue;
            const recent = index >= items.length - 3;
            const related = bigramSimilarity(text, latest.text) >= 0.18;
            if (!recent && !related)
                continue;
            const answered = items.slice(index + 1, index + 4).some(next => {
                if (next.userId === item.userId)
                    return false;
                const reply = String(next.text ?? '');
                return reply.trim() !== '' && !QUESTION_RE.test(reply);
            });
            if (answered)
                continue;
            return item;
        }
        return null;
    }

    async function queueWaiting() {
        try {
            const response = await fetchImpl(proxyBase + '/internal/queue', {
                signal: AbortSignal.timeout(Math.min(timeoutMs, 1500)),
            });
            if (!response.ok)
                return 0;
            const body = await response.json();
            return Number(body?.waiting) || 0;
        }
        catch {
            return 0;
        }
    }

    /** 知识库里能答的内容：只取命中的前三条，给判定器做“别再追问”的依据。 */
    function knowledgeFor(query) {
        try {
            const stamp = statSync(notebookPath).mtimeMs;
            if (stamp !== notebookCache.mtimeMs) {
                notebookCache.mtimeMs = stamp;
                const raw = JSON.parse(readFileSync(notebookPath, 'utf8'));
                notebookCache.entries = (Array.isArray(raw?.entries) ? raw.entries : [])
                    .filter(entry => entry?.category === 'knowledge' && entry.status === 'active');
            }
        }
        catch {
            return '';
        }
        if (notebookCache.entries.length === 0)
            return '';
        const text = String(query ?? '');
        return notebookCache.entries
            .map(entry => ({
                entry,
                score: bigramSimilarity(text, entry.text ?? '') + bigramSimilarity(text, entry.subject ?? ''),
            }))
            .filter(item => item.score >= 0.12)
            .sort((left, right) => right.score - left.score)
            .slice(0, 3)
            .map(item => '- ' + shorten(item.entry.text, 140))
            .join('\n');
    }

    function buildContext(items, knowledgeText) {
        const lines = ['被攒起来的群消息（从旧到新）：'];
        for (const item of items.slice(-8))
            lines.push('- ' + (item.nickname || item.userId || '群友') + '：' + shorten(item.text, 160));
        if (typeof knowledgeText === 'string' && knowledgeText.trim() !== '')
            lines.push('\n已知信息（能答就答，不要追问）：\n' + shorten(knowledgeText, 800));
        lines.push('\n判断是否需要追问；默认输出 {"followup":false}。');
        return lines.join('\n');
    }

    async function askFollowup(items, knowledgeText) {
        const response = await fetchImpl(proxyBase + '/decide', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                max_tokens: 200,
                messages: [
                    { role: 'system', content: BATCH_SYSTEM },
                    { role: 'user', content: buildContext(items, knowledgeText) },
                ],
            }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok)
            throw new Error('decide status ' + response.status);
        const body = await response.json();
        const parsed = extractJson(textOf(body?.choices?.[0]?.message));
        if (parsed === null)
            throw new Error('decide bad json');
        const question = typeof parsed.question === 'string' ? parsed.question.replace(/\s+/gu, ' ').trim() : '';
        return {
            followup: parsed.followup === true && question !== '',
            question: [...question].slice(0, 40).join(''),
            reason: shorten(parsed.reason ?? '', 80),
        };
    }

    /**
     * 处理一个群的一批消息。
     * 返回 { rule, send, count }；send 非空时调用方把它当一句普通群回复发出去。
     */
    async function runBatchOnce({ groupId, focus, knowledgeText } = {}) {
        const group = groupState(groupId);
        if (group === null)
            return { rule: BATCH_RULES.SILENT, send: null, count: 0 };
        const valid = takeValid(groupId, focus);
        if (valid.length === 0)
            return { rule: BATCH_RULES.EXPIRED, send: null, count: 0 };
        const oldestAgeMs = now() - valid[0].at;
        const stamp = now();

        if (settings.followupCooldownMin > 0
            && stamp - Number(group.lastFollowupAt ?? 0) < settings.followupCooldownMin * MINUTE) {
            clear(groupId);
            shadow({
                groupId,
                rule: BATCH_RULES.SILENT,
                reason: '追问冷却中，本批保持沉默',
                details: { batchSize: valid.length, oldestAgeMs, focus: focus ?? null },
            });
            return { rule: BATCH_RULES.SILENT, send: null, count: valid.length };
        }

        if (await queueWaiting() >= settings.queueLimit) {
            shadow({
                groupId,
                rule: BATCH_RULES.DEFERRED,
                reason: 'proxy 队列积压，稍后再处理',
                details: { batchSize: valid.length, oldestAgeMs, focus: focus ?? null },
            });
            return { rule: BATCH_RULES.DEFERRED, send: null, count: valid.length };
        }

        const candidate = pickQuestion(valid);
        if (candidate === null) {
            clear(groupId);
            shadow({
                groupId,
                rule: BATCH_RULES.SILENT,
                reason: '没有值得追问的具体问题',
                details: { batchSize: valid.length, oldestAgeMs, focus: focus ?? null },
            });
            return { rule: BATCH_RULES.SILENT, send: null, count: valid.length };
        }

        let decision;
        try {
            const knowledge = typeof knowledgeText === 'string' && knowledgeText !== ''
                ? knowledgeText
                : knowledgeFor(candidate.text);
            decision = await askFollowup(valid, knowledge);
        }
        catch (error) {
            log('warn', '批处理追问判定失败，保持沉默: ' + (error?.message ?? String(error)));
            decision = { followup: false, question: '', reason: '判定失败' };
        }
        clear(groupId);
        if (!decision.followup || SUMMARY_TONE_RE.test(decision.question)) {
            shadow({
                groupId,
                rule: BATCH_RULES.SILENT,
                reason: decision.reason || '判定不追问',
                details: { batchSize: valid.length, oldestAgeMs, focus: focus ?? null },
            });
            return { rule: BATCH_RULES.SILENT, send: null, count: valid.length };
        }
        group.lastFollowupAt = now();
        group.asked = [...(Array.isArray(group.asked) ? group.asked : []), shorten(candidate.text, 60)].slice(-20);
        save();
        shadow({
            groupId,
            rule: BATCH_RULES.FOLLOWUP,
            reason: decision.reason || '有未被回答的问题，追问一句',
            details: {
                batchSize: valid.length,
                oldestAgeMs,
                focus: focus ?? null,
                question: decision.question,
            },
        });
        return { rule: BATCH_RULES.FOLLOWUP, send: decision.question, count: valid.length };
    }

    /** 同一群同一时刻只处理一批，避免入站触发和定时触发重复消费。 */
    async function runBatch(args = {}) {
        const key = String(args?.groupId ?? '');
        if (processing.has(key)) {
            shadow({
                groupId: key,
                rule: BATCH_RULES.DEFERRED,
                reason: '上一批还在处理',
                details: { batchSize: snapshot()[key]?.pending ?? 0, oldestAgeMs: snapshot()[key]?.oldestAgeMs ?? 0, focus: args?.focus ?? null },
            });
            return { rule: BATCH_RULES.DEFERRED, send: null, count: 0 };
        }
        processing.add(key);
        try {
            return await runBatchOnce(args);
        }
        finally {
            processing.delete(key);
        }
    }

    function snapshot() {
        const out = {};
        const stamp = now();
        for (const [groupId, group] of Object.entries(state.groups ?? {})) {
            const items = Array.isArray(group?.items) ? group.items : [];
            out[groupId] = {
                pending: items.length,
                oldestAgeMs: items.length === 0 ? 0 : Math.max(0, stamp - Number(items[0].at ?? stamp)),
            };
        }
        return out;
    }

    /**
     * 周期清理：不能只等该群下一条消息来触发过期判断。
     * 面板直接读这个文件算 age，没人说话的群里一条陈旧条目会挂上一整天。
     * 按 ttlMin 主动丢弃过期条目，返回被丢掉的条数与涉及群。
     */
    function sweep(options = {}) {
        const stamp = Number.isFinite(options.now) ? options.now : now();
        const ttlMs = settings.ttlMin * MINUTE;
        const touched = [];
        let dropped = 0;
        for (const [groupId, group] of Object.entries(state.groups ?? {})) {
            if (!Array.isArray(group?.items) || group.items.length === 0)
                continue;
            const valid = [];
            let expired = 0;
            let oldestExpiredAge = 0;
            for (const item of group.items) {
                const age = stamp - Number(item.at ?? stamp);
                if (age > ttlMs) {
                    expired += 1;
                    oldestExpiredAge = Math.max(oldestExpiredAge, age);
                    continue;
                }
                valid.push(item);
            }
            if (expired === 0)
                continue;
            group.items = valid;
            dropped += expired;
            touched.push(groupId);
            shadow({
                groupId,
                rule: BATCH_RULES.EXPIRED,
                reason: '周期清理：超过有效期，丢弃不再追问',
                details: { batchSize: expired, oldestAgeMs: oldestExpiredAge, focus: null },
            });
        }
        if (dropped > 0)
            save();
        return { dropped, groups: touched };
    }

    function configure(partial = {}) {
        for (const key of ['ttlMin', 'sizeLimit', 'maxWaitMin', 'idleMin', 'followupCooldownMin', 'groupCap', 'maxChars', 'queueLimit']) {
            if (Number(partial[key]) > 0)
                settings[key] = Number(partial[key]);
        }
        if (Number(partial.realtimeFocusAt) >= 0)
            settings.realtimeFocusAt = Number(partial.realtimeFocusAt);
    }

    return {
        route,
        touch,
        enqueue,
        due,
        runBatch,
        pickQuestion,
        snapshot,
        sweep,
        configure,
        get settings() {
            return { ...settings };
        },
        statePath,
    };
}

let singleton = null;

export function getDeferRuntime(options = {}) {
    if (singleton === null)
        singleton = createDeferRuntime(options);
    return singleton;
}
