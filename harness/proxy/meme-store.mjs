/**
 * 梗库存储与检索：memes.jsonl 的唯一读取口 + 按需检索 + 可撤销状态流转。
 *
 * 边界（和 meme-design.md 对齐）：
 * - 只读检索，不写 notebook / character.md，也不新开注入管线：
 *   proxy 拿到的 section 直接进已有的 dynamicSections（systemTail）。
 * - 写只有两个离线动作：refineMemes（升级/过期）与 revokeMeme（撤销），
 *   都以「追加快照、后写覆盖先写」的方式落盘，不原地改历史。
 * - 删除只做软删除（status=deprecated/archived），sources 永远保留。
 */
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gapConfig } from './bili-pool-config.mjs';

const HOME = 'Y:\\dsh\\home\\qq-persona';
export const MEMES_PATH = process.env.QQ_MEMES_PATH ?? join(HOME, 'memes.jsonl');
export const MEME_STATE_PATH = process.env.QQ_MEME_STATE ?? join(HOME, 'meme-inject-state.json');
export const MEME_INJECT_LOG = process.env.QQ_MEME_INJECT_LOG ?? join(HOME, 'meme-inject.jsonl');

export const NEAR_DUP_DICE = 0.8;
const ABOUT_SELF_VALUES = ['deepseek', 'gpt', 'claude', 'gemini', 'grok', 'other'];

/** 每日新增上限：超出丢弃当天新增，不积压到第二天。 */
export const DAILY_NEW_CAP = 20;

/** 注入配额：每轮 3 / 每会话每小时 10 / 同梗 10 分钟冷却。 */
export const INJECT_POLICY = Object.freeze({
    maxPerTurn: 3,
    maxChars: 200,
    maxSingleChars: 40,
    threshold: 0.35,
    halfLifeDays: 45,
    cooldownMs: 10 * 60_000,
    perChatPerHour: 10,
    repeatPenalty: 0.2,
});

export function readJsonLines(path) {
    if (!existsSync(path))
        return [];
    return readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => {
            try {
                return JSON.parse(line);
            }
            catch {
                return null;
            }
        })
        .filter(Boolean);
}

/** 后写覆盖先写：同 id 取最后一条。 */
export function loadMemes() {
    const map = new Map();
    for (const row of readJsonLines(MEMES_PATH)) {
        if (typeof row?.id === 'string' && row.id !== '')
            map.set(row.id, row);
    }
    // 老记录没有身份/门禁字段，读出来时按当前规则补算，注入层永远只看得到一致的结构。
    return [...map.values()].map(row => sealRecord(row, row.aboutSelf));
}

