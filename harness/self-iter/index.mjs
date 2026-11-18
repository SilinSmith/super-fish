/**
 * 闲时自迭代：独立的定时反思。
 *
 * 与旧实现（在正常 QQ 回合里碰运气）的区别：
 * - 自己 60 秒 tick，不依赖任何用户消息；
 * - 真的调模型，产出结构化 findings，带证据；
 * - 笔记按 auto-notes 自动入库，人格改动一律进待审提案；
 * - 每轮 metrics.jsonl 记录 token / GPU / 让路原因，证明“它真的在算”；
 * - 群消息一来就让路（中断本轮），不在前台占用引擎。
 */
import { readFile } from 'node:fs/promises';
import {
    CHARACTER_PATH,
    NOTEBOOK_PATH,
    acquireLock,
    audit,
    fileHash,
    getProposal,
    listProposals,
    metric,
    proposalId,
    readConfig,
    readJson,
    readState,
    recentMetrics,
    releaseLock,
    saveProposal,
    writeConfig,
    writeState,
} from './store.mjs';
import {
    engineHealthy,
    feedEventsSince,
    groupStates,
    lastInboundAt,
    leaseActive,
    proxyQueue,
    sampleGpu,
    yieldReason,
} from './probe.mjs';
import { collectDossier, parseReflection, reflect } from './reflect.mjs';
import {
    applyNotebookProposal,
    applyProposal,
    buildProposals,
    rejectProposal,
    rollbackProposal,
    validateFindings,
} from './gate.mjs';

let inFlight = false;

function iso(now = Date.now()) {
    return new Date(now).toISOString();
}

function notebookTexts() {
    return readJson(NOTEBOOK_PATH, { entries: [] }).then(doc => (Array.isArray(doc?.entries) ? doc.entries : [])
        .filter(entry => entry?.status === 'active')
        .slice(-80)
        .map(entry => ({
            category: String(entry.category ?? 'note'),
            subject: String(entry.subject ?? ''),
            text: String(entry.text ?? ''),
        })));
}

async function skip(reason, detail = {}) {
    return { ok: false, skipped: true, reason, ...detail };
}

/**
 * 跑一轮。force 只跳过节奏/材料/空闲阈值，不跳过队列、租约和“中途让路”。
 */
