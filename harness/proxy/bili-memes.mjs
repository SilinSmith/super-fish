/**
 * 梗库：从「字幕/转写 + 画面打标 + 弹幕簇」抽候选梗，写独立的 memes.jsonl。
 *
 * 边界：
 * - 只写 memes.jsonl，不写 notebook、不写 character.md、不进每轮上下文。
 * - 记录只是「候选」：source 字段可追溯到 BV / 时间点 / 当时刷的弹幕，后续可修订、可撤销。
 * - 去重先精确（term/aliases 归一化后相等）再近似（二元组 Dice ≥ 0.8），近似命中记为别名。
 * - 抽不到就返回空数组，不硬凑；模型/网络失败如实返回 reason。
 *
 * 用法：
 *   node bili-memes.mjs extract --bvid BV1xx [--limit 5] [--write]
 *   node bili-memes.mjs list [--q 词] [--min 2]
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectDanmaku, renderTimeline } from './bili-danmaku.mjs';
import { subtitleText, videoInfo } from './bili.mjs';
import { gapConfig } from './bili-pool-config.mjs';
import { LLM, chatCompletionsPath, normalizePayload } from './llm-config.mjs';
import { enqueueGap, shouldEnqueueGap } from './meme-gaps-core.mjs';
import {
    DAILY_NEW_CAP, MEMES_PATH, NEAR_DUP_DICE, loadMemes, normalizeTerm, nearScore, readJsonLines,
    refineMemes, revokeMeme, sealRecord, searchMemes, writeMemes,
} from './meme-store.mjs';

export { MEMES_PATH, loadMemes };

const HOME = 'Y:\\dsh\\home\\qq-persona';
const LIBRARY_PATH = join(HOME, 'bili-library.jsonl');

const MEME_URL = process.env.QQ_MEME_URL ?? (new URL(LLM.baseUrl).origin + chatCompletionsPath());
const MEME_MODEL = process.env.QQ_MEME_MODEL ?? LLM.model;
const MEME_TIMEOUT_MS = Number(process.env.QQ_MEME_TIMEOUT_MS) || 120_000;
const MAX_MATERIAL_CHARS = 6000;
const MAX_DANMAKU_CHARS = 3000;

function memeId(term) {
    return 'm-' + createHash('sha1').update(normalizeTerm(term)).digest('hex').slice(0, 12);
}

function clampText(value, limit) {
    return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, limit);
}

/** 模型会把时间轴里的「×N」一起抄回来；去掉计数后缀，只留弹幕原文。 */
function stripCount(text) {
    return clampText(text, 120).replace(/\s*[×xX]\s*\d+\s*$/u, '').trim();
}

function normalizeCandidate(raw) {
    const term = clampText(raw?.term, 24).replace(/[×xX]\d+$/u, '').trim();
    if (term.length < 2)
        return null;
    const evidence = raw?.evidence ?? {};
    const at = /^\d{1,3}:\d{2}$/u.test(String(evidence?.at ?? '')) ? String(evidence.at) : '';
    const danmaku = Array.isArray(evidence?.danmaku)
        ? [...new Set(evidence.danmaku.map(item => stripCount(item)).filter(Boolean))].slice(0, 3)
        : [];
    const aliases = Array.isArray(raw?.aliases)
        ? [...new Set(raw.aliases.map(item => clampText(item, 24)).filter(Boolean))]
            .filter(item => normalizeTerm(item) !== normalizeTerm(term))
            .slice(0, 4)
        : [];
    return {
        term,
        aliases,
        category: ['网络梗', '流行语', '名场面', '固定句式', 'callback'].includes(raw?.category)
            ? raw.category
            : '网络梗',
        meaning: clampText(raw?.meaning, 80),
        usage: clampText(raw?.usage, 60),
        evidence: {
            at,
            quote: clampText(evidence?.quote, 120),
            danmaku,
        },
        confidence: Math.max(0, Math.min(1, Number(raw?.confidence) || 0.5)),
    };
}

/** 先精确（term/别名）后近似（Dice），命中返回已有记录。 */
function findExisting(memes, candidate) {
    const term = normalizeTerm(candidate.term);
    const aliases = candidate.aliases.map(normalizeTerm).filter(Boolean);
    for (const record of memes) {
        const keys = [record.term, ...(record.aliases ?? [])].map(normalizeTerm);
        if (keys.includes(term) || aliases.some(alias => keys.includes(alias)))
            return { record, kind: 'exact', score: 1 };
    }
    let best = null;
    for (const record of memes) {
        const score = nearScore(record.term, candidate.term);
        if (score >= NEAR_DUP_DICE && (best === null || score > best.score))
            best = { record, kind: 'near', score };
    }
    return best;
}

