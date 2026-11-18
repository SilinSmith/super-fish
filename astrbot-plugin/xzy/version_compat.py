"""版本行为集中开关（spec §1.2）：业务代码里不得出现 `if version == ...`。

当前锁定 AstrBot 4.14.6（PyPI）。升级/重装 venv 后：
  1) patches/apply.py  2) patches/verify.py  3) 重启并看 audit/version_warnings.jsonl
"""

from __future__ import annotations

import importlib.metadata as _md
import os

import astrbot

TARGET_VERSION = "4.14.6"

_SITE = os.path.dirname(os.path.dirname(os.path.abspath(astrbot.__file__)))

# 4.14.6 已实测的上游行为（事实，不是开关）：
# - 重载**会**调用 terminate（rectified；旧 REPORT §7 的「不调」不可复现）
# - 压缩没有「保留最近 15%」：truncate_by_turns 丢最旧 1 轮，仍超则腰斩 50%
# - modalities 缺 tool_use 会静默清空工具（P02 已改）
# - provider id 找不到会静默回落 provider_insts[0]（P01 已改）
# - terminate 只认类体直写（P03 已改为 hasattr）
PATCH_MARKERS: dict[str, tuple[str, str]] = {
    "P01": ("astrbot/core/provider/manager.py", "[XZY-P01]"),
    "P02": ("astrbot/core/astr_main_agent.py", "[XZY-P02]"),
    "P03": ("astrbot/core/star/star_manager.py", "[XZY-P03]"),
    "P04a": ("astrbot/core/astr_agent_run_util.py", "[XZY-P04]"),
    "P04b": (
        "astrbot/core/pipeline/process_stage/method/agent_sub_stages/internal.py",
        "[XZY-P04]",
    ),
    "P05a": (
        "astrbot/core/pipeline/process_stage/method/agent_sub_stages/internal.py",
        "[XZY-P05a]",
    ),
    "P05b": (
        "astrbot/core/pipeline/process_stage/method/agent_sub_stages/internal.py",
        "[XZY-P05b]",
    ),
}


def installed_version() -> str:
    try:
        return _md.version("AstrBot")
    except Exception:
        return "unknown"


def check_patches() -> list[str]:
    """返回问题列表；空列表 = 全部就绪。"""
    issues: list[str] = []
    for pid, (rel, marker) in PATCH_MARKERS.items():
        path = os.path.join(_SITE, rel.replace("/", os.sep))
        try:
            with open(path, encoding="utf-8") as f:
                text = f.read()
        except OSError as e:
            issues.append(f"{pid} 读不到 {rel}: {e}")
            continue
        if marker not in text:
            issues.append(f"{pid} 标记缺失（{marker}）: {rel}")
    return issues


def version_warnings() -> list[str]:
    warnings = check_patches()
    actual = installed_version()
    if actual != TARGET_VERSION:
        warnings.append(
            f"当前 AstrBot {actual} != 锁定版本 {TARGET_VERSION}；"
            "补丁锚点与压缩/重载语义可能已变，需重跑 patches/verify.py 与 REPORT 实测"
        )
    return warnings