export async function runOnce(options = {}) {
    const force = options.force === true;
    const trigger = String(options.trigger ?? (force ? 'manual' : 'timer'));
    const config = await readConfig();
    if (!config.enabled)
        return skip('disabled');

    if (inFlight)
        return skip('in-process-busy');
    inFlight = true;
    const lock = await acquireLock(config.model.timeoutMs + 120_000);
    if (!lock.ok)
        return skip('lock-busy', { holder: lock.lock });

    const startedAt = Date.now();
    const runId = proposalId(startedAt);
    const state = await readState();
    let sampled = [];
    let sampler = null;

    try {
        if (!force) {
            if (state.runsToday.count >= config.maxPerDay)
                return skip('daily-cap', { runsToday: state.runsToday.count });
            const lastRun = Date.parse(state.lastRunAt || '') || 0;
            if (lastRun > 0 && startedAt - lastRun < config.minGapMs)
                return skip('min-gap', { nextAllowedAt: iso(lastRun + config.minGapMs) });
        }

        const queue = await proxyQueue();
        if (queue === undefined)
            return skip('proxy-unreachable');
        if (queue.active > 0 || queue.waiting > 0)
            return skip('queue-busy', { queue });
        if (await leaseActive())
            return skip('gpu-lease');
        if (!(await engineHealthy()))
            return skip('engine-unhealthy');

        const lastInbound = await lastInboundAt();
        if (!force && lastInbound > 0 && startedAt - lastInbound < config.idleMs)
            return skip('not-idle', { lastInboundAt: iso(lastInbound) });

        const sinceTs = Date.parse(state.lastRunAt || '') || 0;
        // 手动强制时回看最近 24 小时，避免“刚跑完没新材料”导致完全没法验证。
        const lookbackTs = force && sinceTs > 0
            ? Math.min(sinceTs, startedAt - 24 * 3600_000)
            : sinceTs;
        const events = await feedEventsSince(lookbackTs, {
            onlyGroups: config.onlyGroups,
            limit: 400,
        });
        const material = events.filter(event => event.text.replace(/\[图片\]/gu, '').trim().length >= 4);
        const age = sinceTs > 0 ? startedAt - sinceTs : Number.POSITIVE_INFINITY;
        if (!force && material.length < config.materialMinEvents && age < config.materialMaxAgeMs) {
            return skip('no-material', {
                events: material.length,
                need: config.materialMinEvents,
                ageMs: Number.isFinite(age) ? age : null,
            });
        }
        if (material.length === 0)
            return skip('empty-material');

        // 真实运行从这里开始：计数、采样、调模型。
        state.runsToday.count += 1;
        state.lastRunAt = iso(startedAt);
        await writeState(state);

        const gpuBefore = await sampleGpu();
        sampled = gpuBefore ? [gpuBefore] : [];
        sampler = setInterval(async () => {
            const sample = await sampleGpu();
            if (sample)
                sampled.push(sample);
        }, 1500);
        sampler.unref?.();

        const dossier = await collectDossier({
            events: material,
            groupStates: await groupStates(),
            maxPromptChars: config.model.maxPromptChars,
        });
        const characterBefore = await fileHash(CHARACTER_PATH);

        const result = await reflect({
            prompt: dossier.text,
            modelConfig: config.model,
            sessionId: 'self-iter-' + runId,
            yieldProbe: () => yieldReason(startedAt),
        });

        clearInterval(sampler);
        sampler = null;
        const gpuAfter = await sampleGpu();
        if (gpuAfter)
            sampled.push(gpuAfter);

        const usageMissing = result.ok && (!Number.isFinite(result.completionTokens) || result.completionTokens === null);
        const tokensPerSec = Number.isFinite(result.completionTokens) && result.completionTokens > 0 && result.durationMs > 0
            ? Math.round((result.completionTokens / (result.durationMs / 1000)) * 10) / 10
            : null;
        const yielded = {
            aborted: result.aborted === true,
            reason: result.abortReason || '',
        };

        let parsed = { ok: false, reason: result.error || 'not-run', findings: [] };
        let validated = { accepted: [], rejected: [] };
        const proposals = [];
        let appliedNotebook = 0;
        if (result.ok) {
            parsed = parseReflection(result.content);
            if (parsed.ok) {
                validated = validateFindings({
                    findings: parsed.findings,
                    events: material,
                    notebookEntries: await notebookTexts(),
                    character: await readFileSafe(CHARACTER_PATH),
                    config,
                });
                const built = await buildProposals(validated.accepted, {});
                for (const proposal of built) {
                    await saveProposal(proposal);
                    proposals.push(proposal);
                }
                if (config.mode === 'auto-notes') {
                    const dailyLeft = Math.max(0, config.gates.maxNotebookPerDay - state.notebookToday.count);
                    const budget = Math.min(config.gates.maxNotebookPerRun, dailyLeft);
                    for (const proposal of proposals) {
                        if (appliedNotebook >= budget)
                            break;
                        if (proposal.kind !== 'notebook' || proposal.status !== 'pending')
                            continue;
                        const applied = await applyNotebookProposal(proposal, 'self-iter');
                        if (applied.ok) {
                            appliedNotebook += 1;
                            state.notebookToday.count += 1;
                        }
                    }
                }
            }
        }

        const characterAfter = await fileHash(CHARACTER_PATH);
        const status = result.aborted ? 'aborted'
            : (!result.ok ? 'error'
                : (!parsed.ok ? 'parse-error'
                    : (parsed.findings.length === 0 ? 'empty' : 'ok')));
        const gpuUsed = sampled.map(sample => sample.usedMB).filter(Number.isFinite);
        const util = sampled.map(sample => sample.utilPct).filter(Number.isFinite);
        const summary = {
            runId,
            trigger,
            status,
            mode: config.mode,
            startedAt: iso(startedAt),
            durationMs: result.durationMs,
            feed: { fromTs: lookbackTs, events: material.length, used: dossier.eventsUsed ?? null },
            model: {
                model: result.model ?? null,
                promptTokens: result.promptTokens,
                completionTokens: result.completionTokens,
                totalTokens: result.totalTokens,
                tokensPerSec,
                usageMissing,
            },
            gpu: {
                beforeMB: gpuBefore?.usedMB ?? null,
                peakMB: gpuUsed.length > 0 ? Math.max(...gpuUsed) : null,
                afterMB: gpuAfter?.usedMB ?? null,
                utilSamples: sampled.map(sample => ({ at: sample.at, utilPct: sample.utilPct, usedMB: sample.usedMB })),
            },
            yielded,
            output: {
                findings: parsed.findings?.length ?? 0,
                accepted: validated.accepted.length,
                notebook: proposals.filter(item => item.kind === 'notebook').length,
                character: proposals.filter(item => item.kind === 'character' && item.status === 'pending').length,
                empty: parsed.findings.length === 0,
            },
            gate: {
                autoApplied: appliedNotebook,
                pending: proposals.filter(item => item.status === 'pending').length,
                rejected: validated.rejected.length,
                reasons: validated.rejected.map(item => item.reason),
            },
            characterChanged: characterBefore !== characterAfter,
            characterChangedTotal: state.characterChangedTotal,
            error: result.ok ? (parsed.ok ? '' : parsed.reason) : result.error,
        };
        await metric(summary);

        state.lastRun = {
            runId,
            ts: iso(startedAt),
            status,
            durationMs: result.durationMs,
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
            gpuPeakMB: summary.gpu.peakMB,
            accepted: validated.accepted.length,
            appliedNotebook,
            pending: summary.gate.pending,
            aborted: yielded.aborted,
            reason: yielded.reason,
        };
        state.lastError = status === 'error' ? String(result.error ?? '') : null;
        await writeState(state);

        return { ok: true, runId, status, summary, proposals: proposals.map(item => ({
            id: item.id,
            kind: item.kind,
            status: item.status,
            title: item.title,
        })) };
    }
    catch (error) {
        await metric({
            runId,
            trigger,
            status: 'error',
            startedAt: iso(startedAt),
            error: String(error?.message ?? error),
        });
        const latest = await readState();
        latest.lastRun = { runId, ts: iso(startedAt), status: 'error', error: String(error?.message ?? error) };
        latest.lastError = String(error?.message ?? error);
        await writeState(latest);
        await audit({ proposalId: runId, action: 'run-error', actor: 'self-iter', error: String(error?.message ?? error) });
        return { ok: false, reason: 'error', error: String(error?.message ?? error) };
    }
    finally {
        if (sampler !== null)
            clearInterval(sampler);
        inFlight = false;
        await releaseLock();
    }
}

