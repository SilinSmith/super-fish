/**
 * 场景识别：从入站消息里解析当前会话的 sceneKey。
 *
 * 纯函数模块，不碰文件系统，便于单独单测。
 * 新插件每条消息都带【场景标记】；旧插件没有这行，这里回退到
 * legacy-group / private:<QQ>，并把 sceneFallback 标成 true，
 * 让调用方知道这是推断值、可以如实写进访问日志。
 */

export const SCENE_MARK_RE = /【场景标记】chat=((?:group|private):\d{5,12}) kind=(group|private)/u;

/** 旧插件的群前缀 "[HH:MM 昵称(QQ)]"，私聊没有。 */
const GROUP_PREFIX_RE = /\[\d{1,2}:\d{2}\s[^\]]*\(\d{5,12}\)\]/u;
const SENDER_MARK_RE = /【发送者标记】QQ=(\d{5,12})/u;

/** 旧链路没有群号可用，所有旧群共享这一个场景键。 */
export const LEGACY_GROUP_SCENE = 'legacy-group';

function messageText(message) {
    if (typeof message?.content === 'string')
        return message.content;
    if (Array.isArray(message?.content))
        return message.content.map(part => typeof part?.text === 'string' ? part.text : '').join(' ');
    return '';
}

/** 用户消息文本，新的在前。 */
function userTextsNewestFirst(messages) {
    const out = [];
    if (!Array.isArray(messages))
        return out;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role !== 'user')
            continue;
        out.push(messageText(messages[index]));
    }
    return out;
}

function legacyGroup() {
    return { sceneKey: LEGACY_GROUP_SCENE, chatKind: 'group', chatId: null, sceneFallback: true };
}

/**
 * 解析当前场景。
 *
 * 返回 { sceneKey, chatKind, chatId, sceneFallback }：
 * - 有【场景标记】→ 用标记里的 sceneKey，chatKind/chatId 从 sceneKey 拆出；
 * - 没有标记时回退：群前缀 → legacy-group；发送者标记 → private:<QQ>；
 *   都拿不到 → legacy-group。回退分支 sceneFallback 为 true。
 */
export function latestScene(messages) {
    const texts = userTextsNewestFirst(messages);
    for (const text of texts) {
        const match = SCENE_MARK_RE.exec(text);
        if (match === null)
            continue;
        const sceneKey = match[1];
        const [chatKind, chatId] = sceneKey.split(':');
        return { sceneKey, chatKind, chatId, sceneFallback: false };
    }
    for (const text of texts) {
        if (GROUP_PREFIX_RE.test(text))
            return legacyGroup();
    }
    for (const text of texts) {
        const match = SENDER_MARK_RE.exec(text);
        if (match !== null)
            return { sceneKey: 'private:' + match[1], chatKind: 'private', chatId: match[1], sceneFallback: true };
    }
    return legacyGroup();
}
