"""接话判定：结构化字段 + 规则优先（模型只判灰区）。

分工（与 spec §15.13 对应）：
- 字段层：把「机器人最后一句是什么、多久之前说的、是不是问句、这条有没有 @/引用别人」
  从会话历史、出站台账里直接读出来，随判定 prompt 一起给模型，模型不再靠猜；
- 规则层：能确定性判的不进模型——
    R1 这条在跟别人说话（@别人 / 引用别人）→ 静默，不调模型；
    R2 机器人刚问过（≤ continuationWindowMs）且这条不是 @/引用别人 → 直接接话，不调模型；
- 灰区：R3（30s~120s）/ R4（没有时间戳）/ R5（其余）交给 `judge.py`。

时间戳来源优先级：
1. 进程内出站小账（`note_outbound`，monotonic 差值，最准）；
2. `audit/outbound.jsonl` 尾部（重启后补读，按行内 `wall_ms`）。
台账里都是「已经生成并放行的出站正文」，`【内心】` 行与空正文一律不计。
"""

from __future__ import annotations

import json
import os
import re
import time
from typing import Any

try:
    from . import members
except ImportError:  # AstrBot 以模块方式加载时走这里
    import members  # type: ignore

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_DIR = os.path.abspath(os.path.join(PLUGIN_DIR, "..", "..", "xzy"))
# 与 main.AUDIT_DIR/outbound.jsonl 同一个文件：判定回读只认这一个出口。
OUTBOUND_AUDIT = os.path.join(STATE_DIR, "audit", "outbound.jsonl")

# 进程内只留最近几条：只是为了判「最后一句 + 距现在多久」，不做完整历史
MAX_KEEP = 8
# 审计回读：只看文件尾部这么多字节，避免整份 outbound.jsonl 读进内存
AUDIT_TAIL_BYTES = 256 * 1024
AUDIT_TAIL_ROWS = 400
# 回读缓存：同一毫秒内多次判定不重复读盘
_AUDIT_CACHE: dict[str, tuple[float, int, list[dict[str, Any]]]] = {}

INNER_PREFIX = "【内心】"
# 问句：整句以问号收尾，或以「吗/呢/么」收尾（「在干嘛」这类无问号的也算）
QUESTION_RE = re.compile(r"(?:[?？]|[吗呢么])\s*$")

_SENT: dict[str, list[dict[str, Any]]] = {}


def _now_mono() -> int:
    return time.monotonic_ns()


def _now_ms() -> int:
    return int(time.time() * 1000)


# --------------------------------------------------------------------------- #
# 出站小账
# --------------------------------------------------------------------------- #
def note_outbound(
    umo: str,
    text: str,
    *,
    mono_ns: int | None = None,
    ts_ms: int | None = None,
    stage: str = "decorating_result",
    persist: bool = False,
) -> None:
    """记一条「确实要出站」的正文。空正文与 `【内心】` 行不计。

    `persist=True` 时同时追加一行 `audit/outbound.jsonl`（带 `wall_ms`），
    供重启后回读。只给「没有经过 decorating_result 的发送」用（工具直发
    bridge），避免同一条正文写两遍。
    """
    body = re.sub(r"\s+", " ", str(text or "")).strip()
    if not umo or not body or body.startswith(INNER_PREFIX):
        return
    mono = int(mono_ns if mono_ns is not None else _now_mono())
    ms = int(ts_ms if ts_ms is not None else _now_ms())
    bucket = _SENT.setdefault(str(umo), [])
    bucket.append({"mono_ns": mono, "ts_ms": ms, "text": body[:500]})
    if len(bucket) > MAX_KEEP:
        del bucket[:-MAX_KEEP]
    if persist:
        _append_audit(str(umo), body, mono, ms, stage)


