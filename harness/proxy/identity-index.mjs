/**
 * 视觉身份索引：特征加权匹配 + 证据累积。
 *
 * 只做三件事：给 observed 打分、按阈值给出门禁档位、把重复出现的特征累计成证据。
 * 打标与特征抽取**不在这里**，仍然只有 vision.mjs 的 captionImage 一处。
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const ROOT = process.env.QQ_PROXY_ROOT ?? 'Y:\\dsh\\home\\qq-persona';
const INDEX_PATH = process.env.QQ_IDENTITY_INDEX ?? join(ROOT, 'identity-index.jsonl');
const CLUSTER_PATH = process.env.QQ_IDENTITY_CLUSTERS ?? join(ROOT, 'identity-candidates.json');
/** 主人给的先验种子（只读）。与自动累积的索引分开：种子只能人工写，代码只读。 */
const SEED_PATH = process.env.QQ_IDENTITY_SEED ?? join(ROOT, 'identity-seeds.jsonl');
/** 自己的形象（usageScope=self）单独一个种子文件，和 others-model 物理隔离。 */
const SELF_SEED_PATH = process.env.QQ_IDENTITY_SELF_SEED ?? join(ROOT, 'identity-seeds-self.jsonl');

/** 与 design.md 第 2 节一致；只用于打分，不做词表校验（词表在 vision.mjs）。 */
const WEIGHTS = {
    hairColor: 0.20,
    earType: 0.25,
    proportion: 0.25,
    hairStyle: 0.10,
    eyeColor: 0.10,
    palette: 0.15,
    markers: 0.15,
    ocrText: 0.05,
};
const FEATURE_LABEL = {
    hairColor: '发色', earType: '耳型', proportion: '比例', hairStyle: '发型',
    eyeColor: '瞳色', palette: '主色', markers: '标志物', ocrText: '文字',
};
const NAME_SCORE = 0.72;
const HEDGE_SCORE = 0.50;
const MIN_EVIDENCE = 3;
const MIN_MATERIALS = 2;
const MAX_CANDIDATES = 2;

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function basisOf(entry, observed) {
    const tags = [];
    for (const key of Object.keys(WEIGHTS)) {
        if (key === 'ocrText')
            continue;
        const declared = entry.features?.[key];
        if (!Array.isArray(declared))
            continue;
        for (const value of observed?.[key] ?? []) {
            if (declared.includes(value))
                tags.push(FEATURE_LABEL[key] + '=' + value);
        }
    }
    return tags.slice(0, 4);
}

/** 单条目打分：base 归一化 → 扣负例 → 别名加成 → 乘条目置信度。 */
export function scoreEntry(entry, observed, aliasText = '') {
    if (!entry || typeof entry !== 'object' || entry.status === 'disabled')
        return undefined;
    // 比例是硬特征：种子声明了比例、本次也读出了比例，但两者不相交 → 直接判不匹配，
    // 避免“正常版”和“Q版”两个种子靠发色/主色互相串味。
    const declaredProportion = entry.features?.proportion;
    const observedProportion = Array.isArray(observed?.proportion) ? observed.proportion : [];
    if (Array.isArray(declaredProportion) && declaredProportion.length > 0 && observedProportion.length > 0
        && !observedProportion.some(value => declaredProportion.includes(value)))
        return {
            identity: entry.identity ?? '',
            display: entry.display ?? entry.identity ?? entry.id,
            score: 0,
            basis: [],
            groups: 0,
            usageScope: entry.usageScope ?? 'unknown',
        };
    let raw = 0;
    let total = 0;
    let matchedGroups = 0;
    for (const [key, weight] of Object.entries(WEIGHTS)) {
        const declared = entry.features?.[key];
        if (key === 'ocrText') {
            if (typeof declared !== 'string' || declared === '')
                continue;
            const got = observed?.ocrText;
            // 本次没有抽取到文字 → 该组不参与分母（缺项不惩罚，见 design.md 3.2）。
            if (typeof got !== 'string' || got === '')
                continue;
            total += weight;
            if (declared.includes(got) || got.includes(declared)) {
                raw += weight;
                matchedGroups += 1;
            }
            continue;
        }
        if (!Array.isArray(declared) || declared.length === 0)
            continue;
        const got = Array.isArray(observed?.[key]) ? observed[key] : [];
        // 本次没有抽取到该组 → 不计入分母；抽到了但不对 → 计入分母且不得分。
        if (got.length === 0)
            continue;
        total += weight;
        const hit = got.filter(value => declared.includes(value)).length;
        if (hit === 0)
            continue;
        matchedGroups += 1;
        raw += weight * (key === 'markers'
            ? Math.min(hit, 2) / Math.min(declared.length, 2)
            : Math.min(1, hit / declared.length));
    }
    if (total === 0)
        return undefined;
    let score = raw / total;
    let negativeHits = 0;
    for (const negative of entry.negatives ?? []) {
        const matched = /^([A-Za-z]+)=(.+)$/u.exec(String(negative?.feature ?? ''));
        if (matched === null)
            continue;
        const value = observed?.[matched[1]];
        if (Array.isArray(value) ? value.includes(matched[2]) : value === matched[2])
            negativeHits += 1;
    }
    score -= Math.min(0.45, negativeHits * 0.15);
    if (aliasText !== '' && Array.isArray(entry.aliases)) {
        const text = String(aliasText).toLowerCase();
        if (entry.aliases.some(alias => alias && text.includes(String(alias).toLowerCase())))
            score += 0.10;
    }
    score = clamp(score, 0, 1);
    const confidence = typeof entry.confidence === 'number' ? entry.confidence : 1;
    return {
        identity: entry.identity ?? '',
        display: entry.display ?? entry.identity ?? entry.id,
        score: Number((score * confidence).toFixed(3)),
        basis: basisOf(entry, observed),
        // 命中了几组独立特征（发色/耳型/主色……）。只中一组时不足以点名。
        groups: matchedGroups,
        // self 可以进自我介绍；others-model / 未标注一律只能内部参考。
        usageScope: entry.usageScope ?? 'unknown',
    };
}

