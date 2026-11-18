/**
 * 自迭代的落盘层：配置、状态、提案、审计、指标。
 *
 * 约定：
 * - 所有写入都是「临时文件 + rename」原子替换，或者 append-only jsonl；
 * - 运行锁用 pid + expiresAt，进程被强杀也不会把自迭代永久卡死；
 * - 本模块不判定“该不该跑”，只负责读写，判定在 index.mjs。
 */
import { createHash } from 'node:crypto';
import { appendFile, copyFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
// 生产部署时 self-iter 位于 persona 根下，dirname(HERE) 即 persona 根；
// 仓库里它是独立目录，因此允许用 QQ_PROXY_ROOT / XZY_PERSONA_DIR 显式指定。
export const ROOT = process.env.QQ_PROXY_ROOT ?? process.env.XZY_PERSONA_DIR ?? dirname(HERE);
export const CONFIG_PATH = process.env.QQ_SELF_ITER_CONFIG ?? join(HERE, 'config.json');
export const STATE_PATH = join(HERE, 'state.json');
export const LOCK_PATH = join(HERE, 'run.lock');
export const PROPOSAL_DIR = join(HERE, 'proposals');
export const LEDGER_PATH = join(HERE, 'ledger.jsonl');
export const METRICS_PATH = join(HERE, 'metrics.jsonl');
export const BACKUP_DIR = join(HERE, 'backups');

export const CHARACTER_PATH = join(ROOT, 'character.md');
export const NOTEBOOK_PATH = join(ROOT, 'notebook.json');
export const DIARY_PATH = join(ROOT, 'diary.jsonl');
export const FEED_PATH = join(ROOT, 'conversation-feed.jsonl');
export const GROUP_STATE_DIR = join(ROOT, 'group-state');

const CONFIG_DEFAULTS = {
    enabled: true,
    // auto-notes：笔记自动入库，人格改动待审；review：全部待审（保留给回滚/降级）。
    mode: 'auto-notes',
    minGapMs: 90 * 60_000,
    maxPerDay: 6,
    idleMs: 10 * 60_000,
    materialMinEvents: 30,
    materialMaxAgeMs: 3 * 3600_000,
    // 只复盘群聊：私聊内容不进反思材料，避免跨场景泄漏。
    onlyGroups: true,
    model: {
        timeoutMs: 120_000,
        maxTokens: 900,
        temperature: 0.3,
        maxPromptChars: 14_000,
    },
    gates: {
        maxFindings: 3,
        maxNotebookPerRun: 3,
        maxNotebookPerDay: 6,
        maxCharacterPerDay: 1,
        maxCharacterChars: 400,
        maxExampleChars: 60,
        minConfidence: 0.55,
    },
};

function positive(value, fallback, min = 1) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function clamp01(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.min(1, Math.max(0, parsed));
}

/** 配置校验：只认已知字段，非法值回落到默认值；返回值可直接写盘。 */
export function normalizeConfig(raw) {
    const source = raw !== null && typeof raw === 'object' ? raw : {};
    const model = source.model !== null && typeof source.model === 'object' ? source.model : {};
    const gates = source.gates !== null && typeof source.gates === 'object' ? source.gates : {};
    return {
        enabled: source.enabled !== false,
        mode: source.mode === 'review' ? 'review' : 'auto-notes',
        minGapMs: positive(source.minGapMs, CONFIG_DEFAULTS.minGapMs, 60_000),
        maxPerDay: Math.round(positive(source.maxPerDay, CONFIG_DEFAULTS.maxPerDay)),
        idleMs: positive(source.idleMs, CONFIG_DEFAULTS.idleMs, 60_000),
        materialMinEvents: Math.round(positive(source.materialMinEvents, CONFIG_DEFAULTS.materialMinEvents)),
        materialMaxAgeMs: positive(source.materialMaxAgeMs, CONFIG_DEFAULTS.materialMaxAgeMs, 60_000),
        onlyGroups: source.onlyGroups !== false,
        model: {
            timeoutMs: positive(model.timeoutMs, CONFIG_DEFAULTS.model.timeoutMs, 10_000),
            maxTokens: Math.round(positive(model.maxTokens, CONFIG_DEFAULTS.model.maxTokens, 128)),
            temperature: clamp01(model.temperature, CONFIG_DEFAULTS.model.temperature),
            maxPromptChars: Math.round(positive(model.maxPromptChars, CONFIG_DEFAULTS.model.maxPromptChars, 2_000)),
        },
        gates: {
            maxFindings: Math.round(positive(gates.maxFindings, CONFIG_DEFAULTS.gates.maxFindings)),
            maxNotebookPerRun: Math.round(positive(gates.maxNotebookPerRun, CONFIG_DEFAULTS.gates.maxNotebookPerRun)),
            maxNotebookPerDay: Math.round(positive(gates.maxNotebookPerDay, CONFIG_DEFAULTS.gates.maxNotebookPerDay)),
            maxCharacterPerDay: Math.round(positive(gates.maxCharacterPerDay, CONFIG_DEFAULTS.gates.maxCharacterPerDay)),
            maxCharacterChars: Math.round(positive(gates.maxCharacterChars, CONFIG_DEFAULTS.gates.maxCharacterChars, 40)),
            maxExampleChars: Math.round(positive(gates.maxExampleChars, CONFIG_DEFAULTS.gates.maxExampleChars, 10)),
            minConfidence: clamp01(gates.minConfidence, CONFIG_DEFAULTS.gates.minConfidence),
        },
    };
}

export async function readConfig() {
    try {
        return normalizeConfig(JSON.parse(await readFile(CONFIG_PATH, 'utf8')));
    }
    catch {
        return normalizeConfig({});
    }
}

export async function writeConfig(next) {
    const normalized = normalizeConfig(next);
    await writeJsonAtomic(CONFIG_PATH, normalized);
    return normalized;
}

export async function readJson(path, fallback = null) {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    }
    catch {
        return fallback;
    }
}

