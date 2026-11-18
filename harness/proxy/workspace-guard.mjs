/**
 * QQ 链路工作区围栏（proxy 侧尽力拦截）。
 *
 * 宿主侧的硬边界是 sandbox-write：会话 cwd（Y:\dsh\home\qq）内的写/编辑/子进程写
 * 由 dsh-fs-sandbox + sandbox-windows-acl 强制，越界会返回 FS_SANDBOX_DENIED。
 * 但宿主明确「reads pass through」——read/glob/grep 能读到根外任意文件，桌面类
 * 工具也不受工作区约束。这里补的是宿主给不了的那半边：在 tool_call 下发回宿主
 * 之前判定路径，越界就丢掉这个 call（丢掉=宿主不会执行），并给出一行可审计的日志。
 *
 * 只约束「宿主下发的通用工具」：qq_* 是 persona 自己的工具，read_image 读的是
 * 插件下载到 media 目录的群图，二者本来就在根外工作，不在围栏管辖范围。
 */
import { resolve, sep } from 'node:path';

export const WORKSPACE_ROOT = process.env.QQ_WORKSPACE_ROOT ?? 'Y:\\dsh\\home\\qq';

/** 不在围栏管辖内的工具：persona 自有工具 + 群图读取。 */
const EXEMPT_RE = /^qq_/u;
const EXEMPT_TOOLS = new Set(['read_image', 'memory_search']);

/** 参数里可能是路径的字段名。 */
const PATH_FIELDS = new Set([
    'path', 'paths', 'file', 'files', 'file_path', 'filepath', 'filename',
    'dir', 'directory', 'cwd', 'workdir', 'root', 'target', 'source',
    'destination', 'from', 'to', 'pattern', 'glob', 'include', 'exclude',
]);

/** 命令类字段：整串当命令行扫。 */
const COMMAND_FIELDS = new Set(['command', 'cmd', 'script', 'shell', 'powershell']);
const COMMAND_TOOLS = new Set(['pwsh', 'workflow', 'shell', 'bash']);

/** 绝对路径：盘符（C:\ / C:/）或 UNC（\\host\share）。 */
const ABS_PATH_RE = /(?:[A-Za-z]:[\\/]|\\\\[^\\\s"';|&<>()]+\\[^\s"';|&<>()]*)[^\s"';|&<>()]*/gu;
/** 相对上跳：以 ..\ 或 ../ 开头的一段。 */
const DOTDOT_RE = /(?:^|[\s"'=:(])((?:\.\.[\\/])+[^\s"';|&<>()]*)/gu;
/** 需要环境展开才落地的路径：一律视为越界（无法静态确认落在根内）。 */
const EXPANDING_RE = /(?:^|[\s"'=:(])(?:~[\\/]|%[A-Za-z_][A-Za-z0-9_]*%|\$env:|\$\{)/u;

const ROOT_NORM = resolve(WORKSPACE_ROOT).toLowerCase();
const ROOT_PREFIX = ROOT_NORM.endsWith(sep) ? ROOT_NORM : ROOT_NORM + sep;

/** 相对路径按会话 cwd（= 工作区根）解析；绝对路径按原样解析。 */
export function resolveUnderRoot(path) {
    return resolve(WORKSPACE_ROOT, path);
}

export function insideRoot(path) {
    if (typeof path !== 'string' || path.trim() === '')
        return true;
    const target = resolveUnderRoot(path.trim()).toLowerCase();
    return target === ROOT_NORM || target.startsWith(ROOT_PREFIX);
}

/** 命令行串扫描：任一绝对路径 / 上跳 / 需展开的变量在根外，就算违规。 */
function commandViolation(text) {
    if (EXPANDING_RE.test(text))
        return text.match(EXPANDING_RE)?.[0]?.trim() ?? '<expansion>';
    for (const match of text.matchAll(ABS_PATH_RE)) {
        const candidate = match[0].replace(/[\\/]+$/u, '');
        if (candidate.length <= 2 || /^[A-Za-z]:$/u.test(candidate))
            continue;
        if (!insideRoot(candidate))
            return candidate;
    }
    for (const match of text.matchAll(DOTDOT_RE)) {
        const candidate = match[1];
        if (!insideRoot(candidate))
            return candidate;
    }
    return null;
}

function walkStrings(value, field, visit, depth = 0) {
    if (depth > 4 || value === null || typeof value !== 'object')
        return;
    for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'string') {
            visit(key.toLowerCase(), item);
            continue;
        }
        if (Array.isArray(item)) {
            for (const element of item) {
                if (typeof element === 'string')
                    visit(key.toLowerCase(), element);
                else
                    walkStrings(element, key, visit, depth + 1);
            }
            continue;
        }
        walkStrings(item, key, visit, depth + 1);
    }
}

/**
 * 判定一个 tool_call 是否越界。
 * @returns {string|null} 被拒的路径；null 表示放行。
 */
export function workspaceViolation(call) {
    const name = call?.function?.name;
    if (typeof name !== 'string' || name === '')
        return null;
    if (EXEMPT_RE.test(name) || EXEMPT_TOOLS.has(name))
        return null;
    let args;
    try {
        args = JSON.parse(String(call.function.arguments ?? '{}'));
    }
    catch {
        return null; // 参数不是合法 JSON 时交给宿主报错，不在这里猜
    }
    if (args === null || typeof args !== 'object')
        return null;
    let violation = null;
    walkStrings(args, '', (field, value) => {
        if (violation !== null)
            return;
        if (COMMAND_FIELDS.has(field) || (COMMAND_TOOLS.has(name) && field === 'arguments')) {
            violation = commandViolation(value);
            return;
        }
        if (!PATH_FIELDS.has(field))
            return;
        if (EXPANDING_RE.test(value)) {
            violation = value.trim();
            return;
        }
        if (!insideRoot(value))
            violation = value.trim();
    });
    return violation;
}
