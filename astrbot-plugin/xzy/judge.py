"""判定器（模型层）：`Y:\\dsh\\home\\qq-persona\\judge.mjs` 的 Python 移植。

只负责「规则没拦住之后，问一次模型该不该接」：
- 队列熔断：`{proxyBase}/internal/queue` 的 waiting >= queueLimit 时本轮不发请求；
- POST `{proxyBase}/decide`，system prompt 与 user 上下文原样照搬；
- 失败一律沉默（fail-closed），绝不因为判定器挂了就开始乱说话。

确定性规则（免打扰/访问/@/点名/引用/主人 cue/数字接龙/概率/频次/冷却）全部在
`policy.py`，本模块不再重复一份，避免两边规则漂移。
合并窗口由 `main.py` 的 judge 窗口负责（现网 `judge.mergeWindowMs`）。
"""

from __future__ import annotations

import json
import os
import re
from typing import Any

import aiohttp
from astrbot.api import logger

try:
    from . import continuation
except ImportError:  # AstrBot 以模块方式加载时走这里
    import continuation  # type: ignore

JUDGE_SYSTEM = (
    "你是群聊里的接话判定器。先判断最新一条是不是在跟机器人说，再判断现在该不该接。\n"
    "必须输出两段互相独立的结果：\n"
    "- addressedToBot：这条消息是不是在跟机器人说（@ 它、引用它、拍它、点名它、等它回答）；\n"
    "- shouldReply：此刻该不该由机器人开口。\n"
    "以下情形 addressedToBot 与 shouldReply 都必须是 false，保持沉默：\n"
    "- 别人问别人，且没有 @ 机器人、没有引用机器人；\n"
    "- 两个人在互相问答，机器人只是旁观；\n"
    "- @ 了别人（不是机器人）；\n"
    "- 明显在等技术/事实答案，而说话对象不是机器人；\n"
    "- 只是陈述、吐槽或自言自语，没有要任何人回答。\n"
    "第二人称绑定：「你/您」只有在 addressedToBot 为 true 时才指机器人。消息若在回复别人、@ 别人、或接着别人的话说，句中的「你/您」属于别人的对话，不许当成在叫机器人。\n"
    "单独问号：一条消息如果只有「？」「?」「？？」这类无内容符号，只有它紧跟在机器人自己刚发的那条回复之后，或明确回复/引用机器人那条，才算 addressedToBot=true；中间隔了别人的消息、或别人之间互发的问号，一律 false。\n"
    "结构化字段：上下文里「【结构化字段】」段由插件直接读出（机器人最后一句原文、距现在多少毫秒、是否问句、这条有没有 @/引用别人），这些一律直接采信，不要自己从对话里重新推断，也不要用与字段相反的说法。\n"
    "接话延续（优先级最高）：只要最新这条是在回答/续写机器人最后一句（哪怕没 @、没点名、只有「在干嘛」这种短句），addressedToBot 与 shouldReply 都必须为 true；上面所有沉默条目都不适用于这种情况。最新这条与机器人上一句无关时，仍按上面的规则判。\n"
    "直接追问（优先于「过旧不回」）：最新这条若在直接质问/追问机器人——「你怎么不回」「为什么不理我」「在吗」「人呢」「回我一句」，或是对机器人上一句的直接反驳——即使没有 @、没有引用、距离上一句超过窗口，addressedToBot 与 shouldReply 都必须为 true。反过来，两个人聊得正热、只是句中出现「你/您」的，仍按下面的沉默条目判。\n"
    "过旧不回：话头已经被别人接完，或这条消息明显过期（当前已经没人等它回答），shouldReply 必须为 false；宁可不说。上面「接话延续」「直接追问」两类不适用本条。\n"
    "状态不作为沉默理由：机器人自己的心情/耐心只影响它回复的语气和长短，绝不能因为“不耐烦/没耐心”把 shouldReply 判成 false；"
    "是否回复只看有没有被叫到、或能不能补一句对方需要的关键信息。\n"
    "只有被点名、被 @、被引用、被拍，或确实能补一句对方需要的关键信息时 shouldReply 才能为 true。\n"
    "只输出 JSON：{\"addressedToBot\":true,\"shouldReply\":true,\"reason\":\"一句中文理由\"}，"
    "把两个布尔值换成你判断的真实结果；理由不超过 60 字，不要解释规则，不要输出其它内容。"
)

RULES = {
    "SPEAK": "judge:speak",
    "SILENT": "judge:silent",
    "ERROR": "judge:error",
    "SKIP_QUEUE": "judge:skip:queue",
    "NOT_ADDRESSED": "judge:not-addressed",
    "MERGED": "judge:merged",
    "MASTER_CUE": "master:cue",
}


def shorten(value: Any, max_chars: int) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text if len(text) <= max_chars else text[:max_chars] + "…"


