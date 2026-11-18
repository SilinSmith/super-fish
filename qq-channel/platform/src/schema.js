// canonical event 契约常量与校验。
// 只做声明与只读校验，不参与线上渲染；线上行为由 event.js 唯一决定。

export const EVENT_V = 1;

// 以线上 buildEvent() 的实际输出为准（2026-11-12 核对：无 source 字段）。
export const REQUIRED_PATHS = [
    'v',
    'traceId',
    'ts',
    'kind',
    'chat.type',
    'chat.id',
    'chat.selfId',
    'actor.qq',
    'text',
    'flags',
];

const pick = (obj, path) => path.split('.').reduce((node, key) => (node === null || node === undefined ? undefined : node[key]), obj);

/** 返回错误列表；空数组表示通过。 */
export function validateEvent(evt) {
    if (evt === null || typeof evt !== 'object')
        return ['event 不是对象'];
    const errors = [];
    if (evt.v !== EVENT_V)
        errors.push('v 期望 ' + EVENT_V + ' 实际 ' + evt.v);
    for (const path of REQUIRED_PATHS) {
        const value = pick(evt, path);
        if (value === undefined || value === null || value === '')
            errors.push('缺字段 ' + path);
    }
    for (const qq of evt.mentions ?? []) {
        if (!/^(all|\d{5,12})$/u.test(String(qq)))
            errors.push('mentions 含非法 QQ: ' + qq);
    }
    if (evt.reply !== null && evt.reply !== undefined && typeof evt.reply.unresolved !== 'boolean')
        errors.push('reply.unresolved 必须是 boolean（三态不可退化）');
    return errors;
}
