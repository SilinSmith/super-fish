"""视频取证：ffprobe 元数据、关键帧/切镜抽帧、音轨转写（whisper）。

语义对齐旧栈 qq-persona/video-frames.mjs 与 dsh-onebot-qq/lib/stt.js：
- 关键帧只作基线，可疑 GOP 再定点做场景检测补切镜；
- 抽帧数量有上限，帧文件按时间命名，返回 (at, path, why) 供工具层渲染；
- 转写走本机 whisper CLI，长音频分段不截断，结果写入 asr-transcripts 目录。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

try:
    from .media_platform import PERSONA_HOME, log
except ImportError:  # AstrBot 以模块方式加载时走这里
    from media_platform import PERSONA_HOME, log  # type: ignore

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"

MAX_TICK = 60.0
SCENE_THRESHOLD = 0.32
MAX_RESCUE_GOP = 12
MAX_COUNT = 24  # 硬上限兜底，实际以 video.hardCap 为准

# 抽帧预算：按时长分档封顶（秒, 帧数），最后一项是兜底（0 = 其余）
TIER_DEFAULTS = ((30.0, 16), (120.0, 18), (300.0, 20), (0.0, 22))
FRONT_WINDOW_DEFAULT = 5.0
FRONT_TICKS_DEFAULT = (0.3, 0.8, 1.5, 2.5, 3.5, 4.5)
MIN_GAP_DEFAULT = 0.8
SCENE_QUOTA_DEFAULT = 4
KEYFRAME_QUOTA_DEFAULT = 8
FRAME_EDGE_DEFAULT = 768
_TRANSCRIBE_LOCK = asyncio.Lock()

_CFG: dict[str, Any] = {}


def configure(cfg: dict[str, Any]) -> None:
    section = cfg.get("video") if isinstance(cfg.get("video"), dict) else {}
    _CFG.clear()
    _CFG.update(section)


def _num(key: str, default: float, cast=float) -> Any:
    try:
        value = _CFG.get(key)
        return cast(value) if value not in (None, "") else cast(default)
    except (TypeError, ValueError):
        return cast(default)


def _opt() -> dict[str, Any]:
    tiers: list[tuple[float, int]] = []
    raw = _CFG.get("frameTiers")
    if isinstance(raw, list):
        for item in raw:
            try:
                limit, budget = float(item[0]), int(item[1])
            except (TypeError, ValueError, IndexError):
                continue
            tiers.append((limit, max(1, budget)))
    if not tiers:
        tiers = list(TIER_DEFAULTS)
    raw_ticks = _CFG.get("frontTicks")
    ticks = (
        tuple(float(t) for t in raw_ticks)
        if isinstance(raw_ticks, list) and raw_ticks
        else FRONT_TICKS_DEFAULT
    )
    return {
        "hardCap": max(1, _num("hardCap", MAX_COUNT, int)),
        "tiers": tiers,
        "frontWindow": max(0.0, _num("frontWindowSec", FRONT_WINDOW_DEFAULT)),
        "frontTicks": ticks,
        "minGap": max(0.2, _num("minGapSec", MIN_GAP_DEFAULT)),
        "sceneThreshold": min(0.95, max(0.05, _num("sceneThreshold", SCENE_THRESHOLD))),
        "sceneQuota": max(0, _num("sceneQuota", SCENE_QUOTA_DEFAULT, int)),
        "keyframeQuota": max(0, _num("keyframeQuota", KEYFRAME_QUOTA_DEFAULT, int)),
        "maxRescueGop": max(1, _num("maxRescueGop", MAX_RESCUE_GOP, int)),
        "maxEdge": max(0, _num("frameMaxEdge", FRAME_EDGE_DEFAULT, int)),
    }


def frame_budget(duration: float, requested: int = 0) -> int:
    """按时长分档取帧数预算；requested>0 时作为更小的上限。"""
    opt = _opt()
    budget = opt["hardCap"]
    for limit, tier_budget in opt["tiers"]:
        if limit <= 0 or duration <= limit:
            budget = tier_budget
            break
    budget = min(budget, opt["hardCap"])
    if requested and requested > 0:
        budget = min(budget, int(requested))
    return max(1, budget)


def max_count() -> int:
    return _opt()["hardCap"]


def observe_picks(
    frames: list[dict[str, Any]], front: int = 2, rest: int = 2
) -> list[dict[str, Any]]:
    """视觉观察取帧：前段最前 front 帧 + 剩余时长里均匀铺开的 rest 帧。

    只从已抽出的帧集里挑，不额外抽帧；总数不超过 front+rest，也自然受
    分档预算 / hardCap 约束（抽出来不够就全给）。
    """
    ordered = sorted(frames, key=lambda item: float(item.get("at") or 0.0))
    if len(ordered) <= front + rest:
        return ordered
    picks = ordered[:front]
    # 「前段」以最后一个前段刻度为界（不是第 2 帧），避免中后段又落回 0–5s；
    # 没有 why 标记（range 模式）时退回第 front 帧。
    front_ends = [float(item["at"]) for item in ordered if item.get("why") == "front"]
    start = max(front_ends) if front_ends else float(picks[-1].get("at") or 0.0)
    tail = [item for item in ordered if float(item.get("at") or 0.0) > start] or ordered[front:]
    start = start if start < float(tail[-1].get("at") or 0.0) else float(tail[0].get("at") or 0.0)
    end = float(tail[-1].get("at") or 0.0)
    span = max(0.001, end - start)
    for index in range(rest):
        # 把剩余时长等分成 rest 段，各取段中点附近最近的一帧
        target = start + span * (index + 0.5) / rest
        near = min(tail, key=lambda item: abs(float(item.get("at") or 0.0) - target))
        if near not in picks:
            picks.append(near)
    picks.sort(key=lambda item: float(item.get("at") or 0.0))
    return picks


class VideoError(RuntimeError):
    pass


# 两条视频路（QQ 入站视频 / B站）共用同一份观察口径：前段 2 + 中后段 2
OBSERVE_PROMPT = "用一句中文描述这一帧画面里正在发生什么（人物/动作/场景/字幕文字）。"


async def observe_captions(
    frames: list[dict[str, Any]], describe: Any, prompt: str = OBSERVE_PROMPT
) -> list[dict[str, Any]]:
    """跨片取帧 + 逐帧画面描述：取帧规则只在这里（observe_picks）。

    返回 [{"at", "path", "caption"}]；某一帧描述失败就停，已拿到的照常返回。
    """
    out: list[dict[str, Any]] = []
    for frame in observe_picks(frames):
        try:
            text = await describe(str(frame["path"]), prompt)
        except RuntimeError as exc:
            log("warn", f"视频帧观察失败：{exc}")
            break
        out.append({"at": frame.get("at"), "path": frame.get("path"), "caption": text})
    return out


async def _run(cmd: list[str], timeout: float) -> tuple[int, bytes, bytes]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            creationflags=getattr(__import__("subprocess"), "CREATE_NO_WINDOW", 0),
        )
    except FileNotFoundError as exc:
        raise VideoError(f"找不到可执行程序：{cmd[0]}") from exc
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError as exc:
        proc.kill()
        await proc.wait()
        raise VideoError("外部命令超时") from exc
    return proc.returncode, out, err


async def probe(path: str) -> dict[str, Any]:
    if not os.path.isfile(path):
        raise VideoError("视频文件不存在")
    code, out, err = await _run(
        [
            FFPROBE, "-v", "error", "-print_format", "json",
            "-show_format", "-show_streams", path,
        ],
        30,
    )
    if code != 0:
        raise VideoError("读不出视频信息")
    try:
        data = json.loads(out.decode("utf-8", "replace"))
    except ValueError as exc:
        raise VideoError("视频信息格式异常") from exc
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    duration = 0.0
    for source in ((data.get("format") or {}).get("duration"), (video or {}).get("duration")):
        try:
            duration = float(source)
        except (TypeError, ValueError):
            continue
        if duration > 0:
            break
    rotation = 0
    for side in (video or {}).get("side_data_list") or []:
        if "rotation" in side:
            try:
                rotation = int(float(side["rotation"]))
            except (TypeError, ValueError):
                rotation = 0
    width = int((video or {}).get("width") or 0)
    height = int((video or {}).get("height") or 0)
    if abs(rotation) % 180 == 90:
        width, height = height, width
    return {
        "duration": max(duration, 0.0),
        "width": width,
        "height": height,
        "hasAudio": audio is not None,
        "videoCodec": (video or {}).get("codec_name") or "",
        "audioCodec": (audio or {}).get("codec_name") or "",
    }


def format_clock(seconds: Any) -> str:
    try:
        total = max(0, int(float(seconds)))
    except (TypeError, ValueError):
        total = 0
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


async def keyframe_table(path: str) -> list[dict[str, Any]]:
    code, out, _ = await _run(
        [
            FFPROBE, "-v", "error", "-select_streams", "v:0",
            "-skip_frame", "nokey", "-show_frames",
            "-show_entries", "frame=best_effort_timestamp_time,pkt_duration_time",
            "-of", "csv=p=0", path,
        ],
        60,
    )
    if code != 0:
        return []
    frames: list[dict[str, Any]] = []
    for line in out.decode("utf-8", "replace").splitlines():
        parts = [p.strip() for p in line.split(",") if p.strip()]
        if not parts:
            continue
        try:
            at = float(parts[0])
        except ValueError:
            continue
        frames.append({"at": at, "index": len(frames)})
    return frames


async def scene_in_window(
    path: str, start: float, end: float, threshold: float | None = None
) -> list[float]:
    span = max(0.1, end - start)
    level = SCENE_THRESHOLD if threshold is None else float(threshold)
    code, out, err = await _run(
        [
            FFMPEG, "-hide_banner", "-nostats", "-loglevel", "info",
            "-ss", f"{start:.3f}", "-t", f"{span:.3f}", "-i", path,
            "-an", "-vf", f"select='gt(scene,{level})',showinfo",
            "-f", "null", "-",
        ],
        120,
    )
    if code != 0:
        return []
    hits: list[float] = []
    # showinfo 走 stderr；只看 stdout 会永远拿不到切点
    for match in re.finditer(r"pts_time:([0-9.]+)", (out + err).decode("utf-8", "replace")):
        try:
            hits.append(start + float(match.group(1)))
        except ValueError:
            continue
    return hits


def suspicious_windows(
    keyframes: list[dict[str, Any]], duration: float
) -> list[tuple[float, float]]:
    if not keyframes:
        return []
    windows: list[tuple[float, float]] = []
    times = [k["at"] for k in keyframes] + [max(duration, keyframes[-1]["at"] + 3.0)]
    gaps: list[tuple[float, float, float]] = []
    for left, right in zip(times, times[1:]):
        gap = right - left
        if gap >= 3.0:
            gaps.append((gap, left, right))
    gaps.sort(key=lambda item: item[0], reverse=True)
    # 取最大的若干 GOP 窗口，再按时间顺序扫描：这样场景配额能铺在整段视频上，
    # 而不是被「最新几个窗口」吃掉（同 gap 时也优先更早的）。
    selected = gaps[: _opt()["maxRescueGop"]]
    selected.sort(key=lambda item: item[1])
    for _, left, right in selected:
        windows.append((left + 0.12, right - 0.12 if right - left > 1.0 else right))
    return windows


async def grab_frame(path: str, at: float, out_path: str, max_edge: int | None = None) -> bool:
    edge = _opt()["maxEdge"] if max_edge is None else int(max_edge)
    vf = []
    if edge > 0:
        # 长边封顶到 768，不放大：视觉 token 只跟像素有关，加密帧数不能顺带抬分辨率
        vf = [
            "-vf",
            f"scale='min({edge},iw)':'min({edge},ih)':force_original_aspect_ratio=decrease",
        ]
    code, _, _ = await _run(
        [
            FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
            "-ss", f"{max(0.0, at):.3f}", "-i", path,
            *vf,
            "-frames:v", "1", "-q:v", "3", out_path,
        ],
        60,
    )
    return code == 0 and os.path.isfile(out_path) and os.path.getsize(out_path) > 0


async def collect_frames(
    path: str,
    *,
    mode: str = "overview",
    start: float = 0.0,
    end: float | None = None,
    count: int = 0,
    outdir: str,
) -> dict[str, Any]:
    """抽帧。

    overview：count=0 时按时长分档取预算；count>0 只作为更小的上限。
    顺序是「场景 > 前段 > 关键帧 > 均匀刻度」：宁可少几个固定 tick，也要保住
    场景边界和前段信息密度；超出预算时按同样优先级从低到高丢。
    """
    info = await probe(path)
    duration = info["duration"]
    opt = _opt()
    if mode == "range":
        left = max(0.0, float(start or 0.0))
        right = duration if end is None else min(duration, float(end))
        if right <= left:
            right = min(duration, left + 1.0)
        count = max(1, min(int(count or 6), max_count()))
    else:
        left, right = 0.0, duration
        count = frame_budget(max(0.1, right - left), int(count or 0))

    os.makedirs(outdir, exist_ok=True)
    for name in os.listdir(outdir):
        if name.startswith("frame_"):
            try:
                os.remove(os.path.join(outdir, name))
            except OSError:
                pass

    picks: list[dict[str, Any]] = []
    span = max(0.1, right - left)

    def safe_at(value: float) -> float:
        return round(min(max(left, value), max(left, right - 0.15)), 3)

    def add_at(at: float, why: str, gap: float) -> bool:
        at = safe_at(at)
        if any(abs(at - p["at"]) < gap for p in picks):
            return False
        picks.append({"at": at, "why": why})
        return True

    if mode == "range":
        base = [left + span * index / max(1, count - 1) for index in range(count)]
        for at in base:
            picks.append({"at": safe_at(at), "why": "range"})
    else:
        keyframes = await keyframe_table(path)
        front_gap = min(0.35, opt["minGap"])
        # 1) 前段加密：0–frontWindow 秒用更密的固定刻度，这一段信息密度最高
        for at in opt["frontTicks"]:
            if at < left or at > right or at > opt["frontWindow"]:
                continue
            add_at(at, "front", front_gap)
        # 2) 场景切换优先：可疑 GOP 里抓切镜，最多 sceneQuota 个
        scene_quota = opt["sceneQuota"]
        scene_added = 0
        if scene_quota > 0:
            for win_left, win_right in suspicious_windows(keyframes, right):
                if scene_added >= scene_quota:
                    break
                if win_left >= right:
                    continue
                hits = await scene_in_window(
                    path, win_left, min(win_right, right), opt["sceneThreshold"]
                )
                for at in hits:
                    if add_at(at, "scene", opt["minGap"]):
                        scene_added += 1
                        if scene_added >= scene_quota:
                            break
        # 3) 关键帧均匀铺开（长视频不能只看开头），配额 keyframeQuota
        in_range = [key["at"] for key in keyframes if left <= key["at"] <= right]
        quota = opt["keyframeQuota"]
        if in_range and quota > 0:
            if len(in_range) <= quota:
                base_times = list(in_range)
            else:
                base_times = [
                    in_range[round(index * (len(in_range) - 1) / max(1, quota - 1))]
                    for index in range(quota)
                ]
            for at in base_times:
                add_at(at, "keyframe", opt["minGap"])
        # 4) 还不够预算就用均匀刻度补齐（只补空档，不硬塞）
        if len(picks) < count:
            steps = max(count * 4, 2)
            for index in range(steps):
                at = left + span * index / max(1, steps - 1)
                add_at(at, "tick", opt["minGap"])
                if len(picks) >= count:
                    break
        # 超预算：按 场景 > 前段 > 关键帧 > tick 保留，同优先级留更早的
        if len(picks) > count:
            order = {"scene": 0, "front": 1, "keyframe": 2, "tick": 3}
            picks.sort(key=lambda item: (order.get(item["why"], 9), item["at"]))
            picks = picks[:count]
        picks.sort(key=lambda item: item["at"])

    files: list[dict[str, Any]] = []
    for index, pick in enumerate(picks):
        out_path = os.path.join(outdir, f"frame_{index:02d}_{format_clock(pick['at']).replace(':', '-')}.jpg")
        if await grab_frame(path, pick["at"], out_path):
            files.append({"at": pick["at"], "path": out_path, "why": pick["why"]})
    return {"info": info, "frames": files}


async def extract_audio(path: str, outdir: str) -> str | None:
    os.makedirs(outdir, exist_ok=True)
    out_path = os.path.join(outdir, "audio.wav")
    code, _, _ = await _run(
        [
            FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
            "-i", path, "-vn", "-ac", "1", "-ar", "16000",
            "-c:a", "pcm_s16le", out_path,
        ],
        300,
    )
    if code != 0 or not os.path.isfile(out_path) or os.path.getsize(out_path) < 1024:
        return None
    return out_path


def _whisper_cmd() -> list[str] | None:
    exe = shutil.which("whisper")
    if exe:
        return [exe]
    python = shutil.which("python")
    if python:
        return [python, "-m", "whisper"]
    return None


async def transcribe_audio(path: str, *, timeout: float = 900.0, model: str | None = None) -> str:
    """本机 whisper 转写；同一时刻只跑一个，避免抢显存。"""
    cmd = _whisper_cmd()
    if cmd is None:
        raise VideoError("本机没有 whisper")
    outdir = Path(PERSONA_HOME) / "asr-transcripts"
    outdir.mkdir(parents=True, exist_ok=True)
    async with _TRANSCRIBE_LOCK:
        for name in ((model,) if model else ("small", "tiny")):
            try:
                code, _, err = await _run(
                    cmd
                    + [
                        path,
                        "--model", name,
                        "--language", "zh",
                        "--task", "transcribe",
                        "--output_format", "txt",
                        "--output_dir", str(outdir),
                        "--fp16", "False",
                    ],
                    timeout,
                )
            except VideoError as exc:
                log("warn", f"whisper({name}) 失败：{exc}")
                continue
            if code != 0:
                log("warn", f"whisper({name}) 退出码 {code}：{err.decode('utf-8', 'replace')[-300:]}")
                continue
            stem = Path(path).stem + ".txt"
            target = outdir / stem
            if target.is_file():
                text = target.read_text(encoding="utf-8", errors="replace").strip()
                if text:
                    return text
    raise VideoError("转写没有产出内容")


async def transcribe_video(path: str, *, timeout: float = 900.0) -> str:
    workdir = tempfile.mkdtemp(prefix="qqstt-")
    try:
        audio = await extract_audio(path, workdir)
        if audio is None:
            raise VideoError("这个视频没有可转写的音轨")
        return await transcribe_audio(audio, timeout=timeout)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
