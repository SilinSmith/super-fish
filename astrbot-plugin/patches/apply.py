"""AstrBot 4.14.6 集中补丁（P01-P06）。幂等、精确锚点、失败退出。

用法：
    python apply.py            # 打全部补丁（已打的跳过）
    python apply.py --check    # 只检查，不写
"""

from __future__ import annotations

import os
import shutil
import sys

VENV = os.environ.get("ASTRBOT_VENV", r"E:\Bonsai\astrbot-eval\venv")
SITE = os.path.join(VENV, "Lib", "site-packages")
ORIGINAL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "original")

P01 = ("astrbot/core/provider/manager.py", '''                provider = self.inst_map.get(provider_id)
                if not provider:
                    provider = self.provider_insts[0] if self.provider_insts else None
''', '''                provider = self.inst_map.get(provider_id)
                if not provider:
                    # [XZY-P01] 禁止静默回落到 provider_insts[0]
                    logger.error(
                        f"[XZY-P01] 未找到配置的 chat provider id={provider_id!r}"
                        f"（已加载: {list(self.inst_map.keys())}），"
                        "已禁止回落到 provider_insts[0]，本轮不发起推理。"
                    )
                    provider = None
''')

P02 = ("astrbot/core/astr_main_agent.py", '''        if "tool_use" not in provider_cfg:
            logger.debug(
                "Provider %s does not support tool_use, clearing tools.", provider
            )
            req.func_tool = None
''', '''        if "tool_use" not in provider_cfg:
            # [XZY-P02] 原生会静默清空工具；这里保留工具，仅报错
            logger.error(
                f"[XZY-P02] provider modalities={provider_cfg!r} 缺少 tool_use，"
                "已保留 req.func_tool（原生行为是清空）。请修正 provider 配置。"
            )
''')

P03 = ("astrbot/core/star/star_manager.py", '''        elif "terminate" in star_metadata.star_cls_type.__dict__:
''', '''        # [XZY-P03] 原生只认类体直写的 terminate；hasattr 让继承实现也能被回收
        elif hasattr(star_metadata.star_cls_type, "terminate"):
''')

P04A = ("astrbot/core/astr_agent_run_util.py", '''        except Exception as e:
            logger.error(traceback.format_exc())

            err_msg = f"\\n\\nAstrBot 请求失败。\\n错误类型: {type(e).__name__}\\n错误信息: {e!s}\\n\\n请在平台日志查看和分享错误详情。\\n"

            error_llm_response = LLMResponse(
                role="err",
                completion_text=err_msg,
            )
            try:
                await agent_runner.agent_hooks.on_agent_done(
                    agent_runner.run_context, error_llm_response
                )
            except Exception:
                logger.exception("Error in on_agent_done hook")

            if agent_runner.streaming:
                yield MessageChain().message(err_msg)
            else:
                astr_event.set_result(MessageEventResult().message(err_msg))
            return
''', '''        except Exception as e:
            # [XZY-P04] 原生把上游错误原文直接外发；这里只记日志，不外发
            logger.error(
                f"[XZY-P04] agent 回合异常，已抑制对外发送: {type(e).__name__}: {e!s}"
            )
            logger.error(traceback.format_exc())

            error_llm_response = LLMResponse(
                role="err",
                completion_text="",
            )
            try:
                await agent_runner.agent_hooks.on_agent_done(
                    agent_runner.run_context, error_llm_response
                )
            except Exception:
                logger.exception("Error in on_agent_done hook")

            return
''')

P04B = ("astrbot/core/pipeline/process_stage/method/agent_sub_stages/internal.py", '''        except Exception as e:
            logger.error(f"Error occurred while processing agent: {e}")
            await event.send(
                MessageChain().message(
                    f"Error occurred while processing agent request: {e}"
                )
            )
''', '''        except Exception as e:
            # [XZY-P04] 原生把异常原文发到会话；这里只记日志并清空结果，不外发
            logger.error(
                f"[XZY-P04] agent 处理异常，已抑制对外发送: {type(e).__name__}: {e}"
            )
            event.clear_result()
''')

