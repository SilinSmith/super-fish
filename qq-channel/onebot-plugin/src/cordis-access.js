/**
 * 访问策略同步：影子插件不再自己维护一份群白名单。
 *
 * 真链路是 dsh-onebot-qq，它的 groupPolicy / groupAllowFrom 由 profile 的
 * cordis.patch.yml 注入；影子只做判定对照，必须用同一份输入，否则会出现
 * 「改了 A、影子按 B 拒绝」的假象。这里只解析 `- id: dsh-onebot` 这一块，
 * 不引入 YAML 依赖（插件目录不在 profile 的 node_modules 解析链里）。
 */
import { readFileSync } from 'node:fs';

export const DEFAULT_CORDIS_PATCH = 'C:\\Users\\user\\.dsh\\profiles\\desktop\\cordis.patch.yml';

/** 事实源路径：显式环境变量优先，便于换机器/换 profile。 */
export function cordisAccessSource() {
    const override = process.env.QQ_ACCESS_SOURCE;
    return typeof override === 'string' && override.trim() !== '' ? override.trim() : DEFAULT_CORDIS_PATCH;
}

function unquote(value) {
    return value.replace(/^["']|["']$/gu, '');
}

function indentOf(line) {
    return line.length - line.trimStart().length;
}

/**
 * 读取 `- id: dsh-onebot` 块里的访问策略。
 * 返回 { groupPolicy, allowGroups, source }；文件不存在或没有该块时返回 null。
 */
export function readCordisAccess(path = cordisAccessSource()) {
    let text;
    try {
        text = readFileSync(path, 'utf8');
    }
    catch {
        return null;
    }
    const lines = text.split(/\r?\n/u);
    let start = -1;
    let itemIndent = 0;
    for (let i = 0; i < lines.length; i += 1) {
        const match = /^(\s*)-\s*id:\s*dsh-onebot\s*$/u.exec(lines[i]);
        if (match === null)
            continue;
        start = i;
        itemIndent = match[1].length;
        break;
    }
    if (start === -1)
        return null;

    const result = { groupPolicy: null, allowGroups: null, source: path };
    let listIndent = -1;
    for (let i = start + 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (line.trim() === '')
            continue;
        const indent = indentOf(line);
        // 同级的下一个列表项（或更浅）就是 dsh-onebot 块的结束。
        if (indent <= itemIndent)
            break;
        if (listIndent !== -1) {
            const item = /^\s*-\s*(.+?)\s*$/u.exec(line);
            if (item !== null && indent > listIndent) {
                result.allowGroups.push(unquote(item[1]));
                continue;
            }
            listIndent = -1;
        }
        const inline = /^\s*groupAllowFrom:\s*\[(.*)\]\s*$/u.exec(line);
        if (inline !== null) {
            result.allowGroups = inline[1]
                .split(',')
                .map(item => unquote(item.trim()))
                .filter(item => item !== '');
            continue;
        }
        const block = /^\s*groupAllowFrom:\s*$/u.exec(line);
        if (block !== null) {
            result.allowGroups = [];
            listIndent = indent;
            continue;
        }
        const policy = /^\s*groupPolicy:\s*(\S+)\s*$/u.exec(line);
        if (policy !== null)
            result.groupPolicy = unquote(policy[1]);
    }
    if (result.groupPolicy === null && result.allowGroups === null)
        return null;
    return result;
}

/**
 * 把 cordis 的访问策略覆盖到已校验的配置上（就地修改 config.default.access）。
 * 返回同步信息；读不到事实源时返回 null，保留 config.json 原值。
 */
export function applyCordisAccess(config, path = cordisAccessSource()) {
    const synced = readCordisAccess(path);
    if (synced === null)
        return null;
    if (synced.groupPolicy !== null)
        config.default.access.groupPolicy = synced.groupPolicy;
    if (synced.allowGroups !== null)
        config.default.access.allowGroups = [...synced.allowGroups];
    return {
        source: path,
        groupPolicy: config.default.access.groupPolicy,
        allowGroups: [...config.default.access.allowGroups],
    };
}
