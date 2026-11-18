/**
 * QQ 工具目录：给“按需加载”用。
 *
 * 默认只常驻一小组工具，其余工具由模型通过
 * qq_tool(action="load", names=[...]) 在需要时打开，下一步即可调用。
 *
 * 三份数据分开放，互不漂移：
 * - 本文件：33 个 qq_* 工具的一行文案 + 分组；
 * - tool-catalog.host.json：宿主/预设工具的一行文案（从 request/header 生成）；
 * - tool-resident.json：常驻白名单与加载上限（可直接改，不用改代码）。
 */
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const ROOT = process.env.QQ_PROXY_ROOT ?? 'Y:\\dsh\\home\\qq-persona';
const RESIDENT_PATH = join(ROOT, 'tool-resident.json');
const HOST_CATALOG_PATH = join(ROOT, 'tool-catalog.host.json');

/* ------------------------------------------------------------------ */
/* 可用性单一事实源：和插件注册层（tools.js）读同一组文件。            */
/* 常驻清单、目录总表、load 校验都过这一道，避免“清单里有名字、实际   */
/* 没注册”。恢复停用工具只改 write-tools.json / stickers.json。        */
/* ------------------------------------------------------------------ */
const WRITE_TOOLS_PATH = join(ROOT, 'write-tools.json');
const STICKERS_PATH = join(ROOT, 'stickers.json');
const WRITE_TOOL_NAMES = new Set(['qq_qzone_post', 'qq_qzone_like', 'qq_qzone_extra', 'qq_napcat_api']);
const AVAILABILITY_TTL_MS = 5_000;
let availabilityCache = { at: 0, value: { write: {}, stickers: false } };

function readJsonSync(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return undefined;
    }
}

function availabilityConfig() {
    if (Date.now() - availabilityCache.at < AVAILABILITY_TTL_MS)
        return availabilityCache.value;
    const write = readJsonSync(WRITE_TOOLS_PATH) ?? {};
    const stickers = readJsonSync(STICKERS_PATH) ?? {};
    availabilityCache = {
        at: Date.now(),
        value: { write, stickers: stickers.enabled === true },
    };
    return availabilityCache.value;
}

/** 工具是否真的注册了：贴纸看 stickers.enabled，四个写工具看 write-tools.json。 */
export function toolAvailable(name) {
    if (typeof name !== 'string' || name === '')
        return false;
    const { write, stickers } = availabilityConfig();
    if (name === 'qq_send_sticker')
        return stickers;
    if (!WRITE_TOOL_NAMES.has(name))
        return true;
    if (write.enabled !== true)
        return false;
    // 单工具粒度：tools 里点名了就按它，未点名沿用“总开关开=可用”。
    const perTool = write.tools;
    if (perTool !== null && typeof perTool === 'object' && Object.hasOwn(perTool, name) && perTool[name] !== true)
        return false;
    return name === 'qq_napcat_api' ? write.napcatApi === true : true;
}

/** 内置兜底：tool-resident.json 读不到时用这 10 个。 */
export const BASE_TOOLS = [
    'qq_tool',
    'qq_draw',
    'qq_notebook',
    'memory_search',
    'qq_send_image',
    'qq_at',
    'qq_react',
    'qq_send_sticker',
    'qq_poke',
    'read_image',
];

/** 关闭按需注入时（enabled=false）退回旧的 17 个常驻。 */
export const LEGACY_BASE_TOOLS = [
    'qq_send_image',
    'qq_notebook',
    'qq_task',
    'qq_draw',
    'qq_image_review',
    'qq_tool',
    'read_image',
    'qq_poke',
    'qq_qzone_feed',
    'qq_qzone_like',
    'qq_qzone_post',
    'qq_group_query',
    'qq_group_file',
    'qq_group_album',
    'qq_profile',
    'qq_qzone_extra',
    'qq_read_video',
];