P05A = ("astrbot/core/pipeline/process_stage/method/agent_sub_stages/internal.py", '''        await self.conv_manager.update_conversation(
            event.unified_msg_origin,
            req.conversation.cid,
            history=message_to_save,
            token_usage=token_usage,
        )
''', '''        # [XZY-P05a] 写回前留快照，并按 history_mode 决定「写回」还是「仅本次请求生效」
        message_to_save = _xzy_p05_history_guard(
            event, req, message_to_save, token_usage
        )

        await self.conv_manager.update_conversation(
            event.unified_msg_origin,
            req.conversation.cid,
            history=message_to_save,
            token_usage=token_usage,
        )
''')

P05B = ("astrbot/core/pipeline/process_stage/method/agent_sub_stages/internal.py", '''# we prevent astrbot from connecting to known malicious hosts
''', '''# [XZY-P05b] 历史写回保护：写回前快照 + writeback/request_only 双模式
def _xzy_p05_history_guard(
    event: AstrMessageEvent,
    req: ProviderRequest,
    message_to_save: list[dict],
    token_usage: int | None,
) -> list[dict]:
    """截断写回前留原文快照；按 history_mode.json 决定写回内容。

    - 快照：<data>/xzy/history_snapshots/<umo>/turnNNNN__<wall>.json
    - 模式：<data>/xzy/history_mode.json  {"mode": "writeback" | "request_only"}
    - 丢失判定：pre 的后缀与 new 的前缀做最长重叠，未重叠部分即本轮被丢弃的消息
    """
    import datetime
    import json
    import os
    import re

    from astrbot.core.utils.astrbot_path import get_astrbot_data_path

    state_dir = os.path.join(get_astrbot_data_path(), "xzy")
    mode_path = os.path.join(state_dir, "history_mode.json")

    mode = "writeback"
    try:
        # utf-8-sig：容忍用记事本保存出来的 BOM，避免静默退回 writeback
        with open(mode_path, encoding="utf-8-sig") as f:
            mode = str(json.load(f).get("mode") or "writeback")
    except FileNotFoundError:
        pass
    except Exception as e:
        logger.error(f"[XZY-P05] history_mode.json 读取失败，按 writeback 处理: {e}")
    if mode not in ("writeback", "request_only"):
        logger.error(f"[XZY-P05] history_mode={mode!r} 非法，按 writeback 处理")
        mode = "writeback"

    conv = req.conversation
    raw = conv.history if conv else ""
    try:
        pre = json.loads(raw) if isinstance(raw, str) else list(raw or [])
    except Exception:
        pre = []
    if not isinstance(pre, list):
        pre = []

    def _fp(item):
        try:
            return json.dumps(item, ensure_ascii=False, sort_keys=True, default=str)
        except Exception:
            return repr(item)

    new_fp = [_fp(m) for m in message_to_save]
    pre_fp = [_fp(m) for m in pre]
    overlap = 0
    for k in range(min(len(pre_fp), len(new_fp)), 0, -1):
        if pre_fp[-k:] == new_fp[:k]:
            overlap = k
            break
    dropped = len(pre_fp) - overlap

    final = message_to_save
    if mode == "request_only" and dropped > 0:
        # 仅本次请求生效：把被截掉的前缀拼回去，请求侧仍是截断后的内容
        final = pre[:dropped] + list(message_to_save)

    if dropped > 0:
        umo = event.unified_msg_origin
        safe = re.sub(r"[^A-Za-z0-9._-]+", "_", umo) or "unknown"
        now = datetime.datetime.now().astimezone()
        turn = (
            sum(1 for m in pre if isinstance(m, dict) and m.get("role") == "user") + 1
        )
        wall = now.strftime("%Y%m%dT%H%M%S%f%z")
        payload = {
            "schema": 1,
            "umo": umo,
            "cid": getattr(conv, "cid", None),
            "wall": now.isoformat(),
            "epoch": now.timestamp(),
            "turn": turn,
            "mode": mode,
            "pre_count": len(pre),
            "post_count": len(final),
            "dropped_count": dropped,
            "overlap_zero": overlap == 0,
            "token_usage": token_usage,
            "history": pre,
        }
        snap_path = ""
        try:
            snap_dir = os.path.join(state_dir, "history_snapshots", safe)
            os.makedirs(snap_dir, exist_ok=True)
            snap_path = os.path.join(snap_dir, f"turn{turn:04d}__{wall}.json")
            with open(snap_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
            logger.warning(
                f"[XZY-P05] 历史截断写回: umo={umo} turn={turn} "
                f"{len(pre)}→{len(final)} 条（丢 {dropped}），"
                f"mode={mode}，快照={snap_path}"
            )
        except Exception as e:
            logger.error(f"[XZY-P05] 历史快照写入失败: {e}")
        try:
            audit_dir = os.path.join(state_dir, "audit")
            os.makedirs(audit_dir, exist_ok=True)
            with open(
                os.path.join(audit_dir, "history_writeback.jsonl"),
                "a",
                encoding="utf-8",
            ) as f:
                f.write(
                    json.dumps(
                        {
                            "wall": payload["wall"],
                            "umo": umo,
                            "cid": payload["cid"],
                            "turn": turn,
                            "mode": mode,
                            "pre_count": payload["pre_count"],
                            "post_count": payload["post_count"],
                            "dropped_count": dropped,
                            "overlap_zero": overlap == 0,
                            "snapshot": snap_path,
                        },
                        ensure_ascii=False,
                    )
                    + "\\n"
                )
        except Exception as e:
            logger.error(f"[XZY-P05] 写 history_writeback.jsonl 失败: {e}")

    return final


# we prevent astrbot from connecting to known malicious hosts
''')

