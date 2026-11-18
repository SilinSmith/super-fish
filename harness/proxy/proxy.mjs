import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { readFile, appendFile, mkdir, stat } from 'node:fs/promises';
import { appendFileSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { migrateNotebook, selectMemoryEntries, formatMemorySection, memoryIndexText, workingMemoryText, applyRevocations, relationToneOf } from './memory.mjs';
import { latestScene } from './scene.mjs';
import { createPresenceRuntime } from './presence.mjs';
import { createJudgeRuntime } from './judge.mjs';
import { createDeferRuntime } from './defer.mjs';
import { readLease, waitForLeaseRelease } from './gpu-lease.mjs';
import {
    catalogSection,
    readEnabledTools,
    readResidentConfig,
    readResidentTools,
} from './tool-catalog.mjs';
import { readTasks, formatTaskSection } from './tasks-store.mjs';
import { LLM, BUDGET, ANALYSIS_PROMPT_BUDGET, CONFIG_SOURCE, normalizePayload, upstreamPath, chatCompletionsPath } from './llm-config.mjs';
import { stripPromptEcho, classifyEcho, isEffectivelyEmpty } from './echo-guard.mjs';
import { WORKSPACE_ROOT, workspaceViolation } from './workspace-guard.mjs';
import { ASK_MASTER_TOOL, askMasterToolDefinition, answersSection, evaluateAsk, markConsumed, pendingAnswersFor } from './ask-gate.mjs';
import { createContextCompressor } from './context-compressor.mjs';
import { applyHistoryHygiene } from './history-hygiene.mjs';
import { searchMemes } from './meme-store.mjs';
import { createScheduler } from './scheduler.mjs';

const LISTEN_PORT = Number(process.env.QQ_PROXY_PORT ?? 1240);
const UPSTREAM_TRANSPORT = LLM.protocol === 'https:' ? https : http;
const ROOT = process.env.QQ_PROXY_ROOT ?? 'Y:\\dsh\\home\\qq-persona';
const CHARACTER_PATH = join(ROOT, 'character.md');
const STATE_PATH = join(ROOT, 'state.json');
const NOTEBOOK_PATH = join(ROOT, 'notebook.json');
const DIARY_PATH = join(ROOT, 'diary.jsonl');
// 与 bili.mjs 的 BILI_STATE_PATH 保持同一份文件（可用同一环境变量覆盖）。
const BILI_STATE_PATH = process.env.QQ_BILI_STATE ?? join(ROOT, 'bili-state.json');
/** 自迭代运行痕迹：只追加，不参与任何决策。 */
const SELF_ITER_LOG_PATH = process.env.QQ_SELF_ITER_LOG ?? join(ROOT, 'self-iter', 'runs.jsonl');
const SHARED_FEED_PATH = join(ROOT, 'shared-feed.jsonl');
const LOG_PATH = join(ROOT, 'proxy.log');
const MEMORY_ACCESS_PATH = join(ROOT, 'memory-access.jsonl');
// 新插件撤回机制写出的「来源已撤回」事件；路径与插件 config.json 的 recall.eventsPath 对齐。
const RECALL_EVENTS_PATH = process.env.QQ_RECALL_EVENTS ?? 'Y:\\dsh\\home\\qq-onebot-plugin\\logs\\recall-events.jsonl';

/* ------------------------------------------------------------------ */
/* 接话闸门：状态机 → 专注度路由 → 延迟队列 / 判定器                   */
/* 只处理带【场景标记】的白名单群普通消息；旧链路（无场景标记）、       */
/* 私聊、@、主人、已被插件判过的【接话】【水群】回合一律直通。          */
/* ------------------------------------------------------------------ */
const GATE_SHADOW_PATH = process.env.QQ_SHADOW_PATH ?? 'Y:\\dsh\\home\\qq-onebot-plugin\\logs\\shadow.jsonl';
const GATE_PRESENCE_PATH = process.env.QQ_PRESENCE_PATH ?? join(ROOT, 'presence-state.json');
const GATE_DEFER_PATH = process.env.QQ_DEFER_PATH ?? join(ROOT, 'defer-queue.json');
const GATE_GROUPS = new Set(String(process.env.QQ_JUDGE_GROUPS ?? '100000002,100000001')
    .split(',')
    .map(item => item.trim())
    .filter(item => /^\d{5,12}$/u.test(item)));
const GATE_FOCUS_AT = Number(process.env.QQ_REALTIME_FOCUS_AT ?? 60);
const GATE_MERGE_MS = Number(process.env.QQ_JUDGE_MERGE_MS ?? 5000);
const GATE_TIMEOUT_MS = Number(process.env.QQ_JUDGE_TIMEOUT_MS ?? 3000);
const GATE_QUEUE_LIMIT = Number(process.env.QQ_JUDGE_QUEUE_LIMIT ?? 3);
const GATE_ENABLED = process.env.QQ_GATE === '1';
// 插件已经判过、放行的回合：代理不再重复判定。
const GATE_ACCEPTED_RE = /【接话】|【水群】/u;
const GATE_MENTION_RE = /\[@我\]|@(?:小助手|助手|helper)/iu;
/* 硬闸门开关放文件里：开/关不用改代码、不用动守护链，改完 5 秒内生效。
 * 与 QQ_GATE（专注度/延迟队列/判定器那一整套）是两个独立开关。 */
const GATE_CONFIG_PATH = process.env.QQ_GATE_CONFIG ?? join(ROOT, 'gate-config.json');
let gateConfigCache = { at: 0, data: {} };
function gateConfig() {
    const stamp = Date.now();
    if (stamp - gateConfigCache.at < 5000)
        return gateConfigCache.data;
    try {
        const parsed = JSON.parse(readFileSync(GATE_CONFIG_PATH, 'utf8'));
        gateConfigCache = { at: stamp, data: parsed !== null && typeof parsed === 'object' ? parsed : {} };
    }
    catch {
        gateConfigCache = { at: stamp, data: {} };
    }
    return gateConfigCache.data;
}
function gateHardEnabled() {
    return gateConfig().hard === true;
}

let gateRuntime;
let deferRuntime;
const gateLog = (level, message) => fatalLog('[gate] ' + level + ' ' + message);
/* 延迟队列单独取用：周期清理不该为了一个 defer 顺带构造 presence / judge。 */
function deferRuntimeOf() {
    if (deferRuntime !== undefined)
        return deferRuntime;
    deferRuntime = createDeferRuntime({
        proxyBase: 'http://127.0.0.1:' + LISTEN_PORT,
        statePath: GATE_DEFER_PATH,
        shadowPath: GATE_SHADOW_PATH,
        notebookPath: NOTEBOOK_PATH,
        realtimeFocusAt: GATE_FOCUS_AT,
        queueLimit: GATE_QUEUE_LIMIT,
        log: gateLog,
    });
    return deferRuntime;
}
// 代理没有插件的事件循环，靠惰性初始化把三个运行时绑到同一套文件上。
function gateRuntimes() {
    if (gateRuntime !== undefined)
        return gateRuntime;
    gateRuntime = {
        presence: createPresenceRuntime({ statePath: GATE_PRESENCE_PATH, log: gateLog }),
        judge: createJudgeRuntime({
            proxyBase: 'http://127.0.0.1:' + LISTEN_PORT,
            shadowPath: GATE_SHADOW_PATH,
            notebookPath: NOTEBOOK_PATH,
            mergeWindowMs: GATE_MERGE_MS,
            timeoutMs: GATE_TIMEOUT_MS,
            queueLimit: GATE_QUEUE_LIMIT,
            log: gateLog,
        }),
        defer: deferRuntimeOf(),
    };
    return gateRuntime;
}

/* 过期排空：只等"该群下一条消息"才清理太迟——面板直接按文件里的 age 显示，
 * 一条陈旧条目能挂一整天。这里按 ttlMin 周期扫，到点自己消失。 */
const DEFER_SWEEP_MS = Number(process.env.QQ_DEFER_SWEEP_MS ?? 120_000);
function sweepDeferQueue() {
    try {
        const result = deferRuntimeOf().sweep();
        if (result.dropped > 0)
            fatalLog('defer sweep: dropped ' + result.dropped + ' expired item(s) [' + result.groups.join(',') + ']');
    }
    catch (error) {
        fatalLog('warn: defer sweep failed: ' + (error?.message ?? String(error)));
    }
}
sweepDeferQueue();
// 周期执行统一由进程内单调度器派发（见下方 scheduler），不再单独挂 setInterval。

/* 入站事件信封：插件在消息首行写 【元】{json}，代理只解这一次 JSON，
 * 不再用正则从中文标记里反推 @/拍一拍关系。加载失败时退回旧解析。
 * 归一化层已上移为平台层（单一事实源），URL 必须与插件消费者逐字符相同。 */
const PLATFORM_EVENT_URL = process.env.DSH_QQ_PLATFORM_EVENT
    ?? new URL('../../qq-channel/platform/src/index.js', import.meta.url).href;
let decodeInboundEnvelope = null;
try {
    ({ decodeEnvelope: decodeInboundEnvelope } = await import(PLATFORM_EVENT_URL));
}
catch (error) {
    fatalLog('warn: 入站事件模块不可用，回退旧标记解析: ' + (error?.message ?? String(error)));
    decodeInboundEnvelope = null;
}

/* 漂移自检：插件升级会把 lib/event.js 换回自带实现，届时插件与代理各跑一个渲染器。
 * 只 warn，不阻塞启动；消费者本身已直连平台层，这里只提示垫片被覆盖。 */
// 上游 onebot 插件路径（不属于本仓库）：默认值仅为示例，按自己的 DSH profile 改。
const PLUGIN_EVENT_PATH = process.env.DSH_ONEBOT_EVENT_PATH
    ?? 'C:/Users/user/.dsh/profiles/desktop/node_modules/dsh-onebot-qq/lib/event.js';
const PLATFORM_EVENT_PATH = process.env.DSH_QQ_PLATFORM_EVENT_FILE
    ?? fileURLToPath(new URL('../../qq-channel/platform/src/event.js', import.meta.url));
function checkNormalizationDrift() {
    let pluginSource;
    try {
        pluginSource = readFileSync(PLUGIN_EVENT_PATH, 'utf8');
    }
    catch (error) {
        fatalLog('warn: 归一化层漂移自检跳过（读不到插件 event.js）: ' + (error?.message ?? String(error)));
        return;
    }
    if (pluginSource.includes('qq-platform/src/index.js'))
        return; // 垫片完好
    let detail = '';
    try {
        const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
        detail = sha256(PLUGIN_EVENT_PATH) === sha256(PLATFORM_EVENT_PATH)
            ? '（内容与平台层一致，仅垫片被覆盖）'
            : '（内容与平台层不同，存在两个渲染器）';
    }
    catch { /* 哈希比对失败不影响告警本身 */ }
    fatalLog('warn: 插件升级覆盖了归一化层，消费者仍走平台层；lib/event.js 已不是 shim' + detail);
}
checkNormalizationDrift();
function decodeEnvelopeOf(text) {
    if (decodeInboundEnvelope === null || typeof text !== 'string')
        return null;
    try {
        return decodeInboundEnvelope(text).evt;
    }
    catch {
        return null;
    }
}
/** 信封是给代理看的，不发给引擎：模型只看到渲染好的自然语言。 */
function stripEnvelopeLine(text) {
    if (typeof text !== 'string' || !text.startsWith('【元】'))
        return text;
    const end = text.indexOf('\n');
    return end === -1 ? '' : text.slice(end + 1);
}

/** 本轮 traceId：优先取最后一条入站消息的信封字段，拿不到就留空。 */
function latestTraceId(messages) {
    const evt = decodeEnvelopeOf(latestUserMessageText(messages));
    if (evt === null || typeof evt !== 'object')
        return '';
    for (const key of ['traceId', 'trace_id', 'messageId', 'msgId', 'id']) {
        if (typeof evt[key] === 'string' && evt[key] !== '')
            return evt[key];
    }
    return '';
}

/** 场景标记缺失（legacy-group）时，用【元】信封里的群号还原压缩器键。
 *  否则 snapshot('legacy-group') 永远查不到任何群的状态文件，等于不注入。 */
function envelopeSceneKey(messages) {
    const evt = decodeEnvelopeOf(latestUserMessageText(messages));
    const chat = evt?.chat;
    if (chat === null || typeof chat !== 'object')
        return '';
    if (String(chat.type ?? '') !== 'group')
        return '';
    const id = String(chat.groupId ?? chat.id ?? '');
    return /^\d{5,12}$/u.test(id) ? 'group:' + id : '';
}

/* ------------------------------------------------------------------ */
/* 陈旧回合闸（第二道）：插件侧的出站账本才是主闸，这里只做兜底。       */
/* 重启恢复的旧回合会带着十几小时前的 user 消息重新进来；只在回合第一  */
/* 步（最后一条就是 user）判，避免把正常长回合在中途误杀。             */
/* ------------------------------------------------------------------ */
const STALE_TURNS_PATH = join(ROOT, 'stale-turns.jsonl');
const INBOUND_CLOCK_PATH = join(ROOT, 'inbound-clock.json');
let isTurnStale = null;
let WRITE_TOOL_NAMES = new Set();
try {
    const policy = await import('file:///C:/Users/user/.dsh/profiles/desktop/node_modules/dsh-onebot-qq/lib/restart-policy.js');
    isTurnStale = policy.isTurnStale;
    WRITE_TOOL_NAMES = policy.WRITE_TOOL_NAMES;
}
catch (error) {
    fatalLog('warn: 重启策略模块不可用，陈旧回合闸关闭: ' + (error?.message ?? String(error)));
}
let inboundClockCache = { at: 0, data: {} };
/** 付费联网工具：QQ 链路一律不暴露、不执行（web_search 走 DeepSeek 云端按量计费，一次调用 3 个请求）。 */
const BLOCKED_WEB_TOOLS = new Set(['web_search', 'web_fetch']);
/** 边界类工具：它们不「在根内做事」，而是「重定义根」。subagent 会带出另一套
 * 会话（另一套 cwd/沙箱），working_directory 直接把 cwd 搬走，二者都能绕过工作区
 * 围栏，所以仍不进 QQ 链路。其余宿主工具一律保留（工具该在就在）。 */
const QQ_BOUNDARY_TOOLS = new Set(['subagent', 'subagent_fork', 'working_directory']);
/** 宿主工具的拒绝规则（单一事实源）：集合 + 条件都收在这里。
 * - plugin_manager：能装/改插件，等于改运行中的代码，任何会话都拒。
 * - schedule_edit：只在用户本人私聊里放行，群聊一律拒。
 * ctx.chatKind 取自【场景标记】kind=group|private；缺标记时按 chatId 形状兜底。 */
const QQ_HOST_TOOL_DENY = new Set(['plugin_manager']);
const QQ_HOST_TOOL_PRIVATE_ONLY = new Set(['schedule_edit', ASK_MASTER_TOOL]);
function chatKindOf(ctx) {
    const kind = String(ctx?.chatKind ?? '');
    if (kind === 'group' || kind === 'private')
        return kind;
    return String(ctx?.chatId ?? '').startsWith('private:') ? 'private' : 'group';
}
/** 返回拒绝原因；null 表示放行。 */
function denyHostTool(name, ctx) {
    if (typeof name !== 'string' || name === '')
        return null;
    if (QQ_BOUNDARY_TOOLS.has(name))
        return 'boundary';
    if (QQ_HOST_TOOL_DENY.has(name))
        return 'hard-deny';
    if (QQ_HOST_TOOL_PRIVATE_ONLY.has(name) && chatKindOf(ctx) !== 'private')
        return 'group-chat';
    return null;
}
function inboundClock() {
    const now = Date.now();
    if (now - inboundClockCache.at < 5000)
        return inboundClockCache.data;
    try {
        const parsed = JSON.parse(readFileSync(INBOUND_CLOCK_PATH, 'utf8'));
        inboundClockCache = { at: now, data: parsed !== null && typeof parsed === 'object' ? parsed : {} };
    }
    catch {
        inboundClockCache = { at: now, data: {} };
    }
    return inboundClockCache.data;
}
/** 返回 null 表示正常回合；否则返回审计用的陈旧信息。 */
function staleTurnOf(messages, qqRequest) {
    if (qqRequest !== true || typeof isTurnStale !== 'function')
        return null;
    if (!Array.isArray(messages) || messages.length === 0)
        return null;
    const last = messages[messages.length - 1];
    if (last?.role !== 'user')
        return null; // 回合已经跑起来了，不按入站时间杀中途步骤
    const raw = messageText(last);
    const evt = decodeEnvelopeOf(raw);
    let ts = evt !== null && Number.isFinite(Number(evt.ts)) ? Number(evt.ts) : 0;
    let source = 'envelope';
    if (ts === 0) {
        // 旧格式没有信封：只对明确的 QQ 入站消息用插件写的时钟兜底，
        // 管理员指令/任务续跑不在这里判，避免误伤。
        if (!raw.includes('【发送者标记】') && !raw.includes('【群名】'))
            return null;
        const scene = latestScene(messages);
        const clock = inboundClock();
        const at = Number(clock[String(scene?.sceneKey ?? '')] ?? clock[String(scene?.chatId ?? '')]);
        if (!Number.isFinite(at) || at <= 0)
            return null;
        ts = at;
        source = 'inbound-clock';
    }
    if (!isTurnStale(ts, Date.now(), 'reply'))
        return null;
    const scene = latestScene(messages);
    return {
        at: new Date().toISOString(),
        sceneKey: String(scene?.sceneKey ?? scene?.chatId ?? ''),
        messageTs: new Date(ts).toISOString(),
        ageMs: Date.now() - ts,
        source,
    };
}

/** 去掉时间戳前缀和各类标记，只留真正说出口的那句话。 */
function gateMessageBody(text) {
    const evt = decodeEnvelopeOf(text);
    if (evt !== null && typeof evt.text === 'string')
        return evt.text.replace(/\s+/gu, ' ').trim();
    return String(text)
        .replace(/^\[\d{1,2}:\d{2}\s[^\]]*\(\d{5,12}\)\]\s*/u, '')
        .replace(/【场景标记】[^\n]*/gu, '')
        .replace(/【发送者标记】[^\n]*/gu, '')
        .replace(/【群名】[^\n]*/gu, '')
        .replace(/【接话】[^\n]*/gu, '')
        .replace(/【水群】[^\n]*/gu, '')
        .trim();
}

/**
 * 这句话是不是说给别人的：@别人 / 引用别人 / 回复别人。
 * 只认信封里的结构化标志（atMe / atOther / quotedMe / quotedOther）：
 * 拿不到信封、或引用解析失败（quotedMe === null）都不判——宁可放过，也不误吞。
 */
function addressedElsewhereOf(messages) {
    const evt = decodeEnvelopeOf(latestUserMessageText(messages));
    if (evt === null || typeof evt !== 'object')
        return { hit: false, reason: 'no-envelope' };
    const flags = evt.flags ?? {};
    if (flags.atMe === true)
        return { hit: false, reason: 'at-me' };
    if (flags.atOther === true)
        return { hit: true, reason: 'at-other' };
    if (flags.quotedOther === true)
        return { hit: true, reason: 'quote-other' };
    if (flags.quotedMe === false)
        return { hit: true, reason: 'quote-other' };
    return { hit: false, reason: 'not-addressed' };
}

function isLateNight(stamp) {
    const hour = new Date(stamp).getHours();
    return hour >= 1 && hour < 6;
}

// 同一个 agent 回合会多次请求代理（工具调用循环），入站消息却不变。
// 用短时指纹去重：同一句话只判/入队一次，后续轮次直接放行，避免打断已开始的回复。
const GATE_SEEN = new Map();
function gateRecentlySeen(key) {
    const stamp = Date.now();
    for (const [seenKey, at] of GATE_SEEN) {
        if (stamp - at > 120_000)
            GATE_SEEN.delete(seenKey);
    }
    const last = GATE_SEEN.get(key);
    if (last !== undefined && stamp - last < 60_000)
        return true;
    GATE_SEEN.set(key, stamp);
    return false;
}

/**
 * 返回 { mode: 'pass' | 'silent' | 'reply', text?, rule? }。
 * pass 继续走正常回复；silent 返回空串；reply 直接把批处理的追问当回复。
 */
async function gateTurn(messages) {
    const hardGate = gateHardEnabled();
    if (!GATE_ENABLED && !hardGate)
        return { mode: 'pass' };
    const scene = latestScene(messages);
    // 旧插件没有场景标记：它自己的 @ 门槛已经把关，代理不重复管。
    if (scene.sceneFallback || scene.chatKind !== 'group')
        return { mode: 'pass' };
    const groupId = String(scene.chatId ?? '');
    if (!GATE_GROUPS.has(groupId))
        return { mode: 'pass' };
    const raw = latestUserMessageText(messages);
    if (GATE_ACCEPTED_RE.test(raw))
        return { mode: 'pass' };
    const body = gateMessageBody(raw);
    if (body === '')
        return { mode: 'pass' };
    // 宿主脚手架（「Time sampled while preparing turn N, step M」/ runtime 快照 /
    // 纠偏 nudge）是注入行，不是群友说的话：既不该被判定成接话，更不能进延迟队列
    // —— 它没有发言人，进队后会被安到上一位发言人头上（18 小时残留就是这么来的）。
    if (isScaffoldText(raw) || isScaffoldText(body))
        return { mode: 'silent', rule: 'scaffold:ignored' };
    const speaker = speakerMark(messages);
    const mentioned = GATE_MENTION_RE.test(raw);
    const isMaster = speaker?.isMaster === true;
    // 主人、@、回复机器人永远实时；图片/外部事件的判断在插件侧完成。
    if (mentioned || isMaster)
        return { mode: 'pass' };
    // 硬闸门（当前唯一启用的那一层）：@别人 / 引用别人 / 在回复别人 → 直接沉默，不调模型。
    if (hardGate) {
        const target = addressedElsewhereOf(messages);
        if (target.hit) {
            logLine('gate: hard silent(' + target.reason + ') group=' + groupId
                + ' by=' + (speaker?.nickname ?? '?') + '(' + (speaker?.qq ?? '-') + ')'
                + ' text=' + JSON.stringify(body.slice(0, 40)));
            return { mode: 'silent', rule: 'hard:' + target.reason };
        }
    }
    // 专注度 / 延迟队列 / 判定器那一整套没开：硬闸门放行后直接交回正常回复链路。
    if (!GATE_ENABLED)
        return { mode: 'pass' };
    if (gateRecentlySeen(scene.sceneKey + '|' + (speaker?.qq ?? '') + '|' + body.slice(0, 200)))
        return { mode: 'pass' };

    const { presence, judge, defer } = gateRuntimes();
    const stamp = Date.now();
    presence.noteMessage({ mentioned: false, lateNight: isLateNight(stamp) });
    const focus = presence.get().focus;
    defer.touch(groupId);
    if (defer.route(focus, {
        mentioned: false,
        isMaster: false,
        chatKind: 'group',
        unprompted: false,
        activity: false,
    }) === 'defer') {
        defer.enqueue({
            groupId,
            chatId: scene.sceneKey,
            messageId: '',
            userId: speaker?.qq ?? '',
            nickname: speaker?.nickname ?? '',
            text: body,
            addressed: false,
            focus,
        });
        if (!defer.due(groupId))
            return { mode: 'silent', rule: 'batch:pending' };
        const batch = await defer.runBatch({ groupId, focus: presence.get().focus });
        if (batch.rule === 'batch:followup' && typeof batch.send === 'string' && batch.send !== '')
            return { mode: 'reply', text: batch.send, rule: batch.rule };
        return { mode: 'silent', rule: batch.rule };
    }

    const verdict = await judge.judge({
        groupId,
        chatId: scene.sceneKey,
        userId: speaker?.qq ?? '',
        nickname: speaker?.nickname ?? '',
        text: body,
        messageId: '',
        mentioned: false,
        addressed: false,
        isMaster: false,
        presenceHint: presence.hint(),
    });
    if (verdict.speak !== true)
        return { mode: 'silent', rule: verdict.rule };
    return { mode: 'pass', rule: verdict.rule };
}

let recallApplying = false;
const COMFY_URL = process.env.QQ_COMFY_URL ?? 'http://127.0.0.1:8188';
const COMFY_PYTHON = process.env.QQ_COMFY_PYTHON ?? 'K:\\python\\311\\python.exe';
const COMFY_CWD = process.env.QQ_COMFY_CWD ?? 'E:\\ComfyUI';
const LOCK_PATH = join(ROOT, 'proxy.lock');
function fatalLog(line) {
    try {
        appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
    }
    catch {
        // ignore
    }
}

/* 内部保护（同参循环 / 回合上限）触发时，这一条不发话：
 * 回 200 + 空 content，宿主正常收尾，插件 outbound 的「空回复」路径直接 drop（不调 OneBot），
 * 同时留一份审计。任何固定兜底文案都会被用户看到，等于把机器卡住这件事说给用户听。 */
const TURN_AUDIT_PATH = join(ROOT, 'turn-audit.jsonl');
function appendTurnAudit(kind, detail) {
    try {
        appendFileSync(TURN_AUDIT_PATH, JSON.stringify({ at: new Date().toISOString(), kind, action: 'silent-drop', ...detail }) + '\n', 'utf8');
    }
    catch {
        // 审计失败也不能把兜底文案发出去
    }
}
function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error?.code === 'EPERM';
    }
}
function acquireLock() {
    try {
        const old = Number(readFileSync(LOCK_PATH, 'utf8').trim());
        if (pidAlive(old)) {
            console.log('[qq-persona-proxy] another instance is already running (pid ' + old + ')');
            process.exit(0);
        }
        unlinkSync(LOCK_PATH);
    }
    catch {
        // no lock, or stale/unreadable: fall through to create
    }
    try {
        const fd = openSync(LOCK_PATH, 'wx');
        writeFileSync(fd, String(process.pid) + '\n', 'utf8');
        return fd;
    }
    catch {
        console.log('[qq-persona-proxy] lock exists; another instance won the race');
        process.exit(0);
    }
}
const lockFd = acquireLock();
process.on('exit', code => {
    fatalLog('proxy exit code=' + code + ' pid=' + process.pid);
    try {
        unlinkSync(LOCK_PATH);
    }
    catch {
        // ignore
    }
});
process.on('uncaughtException', error => {
    fatalLog('FATAL uncaughtException: ' + (error?.stack ?? String(error)));
    console.error('[qq-persona-proxy] FATAL uncaughtException', error);
    process.exit(1);
});
process.on('unhandledRejection', reason => {
    fatalLog('FATAL unhandledRejection: ' + (reason?.stack ?? String(reason)));
    console.error('[qq-persona-proxy] FATAL unhandledRejection', reason);
    process.exit(1);
});
// 客户端（DSH）自带的 Authorization 只在显式允许转发时透传给上游；
// 默认使用 llm-backend.json 里配置的 apiKey，没配就不发，避免把宿主的
// 本地 token 误送给 ninfer 等第三方端点。
let lastAuthorization = '';

function upstreamAuthHeader() {
    if (LLM.apiKey !== '')
        return 'Bearer ' + LLM.apiKey;
    if (LLM.forwardClientAuth && lastAuthorization !== '')
        return lastAuthorization;
    return '';
}

function applyUpstreamAuth(headers) {
    const authorization = upstreamAuthHeader();
    if (authorization !== '')
        headers.authorization = authorization;
    else
        delete headers.authorization;
    return headers;
}

// 引擎若按 session 派生 KV 缓存槽位，需要一个跨轮稳定的标识。头名由部署方
// 决定（默认不发，避免给不认识该头的引擎添噪音）：
//   QQ_ENGINE_SESSION_HEADER=x-session-id
// 值优先用宿主透传的会话 id，其次用【场景标记】解析出的 sceneKey；两者都没有
// （旧插件 legacy-group）时不发，宁可不命中也不要多个群共用同一个槽位。
const ENGINE_SESSION_HEADER = process.env.QQ_ENGINE_SESSION_HEADER ?? '';
function applyEngineSession(headers, sessionId) {
    if (ENGINE_SESSION_HEADER !== '' && typeof sessionId === 'string' && sessionId !== '')
        headers[ENGINE_SESSION_HEADER] = sessionId;
    return headers;
}

function messageText(message) {
    if (typeof message?.content === 'string')
        return message.content;
    if (Array.isArray(message?.content))
        return message.content.map(part => typeof part?.text === 'string' ? part.text : '').join(' ');
    return '';
}

/* 来源判定只看入口，不扫消息正文：
 *   ① x-dsh-source: qq|client —— 显式契约头，客户端/插件可直接声明；
 *   ② x-session-id 以 onebot- 开头 —— 插件 sessionIdForChat 的命名契约；
 *   ③ 请求带 QQ 专属工具（qq_at / qq_send_image）—— 插件只给 QQ agent 会话注册；
 * 其余一律按普通客户端处理。判定结果逐请求写日志，便于排查。
 * 注意：以前靠正文里找“【发送者标记】/dsh-onebot”来猜，桌面会话只要聊到
 * 这些词就会被误判成 QQ 回合，进而走进有意沉默分支、回 200 空正文。 */
function resolveRequestSource(req, body) {
    const declared = typeof req.headers['x-dsh-source'] === 'string'
        ? req.headers['x-dsh-source'].trim().toLowerCase()
        : '';
    const session = typeof req.headers['x-session-id'] === 'string' ? req.headers['x-session-id'] : '';
    if (declared === 'qq' || declared === 'client')
        return { source: declared, why: 'header', session };
    if (/^onebot-/u.test(session))
        return { source: 'qq', why: 'session-id', session };
    const tools = Array.isArray(body?.tools) ? body.tools : [];
    const qqTool = tools.some(tool => tool?.function?.name === 'qq_at' || tool?.function?.name === 'qq_send_image');
    if (qqTool)
        return { source: 'qq', why: 'qq-tools', session };
    return { source: 'client', why: 'default', session };
}

/* ------------------------------------------------------------------ */
/* 真实工具调用计数：白名单调整靠数据，不靠猜。                        */
/* 只记 QQ 轮次；按 tool_call.id 去重，避免每轮把同一批历史重复计数。   */
/* ------------------------------------------------------------------ */
const TOOL_USAGE_PATH = join(ROOT, 'tool-usage.jsonl');
const seenToolCallIds = new Set();
const seenToolResultIds = new Set();
/** 媒体调用的短期登记：结果回来时不一定还带着那条 assistant 消息（历史会被裁）。 */
const mediaCalls = new Map();
/** 媒体类工具要留参数与结果：事后能回答"发了什么、结果如何、messageId"。 */
const MEDIA_TOOL_NAMES = new Set([
    'qq_send_sticker', 'qq_send_image', 'qq_send_voice', 'qq_send_file',
    'qq_send_tts', 'qq_send_video', 'qq_send_forward',
]);

function summarizeMediaArgs(raw) {
    let args;
    try {
        args = JSON.parse(String(raw ?? '{}'));
    }
    catch {
        return { raw: String(raw ?? '').slice(0, 300) };
    }
    if (args === null || typeof args !== 'object')
        return { raw: String(raw).slice(0, 300) };
    const out = {};
    for (const [key, value] of Object.entries(args)) {
        if (typeof value === 'string') {
            if (value.startsWith('base64://'))
                out[key] = 'base64:<' + Math.max(0, value.length - 9) + ' chars>';
            else
                out[key] = value.length > 300 ? value.slice(0, 300) + '…' : value;
        }
        else if (typeof value === 'number' || typeof value === 'boolean' || value === null)
            out[key] = value;
        else
            out[key] = JSON.stringify(value).slice(0, 300);
    }
    return out;
}

function summarizeMediaResult(content) {
    const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
            ? content.map(item => typeof item?.text === 'string' ? item.text : '').join(' ')
            : '';
    if (text === '')
        return { ok: null };
    try {
        const value = JSON.parse(text);
        return {
            ok: value?.ok ?? value?.sent ?? null,
            messageId: value?.messageId ?? value?.message_id ?? null,
            traceId: value?.traceId ?? null,
            sticker: value?.sticker ?? undefined,
            forwarded: value?.forwarded ?? undefined,
            senders: Array.isArray(value?.senders) ? value.senders.slice(0, 8) : undefined,
            chars: value?.chars ?? undefined,
            bytes: value?.bytes ?? undefined,
            emotion: value?.emotion ?? undefined,
            error: value?.error ?? null,
            text: typeof value?.text === 'string' ? value.text.slice(0, 200) : undefined,
        };
    }
    catch {
        return { ok: null, text: text.slice(0, 300) };
    }
}

