"""入站折叠内容展开：把模型看不见的两类消息摊成可读文本。

2026-11-15 断点（真实样本见 audit/inbound.jsonl 行 283 / astrbot.log 18:32）：
- 合并转发（聊天记录）在 OneBot 里是 `{"type": "forward", "data": {"id": ...}}`，
  插件原来只渲染「[合并转发]」，id 也没往下传，模型只能拿空参数调 get_forward_msg；
- 视频消息是 `{"type": "video", "data": {"file": ..., "url": ...}}`，
  适配器构造 Video 组件时 pydantic 会把 url 丢掉，插件只渲染「[视频]」。

这里做三件事，都在判定/合批之前完成：
1. forward → 调 get_forward_msg 把每个节点渲染成「谁: 说了什么」，带条数上限；
2. video → 把源文件落到 media 白名单目录，ffprobe 出时长/分辨率/有无音轨，
   输出 `[视频 0:12 720x1280 有声音 3.4MB] [视频:<本地路径>]`，交给现有 qq_read_video；
3. B 站卡片 → 补全真实标题/UP/时长（原来只有「[转发的B站视频]」+ b23 短链）。
"""

from __future__ import annotations

import asyncio
import os
import time
import uuid
from pathlib import Path
from typing import Any

try:
    from . import faces
    from . import image_prep
    from . import media_bili as mb
    from . import media_video as mv
    from .media_platform import log
except ImportError:  # AstrBot 以模块方式加载时走这里
    import faces  # type: ignore
    import image_prep  # type: ignore
    import media_bili as mb  # type: ignore
    import media_video as mv  # type: ignore
    from media_platform import log  # type: ignore

# <inst>/data/plugins/xzy/inbound_expand.py -> <inst>/data
_DATA_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
VIDEO_DIR = Path(_DATA_ROOT) / "xzy" / "media" / "inbound-video"

FORWARD_TIMEOUT = 8.0
FORWARD_MAX_NODES = 30
FORWARD_NODE_CHARS = 100
FORWARD_MAX_CHARS = 1300
FORWARD_MAX_IMAGES = 3

VIDEO_TIMEOUT = 25.0
VIDEO_MAX_BYTES = 80 * 1024 * 1024
VIDEO_KEEP_DAYS = 3
VIDEO_KEEP_FILES = 60

BILI_TIMEOUT = 6.0
BILI_CACHE_TTL = 600.0

_BILI_CACHE: dict[str, tuple[float, dict[str, Any] | None]] = {}

_SEG_LABEL = {
    "image": "[图片]",
    "mface": "[表情]",
    "record": "[语音]",
    "video": "[视频]",
    "file": "[文件]",
    "json": "[卡片]",
    "xml": "[卡片]",
    "forward": "[聊天记录]",
    "reply": "[引用]",
}


def collect_forward_ids(event: Any) -> list[str]:
    """从原始 message 数组里取 forward 段 id；组件层没有这个字段的兜底来源。"""
    ids: list[str] = []
    for seg in _raw_segments(event):
        if str(seg.get("type") or "") != "forward":
            continue
        data = seg.get("data") if isinstance(seg.get("data"), dict) else {}
        fid = str(data.get("id") or "").strip()
        if fid and fid not in ids:
            ids.append(fid)
    return ids


def collect_video_segments(event: Any) -> list[dict[str, str]]:
    """从原始 message 数组里取 video 段（组件会把 url 丢掉，只能读原始报文）。"""
    out: list[dict[str, str]] = []
    for seg in _raw_segments(event):
        if str(seg.get("type") or "") != "video":
            continue
        data = seg.get("data") if isinstance(seg.get("data"), dict) else {}
        out.append(
            {
                "url": str(data.get("url") or data.get("path") or ""),
                "file": str(data.get("file") or ""),
                "thumb": str(data.get("thumb") or ""),
            }
        )
    return out


def _raw_segments(event: Any) -> list[dict[str, Any]]:
    raw = getattr(getattr(event, "message_obj", None), "raw_message", None)
    if not isinstance(raw, dict):
        return []
    message = raw.get("message")
    if not isinstance(message, list):
        return []
    return [seg for seg in message if isinstance(seg, dict)]


async def expand(event: Any, entry: dict[str, Any]) -> None:
    """就地改写 entry["text"]；任何一步失败都只留占位符，不抛到调用方。"""
    if entry.get("forward_ids"):
        await _expand_forwards(event, entry)
    if entry.get("video_segs"):
        await _expand_videos(entry)
    if entry.get("bili_cards"):
        await _enrich_bili_cards(entry)


