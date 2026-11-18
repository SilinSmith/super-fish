/**
 * 常驻群聊上下文压缩器。
 *
 * 机器人没被触发时也在跑：轮询 conversation-feed.jsonl，按群攒一小批消息，
 * 用「朴素视角」系统提示（不含人设、不角色扮演）增量维护一份对话状态：
 * 主要话题、未结问题、指代关系（必须落 QQ）、最近发言人名单。
 *
 * 正式回复轮由 proxy 注入这份状态 + 自上次回复以来的原文，避免把上千条
 * 原始历史塞进窗口。状态与每次运行的审计都落盘，崩溃后从 feed-cursor 续跑。
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_ROOT = 'Y:\\dsh\\home\\qq-persona';
const STATE_VERSION = 1;
const MAX_BATCH = 120;
const MAX_STATE_CHARS = 1400;
const MAX_MEMBERS = 200;
const MAX_TOPICS = 8;
const MAX_QUESTIONS = 6;
const MAX_REFS = 20;
const MAX_SPEAKERS = 30;

function readJson(path, fallback) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return fallback;
    }
}

function writeJsonAtomic(path, value) {
    const tmp = path + '.tmp-' + process.pid;
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    renameSync(tmp, path);
}

/** 昵称归一：只留字母/数字/汉字，用来判断“像不像同一个人”。 */
function normalizeNick(nick) {
    return String(nick ?? '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

/** 相似昵称对（不同 QQ）：互相包含，或公共前缀≥3 字。 */
export function similarNicknames(members) {
    const entries = Object.entries(members ?? {})
        .map(([qq, nick]) => ({ qq, nick: String(nick), key: normalizeNick(nick) }))
        .filter(item => item.key.length >= 2);
    const commonPrefix = (left, right) => {
        let index = 0;
        while (index < left.length && index < right.length && left[index] === right[index])
            index += 1;
        return index;
    };
    const pairs = [];
    for (let i = 0; i < entries.length; i += 1) {
        for (let j = i + 1; j < entries.length; j += 1) {
            const a = entries[i];
            const b = entries[j];
            if (a.qq === b.qq || a.key === b.key)
                continue;
            const contained = a.key.includes(b.key) || b.key.includes(a.key);
            if (contained || commonPrefix(a.key, b.key) >= 3)
                pairs.push({ a, b });
        }
    }
    return pairs.slice(0, 12);
}

/** 确定性指代兜底：按全名/包含关系找成员，返回所有命中（不唯一化）。 */
export function resolveMention(members, mention) {
    const key = normalizeNick(mention);
    if (key === '')
        return [];
    const hits = [];
    for (const [qq, nick] of Object.entries(members ?? {})) {
        const memberKey = normalizeNick(nick);
        if (memberKey === key || memberKey.includes(key))
            hits.push({ qq, nick: String(nick) });
    }
    return hits;
}

/** 从模型输出里抠 JSON（容忍 ```json 包裹与前后废话）。 */
export function parseStateJson(text) {
    const raw = String(text ?? '').trim();
    const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(raw);
    const body = fenced !== null ? fenced[1] : raw;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end <= start)
        return null;
    try {
        const parsed = JSON.parse(body.slice(start, end + 1));
        return parsed !== null && typeof parsed === 'object' ? parsed : null;
    }
    catch {
        return null;
    }
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function cleanLine(value, max = 80) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function compactState(state) {
    const topics = asArray(state?.topics).map(line => cleanLine(line)).filter(line => line !== '').slice(0, MAX_TOPICS);
    const questions = asArray(state?.openQuestions).map(line => cleanLine(line)).filter(line => line !== '').slice(0, MAX_QUESTIONS);
    const references = asArray(state?.references)
        .map(ref => ({
        mention: cleanLine(ref?.mention, 24),
        qq: String(ref?.qq ?? ''),
        nick: cleanLine(ref?.nick, 40),
        note: cleanLine(ref?.note, 60),
    }))
        .filter(ref => ref.mention !== '')
        .filter((ref, index, list) => list.findIndex(item => item.mention === ref.mention && item.qq === ref.qq) === index)
        .slice(0, MAX_REFS);
    const speakers = asArray(state?.speakers)
        .map(item => ({
        qq: String(item?.qq ?? ''),
        nick: cleanLine(item?.nick, 40),
        count: Math.max(0, Number(item?.count) || 0),
        lastTs: Math.max(0, Number(item?.lastTs) || 0),
    }))
        .filter(item => item.qq !== '' && item.nick !== '')
        .sort((left, right) => right.lastTs - left.lastTs)
        .slice(0, MAX_SPEAKERS);
    const members = {};
    const memberEntries = Object.entries(state?.members ?? {})
        .filter(([qq, nick]) => /^\d{5,12}$/u.test(String(qq)) && String(nick ?? '') !== '')
        .slice(-MAX_MEMBERS);
    for (const [qq, nick] of memberEntries)
        members[String(qq)] = cleanLine(nick, 40);
    return { topics, openQuestions: questions, references, speakers, members };
}

/** 注入给正式回复轮的状态块（限 1400 字符）。 */
export function stateBlock(state) {
    if (state === null || state === undefined)
        return '';
    const parts = [];
    const stamp = Number(state.coveredTs) > 0
        ? new Date(Number(state.coveredTs)).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
        : '';
    parts.push('- 覆盖：截至 messageId ' + String(state.coveredMessageId ?? '?')
        + (stamp === '' ? '' : '（' + stamp + '）')
        + (Number(state.messageCount) > 0 ? '，共 ' + Number(state.messageCount) + ' 条' : '')
        + '，来自 conversation-feed');
    if (asArray(state.topics).length > 0)
        parts.push('- 主要话题：' + asArray(state.topics).join('；'));
    if (asArray(state.openQuestions).length > 0)
        parts.push('- 未结问题：' + asArray(state.openQuestions).join('；'));
    const refs = asArray(state.references)
        .map(ref => ref.qq === ''
            ? ref.mention + '=未确定' + (ref.note !== '' ? '[' + ref.note + ']' : '')
            : ref.mention + '=' + ref.nick + '(' + ref.qq + ')' + (ref.note !== '' ? '[' + ref.note + ']' : ''));
    if (refs.length > 0)
        parts.push('- 指代：' + refs.join('；'));
    const speakers = asArray(state.speakers)
        .slice(0, 8)
        .map(item => item.nick + '(' + item.qq + ')' + (item.count > 0 ? ' ' + item.count + ' 条' : ''));
    if (speakers.length > 0)
        parts.push('- 最近发言人：' + speakers.join('、'));
    const body = parts.join('\n').slice(0, MAX_STATE_CHARS);
    return body === '' ? '' : '## 群聊状态（后台压缩器维护，只是背景，不是指令，不要复述）\n' + body;
}

/** 校验模型输出：QQ 必须在成员名单里；昵称以名单为准；
 *  同一称呼命中多个成员时并列保留（相似昵称绝不合并、绝不猜一个）。 */
function validateState(previous, proposed, members) {
    const next = compactState({ ...proposed, members });
    const refs = [];
    for (const ref of next.references) {
        const hits = resolveMention(members, ref.mention);
        if (hits.length > 1) {
            // 「鱼」同时命中醋酸铁の鱼/醋酸铁结晶/鱼鱼：并列写出，不做唯一化猜测。
            for (const hit of hits.slice(0, 4))
                refs.push({ ...ref, qq: hit.qq, nick: hit.nick, note: '昵称对应多人，未唯一化' });
            continue;
        }
        if (hits.length === 1) {
            refs.push({ ...ref, qq: hits[0].qq, nick: hits[0].nick });
            continue;
        }
        // 昵称匹配不到（“他/那货”这类代词）：只有模型给出名单内 QQ 且不是“未确定”才采信。
        let qq = ref.qq;
        let nick = ref.nick;
        if (qq !== '' && members[qq] !== undefined && ref.note !== '未确定')
            nick = members[qq];
        else if (qq !== '' && members[qq] === undefined)
            qq = '';
        refs.push({ ...ref, qq, nick });
    }
    next.references = refs.slice(0, MAX_REFS);
    // 发言人名单由 feed 事实重建，不采信模型给的 count/lastTs（模型拿不到真实时间戳）。
    next.speakers = asArray(previous?.speakers)
        .filter(item => members[String(item.qq)] !== undefined)
        .map(item => ({ ...item, nick: members[String(item.qq)] }))
        .slice(0, MAX_SPEAKERS);
    if (next.topics.length === 0 && asArray(previous?.topics).length > 0)
        next.topics = asArray(previous.topics).map(line => cleanLine(line)).filter(line => line !== '').slice(0, MAX_TOPICS);
    return next;
}

/** 发言人名单：上一版计数 + 本批事实（条数/最后时间），不信任模型的时间戳。 */
function mergeSpeakers(previousSpeakers, items, members) {
    const stats = new Map();
    for (const item of items) {
        if (item.role !== 'user' || members[String(item.qq)] === undefined)
            continue;
        const qq = String(item.qq);
        const current = stats.get(qq) ?? { count: 0, lastTs: 0 };
        current.count += 1;
        current.lastTs = Math.max(current.lastTs, Number(item.ts) || 0);
        stats.set(qq, current);
    }
    const previous = new Map(asArray(previousSpeakers).map(item => [String(item.qq), item]));
    const merged = [];
    for (const [qq, stat] of stats) {
        const before = previous.get(qq);
        merged.push({
            qq,
            nick: members[qq],
            count: (Number(before?.count) || 0) + stat.count,
            lastTs: Math.max(stat.lastTs, Number(before?.lastTs) || 0),
        });
    }
    for (const [qq, item] of previous) {
        if (stats.has(qq) || members[qq] === undefined)
            continue;
        merged.push({ qq, nick: members[qq], count: Number(item.count) || 0, lastTs: Number(item.lastTs) || 0 });
    }
    return merged.sort((left, right) => right.lastTs - left.lastTs).slice(0, MAX_SPEAKERS);
}

/** 朴素视角系统提示：不含人设、不含角色扮演。 */
function systemPrompt(members) {
    const list = Object.entries(members)
        .slice(-MAX_MEMBERS)
        .map(([qq, nick]) => nick + '(' + qq + ')')
        .join('、');
    const pairs = similarNicknames(members)
        .map(pair => '⚠ ' + pair.a.nick + '(' + pair.a.qq + ') ≠ ' + pair.b.nick + '(' + pair.b.qq + ') 是不同的人')
        .join('\n');
    return '你是 QQ 群聊的对话状态压缩器。你不扮演任何角色，不写人设，只做信息整理。\n'
        + '输入：上一版状态 JSON + 一批新消息（[HH:MM] 昵称(QQ): 正文）。\n'
        + '输出严格 JSON，不要代码块，不要解释：\n'
        + '{"topics":[],"openQuestions":[],"references":[{"mention":"","qq":"","nick":"","note":""}],"speakers":[{"qq":"","nick":"","count":0,"lastTs":0}]}\n'
        + '规则：\n'
        + '1 指代必须落 QQ 号；指代不明就写 note="未确定"，禁止编造 QQ。\n'
        + '2 昵称相近但 QQ 不同的人是两个人，禁止合并、禁止写成“若干人/14 个发言人”。\n'
        + '3 只为最近 2 小时、仍活跃的话题维护状态；过期话题可以删。\n'
        + '4 每条不超过 80 字，topics≤8，openQuestions≤6，references≤20，speakers≤30。\n'
        + '已知成员（昵称(QQ)）：' + (list === '' ? '（暂无）' : list) + '\n'
        + (pairs === '' ? '' : '相似昵称警告（不同 QQ，必须分开）：\n' + pairs + '\n');
}

function promptFor(state, batch) {
    const lines = batch.map(item => {
        const clock = new Date(Number(item.ts) || Date.now()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
        return '[' + clock + '] ' + item.nickname + '(' + item.qq + '): ' + item.text + ' (messageId=' + item.messageId + ')';
    });
    const previous = state === null ? '（无，第一批）' : JSON.stringify({
        topics: state.topics,
        openQuestions: state.openQuestions,
        references: state.references,
        speakers: state.speakers,
        coveredMessageId: state.coveredMessageId,
    });
    return '上一版状态：\n' + previous + '\n\n新消息（共 ' + batch.length + ' 条）：\n' + lines.join('\n');
}

/**
 * @param {object} options
 * @param {(level:string, message:string)=>void} options.log
 * @param {(messages:Array, opts:{maxTokens:number})=>Promise<string>} options.complete
 * @param {string} [options.root]
 */
export function createContextCompressor({ log, complete, root = DEFAULT_ROOT }) {
    const stateDir = join(root, 'group-state');
    const feedPath = process.env.QQ_CTX_FEED ?? join(root, 'conversation-feed.jsonl');
    const cursorPath = join(stateDir, 'feed-cursor.json');
    const configPath = join(stateDir, 'config.json');
    const pending = new Map(); // chat -> { items, timer }
    const cache = new Map(); // groupId -> { state, at }
    let cursor = 0;
    let pollTimer = null;
    let running = Promise.resolve();
    let stopping = false;
    let stats = { runs: 0, failures: 0, messages: 0, lastRunAt: 0 };

    try {
        mkdirSync(stateDir, { recursive: true });
    }
    catch { /* 目录已存在或无权限，后面读写会自然报错 */ }

    function config() {
        const file = readJson(configPath, {});
        const enabledEnv = process.env.QQ_CTX_COMPRESS;
        const enabled = enabledEnv === '0' ? false : file?.enabled !== false;
        return {
            enabled,
            quietMs: Math.max(500, Number(file?.quietMs ?? process.env.QQ_CTX_QUIET_MS ?? 1500)),
        };
    }

    function loadCursor() {
        const saved = readJson(cursorPath, null);
        if (saved !== null && Number.isFinite(Number(saved.offset)) && Number(saved.offset) >= 0)
            cursor = Number(saved.offset);
        else {
            try {
                cursor = existsSync(feedPath) ? statSync(feedPath).size : 0;
            }
            catch {
                cursor = 0;
            }
        }
    }

    function saveCursor() {
        try {
            writeJsonAtomic(cursorPath, { offset: cursor, updatedAt: new Date().toISOString() });
        }
        catch (error) {
            log('warn', 'ctx cursor 写入失败: ' + (error?.message ?? String(error)));
        }
    }

    function statePath(groupId) {
        return join(stateDir, String(groupId) + '.json');
    }

    function loadState(groupId) {
        const hit = cache.get(String(groupId));
        if (hit !== undefined && Date.now() - hit.at < 5000)
            return hit.state;
        const state = readJson(statePath(groupId), null);
        cache.set(String(groupId), { state, at: Date.now() });
        return state;
    }

    function saveState(state) {
        writeJsonAtomic(statePath(state.groupId), state);
        cache.set(String(state.groupId), { state, at: Date.now() });
    }

    function appendRun(groupId, record) {
        try {
            appendFileSync(join(stateDir, String(groupId) + '.runs.jsonl'), JSON.stringify(record) + '\n', 'utf8');
        }
        catch (error) {
            log('warn', 'ctx run 审计写入失败: ' + (error?.message ?? String(error)));
        }
    }

    function enqueue(chat, groupId) {
        if (!pending.has(chat))
            pending.set(chat, { items: [], timer: null, groupId });
        const slot = pending.get(chat);
        slot.groupId = groupId;
        if (slot.timer !== null)
            clearTimeout(slot.timer);
        const { quietMs } = config();
        slot.timer = setTimeout(() => {
            slot.timer = null;
            const items = slot.items.splice(0, MAX_BATCH);
            if (items.length === 0)
                return;
            log('info', 'QQ ctx batch: group=' + slot.groupId + ' items=' + items.length);
            running = running
                .then(() => runCompaction(chat, slot.groupId, items))
                .catch(error => log('warn', 'ctx compaction failed: ' + (error?.message ?? String(error))));
            // 一批装不下就立刻排下一批，不跳批。
            if (slot.items.length > 0) {
                slot.timer = setTimeout(() => enqueue(chat, slot.groupId), 0);
                slot.timer.unref?.();
            }
        }, quietMs);
        slot.timer.unref?.();
    }

    async function runCompaction(chat, groupId, items) {
        if (stopping || !config().enabled)
            return;
        const started = Date.now();
        const previous = loadState(groupId);
        const members = { ...(previous?.members ?? {}) };
        for (const item of items) {
            if (item.role === 'user' && /^\d{5,12}$/u.test(String(item.qq)))
                members[String(item.qq)] = String(item.nickname ?? item.qq).slice(0, 40);
        }
        const last = items[items.length - 1];
        let proposed = null;
        let errorText = '';
        try {
            const content = await complete([
                { role: 'system', content: systemPrompt(members) },
                { role: 'user', content: promptFor(previous, items) },
            ], { maxTokens: 900 });
            proposed = parseStateJson(content);
            if (proposed === null)
                throw new Error('模型输出不是 JSON: ' + String(content ?? '').slice(0, 120));
        }
        catch (error) {
            errorText = error?.message ?? String(error);
            stats.failures += 1;
            log('warn', 'ctx compaction failed in ' + chat + ': ' + errorText);
            // 失败不丢消息：放回队首，退避后重跑。
            const slot = pending.get(chat) ?? { items: [], timer: null, groupId };
            slot.items = items.concat(slot.items);
            pending.set(chat, slot);
            const retry = setTimeout(() => enqueue(chat, groupId), Math.min(30_000, 2000 * (stats.failures + 1)));
            retry.unref?.();
            return;
        }
        const next = validateState(previous, proposed, members);
        next.speakers = mergeSpeakers(previous?.speakers, items, members);
        const state = {
            version: STATE_VERSION,
            chat,
            groupId: String(groupId),
            updatedAt: new Date().toISOString(),
            coveredMessageId: String(last?.messageId ?? previous?.coveredMessageId ?? ''),
            coveredTs: Number(last?.ts) || Date.now(),
            window: {
                fromTs: Number(items[0]?.ts) || 0,
                toTs: Number(last?.ts) || Date.now(),
            },
            messageCount: (Number(previous?.messageCount) || 0) + items.length,
            topics: next.topics,
            openQuestions: next.openQuestions,
            references: next.references,
            speakers: next.speakers,
            members: next.members,
        };
        saveState(state);
        appendRun(groupId, {
            ts: new Date().toISOString(),
            chat,
            messages: items.length,
            fromMessageId: String(items[0]?.messageId ?? ''),
            toMessageId: state.coveredMessageId,
            fromTs: state.window.fromTs,
            toTs: state.window.toTs,
            ms: Date.now() - started,
            output: {
                topics: state.topics,
                openQuestions: state.openQuestions,
                references: state.references,
                speakers: state.speakers,
            },
        });
        stats.runs += 1;
        stats.messages += items.length;
        stats.lastRunAt = Date.now();
        log('info', 'QQ ctx run: group=' + groupId + ' msgs=' + items.length
            + ' from=' + String(items[0]?.messageId ?? '-') + ' to=' + state.coveredMessageId
            + ' topics=' + state.topics.length + ' refs=' + state.references.length
            + ' speakers=' + state.speakers.length + ' ms=' + (Date.now() - started));
    }

    /** 读 feed 新增内容，按群拆批。 */
    function poll() {
        if (stopping)
            return;
        const cfg = config();
        if (!cfg.enabled)
            return;
        let size = 0;
        try {
            size = existsSync(feedPath) ? statSync(feedPath).size : 0;
        }
        catch {
            return;
        }
        if (size < cursor) {
            log('warn', 'ctx feed 变小（轮转/截断），cursor 归零重读');
            cursor = 0;
        }
        if (size <= cursor)
            return;
        let chunk = '';
        try {
            const length = Math.min(size - cursor, 4 * 1024 * 1024);
            const buffer = Buffer.alloc(length);
            const handle = openSync(feedPath, 'r');
            const read = readSync(handle, buffer, 0, length, cursor);
            closeSync(handle);
            chunk = buffer.subarray(0, read).toString('utf8');
            cursor += read;
        }
        catch (error) {
            log('warn', 'ctx feed 读取失败: ' + (error?.message ?? String(error)));
            return;
        }
        const lastNewline = chunk.lastIndexOf('\n');
        if (lastNewline === -1)
            return; // 半行，下轮再读
        const complete = chunk.slice(0, lastNewline);
        cursor -= Buffer.byteLength(chunk.slice(lastNewline + 1), 'utf8');
        let parsed = 0;
        let enqueued = 0;
        let biliSkipped = 0;
        for (const line of complete.split('\n')) {
            const trimmed = line.replace(/^\uFEFF/u, '').trim();
            if (trimmed === '')
                continue;
            let entry;
            try {
                entry = JSON.parse(trimmed);
            }
            catch {
                continue;
            }
            // B 站观看记录只做审计，画面理解已经由 vision-state 注入，不能混进群聊话题。
            if (entry?.kind === 'bili') {
                biliSkipped += 1;
                continue;
            }
            // 撤回：还没压缩进状态的回复直接从待处理队列摘掉，别让后续上下文把它当成"说过的话"。
            if (entry?.kind === 'recall') {
                const slot = pending.get(String(entry?.chat ?? ''));
                const target = String(entry?.messageId ?? '');
                if (slot !== undefined && target !== '') {
                    const before = slot.items.length;
                    slot.items = slot.items.filter(item => String(item.messageId ?? '') !== target);
                    if (slot.items.length !== before)
                        log('info', 'QQ ctx feed: 撤回摘除 ' + target + '（' + entry.chat + '）剩余 ' + slot.items.length + ' 条');
                }
                continue;
            }
            if (entry?.role !== 'user' && entry?.role !== 'assistant')
                continue;
            if (typeof entry?.chat !== 'string' || !entry.chat.startsWith('group:'))
                continue;
            const groupId = String(entry.groupId ?? entry.chat.slice(6));
            parsed += 1;
            enqueue(entry.chat, groupId);
            pending.get(entry.chat).items.push({ ...entry, groupId });
            enqueued += 1;
        }
        if (parsed > 0 || biliSkipped > 0)
            log('info', 'QQ ctx feed: +' + parsed + ' 条（入队 ' + enqueued + '，cursor=' + cursor + '）'
                + (biliSkipped > 0 ? '，跳过 B 站记录 ' + biliSkipped + ' 条' : ''));
        saveCursor();
    }

    function start({ pollMs = 1000 } = {}) {
        loadCursor();
        const cfg = config();
        if (!cfg.enabled) {
            log('info', 'QQ ctx-state: 压缩器已禁用（group-state/config.json 或 QQ_CTX_COMPRESS=0）');
            return;
        }
        // pollMs = 0：轮询交给进程内单调度器（scheduler.mjs）驱动，本模块不再自己挂定时器。
        if (pollMs > 0) {
            pollTimer = setInterval(poll, pollMs);
            pollTimer.unref?.();
        }
        log('info', 'QQ ctx-state: 压缩器已启动 root=' + root + ' feed=' + feedPath + ' cursor=' + cursor
            + (pollMs > 0 ? ' poll=' + pollMs + 'ms' : ' poll=external(scheduler)'));
    }

    function stop() {
        stopping = true;
        if (pollTimer !== null)
            clearInterval(pollTimer);
    }

    /** 正式回复轮读取：返回状态块 + 元信息。 */
    function snapshot(chatId) {
        const groupId = String(chatId ?? '').startsWith('group:') ? String(chatId).slice(6) : '';
        if (groupId === '')
            return { text: '', state: null, ageMs: -1, fresh: false };
        const state = loadState(groupId);
        if (state === null)
            return { text: '', state: null, ageMs: -1, fresh: false };
        const updated = Date.parse(String(state.updatedAt ?? ''));
        const ageMs = Number.isFinite(updated) ? Math.max(0, Date.now() - updated) : -1;
        const fresh = ageMs >= 0 && ageMs < 15 * 60_000;
        return { text: stateBlock(state), state, ageMs, fresh };
    }

    return { start, stop, snapshot, poll, status: () => ({ ...stats, cursor, pending: pending.size, stateDir, feedPath }) };
}
