/**
 * 分层记忆的共享实现：归一化、关键词索引、权威分级、冲突合并。
 *
 * 纯函数模块，不碰文件系统，这样 persona proxy（只读注入）和
 * dsh-onebot-qq 的 qq_notebook 工具（写入）可以共用同一套规则，
 * 也可以单独跑单元测试。
 *
 * 存储仍是 notebook.json，schema 升到 version 3：条目带 origin（来源场景）
 * 与 visibility（可见范围），检索前按场景过滤，旧条目迁移时补安全默认值。
 */

export const MASTER_QQ = '10000';
export const MASTER_NAME = '主人';

/** 数值越大越权威。 */
export const AUTHORITY_RANK = { inferred: 0, member: 1, admin: 2, master: 3 };
/** 检索时的权重，不等于 rank：master 是“更可信”，不是“永远相关”。 */
export const AUTHORITY_WEIGHT = { inferred: 0.7, member: 1, admin: 1.25, master: 1.5 };

export const CATEGORIES = ['meme', 'user', 'behavior', 'note', 'core', 'relation', 'knowledge'];

/** 迁移期旧条目的场景键：旧条目没有来源信息，视为全场景可见，避免突然失忆。 */
export const SCENE_LEGACY = 'legacy';
export const AUDIENCES = ['public', 'scene', 'master', 'owner', 'internal'];
export const STATUSES = ['active', 'superseded', 'disputed', 'expired', 'contested'];

/** 高频虚词 bigram，不参与索引，避免“什么/怎么”把无关条目拉进来。 */
const STOP_BIGRAMS = new Set([
    '什么', '怎么', '这个', '那个', '一个', '一下', '我们', '你们', '他们', '她们',
    '现在', '可以', '没有', '知道', '因为', '所以', '但是', '如果', '就是', '还是',
    '这样', '那样', '感觉', '觉得', '然后', '而且', '已经', '自己', '时候', '真的',
    '不是', '不会', '不能', '不要', '应该', '可能', '比较', '有点', '一些', '这种',
]);

const CJK = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff';
const CJK_RUN_RE = new RegExp(`[${CJK}]+`, 'gu');
const ASCII_WORD_RE = /[a-z0-9]+(?:[._+-][a-z0-9]+)*/gu;
const QQ_RE = /\d{5,12}/gu;

function halveWidth(value) {
    let out = '';
    for (const char of value) {
        const code = char.codePointAt(0);
        if (code >= 0xff01 && code <= 0xff5e)
            out += String.fromCodePoint(code - 0xfee0);
        else if (code === 0x3000)
            out += ' ';
        else
            out += char;
    }
    return out;
}

export function normalizeText(value) {
    return halveWidth(String(value ?? ''))
        .toLowerCase()
        .replace(/\[cq:[^\]]*\]/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

/** 中文 bigram + 短整串、英文/数字词、5-12 位 QQ 号。 */
export function tokenize(text) {
    const normalized = normalizeText(text);
    const tokens = new Set();
    for (const match of normalized.matchAll(ASCII_WORD_RE)) {
        const word = match[0];
        if (word.length < 2 || /^\d+$/u.test(word))
            continue;
        tokens.add(word);
    }
    for (const match of normalized.matchAll(QQ_RE))
        tokens.add(match[0]);
    for (const run of normalized.match(CJK_RUN_RE) ?? []) {
        if (run.length === 1) {
            tokens.add(run);
            continue;
        }
        for (let index = 0; index < run.length - 1; index += 1) {
            const bigram = run.slice(index, index + 2);
            if (!STOP_BIGRAMS.has(bigram))
                tokens.add(bigram);
        }
        // 短词整体保留，长句整体没有检索价值。
        if (run.length <= 8)
            tokens.add(run);
    }
    return [...tokens];
}

export function bigramSimilarity(left, right) {
    const a = new Set(tokenize(left));
    const b = new Set(tokenize(right));
    if (a.size === 0 || b.size === 0)
        return 0;
    let shared = 0;
    for (const token of a) {
        if (b.has(token))
            shared += 1;
    }
    return shared / Math.max(a.size, b.size);
}

const NEGATION_RE = /(不是|没有|并非|不对|别再)/u;

/**
 * 同一 (category, subject) 下两条记忆是否在说同一件事。
 *
 * 字面高度相似算冲突；字面只中等相似但一方带否定（“是主人的朋友”
 * 对“不是主人朋友”）也算冲突——这类句子的 bigram 重合天然偏低，
 * 只用 0.55 会漏掉最重要的那种矛盾。
 */
function isConflict(left, right) {
    const similarity = bigramSimilarity(left, right);
    if (similarity >= 0.55)
        return true;
    return similarity >= 0.34 && (NEGATION_RE.test(left) !== NEGATION_RE.test(right));
}

function authorityOf(entry) {
    const authority = entry?.authority;
    return Object.hasOwn(AUTHORITY_RANK, authority) ? authority : 'inferred';
}

function entryText(entry) {
    return String(entry?.subject ?? '') + ' ' + String(entry?.text ?? '') + ' ' + (Array.isArray(entry?.keywords) ? entry.keywords.join(' ') : '');
}

function isExpired(entry, now) {
    if (entry?.status === 'expired')
        return true;
    const ttlHours = Number(entry?.ttlHours);
    if (!Number.isFinite(ttlHours) || ttlHours <= 0)
        return false;
    const ts = Date.parse(String(entry?.ts ?? ''));
    if (!Number.isFinite(ts))
        return false;
    return now - ts >= ttlHours * 3_600_000;
}

function stringOrNull(value) {
    if (value === undefined || value === null)
        return null;
    const text = String(value).trim();
    return text === '' ? null : text;
}

/** 解析 'group:100000001' / 'private:10003'。 */
function parseSceneKey(value) {
    if (typeof value !== 'string')
        return null;
    const match = /^(group|private):(.+)$/u.exec(value.trim());
    if (match === null)
        return null;
    return { sceneKey: `${match[1]}:${match[2]}`, chatKind: match[1], chatId: match[2] };
}

/**
 * 场景键：group:<群号> 或 private:<QQ>。
 *
 * sceneKeyOf('group', '100000001') → 'group:100000001'
 * sceneKeyOf('dm', '123') → 'private:123'（dm 视同私聊）
 * sceneKeyOf('group:100000001') → 原样返回
 */
export function sceneKeyOf(a, b) {
    if (b === undefined || b === null) {
        const single = String(a ?? '').trim();
        const parsed = parseSceneKey(single);
        if (parsed !== null)
            return parsed.sceneKey;
        return single === '' ? SCENE_LEGACY : single;
    }
    const kind = String(a ?? '').trim() === 'group' ? 'group' : 'private';
    return `${kind}:${String(b).trim()}`;
}

function normalizeSensitivity(value, category) {
    if (value !== null && value !== undefined && value !== '') {
        const number = Number(value);
        if (Number.isInteger(number) && number >= 0 && number <= 3)
            return number;
    }
    return category === 'core' ? 0 : 1;
}

function normalizeIdList(value) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    for (const item of value) {
        if (typeof item === 'string' && item !== '' && !out.includes(item))
            out.push(item);
    }
    return out;
}

