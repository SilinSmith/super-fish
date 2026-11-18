"""共享发送封装（只读层）：所有工具模块只准通过这里出站。

为什么不用原生 `event.send()`：它不返回 message_id，拿不到就无法区分
"真发出去了" 和 "空返回被吞"（见 evidence/tools.md §1）。这里直连 OneBot
`send_group_msg` / `send_private_msg`，把 message_id 交回给 handler，
由 `tool_result.render()` 渲染"已发送（message_id=…）"。

- 本地图片/音频/视频/文件一律 `base64://`（对齐 media.js fileToBase64）；
- 群聊 `group:<群号>`、私聊 `private:<QQ号>`；
- 本模块是共享层，其他工具模块只读引用，不要各写一份发送逻辑。
"""

from __future__ import annotations

import base64
import os
import re
from typing import Any

try:
    from . import continuation
    from . import faces
    from . import media_fence
    from . import outbound_clean
except ImportError:  # 扁平模块加载
    import continuation  # type: ignore
    import faces  # type: ignore
    import media_fence  # type: ignore
    import outbound_clean  # type: ignore

MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_FACES = 2

CFG: dict[str, Any] = {}


def configure(cfg: dict[str, Any] | None = None) -> None:
    CFG.clear()
    CFG.update(cfg or {})


def _is_master(event: Any) -> bool:
    master = str(CFG.get("master_qq") or "")
    try:
        sender = str(event.get_sender_id() or "")
    except Exception:  # noqa: BLE001
        sender = ""
    return bool(master) and sender == master


def current_chat(event: Any) -> tuple[str, str]:
    gid = str(event.get_group_id() or "")
    if gid:
        return "group", gid
    return "private", str(event.get_sender_id())


def parse_chat_id(value: str) -> tuple[str, str] | None:
    value = (value or "").strip()
    m = re.fullmatch(r"(group|private)[:：](\d+)", value)
    if not m:
        return None
    return m.group(1), m.group(2)


def resolve_chat(event: Any, chat_id: str) -> tuple[str, str] | None:
    if not (chat_id or "").strip():
        return current_chat(event)
    chat = parse_chat_id(chat_id)
    # 显式 chat_id 只能指向当前会话；跨会话仅主人可用
    if chat is not None and chat != current_chat(event) and not _is_master(event):
        now = current_chat(event)
        raise PermissionError(
            f"仅主人可以指定其他会话；当前会话是 {now[0]}:{now[1]}，拒绝发往 {chat[0]}:{chat[1]}"
        )
    return chat


def is_url(value: str) -> bool:
    return bool(re.match(r"^https?://", value or "", re.I))


def _tts_enabled() -> bool:
    tts = CFG.get("tts") if isinstance(CFG.get("tts"), dict) else {}
    return tts.get("enabled") is True


def _guard_segments(segments: list[dict[str, Any]]) -> None:
    """出站硬拦：系统提示/注入块整条不发；tts 关闭时任何 record 段都不发。

    这里是所有工具直发的唯一入口（qq_send_msg / qq_send_tts / qq_send_voice …），
    放在这层才拦得住「模型换个工具照样发」。
    """
    text = "".join(
        str((seg.get("data") or {}).get("text") or "")
        for seg in segments
        if isinstance(seg, dict) and seg.get("type") == "text"
    )
    fingerprint = outbound_clean.system_fingerprint(text)
    if fingerprint:
        raise ValueError(f"出站内容命中系统提示指纹（{fingerprint}），整条已拦截、未发送")
    if not _tts_enabled() and any(
        isinstance(seg, dict) and seg.get("type") == "record" for seg in segments
    ):
        raise RuntimeError("语音出站已关闭（tts.enabled=false）：不要再发语音，改用文字回复")


async def send_segments(
    event: Any, chat: tuple[str, str], segments: list[dict[str, Any]]
) -> Any:
    bot = getattr(event, "bot", None)
    if bot is None:
        raise RuntimeError("当前平台不支持 OneBot 直发（缺少 event.bot）")
    kind, cid = chat
    if not cid.isdigit():
        raise ValueError(f"目标会话 ID 不是数字：{cid}")
    _guard_segments(segments)
    segments = expand_face_marks(segments)
    if kind == "group":
        ret = await bot.call_action("send_group_msg", group_id=int(cid), message=segments)
    else:
        ret = await bot.call_action("send_private_msg", user_id=int(cid), message=segments)
    # 记账在「bridge 已经返回」之后：不拖慢发送时序，只多一次 append。
    _note_sent(event, segments)
    if isinstance(ret, dict):
        return ret.get("message_id")
    return None


def expand_face_marks(
    segments: list[dict[str, Any]], max_faces: int = MAX_FACES
) -> list[dict[str, Any]]:
    """文本段里的 `[表情:名]` 换成真正的 face 段，超出上限的丢弃。

    走这里而不是另开直发通道，是为了让幂等/清洗/拆条/门禁都还在原来那条链上：
    所有 tool_send 出去的消息（含拆条后的后续气泡）都经过本函数。
    名字查不到时 tokens() 会原样保留标记，于是这条消息退化成纯文本。
    """
    used = 0
    out: list[dict[str, Any]] = []
    for seg in segments:
        if not isinstance(seg, dict) or seg.get("type") != "text":
            out.append(seg)
            continue
        toks = faces.tokens(str((seg.get("data") or {}).get("text") or ""))
        if not any(kind == "face" for kind, _ in toks):
            out.append(seg)
            continue
        for kind, value in toks:
            if kind == "text":
                if value:
                    out.append(text_seg(value))
            elif used < max_faces:
                out.append({"type": "face", "data": {"id": str(value)}})
                used += 1
    return out


def _note_sent(event: Any, segments: list[dict[str, Any]]) -> None:
    """工具直发不经过 decorating_result：在这里补出站小账 + 审计行。

    只记文本段（纯图/语音没有「问句」可言）；umo 取事件自带的
    `unified_msg_origin`，与入站 entry 的 umo 同一格式，重启后可回读。
    """
    try:
        text = "".join(
            str((seg.get("data") or {}).get("text") or "")
            for seg in segments
            if isinstance(seg, dict) and seg.get("type") == "text"
        ).strip()
        umo = str(getattr(event, "unified_msg_origin", "") or "")
        continuation.note_outbound(umo, text, stage="tool_send", persist=True)
    except Exception:  # noqa: BLE001
        # 记账失败绝不影响这次发送的返回值
        pass


def text_seg(text: str) -> dict[str, Any]:
    return {"type": "text", "data": {"text": text}}


def image_seg_from_file(path: str) -> dict[str, Any]:
    path = media_fence.assert_allowed(path)
    if not os.path.isfile(path):
        raise ValueError(f"图片文件不存在：{path}")
    size = os.path.getsize(path)
    if size > MAX_IMAGE_BYTES:
        raise ValueError(f"图片超过 {MAX_IMAGE_BYTES // 1024 // 1024}MB：{path}（{size} 字节）")
    with open(path, "rb") as f:
        raw = f.read()
    return {"type": "image", "data": {"file": "base64://" + base64.b64encode(raw).decode("ascii")}}


# 兼容旧引用名（第一批模块内部用的私有名）
_current_chat = current_chat
_parse_chat_id = parse_chat_id
_resolve_chat = resolve_chat
_is_url = is_url
_send_segments = send_segments
_text_seg = text_seg
_image_seg_from_file = image_seg_from_file
