"""B 站主动刷（插件侧）：旧栈 qq-persona/bili-proactive.mjs 的 Python 版。

与旧栈一致的部分：30 分钟间隔、每小时 ≤2 条、视觉队列安静期、按会话每日分享配额、
同视频全局只提一次、热门池按 UP/标题权重排序选片、看片复用 media_bili.watch、
看完内容才分享。

与旧栈不同的部分：空闲判据不再打 `127.0.0.1:1240` 的队列接口（proxy 已停用），
改用本机回合台账（`audit/inbound|turns|outbound.jsonl` 的 `wall_ms` 尾部最大值），
与自迭代 `self_iter.auto_gate` 使用同一套口径（`self_iter._tail_ms` +
`self_iter.AUTO_ACTIVITY_FILES`）。

只在本进程内跑（AstrBot initialize 拉起），开关在 xzy-config.json 的
`bili_proactive.enabled`，默认关。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

try:
    from . import media_bili as mb
    from . import night_quiet
    from . import self_iter
    from . import self_iter_store as store
    from .media_platform import (
        PERSONA_HOME,
        append_jsonl,
        engine_ready,
        log,
        read_json,
        write_json_atomic,
    )
except ImportError:  # AstrBot 以模块方式加载时走这里
    import media_bili as mb  # type: ignore
    import night_quiet  # type: ignore
    import self_iter  # type: ignore
    import self_iter_store as store  # type: ignore
    from media_platform import (  # type: ignore
        PERSONA_HOME,
        append_jsonl,
        engine_ready,
        log,
        read_json,
        write_json_atomic,
    )

# 看片失败后的退避：首次 10 分钟，连续失败翻倍，封顶 60 分钟
FAIL_BACKOFF_BASE_SEC = 600
FAIL_BACKOFF_MAX_SEC = 3600

# 观测量 / 配额沿用旧栈 bili-proactive.mjs 的默认值
DEFAULT_TARGETS = [
    {"kind": "group", "id": "100000004", "name": "AIVC（学生自发团队）", "perDay": 1},
    {"kind": "group", "id": "100000001", "name": "商用大肥鱼交流群", "perDay": 0},
    {"kind": "private", "id": "10000", "name": "主人", "perDay": 1},
]
HISTORY_VIDEOS_LIMIT = 300

STATE_PATH = Path(
    os.environ.get("XZY_BILI_PROACTIVE_STATE") or str(PERSONA_HOME / "bili-proactive.json")
)
LOG_PATH = Path(
    os.environ.get("XZY_BILI_PROACTIVE_LOG") or str(PERSONA_HOME / "bili-proactive.jsonl")
)
_AUDIT_DIR = os.environ.get("XZY_AUDIT_DIR") or os.path.join(store.STATE_DIR, "audit")
VISION_STATE_PATH = os.environ.get("XZY_VISION_STATE") or os.path.join(
    store.STATE_DIR, "vision-state.json"
)

CFG: dict[str, Any] = {}
_SENDER: Callable[[str, str], Awaitable[bool]] | None = None
_RUNNING = False
_DEGRADE_NOTE = re.compile(r"^（UP 没提供[\s\S]*）$")


# --------------------------------------------------------------------------- #
# 配置
# --------------------------------------------------------------------------- #
def configure(cfg: Any, sender: Callable[[str, str], Awaitable[bool]] | None = None) -> None:
    """注入运行配置与发送器（发送器由 main.py 提供：umo + 纯文本 -> 是否发出）。"""
    global CFG, _SENDER
    CFG = cfg if isinstance(cfg, dict) else {}
    if sender is not None:
        _SENDER = sender


def _int(value: Any, default: int, low: int, high: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, number))


def share_targets(source: dict[str, Any]) -> list[dict[str, Any]]:
    raw = source.get("targets")
    rows = raw if isinstance(raw, list) and raw else DEFAULT_TARGETS
    out: list[dict[str, Any]] = []
    for item in rows:
        if not isinstance(item, dict):
            continue
        kind = "private" if item.get("kind") == "private" else "group"
        ident = str(item.get("id") or "").strip()
        if not re.fullmatch(r"\d{5,12}", ident):
            continue
        out.append(
            {
                "kind": kind,
                "id": ident,
                "name": str(item.get("name") or ""),
                "perDay": max(0, _int(item.get("perDay"), 0, 0, 999)),
            }
        )
    return out


def config() -> dict[str, Any]:
    raw = CFG.get("bili_proactive")
    source = raw if isinstance(raw, dict) else {}
    return {
        "enabled": source.get("enabled") is True,
        "pollSeconds": _int(source.get("pollSeconds"), 60, 30, 900),
        "idleMinutes": _int(source.get("idleMinutes"), 10, 1, 180),
        "minGapMinutes": _int(source.get("minGapMinutes"), 30, 5, 24 * 60),
        "maxPerHour": _int(source.get("maxPerHour"), 2, 1, 12),
        "visionQuietSeconds": _int(source.get("visionQuietSeconds"), 30, 0, 3600),
        # 主动看片只当「够看清讲什么」，16 帧封顶；media_bili 还会再按 video.hardCap 压一次
        "maxFrames": _int(source.get("maxFrames"), 16, 1, 24),
        "platform": str(source.get("platform") or "").strip(),
        "targets": share_targets(source),
    }


# --------------------------------------------------------------------------- #
# 状态与日志
# --------------------------------------------------------------------------- #
def _today() -> str:
    return time.strftime("%Y-%m-%d", time.localtime())


def _utc_iso() -> str:
    """真实 UTC 时间戳（与旧栈 toISOString 同口径），供间隔/每小时配额回算。"""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def read_state() -> dict[str, Any]:
    parsed = read_json(STATE_PATH, {})
    parsed = parsed if isinstance(parsed, dict) else {}
    shares = parsed.get("shares") if isinstance(parsed.get("shares"), dict) else {}
    state: dict[str, Any] = {
        "day": str(parsed.get("day") or ""),
        "count": _int(parsed.get("count"), 0, 0, 10**6),
        "bytes": _int(parsed.get("bytes"), 0, 0, 10**12),
        "totalMs": _int(parsed.get("totalMs"), 0, 0, 10**12),
        "hourly": [str(item) for item in (parsed.get("hourly") or []) if isinstance(item, str)],
        "lastAt": str(parsed.get("lastAt") or ""),
        "lastRun": parsed.get("lastRun"),
        "lastAbort": parsed.get("lastAbort"),
        "lastGate": parsed.get("lastGate"),
        "lastShare": parsed.get("lastShare"),
        "lastShareTarget": str(parsed.get("lastShareTarget") or ""),
        "paused": parsed.get("paused") is True,
        "failStreak": _int(parsed.get("failStreak"), 0, 0, 100),
        "backoffUntil": str(parsed.get("backoffUntil") or ""),
        "shares": {
            "day": str(shares.get("day") or ""),
            "byChat": dict(shares.get("byChat") or {}),
            "videos": dict(shares.get("videos") or {}),
        },
    }
    if state["day"] != _today():
        state["day"] = _today()
        state["count"] = 0
        state["bytes"] = 0
        state["totalMs"] = 0
    if state["shares"]["day"] != _today():
        state["shares"]["day"] = _today()
        state["shares"]["byChat"] = {}
    return state


def write_state(state: dict[str, Any]) -> None:
    payload = {**state, "updatedAt": _utc_iso()}
    try:
        write_json_atomic(STATE_PATH, payload)
    except OSError as exc:
        log("warn", f"[xzy] B站主动刷状态写入失败：{exc}")


def _log_event(kind: str, **fields: Any) -> None:
    try:
        append_jsonl(LOG_PATH, {"ts": _utc_iso(), "kind": kind, **fields})
    except OSError as exc:
        log("warn", f"[xzy] B站主动刷日志写入失败：{exc}")


# --------------------------------------------------------------------------- #
# 闸门
# --------------------------------------------------------------------------- #
def last_activity_ms() -> int:
    """与本机回合台账同口径：inbound / turns / outbound 尾部最大 wall_ms。"""
    values = []
    for name in self_iter.AUTO_ACTIVITY_FILES:
        try:
            values.append(self_iter._tail_ms(name))
        except Exception:  # noqa: BLE001 - 台账读失败只当没活动
            values.append(0)
    return max(values) if values else 0


def vision_quiet(seconds: int) -> tuple[bool, str]:
    if seconds <= 0:
        return True, ""
    try:
        age = time.time() - os.path.getmtime(VISION_STATE_PATH)
    except OSError:
        # 从没打过标 = 安静（与旧栈一致）
        return True, ""
    if age < seconds:
        return False, f"视觉队列刚有活动（{int(age)}s 前）"
    return True, ""


def _iso_ms(value: Any) -> int:
    text = str(value or "").strip()
    if not text:
        return 0
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        from datetime import datetime

        return int(datetime.fromisoformat(text).timestamp() * 1000)
    except ValueError:
        return 0


def gate(*, force: bool = False, engine_ok: bool | None = None) -> dict[str, Any]:
    """开刷前闸门；force 只跳过「间隔 / 每小时配额」，负载与开关类一律不跳。

    engine_ok=False 时直接判不可用（调用方先探测后端），避免进入选片/下载；
    False 之外的 None 表示本次没探测（只在只读自检里出现）。
    """
    cfg = config()
    state = read_state()
    now = int(time.time() * 1000)
    reasons: list[str] = []
    if not cfg["enabled"]:
        reasons.append("主动刷未开启")
    if state["paused"]:
        reasons.append("主动刷已暂停")
    # 夜间静默：整轮跳过（含下载/ASR/逐帧视觉），force 也不放行；窗口结束不补跑
    if cfg["enabled"]:
        quiet = night_quiet.evaluate("bili_proactive")
        if quiet["blocked"]:
            reasons.append(quiet["reason"])
            night_quiet.record(quiet, caller="bili_proactive.gate")
    if engine_ok is False:
        reasons.append("视觉后端不可用（模型接口没就绪）")
    backoff_ms = _iso_ms(state["backoffUntil"])
    if backoff_ms > now:
        left = (backoff_ms - now + 59_999) // 60_000
        reasons.append(f"上次看片失败，退避中（还要 {left} 分钟）")
    activity = last_activity_ms()
    idle_ms = now - activity if activity > 0 else -1
    if activity <= 0:
        reasons.append("没有回合活动记录，无法确认空闲")
    elif idle_ms < cfg["idleMinutes"] * 60_000:
        reasons.append(
            f"最近 {cfg['idleMinutes']} 分钟内还有对话"
            f"（已闲置 {max(0, idle_ms) // 60_000} 分钟）"
        )
    quiet, quiet_reason = vision_quiet(cfg["visionQuietSeconds"])
    if not quiet:
        reasons.append(quiet_reason)
    last = _iso_ms(state["lastAt"])
    if not force and last > 0 and now - last < cfg["minGapMinutes"] * 60_000:
        left = (cfg["minGapMinutes"] * 60_000 - (now - last)) // 60_000 + 1
        reasons.append(f"距上次主动刷不足 {cfg['minGapMinutes']} 分钟（还要 {left} 分钟）")
    before = len(state["hourly"])
    state["hourly"] = [item for item in state["hourly"] if 0 <= now - _iso_ms(item) < 3600_000]
    pruned = len(state["hourly"]) != before
    if not force and len(state["hourly"]) >= cfg["maxPerHour"]:
        reasons.append(f"这一小时已经主动刷了 {len(state['hourly'])} 条")
    return {
        "ok": not reasons,
        "reasons": reasons,
        "state": state,
        "pruned": pruned,
        "idleMs": idle_ms,
        "hourly": len(state["hourly"]),
        "cfg": cfg,
    }


# --------------------------------------------------------------------------- #
# 目标会话与选片
# --------------------------------------------------------------------------- #
def _tail_rows(path: str, limit: int = 300) -> list[dict[str, Any]]:
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 131072))
            chunk = f.read()
    except OSError:
        return []
    rows: list[dict[str, Any]] = []
    for line in chunk.split(b"\n")[-limit:]:
        line = line.strip()
        if not line:
            continue
        try:
            value = json.loads(line.decode("utf-8", "replace"))
        except ValueError:
            continue
        if isinstance(value, dict):
            rows.append(value)
    return rows


def platform_id() -> str:
    cfg = config()
    if cfg["platform"]:
        return cfg["platform"]
    rows = _tail_rows(os.path.join(_AUDIT_DIR, "inbound.jsonl"))
    for row in reversed(rows):
        umo = str(row.get("umo") or "")
        if ":" in umo:
            return umo.split(":", 1)[0]
    return ""


def umo_of(target: dict[str, Any]) -> str:
    platform = platform_id()
    if not platform:
        return ""
    kind = "FriendMessage" if target["kind"] == "private" else "GroupMessage"
    return f"{platform}:{kind}:{target['id']}"


def chat_key_of(target: dict[str, Any]) -> str:
    return f"{target['kind']}:{target['id']}"


def _watched_bvids(state: dict[str, Any]) -> set[str]:
    watched = {str(key) for key in (state["shares"]["videos"] or {}) if key}
    bili_state = read_json(PERSONA_HOME / "bili-state.json", {})
    if isinstance(bili_state, dict):
        recent = bili_state.get("recent")
        rows = recent if isinstance(recent, list) else []
        for item in rows:
            if isinstance(item, dict) and item.get("bvid"):
                watched.add(str(item["bvid"]))
    return watched


async def choose_video(state: dict[str, Any], limit: int = 12) -> dict[str, Any] | None:
    """热门池按 UP/标题权重排序（media_bili.feed 内既有的 _score），排除看过的。"""
    data = await mb.feed("hot", "", limit)
    seen = _watched_bvids(state)
    for item in data.get("items") or []:
        bvid = str(item.get("bvid") or "")
        if bvid and bvid not in seen:
            return item
    return None


# --------------------------------------------------------------------------- #
# 分享
# --------------------------------------------------------------------------- #
def _strip_degrade(summary: str) -> str:
    text = str(summary or "").replace("\r\n", "\n")
    return "\n".join(
        line for line in text.split("\n") if not _DEGRADE_NOTE.match(line.strip())
    ).strip()


def build_share_text(manifest: dict[str, Any]) -> str:
    """优先用视频级总结；没有总结才退回画面描述（与旧栈 buildShareText 一致）。"""
    title = str(manifest.get("title") or "B 站视频").strip()
    summary = manifest.get("summary") or {}
    digest = _strip_degrade(str(summary.get("text") or "")) if summary.get("ok") is True else ""
    if digest:
        text = f"《{title}》\n{digest}"
        return text[:358] + "…" if len(text) > 360 else text
    seen: set[str] = set()
    lines: list[str] = []
    for item in manifest.get("captions") or []:
        caption = str((item or {}).get("caption") or "")
        clean = re.sub(r"\s+", " ", caption).strip()
        clean = re.sub(r"^(画面里|画面中|图中)", "", clean)
        clean = re.sub(r"[。；;]+$", "", clean)
        if not clean or clean in seen:
            continue
        seen.add(clean)
        lines.append(clean)
        if len(lines) >= 2:
            break
    if not lines:
        return ""
    body = "画面里" + lines[0] + ("；" + lines[1] if len(lines) > 1 else "")
    text = f"《{title}》值得看：{body}。"
    return text[:118] + "。" if len(text) > 120 else text


def pick_target(
    state: dict[str, Any], targets: list[dict[str, Any]], *, only: str = ""
) -> dict[str, Any] | None:
    """按上次分享目标轮转，AIVC / 大肥鱼 / 主人 都有机会；0 = 当天不限。"""
    eligible = []
    for target in targets:
        key = chat_key_of(target)
        if only and key != only:
            continue
        used = _int((state["shares"]["byChat"] or {}).get(key), 0, 0, 10**6)
        if target["perDay"] == 0 or used < target["perDay"]:
            eligible.append(target)
    if not eligible:
        return None
    order = [chat_key_of(item) for item in targets]
    last = state["lastShareTarget"]
    start = (order.index(last) + 1) % len(order) if last in order else 0
    rotated = targets[start:] + targets[:start]
    for target in rotated:
        if target in eligible:
            return target
    return None


async def share(
    state: dict[str, Any],
    manifest: dict[str, Any],
    *,
    only: str = "",
) -> dict[str, Any]:
    cfg = config()
    bvid = str(manifest.get("bvid") or "")
    title = str(manifest.get("title") or "")
    if not bvid:
        return {"ok": False, "reason": "没有 bvid"}
    if bvid in (state["shares"]["videos"] or {}):
        return {"ok": False, "reason": "同一视频已经主动分享过（全局只提一次）"}
    text = build_share_text(manifest)
    if not text:
        return {"ok": False, "reason": "既没有总结也没有画面描述，不发"}
    target = pick_target(state, cfg["targets"], only=only)
    if target is None:
        return {"ok": False, "reason": "没有可用分享目标（配额用完或目标不可用）"}
    umo = umo_of(target)
    if not umo:
        return {"ok": False, "reason": "认不出平台实例，无法定位会话"}
    if _SENDER is None:
        return {"ok": False, "reason": "发送器未注册"}
    try:
        ok = bool(await _SENDER(umo, text))
    except Exception as exc:  # noqa: BLE001 - 发送失败不炸定时器
        _log_event("share-fail", bvid=bvid, title=title, target=chat_key_of(target), error=str(exc)[:200])
        return {"ok": False, "reason": f"发送失败：{str(exc)[:120]}"}
    stamp = _utc_iso()
    key = chat_key_of(target)
    state["shares"]["videos"][bvid] = {"at": stamp, "chat": key, "name": target["name"]}
    state["shares"]["byChat"][key] = _int(state["shares"]["byChat"].get(key), 0, 0, 10**6) + 1
    state["lastShareTarget"] = key
    state["lastShare"] = {
        "at": stamp,
        "bvid": bvid,
        "title": title,
        "target": key,
        "name": target["name"],
        "text": text,
        "ok": ok,
    }
    videos = list((state["shares"]["videos"] or {}).items())
    if len(videos) > HISTORY_VIDEOS_LIMIT:
        state["shares"]["videos"] = dict(videos[-HISTORY_VIDEOS_LIMIT:])
    _log_event("share-done" if ok else "share-fail", bvid=bvid, title=title, target=key, chars=len(text))
    return {"ok": ok, "target": key, "name": target["name"], "text": text}


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
async def run_once(*, force: bool = False) -> dict[str, Any]:
    global _RUNNING
    if _RUNNING:
        return {"ok": False, "ran": False, "reason": "已经有一次主动刷在跑"}
    _RUNNING = True
    try:
        engine_ok = await engine_ready(timeout=2.0)
        checked = gate(force=force, engine_ok=engine_ok)
        state = checked["state"]
        cfg = checked["cfg"]
        if not checked["ok"]:
            reason = "；".join(checked["reasons"])
            changed = str((state.get("lastGate") or {}).get("reason") or "") != reason
            state["lastGate"] = {"at": _utc_iso(), "reason": reason, "ok": False}
            if changed or checked["pruned"]:
                write_state(state)
            if changed and cfg["enabled"]:
                _log_event("gate-block", reasons=checked["reasons"])
                log("info", f"[xzy] B站主动刷跳过：{reason}")
            return {"ok": False, "ran": False, "reason": reason, "reasons": checked["reasons"]}

        video = await choose_video(state)
        if video is None:
            state["lastGate"] = {"at": _utc_iso(), "reason": "热门池没有可选的视频", "ok": False}
            write_state(state)
            _log_event("pick-empty")
            return {"ok": False, "ran": False, "reason": "热门池没有可选的视频"}
        _log_event(
            "pick",
            bvid=video.get("bvid"),
            title=video.get("title"),
            owner=video.get("owner"),
            duration=video.get("duration"),
        )

        try:
            manifest = await mb.watch(
                str(video["bvid"]),
                max_frames=cfg["maxFrames"],
                observe=True,
                reason="主动刷（插件侧调度）",
            )
        except Exception as exc:  # noqa: BLE001 - 看片失败只记一条，不重试
            state = read_state()
            streak = _int(state.get("failStreak"), 0, 0, 100) + 1
            delay = min(
                FAIL_BACKOFF_MAX_SEC,
                FAIL_BACKOFF_BASE_SEC * (2 ** (min(streak, 8) - 1)),
            )
            state["failStreak"] = streak
            state["backoffUntil"] = time.strftime(
                "%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + delay)
            )
            state["lastAbort"] = {
                "at": _utc_iso(),
                "reason": str(exc)[:200],
                "where": "watch",
                "bvid": str(video.get("bvid") or ""),
                "title": str(video.get("title") or ""),
                "failStreak": streak,
                "backoffSec": delay,
            }
            write_state(state)
            _log_event(
                "watch-fail",
                bvid=video.get("bvid"),
                error=str(exc)[:200],
                failStreak=streak,
                backoffSec=delay,
            )
            return {"ok": False, "ran": False, "reason": f"看片失败：{str(exc)[:160]}"}

        # 兜底：看片过程中刚好进入夜间静默窗口时只拿到了元数据，不能当成本次刷成功去分享
        if manifest.get("nightQuiet"):
            _log_event(
                "night-quiet",
                bvid=manifest.get("bvid"),
                title=manifest.get("title"),
                reason="夜间静默窗口，跳过分享",
            )
            return {"ok": True, "ran": False, "reason": "夜间静默窗口，已跳过"}

        stamp = _utc_iso()
        state["failStreak"] = 0
        state["backoffUntil"] = ""
        state["count"] += 1
        state["bytes"] += _int(manifest.get("videoBytes"), 0, 0, 10**12)
        state["totalMs"] += _int((manifest.get("timing") or {}).get("total"), 0, 0, 10**12)
        state["lastAt"] = stamp
        state["hourly"] = [*state["hourly"], stamp][-24:]
        state["lastRun"] = {
            "at": stamp,
            "bvid": manifest.get("bvid"),
            "title": manifest.get("title"),
            "owner": manifest.get("owner"),
            "bytes": _int(manifest.get("videoBytes"), 0, 0, 10**12),
            "totalMs": _int((manifest.get("timing") or {}).get("total"), 0, 0, 10**12),
            "frames": len(manifest.get("frames") or []),
            "summarySource": (manifest.get("summary") or {}).get("source"),
            "summaryChars": (manifest.get("summary") or {}).get("chars"),
        }
        state["lastGate"] = {"at": stamp, "reason": "", "ok": True}
        write_state(state)
        _log_event(
            "watched",
            bvid=manifest.get("bvid"),
            title=manifest.get("title"),
            frames=len(manifest.get("frames") or []),
            summarySource=(manifest.get("summary") or {}).get("source"),
        )

        # 看完再确认一次「没人用」：打标/下载期间有人开口就不在这个节骨眼上分享。
        after = gate(force=True)
        if not after["ok"]:
            _log_event(
                "share-skip",
                bvid=manifest.get("bvid"),
                reason="看完后有人在使用：" + "；".join(after["reasons"]),
            )
            return {"ok": True, "ran": True, "title": manifest.get("title"), "share": None}

        result = await share(state, manifest)
        write_state(state)
        _log_event(
            "share-done" if result.get("ok") else "share-skip",
            bvid=manifest.get("bvid"),
            target=result.get("target"),
            reason=result.get("reason", ""),
        )
        return {"ok": True, "ran": True, "title": manifest.get("title"), "share": result}
    finally:
        _RUNNING = False


async def run_loop() -> None:
    """进程内 60s 轮询；到点只问一次 run_once()，真正决定刷不刷的是 gate()。"""
    await asyncio.sleep(20)
    while True:
        cfg = config()
        try:
            if cfg["enabled"]:
                out = await run_once()
                if out.get("ran"):
                    log(
                        "info",
                        f"[xzy] B站主动刷完成：{out.get('title')} "
                        f"分享={out.get('share')}",
                    )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - 定时器不能因单次失败退出
            log("warn", f"[xzy] B站主动刷失败：{exc}")
        await asyncio.sleep(max(30, cfg["pollSeconds"]))


def status() -> dict[str, Any]:
    """只读快照，供重载后自检/回报参数。"""
    cfg = config()
    state = read_state()
    return {
        "enabled": cfg["enabled"],
        "paused": state["paused"],
        "pollSeconds": cfg["pollSeconds"],
        "idleMinutes": cfg["idleMinutes"],
        "minGapMinutes": cfg["minGapMinutes"],
        "maxPerHour": cfg["maxPerHour"],
        "visionQuietSeconds": cfg["visionQuietSeconds"],
        "maxFrames": cfg["maxFrames"],
        "platform": platform_id(),
        "targets": [
            {
                **target,
                "usedToday": _int((state["shares"]["byChat"] or {}).get(chat_key_of(target)), 0, 0, 10**6),
            }
            for target in cfg["targets"]
        ],
        "today": {"count": state["count"], "bytes": state["bytes"], "totalMs": state["totalMs"]},
        "hourly": len(state["hourly"]),
        "lastRun": state["lastRun"],
        "lastGate": state["lastGate"],
        "lastShare": state["lastShare"],
        "failStreak": state["failStreak"],
        "backoffUntil": state["backoffUntil"],
        "statePath": str(STATE_PATH),
        "logPath": str(LOG_PATH),
        "watchedVideos": len(state["shares"]["videos"]),
    }
