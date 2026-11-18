/**
 * ① 接入层：连 OneBot 协议端 的 OneBot 11 正向 WS，归一事件，负责重连。
 *
 * S1 仍然只读：不提供任何发送方法；只开放只读 action（get_msg / 历史 / 资料）。
 * 任何 send_* / set_* / delete_* 在这里就被拒绝，杜绝误发到真实群。
 */

/** 把 OneBot 事件压成固定结构，便于 policy 层直接用。 */
export function normalize(evt) {
    const segments = Array.isArray(evt?.message)
        ? evt.message.map(segment => {
            const type = String(segment?.type ?? '');
            if (type === 'text')
                return { type, text: String(segment?.data?.text ?? '') };
            if (type === 'at')
                return { type, qq: String(segment?.data?.qq ?? '') };
            if (type === 'image')
                return { type, file: String(segment?.data?.file ?? '').slice(0, 80), url: Boolean(segment?.data?.url) };
            if (type === 'reply')
                return {
                    type,
                    id: String(segment?.data?.id ?? ''),
                    qq: segment?.data?.qq === undefined ? null : String(segment.data.qq),
                };
            if (type === 'forward')
                return { type, id: String(segment?.data?.id ?? '') };
            return { type };
        })
        : [];
    const selfId = String(evt?.self_id ?? '');
    const isGroup = evt?.message_type === 'group';
    return {
        postType: String(evt?.post_type ?? ''),
        messageType: evt?.message_type === undefined ? null : String(evt.message_type),
        chatType: isGroup ? 'group' : (evt?.message_type === 'private' ? 'dm' : null),
        chatId: String(isGroup ? evt?.group_id : evt?.user_id ?? ''),
        groupId: evt?.group_id === undefined ? null : String(evt.group_id),
        userId: String(evt?.user_id ?? ''),
        nickname: String(evt?.sender?.card || evt?.sender?.nickname || ''),
        messageId: evt?.message_id === undefined ? null : String(evt.message_id),
        time: evt?.time ?? null,
        raw: String(evt?.raw_message ?? ''),
        segments,
        atMe: segments.some(segment => segment.type === 'at' && (segment.qq === selfId || segment.qq === 'all')),
        replyTo: segments.find(segment => segment.type === 'reply')?.id ?? null,
        selfId,
    };
}

/** 只读 action 白名单；不在这里的一律拒绝。 */
export const READ_ONLY_ACTIONS = new Set([
    'get_msg',
    'get_group_msg_history',
    'get_friend_msg_history',
    'get_login_info',
    'get_group_member_info',
    'get_stranger_info',
]);

export function createConnection({ url, accessToken, log, onEvent }) {
    const baseUrl = String(url ?? 'ws://127.0.0.1:3001');
    const pending = new Map();
    let socket;
    let stopped = false;
    let retry = 0;
    let retryTimer;
    let openedAt = 0;
    let echoSeq = 0;

    function target() {
        if (!accessToken)
            return baseUrl;
        const separator = baseUrl.includes('?') ? '&' : '?';
        return baseUrl + separator + 'access_token=' + encodeURIComponent(accessToken);
    }

    function settleAll(error) {
        for (const [echo, item] of pending) {
            clearTimeout(item.timer);
            item.reject(error);
            pending.delete(echo);
        }
    }

    function scheduleReconnect(reason) {
        if (stopped)
            return;
        retry += 1;
        const delay = Math.min(30000, 3000 * retry);
        log('warn', 'WS 断开，' + delay + 'ms 后重连', { reason, attempt: retry });
        retryTimer = setTimeout(connect, delay);
        retryTimer.unref?.();
    }

    function connect() {
        if (stopped)
            return;
        retryTimer = undefined;
        log('info', 'WS 连接中', { url: baseUrl, attempt: retry + 1 });
        try {
            socket = new WebSocket(target());
        }
        catch (error) {
            scheduleReconnect('构造 WebSocket 失败: ' + (error?.message ?? String(error)));
            return;
        }
        socket.addEventListener('open', () => {
            openedAt = Date.now();
            retry = 0;
            log('info', 'WS 已连接', { url: baseUrl });
        });
        socket.addEventListener('message', event => {
            let payload;
            try {
                payload = JSON.parse(String(event.data));
            }
            catch {
                log('warn', '非 JSON 帧，已忽略', { preview: String(event.data).slice(0, 200) });
                return;
            }
            if (payload?.echo !== undefined && pending.has(payload.echo)) {
                const item = pending.get(payload.echo);
                pending.delete(payload.echo);
                clearTimeout(item.timer);
                if (payload.status === 'failed' || payload.retcode !== 0)
                    item.reject(new Error(payload?.message ?? payload?.wording ?? 'OneBot action 失败'));
                else
                    item.resolve(payload.data);
                return;
            }
            try {
                onEvent(payload);
            }
            catch (error) {
                log('error', '事件处理抛错', { error: error?.stack ?? String(error) });
            }
        });
        socket.addEventListener('error', () => {
            log('warn', 'WS 传输错误', { url: baseUrl });
        });
        socket.addEventListener('close', event => {
            const lived = openedAt === 0 ? 0 : Date.now() - openedAt;
            openedAt = 0;
            settleAll(new Error('WS 已断开'));
            scheduleReconnect('close code=' + event.code + ' reason=' + String(event.reason ?? '') + ' livedMs=' + lived);
        });
    }

    return {
        start() {
            stopped = false;
            connect();
        },
        stop() {
            stopped = true;
            if (retryTimer !== undefined)
                clearTimeout(retryTimer);
            settleAll(new Error('插件已停止'));
            try {
                socket?.close();
            }
            catch {
                // ignore
            }
        },
        /**
         * 只读 OneBot action。拒绝一切非白名单 action（含 send_*）。
         * 返回 Promise<data>；超时/断线/失败都会 reject。
         * options.sample=true 时一律拒绝：样例回放只许走假上游，不许拿假 id 打线上。
         */
        callReadOnly(action, params = {}, timeoutMs = 8000, options = {}) {
            if (options?.sample === true)
                return Promise.reject(new Error('样例回放不访问真实 OneBot: ' + action));
            if (!READ_ONLY_ACTIONS.has(action))
                return Promise.reject(new Error('S1 只允许只读 action，已拒绝: ' + action));
            if (socket === undefined || socket.readyState !== 1)
                return Promise.reject(new Error('WS 未连接'));
            echoSeq += 1;
            const echo = 'qq-onebot-' + echoSeq;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(echo);
                    reject(new Error('OneBot action 超时: ' + action));
                }, timeoutMs);
                timer.unref?.();
                pending.set(echo, { resolve, reject, timer });
                try {
                    socket.send(JSON.stringify({ action, params, echo }));
                }
                catch (error) {
                    pending.delete(echo);
                    clearTimeout(timer);
                    reject(error);
                }
            });
        },
        /** S1 只读：明确不实现发送，任何调用都会抛错。 */
        send() {
            throw new Error('S1 阶段禁止发送消息到 QQ');
        },
    };
}