function recordToolUsage(messages) {
    if (!Array.isArray(messages))
        return;
    const lines = [];
    const calls = new Map();
    for (const message of messages) {
        if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls))
            continue;
        for (const call of message.tool_calls) {
            const name = call?.function?.name;
            if (typeof name !== 'string' || name === '')
                continue;
            const id = typeof call?.id === 'string' && call.id !== ''
                ? call.id
                : createHash('sha1').update(name + '\u0001' + String(call?.function?.arguments ?? '')).digest('hex').slice(0, 16);
            const media = MEDIA_TOOL_NAMES.has(name);
            if (media) {
                calls.set(id, { name, args: summarizeMediaArgs(call?.function?.arguments) });
                mediaCalls.set(id, calls.get(id));
                if (mediaCalls.size > 500) {
                    const oldest = mediaCalls.keys().next().value;
                    if (oldest !== undefined)
                        mediaCalls.delete(oldest);
                }
            }
            if (seenToolCallIds.has(id))
                continue;
            seenToolCallIds.add(id);
            lines.push(JSON.stringify(media
                ? { ts: new Date().toISOString(), event: 'call', name, id, args: calls.get(id)?.args }
                : { ts: new Date().toISOString(), name, id }));
        }
    }
    // 结果单独记：工具返回成功 ≠ 真的发出去，发送结果以 qq-actions 的
    // send_sticker/send_msg 为准；这里只证明工具这一层拿到了什么。
    for (const message of messages) {
        if (message?.role !== 'tool')
            continue;
        const id = typeof message?.tool_call_id === 'string' ? message.tool_call_id : '';
        const call = id !== '' ? (mediaCalls.get(id) ?? calls.get(id)) : undefined;
        if (id === '' || call === undefined || seenToolResultIds.has(id))
            continue;
        seenToolResultIds.add(id);
        lines.push(JSON.stringify({
            ts: new Date().toISOString(),
            event: 'result',
            name: call.name,
            id,
            result: summarizeMediaResult(message?.content),
        }));
    }
    if (seenToolCallIds.size > 5000) {
        let drop = 1000;
        for (const id of seenToolCallIds) {
            seenToolCallIds.delete(id);
            if (--drop <= 0)
                break;
        }
    }
    if (seenToolResultIds.size > 5000) {
        let drop = 1000;
        for (const id of seenToolResultIds) {
            seenToolResultIds.delete(id);
            if (--drop <= 0)
                break;
        }
    }
    if (lines.length > 0)
        void appendFile(TOOL_USAGE_PATH, lines.join('\n') + '\n', 'utf8').catch(() => {});
}


/** Platform metadata is authoritative: the model must never re-decide who the
 * sender is. The group prefix carries "[HH:MM nickname(QQ)]"; @ targets are
 * emitted separately by the bridge. */
function latestGroupMeta(messages) {
    let latest = '';
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role !== 'user')
            continue;
        latest = messageText(messages[index]);
        break;
    }
    if (latest === '' || (!latest.includes('【@对象】') && !latest.includes('[@我]')))
        return undefined;
    const prefix = /\[\d{1,2}:\d{2}\s+([^\]]+?)\((\d{5,12})\)\]/u.exec(latest);
    if (prefix === null)
        return undefined;
    const at = /【@对象】([^\n（]+)/u.exec(latest);
    return {
        text: latest,
        speaker: prefix[1].trim(),
        speakerQq: prefix[2],
        at: at === null ? '无' : at[1].trim(),
    };
}

const analysisCache = new Map();

function analysisKey(meta, messages) {
    const tail = messages.slice(-4).map(message => messageText(message).slice(0, 120)).join('\u0001');
    return (meta.speakerQq + '|' + meta.at + '|' + tail).slice(0, 800);
}

function postUpstreamJsonOnce(payload, timeoutMs, sessionId) {
    return new Promise((resolve, reject) => {
        normalizePayload(payload);
        const data = Buffer.from(JSON.stringify(payload), 'utf8');
        const headers = applyEngineSession(applyUpstreamAuth({
            'content-type': 'application/json',
            'content-length': String(data.length),
        }), sessionId);
        const request = UPSTREAM_TRANSPORT.request({
            host: LLM.host,
            port: LLM.port,
            method: 'POST',
            path: chatCompletionsPath(),
            headers,
            timeout: timeoutMs,
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                const status = response.statusCode ?? 500;
                if (status >= 400) {
                    // 400 大多来自上下文超限或参数不合法，只记状态码等于瞎猜，
                    // 把上游返回的前 300 字带上，才能判断到底是哪一种。
                    const detail = Buffer.concat(chunks).toString('utf8').replace(/\s+/g, ' ').slice(0, 300);
                    reject(new Error('upstream status ' + status + (detail === '' ? '' : ' body=' + detail)));
                    return;
                }
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                }
                catch (error) {
                    reject(error);
                }
            });
        });
        request.on('timeout', () => request.destroy(new Error('analysis timeout')));
        request.on('error', reject);
        request.end(data);
    });
}

// 引擎在 KV 池打满时回 429 / server_overloaded / context cache exhausted。
// 这是准入拒绝：请求发出后十几毫秒就返回，不是排队超时；对面序列一结束，
// 额度立刻回来（实测有 429 之后 4ms 就成功的）。所以退避压到 300–800ms，
// 睡太久反而错过窗口。省页靠的是 max_tokens 封顶和缩短上下文，不是睡眠。
// 池子 429 多给一轮，因为每次重试的上下文都比上一次短，后一轮更可能挤进空位。
const RETRYABLE_UPSTREAM = /(?:^|\D)429(?:\D|$)|server_overloaded|context cache exhausted|engine overloaded|status 503/iu;
const POOL_EXHAUSTED = /context cache exhausted|Paged KV pool|server_overloaded|status 429/iu;
const UPSTREAM_RETRY_DELAYS = [300, 800];
const POOL_RETRY_DELAYS = [300, 600, 800];
/** 最近一次池子 429 的冷却截止时间；冷却期内不再跑分析腿，把池子让给回复。 */
let poolBusyUntil = 0;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableUpstream(error) {
    return RETRYABLE_UPSTREAM.test(error instanceof Error ? error.message : String(error));
}

function isPoolExhausted(error) {
    return POOL_EXHAUSTED.test(error instanceof Error ? error.message : String(error));
}

/** 上游 5xx（引擎内部错误，含请求准备阶段的 subset bound 溢出）。 */
function isUpstreamServerError(error) {
    return /upstream status 5\d\d/i.test(error instanceof Error ? error.message : String(error));
}

/** 同一段长前缀重复出现时，引擎在请求准备阶段固定报这个内部错误。
 *  实测与并发无关：单发、串行、同发都一样，只要前缀已被收进目录并再次匹配就必失败。 */
function isSharedPrefixBoundError(error) {
    return /prepared shared candidates exceeded/i.test(error instanceof Error ? error.message : String(error));
}

/** 去前缀重试：在 system 首行插一个唯一标记，让请求不再命中被污染的共享前缀。
 *  只动首行，不碰人设正文、历史与工具表。 */
function withFreshPrefixMarker(payload, nonce) {
    const messages = Array.isArray(payload?.messages) ? payload.messages.slice() : [];
    const marker = '【turn=' + nonce + '】\n';
    const head = messages[0];
    if (head !== undefined && (head?.role === 'system' || head?.role === 'developer')) {
        const content = typeof head.content === 'string'
            ? marker + head.content
            : [{ type: 'text', text: marker }, ...(Array.isArray(head.content) ? head.content : [])];
        messages[0] = { ...head, content };
    }
    else {
        messages.unshift({ role: 'system', content: marker });
    }
    return { ...payload, messages };
}

/** 按天/小时落一条上游故障计数，
 *  event ∈ 5xx | retry_ok | prefix_shift_ok | prefix_shift_failed | upstream_error。 */
function recordUpstreamFault(event, detail = {}) {
    const now = new Date();
    const pad = value => String(value).padStart(2, '0');
    const day = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
    const line = JSON.stringify({
        ts: now.toISOString(),
        day,
        hour: day + 'T' + pad(now.getHours()),
        event,
        ...detail,
    }) + '\n';
    appendFile(UPSTREAM_FAULT_LEDGER, line, 'utf8').catch(() => {});
}

/**
 * 429 重试用的降级请求：保留 system/developer，历史砍到尾部 ratio 比例。
 * 只动历史，不动人设和最后一条用户消息（问题本身不能被裁掉）。
 */
function shrinkPayloadForPool(payload, ratio) {
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    let fixedEnd = 0;
    while (fixedEnd < messages.length
        && (messages[fixedEnd]?.role === 'system' || messages[fixedEnd]?.role === 'developer'))
        fixedEnd += 1;
    const rest = messages.slice(fixedEnd);
    if (rest.length <= 3)
        return payload;
    const keep = Math.max(2, Math.floor(rest.length * ratio));
    let tail = rest.slice(rest.length - keep);
    while (tail.length > 0 && tail[0]?.role === 'tool')
        tail = tail.slice(1);
    if (tail.length === 0 || tail.length >= rest.length)
        return payload;
    return { ...payload, messages: [...messages.slice(0, fixedEnd), ...tail] };
}

/** 最后一档：只留人设 + 最后一条用户消息，丢工具和历史，换一个极短上下文。 */
function minimalPayload(payload) {
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    const fixed = messages.find(message => message?.role === 'system' || message?.role === 'developer');
    const lastUser = [...messages].reverse().find(message => message?.role === 'user');
    const out = { ...payload };
    out.messages = [fixed, lastUser].filter(message => message !== undefined && message !== null);
    delete out.tools;
    delete out.tool_choice;
    out.max_tokens = Math.min(Number(out.max_tokens) || 256, 256);
    return out;
}

/**
 * options.poolShrink(attempt, payload) 只在池子 429 时调用：
 * 返回新 payload 则用更短的上下文重试，返回 undefined 则放弃重试。
 */
async function postUpstreamJson(payload, timeoutMs, sessionId, options = {}) {
    const shrink = typeof options.poolShrink === 'function' ? options.poolShrink : undefined;
    let current = payload;
    let lastError;
    for (let attempt = 0; ; attempt += 1) {
        try {
            return await postUpstreamJsonOnce(current, timeoutMs, sessionId);
        }
        catch (error) {
            lastError = error;
            if (!isRetryableUpstream(error))
                break;
            const pool = isPoolExhausted(error);
            const delays = pool && shrink !== undefined ? POOL_RETRY_DELAYS : UPSTREAM_RETRY_DELAYS;
            if (attempt >= delays.length)
                break;
            const delay = delays[attempt];
            if (pool)
                poolBusyUntil = Date.now() + delay + 1000;
            let next = current;
            if (pool && shrink !== undefined) {
                const shrunk = shrink(attempt, current);
                if (shrunk === undefined)
                    break;
                next = shrunk;
            }
            const beforeCount = current.messages?.length ?? 0;
            const afterCount = next.messages?.length ?? 0;
            logLine('upstream busy, retry ' + (attempt + 1) + '/' + delays.length
                + ' in ' + delay + 'ms'
                + (next !== current
                    ? ' with shorter context (' + beforeCount + '->' + afterCount + ' msg, dropped=' + Math.max(0, beforeCount - afterCount) + ', windowDropped=0)'
                    : '')
                + ': ' + (error instanceof Error ? error.message : String(error)).slice(0, 160));
            await sleep(delay);
            current = next;
        }
    }
    throw lastError;
}

function parseAnalysisJson(content) {
    if (typeof content !== 'string' || content.trim() === '')
        return undefined;
    const match = /\{[\s\S]*\}/u.exec(content);
    if (match === null)
        return undefined;
    try {
        const data = JSON.parse(match[0]);
        return data && typeof data === 'object' ? data : undefined;
    }
    catch {
        return undefined;
    }
}

/**
 * 分析腿的固定指令。放在消息列表末尾，前面的 system + 历史与回复请求逐字节相同，
 * 引擎处理完这条之后回复请求可以直接命中前缀缓存。
 */
const ANALYSIS_INSTRUCTION = '【内部步骤，不是对方发言】忽略上面的人设和回复要求，只做语义解析，不要聊天、不要调用工具。'
    + '只输出一行 JSON，不要解释：\n'
    + '{"subject":"它在讨论/处理谁的问题或事，填昵称或“未指明”","asks":["它真正提出的问题，最多两条"],'
    + '"referents":{"代词或简称":"指代谁"},"reply_to_bot":true}\n'
    + 'reply_to_bot 只有在最后一条明确在叫/问机器人时才是 true。';

/** 这一轮的最后一条消息是否带图：图片回合只走回复腿，不再叠分析腿。 */
function lastMessageHasImage(message) {
    if (message === undefined || message === null || !Array.isArray(message.content))
        return false;
    return message.content.some(part => part?.type === 'image_url' || part?.type === 'input_image'
        || part?.image_url !== undefined || part?.source?.type === 'base64');
}

function appendTextToMessage(message, text) {
    if (message === undefined || message === null)
        return;
    if (typeof message.content === 'string') {
        message.content += text;
        return;
    }
    if (Array.isArray(message.content)) {
        message.content.push({ type: 'text', text });
        return;
    }
    message.content = text;
}

/** 把已经组装好的回复消息当成前缀，末尾追加一条解析指令。
 *
 * 约束：`messages` 必须原样再发给回复腿（除末尾追加的解析结果外），
 * 否则前缀缓存失效、两次调用各自 prefill 一遍。所以这里不改写任何
 * 已有消息，也不换 system、不删工具/记忆。 */
async function analyzeTurn(meta, messages, tools) {
    if (meta === undefined || !Array.isArray(messages) || messages.length === 0)
        return undefined;
    const key = analysisKey(meta, messages);
    if (analysisCache.has(key))
        return analysisCache.get(key);
    const payload = {
        model: LLM.model,
        temperature: 0,
        // 独立的输出预算：解析只需要一行 JSON，不跟回复共用 1024。
        max_tokens: LLM.analyzeMaxTokens,
        stream: false,
        reasoning_effort: 'none',
        messages: [...messages, { role: 'user', content: ANALYSIS_INSTRUCTION }],
    };
    // 工具表必须和回复腿一致，否则 prompt 从工具定义那一行就开始分叉，前缀缓存失效。
    // 用 tool_choice=none 防止解析腿真的发起工具调用。
    if (Array.isArray(tools) && tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = 'none';
    }
    try {
        const response = await postUpstreamJson(payload, LLM.analyzeTimeoutMs);
        const parsed = parseAnalysisJson(response?.choices?.[0]?.message?.content);
        if (parsed === undefined)
            return undefined;
        if (analysisCache.size >= 200)
            analysisCache.delete(analysisCache.keys().next().value);
        analysisCache.set(key, parsed);
        logLine('analysis: speaker=' + meta.speaker + ' subject=' + String(parsed.subject ?? '').slice(0, 40)
            + ' reply_to_bot=' + (parsed.reply_to_bot === true)
            + ' prefixMessages=' + messages.length + ' maxTokens=' + LLM.analyzeMaxTokens);
        return parsed;
    }
    catch (error) {
        logLine('analysis failed: ' + (error?.message ?? String(error)));
        return undefined;
    }
}

function analysisText(meta, analysis) {
    if (meta === undefined || analysis === undefined)
        return '';
    const lines = [];
    lines.push('- 说话人：' + meta.speaker + '(' + meta.speakerQq + ')（不是被@的人）');
    lines.push('- 本条@：' + meta.at);
    if (typeof analysis.subject === 'string' && analysis.subject.trim() !== '')
        lines.push('- 讨论对象：' + analysis.subject.trim().slice(0, 80));
    if (Array.isArray(analysis.asks) && analysis.asks.length > 0) {
        const asks = analysis.asks
            .map(item => typeof item === 'string' ? item.trim() : '')
            .filter(item => item !== '')
            .slice(0, 2);
        if (asks.length > 0)
            lines.push('- 本轮问题：' + asks.join(' / ').slice(0, 200));
    }
    if (analysis.referents && typeof analysis.referents === 'object') {
        const pairs = Object.entries(analysis.referents)
            .filter(([, value]) => typeof value === 'string' && value.trim() !== '')
            .slice(0, 4)
            .map(([term, value]) => term + '=' + value);
        if (pairs.length > 0)
            lines.push('- 指代：' + pairs.join('；').slice(0, 200));
    }
    // The bridge knows whether the bot itself was @-ed; that is trusted
    // metadata, so it overrides a weak model's guess.
    const addressed = /\[@我\]/u.test(meta.text) || meta.at.includes('你自己');
    lines.push('- 这条消息' + ((addressed || analysis.reply_to_bot === true)
        ? '是在叫/问机器人，直接回应它'
        : '不是在问你：不要当成针对你的提问，不要答题，最多自然接一句很短的话'));
    return '## 本轮语义解析（自动生成的事实参考，不要复述，也不要提“解析”）\n' + lines.join('\n');
}

async function sharedFeedText(latestText) {
    let raw = '';
    try {
        raw = await readFile(SHARED_FEED_PATH, 'utf8');
    }
    catch {
        return '';
    }
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    const entries = [];
    for (const line of raw.split(/\r?\n/)) {
        if (line.trim() === '')
            continue;
        try {
            const entry = JSON.parse(line);
            if (entry && typeof entry.text === 'string' && typeof entry.ts === 'string') {
                const at = Date.parse(entry.ts);
                if (Number.isFinite(at) && at >= cutoff)
                    entries.push(entry);
            }
        }
        catch {
            // A torn line must not break the prompt path.
        }
    }
    const normalizedLatest = latestText.replace(/\s+/g, ' ').slice(-200);
    const recent = entries
        // Only the owner's own messages are worth carrying across chats. The
        // bot's earlier replies are already in each chat's history; re-injecting
        // them here made the model copy its previous sentences verbatim.
        .filter(entry => entry.role === 'user')
        .filter(entry => !normalizedLatest.includes(entry.text.replace(/\s+/g, ' ').slice(0, 30)))
        .slice(-10);
    if (recent.length === 0)
        return '';
    const lines = recent.map(entry => {
        const where = String(entry.chat ?? '').startsWith('group:') ? '群聊' : '私聊';
        const who = entry.nickname || '对方';
        return '- (' + where + ') ' + who + '：' + entry.text.replace(/\s+/g, ' ').slice(0, 160);
    });
    return '## 跨会话近况（后台记忆，只用于判断态度和保持连续；不要复述，不要说是从私聊知道的）\n'
        + lines.join('\n');
}

async function loadCharacter() {
    try {
        return (await readFile(CHARACTER_PATH, 'utf8')).trim();
    }
    catch {
        return '';
    }
}

async function loadState() {
    try {
        const raw = await readFile(STATE_PATH, 'utf8');
        const state = JSON.parse(raw);
        return state && typeof state === 'object' ? state : {};
    }
    catch {
        return {};
    }
}

function stateText(state) {
    const lines = [];
    if (typeof state.mood === 'string' && state.mood !== '')
        lines.push('心情：' + state.mood);
    // 不注入上一轮「内心」原文。它一旦被写进 system，模型下一轮最容易做的事
    // 就是把那句原样当成回复发出来，而且越循环越固定成模板句；实测同一条
    // “刚把今天群里那些…记下来了”连续出现了七轮。
    const memories = Array.isArray(state.memories) ? state.memories.slice(-12) : [];
    if (memories.length > 0) {
        lines.push('最近记忆：');
        for (const memory of memories) {
            const text = typeof memory === 'string' ? memory : memory?.text;
            if (typeof text === 'string' && text !== '')
                lines.push('- ' + text);
        }
    }
    const promises = Array.isArray(state.promises) ? state.promises.slice(-8) : [];
    if (promises.length > 0) {
        lines.push('承诺：');
        for (const promise of promises) {
            const text = typeof promise === 'string' ? promise : promise?.text;
            if (typeof text === 'string' && text !== '')
                lines.push('- ' + text);
        }
    }
    return lines.length > 0 ? lines.join('\n') : '（暂无额外状态）';
}

/** Remove only the hidden inner-thought lines from assistant history.
 *
 * The previous version also stripped every parenthesised span and truncated
 * each assistant message to 220 characters. That corrupted code, math and
 * long answers in history, so the model kept "forgetting" what it had already
 * said — one of the main sources of the broken-context feeling. History is
 * kept verbatim apart from the hidden 【内心】 / <inner> line.
 *
 * 多段思考只有首段带【内心】时，续段过去会被当成正文留在历史里，下一轮
 * 模型会照着自己的旧思考往下编（也是长对话复读的来源之一）。这里不能只
 * 在命中【内心】时才清洗：tool_call 残片、「回复：」前缀、游离的 </think>、
 * 草稿备选句式都会原样回到下一轮上下文，模型随即照着它们再生成一次。
 * 所以历史里的 assistant 文本一律过同一套清洗，再交给出站/摘要。
 */
const TOOL_CALL_BLOCK_RE = /<(?:tool_call|tool_calls|function_calls?|function)[^>]*>[\s\S]*?(?:<\/(?:tool_call|tool_calls|function_calls?|function)\s*>|$)/gi;
/** 草稿备选：模型把多个候选版本一起吐出来，只保留第一个版本。 */
const DRAFT_ALT_RE = /(?:或者|也可以|备选(?:方案)?|另一个版本|另一种说法|换一种说法|换个说法|更自然一点)(?:是|说)?[：:]/u;
const DRAFT_HEADING_RE = /^\s*#{1,6}\s*(?:正文|回复|回答|发言)\s*$/u;

function stripHistoryNoise(text) {
    if (typeof text !== 'string' || text === '')
        return text;
    let out = text
        // 完整思考段与游离结束标记：结束标记之前的内容都不该进历史。
        .replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, '')
        .replace(/^[\s\S]*?<\/think\s*>/gi, '')
        .replace(/<\/?think\b[^>]*>/gi, '')
        .replace(TOOL_CALL_BLOCK_RE, '')
        .replace(/<\/?inner>/gi, '');
    out = stripPromptEcho(out);
    const draft = out.search(DRAFT_ALT_RE);
    if (draft > 0)
        out = out.slice(0, draft);
    out = out.split(/\r?\n/u).filter(line => !DRAFT_HEADING_RE.test(line)).join('\n');
    return out.trim();
}
function stripInnerHistory(messages) {
    for (const message of messages) {
        if (message?.role !== 'assistant')
            continue;
        if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
            continue;
        const clean = text => (typeof text === 'string' ? stripHistoryNoise(text) : text);
        if (typeof message.content === 'string') {
            message.content = clean(message.content);
            continue;
        }
        if (Array.isArray(message.content)) {
            for (const part of message.content) {
                if (typeof part?.text === 'string')
                    part.text = clean(part.text);
            }
        }
    }
    return messages;
}

/** Approximate a history message's prompt cost without counting base64 image
 * payloads, which are tens of thousands of characters but only a small number
 * of model image tokens. Counting the raw data URL used to evict the entire
 * problem image from history on the very next turn. */
const IMAGE_PART_CHARS = 2000;
/** 一张图按视觉 token 计。base64 data URL 有几十万字符，按字符折算会把
 * 图片轮次估成 7 万 token（引擎实测只有 ~9k），历史预算被误判撑爆、砍到 6 条。 */
const IMAGE_PART_TOKENS = 1_200;
function isImagePart(part) {
    const type = String(part?.type ?? '');
    return type === 'image_url' || type === 'image' || type === 'input_image'
        || part?.image_url !== undefined || part?.source?.type === 'base64';
}
function estimatePartSize(part) {
    if (typeof part === 'string')
        return part.length;
    if (!part || typeof part !== 'object')
        return 0;
    if (typeof part.text === 'string')
        return part.text.length;
    if (isImagePart(part))
        return IMAGE_PART_CHARS;
    try {
        return Math.min(JSON.stringify(part).length, 4000);
    }
    catch {
        return 200;
    }
}
function estimateMessageSize(message) {
    let size = 32;
    if (typeof message?.content === 'string')
        size += message.content.length;
    else if (Array.isArray(message?.content))
        size += message.content.reduce((total, part) => total + estimatePartSize(part), 0);
    if (Array.isArray(message?.tool_calls)) {
        for (const call of message.tool_calls)
            size += Math.min(String(call?.function?.arguments ?? '').length, 4000) + 64;
    }
    return size;
}

/** 粗估 token：CJK/emoji 一字≈1，其余按 3.5 字符≈1，宁可高估。
 * 引擎窗口是 32768，用字符做预算根本对不上（中文 1 字符≈1 token）。 */
function estimateTokens(text) {
    const str = String(text ?? '');
    let cjk = 0;
    for (const ch of str) {
        const code = ch.codePointAt(0) ?? 0;
        if (code >= 0x2e80)
            cjk += 1;
    }
    return cjk + Math.ceil((str.length - cjk) / 3.5) + 8;
}
function estimateMessageTokens(message) {
    let text = '';
    let imageTokens = 0;
    if (typeof message?.content === 'string')
        text += stripEnvelopeLine(message.content);
    else if (Array.isArray(message?.content)) {
        for (const part of message.content) {
            if (typeof part?.text === 'string')
                text += stripEnvelopeLine(part.text);
            else if (isImagePart(part))
                imageTokens += IMAGE_PART_TOKENS;
            else
                text += JSON.stringify(part).slice(0, 4000);
        }
    }
    if (Array.isArray(message?.tool_calls)) {
        for (const call of message.tool_calls)
            text += String(call?.function?.arguments ?? '').slice(0, 4000);
    }
    return estimateTokens(text) + 8 + imageTokens;
}

/** 最近几轮对话的起点：保护段从这里开始，逐条保留原文。
 *
 *  旧实现从「最后一次机器人回复之后」起保护，且受两小时时效窗约束：
 *  一个多步回合里工具结果越堆越多，保护段被推到最后几步工具噪音上，
 *  上一轮用户说的话和机器人自己上一句反而落在可裁区，被 countTarget 挤掉。
 *  现在按「轮」往回数：最近 N 条真实 user（运行时快照/重说这类脚手架不算）
 *  以及它们前面那句机器人文本回复，一律原样保留。
 *  更早的才交给 trimHistory 压成索引。
 */
const RECENT_DIALOGUE_TURNS = 3;
function recentDialogueStart(messages, turns = RECENT_DIALOGUE_TURNS) {
    if (!Array.isArray(messages) || messages.length === 0)
        return 0;
    let seen = 0;
    let start = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'user' || scaffoldKindOf(message) !== '')
            continue;
        start = index;
        seen += 1;
        if (seen >= turns)
            break;
    }
    // 机器人自己上一句（无 tool_calls 的文本回复）也要在保护段里。
    for (let index = start - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role === 'user')
            break;
        if (message?.role === 'assistant' && messageText(message).trim() !== '')
            return index;
    }
    return start;
}

/** Keep the newest history under a token budget and return the dropped
 * prefix so it can be represented by a compact rolling summary.
 *
 * 历史尽量保持 append-only：没超预算就原样返回，让引擎能跨轮复用整段
 * KV 前缀；超预算时一次砍到 70%，而不是刚好卡在边界。旧实现每来一条
 * 新消息就把起点往前挪一格，上一轮缓存的历史前缀每轮都作废。
 *
 * protectFrom 之后的尾巴（最近 N 轮对话，含机器人上一句）必须逐条原样保留：
 * 不受 maxMessages / 70% 目标限制，只受 maxTokens 硬上限约束。
 * 保护段自己撑爆硬上限时，先丢整组工具调用（assistant(tool_calls) + 其结果），
 * 工具噪音全部让完还不够才从最旧处丢对话，并用 protectedOverflow 记账。 */
function trimHistory(messages, maxTokens = 8000, maxMessages = 56, options = {}) {
    const sizes = messages.map(estimateMessageTokens);
    const total = sizes.reduce((sum, size) => sum + size, 0);
    const protectFrom = Math.max(0, Math.min(messages.length, Number(options.protectFrom ?? messages.length)));
    if (total <= maxTokens && messages.length <= maxMessages)
        return { kept: messages, dropped: [], tokens: total, tokensBefore: total, protectFrom, protectedCount: messages.length - protectFrom, protectedOverflow: 0, toolDropped: 0 };
    const tokenTarget = Math.floor(maxTokens * 0.7);
    const countTarget = Math.max(6, Math.floor(maxMessages * 0.7));
    const kept = [];
    let used = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const size = sizes[index];
        if (index < protectFrom) {
            if (kept.length >= countTarget)
                break;
            if (kept.length >= 6 && used + size > tokenTarget)
                break;
        }
        kept.unshift(messages[index]);
        used += size;
    }
    let protectedOverflow = 0;
    let toolDropped = 0;
    const keptTokens = () => kept.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    while (kept.length > 1 && keptTokens() > maxTokens) {
        // 本轮最后一条真实 user 之后的内容一律不动（正在跑的工具链缺一环上游就 400）。
        let lastUserAt = kept.length;
        for (let index = kept.length - 1; index >= 0; index -= 1) {
            if (kept[index]?.role === 'user') {
                lastUserAt = index;
                break;
            }
        }
        if (shedToolGroup(kept, lastUserAt) > 0) {
            toolDropped += 1;
            continue;
        }
        // 工具噪音让完了，只剩本轮：宁可用超预算，也不把正在跑的这一轮拆散。
        if (lastUserAt <= 0)
            break;
        const headIndex = messages.length - kept.length;
        if (headIndex >= protectFrom)
            protectedOverflow += 1;
        kept.shift();
    }
    // Never begin the kept window with an orphan tool result.
    while (kept.length > 0 && kept[0]?.role === 'tool')
        kept.shift();
    const protectedKept = Math.min(kept.length, Math.max(0, messages.length - protectFrom));
    // 保护段里让掉的工具组是「中间挖洞」，不能再用前缀长度倒推。
    const keptSet = new Set(kept);
    return {
        kept,
        dropped: messages.filter(message => !keptSet.has(message)),
        tokens: keptTokens(),
        tokensBefore: total,
        protectFrom,
        protectedCount: protectedKept,
        protectedOverflow,
        toolDropped,
    };
}

/** 丢掉 kept 里最旧的一组工具往返（assistant + 它的 tool 结果）。
 *  只动 lastUserAt 之前的部分——本回合正在跑的链条不碰。
 *  返回释放的 token 数；0 表示没有可丢的工具噪音。 */
function shedToolGroup(kept, lastUserAt) {
    for (let index = 0; index < lastUserAt; index += 1) {
        const message = kept[index];
        if (message?.role === 'tool') {
            kept.splice(index, 1);
            return estimateMessageTokens(message) || 1;
        }
        if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0)
            continue;
        const ids = new Set(message.tool_calls.map(call => call?.id).filter(id => typeof id === 'string'));
        let end = index + 1;
        while (end < kept.length && kept[end]?.role === 'tool' && ids.has(kept[end]?.tool_call_id))
            end += 1;
        let freed = 0;
        for (let at = index; at < end; at += 1)
            freed += estimateMessageTokens(kept[at]);
        kept.splice(index, end - index);
        return freed || 1;
    }
    return 0;
}

/**
 * 宿主脚手架每轮都会重新注入一份完整副本（运行时快照 / 时间采样）。
 * 旧副本对当前决策没有价值，却和真实聊天抢同一份裁剪预算。
 *
 * - runtime / time：完整快照，按类只保留最新一条。最新那条绝对不能删，
 *   它承载“现在几点 / 当前目录 / 文件策略”。
 * - repeat-nudge / repeat-detected / resay / read-image：一次性操作指令，
 *   不承载对话内容，整类移出历史（宿主检测到条件会重新注入）。
 * 任何情况下历史最后一条都不删：模型正要据此行动，删掉等于把当前指令吞了。
 * 只在 QQ 改写路径调用，dsh 直连路径不经过这里。
 */
const SCAFFOLD_KINDS = [
    ['runtime', /^Current runtime context\b/u, true],
    ['time', /^Time sampled while preparing turn\b/u, true],
    ['repeat-nudge', /^You are repeating the exact same tool call\b/u, false],
    ['repeat-detected', /^Repeated tool call detected\b/u, false],
    ['resay', /^【重说】/u, false],
    ['read-image', /^【读图】/u, true],
];
/** 本轮已经读过图之后，读图指令不再重复“去读”，改成“已读过”。 */
const READ_IMAGE_SCAFFOLD_DONE = '【读图】这张图本轮已经读过了，内容见前面的读图结果；不要再调用 read_image。';
/** 同回合第二次读图的工具终态（不折叠成含糊提示，明确说“已经看过”）。 */
const READ_IMAGE_TOOL_DONE = '这张图本轮已经看过，内容在第一次读图的结果里；不要再读同一张图，直接用你看到的内容回话。';

/* 带图/表情包回合的工具预算：图看完了还在调别的工具，就是不肯说话。 */
const MEDIA_TURN_TOOL_BUDGET = 3;
const MEDIA_TURN_LABEL_RE = /【媒体】|\[(?:图片|表情包|QQ表情|动画表情|表情)[^\]]*\]/u;

/** 宿主注入的伪 user 消息：脚手架块，或逐轮变化的时间/时区/停顿行。 */
const PSEUDO_USER_LINE_RE = /^(?:Time sampled while preparing|Browser time zone for this request|Elapsed since the preceding step context)/iu;
/** 本轮最后一次 tool 结果的文本：只算最后一条真实 user 之后的，旧步骤不算。 */
function turnFinalToolText(messages) {
    if (!Array.isArray(messages))
        return '';
    const start = lastRealUserIndex(messages);
    if (start < 0)
        return '';
    for (let index = messages.length - 1; index > start; index -= 1) {
        if (messages[index]?.role === 'tool')
            return messageText(messages[index]);
    }
    return '';
}

function isPseudoUserMessage(message) {
    if (message?.role !== 'user')
        return false;
    return scaffoldKindOf(message) !== ''
        || PSEUDO_USER_LINE_RE.test(messageText(message).trim());
}

