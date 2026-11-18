"""入模前图片压缩：所有进模型上下文的图统一收敛到安全尺寸/体积（spec §15.9）。

实测口径（2026-11-15，ninfer 8094 / bonsai-2-27b，engine-requests.jsonl 的
`preparation_seconds.vision_tokens`，KV 页 = 64 token）：

    long_edge   size        bytes     vision_tokens  KV 页
    原图        3840x2400   1025627   9000           141
    1280        1280x800    120725    1000           16
    1024        1024x640     70062     640           10
    768          768x480     45786     360            6
    512          512x320     24994     160            3
    384          384x240     16191      96            2
    512 q95      512x320     44381     160            3
    512 q45      512x320     12345     160            3

即 `vision_tokens = ceil(W/32) * ceil(H/32)`，只跟像素网格有关、跟字节数无关；
所以按长边收敛，字节上限只作兜底（省 base64 体积与下载时间）。

范围：只作用于送模型的 `image_urls` / 视觉观察调用；出站（QQ 发图）保持原图，
本模块不改 event 消息链里的任何 component。

降级：任何一步失败（拿不到图/解码失败/超时）都返回 None，调用方丢掉这张图继续，
不允许把整回合打挂。
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import os
import time
from typing import Any

import logging

logger = logging.getLogger("astrbot")

DEFAULT_MAX_EDGE = 768
DEFAULT_MAX_BYTES = 98304
DEFAULT_INPUT_MAX_BYTES = 12 * 1024 * 1024  # 12MB，超过直接放弃
DEFAULT_TIMEOUT = 10.0
QUALITY_LADDER = (86, 78, 70, 62)

_CFG: dict[str, Any] = {}
_STATE_DIR = ""


def configure(cfg: dict[str, Any], state_dir: str = "") -> None:
    global _CFG, _STATE_DIR
    _CFG = dict(cfg.get("image_prep") or {})
    if state_dir:
        _STATE_DIR = state_dir


def _opt() -> dict[str, Any]:
    return {
        "enabled": _CFG.get("enabled") is not False,
        "maxEdge": int(_CFG.get("maxEdge") or DEFAULT_MAX_EDGE),
        "maxBytes": int(_CFG.get("maxBytes") or DEFAULT_MAX_BYTES),
        "inputMaxBytes": int(_CFG.get("inputMaxBytes") or DEFAULT_INPUT_MAX_BYTES),
        "timeoutSec": float(_CFG.get("timeoutSec") or DEFAULT_TIMEOUT),
    }


def _cache_dir() -> str:
    root = _STATE_DIR or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "xzy")
    path = os.path.join(os.path.abspath(root), "cache", "img")
    os.makedirs(path, exist_ok=True)
    return path


def _audit(record: dict[str, Any]) -> None:
    root = _STATE_DIR or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "xzy")
    try:
        audit_dir = os.path.join(os.path.abspath(root), "audit")
        os.makedirs(audit_dir, exist_ok=True)
        row = {"wall": time.strftime("%Y-%m-%d %H:%M:%S"), **record}
        with open(os.path.join(audit_dir, "image_prep.jsonl"), "a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[xzy] image_prep 审计写入失败: {type(exc).__name__}: {exc}")


def _kind(ref: str) -> str:
    low = ref.lower()
    if low.startswith(("http://", "https://")):
        return "http"
    if low.startswith("base64://"):
        return "base64"
    if low.startswith("data:"):
        return "data"
    if low.startswith("file:///"):
        return "file"
    return "path"


async def _read_ref(ref: str, timeout: float, limit: int) -> tuple[bytes, str]:
    """把各种引用读成原始字节；拿不到就抛异常（由上层降级）。"""
    kind = _kind(ref)
    if kind == "http":
        import aiohttp

        client_timeout = aiohttp.ClientTimeout(total=timeout)
        async with aiohttp.ClientSession(timeout=client_timeout) as session:
            async with session.get(ref) as resp:
                if resp.status >= 400:
                    raise RuntimeError(f"HTTP {resp.status}")
                declared = int(resp.headers.get("Content-Length") or 0)
                if declared > limit:
                    raise RuntimeError(f"图片超过 {limit} 字节")
                # 注意：StreamReader.read(n) 只保证「至少读到一块」，会提前返回，
                # 这里必须 read() 读完整包体，否则大图会被截断成半张（PIL 报 truncated）。
                raw = await resp.read()
        if len(raw) > limit:
            raise RuntimeError(f"图片超过 {limit} 字节")
        return raw, kind
    if kind == "base64":
        return base64.b64decode(ref.removeprefix("base64://")), kind
    if kind == "data":
        body = ref.split(",", 1)[-1]
        return base64.b64decode(body), kind
    path = ref.removeprefix("file:///") if kind == "file" else ref
    # provider 侧就是 open(路径)（相对进程 cwd），这里保持同一套解析口径
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    size = os.path.getsize(path)
    if size > limit:
        raise RuntimeError(f"图片超过 {limit} 字节（{size}）")
    with open(path, "rb") as fh:
        return fh.read(), kind


def _compress(raw: bytes, max_edge: int, max_bytes: int) -> tuple[bytes, tuple[int, int], tuple[int, int], int]:
    """按长边缩 + 质量阶梯收敛；返回 (jpeg 字节, 原始尺寸, 输出尺寸, quality)。"""
    from PIL import Image

    with Image.open(io.BytesIO(raw)) as im:
        src_size = im.size
        fmt = (im.format or "").upper()
        if fmt == "JPEG" and max(src_size) <= max_edge and len(raw) <= max_bytes:
            # 已经够小、格式也对：原样放行，不再二次有损编码
            return raw, src_size, src_size, 100
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            canvas = Image.new("RGB", im.size, (255, 255, 255))
            canvas.paste(im, mask=im.split()[-1])
            im = canvas
        else:
            im = im.convert("RGB")
        im.thumbnail((max_edge, max_edge), Image.LANCZOS)
        out_size = im.size
        best: bytes | None = None
        for quality in QUALITY_LADDER:
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=quality, optimize=True)
            data = buf.getvalue()
            if best is None or len(data) < len(best):
                best = data
            if len(data) <= max_bytes:
                return data, src_size, out_size, quality
        assert best is not None
        return best, src_size, out_size, QUALITY_LADDER[-1]


async def shrink_one(ref: str) -> str | None:
    """压缩一张图，返回本地缓存路径；失败返回 None（调用方丢掉这张图）。"""
    opt = _opt()
    if not opt["enabled"] or not ref:
        return ref or None
    t0 = time.perf_counter()
    try:
        raw, kind = await asyncio.wait_for(
            _read_ref(ref, opt["timeoutSec"], opt["inputMaxBytes"]),
            timeout=opt["timeoutSec"],
        )
        data, src_size, out_size, quality = await asyncio.to_thread(
            _compress, raw, opt["maxEdge"], opt["maxBytes"]
        )
        name = hashlib.sha1(raw).hexdigest()[:20] + f"_{opt['maxEdge']}_q{quality}.jpg"
        path = os.path.join(_cache_dir(), name)
        if not os.path.exists(path):
            tmp = f"{path}.{os.getpid()}.{int(time.time() * 1000)}.tmp"
            with open(tmp, "wb") as fh:
                fh.write(data)
            os.replace(tmp, path)
        _audit(
            {
                "result": "ok",
                "kind": kind,
                "src_bytes": len(raw),
                "src_size": f"{src_size[0]}x{src_size[1]}",
                "out_bytes": len(data),
                "out_size": f"{out_size[0]}x{out_size[1]}",
                "quality": quality,
                "ms": round((time.perf_counter() - t0) * 1000, 1),
            }
        )
        return path
    except Exception as exc:  # noqa: BLE001
        _audit(
            {
                "result": "failed",
                "kind": _kind(ref),
                "source": ref[:160],
                "error": f"{type(exc).__name__}: {exc}",
                "ms": round((time.perf_counter() - t0) * 1000, 1),
            }
        )
        logger.warning(f"[xzy] 图片压缩失败，本轮不带图: {type(exc).__name__}: {exc}")
        return None


async def shrink_many(refs: list[str]) -> list[str]:
    """批量压缩；失败的整条丢掉，绝不抛异常。"""
    if not refs:
        return []
    results = await asyncio.gather(*(shrink_one(r) for r in refs), return_exceptions=True)
    out: list[str] = []
    for item in results:
        if isinstance(item, str) and item:
            out.append(item)
    return out
