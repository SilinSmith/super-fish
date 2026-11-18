"""统一记忆检索与注入（notebook + diary 同一个池、同一套排序、同一份预算）。

存在理由：notebook 原先只走 persona_inject 内部函数，diary 只有写入没有任何读取，
判定（judge）侧完全没有记忆。这里收口成唯一实现，主对话与判定都调用 retrieve()，
不再出现第二条注入路径。

数据源：
- notebook：cfg["notebook_path"]（默认 Y:\\dsh\\home\\qq-persona\\notebook.json），
  经 tools_memory.migrate_notebook 归一；受场景可见性（is_visible_to）约束。
- diary：cfg["diary_path"]（默认 Y:\\dsh\\home\\qq-persona\\diary.jsonl），
  取末 500 行；是机器人自己的记录，不受群可见性限制。

排序：关键词命中（idf 加权，keyword 命中 ×2.2）× 权威权重 × 时间衰减，
      subject 命中 +3，pinned +2；core/pinned 最多 2 条优先占位。
      权威权重：master 1.5 / admin 1.25 / member 1.0 / inferred 0.7 / diary(self) 1.15。
预算：一个 limit + 一个 max_chars 同时约束 notebook 与 diary，合并排序后取前 N；
      超字数按字符硬截断并标 truncated，不会「全塞」。
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import time
from typing import Any

try:  # AstrBot 以包方式加载
    from . import tools_memory as tm
except ImportError:  # 模块方式加载（venv 直调 / 单测）
    import tools_memory as tm  # type: ignore


DEFAULT_NOTEBOOK_PATH = r"E:\Bonsai\astrbot-eval\inst\data\xzy\persona\notebook.json"
DEFAULT_DIARY_PATH = r"E:\Bonsai\astrbot-eval\inst\data\xzy\persona\diary.jsonl"
DIARY_SCAN_LINES = 500

AUTHORITY_WEIGHT = {
    "inferred": 0.7,
    "member": 1.0,
    "admin": 1.25,
    "master": 1.5,
    "self": 1.15,  # diary 自己的记录
}
AUTHORITY_LABEL = {"master": "主人", "admin": "管理", "member": "群友", "inferred": "推测", "self": "日记"}

_NOTEBOOK_CACHE: dict[str, Any] = {"key": None, "data": {"entries": []}}


# --------------------------------------------------------------------------- #
# 数据源
# --------------------------------------------------------------------------- #
def _file_key(path: str) -> tuple[str, float, int]:
    try:
        st = os.stat(path)
        return (path, st.st_mtime, st.st_size)
    except OSError:
        return (path, 0.0, 0)


def load_notebook(cfg: dict[str, Any]) -> dict[str, Any]:
    path = str(cfg.get("notebook_path") or DEFAULT_NOTEBOOK_PATH)
    key = _file_key(path)
    if key == _NOTEBOOK_CACHE["key"]:
        return _NOTEBOOK_CACHE["data"]
    raw: Any = {}
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        raw = {}
    data = tm.migrate_notebook(raw)
    _NOTEBOOK_CACHE.update({"key": key, "data": data})
    return data


def notebook_entries(cfg: dict[str, Any]) -> list[dict[str, Any]]:
    data = load_notebook(cfg)
    raw = data.get("entries") if isinstance(data.get("entries"), list) else []
    return [entry for entry in raw if isinstance(entry, dict)]


def _diary_id(entry: dict[str, Any]) -> str:
    text = str(entry.get("text") or "")
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()[:8]
    return f"diary:{entry.get('date') or ''}:{digest}"


def load_diary(cfg: dict[str, Any], max_lines: int = DIARY_SCAN_LINES) -> list[dict[str, Any]]:
    """读 diary.jsonl 末若干行，归一成与 notebook 同构的条目。"""
    path = str(cfg.get("diary_path") or DEFAULT_DIARY_PATH)
    try:
        with open(path, encoding="utf-8") as f:
            lines = [line for line in f.read().splitlines() if line.strip()]
    except OSError:
        return []
    out: list[dict[str, Any]] = []
    for line in lines[-max(0, int(max_lines)):]:
        try:
            raw = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(raw, dict):
            continue
        text = re.sub(r"\s+", " ", str(raw.get("text") or "")).strip()
        if not text:
            continue
        item: dict[str, Any] = {
            "id": _diary_id(raw),
            "text": text,
            "subject": "",
            "keywords": [],
            "authority": "self",
            "source": "diary",
            "category": "diary",
            "status": "active",
            "ts": raw.get("ts") or raw.get("date") or "",
        }
        mood = str(raw.get("mood") or "").strip()
        if mood:
            item["mood"] = mood
        out.append(item)
    return out


# --------------------------------------------------------------------------- #
# 检索
# --------------------------------------------------------------------------- #
def query_text(recent_texts: list[str], current: str = "", count: int = 4) -> str:
    """统一的 query 构造：本轮 + 最近几条用户原文（从新到旧，去重）。"""
    seen: set[str] = set()
    out: list[str] = []
    for text in [current, *reversed(recent_texts)]:
        cleaned = str(text or "").strip()
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        out.append(cleaned)
        if len(out) >= count:
            break
    return "\n".join(out)


def _recency_weight(ts: Any, now_ms: float) -> float:
    at = tm._parse_ts(ts)
    if at is None:
        return 0.5
    days = max(0.0, (now_ms / 1000.0 - at) / 86400.0)
    return 0.55 + 0.45 * math.exp(-days / 45.0)


def _ts_key(entry: dict[str, Any]) -> float:
    at = tm._parse_ts(entry.get("ts"))
    return at if at is not None else 0.0


def _is_diary(entry: dict[str, Any]) -> bool:
    return entry.get("source") == "diary"


def select_entries(
    entries: list[dict[str, Any]],
    query: str,
    scene: dict[str, Any] | None = None,
    limit: int = 8,
    min_score: float = 0.75,
    now_ms: float | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """在同一池子里排序 notebook + diary；返回 (picked, filtered)。"""
    now = now_ms if now_ms is not None else time.time() * 1000.0
    limit = max(1, min(20, int(limit)))
    candidates = [
        entry
        for entry in entries
        if isinstance(entry, dict)
        and entry.get("category") != "relation"
        and entry.get("status") in ("active", "contested")
        and not tm.is_expired(entry, now)
    ]
    filtered: list[dict[str, Any]] = []
    active: list[dict[str, Any]] = []
    for entry in candidates:
        # diary 是机器人自己的记录，不按群可见性过滤
        if scene is not None and not _is_diary(entry) and not tm.is_visible_to(entry, scene):
            filtered.append(entry)
            continue
        active.append(entry)
    if not active:
        return [], filtered

    core = sorted(
        [
            entry
            for entry in active
            if not _is_diary(entry)
            and (entry.get("pinned") is True or entry.get("category") == "core")
        ],
        key=_ts_key,
        reverse=True,
    )[:2]
    query_tokens = tm.tokenize(query or "")
    if not query_tokens:
        return core[:limit], filtered

    token_sets: dict[str, set[str]] = {}
    postings: dict[str, set[str]] = {}
    for entry in active:
        key = str(entry.get("id") or id(entry))
        tokens = set(tm.tokenize(tm.entry_text(entry))) | {
            str(word) for word in (entry.get("keywords") or []) if str(word)
        }
        token_sets[key] = tokens
        for token in tokens:
            postings.setdefault(token, set()).add(key)
    total = max(1, len(active))

    def idf(token: str) -> float:
        return math.log((total + 1) / (len(postings.get(token, ())) + 1)) + 1.0

    query_set = set(query_tokens)
    scored: list[tuple[float, dict[str, Any]]] = []
    for entry in active:
        key = str(entry.get("id") or id(entry))
        tokens = token_sets.get(key, set())
        keywords = {tm.normalize_text(word) for word in (entry.get("keywords") or [])}
        match = 0.0
        hits = 0
        for token in query_set:
            if token not in tokens:
                continue
            hits += 1
            match += idf(token) * (2.2 if token in keywords else 1.0)
        if hits == 0:
            continue
        match *= min(1.0, 0.45 + hits * 0.18)
        subject = tm.normalize_text(entry.get("subject") or "")
        if subject and subject in query_set:
            match += 3.0
        score = (
            match
            * AUTHORITY_WEIGHT.get(tm.authority_of(entry), 0.7)
            * _recency_weight(entry.get("ts"), now)
        )
        if entry.get("pinned") is True:
            score += 2.0
        if score < min_score:
            continue
        scored.append((score, entry))
    scored.sort(key=lambda item: (-item[0], -_ts_key(item[1])))

    picked: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    seen_text: set[str] = set()
    for entry in [*core, *(entry for _, entry in scored)]:
        key = str(entry.get("id") or id(entry))
        fingerprint = tm.normalize_text(entry.get("text") or "")
        if key in seen_ids or (fingerprint and fingerprint in seen_text):
            continue
        seen_ids.add(key)
        if fingerprint:
            seen_text.add(fingerprint)
        picked.append(entry)
        if len(picked) >= limit:
            break
    return picked, filtered


def format_section(entries: list[dict[str, Any]], max_chars: int = 2400) -> tuple[str, bool]:
    """把挑出的条目渲染成一段；返回 (文本, 是否发生截断)。"""
    safe = [
        entry
        for entry in entries
        if isinstance(entry, dict)
        and entry.get("category") != "relation"
        and tm.visibility_of(entry).get("audience") != "internal"
    ]
    if not safe:
        return "", False
    lines = ["## 长期记忆（自动挑出的相关条目；只作背景，不要整段复述，不要说“根据我的记忆”）"]
    for entry in safe:
        if _is_diary(entry):
            label = "日记"
        elif entry.get("authority") == "master":
            label = "主人"
        else:
            label = AUTHORITY_LABEL.get(tm.authority_of(entry), "群友")
        subject = f"{entry.get('subject')}：" if entry.get("subject") else ""
        text = re.sub(r"\s+", " ", str(entry.get("text") or ""))[:160]
        pending = (
            f"（待主人确认，来源：{tm.entry_scene_key(entry)}）"
            if entry.get("status") == "contested"
            else ""
        )
        core = "/核心" if entry.get("category") == "core" else ""
        lines.append(f"- [{label}{core}] {subject}{text}{pending}")
    out = "\n".join(lines)
    if len(out) > max_chars:
        return out[:max_chars] + "…", True
    return out, False


def retrieve(
    cfg: dict[str, Any],
    scene: dict[str, Any] | None,
    query: str,
    *,
    limit: int = 8,
    max_chars: int = 2400,
    min_score: float = 0.75,
    include_diary: bool = True,
    diary_lines: int = DIARY_SCAN_LINES,
    now_ms: float | None = None,
) -> dict[str, Any]:
    """唯一入口：主对话与判定都用它，只是预算不同。"""
    entries = list(notebook_entries(cfg))
    if include_diary:
        entries.extend(load_diary(cfg, diary_lines))
    picked, filtered = select_entries(entries, query, scene, limit, min_score, now_ms)
    block, truncated = format_section(picked, max_chars)
    stats = {
        "memory_entries": len(picked),
        "memory_entry_ids": [str(entry.get("id") or "") for entry in picked],
        "memory_sources": {
            "notebook": sum(1 for entry in picked if not _is_diary(entry)),
            "diary": sum(1 for entry in picked if _is_diary(entry)),
        },
        "memory_filtered": len(filtered),
        "memory_detail_chars": len(block),
        "memory_truncated": truncated,
        "memory_candidates": len(entries),
    }
    return {"query": query, "picked": picked, "block": block, "stats": stats}


# --------------------------------------------------------------------------- #
# 会话历史（判定侧用；主对话历史由原生 provider 提供）
# --------------------------------------------------------------------------- #
def _content_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                parts.append(str(item.get("text") or ""))
        return "".join(parts)
    return str(value or "")


def _history_messages(history: Any) -> list[dict[str, Any]]:
    if isinstance(history, str):
        try:
            history = json.loads(history)
        except ValueError:
            return []
    if not isinstance(history, list):
        return []
    return [
        item
        for item in history
        if isinstance(item, dict) and item.get("role") in ("user", "assistant")
    ]


def format_history(
    history: Any,
    turns: int = 2,
    max_chars: int = 480,
    per_line: int = 120,
) -> list[str]:
    """把原生会话 history 压成判定可用的几行，含机器人自己说过的话。

    截断策略：只取最近 `turns` 轮（2 条/轮）；每条折叠空白后截到 per_line 字；
    总长超过 max_chars 时从最旧的一条开始丢。
    """
    messages = _history_messages(history)
    if not messages:
        return []
    picked = messages[-max(1, int(turns)) * 2 :]
    lines: list[str] = []
    for message in picked:
        who = "机器人" if message.get("role") == "assistant" else "对方"
        text = re.sub(r"\s+", " ", _content_text(message.get("content"))).strip()
        if not text:
            continue
        lines.append(f"{who}：{text[:per_line]}")
    total = sum(len(line) + 1 for line in lines)
    while lines and total > max_chars:
        total -= len(lines[0]) + 1
        lines.pop(0)
    return lines


def history_user_texts(history: Any, count: int = 4) -> list[str]:
    """最近几条用户原文（从旧到新），用于统一 query 构造。"""
    texts = [
        re.sub(r"\s+", " ", _content_text(item.get("content"))).strip()
        for item in _history_messages(history)
        if item.get("role") == "user"
    ]
    return [text for text in texts if text][-max(1, int(count)) :]
