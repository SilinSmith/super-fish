/**
 * ③ 判定层：去重 → 去抖合批 → 访问 → 免打扰 → 触发 → 概率 → 频次/冷却。
 *
 * 行为对齐旧插件 dsh-onebot-qq 的 bridge.js / inbound.js：
 *   - 群消息必须 @ 机器人、点名字、回复机器人，或主人明确招呼（带 cue/任务词/图片）；
 *   - 数字接龙（222/333…，111 除外）在没人被 @ 时触发；
 *   - 同一人连发按 1200ms（群 2200ms、含图 7000ms）合并成一轮；
 *   - 命中率、每分钟上限与旧插件同基线（30/min）。
 */
import { TRIGGER_MODES } from './config.js';
import { classifySender } from './identity.js';

/** 旧插件原样照抄的两条主人正则（cue + 任务）。 */
export const MASTER_CUE_RE = /(?:在吗|在不在|继续|接着|然后|第二|第三|答案|锐评|评价|你猜|猜猜|看看|说一下|讲讲|不对|错了|不是|重来|重新|[?？]|吗|呢)/u;
export const MASTER_TASK_RE = /(?:做出来|做一下|解题|解答|解一下|计算|求(?:出|解|值|和|导)?|证明|推导|分析|解释|翻译|总结|锐评|评价|写(?:一下|个|段|代码|脚本|函数)?|改(?:一下|改)?|实现|检查|看看|看一下|这道题|题目|答案|步骤|过程|代码)/u;
const DIGIT_CHAIN_RE = /^([0-9])\1{2,5}$/u;
const CQ_CODE_RE = /\[CQ:[^\]]+\]/g;

function trim(text) {
    return String(text ?? '').trim();
}

/** 把 OneBot 消息段拼成旧插件同形的纯文本（含 @QQ、[引用]、[图片]）。 */
export function textOf(inbound) {
    const segments = Array.isArray(inbound.segments) ? inbound.segments : [];
    const parts = [];
    for (const segment of segments) {
        switch (segment?.type) {
        case 'text':
            parts.push(String(segment.text ?? ''));
            break;
        case 'at':
            parts.push(segment.qq === 'all' ? '@全体成员' : '@' + String(segment.qq ?? ''));
            break;
        case 'reply':
            parts.push('[引用]');
            break;
        case 'image':
            parts.push('[图片]');
            break;
        case 'record':
            parts.push('[语音]');
            break;
        case 'video':
            parts.push('[视频]');
            break;
        case 'file':
            parts.push('[文件]');
            break;
        case 'forward':
            parts.push('[合并转发]');
            break;
        default:
            break;
        }
    }
    let text = parts.join('').trim();
    if (text === '' && typeof inbound.raw === 'string')
        text = inbound.raw.replace(CQ_CODE_RE, ' ').replace(/\s+/g, ' ').trim();
    return text;
}

export function hasImage(inbound) {
    return (Array.isArray(inbound.segments) ? inbound.segments : [])
        .some(segment => segment?.type === 'image');
}

export function hasForward(inbound) {
    return (Array.isArray(inbound.segments) ? inbound.segments : [])
        .some(segment => segment?.type === 'forward');
}

/**
 * 旧插件 isInboundAddressed 的等价实现：
 * 群消息 @ 机器人 / 点名字 / 回复机器人 / 主人明确招呼才算 addressed。
 */
export function isAddressed(inbound, cfg, bot) {
    if (inbound.chatType !== 'group')
        return true;
    const selfId = String(bot?.qq ?? inbound.selfId ?? '');
    const atTargets = (Array.isArray(inbound.segments) ? inbound.segments : [])
        .filter(segment => segment?.type === 'at')
        .map(segment => String(segment.qq ?? ''))
        .filter(id => id !== '');
    if (selfId !== '' && atTargets.some(id => id === selfId || id === 'all'))
        return true;
    const text = textOf(inbound);
    const names = Array.isArray(cfg.trigger.mentionNames) ? cfg.trigger.mentionNames : [];
    if (names.some(name => name !== '' && text.includes(name)))
        return true;
    // 机器人账号不走主人快捷通道，即便配置里误把机器人写成 masterQQ。
    const master = classifySender({ userId: inbound.userId, selfId: selfId ?? cfg.bot.qq, cfg }).isMaster;
    if (master) {
        const cue = MASTER_TASK_RE.test(text) || MASTER_CUE_RE.test(text) || hasImage(inbound);
        if (!cue)
            return false;
        return !atTargets.some(id => id !== 'all' && id !== selfId);
    }
    return false;
}