function normalizeHistory(value) {
    if (!Array.isArray(value))
        return [];
    return value
        .filter(item => item && typeof item === 'object')
        .map(item => ({
            at: typeof item.at === 'string' ? item.at : null,
            by: typeof item.by === 'string' ? item.by : null,
            from: item.from && typeof item.from === 'object' ? { ...item.from } : {},
            to: item.to && typeof item.to === 'object' ? { ...item.to } : {},
            reason: typeof item.reason === 'string' ? item.reason : '',
        }));
}

/**
 * 来源场景。优先级：显式 origin.sceneKey → 显式 chatKind/chatId →
 * source.chatId（旧插件的 chatId 本来就是 'group:…' / 'private:…'）→ legacy。
 */
function normalizeOrigin(raw, source, fallbackAt) {
    const given = raw && typeof raw === 'object' ? raw : {};
    const originSource = source && typeof source === 'object' ? source : {};
    const givenScene = typeof given.sceneKey === 'string' ? given.sceneKey.trim() : '';
    const parsedGiven = parseSceneKey(givenScene);
    const parsedSource = parseSceneKey(originSource.chatId);
    const givenKind = given.chatKind === 'group' || given.chatKind === 'private' ? given.chatKind : null;
    const givenChatId = stringOrNull(given.chatId);

    let sceneKey = parsedGiven?.sceneKey ?? givenScene;
    let chatKind = parsedGiven?.chatKind ?? givenKind;
    let chatId = parsedGiven?.chatId ?? givenChatId;
    if (sceneKey === '' && chatKind !== null && chatId !== null)
        sceneKey = `${chatKind}:${chatId}`;
    if (sceneKey === '' && parsedSource !== null) {
        sceneKey = parsedSource.sceneKey;
        chatKind = parsedSource.chatKind;
        chatId = parsedSource.chatId;
    }
    if (sceneKey === '')
        sceneKey = SCENE_LEGACY;
    if (chatKind === null || chatId === null) {
        const parsed = parseSceneKey(sceneKey);
        if (parsed !== null) {
            chatKind = parsed.chatKind;
            chatId = parsed.chatId;
        }
    }
    const at = typeof given.at === 'string' && Number.isFinite(Date.parse(given.at)) ? given.at : fallbackAt;
    return {
        sceneKey,
        chatKind,
        chatId,
        speakerQq: stringOrNull(given.speakerQq) ?? stringOrNull(originSource.qq),
        speakerName: stringOrNull(given.speakerName) ?? stringOrNull(originSource.name) ?? stringOrNull(originSource.nickname),
        messageId: stringOrNull(given.messageId),
        at,
    };
}

function normalizeVisibility(raw, category) {
    const given = raw && typeof raw === 'object' ? raw : {};
    const audience = AUDIENCES.includes(given.audience) ? given.audience : (category === 'core' ? 'public' : 'scene');
    return {
        audience,
        sceneBound: typeof given.sceneBound === 'boolean' ? given.sceneBound : audience !== 'public',
        ownerQq: stringOrNull(given.ownerQq),
        allowedSceneKeys: Array.isArray(given.allowedSceneKeys)
            ? given.allowedSceneKeys.filter(item => typeof item === 'string' && item !== '')
            : [],
        allowedUsers: Array.isArray(given.allowedUsers)
            ? given.allowedUsers.filter(item => typeof item === 'string' && item !== '').map(String)
            : [],
    };
}

function entrySceneKey(value) {
    const sceneKey = value?.origin?.sceneKey;
    return typeof sceneKey === 'string' && sceneKey !== '' ? sceneKey : SCENE_LEGACY;
}

function visibilityOf(value) {
    if (!value || typeof value !== 'object')
        return normalizeVisibility(undefined, undefined);
    const raw = value.visibility && typeof value.visibility === 'object'
        ? value.visibility
        : (typeof value.audience === 'string' ? value : undefined);
    const visibility = normalizeVisibility(raw, value.category);
    if (visibility.audience === 'owner' && visibility.ownerQq === null)
        visibility.ownerQq = stringOrNull(value.origin?.speakerQq);
    return visibility;
}

function scopeOf(value) {
    if (value && typeof value === 'object' && value.visibility && typeof value.visibility === 'object')
        return { visibility: visibilityOf(value), sceneKey: entrySceneKey(value) };
    return { visibility: visibilityOf(value), sceneKey: SCENE_LEGACY };
}

function isSuperset(left, right) {
    const set = new Set(left ?? []);
    return (right ?? []).every(item => set.has(item));
}

/**
 * 可见范围 a 是否覆盖 b（a 至少和 b 一样宽）。
 *
 * public 覆盖所有；不同 audience 之间只有 public 能覆盖；
 * scene 只覆盖同一场景（legacy 视为全场景）；master 只覆盖 master；
 * owner 只覆盖同一 ownerQq 的 owner；同 audience 时 sceneBound:false 更宽，
 * 且 allowed 集合必须是超集。
 */
export function visibilityCovers(a, b) {
    const left = scopeOf(a);
    const right = scopeOf(b);
    const va = left.visibility;
    const vb = right.visibility;
    if (va.audience === 'public')
        return true;
    if (va.audience !== vb.audience)
        return false;
    if (va.audience === 'owner' && String(va.ownerQq) !== String(vb.ownerQq))
        return false;
    if (va.audience === 'scene' && left.sceneKey !== SCENE_LEGACY && right.sceneKey !== left.sceneKey)
        return false;
    if (va.sceneBound !== false && vb.sceneBound === false)
        return false;
    return isSuperset(va.allowedSceneKeys, vb.allowedSceneKeys) && isSuperset(va.allowedUsers, vb.allowedUsers);
}

function sameScope(left, right) {
    return visibilityCovers(left, right) && visibilityCovers(right, left);
}

/**
 * 当前场景能否看到这条记忆。scene 为空时不隔离（旧调用方保持原行为）。
 * scene = { sceneKey, isMaster, speakerQq }
 */
