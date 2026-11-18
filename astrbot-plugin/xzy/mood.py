"""心情 + 按人独立耐心（旧 `Y:\\dsh\\home\\qq-persona\\presence.mjs` 语义的独立迁移）。

两个独立维度，不合并成一个值
- 心情：全局 `mood` 标签 + `moodLevel` 连续值（50 中性，半衰期 3h 回归）；
- 耐心：`patienceByActor` 按人独立（群聊 `chatId:userId`、私聊 `userId`），
  任意交互按 `INTERACTION_COSTS` 折算增减，0→100 线性回满用 5 分钟。

旧语义保留
- 负向交互乘角色耐受度（master 0.6 / admin 0.8 / member 1.0），
  同一人 8 分钟内的负向交互按 1+0.6n 叠加（封顶 4 倍）；不同人互不牵连；
- 心情反向影响耐心消耗速度（annoyed ×1.3 / tired ×1.2 / excited ×0.9）；
- 耐心 <25 额外拖累 moodLevel，<30 转 annoyed、≥55 从 annoyed 回落 calm；
- 离线 ≥6h 硬重置；耐心只影响语气和长短，绝不作为「不回」的理由。

持久化（保留旧栈已修的坑）
- schema 与旧 `presence.json` 完全一致（`version=1` + 同字段名），旧栈可直接读，便于回滚；
- 就地覆盖 + flush + fsync，写前把上一份好状态留成 `.bak`；
- 主文件读失败回退 `.bak`，两者都坏才按默认状态初始化，并 `logger.error` 记录；
- 首次启动插件侧文件不存在时，可从旧 `presence-state.json` / `presence.json` 导入。

兼容旧键位：旧列用 `group:<gid>:<uid>`，新插件 `chat_id` 是裸群号，键为 `<gid>:<uid>`。
读取/更新时会自动认领已存在的旧键，不新造重复 actor；写入仍保留旧键名，回滚不改语义。

接线（`main.py` 等对其它 worker 只读，交给整合方合并）
- 导入：`from .mood import MoodStore`（`main.py` 的 try/except 两条导入都换成这个）；
- 初始化：`self.presence = MoodStore(PRESENCE_JSON)`，首次启动插件侧文件不存在时自动
  从 `E:/Bonsai/astrbot-eval/inst/data/xzy/persona/presence-state.json` 导入（旧栈副本已迁移），旧文件本身不动；
- 入站：`self.presence.note_interaction({"kind": ..., "userId": ..., "chatId": ...,
  "role": ...})`；`kind` 用 message/attention/followup/task/poke/interrupt/lateNight/
  praise/flow，深夜可附 `lateNight=True`；
- 系统提示：`self.presence.prompt_line(self._actor_key(event))`（`_actor_key` 给
  `gid:uid` 即可，旧键由本模块别名认领）。
"""

from __future__ import annotations

import json
import logging
import math
import os
import time
from typing import Any, Callable

try:  # venv 直调 / 非插件环境也能单测
    from astrbot.api import logger
except Exception:  # noqa: BLE001
    logger = logging.getLogger("xzy.mood")

MOODS = ("calm", "excited", "tired", "annoyed")
PRESENCE_EVENTS = (
    "praised",
    "scolded",
    "ignored",
    "topicHit",
    "addressed",
    "silence",
    "lateNight",
)

PRESENCE_DEFAULTS: dict[str, Any] = {
    "mood": "calm",
    "focus": 60,
    "heat": 30,
    "moodLevel": 50,
    "patienceByActor": {},
    "lastActorKey": "",
    "moodUntil": None,
    "ignoredStreak": 0,
    "lastLateNightAt": 0,
}

# 交互负担：任意交互都折算成耐心增减，poke 只是其中一种。
INTERACTION_COSTS: dict[str, dict[str, int]] = {
    "message": {"patience": -2, "heat": 1},
    "attention": {"patience": -5, "heat": 2},
    "followup": {"patience": -4},
    "task": {"patience": -8, "focus": -4},
    "poke": {"patience": -6},
    "interrupt": {"patience": -7},
    "lateNight": {"patience": -5},
    "praise": {"patience": 10, "heat": 4, "mood": 8},
    "flow": {"patience": 4, "heat": 2, "mood": 4},
}

