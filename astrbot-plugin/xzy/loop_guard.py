"""循环闸：`dsh-onebot-qq/lib/loop-guard.js` 的 Python 移植（spec §14.2 B）。

只拦工具执行，不改工具返回值契约，也不替代原生 `max_agent_step`。
四类触发与 `tool_result.CODE_NEXT` 里预留的 code 一一对应：

- `guard-step-cap`：单轮工具步数超过 `TURN_STEP_CAP`（默认 24，必须小于
  AstrBot 的 `max_agent_step`，现网 30）且距上次入站超过 10 步；
- `guard-same-call`：同名同参累计超过 3 次；
- `guard-search-cap`：查询类工具单轮超过 4 次；
- `guard-repeat`：已经查空过，还继续查；
- `guard-tool-fail`：同一工具连续失败 4 次。

状态键是 `umo|turn_id`：同群两人并发回合互不影响。turn_id 由 `on_message`
写到事件 extra（`xzy_turn_id`），工具执行时再读回来。
"""

from __future__ import annotations

import json
from typing import Any, Callable

try:
    from . import tool_result as tr
except ImportError:  # AstrBot 以扁平模块方式加载时走这里
    import tool_result as tr  # type: ignore

TURN_STEP_CAP = 24
IDLE_STEPS_BEFORE_TRIP = 10
SAME_CALL_TERMINAL_CAP = 3
QUERY_TURN_CAP = 4
TOOL_FAILURE_CAP = 4

QUERY_ACTIONS = ("search", "read", "query")


def configure(cfg: dict[str, Any] | None) -> None:
    """步数闸必须早于 AstrBot 原生 max_agent_step 触发，否则等于没设闸。

    现网 `max_agent_step=30`：守卫若按 40 判，永远等不到第 41 步。
    """
    global TURN_STEP_CAP
    section = (cfg or {}).get("loop_guard") if isinstance(cfg, dict) else None
    section = section if isinstance(section, dict) else {}
    raw = section.get("stepCap", TURN_STEP_CAP)
    try:
        TURN_STEP_CAP = max(4, int(raw))
    except (TypeError, ValueError):
        pass


def _sig(tool_name: str, args: dict[str, Any]) -> str:
    try:
        body = json.dumps(args, sort_keys=True, ensure_ascii=False, default=str)
    except Exception:  # noqa: BLE001 - 参数里有不可序列化对象时退化成 repr
        body = repr(sorted(args.items()))
    return f"{tool_name}:{body}"


def is_query_tool(tool_name: str, args: dict[str, Any]) -> bool:
    if tool_name.startswith("memory_"):
        return True
    if tool_name == "memory_search":
        return True
    if tool_name == "qq_notebook":
        return str(args.get("action") or "") in QUERY_ACTIONS
    return False


