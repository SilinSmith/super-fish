/**
 * 水群模式（群内主动接话）共享模块。
 *
 * 职责边界：
 *   - 只决定「这一条群消息要不要主动接」，不绕过下游客服链：静默、清洗、
 *     审校、权限、防重复、@ 对象判定全部照旧。
 *   - 开关只认主人；非主人下指令不改状态，只记 water:denied。
 *   - 状态落 water-state.json；判定与节流参数读 config.json 的 default.water，
 *     免打扰时段复用 default.dnd。
 *   - 每次判定都往 shadow.jsonl 追加 mode:"water" 的 decision 行，便于按小时
 *     聚合看噪音。
 *
 * 规则枚举（decision.rule）：
 *   water:open / water:renew / water:close / water:denied
 *   water:expired / water:reply / water:dispatch / water:sent / water:declined
 *   water:chance / water:skip:dnd / water:skip:throttle / water:skip:addressed
 *   water:quiet / water:ignored
 */
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_CONFIG_PATH = 'Y:\\dsh\\home\\qq-onebot-plugin\\config.json';
export const DEFAULT_STATE_PATH = 'Y:\\dsh\\home\\qq-persona\\water-state.json';
const DEFAULT_SHADOW_PATH = 'Y:\\dsh\\home\\qq-onebot-plugin\\logs\\shadow.jsonl';
/** 水群发出去之后，这么久没人接话就算一次「被无视」。 */
const IGNORE_WINDOW_MS = 180_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const WATER_RULES = Object.freeze({
    OPEN: 'water:open',
    RENEW: 'water:renew',
    CLOSE: 'water:close',
    DENIED: 'water:denied',
    EXPIRED: 'water:expired',
    REPLY: 'water:reply',
    DISPATCH: 'water:dispatch',
    SENT: 'water:sent',
    DECLINED: 'water:declined',
    CHANCE: 'water:chance',
    SKIP_DND: 'water:skip:dnd',
    SKIP_THROTTLE: 'water:skip:throttle',
    SKIP_ADDRESSED: 'water:skip:addressed',
    QUIET: 'water:quiet',
    IGNORED: 'water:ignored',
});

export const WATER_DEFAULTS = Object.freeze({
    defaultMinutes: 30,
    maxMinutes: 120,
    chance: 0.25,
    minIntervalSec: 90,
    perHour: 4,
    perDay: 20,
    quietAfterIgnored: 2,
    quietMinutes: 10,
    maxChars: 120,
    ackOnOpen: true,
});

/**
 * 常驻活跃度三档：quiet = 只认 @/回复（现状）；casual/chatty 走同一套水群判定，
 * 但参数常驻生效，不依赖主人临时开启。群级可用对象覆盖任意节流字段。
 */
export const ACTIVITY_LEVELS = Object.freeze(['quiet', 'casual', 'chatty']);
export const ACTIVITY_PRESETS = Object.freeze({
    quiet: { chance: 0, minIntervalSec: 0, perHour: 0, perDay: 0, quietAfterIgnored: 0, quietMinutes: 0 },
    casual: { chance: 0.15, minIntervalSec: 180, perHour: 3, perDay: 12, quietAfterIgnored: 2, quietMinutes: 10 },
    chatty: { chance: 0.5, minIntervalSec: 20, perHour: 10, perDay: 40, quietAfterIgnored: 3, quietMinutes: 10 },
});
/** 水群 + 活跃度叠加时的硬上限：再宽松也不越过，避免配置手滑刷屏。 */
export const ACTIVITY_HARD_LIMITS = Object.freeze({ chance: 0.8, perHour: 30, perDay: 120 });

export const ACTIVITY_RULES = Object.freeze({
    REPLY: 'activity:reply',
    DISPATCH: 'activity:dispatch',
    SENT: 'activity:sent',
    DECLINED: 'activity:declined',
    CHANCE: 'activity:chance',
    SKIP_DND: 'activity:skip:dnd',
    SKIP_THROTTLE: 'activity:skip:throttle',
    SKIP_ADDRESSED: 'activity:skip:addressed',
    QUIET: 'activity:quiet',
    IGNORED: 'activity:ignored',
});

