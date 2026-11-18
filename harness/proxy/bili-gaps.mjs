/**
 * 观看策略路由：遇到看不懂的梗，去该去的地方补课，而不是见什么刷什么。
 *
 * 路由目的地只有两类（配置在 bili-pool.json 的 router 里）：
 * - 梗 / 黑话 / 网络流行语 → 梗指南（mid 94510621）投稿池；它没覆盖才兜底全站搜索；
 * - 其余（技术、硬件、影像、商业、行业、兜底）→ 全站搜索，不按 UP 分流。
 *
 * 硬约束：
 * - 每次补课最多看 1 条视频，单条 ≤ 20 分钟；
 * - 同一缺口最多尝试 2 次，之后 gave-up 并记原因；
 * - 低优先级：BelowNormal + 720p + 开跑前检查模型空闲；处理中遇 defer/GPU 租约立刻让路；
 * - 防套娃：mineMemes 以 gapDepth=1 调用，新梗只入库、不再入队（深度限 1）。
 *
 * 用法：
 *   node bili-gaps.mjs list
 *   node bili-gaps.mjs add --term 真串子 [--scene group] [--category 网络梗] [--aboutSelf deepseek]
 *   node bili-gaps.mjs route --term 真串子 [--category 网络梗]
 *   node bili-gaps.mjs run [--limit 1] [--force]
 *   node bili-gaps.mjs selftest
 */
import { join } from 'node:path';
import { searchVideos, watch } from './bili.mjs';
import { LIBRARY_PATH, appendLibraryRow } from './bili-library.mjs';
import { findMemeByTerm, mineMemes, recordMemeCandidates } from './bili-memes.mjs';
import { classifyRoute, detectAboutSelf, gapConfig, loadPool, searchQueries } from './bili-pool-config.mjs';
import { listUploads } from './bili-uploads.mjs';
import { externalBusyWithLease, setLowPriority, sleep, yieldReason } from './bili-worker.mjs';
import {
    enqueueUnknownTerm,
    GAPS_PATH,
    gapStats,
    loadGaps,
    logGap,
    shouldEnqueueGap,
    updateGap,
} from './meme-gaps-core.mjs';

const HOME = 'Y:\\dsh\\home\\qq-persona';
const YIELD_POLL_MS = 10_000;

