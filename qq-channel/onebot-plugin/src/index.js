/**
 * 自研 OneBot 通道（替换 dsh-onebot-qq）——S1 影子判定。
 *
 * 只做：连 WS → 去抖/判定 → 组 prompt → 影子回合（可选）→ 写 shadow.jsonl → 观测旧插件。
 * 绝不发送任何 QQ 消息；connection.send 直接抛错。
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createConnection, normalize } from './connection.js';
import { createConfigStore } from './config.js';
import { createLogger } from './log.js';
import { createPolicy } from './policy.js';
import { buildPrompt, sceneKeyOf } from './prompt.js';
import { registerBiliTools } from './bili-tools.js';
import { createRegistry } from './registry.js';
import { createShadow, replaySamples } from './shadow.js';

export const name = 'qq-onebot';
export const inject = ['agents', 'sessions', 'agentPresets', 'tools'];

let createUserMessage = message => message;
try {
    ({ createUserMessage } = await import('@deepseek-ai/dsh-llm'));
}
catch {
    // 保留本地兜底：S1 只用于影子会话，形状一致即可
}

const PLUGIN_DIR = 'Y:\\dsh\\home\\qq-onebot-plugin';

function ensureDir(path) {
    try {
        mkdirSync(path, { recursive: true });
    }
    catch {
        // ignore
    }
}

export function apply(ctx, config = {}) {
    const logPath = String(config.logPath ?? join(PLUGIN_DIR, 'logs', 's1.log'));
    // 状态目录可被宿主配置覆盖，测试用临时目录隔离，默认仍是插件自带 state。
    const stateDir = String(config.stateDir ?? join(PLUGIN_DIR, 'state'));
    const log = createLogger(logPath);

    ctx.effect(() => {
        const cfgPath = String(config.configPath ?? join(PLUGIN_DIR, 'config.json'));
        log('info', '插件已挂载', {
            name,
            inject,
            mode: 'S1-shadow',
            cfgPath,
            wsUrl: String(config.wsUrl ?? 'ws://127.0.0.1:3001'),
        });

        const store = createConfigStore({ path: cfgPath, log });
        if (!store.load()) {
            log('error', '配置不可用，插件不启动（不连 WS）', { cfgPath });
            return () => {
                store.stop();
            };
        }

        const initial = store.current;
        ensureDir(initial.runtime.cwd);
        ensureDir(dirname(initial.shadow.path));
        ensureDir(stateDir);

        const registry = createRegistry({
            agents: ctx.agents,
            agentPresets: ctx.agentPresets,
            log,
            statePath: join(stateDir, 'chat-sessions.json'),
            getConfig: () => store.current,
        });
        registry.load();
        registry.startSweeper();

        // B 站工具：宿主侧只注册取内容/取画面，不发送 QQ 消息。
        let disposeBili = () => undefined;
        void registerBiliTools({
            ctx,
            log,
            resolveChatId: exec => {
                const sessionId = String(exec?.sessionId ?? '');
                if (sessionId === '')
                    return undefined;
                const chats = registry.mapping()?.chats ?? {};
                for (const [chatId, entry] of Object.entries(chats)) {
                    if (entry?.sessionId === sessionId)
                        return chatId;
                }
                return undefined;
            },
        }).then(dispose => {
            if (typeof dispose === 'function')
                disposeBili = dispose;
        }).catch(error => {
            log('warn', 'B站工具注册异常', { error: error?.stack ?? String(error) });
        });

        const connection = createConnection({
            url: String(config.wsUrl ?? 'ws://127.0.0.1:3001'),
            accessToken: String(config.accessToken ?? ''),
            log,
            onEvent: payload => {
                void handleFrame(payload).catch(error => {
                    log('error', '帧处理失败', { error: error?.stack ?? String(error) });
                });
            },
        });

        const policy = createPolicy({
            log,
            resolveReplyTarget: async messageId => {
                const data = await connection.callReadOnly('get_msg', {
                    message_id: Number(messageId),
                }, 8000);
                const qq = data?.sender?.user_id ?? data?.user_id;
                return qq === undefined || qq === null ? undefined : String(qq);
            },
        });

        // 撤回：影子链路不实现。真实撤回统一走 dsh-onebot-qq 的 lib/recall.js。
        let shadow = null;

        shadow = createShadow({
            ctx,
            registry,
            connection,
            log,
            createUserMessage,
            getConfig: () => store.current,
        });

        let handledMeta = false;

        async function handleFrame(frame) {
            if (frame?.post_type !== 'message') {
                if (frame?.post_type === 'meta_event') {
                    if (handledMeta)
                        return;
                    handledMeta = true;
                }
                log('info', '非消息事件', {
                    postType: String(frame?.post_type ?? ''),
                    subType: String(frame?.sub_type ?? ''),
                    noticeType: frame?.notice_type === undefined ? null : String(frame.notice_type),
                    selfId: String(frame?.self_id ?? ''),
                    sample: frame?.sample === true,
                });
                return;
            }

            const inbound = normalize(frame);
            if (inbound.chatType === null) {
                log('warn', '消息类型未知，已忽略', { messageType: inbound.messageType });
                return;
            }
            if (frame?.sample === true)
                inbound.sample = true;

            const cfg = store.effective(inbound.chatType, inbound.chatId);
            if (cfg === null)
                return;

            policy.ingest(inbound, cfg, batch => {
                void processBatch(batch).catch(error => {
                    log('error', '批次处理失败', { error: error?.stack ?? String(error) });
                });
            });
        }

        async function processBatch(batch) {
            const cfg = store.effective(batch.kind, batch.chatId);
            if (cfg === null)
                return;
            const decision = await policy.decide(batch, cfg);
            const scene = {
                sceneKey: sceneKeyOf(batch.kind, batch.chatId),
                chatKind: batch.kind,
                chatId: batch.chatId,
            };
            const prompt = buildPrompt(batch, cfg, scene);
            shadow.handle({ batch, decision, prompt, scene, cfg });
        }

        connection.start();
        store.watch();

        if (initial.samples.enabled) {
            void replaySamples({
                path: initial.samples.path,
                markerPath: join(stateDir, 'samples-replayed'),
                once: initial.samples.once,
                delayMs: initial.samples.delayMs,
                onFrame: frame => handleFrame({ ...frame, sample: true }),
                log,
            });
        }

        return () => {
            log('info', '插件已卸载');
            try {
                disposeBili();
            }
            catch {
                // 工具卸载失败不阻塞插件退出
            }
            store.stop();
            policy.stop();
            registry.stop();
            connection.stop();
            void registry.disposeAll();
        };
    }, 'qq-onebot.lifecycle');
}
