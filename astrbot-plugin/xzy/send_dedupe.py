"""发送工具接管：同轮去重 + 回显 / 预览 / 撤回台账。

为什么需要（AstrBot 4.14.6 原生，不改源码）：
- `send_message_to_user` 的实现直接 `context.context.context.send_message(...)`，
  走 platform 发送层，不经过 result_decorate/respond，也不写 `event.result`；
- 同轮最终结果由 `tool_loop_agent_runner.step()` 产出 `llm_result`，
  `astr_agent_run_util.run_agent` 把它 `set_result` 进 `event.result` 再由 respond 发送；
- 原生工具只回一句 `Message sent to session ...`，模型看不到真实 message_id，
  也没法在发出前反悔。

插件侧在 `on_llm_request` 把工具集里的 `send_message_to_user` 换成本轮专属包装件，
同名替换、不动原生单例，提供四件事：
1. **真实回显**：返回实际发出去的正文（截断）+ bridge 台账里的 message_id；
2. **预览**：`commit=false` 只返回将要发送的内容与目标，不发送、不占幂等键；
3. **幂等**：同一 message_id 已被任何路径答过，这里直接「未发送」并说明来源；
4. **清洗**：工具正文同样先剥 `【内心】`/草稿标记，改过就写「已改写」，
   剥空就「未发送（清洗后无可发正文）」；
5. **精确记账**：`inner.call` 成功返回的那一刻就是正文真实出站的时刻，同时写
   进程内小账与 `audit/outbound.jsonl`（`stage=builtin_tool`），不再靠 2s 后
   `decorating_result` 的生成时间反推。

`on_decorating_result` 见到「本轮已发过同样正文」时整条清空，不再发第二条。
"""

from __future__ import annotations

import asyncio
import copy
import json
import os
import re
import time
from typing import Any

from pydantic import Field
from pydantic.dataclasses import dataclass

from astrbot.core.agent.tool import FunctionTool

try:
    from . import answer_ledger
    from . import continuation
    from . import outbound_clean
    from . import output_spec_gate
except ImportError:  # AstrBot 以模块方式加载
    import answer_ledger  # type: ignore
    import continuation  # type: ignore
    import outbound_clean  # type: ignore
    import output_spec_gate  # type: ignore

TOOL_NAME = "send_message_to_user"
_TTL_SECONDS = 300.0
_STATE: dict[str, dict[str, Any]] = {}
_PUNCT = re.compile(r"[\s\u200B-\u200D，。！？、；：,.!?;:\"'“”‘’（）()【】\[\]…—\-~]+")
_COMMIT_DESC = (
    "默认 true 直接发送。设为 false 只预览：返回将要发送的正文与目标，"
    "不发送、不占用幂等键；确认后再以 commit=true 调一次。"
)


def _norm(text: str) -> str:
    return _PUNCT.sub("", (text or "").lower())


def begin_turn(umo: str) -> None:
    """新回合开始：清掉上一轮的去重状态。"""
    if umo:
        _STATE[umo] = {"texts": [], "ts": time.monotonic()}


def _plain_text(messages: Any) -> str:
    if not isinstance(messages, list):
        return ""
    parts = []
    for item in messages:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "plain" and str(item.get("text") or "").strip():
            parts.append(str(item["text"]))
    return "\n".join(parts).strip()


def _has_media(messages: Any) -> bool:
    if not isinstance(messages, list):
        return False
    return any(
        isinstance(m, dict) and m.get("type") not in (None, "", "plain") for m in messages
    )


def _clip(text: str, limit: int = 200) -> str:
    text = text or ""
    return text if len(text) <= limit else text[:limit] + f"…（共 {len(text)} 字）"


def _chat_key(event: Any) -> str:
    try:
        gid = str(event.get_group_id() or "")
        if gid:
            return gid
        return f"private:{event.get_sender_id()}"
    except Exception:
        return ""


def _record(umo: str, text: str) -> None:
    if not umo or not text:
        return
    state = _STATE.setdefault(umo, {"texts": [], "ts": time.monotonic()})
    state["texts"].append(_norm(text))
    state["ts"] = time.monotonic()


