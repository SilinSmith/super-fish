/**
 * 视频→人格痕迹度量（M1–M5，只读）。
 *
 * 用法：node video-memory-metrics.mjs [--json]
 *
 * M1 coverage        有非 none 账本记录的视频 / 库内视频
 * M2 memoryPerVideo  归因到视频的 notebook 条目 / 已消化视频（分母不含 none）
 * M3 memeHitsReal    meme-inject 里排除验收流量的真实命中次数
 * M4 survivalD1/3/7  写入后 N 天仍存在且 active 的比例（样本不足给 null）
 * M5 hollowRate      空洞条目 / 非 none 条目；none 单独计数并给理由分布
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOME = process.env.QQ_PERSONA_HOME ?? 'Y:\\dsh\\home\\qq-persona';
const LIBRARY_PATH = join(HOME, 'bili-library.jsonl');
const LEDGER_PATH = join(HOME, 'bili-video-memory.jsonl');
const QUEUE_PATH = join(HOME, 'bili-digest-queue.jsonl');
const NOTEBOOK_PATH = join(HOME, 'notebook.json');
const DIARY_PATH = join(HOME, 'diary.jsonl');
const MEMES_PATH = join(HOME, 'memes.jsonl');
const INJECT_PATH = join(HOME, 'meme-inject.jsonl');

const read = path => existsSync(path) ? readFileSync(path, 'utf8') : '';
const jsonl = path => read(path).split('\n').filter(line => line.trim() !== '').map((line) => {
    try {
        return JSON.parse(line);
    }
    catch {
        return null;
    }
}).filter(Boolean);
const json = path => {
    try {
        return JSON.parse(read(path));
    }
    catch {
        return null;
    }
};

const library = jsonl(LIBRARY_PATH);
const ledger = jsonl(LEDGER_PATH);
const queue = jsonl(QUEUE_PATH);
const notebook = json(NOTEBOOK_PATH) ?? { entries: [] };
const diary = jsonl(DIARY_PATH);
const memes = jsonl(MEMES_PATH);
const injects = jsonl(INJECT_PATH);

const now = Date.now();
const entries = Array.isArray(notebook.entries) ? notebook.entries : [];
const entryById = new Map(entries.map(entry => [String(entry.id ?? ''), entry]));
const libraryBvids = new Set(library.map(item => String(item.bvid ?? '')));

/** 每个 bvid 取最后一次非 none 的账本行（重试成功覆盖之前的 none）。 */
const latestSuccess = new Map();
const noneRows = [];
for (const row of ledger) {
    if (row.kind === 'notebook' || row.kind === 'diary')
        latestSuccess.set(String(row.bvid ?? ''), row);
    else
        noneRows.push(row);
}
const attempted = new Set(ledger.map(row => String(row.bvid ?? '')));
const coverage = libraryBvids.size === 0 ? null : [...latestSuccess.keys()].filter(bvid => libraryBvids.has(bvid)).length / libraryBvids.size;

const notebookRows = [...latestSuccess.values()].filter(row => row.kind === 'notebook');
const memoryPerVideo = latestSuccess.size === 0 ? null : notebookRows.length / latestSuccess.size;

/* 真实梗引用：排除验收流量（test/c1/final-check）和消化轮自身。 */
const TEST_CHAT = /^(test|c1|final-check|final_check|bili:digest)$/iu;
const hits = injects.flatMap(line => {
    const chat = String(line?.chat ?? line?.chatId ?? line?.scene ?? '');
    if (TEST_CHAT.test(chat))
        return [];
    return (Array.isArray(line?.picked) ? line.picked : []).map(pick => ({ chat, id: String(pick?.id ?? ''), ts: line.ts }));
});
const memeHitsAll = injects.reduce((sum, line) => sum + (Array.isArray(line?.picked) ? line.picked.length : 0), 0);

/* 存活：账本写入的 memoryId 在 N 天后仍存在且 active；样本不足为 null。 */
function survival(days) {
    const eligible = [];
    let alive = 0;
    for (const row of latestSuccess.values()) {
        if (row.kind !== 'notebook' || row.memoryId === '')
            continue;
        const written = Date.parse(String(row.at ?? ''));
        if (!Number.isFinite(written) || now - written < days * 86_400_000)
            continue;
        eligible.push(row);
        const entry = entryById.get(String(row.memoryId));
        if (entry !== undefined && (entry.status ?? 'active') === 'active')
            alive += 1;
    }
    if (eligible.length === 0)
        return null;
    return { rate: alive / eligible.length, eligible: eligible.length, alive };
}

