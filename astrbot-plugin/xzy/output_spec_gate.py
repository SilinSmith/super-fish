"""出站规范校验（只判不改）——挂在 `on_decorating_result` 的 `review_gate` 之后。

对照 `inst/data/xzy/output-spec.json` 校验「真正要发出去的那条文本」：

- 字数：`len(plain) > reply.maxChars` → `over-limit`
- emoji 频率：emoji 码点数 / 字数 × 100 > `reply.emojiPer100` → `emoji-high`
- 口癖：**窗口口径（2026-11-15 起）**——注入文字写的是「不用每条都带」，所以单条没带不算违规；
  只有「最近 20 条出站（含当前这条）一次都没出现任何 active 口癖」才判 `quirk-missed`；
  单条内同一口癖出现 >2 次 → `quirk-overused`（这条仍是单条判据）。
- 空行分段：命中 `\\n\\s*\\n` → `blank-line`（只观测；插件没有分条发送实现，没有对应开关）
- 语气 / 幽默度：没有客观判据，不判违规，只把 `specRevision` 记进审计供人工对照

**历史行口径说明（不改写旧行）**：`audit/output_spec.jsonl` 里 2026-11-15 20:19 之前写入的行
（首轮 3 条：20:18:11 / 20:18:31 / 20:19:12）用的是「逐条口径」——`violations` 里出现
`quirk-missed` 的含义是「**这一条**没带口癖」，**不是**「20 条窗口全空」。新行一律带
`judgeMode="window-20"` 与 `quirkWindow` 字段；没有 `judgeMode` 的行就是旧口径，下游
（`self_iter._recent_violations`）会按 `legacy-per-message` 标注出来，不会当成新口径证据。
窗口计算只读历史行的 `quirkHits`（事实字段：这条里命中了哪些口癖），与判定口径无关，
所以旧行可以安全参与窗口统计。

**绝不改写、绝不丢弃**：丢弃是二审的职责。合规也写一行，`violations` 为空数组。
落点：`inst/data/xzy/audit/output_spec.jsonl`，写盘失败只告警。
"""

from __future__ import annotations

import json
import os
import re
import time
from typing import Any

try:  # 插件包内导入
    from . import mutation_policy
except ImportError:  # AstrBot 以模块方式加载
    import mutation_policy  # type: ignore

try:
    from astrbot.api import logger as _logger
except ImportError:  # 单测 / 直调时允许没有 AstrBot
    _logger = None

AUDIT_FILE = "output_spec.jsonl"

_SKIP_CONTENT_TYPES = {"STREAMING_RESULT", "STREAMING_FINISH"}

# emoji 码点区（不含 ZWJ / VS16，避免一个表情被算成两三次）
_EMOJI_RE = re.compile(
    "[\U0001F000-\U0001F0FF\U0001F300-\U0001FAFF\U0001F1E6-\U0001F1FF\U00002600-\U000027BF]"
)
_BLANK_LINE_RE = re.compile(r"\n\s*\n")
_QUIRK_OVERUSE_LIMIT = 2
# 口癖窗口：最近 N 条出站（含当前这条）。只用于 quirk-missed，见模块头「窗口口径」。
QUIRK_WINDOW = 20
_TAIL_BYTES = 131072


def _audit_path() -> str:
    base = os.environ.get("XZY_STATE_DIR")
    if base:
        return os.path.join(base, "audit", AUDIT_FILE)
    data_root = os.path.abspath(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
    )
    return os.path.join(data_root, "xzy", "audit", AUDIT_FILE)


def _tail_rows(path: str, limit: int) -> list[dict[str, Any]] | None:
    """读 JSONL 尾部最多 limit 行；文件打不开返回 None（与「文件为空」区分开）。"""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - _TAIL_BYTES))
            chunk = f.read()
    except OSError:
        return None
    rows: list[dict[str, Any]] = []
    for line in chunk.split(b"\n")[-(limit + 2) :]:
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line.decode("utf-8", "replace"))
        except ValueError:  # 包括 seek 截断的首行
            continue
        if isinstance(row, dict) and "wall_ms" in row:
            rows.append(row)
    return rows[-limit:]


def quirk_window(lookback: int = QUIRK_WINDOW) -> dict[str, Any] | None:
    """最近 lookback-1 条历史出站的「有没有出现过口癖」。读不到返回 None（此时不判 missed）。"""
    rows = _tail_rows(_audit_path(), max(0, lookback - 1))
    if rows is None:
        return None
    hit_rows = sum(1 for row in rows if row.get("quirkHits"))
    return {"lookback": lookback, "rows": len(rows), "hitRows": hit_rows, "hit": hit_rows > 0}



def _append_audit(record: dict[str, Any]) -> None:
    try:
        path = _audit_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
            f.flush()
    except Exception as exc:  # noqa: BLE001 - 审计失败不影响发送
        _log("error", f"output_spec audit 写入失败: {exc}")


def _log(level: str, message: str) -> None:
    line = f"[xzy-spec] {message}"
    if _logger is not None:
        getattr(_logger, level, _logger.info)(line)
    else:  # pragma: no cover - 无 AstrBot 环境
        print(line)


def _plain_text(result: Any) -> str:
    try:
        text = result.get_plain_text()
    except Exception:  # noqa: BLE001
        text = ""
    if isinstance(text, str) and text.strip():
        return text
    parts = [
        str(getattr(comp, "text", "") or "")
        for comp in (getattr(result, "chain", None) or [])
        if comp.__class__.__name__ == "Plain"
    ]
    return " ".join(part for part in parts if part)