/** 近似命中时保留更短、更干净的写法作为主词条，旧写法降为别名。 */
function preferredTerm(existing, candidate, kind) {
    if (kind !== 'near')
        return existing.term;
    return candidate.term.length + 2 < normalizeTerm(existing.term).length ? candidate.term : existing.term;
}

function mergeRecord(existing, candidate, context, kind = 'exact') {
    const now = new Date().toISOString();
    const bvid = String(context?.bvid ?? '');
    const term = preferredTerm(existing, candidate, kind);
    const version = {
        bvid,
        title: String(context?.title ?? ''),
        up: String(context?.owner ?? ''),
        at: candidate.evidence.at,
        quote: candidate.evidence.quote,
        danmaku: candidate.evidence.danmaku,
        seenAt: now,
    };
    const videos = Array.isArray(existing.videos) ? [...existing.videos] : [];
    if (bvid !== '' && !videos.includes(bvid))
        videos.push(bvid);
    const aliases = [...(existing.aliases ?? [])];
    // 换了主词条时，旧写法降为别名。
    if (normalizeTerm(term) !== normalizeTerm(existing.term))
        aliases.push(existing.term);
    for (const alias of candidate.aliases) {
        if (normalizeTerm(alias) !== normalizeTerm(term) && !aliases.some(item => normalizeTerm(item) === normalizeTerm(alias)))
            aliases.push(alias);
    }
    const sources = Array.isArray(existing.sources) ? [...existing.sources] : [];
    if (bvid !== '' && !sources.some(item => item.bvid === bvid && item.at === version.at))
        sources.push(version);
    const upgraded = candidate.confidence > Number(existing.confidence ?? 0);
    return sealRecord({
        ...existing,
        term,
        aliases: [...new Set(aliases.filter(item => normalizeTerm(item) !== normalizeTerm(term)))].slice(0, 6),
        videos,
        count: videos.length,
        category: upgraded ? candidate.category : existing.category,
        meaning: upgraded || !existing.meaning ? candidate.meaning : existing.meaning,
        usage: upgraded || !existing.usage ? candidate.usage : existing.usage,
        confidence: Math.max(Number(existing.confidence ?? 0), candidate.confidence),
        // 最新来源放最后，sources 只留最近 3 条，避免记录无限长。
        source: version,
        sources: sources.slice(-3),
        lastSeen: now,
        updatedAt: now,
    }, context?.aboutSelf);
}

function createRecord(candidate, context) {
    const now = new Date().toISOString();
    return sealRecord({
        id: memeId(candidate.term),
        term: candidate.term,
        aliases: candidate.aliases.slice(0, 6),
        category: candidate.category,
        meaning: candidate.meaning,
        usage: candidate.usage,
        confidence: candidate.confidence,
        videos: String(context?.bvid ?? '') === '' ? [] : [String(context.bvid)],
        count: String(context?.bvid ?? '') === '' ? 0 : 1,
        source: {
            bvid: String(context?.bvid ?? ''),
            title: String(context?.title ?? ''),
            up: String(context?.owner ?? ''),
            at: candidate.evidence.at,
            quote: candidate.evidence.quote,
            danmaku: candidate.evidence.danmaku,
            seenAt: now,
        },
        sources: [{
            bvid: String(context?.bvid ?? ''),
            title: String(context?.title ?? ''),
            up: String(context?.owner ?? ''),
            at: candidate.evidence.at,
            quote: candidate.evidence.quote,
            danmaku: candidate.evidence.danmaku,
            seenAt: now,
        }],
        firstSeen: now,
        lastSeen: now,
        status: 'candidate',
    }, context?.aboutSelf);
}