export function isVisibleTo(entry, scene) {
    const visibility = visibilityOf(entry);
    // internal 只给关系/内部计数用：任何情况下都不注入 prompt。
    if (visibility.audience === 'internal')
        return false;
    if (!scene || typeof scene !== 'object')
        return true;
    const sceneKey = stringOrNull(scene.sceneKey);
    if (sceneKey === null)
        return true;
    const originScene = entrySceneKey(entry);
    const sameScene = originScene === sceneKey;
    const speakerQq = stringOrNull(scene.speakerQq) ?? '';
    const extraAllowed = visibility.allowedSceneKeys.includes(sceneKey)
        || (speakerQq !== '' && visibility.allowedUsers.includes(speakerQq));
    if (visibility.audience === 'public')
        return true;
    if (visibility.audience === 'master') {
        if (scene.isMaster !== true)
            return false;
        return visibility.sceneBound !== true || sameScene;
    }
    if (visibility.audience === 'owner') {
        if (visibility.ownerQq === null || speakerQq !== String(visibility.ownerQq))
            return false;
        return visibility.sceneBound !== true || sameScene;
    }
    // scene：同场景可见；迁移期 legacy 条目视为全场景可见；allowed* 只做额外汇入。
    if (sameScene || originScene === SCENE_LEGACY)
        return true;
    return extraAllowed;
}

function invisibilityReason(entry, scene) {
    const visibility = visibilityOf(entry);
    const speakerQq = stringOrNull(scene?.speakerQq) ?? '';
    if (visibility.audience === 'master' && scene?.isMaster !== true)
        return 'need-master';
    if (visibility.audience === 'owner' && (visibility.ownerQq === null || speakerQq !== String(visibility.ownerQq)))
        return 'need-owner';
    return 'scene-mismatch';
}

function factKeyOf(entry) {
    if (typeof entry?.factKey === 'string' && entry.factKey !== '')
        return entry.factKey;
    const category = CATEGORIES.includes(entry?.category) ? entry.category : 'note';
    return `${category}|${normalizeText(entry?.subject ?? '')}`;
}

/** 把任意版本的 notebook 归一化成 version 3，不改动传入对象。 */
export function migrateNotebook(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const entries = Array.isArray(source.entries) ? source.entries : [];
    const migrated = entries
        .filter(entry => entry && typeof entry === 'object' && typeof entry.text === 'string' && entry.text.trim() !== '')
        .map((entry, index) => {
            const authority = Object.hasOwn(AUTHORITY_RANK, entry.authority)
                ? entry.authority
                : (entry?.source?.qq === MASTER_QQ ? 'master' : 'member');
            const category = CATEGORIES.includes(entry.category) ? entry.category : 'note';
            const ts = typeof entry.ts === 'string' && Number.isFinite(Date.parse(entry.ts)) ? entry.ts : new Date(0).toISOString();
            const subject = typeof entry.subject === 'string' ? entry.subject : '';
            const origin = normalizeOrigin(entry.origin, entry.source, ts);
            const visibility = visibilityOf({ ...entry, category, origin });
            return {
                id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : `nb_legacy_${index}`,
                ts,
                category,
                subject,
                text: entry.text.trim(),
                keywords: Array.isArray(entry.keywords) ? entry.keywords.filter(word => typeof word === 'string').slice(0, 24) : [],
                authority,
                confidence: Number.isFinite(Number(entry.confidence)) ? Number(entry.confidence) : (entry.authority ? 1 : 0.7),
                status: STATUSES.includes(entry.status) ? entry.status : 'active',
                factKey: factKeyOf({ ...entry, category, subject }),
                origin,
                visibility,
                sensitivity: normalizeSensitivity(entry.sensitivity, category),
                derivedFrom: normalizeIdList(entry.derivedFrom),
                visibilityHistory: normalizeHistory(entry.visibilityHistory),
                ttlHours: Number.isFinite(Number(entry.ttlHours)) && Number(entry.ttlHours) > 0 ? Number(entry.ttlHours) : null,
                pinned: entry.pinned === true,
                source: entry.source && typeof entry.source === 'object' ? { ...entry.source } : {},
                // 记录人身份：迁移时原样保留，避免一次读写就把归属信息丢掉。
                recordedBy: entry.recordedBy && typeof entry.recordedBy === 'object' ? { ...entry.recordedBy } : null,
                updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : undefined,
                supersededBy: stringOrNull(entry.supersededBy),
                disputedBy: stringOrNull(entry.disputedBy),
                sourceRevoked: entry.sourceRevoked !== null && typeof entry.sourceRevoked === 'object'
                    ? { ...entry.sourceRevoked }
                    : null,
                ...(entry.needsReview === true ? { needsReview: true } : {}),
                // 关系类记忆的私有字段：只供 relationToneOf 使用，不参与常规检索。
                ...(category === 'relation'
                    ? {
                        score: Number.isFinite(Number(entry.score)) ? Number(entry.score) : 50,
                        impression: typeof entry.impression === 'string'
                            ? entry.impression
                            : entry.text.trim().slice(0, 80),
                        evidence: Array.isArray(entry.evidence)
                            ? entry.evidence
                                .filter(item => item && typeof item === 'object')
                                .slice(-5)
                                .map(item => ({
                                    messageId: item.messageId ?? null,
                                    text: String(item.text ?? '').slice(0, 120),
                                    at: typeof item.at === 'string' ? item.at : null,
                                }))
                            : [],
                    }
                    : {}),
            };
        });
    return {
        version: 3,
        entries: migrated,
        updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
    };
}

/** 关键词：显式 tags + 文本里较长的 token，去重限量。 */
export function deriveKeywords(entry, limit = 16) {
    const explicit = Array.isArray(entry?.keywords) ? entry.keywords : [];
    const tokens = tokenize(entryText(entry))
        .filter(token => token.length >= 2)
        .sort((left, right) => right.length - left.length);
    const out = [];
    for (const token of [...explicit, ...tokens]) {
        if (typeof token !== 'string' || token === '')
            continue;
        if (out.includes(token))
            continue;
        out.push(token);
        if (out.length >= limit)
            break;
    }
    return out;
}

function buildIndex(entries) {
    const postings = new Map();
    const tokenSets = new Map();
    for (const entry of entries) {
        const tokens = new Set([...tokenize(entryText(entry)), ...(entry.keywords ?? [])]);
        tokenSets.set(entry.id, tokens);
        for (const token of tokens) {
            let bucket = postings.get(token);
            if (bucket === undefined) {
                bucket = new Set();
                postings.set(token, bucket);
            }
            bucket.add(entry.id);
        }
    }
    return { postings, tokenSets, total: Math.max(1, entries.length) };
}

function idfOf(index, token) {
    const df = index.postings.get(token)?.size ?? 0;
    return Math.log((index.total + 1) / (df + 1)) + 1;
}

function recencyWeight(ts, now) {
    const at = Date.parse(String(ts ?? ''));
    if (!Number.isFinite(at))
        return 0.5;
    const days = Math.max(0, (now - at) / 86_400_000);
    return 0.55 + 0.45 * Math.exp(-days / 45);
}

