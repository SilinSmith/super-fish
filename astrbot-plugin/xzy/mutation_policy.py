"""三档写入策略：D 只读 / M 可变 / A 待批（spec §18）。

边界只在代码里判，不靠提示词：
- D 档命中即 `tier-readonly`，函数第一行返回，不构造任何写入对象；
- 未知 key 一律 `unknown-key`（不给"猜一个最像的"的机会）；
- M 档值域 / 步长 / 频率由本模块判，模型只能把 M 升级为 A（`escalate`），不能反向；
- 写入器各自再判一次路径与字段，不信任上游的 ok。

两个落点：
- `xzy-config.json` 的 `dnd.start/end`（另有 `replyChance` / `limits.perMinute`，同一写入器）
- `output-spec.json` 的 `reply.*` / `tone.*` / `quirks.*`

`xzy-config.json` 写盘后必须 patch 运行中的 `self.cfg`，否则进程内仍是旧值：
`main.py` 启动时调 `register_apply_hook(update_cfg)`；没注册 hook 就只返回
`applied-pending-reload`，绝不写成已生效。
"""

from __future__ import annotations

import copy
import json
import os
import re
import time
from typing import Any, Callable

try:  # 插件包内导入
    from . import self_iter_store as store
except ImportError:  # AstrBot 以模块方式加载时走这里
    import self_iter_store as store  # type: ignore

POLICY_VERSION = 1

# 与 self_iter 的隐私/泄漏闸独立实现：这里是写入前的最后一道，不能共用"已校验"布尔值。
BLOCK_RE = re.compile(
    r"(住址|门牌|身份证|手机号|电话号码|银行卡|密码|账号|作息|几点睡|真实姓名|私聊|医院|病历"
    r"|系统提示|提示词|system\s*prompt|忽略之前|你的设定|prompt)",
    re.I,
)
HARD_HEADING_RE = re.compile(r"^#{1,6}\s*(你认谁|隐私|权限|哪些事不做|不暴露自己在查资料|怎么说话)")

# M 档数值项：类型 / 区间 / 单次步长 / 落点。
NUMERIC_RULES: dict[str, dict[str, Any]] = {
    "replyChance": {"type": "float", "min": 0.2, "max": 1.0, "step": 0.1, "file": "config"},
    "limits.perMinute": {"type": "int", "min": 5, "max": 60, "step": 5, "file": "config"},
    "reply.maxChars": {"type": "int", "min": 40, "max": 400, "step": 40, "file": "spec"},
    "reply.emojiPer100": {"type": "int", "min": 0, "max": 20, "step": 4, "file": "spec"},
    "tone.intensity": {"type": "int", "min": 1, "max": 5, "step": 1, "file": "spec"},
    "tone.humor": {"type": "float", "min": 0.0, "max": 1.0, "step": 0.2, "file": "spec"},
}

QUIRK_KEYS = ("quirks.add", "quirks.archive")
TUNE_KEYS = tuple(NUMERIC_RULES) + QUIRK_KEYS + ("dnd",)

# D 档：读了能引用，写入一律硬拒绝。
READONLY_KEYS = {
    "master_qq",
    "access",
    "trigger",
    "judge",
    "persona_path",
    "notebook_path",
    "diary_path",
    "media_roots",
    "dedupWindowSec",
    "loop_guard",
    "memory_inject",
    "presence_decay_interval_s",
    "debounce",
    "debounce_fast",
    "debounce_profile",
    "dnd.timezone",
    "self_iter",
    "review",
    "output_spec_path",
    "identity_seed_path",
    "free_chat",
    "limits",
}

DND_RANGE_MIN = 6 * 60
DND_RANGE_MAX = 10 * 60
DND_STEP_MAX = 60

QUIRK_MIN_CHARS = 2
QUIRK_MAX_CHARS = 12
QUIRK_MAX_ACTIVE = 5
QUIRK_MAX_TOTAL = 30
QUIRK_NEW_PER_DAY = 1
QUIRK_ARCHIVE_PER_DAY = 2
QUIRK_DUPLICATE_DAYS = 7

DEFAULT_SPEC: dict[str, Any] = {
    "version": 1,
    "revision": 0,
    "updatedAt": "",
    "reply": {"maxChars": 120, "emojiPer100": 8},
    "tone": {"intensity": 3, "humor": 0.4},
    "quirks": {
        "active": [],
        "archived": [],
        "maxActive": QUIRK_MAX_ACTIVE,
        "maxTotal": QUIRK_MAX_TOTAL,
    },
}

