"""生成与分析批次：出图、B 站选片/看片、本地视频取证、要图、图片队列审核。

共享层（tool_result / tool_schema / tool_send / main.py）只读引用；本文件与
media_platform.py / media_draw.py / media_bili.py / media_video.py 属于
batch3 自己的模块，其他 worker 不要改这几个文件。

四态口径：
- 显卡/ComfyUI/审图队列被占用 → blocked(busy)，不是失败；
- 真正生成失败、审图没连上 → failed(upstream-error)，并已落账本；
- 审图两次没过 → failed(policy-rejected)，图已丢弃。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

try:
    from . import image_prep
    from . import media_bili as mb
    from . import media_draw as md
    from . import media_fence
    from . import media_platform as mp
    from . import media_video as mv
    from . import night_quiet
    from . import tool_result as tr
    from .tool_send import (
        current_chat as _current_chat,
        image_seg_from_file as _image_seg,
        resolve_chat as _resolve_chat,
        send_segments as _send_segments,
        text_seg as _text_seg,
    )
except ImportError:  # AstrBot 以扁平模块方式加载时走这里
    import image_prep  # type: ignore
    import media_bili as mb  # type: ignore
    import media_draw as md  # type: ignore
    import media_fence  # type: ignore
    import media_platform as mp  # type: ignore
    import media_video as mv  # type: ignore
    import night_quiet  # type: ignore
    import tool_result as tr  # type: ignore
    from tool_send import current_chat as _current_chat  # type: ignore
    from tool_send import image_seg_from_file as _image_seg  # type: ignore
    from tool_send import resolve_chat as _resolve_chat  # type: ignore
    from tool_send import send_segments as _send_segments  # type: ignore
    from tool_send import text_seg as _text_seg  # type: ignore

CFG: dict[str, Any] = {}
VIDEO_EXTS = {".mp4", ".mkv", ".mov", ".avi", ".webm", ".flv", ".wmv", ".m4v", ".ts"}
VIDEO_MAX_SECONDS = 2 * 3600
VIDEO_FRAME_ROOT = mp.MEDIA_DIR / "video-frames"
# 群内视频阅读的结构化留痕：面板直接读，不再靠 media-tools.log 的散文行
VIDEO_AUDIT = Path(__file__).resolve().parents[2] / "xzy" / "audit" / "media_video.jsonl"


def _video_ids(event: Any) -> tuple[str, str]:
    try:
        return str(event.get_group_id() or ""), str(event.get_sender_id() or "")
    except Exception:  # noqa: BLE001
        return "", ""


def _video_audit(record: dict[str, Any]) -> None:
    try:
        VIDEO_AUDIT.parent.mkdir(parents=True, exist_ok=True)
        with open(VIDEO_AUDIT, "a", encoding="utf-8") as fh:
            fh.write(
                json.dumps({"wall": time.strftime("%Y-%m-%dT%H:%M:%S"), **record}, ensure_ascii=False)
                + "\n"
            )
    except OSError:
        pass
ASK_IMAGE_COOLDOWN_S = 6 * 3600
# 等图标记的有效期：超过这个时间没人回图就算超时，入站侧顺手清掉
ASK_IMAGE_TTL_S = 10 * 60
DRAW_READY_TEXTS = ("在画了，等我一下。", "这就画，别催。", "收到，正在生成。")
DRAW_FAIL_TEXT = "没画出来，等我修好再给你画。"


def _friendly_draw_error(message: str) -> str:
    text = message or ""
    if "超时" in text:
        return "生成超时"
    if "ComfyUI 没起来" in text or "找不到 engine-control" in text:
        return "出图服务没起来"
    if "拒绝了工作流" in text:
        return "出图服务拒绝了这张图"
    if "生成失败" in text:
        return "生成过程中崩了"
    if "显存" in text:
        return "显存不够用"
    return "出图链路出错了"


def configure(cfg: dict[str, Any]) -> None:
    CFG.clear()
    CFG.update(cfg)
    mv.configure(cfg)
    mb.configure(cfg)


def _chat_or_current(event: Any, chat_id: str) -> tuple[str, str]:
    chat = _resolve_chat(event, chat_id)
    if chat is None:
        raise ValueError("chat_id 格式应为 group:<群号> 或 private:<QQ号>")
    return chat


def _chat_key(chat: tuple[str, str]) -> str:
    return f"{chat[0]}:{chat[1]}"


def _master_qq() -> str:
    return str(CFG.get("master_qq") or "10000")


def _prune_frames(root: Path, max_age_s: int = 2 * 24 * 3600) -> None:
    try:
        deadline = time.time() - max_age_s
        for entry in root.iterdir():
            try:
                if entry.is_dir() and entry.stat().st_mtime < deadline:
                    shutil.rmtree(entry, ignore_errors=True)
            except OSError:
                continue
    except OSError:
        pass


def _clip(text: str, limit: int = 8000) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    third = limit // 3
    middle = len(text) // 2
    return text[:third] + "\n……\n" + text[middle - third // 2 : middle + third // 2] + "\n……\n" + text[-third:]


async def _notice(event: Any, chat: tuple[str, str], text: str) -> None:
    try:
        await _send_segments(event, chat, [_text_seg(text)])
    except Exception as exc:
        mp.log("warn", f"提示消息发送失败：{exc}")


# --------------------------------------------------------------------------- #
# 出图
# --------------------------------------------------------------------------- #
async def qq_draw(
    event: Any = None,
    prompt: str = "",
    negative: str = "",
    aspect: str = "1:1",
    megapixels: float = 1.0,
    detail: float = 0.2,
    quality: float = 0.25,
    light: float = 0.5,
    seed: int = 0,
    style: str = "动漫写实",
    chat_id: str = "",
    **_: Any,
) -> dict[str, Any]:
    if event is None:
        raise RuntimeError("缺少事件上下文")
    prompt = (prompt or "").strip()
    if prompt == "":
        raise ValueError("参数 prompt 必填（要画什么）")
    if len(prompt) > 1200:
        raise ValueError("画面描述太长（最多 1200 字符）")
    chat = _chat_or_current(event, chat_id)
    chat_key = _chat_key(chat)
    options = {
        "aspect": aspect if aspect in md.ASPECT_RATIOS else "1:1",
        "megapixels": megapixels,
        "detail": detail,
        "quality": quality,
        "light": light,
        "seed": seed,
        "style": style if style in md.STYLES or style == "无" else "动漫写实",
        "negative": negative,
    }
    def on_ready() -> None:
        texts = CFG.get("draw_ready_texts")
        choices = [str(item) for item in texts] if isinstance(texts, list) and texts else list(DRAW_READY_TEXTS)
        lead = choices[int(time.time() * 1000) % len(choices)]
        asyncio.create_task(_notice(event, chat, lead))

    def on_image(result: dict[str, Any]) -> None:
        md.record_draw(
            {
                "status": "generated",
                "path": result.get("path"),
                "chatId": chat_key,
                "prompt": prompt,
                "width": result.get("width"),
                "height": result.get("height"),
            }
        )

    mp.log(
        "info",
        f"qq_draw start chat={chat_key} aspect={options['aspect']} style={options['style']} chars={len(prompt)}",
    )
    try:
        flow = await md.draw_with_review(prompt, options, on_ready=on_ready, on_image=on_image)
    except md.DrawBusy as exc:
        mp.log("info", f"qq_draw busy: {exc}")
        return tr.result_blocked("busy", str(exc), data={"chatId": chat_key})
    except md.DrawFailed as exc:
        message = str(exc) or "未知错误"
        mp.log("warn", f"qq_draw failed: {message}")
        friendly = _friendly_draw_error(message)
        await _notice(event, chat, f"没画出来（{friendly}），等我修好再给你画。")
        return tr.result_fail(
            "upstream-error",
            "没画出来：" + friendly,
            "已经替你把失败告诉对方了，本轮不要再解释排错细节，也不要把技术原因说给对方。",
            failed=True,
            sent=False,
        )

    if not flow.get("pass"):
        review = flow.get("review") or {}
        if flow.get("reviewFailed"):
            stored = str((flow.get("result") or {}).get("path") or review.get("path") or "")
            # 必须真正进待审队列，否则 qq_image_review 永远是「待审 0 张」，
            # 而这里已经对用户说了「我先存着，确认没问题再发」。
            item = md.add_pending(
                {
                    "chatId": chat_key,
                    "requester": str(event.get_sender_name() or ""),
                    "requesterQq": str(event.get_sender_id() or ""),
                    "prompt": prompt,
                    "path": stored,
                    "width": (flow.get("result") or {}).get("width"),
                    "height": (flow.get("result") or {}).get("height"),
                    "style": options.get("style"),
                }
            )
            md.record_draw(
                {
                    "status": "queued",
                    "queueId": item.get("id"),
                    "path": stored,
                    "chatId": chat_key,
                    "prompt": prompt,
                    "reviewStatus": "failed",
                    "reviewError": str(review.get("reason") or ""),
                }
            )
            await _notice(event, chat, "画好了，我先存着，确认没问题再发。")
            return tr.result_fail(
                "upstream-error",
                f"图画好了，但审图这会儿没连上，我先存着（待审 #{item.get('id')}）",
                "图已进待审队列，本轮不要调用发送工具，也不要描述报错细节；跟着回一句很短的话即可。",
                queued=True,
                reviewFailed=True,
                attempts=flow.get("attempts"),
                queueId=item.get("id"),
                path=stored,
            )
        defects = [str(item) for item in (review.get("defects") or [])]
        md.record_draw({"status": "discarded", "chatId": chat_key, "prompt": prompt, "defects": defects})
        await _notice(event, chat, "这张没画好，我就不发了。")
        return tr.result_fail(
            "policy-rejected",
            "这张没画好，我没发",
            "图已丢弃，本轮不要调用发送工具，也不要描述审图过程或缺陷清单。",
            discarded=True,
            attempts=flow.get("attempts"),
            score=review.get("score"),
            defects=defects,
        )

    result = flow.get("result") or {}
    path = str(result.get("path") or "")
    if not path or not os.path.isfile(path):
        return tr.result_fail("internal", "生成的图片文件不见了", "不要重试出图，直接如实说图没保存下来。")
    try:
        message_id = await _send_segments(event, chat, [_image_seg(path)])
    except Exception as exc:
        mp.log("warn", f"qq_draw 图片发送失败：{exc}")
        return tr.result_fail("unlanded", f"图画好了但没发出去：{exc}", "不要当成已发送，也不要原样重试。")
    md.record_draw(
        {
            "status": "sent",
            "path": path,
            "chatId": chat_key,
            "prompt": prompt,
            "reviewStatus": (flow.get("review") or {}).get("verdict"),
        }
    )
    mp.log(
        "info",
        f"qq_draw sent chat={chat_key} messageId={message_id} seed={result.get('seed')} seconds={result.get('seconds')}",
    )
    return tr.result_ok(
        "已按描述画好并发到当前会话",
        code="sent",
        messageId=message_id,
        data={
            "path": path,
            "width": result.get("width"),
            "height": result.get("height"),
            "seed": result.get("seed"),
            "style": result.get("style"),
            "seconds": result.get("seconds"),
            "review": (flow.get("review") or {}).get("verdict"),
        },
    )


# --------------------------------------------------------------------------- #
# 图片队列审核（仅主人私聊）
# --------------------------------------------------------------------------- #
async def qq_image_review(
    event: Any = None, action: str = "list", id: float = 0, **_: Any
) -> dict[str, Any]:
    if event is None:
        raise RuntimeError("缺少事件上下文")
    chat = _current_chat(event)
    if chat != ("private", _master_qq()):
        return tr.result_blocked("forbidden", "只有主人私聊里能审核图片")
    act = action if action in ("approve", "reject", "resend") else "list"
    if act == "list":
        items = [
            {
                "id": item.get("id"),
                "chatId": item.get("chatId"),
                "requester": item.get("requester"),
                "prompt": str(item.get("prompt") or "")[:80],
                "createdAt": item.get("createdAt"),
            }
            for item in md.list_pending()
        ]
        data: dict[str, Any] = {"action": "list", "items": items}
        unsent = md.read_unsent_draw()
        if unsent:
            # 画完但没发出去（发送前崩溃/重载）：补偿入口在这里，否则这张图就丢了
            data["unsent"] = {
                "id": 0,
                "chatId": unsent.get("chatId"),
                "prompt": str(unsent.get("prompt") or "")[:80],
                "updatedAt": unsent.get("updatedAt"),
            }
        note = f"待审 {len(items)} 张" + ("；另有 1 张画完没发出的图（action=resend 补发）" if unsent else "")
        return tr.result_ok(note, data=data)
    if act == "resend":
        record = md.read_unsent_draw()
        if record is None:
            return tr.result_done("no-result", "近 30 分钟内没有未发出的图")
        target = _resolve_chat(event, str(record.get("chatId") or ""))
        if target is None:
            return tr.result_fail("bad-args", "这条记录的会话格式不对", "记录仍保留，先检查 chatId，不要重试。")
        path = str(record.get("path") or "")
        if not path or not os.path.isfile(path):
            return tr.result_fail("bad-args", "原图文件已经不在了", "不要重试补发。")
        try:
            message_id = await _send_segments(event, target, [_image_seg(path)])
        except Exception as exc:
            mp.log("warn", f"补发未发出的图失败：{exc}")
            return tr.result_fail("unlanded", "图没发出去", "记录仍保留，本轮不要重复补发。")
        md.record_draw({"status": "sent", "path": path, "chatId": record.get("chatId")})
        return tr.result_ok(
            f"已补发到 {record.get('chatId')}",
            code="sent",
            messageId=message_id,
            data={"action": "resend", "chatId": record.get("chatId")},
        )
    try:
        item_id = int(id)
    except (TypeError, ValueError):
        item_id = 0
    if item_id <= 0:
        raise ValueError("需要 id（list 返回的编号）")
    item = md.get_pending(item_id)
    if item is None or item.get("status") != "pending":
        return tr.result_done("no-result", f"没有待审图 #{item_id}")
    if act == "reject":
        md.resolve_pending(item_id, "rejected")
        md.discard_image(str(item.get("path") or ""))
        return tr.result_ok(f"已拒绝并删除 #{item_id}", data={"action": "reject", "id": item_id})
    target = _resolve_chat(event, str(item.get("chatId") or ""))
    if target is None:
        return tr.result_fail("bad-args", "这条队列记录的会话格式不对，发不回去", "队列项仍保留，先让主人检查 chatId。")
    try:
        message_id = await _send_segments(event, target, [_image_seg(str(item.get("path") or ""))])
    except Exception as exc:
        mp.log("warn", f"图片队列发送失败：{exc}")
        return tr.result_fail("unlanded", "图没发出去", "队列项仍保留，本轮不要重复审批。")
    md.resolve_pending(item_id, "approved")
    return tr.result_ok(
        f"已把 #{item_id} 发回 {item.get('chatId')}",
        code="sent",
        messageId=message_id,
        data={"action": "approve", "id": item_id, "chatId": item.get("chatId")},
    )


# --------------------------------------------------------------------------- #
# 要图
# --------------------------------------------------------------------------- #
def _ask_state_path() -> Path:
    return mp.STATE_DIR / "ask-image.json"


def _read_ask_state() -> dict[str, Any]:
    value = mp.read_json(_ask_state_path(), {})
    return value if isinstance(value, dict) else {}


def peek_pending_image_request(chat_key: str, requester: str = "") -> dict[str, Any] | None:
    """只读检查：pending 是否有效、是否同一个请求者；超时的顺手清掉。"""
    state = _read_ask_state()
    entry = state.get(chat_key)
    if not isinstance(entry, dict) or entry.get("pending") is False:
        return None
    try:
        age = time.time() - float(entry.get("at") or 0)
    except (TypeError, ValueError):
        age = ASK_IMAGE_TTL_S + 1
    if age > ASK_IMAGE_TTL_S:
        entry["pending"] = False
        state[chat_key] = entry
        try:
            mp.write_json_atomic(_ask_state_path(), state)
        except OSError:
            pass
        mp.log("info", f"等图超时清除 chat={chat_key} age={int(age)}s")
        return None
    owner = str(entry.get("requester") or "")
    if requester and owner and owner != requester:
        return None
    return entry


def take_pending_image_request(chat_key: str, requester: str = "") -> dict[str, Any] | None:
    """供入站侧消费：取到并清掉“正在等图”标记（保留冷却时间戳）。"""
    if peek_pending_image_request(chat_key, requester) is None:
        return None
    state = _read_ask_state()
    entry = state.get(chat_key)
    if not isinstance(entry, dict) or entry.get("pending") is False:
        return None
    entry["pending"] = False
    state[chat_key] = entry
    try:
        mp.write_json_atomic(_ask_state_path(), state)
    except OSError:
        pass
    return entry


async def qq_ask_image(
    event: Any = None, chat_id: str = "", reason: str = "", purpose: str = "chat", **_: Any
) -> dict[str, Any]:
    if event is None:
        raise RuntimeError("缺少事件上下文")
    target = _chat_or_current(event, chat_id)
    key = _chat_key(target)
    clean = re.sub(r"\s+", " ", (reason or "").strip()).rstrip("。！？!?")
    if clean == "":
        clean = "有没有好玩/好看的图"
    kind = purpose if purpose in ("qzone", "sticker", "chat") else "chat"
    state = _read_ask_state()
    entry = state.get(key)
    if isinstance(entry, dict):
        try:
            age = time.time() - float(entry.get("at") or 0)
        except (TypeError, ValueError):
            age = ASK_IMAGE_COOLDOWN_S + 1
        if age < ASK_IMAGE_COOLDOWN_S:
            minutes = int((ASK_IMAGE_COOLDOWN_S - age + 59) // 60)
            return tr.result_blocked("cooldown", f"刚在这个会话要过图，还要等 {minutes} 分钟")
    what = "想拿一张来配今天的动态" if kind == "qzone" else "想看看"
    suffix = "" if kind == "qzone" and re.search(r"动态|配图", clean) else "，" + what
    if target[0] == "group":
        body = f"想问问大家，{clean}？方便发我一张吗{suffix}，不方便也没关系。"
    else:
        body = f"想跟你要张图：{clean}。方便发我一张吗{suffix}，不方便也没关系。"
    try:
        message_id = await _send_segments(event, target, [_text_seg(body)])
    except Exception as exc:
        return tr.result_fail("unlanded", f"要图消息没发出去：{exc}", "不要当成已经问过，也不要原样重试。")
    state[key] = {
        "at": time.time(),
        "reason": clean,
        "purpose": kind,
        "chatId": key,
        "pending": True,
        "requester": str(event.get_sender_id() or ""),
    }
    try:
        mp.write_json_atomic(_ask_state_path(), state)
    except OSError as exc:
        mp.log("warn", f"等图标记写入失败：{exc}")
    mp.log("info", f"qq_ask_image chat={key} purpose={kind} messageId={message_id}")
    return tr.result_ok(
        f"已在 {key} 发出要图请求，对方发图后会收到提示",
        code="sent",
        messageId=message_id,
        data={"chatId": key, "purpose": kind, "message": body, "awaitingImage": True},
    )


# --------------------------------------------------------------------------- #
# 本地视频取证
# --------------------------------------------------------------------------- #
async def _captions(frames: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # 取帧/描述规则统一在 mv.observe_captions（前段 2 + 中后段 2），这里只注入描述后端
    return await mv.observe_captions(frames, mp.describe_image)


async def qq_read_video(
    event: Any = None,
    path: str = "",
    mode: str = "overview",
    start: float = 0,
    end: float = 0,
    count: int = 0,
    audio: bool = True,
    observe: bool = True,
    **_: Any,
) -> dict[str, Any]:
    started = time.time()
    gid, uid = _video_ids(event)
    raw = (path or "").strip()
    use_mode = "range" if mode == "range" else "overview"
    base: dict[str, Any] = {
        "groupId": gid,
        "senderId": uid,
        "path": raw,
        "mode": use_mode,
        "requestedFrames": max(0, min(mv.max_count(), int(count or 0))),
    }
    try:
        if raw == "":
            raise ValueError("参数 path 必填（取自 [视频:路径]）")
        raw = media_fence.assert_allowed(raw)
        base["path"] = raw
        if not os.path.isfile(raw):
            raise ValueError(f"找不到视频文件：{raw}")
        ext = Path(raw).suffix.lower()
        if ext not in VIDEO_EXTS:
            raise ValueError(f"不支持的格式：{ext or '(无扩展名)'}")
        try:
            probe = await mv.probe(raw)
        except mv.VideoError as exc:
            raise ValueError(f"不支持或读不出这个视频文件（可能已损坏）：{exc}") from exc
        duration = float(probe.get("duration") or 0)
        if not duration > 0:
            raise ValueError("不支持这个视频文件（时长未知，无法抽帧）")
        if duration > VIDEO_MAX_SECONDS:
            raise ValueError(f"不支持超过两小时的视频（这条 {mv.format_clock(duration)}）")
        # 夜间静默：长视频只给 ffprobe 元数据，不抽帧/不转写/不做画面观察
        quiet = night_quiet.evaluate("video", duration_sec=duration)
        if quiet["action"] == "degrade":
            night_quiet.record(
                quiet,
                caller="qq_read_video",
                extra={"path": raw, "groupId": gid, "senderId": uid},
            )
            size_mb = round(os.path.getsize(raw) / 1024 / 1024, 1)
            lines = [
                f"视频 {mv.format_clock(duration)}，{probe.get('width') or '?'}x{probe.get('height') or '?'}"
                + ("，有声音" if probe.get("hasAudio") else "，无音轨")
                + f"，{size_mb}MB",
                f"夜间静默窗口 {night_quiet.window_label()} 内，超过 "
                f"{night_quiet.long_video_seconds() // 60} 分钟的视频只给 ffprobe 元数据："
                "没抽帧、没转写、没做画面观察。",
            ]
            mp.log("info", f"qq_read_video 夜间静默降级 {raw} duration={duration}")
            _video_audit(
                {
                    **base,
                    "ok": True,
                    "reason": "",
                    "durationSec": round(duration, 3),
                    "width": probe.get("width"),
                    "height": probe.get("height"),
                    "hasAudio": bool(probe.get("hasAudio")),
                    "fileSize": os.path.getsize(raw),
                    "frames": 0,
                    "captions": 0,
                    "transcriptChars": 0,
                    "summarySource": "ffprobe",
                    "nightQuiet": True,
                    "degraded": "metadata-only",
                    "elapsedMs": int((time.time() - started) * 1000),
                    "frameDir": "",
                }
            )
            return tr.result_ok(
                "\n".join(lines),
                next_="夜间静默窗口内不做长视频分析和转写；只按元数据简短说一句，别猜画面内容，也别假装看过。",
            )
        # 0 = 按 video.frameTiers 分档；>0 只作为更小的上限
        frame_count = max(0, min(mv.max_count(), int(count or 0)))
        left = max(0.0, float(start or 0)) if use_mode == "range" else 0.0
        right = float(end) if use_mode == "range" and float(end or 0) > left else duration
        right = min(duration, right)
        if not right > left:
            raise ValueError("区间为空（start/end 不合理）")

        _prune_frames(VIDEO_FRAME_ROOT)
        outdir = VIDEO_FRAME_ROOT / uuid.uuid4().hex[:8]
        outdir.mkdir(parents=True, exist_ok=True)
        frames_task = mv.collect_frames(
            raw,
            mode=use_mode,
            start=left,
            end=right,
            count=frame_count,
            outdir=str(outdir),
        )
        transcript_task = None
        if audio is not False and probe.get("hasAudio"):
            transcript_task = asyncio.create_task(mv.transcribe_video(raw, timeout=900.0))
        try:
            collected = await frames_task
        except mv.VideoError as exc:
            if transcript_task is not None:
                transcript_task.cancel()
            raise RuntimeError(str(exc)) from exc
        frames = [
            {"at": round(float(item["at"]), 1), "path": item["path"], "why": item["why"]}
            for item in collected.get("frames") or []
        ]
        transcript = ""
        if transcript_task is not None:
            try:
                transcript = await transcript_task
            except Exception as exc:
                mp.log("warn", f"视频转写失败：{exc}")
        captions = await _captions(frames) if observe else []
        caption_map = {str(item["path"]): str(item["caption"]) for item in captions}
        # 画面描述留一份到事件上：出站时用来判定「是不是把 caption 抄了一遍」
        try:
            event.set_extra(
                "xzy_video_captions",
                [str(item["caption"]) for item in captions if str(item.get("caption") or "").strip()],
            )
        except Exception:  # noqa: BLE001
            pass
        lines = [
            f"视频 {mv.format_clock(duration)}，{probe.get('width') or '?'}x{probe.get('height') or '?'}"
            + ("，有声音" if probe.get("hasAudio") else "，无音轨"),
        ]
        if not frames:
            lines.append("没抽到画面帧（可能只有音频流）。")
        else:
            lines.append(f"已抽 {len(frames)} 帧，按时间顺序：")
            for frame in frames:
                caption = caption_map.get(str(frame["path"]))
                suffix = f"｜{caption}" if caption else ""
                lines.append(f"{mv.format_clock(frame['at'])} [图片:{frame['path']}]{suffix}")
        if transcript:
            lines += ["", "声音转写（可能有错字，按大意理解）：", _clip(transcript)]
        elif not probe.get("hasAudio"):
            lines += ["", "这个视频没有音轨，内容只能看画面。"]
        mp.log("info", f"qq_read_video {raw} frames={len(frames)} captions={len(captions)} chars={len(transcript)}")
        sources = [name for name, hit in (("frames", frames), ("captions", captions), ("transcript", transcript)) if hit]
        _video_audit(
            {
                **base,
                "ok": True,
                "reason": "",
                "durationSec": round(duration, 3),
                "width": probe.get("width"),
                "height": probe.get("height"),
                "hasAudio": bool(probe.get("hasAudio")),
                "fileSize": os.path.getsize(raw),
                "frames": len(frames),
                "captions": len(captions),
                "observedAt": [item.get("at") for item in captions],
                "transcriptChars": len(transcript),
                "summarySource": "+".join(sources),
                "elapsedMs": int((time.time() - started) * 1000),
                "frameDir": str(outdir),
            }
        )
        return tr.result_ok(
            "\n".join(lines),
            next_="上面每帧后面的描述是素材摘录，不是你的话。回话第一句必须直接是你的判断"
            "（值不值得看、哪段出彩、哪段拉胯、什么感觉），禁止用「一个人/一个人物在……」这类画面描述句开头，"
            "禁止照抄任何一句素材描述；素材只用来说清你在评什么。"
            "值得留的判断用 qq_media_note 记一条（path 填 [视频:...] 或某一帧的 [图片:...]）。",
        )
    except Exception as exc:
        _video_audit(
            {
                **base,
                "ok": False,
                "reason": f"{type(exc).__name__}: {exc}",
                "elapsedMs": int((time.time() - started) * 1000),
            }
        )
        raise


# --------------------------------------------------------------------------- #
# 本地图片读取（模型看帧/看图的习惯调用）
# --------------------------------------------------------------------------- #
# 它历史上实际填过的键只有 path；其余是兼容别名，不写进 schema 也不影响调用。
IMAGE_REF_KEYS = ("path", "file", "file_path", "image", "image_path")
# 与 image_prep 的 inputMaxBytes 默认值保持一致：超过这个体积直接说读不了
IMAGE_SIZE_LIMIT = 12 * 1024 * 1024
READ_IMAGE_PROMPT = (
    "客观描述这张图：主体是什么、在做什么、场景与构图、图里出现的文字、明显的瑕疵或异常。"
    "只描述看得见的内容，不评价、不猜背景。"
)


def _image_local_path(raw: str) -> str:
    """把模型给的几种写法归一成本地路径；不做存在性/白名单判断。"""
    from urllib.parse import unquote, urlparse

    value = str(raw or "").strip().strip("\"'")
    if not value.lower().startswith("file://"):
        return os.path.expanduser(value)
    parsed = urlparse(value)
    local = unquote(parsed.path or "")
    if parsed.netloc and parsed.netloc not in ("", "localhost"):
        local = f"//{parsed.netloc}{local}"
    # file:///E:/x -> /E:/x -> E:/x
    if os.name == "nt" and len(local) >= 3 and local[0] == "/" and local[2] == ":":
        local = local[1:]
    return local


async def read_image(
    event: Any = None,
    path: str = "",
    question: str = "",
    prompt: str = "",
    **extra: Any,
) -> dict[str, Any]:
    """读本地图片 → 视觉接口出描述。任何一步失败都返回可读结果，绝不抛异常。"""
    ref = str(path or "").strip()
    used_key = "path"
    if not ref:
        for alias in IMAGE_REF_KEYS:
            value = extra.get(alias)
            if isinstance(value, str) and value.strip():
                ref, used_key = value.strip(), alias
                break
    raw = ref.strip().strip("\"'")
    if not raw:
        return tr.result_fail(
            "bad-args",
            "没给图片路径：参数 path 必填（也接受 file / file_path / image / image_path）",
            "从 [图片:...] 取路径再调；没有路径就别调这个工具。",
        )
    if re.match(r"^https?://", raw, re.I):
        return tr.result_fail(
            "bad-args",
            f"只读本地图片，不支持网址：{raw[:120]}",
            "要联网看图就先把图下载到白名单目录；否则用现有信息回话。",
        )

    local = _image_local_path(raw)
    if not os.path.exists(local):
        return tr.result_fail(
            "bad-args",
            f"文件不存在：{raw}",
            "别凭文件名猜画面；确认路径后再调，或直接用现有信息回话。",
        )
    if not os.path.isfile(local):
        return tr.result_fail("bad-args", f"这不是一个文件：{raw}", "换成具体的图片文件路径。")
    try:
        real = media_fence.assert_allowed(local)
    except media_fence.FenceError as exc:
        return tr.result_blocked(
            "forbidden",
            str(exc),
            "不要重试越界路径；需要看图就让对方把图发到会话里。",
            final=True,
        )

    try:
        size = os.path.getsize(real)
    except OSError as exc:
        return tr.result_fail("bad-args", f"读不到这个文件：{raw}（{exc}）", "别原样重试。")
    if size > IMAGE_SIZE_LIMIT:
        return tr.result_fail(
            "no-material",
            f"这张图太大（{size / 1024 / 1024:.1f}MB，上限 {IMAGE_SIZE_LIMIT // 1024 // 1024}MB），"
            "缩不下来，这次不读了",
            "不要原样重试；让对方发张小一点的，或按已知信息回话。",
            final=True,
        )

    shrunk = await image_prep.shrink_one(real)
    if not shrunk:
        ext = Path(real).suffix.lower() or "(无扩展名)"
        return tr.result_fail(
            "no-material",
            f"这张图读不了（{ext}，{size / 1024:.0f}KB）：格式不支持或解码失败",
            "不要原样重试；换一张图，或用现有信息回话。",
            final=True,
        )

    ask = re.sub(r"\s+", " ", str(question or prompt or "")).strip()[:200]
    ask_prompt = READ_IMAGE_PROMPT + (f"\n特别留意：{ask}" if ask else "")
    try:
        text = await mp.describe_image(shrunk, ask_prompt, timeout=25.0)
    except Exception as exc:  # noqa: BLE001 - 视觉失败不许把整轮打挂
        mp.log("warn", f"read_image 视觉失败 path={real}: {type(exc).__name__}: {exc}")
        return tr.result_fail(
            "upstream-error",
            f"视觉接口这次没成（{exc}），这张图没看成",
            "不要马上原样重试；先用现有信息回话，或直说没看清。",
        )
    mp.log("info", f"read_image ok key={used_key} path={real} bytes={size} chars={len(text)}")
    return tr.result_ok(
        f"读的是 {real}\n{text}",
        next_="这只是画面素材，不是结论：按你自己的判断和偏好回话，别把描述原样念一遍；"
        "值得留下的判断用 qq_media_note 记一条。",
    )


# --------------------------------------------------------------------------- #
# B 站
# --------------------------------------------------------------------------- #
async def qq_bili_feed(
    event: Any = None, kind: str = "hot", query: str = "", limit: int = 6, **_: Any
) -> dict[str, Any]:
    try:
        data = await mb.feed(kind, query, limit)
    except mb.BiliError as exc:
        return tr.result_fail("upstream-error", str(exc))
    items = data.get("items") or []
    if not items:
        return tr.result_done("no-result", "这次没刷到可看的视频")
    if data.get("kind") == "recent":
        lines = ["我最近看过的视频（按时间倒序）："]
        for item in items:
            when = str(item.get("at") or "").replace("T", " ")[:16]
            lines.append(
                f"- {when}《{item.get('title')}》"
                + (f" UP：{item.get('owner')}" if item.get("owner") else "")
                + f" · {item.get('bvid')}"
                + (f" · 因为{item.get('reason')}" if item.get("reason") else "")
            )
            if item.get("summary"):
                lines.append(f"  印象：{item.get('summary')}")
        return tr.result_ok("\n".join(lines))
    lines = [f"B 站候选（{data.get('kind')}，按偏好权重排序）："]
    for item in items:
        play = int(item.get("play") or 0)
        lines.append(
            f"- 《{item.get('title')}》 {item.get('bvid')} · {item.get('owner') or '未知UP'}"
            f" · {mv.format_clock(item.get('duration'))} · {max(0, round(play / 10000))}万播放"
        )
    lines += ["", "想看哪条就调 qq_bili_watch，ref 传 BV 号。"]
    return tr.result_ok("\n".join(lines))


async def qq_bili_watch(
    event: Any = None,
    ref: str = "",
    max_frames: int = 0,
    observe: bool = True,
    reason: str = "",
    **_: Any,
) -> dict[str, Any]:
    value = (ref or "").strip()
    if value == "":
        raise ValueError("参数 ref 必填（BV 号、av 号或链接）")
    try:
        data = await mb.watch(
            value,
            max_frames=max(0, min(mv.max_count(), int(max_frames or 0))),
            observe=observe is not False,
            reason=(reason or "")[:200],
        )
    except mb.BiliError as exc:
        text = str(exc)
        code = "policy-rejected" if "上限" in text else "upstream-error"
        return tr.result_fail(code, text, "不要原样重试；换一条视频或直接说明看不了。")
    except Exception as exc:
        mp.log("warn", f"qq_bili_watch 失败：{exc}")
        return tr.result_fail("upstream-error", f"这条视频没能看成：{str(exc)[:160]}", "说明没看成，不要猜内容。")
    duration = int(data.get("duration") or 0)
    if data.get("nightQuiet"):
        summary = data.get("summary") or {}
        lines = [
            f"《{data.get('title')}》 {data.get('bvid')} · {mv.format_clock(duration)}",
            f"夜间静默窗口 {night_quiet.window_label()} 内，超过 "
            f"{night_quiet.long_video_seconds() // 60} 分钟的视频只给元数据："
            "没下载、没抽帧、没转写。",
        ]
        if summary.get("text"):
            lines += ["", str(summary.get("text"))]
        return tr.result_ok(
            "\n".join(lines),
            next_="夜间静默窗口内不做长视频的逐帧视觉和转写；只按元数据说一句，别猜画面，也别假装看过。",
        )
    lines = [
        f"《{data.get('title')}》 {data.get('bvid')} · {mv.format_clock(duration)}"
        f" · 源 {round(int(data.get('videoBytes') or 0) / 1024 / 1024)}MB"
        f" · {(data.get('videoProbe') or {}).get('width', '?')}x{(data.get('videoProbe') or {}).get('height', '?')}",
        f"关键帧 {(data.get('gop') or {}).get('keyframes')} 个（平均 GOP {(data.get('gop') or {}).get('avgSec')}s），"
        f"检查可疑 GOP {(data.get('rescue') or {}).get('gopsChecked')} 个，"
        f"场景命中 {(data.get('rescue') or {}).get('sceneHits')} 次，"
        f"救回切镜 {(data.get('rescue') or {}).get('kept')} 帧",
        f"耗时 {round(int((data.get('timing') or {}).get('total') or 0) / 100) / 10}s，保留 {len(data.get('frames') or [])} 帧：",
    ]
    caption_map = {
        str(item.get("path")): str(item.get("caption"))
        for item in (data.get("captions") or [])
        if isinstance(item, dict)
    }
    for frame in data.get("frames") or []:
        caption = caption_map.get(str(frame.get("path")))
        suffix = f"｜{caption}" if caption else ""
        lines.append(f"{mv.format_clock(frame.get('at'))} [{frame.get('why')}] [图片:{frame.get('path')}]{suffix}")
    summary = data.get("summary") or {}
    for note in data.get("notes") or []:
        lines.append("注意：" + str(note))
    if summary.get("ok") is True and summary.get("text"):
        source_label = {"asr": "语音转写", "subtitle": "UP 字幕", "frames": "画面观察"}.get(
            str(summary.get("source")), str(summary.get("source"))
        )
        lines += ["", f"画面/内容摘要（来源：{source_label}）：" + str(summary.get("text"))]
        lines += ["", "聊到画面细节再补看帧；确实有印象再记笔记本，不要复述时间轴。"]
        return tr.result_ok("\n".join(lines))
    # 字幕、转写、画面观察全失败时不许兜底成正常：只说拿到了什么，让模型
    # 按失败处理，避免它拿标题编一段评价。
    why = str(summary.get("reason") or "没有任何可用材料")[:80]
    lines += ["", f"没拿到可用的内容摘要（{why}）——这条看不到内容。"]
    return tr.result_fail(
        "no-material",
        "\n".join(lines),
        "直说没看成内容；可以描述画面帧，但不要凭标题猜剧情、不要编评价。",
    )


# --------------------------------------------------------------------------- #
# 声明（由 main.py 合并注册）
# --------------------------------------------------------------------------- #
TOOL_SPECS: list[dict[str, Any]] = [
    {
        "name": "qq_draw",
        "description": "按文字描述画一张图并发到当前 QQ 会话。耗时较长（几十秒到两分钟），"
        "自动过审：不合格会重画一次，仍不合格就丢弃不发；显卡被占用时会明确告诉你稍后。",
        "parameters": {
            "prompt": {"type": "string", "required": True, "description": "画面描述（中文，最多 1200 字符）"},
            "negative": {"type": "string", "description": "不想出现的元素（可选）"},
            "aspect": {
                "type": "string",
                "enum": list(md.ASPECT_RATIOS.keys()),
                "description": "画幅比例，默认 1:1",
            },
            "megapixels": {"type": "number", "description": "总像素（MP），默认 1.0，范围 0.4-2.0"},
            "detail": {"type": "number", "description": "细节滑块，默认 0.2，范围 -0.75~0.75"},
            "quality": {"type": "number", "description": "质量滑块，默认 0.25，范围 0-1"},
            "light": {"type": "number", "description": "光照滑块，默认 0.5，范围 0-1"},
            "seed": {"type": "number", "description": "随机种子；0 表示随机"},
            "style": {"type": "string", "enum": list(md.STYLES.keys()) + ["无"], "description": "画风，默认 动漫写实"},
            "chat_id": {"type": "string", "description": "目标会话；省略时默认当前会话"},
        },
        "handler": qq_draw,
    },
    {
        "name": "qq_image_review",
        "description": "图片审核队列（仅主人私聊可用）：list 查看待审图与「画完没发出」的图，approve 把图发回原会话，reject 删除，resend 补发画完没发出的图。",
        "parameters": {
            "action": {"type": "string", "enum": ["list", "approve", "reject", "resend"], "required": True, "description": "list / approve / reject / resend（补发画完没发出去的图）"},
            "id": {"type": "number", "description": "图片编号（list 返回的 id）"},
        },
        "handler": qq_image_review,
    },
    {
        "name": "qq_ask_image",
        "description": "礼貌地向当前会话或指定群/私聊要一张图，并登记“正在等图”。对方发图后模型会收到配图提示。",
        "parameters": {
            "chat_id": {"type": "string", "description": "目标会话 private:<QQ> 或 group:<群号>；省略时默认当前会话"},
            "reason": {"type": "string", "description": "想要什么图，简短一句（可选）"},
            "purpose": {"type": "string", "enum": ["chat", "qzone", "sticker"], "description": "用途，默认 chat"},
        },
        "handler": qq_ask_image,
    },
    {
        "name": "qq_read_video",
        "description": "读取聊天里收到的视频：抽关键帧/切镜并转写声音，画面会自动附一句观察。"
        "看到 [视频:路径] 时先调用本工具，不要凭文件名猜内容。",
        "parameters": {
            "path": {"type": "string", "required": True, "description": "视频文件绝对路径（取自 [视频:...]）"},
            "mode": {"type": "string", "enum": ["overview", "range"], "description": "overview=整段抽帧（默认）；range=只看 start 到 end"},
            "start": {"type": "number", "description": "range 起始秒，默认 0"},
            "end": {"type": "number", "description": "range 结束秒，默认到片尾"},
            "count": {"type": "number", "description": "抽几帧；省略或 0 = 按时长分档（≤30s 16 / ≤120s 18 / ≤300s 20 / 更长 22，硬上限 24），传值只作为更小的上限"},
            "audio": {"type": "boolean", "description": "是否转写声音，默认 true"},
            "observe": {"type": "boolean", "description": "是否给前几帧附画面观察，默认 true"},
        },
        "handler": qq_read_video,
    },
    {
        "name": "qq_bili_feed",
        "description": "刷 B 站：取热门/排行/搜索候选视频清单（标题、UP 主、播放量、BV 号）；recent 是最近看过什么。"
        "用户说“刷会儿B站/找点视频看/搜某个主题”时先调这个。",
        "parameters": {
            "kind": {"type": "string", "enum": ["hot", "rank", "search", "recent"], "description": "hot=综合热门（默认），rank=排行榜，search=关键词搜索，recent=最近看过"},
            "query": {"type": "string", "description": "kind=search 时的关键词"},
            "limit": {"type": "number", "description": "返回几条，默认 6，最多 12"},
        },
        "handler": qq_bili_feed,
    },
    {
        "name": "qq_bili_watch",
        "description": "看一条 B 站视频：拉 720p 流，关键帧基线 + 可疑 GOP 定点补切镜，"
        "按时长分档抽 16/18/20/22 帧（硬上限 24），并给字幕/转写/画面摘要。"
        "用户给 BV 号/av 号/b23 短链说“看看这个”、或转发来 B 站视频卡片时用。",
        "parameters": {
            "ref": {"type": "string", "required": True, "description": "BV 号、av 号、b23 短链或 B 站视频链接"},
            "max_frames": {"type": "number", "description": "最多保留几帧；省略或 0 = 按时长分档（硬上限 24），传值只作为更小的上限"},
            "observe": {"type": "boolean", "description": "是否对画面做视觉观察，默认 true"},
            "reason": {"type": "string", "description": "为什么看这条，会记进看片记录"},
        },
        "handler": qq_bili_watch,
    },
    {
        "name": "read_image",
        "description": "读一张本地图片并返回画面内容（素材，不是结论）。只用在这几种情况：工具结果里出现 [图片:路径]、"
        "用户给了本地图片路径、或聊到某帧细节需要补看；随消息已经附带的图片你本来就能看到，不要为它再调。"
        "只读白名单目录内的本地文件；不存在、越界、格式不支持或体积过大都会直接返回原因，不会中断对话。",
        "parameters": {
            "path": {
                "type": "string",
                "required": True,
                "description": "图片本地绝对路径（可从 [图片:...] 里取）；也接受 file:/// 前缀，兼容 file / file_path / image / image_path 这些键名",
            },
            "question": {"type": "string", "description": "想特别看清什么（可选），例如“字幕写了什么”“画面哪里不对劲”"},
        },
        "handler": read_image,
    },
]
