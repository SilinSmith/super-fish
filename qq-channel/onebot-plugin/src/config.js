/**
 * ② 配置层：单文件、三层合并（default → groups[群号] → dm）、整份校验、热重载。
 *
 * 设计约束：
 *   - 没有任何 persona/tone 字段；人格只来自 proxy。
 *   - 群级只允许行为字段，出现 persona/tone 视为配置错误。
 *   - 热重载要么整份换、要么整份不动；坏配置保留上一份并追加 config-error.log。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { applyCordisAccess, cordisAccessSource } from './cordis-access.js';
// 预算常量只从 harness/proxy/llm-config.mjs 取，本插件不再自带一份数字。
import { BUDGET } from '../../../harness/proxy/llm-config.mjs';

export const TRIGGER_MODES = ['at', 'keyword', 'regex', 'random', 'reply', 'always'];
const ACCESS_POLICIES = ['allowlist', 'open', 'disabled'];
const GROUP_BEHAVIOR_KEYS = new Set([
    'trigger', 'replyChance', 'limits', 'dnd', 'review', 'access', 'context', 'activity', 'judge',
]);
export const ACTIVITY_LEVELS = ['quiet', 'casual', 'chatty'];

/** 默认值基线对齐旧插件：每分钟 30 条、群默认 @、私聊 always。 */
export const DEFAULTS = {
    version: 1,
    bot: {
        qq: '10001',
        // 主人只允许人工显式声明；不做任何自动推断、迁移或默认兜底。
        masterQQ: '10000',
        // 管理员（人工显式声明，默认空）。管理员能下指令，但归属表态不豁免。
        adminUsers: [],
        // 已知机器人账号（人工维护）。这些号永远不能触发主人级指令。
        knownBots: ['10001'],
    },
    runtime: {
        cwd: 'Y:\\dsh\\home\\qq-onebot-plugin\\shadow',
        provider: 'ninfer',
        model: 'bonsai-2-27b',
        agentPreset: '',
        turnTimeoutMs: 120000,
        agentIdleMs: 1800000,
    },
    debounce: {
        enabled: true,
        baseMs: 1200,
        groupMs: 2200,
        imageMs: 7000,
        maxBatch: 8,
    },
    dedupWindowSec: 300,
    default: {
        trigger: {
            mode: 'at',
            keywords: [],
            regex: '',
            chance: 1.0,
            replyToBot: true,
            mentionNames: ['小助手', '助手', 'helper'],
            banter: true,
        },
        replyChance: 1.0,
        limits: { perMinute: 30, perHour: 0, perDay: 0, cooldownSec: 0 },
        dnd: { start: '', end: '', timezone: 'Asia/Shanghai' },
        review: true,
        // 水群模式：主人显式开启后，只放宽「是否该回」，静默/清洗/审校/权限不变。
        water: {
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
        },
        // 判定器：白名单群不再要求 @，每条普通消息由模型判定说或不说。
        // 只做合并窗口与熔断，不做配额/概率。
        judge: {
            enabled: true,
            groups: ['100000002', '100000001'],
            mergeWindowMs: 5000,
            timeoutMs: 3000,
            queueLimit: 3,
            maxChars: 120,
        },
        // 状态机：专注度 >= realtimeFocusAt 走实时，否则进延迟队列。
        presence: {
            enabled: true,
            focusHalfLifeHours: 3,
            heatHalfLifeHours: 2,
            realtimeFocusAt: 60,
            silenceTiredAfter: 2,
        },
        // 关系类记忆：0-100，50 中性，单次最多 ±3，30 天半衰期回归 50。
        memory: {
            relation: {
                neutral: 50,
                maxDelta: 3,
                halfLifeDays: 30,
            },
        },
        // 延迟队列：低专注时攒批，默认沉默，过期丢弃。
        batch: {
            ttlMin: 30,
            sizeLimit: 8,
            maxWaitMin: 10,
            idleMin: 10,
            followupCooldownMin: 360,
        },
        access: {
            allowAll: false,
            dmPolicy: 'allowlist',
            allowUsers: [],
            denyUsers: [],
            groupPolicy: 'allowlist',
            allowGroups: [],
            denyGroups: [],
        },
        context: { budgetTokens: BUDGET.dshHistoryTokens, maxMessages: 56 },
    },
    groups: {},
    dm: {
        trigger: { mode: 'always' },
        review: false,
    },
    shadow: {
        enabled: true,
        path: 'Y:\\dsh\\home\\qq-onebot-plugin\\logs\\shadow.jsonl',
        dryRunModel: true,
        observeReplyMs: 45000,
        maxReplyChars: 4000,
    },
    samples: {
        enabled: false,
        path: 'Y:\\dsh\\2026-11-11\\onebot-plugin\\work\\samples.jsonl',
        delayMs: 20000,
        once: true,
    },
    security: {
        enabled: true,
        path: 'Y:\\dsh\\home\\qq-onebot-plugin\\logs\\security.jsonl',
    },
};

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 深合并：对象递归，数组整体替换（配置语义：不拼接白名单）。 */
export function deepMerge(base, override) {
    if (!isPlainObject(override))
        return clone(base);
    const out = clone(base);
    for (const [key, value] of Object.entries(override)) {
        if (isPlainObject(value) && isPlainObject(out[key]))
            out[key] = deepMerge(out[key], value);
        else
            out[key] = clone(value);
    }
    return out;
}