export async function writeJsonAtomic(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = path + '.tmp-' + process.pid;
    await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    await rename(tmp, path);
}

export async function fileHash(path) {
    try {
        return createHash('sha256').update(await readFile(path)).digest('hex');
    }
    catch {
        return '';
    }
}

export async function fileStamp(path) {
    try {
        const info = await stat(path);
        return { size: info.size, mtimeMs: Math.round(info.mtimeMs), hash: await fileHash(path) };
    }
    catch {
        return { size: 0, mtimeMs: 0, hash: '' };
    }
}

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

function localDay(now = Date.now()) {
    const date = new Date(now);
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0')
        + '-' + String(date.getDate()).padStart(2, '0');
}

export async function readState() {
    const raw = await readJson(STATE_PATH, {});
    const day = localDay();
    const state = {
        version: 1,
        lastRunAt: typeof raw?.lastRunAt === 'string' ? raw.lastRunAt : '',
        lastRun: raw?.lastRun ?? null,
        lastError: raw?.lastError ?? null,
        runsToday: {
            day: String(raw?.runsToday?.day ?? ''),
            count: Number(raw?.runsToday?.count ?? 0),
        },
        notebookToday: {
            day: String(raw?.notebookToday?.day ?? ''),
            count: Number(raw?.notebookToday?.count ?? 0),
        },
        characterToday: {
            day: String(raw?.characterToday?.day ?? ''),
            count: Number(raw?.characterToday?.count ?? 0),
        },
        characterChangedTotal: Number(raw?.characterChangedTotal ?? 0),
        updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : '',
    };
    for (const key of ['runsToday', 'notebookToday', 'characterToday']) {
        if (state[key].day !== day) {
            state[key].day = day;
            state[key].count = 0;
        }
    }
    return state;
}

export async function writeState(state) {
    await writeJsonAtomic(STATE_PATH, { ...state, updatedAt: new Date().toISOString() });
}

/* ------------------------------------------------------------------ */
/* 运行锁                                                              */
/* ------------------------------------------------------------------ */

