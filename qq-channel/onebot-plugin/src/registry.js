/**
 * ④ 会话层：chat ↔ sessionId 持久映射、每个 chat 一个 agent、同 chat 串行。
 *
 * 影子期使用独立的 `shadow-onebot-*` 会话 id，绝不复用旧插件的 `onebot-*` 会话，
 * 避免两个 agent 同时写同一份会话日志。
 */
import { readFileSync } from 'node:fs';
import { writeJsonAtomic } from './config.js';

export function chatKeyOf(kind, chatId) {
    return String(kind) + ':' + String(chatId);
}

export function sessionIdForChat(kind, chatId) {
    const raw = chatKeyOf(kind, chatId).replace(/[^A-Za-z0-9-]/g, '-');
    return 'shadow-onebot-' + raw;
}

export function createRegistry({ agents, agentPresets, log, statePath, getConfig }) {
    const live = new Map();
    const pending = new Map();
    const chains = new Map();
    let mapping = { version: 1, chats: {} };
    let sweeper = null;

    function note(level, message, data) {
        try {
            log?.(level, message, data);
        }
        catch {
            // ignore
        }
    }

    function load() {
        try {
            const raw = JSON.parse(readFileSync(statePath, 'utf8'));
            if (raw !== null && typeof raw === 'object' && raw.chats !== null && typeof raw.chats === 'object')
                mapping = { version: 1, chats: raw.chats };
            note('info', '会话映射已加载', { chats: Object.keys(mapping.chats).length, statePath });
        }
        catch (error) {
            if (error?.code !== 'ENOENT')
                note('warn', '会话映射读取失败，按空映射启动', { error: error?.message ?? String(error) });
        }
    }

    function persist() {
        if (!writeJsonAtomic(statePath, mapping))
            note('warn', '会话映射写盘失败', { statePath });
    }

    async function resolvePresetId(preferred) {
        if (agentPresets === undefined)
            return undefined;
        const cfg = getConfig();
        const wanted = (typeof preferred === 'string' && preferred !== '')
            ? preferred
            : (cfg.runtime.agentPreset !== '' ? cfg.runtime.agentPreset : agentPresets.defaultId);
        if (wanted === undefined || wanted === '')
            return undefined;
        try {
            const preset = await agentPresets.resolve(wanted);
            return preset?.id ?? undefined;
        }
        catch (error) {
            note('warn', '人格预设解析失败，按默认装配', { wanted, error: error?.message ?? String(error) });
            return undefined;
        }
    }

    async function mountPreset(agentCtx, presetId) {
        if (agentPresets?.mount === undefined)
            return;
        try {
            const preset = await agentPresets.mount(agentCtx, presetId);
            note('debug', 'agent 已加入人格预设', { preset: preset?.id ?? presetId ?? '(default)' });
        }
        catch (error) {
            note('warn', '人格预设 mount 失败，工具回退到全局层', { error: error?.message ?? String(error) });
        }
    }

    async function createOrResume(key) {
        const cfg = getConfig();
        const separator = key.indexOf(':');
        const kind = separator === -1 ? 'group' : key.slice(0, separator);
        const chatId = separator === -1 ? key : key.slice(separator + 1);
        const mapped = mapping.chats[key];
        const presetId = await resolvePresetId(mapped?.preset);
        const setup = async agentCtx => {
            await mountPreset(agentCtx, presetId);
        };
        const agentOptions = { provider: cfg.runtime.provider, model: cfg.runtime.model };
        let handle = null;

        if (typeof mapped?.sessionId === 'string' && mapped.sessionId !== '') {
            try {
                handle = await agents.resume({
                    resumeSessionId: mapped.sessionId,
                    agentOptions,
                    setup,
                });
                note('info', '会话已恢复', { chat: key, sessionId: mapped.sessionId, preset: presetId ?? null });
            }
            catch (error) {
                note('warn', '会话恢复失败，改为新建', {
                    chat: key,
                    sessionId: mapped.sessionId,
                    error: error?.message ?? String(error),
                });
                handle = null;
            }
        }

        if (handle === null) {
            const meta = { cwd: cfg.runtime.cwd };
            if (presetId !== undefined)
                meta.agentPreset = presetId;
            const sessionId = mapped?.sessionId ?? sessionIdForChat(kind, chatId);
            try {
                handle = await agents.create({ sessionId, meta, agentOptions, setup });
                note('info', '会话已创建', { chat: key, sessionId, preset: presetId ?? null });
            }
            catch (error) {
                const freshId = sessionIdForChat(kind, chatId) + '-' + Date.now().toString(36);
                note('warn', '会话创建失败，改用新 id 重试', {
                    chat: key,
                    sessionId,
                    freshId,
                    error: error?.message ?? String(error),
                });
                handle = await agents.create({ sessionId: freshId, meta, agentOptions, setup });
                note('info', '会话已创建（新 id）', { chat: key, sessionId: freshId });
            }
        }

        try {
            await handle.agent?.whenIdle?.();
        }
        catch (error) {
            note('warn', '等待 agent 空闲失败', { chat: key, error: error?.message ?? String(error) });
        }

        const actualSessionId = handle.agent?.session?.id ?? null;
        const entry = {
            agent: handle.agent,
            dispose: handle.dispose,
            sessionId: actualSessionId,
            preset: presetId ?? '',
            lastUsedAt: Date.now(),
        };
        live.set(key, entry);
        if (actualSessionId !== null) {
            mapping.chats[key] = {
                sessionId: actualSessionId,
                preset: presetId ?? '',
                updatedAt: new Date().toISOString(),
            };
            persist();
        }
        return entry;
    }

    function ensureAgent(key) {
        const existing = live.get(key);
        if (existing !== undefined) {
            existing.lastUsedAt = Date.now();
            return Promise.resolve(existing);
        }
        if (pending.has(key))
            return pending.get(key);
        const task = createOrResume(key).finally(() => {
            pending.delete(key);
        });
        pending.set(key, task);
        return task;
    }

    /**
     * 同一 chat 串行执行。前一个失败不会阻断后一个。
     * 返回的 Promise 会传递本次 fn 的结果/异常。
     */
    function runExclusive(key, fn) {
        const prior = chains.get(key) ?? Promise.resolve();
        const next = prior.then(() => fn(), () => fn());
        const guarded = next.catch(() => {});
        chains.set(key, guarded);
        void guarded.finally(() => {
            if (chains.get(key) === guarded)
                chains.delete(key);
        });
        return next;
    }

    async function disposeKey(key) {
        const entry = live.get(key);
        if (entry === undefined)
            return;
        live.delete(key);
        try {
            await entry.dispose?.();
            note('info', '会话已释放', { chat: key, sessionId: entry.sessionId });
        }
        catch (error) {
            note('warn', '会话释放失败', { chat: key, error: error?.message ?? String(error) });
        }
    }

    async function sweepIdle() {
        const cfg = getConfig();
        const now = Date.now();
        const expired = [];
        for (const [key, entry] of live) {
            if (now - entry.lastUsedAt > cfg.runtime.agentIdleMs)
                expired.push(key);
        }
        for (const key of expired)
            await disposeKey(key);
        if (expired.length > 0)
            note('info', '空闲会话已回收', { count: expired.length });
        return expired.length;
    }

    return {
        load,
        ensureAgent,
        runExclusive,
        disposeKey,
        sweepIdle,
        startSweeper() {
            if (sweeper !== null)
                return;
            sweeper = setInterval(() => {
                void sweepIdle();
            }, 300000);
            sweeper.unref?.();
        },
        async disposeAll() {
            const keys = [...live.keys()];
            for (const key of keys)
                await disposeKey(key);
        },
        stop() {
            if (sweeper !== null)
                clearInterval(sweeper);
            sweeper = null;
            chains.clear();
            pending.clear();
        },
        get(key) {
            return live.get(key);
        },
        stats() {
            return { live: live.size, pending: pending.size, chains: chains.size };
        },
        mapping() {
            return mapping;
        },
    };
}
