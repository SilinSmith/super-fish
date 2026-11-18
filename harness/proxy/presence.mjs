/**
 * 状态机：情绪 / 专注度 / 社交热度。
 *
 * 纯逻辑 + 一层持久化：
 *   - applyPresenceEvent 是纯函数，转移表固定、便于单测；
 *   - decayPresence 按 updatedAt 做时间衰减，重启后先算再写回，不原样加载；
 *   - focus 是连续量：>= realtimeFocusAt 走实时，< 阈值进延迟队列（见 defer.mjs）。
 *
 * 这里只描述"它现在什么状态"，不决定说不说；判定器读 hint() 做参考。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_PRESENCE_PATH = 'Y:\\dsh\\home\\qq-persona\\presence-state.json';

export const MOODS = Object.freeze(['calm', 'excited', 'tired', 'annoyed']);
export const PRESENCE_EVENTS = Object.freeze([
    'praised', 'scolded', 'ignored', 'topicHit', 'addressed', 'silence', 'lateNight',
]);

export const PRESENCE_DEFAULTS = Object.freeze({
    mood: 'calm',
    focus: 60,
    heat: 30,
    moodLevel: 50,
    patienceByActor: {},
    lastActorKey: '',
    moodUntil: null,
    ignoredStreak: 0,
    lastLateNightAt: 0,
});

/**
 * 交互负担：任意交互都按这张表折算成耐心增减，poke 只是其中一种。
 * 负值消耗耐心，正值恢复；focus/heat/mood 是附带影响。
 * 注意：patience 是“耐受度”，按人独立；mood 是全局情绪值，两者独立更新、互相影响。
 */
