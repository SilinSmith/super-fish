/**
 * UP 投稿列表：App 端 cursor 接口（匿名可用，避免网页 space 接口的 412/-352）。
 * 回填和主动刷共用，避免两处各写一份签名逻辑。
 */
import { createHash } from 'node:crypto';

// 签名参数不随仓库分发：B 站 App 端的 appkey/appsecret 属于第三方凭据，
// 需要自己从公开客户端参数或自己的配置里取得，用环境变量注入。
const APPKEY = String(process.env.QQ_BILI_APPKEY ?? '');
const APP_SECRET = String(process.env.QQ_BILI_APP_SECRET ?? '');
const APP_UA = 'Mozilla/5.0 BiliDroid/7.81.0 (bbcallen@gmail.com) os/android';

export function appQuery(params) {
    const merged = { ...params, appkey: APPKEY, ts: Math.floor(Date.now() / 1000) };
    const sorted = Object.keys(merged).sort().map(key => key + '=' + encodeURIComponent(merged[key])).join('&');
    merged.sign = createHash('md5').update(sorted + APP_SECRET).digest('hex');
    return Object.keys(merged).map(key => key + '=' + encodeURIComponent(merged[key])).join('&');
}

/**
 * 拉一个 UP 近 N 天的投稿（20 条一页，按发布时间倒序）。
 * 任何失败返回 {ok:false, reason}，不抛；调用方按来源降级。
 */
export async function listUploads(mid, { days = 7, ps = 20, pages = 6, timeoutMs = 20_000 } = {}) {
    const since = Date.now() - days * 24 * 3600_000;
    const items = [];
    let cursor = '';
    let page = 0;
    for (page = 1; page <= pages; page += 1) {
        const query = appQuery({
            vmid: mid,
            order: 'pubdate',
            ps,
            mobi_app: 'android',
            platform: 'android',
            build: 7810200,
            ...(cursor === '' ? {} : { aid: cursor }),
        });
        let data;
        try {
            const response = await fetch('https://app.bilibili.com/x/v2/space/archive/cursor?' + query, {
                headers: { 'user-agent': APP_UA, appkey: APPKEY, mobi_app: 'android' },
                signal: AbortSignal.timeout(timeoutMs),
            });
            data = await response.json();
        }
        catch (error) {
            return { ok: items.length > 0, items, reason: String(error?.message ?? error), pages: page - 1 };
        }
        if (data?.code !== 0)
            return { ok: items.length > 0, items, reason: 'code ' + data?.code + ' ' + (data?.message ?? ''), pages: page - 1 };
        let reachedOld = false;
        for (const row of data?.data?.item ?? []) {
            const created = Number(row.ctime ?? 0) * 1000;
            if (created < since) {
                reachedOld = true;
                continue;
            }
            if (!/^BV[0-9A-Za-z]{10}$/u.test(String(row.bvid ?? '')))
                continue;
            items.push({
                bvid: String(row.bvid),
                title: String(row.title ?? ''),
                owner: String(row.author ?? ''),
                mid: Number(mid),
                pubdate: new Date(created).toISOString(),
                duration: Number(row.duration ?? 0),
                play: Number(row.play ?? 0),
                videos: Number(row.videos ?? 1),
            });
        }
        cursor = String(data?.data?.next_cursor ?? '');
        if (reachedOld || data?.data?.has_next !== true || cursor === '')
            break;
        await new Promise(resolve => setTimeout(resolve, 1_200));
    }
    return { ok: true, items, reason: '', pages: page };
}
