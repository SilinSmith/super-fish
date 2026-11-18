"""会话级「最近一条消息 / 最近发送者」快照。

旧栈桥接层维护 `chat.lastMessageId` / `chat.lastUserId`（见 dsh-onebot-qq/lib/inbound.js
1139/1148），`qq_react` / `qq_poke` 省略目标时读这两个字段。AstrBot 侧没有等价字段，
所以在每条入站消息归一化后由主类写入，工具按 chat_key 读取。

口径：
- **只由入站消息刷新**（与旧栈一致），出站不清空；
- key 与主类合批键一致：群聊 = 群号，私聊 = `private:<QQ号>`；
- 多轮补发（bot 连续发了多条）后，最近一条仍是最后一次有人说话的入站消息，
  与旧栈 `lastMessageId` 同步节奏相同。
"""

from __future__ import annotations

from typing import Any

_MAX_CHATS = 512

_LAST: dict[str, dict[str, str]] = {}


def chat_key(kind: str, chat_id: str) -> str:
    """("group", gid) → gid；("private", uid) → private:uid（与主类一致）。"""
    return str(chat_id) if kind == "group" else f"private:{chat_id}"


def key_of(chat: tuple[str, str]) -> str:
    return chat_key(chat[0], chat[1])


def note(chat_key_value: str, message_id: str, sender: str) -> None:
    if not chat_key_value:
        return
    prev = _LAST.get(chat_key_value) or {}
    _LAST[chat_key_value] = {
        "message_id": str(message_id or prev.get("message_id", "")),
        "sender": str(sender or prev.get("sender", "")),
    }
    if len(_LAST) > _MAX_CHATS:
        for stale in list(_LAST)[: len(_LAST) - _MAX_CHATS]:
            _LAST.pop(stale, None)


def last_message_id(chat_key_value: str) -> str:
    return str((_LAST.get(chat_key_value) or {}).get("message_id") or "")


def last_user_id(chat_key_value: str) -> str:
    return str((_LAST.get(chat_key_value) or {}).get("sender") or "")


def snapshot(chat_key_value: str) -> dict[str, str]:
    return dict(_LAST.get(chat_key_value) or {})


def clear() -> None:
    _LAST.clear()


def _debug() -> dict[str, Any]:  # pragma: no cover - 手工排查
    return {"chats": len(_LAST), "sample": list(_LAST.items())[:5]}
