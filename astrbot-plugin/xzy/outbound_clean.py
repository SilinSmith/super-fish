"""出站窄清洗：草稿格式（候选/最终）与人格内心标记（【内心】）。

规则（不做通用清洗）：
- 文本里没有 `最终：` / `最终:` 标记，且不以 `候选：`/`候选:` 开头 -> 一字不动。
- 以 `候选：`/`候选:` 开头且整段没有 `最终：` -> 整条不出站（沉默优于发草稿），
  不猜哪句是正文。
- 有标记 -> 只保留**最后一个**标记之后的内容。
- 标记之后若还残留 `候选：` 段 -> 从该段起截掉。
- 提取结果为空 -> 整体不出站（由调用方清空 result）。
- `【内心】` 是人格声明的私有思考（character.md「## 内心」），只在本机可见：
  出站前整段剥掉，剥完没有正文就整条不出站（模型主动静默）。
"""
from __future__ import annotations

import re
from typing import Any

FINAL_MARKERS = ("最终：", "最终:")
CAND_MARKERS = ("候选：", "候选:")
# 只认行首的草稿前缀；911 线上帧是「候选回复：」，同属这一形态
_CAND_PREFIX = re.compile(r"^候选(?:回复)?[：:]")

# 搬自旧栈 echo-guard.mjs：行首可能是半角/全角空格、不换行空格或零宽字符
_INNER_LINE = re.compile(r"^[\s\u200B-\u200D]*【内心】", re.M)
# 自称标签前缀：模型/人格让它「每条回复都以【墨鱼】开头」时留下的行首标签。
# 只剥行首，正文里的【内心】等语义标签不动。
_SELF_TAG = re.compile(r"^[^\S\r\n]*(?:【\s*墨鱼\s*】|\[\s*墨鱼\s*\])\s*", re.M)
_ZERO_WIDTH = re.compile(r"[\u200B-\u200D]")
# 模型会给正文加标题且每轮换词，整行只有一个短方括号标签就丢；带正文的只摘标签
_LABEL_PREFIX = re.compile(r"^\s*【(?:正文|回复|回答|发言|聊天回复|回应|最终|结论)】\s*")
_BARE_LABEL = re.compile(r"^\s*【[^】\n]{1,8}】\s*$")
_META_CAPTION = re.compile(r"^\s*(?:分析|思考|推理|判断|说明|理由|结论|最终|正文|回复)[^：:\n]{0,4}[:：]\s*$")
# 只收强信号词，避免把「不过我觉得可以」这类正常接话误判成思考续段
_THINKING_CUE = re.compile(
    r"(?:分析|思考|推理|判断|对方|用户|群友|这轮|这段|这句|他这|她这|他刚才|她刚才|他可能|她可能|"
    r"需要|应该|不能|先观察|先看|先想|先别|得先|接不接|说不说|怎么回|回一句|要不要回|不用回|"
    r"不用接|不必回|不接|不回|潜水|保持安静)"
)
# 模型把私有思考写在 `【内心】` 下后，常以独占一行的 `</think>` 收尾，其后是正文。
# 这是显式边界，比按段数猜可靠。
_THINK_END = re.compile(r"^[^\S\r\n]*</think(?:ing)?>[^\S\r\n]*$", re.M)
_REPLY_LABEL = re.compile(r"^\s*回复(?:\s*@[^\s：:]{1,30}|\s*[^\s：:，,。！？!?]{1,12})?\s*[：:]\s*")
_REPLY_AT_LABEL = re.compile(r"^\s*回复\s*@[^\s：:]{1,30}(?=\s|$)\s*")

