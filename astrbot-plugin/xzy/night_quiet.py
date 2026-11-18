"""夜间静默窗口：23:30–06:00 内禁止长时间高负载任务。

目的：夜里不再把风扇拉起来。只做判定与留痕，不做调度；由调用方决定拦截/降级：

- `bili_proactive`：整轮主动刷跳过（含下载 / ASR / 逐帧视觉），窗口结束不补跑；
- `self_iter`：自迭代重活（自动 tick 与手动 propose）跳过，不补跑；
- `video`：窗口内超过 `longVideoSec` 的长视频只给 ffprobe 元数据，
  不抽帧、不转写、不做画面观察；秒级的单图描述不经过本模块，保持可用。

窗口跨零点按「start > end 表示跨天」处理：
`23:30:00` 算窗口内，`06:00:00` 算窗口外；`23:29:59` 与 `05:59:59` 分别在两端之内。
配置来自 xzy-config.json 的 `night_quiet` 段，默认启用，不写死在调用方。

阈值 300s（5 分钟）的理由：
- 与 video.frameTiers 已有的 300 秒分档边界一致，超过它帧预算与转写时长一起上一个台阶；
- whisper small 的实测 RTF≈0.42：5 分钟音频≈126s CPU，20 分钟≈504s；
  超过 5 分钟后 ASR 单项就持续占用两分钟以上，逐帧视觉调用还会叠加，
  正是夜间风扇被拉起来的主因；5 分钟以内的任务仍是一次有界负载。
"""

from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime, timedelta
from typing import Any

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_ROOT = os.path.abspath(os.path.join(PLUGIN_DIR, "..", ".."))
STATE_DIR = os.path.join(DATA_ROOT, "xzy")
AUDIT_DIR = os.path.join(STATE_DIR, "audit")
NIGHT_AUDIT_PATH = os.path.join(AUDIT_DIR, "night-quiet.jsonl")

DEFAULT_START = "23:30"
DEFAULT_END = "06:00"
DEFAULT_TIMEZONE = "Asia/Shanghai"
DEFAULT_LONG_VIDEO_SEC = 300
DEFAULT_AUDIT_COOLDOWN_SEC = 600

# task -> 中文名（只用于原因文案；不是开关）
TASK_LABELS = {
    "bili_proactive": "B站主动刷",
    "self_iter": "自迭代重活",
    "video": "长视频多帧分析",
}
BLOCK_TASKS = frozenset({"bili_proactive", "self_iter"})
KNOWN_TASKS = frozenset(TASK_LABELS)

CFG: dict[str, Any] = {}
_TZ_CACHE: dict[str, Any] = {}
_WARNED: set[str] = set()
# audit key -> [last_ts, suppressed_count]
_AUDIT_LAST: dict[str, list[float]] = {}

_HM_RE = re.compile(r"^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$")


def configure(cfg: dict[str, Any]) -> None:
    """由宿主整合方传入整份插件配置（与 self_iter.configure 同口径）。"""
    raw = cfg.get("night_quiet") if isinstance(cfg, dict) else {}
    CFG.clear()
    CFG.update(raw if isinstance(raw, dict) else {})
    _TZ_CACHE.clear()
    _WARNED.clear()
    _AUDIT_LAST.clear()


# --------------------------------------------------------------------------- #
# 配置归一化
# --------------------------------------------------------------------------- #
def _int(value: Any, default: int, low: int, high: int) -> int:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return default
    return max(low, min(high, parsed))


def _strict_hm(value: Any) -> tuple[int, str] | None:
    match = _HM_RE.match(str(value or ""))
    if not match:
        return None
    hour = int(match.group(1))
    minute = int(match.group(2))
    second = int(match.group(3) or 0)
    if hour > 23 or minute > 59 or second > 59:
        return None
    label = f"{hour:02d}:{minute:02d}" + (f":{second:02d}" if second else "")
    return hour * 3600 + minute * 60 + second, label


