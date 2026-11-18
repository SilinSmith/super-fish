/**
 * 历史注入卫生层：在代理把 messages 交给上游之前，把「不是对话内容」的东西
 * 折叠成结构化事实，而不是整段删掉。
 *
 * 五类处理（与主人的验收口径一一对应）：
 *  1. assistant 正文里裸写的 <tool_call>…</tool_call> → 一行 `[调用] name(args)`。
 *     这类文本宿主没有执行（没有对应 tool 结果），但「它试过调什么」是事实，不能连事实一起删。
 *  2. repeat-nudge / repeat-detected / 【重说】是当步指令，不是历史内容；
 *     去重与丢弃由 proxy 的 SCAFFOLD_KINDS 负责，这里只把它们从事实集合里排除。
 *  3. notice / recall 事件 → `[事件] …` 一行；超过一回合的直接丢（指令已过期）。
 *  4. 同回合 read_image 按内容 sha256 幂等：第二次起只回「已读，内容未变」，不再带图。
 *  5. runtime / time 快照每回合只留一行 `now=…`，不再逐步重复整段。
 *
 * 所有函数都是纯函数，不读写磁盘、不依赖宿主状态，便于离线重放断言。
 */

import { createHash } from 'node:crypto';

/** notice / recall 信封里的事件类型：只作上下文，不是谁说的话。 */
const EVENT_KINDS = new Set(['notice', 'recall']);

/** 运行环境快照：占 686 字符，真正有用的只有 now/cwd/policy 三个值。 */
const RUNTIME_HEAD_RE = /^Current runtime context\b/u;
const TIME_HEAD_RE = /^Time sampled while preparing turn\b/u;

const FUNCTION_BLOCK_RE = /<tool_call>\s*([\s\S]*?)<\/tool_call>/giu;
const FUNCTION_ONE_RE = /<function[=\s]+(?:name=)?"?([^">\s]+)"?\s*>([\s\S]*?)<\/function>/giu;
const PARAM_BLOCK_RE = /<parameter[=\s]+(?:name=)?"?([^">\s]+)"?\s*>([\s\S]*?)<\/parameter>/giu;

function textOf(message) {
    const content = message?.content;
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content.filter(part => part?.type === 'text' && typeof part.text === 'string')
        .map(part => part.text)
        .join('\n');
}

function withText(message, text) {
    if (typeof message.content === 'string')
        return { ...message, content: text };
    const others = Array.isArray(message.content)
        ? message.content.filter(part => part?.type !== 'text')
        : [];
    return { ...message, content: [{ type: 'text', text }, ...others] };
}

/** 键排序后的紧凑 JSON：两侧（XML 正文 / JSON 行）算出来的事实必须一致。 */
export function canonicalArgs(args) {
    const keys = Object.keys(args ?? {}).sort();
    const sorted = {};
    for (const key of keys)
        sorted[key] = String(args[key] ?? '');
    return JSON.stringify(sorted);
}

/** 从裸写的 tool_call 文本里抠出调用与参数（宿主未执行的那些）。 */
export function parseToolCallMarkup(text) {
    const calls = [];
    for (const block of String(text ?? '').matchAll(FUNCTION_BLOCK_RE)) {
        for (const fn of block[1].matchAll(FUNCTION_ONE_RE)) {
            const args = {};
            for (const param of fn[2].matchAll(PARAM_BLOCK_RE))
                args[param[1]] = param[2].trim();
            calls.push({ name: fn[1], args });
        }
    }
    return calls;
}

/** 一行调用事实。real=true 表示宿主真的执行过（结构里有 tool_calls），
 *  false 表示只是模型把调用写成了正文、没有结果可用。 */
export function renderCallFact(call, real) {
    return '[调用' + (real ? '' : '未执行') + '] ' + call.name + '(' + canonicalArgs(call.args) + ')';
}

/** ① 正文里的裸调用换成一行事实；结构里已有的调用不再重复记。 */
export function stripToolCallMarkup(message) {
    const text = textOf(message);
    if (!/<tool_call/iu.test(text))
        return { message, facts: [] };
    const structural = (Array.isArray(message?.tool_calls) ? message.tool_calls : [])
        .map(call => call?.function?.name + '\u0000' + canonicalArgs(safeJson(call?.function?.arguments)));
    const facts = [];
    for (const call of parseToolCallMarkup(text)) {
        const real = structural.includes(call.name + '\u0000' + canonicalArgs(call.args));
        if (!real)
            facts.push(renderCallFact(call, false));
    }
    let rest = String(text).replace(FUNCTION_BLOCK_RE, '').replace(/<\|?\/?\s*tool_call\s*\|?>/giu, '').trim();
    // 只删干净了带参数的块、还剩半个标签的坏行：整条文本放弃（它本来就不是回复）。
    if (/<\/?(?:tool_call|function|parameter)/iu.test(rest))
        rest = rest.replace(/<\/?(?:tool_call|function|parameter)[^>]*>/giu, '').trim();
    const body = [rest, ...facts].filter(line => line !== '').join('\n');
    return { message: withText(message, body), facts };
}

