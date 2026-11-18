"""第四批工具（原生 FunctionTool）：旧 Node 栈最后 12 个工具。

覆盖 dsh-onebot-qq/lib/tools.js：
qq_tool / qq_group_history / qq_request_master / qq_qzone_feed / qq_qzone_like /
qq_qzone_post / qq_qzone_extra / qq_group_query / qq_group_file /
qq_group_album / qq_task / qq_napcat_api。

旧栈里缺失、这里按 tools.js 实际调用形态降级的部分（单独汇报，不混入"已实现"）：
- 缺 `connection.call` 连接层（qzone/napcat 封装不在 _oldsrc）→ 一律
  `event.bot.call_action(action, **旧栈同名参数)`，返回值按旧栈字段读取；
  非对象/空结果统一判 failed。
- 缺 bridge.chats 会话态（activeTurnRole / lastUserId / qzoneAuthorized /
  pendingImageRequest）→ 主人判定改为 master_qq + event.get_sender_id()；
  qq_task 的 owner 取本轮发送者；qzone "先要图并暂存 12 小时" 未持久化，
  只发要图消息并提示"收到图后带 images 重新调用"。
- 缺 tasks-store.mjs → 本文件用 Python 重写最小等价，沿用同一 tasks.json 结构。
- 缺 tool-catalog.mjs → qq_tool 的目录从各工具模块 TOOL_SPECS 派生；AstrBot
  全量注册，故 load 一律 already-done（所有工具都直接可用）。
- 缺 write-tools.json 总开关 → 四个写工具只保留"仅主人"门槛（仍注册，便于探针
  与集成方统一 36 个）。

handler 内部捕获全部异常并返回四态契约，绝不返回 None。
"""

from __future__ import annotations

import importlib
import json
import os
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any

try:
    from . import faces
    from . import members
    from . import review as review_mod
    from . import tool_result as tr
    from .tool_send import (
        current_chat as _current_chat,
        resolve_chat as _resolve_chat,
        send_segments as _send_segments,
        text_seg as _text_seg,
    )
except ImportError:  # AstrBot 以扁平模块方式加载时走这里
    import faces  # type: ignore
    import members  # type: ignore
    import review as review_mod  # type: ignore
    import tool_result as tr  # type: ignore
    from tool_send import current_chat as _current_chat  # type: ignore
    from tool_send import resolve_chat as _resolve_chat  # type: ignore
    from tool_send import send_segments as _send_segments  # type: ignore
    from tool_send import text_seg as _text_seg  # type: ignore

PERSONA_ROOT = os.environ.get("QQ_PROXY_ROOT") or r"E:\Bonsai\astrbot-eval\inst\data\xzy\persona"
REQUESTS_JSON = os.path.join(PERSONA_ROOT, "requests.json")
TASKS_JSON = os.environ.get("QQ_TASKS_PATH") or os.path.join(PERSONA_ROOT, "tasks.json")

MASTER_REQUEST_COOLDOWN_MS = 4 * 60 * 60 * 1000
MASTER_REQUEST_DAILY_LIMIT = 3
MASTER_REQUEST_KEEP_MS = 30 * 24 * 60 * 60 * 1000
QZONE_MAX_IMAGES = 9
QZONE_FEED_CONTENT_MAX = 300
QZONE_FORWARD_CONTENT_MAX = 200
QZONE_FEED_INDEX_LIMIT = 200
QZONE_LIKE_STATE_LIMIT = 200
MAX_ACTIVE_PER_CHAT = 5
MAX_TASKS = 200
MAX_TASK_STEPS = 8
DEFAULT_MAX_RUNS = 12
DEFAULT_MAX_AGE_HOURS = 6

CFG: dict[str, Any] = {}

# 进程内缓存（与旧栈 qzoneFeedIndex / qzoneLikeState 同语义，重启即清）
_FEED_INDEX: dict[str, tuple[int, int]] = {}
_LIKE_STATE: dict[str, bool] = {}

NAPCAT_API_WHITELIST = [
    # basic / info
    "get_login_info",
    "get_status",
    "get_version_info",
    "can_send_image",
    "can_send_record",
    "get_msg",
    "get_friend_list",
    "get_stranger_info",
    "get_group_list",
    "get_group_member_list",
    "get_group_member_info",
    "get_group_system_msg",
    "get_group_tags",
    "get_friend_msg_history",
    "get_group_msg_history",
    "get_image",
    "get_record",
    "get_forward_msg",
    "get_file",
    "get_private_file_url",
    "get_group_root_files",
    "get_group_files_by_folder",
    "get_group_file_url",
    "upload_private_file",
    "upload_group_file",
    # contacts / profile / interaction
    "get_profile_like",
    "set_msg_emoji_like",
    "send_poke",
    "friend_poke",
    "group_poke",
    "get_friends_with_category",
    "get_recent_contact",
    "get_online_clients",
    "get_unidirectional_friend_list",
    "get_doubt_friends_add_request",
    "get_collection_list",
    "get_group_info_ex",
    "get_group_detail_info",
    "get_group_ignored_notifies",
    "get_group_ignore_add_request",
    "get_emoji_likes",
    "get_msg_emoji_likes",
    "fetch_custom_face",
    "fetch_custom_face_detail",
    "fetch_sys_faces",
    "search_sys_faces",
    "fetch_super_face_id",
    "send_custom_face",
    "translate_en2zh",
    "check_url_safely",
    # files / flash files
    "download_file",
    "get_fileset_info",
    "get_flash_file_list",
    "list_filesets",
    "get_flash_file_url",
    "get_share_link",
    "get_fileset_id",
    # AI / OCR / audio
    "ocr_image",
    "get_ai_characters",
    "send_group_ai_record",
    # Qzone
    "get_qzone_profile",
    "set_qzone_profile",
    "get_qzone_msg_list",
    "get_qzone_msg_detail",
    "get_qzone_feeds",
    "send_qzone_msg",
    "delete_qzone_msg",
    "set_qzone_msg_right",
    "like_qzone",
    "unlike_qzone",
    "comment_qzone",
    "get_qzone_public_capabilities",
    "get_qzone_public_feeds",
    "get_qzone_public_feed_detail",
    "get_qzone_public_comments",
    "get_qzone_public_replies",
    "set_qzone_public_upvote",
    "set_qzone_public_like",
    "set_qzone_public_comment_like",
    "comment_qzone_public_feed",
    "reply_qzone_public_feed",
    "delete_qzone_public_comment",
    "delete_qzone_public_reply",
    "set_qzone_public_follow",
    "forward_qzone_public_feed",
]


def configure(cfg: dict[str, Any]) -> None:
    CFG.clear()
    CFG.update(cfg)
    # 重载时把实际生效的写开关打进日志，便于从运行中的进程核对，而不是只看磁盘文件
    _log(
        "info",
        "write-tools 生效状态："
        + json.dumps(
            {
                name: _write_tool_enabled(name)
                for name in ("qq_qzone_like", "qq_qzone_post", "qq_qzone_extra", "qq_napcat_api")
            },
            ensure_ascii=False,
        ),
    )


# --------------------------------------------------------------------------- #
# 通用小工具
# --------------------------------------------------------------------------- #
class _MissingBot(RuntimeError):
    """当前平台没有 OneBot 直连能力。"""


class _Upstream(RuntimeError):
    """上游 action 返回了空/异常结果。"""


def _log(level: str, message: str) -> None:
    try:
        from astrbot.api import logger
    except ImportError:  # pragma: no cover
        return
    method = {"warn": "warning", "error": "error"}.get(level, "info")
    getattr(logger, method, logger.info)(f"[xzy] {message}")


def _master_qq() -> str:
    return str(CFG.get("master_qq") or "")


def _master_guard(event: Any, tool_name: str, suffix: str = "仅主人可用") -> dict[str, Any] | None:
    master = _master_qq()
    if not re.fullmatch(r"\d{5,12}", master):
        return tr.result_blocked("disabled", f"{tool_name}: 未配置主人 QQ，无法验证权限")
    sender = str(getattr(event, "get_sender_id", lambda: "")() or "")
    if sender != master:
        return tr.result_blocked("forbidden", f"{tool_name}: {suffix}")
    return None