def _append_audit(umo: str, body: str, mono_ns: int, ts_ms: int, stage: str) -> None:
    try:
        os.makedirs(os.path.dirname(OUTBOUND_AUDIT), exist_ok=True)
        record = {
            "mono_ns": mono_ns,
            "wall_ms": ts_ms,
            "wall": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "umo": umo,
            "chars": len(body),
            "text": body[:500],
            "stage": stage,
        }
        with open(OUTBOUND_AUDIT, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            handle.flush()
    except OSError:
        # 审计写不进去不影响发送，也不影响进程内小账
        pass


def set_audit_path(path: str | None) -> None:
    """离线自证用：换一份独立的出站台账。"""
    global OUTBOUND_AUDIT
    OUTBOUND_AUDIT = path or os.path.join(STATE_DIR, "audit", "outbound.jsonl")
    _AUDIT_CACHE.clear()


def reset() -> None:
    """清空进程内小账（离线自证用；线上没有调用点）。"""
    _SENT.clear()
    _AUDIT_CACHE.clear()


def _tail_rows(path: str) -> list[dict[str, Any]]:
    try:
        stat = os.stat(path)
    except OSError:
        return []
    key = (stat.st_mtime, stat.st_size)
    cached = _AUDIT_CACHE.get(path)
    if cached and cached[0] == key[0] and cached[1] == key[1]:
        return cached[2]
    rows: list[dict[str, Any]] = []
    try:
        with open(path, "rb") as handle:
            if stat.st_size > AUDIT_TAIL_BYTES:
                handle.seek(stat.st_size - AUDIT_TAIL_BYTES)
                handle.readline()  # 丢掉被切开的半行
            data = handle.read()
    except OSError:
        return []
    for line in data.decode("utf-8", "ignore").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict):
            rows.append(record)
    rows = rows[-AUDIT_TAIL_ROWS:]
    _AUDIT_CACHE[path] = (stat.st_mtime, stat.st_size, rows)
    return rows


def last_turn(
    umo: str,
    audit_path: str | None = None,
    *,
    now_mono_ns: int | None = None,
    now_ms: int | None = None,
) -> dict[str, Any] | None:
    """机器人最后一句 + 距今多久；取进程内小账与审计台账里更新的那条。"""
    umo = str(umo or "")
    if not umo:
        return None
    mono_now = int(now_mono_ns if now_mono_ns is not None else _now_mono())
    ms_now = int(now_ms if now_ms is not None else _now_ms())
    best: dict[str, Any] | None = None
    bucket = _SENT.get(umo) or []
    if bucket:
        row = bucket[-1]
        best = {
            "text": row["text"],
            "ago_ms": max(0, int((mono_now - int(row["mono_ns"])) / 1_000_000)),
            "ts_ms": int(row["ts_ms"]),
            "source": "memory",
            "msgs_after": len(bucket) - 1,
        }
    if audit_path:
        for record in reversed(_tail_rows(audit_path)):
            if str(record.get("umo") or "") != umo:
                continue
            text = str(record.get("text") or "").strip()
            if not text or text.startswith(INNER_PREFIX):
                continue
            ts = record.get("wall_ms") or record.get("ts")
            if not ts:
                continue  # 老行没有毫秒时间戳：宁可不判，也不按秒猜
            ts_ms = int(ts)
            if best is not None and ts_ms <= int(best["ts_ms"]):
                break
            rows = _tail_rows(audit_path)
            after = 0
            for later in rows:
                if str(later.get("umo") or "") != umo:
                    continue
                later_ts = later.get("wall_ms") or later.get("ts") or 0
                if int(later_ts or 0) > ts_ms:
                    after += 1
            best = {
                "text": text[:500],
                "ago_ms": max(0, ms_now - ts_ms),
                "ts_ms": ts_ms,
                "source": "audit",
                "msgs_after": after,
            }
            break
    return best


# --------------------------------------------------------------------------- #
# 字段
# --------------------------------------------------------------------------- #
def is_question(text: str) -> bool:
    return bool(QUESTION_RE.search(str(text or "").strip()))


def _history_burst(history_lines: list[str] | None) -> int:
    burst = 0
    for line in reversed(list(history_lines or [])):
        if line.startswith("机器人："):
            burst += 1
        else:
            break
    return burst


def build_fields(
    entries: list[dict[str, Any]],
    history_lines: list[str] | None = None,
    *,
    umo: str = "",
    audit_path: str | None = None,
    now_mono_ns: int | None = None,
    now_ms: int | None = None,
) -> dict[str, Any]:
    last = entries[-1] if entries else {}
    turn = last_turn(
        umo or str(last.get("umo") or ""),
        audit_path,
        now_mono_ns=now_mono_ns,
        now_ms=now_ms,
    )
    said, ago, source, after = "", None, "none", 0
    if turn:
        said, ago, source, after = turn["text"], turn["ago_ms"], turn["source"], turn["msgs_after"]
    else:
        for line in reversed(list(history_lines or [])):
            if line.startswith("机器人："):
                said, source = line[4:], "history"
                break
    text = str(last.get("text") or "").strip()
    name_signal = members.signal(
        text,
        last.get("group_id"),
        self_id=str(last.get("self_id") or ""),
        sender_id=str(last.get("sender") or ""),
    )
    return {
        "bot_last_said": said[:200],
        "bot_last_said_ago_ms": ago,
        "bot_last_said_source": source,
        "bot_asked_question": is_question(said),
        "bot_msgs_since": after,
        "bot_burst": _history_burst(history_lines),
        "user_at_other": bool(last.get("at_other")),
        "user_quoted_other": bool(last.get("quoted_other")),
        "addressed_elsewhere": bool(last.get("addressed_elsewhere")),
        "pure_media": bool(last.get("media")) and not text,
        # 低置信度：只在本地记住过昵称时给 likely/no，从没记过就是 unknown
        "name_call_other": name_signal["name_call_other"],
        "name_matched": name_signal["name_matched"],
        "text": text[:200],
    }