/** 最后一条真实 user（非宿主脚手架/注入行）的下标；没有返回 -1。 */
function lastRealUserIndex(messages) {
    if (!Array.isArray(messages))
        return -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role === 'user' && !isPseudoUserMessage(message))
            return index;
    }
    return -1;
}

/** 最后一条真实 user 是否带图/表情包（表情包不走读图链，但同样需要收敛）。 */
function isMediaTurn(messages) {
    const index = lastRealUserIndex(messages);
    return index >= 0 && MEDIA_TURN_LABEL_RE.test(messageText(messages[index]));
}

/** 本回合（最后一条真实 user 之后）已经发生的工具调用次数。 */
function turnToolCallCount(messages) {
    const start = Math.max(0, lastRealUserIndex(messages));
    let count = 0;
    for (let index = start; index < messages.length; index += 1) {
        const message = messages[index];
        if (message?.role === 'assistant' && Array.isArray(message.tool_calls))
            count += message.tool_calls.length;
    }
    return count;
}

/** 读完图之后还去调了别的工具（read_image 本身不算）。 */
function wanderedAfterReadImage(messages) {
    const start = Math.max(0, lastRealUserIndex(messages));
    const names = new Map();
    let readAt = -1;
    for (let index = start; index < messages.length; index += 1) {
        const message = messages[index];
        if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
            for (const call of message.tool_calls) {
                if (typeof call?.id === 'string' && typeof call?.function?.name === 'string')
                    names.set(call.id, call.function.name);
            }
            if (readAt >= 0 && message.tool_calls.some(call => call?.function?.name !== 'read_image'))
                return true;
            continue;
        }
        if (message?.role === 'tool' && names.get(message.tool_call_id) === 'read_image' && readAt < 0)
            readAt = index;
    }
    return false;
}

/** 语义解析腿的 prompt 预算由 llm-config.mjs 的 ANALYSIS_PROMPT_BUDGET 统一计算
 *  （窗口的 0.6，至少 analyzeMaxPromptTokens），这里不再保留比例常量。 */

/** 最后一条真实 user 之后，是否已经出现过 read_image 的工具结果。 */
function hasReadImageToolResult(messages) {
    if (!Array.isArray(messages))
        return false;
    // 跳过宿主每一步注入的脚手架（Time sampled…），否则 turnStart 会落在最后一
    // 条脚手架消息上，前面真正的工具结果一个都看不到，读图闸门等于没生效。
    let turnStart = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role === 'user' && scaffoldKindOf(message) === '') {
            turnStart = index;
            break;
        }
    }
    const names = new Map();
    for (let index = turnStart; index < messages.length; index += 1) {
        const message = messages[index];
        if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
            for (const call of message.tool_calls) {
                if (typeof call?.id === 'string' && typeof call?.function?.name === 'string')
                    names.set(call.id, call.function.name);
            }
            continue;
        }
        if (message?.role === 'tool' && names.get(message.tool_call_id) === 'read_image')
            return true;
    }
    return false;
}
/* 「明确要图」硬闸门：只有出现画图动词/求图短句才算。
 * 单纯聊到图、发来一张图、引用别人"发我一张照片"这类都不算——2026-11-12 17:37
 * 那次就是被这种上下文带出了一张无关的图。
 * 2026-11-13：去掉「发[张个]图」——它会把"发张图看看"（向对方索图）当成本方出图。 */
const EXPLICIT_DRAW_RE = /(画一?[张个幅]|画一下|画个|帮我画|给我画|来[张个]图|出[张个]图|生成[一]?[张个]?图|整[张个]图|draw\s+(me\s+)?a|generate\s+an?\s+image)/iu;
/** 出图请求必须冲它说：私聊直接算；群聊要 at 它或引用它。
 * 信封缺失/解析失败时保持旧行为（宁可放过），避免老链路整段变哑。 */
function drawAddressedToMe(messages, index) {
    const evt = decodeEnvelopeOf(messageText(messages[index]));
    if (evt === null || typeof evt !== 'object')
        return true;
    if (String(evt.chat?.type ?? '') !== 'group')
        return true;
    const flags = evt.flags ?? {};
    return flags.atMe === true || flags.quotedMe === true;
}

function inboundWantsImage(messages) {
    if (!Array.isArray(messages))
        return false;
    let seen = 0;
    for (let index = messages.length - 1; index >= 0 && seen < 6; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'user' || isPseudoUserMessage(message))
            continue;
        seen += 1;
        if (EXPLICIT_DRAW_RE.test(messageText(message)) && drawAddressedToMe(messages, index))
            return true;
    }
    return false;
}
/* 回合中途的停顿：宿主每一步会注入 "Elapsed since the preceding step context: 10m 2s"。
 * 画图切显存/引擎重启会把这个值拉到分钟级，这时继续执行停顿前的工具计划就会
 * 做出莫名其妙的事（2026-11-12 17:47 那轮就是停了 10 分钟后把用户发来的照片原样
 * 发回去、又重画一张）。返回 {step, ms}，没有就返回 0。 */
function stepStallInfo(messages) {
    if (!Array.isArray(messages))
        return { step: 0, ms: 0 };
    for (let index = messages.length - 1; index >= 0 && index >= messages.length - 6; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'user')
            continue;
        const text = messageText(message);
        const stepMatch = /Time sampled while preparing turn \d+, step (\d+)/u.exec(text);
        const elapsed = /Elapsed since the preceding step context:\s*(?:(\d+)\s*h(?:ours?)?\s*)?(?:(\d+)\s*m(?:in(?:ute)?s?)?\s*)?(?:(\d+)\s*s(?:ec(?:ond)?s?)?)?/u.exec(text);
        if (stepMatch === null && elapsed === null)
            continue;
        const hours = Number(elapsed?.[1] ?? 0);
        const minutes = Number(elapsed?.[2] ?? 0);
        const seconds = Number(elapsed?.[3] ?? 0);
        return { step: Number(stepMatch?.[1] ?? 0), ms: (hours * 3600 + minutes * 60 + seconds) * 1000 };
    }
    return { step: 0, ms: 0 };
}
const SCAFFOLD_KEEP_NEWEST = new Map(SCAFFOLD_KINDS.map(([kind, , keepNewest]) => [kind, keepNewest]));

function scaffoldKindOf(message) {
    if (message?.role !== 'user')
        return '';
    const head = messageText(message).trimStart();
    for (const [kind, pattern] of SCAFFOLD_KINDS) {
        if (pattern.test(head))
            return kind;
    }
    return '';
}

/** 纯文本版：接话闸门拿到的是字符串，判它是不是宿主注入的脚手架行。 */
function isScaffoldText(text) {
    const head = String(text ?? '').trimStart();
    if (head === '')
        return false;
    return SCAFFOLD_KINDS.some(([, pattern]) => pattern.test(head));
}

/** @returns {{ messages: unknown[], removed: number, savedTokens: number,
 *   dropped: Map<string, number>, totals: Map<string, number>, keptCounts: Map<string, number> }} */
function dedupeScaffoldHistory(messages) {
    const lastIndex = messages.length - 1;
    const totals = new Map();
    const newest = new Map();
    for (let index = 0; index < messages.length; index += 1) {
        const kind = scaffoldKindOf(messages[index]);
        if (kind === '')
            continue;
        totals.set(kind, (totals.get(kind) ?? 0) + 1);
        newest.set(kind, index);
    }
    if (totals.size === 0)
        return { messages, removed: 0, savedTokens: 0, dropped: new Map(), totals, keptCounts: new Map() };
    const dropped = new Map();
    const keptCounts = new Map();
    const deferred = [];
    let savedTokens = 0;
    const alreadyRead = hasReadImageToolResult(messages);
    const kept = [];
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        const kind = scaffoldKindOf(message);
        const keepNewest = SCAFFOLD_KEEP_NEWEST.get(kind) === true;
        const preserve = kind === ''
            || index === lastIndex
            || (keepNewest && newest.get(kind) === index);
        if (preserve) {
            // 读图指令：本轮已经读过图就改写成“已读过”，不再重复催它去读。
            const payload = kind === 'read-image' && alreadyRead
                ? { ...message, content: READ_IMAGE_SCAFFOLD_DONE }
                : message;
            // 运行时快照/时间采样每轮都变：留在原位，它之后的所有历史都拿不到前缀复用。
            // 统一挪到末条 user 之前，只让最后这一小段不可复用。
            if (keepNewest && index !== lastIndex && messages[lastIndex]?.role === 'user')
                deferred.push(payload);
            else
                kept.push(payload);
            if (kind !== '')
                keptCounts.set(kind, (keptCounts.get(kind) ?? 0) + 1);
            continue;
        }
        dropped.set(kind, (dropped.get(kind) ?? 0) + 1);
        savedTokens += estimateMessageTokens(message);
    }
    if (deferred.length > 0) {
        const tail = kept.pop();
        for (const message of deferred)
            kept.push(message);
        if (tail !== undefined)
            kept.push(tail);
    }
    let removed = 0;
    for (const count of dropped.values())
        removed += count;
    return { messages: kept, removed, savedTokens, dropped, totals, keptCounts, relocated: deferred.length };
}

/**
 * 压成一行摘要。返回 { text, sender }：发言人（含是否主人）单独带出，
 * 不再从正文里删掉后丢失——压缩历史里“谁说的”与“说了什么”同样重要。
 */
function compactUserText(text) {
    const sender = senderLabel(text);
    // 有信封就按结构重建，不再从中文字符串里反推 @ 关系。
    const evt = decodeEnvelopeOf(text);
    if (evt !== null) {
        const ats = (Array.isArray(evt.targets) ? evt.targets : [])
            .filter(item => item?.rel === 'at')
            .map(item => {
                const qq = String(item.qq ?? '');
                if (qq === '')
                    return '';
                if (qq === 'all')
                    return '@全体成员(all)';
                if (qq === String(evt.chat?.selfId ?? ''))
                    return '@你(' + qq + ')';
                if (qq === String(evt.chat?.masterQq ?? ''))
                    return '@主人(' + qq + ')';
                return '@' + (String(item.nick ?? '') === '' ? '群友' : item.nick) + '(' + qq + ')';
            })
            .filter(item => item !== '')
            .join(' ');
        const body = String(evt.text ?? '')
            .replace(/\[图片:[^\]]+\]/g, '[图片]')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 160);
        return { text: (ats === '' ? '' : ats + ' ') + body, sender };
    }
    // 【@对象】不能删：长会话压缩后，@ 是唯一还能把"这句话在说谁"绑住的线索。
    // 这里只压成 @昵称(QQ) 的短形式，保留在摘要行首。
    const atLine = /^【@对象】([^\n]*)/mu.exec(text);
    let atShort = '';
    if (atLine !== null) {
        const part = atLine[1].split('（本条由')[0];
        atShort = part.split(/[、,]\s*/u)
            .map(item => item.trim())
            .filter(item => item !== '')
            .map(item => {
                const qq = /(\d{5,12})/u.exec(item);
                const nick = item.replace(/[（(]\s*\d+\s*[)）]/gu, '').trim();
                if (qq === null)
                    return item;
                return '@' + (nick === '' ? 'QQ' + qq[1] : nick + '(' + qq[1] + ')');
            })
            .join(' ');
    }
    // 时间戳前缀与【发送者标记】在这里只做“搬运”：上面已解析成 sender，
    // 由调用方用 `昵称(QQ)[主人]：` 统一还原，不再是直接丢掉。
    const body = text
        .replace(/^\[\d{1,2}:\d{2}\s[^\]]*\(\d{5,12}\)\]\s*/u, '')
        .replace(/^(?:【发送者标记】|【@对象】|【必须】|【群名】)[^\n]*\n?/gmu, '')
        .replace(/\[图片:[^\]]+\]/g, '[图片]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);
    return { text: (atShort === '' ? '' : atShort + ' ') + body, sender };
}

/** From a user message, recover who spoke (nickname + QQ + 是否主人). The summary
 * used to flatten every speaker into “用户”, so after trimming a multi-person
 * group the model could no longer bind “他/你/刚刚那个人” to a QQ and started
 * mixing people up. Returns { label, isMaster }; label 信息不足时为“未知”，
 * 绝不回落到“用户”——那会把不同发言人糊成同一个人。 */
function senderLabel(text) {
    const evt = decodeEnvelopeOf(text);
    if (evt !== null && String(evt.actor?.qq ?? '') !== '') {
        const nick = String(evt.actor?.nick ?? '').trim();
        return {
            label: nick !== '' && nick !== '未知' ? nick + '(' + evt.actor.qq + ')' : 'QQ' + evt.actor.qq,
            isMaster: evt.actor?.isMaster === true,
            qq: String(evt.actor.qq),
            nick,
        };
    }
    const marked = /【发送者标记】QQ=(\d+)\s+是否主人=(是|否)\s+昵称=([^\n]*)/u.exec(text);
    if (marked !== null) {
        const nick = marked[3].trim();
        return {
            label: nick !== '' && nick !== '未知' ? nick + '(' + marked[1] + ')' : 'QQ' + marked[1],
            isMaster: marked[2] === '是',
            qq: marked[1],
            nick,
        };
    }
    const prefixed = /^\[(?:\d{2}:\d{2} )?([^\]\n]+?)\((\d+)\)\]/u.exec(text);
    if (prefixed !== null) {
        const nick = prefixed[1].trim();
        return {
            label: nick !== '' && nick !== '未知' ? nick + '(' + prefixed[2] + ')' : 'QQ' + prefixed[2],
            isMaster: false,
            qq: prefixed[2],
            nick,
        };
    }
    return { label: '未知', isMaster: false, qq: '', nick: '' };
}

/** 摘要行头：昵称(QQ)[主人]。身份必须一眼可见。 */
function speakerTag(sender) {
    return sender.label + (sender.isMaster ? '[主人]' : '');
}

/**
 * 本来就没有发言人的入站消息：宿主运行时快照、纠偏 nudge、定时主动任务。
 * 它们和「有发言人但没解析出来」是两种事，必须分开计数——都记 unknown 的话，
 * 出了归属问题就永远分不清是解析漏了还是压根没人说。
 */
const SYSTEM_MESSAGE_PATTERNS = [
    /^Current runtime context\b/u,
    /^Time sampled while preparing turn\b/u,
    /^<system-reminder>/u,
    /^You are repeating the exact same tool call\b/u,
    /^Repeated tool call detected\b/u,
    /^【重说】/u,
    /^【读图】/u,
    /^【主动事件】/u,
    /^【每日群聊总结】/u,
    /^【必须】/u,
];
/** 合并转发的占位/整包（真展开时正文仍是 `昵称: 内容` 的行，外层另有发送者）。 */
const FORWARD_LINE_PATTERN = /^\[合并转发(?:\]|：|\s)/u;

/** 被裁 user 消息的身份归类：speaker / system / forward-line / unknown。
 * 只有最后一种代表解析失败，前三种是「没有发言人」而不是「没认出发言人」。 */
function classifyDroppedUser(text) {
    const sender = senderLabel(text);
    if (sender.qq !== '')
        return { kind: 'speaker', sender };
    const head = String(text ?? '').trimStart();
    if (FORWARD_LINE_PATTERN.test(head))
        return { kind: 'forward-line', sender };
    if (SYSTEM_MESSAGE_PATTERNS.some(pattern => pattern.test(head)))
        return { kind: 'system', sender };
    return { kind: 'unknown', sender };
}

/**
 * 被裁消息的身份清单：谁被裁掉了、各几条、有没有主人、有没有身份未知的。
 * 只统计 user 消息（assistant/tool 没有“发言人”）。用于事后核对
 * “摘要里 A 的身份还在不在”，而不是靠推测。
 */
function droppedSpeakerSummary(dropped) {
    const senders = new Map();
    const detail = [];
    let speakerSamples = 0;
    let userMessages = 0;
    let unknown = 0;
    let system = 0;
    let forwardLine = 0;
    for (const message of dropped) {
        if (message?.role !== 'user')
            continue;
        userMessages += 1;
        const raw = messageText(message);
        const classified = classifyDroppedUser(raw);
        const sender = classified.sender;
        // 明细优先保留「没有发言人」的行，否则它们永远被前 20 条普通发言挤掉。
        if (classified.kind === 'speaker') {
            if (speakerSamples < 10) {
                speakerSamples += 1;
                if (detail.length < 30)
                    detail.push(speakerTag(sender) + ':' + String(compactUserText(raw).text ?? '').slice(0, 60));
            }
        }
        else if (detail.length < 30) {
            detail.push('[' + classified.kind + ']' + ':' + String(compactUserText(raw).text ?? '').slice(0, 60));
        }
        if (classified.kind === 'unknown') {
            unknown += 1;
            continue;
        }
        if (classified.kind === 'system') {
            system += 1;
            continue;
        }
        if (classified.kind === 'forward-line') {
            forwardLine += 1;
            continue;
        }
        const prev = senders.get(sender.qq);
        if (prev === undefined)
            senders.set(sender.qq, { qq: sender.qq, nick: sender.nick, isMaster: sender.isMaster, count: 1 });
        else {
            prev.count += 1;
            prev.isMaster = prev.isMaster || sender.isMaster;
        }
    }
    return { userMessages, unknown, system, forwardLine, senders: [...senders.values()], detail };
}

/** Extractive rolling summary of the dropped prefix. It is deliberately not
 * sent to an LLM: compaction must still work when the reviewer/model is down. */
/* 摘要时间窗：只把本轮入站之前 SUMMARY_WINDOW_MS 内的内容写进摘要。
 * 以前会把十几个小时前的旧话题也摘进来（2026-11-12 17:55 那句"被证伪了…"
 * 就是把前一天 22:05 的群聊当成了当前问题）。 */
const SUMMARY_WINDOW_MS = 2 * 60 * 60 * 1000;
function messageTimestampOf(message) {
    const text = messageText(message);
    const meta = /【元】(\{[\s\S]*?\})\s*\n/u.exec(text);
    if (meta !== null) {
        try {
            const ts = Number(JSON.parse(meta[1])?.ts);
            if (Number.isFinite(ts) && ts > 0)
                return ts;
        }
        catch {
            // 元数据坏了就退回行首时间
        }
    }
    const clock = /\[(\d{2}):(\d{2})\s/u.exec(text);
    if (clock !== null) {
        const guess = new Date();
        guess.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
        return guess.getTime();
    }
    return 0;
}
function clockLabelOf(ts) {
    if (!Number.isFinite(ts) || ts <= 0)
        return '';
    const date = new Date(ts);
    return '[' + String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0') + ']';
}
function summarizeDropped(dropped, hideReviewTalk = false, options = {}) {
    const newerThanTs = Number(options.newerThanTs ?? 0);
    const imageOnlyTurn = options.imageOnlyTurn === true;
    const lines = [];
    const imagePaths = [];
    let skippedSystem = 0;
    let skippedSystemTokens = 0;
    let skippedOld = 0;
    // assistant/tool 消息没有自己的时间戳，沿用前面最近一条 user 的时间。
    let cursorTs = 0;
    const tsByIndex = dropped.map(message => {
        const own = messageTimestampOf(message);
        if (own > 0)
            cursorTs = own;
        return own > 0 ? own : cursorTs;
    });
    // 采样：最近 16 条 + 全区间均匀抽 6 条 user + 保证含丢弃区间最后 2 条 user。
    // 只取 [-16:] 时，工具密集回合里这 16 条几乎全是 tool/assistant 的 tool_call，
    // 摘要恒为空（实测 chars=0），压缩就退化成“只丢不留”。
    const sampledIndexes = new Set();
    for (let index = Math.max(0, dropped.length - 16); index < dropped.length; index += 1)
        sampledIndexes.add(index);
    const userIndexes = [];
    for (let index = 0; index < dropped.length; index += 1) {
        if (dropped[index]?.role === 'user')
            userIndexes.push(index);
    }
    for (const index of userIndexes.slice(-2))
        sampledIndexes.add(index);
    const evenCount = Math.min(6, userIndexes.length);
    for (let step = 0; step < evenCount; step += 1) {
        const position = evenCount <= 1 ? 0 : Math.round(step * (userIndexes.length - 1) / (evenCount - 1));
        sampledIndexes.add(userIndexes[position]);
    }
    for (const index of [...sampledIndexes].sort((left, right) => left - right)) {
        const message = dropped[index];
        for (const match of messageText(message).matchAll(/\[图片:([^\]]+)\]/gu))
            imagePaths.push(match[1].trim());
        if (lines.length >= 12)
            continue;
        if (message?.role === 'user') {
            const raw = messageText(message);
            const classified = classifyDroppedUser(raw);
            // 系统注入不是“谁说了什么”：不进摘要，否则摘要会退化成一堆
            // “你重复调用了工具”，既占字数又诱导模型继续重复。
            if (classified.kind === 'system') {
                skippedSystem += 1;
                skippedSystemTokens += estimateMessageTokens(message);
                continue;
            }
            const ts = tsByIndex[index] ?? 0;
            // 本轮入站只有图、没有配文时，旧话题一个字都不进摘要。
            if (imageOnlyTurn) {
                skippedOld += 1;
                continue;
            }
            // 超出时间窗（含时间不明）的旧内容一律不进摘要。
            if (newerThanTs > 0 && (ts <= 0 || newerThanTs - ts > SUMMARY_WINDOW_MS)) {
                skippedOld += 1;
                continue;
            }
            const compact = compactUserText(raw);
            if (compact.text !== '') {
                // 永远保留真实发言人：不同人的行不合并，也不统一成“用户”。
                const tag = classified.kind === 'speaker' ? speakerTag(classified.sender) : '[' + classified.kind + ']';
                lines.push(clockLabelOf(ts) + tag + '：' + compact.text);
            }
        }
        else if (message?.role === 'assistant') {
            const raw = messageText(message);
            const ts = tsByIndex[index] ?? 0;
            if (newerThanTs > 0 && (ts <= 0 || newerThanTs - ts > SUMMARY_WINDOW_MS)) {
                skippedOld += 1;
                continue;
            }
            const cleaned = stripHistoryNoise(raw);
            const text = (hideReviewTalk ? stripReviewTalk(cleaned, '') : cleaned).replace(/\s+/g, ' ').trim().slice(0, 140);
            if (text !== '')
                lines.push(clockLabelOf(ts) + '你：' + text);
        }
    }
    // compactUserText turns [图片:path] into [图片], so without this line the
    // path is gone for good and the bot can never look at the image again.
    const uniqueImages = [...new Set(imagePaths)].slice(-4);
    if (uniqueImages.length > 0)
        lines.push('早前上下文里的图片（需要时可 read_image 重看）：' + uniqueImages.join('、'));
    // 人名清单：被裁掉的整段里出现过的发言人，只留 昵称(QQ)，不带内容。
    // 摘要正文只采样 12 行，当事人常常不在样本里；至少让模型知道“这个人存在过”。
    const roster = new Map();
    for (const message of dropped) {
        if (message?.role !== 'user')
            continue;
        const classified = classifyDroppedUser(messageText(message));
        if (classified.kind !== 'speaker')
            continue;
        const qq = String(classified.sender?.qq ?? '');
        if (qq === '' || roster.has(qq))
            continue;
        roster.set(qq, speakerTag(classified.sender).replace('[主人]', ''));
    }
    let rosterChars = 0;
    let rosterTokens = 0;
    if (roster.size > 0) {
        const names = [...roster.values()];
        const shown = names.slice(0, 30);
        const rosterLine = '【发言人清单】' + shown.join('、')
            + '（共 ' + names.length + ' 人' + (names.length > shown.length ? '，只列前 30' : '') + '）';
        lines.push(rosterLine);
        rosterChars = rosterLine.length;
        rosterTokens = estimateMessageTokens({ role: 'user', content: rosterLine });
    }
    // 被裁的全是 system 时 text 为空：调用方据此不注入，避免出现只有标题的空摘要。
    const text = lines.length === 0
        ? ''
        : '【历史摘要·发言人已保留】\n' + lines.join('\n');
    return { text, skippedSystem, skippedSystemTokens, skippedOld, rosterChars, rosterTokens, rosterSize: roster.size, rosterNames: [...roster.values()].slice(0, 30).join('、') };
}

async function loadNotebook() {
    try {
        const raw = await readFile(NOTEBOOK_PATH, 'utf8');
        const notebook = JSON.parse(raw);
        if (!notebook || typeof notebook !== 'object')
            return {};
        return await applyRecallEvents(notebook);
    }
    catch {
        return {};
    }
}

/**
 * 消费插件写出的撤回事件：命中 origin.messageId 的条目 → status=expired + sourceRevoked。
 * 幂等；只在真的有条目变化时原子写回 notebook.json，避免空转。
 * 旧插件写入与本函数可能并发，这里用单进程标志位让下一轮再消费，宁可慢一轮也不覆盖。
 */
async function applyRecallEvents(notebook) {
    if (recallApplying)
        return notebook;
    let text;
    try {
        text = await readFile(RECALL_EVENTS_PATH, 'utf8');
    }
    catch {
        return notebook;
    }
    const events = [];
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === '')
            continue;
        try {
            const event = JSON.parse(trimmed);
            if (event?.type === 'source_recalled')
                events.push(event);
        }
        catch {
            // 坏行跳过，不影响本轮
        }
    }
    if (events.length === 0)
        return notebook;

    recallApplying = true;
    try {
        const result = applyRevocations(notebook, events);
        if (result.changed.length === 0 && result.cascaded.length === 0)
            return notebook;
        const tmp = NOTEBOOK_PATH + '.recall-' + process.pid;
        writeFileSync(tmp, JSON.stringify(notebook, null, 2), 'utf8');
        renameSync(tmp, NOTEBOOK_PATH);
        try {
            appendFileSync(MEMORY_ACCESS_PATH, JSON.stringify({
                ts: new Date().toISOString(),
                type: 'source-revoked',
                changed: result.changed,
                cascaded: result.cascaded,
            }) + '\n', 'utf8');
        }
        catch {
            // 访问日志失败不影响记忆状态
        }
        console.log('[recall] 来源已撤回，条目退出检索: ' + result.changed.join(', '));
        return notebook;
    }
    catch (error) {
        console.log('[recall] 撤回事件应用失败: ' + (error?.message ?? String(error)));
        return notebook;
    }
    finally {
        recallApplying = false;
    }
}

/** 每条入站消息都带可信的发送者标记，私聊也不例外；不能只依赖群前缀。 */
function speakerMark(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const text = messageText(messages[index]);
        const match = /【发送者标记】QQ=(\d{5,12}) 是否主人=(是|否) 昵称=([^\n]+)/u.exec(text);
        if (match !== null)
            return { qq: match[1], isMaster: match[2] === '是', nickname: match[3].trim() };
    }
    return undefined;
}

/**
 * 把历史里的各种图片 part 统一成 image_url + base64 data URL。
 *
 * DSH 会把图片传成 attachment 引用（sha256:...），OpenAI 兼容端点只认
 * base64 data URL，整段历史会因此 400。这里把 attachment 从磁盘还原成
 * base64，让多模态模型真正看到图；只有实在解析不了的附件才退化成文字
 * 占位，保证会话不中断。
 */
const ATTACHMENT_OBJECT_ROOT = process.env.DSH_ATTACHMENT_ROOT
    ?? 'C:\\Users\\user\\.dsh\\attachments\\v1\\objects';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 源图允许读到 32MB，超出直接降级；读进来后一律按像素预算缩放，避免大图把视觉塔显存打爆。 */
const MAX_IMAGE_SOURCE_BYTES = 32 * 1024 * 1024;
/** 约 1MP；超过就等比缩到长边 1,024 且总像素 1MP 以内。Qwen-VL 系默认 max_pixels 同量级。 */
const MAX_IMAGE_PIXELS = 1024 * 1024;
const MAX_IMAGE_EDGE = 1024;
const IMAGE_CACHE_MAX = 12;
const imageDataCache = new Map();

/** 本机引擎只认 PNG/JPEG 的 data URL；WebP/GIF/BMP 会报
 * "'url' field must be a base64 encoded image."，所以先转码再发给模型。 */
const SHARP_CANDIDATES = [
    process.env.DSH_SHARP_PATH,
    'C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\sharp\\dist\\index.mjs',
];
let sharpPromise;
function loadSharp() {
    sharpPromise ??= (async () => {
        for (const candidate of SHARP_CANDIDATES) {
            if (typeof candidate !== 'string' || candidate === '')
                continue;
            const path = candidate.startsWith('file:')
                ? candidate
                : 'file:///' + candidate.replace(/\\/gu, '/').replace(/^\/+/u, '');
            try {
                const module = await import(path);
                return module.default ?? module;
            }
            catch {
                // try next candidate
            }
        }
        return undefined;
    })();
    return sharpPromise;
}

function parseDataUrl(url) {
    const match = /^data:([^;,]+)?;base64,(.*)$/su.exec(url);
    if (match === null)
        return undefined;
    try {
        return { mime: (match[1] ?? '').toLowerCase(), bytes: Buffer.from(match[2], 'base64') };
    }
    catch {
        return undefined;
    }
}

async function imageMeta(sharp, bytes) {
    try {
        const meta = await sharp(bytes, { animated: false }).metadata();
        const width = meta.width ?? 0;
        const height = meta.height ?? 0;
        return width > 0 && height > 0 ? { width, height } : undefined;
    }
    catch {
        return undefined;
    }
}

/** 等比缩放目标尺寸：长边 1,024 与总像素 1MP 双约束取更严的一个，宽高按同一比例，偶数对齐。 */
function targetSize(width, height) {
    const scale = Math.min(
        1,
        MAX_IMAGE_EDGE / Math.max(width, height),
        Math.sqrt(MAX_IMAGE_PIXELS / (width * height)),
    );
    if (scale >= 1)
        return undefined;
    const toEven = value => Math.max(2, Math.floor(value / 2) * 2);
    return {
        width: Math.min(toEven(width * scale), MAX_IMAGE_EDGE),
        height: Math.min(toEven(height * scale), MAX_IMAGE_EDGE),
    };
}

async function toModelDataUrl(bytes, mime) {
    const safeMime = typeof mime === 'string' ? mime.split(';')[0].trim().toLowerCase() : '';
    const nativeMime = safeMime === 'image/png' || safeMime === 'image/jpeg';
    const sizeOk = bytes.length <= MAX_IMAGE_BYTES;
    const sharp = await loadSharp();
    const meta = sharp === undefined ? undefined : await imageMeta(sharp, bytes);
    const withinBudget = meta !== undefined
        && meta.width <= MAX_IMAGE_EDGE
        && meta.height <= MAX_IMAGE_EDGE
        && meta.width * meta.height <= MAX_IMAGE_PIXELS;
    // 尺寸和体积都在预算内才原样透传；否则等比缩放，缩完仍超预算就降级成文字占位。
    if (nativeMime && sizeOk && withinBudget)
        return `data:${safeMime};base64,${bytes.toString('base64')}`;
    if (sharp === undefined) {
        // 没有 sharp 就压不动：9MP 原图进模型要 139 页 KV，直接换来 429。
        // 这一张按“没图”处理（内容会被换成文字占位），回合继续，不整轮失败。
        logLine('image skipped | sharp unavailable, ' + bytes.length + 'B image dropped before model');
        return undefined;
    }
    if (meta === undefined || targetSize(meta.width, meta.height) === undefined)
        return undefined;
    const target = targetSize(meta.width, meta.height);
    try {
        const pipeline = sharp(bytes, { animated: false })
            .resize({ width: target.width, height: target.height, fit: 'inside', withoutEnlargement: true });
        const output = safeMime === 'image/jpeg'
            ? await pipeline.jpeg({ quality: 82 }).toBuffer()
            : await pipeline.png({ compressionLevel: 9 }).toBuffer();
        if (output.length > MAX_IMAGE_BYTES)
            return undefined;
        const ratio = input => (input.height === 0 ? 0 : input.width / input.height).toFixed(2);
        logLine(`image resized | ${meta.width}x${meta.height}(${ratio(meta)}) -> ${target.width}x${target.height}(${ratio(target)}) | ${(bytes.length / 1048576).toFixed(2)}MB -> ${(output.length / 1048576).toFixed(2)}MB`);
        return 'data:' + (safeMime === 'image/jpeg' ? 'image/jpeg' : 'image/png') + ';base64,' + output.toString('base64');
    }
    catch {
        return undefined;
    }
}

function sniffImageMime(bytes) {
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
        return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
        return 'image/jpeg';
    if (bytes.length >= 4 && bytes.toString('ascii', 0, 3) === 'GIF')
        return 'image/gif';
    if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
        return 'image/webp';
    if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d)
        return 'image/bmp';
    return undefined;
}

async function dataUrlFromFile(path, declared) {
    if (typeof path !== 'string' || path === '')
        return undefined;
    try {
        const bytes = await readFile(path);
        if (bytes.length > MAX_IMAGE_SOURCE_BYTES)
            return undefined;
        const mime = sniffImageMime(bytes)
            ?? (typeof declared === 'string' && declared.startsWith('image/') ? declared.split(';')[0].trim() : undefined);
        if (mime === undefined)
            return undefined;
        return await toModelDataUrl(bytes, mime);
    }
    catch {
        return undefined;
    }
}

