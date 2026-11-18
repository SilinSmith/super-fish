"""tool_calls 回合 content 标注（插件重载即生效，不必重启宿主）。

AstrBot 4.14.6 原生 `ToolLoopAgentRunner.step()` 在有工具调用的那一轮也会先
`yield llm_result`（content），而 `on_decorating_result` 无从判断它是不是最终
答复：中间回合不触发 `OnLLMResponseEvent`。于是这段 content 会被当最终正文发出，
并抢占该消息的最终幂等键（三次实伤见 spec §17.1）。

核心文件已加 `[XZY-P07]` 补丁，但改 venv 里的源码要等进程重启才会重新 import；
这里在插件加载时给 runner 包一层，重载插件即生效：
- 记住最近一次完整 `LLMResponse`；
- 在 `yield` 每个 `llm_result` 之前，把它的 `tools_call_name` 写成
  `event.extra["xzy_tool_round"]`（每步覆盖，与本次 set_result 一一对应）。

重复加载（插件热重载）不会叠加包装：已包装过就直接跳过。
"""

from __future__ import annotations

_MARK = "__xzy_p07__"


def install() -> bool:
    """挂载标注；已挂载或核心结构不符时返回 False。"""
    try:
        from astrbot.core.agent.runners.tool_loop_agent_runner import (
            ToolLoopAgentRunner,
        )
    except Exception:
        return False

    if getattr(ToolLoopAgentRunner.step, _MARK, False):
        return False
    if not hasattr(ToolLoopAgentRunner, "_iter_llm_responses"):
        return False

    orig_iter = ToolLoopAgentRunner._iter_llm_responses
    orig_step = ToolLoopAgentRunner.step

    def _iter_llm_responses(self):
        async def _gen():
            async for resp in orig_iter(self):
                if not getattr(resp, "is_chunk", False):
                    # 完整响应：step() 内部接下来就会用它决定有没有工具调用
                    self._xzy_last_llm_resp = resp
                yield resp

        return _gen()

    async def step(self):
        async for resp in orig_step(self):
            if resp.type == "llm_result":
                last = getattr(self, "_xzy_last_llm_resp", None)
                try:
                    self.run_context.context.event.set_extra(
                        "xzy_tool_round", bool(getattr(last, "tools_call_name", None))
                    )
                except Exception:
                    pass
                self._xzy_last_llm_resp = None
            yield resp

    setattr(step, _MARK, True)
    _iter_llm_responses.__xzy_p07__ = True  # type: ignore[attr-defined]
    ToolLoopAgentRunner._iter_llm_responses = _iter_llm_responses  # type: ignore[method-assign]
    ToolLoopAgentRunner.step = step  # type: ignore[method-assign]
    return True
