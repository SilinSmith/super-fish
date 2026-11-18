/**
 * 入站素材收取：来源判定 → 限流 → blocklist → 下载 → 去重入库 → 排队打标。
 *
 * 边界：
 * - sticker 段：沿用群白名单限流，全部收。
 * - image 段：只收主人本人、私聊、或 IMAGE_INTAKE_POLICY.groupWhitelist 里的群；
 *   其他群成员的随手图在下载前就拒绝，不落盘、不写审计。
 * - 限流丢弃、坏图、超限、blocklist 命中、非白名单来源都只写审计 + 计数，图片不落盘。
 * - 打标交给独立的 tag 子进程，沿用每小时配额与 GPU 租约暂停，不堵入站。
 * - 插件入站分支以旁路方式调用本模块，调用方必须 fire-and-forget。
 */
import { spawn } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    audit, blocklistMatch, ensureLayout, ingestFile, matchDeny, WORK_DIR,
} from './sticker-lib.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(MODULE_DIR, 'sticker-cli.mjs');
const STATE_PATH = join(WORK_DIR, 'intake-state.json');

/** 限流参数：按发送者每日、按群每小时；超出只计数不落盘。 */
export const INTAKE_POLICY = Object.freeze({
    perSenderPerDay: 5,
    perGroupPerHour: 10,
    // 空数组表示沿用插件自己的群白名单；填了就再叠一层。
    groupWhitelist: [],
});

/**
 * 普通图片的入库范围：只收主人本人、私聊、或这里列出的群。
 * 主人的批量发送按图片单独计额度，避免被表情包的 5 次/日卡住。
 */
export const IMAGE_INTAKE_POLICY = Object.freeze({
    perSenderPerDay: 60,
    perGroupPerHour: 40,
    groupWhitelist: [],
    allowPrivate: true,
});

/**
 * 判断一张普通图片是否该入库；返回来源标记，供记录回溯。
 * @param meta - { chatId, groupId, userId }
 * @param masterUserId - 插件配置里的 masterQQ
 */
export function shouldIntakeImage(meta = {}, masterUserId = '') {
    const userId = String(meta.userId ?? '');
    const chatId = String(meta.chatId ?? '');
    const groupId = String(meta.groupId ?? '');
    if (masterUserId !== '' && userId === masterUserId)
        return { ok: true, kind: 'owner-image', reason: 'master' };
    if (IMAGE_INTAKE_POLICY.allowPrivate === true && chatId.startsWith('private:'))
        return { ok: true, kind: 'private-image', reason: 'private' };
    if (groupId !== '' && IMAGE_INTAKE_POLICY.groupWhitelist.includes(groupId))
        return { ok: true, kind: 'group-image', reason: 'group-allowlist' };
    return { ok: false, reason: 'source-not-allowed' };
}

const TAG_DEBOUNCE_MS = 60_000;
let lastTagAt = 0;

function pad(value) {
    return String(value).padStart(2, '0');
}

function dayKey(date = new Date()) {
    return String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate());
}

function hourKey(date = new Date()) {
    return dayKey(date) + pad(date.getHours());
}

function overCap(count, cap) {
    return Number(count) >= Number(cap);
}

async function readState() {
    try {
        return JSON.parse(await readFile(STATE_PATH, 'utf8'));
    }
    catch {
        return {};
    }
}