/** 合并入库；只对新增/变化过的记录追加一行（后写覆盖先写）。 */
export function recordMemeCandidates(candidates, context = {}) {
    const memes = loadMemes();
    const added = [];
    const merged = [];
    const dropped = [];
    const lines = [];
    const today = new Date().toISOString().slice(0, 10);
    let addedToday = memes.filter(item => String(item.firstSeen ?? '').slice(0, 10) === today).length;
    for (const candidate of candidates) {
        const hit = findExisting(memes, candidate);
        if (hit === null) {
            // 每日新增上限：超出直接丢，不积压到第二天。
            if (addedToday >= DAILY_NEW_CAP) {
                dropped.push(candidate.term);
                continue;
            }
            const record = createRecord(candidate, context);
            memes.push(record);
            added.push(record);
            lines.push(record);
            addedToday += 1;
            continue;
        }
        const next = mergeRecord(hit.record, candidate, context, hit.kind);
        // 近似命中把候选写法补成别名，方便以后精确命中（已是主词条就不重复加）。
        if (hit.kind === 'near'
            && normalizeTerm(candidate.term) !== normalizeTerm(next.term)
            && !next.aliases.some(item => normalizeTerm(item) === normalizeTerm(candidate.term)))
            next.aliases = [...next.aliases, candidate.term].slice(0, 6);
        const index = memes.findIndex(item => item.id === next.id);
        if (index >= 0)
            memes[index] = next;
        merged.push(next);
        lines.push(next);
    }
    // 整库重写而不是追加：同一词条永远只有一条，不会再出现 5 份「真串子」。
    if (lines.length > 0)
        writeMemes(memes);
    return { added, merged, dropped, total: memes.length, cap: DAILY_NEW_CAP, addedToday };
}

function stripJsonFence(text) {
    const match = /```(?:json)?\s*([\s\S]*?)```/u.exec(text);
    return match === null ? text : match[1];
}

function buildMaterial({ summaryText, text, captions, danmaku }) {
    const blocks = [];
    const summary = String(summaryText ?? '').trim();
    if (summary !== '')
        blocks.push('[视频总结]\n' + summary.slice(0, 1200));
    const body = String(text ?? '').trim();
    if (body !== '')
        blocks.push('[字幕/转写节选（含时间点，可能有同音错字）]\n' + body.slice(0, MAX_MATERIAL_CHARS));
    const shots = (captions ?? []).filter(Boolean).slice(0, 8);
    if (shots.length > 0)
        blocks.push('[画面观察]\n' + shots.map((item, index) => (index + 1) + '. ' + clampText(item, 100)).join('\n'));
    const timeline = renderTimeline(danmaku, { maxChars: MAX_DANMAKU_CHARS, perBucket: 3 });
    if (timeline !== '')
        blocks.push('[弹幕时间轴（每桶按重复次数排序，×N 表示同一条被刷了 N 次）]\n' + timeline);
    // 全片高频：跨桶累计 ≥5 次的写法，是「真被当梗刷」的最强信号。
    const repeated = (Array.isArray(danmaku?.buckets) ? danmaku.buckets : [])
        .flatMap(bucket => Array.isArray(bucket?.top) ? bucket.top : [])
        .filter(item => Number(item.total ?? 0) >= 5)
        .sort((left, right) => Number(right.total) - Number(left.total))
        .slice(0, 10);
    if (repeated.length > 0)
        blocks.push('[全片重复最多的弹幕]\n' + repeated.map(item => item.text + '×' + item.total).join('、'));
    return blocks.join('\n\n');
}

/**
 * 抽候选梗。只返回候选，不入库（入库用 recordMemeCandidates）。
 * @returns {{ok:boolean, memes:object[], reason:string, ms:number, chars:number}}
 */
