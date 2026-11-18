"""补丁校验：标记 + 行为双重检查。全绿返回 0。"""

from __future__ import annotations

import os
import sys

VENV = os.environ.get("ASTRBOT_VENV", r"E:\Bonsai\astrbot-eval\venv")
SITE = os.path.join(VENV, "Lib", "site-packages")

CHECKS = [
    (
        "P01",
        "astrbot/core/provider/manager.py",
        ["# [XZY-P01]", "provider = None"],
        ["provider = self.provider_insts[0] if self.provider_insts else None"],
    ),
    (
        "P02",
        "astrbot/core/astr_main_agent.py",
        ["# [XZY-P02]", "已保留 req.func_tool"],
        ["does not support tool_use, clearing tools", "req.func_tool = None"],
    ),
    (
        "P03",
        "astrbot/core/star/star_manager.py",
        ["# [XZY-P03]", 'hasattr(star_metadata.star_cls_type, "terminate")'],
        ['elif "terminate" in star_metadata.star_cls_type.__dict__:'],
    ),
    (
        "P04a",
        "astrbot/core/astr_agent_run_util.py",
        ["# [XZY-P04]", "已抑制对外发送"],
        ["AstrBot 请求失败", "set_result(MessageEventResult().message(err_msg))"],
    ),
    (
        "P04b",
        "astrbot/core/pipeline/process_stage/method/agent_sub_stages/internal.py",
        ["# [XZY-P04]", "event.clear_result()"],
        ["Error occurred while processing agent request"],
    ),
    (
        "P05a",
        "astrbot/core/pipeline/process_stage/method/agent_sub_stages/internal.py",
        ["# [XZY-P05a]", "message_to_save = _xzy_p05_history_guard("],
        [],
    ),
    (
        "P05b",
        "astrbot/core/pipeline/process_stage/method/agent_sub_stages/internal.py",
        ["# [XZY-P05b]", "history_snapshots", '"request_only"'],
        [],
    ),
    (
        "P06a",
        "astrbot/core/provider/sources/openai_source.py",
        [
            "# [XZY-P06]",
            "_xzy_p06_create_with_retry",
            "_XZY_P06_RETRYABLE_STATUS = frozenset({500, 502, 503, 504})",
            "SDK 重试已置 0",
            "重试耗尽",
            "重试后成功",
        ],
        [],
    ),
    (
        "P06b",
        "astrbot/core/provider/sources/openai_source.py",
        ["# [XZY-P06b]", "completion = await _xzy_p06_create_with_retry("],
        ["completion = await self.client.chat.completions.create("],
    ),
    (
        "P06c",
        "astrbot/core/provider/sources/openai_source.py",
        ["# [XZY-P06c]", "stream = await _xzy_p06_create_with_retry("],
        ["stream = await self.client.chat.completions.create("],
    ),
    (
        "P06d",
        "astrbot/core/provider/sources/openai_source.py",
        ["# [XZY-P06d]", "P06 是唯一重试策略", "max_retries=0,"],
        [],
    ),
    (
        "P06e",
        "astrbot/core/provider/sources/openai_source.py",
        ["# [XZY-P06e]", "Azure 分支同上", "max_retries=0,"],
        [],
    ),
    (
        "P06f",
        "astrbot/core/provider/sources/openai_source.py",
        ["# [XZY-P06f]", "APIConnectionError, APITimeoutError, NotFoundError"],
        [],
    ),
]


def main() -> int:
    failed = 0
    for pid, rel, must, must_not in CHECKS:
        path = os.path.join(SITE, rel.replace("/", os.sep))
        if not os.path.exists(path):
            print(f"[FAIL] {pid} 文件不存在: {path}")
            failed += 1
            continue
        with open(path, encoding="utf-8") as f:
            text = f.read()
        for token in must:
            if token not in text:
                print(f"[FAIL] {pid} 缺少标记/行为: {token!r}")
                failed += 1
        for token in must_not:
            if token in text:
                print(f"[FAIL] {pid} 仍存在旧行为: {token!r}")
                failed += 1
        if not any(t not in text for t in must) and not any(
            t in text for t in must_not
        ):
            print(f"[OK] {pid} {rel}")

    snap_root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "original")
    snaps = sum(len(files) for _, _, files in os.walk(snap_root))
    print(f"\n原文件快照: {snaps} 个")
    if failed:
        print(f"失败 {failed} 项")
        return 1
    print("补丁校验全绿。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