# 系统提示 / 注入块的指纹：命中即整条不出站（2026-11-17 事故：模型把「工具上限」
# 系统通知当成用户消息回答，并作为正文发给主人）。只收高区分度字面量，
# 都是 system_prompt 里的固定标记或核心运行时通知，正常接话不会出现。
SYSTEM_FINGERPRINTS: tuple[tuple[str, str], ...] = (
    ("persona-inject-mark", "【人格设定 · 只读】"),
    ("persona-inject-end", "【人格设定 · 结束】"),
    ("native-persona-header", "# Persona Instructions"),
    ("image-criteria", "【看图口径】"),
    ("working-memory", "## 本轮工作记忆"),
    ("sender-mark", "【发送者标记】"),
    ("scene-mark", "【场景标记】"),
    ("group-context-mark", "【同群其他人的消息"),
    ("output-spec", "## 输出规范（每轮都按这个来）"),
    ("static-rules-memory", "## 记忆怎么用"),
    ("static-rules-task", "## 任务怎么用"),
    ("static-rules-reply", "## 现在怎么回"),
    ("self-identity", "## 你自己是谁"),
    ("tool-cap-notice", "不要再用工具，直接回答"),
    ("max-steps-notice", "Agent reached max steps"),
)
# 带数字的运行时通知（条数每轮不同），用正则兜
SYSTEM_FINGERPRINT_RES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("tool-cap-count", re.compile(r"本轮(?:已)?调用\s*\d+\s*次工具[，,]?\s*超(?:过|出)上限")),
)

# 「机制自述」：只在撞过工具步数上限的回合里启用（见 clean_outbound 的 cap_tripped）。
# 2026-11-17 事故原文：「行，工具用完了，我这边也没挂着的活，就到此为止。」
# 收紧到「工具/调用 + 上限/用完」这类搭配，避免误伤正常聊天里的「工具」二字。
_MECHANISM_TALK_RES: tuple[re.Pattern[str], ...] = (
    re.compile(r"工具(?:已经|都)?(?:用完|用满|到(?:了)?上限|上限)"),
    re.compile(r"(?:调用|工具)(?:次数)?[^，。！？\n]{0,6}超(?:过|出)上限"),
    re.compile(r"本轮[^，。！？\n]{0,10}工具"),
    re.compile(r"多步任务"),
    re.compile(r"系统(?:提示|通知|消息|发的)"),
)


def _effectively_empty(text: str) -> bool:
    return _ZERO_WIDTH.sub("", text).strip() == ""


def _clean_lines(lines: list[str]) -> str:
    kept: list[str] = []
    for line in lines:
        if line.strip() == "":
            kept.append(line)
            continue
        if _BARE_LABEL.match(line) or _META_CAPTION.match(line):
            continue
        stripped = _LABEL_PREFIX.sub("", line)
        if stripped.strip() == "":
            continue
        kept.append(stripped)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(kept)).strip()


def _strip_reply_label(text: str) -> str:
    return _REPLY_LABEL.sub("", _REPLY_AT_LABEL.sub("", text))


def _strip_quotes(text: str) -> str:
    """去掉引号内的引用内容，避免把「别人说过的话」当成自我改口。"""
    return re.sub(r"「[^」]*」|“[^”]*”|\"[^\"]*\"|『[^』]*』", "", text or "")


# 自我改口链的形态信号（不按某个词做黑名单，按"先肯定→打断→改口→再裁定"的结构）
_FIX_BREAK = re.compile(r"[，,、…。；;．.]\s*不对\s*[，,。…！!？?]")      # 「X，不对，Y」
_FIX_OH = re.compile(r"[。！!？?…．.]\s*哦\s*[，,]")                     # 句末「。哦，」自答
_FIX_WRONG = re.compile(r"([\u4e00-\u9fa5A-Za-z0-9]{1,10})是错的")       # 「X 是错的」
_FIX_MARK = re.compile(r"等等[，,]|说错了|记错了|不是不是|纠正一下|重来[，,]")
_SELF_START = re.compile(r"^\s*(不对|不是)[，,]")                        # 句子以「不对，」开头
_QUOTE_SPLIT = re.compile(r"[。！？!?…\n]+")