export function normalizeTerm(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/^[《「『"'“”‘’\s]+|[》」』"'“”‘’\s]+$/gu, '')
        .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function bigrams(text) {
    const value = normalizeTerm(text);
    if (value.length < 2)
        return value === '' ? [] : [value];
    const out = [];
    for (let index = 0; index < value.length - 1; index += 1)
        out.push(value.slice(index, index + 2));
    return out;
}

function dice(left, right) {
    const a = bigrams(left);
    const b = bigrams(right);
    if (a.length === 0 || b.length === 0)
        return 0;
    const pool = new Map();
    for (const gram of a)
        pool.set(gram, (pool.get(gram) ?? 0) + 1);
    let hit = 0;
    for (const gram of b) {
        const count = pool.get(gram) ?? 0;
        if (count > 0) {
            hit += 1;
            pool.set(gram, count - 1);
        }
    }
    return (2 * hit) / (a.length + b.length);
}

/** 最长公共子串：用来识别「同一个固定句式换了前半句」的变体。 */
export function longestCommon(a, b) {
    const left = normalizeTerm(a);
    const right = normalizeTerm(b);
    let best = '';
    const row = new Array(right.length + 1).fill(0);
    for (let i = 1; i <= left.length; i += 1) {
        let previous = 0;
        for (let j = 1; j <= right.length; j += 1) {
            const saved = row[j];
            if (left[i - 1] === right[j - 1]) {
                row[j] = previous + 1;
                if (row[j] > best.length)
                    best = left.slice(i - row[j], i);
            }
            else {
                row[j] = 0;
            }
            previous = saved;
        }
    }
    return best;
}

/** 近似判定：Dice ≥0.8，或共享一段 ≥4 字且占较短一方一半以上（固定句式变体）。 */
export function nearScore(left, right) {
    const score = dice(left, right);
    if (score >= NEAR_DUP_DICE)
        return score;
    const shared = longestCommon(left, right);
    const shorter = Math.min(normalizeTerm(left).length, normalizeTerm(right).length);
    if (shared.length >= 4 && shorter > 0 && shared.length / shorter >= 0.5)
        return Math.max(score, 0.8);
    return score;
}

/**
 * 身份红线（结构保证，不靠提示词）：
 * - aboutSelf=deepseek → usageScope=self-persona，可进人设；
 * - 其它模型 → usageScope=others-model / talkOnly=true / injectionPrefix 明确限定，注入层只允许当谈资；
 * - 普通梗（没有 aboutSelf）→ usageScope=general。
 */
export function identityOf(aboutSelf) {
    const value = String(aboutSelf ?? '');
    if (ABOUT_SELF_VALUES.includes(value)) {
        const self = value === 'deepseek';
        return {
            aboutSelf: value,
            usageScope: self ? 'self-persona' : 'others-model',
            identitySafe: self,
            talkOnly: !self,
            injectionPrefix: self ? '' : '（别人的模型梗，仅作谈资，禁止用来描述自己）',
        };
    }
    return { aboutSelf: '', usageScope: 'general', identitySafe: true, talkOnly: false, injectionPrefix: '' };
}

/** 低质门禁：置信度 ≤ 阈值且只出现 1 次 → 拦下（真串子 0.6 就是这条）。 */
function gateOf(record) {
    const confidence = Number(record.confidence ?? 0);
    const count = Number(record.count ?? 0);
    const threshold = Number(gapConfig().maxConfidence);
    if (confidence <= threshold && count < 2)
        return { status: 'blocked', reason: 'confidence ' + confidence + ' ≤ ' + threshold + ' 且只出现 ' + count + ' 次' };
    return { status: 'pass', reason: '' };
}

/** 身份字段 + 门禁 + 可注入标记一次性算好，之后再改置信度也要重新过这里。 */
export function sealRecord(record, aboutSelf) {
    const identity = identityOf(aboutSelf === '' || aboutSelf === undefined ? record.aboutSelf : aboutSelf);
    const gate = gateOf(record);
    return {
        ...record,
        status: record.status ?? 'candidate',
        ...identity,
        gate,
        injectable: identity.usageScope !== 'others-model' && gate.status === 'pass',
    };
}

/* ------------------------------------------------------------------ */
/* 检索（纯读）                                                        */
/* ------------------------------------------------------------------ */

function dayKey(now) {
    const date = new Date(now);
    const pad = value => String(value).padStart(2, '0');
    return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate());
}

function cleanQuery(text) {
    return String(text ?? '')
        .replace(/【[^】]*】/gu, ' ')
        .replace(/\[[^\]\n]{0,60}\]/gu, ' ')
        .replace(/@\d{5,12}/gu, ' ')
        .replace(/\(\d{5,12}\)/gu, ' ');
}

function loadState() {
    try {
        const parsed = JSON.parse(readFileSync(MEME_STATE_PATH, 'utf8'));
        return {
            version: 1,
            lastInject: parsed?.lastInject && typeof parsed.lastInject === 'object' ? parsed.lastInject : {},
            breaks: parsed?.breaks && typeof parsed.breaks === 'object' ? parsed.breaks : {},
            usedDay: parsed?.usedDay && typeof parsed.usedDay === 'object' ? parsed.usedDay : {},
            chats: parsed?.chats && typeof parsed.chats === 'object' ? parsed.chats : {},
        };
    }
    catch {
        return { version: 1, lastInject: {}, breaks: {}, usedDay: {}, chats: {} };
    }
}

function saveState(state) {
    const temporary = MEME_STATE_PATH + '.tmp';
    writeFileSync(temporary, JSON.stringify(state), 'utf8');
    renameSync(temporary, MEME_STATE_PATH);
}

/** 触发 B：在问这个梗是什么意思 / 哪来的。 */
const QUESTION_RE = /什么意思|什么梗|啥梗|啥意思|哪来的|哪儿来的|出处|什么来头|怎么来的|什么梗啊/u;
const BV_RE = /BV[0-9A-Za-z]{10}/gu;

function recordKeys(record) {
    return [record.term, ...(record.aliases ?? [])]
        .map(item => String(item ?? ''))
        .filter(item => normalizeTerm(item).length >= 2);
}