const hollowRows = [...latestSuccess.values()].filter(row => row.hollow === true);
const hollowRate = latestSuccess.size === 0 ? null : hollowRows.length / latestSuccess.size;
const noneReasons = new Map();
for (const row of noneRows) {
    const key = String(row.reason ?? '未说明').slice(0, 40) || '未说明';
    noneReasons.set(key, (noneReasons.get(key) ?? 0) + 1);
}

/* 兼容旧口径：库内视频在 notebook/diary 里的字面提及数（含人工写入）。 */
function mentions(bvid, title) {
    const needle = title.length >= 4 ? title : '';
    const hit = value => value.includes(bvid) || (needle !== '' && value.includes(needle));
    const notebookHits = entries.filter(entry => hit(JSON.stringify(entry))).length;
    const diaryHits = diary.filter(line => hit(JSON.stringify(line))).length;
    return { notebookHits, diaryHits };
}
let notebookMentions = 0;
let diaryMentions = 0;
for (const item of library) {
    const found = mentions(String(item.bvid ?? ''), String(item.title ?? ''));
    notebookMentions += found.notebookHits;
    diaryMentions += found.diaryHits;
}

const report = {
    at: new Date().toISOString(),
    inputs: {
        libraryVideos: library.length,
        ledgerRows: ledger.length,
        queueRows: queue.length,
        notebookEntries: entries.length,
        diaryLines: diary.length,
        memes: memes.length,
        injectLines: injects.length,
    },
    M1: { coverage, digested: latestSuccess.size, attempted: attempted.size, library: libraryBvids.size },
    M2: { memoryPerVideo, notebookRows: notebookRows.length },
    M3: { memeHitsReal: hits.length, memeHitsAll, fakeHits: memeHitsAll - hits.length, samples: hits.slice(0, 5) },
    M4: { survivalD1: survival(1), survivalD3: survival(3), survivalD7: survival(7) },
    M5: {
        hollowRate,
        hollowRows: hollowRows.length,
        nonNoneRows: latestSuccess.size,
        noneRows: noneRows.length,
        noneRate: ledger.length === 0 ? null : noneRows.length / ledger.length,
        noneReasons: [...noneReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    },
    legacyMentions: { notebookMentions, diaryMentions },
};

console.log(JSON.stringify(report, null, 2));

if (!process.argv.includes('--json')) {
    const pct = value => value === null ? 'n/a' : (value * 100).toFixed(1) + '%';
    const surv = value => value === null ? '样本不足' : pct(value.rate) + '（' + value.alive + '/' + value.eligible + '）';
    console.log('');
    console.log('M1 覆盖      ' + pct(report.M1.coverage) + '（' + report.M1.digested + '/' + report.M1.library + ' 条视频有非 none 账本）');
    console.log('M2 每视频记忆 ' + (report.M2.memoryPerVideo === null ? 'n/a' : report.M2.memoryPerVideo.toFixed(2)) + ' 条 notebook');
    console.log('M3 真实梗命中 ' + report.M3.memeHitsReal + ' 次（全部 ' + report.M3.memeHitsAll + '，验收流量 ' + report.M3.fakeHits + '）');
    console.log('M4 存活      D1 ' + surv(report.M4.survivalD1) + ' · D3 ' + surv(report.M4.survivalD3) + ' · D7 ' + surv(report.M4.survivalD7));
    console.log('M5 空洞率    ' + pct(report.M5.hollowRate) + '（' + report.M5.hollowRows + '/' + report.M5.nonNoneRows + '），none ' + report.M5.noneRows + ' 条');
    if (report.M5.noneReasons.length > 0)
        console.log('   none 理由   ' + report.M5.noneReasons.map(([reason, count]) => reason + '×' + count).join('；'));
    console.log('旧口径提及   notebook ' + report.legacyMentions.notebookMentions + ' 条 · diary ' + report.legacyMentions.diaryMentions + ' 行');
}
