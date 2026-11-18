"""统一工具结果契约（迁移自 dsh-onebot-qq/lib/tool-result.js，2026-11-14）。

所有工具只返回一种形状：

    {"state": "ok|done|failed|blocked", "code": "...", "why": "...",
     "next": "...", "retry": "no|changed-args|later", ...业务字段}

- ok      真做成了
- done    不用做 / 没有结果（查不到、已做过、到上限）
- failed  试过但没成
- blocked 根本没执行（权限、停用、守卫）

`render()` 是唯一渲染实现：模型看到的每一句话都来自 why/next。
原生 `FunctionTool` 会把 handler 返回值原样塞给模型；handler 抛异常会被
原生改写成英文 `error: ...` 并可能被模型原样外发（见 evidence/tools.md §1），
所以 handler 一律用 `safe_call()` 包住，禁止抛异常、禁止返回 None。
"""

from __future__ import annotations

import json
import re
from typing import Any

RESULT_STATES = ("ok", "done", "failed", "blocked")

STATE_WHY = {
    "ok": "操作已完成",
    "done": "这件事不用再做",
    "failed": "工具没有成功完成这次调用",
    "blocked": "这次调用没有执行",
}

CODE_NEXT: dict[str, str] = {
    # done
    "already-done": "这件事已经做过了，不要再调用这个工具，继续对话。",
    "no-result": "已经查过、确实没有；别再换关键词，也别换别的查询工具重查，直接用现有信息回答，不清楚就直说。",
    "limit-reached": "本回合不会再执行同类调用，直接用现在的结果回答。",
    # failed
    "bad-args": "参数不对才没执行，改对参数可以再调一次；改不对就别调，直接用文字说清楚。",
    "missing-target": "先确认要操作的对象（会话/群/消息），确认不了就别调这个工具。",
    "no-material": "这个工具确实没有可用素材，别再用同样参数重试；换个做法，或者干脆用文字表达。",
    "no-evidence": "找不到所需依据，别猜也别重复查；直接说不知道，或换一个信息来源。",
    "policy-rejected": "这是最终结果，不要重试，也不要假装已经完成。",
    "unlanded": "没有真实发送成功，不要当成已发送，也不要用同样参数重试。",
    "upstream-error": "上游这次失败了，不要立刻原样重试；过一会儿再试，或者换一种做法。",
    "timeout": "本次超时未完成，别原样重试；稍后再试，或换更简单的做法。",
    "internal": "这是工具内部错误，原样重试大概率还是失败；换别的做法或直接回答。",
    # blocked
    "forbidden": "当前会话没有这个权限，再调也不会通过；需要的话让对方找主人。",
    "disabled": "这个功能已停用，调用没有意义，不要再试。",
    "cooldown": "冷却中，本轮不要再调用，等下一轮。",
    "busy": "同类操作正占用着，不要重复调用，等它结束。",
    "guard-same-call": "不要再用同样的参数调用它，直接说话或给出结论。",
    "guard-repeat": "不要继续调用工具，直接用上下文回答。",
    "guard-step-cap": "不要再调用任何工具，直接用你现在掌握的上下文回答。",
    "guard-tool-fail": "这个工具已经连续失败，别再重试，换方法或直接回答。",
    "guard-search-cap": "不要再查询了，直接用现有信息回答。",
    "guard-turn-budget": "本轮工具预算已用完，直接回答。",
}

RETRY_OF: dict[str, str] = {
    "bad-args": "changed-args",
    "missing-target": "changed-args",
    "upstream-error": "later",
    "timeout": "later",
    "internal": "later",
    "cooldown": "later",
    "busy": "later",
}

NOSENT = ("不要", "别再用", "最终结果")

_CONTRACT_KEYS = {
    "state", "code", "why", "next", "retry", "data",
    "ok", "sent", "messageId", "traceId", "blocked", "final", "terminal",
    "done", "disabled", "failed", "landed", "queued", "discarded",
    "note", "text", "reply", "hint", "error", "duplicate", "unchanged", "written",
}


def _build(state: str, code: str, why: str = "", next_: str = "", extra: dict[str, Any] | None = None) -> dict[str, Any]:
    out: dict[str, Any] = dict(extra or {})
    fact = (why or "").strip()
    advice = (next_ or "").strip()
    out["state"] = state
    out["code"] = code
    out["why"] = fact or STATE_WHY[state]
    out["next"] = advice or CODE_NEXT.get(code, "")
    out["retry"] = RETRY_OF.get(code, "no")
    return out


def result_ok(why: str = "", code: str = "ok", next_: str = "", **extra: Any) -> dict[str, Any]:
    return _build("ok", code, why, next_, extra)