def _window_cfg() -> dict[str, Any]:
    raw_start = CFG.get("start")
    raw_end = CFG.get("end")
    start = _strict_hm(raw_start) or _strict_hm(DEFAULT_START)
    end = _strict_hm(raw_end) or _strict_hm(DEFAULT_END)
    if start is None or end is None:  # 默认值本身写错才会到这里
        start, end = (23 * 3600 + 30 * 60, DEFAULT_START), (6 * 3600, DEFAULT_END)
    if raw_start not in (None, "") and _strict_hm(raw_start) is None:
        _warn_once("bad-start", f"night_quiet.start={raw_start!r} 不合法，回退 {DEFAULT_START}")
    if raw_end not in (None, "") and _strict_hm(raw_end) is None:
        _warn_once("bad-end", f"night_quiet.end={raw_end!r} 不合法，回退 {DEFAULT_END}")
    timezone = str(CFG.get("timezone") or DEFAULT_TIMEZONE).strip() or DEFAULT_TIMEZONE
    return {
        "enabled": CFG.get("enabled") is not False,
        "start": start[1],
        "end": end[1],
        "startSec": float(start[0]),
        "endSec": float(end[0]),
        "timezone": timezone,
        "longVideoSec": _int(CFG.get("longVideoSec"), DEFAULT_LONG_VIDEO_SEC, 30, 6 * 3600),
        "auditCooldownSec": _int(
            CFG.get("auditCooldownSec"), DEFAULT_AUDIT_COOLDOWN_SEC, 0, 86400
        ),
    }


def _tz():
    name = str(CFG.get("timezone") or DEFAULT_TIMEZONE).strip() or DEFAULT_TIMEZONE
    cached = _TZ_CACHE.get(name)
    if cached is not None:
        return cached
    try:
        from zoneinfo import ZoneInfo

        tz = ZoneInfo(name)
    except Exception:  # noqa: BLE001 - Windows 上缺 tzdata 时回退系统时区
        tz = datetime.now().astimezone().tzinfo
        _warn_once(f"tz:{name}", f"时区 {name} 不可用，回退到系统本地时区")
    _TZ_CACHE[name] = tz
    return tz


def now_local(now: Any = None) -> datetime:
    """now 可为 None / 时间戳 / datetime；统一换算到配置时区。"""
    tz = _tz()
    if now is None:
        return datetime.now(tz)
    if isinstance(now, datetime):
        return now.astimezone(tz) if now.tzinfo is not None else now.replace(tzinfo=tz)
    try:
        return datetime.fromtimestamp(float(now), tz)
    except (TypeError, ValueError, OSError):
        return datetime.now(tz)


def _inside(dt: datetime, window: dict[str, Any]) -> bool:
    if not window["enabled"]:
        return False
    second = dt.hour * 3600 + dt.minute * 60 + dt.second + dt.microsecond / 1_000_000
    start, end = window["startSec"], window["endSec"]
    if start == end:
        return False  # 起止相同视为空窗口，不把整天静默掉
    if start < end:
        return start <= second < end
    # 跨零点：23:30–06:00 是同一段，23:30 之后或 06:00 之前都算
    return second >= start or second < end


def window_label() -> str:
    window = _window_cfg()
    return f"{window['start']}–{window['end']}（{window['timezone']}）"


def long_video_seconds() -> int:
    return _window_cfg()["longVideoSec"]


def in_window(now: Any = None) -> bool:
    return _inside(now_local(now), _window_cfg())


def evaluate(task: str, *, duration_sec: Any = None, now: Any = None) -> dict[str, Any]:
    """判定一次任务该放行还是拦截/降级；纯函数，不写盘。

    task:
      - bili_proactive / self_iter：窗口内 block；
      - video：窗口内且 duration_sec > longVideoSec 时 degrade（只给元数据）；
      - 其他/未知：一律 allow（本模块只领域长任务，不做全局闸）。
    """
    window = _window_cfg()
    dt = now_local(now)
    inside = _inside(dt, window)
    label = f"{window['start']}–{window['end']}（{window['timezone']}）"
    duration: float | None = None
    if duration_sec is not None:
        try:
            duration = max(0.0, float(duration_sec))
        except (TypeError, ValueError):
            duration = None

    action = "allow"
    reason = ""
    if inside and task in BLOCK_TASKS:
        action = "block"
        reason = f"夜间静默窗口 {label} 内不跑{TASK_LABELS.get(task, task)}"
    elif inside and task == "video" and duration is not None:
        threshold = window["longVideoSec"]
        if duration > threshold:
            action = "degrade"
            reason = (
                f"夜间静默窗口 {label} 内不做超过 {threshold // 60} 分钟视频的"
                f"多帧视觉/转写（这条 {duration / 60:.1f} 分钟），只给 ffprobe 元数据"
            )

    return {
        "action": action,
        "blocked": action == "block",
        "degraded": action == "degrade",
        "task": task,
        "taskLabel": TASK_LABELS.get(task, task),
        "reason": reason,
        "enabled": window["enabled"],
        "inWindow": inside,
        "window": {
            "start": window["start"],
            "end": window["end"],
            "timezone": window["timezone"],
        },
        "localAt": dt.isoformat(),
        "durationSec": duration,
        "thresholdSec": window["longVideoSec"],
    }