def looks_unfinalized(text: str) -> tuple[bool, list[str]]:
    """判断一段文本是不是「还没定稿的自我改口/自问自答」。

    按结构识别（打断→改口→再裁定），不按单个词做黑名单；引号内引用先剔掉。
    同一句里要凑够 2 分才算，单类信号放行。
    """
    body = _strip_quotes(text)
    marks: list[str] = []
    score = 0
    sentences = [s.strip() for s in _QUOTE_SPLIT.split(body) if s.strip()]
    for index, sentence in enumerate(sentences):
        local = 0
        local_marks: list[str] = []
        if _FIX_BREAK.search(sentence):
            local += 2
            local_marks.append("break")
        match = _SELF_START.match(sentence)
        if match and index > 0 and not re.search(r"你|您", sentence):
            # 上一句已经说完，这句以「不对，」打断自己，且不是在反驳对话人
            local += 2
            local_marks.append("self-start")
        for term in _FIX_WRONG.findall(sentence):
            # 只有同一个词在本句前面被肯定过，才算自我否定（否则是评价别人的话）
            if sentence.count(term) >= 2:
                local += 1
                local_marks.append(f"judge:{term}")
                break
        marker_hits = len(_FIX_MARK.findall(sentence))
        if marker_hits:
            local += min(marker_hits, 2)
            local_marks.append("marker")
        if local > score:
            score = local
            marks = local_marks
    if _FIX_OH.search(body):
        score += 2
        marks = marks + ["self-answer"]
    return score >= 2, marks


def strip_inner(text: str) -> dict[str, Any]:
    """剥掉 `【内心】` 思考段；剥完为空表示模型这轮选择不说话。

    返回 {"text", "hit", "silent"}；没有内心标记时 text 与入参一字不差。
    """
    raw = text or ""
    lines = raw.split("\n")
    first = next((i for i, line in enumerate(lines) if _INNER_LINE.match(line)), -1)
    if first < 0:
        return {"text": raw, "hit": False, "silent": False, "held": ""}

    # `【内心】` 之后若有显式 `</think>` 边界，其后即正文，直接取用，不按段数猜。
    think_end = next(
        (i for i in range(first + 1, len(lines)) if _THINK_END.match(lines[i])),
        -1,
    )
    if think_end >= 0:
        out = _strip_reply_label(_clean_lines(lines[think_end + 1:]))
        return {"text": out, "hit": True, "silent": _effectively_empty(out), "held": ""}

    body_label = next(
        (i for i in range(first + 1, len(lines)) if _LABEL_PREFIX.match(lines[i])),
        -1,
    )
    if body_label >= 0:
        out = _strip_reply_label(_clean_lines(lines[body_label:]))
        return {"text": out, "hit": True, "silent": _effectively_empty(out)}

    paragraphs: list[str] = []
    current: list[str] = []
    for line in lines[first + 1:]:
        if line.strip() == "":
            if current:
                paragraphs.append("\n".join(current).strip())
                current = []
            continue
        if _BARE_LABEL.match(line) or _META_CAPTION.match(line):
            continue
        stripped = _LABEL_PREFIX.sub("", line)
        if stripped.strip() == "":
            continue
        current.append(stripped)
    if current:
        paragraphs.append("\n".join(current).strip())

    kept = [p for p in paragraphs if p]
    if len(kept) >= 2:
        # `【内心】` 之后没有任何显式正文标签（走到这里就说明没有），且不止一段：
        # 边界只能猜。2026-11-15 17:17:31 就是猜错——4 段结论式推理被当正文发进群。
        # 不再猜：整条记为未提交草稿（held），由草稿本兜住，等模型显式提交。
        return {"text": "", "hit": True, "silent": True, "held": "\n\n".join(kept)}
    start = 0
    for index, item in enumerate(kept):
        if _THINKING_CUE.search(item):
            start = index + 1
    out = _strip_reply_label(re.sub(r"\n{3,}", "\n\n", "\n\n".join(kept[start:])).strip())
    return {"text": out, "hit": True, "silent": _effectively_empty(out), "held": ""}


