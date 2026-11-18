/**
 * B 站写操作：只允许 点赞 / 收藏 / 关注。
 *
 * 边界（代码层强制，不依赖提示词）：
 * - 所有请求都必须走 call() 的 ENDPOINTS 白名单；不在名单里的 endpoint 一律不发起。
 * - 投币（coin/add）、发弹幕（danmaku/post）、评论（reply/add）直接判死，永不联网；
 *   以后要放开必须改这里的代码。
 * - 幂等：同一 bvid 不重复点赞/收藏，同一 mid 不重复关注；当天有软上限。
 * - 失败最多重试 2 次（仅网络/5xx），业务错误不重试，避免触发风控。
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { cookieHeaderValue, currentAccount } from './bili-account.mjs';
import { apiHeaders, csrfToken } from './bili-fingerprint.mjs';

const HOME = 'Y:\\dsh\\home\\qq-persona';
export const WRITE_STATE_PATH = process.env.QQ_BILI_WRITE_STATE ?? join(HOME, 'bili-write-state.json');
export const WRITE_LOG_PATH = process.env.QQ_BILI_WRITE_LOG ?? join(HOME, 'bili-write.log');
export const WRITE_CONFIG_PATH = process.env.QQ_BILI_WRITE_CONFIG ?? join(HOME, 'bili-write.json');
const FAV_FOLDER_TITLE = '看过的';
// 软上限：点赞 30 / 收藏 30 / 关注 10 每天。比用户给的 50 量级更保守，留出人工操作空间。
const CAPS = { like: 30, favorite: 30, follow: 10 };
const MAX_RETRIES = 2;

/** 白名单：唯一允许发起的 endpoint。key 是内部动作名。 */
const ENDPOINTS = {
    'like': { path: '/x/web-interface/archive/like', method: 'POST', write: true },
    'fav-deal': { path: '/x/v3/fav/resource/deal', method: 'POST', write: true },
    'fav-folder-list': { path: '/x/v3/fav/folder/created/list-all', method: 'GET', write: false },
    'fav-folder-add': { path: '/x/v3/fav/folder/add', method: 'POST', write: true },
    'relation-modify': { path: '/x/relation/modify', method: 'POST', write: true },
    'relation-read': { path: '/x/relation', method: 'GET', write: false },
    'view': { path: '/x/web-interface/view', method: 'GET', write: false },
};

/** 硬禁名单：命中即拦，记录「禁止的动作」，不发起任何网络请求。 */
const BANNED = new Map([
    ['/x/web-interface/coin/add', '投币'],
    ['/x/v2/dm/post', '发弹幕'],
    ['/x/danmaku/post', '发弹幕'],
    ['/x/v2/reply/add', '评论'],
]);

let chain = Promise.resolve();

function localDay() {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

function logEvent(entry) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    chain = chain.then(async () => {
        await mkdir(dirname(WRITE_LOG_PATH), { recursive: true });
        await appendFile(WRITE_LOG_PATH, line, 'utf8');
    }).catch(() => undefined);
    return chain;
}

/** 被拦的动作：只在日志里说明原因，绝不发请求。 */
async function block(endpoint, detail) {
    const action = BANNED.get(endpoint) ?? '';
    const reason = (action === '' ? '不在白名单：' : '硬禁动作：') + detail;
    await logEvent({ kind: 'blocked', action, endpoint, reason: '禁止的动作：' + reason });
    console.log('[禁止的动作] ' + (action === '' ? endpoint : action + '（' + endpoint + '）') + '：' + reason + '，未发起请求');
    const error = new Error('BILI_ACTION_BLOCKED：' + reason + ' ' + endpoint);
    error.code = 'BILI_ACTION_BLOCKED';
    throw error;
}

function resolveEndpoint(nameOrPath) {
    const byKey = ENDPOINTS[nameOrPath];
    if (byKey !== undefined)
        return { name: nameOrPath, ...byKey };
    const found = Object.values(ENDPOINTS).find(item => item.path === nameOrPath);
    if (found !== undefined)
        return { name: found.path, ...found };
    return null;
}

async function readState() {
    try {
        const parsed = JSON.parse(await readFile(WRITE_STATE_PATH, 'utf8'));
        return {
            day: String(parsed?.day ?? ''),
            counts: { like: 0, favorite: 0, follow: 0, ...(parsed?.counts ?? {}) },
            liked: { ...(parsed?.liked ?? {}) },
            faved: { ...(parsed?.faved ?? {}) },
            followed: { ...(parsed?.followed ?? {}) },
            folderId: Number(parsed?.folderId ?? 0) || 0,
        };
    }
    catch {
        return { day: '', counts: { like: 0, favorite: 0, follow: 0 }, liked: {}, faved: {}, followed: {}, folderId: 0 };
    }
}