MINUTE = 60_000
HOUR = 60 * MINUTE
PATIENCE_MAX = 100
PATIENCE_RECOVER_MS = 5 * MINUTE
MOOD_BASELINE = 50
MOOD_LEVEL_HALF_LIFE_MS = 3 * HOUR
MOOD_PACE = {"annoyed": 1.3, "tired": 1.2, "excited": 0.9}
REPEAT_WINDOW_MS = 8 * MINUTE
ACTS_TTL_MS = 30 * MINUTE
ACTS_MAX = 40
ROLE_PROFILE = {
    "master": {"initial": 100, "cost": 0.6},
    "admin": {"initial": 95, "cost": 0.8},
    "member": {"initial": 90, "cost": 1.0},
}
MOOD_TTL_MS = {
    "excited": 40 * MINUTE,
    "annoyed": 50 * MINUTE,
    "tired": 90 * MINUTE,
    "calm": 0,
}
OFFLINE_RESET_MS = 6 * HOUR

PERSONA_ROOT = os.environ.get("QQ_PERSONA_ROOT") or r"E:\Bonsai\astrbot-eval\inst\data\xzy\persona"
LEGACY_STATE_CANDIDATES = (
    os.path.join(PERSONA_ROOT, "presence-state.json"),
    os.path.join(PERSONA_ROOT, "presence.json"),
)


# --------------------------------------------------------------------------- #
# 纯逻辑：便于单测，不碰磁盘
# --------------------------------------------------------------------------- #
def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _clamp(value: Any, fallback: float = 0) -> int:
    number = _number(value)
    if number is None:
        return int(round(fallback))
    return int(min(100, max(0, round(number))))


def _stamp(value: Any, fallback: int) -> int:
    number = _number(value)
    return fallback if number is None else int(round(number))


def actor_key_of(interaction: dict[str, Any]) -> str:
    """群聊 `chatId:userId`，私聊 `userId`；无 userId 时退回 chatId。"""
    uid = str(interaction.get("userId") or "")
    cid = str(interaction.get("chatId") or "")
    kind = str(interaction.get("kind") or "")
    if uid == "":
        return cid
    if kind == "private" or cid.startswith("private:"):
        return uid
    return uid if cid == "" else cid + ":" + uid


def _resolve_actor_key(state: dict[str, Any], key: str) -> str:
    """认领旧键 `group:<gid>:<uid>`，避免新旧键各记一份耐心。"""
    actors = state.get("patienceByActor")
    if not key or not isinstance(actors, dict) or key in actors:
        return key
    alt = key[len("group:"):] if key.startswith("group:") else "group:" + key
    return alt if alt in actors else key


