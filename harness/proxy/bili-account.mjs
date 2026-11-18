/**
 * B 站独立账号绑定。
 *
 * 设计边界（必须保持）：
 * - 登录态只认用户提供的 SESSDATA；不读浏览器 cookie 库、不读 QQ 本地数据、不复用其它登录态。
 * - 请求头与指纹 cookie（buvid3/buvid4/_uuid 等）来自 bili-fingerprint.mjs，只用于对齐浏览器特征，
 *   取不到就留空，绝不生成随机值。
 * - 失效/过期时把 status 记为 invalid 并停止带 cookie，明确降级为未登录，绝不静默当成已登录。
 * - 落盘只存这一个字段，展示只给掩码；调用方只在请求头里用它。
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { apiHeaders, cookieHeader } from './bili-fingerprint.mjs';

const HOME = 'Y:\\dsh\\home\\qq-persona';
export const BILI_ACCOUNT_PATH = process.env.QQ_BILI_ACCOUNT ?? join(HOME, 'bili-account.json');
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
// 缓存 10 分钟：面板轮询不反复打 B 站，但失效能在下一次使用前被发现。
const VERIFY_TTL_MS = 10 * 60_000;
const CACHE_MS = 3000;

let cache = { at: 0, doc: null };

function isMissing(error) {
    return error?.code === 'ENOENT';
}

function maskSessdata(value) {
    const text = String(value ?? '');
    if (text === '')
        return '—';
    if (text.length <= 12)
        return text.slice(0, 2) + '…';
    return text.slice(0, 6) + '…' + text.slice(-4);
}

export { maskSessdata };

function normalizeSessdata(raw) {
    let text = String(raw ?? '').trim();
    if (text === '')
        throw new Error('SESSDATA 不能为空');
    if (/^SESSDATA=/iu.test(text))
        text = text.slice('SESSDATA='.length).trim();
    if (text.includes(';'))
        throw new Error('只填 SESSDATA 这一个值，不要粘贴整段 Cookie（含分号）');
    if (!/^[0-9A-Za-z%*_,.-]{16,512}$/u.test(text))
        throw new Error('SESSDATA 格式不对，应形如 xxxxxxxx%2Cxxxxxxxxxx%2Cxxxxx%2Axx');
    return text;
}

function defaultDoc() {
    return {
        sessdata: '',
        updatedAt: '',
        checkedAt: '',
        status: 'invalid',
        mid: null,
        uname: '',
        level: 0,
        vip: false,
        error: '',
    };
}

async function readDoc() {
    if (Date.now() - cache.at < CACHE_MS)
        return cache.doc;
    let doc = null;
    try {
        const parsed = JSON.parse(await readFile(BILI_ACCOUNT_PATH, 'utf8'));
        if (parsed !== null && typeof parsed === 'object' && typeof parsed.sessdata === 'string' && parsed.sessdata !== '')
            doc = { ...defaultDoc(), ...parsed, sessdata: parsed.sessdata };
    }
    catch (error) {
        if (!isMissing(error))
            doc = null;
    }
    cache = { at: Date.now(), doc };
    return doc;
}

async function writeDoc(doc) {
    await mkdir(dirname(BILI_ACCOUNT_PATH), { recursive: true });
    const payload = JSON.stringify(doc, null, 2) + '\n';
    await writeFile(BILI_ACCOUNT_PATH + '.tmp', payload, { encoding: 'utf8', mode: 0o600 });
    await rename(BILI_ACCOUNT_PATH + '.tmp', BILI_ACCOUNT_PATH);
    await chmod(BILI_ACCOUNT_PATH, 0o600).catch(() => undefined);
    cache = { at: Date.now(), doc };
}

function pickRefreshedSessdata(response) {
    const list = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie') ?? ''];
    for (const line of list) {
        const match = /(?:^|[,\s])SESSDATA=([^;]+)/u.exec(String(line));
        if (match !== null && match[1] !== '')
            return match[1];
    }
    return null;
}

/** 用这一个 cookie 问 B 站「你是谁」。网络失败也返回结构化结果，不抛。 */
async function verify(sessdata, { timeoutMs = 12_000 } = {}) {
    let response;
    try {
        response = await fetch(NAV_URL, {
            // 校验时不带旧会话的 bili_jct，避免新 SESSDATA 与旧 csrf 混用。
            headers: apiHeaders(await cookieHeader(sessdata, { csrf: false })),
            signal: AbortSignal.timeout(timeoutMs),
        });
    }
    catch (error) {
        return { ok: false, reason: 'network', code: 0, error: '连不上 B 站 nav：' + String(error?.message ?? error), refreshed: null };
    }
    if (response.status === 412 || response.status === 429)
        return { ok: false, reason: 'network', code: 0, error: 'B 站风控拦截（HTTP ' + response.status + '），稍后再试', refreshed: null };
    const text = await response.text();
    let body;
    try {
        body = JSON.parse(text);
    }
    catch {
        return { ok: false, reason: 'network', code: 0, error: 'B 站 nav 返回非 JSON（HTTP ' + response.status + '）', refreshed: null };
    }
    const refreshed = pickRefreshedSessdata(response);
    if (Number(body?.code ?? 0) !== 0) {
        const code = Number(body?.code ?? 0);
        const message = String(body?.message ?? '');
        return {
            ok: false,
            // 只有 -101 才代表「登录态失效」；其它 code 不据此判死刑，避免误杀。
            reason: code === -101 ? 'auth' : 'other',
            code,
            error: code === -101
                ? '-101 账号未登录：SESSDATA 已失效或过期'
                : 'B 站返回 ' + code + (message === '' ? '' : '：' + message),
            refreshed,
        };
    }
    const data = body?.data ?? {};
    if (data.isLogin !== true) {
        return { ok: false, reason: 'auth', code: -101, error: '-101 账号未登录：B 站判定当前 cookie 不是有效登录态', refreshed };
    }
    return {
        ok: true,
        reason: 'ok',
        mid: Number(data.mid ?? 0) || null,
        uname: String(data.uname ?? ''),
        level: Number(data.level_info?.current_level ?? 0) || 0,
        vip: Number(data.vipStatus ?? 0) > 0,
        refreshed,
    };
}