function safeJson(raw) {
    try {
        const parsed = JSON.parse(String(raw ?? '{}'));
        return parsed !== null && typeof parsed === 'object' ? parsed : {};
    }
    catch {
        return {};
    }
}

/** ⑤ runtime / time 压成一行所需的字段；返回 null 表示这条不是快照。 */
export function compactScaffold(text) {
    const raw = String(text ?? '');
    if (RUNTIME_HEAD_RE.test(raw)) {
        const pick = pattern => (pattern.exec(raw)?.[1] ?? '').trim();
        const cwd = pick(/Current working directory:\s*"([^"]*)"/u);
        const policy = pick(/DSH file policy:\s*([^.\n]*)/u);
        const approvals = /Approval prompts are enabled/u.test(raw) ? 'on' : 'off';
        return { kind: 'runtime', fields: 'cwd="' + cwd + '" policy=' + policy + ' approvals=' + approvals };
    }
    if (TIME_HEAD_RE.test(raw)) {
        const now = (/Time sampled while preparing turn (\d+), step (\d+):\s*([^\n]*)/u.exec(raw) ?? []);
        const stamp = String(now[3] ?? '').trim();
        return stamp === '' ? null : { kind: 'time', now: stamp };
    }
    return null;
}

/** ③ notice / recall 信封 → 元数据行 + 本回合指令；返回 null 表示不是事件。 */
export function noticeOf(message) {
    const text = textOf(message);
    const at = text.indexOf('【元】');
    if (at === -1)
        return null;
    const head = text.slice(0, at).trim();
    const end = text.indexOf('\n', at);
    const jsonText = end === -1 ? text.slice(at + 3) : text.slice(at + 3, end);
    let evt;
    try {
        evt = JSON.parse(jsonText);
    }
    catch {
        return null;
    }
    if (evt === null || typeof evt !== 'object' || !EVENT_KINDS.has(String(evt.kind ?? '')))
        return null;
    return { evt, head, body: end === -1 ? '' : text.slice(end + 1).trim() };
}

export function renderEventLine(evt) {
    const kind = String(evt.kind ?? '');
    const traceId = String(evt.traceId ?? '').split('-').slice(0, 2).join('-');
    const actor = evt.actor ?? {};
    const who = String(actor.nick ?? '') !== '' ? actor.nick + '(' + String(actor.qq ?? '') + ')' : String(actor.qq ?? '未知');
    const target = (Array.isArray(evt.targets) ? evt.targets : []).find(item => item?.rel !== 'at');
    const what = String(evt.notice?.subType ?? evt.notice?.type ?? '');
    const targetText = target === undefined ? '' : '→' + String(target.nick ?? '') + '(' + String(target.qq ?? '') + ')';
    const detail = String(evt.text ?? '').replace(/\s+/gu, ' ').trim();
    const tail = detail === '' ? '' : '：' + detail.slice(0, 120);
    return '[事件] ' + kind + (what === '' ? '' : ':' + what) + ' ' + who + targetText + tail
        + (traceId === '' ? '' : ' trace=' + traceId);
}

/** 回合起点：最后一条真实 user（快照/事件行不算）。 */
export function realTurnStart(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'user')
            continue;
        const text = textOf(message).trimStart();
        if (RUNTIME_HEAD_RE.test(text) || TIME_HEAD_RE.test(text) || text.startsWith('【运行环境】') || text.startsWith('【时间】'))
            continue;
        if (noticeOf(message) !== null)
            continue;
        return index;
    }
    return -1;
}

/** ④ 同回合 read_image 按内容 sha256 幂等。返回替换后的消息数组与统计。 */
export function dedupeReadImageByContent(messages, { turnStart } = {}) {
    const start = Number.isInteger(turnStart) && turnStart >= 0 ? turnStart : realTurnStart(messages);
    if (start < 0)
        return { messages, replaced: 0 };
    const nameById = new Map();
    const pathById = new Map();
    for (let index = start; index < messages.length; index += 1) {
        const calls = messages[index]?.tool_calls;
        if (!Array.isArray(calls))
            continue;
        for (const call of calls) {
            const name = call?.function?.name;
            if (typeof call?.id !== 'string' || typeof name !== 'string')
                continue;
            nameById.set(call.id, name);
            if (name === 'read_image') {
                const args = safeJson(call.function?.arguments);
                pathById.set(call.id, String(args.path ?? args.file_path ?? args.file ?? args.image ?? ''));
            }
        }
    }
    const seen = new Set();
    let replaced = 0;
    const next = messages.map((message, index) => {
        if (index < start || message?.role !== 'tool')
            return message;
        if (nameById.get(message.tool_call_id ?? '') !== 'read_image')
            return message;
        const digest = contentDigest(message);
        const path = pathById.get(message.tool_call_id ?? '') ?? '';
        const key = digest !== ''
            ? 'sha:' + digest
            : (path !== '' ? 'path:' + path : '');
        if (key === '' || !seen.has(key)) {
            if (key !== '')
                seen.add(key);
            return message;
        }
        replaced += 1;
        return { ...message, content: '已读，内容未变（sha=' + digest.slice(0, 12) + '）' };
    });
    return { messages: next, replaced };
}

