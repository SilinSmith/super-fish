/**
 * 入站事件的唯一归一化层。
 *
 * 设计目标：同一个事实（谁、@了谁、被拍的是谁、群名是什么）只在入站边界解析一次，
 * 之后所有下游（prompt 拼装、代理压缩、闸门、判定器、出站 @ 反查）都读结构，
 * 不再各自用正则从中文标记里二次抽取。
 *
 * 两类产物：
 *  - 结构体 CanonicalEvent（机器可读，带 traceId，便于跨日志还原现场）
 *  - text（模型看到的唯一一段话，由 renderEventText 生成，只生成一次）
 * 结构体以 `【元】{json}` 单行形式随消息带走；代理发给引擎前会剥掉这行，
 * 模型只看到渲染后的自然语言，代理则按结构做压缩与闸门。
 */

export const ENVELOPE_TAG = '【元】';

const MENTION_DIRECTORY = new Map();

function nextTraceId(prefix) {
    const stamp = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return prefix + '-' + stamp + '-' + rand;
}

/** 结构化 mentions → `@昵称(QQ)` 短形式；查不到昵称就写 QQ。 */
export function formatMention(target) {
    const qq = String(target?.qq ?? '');
    if (qq === '')
        return '';
    const nick = String(target?.nick ?? target?.name ?? '').trim();
    return '@' + (nick === '' ? 'QQ' + qq : nick + '(' + qq + ')');
}

/** quotedMe 是三态：true=引用了你，false=不是引用你，null=引用解析失败（未知）。
 * null 不能被下游当成 false 消费，否则 get_msg 失败就会静默降级成“没引用”。 */
function triBool(value) {
    if (value === true)
        return true;
    if (value === null)
        return null;
    return false;
}

export function buildEvent(input) {
    const targets = Array.isArray(input.targets)
        ? input.targets
            .filter(item => String(item?.qq ?? '') !== '')
            .map(item => ({
                qq: String(item.qq),
                nick: String(item.nick ?? ''),
                rel: String(item.rel ?? 'at'),
            }))
        : [];
    const actorQq = String(input.actor?.qq ?? '');
    const selfId = String(input.chat?.selfId ?? '');
    return {
        v: 1,
        traceId: String(input.traceId ?? nextTraceId(String(input.kind ?? 'message'))),
        ts: Number(input.ts ?? Date.now()),
        kind: String(input.kind ?? 'message'),
        chat: {
            type: String(input.chat?.type ?? 'group'),
            id: String(input.chat?.id ?? ''),
            name: String(input.chat?.name ?? ''),
            selfId,
            masterQq: String(input.chat?.masterQq ?? ''),
            groupId: input.chat?.groupId === undefined || input.chat.groupId === null || input.chat.groupId === ''
                ? null
                : String(input.chat.groupId),
        },
        actor: {
            qq: actorQq,
            nick: String(input.actor?.nick ?? ''),
            card: String(input.actor?.card ?? ''),
            role: String(input.actor?.role ?? ''),
            isSelf: input.actor?.isSelf === true || (actorQq !== '' && actorQq === selfId),
            isMaster: input.actor?.isMaster === true,
        },
        targets,
        text: String(input.text ?? ''),
        mentions: targets.filter(item => item.rel === 'at').map(item => item.qq),
        reply: input.reply === undefined ? null : input.reply,
        flags: {
            atMe: input.flags?.atMe === true,
            atOther: input.flags?.atOther === true,
            pokeMe: input.flags?.pokeMe === true,
            pokeSelf: input.flags?.pokeSelf === true,
            pokeOther: input.flags?.pokeOther === true,
            quotedMe: triBool(input.flags?.quotedMe),
            quotedSelf: input.flags?.quotedSelf === true,
            quotedOther: input.flags?.quotedOther === true,
            quotedUnknown: input.flags?.quotedUnknown === true,
            isSelf: input.flags?.isSelf === true,
            isBot: input.flags?.isBot === true,
            isMaster: input.flags?.isMaster === true,
            isDuplicate: input.flags?.isDuplicate === true,
            isEmptyBody: input.flags?.isEmptyBody === true,
            isAmbient: input.flags?.isAmbient !== false,
            selfRecall: input.flags?.selfRecall === true,
            isReaction: input.flags?.isReaction === true,
            addressedElsewhere: input.flags?.addressedElsewhere === true,
        },
        media: Array.isArray(input.media) ? input.media.map(item => ({ ...item })) : [],
    };
}

