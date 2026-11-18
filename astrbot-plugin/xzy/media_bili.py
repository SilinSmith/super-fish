"""B 站候选与看片链路（对齐旧栈 qq-persona/bili.mjs + bili-summary.mjs）。

- feed: hot / rank / search / recent（recent 读本机看片记录）；
- watch: 解析 BV/av/b23 → view 信息 → 720p durl → 抽关键帧 + 可疑 GOP 补切镜
  → 字幕优先、没有字幕走 whisper 转写 → 视觉补观察 → 三段式摘要。
长视频不再硬截断：字幕/转写按开头/中段/结尾取 12000 字，帧预算固定上限。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode

try:
    from .media_platform import (
        MEDIA_DIR,
        PERSONA_HOME,
        append_jsonl,
        backend,
        chat_text,
        describe_image,
        log,
        now_iso,
        read_json,
        tail_jsonl,
        write_json_atomic,
    )
    from . import media_video as mv
    from . import night_quiet
except ImportError:  # AstrBot 以模块方式加载时走这里
    from media_platform import (  # type: ignore
        MEDIA_DIR,
        PERSONA_HOME,
        append_jsonl,
        backend,
        chat_text,
        describe_image,
        log,
        now_iso,
        read_json,
        tail_jsonl,
        write_json_atomic,
    )
    import media_video as mv  # type: ignore
    import night_quiet  # type: ignore

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
HEADERS = {
    "User-Agent": USER_AGENT,
    "Referer": "https://www.bilibili.com/",
    "Origin": "https://www.bilibili.com",
}
API = "https://api.bilibili.com"
MAX_DURATION_SEC = 20 * 60
MAX_SUBTITLE_CHARS = 12_000
# AstrBot 的 tool_call_timeout 是 300s：预算按 230s 走，剩下 70s 留给模型收尾。
# 超预算不改结论，只做「降级 + 明说」：转写先降 tiny，再不够就跳过并记进 notes。
WATCH_BUDGET_SEC = float(os.environ.get("XZY_BILI_BUDGET_SEC") or 230)
# 本机实测 RTF（i7-13700K，whisper CPU）：small≈0.42，tiny≈0.10。
ASR_RTF = {"small": 0.42, "tiny": 0.11}
STATE_PATH = PERSONA_HOME / "bili-state.json"
PREFS_PATH = PERSONA_HOME / "bili-prefs.json"
VIDEO_MEMORY_PATH = PERSONA_HOME / "bili-video-memory.jsonl"
_WATCH_LOCK = asyncio.Lock()
# 看片抽帧上限：默认跟 video.hardCap 走（分档 16/18/20/22，硬上限 24）
_CFG: dict[str, Any] = {}


def configure(cfg: dict[str, Any]) -> None:
    section = cfg.get("bili") if isinstance(cfg.get("bili"), dict) else {}
    _CFG.clear()
    _CFG.update(section)


def _frame_cap(requested: int = 0) -> int:
    """看片帧数上限：bili.maxFrames 与入参都只能把分档预算压小，不能抬高。"""
    cap = mv.max_count()
    try:
        configured = int(_CFG.get("maxFrames") or 0)
    except (TypeError, ValueError):
        configured = 0
    if configured > 0:
        cap = min(cap, configured)
    try:
        asked = int(requested or 0)
    except (TypeError, ValueError):
        asked = 0
    if asked > 0:
        cap = min(cap, asked)
    return max(1, cap)

MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

_NAV_CACHE: dict[str, Any] = {"at": 0.0, "img": "", "sub": ""}


class BiliError(RuntimeError):
    pass


def _session():
    import aiohttp

    return aiohttp.ClientSession(
        headers=HEADERS,
        timeout=aiohttp.ClientTimeout(total=20),
    )


def _md5(text: str) -> str:
    try:
        from hashlib import md5

        return md5(text.encode("utf-8")).hexdigest()
    except Exception:  # pragma: no cover
        return ""


async def _fetch_nav_keys() -> tuple[str, str]:
    now = time.time()
    if _NAV_CACHE["img"] and now - float(_NAV_CACHE["at"]) < 6 * 3600:
        return str(_NAV_CACHE["img"]), str(_NAV_CACHE["sub"])
    try:
        async with _session() as session:
            async with session.get(API + "/x/web-interface/nav") as resp:
                data = await resp.json(content_type=None)
    except Exception as exc:
        log("warn", f"bili nav 失败：{exc}")
        return "", ""
    wbi = ((data or {}).get("data") or {}).get("wbi_img") or {}
    img = str(wbi.get("img_url") or "")
    sub = str(wbi.get("sub_url") or "")
    img_key = img.rsplit("/", 1)[-1].split(".")[0] if img else ""
    sub_key = sub.rsplit("/", 1)[-1].split(".")[0] if sub else ""
    if img_key and sub_key:
        _NAV_CACHE.update({"at": now, "img": img_key, "sub": sub_key})
    return img_key, sub_key


async def _wbi_params(params: dict[str, Any]) -> dict[str, Any]:
    img_key, sub_key = await _fetch_nav_keys()
    if not img_key or not sub_key:
        return dict(params)
    raw = img_key + sub_key
    mixin = "".join(raw[index] for index in MIXIN_KEY_ENC_TAB if index < len(raw))[:32]
    signed = dict(params)
    signed["wts"] = int(time.time())
    filtered = {
        key: "".join(ch for ch in str(value) if ch not in "!'()*")
        for key, value in signed.items()
    }
    query = urlencode(sorted(filtered.items()), quote_via=quote)
    signed["w_rid"] = _md5(query + mixin)
    return signed


async def fetch_json(path: str, params: dict[str, Any] | None = None, *, wbi: bool = False) -> dict[str, Any]:
    params = dict(params or {})
    if wbi:
        params = await _wbi_params(params)
    url = API + path + ("?" + urlencode(params, quote_via=quote) if params else "")
    try:
        async with _session() as session:
            async with session.get(url) as resp:
                raw = await resp.text()
    except Exception as exc:
        raise BiliError("连不上 B 站") from exc
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise BiliError("B 站返回格式异常") from exc
    if not isinstance(data, dict):
        raise BiliError("B 站返回格式异常")
    if int(data.get("code") or 0) != 0:
        raise BiliError(str(data.get("message") or "B 站接口拒绝"))
    return data


def parse_ref(ref: str) -> str:
    value = (ref or "").strip()
    match = re.search(r"(BV[0-9A-Za-z]{10})", value)
    if match:
        return match.group(1)
    match = re.search(r"av(\d+)", value, re.I)
    if match:
        return "av" + match.group(1)
    return ""


async def resolve_ref(ref: str) -> str:
    bvid = parse_ref(ref)
    if bvid:
        return bvid
    if "b23.tv" in (ref or ""):
        try:
            import aiohttp

            async with aiohttp.ClientSession(
                headers=HEADERS, timeout=aiohttp.ClientTimeout(total=12)
            ) as session:
                async with session.get(ref, allow_redirects=True) as resp:
                    return parse_ref(str(resp.url))
        except Exception as exc:
            raise BiliError("短链解析失败") from exc
    raise BiliError("认不出这个 BV 号/链接")


def _duration_of(item: dict[str, Any]) -> int:
    try:
        return int(item.get("duration") or 0)
    except (TypeError, ValueError):
        return 0


async def video_info(bvid: str) -> dict[str, Any]:
    data = await fetch_json("/x/web-interface/view", {"bvid": bvid} if bvid.startswith("BV") else {"aid": bvid[2:]})
    view = data.get("data") or {}
    pages = view.get("pages") or []
    cid = 0
    if pages:
        cid = int(pages[0].get("cid") or 0)
    return {
        "bvid": str(view.get("bvid") or bvid),
        "aid": int(view.get("aid") or 0),
        "cid": cid,
        "title": str(view.get("title") or ""),
        "owner": str((view.get("owner") or {}).get("name") or ""),
        "duration": int(view.get("duration") or 0),
        "desc": str(view.get("desc") or ""),
        "pages": pages,
    }


def _prefs() -> dict[str, Any]:
    value = read_json(PREFS_PATH, {})
    return value if isinstance(value, dict) else {}


def _score(item: dict[str, Any], prefs: dict[str, Any]) -> float:
    score = 0.0
    owner = str(item.get("owner") or "")
    title = str(item.get("title") or "")
    up_weights = prefs.get("upWeights") or {}
    if isinstance(up_weights, dict):
        for name, weight in up_weights.items():
            if name and name in owner:
                score += float(weight or 0)
    title_weights = prefs.get("titleWeights") or {}
    if isinstance(title_weights, dict):
        for word, weight in title_weights.items():
            if word and word in title:
                score += float(weight or 0)
    play = int(item.get("play") or 0)
    score += min(30.0, play / 200_000)
    duration = _duration_of(item)
    if 120 <= duration <= 900:
        score += 8
    elif duration > MAX_DURATION_SEC:
        score -= 25
    return score


def _excluded(item: dict[str, Any], prefs: dict[str, Any]) -> bool:
    title = str(item.get("title") or "")
    for word in prefs.get("exclude") or []:
        if word and word in title:
            return True
    return False


def _shape_video(item: dict[str, Any]) -> dict[str, Any]:
    owner = item.get("owner") or {}
    if isinstance(owner, dict):
        owner_name = str(owner.get("name") or "")
    else:
        owner_name = str(owner or "")
    return {
        "bvid": str(item.get("bvid") or ""),
        "title": str(item.get("title") or ""),
        "owner": owner_name,
        "duration": _duration_of(item),
        "play": int(item.get("play") or (item.get("stat") or {}).get("view") or 0),
        "pubdate": int(item.get("pubdate") or 0),
    }


async def _hot(limit: int) -> list[dict[str, Any]]:
    data = await fetch_json("/x/web-interface/popular", {"ps": min(50, limit * 3), "pn": 1})
    return [_shape_video(item) for item in (data.get("data") or {}).get("list") or []]


async def _rank(limit: int) -> list[dict[str, Any]]:
    data = await fetch_json("/x/web-interface/ranking/v2", {"rid": 0, "type": "all"}, wbi=True)
    return [_shape_video(item) for item in (data.get("data") or {}).get("list") or []]


async def _search(query: str, limit: int) -> list[dict[str, Any]]:
    if not query.strip():
        raise BiliError("搜索需要关键词")
    data = await fetch_json(
        "/x/web-interface/wbi/search/type",
        {"search_type": "video", "keyword": query.strip(), "page": 1, "page_size": min(30, limit * 3)},
        wbi=True,
    )
    result = (data.get("data") or {}).get("result") or []
    return [_shape_video(item) for item in result]


def _recent(limit: int) -> list[dict[str, Any]]:
    state = read_json(STATE_PATH, {})
    recent = state.get("recent") if isinstance(state, dict) else []
    if not isinstance(recent, list):
        recent = []
    memory: dict[str, dict[str, Any]] = {}
    for entry in tail_jsonl(VIDEO_MEMORY_PATH, 500):
        if entry.get("bvid") and entry.get("kind") not in ("none", "", None):
            memory[str(entry["bvid"])] = entry
    items: list[dict[str, Any]] = []
    for item in recent[:limit]:
        bvid = str(item.get("bvid") or "")
        note = memory.get(bvid) or {}
        items.append(
            {
                "at": str(item.get("at") or ""),
                "bvid": bvid,
                "title": str(item.get("title") or ""),
                "owner": str(item.get("owner") or ""),
                "reason": str(item.get("reason") or ""),
                "summary": str(item.get("summary") or note.get("summary") or ""),
                "memoryIds": [str(note["memoryId"])] if note.get("memoryId") else [],
            }
        )
    return items


async def feed(kind: str, query: str, limit: int) -> dict[str, Any]:
    kind = kind if kind in ("hot", "rank", "search", "recent") else "hot"
    limit = max(1, min(int(limit or 6), 12))
    if kind == "recent":
        return {"kind": "recent", "items": _recent(limit)}
    if kind == "hot":
        items = await _hot(limit)
    elif kind == "rank":
        items = await _rank(limit)
    else:
        items = await _search(query, limit)
    prefs = _prefs()
    items = [item for item in items if item.get("bvid") and not _excluded(item, prefs)]
    items.sort(key=lambda item: _score(item, prefs), reverse=True)
    return {"kind": kind, "items": items[:limit]}


async def _play_urls(info: dict[str, Any]) -> list[str]:
    params = {
        "bvid": info["bvid"],
        "cid": info["cid"],
        "qn": 64,
        "fnval": 1,
        "fourk": 0,
    }
    data = await fetch_json("/x/player/wbi/playurl", params, wbi=True)
    durl = (data.get("data") or {}).get("durl") or []
    if not durl:
        raise BiliError("这条视频没有可直接下载的 720p 流")
    hosts = [str(durl[0].get("url") or ""), *[str(item) for item in (durl[0].get("backup_url") or [])]]
    hosts = [item for item in hosts if item]
    if not hosts:
        raise BiliError("取流地址失败")
    return hosts


async def _download(url: str, target: str, *, total_timeout: float = 600) -> int:
    import aiohttp

    timeout = aiohttp.ClientTimeout(total=max(15.0, total_timeout), sock_read=120)
    async with aiohttp.ClientSession(headers=HEADERS, timeout=timeout) as session:
        async with session.get(url) as resp:
            if resp.status >= 400:
                raise BiliError(f"下载视频失败（HTTP {resp.status}）")
            with open(target, "wb") as f:
                async for chunk in resp.content.iter_chunked(256 * 1024):
                    f.write(chunk)
    return os.path.getsize(target)


async def _subtitle(info: dict[str, Any]) -> dict[str, Any]:
    try:
        data = await fetch_json(
            "/x/player/v2", {"bvid": info["bvid"], "cid": info["cid"]}, wbi=True
        )
    except BiliError:
        return {"ok": False, "reason": "字幕接口不可用"}
    subs = ((data.get("data") or {}).get("subtitle") or {}).get("subtitles") or []
    if not subs:
        return {"ok": False, "reason": "没有字幕"}
    url = str(subs[0].get("subtitle_url") or "")
    if url.startswith("//"):
        url = "https:" + url
    if not url:
        return {"ok": False, "reason": "字幕地址为空"}
    try:
        import aiohttp

        async with aiohttp.ClientSession(headers=HEADERS, timeout=aiohttp.ClientTimeout(total=20)) as session:
            async with session.get(url) as resp:
                data = await resp.json(content_type=None)
    except Exception:
        return {"ok": False, "reason": "字幕下载失败"}
    body = data.get("body") or []
    lines: list[str] = []
    for item in body:
        text = str(item.get("content") or "").strip()
        if text:
            lines.append(f"[{mv.format_clock(item.get('from') or 0)}] {text}")
    text = "\n".join(lines).strip()
    if not text:
        return {"ok": False, "reason": "字幕为空"}
    return {"ok": True, "lang": str(subs[0].get("lan") or ""), "chars": len(text), "text": text}


def _trim(text: str) -> str:
    if len(text) <= MAX_SUBTITLE_CHARS:
        return text
    part = MAX_SUBTITLE_CHARS // 3
    middle = len(text) // 2
    return (
        text[:part]
        + "\n……\n"
        + text[middle - part // 2 : middle + part // 2]
        + "\n……\n"
        + text[-part:]
    )


async def summarize_video(
    *,
    title: str,
    owner: str,
    duration: int,
    subtitle: dict[str, Any],
    asr: dict[str, Any],
    captions: list[str],
) -> dict[str, Any]:
    use_subtitle = subtitle.get("ok") is True and str(subtitle.get("text") or "").strip() != ""
    use_asr = (not use_subtitle) and asr.get("ok") is True and str(asr.get("text") or "").strip() != ""
    if use_subtitle:
        material = "以下是视频字幕（时间轴 + 正文）：\n" + _trim(str(subtitle.get("text") or ""))
        source = "subtitle"
    elif use_asr:
        material = "以下是视频语音内容（时间轴 + 正文，可能有同音错字）：\n" + _trim(str(asr.get("text") or ""))
        source = "asr"
    elif captions:
        material = "以下是按画面变化率抽帧得到的画面观察（只记录画面里发生了什么）：\n" + "\n".join(
            f"{index + 1}. {text}" for index, text in enumerate(captions)
        )
        source = "frames"
    else:
        return {"ok": False, "source": "none", "reason": "既没有字幕、转写也没有画面观察", "text": ""}
    minutes = max(1, round((duration or 0) / 60))
    messages = [
        {
            "role": "system",
            "content": "你是视频编辑。只根据给定材料写一份给人看的视频总结，不编造材料里没有的情节。"
            "不要逐帧罗列画面，不要空话。只输出 JSON。",
        },
        {
            "role": "user",
            "content": f"视频：《{title}》\nUP：{owner}\n时长：约 {minutes} 分钟\n\n{material}\n\n"
            '请输出 JSON：{"gist":"2-4 句连贯的话，说清主题和脉络",'
            '"highlights":["具体的内容点 1","具体的内容点 2"],"audience":"一句话：适合谁看"}\n'
            "gist 不超过 160 字，highlights 每条不超过 40 字、最多 3 条，audience 不超过 40 字。",
        },
    ]
    started = time.time()
    try:
        raw = await chat_text(messages, max_tokens=700, timeout=120.0, temperature=0.2)
    except RuntimeError as exc:
        return {"ok": False, "source": source, "reason": str(exc), "text": ""}
    text = raw.strip()
    match = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if match:
        text = match.group(1).strip()
    try:
        parsed = json.loads(text)
    except ValueError:
        parsed = {"gist": re.sub(r"\s+", " ", text)[:220]}
    gist = str(parsed.get("gist") or "").strip()
    if not gist:
        return {"ok": False, "source": source, "reason": "模型没有给出可用总结", "text": ""}
    lines = ["讲了什么：" + gist]
    highlights = [str(x).strip() for x in (parsed.get("highlights") or []) if str(x).strip()][:3]
    if highlights:
        marks = ["①", "②", "③"]
        lines.append("值得看的点：" + " ".join(marks[i] + item for i, item in enumerate(highlights)))
    audience = str(parsed.get("audience") or "").strip()
    if audience:
        lines.append("适合谁看：" + audience)
    return {
        "ok": True,
        "source": source,
        "text": "\n".join(lines),
        "chars": sum(len(line) for line in lines),
        "ms": int((time.time() - started) * 1000),
    }


def _record_state(info: dict[str, Any], *, frames: int, rescued: int, total_ms: int, bytes_: int) -> None:
    state = read_json(STATE_PATH, {})
    if not isinstance(state, dict):
        state = {}
    recent = state.get("recent") if isinstance(state.get("recent"), list) else []
    entry = {
        "at": now_iso() + "Z",
        "bvid": info["bvid"],
        "title": info["title"],
        "owner": info["owner"],
        "duration": info["duration"],
        "frames": frames,
        "rescued": rescued,
        "totalMs": total_ms,
        "bytes": bytes_,
        "chatId": "bili:tool",
        "triggeredBy": "qq_bili_watch",
    }
    recent = [item for item in recent if item.get("bvid") != info["bvid"]]
    recent.insert(0, entry)
    state["recent"] = recent[:60]
    state["updatedAt"] = now_iso()
    try:
        write_json_atomic(STATE_PATH, state)
    except OSError as exc:
        log("warn", f"bili 状态写入失败：{exc}")


def _night_manifest(
    info: dict[str, Any], decision: dict[str, Any], started: float
) -> dict[str, Any]:
    """夜间静默降级：不下载、不抽帧、不转写，只给 B 站元数据。"""
    total_ms = int((time.time() - started) * 1000)
    desc = re.sub(r"\s+", " ", str(info.get("desc") or "")).strip()
    minutes = max(1, round(int(info.get("duration") or 0) / 60))
    text = f"《{info['title']}》 UP：{info['owner'] or '未知'}，时长约 {minutes} 分钟。"
    if desc:
        text += "简介：" + (desc[:180] + "…" if len(desc) > 180 else desc)
    else:
        text += "夜间静默只取元数据，这条没有简介可引用。"
    note = str(decision.get("reason") or "夜间静默窗口") + "；未下载、未抽帧、未转写。"
    append_jsonl(
        MEDIA_DIR / "state" / "bili-watch.jsonl",
        {
            "at": now_iso(),
            "bvid": info["bvid"],
            "title": info["title"],
            "reason": "夜间静默",
            "frames": 0,
            "ok": False,
            "nightQuiet": True,
            "degraded": "metadata-only",
            "ms": total_ms,
        },
    )
    return {
        "bvid": info["bvid"],
        "title": info["title"],
        "owner": info["owner"],
        "duration": info["duration"],
        "videoBytes": 0,
        "videoProbe": {},
        "gop": {"keyframes": 0, "avgSec": 0},
        "rescue": {"gopsChecked": 0, "sceneHits": 0, "kept": 0, "missedByKeyframeOnly": 0},
        "timing": {"total": total_ms},
        "budget": {"limitSec": int(WATCH_BUDGET_SEC), "spentSec": int(total_ms / 1000)},
        "notes": [note],
        "frames": [],
        "captions": [],
        "summary": {"ok": True, "source": "metadata", "text": text, "chars": len(text), "ms": 0},
        "account": {"status": "anonymous", "quality": 64},
        "nightQuiet": True,
        "nightWindow": decision.get("window"),
    }


async def watch(
    ref: str,
    *,
    max_frames: int = 0,
    observe: bool = True,
    reason: str = "",
) -> dict[str, Any]:
    async with _WATCH_LOCK:
        started = time.time()
        deadline = started + WATCH_BUDGET_SEC
        stage: dict[str, int] = {}
        notes: list[str] = []

        def remaining() -> float:
            return deadline - time.time()

        def mark(name: str) -> None:
            stage[name] = int((time.time() - started) * 1000)

        bvid = await resolve_ref(ref)
        info = await video_info(bvid)
        if info["duration"] > MAX_DURATION_SEC:
            raise BiliError(f"这条视频 {mv.format_clock(info['duration'])}，超过单次看片上限 20 分钟")
        # 夜间静默：长视频只给元数据（不下载/抽帧/转写），短于阈值的仍可正常看
        quiet = night_quiet.evaluate("video", duration_sec=info["duration"])
        if quiet["action"] == "degrade":
            night_quiet.record(
                quiet,
                caller="media_bili.watch",
                extra={"bvid": info["bvid"], "title": info["title"]},
            )
            return _night_manifest(info, quiet, started)
        urls = await _play_urls(info)
        mark("meta")
        workdir = tempfile.mkdtemp(prefix="qqbili-")
        video_path = os.path.join(workdir, "video.mp4")
        try:
            bytes_ = 0
            last_error: BaseException | None = None
            for index, candidate in enumerate(urls):
                try:
                    bytes_ = await _download(
                        candidate, video_path, total_timeout=max(20.0, remaining() - 20)
                    )
                    break
                except Exception as exc:  # noqa: BLE001
                    last_error = exc
                    log("warn", f"bili 下载失败（第 {index + 1} 个地址）：{exc}")
            if bytes_ == 0 and last_error is not None:
                raise last_error
            mark("download")
            probe = await mv.probe(video_path)
            keyframes = await mv.keyframe_table(video_path)
            avg_gop = (
                round((info["duration"] or 0) / max(1, len(keyframes)), 1) if keyframes else 0
            )
            frames_out = os.path.join(workdir, "frames")
            outdir = MEDIA_DIR / "bili-frames" / (info["bvid"] + "-" + time.strftime("%Y%m%d%H%M%S"))
            outdir.mkdir(parents=True, exist_ok=True)
            collected = await mv.collect_frames(
                video_path,
                count=_frame_cap(max_frames),
                outdir=frames_out,
            )
            mark("frames")
            frames: list[dict[str, Any]] = []
            for index, frame in enumerate(collected["frames"]):
                target = outdir / f"frame_{index:02d}.jpg"
                try:
                    shutil.copyfile(frame["path"], target)
                except OSError:
                    continue
                frames.append({"at": frame["at"], "path": str(target), "why": frame["why"]})
            keyframes_kept = sum(1 for frame in frames if frame["why"] == "keyframe")
            scene_kept = sum(1 for frame in frames if frame["why"] == "scene")
            scene_hits = scene_kept
            subtitle = await _subtitle(info)
            asr: dict[str, Any] = {"ok": False}
            if not subtitle.get("ok") and probe["hasAudio"]:
                left = remaining()
                est = {
                    name: info["duration"] * rtf
                    for name, rtf in ASR_RTF.items()
                }
                pick = next(
                    (name for name in ("small", "tiny") if est[name] + 25 <= left),
                    None,
                )
                if pick is None:
                    notes.append(
                        f"时间预算不够转写（剩 {int(left)}s，"
                        f"small 约 {int(est['small'])}s / tiny 约 {int(est['tiny'])}s），已跳过"
                    )
                    log("warn", "bili 转写跳过：" + notes[-1])
                else:
                    if pick != "small":
                        notes.append("按时间预算把转写降到 tiny（小模型，专有名词可能听错）")
                    try:
                        audio = await mv.extract_audio(video_path, workdir)
                        if audio is None:
                            raise mv.VideoError("音轨抽取失败")
                        text = await mv.transcribe_audio(
                            audio,
                            timeout=max(20.0, min(900.0, left - 15)),
                            model=pick,
                        )
                        asr = {"ok": True, "model": pick, "chars": len(text), "text": text}
                    except Exception as exc:
                        log("warn", f"bili 转写失败：{exc}")
            mark("asr")
            observed: list[dict[str, Any]] = []
            if observe and remaining() > 25:
                # 取帧/描述规则与 QQ 入站视频同源：mv.observe_captions（前段 2 + 中后段 2）
                observed = await mv.observe_captions(frames, describe_image)
            elif observe:
                notes.append("时间预算不足，跳过画面观察")
            mark("vision")
            if remaining() < 8:
                notes.append("时间预算不足，没做总结")
                summary = {"ok": False, "reason": "超时未总结", "text": ""}
            else:
                summary = await summarize_video(
                    title=info["title"],
                    owner=info["owner"],
                    duration=info["duration"],
                    subtitle=subtitle,
                    asr=asr,
                    captions=[str(item["caption"]) for item in observed],
                )
            mark("summary")
            total_ms = int((time.time() - started) * 1000)
            _record_state(
                info,
                frames=len(frames),
                rescued=scene_kept,
                total_ms=total_ms,
                bytes_=bytes_,
            )
            append_jsonl(
                MEDIA_DIR / "state" / "bili-watch.jsonl",
                {
                    "at": now_iso(),
                    "bvid": info["bvid"],
                    "title": info["title"],
                    "reason": reason[:200],
                    "frames": len(frames),
                    "summarySource": summary.get("source"),
                    "ok": bool(summary.get("ok")),
                    "ms": total_ms,
                },
            )
            return {
                "bvid": info["bvid"],
                "title": info["title"],
                "owner": info["owner"],
                "duration": info["duration"],
                "videoBytes": bytes_,
                "videoProbe": probe,
                "gop": {
                    "keyframes": len(keyframes),
                    "avgSec": avg_gop,
                },
                "rescue": {
                    "gopsChecked": min(12, max(0, len(keyframes) - 1)),
                    "sceneHits": scene_hits,
                    "kept": scene_kept,
                    "missedByKeyframeOnly": max(0, scene_hits - scene_kept),
                },
                "timing": {"total": total_ms, **stage},
                "budget": {"limitSec": int(WATCH_BUDGET_SEC), "spentSec": int(total_ms / 1000)},
                "notes": notes,
                "frames": frames,
                "captions": observed,
                "summary": summary,
                "account": {"status": "anonymous", "quality": 64},
            }
        finally:
            shutil.rmtree(workdir, ignore_errors=True)
