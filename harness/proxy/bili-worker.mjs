/**
 * 后台 B 站任务的公共「让路 / 低优先级」逻辑：回填、补课共用。
 * 原则：QQ 有请求时让路；进程本身降到 BelowNormal，不跟宿主抢 CPU。
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { readLease } from './gpu-lease.mjs';

const HOME = 'Y:\\dsh\\home\\qq-persona';
const PROXY_QUEUE_URL = process.env.QQ_PROXY_QUEUE_URL ?? 'http://127.0.0.1:1240/internal/queue';
const DEFER_PATH = process.env.QQ_DEFER_PATH ?? join(HOME, 'defer-queue.json');

/** Windows 下把当前进程降到 BelowNormal；失败只提示，不拦任务。 */
export function setLowPriority() {
    try {
        os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
        return true;
    }
    catch {
        return false;
    }
}

export function readJson(path, fallback = null) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return fallback;
    }
}

/** 条目处理中途只看外部信号（defer / GPU 租约），避免把自己触发视觉/总结的模型活动当成对话。 */
export function externalBusy() {
    const defer = readJson(DEFER_PATH, null);
    const pending = Object.values(defer?.groups ?? {})
        .reduce((total, group) => total + (Array.isArray(group?.items) ? group.items.length : 0), 0);
    if (pending > 0)
        return 'defer 队列还有 ' + pending + ' 条';
    return '';
}

export async function externalBusyWithLease() {
    const reason = externalBusy();
    if (reason !== '')
        return reason;
    const lease = await readLease();
    if (lease !== undefined)
        return 'GPU 租约在 ' + String(lease.owner ?? '别人') + ' 手上';
    return '';
}

/** 开跑前判定：模型回合空闲、defer 空、无 GPU 租约。 */
export async function yieldReason() {
    try {
        const response = await fetch(PROXY_QUEUE_URL, { signal: AbortSignal.timeout(2500) });
        const data = await response.json();
        if (Number(data?.active ?? 0) > 0)
            return '有进行中的模型回合（' + data.active + '）';
        if (Number(data?.waiting ?? 0) > 0)
            return '模型请求排队（' + data.waiting + '）';
    }
    catch {
        return '模型网关不可达，无法确认空闲';
    }
    return externalBusyWithLease();
}

export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
