"""第二批工具（原生 FunctionTool）：媒体直发。

覆盖旧栈 dsh-onebot-qq/lib/tools.js 的：
- qq_send_voice / qq_send_tts / qq_send_video / qq_send_file / qq_send_forward

所有发送复用 tools_batch1 的 `_send_segments()`（直连 OneBot，能取到 message_id）；
本地文件一律读成 `base64://`（与 media.js fileToBase64 一致），尺寸上限照抄：
图片 8MB / 语音 15MB / 视频与文件 20MB。

与旧栈的已知差异（单独汇报，不混入"已实现"）：
- `qq_send_tts` 的中文台词会先过 GSV 的 `/hiragana?mode=transliterate` 转假名（已接，
  见 `_to_hiragana`），失败才按 kana-only 报错；旧栈的 `voiceRequestContent` 会话字段
  在 AstrBot 侧不存在，改由模型把台词直接写进参数。`voiceToolUsed` 记账仍未接。
- 语音依赖本机 GSV 服务（127.0.0.1:5000）；服务没起时 `_to_hiragana` 返回空串，工具会
  明确报"语音不可用"，不会假装成功。
- `qq_send_forward` 的节点二审走 review.py 的 `forward-risk` 模式，与旧栈一致。
"""

from __future__ import annotations

import base64
import os
import re
import struct
import time
import uuid
from typing import Any

import aiohttp

try:
    from . import media_fence
    from . import review as review_mod
    from . import tool_result as tr
    from .tool_send import resolve_chat as _resolve_chat, send_segments as _send_segments
except ImportError:  # AstrBot 以扁平模块方式加载时走这里
    import media_fence  # type: ignore
    import review as review_mod  # type: ignore
    import tool_result as tr  # type: ignore
    from tool_send import resolve_chat as _resolve_chat, send_segments as _send_segments  # type: ignore

VOICE_MAX_BYTES = 15 * 1024 * 1024
MEDIA_MAX_BYTES = 20 * 1024 * 1024

CFG: dict[str, Any] = {}


def configure(cfg: dict[str, Any]) -> None:
    CFG.clear()
    CFG.update(cfg)


def _log(level: str, message: str) -> None:
    """二审日志：插件里统一走 astrbot logger，这里按需延迟导入避免循环。"""
    try:
        from astrbot.api import logger
    except ImportError:  # pragma: no cover
        return
    method = {"warn": "warning", "error": "error"}.get(level, "info")
    getattr(logger, method, logger.info)(f"[xzy] {message}")


def _media_dir() -> str:
    path = str(CFG.get("media_dir") or "")
    if path:
        return path
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "xzy", "media"))


# 2026-11-17 事故：模型在一次回复里连发 8 条 TTS（emotion 轮换绕过了同参数去重）。
# 止血：tts.enabled 默认 false，工具直接拒绝；开启后仍按窗口限条数 + 同台词去重。
VOICE_DISABLED_MSG = "语音出站已关闭（tts.enabled=false，事故止血中）：不要重试，改用文字回复。"
_VOICE_SENT: dict[str, list[tuple[float, str]]] = {}


def _voice_gate(event: Any, spoken: str = "") -> None:
    """语音出站闸门：总开关 → 同台词去重（忽略 emotion）→ 窗口内条数上限。

    只传 event 时仅做开关检查；传 spoken 时做完整检查并记账。
    """
    if _tts_opt("enabled", False) is not True:
        raise RuntimeError(VOICE_DISABLED_MSG)
    umo = str(getattr(event, "unified_msg_origin", "") or "")
    key = re.sub(r"\s+", "", spoken or "")
    if not umo or not key:
        return
    window = float(_tts_opt("windowSeconds", 120) or 120)
    cap = int(_tts_opt("maxPerWindow", 2) or 2)
    now = time.monotonic()
    rows = [(ts, item) for ts, item in _VOICE_SENT.get(umo, []) if now - ts < window]
    if any(item == key for _, item in rows):
        _VOICE_SENT[umo] = rows
        raise RuntimeError("这句语音本次已经发过（同台词不重复发，换 emotion 也算重复）：不要再发语音")
    if len(rows) >= cap:
        _VOICE_SENT[umo] = rows
        raise RuntimeError(
            f"{int(window)} 秒内已发 {len(rows)} 条语音，达到上限 {cap}：不要再发语音，改用文字回复"
        )
    rows.append((now, key))
    _VOICE_SENT[umo] = rows