def result_done(code: str, why: str = "", next_: str = "", **extra: Any) -> dict[str, Any]:
    return _build("done", code, why, next_, extra)


def result_fail(code: str, why: str = "", next_: str = "", **extra: Any) -> dict[str, Any]:
    return _build("failed", code, why, next_, extra)


def result_blocked(code: str, why: str = "", next_: str = "", **extra: Any) -> dict[str, Any]:
    return _build("blocked", code, why, next_, extra)


def _sentence(text: str) -> str:
    return text if re.search(r"[。！？!?]$", text) else text + "。"


def _advice(result: dict[str, Any]) -> str:
    why = result.get("why") or ""
    if re.search(r"不要|别再用|最终结果", why):
        return ""
    return result.get("next") or ""


def render(value: Any) -> str:
    """唯一渲染实现：四态前缀 + why + next +（ok 且非发送类的）业务 JSON。"""
    result = normalize(value)
    lines: list[str] = []
    state = result["state"]
    if state == "ok":
        msg_id = result.get("messageId")
        if result.get("code") == "sent" and msg_id is not None and str(msg_id).strip() != "":
            lines.append(f"已发送（message_id={msg_id}）")
        else:
            why = result.get("why") or ""
            lines.append("已完成" if why == STATE_WHY["ok"] else f"已完成：{why}")
            if result.get("next"):
                lines.append(_sentence(result["next"]))
        if result.get("code") not in ("sent", "forwarded") and result.get("data") is not None:
            lines.append(json.dumps(result["data"], ensure_ascii=False, indent=2))
    elif state == "done":
        prefix = {
            "no-result": "没查到",
            "already-done": "已经做过",
            "limit-reached": "到上限了",
        }.get(result.get("code", ""), "不用再做")
        why = result.get("why") or ""
        lines.append(prefix if why == STATE_WHY["done"] else f"{prefix}：{why}")
        advice = _advice(result)
        if advice:
            lines.append(_sentence(advice))
    elif state == "failed":
        why = result.get("why") or ""
        lines.append("没有成功" if why == STATE_WHY["failed"] else f"没有成功：{why}")
        advice = _advice(result)
        if advice:
            lines.append(_sentence(advice))
    else:
        why = result.get("why") or ""
        lines.append("没有执行" if why == STATE_WHY["blocked"] else f"没有执行：{why}")
        advice = _advice(result)
        if advice:
            lines.append(_sentence(advice))
    return "\n".join(lines)


def as_text(value: Any) -> str:
    """handler 返回给模型的字符串：四态渲染结果（不返回 None）。"""
    return render(value)


def normalize(value: Any, tool_name: str = "") -> dict[str, Any]:
    """把任意返回值归一成契约对象；None / 静默成功按 failed 处理。"""
    if isinstance(value, dict) and value.get("state") in RESULT_STATES:
        return _build(
            value["state"],
            str(value.get("code") or "ok"),
            str(value.get("why") or ""),
            str(value.get("next") or ""),
            value,
        )
    if isinstance(value, list):
        return result_ok(f"共 {len(value)} 项", data=value)
    if value is None:
        return result_fail(
            "internal",
            "工具没有返回任何结果（静默成功按失败处理）",
            "不要用同样参数重试，改用别的做法或直接回答。",
            final=True,
        )
    if not isinstance(value, dict):
        return result_ok("", data=value)
    if value.get("blocked") is True:
        text = str(value.get("text") or value.get("why") or value.get("note") or "")
        if value.get("disabled") is True:
            return result_blocked("disabled", text, CODE_NEXT["disabled"], final=True)
        return result_fail(_infer_fail_code(text), text, "", final=True)
    if value.get("sent") is True or value.get("landed") is True:
        msg_id = value.get("messageId")
        if msg_id is not None and str(msg_id).strip() != "":
            return result_ok("", code="sent", messageId=msg_id, traceId=value.get("traceId"))
        if value.get("landed") is True:
            why = str(value.get("why") or f"已提交 {int(value.get('forwarded') or 0)} 条（接口不返回消息号）")
            return result_ok(why, code="forwarded", landed=True, traceId=value.get("traceId"))
        return result_fail(
            "unlanded",
            str(value.get("why") or "发送接口没有返回 message_id，这次没有真正发出去"),
            str(value.get("next") or ""),
            final=True,
            traceId=value.get("traceId"),
        )
    if value.get("ok") is False or value.get("failed") is True:
        why = str(value.get("error") or value.get("reply") or value.get("text") or value.get("note") or value.get("why") or "")
        code = str(value.get("code") or "")
        if code in ("", "ok"):
            code = "policy-rejected" if value.get("discarded") is True else _infer_fail_code(why)
        return result_fail(code, why, str(value.get("note") or value.get("next") or ""), final=True)
    if value.get("duplicate") is True:
        return result_done(
            "already-done",
            str(value.get("why") or f"同样的内容已经记过了（当前共 {value.get('count', '?')} 条），没有重复写入"),
            CODE_NEXT["already-done"],
            data=_payload(value),
        )
    if value.get("unchanged") is True:
        return result_done(
            "already-done",
            str(value.get("why") or "目标状态本来就是这样，没有重复操作"),
            CODE_NEXT["already-done"],
            data=_payload(value),
        )
    if value.get("done") is True:
        return result_done("already-done", str(value.get("why") or "这一步已经完成了"), "")
    why = str(value.get("text") or value.get("why") or "").strip()
    skip = {"text"} if why else set()
    data = _payload(value, skip)
    result = result_ok(why, code=str(value.get("code") or "ok"), next_=str(value.get("hint") or value.get("next") or ""))
    if data is not None:
        result["data"] = data
    if value.get("messageId") is not None:
        result["messageId"] = value["messageId"]
    if value.get("traceId") is not None:
        result["traceId"] = value["traceId"]
    return result


