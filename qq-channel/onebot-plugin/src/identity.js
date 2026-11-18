/**
 * 发送者身份解析：主人 / 管理员 / 机器人 / 普通用户。
 *
 * 只认人工声明：bot.masterQQ、bot.adminUsers、bot.knownBots。
 * 不从 selfId、旧配置迁移、运行时行为里推断主人身份——机器人账号哪怕
 * 同时出现在主人列表里，也一律按机器人处理，不能触发主人级指令。
 */

export function isBotSender({ userId, selfId, cfg }) {
    const qq = String(userId ?? '');
    if (qq === '')
        return false;
    if (String(selfId ?? '') !== '' && qq === String(selfId))
        return true;
    const known = [
        String(cfg?.bot?.qq ?? ''),
        ...(cfg?.bot?.knownBots ?? []).map(String),
    ].filter(item => item !== '');
    return known.includes(qq);
}

export function classifySender({ userId, selfId, cfg }) {
    const qq = String(userId ?? '');
    const bot = isBotSender({ userId: qq, selfId, cfg });
    const isAdmin = !bot && (cfg?.bot?.adminUsers ?? []).map(String).includes(qq);
    const isMaster = !bot && qq !== '' && qq === String(cfg?.bot?.masterQQ ?? '');
    return {
        qq,
        bot,
        isMaster,
        isAdmin,
        role: isMaster ? 'master' : (isAdmin ? 'admin' : (bot ? 'bot' : 'user')),
    };
}

/** 主人级操作一律走这个判断：机器人、未知账号、管理员都不算。 */
export function canUseMasterCommand({ userId, selfId, cfg }) {
    return classifySender({ userId, selfId, cfg }).isMaster;
}