# --------------------------------------------------------------------------- #
# 媒体段
# --------------------------------------------------------------------------- #
def _read_media(path: str, max_bytes: int, label: str) -> str:
    """本地绝对路径 → base64://；先过白名单围栏（对齐旧栈 fencedMediaFile）。"""
    raw = str(path or "").strip()
    if raw == "":
        raise ValueError(f"参数 path 必填（{label} 本地绝对路径）")
    if re.match(r"^https?://", raw, re.I):
        raise ValueError(f"参数 path 必须是本地文件路径，不支持 URL：{raw}")
    real = media_fence.assert_allowed(raw)
    size = os.path.getsize(real)
    if size > max_bytes:
        raise ValueError(f"参数 path 文件大小 {size} 字节超过上限 {max_bytes // 1024 // 1024}MB：{raw}")
    with open(real, "rb") as f:
        return "base64://" + base64.b64encode(f.read()).decode("ascii")


def _chat_or_current(event: Any, chat_id: str) -> tuple[str, str]:
    chat = _resolve_chat(event, chat_id)
    if chat is None:
        raise ValueError("chat_id 格式应为 group:<群号> 或 private:<QQ号>")
    return chat


# --------------------------------------------------------------------------- #
# 发送类
# --------------------------------------------------------------------------- #
async def qq_send_voice(
    event: Any = None, path: str = "", chat_id: str = "", **_: Any
) -> dict[str, Any]:
    if event is None:
        raise RuntimeError("缺少事件上下文")
    _voice_gate(event)
    chat = _chat_or_current(event, chat_id)
    _voice_gate(event, "file:" + os.path.basename(str(path or "")))
    file = _read_media(path, VOICE_MAX_BYTES, "语音")
    message_id = await _send_segments(event, chat, [{"type": "record", "data": {"file": file}}])
    return {"sent": True, "messageId": message_id, "chatId": f"{chat[0]}:{chat[1]}"}


async def qq_send_video(
    event: Any = None, path: str = "", chat_id: str = "", **_: Any
) -> dict[str, Any]:
    if event is None:
        raise RuntimeError("缺少事件上下文")
    chat = _chat_or_current(event, chat_id)
    file = _read_media(path, MEDIA_MAX_BYTES, "视频")
    message_id = await _send_segments(event, chat, [{"type": "video", "data": {"file": file}}])
    return {"sent": True, "messageId": message_id, "chatId": f"{chat[0]}:{chat[1]}"}


async def qq_send_file(
    event: Any = None, path: str = "", name: str = "", chat_id: str = "", **_: Any
) -> dict[str, Any]:
    if event is None:
        raise RuntimeError("缺少事件上下文")
    raw = str(path or "").strip()
    if raw == "":
        raise ValueError("参数 path 必填")
    chat = _chat_or_current(event, chat_id)
    file = _read_media(raw, MEDIA_MAX_BYTES, "文件")
    filename = str(name or "").strip() or os.path.basename(raw) or "file"
    message_id = await _send_segments(
        event, chat, [{"type": "file", "data": {"file": file, "name": filename}}]
    )
    return {"sent": True, "messageId": message_id, "name": filename}


async def qq_send_forward(
    event: Any = None, messages: Any = None, chat_id: str = "", **_: Any
) -> dict[str, Any]:
    if event is None:
        raise RuntimeError("缺少事件上下文")
    if not isinstance(messages, list) or not messages:
        raise ValueError("参数 messages 不能为空（至少一条）")
    chat = _chat_or_current(event, chat_id)
    bot = getattr(event, "bot", None)
    if bot is None:
        raise RuntimeError("当前平台不支持合并转发（缺少 event.bot）")
    nodes: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []
    for item in messages:
        if not isinstance(item, dict):
            raise ValueError("参数 messages 的每一项都必须是对象")
        content = str(item.get("content") or "").replace("😅", "")
        if content == "":
            raise ValueError("参数 messages 每条都需要 content")
        name = str(item.get("name") or "").strip() or "助手"
        if CFG.get("reviewForward") is not False and "```" not in content:
            verdict = await review_mod.review_outbound_text(
                content, CFG, mode="forward-risk", log=_log
            )
            if verdict["action"] == "drop":
                dropped.append({"name": name, "reasons": verdict["reasons"]})
                _log("warn", f"forward node dropped by review: {'，'.join(verdict['reasons'])}")
                continue
        nodes.append({"name": name[:24], "content": content[:500]})
    if not nodes:
        return tr.result_fail(
            "policy-rejected",
            "合并转发的所有节点都没通过二次审核",
            "不要重试，也不要把它们拆成普通消息再发。",
            final=True,
            dropped=dropped,
        )
    self_id = str(event.get_self_id() or "")
    payload_nodes = [
        {
            "type": "node",
            "data": {
                "uin": self_id or "0",
                "name": node["name"],
                "content": [{"type": "text", "data": {"text": node["content"]}}],
            },
        }
        for node in nodes
    ]
    kind, cid = chat
    if kind == "group":
        await bot.call_action("send_forward_msg", group_id=int(cid), messages=payload_nodes)
    else:
        await bot.call_action("send_private_forward_msg", user_id=int(cid), messages=payload_nodes)
    return tr.result_ok(
        f"已提交 {len(nodes)} 条（接口不返回消息号）",
        code="forwarded",
        landed=True,
        forwarded=len(nodes),
        dropped=dropped or None,
    )


