"""生成与分析批次（batch3）的共享底座：路径、日志、LLM/视觉客户端、JSON 账本。

只被 batch3 自己的模块引用；共享层（tool_result / tool_schema / tool_send /
main.py）保持只读。所有路径都允许用环境变量覆盖，方便用独立副本验证。
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import time
from pathlib import Path
from typing import Any

PERSONA_HOME = Path(os.environ.get("QQ_PERSONA_HOME", r"E:\Bonsai\astrbot-eval\inst\data\xzy\persona"))
BACKEND_CONFIG = Path(os.environ.get("QQ_LLM_CONFIG", str(PERSONA_HOME / "llm-backend.json")))
MEDIA_DIR = Path(os.environ.get("QQ_MEDIA_DIR", str(PERSONA_HOME / "media")))
STATE_DIR = MEDIA_DIR / "state"
GENERATED_DIR = MEDIA_DIR / "generated"
LOG_PATH = Path(os.environ.get("QQ_MEDIA_LOG", str(PERSONA_HOME / "media-tools.log")))
COMFY_BASE = os.environ.get("QQ_COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
LEASE_PATH = Path(os.environ.get("QQ_LEASE_PATH", str(PERSONA_HOME / "gpu-lease.json")))
ENGINE_CONTROL = os.environ.get(
    "QQ_ENGINE_CONTROL", r"Y:\workspace\ninfer\engine-control.ps1"
)
ENGINE_CONTROL_CWD = os.environ.get("QQ_ENGINE_CONTROL_CWD", r"Y:\workspace\ninfer")
ENGINE_HEALTH = os.environ.get("QQ_ENGINE_HEALTH", "http://127.0.0.1:8094/v1/models")
BROKER_BASE = os.environ.get("QQ_BROKER_URL", "http://127.0.0.1:1240").rstrip("/")

_BACKEND_CACHE: dict[str, Any] = {"mtime": 0.0, "value": None}
_LOG_LOCK: asyncio.Lock | None = None


def backend() -> dict[str, Any]:
    """读取 llm-backend.json；环境变量优先，便于隔离验证。"""
    try:
        mtime = BACKEND_CONFIG.stat().st_mtime
    except OSError:
        mtime = 0.0
    if _BACKEND_CACHE["value"] is not None and _BACKEND_CACHE["mtime"] == mtime:
        value = dict(_BACKEND_CACHE["value"])
    else:
        value = {}
        try:
            with open(BACKEND_CONFIG, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                value = loaded
        except (OSError, ValueError, TypeError):
            value = {}
        _BACKEND_CACHE["value"] = dict(value)
        _BACKEND_CACHE["mtime"] = mtime
    value["baseUrl"] = os.environ.get("QQ_LLM_BASE", value.get("baseUrl") or "http://127.0.0.1:8094/v1")
    value["model"] = os.environ.get("QQ_LLM_MODEL", value.get("model") or "bonsai-2-27b")
    value["apiKey"] = os.environ.get("QQ_LLM_KEY", value.get("apiKey") or "")
    return value


async def engine_ready(timeout: float = 2.0) -> bool:
    """模型/视觉后端是否在线：探测 backend baseUrl 的 /models。"""
    try:
        import aiohttp
    except ImportError:  # pragma: no cover - 环境缺依赖时按不可用处理
        return False
    url = str(backend().get("baseUrl") or "").rstrip("/") + "/models"
    try:
        timeout_obj = aiohttp.ClientTimeout(total=timeout)
        async with aiohttp.ClientSession(timeout=timeout_obj) as session:
            async with session.get(url) as resp:
                return resp.status < 400
    except Exception:  # noqa: BLE001 - 连不上就当不可用
        return False


def log(level: str, message: str) -> None:
    """打印到 AstrBot 日志，同时落一份独立文件回执。"""
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] [{level}] {message}"
    try:
        print(f"qq-media: {message}")
    except Exception:
        pass
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        if LOG_PATH.exists() and LOG_PATH.stat().st_size > 2 * 1024 * 1024:
            os.replace(LOG_PATH, LOG_PATH.with_suffix(".1.log"))
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def audit_engine(record: dict[str, Any]) -> None:
    """引擎卸载/恢复审计：谁卸的、什么时候恢复、卡了多久。"""
    row = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), **record}
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        with open(STATE_DIR / "engine-switch.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    except (OSError, TypeError):
        pass


def read_json(path: Path, default: Any) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError, TypeError):
        return default


def write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp{os.getpid()}")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def append_jsonl(path: Path, entry: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        f.flush()


def tail_jsonl(path: Path, limit: int = 40) -> list[dict[str, Any]]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            lines = f.readlines()[-limit:]
    except OSError:
        return []
    items: list[dict[str, Any]] = []
    for line in lines:
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict):
            items.append(value)
    return items


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def image_data_url(path: str, max_side: int = 768) -> str:
    """把本地图片缩到最长边 max_side，转成 data URL；PIL 不可用时原样编码。"""
    try:
        from PIL import Image  # type: ignore

        with Image.open(path) as im:
            im = im.convert("RGB")
            im.thumbnail((max_side, max_side))
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=86)
            raw = buf.getvalue()
        return "data:image/jpeg;base64," + base64.b64encode(raw).decode("ascii")
    except Exception:
        with open(path, "rb") as f:
            raw = f.read()
        return "data:image/png;base64," + base64.b64encode(raw).decode("ascii")


async def chat_text(
    messages: list[dict[str, Any]],
    *,
    max_tokens: int = 512,
    timeout: float = 60.0,
    temperature: float = 0.2,
) -> str:
    """调本机 ninfer 的 OpenAI 兼容接口；失败抛 RuntimeError（中文摘要）。"""
    try:
        import aiohttp
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("缺少 aiohttp，无法调用本机模型") from exc
    cfg = backend()
    base = str(cfg.get("baseUrl") or "").rstrip("/")
    url = base + "/chat/completions"
    headers = {"Content-Type": "application/json"}
    if cfg.get("apiKey"):
        headers["Authorization"] = f"Bearer {cfg['apiKey']}"
    payload = {
        "model": cfg.get("model") or "local",
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": False,
    }
    timeout_obj = aiohttp.ClientTimeout(total=timeout)
    try:
        async with aiohttp.ClientSession(timeout=timeout_obj) as session:
            async with session.post(url, json=payload, headers=headers) as resp:
                raw = await resp.text()
                if resp.status >= 400:
                    raise RuntimeError(f"本机模型返回 {resp.status}")
    except asyncio.TimeoutError as exc:
        raise RuntimeError("本机模型超时") from exc
    except aiohttp.ClientError as exc:
        raise RuntimeError("连不上本机模型") from exc
    try:
        data = json.loads(raw)
        content = data["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise RuntimeError("本机模型返回格式异常") from exc
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("本机模型返回空内容")
    return content.strip()


async def describe_image(path: str, prompt: str, *, timeout: float = 30.0) -> str:
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": image_data_url(path)}},
            ],
        }
    ]
    return await chat_text(messages, max_tokens=220, timeout=timeout, temperature=0.2)