/** 图片内容的 sha256：宿主 attachment 自带 attachmentId（sha256:<hex>）优先，
 *  其次是 base64 图片部件，最后看结果文本里带的 sha256 引用。 */
export function contentDigest(message) {
    const content = message?.content;
    if (Array.isArray(content)) {
        for (const part of content) {
            const id = String(part?.attachment?.attachmentId ?? '');
            if (/^sha256:[0-9a-f]{64}$/iu.test(id))
                return id.slice(7).toLowerCase();
            const b64 = part?.image_url?.url ?? part?.source?.data ?? part?.data ?? '';
            if (typeof b64 === 'string' && b64 !== '')
                return sha256(b64.replace(/^data:[^,]*,/u, ''));
        }
    }
    const text = textOf(message);
    const hit = /sha256:([0-9a-f]{64})/iu.exec(text) ?? /\bsha=([0-9a-f]{8,64})/iu.exec(text);
    return hit === null ? '' : hit[1].toLowerCase();
}

/** sha256（hex）：图片 base64 与文本共用同一个摘要口径。 */
export function sha256(input) {
    return createHash('sha256').update(String(input ?? ''), 'utf8').digest('hex');
}

/**
 * 全套卫生处理。读图去重先做（它按原下标算回合起点），再做事件/快照归位与
 * 调用残片剥离——后两步会删消息，下标会变。
 * @returns {{ messages: unknown[], stats: object }}
 */
export function applyHistoryHygiene(messages, { turnStart, keepFrom } = {}) {
    const start = Number.isInteger(turnStart) && turnStart >= 0 ? turnStart : realTurnStart(messages);
    // 最近几轮的事件仍是对话原文（私聊里拍一拍就是这一轮的入站内容），
    // 只有比 keepFrom 更早的事件才算过期、压成一行索引。
    const eventKeepFrom = Number.isInteger(keepFrom) && keepFrom >= 0 ? Math.min(keepFrom, start) : start;
    const stats = { toolCallFacts: 0, markupChars: 0, events: 0, staleEvents: 0, scaffolds: 0, scaffoldChars: 0, readImageDup: 0 };
    const deduped = dedupeReadImageByContent(messages, { turnStart: start });
    stats.readImageDup = deduped.replaced;
    let newestScaffoldIndex = -1;
    let runtimeFields = '';
    let clockNow = '';
    const staged = [];
    for (let index = 0; index < deduped.messages.length; index += 1) {
        const message = deduped.messages[index];
        if (message === null || typeof message !== 'object') {
            staged.push({ index, message });
            continue;
        }
        if (message.role === 'user') {
            const text = textOf(message);
            const scaffold = compactScaffold(text);
            if (scaffold !== null) {
                stats.scaffolds += 1;
                stats.scaffoldChars += text.length;
                newestScaffoldIndex = Math.max(newestScaffoldIndex, index);
                if (scaffold.kind === 'runtime')
                    runtimeFields = scaffold.fields;
                else
                    clockNow = scaffold.now;
                continue; // 先摘掉，最后只放回一行
            }
            const notice = noticeOf(message);
            if (notice !== null) {
                if (index < eventKeepFrom) {
                    stats.staleEvents += 1;
                    continue;
                }
                stats.events += 1;
                const line = renderEventLine(notice.evt);
                const body = notice.body;
                staged.push({ index, message: withText(message, body === '' ? line : line + '\n' + body) });
                continue;
            }
            staged.push({ index, message });
            continue;
        }
        if (message.role === 'assistant') {
            const before = textOf(message).length;
            const stripped = stripToolCallMarkup(message);
            stats.toolCallFacts += stripped.facts.length;
            stats.markupChars += Math.max(0, before - textOf(stripped.message).length);
            const empty = textOf(stripped.message).trim() === '' && !(Array.isArray(message.tool_calls) && message.tool_calls.length > 0);
            if (empty)
                continue;
            staged.push({ index, message: stripped.message });
            continue;
        }
        staged.push({ index, message });
    }
    if (runtimeFields !== '' || clockNow !== '') {
        // 快照只留最新一份、压成一行（时间 + 运行环境都在这行里）；位置保持原序。
        // 前缀保留 "Current runtime context"，让代理把它继续当宿主脚手架而不是用户发言。
        const line = 'Current runtime context (compacted): '
            + [clockNow === '' ? '' : 'now=' + clockNow, runtimeFields].filter(part => part !== '').join(' ');
        const at = staged.findIndex(item => item.index > newestScaffoldIndex);
        const entry = { index: newestScaffoldIndex, message: { role: 'user', content: line } };
        if (at === -1)
            staged.push(entry);
        else
            staged.splice(at, 0, entry);
    }
    return { messages: staged.map(item => item.message), stats };
}
