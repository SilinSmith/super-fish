"""一条消息一个幂等键：先回答的路径占键，后到的路径必须放弃。

为什么需要（AstrBot 4.14.6，不改源码）：
- 同一条入站消息可能被多条路径回答：原生空 @ 等待器的抢先回复、
  模型工具 `send_message_to_user`、同轮最终正文；
- 11:24 那条消息在 60 秒等待器超时后再次流进 xzy，起了第二个 LLM 回合，
  又多出一条；11:11 同类却没有。两次差异的调度层原因查不到，
  所以不再依赖解释，改用 message_id 幂等：谁先答谁占键。

语义：
- 键 = `umo|message_id`；防抖合批时整批 message_id 一起占，任一被占即视为已答；
- 只有**文本**出站才占键：纯图片/表情不占，避免把后续正文挤掉；
- TTL 600s，容量上限 2000（超限按时间淘汰）；
- **撤回不回滚**：撤回是「替代再补一句」，不是「允许重发」。幂等键保持已答，
  撤回后同一 message_id 不会自动再出一句（决策见 spec）。
"""

from __future__ import annotations

import time
from typing import Any

TTL_SECONDS = 600.0
MAX_ENTRIES = 2000

_STATE: dict[str, dict[str, Any]] = {}


def _key(umo: str, mid: str) -> str:
    return f"{umo}|{mid}"


def event_ids(event: Any) -> list[str]:
    """取本次出站归属的 message_id 集合；没有 message_id 时回退到回合号。"""
    ids: list[str] = []
    try:
        batch = event.get_extra("xzy_batch") or {}
        for mid in batch.get("message_ids") or []:
            mid = str(mid or "")
            if mid:
                ids.append(mid)
    except Exception:
        pass
    if not ids:
        try:
            mid = str(getattr(getattr(event, "message_obj", None), "message_id", "") or "")
            if mid:
                ids.append(mid)
        except Exception:
            pass
    if not ids:
        try:
            tid = str(event.get_extra("xzy_turn_id") or "")
            if tid:
                ids.append("turn:" + tid)
        except Exception:
            pass
    return ids


def _fresh(row: dict[str, Any] | None, now: float) -> bool:
    return bool(row) and now - float(row.get("ts", 0.0)) <= TTL_SECONDS


def answered(umo: str, ids: list[str]) -> str | None:
    """任一 id 已被占键则返回占用者来源，否则 None。"""
    if not umo or not ids:
        return None
    now = time.monotonic()
    for mid in ids:
        key = _key(umo, mid)
        row = _STATE.get(key)
        if _fresh(row, now):
            return str((row or {}).get("source") or "unknown")
        if row is not None:
            _STATE.pop(key, None)
    return None


def mark(umo: str, ids: list[str], source: str, text: str = "") -> None:
    """占键；先到先得，已占的不覆盖。"""
    if not umo or not ids:
        return
    now = time.monotonic()
    for mid in ids:
        key = _key(umo, mid)
        if _fresh(_STATE.get(key), now):
            continue
        _STATE[key] = {"ts": now, "source": source, "text": (text or "")[:200]}
    _prune(now)


def _prune(now: float) -> None:
    if len(_STATE) <= MAX_ENTRIES:
        return
    for key, row in list(_STATE.items()):
        if now - float(row.get("ts", 0.0)) > TTL_SECONDS:
            _STATE.pop(key, None)
    while len(_STATE) > MAX_ENTRIES:
        oldest = min(_STATE, key=lambda k: _STATE[k].get("ts", 0.0))
        _STATE.pop(oldest, None)


def reset() -> None:
    """测试用：清空台账。"""
    _STATE.clear()