/** name -> 一行说明（干什么；什么时候用）。 */
export const TOOL_GROUPS = {
    resident: {
        label: '常驻（不用加载）',
        tools: {
            'qq_tool': '加载/查看工具；需要名单里没常驻的工具时',
            'qq_draw': '本地画图并直接发出；只有对方明确要一张图时',
            'qq_send_image': '发本地图片或 URL；要发图时',
            'qq_notebook': '长期记忆 add/read/search；要记或要回忆时',
            'memory_search': '长期记忆检索；问旧事/旧约定前先查，别凭空猜',
            'qq_at': '群里 @ 某人；要专门叫某人时',
            'qq_send_sticker': '按情绪发表情包；文字不够时',
            'qq_poke': '拍一拍；想戳对方时',
        },
    },
    chat: {
        label: '群聊互动',
        tools: {
            'qq_react': '给已有消息贴表情；只是补充反应，不能代替发言',
            'qq_group_history': '读群聊历史；要补上下文时',
        },
    },
    media: {
        label: '语音/文件',
        tools: {
            'qq_send_voice': '发语音；想用声音说话时',
            'qq_send_tts': '文字转语音发送；要把话读出来时',
            'qq_send_video': '发视频；主人要视频时',
            'qq_send_file': '发文件；主人要文件时',
            'qq_send_forward': '合并转发聊天记录；要转述一段对话时',
            'qq_ask_image': '在群里要一张图；想看对方发图时',
            'qq_bili_feed': '刷 B 站候选（热门/排行/搜索）；想找点视频看时',
            'qq_bili_watch': '看一条 B 站视频并抽帧；用户给 BV 号说“看看这个”时',
        },
    },
    memory: {
        label: '角色与记忆',
        tools: {
            'qq_character_note': '记心情/承诺/角色记忆；有值得留的角色痕迹时',
            'qq_diary': '写今天的日记；一天结束想留笔时',
            'qq_request_master': '向主人请求权限/功能/修复；自己搞不定时',
        },
    },
    owner: {
        label: '主人只读/高级',
        tools: {
            'qq_qzone_feed': '刷好友动态；主人让看空间时',
            'qq_qzone_like': '空间点赞/取消；主人要赞时',
            'qq_qzone_post': '发空间说说；主人让发动态时',
            'qq_qzone_extra': '查空间资料/说说/评论；主人要细看空间时',
            'qq_group_query': '查群资料/成员/公告/精华；主人要查群时',
            'qq_group_file': '群文件目录/下载链接；主人要文件时',
            'qq_group_album': '群相册/媒体列表；主人要看相册时',
            'qq_profile': '好友/分组/最近联系人/收藏表情；主人要查人时',
            'qq_image_review': '待发图片队列审批；主人私聊管图时',
            'qq_task': '跨轮任务 add/update/done/list；多步或跨轮的事',
            'qq_read_video': '读聊天视频（抽帧+看图）；要理解视频时',
            'qq_napcat_api': '调白名单 NapCat API；主人明确要求时',
        },
    },
};

/** name -> 一行说明（只含 qq_* 工具）。 */
export const TOOL_CATALOG = (() => {
    const catalog = {};
    for (const group of Object.values(TOOL_GROUPS))
        Object.assign(catalog, group.tools);
    return catalog;
})();

/* ------------------------------------------------------------------ */
/* 配置读取：5 秒缓存，改文件不用重启进程。                            */
/* ------------------------------------------------------------------ */
function cachedReader(path, ttlMs, parse) {
    let at = 0;
    let value;
    return async () => {
        if (value !== undefined && Date.now() - at < ttlMs)
            return value;
        try {
            value = parse(JSON.parse(await readFile(path, 'utf8')));
        }
        catch {
            value = parse(undefined);
        }
        at = Date.now();
        return value;
    };
}

/** 内置兜底限制：tool-resident.json 没写 limits 时用这组，别处不再各写一份。 */
export const DEFAULT_LIMITS = Object.freeze({
    maxNamesPerCall: 3,
    maxLoadsPerTurn: 2,
    loadWindowMs: 90_000,
});