# --------------------------------------------------------------------------- #
# TTS（Style-Bert-VITS2）
# --------------------------------------------------------------------------- #
EMOTION_PROFILES: dict[str, dict[str, Any]] = {
    "happy": {"assist": "嬉しくてたまらない！", "length": 0.92, "sdp": 0.6, "noise": 0.7, "noisew": 0.9, "weight": 0.8},
    "excited": {"assist": "わーい！すごく楽しみ！", "length": 0.9, "sdp": 0.7, "noise": 0.8, "noisew": 1.0, "weight": 0.9},
    "shy": {"assist": "ちょっと恥ずかしい…", "length": 1.08, "sdp": 0.4, "noise": 0.5, "noisew": 0.7, "weight": 0.7},
    "cute": {"assist": "ねえ、甘えてもいい？", "length": 1.1, "sdp": 0.45, "noise": 0.5, "noisew": 0.7, "weight": 0.7},
    "angry": {"assist": "もう、怒ったんだから！", "length": 0.88, "sdp": 0.7, "noise": 0.8, "noisew": 1.0, "weight": 0.85},
    "sad": {"assist": "悲しくて、泣きそう…", "length": 1.2, "sdp": 0.3, "noise": 0.4, "noisew": 0.6, "weight": 0.8},
    "speechless": {"assist": "はあ…呆れた。", "length": 1.0, "sdp": 0.35, "noise": 0.45, "noisew": 0.6, "weight": 0.6},
    "calm": {"assist": "", "length": None, "sdp": None, "noise": None, "noisew": None, "weight": 0},
}

TTS_TEXT_OK = re.compile(
    r"^[\u3041-\u3096\u309d\u309e\u30a1-\u30fa\u30fc\u30fb\s。、！？…A-Za-z0-9.,!?'\"-]+$"
)


def normalize_emotion(raw: str) -> str:
    value = str(raw or "").strip().lower()
    if value == "":
        return "calm"
    if re.search(r"开心|高兴|愉快|快乐|happy|joy", value):
        return "happy"
    if re.search(r"兴奋|激动|期待|excited|excite", value):
        return "excited"
    if re.search(r"害羞|羞|shy|embarrass", value):
        return "shy"
    if re.search(r"撒娇|可爱|甜|黏|cute|sweet|coquettish", value):
        return "cute"
    if re.search(r"生气|愤怒|怒|angry|mad", value):
        return "angry"
    if re.search(r"难过|悲伤|委屈|哭|sad|sorrow", value):
        return "sad"
    if re.search(r"无语|无奈|呆|speechless|helpless", value):
        return "speechless"
    return "calm"


def infer_emotion_from_text(text: str) -> str:
    if re.search(r"嬉|楽|わーい|やった|うれ|たのし|happy", text):
        return "happy"
    if re.search(r"興奮|わくわく|楽しみ|excited", text):
        return "excited"
    if re.search(r"恥ずか|照れ|shy|はずかし", text):
        return "shy"
    if re.search(r"甘え|好き|かわいい|cute|sweet|すき|あまえ", text):
        return "cute"
    if re.search(r"怒|むかつ|ふざけ|angry|許さ|おこ|いや", text):
        return "angry"
    if re.search(r"悲|泣|寂|つら|sad|かなし|さみ", text):
        return "sad"
    if re.search(r"はあ|呆|无语|めんど|speechless|あきれ", text):
        return "speechless"
    return "calm"


def is_tts_text(text: str) -> bool:
    return bool(TTS_TEXT_OK.match(text))