/** 数字接龙：222/333… 触发，111 除外；有人被 @ 时不触发。 */
export function isBanter(inbound, cfg) {
    if (inbound.chatType !== 'group')
        return false;
    if (cfg.trigger.banter !== true)
        return false;
    const text = textOf(inbound).trim();
    if (text === '111' || !DIGIT_CHAIN_RE.test(text))
        return false;
    const selfId = String(inbound.selfId ?? '');
    const atTargets = (Array.isArray(inbound.segments) ? inbound.segments : [])
        .filter(segment => segment?.type === 'at')
        .map(segment => String(segment.qq ?? ''))
        .filter(id => id !== '');
    return !atTargets.some(id => id !== 'all' && id !== selfId);
}

function localMinutes(now, timeZone) {
    try {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).formatToParts(now);
        const hour = Number(parts.find(part => part.type === 'hour')?.value ?? '0') % 24;
        const minute = Number(parts.find(part => part.type === 'minute')?.value ?? '0');
        return hour * 60 + minute;
    }
    catch {
        return now.getHours() * 60 + now.getMinutes();
    }
}

/** 免打扰：支持跨零点；start/end 为空表示关闭。 */
export function inDnd(dnd, now) {
    if (dnd === undefined || dnd.start === '' || dnd.end === '')
        return false;
    const toMinutes = value => {
        const [hour, minute] = value.split(':').map(Number);
        return hour * 60 + minute;
    };
    const start = toMinutes(dnd.start);
    const end = toMinutes(dnd.end);
    const current = localMinutes(now, dnd.timezone || 'Asia/Shanghai');
    return start <= end
        ? current >= start && current < end
        : current >= start || current < end;
}

/** 访问控制：deny 优先；私聊与群各用自己的策略。 */
export function accessAllowed(inbound, cfg) {
    const access = cfg.access;
    const userId = String(inbound.userId);
    const groupId = String(inbound.groupId ?? inbound.chatId);
    if (access.denyUsers.includes(userId))
        return { ok: false, rule: 'access:deny-user', reason: '用户在黑名单' };
    if (access.denyGroups.includes(groupId))
        return { ok: false, rule: 'access:deny-group', reason: '群在黑名单' };

    if (inbound.chatType === 'dm') {
        if (access.dmPolicy === 'disabled')
            return { ok: false, rule: 'access:dm-disabled', reason: '私聊已禁用' };
        if (access.dmPolicy === 'allowlist' && !access.allowUsers.includes(userId))
            return { ok: false, rule: 'access:dm-allowlist', reason: '用户不在私聊白名单' };
        if (access.dmPolicy === 'open'
            && !access.allowAll
            && !access.allowUsers.includes(userId)
            && userId !== String(cfg.bot.masterQQ))
            return { ok: false, rule: 'access:dm-open', reason: '私聊开放但未放行该用户' };
        return { ok: true };
    }

    if (access.groupPolicy === 'disabled')
        return { ok: false, rule: 'access:group-disabled', reason: '群聊已禁用' };
    if (access.groupPolicy === 'allowlist' && !access.allowGroups.includes(groupId))
        return { ok: false, rule: 'access:group-allowlist', reason: '群不在白名单' };
    return { ok: true };
}