def _prepare(messages: Any) -> tuple[Any, str, dict[str, Any] | None, bool]:
    """清洗正文，返回 (清洗后的 messages, 原文, 清洗结果, 是否改过)。"""
    if not isinstance(messages, list) or not messages:
        return messages, "", None, False
    plain_idx = [
        i
        for i, m in enumerate(messages)
        if isinstance(m, dict) and m.get("type") == "plain"
    ]
    if not plain_idx:
        return messages, "", None, False
    original = "\n".join(str(messages[i].get("text") or "") for i in plain_idx).strip()
    cleaned = outbound_clean.clean_outbound(original)
    new_messages: list[Any] = []
    placed = False
    for idx, item in enumerate(messages):
        if isinstance(item, dict) and item.get("type") == "plain":
            if not placed and cleaned["text"]:
                new_messages.append({**item, "text": cleaned["text"]})
                placed = True
            continue
        new_messages.append(item)
    return new_messages, original, cleaned, cleaned["text"] != original


def _latest_sent_id(ledger_path: str, chat_key: str, after_ts: float) -> str:
    if not ledger_path or not chat_key:
        return ""
    try:
        with open(ledger_path, encoding="utf-8") as fh:
            rows = [json.loads(line) for line in fh if line.strip()]
    except Exception:
        return ""
    for row in reversed(rows):
        if str(row.get("chat") or "") != chat_key:
            continue
        try:
            if float(row.get("at") or 0) < after_ts:
                continue
        except Exception:
            continue
        return str(row.get("message_id") or "")
    return ""


async def _await_sent_id(
    ledger_path: str, chat_key: str, after_ts: float, timeout: float = 1.2
) -> str:
    deadline = time.monotonic() + timeout
    while True:
        mid = _latest_sent_id(ledger_path, chat_key, after_ts)
        if mid:
            return mid
        if time.monotonic() >= deadline:
            return ""
        await asyncio.sleep(0.1)


def _sent_line(
    sent_text: str,
    mid: str,
    chat_key: str,
    changed: bool,
    cleaned: dict[str, Any] | None,
) -> str:
    head = "已改写后发送" if changed else "已发送"
    reason = ""
    if changed and cleaned:
        reason = f" | 改写原因={cleaned.get('reason') or 'clean'}"
    mid_text = mid or "unknown（1.2s 内未在 bridge 台账看到这条）"
    return (
        f"{head} | message_id={mid_text} | 目标={chat_key or '未知'}"
        f"{reason} | 正文={_clip(sent_text)}"
    )


