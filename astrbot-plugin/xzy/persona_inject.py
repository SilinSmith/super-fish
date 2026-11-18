"""人格与记忆注入（旧栈 proxy.mjs / memory.mjs 的 Python 迁移）。

职责边界（只做这三件事，不接管原生链路、不拼消息、不写人格文件）：
1. 人格只读：`character.md` + 静态「记忆/任务/怎么回」规则 + `identity-seeds-self.jsonl`
   里的自身形象，按 mtime 缓存后逐轮拼进原生 `ProviderRequest.system_prompt`；
   原生人格段（`# Persona Instructions`）先删再写，保证是**替换**而不是叠加。
2. 二维身份：当前会话（群/私聊 + chatId）、当前说话人、是否主人、最近被纠正的话，
   写成「本轮工作记忆」。群维度其他人的消息由 main._apply_batch 附在用户消息里
   （`context_section()` 是同一段文案的规范实现）。
3. 记忆按需：先按场景过滤，再只给 core + 与本轮最近发言相关的少量条目
   （默认 ≤8 条 / 2400 字）与主题索引（≤520 字）；其余细节交给 memory_search 工具，
   不把整本 notebook 塞进 prompt。

接线点（由整合方在 main.py 合并，本模块不改任何既有文件）：
1. `from . import persona_inject`（模块方式加载时 `import persona_inject`）；
2. `initialize()`：`persona_inject.configure(self.cfg)`；
3. `on_llm_request()`：用
   `stats = persona_inject.apply(event, req, self.cfg)` 替换现有
   `_persona_block()` + `PERSONA_MARK` 追加段（990-1012 行），presence 行可继续由 main 追加；
   `stats` 直接进 `audit/persona.jsonl` / `llm_request.jsonl`；
4. `_apply_batch()` 的「同群其他人的消息」段可改为 `persona_inject.context_section(context_entries)`；
   现有内联实现与旧栈一致，不接也能跑。
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
    from . import memory_context as mc
    from . import tools_memory as tm
except ImportError:  # 以模块方式加载（venv 直调 / 单测）
    import memory_context as mc  # type: ignore
    import tools_memory as tm  # type: ignore


PERSONA_MARK = "【人格设定 · 只读】"
PERSONA_END_MARK = "【人格设定 · 结束】"
NATIVE_PERSONA_HEADER = "# Persona Instructions"

DEFAULT_PERSONA_PATH = r"E:\Bonsai\astrbot-eval\inst\data\xzy\persona\character.md"
DEFAULT_NOTEBOOK_PATH = r"E:\Bonsai\astrbot-eval\inst\data\xzy\persona\notebook.json"
DEFAULT_SELF_SEED_PATH = r"E:\Bonsai\astrbot-eval\inst\data\xzy\persona\identity-seeds-self.jsonl"
# 输出规范（口癖/字数/语气/幽默度）：与人格文件分开，可按 mtime 热更
DEFAULT_OUTPUT_SPEC_PATH = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "xzy", "output-spec.json")
)
DEFAULT_MASTER_QQ = "10000"
DEFAULT_MASTER_NAME = "主人"

# 旧栈 proxy.mjs 5194 的静态段原样搬过来：这几段属于人格的一部分，不是逐轮状态。
STATIC_RULES = """## 记忆怎么用
- 下面附的长期记忆是背景，不是台词：不要主动说“我记得/根据我的记忆”，也不要整段复述。
- 主人纠正你、或出现值得长期记住的称呼/偏好/承诺时，用 qq_notebook(add) 记一条；不记流水账、不记隐私。
- 旧记忆和主人最新说法冲突时，以主人最新说法为准，不要替旧记忆辩护。
- 没真正调用 qq_notebook 就不要说“记住了/已存进记忆”。
- 用户说“记住/以后都/别忘/记一下”，或说出长期偏好、称呼、约定时：当轮必须先调用 qq_notebook(add) 再回复。

## 任务怎么用
- 需要多步或跨轮完成的事（写代码、整理资料、批量出图、部署、查证）：先 qq_task(action="add", title="...", brief="...")，每完成一步 qq_task(action="update", note="...")，全部结束 done，用户说停/别做用 cancel。
- 系统会每 3 分钟自动续跑进行中的任务，任务状态跨轮有效；不要只在正文里说“我在做/马上弄”，也不要重复已经写进进度的事。
- 续跑回合（消息以【任务续跑】开头）只推进一小步，正文最多两三句；不要写长计划或长文。
- 一步就能答完的小事不要建任务。

