import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 极简 JSONL 日志：一行一个 JSON，便于后面影子比对脚本直接解析。
 * 不依赖宿主 logger，避免 S0 阶段被宿主日志级别吞掉。
 */
export function createLogger(path) {
    try {
        mkdirSync(dirname(path), { recursive: true });
    }
    catch {
        // 目录已存在或不可写：后续 append 也会失败，但插件不能因此崩掉
    }
    return function log(level, message, data) {
        const line = JSON.stringify({
            ts: new Date().toISOString(),
            level,
            message,
            ...(data === undefined ? {} : { data }),
        });
        try {
            appendFileSync(path, line + '\n', 'utf8');
        }
        catch {
            // ignore
        }
        if (level === 'error')
            console.error('[qq-onebot] ' + message, data ?? '');
    };
}
