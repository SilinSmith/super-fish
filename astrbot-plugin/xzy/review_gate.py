"""出站二审闸门（只判不改）——挂在 AstrBot 原生「发送消息前」钩子上。

唯一口径来自旧栈 ``dsh-onebot-qq/lib/review.js``（2026-11-14 现网版本）：

1. 审核后端暂时不可用：HTTP 503 且 body.reason == "busy"（出图租约 / 引擎排队）
   - reviewFailOpen=true（默认）：原文照发，**不改写、不丢弃**；
   - reviewFailOpen=false：drop，不发。
2. 真实失败：超时 / HTTP 错误 / 返回不是合法 JSON —— 一律静默 drop，不看 reviewFailOpen。
3. 机器硬问题（工具名、本地路径、图片占位符、密钥、虚构行为/结果）：任何情况都不放行。

本模块只决定「发」还是「不发」：allow 时原 result 一个字符都不动；drop 时清空本次结果。
``cleanupForSend`` 已整条删除（旧栈二次改写复读的根因），这里不引回，也不做任何代笔。

接线（``main.py`` 对其它 worker 只读，交给整合方合并）：
    # XzyPlugin.on_decorating_result 末尾（现有 outbound.jsonl 审计之后）加一行
    await review_gate.gate_event(event, self.cfg)

不需要新装饰器，也不需要新配置项：直接读 ``cfg["review"]``（enabled/url/model/
timeoutMs/maxAttempts/failOpen），默认 enabled=false 时只跑机器硬规则，与旧栈一致。
流式结果（STREAMING_RESULT / STREAMING_FINISH）不拦：内容已经流给用户，拦不住也不改写。
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

try:  # 插件包内导入
    from . import review as review_mod
except ImportError:  # AstrBot 以模块方式加载
    import review as review_mod  # type: ignore

try:
    from astrbot.api import logger as _logger
except ImportError:  # 单测 / venv 直调时允许没有 AstrBot
    _logger = None

AUDIT_FILE = "review.jsonl"

_SKIP_CONTENT_TYPES = {"STREAMING_RESULT", "STREAMING_FINISH"}


def _audit_path() -> str:
    """默认 <inst>/data/xzy/audit/review.jsonl；测试可用 XZY_AUDIT_DIR 改道。"""
    base = os.environ.get("XZY_AUDIT_DIR")
    if base:
        return os.path.join(base, AUDIT_FILE)
    # <inst>/data/plugins/xzy/review_gate.py -> <inst>/data
    data_root = os.path.abspath(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
    )
    return os.path.join(data_root, "xzy", "audit", AUDIT_FILE)


def _append_audit(record: dict[str, Any]) -> None:
    try:
        path = _audit_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
            f.flush()
    except Exception as exc:  # noqa: BLE001 - 审计失败不能影响发送判定
        _log("error", f"review audit 写入失败: {exc}")


def _log(level: str, message: str) -> None:
    line = f"[xzy-review] {message}"
    if _logger is not None:
        getattr(_logger, level, _logger.info)(line)
    else:  # pragma: no cover - 无 AstrBot 环境
        print(line)


def _plain_text(result: Any) -> str:
    try:
        text = result.get_plain_text()
    except Exception:  # noqa: BLE001
        text = ""
    if isinstance(text, str) and text.strip():
        return text
    parts = [
        str(getattr(comp, "text", "") or "")
        for comp in (getattr(result, "chain", None) or [])
        if comp.__class__.__name__ == "Plain"
    ]
    return " ".join(part for part in parts if part)


def _content_type_name(result: Any) -> str:
    ctype = getattr(result, "result_content_type", None)
    return str(getattr(ctype, "name", ctype) or "")


def _default_context(event: Any) -> str:
    """默认上下文：本轮入站原文（合批后）。旧栈传的是对话上下文，
    这里没有原生 req 句柄，先用于判断「答非所问 / 叫错对象」；调用方可覆盖。"""
    message = getattr(event, "message_str", "") or ""
    return message.strip()[:2000]


def _umo(event: Any) -> str:
    return str(getattr(event, "unified_msg_origin", "") or "")


async def gate_event(
    event: Any,
    cfg: dict[str, Any],
    *,
    mode: str = "final",
    allow_long: bool | None = None,
    context: str | None = None,
) -> dict[str, Any]:
    """判定本轮出站文本；allow 不动原文，drop 清空结果（不发送、不改写）。

    返回 review 的 verdict，额外带 ``dropped`` 与 ``text`` 便于审计/测试。
    """
    result = None
    try:
        result = event.get_result()
    except Exception as exc:  # noqa: BLE001
        _log("error", f"取 result 失败，按放行处理: {exc}")

    if result is None:
        return {
            "action": "allow",
            "source": "no-result",
            "reasons": [],
            "hard": False,
            "text": "",
            "dropped": False,
        }

    if _content_type_name(result) in _SKIP_CONTENT_TYPES:
        return {
            "action": "allow",
            "source": "streaming-skip",
            "reasons": [],
            "hard": False,
            "text": "",
            "dropped": False,
        }

    text = _plain_text(result)
    if not text.strip():
        # 纯图片/表情/空链：旧栈二审只审文本，这里同样不拦
        return {
            "action": "allow",
            "source": "no-text",
            "reasons": [],
            "hard": False,
            "text": text,
            "dropped": False,
        }

    ctx = _default_context(event) if context is None else context
    try:
        verdict = await review_mod.review_outbound_text(
            text,
            cfg or {},
            mode=mode,
            allow_long=allow_long,
            context=ctx,
            log=_log,
        )
    except Exception as exc:  # noqa: BLE001 - 闸门自身异常不应吞掉用户消息
        _log("error", f"review 判定异常，按放行处理: {exc}")
        _append_audit(
            {
                "ts": _wall(),
                "kind": "review-error",
                "umo": _umo(event),
                "chars": len(text),
                "error": f"{type(exc).__name__}: {exc}",
                "text_head": text[:200],
            }
        )
        return {
            "action": "allow",
            "source": "gate-error",
            "reasons": [],
            "hard": False,
            "text": text,
            "dropped": False,
        }

    dropped = verdict.get("action") == "drop"
    if dropped:
        # 只清空、不改写：respond 阶段拿不到 result 即跳过发送
        try:
            event.clear_result()
        except Exception as exc:  # noqa: BLE001
            _log("error", f"clear_result 失败: {exc}")

    try:
        event.set_extra("xzy_review", verdict)
    except Exception:  # noqa: BLE001
        pass

    _append_audit(
        {
            "ts": _wall(),
            "kind": "review",
            "umo": _umo(event),
            "mode": mode,
            "chars": len(text),
            "action": verdict.get("action"),
            "source": verdict.get("source"),
            "hard": bool(verdict.get("hard")),
            "reasons": verdict.get("reasons") or [],
            "dropped": dropped,
            "text_head": text[:200],
        }
    )
    _log(
        "info" if not dropped else "warn",
        f"outbound review action={verdict.get('action')} "
        f"source={verdict.get('source')} hard={bool(verdict.get('hard'))} "
        f"reasons={verdict.get('reasons')} umo={_umo(event)}",
    )
    return {**verdict, "dropped": dropped, "text": text}


def _wall() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")