/** 只有一条消息（当前轮）需要给模型看；历史由代理按结构压缩，不重复渲染。 */
export function renderEventText(evt) {
    if (evt.kind === 'notice') {
        if (evt.targets.some(item => item.rel === 'poke')) {
            const poke = evt.targets.find(item => item.rel === 'poke');
            return {
                head: '',
                body: renderPokeText({
                    poker: { qq: evt.actor.qq, nick: evt.actor.nick },
                    target: poke,
                    selfId: evt.chat.selfId,
                    suffix: evt.suffix ?? '',
                }),
            };
        }
        return { head: '', body: evt.noticeText ?? '' };
    }
    const atLine = renderAtLine(evt);
    const mediaLine = renderMediaLine(evt);
    const tail = mediaLine === ''
        ? ''
        : (atLine === '' || atLine.endsWith('\n') ? '' : '\n') + mediaLine;
    const head = renderSenderLine(evt) + renderChatLine(evt) + renderGroupLine(evt)
        + renderQuoteLine(evt) + atLine + tail + '\n';
    const body = stripMediaPlaceholders(String(evt.text ?? ''), evt.media);
    return {
        head,
        body: truncateBody(head, body),
    };
}

/** 媒体已经进了 media[]，正文里同一个媒体不再留占位符。
 *  带路径的标注（[图片:path]）保留，模型读图还要用。 */
function stripMediaPlaceholders(text, media) {
    if (!Array.isArray(media) || media.length === 0 || text === '')
        return text;
    const kinds = new Set(media.map(item => String(item?.kind ?? '')).filter(kind => kind !== ''));
    let out = text;
    if (kinds.has('image'))
        out = out.replace(/\[图片\]/gu, '');
    if (kinds.has('voice'))
        out = out.replace(/\[语音\]/gu, '');
    if (kinds.has('video'))
        out = out.replace(/\[视频\]/gu, '');
    if (kinds.has('forward'))
        out = out.replace(/\[合并转发\]/gu, '');
    if (kinds.has('card'))
        out = out.replace(/\[卡片\]/gu, '');
    if (kinds.has('sticker'))
        out = out.replace(/\[(?:表情包|QQ表情)[^\]]*\]/gu, '');
    if (kinds.has('file')) {
        out = out.replace(/\[文件\]/gu, '')
            .replace(/\[文件:([^\]]*)\]/gu, (all, inner) => /[\\/]/u.test(inner) ? all : '');
    }
    return out.replace(/[ \t]{2,}/gu, ' ').trim();
}

/** 单条事件进 prompt 的上限：超了截断并写明丢了多少字。 */
const MAX_EVENT_TEXT = 4000;

function truncateBody(head, body) {
    const total = head.length + body.length;
    if (total <= MAX_EVENT_TEXT)
        return body;
    let budget = MAX_EVENT_TEXT - head.length - 12;
    for (let round = 0; round < 2; round += 1) {
        const keep = Math.max(0, Math.min(body.length, budget));
        const dropped = body.length - keep;
        const suffix = '…[截断 ' + dropped + ' 字]';
        budget = MAX_EVENT_TEXT - head.length - suffix.length;
    }
    const keep = Math.max(0, Math.min(body.length, budget));
    const dropped = body.length - keep;
    return body.slice(0, keep) + '…[截断 ' + dropped + ' 字]';
}

/** 私聊 / 临时会话 / 群 的会话性质；群名单独走 renderGroupLine。 */
export function renderChatLine(evt) {
    if (evt.chat.type === 'temp')
        return '【会话】临时会话（来自群 ' + (evt.chat.groupId ?? evt.chat.id) + '，不是好友私聊）\n';
    if (evt.chat.type === 'private')
        return '【会话】私聊（QQ=' + evt.actor.qq + '）\n';
    return '';
}

/** 引用解析失败时明确写“未知”，不把 quotedMe 降级成 false 让模型猜。
 *  解析成功时必须把被引用的原话渲染出来：模型判断“他在回哪句”只能靠这一行。 */