function bvidHits(record, bvids) {
    if (bvids.size === 0)
        return '';
    const all = [record.source?.bvid, ...(record.sources ?? []).map(item => item?.bvid), ...(record.videos ?? [])]
        .filter(item => typeof item === 'string')
        .map(item => item.toLowerCase());
    for (const bvid of bvids) {
        if (all.includes(bvid))
            return bvid;
    }
    return '';
}

/** 相关度：term 1.0 / 别名 0.9 / 部分重合 0.6 / 仅来源 BV 0.4。 */
function relevanceOf(record, normText, bvids) {
    const term = normalizeTerm(record.term);
    if (term.length >= 2 && normText.includes(term))
        return { value: 1, kind: 'term' };
    for (const alias of record.aliases ?? []) {
        const key = normalizeTerm(alias);
        if (key.length >= 2 && normText.includes(key))
            return { value: 0.9, kind: 'alias' };
    }
    for (const key of recordKeys(record)) {
        const shared = longestCommon(key, normText);
        const length = normalizeTerm(key).length;
        if (shared.length >= 3 && length > 0 && shared.length / length >= 0.6)
            return { value: 0.6, kind: 'partial' };
    }
    const bvid = bvidHits(record, bvids);
    if (bvid !== '')
        return { value: 0.4, kind: 'bvid', bvid };
    return { value: 0, kind: '' };
}

function ageDays(record, now) {
    const stamp = Date.parse(String(record.lastSeen ?? record.updatedAt ?? record.firstSeen ?? ''));
    if (!Number.isFinite(stamp))
        return 0;
    return Math.max(0, (now - stamp) / 864e5);
}

function eligible(record, question) {
    if (record.injectable !== true || record.usageScope === 'others-model')
        return false;
    if (record.status === 'deprecated' || record.status === 'archived')
        return false;
    if (record.status === 'stale' && !question)
        return false;
    if (record.status === 'confirmed')
        return true;
    // candidate：confidence ≥0.6 且跨 ≥2 条视频才可检索。
    return Number(record.confidence ?? 0) >= 0.6 && Number(record.count ?? 0) >= 2;
}

function clampMeaning(record) {
    const text = String(record.meaning || record.usage || '').replace(/\s+/gu, ' ').trim();
    if (text.length <= INJECT_POLICY.maxSingleChars)
        return text;
    // 硬切会把词切断（「因发音…」），优先在标点处收口，最多留 40 字。
    const head = text.slice(0, INJECT_POLICY.maxSingleChars);
    const cut = Math.max(head.lastIndexOf('，'), head.lastIndexOf('。'), head.lastIndexOf('；'), head.lastIndexOf('、'));
    return (cut >= 16 ? head.slice(0, cut) : head.slice(0, INJECT_POLICY.maxSingleChars - 1)) + '…';
}

function provenanceOf(record) {
    const source = record.source ?? {};
    const up = String(source.up ?? '');
    const bvid = String(source.bvid ?? '');
    const at = String(source.at ?? '');
    return [up, bvid, at].filter(Boolean).join(' ');
}

/**
 * 按本轮内容检索可注入的梗。
 * @returns {{ section: string, picked: object[], trigger: string, reason: string }}
 */