async function attachmentDataUrl(attachment) {
    const raw = String(attachment?.attachmentId ?? '');
    const match = /(?:sha256:)?([0-9a-fA-F]{64})/u.exec(raw);
    if (match === null)
        return undefined;
    const hash = match[1].toLowerCase();
    const cached = imageDataCache.get(hash);
    if (cached !== undefined)
        return cached;
    const path = join(ATTACHMENT_OBJECT_ROOT, hash.slice(0, 2), hash);
    const dataUrl = await dataUrlFromFile(path, attachment?.mediaType);
    if (dataUrl === undefined)
        return undefined;
    if (imageDataCache.size >= IMAGE_CACHE_MAX)
        imageDataCache.delete(imageDataCache.keys().next().value);
    imageDataCache.set(hash, dataUrl);
    return dataUrl;
}

function filePathFromUrl(url) {
    if (url.startsWith('file://')) {
        try {
            return fileURLToPath(url);
        }
        catch {
            return undefined;
        }
    }
    if (/^[A-Za-z]:[\\/]/u.test(url) || url.startsWith('\\\\'))
        return url;
    return undefined;
}

async function httpImageDataUrl(url) {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
        if (!response.ok)
            return undefined;
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > MAX_IMAGE_SOURCE_BYTES)
            return undefined;
        const mime = sniffImageMime(bytes) ?? (response.headers.get('content-type') ?? '').split(';')[0].trim();
        if (!mime.startsWith('image/'))
            return undefined;
        return await toModelDataUrl(bytes, mime);
    }
    catch {
        return undefined;
    }
}

async function imagePartDataUrl(part) {
    const declared = typeof part?.mimeType === 'string'
        ? part.mimeType
        : (typeof part?.media_type === 'string' ? part.media_type : undefined);
    if (part?.source?.type === 'base64' && typeof part.source.data === 'string') {
        return await toModelDataUrl(
            Buffer.from(part.source.data, 'base64'),
            part.source.media_type ?? declared ?? 'image/png',
        );
    }
    if (typeof part?.data === 'string' && part.data.length > 0) {
        return await toModelDataUrl(Buffer.from(part.data, 'base64'), declared ?? 'image/png');
    }
    if (part?.attachment !== undefined)
        return await attachmentDataUrl(part.attachment);
    const url = typeof part?.image_url === 'string'
        ? part.image_url
        : (typeof part?.image_url?.url === 'string' ? part.image_url.url : undefined);
    if (url !== undefined && url !== '') {
        if (url.startsWith('data:')) {
            const parsed = parseDataUrl(url);
            if (parsed === undefined)
                return undefined;
            return await toModelDataUrl(parsed.bytes, parsed.mime);
        }
        const sha = /(?:sha256:)?([0-9a-fA-F]{64})/u.exec(url);
        if (sha !== null)
            return await attachmentDataUrl({ attachmentId: 'sha256:' + sha[1] });
        const localPath = filePathFromUrl(url);
        if (localPath !== undefined)
            return await dataUrlFromFile(localPath, declared);
        return await httpImageDataUrl(url);
    }
    if (typeof part?.url === 'string')
        return await imagePartDataUrl({ image_url: { url: part.url }, mimeType: declared });
    return undefined;
}

/** 降级时给用户一句能看懂的原因，别只丢一个占位符。 */
function imageFailureNote(part) {
    const base64 = typeof part?.source?.data === 'string'
        ? part.source.data
        : (typeof part?.data === 'string' ? part.data : '');
    if (base64 !== '') {
        const approx = Math.floor(base64.length * 3 / 4);
        if (approx > MAX_IMAGE_SOURCE_BYTES)
            return '源图约 ' + Math.round(approx / 1048576) + 'MB，超过上限';
        return '压缩后仍超出预算或格式不支持';
    }
    return '尺寸过大或格式不支持';
}

async function normalizeImageParts(messages) {
    // 引擎未启用 vision 时，图片 part 会让整轮请求 400。统一降级成文字占位，
    // 保住聊天；等引擎侧开启 --vision 后把 supportsVision 改回 true 即可恢复。
    if (!LLM.supportsVision) {
        let hidden = 0;
        for (const message of messages) {
            if (!Array.isArray(message?.content))
                continue;
            const next = [];
            for (const part of message.content) {
                const type = typeof part?.type === 'string' ? part.type : '';
                const isImage = type === 'image' || type === 'image_url' || type === 'input_image'
                    || part?.image_url !== undefined || part?.source?.type === 'base64';
                if (isImage) {
                    hidden += 1;
                    next.push({ type: 'text', text: '[图片]' });
                }
                else {
                    next.push(part);
                }
            }
            message.content = next;
        }
        return { converted: 0, lost: hidden };
    }
    let converted = 0;
    let lost = 0;
    for (const message of messages) {
        if (!Array.isArray(message?.content))
            continue;
        const next = [];
        for (const part of message.content) {
            const type = typeof part?.type === 'string' ? part.type : '';
            const isImage = type === 'image' || type === 'image_url' || type === 'input_image'
                || part?.image_url !== undefined || part?.source?.type === 'base64';
            if (!isImage) {
                next.push(part);
                continue;
            }
            const dataUrl = await imagePartDataUrl(part);
            if (dataUrl !== undefined) {
                converted += 1;
                next.push({ type: 'image_url', image_url: { url: dataUrl } });
                continue;
            }
            lost += 1;
            const note = imageFailureNote(part);
            const hint = part?.attachment?.attachmentId ?? part?.image_url?.url ?? part?.url ?? '';
            logLine('image part dropped | ' + note + (hint === '' ? '' : ' | ' + String(hint).slice(0, 120)));
            next.push({ type: 'text', text: '[图片已跳过：' + note + ']' });
        }
        message.content = next;
    }
    return { converted, lost };
}

function latestUserMessageText(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'user')
            return messageText(messages[index]);
    }
    return '';
}

/** 群消息一定带 "[HH:MM 昵称(QQ)]" 前缀，私聊没有；不要依赖 @元数据。 */
function latestIsGroupChat(messages) {
    return /\[\d{1,2}:\d{2}\s[^\]]*\(\d{5,12}\)\]/u.test(latestUserMessageText(messages));
}

/** 图片审核/私信流程是后台机制，不是聊天内容。小模型会把工具结果和旧回复里
 * 的“私信给您审核，批准了就发出来”原样复读，群里尤其明显；这里按分句剪掉。 */
const REVIEW_TALK_RE = /(?:私信|私聊|私发).{0,12}(?:主人|您|你|审核|审批|待审|过目|批准|确认|流程)|(?:审核|审批|待审|过目|批准|审核队列).{0,12}(?:图片|图|画|照片|通过|后发|再发|发出来|排队)|(?:发给|发到|提交|送去).{0,10}(?:主人|审核|审批|待审)|发(?:给|到)?(?:您|你|主人).{0,4}(?:审核|过目|批准)|(?:给|等|让|由)(?:主人|您|你).{0,6}(?:过目|审核|批准|同意|确认)|主人.{0,6}(?:审核|批准|过目)|批准后?就发|先审后发|过审/u;

const REVIEW_WORD_RE = /审核|审批|待审|过目|批准|排队|队列|私信|私聊|私发/u;
const IMAGE_CONTEXT_RE = /(?:图|画|照片|插画|立绘|头像|壁纸|出图|自拍)/u;

/** imageContext：这一轮本来就在聊图时，任何“审核/排队/私信”都视为后台流程，
 * 连带把“审核那帮家伙”“还在排队”这类抱怨一起剪掉。 */
function stripReviewTalk(text, fallback = '嗯。', imageContext = false) {
    if (typeof text !== 'string')
        return text;
    if (!REVIEW_TALK_RE.test(text) && !(imageContext && REVIEW_WORD_RE.test(text)))
        return text;
    const parts = text.split(/(?<=[。！？!?，,；;～~\n])/u);
    const kept = parts
        .filter(part => !REVIEW_TALK_RE.test(part) && !(imageContext && REVIEW_WORD_RE.test(part)))
        .join('')
        .replace(/[，,；;、～~\s]+$/u, '')
        .trim();
    return kept !== '' ? kept : fallback;
}

/** 最近几条用户消息（新的在前），用于检索关键词和纠正检测。 */
function recentUserTexts(messages, count = 4) {
    const out = [];
    for (let index = messages.length - 1; index >= 0 && out.length < count; index -= 1) {
        if (messages[index]?.role !== 'user')
            continue;
        const text = messageText(messages[index]);
        if (text.trim() !== '')
            out.push(text);
    }
    return out;
}

/** 明确的出图意图。真实聊天里很少有人刚好说“画一张……图”，
 * “画几张”“画一点这样的图”“图呢”“倒是画啊”都算，必须覆盖。 */
const DRAW_INTENT_RE = new RegExp([
    '(?:画|绘制|生成|出图|p图|来|发|整)[^。！？\\n]{0,16}(?:图|照片|插画|立绘|头像|壁纸|画像)',
    '(?:画|绘制|生成|出图|p图)[^。！？\\n]{0,6}(?:张|幅|下|吧|啊|呗|嘛)',
    '(?:图呢|图在哪|没看到图|还没图|没图|图都没|怎么没图|怎么没画|还没画|倒是画|赶紧画|快画|重画|再画|画吧|画啊)',
    '(?:再|又|多)?来(?:一|两|几|三|四|五|十)?(?:张|张图|几张图)',
    '(?:帮我|给我|你|再|快|赶紧)?(?:画|绘制|p图)(?:一下|吧|啊|呗)?[。！？!?\\s]*$',
].join('|'), 'u');

function hasDrawIntent(text, previousAssistant = '') {
    const plain = String(text ?? '').replace(/【[^】]*】/gu, ' ');
    // QQ 的信封（发送者标记、时间昵称、@对象、<user_message>）会混进长度判断，
    // 所以先把用户真正说的那句取出来。
    const envelope = /<user_message[^>]*>([\s\S]*?)<\/user_message>/u.exec(plain);
    const said = (envelope === null ? plain : envelope[1]).trim();
    if (said === '')
        return false;
    // 出图流程里的续话本身不含“画/图”：「开动漫写实lora」「其他自由发挥」「你倒是调用一下」
    // 「你又忘记工具调用了」。这些是明确的继续出图指令，旧正则全部漏掉，
    // 结果模型只承诺“行，我来画一张”却从不发 tool call。
    const promised = /(画|绘制|出图|生成|图)/u.test(previousAssistant);
    if (said.length <= 80 && /(?:开|换|切|用|加)[^。！？\n]{0,8}(?:lora|风格|画风|模型)/iu.test(said))
        return true;
    if (said.length <= 80 && promised && /(调用|工具|动手|开始|赶紧)/u.test(said))
        return true;
    if (said.length <= 40 && promised && /(自由发挥|随便|你定|看着办|都可以|随意|都行)/u.test(said))
        return true;
    // 技术汇报/技能清单里也会出现“画画”“AI 生图”这类词，那不是让对方出图。
    // 一旦误判就会强制 qq_draw，让 9B 花几分钟去拼一个根本不该画的 prompt，
    // 整轮对话卡死。长文或带这些词的，一律不强制。
    // 注意只看对方真正说的那句（said）：QQ 信封里的发送者标记、@对象说明、
    // 昵称标签加起来常超过 160 字，用整条内容判断会把正常的“再画一张”误杀。
    if (said.length > 160)
        return false;
    if (/(技能|skill|插件|工具|api|接口|汇报|检查结果|生图器|视频生成)/iu.test(said))
        return false;
    return DRAW_INTENT_RE.test(said);
}

function previousAssistantText(messages, lastUserIndex) {
    for (let index = lastUserIndex - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'assistant')
            return messageText(messages[index]);
    }
    return '';
}

async function loadDiary() {
    try {
        const raw = await readFile(DIARY_PATH, 'utf8');
        return raw
            .split('\n')
            .filter(line => line.trim() !== '')
            .slice(-5)
            .map(line => {
                try {
                    return JSON.parse(line);
                }
                catch {
                    return undefined;
                }
            })
            .filter(entry => entry && typeof entry === 'object');
    }
    catch {
        return [];
    }
}

/** 读取 B 站观看的“现状”记录；读不到就当没在刷，不阻塞本轮。 */
async function loadBiliActivity() {
    try {
        const parsed = JSON.parse(await readFile(BILI_STATE_PATH, 'utf8'));
        return Array.isArray(parsed?.activity) ? parsed.activity : [];
    }
    catch {
        return [];
    }
}

function biliDay(date) {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(date);
}

function biliWhen(at, now) {
    if (!Number.isFinite(at) || at <= 0)
        return '最近';
    const age = now - at;
    if (age < 90_000)
        return '刚刚';
    if (age < 3600_000)
        return Math.max(1, Math.round(age / 60_000)) + ' 分钟前';
    const date = new Date(at);
    const hm = String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
    const day = biliDay(date);
    if (day === biliDay(new Date(now)))
        return '今天 ' + hm;
    const yesterday = biliDay(new Date(now - 24 * 3600_000));
    if (day === yesterday)
        return '昨天 ' + hm;
    return Math.max(1, Math.round(age / (24 * 3600_000))) + ' 天前';
}

/** 后台刷视频不该只是一段结论摘要：改写成第一人称的现状，进现有 dynamicSections。 */
function biliActivitySection(items, now = Date.now()) {
    if (!Array.isArray(items) || items.length === 0)
        return '';
    const lines = [];
    for (const item of items.slice(-3).reverse()) {
        const title = String(item?.title ?? '').trim();
        if (title === '')
            continue;
        const at = Date.parse(String(item?.at ?? ''));
        const age = Number.isFinite(at) ? now - at : Number.POSITIVE_INFINITY;
        const when = biliWhen(at, now);
        const owner = String(item?.owner ?? '').trim();
        const secs = Number(item?.duration ?? 0);
        const duration = secs >= 60
            ? Math.floor(secs / 60) + ' 分 ' + (secs % 60) + ' 秒'
            : secs + ' 秒';
        const source = String(item?.source ?? '');
        const how = source === 'proactive'
            ? '是我自己刷到的'
            : source === 'feed'
                ? '是我从候选里挑的'
                : source === 'backfill'
                    ? '是之前补刷的'
                    : '是对方点名让我看的';
        const why = String(item?.reason ?? '').trim();
        const gist = String(item?.summary ?? '').replace(/\s+/gu, ' ').trim().slice(0, 80);
        lines.push('- ' + when + ' ' + (age < 2 * 3600_000 ? '我正在看' : '我最近看过')
            + '《' + title + '》' + (owner === '' ? '' : '（UP：' + owner + '）')
            + '，' + duration + '，' + how + (why === '' ? '' : '，因为' + why) + '。'
            + (gist === '' ? '' : '我的印象：' + gist));
    }
    if (lines.length === 0)
        return '';
    return '## 我正在做什么\n这些是你自己真实的观看活动，不是别人转述的摘要；被问到在干嘛时按这里说，不要否认看过。\n'
        + lines.join('\n');
}

function diaryText(entries) {
    if (entries.length === 0)
        return '';
    const lines = ['最近日记（你自己写的，只作参考，不要整段复述）：'];
    for (const entry of entries) {
        const text = typeof entry?.text === 'string' ? entry.text : '';
        if (text === '')
            continue;
        const date = typeof entry?.date === 'string' && entry.date !== '' ? entry.date + '：' : '';
        lines.push('- ' + date + text);
    }
    let out = lines.join('\n');
    if (out.length > 1200)
        out = out.slice(0, 1200) + '…';
    return out;
}

function logLine(line) {
    const stamp = new Date().toISOString();
    appendFile(LOG_PATH, `[${stamp}] ${line}\n`, 'utf8').catch(() => {});
}

/* 常驻群聊上下文压缩器：机器人没被触发时也按 conversation-feed 增量压缩。
 * 走同一上游但只占一个普通请求位；失败由压缩器自己退避重放，不丢消息。 */
function completePlain(messages, options = {}) {
    return new Promise((resolve, reject) => {
        const payload = Buffer.from(JSON.stringify(normalizePayload({
            temperature: 0.2,
            max_tokens: Math.max(120, Math.min(1200, Number(options.maxTokens) || 900)),
            stream: false,
            messages,
        })), 'utf8');
        const headers = applyUpstreamAuth({
            'content-type': 'application/json',
            'content-length': String(payload.length),
        });
        const upstream = UPSTREAM_TRANSPORT.request({
            host: LLM.host,
            port: LLM.port,
            method: 'POST',
            path: chatCompletionsPath(),
            headers,
            timeout: 120_000,
        }, upstreamRes => {
            let text = '';
            upstreamRes.setEncoding('utf8');
            upstreamRes.on('data', chunk => { text += chunk; });
            upstreamRes.on('end', () => {
                try {
                    const parsed = JSON.parse(text);
                    const content = parsed?.choices?.[0]?.message?.content;
                    if (typeof content !== 'string' || content === '')
                        throw new Error('empty completion: ' + text.slice(0, 120));
                    resolve(content);
                }
                catch (error) {
                    reject(error);
                }
            });
        });
        upstream.on('error', reject);
        upstream.on('timeout', () => upstream.destroy(new Error('completion timeout')));
        upstream.end(payload);
    });
}
const contextCompressor = createContextCompressor({
    log: (level, message) => logLine('[ctx] ' + level + ' ' + message),
    complete: completePlain,
});

/** 记忆访问日志：只记“注入了谁、挡掉了谁”，不含正文。
 * 日志失败绝不影响本轮请求，所以同步写 + 吞掉异常。 */
function logMemoryAccess(record) {
    try {
        appendFileSync(MEMORY_ACCESS_PATH, JSON.stringify(record) + '\n', 'utf8');
    }
    catch {
        // ignore
    }
}

function forward(req, res, body) {
    const headers = applyUpstreamAuth({ ...req.headers });
    delete headers.host;
    delete headers['content-length'];
    if (body !== undefined)
        headers['content-length'] = String(body.length);
    res.on('error', () => {});
    const upstream = UPSTREAM_TRANSPORT.request({
        host: LLM.host,
        port: LLM.port,
        method: req.method,
        path: upstreamPath(req.url),
        headers,
        timeout: LLM.requestTimeoutMs,
    }, upstreamRes => {
        upstreamRes.on('error', () => {});
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
    });
    req.on('aborted', () => upstream.destroy());
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', error => {
        logLine('upstream error: ' + (error instanceof Error ? error.message : String(error)));
        if (!res.headersSent)
            res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'persona proxy upstream error: ' + (error instanceof Error ? error.message : String(error)) } }));
    });
    if (body !== undefined)
        upstream.end(body);
    else
        req.pipe(upstream);
}

/** 出图风格名，和 qq_draw 的 style 参数一致；用户说“开动漫写实lora”时用它。 */
const DRAW_STYLES = ['厚涂2.5D', '动漫写实', '赛璐珞', '鲸鱼娘', '鬼针草v2', '鬼针草Anima', 'BunnySlop', 'Kzmynon', 'Silvana', 'ningenmame', 'cunnyfunky', '奶蛙', 'shionnnk'];

// ---- DSH 桌面请求兜底：采样默认值、历史预算、并发上限 -------------------
// QQ 路径有自己的预算逻辑；这里只服务 DSH 桌面宿主，避免把客户端参数
// 一项项搬到 DSH 配置里，换后端时只改这里。
const DSH_MAX_TOKENS_DEFAULT = 256;
const DSH_MAX_TOKENS_CEILING = 800;
const DSH_HISTORY_TOKEN_BUDGET = BUDGET.dshHistoryTokens;
// 引擎 KV 池 896 页（57,344 token），实测 3 路各 12k 历史不耗尽；
// 并发 3 时聚合 220 tok/s、单条 p95 约 4.2s。所有走上游的请求（QQ、桌面宿主、
// 语义解析、出图提示词、图片审核）共用这个有界信号量，满了直接拒绝并记日志。
const UPSTREAM_MAX_CONCURRENCY = Math.max(1, Number(process.env.QQ_UPSTREAM_MAX_CONCURRENCY ?? 3));
const UPSTREAM_QUEUE_LIMIT = Math.max(1, Number(process.env.QQ_UPSTREAM_QUEUE_LIMIT ?? 8));

// 引擎请求准备阶段的内部 5xx（如 "prepared shared candidates exceeded the fixed subset bound"）
// 重发通常能过：有限次、带退避地静默重试；仍失败就这轮不说话，绝不对外冒兜底话术。
const UPSTREAM_SILENT_RETRIES = Math.max(0, Number(process.env.QQ_UPSTREAM_SILENT_RETRIES ?? 2));
const UPSTREAM_SILENT_BACKOFF_MS = Math.max(100, Number(process.env.QQ_UPSTREAM_SILENT_BACKOFF_MS ?? 700));

// 上游故障计数：静默重试不能把故障藏起来。每次 5xx、重试成功、最终静默丢弃
// 各写一行 JSONL，带 day/hour 字段，方便按天/小时统计频次走势。
const UPSTREAM_FAULT_LEDGER = process.env.QQ_UPSTREAM_FAULT_LEDGER ?? 'Y:/dsh/home/qq-persona/upstream-faults.jsonl';

function estimateTextTokens(text) {
    let cjk = 0;
    let other = 0;
    for (const char of String(text ?? '')) {
        if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/u.test(char))
            cjk += 1;
        else
            other += 1;
    }
    return cjk + Math.ceil(other / 4);
}

function messageTokens(message) {
    if (!message || typeof message !== 'object')
        return 0;
    let total = 8;
    if (typeof message.content === 'string') {
        total += estimateTextTokens(message.content);
    }
    else if (Array.isArray(message.content)) {
        for (const part of message.content) {
            if (typeof part?.text === 'string')
                total += estimateTextTokens(part.text);
            else if (part?.type === 'image_url' || part?.type === 'input_image')
                total += 1000;
            else
                total += 200;
        }
    }
    if (message.tool_calls)
        total += estimateTextTokens(JSON.stringify(message.tool_calls));
    return total;
}

/** 只保留最近约 12k token：系统提示固定保留，超预算时从最旧的对话开始丢。 */
function trimDshHistory(messages) {
    const sizes = [];
    let total = 0;
    for (const message of messages) {
        const size = messageTokens(message);
        sizes.push(size);
        total += size;
    }
    if (total <= DSH_HISTORY_TOKEN_BUDGET)
        return 0;
    let fixedEnd = 0;
    while (fixedEnd < messages.length && (messages[fixedEnd]?.role === 'system' || messages[fixedEnd]?.role === 'developer'))
        fixedEnd += 1;
    let keepFrom = messages.length - 1;
    let budget = DSH_HISTORY_TOKEN_BUDGET;
    for (let index = messages.length - 1; index >= fixedEnd; index -= 1) {
        if (index !== messages.length - 1 && sizes[index] > budget)
            break;
        budget -= sizes[index];
        keepFrom = index;
    }
    // 不能从 tool 结果开头，否则工具调用和结果配不上，上游会 400。
    while (keepFrom < messages.length && messages[keepFrom]?.role === 'tool')
        keepFrom += 1;
    if (keepFrom <= fixedEnd)
        return 0;
    const dropped = messages.length - (fixedEnd + (messages.length - keepFrom));
    const kept = [...messages.slice(0, fixedEnd), ...messages.slice(keepFrom)];
    messages.length = 0;
    messages.push(...kept);
    return dropped;
}

function lastUserText(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'user')
            return messageText(messages[index]);
    }
    return '';
}

