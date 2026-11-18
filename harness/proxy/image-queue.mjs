/**
 * 待审图片队列。
 *
 * 群友/非主人要图时，qq_draw 不直接发出去，而是把图先私信给主人过目，
 * 这里保存“谁要的、在哪个会话、图在哪”。主人批准后由 qq_image_review
 * 把图发回原会话；拒绝则删除文件。
 *
 * 单进程（DSH 插件）内用 promise 链串行化读改写，文件用临时文件+rename
 * 原子替换，避免并发工具调用把队列写坏。
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const QUEUE_PATH = 'Y:\\dsh\\home\\qq-persona\\image-requests.json';
const MAX_ITEMS = 60;
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DONE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

let chain = Promise.resolve();

function withLock(task) {
    const run = chain.then(task, task);
    chain = run.then(() => undefined, () => undefined);
    return run;
}

async function loadState() {
    try {
        const raw = await readFile(QUEUE_PATH, 'utf8');
        const state = JSON.parse(raw);
        const items = Array.isArray(state?.items) ? state.items.filter(item => item && typeof item === 'object') : [];
        const nextId = Number.isInteger(state?.nextId) && state.nextId > 0 ? state.nextId : items.length + 1;
        return { nextId, items };
    }
    catch {
        return { nextId: 1, items: [] };
    }
}

async function saveState(state) {
    await mkdir(dirname(QUEUE_PATH), { recursive: true });
    const temporary = QUEUE_PATH + '.tmp';
    await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', 'utf8');
    await rename(temporary, QUEUE_PATH);
}

function prune(state, now) {
    state.items = state.items.filter(item => {
        const age = now - Date.parse(String(item.createdAt ?? ''));
        if (!Number.isFinite(age))
            return false;
        if (item.status === 'pending')
            return age < PENDING_TTL_MS;
        return age < DONE_TTL_MS;
    });
    if (state.items.length > MAX_ITEMS)
        state.items = state.items.slice(-MAX_ITEMS);
}

/** 新增一条待审记录，返回带 id 的完整记录。 */
export function addPending(record) {
    return withLock(async () => {
        const state = await loadState();
        const now = Date.now();
        prune(state, now);
        const id = state.nextId;
        state.nextId = id + 1;
        const item = {
            id,
            status: 'pending',
            createdAt: new Date(now).toISOString(),
            chatId: String(record.chatId ?? ''),
            requester: String(record.requester ?? ''),
            requesterQq: String(record.requesterQq ?? ''),
            prompt: String(record.prompt ?? '').slice(0, 500),
            path: String(record.path ?? ''),
            width: Number(record.width) || 0,
            height: Number(record.height) || 0,
            style: String(record.style ?? ''),
        };
        state.items.push(item);
        await saveState(state);
        return item;
    });
}

export function listPending() {
    return withLock(async () => {
        const state = await loadState();
        prune(state, Date.now());
        return state.items.filter(item => item.status === 'pending');
    });
}

export function getPending(id) {
    return withLock(async () => {
        const state = await loadState();
        prune(state, Date.now());
        return state.items.find(item => item.id === Number(id));
    });
}

/** 标记为已批准/已拒绝；返回更新后的记录（找不到返回 undefined）。 */
export function resolvePending(id, status) {
    return withLock(async () => {
        const state = await loadState();
        const item = state.items.find(entry => entry.id === Number(id));
        if (item === undefined)
            return undefined;
        item.status = status === 'approved' ? 'approved' : 'rejected';
        item.resolvedAt = new Date().toISOString();
        await saveState(state);
        return item;
    });
}

/** 拒绝后清理图片文件；已被批准的文件保留，方便回看。 */
export async function discardImage(path) {
    if (typeof path !== 'string' || !path.startsWith('Y:\\dsh\\home\\qq-persona\\media\\'))
        return false;
    try {
        await unlink(path);
        return true;
    }
    catch {
        return false;
    }
}
