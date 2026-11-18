/**
 * 写回闸：校验模型产出 → 生成提案 → 应用 / 拒绝 / 回滚。
 *
 * 人格只允许两个落点：
 * 1) 追加 `## 自迭代补记（YYYY-MM-DD）` 新章节；
 * 2) 往「说话示例」的“真实翻车过的说法，别再出现”代码块里加反例。
 * 任何情况下都不改身份、隐私、权限、硬规则、说话方式这些正文。
 */
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import { bigramSimilarity, migrateNotebook, upsertEntry } from '../memory.mjs';
import {
    CHARACTER_PATH,
    NOTEBOOK_PATH,
    audit,
    backupFile,
    fileHash,
    proposalId,
    readJson,
    saveProposal,
    writeJsonAtomic,
} from './store.mjs';

const CATEGORIES = new Set(['core', 'user', 'relation', 'meme', 'behavior', 'knowledge', 'note']);
const PRIVACY_RE = /(住址|家庭住址|门牌|身份证|手机号|电话号码|银行卡|密码|账号|作息|几点睡|真实姓名|私聊|医院|病历)/u;
const LEAK_RE = /(系统提示|提示词|system\s*prompt|忽略之前|你的设定|规则里|prompt)/iu;
const HARD_HEADING_RE = /^#{1,6}\s*(你认谁|隐私|权限|哪些事不做|不暴露自己在查资料|怎么说话)/u;
// 群聊概括/关系评价没有检索价值，属于“走一遍填空”的产物。
const EDITORIAL_RE = /(体现|说明|反映出?|展现|彰显|共同兴趣|互动关系|值得关注|需跟踪|存在多项未决|氛围|气氛|持续讨论)/u;
// 纯媒体事件说不清内容，不记。
const MEDIA_ONLY_RE = /(发送(了)?多张图片|发了几张图|图片分享|表情包和短视频|让我查看)/u;

