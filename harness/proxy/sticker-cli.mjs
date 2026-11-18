/**
 * 表情包离线链路：
 *   harvest → ingest → tag → recall
 * 维护：
 *   maintain / health / history / restore / backup
 *
 * 不启动常驻进程、不改插件、不动 stickers.json。
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import {
    BLOB_DIR, HARVEST_DIR, HARVEST_MANIFEST, LIB_ROOT, SCENE_ORDER, STICKER_EMOTIONS,
    TABOO_OPTIONS, UNKNOWN_EMOTION, WORK_DIR,
    attachCaption, checkPatch, ensureDailyBackup, ensureLayout, getHealth, hashFile, ingestFile,
    listPendingTag, loadDenyList, loadRecords, pickSticker, readMaintenanceHistory, recall,
    addDeny, purgeRecords, recheckBlocks, reserveTagBudget, resetTag, restoreRecord,
    runMaintenance, toBytesText,
} from './sticker-lib.mjs';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'help';

function arg(name, fallback = undefined) {
    const index = argv.indexOf('--' + name);
    if (index === -1 || index + 1 >= argv.length) return fallback;
    return argv[index + 1];
}

function has(name) {
    return argv.includes('--' + name);
}

function numberArg(name, fallback) {
    const value = Number(arg(name, fallback));
    return Number.isFinite(value) ? value : fallback;
}

function print(value) {
    console.log(JSON.stringify(value, null, 2));
}

function imageExtension(name) {
    return /\.(png|jpe?g|gif|webp)$/iu.test(name);
}

async function harvestLocal() {
    const entries = [];
    for (const entry of await readdir(LIB_ROOT, { withFileTypes: true })) {
        if (!entry.isFile() || !imageExtension(entry.name)) continue;
        entries.push({
            path: join(LIB_ROOT, entry.name),
            kind: 'local-import',
            name: entry.name,
            protected: true,
            desc: '',
        });
    }
    return entries;
}

function sniffExtension(buffer) {
    if (buffer.length >= 2 && buffer[0] === 0x89 && buffer[1] === 0x50) return 'png';
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpg';
    if (buffer.subarray(0, 3).toString('latin1') === 'GIF') return 'gif';
    if (buffer.subarray(0, 4).toString('latin1') === 'RIFF'
        && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
    return '';
}

async function fetchCustomFaces(count = 48) {
    const url = process.env.QQ_ONEBOT_WS ?? 'ws://127.0.0.1:3001';
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WS 连接超时: ' + url)), 8000);
        socket.addEventListener('open', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
        socket.addEventListener('error', event => {
            clearTimeout(timer);
            reject(new Error('WS 连接失败: ' + String(event?.message ?? event?.type ?? 'error')));
        }, { once: true });
    });
    const echo = 'sticker-harvest-' + Date.now();
    const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('fetch_custom_face_detail 超时')), 20000);
        socket.addEventListener('message', event => {
            let payload;
            try {
                payload = JSON.parse(String(event.data));
            }
            catch {
                return;
            }
            if (payload?.echo !== echo) return;
            clearTimeout(timer);
            resolve(payload);
        });
    });
    socket.send(JSON.stringify({
        action: 'fetch_custom_face_detail',
        params: { count },
        echo,
    }));
    const payload = await response;
    socket.close();
    if (payload?.status !== 'ok' && payload?.retcode !== 0)
        throw new Error('fetch_custom_face_detail 返回异常: ' + JSON.stringify(payload).slice(0, 300));
    const data = payload?.data;
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.data)) return data.data;
    return [];
}

async function downloadFace(face) {
    const url = String(face?.url ?? '');
    if (!/^https?:\/\//iu.test(url)) return { ok: false, reason: 'bad-url', url };
    let response;
    try {
        response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    }
    catch (error) {
        return { ok: false, reason: 'fetch-failed', detail: String(error?.message ?? error), url };
    }
    if (!response.ok) return { ok: false, reason: 'http-' + response.status, url };
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) return { ok: false, reason: 'empty', url };
    if (buffer.length > 5 * 1024 * 1024) return { ok: false, reason: 'too-large', bytes: buffer.length, url };
    const extension = sniffExtension(buffer);
    if (extension === '') return { ok: false, reason: 'not-image', bytes: buffer.length, url };
    const name = String(face?.md5 ?? face?.emoji_id ?? Date.now()).replace(/[^a-z0-9_-]/giu, '').slice(0, 40)
        || String(Date.now());
    const path = join(HARVEST_DIR, name + '.' + extension);
    await mkdir(HARVEST_DIR, { recursive: true });
    await writeFile(path, buffer);
    return { ok: true, path, bytes: buffer.length, extension };
}

async function harvest() {
    await ensureLayout();
    const remote = has('remote');
    const count = numberArg('count', 48);
    const entries = [];
    const failures = [];

    if (!has('local-only')) {
        for (const entry of await harvestLocal()) entries.push(entry);
    }

    if (remote) {
        let faces;
        try {
            faces = await fetchCustomFaces(count);
        }
        catch (error) {
            failures.push({ stage: 'fetch', detail: String(error?.message ?? error) });
            faces = [];
        }
        for (const face of faces) {
            const downloaded = await downloadFace(face);
            if (!downloaded.ok) {
                failures.push({ stage: 'download', emojiId: face?.emoji_id ?? null, ...downloaded });
                continue;
            }
            entries.push({
                path: downloaded.path,
                kind: 'custom-face',
                name: basename(downloaded.path),
                protected: false,
                emojiId: String(face?.emoji_id ?? ''),
                resId: String(face?.resId ?? ''),
                md5: String(face?.md5 ?? ''),
                desc: String(face?.desc ?? ''),
                url: String(face?.url ?? ''),
            });
        }
    }

    const manifest = {
        createdAt: new Date().toISOString(),
        remoteRequested: remote,
        count,
        entries,
        failures,
    };
    await mkdir(WORK_DIR, { recursive: true });
    await writeFile(HARVEST_MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    print({
        localFiles: entries.filter(entry => entry.kind === 'local-import').length,
        remoteFetched: entries.filter(entry => entry.kind === 'custom-face').length
            + failures.filter(item => item.stage === 'download').length,
        remoteDownloaded: entries.filter(entry => entry.kind === 'custom-face').length,
        failures: failures.length,
        manifest: HARVEST_MANIFEST,
        failureDetails: failures.slice(0, 10),
    });
}

async function ingestManifest() {
    await ensureLayout();
    let manifest;
    try {
        manifest = JSON.parse(await readFile(HARVEST_MANIFEST, 'utf8'));
    }
    catch {
        manifest = { entries: (await harvestLocal()).map(entry => ({ ...entry })) };
    }
    const dryRun = has('dry-run');
    const counts = { added: 0, exactDuplicate: 0, nearDuplicate: 0, rejected: 0 };
    const results = [];
    for (const entry of manifest.entries ?? []) {
        try {
            const result = await ingestFile({
                sourcePath: entry.path,
                source: {
                    kind: entry.kind ?? 'manual',
                    emojiId: entry.emojiId,
                    md5: entry.md5,
                    desc: entry.desc,
                    url: entry.url,
                    name: entry.name ?? basename(entry.path ?? ''),
                },
                dryRun,
                protect: entry.protected === true,
                descHint: entry.desc ?? '',
            });
            if (result.status === 'added') counts.added += 1;
            else if (result.status === 'exact-duplicate') counts.exactDuplicate += 1;
            else if (result.status === 'near-duplicate') counts.nearDuplicate += 1;
            else counts.rejected += 1;
            results.push(result);
        }
        catch (error) {
            counts.rejected += 1;
            results.push({ status: 'error', path: entry.path, detail: String(error?.message ?? error) });
        }
    }
    print({
        sourceEntries: (manifest.entries ?? []).length,
        dryRun,
        ...counts,
        results: results.slice(0, 20),
    });
}

async function readVisionState() {
    try {
        return JSON.parse(await readFile(
            process.env.QQ_VISION_STATE ?? 'Y:\\dsh\\home\\qq-persona\\vision-state.json',
            'utf8',
        ));
    }
    catch {
        return { entries: [] };
    }
}

async function tag() {
    await ensureLayout();
    const limit = numberArg('limit', 1000);
    const backfill = has('backfill');
    const timeoutMs = numberArg('timeout', 300_000);
    // --id a,b：先把这些记录改回待打标再跑，用于模型输出坏掉后的定向重打。
    const resetIds = String(arg('id', '')).split(/[,\s]+/u).filter(Boolean);
    if (resetIds.length > 0) {
        const touched = await resetTag(resetIds);
        console.log('重置待打标: ' + (touched.join(',') || '无'));
    }
    const pending = await listPendingTag(limit);
    if (pending.length === 0) {
        print({ pending: 0, tagged: 0, note: '没有待打标记录' });
        return;
    }

    const vision = await import('./vision.mjs');
    const runId = Date.now().toString(36);
    const results = [];
    let budgetExhausted = false;

    for (const record of pending) {
        const budget = await reserveTagBudget({ backfill });
        if (!budget.allowed) {
            budgetExhausted = true;
            break;
        }
        try {
            await stat(record.blobPath);
        }
        catch {
            results.push({ id: record.id, ms: 0, error: 'blob-missing' });
            continue;
        }
        const chatId = 'sticker-ingest:' + record.id + ':' + runId;
        const startedAt = Date.now();
        // 唯一打标路径：observeImage → captionImage，source=sticker 才会要求结构化 sticker。
        vision.observeImage({
            path: record.blobPath,
            chatId,
            deleteAfter: false,
            source: 'sticker',
            batch: backfill,
            hint: {
                stickerEmotions: [...STICKER_EMOTIONS],
                stickerScenes: [...SCENE_ORDER],
                stickerTaboo: [...TABOO_OPTIONS],
            },
        });
        const idle = await vision.waitForVisionIdle(timeoutMs);
        const state = await readVisionState();
        const entry = (state.entries ?? []).find(item => item?.chatId === chatId);
        const caption = String(entry?.text ?? '');
        const error = caption === '' ? (idle ? 'vision-empty' : 'vision-timeout') : undefined;
        const updated = await attachCaption(record.id, caption, {
            error,
            sticker: entry?.sticker,
            panels: entry?.panels,
            layout: entry?.layout,
            promptVersion: 'observeImage-sticker-v2',
        });
        results.push({
            id: record.id,
            ms: Date.now() - startedAt,
            caption,
            emotion: updated.emotion,
            emotionConfidence: updated.emotionConfidence,
            scenes: updated.scenes,
            sceneConfidences: updated.sceneConfidences,
            intensity: updated.intensity,
            intensityConfidence: updated.intensityConfidence,
            textOnImage: updated.textOnImage,
            textOnImageItems: updated.textOnImageItems,
            taboo: updated.taboo,
            tabooConfidences: updated.tabooConfidences,
            ocrMissing: updated.ocrMissing === true,
            uncertain: updated.emotion === UNKNOWN_EMOTION,
            layout: updated.layout ?? null,
            panels: updated.panels ?? [],
            tagSource: updated.tagSource,
            tagRuleVersion: updated.tagRuleVersion,
            promptVersion: updated.promptVersion,
            error: error ?? null,
        });
        console.log('[' + results.length + '/' + pending.length + '] ' + record.id
            + ' ' + (Date.now() - startedAt) + 'ms '
            + updated.emotion + '(' + (updated.emotionConfidence ?? 0) + ')'
            + ' / ' + (updated.scenes ?? []).join(',')
            + ' / 强度 ' + (updated.intensity ?? '未判')
            + ' / 文字 ' + ((updated.textOnImageItems ?? []).map(item => item.text).join('|') || '无')
            + (updated.panels?.length ? ' / 分格 ' + updated.panels.length : '')
            + ' / ' + (caption || error));
        if (!idle) {
            results.push({ id: record.id, ms: 0, error: 'vision-timeout-stop' });
            break;
        }
    }

    const completed = results.filter(item => item.error === null);
    print({
        pending: pending.length,
        tagged: completed.length,
        failed: results.filter(item => item.error !== null && item.error !== undefined).length,
        budgetExhausted,
        totalMs: results.reduce((sum, item) => sum + (Number(item.ms) || 0), 0),
        avgMs: results.length === 0 ? 0
            : Math.round(results.reduce((sum, item) => sum + (Number(item.ms) || 0), 0) / results.length),
        results,
    });
}

async function retag() {
    const records = await loadRecords();
    const results = [];
    let skippedStructured = 0;
    for (const record of records) {
        if (String(record.captionRaw ?? '') === '') continue;
        // 结构化结果（vision-v2）不能被文本规则覆盖，重跑要重新过模型。
        if (record.tagSource === 'vision-structured') {
            skippedStructured += 1;
            continue;
        }
        const updated = await attachCaption(record.id, record.captionRaw, {
            error: record.tagError ?? undefined,
        });
        results.push({
            id: updated.id,
            emotion: updated.emotion,
            emotionConfidence: updated.emotionConfidence,
            scenes: updated.scenes,
            intensity: updated.intensity,
            textOnImage: updated.textOnImage,
            tagSource: updated.tagSource,
            blocked: updated.flags?.blocked === true,
        });
    }
    print({ retagged: results.length, skippedStructured, modelCalls: 0, results });
}

async function runRecall() {
    const text = String(arg('text', ''));
    if (text === '') {
        print({ error: 'recall 需要 --text "..."' });
        return;
    }
    const result = await recall({
        text,
        emotion: String(arg('emotion', '')),
        limit: numberArg('limit', 3),
        recordHits: !has('no-record'),
    });
    print(result);
    for (const candidate of result.candidates) {
        console.log('\n#' + candidate.id + '  score=' + candidate.score
            + '  情绪=' + candidate.emotion + '(' + (candidate.emotionConfidence ?? 0) + ')'
            + '  场景=' + candidate.scenes.join(',')
            + '  强度=' + (candidate.intensity === null || candidate.intensity === undefined
                ? '未判' : candidate.intensity + '/5'));
        console.log('  描述: ' + candidate.description);
        console.log('  理由: ' + candidate.reason);
    }
}

async function runPick() {
    const text = String(arg('text', ''));
    if (text === '') {
        print({ error: 'pick 需要 --text "..."' });
        return;
    }
    // 固定 dry-run：只看选择结果，不写 pick-state，也不改索引里的 lastUsedAt。
    const result = await pickSticker({
        text,
        emotion: String(arg('emotion', '')),
        chatId: String(arg('chat', 'dry-run')),
        dryRun: true,
    });
    print(result);
    if (result.chosen !== undefined) {
        console.log('\n选中: ' + result.chosen.emotion + ' | '
            + (result.chosen.textOnImage || result.chosen.description));
        console.log('文件: ' + result.chosen.blobPath);
        console.log('理由: ' + result.chosen.reason);
    }
    else {
        console.log('\n不发：' + result.reason);
    }
}

async function maintain() {
    const history = numberArg('history', 0);
    if (history > 0) {
        print(await readMaintenanceHistory(history));
        return;
    }
    const summary = await runMaintenance({
        dryRun: has('dry-run'),
        sendingEnabled: has('sending'),
    });
    print(summary);
}

async function stats() {
    const health = await getHealth();
    const records = await loadRecords();
    const selectable = records.filter(record => record.flags?.blocked !== true
        && record.emotion !== UNKNOWN_EMOTION && record.emotion !== '其他');
    print({
        ...health,
        indexRecords: records.length,
        selectable: selectable.length,
        blobsDir: BLOB_DIR,
        libraryRoot: LIB_ROOT,
    });
}

/** 物理清除指定记录（含 blob 与 pick-state 历史），不可恢复。 */
async function purge() {
    const ids = String(arg('id', '')).split(/[,\s]+/u).filter(Boolean);
    if (ids.length === 0) {
        print({ error: 'purge 需要 --id a,b' });
        return;
    }
    print(await purgeRecords(ids, { reason: String(arg('reason', 'manual')) }));
}