/**
 * 按相关度挑长期记忆。query 一般是本轮最新消息加最近几条。
 * 纯本地计算，500 条以内应在毫秒级。
 *
 * options.scene 为空时不隔离（迁移期旧调用方保持原行为）；给出
 * { sceneKey, isMaster, speakerQq } 时先按可见范围过滤，再挑 core 和打分。
 * 返回 { entries, filtered }，filtered 只包含因可见性被挡掉的条目。
 * options.withScores 为 true 时额外返回 scores（{ [id]: 分数 }，core 记 0），
 * 供 proxy 写访问日志；不传时返回形状不变。
 */
export function selectMemoryEntries(notebook, queryText, options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const limit = Math.max(1, Math.min(20, Number(options.limit) || 8));
    const scene = options.scene && typeof options.scene === 'object' ? options.scene : null;
    const withScores = options.withScores === true;
    const scoreById = new Map();
    /** 统一收口返回形状：只有 withScores 时才多带一个 scores。 */
    const result = entries => {
        if (!withScores)
            return { entries, filtered };
        const scores = {};
        for (const entry of entries)
            scores[entry.id] = scoreById.get(entry.id) ?? 0;
        return { entries, filtered, scores };
    };
    const candidates = (Array.isArray(notebook?.entries) ? notebook.entries : [])
        .filter(entry => entry.category !== 'relation')
        .filter(entry => (entry.status === 'active' || entry.status === 'contested') && !isExpired(entry, now));
    const filtered = [];
    const active = [];
    for (const entry of candidates) {
        if (scene !== null && !isVisibleTo(entry, scene)) {
            filtered.push({ id: entry.id, audience: visibilityOf(entry).audience, reason: invisibilityReason(entry, scene) });
            continue;
        }
        active.push(entry);
    }
    if (active.length === 0)
        return result([]);
    // 核心条目不依赖关键词命中：身份、称呼、硬边界这类内容必须每轮都在。
    const core = active
        .filter(entry => entry.pinned === true || entry.category === 'core')
        .sort((left, right) => String(right.ts).localeCompare(String(left.ts)))
        .slice(0, 2);
    if (withScores) {
        for (const entry of core)
            scoreById.set(entry.id, 0);
    }
    const queryTokens = tokenize(queryText ?? '');
    if (queryTokens.length === 0)
        return result(core.slice(0, limit));
    const index = buildIndex(active);
    const querySet = new Set(queryTokens);
    const scored = [];
    for (const entry of active) {
        const tokens = index.tokenSets.get(entry.id) ?? new Set();
        const keywordSet = new Set((entry.keywords ?? []).map(keyword => normalizeText(keyword)));
        let match = 0;
        let hits = 0;
        for (const token of querySet) {
            if (!tokens.has(token))
                continue;
            hits += 1;
            match += idfOf(index, token) * (keywordSet.has(token) ? 2.2 : 1);
        }
        if (hits === 0)
            continue;
        // 长句里一个偶然命中的 bigram 不该压过真正相关的条目。
        match *= Math.min(1, 0.45 + hits * 0.18);
        const subject = normalizeText(entry.subject);
        if (subject !== '' && querySet.has(subject))
            match += 3;
        let score = match * (AUTHORITY_WEIGHT[authorityOf(entry)] ?? 0.7) * recencyWeight(entry.ts, now);
        if (entry.pinned === true)
            score += 2;
        if (score < 0.75)
            continue;
        scored.push({ entry, score });
    }
    scored.sort((left, right) => right.score - left.score || String(right.entry.ts).localeCompare(String(left.entry.ts)));
    if (withScores) {
        for (const item of scored) {
            // core 已在前面记 0，别被关键词分数覆盖。
            if (!scoreById.has(item.entry.id))
                scoreById.set(item.entry.id, item.score);
        }
    }
    const seen = new Set();
    const picked = [];
    for (const entry of [...core, ...scored.map(item => item.entry)]) {
        if (seen.has(entry.id))
            continue;
        const fingerprint = normalizeText(entry.text);
        if (seen.has(fingerprint))
            continue;
        seen.add(entry.id);
        seen.add(fingerprint);
        picked.push(entry);
        if (picked.length >= limit)
            break;
    }
    return result(picked);
}

export function searchEntries(notebook, options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const limit = Math.max(1, Math.min(50, Number(options.limit) || 10));
    const category = typeof options.category === 'string' && options.category !== '' ? options.category : '';
    const subject = normalizeText(options.subject ?? '');
    const query = normalizeText(options.query ?? '');
    let entries = (Array.isArray(notebook?.entries) ? notebook.entries : [])
        .filter(entry => entry.status !== 'superseded' && entry.status !== 'expired' && !isExpired(entry, now));
    // 工具化检索不能绕过可见性：qq_notebook read/search 以前直接返回全库，
    // 任何人都能读到 private / master / owner 条目。scene 为空时保持旧行为
    // （迁移与只读导出用），带了场景就按 isVisibleTo 过滤，internal 一律不出。
    if (options.scene && typeof options.scene === 'object')
        entries = entries.filter(entry => isVisibleTo(entry, options.scene));
    if (category !== '')
        entries = entries.filter(entry => entry.category === category);
    if (subject !== '')
        entries = entries.filter(entry => normalizeText(entry.subject).includes(subject));
    if (query !== '')
        entries = entries.filter(entry => normalizeText(entryText(entry)).includes(query));
    return entries.slice(-limit).reverse();
}

/**
 * 7.4 冲突分治：先定类，再决定“覆盖 / 共存 / 挂起”。
 *
 * command   主人明确的长期命令（“记住/以后都/别再…”）——压过一切
 * identity  稳定身份（user/core）——绝不覆盖，冲突挂 disputed 私信主人
 * relation  主观评价——不覆盖，按时间衰减累加（由 upsertRelation 维护）
 * knowledge 可共存知识（knowledge/meme）——多版本并存，检索时都给
 * volatile  时效性事实（behavior/note）——最新的赢，旧条目留痕（superseded）
 * unknown   判不出——挂 disputed，交主人裁决
 */
export function classifyConflict({ category, authority, text } = {}) {
    const value = String(text ?? '').trim();
    if (authority === 'master' && /^(记住|以后都|以后不|别再|必须|不许|只能)/u.test(value))
        return 'command';
    switch (category) {
        case 'user':
        case 'core':
            return 'identity';
        case 'relation':
            return 'relation';
        case 'knowledge':
        case 'meme':
            return 'knowledge';
        case 'behavior':
        case 'note':
            return 'volatile';
        default:
            return 'unknown';
    }
}

/**
 * 写入/合并一条记忆。
 *
 * - 完全相同 → duplicate
 * - 同一 factKey 且文本冲突时，按“权威 + 可见范围”判定：
 *   新权威更高且范围覆盖旧 → 旧 superseded；
 *   新权威更高但范围更窄 → 新 active，旧 contested（保留在旧范围）；
 *   新权威更低 → 新 disputed（保留，但不参与常规检索）；
 *   权威相同范围相同 → 旧 superseded；范围不同 → 旧 contested
 * - 其余 → added
 */