function parseResidentConfig(parsed) {
    // 以 tool-resident.json 为准：文件在就照它（空数组也算“没常驻”），
    // 只有文件缺失/解析失败才退回 BASE_TOOLS，并标明来源。
    const fromFile = parsed !== undefined;
    const resident = (fromFile
        ? (Array.isArray(parsed?.resident) ? parsed.resident.filter(name => typeof name === 'string') : [])
        : BASE_TOOLS).filter(toolAvailable);
    const limits = parsed?.limits && typeof parsed.limits === 'object' ? parsed.limits : {};
    return {
        enabled: parsed?.enabled !== false,
        resident,
        source: fromFile ? 'tool-resident.json' : 'BASE_TOOLS',
        limits: {
            maxNamesPerCall: Math.max(1, Number(limits.maxNamesPerCall) || DEFAULT_LIMITS.maxNamesPerCall),
            maxLoadsPerTurn: Math.max(1, Number(limits.maxLoadsPerTurn) || DEFAULT_LIMITS.maxLoadsPerTurn),
            loadWindowMs: Math.max(1_000, Number(limits.loadWindowMs) || DEFAULT_LIMITS.loadWindowMs),
        },
    };
}

export const readResidentConfig = cachedReader(RESIDENT_PATH, 5_000, parseResidentConfig);

/** 同步版：与 readResidentConfig 共用同一解析，供插件注册期同步建表用。 */
export function readResidentConfigSync() {
    return parseResidentConfig(readJsonSync(RESIDENT_PATH));
}

/** 当前应常驻的工具名；enabled=false 时退回旧 17 个。 */
export async function readResidentTools() {
    const config = await readResidentConfig();
    return config.enabled ? config.resident : LEGACY_BASE_TOOLS.filter(toolAvailable);
}

function parseHostCatalog(parsed) {
    const tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
    return tools
        .filter(item => typeof item?.name === 'string')
        .map(item => ({
            name: item.name,
            line: typeof item.line === 'string' ? item.line : '',
            // 显式白名单语义：只有 qqAllowed=true 的宿主工具进 QQ 链路。
            // 缺省一律拒绝，避免“从目录里删一行反而把工具放出来”的反转。
            qqAllowed: item.qqAllowed === true,
        }));
}

export const readHostCatalog = cachedReader(HOST_CATALOG_PATH, 5_000, parseHostCatalog);

/** 同步版：与 readHostCatalog 共用同一解析，供插件注册期同步建 deny 表用。 */
export function readHostCatalogSync() {
    return parseHostCatalog(readJsonSync(HOST_CATALOG_PATH));
}

/** 目录之外也没有注册能力、restrict 拦不住的宿主工具，单独硬拒。 */
export const QQ_EXPLICIT_DENY = new Set(['subagent', 'subagent_fork']);

/** 允许出现在 QQ 总表 / tools / load 里的宿主工具。 */
export async function readQQHostCatalog() {
    const host = await readHostCatalog();
    return host.filter(item => item.qqAllowed && !QQ_EXPLICIT_DENY.has(item.name));
}

/** 一律不进 QQ 链路的宿主工具名（含显式拒绝项）。显式拒绝优先于常驻。 */
export async function deniedHostToolNames() {
    const host = await readHostCatalog();
    const denied = new Set(QQ_EXPLICIT_DENY);
    for (const item of host) {
        if (!item.qqAllowed)
            denied.add(item.name);
    }
    return denied;
}

/** QQ 工具 + 白名单宿主工具，用于校验加载请求。 */
export async function catalogNames() {
    const host = await readQQHostCatalog();
    return new Set([...Object.keys(TOOL_CATALOG).filter(toolAvailable), ...host.map(item => item.name)]);
}