# --------------------------------------------------------------------------- #
# 合并转发
# --------------------------------------------------------------------------- #
async def _expand_forwards(event: Any, entry: dict[str, Any]) -> None:
    text = str(entry.get("text") or "")
    images: list[str] = list(entry.get("forward_images") or [])
    for fid in entry.get("forward_ids") or []:
        block, node_images = await _forward_block(event, fid)
        images.extend(node_images)
        if "[合并转发]" in text:
            text = text.replace("[合并转发]", block, 1)
        else:
            text = f"{text} {block}".strip()
    entry["text"] = text.strip()
    if images:
        entry["forward_images"] = images


async def _forward_block(event: Any, fid: str) -> tuple[str, list[str]]:
    """返回 (给模型的文本, 需要作为图片一起送模型的本地缓存路径)。"""
    nodes = await _fetch_forward(event, fid)
    if nodes is None:
        return "[聊天记录 取不到内容]", []
    if not nodes:
        return "[聊天记录 空]", []
    images: list[str] = []
    image_refs: list[str] = []
    total = len(nodes)
    pieces: list[str] = []
    used = 0
    for node in nodes:
        if len(pieces) >= FORWARD_MAX_NODES:
            break
        body, refs = _node_content(node)
        if len(image_refs) < FORWARD_MAX_IMAGES:
            for ref in refs:
                if len(image_refs) >= FORWARD_MAX_IMAGES:
                    break
                if ref and ref not in image_refs:
                    image_refs.append(ref)
        body = body or "[空]"
        if len(body) > FORWARD_NODE_CHARS:
            body = body[:FORWARD_NODE_CHARS].rstrip() + "…"
        who = _node_sender(node)
        piece = f"{who}: {body}" if who else body
        if used + len(piece) + 1 > FORWARD_MAX_CHARS:
            break
        pieces.append(piece)
        used += len(piece) + 1
    head = (
        f"[聊天记录 {len(pieces)}/{total} 条]"
        if pieces and len(pieces) < total
        else f"[聊天记录 {total} 条]"
    )
    text = head if not pieces else head + " " + "｜".join(pieces)
    for ref in image_refs:
        try:
            path = await image_prep.shrink_one(ref)
        except Exception as exc:  # noqa: BLE001
            log("warn", f"聊天记录内图片取回失败：{type(exc).__name__}: {exc}")
            path = None
        if path:
            images.append(path)
    return text, images


async def _fetch_forward(event: Any, fid: str) -> list[dict[str, Any]] | None:
    bot = getattr(event, "bot", None)
    if bot is None or not hasattr(bot, "call_action"):
        log("warn", f"get_forward_msg 不可用：当前平台没有 event.bot id={fid}")
        return None
    try:
        ret = await asyncio.wait_for(
            bot.call_action("get_forward_msg", id=fid), timeout=FORWARD_TIMEOUT
        )
    except Exception as exc:  # noqa: BLE001
        log("warn", f"get_forward_msg 失败 id={fid}: {type(exc).__name__}: {exc}")
        return None
    if isinstance(ret, list):
        nodes = ret
    elif isinstance(ret, dict):
        payload = ret.get("data") if isinstance(ret.get("data"), dict) else ret
        nodes = payload.get("messages") or payload.get("message") or []
    else:
        return None
    if not isinstance(nodes, list):
        return None
    return [node for node in nodes if isinstance(node, dict)]


def _node_sender(node: dict[str, Any]) -> str:
    sender = node.get("sender") if isinstance(node.get("sender"), dict) else {}
    name = sender.get("card") or sender.get("nickname") or node.get("nickname") or ""
    if name:
        return str(name)
    uid = sender.get("user_id") or node.get("user_id") or ""
    return f"QQ{uid}" if uid else ""


def _node_content(node: dict[str, Any]) -> tuple[str, list[str]]:
    """返回 (节点文字, 节点内图片源地址)。"""
    message = node.get("message")
    if isinstance(message, str):
        return message.strip(), []
    if not isinstance(message, list):
        content = node.get("content")
        return (str(content).strip() if content else ""), []
    parts: list[str] = []
    refs: list[str] = []
    for seg in message:
        if not isinstance(seg, dict):
            continue
        seg_type = str(seg.get("type") or "")
        data = seg.get("data") if isinstance(seg.get("data"), dict) else {}
        if seg_type == "text":
            parts.append(str(data.get("text") or ""))
        elif seg_type == "at":
            qq = str(data.get("qq") or "")
            parts.append("@全体成员" if qq == "all" else f"@{qq}")
        elif seg_type in ("image", "mface"):
            parts.append("[图片]")
            ref = str(data.get("url") or data.get("file") or "")
            if ref:
                refs.append(ref)
        elif seg_type == "face":
            parts.append(faces.label(data.get("id")))
        else:
            parts.append(_SEG_LABEL.get(seg_type, f"[{seg_type}]"))
    return "".join(parts).strip(), refs


