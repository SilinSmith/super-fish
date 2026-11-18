/**
 * 视频库写入：一行一条，同一 bvid 只保留第一次入库的那条。
 * 回填与补课都走这里，避免同一条视频被不同路径重复写进 bili-library.jsonl。
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOME = 'Y:\\dsh\\home\\qq-persona';
export const LIBRARY_PATH = process.env.QQ_BILI_LIBRARY ?? join(HOME, 'bili-library.jsonl');

let index = null;

function loadIndex() {
    if (index !== null)
        return index;
    index = new Set();
    if (existsSync(LIBRARY_PATH)) {
        for (const line of readFileSync(LIBRARY_PATH, 'utf8').split('\n')) {
            const trimmed = line.trim();
            if (trimmed === '')
                continue;
            try {
                const row = JSON.parse(trimmed);
                if (typeof row?.bvid === 'string' && row.bvid !== '')
                    index.add(row.bvid);
            }
            catch {
                // 坏行忽略，不影响其它记录
            }
        }
    }
    return index;
}

/** 返回 true 表示真的写进去了；已存在（同 bvid）返回 false，不重复追加。 */
export function appendLibraryRow(row) {
    const bvid = typeof row?.bvid === 'string' ? row.bvid : '';
    const seen = loadIndex();
    if (bvid !== '' && seen.has(bvid))
        return false;
    appendFileSync(LIBRARY_PATH, JSON.stringify(row) + '\n', 'utf8');
    if (bvid !== '')
        seen.add(bvid);
    return true;
}