function pidAlive(pid) {
    if (!Number.isFinite(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}

/** 拿运行锁；返回 {ok, lock}。过期或持有进程已退出时自动接管。 */
export async function acquireLock(ttlMs = 10 * 60_000) {
    const now = Date.now();
    const lock = {
        pid: process.pid,
        startedAt: now,
        expiresAt: now + ttlMs,
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await mkdir(HERE, { recursive: true });
            await writeFile(LOCK_PATH, JSON.stringify(lock) + '\n', { encoding: 'utf8', flag: 'wx' });
            return { ok: true, lock };
        }
        catch {
            const current = await readJson(LOCK_PATH, null);
            const expired = !current || Number(current.expiresAt) < now || !pidAlive(Number(current.pid));
            if (!expired)
                return { ok: false, lock: current };
            await unlink(LOCK_PATH).catch(() => {});
        }
    }
    return { ok: false, lock: await readJson(LOCK_PATH, null) };
}

export async function releaseLock() {
    const current = await readJson(LOCK_PATH, null);
    if (current !== null && Number(current.pid) !== process.pid)
        return false;
    await unlink(LOCK_PATH).catch(() => {});
    return true;
}

/* ------------------------------------------------------------------ */
/* 提案                                                                */
/* ------------------------------------------------------------------ */

export async function listProposals(limit = 100) {
    let names;
    try {
        names = await readdir(PROPOSAL_DIR);
    }
    catch {
        return [];
    }
    const files = names.filter(name => name.endsWith('.json')).sort().slice(-limit);
    const rows = [];
    for (const name of files) {
        const doc = await readJson(join(PROPOSAL_DIR, name), null);
        if (doc !== null && typeof doc === 'object')
            rows.push(doc);
    }
    return rows.sort((left, right) => String(right.ts).localeCompare(String(left.ts)));
}

export async function getProposal(id) {
    if (typeof id !== 'string' || !/^si-[a-z0-9-]+$/u.test(id))
        return null;
    return readJson(join(PROPOSAL_DIR, id + '.json'), null);
}

export async function saveProposal(proposal) {
    await mkdir(PROPOSAL_DIR, { recursive: true });
    await writeJsonAtomic(join(PROPOSAL_DIR, proposal.id + '.json'), proposal);
    return proposal;
}

export function proposalId(now = Date.now()) {
    const day = localDay(now).replace(/-/gu, '');
    const clock = String(now).slice(-7);
    return 'si-' + day + '-' + clock;
}

/* ------------------------------------------------------------------ */
/* 审计与指标                                                          */
/* ------------------------------------------------------------------ */

let appendChain = Promise.resolve();

/** 串行 append，避免并发写把 jsonl 行交织在一起。 */
export function appendJsonl(path, entry) {
    const line = JSON.stringify(entry) + '\n';
    appendChain = appendChain
        .then(async () => {
            await mkdir(dirname(path), { recursive: true });
            await appendFile(path, line, 'utf8');
        })
        .catch(() => undefined);
    return appendChain;
}

export function audit(entry) {
    return appendJsonl(LEDGER_PATH, { ts: new Date().toISOString(), ...entry });
}

export function metric(entry) {
    return appendJsonl(METRICS_PATH, { ts: new Date().toISOString(), ...entry });
}

/** 读 metrics 末尾若干行；文件大时只读尾部 512KB。 */
export async function recentMetrics(limit = 10) {
    let handle;
    try {
        const info = await stat(METRICS_PATH);
        const length = Math.min(info.size, 512 * 1024);
        const buffer = Buffer.alloc(length);
        handle = await open(METRICS_PATH, 'r');
        await handle.read(buffer, 0, length, info.size - length);
        const lines = buffer.toString('utf8').trim().split('\n').filter(line => line.trim() !== '');
        return lines.slice(-limit).map(line => {
            try {
                return JSON.parse(line);
            }
            catch {
                return null;
            }
        }).filter(Boolean);
    }
    catch {
        return [];
    }
    finally {
        await handle?.close().catch(() => {});
    }
}

export async function backupFile(path, label) {
    await mkdir(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    const target = join(BACKUP_DIR, label + '-' + stamp + '-' + process.pid + '.bak');
    await copyFile(path, target);
    return target;
}
