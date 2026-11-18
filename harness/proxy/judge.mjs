/**
 * 判定器：给一小段群上下文，让模型回答"现在该不该接一句"。
 *
 * 三条硬约束：
 *   - 同群 mergeWindowMs 内的多条消息合并成一次判定，不是逐条打模型，也不丢消息；
 *   - 熔断只看 proxy 队列：waiting >= queueLimit 时本轮不发模型请求，记 judge:skip:queue；
 *   - 判定失败一律沉默（judge:error），绝不因为判定器挂了就开始乱说话。
 *
 * 每次判定都往 shadow.jsonl 写一行 mode:"judge"，理由落盘，方便回看它为什么开口。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrateNotebook, relationToneOf } from './memory.mjs';

export const DEFAULT_JUDGE_SHADOW_PATH = 'Y:\\dsh\\home\\qq-onebot-plugin\\logs\\shadow.jsonl';

export const JUDGE_RULES = Object.freeze({
    SPEAK: 'judge:speak',
    SILENT: 'judge:silent',
    ERROR: 'judge:error',
    SKIP_QUEUE: 'judge:skip:queue',
    SKIP_DND: 'judge:skip:dnd',
    MERGED: 'judge:merged',
    NOT_ADDRESSED: 'judge:not-addressed',
    /** 主人发话：不靠正文措辞判断，硬闸门之外一律接住。 */
    MASTER_CUE: 'master:cue',
});

const JUDGE_SYSTEM = '你是群聊里的接话判定器。先判断最新一条是不是在跟机器人说，再判断现在该不该接。\n'
    + '必须输出两段互相独立的结果：\n'
    + '- addressedToBot：这条消息是不是在跟机器人说（@ 它、引用它、拍它、点名它、等它回答）；\n'
    + '- shouldReply：此刻该不该由机器人开口。\n'
    + '以下情形 addressedToBot 与 shouldReply 都必须是 false，保持沉默：\n'
    + '- 别人问别人，且没有 @ 机器人、没有引用机器人；\n'
    + '- 两个人在互相问答，机器人只是旁观；\n'
    + '- @ 了别人（不是机器人）；\n'
    + '- 明显在等技术/事实答案，而说话对象不是机器人；\n'
    + '- 只是陈述、吐槽或自言自语，没有要任何人回答。\n'
    + '第二人称绑定：「你/您」只有在 addressedToBot 为 true 时才指机器人。消息若在回复别人、@ 别人、或接着别人的话说，句中的「你/您」属于别人的对话，不许当成在叫机器人。\n'
    + '单独问号：一条消息如果只有「？」「?」「？？」这类无内容符号，只有它紧跟在机器人自己刚发的那条回复之后，或明确回复/引用机器人那条，才算 addressedToBot=true；中间隔了别人的消息、或别人之间互发的问号，一律 false。\n'
    + '过旧不回：话头已经被别人接完，或这条消息明显过期（当前已经没人等它回答），shouldReply 必须为 false；宁可不说。\n'
    + '状态不作为沉默理由：机器人自己的心情/耐心只影响它回复的语气和长短，绝不能因为“不耐烦/没耐心”把 shouldReply 判成 false；'
    + '是否回复只看有没有被叫到、或能不能补一句对方需要的关键信息。\n'
    + '只有被点名、被 @、被引用、被拍，或确实能补一句对方需要的关键信息时 shouldReply 才能为 true。\n'
    + '只输出 JSON：{"addressedToBot":true,"shouldReply":true,"reason":"一句中文理由"}，'
    + '把两个布尔值换成你判断的真实结果；理由不超过 60 字，不要解释规则，不要输出其它内容。';

const RELATION_TONE_LINE = {
    熟悉: '熟悉',
    一般: '一般',
    生疏: '生疏',
};

function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return null;
    }
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

function shorten(value, max) {
    const chars = [...String(value ?? '').replace(/\s+/gu, ' ').trim()];
    return chars.length <= max ? chars.join('') : chars.slice(0, max).join('') + '…';
}

