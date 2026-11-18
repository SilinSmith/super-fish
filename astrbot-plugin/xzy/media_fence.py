"""出站本地文件白名单（fail-closed）。

模型可以在工具参数里写任意本地路径，必须在这里挡住：只有白名单根目录内的
普通文件才允许被读成 base64 发出去（图片/语音/视频/文件/表情/抽帧）。
越界一律抛 FenceError，由 tool_result.fail_from_error 归一成 blocked/forbidden。
"""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import unquote, urlparse


class FenceError(PermissionError):
    """路径越界。故意继承 PermissionError，便于四态分类识别。"""


_ROOTS: list[str] = []


def _data_dir() -> str:
    # <inst>/data/plugins/xzy/media_fence.py -> <inst>/data
    return os.path.abspath(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
    )


def configure(cfg: dict[str, Any] | None = None) -> None:
    """白名单根：~/.dsh/media、E:\\ComfyUI\\output、插件媒体目录，外加可选项。"""
    cfg = cfg or {}
    roots: list[str] = [
        os.path.join(os.path.expanduser("~"), ".dsh", "media"),
        r"E:\ComfyUI\output",
        os.path.join(_data_dir(), "xzy", "media"),
    ]
    media_dir = str(cfg.get("media_dir") or "").strip()
    if media_dir:
        roots.append(media_dir)
    extra = cfg.get("media_roots")
    if isinstance(extra, list):
        roots.extend(str(p) for p in extra if isinstance(p, str) and p.strip())
    _ROOTS[:] = [os.path.normcase(os.path.realpath(p)) for p in roots]


def roots() -> list[str]:
    """给人看的白名单实际值（原始大小写，已 realpath）。"""
    return [os.path.realpath(p) for p in _ROOTS]


def _local_path(raw: str) -> str:
    if raw.lower().startswith("file://"):
        parsed = urlparse(raw)
        path = unquote(parsed.path or "")
        if os.name == "nt" and len(path) >= 3 and path[0] == "/" and path[2] == ":":
            path = path[1:]
        return path
    return raw


def assert_allowed(path: str) -> str:
    """返回可用的真实路径；越界/不存在/不是文件都抛 FenceError。"""
    raw = str(path or "").strip()
    if raw == "":
        raise FenceError("参数 path 必填")
    local = _local_path(raw)
    real = os.path.realpath(local)
    norm = os.path.normcase(real)
    for root in _ROOTS:
        try:
            if os.path.commonpath([norm, root]) == root:
                break
        except ValueError:
            continue
    else:
        raise FenceError(
            "路径越界：只允许白名单目录内的文件（"
            + "；".join(roots())
            + f"），收到：{raw}"
        )
    if not os.path.isfile(real):
        raise FenceError(f"文件不存在或不是普通文件：{raw}")
    return real