export function renderQuoteLine(evt) {
    if (evt.reply === null || evt.reply === undefined)
        return '';
    if (evt.flags?.quotedUnknown === true)
        return '【引用对象】未知（get_msg 解析失败，引用内容读取失败；不要假装知道被引用的原话）\n';
    const text = String(evt.reply.text ?? '').replace(/\s+/gu, ' ').trim();
    const nick = String(evt.reply.nick ?? '').trim();
    const qq = String(evt.reply.qq ?? '').trim();
    const selfId = String(evt.chat?.selfId ?? '');
    const isSelf = qq !== '' && qq === selfId;
    const who = isSelf
        ? '你自己'
        : (nick !== '' ? nick + (qq !== '' ? '(' + qq + ')' : '') : (qq !== '' ? 'QQ' + qq : '某人'));
    const media = Array.isArray(evt.reply.media) ? evt.reply.media : [];
    const mediaNote = media.length === 0
        ? ''
        : '（还带 ' + media.map(item => MEDIA_LABELS[String(item?.kind ?? '')] ?? '媒体').join('、') + '）';
    const selfNote = isSelf ? '（这是你自己之前说的话，不要当成对方说的）' : '';
    if (text === '')
        return '【引用】' + who + ' 的消息' + mediaNote + '（没有可读文字，只有媒体；不要假装知道内容）\n';
    const shown = text.length > 300 ? text.slice(0, 300) + '…' : text;
    return '【引用】' + who + ' 说的原话：「' + shown + '」' + mediaNote + selfNote + '\n';
}

const MEDIA_LABELS = {
    image: '图片',
    sticker: '表情包',
    face: 'QQ表情',
    video: '视频',
    voice: '语音',
    file: '文件',
    forward: '合并转发',
    card: '卡片',
};

/** 媒体只走旁路：这里按 kind 汇总成人话，不把 [图片] 之类占位符塞回正文。 */
export function renderMediaLine(evt) {
    const media = Array.isArray(evt.media) ? evt.media : [];
    if (media.length === 0)
        return '';
    const order = [];
    const counts = new Map();
    for (const item of media) {
        const kind = String(item?.kind ?? '');
        if (kind === '')
            continue;
        if (!counts.has(kind)) {
            counts.set(kind, 0);
            order.push(kind);
        }
        counts.set(kind, counts.get(kind) + 1);
    }
    if (order.length === 0)
        return '';
    const parts = order.map(kind => {
        const label = MEDIA_LABELS[kind] ?? kind;
        const count = counts.get(kind);
        const captions = media
            .filter(item => String(item?.kind ?? '') === kind && String(item?.caption ?? '') !== '')
            .map(item => String(item.caption).slice(0, 20));
        const caption = captions.length === 0 ? '' : '「' + [...new Set(captions)].slice(0, 3).join('、') + '」';
        return label + caption + (count > 1 ? '×' + count : '');
    });
    return '【媒体】' + parts.join('、') + '（旁路参数，不在正文里）\n';
}

export function renderSenderLine(evt) {
    return '【发送者标记】QQ=' + evt.actor.qq
        + ' 是否主人=' + (evt.actor.isMaster ? '是' : '否')
        + ' 昵称=' + evt.actor.nick + '\n';
}

export function renderGroupLine(evt) {
    if (evt.chat.type !== 'group' || evt.chat.name === '')
        return '';
    return '【群名】' + evt.chat.name.replace(/\s+/gu, ' ').slice(0, 40) + '\n';
}

export function renderAtLine(evt) {
    const ats = evt.targets.filter(item => item.rel === 'at');
    const who = evt.actor.nick + '(' + evt.actor.qq + ')';
    if (ats.length === 0)
        return '【@对象】无（本条由 ' + who + ' 发出，没有@任何人）';
    const names = ats.map(item => {
        if (item.qq === 'all')
            return '全体成员(all)';
        if (evt.chat.masterQq !== '' && item.qq === evt.chat.masterQq)
            return '主人(' + item.qq + ')';
        if (evt.chat.selfId !== '' && item.qq === evt.chat.selfId)
            return '你自己(' + item.qq + ')';
        return '群友(' + item.qq + ')';
    }).join('、');
    return '【@对象】' + names
        + '（本条由 ' + who + ' 发出；@ 不改变说话人，也不代表被@的人在提问题；'
        + '被@的人没有开口时，问题仍然是说话人的）';
}

/**
 * 拍一拍的唯一渲染点。必须区分「拍的是你」和「拍的是别人」：
 * 前者要求回应，后者只是背景信息，绝不能产出同一句话让模型猜。
 */
export function renderPokeText({ poker, target, selfId, suffix = '' }) {
    const pokerText = poker.nick === '' ? String(poker.qq) : poker.nick + '(' + poker.qq + ')';
    const targetQq = String(target.qq);
    const targetText = selfId !== '' && targetQq === String(selfId)
        ? '你'
        : (targetQq === String(poker.qq)
            ? '自己'
            : (target.nick === '' ? targetQq : target.nick + '(' + targetQq + ')'));
    const suffixText = suffix === '' ? '' : '（' + suffix + '）';
    return pokerText + ' 拍了拍 ' + targetText + suffixText;
}