P06A = ("astrbot/core/provider/sources/openai_source.py", '''from ..register import register_provider_adapter


@register_provider_adapter(
''', '''from ..register import register_provider_adapter

# [XZY-P06] 上游 5xx 短退避重试：只重试瞬时错误，参数类错误立即抛出
_XZY_P06_RETRYABLE_STATUS = frozenset({500, 502, 503, 504})
_XZY_P06_MAX_RETRIES = 2  # 首次 + 2 次重试 = 最多 3 次尝试


def _xzy_p06_is_transient(e: Exception) -> bool:
    # 连接失败/读超时：SDK 重试已置 0，由这里统一有限重试
    if isinstance(e, (APIConnectionError, APITimeoutError)):
        return True
    status = getattr(e, "status_code", None)
    if isinstance(status, int):
        return status in _XZY_P06_RETRYABLE_STATUS
    text = str(e)
    if "Error code:" not in text:
        return False
    head = text.split("Error code:", 1)[1].strip()[:3]
    return head.isdigit() and int(head) in _XZY_P06_RETRYABLE_STATUS


async def _xzy_p06_create_with_retry(create, **kwargs):
    """在真正发请求的一层对 5xx 做短退避重试。

    - 只重试 500/502/503/504；400/401/422/429 等原样抛出
    - 退避 200-500ms 起、逐次翻倍，+-15% 抖动，最多 3 次尝试
    """
    attempt = 0
    while True:
        attempt += 1
        try:
            result = await create(**kwargs)
        except Exception as e:
            if not _xzy_p06_is_transient(e):
                raise
            if attempt > _XZY_P06_MAX_RETRIES:
                logger.error(
                    f"[XZY-P06] 重试耗尽（共 {attempt} 次尝试），"
                    f"上游原文: {type(e).__name__}: {e!s}"
                )
                raise
            delay = random.uniform(0.2, 0.5) * (2 ** (attempt - 1))
            delay *= random.uniform(0.85, 1.15)
            logger.warning(
                f"[XZY-P06] 上游瞬时错误（第 {attempt} 次尝试），"
                f"{delay * 1000:.0f}ms 后重试: {type(e).__name__}: {e!s}"
            )
            await asyncio.sleep(delay)
            continue
        if attempt > 1:
            logger.info(f"[XZY-P06] 重试后成功（第 {attempt} 次尝试）")
        return result


@register_provider_adapter(
''')

P06B = ("astrbot/core/provider/sources/openai_source.py", '''        completion = await self.client.chat.completions.create(
            **payloads,
            stream=False,
            extra_body=extra_body,
        )
''', '''        # [XZY-P06b] 5xx 短退避重试落在真正发请求的一层
        completion = await _xzy_p06_create_with_retry(
            self.client.chat.completions.create,
            **payloads,
            stream=False,
            extra_body=extra_body,
        )
''')

