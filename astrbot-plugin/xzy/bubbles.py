"""出站拆条：把一条长回复按句子边界拆成 1~3 条 QQ 消息。

规则（都是硬约束，不做语言模型猜测）：
- 按句号/问号/叹号/省略号/换行切句，**只在句子边界切**，绝不出半句话；
- 短回复（<= min_chars，默认 15 字）不拆，避免「好。」被拆成两段；
- 每段 <= max_chars（默认 45 字）；单句本身超长时整句保留，不硬切；
- 最多 max_parts（默认 3）段，超了就把尾段合并，宁少勿多；
- 段尾短于 min_tail（默认 6 字）时并进上一段，避免「。嗯。」单独一条。
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime
from typing import Any

AUDIT_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "xzy", "audit", "bubbles.jsonl"
)

_ENDS = "。！？!?…"
_EMOJI_ONLY = re.compile(r"^[\s\U0001F300-\U0001FAFF\u2600-\u27BF\uFE0F]+$")


def _sentences(text: str) -> list[str]:
    out: list[str] = []
    buf = ""
    for ch in text:
        if ch == "\n":
            if buf.strip():
                out.append(buf.strip())
            buf = ""
            continue
        buf += ch
        if ch in _ENDS:
            out.append(buf.strip())
            buf = ""
    if buf.strip():
        out.append(buf.strip())
    return out


def split_bubbles(
    text: str,
    max_chars: int = 45,
    max_parts: int = 3,
    min_chars: int = 16,
    min_tail: int = 6,
) -> list[str]:
    """返回要按顺序发出的多段文本；返回 [原文] 表示不拆。"""
    body = (text or "").strip()
    if not body:
        return [""]
    if len(body) <= min_chars or _EMOJI_ONLY.match(body):
        return [body]
    sentences = _sentences(body)
    if len(sentences) <= 1 and "\n" not in body:
        return [body]

    # 换行是硬边界（人换行基本就是换一条），行内再按句末标点攒段
    parts: list[str] = []
    for block in [ln.strip() for ln in body.split("\n") if ln.strip()]:
        current = ""
        for sentence in _sentences(block) or [block]:
            if current and len(current) + len(sentence) <= max_chars:
                current += sentence
            else:
                if current:
                    parts.append(current)
                current = sentence
        if current:
            parts.append(current)
    # 段数超上限：从尾部往前合并（合并是最安全的「不少发」手段）
    while len(parts) > max_parts:
        parts[-2] += parts[-1]
        parts.pop()
    # 尾段太短：并进上一段
    while len(parts) > 1 and len(parts[-1]) < min_tail:
        parts[-2] += parts[-1]
        parts.pop()
    if len(parts) <= 1:
        return [body]
    return parts


def describe(parts: list[str]) -> dict[str, Any]:
    """审计用：段数与各段字数（不落全文，全文已在 outbound.jsonl）。"""
    return {"parts": len(parts), "chars": [len(p) for p in parts]}


# 运行期配置（main.initialize 注入 cfg["bubbles"]），工具直发/草稿本共用同一份
_CFG: dict[str, Any] = {"enabled": True, "maxChars": 45, "maxParts": 3, "gapMs": 600}


def configure(cfg: dict[str, Any] | None = None) -> None:
    if isinstance(cfg, dict):
        _CFG.update({k: v for k, v in cfg.items() if v is not None})


def settings() -> dict[str, Any]:
    return dict(_CFG)


def split_text(text: str) -> list[str]:
    """按当前配置拆条；未启用时原样一段。"""
    if not _CFG.get("enabled", True):
        return [text]
    return split_bubbles(
        text, int(_CFG.get("maxChars") or 45), int(_CFG.get("maxParts") or 3)
    )


def audit(umo: str, **fields: Any) -> None:
    """拆段审计：段数/各段字数/实际发出的 message_id 都落这里。"""
    row = {"wall": datetime.now().isoformat(timespec="milliseconds"), "umo": umo}
    row.update(fields)
    try:
        os.makedirs(os.path.dirname(AUDIT_PATH), exist_ok=True)
        with open(AUDIT_PATH, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    except Exception:  # noqa: BLE001 审计失败不能影响发送
        pass