export async function extractMemeCandidates({ title, owner, duration, summaryText, text, captions, danmaku, limit = 5 } = {}) {
    const started = Date.now();
    const material = buildMaterial({ summaryText, text, captions, danmaku });
    if (material === '')
        return { ok: false, memes: [], reason: '没有可抽取的材料', ms: 0, chars: 0 };
    const headers = { 'content-type': 'application/json' };
    if (LLM.apiKey !== '')
        headers.authorization = 'Bearer ' + LLM.apiKey;
    const minutes = Math.max(1, Math.round(Number(duration ?? 0) / 60));
    const payload = normalizePayload({
        model: MEME_MODEL,
        stream: false,
        temperature: 0.3,
        max_tokens: 900,
        reasoning_effort: 'none',
        messages: [
            {
                role: 'system',
                content: '你在帮一个中文虚拟角色从 B 站视频里吸收「可长期复用的梗」。只根据给定材料判断，不编造材料里没有的东西。'
                    + '必须区分「视频专有名词/产品型号/参数/人名」和「能在别的对话里复用的梗」，只输出后者。宁缺毋滥。',
            },
            {
                role: 'user',
                content: '视频：《' + String(title ?? '') + '》\nUP：' + String(owner ?? '') + '\n时长：约 ' + minutes + ' 分钟\n\n'
                    + material
                    + '\n\n请只输出 JSON（不要额外文字）：\n'
                    + '{"memes":[{"term":"梗本身，≤20 字","aliases":["同义写法"],'
                    + '"category":"网络梗|流行语|名场面|固定句式|callback",'
                    + '"meaning":"一句话解释它是什么意思","usage":"什么场景下可以自然地用出来，≤40 字",'
                    + '"evidence":{"at":"mm:ss","quote":"视频里的原句","danmaku":["真实出现的弹幕原文"]},'
                    + '"confidence":0.0}]}\n'
                    + '规则：\n'
                    + '1. 最多 ' + Math.max(1, Math.min(Number(limit) || 5, 8)) + ' 条；没有就输出 {"memes":[]}。\n'
                    + '2. 只收：网络梗、流行语、名场面、固定句式、callback。\n'
                    + '3. 不收：产品名/型号/参数/人名/普通名词/行业术语/商业模式（如 JIT、预售、供应链）/视频专有情节；'
                    + '也不收“哈哈”“牛逼”这类普通感叹，除非它本身就是固定梗的写法。\n'
                    + '4. 弹幕里同一写法在整条视频被刷 ≥5 次才算强信号，可作为主要依据。\n'
                    + '5. evidence.at 用 mm:ss；danmaku 填 0–3 条材料里真实出现的弹幕原文，不要编。',
            },
        ],
    });
    try {
        const response = await fetch(MEME_URL, {
            method: 'POST',
            headers,
            signal: AbortSignal.timeout(MEME_TIMEOUT_MS),
            body: JSON.stringify(payload),
        });
        if (!response.ok)
            return { ok: false, memes: [], reason: '梗模型 HTTP ' + response.status, ms: Date.now() - started, chars: material.length };
        const data = await response.json();
        const raw = String(data?.choices?.[0]?.message?.content ?? '').trim();
        let parsed;
        try {
            parsed = JSON.parse(stripJsonFence(raw));
        }
        catch {
            return { ok: false, memes: [], reason: '模型输出不是 JSON', ms: Date.now() - started, chars: material.length };
        }
        const list = Array.isArray(parsed?.memes) ? parsed.memes : Array.isArray(parsed) ? parsed : [];
        const memes = list.map(normalizeCandidate).filter(Boolean);
        return { ok: true, memes, reason: '', ms: Date.now() - started, chars: material.length };
    }
    catch (error) {
        return { ok: false, memes: [], reason: String(error?.message ?? error), ms: Date.now() - started, chars: material.length };
    }
}

/**
 * 一条龙：取字幕（缺转写时）/弹幕 → 抽候选 → 可选入库。
 * 供回填与 CLI 共用；任何一步失败都只返回原因，不抛。
 */
export async function mineMemes({
    bvid,
    title,
    owner,
    duration,
    cid,
    summaryText = '',
    captions = [],
    transcriptPath = '',
    danmaku = null,
    limit = 5,
    write = false,
    // 二创视频的模型归属（deepseek/gpt/claude/gemini/grok/other），普通视频留空。
    aboutSelf = '',
    // 补课深度：0=正常观看，可以入缺口队列；≥1=补课产出的视频，只入库、不再触发补课。
    gapDepth = 0,
    scene = 'video',
} = {}) {
    const started = Date.now();
    let text = '';
    if (String(transcriptPath ?? '') !== '' && existsSync(String(transcriptPath))) {
        try {
            text = readFileSync(String(transcriptPath), 'utf8');
        }
        catch {
            text = '';
        }
    }
    if (text === '') {
        const subtitle = await subtitleText(bvid, cid).catch(() => ({ ok: false, text: '' }));
        text = subtitle?.ok === true ? String(subtitle.text ?? '') : '';
    }
    // watch 里已经采过就直接用；没采到（ok:false）再补一次，仍失败就按实际原因记。
    const collected = danmaku?.ok === true ? danmaku : await collectDanmaku({ cid, duration });
    const extracted = await extractMemeCandidates({ title, owner, duration, summaryText, text, captions, danmaku: collected, limit });
    const result = {
        ok: extracted.ok,
        reason: extracted.reason,
        danmaku: {
            ok: collected?.ok === true,
            reason: collected?.reason ?? '',
            total: Number(collected?.total ?? 0),
            kept: Number(collected?.kept ?? 0),
            bucketSec: Number(collected?.bucketSec ?? 0),
            buckets: Array.isArray(collected?.buckets) ? collected.buckets.length : 0,
        },
        candidates: extracted.memes,
        added: [],
        merged: [],
        totalMemes: 0,
        gapDepth,
        aboutSelf: String(aboutSelf ?? ''),
        gaps: { enqueued: [], skipped: '' },
        ms: Date.now() - started,
    };
    if (write && extracted.ok)
        Object.assign(result, recordMemeCandidates(extracted.memes, { bvid, title, owner, aboutSelf }));

    // 待解释队列：低置信度候选入队。深度限制写在这里，调用方绕不过去。
    if (write && extracted.ok) {
        const threshold = Number(gapConfig().maxConfidence);
        for (const candidate of extracted.memes) {
            const verdict = shouldEnqueueGap({ gapDepth, confidence: candidate.confidence, maxConfidence: threshold });
            if (!verdict.ok) {
                if (verdict.reason === 'depth-limit')
                    result.gaps.skipped = 'depth-limit（补课视频只入库，不再入队）';
                continue;
            }
            const queued = enqueueGap({
                term: candidate.term,
                category: candidate.category,
                confidence: candidate.confidence,
                scene,
                bvid,
                title,
                aboutSelf,
            });
            if (queued.queued)
                result.gaps.enqueued.push(queued.record.term);
        }
    }
    result.totalMemes = loadMemes().length;
    return result;
}

