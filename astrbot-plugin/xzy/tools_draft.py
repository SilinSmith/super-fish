"""草稿本四件套：只写不发 / 读回 / 丢弃 / 提交。

设计：草稿是独立缓冲区，`qq_draft_write` 绝不触发发送；
只有 `qq_draft_submit` 会出站，且提交前必须过 `outbound_clean`（含 `【内心】` 剥离）
与 `answer_ledger` / `send_dedupe` 两道幂等，发送出口复用 `tool_send`。
"""

from __future__ import annotations

import asyncio
from typing import Any

try:
    from . import answer_ledger
    from . import bubbles
    from . import draftbook
    from . import outbound_clean
    from . import send_dedupe
    from . import tool_result as tr
    from . import tool_send
except ImportError:  # 扁平模块加载
    import answer_ledger  # type: ignore
    import bubbles  # type: ignore
    import draftbook  # type: ignore
    import outbound_clean  # type: ignore
    import send_dedupe  # type: ignore
    import tool_result as tr  # type: ignore
    import tool_send  # type: ignore


def configure(cfg: dict[str, Any] | None = None) -> None:
    draftbook.configure(cfg)


def _umo(event: Any) -> str:
    return str(getattr(event, "unified_msg_origin", "") or "")


async def qq_draft_write(
    event: Any = None,
    text: str = "",
    note: str = "",
    **_: Any,
) -> dict[str, Any]:
    body = (text or "").strip()
    if not body:
        raise ValueError("参数 text 必填：要写进草稿本的正文")
    umo = _umo(event)
    info = draftbook.write(umo, body, note=note)
    preview = outbound_clean.clean_outbound(body)
    warn = ""
    if preview.get("dropped"):
        warn = f"；注意：这份草稿按现有清洗会被整条拦下（{preview.get('reason')}），提交会失败"
    return tr.result_ok(
        f"草稿第 {info['version']} 版已存（{info['chars']} 字），**未发送**。"
        f"改完用 qq_draft_submit 提交，或用 qq_draft_discard 丢掉{warn}",
        version=info["version"],
        chars=info["chars"],
        preview_chars=len(preview.get("text") or ""),
    )


async def qq_draft_show(event: Any = None, **_: Any) -> dict[str, Any]:
    umo = _umo(event)
    data = draftbook.current(umo)
    text = str(data.get("text") or "")
    version = int(data.get("version") or 0)
    if not text:
        return tr.result_ok("草稿本是空的。", version=0, chars=0)
    history = [
        f"v{item.get('version')}（{item.get('chars')} 字，{item.get('source') or 'model'}）"
        for item in (data.get("versions") or [])[-3:]
    ]
    return tr.result_ok(
        f"当前草稿第 {version} 版（{len(text)} 字，未发送）：\n{text}\n\n"
        f"历史：{' / '.join(history)}",
        version=version,
        chars=len(text),
    )


async def qq_draft_discard(
    event: Any = None,
    reason: str = "",
    **_: Any,
) -> dict[str, Any]:
    umo = _umo(event)
    info = draftbook.discard(umo, reason=reason)
    if not info["chars"]:
        return tr.result_ok("草稿本来是空的，没有可丢的。", version=info["version"])
    return tr.result_ok(
        f"已丢弃第 {info['version']} 版草稿（{info['chars']} 字），没有发送。",
        version=info["version"],
        chars=info["chars"],
    )