export function encodeEnvelope(evt) {
    return ENVELOPE_TAG + JSON.stringify(evt) + '\n';
}

/** 从消息文本里取出结构体；没有信封时 body 原样返回。 */
export function decodeEnvelope(raw) {
    const text = String(raw ?? '');
    if (!text.startsWith(ENVELOPE_TAG))
        return { evt: null, body: text };
    const end = text.indexOf('\n');
    const line = end === -1 ? text.slice(ENVELOPE_TAG.length) : text.slice(ENVELOPE_TAG.length, end);
    let evt = null;
    try {
        evt = JSON.parse(line);
    }
    catch {
        evt = null;
    }
    return { evt, body: end === -1 ? '' : text.slice(end + 1) };
}

/** 每收到一条带 @ 或发送者的消息就更新目录，出站写 @昵称 时优先命中这里。 */
export function registerMentions(chatId, evt) {
    const key = String(chatId);
    let map = MENTION_DIRECTORY.get(key);
    if (map === undefined) {
        map = new Map();
        MENTION_DIRECTORY.set(key, map);
    }
    const remember = (qq, nick) => {
        if (qq === '' || qq === 'all')
            return;
        map.set(qq, qq);
        if (nick !== '')
            map.set(nick, qq);
    };
    remember(evt.actor.qq, evt.actor.nick);
    if (evt.actor.card !== '')
        remember(evt.actor.qq, evt.actor.card);
    for (const target of evt.targets)
        remember(target.qq, target.nick);
    if (map.size > 2000) {
        const keep = [...map.entries()].slice(-1500);
        MENTION_DIRECTORY.set(key, new Map(keep));
    }
}

export function lookupMention(chatId, name) {
    const map = MENTION_DIRECTORY.get(String(chatId));
    if (map === undefined)
        return undefined;
    const hit = map.get(String(name).trim());
    return hit === undefined ? undefined : String(hit);
}

/* ------------------------------------------------------------------ */
/* media                                                               */
/* ------------------------------------------------------------------ */

const MEDIA_KIND_ALIASES = {
    image: 'image',
    img: 'image',
    sticker: 'sticker',
    mface: 'sticker',
    marketface: 'sticker',
    face: 'face',
    video: 'video',
    record: 'voice',
    voice: 'voice',
    file: 'file',
    forward: 'forward',
    json: 'card',
    xml: 'card',
    card: 'card',
};

function mediaKind(kind) {
    const key = String(kind ?? '').toLowerCase();
    return MEDIA_KIND_ALIASES[key] ?? '';
}

function normalizeMediaItem(item) {
    const kind = mediaKind(item?.kind);
    if (kind === '')
        return null;
    const out = { kind };
    if (typeof item.url === 'string' && item.url !== '')
        out.url = item.url;
    if (typeof item.file === 'string' && item.file !== '')
        out.file = item.file;
    if (typeof item.path === 'string' && item.path !== '')
        out.path = item.path;
    if (typeof item.caption === 'string' && item.caption !== '')
        out.caption = item.caption;
    if (typeof item.name === 'string' && item.name !== '')
        out.name = item.name;
    if (item.width !== undefined)
        out.width = item.width;
    if (item.height !== undefined)
        out.height = item.height;
    return out;
}

/**
 * 媒体分类的唯一点：sticker / face / video / voice / file / forward / card / image。
 * 上游已解析过（inbound.media）就沿用；没有就退回从 segments 自己分。
 */
export function normalizeMedia(media, segments) {
    const given = Array.isArray(media) ? media : [];
    if (given.length > 0)
        return given.map(normalizeMediaItem).filter(Boolean);
    const out = [];
    for (const seg of Array.isArray(segments) ? segments : []) {
        const type = String(seg?.type ?? '');
        const data = seg?.data ?? {};
        if (type === 'image') {
            const subType = String(data.sub_type ?? data['sub-type'] ?? '');
            out.push({ kind: subType === '1' ? 'sticker' : 'image', url: data.url, file: data.file });
            continue;
        }
        if (type === 'mface' || type === 'marketface') {
            out.push({
                kind: 'sticker',
                url: data.url,
                caption: String(data.summary || data.name || data.face_name || ''),
                name: String(data.name || ''),
            });
            continue;
        }
        if (type === 'face') {
            out.push({ kind: 'face', caption: String(data.id ?? '') });
            continue;
        }
        if (type === 'record' || type === 'voice') {
            out.push({ kind: 'voice', url: data.url, file: data.file });
            continue;
        }
        if (type === 'video') {
            out.push({ kind: 'video', url: data.url, file: data.file });
            continue;
        }
        if (type === 'file') {
            out.push({ kind: 'file', url: data.url, file: data.file_id || data.file, name: data.name || data.file });
            continue;
        }
        if (type === 'forward') {
            out.push({ kind: 'forward', name: String(data.id ?? data.resId ?? '') });
            continue;
        }
        if (type === 'json' || type === 'xml') {
            out.push({ kind: 'card' });
        }
    }
    return out;
}