class LoopGuard:
    def __init__(self) -> None:
        self._states: dict[str, dict[str, Any]] = {}

    @staticmethod
    def _key(chat: str, turn_id: str) -> str:
        return f"{chat or 'unknown'}|{turn_id or 'default'}"

    def start_turn(self, chat: str, turn_id: str = "default") -> None:
        key = self._key(chat, turn_id)
        self._states[key] = {
            "steps": 0,
            "last_input_step": 0,
            "calls": {},
            "query_calls": 0,
            "query_empty": False,
            "failures": 0,
            "last_failed_tool": "",
            "cap_tripped": False,
        }
        # 防御性回收：turn 键只增不减，超过一定量就丢最旧的
        if len(self._states) > 256:
            for stale in list(self._states)[:128]:
                self._states.pop(stale, None)

    def _state(self, chat: str, turn_id: str) -> dict[str, Any]:
        key = self._key(chat, turn_id)
        state = self._states.get(key)
        if state is None:
            self.start_turn(chat, turn_id)
            state = self._states[key]
        return state

    def cap_tripped(self, chat: str, turn_id: str) -> bool:
        """该回合是否撞过工具步数上限（撞过 = 最终正文可能是对系统通知的回答）。"""
        return bool(self._state(chat, turn_id).get("cap_tripped"))

    def before_tool(
        self, chat: str, turn_id: str, tool_name: str, args: dict[str, Any]
    ) -> tuple[str, str] | None:
        """返回 (code, why) 表示拦截；None 表示放行。"""
        state = self._state(chat, turn_id)
        state["steps"] += 1

        if (
            state["steps"] > TURN_STEP_CAP
            and state["steps"] - state["last_input_step"] > IDLE_STEPS_BEFORE_TRIP
        ):
            # 该回合已不可收拾：AstrBot 到 max_agent_step 会以 user 角色注入
            # 「工具调用次数已达到上限…」并强制收尾。2026-11-17 事故里模型把这条
            # 系统通知当成人话回复（「行，工具用完了…」）发给了主人。标记后由
            # main 在出站时拦掉这类「机制自述」正文。
            state["cap_tripped"] = True
            return (
                "guard-step-cap",
                f"本轮已调用 {state['steps']} 次工具，超过上限 {TURN_STEP_CAP}；"
                "不要再用工具，直接回答用户的问题。不要在回复里提工具、调用次数或系统提示。",
            )

        sig = _sig(tool_name, args)
        total = int(state["calls"].get(sig) or 0) + 1
        state["calls"][sig] = total
        if total > SAME_CALL_TERMINAL_CAP:
            return (
                "guard-same-call",
                f"{tool_name} 用相同参数已经调了 {total - 1} 次；"
                "不要再用同样参数重试，直接给结论。",
            )

        if is_query_tool(tool_name, args):
            state["query_calls"] += 1
            if state["query_empty"]:
                return (
                    "guard-repeat",
                    "这次查询已经查空过；不要继续查，直接用现有信息回答。",
                )
            if state["query_calls"] > QUERY_TURN_CAP:
                return (
                    "guard-search-cap",
                    f"本轮查询已做 {state['query_calls'] - 1} 次，超过上限 "
                    f"{QUERY_TURN_CAP}；不要再查，直接回答。",
                )

        if state["failures"] >= TOOL_FAILURE_CAP and state["last_failed_tool"] == tool_name:
            return (
                "guard-tool-fail",
                f"{tool_name} 已连续失败 {state['failures']} 次；别再重试，换方法或直接回答。",
            )
        return None

    def note_result(
        self,
        chat: str,
        turn_id: str,
        tool_name: str,
        state: str,
        code: str,
        args: dict[str, Any],
    ) -> None:
        st = self._state(chat, turn_id)
        if state in ("ok", "done"):
            st["failures"] = 0
            st["last_failed_tool"] = ""
        elif state in ("failed", "blocked"):
            if st["last_failed_tool"] == tool_name:
                st["failures"] += 1
            else:
                st["last_failed_tool"] = tool_name
                st["failures"] = 1
        if state == "done" and code == "no-result" and is_query_tool(tool_name, args):
            st["query_empty"] = True


GUARD = LoopGuard()


def _turn_id(event: Any) -> str:
    getter = getattr(event, "get_extra", None)
    if callable(getter):
        try:
            return str(getter("xzy_turn_id", "") or "default")
        except Exception:  # noqa: BLE001
            return "default"
    return "default"


def wrap_handler(handler: Callable[..., Any], tool_name: str) -> Callable[..., Any]:
    """包在 handler 外层、safe_call 内层：拦截时返回四态 blocked 契约。"""

    async def wrapper(*args: Any, **kwargs: Any) -> Any:
        event = args[0] if args else kwargs.get("event")
        chat = str(getattr(event, "unified_msg_origin", "") or "")
        turn_id = _turn_id(event)
        call_args = {k: v for k, v in kwargs.items() if k != "event"}
        blocked = GUARD.before_tool(chat, turn_id, tool_name, call_args)
        if blocked:
            code, why = blocked
            return tr.result_blocked(code, why)
        value = await handler(*args, **kwargs)
        normalized = tr.normalize(value)
        GUARD.note_result(
            chat,
            turn_id,
            tool_name,
            str(normalized.get("state") or ""),
            str(normalized.get("code") or ""),
            call_args,
        )
        return value

    wrapper.__name__ = getattr(handler, "__name__", tool_name)
    wrapper.__doc__ = getattr(handler, "__doc__", None)
    return wrapper