export function upsertEntry(notebook, incoming, options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const at = new Date(now).toISOString();
    const text = String(incoming?.text ?? '').trim();
    if (text === '')
        throw new Error('upsertEntry: text 必填');
    const category = CATEGORIES.includes(incoming?.category) ? incoming.category : 'note';
    const subject = String(incoming?.subject ?? '').trim();
    const authority = Object.hasOwn(AUTHORITY_RANK, incoming?.authority) ? incoming.authority : 'inferred';
    if (!Array.isArray(notebook.entries))
        notebook.entries = [];
    const origin = normalizeOrigin(incoming?.origin, incoming?.source, at);
    const visibility = normalizeVisibility(incoming?.visibility, category);
    if (visibility.audience === 'owner' && visibility.ownerQq === null && origin.speakerQq !== null)
        visibility.ownerQq = origin.speakerQq;
    const factKey = typeof incoming?.factKey === 'string' && incoming.factKey !== ''
        ? incoming.factKey
        : `${category}|${normalizeText(subject)}`;
    const normalized = normalizeText(text);
    const exact = notebook.entries.find(entry => entry.status !== 'superseded'
        && factKeyOf(entry) === factKey
        && normalizeText(entry.text) === normalized);
    if (exact !== undefined)
        return { action: 'duplicate', id: exact.id, total: notebook.entries.length };

    const newRank = AUTHORITY_RANK[authority];
    const current = { visibility, origin };
    const conflictClass = classifyConflict({ category, authority, text });
    const similarAll = notebook.entries.filter(entry => entry.status === 'active'
        && factKeyOf(entry) === factKey
        && isConflict(entry.text, text));
    // owner-only 覆写：不是 owner 本人、也不是主人时，任何写入都不能碰 owner 条目
    // （好感度/主观评价只留内部，别人改不了）。
    const ownerLocked = similarAll.find((entry) => {
        const visible = visibilityOf(entry);
        return visible.audience === 'owner' && visible.ownerQq !== null
            && String(origin.speakerQq ?? '') !== String(visible.ownerQq)
            && authority !== 'master';
    });
    if (ownerLocked !== undefined)
        return { action: 'forbidden', reason: 'owner-only', ownerQq: visibilityOf(ownerLocked).ownerQq };
    // 7.4 分治：knowledge/relation 共存；command/volatile 最新覆盖；
    // identity/unknown 不覆盖，挂 disputed 交给主人裁决。
    const similar = conflictClass === 'knowledge' || conflictClass === 'relation' ? [] : similarAll;
    const forceSupersede = conflictClass === 'command' || conflictClass === 'volatile';
    const forceDispute = conflictClass === 'identity' || conflictClass === 'unknown';

    const superseded = [];
    const contested = [];
    let disputedBy = null;
    for (const entry of similar) {
        if (forceSupersede) {
            superseded.push({ entry, reason: conflictClass + ':latest-wins' });
            continue;
        }
        if (forceDispute) {
            // 稳定身份：普通成员改不动，挂 disputed 交给主人；
            // 主人本人写入就是 owner 的决定，直接覆盖并留痕。
            if (conflictClass === 'identity' && authority === 'master') {
                superseded.push({ entry, reason: 'identity:owner-override' });
                continue;
            }
            disputedBy = entry.id;
            break;
        }
        const oldRank = AUTHORITY_RANK[authorityOf(entry)];
        if (newRank < oldRank) {
            disputedBy = entry.id;
            break;
        }
        if (newRank > oldRank) {
            if (visibilityCovers(current, entry))
                superseded.push({ entry, reason: 'higher-authority-covers' });
            else
                contested.push({ entry, reason: 'higher-authority-narrower' });
            continue;
        }
        // 权威相同：范围相同按时间覆盖，范围不同视为新范围更窄。
        if (sameScope(current, entry))
            superseded.push({ entry, reason: 'equal-authority-same-scope' });
        else
            contested.push({ entry, reason: 'equal-authority-different-scope' });
    }

    for (const item of superseded) {
        item.entry.status = 'superseded';
        item.entry.updatedAt = at;
        item.entry.supersededBy = 'pending';
    }
    for (const item of contested) {
        item.entry.status = 'contested';
        item.entry.updatedAt = at;
    }

    const keywords = deriveKeywords(incoming);
    // keywords 必填：写不出来的记忆检索不到，等于没记。调用方要么给 text
    // 足够具体，要么显式传 keywords。
    if (keywords.length === 0)
        throw new Error('upsertEntry: keywords 必填（内容太短或全是虚词，请补 keywords）');
    const entry = {
        id: `nb_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        ts: at,
        category,
        subject,
        text,
        keywords,
        authority,
        confidence: Number.isFinite(Number(incoming?.confidence))
            ? Number(incoming.confidence)
            : (disputedBy !== null ? 0.5 : (authority === 'inferred' ? 0.7 : 0.95)),
        status: disputedBy !== null ? 'disputed' : 'active',
        factKey,
        origin,
        visibility,
        sensitivity: normalizeSensitivity(incoming?.sensitivity, category),
        derivedFrom: normalizeIdList(incoming?.derivedFrom),
        visibilityHistory: normalizeHistory(incoming?.visibilityHistory),
        ttlHours: Number.isFinite(Number(incoming?.ttlHours)) && Number(incoming.ttlHours) > 0 ? Number(incoming.ttlHours) : null,
        pinned: disputedBy === null && incoming?.pinned === true,
        source: incoming?.source && typeof incoming.source === 'object' ? { ...incoming.source } : {},
        // 谁记录的（发起人身份），与 authority（这条事实关于谁）分开保存。
        recordedBy: incoming?.recordedBy && typeof incoming.recordedBy === 'object' ? { ...incoming.recordedBy } : null,
        updatedAt: at,
        supersededBy: null,
        disputedBy,
    };
    if (entry.status === 'active') {
        for (const old of notebook.entries) {
            if (old.supersededBy === 'pending')
                old.supersededBy = entry.id;
        }
    }
    notebook.entries.push(entry);
    notebook.entries = notebook.entries.slice(-800);
    notebook.updatedAt = at;

    const action = entry.status === 'disputed'
        ? 'disputed'
        : contested.length > 0 ? 'contested'
            : superseded.length > 0 ? 'superseded'
                : similarAll.length > 0 ? 'coexist' : 'added';
    const result = { action, conflictClass, id: entry.id, total: notebook.entries.length };
    if (entry.status === 'disputed' && disputedBy !== null) {
        result.conflictsWith = disputedBy;
        result.needsMaster = true;
        result.conflict = { withId: disputedBy, reason: conflictClass + ':needs-master', outcome: 'disputed' };
    } else if (contested.length > 0) {
        result.conflict = { withId: contested[0].entry.id, reason: contested[0].reason, outcome: 'contested' };
    } else if (superseded.length > 0) {
        result.conflict = { withId: superseded[0].entry.id, reason: superseded[0].reason, outcome: 'superseded' };
        result.superseded = superseded.length;
    }
    return result;
}

const RELATION_NEUTRAL = 50;
const RELATION_MAX_DELTA = 3;
const RELATION_HALF_LIFE_DAYS = 30;
const RELATION_TONES = ['熟悉', '一般', '生疏'];

/** 关系分按半衰期回归中性（默认 30 天回到 50）。纯函数。 */
export function decayRelationScore(score, updatedAt, now = Date.now(), options = {}) {
    const neutral = Number.isFinite(Number(options.neutral)) ? Number(options.neutral) : RELATION_NEUTRAL;
    const halfLifeDays = Number(options.halfLifeDays) > 0
        ? Number(options.halfLifeDays)
        : RELATION_HALF_LIFE_DAYS;
    const base = Number.isFinite(Number(score)) ? Number(score) : neutral;
    const at = typeof updatedAt === 'number' ? updatedAt : Date.parse(String(updatedAt ?? ''));
    if (!Number.isFinite(at))
        return base;
    const days = Math.max(0, (now - at) / 86_400_000);
    return neutral + (base - neutral) * Math.pow(0.5, days / halfLifeDays);
}

/** 找某人的关系条目（可能有多条历史，取最新一条 active）。 */
export function relationEntryOf(notebook, subjectId) {
    const key = String(subjectId ?? '').trim();
    if (key === '')
        return undefined;
    const entries = Array.isArray(notebook?.entries) ? notebook.entries : [];
    const matches = entries.filter(entry => entry?.category === 'relation'
        && entry.status === 'active'
        && (String(entry.subject) === key || entry.factKey === 'relation|' + key));
    if (matches.length === 0)
        return undefined;
    return matches.sort((left, right) => String(right.updatedAt ?? right.ts).localeCompare(String(left.updatedAt ?? left.ts)))[0];
}

/**
 * 写入/更新一段关系。
 *
 * 约束：
 *   - 单次变动不超过 maxDelta（默认 3），避免一次对话把分数拉爆；
 *   - 写入前先按半衰期把旧分回归中性，久不联系会自然淡化；
 *   - impression/evidence 只留在条目里，audience 固定 internal，检索层永不注入。
 */
export function upsertRelation(notebook, incoming, options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const at = new Date(now).toISOString();
    const subjectId = String(incoming?.subjectId ?? '').trim();
    if (subjectId === '')
        throw new Error('upsertRelation: subjectId 必填');
    if (!Array.isArray(notebook.entries))
        notebook.entries = [];
    const neutral = Number.isFinite(Number(options.neutral)) ? Number(options.neutral) : RELATION_NEUTRAL;
    const maxDelta = Number.isFinite(Number(options.maxDelta)) ? Number(options.maxDelta) : RELATION_MAX_DELTA;
    const halfLifeDays = Number.isFinite(Number(options.halfLifeDays))
        ? Number(options.halfLifeDays)
        : RELATION_HALF_LIFE_DAYS;

    const existing = relationEntryOf(notebook, subjectId);
    const base = existing === undefined
        ? neutral
        : decayRelationScore(existing.score, existing.updatedAt ?? existing.ts, now, { neutral, halfLifeDays });
    const rawDelta = Number(incoming?.delta ?? 0);
    const delta = Math.min(maxDelta, Math.max(-maxDelta, Number.isFinite(rawDelta) ? rawDelta : 0));
    const score = Math.min(100, Math.max(0, Math.round(base + delta)));
    const impression = String(incoming?.impression ?? existing?.impression ?? '')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 80);

    const evidence = Array.isArray(existing?.evidence) ? [...existing.evidence] : [];
    const proof = incoming?.evidence;
    if (proof !== null && proof !== undefined) {
        evidence.push({
            messageId: proof.messageId ?? null,
            text: String(proof.text ?? '').slice(0, 120),
            at,
        });
        while (evidence.length > 5)
            evidence.shift();
    }

    if (existing !== undefined) {
        existing.score = score;
        existing.impression = impression;
        existing.text = impression;
        existing.evidence = evidence;
        existing.updatedAt = at;
        notebook.updatedAt = at;
        return { id: existing.id, score, delta };
    }

    const origin = normalizeOrigin({ sceneKey: incoming?.sceneKey }, { qq: subjectId }, at);
    const entry = {
        id: `nb_rel_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        ts: at,
        category: 'relation',
        subject: subjectId,
        text: impression,
        keywords: deriveKeywords({ text: impression }),
        authority: 'inferred',
        confidence: 0.6,
        status: 'active',
        factKey: 'relation|' + subjectId,
        origin,
        visibility: {
            audience: 'internal',
            sceneBound: true,
            ownerQq: null,
            allowedSceneKeys: [],
            allowedUsers: [],
        },
        sensitivity: 2,
        derivedFrom: [],
        visibilityHistory: [],
        ttlHours: null,
        pinned: false,
        source: { system: 'relation' },
        updatedAt: at,
        score,
        impression,
        evidence,
    };
    notebook.entries.push(entry);
    notebook.entries = notebook.entries.slice(-800);
    notebook.updatedAt = at;
    return { id: entry.id, score, delta };
}