P06C = ("astrbot/core/provider/sources/openai_source.py", '''        stream = await self.client.chat.completions.create(
            **payloads,
            stream=True,
            extra_body=extra_body,
        )
''', '''        # [XZY-P06c] 流式同样只重试建连这一步，已吐出的 chunk 不重放
        stream = await _xzy_p06_create_with_retry(
            self.client.chat.completions.create,
            **payloads,
            stream=True,
            extra_body=extra_body,
        )
''')

P06D = ("astrbot/core/provider/sources/openai_source.py", '''            self.client = AsyncOpenAI(
                api_key=self.chosen_api_key,
                base_url=provider_config.get("api_base", None),
                default_headers=self.custom_headers,
                timeout=self.timeout,
            )
''', '''            # [XZY-P06d] P06 是唯一重试策略：关掉 SDK 自带 5xx/连接重试
            self.client = AsyncOpenAI(
                api_key=self.chosen_api_key,
                base_url=provider_config.get("api_base", None),
                default_headers=self.custom_headers,
                timeout=self.timeout,
                max_retries=0,
            )
''')

P06E = ("astrbot/core/provider/sources/openai_source.py", '''            self.client = AsyncAzureOpenAI(
                api_key=self.chosen_api_key,
                api_version=provider_config.get("api_version", None),
                default_headers=self.custom_headers,
                base_url=provider_config.get("api_base", ""),
                timeout=self.timeout,
            )
''', '''            # [XZY-P06e] Azure 分支同上：P06 唯一重试策略
            self.client = AsyncAzureOpenAI(
                api_key=self.chosen_api_key,
                api_version=provider_config.get("api_version", None),
                default_headers=self.custom_headers,
                base_url=provider_config.get("api_base", ""),
                timeout=self.timeout,
                max_retries=0,
            )
''')

P06F = ("astrbot/core/provider/sources/openai_source.py", '''from openai._exceptions import NotFoundError
''', '''# [XZY-P06f] 连接失败/读超时纳入 P06 重试判定
from openai._exceptions import APIConnectionError, APITimeoutError, NotFoundError
''')

PATCHES = [
    ("P01", P01),
    ("P02", P02),
    ("P03", P03),
    ("P04a", P04A),
    ("P04b", P04B),
    ("P05a", P05A),
    ("P05b", P05B),
    ("P06b", P06B),
    ("P06c", P06C),
    ("P06d", P06D),
    ("P06e", P06E),
    ("P06f", P06F),
    ("P06a", P06A),
]


def main() -> int:
    check_only = "--check" in sys.argv
    os.makedirs(ORIGINAL, exist_ok=True)
    failed = 0
    for pid, (rel, old, new) in PATCHES:
        path = os.path.join(SITE, rel.replace("/", os.sep))
        if not os.path.exists(path):
            print(f"[FAIL] {pid} 文件不存在: {path}")
            failed += 1
            continue
        with open(path, encoding="utf-8") as f:
            text = f.read()

        marker = f"[XZY-{pid.rstrip('ab')}]"
        if marker in text:
            print(f"[SKIP] {pid} 已打（发现标记 {marker}）")
            continue

        count = text.count(old)
        if count != 1:
            print(f"[FAIL] {pid} 锚点匹配 {count} 次（必须恰好 1 次）: {rel}")
            failed += 1
            continue

        if check_only:
            print(f"[OK] {pid} 锚点唯一，可打: {rel}")
            continue

        snapshot = os.path.join(ORIGINAL, rel.replace("/", os.sep))
        if not os.path.exists(snapshot):
            os.makedirs(os.path.dirname(snapshot), exist_ok=True)
            shutil.copy2(path, snapshot)
            print(f"[SNAP] {pid} 原文件已存: {snapshot}")

        with open(path, "w", encoding="utf-8") as f:
            f.write(text.replace(old, new, 1))
        print(f"[DONE] {pid} 已打: {rel}")

    if failed:
        print(f"\n失败 {failed} 处，未做任何模糊匹配。")
        return 1
    print("\n全部补丁就绪。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
