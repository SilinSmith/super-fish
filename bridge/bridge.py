"""OneBot v11 双向桥：OneBot 协议端 正向 WS（实现侧）↔ AstrBot 反连 WS（客户端侧）。

数据流：
  OneBot 协议端(3001) --event--> bridge --event--> AstrBot(6199/ws)
  AstrBot(6199/ws) --action--> bridge --action--> OneBot 协议端(3001) --response--> AstrBot

按 bridge-mode.json 过滤入站事件（每条事件读一次，mtime 变了才重读）：
  old        不转发任何事件（桥不应在 old 模式下运行）
  private    私聊 + 私聊类 notice/request
  one-group  私聊 + 指定群的全部事件（group_id 单个字符串）
  groups     私聊 + group_ids 列表里的群（one-group 的多群版，2026-11-15 新增）
  all        全部

文件格式（JSON，热加载，无需重启）：
  {"mode":"one-group","group_id":"100000001"}
  {"mode":"groups","group_ids":["100000001","100000004","100000002"]}
  groups 模式只放行列表里的群；列表外的群照旧 DROP（reason=group filtered）。

用法（默认值即现网）：
  python bridge.py
  python bridge.py --upstream ws://127.0.0.1:3001 --astrbot ws://127.0.0.1:6199/ws
离线联调时把 --upstream 指到假服务器即可，不会连真实 3001。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import time
from pathlib import Path

import aiohttp

# 机器人自己的 QQ 号：用于丢弃自己发出的回声消息、识别「自己撤回自己」。
# 发布版不写死，默认取自环境变量，也可用 --self-id 覆盖。
SELF_ID = os.environ.get("QQ_SELF_ID", "10001")
# 台账/日志/模式文件所在目录：默认与脚本同目录，可用 --home 或 QQ_CUTOVER_DIR 覆盖。
HOME = Path(os.environ.get("QQ_CUTOVER_DIR") or Path(__file__).resolve().parent)

# 入站噪声黑名单（精确三元组，白名单式排除）。
#
# 只丢 notify/input_status：它是「对方正在输入…」的瞬时 UX 提示，raw_message 为空。
# 之前它被当普通事件转进 AstrBot，aiocqhttp 会构造出空消息事件，进防抖合批后
# merged_count 虚高、prompt 里出现空条目（2026-11-15 01:39 实测 merged=4，前 3 条为空）。
#
# 明确保留（不在此集合内，继续按 allow() 原有规则转发）：
#   notice/friend_recall、notice/group_recall      —— 撤回，下游要据此清上下文
#   notice/group_increase、group_decrease、group_admin —— 群成员/管理变动
#   notice/group_upload、group_ban、group_card      —— 群文件/禁言/名片
#   notify/poke、notify/honor、notify/lucky_king    —— 戳一戳与群荣誉
#   request/friend、request/group                   —— 加好友/加群请求
# 即「有消息语义或被下游消费的 notice」全部放行，只砍纯输入状态。
NOISE_NOTICE_SUBTYPES = frozenset({"input_status"})

# 撤回（对齐旧栈 recall.js）：通知类型、台账保留
# 2026-11-15：用户否决「跟着对方撤回就自动删自己的回复」，bridge 不再发 delete_msg，
# 只记账（result=notice-only）。是否撤回由模型自己判断（插件侧 qq_recall 工具）。
RECALL_NOTICE_TYPES = frozenset({"group_recall", "friend_recall"})
LEDGER_MAX_AGE_SEC = 1800.0
LEDGER_KEEP = 400

# 入站补投队列：AstrBot 断开期间把要转发的事件留在内存，重连后按序补投。
# 上限之外的先丢最旧，并写一条 drop reason=queue-overflow（含被丢的 message_id/群/人），不静默丢。
INBOUND_QUEUE_CAP = 200


def wall() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


class Bridge:
    def __init__(self, args: argparse.Namespace) -> None:
        self.upstream_url = args.upstream
        self.ab_url = args.astrbot
        self.mode_file = Path(args.mode_file)
        self.log_path = Path(args.log)
        self.pid_path = Path(args.pid)
        self.mode: dict = {"mode": "old", "group_id": ""}
        self.mode_mtime = 0
        self.upstream_ws: aiohttp.ClientWebSocketResponse | None = None
        self.ab_ws: aiohttp.ClientWebSocketResponse | None = None
        self.pending: dict[str, asyncio.Future] = {}
        self.stop = asyncio.Event()
        # AstrBot 断开期间待补投的入站（有上限，见 INBOUND_QUEUE_CAP）
        self.inbound_queue: list[dict] = []
        self.started_at = time.time()
        # 撤回台账：chat -> 最近入站 id（只在「上一批已被回复」后重置，同批多气泡共用）
        self.last_inbound: dict[str, list[dict]] = {}
        self.last_outbound_at: dict[str, float] = {}
        self.ledger_path = HOME / "recall-ledger.jsonl"
        self.recall_path = HOME / "recall.jsonl"
        self.ledger: list[dict] = self._load_ledger()

    # ---------------------------------------------------------------- logging
    def log(self, kind: str, /, **fields) -> None:
        rec = {"at": wall(), **fields, "kind": kind}
        line = json.dumps(rec, ensure_ascii=False)
        try:
            with open(self.log_path, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except Exception as exc:  # noqa: BLE001
            print(f"LOG_ERR {exc}", flush=True)
        print(line, flush=True)

    # ------------------------------------------------------------------ mode
    def current_mode(self) -> dict:
        try:
            st = os.stat(self.mode_file)
            if st.st_mtime_ns != self.mode_mtime:
                self.mode = json.loads(self.mode_file.read_text(encoding="utf-8"))
                self.mode_mtime = st.st_mtime_ns
                self.log("mode", mode=self.mode.get("mode"), group_id=self.mode.get("group_id", ""),
                         group_ids=self.mode.get("group_ids") or [])
        except Exception as exc:  # noqa: BLE001
            self.log("mode-error", error=f"{type(exc).__name__}: {exc}")
        return self.mode

    def _group_ids(self, mode: dict) -> set[str]:
        """groups 模式读 group_ids 列表；one-group 沿用单个 group_id。"""
        if str(mode.get("mode") or "") == "groups":
            ids = mode.get("group_ids") or []
            if isinstance(ids, (str, int)):
                ids = [ids]
            return {str(x) for x in ids if str(x).strip()}
        gid = str(mode.get("group_id", "") or "")
        return {gid} if gid else set()

    def allow(self, ev: dict) -> tuple[bool, str]:
        mode_obj = self.current_mode()
        mode = str(mode_obj.get("mode") or "old")
        gids = self._group_ids(mode_obj)
        post = ev.get("post_type")
        if mode == "old":
            return False, "mode=old"
        if (post == "notice"
                and ev.get("notice_type") == "notify"
                and str(ev.get("sub_type") or "") in NOISE_NOTICE_SUBTYPES):
            # 输入状态没有正文，转进去只会变成空消息事件污染合批与 prompt。
            return False, f"noise:{ev.get('notice_type')}/{ev.get('sub_type')}"
        if post == "meta_event":
            # lifecycle 必须给；heartbeat 在 all 阶段才透传，减少噪声。
            if ev.get("meta_event_type") == "lifecycle" or mode == "all":
                return True, "meta"
            return False, "meta filtered"
        if post == "message":
            mtype = ev.get("message_type")
            if mtype == "private":
                return mode in ("private", "one-group", "groups", "all"), "private"
            if mtype == "group":
                if mode == "all":
                    return True, "group"
                if mode in ("one-group", "groups"):
                    ok = str(ev.get("group_id")) in gids
                    return ok, "group" if ok else "group filtered"
                return False, "group filtered"
            return False, f"message_type={mtype}"
        if post in ("notice", "request"):
            if ev.get("group_id") is not None:
                if mode == "all":
                    return True, f"{post}/group"
                if mode in ("one-group", "groups"):
                    ok = str(ev.get("group_id")) in gids
                    return ok, f"{post}/group" if ok else f"{post}/group filtered"
                return False, f"{post}/group filtered"
            return mode in ("private", "one-group", "groups", "all"), f"{post}/private"
        return mode == "all", f"post_type={post}"

    # --------------------------------------------------------------- recall
    def _load_ledger(self) -> list[dict]:
        rows: list[dict] = []
        try:
            with open(self.ledger_path, "r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rows.append(json.loads(line))
                    except Exception:  # noqa: BLE001
                        continue
        except FileNotFoundError:
            return []
        except Exception as exc:  # noqa: BLE001
            self.log("ledger-error", error=f"{type(exc).__name__}: {exc}")
            return []
        return rows[-LEDGER_KEEP:]

    @staticmethod
    def chat_key(ev: dict) -> str:
        if ev.get("group_id") is not None:
            return str(ev.get("group_id"))
        return f"private:{ev.get('user_id')}"

    def note_inbound(self, ev: dict) -> None:
        """记入站 id；若上一批已经被回复过，新入站开启新的一组 sources。"""
        key = self.chat_key(ev)
        now = time.time()
        rows = [
            r for r in self.last_inbound.get(key, [])
            if now - float(r.get("at") or 0) <= LEDGER_MAX_AGE_SEC
        ]
        last_out = float(self.last_outbound_at.get(key) or 0)
        if rows and last_out >= float(rows[-1].get("at") or 0):
            rows = []
        message_id = str(ev.get("message_id") or "")
        if message_id:
            rows.append({"id": message_id, "at": now})
        self.last_inbound[key] = rows[-8:]

    def note_outbound(self, action: str, params: dict, resp: dict) -> None:
        """send_* 成功后把「自己发出的 message_id ← 本批入站」写台账。"""
        if action not in ("send_private_msg", "send_group_msg"):
            return
        data = resp.get("data") or {}
        message_id = str(data.get("message_id") or "") if isinstance(data, dict) else ""
        if resp.get("status") != "ok" or not message_id:
            return
        if params.get("group_id") is not None:
            chat = str(params.get("group_id"))
        else:
            chat = f"private:{params.get('user_id')}"
        now = time.time()
        sources = [r["id"] for r in self.last_inbound.get(chat, []) if r.get("id")]
        rec = {
            "at": now,
            "wall": wall(),
            "chat": chat,
            "message_id": message_id,
            "sources": sources,
            "action": action,
        }
        self.last_outbound_at[chat] = now
        self.ledger.append(rec)
        self.ledger = self.ledger[-LEDGER_KEEP:]
        try:
            with open(self.ledger_path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        except Exception as exc:  # noqa: BLE001
            self.log("ledger-error", error=f"{type(exc).__name__}: {exc}")

    def record_recall(self, **fields) -> None:
        rec = {"at": wall(), **fields}
        try:
            with open(self.recall_path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        except Exception as exc:  # noqa: BLE001
            self.log("recall-audit-error", error=f"{type(exc).__name__}: {exc}")
        self.log("RECALL", **fields)

    async def handle_recall(self, ev: dict) -> None:
        """入站撤回：只记账，不自动删自己的回复（2026-11-15 用户否决联动撤回）。

        是否撤回自己说过的话由模型判断（插件 `qq_recall` 工具），bridge 不再跟着
        对方的撤回动作按时间窗 delete_msg。台账保留，作为「这条回复在回谁」的审计证据。
        """
        notice_type = str(ev.get("notice_type") or "")
        recalled = str(ev.get("message_id") or "")
        chat = self.chat_key(ev)
        operator = str(ev.get("operator_id") or ev.get("user_id") or "")
        now = time.time()
        if operator == SELF_ID:
            self.record_recall(kind="notice", notice_type=notice_type, chat=chat,
                               message_id=recalled, operator=operator, result="self")
            return
        targets = [
            r for r in self.ledger
            if r.get("chat") == chat
            and now - float(r.get("at") or 0) <= LEDGER_MAX_AGE_SEC
            and recalled in (r.get("sources") or [])
        ]
        if not targets:
            self.record_recall(kind="notice", notice_type=notice_type, chat=chat,
                               message_id=recalled, operator=operator, result="not-found")
            return
        # 只记录「这条入站曾被谁回复」，不触达 QQ；撤回动作留给模型。
        for rec in targets:
            self.record_recall(
                kind="notice", notice_type=notice_type, chat=chat, message_id=recalled,
                operator=operator, reply_id=str(rec.get("message_id") or ""),
                result="notice-only", age=round(now - float(rec.get("at") or 0), 1),
            )

    # ------------------------------------------------------------- forwards
    def enqueue_inbound(self, ev: dict) -> None:
        """AstrBot 未连接：入站进内存队列，重连后补投。

        meta_event 不入队（过期的 lifecycle/heartbeat 补投无意义），只记 drop。
        队列满时先丢最旧的一条并写 queue-overflow 审计，不静默丢。
        """
        if ev.get("post_type") == "meta_event":
            self.log("drop", reason="astrbot-not-connected", message_id=ev.get("message_id"))
            return
        if len(self.inbound_queue) >= INBOUND_QUEUE_CAP:
            dropped = self.inbound_queue.pop(0)
            self.log("drop", reason="queue-overflow", queued=len(self.inbound_queue),
                     cap=INBOUND_QUEUE_CAP, message_id=dropped.get("message_id"),
                     post_type=dropped.get("post_type"), group_id=dropped.get("group_id"),
                     user_id=dropped.get("user_id"))
        self.inbound_queue.append(ev)
        self.log("QUEUE", queued=len(self.inbound_queue), cap=INBOUND_QUEUE_CAP,
                 post_type=ev.get("post_type"), group_id=ev.get("group_id"),
                 user_id=ev.get("user_id"), message_id=ev.get("message_id"))

    async def replay_inbound(self, ws) -> None:
        """AstrBot 重连后按序补投内存队列；中途失败保留剩余，下次重连再投。"""
        if not self.inbound_queue:
            return
        self.log("REPLAY", count=len(self.inbound_queue))
        replayed = 0
        while self.inbound_queue:
            ev = self.inbound_queue[0]
            try:
                await ws.send_json(ev)
            except Exception as exc:  # noqa: BLE001
                self.log("drop", reason=f"replay-failed: {type(exc).__name__}: {exc}",
                         message_id=ev.get("message_id"), remaining=len(self.inbound_queue))
                return
            self.inbound_queue.pop(0)
            replayed += 1
            self.log("REPLAY-OK", message_id=ev.get("message_id"),
                     post_type=ev.get("post_type"), group_id=ev.get("group_id"),
                     user_id=ev.get("user_id"))
        self.log("replay-done", count=replayed)

    async def send_event(self, ev: dict) -> None:
        if self.ab_ws is None or self.ab_ws.closed:
            self.enqueue_inbound(ev)
            return
        try:
            await self.ab_ws.send_json(ev)
            summary = {
                "message_type": ev.get("message_type") or ev.get("meta_event_type") or ev.get("post_type"),
                "group_id": ev.get("group_id"),
                "user_id": ev.get("user_id"),
                "message_id": ev.get("message_id"),
                "raw": str(ev.get("raw_message", ""))[:200],
            }
            self.log("INBOUND", **{k: v for k, v in summary.items() if v is not None})
        except Exception as exc:  # noqa: BLE001
            self.log("drop", reason=f"send-event-failed: {type(exc).__name__}: {exc}",
                     message_id=ev.get("message_id"))

    async def relay_action(self, frame: dict) -> dict:
        echo = frame.get("echo")
        if self.upstream_ws is None or self.upstream_ws.closed:
            return {"status": "failed", "retcode": 100, "data": None, "echo": echo,
                    "wording": "onebot not connected"}
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        key = str(echo)
        self.pending[key] = fut
        try:
            await self.upstream_ws.send_json(frame)
            resp = await asyncio.wait_for(fut, timeout=40)
        except asyncio.TimeoutError:
            resp = {"status": "failed", "retcode": 120, "data": None, "echo": echo,
                    "wording": "onebot action timeout"}
        except Exception as exc:  # noqa: BLE001
            resp = {"status": "failed", "retcode": 130, "data": None, "echo": echo,
                    "wording": f"{type(exc).__name__}: {exc}"}
        finally:
            self.pending.pop(key, None)
        action = frame.get("action", "")
        params = frame.get("params") or {}
        brief = {k: params.get(k) for k in ("group_id", "user_id", "message", "message_id") if k in params}
        self.log("OUTBOUND", action=action, params=brief,
                 status=resp.get("status"), retcode=resp.get("retcode"))
        return resp

    # ---------------------------------------------------------------- loops
    async def upstream_loop(self, session: aiohttp.ClientSession) -> None:
        while not self.stop.is_set():
            try:
                async with session.ws_connect(self.upstream_url, heartbeat=30, max_msg_size=0) as ws:
                    self.upstream_ws = ws
                    # 启动到接上 3001 之间的入站 bridge 看不到（进程还没连），
                    # 这里把窗口长度写进日志，避免「空窗内丢了什么」完全不可追溯。
                    self.log("upstream-connected", url=self.upstream_url,
                             startupGapSec=round(time.time() - self.started_at, 1))
                    async for msg in ws:
                        if msg.type != aiohttp.WSMsgType.TEXT:
                            continue
                        try:
                            data = json.loads(msg.data)
                        except Exception:  # noqa: BLE001
                            continue
                        if "status" in data and "echo" in data and "post_type" not in data:
                            fut = self.pending.get(str(data.get("echo")))
                            if fut is not None and not fut.done():
                                fut.set_result(data)
                            continue
                        if "post_type" not in data:
                            continue
                        if (data.get("post_type") == "message"
                                and str(data.get("user_id")) == SELF_ID):
                            self.log("drop", reason="self-message", message_id=data.get("message_id"))
                            continue
                        ok, why = self.allow(data)
                        if not ok:
                            self.log("DROP", reason=why, post_type=data.get("post_type"),
                                     message_type=data.get("message_type"),
                                     notice_type=data.get("notice_type"),
                                     sub_type=data.get("sub_type"),
                                     group_id=data.get("group_id"),
                                     message_id=data.get("message_id"))
                            continue
                        if data.get("post_type") == "message":
                            self.note_inbound(data)
                        elif (data.get("post_type") == "notice"
                              and data.get("notice_type") in RECALL_NOTICE_TYPES):
                            # 只记账（不再 delete_msg），再把通知转给 AstrBot 做上下文收尾
                            await self.handle_recall(data)
                        await self.send_event(data)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                self.log("upstream-error", error=f"{type(exc).__name__}: {exc}")
            finally:
                self.upstream_ws = None
            if not self.stop.is_set():
                await asyncio.sleep(2)

    async def ab_loop(self, session: aiohttp.ClientSession) -> None:
        headers = {
            "X-Client-Role": "universal",
            "X-Self-ID": SELF_ID,
            "User-Agent": "qq-cutover-bridge/1.0",
        }
        while not self.stop.is_set():
            try:
                async with session.ws_connect(self.ab_url, headers=headers, heartbeat=30,
                                              max_msg_size=0) as ws:
                    self.ab_ws = ws
                    self.log("astrbot-connected", url=self.ab_url, self_id=SELF_ID)
                    await ws.send_json({
                        "post_type": "meta_event",
                        "meta_event_type": "lifecycle",
                        "sub_type": "connect",
                        "time": int(time.time()),
                        "self_id": int(SELF_ID),
                    })
                    # 连上后先补投断开期间攒下的入站，再进入正常收发
                    await self.replay_inbound(ws)
                    async for msg in ws:
                        if msg.type != aiohttp.WSMsgType.TEXT:
                            continue
                        try:
                            data = json.loads(msg.data)
                        except Exception:  # noqa: BLE001
                            continue
                        if "action" not in data:
                            continue
                        resp = await self.relay_action(data)
                        self.note_outbound(
                            str(data.get("action") or ""), data.get("params") or {}, resp
                        )
                        try:
                            await ws.send_json(resp)
                        except Exception as exc:  # noqa: BLE001
                            self.log("ab-send-error", error=f"{type(exc).__name__}: {exc}")
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                self.log("astrbot-error", error=f"{type(exc).__name__}: {exc}")
            finally:
                self.ab_ws = None
            if not self.stop.is_set():
                await asyncio.sleep(2)

    async def run(self) -> None:
        self.log("start", onebot=self.upstream_url, astrbot=self.ab_url,
                 mode_file=str(self.mode_file), pid=os.getpid())
        timeout = aiohttp.ClientTimeout(total=None, sock_connect=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            tasks = [asyncio.create_task(self.upstream_loop(session)),
                     asyncio.create_task(self.ab_loop(session))]
            await self.stop.wait()
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        self.log("stop")


def main() -> int:
    global SELF_ID, HOME
    parser = argparse.ArgumentParser()
    parser.add_argument("--upstream", default="ws://127.0.0.1:3001")
    parser.add_argument("--astrbot", default="ws://127.0.0.1:6199/ws")
    parser.add_argument("--self-id", default=os.environ.get("QQ_SELF_ID", SELF_ID))
    parser.add_argument("--home", default=os.environ.get("QQ_CUTOVER_DIR", ""))
    parser.add_argument("--mode-file", default="")
    parser.add_argument("--log", default="")
    parser.add_argument("--pid", default="")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    SELF_ID = str(args.self_id)
    if args.home:
        HOME = Path(args.home)
    args.mode_file = args.mode_file or str(HOME / "bridge-mode.json")
    args.log = args.log or str(HOME / "bridge.log")
    args.pid = args.pid or str(HOME / "bridge.pid")

    pid_path = Path(args.pid)
    if pid_path.exists() and not args.force:
        try:
            old = int(pid_path.read_text(encoding="utf-8").strip() or "0")
            if old and os.path.exists(f"/proc/{old}"):
                print(f"bridge already running pid={old}", flush=True)
                return 1
            if old:
                import subprocess
                out = subprocess.run(["tasklist", "/FI", f"PID eq {old}"], capture_output=True, text=True)
                if str(old) in (out.stdout or ""):
                    print(f"bridge already running pid={old}", flush=True)
                    return 1
        except Exception:  # noqa: BLE001
            pass

    PID_PATH = pid_path

    async def runner() -> None:
        bridge = Bridge(args)
        PID_PATH.write_text(str(os.getpid()), encoding="utf-8")
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, bridge.stop.set)
            except NotImplementedError:
                pass
        try:
            await bridge.run()
        finally:
            try:
                if PID_PATH.read_text(encoding="utf-8").strip() == str(os.getpid()):
                    PID_PATH.unlink(missing_ok=True)
            except Exception:  # noqa: BLE001
                pass

    asyncio.run(runner())
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except BaseException:
        # pythonw 没有控制台，崩溃必须落盘，否则只剩「进程没了」这一条线索
        import traceback

        try:
            with open(HOME / "bridge.crash.log", "a", encoding="utf-8") as fh:
                fh.write(wall() + "\n" + traceback.format_exc() + "\n")
        finally:
            raise