async function writeState(state) {
    const today = localDay();
    if (state.day !== today)
        state.day = today;
    const prune = (map) => {
        const keys = Object.keys(map);
        if (keys.length <= 2000)
            return map;
        return Object.fromEntries(keys.slice(-2000).map(key => [key, map[key]]));
    };
    const doc = { ...state, liked: prune(state.liked), faved: prune(state.faved), followed: prune(state.followed) };
    await mkdir(dirname(WRITE_STATE_PATH), { recursive: true });
    // 直接覆盖写：状态只是幂等缓存，避免 rename 覆盖把旧版本反复丢进回收站。
    await writeFile(WRITE_STATE_PATH, JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

async function loadCsrf() {
    const value = await csrfToken();
    if (value !== '')
        return value;
    throw new Error('缺少 bili_jct（写操作需要 csrf）：请写入 bili-csrf.json 或设置 QQ_BILI_CSRF');
}

/**
 * 写操作总开关：默认关闭。必须同时满足
 *   1) bili-write.json 里 enabled === true
 *   2) 环境变量 QQ_BILI_WRITE === '1'
 * 任一不满足就 fail closed，并记一条日志。所有写入口与 call() 都会检查，无法绕过。
 */
export async function writeSwitch() {
    let configEnabled = false;
    let configError = '';
    try {
        const parsed = JSON.parse(await readFile(WRITE_CONFIG_PATH, 'utf8'));
        configEnabled = parsed?.enabled === true;
    }
    catch (error) {
        configError = String(error?.message ?? error);
    }
    const envEnabled = String(process.env.QQ_BILI_WRITE ?? '').trim() === '1';
    return { enabled: configEnabled && envEnabled, configEnabled, envEnabled, configError };
}

async function assertWritesEnabled(action) {
    const state = await writeSwitch();
    if (state.enabled)
        return;
    const missing = [
        state.configEnabled ? '' : 'bili-write.json enabled=false',
        state.envEnabled ? '' : 'QQ_BILI_WRITE!=1',
    ].filter(Boolean).join(' 且 ');
    await logEvent({ kind: 'disabled', action, reason: '写操作已关闭：' + missing });
    console.log('[写操作已关闭] ' + action + '：' + missing + '，未发起请求');
    const error = new Error('BILI_WRITE_DISABLED：写操作开关关闭（' + missing + '）');
    error.code = 'BILI_WRITE_DISABLED';
    throw error;
}

async function httpJson(url, { method = 'GET', form, cookie, timeoutMs = 15_000 } = {}) {
    const headers = apiHeaders(cookie ?? undefined);
    let body;
    if (method === 'POST') {
        headers['content-type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(form ?? {}).toString();
    }
    const response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 412 || response.status === 429)
        throw new Error('BILI_RISK_' + response.status);
    if (response.status >= 500)
        throw new Error('BILI_HTTP_' + response.status);
    const data = await response.json();
    return { status: response.status, body: data };
}

/** 唯一出口：白名单校验 → 带 cookie/csrf → 最多重试 2 次（仅网络/5xx）。 */
async function call(nameOrPath, { query, form } = {}) {
    const raw = String(nameOrPath);
    // 硬禁优先判：即使路径没登记，也要按「禁止的动作」记，而不是含糊的「未登记」。
    if (BANNED.has(raw))
        await block(raw, '该动作永久禁用');
    const endpoint = resolveEndpoint(raw);
    if (endpoint === null)
        await block(raw, '未登记的 endpoint');
    if (BANNED.has(endpoint.path))
        await block(endpoint.path, '该动作永久禁用');
    // 第二道闸：即使内部逻辑绕过了入口，写 endpoint 也必须过开关。
    if (endpoint.write)
        await assertWritesEnabled(endpoint.path);
    const cookie = await cookieHeaderValue();
    if (cookie === null)
        throw new Error('B 站账号未登录或已失效，写操作中止');
    const payload = { ...(form ?? {}) };
    if (endpoint.write)
        payload.csrf = await loadCsrf();
    const search = new URLSearchParams(query ?? {}).toString();
    const url = 'https://api.bilibili.com' + endpoint.path + (search === '' ? '' : '?' + search);
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        try {
            const { body } = await httpJson(url, { method: endpoint.method, form: payload, cookie });
            return body;
        }
        catch (error) {
            lastError = error;
            const transient = /BILI_HTTP_5|fetch failed|ECONN|ETIMEDOUT|timeout/iu.test(String(error?.message ?? error));
            if (!transient || attempt === MAX_RETRIES)
                throw error;
            await new Promise(resolve => setTimeout(resolve, 1200 * (attempt + 1)));
        }
    }
    throw lastError;
}

async function takeQuota(state, kind) {
    const today = localDay();
    if (state.day !== today) {
        state.day = today;
        state.counts = { like: 0, favorite: 0, follow: 0 };
    }
    const used = Number(state.counts[kind] ?? 0);
    if (used >= CAPS[kind]) {
        await logEvent({ kind: 'cap', action: kind, used, cap: CAPS[kind] });
        return false;
    }
    state.counts[kind] = used + 1;
    return true;
}

/** 收藏夹：找不到就建；满了就再建一个「看过的 N」。 */
async function ensureFolder(state, mid) {
    const listed = await call('fav-folder-list', { query: { up_mid: String(mid), type: '2' } });
    if (Number(listed?.code ?? 0) !== 0)
        throw new Error('收藏夹列表失败：' + Number(listed?.code) + ' ' + String(listed?.message ?? ''));
    const folders = Array.isArray(listed?.data?.list) ? listed.data.list : [];
    const match = folders.find(folder => String(folder?.title ?? '') === FAV_FOLDER_TITLE);
    if (match !== undefined) {
        state.folderId = Number(match.id);
        return { id: Number(match.id), title: FAV_FOLDER_TITLE, created: false };
    }
    const created = await call('fav-folder-add', {
        form: { title: FAV_FOLDER_TITLE, desc: '自动收藏看过的视频', privacy: '0' },
    });
    const code = Number(created?.code ?? 0);
    if (code !== 0)
        throw new Error('创建收藏夹失败：' + code + ' ' + String(created?.message ?? ''));
    const id = Number(created?.data?.id ?? created?.data?.fid ?? 0);
    if (id === 0)
        throw new Error('创建收藏夹返回里没有 id');
    state.folderId = id;
    await logEvent({ kind: 'folder-created', id, title: FAV_FOLDER_TITLE });
    return { id, title: FAV_FOLDER_TITLE, created: true };
}

/** 收藏夹满（或 id 失效）时再建一个，后缀递增。 */
async function createOverflowFolder(state, mid, index) {
    const title = FAV_FOLDER_TITLE + ' ' + index;
    const created = await call('fav-folder-add', { form: { title, desc: '自动收藏看过的视频', privacy: '0' } });
    if (Number(created?.code ?? 0) !== 0)
        throw new Error('创建收藏夹失败：' + Number(created?.code) + ' ' + String(created?.message ?? ''));
    const id = Number(created?.data?.id ?? created?.data?.fid ?? 0);
    state.folderId = id;
    await logEvent({ kind: 'folder-created', id, title, mid });
    return id;
}

export async function likeVideo(bvid) {
    await assertWritesEnabled('like');
    const state = await readState();
    const key = String(bvid);
    if (state.liked[key] !== undefined) {
        await writeState(state);
        return { ok: true, skipped: 'already-liked', bvid: key };
    }
    if (!await takeQuota(state, 'like')) {
        await writeState(state);
        return { ok: false, bvid: key, reason: 'daily-cap', cap: CAPS.like };
    }
    const body = await call('like', { form: { bvid: key, like: '1' } });
    const code = Number(body?.code ?? 0);
    if (code !== 0) {
        await writeState(state);
        return { ok: false, bvid: key, code, message: String(body?.message ?? '') };
    }
    state.liked[key] = new Date().toISOString();
    await writeState(state);
    return { ok: true, bvid: key, code, message: String(body?.message ?? '') };
}

export async function favoriteVideo(bvid) {
    await assertWritesEnabled('favorite');
    const state = await readState();
    const key = String(bvid);
    if (state.faved[key] !== undefined) {
        await writeState(state);
        return { ok: true, skipped: 'already-faved', bvid: key };
    }
    const account = await currentAccount();
    if (account.mid === null || account.bound !== true)
        throw new Error('B 站账号未绑定，无法收藏');
    const view = await call('view', { query: { bvid: key } });
    const aid = Number(view?.data?.aid ?? 0);
    if (aid === 0)
        throw new Error('取 aid 失败：' + Number(view?.code) + ' ' + String(view?.message ?? ''));
    if (!await takeQuota(state, 'favorite')) {
        await writeState(state);
        return { ok: false, bvid: key, reason: 'daily-cap', cap: CAPS.favorite };
    }
    let folder = await ensureFolder(state, account.mid);
    let body = await call('fav-deal', {
        form: { rid: String(aid), type: '2', add_media_ids: String(folder.id), del_media_ids: '' },
    });
    // 收藏夹满（11201 / 或提示已满）时新建一个再放一次。
    if (Number(body?.code ?? 0) === 11201 || /满/u.test(String(body?.message ?? ''))) {
        const folders = await call('fav-folder-list', { query: { up_mid: String(account.mid), type: '2' } });
        const count = (Array.isArray(folders?.data?.list) ? folders.data.list : [])
            .filter(item => String(item?.title ?? '').startsWith(FAV_FOLDER_TITLE)).length;
        const id = await createOverflowFolder(state, account.mid, count + 1);
        body = await call('fav-deal', { form: { rid: String(aid), type: '2', add_media_ids: String(id), del_media_ids: '' } });
        folder = { id, title: FAV_FOLDER_TITLE + ' ' + (count + 1), created: true };
    }
    const code = Number(body?.code ?? 0);
    if (code !== 0) {
        await writeState(state);
        return { ok: false, bvid: key, code, message: String(body?.message ?? ''), folderId: folder.id };
    }
    state.faved[key] = new Date().toISOString();
    await writeState(state);
    return { ok: true, bvid: key, aid, code, message: String(body?.message ?? ''), folderId: folder.id, folderTitle: folder.title };
}

export async function followUp(mid) {
    await assertWritesEnabled('follow');
    const state = await readState();
    const key = String(mid);
    if (state.followed[key] !== undefined) {
        await writeState(state);
        return { ok: true, skipped: 'already-followed', mid: key };
    }
    const relation = await call('relation-read', { query: { fid: key } });
    const attribute = Number(relation?.data?.attribute ?? 0);
    if (attribute !== 0) {
        state.followed[key] = new Date().toISOString();
        await writeState(state);
        return { ok: true, skipped: 'already-followed', mid: key, attribute };
    }
    if (!await takeQuota(state, 'follow')) {
        await writeState(state);
        return { ok: false, mid: key, reason: 'daily-cap', cap: CAPS.follow };
    }
    const body = await call('relation-modify', { form: { fid: key, act: '1', re_src: '11' } });
    const code = Number(body?.code ?? 0);
    if (code !== 0) {
        await writeState(state);
        return { ok: false, mid: key, code, message: String(body?.message ?? '') };
    }
    state.followed[key] = new Date().toISOString();
    await writeState(state);
    return { ok: true, mid: key, code, message: String(body?.message ?? '') };
}

/** 自检：三个硬禁动作 + 一个未登记 endpoint，全部应在联网前被拦。 */
export async function blockedSelfTest() {
    const results = [];
    for (const endpoint of ['/x/web-interface/coin/add', '/x/v2/dm/post', '/x/v2/reply/add', '/x/web-interface/fake/none']) {
        const started = Date.now();
        try {
            await call(endpoint, { form: { csrf: '' } });
            results.push({ endpoint, blocked: false, ms: Date.now() - started });
        }
        catch (error) {
            results.push({
                endpoint,
                blocked: error?.code === 'BILI_ACTION_BLOCKED',
                reason: String(error?.message ?? error),
                ms: Date.now() - started,
            });
        }
    }
    return results;
}

export async function writeStatus() {
    const state = await readState();
    const gate = await writeSwitch();
    return {
        enabled: gate.enabled,
        configEnabled: gate.configEnabled,
        envEnabled: gate.envEnabled,
        configPath: WRITE_CONFIG_PATH,
        day: state.day,
        counts: state.counts,
        caps: CAPS,
        liked: Object.keys(state.liked).length,
        faved: Object.keys(state.faved).length,
        followed: Object.keys(state.followed).length,
        folderId: state.folderId,
        statePath: WRITE_STATE_PATH,
        logPath: WRITE_LOG_PATH,
    };
}

/** 供测试读取白名单规模。 */
export { ENDPOINTS as ALLOWED_ENDPOINTS };
