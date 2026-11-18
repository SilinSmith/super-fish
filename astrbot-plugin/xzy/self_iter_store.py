"""自迭代落盘层（迁移自 Y:\\dsh\\home\\qq-persona\\self-iter\\store.mjs）。

约定与旧栈保持一致：
- 所有 JSON 写入都走「临时文件 + os.replace」原子替换，或 append-only jsonl；
- 运行锁「缺了就建」（open(..., "x")）；持有 pid 已不存活或已过期时清掉重建，
  不是「缺了就跳过」；
- 提案目录 / 备份目录 / ledger / lock 默认落在人格目录下的 `self-iter/`，
  与旧 Node 实现同一套文件，可被任一侧读取、接管与回滚。

本模块只负责读写，不做「该不该跑」「该不该应用」的判定（在 self_iter.py）。
"""

from __future__ import annotations

import ctypes
import hashlib
import json
import os
import random
import re
import threading
import time
from typing import Any

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_ROOT = os.path.abspath(os.path.join(PLUGIN_DIR, "..", ".."))
STATE_DIR = os.path.join(DATA_ROOT, "xzy")

DEFAULT_PERSONA_PATH = r"E:\Bonsai\astrbot-eval\inst\data\xzy\persona\character.md"
DEFAULT_NOTEBOOK_PATH = r"E:\Bonsai\astrbot-eval\inst\data\xzy\persona\notebook.json"

DEFAULT_GATES: dict[str, Any] = {
    "maxFindings": 3,
    "maxNotebookPerRun": 3,
    "maxNotebookPerDay": 6,
    "maxCharacterPerDay": 1,
    "maxCharacterChars": 400,
    "maxExampleChars": 60,
    "minConfidence": 0.55,
}

CFG: dict[str, Any] = {}
_APPEND_LOCK = threading.Lock()


def configure(cfg: dict[str, Any]) -> None:
    """由宿主整合方传入整份插件配置（与 tools_memory.configure 同口径）。"""
    CFG.clear()
    CFG.update(cfg or {})


# --------------------------------------------------------------------------- #
# 配置归一化
# --------------------------------------------------------------------------- #
def _int(value: Any, default: int, low: int = 1, high: int = 2**31 - 1) -> int:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return default
    return max(low, min(high, parsed))