/**
 * 把关系分压缩成行为倾向，只返回「熟悉 / 一般 / 生疏」三个词。
 * 分数和 impression 绝不出这个函数。
 */
export function relationToneOf(notebook, subjectId, options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const entry = relationEntryOf(notebook, subjectId);
    if (entry === undefined)
        return '';
    const score = decayRelationScore(entry.score, entry.updatedAt ?? entry.ts, now, options);
    if (score >= 65)
        return RELATION_TONES[0];
    if (score <= 35)
        return RELATION_TONES[2];
    return RELATION_TONES[1];
}

function findEntry(notebook, id) {
    const entries = Array.isArray(notebook?.entries) ? notebook.entries : [];
    return entries.find(entry => entry?.id === id);
}

function writeVisibilityChange(entry, next, { at, by, reason }) {
    const before = visibilityOf(entry);
    entry.visibility = next;
    entry.visibilityHistory = [
        ...normalizeHistory(entry.visibilityHistory),
        { at, by, from: before, to: { ...next }, reason },
    ];
    entry.updatedAt = at;
}

/**
 * 升级可见范围：仅主人可执行，写 visibilityHistory。
 * 升级不级联——避免私事被派生条目带出去。
 */
export function promoteVisibility(notebook, id, patch = {}, options = {}) {
    if (options.isMaster !== true)
        return { ok: false, error: '仅主人可升级' };
    const entry = findEntry(notebook, id);
    if (entry === undefined)
        return { ok: false, error: '条目不存在' };
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const at = new Date(now).toISOString();
    const next = normalizeVisibility({ ...visibilityOf(entry), ...patch }, entry.category);
    writeVisibilityChange(entry, next, {
        at,
        by: stringOrNull(options.by) ?? MASTER_QQ,
        reason: typeof options.reason === 'string' ? options.reason : '',
    });
    return { ok: true, id, visibility: next };
}