async function writeState(state) {
    const temp = STATE_PATH + '.tmp';
    state.updatedAt = new Date().toISOString();
    await writeFile(temp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    await rename(temp, STATE_PATH);
}

function normalizeStats(state) {
    state.stats = state.stats ?? {};
    const stats = state.stats;
    stats.received = Number(stats.received) || 0;
    stats.accepted = Number(stats.accepted) || 0;
    stats.duplicate = Number(stats.duplicate) || 0;
    stats.throttled = Number(stats.throttled) || 0;
    stats.rejected = Number(stats.rejected) || 0;
    stats.byReason = stats.byReason ?? {};
    return stats;
}

/** 计数并判断是否超限；返回 { blocked, scope, senderCount, groupCount }。 */
async function consumeQuota(source, limits = INTAKE_POLICY) {
    const state = await readState();
    const stats = normalizeStats(state);
    const day = dayKey();
    const hour = hourKey();
    state.senders = state.senders ?? {};
    state.groups = state.groups ?? {};
    for (const [key, value] of Object.entries(state.senders)) {
        if (value?.day !== day) delete state.senders[key];
    }
    for (const [key, value] of Object.entries(state.groups)) {
        if (value?.hour !== hour) delete state.groups[key];
    }

    stats.received += 1;
    // 私聊没有 groupId，用 chatId 作为每小时限流的分桶键，避免都挤到空键上。
    const quotaKey = String(source.chatId ?? '') || String(source.groupId ?? '') || 'unknown';
    const sender = state.senders[source.userId] ?? { day, count: 0 };
    const group = state.groups[quotaKey] ?? { hour, count: 0 };
    const senderHit = overCap(sender.count, limits.perSenderPerDay);
    const groupHit = overCap(group.count, limits.perGroupPerHour);
    if (senderHit || groupHit) {
        await writeState(state);
        return {
            blocked: true,
            scope: senderHit ? 'sender' : 'group',
            senderCount: sender.count,
            groupCount: group.count,
        };
    }
    sender.count += 1;
    group.count += 1;
    state.senders[source.userId] = sender;
    state.groups[quotaKey] = group;
    await writeState(state);
    return { blocked: false, senderCount: sender.count, groupCount: group.count };
}

/** 计一次结果 + 写一行审计：收下/丢弃每次都留痕，和 intake-state 计数一一对应。 */
async function recordOutcome(result) {
    const state = await readState();
    const stats = normalizeStats(state);
    if (result.status === 'added') stats.accepted += 1;
    else if (result.status === 'duplicate') stats.duplicate += 1;
    else if (result.status === 'throttled') stats.throttled += 1;
    else stats.rejected += 1;
    if (result.reason !== undefined && result.reason !== '')
        stats.byReason[result.reason] = (Number(stats.byReason[result.reason]) || 0) + 1;
    await writeState(state);

    // 入库配额本身已按发送者/群限流（5 次每日、10 次每小时），逐条审计不会刷屏。
    await audit({
        event: 'sticker-intake',
        status: result.status,
        reason: result.reason ?? null,
        id: result.id ?? null,
        sha256: result.sha256 ?? null,
        detail: result.detail ?? null,
        source: result.source,
        ms: result.ms,
    });
}

function scheduleTagging() {
    if (process.env.QQ_STICKER_NO_TAG === '1') return;
    const now = Date.now();
    if (now - lastTagAt < TAG_DEBOUNCE_MS) return;
    lastTagAt = now;
    try {
        const child = spawn(process.execPath, [CLI_PATH, 'tag', '--limit', '3'], {
            cwd: MODULE_DIR,
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
        });
        child.unref();
    }
    catch {
        // 打标失败不影响入库；下一次定时任务会补
    }
}

/**
 * 收一张入站素材（sticker 或 image）。两类共用同一条入库/打标流水线，
 * 只有来源判定与限流额度不同。
 * @param ref - 插件 media[] 里的引用（url/file/caption/name）。
 * @param meta - { chatId, groupId, userId, nickname, messageId, at, masterUserId }。
 * @param fetch - 由插件提供，返回 { path } 的已下载本地文件。
 * @param via - 'sticker' | 'image'。
 * @returns { status, reason?, id?, sha256?, distance?, source, ms }
 */
async function intakeMedia({ ref, meta = {}, fetch, via = 'sticker', sourceKind } = {}) {
    await ensureLayout();
    const startedAt = Date.now();
    const chatId = String(meta.chatId ?? '');
    const groupId = String(meta.groupId ?? '');
    const userId = String(meta.userId ?? '');

    // 图片来源在下载前判定；不在范围内的直接返回，不写审计、不占额度。
    let kind = sourceKind ?? (via === 'image' ? 'owner-image' : 'group-sticker');
    let reason;
    if (via === 'image') {
        const verdict = shouldIntakeImage({ chatId, groupId, userId }, String(meta.masterUserId ?? ''));
        if (verdict.ok !== true)
            return { status: 'rejected', reason: verdict.reason, source: null, ms: Date.now() - startedAt };
        kind = verdict.kind;
        reason = verdict.reason;
    }

    const source = {
        kind,
        via,
        ...(reason === undefined ? {} : { reason }),
        chatId,
        groupId,
        userId,
        nickname: String(meta.nickname ?? ''),
        messageId: meta.messageId === undefined ? '' : String(meta.messageId),
        at: Number.isFinite(meta.at) ? new Date(Number(meta.at) * 1000).toISOString() : new Date().toISOString(),
        caption: String(ref?.caption ?? ''),
        name: String(ref?.name ?? ''),
    };
    const finish = async (result) => {
        const done = { ...result, source, ms: Date.now() - startedAt };
        await recordOutcome(done);
        return done;
    };
    const limits = via === 'image' ? IMAGE_INTAKE_POLICY : INTAKE_POLICY;

    // 段里自带 sha256 时，下载前就能按拒收名单拦掉。
    const refSha = String(ref?.sha256 ?? '').toLowerCase();
    if (/^[0-9a-f]{64}$/u.test(refSha)) {
        const denied = await matchDeny({ sha256: refSha });
        if (denied !== undefined) {
            await audit({
                event: 'sticker-intake', status: 'blocked', reason: 'denylist',
                sha256: refSha, match: denied.match, entryReason: denied.reason ?? null, source,
            });
            return finish({ status: 'rejected', reason: 'denylist' });
        }
    }

    if (limits.groupWhitelist.length > 0
        && !limits.groupWhitelist.includes(source.groupId))
        return finish({ status: 'rejected', reason: 'group-not-allowed' });

    const throttle = await consumeQuota(source, limits);
    if (throttle.blocked === true)
        return finish({ status: 'throttled', reason: throttle.scope });

    const hit = await blocklistMatch([source.caption, source.name, ref?.file].filter(Boolean).join(' '));
    if (hit !== undefined)
        return finish({ status: 'rejected', reason: 'blocklist:' + hit });

    let asset;
    try {
        asset = await fetch();
    }
    catch (error) {
        return finish({ status: 'rejected', reason: 'download-failed', detail: String(error?.message ?? error) });
    }
    if (asset === undefined || typeof asset?.path !== 'string' || asset.path === '')
        return finish({ status: 'rejected', reason: 'unresolved-source' });

    const result = await ingestFile({
        sourcePath: asset.path,
        source,
        descHint: source.caption,
    });
    if (result.status === 'added') {
        scheduleTagging();
        return finish({ status: 'added', id: result.id, sha256: result.sha256 });
    }
    if (result.status === 'denylisted')
        return finish({ status: 'rejected', reason: 'denylist', sha256: result.sha256 });
    if (result.status === 'exact-duplicate' || result.status === 'near-duplicate')
        return finish({ status: 'duplicate', reason: result.status, id: result.id, sha256: result.sha256, distance: result.distance });
    return finish({ status: 'rejected', reason: result.reason ?? 'ingest-rejected', detail: result.detail });
}

/** 表情包段入库（原有行为）。 */
export async function intakeInboundSticker({ ref, meta = {}, fetch } = {}) {
    return intakeMedia({ ref, meta, fetch, via: 'sticker' });
}

/** 主人/私聊/指定群发的普通图片入库。 */
export async function intakeInboundImage({ ref, meta = {}, fetch, sourceKind } = {}) {
    return intakeMedia({ ref, meta, fetch, via: 'image', sourceKind });
}
