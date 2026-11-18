/**
 * 显卡租约（GPU lease）。
 *
 * MOSS 出图需要独占显存：先释放聊天模型，再让 ComfyUI 加载 MOSS，最后把
 * 聊天模型装回来。这段窗口里如果 QQ 群又来消息，persona proxy 会把请求
 * 直接打到模型后端——模型已经不在显存里，请求会失败或者触发一次漫长的
 * 冷加载。
 *
 * 所以用一个小 JSON 文件当租约：出图工具持有租约，proxy 在转发前等待租约
 * 释放。文件带 pid 和过期时间，进程被强杀也不会把租约永久卡死。
 */
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

export const LEASE_PATH = process.env.QQ_LEASE_PATH ?? 'Y:\\dsh\\home\\qq-persona\\gpu-lease.json';

function pidAlive(pid) {
    if (!Number.isFinite(pid) || pid <= 0)
        return true;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** 当前有效租约；过期或持有进程已退出的租约视为不存在。 */
export async function readLease() {
    try {
        const raw = await readFile(LEASE_PATH, 'utf8');
        const lease = JSON.parse(raw);
        if (!lease || typeof lease !== 'object')
            return undefined;
        if (Number(lease.expiresAt) < Date.now())
            return undefined;
        if (!pidAlive(Number(lease.pid)))
            return undefined;
        return lease;
    }
    catch {
        return undefined;
    }
}

/** 尝试独占显卡；被占用时返回现有租约而不是抛错。 */
export async function acquireLease(options = {}) {
    const owner = String(options.owner ?? 'unknown');
    const reason = String(options.reason ?? '');
    const ttlMs = Math.max(30_000, Number(options.ttlMs) || 600_000);
    const existing = await readLease();
    if (existing !== undefined)
        return { ok: false, lease: existing };
    await mkdir(dirname(LEASE_PATH), { recursive: true });
    const lease = {
        id: randomUUID(),
        owner,
        pid: process.pid,
        reason,
        startedAt: new Date().toISOString(),
        expiresAt: Date.now() + ttlMs,
    };
    try {
        await writeFile(LEASE_PATH, JSON.stringify(lease) + '\n', { encoding: 'utf8', flag: 'wx' });
        return { ok: true, lease };
    }
    catch {
        // 文件还在但租约已失效：删掉重试一次。
        const again = await readLease();
        if (again !== undefined)
            return { ok: false, lease: again };
        await unlink(LEASE_PATH).catch(() => {});
        try {
            await writeFile(LEASE_PATH, JSON.stringify(lease) + '\n', { encoding: 'utf8', flag: 'wx' });
            return { ok: true, lease };
        }
        catch {
            return { ok: false, lease: await readLease() };
        }
    }
}

export async function releaseLease(id) {
    const current = await readLease();
    if (current !== undefined && current.id !== id)
        return false;
    await unlink(LEASE_PATH).catch(() => {});
    return true;
}

/** 等租约释放；超时返回 false（调用方可以照常转发，至少不会永远卡住）。 */
export async function waitForLeaseRelease(timeoutMs = 180_000) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() < deadline) {
        const lease = await readLease();
        if (lease === undefined)
            return true;
        await sleep(500);
    }
    return false;
}
