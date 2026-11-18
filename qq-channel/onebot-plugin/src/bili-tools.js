/**
 * B 站工具：只做「选内容 / 看画面」，不发送任何 QQ 消息。
 * 画面理解由 vision.mjs 打标后写入 vision-state，下一轮自然注入。
 */
const BILI_MODULE = new URL('../../../harness/proxy/bili.mjs', import.meta.url).href;
const BILI_PROACTIVE_MODULE = new URL('../../../harness/proxy/bili-proactive.mjs', import.meta.url).href;

function clock(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}

export async function registerBiliTools({ ctx, log = () => undefined, resolveChatId } = {}) {
    if (ctx?.tools?.register === undefined)
        return;
    const disposers = [];
    let defineTool;
    try {
        ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
    }
    catch {
        try {
            // 全局 npm 安装的 DSH tools；必要时用 DSH_TOOLS_ENTRY 指定绝对路径。
            const fallback = process.env.DSH_TOOLS_ENTRY
                || 'file:///C:/Users/user/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
            ({ defineTool } = await import(fallback));
        }
        catch (error) {
            log('warn', 'B站工具未注册：defineTool 不可用 ' + String(error?.message ?? error));
            return;
        }
    }
    const bili = await import(BILI_MODULE);

    const sceneOf = (exec) => {
        try {
            const resolved = resolveChatId?.(exec);
            if (typeof resolved === 'string' && resolved !== '')
                return resolved;
        }
        catch {
            // 解析失败就退化为本地场景，不影响取画面
        }
        return 'bili:local';
    };

    // 观看记录里的「谁触发的」：工具上下文只有 sessionId，没有 QQ 发送者，所以记到群/会话级。
    const triggerOf = exec => sceneOf(exec);

    const accountLine = (value) => {
        const account = value?.account;
        if (account?.status === 'ok')
            return '身份：已登录 · ' + (account.uname || '未知') + '（mid ' + (account.mid ?? '—') + '）';
        if (account?.status === 'invalid')
            return '身份：SESSDATA 已失效，本次已降级为未登录（720p）' + (account.error ? ' · ' + account.error : '');
        return '身份：未登录（720p 上限）';
    };

    const register = (tool) => {
        try {
            disposers.push(ctx.tools.register(tool));
        }
        catch (error) {
            log('warn', 'B站工具注册失败 ' + tool.name + ': ' + String(error?.message ?? error));
        }
    };

    register(defineTool({
        name: 'qq_bili_feed',
        description: '刷 B 站：取热门/排行/搜索候选视频清单（标题、UP 主、播放量、BV 号）。'
            + '用户说“刷会儿B站/找点视频看/搜某个主题”时先调这个，再决定要不要用 qq_bili_watch 看具体一条。',
        parameters: {
            kind: {
                type: 'string',
                enum: ['hot', 'rank', 'search'],
                description: 'hot=综合热门（默认），rank=排行榜，search=按关键词搜索',
            },
            query: { type: 'string', description: 'kind=search 时的关键词' },
            limit: { type: 'number', description: '返回几条，默认 6，最多 12' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => {
                const v = value;
                if (v === null || typeof v !== 'object' || !Array.isArray(v.items) || v.items.length === 0)
                    return [{ type: 'text', text: '这次没刷到可看的视频。' }];
                const lines = ['B 站候选（' + v.kind + '，按偏好权重排序）:'];
                for (const item of v.items)
                    lines.push('- 《' + item.title + '》 ' + item.bvid
                        + ' · ' + (item.owner || '未知UP') + ' · ' + clock(item.duration)
                        + ' · ' + Math.round(Number(item.play) / 10000) + '万播放');
                lines.push('', '想看哪条就调 qq_bili_watch，ref 传 BV 号。');
                return [{ type: 'text', text: lines.join('\n') }];
            },
        },
        isConcurrencySafe: () => false,
        execute: async (args) => bili.feed({
            kind: String(args?.kind ?? 'hot'),
            query: String(args?.query ?? ''),
            limit: Number(args?.limit) || 6,
        }),
    }));

    register(defineTool({
        name: 'qq_bili_watch',
        description: '看一条 B 站视频：拉 720p 流，只解关键帧作为基线，对可疑 GOP 定点做场景检测补齐切镜，'
            + '最多 12 帧。帧路径用 read_image 逐张查看；画面摘要会自动进入你下一轮看到的上下文，不用复述。'
            + '用户给 BV 号/av 号/b23 短链时说“看看这个”就用本工具。',
        parameters: {
            ref: { type: 'string', required: true, description: 'BV 号、av 号、b23 短链或 B 站视频链接' },
            max_frames: { type: 'number', description: '最多保留几帧，默认 12，上限 12' },
            observe: { type: 'boolean', description: '是否把画面交给后台视觉打标，默认 true' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => {
                const v = value;
                if (v === null || typeof v !== 'object' || !Array.isArray(v.frames))
                    return [{ type: 'text', text: '没看成这条视频。' }];
                const lines = [
                    '《' + v.title + '》 ' + v.bvid + ' · ' + clock(v.duration)
                        + ' · 源 ' + Math.round(Number(v.videoBytes) / 1024 / 1024) + 'MB'
                        + ' · ' + (v.videoProbe?.width ?? '?') + 'x' + (v.videoProbe?.height ?? '?'),
                    accountLine(v),
                    '关键帧 ' + v.gop?.keyframes + ' 个（平均 GOP ' + v.gop?.avgSec + 's），'
                        + '检查可疑 GOP ' + v.rescue?.gopsChecked + ' 个，场景命中 ' + v.rescue?.sceneHits
                        + ' 次，救回切镜 ' + v.rescue?.kept + ' 帧'
                        + '（仅关键帧会漏 ' + v.rescue?.missedByKeyframeOnly + ' 个）',
                    '耗时 ' + (Math.round(Number(v.timing?.total) / 100) / 10) + 's，保留 ' + v.frames.length + ' 帧：',
                ];
                for (const frame of v.frames)
                    lines.push(clock(frame.at) + ' [' + frame.why + '] [图片:' + frame.path + ']');
                if (v.contextual?.ok === true)
                    lines.push('', '接话时如果自然，可以提一句：' + v.contextual.text);
                lines.push('', '先读 2-3 张判断内容，别把 12 张全读一遍；聊到画面细节再补读。');
                return [{ type: 'text', text: lines.join('\n') }];
            },
        },
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const ref = String(args?.ref ?? '').trim();
            if (ref === '')
                throw new Error('qq_bili_watch: ref 必填（BV 号或链接）');
            const watched = await bili.watch(ref, {
                chatId: sceneOf(exec),
                maxFrames: Number(args?.max_frames) || 12,
                observe: args?.observe !== false,
                triggeredBy: triggerOf(exec),
            });
            // 复用同一条 share 构造做「对话中带出」，只记上下文提及，不发消息。
            let contextual = null;
            try {
                const { mentionWatched } = await import(BILI_PROACTIVE_MODULE);
                contextual = await mentionWatched(watched, {
                    relevance: '用户在对话里要求看这条视频（ref=' + ref + '）',
                });
            }
            catch (error) {
                log('warn', 'B站上下文提及失败 ' + String(error?.message ?? error));
            }
            return { ...watched, contextual };
        },
    }));

    return () => {
        for (const dispose of disposers.reverse()) {
            try {
                dispose?.();
            }
            catch {
                // 卸载时的清理失败不影响退出
            }
        }
    };
}