class DecideBadJSON(RuntimeError):
    """模型返回解析不出约定结构：带上原始返回前缀，便于判断是空串、围栏还是被截断。"""

    def __init__(self, raw: Any) -> None:
        self.raw = str(raw or "")
        super().__init__(f"decide bad json raw={shorten(self.raw[:200], 160)!r}")


def extract_json(text: Any) -> dict[str, Any] | None:
    """能解析就解析：先整体、再去 ```json 围栏、最后取首尾花括号之间的片段。"""
    raw = str(text or "").strip()
    if not raw:
        return None
    candidates = [raw]
    fence = re.search(r"```(?:json)?\s*(.*?)```", raw, re.S)
    if fence:
        candidates.append(fence.group(1).strip())
    start, end = raw.find("{"), raw.rfind("}")
    if 0 <= start < end:
        candidates.append(raw[start : end + 1])
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except Exception:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def build_context(
    entries: list[dict[str, Any]],
    relation: str = "",
    history_lines: list[str] | None = None,
    memory_block: str = "",
    fields: dict[str, Any] | None = None,
) -> str:
    lines: list[str] = []
    if history_lines:
        lines.append("本会话最近对话（含你自己说过的话；判断对方是不是在接你的话）：")
        lines.extend("- " + line for line in history_lines)
        bot_lines = [line for line in history_lines if line.startswith("机器人：")]
        if bot_lines:
            lines.append(
                f"注意：机器人最后一句是「{bot_lines[-1][4:]}」，先判断最新这条是否在接这句。"
            )
        lines.append("")
    if fields:
        block = continuation.format_block(fields)
        if block:
            lines.append(block)
            lines.append("")
    if memory_block:
        lines.append(memory_block)
        lines.append("")
    lines.append("群里最近的消息（从旧到新）：")
    for entry in entries[-8:]:
        name = entry.get("nick") or entry.get("user_id") or "群友"
        lines.append("- " + name + "：" + shorten(entry.get("text"), 180))
    last = entries[-1]
    mentioned = last.get("mentioned") is True
    quoted_me = last.get("quoted_me") is True
    at_other = last.get("at_other") is True
    quoted_other = last.get("quoted_other") is True
    addressed_elsewhere = last.get("addressed_elsewhere") is True
    asking = "机器人" if mentioned or quoted_me else ("别人" if (at_other or quoted_other or addressed_elsewhere) else "不清楚")
    lines.append("")
    lines.append("最新一条由 " + (last.get("nick") or last.get("user_id") or "群友") + " 发出")
    lines.append("是否 @ 了机器人：" + ("是" if mentioned else "否"))
    lines.append("是否 @ 了别人：" + ("是" if at_other else "否"))
    lines.append("是否引用机器人：" + ("是" if quoted_me else "否"))
    lines.append("是否引用别人：" + ("是" if quoted_other else "否"))
    lines.append("是否在回复别人：" + ("是" if addressed_elsewhere else "否"))
    lines.append("这句话在问/等谁回答：" + asking)
    if relation:
        lines.append("与说话人关系倾向：" + relation)
    lines.append("先判断 addressedToBot，再判断 shouldReply。只输出 JSON。")
    return "\n".join(lines)


def _verdict(
    speak: bool,
    rule: str,
    reason: str,
    gate: str,
    addressed_to_bot: bool = False,
    should_reply: bool = False,
) -> dict[str, Any]:
    return {
        "speak": speak,
        "addressed_to_bot": addressed_to_bot,
        "should_reply": should_reply,
        "reason": reason,
        "rule": rule,
        "gate": gate,
    }


def _judge_cfg(cfg: dict[str, Any]) -> dict[str, Any]:
    judge = cfg.get("judge")
    return judge if isinstance(judge, dict) else {}


async def queue_waiting(base: str, timeout_s: float) -> int:
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=min(timeout_s, 1.5))) as session:
            async with session.get(base.rstrip("/") + "/internal/queue") as resp:
                if resp.status != 200:
                    return 0
                body = await resp.json(content_type=None)
                return int((body or {}).get("waiting") or 0)
    except Exception:
        # 探测失败按空闲处理：真的不行，后面的 /decide 会失败并沉默。
        return 0


def _decision_from_content(content: Any) -> dict[str, Any]:
    parsed = extract_json(content)
    if (
        parsed is None
        or not isinstance(parsed.get("addressedToBot"), bool)
        or not isinstance(parsed.get("shouldReply"), bool)
    ):
        raise DecideBadJSON(content)
    return {
        "addressed_to_bot": parsed["addressedToBot"],
        "should_reply": parsed["shouldReply"],
        "reason": shorten(parsed.get("reason", ""), 80),
    }