async function readFileSafe(path) {
    try {
        return await readFile(path, 'utf8');
    }
    catch {
        return '';
    }
}

export async function status() {
    const [config, state, metrics, proposals] = await Promise.all([
        readConfig(),
        readState(),
        recentMetrics(10),
        listProposals(200),
    ]);
    const pending = proposals.filter(item => item.status === 'pending');
    const applied = proposals.filter(item => item.status === 'applied');
    return {
        config,
        state,
        recentRuns: metrics,
        lastRun: metrics[metrics.length - 1] ?? null,
        pending,
        recentProposals: proposals.slice(0, 20),
        counts: {
            pending: pending.length,
            applied: applied.length,
            rejected: proposals.filter(item => item.status === 'rejected' || item.status === 'stale').length,
            rolledback: proposals.filter(item => item.status === 'rolledback').length,
            characterChangedTotal: state.characterChangedTotal,
            runsToday: state.runsToday.count,
            notebookToday: state.notebookToday.count,
            characterToday: state.characterToday.count,
        },
    };
}

export async function approveProposal(id, actor = 'master') {
    const proposal = await getProposal(id);
    if (proposal === null)
        return { ok: false, reason: 'not-found' };
    if (proposal.kind === 'character') {
        const state = await readState();
        const config = await readConfig();
        if (state.characterToday.count >= config.gates.maxCharacterPerDay)
            return { ok: false, reason: 'daily-character-cap' };
        const result = await applyProposal(proposal, actor);
        if (result.ok) {
            state.characterToday.count += 1;
            state.characterChangedTotal += 1;
            await writeState(state);
        }
        return result;
    }
    return applyProposal(proposal, actor);
}

export async function rejectProposalById(id, actor = 'master', reason = 'manual') {
    const proposal = await getProposal(id);
    if (proposal === null)
        return { ok: false, reason: 'not-found' };
    return rejectProposal(proposal, actor, reason);
}

export async function rollbackProposalById(id, actor = 'master') {
    const proposal = await getProposal(id);
    if (proposal === null)
        return { ok: false, reason: 'not-found' };
    const result = await rollbackProposal(proposal, actor);
    if (result.ok && proposal.kind === 'character') {
        const state = await readState();
        state.characterChangedTotal = Math.max(0, state.characterChangedTotal - 1);
        await writeState(state);
    }
    if (result.ok && proposal.kind === 'notebook') {
        const state = await readState();
        state.notebookToday.count = Math.max(0, state.notebookToday.count - 1);
        await writeState(state);
    }
    return result;
}

export async function updateConfig(patch) {
    const current = await readConfig();
    const merged = {
        ...current,
        ...(patch && typeof patch === 'object' ? patch : {}),
        model: { ...current.model, ...(patch?.model ?? {}) },
        gates: { ...current.gates, ...(patch?.gates ?? {}) },
    };
    return writeConfig(merged);
}

/** 后台 tick：console 启动时挂一次，60 秒看一次是否该跑。 */
export function createWatcher(options = {}) {
    const log = options.log ?? (() => {});
    const intervalMs = Number(options.intervalMs) || 60_000;
    let timer = null;
    let ticking = false;
    let lastSkip = '';

    async function tick() {
        if (ticking)
            return;
        ticking = true;
        try {
            const result = await runOnce({});
            if (result.ok) {
                lastSkip = '';
                log('self-iter run ' + result.runId + ' status=' + result.status);
            }
            else if (result.skipped !== true) {
                lastSkip = '';
                log('self-iter skipped: ' + result.reason);
            }
            else if (result.reason !== lastSkip) {
                lastSkip = result.reason;
                log('self-iter waiting: ' + result.reason);
            }
        }
        catch (error) {
            log('self-iter tick error: ' + String(error?.message ?? error));
        }
        finally {
            ticking = false;
        }
    }

    return {
        start() {
            if (timer !== null)
                return;
            void tick();
            timer = setInterval(() => { void tick(); }, intervalMs);
            timer.unref?.();
        },
        stop() {
            if (timer !== null)
                clearInterval(timer);
            timer = null;
        },
        tick,
    };
}