def strip_self_tag(text: str) -> dict[str, Any]:
    """剥掉行首的自称标签 `【墨鱼】` / `[墨鱼]`（含标签前后空白）。

    只认行首，正文里的 `【内心】` 等语义标签不动；没有命中时 text 与入参一字不差。
    """
    raw = text or ""
    if "墨鱼" not in raw:
        return {"text": raw, "hit": False, "stripped": 0}
    out, count = _SELF_TAG.subn("", raw)
    if not count:
        return {"text": raw, "hit": False, "stripped": 0}
    return {"text": out, "hit": True, "stripped": count}


def system_fingerprint(text: str) -> str:
    """命中系统提示/注入块时返回 `标签:片段`，否则返回空串。"""
    body = text or ""
    if not body:
        return ""
    for label, needle in SYSTEM_FINGERPRINTS:
        if needle in body:
            return f"{label}:{needle}"
    for label, pattern in SYSTEM_FINGERPRINT_RES:
        match = pattern.search(body)
        if match:
            return f"{label}:{match.group(0)}"
    return ""


def mechanism_talk(text: str) -> str:
    """命中「机制自述」（工具用完/调用上限/系统提示）时返回命中片段，否则空串。"""
    body = text or ""
    for pattern in _MECHANISM_TALK_RES:
        match = pattern.search(body)
        if match:
            return match.group(0)
    return ""


def _drop_mechanism_talk(result: dict[str, Any], cap_tripped: bool) -> None:
    """撞过工具上限的回合里，「工具用完/调用上限/系统提示」这类正文整条不出站。"""
    if not cap_tripped or result.get("dropped"):
        return
    hit = mechanism_talk(str(result.get("text") or ""))
    if not hit:
        return
    result.update(
        text="",
        cleaned_chars=0,
        dropped=True,
        reason="held:mechanism-talk",
        fingerprint=f"mechanism-talk:{hit}",
    )


def clean_outbound(text: str, cap_tripped: bool = False) -> dict[str, Any]:
    """出站清洗总入口：先拦系统提示/注入块，再剥 `【内心】` 与行首自称标签，
    再走「候选/最终」窄清洗，最后拦未定稿改口。

    cap_tripped=True（本回合撞过工具步数上限）时，额外拦「机制自述」正文：
    那类内容通常是在回答 AstrBot 注入的「工具调用次数已达到上限…」。
    """
    fingerprint = system_fingerprint(text)
    if fingerprint:
        # 系统内容整条不出站，也不进草稿本（草稿本是给人格续写用的，不是系统文本）
        return {
            "hit": True,
            "text": "",
            "original_chars": len(text or ""),
            "cleaned_chars": 0,
            "cut_candidate": False,
            "dropped": True,
            "reason": "held:system-fingerprint",
            "inner_hit": False,
            "self_tag_hit": False,
            "self_tag_stripped": 0,
            "held": "",
            "hold_reason": "",
            "fingerprint": fingerprint,
        }
    inner = strip_inner(text)
    self_tag = strip_self_tag(inner["text"])
    # 裸的正文标签（【回复】/【正文】…）也剥：不是内心段时原来会原样发出去
    labeled = _LABEL_PREFIX.sub("", self_tag["text"])
    label_hit = labeled != self_tag["text"]
    result = clean_final_only(labeled)
    result["inner_hit"] = inner["hit"]
    result["self_tag_hit"] = self_tag["hit"]
    result["self_tag_stripped"] = self_tag["stripped"]
    result["held"] = inner.get("held") or ""
    result["hold_reason"] = "held:unlabeled-multi" if result["held"] else ""
    result["original_chars"] = len(text or "")
    if not inner["hit"] and not self_tag["hit"] and not label_hit:
        _hold_unfinalized(result)
        _drop_mechanism_talk(result, cap_tripped)
        return result
    result["hit"] = True
    if inner["hit"] and inner["silent"]:
        reason = "held:unlabeled-multi" if result["held"] else "inner-silent"
        result.update(text="", cleaned_chars=0, dropped=True, reason=reason)
        return result
    if _effectively_empty(str(result["text"] or "")):
        # 整条只剩标签（如「【墨鱼】」）：剥完没正文，整条不出站
        result.update(text="", cleaned_chars=0, dropped=True, reason="empty-after-strip")
        return result
    _hold_unfinalized(result)
    _drop_mechanism_talk(result, cap_tripped)
    if result.get("dropped"):
        return result
    marks = []
    if inner["hit"]:
        marks.append("inner-stripped")
    if self_tag["hit"]:
        marks.append("self-tag-stripped")
    if label_hit:
        marks.append("label-stripped")
    if result["reason"]:
        marks.append(result["reason"])
    result["reason"] = "+".join(marks)
    return result