# --------------------------------------------------------------------------- #
# 留痕：默认写 audit/night-quiet.jsonl，同一 caller 的同类拒绝按冷却合并
# --------------------------------------------------------------------------- #
def record(
    decision: dict[str, Any],
    *,
    caller: str = "",
    extra: dict[str, Any] | None = None,
    path: str | None = None,
) -> bool:
    """把 block/degrade 写进审计；被冷却合并时返回 False（内存里累计 suppressed）。"""
    if not isinstance(decision, dict):
        return False
    action = str(decision.get("action") or "allow")
    if action not in ("block", "degrade"):
        return False
    window = _window_cfg()
    key = f"{action}|{decision.get('task')}|{caller}"
    now_ts = time.time()
    last = _AUDIT_LAST.get(key)
    if last and window["auditCooldownSec"] > 0 and now_ts - last[0] < window["auditCooldownSec"]:
        last[1] += 1
        return False
    suppressed = int(last[1]) if last else 0
    _AUDIT_LAST[key] = [now_ts, 0]

    row = {
        "kind": "night-quiet",
        "action": action,
        "task": decision.get("task"),
        "reason": decision.get("reason"),
        "window": decision.get("window"),
        "localAt": decision.get("localAt"),
        "wall": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "durationSec": decision.get("durationSec"),
        "thresholdSec": decision.get("thresholdSec"),
        "caller": caller,
        "suppressed": suppressed,
        "extra": extra or {},
    }
    target = path or NIGHT_AUDIT_PATH
    try:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            f.flush()
    except OSError as exc:
        _warn(f"夜间静默审计写入失败：{exc}")
        return False
    return True


def status() -> dict[str, Any]:
    window = _window_cfg()
    dt = now_local()
    return {
        "enabled": window["enabled"],
        "start": window["start"],
        "end": window["end"],
        "timezone": window["timezone"],
        "longVideoSec": window["longVideoSec"],
        "auditCooldownSec": window["auditCooldownSec"],
        "windowLabel": f"{window['start']}–{window['end']}（{window['timezone']}）",
        "nowLocal": dt.isoformat(),
        "inWindow": _inside(dt, window),
        "auditPath": NIGHT_AUDIT_PATH,
    }


# --------------------------------------------------------------------------- #
# 日志
# --------------------------------------------------------------------------- #
def _warn(message: str) -> None:
    try:
        try:
            from .media_platform import log
        except ImportError:
            from media_platform import log  # type: ignore
        log("warn", f"[xzy] {message}")
        return
    except Exception:  # noqa: BLE001 - 独立运行时没有共享日志层
        pass
    try:
        print(f"[xzy] {message}")
    except Exception:
        pass


def _warn_once(key: str, message: str) -> None:
    if key in _WARNED:
        return
    _WARNED.add(key)
    _warn(message)


