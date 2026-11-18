"""记忆与文本批（原生 FunctionTool）：记事本 / 记忆检索 / 群状态与备注 / 上下文读写 / 人物档案。

语义来源：
- `qq_notebook`、`memory_search`、`qq_profile` 逐条对齐旧栈
  `dsh-onebot-qq/lib/tools.js`（1673 / 1854 / 3084 行附近）；
- 记忆规则逐条移植 `Y:\\dsh\\home\\qq-persona\\memory.mjs`
  （tokenize / migrateNotebook / deriveKeywords / searchEntries / upsertEntry /
  upsertRelation / degradeExpiredRawText / exportNotebookReadOnly / searchHint）；
- 群状态读取对齐 `context-compressor.mjs` 维护的 `group-state/<群号>.json`，
  上下文读取对齐 `conversation-feed.jsonl`（字段：ts/chat/groupId/role/qq/nickname/messageId/text）。

与旧栈的已知差异（单独汇报，不混入“已实现”）：
- 群备注、上下文备注写在本插件自己的 `state_dir`（`group-notes.json` /
  `context-notes.json`），不写 compressor 的 `group-state/*.json`，避免被后台
  压缩器整份覆盖；`conversation-feed.jsonl` 只读，不追加。
- 旧栈用 `chat.activeTurnRole` 判权威，AstrBot 侧没有该字段，改为
  「发送者 == master_qq 视为 master，其余 member」。单轮私聊/群聊等价。
- `qq_diary` / `qq_character_note` 已由 tools_batch1 落地，本批不重复注册。

约束（evidence/tools.md §1）：
- handler 一律返回四态契约 dict，由 `tool_schema.make_tool` 包 `safe_call`；
- 禁止抛异常漏出、禁止返回 None；错误文案全中文；
- 所有写盘走临时文件 + os.replace，声明数 = 注册数。
"""

from __future__ import annotations

import datetime
import functools
import json
import os
import random
import re
import sys
import time
import traceback
from typing import Any

try:
    from . import tool_result as tr
except ImportError:  # AstrBot 以扁平模块方式加载时走这里
    import tool_result as tr  # type: ignore

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_ROOT = os.path.abspath(os.path.join(PLUGIN_DIR, "..", ".."))
STATE_DIR = os.path.join(DATA_ROOT, "xzy")


class _ToolError(ValueError):
    """本模块自己写的、文案可直接给模型看的中文错误（safe_call 会按文案分类）。"""


# --------------------------------------------------------------------------- #
# memory.mjs 常量
# --------------------------------------------------------------------------- #
MASTER_QQ_DEFAULT = "10000"
MASTER_NAME_DEFAULT = "主人"

AUTHORITY_RANK = {"inferred": 0, "member": 1, "admin": 2, "master": 3}
AUTHORITY_WEIGHT = {"inferred": 0.7, "member": 1, "admin": 1.25, "master": 1.5}
CATEGORIES = ["meme", "user", "behavior", "note", "core", "relation", "knowledge"]
SCENE_LEGACY = "legacy"
AUDIENCES = ["public", "scene", "master", "owner", "internal"]
STATUSES = ["active", "superseded", "disputed", "expired", "contested"]

STOP_BIGRAMS = {
    "什么", "怎么", "这个", "那个", "一个", "一下", "我们", "你们", "他们", "她们",
    "现在", "可以", "没有", "知道", "因为", "所以", "但是", "如果", "就是", "还是",
    "这样", "那样", "感觉", "觉得", "然后", "而且", "已经", "自己", "时候", "真的",
    "不是", "不会", "不能", "不要", "应该", "可能", "比较", "有点", "一些", "这种",
}

_CJK_RUN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+")
_ASCII_WORD_RE = re.compile(r"[a-z0-9]+(?:[._+-][a-z0-9]+)*")
_QQ_RE = re.compile(r"\d{5,12}")
_NEGATION_RE = re.compile(r"不是|没有|并非|不对|别再")
_SCENE_RE = re.compile(r"^(group|private):(.+)$")

RELATION_NEUTRAL = 50
RELATION_MAX_DELTA = 3
RELATION_HALF_LIFE_DAYS = 30
RELATION_TONES = ["熟悉", "一般", "生疏"]
RAW_RETENTION_DAYS = 30

CFG: dict[str, Any] = {}


def configure(cfg: dict[str, Any]) -> None:
    CFG.clear()
    CFG.update(cfg or {})


# --------------------------------------------------------------------------- #
# 路径
# --------------------------------------------------------------------------- #
def _notebook_path() -> str:
    path = str(CFG.get("notebook_path") or "")
    return path or os.path.join(r"E:\Bonsai\astrbot-eval\inst\data\xzy\persona", "notebook.json")


def _notebook_archive_path() -> str:
    path = str(CFG.get("notebook_archive_path") or "")
    if path:
        return path
    return os.path.join(os.path.dirname(_notebook_path()), "notebook-archive.jsonl")


def _group_state_dir() -> str:
    path = str(CFG.get("group_state_dir") or "")
    if path:
        return path
    return os.path.join(os.path.dirname(_notebook_path()), "group-state")


def _conversation_feed_path() -> str:
    path = str(CFG.get("conversation_feed_path") or "")
    if path:
        return path
    return os.path.join(os.path.dirname(_notebook_path()), "conversation-feed.jsonl")


def _notes_dir() -> str:
    path = str(CFG.get("state_dir") or "")
    return path or STATE_DIR


def _group_notes_path() -> str:
    return os.path.join(_notes_dir(), "group-notes.json")


def _context_notes_path() -> str:
    return os.path.join(_notes_dir(), "context-notes.json")


def _master_qq() -> str:
    return str(CFG.get("master_qq") or MASTER_QQ_DEFAULT).strip()


def _master_name() -> str:
    return str(CFG.get("master_name") or MASTER_NAME_DEFAULT).strip()


# --------------------------------------------------------------------------- #
# 基础读写
# --------------------------------------------------------------------------- #
def _read_json(path: str, default: Any) -> Any:
    try:
        with open(path, encoding="utf-8-sig") as f:
            return json.load(f)
    except Exception:
        return default


def _write_json_atomic(path: str, data: Any) -> None:
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    tmp = f"{path}.tmp-{os.getpid()}-{random.randint(1000, 9999)}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _append_jsonl(path: str, records: list[dict[str, Any]]) -> None:
    if not records:
        return
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        for record in records:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
        f.flush()


def _now_ms() -> int:
    return int(time.time() * 1000)