/** 生成给模型看的总表。 */
export async function catalogSection({ resident, loaded } = {}) {
    const residentList = Array.isArray(resident) ? resident : await readResidentTools();
    const loadedList = Array.isArray(loaded) ? loaded : [];
    const residentSet = new Set(residentList);
    const loadedSet = new Set(loadedList);
    const host = await readQQHostCatalog();
    const rows = [];
    const push = (name, line) => {
        const tag = residentSet.has(name) ? '常驻' : loadedSet.has(name) ? '已加载' : '需加载';
        rows.push({ name, line, tag });
    };
    for (const [name, line] of Object.entries(TOOL_CATALOG)) {
        if (toolAvailable(name))
            push(name, line);
    }
    for (const item of host) {
        if (item.line !== '')
            push(item.name, item.line);
    }
    // 一个都没有时不要留空标题，调用方会跳过整段。
    if (rows.length === 0)
        return '';
    // 常驻在前，其余按“需加载→已加载”排，方便模型扫。
    const order = { 常驻: 0, 需加载: 1, 已加载: 2 };
    rows.sort((a, b) => (order[a.tag] - order[b.tag]) || a.name.localeCompare(b.name));
    const lines = [
        '## 工具总表（' + rows.length + ' 个，默认只有[常驻]直接可用）',
        '[需加载] 的工具先 qq_tool(action="load", names=[...])，下一步即可调用；单次最多 3 个。',
    ];
    for (const row of rows)
        lines.push('- ' + row.name + ' [' + row.tag + ']：' + row.line);
    return lines.join('\n');
}

/** 给模型看的分组清单（qq_tool action="list"）。 */
export function catalogText() {
    const lines = [];
    for (const group of Object.values(TOOL_GROUPS)) {
        const entries = Object.entries(group.tools).filter(([name]) => toolAvailable(name));
        if (entries.length === 0)
            continue;
        lines.push('[' + group.label + ']');
        for (const [name, description] of entries)
            lines.push('- ' + name + '：' + description);
        lines.push('');
    }
    lines.push('加载方式：qq_tool(action="load", names=["qq_at","qq_react"])，下一步即可调用。');
    return lines.join('\n');
}

export function toolHelpText(name) {
    if (typeof name !== 'string' || !Object.hasOwn(TOOL_CATALOG, name) || !toolAvailable(name))
        return undefined;
    const group = Object.entries(TOOL_GROUPS).find(([, value]) => Object.hasOwn(value.tools, name));
    return name + '：' + TOOL_CATALOG[name] + '（分组：' + (group?.[1].label ?? '其他') + '）';
}

/* ------------------------------------------------------------------ */
/* 已加载工具的状态文件：qq_tool 写，proxy 读。                        */
/* 不依赖对话历史里是否保留 tool_calls，宿主裁剪历史也不会丢状态。      */
/* ------------------------------------------------------------------ */
export const ENABLED_PATH = join(ROOT, 'tool-enabled.json');
const DEFAULT_TTL_MS = 30 * 60_000;

/** 读取尚未过期的已加载工具名（自动清理过期项）。 */
export async function readEnabledTools(now = Date.now()) {
    try {
        const raw = await readFile(ENABLED_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        const names = new Set(await catalogNames());
        const resident = new Set(await readResidentTools());
        const result = [];
        for (const [name, expiresAt] of Object.entries(parsed?.names ?? {})) {
            if (!names.has(name) || resident.has(name))
                continue;
            if (Number(expiresAt) > now)
                result.push(name);
        }
        return result;
    }
    catch {
        return [];
    }
}

/** 打开一组工具（TTL 30 分钟，反复加载会续期）。 */
export async function enableTools(names, ttlMs = DEFAULT_TTL_MS) {
    const now = Date.now();
    const known = await catalogNames();
    const resident = new Set(await readResidentTools());
    const valid = (Array.isArray(names) ? names : [])
        .filter(name => typeof name === 'string' && known.has(name) && !resident.has(name));
    if (valid.length === 0)
        return [];
    let state = { names: {} };
    try {
        const parsed = JSON.parse(await readFile(ENABLED_PATH, 'utf8'));
        if (parsed && typeof parsed.names === 'object')
            state = parsed;
    }
    catch {
        // 第一次加载
    }
    for (const [name, expiresAt] of Object.entries(state.names)) {
        if (Number(expiresAt) <= now)
            delete state.names[name];
    }
    for (const name of valid)
        state.names[name] = now + Math.max(60_000, Number(ttlMs) || DEFAULT_TTL_MS);
    await mkdir(dirname(ENABLED_PATH), { recursive: true });
    const temporary = ENABLED_PATH + '.tmp';
    await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', 'utf8');
    await rename(temporary, ENABLED_PATH);
    return valid;
}
