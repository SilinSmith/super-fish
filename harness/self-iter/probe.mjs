/**
 * 自迭代的环境探针：空闲判定、让路信号、GPU 采样、材料读取。
 *
 * 只读现有文件/接口，不新增服务、不改代理：
 * - /internal/queue（proxy 已暴露）
 * - inbound-clock.json（proxy 每收到一条 QQ 入站就写）
 * - gpu-lease.json（出图租约）
 * - conversation-feed.jsonl / group-state/*.json（压缩链路产物）
 */
import { execFile } from 'node:child_process';
import http from 'node:http';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readLease } from '../gpu-lease.mjs';
import { FEED_PATH, GROUP_STATE_DIR, ROOT } from './store.mjs';

const execFileAsync = promisify(execFile);
const PROXY_BASE = process.env.QQ_PROXY_URL ?? 'http://127.0.0.1:' + (process.env.QQ_PROXY_PORT ?? 1240);
const INBOUND_CLOCK_PATH = process.env.QQ_INBOUND_CLOCK ?? join(ROOT, 'inbound-clock.json');

function httpJson(url, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: timeoutMs }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                }
                catch (error) {
                    reject(error);
                }
            });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

/** 代理的上游并发队列；拿不到就返回 undefined（判定为“不空闲”更保守）。 */
export async function proxyQueue() {
    try {
        const doc = await httpJson(PROXY_BASE + '/internal/queue');
        return {
            active: Number(doc?.active ?? 0),
            waiting: Number(doc?.waiting ?? 0),
            limit: Number(doc?.limit ?? 0),
        };
    }
    catch {
        return undefined;
    }
}

export async function engineHealthy() {
    try {
        const doc = await httpJson(PROXY_BASE + '/health', 2000);
        return doc?.ok === true;
    }
    catch {
        return false;
    }
}

export async function leaseActive() {
    return (await readLease()) !== undefined;
}

/** 所有场景里最近一条入站的时间（毫秒），没有则 0。 */
export async function lastInboundAt() {
    try {
        const doc = JSON.parse(await readFile(INBOUND_CLOCK_PATH, 'utf8'));
        let latest = 0;
        for (const value of Object.values(doc ?? {})) {
            const stamp = Number(value);
            if (Number.isFinite(stamp) && stamp > latest)
                latest = stamp;
        }
        return latest;
    }
    catch {
        return 0;
    }
}

/** 读文件尾部若干行；只读最后 maxBytes，避免 feed 长大后整文件读入。 */
async function tailLines(path, maxBytes = 3 * 1024 * 1024) {
    let handle;
    try {
        const info = await stat(path);
        const length = Math.min(info.size, maxBytes);
        const buffer = Buffer.alloc(length);
        handle = await open(path, 'r');
        await handle.read(buffer, 0, length, info.size - length);
        const text = buffer.toString('utf8');
        // 文件被截断在行中间时丢掉第一行残片。
        const lines = text.split('\n');
        if (info.size > length)
            lines.shift();
        return lines.filter(line => line.trim() !== '');
    }
    catch {
        return [];
    }
    finally {
        await handle?.close().catch(() => {});
    }
}

/** 自 sinceTs 之后的群聊用户消息。 */
export async function feedEventsSince(sinceTs, options = {}) {
    const limit = Number(options.limit) || 400;
    const onlyGroups = options.onlyGroups !== false;
    const lines = await tailLines(FEED_PATH);
    const events = [];
    for (const line of lines) {
        let row;
        try {
            row = JSON.parse(line);
        }
        catch {
            continue;
        }
        const ts = Number(row?.ts ?? 0);
        if (!Number.isFinite(ts) || ts <= sinceTs)
            continue;
        if (String(row?.role ?? 'user') !== 'user')
            continue;
        const text = String(row?.text ?? '').replace(/\s+/gu, ' ').trim();
        if (text === '')
            continue;
        const chat = String(row?.chat ?? '');
        if (onlyGroups && !chat.startsWith('group:'))
            continue;
        events.push({
            ts,
            chat,
            sceneKey: chat,
            groupId: String(row?.groupId ?? chat.split(':')[1] ?? ''),
            qq: String(row?.qq ?? ''),
            nickname: String(row?.nickname ?? ''),
            messageId: String(row?.messageId ?? ''),
            text: text.slice(0, 160),
        });
        if (events.length >= limit)
            break;
    }
    return events;
}

/** 各群压缩器产出的主题/未决问题，作为反思的骨架。 */
export async function groupStates() {
    let names;
    try {
        names = await readdir(GROUP_STATE_DIR);
    }
    catch {
        return [];
    }
    const rows = [];
    for (const name of names.filter(item => item.endsWith('.json'))) {
        let doc;
        try {
            doc = JSON.parse(await readFile(join(GROUP_STATE_DIR, name), 'utf8'));
        }
        catch {
            continue;
        }
        rows.push({
            sceneKey: String(doc?.chat ?? 'group:' + name.replace(/\.json$/u, '')),
            updatedAt: String(doc?.updatedAt ?? ''),
            messageCount: Number(doc?.messageCount ?? 0),
            topics: Array.isArray(doc?.topics) ? doc.topics.slice(0, 8).map(String) : [],
            openQuestions: Array.isArray(doc?.openQuestions) ? doc.openQuestions.slice(0, 6).map(String) : [],
        });
    }
    return rows;
}

/** 采样一次 GPU；nvidia-smi 不存在就返回 null（不影响主流程）。 */
export async function sampleGpu() {
    try {
        const { stdout } = await execFileAsync('nvidia-smi', [
            '--query-gpu=utilization.gpu,memory.used,memory.total',
            '--format=csv,noheader,nounits',
        ], { windowsHide: true, timeout: 5000 });
        const line = String(stdout ?? '').trim().split('\n')[0] ?? '';
        const [util, used, total] = line.split(',').map(part => Number(part.trim()));
        if (!Number.isFinite(used))
            return null;
        return {
            at: new Date().toISOString(),
            utilPct: Number.isFinite(util) ? util : null,
            usedMB: Math.round(used),
            totalMB: Number.isFinite(total) ? Math.round(total) : null,
        };
    }
    catch {
        return null;
    }
}

/** 运行中每 2 秒调用：返回让路原因，null 表示可以继续。 */
export async function yieldReason(startedAt) {
    const queue = await proxyQueue();
    if (queue === undefined)
        return 'proxy-unreachable';
    // 自己的请求本身占 1 个槽；>1 或有人排队说明真人对话在用引擎。
    if (queue.active > 1 || queue.waiting > 0)
        return 'queue-busy';
    if (await leaseActive())
        return 'gpu-lease';
    if ((await lastInboundAt()) > startedAt)
        return 'new-inbound';
    return null;
}