def wav_duration_ms(audio: bytes) -> float:
    if len(audio) < 44 or audio[0:4] != b"RIFF" or audio[8:12] != b"WAVE":
        return 0.0
    offset = 12
    byte_rate = 0
    data_size = 0
    while offset + 8 <= len(audio):
        chunk_id = audio[offset : offset + 4]
        size = struct.unpack("<I", audio[offset + 4 : offset + 8])[0]
        body = offset + 8
        if chunk_id == b"fmt " and size >= 16:
            byte_rate = struct.unpack("<I", audio[body + 8 : body + 12])[0]
        if chunk_id == b"data":
            data_size = size
            break
        offset = body + size + (size % 2)
    if byte_rate <= 0:
        return 0.0
    return (data_size / byte_rate) * 1000.0


def _tts_opt(key: str, default: Any) -> Any:
    group = CFG.get("tts") if isinstance(CFG.get("tts"), dict) else {}
    flat = "tts" + key[0].upper() + key[1:]
    if key in group:
        return group[key]
    if flat in CFG:
        return CFG[flat]
    return default


async def _to_hiragana(text: str, mode: str = "transliterate") -> str:
    base = str(_tts_opt("url", "http://127.0.0.1:5000")).rstrip("/")
    try:
        timeout = aiohttp.ClientTimeout(total=90)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                f"{base}/hiragana", params={"text": text, "mode": mode}
            ) as resp:
                if not resp.ok:
                    return ""
                data = await resp.json(content_type=None)
        return str((data or {}).get("text") or "").strip()
    except Exception:  # noqa: BLE001 - 与旧栈一致：转写失败返回空串
        return ""


async def qq_send_tts(
    event: Any = None,
    text: str = "",
    emotion: str = "",
    chat_id: str = "",
    model_name: str = "",
    speaker_name: str = "",
    style: str = "",
    **_: Any,
) -> dict[str, Any]:
    if event is None:
        raise RuntimeError("缺少事件上下文")
    _voice_gate(event)
    master = str(CFG.get("master_qq") or "")
    if master and str(event.get_sender_id() or "") != master:
        raise PermissionError("qq_send_tts: 仅主人可用")
    body = str(text or "").strip()
    if body == "":
        raise ValueError("参数 text 必填")
    max_chars = int(_tts_opt("maxChars", 500) or 500)
    kana_only = _tts_opt("kanaOnly", True) is not False
    if len(body) > max_chars:
        raise ValueError(f"参数 text 过长（最多 {max_chars} 字），请自己压缩或分段")
    spoken = body
    if kana_only and not is_tts_text(spoken):
        converted = await _to_hiragana(spoken)
        if converted and is_tts_text(converted):
            spoken = converted
    if len(spoken) > max_chars:
        spoken = spoken[:max_chars]
    if kana_only and not is_tts_text(spoken):
        raise ValueError("台词必须是假名/日式英语，不能含汉字或中文；请自己转写后重试，不要问用户")
    if not re.search(r"[\u3040-\u30ff]", spoken):
        raise ValueError("参数 text 必须是日语（至少包含平假名或片假名）")

    # 合成前就卡住重复台词/超量：合成一次要几秒，不能让模型靠换 emotion 反复刷
    _voice_gate(event, spoken)

    emo = normalize_emotion(emotion or infer_emotion_from_text(spoken))
    profile = EMOTION_PROFILES.get(emo) or EMOTION_PROFILES["calm"]
    base = str(_tts_opt("url", "http://127.0.0.1:5000")).rstrip("/")
    params: dict[str, Any] = {
        "text": spoken,
        "model_name": str(model_name or _tts_opt("modelName", "Fusetsu-v1.5")),
        "speaker_name": str(speaker_name or _tts_opt("speakerName", "Fusetsu_v1.5")),
        "style": str(style or _tts_opt("style", "Neutral")),
        "style_weight": str(_tts_opt("styleWeight", 1.0)),
        "length": str(profile["length"] if profile["length"] is not None else _tts_opt("length", 1.0)),
        "language": str(_tts_opt("language", "JP")),
    }
    if profile["assist"]:
        params.update(
            {
                "assist_text": profile["assist"],
                "assist_text_weight": str(profile["weight"]),
                "sdp_ratio": str(profile["sdp"]),
                "noise": str(profile["noise"]),
                "noisew": str(profile["noisew"]),
            }
        )
    timeout_s = float(_tts_opt("timeoutMs", 120000)) / 1000.0
    try:
        timeout = aiohttp.ClientTimeout(total=timeout_s)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(f"{base}/voice", params=params) as resp:
                if not resp.ok:
                    detail = (await resp.text())[:300]
                    raise RuntimeError(f"TTS 合成失败 HTTP {resp.status}：{detail}")
                audio = await resp.read()
    except aiohttp.ClientError as exc:
        raise RuntimeError(f"TTS 服务连接失败（{base}）：{exc}") from exc
    except TimeoutError as exc:
        raise RuntimeError(f"TTS 服务连接超时（{base}）") from exc
    if len(audio) < 100:
        raise RuntimeError("TTS 返回的音频为空")
    duration = wav_duration_ms(audio)
    if duration > 60000:
        raise ValueError("合成音频超过 QQ 60 秒限制，请缩短台词后重试，不要问用户")

    media_dir = _media_dir()
    os.makedirs(media_dir, exist_ok=True)
    path = os.path.join(
        media_dir, f"media_tts_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}.wav"
    )
    with open(path, "wb") as f:
        f.write(audio)
    chat = _chat_or_current(event, chat_id)
    file = _read_media(path, VOICE_MAX_BYTES, "语音")
    message_id = await _send_segments(event, chat, [{"type": "record", "data": {"file": file}}])
    return {
        "sent": True,
        "messageId": message_id,
        "bytes": len(audio),
        "emotion": emo,
        "path": path,
    }