/* ------------------------------------------------------------------ */
/* de-duplication                                                      */
/* ------------------------------------------------------------------ */

/** 完全重复消息：同一个 message_id 在 5 分钟内重复到达即视为重复。
 * 事件层留痕（flags.isDuplicate），上层 gate 直接按它沉默。 */
const DEDUPE_TTL_MS = 5 * 60 * 1000;
const DEDUPE_MAX_ENTRIES = 2048;
const SEEN_MESSAGE_KEYS = new Map();

function pruneDedupe(now) {
    for (const [key, at] of SEEN_MESSAGE_KEYS) {
        if (now - at > DEDUPE_TTL_MS)
            SEEN_MESSAGE_KEYS.delete(key);
        else
            break;
    }
    while (SEEN_MESSAGE_KEYS.size > DEDUPE_MAX_ENTRIES) {
        const oldest = SEEN_MESSAGE_KEYS.keys().next().value;
        SEEN_MESSAGE_KEYS.delete(oldest);
    }
}

function markSeen(key, now) {
    const at = SEEN_MESSAGE_KEYS.get(key);
    if (at !== undefined && now - at <= DEDUPE_TTL_MS)
        return true;
    SEEN_MESSAGE_KEYS.delete(key);
    SEEN_MESSAGE_KEYS.set(key, now);
    pruneDedupe(now);
    return false;
}

/* 机器人回复过哪些消息：撤回通知据此区分「撤回的是被回复过的消息」。
 * 只存 chatId#messageId，30 分钟过期，最多 512 条。 */
const REPLIED_MESSAGE_IDS = new Map();
const REPLIED_TTL_MS = 30 * 60_000;
const REPLIED_MAX_ENTRIES = 512;

export function rememberRepliedMessage(chatId, messageId) {
    if (chatId === '' || messageId === undefined || messageId === null || messageId === '')
        return;
    const key = String(chatId) + '#' + String(messageId);
    const now = Date.now();
    for (const [seenKey, at] of REPLIED_MESSAGE_IDS) {
        if (now - at > REPLIED_TTL_MS)
            REPLIED_MESSAGE_IDS.delete(seenKey);
    }
    REPLIED_MESSAGE_IDS.delete(key);
    REPLIED_MESSAGE_IDS.set(key, now);
    while (REPLIED_MESSAGE_IDS.size > REPLIED_MAX_ENTRIES) {
        const oldest = REPLIED_MESSAGE_IDS.keys().next().value;
        REPLIED_MESSAGE_IDS.delete(oldest);
    }
}

export function repliedToMessage(chatId, messageId) {
    if (chatId === '' || messageId === undefined || messageId === null || messageId === '')
        return false;
    const at = REPLIED_MESSAGE_IDS.get(String(chatId) + '#' + String(messageId));
    return at !== undefined && Date.now() - at <= REPLIED_TTL_MS;
}

/* ------------------------------------------------------------------ */
/* builders                                                            */
/* ------------------------------------------------------------------ */

/**
 * 第 0 跳：一条普通消息 → 规范事件。
 * 所有 @ 关系只在这里读一次；下游不再从中文标记里反推。
 */
