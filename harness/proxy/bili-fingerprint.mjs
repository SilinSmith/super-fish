/**
 * B 站浏览器指纹对齐：请求头 + 非登录类 cookie。
 *
 * 目的：让所有请求看起来与用户本机 Edge 一致，避免「自定义 UA + 无 buvid」的裸客户端特征。
 * 约束：
 * - 额外 cookie 只从用户提供的 bili-cookies.json 读取，取不到就留空，绝不生成随机值。
 * - SESSDATA / bili_jct 仍由账号与 csrf 文件单独提供；本模块只负责拼装，不落盘明文。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const HOME = 'Y:\\dsh\\home\\qq-persona';
export const COOKIE_EXTRAS_PATH = process.env.QQ_BILI_COOKIES ?? join(HOME, 'bili-cookies.json');
export const CSRF_PATH = process.env.QQ_BILI_CSRF_PATH ?? join(HOME, 'bili-csrf.json');

// 与本机安装的 Microsoft Edge 保持一致（157.0.4341.46）。
const EDGE_FULL = '157.0.4341.46';
const EDGE_MAJOR = '157';
const CHROME_MAJOR = '157';
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/' + CHROME_MAJOR + '.0.0.0 Safari/537.36 Edg/' + EDGE_FULL;

// 浏览器会带的客户端提示头；写死与本机 Edge 一致的品牌顺序。
const CLIENT_HINTS = {
    'sec-ch-ua': '"Microsoft Edge";v="' + EDGE_MAJOR + '", "Chromium";v="' + CHROME_MAJOR + '", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
};

/** 非登录类指纹 cookie：只带这些名字，其它一律忽略。 */
export const EXTRA_COOKIE_NAMES = ['buvid3', 'buvid4', '_uuid', 'b_nut', 'bili_ticket'];

let extrasCache = { at: 0, map: new Map() };

function parseCookieString(text) {
    const map = new Map();
    for (const part of String(text ?? '').split(';')) {
        const index = part.indexOf('=');
        if (index <= 0)
            continue;
        const name = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        if (name !== '' && value !== '')
            map.set(name, value);
    }
    return map;
}

/** 读用户提供的完整 cookie 串（或对象），只取指纹相关的几项。 */
export async function extraCookies() {
    if (Date.now() - extrasCache.at < 5_000)
        return extrasCache.map;
    let map = new Map();
    try {
        const parsed = JSON.parse(await readFile(COOKIE_EXTRAS_PATH, 'utf8'));
        const source = typeof parsed?.cookie === 'string'
            ? parseCookieString(parsed.cookie)
            : new Map(Object.entries(parsed ?? {}).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, value]));
        for (const name of EXTRA_COOKIE_NAMES) {
            const value = source.get(name);
            if (typeof value === 'string' && value !== '')
                map.set(name, value);
        }
    }
    catch {
        map = new Map();
    }
    extrasCache = { at: Date.now(), map };
    return map;
}

/** bili_jct：写操作要用；只读请求也带上，和浏览器保持一致。 */
export async function csrfToken() {
    const fromEnv = String(process.env.QQ_BILI_CSRF ?? '').trim();
    if (fromEnv !== '')
        return fromEnv;
    try {
        const parsed = JSON.parse(await readFile(CSRF_PATH, 'utf8'));
        return String(parsed?.bili_jct ?? '').trim();
    }
    catch {
        return '';
    }
}

/** 组装 cookie 头：SESSDATA → bili_jct → 指纹 cookie。缺失项直接跳过。 */
export async function cookieHeader(sessdata, { csrf = true } = {}) {
    const pairs = [];
    if (String(sessdata ?? '') !== '')
        pairs.push('SESSDATA=' + sessdata);
    const jct = csrf ? await csrfToken() : '';
    if (jct !== '')
        pairs.push('bili_jct=' + jct);
    for (const [name, value] of await extraCookies())
        pairs.push(name + '=' + value);
    return pairs.join('; ');
}

/** API（XHR/fetch）请求头，形如浏览器自己发的 JSON 请求。 */
export function apiHeaders(cookie) {
    const headers = {
        'user-agent': UA,
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        origin: 'https://www.bilibili.com',
        referer: 'https://www.bilibili.com/',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-site',
        ...CLIENT_HINTS,
    };
    if (typeof cookie === 'string' && cookie !== '')
        headers.cookie = cookie;
    return headers;
}

/** 媒体/字幕/CDN 请求头：浏览器的图片、视频、字幕拉取。 */
export function mediaHeaders(cookie) {
    const headers = {
        'user-agent': UA,
        accept: '*/*',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        origin: 'https://www.bilibili.com',
        referer: 'https://www.bilibili.com/',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'cross-site',
        ...CLIENT_HINTS,
    };
    if (typeof cookie === 'string' && cookie !== '')
        headers.cookie = cookie;
    return headers;
}

/** 跳转短链时的文档请求头。 */
export function navigateHeaders() {
    return {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        ...CLIENT_HINTS,
    };
}