WRITE_TOOLS_JSON = os.environ.get("QQ_WRITE_TOOLS_PATH") or os.path.join(
    PERSONA_ROOT, "write-tools.json"
)
WRITE_TOOL_CLOSED_TEXT = (
    "{tool}: 写操作已关闭（write-tools.json 未放行）。这是最终结果：不要重试，也不要假装做过。"
)


def _write_tool_enabled(tool_name: str) -> bool:
    """与旧栈 tools.js 同义：每次调用都读文件，不缓存（改完不用重启宿主）。"""
    data = _read_json(WRITE_TOOLS_JSON, {})
    if not isinstance(data, dict) or data.get("enabled") is not True:
        return False
    if tool_name == "qq_napcat_api":
        return data.get("napcatApi") is True
    tools = data.get("tools") if isinstance(data.get("tools"), dict) else {}
    return tools.get(tool_name) is True


def _write_audit_dir() -> str:
    path = str(CFG.get("audit_dir") or "").strip()
    if path:
        return path
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "xzy", "audit")


def _write_audit(
    event: Any,
    tool_name: str,
    action: str,
    params: dict[str, Any],
    result: str,
    *,
    code: str = "",
    error: str = "",
) -> None:
    """每次写操作留一条：谁触发、什么参数、结果。失败也记，绝不影响业务。"""
    try:
        master = _master_qq()
        try:
            sender = str(getattr(event, "get_sender_id", lambda: "")() or "")
        except Exception:  # noqa: BLE001
            sender = ""
        try:
            kind, cid = _current_chat(event)
            chat = f"{kind}:{cid}"
        except Exception:  # noqa: BLE001
            chat = ""
        row = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "actor": sender or "unknown",
            "actorRole": "master" if sender and sender == master else "member",
            "surface": "astrbot",
            "tool": tool_name,
            "action": action,
            "params": params,
            "chatId": chat,
            "messageId": "",
            "result": result,
            "code": code,
            "error": error,
        }
        directory = _write_audit_dir()
        os.makedirs(directory, exist_ok=True)
        with open(os.path.join(directory, "write-tools.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
            f.flush()
    except Exception:  # noqa: BLE001
        pass


def _write_gate(event: Any, tool_name: str, params: dict[str, Any]) -> dict[str, Any] | None:
    if _write_tool_enabled(tool_name):
        return None
    _write_audit(event, tool_name, "gate", params, "blocked", code="write-tools-off")
    return tr.result_blocked("disabled", WRITE_TOOL_CLOSED_TEXT.format(tool=tool_name))


async def _call_action(event: Any, action: str, **params: Any) -> Any:
    bot = getattr(event, "bot", None)
    if bot is None:
        raise _MissingBot(f"当前平台不支持 OneBot action 调用（缺少 event.bot）：{action}")
    return await bot.call_action(action, **params)


def _exception_result(exc: BaseException, tool_name: str) -> dict[str, Any]:
    if isinstance(exc, _MissingBot):
        return tr.result_blocked("disabled", str(exc))
    if isinstance(exc, _Upstream):
        return tr.result_fail(
            "upstream-error", str(exc), "上游这次失败了，不要立刻原样重试；过一会儿再试。", final=True
        )
    return tr.fail_from_error(exc, tool_name)


def _action_payload(ret: Any, action: str) -> Any:
    if ret is None:
        raise _Upstream(f"{action} 没有返回结果")
    if isinstance(ret, (dict, list)):
        if len(ret) == 0:
            raise _Upstream(f"{action} 返回空结果")
        return ret
    raise _Upstream(f"{action} 返回了无法解析的结果：{str(ret)[:120]}")


def _read_json(path: str, default: Any) -> Any:
    try:
        with open(path, encoding="utf-8-sig") as f:
            return json.load(f)
    except Exception:
        return default


def _write_json(path: str, data: Any) -> None:
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _int_param(value: Any, default: int, low: int, high: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(low, min(high, number))


def _optional_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value == value:
        return int(value)
    if isinstance(value, str) and re.fullmatch(r"-?\d+", value.strip()):
        return int(value.strip())
    return None


def _qq_number(value: Any, label: str) -> int:
    raw = str(value if isinstance(value, (int, str)) else "").strip()
    if not re.fullmatch(r"\d{5,12}", raw):
        raise ValueError(f"{label} 必须是 5-12 位 QQ 号")
    return int(raw)


def _group_id_of(event: Any, value: Any) -> int:
    raw = str(value if isinstance(value, (int, str)) else "").strip()
    if raw:
        if not re.fullmatch(r"\d{5,12}", raw):
            raise ValueError("group_id 必须是 5-12 位群号")
        return int(raw)
    chat = _current_chat(event)
    if chat[0] != "group":
        raise ValueError("该操作仅支持群聊：请传 group_id")
    return int(chat[1])


def _cq_plain(raw: str) -> str:
    return re.sub(r"\[CQ:[^\]]+\]", "", raw or "").strip()


def _message_text(message: Any, raw: str) -> tuple[str, str | None, str | None]:
    parts: list[str] = []
    reply_id: str | None = None
    forward_id: str | None = None
    if isinstance(message, list):
        for seg in message:
            if not isinstance(seg, dict):
                continue
            kind = str(seg.get("type") or "")
            data = seg.get("data") if isinstance(seg.get("data"), dict) else {}
            if kind == "text":
                parts.append(str(data.get("text") or ""))
            elif kind == "at":
                parts.append("@" + str(data.get("qq") or ""))
            elif kind == "reply":
                reply_id = str(data.get("id") or "") or None
            elif kind == "forward":
                forward_id = str(data.get("id") or "") or None
                parts.append("[合并转发]")
            elif kind == "image":
                parts.append("[图片]")
            elif kind == "face":
                parts.append(faces.label(data.get("id")))
            elif kind == "record":
                parts.append("[语音]")
            elif kind == "video":
                parts.append("[视频]")
            elif kind == "file":
                parts.append("[文件]")
    text = "".join(parts).strip()
    if text == "" and raw:
        text = _cq_plain(raw)
    return text, reply_id, forward_id


def _iso(ms: int) -> str:
    return (
        datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _day_key(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d")


def _clip(text: str, limit: int) -> str:
    value = re.sub(r"\s+", " ", str(text or "")).strip()
    return value[:limit] + "…" if len(value) > limit else value


# --------------------------------------------------------------------------- #
# qq_tool：目录 / 加载 / 帮助
# --------------------------------------------------------------------------- #
CATALOG_GROUPS = (
    (
        "常驻（不用加载）",
        ("qq_tool", "qq_send_image", "qq_at", "qq_send_sticker", "qq_poke", "memory_search", "qq_notebook"),
    ),
    ("群聊互动", ("qq_react", "qq_group_history")),
    (
        "语音/文件",
        (
            "qq_send_voice", "qq_send_tts", "qq_send_video", "qq_send_file", "qq_send_forward",
            "qq_ask_image", "qq_bili_feed", "qq_bili_watch", "qq_draw", "qq_read_video",
        ),
    ),
    ("角色与记忆", ("qq_character_note", "qq_diary", "qq_request_master")),
    ("草稿本", ("qq_draft_write", "qq_draft_show", "qq_draft_discard", "qq_draft_submit")),
    (
        "主人只读/高级",
        (
            "qq_qzone_feed", "qq_qzone_like", "qq_qzone_post", "qq_qzone_extra", "qq_group_query",
            "qq_group_file", "qq_group_album", "qq_image_review", "qq_task", "qq_napcat_api", "qq_profile",
        ),
    ),
)
CATALOG_MODULES = (
    "tools_batch1", "tools_batch2", "tools_batch3", "tools_memory", "tools_sticker", "tools_batch4",
    "tools_draft",
)


def _import_sibling(name: str) -> Any:
    package = __package__ or ""
    if package:
        return importlib.import_module("." + name, package)
    return importlib.import_module(name)


def _catalog() -> dict[str, str]:
    catalog: dict[str, str] = {}
    for module_name in CATALOG_MODULES:
        try:
            module = _import_sibling(module_name)
        except Exception:  # noqa: BLE001 - 某个模块没装不应拖垮目录
            continue
        for spec in getattr(module, "TOOL_SPECS", []) or []:
            name = str(spec.get("name") or "")
            if name:
                catalog[name] = _clip(str(spec.get("description") or ""), 60)
    return catalog


def _catalog_text(catalog: dict[str, str]) -> str:
    lines: list[str] = []
    listed: set[str] = set()
    for label, names in CATALOG_GROUPS:
        entries = [(name, catalog[name]) for name in names if name in catalog]
        if not entries:
            continue
        lines.append(f"[{label}]")
        for name, line in entries:
            lines.append(f"- {name}：{line}")
            listed.add(name)
        lines.append("")
    rest = sorted(name for name in catalog if name not in listed)
    if rest:
        lines.append("[其他工具]")
        for name in rest:
            lines.append(f"- {name}：{catalog[name]}")
        lines.append("")
    lines.append("所有工具都已常驻，直接调用即可，不用 load。")
    return "\n".join(lines)


async def qq_tool(
    event: Any = None, action: str = "list", names: Any = None, name: str = "", **_: Any
) -> dict[str, Any]:
    try:
        act = action if action in ("load", "help") else "list"
        catalog = _catalog()
        if act == "list":
            text = _catalog_text(catalog)
            return tr.result_ok(f"工具目录共 {len(catalog)} 个", data={"action": "list", "text": text})
        if act == "help":
            target = str(name or "").strip()
            if target == "":
                raise ValueError("qq_tool: help 需要 name")
            if target not in catalog:
                raise ValueError(f"qq_tool: 没有这个工具：{target}")
            group_label = next(
                (label for label, items in CATALOG_GROUPS if target in items), "其他"
            )
            return tr.result_ok(
                f"{target}：{catalog[target]}（分组：{group_label}）",
                data={"action": "help", "name": target, "group": group_label},
            )
        requested: list[str] = []
        if isinstance(names, list):
            requested.extend(str(item).strip() for item in names if isinstance(item, str) and item.strip())
        if not requested and str(name or "").strip():
            requested.append(str(name).strip())
        if not requested:
            raise ValueError('qq_tool: load 需要 names，例如 ["qq_at","qq_react"]')
        unique = list(dict.fromkeys(requested))
        limit = 3
        rejected = [{"name": item, "reason": f"单次最多 {limit} 个，本次未受理"} for item in unique[limit:]]
        already = [item for item in unique[:limit] if item in catalog]
        unknown = [
            {"name": item, "reason": "没有这个工具"} for item in unique[:limit] if item not in catalog
        ]
        rejected.extend(unknown)
        return tr.result_done(
            "already-done",
            "按需加载已关闭：所有工具都已常驻，直接调用即可，不用 load。",
            data={"action": "load", "loaded": [], "already": already, "rejected": rejected},
        )
    except Exception as exc:  # noqa: BLE001
        return _exception_result(exc, "qq_tool")


# --------------------------------------------------------------------------- #
# qq_group_history
# --------------------------------------------------------------------------- #
async def qq_group_history(
    event: Any = None, chat_id: str = "", count: Any = 20, message_seq: Any = None, **_: Any
) -> dict[str, Any]:
    try:
        if event is None:
            raise ValueError("缺少事件上下文")
        chat = _resolve_chat(event, chat_id)
        if chat is None:
            raise ValueError("chat_id 格式应为 group:<群号> 或 private:<QQ号>")
        if chat[0] != "group":
            raise ValueError("qq_group_history: 仅支持群聊")
        size = _int_param(count, 20, 1, 50)
        params: dict[str, Any] = {"group_id": int(chat[1]), "count": size}
        seq = _optional_int(message_seq)
        if seq is not None:
            params["message_seq"] = seq
        ret = await _call_action(event, "get_group_msg_history", **params)
        payload = _action_payload(ret, "get_group_msg_history")
        if not isinstance(payload, dict):
            raise _Upstream("get_group_msg_history 返回了非对象结果")
        raw_messages = payload.get("messages")
        if not isinstance(raw_messages, list) or not raw_messages:
            raise _Upstream("get_group_msg_history 没有返回任何消息")
        rows: list[dict[str, Any]] = []
        for item in raw_messages:
            if not isinstance(item, dict):
                continue
            sender = item.get("sender") if isinstance(item.get("sender"), dict) else {}
            raw = item.get("raw_message") if isinstance(item.get("raw_message"), str) else ""
            text, reply_id, forward_id = _message_text(item.get("message"), raw)
            user_id = sender.get("user_id")
            if user_id is None:
                user_id = item.get("user_id")
            nickname = (
                str(sender.get("card") or "")
                or str(sender.get("nickname") or "")
                or str(user_id or "")
            )
            rows.append(
                {
                    "message_id": str(item["message_id"]) if item.get("message_id") is not None else None,
                    "time": str(item["time"]) if item.get("time") is not None else None,
                    "user_id": str(user_id) if user_id is not None else None,
                    "nickname": nickname,
                    "text": text,
                    "reply_id": reply_id,
                    "forward_id": forward_id,
                }
            )
        if not rows:
            raise _Upstream("get_group_msg_history 返回的消息都无法解析")
        return tr.result_ok(f"{len(rows)} 条历史消息", data={"count": len(rows), "messages": rows})
    except Exception as exc:  # noqa: BLE001
        return _exception_result(exc, "qq_group_history")


# --------------------------------------------------------------------------- #
# qq_request_master
# --------------------------------------------------------------------------- #
async def qq_request_master(
    event: Any = None, kind: str = "other", text: str = "", reason: str = "", **_: Any
) -> dict[str, Any]:
    try:
        if event is None:
            raise ValueError("缺少事件上下文")
        master = _master_qq()
        if not re.fullmatch(r"\d{5,12}", master):
            return tr.result_blocked("disabled", "qq_request_master: 未配置主人 QQ")
        body_text = str(text or "").strip()
        if len(body_text) < 2:
            raise ValueError("qq_request_master: text 太短")
        if len(body_text) > 200:
            raise ValueError("qq_request_master: text 最长 200 字，请压缩")
        reason_raw = str(reason or "").strip()
        if len(reason_raw) > 200:
            raise ValueError("qq_request_master: reason 最长 200 字，请压缩")
        kind_raw = str(kind or "").strip().lower() or "other"
        kind_value = kind_raw if kind_raw in ("permission", "feature", "fix", "other") else "other"
        now = int(time.time() * 1000)
        state = _read_json(REQUESTS_JSON, {})
        if not isinstance(state, dict):
            state = {}
        requests = state.get("requests")
        requests = [entry for entry in requests if isinstance(entry, dict)] if isinstance(requests, list) else []
        requests = [
            entry
            for entry in requests
            if isinstance(entry.get("ts"), (int, float)) and now - float(entry["ts"]) < MASTER_REQUEST_KEEP_MS
        ]
        if requests:
            latest = requests[-1]
            elapsed = now - int(latest.get("ts") or 0)
            if elapsed < MASTER_REQUEST_COOLDOWN_MS:
                minutes = (MASTER_REQUEST_COOLDOWN_MS - elapsed + 59999) // 60000
                return tr.result_blocked(
                    "cooldown", f"qq_request_master: 刚问过主人，还要等 {minutes} 分钟"
                )
        day_key = _day_key(now)
        today_count = sum(1 for entry in requests if _day_key(int(entry.get("ts") or 0)) == day_key)
        if today_count >= MASTER_REQUEST_DAILY_LIMIT:
            return tr.result_done(
                "limit-reached",
                f"qq_request_master: 今天已经问过 {MASTER_REQUEST_DAILY_LIMIT} 次，明天再说",
            )
        kind_label = {"permission": "权限", "feature": "新功能", "fix": "修复"}.get(kind_value, "请求")
        chat = _current_chat(event)
        if chat[0] == "private" and chat[1] == master:
            source = "主人私聊"
        elif chat[0] == "group":
            source = "群 " + chat[1]
        else:
            source = "私聊 " + chat[1]
        body = "\n".join(
            [
                f"【小助手请求 · {kind_label}】",
                body_text,
                *([f"原因：{reason_raw}"] if reason_raw else []),
                f"来源：{source}",
                "（只是请求，我不会自己改配置或加权限。）",
            ]
        )
        if getattr(event, "bot", None) is None:
            return tr.result_blocked("disabled", "qq_request_master: 当前平台不支持 OneBot 直发")
        message_id = await _send_segments(event, ("private", master), [_text_seg(body)])
        if message_id is None or str(message_id).strip() == "":
            return tr.result_fail(
                "unlanded",
                "发给主人的请求没有返回 message_id，这次没有真正发出去",
                "不要当成已经问过主人，也不要原样重试。",
                final=True,
            )
        request_id = uuid.uuid4().hex[:8]
        requests.append(
            {
                "id": request_id,
                "ts": now,
                "kind": kind_value,
                "text": body_text,
                "reason": reason_raw,
                "source": f"{chat[0]}:{chat[1]}",
                "messageId": message_id,
            }
        )
        persisted = True
        try:
            state.update(
                {
                    "version": 1,
                    "requests": requests[-100:],
                    "updatedAt": _iso(now),
                }
            )
            _write_json(REQUESTS_JSON, state)
        except OSError as exc:
            persisted = False
            _log("warn", f"qq_request_master 记录写入失败：{exc}")
        remaining = max(0, MASTER_REQUEST_DAILY_LIMIT - today_count - 1)
        # kind=other 时 kind_label 本身是"请求"，直接拼会重复成"请求请求"
        prefix = "" if kind_label == "请求" else kind_label
        return tr.result_ok(
            f"已把{prefix}请求发给主人（今日还剩 {remaining} 次）",
            data={
                "requestId": request_id,
                "kind": kind_value,
                "messageId": message_id,
                "remainingToday": remaining,
                "persisted": persisted,
            },
        )
    except Exception as exc:  # noqa: BLE001
        return _exception_result(exc, "qq_request_master")


# --------------------------------------------------------------------------- #
# Qzone
# --------------------------------------------------------------------------- #
def _remember_feed(tid: str, target_uin: int, abstime: int) -> None:
    if not tid:
        return
    _FEED_INDEX[tid] = (target_uin, abstime)
    while len(_FEED_INDEX) > QZONE_FEED_INDEX_LIMIT:
        _FEED_INDEX.pop(next(iter(_FEED_INDEX)))


def _qzone_plain_text(html: Any) -> str:
    text = str(html or "")
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]*>", "", text)
    for source, target in (("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"')):
        text = text.replace(source, target)
    return re.sub(r"\s+\n", "\n", text).strip()


def _normalize_qzone_image(source: str) -> str:
    value = source.strip()
    if value.startswith("[图片:") and value.endswith("]"):
        value = value[4:-1].strip()
    if re.match(r"^(?:https?|file|base64)://", value, re.I):
        return value
    if re.match(r"^[A-Za-z]:[\\/]", value):
        return "file:///" + value.replace("\\", "/")
    if value.startswith("/"):
        return "file://" + value
    return value


async def qq_qzone_feed(
    event: Any = None, count: Any = 10, page_num: Any = 1, cursor: str = "", **_: Any
) -> dict[str, Any]:
    try:
        if event is None:
            raise ValueError("缺少事件上下文")
        blocked = _master_guard(event, "qq_qzone_feed")
        if blocked is not None:
            return blocked
        size = _int_param(count, 10, 1, 50)
        page = max(1, _int_param(page_num, 1, 1, 10**6))
        params: dict[str, Any] = {"page_num": page, "count": size}
        cursor_value = str(cursor or "").strip()
        if cursor_value:
            params["cursor"] = cursor_value
        ret = await _call_action(event, "get_qzone_feeds", **params)
        payload = _action_payload(ret, "get_qzone_feeds")
        if not isinstance(payload, dict):
            raise _Upstream("get_qzone_feeds 返回了非对象结果")
        raw_feeds = payload.get("feeds")
        if not isinstance(raw_feeds, list) or not raw_feeds:
            raise _Upstream("get_qzone_feeds 本页没有读到动态")
        feeds: list[dict[str, Any]] = []
        for feed in raw_feeds:
            if not isinstance(feed, dict):
                continue
            tid = feed.get("tid") if isinstance(feed.get("tid"), str) and feed.get("tid") else None
            target_uin = int(feed.get("uin") or 0)
            abstime = int(feed.get("time") or 0)
            if tid:
                _remember_feed(tid, target_uin, abstime)
            raw_content = str(feed.get("content") or "").strip() or _qzone_plain_text(feed.get("html"))
            images = feed.get("images") if isinstance(feed.get("images"), list) else []
            forward_content = str(feed.get("rt_con") or feed.get("rt_content") or "").strip()
            forward_uin = int(feed.get("rt_uin") or feed.get("rtUin") or 0)
            forward_nick = str(
                feed.get("rt_nickname") or feed.get("rt_name") or feed.get("rt_username") or ""
            ).strip()
            is_forward = bool(
                forward_content
                or forward_uin > 0
                or int(feed.get("rt_tid") or 0) > 0
                or feed.get("type") == "forward"
                or feed.get("is_forward") is True
            )
            source = str(
                feed.get("source") or feed.get("app_name") or feed.get("feed_source") or feed.get("from") or ""
            ).strip()
            nickname = str(feed.get("nickname") or "")
            feeds.append(
                {
                    "tid": tid,
                    "target_uin": str(target_uin) if target_uin > 0 else None,
                    "abstime": abstime if abstime > 0 else None,
                    "nickname": nickname,
                    "author": {"nickname": nickname, "qq": str(target_uin) if target_uin > 0 else None},
                    "time": abstime,
                    "content": _clip(raw_content, QZONE_FEED_CONTENT_MAX) if raw_content else "",
                    "images": images[:4],
                    "image_count": len(images),
                    "like_count": feed.get("like_count") if isinstance(feed.get("like_count"), int) else None,
                    "comment_count": (
                        feed.get("comment_count") if isinstance(feed.get("comment_count"), int) else None
                    ),
                    "source": source or None,
                    "forward": {
                        "is_forward": is_forward,
                        "nickname": forward_nick or None,
                        "qq": str(forward_uin) if forward_uin > 0 else None,
                        "content": _clip(forward_content, QZONE_FORWARD_CONTENT_MAX) if forward_content else None,
                    },
                }
            )
        if not feeds:
            raise _Upstream("get_qzone_feeds 返回的动态都无法解析")
        next_cursor = payload.get("next_cursor") if isinstance(payload.get("next_cursor"), str) else None
        return tr.result_ok(
            f"本页 {len(feeds)} 条好友动态",
            data={"feeds": feeds, "has_more": payload.get("has_more") is True, "next_cursor": next_cursor},
        )
    except Exception as exc:  # noqa: BLE001
        return _exception_result(exc, "qq_qzone_feed")


async def qq_qzone_like(
    event: Any = None, tid: Any = "", target_uin: Any = "", abstime: Any = None, unlike: bool = False, **_: Any
) -> dict[str, Any]:
    try:
        if event is None:
            raise ValueError("缺少事件上下文")
        blocked = _master_guard(event, "qq_qzone_like")
        if blocked is not None:
            return blocked
        blocked = _write_gate(event, "qq_qzone_like", {"tid": str(tid), "unlike": bool(unlike)})
        if blocked is not None:
            return blocked
        tid_value = str(tid if isinstance(tid, (str, int)) else "").strip()
        if tid_value == "":
            raise ValueError("qq_qzone_like: tid 必填（先用 qq_qzone_feed 读动态）")
        cached = _FEED_INDEX.get(tid_value)
        raw_target = str(target_uin if isinstance(target_uin, (str, int)) else "").strip()
        if raw_target and not re.fullmatch(r"\d+", raw_target):
            raise ValueError("qq_qzone_like: target_uin 必须是 QQ 号")
        target = int(raw_target) if raw_target else (cached[0] if cached else 0)
        at = _optional_int(abstime)
        if at is None:
            at = cached[1] if cached else 0
        liked = not bool(unlike)
        if _LIKE_STATE.get(tid_value) is liked:
            return tr.result_done(
                "already-done",
                "已经点过赞" if liked else "已经是未点赞状态",
                data={"tid": tid_value, "liked": liked},
            )
        params: dict[str, Any] = {"tid": tid_value, "abstime": at}
        if target > 0:
            params["target_uin"] = target
        try:
            await _call_action(event, "unlike_qzone" if unlike else "like_qzone", **params)
        except Exception as exc:  # noqa: BLE001 - 点赞失败是终态
            _write_audit(
                event,
                "qq_qzone_like",
                "unlike_qzone" if unlike else "like_qzone",
                params,
                "failed",
                error=str(exc)[:200],
            )
            if isinstance(exc, _MissingBot):
                return tr.result_blocked("disabled", str(exc))
            return tr.result_fail(
                "upstream-error",
                f"点赞失败：{exc}",
                "点赞失败是最终结果：本轮不要重试同一 tid，也不要说已经点过赞。",
                final=True,
            )
        _write_audit(
            event,
            "qq_qzone_like",
            "unlike_qzone" if unlike else "like_qzone",
            params,
            "ok",
        )
        _LIKE_STATE[tid_value] = liked
        while len(_LIKE_STATE) > QZONE_LIKE_STATE_LIMIT:
            _LIKE_STATE.pop(next(iter(_LIKE_STATE)))
        return tr.result_ok(
            "已取消赞" if unlike else "已点赞",
            data={
                "tid": tid_value,
                "target_uin": str(target) if target > 0 else None,
                "abstime": at,
                "liked": liked,
            },
        )
    except Exception as exc:  # noqa: BLE001
        return _exception_result(exc, "qq_qzone_like")


async def qq_qzone_post(
    event: Any = None,
    content: str = "",
    images: Any = None,
    ask_first: Any = True,
    ask_chat_id: str = "",
    reason: str = "",
    ugc_right: Any = 1,
    **_: Any,
) -> dict[str, Any]:
    try:
        if event is None:
            raise ValueError("缺少事件上下文")
        blocked = _master_guard(event, "qq_qzone_post", "仅主人可用，或先由主人发起一次配图请求")
        if blocked is not None:
            return blocked
        blocked = _write_gate(
            event,
            "qq_qzone_post",
            {
                "contentHead": str(content or "")[:80],
                "images": len(images) if isinstance(images, list) else 0,
            },
        )
        if blocked is not None:
            return blocked
        body = str(content or "").replace("😅", "").strip()
        if body == "":
            raise ValueError("qq_qzone_post: content 必填（😅 已移除，不能作为正文）")
        if len(body) > 1000:
            raise ValueError("qq_qzone_post: content 最长 1000 字，请压缩")
        verdict = await review_mod.review_outbound_text(body, CFG, mode="qzone", log=_log)
        if verdict["action"] == "drop":
            return tr.result_fail(
                "policy-rejected",
                "qq_qzone_post: 动态正文未通过二次审核：" + "，".join(verdict["reasons"]),
                "这是最终结果，不要重试，也不要换措辞再发。",
                final=True,
            )
        items = [item for item in (images or []) if isinstance(item, str) and item.strip()] if isinstance(images, list) else []
        if len(items) > QZONE_MAX_IMAGES:
            raise ValueError("qq_qzone_post: 一次最多 9 张图")
        ugc = _optional_int(ugc_right)
        if ugc not in (1, 4, 16, 64, 128):
            ugc = 1
        master = _master_qq()
        if len(items) == 0 and ask_first is not False:
            if str(ask_chat_id or "").strip():
                ask_chat = _resolve_chat(event, ask_chat_id)
                if ask_chat is None:
                    raise ValueError("chat_id 格式应为 group:<群号> 或 private:<QQ号>")
            else:
                if not re.fullmatch(r"\d{5,12}", master):
                    return tr.result_blocked("disabled", "qq_qzone_post: 未配置主人 QQ，无法先要图")
                ask_chat = ("private", master)
            clean = re.sub(r"\s+", " ", str(reason or "").strip()).rstrip("。！？!?")
            if clean == "":
                clean = "有没有适合配今天动态的图"
            suffix = "" if re.search(r"动态|配图", clean) else "，想拿一张来配今天的动态"
            key = f"{ask_chat[0]}:{ask_chat[1]}"
            if ask_chat[0] == "group":
                asked = f"想问问大家，{clean}？方便发我一张吗{suffix}，不方便也没关系。"
            else:
                asked = f"想跟你要张图：{clean}。方便发我一张吗{suffix}，不方便也没关系。"
            message_id = await _send_segments(event, ask_chat, [_text_seg(asked)])
            if message_id is None or str(message_id).strip() == "":
                return tr.result_fail(
                    "unlanded",
                    "要图消息没有返回 message_id，这次没有真正发出去",
                    "不要当成已经问过，也不要原样重试。",
                    final=True,
                )
            return tr.result_ok(
                f"已向 {key} 要图，动态还没发布",
                data={
                    "pending": True,
                    "askedChat": key,
                    "messageId": message_id,
                    "content": body,
                    "ugcRight": ugc,
                    "note": "旧栈的 12 小时暂存动态未迁移：收到图后带 images 重新调用 qq_qzone_post。",
                },
            )
        params: dict[str, Any] = {"content": body, "ugc_right": ugc}
        if items:
            params["images"] = [_normalize_qzone_image(item) for item in items]
        audit_params = {"contentHead": body[:80], "images": len(items), "ugcRight": ugc}
        try:
            ret = await _call_action(event, "send_qzone_msg", **params)
            payload = _action_payload(ret, "send_qzone_msg")
            if not isinstance(payload, dict):
                raise _Upstream("send_qzone_msg 返回了非对象结果")
            tid = payload.get("tid")
            if tid is None or str(tid).strip() == "":
                raise _Upstream("send_qzone_msg 没有返回 tid，这次发布没有确认成功")
        except Exception as exc:  # noqa: BLE001
            _write_audit(event, "qq_qzone_post", "send_qzone_msg", audit_params, "failed", error=str(exc)[:200])
            raise
        _write_audit(event, "qq_qzone_post", "send_qzone_msg", {**audit_params, "tid": str(tid)}, "ok")
        return tr.result_ok(
            f"已发布动态（{len(items)} 张图）" if items else "已发布纯文字动态",
            data={"tid": str(tid), "images": len(items), "ugcRight": ugc},
        )
    except Exception as exc:  # noqa: BLE001
        return _exception_result(exc, "qq_qzone_post")


async def qq_qzone_extra(
    event: Any = None,
    action: str = "",
    target_uin: Any = "",
    tid: Any = "",
    pos: Any = 0,
    num: Any = 20,
    **_: Any,
) -> dict[str, Any]:
    try:
        if event is None:
            raise ValueError("缺少事件上下文")
        blocked = _master_guard(event, "qq_qzone_extra")
        if blocked is not None:
            return blocked
        act = str(action or "").strip()
        blocked = _write_gate(event, "qq_qzone_extra", {"action": act})
        if blocked is not None:
            return blocked
        target = _qq_number(target_uin, "target_uin") if str(target_uin or "").strip() else None
        offset = _optional_int(pos)
        size = _optional_int(num)
        params: dict[str, Any] = {"pos": offset if offset is not None else 0, "num": size if size is not None else 20}
        if act == "profile":
            endpoint = "get_qzone_profile"
            params.pop("pos", None)
            params.pop("num", None)
        elif act == "msg_list":
            endpoint = "get_qzone_msg_list"
        elif act == "msg_detail":
            tid_value = str(tid or "").strip()
            if tid_value == "":
                raise ValueError("qq_qzone_extra: msg_detail 需要 tid")
            endpoint = "get_qzone_msg_detail"
            params["tid"] = tid_value
        else:
            raise ValueError(f"qq_qzone_extra: 不支持的 action：{act}")
        if target is not None:
            params["target_uin"] = target
        try:
            ret = await _call_action(event, endpoint, **params)
            payload = _action_payload(ret, endpoint)
        except Exception as exc:  # noqa: BLE001
            _write_audit(
                event, "qq_qzone_extra", f"qzone-extra:{act}", params, "failed", error=str(exc)[:200]
            )
            raise
        _write_audit(event, "qq_qzone_extra", f"qzone-extra:{act}", params, "ok")
        return tr.result_ok(f"已查询空间资料（{act}）", data={"action": act, "result": payload})
    except Exception as exc:  # noqa: BLE001
        return _exception_result(exc, "qq_qzone_extra")


# --------------------------------------------------------------------------- #
# 群只读
# --------------------------------------------------------------------------- #
QQ_GROUP_QUERY_ACTIONS = (
    "info", "info_ex", "detail", "members", "member", "honor", "system", "settings",
    "shut", "signed", "tags", "notices", "essence", "at_all", "share_link", "todo",
)


async def qq_group_query(
    event: Any = None,
    action: str = "",
    group_id: Any = "",
    user_id: Any = "",
    type: str = "",
    count: Any = None,
    only_pending: bool = False,
    no_cache: bool = False,
    need_short_url: bool = False,
    **_: Any,
) -> dict[str, Any]:
    try:
        if event is None:
            raise ValueError("缺少事件上下文")
        blocked = _master_guard(event, "qq_group_query")
        if blocked is not None:
            return blocked
        act = str(action or "").strip()
        if act not in QQ_GROUP_QUERY_ACTIONS:
            raise ValueError(f"qq_group_query: 不支持的 action：{act}")
        gid = _group_id_of(event, group_id)
        if act == "info":
            endpoint, params = "get_group_info", {"group_id": gid}
        elif act == "info_ex":
            endpoint, params = "get_group_info_ex", {"group_id": gid, "no_cache": no_cache is True}
        elif act == "detail":
            endpoint, params = "get_group_detail_info", {"group_id": gid, "no_cache": no_cache is True}
        elif act == "members":
            endpoint, params = "get_group_member_list", {"group_id": gid}
        elif act == "member":
            endpoint, params = "get_group_member_info", {
                "group_id": gid,
                "user_id": _qq_number(user_id, "user_id"),
            }
        elif act == "honor":
            endpoint, params = "get_group_honor_info", {"group_id": gid, "type": str(type or "all")}
        elif act == "system":
            size = _optional_int(count)
            endpoint, params = "get_group_system_msg", {
                "group_id": gid,
                "only_pending": only_pending is True,
                "count": size if size is not None else 20,
            }
        elif act == "settings":
            endpoint, params = "get_group_admin_settings", {"group_id": gid}
        elif act == "shut":
            endpoint, params = "get_group_shut_list", {"group_id": gid}
        elif act == "signed":
            endpoint, params = "get_group_signed_list", {"group_id": gid}
        elif act == "tags":
            endpoint, params = "get_group_tags", {"group_id": gid}
        elif act == "notices":
            endpoint, params = "_get_group_notice", {"group_id": gid}
        elif act == "essence":
            endpoint, params = "get_essence_msg_list", {"group_id": gid}
        elif act == "at_all":
            endpoint, params = "get_group_at_all_remain", {"group_id": gid}
        elif act == "share_link":
            endpoint, params = "get_group_share_link", {"group_id": gid, "need_short_url": need_short_url is True}
        else:  # todo
            endpoint, params = "get_group_todo_list", {"group_id": gid}
        ret = await _call_action(event, endpoint, **params)
        payload = _action_payload(ret, endpoint)
        # 顺手刷新本地群成员名字表（零额外网络请求）：模型查一次成员，
        # 接话判定的「文字叫别人名字」信号就能用一次。
        if act in ("members", "member"):
            try:
                members.note_group_list(
                    gid, payload if isinstance(payload, list) else [payload]
                )
            except Exception:  # noqa: BLE001
                pass
        return tr.result_ok(f"已查询群资料（{act}）", data={"action": act, "group_id": gid, "result": payload})
    except Exception as exc:  # noqa: BLE001
        return _exception_result(exc, "qq_group_query")


async def qq_group_file(
    event: Any = None,
    action: str = "",
    group_id: Any = "",
    file_id: str = "",
    folder_id: str = "",
    busid: Any = None,
    **_: Any,
) -> dict[str, Any]:
    try:
        if event is None:
            raise ValueError("缺少事件上下文")
        blocked = _master_guard(event, "qq_group_file")
        if blocked is not None:
            return blocked
        act = str(action or "").strip()
        gid = _group_id_of(event, group_id)
        if act == "list":
            endpoint, params = "get_group_root_files", {"group_id": gid}
        elif act == "system":
            endpoint, params = "get_group_file_system_info", {"group_id": gid}
        elif act == "folder":
            folder = str(folder_id or "").strip()
            if folder == "":
                raise ValueError("qq_group_file: folder 需要 folder_id")
            endpoint, params = "get_group_files_by_folder", {"group_id": gid, "folder_id": folder}
        elif act == "url":
            file = str(file_id or "").strip()
            if file == "":
                raise ValueError("qq_group_file: url 需要 file_id")
            endpoint, params = "get_group_file_url", {"group_id": gid, "file_id": file}
            bus = _optional_int(busid)
            if bus is not None:
                params["busid"] = bus
        else:
            raise ValueError(f"qq_group_file: 不支持的 action：{act}")
        ret = await _call_action(event, endpoint, **params)
        payload = _action_payload(ret, endpoint)
        return tr.result_ok(f"已查询群文件（{act}）", data={"action": act, "group_id": gid, "result": payload})
    except Exception as exc:  # noqa: BLE001
        return _exception_result(exc, "qq_group_file")


async def qq_group_album(
    event: Any = None,
    action: str = "",
    group_id: Any = "",
    album_id: str = "",
    attach_info: str = "",
    **_: Any,
) -> dict[str, Any]:
    try:
        if event is None:
            raise ValueError("缺少事件上下文")
        blocked = _master_guard(event, "qq_group_album")
        if blocked is not None:
            return blocked
        act = str(action or "").strip()
        gid = _group_id_of(event, group_id)
        attach = str(attach_info or "")
        if act == "albums":
            endpoint, params = "get_group_album_list", {"group_id": gid}
        elif act == "album_list":
            endpoint, params = "get_qun_album_list", {"group_id": gid, "attach_info": attach}
        elif act == "media":
            album = str(album_id or "").strip()
            if album == "":
                raise ValueError("qq_group_album: media 需要 album_id")
            endpoint, params = "get_group_album_media_list", {
                "group_id": gid,
                "album_id": album,
                "attach_info": attach,
            }
        else:
            raise ValueError(f"qq_group_album: 不支持的 action：{act}")
        ret = await _call_action(event, endpoint, **params)
        payload = _action_payload(ret, endpoint)
        return tr.result_ok(f"已查询群相册（{act}）", data={"action": act, "group_id": gid, "result": payload})
    except Exception as exc:  # noqa: BLE001
        return _exception_result(exc, "qq_group_album")


# --------------------------------------------------------------------------- #
# qq_task：tasks-store.mjs 的最小 Python 等价（同一 tasks.json 结构）
# --------------------------------------------------------------------------- #
TASK_STATUSES = ("active", "done", "cancelled", "expired")


def _clamp_number(value: Any, fallback: int, low: int, high: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(low, min(high, number))


def _normalize_task(raw: Any, index: int) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    title = str(raw.get("title") or "").strip()
    if title == "":
        return None
    created = str(raw.get("createdAt") or "")
    if not created:
        created = _iso(int(time.time() * 1000))
    updated = str(raw.get("updatedAt") or created)
    steps = raw.get("steps") if isinstance(raw.get("steps"), list) else []
    return {
        "id": str(raw.get("id") or f"t_legacy_{index}"),
        "chatId": str(raw.get("chatId") or ""),
        "title": title[:80],
        "brief": str(raw.get("brief") or "")[:500],
        "steps": [str(step)[:200] for step in steps if isinstance(step, str) and step.strip()][-12:],
        "status": raw.get("status") if raw.get("status") in TASK_STATUSES else "active",
        "ownerQQ": str(raw.get("ownerQQ") or ""),
        "ownerName": str(raw.get("ownerName") or ""),
        "ownerRole": "admin" if raw.get("ownerRole") == "admin" else "member",
        "createdAt": created,
        "updatedAt": updated,
        "lastRunAt": int(raw.get("lastRunAt") or 0),
        "runs": max(0, int(raw.get("runs") or 0)),
        "maxRuns": _clamp_number(raw.get("maxRuns"), DEFAULT_MAX_RUNS, 1, 50),
        "maxAgeHours": _clamp_number(raw.get("maxAgeHours"), DEFAULT_MAX_AGE_HOURS, 1, 72),
        "stalls": max(0, int(raw.get("stalls") or 0)),
        "note": str(raw.get("note") or "")[:300],
    }


def _read_tasks() -> dict[str, Any]:
    raw = _read_json(TASKS_JSON, {})
    source = raw if isinstance(raw, dict) else {}
    items = source.get("tasks") if isinstance(source.get("tasks"), list) else []
    tasks = [_normalize_task(item, index) for index, item in enumerate(items)]
    return {"version": 1, "tasks": [task for task in tasks if task is not None][-MAX_TASKS:]}


def _find_task(doc: dict[str, Any], task_id: str, chat_id: str) -> dict[str, Any] | None:
    tasks = doc.get("tasks") or []
    if task_id:
        for task in tasks:
            if task["id"] == task_id and task["chatId"] == chat_id:
                return task
        return None
    active = [task for task in tasks if task["chatId"] == chat_id and task["status"] == "active"]
    active.sort(key=lambda task: task["updatedAt"], reverse=True)
    return active[0] if active else None


def _task_summary(task: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": task["id"],
        "title": task["title"],
        "status": task["status"],
        "runs": task["runs"],
        "maxRuns": task["maxRuns"],
        "steps": task["steps"][-3:],
        "note": task["note"],
    }


def _base36(value: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while value:
        out = digits[value % 36] + out
        value //= 36
    return out or "0"


async def qq_task(
    event: Any = None,
    action: str = "list",
    id: str = "",
    title: str = "",
    brief: str = "",
    steps: Any = None,
    note: str = "",
    chat_id: str = "",
    **_: Any,
) -> dict[str, Any]:
    try:
        if event is None:
            raise ValueError("缺少事件上下文")
        chat = _resolve_chat(event, chat_id)
        if chat is None:
            raise ValueError("chat_id 格式应为 group:<群号> 或 private:<QQ号>")
        chat_key = f"{chat[0]}:{chat[1]}"
        act = action if action in ("add", "update", "done", "cancel", "list") else "list"
        doc = _read_tasks()
        tasks = doc["tasks"]
        now = int(time.time() * 1000)
        if act == "list":
            active = [task for task in tasks if task["chatId"] == chat_key and task["status"] == "active"]
            active.sort(key=lambda task: task["updatedAt"], reverse=True)
            if not active:
                return tr.result_done("no-result", "这个会话没有进行中的任务", data={"action": act, "total": 0})
            return tr.result_ok(
                f"进行中任务 {len(active)} 个",
                data={"action": act, "total": len(active), "tasks": [_task_summary(task) for task in active]},
            )
        if act == "add":
            title_value = str(title or "").strip()
            if title_value == "":
                raise ValueError("qq_task: add 需要 title（一句话说明要完成什么）")
            active = [task for task in tasks if task["chatId"] == chat_key and task["status"] == "active"]
            if len(active) >= MAX_ACTIVE_PER_CHAT:
                raise ValueError(
                    f"qq_task: 这个会话已有 {len(active)} 个进行中任务，先 done/cancel 一个再建"
                )
            step_list = (
                [str(step)[:200] for step in steps if isinstance(step, str) and step.strip()][:MAX_TASK_STEPS]
                if isinstance(steps, list)
                else []
            )
            sender = str(getattr(event, "get_sender_id", lambda: "")() or "")
            name = ""
            try:
                name = str(event.get_sender_name() or "")
            except Exception:  # noqa: BLE001
                name = ""
            task = {
                "id": "t" + _base36(now) + uuid.uuid4().hex[:4],
                "chatId": chat_key,
                "title": title_value[:80],
                "brief": str(brief or "")[:500],
                "steps": step_list,
                "status": "active",
                "ownerQQ": sender,
                "ownerName": name,
                "ownerRole": "admin" if sender == _master_qq() else "member",
                "createdAt": _iso(now),
                "updatedAt": _iso(now),
                "lastRunAt": 0,
                "runs": 0,
                "maxRuns": DEFAULT_MAX_RUNS,
                "maxAgeHours": DEFAULT_MAX_AGE_HOURS,
                "stalls": 0,
                "note": "",
            }
            tasks.append(task)
            doc["tasks"] = tasks[-MAX_TASKS:]
            _write_json(TASKS_JSON, {"version": 1, "tasks": doc["tasks"], "updatedAt": _iso(now)})
            return tr.result_ok(
                "任务已开始",
                next_="每完成一步用 update，全部结束用 done，用户让停用 cancel。",
                data={"action": act, "task": _task_summary(task)},
            )
        task = _find_task(doc, str(id or "").strip(), chat_key)
        if act == "update":
            body = str(note or "").strip()
            brief_value = str(brief or "").strip()
            if body == "" and brief_value == "":
                raise ValueError("qq_task: update 需要 note 或 brief")
            if task is None or task["status"] != "active":
                return tr.result_fail(
                    "missing-target",
                    "qq_task: 没有找到进行中的任务（可能已完成，或用 list 查 id）",
                    "先 list 查一下 id，确认后再 update；找不到就别再猜。",
                )
            if brief_value:
                task["brief"] = brief_value[:500]
            if body:
                task["steps"] = (task["steps"] + [body[:200]])[-12:]
            task["updatedAt"] = _iso(now)
            task["stalls"] = 0
            _write_json(TASKS_JSON, {"version": 1, "tasks": tasks, "updatedAt": _iso(now)})
            return tr.result_ok("任务进度已记录", data={"action": act, "task": _task_summary(task)})
        # done / cancel
        if task is None:
            return tr.result_fail(
                "missing-target",
                "qq_task: 没有找到任务（用 list 查 id）",
                "先 list 查一下 id，确认后再收尾。",
            )
        if task["status"] != "active":
            return tr.result_done(
                "already-done",
                f"任务已经是 {task['status']} 状态，不用再收尾",
                data={"action": act, "task": _task_summary(task)},
            )
        task["status"] = "cancelled" if act == "cancel" else "done"
        task["note"] = str(note or "").strip()[:300]
        task["updatedAt"] = _iso(now)
        _write_json(TASKS_JSON, {"version": 1, "tasks": tasks, "updatedAt": _iso(now)})
        return tr.result_ok(
            "任务已取消" if act == "cancel" else "任务已完成",
            data={"action": act, "task": _task_summary(task)},
        )
    except Exception as exc:  # noqa: BLE001
        return _exception_result(exc, "qq_task")


# --------------------------------------------------------------------------- #
# qq_napcat_api：白名单透传
# --------------------------------------------------------------------------- #
async def qq_napcat_api(
    event: Any = None, action: str = "", params: Any = None, **_: Any
) -> dict[str, Any]:
    try:
        if event is None:
            raise ValueError("缺少事件上下文")
        blocked = _master_guard(event, "qq_napcat_api", "仅主人/管理员可用")
        if blocked is not None:
            return blocked
        act = str(action or "")
        if act not in NAPCAT_API_WHITELIST:
            raise ValueError(
                "qq_napcat_api: action 不在白名单内（" + ", ".join(NAPCAT_API_WHITELIST) + "）"
            )
        # 语音出站总开关同样管这条 NapCat 直通路径（QQ AI 语音同样是 record 出站）
        if act == "send_group_ai_record" and not (
            isinstance(CFG.get("tts"), dict) and CFG["tts"].get("enabled") is True
        ):
            return tr.result_fail(
                "policy-rejected",
                "语音出站已关闭（tts.enabled=false）：send_group_ai_record 已禁用",
                "不要重试，改用文字回复。",
            )
        payload = params if isinstance(params, dict) else {}
        audit_params = {
            key: value if isinstance(value, (int, float, bool, type(None))) else str(value)[:120]
            for key, value in payload.items()
        }
        blocked = _write_gate(event, "qq_napcat_api", {"action": act, "params": audit_params})
        if blocked is not None:
            return blocked
        try:
            ret = await _call_action(event, act, **payload)
        except Exception as exc:  # noqa: BLE001
            _write_audit(event, "qq_napcat_api", act, audit_params, "failed", error=str(exc)[:200])
            raise
        if ret is None:
            _write_audit(event, "qq_napcat_api", act, audit_params, "failed", code="empty-result")
            return tr.result_fail("upstream-error", f"{act} 没有返回结果", "不要原样重试，换一种做法。")
        _write_audit(event, "qq_napcat_api", act, audit_params, "ok")
        return tr.result_ok(f"已调用 {act}", data={"action": act, "result": ret})
    except Exception as exc:  # noqa: BLE001
        return _exception_result(exc, "qq_napcat_api")


# --------------------------------------------------------------------------- #
# 声明（schema 逐条对齐 tools.js）
# --------------------------------------------------------------------------- #
TOOL_SPECS: list[dict[str, Any]] = [
    {
        "name": "qq_tool",
        "description": "按需加载工具。system 里有「工具总表」：所有工具都已常驻，直接调用即可；action=\"list\" 看分组，action=\"help\" 查单个工具。",
        "parameters": {
            "action": {"type": "string", "required": True, "description": "list / load / help"},
            "names": {
                "type": "array",
                "items": {"type": "string"},
                "description": 'load 时要加载的工具名，例如 ["qq_at","qq_react"]',
            },
            "name": {"type": "string", "description": "help 时要查的工具名"},
        },
        "handler": qq_tool,
    },
    {
        "name": "qq_group_history",
        "description": "拉取群聊最近消息历史（供总结群内上下文、查看用户之前的发言）。仅群聊可用。",
        "parameters": {
            "chat_id": {"type": "string", "description": "目标群会话 group:<群号>；省略时默认当前会话（须为群聊）"},
            "count": {"type": "number", "description": "拉取条数（≤50，默认 20）"},
            "message_seq": {"type": "number", "description": "起始消息序号（翻页用，可选）"},
        },
        "handler": qq_group_history,
    },
    {
        "name": "qq_request_master",
        "description": "让 bot 主动私信主人，请求一项权限、开发一个新功能、或报告一个需要主人处理的问题。只是请求，不会自己改配置/加权限；每个请求有冷却和每日上限。",
        "parameters": {
            "kind": {
                "type": "string",
                "required": True,
                "description": "请求类型：permission（权限）/ feature（新功能）/ fix（修复）/ other（其他）",
            },
            "text": {
                "type": "string",
                "required": True,
                "description": "想请主人做什么，一两句说清楚（≤200 字）",
            },
            "reason": {"type": "string", "description": "为什么需要，简短一句（可选，≤200 字）"},
        },
        "handler": qq_request_master,
    },
    {
        "name": "qq_qzone_feed",
        "description": "刷 QQ 空间好友动态（只读）。返回每条动态的作者、正文、图片、点赞/评论数（仅展示），以及定位说说用的 tid/target_uin/abstime；tid 为 null 的动态不是说说。仅主人可用。",
        "parameters": {
            "count": {"type": "number", "description": "本页条数，默认 10，最多 50"},
            "page_num": {"type": "number", "description": "页码，默认 1"},
            "cursor": {"type": "string", "description": "续页游标：把上次返回的 next_cursor 原样传回"},
        },
        "handler": qq_qzone_feed,
    },
    {
        "name": "qq_qzone_like",
        "description": "给 QQ 空间的一条说说点赞，或取消赞。tid 来自 qq_qzone_feed；省略 target_uin/abstime 时会用最后一次 qq_qzone_feed 记录的值。仅主人可用。",
        "parameters": {
            "tid": {"type": "string", "required": True, "description": "说说 tid（来自 qq_qzone_feed）"},
            "target_uin": {"type": "string", "description": "说说作者 QQ；省略时用 qq_qzone_feed 记录的作者"},
            "abstime": {"type": "number", "description": "说说发表时间（unix 秒）；省略时用 qq_qzone_feed 记录的时间"},
            "unlike": {"type": "boolean", "description": "true=取消赞；默认点赞"},
        },
        "handler": qq_qzone_like,
    },
    {
        "name": "qq_qzone_post",
        "description": "发一条 Qzone 动态。没有配图且 ask_first=true 时，先礼貌向主人或指定群要图。必须先有主人授权。",
        "parameters": {
            "content": {"type": "string", "required": True, "description": "说说正文（≤1000 字）"},
            "images": {
                "type": "array",
                "items": {"type": "string"},
                "description": "可选配图：本地绝对路径、file://、http(s):// 或 base64://，最多 9 张",
            },
            "ask_first": {"type": "boolean", "description": "没有图时是否先要图，默认 true；明确要发纯文字时传 false"},
            "ask_chat_id": {"type": "string", "description": "向谁要图：private:<QQ> 或 group:<群号>；默认主人私聊"},
            "reason": {"type": "string", "description": "要图时的一句话理由（可选）"},
            "ugc_right": {"type": "number", "description": "可见范围：1=所有人，4=好友，16=部分好友，64=仅自己，128=部分好友不可见；默认 1"},
        },
        "handler": qq_qzone_post,
    },
    {
        "name": "qq_qzone_extra",
        "description": "查看 QQ 空间补充信息（仅主人，只读）：空间名称/说明、自己（或指定账号）的说说列表与说说详情（含评论）。",
        "parameters": {
            "action": {"type": "string", "required": True, "description": "profile / msg_list / msg_detail"},
            "target_uin": {"type": "string", "description": "目标 QQ 号（默认机器人自己）"},
            "tid": {"type": "string", "description": "说说 ID（msg_detail）"},
            "pos": {"type": "number", "description": "起始偏移，默认 0"},
            "num": {"type": "number", "description": "本页数量，默认 20"},
        },
        "handler": qq_qzone_extra,
    },
    {
        "name": "qq_group_query",
        "description": "查询群资料（仅主人，只读）：群信息、成员列表/单个成员、群荣誉、群系统消息、管理设置、禁言列表、签到列表、群标签、群公告、精华消息、@全体剩余次数、群分享链接、群待办。group_id 省略时用当前群聊。",
        "parameters": {
            "action": {
                "type": "string",
                "required": True,
                "description": "info / info_ex / detail / members / member / honor / system / settings / shut / signed / tags / notices / essence / at_all / share_link / todo",
            },
            "group_id": {"type": "string", "description": "群号；省略时用当前群聊"},
            "user_id": {"type": "string", "description": "成员 QQ 号（member）"},
            "type": {"type": "string", "description": "荣誉类型（honor），默认 all"},
            "count": {"type": "number", "description": "条数（system）"},
            "only_pending": {"type": "boolean", "description": "只看待处理（system）"},
            "no_cache": {"type": "boolean", "description": "跳过缓存（info_ex/detail）"},
            "need_short_url": {"type": "boolean", "description": "需要短链接（share_link）"},
        },
        "handler": qq_group_query,
    },
    {
        "name": "qq_group_file",
        "description": "查看群文件（仅主人，只读）：根目录列表、子文件夹列表、文件下载链接、群文件容量信息。group_id 省略时用当前群聊。",
        "parameters": {
            "action": {"type": "string", "required": True, "description": "list（根目录）/ folder（子文件夹）/ url（下载链接）/ system（容量信息）"},
            "group_id": {"type": "string", "description": "群号；省略时用当前群聊"},
            "file_id": {"type": "string", "description": "文件 ID（url）"},
            "folder_id": {"type": "string", "description": "文件夹 ID（folder）"},
            "busid": {"type": "number", "description": "文件业务 ID（url，可选）"},
        },
        "handler": qq_group_file,
    },
    {
        "name": "qq_group_album",
        "description": "查看群相册（仅主人，只读）：相册列表、相册媒体列表（图片/视频及分页游标）。album_id 来自相册列表。group_id 省略时用当前群聊。",
        "parameters": {
            "action": {"type": "string", "required": True, "description": "albums / album_list / media"},
            "group_id": {"type": "string", "description": "群号；省略时用当前群聊"},
            "album_id": {"type": "string", "description": "相册 ID（media）"},
            "attach_info": {"type": "string", "description": "分页游标（可选）"},
        },
        "handler": qq_group_album,
    },
    {
        "name": "qq_task",
        "description": "跨轮任务状态：需要多步或跨轮才能完成的事，先 add 建任务；每完成一步 update 记进度；全部完成 done，用户让停就 cancel。一步就能答完的小事不要建任务。",
        "parameters": {
            "action": {"type": "string", "required": True, "description": "add / update / done / cancel / list"},
            "id": {"type": "string", "description": "任务 id；update/done/cancel 省略时用当前会话最近的进行中任务"},
            "title": {"type": "string", "description": "add：一句话说明要完成什么"},
            "brief": {"type": "string", "description": "add/update：目标、约束、验收标准"},
            "steps": {
                "type": "array",
                "items": {"type": "string"},
                "description": "add：计划步骤（可选，最多 8 条）",
            },
            "note": {"type": "string", "description": "update：这一步的结果；done/cancel：收尾说明"},
            "chat_id": {"type": "string", "description": "目标会话；省略时默认当前会话"},
        },
        "handler": qq_task,
    },
    {
        "name": "qq_napcat_api",
        "description": "调用 NapCat 白名单内的 OneBot 扩展 API（群成员列表/信息、文件、OCR、AI 语音等）。非白名单 action 会被拒绝。",
        "parameters": {
            "action": {
                "type": "string",
                "required": True,
                "description": "白名单 action：" + " / ".join(NAPCAT_API_WHITELIST),
            },
            "params": {
                "type": "object",
                "properties": {},
                "description": "action 参数（JSON 对象）",
            },
        },
        "handler": qq_napcat_api,
    },
]