/** 结构性地只返回可注入的梗：别人的模型梗即使被调用方拿到，也不会进自我介绍/人设。 */
export function injectableMemes() {
    return loadMemes().filter(row => row.injectable === true
        && row.usageScope !== 'others-model'
        && row.gate?.status === 'pass');
}

/** 仅作谈资的梗（别人的模型梗），注入层必须和 injectableMemes 分开使用。 */
export function talkOnlyMemes() {
    return loadMemes().filter(row => row.usageScope === 'others-model');
}

/** 按词条找记录，给缺口闭环用。 */
export function findMemeByTerm(term) {
    const hit = findExisting(loadMemes(), { term: String(term ?? ''), aliases: [] });
    return hit?.record ?? null;
}

/* ------------------------------------------------------------------ CLI */

function argValue(name, fallback = '') {
    const index = process.argv.indexOf('--' + name);
    return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

function libraryRow(bvid) {
    return readJsonLines(LIBRARY_PATH).filter(row => row.bvid === bvid).at(-1) ?? null;
}

async function cliExtract() {
    const bvid = argValue('bvid');
    if (bvid === '') {
        console.log('用法：node bili-memes.mjs extract --bvid BV1xx [--limit 5] [--write]');
        return;
    }
    const row = libraryRow(bvid);
    if (row === null) {
        console.log('视频库里没有 ' + bvid + '，先用 bili-backfill 处理过再抽。');
        return;
    }
    const info = await videoInfo(bvid);
    const result = await mineMemes({
        bvid,
        title: row.title,
        owner: row.owner,
        duration: Number(row.duration) || info.duration,
        cid: info.cid,
        summaryText: row.summary,
        captions: row.captions,
        transcriptPath: row.transcriptPath,
        limit: Number(argValue('limit', '5')) || 5,
        write: process.argv.includes('--write'),
        aboutSelf: argValue('aboutSelf'),
    });
    console.log(JSON.stringify(result, null, 2));
}

function cliList() {
    const keyword = argValue('q');
    const min = Number(argValue('min', '0')) || 0;
    const memes = loadMemes()
        .filter(row => min === 0 || Number(row.count ?? 0) >= min)
        .filter(row => keyword === '' || row.term.includes(keyword) || (row.aliases ?? []).some(item => item.includes(keyword)))
        .sort((a, b) => Number(b.count ?? 0) - Number(a.count ?? 0) || String(b.lastSeen).localeCompare(String(a.lastSeen)));
    console.log('共 ' + memes.length + ' 条（可注入 ' + memes.filter(row => row.injectable === true).length
        + '，仅谈资 ' + memes.filter(row => row.usageScope === 'others-model').length + '）');
    for (const row of memes) {
        const tags = [
            row.aboutSelf ? 'aboutSelf=' + row.aboutSelf : '',
            row.usageScope ?? '',
            row.gate?.status === 'blocked' ? 'gate=blocked' : '',
        ].filter(Boolean);
        console.log([row.term, '×' + row.count, row.category, tags.join(','), row.meaning].filter(Boolean).join('  '));
    }
}

if (process.argv[1]?.endsWith('bili-memes.mjs') === true) {
    const command = process.argv[2] ?? 'list';
    if (command === 'extract')
        await cliExtract();
    else if (command === 'refine')
        console.log(JSON.stringify(refineMemes(), null, 2));
    else if (command === 'revoke')
        console.log(JSON.stringify(revokeMeme(argValue('term'), argValue('reason')), null, 2));
    else if (command === 'search')
        console.log(JSON.stringify(searchMemes({ text: argValue('text'), chatId: argValue('chat', 'cli') }), null, 2));
    else
        cliList();
}