async function readJsonl(path) {
    try {
        const text = await readFile(path, 'utf8');
        return text.split('\n')
            .map(line => line.trim())
            .filter(line => line !== '')
            .map(line => {
                try {
                    return JSON.parse(line);
                }
                catch {
                    return undefined;
                }
            })
            .filter(entry => entry !== undefined && entry.status !== 'disabled');
    }
    catch {
        return [];
    }
}

/** 种子在前、自动索引在后；同 id 以索引为准（索引是后来者）。 */
async function loadEntries() {
    const [seeds, selfSeeds, index] = await Promise.all([
        readJsonl(SEED_PATH), readJsonl(SELF_SEED_PATH), readJsonl(INDEX_PATH),
    ]);
    const byId = new Map();
    for (const entry of [...seeds, ...selfSeeds, ...index])
        byId.set(entry.id ?? JSON.stringify(entry.features), entry);
    const entries = [...byId.values()];
    for (const entry of entries) {
        if (typeof entry.signature !== 'string' || entry.signature === '')
            entry.signature = signatureOf(entry.features);
    }
    return entries;
}

/** 门禁：只认 observed 的匹配分，null 身份（未命名聚类）不参与点名。 */
export function gateOn(entries, observed, aliasText = '') {
    const scored = [];
    for (const entry of entries) {
        const result = scoreEntry(entry, observed, aliasText);
        if (result !== undefined && result.identity !== '' && result.score > 0)
            scored.push(result);
    }
    if (scored.length === 0)
        return { level: 'silent', candidates: [] };
    scored.sort((a, b) => b.score - a.score);
    const top = scored[0];
    // 只命中一组特征（比如只有主色对）时不许点名，最多“可能是”。
    const level = top.score >= NAME_SCORE && top.groups >= 2
        ? 'name'
        : top.score >= HEDGE_SCORE ? 'hedge' : 'silent';
    if (level === 'silent')
        return { level, candidates: [] };
    const tied = scored[1] !== undefined && top.score - scored[1].score < 0.08;
    return { level, candidates: scored.slice(0, tied ? 2 : 1) };
}

function signatureOf(observed) {
    if (observed === null || typeof observed !== 'object')
        return '';
    const parts = [];
    for (const key of ['hairColor', 'hairStyle', 'earType', 'eyeColor', 'palette', 'markers']) {
        const values = Array.isArray(observed[key]) ? [...observed[key]].sort() : [];
        if (values.length > 0)
            parts.push(key + ':' + values.slice(0, 2).join('|'));
    }
    return parts.length >= 3 ? parts.join(';') : '';
}

async function readClusters() {
    try {
        const parsed = JSON.parse(await readFile(CLUSTER_PATH, 'utf8'));
        return parsed?.clusters && typeof parsed.clusters === 'object' ? parsed.clusters : {};
    }
    catch {
        return {};
    }
}

async function writeClusters(clusters) {
    await mkdir(dirname(CLUSTER_PATH), { recursive: true });
    await writeFile(CLUSTER_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), clusters }, null, 2), 'utf8');
}

function hash4(value) {
    let hash = 0;
    for (const char of value)
        hash = (hash * 31 + char.codePointAt(0)) % 0xffff;
    return hash.toString(16).padStart(4, '0');
}

/**
 * 从一次观察里累积证据：同一组特征出现在 ≥3 条素材、且覆盖 ≥2 个来源，
 * 才落一条 status=pending 的未命名条目；confidence 锁 0.5，永远只能"可能是"。
 */
