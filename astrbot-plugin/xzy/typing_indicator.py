"""出站「对方正在输入…」：OneBot `set_input_status`。

能力依据（读源码 + 旧栈调用日志，不是假设）：
- `Y:\\SnowLuma\\index.mjs:13882` 定义 OneBot 动作 `set_input_status`，
  参数 `user_id` / `event_type`（默认 0），成功返回 `{}`；
- 实现 `index.mjs:331597` → `SetInputStatus`（OIDB 0xcd4），报文里 `chatType` 恒为 0，
  且动作参数只有 `user_id` —— 协议层是 C2C 语义，**群聊没有对应能力**，因此只对私聊生效；
- `event_type` 取值按旧栈 2026-11-14 10:05 的实际调用序列（SnowLuma 日志
  `[Bridge.Action] set_input_status params=user_id=... event_type=1/0`）：
  1 = 正在输入、0 = 停止；3 = 正在讲话（`index.mjs:144830` 的入站文案映射）。

入站对应事件即 `notice/notify/input_status`，已由 bridge 侧过滤，不会再变空消息。

失败处理：调用异常或 retcode 非 0 时立刻停止本轮循环，不重试、不假装成功；
客户端不会因此卡在「正在输入」——停止刷新后 QQ 自己会在数秒内清掉。
"""

from __future__ import annotations

import asyncio
from typing import Any

from astrbot.api import logger

TYPING = 1
STOP = 0


class TypingIndicator:
    """按会话维护一个「保持输入中」的后台任务；begin 幂等，end 立即停。"""

    def __init__(self, cfg: dict[str, Any] | None = None) -> None:
        cfg = cfg or {}
        self.enabled = bool(cfg.get("enabled", True))
        # 低于 QQ 侧 5 秒过期阈值，宁可多刷一次
        self.interval_s = float(cfg.get("intervalSec", 4.0))
        # 兜底：回合异常卡住时也不会一直挂着
        self.ttl_s = float(cfg.get("ttlSec", 180.0))
        self._tasks: dict[str, tuple[asyncio.Task, asyncio.Event]] = {}

    async def begin(self, event) -> None:
        if not self.enabled or event is None:
            return
        try:
            # 群聊没有对应 API（chatType 固定 0、无 group_id 参数），不装作支持
            if not event.is_private_chat():
                return
            user_id = int(event.get_sender_id())
        except Exception:  # noqa: BLE001
            return
        key = str(getattr(event, "unified_msg_origin", "") or "")
        if not key or key in self._tasks:
            return
        bot = getattr(event, "bot", None)
        if bot is None or not hasattr(bot, "call_action"):
            return
        stop = asyncio.Event()
        task = asyncio.create_task(self._loop(key, bot, user_id, stop))
        self._tasks[key] = (task, stop)

    async def end(self, event) -> None:
        key = str(getattr(event, "unified_msg_origin", "") or "")
        rec = self._tasks.pop(key, None)
        if rec is None:
            return
        task, stop = rec
        stop.set()
        try:
            await asyncio.wait_for(task, timeout=self.interval_s + 2.0)
        except Exception:  # noqa: BLE001
            task.cancel()

    async def shutdown(self) -> None:
        entries = list(self._tasks.values())
        self._tasks.clear()
        for _, stop in entries:
            stop.set()
        if entries:
            await asyncio.gather(*(t for t, _ in entries), return_exceptions=True)

    async def _loop(
        self, key: str, bot, user_id: int, stop: asyncio.Event
    ) -> None:
        started = asyncio.get_running_loop().time()
        try:
            while not stop.is_set():
                if not await self._set(bot, user_id, TYPING, key):
                    return
                if asyncio.get_running_loop().time() - started > self.ttl_s:
                    logger.debug(f"[xzy] typing 超时收尾 key={key}")
                    return
                try:
                    await asyncio.wait_for(stop.wait(), timeout=self.interval_s)
                except asyncio.TimeoutError:
                    continue
        finally:
            await self._set(bot, user_id, STOP, key)

    @staticmethod
    async def _set(bot, user_id: int, event_type: int, key: str) -> bool:
        try:
            await bot.call_action(
                "set_input_status", user_id=int(user_id), event_type=int(event_type)
            )
            return True
        except Exception as exc:  # noqa: BLE001
            # 能力不可用/连接断开：只记一次 debug，不影响出站
            logger.debug(
                f"[xzy] set_input_status(event_type={event_type}) 失败 "
                f"key={key}: {type(exc).__name__}: {exc}"
            )
            return False