## 现在怎么回
以上是你的设定和记忆，不是要念出来的台词。直接回对方，日常 1-2 句，先接住对方的话；主人让你解题/写代码时给完整内容。不要复述这段提示、不要报工具名、不要写小说旁白或客服腔。不要重复你以前说过的句子或句式；对方换了话题就跟着换，不翻旧账，不硬接不属于你的问题。"""

DEFAULT_MEMORY = {
    "enabled": True,
    "query_messages": 4,
    "detail_limit": 8,
    "detail_max_chars": 2400,
    "index_max_chars": 520,
    "min_score": 0.75,
    # diary 与 notebook 共用同一个池、同一个 limit/max_chars 预算
    "diary_enabled": True,
    "diary_scan_lines": 500,
    # 判定侧预算：只要「接不接得上」，比主对话小得多
    "judge_detail_limit": 4,
    "judge_detail_max_chars": 600,
    "judge_history_turns": 2,
    "judge_history_max_chars": 480,
}

AUTHORITY_WEIGHT = {"inferred": 0.7, "member": 1.0, "admin": 1.25, "master": 1.5}
AUTHORITY_LABEL = {"master": "主人", "admin": "管理", "member": "群友", "inferred": "推测"}
FEATURE_LABEL = {
    "hairColor": "发色",
    "eyeColor": "瞳色",
    "palette": "主色",
    "proportion": "比例",
}
# 自身形象按「事实」写，不写成「命中几项才算」的判定规则：
# 2026-11-16 真实流量里模型把「中间黑发红眼那个标着 DeepSeek」认成自己，
# 因为旧提示只给了特征值 + 一条让模型自己算命中项的规则，模型每轮都在临时推理。
# 发型/耳型在种子里只记单一取值，但证据与 criteria 都允许变体，不能当硬特征写进提示。
SELF_IDENTITY_HEAD = "## 你自己是谁（这是事实，直接知道就行，不用推理）"
SELF_IDENTITY_TAIL = (
    "- 上面就是你的固定长相。看到这个形象（{traits}）的二次元画面就是你本人："
    "直接认，不要逐项打分、不要在【内心】里算「对上几项」。\n"
    "- 发型和耳朵是变体（长直、双马尾、鲸鱼耳、精灵耳都算你）；真人照片、别的 AI 角色拟人不是你。\n"
    "- 明显对不上时（发色、瞳色、主色都不沾）就直说不是你，并指出哪一项不对；"
    "别用一个标着 DeepSeek 的标签就认领别人的配色。"
)
CORRECTION_RE = re.compile(r"(不是|不对|错了|别叫|不要叫|记错|说过|应该是|你搞错|搞混|还在这么说|叫错)")
GROUP_CONTEXT_MARK = "【同群其他人的消息（仅供理解上下文，不要逐条回复他们）】"
# 人格段之后可能出现的边界：原生 skills / 工具提示 / 插件 presence / 本模块记忆段。
_PERSONA_BOUNDARIES = (
    "\n\n## Skills\n",
    "\n\nWhen using tools: ",
    "\n\n【当下状态】",
    "\n\n" + PERSONA_MARK,
    "\n\n## 本轮工作记忆",
    "\n\n## 长期记忆",
    "\n\n## 记忆索引",
)

_CFG: dict[str, Any] = {}
_PERSONA_CACHE: dict[str, Any] = {"key": "", "text": "", "meta": {}}
_NOTEBOOK_CACHE: dict[str, Any] = {"key": "", "data": {}}
_OUTPUT_SPEC_CACHE: dict[str, Any] = {"key": "", "text": "", "meta": {}}


def configure(cfg: dict[str, Any] | None) -> None:
    """接收 main 的整份配置；只读使用，不写回。"""
    _CFG.clear()
    _CFG.update(cfg or {})
    tm.configure(_CFG)
    _PERSONA_CACHE.update({"key": "", "text": "", "meta": {}})
    _NOTEBOOK_CACHE.update({"key": "", "data": {}})
    _OUTPUT_SPEC_CACHE.update({"key": "", "text": "", "meta": {}})


# --------------------------------------------------------------------------- #
# 人格
# --------------------------------------------------------------------------- #
def _file_key(path: str) -> str:
    try:
        stat = os.stat(path)
        return f"{path}:{int(stat.st_mtime)}:{stat.st_size}"
    except OSError:
        return f"{path}:missing"


def _read_text(path: str) -> tuple[str, bytes]:
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError:
        return "", b""
    return raw.decode("utf-8", errors="replace").strip(), raw


def _self_identity_section(seed_path: str) -> str:
    """自身形象：只取 usageScope=self 的种子，写成「你是谁 + 长什么样」的事实。"""
    try:
        with open(seed_path, encoding="utf-8") as f:
            rows = [line.strip() for line in f if line.strip()]
    except OSError:
        return ""
    lines: list[str] = []
    traits: list[str] = []
    name = ""
    for raw in rows:
        try:
            entry = json.loads(raw)
        except Exception:  # noqa: BLE001
            continue
        if not isinstance(entry, dict) or entry.get("usageScope") != "self":
            continue
        if entry.get("status") in ("disabled", "pending"):
            continue
        features = entry.get("features") if isinstance(entry.get("features"), dict) else {}
        parts: list[str] = []
        for key, label in FEATURE_LABEL.items():
            value = features.get(key)
            if isinstance(value, list):
                values = [str(item) for item in value if str(item)]
                if values:
                    parts.append(f"{label}={'/'.join(values)}")
        if not parts:
            continue
        if not name:
            name = str(entry.get("identity") or "").strip()
        if not traits:  # 用第一条（正常比例）定「对上就是你自己」的配色口径
            for key in ("hairColor", "eyeColor", "palette"):
                value = features.get(key)
                if isinstance(value, list):
                    values = [str(item) for item in value if str(item)]
                    if values:
                        traits.append(f"{FEATURE_LABEL[key]}{'/'.join(values)}")
        display = str(entry.get("display") or entry.get("identity") or "自己")
        lines.append(f"- {display}：{'、'.join(parts)}")
    if not lines:
        return ""
    head = SELF_IDENTITY_HEAD
    if name:
        head += f"\n- 你叫「{name}」，是 DeepSeek 的拟人化版本。"
    return (
        head
        + "\n"
        + "\n".join(lines)
        + "\n"
        + SELF_IDENTITY_TAIL.format(traits="、".join(traits) or "上面这些")
    )


def persona_text(cfg: dict[str, Any] | None = None) -> tuple[str, dict[str, Any]]:
    """返回完整人格块（只读、按 mtime 缓存）。"""
    cfg = cfg or _CFG
    persona_path = str(cfg.get("persona_path") or DEFAULT_PERSONA_PATH)
    seed_path = str(cfg.get("identity_seed_path") or DEFAULT_SELF_SEED_PATH)
    key = f"{_file_key(persona_path)}|{_file_key(seed_path)}"
    if key == _PERSONA_CACHE["key"]:
        return _PERSONA_CACHE["text"], dict(_PERSONA_CACHE["meta"])

    character, raw = _read_text(persona_path)
    self_section = _self_identity_section(seed_path)
    parts = [f"{PERSONA_MARK}\n{character}", STATIC_RULES]
    if self_section:
        parts.append(self_section)
    text = "\n\n".join(part for part in parts if part).strip() if character else ""
    if text:
        text += "\n" + PERSONA_END_MARK
    meta = {
        "path": persona_path,
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest() if raw else "",
        "mtime": int(os.stat(persona_path).st_mtime) if raw else 0,
        "self_seed_path": seed_path,
        "self_identity_lines": self_section.count("\n- ") if self_section else 0,
        "chars": len(text),
    }
    _PERSONA_CACHE.update({"key": key, "text": text, "meta": meta})
    return text, dict(meta)


# --------------------------------------------------------------------------- #
# 输出规范（口癖 / 字数 / 语气 / 幽默度）：独立文档，按 mtime 缓存
# --------------------------------------------------------------------------- #
_TONE_LINES = {
    1: "很冷淡，句子短，不主动撒娇",
    2: "偏冷静，正事优先，少加修饰",
    3: "平常说话，不端着也不刻意撒娇",
    4: "亲近一点，会主动接话和吐槽",
    5: "很黏人，语气软，允许撒娇",
}


def _humor_line(value: float) -> str:
    if value < 0.25:
        return "基本不开玩笑，先把事说清"
    if value <= 0.6:
        return "偶尔开个玩笑，不硬凑"
    return "可以多接梗，但别喧宾夺主"


def output_spec_block(cfg: dict[str, Any] | None = None) -> tuple[str, dict[str, Any]]:
    """把 output-spec.json 翻成固定措辞的约束行；解析失败返回空串（不阻塞请求）。"""
    cfg = cfg or _CFG
    path = str(cfg.get("output_spec_path") or DEFAULT_OUTPUT_SPEC_PATH)
    key = _file_key(path)
    if key == _OUTPUT_SPEC_CACHE["key"]:
        return _OUTPUT_SPEC_CACHE["text"], dict(_OUTPUT_SPEC_CACHE["meta"])

    raw, _ = _read_text(path)
    spec: dict[str, Any] = {}
    error = ""
    if raw:
        try:
            parsed = json.loads(raw)
            spec = parsed if isinstance(parsed, dict) else {}
        except ValueError as exc:
            error = f"spec-json-invalid: {exc}"
    reply = spec.get("reply") if isinstance(spec.get("reply"), dict) else {}
    tone = spec.get("tone") if isinstance(spec.get("tone"), dict) else {}
    quirks = spec.get("quirks") if isinstance(spec.get("quirks"), dict) else {}
    lines: list[str] = []
    try:
        max_chars = int(reply.get("maxChars") or 0)
        emoji_per100 = int(reply.get("emojiPer100") or 0)
    except (TypeError, ValueError):
        max_chars, emoji_per100 = 0, 0
    if max_chars > 0:
        emoji_text = "不用 emoji" if emoji_per100 == 0 else f"emoji 每 100 字不超过 {emoji_per100} 个"
        lines.append(f"- 单条回复不超过 {max_chars} 字；{emoji_text}")
    try:
        intensity = int(tone.get("intensity") or 0)
    except (TypeError, ValueError):
        intensity = 0
    if intensity in _TONE_LINES:
        lines.append(f"- 语气强度 {intensity}/5：{_TONE_LINES[intensity]}")
    try:
        humor = float(tone.get("humor") or 0)
    except (TypeError, ValueError):
        humor = 0.0
    if tone:
        lines.append(f"- 幽默度 {humor:.1f}：{_humor_line(humor)}")
    phrases = [
        str(row.get("text") or "")
        for row in (quirks.get("active") or [])
        if isinstance(row, dict) and str(row.get("text") or "")
    ]
    if phrases:
        lines.append(
            "- 常用口癖（只是可选修饰，最多每 5–8 条用一次，能不用就不用；"
            "连续两条不得重复同一口癖）：" + "、".join(phrases)
        )
    if not lines:
        text = ""
    else:
        text = "## 输出规范（每轮都按这个来）\n" + "\n".join(lines)
    meta = {
        "path": path,
        "revision": int(spec.get("revision") or 0) if str(spec.get("revision") or "").isdigit() else 0,
        "chars": len(text),
        "block": text,
        "error": error,
    }
    _OUTPUT_SPEC_CACHE.update({"key": key, "text": text, "meta": meta})
    return text, dict(meta)


# --------------------------------------------------------------------------- #
# 人格段替换（原生 persona / 本模块旧块都先清掉，避免叠加）
# --------------------------------------------------------------------------- #
def _section_end(text: str, start: int) -> int:
    ends = [pos for pos in (text.find(mark, start) for mark in _PERSONA_BOUNDARIES) if pos >= 0]
    return min(ends) if ends else len(text)


def strip_injected_persona(system: str) -> tuple[str, bool]:
    """去掉本模块（或 main 旧实现）注入过的人格块，重复调用不会叠加。"""
    removed = False
    while True:
        start = system.find(PERSONA_MARK)
        if start < 0:
            break
        end = system.find(PERSONA_END_MARK, start)
        if end >= 0:
            end += len(PERSONA_END_MARK)
        else:  # main 旧实现只有开头标记
            end = _section_end(system, start)
        cut_from = start
        while cut_from > 0 and system[cut_from - 1] == "\n":
            cut_from -= 1
        system = system[:cut_from] + ("\n\n" + system[end:].lstrip("\n") if system[end:].strip() else "")
        removed = True
    return system.strip(), removed


def replace_native_persona(system: str, persona_block: str) -> tuple[str, bool]:
    """把原生 `# Persona Instructions` 段原地换成我们的人格块；没有就追加。

    原生段在 system_prompt 开头时前面没有空行（strip 后也如此），所以按「行首」匹配，
    不能要求标题前必须有一个 `\\n`，否则会退化成追加、出现两份人格。
    """
    at = -1
    pos = system.find(NATIVE_PERSONA_HEADER)
    while pos >= 0:
        if pos == 0 or system[pos - 1] == "\n":
            at = pos
            break
        pos = system.find(NATIVE_PERSONA_HEADER, pos + 1)
    if at < 0:
        merged = (system.strip() + "\n\n" + persona_block).strip() if system.strip() else persona_block
        return merged, False
    start = at + len(NATIVE_PERSONA_HEADER)
    end = _section_end(system, start)
    head = system[:at].rstrip("\n")
    merged = (head + "\n\n" if head.strip() else "") + persona_block + system[end:]
    return merged.strip(), True


# --------------------------------------------------------------------------- #
# 二维身份（当前会话 / 当前说话人）
# --------------------------------------------------------------------------- #
def scene_of(event: Any, cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    cfg = cfg or _CFG
    gid = str(getattr(event, "get_group_id", lambda: "")() or "")
    uid = str(getattr(event, "get_sender_id", lambda: "")() or "")
    nick = str(getattr(event, "get_sender_name", lambda: "")() or "")
    master_qq = str(cfg.get("master_qq") or DEFAULT_MASTER_QQ)
    is_master = bool(master_qq) and uid == master_qq
    return {
        "chatKind": "group" if gid else "private",
        "chatId": gid or uid,
        "sceneKey": f"group:{gid}" if gid else f"private:{uid}",
        "speaker": nick,
        "speakerQq": uid,
        "isMaster": is_master,
        "masterQq": master_qq,
        "masterName": str(cfg.get("master_name") or DEFAULT_MASTER_NAME),
    }


def context_section(entries: list[dict[str, Any]] | None) -> str:
    """群维度：同窗口其他人消息只作上下文，不逐条回复、不并入本轮消息链。"""
    if not entries:
        return ""
    lines = []
    for ctx in entries:
        body = str(ctx.get("text") or "")
        if not body and ctx.get("components"):
            body = "[" + "/".join(ctx["components"]) + "]"
        lines.append(f"- [{ctx.get('nick')}({ctx.get('sender')})] {body}")
    if not lines:
        return ""
    return "\n\n" + GROUP_CONTEXT_MARK + "\n" + "\n".join(lines)


def _current_text(event: Any) -> str:
    text = str(getattr(event, "message_str", "") or "")
    cut = text.find(GROUP_CONTEXT_MARK)
    if cut >= 0:
        text = text[:cut]
    return text.strip()


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                parts.append(str(item.get("text") or ""))
        return "".join(parts)
    return str(content or "")


def recent_user_texts(req: Any, event: Any, count: int = 4) -> list[str]:
    """本轮 + 历史里最近几条用户原文（从新到旧）。"""
    out: list[str] = []
    current = _current_text(event)
    if current:
        out.append(current)
    contexts = getattr(req, "contexts", None) or []
    for item in reversed(contexts):
        if len(out) >= count:
            break
        if not isinstance(item, dict) or item.get("role") != "user":
            continue
        text = _content_text(item.get("content")).strip()
        if text:
            out.append(text)
    return out[:count]


def working_memory_block(scene: dict[str, Any], recent_texts: list[str]) -> str:
    """沿用旧栈的两行标记：character.md 里按【发送者标记】判身份，不能只写“当前说话人”。"""
    is_master = "是" if scene["isMaster"] else "否"
    kind = "group" if scene["chatKind"] == "group" else "dm"
    lines = [
        f"【发送者标记】QQ={scene['speakerQq']} 是否主人={is_master} 昵称={scene['speaker'] or '未知'}",
        f"【场景标记】chat={scene['sceneKey']} kind={kind}",
    ]
    corrections = [text for text in recent_texts if CORRECTION_RE.search(text)][-2:]
    for correction in corrections:
        cleaned = re.sub(r"\s+", " ", correction)[:70]
        lines.append(f"- 最近被纠正：{cleaned}")
    return "## 本轮工作记忆\n" + "\n".join(lines)


# --------------------------------------------------------------------------- #
# 记忆检索（memory.mjs selectMemoryEntries 的移植）
# --------------------------------------------------------------------------- #
def _recency_weight(ts: Any, now_ms: float) -> float:
    at = tm._parse_ts(ts)
    if at is None:
        return 0.5
    days = max(0.0, (now_ms / 1000.0 - at) / 86400.0)
    return 0.55 + 0.45 * math.exp(-days / 45.0)


def _ts_key(entry: dict[str, Any]) -> float:
    at = tm._parse_ts(entry.get("ts"))
    return at if at is not None else 0.0


def select_memory_entries(
    notebook: dict[str, Any],
    query: str,
    scene: dict[str, Any] | None,
    limit: int = 8,
    now_ms: float | None = None,
    min_score: float = 0.75,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """兼容旧调用：排序/预算逻辑已收口到 memory_context（唯一实现）。"""
    raw = notebook.get("entries") if isinstance(notebook.get("entries"), list) else []
    entries = [entry for entry in raw if isinstance(entry, dict)]
    return mc.select_entries(entries, query, scene, limit, min_score, now_ms)


def format_memory_section(entries: list[dict[str, Any]], max_chars: int = 2400) -> str:
    """兼容旧调用：渲染逻辑已收口到 memory_context（唯一实现）。"""
    return mc.format_section(entries, max_chars)[0]


def _load_notebook(cfg: dict[str, Any]) -> dict[str, Any]:
    return mc.load_notebook(cfg)


# --------------------------------------------------------------------------- #
# 入口：原生 on_llm_request 调用
# --------------------------------------------------------------------------- #
def apply(
    event: Any,
    req: Any,
    cfg: dict[str, Any] | None = None,
    extra_blocks: list[str] | None = None,
) -> dict[str, Any]:
    """把人格 + 记忆写进 req.system_prompt；返回审计字段，不写文件。"""
    cfg = cfg or _CFG
    before = str(getattr(req, "system_prompt", "") or "")

    cleaned, removed_injected = strip_injected_persona(before)
    persona, persona_meta = persona_text(cfg)
    if persona:
        system, native_replaced = replace_native_persona(cleaned, persona)
    else:  # 人格文件缺失：不删原生人格，等人工修文件
        system, native_replaced = cleaned, False

    blocks: list[str] = []
    # 输出规范紧贴人格段：口癖/字数/语气是每轮都要看的约束，不是记忆素材。
    spec_block, spec_meta = output_spec_block(cfg)
    if spec_block:
        blocks.append(spec_block)
    memory_stats: dict[str, Any] = {}
    opts = {**DEFAULT_MEMORY, **(cfg.get("memory_inject") or {})}
    if opts.get("enabled", True):
        scene = scene_of(event, cfg)
        recent = recent_user_texts(req, event, int(opts.get("query_messages") or 4))
        notebook = _load_notebook(cfg)
        working = working_memory_block(scene, recent)
        if working:
            blocks.append(working)
        memory = mc.retrieve(
            cfg,
            scene,
            mc.query_text(recent, ""),
            limit=int(opts.get("detail_limit") or 8),
            max_chars=int(opts.get("detail_max_chars") or 2400),
            min_score=float(opts.get("min_score") or 0.75),
            include_diary=bool(opts.get("diary_enabled", True)),
            diary_lines=int(opts.get("diary_scan_lines") or mc.DIARY_SCAN_LINES),
        )
        if memory["block"]:
            blocks.append(memory["block"])
        index_text = tm.memory_index_text(notebook, scene, int(opts.get("index_max_chars") or 520))
        if index_text:
            blocks.append(index_text)
        memory_stats = {
            "scene": scene["sceneKey"],
            "is_master": scene["isMaster"],
            "speaker_qq": scene["speakerQq"],
            "recent_query_chars": len("\n".join(recent)),
            **memory["stats"],
            "memory_index_chars": len(index_text),
            "working_chars": len(working),
        }
    if extra_blocks:
        blocks.extend(block for block in extra_blocks if block)
    if blocks:
        system = (system.strip() + "\n\n" + "\n\n".join(blocks)).strip() if system.strip() else "\n\n".join(blocks).strip()

    req.system_prompt = system
    return {
        "persona_injected": bool(persona),
        "persona": persona_meta,
        "native_persona_replaced": native_replaced,
        "stale_injected_removed": removed_injected,
        "system_prompt_chars_before": len(before),
        "system_prompt_chars_after": len(system),
        "system_prompt_sha256": hashlib.sha256(system.encode("utf-8")).hexdigest(),
        "output_spec": spec_meta,
        **memory_stats,
    }