def _iso(ms: int | None = None) -> str:
    ms = _now_ms() if ms is None else ms
    dt = datetime.datetime.fromtimestamp(ms / 1000, tz=datetime.timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _parse_ts(value: Any) -> float | None:
    text = str(value or "").strip()
    if text == "":
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    m = re.search(r"([+-]\d{2})(\d{2})$", text)
    if m:
        text = text[: m.start()] + m.group(1) + ":" + m.group(2)
    try:
        return datetime.datetime.fromisoformat(text).timestamp() * 1000
    except ValueError:
        return None


def _int(value: Any, default: int, low: int, high: int) -> int:
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        number = default
    return max(low, min(high, number))


def _num(value: Any, default: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number


def _str_or_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


# --------------------------------------------------------------------------- #
# 文本归一化与分词（memory.mjs 1-102）
# --------------------------------------------------------------------------- #
def halve_width(value: str) -> str:
    out: list[str] = []
    for char in value:
        code = ord(char)
        if 0xFF01 <= code <= 0xFF5E:
            out.append(chr(code - 0xFEE0))
        elif code == 0x3000:
            out.append(" ")
        else:
            out.append(char)
    return "".join(out)


def normalize_text(value: Any) -> str:
    text = halve_width(str(value or "")).lower()
    text = re.sub(r"\[cq:[^\]]*\]", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def tokenize(text: Any) -> list[str]:
    normalized = normalize_text(text)
    tokens: list[str] = []
    seen: set[str] = set()

    def add(token: str) -> None:
        if token and token not in seen:
            seen.add(token)
            tokens.append(token)

    for word in _ASCII_WORD_RE.findall(normalized):
        if len(word) < 2 or word.isdigit():
            continue
        add(word)
    for qq in _QQ_RE.findall(normalized):
        add(qq)
    for run in _CJK_RUN_RE.findall(normalized):
        if len(run) == 1:
            add(run)
            continue
        for index in range(len(run) - 1):
            bigram = run[index : index + 2]
            if bigram not in STOP_BIGRAMS:
                add(bigram)
        if len(run) <= 8:
            add(run)
    return tokens


def bigram_similarity(left: Any, right: Any) -> float:
    a = set(tokenize(left))
    b = set(tokenize(right))
    if not a or not b:
        return 0.0
    return len(a & b) / max(len(a), len(b))


def is_conflict(left: str, right: str) -> bool:
    similarity = bigram_similarity(left, right)
    if similarity >= 0.55:
        return True
    return similarity >= 0.34 and bool(_NEGATION_RE.search(left)) != bool(_NEGATION_RE.search(right))


def authority_of(entry: dict[str, Any]) -> str:
    authority = entry.get("authority")
    return authority if authority in AUTHORITY_RANK else "inferred"


def entry_text(entry: dict[str, Any]) -> str:
    keywords = entry.get("keywords")
    joined = " ".join(str(item) for item in keywords) if isinstance(keywords, list) else ""
    return f"{entry.get('subject') or ''} {entry.get('text') or ''} {joined}"


def is_expired(entry: dict[str, Any], now_ms: float) -> bool:
    if entry.get("status") == "expired":
        return True
    try:
        ttl_hours = float(entry.get("ttlHours"))
    except (TypeError, ValueError):
        return False
    if ttl_hours <= 0:
        return False
    ts = _parse_ts(entry.get("ts"))
    if ts is None:
        return False
    return now_ms - ts >= ttl_hours * 3_600_000


# --------------------------------------------------------------------------- #
# 场景与可见范围（memory.mjs 148-381）
# --------------------------------------------------------------------------- #
def parse_scene_key(value: Any) -> dict[str, str] | None:
    if not isinstance(value, str):
        return None
    m = _SCENE_RE.match(value.strip())
    if not m:
        return None
    return {"sceneKey": f"{m.group(1)}:{m.group(2)}", "chatKind": m.group(1), "chatId": m.group(2)}


def _normalize_sensitivity(value: Any, category: str | None) -> int:
    if value is not None and value != "":
        try:
            number = int(value)
            if 0 <= number <= 3:
                return number
        except (TypeError, ValueError):
            pass
    return 0 if category == "core" else 1


def _normalize_id_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        if isinstance(item, str) and item and item not in out:
            out.append(item)
    return out


def _normalize_history(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    out = []
    for item in value:
        if not isinstance(item, dict):
            continue
        out.append(
            {
                "at": item.get("at") if isinstance(item.get("at"), str) else None,
                "by": item.get("by") if isinstance(item.get("by"), str) else None,
                "from": dict(item.get("from") or {}) if isinstance(item.get("from"), dict) else {},
                "to": dict(item.get("to") or {}) if isinstance(item.get("to"), dict) else {},
                "reason": item.get("reason") if isinstance(item.get("reason"), str) else "",
            }
        )
    return out


def normalize_origin(raw: Any, source: Any, fallback_at: str) -> dict[str, Any]:
    given = raw if isinstance(raw, dict) else {}
    origin_source = source if isinstance(source, dict) else {}
    given_scene = given.get("sceneKey").strip() if isinstance(given.get("sceneKey"), str) else ""
    parsed_given = parse_scene_key(given_scene)
    parsed_source = parse_scene_key(origin_source.get("chatId"))
    given_kind = given.get("chatKind") if given.get("chatKind") in ("group", "private") else None
    given_chat_id = _str_or_none(given.get("chatId"))

    scene_key = parsed_given["sceneKey"] if parsed_given else given_scene
    chat_kind = parsed_given["chatKind"] if parsed_given else given_kind
    chat_id = parsed_given["chatId"] if parsed_given else given_chat_id
    if scene_key == "" and chat_kind is not None and chat_id is not None:
        scene_key = f"{chat_kind}:{chat_id}"
    if scene_key == "" and parsed_source is not None:
        scene_key = parsed_source["sceneKey"]
        chat_kind = parsed_source["chatKind"]
        chat_id = parsed_source["chatId"]
    if scene_key == "":
        scene_key = SCENE_LEGACY
    if chat_kind is None or chat_id is None:
        parsed = parse_scene_key(scene_key)
        if parsed:
            chat_kind, chat_id = parsed["chatKind"], parsed["chatId"]
    at = given.get("at") if isinstance(given.get("at"), str) and _parse_ts(given.get("at")) else fallback_at
    return {
        "sceneKey": scene_key,
        "chatKind": chat_kind,
        "chatId": chat_id,
        "speakerQq": _str_or_none(given.get("speakerQq")) or _str_or_none(origin_source.get("qq")),
        "speakerName": _str_or_none(given.get("speakerName"))
        or _str_or_none(origin_source.get("name"))
        or _str_or_none(origin_source.get("nickname")),
        "messageId": _str_or_none(given.get("messageId")),
        "at": at,
    }


def normalize_visibility(raw: Any, category: str | None) -> dict[str, Any]:
    given = raw if isinstance(raw, dict) else {}
    audience = given.get("audience") if given.get("audience") in AUDIENCES else ("public" if category == "core" else "scene")
    return {
        "audience": audience,
        "sceneBound": given.get("sceneBound") if isinstance(given.get("sceneBound"), bool) else audience != "public",
        "ownerQq": _str_or_none(given.get("ownerQq")),
        "allowedSceneKeys": [
            item for item in given.get("allowedSceneKeys") or [] if isinstance(item, str) and item
        ]
        if isinstance(given.get("allowedSceneKeys"), list)
        else [],
        "allowedUsers": [
            str(item) for item in given.get("allowedUsers") or [] if isinstance(item, (str, int)) and str(item)
        ]
        if isinstance(given.get("allowedUsers"), list)
        else [],
    }


def entry_scene_key(value: dict[str, Any]) -> str:
    origin = value.get("origin")
    scene_key = origin.get("sceneKey") if isinstance(origin, dict) else None
    return scene_key if isinstance(scene_key, str) and scene_key else SCENE_LEGACY


def visibility_of(value: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(value, dict):
        return normalize_visibility(None, None)
    raw: Any = value.get("visibility") if isinstance(value.get("visibility"), dict) else None
    if raw is None and isinstance(value.get("audience"), str):
        raw = value
    visibility = normalize_visibility(raw, value.get("category"))
    if visibility["audience"] == "owner" and visibility["ownerQq"] is None:
        origin = value.get("origin")
        visibility["ownerQq"] = _str_or_none((origin or {}).get("speakerQq")) if isinstance(origin, dict) else None
    return visibility


def _scope_of(value: dict[str, Any]) -> dict[str, Any]:
    if isinstance(value, dict) and isinstance(value.get("visibility"), dict):
        return {"visibility": visibility_of(value), "sceneKey": entry_scene_key(value)}
    return {"visibility": visibility_of(value), "sceneKey": SCENE_LEGACY}


def _is_superset(left: list[str], right: list[str]) -> bool:
    bucket = set(left or [])
    return all(item in bucket for item in (right or []))


def visibility_covers(a: dict[str, Any], b: dict[str, Any]) -> bool:
    left = _scope_of(a)
    right = _scope_of(b)
    va, vb = left["visibility"], right["visibility"]
    if va["audience"] == "public":
        return True
    if va["audience"] != vb["audience"]:
        return False
    if va["audience"] == "owner" and str(va["ownerQq"]) != str(vb["ownerQq"]):
        return False
    if va["audience"] == "scene" and left["sceneKey"] != SCENE_LEGACY and right["sceneKey"] != left["sceneKey"]:
        return False
    if va["sceneBound"] is not False and vb["sceneBound"] is False:
        return False
    return _is_superset(va["allowedSceneKeys"], vb["allowedSceneKeys"]) and _is_superset(
        va["allowedUsers"], vb["allowedUsers"]
    )


def same_scope(left: dict[str, Any], right: dict[str, Any]) -> bool:
    return visibility_covers(left, right) and visibility_covers(right, left)


def is_visible_to(entry: dict[str, Any], scene: dict[str, Any] | None) -> bool:
    visibility = visibility_of(entry)
    if visibility["audience"] == "internal":
        return False
    if not isinstance(scene, dict):
        return True
    scene_key = _str_or_none(scene.get("sceneKey"))
    if scene_key is None:
        return True
    origin_scene = entry_scene_key(entry)
    same_scene = origin_scene == scene_key
    speaker_qq = _str_or_none(scene.get("speakerQq")) or ""
    extra_allowed = scene_key in visibility["allowedSceneKeys"] or (
        speaker_qq != "" and speaker_qq in visibility["allowedUsers"]
    )
    if visibility["audience"] == "public":
        return True
    if visibility["audience"] == "master":
        if scene.get("isMaster") is not True:
            return False
        return visibility["sceneBound"] is not True or same_scene
    if visibility["audience"] == "owner":
        if visibility["ownerQq"] is None or speaker_qq != str(visibility["ownerQq"]):
            return False
        return visibility["sceneBound"] is not True or same_scene
    if same_scene or origin_scene == SCENE_LEGACY:
        return True
    return extra_allowed


def _invisibility_reason(entry: dict[str, Any], scene: dict[str, Any]) -> str:
    visibility = visibility_of(entry)
    speaker_qq = _str_or_none(scene.get("speakerQq")) or ""
    if visibility["audience"] == "master" and scene.get("isMaster") is not True:
        return "need-master"
    if visibility["audience"] == "owner" and (
        visibility["ownerQq"] is None or speaker_qq != str(visibility["ownerQq"])
    ):
        return "need-owner"
    return "scene-mismatch"


def fact_key_of(entry: dict[str, Any]) -> str:
    key = entry.get("factKey")
    if isinstance(key, str) and key:
        return key
    category = entry.get("category") if entry.get("category") in CATEGORIES else "note"
    return f"{category}|{normalize_text(entry.get('subject') or '')}"


# --------------------------------------------------------------------------- #
# 迁移 / 关键词 / 检索（memory.mjs 384-628）
# --------------------------------------------------------------------------- #
def migrate_notebook(raw: Any) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    entries = source.get("entries") if isinstance(source.get("entries"), list) else []
    migrated: list[dict[str, Any]] = []
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict) or not isinstance(entry.get("text"), str) or entry["text"].strip() == "":
            continue
        authority = entry.get("authority") if entry.get("authority") in AUTHORITY_RANK else (
            "master" if isinstance(entry.get("source"), dict) and entry["source"].get("qq") == _master_qq() else "member"
        )
        category = entry.get("category") if entry.get("category") in CATEGORIES else "note"
        ts = entry.get("ts") if isinstance(entry.get("ts"), str) and _parse_ts(entry.get("ts")) else _iso(0)
        subject = entry.get("subject") if isinstance(entry.get("subject"), str) else ""
        origin = normalize_origin(entry.get("origin"), entry.get("source"), ts)
        visibility = visibility_of({**entry, "category": category, "origin": origin})
        keywords = (
            [word for word in entry.get("keywords") if isinstance(word, str)][:24]
            if isinstance(entry.get("keywords"), list)
            else []
        )
        item: dict[str, Any] = {
            "id": entry.get("id") if isinstance(entry.get("id"), str) and entry.get("id") else f"nb_legacy_{index}",
            "ts": ts,
            "category": category,
            "subject": subject,
            "text": entry["text"].strip(),
            "keywords": keywords,
            "authority": authority,
            "confidence": _num(entry.get("confidence"), 1.0 if entry.get("authority") else 0.7),
            "status": entry.get("status") if entry.get("status") in STATUSES else "active",
            "factKey": fact_key_of({**entry, "category": category, "subject": subject}),
            "origin": origin,
            "visibility": visibility,
            "sensitivity": _normalize_sensitivity(entry.get("sensitivity"), category),
            "derivedFrom": _normalize_id_list(entry.get("derivedFrom")),
            "visibilityHistory": _normalize_history(entry.get("visibilityHistory")),
            "ttlHours": float(entry["ttlHours"]) if _num(entry.get("ttlHours"), 0) > 0 else None,
            "pinned": entry.get("pinned") is True,
            "source": dict(entry["source"]) if isinstance(entry.get("source"), dict) else {},
            "recordedBy": dict(entry["recordedBy"]) if isinstance(entry.get("recordedBy"), dict) else None,
            "updatedAt": entry.get("updatedAt") if isinstance(entry.get("updatedAt"), str) else None,
            "supersededBy": _str_or_none(entry.get("supersededBy")),
            "disputedBy": _str_or_none(entry.get("disputedBy")),
            "sourceRevoked": dict(entry["sourceRevoked"]) if isinstance(entry.get("sourceRevoked"), dict) else None,
        }
        if entry.get("needsReview") is True:
            item["needsReview"] = True
        if category == "relation":
            item["score"] = _num(entry.get("score"), 50)
            item["impression"] = (
                entry.get("impression")
                if isinstance(entry.get("impression"), str)
                else item["text"][:80]
            )
            evidence = entry.get("evidence") if isinstance(entry.get("evidence"), list) else []
            item["evidence"] = [
                {
                    "messageId": evidence_item.get("messageId"),
                    "text": str(evidence_item.get("text") or "")[:120],
                    "at": evidence_item.get("at") if isinstance(evidence_item.get("at"), str) else None,
                }
                for evidence_item in evidence[-5:]
                if isinstance(evidence_item, dict)
            ]
        migrated.append(item)
    return {
        "version": 3,
        "entries": migrated,
        "updatedAt": source.get("updatedAt") if isinstance(source.get("updatedAt"), str) else None,
    }


def derive_keywords(entry: dict[str, Any], limit: int = 16) -> list[str]:
    explicit = entry.get("keywords") if isinstance(entry.get("keywords"), list) else []
    tokens = sorted((token for token in tokenize(entry_text(entry)) if len(token) >= 2), key=len, reverse=True)
    out: list[str] = []
    for token in list(explicit) + tokens:
        if not isinstance(token, str) or token == "" or token in out:
            continue
        out.append(token)
        if len(out) >= limit:
            break
    return out


def search_entries(notebook: dict[str, Any], options: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    options = options or {}
    now_ms = _num(options.get("now"), _now_ms())
    limit = _int(options.get("limit"), 10, 1, 50)
    category = options.get("category") if isinstance(options.get("category"), str) else ""
    subject = normalize_text(options.get("subject") or "")
    query = normalize_text(options.get("query") or "")
    raw_entries = notebook.get("entries") if isinstance(notebook.get("entries"), list) else []
    entries = [
        entry
        for entry in raw_entries
        if isinstance(entry, dict)
        and entry.get("status") not in ("superseded", "expired")
        and not is_expired(entry, now_ms)
    ]
    scene = options.get("scene")
    if isinstance(scene, dict):
        entries = [entry for entry in entries if is_visible_to(entry, scene)]
    if category != "":
        entries = [entry for entry in entries if entry.get("category") == category]
    if subject != "":
        entries = [entry for entry in entries if subject in normalize_text(entry.get("subject") or "")]
    if query != "":
        entries = [entry for entry in entries if query in normalize_text(entry_text(entry))]
    return list(reversed(entries[-limit:]))


def memory_index_text(notebook: dict[str, Any], scene: dict[str, Any] | None, max_chars: int = 520) -> str:
    raw_entries = notebook.get("entries") if isinstance(notebook.get("entries"), list) else []
    entries = [
        entry
        for entry in raw_entries
        if isinstance(entry, dict)
        and entry.get("status") in ("active", "contested")
        and entry.get("category") != "relation"
        and (scene is None or is_visible_to(entry, scene))
    ]
    subjects: dict[str, int] = {}
    keywords: dict[str, int] = {}
    for entry in entries:
        subject = str(entry.get("subject") or "").strip()
        if subject:
            subjects[subject] = subjects.get(subject, 0) + 1
        for word in entry.get("keywords") if isinstance(entry.get("keywords"), list) else []:
            key = str(word).strip()
            if len(key) >= 2:
                keywords[key] = keywords.get(key, 0) + 1
    top_subjects = [value for value, _ in sorted(subjects.items(), key=lambda item: -item[1])[:8]]
    top_keywords = [
        value for value, _ in sorted(keywords.items(), key=lambda item: (-item[1], item[0]))[:24]
    ]
    if not top_subjects and not top_keywords:
        return ""
    text = "## 记忆索引（这里只有主题，细节用 memory_search 查）"
    if top_subjects:
        text += "\n- 记过的人/对象：" + "、".join(top_subjects)
    if top_keywords:
        text += "\n- 关键词：" + "、".join(top_keywords)
    if len(text) > max_chars:
        text = text[:max_chars] + "…"
    return text


def search_hint(notebook: dict[str, Any], query: str, total: int, scene: dict[str, Any] | None) -> str:
    if total > 0:
        return f"这是最相关的 {total} 条，不要重复检索。"
    empty = "没有匹配的记忆。这就是全部结果，不要换关键词重复检索。"
    index_text = memory_index_text(notebook, scene).lower()
    tokens = [
        token
        for token in re.split(r"[\s,，、。；;：:!！?？\"'“”‘’（）()\[\]【】]+", str(query).lower())
        if len(token) >= 2
    ]
    if not tokens or index_text == "":
        return empty
    if any(token in index_text for token in tokens):
        return empty
    return "没有匹配的记忆，索引里也没有这个主题，换词也搜不到。这就是全部结果，不要重复检索。"


# --------------------------------------------------------------------------- #
# 写入/冲突（memory.mjs 640-825）
# --------------------------------------------------------------------------- #
def classify_conflict(category: str, authority: str, text: str) -> str:
    value = str(text or "").strip()
    if authority == "master" and re.match(r"^(记住|以后都|以后不|别再|必须|不许|只能)", value):
        return "command"
    if category in ("user", "core"):
        return "identity"
    if category == "relation":
        return "relation"
    if category == "knowledge":
        return "knowledge"
    if category in ("meme",):
        return "knowledge"
    if category in ("behavior", "note"):
        return "volatile"
    return "unknown"


def upsert_entry(notebook: dict[str, Any], incoming: dict[str, Any], options: dict[str, Any] | None = None) -> dict[str, Any]:
    options = options or {}
    now_ms = _num(options.get("now"), _now_ms())
    at = _iso(int(now_ms))
    text = str(incoming.get("text") or "").strip()
    if text == "":
        raise _ToolError("upsertEntry: text 必填")
    category = incoming.get("category") if incoming.get("category") in CATEGORIES else "note"
    subject = str(incoming.get("subject") or "").strip()
    authority = incoming.get("authority") if incoming.get("authority") in AUTHORITY_RANK else "inferred"
    if not isinstance(notebook.get("entries"), list):
        notebook["entries"] = []
    origin = normalize_origin(incoming.get("origin"), incoming.get("source"), at)
    visibility = normalize_visibility(incoming.get("visibility"), category)
    if visibility["audience"] == "owner" and visibility["ownerQq"] is None and origin["speakerQq"] is not None:
        visibility["ownerQq"] = origin["speakerQq"]
    fact_key = incoming.get("factKey") if isinstance(incoming.get("factKey"), str) and incoming.get("factKey") else f"{category}|{normalize_text(subject)}"
    normalized = normalize_text(text)
    for entry in notebook["entries"]:
        if (
            entry.get("status") != "superseded"
            and fact_key_of(entry) == fact_key
            and normalize_text(entry.get("text")) == normalized
        ):
            return {"action": "duplicate", "id": entry.get("id"), "total": len(notebook["entries"])}

    new_rank = AUTHORITY_RANK[authority]
    current = {"visibility": visibility, "origin": origin}
    conflict_class = classify_conflict(category, authority, text)
    similar_all = [
        entry
        for entry in notebook["entries"]
        if entry.get("status") == "active"
        and fact_key_of(entry) == fact_key
        and is_conflict(str(entry.get("text") or ""), text)
    ]
    for entry in similar_all:
        visible = visibility_of(entry)
        if (
            visible["audience"] == "owner"
            and visible["ownerQq"] is not None
            and str(origin.get("speakerQq") or "") != str(visible["ownerQq"])
            and authority != "master"
        ):
            return {"action": "forbidden", "reason": "owner-only", "ownerQq": visible["ownerQq"]}

    similar = [] if conflict_class in ("knowledge", "relation") else similar_all
    force_supersede = conflict_class in ("command", "volatile")
    force_dispute = conflict_class in ("identity", "unknown")

    superseded: list[dict[str, Any]] = []
    contested: list[dict[str, Any]] = []
    disputed_by: str | None = None
    for entry in similar:
        if force_supersede:
            superseded.append({"entry": entry, "reason": conflict_class + ":latest-wins"})
            continue
        if force_dispute:
            if conflict_class == "identity" and authority == "master":
                superseded.append({"entry": entry, "reason": "identity:owner-override"})
                continue
            disputed_by = entry.get("id")
            break
        old_rank = AUTHORITY_RANK[authority_of(entry)]
        if new_rank < old_rank:
            disputed_by = entry.get("id")
            break
        if new_rank > old_rank:
            if visibility_covers(current, entry):
                superseded.append({"entry": entry, "reason": "higher-authority-covers"})
            else:
                contested.append({"entry": entry, "reason": "higher-authority-narrower"})
            continue
        if same_scope(current, entry):
            superseded.append({"entry": entry, "reason": "equal-authority-same-scope"})
        else:
            contested.append({"entry": entry, "reason": "equal-authority-different-scope"})

    for item in superseded:
        item["entry"]["status"] = "superseded"
        item["entry"]["updatedAt"] = at
        item["entry"]["supersededBy"] = "pending"
    for item in contested:
        item["entry"]["status"] = "contested"
        item["entry"]["updatedAt"] = at

    keywords = derive_keywords(incoming)
    if not keywords:
        raise _ToolError("keywords 必填（内容太短或全是虚词，请补 keywords）")
    entry = {
        "id": f"nb_{_base36(now_ms)}_{_rand5()}",
        "ts": at,
        "category": category,
        "subject": subject,
        "text": text,
        "keywords": keywords,
        "authority": authority,
        "confidence": _num(incoming.get("confidence"), 0.5 if disputed_by is not None else (0.7 if authority == "inferred" else 0.95)),
        "status": "disputed" if disputed_by is not None else "active",
        "factKey": fact_key,
        "origin": origin,
        "visibility": visibility,
        "sensitivity": _normalize_sensitivity(incoming.get("sensitivity"), category),
        "derivedFrom": _normalize_id_list(incoming.get("derivedFrom")),
        "visibilityHistory": _normalize_history(incoming.get("visibilityHistory")),
        "ttlHours": float(incoming["ttlHours"]) if _num(incoming.get("ttlHours"), 0) > 0 else None,
        "pinned": disputed_by is None and incoming.get("pinned") is True,
        "source": dict(incoming["source"]) if isinstance(incoming.get("source"), dict) else {},
        "recordedBy": dict(incoming["recordedBy"]) if isinstance(incoming.get("recordedBy"), dict) else None,
        "updatedAt": at,
        "supersededBy": None,
        "disputedBy": disputed_by,
    }
    if entry["status"] == "active":
        for old in notebook["entries"]:
            if old.get("supersededBy") == "pending":
                old["supersededBy"] = entry["id"]
    notebook["entries"].append(entry)
    notebook["entries"] = notebook["entries"][-800:]
    notebook["updatedAt"] = at

    if entry["status"] == "disputed":
        action = "disputed"
    elif contested:
        action = "contested"
    elif superseded:
        action = "superseded"
    elif similar_all:
        action = "coexist"
    else:
        action = "added"
    result: dict[str, Any] = {
        "action": action,
        "conflictClass": conflict_class,
        "id": entry["id"],
        "total": len(notebook["entries"]),
    }
    if entry["status"] == "disputed" and disputed_by is not None:
        result["conflictsWith"] = disputed_by
        result["needsMaster"] = True
        result["conflict"] = {"withId": disputed_by, "reason": conflict_class + ":needs-master", "outcome": "disputed"}
    elif contested:
        result["conflict"] = {"withId": contested[0]["entry"].get("id"), "reason": contested[0]["reason"], "outcome": "contested"}
    elif superseded:
        result["conflict"] = {"withId": superseded[0]["entry"].get("id"), "reason": superseded[0]["reason"], "outcome": "superseded"}
        result["superseded"] = len(superseded)
    return result


def _base36(value: float) -> str:
    number = int(value)
    if number == 0:
        return "0"
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while number:
        number, rem = divmod(number, 36)
        out = digits[rem] + out
    return out


def _rand5() -> str:
    alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
    return "".join(random.choice(alphabet) for _ in range(5))


# --------------------------------------------------------------------------- #
# 关系记忆（memory.mjs 827-968）
# --------------------------------------------------------------------------- #
def decay_relation_score(score: Any, updated_at: Any, now_ms: float, neutral: float = RELATION_NEUTRAL, half_life_days: float = RELATION_HALF_LIFE_DAYS) -> float:
    base = _num(score, neutral)
    at = updated_at if isinstance(updated_at, (int, float)) else _parse_ts(updated_at)
    if at is None:
        return base
    days = max(0.0, (now_ms - float(at)) / 86_400_000)
    return neutral + (base - neutral) * (0.5 ** (days / half_life_days))


def relation_entry_of(notebook: dict[str, Any], subject_id: Any) -> dict[str, Any] | None:
    key = str(subject_id or "").strip()
    if key == "":
        return None
    entries = notebook.get("entries") if isinstance(notebook.get("entries"), list) else []
    matches = [
        entry
        for entry in entries
        if isinstance(entry, dict)
        and entry.get("category") == "relation"
        and entry.get("status") == "active"
        and (str(entry.get("subject")) == key or entry.get("factKey") == "relation|" + key)
    ]
    if not matches:
        return None
    return sorted(matches, key=lambda entry: str(entry.get("updatedAt") or entry.get("ts")), reverse=True)[0]


def upsert_relation(notebook: dict[str, Any], incoming: dict[str, Any], options: dict[str, Any] | None = None) -> dict[str, Any]:
    options = options or {}
    now_ms = _num(options.get("now"), _now_ms())
    at = _iso(int(now_ms))
    subject_id = str(incoming.get("subjectId") or "").strip()
    if subject_id == "":
        raise _ToolError("upsertRelation: subjectId 必填")
    if not isinstance(notebook.get("entries"), list):
        notebook["entries"] = []
    existing = relation_entry_of(notebook, subject_id)
    base = RELATION_NEUTRAL if existing is None else decay_relation_score(
        existing.get("score"), existing.get("updatedAt") or existing.get("ts"), now_ms
    )
    delta = max(-RELATION_MAX_DELTA, min(RELATION_MAX_DELTA, _num(incoming.get("delta"), 0)))
    score = int(max(0, min(100, round(base + delta))))
    impression = re.sub(r"\s+", " ", str(incoming.get("impression") or (existing or {}).get("impression") or "")).strip()[:80]

    evidence = list(existing.get("evidence")) if existing and isinstance(existing.get("evidence"), list) else []
    proof = incoming.get("evidence")
    if isinstance(proof, dict):
        evidence.append(
            {
                "messageId": proof.get("messageId"),
                "text": str(proof.get("text") or "")[:120],
                "at": at,
            }
        )
        while len(evidence) > 5:
            evidence.pop(0)

    if existing is not None:
        existing["score"] = score
        existing["impression"] = impression
        existing["text"] = impression
        existing["evidence"] = evidence
        existing["updatedAt"] = at
        notebook["updatedAt"] = at
        return {"id": existing.get("id"), "score": score, "delta": delta}

    origin = normalize_origin({"sceneKey": incoming.get("sceneKey")}, {"qq": subject_id}, at)
    entry = {
        "id": f"nb_rel_{_base36(now_ms)}_{_rand5()}",
        "ts": at,
        "category": "relation",
        "subject": subject_id,
        "text": impression,
        "keywords": derive_keywords({"text": impression}),
        "authority": "inferred",
        "confidence": 0.6,
        "status": "active",
        "factKey": "relation|" + subject_id,
        "origin": origin,
        "visibility": {
            "audience": "internal",
            "sceneBound": True,
            "ownerQq": None,
            "allowedSceneKeys": [],
            "allowedUsers": [],
        },
        "sensitivity": 2,
        "derivedFrom": [],
        "visibilityHistory": [],
        "ttlHours": None,
        "pinned": False,
        "source": {"system": "relation"},
        "updatedAt": at,
        "score": score,
        "impression": impression,
        "evidence": evidence,
    }
    notebook["entries"].append(entry)
    notebook["entries"] = notebook["entries"][-800:]
    notebook["updatedAt"] = at
    return {"id": entry["id"], "score": score, "delta": delta}


# --------------------------------------------------------------------------- #
# 30 天原文降级 / 只读导出（memory.mjs 1077-1162）
# --------------------------------------------------------------------------- #
def degrade_expired_raw_text(notebook: dict[str, Any], now_ms: float | None = None, days: float = RAW_RETENTION_DAYS) -> dict[str, Any]:
    now_ms = _now_ms() if now_ms is None else now_ms
    cutoff = now_ms - days * 86_400_000
    archive: list[dict[str, Any]] = []
    changed = 0
    for entry in notebook.get("entries") or []:
        if not isinstance(entry, dict) or entry.get("rawDegradedAt"):
            continue
        at = _parse_ts(entry.get("ts"))
        if at is None or at > cutoff:
            continue
        original = str(entry.get("text") or "")
        if original == "":
            continue
        summary = (
            entry.get("summary").strip()
            if isinstance(entry.get("summary"), str) and entry.get("summary").strip()
            else (original if len(original) <= 60 else original[:60] + "…")
        )
        if summary == original:
            continue
        entry["summary"] = summary
        entry["text"] = summary
        entry["rawDegradedAt"] = _iso(int(now_ms))
        entry["updatedAt"] = entry["rawDegradedAt"]
        archive.append(
            {
                "id": entry.get("id"),
                "ts": entry.get("ts"),
                "category": entry.get("category"),
                "subject": entry.get("subject"),
                "text": original,
                "degradedAt": entry["rawDegradedAt"],
            }
        )
        changed += 1
    return {"changed": changed, "archive": archive}


def export_read_only(notebook: dict[str, Any], is_master: bool) -> dict[str, Any]:
    include_owner = is_master is True
    entries = []
    for entry in notebook.get("entries") or []:
        if not isinstance(entry, dict):
            continue
        visibility = visibility_of(entry)
        if not include_owner and visibility["audience"] == "owner":
            continue
        entries.append(
            {
                "id": entry.get("id"),
                "ts": entry.get("ts"),
                "category": entry.get("category"),
                "subject": entry.get("subject"),
                "text": entry.get("text"),
                "summary": entry.get("summary"),
                "keywords": entry.get("keywords") if isinstance(entry.get("keywords"), list) else [],
                "authority": entry.get("authority"),
                "confidence": entry.get("confidence"),
                "status": entry.get("status"),
                "factKey": entry.get("factKey"),
                "origin": entry.get("origin"),
                "visibility": {
                    "audience": visibility["audience"],
                    "sceneBound": visibility["sceneBound"],
                    "ownerQq": visibility["ownerQq"] if include_owner else None,
                },
                "sensitivity": entry.get("sensitivity"),
                "ttlHours": entry.get("ttlHours"),
                "updatedAt": entry.get("updatedAt"),
                "supersededBy": entry.get("supersededBy"),
                "disputedBy": entry.get("disputedBy"),
            }
        )
    return {
        "version": 3,
        "exportedAt": _iso(),
        "readOnly": True,
        "count": len(entries),
        "entries": entries,
    }


def authority_from_role(role: str) -> str:
    if role in ("admin", "master"):
        return "master"
    if role == "member":
        return "member"
    return "inferred"


# --------------------------------------------------------------------------- #
# 事件上下文
# --------------------------------------------------------------------------- #
def _chinese_errors(fn):
    """未预料的异常一律收敛成中文四态；原始堆栈只进日志，不外发给模型。"""

    @functools.wraps(fn)
    async def wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            return await fn(*args, **kwargs)
        except _ToolError:
            raise  # 自己写的中文参数/权限错误，交给 safe_call 统一分类
        except Exception:  # noqa: BLE001 - handler 必须兜住
            traceback.print_exc(file=sys.stderr)
            return tr.result_fail(
                "internal",
                "本地记忆文件读写失败（磁盘或权限问题），这次没有改到任何东西",
                "不要原样重试；先确认路径可写，或改用文字回答。",
            )

    return wrapper


def _event_ctx(event: Any) -> dict[str, Any]:
    gid = str(event.get_group_id() or "")
    uid = str(event.get_sender_id() or "")
    nick = str(event.get_sender_name() or "")
    master = _master_qq()
    is_master = bool(master) and uid == master
    return {
        "group_id": gid,
        "uid": uid,
        "nick": nick,
        "is_master": is_master,
        "is_group": bool(gid),
        "scene": {
            "sceneKey": f"group:{gid}" if gid else f"private:{uid}",
            "isMaster": is_master,
            "speakerQq": uid if is_master else "",
        },
        "role": "admin" if is_master else "member",
    }


def _load_notebook() -> dict[str, Any]:
    data = _read_json(_notebook_path(), {})
    return data if isinstance(data, dict) else {}


def revoke_source(message_id: str, operator: str = "", at: str | None = None) -> dict[str, Any]:
    """QQ 侧撤回一条消息后，把来源是这条消息的笔记条目标为 expired。

    对齐旧栈 memory.mjs 的 applyRevocations：不删条目，只退出检索
    （status=expired + sourceRevoked），派生条目只打 needsReview。
    返回 {"ok", "changed", "cascaded"}；无命中时 changed 为空、不写盘。
    """
    mid = str(message_id or "").strip()
    if mid == "":
        return {"ok": False, "changed": [], "cascaded": [], "reason": "empty-message-id"}
    notebook = migrate_notebook(_load_notebook())
    entries = notebook.get("entries") if isinstance(notebook.get("entries"), list) else []
    stamp = at if isinstance(at, str) and at else _iso()
    changed: list[str] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        origin = entry.get("origin") if isinstance(entry.get("origin"), dict) else {}
        if str(origin.get("messageId") or "") != mid:
            continue
        if entry.get("status") == "expired" and isinstance(entry.get("sourceRevoked"), dict):
            continue
        entry["status"] = "expired"
        entry["updatedAt"] = stamp
        entry["sourceRevoked"] = {
            "at": stamp,
            "by": operator or None,
            "messageId": mid,
            "reason": "source-recalled",
        }
        changed.append(str(entry.get("id") or ""))
    cascaded: list[str] = []
    if changed:
        ids = set(changed)
        for entry in entries:
            if not isinstance(entry, dict) or str(entry.get("id") or "") in ids:
                continue
            derived = entry.get("derivedFrom") if isinstance(entry.get("derivedFrom"), list) else []
            if any(str(d) in ids for d in derived):
                entry["needsReview"] = True
                cascaded.append(str(entry.get("id") or ""))
        notebook["updatedAt"] = stamp
        _write_json_atomic(_notebook_path(), notebook)
    audit_dir = str(CFG.get("audit_dir") or "")
    if audit_dir == "":
        audit_dir = os.path.join(
            os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "xzy", "audit"
        )
    _append_jsonl(
        os.path.join(audit_dir, "memory_revoke.jsonl"),
        [
            {
                "wall": stamp,
                "messageId": mid,
                "operator": operator or "",
                "changed": changed,
                "cascaded": cascaded,
            }
        ],
    )
    return {"ok": True, "changed": changed, "cascaded": cascaded}


def _entry_row(entry: dict[str, Any], with_keywords: bool = False) -> dict[str, Any]:
    row = {
        "ts": entry.get("ts"),
        "category": entry.get("category"),
        "subject": entry.get("subject"),
        "text": entry.get("text"),
        "authority": entry.get("authority"),
        "status": entry.get("status"),
    }
    if with_keywords:
        row["id"] = entry.get("id")
        row["keywords"] = entry.get("keywords") or []
    return row


# --------------------------------------------------------------------------- #
# qq_notebook（对齐 tools.js 1673-1852）
# --------------------------------------------------------------------------- #
def _event_message_id(event: Any) -> str:
    """当前触发消息的 OneBot message_id；撤回时靠它反查来源条目。"""
    try:
        obj = getattr(event, "message_obj", None)
        mid = getattr(obj, "message_id", "") if obj is not None else ""
        return str(mid or "")
    except Exception:  # noqa: BLE001
        return ""


@_chinese_errors
async def qq_notebook(
    event: Any = None,
    action: str = "",
    category: str = "",
    subject: str = "",
    text: str = "",
    keywords: Any = None,
    delta: Any = 1,
    query: str = "",
    limit: Any = 10,
    **_: Any,
) -> dict[str, Any]:
    if event is None:
        raise _ToolError("缺少事件上下文参数")
    act = action if action in ("add", "relate", "search", "export") else "read"
    ctx = _event_ctx(event)
    scene = ctx["scene"]
    speaker_authority = authority_from_role(ctx["role"])
    notebook = _load_notebook()
    nlimit = _int(limit, 10, 1, 50)

    if act == "export":
        migrated = migrate_notebook(notebook)
        data = export_read_only(migrated, ctx["is_master"])
        return tr.result_ok(f"只读导出 {data['count']} 条", data=data)

    if act in ("add", "relate"):
        body = str(text or "").strip()
        if body == "":
            raise _ToolError("add/relate 需要 text（要记住的内容）")
        cat = category if category in CATEGORIES else "note"
        subj = str(subject or "").strip()
        if act == "relate" or cat == "relation":
            if not re.fullmatch(r"\d{5,12}", subj):
                raise _ToolError("relate 的 subject 参数必须是 QQ 号（5-12 位数字）")
            migrated = migrate_notebook(notebook)
            result = upsert_relation(
                migrated,
                {
                    "subjectId": subj,
                    "delta": _num(delta, 1),
                    "impression": body,
                    "sceneKey": scene["sceneKey"],
                    "evidence": {"messageId": "", "text": body[:120]},
                    "now": _now_ms(),
                },
            )
            _write_json_atomic(_notebook_path(), migrated)
            # 分数只在工具结果里，模型回复中不得出现（旧栈同口径）
            return tr.result_ok(
                f"已调整对 {subj} 的内部关系倾向（不要说出分数或评价）",
                data={"action": "relate", "subject": subj, "delta": result["delta"], "total": len(migrated["entries"])},
            )

        migrated = migrate_notebook(notebook)
        subject_is_master = subj != "" and subj in (_master_qq(), _master_name())
        if subj == "":
            authority = speaker_authority
        elif subject_is_master:
            authority = "master"
        else:
            authority = "member" if speaker_authority == "master" else speaker_authority
        recorded_by = {
            "role": ctx["role"],
            "authority": speaker_authority,
            "qq": _master_qq() if ctx["is_master"] else ("" if ctx["is_group"] else ctx["uid"]),
            "nickname": ctx["nick"],
            "at": _iso(),
        }
        result = upsert_entry(
            migrated,
            {
                "text": body,
                "category": cat,
                "subject": subj,
                "authority": authority,
                "source": {
                    "chatId": scene["sceneKey"],
                    "role": ctx["role"],
                    "qq": _master_qq() if ctx["is_master"] else "",
                },
                "recordedBy": recorded_by,
                "origin": {"messageId": _event_message_id(event)},
                "keywords": [str(item) for item in keywords] if isinstance(keywords, list) else None,
                "now": _now_ms(),
            },
        )
        if result["action"] == "duplicate":
            return tr.result_done(
                "already-done",
                f"同样的内容已经记过了（当前共 {result['total']} 条），这次没有重复写入",
                data={"action": "duplicate", "total": result["total"]},
            )
        if result["action"] == "forbidden":
            return tr.result_blocked(
                "forbidden",
                "这条记忆属于别人的私有范围，不能改写",
                "这是最终结果，不要重试，也不要假装已经完成。",
                data={"action": "forbidden", "reason": result.get("reason")},
            )
        degraded = degrade_expired_raw_text(migrated, now_ms=_now_ms())
        if degraded["archive"]:
            _append_jsonl(_notebook_archive_path(), degraded["archive"])
        _write_json_atomic(_notebook_path(), migrated)
        why = {
            "disputed": "已记下，但与旧说法冲突，已挂起等主人核对",
            "contested": "已记下；旧说法在别的范围仍然有效，两条并存",
            "superseded": "已记住，并覆盖了同主题的旧说法",
            "coexist": "已记住，与同主题的其他条目并存",
        }.get(result["action"], "已记住")
        data = {
            "action": result["action"],
            "id": result["id"],
            "category": cat,
            "subject": subj,
            "authority": authority,
            "text": body,
            "recordedBy": recorded_by,
            "total": result["total"],
            "needsMaster": bool(result.get("needsMaster")),
        }
        if result.get("conflict") is not None:
            data["conflict"] = result["conflict"]
        return tr.result_ok(why, data=data)

    migrated = migrate_notebook(notebook)
    q = str(query or "").strip()
    if act == "search" and q == "":
        raise _ToolError("search 需要 query")
    subj = str(subject or "").strip()
    cat = category if category in CATEGORIES else ""
    entries = search_entries(
        migrated,
        {
            "query": q if act == "search" else "",
            "category": cat,
            "subject": subj,
            "limit": nlimit,
            "scene": scene,
            "now": _now_ms(),
        },
    )
    rows = [_entry_row(entry) for entry in entries]
    hint = search_hint(migrated, q, len(rows), scene) if act == "search" else ""
    if not rows:
        return tr.result_done(
            "no-result",
            "notebook 中没有匹配条目，请勿换关键词反复重试",
            data={"action": act, "total": 0, "entries": [], "hint": hint},
        )
    return tr.result_ok(
        f"命中 {len(rows)} 条",
        data={"action": act, "total": len(rows), "entries": rows, "hint": hint},
    )


# --------------------------------------------------------------------------- #
# qq_media_note：把对图片/视频的判断记进同一本笔记本（和看片笔记同体系）
# --------------------------------------------------------------------------- #
MEDIA_NOTE_CAP = 150
MEDIA_NOTE_SIM = 0.8


def _media_note_ref(raw: str) -> str:
    value = str(raw or "").strip().strip("\"'")
    match = re.search(r"\[(?:图片|视频):(.+?)\]", value)
    return (match.group(1) if match else value).strip()


def _media_note_key(kind: str, local: str) -> str:
    import hashlib

    try:
        stat = os.stat(local)
        raw = f"{os.path.normcase(os.path.abspath(local))}|{stat.st_size}|{int(stat.st_mtime)}"
    except OSError:
        raw = local[:200]
    digest = hashlib.sha1(f"{kind}|{raw}".encode("utf-8", "ignore")).hexdigest()[:16]
    return f"media|{kind}|{digest}"


@_chinese_errors
async def qq_media_note(
    event: Any = None,
    path: str = "",
    verdict: str = "",
    rating: str = "neutral",
    kind: str = "image",
    subject: str = "",
    keywords: Any = None,
    **_: Any,
) -> dict[str, Any]:
    if event is None:
        raise _ToolError("缺少事件上下文参数")
    body = str(verdict or "").strip()[:120]
    if len(body) < 6:
        raise _ToolError("verdict 至少 6 个字：写清你喜欢/不喜欢哪里，别只写“好看”")
    local = _media_note_ref(path)
    if not local:
        raise _ToolError("path 必填：填图片/视频路径，或工具结果里的 [图片:...] / [视频:...]")
    media_kind = str(kind or "").strip().lower()
    if media_kind not in ("image", "video", "frame"):
        media_kind = "image"

    ctx = _event_ctx(event)
    scene = ctx["scene"]
    migrated = migrate_notebook(_load_notebook())
    fact_key = _media_note_key(media_kind, local)
    media_total = sum(
        1
        for item in migrated["entries"]
        if isinstance(item.get("source"), dict) and item["source"].get("mediaKey")
    )
    if media_total >= MEDIA_NOTE_CAP:
        return tr.result_done(
            "limit-reached",
            f"媒体笔记已到上限 {MEDIA_NOTE_CAP} 条，这条不记了（先整理旧的）",
            data={"mediaNotes": media_total},
        )
    for item in migrated["entries"]:
        if item.get("status") == "superseded" or fact_key_of(item) != fact_key:
            continue
        if bigram_similarity(item.get("text"), body) >= MEDIA_NOTE_SIM:
            return tr.result_done(
                "already-recorded",
                "同一张图同一个判断已经记过了，不重复记",
                data={"id": item.get("id"), "mediaNotes": media_total},
            )

    message_id = ""
    try:
        message_id = str(event.message_obj.message_id or "")
    except Exception:  # noqa: BLE001 - 事件对象可能没有 message_obj
        message_id = ""
    source = {
        "chatId": scene["sceneKey"],
        "role": ctx["role"],
        "qq": _master_qq() if ctx["is_master"] else ("" if ctx["is_group"] else ctx["uid"]),
        "nickname": ctx["nick"],
        "senderQq": ctx["uid"],
        "senderNick": ctx["nick"],
        "messageId": message_id,
        "mediaKey": fact_key,
        "mediaKind": media_kind,
        "mediaPath": local[:240],
        "rating": rating if rating in ("like", "neutral", "dislike") else "neutral",
    }
    result = upsert_entry(
        migrated,
        {
            "text": body,
            "category": "note",
            "subject": str(subject or "").strip() or ctx["nick"] or "画面",
            "authority": "inferred",
            "factKey": fact_key,
            "keywords": keywords if isinstance(keywords, list) else None,
            "source": source,
        },
        {"now": _now_ms()},
    )
    action = str(result.get("action") or "")
    if action == "duplicate":
        return tr.result_done(
            "already-recorded",
            "同一张图同一个判断已经记过了",
            data={"id": result.get("id"), "mediaNotes": media_total},
        )
    if action == "forbidden":
        return tr.result_blocked(
            "forbidden",
            "这条笔记的可见性不允许写入",
            "别重试；换一条公开内容再记。",
            final=True,
        )
    _write_json_atomic(_notebook_path(), migrated)
    return tr.result_ok(
        f"已记下这条判断（{action}）",
        next_="这是内部笔记，不要在回复里说“我记下来了”；继续自然聊。",
        data={
            "id": result.get("id"),
            "action": action,
            "chatId": scene["sceneKey"],
            "mediaKey": fact_key,
            "mediaNotes": media_total + 1,
            "total": result.get("total"),
        },
    )


# --------------------------------------------------------------------------- #
# memory_search（对齐 tools.js 1854-1912）
# --------------------------------------------------------------------------- #
@_chinese_errors
async def memory_search(
    event: Any = None,
    query: str = "",
    category: str = "",
    subject: str = "",
    limit: Any = 6,
    **_: Any,
) -> dict[str, Any]:
    q = str(query or "").strip()
    if q == "":
        raise _ToolError("query 必填")
    notebook = migrate_notebook(_load_notebook())
    scene = _event_ctx(event)["scene"] if event is not None else None
    nlimit = _int(limit, 6, 1, 20)
    entries = search_entries(
        notebook,
        {
            "query": q,
            "category": str(category or ""),
            "subject": str(subject or ""),
            "limit": nlimit,
            "scene": scene,
            "now": _now_ms(),
        },
    )
    rows = [_entry_row(entry, with_keywords=True) for entry in entries]
    hint = search_hint(notebook, q, len(rows), scene)
    if not rows:
        return tr.result_done(
            "no-result",
            hint,
            data={"action": "search", "query": q, "total": 0, "entries": [], "hint": hint},
        )
    return tr.result_ok(
        f"命中 {len(rows)} 条",
        data={"action": "search", "query": q, "total": len(rows), "entries": rows, "hint": hint},
    )


# --------------------------------------------------------------------------- #
# qq_group_state：群状态 + 群备注
# --------------------------------------------------------------------------- #
def _group_notes() -> dict[str, Any]:
    data = _read_json(_group_notes_path(), {})
    if not isinstance(data, dict) or not isinstance(data.get("groups"), dict):
        return {"version": 1, "groups": {}}
    return data


def _context_notes() -> dict[str, Any]:
    data = _read_json(_context_notes_path(), {})
    if not isinstance(data, dict) or not isinstance(data.get("chats"), dict):
        return {"version": 1, "chats": {}}
    return data


@_chinese_errors
async def qq_group_state(
    event: Any = None,
    action: str = "read",
    group_id: str = "",
    text: str = "",
    subject: str = "",
    limit: Any = 10,
    **_: Any,
) -> dict[str, Any]:
    if event is None:
        raise _ToolError("缺少事件上下文参数")
    ctx = _event_ctx(event)
    gid = str(group_id or "").strip() or ctx["group_id"]
    if not gid:
        raise _ToolError("仅群聊可用：group_id 参数不能为空（私聊里需要显式传群号）")
    if not gid.isdigit():
        raise _ToolError(f"group_id 参数必须是群号：{gid}")
    act = action if action in ("read", "note") else "read"
    note_key = f"group:{gid}"

    if act == "note":
        body = str(text or "").strip()
        if body == "":
            raise _ToolError("note 需要 text（要记的备注）")
        store = _group_notes()
        notes = store["groups"].get(note_key) if isinstance(store["groups"].get(note_key), list) else []
        notes.append(
            {
                "ts": _iso(),
                "text": body[:500],
                "subject": str(subject or "").strip()[:40],
                "by": ctx["uid"],
                "nick": ctx["nick"],
            }
        )
        store["groups"][note_key] = notes[-200:]
        _write_json_atomic(_group_notes_path(), store)
        return tr.result_ok(
            f"已记下群备注（当前 {len(store['groups'][note_key])} 条）",
            data={"action": "note", "groupId": gid, "total": len(store["groups"][note_key])},
        )

    state_path = os.path.join(_group_state_dir(), f"{gid}.json")
    state = _read_json(state_path, None)
    store = _group_notes()
    notes = store["groups"].get(note_key) if isinstance(store["groups"].get(note_key), list) else []
    notes = notes[-_int(limit, 10, 1, 50) :]
    if not isinstance(state, dict) and not notes:
        return tr.result_done(
            "no-result",
            "这个群还没有群状态或备注记录",
            data={"action": "read", "groupId": gid, "stateFile": state_path},
        )

    state = state if isinstance(state, dict) else {}
    members = state.get("members") if isinstance(state.get("members"), dict) else {}
    data = {
        "action": "read",
        "groupId": gid,
        "stateFile": state_path if state else None,
        "updatedAt": state.get("updatedAt"),
        "coveredMessageId": state.get("coveredMessageId"),
        "messageCount": state.get("messageCount"),
        "topics": state.get("topics") if isinstance(state.get("topics"), list) else [],
        "openQuestions": state.get("openQuestions") if isinstance(state.get("openQuestions"), list) else [],
        "references": (state.get("references") if isinstance(state.get("references"), list) else [])[:20],
        "speakers": (state.get("speakers") if isinstance(state.get("speakers"), list) else [])[:8],
        "members": dict(list(members.items())[:30]),
        "notes": notes,
    }
    return tr.result_ok(f"群状态已读取（话题 {len(data['topics'])} 条、备注 {len(notes)} 条）", data=data)


# --------------------------------------------------------------------------- #
# qq_context：上下文读写
# --------------------------------------------------------------------------- #
def _resolve_chat_key(event: Any, chat_id: str) -> str:
    value = str(chat_id or "").strip()
    if value:
        parsed = parse_scene_key(value)
        if parsed is None:
            raise _ToolError("chat_id 参数必须是 group:<群号> 或 private:<QQ号>")
        return parsed["sceneKey"]
    ctx = _event_ctx(event)
    return f"group:{ctx['group_id']}" if ctx["is_group"] else f"private:{ctx['uid']}"


def _read_feed_tail(max_bytes: int = 4 * 1024 * 1024) -> list[str]:
    path = _conversation_feed_path()
    try:
        size = os.path.getsize(path)
    except OSError:
        return []
    try:
        with open(path, "rb") as f:
            if size > max_bytes:
                f.seek(size - max_bytes)
                f.readline()  # 丢掉可能被截断的首行
            raw = f.read()
    except OSError:
        return []
    return [line for line in raw.decode("utf-8", errors="replace").splitlines() if line.strip()]


@_chinese_errors
async def qq_context(
    event: Any = None,
    action: str = "read",
    chat_id: str = "",
    count: Any = 20,
    kind: str = "note",
    text: str = "",
    qq: str = "",
    nick: str = "",
    **_: Any,
) -> dict[str, Any]:
    if event is None:
        raise _ToolError("缺少事件上下文参数")
    act = action if action in ("read", "write") else "read"
    key = _resolve_chat_key(event, chat_id)

    if act == "write":
        body = str(text or "").strip()
        if body == "":
            raise _ToolError("write 需要 text（要记下的上下文备注）")
        note_kind = kind if kind in ("topic", "question", "note", "ref") else "note"
        store = _context_notes()
        notes = store["chats"].get(key) if isinstance(store["chats"].get(key), list) else []
        notes.append(
            {
                "ts": _iso(),
                "kind": note_kind,
                "text": body[:500],
                "qq": str(qq or "").strip()[:20],
                "nick": str(nick or "").strip()[:40],
                "by": _event_ctx(event)["uid"],
            }
        )
        store["chats"][key] = notes[-100:]
        _write_json_atomic(_context_notes_path(), store)
        return tr.result_ok(
            f"已记下上下文备注（当前 {len(store['chats'][key])} 条）",
            data={"action": "write", "chat": key, "kind": note_kind, "total": len(store["chats"][key])},
        )

    nlimit = _int(count, 20, 1, 50)
    rows: list[dict[str, Any]] = []
    for line in reversed(_read_feed_tail()):
        if len(rows) >= nlimit:
            break
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(item, dict) or item.get("chat") != key:
            continue
        ts = _num(item.get("ts"), 0)
        stamp = ""
        if ts > 0:
            stamp = datetime.datetime.fromtimestamp(ts / 1000).strftime("%H:%M")
        rows.append(
            {
                "time": stamp,
                "qq": str(item.get("qq") or ""),
                "nick": str(item.get("nickname") or ""),
                "role": str(item.get("role") or ""),
                "text": str(item.get("text") or "")[:200],
                "messageId": str(item.get("messageId") or ""),
            }
        )
    rows.reverse()

    store = _context_notes()
    notes = store["chats"].get(key) if isinstance(store["chats"].get(key), list) else []
    notes = notes[-20:]
    if not rows and not notes:
        return tr.result_done(
            "no-result",
            "这个会话没有可读的上下文（feed 里没有记录，也没有上下文备注）",
            data={"action": "read", "chat": key, "total": 0, "messages": [], "notes": []},
        )
    return tr.result_ok(
        f"已读取 {len(rows)} 条上下文（备注 {len(notes)} 条）",
        data={"action": "read", "chat": key, "total": len(rows), "messages": rows, "notes": notes},
    )


# --------------------------------------------------------------------------- #
# qq_profile：人物档案（仅主人，只读）
# --------------------------------------------------------------------------- #
_PROFILE_CALLS: dict[str, str] = {
    "friend_list": "get_friend_list",
    "stranger": "get_stranger_info",
    "categories": "get_friends_with_category",
    "recent": "get_recent_contact",
    "online": "get_online_clients",
    "unidirectional": "get_unidirectional_friend_list",
    "friend_requests": "get_doubt_friends_add_request",
    "profile_like": "get_profile_like",
    "collection": "get_collection_list",
    "faces": "fetch_custom_face",
    "face_detail": "fetch_custom_face_detail",
}


@_chinese_errors
async def qq_profile(
    event: Any = None,
    action: str = "",
    user_id: str = "",
    start: Any = 0,
    count: Any = 20,
    category: Any = None,
    **_: Any,
) -> dict[str, Any]:
    if event is None:
        raise _ToolError("缺少事件上下文参数")
    master = _master_qq()
    ctx = _event_ctx(event)
    if master and not ctx["is_master"]:
        raise _ToolError("qq_profile: 仅主人可用")
    act = str(action or "").strip()
    api = _PROFILE_CALLS.get(act)
    if api is None:
        raise _ToolError(f"不支持的 action：{act or '（空）'}")

    bot = getattr(event, "bot", None)
    if bot is None:
        raise _ToolError("当前平台不支持 OneBot 查询（缺少 event.bot）")
    ncount = _int(count, 20, 1, 200)
    uid = str(user_id or "").strip()
    params: dict[str, Any] = {}
    if act == "stranger":
        if not uid.isdigit():
            raise _ToolError("stranger 需要 user_id（QQ 号）")
        params["user_id"] = int(uid)
    elif act == "profile_like":
        params.update({"start": _int(start, 0, 0, 100000), "count": ncount})
        if uid:
            if not uid.isdigit():
                raise _ToolError("user_id 必须是 QQ 号")
            params["user_id"] = int(uid)
    elif act == "collection":
        params["count"] = ncount
        if category not in (None, ""):
            params["category"] = _int(category, 0, 0, 1000)
    elif act == "faces":
        params.update({"count": ncount, "return_type": 1})

    ret = await bot.call_action(api, **params)
    if isinstance(ret, list):
        data: Any = {"action": act, "total": len(ret), "items": ret[:50]}
        if len(ret) > 50:
            data["truncated"] = True
        return tr.result_ok(f"查询完成（{len(ret)} 条，最多展示 50 条）", data=data)
    if isinstance(ret, dict):
        rows = ret.get("list") or ret.get("data")
        if isinstance(rows, list) and len(rows) > 50:
            return tr.result_ok(
                f"查询完成（{len(rows)} 条，最多展示 50 条）",
                data={"action": act, "total": len(rows), "items": rows[:50], "truncated": True},
            )
        return tr.result_ok("查询完成", data={"action": act, "result": ret})
    return tr.result_ok("查询完成", data={"action": act, "result": ret})


# --------------------------------------------------------------------------- #
# 声明（schema 逐条对齐 tools.js；声明数 = 注册数）
# --------------------------------------------------------------------------- #
TOOL_SPECS: list[dict[str, Any]] = [
    {
        "name": "qq_notebook",
        "description": (
            "长期笔记本：记录梗、群友行为、长期偏好/设定、可复用知识，以及对某个群友的关系倾向；"
            "add/relate/read/search/export。用户说“记住/以后都/别忘/记一下”，或给出长期偏好、称呼、"
            "约定时，必须当轮调用 add，不能只在正文说“记住了”。只记值得长期记住的，不要流水账，"
            "不要记隐私敏感信息。只有关于主人本人的条目才算主人权威，关于别人的条目最高按群友权威记；"
            "主人的断言会覆盖冲突的旧记忆，其他人的相反说法只记为待核对。relate 用来调整对某个群友的"
            "好感度（单次最多 ±3，只留内部倾向，永远不要在回复里说出分数或评价）。read/search 只在确实"
            "要找旧条目时用一次：查不到就直接回答，不要换关键词再查。"
        ),
        "parameters": {
            "action": {"type": "string", "required": True, "description": "add / relate / read / search / export"},
            "category": {"type": "string", "description": "meme / user / behavior / note / knowledge / core，默认 note"},
            "subject": {"type": "string", "description": "对象：QQ 号、昵称或群号；relate 时必须是 QQ 号"},
            "text": {"type": "string", "description": "add 时要记住的内容（简短一句）；relate 时是一两句主观印象"},
            "keywords": {"type": "array", "items": {"type": "string"}, "description": "add 专用：检索关键词；不填会从 text 自动派生"},
            "delta": {"type": "number", "description": "relate 专用：好感度变化，-3..3，默认 1"},
            "query": {"type": "string", "description": "search 关键词"},
            "limit": {"type": "number", "description": "返回条数，默认 10，最大 50"},
        },
        "handler": qq_notebook,
    },
    {
        "name": "qq_media_note",
        "description": (
            "把你对一张图/一段视频的判断记进长期笔记本（和看片笔记同一本，可被记忆检索到）。"
            "只在真的有判断时记：喜欢/不喜欢、哪里出彩、哪里不行、跟你的口味合不合；表情包、随手图不要记，"
            "同一张图同一个判断只记一次（自动去重），媒体笔记最多 150 条。"
            "这是内部沉淀，回复里不要提“我记下来了”。"
        ),
        "parameters": {
            "path": {
                "type": "string",
                "required": True,
                "description": "图片来源：本地路径，或工具结果里的 [图片:...] / [视频:...]",
            },
            "verdict": {
                "type": "string",
                "required": True,
                "description": "一句话判断（第一人称，6-120 字），例如“这张我挺喜欢，配色很脏但构图有劲”",
            },
            "rating": {"type": "string", "description": "like / neutral / dislike，默认 neutral"},
            "kind": {"type": "string", "description": "image / video / frame，默认 image"},
            "subject": {"type": "string", "description": "对象：谁发的、UP 主或群号；不填用发送者昵称"},
            "keywords": {"type": "array", "items": {"type": "string"}, "description": "检索关键词；不填会从 verdict 自动派生"},
        },
        "handler": qq_media_note,
    },
    {
        "name": "memory_search",
        "description": (
            "长期记忆检索（常驻）。只在真的要回忆旧信息时才用一次（“之前说过/还记不记得/那个人/"
            "那个东西/不是约好了”）：查到就答；查不到就直接说“我记不清了”，再用现有信息回答。"
            "简单问题、常识、当前对话里已经有的信息，一律直接回答，不要查。禁止换个关键词反复查。"
            "只返回当前会话可见的条目，owner 内容不会出现在这里。"
        ),
        "parameters": {
            "query": {"type": "string", "required": True, "description": "关键词、人名、群号或短语"},
            "category": {"type": "string", "description": "可选：meme / user / behavior / note / knowledge / core / relation"},
            "subject": {"type": "string", "description": "可选：限定对象（QQ 号 / 昵称 / 群号）"},
            "limit": {"type": "number", "description": "返回条数，默认 6，最大 20"},
        },
        "handler": memory_search,
    },
    {
        "name": "qq_group_state",
        "description": (
            "群状态与备注：读取当前群的压缩状态（主要话题、未结问题、指代关系、最近发言人、成员名单），"
            "或用 note 记一条群备注（关于某个群友/某件事的长期补充）。群状态由后台压缩器维护，"
            "这里只读；备注单独存，不会覆盖压缩器。仅群聊可用。"
        ),
        "parameters": {
            "action": {"type": "string", "description": "read（默认）/ note"},
            "group_id": {"type": "string", "description": "群号；省略时用当前群"},
            "text": {"type": "string", "description": "note 时要记的备注（简短一句）"},
            "subject": {"type": "string", "description": "备注对象：QQ 号或昵称（可选）"},
            "limit": {"type": "number", "description": "read 时返回备注条数，默认 10，最大 50"},
        },
        "handler": qq_group_state,
    },
    {
        "name": "qq_context",
        "description": (
            "上下文读写：read 读取当前会话最近的原始对话（来自后台 conversation-feed，"
            "用于补足被压缩掉的细节）；write 记一条上下文备注（topic 话题 / question 未结问题 / "
            "ref 指代关系 / note 普通备注），后续 read 会一并返回。只在确实需要补上下文时用，"
            "不要每次说话都调用。"
        ),
        "parameters": {
            "action": {"type": "string", "description": "read（默认）/ write"},
            "chat_id": {"type": "string", "description": "目标会话 group:<群号> 或 private:<QQ号>；省略时用当前会话"},
            "count": {"type": "number", "description": "read 条数，默认 20，最大 50"},
            "kind": {"type": "string", "description": "write 类型：topic / question / ref / note，默认 note"},
            "text": {"type": "string", "description": "write 时要记的内容"},
            "qq": {"type": "string", "description": "write/ref 涉及的 QQ 号（可选）"},
            "nick": {"type": "string", "description": "write/ref 涉及的昵称（可选）"},
        },
        "handler": qq_context,
    },
    {
        "name": "qq_profile",
        "description": (
            "查看账号/好友资料（仅主人，只读）：好友列表、陌生人资料、好友分组、最近联系人、在线设备、"
            "单向好友、好友申请、资料赞、收藏列表、收藏表情列表、表情详情。"
        ),
        "parameters": {
            "action": {
                "type": "string",
                "required": True,
                "description": "friend_list / stranger / categories / recent / online / unidirectional / friend_requests / profile_like / collection / faces / face_detail",
            },
            "user_id": {"type": "string", "description": "目标 QQ 号（stranger/profile_like）"},
            "start": {"type": "number", "description": "起始偏移（profile_like）"},
            "count": {"type": "number", "description": "数量（profile_like/collection/faces）"},
            "category": {"type": "number", "description": "收藏分类（collection，可选）"},
        },
        "handler": qq_profile,
    },
]
