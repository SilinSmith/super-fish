/**
 * 出站防复读：模型偶尔把注入的上下文整段抄回来（发送者标记 / 场景标记 /
 * 群聊消息头）。这些行一旦进 QQ 就是内部结构泄漏，出站前统一剪掉。
 *
 * 另外，人格设定（character.md「## 内心」）要求模型把思考写进 `【内心】...`，
 * 不想接话时"只输出【内心】保持安静"。所以【内心】不是故障，是**主动静默**：
 * 这里要把整段思考都剥掉（含不带标记的续行），并把"全是内心"归类成 silent，
 * 由调用方保持沉默，而不是伪造一句道歉。
 *
 * 多段思考：模型只在第一段写【内心】，后面空行隔开的续段不再带标签
 * （约 1/10 的回复会这样）。只认首段标签会把后续思考漏进正文，所以这里
 * 按段落判断「思考续段」：剥到最后一个像思考的段落，其余才算正文。
 */
const MARKER_LINE_RE = /^\s*(?:【发送者标记】|【场景标记】|【@对象】|【撤回标记】|\[群聊[^\]]*\]|\[\d{1,2}:\d{2}\s[^\]]*\]\s*(?:\[@我\])?)/u;
// 行首可能是半角空格/Tab，也可能是全角空格（中文缩进）、不换行空格或零宽字符；
// 只容忍 [ \t] 会把「行首带全角空格的【内心】」判成正文，整段思考因此下发给插件。
const INNER_LINE_RE = /^[\s\u200B-\u200D]*【内心】/mu;
// 零宽字符不在 JS \s 里，也不受 trim 影响，判空前单独丢掉。
const ZERO_WIDTH_RE = /[\u200B-\u200D]/gu;

/** 判断一段文本是否"实际上为空"：NFKC 折完全角/不换行空格，去掉零宽字符后再 trim。 */
export function isEffectivelyEmpty(text) {
    if (typeof text !== 'string')
        return true;
    return text.normalize('NFKC').replace(ZERO_WIDTH_RE, '').trim() === '';
}
// 模型会给答案自己加标题，而且每轮换一个词（【正文】【回复】【回应】…）。
// 词表追不上，改成通用规则：整行只有一个短方括号标签时整行丢弃；
// 标签后面跟着正文的，只摘标签保留正文。
const LABEL_PREFIX_RE = /^\s*【(?:正文|回复|回答|发言|聊天回复|回应|最终|结论)】\s*/u;
const BARE_LABEL_RE = /^\s*【[^】\n]{1,8}】\s*$/u;
// 「分析内容：」「最终结论：」这类独占一行的元话语同样丢掉。
const META_CAPTION_RE = /^\s*(?:分析|思考|推理|判断|说明|理由|结论|最终|正文|回复)[^：:\n]{0,4}[:：]\s*$/u;
// 判断一个段落是不是「思考续段」。只收强信号词，避免把「不过我觉得可以」
// 这类正常接话误判成思考；命中任意一个就继续往下剥。
const THINKING_CUE_RE = /(?:分析|思考|推理|判断|对方|用户|群友|这轮|这段|这句|他这|她这|他刚才|她刚才|他可能|她可能|需要|应该|不能|先观察|先看|先想|先别|得先|接不接|说不说|怎么回|回一句|要不要回|不用回|不用接|不必回|不接|不回|潜水|保持安静)/u;

function isEchoLine(line) {
    return MARKER_LINE_RE.test(line) || BARE_LABEL_RE.test(line) || META_CAPTION_RE.test(line);
}

function stripLabel(line) {
    return line.replace(LABEL_PREFIX_RE, '');
}

// 模型会把「回复：/回复 某人：」当成发言格式写在正文开头（源头是入站合并消息模板
// 「…不要逐条回复：」）。只在消息开头剥一层，正文中间出现的“回复”不动。
const REPLY_LABEL_RE = /^\s*回复(?:\s*@[^\s：:]{1,30}|\s*[^\s：:，,。！？!?]{1,12})?\s*[：:]\s*/u;
const REPLY_AT_LABEL_RE = /^\s*回复\s*@[^\s：:]{1,30}(?=\s|$)\s*/u;

export function stripReplyLabel(text) {
    if (typeof text !== 'string' || text === '')
        return text;
    return text.replace(REPLY_LABEL_RE, '').replace(REPLY_AT_LABEL_RE, '');
}

/** 逐行清理：丢掉结构标记、裸标签、元话语，摘掉正文标签。 */
function cleanLines(lines) {
    const kept = [];
    for (const line of lines) {
        if (line.trim() === '') {
            kept.push(line);
            continue;
        }
        if (isEchoLine(line))
            continue;
        const withoutLabel = stripLabel(line);
        if (withoutLabel.trim() === '')
            continue;
        kept.push(withoutLabel);
    }
    return kept.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}

export function stripPromptEcho(text) {
    if (typeof text !== 'string' || text === '')
        return text;
    const lines = text.split(/\r?\n/u);
    const firstInner = lines.findIndex(line => INNER_LINE_RE.test(line));

    // 没有【内心】：沿用逐行清理。
    if (firstInner < 0)
        return stripReplyLabel(cleanLines(lines));

    // 有显式正文标签：标签之后全是正文，前面（含思考）整段丢掉。
    const bodyLabel = lines.findIndex((line, index) => index > firstInner && LABEL_PREFIX_RE.test(line));
    if (bodyLabel >= 0)
        return stripReplyLabel(cleanLines(lines.slice(bodyLabel)));

    // 没有正文标签：把首段之后按空行切成段落，剥到最后一个「像思考」的段落。
    const paragraphs = [];
    let current = [];
    for (const line of lines.slice(firstInner + 1)) {
        if (line.trim() === '') {
            if (current.length > 0) {
                paragraphs.push(current.join('\n').trim());
                current = [];
            }
            continue;
        }
        if (isEchoLine(line))
            continue;
        const withoutLabel = stripLabel(line);
        if (withoutLabel.trim() === '')
            continue;
        current.push(withoutLabel);
    }
    if (current.length > 0)
        paragraphs.push(current.join('\n').trim());

    const kept = paragraphs.filter(item => item !== '');
    if (kept.length === 0)
        return '';
    let start = 0;
    for (let index = 0; index < kept.length; index += 1) {
        if (THINKING_CUE_RE.test(kept[index]))
            start = index + 1;
    }
    return stripReplyLabel(kept.slice(start).join('\n\n').replace(/\n{3,}/gu, '\n\n').trim());
}

/** 把一次模型的原始输出分类，决定出站怎么处理。
 *
 * - `text`     剥完还有正文 → 正常发出
 * - `silent`   剥完为空，但原文有【内心】→ 模型这轮选择不说话，不要伪造台词
 * - `echo-only`剥完为空，且只有结构标记 → 是回声故障，值得重生成一次
 * - `empty`    上游本来就返回空 → 交给下游的空回复计数逻辑
 */
export function classifyEcho(rawContent) {
    const text = stripPromptEcho(rawContent);
    if (typeof text !== 'string')
        return { kind: 'text', text: text ?? '' };
    // 剥完只剩空白/全角空格/零宽字符也算空，不能按原始串比较。
    if (!isEffectivelyEmpty(text))
        return { kind: 'text', text };
    const raw = typeof rawContent === 'string' ? rawContent : '';
    if (isEffectivelyEmpty(raw))
        return { kind: 'empty', text: '' };
    if (INNER_LINE_RE.test(raw))
        return { kind: 'silent', text: '' };
    return { kind: 'echo-only', text: '' };
}