def _payload(value: dict[str, Any], extra_skip: set[str] | None = None) -> dict[str, Any] | None:
    out = {
        key: item
        for key, item in value.items()
        if key not in _CONTRACT_KEYS and key not in (extra_skip or set()) and item is not None
    }
    return out or None


def _infer_fail_code(text: str) -> str:
    if re.search(r"message_id|没有发出去", text):
        return "unlanded"
    if re.search(r"没有合适|没有可用|无可用|no-eligible|no-material|没有素材|素材", text):
        return "no-material"
    if re.search(r"仅主人|只有主人|管理员|权限", text):
        return "forbidden"
    if re.search(r"停用|已关闭|disabled", text):
        return "disabled"
    if re.search(r"超时|timeout", text, re.I):
        return "timeout"
    return "upstream-error"


def fail_from_error(error: BaseException, tool_name: str = "") -> dict[str, Any]:
    """异常也归一成契约；分类规则与旧栈一致。"""
    why = str(error or "").strip()
    if tool_name and why.startswith(tool_name + ": "):
        why = why[len(tool_name) + 2 :].strip()
    if why == "":
        why = f"工具内部错误（{type(error).__name__}）"
    if type(error).__name__ == "FenceError":
        return result_blocked(
            "forbidden", why, "只允许使用白名单目录内的文件，不要重试越界路径。", final=True
        )
    if isinstance(error, PermissionError) and re.search(r"仅主人|只有主人", why):
        return result_blocked(
            "forbidden", why, "当前会话没有这个权限，再调也不会通过；需要的话让对方找主人。", final=True
        )
    if isinstance(error, (TypeError, ValueError)) and re.search(r"参数|必填|不能为空", why):
        return result_fail("bad-args", why, "", final=True)
    if re.search(r"冷却|熔断", why):
        return result_blocked("cooldown", why, CODE_NEXT["cooldown"])
    if re.search(r"幂等跳过|已经发过", why):
        return result_done("already-done", why, CODE_NEXT["already-done"])
    code = "internal"
    if re.search(r"无法确定目标|目标会话", why):
        code = "missing-target"
    elif re.search(
        r"必填|不能为空|需要 ?(?:id|text|query|names|action|ref|prompt|关键词|参数)|必须是|最多|至少|不在白名单|请传|请提供|不支持|仅支持|只支持",
        why,
    ):
        code = "bad-args"
    elif re.search(r"仅主人|只有主人|管理员", why):
        code = "forbidden"
    elif re.search(r"停用|已关闭", why):
        code = "disabled"
    elif re.search(r"超时|timeout", why, re.I):
        code = "timeout"
    elif re.search(r"连接|HTTP|网络|ffprobe|上游|ECONN|ETIMEDOUT|socket|spawn", why, re.I):
        code = "upstream-error"
    return result_fail(code, why, "", final=True)


def safe_call(fn, tool_name: str = ""):
    """装饰器：handler 永不抛异常、永不返回 None（原生会把异常改写成英文外发）。"""
    name = tool_name or getattr(fn, "__name__", "")

    async def wrapper(*args: Any, **kwargs: Any) -> str:
        try:
            value = await fn(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001 - 必须兜住全部异常
            value = fail_from_error(exc, name)
        return as_text(value)

    wrapper.__name__ = getattr(fn, "__name__", "tool_wrapper")
    wrapper.__doc__ = getattr(fn, "__doc__", None)
    return wrapper
