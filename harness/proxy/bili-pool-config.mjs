/**
 * bili-pool.json 的唯一读取入口：候选来源、二创关键词、路由表、缺口预算、长视频批次都在这里读。
 * 代码里不硬编码 UP 名单、关键词、路由目的地，改配置就生效。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOME = 'Y:\\dsh\\home\\qq-persona';
export const POOL_PATH = process.env.QQ_BILI_POOL ?? join(HOME, 'bili-pool.json');

const DEFAULTS = {
    upPool: [],
    selfKeywords: { keywords: [], aboutSelf: {}, perRun: 4 },
    search: { orders: ['totalrank', 'click'], topN: 6 },
    router: {
        meme: { label: '梗指南', target: 'up:94510621', categories: [], hints: [] },
        search: { label: '全站搜索', target: 'search', orders: ['totalrank', 'click'], topN: 6, maxQueries: 3, querySuffixes: [], hints: [] },
    },
    gaps: { maxConfidence: 0.6, maxAttempts: 2, minDurationSec: 30, maxDurationSec: 1200, cooldownMs: 7_200_000 },
    longBatch: { ups: ['影视飓风', '极客湾Geekerwan'], maxDurationSec: 5400 },
};

export function loadPool() {
    try {
        const doc = JSON.parse(readFileSync(POOL_PATH, 'utf8'));
        return {
            ...DEFAULTS,
            ...doc,
            selfKeywords: { ...DEFAULTS.selfKeywords, ...(doc?.selfKeywords ?? {}) },
            search: { ...DEFAULTS.search, ...(doc?.search ?? {}) },
            router: {
                meme: { ...DEFAULTS.router.meme, ...(doc?.router?.meme ?? {}) },
                search: { ...DEFAULTS.router.search, ...(doc?.router?.search ?? {}) },
            },
            gaps: { ...DEFAULTS.gaps, ...(doc?.gaps ?? {}) },
            longBatch: { ...DEFAULTS.longBatch, ...(doc?.longBatch ?? {}) },
        };
    }
    catch {
        return DEFAULTS;
    }
}

function normalize(value) {
    return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 关键词 → aboutSelf。配置里没写就按模型名兜底猜，猜不出算 other。 */
export function aboutSelfForKeyword(doc, keyword) {
    const map = doc?.selfKeywords?.aboutSelf ?? {};
    if (map[keyword] !== undefined)
        return String(map[keyword]);
    const text = String(keyword ?? '').toLowerCase();
    for (const [name, value] of [['deepseek', 'deepseek'], ['gpt', 'gpt'], ['claude', 'claude'], ['gemini', 'gemini'], ['grok', 'grok']]) {
        if (text.includes(name))
            return value;
    }
    return 'other';
}

/** 从标题/正文里识别这是「哪个模型的拟人梗」；识别不到返回空串。 */
export function detectAboutSelf(doc, text) {
    const statement = String(text ?? '');
    if (statement.trim() === '')
        return { aboutSelf: '', keyword: '' };
    const map = doc?.selfKeywords?.aboutSelf ?? {};
    const keywords = [...new Set([...Object.keys(map), ...(doc?.selfKeywords?.keywords ?? [])])]
        .filter(Boolean)
        .sort((left, right) => right.length - left.length);
    for (const keyword of keywords) {
        if (statement.includes(keyword))
            return { aboutSelf: aboutSelfForKeyword(doc, keyword), keyword };
    }
    const lower = statement.toLowerCase();
    for (const name of ['deepseek', 'gpt', 'claude', 'gemini', 'grok']) {
        if (lower.includes(name))
            return { aboutSelf: name, keyword: name };
    }
    return { aboutSelf: '', keyword: '' };
}

/** 路由：梗/黑话/网络流行语 → 梗指南；其余（含技术、影像、兜底）→ 全站搜索。 */
export function classifyRoute(doc, { term = '', category = '', aboutSelf = '' } = {}) {
    const meme = doc?.router?.meme ?? DEFAULTS.router.meme;
    const search = doc?.router?.search ?? DEFAULTS.router.search;
    // AI 拟人/模型二创没有专属 UP，仍走全站搜索，只是关键词换成二创词。
    if (aboutSelf !== '' && aboutSelf !== undefined && aboutSelf !== null)
        return { id: 'search', label: search.label, target: search.target, reason: '二创关键词池（aboutSelf=' + aboutSelf + '）' };
    // 技术/影像/行业词即使被抽成「流行语」也不送梗指南：全站搜索。
    const forcedSearch = (search.hints ?? []).find(hint => hint !== '' && term.includes(hint));
    if (forcedSearch !== undefined)
        return { id: 'search', label: search.label, target: search.target, reason: '技术/行业词（' + forcedSearch + '）' };
    // 纯拉丁字母/数字型号（HBM4、iPhone 18、DLSS 4.5）不是梗的写法，按技术词走全站搜索。
    if (/\d/u.test(term) && !/[\u4e00-\u9fff]/u.test(term))
        return { id: 'search', label: search.label, target: search.target, reason: '型号/数字词' };
    if (category !== '' && (meme.categories ?? []).includes(category))
        return { id: 'meme', label: meme.label, target: meme.target, reason: '类别=' + category };
    if ((meme.hints ?? []).some(hint => hint !== '' && term.includes(hint)))
        return { id: 'meme', label: meme.label, target: meme.target, reason: '词形命中梗类提示' };
    return { id: 'search', label: search.label, target: search.target, reason: '非梗类，兜底全站搜索' };
}

/** 全站搜索的关键词：原词 + 梗类「是什么梗」变体 + 梗库别名 + （二创时）该模型的拟人关键词。 */
export function searchQueries(doc, { term = '', aliases = [], aboutSelf = '', category = '' } = {}) {
    const extra = [];
    if (aboutSelf !== '' && aboutSelf !== undefined && aboutSelf !== null) {
        const map = doc?.selfKeywords?.aboutSelf ?? {};
        for (const [keyword, value] of Object.entries(map)) {
            if (String(value) === String(aboutSelf))
                extra.push(keyword);
        }
    }
    const max = Number(doc?.router?.search?.maxQueries) || 3;
    const memeCategories = doc?.router?.meme?.categories ?? [];
    const suffixes = memeCategories.includes(category) ? (doc?.router?.search?.querySuffixes ?? []) : [];
    const variants = suffixes.filter(Boolean).map(suffix => term + suffix);
    const seen = new Set();
    const out = [];
    for (const raw of [term, ...variants, ...aliases, ...extra]) {
        const value = String(raw ?? '').trim();
        const key = normalize(value);
        if (value === '' || key === '' || seen.has(key))
            continue;
        seen.add(key);
        out.push(value);
        if (out.length >= max)
            break;
    }
    return out;
}

export function gapConfig(doc = loadPool()) {
    return { ...DEFAULTS.gaps, ...(doc?.gaps ?? {}) };
}

export function longBatchConfig(doc = loadPool()) {
    return { ...DEFAULTS.longBatch, ...(doc?.longBatch ?? {}) };
}