/**
 * 降级可见范围：归属人或主人可执行，写历史后对派生条目做降级级联。
 */
export function downgradeVisibility(notebook, id, patch = {}, options = {}) {
    const entry = findEntry(notebook, id);
    if (entry === undefined)
        return { ok: false, error: '条目不存在' };
    const visibility = visibilityOf(entry);
    const by = stringOrNull(options.by) ?? '';
    const allowed = options.isMaster === true
        || (visibility.ownerQq !== null && by !== '' && by === String(visibility.ownerQq));
    if (!allowed)
        return { ok: false, error: '仅主人或归属人可降级' };
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const at = new Date(now).toISOString();
    const next = normalizeVisibility({ ...visibility, ...patch }, entry.category);
    writeVisibilityChange(entry, next, {
        at,
        by: by !== '' ? by : 'master',
        reason: typeof options.reason === 'string' ? options.reason : '',
    });
    const cascade = propagateVisibility(notebook, id, { now });
    return { ok: true, id, visibility: next, cascaded: cascade.cascaded ?? [] };
}

/**
 * 沿 derivedFrom 反向遍历：派生条目的可见范围如果比来源更宽，降到与来源同级，
 * 标 needsReview 并写一条 by:'cascade' 的历史。
 */
export function propagateVisibility(notebook, sourceId, options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const at = new Date(now).toISOString();
    const source = findEntry(notebook, sourceId);
    if (source === undefined)
        return { ok: false, cascaded: [] };
    const entries = Array.isArray(notebook.entries) ? notebook.entries : [];
    const cascaded = [];
    const visited = new Set([source.id]);
    const queue = [source];
    while (queue.length > 0) {
        const current = queue.shift();
        for (const entry of entries) {
            if (visited.has(entry.id) || !Array.isArray(entry.derivedFrom) || !entry.derivedFrom.includes(current.id))
                continue;
            visited.add(entry.id);
            if (visibilityCovers(entry, current) && !sameScope(entry, current)) {
                const next = normalizeVisibility(visibilityOf(current), entry.category);
                writeVisibilityChange(entry, next, { at, by: 'cascade', reason: 'derived-from-broader-scope' });
                entry.needsReview = true;
                cascaded.push(entry.id);
            }
            queue.push(entry);
        }
    }
    return { ok: true, cascaded };
}

/** 遗忘：标记 expired，并对派生条目做降级级联。 */
export function expireEntry(notebook, id, options = {}) {
    const entry = findEntry(notebook, id);
    if (entry === undefined)
        return { ok: false, error: '条目不存在' };
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const at = new Date(now).toISOString();
    entry.status = 'expired';
    entry.updatedAt = at;
    const cascade = propagateVisibility(notebook, id, { now });
    return { ok: true, id, cascaded: cascade.cascaded ?? [] };
}

/** 原文保留天数：超过后只留摘要，原文走归档文件，可回滚。 */
export const RAW_RETENTION_DAYS = 30;

/**
 * 30 天原文降级（纯函数）。
 *
 * 到期条目把 text 换成摘要：有 summary 用 summary，否则截首句；
 * 原文放进返回的 archive，调用方追加到 notebook-archive.jsonl 即可回滚。
 * 已经降级过的条目不重复处理。
 */
export function degradeExpiredRawText(notebook, options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const days = Number(options.days) > 0 ? Number(options.days) : RAW_RETENTION_DAYS;
    const cutoff = now - days * 86_400_000;
    const archive = [];
    let changed = 0;
    for (const entry of notebook?.entries ?? []) {
        if (!entry || entry.rawDegradedAt)
            continue;
        const at = Date.parse(String(entry.ts ?? ''));
        if (!Number.isFinite(at) || at > cutoff)
            continue;
        const original = String(entry.text ?? '');
        if (original === '')
            continue;
        const summary = typeof entry.summary === 'string' && entry.summary.trim() !== ''
            ? entry.summary.trim()
            : ([...original].length <= 60 ? original : [...original].slice(0, 60).join('') + '…');
        if (summary === original)
            continue;
        entry.summary = summary;
        entry.text = summary;
        entry.rawDegradedAt = new Date(now).toISOString();
        entry.updatedAt = entry.rawDegradedAt;
        archive.push({
            id: entry.id,
            ts: entry.ts,
            category: entry.category,
            subject: entry.subject,
            text: original,
            degradedAt: entry.rawDegradedAt,
        });
        changed += 1;
    }
    return { changed, archive };
}

/**
 * 只读导出（不改 notebook）。
 *
 * owner 条目默认不导出；主人导出时带 ownerQq，便于只读留档。
 * 输出只含可读字段，不含评分明细等内部结构。
 */
export function exportNotebookReadOnly(notebook, options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const includeOwner = options.isMaster === true || options.includeOwner === true;
    const entries = (notebook?.entries ?? [])
        .filter(entry => entry && (includeOwner || visibilityOf(entry).audience !== 'owner'))
        .map((entry) => {
            const visibility = visibilityOf(entry);
            return {
                id: entry.id,
                ts: entry.ts,
                category: entry.category,
                subject: entry.subject,
                text: entry.text,
                summary: entry.summary ?? null,
                keywords: Array.isArray(entry.keywords) ? entry.keywords : [],
                authority: entry.authority,
                confidence: entry.confidence,
                status: entry.status,
                factKey: entry.factKey,
                origin: entry.origin,
                visibility: {
                    audience: visibility.audience,
                    sceneBound: visibility.sceneBound,
                    ownerQq: includeOwner ? visibility.ownerQq : null,
                },
                sensitivity: entry.sensitivity,
                ttlHours: entry.ttlHours,
                updatedAt: entry.updatedAt,
                supersededBy: entry.supersededBy ?? null,
                disputedBy: entry.disputedBy ?? null,
            };
        });
    return { version: 3, exportedAt: new Date(now).toISOString(), readOnly: true, count: entries.length, entries };
}

/**
 * 撤回来源：把 origin.messageId 命中撤回事件的条目标成 sourceRevoked + expired。
 *
 * 纯函数，不写文件；由 proxy 在加载 notebook 后调用。条目不会被删除，
 * 只是退出检索（selectMemoryEntries 会跳过 expired），保留可追溯。
 * 派生条目只标 needsReview，不自动删除，避免误伤。
 */