# --------------------------------------------------------------------------- #
# 规则
# --------------------------------------------------------------------------- #
def windows(cfg: dict[str, Any]) -> tuple[int, int]:
    judge = cfg.get("judge") if isinstance(cfg.get("judge"), dict) else {}
    window = int(judge.get("continuationWindowMs") or 30000)
    stale = int(judge.get("continuationStaleMs") or 120000)
    return window, max(window, stale)


def _verdict(
    speak: bool,
    rule: str,
    reason: str,
    *,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "speak": speak,
        "addressed_to_bot": speak,
        "should_reply": speak,
        "reason": reason,
        "rule": rule,
        "gate": "rule",
        "details": details or {},
    }


def decide(fields: dict[str, Any], cfg: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    """返回 (rule_hit, verdict)。verdict 为 None 表示进灰区、要调模型。"""
    window, stale = windows(cfg)
    if fields.get("addressed_elsewhere"):
        return (
            "R1:addressed-elsewhere",
            _verdict(
                False,
                "rule:addressed-elsewhere",
                "在跟别人说话（@/引用别人），不接",
                details={"addressed_elsewhere": True},
            ),
        )
    if not fields.get("bot_last_said") or fields.get("pure_media"):
        return "R5:model", None
    ago = fields.get("bot_last_said_ago_ms")
    if ago is None:
        return "R4:no-ago", None
    if fields.get("bot_asked_question") and 0 <= int(ago) <= window:
        return (
            "R2:continuation",
            _verdict(
                True,
                "rule:continuation",
                f"接话：机器人 {int(ago)}ms 前刚问过「{str(fields.get('bot_last_said'))[:24]}」",
                details={
                    "ago_ms": int(ago),
                    "window_ms": window,
                    "bot_last_said": fields.get("bot_last_said"),
                },
            ),
        )
    if window < int(ago) <= stale:
        return "R3:stale-window", None
    return "R5:model", None


# --------------------------------------------------------------------------- #
# 注入 prompt 的字段块
# --------------------------------------------------------------------------- #
def _yesno(value: Any) -> str:
    return "是" if value is True else "否"


def format_block(fields: dict[str, Any] | None) -> str:
    if not fields:
        return ""
    ago = fields.get("bot_last_said_ago_ms")
    said = str(fields.get("bot_last_said") or "")
    lines = ["【结构化字段（插件已读出，直接采信，不要自己推断）】"]
    lines.append("- 机器人最后一句：" + (f"「{said}」" if said else "（没有记录）"))
    lines.append(
        "- 距这句话：" + ("未知（没有毫秒时间戳）" if ago is None else f"{int(ago)} 毫秒前")
    )
    lines.append("- 这句是问句：" + _yesno(fields.get("bot_asked_question")))
    lines.append(
        "- 机器人最后一句之后又发了：" + str(int(fields.get("bot_msgs_since") or 0)) + " 条"
    )
    lines.append("- 机器人连发条数（含最后一句）：" + str(int(fields.get("bot_burst") or 0)))
    lines.append("- 这条 @ 了别人：" + _yesno(fields.get("user_at_other")))
    lines.append("- 这条引用了别人：" + _yesno(fields.get("user_quoted_other")))
    lines.append("- 这条在回复别人：" + _yesno(fields.get("addressed_elsewhere")))
    matched = fields.get("name_matched") or []
    if fields.get("name_call_other") == "likely":
        lines.append(
            "- 是否在叫别人名字：可能（这句话里出现了群成员昵称：" + "、".join(matched)
            + "；也可能只是顺口提到，请结合上下文判断，不要仅凭这个判接话）"
        )
    elif fields.get("name_call_other") == "no":
        lines.append("- 是否在叫别人名字：否（本地名单里没有昵称出现在这句话里）")
    else:
        lines.append("- 是否在叫别人名字：未知（本地还没有这个群的人名缓存）")
    return "\n".join(lines)