export function searchMemes({ text = '', chatId = '', sceneKey = '', now = Date.now(), limit = INJECT_POLICY.maxPerTurn } = {}) {
    const raw = cleanQuery(text);
    if (normalizeTerm(raw).length < 2)
        return { section: '', picked: [], trigger: '', reason: 'empty' };
    const question = QUESTION_RE.test(raw);
    const bvids = new Set((raw.match(BV_RE) ?? []).map(item => item.toLowerCase()));
    const normText = normalizeTerm(raw);
    const chatKey = (String(chatId) || 'unknown') + (sceneKey === '' ? '' : '|' + sceneKey);
    const state = loadState();
    const today = dayKey(now);
    const hourAgo = now - 3600_000;

    const recent = (state.chats[chatKey] ?? []).filter(stamp => Number(stamp) >= hourAgo);
    state.chats[chatKey] = recent;
    if (recent.length >= INJECT_POLICY.perChatPerHour) {
        saveState(state);
        return { section: '', picked: [], trigger: question ? 'B' : 'A', reason: 'hour-quota' };
    }

    const records = loadMemes().filter(record => eligible(record, question));
    const scored = [];
    for (const record of records) {
        const relevance = relevanceOf(record, normText, bvids);
        if (relevance.value === 0)
            continue;
        const cooled = now - Number(state.lastInject[record.id] ?? 0) < INJECT_POLICY.cooldownMs;
        if (cooled) {
            // 追问/玩梗可以突破一次冷却，但同一次注入只能破一次。
            if (!question || Number(state.breaks[record.id] ?? 0) === Number(state.lastInject[record.id] ?? 0))
                continue;
        }
        const count = Math.max(1, Number(record.count ?? (record.videos ?? []).length ?? 0));
        const countPart = Math.min(1, Math.log2(1 + count) / Math.log2(11));
        const days = ageDays(record, now);
        const category = String(record.category ?? '');
        const categoryWeight = category === 'callback' || category === '固定句式' ? 1 : 0.8;
        let score = 0.5 * relevance.value
            + 0.3 * countPart
            + 0.15 * Math.pow(0.5, days / INJECT_POLICY.halfLifeDays)
            + 0.05 * categoryWeight;
        // 90 天没再出现 ×0.5，180 天再 ×0.5；365 天由 refine 标 stale。
        // 追问（B）不扣冷度：用户主动问起时，老梗正是当前最相关的背景。
        if (!question) {
            if (days >= 180)
                score *= 0.25;
            else if (days >= 90)
                score *= 0.5;
        }
        if (state.usedDay[record.id] === today)
            score -= INJECT_POLICY.repeatPenalty;
        if (score < INJECT_POLICY.threshold)
            continue;
        scored.push({ record, score, relevance, cooled });
    }

    scored.sort((left, right) => right.score - left.score);
    const picked = [];
    const categoryCount = new Map();
    const usedBvids = new Set();
    let chars = 0;
    for (const item of scored) {
        if (picked.length >= Math.max(1, Math.min(INJECT_POLICY.maxPerTurn, Number(limit) || INJECT_POLICY.maxPerTurn)))
            break;
        const record = item.record;
        // 批内贪心：和已选条目近似（同一套 nearScore）就丢。
        const near = picked.some(chosen => {
            const left = recordKeys(chosen.record);
            const right = recordKeys(record);
            return left.some(a => right.some(b => nearScore(a, b) >= 0.6));
        });
        if (near)
            continue;
        const category = String(record.category ?? '其他');
        if ((categoryCount.get(category) ?? 0) >= 2)
            continue;
        // 同一来源视频只留一条；触发 C（正在聊那条 BV）时放开。
        const bvid = String(record.source?.bvid ?? '');
        const bvidTrigger = item.relevance.kind === 'bvid';
        if (!bvidTrigger && bvid !== '' && usedBvids.has(bvid))
            continue;
        const meaning = clampMeaning(record);
        if (meaning === '')
            continue;
        let line = '- ' + record.term + (meaning === '' ? '' : '：' + meaning);
        if (question) {
            const source = provenanceOf(record);
            if (source !== '')
                line += '\n  出处：' + source;
        }
        if (chars + line.length > INJECT_POLICY.maxChars)
            continue;
        picked.push({ record, score: item.score, relevance: item.relevance, cooled: item.cooled, line });
        categoryCount.set(category, (categoryCount.get(category) ?? 0) + 1);
        if (bvid !== '')
            usedBvids.add(bvid);
        chars += line.length + 1;
    }

    const trigger = picked.some(item => item.relevance.kind === 'bvid') ? 'C' : question ? 'B' : 'A';
    if (picked.length === 0) {
        saveState(state);
        return { section: '', picked: [], trigger, reason: 'no-hit' };
    }

    for (const item of picked) {
        state.lastInject[item.record.id] = now;
        state.usedDay[item.record.id] = today;
        if (item.cooled)
            state.breaks[item.record.id] = now;
    }
    // 配额按「条」算：一轮注入 3 条就记 3 次，避免 10 次请求塞进 30 条。
    state.chats[chatKey] = [...recent, ...picked.map(() => now)];
    const dayStart = now - 864e5;
    for (const [id, stamp] of Object.entries(state.lastInject)) {
        if (Number(stamp) < dayStart)
            delete state.lastInject[id];
    }
    for (const [id, day] of Object.entries(state.usedDay)) {
        if (day !== today)
            delete state.usedDay[id];
    }
    saveState(state);

    const section = '【可用的梗（理解用，不必硬用）】\n' + picked.map(item => item.line).join('\n');
    try {
        appendFileSync(MEME_INJECT_LOG, JSON.stringify({
            ts: new Date(now).toISOString(),
            chat: String(chatId ?? ''),
            scene: String(sceneKey ?? ''),
            trigger,
            picked: picked.map(item => ({
                id: item.record.id,
                term: item.record.term,
                score: Number(item.score.toFixed(3)),
                relevance: item.relevance.kind,
                brokeCooldown: item.cooled,
            })),
        }) + '\n', 'utf8');
    }
    catch {
        // 日志失败不影响注入
    }
    return { section, picked: picked.map(item => item.record.term), trigger, reason: '' };
}