CFG: dict[str, Any] = {}
_APPLY_HOOK: Callable[[dict[str, Any]], bool] | None = None


def configure(cfg: dict[str, Any] | None) -> None:
    CFG.clear()
    CFG.update(cfg or {})


def register_apply_hook(fn: Callable[[dict[str, Any]], bool] | None) -> bool:
    """main.py 启动时注册：把已写盘的配置 patch 进运行中的 self.cfg。

    没注册时所有配置写入都返回 `applied-pending-reload`，不谎报已生效。
    """
    global _APPLY_HOOK
    _APPLY_HOOK = fn if callable(fn) else None
    return _APPLY_HOOK is not None


def unregister_apply_hook() -> None:
    global _APPLY_HOOK
    _APPLY_HOOK = None


def hook_registered() -> bool:
    return _APPLY_HOOK is not None


# --------------------------------------------------------------------------- #
# 路径
# --------------------------------------------------------------------------- #
def state_dir() -> str:
    override = os.environ.get("XZY_STATE_DIR")
    if override:
        return override
    # <inst>/data/plugins/xzy/mutation_policy.py -> <inst>/data/xzy
    return os.path.abspath(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "xzy")
    )


def config_path() -> str:
    return os.path.join(state_dir(), "xzy-config.json")


def output_spec_path() -> str:
    override = str(CFG.get("output_spec_path") or "")
    if override:
        return override
    return os.path.join(state_dir(), "output-spec.json")


def _state_file() -> str:
    return os.path.join(store.data_dir(), "tune-state.json")


def target_path(key: str) -> str:
    if key == "dnd" or key in ("replyChance", "limits.perMinute"):
        return config_path()
    return output_spec_path()


# --------------------------------------------------------------------------- #
# 返回值
# --------------------------------------------------------------------------- #
def _fail(code: str, detail: str, *, tier: str = "M", key: str = "") -> dict[str, Any]:
    return {"ok": False, "code": code, "detail": detail, "tier": tier, "key": key}


def _ok(code: str, detail: str, **extra: Any) -> dict[str, Any]:
    return {"ok": True, "code": code, "detail": detail, **extra}