export function applyRevocations(notebook, events, options = {}) {
    const list = Array.isArray(events) ? events : [];
    const entries = Array.isArray(notebook?.entries) ? notebook.entries : [];
    const byMessage = new Map();
    for (const event of list) {
        const messageId = stringOrNull(event?.messageId);
        if (messageId !== null)
            byMessage.set(messageId, event);
    }
    if (byMessage.size === 0)
        return { ok: true, changed: [], cascaded: [] };

    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const fallbackAt = new Date(now).toISOString();
    const changed = [];
    for (const entry of entries) {
        const messageId = stringOrNull(entry?.origin?.messageId);
        if (messageId === null || !byMessage.has(messageId))
            continue;
        if (entry.status === 'expired' && entry.sourceRevoked !== undefined && entry.sourceRevoked !== null)
            continue;
        const event = byMessage.get(messageId);
        entry.status = 'expired';
        entry.updatedAt = stringOrNull(event?.at) ?? fallbackAt;
        entry.sourceRevoked = {
            at: stringOrNull(event?.at) ?? fallbackAt,
            by: stringOrNull(event?.operatorId),
            messageId,
            reason: 'source-recalled',
        };
        changed.push(entry.id);
    }

    // 派生条目：沿 derivedFrom 传递 needsReview，不改状态。
    const affected = new Set(changed);
    const cascaded = [];
    let queue = [...changed];
    while (queue.length > 0) {
        const next = [];
        for (const entry of entries) {
            if (!Array.isArray(entry.derivedFrom) || affected.has(entry.id))
                continue;
            if (!entry.derivedFrom.some(id => affected.has(id)))
                continue;
            affected.add(entry.id);
            entry.needsReview = true;
            next.push(entry.id);
            cascaded.push(entry.id);
        }
        queue = next;
    }
    return { ok: true, changed, cascaded };
}

export function authorityFromRole(role) {
    if (role === 'admin' || role === 'master')
        return 'master';
    if (role === 'member')
        return 'member';
    return 'inferred';
}

const AUTHORITY_LABEL = { master: '主人', admin: '管理', member: '群友', inferred: '推测' };

/**
 * 常驻记忆索引（100–200 token）：只列“记过什么主题”，细节留给 memory_search。
 *
 * 没有它，模型不知道自己有记忆可用；有了它，问旧事时可以主动查一次。
 * scene 传 null 表示按旧行为不做隔离（迁移期），传对象则严格按可见性过滤。
 */
export function memoryIndexText(notebook, scene, options = {}) {
    const maxChars = Number(options.maxChars) > 0 ? Number(options.maxChars) : 520;
    const entries = (notebook?.entries ?? []).filter(entry => entry
        && (entry.status === 'active' || entry.status === 'contested')
        && entry.category !== 'relation'
        && (scene === null || scene === undefined || isVisibleTo(entry, scene)));
    const subjects = new Map();
    const keywords = new Map();
    for (const entry of entries) {
        const subject = String(entry.subject ?? '').trim();
        if (subject !== '')
            subjects.set(subject, (subjects.get(subject) ?? 0) + 1);
        for (const word of Array.isArray(entry.keywords) ? entry.keywords : []) {
            const key = String(word).trim();
            if (key.length >= 2)
                keywords.set(key, (keywords.get(key) ?? 0) + 1);
        }
    }
    const topSubjects = [...subjects].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([value]) => value);
    const topKeywords = [...keywords].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 24).map(([value]) => value);
    if (topSubjects.length === 0 && topKeywords.length === 0)
        return '';
    let text = '## 记忆索引（这里只有主题，细节用 memory_search 查）';
    if (topSubjects.length > 0)
        text += '\n- 记过的人/对象：' + topSubjects.join('、');
    if (topKeywords.length > 0)
        text += '\n- 关键词：' + topKeywords.join('、');
    if (text.length > maxChars)
        text = [...text].slice(0, maxChars).join('') + '…';
    return text;
}

export function formatMemorySection(entries, options = {}) {
    const maxChars = Math.max(400, Number(options.maxChars) || 2400);
    // 第二道拦截：即便上游传错，relation / internal 条目也不进 prompt。
    const safe = Array.isArray(entries)
        ? entries.filter(entry => entry?.category !== 'relation' && visibilityOf(entry).audience !== 'internal')
        : [];
    if (safe.length === 0)
        return '';
    const lines = ['## 长期记忆（自动挑出的相关条目；只作背景，不要整段复述，不要说“根据我的记忆”）'];
    for (const entry of safe) {
        const label = entry.authority === 'master' ? '主人' : AUTHORITY_LABEL[authorityOf(entry)] ?? '群友';
        const subject = entry.subject !== '' ? entry.subject + '：' : '';
        const text = String(entry.text ?? '').replace(/\s+/gu, ' ').slice(0, 160);
        // contested：新说法范围更窄，旧条目只在旧范围可见；标出来让主人确认。
        const pending = entry.status === 'contested' ? `（待主人确认，来源：${entrySceneKey(entry)}）` : '';
        lines.push(`- [${label}${entry.category === 'core' ? '/核心' : ''}] ${subject}${text}${pending}`);
    }
    let out = lines.join('\n');
    if (out.length > maxChars)
        out = out.slice(0, maxChars) + '…';
    return out;
}

/** 每轮重算的工作记忆：谁在说话、是否主人、最近被纠正过什么。 */
export function workingMemoryText(context = {}) {
    const lines = [];
    const {
        chatKind = '', chatId = '', speaker = '', speakerQq = '', isMaster = false,
        recentUserTexts = [],
    } = context;
    if (chatKind !== '' || chatId !== '') {
        // 旧插件群里拿不到群号；不要输出“群 ”这种残缺文案。
        const where = chatKind === 'group'
            ? (chatId === '' ? '群聊' : '群 ' + chatId)
            : chatKind === 'private'
                ? (chatId === '' ? '私聊' : '私聊 ' + chatId)
                : chatId;
        lines.push(`- 当前会话：${where}`);
    }
    if (speaker !== '' || speakerQq !== '') {
        const identity = speakerQq === MASTER_QQ
            ? `，唯一主人${MASTER_NAME}`
            : `，不是主人（主人是${MASTER_NAME}(${MASTER_QQ})）`;
        lines.push(`- 当前说话人：${speaker || '未知'}${speakerQq !== '' ? `(${speakerQq})` : ''}${identity}`);
    }
    const correctionRe = /(不是|不对|错了|别叫|不要叫|记错|说过|应该是|你搞错|搞混|还在这么说|叫错)/u;
    const corrections = recentUserTexts
        .filter(text => typeof text === 'string' && correctionRe.test(text))
        .slice(-2)
        .map(text => text.replace(/\s+/gu, ' ').slice(0, 70));
    for (const correction of corrections)
        lines.push(`- 最近被纠正：${correction}`);
    return lines.length > 0 ? '## 本轮工作记忆\n' + lines.join('\n') : '';
}
