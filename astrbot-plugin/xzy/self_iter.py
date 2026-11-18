"""自迭代三闸与回滚（迁移自 Y:\\dsh\\home\\qq-persona\\self-iter\\gate.mjs + index.mjs 的审阅段）。

三闸与旧栈逐条对齐：
1. 动作有效性：`action` 只认 remember / note / persona_patch，其余一律 `action-none`；
2. 内容校验：置信度、场景必须来自本轮材料、证据必须存在；人格只允许
   `append_section` / `negative_example` 两个落点，且拦截隐私、提示词泄漏、硬规则标题、
   概括性套话、重复内容；记忆必须能在证据原话里找到落点（bigram 相似度）；
3. 应用前后哈希与备份：应用前记录 beforeHash、复制备份，应用后记录 afterHash；
   人格提案应用前还要过 `file-changed-since-proposal` 的 stale 检查。

回滚只靠 `backupPath`，且必须先确认当前文件仍是「应用后」的 afterHash，
避免把之后的人工改动覆盖掉（drift-detected）。

三条硬约束（不改变上面三闸的语义）：
- 写路径白名单：只认 `character.md` / `notebook.json` / 同目录的 `diary.jsonl`、`diary.md`，
  其余路径一律拒绝并在 ledger 记 `deny-write` + 原因；
- apply 前断言：`.py` 目标走 compile + 绝对导入名断言（py_compile 等价），`.json/.jsonl`
  走解析，纯文本不许为空；不通过就停在 `precheck-failed`，提案保持 pending；
- apply 后与回滚后都复核哈希：apply 的 afterHash 必须可读且不同于 beforeHash；回滚先把备份
  写到临时文件核对 beforeHash，确认后才原子替换，复核不过就记 `rollbackError` 并保持 applied，
  绝不写成 rolledback。`replay_roundtrip()` 是离线最小回放（apply → rollback → 哈希复原）。

提案 JSON 字段与旧栈完全兼容：
id/ts/kind/status/title/reason/confidence/sceneKey/evidence/payload/diff/
beforeHash/afterHash/appliedAt/appliedBy/backupPath/result。

接线点（main.py 只读，由整合方合并）：
- `TOOL_MODULES` 追加 `self_iter`；
- 夜间反思 worker 产出 findings 后调用
  `self_iter.validate_findings(...)` → `self_iter.build_proposals(...)` → `self_iter_store.save_proposal(...)`；
- 主人的 apply / reject / rollback 直接调 `apply_proposal` / `reject_proposal` / `rollback_proposal`，
  或走本模块声明的四个 FunctionTool（均限主人）。
- **灰度期自动 apply 关闭**：`apply_proposal(..., auto=True)` 在 `self_iter.auto_apply` 为 false 时
  直接返回 `auto-apply-disabled`；手动 `self_iter_apply` 走默认 `auto=False`，不受影响。
  原因是 notebook 目前由 `qq_notebook` 唯一写，self_iter 整份重写会打掉旧提案的 `afterHash`。
"""

from __future__ import annotations

import ast
import hashlib
import importlib.util
import json
import os
import re
import time
from typing import Any

try:
    from . import judge as judge_mod
    from . import mutation_policy
    from . import night_quiet
    from . import self_iter_store as store
    from . import tool_result as tr
    from . import tools_memory as mem
except ImportError:  # AstrBot 以扁平模块方式加载时走这里
    import judge as judge_mod  # type: ignore
    import mutation_policy  # type: ignore
    import night_quiet  # type: ignore
    import self_iter_store as store  # type: ignore
    import tool_result as tr  # type: ignore
    import tools_memory as mem  # type: ignore

CFG: dict[str, Any] = {}


def configure(cfg: dict[str, Any]) -> None:
    CFG.clear()
    CFG.update(cfg or {})
    store.configure(cfg)
    mem.configure(cfg)


# --------------------------------------------------------------------------- #
# 内容闸的常量（逐条对齐 gate.mjs）
# --------------------------------------------------------------------------- #
ACTIONS = ("remember", "note", "persona_patch", "tune")
CATEGORIES = {"core", "user", "relation", "meme", "behavior", "knowledge", "note"}
PRIVACY_RE = re.compile(r"(住址|家庭住址|门牌|身份证|手机号|电话号码|银行卡|密码|账号|作息|几点睡|真实姓名|私聊|医院|病历)")
LEAK_RE = re.compile(r"(系统提示|提示词|system\s*prompt|忽略之前|你的设定|规则里|prompt)", re.I)
HARD_HEADING_RE = re.compile(r"^#{1,6}\s*(你认谁|隐私|权限|哪些事不做|不暴露自己在查资料|怎么说话)")
# 群聊概括/关系评价没有检索价值，属于“走一遍填空”的产物。
EDITORIAL_RE = re.compile(r"(体现|说明|反映出?|展现|彰显|共同兴趣|互动关系|值得关注|需跟踪|存在多项未决|氛围|气氛|持续讨论)")
# 纯媒体事件说不清内容，不记。
MEDIA_ONLY_RE = re.compile(r"(发送(了)?多张图片|发了几张图|图片分享|表情包和短视频|让我查看)")

MIN_PERSONA_CHARS = 6
MIN_EXAMPLE_FIX_CHARS = 4
MIN_MEMORY_TEXT_CHARS = 6
MIN_SUBJECT_CHARS = 2


# --------------------------------------------------------------------------- #
# 小工具
# --------------------------------------------------------------------------- #
def _one_line(value: Any, max_chars: int) -> str:
    text = re.sub(r"\s+", " ", "" if value is None else str(value))
    text = re.sub(r"^#+\s*", "", text).replace("```", "")
    return text.strip()[:max_chars]