export function buildMessageEvent(input) {
    const selfId = String(input.selfId ?? '');
    const segments = Array.isArray(input.segments) ? input.segments : [];
    const seen = new Set();
    const targets = [];
    for (const segment of segments) {
        if (segment?.type !== 'at')
            continue;
        const qq = String(segment?.data?.qq ?? segment?.qq ?? '');
        if (qq === '' || seen.has(qq))
            continue;
        seen.add(qq);
        targets.push({ qq, nick: '', rel: 'at' });
    }
    const actorQq = String(input.userId ?? '');
    const replyId = input.replyId === undefined || input.replyId === null ? '' : String(input.replyId);
    const replyQq = String(input.replyQq ?? '');
    const replyUnresolved = replyId !== '' && replyQq === '' && input.replyResolved !== true;
    if (replyQq !== '' && seen.has(replyQq) === false && replyQq !== selfId)
        targets.push({ qq: replyQq, nick: String(input.replyNick ?? ''), rel: 'reply' });
    const atMe = targets.some(item => item.rel === 'at' && (item.qq === selfId || item.qq === 'all'));
    const atOther = targets.some(item => item.rel === 'at' && item.qq !== selfId && item.qq !== 'all');
    const quotedMe = replyQq === '' ? (replyUnresolved ? null : false) : replyQq === selfId;
    const quotedSelf = replyQq !== '' && replyQq === actorQq;
    const quotedOther = replyQq !== '' && replyQq !== selfId && replyQq !== actorQq;
    const subType = String(input.subType ?? '');
    const chatType = String(input.kind ?? 'group') === 'group'
        ? 'group'
        : (subType === 'group' || subType === 'discuss' || subType === 'temp' ? 'temp' : 'private');
    const messageId = input.messageId === undefined || input.messageId === null ? null : String(input.messageId);
    const knownBots = Array.isArray(input.knownBots) ? input.knownBots.map(String) : [];
    const isBot = actorQq !== '' && actorQq !== selfId && (input.isBot === true || knownBots.includes(actorQq));
    const chatId = String(input.chatId ?? '');
    const now = Date.now();
    const seenKeys = Array.isArray(input.seenMessageKeys) ? input.seenMessageKeys.map(String) : [];
    const dedupeKey = messageId === null ? '' : chatType + ':' + chatId + '#' + messageId;
    const isDuplicate = input.isDuplicate === true
        || (dedupeKey !== '' && (seenKeys.includes(dedupeKey) || markSeen(dedupeKey, now)));
    const media = normalizeMedia(input.media, segments);
    const isSelf = actorQq !== '' && actorQq === selfId;
    const isMaster = input.isMaster === true;
    const evt = buildEvent({
        kind: /^\//u.test(String(input.text ?? '').trim()) ? 'command' : 'message',
        ts: input.ts,
        chat: {
            type: chatType,
            id: chatId,
            name: chatType === 'group' ? String(input.groupName ?? '') : '',
            selfId,
            masterQq: String(input.masterQq ?? ''),
            groupId: String(input.groupId ?? (chatType === 'group' ? chatId : '')) || null,
        },
        actor: {
            qq: actorQq,
            nick: String(input.nickname ?? ''),
            card: String(input.card ?? ''),
            role: String(input.role ?? ''),
            isSelf,
            isMaster,
        },
        targets,
        text: String(input.text ?? ''),
        reply: replyId === ''
            ? null
            : {
                id: replyId,
                qq: replyQq,
                nick: String(input.replyNick ?? ''),
                text: String(input.replyText ?? ''),
                ...(Array.isArray(input.replyMedia) && input.replyMedia.length > 0
                    ? { media: input.replyMedia.map(item => ({ ...item })) }
                    : {}),
                unresolved: replyUnresolved,
            },
        flags: {
            atMe,
            atOther,
            pokeMe: false,
            pokeSelf: false,
            pokeOther: false,
            quotedMe,
            quotedSelf,
            quotedOther,
            quotedUnknown: replyUnresolved,
            isSelf,
            isBot,
            isMaster,
            isDuplicate,
            isEmptyBody: String(input.text ?? '').trim() === '',
            isAmbient: !atMe && quotedMe !== true && !atOther && !quotedOther && !isSelf,
            addressedElsewhere: atOther && !atMe,
        },
        media,
    });
    evt.messageId = messageId;
    return evt;
}

/**
 * 第 0 跳：一条 poke 通知 → 规范事件。
 * 明确保留 (poker, target) 三元组，拍 bot / 拍别人 / 拍自己 三种输入不合并。
 */