function anonymousView() {
    return {
        bound: false,
        status: 'anonymous',
        mid: null,
        uname: '',
        level: 0,
        vip: false,
        masked: '—',
        updatedAt: '',
        checkedAt: '',
        error: '',
        note: '未绑定：按未登录取流，画质上限 720p',
    };
}

function view(doc) {
    const ok = doc.status === 'ok';
    return {
        bound: true,
        status: ok ? 'ok' : 'invalid',
        mid: doc.mid ?? null,
        uname: doc.uname ?? '',
        level: Number(doc.level ?? 0) || 0,
        vip: doc.vip === true,
        masked: maskSessdata(doc.sessdata),
        updatedAt: doc.updatedAt ?? '',
        checkedAt: doc.checkedAt ?? '',
        error: ok ? '' : String(doc.error ?? 'SESSDATA 已失效'),
        note: ok ? '已绑定：取流带 SESSDATA' : 'SESSDATA 已失效，已降级为未登录（720p）',
    };
}

/** 给 bili.mjs 用：只在 status=ok 时返回完整 cookie 头（SESSDATA + bili_jct + 指纹 cookie）。 */
export async function cookieHeaderValue() {
    const doc = await readDoc();
    if (doc === null || doc.status !== 'ok' || doc.sessdata === '')
        return null;
    return cookieHeader(doc.sessdata);
}

/** 只读状态（不发网络请求），用于请求头与 manifest。 */
export async function currentAccount() {
    const doc = await readDoc();
    return doc === null ? anonymousView() : view(doc);
}

/**
 * 返回可用账号；cookie 过期/失效时先重验一次，失败就落盘 invalid 并降级。
 * 永不抛错，网络问题也只是返回 invalid + error。
 */
export async function ensureAccount() {
    const doc = await readDoc();
    if (doc === null)
        return anonymousView();
    if (doc.status === 'ok' && Date.now() - Date.parse(doc.checkedAt) < VERIFY_TTL_MS)
        return view(doc);
    return refresh(doc, doc.sessdata);
}

async function refresh(doc, sessdata) {
    const result = await verify(sessdata);
    const now = new Date().toISOString();
    if (result.ok) {
        const next = {
            ...doc,
            sessdata: result.refreshed ?? sessdata,
            updatedAt: now,
            checkedAt: now,
            status: 'ok',
            mid: result.mid,
            uname: result.uname,
            level: result.level,
            vip: result.vip,
            error: '',
        };
        await writeDoc(next).catch(() => undefined);
        return view(next);
    }
    // 网络/风控失败不判失效：保留上次状态，避免一次抖动就把好好的账号降级。
    if (result.reason !== 'auth')
        return { ...view(doc), warning: '账号校验未完成：' + result.error };
    const next = { ...doc, checkedAt: now, status: 'invalid', error: result.error };
    await writeDoc(next).catch(() => undefined);
    return view(next);
}

/** 面板轮询：fresh=false 用缓存；fresh=true 强制问一次 B 站。 */
export async function accountStatus({ fresh = false } = {}) {
    const doc = await readDoc();
    if (doc === null)
        return anonymousView();
    if (!fresh) {
        if (doc.status === 'invalid')
            return view(doc);
        if (Date.now() - Date.parse(doc.checkedAt) < VERIFY_TTL_MS)
            return view(doc);
    }
    return refresh(doc, doc.sessdata);
}

/** 绑定：先验证再落盘；验证失败直接报错，不保存、不冒充已登录。 */
export async function bindAccount(raw) {
    const sessdata = normalizeSessdata(raw);
    const result = await verify(sessdata);
    if (!result.ok)
        throw new Error(result.error);
    const now = new Date().toISOString();
    const doc = {
        sessdata: result.refreshed ?? sessdata,
        updatedAt: now,
        checkedAt: now,
        status: 'ok',
        mid: result.mid,
        uname: result.uname,
        level: result.level,
        vip: result.vip,
        error: '',
    };
    await writeDoc(doc);
    return view(doc);
}

export async function unbindAccount() {
    await rm(BILI_ACCOUNT_PATH, { force: true });
    cache = { at: Date.now(), doc: null };
}

/** bili.mjs 在带 cookie 的请求被判 -101 时调用：明确标记失效并停止带 cookie。 */
export async function markInvalid(reason) {
    const doc = await readDoc();
    if (doc === null || doc.status === 'invalid')
        return;
    const next = {
        ...doc,
        status: 'invalid',
        error: String(reason ?? '账号未登录'),
        checkedAt: new Date().toISOString(),
    };
    await writeDoc(next).catch(() => undefined);
}