# --------------------------------------------------------------------------- #
# 视频
# --------------------------------------------------------------------------- #
async def _expand_videos(entry: dict[str, Any]) -> None:
    text = str(entry.get("text") or "")
    for seg in entry.get("video_segs") or []:
        label = await _video_label(seg, str(entry.get("message_id") or ""))
        if "[视频]" in text:
            text = text.replace("[视频]", label, 1)
        else:
            text = f"{text} {label}".strip()
    entry["text"] = text.strip()


async def _video_label(seg: dict[str, str], message_id: str) -> str:
    url = str(seg.get("url") or "").strip()
    if not url:
        return "[视频 源地址缺失，取不回来]"
    path = await _download_video(url, message_id)
    if not path:
        return "[视频 取回失败：源文件下载超时或过大]"
    try:
        info = await asyncio.wait_for(mv.probe(path), timeout=20)
    except Exception as exc:  # noqa: BLE001
        log("warn", f"入站视频元数据读取失败 path={path}: {type(exc).__name__}: {exc}")
        return f"[视频: {path}]"
    size_mb = 0.0
    try:
        size_mb = os.path.getsize(path) / 1048576.0
    except OSError:
        pass
    size_text = f"{size_mb:.1f}MB" if size_mb >= 0.1 else f"{max(1, round(size_mb * 1024))}KB"
    return (
        f"[视频 {mv.format_clock(info.get('duration'))} "
        f"{info.get('width') or '?'}x{info.get('height') or '?'} "
        + ("有声音" if info.get("hasAudio") else "无音轨")
        + f" {size_text}] [视频:{path}]"
    )


async def _download_video(url: str, message_id: str) -> str:
    VIDEO_DIR.mkdir(parents=True, exist_ok=True)
    _prune_videos()
    name = f"{message_id or 'msg'}-{uuid.uuid4().hex[:8]}.mp4"
    dest = VIDEO_DIR / name
    try:
        import aiohttp

        timeout = aiohttp.ClientTimeout(total=VIDEO_TIMEOUT)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, allow_redirects=True) as resp:
                if resp.status != 200:
                    log("warn", f"入站视频下载 HTTP {resp.status}")
                    return ""
                declared = int(resp.headers.get("Content-Length") or 0)
                if declared > VIDEO_MAX_BYTES:
                    log("warn", f"入站视频过大 {declared} bytes，跳过")
                    return ""
                size = 0
                with open(dest, "wb") as fh:
                    async for chunk in resp.content.iter_chunked(256 * 1024):
                        size += len(chunk)
                        if size > VIDEO_MAX_BYTES:
                            log("warn", f"入站视频超过 {VIDEO_MAX_BYTES} bytes，丢弃")
                            fh.close()
                            dest.unlink(missing_ok=True)
                            return ""
                        fh.write(chunk)
        return str(dest)
    except Exception as exc:  # noqa: BLE001
        log("warn", f"入站视频下载失败：{type(exc).__name__}: {exc}")
        try:
            dest.unlink(missing_ok=True)
        except OSError:
            pass
        return ""


def _prune_videos() -> None:
    """落盘目录自清理：超过 3 天或超过 60 个就删最旧的。"""
    try:
        files = sorted(VIDEO_DIR.glob("*.mp4"), key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError:
        return
    cutoff = time.time() - VIDEO_KEEP_DAYS * 86400
    for idx, item in enumerate(files):
        try:
            if idx >= VIDEO_KEEP_FILES or item.stat().st_mtime < cutoff:
                item.unlink(missing_ok=True)
        except OSError:
            continue


# --------------------------------------------------------------------------- #
# B 站卡片补全
# --------------------------------------------------------------------------- #
async def _enrich_bili_cards(entry: dict[str, Any]) -> None:
    text = str(entry.get("text") or "")
    for card in entry.get("bili_cards") or []:
        label = str(card.get("label") or "")
        if not label:
            continue
        info = await _bili_info(str(card.get("url") or ""))
        if not info:
            continue
        head = f"[转发的B站视频]《{info.get('title') or card.get('title') or ''}》"
        if info.get("owner"):
            head += f" {info['owner']}"
        if info.get("duration"):
            head += f" · {mv.format_clock(info['duration'])}"
        text = text.replace(label, f"{head} {card.get('url') or ''}")
    entry["text"] = text.strip()


async def _bili_info(url: str) -> dict[str, Any] | None:
    if not url:
        return None
    now = time.monotonic()
    cached = _BILI_CACHE.get(url)
    if cached and now - cached[0] < BILI_CACHE_TTL:
        return cached[1]
    try:
        bvid = await asyncio.wait_for(mb.resolve_ref(url), timeout=BILI_TIMEOUT)
        info = await asyncio.wait_for(mb.video_info(bvid), timeout=BILI_TIMEOUT)
    except Exception as exc:  # noqa: BLE001
        log("warn", f"B站卡片补全失败 url={url}: {type(exc).__name__}: {exc}")
        _BILI_CACHE[url] = (now, None)
        return None
    _BILI_CACHE[url] = (now, info)
    return info
