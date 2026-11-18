"""草稿本：写进草稿区不等于发送。

为什么要它：`【内心】` 之后如果没有显式正文标签，出站清洗只能「猜」推理在哪结束。
2026-11-15 17:17:31 就猜错了——588 字里的 4 段结论式推理被当正文发进群。
这里提供一块独立缓冲区：模型可以反复改写同一份草稿，最后由 `qq_draft_submit`
显式提交；提交前仍走现有 `outbound_clean` + 幂等台账 + 发送出口，不另开一条链路。

落盘：
- `xzy/drafts/<umo>.json`：当前草稿（version / text / versions 最近 20 版）；
- `xzy/audit/draft.jsonl`：每版写入、丢弃、提交结果（发了/没发/为什么）。
"""

from __future__ import annotations

import json
import os
import re
import time
from typing import Any

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_ROOT = os.path.abspath(os.path.join(PLUGIN_DIR, "..", ".."))
STATE_DIR = os.path.join(DATA_ROOT, "xzy")
DRAFT_DIR = os.path.join(STATE_DIR, "drafts")
AUDIT_PATH = os.path.join(STATE_DIR, "audit", "draft.jsonl")

MAX_VERSIONS = 20

_CFG: dict[str, Any] = {}


def configure(cfg: dict[str, Any] | None = None) -> None:
    _CFG.clear()
    _CFG.update(cfg or {})


def _slug(umo: str) -> str:
    return re.sub(r"[^0-9A-Za-z]+", "_", umo or "unknown").strip("_")[:120] or "unknown"


def _path(umo: str) -> str:
    return os.path.join(DRAFT_DIR, _slug(umo) + ".json")


def _load(umo: str) -> dict[str, Any]:
    try:
        with open(_path(umo), encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def _save(umo: str, data: dict[str, Any]) -> None:
    os.makedirs(DRAFT_DIR, exist_ok=True)
    tmp = _path(umo) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, _path(umo))


def _audit(umo: str, action: str, **fields: Any) -> None:
    row = {
        "wall": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "umo": umo,
        "action": action,
        **fields,
    }
    try:
        os.makedirs(os.path.dirname(AUDIT_PATH), exist_ok=True)
        with open(AUDIT_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    except Exception:  # noqa: BLE001
        pass


def write(umo: str, text: str, note: str = "", source: str = "model") -> dict[str, Any]:
    """覆盖当前草稿为新版本；只落盘，不发。"""
    body = text or ""
    data = _load(umo)
    version = int(data.get("version") or 0) + 1
    versions = list(data.get("versions") or [])
    versions.append(
        {
            "version": version,
            "chars": len(body),
            "note": (note or "")[:200],
            "source": source,
            "text": body[:500],
        }
    )
    _save(
        umo,
        {
            "umo": umo,
            "version": version,
            "text": body,
            "note": (note or "")[:200],
            "source": source,
            "updated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "versions": versions[-MAX_VERSIONS:],
        },
    )
    _audit(
        umo,
        "write",
        version=version,
        chars=len(body),
        source=source,
        note=(note or "")[:200],
        text=body[:500],
    )
    return {"version": version, "chars": len(body), "text": body}


def current(umo: str) -> dict[str, Any]:
    return _load(umo)


def hold(umo: str, text: str, reason: str = "") -> dict[str, Any]:
    """出站清洗拦下的「无标签多段内心」转存为未提交草稿，等模型显式提交。"""
    info = write(umo, text, note=reason, source="held")
    _audit(umo, "hold", version=info["version"], chars=info["chars"], reason=(reason or "")[:200])
    return info


def discard(umo: str, reason: str = "") -> dict[str, Any]:
    data = _load(umo)
    version = int(data.get("version") or 0)
    chars = len(str(data.get("text") or ""))
    _audit(umo, "discard", reason=(reason or "")[:200], version=version, chars=chars)
    _save(umo, {"umo": umo, "version": 0, "text": "", "versions": data.get("versions") or []})
    return {"version": version, "chars": chars}


def submitted(umo: str, version: int, outcome: str, reason: str, text: str, message_id: Any = None) -> None:
    """提交结果落盘：outcome = sent / blocked / dropped。"""
    _audit(
        umo,
        "submit",
        version=version,
        outcome=outcome,
        reason=(reason or "")[:200],
        chars=len(text or ""),
        message_id=message_id,
        text=(text or "")[:500],
    )