# --------------------------------------------------------------------------- #
# 离线用例：python night_quiet.py
# --------------------------------------------------------------------------- #
def _offline_selftest() -> int:
    import shutil
    import tempfile

    failures: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"{'PASS' if ok else 'FAIL'} {name}" + (f" — {detail}" if detail and not ok else ""))
        if not ok:
            failures.append(name)

    def at(hour: int, minute: int, second: int = 0, day: int = 17) -> datetime:
        return datetime(2026, 11, day, hour, minute, second, tzinfo=_tz())

    base = {
        "enabled": True,
        "start": "23:30",
        "end": "06:00",
        "timezone": "Asia/Shanghai",
        "longVideoSec": 300,
        "auditCooldownSec": 600,
    }
    configure({"night_quiet": dict(base)})
    print(f"窗口: {window_label()} 当前 inWindow={in_window(at(0, 0))}")

    def action(task: str, moment: datetime, duration: float | None = None) -> str:
        decision = evaluate(task, duration_sec=duration, now=moment)
        return decision["action"]

    # 开关打开：窗口内拦截、窗口外放行
    check("23:29:59 窗口外放行", action("bili_proactive", at(23, 29, 59)) == "allow")
    check("23:30:00 窗口内拦截", action("bili_proactive", at(23, 30, 0)) == "block")
    check("23:45:00 窗口内拦截", action("bili_proactive", at(23, 45, 0)) == "block")
    check("00:00:00 跨零点仍拦截", action("bili_proactive", at(0, 0, 0, day=18)) == "block")
    check("05:59:59 窗口内拦截", action("bili_proactive", at(5, 59, 59, day=18)) == "block")
    check("06:00:00 窗口外放行", action("bili_proactive", at(6, 0, 0, day=18)) == "allow")
    check("12:00:00 窗口外放行", action("self_iter", at(12, 0, 0)) == "allow")
    check("23:30:00 自迭代拦截", action("self_iter", at(23, 30, 0)) == "block")

    # 长视频阈值：≤300s 放行，>300s 降级
    check("窗口内 300s 视频放行", action("video", at(0, 10), duration=300) == "allow")
    check("窗口内 301s 视频降级", action("video", at(0, 10), duration=301) == "degrade")
    check("窗口内 20 分钟视频降级", action("video", at(5, 59, 59, day=18), duration=1200) == "degrade")
    check("窗口外 20 分钟视频放行", action("video", at(12, 0), duration=1200) == "allow")
    check("06:00:00 长视频放行", action("video", at(6, 0, 0, day=18), duration=1200) == "allow")

    # 跨零点连续：23:30 → 次日 06:00 每分钟都在窗口内；06:00 → 23:30 都不在
    bad: list[str] = []
    cursor = at(23, 30)
    stop = at(6, 0, day=18)
    while cursor < stop:
        if action("bili_proactive", cursor) != "block":
            bad.append(cursor.isoformat())
        cursor += timedelta(minutes=1)
    check("跨零点 23:30→06:00 连续拦截", not bad, f"漏放 {bad[:3]}")
    bad = []
    cursor = at(6, 0, day=18)
    stop = at(23, 30, day=18)
    while cursor < stop:
        if action("bili_proactive", cursor) != "allow":
            bad.append(cursor.isoformat())
        cursor += timedelta(minutes=1)
    check("06:00→23:30 连续放行", not bad, f"误拦 {bad[:3]}")

    # 开关关闭：全部放行，in_window 恒为 false
    configure({"night_quiet": {**base, "enabled": False}})
    check("关闭后 23:45 主动刷放行", action("bili_proactive", at(23, 45)) == "allow")
    check("关闭后 23:45 自迭代放行", action("self_iter", at(23, 45)) == "allow")
    check("关闭后 23:45 长视频放行", action("video", at(23, 45), duration=1200) == "allow")
    check("关闭后 in_window=false", in_window(at(23, 45)) is False)
    check("关闭后 evaluate.inWindow=false", evaluate("bili_proactive", now=at(23, 45))["inWindow"] is False)

    # 非法配置回退默认 23:30–06:00
    configure({"night_quiet": {**base, "start": "25:00"}})
    check("start 非法回退 23:30", action("bili_proactive", at(23, 30)) == "block")

    # 留痕：同一 caller 在冷却内合并，冷却归零后再次落盘
    configure({"night_quiet": dict(base)})
    root = tempfile.mkdtemp(prefix="night-quiet-selftest-")
    audit = os.path.join(root, "night-quiet.jsonl")
    try:
        decision = evaluate("bili_proactive", now=at(23, 45))
        wrote1 = record(decision, caller="selftest", path=audit)
        wrote2 = record(decision, caller="selftest", path=audit)
        with open(audit, encoding="utf-8") as f:
            lines = [line for line in f if line.strip()]
        check("首次拦截落盘", wrote1 is True and len(lines) == 1, f"lines={len(lines)}")
        check("冷却内合并不重复落盘", wrote2 is False and len(lines) == 1, f"lines={len(lines)}")
        configure({"night_quiet": {**base, "auditCooldownSec": 0}})
        wrote3 = record(decision, caller="selftest", path=audit)
        with open(audit, encoding="utf-8") as f:
            lines = [line for line in f if line.strip()]
        check("冷却归零后再次落盘", wrote3 is True and len(lines) == 2, f"lines={len(lines)}")
        check("放行不落盘", record(evaluate("video", duration_sec=60, now=at(23, 45)), caller="selftest", path=audit) is False)
    finally:
        shutil.rmtree(root, ignore_errors=True)

    configure({"night_quiet": dict(base)})
    print("")
    if failures:
        print(f"失败 {len(failures)} 项：{failures}")
        return 1
    print("全部用例通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(_offline_selftest())