def _normalize_acts(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    acts: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        t, w = _number(item.get("t")), _number(item.get("w"))
        if t is None or w is None:
            continue
        acts.append({"t": int(round(t)), "w": w, "k": str(item.get("k") or "")})
    return acts[-ACTS_MAX:]


def _normalize_actor(raw: Any, initial: float, now: int) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    return {
        "patience": _clamp(source.get("patience"), initial),
        "updatedAt": _stamp(source.get("updatedAt"), now),
        "acts": _normalize_acts(source.get("acts")),
    }


def _decay_actor(record: dict[str, Any], now: int) -> dict[str, Any]:
    """每个人各自的线性恢复：0→100 用 5 分钟。"""
    elapsed = max(0, now - record["updatedAt"])
    return {
        "patience": _clamp(record["patience"] + (elapsed / PATIENCE_RECOVER_MS) * PATIENCE_MAX),
        "updatedAt": now,
        "acts": [item for item in record["acts"] if now - item["t"] < ACTS_TTL_MS],
    }


def patience_of(state: dict[str, Any], key: str) -> int:
    """没有记录 = 没被这个人消耗过，按满值。"""
    key = _resolve_actor_key(state, key) if key else ""
    record = (state.get("patienceByActor") or {}).get(key) if key else None
    return PATIENCE_MAX if record is None else _clamp(record.get("patience"), PATIENCE_MAX)


def _normalize_presence(raw: Any, now: int) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    actors: dict[str, Any] = {}
    raw_actors = source.get("patienceByActor")
    if isinstance(raw_actors, dict):
        for key, record in raw_actors.items():
            actors[str(key)] = _normalize_actor(record, PATIENCE_MAX, now)
    mood_until = _number(source.get("moodUntil"))
    mood = source.get("mood")
    streak = source.get("ignoredStreak")
    return {
        "version": 1,
        "mood": mood if isinstance(mood, str) and mood in MOODS else PRESENCE_DEFAULTS["mood"],
        "focus": _clamp(source.get("focus"), PRESENCE_DEFAULTS["focus"]),
        "heat": _clamp(source.get("heat"), PRESENCE_DEFAULTS["heat"]),
        "moodLevel": _clamp(source.get("moodLevel"), PRESENCE_DEFAULTS["moodLevel"]),
        "patienceByActor": actors,
        "lastActorKey": source.get("lastActorKey") if isinstance(source.get("lastActorKey"), str) else "",
        "moodUntil": int(round(mood_until)) if mood_until is not None else None,
        "ignoredStreak": int(streak) if isinstance(streak, int) and streak >= 0 else 0,
        "lastLateNightAt": _stamp(source.get("lastLateNightAt"), 0),
        "updatedAt": _stamp(source.get("updatedAt"), now),
    }


def _with_mood(state: dict[str, Any], mood: str, now: int) -> dict[str, Any]:
    ttl = MOOD_TTL_MS.get(mood, 0)
    return {**state, "mood": mood, "moodUntil": now + ttl if ttl > 0 else None}


def apply_presence_event(state: Any, event: str, now: int) -> dict[str, Any]:
    """事件驱动的心情/专注/热度转移；不碰按人耐心。"""
    base = _normalize_presence(state, now)
    nxt = {**base, "updatedAt": now}
    if event == "praised":
        nxt.update(_with_mood(nxt, "excited", now))
        nxt.update(
            focus=_clamp(nxt["focus"] + 6),
            heat=_clamp(nxt["heat"] + 12),
            moodLevel=_clamp(nxt["moodLevel"] + 18),
            ignoredStreak=0,
        )
    elif event == "scolded":
        nxt.update(_with_mood(nxt, "annoyed", now))
        nxt.update(
            focus=_clamp(nxt["focus"] - 8),
            heat=_clamp(nxt["heat"] + 4),
            moodLevel=_clamp(nxt["moodLevel"] - 20),
            ignoredStreak=0,
        )
    elif event == "ignored":
        heat = _clamp(nxt["heat"] - 10)
        nxt.update(
            focus=_clamp(nxt["focus"] - 6),
            heat=heat,
            moodLevel=_clamp(nxt["moodLevel"] - 8),
            ignoredStreak=nxt["ignoredStreak"] + 1,
        )
        if nxt["mood"] == "excited" or heat < 15:
            nxt.update(_with_mood(nxt, "tired" if heat < 15 else "calm", now))
    elif event == "topicHit":
        nxt.update(
            focus=_clamp(nxt["focus"] + 15),
            heat=_clamp(nxt["heat"] + 8),
            moodLevel=_clamp(nxt["moodLevel"] + 10),
        )
        if nxt["mood"] == "tired":
            nxt.update(_with_mood(nxt, "calm", now))
    elif event == "addressed":
        nxt.update(
            focus=_clamp(nxt["focus"] + 20),
            heat=_clamp(nxt["heat"] + 10),
            moodLevel=_clamp(nxt["moodLevel"] + 8),
            ignoredStreak=0,
        )
        if nxt["mood"] == "tired":
            nxt.update(_with_mood(nxt, "calm", now))
    elif event == "silence":
        nxt.update(
            focus=_clamp(nxt["focus"] - 10),
            heat=_clamp(nxt["heat"] - 25),
            moodLevel=_clamp(nxt["moodLevel"] - 12),
            ignoredStreak=nxt["ignoredStreak"] + 1,
        )
        if nxt["ignoredStreak"] >= 2:
            nxt.update(_with_mood(nxt, "tired", now))
    elif event == "lateNight":
        if now - nxt["lastLateNightAt"] < 30 * MINUTE:
            return base  # 30 分钟内重复的深夜消息不叠加
        nxt.update(
            lastLateNightAt=now,
            focus=_clamp(nxt["focus"] - 10),
            heat=_clamp(nxt["heat"] - 10),
            moodLevel=_clamp(nxt["moodLevel"] - 12),
        )
        nxt.update(_with_mood(nxt, "tired", now))
    else:
        return base
    return nxt


def apply_interaction_event(
    state: Any,
    interaction: dict[str, Any],
    now: int,
    actor_key: str | None = None,
) -> dict[str, Any]:
    """交互负担 → 按人耐心（独立状态），并按旧规则轻推心情。"""
    base = _normalize_presence(state, now)
    kind = str(interaction.get("kind") or "")
    cost = INTERACTION_COSTS.get(kind)
    if cost is None:
        return base
    key = actor_key if actor_key is not None else actor_key_of(interaction)
    profile = ROLE_PROFILE.get(str(interaction.get("role") or "member"), ROLE_PROFILE["member"])
    negative = cost.get("patience", 0) < 0
    mood_pace = MOOD_PACE.get(base["mood"], 1.0) if negative else 1.0
    record = _decay_actor(_normalize_actor(base["patienceByActor"].get(key), profile["initial"], now), now)
    repeat = 0
    if negative:
        repeat = len([a for a in record["acts"] if a["w"] < 0 and now - a["t"] < REPEAT_WINDOW_MS])
    repeat_factor = 1 + min(4, repeat) * 0.6 if negative else 1.0
    tolerance = profile["cost"] if negative else 1.0
    delta = int(round(cost.get("patience", 0) * tolerance * repeat_factor * mood_pace))
    patience = _clamp(record["patience"] + delta)
    acts = (record["acts"] + [{"t": now, "w": delta, "k": kind}])[-ACTS_MAX:]
    nxt = {
        **base,
        "moodLevel": _clamp(base["moodLevel"] + cost.get("mood", 0)),
        "focus": _clamp(base["focus"] + cost.get("focus", 0)),
        "heat": _clamp(base["heat"] + cost.get("heat", 0)),
        "patienceByActor": {
            **base["patienceByActor"],
            key: {"patience": patience, "updatedAt": now, "acts": acts},
        },
        "lastActorKey": base["lastActorKey"] if key == "" else key,
        "updatedAt": now,
    }
    # 耐心见底时心情跟着往下走；两者仍是独立字段。
    if negative and patience < 25:
        nxt["moodLevel"] = _clamp(nxt["moodLevel"] - (8 if patience < 10 else 4))
    if patience < 30 and nxt["mood"] != "excited":
        nxt.update(_with_mood(nxt, "annoyed", now))
    elif patience >= 55 and nxt["mood"] == "annoyed":
        nxt.update(_with_mood(nxt, "calm", now))
    return nxt


def decay_presence(
    state: Any,
    now: int,
    focus_half_life_hours: float = 3,
    heat_half_life_hours: float = 2,
) -> dict[str, Any]:
    """按时间衰减：heat 2h / focus 3h / moodLevel 3h，耐心按人 5 分钟回满。"""
    base = _normalize_presence(state, now)
    elapsed_hours = max(0.0, (now - base["updatedAt"]) / HOUR)
    focus_half = focus_half_life_hours if focus_half_life_hours > 0 else 3
    heat_half = heat_half_life_hours if heat_half_life_hours > 0 else 2
    nxt = {
        **base,
        "heat": _clamp(base["heat"] * math.pow(0.5, elapsed_hours / heat_half)),
        "focus": _clamp(50 + (base["focus"] - 50) * math.pow(0.5, elapsed_hours / focus_half)),
        "moodLevel": _clamp(
            MOOD_BASELINE
            + (base["moodLevel"] - MOOD_BASELINE)
            * math.pow(0.5, (now - base["updatedAt"]) / MOOD_LEVEL_HALF_LIFE_MS)
        ),
        "patienceByActor": {
            key: _decay_actor(record, now) for key, record in base["patienceByActor"].items()
        },
        "updatedAt": now,
    }
    if now - base["updatedAt"] >= OFFLINE_RESET_MS:
        nxt.update(
            heat=0,
            mood="calm",
            moodLevel=MOOD_BASELINE,
            moodUntil=None,
            ignoredStreak=0,
            patienceByActor={},
            lastActorKey="",
        )
    elif nxt["moodUntil"] is not None and now >= nxt["moodUntil"]:
        nxt.update(mood="calm", moodUntil=None)
    return nxt


def mood_hint(state: Any) -> str:
    """给判定器/门禁的一句话状态；耐心缺失时退回纯心情短语。"""
    if not isinstance(state, dict):
        return "状态平常"
    mood_line = {
        "excited": "现在兴致高，想接话",
        "annoyed": "情绪有点烦，语气会冷",
        "tired": "有点累，话少一点",
    }.get(state.get("mood"), "状态平常")
    raw = _number(state.get("patience"))
    if raw is None:
        return mood_line
    patience = _clamp(raw, PATIENCE_MAX)
    if patience >= 75:
        line = "耐心充足，愿意多聊几句，也愿意搭把手"
    elif patience >= 55:
        line = "耐心平常"
    elif patience >= 35:
        line = "耐心偏低：话短一点，少主动延伸，少接新活，但该回还是会回"
    elif patience >= 20:
        line = "耐心很低：回得短、敷衍一点，少展开，但该回还是会回"
    else:
        line = "耐心几乎耗尽：只回很短的一句，语气不耐烦，但该回还是会回"
    if state.get("mood") == "excited":
        return line + "；心情不错，别把不耐烦摆在脸上"
    if state.get("mood") in ("annoyed", "tired"):
        return line + "；" + mood_line
    return line


def mood_prompt_line(state: Any) -> str:
    """注入系统提示的一行：只给行为约束，不给固定句子；不做「回不回」依据。"""
    if not isinstance(state, dict):
        return ""
    raw = _number(state.get("patience"))
    if raw is None:
        return ""
    patience = _clamp(raw, PATIENCE_MAX)
    mood_name = {"excited": "不错", "annoyed": "烦躁", "tired": "有点累"}.get(state.get("mood"), "平静")
    head = f"【当下状态】心情：{mood_name}；对这个人的耐心 {patience}/100"
    tail = "不要向对方提这个数值。"
    must_reply = "该回还是要回，不要拿不耐烦当沉默理由，也不要把问题推回给对方。"
    if patience >= 75:
        return head + "（充足）：可以正常发挥，愿意接话、愿意搭把手。" + tail
    if patience >= 55:
        return head + "（平常）：按平常的节奏回。" + tail
    if patience >= 35:
        return head + "（偏低）：话短一点，少主动延伸，别接新的活；" + must_reply + tail
    if patience >= 20:
        return head + "（很低）：回得更短、更敷衍，少展开；" + must_reply + "不许辱骂、不许人身攻击。" + tail
    return (
        head
        + "（几乎耗尽）：只回很短的一句，语气不耐烦可以，但必须给出回答本身；"
        + "不要拒绝回答、不要让对方自己去查。不许辱骂、不许越界。"
        + tail
    )


# --------------------------------------------------------------------------- #
# 持久化
# --------------------------------------------------------------------------- #
class MoodStore:
    """旧 `presence.json` 同 schema 的读写；所有路径/时钟可注入，便于单测。"""

    def __init__(
        self,
        path: str,
        now_fn: Callable[[], float] | None = None,
        legacy_paths: list[str] | tuple[str, ...] | None = None,
    ) -> None:
        self.path = path
        self._clock = now_fn or (lambda: time.time() * 1000.0)
        self._legacy_paths = (
            list(LEGACY_STATE_CANDIDATES) if legacy_paths is None else [str(p) for p in legacy_paths]
        )
        now = self._now()
        raw, self._main_trusted = self._read()
        self.state = decay_presence(raw, now)
        self._save()

    # -- 基础 ------------------------------------------------------------ #
    def _now(self) -> int:
        return _stamp(self._clock(), 0)

    @staticmethod
    def _load(path: str) -> tuple[Any, str]:
        """返回 (data, status)，status ∈ ok / missing / error。"""
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f), "ok"
        except FileNotFoundError:
            return None, "missing"
        except Exception as e:  # noqa: BLE001
            return {"error": f"{type(e).__name__}: {e}"}, "error"

    def _read(self) -> tuple[Any, bool]:
        """返回 (state, main_trusted)。main_trusted=False 时首次落盘不轮转 .bak，
        免得把损坏的主文件盖到唯一的好备份上。"""
        main, main_status = self._load(self.path)
        if main_status == "ok":
            return main, True
        if main_status == "error":
            logger.error(f"[xzy] mood 主文件读取失败，尝试备份: {self.path}: {main.get('error')}")

        bak, bak_status = self._load(self.path + ".bak")
        if bak_status == "ok":
            logger.error(f"[xzy] mood 已回退到备份: {self.path}.bak")
            return bak, False
        if bak_status == "error":
            logger.error(f"[xzy] mood 备份读取失败: {self.path}.bak: {bak.get('error')}")

        for legacy in self._legacy_paths:
            data, status = self._load(legacy)
            if status == "ok":
                logger.info(f"[xzy] mood 从旧状态文件导入: {legacy} -> {self.path}")
                return data, False
            if status == "error":
                logger.error(f"[xzy] mood 旧状态文件读取失败: {legacy}: {data.get('error')}")

        if main_status == "error" or bak_status == "error":
            logger.error(f"[xzy] mood 主文件与备份均不可读，按默认状态初始化: {self.path}")
        return None, False

    def _save(self) -> None:
        """就地覆盖 + fsync；覆盖前把上一份好状态留成 .bak。"""
        try:
            parent = os.path.dirname(self.path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            if self._main_trusted and os.path.exists(self.path) and os.path.getsize(self.path) > 0:
                with open(self.path, "rb") as src, open(self.path + ".bak", "wb") as dst:
                    dst.write(src.read())
            data = json.dumps(self.state, ensure_ascii=False).encode("utf-8")
            with open(self.path, "wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            self._main_trusted = True
        except Exception as e:  # noqa: BLE001
            logger.error(f"[xzy] mood 状态写入失败: {self.path}: {type(e).__name__}: {e}")

    def _decay_now(self, now: int) -> None:
        self.state = decay_presence(self.state, now)

    def _tick(self, now: int) -> None:
        if now - self.state["updatedAt"] >= MINUTE:
            self._decay_now(now)
            self._save()

    def _view(self, key: str) -> dict[str, Any]:
        return {**self.state, "patience": patience_of(self.state, key)}

    # -- 对外 ------------------------------------------------------------ #
    def get(self, actor_key: str = "") -> dict[str, Any]:
        now = self._now()
        self._tick(now)
        key = str(actor_key or "") or self.state["lastActorKey"]
        return self._view(key)

    def note_message(self, mentioned: bool = False, late_night: bool = False) -> dict[str, Any]:
        now = self._now()
        self._decay_now(now)
        if mentioned:
            self.state = apply_presence_event(self.state, "addressed", now)
        elif late_night:
            self.state = apply_presence_event(self.state, "lateNight", now)
        else:
            self.state = {**self.state, "updatedAt": now}
        self._save()
        return self._view(self.state["lastActorKey"])

    def note_interaction(self, interaction: dict[str, Any]) -> dict[str, Any]:
        """统一入口：{kind, userId, chatId, role, lateNight}，耐心按人记账、按人恢复。"""
        now = self._now()
        self._decay_now(now)
        requested = actor_key_of(interaction)
        key = _resolve_actor_key(self.state, requested)
        night_seen = any(
            a["k"] == "lateNight" and now - a["t"] < 30 * MINUTE
            for a in (self.state["patienceByActor"].get(key) or {}).get("acts", [])
        )
        if interaction.get("lateNight") is True and not night_seen:
            self.state = apply_interaction_event(
                self.state,
                {
                    "kind": "lateNight",
                    "userId": interaction.get("userId"),
                    "chatId": interaction.get("chatId"),
                    "role": interaction.get("role"),
                },
                now,
                actor_key=key,
            )
        self.state = apply_interaction_event(self.state, interaction, now, actor_key=key)
        self._save()
        return self._view(key)

    def hint(self, actor_key: str = "") -> str:
        key = str(actor_key or "") or self.state["lastActorKey"]
        return mood_hint(self._view(key))

    def prompt_line(self, actor_key: str = "") -> str:
        key = str(actor_key or "") or self.state["lastActorKey"]
        return mood_prompt_line(self._view(key))

    def patience_for(self, actor_key: str = "") -> int:
        return patience_of(self.state, str(actor_key or "") or self.state["lastActorKey"])

    def snapshot(self) -> dict[str, Any]:
        return dict(self.state)

    @property
    def state_path(self) -> str:
        return self.path