def _hold_unfinalized(result: dict[str, Any]) -> None:
    """自我改口/自问自答 = 未定稿：整条转草稿本，不出站。"""
    body = str(result.get("text") or "")
    if not body or result.get("dropped"):
        return
    unfinalized, marks = looks_unfinalized(body)
    if not unfinalized:
        return
    result.update(
        held=body,
        text="",
        cleaned_chars=0,
        dropped=True,
        reason="held:self-correction",
        hold_reason="held:self-correction",
        hold_marks=marks,
    )


def _last_marker(text: str, markers: tuple[str, ...]) -> tuple[int, str]:
    best_idx = -1
    best_mark = ""
    for mark in markers:
        idx = text.rfind(mark)
        if idx > best_idx:
            best_idx, best_mark = idx, mark
    return best_idx, best_mark


def _first_marker(text: str, markers: tuple[str, ...]) -> int:
    found = [text.find(mark) for mark in markers if text.find(mark) >= 0]
    return min(found) if found else -1


def clean_final_only(text: str) -> dict[str, Any]:
    original = text or ""
    idx, mark = _last_marker(original, FINAL_MARKERS)
    result: dict[str, Any] = {
        "hit": False,
        "text": original,
        "original_chars": len(original),
        "cleaned_chars": len(original),
        "cut_candidate": False,
        "dropped": False,
        "reason": "",
    }
    if idx < 0:
        # 只有候选、没有最终：不猜正文，整条不发
        if _CAND_PREFIX.match(original.strip()):
            result.update(
                hit=True,
                text="",
                cleaned_chars=0,
                dropped=True,
                reason="candidate-only",
            )
        return result

    rest = original[idx + len(mark):]
    cand_idx = _first_marker(rest, CAND_MARKERS)
    if cand_idx >= 0:
        rest = rest[:cand_idx]
        result["cut_candidate"] = True

    cleaned = rest.strip().rstrip("、,，").strip()
    result["text"] = cleaned
    result["cleaned_chars"] = len(cleaned)
    result["dropped"] = not cleaned
    result["hit"] = True
    result["reason"] = "empty-after-final" if result["dropped"] else "final-extracted"
    return result


def apply_text(result: Any, cleaned: str) -> bool:
    """把 result 里的 Plain 文本换成 cleaned，保留 At/Image 等其他段。

    返回是否成功替换；没有 Plain 段时返回 False。
    """
    chain = getattr(result, "chain", None)
    if not chain:
        return False
    try:
        from astrbot.core.message.components import Plain
    except Exception:  # noqa: BLE001
        return False

    first = None
    for comp in chain:
        if isinstance(comp, Plain):
            if first is None:
                comp.text = cleaned
                first = comp
            else:
                comp.text = ""
    return first is not None