async def qq_draft_submit(
    event: Any = None,
    reason: str = "",
    **_: Any,
) -> dict[str, Any]:
    if event is None:
        return tr.result_fail("no-event", "拿不到当前会话，无法提交草稿", "改用 send_message_to_user。")
    umo = _umo(event)
    data = draftbook.current(umo)
    raw = str(data.get("text") or "").strip()
    version = int(data.get("version") or 0)
    if not raw:
        return tr.result_fail("empty-draft", "草稿本是空的，没有可提交的内容", "先用 qq_draft_write 写草稿。")
    if str(data.get("source") or "") == "held":
        # held = 出站清洗拦下的未定稿（推理片段 / 自我改口），直接提交等于把半成品发出去。
        return tr.result_fail(
            "held-reasoning",
            "这份草稿是出站清洗拦下的未定稿（推理片段或自我改口），不能直接提交，也没有发送。",
            "先用 qq_draft_write 写一版定稿，再 qq_draft_submit。",
        )

    cleaned = outbound_clean.clean_outbound(raw)
    if cleaned.get("dropped"):
        draftbook.submitted(umo, version, "dropped", str(cleaned.get("reason") or ""), raw)
        return tr.result_fail(
            "clean-dropped",
            f"这份草稿被出站清洗整条拦下（{cleaned.get('reason')}），没有发送。"
            f"剥完只剩 {cleaned.get('cleaned_chars')} 字。",
            "把草稿改成正文（去掉【内心】/只写要发的话）再提交，或直接丢弃。",
        )
    body = str(cleaned.get("text") or "").strip()
    if not body:
        draftbook.submitted(umo, version, "dropped", "empty-after-clean", raw)
        return tr.result_fail("clean-dropped", "清洗后没有可发正文，没有发送", "改草稿或丢弃。")

    ids = answer_ledger.event_ids(event)
    answered_by = answer_ledger.answered(umo, ids)
    if answered_by:
        draftbook.submitted(umo, version, "blocked", f"已由 {answered_by} 答复", body)
        return tr.result_blocked(
            "already-answered",
            f"这条消息已经由 {answered_by} 回答过，草稿没有发送。",
            "不要重发；要补充就用 send_message_to_user 说新内容。",
        )
    if send_dedupe.is_duplicate(umo, body):
        draftbook.submitted(umo, version, "blocked", "同轮重复", body)
        return tr.result_blocked(
            "duplicate",
            "本轮已经发过同样的正文，草稿没有重复发送。",
            "不要重发。",
        )

    chat = tool_send.current_chat(event)
    # 拆条：长草稿同样按句子边界拆 2~3 段，段间留 gapMs；message_id 记第一段。
    # 幂等仍是按「整条 body」占键，拆段不会让多段互相挡。
    parts = bubbles.split_text(body)
    message_id = await tool_send.send_segments(event, chat, [tool_send.text_seg(parts[0])])
    if len(parts) > 1:
        gap = float(bubbles.settings().get("gapMs") or 600) / 1000.0
        for index, part in enumerate(parts[1:], start=2):
            await asyncio.sleep(gap)
            try:
                extra_id = await tool_send.send_segments(
                    event, chat, [tool_send.text_seg(part)]
                )
            except Exception as exc:  # 单段失败不重试，避免重复刷屏
                extra_id, error = None, str(exc)
                error_type = type(exc).__name__
                retcode = getattr(exc, "retcode", None)
            else:
                error, error_type, retcode = "", "", None
            bubbles.audit(
                umo,
                stage="draft_submit",
                part=index,
                chars=len(part),
                message_id=extra_id,
                error=error,
                error_type=error_type,
                retcode=retcode,
            )
    answer_ledger.mark(umo, ids, "draft", body)
    try:
        send_dedupe._record(umo, body)
    except Exception:  # noqa: BLE001
        pass
    draftbook.submitted(umo, version, "sent", reason, body, message_id=message_id)
    draftbook.discard(umo, reason="submitted")
    return tr.result_ok(
        f"草稿第 {version} 版已发送（message_id={message_id}）。",
        version=version,
        chars=len(body),
        message_id=message_id,
    )


TOOL_SPECS: list[dict[str, Any]] = [
    {
        "name": "qq_draft_write",
        "description": "把一段话写进草稿本（独立缓冲区，不会发送）。可以反复调用改同一份草稿，"
        "每次都是新版本；觉得改明白了再用 qq_draft_submit 提交。想发又怕说错、"
        "或需要先打腹稿再润色时用它。",
        "parameters": {
            "text": {"type": "string", "required": True, "description": "草稿正文（只写要对人说出口的话，不要写分析）"},
            "note": {"type": "string", "description": "这一版改了什么，便于事后追（可选）"},
        },
        "handler": qq_draft_write,
    },
    {
        "name": "qq_draft_show",
        "description": "读回当前草稿（第几版、多少字、原文）与最近几版摘要；不会发送。",
        "parameters": {},
        "handler": qq_draft_show,
    },
    {
        "name": "qq_draft_discard",
        "description": "丢掉当前草稿，不发送。决定不说了、或这份草稿不要了时用。",
        "parameters": {
            "reason": {"type": "string", "description": "为什么丢掉（可选，会记审计）"},
        },
        "handler": qq_draft_discard,
    },
    {
        "name": "qq_draft_submit",
        "description": "提交当前草稿：过出站清洗（剥【内心】、只留正文）与幂等台账后真正发送。"
        "清洗整条拦下或已被别处回答过时不会发送，并告诉你原因。",
        "parameters": {
            "reason": {"type": "string", "description": "为什么现在可以发了（可选，会记审计）"},
        },
        "handler": qq_draft_submit,
    },
]