async def chat_direct(
    system: str,
    user: str,
    *,
    max_tokens: int = 800,
    timeout_s: float = 60.0,
    temperature: float = 0.2,
) -> str:
    """直连本机引擎（8094 的 OpenAI 兼容口）。

    旧栈 proxy（1240）只是壳，模型本身就在引擎里；proxy 不在时判定不该跟着一起死，
    自迭代的反思也复用这条路。
    """
    base = str(os.environ.get("QQ_LLM_BASE") or "http://127.0.0.1:8094/v1").rstrip("/")
    payload = {
        "model": str(os.environ.get("QQ_LLM_MODEL") or "bonsai-2-27b"),
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": False,
    }
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout_s)) as session:
        async with session.post(base + "/chat/completions", json=payload) as resp:
            raw = await resp.text()
            if resp.status >= 400:
                raise RuntimeError(f"engine status {resp.status}")
    try:
        body = json.loads(raw)
        content = (((body or {}).get("choices") or [{}])[0].get("message") or {}).get("content")
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise RuntimeError("engine 返回格式异常") from exc
    if not isinstance(content, str) or not content.strip():
        raise DecideBadJSON(content)
    return content


async def _decide_by_model(
    entries: list[dict[str, Any]],
    cfg: dict[str, Any],
    history_lines: list[str] | None = None,
    memory_block: str = "",
    fields: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    judge = _judge_cfg(cfg)
    base = str(judge.get("proxyBase") or "http://127.0.0.1:1240").rstrip("/")
    timeout_s = max(0.5, float(judge.get("timeoutMs") or 3000) / 1000.0)
    payload = {
        "max_tokens": 200,
        "messages": [
            {"role": "system", "content": JUDGE_SYSTEM},
            {
                "role": "user",
                "content": build_context(
                    entries, history_lines=history_lines, memory_block=memory_block, fields=fields
                ),
            },
        ],
    }
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout_s)) as session:
        async with session.post(base + "/decide", json=payload) as resp:
            if resp.status != 200:
                raise RuntimeError(f"decide status {resp.status}")
            body = await resp.json(content_type=None)
    content = (((body or {}).get("choices") or [{}])[0].get("message") or {}).get("content")
    return _decision_from_content(content)


async def _decide_direct(
    entries: list[dict[str, Any]],
    cfg: dict[str, Any],
    history_lines: list[str] | None = None,
    memory_block: str = "",
    fields: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """proxy 不通时的后备：同样的 system/上下文，直接问引擎。"""
    judge = _judge_cfg(cfg)
    timeout_s = max(3.0, float(judge.get("directTimeoutMs") or 8000) / 1000.0)
    content = await chat_direct(
        JUDGE_SYSTEM,
        build_context(
            entries, history_lines=history_lines, memory_block=memory_block, fields=fields
        ),
        max_tokens=200,
        timeout_s=timeout_s,
    )
    return _decision_from_content(content)


async def judge_model(
    entries: list[dict[str, Any]],
    cfg: dict[str, Any],
    history_lines: list[str] | None = None,
    memory_block: str = "",
    fields: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """白名单群、且规则层没有触发（no:*）的批次，才走模型判定。"""
    judge = _judge_cfg(cfg)
    base = str(judge.get("proxyBase") or "http://127.0.0.1:1240").rstrip("/")
    timeout_s = max(0.5, float(judge.get("timeoutMs") or 3000) / 1000.0)
    waiting = await queue_waiting(base, timeout_s)
    limit = int(judge.get("queueLimit") or 3)
    if waiting >= limit:
        return _verdict(False, RULES["SKIP_QUEUE"], "proxy 队列积压，本轮不新增请求", "queue")

    decision = None
    gate = "model"
    for attempt in (1, 2):
        try:
            decision = await _decide_by_model(entries, cfg, history_lines, memory_block, fields)
            break
        except DecideBadJSON as exc:
            logger.warning(f"[xzy] 接话判定解析失败（第 {attempt}/2 次）: {exc}")
        except Exception as exc:  # noqa: BLE001
            # 旧栈 proxy 只是壳：它挂了不等于模型挂了，改直连引擎再判一次。
            logger.warning(
                f"[xzy] 旧栈 proxy 判定不通（{type(exc).__name__}: {exc}），改直连引擎"
            )
            try:
                decision = await _decide_direct(entries, cfg, history_lines, memory_block, fields)
                gate = "model-direct"
                logger.info("[xzy] 接话判定已由直连引擎完成（proxy 不可用）")
            except DecideBadJSON as exc2:
                logger.warning(f"[xzy] 直连引擎判定解析失败: {exc2}")
            except Exception as exc2:  # noqa: BLE001
                logger.warning(
                    f"[xzy] 直连引擎判定失败，保持沉默: {type(exc2).__name__}: {exc2}"
                )
            break
    if decision is None:
        logger.warning("[xzy] 接话判定失败，保持沉默")
        return _verdict(False, RULES["ERROR"], "判定失败，保持沉默", "error")

    speak = decision["should_reply"] is True and decision["addressed_to_bot"] is True
    return _verdict(
        speak,
        RULES["SPEAK"] if speak else RULES["SILENT"],
        decision["reason"],
        gate,
        decision["addressed_to_bot"],
        decision["should_reply"],
    )