async function learn(entry) {
    const observations = [];
    if (entry.observed !== undefined)
        observations.push({ index: 0, observed: entry.observed });
    for (const panel of entry.panels ?? [])
        observations.push({ index: panel.index, observed: panel.observed });
    const clusters = await readClusters();
    const existing = new Set((await loadEntries()).map(item => item.signature).filter(Boolean));
    let changed = false;
    for (const observation of observations) {
        const signature = signatureOf(observation.observed);
        if (signature === '')
            continue;
        const cluster = clusters[signature] ?? { signature, features: {}, evidence: [], firstSeen: entry.at };
        for (const key of Object.keys(WEIGHTS)) {
            if (key === 'ocrText' || !Array.isArray(observation.observed[key]))
                continue;
            if (observation.observed[key].length > 0)
                cluster.features[key] = observation.observed[key];
        }
        const material = entry.video ?? entry.chatId ?? 'unknown';
        const ref = material + '|' + Math.round(entry.at / 1000);
        if (!cluster.evidence.some(item => item.ref === ref)) {
            cluster.evidence.push({
                ref,
                material,
                at: entry.at,
                index: observation.index,
                source: entry.source ?? 'chat',
                frame: entry.frame ?? null,
            });
            cluster.lastSeen = entry.at;
            changed = true;
        }
        clusters[signature] = cluster;
        const materials = new Set(cluster.evidence.map(item => item.material));
        if (cluster.evidence.length < MIN_EVIDENCE || materials.size < MIN_MATERIALS || existing.has(signature))
            continue;
        existing.add(signature);
        const record = {
            id: 'ident_auto_' + hash4(signature),
            identity: '',
            display: '未命名形象 #' + hash4(signature),
            aliases: [],
            features: cluster.features,
            signature,
            evidence: cluster.evidence.slice(-8),
            negatives: [],
            authority: 'heuristic',
            confidence: 0.5,
            asContext: true,
            status: 'pending',
            createdAt: new Date(entry.at).toISOString(),
            updatedAt: new Date(entry.at).toISOString(),
        };
        await mkdir(dirname(INDEX_PATH), { recursive: true });
        await appendFile(INDEX_PATH, JSON.stringify(record) + '\n', 'utf8');
        changed = true;
    }
    if (changed)
        await writeClusters(clusters);
}

/** 给一条打标结果挂上身份候选（只挂 asContext，不进可见文本）。 */
export async function annotateEntry(entry) {
    try {
        const entries = await loadEntries();
        const aliasText = typeof entry.text === 'string' ? entry.text : '';
        // 外部标签只从文件名取（主人/上游给的），不从画面推断；不参与任何打分。
        const labels = externalLabelsFromPath(entry.frame);
        if (labels.length > 0)
            entry.externalLabels = labels;
        const slots = [];
        // 多格图的整图 observed 是各格并集，拿去匹配只会串味，直接跳过。
        const grid = (entry.layout?.panels ?? 1) > 1;
        const whole = grid ? { level: 'silent', candidates: [] } : gateOn(entries, entry.observed, aliasText);
        if (whole.level !== 'silent')
            slots.push({ index: 0, level: whole.level, candidates: whole.candidates });
        for (const panel of entry.panels ?? []) {
            const result = gateOn(entries, panel.observed, aliasText);
            if (result.level !== 'silent')
                slots.push({ index: panel.index, level: result.level, candidates: result.candidates });
        }
        if (slots.length > 0)
            entry.identityCandidates = slots;
        await learn(entry);
        return entry;
    }
    catch {
        return entry;
    }
}

/** 注入上下文用的一行候选摘要；silent 时返回空串。 */
export function candidateSuffix(entry) {
    const slots = entry?.identityCandidates;
    if (!Array.isArray(slots) || slots.length === 0)
        return '';
    const selfParts = [];
    const contextParts = [];
    for (const slot of slots) {
        const top = slot.candidates?.[0];
        if (top === undefined)
            continue;
        const where = slot.index === 0 ? '整图' : '第' + slot.index + '格';
        const mode = slot.level === 'name' ? '疑似 ' : '可能是 ';
        const extra = slot.candidates.length > 1 ? '／' + slot.candidates[1].display : '';
        const text = where + mode + top.display + extra + '（' + top.score.toFixed(2) + '）';
        // 只有 usageScope=self 能进自我介绍；其他模型的拟人永远是“不主动提”。
        if (top.usageScope === 'self')
            selfParts.push(text);
        else
            contextParts.push(text);
    }
    const lines = [];
    if (selfParts.length > 0)
        lines.push('；自己的形象（可以承认）：' + selfParts.join('，'));
    if (contextParts.length > 0)
        lines.push('；内部参考（不主动提）：' + contextParts.join('，'));
    return lines.join('');
}

/** 从文件名里取外部标签（pro/flash 等）；只记录，不参与打分，也不从画面推断。 */
function externalLabelsFromPath(path) {
    if (typeof path !== 'string' || path === '')
        return [];
    const name = path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1);
    const labels = [];
    for (const match of name.matchAll(/(?:^|[^a-z0-9])(pro|flash)(?:[^a-z0-9]|$)/giu))
        labels.push({ label: match[1].toLowerCase(), source: 'filename' });
    return labels;
}
