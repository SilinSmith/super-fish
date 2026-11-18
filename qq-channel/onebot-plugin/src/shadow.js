/**
 * ⑥ 影子层：只记录、绝不发送。
 *
 * 每条消息写三类行：
 *   decision       判定结果（必写）
 *   would_reply    如果回会回什么（判定为回且 dryRunModel=true 时）
 *   legacy_observe 旧插件实际是否回复（到点用只读历史查询回填）
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { chatKeyOf } from './registry.js';

function truncate(text, max) {
    const value = String(text ?? '');
    const chars = [...value];
    return chars.length <= max ? value : chars.slice(0, max).join('') + '…';
}

function messageText(message) {
    const content = message?.content;
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content
        .map(part => (typeof part?.text === 'string' ? part.text : ''))
        .join('')
        .trim();
}

export function createShadow({ ctx, registry, connection, log, createUserMessage, getConfig }) {
    let seq = 0;
    const stats = { decisions: 0, wouldReplies: 0, observations: 0, errors: 0 };

    function note(level, message, data) {
        try {
            log?.(level, message, data);
        }
        catch {
            // ignore
        }
    }

    function append(line) {
        const cfg = getConfig();
        try {
            mkdirSync(dirname(cfg.shadow.path), { recursive: true });
            appendFileSync(cfg.shadow.path, JSON.stringify(line) + '\n', 'utf8');
            return true;
        }
        catch (error) {
            stats.errors += 1;
            note('warn', '影子日志写入失败', { error: error?.message ?? String(error) });
            return false;
        }
    }

    function nextId() {
        seq += 1;
        return 'sh_' + Date.now().toString(36) + '_' + seq.toString(36);
    }

    function recordDecision({ id, batch, decision, scene, cfg }) {
        stats.decisions += 1;
        return append({
            type: 'decision',
            id,
            ts: new Date().toISOString(),
            sample: batch.sample === true,
            cfgVersion: cfg.cfgVersion,
            sceneKey: scene.sceneKey,
            chatId: batch.chatId,
            messageIds: batch.messageIds,
            tailMessageId: batch.tailMessageId,
            sender: { qq: String(batch.userId), nickname: batch.nickname },
            textPreview: truncate(batch.text, 200),
            segmentTypes: [...new Set((Array.isArray(batch.segments) ? batch.segments : [])
                .map(segment => String(segment?.type ?? '')))],
            decision: {
                reply: decision.reply,
                rule: decision.rule,
                reason: decision.reason,
                details: decision.details,
            },
            wouldReply: null,
            legacy: { replied: null },
        });
    }

    async function runWouldReply({ id, batch, prompt, cfg }) {
        const key = chatKeyOf(batch.kind, batch.chatId);
        const startedAt = Date.now();
        return registry.runExclusive(key, async () => {
            const entry = await registry.ensureAgent(key);
            const sessionId = entry.sessionId;
            if (sessionId === null)
                throw new Error('会话 id 不可用');

            const texts = [];
            let off;
            const result = await new Promise(resolve => {
                let settled = false;
                const finish = (error, reason) => {
                    if (settled)
                        return;
                    settled = true;
                    clearTimeout(timer);
                    try {
                        off?.();
                    }
                    catch {
                        // ignore
                    }
                    resolve({ error, reason });
                };
                const timer = setTimeout(() => {
                    finish('timeout', 'turn/end 超时');
                }, cfg.runtime.turnTimeoutMs);
                timer.unref?.();

                try {
                    off = ctx.on('session/event', (eventSession, event) => {
                        if (eventSession?.id !== sessionId)
                            return;
                        if (event?.type === 'assistant/message') {
                            const text = messageText(event?.data?.message);
                            if (text !== '')
                                texts.push(text);
                            return;
                        }
                        if (event?.type === 'turn/end') {
                            const reason = event?.data?.reason ?? {};
                            const error = reason?.error === undefined
                                ? null
                                : String(reason.error?.message ?? reason.error);
                            finish(error, String(reason?.kind ?? ''));
                        }
                    });
                }
                catch (error) {
                    finish(error?.message ?? String(error), 'subscribe');
                    return;
                }

                try {
                    entry.agent.followup(createUserMessage({
                        content: [{ type: 'text', text: prompt }],
                        source: { kind: 'plugin:qq-onebot' },
                    }));
                }
                catch (error) {
                    finish(error?.message ?? String(error), 'followup');
                }
            });

            const ms = Date.now() - startedAt;
            stats.wouldReplies += 1;
            const replyText = texts.join('\n');
            append({
                type: 'would_reply',
                id,
                ts: new Date().toISOString(),
                sample: batch.sample === true,
                sceneKey: sceneKeyForBatch(batch),
                sessionId,
                ms,
                text: truncate(replyText, cfg.shadow.maxReplyChars),
                error: result.error,
                reason: result.reason,
                promptPreview: truncate(prompt, 400),
            });
            return { text: texts.join('\n'), error: result.error, sessionId, ms };
        });
    }

    function sceneKeyForBatch(batch) {
        // batch.kind 是 'group' | 'dm'；场景键与 prompt 层保持同一规则。
        return (batch.kind === 'group' ? 'group:' : 'private:') + String(batch.chatId);
    }

    async function queryHistory(batch, selfId) {
        // 样例 batch 的 message_id 是编的（900001/900002），打真实 API 只会
        // 在 OneBot 协议端 里留下 get_group_msg_history message_id=900002 这种脏请求。
        if (batch.sample === true)
            return { ok: false, error: 'sample: 回放不访问真实历史接口' };
        if (batch.tailMessageId === null || batch.tailMessageId === undefined)
            return { ok: false, error: '无 message_id，无法锚定历史' };
        const params = batch.kind === 'group'
            ? { group_id: Number(batch.groupId), message_id: Number(batch.tailMessageId), count: 20, reverse_order: false }
            : { user_id: Number(batch.chatId), message_id: Number(batch.tailMessageId), count: 20, reverse_order: false };
        const action = batch.kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history';
        try {
            const data = await connection.callReadOnly(action, params, 10000, { sample: batch.sample === true });
            const messages = Array.isArray(data?.messages)
                ? data.messages
                : (Array.isArray(data) ? data : []);
            return { ok: true, messages };
        }
        catch (error) {
            return { ok: false, error: error?.message ?? String(error) };
        }
    }

    function findBotReply(messages, batch, selfId) {
        const since = Number(batch.time ?? 0) - 5;
        const found = [];
        for (const item of messages) {
            const uid = String(item?.sender?.user_id ?? item?.user_id ?? '');
            const messageId = String(item?.message_id ?? '');
            const time = Number(item?.time ?? 0);
            if (uid !== selfId)
                continue;
            if (messageId !== '' && messageId === String(batch.tailMessageId))
                continue;
            if (time !== 0 && time < since)
                continue;
            found.push(item);
        }
        if (found.length === 0)
            return null;
        found.sort((a, b) => Number(a?.time ?? 0) - Number(b?.time ?? 0));
        const first = found[0];
        return {
            messageId: String(first?.message_id ?? ''),
            text: typeof first?.raw_message === 'string'
                ? first.raw_message
                : messageText(first?.message),
            time: Number(first?.time ?? 0) > 0 ? Number(first.time) * 1000 : Date.now(),
        };
    }

    async function observeLegacy({ id, batch, decision, cfg, attempt = 0 }) {
        const selfId = String(cfg.bot.qq);
        const result = await queryHistory(batch, selfId);
        if (!result.ok) {
            stats.observations += 1;
            append({
                type: 'legacy_observe',
                id,
                ts: new Date().toISOString(),
                sample: batch.sample === true,
                sceneKey: sceneKeyForBatch(batch),
                legacy: { replied: null, error: result.error },
                attempts: attempt + 1,
            });
            return;
        }
        const reply = findBotReply(result.messages, batch, selfId);
        if (reply === null && decision.reply === true && attempt < 2) {
            const timer = setTimeout(() => {
                void observeLegacy({ id, batch, decision, cfg, attempt: attempt + 1 });
            }, 15000);
            timer.unref?.();
            return;
        }
        stats.observations += 1;
        append({
            type: 'legacy_observe',
            id,
            ts: new Date().toISOString(),
            sample: batch.sample === true,
            sceneKey: sceneKeyForBatch(batch),
            legacy: reply === null
                ? { replied: false, messageId: null, textPreview: null, error: null }
                : {
                    replied: true,
                    messageId: reply.messageId,
                    textPreview: truncate(reply.text, 200),
                    error: null,
                },
            legacyRepliedWithoutAddressed: reply !== null
                && decision.reply === false
                && decision.details?.addressed === false,
            attempts: attempt + 1,
        });
    }

    return {
        /**
         * 入口：写 decision；按需跑影子回合；到点观测旧插件。
         * 不 await 模型与观测，避免拖住入站处理。
         */
        handle({ batch, decision, prompt, scene, cfg }) {
            const id = nextId();
            recordDecision({ id, batch, decision, scene, cfg });
            note('info', '影子判定', {
                id,
                sample: batch.sample === true,
                chat: batch.chatId,
                reply: decision.reply,
                rule: decision.rule,
            });

            if (decision.reply && cfg.shadow.dryRunModel) {
                void runWouldReply({ id, batch, prompt, cfg }).catch(error => {
                    stats.errors += 1;
                    append({
                        type: 'would_reply',
                        id,
                        ts: new Date().toISOString(),
                        sample: batch.sample === true,
                        sceneKey: sceneKeyForBatch(batch),
                        sessionId: null,
                        ms: 0,
                        text: '',
                        error: error?.message ?? String(error),
                        reason: 'shadow-failed',
                        promptPreview: truncate(prompt, 400),
                    });
                    note('warn', '影子回合失败', { id, error: error?.stack ?? String(error) });
                });
            }

            const delay = Math.max(0, Number(cfg.shadow.observeReplyMs ?? 0));
            const timer = setTimeout(() => {
                void observeLegacy({ id, batch, decision, cfg });
            }, delay);
            timer.unref?.();
            return id;
        },
        stats() {
            return { ...stats };
        },
        /** 供撤回等模块写同一份 shadow.jsonl（仍只追加，不发送）。 */
        appendLine(line) {
            return append(line);
        },
    };
}