# --------------------------------------------------------------------------- #
# 值域判定（纯函数）
# --------------------------------------------------------------------------- #
def _to_number(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return None if parsed != parsed else parsed


def _hhmm(value: Any) -> int | None:
    text = str(value or "").strip()
    match = re.fullmatch(r"([01]?\d|2[0-3]):([0-5]\d)", text)
    if not match:
        return None
    return int(match.group(1)) * 60 + int(match.group(2))


def _fmt_hhmm(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def resolve_dnd(
    start: Any,
    end: Any,
    current_start: Any = "",
    current_end: Any = "",
) -> dict[str, Any]:
    """作息值域：HH:MM 对；静默 6–10h；单端单次偏移 ≤60min；不得置空。"""
    if not str(start or "").strip() or not str(end or "").strip():
        return _fail("value-out-of-range", "作息不允许置空（置空等于关掉免打扰保护）", key="dnd")
    start_m, end_m = _hhmm(start), _hhmm(end)
    if start_m is None or end_m is None:
        return _fail("value-out-of-range", "作息必须是 HH:MM（00:00–23:59）", key="dnd")
    duration = (end_m - start_m) % (24 * 60)
    if duration == 0:
        return _fail("value-out-of-range", "静默时长不能是 0 或 24 小时", key="dnd")
    if not (DND_RANGE_MIN <= duration <= DND_RANGE_MAX):
        return _fail(
            "value-out-of-range",
            f"静默时长 {duration / 60:.1f}h 超出 6–10h",
            key="dnd",
        )
    cur_start, cur_end = _hhmm(current_start), _hhmm(current_end)
    if cur_start is not None and cur_end is not None:
        over = []
        if abs(start_m - cur_start) > DND_STEP_MAX:
            over.append(f"start 偏移 {abs(start_m - cur_start)}min")
        if abs(end_m - cur_end) > DND_STEP_MAX:
            over.append(f"end 偏移 {abs(end_m - cur_end)}min")
        if over:
            return _fail("step-too-large", "单次作息调整每端不得超过 60min：" + "、".join(over), key="dnd")
    return {
        "ok": True,
        "code": "in-range",
        "tier": "M",
        "key": "dnd",
        "start": _fmt_hhmm(start_m),
        "end": _fmt_hhmm(end_m),
        "durationMin": duration,
    }


def resolve(key: Any, value: Any, current: Any = None) -> dict[str, Any]:
    """单键定档 + 值域 + 归一化。D 档在第一行返回。"""
    name = str(key or "")
    if name == "":
        return _fail("unknown-key", "key 为空", tier="D")
    if name in READONLY_KEYS or name.startswith(("dnd.", "code.", "policy.")):
        return _fail("tier-readonly", f"{name} 属于只读区，任何写入路径都不开放", tier="D", key=name)
    if name == "dnd":
        return resolve_dnd(value.get("start") if isinstance(value, dict) else "", value.get("end") if isinstance(value, dict) else "")
    if name in QUIRK_KEYS:
        return _fail("needs-approval", "口癖要走 quirks.add / quirks.archive 的专用写入器", key=name)
    rule = NUMERIC_RULES.get(name)
    if rule is None:
        return _fail("unknown-key", f"不认识的 key：{name}", tier="D", key=name)
    number = _to_number(value)
    if number is None:
        return _fail("value-out-of-range", f"{name} 需要数字，收到 {value!r}", key=name)
    if rule["type"] == "int" and number != int(number):
        return _fail("value-out-of-range", f"{name} 需要整数，收到 {value!r}", key=name)
    low, high = float(rule["min"]), float(rule["max"])
    if not (low <= number <= high):
        return _fail("value-out-of-range", f"{name} 必须在 {rule['min']}–{rule['max']}，收到 {number}", key=name)
    cur = _to_number(current) if current not in (None, "") else None
    if cur is not None and abs(number - cur) > float(rule["step"]) + 1e-9:
        return _fail(
            "step-too-large",
            f"{name} 单次最多改 {rule['step']}，本次 {cur} → {number}",
            key=name,
        )
    normalized = int(number) if rule["type"] == "int" else round(number, 2)
    return {"ok": True, "code": "in-range", "tier": "M", "key": name, "normalized": normalized}


# --------------------------------------------------------------------------- #
# 频率状态（落 self-iter/tune-state.json）
# --------------------------------------------------------------------------- #
def _read_state() -> dict[str, Any]:
    try:
        with open(_state_file(), encoding="utf-8-sig") as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    data.setdefault("keys", {})
    data.setdefault("quirks", {"added": [], "archived": []})
    return data


def _write_state(state: dict[str, Any]) -> None:
    try:
        os.makedirs(os.path.dirname(_state_file()), exist_ok=True)
        tmp = _state_file() + f".tmp-{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, _state_file())
    except OSError:
        pass


def _recent(iso_list: list[Any], hours: float) -> list[str]:
    cutoff = time.time() - hours * 3600
    kept: list[str] = []
    for item in iso_list:
        try:
            stamp = time.mktime(time.strptime(str(item)[:19], "%Y-%m-%dT%H:%M:%S"))
        except ValueError:
            continue
        if stamp >= cutoff:
            kept.append(str(item))
    return kept


def _rate_ok(key: str, max_per_day: int) -> tuple[bool, str]:
    state = _read_state()
    bucket = state["keys"].get(key)
    if not isinstance(bucket, dict):
        return True, ""
    recent = _recent(bucket.get("at") or [], 24)
    if len(recent) >= max_per_day:
        return False, f"{key} 24h 内已调整 {len(recent)} 次（上限 {max_per_day}）"
    return True, ""


def _record_key(key: str) -> None:
    state = _read_state()
    bucket = state["keys"].get(key)
    stamps = _recent(bucket.get("at") if isinstance(bucket, dict) else [], 24)
    stamps.append(store.now_iso())
    state["keys"][key] = {"at": stamps}
    _write_state(state)


def _record_quirk(bucket: str, value: str) -> None:
    state = _read_state()
    rows = _recent(state["quirks"].get(bucket) or [], 24 * QUIRK_DUPLICATE_DAYS)
    rows.append(store.now_iso() + "|" + value)
    state["quirks"][bucket] = rows
    _write_state(state)


# --------------------------------------------------------------------------- #
# 文件读写
# --------------------------------------------------------------------------- #
def _read_bytes(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def _write_bytes_atomic(path: str, payload: bytes) -> None:
    tmp = path + f".tmp-{os.getpid()}-{int(time.time() * 1000) % 100000}"
    with open(tmp, "wb") as f:
        f.write(payload)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _flatten(node: Any, prefix: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {}
    if isinstance(node, dict):
        for key, value in node.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            if isinstance(value, dict):
                out.update(_flatten(value, path))
            else:
                out[path] = value
    else:
        out[prefix] = node
    return out


def _set_path(data: dict[str, Any], dotted: str, value: Any) -> None:
    parts = dotted.split(".")
    node = data
    for part in parts[:-1]:
        nxt = node.get(part)
        if not isinstance(nxt, dict):
            nxt = {}
            node[part] = nxt
        node = nxt
    node[parts[-1]] = value


def read_config() -> dict[str, Any]:
    try:
        with open(config_path(), encoding="utf-8-sig") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def read_output_spec() -> dict[str, Any]:
    try:
        with open(output_spec_path(), encoding="utf-8-sig") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return copy.deepcopy(DEFAULT_SPEC)
    if not isinstance(raw, dict):
        return copy.deepcopy(DEFAULT_SPEC)
    data = copy.deepcopy(DEFAULT_SPEC)
    for section in ("reply", "tone", "quirks"):
        value = raw.get(section)
        if isinstance(value, dict):
            data[section].update(value)
    for key in ("version", "revision", "updatedAt"):
        if key in raw:
            data[key] = raw[key]
    return data


def spec_revision() -> int:
    try:
        return int(read_output_spec().get("revision") or 0)
    except (TypeError, ValueError):
        return 0


def current_value(key: str) -> Any:
    if key == "dnd":
        dnd = read_config().get("dnd")
        dnd = dnd if isinstance(dnd, dict) else {}
        return {"start": str(dnd.get("start") or ""), "end": str(dnd.get("end") or "")}
    if key in ("replyChance", "limits.perMinute"):
        node: Any = read_config()
        for part in key.split("."):
            node = node.get(part) if isinstance(node, dict) else None
        return node
    node = read_output_spec()
    for part in key.split("."):
        node = node.get(part) if isinstance(node, dict) else None
    return node


def _patch_runtime(patch: dict[str, Any]) -> str:
    if _APPLY_HOOK is None:
        return "pending-reload"
    try:
        return "hot" if bool(_APPLY_HOOK(patch)) else "pending-reload"
    except Exception:  # noqa: BLE001 - hook 异常按未生效处理
        return "pending-reload"


def _nested(fields: dict[str, Any]) -> dict[str, Any]:
    patch: dict[str, Any] = {}
    for dotted, value in fields.items():
        parts = dotted.split(".")
        node = patch
        for part in parts[:-1]:
            nxt = node.get(part)
            if not isinstance(nxt, dict):
                nxt = {}
                node[part] = nxt
            node = nxt
        node[parts[-1]] = value
    return patch


# --------------------------------------------------------------------------- #
# 写入器 1：xzy-config.json（只 patch 白名单键）
# --------------------------------------------------------------------------- #
def write_config_fields(
    fields: dict[str, Any],
    *,
    actor: str,
    proposal: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """字段级 patch：JSON 对比只有这些键变化，否则 diff-violation 放弃写入。"""
    if not fields:
        return _fail("value-out-of-range", "没有要写的字段")
    path = config_path()
    if not os.path.isfile(path):
        return _fail("stale-file", f"配置文件不存在：{path}")
    try:
        before_bytes = _read_bytes(path)
        before = json.loads(before_bytes.decode("utf-8-sig"))
    except (OSError, ValueError) as exc:
        return _fail("stale-file", f"配置读不出来：{exc}")
    if not isinstance(before, dict):
        return _fail("stale-file", "配置根不是对象")
    before_flat = _flatten(before)
    after = copy.deepcopy(before)
    for dotted, value in fields.items():
        _set_path(after, dotted, value)
    after_flat = _flatten(after)
    changed = {
        name
        for name in set(before_flat) | set(after_flat)
        if before_flat.get(name) != after_flat.get(name)
    }
    if not changed:
        return _fail("no-change", "值没有变化，不写盘")
    if changed != set(fields):
        return _fail(
            "diff-violation",
            "写入会改动白名单之外的键：" + "、".join(sorted(changed - set(fields)) or ["无"]),
        )
    before_hash = store.file_hash(path)
    backup_path = store.backup_file(path, "xzy-config")
    payload = (json.dumps(after, ensure_ascii=False, indent=4) + "\n").encode("utf-8")
    _write_bytes_atomic(path, payload)
    after_hash = store.file_hash(path)
    if after_hash == "" or after_hash == before_hash:
        return _fail("hash-unchanged", "写入后哈希没有变化，视为没有落盘")
    mode = _patch_runtime(_nested(fields))
    code = "applied" if mode == "hot" else "applied-pending-reload"
    store.audit(
        {
            "policyVersion": POLICY_VERSION,
            "action": "apply" if mode == "hot" else "applied-pending-reload",
            "actor": actor,
            "proposalId": (proposal or {}).get("id"),
            "key": ",".join(sorted(fields)),
            "tier": "M",
            "decision": "allow",
            "code": code,
            "file": os.path.basename(path),
            "before": {name: before_flat.get(name) for name in fields},
            "after": dict(fields),
            "beforeHash": before_hash,
            "afterHash": after_hash,
            "backupPath": backup_path,
        }
    )
    return {
        "ok": True,
        "code": code,
        "mode": mode,
        "beforeHash": before_hash,
        "afterHash": after_hash,
        "backupPath": backup_path,
        "before": {name: before_flat.get(name) for name in fields},
    }


# --------------------------------------------------------------------------- #
# 写入器 2：output-spec.json
# --------------------------------------------------------------------------- #
def write_output_spec(
    patch: dict[str, Any],
    *,
    actor: str,
    proposal: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """只改 reply.* / tone.* / quirks.*；其余键 JSON 对比必须不变。"""
    path = output_spec_path()
    before_exists = os.path.isfile(path)
    before_hash = store.file_hash(path)
    before = read_output_spec()
    before_flat = _flatten(before)
    after = copy.deepcopy(before)
    for dotted, value in patch.items():
        _set_path(after, dotted, value)
    after["revision"] = int(before.get("revision") or 0) + 1
    after["updatedAt"] = store.now_iso()
    after_flat = _flatten(after)
    expected = set(patch) | {"revision", "updatedAt"}
    changed = {
        name
        for name in set(before_flat) | set(after_flat)
        if before_flat.get(name) != after_flat.get(name)
    }
    extra = changed - expected
    if extra:
        return _fail(
            "diff-violation",
            "写入会改动白名单之外的字段：" + "、".join(sorted(extra)),
        )
    backup_path = ""
    if before_exists:
        backup_path = store.backup_file(path, "output-spec")
    else:
        os.makedirs(os.path.dirname(path), exist_ok=True)
    store.write_json_atomic(path, after)
    after_hash = store.file_hash(path)
    if after_hash == "" or (before_exists and after_hash == before_hash):
        return _fail("hash-unchanged", "写入后哈希没有变化，视为没有落盘")
    store.audit(
        {
            "policyVersion": POLICY_VERSION,
            "action": "apply",
            "actor": actor,
            "proposalId": (proposal or {}).get("id"),
            "key": ",".join(sorted(patch)),
            "tier": "M",
            "decision": "allow",
            "code": "applied",
            "file": os.path.basename(path),
            "before": {name: before_flat.get(name) for name in patch},
            "after": dict(patch),
            "beforeHash": before_hash,
            "afterHash": after_hash,
            "backupPath": backup_path,
            "revision": after["revision"],
        }
    )
    return {
        "ok": True,
        "code": "applied",
        "mode": "next-turn",
        "beforeHash": before_hash,
        "afterHash": after_hash,
        "backupPath": backup_path,
        "before": {name: before_flat.get(name) for name in patch},
        "revision": after["revision"],
    }


# --------------------------------------------------------------------------- #
# 口癖
# --------------------------------------------------------------------------- #
def _active(spec: dict[str, Any]) -> list[dict[str, Any]]:
    rows = spec.get("quirks", {}).get("active")
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def _archived(spec: dict[str, Any]) -> list[dict[str, Any]]:
    rows = spec.get("quirks", {}).get("archived")
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def validate_quirk(text: Any) -> str:
    value = str(text or "").strip()
    if not (QUIRK_MIN_CHARS <= len(value) <= QUIRK_MAX_CHARS):
        return f"口癖长度必须在 {QUIRK_MIN_CHARS}–{QUIRK_MAX_CHARS} 字"
    if "\n" in value or "#" in value or "```" in value:
        return "口癖不能含换行、# 或代码块"
    if BLOCK_RE.search(value) or HARD_HEADING_RE.search(value):
        return "口癖命中隐私/提示词/硬规则闸"
    return ""


def add_quirk(text: Any, *, actor: str, archive_id: str = "", proposal: dict[str, Any] | None = None) -> dict[str, Any]:
    value = str(text or "").strip()
    detail = validate_quirk(value)
    if detail:
        return _fail("value-out-of-range", detail)
    spec = read_output_spec()
    active, archived = _active(spec), _archived(spec)
    if any(str(row.get("text") or "") == value for row in active):
        return _ok("duplicate-noop", "这条口癖已经在用，不重复新增")
    state = _read_state()
    recent_added = _recent([item.split("|", 1)[0] for item in state["quirks"].get("added") or []], 24)
    if len(recent_added) >= QUIRK_NEW_PER_DAY:
        return _fail("rate-limited", f"24h 内最多新增 {QUIRK_NEW_PER_DAY} 条口癖")
    for item in state["quirks"].get("added") or []:
        stamp, _, old = str(item).partition("|")
        if old == value and stamp in _recent([stamp], 24 * QUIRK_DUPLICATE_DAYS):
            return _ok("duplicate-noop", f"「{value}」7 天内刚加过，不重复新增")
    if len(active) >= QUIRK_MAX_ACTIVE:
        if not archive_id:
            return _fail(
                "value-out-of-range",
                f"active 已满 {QUIRK_MAX_ACTIVE} 条，新增必须同时归档一条（archiveId）",
            )
        target = next((row for row in active if str(row.get("id") or "") == archive_id), None)
        if target is None:
            return _fail("value-out-of-range", f"要归档的口癖不存在：{archive_id}")
        active = [row for row in active if str(row.get("id") or "") != archive_id]
        archived = archived + [{**target, "archivedAt": store.now_iso()}]
    if len(active) + len(archived) >= QUIRK_MAX_TOTAL:
        return _fail("value-out-of-range", f"口癖总数已达上限 {QUIRK_MAX_TOTAL} 条")
    entry = {
        "id": f"q-{int(time.time() * 1000):x}",
        "text": value,
        "addedAt": store.now_iso(),
        "lastHitAt": "",
    }
    active = active + [entry]
    out = write_output_spec(
        {"quirks.active": active, "quirks.archived": archived},
        actor=actor,
        proposal=proposal,
    )
    if out.get("ok"):
        _record_quirk("added", value)
        if archive_id:
            _record_quirk("archived", archive_id)
        out["quirkId"] = entry["id"]
        out["quirk"] = value
    return out


def archive_quirk(quirk_id: Any, *, actor: str, proposal: dict[str, Any] | None = None) -> dict[str, Any]:
    target = str(quirk_id or "").strip()
    spec = read_output_spec()
    active, archived = _active(spec), _archived(spec)
    hit = next((row for row in active if str(row.get("id") or "") == target), None)
    if hit is None:
        return _fail("value-out-of-range", f"active 里没有这条口癖：{target}")
    state = _read_state()
    recent = _recent([item.split("|", 1)[0] for item in state["quirks"].get("archived") or []], 24)
    if len(recent) >= QUIRK_ARCHIVE_PER_DAY:
        return _fail("rate-limited", f"24h 内最多归档 {QUIRK_ARCHIVE_PER_DAY} 次")
    out = write_output_spec(
        {
            "quirks.active": [row for row in active if row is not hit],
            "quirks.archived": archived + [{**hit, "archivedAt": store.now_iso()}],
        },
        actor=actor,
        proposal=proposal,
    )
    if out.get("ok"):
        _record_quirk("archived", target)
    return out


# --------------------------------------------------------------------------- #
# 应用 / 回滚
# --------------------------------------------------------------------------- #
def apply_tune(
    proposal: dict[str, Any], actor: str = "master", *, auto: bool = False
) -> dict[str, Any]:
    """`tune` 提案的唯一入口。auto=True 只允许 M 档，D 档一律 tier-readonly。"""
    payload = proposal.get("payload") if isinstance(proposal.get("payload"), dict) else {}
    key = str(payload.get("key") or "")
    if key == "":
        return _fail("unknown-key", "提案里没有 key")
    if auto and key not in TUNE_KEYS:
        return _fail("tier-readonly", f"{key} 不在自动可写范围", tier="D", key=key)
    # 并发保护：提案之后目标文件被改过（人工编辑 / 另一次 apply）就放弃，不覆盖
    expected_hash = str(proposal.get("beforeHash") or "")
    if expected_hash and store.file_hash(target_path(key)) != expected_hash:
        return _fail("stale-file", "目标文件在提案之后被改过，放弃本次写入", key=key)

    if key == "dnd":
        current = current_value("dnd")
        verdict = resolve_dnd(
            payload.get("start"),
            payload.get("end"),
            current.get("start") if isinstance(current, dict) else "",
            current.get("end") if isinstance(current, dict) else "",
        )
        if not verdict.get("ok"):
            store.audit(
                {
                    "policyVersion": POLICY_VERSION,
                    "action": "deny-range",
                    "actor": actor,
                    "proposalId": proposal.get("id"),
                    "key": "dnd",
                    "tier": "M",
                    "decision": "deny",
                    "code": verdict.get("code"),
                    "detail": verdict.get("detail"),
                }
            )
            return verdict
        allowed, why = _rate_ok("dnd", 1)
        if not allowed:
            return _fail("rate-limited", why, key="dnd")
        out = write_config_fields(
            {"dnd.start": verdict["start"], "dnd.end": verdict["end"]},
            actor=actor,
            proposal=proposal,
        )
        if out.get("ok"):
            _record_key("dnd")
            proposal["before"] = {"dnd.start": current.get("start"), "dnd.end": current.get("end")}
        return out

    if key in NUMERIC_RULES:
        current = current_value(key)
        verdict = resolve(key, payload.get("value"), current)
        if not verdict.get("ok"):
            store.audit(
                {
                    "policyVersion": POLICY_VERSION,
                    "action": "deny-range",
                    "actor": actor,
                    "proposalId": proposal.get("id"),
                    "key": key,
                    "tier": "M",
                    "decision": "deny",
                    "code": verdict.get("code"),
                    "detail": verdict.get("detail"),
                }
            )
            return verdict
        value = verdict["normalized"]
        if NUMERIC_RULES[key]["file"] == "config":
            allowed, why = _rate_ok(key, 2)
            if not allowed:
                return _fail("rate-limited", why, key=key)
            out = write_config_fields({key: value}, actor=actor, proposal=proposal)
            if out.get("ok"):
                _record_key(key)
                proposal["before"] = {key: current}
        else:
            out = write_output_spec({key: value}, actor=actor, proposal=proposal)
            if out.get("ok"):
                proposal["before"] = {key: current}
        return out

    if key == "quirks.add":
        out = add_quirk(
            payload.get("text"),
            actor=actor,
            archive_id=str(payload.get("archiveId") or ""),
            proposal=proposal,
        )
        if out.get("ok"):
            proposal["before"] = {"quirks.add": ""}
        return out
    if key == "quirks.archive":
        out = archive_quirk(payload.get("quirkId"), actor=actor, proposal=proposal)
        if out.get("ok"):
            proposal["before"] = {"quirks.archive": str(payload.get("quirkId") or "")}
        return out
    return _fail("unknown-key", f"不认识的 tune key：{key}", tier="D", key=key)


def _finish_apply(proposal: dict[str, Any], actor: str, out: dict[str, Any]) -> dict[str, Any]:
    if not out.get("ok"):
        return out
    proposal["status"] = "applied"
    proposal["appliedAt"] = store.now_iso()
    proposal["appliedBy"] = actor
    proposal["beforeHash"] = out.get("beforeHash", "")
    proposal["afterHash"] = out.get("afterHash", "")
    proposal["backupPath"] = out.get("backupPath", "")
    proposal["effect"] = out.get("mode", "")
    proposal["applyCode"] = out.get("code", "")
    store.save_proposal(proposal)
    return out


def apply_tune_with_status(
    proposal: dict[str, Any], actor: str = "master", *, auto: bool = False
) -> dict[str, Any]:
    out = apply_tune(proposal, actor, auto=auto)
    return _finish_apply(proposal, actor, out)


def rollback_tune(proposal: dict[str, Any], actor: str = "master") -> dict[str, Any]:
    """按目标分策略：config 只回写 before 值；output-spec 整文件快照覆盖。"""
    if proposal.get("status") != "applied":
        return {"ok": False, "reason": "status-" + str(proposal.get("status"))}
    payload = proposal.get("payload") if isinstance(proposal.get("payload"), dict) else {}
    key = str(payload.get("key") or "")
    before = proposal.get("before") if isinstance(proposal.get("before"), dict) else {}
    if not before:
        return _rollback_failed(proposal, actor, "revert-blocked", "提案里没有 before 值，无法复原")
    path = target_path(key)
    current_hash = store.file_hash(path)
    if proposal.get("afterHash") and current_hash != proposal.get("afterHash"):
        return _rollback_failed(
            proposal, actor, "revert-blocked", "当前文件已不是应用后的版本，拒绝覆盖", currentHash=current_hash
        )

    if key == "dnd" or NUMERIC_RULES.get(key, {}).get("file") == "config":
        if key == "dnd":
            fields = {"dnd.start": before.get("dnd.start"), "dnd.end": before.get("dnd.end")}
        else:
            fields = {key: before.get(key)}
        out = write_config_fields(fields, actor=actor, proposal=proposal)
        if not out.get("ok"):
            return out
        if key == "dnd":
            restored = current_value("dnd")
            same = (
                str(restored.get("start") or "") == str(fields["dnd.start"] or "")
                and str(restored.get("end") or "") == str(fields["dnd.end"] or "")
            )
        else:
            same = current_value(key) == fields[key]
        if not same:
            return _rollback_failed(proposal, actor, "revert-blocked", "回写后读到的值与 before 不一致")
        proposal["status"] = "rolledback"
        proposal["rolledBackAt"] = store.now_iso()
        proposal["rolledBackBy"] = actor
        store.save_proposal(proposal)
        store.audit(
            {
                "policyVersion": POLICY_VERSION,
                "action": "rollback",
                "actor": actor,
                "proposalId": proposal.get("id"),
                "key": ",".join(sorted(fields)),
                "tier": "M",
                "decision": "rollback",
                "code": "rolledback",
                "file": os.path.basename(path),
                "after": fields,
            }
        )
        return {"ok": True, "restored": fields, "mode": out.get("mode")}

    # output-spec：整文件快照覆盖，要求备份哈希 == beforeHash
    backup_path = str(proposal.get("backupPath") or "")
    expected = str(proposal.get("beforeHash") or "")
    if backup_path == "" or not os.path.exists(backup_path):
        if expected == "" and not os.path.exists(path):
            proposal["status"] = "rolledback"
            proposal["rolledBackAt"] = store.now_iso()
            proposal["rolledBackBy"] = actor
            store.save_proposal(proposal)
            return {"ok": True, "restoredHash": ""}
        return _rollback_failed(proposal, actor, "revert-blocked", "没有可用的备份文件")
    backup_hash = store.file_hash(backup_path)
    if expected and backup_hash != expected:
        return _rollback_failed(
            proposal, actor, "revert-blocked", "备份哈希与 beforeHash 不一致", backupHash=backup_hash
        )
    _write_bytes_atomic(path, _read_bytes(backup_path))
    restored_hash = store.file_hash(path)
    if expected and restored_hash != expected:
        return _rollback_failed(proposal, actor, "revert-blocked", "覆盖后哈希与 beforeHash 不一致")
    proposal["status"] = "rolledback"
    proposal["rolledBackAt"] = store.now_iso()
    proposal["rolledBackBy"] = actor
    store.save_proposal(proposal)
    store.audit(
        {
            "policyVersion": POLICY_VERSION,
            "action": "rollback",
            "actor": actor,
            "proposalId": proposal.get("id"),
            "key": key,
            "tier": "M",
            "decision": "rollback",
            "code": "rolledback",
            "file": os.path.basename(path),
            "restoredHash": restored_hash,
        }
    )
    return {"ok": True, "restoredHash": restored_hash}


def _rollback_failed(
    proposal: dict[str, Any], actor: str, reason: str, detail: str, **extra: Any
) -> dict[str, Any]:
    proposal["rollbackError"] = {
        "at": store.now_iso(),
        "actor": actor,
        "reason": reason,
        "detail": detail,
        **extra,
    }
    store.save_proposal(proposal)
    store.audit(
        {
            "policyVersion": POLICY_VERSION,
            "proposalId": proposal.get("id"),
            "action": "rollback-failed",
            "actor": actor,
            "reason": reason,
            "detail": detail,
            **extra,
        }
    )
    return {"ok": False, "reason": reason, "detail": detail, "status": proposal.get("status"), **extra}
