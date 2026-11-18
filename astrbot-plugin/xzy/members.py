"""本地群成员名字表：给判定提供低置信度的「文字叫别人名字」信号。

只做信号、不做规则：命中 `likely` 也不改变「是否开口」，只把结论和命中的名字
交给模型，由模型判断是「在叫这个人」还是「顺口提到这个人」。

来源（都不额外发网络请求）：
1. 每条群消息的发言者昵称（`note_entry`，随流量自然积累）；
2. `qq_group_query members` 这类工具成功返回的成员列表（`note_group_list`，
   模型主动查一次就顺手刷新一次）；
3. 之后同一个人发言时补上 id → 昵称映射（@ 里只有 QQ 号，靠这一步对齐）。

刷新与容量：每条消息更新一次发言者；落盘节流 60s（`FLUSH_INTERVAL_S`），
进程退出时 `flush()`。每群最多 500 人、最多 20 个群，条目 30 天过期，
内存占用上限约 10000 × 80B ≈ 800KB，实际通常几十 KB。

覆盖不到：从没发过言、也没被工具查到的成员（新入群）；改名后旧昵称残留
（以最后一次看到的为准）；纯外号/缩写不在 QQ 昵称里；两人昵称互为子串时
会同时命中（`name_matched` 全列出来，不挑一个）。
"""

from __future__ import annotations

import json
import os
import re
import time
from typing import Any

MAX_GROUPS = 20
MAX_PER_GROUP = 500
NAME_TTL_MS = 30 * 24 * 3600 * 1000
FLUSH_INTERVAL_S = 60.0
MIN_NAME_LEN = 2

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_DIR = os.path.abspath(os.path.join(PLUGIN_DIR, "..", "..", "xzy"))
STORE_PATH = os.path.join(STATE_DIR, "member_names.json")

_MEMBERS: dict[str, dict[str, dict[str, Any]]] = {}
_LOADED = False
_DIRTY = False
_LAST_FLUSH = 0.0


def _now_ms() -> int:
    return int(time.time() * 1000)


def set_store_path(path: str | None) -> None:
    """离线自证用：换一份独立的成员表，不碰线上缓存。"""
    global STORE_PATH, _LOADED, _DIRTY
    STORE_PATH = path or os.path.join(STATE_DIR, "member_names.json")
    _MEMBERS.clear()
    _LOADED = False
    _DIRTY = False


def _load() -> None:
    global _LOADED
    if _LOADED:
        return
    _LOADED = True
    try:
        with open(STORE_PATH, encoding="utf-8") as handle:
            raw = json.load(handle)
    except Exception:
        return
    if not isinstance(raw, dict):
        return
    for gid, table in raw.items():
        if isinstance(table, dict):
            _MEMBERS[str(gid)] = {
                str(uid): value
                for uid, value in table.items()
                if isinstance(value, dict) and value.get("name")
            }


def _prune(now_ms: int) -> None:
    for gid, table in list(_MEMBERS.items()):
        alive = {
            uid: value
            for uid, value in table.items()
            if now_ms - int(value.get("ts") or 0) <= NAME_TTL_MS
        }
        if not alive:
            _MEMBERS.pop(gid, None)
        elif len(alive) > MAX_PER_GROUP:
            keep = sorted(alive.items(), key=lambda kv: int(kv[1].get("ts") or 0), reverse=True)
            _MEMBERS[gid] = dict(keep[:MAX_PER_GROUP])
        else:
            _MEMBERS[gid] = alive
    while len(_MEMBERS) > MAX_GROUPS:
        oldest = min(
            _MEMBERS.items(),
            key=lambda kv: max(int(v.get("ts") or 0) for v in kv[1].values()) if kv[1] else 0,
        )
        _MEMBERS.pop(oldest[0], None)


def flush(force: bool = False) -> None:
    global _DIRTY, _LAST_FLUSH
    now = time.time()
    if not _DIRTY and not force:
        return
    if not force and now - _LAST_FLUSH < FLUSH_INTERVAL_S:
        return
    _prune(_now_ms())
    try:
        os.makedirs(os.path.dirname(STORE_PATH), exist_ok=True)
        tmp = STORE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(_MEMBERS, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, STORE_PATH)
        _DIRTY = False
        _LAST_FLUSH = now
    except Exception:
        pass


def _clean_name(value: Any) -> str:
    name = re.sub(r"\s+", "", str(value or "")).strip()
    if len(name) < MIN_NAME_LEN or name.isdigit():
        return ""
    if not re.search(r"[^\W_]", name, re.UNICODE):
        return ""
    return name[:32]


def note_member(group_id: Any, user_id: Any, name: Any, *, ts_ms: int | None = None) -> None:
    global _DIRTY
    gid, uid = str(group_id or ""), str(user_id or "")
    clean = _clean_name(name)
    if not gid or not uid or not clean:
        return
    _load()
    _MEMBERS.setdefault(gid, {})[uid] = {"name": clean, "ts": int(ts_ms or _now_ms())}
    _DIRTY = True


def note_entry(entry: dict[str, Any]) -> None:
    """入站消息顺手记一条：发言者 id → 当前群昵称。"""
    if str(entry.get("chat") or "") != "group":
        return
    self_id = str(entry.get("self_id") or "")
    sender = str(entry.get("sender") or "")
    if not sender or sender == self_id:
        return
    note_member(entry.get("group_id"), sender, entry.get("nick"))
    # 自带节流（60s 一次），不阻塞入站链路
    flush()


def note_group_list(group_id: Any, members: Any) -> int:
    """吃一份 `get_group_member_list` 结果（字段名兼容 card/nickname/nick）。"""
    gid = str(group_id or "")
    if not gid or not isinstance(members, list):
        return 0
    added = 0
    for item in members:
        if not isinstance(item, dict):
            continue
        uid = item.get("user_id") or item.get("uin") or item.get("qq")
        name = item.get("card") or item.get("nickname") or item.get("nick") or ""
        before = len(_MEMBERS.get(gid) or {})
        note_member(gid, uid, name)
        if len(_MEMBERS.get(gid) or {}) != before:
            added += 1
    if added:
        flush(force=True)
    return added


def known_count(group_id: Any) -> int:
    _load()
    return len(_MEMBERS.get(str(group_id or "")) or {})


def signal(
    text: str,
    group_id: Any,
    *,
    self_id: str = "",
    sender_id: str = "",
) -> dict[str, Any]:
    """返回 {"name_call_other": likely/no/unknown, "name_matched": [...]}。

    unknown = 群里一个人名都没记住；no = 记住了但这句话没出现其中任何一个；
    likely = 出现了别人的昵称（低置信度，不代表真的在叫这个人）。
    """
    gid = str(group_id or "")
    _load()
    table = _MEMBERS.get(gid) or {}
    if not table:
        return {"name_call_other": "unknown", "name_matched": []}
    body = str(text or "")
    matched: list[str] = []
    for uid, value in table.items():
        if uid in (str(self_id or ""), str(sender_id or "")):
            continue
        name = str(value.get("name") or "")
        if name and name in body and name not in matched:
            matched.append(name)
    return {"name_call_other": "likely" if matched else "no", "name_matched": matched[:5]}