/** 往拒收名单加一条：--file 自动算 sha256/phash，也可直接给 --sha256。 */
async function deny() {
    let sha256 = String(arg('sha256', '')).toLowerCase();
    let phash = String(arg('phash', ''));
    const file = arg('file');
    if (file !== undefined && sha256 === '') {
        const hashed = await hashFile(file);
        sha256 = hashed.sha256;
        if (phash === '' && hashed.phash !== undefined) phash = hashed.phash;
    }
    print(await addDeny({
        sha256,
        phash,
        name: String(arg('name', file ?? '')),
        reason: String(arg('reason', 'manual')),
        by: 'cli',
        note: String(arg('note', '')),
    }));
}

async function main() {
    if (command === 'harvest') return harvest();
    if (command === 'ingest') return ingestManifest();
    if (command === 'tag') return tag();
    if (command === 'retag') return retag();
    if (command === 'recall') return runRecall();
    if (command === 'pick') return runPick();
    if (command === 'maintain') return maintain();
    if (command === 'purge') return purge();
    if (command === 'deny') return deny();
    if (command === 'deny-list') {
        print(await loadDenyList());
        return;
    }
    if (command === 'recheck') {
        print(await recheckBlocks());
        return;
    }
    if (command === 'health' || command === 'stats') return stats();
    if (command === 'history') {
        print(await readMaintenanceHistory(numberArg('limit', 5)));
        return;
    }
    if (command === 'restore') {
        const id = argv[1];
        print(id === undefined ? { error: 'restore 需要 id' } : await restoreRecord(id));
        return;
    }
    if (command === 'patch-check') {
        print(await checkPatch());
        return;
    }
    if (command === 'backup') {
        print(await ensureDailyBackup({ force: has('force') }));
        return;
    }
    if (command === 'size') {
        let bytes = 0;
        let count = 0;
        for (const entry of await readdir(BLOB_DIR, { withFileTypes: true, recursive: true })) {
            if (!entry.isFile()) continue;
            const info = await stat(join(entry.path ?? BLOB_DIR, entry.name));
            bytes += info.size;
            count += 1;
        }
        print({ count, bytes, bytesText: toBytesText(bytes) });
        return;
    }
    print({
        usage: [
            'harvest [--remote] [--count 48] [--local-only]',
            'ingest [--dry-run]',
            'tag [--backfill] [--limit N] [--timeout ms]',
            'retag  # 用已存 caption 重新推导标签，0 次模型调用',
            'recall --text "..." [--emotion X] [--limit 3] [--no-record]',
            'pick --text "..." [--emotion X] [--chat id]  # 发送侧 dry-run，不写冷却',
            'maintain [--dry-run] [--sending] | --history N',
            'health | stats | history [--limit N] | restore <id> | backup [--force] | size',
            'patch-check  # 入站表情包补丁是否还在',
        ],
        libraryRoot: LIB_ROOT,
        harvestManifest: HARVEST_MANIFEST,
    });
}

main().catch(error => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
});