export function buildPokeEvent(input) {
    const selfId = String(input.selfId ?? '');
    const pokerQq = String(input.pokerQq ?? '');
    const targetQq = String(input.targetQq ?? '');
    const evt = buildEvent({
        kind: 'notice',
        ts: input.ts,
        chat: {
            type: String(input.kind ?? 'group'),
            id: String(input.chatId ?? ''),
            name: String(input.groupName ?? ''),
            selfId,
            masterQq: String(input.masterQq ?? ''),
            groupId: String(input.groupId ?? (String(input.kind ?? 'group') === 'group' ? input.chatId : '')) || null,
        },
        actor: {
            qq: pokerQq,
            nick: String(input.pokerNick ?? ''),
            card: String(input.pokerCard ?? ''),
            isSelf: pokerQq !== '' && pokerQq === selfId,
            isMaster: input.pokerIsMaster === true,
        },
        targets: [{ qq: targetQq, nick: String(input.targetNick ?? ''), rel: 'poke' }],
        text: '',
        flags: {
            atMe: false,
            atOther: false,
            pokeMe: targetQq !== '' && targetQq === selfId,
            pokeSelf: targetQq !== '' && targetQq === pokerQq && pokerQq !== selfId,
            pokeOther: targetQq !== '' && targetQq !== selfId && targetQq !== pokerQq,
            quotedMe: false,
            isSelf: pokerQq !== '' && pokerQq === selfId,
            isMaster: input.pokerIsMaster === true,
            isAmbient: false,
            addressedElsewhere: targetQq !== '' && targetQq !== selfId && targetQq !== pokerQq,
        },
        media: [],
    });
    evt.suffix = String(input.suffix ?? '');
    evt.autoPokedAt = Number(input.autoPokedAt ?? 0);
    evt.notice = { type: 'notify', subType: 'poke', operatorQq: null, targetQq: targetQq === '' ? null : targetQq };
    return evt;
}

/* ------------------------------------------------------------------ */
/* notices                                                             */
/* ------------------------------------------------------------------ */

function personLabel(qq, nick) {
    const id = String(qq ?? '');
    const name = String(nick ?? '').trim();
    if (id === '')
        return name === '' ? '未知' : name;
    return name === '' || name === id ? id : name + '(' + id + ')';
}

/**
 * 第 0 跳：通知类事件（撤回 / 入退群 / 踢人 / 禁言 / 名片 / 表情回应）。
 * 每种通知都有独立分支，不并类、不省略操作者与被操作者。
 */
export function buildNoticeEvent(input) {
    const selfId = String(input.selfId ?? '');
    const noticeType = String(input.noticeType ?? '');
    const subType = String(input.subType ?? '');
    const groupId = String(input.groupId ?? '');
    const chatType = noticeType.startsWith('group_') || groupId !== '' ? 'group' : 'private';
    const actorQq = String(input.actor?.qq ?? input.userId ?? '');
    const actorNick = String(input.actor?.nick ?? input.nickname ?? '');
    const operatorQq = String(input.operatorQq ?? '');
    const operatorNick = String(input.operatorNick ?? '');
    const targetQq = String(input.targetQq ?? input.userId ?? '');
    const targetNick = String(input.targetNick ?? actorNick);
    const knownBots = Array.isArray(input.knownBots) ? input.knownBots.map(String) : [];
    const chatId = chatType === 'group' ? groupId : actorQq;
    const messageId = input.messageId === undefined || input.messageId === null ? '' : String(input.messageId);
    // 每种通知都保留被作用对象，不把事实压成一句文本。
    const targets = [];
    if (noticeType === 'group_recall' || noticeType === 'friend_recall')
        targets.push({ qq: targetQq, nick: targetNick, rel: 'recall' });
    else if (noticeType === 'group_ban')
        targets.push({ qq: targetQq, nick: targetNick, rel: 'ban' });
    else if (noticeType === 'group_decrease' && (subType === 'kick' || subType === 'kick_me'))
        targets.push({ qq: targetQq, nick: targetNick, rel: 'kick' });
    else if (noticeType === 'group_msg_emoji_like' || noticeType === 'reaction')
        targets.push({ qq: actorQq, nick: actorNick, rel: 'reaction' });
    else if (noticeType === 'group_upload')
        targets.push({ qq: actorQq, nick: actorNick, rel: 'uploader' });
    // 群文件带结构化 media，不退化成正文占位符。
    const file = input.file ?? null;
    const media = file === null
        ? []
        : [{
            kind: 'file',
            id: String(file.id ?? file.file_id ?? ''),
            name: String(file.name ?? file.file_name ?? ''),
            size: Number(file.size ?? file.file_size ?? 0),
        }];
    // 撤回三态：自己撤回自己的、撤回他人、撤回一条被 bot 回复过的消息。
    const isRecall = noticeType === 'group_recall' || noticeType === 'friend_recall';
    const recallReplied = isRecall && messageId !== '' && repliedToMessage(chatId, messageId);
    const evt = buildEvent({
        kind: 'notice',
        ts: input.ts,
        chat: {
            type: chatType,
            id: chatId,
            name: chatType === 'group' ? String(input.groupName ?? '') : '',
            selfId,
            masterQq: String(input.masterQq ?? ''),
            groupId: groupId === '' ? null : groupId,
        },
        actor: {
            qq: actorQq,
            nick: actorNick,
            card: String(input.actor?.card ?? input.card ?? ''),
            role: String(input.actor?.role ?? input.role ?? ''),
            isSelf: actorQq !== '' && actorQq === selfId,
            isMaster: actorQq !== '' && actorQq === String(input.masterQq ?? ''),
        },
        targets,
        text: '',
        flags: {
            isSelf: actorQq !== '' && actorQq === selfId,
            isBot: actorQq !== '' && actorQq !== selfId && knownBots.includes(actorQq),
            isMaster: actorQq !== '' && actorQq === String(input.masterQq ?? ''),
            isAmbient: false,
        },
        media,
    });
    evt.notice = {
        type: noticeType,
        subType,
        operatorQq: operatorQq === '' ? null : operatorQq,
        targetQq: targetQq === '' ? null : targetQq,
    };
    evt.noticeText = renderNoticeText({
        noticeType,
        subType,
        actor: { qq: actorQq, nick: actorNick },
        operator: { qq: operatorQq, nick: operatorNick },
        target: { qq: targetQq, nick: targetNick },
        duration: Number(input.duration ?? 0),
        cardNew: String(input.cardNew ?? ''),
        messageId,
        selfId,
        repliedByBot: recallReplied,
    });
    if (isRecall)
        evt.flags.selfRecall = targetQq !== '' && targetQq === selfId;
    if (isRecall)
        evt.flags.recallReplied = recallReplied;
    if (noticeType === 'group_msg_emoji_like' || noticeType === 'reaction')
        evt.flags.isReaction = true;
    return evt;
}

