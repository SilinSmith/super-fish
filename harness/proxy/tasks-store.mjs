/**
 * 跨轮任务状态：把多步任务的目标、进度、续跑次数存成文件。
 *
 * 插件侧（qq_task 工具、bridge 的续跑定时器）负责写，persona proxy 每轮
 * 读取并注入，所以即使 QQ 会话历史被裁剪，模型也不会忘记做到哪一步。
 *
 * 纯函数 + 固定路径，方便单独测试。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// 允许测试/离线验证换一个文件；默认仍是宿主与插件共用的那一份。
export const TASKS_PATH = process.env.QQ_TASKS_PATH ?? 'Y:\\dsh\\home\\qq-persona\\tasks.json';
/** 每个会话最多几个进行中任务。 */
export const MAX_ACTIVE_PER_CHAT = 5;
/** 全部任务保留上限（防止文件无限增长）。 */
const MAX_TASKS = 200;
/** 同一个任务两次自动续跑的最小间隔。 */
export const RUN_GAP_MS = 3 * 60_000;
export const DEFAULT_MAX_RUNS = 12;
export const DEFAULT_MAX_AGE_HOURS = 6;
/** 连续几轮续跑没有任何 update，就认定卡死并自动收尾。 */
export const MAX_STALLS = 3;

const STATUSES = ['active', 'done', 'cancelled', 'expired'];

function iso(ms) {
    return new Date(ms).toISOString();
}