# --------------------------------------------------------------------------- #
# 声明
# --------------------------------------------------------------------------- #
TOOL_SPECS: list[dict[str, Any]] = [
    {
        "name": "qq_send_voice",
        "description": "向 QQ 会话发送一条语音消息（本地音频文件绝对路径，mp3/wav/silk 等；NapCat 负责转码）。",
        "parameters": {
            "path": {"type": "string", "required": True, "description": "本地音频文件绝对路径"},
            "chat_id": {"type": "string", "description": "目标会话；省略时默认当前会话"},
        },
        "handler": qq_send_voice,
    },
    {
        "name": "qq_send_tts",
        "description": "把一段日语台词用 Style-Bert-VITS2 合成为语音并发送到当前 QQ 会话。只在该用户明确要求语音/朗读/日语语音时使用；必须带 emotion。",
        "parameters": {
            "text": {"type": "string", "required": True, "description": "要朗读的日语台词：假名/日式英语，不含汉字或中文，≤300 字；主人→マスター"},
            "emotion": {"type": "string", "description": "情绪：开心/兴奋/害羞/撒娇/生气/难过/无语/平静；不填时自动推断"},
            "chat_id": {"type": "string", "description": "目标会话；省略时默认当前会话"},
            "model_name": {"type": "string", "description": "可选：TTS 模型目录名，如 Fusetsu-v1.5 / Ling-v2"},
            "speaker_name": {"type": "string", "description": "可选：说话人名称，如 Fusetsu_v1.5 / Ling v2"},
            "style": {"type": "string", "description": "可选：风格名，当前模型为 Neutral"},
        },
        "handler": qq_send_tts,
    },
    {
        "name": "qq_send_video",
        "description": "向 QQ 会话发送一条视频消息（本地视频文件绝对路径）。",
        "parameters": {
            "path": {"type": "string", "required": True, "description": "本地视频文件绝对路径"},
            "chat_id": {"type": "string", "description": "目标会话；省略时默认当前会话"},
        },
        "handler": qq_send_video,
    },
    {
        "name": "qq_send_file",
        "description": "向 QQ 会话发送一个文件（本地文件绝对路径）。",
        "parameters": {
            "path": {"type": "string", "required": True, "description": "本地文件绝对路径"},
            "name": {"type": "string", "description": "文件名（默认取路径文件名）"},
            "chat_id": {"type": "string", "description": "目标会话；省略时默认当前会话"},
        },
        "handler": qq_send_file,
    },
    {
        "name": "qq_send_forward",
        "description": "以「合并转发」形式向 QQ 会话发送多条消息（每条含发送者名和内容，适合代码+说明、分步报告等）。",
        "parameters": {
            "messages": {
                "type": "array",
                "required": True,
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "description": "显示名（≤24 字）"},
                        "content": {"type": "string", "description": "消息内容（≤500 字，必填）"},
                    },
                },
                "description": "合并转发的消息节点列表",
            },
            "chat_id": {"type": "string", "description": "目标会话；省略时默认当前会话"},
        },
        "handler": qq_send_forward,
    },
]