export function clone(value) {
    if (Array.isArray(value))
        return value.map(item => clone(item));
    if (isPlainObject(value)) {
        const out = {};
        for (const [key, item] of Object.entries(value))
            out[key] = clone(item);
        return out;
    }
    return value;
}

function isDigits(value, min = 5, max = 12) {
    return typeof value === 'string' && new RegExp('^\\d{' + min + ',' + max + '}$').test(value);
}

function isNonNegativeInt(value) {
    return Number.isInteger(value) && value >= 0;
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function validateTrigger(trigger, label, errors) {
    if (!isPlainObject(trigger)) {
        errors.push(label + '.trigger 必须是对象');
        return;
    }
    if (!TRIGGER_MODES.includes(trigger.mode))
        errors.push(label + '.trigger.mode 非法: ' + String(trigger.mode));
    if (!Array.isArray(trigger.keywords) || trigger.keywords.some(item => typeof item !== 'string'))
        errors.push(label + '.trigger.keywords 必须是字符串数组');
    if (typeof trigger.regex !== 'string')
        errors.push(label + '.trigger.regex 必须是字符串');
    else if (trigger.regex !== '') {
        try {
            new RegExp(trigger.regex);
        }
        catch (error) {
            errors.push(label + '.trigger.regex 无法编译: ' + (error?.message ?? String(error)));
        }
    }
    if (typeof trigger.chance !== 'number' || !(trigger.chance >= 0 && trigger.chance <= 1))
        errors.push(label + '.trigger.chance 必须在 [0,1]');
    if (typeof trigger.replyToBot !== 'boolean')
        errors.push(label + '.trigger.replyToBot 必须是布尔');
    if (!Array.isArray(trigger.mentionNames) || trigger.mentionNames.some(item => typeof item !== 'string'))
        errors.push(label + '.trigger.mentionNames 必须是字符串数组');
    if (typeof trigger.banter !== 'boolean')
        errors.push(label + '.trigger.banter 必须是布尔');
}

function validateLayer(layer, label, errors) {
    if (!isPlainObject(layer)) {
        errors.push(label + ' 必须是对象');
        return;
    }
    validateTrigger(layer.trigger, label, errors);
    if (typeof layer.replyChance !== 'number' || !(layer.replyChance >= 0 && layer.replyChance <= 1))
        errors.push(label + '.replyChance 必须在 [0,1]');
    if (!isPlainObject(layer.limits)) {
        errors.push(label + '.limits 必须是对象');
    }
    else {
        for (const key of ['perMinute', 'perHour', 'perDay', 'cooldownSec']) {
            if (!isNonNegativeInt(layer.limits[key]))
                errors.push(label + '.limits.' + key + ' 必须是非负整数');
        }
    }
    if (!isPlainObject(layer.dnd)) {
        errors.push(label + '.dnd 必须是对象');
    }
    else {
        const { start, end } = layer.dnd;
        if (typeof start !== 'string' || typeof end !== 'string')
            errors.push(label + '.dnd.start/end 必须是字符串');
        else if ((start === '') !== (end === ''))
            errors.push(label + '.dnd.start 与 end 必须同时为空或同时填写');
        else if (start !== '' && (!HHMM_RE.test(start) || !HHMM_RE.test(end)))
            errors.push(label + '.dnd.start/end 必须是 HH:MM');
        if (typeof layer.dnd.timezone !== 'string' || layer.dnd.timezone === '')
            errors.push(label + '.dnd.timezone 必须是非空字符串');
    }
    if (typeof layer.review !== 'boolean')
        errors.push(label + '.review 必须是布尔');
    if (!isPlainObject(layer.access)) {
        errors.push(label + '.access 必须是对象');
    }
    else {
        const access = layer.access;
        if (typeof access.allowAll !== 'boolean')
            errors.push(label + '.access.allowAll 必须是布尔');
        if (!ACCESS_POLICIES.includes(access.dmPolicy))
            errors.push(label + '.access.dmPolicy 非法: ' + String(access.dmPolicy));
        if (!ACCESS_POLICIES.includes(access.groupPolicy))
            errors.push(label + '.access.groupPolicy 非法: ' + String(access.groupPolicy));
        for (const key of ['allowUsers', 'denyUsers', 'allowGroups', 'denyGroups']) {
            if (!Array.isArray(access[key]) || access[key].some(item => typeof item !== 'string'))
                errors.push(label + '.access.' + key + ' 必须是字符串数组');
        }
    }
    if (!isPlainObject(layer.context)) {
        errors.push(label + '.context 必须是对象');
    }
    else {
        if (!isNonNegativeInt(layer.context.budgetTokens))
            errors.push(label + '.context.budgetTokens 必须是非负整数');
        if (!isNonNegativeInt(layer.context.maxMessages))
            errors.push(label + '.context.maxMessages 必须是非负整数');
    }
}

/** 水群模式参数：全部有界，避免一次手滑把群刷爆。 */
function validateWater(water, label, errors) {
    if (!isPlainObject(water)) {
        errors.push(label + '.water 必须是对象');
        return;
    }
    for (const key of ['defaultMinutes', 'maxMinutes']) {
        if (!Number.isInteger(water[key]) || water[key] < 1 || water[key] > 1440)
            errors.push(label + '.water.' + key + ' 必须在 1-1440 分钟');
    }
    if (Number.isInteger(water.defaultMinutes) && Number.isInteger(water.maxMinutes)
        && water.defaultMinutes > water.maxMinutes)
        errors.push(label + '.water.defaultMinutes 不能大于 maxMinutes');
    if (typeof water.chance !== 'number' || !(water.chance >= 0 && water.chance <= 1))
        errors.push(label + '.water.chance 必须在 [0,1]');
    for (const key of ['minIntervalSec', 'perHour', 'perDay', 'quietAfterIgnored', 'quietMinutes']) {
        if (!isNonNegativeInt(water[key]))
            errors.push(label + '.water.' + key + ' 必须是非负整数');
    }
    if (!Number.isInteger(water.maxChars) || water.maxChars < 1 || water.maxChars > 1000)
        errors.push(label + '.water.maxChars 必须在 1-1000');
    if (typeof water.ackOnOpen !== 'boolean')
        errors.push(label + '.water.ackOnOpen 必须是布尔');
}

/** 判定器：白名单群 + 合并窗口 + 熔断参数。 */
function validateJudge(judge, label, errors) {
    if (!isPlainObject(judge)) {
        errors.push(label + '.judge 必须是对象');
        return;
    }
    if (typeof judge.enabled !== 'boolean')
        errors.push(label + '.judge.enabled 必须是布尔');
    if (!Array.isArray(judge.groups) || judge.groups.some(group => !isDigits(String(group))))
        errors.push(label + '.judge.groups 必须是群号字符串数组');
    const ranges = [
        ['mergeWindowMs', 500, 30000],
        ['timeoutMs', 500, 10000],
        ['queueLimit', 1, 20],
        ['maxChars', 20, 400],
    ];
    for (const [key, min, max] of ranges) {
        if (!Number.isInteger(judge[key]) || judge[key] < min || judge[key] > max)
            errors.push(label + '.judge.' + key + ' 必须在 ' + min + '-' + max);
    }
}

/** 状态机参数：半衰期与实时阈值。 */
function validatePresence(presence, label, errors) {
    if (!isPlainObject(presence)) {
        errors.push(label + '.presence 必须是对象');
        return;
    }
    if (typeof presence.enabled !== 'boolean')
        errors.push(label + '.presence.enabled 必须是布尔');
    for (const key of ['focusHalfLifeHours', 'heatHalfLifeHours']) {
        if (typeof presence[key] !== 'number' || !(presence[key] > 0 && presence[key] <= 72))
            errors.push(label + '.presence.' + key + ' 必须在 (0,72]');
    }
    if (!Number.isInteger(presence.realtimeFocusAt) || presence.realtimeFocusAt < 0 || presence.realtimeFocusAt > 100)
        errors.push(label + '.presence.realtimeFocusAt 必须在 0-100');
    if (!Number.isInteger(presence.silenceTiredAfter) || presence.silenceTiredAfter < 1 || presence.silenceTiredAfter > 10)
        errors.push(label + '.presence.silenceTiredAfter 必须在 1-10');
}

/** 关系记忆：中性值、单次最大变动、衰减半衰期。 */
function validateMemory(memory, label, errors) {
    if (!isPlainObject(memory) || !isPlainObject(memory.relation)) {
        errors.push(label + '.memory.relation 必须是对象');
        return;
    }
    const relation = memory.relation;
    if (!Number.isInteger(relation.neutral) || relation.neutral < 0 || relation.neutral > 100)
        errors.push(label + '.memory.relation.neutral 必须在 0-100');
    if (!Number.isInteger(relation.maxDelta) || relation.maxDelta < 1 || relation.maxDelta > 10)
        errors.push(label + '.memory.relation.maxDelta 必须在 1-10');
    if (typeof relation.halfLifeDays !== 'number' || !(relation.halfLifeDays > 0 && relation.halfLifeDays <= 365))
        errors.push(label + '.memory.relation.halfLifeDays 必须在 (0,365]');
}

/** 延迟队列：有效期、触发阈值与冷却。 */
function validateBatch(batch, label, errors) {
    if (!isPlainObject(batch)) {
        errors.push(label + '.batch 必须是对象');
        return;
    }
    const ranges = [
        ['ttlMin', 1, 1440],
        ['sizeLimit', 1, 50],
        ['maxWaitMin', 1, 1440],
        ['idleMin', 1, 1440],
        ['followupCooldownMin', 0, 1440],
    ];
    for (const [key, min, max] of ranges) {
        if (!Number.isInteger(batch[key]) || batch[key] < min || batch[key] > max)
            errors.push(label + '.batch.' + key + ' 必须在 ' + min + '-' + max);
    }
}

/** 群级活跃度：quiet / casual / chatty，或带节流覆盖的对象。 */
function validateGroupActivity(activity, label, errors) {
    if (typeof activity === 'string') {
        if (!ACTIVITY_LEVELS.includes(activity))
            errors.push(label + ' 非法: ' + activity + '（可选 quiet/casual/chatty）');
        return;
    }
    if (!isPlainObject(activity)) {
        errors.push(label + ' 必须是字符串或对象');
        return;
    }
    if (!ACTIVITY_LEVELS.includes(activity.level))
        errors.push(label + '.level 非法: ' + String(activity.level));
    if (activity.chance !== undefined
        && (typeof activity.chance !== 'number' || !(activity.chance >= 0 && activity.chance <= 1)))
        errors.push(label + '.chance 必须在 [0,1]');
    for (const key of ['minIntervalSec', 'perHour', 'perDay', 'quietAfterIgnored', 'quietMinutes']) {
        if (activity[key] !== undefined && !isNonNegativeInt(activity[key]))
            errors.push(label + '.' + key + ' 必须是非负整数');
    }
}

/**
 * 整份校验。返回 { ok, errors, warnings, config }。
 * config 已合并默认值，可直接用于运行。
 */
export function validateConfig(raw) {
    const errors = [];
    const warnings = [];
    if (!isPlainObject(raw))
        return { ok: false, errors: ['配置根必须是对象'], warnings, config: null };

    if (raw.version !== 1)
        errors.push('version 必须为 1');
    if (!isPlainObject(raw.bot))
        errors.push('bot 必须是对象');
    else {
        if (!isDigits(raw.bot.qq))
            errors.push('bot.qq 必须是 5-12 位数字字符串');
        if (!isDigits(raw.bot.masterQQ))
            errors.push('bot.masterQQ 必须是 5-12 位数字字符串');
        if (!Array.isArray(raw.bot.adminUsers) || raw.bot.adminUsers.some(item => !isDigits(item)))
            errors.push('bot.adminUsers 必须是数字字符串数组');
        if (raw.bot.knownBots !== undefined
            && (!Array.isArray(raw.bot.knownBots) || raw.bot.knownBots.some(item => !isDigits(item))))
            errors.push('bot.knownBots 必须是数字字符串数组');
        if (Array.isArray(raw.bot.knownBots) && raw.bot.knownBots.map(String).includes(String(raw.bot.masterQQ)))
            errors.push('bot.knownBots 不能包含 bot.masterQQ（机器人账号不能当主人）');
    }

    const config = deepMerge(DEFAULTS, raw);

    if (!isPlainObject(config.security))
        errors.push('security 必须是对象');
    else {
        if (typeof config.security.enabled !== 'boolean')
            errors.push('security.enabled 必须是布尔');
        if (typeof config.security.path !== 'string' || config.security.path === '')
            errors.push('security.path 不能为空');
    }

    if (!isPlainObject(config.runtime))
        errors.push('runtime 必须是对象');
    else {
        if (typeof config.runtime.provider !== 'string' || config.runtime.provider === '')
            errors.push('runtime.provider 不能为空');
        if (typeof config.runtime.model !== 'string' || config.runtime.model === '')
            errors.push('runtime.model 不能为空');
        if (typeof config.runtime.cwd !== 'string' || config.runtime.cwd === '')
            errors.push('runtime.cwd 不能为空');
        if (typeof config.runtime.agentPreset !== 'string')
            errors.push('runtime.agentPreset 必须是字符串');
        if (!Number.isInteger(config.runtime.turnTimeoutMs)
            || config.runtime.turnTimeoutMs < 1000 || config.runtime.turnTimeoutMs > 600000)
            errors.push('runtime.turnTimeoutMs 必须在 1s-10min');
        if (!Number.isInteger(config.runtime.agentIdleMs) || config.runtime.agentIdleMs < 60000)
            errors.push('runtime.agentIdleMs 必须 >= 60000');
    }

    if (!isPlainObject(config.debounce))
        errors.push('debounce 必须是对象');
    else {
        if (typeof config.debounce.enabled !== 'boolean')
            errors.push('debounce.enabled 必须是布尔');
        if (!Number.isInteger(config.debounce.baseMs)
            || config.debounce.baseMs < 100 || config.debounce.baseMs > 10000)
            errors.push('debounce.baseMs 必须在 100-10000');
        for (const key of ['groupMs', 'imageMs']) {
            if (!isNonNegativeInt(config.debounce[key]))
                errors.push('debounce.' + key + ' 必须是非负整数');
        }
        if (!Number.isInteger(config.debounce.maxBatch)
            || config.debounce.maxBatch < 1 || config.debounce.maxBatch > 32)
            errors.push('debounce.maxBatch 必须在 1-32');
    }

    if (!isNonNegativeInt(config.dedupWindowSec) || config.dedupWindowSec > 86400)
        errors.push('dedupWindowSec 必须在 0-86400');

    validateLayer(config.default, 'default', errors);
    validateWater(config.default.water, 'default', errors);
    validateJudge(config.default.judge, 'default', errors);
    validatePresence(config.default.presence, 'default', errors);
    validateMemory(config.default.memory, 'default', errors);
    validateBatch(config.default.batch, 'default', errors);

    if (!isPlainObject(config.dm)) {
        errors.push('dm 必须是对象');
    }
    else {
        validateLayer(deepMerge(config.default, config.dm), 'dm', errors);
        if (config.dm.trigger?.mode !== undefined && config.dm.trigger.mode !== 'always')
            warnings.push('dm.trigger.mode 不是 always：私聊将按该模式判定');
    }

    if (!isPlainObject(config.groups)) {
        errors.push('groups 必须是对象');
    }
    else {
        for (const [groupId, group] of Object.entries(config.groups)) {
            if (!isDigits(groupId))
                errors.push('groups 键必须是 5-12 位群号: ' + groupId);
            if (!isPlainObject(group)) {
                errors.push('groups.' + groupId + ' 必须是对象');
                continue;
            }
            for (const key of Object.keys(group)) {
                if (key === 'persona' || key === 'tone')
                    errors.push('groups.' + groupId + ' 不支持分群人格字段: ' + key);
                else if (!GROUP_BEHAVIOR_KEYS.has(key))
                    warnings.push('groups.' + groupId + ' 未知字段: ' + key);
            }
            validateLayer(deepMerge(config.default, group), 'groups.' + groupId, errors);
            if (group.activity !== undefined)
                validateGroupActivity(group.activity, 'groups.' + groupId + '.activity', errors);
            if (group.judge !== undefined && typeof group.judge !== 'boolean')
                errors.push('groups.' + groupId + '.judge 必须是布尔');
        }
    }

    if (!isPlainObject(config.shadow)) {
        errors.push('shadow 必须是对象');
    }
    else {
        if (typeof config.shadow.enabled !== 'boolean')
            errors.push('shadow.enabled 必须是布尔');
        if (typeof config.shadow.path !== 'string' || config.shadow.path === '')
            errors.push('shadow.path 不能为空');
        if (typeof config.shadow.dryRunModel !== 'boolean')
            errors.push('shadow.dryRunModel 必须是布尔');
        if (!isNonNegativeInt(config.shadow.observeReplyMs) || config.shadow.observeReplyMs > 600000)
            errors.push('shadow.observeReplyMs 必须在 0-600000');
        if (!Number.isInteger(config.shadow.maxReplyChars)
            || config.shadow.maxReplyChars < 100 || config.shadow.maxReplyChars > 20000)
            errors.push('shadow.maxReplyChars 必须在 100-20000');
    }

    if (!isPlainObject(config.samples)) {
        errors.push('samples 必须是对象');
    }
    else {
        if (typeof config.samples.enabled !== 'boolean')
            errors.push('samples.enabled 必须是布尔');
        if (typeof config.samples.path !== 'string' || config.samples.path === '')
            errors.push('samples.path 不能为空');
        if (!isNonNegativeInt(config.samples.delayMs))
            errors.push('samples.delayMs 必须是非负整数');
        if (typeof config.samples.once !== 'boolean')
            errors.push('samples.once 必须是布尔');
    }

    const knownRoot = new Set(['version', 'bot', 'runtime', 'debounce', 'dedupWindowSec', 'default',
        'groups', 'dm', 'shadow', 'samples']);
    for (const key of Object.keys(raw)) {
        if (!knownRoot.has(key))
            warnings.push('未知根字段: ' + key);
    }

    return { ok: errors.length === 0, errors, warnings, config: errors.length === 0 ? config : null };
}

/** 读取并校验一个配置文件。 */
export function loadConfigFile(path) {
    try {
        const text = readFileSync(path, 'utf8');
        const raw = JSON.parse(text);
        return { ...validateConfig(raw), raw };
    }
    catch (error) {
        return {
            ok: false,
            errors: ['读取/解析失败: ' + (error?.message ?? String(error))],
            warnings: [],
            config: null,
            raw: null,
        };
    }
}

/**
 * 配置仓库：持有当前版本、按 chat 记忆化合并结果、热重载。
 * 初始加载失败时 current 为 null，调用方不应启动管线。
 */
export function createConfigStore({ path, log }) {
    let current = null;
    let version = 0;
    let watcher = null;
    let timer = null;
    let accessWatcher = null;
    let accessTimer = null;
    const memo = new Map();
    const errorLogPath = join(dirname(path), 'logs', 'config-error.log');

    function writeError(errors, raw) {
        try {
            mkdirSync(dirname(errorLogPath), { recursive: true });
            appendFileSync(errorLogPath, JSON.stringify({
                ts: new Date().toISOString(),
                errors,
                rawHash: hash(JSON.stringify(raw ?? null)),
            }) + '\n', 'utf8');
        }
        catch {
            // 日志失败不能反过来影响配置加载
        }
        try {
            log?.('error', '配置校验失败，保留上一份', { errors, hasPrevious: current !== null });
        }
        catch {
            // ignore
        }
    }

    function adopt(result, source) {
        if (!result.ok) {
            writeError(result.errors, result.raw);
            return false;
        }
        current = result.config;
        version += 1;
        memo.clear();
        // 群白名单/策略以真链路的 cordis.patch.yml 为唯一事实源，config.json 只留兜底。
        const access = applyCordisAccess(current);
        log?.('info', '配置已加载', {
            source,
            version,
            groups: Object.keys(current.groups),
            dryRunModel: current.shadow.dryRunModel,
            access: access === null
                ? { source: 'config.json（未找到 cordis 事实源）', policies: current.default.access.groupPolicy, allowGroups: current.default.access.allowGroups }
                : access,
        });
        if (result.warnings.length > 0)
            log?.('warn', '配置告警', { warnings: result.warnings });
        return true;
    }

    return {
        get path() {
            return path;
        },
        get current() {
            return current;
        },
        get version() {
            return version;
        },
        load() {
            const result = loadConfigFile(path);
            return adopt(result, 'initial');
        },
        reload() {
            const result = loadConfigFile(path);
            if (adopt(result, 'hot-reload'))
                log?.('info', '配置热重载成功', { version });
            return result.ok;
        },
        watch() {
            if (watcher !== null && accessWatcher !== null)
                return;
            if (watcher === null) {
                try {
                    watcher = watch(dirname(path), (event, filename) => {
                        if (filename !== null && String(filename) !== basename(path))
                            return;
                        if (timer !== null)
                            clearTimeout(timer);
                        timer = setTimeout(() => {
                            timer = null;
                            this.reload();
                        }, 300);
                    });
                    watcher.on?.('error', error => {
                        log?.('warn', '配置 watch 出错', { error: error?.message ?? String(error) });
                    });
                }
                catch (error) {
                    log?.('warn', '配置 watch 启动失败，热重载不可用', { error: error?.message ?? String(error) });
                }
            }
            // 白名单事实源在另一个目录：单独盯一份，改完 cordis 不需要再手改 config.json。
            if (accessWatcher === null) {
                const accessPath = cordisAccessSource();
                try {
                    accessWatcher = watch(dirname(accessPath), (event, filename) => {
                        if (filename !== null && String(filename) !== basename(accessPath))
                            return;
                        if (accessTimer !== null)
                            clearTimeout(accessTimer);
                        accessTimer = setTimeout(() => {
                            accessTimer = null;
                            this.reload();
                        }, 300);
                    });
                    accessWatcher.on?.('error', error => {
                        log?.('warn', 'cordis watch 出错', { error: error?.message ?? String(error) });
                    });
                }
                catch (error) {
                    log?.('warn', 'cordis watch 启动失败，白名单热同步不可用', { error: error?.message ?? String(error) });
                }
            }
        },
        stop() {
            if (timer !== null)
                clearTimeout(timer);
            timer = null;
            if (accessTimer !== null)
                clearTimeout(accessTimer);
            accessTimer = null;
            try {
                watcher?.close();
            }
            catch {
                // ignore
            }
            watcher = null;
            try {
                accessWatcher?.close();
            }
            catch {
                // ignore
            }
            accessWatcher = null;
        },
        /** 三层合并：default → groups[群号] → dm。 */
        effective(kind, chatId) {
            if (current === null)
                return null;
            const key = version + '|' + kind + '|' + chatId;
            if (memo.has(key))
                return memo.get(key);
            let merged = clone(current.default);
            if (kind === 'group') {
                const group = current.groups[String(chatId)];
                if (group !== undefined)
                    merged = deepMerge(merged, group);
            }
            else if (kind === 'dm') {
                merged = deepMerge(merged, current.dm);
            }
            merged.runtime = current.runtime;
            merged.bot = current.bot;
            merged.debounce = current.debounce;
            merged.dedupWindowSec = current.dedupWindowSec;
            merged.shadow = current.shadow;
            merged.samples = current.samples;
            merged.cfgVersion = version;
            memo.set(key, merged);
            return merged;
        },
    };
}

/** 稳定短哈希，仅用于日志关联，不做安全用途。 */
export function hash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

/** 原子写 JSON（临时文件 + rename），rename 失败时回退直接覆盖。 */
export function writeJsonAtomic(path, value) {
    try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = path + '.tmp-' + process.pid;
        writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
        renameSync(tmp, path);
        return true;
    }
    catch {
        return false;
    }
}

/** 配置目录是否已存在（供入口决定是否创建）。 */
export function ensureDir(path) {
    if (existsSync(path))
        return;
    try {
        mkdirSync(path, { recursive: true });
    }
    catch {
        // ignore
    }
}