def _content_type_name(result: Any) -> str:
    ctype = getattr(result, "result_content_type", None)
    return str(getattr(ctype, "name", ctype) or "")


def _umo(event: Any) -> str:
    return str(getattr(event, "unified_msg_origin", "") or "")


def check_text(
    text: str,
    spec: dict[str, Any],
    *,
    window: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """纯判定：返回字数 / emoji / 口癖命中 / 违规码，供审计与测试。

    ``window`` 是 `quirk_window()` 的结果：最近 19 条历史出站有没有出现过口癖。
    传 None（读不到历史）时不判 ``quirk-missed``，避免因为审计文件缺失而误报。
    """
    reply = spec.get("reply") if isinstance(spec.get("reply"), dict) else {}
    quirks = spec.get("quirks") if isinstance(spec.get("quirks"), dict) else {}
    max_chars = int(reply.get("maxChars") or 120)
    emoji_per100 = int(reply.get("emojiPer100") or 0)
    plain = text or ""
    chars = len(plain)
    emoji = len(_EMOJI_RE.findall(plain))
    rate = round(emoji * 100 / chars, 1) if chars else 0.0
    hits: list[dict[str, Any]] = []
    for row in quirks.get("active") or []:
        if not isinstance(row, dict):
            continue
        phrase = str(row.get("text") or "")
        if phrase == "":
            continue
        count = plain.count(phrase)
        if count:
            hits.append({"id": str(row.get("id") or ""), "text": phrase, "count": count})
    violations: list[str] = []
    if chars > max_chars:
        violations.append("over-limit")
    if emoji_per100 >= 0 and rate > emoji_per100:
        violations.append("emoji-high")
    active_total = len([row for row in (quirks.get("active") or []) if isinstance(row, dict)])
    # 窗口口径：单条没带口癖不算违规；只有最近 20 条（含本条）全都没出现才判。
    if active_total and not hits and window is not None and not window.get("hit"):
        violations.append("quirk-missed")
    if any(int(item.get("count") or 0) > _QUIRK_OVERUSE_LIMIT for item in hits):
        violations.append("quirk-overused")
    if _BLANK_LINE_RE.search(plain):
        violations.append("blank-line")
    return {
        "specRevision": int(spec.get("revision") or 0),
        "chars": chars,
        "maxChars": max_chars,
        "emoji": emoji,
        "emojiPer100": rate,
        "quirkHits": hits,
        "violations": violations,
        # 判定口径要进审计：没有这两个字段的历史行 = 旧「逐条口径」。
        "judgeMode": "window-20",
        "quirkWindow": {
            "lookback": QUIRK_WINDOW,
            "prevRows": int((window or {}).get("rows") or 0),
            "prevHitRows": int((window or {}).get("hitRows") or 0),
            "hit": bool(hits) or bool((window or {}).get("hit")),
            "readable": window is not None,
        },
    }


def audit_text(text: str, umo: str = "", stage: str = "gate") -> dict[str, Any] | None:
    """对一段「确定已出站」的正文走同一套判定并落审计行，返回 checks。

    给不经 `on_decorating_result` 的直发路径用（`send_dedupe` 的 builtin_tool
    工具直发），让它们也写 `audit/output_spec.jsonl`，否则这些出站没有审计行。
    空正文返回 None，不写行。
    """
    text = text or ""
    if not text.strip():
        return None
    spec = mutation_policy.read_output_spec()
    window = quirk_window()
    checks = check_text(text, spec, window=window)
    wall_ms = int(time.time() * 1000)
    _append_audit(
        {
            "wall": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "wall_ms": wall_ms,
            "umo": str(umo or ""),
            "stage": stage,
            "chars": checks["chars"],
            "maxChars": checks["maxChars"],
            "emojis": checks["emoji"],
            "emojiPer100": checks["emojiPer100"],
            "quirkHits": checks["quirkHits"],
            "violations": checks["violations"],
            "specRevision": checks["specRevision"],
            "judgeMode": checks["judgeMode"],
            "quirkWindow": checks["quirkWindow"],
            "textHead": text[:200],
        }
    )
    if checks["violations"]:
        _log(
            "warn",
            f"出站规范违规 {checks['violations']} chars={checks['chars']}/{checks['maxChars']} "
            f"emoji={checks['emojiPer100']}% quirkHits={len(checks['quirkHits'])} "
            f"windowHit={checks['quirkWindow']['hit']}"
            f"({checks['quirkWindow']['prevHitRows']}/{checks['quirkWindow']['prevRows']}) "
            f"stage={stage} umo={umo}",
        )
    return checks


def check_event(event: Any, cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    """判定本轮出站文本；不改 result、不清 result。"""
    result = None
    try:
        result = event.get_result()
    except Exception as exc:  # noqa: BLE001
        _log("error", f"取 result 失败，跳过规范校验: {exc}")
    if result is None:
        return {"checks": None, "skipped": "no-result"}
    if _content_type_name(result) in _SKIP_CONTENT_TYPES:
        return {"checks": None, "skipped": "streaming"}
    text = _plain_text(result)
    if not text.strip():
        return {"checks": None, "skipped": "no-text"}
    checks = audit_text(text, _umo(event), stage="decorating_result")
    return {"checks": checks, "skipped": ""}
