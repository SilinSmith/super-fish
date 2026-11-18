/**
 * 上游降级的判定与自愈。
 *
 * 输入是 qq-persona 的 upstream-faults.jsonl 事件流：
 *   - 故障事件：5xx / upstream_error / silent_drop
 *   - 恢复事件：retry_ok / prefix_shift_ok
 *
 * 解除条件（满足任意一条即视为恢复）：
 *   1. 故障之后出现恢复事件（retry_ok / prefix_shift_ok），立即解除；
 *   2. 最近一次故障滑出 15 分钟窗口，且期间没有新故障。
 *
 * 降级只在「最近一次故障晚于最近一次恢复，且故障仍在窗口内」时成立，
 * 避免一次瞬时 5xx 把面板钉住 15 分钟。
 */
export const FAULT_WINDOW_MS = 15 * 60 * 1000;

const FAULT_EVENTS = new Set(['5xx', 'upstream_error', 'silent_drop']);
const SUCCESS_EVENTS = new Set(['retry_ok', 'prefix_shift_ok']);

function atOf(row) {
    const raw = row?.ts;
    if (typeof raw === 'number' && Number.isFinite(raw))
        return raw;
    const parsed = Date.parse(String(raw ?? ''));
    return Number.isFinite(parsed) ? parsed : 0;
}

function iso(ms) {
    return ms ? new Date(ms).toISOString() : null;
}

export function summarizeUpstream(rows, now = Date.now(), windowMs = FAULT_WINDOW_MS) {
    const events = [];
    for (const row of rows ?? []) {
        const at = atOf(row);
        if (!at || at > now)
            continue;
        const type = String(row?.event ?? '');
        const fault = FAULT_EVENTS.has(type);
        if (!fault && !SUCCESS_EVENTS.has(type))
            continue;
        events.push({ at, type, fault, status: row?.status ?? null });
    }
    events.sort((a, b) => a.at - b.at);

    let lastFault = null;
    let lastSuccess = null;
    for (const event of events) {
        if (event.fault)
            lastFault = event;
        else
            lastSuccess = event;
    }

    const windowStart = now - windowMs;
    const recentFaults = events.filter(event => event.fault && event.at >= windowStart);
    const counts = {};
    for (const event of recentFaults)
        counts[event.type] = (counts[event.type] ?? 0) + 1;

    const active = Boolean(lastFault)
        && now - lastFault.at < windowMs
        && (!lastSuccess || lastFault.at > lastSuccess.at);

    if (active) {
        // 本次降级起点：从最近一次故障往回找，连续（间隔不超过窗口）的故障算同一轮；
        // 中间断档超过窗口就停下，避免把 20 分钟前的孤立故障算进当前降级时长。
        const faultsAfterSuccess = events.filter(event => event.fault && event.at > (lastSuccess?.at ?? 0));
        let sinceAt = lastFault.at;
        for (let index = faultsAfterSuccess.length - 1; index > 0; index -= 1) {
            if (faultsAfterSuccess[index].at - faultsAfterSuccess[index - 1].at <= windowMs)
                sinceAt = faultsAfterSuccess[index - 1].at;
            else
                break;
        }
        const clearAt = lastFault.at + windowMs;
        const clearWhen = '最近一次故障 ' + iso(lastFault.at)
            + '；窗口内无新故障则 ' + iso(clearAt) + ' 自动解除，或下一次 retry_ok / prefix_shift_ok 立即解除';
        const detail = Object.entries(counts).map(([type, count]) => type + ' ' + count).join('、');
        return {
            active: true,
            sinceAt,
            since: iso(sinceAt),
            forMs: Math.max(0, now - sinceAt),
            clearAt,
            clearWhen,
            clearedAt: null,
            faultCount15: recentFaults.length,
            counts,
            lastFaultAt: lastFault.at,
            lastFaultType: lastFault.type,
            lastSuccessAt: lastSuccess?.at ?? 0,
            reason: '近 15 分钟 ' + recentFaults.length + ' 次上游异常（' + detail + '）',
            windowMs,
        };
    }

    let clearedAt = 0;
    let reason = '';
    if (lastSuccess && (!lastFault || lastSuccess.at > lastFault.at)) {
        clearedAt = lastSuccess.at;
        reason = '上游已恢复：' + iso(lastSuccess.at) + ' 收到 ' + lastSuccess.type
            + (recentFaults.length > 0 ? '，窗口内 ' + recentFaults.length + ' 次异常不再计入降级' : '');
    }
    else if (lastFault) {
        clearedAt = lastFault.at + windowMs;
        reason = '窗口内无新故障：最近一次异常 ' + iso(lastFault.at) + ' 已滑出 '
            + Math.round(windowMs / 60000) + ' 分钟窗口';
    }
    return {
        active: false,
        sinceAt: null,
        since: null,
        forMs: 0,
        clearAt: null,
        clearWhen: '',
        clearedAt: clearedAt <= now ? clearedAt : 0,
        faultCount15: recentFaults.length,
        counts,
        lastFaultAt: lastFault?.at ?? 0,
        lastFaultType: lastFault?.type ?? null,
        lastSuccessAt: lastSuccess?.at ?? 0,
        reason,
        windowMs,
    };
}
