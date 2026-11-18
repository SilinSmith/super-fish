"""第三批工具（媒体与出站补齐）：qq_send_sticker。

旧栈 `dsh-onebot-qq/lib/tools.js` 的 qq_send_sticker 有三层：
1. 总开关 `qq-persona/stickers.json` 的 enabled（关闭时工具整条不注册）；
2. 选图 `sticker-lib.pickSticker`：按最近对话打分、情绪门槛、10 分钟全局冷却、
   同会话最近 3 张排除、黑名单；一次回复最多一张（turnId 去重）；
3. 发送成功后 `noteStickerSelected` 记账，并写 `sticker-work/send-trace.jsonl`。

本模块只做 Python 侧编排，选图逻辑统一走 `sticker_bridge.mjs` →
`sticker-lib.mjs`，不复制第二套打分规则。发送一律走共享 `tool_send.py`
（直连 OneBot，能取到 message_id）。

与旧栈的已知差异（单独汇报，不混入"已实现"）：
- `mediaRoots` 目录围栏未移植（与 tools_batch1/2 同口径：只校验存在与大小）。
- 最近对话取自 xzy 审计 `audit/inbound.jsonl`（只含入站用户消息，天然排除 bot
  自己的回复），不是旧栈内存里的 `chat.recentLog`；条数同为最近 8 条。
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any

try:
    from . import tool_context
    from . import tool_result as tr
    from . import tool_send
except ImportError:  # AstrBot 以扁平模块方式加载时走这里
    import tool_context  # type: ignore
    import tool_result as tr  # type: ignore
    import tool_send  # type: ignore

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_ROOT = os.path.abspath(os.path.join(PLUGIN_DIR, "..", "..", "xzy"))

DEFAULT_STICKERS_CONFIG = r"E:\Bonsai\astrbot-eval\inst\data\xzy\persona\stickers.json"
DEFAULT_STICKER_LIB = r"E:\Bonsai\astrbot-eval\inst\data\xzy\persona\sticker-lib.mjs"
DEFAULT_STICKER_ROOT = r"C:\Users\user\.dsh\media\onebot\stickers"
DEFAULT_STICKER_BACKUP = r"E:\Bonsai\astrbot-eval\inst\data\xzy\persona\sticker-backup"
DEFAULT_TRACE = r"E:\Bonsai\astrbot-eval\inst\data\xzy\persona\sticker-work\send-trace.jsonl"

CONTEXT_LIMIT = 8
# 只读入站审计的尾部；inbound.jsonl 会一直增长，不能整文件读。
INBOUND_TAIL_BYTES = 256 * 1024

STICKER_DISABLED_TEXT = (
    "贴纸功能已整体停用（stickers.enabled=false），一张都不会发。这是最终结果："
    "不要重试、不要换 emotion，也不要用文字假装发过表情包；有话就用文字说。"
)

CFG: dict[str, Any] = {}


def configure(cfg: dict[str, Any]) -> None:
    CFG.clear()
    CFG.update(cfg)


def _log(level: str, message: str) -> None:
    try:
        from astrbot.api import logger
    except ImportError:  # pragma: no cover
        return
    method = {"warn": "warning", "error": "error"}.get(level, "info")
    getattr(logger, method, logger.info)(f"[xzy] {message}")


def _opt(name: str, default: str = "") -> str:
    """贴纸路径允许 config 覆盖：sticker.<name> / sticker_<name> / 环境变量。"""
    group = CFG.get("sticker") if isinstance(CFG.get("sticker"), dict) else {}
    if name in group and str(group[name] or "").strip():
        return str(group[name]).strip()
    flat = "sticker_" + name
    if str(CFG.get(flat) or "").strip():
        return str(CFG[flat]).strip()
    env = os.environ.get("QQ_STICKER_" + name.upper(), "")
    if str(env).strip():
        return str(env).strip()
    return default


def _stickers_enabled() -> bool:
    path = _opt("config", DEFAULT_STICKERS_CONFIG)
    try:
        with open(path, encoding="utf-8-sig") as f:
            data = json.load(f)
    except Exception:  # noqa: BLE001 - 配置缺失/损坏都按停用处理（与旧栈一致）
        return False
    return isinstance(data, dict) and data.get("enabled") is True


def _audit_dir() -> str:
    path = str(CFG.get("audit_dir") or "").strip()
    return path or os.path.join(STATE_ROOT, "audit")


def _append_audit(filename: str, record: dict[str, Any]) -> None:
    """真实调用回执：与 main.py 的 audit/*.jsonl 同目录同格式，失败不影响业务。"""
    try:
        os.makedirs(_audit_dir(), exist_ok=True)
        row = {"wall": time.strftime("%Y-%m-%dT%H:%M:%S%z"), **record}
        with open(os.path.join(_audit_dir(), filename), "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            f.flush()
    except Exception:  # noqa: BLE001
        pass


def _append_trace(record: dict[str, Any]) -> None:
    """旧栈 sticker-work/send-trace.jsonl：选图结果 + 记账结果，供复盘。"""
    try:
        path = _opt("trace", DEFAULT_TRACE)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        row = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), **record}
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            f.flush()
    except Exception:  # noqa: BLE001
        pass


def _recent_user_texts(chat: tuple[str, str], limit: int = CONTEXT_LIMIT) -> str:
    """同一会话最近 N 条入站用户发言（只读审计尾部，不含 bot 自己的回复）。"""
    path = os.path.join(_audit_dir(), "inbound.jsonl")
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - INBOUND_TAIL_BYTES))
            raw = f.read()
    except OSError:
        return ""
    kind, cid = chat
    texts: list[str] = []
    for line in raw.decode("utf-8", "ignore").splitlines()[-400:]:
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue  # 尾部截断的半行
        group_id = str(record.get("group_id") or "")
        if kind == "group":
            if group_id != cid:
                continue
        elif group_id or str(record.get("sender") or "") != cid:
            continue
        text = str(record.get("text") or "").strip()
        if text:
            texts.append(text)
    return "\n".join(texts[-limit:])


async def _node_call(payload: dict[str, Any], timeout_s: float = 20.0) -> dict[str, Any]:
    helper = os.path.join(PLUGIN_DIR, "sticker_bridge.mjs")
    node = _opt("node", "node")
    env = dict(os.environ)
    env["QQ_STICKER_LIB"] = _opt("lib", DEFAULT_STICKER_LIB)
    root = _opt("root", "")
    if root:
        env["QQ_STICKER_ROOT"] = root
    work = _opt("work", "")
    if work:
        env["QQ_STICKER_WORK"] = work
    backup = _opt("backup", DEFAULT_STICKER_BACKUP)
    if backup:
        env["QQ_STICKER_BACKUP"] = backup
    proc = await asyncio.create_subprocess_exec(
        node,
        helper,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    try:
        out, err = await asyncio.wait_for(proc.communicate(data), timeout=timeout_s)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise TimeoutError("表情包选图服务超时")
    if proc.returncode != 0:
        detail = err.decode("utf-8", "ignore").strip()[:200]
        raise RuntimeError(f"表情包选图服务退出码 {proc.returncode}：{detail}")
    lines = [line for line in out.decode("utf-8", "ignore").splitlines() if line.strip()]
    if not lines:
        raise RuntimeError("表情包选图服务没有返回结果")
    try:
        value = json.loads(lines[-1])
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"表情包选图服务返回格式异常：{exc}") from exc
    if not isinstance(value, dict):
        raise RuntimeError("表情包选图服务返回格式异常")
    return value


async def _note_selected(sticker_id: str, chat_key: str, turn_id: str) -> str:
    """记账失败不能影响发送结果：只返回错误摘要供 trace 使用。"""
    try:
        result = await _node_call(
            {
                "cmd": "note",
                "id": sticker_id,
                "chatId": chat_key,
                "turnId": turn_id,
                "now": int(time.time() * 1000),
            },
            timeout_s=10.0,
        )
        if result.get("ok") is not True:
            return str(result.get("error") or result.get("reason") or "note-failed")[:300]
        return ""
    except Exception as exc:  # noqa: BLE001
        return str(exc)[:300]


_MEANING_EVIDENCE = ("emotion", "scene", "text")


def _meaning_unverified_reason(chosen: dict[str, Any]) -> str:
    """空串=能保证理解；非空=拦截原因。判据与 sticker-lib.meaningVerified 对齐。

    Python 侧看不到 tagged/flags，只复核「发送前必须成立」的三项：
    来自对话的依据、非空描述、达标分数。
    """
    evidence = chosen.get("evidence") if isinstance(chosen.get("evidence"), list) else []
    if not {str(item) for item in evidence}.intersection(_MEANING_EVIDENCE):
        return "no-context-evidence"
    if not str(chosen.get("description") or "").strip():
        return "no-description"
    try:
        if float(chosen.get("score")) < 1.5:
            return "weak-score"
    except (TypeError, ValueError):
        return "weak-score"
    if str(chosen.get("emotion") or "").strip() in ("", "不确定", "其他"):
        return "no-emotion"
    return ""


def _record_meaning_block(
    chat_key: str, context_text: str, candidates: Any, reason: str
) -> None:
    """拦住也要记账：事后按 kind=guard-block 统计拦截率与误拦样本。"""
    rows: list[dict[str, Any]] = []
    if isinstance(candidates, list):
        for item in candidates[:8]:
            if not isinstance(item, dict):
                continue
            rows.append(
                {
                    "id": item.get("id"),
                    "score": item.get("score"),
                    "evidence": item.get("evidence"),
                    "description": str(item.get("description") or "")[:120],
                    "status": item.get("status"),
                }
            )
    _append_trace(
        {
            "event": "blocked",
            "reason": reason,
            "chatId": chat_key,
            "queryTextHead": str(context_text or "")[:80],
            "candidates": rows,
        }
    )
    _append_audit(
        "sticker.jsonl",
        {
            "kind": "guard-block",
            "tool": "qq_send_sticker",
            "chat": chat_key,
            "reason": reason,
            "candidates": rows,
        },
    )


async def qq_send_sticker(
    event: Any = None, emotion: str = "", chat_id: str = "", **_: Any
) -> dict[str, Any]:
    if not _stickers_enabled():
        return tr.result_blocked(
            "disabled",
            STICKER_DISABLED_TEXT,
            "表情包功能停用期间不要再调用这个工具，有话直接用文字说。",
        )
    if event is None:
        raise RuntimeError("缺少事件上下文")
    chat = tool_send.resolve_chat(event, chat_id)
    if chat is None:
        raise ValueError("chat_id 格式应为 group:<群号> 或 private:<QQ号>")
    chat_key = f"{chat[0]}:{chat[1]}"
    hint = str(emotion or "").strip()
    context_text = _recent_user_texts(chat)
    if not context_text.strip() and not hint:
        return tr.result_fail(
            "no-material",
            "没有可参考的对话内容，选不出表情包",
            "不要重试、不要换 emotion，也不要用文字假装发过；有话就用文字说。",
            final=True,
        )
    # 一轮一张：同一轮内最近一条入站消息不变，作为 turnId（旧栈用 exec.turn）。
    turn_id = tool_context.last_message_id(tool_context.key_of(chat))
    turn_key = f"msg:{turn_id}" if turn_id else ""

    try:
        picked = await _node_call(
            {
                "cmd": "pick",
                "text": context_text,
                "emotion": hint,
                "chatId": chat_key,
                "turnId": turn_key,
            }
        )
    except Exception as exc:  # noqa: BLE001
        # 原始异常只进日志，不把英文原文回给模型
        _log("warn", f"qq_send_sticker 选图失败: {exc}")
        return tr.result_fail(
            "upstream-error",
            "表情包选图服务这次没跑起来（选图进程启动失败或超时）",
            "不要立刻原样重试；稍后再试，或者有话先用文字说。",
        )

    if picked.get("ok") is not True:
        reason = str(picked.get("reason") or "no-eligible")
        if reason == "meaning-unverified":
            _record_meaning_block(chat_key, context_text, picked.get("candidates"), reason)
            return tr.result_fail(
                "meaning-unverified",
                "这张图我没把握它在这个语境里的意思，这次不发",
                "不要重试、不要换 emotion，也不要用文字假装发过；有话就用文字说。",
                final=True,
            )
        if reason == "already-sent-this-turn":
            return tr.result_done(
                "already-done",
                "这一轮已经发过一张表情包了，一次回复最多一张",
                "不要发表情包，也不要用文字假装发过；有话就用文字说。",
            )
        if reason in ("lib-unavailable", "lib-error", "bad-payload"):
            _log("warn", f"qq_send_sticker 选图服务异常: {reason} {picked.get('error') or ''}")
            return tr.result_fail(
                "upstream-error",
                "表情包选图服务这次没跑起来（服务异常）",
                "不要立刻原样重试；稍后再试，或者有话先用文字说。",
            )
        labels = {
            "no-eligible": "没有同时满足情绪和防重复的库存",
            "no-emotion": "没看出来该配什么情绪",
            "empty-query": "对话里没有可参考的内容",
            "all-filtered": "候选都被冷却或黑名单挡掉了",
            "no-record": "表情包库是空的",
        }
        return tr.result_fail(
            "no-material",
            f"库里没有能对上这段对话的表情包（{labels.get(reason, '库存不足或都被冷却挡掉了')}）",
            "不要重试、不要换 emotion，也不要用文字假装发过；有话就用文字说。",
            final=True,
        )

    chosen = picked.get("chosen") or {}
    sticker_id = str(chosen.get("id") or "")
    path = str(chosen.get("blobPath") or "")
    if not sticker_id or not path:
        raise RuntimeError("表情包选图结果缺少 id/blobPath")
    # 兜底闸：Node 侧已判过一次，这里在真正发图前再复核，防绕过/版本不一致。
    guard = _meaning_unverified_reason(chosen)
    if guard:
        _log("warn", f"qq_send_sticker 含义闸拦截 sticker={sticker_id} reason={guard}")
        _record_meaning_block(chat_key, context_text, [chosen], guard)
        return tr.result_fail(
            "meaning-unverified",
            "这张图我没把握它在这个语境里的意思，这次不发",
            "不要重试、不要换 emotion，也不要用文字假装发过；有话就用文字说。",
            final=True,
        )
    segment = tool_send.image_seg_from_file(path)
    message_id = await tool_send.send_segments(event, chat, [segment])
    evidence = chosen.get("evidence") if isinstance(chosen.get("evidence"), list) else []
    reason_text = (
        f"{chosen.get('reason') or ''}；依据=" + ("+".join(str(x) for x in evidence) if evidence else "无")
    )
    if message_id is None or str(message_id).strip() == "":
        _append_trace(
            {
                "event": "unlanded",
                "chatId": chat_key,
                "stickerId": sticker_id,
                "emotion": chosen.get("emotion"),
                "score": chosen.get("score"),
                "reason": "sendSegments 没有返回 message_id",
                "file": path,
            }
        )
        return tr.result_fail(
            "unlanded",
            f"发送接口没有返回 message_id（{sticker_id}），这次没有真正发出去",
            "不要重试、不要换 emotion，也不要用文字假装发过；有话就用文字说。",
            final=True,
        )

    accounting_error = await _note_selected(sticker_id, chat_key, turn_key)
    _append_trace(
        {
            "event": "sent",
            "chatId": chat_key,
            "stickerId": sticker_id,
            "emotion": chosen.get("emotion"),
            "score": chosen.get("score"),
            "evidence": evidence,
            "reason": reason_text,
            "file": path,
            "messageId": message_id,
            "accounting": "ok" if accounting_error == "" else "failed",
            **({"error": accounting_error} if accounting_error else {}),
        }
    )
    _append_audit(
        "sticker.jsonl",
        {
            "kind": "send",
            "tool": "qq_send_sticker",
            "chat": chat_key,
            "message_id": message_id,
            "sticker_id": sticker_id,
            "emotion": chosen.get("emotion"),
            "score": chosen.get("score"),
            "file": path,
        },
    )
    _log(
        "info",
        f"qq_send_sticker 已发送 chat={chat_key} message_id={message_id} "
        f"sticker={sticker_id} emotion={chosen.get('emotion')}",
    )
    return {
        "sent": True,
        "messageId": message_id,
        "sticker": {
            "id": sticker_id,
            "emotion": chosen.get("emotion"),
            "file": path,
            "reason": reason_text,
            "score": chosen.get("score"),
        },
    }


# --------------------------------------------------------------------------- #
# 声明（供插件注册入口合并；本模块不自带注册逻辑）
# --------------------------------------------------------------------------- #
TOOL_SPECS: list[dict[str, Any]] = [
    {
        "name": "qq_send_sticker",
        "description": (
            "按当前对话和情绪从表情包库选一张发出去。一次回复最多一张，发过就不要再发；"
            "没梗、纯信息、语气冷淡的场合本来就不该发。选图、冷却、按会话去重、黑名单都由系统处理："
            "没有合适的时候会直接拒绝（这是最终结果，不要重试），不要用文字假装发表情包。"
        ),
        "parameters": {
            "emotion": {
                "type": "string",
                "description": "可选的倾向提示，如 赞同/开心/吐槽/无语；不填就按最近对话推断",
            },
            "chat_id": {"type": "string", "description": "目标会话；省略时默认当前会话"},
        },
        "handler": qq_send_sticker,
    },
]