export function renderNoticeText(input) {
    const {
        noticeType, subType, actor, operator, target, duration, cardNew, messageId, selfId, repliedByBot,
    } = input;
    if (noticeType === 'group_recall' || noticeType === 'friend_recall') {
        const who = operator.qq !== '' ? operator : actor;
        const original = target.qq !== '' ? target : actor;
        const base = (who.qq === original.qq || original.qq === '')
            ? '[撤回] ' + personLabel(who.qq, who.nick) + ' 撤回了一条消息'
            : '[撤回] ' + personLabel(who.qq, who.nick) + ' 撤回了 '
                + personLabel(original.qq, original.nick) + ' 的一条消息';
        // 撤回的正好是 bot 被回复过的那条：多一档“和你有关”的信息。
        return repliedByBot === true ? base + '（这条你回复过）' : base;
    }
    if (noticeType === 'group_increase')
        return '[入群] ' + personLabel(actor.qq, actor.nick) + ' 加入了群聊';
    if (noticeType === 'group_decrease') {
        if (subType === 'kick' || subType === 'kick_me') {
            const op = operator.qq !== '' ? operator : actor;
            return '[被移出] ' + personLabel(op.qq, op.nick) + ' 将 '
                + personLabel(actor.qq, actor.nick) + ' 移出群聊';
        }
        return '[退群] ' + personLabel(actor.qq, actor.nick) + ' 退出了群聊';
    }
    if (noticeType === 'group_ban') {
        const op = operator.qq !== '' ? operator : actor;
        const tgt = personLabel(target.qq, target.nick);
        return duration > 0
            ? '[禁言] ' + personLabel(op.qq, op.nick) + ' 禁言了 ' + tgt + ' ' + duration + ' 秒'
            : '[解禁] ' + personLabel(op.qq, op.nick) + ' 解除了 ' + tgt + ' 的禁言';
    }
    if (noticeType === 'group_card')
        return '[名片变更] ' + personLabel(actor.qq, actor.nick) + ' 的群名片改为「' + cardNew + '」';
    if (noticeType === 'group_msg_emoji_like' || noticeType === 'reaction')
        return '[表情回应] ' + personLabel(actor.qq, actor.nick) + ' 回应了消息 ' + messageId;
    if (noticeType === 'group_upload')
        return '[群文件] ' + personLabel(actor.qq, actor.nick) + ' 上传了文件';
    if (noticeType === 'friend_add')
        return '[加好友] ' + personLabel(actor.qq, actor.nick) + ' 添加了好友';
    if (String(selfId) !== '' && actor.qq === String(selfId))
        return '[通知:' + (noticeType || 'unknown') + ']（与你有关）';
    return '[通知:' + (noticeType || 'unknown') + ']';
}

