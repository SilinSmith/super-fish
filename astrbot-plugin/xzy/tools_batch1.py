"""第一批工具（原生 FunctionTool）：群内 @ / 表情回应 / 拍一拍 / 发图 / 角色记忆 / 日记。

语义逐条对齐 dsh-onebot-qq/lib/tools.js：
- qq_at、qq_react、qq_poke、qq_send_image、qq_character_note、qq_diary。
- 所有 handler 返回四态契约 dict，由 `tool_schema.make_tool` 包 `safe_call`。
- 返回值一律是 `tool_result.render()` 的字符串（原生会把字符串原样交给模型）。

与旧栈的已知差异（单独汇报，不混入"已实现"）：
- 图片 caption 的二审（reviewOutboundText）尚未接，随 T3.3 一起补。
- qq_react / qq_poke 省略 message_id / user_id 时，旧栈取"会话最近一条"，
  这里暂取"触发本轮的这条消息 / 发送者"，行为差异写在 evidence/tools.md。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from typing import Any

try:
    from . import review as review_mod
    from . import tool_context
    from . import tool_result as tr
    from .tool_send import (
        current_chat as _current_chat,
        image_seg_from_file as _image_seg_from_file,
        is_url as _is_url,
        parse_chat_id as _parse_chat_id,
        resolve_chat as _resolve_chat,
        send_segments as _send_segments,
        text_seg as _text_seg,
    )
except ImportError:  # AstrBot 以扁平模块方式加载时走这里
    import review as review_mod  # type: ignore
    import tool_context  # type: ignore
    import tool_result as tr  # type: ignore
    from tool_send import (  # type: ignore
        current_chat as _current_chat,
        image_seg_from_file as _image_seg_from_file,
        is_url as _is_url,
        parse_chat_id as _parse_chat_id,
        resolve_chat as _resolve_chat,
        send_segments as _send_segments,
        text_seg as _text_seg,
    )

PERSONA_ROOT = r"E:\Bonsai\astrbot-eval\inst\data\xzy\persona"
STATE_JSON = os.path.join(PERSONA_ROOT, "state.json")
DIARY_JSONL = os.path.join(PERSONA_ROOT, "diary.jsonl")
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_IMAGES = 9

CFG: dict[str, Any] = {}


def configure(cfg: dict[str, Any]) -> None:
    CFG.clear()
    CFG.update(cfg)


def _review_log(level: str, message: str) -> None:
    try:
        from astrbot.api import logger
    except ImportError:  # pragma: no cover
        return
    method = {"warn": "warning", "error": "error"}.get(level, "info")
    getattr(logger, method, logger.info)(f"[xzy] {message}")


# --------------------------------------------------------------------------- #
# 工具实现
# --------------------------------------------------------------------------- #
async def qq_at(event: Any = None, qq: str = "", text: str = "", chat_id: str = "", **_: Any) -> dict[str, Any]:
    if event is None:
        raise RuntimeError("缺少事件上下文")
    qq = str(qq or "").strip()
    if qq == "":
        raise ValueError("qq 必填")
    if not qq.isdigit():
        raise ValueError(f"qq 必须是 QQ 号：{qq}")
    chat = _resolve_chat(event, chat_id)
    if chat is None:
        raise ValueError("chat_id 格式应为 group:<群号> 或 private:<QQ号>")
    if chat[0] != "group":
        raise ValueError("仅支持群聊")
    if not (chat_id or "").strip():
        chat = ("group", str(event.get_group_id() or ""))
    segments = [{"type": "at", "data": {"qq": qq}}]
    if text:
        segments.append(_text_seg(" " + text))
    message_id = await _send_segments(event, chat, segments)
    return {"sent": True, "messageId": message_id}


async def qq_react(
    event: Any = None, emoji_id: str = "", message_id: str = "", chat_id: str = "", **_: Any
) -> dict[str, Any]:
    if event is None:
        raise RuntimeError("缺少事件上下文")
    emoji = str(emoji_id or "").strip()
    if not emoji.isdigit():
        raise ValueError("emoji_id 必须是数字字符串")
    chat = _resolve_chat(event, chat_id)
    if chat is None:
        raise ValueError("chat_id 格式应为 group:<群号> 或 private:<QQ号>")
    target = str(message_id or "").strip()
    if target == "":
        # 旧栈 chat.lastMessageId：会话最近一条（入站消息刷新，不随出站清空）
        target = tool_context.last_message_id(tool_context.key_of(chat))
    if target == "":
        raise ValueError("没有可回应的消息")
    bot = getattr(event, "bot", None)
    if bot is None:
        raise RuntimeError("当前平台不支持表情回应")
    await bot.call_action(
        "set_msg_emoji_like", message_id=int(target), emoji_id=emoji, set=True
    )
    return tr.result_ok("已贴表情回应", messageId=target, emoji_id=emoji)


async def qq_poke(
    event: Any = None, user_id: str = "", chat_id: str = "", **_: Any
) -> dict[str, Any]:
    if event is None:
        raise RuntimeError("缺少事件上下文")
    chat = _resolve_chat(event, chat_id)
    if chat is None:
        raise ValueError("chat_id 格式应为 group:<群号> 或 private:<QQ号>")
    target = str(user_id or "").strip()
    if target == "":
        # 旧栈 chat.lastUserId：会话最近发送者（不是「本条消息的发送者」）
        target = tool_context.last_user_id(tool_context.key_of(chat))
    if target == "":
        raise ValueError("没有可拍的人，请传 user_id")
    if not target.isdigit():
        raise ValueError(f"user_id 必须是 QQ 号：{target}")
    bot = getattr(event, "bot", None)
    if bot is None:
        raise RuntimeError("当前平台不支持拍一拍")
    params: dict[str, Any] = {"user_id": int(target)}
    if chat[0] == "group":
        params["group_id"] = int(chat[1])
    await bot.call_action("send_poke", **params)
    return tr.result_ok(f"已拍一拍 {target}", target=target, chatId=f"{chat[0]}:{chat[1]}")


async def qq_send_image(
    event: Any = None,
    sources: Any = None,
    chat_id: str = "",
    caption: str = "",
    **_: Any,
) -> dict[str, Any]:
    if event is None:
        raise RuntimeError("缺少事件上下文")
    items = [s for s in (sources or []) if isinstance(s, str) and s.strip()]
    if not items:
        raise ValueError("sources 不能为空")
    if len(items) > MAX_IMAGES:
        raise ValueError(f"一次最多 {MAX_IMAGES} 张图片")
    chat = _resolve_chat(event, chat_id)
    if chat is None:
        raise ValueError("chat_id 格式应为 group:<群号> 或 private:<QQ号>")
    segments: list[dict[str, Any]] = []
    text = str(caption or "").replace("😅", "")
    if text:
        # 旧栈 qq_send_image：caption 先过二审（mode=final），drop 只丢文字、图片照发
        verdict = await review_mod.review_outbound_text(text, CFG, mode="final", log=_review_log)
        if verdict["action"] == "drop":
            _review_log("warn", f"qq_send_image caption dropped: {'，'.join(verdict['reasons'])}")
            text = ""
    if text:
        segments.append(_text_seg(text))
    for source in items:
        if _is_url(source):
            segments.append({"type": "image", "data": {"url": source}})
        else:
            segments.append(_image_seg_from_file(source))
    message_id = await _send_segments(event, chat, segments)
    return {"sent": True, "messageId": message_id, "count": len(items)}


def _read_json(path: str, default: Any) -> Any:
    try:
        with open(path, encoding="utf-8-sig") as f:
            return json.load(f)
    except Exception:
        return default


def _write_json(path: str, data: Any) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


async def qq_character_note(
    event: Any = None, note: str = "", kind: str = "", **_: Any
) -> dict[str, Any]:
    note = str(note or "").strip()
    if note == "":
        raise ValueError("note 必填")
    kind = kind if kind in ("promise", "mood") else "memory"
    state = _read_json(STATE_JSON, None)
    if not isinstance(state, dict):
        state = {"version": 1, "mood": "有点懒，但心情不错", "memories": [], "promises": []}
    now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    entry = {"ts": now, "text": note}
    if kind == "mood":
        state["mood"] = note
    elif kind == "promise":
        state["promises"] = (state.get("promises") or [])[-19:] + [entry]
    else:
        state["memories"] = (state.get("memories") or [])[-49:] + [entry]
    state["updatedAt"] = now
    _write_json(STATE_JSON, state)
    return tr.result_ok(
        f"已记住（{kind}）",
        kind=kind,
        totalMemories=len(state.get("memories") or []),
    )


def _diary_fingerprint(text: str) -> str:
    cleaned = re.sub(r"[\s\W_]+", "", text, flags=re.UNICODE).lower()
    return hashlib.sha1(cleaned.encode("utf-8")).hexdigest()


def _diary_fingerprints() -> tuple[set[str], int]:
    seen: set[str] = set()
    count = 0
    try:
        with open(DIARY_JSONL, encoding="utf-8") as f:
            lines = [line for line in f.read().splitlines() if line.strip()]
    except OSError:
        return seen, 0
    count = len(lines)
    for line in lines[-500:]:
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        text = str(entry.get("text") or "").strip()
        if text:
            seen.add(_diary_fingerprint(text))
    return seen, count


async def qq_diary(
    event: Any = None, text: str = "", mood: str = "", **_: Any
) -> dict[str, Any]:
    body = str(text or "").strip()
    if body == "":
        raise ValueError("text 必填")
    now = time.localtime()
    date = time.strftime("%Y-%m-%d", now)
    entry: dict[str, Any] = {
        "date": date,
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S", now) + time.strftime("%z", now),
        "text": body[:800],
    }
    if str(mood or "").strip():
        entry["mood"] = str(mood).strip()
    seen, count = _diary_fingerprints()
    if _diary_fingerprint(entry["text"]) in seen:
        return tr.result_done(
            "already-done",
            f"同样的内容今天已经记过了（当前共 {count} 条），这次没有重复写入",
            date=date,
            count=count,
        )
    os.makedirs(os.path.dirname(DIARY_JSONL), exist_ok=True)
    with open(DIARY_JSONL, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        f.flush()
    return tr.result_ok(f"日记已记录（第 {count + 1} 条，{date}）", date=date, count=count + 1)


# --------------------------------------------------------------------------- #
# 声明（schema 逐条对齐 tools.js）
# --------------------------------------------------------------------------- #
TOOL_SPECS: list[dict[str, Any]] = [
    {
        "name": "qq_at",
        "description": "在群聊里 @ 一个群友（不会在正文里暴露 QQ 号）。text 可选，紧跟在 @ 后发送。仅群聊可用。",
        "parameters": {
            "qq": {"type": "string", "required": True, "description": "要 @ 的群友 QQ 号"},
            "text": {"type": "string", "description": "跟在 @ 后面的文字（可选）"},
            "chat_id": {"type": "string", "description": "目标群会话；省略时默认当前会话"},
        },
        "handler": qq_at,
    },
    {
        "name": "qq_react",
        "description": "给当前会话里某条已有消息贴一个 QQ 表情回应（气泡下的小表情）。只是补充反应，不能代替文字回复。",
        "parameters": {
            "emoji_id": {"type": "string", "required": True, "description": "QQ 表情 ID，必须是数字字符串（如 128512）"},
            "message_id": {"type": "string", "description": "目标消息 ID；省略时用触发本轮的消息"},
            "chat_id": {"type": "string", "description": "目标会话；省略时默认当前会话"},
        },
        "handler": qq_react,
    },
    {
        "name": "qq_poke",
        "description": "拍一拍当前会话的对方/指定群友，或在被拍后拍回去。user_id 传 QQ 号（群聊里必须传要拍的人）。",
        "parameters": {
            "user_id": {"type": "string", "description": "要拍的人的 QQ 号；省略时用本轮发送者"},
            "chat_id": {"type": "string", "description": "目标会话；省略时默认当前会话"},
        },
        "handler": qq_poke,
    },
    {
        "name": "qq_send_image",
        "description": "向 QQ 会话发送一张或多张图片（本地文件路径或 http(s) URL，最多 9 张）。",
        "parameters": {
            "sources": {"type": "array", "items": {"type": "string"}, "required": True, "description": "图片来源：本地绝对路径或 http(s) URL，最多 9 个"},
            "chat_id": {"type": "string", "description": "目标会话，格式 private:<QQ号> 或 group:<群号>；省略时默认当前会话"},
            "caption": {"type": "string", "description": "图片说明文字（可选，作为图片前的文本发送）"},
        },
        "handler": qq_send_image,
    },
    {
        "name": "qq_character_note",
        "description": "记录角色记忆/心情/承诺，写入角色状态文件；下一次对话会自动注入。只记值得记住的。",
        "parameters": {
            "note": {"type": "string", "required": True, "description": "要记住的内容（简短一句）"},
            "kind": {"type": "string", "description": "memory（默认）/ promise / mood"},
        },
        "handler": qq_character_note,
    },
    {
        "name": "qq_diary",
        "description": "写今天的日记（给自己看，不会发到 QQ）。每天总结或重要时刻写一条，像自己说话。",
        "parameters": {
            "text": {"type": "string", "required": True, "description": "今天发生了什么、你的心情和想法（一两百字即可）"},
            "mood": {"type": "string", "description": "此刻的心情，如 开心/有点累/满足/烦躁"},
        },
        "handler": qq_diary,
    },
]