function argValue(name, fallback = '') {
    const index = process.argv.indexOf('--' + name);
    return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

function firstSentence(text) {
    const value = String(text ?? '').replace(/\s+/gu, ' ').trim();
    if (value === '')
        return '';
    const cut = /^(.{10,120}?[。！？!?])/u.exec(value)?.[1];
    return (cut ?? value.slice(0, 120)).trim();
}

function log(entry) {
    logGap(entry);
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    console.log('[' + time + '] ' + entry.step + '  ' + (entry.detail ?? ''));
}

/** 解释类标题的强弱：直接「是什么梗」最可信，其次梗百科/科普，再次解释/起源。 */
function explainerScore(title) {
    const text = String(title ?? '');
    if (/是什么梗|什么梗/u.test(text))
        return 4;
    if (/梗指南|梗百科|十万个梗/u.test(text))
        return 3;
    if (/什么意思|解释|科普/u.test(text))
        return 2;
    if (/由来|起源|前世今生|怎么来的/u.test(text))
        return 1;
    return 0;
}

/** 优先解释类标题（是什么梗 > 梗百科 > 解释 > 起源），其次标题含原词/别名，最后才取第一条。 */
function pickCandidate(items, term, aliases = []) {
    const words = [term, ...aliases].filter(Boolean).sort((left, right) => right.length - left.length);
    const hits = items.filter(item => words.some(word => String(item.title ?? '').includes(word)));
    const explainers = hits
        .map((item, index) => {
            const title = String(item.title ?? '');
            // 标题直接以词条开头、且是 5 分钟内的短片，更像「就讲这一个梗」的条目。
            const prefix = words.some(word => title.startsWith(word)) ? 2 : 0;
            const short = Number(item.duration) <= 300 ? 1 : 0;
            return { item, index, score: explainerScore(title) + prefix + short };
        })
        .filter(row => row.score > 0)
        .sort((left, right) => right.score - left.score || left.index - right.index);
    return explainers[0]?.item ?? hits[0] ?? items[0] ?? null;
}

async function routeCandidates(gap, poolDoc, conf) {
    const rule = classifyRoute(poolDoc, { term: gap.term, category: gap.category, aboutSelf: gap.aboutSelf });
    // 梗库已有别名（真串子→串子）直接复用，关键词覆盖更全。
    const known = findMemeByTerm(gap.term);
    const aliases = [...new Set([...(Array.isArray(gap.aliases) ? gap.aliases : []), ...(known?.aliases ?? [])])];
    const queries = searchQueries(poolDoc, { term: gap.term, aliases, aboutSelf: gap.aboutSelf, category: gap.category });
    const maxDuration = Number(conf.maxDurationSec);
    const minDuration = Number(conf.minDurationSec) || 30;
    const usable = item => Number(item.duration) >= minDuration && Number(item.duration) <= maxDuration;
    const routes = [];

    if (rule.id === 'meme') {
        const mid = Number(String(rule.target).split(':')[1]);
        const list = await listUploads(mid, { days: 365, ps: 20, pages: 4 });
        const hits = list.items
            .filter(item => [gap.term, ...aliases].some(word => word !== '' && String(item.title).includes(word)))
            .filter(usable);
        log({ gap: gap.id, step: 'route', detail: rule.label + '（' + rule.reason + '），投稿池命中 ' + hits.length + ' 条' });
        if (hits.length > 0) {
            routes.push({ label: rule.label, target: rule.target, items: hits.map(item => ({ ...item, route: rule.label })) });
            return { rule, routes, queries, picked: pickCandidate(hits, gap.term, aliases) };
        }
        log({ gap: gap.id, step: 'route-fallback', detail: rule.label + ' 未覆盖「' + gap.term + '」→ 全站搜索' });
    }

    const orders = Array.isArray(poolDoc.router?.search?.orders) ? poolDoc.router.search.orders : ['totalrank', 'click'];
    const topN = Number(poolDoc.router?.search?.topN) || 6;
    const searchItems = [];
    for (const query of queries) {
        for (const order of orders) {
            let list = [];
            try {
                list = await searchVideos({ query, order, limit: topN });
            }
            catch (error) {
                log({ gap: gap.id, step: 'search-error', detail: query + ' ' + order + ' ' + String(error?.message ?? error).slice(0, 80) });
                continue;
            }
            searchItems.push(...list.filter(usable).map(item => ({ ...item, route: '全站搜索' })));
            await sleep(300);
        }
    }
    const seen = new Set();
    const deduped = searchItems.filter(item => {
        if (seen.has(item.bvid))
            return false;
        seen.add(item.bvid);
        return true;
    });
    log({
        gap: gap.id,
        step: 'search',
        detail: '关键词 ' + JSON.stringify(queries) + '，排序 ' + orders.join('/') + '，取回 '
            + searchItems.length + ' 条，去重 ' + deduped.length + ' 条',
    });
    routes.push({ label: '全站搜索', target: 'search', items: deduped });
    return {
        rule: { ...rule, id: 'search', label: '全站搜索', target: 'search' },
        routes,
        queries,
        picked: pickCandidate(deduped, gap.term, aliases),
    };
}

function libraryRow(manifest, gap) {
    return {
        bvid: manifest.bvid,
        title: manifest.title,
        owner: manifest.owner,
        duration: manifest.duration,
        processedAt: new Date().toISOString(),
        mode: 'gap',
        gap: gap.id,
        summarySource: manifest.summary?.source ?? '',
        summary: manifest.summary?.text ?? '',
        asrModel: manifest.asr?.model ?? '',
        transcriptPath: manifest.asr?.transcriptPath ?? '',
        danmakuTotal: Number(manifest.danmaku?.total ?? 0),
        danmakuKept: Number(manifest.danmaku?.kept ?? 0),
        totalMs: Number(manifest.timing?.total ?? 0),
    };
}

/** 用解释视频的总结兜底回填一条记录（置信度低，门禁会拦住，不会进人设）。 */
function backfillFromSummary(gap, manifest, aboutSelf) {
    const meaning = firstSentence(manifest.summary?.text ?? '');
    if (meaning === '')
        return null;
    recordMemeCandidates([{
        term: gap.term,
        aliases: [],
        category: gap.category || '网络梗',
        meaning,
        usage: '',
        confidence: 0.55,
        evidence: { at: '', quote: meaning, danmaku: '' },
    }], {
        bvid: manifest.bvid,
        title: manifest.title,
        owner: manifest.owner,
        aboutSelf: aboutSelf || '',
    });
    return findMemeByTerm(gap.term);
}

async function runGap(gap, poolDoc, conf) {
    if (gap.attempts >= Number(conf.maxAttempts)) {
        gap.status = 'gave-up';
        gap.gaveUpReason = '已尝试 ' + gap.attempts + ' 次，达到上限';
        updateGap(gap);
        log({ gap: gap.id, step: 'gave-up', detail: gap.gaveUpReason });
        return { ok: false, gaveUp: true };
    }

    const picked = await routeCandidates(gap, poolDoc, conf).catch(error => {
        log({ gap: gap.id, step: 'route-error', detail: String(error?.message ?? error).slice(0, 120) });
        return null;
    });
    if (picked === null) {
        gap.attempts += 1;
        gap.lastResult = 'route-error';
        gap.status = gap.attempts >= Number(conf.maxAttempts) ? 'gave-up' : 'pending';
        if (gap.status === 'gave-up')
            gap.gaveUpReason = '路由失败';
        updateGap(gap);
        return { ok: false };
    }

    gap.attempts += 1;
    gap.lastAttemptAt = new Date().toISOString();
    gap.route = { id: picked.rule.id, label: picked.rule.label, target: picked.rule.target, reason: picked.rule.reason, queries: picked.queries };
    // candidates 存「候选解释」，candidateVideos 单独存路由找到的视频，字段语义别混。
    gap.candidateVideos = picked.routes.flatMap(route => route.items.slice(0, 5).map(item => ({
        bvid: item.bvid,
        title: item.title,
        owner: item.owner,
        duration: item.duration,
        play: item.play ?? 0,
        route: route.label,
    }))).slice(0, 8);
    const video = picked.picked;
    if (video === null) {
        gap.lastResult = 'no-candidate';
        gap.status = gap.attempts >= Number(conf.maxAttempts) ? 'gave-up' : 'pending';
        if (gap.status === 'gave-up')
            gap.gaveUpReason = '路由目的地没有可用视频';
        updateGap(gap);
        log({ gap: gap.id, step: 'no-candidate', detail: '目的地没有 ≤' + conf.maxDurationSec / 60 + ' 分钟的视频，attempts=' + gap.attempts });
        return { ok: false };
    }

    gap.triedVideos = [...(gap.triedVideos ?? []), { bvid: video.bvid, title: video.title, at: new Date().toISOString() }].slice(-4);
    updateGap(gap);
    log({
        gap: gap.id,
        step: 'pick',
        detail: '[' + gap.route.label + '] ' + video.bvid + '  ' + Math.round(video.duration / 60) + ' 分钟  ' + video.title.slice(0, 50),
    });

    let interrupt = '';
    const timer = setInterval(async () => {
        const busy = await externalBusyWithLease().catch(() => '');
        if (busy !== '')
            interrupt = busy;
    }, YIELD_POLL_MS);
    const started = Date.now();
    try {
        const manifest = await watch(video.bvid, {
            chatId: 'bili:gap',
            mode: 'gap',
            triggeredBy: 'gap',
            summarize: true,
            record: false,
            shouldYield: () => interrupt,
            maxDurationSec: Number(conf.maxDurationSec),
        });
        log({ gap: gap.id, step: 'watch', detail: 'ok ' + (Date.now() - started) + 'ms，总结来源 ' + (manifest.summary?.source ?? '') });

        // 只收「确实提到这个词」的总结，避免别的任务/错误上下文串进来当候选解释。
        const explanation = firstSentence(manifest.summary?.text ?? '');
        const words = [gap.term, ...(findMemeByTerm(gap.term)?.aliases ?? [])].filter(Boolean);
        if (explanation !== '' && words.some(word => explanation.includes(word)))
            gap.candidates = [...new Set([...(gap.candidates ?? []), explanation])].slice(-3);

        appendLibraryRow(libraryRow(manifest, gap));
        log({ gap: gap.id, step: 'library', detail: '已入库 ' + manifest.bvid });

        const aboutSelf = String(gap.aboutSelf ?? '') || detectAboutSelf(poolDoc, manifest.title).aboutSelf;
        const memes = await mineMemes({
            bvid: manifest.bvid,
            title: manifest.title,
            owner: manifest.owner,
            duration: manifest.duration,
            cid: Number(manifest.danmaku?.cid ?? 0),
            summaryText: manifest.summary?.text ?? '',
            transcriptPath: manifest.asr?.transcriptPath ?? '',
            danmaku: manifest.danmaku,
            limit: 5,
            write: true,
            gapDepth: 1,
            aboutSelf,
        });
        log({
            gap: gap.id,
            step: 'mine',
            detail: '候选 ' + memes.candidates.length + '，新增 ' + memes.added.length + '，合并 '
                + memes.merged.length + '，入队 ' + memes.gaps.enqueued.length
                + (memes.gaps.skipped === '' ? '' : '，跳过（' + memes.gaps.skipped + '）'),
        });

        let record = findMemeByTerm(gap.term);
        if (record === null)
            record = backfillFromSummary(gap, manifest, aboutSelf);
        if (record === null) {
            gap.lastResult = 'no-record';
            gap.status = gap.attempts >= Number(conf.maxAttempts) ? 'gave-up' : 'pending';
            if (gap.status === 'gave-up')
                gap.gaveUpReason = '视频里没有抽到「' + gap.term + '」的解释';
            updateGap(gap);
            log({ gap: gap.id, step: 'no-record', detail: 'attempts=' + gap.attempts + '，' + (gap.gaveUpReason ?? '等待重试') });
            return { ok: false };
        }

        gap.status = 'closed';
        gap.closedAt = new Date().toISOString();
        gap.sourceVideo = { bvid: manifest.bvid, title: manifest.title, owner: manifest.owner, route: gap.route.label };
        gap.explanation = record.meaning || (gap.candidates ?? []).at(-1) || '';
        gap.memeId = record.id ?? '';
        gap.gate = record.gate ?? null;
        gap.lastResult = 'closed';
        updateGap(gap);
        log({
            gap: gap.id,
            step: 'close',
            detail: '「' + record.term + '」→ ' + String(record.meaning ?? '').slice(0, 80)
                + '；memeId=' + record.id + '，gate=' + (record.gate?.status ?? '?') + '，总耗时 ' + (Date.now() - started) + 'ms',
        });
        return { ok: true, record };
    }
    catch (error) {
        const message = String(error?.message ?? error);
        if (message.includes('BILI_YIELD')) {
            // 让路不消耗尝试次数。
            gap.attempts = Math.max(0, gap.attempts - 1);
            gap.lastResult = 'yield';
            gap.status = 'pending';
            updateGap(gap);
            log({ gap: gap.id, step: 'yield', detail: 'QQ 有请求，暂停补课：' + message });
            return { ok: false, yielded: true };
        }
        gap.lastResult = 'failed';
        gap.lastError = message.slice(0, 160);
        gap.status = gap.attempts >= Number(conf.maxAttempts) ? 'gave-up' : 'pending';
        if (gap.status === 'gave-up')
            gap.gaveUpReason = message.slice(0, 120);
        updateGap(gap);
        log({ gap: gap.id, step: 'failed', detail: message.slice(0, 120) + '，attempts=' + gap.attempts });
        return { ok: false };
    }
    finally {
        clearInterval(timer);
    }
}

async function cliRun({ limit = 1, force = false } = {}) {
    const poolDoc = loadPool();
    const conf = gapConfig(poolDoc);
    const applied = setLowPriority();
    console.log('[低优先级] ' + (applied ? '进程已降到 BelowNormal' : '优先级设置失败，仍单条串行')
        + '；每次 1 条、单条上限 ' + Math.round(Number(conf.maxDurationSec) / 60) + ' 分钟、最多 '
        + conf.maxAttempts + ' 次；QQ 有请求时让路');

    const reason = await yieldReason();
    if (reason !== '') {
        console.log('[让路] ' + reason + '，本轮不补课');
        log({ step: 'yield-before-run', detail: reason });
        return;
    }

    const pending = loadGaps().filter(gap => gap.status === 'pending').slice(0, limit);
    if (pending.length === 0) {
        console.log('没有 pending 缺口。');
        return;
    }
    for (const gap of pending) {
        if (!force && gap.lastAttemptAt !== undefined && gap.lastAttemptAt !== null) {
            const age = Date.now() - Date.parse(gap.lastAttemptAt);
            if (Number.isFinite(age) && age < Number(conf.cooldownMs)) {
                console.log('[冷却] ' + gap.term + ' 距上次尝试 ' + Math.round(age / 60_000)
                    + ' 分钟（冷却 ' + Math.round(Number(conf.cooldownMs) / 60_000) + '），跳过');
                continue;
            }
        }
        const result = await runGap(gap, poolDoc, conf);
        if (result?.yielded === true)
            break;
    }
    const stats = gapStats();
    console.log('队列统计：' + JSON.stringify(stats));
}

function cliList() {
    const rows = loadGaps();
    console.log('meme-gaps：' + GAPS_PATH);
    console.log('字段：id/term/firstSeen/scene/category/candidates(候选解释)/candidateVideos/attempts/status/route/triedVideos/sourceVideo/closedAt/gaveUpReason');
    console.log('统计：' + JSON.stringify(gapStats()));
    for (const gap of rows) {
        console.log([
            gap.status,
            gap.term,
            '×' + gap.attempts,
            gap.scene,
            gap.route?.label ?? '-',
            gap.lastResult ?? '',
            gap.gaveUpReason ?? '',
        ].filter(Boolean).join('  '));
    }
}

async function cliRoute() {
    const term = argValue('term');
    if (term === '') {
        console.log('用法：node bili-gaps.mjs route --term 真串子 [--category 网络梗] [--aboutSelf deepseek]');
        return;
    }
    const poolDoc = loadPool();
    const conf = gapConfig(poolDoc);
    const gap = {
        id: 'dry-run',
        term,
        category: argValue('category'),
        aboutSelf: argValue('aboutSelf'),
        aliases: [],
    };
    const routed = await routeCandidates(gap, poolDoc, conf);
    console.log('路由：' + routed.rule.label + '（' + routed.rule.reason + '）');
    console.log('关键词：' + JSON.stringify(routed.queries));
    console.log('选中：' + (routed.picked === null ? '无' : routed.picked.bvid + '  ' + routed.picked.title));
    for (const route of routed.routes)
        for (const item of route.items.slice(0, 6))
            console.log('  [' + item.route + '] ' + item.bvid + '  ' + Math.round(item.duration / 60) + '分  ' + item.owner + '  ' + item.title.slice(0, 50));
}

function cliSelfTest() {
    const cases = [
        { name: '正常抽梗（深度0，置信度0.6）', input: { gapDepth: 0, confidence: 0.6, maxConfidence: 0.6 }, expect: true },
        { name: '补课视频（深度1）', input: { gapDepth: 1, confidence: 0.3, maxConfidence: 0.6 }, expect: false },
        { name: '高置信度（0.9）', input: { gapDepth: 0, confidence: 0.9, maxConfidence: 0.6 }, expect: false },
    ];
    let pass = 0;
    for (const item of cases) {
        const verdict = shouldEnqueueGap(item.input);
        const ok = verdict.ok === item.expect;
        if (ok)
            pass += 1;
        console.log((ok ? 'PASS' : 'FAIL') + '  ' + item.name + ' → ' + JSON.stringify(verdict));
    }
    console.log(pass + '/' + cases.length + ' 通过（深度限制与置信度阈值都是代码硬判定）');
}

if (process.argv[1]?.endsWith('bili-gaps.mjs') === true) {
    const command = process.argv[2] ?? 'list';
    if (command === 'add') {
        const term = argValue('term');
        const result = enqueueUnknownTerm(term, {
            scene: argValue('scene', 'group'),
            category: argValue('category'),
            aboutSelf: argValue('aboutSelf'),
            reason: 'cli-add',
        });
        console.log(JSON.stringify({ queued: result.queued, reason: result.reason, record: result.record }, null, 2));
    }
    else if (command === 'route') {
        await cliRoute();
    }
    else if (command === 'run') {
        await cliRun({
            limit: Math.max(1, Number(argValue('limit', '1')) || 1),
            force: process.argv.includes('--force'),
        });
    }
    else if (command === 'selftest') {
        cliSelfTest();
    }
    else {
        cliList();
    }
}
