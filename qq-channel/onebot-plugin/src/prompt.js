/**
 * ⑤ 提示词封装：只产出"平台事实"标记，不拼接人格/记忆/规则。
 *
 * 与旧插件保持同形，proxy 才能按原逻辑解析：
 *   【发送者标记】QQ=… 是否主人=… 昵称=…
 *   【@对象】… / 【@对象】无…
 *   [HH:MM 昵称(QQ)][@我] <user_message …>正文</user_message>
 *
 * 新增一行【场景标记】用于跨群/私聊的记忆隔离；旧插件没有这行，proxy 会回退 legacy。
 */
import { classifySender } from './identity.js';

/** 昵称白名单：去控制字符与 XML 元字符，压缩空白，截 32 码点。 */
export function sanitizeNickname(nickname) {
    const printable = String(nickname ?? '').replace(/[\u0000-\u001f\u007f-\u009f<>&"']/g, '');
    const collapsed = printable.replace(/\s+/g, ' ').trim();
    const chars = [...collapsed];
    return chars.length <= 32 ? collapsed : chars.slice(0, 32).join('');
}

export function wrapUserMessage(content, userId, nickname) {
    return '<user_message qq="' + userId + '" nickname="' + sanitizeNickname(nickname) + '">\n'
        + content + '\n</user_message>';
}

export function buildGroupMessagePrefix(nickname, userId, mentioned, at = new Date()) {
    const hh = String(at.getHours()).padStart(2, '0');
    const mm = String(at.getMinutes()).padStart(2, '0');
    return '[' + hh + ':' + mm + ' ' + sanitizeNickname(nickname) + '(' + userId + ')]'
        + (mentioned ? '[@我]' : '') + ' ';
}

export function sceneKeyOf(kind, chatId) {
    return (kind === 'group' ? 'group:' : 'private:') + String(chatId);
}

function describeAt(ids, cfg, nickname, userId) {
    return ids.map(id => {
        if (id === 'all')
            return '全体成员(all)';
        if (id === String(cfg.bot.masterQQ))
            return '主人(' + id + ')';
        if (id === String(cfg.bot.qq))
            return '你自己(' + id + ')';
        return '群友(' + id + ')';
    }).join('、')
        + '（本条由 ' + sanitizeNickname(nickname) + '(' + userId + ') 发出；@ 不改变说话人，也不代表被@的人在提问题；'
        + '被@的人没有开口时，问题仍然是说话人的）\n';
}

/**
 * 构造投递给 agent 的最终文本。
 * @param batch policy.makeBatch 的产物
 * @param cfg EffectiveConfig
 * @param scene { sceneKey, chatKind, chatId }
 */
export function buildPrompt(batch, cfg, scene, { at = new Date() } = {}) {
    const nickname = sanitizeNickname(batch.nickname);
    const userId = String(batch.userId);
    // 机器人账号即使 QQ 与主人配置相同，也不能被标成主人。
    const isMaster = classifySender({ userId, selfId: cfg.bot.qq, cfg }).isMaster;
    const botQq = String(cfg.bot.qq);
    const body = String(batch.text ?? '')
        .replaceAll('@' + botQq, '@你')
        .trim();

    const senderMark = '【发送者标记】QQ=' + userId
        + ' 是否主人=' + (isMaster ? '是' : '否')
        + ' 昵称=' + (nickname === '' ? userId : nickname) + '\n';
    const sceneMark = '【场景标记】chat=' + scene.sceneKey
        + ' kind=' + scene.chatKind + '\n';

    let head = '';
    let atMark = '';
    if (scene.chatKind === 'group') {
        const ids = [...new Set((Array.isArray(batch.segments) ? batch.segments : [])
            .filter(segment => segment?.type === 'at')
            .map(segment => String(segment.qq ?? ''))
            .filter(id => id !== ''))];
        atMark = ids.length === 0
            ? '【@对象】无（本条由 ' + (nickname === '' ? userId : nickname) + '(' + userId + ') 发出，没有@任何人）\n'
            : '【@对象】' + describeAt(ids, cfg, nickname, userId);
        head = buildGroupMessagePrefix(nickname === '' ? userId : nickname, userId, batch.atMe, at);
    }

    return senderMark + sceneMark + atMark
        + head
        + wrapUserMessage(body, userId, nickname === '' ? userId : nickname);
}