function oneLine(value, maxChars) {
    return String(value ?? '')
        .replace(/\s+/gu, ' ')
        .replace(/^#+\s*/u, '')
        .replace(/```/gu, '')
        .trim()
        .slice(0, maxChars);
}

function evidenceIndex(events) {
    const byId = new Map();
    for (const event of events) {
        if (event.messageId !== '')
            byId.set(event.messageId, event);
    }
    return byId;
}

/**
 * 校验 findings。返回 accepted（可直接建提案）和 rejected（带原因，用于 metrics）。
 */
export function validateFindings(input) {
    const config = input.config;
    const events = Array.isArray(input.events) ? input.events : [];
    const snippets = Array.isArray(input.notebookEntries) ? input.notebookEntries : [];
    const character = String(input.character ?? '');
    const scenes = new Set(events.map(event => event.sceneKey));
    const byId = evidenceIndex(events);
    const accepted = [];
    const rejected = [];
    const seenText = [];

    const findings = (Array.isArray(input.findings) ? input.findings : []).slice(0, config.gates.maxFindings);
    for (const finding of findings) {
        const action = String(finding?.action ?? 'none');
        if (!['remember', 'note', 'persona_patch'].includes(action)) {
            rejected.push({ action: 'none', reason: 'action-none', event: oneLine(finding?.event, 60) });
            continue;
        }
        const confidence = Number(finding?.confidence);
        if (!Number.isFinite(confidence) || confidence < config.gates.minConfidence) {
            rejected.push({ action, reason: 'low-confidence', event: oneLine(finding?.event, 60) });
            continue;
        }
        const sceneKey = String(finding?.sceneKey ?? '');
        if (!scenes.has(sceneKey)) {
            rejected.push({ action, reason: 'scene-not-in-material', event: oneLine(finding?.event, 60), sceneKey });
            continue;
        }
        const evidence = (Array.isArray(finding?.evidence) ? finding.evidence : [])
            .map(item => {
                const messageId = String(item?.messageId ?? '');
                const ts = Number(item?.ts ?? 0);
                const hit = byId.get(messageId);
                if (hit === undefined && !Number.isFinite(ts))
                    return null;
                return hit !== undefined
                    ? { messageId: hit.messageId, ts: hit.ts, chat: hit.sceneKey }
                    : { messageId, ts, chat: sceneKey };
            })
            .filter(Boolean);
        if (evidence.length === 0) {
            rejected.push({ action, reason: 'no-evidence', event: oneLine(finding?.event, 60), sceneKey });
            continue;
        }

        if (action === 'persona_patch') {
            const target = String(finding?.persona?.target ?? '');
            const text = oneLine(finding?.persona?.text, config.gates.maxCharacterChars);
            if (target !== 'append_section' && target !== 'negative_example') {
                rejected.push({ action, reason: 'persona-target', event: oneLine(finding?.event, 60) });
                continue;
            }
            if (text.length < 6) {
                rejected.push({ action, reason: 'persona-too-short', event: oneLine(finding?.event, 60) });
                continue;
            }
            if (PRIVACY_RE.test(text) || LEAK_RE.test(text) || HARD_HEADING_RE.test(text)) {
                rejected.push({ action, reason: 'persona-blocked-content', event: oneLine(finding?.event, 60) });
                continue;
            }
            if (EDITORIAL_RE.test(text)) {
                rejected.push({ action, reason: 'editorializing', event: oneLine(finding?.event, 60) });
                continue;
            }
            const fix = target === 'negative_example' ? oneLine(finding?.persona?.fix, config.gates.maxExampleChars) : '';
            if (target === 'negative_example' && fix.length < 4) {
                rejected.push({ action, reason: 'persona-missing-fix', event: oneLine(finding?.event, 60) });
                continue;
            }
            if (character.includes(text) || seenText.some(other => bigramSimilarity(other, text) >= 0.8)) {
                rejected.push({ action, reason: 'persona-duplicate', event: oneLine(finding?.event, 60) });
                continue;
            }
            seenText.push(text);
            accepted.push({
                action,
                event: oneLine(finding?.event, 60),
                why: oneLine(finding?.why, 60),
                sceneKey,
                confidence,
                evidence,
                persona: { target, text, fix },
            });
            continue;
        }

        const category = String(finding?.memory?.category ?? 'note');
        const subject = oneLine(finding?.memory?.subject, 24);
        const text = oneLine(finding?.memory?.text, 120);
        if (!CATEGORIES.has(category) || subject.length < 2 || text.length < 6) {
            rejected.push({ action, reason: 'memory-schema', event: oneLine(finding?.event, 60) });
            continue;
        }
        if (PRIVACY_RE.test(text) || LEAK_RE.test(text)) {
            rejected.push({ action, reason: 'memory-blocked-content', event: oneLine(finding?.event, 60) });
            continue;
        }
        if (EDITORIAL_RE.test(text) || MEDIA_ONLY_RE.test(text)) {
            rejected.push({ action, reason: 'editorializing', event: oneLine(finding?.event, 60) });
            continue;
        }
        // 必须能在证据原话里找到落点，防止模型总结出一个凭空的事实。
        const grounded = evidence.some(item => {
            const source = byId.get(item.messageId);
            return source !== undefined && bigramSimilarity(source.text, text) >= 0.15;
        });
        if (!grounded) {
            rejected.push({ action, reason: 'ungrounded', event: oneLine(finding?.event, 60) });
            continue;
        }
        const duplicate = snippets.find(entry => bigramSimilarity(entry.text, text) >= 0.6);
        if (duplicate !== undefined || seenText.some(other => bigramSimilarity(other, text) >= 0.6)) {
            rejected.push({ action, reason: 'duplicate', event: oneLine(finding?.event, 60), subject });
            continue;
        }
        seenText.push(text);
        accepted.push({
            action,
            event: oneLine(finding?.event, 60),
            why: oneLine(finding?.why, 60),
            sceneKey,
            confidence,
            evidence,
            memory: { category, subject, text },
        });
    }
    return { accepted, rejected };
}

function characterAppend(text, dateLabel) {
    const heading = '## 自迭代补记（' + dateLabel + '）';
    return { heading, block: '\n\n' + heading + '\n- ' + text + '\n' };
}

function insertSection(markdown, text, dateLabel) {
    const { heading, block } = characterAppend(text, dateLabel);
    const index = markdown.indexOf(heading);
    if (index < 0)
        return markdown.replace(/\s*$/u, '') + block;
    const nextHeading = markdown.indexOf('\n## ', index + heading.length);
    const insertAt = nextHeading < 0 ? markdown.length : nextHeading;
    const head = markdown.slice(0, insertAt).replace(/\s*$/u, '');
    const tail = markdown.slice(insertAt);
    return head + '\n- ' + text + '\n' + tail;
}

function insertNegativeExample(markdown, text, fix) {
    const anchor = '下面这些是真实翻车过的说法，别再出现：';
    const anchorIndex = markdown.indexOf(anchor);
    if (anchorIndex < 0)
        return null;
    const fenceStart = markdown.indexOf('```text', anchorIndex);
    if (fenceStart < 0)
        return null;
    const fenceEnd = markdown.indexOf('\n```', fenceStart + 7);
    if (fenceEnd < 0)
        return null;
    const block = '\n❌ ' + text + '\n   → ' + fix + '\n';
    return markdown.slice(0, fenceEnd) + block + markdown.slice(fenceEnd);
}

function dateLabel() {
    const now = new Date();
    return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
        + '-' + String(now.getDate()).padStart(2, '0');
}

/** 由校验后的 findings 生成提案（人格提案只生成、不应用）。 */
export async function buildProposals(accepted, context) {
    const proposals = [];
    const now = Date.now();
    const characterHash = await fileHash(CHARACTER_PATH);
    let cursor = 0;
    for (const item of accepted) {
        cursor += 1;
        const id = proposalId(now + cursor);
        if (item.action === 'persona_patch') {
            const before = context.character;
            const next = item.persona.target === 'negative_example'
                ? insertNegativeExample(before, item.persona.text, item.persona.fix)
                : insertSection(before, item.persona.text, dateLabel());
            if (next === null) {
                proposals.push({
                    id,
                    ts: new Date(now).toISOString(),
                    kind: 'character',
                    status: 'rejected',
                    title: item.event,
                    reason: '人格文件里找不到落点（说话示例反例块缺失）',
                    rejectedReason: 'anchor-missing',
                    payload: item,
                });
                continue;
            }
            const diff = next === before
                ? ''
                : '--- character.md\n+++ character.md\n@@ ' + item.persona.target + ' @@\n+ ' + item.persona.text + (item.persona.fix ? '\n+   → ' + item.persona.fix : '');
            proposals.push({
                id,
                ts: new Date(now).toISOString(),
                kind: 'character',
                status: 'pending',
                title: item.event,
                reason: item.why,
                confidence: item.confidence,
                sceneKey: item.sceneKey,
                evidence: item.evidence,
                payload: item.persona,
                diff,
                beforeHash: characterHash,
                afterHash: '',
            });
            continue;
        }
        proposals.push({
            id,
            ts: new Date(now).toISOString(),
            kind: 'notebook',
            status: 'pending',
            title: item.memory.subject + '：' + item.memory.text,
            reason: item.why,
            confidence: item.confidence,
            sceneKey: item.sceneKey,
            evidence: item.evidence,
            payload: { action: item.action, ...item.memory },
            diff: '+ [' + item.memory.category + '|' + item.memory.subject + '] ' + item.memory.text,
            beforeHash: '',
            afterHash: '',
        });
    }
    return proposals;
}

/** 应用笔记提案：自动模式下立即入库。 */
export async function applyNotebookProposal(proposal, actor) {
    const raw = await readJson(NOTEBOOK_PATH, null);
    if (raw === null)
        return { ok: false, reason: 'notebook-missing' };
    const notebook = migrateNotebook(raw);
    const evidence = (proposal.evidence ?? [])[0] ?? {};
    const result = upsertEntry(notebook, {
        category: proposal.payload.category,
        subject: proposal.payload.subject,
        text: proposal.payload.text,
        authority: 'inferred',
        confidence: proposal.confidence,
        origin: {
            sceneKey: proposal.sceneKey,
            speakerQq: null,
            speakerName: null,
            messageId: evidence.messageId ?? '',
            at: new Date(evidence.ts ?? Date.now()).toISOString(),
        },
        visibility: { audience: 'scene', sceneBound: true },
        sensitivity: 'normal',
        source: { chatId: proposal.sceneKey, role: 'self-iter' },
        recordedBy: { role: 'self-iter', actor },
    });
    if (result.action === 'duplicate' || result.action === 'forbidden') {
        proposal.status = 'rejected';
        proposal.rejectedReason = result.action;
        proposal.decidedAt = new Date().toISOString();
        await saveProposal(proposal);
        await audit({ proposalId: proposal.id, action: 'apply', actor, result: result.action });
        return { ok: false, reason: result.action };
    }
    const backupPath = await backupFile(NOTEBOOK_PATH, 'notebook');
    const beforeHash = await fileHash(NOTEBOOK_PATH);
    await writeJsonAtomic(NOTEBOOK_PATH, notebook);
    const afterHash = await fileHash(NOTEBOOK_PATH);
    proposal.status = 'applied';
    proposal.appliedAt = new Date().toISOString();
    proposal.appliedBy = actor;
    proposal.beforeHash = beforeHash;
    proposal.afterHash = afterHash;
    proposal.backupPath = backupPath;
    proposal.result = { action: result.action, entryId: result.id, total: result.total };
    await saveProposal(proposal);
    await audit({
        proposalId: proposal.id,
        action: 'apply',
        actor,
        file: 'notebook.json',
        beforeHash,
        afterHash,
        result: result.action,
        entryId: result.id,
    });
    return { ok: true, action: result.action };
}

/** 应用人格提案：无论 auto-notes 还是 review，都只在主人批准时调用。 */
export async function applyCharacterProposal(proposal, actor) {
    let before;
    try {
        before = await readFile(CHARACTER_PATH, 'utf8');
    }
    catch {
        return { ok: false, reason: 'character-missing' };
    }
    const beforeHash = await fileHash(CHARACTER_PATH);
    if (proposal.beforeHash !== '' && beforeHash !== proposal.beforeHash) {
        proposal.status = 'stale';
        proposal.rejectedReason = 'file-changed-since-proposal';
        proposal.decidedAt = new Date().toISOString();
        await saveProposal(proposal);
        await audit({ proposalId: proposal.id, action: 'stale', actor, beforeHash, expected: proposal.beforeHash });
        return { ok: false, reason: 'stale' };
    }
    const target = proposal.payload?.target;
    const text = proposal.payload?.text ?? '';
    const fix = proposal.payload?.fix ?? '';
    const next = target === 'negative_example'
        ? insertNegativeExample(before, text, fix)
        : insertSection(before, text, dateLabel());
    if (next === null || next === before)
        return { ok: false, reason: 'anchor-missing' };

    const backupPath = await backupFile(CHARACTER_PATH, 'character');
    const tmp = CHARACTER_PATH + '.tmp-' + process.pid;
    await writeFile(tmp, next, 'utf8');
    await rename(tmp, CHARACTER_PATH);
    const afterHash = await fileHash(CHARACTER_PATH);
    proposal.status = 'applied';
    proposal.appliedAt = new Date().toISOString();
    proposal.appliedBy = actor;
    proposal.beforeHash = beforeHash;
    proposal.afterHash = afterHash;
    proposal.backupPath = backupPath;
    proposal.diff = '--- character.md\n+++ character.md\n@@ ' + target + ' @@\n+ ' + text
        + (fix !== '' ? '\n+   → ' + fix : '');
    await saveProposal(proposal);
    await audit({
        proposalId: proposal.id,
        action: 'apply',
        actor,
        file: 'character.md',
        beforeHash,
        afterHash,
        target,
    });
    return { ok: true };
}

export async function applyProposal(proposal, actor) {
    if (proposal.status !== 'pending')
        return { ok: false, reason: 'status-' + proposal.status };
    return proposal.kind === 'character'
        ? applyCharacterProposal(proposal, actor)
        : applyNotebookProposal(proposal, actor);
}

/** 回滚：只有当前文件还是“应用后”的那个版本才恢复，避免覆盖后续人工改动。 */
export async function rollbackProposal(proposal, actor) {
    if (proposal.status !== 'applied')
        return { ok: false, reason: 'status-' + proposal.status };
    if (typeof proposal.backupPath !== 'string' || proposal.backupPath === '')
        return { ok: false, reason: 'no-backup' };
    const path = proposal.kind === 'character' ? CHARACTER_PATH : NOTEBOOK_PATH;
    const currentHash = await fileHash(path);
    if (currentHash !== proposal.afterHash)
        return { ok: false, reason: 'drift-detected', currentHash };
    await copyFile(proposal.backupPath, path);
    proposal.status = 'rolledback';
    proposal.rolledBackAt = new Date().toISOString();
    proposal.rolledBackBy = actor;
    await saveProposal(proposal);
    await audit({
        proposalId: proposal.id,
        action: 'rollback',
        actor,
        file: proposal.kind === 'character' ? 'character.md' : 'notebook.json',
        restoredHash: await fileHash(path),
    });
    return { ok: true };
}

export async function rejectProposal(proposal, actor, reason) {
    if (proposal.status !== 'pending')
        return { ok: false, reason: 'status-' + proposal.status };
    proposal.status = 'rejected';
    proposal.rejectedReason = String(reason ?? 'manual');
    proposal.decidedAt = new Date().toISOString();
    proposal.decidedBy = actor;
    await saveProposal(proposal);
    await audit({ proposalId: proposal.id, action: 'reject', actor, reason: proposal.rejectedReason });
    return { ok: true };
}