function ruleSet(mode) {
    return typeof mode === 'string' && mode.startsWith('water') ? WATER_RULES : ACTIVITY_RULES;
}

const OPEN_PHRASES = new Set(['水群吧', '开始水群', '来聊天', '继续水', '再水会']);
const CLOSE_PHRASES = new Set(['别水了', '安静', '收工', '散会']);

/** 去掉 @、引用占位和首尾标点/空白，只留下可比较的短语。 */
export function normalizeWaterText(text) {
    return String(text ?? '')
        .replace(/@\d{5,12}/g, '')
        .replace(/\[引用\]/g, '')
        .replace(/^[\s，,。.!！~～…、:：;；]+/u, '')
        .replace(/[\s，,。.!！~～…、:：;；]+$/u, '')
        .trim();
}

/**
 * 解析开关指令。返回 { kind:'open'|'close', minutes:number|null, exact:boolean }
 * 或 null（不是指令）。
 * 精确入口 /water 不需要 @；口语短语由调用方要求「已 @ 机器人」再开放。
 */
export function parseWaterCommand(text) {
    const raw = normalizeWaterText(text);
    if (raw === '')
        return null;
    const lower = raw.toLowerCase();
    if (/^\/water\s+off$/i.test(raw))
        return { kind: 'close', minutes: null, exact: true };
    if (lower === '/water')
        return { kind: 'open', minutes: null, exact: true };
    const timed = /^\/water\s+(\d{1,3})\s*(?:m|min|mins|分钟)?$/i.exec(raw);
    if (timed !== null)
        return { kind: 'open', minutes: Number(timed[1]), exact: true };
    if (OPEN_PHRASES.has(raw))
        return { kind: 'open', minutes: null, exact: false };
    if (CLOSE_PHRASES.has(raw))
        return { kind: 'close', minutes: null, exact: false };
    return null;
}

function minutesOfDay(stamp, timeZone) {
    try {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: timeZone || 'Asia/Shanghai',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).formatToParts(new Date(stamp));
        const hour = Number(parts.find(part => part.type === 'hour')?.value ?? 0);
        const minute = Number(parts.find(part => part.type === 'minute')?.value ?? 0);
        return (hour % 24) * 60 + minute;
    }
    catch {
        const date = new Date(stamp);
        return date.getHours() * 60 + date.getMinutes();
    }
}

function toMinutes(value) {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? ''));
    return match === null ? null : Number(match[1]) * 60 + Number(match[2]);
}

/** 免打扰时段（支持跨午夜）。start/end 任一为空即视为未配置。 */
export function inDnd(dnd, stamp) {
    if (dnd === undefined || dnd === null)
        return false;
    const start = toMinutes(dnd.start);
    const end = toMinutes(dnd.end);
    if (start === null || end === null || start === end)
        return false;
    const now = minutesOfDay(stamp, dnd.timezone);
    return start < end
        ? now >= start && now < end
        : now >= start || now < end;
}

function hourBucket(stamp, timeZone) {
    try {
        const text = new Intl.DateTimeFormat('sv-SE', {
            timeZone: timeZone || 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            hour12: false,
        }).format(new Date(stamp));
        return text.replace(' ', 'T');
    }
    catch {
        return new Date(stamp).toISOString().slice(0, 13);
    }
}

function hhmm(stamp, timeZone) {
    const minutes = minutesOfDay(stamp, timeZone);
    return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
}

function truncate(text, max) {
    const chars = [...String(text ?? '')];
    return chars.length <= max ? chars.join('') : chars.slice(0, max).join('') + '…';
}

function freshGroupState() {
    return {
        active: false,
        openedAt: null,
        openedBy: null,
        expiresAt: null,
        attempts: [],
        lastAttemptAt: null,
        sentCount: 0,
        declinedCount: 0,
        ignoredStreak: 0,
        quietUntil: null,
        pending: null,
    };
}