def _number(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return None if parsed != parsed else parsed


def _iso_ms(ms: int) -> str:
    return store._iso_ms(int(ms))


def _local_date_label() -> str:
    dt = time.localtime()
    return f"{dt.tm_year}-{dt.tm_mon:02d}-{dt.tm_mday:02d}"


def _read_text(path: str) -> str:
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def _evidence_index(events: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    for event in events:
        message_id = str(event.get("messageId") or "")
        if message_id != "":
            index[message_id] = event
    return index


def _bigram(left: Any, right: Any) -> float:
    try:
        return float(mem.bigram_similarity(left, right))
    except Exception:
        return 0.0


# --------------------------------------------------------------------------- #
# tune：违规 → 证据 → 值域（全部在代码里判，模型只给 key/value）
# --------------------------------------------------------------------------- #
def _violation_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [event for event in events if isinstance(event.get("violation"), dict)]


def _validate_tune(
    finding: dict[str, Any],
    events: list[dict[str, Any]],
    scene_key: str,
    confidence: float,
    event_label: str,
) -> dict[str, Any]:
    """tune 的证据不是 messageId，而是「本场景的真实违规行 + specRevision + 计数」。"""
    key = str(finding.get("key") or "")
    if key not in mutation_policy.TUNE_KEYS:
        return {"ok": False, "reason": "tune-key"}
    raw_rev = finding.get("specRevision")
    try:
        spec_rev = int(raw_rev)
    except (TypeError, ValueError):
        return {"ok": False, "reason": "tune-no-revision"}
    current_rev = mutation_policy.spec_revision()
    if spec_rev != current_rev:
        return {
            "ok": False,
            "reason": "tune-stale-revision",
            "detail": f"材料 revision={spec_rev}，当前 {current_rev}",
        }
    local = [
        event
        for event in _violation_events(events)
        if str(event.get("sceneKey") or "") == scene_key
    ]
    if not local:
        return {"ok": False, "reason": "tune-no-violation"}
    code = str(finding.get("violationCode") or "")
    if code:
        matched = [
            event
            for event in local
            if code in ((event.get("violation") or {}).get("codes") or [])
        ]
        if matched:
            local = matched
    # 口癖类证据必须是「窗口口径」的行：旧行是逐条判定，
    # 2026-11-15 起 quirk-missed 改成 20 条窗口，旧行不能当新口径依据（见 output_spec_gate 模块头）。
    cited = {
        str(item)
        for event in local
        for item in ((event.get("violation") or {}).get("codes") or [])
    }
    if "quirk-missed" in cited and all(
        bool((event.get("violation") or {}).get("legacy")) for event in local
    ):
        return {
            "ok": False,
            "reason": "tune-legacy-evidence",
            "detail": "命中的口癖违规全是旧「逐条口径」的行，不构成窗口口径证据",
        }
    tune: dict[str, Any] = {
        "key": key,
        "specRevision": spec_rev,
        "violationCode": code
        or ",".join(sorted({c for event in local for c in (event.get("violation") or {}).get("codes") or []})),
        "count": len(local),
    }
    if key == "dnd":
        current = mutation_policy.current_value("dnd")
        verdict = mutation_policy.resolve_dnd(
            finding.get("start"),
            finding.get("end"),
            current.get("start") if isinstance(current, dict) else "",
            current.get("end") if isinstance(current, dict) else "",
        )
        if not verdict.get("ok"):
            return {"ok": False, "reason": str(verdict.get("code") or "value-out-of-range"), "detail": verdict.get("detail")}
        tune.update({"start": verdict["start"], "end": verdict["end"], "value": f"{verdict['start']}-{verdict['end']}"})
    elif key in ("quirks.add", "quirks.archive"):
        if key == "quirks.add":
            text = str(finding.get("text") or "").strip()
            detail = mutation_policy.validate_quirk(text)
            if detail:
                return {"ok": False, "reason": "value-out-of-range", "detail": detail}
            tune.update({"text": text, "archiveId": str(finding.get("archiveId") or "")})
        else:
            quirk_id = str(finding.get("quirkId") or "").strip()
            active = mutation_policy.read_output_spec().get("quirks", {}).get("active") or []
            if not any(str(row.get("id") or "") == quirk_id for row in active if isinstance(row, dict)):
                return {"ok": False, "reason": "value-out-of-range", "detail": f"active 里没有 {quirk_id}"}
            tune.update({"quirkId": quirk_id})
    else:
        verdict = mutation_policy.resolve(
            key, finding.get("value"), mutation_policy.current_value(key)
        )
        if not verdict.get("ok"):
            return {"ok": False, "reason": str(verdict.get("code") or "value-out-of-range"), "detail": verdict.get("detail")}
        tune["value"] = verdict["normalized"]
    evidence = [
        {
            "messageId": str(event.get("messageId") or ""),
            "ts": int(_number(event.get("ts")) or 0),
            "chat": str(event.get("sceneKey") or ""),
        }
        for event in local[:5]
    ]
    return {
        "ok": True,
        "item": {
            "action": "tune",
            "event": event_label,
            "why": _one_line(finding.get("why"), 60),
            "sceneKey": scene_key,
            "confidence": confidence,
            "evidence": evidence,
            "tune": tune,
        },
    }


# --------------------------------------------------------------------------- #
# 写路径白名单 + apply 前的语法/格式断言
# --------------------------------------------------------------------------- #
# 自迭代只允许改「既定目标」：人格、笔记本，以及与它们同目录的日记文件。
# 其余路径（插件源码、系统文件、任意 json/jsonl）一律拒绝并落 ledger 记原因。
ALLOWED_TARGET_NAMES = ("character.md", "notebook.json", "diary.jsonl", "diary.md")


def _guard_write_path(
    path: Any,
    *,
    action: str,
    proposal: dict[str, Any] | None = None,
    actor: str = "",
) -> dict[str, Any] | None:
    """路径白名单：允许返回 None，拒绝返回带中文原因的失败结果并记审计。"""
    raw = "" if path is None else str(path)
    norm = os.path.normcase(os.path.abspath(raw)) if raw.strip() else ""
    reason = ""
    if norm == "":
        reason = "目标路径为空"
    else:
        name = os.path.basename(norm)
        persona = os.path.normcase(os.path.abspath(store.persona_path()))
        notebook = os.path.normcase(os.path.abspath(store.notebook_path()))
        notebook_dir = os.path.dirname(notebook)
        if name not in ALLOWED_TARGET_NAMES:
            reason = f"不是既定目标文件名：{name}（只允许 {'/'.join(ALLOWED_TARGET_NAMES)}）"
        elif norm not in (persona, notebook) and not (
            name in ("diary.jsonl", "diary.md") and os.path.dirname(norm) == notebook_dir
        ):
            reason = f"不在既定目标路径上：{norm}"
    if reason == "":
        return None
    record: dict[str, Any] = {"action": "deny-write", "op": action, "actor": actor, "file": raw, "reason": reason}
    if isinstance(proposal, dict) and proposal.get("id"):
        record["proposalId"] = proposal.get("id")
    store.audit(record)
    store.metric({"action": "deny-write", "op": action, "reason": reason})
    return {"ok": False, "reason": "write-path-denied", "detail": reason}


def _python_assertion(code: str, label: str) -> str:
    """py_compile 等价的语法断言 + 绝对导入名断言；通过返回空串。"""
    try:
        compile(code, label, "exec", dont_inherit=True)
    except (SyntaxError, ValueError) as error:
        line = getattr(error, "lineno", 0) or 0
        message = getattr(error, "msg", None) or str(error)
        return f"python-syntax：第 {line} 行 {message}"
    try:
        tree = ast.parse(code, filename=label)
    except SyntaxError as error:
        return f"python-syntax：{error}"
    missing: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots = [alias.name.split(".")[0] for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and not node.level:
            roots = [(node.module or "").split(".")[0]]
        else:
            continue
        for root in roots:
            if root == "" or root in missing:
                continue
            try:
                found = importlib.util.find_spec(root) is not None
            except (ImportError, ValueError):
                found = False
            if not found:
                missing.append(root)
    if missing:
        return "python-import：找不到模块 " + "、".join(missing)
    return ""


def _assert_content_ok(path: Any, content: Any) -> str:
    """按目标后缀做 apply 前断言：.py 走语法/导入，.json(.l) 走解析，文本不许为空。"""
    name = os.path.basename(str(path or "")).lower()
    text = "" if content is None else str(content)
    if name.endswith(".py"):
        return _python_assertion(text, str(path))
    if name.endswith(".json"):
        try:
            json.loads(text)
        except ValueError as error:
            return f"json-invalid：{error}"
        return ""
    if name.endswith(".jsonl"):
        for line_no, line in enumerate(text.splitlines(), 1):
            if line.strip() == "":
                continue
            try:
                json.loads(line)
            except ValueError as error:
                return f"jsonl-invalid：第 {line_no} 行 {error}"
        return ""
    if "\x00" in text:
        return "text-nul：内容里有 NUL 字节"
    if text.strip() == "":
        return "content-empty：写出来是空文件"
    return ""


def _precheck_failed(
    proposal: dict[str, Any], actor: str, file_label: str, detail: str
) -> dict[str, Any]:
    """apply 前断言没过：提案保持 pending，只落审计，不写目标文件。"""
    store.audit(
        {
            "proposalId": proposal.get("id"),
            "action": "precheck-failed",
            "actor": actor,
            "file": file_label,
            "reason": detail,
        }
    )
    return {"ok": False, "reason": "precheck-failed", "detail": detail}


def _verify_apply_hash(
    proposal: dict[str, Any], before_hash: str, after_hash: str, file_label: str, actor: str
) -> dict[str, Any] | None:
    """apply 之后必须能读到新哈希，且与 beforeHash 不同，否则显式失败。"""
    detail = ""
    if after_hash == "":
        detail = "写入后读不到文件，afterHash 为空"
    elif after_hash == before_hash:
        detail = "写入后内容哈希没变化，视为没有落盘"
    if detail == "":
        return None
    proposal["status"] = "apply-failed"
    proposal["rejectedReason"] = "after-hash-invalid"
    proposal["decidedAt"] = store.now_iso()
    store.save_proposal(proposal)
    store.audit(
        {
            "proposalId": proposal.get("id"),
            "action": "apply-failed",
            "actor": actor,
            "file": file_label,
            "beforeHash": before_hash,
            "afterHash": after_hash,
            "reason": detail,
        }
    )
    return {"ok": False, "reason": "apply-failed", "detail": detail}


# --------------------------------------------------------------------------- #
# 第一闸 + 第二闸：动作有效性与内容校验
# --------------------------------------------------------------------------- #
def validate_findings(
    findings: Any,
    events: Any,
    notebook_entries: Any = None,
    character: str = "",
    gates: dict[str, Any] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """校验 findings，返回 {accepted, rejected}；rejected 里带原因码，供 metrics 使用。"""
    limits = gates if isinstance(gates, dict) else store.self_iter_config()["gates"]
    event_list = [event for event in (events or []) if isinstance(event, dict)]
    snippets = [entry for entry in (notebook_entries or []) if isinstance(entry, dict)]
    scenes = {str(event.get("sceneKey") or "") for event in event_list}
    by_id = _evidence_index(event_list)
    source_text = str(character or "")
    accepted: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    seen_text: list[str] = []

    max_findings = int(limits.get("maxFindings") or 3)
    min_confidence = float(limits.get("minConfidence") or 0)
    max_character_chars = int(limits.get("maxCharacterChars") or 400)
    max_example_chars = int(limits.get("maxExampleChars") or 60)

    for finding in (findings if isinstance(findings, list) else [])[:max_findings]:
        if not isinstance(finding, dict):
            rejected.append({"action": "none", "reason": "action-none", "event": ""})
            continue
        action = str(finding.get("action") or "none")
        event_label = _one_line(finding.get("event"), 60)
        # 第一闸：动作有效性
        if action not in ACTIONS:
            rejected.append({"action": "none", "reason": "action-none", "event": event_label})
            continue
        confidence = _number(finding.get("confidence"))
        if confidence is None or confidence < min_confidence:
            rejected.append({"action": action, "reason": "low-confidence", "event": event_label})
            continue
        scene_key = str(finding.get("sceneKey") or "")
        if scene_key not in scenes:
            rejected.append(
                {"action": action, "reason": "scene-not-in-material", "event": event_label, "sceneKey": scene_key}
            )
            continue
        # tune 的证据是「本场景的违规行 + specRevision + 计数」，不走 messageId 索引
        if action == "tune":
            tuned = _validate_tune(finding, event_list, scene_key, confidence, event_label)
            if not tuned.get("ok"):
                rejected.append(
                    {
                        "action": action,
                        "reason": tuned.get("reason"),
                        "event": event_label,
                        "sceneKey": scene_key,
                        "detail": tuned.get("detail", ""),
                    }
                )
                continue
            accepted.append(tuned["item"])
            continue

        evidence: list[dict[str, Any]] = []
        for item in finding.get("evidence") if isinstance(finding.get("evidence"), list) else []:
            if not isinstance(item, dict):
                continue
            message_id = str(item.get("messageId") or "")
            raw_ts = item.get("ts")
            ts = 0.0 if raw_ts is None else _number(raw_ts)
            if ts is None:
                continue
            hit = by_id.get(message_id)
            hit_ts = _number(hit.get("ts")) if hit is not None else None
            evidence.append(
                {
                    "messageId": str(hit.get("messageId")) if hit is not None else message_id,
                    "ts": int(hit_ts if hit_ts is not None else ts),
                    "chat": str(hit.get("sceneKey")) if hit is not None else scene_key,
                }
            )
        if not evidence:
            rejected.append(
                {"action": action, "reason": "no-evidence", "event": event_label, "sceneKey": scene_key}
            )
            continue

        if action == "persona_patch":
            persona = finding.get("persona") if isinstance(finding.get("persona"), dict) else {}
            target = str(persona.get("target") or "")
            text = _one_line(persona.get("text"), max_character_chars)
            if target not in ("append_section", "negative_example"):
                rejected.append({"action": action, "reason": "persona-target", "event": event_label})
                continue
            if len(text) < MIN_PERSONA_CHARS:
                rejected.append({"action": action, "reason": "persona-too-short", "event": event_label})
                continue
            if PRIVACY_RE.search(text) or LEAK_RE.search(text) or HARD_HEADING_RE.search(text):
                rejected.append({"action": action, "reason": "persona-blocked-content", "event": event_label})
                continue
            if EDITORIAL_RE.search(text):
                rejected.append({"action": action, "reason": "editorializing", "event": event_label})
                continue
            fix = _one_line(persona.get("fix"), max_example_chars) if target == "negative_example" else ""
            if target == "negative_example" and len(fix) < MIN_EXAMPLE_FIX_CHARS:
                rejected.append({"action": action, "reason": "persona-missing-fix", "event": event_label})
                continue
            if text in source_text or any(_bigram(other, text) >= 0.8 for other in seen_text):
                rejected.append({"action": action, "reason": "persona-duplicate", "event": event_label})
                continue
            seen_text.append(text)
            accepted.append(
                {
                    "action": action,
                    "event": event_label,
                    "why": _one_line(finding.get("why"), 60),
                    "sceneKey": scene_key,
                    "confidence": confidence,
                    "evidence": evidence,
                    "persona": {"target": target, "text": text, "fix": fix},
                }
            )
            continue

        memory = finding.get("memory") if isinstance(finding.get("memory"), dict) else {}
        category = str(memory.get("category") or "note")
        subject = _one_line(memory.get("subject"), 24)
        text = _one_line(memory.get("text"), 120)
        if category not in CATEGORIES or len(subject) < MIN_SUBJECT_CHARS or len(text) < MIN_MEMORY_TEXT_CHARS:
            rejected.append({"action": action, "reason": "memory-schema", "event": event_label})
            continue
        if PRIVACY_RE.search(text) or LEAK_RE.search(text):
            rejected.append({"action": action, "reason": "memory-blocked-content", "event": event_label})
            continue
        if EDITORIAL_RE.search(text) or MEDIA_ONLY_RE.search(text):
            rejected.append({"action": action, "reason": "editorializing", "event": event_label})
            continue
        # 必须能在证据原话里找到落点，防止模型总结出一个凭空的事实。
        grounded = False
        for item in evidence:
            source = by_id.get(str(item.get("messageId") or ""))
            if source is not None and _bigram(source.get("text"), text) >= 0.15:
                grounded = True
                break
        if not grounded:
            rejected.append({"action": action, "reason": "ungrounded", "event": event_label})
            continue
        duplicate = any(_bigram(entry.get("text"), text) >= 0.6 for entry in snippets)
        if duplicate or any(_bigram(other, text) >= 0.6 for other in seen_text):
            rejected.append(
                {"action": action, "reason": "duplicate", "event": event_label, "subject": subject}
            )
            continue
        seen_text.append(text)
        accepted.append(
            {
                "action": action,
                "event": event_label,
                "why": _one_line(finding.get("why"), 60),
                "sceneKey": scene_key,
                "confidence": confidence,
                "evidence": evidence,
                "memory": {"category": category, "subject": subject, "text": text},
            }
        )
    return {"accepted": accepted, "rejected": rejected}


# --------------------------------------------------------------------------- #
# 人格落点（只允许追加章节 / 反例块，不动正文）
# --------------------------------------------------------------------------- #
def _insert_section(markdown: str, text: str, date_label: str) -> str:
    heading = f"## 自迭代补记（{date_label}）"
    block = "\n\n" + heading + "\n- " + text + "\n"
    index = markdown.find(heading)
    if index < 0:
        return markdown.rstrip() + block
    next_heading = markdown.find("\n## ", index + len(heading))
    insert_at = len(markdown) if next_heading < 0 else next_heading
    head = markdown[:insert_at].rstrip()
    tail = markdown[insert_at:]
    return head + "\n- " + text + "\n" + tail


def _insert_negative_example(markdown: str, text: str, fix: str) -> str | None:
    anchor = "下面这些是真实翻车过的说法，别再出现："
    anchor_index = markdown.find(anchor)
    if anchor_index < 0:
        return None
    fence_start = markdown.find("```text", anchor_index)
    if fence_start < 0:
        return None
    fence_end = markdown.find("\n```", fence_start + 7)
    if fence_end < 0:
        return None
    block = "\n❌ " + text + "\n   → " + fix + "\n"
    return markdown[:fence_end] + block + markdown[fence_end:]


def _next_character(before: str, target: str, text: str, fix: str) -> str | None:
    if target == "negative_example":
        return _insert_negative_example(before, text, fix)
    return _insert_section(before, text, _local_date_label())


# --------------------------------------------------------------------------- #
# 提案构建（人格提案只生成、不应用）
# --------------------------------------------------------------------------- #
def _tune_title(tune: dict[str, Any], before: Any) -> str:
    key = str(tune.get("key") or "")
    count = tune.get("count")
    if key == "dnd":
        old = before if isinstance(before, dict) else {}
        old_text = f"{old.get('start') or '空'}-{old.get('end') or '空'}"
        return f"作息 {old_text} → {tune.get('start')}-{tune.get('end')}（本场景违规 {count} 条）"
    if key == "quirks.add":
        return f"新增口癖「{tune.get('text')}」（本场景违规 {count} 条）"
    if key == "quirks.archive":
        return f"归档口癖 {tune.get('quirkId')}（本场景违规 {count} 条）"
    return f"{key} {before} → {tune.get('value')}（本场景违规 {count} 条）"


def build_proposals(accepted: list[dict[str, Any]]) -> list[dict[str, Any]]:
    proposals: list[dict[str, Any]] = []
    now = int(time.time() * 1000)
    character_hash = store.file_hash(store.persona_path())
    character = _read_text(store.persona_path())
    cursor = 0
    for item in accepted:
        cursor += 1
        pid = store.proposal_id(now + cursor)
        ts = _iso_ms(now)
        if item.get("action") == "tune":
            tune = item.get("tune") or {}
            key = str(tune.get("key") or "")
            target = mutation_policy.target_path(key)
            before = mutation_policy.current_value("dnd" if key == "dnd" else key)
            if key == "dnd":
                old_text = (
                    f"{before.get('start') or '空'}-{before.get('end') or '空'}"
                    if isinstance(before, dict)
                    else "空"
                )
                new_text = f"{tune.get('start')}-{tune.get('end')}"
            else:
                old_text = json.dumps(before, ensure_ascii=False) if isinstance(before, (dict, list)) else str(before)
                new_text = str(tune.get("value") or tune.get("text") or tune.get("quirkId") or "")
            proposals.append(
                {
                    "id": pid,
                    "ts": ts,
                    "kind": "tune",
                    "status": "pending",
                    "title": _tune_title(tune, before),
                    "reason": item.get("why", ""),
                    "confidence": item.get("confidence"),
                    "sceneKey": item.get("sceneKey", ""),
                    "evidence": item.get("evidence", []),
                    "payload": tune,
                    "diff": (
                        f"--- {os.path.basename(target)}\n+++ {os.path.basename(target)}\n"
                        f"- {key}: {old_text}\n+ {key}: {new_text}"
                    ),
                    "beforeHash": store.file_hash(target),
                    "afterHash": "",
                }
            )
            continue
        if item.get("action") == "persona_patch":
            persona = item.get("persona") or {}
            target = str(persona.get("target") or "")
            text = str(persona.get("text") or "")
            fix = str(persona.get("fix") or "")
            nxt = _next_character(character, target, text, fix)
            if nxt is None:
                proposals.append(
                    {
                        "id": pid,
                        "ts": ts,
                        "kind": "character",
                        "status": "rejected",
                        "title": item.get("event", ""),
                        "reason": "人格文件里找不到落点（说话示例反例块缺失）",
                        "rejectedReason": "anchor-missing",
                        "payload": persona,
                    }
                )
                continue
            diff = ""
            if nxt != character:
                diff = (
                    "--- character.md\n+++ character.md\n@@ "
                    + target
                    + " @@\n+ "
                    + text
                    + (("\n+   → " + fix) if fix else "")
                )
            proposals.append(
                {
                    "id": pid,
                    "ts": ts,
                    "kind": "character",
                    "status": "pending",
                    "title": item.get("event", ""),
                    "reason": item.get("why", ""),
                    "confidence": item.get("confidence"),
                    "sceneKey": item.get("sceneKey", ""),
                    "evidence": item.get("evidence", []),
                    "payload": persona,
                    "diff": diff,
                    "beforeHash": character_hash,
                    "afterHash": "",
                }
            )
            continue
        memory = item.get("memory") or {}
        proposals.append(
            {
                "id": pid,
                "ts": ts,
                "kind": "notebook",
                "status": "pending",
                "title": str(memory.get("subject") or "") + "：" + str(memory.get("text") or ""),
                "reason": item.get("why", ""),
                "confidence": item.get("confidence"),
                "sceneKey": item.get("sceneKey", ""),
                "evidence": item.get("evidence", []),
                "payload": {
                    "action": item.get("action"),
                    "category": memory.get("category"),
                    "subject": memory.get("subject"),
                    "text": memory.get("text"),
                },
                "diff": "+ ["
                + str(memory.get("category") or "")
                + "|"
                + str(memory.get("subject") or "")
                + "] "
                + str(memory.get("text") or ""),
                "beforeHash": "",
                "afterHash": "",
            }
        )
    return proposals


# --------------------------------------------------------------------------- #
# 第三闸：应用（哈希 + 备份）与回滚
# --------------------------------------------------------------------------- #
def _integrity_gate(proposal: dict[str, Any]) -> str:
    """应用前的最小结构复检，防止手工改坏的提案绕过内容闸。"""
    kind = proposal.get("kind")
    payload = proposal.get("payload")
    if kind not in ("character", "notebook"):
        return "unknown-kind"
    if not isinstance(payload, dict):
        return "damaged-proposal"
    if kind == "character":
        target = str(payload.get("target") or "")
        text = str(payload.get("text") or "").strip()
        if target not in ("append_section", "negative_example"):
            return "persona-target"
        if len(text) < MIN_PERSONA_CHARS:
            return "persona-too-short"
        if PRIVACY_RE.search(text) or LEAK_RE.search(text) or HARD_HEADING_RE.search(text):
            return "persona-blocked-content"
        return ""
    category = str(payload.get("category") or "")
    subject = str(payload.get("subject") or "").strip()
    text = str(payload.get("text") or "").strip()
    if category not in CATEGORIES or len(subject) < MIN_SUBJECT_CHARS or len(text) < MIN_MEMORY_TEXT_CHARS:
        return "memory-schema"
    if PRIVACY_RE.search(text) or LEAK_RE.search(text):
        return "memory-blocked-content"
    return ""


def apply_notebook_proposal(proposal: dict[str, Any], actor: str) -> dict[str, Any]:
    path = store.notebook_path()
    denied = _guard_write_path(path, action="apply", proposal=proposal, actor=actor)
    if denied:
        return denied
    raw = store.read_json(path, None)
    if not isinstance(raw, dict):
        return {"ok": False, "reason": "notebook-missing"}
    notebook = mem.migrate_notebook(raw)
    payload = proposal.get("payload") or {}
    evidence = (proposal.get("evidence") or [{}])[0] or {}
    at_ms = _number(evidence.get("ts"))
    at = _iso_ms(int(at_ms)) if at_ms is not None else store.now_iso()
    try:
        result = mem.upsert_entry(
            notebook,
            {
                "category": payload.get("category"),
                "subject": payload.get("subject"),
                "text": payload.get("text"),
                "authority": "inferred",
                "confidence": proposal.get("confidence"),
                "origin": {
                    "sceneKey": proposal.get("sceneKey"),
                    "speakerQq": None,
                    "speakerName": None,
                    "messageId": evidence.get("messageId") or "",
                    "at": at,
                },
                "visibility": {"audience": "scene", "sceneBound": True},
                "sensitivity": "normal",
                "source": {"chatId": proposal.get("sceneKey"), "role": "self-iter"},
                "recordedBy": {"role": "self-iter", "actor": actor},
            },
        )
    except ValueError as error:
        return {"ok": False, "reason": "notebook-upsert-error", "error": str(error)}
    if result.get("action") in ("duplicate", "forbidden"):
        proposal["status"] = "rejected"
        proposal["rejectedReason"] = result.get("action")
        proposal["decidedAt"] = store.now_iso()
        store.save_proposal(proposal)
        store.audit(
            {"proposalId": proposal.get("id"), "action": "apply", "actor": actor, "result": result.get("action")}
        )
        return {"ok": False, "reason": str(result.get("action"))}

    before_hash = store.file_hash(path)
    try:
        serialized = json.dumps(notebook, ensure_ascii=False)
    except (TypeError, ValueError) as error:
        return _precheck_failed(proposal, actor, "notebook.json", f"notebook-json-serialize：{error}")
    blocked = _assert_content_ok(path, serialized)
    if blocked:
        return _precheck_failed(proposal, actor, "notebook.json", blocked)
    backup_path = store.backup_file(path, "notebook")
    store.write_json_atomic(path, notebook)
    after_hash = store.file_hash(path)
    failed = _verify_apply_hash(proposal, before_hash, after_hash, "notebook.json", actor)
    if failed:
        return failed
    proposal["status"] = "applied"
    proposal["appliedAt"] = store.now_iso()
    proposal["appliedBy"] = actor
    proposal["beforeHash"] = before_hash
    proposal["afterHash"] = after_hash
    proposal["backupPath"] = backup_path
    proposal["result"] = {
        "action": result.get("action"),
        "entryId": result.get("id"),
        "total": result.get("total"),
    }
    store.save_proposal(proposal)
    store.audit(
        {
            "proposalId": proposal.get("id"),
            "action": "apply",
            "actor": actor,
            "file": "notebook.json",
            "beforeHash": before_hash,
            "afterHash": after_hash,
            "result": result.get("action"),
            "entryId": result.get("id"),
        }
    )
    return {"ok": True, "action": result.get("action")}


def apply_character_proposal(proposal: dict[str, Any], actor: str) -> dict[str, Any]:
    path = store.persona_path()
    denied = _guard_write_path(path, action="apply", proposal=proposal, actor=actor)
    if denied:
        return denied
    if not os.path.isfile(path):
        return {"ok": False, "reason": "character-missing"}
    before = _read_text(path)
    before_hash = store.file_hash(path)
    if proposal.get("beforeHash") and before_hash != proposal.get("beforeHash"):
        proposal["status"] = "stale"
        proposal["rejectedReason"] = "file-changed-since-proposal"
        proposal["decidedAt"] = store.now_iso()
        store.save_proposal(proposal)
        store.audit(
            {
                "proposalId": proposal.get("id"),
                "action": "stale",
                "actor": actor,
                "beforeHash": before_hash,
                "expected": proposal.get("beforeHash"),
            }
        )
        return {"ok": False, "reason": "stale"}
    payload = proposal.get("payload") or {}
    target = str(payload.get("target") or "")
    text = str(payload.get("text") or "")
    fix = str(payload.get("fix") or "")
    nxt = _next_character(before, target, text, fix)
    if nxt is None or nxt == before:
        return {"ok": False, "reason": "anchor-missing"}
    blocked = _assert_content_ok(path, nxt)
    if blocked:
        return _precheck_failed(proposal, actor, "character.md", blocked)

    backup_path = store.backup_file(path, "character")
    tmp = path + ".tmp-" + str(os.getpid())
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(nxt)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    after_hash = store.file_hash(path)
    failed = _verify_apply_hash(proposal, before_hash, after_hash, "character.md", actor)
    if failed:
        return failed
    proposal["status"] = "applied"
    proposal["appliedAt"] = store.now_iso()
    proposal["appliedBy"] = actor
    proposal["beforeHash"] = before_hash
    proposal["afterHash"] = after_hash
    proposal["backupPath"] = backup_path
    proposal["diff"] = (
        "--- character.md\n+++ character.md\n@@ "
        + target
        + " @@\n+ "
        + text
        + (("\n+   → " + fix) if fix else "")
    )
    store.save_proposal(proposal)
    store.audit(
        {
            "proposalId": proposal.get("id"),
            "action": "apply",
            "actor": actor,
            "file": "character.md",
            "beforeHash": before_hash,
            "afterHash": after_hash,
            "target": target,
        }
    )
    return {"ok": True}


def apply_proposal(
    proposal: dict[str, Any], actor: str = "master", *, auto: bool = False
) -> dict[str, Any]:
    """``auto=True`` 只给夜间反思之类的自动路径用：灰度期默认拒绝，必须主人手动 apply。"""
    # 只读区硬边界：人格文件在自动路径上永远不可写，与 auto_apply 配置无关
    if auto and proposal.get("kind") == "character":
        store.audit(
            {
                "proposalId": proposal.get("id"),
                "action": "deny-write",
                "actor": actor,
                "file": "character.md",
                "reason": "tier-readonly（自动路径不写人格文件）",
            }
        )
        return {
            "ok": False,
            "reason": "tier-readonly",
            "detail": "人格文件属于只读区：只有主人手动 self_iter_apply 可写",
        }
    if auto and not store.self_iter_config()["auto_apply"]:
        return {"ok": False, "reason": "auto-apply-disabled"}
    if proposal.get("status") != "pending":
        return {"ok": False, "reason": "status-" + str(proposal.get("status"))}
    if proposal.get("kind") == "tune":
        return mutation_policy.apply_tune_with_status(proposal, actor, auto=auto)
    blocked = _integrity_gate(proposal)
    if blocked:
        return {"ok": False, "reason": blocked}
    if proposal.get("kind") == "character":
        return apply_character_proposal(proposal, actor)
    return apply_notebook_proposal(proposal, actor)


def _rollback_failed(
    proposal: dict[str, Any], actor: str, reason: str, detail: str, **extra: Any
) -> dict[str, Any]:
    """回滚失败要显式落状态：文件仍是 applied，记 rollbackError，绝不写成 rolledback。"""
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
            "proposalId": proposal.get("id"),
            "action": "rollback-failed",
            "actor": actor,
            "reason": reason,
            "detail": detail,
            **extra,
        }
    )
    return {"ok": False, "reason": reason, "detail": detail, "status": proposal.get("status"), **extra}


def rollback_proposal(proposal: dict[str, Any], actor: str = "master") -> dict[str, Any]:
    """回滚 = 备份 hash == beforeHash → 原子替换 → 复核 hash；任何一步不符都算失败。"""
    if proposal.get("status") != "applied":
        return {"ok": False, "reason": "status-" + str(proposal.get("status"))}
    # tune 按目标分策略：config 只回写 before 值，output-spec 整文件快照
    if proposal.get("kind") == "tune":
        return mutation_policy.rollback_tune(proposal, actor)
    backup_path = proposal.get("backupPath")
    if not isinstance(backup_path, str) or backup_path == "":
        return {"ok": False, "reason": "no-backup"}
    if not os.path.exists(backup_path):
        return {"ok": False, "reason": "backup-missing"}
    kind = proposal.get("kind")
    path = store.persona_path() if kind == "character" else store.notebook_path()
    denied = _guard_write_path(path, action="rollback", proposal=proposal, actor=actor)
    if denied:
        return denied
    expected = str(proposal.get("beforeHash") or "")
    if expected == "":
        return _rollback_failed(
            proposal, actor, "rollback-unverifiable", "提案里没有 beforeHash，无法断言复原到应用前"
        )
    current_hash = store.file_hash(path)
    if current_hash != proposal.get("afterHash"):
        return _rollback_failed(
            proposal,
            actor,
            "drift-detected",
            "当前文件已不是应用后的版本，拒绝覆盖",
            currentHash=current_hash,
        )

    # 先写到临时文件并核对备份哈希，确认无误后才原子替换，失败时目标文件一个字节都不动。
    tmp = path + ".rollback-" + str(os.getpid())
    try:
        with open(backup_path, "rb") as src:
            payload_bytes = src.read()
        with open(tmp, "wb") as dst:
            dst.write(payload_bytes)
            dst.flush()
            os.fsync(dst.fileno())
        backup_hash = store.file_hash(tmp)
        if backup_hash != expected:
            return _rollback_failed(
                proposal,
                actor,
                "rollback-hash-mismatch",
                "备份文件哈希与 beforeHash 不一致（备份已被改动）",
                backupPath=backup_path,
                expectedHash=expected,
                backupHash=backup_hash,
            )
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass
    restored_hash = store.file_hash(path)
    if restored_hash != expected:
        return _rollback_failed(
            proposal,
            actor,
            "rollback-hash-mismatch",
            "回滚后复核哈希与 beforeHash 不一致",
            expectedHash=expected,
            restoredHash=restored_hash,
        )
    proposal["status"] = "rolledback"
    proposal["rolledBackAt"] = store.now_iso()
    proposal["rolledBackBy"] = actor
    proposal["restoredHash"] = restored_hash
    proposal.pop("rollbackError", None)
    store.save_proposal(proposal)
    store.audit(
        {
            "proposalId": proposal.get("id"),
            "action": "rollback",
            "actor": actor,
            "file": "character.md" if kind == "character" else "notebook.json",
            "expectedHash": expected,
            "restoredHash": restored_hash,
            "verified": True,
        }
    )
    return {"ok": True, "restoredHash": restored_hash}


def replay_roundtrip(proposal: dict[str, Any], actor: str = "replay") -> dict[str, Any]:
    """最小回放：apply → rollback → 断言哈希复原。只给离线用例用，不要接线上入口。"""
    kind = proposal.get("kind")
    path = store.persona_path() if kind == "character" else store.notebook_path()
    original_hash = store.file_hash(path)
    applied = apply_proposal(proposal, actor)
    if not applied.get("ok"):
        return {
            "ok": False,
            "stage": "apply",
            "reason": applied.get("reason"),
            "detail": applied.get("detail"),
            "originalHash": original_hash,
        }
    applied_hash = store.file_hash(path)
    rolled = rollback_proposal(proposal, actor)
    if not rolled.get("ok"):
        return {
            "ok": False,
            "stage": "rollback",
            "reason": rolled.get("reason"),
            "detail": rolled.get("detail"),
            "originalHash": original_hash,
            "appliedHash": applied_hash,
        }
    restored_hash = store.file_hash(path)
    ok = restored_hash == original_hash
    return {
        "ok": ok,
        "stage": "done" if ok else "verify",
        "reason": "" if ok else "hash-not-restored",
        "originalHash": original_hash,
        "appliedHash": applied_hash,
        "restoredHash": restored_hash,
    }


def reject_proposal(proposal: dict[str, Any], actor: str = "master", reason: str = "manual") -> dict[str, Any]:
    if proposal.get("status") != "pending":
        return {"ok": False, "reason": "status-" + str(proposal.get("status"))}
    proposal["status"] = "rejected"
    proposal["rejectedReason"] = str(reason or "manual")
    proposal["decidedAt"] = store.now_iso()
    proposal["decidedBy"] = actor
    store.save_proposal(proposal)
    store.audit(
        {"proposalId": proposal.get("id"), "action": "reject", "actor": actor, "reason": proposal["rejectedReason"]}
    )
    return {"ok": True}


# --------------------------------------------------------------------------- #
# 工具入口（全部限主人；群里的模型调用一律 blocked）
# --------------------------------------------------------------------------- #
def _require_master(event: Any) -> dict[str, Any] | None:
    if event is None:
        return None
    try:
        sender = str(event.get_sender_id() or "")
    except Exception:
        sender = ""
    master = str(CFG.get("master_qq") or "").strip()
    if master and sender == master:
        return None
    return tr.result_blocked("forbidden", "自迭代的审阅、应用与回滚只允许主人操作", "需要主人亲自批准。")


def _int(value: Any, default: int, low: int, high: int) -> int:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return default
    return max(low, min(high, parsed))


def _action_result(result: dict[str, Any], verb: str) -> dict[str, Any]:
    if result.get("ok"):
        detail = f"（{result.get('restoredHash', '')[:12]}）" if result.get("restoredHash") else ""
        return tr.result_ok(f"{verb}完成{detail}", data=result)
    reason = str(result.get("reason") or "")
    detail = str(result.get("detail") or "")
    if reason.startswith("status-"):
        return tr.result_done("already-done", f"当前状态是 {reason[7:]}，不能{verb}")
    if detail:
        return tr.result_fail("policy-rejected", f"{verb}被拦：{detail}", data=result)
    return tr.result_fail("policy-rejected", f"{verb}被拦：{reason}", data=result)


async def self_iter_list(event: Any = None, status: str = "pending", limit: Any = 20, **_: Any) -> dict[str, Any]:
    blocked = _require_master(event)
    if blocked:
        return blocked
    rows = store.list_proposals(_int(limit, 20, 1, 200))
    if status in ("pending", "applied", "rejected", "stale", "rolledback"):
        rows = [row for row in rows if row.get("status") == status]
    data = [
        {
            "id": row.get("id"),
            "kind": row.get("kind"),
            "status": row.get("status"),
            "title": row.get("title"),
            "reason": row.get("reason"),
            "ts": row.get("ts"),
        }
        for row in rows
    ]
    return tr.result_ok(f"共 {len(data)} 条提案", data=data)


async def self_iter_apply(event: Any = None, proposal_id: str = "", **_: Any) -> dict[str, Any]:
    blocked = _require_master(event)
    if blocked:
        return blocked
    proposal = store.get_proposal(str(proposal_id or "").strip())
    if proposal is None:
        return tr.result_done("no-result", "找不到这个提案 id")
    lock = store.acquire_lock()
    if not lock.get("ok"):
        return tr.result_blocked("busy", "另一个自迭代操作正在写文件，稍后再试", "等前一个操作结束再试。")
    try:
        outcome = apply_proposal(proposal, "master")
    finally:
        store.release_lock()
    store.metric(
        {
            "action": "apply",
            "proposalId": str(proposal_id),
            "kind": proposal.get("kind"),
            "ok": bool(outcome.get("ok")),
            "reason": outcome.get("reason"),
        }
    )
    return _action_result(outcome, "应用")


async def self_iter_reject(
    event: Any = None, proposal_id: str = "", reason: str = "manual", **_: Any
) -> dict[str, Any]:
    blocked = _require_master(event)
    if blocked:
        return blocked
    proposal = store.get_proposal(str(proposal_id or "").strip())
    if proposal is None:
        return tr.result_done("no-result", "找不到这个提案 id")
    lock = store.acquire_lock()
    if not lock.get("ok"):
        return tr.result_blocked("busy", "另一个自迭代操作正在写文件，稍后再试", "等前一个操作结束再试。")
    try:
        outcome = reject_proposal(proposal, "master", reason or "manual")
    finally:
        store.release_lock()
    store.metric(
        {
            "action": "reject",
            "proposalId": str(proposal_id),
            "kind": proposal.get("kind"),
            "ok": bool(outcome.get("ok")),
            "reason": outcome.get("reason"),
        }
    )
    return _action_result(outcome, "拒绝")


async def self_iter_rollback(event: Any = None, proposal_id: str = "", **_: Any) -> dict[str, Any]:
    blocked = _require_master(event)
    if blocked:
        return blocked
    proposal = store.get_proposal(str(proposal_id or "").strip())
    if proposal is None:
        return tr.result_done("no-result", "找不到这个提案 id")
    lock = store.acquire_lock()
    if not lock.get("ok"):
        return tr.result_blocked("busy", "另一个自迭代操作正在写文件，稍后再试", "等前一个操作结束再试。")
    try:
        outcome = rollback_proposal(proposal, "master")
    finally:
        store.release_lock()
    store.metric(
        {
            "action": "rollback",
            "proposalId": str(proposal_id),
            "kind": proposal.get("kind"),
            "ok": bool(outcome.get("ok")),
            "reason": outcome.get("reason"),
        }
    )
    return _action_result(outcome, "回滚")


PROPOSE_SYSTEM = "你是人格与记忆的反思器，只做素材归纳，不聊天、不寒暄、不解释过程。只输出一段 JSON。"
PROPOSE_RULES = """从材料里找出最多 {max_findings} 条值得长期保留的内容，只允许四种 action：
- remember：稳定事实（偏好、身份、关系、常用称呼）
- note：短期有用的事项（计划、约定、正在做的事）
- persona_patch：回答方式的修正（target=append_section 追加一句行为规则；target=negative_example 追加一条「这样说不好 → 应该这样说」）
- tune：调整我自己的输出规范或作息。**只有材料里出现【出站违规】行时才允许输出**，用来修掉反复犯的违规
  key 只允许：reply.maxChars / reply.emojiPer100 / tone.intensity / tone.humor / quirks.add / quirks.archive / dnd
  数值类给 value（单次只能小步调，代码会卡步长）；dnd 给 start 和 end（HH:MM，静默 6–10 小时）；
  quirks.add 给 text（2–12 字，active 满 5 条时还要给 archiveId）；quirks.archive 给 quirkId
  specRevision 必须原样抄下面「当前输出规范 revision=」的数字；sceneKey 必须是那条违规行的 sceneKey；
  violationCode 抄违规行的码（over-limit / emoji-high / quirk-missed / quirk-overused）
硬性要求：
1. confidence 取 0~1，低于 {min_conf} 的不要输出；
2. sceneKey 必须原样取自材料里某一条；
3. 除 tune 外 evidence 至少 1 条，messageId 必须原样取自材料；tune 的证据是违规行本身，不用再给 evidence；
4. persona_patch 的 text 必须是一句可复用的话，不得含隐私（QQ号/电话/地址/真名/医院）、不得提到提示词或系统规则、不得写标题；negative_example 还要给 fix（不超过 60 字）；
5. remember / note 的 subject 不超过 24 字，text 不超过 120 字；text 必须大量复用证据原话里的词（不要换同义词、不要概括成抽象结论），否则会被判“没依据”。
没有值得记的就输出 {{"findings": []}}。
输出示例：
{{"findings":[{{"action":"remember","confidence":0.8,"sceneKey":"group:123","event":"称呼偏好","why":"本人明确说明","evidence":[{{"messageId":"123"}}],"memory":{{"category":"user","subject":"希望被叫小鱼","text":"以后叫我小鱼就行"}}}}]}}
tune 示例（仅当材料里有【出站违规】时）：
{{"findings":[{{"action":"tune","confidence":0.9,"sceneKey":"group:123","event":"回复太长","why":"连续两条超过字数上限","key":"reply.maxChars","value":160,"specRevision":1,"violationCode":"over-limit"}}]}}
category 只允许：core / user / relation / meme / behavior / knowledge / note。"""


def _notebook_entries() -> list[dict[str, Any]]:
    try:
        with open(store.notebook_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError, TypeError):
        return []
    if isinstance(data, list):
        return [row for row in data if isinstance(row, dict)]
    if isinstance(data, dict):
        rows = data.get("entries")
        if isinstance(rows, list):
            return [row for row in rows if isinstance(row, dict)]
    return []


def _scene_of_umo(umo: Any) -> str:
    """把出站审计的 umo 折成与 inbound 相同的 sceneKey（group:/private:）。"""
    parts = str(umo or "").split(":")
    if len(parts) >= 3:
        kind, ident = parts[-2], parts[-1]
        if kind == "GroupMessage":
            return f"group:{ident}"
        if kind in ("FriendMessage", "PrivateMessage"):
            return f"private:{ident}"
    return str(umo or "")


def _recent_violations(limit: int = 8) -> list[dict[str, Any]]:
    """出站规范违规进反思材料：没有它，tune 提案永远没有证据。"""
    path = os.path.join(store.STATE_DIR, "audit", "output_spec.jsonl")
    try:
        with open(path, "r", encoding="utf-8") as f:
            lines = f.readlines()[-2000:]
    except OSError:
        return []
    events: list[dict[str, Any]] = []
    for index, line in enumerate(reversed(lines)):
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if not isinstance(row, dict):
            continue
        codes = [str(code) for code in (row.get("violations") or []) if str(code)]
        if not codes:
            continue
        wall_ms = int(row.get("wall_ms") or 0)
        scene = _scene_of_umo(row.get("umo"))
        spec_rev = int(row.get("specRevision") or 0)
        head = str(row.get("textHead") or "")[:120]
        # 没有 judgeMode 的行是 2026-11-15 的旧「逐条口径」，quirk-missed 的含义与现在不同。
        judge_mode = str(row.get("judgeMode") or "legacy-per-message")
        events.append(
            {
                "messageId": f"out:{wall_ms}:{index}",
                "ts": wall_ms,
                "sceneKey": scene,
                "nick": "我（出站）",
                "text": (
                    f"【出站违规】{','.join(codes)}｜口径={judge_mode}"
                    f"｜字数 {row.get('chars')}/{row.get('maxChars')}"
                    f"｜emoji {row.get('emojiPer100')}%｜specRevision={spec_rev}｜原文：{head}"
                ),
                "violation": {
                    "codes": codes,
                    "judgeMode": judge_mode,
                    "legacy": judge_mode != "window-20",
                    "specRevision": spec_rev,
                    "chars": row.get("chars"),
                    "maxChars": row.get("maxChars"),
                    "emojiPer100": row.get("emojiPer100"),
                    "quirkHits": row.get("quirkHits") or [],
                },
            }
        )
        if len(events) >= limit:
            break
    events.reverse()
    return events


def _recent_events(limit: int) -> list[dict[str, Any]]:
    """反思材料 = inbound.jsonl + 最近的出站违规（违规让 tune 有据可依）。"""
    path = os.path.join(store.STATE_DIR, "audit", "inbound.jsonl")
    events: list[dict[str, Any]] = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            lines = f.readlines()[-4000:]
    except OSError:
        lines = []
    for line in reversed(lines):
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if not isinstance(row, dict):
            continue
        message_id = str(row.get("message_id") or "")
        text = str(row.get("text") or "").strip()
        if not message_id or len(text) < 4:
            continue
        group_id = str(row.get("group_id") or "")
        scene = f"group:{group_id}" if group_id else f"private:{row.get('sender') or ''}"
        events.append(
            {
                "messageId": message_id,
                "ts": int(row.get("ts") or 0),
                "sceneKey": scene,
                "nick": str(row.get("nick") or row.get("sender") or ""),
                "text": text[:300],
            }
        )
        if len(events) >= limit:
            break
    events.reverse()
    violations = _recent_violations(max(3, min(8, limit // 3)))
    if violations:
        merged = events + violations
        merged.sort(key=lambda item: int(item.get("ts") or 0))
        events = merged[-max(limit, len(violations)):]
    return events


MEDIA_NOTE_MATERIAL_LIMIT = 12


def _ts_ms(value: Any) -> int:
    """把 inbound 的毫秒时间戳或 notebook 的 ISO 时间统一成毫秒。"""
    text = str(value or "").strip()
    if text.isdigit():
        number = int(text)
        return number * 1000 if number < 10_000_000_000 else number
    try:
        from datetime import datetime

        return int(datetime.strptime(text, "%Y-%m-%dT%H:%M:%S%z").timestamp() * 1000)
    except (TypeError, ValueError):
        return 0


def _media_note_rows(limit: int = MEDIA_NOTE_MATERIAL_LIMIT) -> list[dict[str, Any]]:
    """qq_media_note 写进 notebook 的判断：带来源（图片/视频、群、发送者）。"""
    rows = [
        row
        for row in _notebook_entries()
        if row.get("status") != "superseded"
        and isinstance(row.get("source"), dict)
        and row["source"].get("mediaKey")
    ]
    rows.sort(key=lambda row: _ts_ms(row.get("ts")), reverse=True)
    return rows[:limit]


def _merge_media_notes(
    events: list[dict[str, Any]], notes: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """把媒体判断并进材料；同一 messageId 合并成一条，避免重复计数。"""
    by_id = {item["messageId"]: item for item in events}
    extra: list[dict[str, Any]] = []
    extra_by_id: dict[str, dict[str, Any]] = {}
    for row in notes:
        source = row.get("source") if isinstance(row.get("source"), dict) else {}
        scene = str(source.get("chatId") or "")
        if not scene:
            continue
        kind = str(source.get("mediaKind") or "image")
        label = "视频" if kind in ("video", "frame") else "图片"
        sender = str(source.get("senderNick") or source.get("nickname") or "自己")
        note_id = str(row.get("id") or "")
        line = (
            f"【{label}评价·我自己的判断】{str(row.get('text') or '')[:120]}"
            f"｜来源：{str(source.get('mediaPath') or '')[:120]}｜{scene}｜{sender}"
        )
        mid = str(source.get("messageId") or "")
        target = by_id.get(mid) if mid else None
        if target is not None:
            target["text"] = (str(target.get("text") or "") + "｜" + line)[:400]
            target["mediaNoteId"] = note_id
            continue
        if mid and mid in extra_by_id:
            same = extra_by_id[mid]
            same["text"] = (str(same.get("text") or "") + "｜" + line)[:400]
            continue
        entry = {
            "messageId": mid or f"note:{note_id}",
            "ts": _ts_ms(row.get("ts")),
            "sceneKey": scene,
            "nick": sender,
            "text": line[:400],
            "mediaNoteId": note_id,
        }
        extra.append(entry)
        if mid:
            extra_by_id[mid] = entry
    if not extra:
        return events
    combined = events + extra
    combined.sort(key=lambda item: int(item.get("ts") or 0))
    return combined


async def self_iter_propose(
    event: Any = None, limit: Any = 40, _actor: str = "master", **_: Any
) -> dict[str, Any]:
    """产出入口：模型读最近材料 → findings → 三闸 → 提案。

    没有这一步，`self_iter_list` 永远是空的：提案不可能凭空出现。
    ``_actor="auto"`` 只给 `auto_tick` 用：不传 event（`_require_master(None)` 放行），
    审计里记 auto；产出与手动完全一样，都是 pending 提案，绝不自动 apply。
    """
    blocked = _require_master(event)
    if blocked:
        return blocked
    # 手动反思也是重活：夜间静默窗口内不跑，直接返回 blocked（不补跑）
    quiet = night_quiet.evaluate("self_iter")
    if quiet["blocked"]:
        night_quiet.record(quiet, caller="self_iter.self_iter_propose", extra={"actor": _actor})
        return tr.result_blocked(
            "night-quiet",
            quiet["reason"] + "；窗口结束后也不会自动补跑。",
            "这次没执行，别假装跑过；直接说夜间不做重活，白天再提。",
        )
    events = _recent_events(_int(limit, 40, 5, 120))
    events = _merge_media_notes(events, _media_note_rows())
    if len(events) < 5:
        return tr.result_done("no-result", f"最近的材料只有 {len(events)} 条，先攒够 5 条再反思")
    gates = store.self_iter_config()["gates"]
    material = "\n".join(
        f"- messageId={item['messageId']} | sceneKey={item['sceneKey']} | {item['nick']}：{item['text']}"
        for item in events
    )
    spec = mutation_policy.read_output_spec()
    dnd = mutation_policy.current_value("dnd")
    spec_line = (
        f"当前输出规范 revision={mutation_policy.spec_revision()}；"
        f"maxChars={spec.get('reply', {}).get('maxChars')} "
        f"emojiPer100={spec.get('reply', {}).get('emojiPer100')} "
        f"tone={spec.get('tone', {}).get('intensity')}/{spec.get('tone', {}).get('humor')}；"
        f"当前作息 start={dnd.get('start') or '空'} end={dnd.get('end') or '空'}"
    )
    user = (
        "材料（从旧到新）：\n"
        + material
        + "\n\n"
        + spec_line
        + "\n\n"
        + "说明：带【图片评价·我自己的判断】的行是你之前看图/视频后留下的判断，括号里是来源；"
        "可以用它当依据，但不要把同一条判断再记一遍。带【出站违规】的行是你上一轮发出去的正文"
        "没达标，只有这种行才能支撑 tune。\n\n"
        + PROPOSE_RULES.format(
            max_findings=gates["maxFindings"], min_conf=gates["minConfidence"]
        )
    )
    try:
        raw = await judge_mod.chat_direct(
            PROPOSE_SYSTEM, user, max_tokens=900, timeout_s=90.0, temperature=0.2
        )
    except Exception as exc:  # noqa: BLE001
        store.metric({"action": "propose", "ok": False, "error": type(exc).__name__})
        return tr.result_fail(
            "upstream-error", f"反思没跑成（{type(exc).__name__}）", "不要向用户解释细节，也不要重试。"
        )
    parsed = judge_mod.extract_json(raw) or {}
    findings = parsed.get("findings")
    if not isinstance(findings, list):
        store.metric({"action": "propose", "ok": False, "error": "bad-json"})
        return tr.result_fail(
            "upstream-error", "反思输出不是约定的 JSON", "不要重试，也不要向用户解释。"
        )
    verdict = validate_findings(
        findings, events, _notebook_entries(), _read_text(store.persona_path()), gates
    )
    proposals = build_proposals(verdict["accepted"])
    for proposal in proposals:
        store.save_proposal(proposal)
    store.metric(
        {
            "action": "propose",
            "actor": _actor,
            "ok": True,
            "model": "direct",
            "materials": len(events),
            "accepted": len(verdict["accepted"]),
            "rejected": len(verdict["rejected"]),
            "proposals": len(proposals),
        }
    )
    store.audit(
        {
            "action": "propose",
            "actor": _actor,
            "materials": len(events),
            "accepted": len(verdict["accepted"]),
            "rejected": verdict["rejected"],
            "proposals": [proposal.get("id") for proposal in proposals],
        }
    )
    reasons = [str(row.get("reason") or "") for row in verdict["rejected"]]
    return tr.result_ok(
        f"反思完成：新增 {len(proposals)} 条提案（通过 {len(verdict['accepted'])}，拒绝 {len(verdict['rejected'])}）",
        data={
            "materials": len(events),
            "proposals": [
                {
                    "id": proposal.get("id"),
                    "kind": proposal.get("kind"),
                    "status": proposal.get("status"),
                    "title": proposal.get("title"),
                }
                for proposal in proposals
            ],
            "rejected": reasons,
        },
    )


# --------------------------------------------------------------------------- #
# 自动触发（spec §16.2）：连续 10 分钟无活动 / 每 3 小时 ≤1 次 / 每天 ≤8 次
# 只出提案；不调用 apply_proposal，因此 auto_apply 对代码与只读区永远关着。
# --------------------------------------------------------------------------- #
AUTO_STATE_FILE = "auto-state.json"
AUTO_TAG = "auto"
# 闲时判据用的三个台账（turns.jsonl 只有 llm_request，没有回合结束行，
# 所以「无进行中回合」只能用「最近没有新的请求/出站」近似，见 §16.2 的限制说明）。
AUTO_ACTIVITY_FILES = ("inbound.jsonl", "turns.jsonl", "outbound.jsonl")


def auto_config() -> dict[str, Any]:
    raw = CFG.get("self_iter")
    source = raw if isinstance(raw, dict) else {}
    auto = source.get("auto") if isinstance(source.get("auto"), dict) else {}
    return {
        "enabled": auto.get("enabled") is not False,
        "idleMinutes": _int(auto.get("idleMinutes"), 10, 1, 180),
        "maxPerDay": _int(auto.get("maxPerDay"), 8, 1, 48),
        "gapHours": _int(auto.get("gapHours"), 3, 1, 24),
        "materialLimit": _int(auto.get("materialLimit"), 30, 5, 120),
        "skipLogSeconds": _int(auto.get("skipLogSeconds"), 1800, 60, 86400),
        "pollSeconds": _int(auto.get("pollSeconds"), 60, 15, 900),
    }


def auto_state_path() -> str:
    return os.path.join(store.data_dir(), AUTO_STATE_FILE)


def _auto_state() -> dict[str, Any]:
    doc = store.read_json(auto_state_path(), {})
    if not isinstance(doc, dict):
        doc = {}
    runs: list[int] = []
    for value in doc.get("runs") or []:
        try:
            runs.append(int(value))
        except (TypeError, ValueError):
            continue
    return {
        "runs": runs[-64:],
        "lastRunMs": int(doc.get("lastRunMs") or 0),
        "lastMaterialKey": str(doc.get("lastMaterialKey") or ""),
        "lastResult": str(doc.get("lastResult") or ""),
        "lastSkipReason": str(doc.get("lastSkipReason") or ""),
        "lastSkipMs": int(doc.get("lastSkipMs") or 0),
    }


def _save_auto_state(state: dict[str, Any]) -> None:
    try:
        store.write_json_atomic(auto_state_path(), state)
    except Exception as exc:  # noqa: BLE001 - 状态写失败不影响主链路
        store.audit({"action": "auto-state-error", "error": type(exc).__name__})


def _tail_ms(name: str, field: str = "wall_ms", rows: int = 400) -> int:
    """读 audit/<name> 尾部最大 wall_ms；文件不存在返回 0。"""
    path = os.path.join(store.STATE_DIR, "audit", name)
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 262144))
            chunk = f.read()
    except OSError:
        return 0
    latest = 0
    for line in chunk.split(b"\n")[-rows:]:
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line.decode("utf-8", "replace"))
        except ValueError:
            continue
        if not isinstance(row, dict):
            continue
        try:
            latest = max(latest, int(row.get(field) or 0))
        except (TypeError, ValueError):
            continue
    return latest


def _material_key(events: list[dict[str, Any]]) -> str:
    ids = "|".join(str(event.get("messageId") or "") for event in events)
    return hashlib.md5(ids.encode("utf-8")).hexdigest()[:16]


def _runs_today(state: dict[str, Any], now_ms: int) -> int:
    today = time.strftime("%Y-%m-%d", time.localtime(now_ms / 1000))
    return sum(
        1
        for ms in state["runs"]
        if time.strftime("%Y-%m-%d", time.localtime(ms / 1000)) == today
    )


def auto_gate(now_ms: int | None = None) -> dict[str, Any]:
    """只判定「该不该跑」。ok=False 时 reason 是闸门码，log 表示这条拒绝值不值得记。

    「not-idle」不记（一天里绝大多数轮询都属于它，记了就是刷屏）；
    「gap / daily-cap / same-window」记，因为它们代表「本该跑但被节流」。
    """
    now = int(time.time() * 1000) if now_ms is None else int(now_ms)
    cfg = auto_config()
    state = _auto_state()
    base: dict[str, Any] = {"cfg": cfg, "state": state, "now": now}
    if not store.self_iter_config()["enabled"]:
        return {"ok": False, "reason": "self-iter-disabled", "log": False, **base}
    if not cfg["enabled"]:
        return {"ok": False, "reason": "auto-disabled", "log": False, **base}
    # 夜间静默：自动反思属于重活，整轮跳过且不补跑；log=True 让 auto-skip 落一条
    quiet = night_quiet.evaluate("self_iter")
    if quiet["blocked"]:
        night_quiet.record(quiet, caller="self_iter.auto_gate")
        return {"ok": False, "reason": "night-quiet", "log": True, "night": quiet, **base}
    last_activity = max(_tail_ms(name) for name in AUTO_ACTIVITY_FILES)
    if last_activity <= 0:
        return {"ok": False, "reason": "no-inbound", "log": False, **base}
    idle_ms = now - last_activity
    if idle_ms < cfg["idleMinutes"] * 60_000:
        return {"ok": False, "reason": "not-idle", "log": False, "idleMs": idle_ms, **base}
    today_count = _runs_today(state, now)
    since_run = now - int(state["lastRunMs"]) if state["lastRunMs"] else None
    if since_run is not None and since_run < cfg["gapHours"] * 3600_000:
        return {
            "ok": False,
            "reason": "gap",
            "log": True,
            "idleMs": idle_ms,
            "sinceRunMs": since_run,
            "todayCount": today_count,
            **base,
        }
    if today_count >= cfg["maxPerDay"]:
        return {
            "ok": False,
            "reason": "daily-cap",
            "log": True,
            "idleMs": idle_ms,
            "todayCount": today_count,
            **base,
        }
    events = _recent_events(cfg["materialLimit"])
    key = _material_key(events)
    if key and key == state["lastMaterialKey"]:
        return {
            "ok": False,
            "reason": "same-window",
            "log": True,
            "idleMs": idle_ms,
            "todayCount": today_count,
            "materialKey": key,
            "materials": len(events),
            **base,
        }
    if len(events) < 5:
        return {
            "ok": False,
            "reason": "material-too-small",
            "log": False,
            "materials": len(events),
            **base,
        }
    return {
        "ok": True,
        "reason": "ok",
        "log": True,
        "idleMs": idle_ms,
        "todayCount": today_count,
        "materialKey": key,
        "materials": len(events),
        **base,
    }


def _record_auto_skip(gate: dict[str, Any]) -> None:
    state = gate["state"]
    now = int(gate["now"])
    reason = str(gate["reason"])
    interval = int(gate["cfg"]["skipLogSeconds"]) * 1000
    # 同一原因在 skipLogSeconds 内只记一次，避免闲时轮询把 ledger 刷满。
    if reason == state["lastSkipReason"] and now - int(state["lastSkipMs"]) < interval:
        return
    state["lastSkipReason"] = reason
    state["lastSkipMs"] = now
    _save_auto_state(state)
    store.audit(
        {
            "action": "auto-skip",
            "actor": AUTO_TAG,
            "reason": reason,
            "idleMs": gate.get("idleMs"),
            "sinceRunMs": gate.get("sinceRunMs"),
            "todayCount": gate.get("todayCount"),
            "materials": gate.get("materials"),
            "materialKey": gate.get("materialKey"),
        }
    )
    store.metric({"action": "auto", "ok": False, "reason": reason, "actor": AUTO_TAG})


async def auto_tick(now_ms: int | None = None) -> dict[str, Any]:
    """定时器每 pollSeconds 调一次：过闸则跑一次 propose，只写 pending 提案。"""
    gate = auto_gate(now_ms)
    if not gate["ok"]:
        if gate.get("log"):
            _record_auto_skip(gate)
        return {
            "ran": False,
            "reason": gate["reason"],
            "idleMs": gate.get("idleMs"),
            "todayCount": gate.get("todayCount"),
            "materialKey": gate.get("materialKey"),
        }
    now = int(gate["now"])
    state = gate["state"]
    cfg = gate["cfg"]
    result = await self_iter_propose(None, limit=cfg["materialLimit"], _actor=AUTO_TAG)
    ok = str(result.get("state") or "") == "ok"
    data = result.get("data") if isinstance(result.get("data"), dict) else {}
    proposals = [str(row.get("id") or "") for row in (data.get("proposals") or [])]
    state["runs"] = (state["runs"] + [now])[-64:]
    state["lastRunMs"] = now
    state["lastResult"] = f"ok:{len(proposals)}" if ok else "failed:" + str(result.get("code") or "")
    if ok:
        # 只有成功才占住材料窗口；失败后隔一个 gapHours 还能重试同一批材料。
        state["lastMaterialKey"] = str(gate["materialKey"])
    _save_auto_state(state)
    store.audit(
        {
            "action": "auto-run",
            "actor": AUTO_TAG,
            "ok": ok,
            "code": result.get("code"),
            "idleMs": gate.get("idleMs"),
            "todayCount": gate.get("todayCount"),
            "materials": gate.get("materials"),
            "materialKey": gate.get("materialKey"),
            "proposals": proposals,
        }
    )
    store.metric(
        {
            "action": "auto",
            "actor": AUTO_TAG,
            "ok": ok,
            "proposals": len(proposals),
            "materials": gate.get("materials"),
        }
    )
    return {
        "ran": True,
        "ok": ok,
        "code": result.get("code"),
        "proposals": proposals,
        "materials": gate.get("materials"),
        "idleMs": gate.get("idleMs"),
        "todayCount": gate.get("todayCount"),
    }


TOOL_SPECS: list[dict[str, Any]] = [
    {
        "name": "self_iter_propose",
        "description": (
            "跑一次反思并产出提案（仅主人）：读最近聊天材料，过三闸后写入待审提案。"
            "只有主人明确说“反思一下/整理记忆”时才调用；产出后仍需主人逐条 apply。"
        ),
        "parameters": {
            "limit": {"type": "number", "description": "取最近多少条材料，默认 40，范围 5~120"},
        },
        "handler": self_iter_propose,
    },
    {
        "name": "self_iter_list",
        "description": (
            "自迭代提案列表（仅主人）：查看反思产生的待审/已应用/已回滚提案。"
            "只有主人明确问“有什么提案/自迭代了什么”时才调用。"
        ),
        "parameters": {
            "status": {"type": "string", "description": "pending（默认）/ applied / rejected / stale / rolledback / all"},
            "limit": {"type": "number", "description": "返回条数，默认 20，最大 200"},
        },
        "handler": self_iter_list,
    },
    {
        "name": "self_iter_apply",
        "description": (
            "应用一条自迭代提案（仅主人）：过内容闸与哈希/备份闸后写入人格或笔记本。"
            "只有主人明确说“同意/应用这条”时才调用，必须带提案 id。"
        ),
        "parameters": {
            "proposal_id": {"type": "string", "required": True, "description": "提案 id，例如 si-20261114-2805153"},
        },
        "handler": self_iter_apply,
    },
    {
        "name": "self_iter_reject",
        "description": "拒绝一条自迭代提案（仅主人），必须带提案 id。",
        "parameters": {
            "proposal_id": {"type": "string", "required": True, "description": "提案 id"},
            "reason": {"type": "string", "description": "拒绝原因，默认 manual"},
        },
        "handler": self_iter_reject,
    },
    {
        "name": "self_iter_rollback",
        "description": (
            "回滚一条已应用的自迭代提案（仅主人）：用备份文件恢复，"
            "当前文件已被人改过时拒绝执行（drift-detected）。必须带提案 id。"
        ),
        "parameters": {
            "proposal_id": {"type": "string", "required": True, "description": "提案 id"},
        },
        "handler": self_iter_rollback,
    },
]


# --------------------------------------------------------------------------- #
# 离线用例：python self_iter.py
# --------------------------------------------------------------------------- #
def _offline_selftest() -> int:
    """三道缺口的离线用例：全在临时目录里跑，不碰线上文件、不连引擎、不重启任何服务。"""
    import shutil
    import tempfile

    failures: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"{'PASS' if ok else 'FAIL'} {name}" + (f" — {detail}" if detail and not ok else ""))
        if not ok:
            failures.append(name)

    root = tempfile.mkdtemp(prefix="self-iter-selftest-")
    persona = os.path.join(root, "character.md")
    notebook = os.path.join(root, "notebook.json")
    base_text = "# 角色\n\n做一个安静的人。\n"
    with open(persona, "w", encoding="utf-8") as f:
        f.write(base_text)
    with open(notebook, "w", encoding="utf-8") as f:
        json.dump({"version": 3, "entries": []}, f, ensure_ascii=False)

    def setup(persona_path: str = persona) -> None:
        configure(
            {
                "master_qq": "1",
                "persona_path": persona_path,
                "notebook_path": notebook,
                "self_iter": {"data_dir": os.path.join(root, "self-iter")},
            }
        )

    def reset_persona() -> None:
        with open(persona, "w", encoding="utf-8") as f:
            f.write(base_text)

    def ledger_has(action: str, needle: str) -> bool:
        try:
            with open(store.ledger_path(), encoding="utf-8") as f:
                return any(action in line and needle in line for line in f)
        except OSError:
            return False

    def character_case(pid: str, text: str) -> dict[str, Any]:
        return {
            "id": pid,
            "ts": store.now_iso(),
            "kind": "character",
            "status": "pending",
            "title": "离线用例",
            "payload": {"target": "append_section", "text": text, "fix": ""},
            "beforeHash": store.file_hash(persona),
            "afterHash": "",
        }

    setup()
    try:
        # ---- 缺口 1：apply 前语法/导入/格式断言 ---------------------------- #
        syntax = _python_assertion("def broken(:\n    pass\n", "probe.py")
        check("gap1 .py 语法断言拒绝坏代码", syntax.startswith("python-syntax"), syntax)
        check("gap1 .py 语法断言放行好代码", _python_assertion("import json\nVALUE = 1\n", "probe.py") == "")
        missing = _python_assertion("import module_that_does_not_exist_xyz\n", "probe.py")
        check("gap1 .py 导入断言拒绝缺失模块", missing.startswith("python-import"), missing)
        check("gap1 文本断言拒绝空文件", _assert_content_ok("character.md", "   \n") != "")
        bad_json = _assert_content_ok("notebook.json", "{oops")
        check("gap1 json 断言拒绝坏内容", bad_json.startswith("json-invalid"), bad_json)
        check("gap1 jsonl 断言放行合法行", _assert_content_ok("diary.jsonl", '{"a":1}\n{"b":2}\n') == "")

        # ---- 缺口 3：写入路径白名单 ---------------------------------------- #
        check("gap3 人格文件放行", _guard_write_path(persona, action="selftest") is None)
        check(
            "gap3 同目录日记放行",
            _guard_write_path(os.path.join(root, "diary.jsonl"), action="selftest") is None,
        )
        denied = _guard_write_path(os.path.join(root, "main.py"), action="selftest")
        check(
            "gap3 插件源码拒绝",
            isinstance(denied, dict) and denied.get("reason") == "write-path-denied",
            str(denied),
        )
        check("gap3 拒绝原因落 ledger", ledger_has("deny-write", "main.py"))
        denied_other_dir = _guard_write_path(os.path.join(root, "sub", "diary.jsonl"), action="selftest")
        check(
            "gap3 异地 diary 拒绝",
            isinstance(denied_other_dir, dict) and denied_other_dir.get("reason") == "write-path-denied",
            str(denied_other_dir),
        )

        evil_persona = os.path.join(root, "main.py")
        with open(evil_persona, "w", encoding="utf-8") as f:
            f.write("# not a target\n")
        setup(evil_persona)
        out = apply_proposal(character_case("si-selftest-denied", "离线用例的越界人格内容"), "selftest")
        check("gap3 apply 被白名单拦下", out.get("reason") == "write-path-denied", str(out))
        check("gap3 被拦后不写目标文件", _read_text(evil_persona) == "# not a target\n")
        setup()

        # ---- 缺口 2：最小回放 apply → rollback → 哈希复原 ------------------ #
        original_hash = store.file_hash(persona)
        replay = replay_roundtrip(character_case("si-selftest-replay", "离线回放追加的一句规则"), "selftest")
        check("gap2 人格回放成功", replay.get("ok") is True, str(replay))
        check("gap2 人格回放后哈希复原", store.file_hash(persona) == original_hash, str(replay))
        check("gap2 人格回放结束时状态是 rolledback", replay.get("stage") == "done", str(replay))

        # 故意失败一：apply 后有人改了文件（drift），回滚必须拒绝且保持 applied。
        drift = character_case("si-selftest-drift", "漂移用例追加的一句规则")
        check("gap2 漂移用例先 apply 成功", apply_proposal(drift, "selftest").get("ok") is True)
        with open(persona, "a", encoding="utf-8") as f:
            f.write("\n人工改动\n")
        out = rollback_proposal(drift, "selftest")
        check("gap2 漂移时回滚被拒", out.get("reason") == "drift-detected", str(out))
        check("gap2 漂移失败后状态仍是 applied", drift.get("status") == "applied", str(drift.get("status")))
        check("gap2 漂移失败有审计", ledger_has("rollback-failed", "drift-detected"))
        reset_persona()

        # 故意失败二：备份被篡改，回滚必须在替换前发现哈希不符，目标文件不动。
        tampered = character_case("si-selftest-tamper", "备份篡改用例追加的一句规则")
        check("gap2 篡改用例先 apply 成功", apply_proposal(tampered, "selftest").get("ok") is True)
        with open(str(tampered.get("backupPath")), "wb") as f:
            f.write(b"tampered backup\n")
        out = rollback_proposal(tampered, "selftest")
        check("gap2 备份被改时回滚失败", out.get("reason") == "rollback-hash-mismatch", str(out))
        check(
            "gap2 失败后目标文件未被覆盖",
            store.file_hash(persona) == tampered.get("afterHash"),
            str(out),
        )
        check("gap2 失败留 rollbackError", isinstance(tampered.get("rollbackError"), dict))
        check("gap2 失败不写 rolledback", tampered.get("status") == "applied", str(tampered.get("status")))
        reset_persona()

        # notebook 同样回放一次，确认两类目标都走同一套校验。
        notebook_hash = store.file_hash(notebook)
        nb_proposal = {
            "id": "si-selftest-notebook",
            "ts": store.now_iso(),
            "kind": "notebook",
            "status": "pending",
            "title": "周末骑车：周末去西湖骑车拍照",
            "payload": {"action": "remember", "category": "note", "subject": "周末骑车", "text": "周末去西湖骑车拍照"},
            "confidence": 0.8,
            "sceneKey": "group:1",
            "evidence": [{"messageId": "m-selftest", "ts": 0}],
            "beforeHash": "",
            "afterHash": "",
        }
        replay_nb = replay_roundtrip(nb_proposal, "selftest")
        check("gap2 笔记本回放成功", replay_nb.get("ok") is True, str(replay_nb))
        check("gap2 笔记本回放后哈希复原", store.file_hash(notebook) == notebook_hash, str(replay_nb))

        print("SKIP 反思链路（self_iter_propose 需要模型/引擎）：按约定不跑、不重启引擎或 AstrBot。")
    finally:
        shutil.rmtree(root, ignore_errors=True)

    print(f"\n离线用例：{len(failures)} 条失败" if failures else "\n离线用例：全部通过")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(_offline_selftest())