/* ------------------------------------------------------------------ */
/* 三阶段：观察 → 提炼（confirmed / stale）→ 可撤销（deprecated）      */
/* ------------------------------------------------------------------ */

/** 整库重写（一条一行）：写入时顺手压掉历史重复，后面不会再越写越胖。 */
export function writeMemes(records) {
    const temporary = MEMES_PATH + '.tmp';
    writeFileSync(temporary, records.map(item => JSON.stringify(item)).join('\n') + '\n', 'utf8');
    renameSync(temporary, MEMES_PATH);
}

function appendSnapshots(records) {
    if (records.length === 0)
        return;
    const byId = new Map(loadMemes().map(record => [record.id, record]));
    for (const record of records)
        byId.set(record.id, record);
    writeMemes([...byId.values()]);
}

function distinctVideos(record) {
    return new Set((record.videos ?? []).filter(Boolean)).size;
}

function distinctUps(record) {
    const ups = new Set();
    for (const source of [record.source, ...(record.sources ?? [])]) {
        if (typeof source?.up === 'string' && source.up !== '')
            ups.add(source.up);
    }
    return ups.size;
}

function promotionReady(record, now) {
    if (distinctVideos(record) < 3)
        return '';
    if (distinctUps(record) < 2)
        return '';
    const first = Date.parse(String(record.firstSeen ?? ''));
    const last = Date.parse(String(record.lastSeen ?? ''));
    if (Number.isFinite(first) && Number.isFinite(last) && (last - first) / 864e5 < 7)
        return '';
    if (Number(record.confidence ?? 0) < 0.7)
        return '';
    return '跨 ' + distinctVideos(record) + ' 条视频/' + distinctUps(record) + ' 个 UP，跨度≥7 天，confidence≥0.7';
}

/**
 * 离线提炼：candidate → confirmed；超过 365 天没有新视频 → stale。
 * 只有离线任务/CLI 调，不在对话中途改状态。
 */
export function refineMemes({ now = Date.now() } = {}) {
    const records = loadMemes();
    const changed = [];
    const promoted = [];
    const staled = [];
    for (const record of records) {
        if (record.status === 'deprecated' || record.status === 'archived')
            continue;
        const days = ageDays(record, now);
        if (record.status === 'candidate') {
            const reason = promotionReady(record, now);
            if (reason !== '') {
                const next = sealRecord({
                    ...record,
                    status: 'confirmed',
                    confirmedAt: new Date(now).toISOString(),
                    confirmedReason: reason,
                    updatedAt: new Date(now).toISOString(),
                });
                changed.push(next);
                promoted.push(record.term);
                continue;
            }
        }
        if (record.status !== 'stale' && days >= 365) {
            const next = sealRecord({
                ...record,
                status: 'stale',
                staleAt: new Date(now).toISOString(),
                staleReason: '365 天没有新视频',
                updatedAt: new Date(now).toISOString(),
            });
            changed.push(next);
            staled.push(record.term);
        }
    }
    appendSnapshots(changed);
    return { promoted, staled, changed: changed.length };
}

/** 撤销：软删除，保留 sources 以便复盘/恢复。 */
export function revokeMeme(term, reason = '') {
    const key = normalizeTerm(term);
    if (key === '')
        return { ok: false, reason: 'empty-term' };
    const records = loadMemes();
    const hit = records.find(record => recordKeys(record).some(item => normalizeTerm(item) === key));
    if (hit === undefined)
        return { ok: false, reason: 'not-found' };
    const next = sealRecord({
        ...hit,
        status: 'deprecated',
        deprecatedAt: new Date().toISOString(),
        deprecatedReason: String(reason ?? ''),
        updatedAt: new Date().toISOString(),
    });
    appendSnapshots([next]);
    return { ok: true, term: hit.term, id: hit.id, status: next.status };
}