export function createJudgeRuntime(options = {}) {
    const proxyBase = String(options.proxyBase ?? 'http://127.0.0.1:1240').replace(/\/+$/u, '');
    const shadowPath = options.shadowPath ?? DEFAULT_JUDGE_SHADOW_PATH;
    const notebookPath = options.notebookPath ?? 'Y:\\dsh\\home\\qq-persona\\notebook.json';
    const now = options.now ?? (() => Date.now());
    const log = options.log ?? (() => {});
    const setTimer = options.setTimer ?? setTimeout;
    const clearTimer = options.clearTimer ?? clearTimeout;
    const fetchImpl = options.fetchImpl ?? fetch;

    let mergeWindowMs = Math.max(10, Number(options.mergeWindowMs) || 5000);
    let timeoutMs = Math.max(500, Number(options.timeoutMs) || 3000);
    let queueLimit = Math.max(1, Number(options.queueLimit) || 3);

    /** groupId → { seq, entries:[{input, resolve}], timer } */
    const windows = new Map();
    const notebookCache = { mtimeMs: -1, notebook: null };

    function shadow(row) {
        try {
            mkdirSync(dirname(shadowPath), { recursive: true });
            // 判定 v2 的三个可观测字段：addressedToBot / shouldReply / gate。
            // 同时保留旧的 type/decision 外形，监听与平台不需要再靠推断。
            const record = {
                ts: new Date(now()).toISOString(),
                type: 'decision',
                mode: 'judge',
                ...row,
                decision: {
                    reply: row.reply === true,
                    rule: row.rule ?? '',
                    reason: row.reason ?? '',
                    details: {
                        addressedToBot: row.addressedToBot === true,
                        shouldReply: row.shouldReply === true,
                        gate: row.gate ?? '',
                    },
                },
            };
            appendFileSync(shadowPath, JSON.stringify(record) + '\n', 'utf8');
        }
        catch {
            // 日志失败不能影响判定
        }
    }

    function notebook() {
        try {
            const stamp = statSync(notebookPath).mtimeMs;
            if (stamp !== notebookCache.mtimeMs) {
                notebookCache.mtimeMs = stamp;
                notebookCache.notebook = migrateNotebook(readJson(notebookPath));
            }
            return notebookCache.notebook;
        }
        catch {
            return notebookCache.notebook;
        }
    }

    function relationHint(qq) {
        if (typeof qq !== 'string' || qq === '')
            return '';
        try {
            return relationToneOf(notebook(), qq, { now: now() });
        }
        catch {
            return '';
        }
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
            // 探测失败按空闲处理：真的不行，后面的 /decide 会失败并沉默。
            return 0;
        }
    }

    function buildContext(entries, relation) {
        const lines = ['群里最近的消息（从旧到新）：'];
        for (const entry of entries.slice(-8))
            lines.push('- ' + (entry.input.nickname || entry.input.userId || '群友') + '：' + shorten(entry.input.text, 180));
        const last = entries[entries.length - 1].input;
        const mentioned = last.mentioned === true;
        const quotedMe = last.quotedMe === true;
        const pokeMe = last.pokeMe === true;
        const atOther = last.atOther === true;
        const quotedOther = last.quotedOther === true;
        const addressedElsewhere = last.addressed === true;
        const asking = mentioned || quotedMe || pokeMe
            ? '机器人'
            : (atOther || quotedOther || addressedElsewhere ? '别人' : '不清楚');
        lines.push('');
        lines.push('最新一条由 ' + (last.nickname || last.userId || '群友') + ' 发出');
        lines.push('是否 @ 了机器人：' + (mentioned ? '是' : '否'));
        lines.push('是否 @ 了别人：' + (atOther ? '是' : '否'));
        lines.push('是否引用机器人：' + (quotedMe ? '是' : (last.quotedUnknown === true ? '解析失败（未知）' : '否')));
        lines.push('是否引用别人：' + (quotedOther ? '是' : '否'));
        lines.push('是否拍机器人：' + (pokeMe ? '是' : '否'));
        lines.push('是否在回复别人：' + (addressedElsewhere ? '是' : '否'));
        // 带上“谁在回谁”：被引用的那条是谁说的、说了什么，别只给一句孤立的话。
        if (typeof last.quotedNick === 'string' && last.quotedNick !== ''
            && typeof last.quotedText === 'string' && last.quotedText !== '')
            lines.push('它引用的那条来自 ' + last.quotedNick + '：' + shorten(last.quotedText, 120));
        lines.push('这句话在问/等谁回答：' + asking);
        if (relation !== '')
            lines.push('与说话人关系倾向：' + RELATION_TONE_LINE[relation]);
        if (typeof last.presenceHint === 'string' && last.presenceHint !== '')
            lines.push('它自己的状态：' + last.presenceHint);
        lines.push('先判断 addressedToBot，再判断 shouldReply。只输出 JSON。');
        return lines.join('\n');
    }

    async function decide(entries, relation) {
        const response = await fetchImpl(proxyBase + '/decide', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                max_tokens: 200,
                messages: [
                    { role: 'system', content: JUDGE_SYSTEM },
                    { role: 'user', content: buildContext(entries, relation) },
                ],
            }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok)
            throw new Error('decide status ' + response.status);
        const body = await response.json();
        const parsed = extractJson(textOf(body?.choices?.[0]?.message));
        // 只接受两段都齐全的判定；旧的一元 speak 输出视为格式异常（宁沉默）。
        if (parsed === null
            || typeof parsed.addressedToBot !== 'boolean'
            || typeof parsed.shouldReply !== 'boolean')
            throw new Error('decide bad json');
        return {
            addressedToBot: parsed.addressedToBot,
            shouldReply: parsed.shouldReply,
            reason: shorten(parsed.reason ?? '', 80),
        };
    }

    async function flush(key) {
        const window = windows.get(key);
        if (window === undefined)
            return;
        windows.delete(key);
        clearTimer(window.timer);
        const entries = window.entries;
        const last = entries[entries.length - 1];
        const base = {
            groupId: last.input.groupId,
            chatId: last.input.chatId,
            userId: last.input.userId,
            nickname: last.input.nickname,
            messageId: last.input.messageId,
            text: shorten(last.input.text, 180),
            mergedCount: entries.length,
            mode: 'judge',
        };
        let verdict;
        const waiting = await queueWaiting();
        // 主人身份不构成“被叫到”：群里同时有别人时，「测你吗」的“你”可能指着别人。
        // 只认 @/引用/拍/点名，其余交给模型的 addressedToBot。
        const addressed = last.input.mentioned === true
            || last.input.quotedMe === true
            || last.input.pokeMe === true;
        const directedElsewhere = last.input.addressed === true
            || last.input.atOther === true
            || last.input.quotedOther === true;
        if (!addressed && directedElsewhere) {
            // 确定性硬闸门：别人之间的 @/引用/问答，机器人不插嘴。
            // 这一条不看模型脸色，避免“别人问别人”被判定器放进来。
            verdict = {
                speak: false,
                addressedToBot: false,
                shouldReply: false,
                reason: '这条在跟别人说，不是在叫机器人',
                rule: JUDGE_RULES.NOT_ADDRESSED,
                gate: 'hard',
            };
        }
        else if (last.input.isMaster === true) {
            // 主人发话：除上面“在跟别人说”的硬闸门外一律接住。
            // 不经模型、不看正文有没有问号，也不因队列积压被跳过。
            verdict = {
                speak: true,
                addressedToBot: true,
                shouldReply: true,
                reason: '主人发话，直接接',
                rule: JUDGE_RULES.MASTER_CUE,
                gate: 'master',
            };
        }
        else if (waiting >= queueLimit) {
            verdict = { speak: false, reason: 'proxy 队列积压，本轮不新增请求', rule: JUDGE_RULES.SKIP_QUEUE, gate: 'queue' };
        }
        else {
            try {
                const decision = await decide(entries, relationHint(last.input.userId));
                const speak = decision.shouldReply === true
                    && (addressed || decision.addressedToBot === true);
                verdict = {
                    speak,
                    addressedToBot: decision.addressedToBot,
                    shouldReply: decision.shouldReply,
                    reason: decision.reason,
                    rule: speak ? JUDGE_RULES.SPEAK : JUDGE_RULES.SILENT,
                    gate: 'model',
                };
            }
            catch (error) {
                log('warn', '接话判定失败，保持沉默: ' + (error?.message ?? String(error)));
                verdict = { speak: false, reason: '判定失败，保持沉默', rule: JUDGE_RULES.ERROR, gate: 'error' };
            }
        }
        shadow({
            ...base,
            reply: verdict.speak,
            addressedToBot: verdict.addressedToBot,
            shouldReply: verdict.shouldReply,
            gate: verdict.gate ?? '',
            rule: verdict.rule,
            reason: verdict.reason,
        });
        for (let index = 0; index < entries.length; index += 1) {
            const entry = entries[index];
            if (index < entries.length - 1) {
                entry.resolve({
                    speak: false,
                    reason: '与后续消息合并判定',
                    rule: JUDGE_RULES.MERGED,
                    gate: 'merged',
                    mergedCount: entries.length,
                });
                continue;
            }
            entry.resolve({ ...verdict, mergedCount: entries.length });
        }
    }

    /**
     * 入队等待合并窗口。窗口结束前同群的后续消息复用同一次判定，
     * 只有最后一条真正拿到判定结果，前面的返回 judge:merged 避免重复回复。
     */
    function judge(input) {
        const stamp = Number.isFinite(input.now) ? input.now : now();
        if (input.dnd === true) {
            shadow({
                groupId: input.groupId,
                chatId: input.chatId,
                userId: input.userId,
                nickname: input.nickname,
                messageId: input.messageId,
                text: shorten(input.text, 180),
                mergedCount: 1,
                reply: false,
                addressedToBot: false,
                shouldReply: false,
                gate: 'dnd',
                rule: JUDGE_RULES.SKIP_DND,
                reason: '处于免打扰时段',
            });
            return Promise.resolve({ speak: false, reason: '免打扰', rule: JUDGE_RULES.SKIP_DND, gate: 'dnd', mergedCount: 1 });
        }
        const key = String(input.groupId ?? input.chatId ?? '');
        let window = windows.get(key);
        if (window === undefined) {
            const timer = setTimer(() => { void flush(key); }, mergeWindowMs);
            window = { entries: [], timer };
            windows.set(key, window);
        }
        return new Promise(resolve => {
            window.entries.push({ input: { ...input, now: stamp }, resolve });
        });
    }

    /** 免打扰/主动跳过时也留一行 shadow，便于按群统计。 */
    function recordSkip(input, rule, reason) {
        shadow({
            groupId: input.groupId,
            chatId: input.chatId,
            userId: input.userId,
            nickname: input.nickname,
            messageId: input.messageId,
            text: shorten(input.text, 180),
            mergedCount: 1,
            reply: false,
            rule,
            reason,
        });
    }

    function configure(partial = {}) {
        if (Number(partial.mergeWindowMs) >= 10)
            mergeWindowMs = Number(partial.mergeWindowMs);
        if (Number(partial.timeoutMs) >= 500)
            timeoutMs = Number(partial.timeoutMs);
        if (Number(partial.queueLimit) >= 1)
            queueLimit = Number(partial.queueLimit);
    }

    return {
        judge,
        recordSkip,
        configure,
        get pendingWindows() {
            return windows.size;
        },
    };
}

let singleton = null;

export function getJudgeRuntime(options = {}) {
    if (singleton === null)
        singleton = createJudgeRuntime(options);
    return singleton;
}
