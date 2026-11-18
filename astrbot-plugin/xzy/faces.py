"""QQ 原生表情（face 段）的 id ↔ 中文名映射，以及正文表情标记的解析。

为什么要有这个：AstrBot 的 aiocqhttp 适配层把 `{'type': 'face', 'data': {'id': '32'}}`
转成 `Face(id=32)` 组件，id 是全的；但插件的入站归一化只按组件类型兜底成 `[Face]`，
id 在这里被丢掉，模型只能看到「有个表情」而看不到是哪个表情（真实样本见
audit/inbound.jsonl 行 549/646）。

数据文件 `faces.json` 由所使用的 OneBot 协议端落盘的 QQ 官方系统表情目录导出
（协议端通过 QQ sysface 接口拉取），id 与 `[CQ:face,id=N]` 同一个空间，
名称是目录里的 qDes 去掉 QQ 的前缀 `/`，不是自己编的 id。导出方法见 docs/faces.md。
增补直接改 faces.json 的 `faces`，本模块按 mtime 热加载。

读的方向（入站）：命中 → `[表情:汪汪]`；未收录 → `[表情:id=123]`（保留原始 id，
事后能拿真实记录补表）；没有 id → `[表情]`。

写的方向（出站）：模型正文里写 `[表情:汪汪]`，`tokens()` 反向查表得到 id，
由出站层换成真正的 face 段；名字查不到就原样留在文本里（不瞎发），
`[表情:277]` 这种纯数字写法按 id 直查同一张表。
"""

from __future__ import annotations

import json
import os
import re
from typing import Any

FACES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "faces.json")

# 模型正文里的表情标记；名字限 1~12 字，不跨行、不嵌套方括号
MARK_RE = re.compile(r"\[表情[:：]([^\[\]\r\n]{1,12})\]")

_state: dict[str, Any] = {"mtime": -1.0, "faces": {}, "by_name": {}}


def _load() -> dict[str, str]:
    """读 faces.json；文件缺失/损坏时退回上一份有效表，不抛给调用方。"""
    try:
        mtime = os.path.getmtime(FACES_PATH)
    except OSError:
        return _state["faces"]
    if mtime == _state["mtime"]:
        return _state["faces"]
    try:
        with open(FACES_PATH, encoding="utf-8") as f:
            payload = json.load(f)
    except (OSError, ValueError):
        return _state["faces"]
    raw = payload.get("faces") if isinstance(payload, dict) else None
    if not isinstance(raw, dict):
        return _state["faces"]
    table = {
        str(k).strip(): str(v).strip()
        for k, v in raw.items()
        if str(k).strip() and str(v).strip()
    }
    by_name: dict[str, str] = {}
    for fid, name in table.items():  # 同名多 id 时取最小的 id（表已按 id 升序）
        by_name.setdefault(name, fid)
    _state["mtime"] = mtime
    _state["faces"] = table
    _state["by_name"] = by_name
    return table


def name(face_id: Any) -> str:
    key = str(face_id if face_id is not None else "").strip()
    return _load().get(key, "") if key else ""


def label(face_id: Any) -> str:
    key = str(face_id if face_id is not None else "").strip()
    if not key:
        return "[表情]"
    hit = _load().get(key)
    return f"[表情:{hit}]" if hit else f"[表情:id={key}]"


def id_of(token: Any) -> str:
    """名字或纯数字 id → id；查不到返回空串（调用方据此退回纯文本）。"""
    key = str(token if token is not None else "").strip()
    if not key:
        return ""
    table = _load()
    if key.isdigit():
        return key if key in table else ""
    return _state["by_name"].get(key, "")


def tokens(text: str) -> list[tuple[str, str]]:
    """把正文切成 [("text", 原文) | ("face", id)]，相邻文本已合并。

    名字查不到的标记不删，原样并进文本，保证「不瞎发」且用户还能看见原话。
    """
    raw = text or ""
    out: list[tuple[str, str]] = []
    pos = 0
    for m in MARK_RE.finditer(raw):
        if m.start() > pos:
            out.append(("text", raw[pos:m.start()]))
        fid = id_of(m.group(1))
        out.append(("face", fid) if fid else ("text", m.group(0)))
        pos = m.end()
    if pos < len(raw):
        out.append(("text", raw[pos:]))
    merged: list[tuple[str, str]] = []
    for kind, value in out:
        if kind == "text" and merged and merged[-1][0] == "text":
            merged[-1] = ("text", merged[-1][1] + value)
        else:
            merged.append((kind, value))
    return merged


def merge_mark_only_parts(parts: list[str]) -> list[str]:
    """拆条后不让「只有表情」的碎片单独成条：并到相邻的文本段上。"""
    out: list[str] = []
    pending = ""
    for part in parts:
        part = part or ""
        if MARK_RE.sub("", part).strip():
            out.append(pending + part)
            pending = ""
        elif out:
            out[-1] += part
        else:
            pending += part
    if pending:
        if out:
            out[-1] += pending
        else:
            out.append(pending)
    return out