def _num(value: Any, default: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    if parsed != parsed:  # NaN
        return default
    return parsed


def _clamp01(value: Any, default: float) -> float:
    return min(1.0, max(0.0, _num(value, default)))


def self_iter_config() -> dict[str, Any]:
    raw = CFG.get("self_iter")
    source = raw if isinstance(raw, dict) else {}
    gates_raw = source.get("gates") if isinstance(source.get("gates"), dict) else {}
    gates = {
        "maxFindings": _int(gates_raw.get("maxFindings"), DEFAULT_GATES["maxFindings"]),
        "maxNotebookPerRun": _int(gates_raw.get("maxNotebookPerRun"), DEFAULT_GATES["maxNotebookPerRun"]),
        "maxNotebookPerDay": _int(gates_raw.get("maxNotebookPerDay"), DEFAULT_GATES["maxNotebookPerDay"]),
        "maxCharacterPerDay": _int(gates_raw.get("maxCharacterPerDay"), DEFAULT_GATES["maxCharacterPerDay"]),
        "maxCharacterChars": _int(gates_raw.get("maxCharacterChars"), DEFAULT_GATES["maxCharacterChars"], 40),
        "maxExampleChars": _int(gates_raw.get("maxExampleChars"), DEFAULT_GATES["maxExampleChars"], 10),
        "minConfidence": _clamp01(gates_raw.get("minConfidence"), DEFAULT_GATES["minConfidence"]),
    }
    return {
        "enabled": source.get("enabled") is not False,
        # 灰度期：notebook 由 qq_notebook 唯一写，self_iter 只出提案；
        # 自动 apply 默认关闭，只有主人手动 self_iter_apply 能落盘。
        "auto_apply": source.get("auto_apply") is True,
        "data_dir": str(source.get("data_dir") or ""),
        "proposals_dir": str(source.get("proposals_dir") or ""),
        "backups_dir": str(source.get("backups_dir") or ""),
        "lock_ttl_ms": _int(source.get("lock_ttl_ms"), 10 * 60_000, 60_000, 24 * 3600_000),
        "gates": gates,
    }


# --------------------------------------------------------------------------- #
# 路径
# --------------------------------------------------------------------------- #
def persona_path() -> str:
    return str(CFG.get("persona_path") or DEFAULT_PERSONA_PATH)


def notebook_path() -> str:
    return str(CFG.get("notebook_path") or DEFAULT_NOTEBOOK_PATH)


def data_dir() -> str:
    override = self_iter_config()["data_dir"]
    if override:
        return override
    return os.path.join(os.path.dirname(persona_path()), "self-iter")


def proposals_dir() -> str:
    override = self_iter_config()["proposals_dir"]
    return override or os.path.join(data_dir(), "proposals")


def backups_dir() -> str:
    override = self_iter_config()["backups_dir"]
    return override or os.path.join(data_dir(), "backups")


def ledger_path() -> str:
    return os.path.join(data_dir(), "ledger.jsonl")


def metrics_path() -> str:
    return os.path.join(data_dir(), "metrics.jsonl")


def lock_path() -> str:
    return os.path.join(data_dir(), "run.lock")


# --------------------------------------------------------------------------- #
# 基础读写
# --------------------------------------------------------------------------- #
def read_json(path: str, default: Any = None) -> Any:
    try:
        with open(path, encoding="utf-8-sig") as f:
            return json.load(f)
    except Exception:
        return default


def write_json_atomic(path: str, value: Any) -> None:
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    tmp = f"{path}.tmp-{os.getpid()}-{random.randint(1000, 9999)}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def file_hash(path: str) -> str:
    try:
        with open(path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()
    except OSError:
        return ""


def backup_file(path: str, label: str) -> str:
    os.makedirs(backups_dir(), exist_ok=True)
    stamp = _iso_ms(int(time.time() * 1000)).replace(":", "-").replace(".", "-")
    target = os.path.join(backups_dir(), f"{label}-{stamp}-{os.getpid()}.bak")
    with open(path, "rb") as src, open(target, "wb") as dst:
        dst.write(src.read())
        dst.flush()
        os.fsync(dst.fileno())
    return target


def _iso_ms(ms: int) -> str:
    dt = time.gmtime(ms / 1000)
    return time.strftime("%Y-%m-%dT%H:%M:%S", dt) + f".{ms % 1000:03d}Z"


def now_iso() -> str:
    return _iso_ms(int(time.time() * 1000))


# --------------------------------------------------------------------------- #
# 审计与指标（append-only）
# --------------------------------------------------------------------------- #
def append_jsonl(path: str, entry: dict[str, Any]) -> None:
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    line = json.dumps(entry, ensure_ascii=False) + "\n"
    with _APPEND_LOCK:
        with open(path, "a", encoding="utf-8") as f:
            f.write(line)
            f.flush()
            os.fsync(f.fileno())


def audit(entry: dict[str, Any]) -> None:
    append_jsonl(ledger_path(), {"ts": now_iso(), **entry})


def metric(entry: dict[str, Any]) -> None:
    append_jsonl(metrics_path(), {"ts": now_iso(), **entry})


# --------------------------------------------------------------------------- #
# 运行锁：缺了就建；过期或持有进程已退出则接管
# --------------------------------------------------------------------------- #
if os.name == "nt":
    _KERNEL32 = ctypes.windll.kernel32
    _KERNEL32.OpenProcess.restype = ctypes.c_void_p
    _KERNEL32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    _KERNEL32.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
    _KERNEL32.CloseHandle.argtypes = [ctypes.c_void_p]
else:  # pragma: no cover - 插件实际运行在 Windows
    _KERNEL32 = None

_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_STILL_ACTIVE = 259
_ERROR_ACCESS_DENIED = 5


def _pid_alive(pid: int) -> bool:
    """Windows 上不能用 os.kill(pid, 0)（会终止进程），改走 OpenProcess。"""
    if not isinstance(pid, int) or pid <= 0:
        return False
    if pid == os.getpid():
        return True
    if os.name != "nt":  # pragma: no cover
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    handle = _KERNEL32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
    if not handle:
        # 权限不足说明进程存在（系统进程 / 其他用户），按存活处理
        return _KERNEL32.GetLastError() == _ERROR_ACCESS_DENIED
    try:
        code = ctypes.c_ulong()
        if not _KERNEL32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return False
        return code.value == _STILL_ACTIVE
    finally:
        _KERNEL32.CloseHandle(handle)


def acquire_lock(ttl_ms: int | None = None) -> dict[str, Any]:
    cfg = self_iter_config()
    ttl = _int(ttl_ms if ttl_ms is not None else cfg["lock_ttl_ms"], cfg["lock_ttl_ms"], 1_000)
    now = int(time.time() * 1000)
    lock = {"pid": os.getpid(), "startedAt": now, "expiresAt": now + ttl}
    path = lock_path()
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    for _ in range(2):
        try:
            with open(path, "x", encoding="utf-8") as f:
                f.write(json.dumps(lock) + "\n")
                f.flush()
                os.fsync(f.fileno())
            return {"ok": True, "lock": lock}
        except FileExistsError:
            current = read_json(path, None)
            try:
                expires_at = int((current or {}).get("expiresAt") or 0)
            except (TypeError, ValueError):
                expires_at = 0
            try:
                holder = int((current or {}).get("pid") or 0)
            except (TypeError, ValueError):
                holder = 0
            expired = not isinstance(current, dict) or expires_at < now or not _pid_alive(holder)
            if not expired:
                return {"ok": False, "lock": current}
            try:
                os.unlink(path)
            except OSError:
                pass
    return {"ok": False, "lock": read_json(path, None)}


def release_lock() -> bool:
    current = read_json(lock_path(), None)
    if isinstance(current, dict) and int(current.get("pid") or 0) != os.getpid():
        return False
    try:
        os.unlink(lock_path())
    except OSError:
        pass
    return True


# --------------------------------------------------------------------------- #
# 提案
# --------------------------------------------------------------------------- #
_PROPOSAL_ID_RE = re.compile(r"^si-[a-z0-9-]+$")


def proposal_id(now_ms: int | None = None) -> str:
    ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
    day = time.strftime("%Y%m%d", time.localtime(ms / 1000))
    return f"si-{day}-{str(ms)[-7:]}"


def list_proposals(limit: int = 100) -> list[dict[str, Any]]:
    try:
        names = os.listdir(proposals_dir())
    except OSError:
        return []
    files = sorted(name for name in names if name.endswith(".json"))
    rows: list[dict[str, Any]] = []
    for name in files[-max(1, limit) :]:
        doc = read_json(os.path.join(proposals_dir(), name), None)
        if isinstance(doc, dict):
            rows.append(doc)
    rows.sort(key=lambda item: str(item.get("ts") or ""), reverse=True)
    return rows


def get_proposal(pid: str) -> dict[str, Any] | None:
    if not isinstance(pid, str) or not _PROPOSAL_ID_RE.match(pid):
        return None
    doc = read_json(os.path.join(proposals_dir(), pid + ".json"), None)
    return doc if isinstance(doc, dict) else None


def save_proposal(proposal: dict[str, Any]) -> dict[str, Any]:
    write_json_atomic(os.path.join(proposals_dir(), str(proposal["id"]) + ".json"), proposal)
    return proposal