export const INTERACTION_COSTS = Object.freeze({
    message: { patience: -2, heat: 1 },
    attention: { patience: -5, heat: 2 },
    followup: { patience: -4 },
    task: { patience: -8, focus: -4 },
    poke: { patience: -6 },
    interrupt: { patience: -7 },
    lateNight: { patience: -5 },
    praise: { patience: 10, heat: 4, mood: 8 },
    flow: { patience: 4, heat: 2, mood: 4 },
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** 耐心上限；回满按 0→100 用 5 分钟线性恢复。 */
const PATIENCE_MAX = 100;
const PATIENCE_RECOVER_MS = 5 * MINUTE;
/** 情绪值回归中性 50 的半衰期（慢，和耐心是两套时间尺度）。 */
const MOOD_BASELINE = 50;
const MOOD_LEVEL_HALF_LIFE_MS = 3 * HOUR;
/** 心情会改变耐心消耗速度：烦/累时掉得更快，兴奋时更耐一点。 */
const MOOD_PACE = Object.freeze({ annoyed: 1.3, tired: 1.2, excited: 0.9 });
/** 同一人在这个窗口内的负向交互会叠加（越戳越烦）。 */
const REPEAT_WINDOW_MS = 8 * MINUTE;
/** 交互账本只留最近 30 分钟，避免状态文件无限增长。 */
const ACTS_TTL_MS = 30 * MINUTE;
const ACTS_MAX = 40;
/** 角色差异是“每个人自己的初值和消耗速率”，不是共享一个池。 */
const ROLE_PROFILE = Object.freeze({
    master: { initial: 100, cost: 0.6 },
    admin: { initial: 95, cost: 0.8 },
    member: { initial: 90, cost: 1 },
});
const MOOD_TTL_MS = Object.freeze({
    excited: 40 * MINUTE,
    annoyed: 50 * MINUTE,
    tired: 90 * MINUTE,
    calm: 0,
});
/** 离线超过这么久直接硬重置，避免衰减公式留下"昨天的不悦"。 */
const OFFLINE_RESET_MS = 6 * HOUR;

function clampScore(value, fallback = 0) {
    const number = Number(value);
    if (!Number.isFinite(number))
        return Math.round(fallback);
    return Math.min(100, Math.max(0, Math.round(number)));
}

function normalizeActs(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw
        .filter(item => item !== null && typeof item === 'object'
            && Number.isFinite(Number(item.t)) && Number.isFinite(Number(item.w)))
        .map(item => ({
            t: Number(item.t),
            w: Number(item.w),
            k: String(item.k ?? ''),
        }))
        .slice(-ACTS_MAX);
}

/** 耐心按人独立：群聊用 chatId:userId，私聊按 userId。 */
export function actorKeyOf({ chatId, userId, kind } = {}) {
    const uid = String(userId ?? '');
    const cid = String(chatId ?? '');
    if (uid === '')
        return cid;
    if (kind === 'private' || cid.startsWith('private:'))
        return uid;
    return cid === '' ? uid : cid + ':' + uid;
}

function normalizeActor(raw, initial, now) {
    const source = raw !== null && typeof raw === 'object' ? raw : {};
    return {
        patience: clampScore(source.patience, initial),
        updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : now,
        acts: normalizeActs(source.acts),
    };
}

/** 每个 actor 各自的线性恢复：5 分钟从 0 回满 100。 */
function decayActor(record, now) {
    const elapsed = Math.max(0, now - record.updatedAt);
    return {
        patience: clampScore(record.patience + (elapsed / PATIENCE_RECOVER_MS) * PATIENCE_MAX),
        updatedAt: now,
        acts: record.acts.filter(item => now - item.t < ACTS_TTL_MS),
    };
}

/** 读取某人的耐心；没有记录说明没冒犯过它，按满值算。 */
export function patienceOf(state, key) {
    const record = key === '' ? undefined : state?.patienceByActor?.[key];
    if (record === undefined || record === null)
        return PATIENCE_MAX;
    return clampScore(record.patience, PATIENCE_MAX);
}

function normalizePresence(raw, now) {
    const source = raw !== null && typeof raw === 'object' ? raw : {};
    const actors = {};
    if (source.patienceByActor !== null && typeof source.patienceByActor === 'object') {
        for (const [key, record] of Object.entries(source.patienceByActor))
            actors[key] = normalizeActor(record, PATIENCE_MAX, now);
    }
    return {
        version: 1,
        mood: MOODS.includes(source.mood) ? source.mood : PRESENCE_DEFAULTS.mood,
        focus: clampScore(source.focus, PRESENCE_DEFAULTS.focus),
        heat: clampScore(source.heat, PRESENCE_DEFAULTS.heat),
        moodLevel: clampScore(source.moodLevel, PRESENCE_DEFAULTS.moodLevel),
        patienceByActor: actors,
        lastActorKey: typeof source.lastActorKey === 'string' ? source.lastActorKey : '',
        moodUntil: Number.isFinite(Number(source.moodUntil)) ? Number(source.moodUntil) : null,
        ignoredStreak: Number.isInteger(source.ignoredStreak) && source.ignoredStreak >= 0 ? source.ignoredStreak : 0,
        lastLateNightAt: Number.isFinite(Number(source.lastLateNightAt)) ? Number(source.lastLateNightAt) : 0,
        updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : now,
    };
}

function withMood(state, mood, now) {
    const ttl = MOOD_TTL_MS[mood] ?? 0;
    return { ...state, mood, moodUntil: ttl > 0 ? now + ttl : null };
}

/**
 * 状态转移。返回新对象，不改入参。
 *
 * mood 是情绪标签，moodLevel 是同一情绪方向的连续值（50 中性），
 * 由聊天内容/事件性质驱动；与 patience（交互耐受度）是两套独立状态。
 *
 * | event      | mood                    | moodLevel | focus | heat |
 * | praised    | excited (40min)         | +18       | +6    | +12  |
 * | scolded    | annoyed (50min)         | -20       | -8    | +4   |
 * | ignored    | excited→calm；低热转累  | -8        | -6    | -10  |
 * | topicHit   | tired→calm              | +10       | +15   | +8   |
 * | addressed  | tired→calm              | +8        | +20   | +10  |
 * | silence    | 连续 2 次 → tired(90min) | -12      | -10   | -25  |
 * | lateNight  | tired (90min，30min 去抖) | -12      | -10   | -10  |
 */
export function applyPresenceEvent(state, event, options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const base = normalizePresence(state, now);
    const next = { ...base, updatedAt: now };
    switch (event) {
        case 'praised':
            Object.assign(next, withMood(next, 'excited', now), {
                focus: clampScore(next.focus + 6),
                heat: clampScore(next.heat + 12),
                moodLevel: clampScore(next.moodLevel + 18),
                ignoredStreak: 0,
            });
            break;
        case 'scolded':
            Object.assign(next, withMood(next, 'annoyed', now), {
                focus: clampScore(next.focus - 8),
                heat: clampScore(next.heat + 4),
                moodLevel: clampScore(next.moodLevel - 20),
                ignoredStreak: 0,
            });
            break;
        case 'ignored': {
            const heat = clampScore(next.heat - 10);
            next.focus = clampScore(next.focus - 6);
            next.heat = heat;
            next.moodLevel = clampScore(next.moodLevel - 8);
            next.ignoredStreak = next.ignoredStreak + 1;
            if (next.mood === 'excited' || heat < 15)
                Object.assign(next, withMood(next, heat < 15 ? 'tired' : 'calm', now));
            break;
        }
        case 'topicHit':
            next.focus = clampScore(next.focus + 15);
            next.heat = clampScore(next.heat + 8);
            next.moodLevel = clampScore(next.moodLevel + 10);
            if (next.mood === 'tired')
                Object.assign(next, withMood(next, 'calm', now));
            break;
        case 'addressed':
            next.focus = clampScore(next.focus + 20);
            next.heat = clampScore(next.heat + 10);
            next.moodLevel = clampScore(next.moodLevel + 8);
            next.ignoredStreak = 0;
            if (next.mood === 'tired')
                Object.assign(next, withMood(next, 'calm', now));
            break;
        case 'silence':
            next.focus = clampScore(next.focus - 10);
            next.heat = clampScore(next.heat - 25);
            next.moodLevel = clampScore(next.moodLevel - 12);
            next.ignoredStreak = next.ignoredStreak + 1;
            if (next.ignoredStreak >= 2)
                Object.assign(next, withMood(next, 'tired', now));
            break;
        case 'lateNight':
            // 深夜只降一次：30 分钟内重复的深夜消息不叠加。
            if (now - next.lastLateNightAt < 30 * MINUTE)
                return base;
            next.lastLateNightAt = now;
            next.focus = clampScore(next.focus - 10);
            next.heat = clampScore(next.heat - 10);
            next.moodLevel = clampScore(next.moodLevel - 12);
            Object.assign(next, withMood(next, 'tired', now));
            break;
        default:
            return base;
    }
    return next;
}

/**
 * 交互负担 → 耐心（独立状态），并按规则轻推情绪值（另一个独立状态）。
 *
 * - 每种交互按 INTERACTION_COSTS 折算耐心；
 * - 负向交互乘角色耐受度（主人 0.6 / 管理员 0.8 / 群友 1.0，不存在免疫）；
 * - 同一人在 REPEAT_WINDOW_MS 内的负向交互按 1+0.6×次数 叠加（封顶 4 倍），
 *   不同人各按基础值算：同一人连戳比一群人各戳一下更烦；
 * - 心情反向影响耐心消耗速度（annoyed ×1.3、tired ×1.2、excited ×0.9）；
 * - 耐心被压到 < 25 时，情绪值额外下滑（耐心耗尽 → 心情往负面走）；
 * - 耐心 < 30 转 annoyed，回到 >= 55 时从 annoyed 回落 calm。
 */
export function applyInteractionEvent(state, interaction = {}, options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const base = normalizePresence(state, now);
    const kind = String(interaction.kind ?? '');
    const cost = INTERACTION_COSTS[kind];
    if (cost === undefined)
        return base;
    const key = actorKeyOf(interaction);
    const profile = ROLE_PROFILE[String(interaction.role ?? 'member')] ?? ROLE_PROFILE.member;
    const negative = (cost.patience ?? 0) < 0;
    const moodPace = negative ? (MOOD_PACE[base.mood] ?? 1) : 1;
    // 每个 actor 单独恢复、单独记账，互不牵连。
    const record = decayActor(normalizeActor(base.patienceByActor[key], profile.initial, now), now);
    let repeat = 0;
    if (negative)
        repeat = record.acts.filter(item => item.w < 0 && now - item.t < REPEAT_WINDOW_MS).length;
    const repeatFactor = negative ? 1 + Math.min(4, repeat) * 0.6 : 1;
    const tolerance = negative ? profile.cost : 1;
    const delta = Math.round((cost.patience ?? 0) * tolerance * repeatFactor * moodPace);
    const patience = clampScore(record.patience + delta);
    const next = {
        ...base,
        moodLevel: clampScore(base.moodLevel + (cost.mood ?? 0)),
        focus: clampScore(base.focus + (cost.focus ?? 0)),
        heat: clampScore(base.heat + (cost.heat ?? 0)),
        patienceByActor: {
            ...base.patienceByActor,
            [key]: { patience, updatedAt: now, acts: [...record.acts, { t: now, w: delta, k: kind }].slice(-ACTS_MAX) },
        },
        lastActorKey: key === '' ? base.lastActorKey : key,
        updatedAt: now,
    };
    // 耐心见底时情绪跟着往下走（另一套状态，但允许被耐心拖累）。
    if (negative && patience < 25)
        next.moodLevel = clampScore(next.moodLevel - (patience < 10 ? 8 : 4));
    if (patience < 30 && next.mood !== 'excited')
        Object.assign(next, withMood(next, 'annoyed', now));
    else if (patience >= 55 && next.mood === 'annoyed')
        Object.assign(next, withMood(next, 'calm', now));
    return next;
}

/**
 * 按时间衰减：heat 半衰期 2h，focus 以 50 为中心半衰期 3h 回归，
 * 每个 actor 的 patience 各自线性恢复（5 分钟回满），
 * moodLevel 以 50 为中心半衰期 3h 回归（慢），mood 标签到期回落 calm；
 * 离线 >= 6h 硬重置 heat/mood/moodLevel/耐心账本。
 */
export function decayPresence(state, now, options = {}) {
    const focusHalfLife = Number(options.focusHalfLifeHours) > 0 ? Number(options.focusHalfLifeHours) : 3;
    const heatHalfLife = Number(options.heatHalfLifeHours) > 0 ? Number(options.heatHalfLifeHours) : 2;
    const base = normalizePresence(state, now);
    const stamp = Number.isFinite(now) ? now : Date.now();
    const hours = Math.max(0, (stamp - base.updatedAt) / HOUR);
    const actors = {};
    for (const [key, record] of Object.entries(base.patienceByActor))
        actors[key] = decayActor(record, stamp);
    const next = {
        ...base,
        heat: clampScore(base.heat * Math.pow(0.5, hours / heatHalfLife)),
        focus: clampScore(50 + (base.focus - 50) * Math.pow(0.5, hours / focusHalfLife)),
        moodLevel: clampScore(MOOD_BASELINE
            + (base.moodLevel - MOOD_BASELINE) * Math.pow(0.5, (stamp - base.updatedAt) / MOOD_LEVEL_HALF_LIFE_MS)),
        patienceByActor: actors,
        updatedAt: stamp,
    };
    if (stamp - base.updatedAt >= OFFLINE_RESET_MS) {
        next.heat = 0;
        next.mood = 'calm';
        next.moodLevel = MOOD_BASELINE;
        next.moodUntil = null;
        next.ignoredStreak = 0;
        next.patienceByActor = {};
        next.lastActorKey = '';
    }
    else if (next.moodUntil !== null && stamp >= next.moodUntil) {
        next.mood = 'calm';
        next.moodUntil = null;
    }
    return next;
}

/**
 * 给判定器/门禁用的一句话状态。没有 patience 字段时回退到旧的心情短语，
 * 保持既有调用方与单测不变。
 * 注意：耐心只描述“话怎么说”，不给“可以不回”的理由。
 */
export function presenceHint(state) {
    const moodLine = state?.mood === 'excited'
        ? '现在兴致高，想接话'
        : state?.mood === 'annoyed'
            ? '情绪有点烦，语气会冷'
            : state?.mood === 'tired'
                ? '有点累，话少一点'
                : '状态平常';
    if (state === null || typeof state !== 'object' || !Number.isFinite(Number(state.patience)))
        return moodLine;
    const patience = clampScore(state.patience, PATIENCE_MAX);
    const patienceLine = patience >= 75
        ? '耐心充足，愿意多聊几句，也愿意搭把手'
        : patience >= 55
            ? '耐心平常'
            : patience >= 35
                ? '耐心偏低：话短一点，少主动延伸，少接新活，但该回还是会回'
                : patience >= 20
                    ? '耐心很低：回得短、敷衍一点，少展开，但该回还是会回'
                    : '耐心几乎耗尽：只回很短的一句，语气不耐烦，但该回还是会回';
    if (state.mood === 'excited')
        return patienceLine + '；心情不错，别把不耐烦摆在脸上';
    if (state.mood === 'annoyed' || state.mood === 'tired')
        return patienceLine + '；' + moodLine;
    return patienceLine;
}

/**
 * 注入回复提示词的一行状态：只给行为约束，不给固定句子。
 * 耐心只影响语气与长度，明确不做“回不回”的依据。
 * 没有耐心状态时返回空串，调用方原样拼接。
 */
export function presencePromptLine(state) {
    if (state === null || typeof state !== 'object' || !Number.isFinite(Number(state.patience)))
        return '';
    const patience = clampScore(state.patience, PATIENCE_MAX);
    const moodName = state.mood === 'excited' ? '不错' : state.mood === 'annoyed' ? '烦躁' : state.mood === 'tired' ? '有点累' : '平静';
    const head = '【当下状态】心情：' + moodName + '；对这个人的耐心 ' + patience + '/100';
    const tail = '不要向对方提这个数值。';
    const mustReply = '该回还是要回，不要拿不耐烦当沉默理由，也不要把问题推回给对方。';
    if (patience >= 75)
        return head + '（充足）：可以正常发挥，愿意接话、愿意搭把手。' + tail;
    if (patience >= 55)
        return head + '（平常）：按平常的节奏回。' + tail;
    if (patience >= 35)
        return head + '（偏低）：话短一点，少主动延伸，别接新的活；' + mustReply + tail;
    if (patience >= 20)
        return head + '（很低）：回得更短、更敷衍，少展开；' + mustReply
            + '不许辱骂、不许人身攻击。' + tail;
    return head + '（几乎耗尽）：只回很短的一句，语气不耐烦可以，但必须给出回答本身；'
        + '不要拒绝回答、不要让对方自己去查。不许辱骂、不许越界。' + tail;
}

function readStateFile(path) {
    try {
        if (!existsSync(path))
            return null;
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return null;
    }
}

export function createPresenceRuntime(options = {}) {
    const statePath = options.statePath ?? DEFAULT_PRESENCE_PATH;
    const now = options.now ?? (() => Date.now());
    const log = options.log ?? (() => {});
    const focusHalfLifeHours = options.focusHalfLifeHours ?? 3;
    const heatHalfLifeHours = options.heatHalfLifeHours ?? 2;

    // 启动即衰减并写回：不能让昨天的 excited 原样挂到今天。
    let state = decayPresence(readStateFile(statePath), now(), { focusHalfLifeHours, heatHalfLifeHours });

    function save() {
        try {
            mkdirSync(dirname(statePath), { recursive: true });
            const tmp = statePath + '.tmp';
            writeFileSync(tmp, JSON.stringify(state), 'utf8');
            renameSync(tmp, statePath);
        }
        catch (error) {
            log('warn', '状态机写入失败: ' + (error?.message ?? String(error)));
        }
    }
    save();

    return {
        /**
         * 取全局状态 + 指定人的耐心。key 省略时用最近一次交互的人；
         * 没有该人记录时耐心按满值（没被这个人消耗过）。
         */
        get(actorKey) {
            const stamp = now();
            // 长时间运行也要衰减：读的时候按当前时间算，避免 focus 卡在最后一次事件。
            if (stamp - state.updatedAt >= 60_000) {
                state = decayPresence(state, stamp, { focusHalfLifeHours, heatHalfLifeHours });
                save();
            }
            const key = String(actorKey ?? '') || state.lastActorKey;
            return { ...state, patience: patienceOf(state, key) };
        },
        apply(event) {
            const stamp = now();
            state = decayPresence(state, stamp, { focusHalfLifeHours, heatHalfLifeHours });
            state = applyPresenceEvent(state, event, { now: stamp });
            save();
            return { ...state, patience: patienceOf(state, state.lastActorKey) };
        },
        /** 有人在群里 @ 它 → addressed；深夜第一条 → lateNight。 */
        noteMessage({ mentioned, lateNight } = {}) {
            const stamp = now();
            state = decayPresence(state, stamp, { focusHalfLifeHours, heatHalfLifeHours });
            if (mentioned === true)
                state = applyPresenceEvent(state, 'addressed', { now: stamp });
            else if (lateNight === true)
                state = applyPresenceEvent(state, 'lateNight', { now: stamp });
            else
                state = { ...state, updatedAt: stamp };
            save();
            return { ...state, patience: patienceOf(state, state.lastActorKey) };
        },
        /**
         * 统一交互入口：{ kind, userId, chatId, role, lateNight }。
         * 耐心按 actorKeyOf(chatId,userId) 单独记账、单独恢复；
         * lateNight 作为附加负担对同一个人只记一次（30 分钟内不叠加）。
         */
        noteInteraction(interaction = {}) {
            const stamp = now();
            state = decayPresence(state, stamp, { focusHalfLifeHours, heatHalfLifeHours });
            const key = actorKeyOf(interaction);
            const nightSeen = (state.patienceByActor[key]?.acts ?? [])
                .some(item => item.k === 'lateNight' && stamp - item.t < 30 * MINUTE);
            if (interaction.lateNight === true && !nightSeen) {
                state = applyInteractionEvent(state, {
                    kind: 'lateNight',
                    userId: interaction.userId,
                    chatId: interaction.chatId,
                    role: interaction.role,
                }, { now: stamp });
            }
            state = applyInteractionEvent(state, interaction, { now: stamp });
            save();
            return { ...state, patience: patienceOf(state, key) };
        },
        /** 判定器/门禁用；key 省略时用最近一次交互的人。 */
        hint(actorKey) {
            const key = String(actorKey ?? '') || state.lastActorKey;
            return presenceHint({ ...state, patience: patienceOf(state, key) });
        },
        /** 回复提示词用的一行状态（可能为空串）。 */
        promptLine(actorKey) {
            const key = String(actorKey ?? '') || state.lastActorKey;
            return presencePromptLine({ ...state, patience: patienceOf(state, key) });
        },
        /** 某人当前耐心（0-100），不做写入。 */
        patienceFor(actorKey) {
            return patienceOf(state, String(actorKey ?? '') || state.lastActorKey);
        },
        configure(partial = {}) {
            if (Number(partial.focusHalfLifeHours) > 0)
                state = decayPresence(state, now(), { ...partial });
        },
        snapshot() {
            return { ...state };
        },
        statePath,
    };
}

let singleton = null;

export function getPresenceRuntime(options = {}) {
    if (singleton === null)
        singleton = createPresenceRuntime(options);
    return singleton;
}