/** 样例回放：每行一条 OneBot 事件；once=true 时写标记避免重复回放。 */
export async function replaySamples({ path, markerPath, once, delayMs, onFrame, log }) {
    if (once && existsSync(markerPath)) {
        log?.('info', '样例已回放过，跳过', { markerPath });
        return 0;
    }
    const wait = Math.max(0, Number(delayMs ?? 0));
    if (wait > 0)
        await new Promise(resolve => {
            const timer = setTimeout(resolve, wait);
            timer.unref?.();
        });
    let text;
    try {
        text = readFileSync(path, 'utf8');
    }
    catch (error) {
        log?.('warn', '样例文件不可读，跳过回放', { path, error: error?.message ?? String(error) });
        return 0;
    }
    let count = 0;
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === '')
            continue;
        let frame;
        try {
            frame = JSON.parse(trimmed);
        }
        catch {
            log?.('warn', '样例行不是 JSON，已跳过', { preview: trimmed.slice(0, 160) });
            continue;
        }
        frame.sample = true;
        try {
            await onFrame(frame);
            count += 1;
        }
        catch (error) {
            log?.('warn', '样例回放失败', { error: error?.message ?? String(error) });
        }
    }
    if (once) {
        try {
            mkdirSync(dirname(markerPath), { recursive: true });
            writeFileSync(markerPath, new Date().toISOString(), 'utf8');
        }
        catch {
            // ignore
        }
    }
    log?.('info', '样例回放完成', { count, sample: true });
    return count;
}