function numberOr(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function integerOr(value, fallback) {
    return Number.isInteger(value) ? value : fallback;
}

export function createWaterRuntime(options = {}) {
    const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
    const statePath = options.statePath ?? DEFAULT_STATE_PATH;
    const fixedShadowPath = options.shadowPath;
    const now = options.now ?? (() => Date.now());
    const random = options.random ?? Math.random;
    const log = options.log ?? (() => {});

    let configCache = {
        mtimeMs: -1,
        water: { ...WATER_DEFAULTS },
        dnd: {},
        groups: {},
        shadowPath: fixedShadowPath ?? DEFAULT_SHADOW_PATH,
        timezone: 'Asia/Shanghai',
    };
    let configError = '';
    let state = loadState();
    let seq = 0;

    function readConfig() {
        let stamp;
        try {
            stamp = statSync(configPath).mtimeMs;
        }
        catch (error) {
            if (configError !== 'stat') {
                configError = 'stat';
                log('warn', '水群配置读取失败，沿用上一次参数: ' + (error?.message ?? String(error)));
            }
            return configCache;
        }
        if (stamp === configCache.mtimeMs)
            return configCache;
        try {
            const raw = JSON.parse(readFileSync(configPath, 'utf8'));
            const waterRaw = raw?.default?.water ?? {};
            const water = {
                defaultMinutes: integerOr(waterRaw.defaultMinutes, WATER_DEFAULTS.defaultMinutes),
                maxMinutes: integerOr(waterRaw.maxMinutes, WATER_DEFAULTS.maxMinutes),
                chance: numberOr(waterRaw.chance, WATER_DEFAULTS.chance),
                minIntervalSec: integerOr(waterRaw.minIntervalSec, WATER_DEFAULTS.minIntervalSec),
                perHour: integerOr(waterRaw.perHour, WATER_DEFAULTS.perHour),
                perDay: integerOr(waterRaw.perDay, WATER_DEFAULTS.perDay),
                quietAfterIgnored: integerOr(waterRaw.quietAfterIgnored, WATER_DEFAULTS.quietAfterIgnored),
                quietMinutes: integerOr(waterRaw.quietMinutes, WATER_DEFAULTS.quietMinutes),
                maxChars: integerOr(waterRaw.maxChars, WATER_DEFAULTS.maxChars),
                ackOnOpen: typeof waterRaw.ackOnOpen === 'boolean' ? waterRaw.ackOnOpen : WATER_DEFAULTS.ackOnOpen,
            };
            if (water.defaultMinutes > water.maxMinutes)
                water.defaultMinutes = water.maxMinutes;
            configCache = {
                mtimeMs: stamp,
                water,
                dnd: raw?.default?.dnd ?? {},
                groups: raw?.groups !== null && typeof raw?.groups === 'object' ? raw.groups : {},
                shadowPath: fixedShadowPath
                    ?? (typeof raw?.shadow?.path === 'string' && raw.shadow.path !== '' ? raw.shadow.path : DEFAULT_SHADOW_PATH),
                timezone: typeof raw?.default?.dnd?.timezone === 'string' && raw.default.dnd.timezone !== ''
                    ? raw.default.dnd.timezone
                    : 'Asia/Shanghai',
            };
            configError = '';
        }
        catch (error) {
            if (configError !== 'parse') {
                configError = 'parse';
                log('warn', '水群配置解析失败，沿用上一次参数: ' + (error?.message ?? String(error)));
            }
        }
        return configCache;
    }

    function loadState() {
        try {
            if (!existsSync(statePath))
                return { version: 1, groups: {} };
            const raw = JSON.parse(readFileSync(statePath, 'utf8'));
            if (raw === null || typeof raw !== 'object' || typeof raw.groups !== 'object' || raw.groups === null)
                return { version: 1, groups: {} };
            return { version: 1, groups: raw.groups };
        }
        catch (error) {
            log('warn', '水群状态读取失败，按空状态启动: ' + (error?.message ?? String(error)));
            return { version: 1, groups: {} };
        }
    }

    function saveState() {
        try {
            mkdirSync(dirname(statePath), { recursive: true });
            const tmp = statePath + '.tmp';
            writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
            renameSync(tmp, statePath);
        }
        catch (error) {
            log('warn', '水群状态写入失败: ' + (error?.message ?? String(error)));
        }
    }

    function groupState(groupId) {
        const key = String(groupId ?? '');
        if (key === '')
            return null;
        if (state.groups[key] === undefined || state.groups[key] === null)
            state.groups[key] = freshGroupState();
        const group = state.groups[key];
        for (const [name, value] of Object.entries(freshGroupState())) {
            if (group[name] === undefined)
                group[name] = value;
        }
        return group;
    }

    function pruneAttempts(group) {
        const cutoff = now() - DAY_MS;
        group.attempts = (Array.isArray(group.attempts) ? group.attempts : [])
            .map(item => Number(item))
            .filter(item => Number.isFinite(item) && item > cutoff)
            .sort((a, b) => a - b);
    }

    function shadow(event) {
        const cfg = readConfig();
        const stamp = event.ts ?? now();
        seq += 1;
        const line = {
            type: 'decision',
            mode: event.mode ?? 'water',
            id: event.id ?? ('water_' + stamp.toString(36) + '_' + seq.toString(36)),
            ts: new Date(stamp).toISOString(),
            hourLocal: hourBucket(stamp, cfg.timezone),
            cfgVersion: 1,
            sceneKey: event.groupId ? 'group:' + event.groupId : '',
            chatId: event.groupId ? 'group:' + event.groupId : '',
            messageIds: event.messageId ? [String(event.messageId)] : [],
            tailMessageId: event.messageId ?? null,
            sender: { qq: event.userId === undefined ? '' : String(event.userId), nickname: event.nickname ?? '' },
            textPreview: truncate(event.text ?? '', 200),
            decision: {
                reply: event.reply === true,
                rule: event.rule,
                reason: event.reason ?? '',
                details: event.details ?? {},
            },
            wouldReply: null,
            legacy: { replied: null },
        };
        try {
            mkdirSync(dirname(cfg.shadowPath), { recursive: true });
            appendFileSync(cfg.shadowPath, JSON.stringify(line) + '\n', 'utf8');
        }
        catch (error) {
            log('warn', '水群影子日志写入失败: ' + (error?.message ?? String(error)));
        }
        return line;
    }

    function waterActive(groupId) {
        const key = String(groupId ?? '');
        const group = state.groups[key];
        // 没有记录就是没开过水群：不要为每条普通群消息建空状态。
        if (group === undefined || group === null || group.active !== true)
            return false;
        const stamp = now();
        if (typeof group.expiresAt === 'number' && stamp >= group.expiresAt) {
            group.active = false;
            group.pending = null;
            saveState();
            shadow({
                groupId,
                rule: WATER_RULES.EXPIRED,
                reason: '水群到时自动退出',
                details: { expiresAt: group.expiresAt },
                ts: stamp,
            });
            return false;
        }
        return true;
    }

    function activityOf(cfg, key) {
        const raw = cfg.groups?.[key]?.activity;
        if (typeof raw === 'string')
            return { level: ACTIVITY_LEVELS.includes(raw) ? raw : 'quiet', overrides: {} };
        if (raw !== null && typeof raw === 'object') {
            const level = ACTIVITY_LEVELS.includes(raw.level) ? raw.level : 'quiet';
            const overrides = {};
            for (const field of ['chance', 'minIntervalSec', 'perHour', 'perDay', 'quietAfterIgnored', 'quietMinutes']) {
                if (typeof raw[field] === 'number' && Number.isFinite(raw[field]))
                    overrides[field] = raw[field];
            }
            return { level, overrides };
        }
        return { level: 'quiet', overrides: {} };
    }

    /** 水群与常驻活跃度叠加时取更宽松的一份，但绝不越过硬上限。 */
    function mergePermissive(activity, water) {
        return clampParams({
            chance: Math.max(activity.chance, water.chance),
            minIntervalSec: Math.min(activity.minIntervalSec, water.minIntervalSec),
            perHour: Math.max(activity.perHour, water.perHour),
            perDay: Math.max(activity.perDay, water.perDay),
            quietAfterIgnored: Math.max(activity.quietAfterIgnored, water.quietAfterIgnored),
            quietMinutes: Math.max(activity.quietMinutes, water.quietMinutes),
            maxChars: water.maxChars,
        });
    }

    function clampParams(params) {
        return {
            ...params,
            chance: Math.min(params.chance, ACTIVITY_HARD_LIMITS.chance),
            perHour: Math.min(params.perHour, ACTIVITY_HARD_LIMITS.perHour),
            perDay: Math.min(params.perDay, ACTIVITY_HARD_LIMITS.perDay),
        };
    }

    /**
     * 当前群该用哪种模式：临时水群优先标注 water；否则看群级 activity。
     * 返回 { mode, params } 或 null（quiet 且没有手动水群 = 保持原 @ 门槛）。
     */
    function resolveMode(groupId) {
        const cfg = readConfig();
        const key = String(groupId ?? '');
        const on = waterActive(key);
        const activity = activityOf(cfg, key);
        const activityParams = activity.level === 'quiet'
            ? null
            : { ...cfg.water, ...ACTIVITY_PRESETS[activity.level], ...activity.overrides };
        if (on) {
            return {
                mode: 'water',
                params: activityParams === null
                    ? { ...cfg.water }
                    : mergePermissive(activityParams, cfg.water),
            };
        }
        // 单一来源不做硬上限裁剪：群级显式配置以配置为准，硬上限只约束「水群 + 活跃度」叠加。
        if (activityParams !== null)
            return { mode: 'activity:' + activity.level, params: activityParams };
        return null;
    }

    function closeState(groupId, details, rule = WATER_RULES.CLOSE) {
        const group = groupState(groupId);
        const wasActive = group.active === true;
        group.active = false;
        group.pending = null;
        group.quietUntil = null;
        group.ignoredStreak = 0;
        saveState();
        shadow({ groupId, rule, reason: details.reason, details: { ...details, wasActive } });
        return wasActive;
    }

    function openState(groupId, minutes, userId, nickname, messageId, text) {
        const cfg = readConfig();
        const requested = Number(minutes);
        const safeMinutes = Number.isFinite(requested) && requested > 0 ? requested : cfg.water.defaultMinutes;
        const capped = Math.max(1, Math.min(safeMinutes, cfg.water.maxMinutes));
        const group = groupState(groupId);
        const renew = group.active === true;
        const stamp = now();
        group.active = true;
        group.openedAt = stamp;
        group.openedBy = String(userId ?? '');
        group.expiresAt = stamp + capped * 60_000; // 不叠加：从当前时刻重新起算
        group.ignoredStreak = 0;
        group.quietUntil = null;
        group.pending = null;
        saveState();
        shadow({
            groupId,
            userId,
            nickname,
            messageId,
            text,
            rule: renew ? WATER_RULES.RENEW : WATER_RULES.OPEN,
            reason: renew ? '主人续期水群' : '主人开启水群',
            details: { minutes: capped, expiresAt: group.expiresAt },
            ts: stamp,
        });
        return { renew, minutes: capped, expiresAt: group.expiresAt };
    }

    function handleCommand({ groupId, chatId, text, userId, isMaster, mentioned, nickname, messageId }) {
        const parsed = parseWaterCommand(text);
        if (parsed === null)
            return { consumed: false, action: 'none', ackText: null };
        const cfg = readConfig();
        if (isMaster !== true) {
            // 精确入口一定消费掉；口语短语只有真的 @ 了机器人才算“下指令”，
            // 否则“安静”这种日常用语会被误吞，影响正常对话。
            if (parsed.exact !== true && mentioned !== true)
                return { consumed: false, action: 'none', ackText: null };
            shadow({
                groupId, userId, nickname, messageId, text,
                rule: WATER_RULES.DENIED,
                reason: '非主人下发的开关指令，已忽略',
                details: { command: parsed.kind },
            });
            return { consumed: true, action: 'denied', ackText: null };
        }
        const timezone = cfg.timezone;
        if (parsed.kind === 'close') {
            closeState(groupId, { reason: '主人要求停止水群', by: String(userId ?? '') });
            return { consumed: true, action: 'close', ackText: '行，不水了。', chatId };
        }
        // 口语短语必须真的 @ 了机器人；精确入口 /water 不要求 @。
        if (!parsed.exact && mentioned !== true)
            return { consumed: false, action: 'none', ackText: null };
        const minutes = parsed.minutes ?? cfg.water.defaultMinutes;
        const opened = openState(groupId, minutes, userId, nickname, messageId, text);
        if (cfg.water.ackOnOpen !== true)
            return { consumed: true, action: opened.renew ? 'renew' : 'open', ackText: null };
        const until = hhmm(opened.expiresAt, timezone);
        return {
            consumed: true,
            action: opened.renew ? 'renew' : 'open',
            ackText: (opened.renew ? '再续一会儿，到 ' : '好，我水一会儿，到 ') + until + '。',
        };
    }

    /** 每条群消息都调用：更新「被无视」计数、记录有人接话。 */
    function observe({ groupId, mentioned }) {
        const resolved = resolveMode(groupId);
        if (resolved === null)
            return;
        const group = state.groups[String(groupId ?? '')];
        if (group === undefined || group === null || group.pending === null)
            return;
        const stamp = now();
        if (mentioned === true) {
            group.ignoredStreak = 0;
            group.pending = null;
            saveState();
            return;
        }
        const pending = group.pending;
        if (pending.settled === true)
            return;
        if (stamp - Number(pending.at ?? 0) < IGNORE_WINDOW_MS)
            return;
        group.ignoredStreak = Number(group.ignoredStreak ?? 0) + 1;
        pending.settled = true;
        const params = resolved.params;
        const mode = pending.mode ?? resolved.mode;
        let quietUntil = null;
        if (group.ignoredStreak >= params.quietAfterIgnored && params.quietMinutes > 0) {
            quietUntil = stamp + params.quietMinutes * 60_000;
            group.quietUntil = quietUntil;
        }
        saveState();
        shadow({
            mode,
            groupId,
            rule: ruleSet(mode).IGNORED,
            reason: '主动接话后没人接，记一次被无视',
            details: {
                ignoredStreak: group.ignoredStreak,
                quietUntil,
                quietMinutes: params.quietMinutes,
            },
            ts: stamp,
        });
    }

    /**
     * 主动接话候选判定（临时水群 + 常驻活跃度共用）。
     * 只在「没 @ 机器人、也不是在回别人」时调用。
     * 返回 { reply, rule, maxChars, mode }；不回复时 rule 说明被哪条规则挡下。
     */
    function consider({ groupId, chatId, text, messageId, userId, nickname, mentioned, addressedElsewhere }) {
        const resolved = resolveMode(groupId);
        if (resolved === null)
            return { reply: false, rule: null };
        if (mentioned === true)
            return { reply: false, rule: null };
        const cfg = readConfig();
        const params = resolved.params;
        const mode = resolved.mode;
        const rules = ruleSet(mode);
        const group = groupState(groupId);
        const stamp = now();
        const base = {
            mode,
            groupId,
            userId,
            nickname,
            messageId,
            text,
            details: {},
            ts: stamp,
        };

        // 有人被 @ / 这条在回别人：绝对不抢答（原有优先级保留）。
        if (addressedElsewhere === true) {
            shadow({
                ...base,
                rule: rules.SKIP_ADDRESSED,
                reason: '这条消息在 @ 或回复别人，不抢答',
            });
            return { reply: false, rule: rules.SKIP_ADDRESSED };
        }
        // 免打扰永远优先于活跃度/水群。
        if (inDnd(cfg.dnd, stamp)) {
            shadow({
                ...base,
                rule: rules.SKIP_DND,
                reason: '处于免打扰时段',
                details: { dnd: cfg.dnd },
            });
            return { reply: false, rule: rules.SKIP_DND };
        }
        if (typeof group.quietUntil === 'number' && stamp < group.quietUntil) {
            shadow({
                ...base,
                rule: rules.QUIET,
                reason: '连续被无视，降温中',
                details: { until: group.quietUntil, ignoredStreak: group.ignoredStreak },
            });
            return { reply: false, rule: rules.QUIET };
        }

        pruneAttempts(group);
        const throttle = (why, details) => {
            shadow({
                ...base,
                rule: rules.SKIP_THROTTLE,
                reason: why,
                details: { ...details, rule: 'throttle' },
            });
            return { reply: false, rule: rules.SKIP_THROTTLE };
        };
        if (params.minIntervalSec > 0
            && typeof group.lastAttemptAt === 'number'
            && stamp - group.lastAttemptAt < params.minIntervalSec * 1000) {
            return throttle('两条主动消息之间间隔太近', {
                minIntervalSec: params.minIntervalSec,
                lastAttemptAt: group.lastAttemptAt,
            });
        }
        if (params.perHour > 0) {
            const hourCount = group.attempts.filter(item => stamp - item < 60 * 60 * 1000).length;
            if (hourCount >= params.perHour)
                return throttle('本小时主动接话次数已达上限', { perHour: params.perHour, hourCount });
        }
        if (params.perDay > 0) {
            const dayCount = group.attempts.filter(item => stamp - item < DAY_MS).length;
            if (dayCount >= params.perDay)
                return throttle('今日主动接话次数已达上限', { perDay: params.perDay, dayCount });
        }
        if (params.chance < 1 && random() >= params.chance) {
            shadow({
                ...base,
                rule: rules.CHANCE,
                reason: '概率未命中',
                details: { chance: params.chance },
            });
            return { reply: false, rule: rules.CHANCE };
        }

        group.attempts.push(stamp);
        group.lastAttemptAt = stamp;
        group.pending = { at: stamp, messageId: messageId ?? null, settled: false, mode };
        saveState();
        shadow({
            ...base,
            reply: true,
            rule: rules.REPLY,
            reason: mode === 'water' ? '命中临时水群接话' : '命中常驻活跃度接话',
            details: {
                chance: params.chance,
                minIntervalSec: params.minIntervalSec,
                perHour: params.perHour,
                perDay: params.perDay,
                maxChars: params.maxChars,
            },
        });
        return { reply: true, rule: rules.REPLY, maxChars: params.maxChars, mode };
    }

    function modeFor(groupId) {
        const group = state.groups[String(groupId ?? '')];
        if (group !== undefined && group !== null && rowMode(group) !== null)
            return rowMode(group);
        const resolved = resolveMode(groupId);
        return resolved === null ? 'water' : resolved.mode;
    }

    function rowMode(group) {
        return group.pending === null || group.pending === undefined
            ? null
            : (group.pending.mode ?? null);
    }

    /** 判定通过、即将投递给模型。 */
    function noteDispatched({ groupId, chatId, messageId, userId, nickname, text }) {
        const mode = modeFor(groupId);
        shadow({
            mode,
            groupId,
            userId,
            nickname,
            messageId,
            text,
            reply: true,
            rule: ruleSet(mode).DISPATCH,
            reason: '主动接话消息已投递给模型',
        });
    }

    /** 真正发出了一条（outbound 调用）；同一轮只记一次。 */
    function noteSent({ groupId, chatId, chars }) {
        const group = groupState(groupId);
        if (group === null)
            return;
        const mode = rowMode(group) ?? modeFor(groupId);
        group.sentCount = Number(group.sentCount ?? 0) + 1;
        if (group.pending !== null)
            group.pending.sentAt = now();
        saveState();
        shadow({
            mode,
            groupId,
            rule: ruleSet(mode).SENT,
            reason: '主动接话消息已发出',
            reply: true,
            details: { chars: chars ?? null, sentCount: group.sentCount },
        });
    }

    /** 模型只回【内心】或空内容：真的不发，记 declined。 */
    function noteDeclined({ groupId, chatId }) {
        const group = groupState(groupId);
        if (group === null)
            return;
        const mode = rowMode(group) ?? modeFor(groupId);
        group.declinedCount = Number(group.declinedCount ?? 0) + 1;
        group.pending = null;
        saveState();
        shadow({
            mode,
            groupId,
            rule: ruleSet(mode).DECLINED,
            reason: '模型选择不说话（【内心】/空回复）',
            details: { declinedCount: group.declinedCount },
        });
    }

    function snapshot(groupId) {
        const group = groupState(groupId);
        return group === null ? null : { ...group, attempts: [...group.attempts] };
    }

    return {
        handleCommand,
        observe,
        consider,
        noteDispatched,
        noteSent,
        noteDeclined,
        snapshot,
        configPath,
        statePath,
    };
}

let singleton = null;

/** 插件进程内共用的单例（inbound 判定 + outbound 记账用同一份状态）。 */
export function getWaterRuntime(options = {}) {
    if (singleton === null)
        singleton = createWaterRuntime(options);
    return singleton;
}