# 必须重写 `call` 而不是给 `handler` 赋值：原生 `call_local_llm_tool` 对
# `decorator_handler` 传的是 **event**，对 `call` 传的才是 ContextWrapper；
# 而 SendMessageToUserTool.call 需要 ContextWrapper 才能拿到 plugin Context。
@dataclass
class _SendProxy(FunctionTool):
    name: str = "send_message_to_user"
    description: str = ""
    parameters: dict = Field(default_factory=dict)
    inner: Any = None
    ledger_path: str = ""

    async def call(self, context: Any, **kwargs: Any) -> Any:
        try:
            event = context.context.event
        except Exception:
            event = None
        umo = str(getattr(event, "unified_msg_origin", "") or "")
        ids = answer_ledger.event_ids(event) if event is not None else []
        chat_key = _chat_key(event)

        commit = kwargs.pop("commit", True)
        commit = True if commit is None else bool(commit)
        raw_messages = kwargs.get("messages")
        text = _plain_text(raw_messages)
        prepared, original, cleaned, changed = _prepare(raw_messages)
        cleaned_dropped = bool(cleaned and cleaned.get("dropped"))

        # 1) 预览：不发送、不占键，只把将要发生的事告诉模型
        if not commit:
            blocked = answer_ledger.answered(umo, ids) if text else None
            preview_text = (cleaned or {}).get("text", original)
            tail = f" | 幂等=已占用（{blocked}），commit 也不会发出" if blocked else ""
            if cleaned_dropped:
                tail += f" | 清洗=会整条丢弃（{cleaned.get('reason')}）"
            elif changed:
                tail += f" | 清洗=会改写（{cleaned.get('reason')}）"
            return (
                f"预览（未发送） | 目标={chat_key or '未知'} | 正文={_clip(preview_text)}"
                f"{tail} | 说明=确认后带 commit=true 再调一次"
            )

        # 2) 幂等：同一 message_id 先被别的路径答过，这里不发
        if text:
            answered_by = answer_ledger.answered(umo, ids)
            if answered_by:
                return (
                    f"未发送 | 原因=该消息已由 {answered_by} 答复（幂等键已占用）"
                    f" | 正文={_clip(text)}"
                )

        # 3) 清洗后没有正文：整条不发（有媒体时只发媒体）
        if cleaned_dropped and not _has_media(prepared):
            return (
                f"未发送 | 原因=清洗后无可发正文（{cleaned.get('reason')}）"
                f" | 原正文={_clip(original)}"
            )
        if not prepared:
            return "未发送 | 原因=清洗后没有可发送的内容"

        # 4) 真发；成功后再从 bridge 台账取回真实 message_id
        kwargs["messages"] = prepared
        started = time.time()
        result = await self.inner.call(context, **kwargs)
        failed = isinstance(result, str) and result.lstrip().lower().startswith("error")
        if failed:
            return f"未发送 | 原因={result} | 目标={chat_key or '未知'}"
        sent_text = (cleaned or {}).get("text") or text
        _record(umo, sent_text)
        # 真实发送时刻：`inner.call` 已返回成功，正文此刻出站。记账放在这里、
        # 而不是 2s 后的 decorating_result 上，也不受下面 1.2s 取 message_id 的影响。
        continuation.note_outbound(
            umo, sent_text, stage="builtin_tool", persist=True
        )
        # 工具直发不经过 `on_decorating_result`，门禁不会自己跑；这里补写同一份
        # `audit/output_spec.jsonl`，否则这条出站没有规范审计行。
        try:
            output_spec_gate.audit_text(sent_text, umo, stage="builtin_tool")
        except Exception:  # noqa: BLE001 - 审计失败不影响发送
            pass
        if sent_text:
            answer_ledger.mark(umo, ids, "tool", sent_text)
        mid = await _await_sent_id(self.ledger_path, chat_key, started)
        return _sent_line(sent_text, mid, chat_key, changed, cleaned)


def install(toolset: Any, ledger_path: str = "") -> bool:
    """把本轮的工具集里的发送工具换成带记录/回显/预览的包装件。"""
    getter = getattr(toolset, "get_tool", None)
    adder = getattr(toolset, "add_tool", None)
    if getter is None or adder is None:
        return False
    original = getter(TOOL_NAME)
    if original is None:
        return False

    params = copy.deepcopy(
        getattr(original, "parameters", {"type": "object", "properties": {}})
    )
    if not isinstance(params, dict):
        params = {"type": "object", "properties": {}}
    props = params.setdefault("properties", {})
    if isinstance(props, dict):
        props["commit"] = {"type": "boolean", "description": _COMMIT_DESC}

    desc = getattr(original, "description", "") or ""
    proxy = _SendProxy(
        name=getattr(original, "name", TOOL_NAME),
        description=desc + "\n返回真实发送结果（message_id 可用于 qq_recall）；commit=false 仅预览。",
        parameters=params,
        inner=original,
        ledger_path=ledger_path,
    )
    adder(proxy)
    return True


def is_duplicate(umo: str, text: str) -> bool:
    """本轮是否已通过工具发出过同样的正文。"""
    state = _STATE.get(umo)
    if not state:
        return False
    if time.monotonic() - state.get("ts", 0.0) > _TTL_SECONDS:
        _STATE.pop(umo, None)
        return False
    current = _norm(text)
    if not current:
        return False
    for sent in state.get("texts") or []:
        if not sent:
            continue
        if current == sent:
            return True
        short, long = (current, sent) if len(current) <= len(sent) else (sent, current)
        if len(short) >= 8 and short in long:
            return True
    return False