export function createPolicy({ log, now = () => new Date(), rng = Math.random, resolveReplyTarget } = {}) {
    const dedupSeen = new Map();
    const batches = new Map();
    const limits = new Map();

    function note(level, message, data) {
        try {
            log?.(level, message, data);
        }
        catch {
            // ignore
        }
    }

    function dedup(inbound, windowSec) {
        if (inbound.messageId === null || inbound.messageId === undefined)
            return false;
        const key = inbound.chatId + '#' + inbound.messageId;
        const at = now().getTime();
        const prior = dedupSeen.get(key);
        if (prior !== undefined && at - prior < windowSec * 1000)
            return true;
        dedupSeen.set(key, at);
        if (dedupSeen.size > 4096) {
            const cutoff = at - windowSec * 1000;
            for (const [item, ts] of dedupSeen) {
                if (ts < cutoff)
                    dedupSeen.delete(item);
            }
            if (dedupSeen.size > 4096) {
                const overflow = dedupSeen.size - 4096;
                let index = 0;
                for (const item of dedupSeen.keys()) {
                    if (index >= overflow)
                        break;
                    dedupSeen.delete(item);
                    index += 1;
                }
            }
        }
        return false;
    }

    function shouldDebounce(inbound, cfg) {
        if (cfg.debounce.enabled !== true)
            return false;
        if (inbound.userId === String(cfg.bot.qq))
            return false;
        if (inbound.replyTo !== null && inbound.replyTo !== undefined)
            return false;
        if (hasForward(inbound))
            return false;
        if (/^\s*\//.test(textOf(inbound)))
            return false;
        return true;
    }

    function mergedText(entries, latest) {
        if (entries.length <= 1)
            return textOf(latest);
        const prior = entries.slice(0, -1).map((item, index) => {
            const label = item.chatType === 'group'
                ? '[' + item.nickname + '(' + item.userId + ')] '
                : '';
            return (index + 1) + '. ' + label + textOf(item);
        });
        return '【连续消息】同一人短时间发来 ' + entries.length
            + ' 条，先结合全部内容理解，再只回一次，不要逐条回复：\n'
            + prior.join('\n')
            + '\n最后一条：' + textOf(latest);
    }

    function makeBatch(entries, cfg) {
        const latest = entries[entries.length - 1];
        return {
            entries,
            kind: latest.chatType,
            chatId: latest.chatId,
            groupId: latest.groupId,
            userId: latest.userId,
            nickname: latest.nickname,
            messageIds: entries.map(item => item.messageId).filter(id => id !== null),
            tailMessageId: latest.messageId,
            atMe: entries.some(item => {
                const selfId = String(item.selfId ?? '');
                return (Array.isArray(item.segments) ? item.segments : [])
                    .some(segment => segment?.type === 'at' && (segment.qq === selfId || segment.qq === 'all'));
            }),
            text: mergedText(entries, latest),
            hasImage: entries.some(hasImage),
            segments: latest.segments,
            raw: latest.raw,
            time: latest.time,
            sample: latest.sample === true,
            cfgVersion: cfg.cfgVersion,
        };
    }

    function enqueue(inbound, cfg, onBatch) {
        const key = inbound.chatId + '#' + inbound.userId;
        const prior = batches.get(key);
        if (prior?.timer !== undefined)
            clearTimeout(prior.timer);
        const entries = [...(prior?.entries ?? []), inbound].slice(-cfg.debounce.maxBatch);
        const delay = hasImage(inbound)
            ? Math.max(cfg.debounce.baseMs, cfg.debounce.imageMs)
            : inbound.chatType === 'group'
                ? Math.max(cfg.debounce.baseMs, cfg.debounce.groupMs)
                : cfg.debounce.baseMs;
        const entry = {
            entries,
            timer: setTimeout(() => {
                batches.delete(key);
                try {
                    onBatch(makeBatch(entries, cfg));
                }
                catch (error) {
                    note('error', '去抖批次派发失败', { error: error?.stack ?? String(error) });
                }
            }, delay),
        };
        entry.timer.unref?.();
        batches.set(key, entry);
    }

    async function resolveReply(inbound, cfg) {
        if (inbound.replyTo === null || inbound.replyTo === undefined)
            return { target: undefined, error: null };
        // 样例回放的 replyTo 是编的 id（900001/900002），不许拿它去查真实 get_msg。
        if (inbound.sample === true)
            return { target: undefined, error: 'sample: 回放不访问真实消息接口' };
        if (cfg.trigger.replyToBot !== true)
            return { target: undefined, error: null };
        if (typeof resolveReplyTarget !== 'function')
            return { target: undefined, error: '未接入 get_msg' };
        try {
            const target = await resolveReplyTarget(inbound.replyTo);
            return { target: target === undefined ? undefined : String(target), error: null };
        }
        catch (error) {
            return { target: undefined, error: error?.message ?? String(error) };
        }
    }

    function checkLimits(chatId, cfg) {
        const nowMs = now().getTime();
        const state = limits.get(chatId) ?? { minute: [], hour: [], day: [], lastAt: 0 };
        state.minute = state.minute.filter(ts => nowMs - ts < 60_000);
        state.hour = state.hour.filter(ts => nowMs - ts < 3_600_000);
        state.day = state.day.filter(ts => nowMs - ts < 86_400_000);
        const limit = cfg.limits;
        if (limit.cooldownSec > 0 && state.lastAt > 0 && nowMs - state.lastAt < limit.cooldownSec * 1000) {
            limits.set(chatId, state);
            return { ok: false, rule: 'limit:cooldown', reason: '冷却中（' + limit.cooldownSec + 's）' };
        }
        if (limit.perMinute > 0 && state.minute.length >= limit.perMinute) {
            limits.set(chatId, state);
            return { ok: false, rule: 'limit:minute', reason: '超过每分钟上限 ' + limit.perMinute };
        }
        if (limit.perHour > 0 && state.hour.length >= limit.perHour) {
            limits.set(chatId, state);
            return { ok: false, rule: 'limit:hour', reason: '超过每小时上限 ' + limit.perHour };
        }
        if (limit.perDay > 0 && state.day.length >= limit.perDay) {
            limits.set(chatId, state);
            return { ok: false, rule: 'limit:day', reason: '超过每天上限 ' + limit.perDay };
        }
        state.minute.push(nowMs);
        state.hour.push(nowMs);
        state.day.push(nowMs);
        state.lastAt = nowMs;
        limits.set(chatId, state);
        return { ok: true };
    }

    function reject(cfg, rule, reason, details = {}) {
        return { reply: false, rule, reason, details, cfgVersion: cfg.cfgVersion };
    }

    /**
     * 对一批消息做判定。返回 Promise<Decision>。
     * 注意：即使 reply=false，details 也保留事实位，便于影子比对。
     */
    async function decide(batch, cfg) {
        if (!TRIGGER_MODES.includes(cfg.trigger.mode))
            return reject(cfg, 'config:mode', '触发模式非法');

        const dnd = inDnd(cfg.dnd, now());
        if (dnd)
            return reject(cfg, 'dnd', '免打扰时段');

        const access = accessAllowed({
            chatType: batch.kind,
            userId: batch.userId,
            groupId: batch.groupId,
            chatId: batch.chatId,
        }, cfg);
        if (!access.ok)
            return reject(cfg, access.rule, access.reason);

        const latest = batch.entries[batch.entries.length - 1];
        const selfId = String(latest.selfId ?? '');
        const atTargets = (Array.isArray(batch.segments) ? batch.segments : [])
            .filter(segment => segment?.type === 'at')
            .map(segment => String(segment.qq ?? ''))
            .filter(id => id !== '');
        const atOthers = atTargets.some(id => id !== 'all' && id !== selfId);
        const reply = await resolveReply(latest, cfg);
        const replyToBot = reply.target !== undefined && reply.target === selfId;
        const replyToOther = reply.target !== undefined && reply.target !== selfId;
        const addressedElsewhere = atOthers || replyToOther;

        const nameHit = (cfg.trigger.mentionNames ?? [])
            .some(name => name !== '' && batch.text.includes(name));
        const masterCue = MASTER_TASK_RE.test(batch.text)
            || MASTER_CUE_RE.test(batch.text)
            || batch.hasImage;
        const masterBypass = classifySender({ userId: batch.userId, selfId: cfg.bot.qq, cfg }).isMaster
            && !addressedElsewhere
            && !(batch.kind === 'group' && DIGIT_CHAIN_RE.test(textOf(latest).trim()))
            && masterCue;

        const digitText = textOf(latest).trim();
        const digitChain = DIGIT_CHAIN_RE.test(digitText) && digitText !== '111';
        const banter = batch.kind === 'group'
            && cfg.trigger.banter === true
            && digitChain
            && !addressedElsewhere;

        const addressed = batch.kind === 'group'
            && (batch.atMe || nameHit || replyToBot || masterBypass);

        const details = {
            addressed,
            atMe: batch.atMe,
            nameHit,
            replyToBot,
            replyToOther,
            masterBypass,
            digitChain,
            banter,
            atOthers,
            replyResolveError: reply.error,
        };

        let triggered = false;
        let rule = '';
        let reason = '';

        if (batch.kind === 'dm') {
            const mode = cfg.trigger.mode;
            if (mode === 'keyword') {
                const hit = (cfg.trigger.keywords ?? []).find(word => word !== '' && batch.text.includes(word));
                if (hit !== undefined) {
                    triggered = true;
                    rule = 'keyword:' + hit;
                    reason = '命中关键词「' + hit + '」';
                }
                else {
                    reason = '私聊关键词未命中';
                }
            }
            else if (mode === 'regex') {
                if (cfg.trigger.regex === '' || new RegExp(cfg.trigger.regex).test(batch.text)) {
                    triggered = true;
                    rule = 'regex';
                    reason = cfg.trigger.regex === '' ? '私聊（正则为空，放行）' : '命中正则';
                }
                else {
                    reason = '私聊正则未命中';
                }
            }
            else if (mode === 'random') {
                if (rng() < cfg.trigger.chance) {
                    triggered = true;
                    rule = 'random';
                    reason = '随机命中（' + cfg.trigger.chance + '）';
                }
                else {
                    reason = '私聊随机未命中';
                }
            }
            else {
                triggered = true;
                rule = 'dm:always';
                reason = '私聊消息';
            }
        }
        else if (addressed) {
            triggered = true;
            if (batch.atMe)
                rule = 'at:segment';
            else if (nameHit)
                rule = 'at:name';
            else if (replyToBot)
                rule = 'reply:bot';
            else
                rule = 'master:cue';
            reason = '消息直接指向机器人（' + rule + '）';
        }
        else if (banter) {
            triggered = true;
            rule = 'banter:digit';
            reason = '数字接龙';
        }
        else {
            const mode = cfg.trigger.mode;
            if (mode === 'keyword') {
                const hit = (cfg.trigger.keywords ?? []).find(word => word !== '' && batch.text.includes(word));
                if (hit !== undefined) {
                    triggered = true;
                    rule = 'keyword:' + hit;
                    reason = '命中关键词「' + hit + '」';
                }
            }
            else if (mode === 'regex' && cfg.trigger.regex !== '') {
                if (new RegExp(cfg.trigger.regex).test(batch.text)) {
                    triggered = true;
                    rule = 'regex';
                    reason = '命中正则';
                }
            }
            else if (mode === 'random') {
                if (rng() < cfg.trigger.chance) {
                    triggered = true;
                    rule = 'random';
                    reason = '随机命中（' + cfg.trigger.chance + '）';
                }
            }
            else if (mode === 'always') {
                triggered = true;
                rule = 'always';
                reason = '全量触发';
            }
            else if (mode === 'reply') {
                reason = '未回复机器人';
            }
            else {
                reason = '未 @、未点名、未回复机器人';
            }
        }

        if (!triggered)
            return reject(cfg, 'no:' + cfg.trigger.mode, reason || '未触发', details);

        if (cfg.replyChance < 1 && rng() >= cfg.replyChance)
            return reject(cfg, 'chance', '触发后概率未通过（' + cfg.replyChance + '）', details);

        const limited = checkLimits(batch.chatId, cfg);
        if (!limited.ok)
            return reject(cfg, limited.rule, limited.reason, details);

        return { reply: true, rule, reason, details, cfgVersion: cfg.cfgVersion };
    }

    return {
        /** 去重 + 去抖；返回 'duplicate' | 'debounced' | 'immediate' | 'ignored'。 */
        ingest(inbound, cfg, onBatch) {
            if (inbound?.postType !== 'message')
                return 'ignored';
            if (String(inbound.userId) === String(cfg.bot.qq))
                return 'self';
            if (dedup(inbound, cfg.dedupWindowSec))
                return 'duplicate';
            if (shouldDebounce(inbound, cfg)) {
                enqueue(inbound, cfg, onBatch);
                return 'debounced';
            }
            try {
                onBatch(makeBatch([inbound], cfg));
            }
            catch (error) {
                note('error', '即时批次派发失败', { error: error?.stack ?? String(error) });
            }
            return 'immediate';
        },
        decide,
        textOf,
        isAddressed: (inbound, cfg) => isAddressed(inbound, cfg, cfg.bot),
        isBanter: (inbound, cfg) => isBanter(inbound, cfg),
        stop() {
            for (const entry of batches.values()) {
                if (entry.timer !== undefined)
                    clearTimeout(entry.timer);
            }
            batches.clear();
        },
        stats() {
            return {
                pendingBatches: batches.size,
                dedupEntries: dedupSeen.size,
                rateChats: limits.size,
            };
        },
    };
}
