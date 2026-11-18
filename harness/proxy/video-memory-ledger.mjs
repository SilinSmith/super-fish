/**
 * 视频记忆账本 + 消化队列（独立文件，不并进 bili-library.jsonl）。
 *
 * 账本只存引用，不存记忆正文：一行 = 一次消化尝试，
 * 能回答「哪条 bvid → 哪条记忆 → 写在哪 → 什么时候」。
 * 队列一行 = 一条待消化视频；消费后写 done 标记做幂等，不改旧行。
 *
 * 纯文件读写，无定时器、无网络；persona 脚本与 dsh-onebot-qq 插件共用。
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PERSONA_HOME = process.env.QQ_PERSONA_HOME ?? 'Y:\\dsh\\home\\qq-persona';
export const LEDGER_PATH = process.env.QQ_VIDEO_MEMORY_LEDGER ?? join(PERSONA_HOME, 'bili-video-memory.jsonl');
export const QUEUE_PATH = process.env.QQ_VIDEO_DIGEST_QUEUE ?? join(PERSONA_HOME, 'bili-digest-queue.jsonl');
export const DONE_PATH = process.env.QQ_VIDEO_DIGEST_DONE ?? join(PERSONA_HOME, 'bili-digest-done.jsonl');
export const NOTEBOOK_PATH = process.env.QQ_NOTEBOOK ?? join(PERSONA_HOME, 'notebook.json');
export const DIARY_PATH = process.env.QQ_DIARY ?? join(PERSONA_HOME, 'diary.jsonl');

function readJsonLines(path) {
    if (!existsSync(path))
        return [];
    const rows = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '')
            continue;
        try {
            rows.push(JSON.parse(trimmed));
        }
        catch {
            // 坏行跳过：账本不能让一条残行拖垮整批统计
        }
    }
    return rows;
}

function appendRow(path, row) {
    appendFileSync(path, JSON.stringify(row) + '\n', 'utf8');
    return row;
}

/* ---------------- 账本 ---------------- */

export function readLedger() {
    return readJsonLines(LEDGER_PATH);
}

/** 追加一行账本；调用方负责给出 kind / memoryId / reason。 */
export function appendLedger(row) {
    const entry = {
        bvid: String(row?.bvid ?? ''),
        at: String(row?.at ?? new Date().toISOString()),
        kind: row?.kind === 'notebook' || row?.kind === 'diary' ? row.kind : 'none',
        memoryId: String(row?.memoryId ?? ''),
        chatId: String(row?.chatId ?? 'bili:digest'),
        queueId: String(row?.queueId ?? ''),
        windowFrom: String(row?.windowFrom ?? ''),
        windowTo: String(row?.windowTo ?? ''),
        chars: Number(row?.chars ?? 0),
        hollow: row?.hollow === true,
        reason: String(row?.reason ?? ''),
        attempt: Number(row?.attempt ?? 1),
        ...(Array.isArray(row?.extraIds) && row.extraIds.length > 0 ? { extraIds: row.extraIds.map(String) } : {}),
    };
    return appendRow(LEDGER_PATH, entry);
}

/* ---------------- 队列 ---------------- */

export function readQueue() {
    return readJsonLines(QUEUE_PATH);
}

export function readDone() {
    return readJsonLines(DONE_PATH);
}

function queueRow(job) {
    return {
        queueId: 'dq_' + randomUUID().slice(0, 8),
        bvid: String(job?.bvid ?? ''),
        title: String(job?.title ?? '').slice(0, 160),
        owner: String(job?.owner ?? '').slice(0, 80),
        duration: Number(job?.duration ?? 0),
        summary: String(job?.summary ?? '').slice(0, 1800),
        captions: Array.isArray(job?.captions) ? job.captions.slice(0, 6).map(String) : [],
        source: String(job?.source ?? 'backfill'),
        enqueuedAt: new Date().toISOString(),
        attempts: Math.max(0, Number(job?.attempts ?? 0)),
    };
}

/**
 * 入队；同一 bvid 已在队列里、或账本里已有非 none 的成功记录时不重复入队。
 * 返回入队行，跳过时返回 null。
 */
export function enqueueDigest(job) {
    const bvid = String(job?.bvid ?? '').trim();
    if (bvid === '')
        throw new Error('enqueueDigest: bvid 必填');
    const done = new Set(readDone().map(row => String(row?.queueId ?? '')));
    if (readQueue().some(row => String(row?.bvid ?? '') === bvid && !done.has(String(row?.queueId ?? ''))))
        return null;
    if (readLedger().some(row => String(row?.bvid ?? '') === bvid && row?.kind !== 'none'))
        return null;
    return appendRow(QUEUE_PATH, queueRow({ ...job, bvid }));
}

/** 最早一条未完成的队列项；没有返回 null。 */
export function peekDigest() {
    const done = new Set(readDone().map(row => String(row?.queueId ?? '')));
    for (const row of readQueue()) {
        if (!done.has(String(row?.queueId ?? '')))
            return row;
    }
    return null;
}

/** 被打断/超时后的重排队：新 queueId、attempts+1，旧行用 done 标记收口。 */
export function requeueDigest(job) {
    const attempts = Number(job?.attempts ?? 0) + 1;
    return appendRow(QUEUE_PATH, queueRow({ ...job, attempts }));
}

export function markDigestDone(queueId, result) {
    return appendRow(DONE_PATH, {
        queueId: String(queueId ?? ''),
        at: new Date().toISOString(),
        result: String(result ?? ''),
    });
}

/* ---------------- 空洞判定（M5 共用） ---------------- */

const GENERIC_OPENING = /^(看了|看完|没啥|没什么|没有值得|不值得|无|记不住|跳过|感觉一般|一般般)/u;

/** 一条记忆是否空洞：过短，或“看了/没啥”开头且没有具体内容。 */
export function hollowOf(text) {
    const value = String(text ?? '').replace(/\s+/gu, ' ').trim();
    if (value === '')
        return true;
    if (value.length < 12)
        return true;
    return GENERIC_OPENING.test(value) && value.length < 40;
}