function clampNumber(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function normalizeTask(raw, index) {
    if (raw === null || typeof raw !== 'object')
        return undefined;
    const title = String(raw.title ?? '').trim();
    if (title === '')
        return undefined;
    const created = Number.isFinite(Date.parse(String(raw.createdAt ?? '')))
        ? String(raw.createdAt)
        : iso(Date.now());
    return {
        id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : 't_legacy_' + index,
        chatId: typeof raw.chatId === 'string' ? raw.chatId : '',
        title: title.slice(0, 80),
        brief: String(raw.brief ?? '').slice(0, 500),
        steps: Array.isArray(raw.steps)
            ? raw.steps.filter(step => typeof step === 'string' && step.trim() !== '').slice(-12).map(step => step.slice(0, 200))
            : [],
        status: STATUSES.includes(raw.status) ? raw.status : 'active',
        ownerQQ: String(raw.ownerQQ ?? ''),
        ownerName: String(raw.ownerName ?? ''),
        ownerRole: raw.ownerRole === 'admin' ? 'admin' : 'member',
        createdAt: created,
        updatedAt: Number.isFinite(Date.parse(String(raw.updatedAt ?? '')) ? String(raw.updatedAt) : created),
        lastRunAt: Number.isFinite(Number(raw.lastRunAt)) ? Number(raw.lastRunAt) : 0,
        runs: Math.max(0, Math.trunc(Number(raw.runs) || 0)),
        maxRuns: clampNumber(raw.maxRuns, DEFAULT_MAX_RUNS, 1, 50),
        maxAgeHours: clampNumber(raw.maxAgeHours, DEFAULT_MAX_AGE_HOURS, 1, 72),
        stalls: Math.max(0, Math.trunc(Number(raw.stalls) || 0)),
        note: String(raw.note ?? '').slice(0, 300),
    };
}

/** 把任意版本的任务文件归一化成 v1，不改动传入对象。 */
export function migrateTasks(raw) {
    const source = raw !== null && typeof raw === 'object' ? raw : {};
    const tasks = (Array.isArray(source.tasks) ? source.tasks : [])
        .map((task, index) => normalizeTask(task, index))
        .filter(task => task !== undefined)
        .slice(-MAX_TASKS);
    return {
        version: 1,
        tasks,
        updatedAt: typeof source.updatedAt === 'string' && source.updatedAt !== '' ? source.updatedAt : null,
    };
}

/** 读取任务文件；损坏或不存在时返回空状态，不抛错。 */
export async function readTasks() {
    try {
        return migrateTasks(JSON.parse(await readFile(TASKS_PATH, 'utf8')));
    }
    catch {
        return migrateTasks(undefined);
    }
}

/** 临时文件 + rename，避免 proxy 读到半个 JSON。 */
export async function writeTasks(doc) {
    const normalized = migrateTasks(doc);
    await mkdir(dirname(TASKS_PATH), { recursive: true });
    const temporary = TASKS_PATH + '.tmp';
    await writeFile(temporary, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
    await rename(temporary, TASKS_PATH);
    return normalized;
}

/** 找任务：优先 id；没给 id 时用该会话最近更新的进行中任务。 */
export function findTask(doc, id, chatId) {
    const tasks = Array.isArray(doc?.tasks) ? doc.tasks : [];
    if (typeof id === 'string' && id !== '') {
        return tasks.find(task => task.id === id && (chatId === undefined || task.chatId === chatId));
    }
    return tasks
        .filter(task => task.chatId === chatId && task.status === 'active')
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

export function createTask(doc, input, now = Date.now()) {
    const title = String(input?.title ?? '').trim();
    const chatId = String(input?.chatId ?? '');
    if (title === '')
        throw new Error('qq_task: add 需要 title（一句话说明要完成什么）');
    if (chatId === '')
        throw new Error('qq_task: 找不到当前会话，无法建任务');
    const active = doc.tasks.filter(task => task.chatId === chatId && task.status === 'active');
    if (active.length >= MAX_ACTIVE_PER_CHAT)
        throw new Error('qq_task: 这个会话已有 ' + active.length + ' 个进行中任务，先 done/cancel 一个再建');
    const steps = Array.isArray(input?.steps)
        ? input.steps.filter(step => typeof step === 'string' && step.trim() !== '').slice(0, 8).map(step => step.slice(0, 200))
        : [];
    const task = {
        id: 't' + now.toString(36) + Math.random().toString(36).slice(2, 6),
        chatId,
        title: title.slice(0, 80),
        brief: String(input?.brief ?? '').slice(0, 500),
        steps,
        status: 'active',
        ownerQQ: String(input?.ownerQQ ?? ''),
        ownerName: String(input?.ownerName ?? ''),
        ownerRole: input?.ownerRole === 'admin' ? 'admin' : 'member',
        createdAt: iso(now),
        updatedAt: iso(now),
        lastRunAt: 0,
        runs: 0,
        maxRuns: clampNumber(input?.maxRuns, DEFAULT_MAX_RUNS, 1, 50),
        maxAgeHours: clampNumber(input?.maxAgeHours, DEFAULT_MAX_AGE_HOURS, 1, 72),
        stalls: 0,
        note: '',
    };
    doc.tasks.push(task);
    if (doc.tasks.length > MAX_TASKS)
        doc.tasks = doc.tasks.slice(-MAX_TASKS);
    doc.updatedAt = iso(now);
    return task;
}

export function updateTask(doc, input, now = Date.now()) {
    const task = findTask(doc, input?.id, input?.chatId);
    if (task === undefined || task.status !== 'active')
        throw new Error('qq_task: 没有找到进行中的任务（可能已完成，或用 list 查 id）');
    const note = String(input?.note ?? '').trim();
    const brief = String(input?.brief ?? '').trim();
    if (note === '' && brief === '')
        throw new Error('qq_task: update 需要 note 或 brief');
    if (brief !== '')
        task.brief = brief.slice(0, 500);
    if (note !== '') {
        task.steps.push(note.slice(0, 200));
        task.steps = task.steps.slice(-12);
    }
    task.updatedAt = iso(now);
    // 有真实进度，卡死计数清零。
    task.stalls = 0;
    doc.updatedAt = iso(now);
    return task;
}

export function finishTask(doc, input, now = Date.now()) {
    const task = findTask(doc, input?.id, input?.chatId);
    if (task === undefined)
        throw new Error('qq_task: 没有找到任务（用 list 查 id）');
    if (task.status !== 'active')
        return task;
    const note = String(input?.note ?? '').trim();
    task.status = input?.status === 'cancelled' ? 'cancelled' : 'done';
    task.note = note.slice(0, 300);
    task.updatedAt = iso(now);
    doc.updatedAt = iso(now);
    return task;
}

/** 到期的任务标记为 expired，返回本轮的收尾列表。 */
export function expireTasks(doc, now = Date.now()) {
    const expired = [];
    for (const task of doc.tasks) {
        if (task.status !== 'active')
            continue;
        const ageMs = now - Date.parse(task.createdAt);
        const tooOld = ageMs >= task.maxAgeHours * 3_600_000;
        const tooMany = task.runs >= task.maxRuns;
        const stuck = task.stalls >= MAX_STALLS;
        if (!tooOld && !tooMany && !stuck)
            continue;
        task.status = 'expired';
        task.note = tooOld ? '超过 ' + task.maxAgeHours + ' 小时自动停止'
            : (tooMany ? '续跑 ' + task.runs + ' 次仍未完成，自动停止'
                : '连续 ' + task.stalls + ' 次续跑没有进度，自动停止');
        task.updatedAt = iso(now);
        expired.push(task);
    }
    if (expired.length > 0)
        doc.updatedAt = iso(now);
    return expired;
}

/** 下一轮该续跑的任务：最早的、间隔够 3 分钟的 active 任务。 */
export function dueTask(doc, now = Date.now()) {
    const active = doc.tasks
        .filter(task => task.status === 'active' && task.chatId !== '')
        .sort((left, right) => left.lastRunAt - right.lastRunAt);
    const task = active[0];
    if (task === undefined)
        return undefined;
    if (task.runs >= task.maxRuns)
        return undefined;
    if (now - task.lastRunAt < RUN_GAP_MS)
        return undefined;
    if (now - Date.parse(task.createdAt) >= task.maxAgeHours * 3_600_000)
        return undefined;
    return task;
}

/** 派发前记账：上一轮之后没有 update 就算一次停滞。 */
export function markRun(doc, task, now = Date.now()) {
    if (task.lastRunAt > 0 && Date.parse(task.updatedAt) <= task.lastRunAt)
        task.stalls += 1;
    else
        task.stalls = 0;
    task.runs += 1;
    task.lastRunAt = now;
    doc.updatedAt = iso(now);
    return task;
}

/** 每轮注入 system 的任务区；没有进行中任务时返回空串。 */
export function formatTaskSection(doc, options = {}) {
    const chatId = typeof options.chatId === 'string' && options.chatId !== '' ? options.chatId : undefined;
    const limit = Math.max(1, Math.min(10, Number(options.limit) || 5));
    const active = doc.tasks
        .filter(task => task.status === 'active' && (chatId === undefined || task.chatId === chatId))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, limit);
    if (active.length === 0)
        return '';
    const lines = ['## 进行中的任务（跨轮保存，完成或取消前一直有效）'];
    for (const task of active) {
        lines.push('- [' + task.id + '] ' + task.title + '（已续跑 ' + task.runs + '/' + task.maxRuns + '）');
        if (task.brief !== '')
            lines.push('  目标：' + task.brief);
        if (task.steps.length > 0)
            lines.push('  最近：' + task.steps.slice(-3).join('；'));
        else
            lines.push('  最近：还没记录进度');
    }
    lines.push('继续推进时先看上面的进度，不要重复已完成的事；做完一步用 qq_task(action="update", id="<id>", note="...")，全部结束用 done，用户让停用 cancel。');
    return lines.join('\n');
}

/** 自动续跑时投给模型的请求文本。 */
export function continuationPrompt(task) {
    const progress = task.steps.length > 0 ? task.steps.slice(-2).join('；') : '（还没记录进度）';
    return '【任务续跑】任务「' + task.title + '」还没结束（第 ' + (task.runs + 1) + '/' + task.maxRuns + ' 次续跑）。\n'
        + (task.brief !== '' ? '目标：' + task.brief + '\n' : '')
        + '最近进度：' + progress + '\n'
        + '现在继续推进下一步：需要工具就真的调用，不要只回复“我在做/马上弄”；一次只做一小步。\n'
        + '做完后用 qq_task(action="update", id="' + task.id + '", note="这一步的结果") 记进度；全部完成用 qq_task(action="done", id="' + task.id + '")；做不下去或需要我决定，用 qq_task(action="cancel", id="' + task.id + '", note="原因")。\n'
        + '如果这一步没有任何对外的新进展，只输出【内心】...，不要发空话。';
}