/** 新模型语义：默认 0.7/0.9，回复 256 token；工具或代码/解释场景放宽到 800。 */
function applyDshDefaults(body, messages) {
    if (!Number.isFinite(Number(body.temperature)))
        body.temperature = 0.7;
    if (!Number.isFinite(Number(body.top_p)))
        body.top_p = 0.9;
    const wantsLong = (Array.isArray(body.tools) && body.tools.length > 0)
        || /```|代码|code\b|解释|实现|重构|debug/iu.test(lastUserText(messages));
    const ceiling = wantsLong ? DSH_MAX_TOKENS_CEILING : DSH_MAX_TOKENS_DEFAULT;
    const requested = Number(body.max_tokens);
    body.max_tokens = Number.isFinite(requested) && requested > 0
        ? Math.min(requested, DSH_MAX_TOKENS_CEILING)
        : ceiling;
}

let upstreamActive = 0;
const upstreamWaiters = [];
let upstreamDropped = 0;

class UpstreamQueueFull extends Error {
    constructor() {
        super('upstream queue full');
        this.name = 'UpstreamQueueFull';
    }
}

function acquireUpstreamSlot() {
    if (upstreamActive < UPSTREAM_MAX_CONCURRENCY) {
        upstreamActive += 1;
        return Promise.resolve();
    }
    if (upstreamWaiters.length >= UPSTREAM_QUEUE_LIMIT) {
        upstreamDropped += 1;
        logLine('upstream queue full: dropped=' + upstreamDropped + ' waiting=' + upstreamWaiters.length
            + ' limit=' + UPSTREAM_QUEUE_LIMIT + ' active=' + upstreamActive);
        return Promise.reject(new UpstreamQueueFull());
    }
    return new Promise(resolve => upstreamWaiters.push(resolve));
}

function releaseUpstreamSlot() {
    upstreamActive -= 1;
    if (upstreamActive < 0)
        upstreamActive = 0;
    const next = upstreamWaiters.shift();
    if (next !== undefined) {
        upstreamActive += 1;
        next();
    }
}


function cleanEnvelope(text) {
    return String(text ?? '')
        .replace(/【[^】]*】/gu, ' ')
        .replace(/<user_message[^>]*>/gu, ' ')
        .replace(/<\/user_message>/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

/** 上游模型不肯发 tool call 时，单独让它把画面翻译成英文标签。 */
async function composeDrawArgs(kept, lastUserIndex, contentHint) {
    const lines = [];
    for (const text of recentUserTexts(kept, 5).reverse()) {
        const clean = cleanEnvelope(text);
        if (clean !== '')
            lines.push('对方：' + clean.slice(0, 300));
    }
    const promise = previousAssistantText(kept, lastUserIndex);
    if (promise !== '' && /(画|图)/u.test(promise))
        lines.push('你刚说过：' + cleanEnvelope(promise).slice(0, 300));
    const hint = cleanEnvelope(contentHint);
    if (hint !== '')
        lines.push('你这一轮想回：' + hint.slice(0, 300));
    if (lines.length === 0)
        return undefined;
    try {
        const response = await postUpstreamJson({
            model: LLM.model,
            temperature: 0.5,
            max_tokens: 360,
            stream: false,
            reasoning_effort: 'none',
            messages: [
                { role: 'system', content: '你是出图提示词生成器。你只输出一行 JSON，不聊天、不解释。' },
                {
                    role: 'user',
                    content: '对话（从旧到新）：\n' + lines.join('\n')
                        + '\n\n根据对方最后要的画面，写这张图的英文 Danbooru 标签：人物数量、发型发色、服装、动作、表情、场景、构图、光照，逗号分隔。'
                        + '人物一律是成年人；不要色情描写，不要中文句子，不要“画好了/马上画”这类话。\n'
                        + '只输出：{"prompt":"1girl, solo, ..."}',
                },
            ],
        }, 90_000);
        const parsed = parseAnalysisJson(response?.choices?.[0]?.message?.content);
        const prompt = typeof parsed?.prompt === 'string' ? parsed.prompt.replace(/\s+/gu, ' ').trim() : '';
        if (prompt === '')
            return undefined;
        return { prompt };
    }
    catch (error) {
        logLine('forced draw prompt error: ' + (error instanceof Error ? error.message : String(error)));
        return undefined;
    }
}

/** 画幅别名归一：模型常把“竖图/横图”直接塞进 aspect，工具只认比例。 */
function normalizeAspect(value, joined) {
    const ratios = ['21:9', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '1:1'];
    const direct = String(value ?? '').trim();
    for (const ratio of ratios) {
        if (direct.includes(ratio))
            return ratio;
    }
    if (/竖/u.test(direct))
        return '9:16';
    if (/横|宽/u.test(direct))
        return '16:9';
    if (/方/u.test(direct))
        return '1:1';
    for (const ratio of ratios) {
        if (joined.includes(ratio))
            return ratio;
    }
    if (/竖/u.test(joined))
        return '9:16';
    if (/横|宽/u.test(joined))
        return '16:9';
    return undefined;
}

/** 用户最近说的话里指定的风格/画幅，补进合成参数；不合法的 style 丢掉。 */
function applyDrawOptions(args, kept) {
    // 发到哪个会话由插件按当前 session 和权限决定，模型给的 chat_id 一律不用，
    // 否则它会自己猜成“私聊主人”或别的群。
    delete args.chat_id;
    const joined = recentUserTexts(kept, 4).map(cleanEnvelope).join('\n');
    if (typeof args.style === 'string') {
        const style = args.style.replace(/（默认）/gu, '').trim();
        if (!DRAW_STYLES.includes(style))
            delete args.style;
    }
    if (typeof args.style !== 'string') {
        for (const style of DRAW_STYLES) {
            if (joined.includes(style)) {
                args.style = style;
                break;
            }
        }
    }
    const aspect = normalizeAspect(args.aspect, joined);
    if (aspect === undefined || aspect === '1:1')
        delete args.aspect;
    else
        args.aspect = aspect;
    return args;
}

function synthResponseBase(body) {
    const created = Math.floor(Date.now() / 1000);
    const suffix = Math.random().toString(36).slice(2, 10);
    return {
        id: 'chatcmpl-draw' + suffix,
        created,
        model: typeof body.model === 'string' && body.model !== '' ? body.model : LLM.model,
        callId: 'call_draw_' + suffix,
    };
}

/** 合成一个 qq_draw 的 tool call 回给 DSH；流式/非流式都按 OpenAI 协议。 */
function sendDrawToolCall(res, body, args) {
    const base = synthResponseBase(body);
    const argsText = JSON.stringify(args);
    if (body.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            id: base.id,
            object: 'chat.completion',
            created: base.created,
            model: base.model,
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                        id: base.callId,
                        type: 'function',
                        function: { name: 'qq_draw', arguments: argsText },
                    }],
                },
                finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }));
        return;
    }
    const head = { id: base.id, object: 'chat.completion.chunk', created: base.created, model: base.model };
    res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
    });
    res.write('data: ' + JSON.stringify({
        ...head,
        choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }],
    }) + '\n\n');
    res.write('data: ' + JSON.stringify({
        ...head,
        choices: [{
            index: 0,
            delta: {
                tool_calls: [{
                    index: 0,
                    id: base.callId,
                    type: 'function',
                    function: { name: 'qq_draw', arguments: argsText },
                }],
            },
            finish_reason: null,
        }],
    }) + '\n\n');
    res.write('data: ' + JSON.stringify({
        ...head,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    }) + '\n\n');
    res.end('data: [DONE]\n\n');
}

function sendPlainText(res, body, text) {
    const base = synthResponseBase(body);
    if (body.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            id: base.id,
            object: 'chat.completion',
            created: base.created,
            model: base.model,
            choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }));
        return;
    }
    const head = { id: base.id, object: 'chat.completion.chunk', created: base.created, model: base.model };
    res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
    });
    res.write('data: ' + JSON.stringify({
        ...head,
        choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    }) + '\n\n');
    res.write('data: ' + JSON.stringify({
        ...head,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }) + '\n\n');
    res.end('data: [DONE]\n\n');
}

/** 上游 5xx 不能合成 200 空 assistant：宿主会把它记成
 * “completed response with no content”，桌面端就显示“本轮运行失败”。
 * 回明确错误码，让客户端按失败处理（可自行重试）；QQ 侧仍然不出话。 */
function sendUpstreamFailure(res, status, detail, code = 'upstream_' + status) {
    if (res.headersSent) {
        try {
            res.end();
        }
        catch { }
        return;
    }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
        error: {
            message: String(detail ?? '').slice(0, 300),
            type: 'upstream_error',
            code,
        },
    }));
}

/** 有意沉默：QQ 回合照旧不出话（插件的空回复逻辑处理）；其它来源
 * 一律回带 error.code 的错误——桌面端/普通客户端不允许收到 200 空正文。 */
function sendSilence(res, body, source, code, detail) {
    if (source === 'qq') {
        sendPlainText(res, body, '');
        return;
    }
    logLine('client source refused empty reply: code=' + code);
    sendUpstreamFailure(res, 502, detail, code);
}

/** 模型嘴上说“画好/马上画/再画几张”，但没发 tool call 时的识别。
 * 只认明确的完成或承诺，问句和否定句不算。 */
/* 2026-11-13：补「我画给你」「画给你看」「等我画」这类顺序变体——原来的
 * 正则要求“给你”在“画”前，导致 08:47「行，我画给你。」完全没被识别。 */
const DRAW_CLAIM_PROMISE_RE = /(?:(?:这就|马上|现在|立刻|开始|直接|待会|待会儿|一会|稍等)(?:给你|帮你|给群里|给你们|给大家)?(?:画|绘制|生成|出图))|(?<![不别没])(?:我|人家)?(?:画|绘制)(?:一张|几张|一幅|几幅)?(?:给你|给你们|给大家|给群里)(?:看)?|(?:等(?:我|我下|一下|会儿)(?:给你|帮你|给你们|给大家|给群里)?(?:画|绘制))/u;
const DRAW_CLAIM_COMPLETION_RE = /(?:画好|画完|画出来|出图|生成好|生成完)(?:了|啦|咯|喽|哟|呢|，|。|！|!|$)/u;
const DRAW_CLAIM_INTENT_RE = /(?:再|多)(?:画|绘制)(?:一张|几张|一幅|几幅)|(?:想|打算|寻思|准备)(?:再|多)?(?:给你|帮你|给你们|给大家|给群里)?(?:画|绘制)(?:一张|几张|一幅|几幅)/u;
const DRAW_CLAIM_PERSONAL_RE = /(?:我|人家)(?:给你|帮你|给你们|给大家|给群里)(?:画|绘制)(?:一张|几张|一幅|几幅)/u;
const DRAW_CLAIM_OFFER_RE = /(?:要不要|想不想|需不需要|需要我|要我|可以给你|能不能)(?:给你|帮你|给你们|给大家|给群里)?(?:画|绘制|生成|出图)/u;
const DRAW_CLAIM_NEGATIVE_RE = /(?:还没|没有|不|别|不会|无法|不能|没)(?:真正)?(?:画|出图|生成)|(?:画不好|画不了|画不出|不会画|没画|没出图|没有图)/u;

function claimsDraw(text) {
    const said = String(text ?? '');
    if (said === '')
        return false;
    if (DRAW_CLAIM_OFFER_RE.test(said))
        return false;
    if (DRAW_CLAIM_PROMISE_RE.test(said))
        return true;
    if (DRAW_CLAIM_NEGATIVE_RE.test(said))
        return false;
    return DRAW_CLAIM_COMPLETION_RE.test(said)
        || DRAW_CLAIM_INTENT_RE.test(said)
        || DRAW_CLAIM_PERSONAL_RE.test(said);
}

/** 本轮不该出图却说了“我画给你”：按句删掉承诺，删空由调用方沉默。
 * 否定句（不画/懒得画/画不了）claimsDraw 返回 false，原样保留。 */
function stripDrawPromises(text) {
    const said = String(text ?? '');
    if (said === '')
        return said;
    // 逗号也算分句边界：只删承诺那半句，别把「这图真好看，我画给你看」整句吞掉。
    const kept = said.split(/(?<=[。！？!?；;，,\n])/u).filter(part => !claimsDraw(part));
    const stripped = kept.join('').replace(/\n{3,}/gu, '\n\n').trim();
    // 只剩「行，/好，」这类应答词时按删空处理，不留半句。
    return /^[行好嗯哦噢对是]{1,2}[，,。！!、\s]*$/u.test(stripped) ? '' : stripped;
}

/* 反向校验（只记审计，不改正文）：模型声称“发了图/文件”“查过/搜过”，
 * 但这一步并没有对应的成功调用。先攒样本，再决定要不要改正文。 */
const CLAIM_SEND_RE = /(?:我(?:已经|刚)?(?:把|给你)?(?:发|传)(?:了|过去|给你)?[^。！？\n]{0,10}(?:图|照片|文件|表情|截图))|(?:(?:图|照片|文件|截图)[^。！？\n]{0,6}(?:发|传)(?:过去|给你|好了))/u;
const CLAIM_SEARCH_RE = /(?:我(?:刚|已经)?(?:查|搜|检索)(?:了|到)|搜到(?:了)?|查到(?:了)?|网上(?:说|查到))/u;
const CLAIM_SEARCH_TOOLS = new Set(['web_search', 'web_fetch', 'qq_bili_feed', 'qq_bili_watch', 'qq_tool']);
function auditClaimWithoutCall(content, calls) {
    const said = String(content ?? '');
    if (said.trim() === '')
        return;
    const names = new Set((Array.isArray(calls) ? calls : [])
        .map(call => call?.function?.name)
        .filter(name => typeof name === 'string'));
    if (claimsDraw(said) && !names.has('qq_draw'))
        logLine('claim without call: draw');
    if (CLAIM_SEND_RE.test(said) && !names.has('qq_send_image'))
        logLine('claim without call: media');
    if (CLAIM_SEARCH_RE.test(said) && !Array.from(names).some(name => CLAIM_SEARCH_TOOLS.has(name)))
        logLine('claim without call: search');
}

/** 把上游非流式消息（正文、普通 tool call、出图 tool call）统一转成
 * DSH 能解析的 OpenAI 响应；QQ 不需要逐字流式。 */
function sendAssistantMessage(res, body, message, finishReason) {
    const base = synthResponseBase(body);
    const content = typeof message?.content === 'string' ? message.content : null;
    const toolCalls = Array.isArray(message?.tool_calls)
        ? message.tool_calls.filter(call => typeof call?.function?.name === 'string')
        : [];
    const normalized = toolCalls.map((call, index) => ({
        id: typeof call.id === 'string' && call.id !== '' ? call.id : base.callId + '_' + index,
        type: 'function',
        function: {
            name: call.function.name,
            arguments: typeof call.function.arguments === 'string'
                ? call.function.arguments
                : JSON.stringify(call.function.arguments ?? {}),
        },
    }));
    const reason = normalized.length > 0
        ? 'tool_calls'
        : (typeof finishReason === 'string' && finishReason !== '' ? finishReason : 'stop');
    // 平台不代模型说话：空正文原样下发（QQ 侧由插件沉默），这里只留一条原因。
    if (isEffectivelyEmpty(content) && normalized.length === 0)
        logLine('QQ silence: model returned no content, platform will not speak');
    if (body.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            id: base.id,
            object: 'chat.completion',
            created: base.created,
            model: base.model,
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content,
                    tool_calls: normalized.length > 0 ? normalized : undefined,
                },
                finish_reason: reason,
            }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }));
        return;
    }
    const head = { id: base.id, object: 'chat.completion.chunk', created: base.created, model: base.model };
    res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
    });
    res.write('data: ' + JSON.stringify({
        ...head,
        choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
    }) + '\n\n');
    if (normalized.length > 0) {
        res.write('data: ' + JSON.stringify({
            ...head,
            choices: [{
                index: 0,
                delta: { tool_calls: normalized.map((call, index) => ({ ...call, index })) },
                finish_reason: null,
            }],
        }) + '\n\n');
    }
    res.write('data: ' + JSON.stringify({
        ...head,
        choices: [{ index: 0, delta: {}, finish_reason: reason }],
    }) + '\n\n');
    res.end('data: [DONE]\n\n');
}

/** 模型自己发起的 qq_draw 也要过一遍参数清洗：删掉它猜的 chat_id，
 * 修正不合法的 style/aspect，否则图会被发到错误会话或参数报错。 */
function sanitizeDrawCalls(message, kept) {
    if (!Array.isArray(message?.tool_calls))
        return message;
    let changed = false;
    const toolCalls = message.tool_calls.map(call => {
        if (call?.function?.name !== 'qq_draw')
            return call;
        let args;
        try {
            args = JSON.parse(String(call.function.arguments ?? '{}'));
        }
        catch {
            return call;
        }
        if (!args || typeof args !== 'object')
            return call;
        applyDrawOptions(args, kept);
        changed = true;
        return { ...call, function: { ...call.function, arguments: JSON.stringify(args) } };
    });
    return changed ? { ...message, tool_calls: toolCalls } : message;
}

/** 截断字符串时可能切在 emoji 的代理对中间，留下孤立的高/低位代理。
 * 严格的 JSON 解析器遇到这种字符会直接回 400
 * （surrogate U+D800..U+DBFF must be followed by...），整轮回复丢失。
 * 所以发往上游之前，把所有 text 字段里的孤立代理清掉。 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function scrubText(value) {
    return typeof value === 'string' ? value.replace(LONE_SURROGATE, '') : value;
}

function scrubMessage(message) {
    if (typeof message?.content === 'string')
        return { ...message, content: scrubText(message.content) };
    if (Array.isArray(message?.content))
        return { ...message, content: message.content.map(part => part !== null && typeof part === 'object' && typeof part.text === 'string' ? { ...part, text: scrubText(part.text) } : part) };
    return message;
}

function scrubBody(body) {
    if (!Array.isArray(body?.messages))
        return body;
    return { ...body, messages: body.messages.map(scrubMessage) };
}

/** 兜底短句轮换：同一句反复出现比不说话更像坏了，至少别复读。 */
const FALLBACK_LINES = [
    '刚走神了，你再说一遍？',
    '哎，我这边断了一下，重说一次？',
    '刚才没接住，再来一遍。',
];
let fallbackCursor = 0;
function normalizeReply(text) {
    return String(text ?? '').replace(/\s+/gu, ' ').trim();
}
function nextFallbackLine(avoid = '') {
    const skip = normalizeReply(avoid);
    for (let step = 0; step < FALLBACK_LINES.length; step += 1) {
        const line = FALLBACK_LINES[fallbackCursor % FALLBACK_LINES.length];
        fallbackCursor += 1;
        if (normalizeReply(line) !== skip)
            return line;
    }
    return '';
}

/** 回声故障重生成：追加一条约束，明确只要最终发言、不要任何标记。 */
function withNoMarkerHint(payload) {
    return {
        ...payload,
        messages: [...payload.messages, {
            role: 'system',
            content: '直接输出给对方的聊天回复，1-2 句。不要输出【内心】【发送者标记】【场景标记】等任何标记，不要解释思考过程。',
        }],
    };
}

/** 带图/表情/转发回合空输出时的补答：撤工具，逼它给一句话。 */
function withMediaForceHint(payload) {
    return {
        ...payload,
        messages: [...payload.messages, {
            role: 'system',
            content: '## 现在就回答\n对方发来的是一条媒体消息（图片/表情包/合并转发），不要调用任何工具。'
                + '直接用一句话回应：说你从图里看到的、或你对这个表情的反应；看不清内容就直说看不清并追问一句。'
                + '不要提工具、流程、本轮或任何内部状态。',
        }],
    };
}

/** 调用全被丢弃时的补答：撤工具 + 明确要求直接说话。 */
function withNoToolsHint(payload) {
    return {
        ...payload,
        tools: undefined,
        messages: [...payload.messages, {
            role: 'system',
            content: '## 现在就回答\n这一步没有可用工具，不要调用任何工具。'
                + '直接针对对方最新一条消息回一句自然的话，1-2 句；不要提工具、流程或任何内部状态。',
        }],
    };
}

/** 复读重生成：明确告诉模型它上一句是什么，只按最新消息重说。 */
function withNoRepeatHint(payload, previous) {
    const said = normalizeReply(previous).slice(0, 120);
    return {
        ...payload,
        messages: [...payload.messages, {
            role: 'system',
            content: '你上一条回复是「' + said + '」。这次不要重复它，也不要换汤不换药地改写；只根据对方最新一条消息给一个具体、自然的说法，1-2 句。',
        }],
    };
}

/** 整段正文只有一个 tool_call 标记（或干脆为空）：这类输出是坏行，不能当回复。 */
function isToolMarkupOnly(text) {
    const trimmed = String(text ?? '').trim();
    return trimmed.replace(/<\|?\/?\s*tool_call\s*\|?>/giu, '').trim() === '';
}

/* 同样的空截断残片在窗口内重复出现时，不再按原样重试：重试只会得到同一个 1-token 结果。 */
const TRUNCATED_REPEAT_WINDOW_MS = 10 * 60 * 1000;
const TRUNCATED_TINY_CHARS = 60;
const truncatedEmptySeen = new Map(); // key: chatId|残片 → { at, hits }

function truncatedRepeatKey(chatId, content) {
    if (typeof content !== 'string' || content.length === 0 || content.length > TRUNCATED_TINY_CHARS)
        return '';
    return (chatId || '-') + '|' + content;
}

/* read_image 重复读取闸门：同一张图同一回合最多读 2 次（第 3 次的结果不再发上游），
 * 跨回合同一 (chatId, path) 累计最多 6 次。命中后不把请求发给引擎，直接返回明确结果，
 * 避免模型靠重复读同一张图空转烧 token。 */
const READ_IMAGE_PER_TURN_LIMIT = 2;
const READ_IMAGE_TOTAL_LIMIT = 6;
const READ_IMAGE_TOTAL_TTL_MS = 24 * 60 * 60 * 1000;
const readImageTotals = new Map(); // chatId|path → { count, at }
const readImageSeenCalls = new Map(); // tool_call id → at，防止历史里的同一条被重复计数

function readImagePathOf(call) {
    if (call?.function?.name !== 'read_image')
        return '';
    let args = {};
    try { args = JSON.parse(String(call.function.arguments ?? '{}')); }
    catch { args = {}; }
    return String(args.path ?? args.file_path ?? args.file ?? args.image ?? '').trim();
}

/** 命中返回 { path, turn, total }；未命中返回 null。
 * turnStartHint 由调用方传入真实的最后一条用户消息下标（拼 prompt 后末尾会追加
 * systemTail 伪 user 消息，不能再用“最后一条 user”来划分回合）。 */
function readImageCapVerdict(messages, chatId, now = Date.now(), turnStartHint = -1) {
    if (!Array.isArray(messages))
        return null;
    let turnStart = turnStartHint;
    if (turnStart < 0) {
        turnStart = 0;
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (messages[i]?.role === 'user') {
                turnStart = i;
                break;
            }
        }
    }
    const turnCounts = new Map();
    for (let i = turnStart; i < messages.length; i += 1) {
        const calls = messages[i]?.tool_calls;
        if (!Array.isArray(calls))
            continue;
        for (const call of calls) {
            const path = readImagePathOf(call);
            if (path === '')
                continue;
            turnCounts.set(path, (turnCounts.get(path) ?? 0) + 1);
            const id = String(call?.id ?? '');
            if (id !== '' && readImageSeenCalls.has(id))
                continue;
            if (id !== '')
                readImageSeenCalls.set(id, now);
            const key = (chatId || '-') + '|' + path;
            const rec = readImageTotals.get(key);
            if (rec === undefined || now - rec.at > READ_IMAGE_TOTAL_TTL_MS)
                readImageTotals.set(key, { count: 1, at: now });
            else
                rec.count += 1;
        }
    }
    if (readImageSeenCalls.size > 5000) {
        for (const [id, at] of readImageSeenCalls) {
            if (now - at > READ_IMAGE_TOTAL_TTL_MS)
                readImageSeenCalls.delete(id);
        }
    }
    for (const [path, turn] of turnCounts) {
        const total = readImageTotals.get((chatId || '-') + '|' + path)?.count ?? turn;
        if (turn > READ_IMAGE_PER_TURN_LIMIT || total > READ_IMAGE_TOTAL_LIMIT)
            return { path, turn, total };
    }
    return null;
}
/* ------------------------------------------------------------------ */
/* 回合预算 / 重复调用闸门（第二道硬闸）：压住“工具结果回灌 → 续接请求”的自放大。 */
/* 14:40–14:50 只有 20 条入站（18 张图），proxy 却产生了约 950 个回合：图片 →     */
/* read_image 结果回灌 → 续接请求 → 再回灌。read_image 同 path 上限只压得住       */
/* “同一张图”，压不住“不同工具轮流回灌”。这里按单条入站消息给回合数封顶，        */
/* 并按 toolName + 关键参数 识别原地打转；命中就不再发上游，直接收尾。            */
/* 上限：gate-config.json 的 turnBudget / loopGuardLimit > 环境变量 > 默认值。    */
/* ------------------------------------------------------------------ */
const TURN_BUDGET_DEFAULT = 12;
const LOOP_GUARD_DEFAULT = 3;
/** 循环保护触发后宿主会立刻补一轮【重来】。那一轮不是用户的新消息，
 *  必须一起静默丢弃；否则它换个回合身份重新进上游，还可能开口说话。 */
const LOOP_FOLLOWUP_RE = /(?:^|\n)\s*(?:<user_message[^>]*>)?\s*【(?:重来|重说|重写)】/u;
const LOOP_FOLLOWUP_TTL_MS = 60 * 1000;
const loopDroppedChats = new Map(); // chatId → 触发循环保护的时间
const INBOUND_ROUND_TTL_MS = 30 * 60 * 1000;
/** 同一 inbound 消息已用回合数：取「历史里的 assistant 步数」与内存计数的较大值，
 * 宿主中途裁历史也不会把计数抹掉。 */
const inboundRounds = new Map(); // chatId|inboundId → { used, lastTool, at }

/** 配置项优先、环境变量次之；<= 0 表示关闭该闸。 */
function gateLimit(cfgValue, envValue, fallback) {
    for (const value of [cfgValue, envValue]) {
        if (value === undefined || value === null || value === '')
            continue;
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return Math.floor(parsed);
    }
    return fallback;
}
function turnBudgetLimit() {
    return gateLimit(gateConfig().turnBudget, process.env.QQ_TURN_BUDGET, TURN_BUDGET_DEFAULT);
}
function loopGuardLimit() {
    return gateLimit(gateConfig().loopGuardLimit, process.env.QQ_LOOP_GUARD_LIMIT, LOOP_GUARD_DEFAULT);
}

/** 入站消息 id：优先信封里的 messageId/msgId，其次 traceId；
 * 旧插件没有信封时退化成 (chatId + 正文) 哈希——同一条消息的续接请求哈希相同。 */
function inboundMessageId(kept, lastUserIndex, chatId) {
    if (!Array.isArray(kept) || lastUserIndex < 0 || lastUserIndex >= kept.length)
        return '';
    const text = messageText(kept[lastUserIndex]);
    const evt = decodeEnvelopeOf(text);
    if (evt !== null && typeof evt === 'object') {
        for (const key of ['messageId', 'msgId', 'message_id', 'traceId', 'trace_id', 'id']) {
            const value = evt[key];
            if (typeof value === 'string' && value !== '')
                return value;
            if (typeof value === 'number' && Number.isFinite(value))
                return String(value);
        }
    }
    const body = text.replace(/^【元】[^\n]*\n/u, '').trim();
    return 'h' + createHash('sha256').update((chatId || '-') + '|' + body.slice(0, 500)).digest('hex').slice(0, 12);
}

/** 关键参数：去掉每次都会变的调度字段，再做键排序的规范化 JSON。
 * 参数不是 JSON 对象时退回原始串前 200 字符。 */
const LOOP_ARG_VOLATILE = new Set(['timeout', 'timeoutMs', 'timeout_ms', 'nonce', 'traceId', 'trace_id',
    'requestId', 'request_id', 'ts', 'timestamp', 'now', 'delay', 'wait', 'retries', 'attempt']);
function loopCallKey(call) {
    const tool = String(call?.function?.name ?? '');
    const raw = String(call?.function?.arguments ?? '');
    let args;
    try {
        const parsed = JSON.parse(raw);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
            args = parsed;
    }
    catch {
        args = undefined;
    }
    let canonical = raw.slice(0, 200);
    if (args !== undefined) {
        const picked = {};
        for (const key of Object.keys(args).sort()) {
            if (LOOP_ARG_VOLATILE.has(key))
                continue;
            const value = args[key];
            if (value === undefined || value === null || value === '')
                continue;
            picked[key] = typeof value === 'string' ? value.slice(0, 200) : value;
        }
        if (Object.keys(picked).length > 0)
            canonical = JSON.stringify(picked);
    }
    return { tool, args: canonical, key: tool + '\u0000' + canonical };
}

/** 统计回合链（turnStart 之后）已经跑过的上游步数与工具调用重复情况。 */
function turnChainStats(messages, turnStart) {
    const counts = new Map();
    let rounds = 0;
    let lastTool = '';
    for (let index = Math.max(0, turnStart); index < messages.length; index += 1) {
        const message = messages[index];
        if (message?.role !== 'assistant')
            continue;
        rounds += 1;
        if (!Array.isArray(message.tool_calls))
            continue;
        for (const call of message.tool_calls) {
            if (typeof call?.function?.name !== 'string' || call.function.name === '')
                continue;
            lastTool = call.function.name;
            const { tool, args, key } = loopCallKey(call);
            const rec = counts.get(key);
            if (rec === undefined)
                counts.set(key, { tool, args, count: 1 });
            else
                rec.count += 1;
        }
    }
    return { rounds, lastTool, counts };
}

/** 同一 toolName + 关键参数 出现次数超过 limit 才算打转；未命中返回 null。 */
function loopGuardHit(stats, limit) {
    if (limit <= 0)
        return null;
    for (const rec of stats.counts.values()) {
        if (rec.count > limit)
            return rec;
    }
    return null;
}

/** 命中返回 { hits }（并自增计数）；未命中返回 null。 */
function noteTruncatedRepeat(key, now = Date.now()) {
    if (key === '')
        return null;
    for (const [k, v] of truncatedEmptySeen) {
        if (now - v.at > TRUNCATED_REPEAT_WINDOW_MS)
            truncatedEmptySeen.delete(k);
    }
    const prev = truncatedEmptySeen.get(key);
    if (prev === undefined)
        return null;
    prev.at = now;
    prev.hits += 1;
    return { hits: prev.hits };
}
function rememberTruncatedRepeat(key, now = Date.now()) {
    if (key === '')
        return;
    const prev = truncatedEmptySeen.get(key);
    if (prev !== undefined) {
        prev.at = now;
        prev.hits += 1;
        return;
    }
    if (truncatedEmptySeen.size >= 32) {
        const oldest = truncatedEmptySeen.keys().next().value;
        if (oldest !== undefined)
            truncatedEmptySeen.delete(oldest);
    }
    truncatedEmptySeen.set(key, { at: now, hits: 1 });
}
function clearTruncatedRepeat(key) {
    if (key !== '')
        truncatedEmptySeen.delete(key);
}

/** 输出被 max_tokens 砍断后的重生成：要求直接给结论，且不要任何工具标记。 */
function withTruncationHint(payload) {
    return {
        ...payload,
        messages: [...payload.messages, {
            role: 'system',
            content: '上一次输出被长度上限截断了。这次直接给最终结论，1-3 句，不要输出 <tool_call> 或任何尖括号标记，不要解释思考过程，也不要再调用工具。',
        }],
    };
}

/** 同一回合内重复检索拿到逐字相同的结果时，把后出现的 tool 结果压成终态提示：
 * 既省 token，也直接掐断“换个关键词再搜一遍”的循环。只动检索类工具。 */
const DUPLICATE_TOOL_NOTICE = '同一结果，别重复检索，基于现有信息回答。';
const DUPLICATE_LOOKUP_TOOLS = new Set(['web_search', 'qq_notebook', 'memory_search']);

function collapseDuplicateToolResults(messages) {
    if (!Array.isArray(messages) || messages.length === 0)
        return { messages, replaced: 0, turnTools: 0 };
    // 回合起点 = 最后一条真实入站 user（宿主脚手架不算）。
    let turnStart = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'user' && scaffoldKindOf(messages[index]) === '') {
            turnStart = index;
            break;
        }
    }
    if (turnStart < 0)
        return { messages, replaced: 0, turnTools: 0 };
    const nameById = new Map();
    const seen = new Set();
    let replaced = 0;
    let turnTools = 0;
    let seenReadImage = false;
    const collapsed = messages.map((message, index) => {
        if (index < turnStart || message === null || typeof message !== 'object')
            return message;
        if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
            for (const call of message.tool_calls) {
                const id = call?.id;
                const name = call?.function?.name;
                if (typeof id === 'string' && typeof name === 'string')
                    nameById.set(id, name);
            }
            return message;
        }
        if (message.role !== 'tool')
            return message;
        const name = nameById.get(message.tool_call_id ?? '');
        if (name === 'read_image') {
            // 同回合只留第一份读图结果：后面的重复读图直接给终态，模型不会再拿到新图。
            turnTools += 1;
            if (!seenReadImage) {
                seenReadImage = true;
                return message;
            }
            replaced += 1;
            return { ...message, content: READ_IMAGE_TOOL_DONE };
        }
        if (typeof name !== 'string' || !DUPLICATE_LOOKUP_TOOLS.has(name))
            return message;
        turnTools += 1;
        const key = name + '\u0000' + messageText(message);
        if (!seen.has(key)) {
            seen.add(key);
            return message;
        }
        replaced += 1;
        return { ...message, content: DUPLICATE_TOOL_NOTICE };
    });
    return { messages: collapsed, replaced, turnTools };
}

/* ------------------------------------------------------------------ */
/* 自迭代运行记录：这次谁触发、摘录多长、调了哪些工具、人格/记忆有没有变。 */
/* 只追加到 self-iter/runs.jsonl；写失败只记 warn，绝不影响回复主流程。      */
/* ------------------------------------------------------------------ */
const SELF_ITER_RUNS = new Map();
const SELF_ITER_RUN_TTL_MS = 6 * 3600_000;

/** 命中每日总结的回合：key 按“日期 + 摘录哈希”定位同一回合的多个 step；
 *  runId 在 start 时再加一段启动时刻，避免同一天多次触发共用同一个 id。 */
function selfIterTurnOf(kept, lastUserIndex) {
    if (!Array.isArray(kept) || lastUserIndex < 0)
        return undefined;
    const text = messageText(kept[lastUserIndex]);
    if (!text.includes('【每日群聊总结】'))
        return undefined;
    const now = new Date();
    const day = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
        + '-' + String(now.getDate()).padStart(2, '0');
    const digest = createHash('sha256').update(text.slice(0, 2000)).digest('hex');
    return {
        key: 'si-' + day + '-' + digest.slice(0, 8),
        promptHash: createHash('sha256').update(text).digest('hex').slice(0, 16),
        excerptChars: text.length,
    };
}

/** 人格与记忆的现状快照：只看文件，不调用 loadNotebook（它会消费撤回事件）。 */
async function selfIterSnapshot() {
    const [mtimeMs, notebookRaw, diaryRaw] = await Promise.all([
        stat(CHARACTER_PATH).then(info => info.mtimeMs).catch(() => 0),
        readFile(NOTEBOOK_PATH, 'utf8').catch(() => ''),
        readFile(DIARY_PATH, 'utf8').catch(() => ''),
    ]);
    let notebookCount = 0;
    try {
        const doc = JSON.parse(notebookRaw);
        if (Array.isArray(doc?.entries))
            notebookCount = doc.entries.length;
    }
    catch {
        // 解析失败就记 0：观测不能影响主流程
    }
    return {
        characterMtimeMs: Math.round(mtimeMs),
        notebookCount,
        diaryCount: diaryRaw.split('\n').filter(line => line.trim() !== '').length,
    };
}

function writeSelfIterLine(entry) {
    void mkdir(dirname(SELF_ITER_LOG_PATH), { recursive: true })
        .then(() => appendFile(SELF_ITER_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8'))
        .catch(error => fatalLog('warn: self-iter 运行记录写入失败: ' + (error?.message ?? String(error))));
}

async function selfIterBegin(turn, chatId) {
    if (SELF_ITER_RUNS.has(turn.key))
        return;
    for (const [key, run] of SELF_ITER_RUNS) {
        if (Date.now() - run.startedAt > SELF_ITER_RUN_TTL_MS)
            SELF_ITER_RUNS.delete(key);
    }
    const now = new Date();
    const clock = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0')
        + String(now.getSeconds()).padStart(2, '0');
    const run = { ...turn, runId: turn.key + '-' + clock, chatId, startedAt: Date.now(), step: 0, tools: [], before: undefined };
    SELF_ITER_RUNS.set(turn.key, run);
    run.before = await selfIterSnapshot();
    writeSelfIterLine({
        ts: new Date().toISOString(),
        runId: run.runId,
        phase: 'start',
        chatId: run.chatId,
        excerptChars: run.excerptChars,
        promptHash: run.promptHash,
        before: run.before,
    });
}

/** 每个上游回合记一行；没有 tool_calls 的那一步就是回合收尾，补 after/delta。 */
async function selfIterStep(key, toolNames, droppedCalls = 0) {
    const run = SELF_ITER_RUNS.get(key);
    if (run === undefined)
        return;
    run.step += 1;
    for (const name of toolNames) {
        if (!run.tools.includes(name))
            run.tools.push(name);
    }
    const base = {
        ts: new Date().toISOString(),
        runId: run.runId,
        step: run.step,
        chatId: run.chatId,
        toolsThisStep: toolNames,
        tools: [...run.tools],
    };
    if (droppedCalls > 0)
        base.droppedCalls = droppedCalls;
    if (toolNames.length > 0) {
        writeSelfIterLine({ ...base, phase: 'step' });
        return;
    }
    SELF_ITER_RUNS.delete(key);
    const after = await selfIterSnapshot();
    writeSelfIterLine({
        ...base,
        phase: 'end',
        final: true,
        durationMs: Date.now() - run.startedAt,
        before: run.before,
        after,
        delta: {
            characterChanged: after.characterMtimeMs !== run.before.characterMtimeMs,
            notebookCount: after.notebookCount - run.before.notebookCount,
            diaryCount: after.diaryCount - run.before.diaryCount,
        },
    });
}

/** 所有 QQ 请求都先走上游非流式：这样能在回复真正发给对方之前检查
 * “说要画但没调用”和“说画好了但没调用”，再补一个 qq_draw。 */
async function forwardQQReply(req, res, body, kept, lastUserIndex, forced, drawActivityAfterUser, hideReviewTalk, imageContext, engineSession, qqContext = {}) {
    const startedAt = Date.now();
    // 每日总结是现存的“自迭代”入口，但以前只有 prompt 进模型、没有任何运行痕迹。
    // 这里只做旁路观测（append-only），不改变回复行为、不碰人格与记忆。
    const selfIter = selfIterTurnOf(kept, lastUserIndex);
    if (selfIter !== undefined)
        void selfIterBegin(selfIter, String(qqContext.chatId ?? ''));
    const payload = scrubBody({ ...body, stream: false });
    delete payload.stream_options;
    // 上一轮真正发出去的回复。兜底句和复读判定都要避开它：这条内容会
    // 写进 Harness 的会话历史，下一轮模型会把它当成“我上一条”照抄。
    const previousReply = previousAssistantText(kept, lastUserIndex);
    // read_image 重复读取闸门：同一张图读到第 3 次就不再发上游，直接给一条明确结果。
    const capHit = readImageCapVerdict(kept, String(qqContext.chatId ?? ''), Date.now(), lastUserIndex);
    // 第二道闸：单条入站消息的回合预算 + 同 toolName/关键参数 原地打转。
    // 只在能定位到入站消息时计（chainStart = 本轮入站 user 消息下标，跳过宿主脚手架）。
    const gateChatId = String(qqContext.chatId ?? '');
    // 跳过宿主中途插入的脚手架 user 行（「Time sampled while preparing turn…」等），
    // 否则续接回合会被当成新一轮、回合预算永远从 0 重计。
    let chainStart = lastRealUserIndex(kept);
    if (chainStart < 0)
        chainStart = lastUserIndex;
    const inboundId = inboundMessageId(kept, chainStart, gateChatId);
    const chain = chainStart >= 0
        ? turnChainStats(kept, chainStart)
        : { rounds: 0, lastTool: '', counts: new Map() };
    // 上一轮被循环保护静默丢弃后，宿主补发的【重来】不是用户的新消息：
    // 同一 chat 60 秒内遇到就继续丢弃，别让它换个回合身份重新进上游。
    const loopDropKey = gateChatId || '-';
    const loopDroppedAt = loopDroppedChats.get(loopDropKey);
    if (loopDroppedAt !== undefined) {
        if (Date.now() - loopDroppedAt <= LOOP_FOLLOWUP_TTL_MS
            && chainStart >= 0 && LOOP_FOLLOWUP_RE.test(messageText(kept[chainStart]))) {
            logLine('loop-guard followup blocked: chat=' + loopDropKey + ' inbound=' + inboundId
                + ' (循环保护后的宿主重来回合，未发上游；静默丢弃)');
            appendTurnAudit('loop-guard-followup', { chat: gateChatId || '', inbound: inboundId });
            loopDroppedChats.delete(loopDropKey);
            sendSilence(res, body, qqContext.source ?? 'qq', 'loop_guard_followup', 'host retry after loop guard; message dropped');
            return;
        }
        // 真实的新消息：上一轮的循环保护到此结束。
        loopDroppedChats.delete(loopDropKey);
    }
    const roundKey = (gateChatId || '-') + '|' + inboundId;
    const gateNow = Date.now();
    const prevRound = inboundRounds.get(roundKey);
    let usedRounds = chain.rounds;
    if (prevRound !== undefined && gateNow - prevRound.at <= INBOUND_ROUND_TTL_MS)
        usedRounds = Math.max(usedRounds, prevRound.used);
    const lastTool = chain.lastTool !== '' ? chain.lastTool : (prevRound?.lastTool ?? '');
    const budgetLimit = turnBudgetLimit();
    const budgetHit = inboundId !== '' && budgetLimit > 0 && usedRounds >= budgetLimit
        ? { used: usedRounds, lastTool: lastTool || '-' }
        : null;
    const loopLimit = loopGuardLimit();
    const loopHit = budgetHit === null && inboundId !== ''
        ? loopGuardHit(chain, loopLimit)
        : null;
    if (inboundId !== '') {
        inboundRounds.set(roundKey, {
            used: budgetHit !== null ? budgetHit.used : usedRounds + 1,
            lastTool,
            at: gateNow,
        });
        if (inboundRounds.size > 500) {
            for (const [key, rec] of inboundRounds) {
                if (gateNow - rec.at > INBOUND_ROUND_TTL_MS)
                    inboundRounds.delete(key);
            }
        }
    }
    let response;
    const upstreamStarted = Date.now();
    try {
        if (budgetHit !== null) {
            logLine('turn-budget blocked: chat=' + (gateChatId || '-')
                + ' inbound=' + inboundId
                + ' rounds=' + budgetHit.used
                + ' lastTool=' + budgetHit.lastTool
                + ' budget=' + budgetLimit
                + ' (本条入站消息的续接回合已到上限，未发上游；本条静默丢弃)');
            appendTurnAudit('turn-budget', {
                chat: gateChatId || '',
                inbound: inboundId,
                rounds: budgetHit.used,
                lastTool: budgetHit.lastTool,
                budget: budgetLimit,
            });
            sendSilence(res, body, qqContext.source ?? 'qq', 'turn_budget', 'turn budget reached; message dropped');
            return;
        }
        else if (loopHit !== null) {
            logLine('loop-guard blocked: chat=' + (gateChatId || '-')
                + ' inbound=' + inboundId
                + ' tool=' + loopHit.tool
                + ' args=' + loopHit.args.slice(0, 120)
                + ' count=' + loopHit.count + ' limit=' + loopLimit
                + ' rounds=' + usedRounds
                + ' (同一工具调用原地重复，未发上游；本条静默丢弃)');
            appendTurnAudit('loop-guard', {
                chat: gateChatId || '',
                inbound: inboundId,
                tool: loopHit.tool,
                args: loopHit.args.slice(0, 120),
                count: loopHit.count,
                limit: loopLimit,
                rounds: usedRounds,
            });
            loopDroppedChats.set(gateChatId || '-', Date.now());
            sendSilence(res, body, qqContext.source ?? 'qq', 'loop_guard', 'same tool call repeated; message dropped');
            return;
        }
        else if (capHit !== null) {
            logLine('read_image cap blocked: chat=' + (qqContext.chatId || '-')
                + ' path=' + capHit.path + ' turn=' + capHit.turn + ' total=' + capHit.total
                + ' (同一张图重复读取，未发上游；本条静默丢弃)');
            appendTurnAudit('read-image-cap', {
                chat: String(qqContext.chatId ?? ''),
                path: capHit.path,
                turn: capHit.turn,
                total: capHit.total,
            });
            sendSilence(res, body, qqContext.source ?? 'qq', 'read_image_cap', 'same image read repeatedly; message dropped');
            return;
        }
        else {
            // 429 走“等池子 + 缩短上下文”的重试：依次砍到 70% / 45% / 30%，
            // 每次都比上一次小，绝不把原请求原样重发。
            response = await postUpstreamJson(payload, LLM.requestTimeoutMs, engineSession, {
                poolShrink: attempt => shrinkPayloadForPool(payload, attempt === 0 ? 0.7 : (attempt === 1 ? 0.45 : 0.3)),
            });
            // 只读时延拆分：queue=proxy 内拼 prompt 到发上游，upstream=等引擎整段返回。
            logLine('qq reply timing: queue=' + (upstreamStarted - startedAt)
                + 'ms upstream=' + (Date.now() - upstreamStarted)
                + 'ms total=' + (Date.now() - startedAt) + 'ms');
        }
    }
    catch (error) {
        logLine('qq reply upstream error: ' + (error instanceof Error ? error.message : String(error)));
        // 池子打满时，缩短上下文重试过三轮还不行，就不再重发：只带人设 +
        // 最后一条消息换一次极短回答；连这个也失败才回兜底句。
        if (isPoolExhausted(error)) {
            const shortPayload = minimalPayload(payload);
            logLine('pool exhausted: trying short-context reply, dropped='
                + Math.max(0, (payload.messages?.length ?? 0) - shortPayload.messages.length)
                + ' windowDropped=0');
            const short = await postUpstreamJson(shortPayload, LLM.requestTimeoutMs, engineSession)
                .catch(shortError => {
                    logLine('short-context reply failed: '
                        + (shortError instanceof Error ? shortError.message : String(shortError)).slice(0, 160));
                    return undefined;
                });
            if (normalizeReply(short?.choices?.[0]?.message?.content ?? '') !== '') {
                response = short;
                logLine('short-context reply ok');
            }
        }
        if (response !== undefined) {
            // 短上下文拿到了回答，继续走正常出站流程。
        }
        else {
            // 上游内部 5xx 先有限次、带退避地静默重试；重试仍失败就这轮不出话。
            // 原则：内部故障不对外说话。nextFallbackLine 只留给真正需要说话的场景，
            // 不再挂在引擎故障路径上。
            if (isUpstreamServerError(error)) {
                const statusMatch = /upstream status (5\d\d)/i.exec(error instanceof Error ? error.message : String(error));
                recordUpstreamFault('5xx', { status: statusMatch ? Number(statusMatch[1]) : 0 });
                // 共享前缀污染：先做一次"去前缀"重试——system 首行插唯一标记，
                // 绕开引擎里已存在的那条前缀目录项。正常路径零变化，只有这条失败的
                // 路径多一次全量 prefill（实测 8.6k prompt 约 +2.8–3.7s）。
                if (isSharedPrefixBoundError(error)) {
                    const nonce = (typeof qqContext.traceId === 'string' && qqContext.traceId !== '')
                        ? qqContext.traceId
                        : ('r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
                    const shifted = withFreshPrefixMarker(payload, nonce);
                    const shiftedStart = Date.now();
                    const retried = await postUpstreamJson(shifted, LLM.requestTimeoutMs, engineSession)
                        .catch(shiftError => {
                            logLine('prefix-shift retry failed: nonce=' + nonce + ' '
                                + (shiftError instanceof Error ? shiftError.message : String(shiftError)).slice(0, 160));
                            return undefined;
                        });
                    if (retried !== undefined) {
                        response = retried;
                        logLine('prefix-shift retry ok: nonce=' + nonce + ' ms=' + (Date.now() - shiftedStart));
                        recordUpstreamFault('prefix_shift_ok', { nonce, ms: Date.now() - shiftedStart });
                    }
                    else {
                        recordUpstreamFault('prefix_shift_failed', { nonce, ms: Date.now() - shiftedStart });
                    }
                }
                for (let attempt = 1; response === undefined && attempt <= UPSTREAM_SILENT_RETRIES; attempt += 1) {
                    await sleep(UPSTREAM_SILENT_BACKOFF_MS * attempt);
                    const retried = await postUpstreamJson(payload, LLM.requestTimeoutMs, engineSession)
                        .catch(retryError => {
                            logLine('silent retry ' + attempt + '/' + UPSTREAM_SILENT_RETRIES + ' failed: '
                                + (retryError instanceof Error ? retryError.message : String(retryError)).slice(0, 160));
                            return undefined;
                        });
                    if (retried !== undefined) {
                        response = retried;
                        logLine('silent retry ' + attempt + '/' + UPSTREAM_SILENT_RETRIES + ' ok');
                        recordUpstreamFault('retry_ok', { attempt });
                        break;
                    }
                }
            }
            if (response === undefined) {
                // 不再把上游 429/超时的原始 JSON 丢给聊天窗口；但也绝不再回
                // 200 + 空 assistant——宿主会把它当成“完成但没内容”。
                const failureDetail = (error instanceof Error ? error.message : String(error)).slice(0, 200);
                if (isRetryableUpstream(error)) {
                    // 平台不再替模型说“我卡了一下”：QQ 侧保持沉默，只记原因，不写历史。
                    logLine('QQ silence: upstream retryable failure, platform will not speak');
                    recordUpstreamFault('upstream_error', { retryable: true });
                    sendSilence(res, body, qqContext.source ?? 'qq', 'upstream_retryable', failureDetail);
                }
                else {
                    logLine('qq reply upstream failure: returning 502, no empty completion');
                    recordUpstreamFault('upstream_error', { retryable: false });
                    sendUpstreamFailure(res, 502, failureDetail);
                }
                return;
            }
        }
    }
    const choice = response?.choices?.[0];
    const message = choice?.message;
    if (message === undefined || typeof message !== 'object') {
        logLine('qq reply upstream failure: response without message -> 502');
        sendUpstreamFailure(res, 502, 'upstream response has no message');
        return;
    }
    const rawContent = typeof message.content === 'string' ? message.content : '';
    // 模型偶尔把注入的上下文整段复读回来；出站前剪掉，绝不让它进 QQ。
    const echo = classifyEcho(rawContent);
    let content = echo.text;
    const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : '';
    // 输出被 max_tokens 砍断（finish_reason=length）且没有可用正文时，不能让
    // `<tool_call>` 这类残片冒充回复、更不能送进下面的复读判定被静默掉：
    // 先记一条明确的截断日志，再带约束重生成一次；重试仍被砍就沉默但留日志。
    if (finishReason === 'length' && isToolMarkupOnly(content)) {
        const promptTokensNow = (body.messages ?? [])
            .reduce((total, item) => total + estimateMessageTokens(item), 0);
        const truncatedChars = content.length;
        const repeatKey = truncatedRepeatKey(qqContext.chatId, content);
        const repeat = noteTruncatedRepeat(repeatKey);
        logLine('QQ reply truncated at max_tokens: chat=' + (qqContext.chatId || '-')
            + ' trace=' + (qqContext.traceId || '-')
            + ' tokens=' + promptTokensNow + '+' + String(body.max_tokens ?? '-')
            + ' finish=length chars=' + truncatedChars
            + ' repeatHits=' + String(repeat?.hits ?? 0));
        if (repeat !== null) {
            // 同一段残片在窗口内又出现：重试只会得到同一个 1-token 结果。
            content = '';
            message.content = '';
            logLine('QQ reply truncated repeat-empty: skipping retry hits=' + repeat.hits
                + ' chars=' + truncatedChars);
            const source = qqContext.source ?? 'qq';
            if (repeat.hits >= 3) {
                logLine('QQ reply truncated repeat-empty: staying silent hits=' + repeat.hits);
                sendSilence(res, body, source, 'reply_truncated_repeat', 'reply stayed empty after repeated truncation');
                return;
            }
            // 截断复读不再补“短句”：平台不代答，沉默并把原因记进日志。
            logLine('QQ silence: truncated repeat fallback disabled (platform will not speak) hits=' + repeat.hits);
            sendSilence(res, body, source, 'reply_truncated_repeat', 'reply stayed empty after repeated truncation');
            return;
        }
        const retried = await postUpstreamJson(withTruncationHint(payload), LLM.requestTimeoutMs, engineSession)
            .catch(() => undefined);
        const retryChoice = retried?.choices?.[0];
        const retryText = stripPromptEcho(typeof retryChoice?.message?.content === 'string' ? retryChoice.message.content : '');
        const retryFinish = typeof retryChoice?.finish_reason === 'string' ? retryChoice.finish_reason : '';
        if (!isEffectivelyEmpty(retryText) && retryFinish !== 'length' && !isToolMarkupOnly(retryText)) {
            content = retryText;
            clearTruncatedRepeat(repeatKey);
            logLine('QQ reply truncation retry recovered: ' + retryText.slice(0, 80));
        }
        else {
            content = '';
            message.content = '';
            rememberTruncatedRepeat(repeatKey);
            logLine('QQ reply truncated retry empty: staying silent finish=' + (retryFinish || '-')
                + ' chars=' + retryText.length);
            sendSilence(res, body, qqContext.source ?? 'qq', 'reply_truncated_empty', 'reply stayed empty after truncation retry');
            return;
        }
    }
    else if (content !== '' && isToolMarkupOnly(content)) {
        // finish_reason 正常但正文只剩 tool_call 标记：同样是坏输出，绝不发给 QQ，
        // 也不进复读判定（否则会被判成 repeat → 重试 → 沉默，用户侧完全无声）。
        logLine('QQ reply tool-call markup dropped: finish=' + (finishReason || '-')
            + ' raw=' + JSON.stringify(content.slice(0, 60)));
        content = '';
    }
    else if (echo.kind === 'silent') {
        // 人格设定允许「只输出【内心】= 这轮选择不说话」。以前这里伪造一句
        // 「刚走神了」，于是每条没让它接的群消息都变成同一句道歉。空串交给
        // outbound：静默 / 重试 / 次数上限由它已有的 emptyReplyCount 逻辑处理。
        logLine('echo only-inner: staying silent');
    }
    else if (echo.kind === 'echo-only') {
        // 纯结构标记回声属于真故障：带约束重生成一次。
        logLine('prompt echo stripped: (empty) raw=' + JSON.stringify(rawContent.slice(0, 200)));
        const retried = await postUpstreamJson(withNoMarkerHint(payload), LLM.requestTimeoutMs, engineSession).catch(() => undefined);
        const retryText = stripPromptEcho(retried?.choices?.[0]?.message?.content ?? '');
        if (!isEffectivelyEmpty(retryText)) {
            content = retryText;
            logLine('echo retry recovered: ' + retryText.slice(0, 80));
        }
        else {
            // 不能再把兜底句写进 assistant 消息：它会被 Harness 存进会话，
            // 下一轮模型看到“自己上一条”就是这句话，于是原样照抄，长对话里
            // 越滚越固定（实测同一群里连续十几轮都是同一句）。空串交给插件
            // outbound 的空回复逻辑（重说一次 / 中性兜底）。
            content = '';
            logLine('echo retry empty: staying silent (no canned fallback into history)');
        }
    }
    else if (echo.kind === 'text' && content !== rawContent) {
        logLine('prompt echo stripped: ' + content.slice(0, 80));
    }
    // 通用约束：本步真正下发给模型的工具集合是唯一白名单。
    // 9B 会凭历史记忆声明任何它记得的工具名（2026-11-13 00:25 连画 3 张就是这么来的），
    // 代理不校验就转发，宿主会照单执行。这里对所有 tool_calls 逐条校验，不给单个工具做特例，
    // 这样闸门隐藏（qq_draw / qq_at / read_image）、媒体回合撤工具、终态撤工具都能覆盖。
    const offeredTools = new Set(Array.isArray(payload.tools)
        ? payload.tools
            .map(tool => tool?.function?.name)
            .filter(name => typeof name === 'string' && name !== '')
        : []);
    let droppedCallCount = 0;
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        const keptCalls = [];
        for (const call of message.tool_calls) {
            const name = call?.function?.name;
            // 宿主工具拒绝规则（硬拒 + 群聊条件拒）：命中的 call 不交给宿主执行。
            // 放在 offered 判定之前，模型硬编造被撤下的工具名也会留下这条审计。
            const denied = denyHostTool(name, qqContext);
            if (denied !== null) {
                droppedCallCount += 1;
                if (QQ_HOST_TOOL_PRIVATE_ONLY.has(name))
                    logLine(name + ' denied: group chat ' + (qqContext.chatId || '-'));
                else
                    logLine(name + ' denied: ' + denied + ' chat=' + (qqContext.chatId || '-')
                        + ' kind=' + chatKindOf(qqContext));
                continue;
            }
            if (name === ASK_MASTER_TOOL) {
                let args = {};
                try { args = JSON.parse(String(call?.function?.arguments ?? '{}')); }
                catch { args = {}; }
                const verdict = evaluateAsk({ args, ctx: qqContext, now: Date.now() });
                droppedCallCount += 1;
                if (!verdict.ok) {
                    logLine('qq_ask_master denied: ' + verdict.reason
                        + (verdict.detail === '' ? '' : ' (' + verdict.detail + ')')
                        + ' chat=' + (qqContext.chatId || '-') + ' topic=' + verdict.topicKey);
                    continue;
                }
                if (verdict.reuse) {
                    logLine('qq_ask_master reused: ' + verdict.id + ' chat=' + (qqContext.chatId || '-'));
                    continue;
                }
                logLine('qq_ask_master queued: ' + verdict.id + ' chat=' + (qqContext.chatId || '-')
                    + ' topic=' + verdict.topicKey);
                // 空正文时补一句人话。content 一起改，否则下面的「全丢重答」分支
                // 会把这句话当成故障再问模型一次，可能换成系统腔。
                if (!message.content) {
                    content = '我去问问主人，回头告诉你。';
                    message.content = content;
                }
                continue;
            }
            if (typeof name === 'string' && offeredTools.has(name)) {
                // 私聊放行也留一行，方便事后核对是否被滥用。
                if (QQ_HOST_TOOL_PRIVATE_ONLY.has(name))
                    logLine(name + ' allowed: private chat ' + (qqContext.chatId || '-'));
                // 工作区围栏：路径参数越界的调用不交给宿主执行（丢 call 即不执行）。
                const path = workspaceViolation(call);
                if (path !== null) {
                    droppedCallCount += 1;
                    logLine('workspace guard: dropped ' + name + ' path=' + path
                        + ' root=' + WORKSPACE_ROOT + ' chat=' + (qqContext.chatId || '-'));
                    continue;
                }
                keptCalls.push(call);
                continue;
            }
            droppedCallCount += 1;
            logLine('tool call dropped: ' + String(name ?? '<no-name>') + ' (not offered this step) offered='
                + offeredTools.size);
        }
        if (droppedCallCount > 0) {
            if (keptCalls.length > 0)
                message.tool_calls = keptCalls;
            else
                delete message.tool_calls;
        }
    }
    const hasAnyTool = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
    // 校验之后才是真正会被宿主执行的那批工具；没有工具调用 = 这一轮以文本（或沉默）收尾。
    if (selfIter !== undefined) {
        const surviving = Array.isArray(message.tool_calls)
            ? [...new Set(message.tool_calls
                .map(call => String(call?.function?.name ?? ''))
                .filter(name => name !== ''))]
            : [];
        void selfIterStep(selfIter.key, surviving, droppedCallCount);
    }
    // 调用全被丢弃、正文又是空的：不能把空回合发出去，撤工具重答一次。
    if (content === '' && !hasAnyTool && droppedCallCount > 0 && echo.kind !== 'silent') {
        const recovered = await postUpstreamJson(withNoToolsHint(payload), LLM.requestTimeoutMs, engineSession)
            .catch(() => undefined);
        const recoveredText = stripPromptEcho(recovered?.choices?.[0]?.message?.content ?? '');
        if (recoveredText !== '' && !isToolMarkupOnly(recoveredText)) {
            content = recoveredText;
            message.content = recoveredText;
            logLine('QQ recovery: dropped tool calls answered: ' + recoveredText.slice(0, 80));
        }
        else {
            logLine('QQ recovery: dropped tool calls still empty after retry');
        }
    }
    // 带图/表情包/转发的回合，模型有时直接空输出（一个 token 都没有），
    // 用户侧就是彻底没回应。这里给一次明确的补答机会：撤工具 + 必须一句话。
    // 【内心】里的“这轮不说话”是人格选择，不能覆盖。
    if (content === '' && !hasAnyTool && echo.kind !== 'silent'
        && (isMediaTurn(body.messages) || hasReadImageToolResult(body.messages))) {
        const mediaRetried = await postUpstreamJson(withMediaForceHint(payload), LLM.requestTimeoutMs, engineSession)
            .catch(() => undefined);
        const mediaRetryText = stripPromptEcho(mediaRetried?.choices?.[0]?.message?.content ?? '');
        if (mediaRetryText !== '' && !isToolMarkupOnly(mediaRetryText)) {
            content = mediaRetryText;
            message.content = mediaRetryText;
            logLine('QQ recovery: empty media turn recovered: ' + mediaRetryText.slice(0, 80));
        }
        else {
            logLine('QQ recovery: empty media turn still empty after force retry');
        }
    }
    // 硬拦截：模型仍然发出 web_search / web_fetch 调用时，直接回终态文本，
    // 不把 tool call 交给宿主执行（宿主的 dsh-tool-web 会走 DeepSeek 云端计费）。
    if (hasAnyTool) {
        const blockedCalls = message.tool_calls
            .filter(call => BLOCKED_WEB_TOOLS.has(call?.function?.name));
        if (blockedCalls.length > 0) {
            logLine('QQ silence: blocked web tool call, platform will not speak chat='
                + (qqContext.chatId || '-') + ' trace=' + (qqContext.traceId || '-'));
            sendSilence(res, body, qqContext.source ?? 'qq', 'blocked_web_tool', 'web tools are not available on this link');
            return;
        }
    }
    // 长对话复读：模型把历史里自己上一句原样再发一遍。命中就重生成一次，
    // 仍相同则这轮沉默，避免同一句话继续被写进历史、自我强化。
    if (!hasAnyTool && content !== '' && !isToolMarkupOnly(content)
        && normalizeReply(content) === normalizeReply(previousReply)) {
        logLine('repeat reply suppressed: ' + cleanEnvelope(content).slice(0, 60));
        const retried = await postUpstreamJson(withNoRepeatHint(payload, previousReply), LLM.requestTimeoutMs, engineSession)
            .catch(() => undefined);
        const retryText = stripPromptEcho(retried?.choices?.[0]?.message?.content ?? '');
        content = (!isEffectivelyEmpty(retryText) && normalizeReply(retryText) !== normalizeReply(previousReply)) ? retryText : '';
        if (content === '')
            logLine('repeat retry empty: staying silent');
    }
    if (content !== rawContent)
        message.content = content;
    // 反向校验：本轮没有对应调用却声称做过（画了/发了/查了）时只记审计。
    auditClaimWithoutCall(content, message.tool_calls);
    // “说要画”只在 qq_draw 真正下发过时才补调用：否则就是把模型的空话变成一次真实出图。
    const drawExpected = !hasAnyTool && !drawActivityAfterUser
        && (forced || (offeredTools.has('qq_draw') && claimsDraw(content)));
    if (drawExpected) {
        // 兜底一：带着 qq_draw 重试一次，逼模型自己发 tool call（08:47 那轮
        // 工具被误撤后只回了一句「行，我画给你」，图根本没生成）。
        const drawTool = Array.isArray(payload.tools)
            ? payload.tools.find(tool => tool?.function?.name === 'qq_draw')
            : undefined;
        if (drawTool !== undefined) {
            const retried = await postUpstreamJson({
                ...payload,
                tools: [drawTool],
                tool_choice: 'required',
                messages: [...payload.messages, {
                    role: 'system',
                    content: '## 现在就画\n对方明确要图：这一步必须调用 qq_draw 生成图片，把画面写进 prompt。'
                        + '不要只回“正在画/好的/马上”，也不要用文字代替图片。',
                }],
            }, LLM.requestTimeoutMs, engineSession).catch(() => undefined);
            const retryCall = Array.isArray(retried?.choices?.[0]?.message?.tool_calls)
                ? retried.choices[0].message.tool_calls.find(call => call?.function?.name === 'qq_draw')
                : undefined;
            let retryArgs;
            try {
                retryArgs = retryCall === undefined ? undefined : JSON.parse(String(retryCall.function.arguments ?? '{}'));
            }
            catch {
                retryArgs = undefined;
            }
            if (retryArgs && typeof retryArgs === 'object'
                && typeof retryArgs.prompt === 'string' && retryArgs.prompt.trim() !== '') {
                applyDrawOptions(retryArgs, kept);
                logLine('draw retry ok: qq_draw tool_call prompt=' + retryArgs.prompt.slice(0, 100));
                sendDrawToolCall(res, body, retryArgs);
                return;
            }
            logLine('draw retry: no usable qq_draw call, falling back to prompt synthesis');
        }
        // 兜底二：模型还是不肯发 tool call，单独把画面翻成提示词再合成。
        const args = await composeDrawArgs(kept, lastUserIndex, content);
        if (args !== undefined) {
            applyDrawOptions(args, kept);
            logLine((forced ? 'forced' : 'auto') + ' draw synthesized tool_call prompt='
                + String(args.prompt).slice(0, 100) + ' style=' + String(args.style ?? '-'));
            sendDrawToolCall(res, body, args);
            return;
        }
        logLine('QQ silence: draw synth failed, platform will not speak prompt=' + cleanEnvelope(content).slice(0, 80));
        sendSilence(res, body, qqContext.source ?? 'qq', 'draw_synth_failed', 'draw arguments could not be composed');
        return;
    }
    // 反方向：没人明确要图，却主动承诺「我给你画」→ 删掉承诺句再发，删空则沉默。
    // 明确否定（不画/懒得画/画不了）claimsDraw 返回 false，原样保留。
    if (!hasAnyTool && !drawActivityAfterUser && !forced && !offeredTools.has('qq_draw')
        && claimsDraw(content)) {
        const stripped = stripDrawPromises(content);
        if (stripped !== content) {
            logLine('draw promise stripped (no explicit request): ' + cleanEnvelope(content).slice(0, 80));
            content = stripped;
            message.content = stripped;
            if (content === '') {
                logLine('QQ silence: draw promise only, platform will not speak');
                sendSilence(res, body, qqContext.source ?? 'qq', 'draw_promise_only', 'reply was a draw promise without a request');
                return;
            }
        }
    }
    if (hideReviewTalk && typeof message.content === 'string') {
        // 剥完只剩审核话术时不再补“嗯。/画好啦”——平台不代答，直接沉默。
        const cleaned = stripReviewTalk(message.content, '', imageContext);
        if (cleaned !== message.content) {
            logLine('review talk stripped: ' + cleanEnvelope(content).slice(0, 80));
            if (cleaned === '') {
                content = '';
                message.content = '';
                logLine('QQ silence: reply was review talk only, platform will not speak');
                sendSilence(res, body, qqContext.source ?? 'qq', 'review_talk_only', 'reply contained only review talk');
                return;
            }
            message.content = cleaned;
        }
    }
    sendAssistantMessage(res, body, sanitizeDrawCalls(message, kept), choice?.finish_reason);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > 32 * 1024 * 1024) {
                reject(new Error('request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

async function comfyUp() {
    try {
        const response = await fetch(COMFY_URL + '/system_stats', { signal: AbortSignal.timeout(2_000) });
        return response.ok;
    }
    catch {
        return false;
    }
}

let comfyStartPromise;

/** qq_draw 在 DSH 的 workspace-write 沙箱里执行；它 spawn 出来的 ComfyUI
 * 会继承沙箱限制，读不到 F:\ 的模型、写不了 E:\ComfyUI\output（表现为
 * read_file_slice failed / Permission denied）。所以由沙箱外的 proxy 负责
 * 拉起 ComfyUI，工具侧只通过 HTTP 请求。 */
async function ensureComfy() {
    if (await comfyUp())
        return { ok: true, started: false };
    if (comfyStartPromise !== undefined)
        return comfyStartPromise;
    comfyStartPromise = (async () => {
        try {
            logLine('comfy: starting python directly');
            // 不再套一层 PowerShell：Start-Process 在无控制台的父进程下会「成功退出
            // 但什么也没起」（实测 exit code 0、日志不更新、8188 始终不监听）。
            // 这里直接拉 python，stdout/stderr 落到同一对日志。
            const outFd = openSync(join(ROOT, 'comfyui.out.log'), 'a');
            const errFd = openSync(join(ROOT, 'comfyui.err.log'), 'a');
            const child = spawn(COMFY_PYTHON, ['-u', 'main.py', '--port', '8188', '--listen', '127.0.0.1', '--disable-auto-launch'], {
                cwd: COMFY_CWD,
                detached: true,
                stdio: ['ignore', outFd, errFd],
                windowsHide: true,
            });
            child.on('error', error => logLine('comfy: spawn failed ' + (error instanceof Error ? error.message : String(error))));
            child.on('exit', code => logLine('comfy: python exited code=' + String(code)));
            child.unref();
            logLine('comfy: python pid=' + String(child.pid ?? '-'));
            const deadline = Date.now() + 90_000;
            while (Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 2_000));
                if (await comfyUp()) {
                    logLine('comfy: ready');
                    return { ok: true, started: true };
                }
            }
            logLine('comfy: start timeout');
            return { ok: false, started: true, error: 'ComfyUI 启动超时（90s）' };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logLine('comfy: start failed ' + message);
            return { ok: false, started: false, error: message };
        }
        finally {
            comfyStartPromise = undefined;
        }
    })();
    return comfyStartPromise;
}

/* ComfyUI 常驻后的显存回收：正常出图结束时 moss-gen 自己会调 /free，
 * 这里只兜「进程还在、但模型因为回合崩溃/中断留在显存里」的情况。
 * 每 5 分钟看一次：队列空、且确有模型驻留（torch 占用 > 1GB）才动手，
 * 没有模型时完全不发请求。5 分钟的理由：正常路径已经即时释放，这里只是
 * 异常兜底；再短会和「同一轮连画两三张」的间隔打架，再长则引擎重载时
 * 白白被占着 ~9GB。 */
const COMFY_IDLE_FREE_MS = Number(process.env.QQ_COMFY_IDLE_FREE_MS ?? 5 * 60_000);
async function freeComfyIfIdle() {
    try {
        const stats = await (await fetch(COMFY_URL + '/system_stats', { signal: AbortSignal.timeout(3_000) })).json();
        const device = Array.isArray(stats?.devices) ? stats.devices[0] : undefined;
        const resident = Math.max(0, Number(device?.torch_vram_total ?? 0) - Number(device?.torch_vram_free ?? 0));
        if (resident < 1024 * 1024 * 1024)
            return;
        const queue = await (await fetch(COMFY_URL + '/queue', { signal: AbortSignal.timeout(3_000) })).json();
        const busy = (queue?.queue_running?.length ?? 0) + (queue?.queue_pending?.length ?? 0);
        if (busy > 0)
            return;
        const response = await fetch(COMFY_URL + '/free', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ unload_models: true, free_memory: true }),
            signal: AbortSignal.timeout(10_000),
        });
        logLine('comfy idle free: model VRAM ' + Math.round(resident / 1048576) + 'MB, status=' + response.status);
    }
    catch {
        // ComfyUI 没在跑就跳过，等下一轮
    }
}
/* ------------------------------------------------------------------ */
/* 进程内单调度器：所有周期性任务只在这里注册                             */
/* ------------------------------------------------------------------ */

const HEARTBEAT_PATH = join(ROOT, 'proxy-heartbeat.json');
const scheduler = createScheduler({
    statePath: join(ROOT, 'scheduler-state.json'),
    tickMs: Number(process.env.QQ_SCHED_TICK_MS ?? 30_000),
    log: (level, message) => fatalLog('sched ' + level + ': ' + message),
});

function writeHeartbeatFile() {
    const payload = {
        at: new Date().toISOString(),
        pid: process.pid,
        port: LISTEN_PORT,
        uptimeSec: Math.round(process.uptime()),
        scheduler: scheduler.snapshot(),
    };
    const tmp = HEARTBEAT_PATH + '.tmp-' + process.pid;
    try {
        writeFileSync(tmp, JSON.stringify(payload));
        renameSync(tmp, HEARTBEAT_PATH);
    }
    catch (error) {
        fatalLog('warn: heartbeat 落盘失败: ' + (error?.message ?? String(error)));
    }
}

const healthState = { engine: null, comfy: null };

async function probeUrl(url) {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(4_000) });
        return response.ok === true;
    }
    catch {
        return false;
    }
}

/** 健康探针：只在状态翻转时写一行，避免日志刷屏。 */
async function probeHealth() {
    const engineUrl = LLM.baseUrl.replace(/\/+$/, '') + '/models';
    const engineOk = await probeUrl(engineUrl);
    if (engineOk !== healthState.engine) {
        fatalLog('health: 引擎 ' + (engineOk ? '就绪' : '不可达') + ' ' + engineUrl);
        healthState.engine = engineOk;
    }
    const comfyOk = await probeUrl('http://127.0.0.1:8188/system_stats');
    if (comfyOk !== healthState.comfy) {
        fatalLog('health: ComfyUI ' + (comfyOk ? '就绪' : '不可达') + ' 8188');
        healthState.comfy = comfyOk;
    }
}

const STICKER_SCRIPT = join(ROOT, 'sticker-maintain.ps1');

const TOOL_LINT_SCRIPT = join(ROOT, 'tool-contract-lint.mjs');
const PLUGIN_LIB_DIR = process.env.DSH_ONEBOT_LIB
    ?? 'C:/Users/user/.dsh/profiles/desktop/node_modules/dsh-onebot-qq/lib';

/** 启动断言：33 个工具的 schema meta + 四态契约 lint，任一失败拒绝启动（fail-closed）。
 *  走子进程：lint 会把 QQ_PROXY_ROOT 指到临时沙箱，避免碰到线上常驻/开关配置。 */
async function assertToolContracts() {
    const exitCode = await new Promise(resolve => {
        const child = spawn(process.execPath, [TOOL_LINT_SCRIPT], {
            env: { ...process.env, DSH_ONEBOT_LIB: PLUGIN_LIB_DIR },
            stdio: ['ignore', 'inherit', 'inherit'],
            windowsHide: true,
        });
        child.on('error', error => {
            logLine('FATAL tool contract: 无法启动 lint 子进程：' + (error?.message ?? String(error)));
            resolve(-1);
        });
        child.on('exit', code => resolve(code ?? -1));
    });
    if (exitCode !== 0) {
        logLine('FATAL tool contract: lint 退出码 ' + exitCode + '，拒绝启动');
        console.error('[qq-persona-proxy] tool contract lint failed, exit ' + exitCode);
        process.exit(1);
    }
    logLine('tool contract ok: 33 个工具的 schema meta + 四态契约通过');
}

/** 启动断言：上游 /models 必须真的有 LLM.model，否则拒绝启动（不许静默回落到别的模型）。 */
async function assertModelRoute() {
    const url = LLM.baseUrl.replace(/\/+$/, '') + '/models';
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
        if (!response.ok)
            throw new Error('HTTP ' + response.status);
        const data = await response.json();
        const ids = Array.isArray(data?.data) ? data.data.map(item => String(item?.id ?? '')) : [];
        if (!ids.includes(LLM.model)) {
            logLine('FATAL model route: ' + url + ' 里没有 ' + LLM.model + '，实际=[' + ids.join(', ') + ']');
            console.error('[qq-persona-proxy] model route assertion failed: ' + LLM.model);
            process.exit(1);
        }
        logLine('model route ok: ' + LLM.model + ' @ ' + url);
    }
    catch (error) {
        logLine('FATAL model route: 无法验证 ' + url + '：' + (error?.message ?? String(error)));
        console.error('[qq-persona-proxy] model route assertion failed:', error);
        process.exit(1);
    }
}

/** 请求自带的 model 必须指向同一个模型：允许 provider 前缀（ninfer/bonsai-2-27b），
 *  但不允许换成别的模型后由 proxy 悄悄改写。 */
function modelMismatchOf(body) {
    const requested = typeof body?.model === 'string' ? body.model.trim() : '';
    if (requested === '')
        return '';
    const bare = requested.split('/').pop();
    return bare === LLM.model ? '' : requested;
}

/** 表情包维护：原来由计划任务每天 04:30 跑，现在只在栈运行时由调度器到点执行。 */
function runStickerMaintenance() {
    return new Promise(resolve => {
        if (!existsSync(STICKER_SCRIPT)) {
            fatalLog('warn: sticker.maintain 找不到脚本 ' + STICKER_SCRIPT);
            resolve();
            return;
        }
        const child = spawn('powershell.exe', [
            '-NoLogo', '-NoProfile', '-NonInteractive',
            '-ExecutionPolicy', 'Bypass', '-File', STICKER_SCRIPT,
        ], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let tail = '';
        const collect = chunk => { tail = (tail + String(chunk)).slice(-2_000); };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        const killer = setTimeout(() => {
            fatalLog('warn: sticker.maintain 超过 25 分钟，终止');
            try { child.kill(); } catch { /* 忽略 */ }
        }, 25 * 60_000);
        killer.unref?.();
        child.on('error', error => {
            clearTimeout(killer);
            fatalLog('warn: sticker.maintain 启动失败: ' + (error?.message ?? String(error)));
            resolve();
        });
        child.on('exit', code => {
            clearTimeout(killer);
            fatalLog('info: sticker.maintain 结束 code=' + code + (tail ? ' tail=' + tail.trim().slice(-400) : ''));
            resolve();
        });
    });
}

scheduler.register({ id: 'defer.sweep', intervalMs: DEFER_SWEEP_MS, run: async () => sweepDeferQueue() });
scheduler.register({ id: 'comfy.idleFree', intervalMs: COMFY_IDLE_FREE_MS, run: async () => freeComfyIfIdle() });
scheduler.register({ id: 'groupState.compact', intervalMs: 30_000, timeoutMs: 90_000, run: async () => contextCompressor.poll() });
scheduler.register({ id: 'presence.decay', intervalMs: 5 * 60_000, run: async () => { gateRuntimes().presence.get(); } });
scheduler.register({ id: 'health.probe', intervalMs: 60_000, run: async () => probeHealth() });
scheduler.register({ id: 'heartbeat.persist', intervalMs: 60_000, run: async () => writeHeartbeatFile() });
scheduler.register({ id: 'sticker.maintain', intervalMs: 24 * 60 * 60_000, timeoutMs: 30 * 60_000, run: async () => runStickerMaintenance() });

// B 站主动刷：这个 worker 之前从未在 proxy 里启动过，默认保持关闭；
// 只有显式设置 QQ_BILI_PROACTIVE=1 才交给调度器驱动，避免悄悄打开未验证的行为。
if (process.env.QQ_BILI_PROACTIVE === '1') {
    let watcher = null;
    scheduler.register({
        id: 'bili.worker',
        intervalMs: Number(process.env.QQ_BILI_PROACTIVE_INTERVAL_MS ?? 10 * 60_000),
        timeoutMs: 10 * 60_000,
        run: async () => {
            if (watcher === null) {
                const mod = await import('./bili-proactive.mjs');
                watcher = mod.createWatcher({ log: (level, message) => fatalLog('bili ' + level + ': ' + message) });
            }
            await watcher.tick();
        },
    });
}

const RELATION_TENDENCY = {
    熟悉: '可以更放松、更熟络一点',
    一般: '保持正常客气',
    生疏: '更客气、留点距离',
};

/** 关系分 → 一句行为分寸。分数与 impression 不出现在 prompt 里。 */
function relationToneSection(tone, nickname) {
    const tendency = RELATION_TENDENCY[tone];
    if (tendency === undefined)
        return '';
    const who = typeof nickname === 'string' && nickname !== '' ? nickname : '对方';
    return '\n\n## 对当前说话人的倾向\n- 对' + who + '：' + tendency + '。按这个分寸说话，不要解释原因。';
}

// 引擎运行态探针：只有 /health 才算数。端口在听、/v1/models 200 都不代表能推理——
// 2026-11-14 02:02Z 起的闩锁故障就是 8094 在听、/v1/models 200，但 /health 503、
// 所有 completion 503。2 秒内复用结果，避免被守护/控制台高频轮询打成风暴。
let engineHealthCache = { at: 0, value: null };
async function probeEngineHealth() {
    const now = Date.now();
    if (engineHealthCache.value !== null && now - engineHealthCache.at < 2000)
        return engineHealthCache.value;
    let value;
    try {
        const resp = await fetch(new URL('/health', LLM.baseUrl), { signal: AbortSignal.timeout(1500) });
        let body = null;
        try { body = await resp.json(); }
        catch { body = null; }
        value = { ok: resp.ok, httpStatus: resp.status, status: body?.status ?? null, error: null };
    }
    catch (error) {
        value = { ok: false, httpStatus: 0, status: 'unreachable', error: String(error?.message ?? error) };
    }
    value.checkedAt = new Date(now).toISOString();
    engineHealthCache = { at: now, value };
    return value;
}

const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        // 自身 ok 恒为 true（start-proxy 靠 200 判活）；引擎状态单列，真 503 时 degraded=true。
        const engineHealth = await probeEngineHealth();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            ok: true,
            degraded: !engineHealth.ok,
            listen: LISTEN_PORT,
            engine: LLM.engine,
            upstream: LLM.baseUrl,
            model: LLM.model,
            engineHealth,
            config: CONFIG_SOURCE,
        }));
        return;
    }

    if (req.method === 'GET' && req.url === '/internal/queue') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            active: upstreamActive,
            waiting: upstreamWaiters.length,
            limit: UPSTREAM_QUEUE_LIMIT,
            dropped: upstreamDropped,
        }));
        return;
    }

    if (req.method === 'GET' && req.url === '/internal/defer') {
        const deferPath = process.env.QQ_DEFER_PATH ?? join(ROOT, 'defer-queue.json');
        const groups = {};
        try {
            const raw = JSON.parse(readFileSync(deferPath, 'utf8'));
            const stamp = Date.now();
            for (const [groupId, group] of Object.entries(raw?.groups ?? {})) {
                const items = Array.isArray(group?.items) ? group.items : [];
                groups[groupId] = {
                    pending: items.length,
                    oldestAgeMs: items.length === 0 ? 0 : Math.max(0, stamp - Number(items[0]?.at ?? stamp)),
                };
            }
        }
        catch {
            // 没有队列文件就是空，不报错。
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ groups }));
        return;
    }

    if (req.method === 'POST' && req.url === '/comfy/ensure') {
        const result = await ensureComfy();
        res.writeHead(result.ok ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
    }

    if (req.method === 'POST' && req.url === '/decide') {
        let raw;
        try {
            raw = await readBody(req);
        }
        catch (error) {
            res.writeHead(413, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
            return;
        }
        let input;
        try {
            input = JSON.parse(raw.toString('utf8'));
        }
        catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'invalid JSON' } }));
            return;
        }
        const messages = Array.isArray(input?.messages) ? input.messages : [];
        if (messages.length === 0) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'messages required' } }));
            return;
        }
        // 出图时模型不在显存里：决定是否接话这一步不再等 15 秒（等完还是没模型，
        // 用户只看到沉默）。直接放行，让后面的回复步骤给出「我在画图」。
        if ((await readLease()) !== undefined) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                choices: [{ message: { role: 'assistant', content: '{"reply":true,"reason":"正在出图，先告知稍等"}' } }],
            }));
            return;
        }
        const decisionPayload = normalizePayload({
            temperature: 0.2,
            max_tokens: Math.max(120, Math.min(800, Number(input.max_tokens) || 300)),
            stream: false,
            chat_template_kwargs: { enable_thinking: false },
            reasoning_effort: 'none',
            messages,
        });
        const payload = Buffer.from(JSON.stringify(decisionPayload), 'utf8');
        const headers = applyUpstreamAuth({
            'content-type': 'application/json',
            'content-length': String(payload.length),
        });
        const upstream = UPSTREAM_TRANSPORT.request({
            host: LLM.host,
            port: LLM.port,
            method: 'POST',
            path: chatCompletionsPath(),
            headers,
            timeout: 20_000,
        }, upstreamRes => {
            upstreamRes.on('error', () => {});
            res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
            upstreamRes.pipe(res);
        });
        upstream.on('error', error => {
            logLine('decision upstream error: ' + (error instanceof Error ? error.message : String(error)));
            if (!res.headersSent)
                res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'decision upstream error: ' + (error instanceof Error ? error.message : String(error)) } }));
        });
        upstream.end(payload);
        return;
    }

    if (req.method === 'POST' && req.url === '/review') {
        let raw;
        try {
            raw = await readBody(req);
        }
        catch (error) {
            res.writeHead(413, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
            return;
        }
        // 审核请求同样走可配置后端：模型名统一映射，去掉 ninfer 不认的
        // chat_template_kwargs（如果配置声明不支持）。
        let reviewPayload = raw;
        try {
            const parsedReview = JSON.parse(raw.toString('utf8'));
            if (parsedReview && typeof parsedReview === 'object') {
                reviewPayload = Buffer.from(JSON.stringify(normalizePayload(parsedReview)), 'utf8');
            }
        }
        catch {
            // 非 JSON 原样转发
        }
        // 审稿同样是模型请求：出图期间聊天模型已卸载，放进去会触发冷加载抢显存。
        // 直接 503，让审稿侧按失败降级（机器审/暂存），不碰引擎。
        const reviewLease = await readLease();
        if (reviewLease !== undefined) {
            logLine('review skipped: gpu lease active (lease ' + reviewLease.id.slice(0, 8) + ')');
            // reason=busy 是给审稿侧的唯一可判标记：出图租约只是"暂时审不了"，
            // 不是"审不过"，审稿侧据此放行原文而不是丢弃。
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                error: { message: 'gpu busy: 正在生成图片，跳过审稿' },
                reason: 'busy',
                lease: reviewLease.id.slice(0, 8),
            }));
            return;
        }
        try {
            await acquireUpstreamSlot();
        }
        catch {
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                error: { message: 'engine busy: queue full, retry later' },
                reason: 'busy',
                lease: 'engine-queue',
            }));
            return;
        }
        res.once('close', releaseUpstreamSlot);
        const headers = applyUpstreamAuth({
            'content-type': 'application/json',
            'content-length': String(reviewPayload.length),
        });
        const upstream = UPSTREAM_TRANSPORT.request({
            host: LLM.host,
            port: LLM.port,
            method: 'POST',
            path: chatCompletionsPath(),
            headers,
            timeout: LLM.reviewTimeoutMs,
        }, upstreamRes => {
            upstreamRes.on('error', () => {});
            res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
            upstreamRes.pipe(res);
        });
        upstream.on('error', error => {
            logLine('review upstream error: ' + (error instanceof Error ? error.message : String(error)));
            if (!res.headersSent)
                res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'review upstream error: ' + (error instanceof Error ? error.message : String(error)) } }));
        });
        upstream.end(reviewPayload);
        return;
    }

    if (req.method === 'GET' && req.url?.startsWith('/internal/ctx-status')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(contextCompressor.status()));
        return;
    }

    if (req.method === 'GET' && req.url?.startsWith('/internal/ctx-state')) {
        let chat = '';
        try {
            chat = new URL(req.url, 'http://127.0.0.1').searchParams.get('chat') ?? '';
        }
        catch {
            chat = '';
        }
        if (chat !== '' && !chat.includes(':'))
            chat = 'group:' + chat;
        const snap = contextCompressor.snapshot(chat);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ chat, ageMs: snap.ageMs, fresh: snap.fresh, text: snap.text, state: snap.state }));
        return;
    }

    if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url?.startsWith('/v1/chat/completions?'))) {
        const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
        if (auth !== '')
            lastAuthorization = auth;
        let raw;
        try {
            raw = await readBody(req);
        }
        catch (error) {
            res.writeHead(413, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
            return;
        }
        let body;
        try {
            body = JSON.parse(raw.toString('utf8'));
        }
        catch {
            forward(req, res, raw);
            return;
        }
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const sourceInfo = resolveRequestSource(req, body);
        const qqRequest = sourceInfo.source === 'qq';
        logLine('request source: ' + sourceInfo.source + ' why=' + sourceInfo.why
            + ' session=' + (sourceInfo.session || '-')
            + ' stream=' + (body.stream === true) + ' messages=' + messages.length
            + ' tools=' + (Array.isArray(body.tools) ? body.tools.length : 0));
        // 出图期间聊天模型已被卸载、MOSS 占着显存。所有模型请求（不只 QQ）都要
        // 先等租约释放，否则宿主的其它会话会触发引擎把聊天模型冷加载
        // 回来，和 MOSS 抢显存直接 OOM。等不到就 fail closed，绝不转发。
        const lease = await readLease();
        if (lease !== undefined) {
            if (qqRequest) {
                // 租约现在只会在 ComfyUI 就绪、真的开始出图后存在；此时聊天模型
                // 已被卸载，回什么都不可能是模型自己说的。这里一律保持沉默，
                // 不再由 proxy 编一句「在画图」冒充 assistant 消息（也避开审稿）。
                // 「在画图」由 qq_draw 工具在出图真正开始时自己发。
                logLine('qq request during gpu lease: stay silent (lease ' + lease.id.slice(0, 8) + ')');
                sendSilence(res, body, sourceInfo.source, 'gpu_lease_silent', 'chat model unloaded during image generation');
                return;
            }
            logLine('model request waiting for gpu lease: ' + (lease.reason ?? '') + ' owner=' + (lease.owner ?? ''));
            const released = await waitForLeaseRelease(260_000);
            if (!released) {
                logLine('model request rejected: gpu lease still active');
                res.writeHead(503, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'gpu busy: 正在生成图片，临时卸载了聊天模型' } }));
                return;
            }
        }
        if (qqRequest)
            recordToolUsage(messages);
        // 接话闸门：白名单群的普通消息先过状态机/专注度/判定器。
        // 判沉默或进了延迟队列就直接返回空串，不占上游队列、不生成回复。
        if (qqRequest) {
            const gate = await gateTurn(messages);
            if (gate.mode === 'reply') {
                // 延迟队列到点不再以“平台话术”直接发群：只记日志、保持沉默。
                logLine('QQ silence: deferred followup suppressed (platform will not speak) in '
                    + latestScene(messages).chatId + ' — ' + gate.rule + ' text=' + String(gate.text ?? '').slice(0, 60));
                sendSilence(res, body, sourceInfo.source, 'deferred_followup', 'deferred followup is platform speech');
                return;
            }
            if (gate.mode === 'silent') {
                logLine('gate: silent in ' + latestScene(messages).chatId + ' — ' + gate.rule);
                sendSilence(res, body, sourceInfo.source, 'gate_silent', 'reply gate decided to stay silent');
                return;
            }
        }
        try {
            await acquireUpstreamSlot();
        }
        catch {
            if (qqRequest) {
                logLine('QQ silence: upstream queue full, platform will not speak');
                sendSilence(res, body, qqContext.source ?? 'qq', 'upstream_queue_full', 'upstream concurrency queue is full');
            }
            else {
                res.writeHead(503, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'engine busy: queue full, retry later' } }));
            }
            return;
        }
        res.once('close', releaseUpstreamSlot);
        if (!qqRequest) {
            // 桌面宿主也连这个端口。默认关闭思考：部分本地模型会把整段
            // 输出预算耗在隐藏推理上，可见内容为空。客户端显式要求思考时
            // 才保留。
            const explicit = typeof body.reasoning_effort === 'string' && body.reasoning_effort !== '' && body.reasoning_effort !== 'none';
            const wantsThinking = explicit || body.chat_template_kwargs?.enable_thinking === true;
            applyDshDefaults(body, messages);
            const trimmed = trimDshHistory(messages);
            normalizePayload(body);
            // 桌面宿主（source=client）原来直连上游，图片按原分辨率进模型；
            // 02:31 那次 9 MP 图实测 9,024 token / 141 页。这里复用 QQ 路径同一套
            // 压缩（长边 ≤1024、≤1 MP、JPEG q82），压失败只丢这张图，不让整回合失败。
            try {
                const images = await normalizeImageParts(messages);
                if (images.converted > 0 || images.lost > 0)
                    logLine('client images | converted=' + images.converted + ' lost=' + images.lost);
            }
            catch (error) {
                logLine('client images | normalize failed: ' + (error?.message ?? String(error)));
            }
            if (trimmed > 0)
                logLine('dsh history trimmed to ' + messages.length + ' messages (~' + DSH_HISTORY_TOKEN_BUDGET + ' token budget) dropped=' + trimmed + ' windowDropped=' + trimmed);
            if (!wantsThinking)
                body.reasoning_effort = 'none';
            forward(req, res, Buffer.from(JSON.stringify(scrubBody(body)), 'utf8'));
            return;
        }
        const character = await loadCharacter();
        if (character === '') {
            forward(req, res, raw);
            return;
        }
        const meta = latestGroupMeta(messages);
        const latestText = meta === undefined ? '' : meta.text;
        const [state, notebook, diary, feedSection, taskDoc, biliActivity] = await Promise.all([
            loadState(),
            loadNotebook(),
            loadDiary(),
            sharedFeedText(latestText),
            readTasks(),
            loadBiliActivity(),
        ]);
        // 长期记忆按本轮内容检索，而不是无差别注入最近 25 条；检索是纯本地
        // 计算，不额外调用模型，避免给回复路径加延迟。
        // 场景键来自【场景标记】；旧插件没有这行时回退 legacy-group / private:<QQ>。
        const scene = latestScene(messages);
        const speaker = speakerMark(messages);
        const recentTexts = recentUserTexts(messages, 4);
        const queryText = recentTexts.join('\n');
        const memoryScene = {
            sceneKey: scene.sceneKey,
            isMaster: speaker?.isMaster === true,
            speakerQq: speaker?.qq ?? '',
        };
        const migratedNotebook = migrateNotebook(notebook);
        const {
            entries: memoryEntries,
            filtered: memoryFiltered,
            scores: memoryScores,
        } = selectMemoryEntries(migratedNotebook, queryText, {
            // 旧插件没有【场景标记】：场景无法判定时不做隔离，保持旧行为不变。
            // 新插件一定带标记，按 group:/private: 严格过滤。日志仍如实记 sceneFallback。
            limit: 8, maxChars: 2400, scene: scene.sceneFallback ? null : memoryScene, withScores: true,
        });
        const memorySection = formatMemorySection(memoryEntries, { maxChars: 2400 });
        // 关系倾向按当前说话人裁剪：只给一句行为分寸，不带分数、不带 impression。
        const relationTone = speaker === undefined ? '' : relationToneOf(migratedNotebook, speaker.qq, { now: Date.now() });
        const relationSection = relationToneSection(relationTone, speaker?.nickname ?? '');
        const workingSection = workingMemoryText({
            chatKind: scene.chatKind === 'private' ? 'private' : 'group',
            chatId: scene.chatId ?? '',
            speaker: speaker?.nickname ?? '',
            speakerQq: speaker?.qq ?? '',
            isMaster: speaker?.isMaster === true,
            recentUserTexts: recentTexts,
        });
        const notebookSection = memorySection;
        // 梗走的是同一条注入通道（dynamicSections → systemTail），不新开管线：
        // 只在用户这轮真的提到/问到词条时给 0–3 条，检索纯本地读 memes.jsonl。
        let memeHit = { section: '', picked: [], trigger: '' };
        try {
            memeHit = searchMemes({
                text: queryText,
                chatId: String(scene.chatId ?? ''),
                sceneKey: String(scene.sceneKey ?? ''),
            });
        }
        catch (error) {
            logLine('QQ meme inject skipped: ' + (error instanceof Error ? error.message : String(error)));
        }
        const diarySection = diaryText(diary);
        // 稳定前缀：character.md → 静态规则 → 工具总表。这三段每轮逐字节相同，
        // 引擎的 prefix cache 才能从这里命中；逐轮变化的内容统一留到最后的动态段。
        // 之前把「## 角色状态」紧跟在人设后面，等于每轮都在公共前缀的第二个块
        // 就制造差异，缓存永远只能吃到 3–4k。
        const dynamicSections = ['## 角色状态\n' + stateText(state)];
        // 我正在刷什么：后台观看写成第一人称现状，复用同一条 systemTail 通道。
        const biliSection = biliActivitySection(biliActivity);
        if (biliSection !== '') {
            dynamicSections.push(biliSection);
            logLine('QQ bili activity inject: items=' + Math.min(3, biliActivity.length) + ' chars=' + biliSection.length);
        }
        if (workingSection !== '')
            dynamicSections.push(workingSection);
        if (notebookSection !== '')
            dynamicSections.push(notebookSection);
        // 常驻记忆索引：只列主题（100–200 token），让模型知道“有东西可查”，
        // 细节由 memory_search 拉，避免把整本笔记塞进 prompt。
        const indexSection = memoryIndexText(migratedNotebook, scene.sceneFallback ? null : memoryScene, { maxChars: 520 });
        if (indexSection !== '')
            dynamicSections.push(indexSection);
        if (relationSection !== '')
            dynamicSections.push(relationSection);
        if (memeHit.section !== '') {
            dynamicSections.push(memeHit.section);
            logLine('QQ meme inject: terms=' + memeHit.picked.join('|') + ' trigger=' + memeHit.trigger);
        }
        // 群消息拿不到群号，只在私聊按 QQ 精确匹配，避免把别处的任务内容带进群。
        const groupNow = latestIsGroupChat(messages);
        const speakerNow = speakerMark(messages);
        const taskSection = groupNow
            ? (taskDoc.tasks.some(task => task.status === 'active' && task.chatId.startsWith('group:'))
                ? '## 进行中的任务\n本群可能有进行中的任务；需要时先用 qq_task(action="list") 查看，不要凭空回忆进度。'
                : '')
            : (speakerNow === undefined ? '' : formatTaskSection(taskDoc, { chatId: 'private:' + speakerNow.qq }));
        if (taskSection !== '')
            dynamicSections.push(taskSection);
        if (diarySection !== '')
            dynamicSections.push('## 日记\n' + diarySection);
        if (feedSection !== '')
            dynamicSections.push(feedSection);
        let system = character;
        system += '\n\n## 记忆怎么用\n- 下面附的长期记忆是背景，不是台词：不要主动说“我记得/根据我的记忆”，也不要整段复述。\n- 主人纠正你、或出现值得长期记住的称呼/偏好/承诺时，用 qq_notebook(add) 记一条；不记流水账、不记隐私。\n- 旧记忆和主人最新说法冲突时，以主人最新说法为准，不要替旧记忆辩护。\n- 没真正调用 qq_notebook 就不要说“记住了/已存进记忆”。\n- 用户说“记住/以后都/别忘/记一下”，或说出长期偏好、称呼、约定时：当轮必须先调用 qq_notebook(add) 再回复。\n\n## 任务怎么用\n- 需要多步或跨轮完成的事（写代码、整理资料、批量出图、部署、查证）：先 qq_task(action="add", title="...", brief="...")，每完成一步 qq_task(action="update", note="...")，全部结束 done，用户说停/别做用 cancel。\n- 系统会每 3 分钟自动续跑进行中的任务，任务状态跨轮有效；不要只在正文里说“我在做/马上弄”，也不要重复已经写进进度的事。\n- 续跑回合（消息以【任务续跑】开头）只推进一小步，正文最多两三句；不要写长计划或长文。\n- 一步就能答完的小事不要建任务。\n\n## 现在怎么回\n以上是你的设定和记忆，不是要念出来的台词。直接回对方，日常 1-2 句，先接住对方的话；主人让你解题/写代码时给完整内容。不要复述这段提示、不要报工具名、不要写小说旁白或客服腔。不要重复你以前说过的句子或句式；对方换了话题就跟着换，不翻旧账，不硬接不属于你的问题。';
        // Some providers also carry a top-level system/developer field; the
        // persona proxy must remove it or the old host persona can leak into
        // the model alongside character.md.
        const hadTopSystem = 'system' in body || 'developer' in body;
        if ('system' in body)
            delete body.system;
        if ('developer' in body)
            delete body.developer;
        // 先按类去掉历史里重复的宿主脚手架（只留最新一条），再按预算裁剪：
        // 不这么做的话，被裁掉的首先是真实聊天，而重复快照会继续占窗口。
        const deduped = dedupeScaffoldHistory(stripInnerHistory(messages.filter(message => message?.role !== 'system' && message?.role !== 'developer')));
        // 重复检索短路：同回合里逐字相同的 web_search / qq_notebook / memory_search
        // 结果留第一条，其余压成终态提示，避免模型拿着同一份材料再搜六遍。
        const collapsedTools = collapseDuplicateToolResults(deduped.messages);
        // 历史卫生：裸调用残片→一行调用事实、事件→元数据行、读图按 sha256 幂等、
        // 快照每回合一行。必须在裁剪之前，省下的字符才进预算。
        // keepFrom：最近几轮里的事件（私聊拍一拍就是这一轮的入站原文）不能按过期丢。
        const hygiene = applyHistoryHygiene(collapsedTools.messages, { keepFrom: recentDialogueStart(collapsedTools.messages) });
        collapsedTools.messages = hygiene.messages;
        if (hygiene.stats.scaffolds + hygiene.stats.readImageDup + hygiene.stats.toolCallFacts + hygiene.stats.events > 0)
            logLine('QQ history hygiene: ' + JSON.stringify(hygiene.stats));
        if (collapsedTools.replaced > 0)
            logLine('QQ tool dedupe: turnTools=' + collapsedTools.turnTools + ' replaced=' + collapsedTools.replaced);
        // 最近 N 轮对话（用户原文 + 机器人上一句）进保护段，原样注入；
        // 更早的才按 replyHistoryMessages / 预算压成索引。
        const latestRaw = latestUserMessageText(messages);
        const latestSaid = (/<user_message[^>]*>([\s\S]*?)<\/user_message>/u.exec(latestRaw)?.[1] ?? latestRaw);
        const latestTs = messageTimestampOf({ role: 'user', content: latestRaw });
        const protectFrom = recentDialogueStart(collapsedTools.messages);
        const history = trimHistory(collapsedTools.messages, LLM.budgetTokens, LLM.replyHistoryMessages, { protectFrom });
        if (deduped.removed > 0) {
            const classes = [...deduped.totals]
                .map(([kind, total]) => kind + ':' + total + '->' + (deduped.keptCounts.get(kind) ?? 0))
                .join(',');
            logLine('QQ compaction dedupe: removed=' + deduped.removed
                + ' classes=' + classes
                + ' relocated=' + (deduped.relocated ?? 0)
                + ' savedTokens=' + deduped.savedTokens);
        }
        if (history.protectedOverflow > 0)
            logLine('QQ compaction protect: overflow=' + history.protectedOverflow
                + ' (保护段自身超过 ' + LLM.budgetTokens + ' token，只能从保护段最旧处让位)');
        // 每次真正裁剪都留一行审计：丢弃区间 + token 前后 + 硬下限保护段。
        if (history.dropped.length > 0) {
            const dropEnd = collapsedTools.messages.length - history.kept.length - 1;
            const audit = {
                at: new Date().toISOString(),
                kind: 'context-trim',
                chat: scene.chatId ?? '-',
                dropRange: '0..' + Math.max(0, dropEnd),
                droppedMessages: history.dropped.length,
                toolGroupsDropped: history.toolDropped,
                tokensBefore: history.tokensBefore,
                tokensAfter: history.tokens,
                protectedMessages: history.protectedCount,
                protectedOverflow: history.protectedOverflow,
                budgetTokens: LLM.budgetTokens,
            };
            try { appendFileSync(TURN_AUDIT_PATH, JSON.stringify(audit) + '\n', 'utf8'); } catch { /* 审计失败不阻塞回复 */ }
            logLine('QQ context trim: ' + JSON.stringify(audit));
        }
        const kept = history.kept;
        // 群里（以及非主人私聊）不出现图片审核/私信流程；主人私聊保留，方便
        // 用 /pass 管图。旧回复里已经有这些句子，先剪掉再喂给模型，避免复读。
        const imageContext = IMAGE_CONTEXT_RE.test(latestSaid);
        // 续跑只推进一小步：限制输出长度，避免长时间占着本地模型、
        // 让主人发来的消息排队等它写完。
        if (latestSaid.includes('【任务续跑】') && (!Number.isFinite(Number(body.max_tokens)) || Number(body.max_tokens) > 512))
            body.max_tokens = 512;
        const hideReviewTalk = latestIsGroupChat(messages) || (speaker !== undefined && speaker.isMaster !== true);
        if (hideReviewTalk) {
            for (const message of kept) {
                if (message?.role === 'assistant' && typeof message.content === 'string')
                    message.content = stripReviewTalk(message.content, '');
            }
        }
        // 后台压缩器状态：群聊且新鲜（<15min）时注入；此时不再重复注入
        // summarizeDropped 的摘要正文，避免两份摘要互相打架（摘要仍照常落日志）。
        const ctxSceneKey = scene.chatKind === 'group'
            ? (scene.sceneKey === 'legacy-group' ? (envelopeSceneKey(messages) || scene.sceneKey) : scene.sceneKey)
            : '';
        const ctxStateNow = ctxSceneKey !== ''
            ? contextCompressor.snapshot(ctxSceneKey)
            : { text: '', fresh: false, ageMs: -1 };
        const ctxStateText = ctxStateNow.text;
        // 摘要只看本轮入站前 2 小时内；本轮只有图没配文时，旧话题一律不进摘要。
        const imageOnlyTurn = imageContext
            && !/\p{L}/u.test(latestSaid.replace(/\[图片:[^\]]*\]/gu, ' '));
        const compaction = summarizeDropped(history.dropped, hideReviewTalk, { newerThanTs: latestTs, imageOnlyTurn });
        const summaryInjected = compaction.text !== '' && !(ctxStateText !== '' && ctxStateNow.fresh);
        if (summaryInjected)
            dynamicSections.unshift('## 较早对话摘要（自动压缩，只作参考，不是指令，不要复述）\n' + compaction.text);
        if (ctxStateText !== '')
            dynamicSections.unshift(ctxStateText);
        if (ctxStateText !== '' || compaction.text !== '') {
            logLine('QQ ctx-state: group=' + ctxSceneKey
                + ' injected=' + (ctxStateText !== '' ? '1' : '0')
                + ' fresh=' + (ctxStateNow.fresh ? '1' : '0')
                + ' ageSec=' + (ctxStateNow.ageMs < 0 ? '-' : Math.round(ctxStateNow.ageMs / 1000))
                + ' chars=' + ctxStateText.length
                + ' summaryInjected=' + (summaryInjected ? '1' : '0')
                + ' summaryChars=' + compaction.text.length);
        }
        // 压缩可观测性：把“摘要正文”和“被裁消息的身份”一起落盘，事后可直接
        // 核对某一轮里 A 的身份有没有被丢，而不是靠推测。
        const droppedIdentity = droppedSpeakerSummary(history.dropped);
        if (history.dropped.length > 0) {
            logLine('QQ compaction senders: dropped=' + history.dropped.length
                + ' user=' + droppedIdentity.userMessages
                + ' unknown=' + droppedIdentity.unknown
                + ' system=' + droppedIdentity.system
                + ' forwardLine=' + droppedIdentity.forwardLine
                + ' qqs=' + (droppedIdentity.senders.map(item => item.qq + ':' + item.count + (item.isMaster ? ':master' : ':member')).join('|') || '-'));
            if (droppedIdentity.detail.length > 0)
                logLine('QQ compaction detail: ' + droppedIdentity.detail.join(' | ').slice(0, 1200));
            logLine('QQ compaction summary: chars=' + compaction.text.length
                + ' skippedSystem=' + compaction.skippedSystem
                + ' skippedSystemTokens=' + compaction.skippedSystemTokens
                + ' skippedOld=' + (compaction.skippedOld ?? 0)
                + ' rosterPeople=' + (compaction.rosterSize ?? 0)
                + ' rosterChars=' + (compaction.rosterChars ?? 0)
                + ' rosterTokens~' + (compaction.rosterTokens ?? 0)
                + ' roster=[' + (compaction.rosterNames ?? '') + ']'
                + ' text=' + compaction.text.replace(/\n/gu, '\\n').slice(0, 800));
        }
        // 工具按需注入：默认只给常驻 schema，其余工具用一行总表介绍，
        // 模型需要时 qq_tool(action="load") 打开。总表放在静态规则之后、
        // 动态段之前：它只随“已加载工具”变化，多数轮次里仍属于可复用前缀。
        const residentConfig = await readResidentConfig();
        // 常驻名单统一从 tool-catalog 读：它已按 write-tools.json / stickers.json 过滤，
        // 不会出现“清单里有名字、插件没注册”。legacy 回退也走同一条路。
        const residentTools = await readResidentTools();
        const enabledTools = await readEnabledTools();
        let catalogChars = 0;
        if (residentConfig.enabled) {
            const catalog = await catalogSection({ resident: residentTools, loaded: enabledTools });
            if (catalog !== '') {
                system += '\n\n' + catalog;
                catalogChars = catalog.length;
            }
            // 被砍掉的工具不会出现在总表里，但历史里可能还留着对它们的调用；
            // 不点名说清楚，模型会继续往已消失的名字上伸手（实测 web_search 被裁后仍反复发起）。
            system += '\n\n总表里没有的工具名一律不存在：本环境没有联网工具（web_search / web_fetch），'
                + '也没有子代理（subagent）。不要调用它们，不要用 qq_tool 加载，也不要说自己要去查网。';
        }
        // 逐轮变化的内容不能留在 system 里：system 一旦出现差异，它之后整段历史都
        // 拿不到前缀复用。这里只收集成 systemTail，等历史裁剪完再挂到末条 user 消息后面，
        // 保证「人设 + 静态规则 + 工具总表」这段跨回合逐字节不变。
        let systemTail = dynamicSections.filter(section => section !== '').join('\n\n');
        // 慢通道读取端：私聊回合把主人已作答的条目当上下文注入，注入后标 consumed。
        // 只提供上下文，不替模型生成回复。
        if (String(scene.chatKind ?? '') === 'private') {
            const answered = pendingAnswersFor(String(scene.chatId ?? ''), Date.now());
            if (answered.length > 0) {
                const section = answersSection(answered);
                if (section !== '')
                    systemTail += (systemTail === '' ? '' : '\n\n') + section;
                markConsumed(answered.map(item => item.id));
                logLine('qq_ask answers injected: ' + answered.map(item => item.id).join(',')
                    + ' chat=' + (scene.chatId ?? '-'));
            }
        }
        const imageParts = await normalizeImageParts(kept);
        // 部分模型需要在服务端显式关闭 thinking，否则可见内容为空。
        // reasoning_effort 是 OpenAI 兼容字段；chat_template_kwargs 只有
        // 上游声明支持时才发送，避免 ninfer 等端点因未知参数返回 400。
        if (LLM.supportsChatTemplateKwargs) {
            body.chat_template_kwargs = {
                ...(body.chat_template_kwargs && typeof body.chat_template_kwargs === 'object' ? body.chat_template_kwargs : {}),
                enable_thinking: false,
            };
        }
        else {
            delete body.chat_template_kwargs;
        }
        body.reasoning_effort = 'none';
        // 模型路由断言：请求里写的是别的模型就直接 400，不再由 normalizePayload 静默改写。
        const badModel = modelMismatchOf(body);
        if (badModel !== '') {
            const detail = { at: new Date().toISOString(), kind: 'model-mismatch', chat: scene.chatId ?? '-', requested: badModel, expected: LLM.model };
            logLine('QQ model mismatch: ' + JSON.stringify(detail));
            try { appendFileSync(TURN_AUDIT_PATH, JSON.stringify(detail) + '\n', 'utf8'); } catch { /* 忽略 */ }
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: { type: 'model_mismatch', message: 'expected model ' + LLM.model + ', got ' + badModel } }));
            return;
        }
        normalizePayload(body);
        // 输出预算必须在这里封顶：QQ 通道的客户端会带几万的 max_tokens
        // （实测 24,807），引擎按这个值预留 KV —— 24.8k ≈ 388 页，一个请求
        // 就把 896 页的池子定光，这才是 429 的根因。真实输出只有 16–200 token，
        // 回复腿封到 LLM.maxTokens（1536）；续跑在下面单独压到 512。
        // 分析腿不走这里，它用 analyzeMaxTokens（160），两条腿不共用。
        const maxTokensRequested = Number.isFinite(Number(body.max_tokens)) ? Number(body.max_tokens) : 0;
        body.max_tokens = maxTokensRequested > 0
            ? Math.min(maxTokensRequested, LLM.maxTokens)
            : LLM.maxTokens;
        // 引擎按 OpenAI 语义优先读 max_completion_tokens：客户端带了这个字段时，
        // 上面设的 max_tokens 会被顶掉（实测 1536 → 引擎打 1,024）。QQ 链路只认 max_tokens。
        if (Object.hasOwn(body, 'max_completion_tokens'))
            delete body.max_completion_tokens;
        // 工具按需加载：常驻名单在 tool-resident.json（可直接改），其余由模型用
        // qq_tool(action="load") 打开，状态写在 tool-enabled.json 里，30 分钟
        // 过期。一次塞 50 个工具时 9B 会直接不发起 tool call，分层后才稳定。
        // 宿主下发的工具不再过名字白名单：请求里带什么就保留什么（工具该在就在）。
        // qq_* 仍走按需加载（常驻 + load），宿主工具不在此列，所以单独并进来。
        const offeredHostTools = (Array.isArray(body.tools) ? body.tools : [])
            .map(tool => tool?.function?.name)
            .filter(name => typeof name === 'string' && name !== '' && !name.startsWith('qq_'));
        const allowedTools = new Set([...residentTools, ...enabledTools, ...offeredHostTools]);
        // 同一份 denyHostTool 规则也用于工具表：被拒的工具不下发（群聊里
        // plugin_manager / schedule_edit 直接不出现；私聊 schedule_edit 正常出现）。
        for (const name of allowedTools) {
            if (denyHostTool(name, scene) !== null)
                allowedTools.delete(name);
        }
        // 即使 tool-enabled.json 里还留着旧记录、或宿主把工具塞进 body.tools，
        // 也不让付费联网工具回到 QQ 回合里。
        for (const name of BLOCKED_WEB_TOOLS)
            allowedTools.delete(name);
        // 第二道闸：重启恢复出来的陈旧回合——剔除所有会真的往 QQ 写东西的工具，
        // 并在 system 里说清楚。主闸是插件侧的持久化出站账本，这里只兜底。
        const staleTurn = staleTurnOf(messages, qqRequest);
        if (staleTurn !== null) {
            let removed = 0;
            if (Array.isArray(body.tools)) {
                const before = body.tools.length;
                body.tools = body.tools.filter(tool => {
                    const name = tool?.function?.name;
                    return typeof name !== 'string' || !WRITE_TOOL_NAMES.has(name);
                });
                removed = before - body.tools.length;
                if (body.tools.length === 0)
                    delete body.tools;
            }
            systemTail += (systemTail === '' ? '' : '\n\n') + '## 这一轮已经过期\n'
                + '这条入站消息产生于 ' + Math.round(staleTurn.ageMs / 60_000) + ' 分钟前，已经超过 3 分钟的回复时限。\n'
                + '本轮不要发送任何 QQ 消息、不要出图、不要转发或补发；发送类工具已被移除。\n'
                + '如果确实还要回应，只用一句话说明「这条已经太旧了」即可。';
            void appendFile(STALE_TURNS_PATH, JSON.stringify({ ...staleTurn, removed }) + '\n', 'utf8')
                .catch(error => fatalLog('warn: stale-turns 审计写入失败: ' + (error?.message ?? String(error))));
            fatalLog('warn: 陈旧回合已拦截 scene=' + staleTurn.sceneKey + ' age='
                + Math.round(staleTurn.ageMs / 60_000) + 'min source=' + staleTurn.source + ' removed=' + removed);
        }
        const toolsBefore = Array.isArray(body.tools) ? body.tools.length : 0;
        const toolChoiceIn = body.tool_choice;
        const toolsCharsBefore = Array.isArray(body.tools) ? JSON.stringify(body.tools).length : 0;
        const droppedToolNames = (Array.isArray(body.tools) ? body.tools : [])
            .map(tool => tool?.function?.name)
            .filter(name => typeof name === 'string'
                && (!allowedTools.has(name) || BLOCKED_WEB_TOOLS.has(name)));
        if (Array.isArray(body.tools)) {
            const keptTools = body.tools.filter(tool => {
                const name = tool?.function?.name;
                return typeof name === 'string' && allowedTools.has(name) && !BLOCKED_WEB_TOOLS.has(name);
            });
            // 工具定义在模板里排在 system 之前，顺序抖动会直接把前缀缓存打掉：
            // 按名字排序后，每轮下发的 tools 字节序列保持稳定。
            if (keptTools.length > 0)
                body.tools = keptTools.sort((a, b) => String(a?.function?.name ?? '').localeCompare(String(b?.function?.name ?? '')));
            else
                delete body.tools;
            // 问主人：只在私聊下发（与 schedule_edit 同一套 scene 判定，不复制逻辑）。
            if (denyHostTool(ASK_MASTER_TOOL, scene) === null) {
                body.tools = [...body.tools, askMasterToolDefinition()]
                    .sort((a, b) => String(a?.function?.name ?? '').localeCompare(String(b?.function?.name ?? '')));
            }
            // 工具表快照：出问题时能直接从日志核对「这一轮到底下发了什么」。
            logLine('QQ tools: ' + (body.tools?.length ?? 0) + ' names='
                + (body.tools?.map(tool => tool?.function?.name).join(',') || '-')
                + ' chat=' + (scene.chatId ?? '-') + ' kind=' + (scene.chatKind ?? 'legacy'));
            // 读图同回合只给一次：本轮已经读过图，就不再把这个工具下发给模型。
            if (Array.isArray(body.tools)
                && body.tools.some(tool => tool?.function?.name === 'read_image')
                && hasReadImageToolResult(body.messages)) {
                body.tools = body.tools.filter(tool => tool?.function?.name !== 'read_image');
                if (body.tools.length === 0)
                    delete body.tools;
                logLine('QQ tools: read_image hidden (already read this turn)');
            }
            // 带图/表情包回合收敛闸门（P2）：图看完了还在调别的工具，或工具预算用完，
            // 就不再等宿主走到 step-cap —— 撤工具，逼它用一句话回话。
            if (Array.isArray(body.tools) && (isMediaTurn(body.messages) || hasReadImageToolResult(body.messages))) {
                const mediaCalls = turnToolCallCount(body.messages);
                const wandered = wanderedAfterReadImage(body.messages);
                if (mediaCalls >= MEDIA_TURN_TOOL_BUDGET || wandered) {
                    delete body.tools;
                    systemTail += (systemTail === '' ? '' : '\n\n') + '## 现在就回答\n'
                        + '这一轮的图片/表情已经看过了，不要继续调用任何工具，也不要再查别的东西。'
                        + '直接用一句话回复对方这条消息：说你从图里看到的，或你对这个表情的反应；'
                        + '看不清就直说看不清并追问一句。不要提工具、流程、本轮或任何内部状态。';
                    logLine('QQ recovery: media turn not converged (calls=' + mediaCalls + ', wandered=' + wandered + '), tools stripped');
                }
            }
            // 没人明确要图就不给 qq_draw：它常驻，模型很容易顺手画一张，
            // 而画图会卸载聊天模型，代价远大于收益。
            if (Array.isArray(body.tools)
                && body.tools.some(tool => tool?.function?.name === 'qq_draw')
                && !inboundWantsImage(body.messages)) {
                body.tools = body.tools.filter(tool => tool?.function?.name !== 'qq_draw');
                if (body.tools.length === 0)
                    delete body.tools;
                logLine('QQ tools: qq_draw hidden (no explicit image request)');
            }
        }
        // 停顿硬闸门：回合中途停了 2 分钟以上（画图切显存、引擎重启），
        // 不许接着执行停顿前的工具计划——撤掉工具，让它重新写一条正常回复。
        const stall = stepStallInfo(body.messages);
        if (stall.step >= 2 && stall.ms >= 120_000) {
            if (Array.isArray(body.tools))
                delete body.tools;
            systemTail += (systemTail === '' ? '' : '\n\n') + '## 重新回答\n这一回合中途停了很久，之前打算做的事已经过期。不要继续之前的工具计划，直接用现在的上下文回答对方最新那句话，语气和平时一样，不要提停顿、工具、流程或任何内部状态。';
            logLine('QQ recovery: stalled turn step=' + stall.step + ' gap=' + Math.round(stall.ms / 1000) + 's, tools stripped');
        }
        // 查询闸门已经给出终态（未执行）：撤掉全部工具，让模型用现有上下文直接作答。
        // 不是兜底话术——这条回复由模型自己写，语气与正常回复一致。
        // 只认本轮（最后一条真实 user 之后）的 tool 结果：更早步骤的「查不到：」
        // 属于上一轮，拿它撤工具会把正常回合误伤成 17->0（2026-11-13 08:47）。
        const lastToolText = turnFinalToolText(body.messages);
        if (lastToolText !== '' && /本次调用未执行|本回合查询工具已经调用到上限|查不到：/u.test(lastToolText)) {
            if (Array.isArray(body.tools))
                delete body.tools;
            systemTail += (systemTail === '' ? '' : '\n\n') + '## 现在就回答\n'
                + '检索到此为止，没有更多信息可查。直接用你现有的上下文回答对方这句话，'
                + '语气和平时一样，不要提检索、工具、上限、本轮或任何流程，也不要道歉。';
            logLine('QQ recovery: query guard tripped, tools stripped for final answer');
        }
        // 硬上限兜底：system + 历史 + 工具描述 + 生成长度不能顶穿引擎窗口（默认 32768）。
        // trimHistory 已按 token 预算压过一轮；这里再按整体占用校验一次，
        // 超出时从最旧的历史开始挤掉（摘要上面已经生成，不重复压缩）。
        // 兜底必须真兜住：历史最多丢到最后一条，还不够就撤工具、再不行截 system，
        // 绝不把超窗 prompt 硬塞给引擎。
        const windowLimit = LLM.contextWindowTokens;
        let toolsTokens = Array.isArray(body.tools) ? estimateTokens(JSON.stringify(body.tools)) : 0;
        let systemTokens = estimateTokens(system) + estimateTokens(systemTail);
        let historyTokens = kept.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
        const windowBefore = systemTokens + historyTokens + toolsTokens + body.max_tokens;
        // 保护段（自上次机器人回复起）不允许被窗口兜底吃掉；真要吃时单独记账。
        const protectedKept = Math.min(history.protectedCount ?? 0, kept.length);
        let windowProtectedDropped = 0;
        let droppedForWindow = 0;
        let windowDroppedTokens = 0;
        const windowDroppedMessages = [];
        while (kept.length > Math.max(1, protectedKept)
            && systemTokens + historyTokens + toolsTokens + body.max_tokens > windowLimit) {
            const droppedSize = estimateMessageTokens(kept[0]);
            historyTokens -= droppedSize;
            windowDroppedTokens += droppedSize;
            windowDroppedMessages.push(kept[0]);
            kept.shift();
            droppedForWindow += 1;
        }
        // 从头部丢历史可能留下没有对应 tool_call 的孤儿工具结果，上游会 400。
        while (droppedForWindow > 0 && kept.length > Math.max(1, protectedKept) && kept[0]?.role === 'tool') {
            const droppedSize = estimateMessageTokens(kept[0]);
            historyTokens -= droppedSize;
            windowDroppedTokens += droppedSize;
            windowDroppedMessages.push(kept[0]);
            kept.shift();
            droppedForWindow += 1;
        }
        if (kept.length <= protectedKept && systemTokens + historyTokens + toolsTokens + body.max_tokens > windowLimit)
            windowProtectedDropped = protectedKept;
        if (droppedForWindow > 0) {
            systemTail += (systemTail === '' ? '' : '\n\n') + '【上下文超窗，最旧的 ' + droppedForWindow + ' 条消息已丢弃】';
            systemTokens = estimateTokens(system) + estimateTokens(systemTail);
            // 超窗丢弃同样要留下身份清单：这批消息没有进摘要（摘要已先生成）。
            const windowIdentity = droppedSpeakerSummary(windowDroppedMessages);
            logLine('QQ compaction window senders: windowDropped=' + droppedForWindow
                + ' user=' + windowIdentity.userMessages
                + ' unknown=' + windowIdentity.unknown
                + ' system=' + windowIdentity.system
                + ' forwardLine=' + windowIdentity.forwardLine
                + ' qqs=' + (windowIdentity.senders.map(item => item.qq + ':' + item.count + (item.isMaster ? ':master' : ':member')).join('|') || '-'));
            if (windowIdentity.detail.length > 0)
                logLine('QQ compaction window detail: ' + windowIdentity.detail.join(' | ').slice(0, 1200));
        }
        let toolsStrippedForWindow = false;
        if (Array.isArray(body.tools) && systemTokens + historyTokens + toolsTokens + body.max_tokens > windowLimit) {
            delete body.tools;
            toolsTokens = 0;
            toolsStrippedForWindow = true;
        }
        let systemTruncatedFrom = 0;
        if (systemTokens + historyTokens + toolsTokens + body.max_tokens > windowLimit) {
            // 最后一道：system 自己就撑爆窗口时按比例保尾部——结尾的“现在怎么回”
            // 比开头的人设段落更影响这一步输出。
            const budget = Math.max(512, windowLimit - historyTokens - toolsTokens - body.max_tokens);
            const keepChars = Math.max(400, Math.floor(system.length * (budget / Math.max(1, systemTokens))));
            if (keepChars < system.length) {
                systemTruncatedFrom = system.length;
                system = '【系统提示过长，前部已截断】\n' + system.slice(-keepChars);
                systemTokens = estimateTokens(system) + estimateTokens(systemTail);
            }
        }
        let windowAfter = systemTokens + historyTokens + toolsTokens + body.max_tokens;
        let lastTruncatedFrom = 0;
        if (windowAfter > windowLimit && kept.length === 1 && typeof kept[0]?.content === 'string') {
            // 只剩最后一条仍然超窗：只能截这一条自己的正文，保尾部（当前指令通常在末尾）。
            const budget = Math.max(256, windowLimit - systemTokens - toolsTokens - body.max_tokens);
            const keepChars = Math.max(200, Math.floor(kept[0].content.length * (budget / Math.max(1, historyTokens))));
            if (keepChars < kept[0].content.length) {
                lastTruncatedFrom = kept[0].content.length;
                const beforeSize = estimateMessageTokens(kept[0]);
                kept[0] = { ...kept[0], content: '【前文过长，已截断】\n' + kept[0].content.slice(-keepChars) };
                historyTokens += estimateMessageTokens(kept[0]) - beforeSize;
                windowAfter = systemTokens + historyTokens + toolsTokens + body.max_tokens;
            }
        }
        if (windowBefore > windowLimit) {
            fatalLog('warn: prompt ' + windowBefore + ' tokens 超过窗口 ' + windowLimit
                + '，已裁到 ' + windowAfter + '（丢 ' + droppedForWindow + ' 条历史 / '
                + windowDroppedTokens + ' tok'
                + (toolsStrippedForWindow ? '，撤掉全部工具' : '')
                + (systemTruncatedFrom > 0 ? '，system ' + systemTruncatedFrom + '->' + system.length + ' 字符' : '')
                + (lastTruncatedFrom > 0 ? '，最后一条 ' + lastTruncatedFrom + '->' + kept[0].content.length + ' 字符' : '')
                + '）');
            logLine('QQ window trim: before=' + windowBefore + ' after=' + windowAfter + '/' + windowLimit
                + ' droppedMessages=' + droppedForWindow + ' droppedTokens=' + windowDroppedTokens
                + ' protectedKept=' + protectedKept
                + ' protectedStop=' + (windowProtectedDropped > 0 ? '1' : '0')
                + ' toolsStripped=' + (toolsStrippedForWindow ? '1' : '0')
                + ' systemTruncated=' + (systemTruncatedFrom > 0 ? systemTruncatedFrom + '->' + system.length : '0')
                + ' lastMessageTruncated=' + (lastTruncatedFrom > 0 ? lastTruncatedFrom + '->' + kept[0].content.length : '0'));
        }
        const toolsChars = Array.isArray(body.tools) ? JSON.stringify(body.tools).length : 0;
        const toolNames = Array.isArray(body.tools)
            ? body.tools.map(tool => tool?.function?.name).filter(name => typeof name === 'string').join(',')
            : '';
        const rewritten = kept.map(message => (typeof message?.content === 'string'
            ? { ...message, content: stripEnvelopeLine(message.content) }
            : message));
        // 逐轮变化的块挂在最末一条 user 消息之后：前面 system + 历史保持逐字节稳定，
        // 引擎的前缀缓存才能一路命中到这一轮新加的用户话之前。
        if (systemTail !== '') {
            const lastIndexNow = rewritten.length - 1;
            const lastMessage = rewritten[lastIndexNow];
            if (lastMessage?.role === 'user' && typeof lastMessage.content === 'string')
                rewritten[lastIndexNow] = { ...lastMessage, content: lastMessage.content + '\n\n' + systemTail };
            else
                rewritten.push({ role: 'user', content: systemTail });
        }
        body.messages = [{ role: 'system', content: system }, ...rewritten];
        const promptTokens = systemTokens + historyTokens + toolsTokens;
        // “画一张/发一张…图”这类明确的出图请求：如果模型还没开始动手，就强制
        // 这一步必须发起 tool call。9B 经常只回一句“正在画哦”然后结束回合，
        // 图根本没生成。只在最后一条用户消息之后还没有任何工具活动时强制，
        // 避免在工具结果回来后的总结步里继续逼它调工具。
        const lastUserIndex = (() => {
            for (let index = kept.length - 1; index >= 0; index -= 1) {
                if (kept[index]?.role === 'user')
                    return index;
            }
            return -1;
        })();
        // 强制出图只认“本轮用户这条消息明确提出要图”，不再让上一轮 assistant 的承诺把人带进去。
        const drawIntent = lastUserIndex >= 0
            && EXPLICIT_DRAW_RE.test(messageText(kept[lastUserIndex]))
            && drawAddressedToMe(kept, lastUserIndex)
            && Array.isArray(body.tools)
            && body.tools.some(tool => tool?.function?.name === 'qq_draw');
        const toolActivityAfterUser = lastUserIndex < 0
            ? false
            : kept.slice(lastUserIndex + 1).some(message => message?.role === 'tool'
                || (message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0));
        const drawActivityAfterUser = lastUserIndex < 0
            ? false
            : kept.slice(lastUserIndex + 1).some(message => message?.role === 'assistant'
                && Array.isArray(message.tool_calls)
                && message.tool_calls.some(call => call?.function?.name === 'qq_draw'));
        const forced = drawIntent && !toolActivityAfterUser;
        if (forced) {
            body.tool_choice = 'required';
            // 只留 qq_draw 一个工具，9B 就不会再犹豫去挑别的工具，保证这一步
            // 真的发起出图，而不是又回一句“马上画”。
            body.tools = body.tools.filter(tool => tool?.function?.name === 'qq_draw');
            if (Array.isArray(body.messages) && body.messages[0]?.role === 'system') {
                body.messages[0] = {
                    role: 'system',
                    content: String(body.messages[0].content ?? '')
                        + '\n\n## 本轮硬性要求\n对方明确要图：这一步必须调用 qq_draw 生成图片，把画面写进 prompt。不要只回复“正在画/好的/马上”，也不要用文字代替图片。',
                };
            }
        }
        // tool_choice 必须和最终留下的工具集一致，否则上游直接 400，整轮没有回复：
        //   - required + 0 个工具 → "tool_choice='required' requires at least one tool"
        //   - required + 多个工具 → NInfer 无法约束，要求指名函数
        // 客户端偶尔会带 required 进来，工具被按需注入裁掉后就对不上了。
        const finalToolCount = Array.isArray(body.tools) ? body.tools.length : 0;
        if (finalToolCount === 0) {
            if (body.tool_choice !== undefined)
                logLine('tool_choice dropped: no tools left (' + String(body.tool_choice) + ')');
            delete body.tool_choice;
        }
        else if (body.tool_choice === 'required' && finalToolCount > 1) {
            logLine('tool_choice required->auto: ' + finalToolCount + ' tools');
            body.tool_choice = 'auto';
        }
        const historyChars = kept.reduce((total, message) => total + estimateMessageSize(message), 0);
        logLine(`QQ rewrite: in=${messages.length} out=${body.messages.length} tokens=${promptTokens}/${LLM.contextWindowTokens} chars=${system.length} tailChars=${systemTail.length} history=${historyChars} dropped=${history.dropped.length} protected=${history.protectedCount ?? 0} turns=${RECENT_DIALOGUE_TURNS} toolDropped=${history.toolDropped ?? 0} protectedOverflow=${history.protectedOverflow ?? 0} windowDropped=${droppedForWindow} windowProtectedStop=${windowProtectedDropped > 0 ? '1' : '0'} windowBefore=${windowBefore} windowAfter=${windowAfter} windowDroppedTokens=${windowDroppedTokens} systemTruncated=${systemTruncatedFrom > 0 ? '1' : '0'} dedupRemoved=${deduped.removed} dedupSavedTokens=${deduped.savedTokens} maxTokens=${maxTokensRequested > 0 ? maxTokensRequested : '-'}->${body.max_tokens} topSystem=${hadTopSystem} stream=${body.stream === true} tools=${toolsBefore}->${Array.isArray(body.tools) ? body.tools.length : 0} toolsChars=${toolsCharsBefore}->${toolsChars} droppedTools=${droppedToolNames.join('|') || '-'} catalogChars=${catalogChars} enabled=${enabledTools.join('|')} forced=${forced ? 'draw' : '-'} tc=${toolChoiceIn === undefined ? '-' : JSON.stringify(toolChoiceIn)}->${body.tool_choice === undefined ? '-' : JSON.stringify(body.tool_choice)} names=${toolNames} mem=${memoryEntries.length} tasks=${taskDoc.tasks.filter(task => task.status === 'active').length} images=${imageParts.converted}+${imageParts.lost}lost scene=${scene.sceneKey} fallback=${scene.sceneFallback ? '1' : '0'} filtered=${memoryFiltered.length} summaryChars=${compaction.text.length} summaryInjected=${summaryInjected ? '1' : '0'} ctxState=${ctxStateText !== '' ? '1' : '0'} ctxAgeSec=${ctxStateNow.ageMs < 0 ? '-' : Math.round(ctxStateNow.ageMs / 1000)} droppedUsers=${droppedIdentity.userMessages} droppedUnknown=${droppedIdentity.unknown} droppedSystem=${droppedIdentity.system} droppedForwardLine=${droppedIdentity.forwardLine}`);
        // 注入明细写 memory-access.jsonl：可追溯“这条记忆为什么出现在这轮”。
        logMemoryAccess({
            ts: new Date().toISOString(),
            sceneKey: scene.sceneKey,
            sceneFallback: scene.sceneFallback,
            speakerQq: speaker?.qq ?? '',
            queryHash: createHash('sha256').update(queryText).digest('hex').slice(0, 12),
            injected: memoryEntries.map(entry => ({
                id: entry.id,
                audience: entry.visibility?.audience ?? 'scene',
                originScene: entry.origin?.sceneKey ?? 'legacy',
                originAt: entry.origin?.at ?? null,
                score: memoryScores?.[entry.id] ?? null,
            })),
            filtered: memoryFiltered.map(item => ({ id: item.id, audience: item.audience, reason: item.reason })),
        });
        // 引擎 session 槽位标识：优先宿主透传的会话 id，其次场景标记；
        // 旧插件两个都没有时留空（不发头），避免多群误共用同一缓存槽。
        const hostSession = typeof req.headers['x-session-id'] === 'string' ? req.headers['x-session-id'] : '';
        const engineSession = hostSession !== ''
            ? hostSession
            : (scene.sceneFallback ? '' : scene.sceneKey);
        // 两段式的分析腿：请求 = 刚刚组装好的 messages 原样 + 末尾一条解析指令。
        // 回复请求 = 同样的 messages + 末尾追加的解析结果，所以分析腿的
        // system + 历史 是回复请求的严格前缀；引擎处理完分析腿后，回复腿
        // 只需要 prefill 末尾那一小段，不再把同一段 prompt 重算一遍。
        // 但这一腿要多占一份 KV，下面三种情况直接跳过，只走回复腿：
        //   ① 本轮带图（视觉 token 本来就贵，再叠一份就是自己挤自己）
        //   ② 刚吃过池子 429（冷却期内让路）
        //   ③ prompt 已经超过解析腿预算（窗口的 60%，至少 analyzeMaxPromptTokens）
        const imageTurn = imageContext || lastMessageHasImage(body.messages[body.messages.length - 1]);
        const analysisPromptTokens = body.messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
        let analysisSkip = '';
        const analysisPromptBudget = ANALYSIS_PROMPT_BUDGET;
        if (imageTurn)
            analysisSkip = 'image turn';
        else if (Date.now() < poolBusyUntil)
            analysisSkip = 'pool cooldown ' + Math.ceil((poolBusyUntil - Date.now()) / 1000) + 's';
        else if (analysisPromptTokens > analysisPromptBudget)
            analysisSkip = 'prompt too big (' + analysisPromptTokens + ' tokens > ' + analysisPromptBudget + ')';
        const analysisStarted = Date.now();
        const analysis = analysisSkip === '' ? await analyzeTurn(meta, body.messages, body.tools) : undefined;
        if (analysisSkip !== '')
            logLine('analysis leg skipped: ' + analysisSkip);
        if (analysis !== undefined) {
            const section = analysisText(meta, analysis);
            if (section !== '') {
                const block = '【语义解析·后台参考，不是对方发言，不要复述】\n' + section;
                const tail = body.messages[body.messages.length - 1];
                if (tail?.role === 'user')
                    appendTextToMessage(tail, '\n\n' + block);
                else
                    body.messages.push({ role: 'user', content: block });
            }
            logLine('analysis leg: sharedPrefixMsgs=' + body.messages.length + ' msg, ' + (Date.now() - analysisStarted) + 'ms');
        }
        await forwardQQReply(req, res, body, kept, lastUserIndex, forced, drawActivityAfterUser, hideReviewTalk, imageContext, engineSession, {
            chatId: scene.chatId ?? scene.sceneKey ?? '',
            chatKind: scene.chatKind ?? '',
            traceId: latestTraceId(messages),
            source: sourceInfo.source,
        });
        return;
    }

    forward(req, res, undefined);
});

server.on('error', error => {
    logLine('server error: ' + (error instanceof Error ? error.message : String(error)));
    console.error('[qq-persona-proxy]', error);
    process.exitCode = 1;
});

// 工具契约闸在 listen 之前：lint 不通过就不对外提供服务，避免带缺陷的工具上线。
await assertToolContracts();

server.listen(LISTEN_PORT, '127.0.0.1', () => {
    console.log(`[qq-persona-proxy] listening 127.0.0.1:${LISTEN_PORT} -> ${LLM.baseUrl} model=${LLM.model}`);
    logLine(`listening ${LISTEN_PORT} -> ${LLM.baseUrl} model=${LLM.model} engine=${LLM.engine}`);
    // 闸门是环境变量开关，光看代码不知道线上到底开没开；启动时打一行，省得靠猜。
    logLine('gate: enabled=' + String(GATE_ENABLED)
        + ' hard=' + String(gateHardEnabled())
        + ' cfg=' + GATE_CONFIG_PATH
        + ' groups=[' + [...GATE_GROUPS].join(',') + ']'
        + ' turnBudget=' + turnBudgetLimit()
        + ' loopGuard=' + loopGuardLimit()
        + ' deferSweep=' + String(DEFER_SWEEP_MS) + 'ms');
    // 群状态压缩的轮询也归调度器统一驱动（不再自己开 1s setInterval）。
    contextCompressor.start({ pollMs: 0 });
    void assertModelRoute();
    scheduler.start();
});

for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => server.close(() => process.exit(0)));

// 以前一个没人 catch 的 Promise 或同步异常就能把整个代理带走，
// 群聊直接断线。这里至少把现场写进日志，并让进程继续扛着。
process.on('unhandledRejection', reason => {
    logLine('unhandledRejection: ' + (reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)));
    console.error('[qq-persona-proxy] unhandledRejection', reason);
});
process.on('uncaughtException', error => {
    logLine('uncaughtException: ' + (error instanceof Error ? (error.stack ?? error.message) : String(error)));
    console.error('[qq-persona-proxy] uncaughtException', error);
});
