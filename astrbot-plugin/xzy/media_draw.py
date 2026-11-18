"""MOSS 出图链路（对齐旧栈 qq-persona/moss-gen.mjs + draw-review.mjs + gpu-lease.mjs）。

闭环顺序与旧栈一致：
  拿租约 → 确保 ComfyUI → 释放聊天模型 → 提交工作流 → 取图 → 释放 ComfyUI 显存
  → 恢复聊天模型 → 放租约
任何一步失败，finally 都要尽量把聊天模型装回来。排队（别的任务在跑）与
真正失败是两种终态，由调用方区分，不能静默当成失败。
"""

from __future__ import annotations

import asyncio
import ctypes
import hashlib
import json
import os
import random
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

try:
    from .media_platform import (
        BROKER_BASE,
        COMFY_BASE,
        ENGINE_CONTROL,
        ENGINE_CONTROL_CWD,
        ENGINE_HEALTH,
        GENERATED_DIR,
        LEASE_PATH,
        MEDIA_DIR,
        STATE_DIR,
        audit_engine,
        backend,
        chat_text,
        log,
        read_json,
        write_json_atomic,
    )
except ImportError:  # AstrBot 以模块方式加载时走这里
    from media_platform import (  # type: ignore
        BROKER_BASE,
        COMFY_BASE,
        ENGINE_CONTROL,
        ENGINE_CONTROL_CWD,
        ENGINE_HEALTH,
        GENERATED_DIR,
        LEASE_PATH,
        MEDIA_DIR,
        STATE_DIR,
        audit_engine,
        backend,
        chat_text,
        log,
        read_json,
        write_json_atomic,
    )

COMBO = "moss\\"
MODELS = {
    "unet": COMBO + "moss_image_sft_int8_convrot.safetensors",
    "clip": COMBO + "qwen3.5_9b_int8_convrot.safetensors",
    "vae": COMBO + "flux2-vae.safetensors",
    "dmd": COMBO + "加速\\02-8步加速当前.safetensors",
}

SLIDERS = {
    "detail": (COMBO + "滑块\\01-细节.safetensors", 0.2),
    "quality": (COMBO + "滑块\\02-质量.safetensors", 0.25),
    "age": (COMBO + "滑块\\03-年龄.safetensors", -1.0),
    "chest": (COMBO + "滑块\\04-胸部.safetensors", -2.4),
    "weight": (COMBO + "滑块\\05-体重.safetensors", -1.5),
    "light": (COMBO + "滑块\\06-光照.safetensors", 0.5),
}

STYLES = {
    "动漫写实": COMBO + "风格\\01-Anireal动漫写实.safetensors",
    "BunnySlop": COMBO + "风格\\02-BunnySlop.safetensors",
    "Kzmynon": COMBO + "风格\\03-Kzmynon.safetensors",
    "鬼针草v2": COMBO + "风格\\04-鬼针草v2.safetensors",
    "Silvana": COMBO + "风格\\05-Silvana.safetensors",
    "ningenmame": COMBO + "风格\\06-ningenmame.safetensors",
    "cunnyfunky": COMBO + "风格\\07-cunnyfunky.safetensors",
    "厚涂2.5D": COMBO + "风格\\08-厚涂2.5D.safetensors",
    "奶蛙": COMBO + "风格\\09-奶蛙.safetensors",
    "赛璐珞": COMBO + "风格\\10-赛璐珞.safetensors",
    "鬼针草Anima": COMBO + "风格\\11-鬼针草Anima.safetensors",
    "shionnnk": COMBO + "风格\\12-shionnnk.safetensors",
    "鲸鱼娘": COMBO + "风格\\13-鲸鱼娘.safetensors",
}

DEFAULT_NEGATIVE = "worst quality, bad anatomy, watermark, jpeg artifact, blurry, lowres"
ASPECT_RATIOS = {
    "1:1": (1, 1),
    "2:3": (2, 3),
    "3:2": (3, 2),
    "3:4": (3, 4),
    "4:3": (4, 3),
    "9:16": (9, 16),
    "16:9": (16, 9),
    "21:9": (21, 9),
}
COMFY_OUTPUT = Path(os.environ.get("QQ_COMFY_OUTPUT", r"E:\ComfyUI\output"))
COMFY_BREAKER = Path(os.environ.get("QQ_COMFY_BREAKER", str(MEDIA_DIR / "comfy-breaker.json")))
REVIEW_LOG = Path(os.environ.get("QQ_DRAW_REVIEW_LOG", r"E:\Bonsai\astrbot-eval\inst\data\xzy\persona\draw-review.jsonl"))
UNSENT_DRAW = STATE_DIR / "last-draw.json"
# engine-control.ps1 unload 时落的标记（同目录），恢复失败后靠它让 watchdog 兜底
PENDING_RESTORE_MARKER = Path(os.environ.get(
    "QQ_ENGINE_PENDING_MARKER",
    r"Y:\dsh\2026-11-10\infer-deploy\work\logs\engine.pending-restore.json"))
# 出图窗口把 TTS(Style-Bert-VITS2-CUDA, 127.0.0.1:5000) 的 ~1.3 GiB 也让出去
TTS_YIELD = os.environ.get("QQ_TTS_YIELD", r"Y:\dsh\tts-yield.ps1")
IMAGE_QUEUE = Path(os.environ.get("QQ_IMAGE_QUEUE", r"E:\Bonsai\astrbot-eval\inst\data\xzy\persona\image-requests.json"))
MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_REVIEW_QUEUE = 4
_REVIEW_LOCK = asyncio.Lock()
_REVIEW_WAITING = 0

REVIEW_SYSTEM = "你是图像质检员，只做判定。不聊天、不扮演任何角色、不寒暄、不解释过程。只输出一段 JSON。"
REVIEW_RUBRIC = """检查这张图，逐项判断：
1. hands_ok：手指数量与形状是否正常（多指、少指、粘连、断手都算 false）
2. limbs_ok：四肢是否错位、缺失、重复（多手多脚、肢体反关节都算 false）
3. face_ok：脸部是否崩坏、五官错位、眼睛不对称
4. text_ok：图中文字是否清楚可读；没有任何文字时算 true
5. composition_ok：主体是否完整、不糊、没有大片空白或被裁掉
6. noise_ok：没有明显噪点、色块、拼接伪影
最后给 score（0-100）和 defects（中文短句，没有就空数组）。
任一 *_ok 为 false 或 score < 60 时 verdict 必须是 "fail"，否则 "pass"。
只输出 JSON，不要代码块，不要解释：
{"hands_ok":true,"limbs_ok":true,"face_ok":true,"text_ok":true,"composition_ok":true,"noise_ok":true,"score":80,"defects":[],"verdict":"pass"}"""
FIELDS = ["hands_ok", "limbs_ok", "face_ok", "text_ok", "composition_ok", "noise_ok"]
FIELD_LABEL = {
    "hands_ok": "手",
    "limbs_ok": "四肢",
    "face_ok": "脸",
    "text_ok": "文字",
    "composition_ok": "构图",
    "noise_ok": "噪点",
}


class DrawBusy(RuntimeError):
    """排队/显存/租约被占用：不是失败，调用方应回“稍后再画”。"""


class DrawFailed(RuntimeError):
    """真正失败：ComfyUI 起不来、工作流被拒、生成崩溃。"""


# --------------------------------------------------------------------------- #
# 尺寸与工作流
# --------------------------------------------------------------------------- #
def resolution_for(aspect: str, megapixels: Any) -> tuple[int, int]:
    pair = ASPECT_RATIOS.get(aspect) or ASPECT_RATIOS["1:1"]
    try:
        mp = float(megapixels)
    except (TypeError, ValueError):
        mp = 1.0
    mp = min(2.0, max(0.4, mp))
    scale = ((mp * 1024 * 1024) / (pair[0] * pair[1])) ** 0.5

    def round8(value: float) -> int:
        return max(64, int(round(value / 8)) * 8)

    return round8(pair[0] * scale), round8(pair[1] * scale)


def _clamp(value: Any, low: float, high: float, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return min(high, max(low, number))


def build_workflow(options: dict[str, Any]) -> dict[str, Any]:
    steps = 8
    try:
        seed = int(options.get("seed") or 0)
    except (TypeError, ValueError):
        seed = 0
    if seed <= 0:
        seed = random.randint(1, 10**15)
    style = str(options.get("style") or "动漫写实")
    style_file = None if style == "无" else STYLES.get(style, STYLES["动漫写实"])
    positive = ("best quality, highres, " + str(options.get("prompt") or "")).strip()
    negative = str(options.get("negative") or "").strip() or DEFAULT_NEGATIVE
    width, height = resolution_for(str(options.get("aspect") or "1:1"), options.get("megapixels"))
    workflow: dict[str, Any] = {
        "13": {"class_type": "UNETLoader", "inputs": {"unet_name": MODELS["unet"], "weight_dtype": "default"}},
        "1328": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["13", 0], "shift": 5.0, "sampling": "flow"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": MODELS["clip"], "type": "moss_image", "device": "default"}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": positive, "clip": ["2", 0]}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": negative, "clip": ["2", 0]}},
        "7": {"class_type": "EmptyLatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": MODELS["vae"]}},
        "1311": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["1529", 0], "seed": seed, "steps": steps, "cfg": 1.0,
                "sampler_name": "euler", "scheduler": "simple",
                "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["7", 0], "denoise": 1.0,
            },
        },
        "1312": {"class_type": "VAEDecode", "inputs": {"samples": ["1311", 0], "vae": ["3", 0]}},
        "1313": {"class_type": "SaveImage", "inputs": {"images": ["1312", 0], "filename_prefix": "qq_draw_" + str(int(time.time() * 1000))}},
    }
    previous = "1328"
    sliders = [
        ("20", SLIDERS["detail"][0], _clamp(options.get("detail"), -0.75, 0.75, SLIDERS["detail"][1])),
        ("21", SLIDERS["quality"][0], _clamp(options.get("quality"), 0, 1, SLIDERS["quality"][1])),
        ("22", SLIDERS["age"][0], SLIDERS["age"][1]),
        ("23", SLIDERS["chest"][0], SLIDERS["chest"][1]),
        ("24", SLIDERS["weight"][0], SLIDERS["weight"][1]),
        ("25", SLIDERS["light"][0], _clamp(options.get("light"), 0, 1, SLIDERS["light"][1])),
    ]
    for node_id, lora, strength in sliders:
        workflow[node_id] = {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {"model": [previous, 0], "lora_name": lora, "strength_model": strength},
        }
        previous = node_id
    if style_file is not None:
        workflow["26"] = {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {"model": [previous, 0], "lora_name": style_file, "strength_model": 0.7},
        }
        previous = "26"
    workflow["27"] = {
        "class_type": "LoraLoaderModelOnly",
        "inputs": {"model": [previous, 0], "lora_name": MODELS["dmd"], "strength_model": 0.7},
    }
    workflow["1529"] = {
        "class_type": "SkipLayerGuidanceDiTSimple",
        "inputs": {
            "model": ["27", 0], "double_layers": "", "single_layers": "22",
            "start_percent": 0.0, "end_percent": 0.5,
        },
    }
    return {
        "workflow": workflow,
        "seed": seed,
        "steps": steps,
        "width": width,
        "height": height,
        "style": "无" if style_file is None else style,
        "positive": positive,
        "negative": negative,
    }


# --------------------------------------------------------------------------- #
# ComfyUI
# --------------------------------------------------------------------------- #
def _http():
    import aiohttp

    return aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30))


async def comfy_up(timeout: float = 2.0) -> bool:
    try:
        import aiohttp

        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as session:
            async with session.get(COMFY_BASE + "/system_stats") as resp:
                return resp.status < 500
    except Exception:
        return False


def _read_breaker() -> dict[str, Any]:
    value = read_json(COMFY_BREAKER, {})
    return value if isinstance(value, dict) else {}


def _write_breaker(state: dict[str, Any]) -> None:
    try:
        write_json_atomic(COMFY_BREAKER, state)
    except OSError:
        pass


async def ensure_comfy() -> None:
    if await comfy_up():
        if int(_read_breaker().get("failures") or 0) > 0:
            _write_breaker({"failures": 0, "clearedAt": time.strftime("%Y-%m-%dT%H:%M:%S")})
        return
    now = int(time.time() * 1000)
    breaker = _read_breaker()
    failures = int(breaker.get("failures") or 0)
    cooldown_until = int(breaker.get("cooldownUntil") or 0)
    if cooldown_until > now:
        left = max(1, (cooldown_until - now + 999) // 1000)
        log("warn", f"ComfyUI 冷却中，跳过启动（剩 {left} 秒）")
        raise DrawBusy("ComfyUI 刚启动失败过，过几分钟再试")
    next_failures = failures + 1
    cooldown_ms = min(15 * 60_000, 5 * 60_000 * (2 ** max(0, next_failures - 1)))
    attempt_at = time.strftime("%Y-%m-%dT%H:%M:%S")
    _write_breaker({
        "failures": next_failures,
        "lastAttemptAt": attempt_at,
        "cooldownUntil": now + cooldown_ms,
        "lastError": "启动中",
    })
    log("info", "ComfyUI 未运行，请求 proxy 在沙箱外启动（本轮只试这一次）")
    reason = ""
    try:
        import aiohttp

        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=100)) as session:
            async with session.post(BROKER_BASE + "/comfy/ensure") as resp:
                try:
                    body = await resp.json(content_type=None)
                except ValueError:
                    body = {}
                if isinstance(body, dict) and body.get("ok") is True and await comfy_up():
                    _write_breaker({"failures": 0, "clearedAt": time.strftime("%Y-%m-%dT%H:%M:%S")})
                    log("info", "ComfyUI ready（由 proxy 启动）")
                    return
                reason = str((body or {}).get("error") or f"HTTP {resp.status}")
    except Exception as exc:
        reason = str(exc)
    _write_breaker({
        "failures": next_failures,
        "lastAttemptAt": attempt_at,
        "cooldownUntil": int(time.time() * 1000) + cooldown_ms,
        "lastError": reason[:200],
    })
    log("warn", f"ComfyUI 启动失败，停止重试 {cooldown_ms // 60_000} 分钟：{reason}")
    raise DrawFailed(f"ComfyUI 没起来（{reason}）")


async def free_comfy_vram(label: str) -> bool:
    try:
        import aiohttp

        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
            async with session.post(
                COMFY_BASE + "/free",
                json={"unload_models": True, "free_memory": True},
            ) as resp:
                log("info", f"ComfyUI /free ({label}) status={resp.status}")
                return resp.status < 400
    except Exception as exc:
        log("warn", f"ComfyUI /free failed: {exc}")
        return False


async def _queue_state() -> dict[str, Any]:
    import aiohttp

    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
        async with session.get(COMFY_BASE + "/queue") as resp:
            raw = await resp.text()
    data = json.loads(raw)
    return data if isinstance(data, dict) else {}


async def queue_busy() -> bool:
    try:
        queue = await _queue_state()
    except Exception:
        return False
    running = len(queue.get("queue_running") or [])
    pending = len(queue.get("queue_pending") or [])
    return running + pending > 0


async def _queue_has_prompt(prompt_id: str) -> bool:
    try:
        queue = await _queue_state()
    except Exception:
        return True
    for key in ("queue_running", "queue_pending"):
        for item in queue.get(key) or []:
            if isinstance(item, list) and prompt_id in item:
                return True
    return False


async def _http_json(method: str, url: str, payload: Any = None, timeout: float = 30.0) -> tuple[int, Any]:
    import aiohttp

    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as session:
        kwargs: dict[str, Any] = {}
        if payload is not None:
            kwargs["json"] = payload
        async with session.request(method, url, **kwargs) as resp:
            raw = await resp.text()
            try:
                body = json.loads(raw)
            except ValueError:
                body = raw[:400]
            return resp.status, body


async def submit_and_wait(workflow: dict[str, Any], timeout: float = 180.0) -> dict[str, Any]:
    client_id = str(uuid.uuid4())
    status, body = await _http_json("POST", COMFY_BASE + "/prompt", {"prompt": workflow, "client_id": client_id})
    if status >= 400 or not isinstance(body, dict) or body.get("prompt_id") is None:
        detail = ""
        if isinstance(body, dict):
            detail = str((body.get("error") or {}).get("message") or body.get("node_errors") or body)[:400]
        else:
            detail = str(body)[:400]
        raise DrawFailed("ComfyUI 拒绝了工作流：" + detail)
    prompt_id = str(body["prompt_id"])
    deadline = time.time() + timeout
    missing = 0
    while time.time() < deadline:
        await asyncio.sleep(1.5)
        history: Any = None
        for _ in range(3):
            try:
                _, history = await _http_json("GET", f"{COMFY_BASE}/history/{prompt_id}", timeout=10)
                break
            except Exception:
                await asyncio.sleep(0.7)
        if history is None:
            raise DrawFailed("ComfyUI 在处理时崩溃了（常见于显存被抢占），等它恢复后再画")
        entry = history.get(prompt_id) if isinstance(history, dict) else None
        if isinstance(entry, dict):
            status_obj = entry.get("status") or {}
            if status_obj.get("status_str") == "error":
                messages = []
                for item in status_obj.get("messages") or []:
                    if isinstance(item, list) and len(item) > 1 and isinstance(item[1], dict):
                        messages.append(str(item[1].get("message") or item[0]))
                    else:
                        messages.append(str(item))
                raise DrawFailed("MOSS 生成失败：" + ("; ".join(messages) or "未知错误")[:400])
            images = ((entry.get("outputs") or {}).get("1313") or {}).get("images") or []
            if images:
                return {"promptId": prompt_id, "image": images[0]}
            continue
        if await _queue_has_prompt(prompt_id):
            missing = 0
        else:
            missing += 1
            if missing >= 3:
                raise DrawFailed("任务从 ComfyUI 队列里消失了（进程可能崩溃）")
    try:
        await _http_json("POST", COMFY_BASE + "/interrupt", {}, timeout=5)
    except Exception:
        pass
    raise DrawFailed(f"MOSS 生成超时（{int(timeout)}s）")


# --------------------------------------------------------------------------- #
# GPU 租约
# --------------------------------------------------------------------------- #
def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return True
    try:
        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel32.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        try:
            code = ctypes.c_ulong(0)
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return True
            return code.value == 259
        finally:
            kernel32.CloseHandle(handle)
    except Exception:
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False


def read_lease() -> dict[str, Any] | None:
    value = read_json(LEASE_PATH, None)
    if not isinstance(value, dict):
        return None
    try:
        if int(value.get("expiresAt") or 0) < int(time.time() * 1000):
            return None
        if not pid_alive(int(value.get("pid") or 0)):
            return None
    except (TypeError, ValueError):
        return None
    return value


def acquire_lease(*, owner: str, reason: str, ttl_ms: int = 15 * 60_000) -> dict[str, Any]:
    existing = read_lease()
    if existing is not None:
        return {"ok": False, "lease": existing}
    LEASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    lease = {
        "id": str(uuid.uuid4()),
        "owner": owner,
        "pid": os.getpid(),
        "reason": reason,
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "expiresAt": int(time.time() * 1000) + max(30_000, int(ttl_ms)),
    }
    try:
        fd = os.open(str(LEASE_PATH), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(lease) + "\n")
        return {"ok": True, "lease": lease}
    except FileExistsError:
        again = read_lease()
        if again is not None:
            return {"ok": False, "lease": again}
        try:
            os.unlink(LEASE_PATH)
        except OSError:
            pass
        try:
            fd = os.open(str(LEASE_PATH), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(json.dumps(lease) + "\n")
            return {"ok": True, "lease": lease}
        except OSError:
            return {"ok": False, "lease": read_lease()}


def release_lease(lease_id: str) -> bool:
    current = read_lease()
    if current is not None and current.get("id") != lease_id:
        return False
    try:
        os.unlink(LEASE_PATH)
    except OSError:
        pass
    return True


# --------------------------------------------------------------------------- #
# 聊天引擎释放/恢复
# --------------------------------------------------------------------------- #
# 引擎默认容量已改成 86016（1344 页）——降级值若仍是 86016 就等于「没降级，只多花一次
# /free 和一轮启动」。取 73728（1152 页），runtime 预留约 5.8 GiB，比 86016 的 6.41 GiB
# 少 ~0.6 GiB，显存真挤的时候才有可降空间；上下文短一点也比 QQ 一直不回强。
DEGRADED_KV_CAPACITY = 73728

# 恢复「卡住检测」：以「还有没有进展」判死，不用固定总时长。
# 依据：正常热启动 8.9s；但进程被杀后的冷启动实测 1m 18.6s（04:54:00→04:55:13，
# CUDA graphs 就占 1m11s）。只按总时长设阈值会把冷启动误杀（实测 40s 阈值两次误杀）。
# 所以看两个进展信号：engine.err.log 字节数 + GPU 已用显存；连续 NO_PROGRESS_SEC
# 没有变化才算卡住；总时长另有 HARD_CEILING_SEC 兜底。可用环境变量覆盖。
NO_PROGRESS_SEC = 25.0
HARD_CEILING_SEC = 180.0
# 默认容量 86016 的 runtime 预留实测 6.41 GiB ≈ 6564 MiB
# （05:24:47 engine.err.log: `capacity | KV 86,016 tokens ... runtime 6.41 GiB`）。
# 旧值 7100 是按 94208 的 6957 MiB 定的，默认容量改小后会误判「不够」，
# 把本该满配的第一枪直接推去降级。
ENGINE_REQUIRED_MB = 6600
ENGINE_LOG = PENDING_RESTORE_MARKER.parent / "engine.err.log"


def _no_progress_sec() -> float:
    try:
        value = float(os.environ.get("QQ_ENGINE_STUCK_SEC") or NO_PROGRESS_SEC)
    except Exception:
        return NO_PROGRESS_SEC
    return max(10.0, value)


def _hard_ceiling_sec() -> float:
    try:
        value = float(os.environ.get("QQ_ENGINE_RESTORE_CEIL_SEC") or HARD_CEILING_SEC)
    except Exception:
        return HARD_CEILING_SEC
    return max(60.0, value)


async def _gpu_free_mb() -> int:
    """当前 GPU 空闲显存（MiB）；查不到返回 -1。"""
    try:
        proc = await asyncio.create_subprocess_exec(
            "nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            creationflags=getattr(__import__("subprocess"), "CREATE_NO_WINDOW", 0),
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        return int(out.decode("utf-8", "replace").strip().splitlines()[0])
    except Exception:
        return -1


async def _engine_progress_snapshot() -> tuple[int, int]:
    """恢复进展信号：(engine.err.log 字节数, GPU 已用 MiB)。任一变化都算在推进。"""
    try:
        size = ENGINE_LOG.stat().st_size
    except Exception:
        size = 0
    used = -1
    try:
        proc = await asyncio.create_subprocess_exec(
            "nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            creationflags=getattr(__import__("subprocess"), "CREATE_NO_WINDOW", 0),
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        used = int(out.decode("utf-8", "replace").strip().splitlines()[0])
    except Exception:
        used = -1
    return size, used


async def _kill_tree(pid: int) -> None:
    """杀掉脚本进程树（powershell 被杀后它拉起的 start-ninfer 仍会跑）。"""
    try:
        proc = await asyncio.create_subprocess_exec(
            "taskkill", "/PID", str(pid), "/T", "/F",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            creationflags=getattr(__import__("subprocess"), "CREATE_NO_WINDOW", 0),
        )
        await asyncio.wait_for(proc.wait(), timeout=10)
    except Exception:
        pass


async def _kill_stuck_engine() -> bool:
    """健康信号一直没来、进程却还在：它是卡在初始化占着端口的僵尸，清掉才能降级重试。"""
    if await _engine_ready(timeout=2.0):
        return False
    try:
        proc = await asyncio.create_subprocess_exec(
            "taskkill", "/IM", "ninfer-serve-89.exe", "/T", "/F",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            creationflags=getattr(__import__("subprocess"), "CREATE_NO_WINDOW", 0),
        )
        await asyncio.wait_for(proc.communicate(), timeout=10)
        return proc.returncode == 0
    except Exception:
        return False



async def _kill_supervisor() -> tuple[int, bool]:
    """停掉引擎 supervisor（watchdog 常驻进程）。

    卡住判定后只杀引擎进程的话，supervisor 会立刻用**第一次的 argv** 再拉一只起来，
    第二次（降级 + --no-cuda-graph）就永远轮不到，还会留下双实例。
    """
    sup_file = PENDING_RESTORE_MARKER.parent / "supervisor.pid"
    try:
        pid = int(sup_file.read_text(encoding="utf-8").strip().splitlines()[0])
    except (OSError, ValueError, IndexError):
        return 0, False
    if pid <= 0:
        return 0, False
    try:
        proc = await asyncio.create_subprocess_exec(
            "taskkill", "/PID", str(pid), "/T", "/F",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            creationflags=getattr(__import__("subprocess"), "CREATE_NO_WINDOW", 0),
        )
        await asyncio.wait_for(proc.communicate(), timeout=10)
        return pid, proc.returncode == 0
    except Exception:
        return pid, False


async def _engine_process_alive() -> bool:
    """ninfer 进程还在说明 start-ninfer 仍在重试：不能再并发拉第二个。"""
    try:
        proc = await asyncio.create_subprocess_exec(
            "tasklist", "/FI", "IMAGENAME eq ninfer-serve-89.exe", "/NH",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            creationflags=getattr(__import__("subprocess"), "CREATE_NO_WINDOW", 0),
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        return "ninfer-serve-89" in out.decode("utf-8", "replace").lower()
    except Exception:
        return True  # 查不到就当还活着，宁可不降级也不要并发出两个引擎


async def _engine_reachable(timeout: float = 2.5) -> bool:
    try:
        import aiohttp

        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as session:
            async with session.get(ENGINE_HEALTH) as resp:
                return resp.status < 600
    except Exception:
        return False


async def _engine_ready(timeout: float = 2.5) -> bool:
    try:
        import aiohttp

        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as session:
            async with session.get(ENGINE_HEALTH) as resp:
                return resp.status < 400
    except Exception:
        return False


async def _run_engine_script(action: str, timeout: float, kv_capacity: int = 0) -> tuple[int, str]:
    cmd = [
        "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
        "-ExecutionPolicy", "Bypass", "-File", ENGINE_CONTROL,
        "-Action", action,
    ]
    if action == "unload":
        # MaxDrawSec：出图链路死掉时，守护最多等这么久就无条件恢复（默认 900s 太长）
        cmd += [
            "-Owner", "qq_draw", "-OwnerPid", str(os.getpid()),
            "-Reason", "MOSS 出图", "-MaxDrawSec", "360",
        ]
    elif action == "restore":
        # 恢复也要留身份：engine-control.log 里不能出现 owner=unknown
        cmd += [
            "-Owner", "qq_draw", "-OwnerPid", str(os.getpid()),
            "-Reason", "出图结束",
        ]
        if kv_capacity > 0:
            # 降级恢复：ComfyUI 显存没卸干净时按更小的 --kv-capacity 拉起
            cmd += ["-KvCapacity", str(kv_capacity)]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=ENGINE_CONTROL_CWD,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            creationflags=getattr(__import__("subprocess"), "CREATE_NO_WINDOW", 0),
        )
    except FileNotFoundError as exc:
        raise DrawFailed("找不到 engine-control.ps1") from exc
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return -1, "脚本超时"
    return proc.returncode, (out + err).decode("utf-8", "replace")[-400:]


async def release_chat_engine() -> bool:
    cfg = backend()
    control = cfg.get("engineControl") or {}
    if not os.path.isfile(ENGINE_CONTROL):
        raise DrawFailed("未配置 engine-control.ps1，无法在出图前释放显存（图会画不出来）")
    stop_wait = (float(control.get("stopWaitMs") or 30_000)) / 1000
    started = time.time()
    code, detail = await _run_engine_script("unload", stop_wait + 30)
    if code != 0:
        log("warn", f"engine unload 失败 code={code}：{detail}")
        audit_engine({"phase": "unload-failed", "owner": "qq_draw",
                      "ownerPid": os.getpid(), "reason": "MOSS 出图",
                      "code": code, "detail": detail})
        raise DrawFailed("请求卸载引擎失败，已放弃出图以免聊天模型回不来")
    deadline = time.time() + stop_wait
    while time.time() < deadline:
        if not await _engine_reachable():
            audit_engine({"phase": "unloaded", "owner": "qq_draw",
                          "ownerPid": os.getpid(), "reason": "MOSS 出图",
                          "stopMs": int((time.time() - started) * 1000)})
            # 明确写出代价：这段时间 QQ 收不到回复，恢复前都不会有模型。
            log("info", f"chat engine unloaded in {time.time() - started:.1f}s "
                        f"(owner=qq_draw pid={os.getpid()})；QQ 回复暂停，画完自动恢复")
            return True
        await asyncio.sleep(1)
    audit_engine({"phase": "unload-failed", "owner": "qq_draw",
                  "ownerPid": os.getpid(), "reason": "MOSS 出图",
                  "detail": f"引擎仍在监听（>{stop_wait:.0f}s）"})
    raise DrawFailed("引擎仍在运行，无法在出图前释放显存")


def _engine_control_accepts_extra_args() -> bool:
    """engine-control.ps1 是否已支持 -ExtraArgs 透传给 start-ninfer.ps1。

    那两个文件不归本模块维护，这里只探测，不假设；不支持就不传（传了会直接
    parameter-not-found 让整次恢复失败）。探测到支持后靠 launch.json 复核是否真生效。
    """
    try:
        text = Path(ENGINE_CONTROL).read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        return False
    return bool(re.search(r"\$ExtraArgs", text, re.I) and re.search(r"-\s*ExtraArgs", text, re.I))


def _launch_args() -> list[str]:
    """start-ninfer.ps1 最后一次写下的引擎 argv（launch.json），读不到返回空。"""
    try:
        data = json.loads((PENDING_RESTORE_MARKER.parent / "launch.json")
                          .read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return []
    args = data.get("args") if isinstance(data, dict) else None
    return [str(item) for item in args] if isinstance(args, list) else []


async def _run_restore_guarded(kv_capacity: int, stuck_sec: float,
                               ceiling: float, extra_args: str = "") -> tuple[int, str, bool]:
    """跑 restore 脚本，同时盯引擎健康与进展；连续 stuck_sec 无进展判卡住。

    extra_args 原样透传给 engine-control.ps1 -ExtraArgs（例如 --no-cuda-graph）。
    返回 (code, detail, stuck)。stuck=True 时脚本已连同子进程被杀，调用方应直接降级重试。
    """
    cmd = [
        "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
        "-ExecutionPolicy", "Bypass", "-File", ENGINE_CONTROL,
        "-Action", "restore",
        "-Owner", "qq_draw", "-OwnerPid", str(os.getpid()),
        "-Reason", "出图结束",
    ]
    if kv_capacity > 0:
        cmd += ["-KvCapacity", str(kv_capacity)]
    if extra_args:
        cmd += ["-ExtraArgs", extra_args]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=ENGINE_CONTROL_CWD,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            creationflags=getattr(__import__("subprocess"), "CREATE_NO_WINDOW", 0),
        )
    except FileNotFoundError as exc:
        raise DrawFailed("找不到 engine-control.ps1") from exc
    comm = asyncio.create_task(proc.communicate())
    started = time.time()
    health = False
    last_sig = await _engine_progress_snapshot()
    last_progress = time.time()
    while not comm.done():
        if await _engine_ready(timeout=1.5):
            health = True
            break
        now = time.time()
        sig = await _engine_progress_snapshot()
        if sig != last_sig:
            last_sig = sig
            last_progress = now
        if now - last_progress >= stuck_sec:
            await _kill_tree(proc.pid)
            comm.cancel()
            return -1, f"卡住 {now - last_progress:.0f}s 无进展（engine.err.log/显存都没变化）", True
        if now - started >= ceiling:
            await _kill_tree(proc.pid)
            comm.cancel()
            return -1, f"超过 {ceiling:.0f}s 硬上限仍未就绪", True
        await asyncio.sleep(2)
    if health and not comm.done():
        try:
            out, err = await asyncio.wait_for(asyncio.shield(comm), timeout=10)
        except asyncio.TimeoutError:
            # 引擎已就绪，脚本只是在收尾：不能 kill 进程树，否则会把刚起来的引擎一起带走
            return 0, "引擎已就绪；脚本仍在收尾（未终止）", False
    elif comm.done():
        out, err = comm.result()
    else:
        out, err = b"", b""
    detail = (out + err).decode("utf-8", "replace")[-400:]
    if health:
        return 0, detail or "health ok", False
    return (proc.returncode or 0), detail, False


async def restore_chat_engine(kv_capacity: int = 0, extra_args: str = "") -> bool:
    cfg = backend()
    control = cfg.get("engineControl") or {}
    ready_timeout = float(os.environ.get("QQ_ENGINE_READY_TIMEOUT") or control.get("readyTimeoutMs") or 600_000) / 1000
    stuck = _no_progress_sec()
    ceiling = _hard_ceiling_sec()
    log(
        "info",
        "restoring chat engine via engine-control.ps1 restore"
        + (f"（降级 kv-capacity={kv_capacity}）" if kv_capacity > 0 else "")
        + (f"（额外参数 {extra_args}）" if extra_args else "")
        + f"（{stuck:.0f}s 无进展判卡住，硬上限 {ceiling:.0f}s）",
    )
    started = time.time()
    code, detail, stuck_hit = await _run_restore_guarded(kv_capacity, stuck, ceiling, extra_args)
    if stuck_hit:
        alive = await _engine_process_alive()
        killed = await _kill_stuck_engine() if alive else False
        # 连 supervisor 一起停：否则它用第一次的 argv 抢先重启，第二次永远轮不到
        sup_pid, sup_killed = await _kill_supervisor()
        if sup_killed:
            await asyncio.sleep(1.0)
            if await _engine_process_alive():
                killed = (await _kill_stuck_engine()) or killed
        audit_engine({"phase": "restore-stuck", "owner": "qq_draw",
                      "ownerPid": os.getpid(), "reason": "出图结束",
                      "waitedMs": int((time.time() - started) * 1000),
                      "kvCapacity": kv_capacity, "noProgressSec": stuck,
                      "extraArgs": extra_args,
                      "engineProcessAlive": alive, "engineKilled": killed,
                      "supervisorPid": sup_pid, "supervisorKilled": sup_killed,
                      "detail": detail})
        log("error", f"restore 判卡住：{detail}；已终止等待"
                     + ("，并清掉卡在初始化的引擎进程" if killed else ""))
        return False
    if code != 0:
        log("error", f"restore 脚本失败 code={code}：{detail}")
        # 脚本已经退出且进程不在 = start-ninfer 放弃了。此时再等满 ready_timeout
        # 就是 03:37–03:55 那种白等 10 分钟，必须先快速失败让上层降级重试。
        if not await _engine_ready() and not await _engine_process_alive():
            audit_engine({"phase": "restore-failed", "owner": "qq_draw",
                          "ownerPid": os.getpid(), "reason": "出图结束",
                          "waitedMs": int((time.time() - started) * 1000),
                          "kvCapacity": kv_capacity, "extraArgs": extra_args,
                          "detail": detail, "fastFail": True})
            log("error", "chat engine restore failed fast（脚本已放弃、进程不在，不再空等）")
            return False
    # 脚本已退出：只要 engine.err.log / 显存还在变就继续等，连续 stuck 秒没进展才判失败
    last_sig = await _engine_progress_snapshot()
    last_progress = time.time()
    next_notice = time.time() + 15
    while time.time() - started < ceiling:
        if await _engine_ready():
            audit_engine({"phase": "restored", "owner": "qq_draw",
                          "ownerPid": os.getpid(), "reason": "出图结束",
                          "kvCapacity": kv_capacity, "extraArgs": extra_args,
                          # 脚本可能因 LOCK BUSY（上一轮启动还在飞行）非 0 退出，
                          # 但引擎确实起来了；把退出码留下，别把这种情况写成「脚本成功」
                          "scriptCode": code,
                          "readyMs": int((time.time() - started) * 1000)})
            log("info", f"chat engine restored in {time.time() - started:.1f}s；QQ 回复恢复"
                        + (f"（restore 脚本 code={code}，引擎由在飞的启动拉起）" if code != 0 else ""))
            return True
        sig = await _engine_progress_snapshot()
        if sig != last_sig:
            last_sig = sig
            last_progress = time.time()
        if time.time() - last_progress >= stuck:
            log("error", f"chat engine 连续 {stuck:.0f}s 无进展（日志/显存不变），判失败")
            break
        if time.time() >= next_notice:
            log("info", "chat engine still loading")
            next_notice = time.time() + 15
        await asyncio.sleep(1)
    alive = await _engine_process_alive()
    killed = await _kill_stuck_engine() if alive else False
    audit_engine({"phase": "restore-failed", "owner": "qq_draw",
                  "ownerPid": os.getpid(), "reason": "出图结束",
                  "kvCapacity": kv_capacity, "extraArgs": extra_args,
                  "waitedMs": int((time.time() - started) * 1000), "detail": detail,
                  "engineProcessAlive": alive, "engineKilled": killed,
                  "fastFail": True, "noProgressSec": stuck,
                  "hardCeilingSec": ceiling, "readyTimeoutSec": ready_timeout})
    log("error", "chat engine did not become ready（无进展或到硬上限）"
                 + ("；已清掉卡住的引擎进程" if killed else ""))
    return False


# --------------------------------------------------------------------------- #
# TTS 让路（tts-yield.ps1）
#
# 顺序有硬约束：引擎卸载后 → TTS release → 出图 → 引擎 restore 成功 → TTS restore。
# 反过来先拉 TTS 会 CUDA OOM：实测只余 362 MiB 时端口能起、首次 /voice 直接 OOM（脚本 exit 11）。
# 两个方向都不许影响出图：release 失败只记账继续画；restore 失败记账后交给外层，不抛。
# --------------------------------------------------------------------------- #
async def _free_mb_stable(max_wait: float = 10.0) -> tuple[int, int]:
    """读可用显存，等它不再上涨再返回 (freeMb, waitedMs)。

    ComfyUI 的 `/free` 返回 200 时显存还没释放完（异步），立刻读会把「正在释放」
    当成「被占用」，于是满配被误判成不够、直接降级。连续两次涨幅 <128 MiB 视为稳定。
    """
    started = time.time()
    last = await _gpu_free_mb()
    if last <= 0:
        return last, 0
    while time.time() - started < max_wait:
        await asyncio.sleep(1.5)
        current = await _gpu_free_mb()
        if current <= 0:
            return current, int((time.time() - started) * 1000)
        if current - last < 128:
            return current, int((time.time() - started) * 1000)
        last = current
    return last, int((time.time() - started) * 1000)


async def _run_tts_yield(mode: str) -> tuple[int, str, int]:
    """跑 tts-yield.ps1；返回 (code, detail, elapsedMs)。找不到脚本按失败处理。"""
    if not os.path.isfile(TTS_YIELD):
        return -1, f"找不到 {TTS_YIELD}", 0
    timeout = 120.0 if mode == "release" else 420.0
    cmd = [
        "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
        "-ExecutionPolicy", "Bypass", "-File", TTS_YIELD, "-Mode", mode,
    ]
    started = time.time()
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            creationflags=getattr(__import__("subprocess"), "CREATE_NO_WINDOW", 0),
        )
    except FileNotFoundError:
        return -1, "powershell.exe 不在 PATH", 0
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return -1, f"脚本超过 {timeout:.0f}s 未退出", int((time.time() - started) * 1000)
    return (proc.returncode or 0), (out + err).decode("utf-8", "replace")[-400:], int((time.time() - started) * 1000)


async def yield_tts_for_draw() -> bool:
    """出图前把 TTS 显存让出来；失败只记一笔，绝不影响继续出图。"""
    before = await _gpu_free_mb()
    code, detail, elapsed = await _run_tts_yield("release")
    after = await _gpu_free_mb()
    ok = code == 0
    audit_engine({"phase": "tts-released" if ok else "tts-release-failed",
                  "owner": "qq_draw", "ownerPid": os.getpid(),
                  "reason": "MOSS 出图让路", "code": code,
                  "elapsedMs": elapsed, "freeMbBefore": before, "freeMbAfter": after,
                  # 成功时 TTS 是「被让路」而不是坏掉；失败时状态未知，不要写成可用
                  "ttsAvailable": False if ok else None,
                  "intent": "tts-yielded-for-draw" if ok else "release-failed-draw-continues",
                  "detail": (detail.rstrip() or "ok") if ok else detail})
    if ok:
        log("info", f"TTS 已让路（{elapsed / 1000:.1f}s，可用显存 {before}→{after} MiB）；"
                    "出图窗口内 TTS 不可用是人为让路，不是故障")
    else:
        log("warn", f"TTS release 失败 code={code}（{elapsed / 1000:.1f}s），跳过让路继续出图：{detail}")
    return ok


async def restore_tts_after_draw() -> bool:
    """引擎恢复成功后把 TTS 拉回来。失败只写审计交给外层，不让异常盖住真正的出图错误。"""
    before = await _gpu_free_mb()
    code, detail, elapsed = await _run_tts_yield("restore")
    after = await _gpu_free_mb()
    ok = code == 0
    audit_engine({"phase": "tts-restored" if ok else "tts-restore-failed",
                  "owner": "qq_draw", "ownerPid": os.getpid(),
                  "reason": "出图结束", "code": code,
                  "elapsedMs": elapsed, "freeMbBefore": before, "freeMbAfter": after,
                  "ttsAvailable": ok,
                  "intent": "tts-restored" if ok else "tts-left-yielded-needs-outer",
                  "detail": detail})
    if ok:
        log("info", f"TTS 已恢复（{elapsed / 1000:.1f}s，可用显存 {before}→{after} MiB）")
    else:
        log("error", f"TTS restore 失败 code={code}（{elapsed / 1000:.1f}s）：{detail}；"
                     "TTS 保持不可用，已写 tts-restore-failed 审计交给外层")
    return ok


# --------------------------------------------------------------------------- #
# 生成
# --------------------------------------------------------------------------- #
async def generate_image(options: dict[str, Any], *, on_ready=None, on_image=None) -> dict[str, Any]:
    prompt = str(options.get("prompt") or "").strip()
    if prompt == "":
        raise DrawFailed("画面描述不能为空")
    if len(prompt) > 1200:
        raise DrawFailed("画面描述太长（最多 1200 字符）")
    aspect = str(options.get("aspect") or "1:1")
    if aspect not in ASPECT_RATIOS:
        aspect = "1:1"
    await ensure_comfy()
    if await queue_busy():
        raise DrawBusy("ComfyUI 正在跑别的任务（可能是长视频），等它跑完再画")
    lease = acquire_lease(owner="qq_draw", reason="MOSS 出图", ttl_ms=15 * 60_000)
    if not lease.get("ok"):
        busy = lease.get("lease") or {}
        suffix = f"（{busy.get('reason')}）" if busy.get("reason") else ""
        raise DrawBusy("显卡正在被占用" + suffix + "，等这次结束再画")
    started_at = time.time()
    built = build_workflow({**options, "aspect": aspect})
    outcome: dict[str, Any] | None = None
    restored = False
    switched = False
    submitted = False
    paused_at = 0.0
    tts_yielded = False
    guard: asyncio.Task | None = None
    try:
        switched = True
        try:
            if callable(on_ready):
                on_ready()
        except Exception:
            pass
        await release_chat_engine()
        paused_at = time.time()
        # 引擎已卸载，再把 TTS 的 ~1.3 GiB 也让出去；失败只记账，照常出图
        try:
            tts_yielded = await yield_tts_for_draw()
        except Exception as exc:  # noqa: BLE001
            log("warn", f"TTS release 异常（不影响出图，继续画）: {exc}")

        async def _guard() -> None:
            while True:
                await asyncio.sleep(10)
                # 外部引擎无法同步探测驻留状态；这里只在服务意外可达时重新释放。
                if await _engine_reachable(timeout=1.0):
                    log("warn", "chat engine reappeared during generation; releasing again")
                    try:
                        await release_chat_engine()
                    except Exception:
                        pass

        guard = asyncio.create_task(_guard())
        log(
            "info",
            f"MOSS submit {built['width']}x{built['height']} steps={built['steps']} seed={built['seed']}",
        )
        submitted = True
        result = await submit_and_wait(built["workflow"], timeout=180.0)
        image = result["image"]
        source = COMFY_OUTPUT / str(image.get("subfolder") or "") / str(image.get("filename") or "")
        if not source.is_file() or source.stat().st_size <= 0:
            raise DrawFailed("生成的图片是空文件")
        GENERATED_DIR.mkdir(parents=True, exist_ok=True)
        target = GENERATED_DIR / f"draw_{int(time.time() * 1000)}_{built['seed']}.png"
        shutil.copyfile(source, target)
        outcome = {
            "path": str(target),
            "width": built["width"],
            "height": built["height"],
            "seed": built["seed"],
            "steps": built["steps"],
            "style": built["style"],
            "aspect": aspect,
            "seconds": int(time.time() - started_at),
            "bytes": source.stat().st_size,
        }
        try:
            if callable(on_image):
                on_image(outcome)
        except Exception:
            pass
    finally:
        if guard is not None:
            guard.cancel()
        # 必须先让 ComfyUI 卸模型再拉引擎：03:37–03:55 实测 ComfyUI 仍占显存时
        # 引擎报 requires 7295135744 bytes / available 7201619968，连退 5 次。
        # 所以无论有没有提交成功（排队失败、ComfyUI 报错也算）都要先 /free。
        try:
            await free_comfy_vram("after draw")
        except Exception as exc:  # noqa: BLE001
            log("warn", f"ComfyUI /free 异常（不影响恢复）: {exc}")
        if switched:
            failures: list[str] = []
            # /free 是异步释放：返回 200 时显存还在回落，立刻读会把「正在释放」
            # 当成「被占用」（10:29 那轮读到 3332 MiB，1.8 秒后实际 15268 MiB），
            # 于是 86,016 被误判成不够、直接降级。这里等释放曲线走平再判定。
            free_mb, stable_ms = await _free_mb_stable()
            skip_full = 0 < free_mb < ENGINE_REQUIRED_MB
            audit_engine({"phase": "restore-precheck", "owner": "qq_draw",
                          "ownerPid": os.getpid(), "freeMb": free_mb,
                          "requiredMb": ENGINE_REQUIRED_MB, "waitedMs": stable_ms,
                          "skipFull": skip_full,
                          "kvCapacity": DEGRADED_KV_CAPACITY if skip_full else 0})
            if skip_full:
                log("warn", f"恢复前可用显存 {free_mb} MiB < 满配需要 {ENGINE_REQUIRED_MB} MiB，"
                            f"（等待释放 {stable_ms} ms 后仍不足）跳过满配直接降级")
            for attempt in (1, 2):
                capacity = DEGRADED_KV_CAPACITY if (attempt > 1 or skip_full) else 0
                extra = ""
                try:
                    if attempt > 1:
                        # 第一次起不来多半仍是显存没放干净：再压一次 ComfyUI，
                        # 并按降级容量拉起，避免同一块显存重试 5 次还是失败。
                        await free_comfy_vram("before restore retry")
                        # 重试不再等 CUDA graph 捕获：同显存下带 --no-cuda-graph
                        # 冷启动 63.7s → 8.5s（引擎侧实测），代价是解码吞吐 ~-8%。
                        if _engine_control_accepts_extra_args():
                            extra = "--no-cuda-graph"
                        audit_engine({"phase": "restore-retry", "owner": "qq_draw",
                                      "ownerPid": os.getpid(), "attempt": attempt,
                                      "kvCapacity": capacity,
                                      "noCudaGraph": bool(extra), "extraArgs": extra,
                                      "prevFailure": failures[-1] if failures else "",
                                      "detail": "第一次恢复判失败，/free 后按降级容量重试"
                                                + ("（带 --no-cuda-graph）" if extra else
                                                   "；engine-control.ps1 尚未透传 -ExtraArgs，"
                                                   "本次无法带 --no-cuda-graph")})
                        if not extra:
                            log("warn", "engine-control.ps1 未透传 -ExtraArgs，重试无法带 --no-cuda-graph，"
                                        "冷启动仍会卡在 CUDA graph 捕获")
                    restored = await restore_chat_engine(kv_capacity=capacity, extra_args=extra)
                    if extra:
                        applied = "--no-cuda-graph" in _launch_args()
                        audit_engine({"phase": "restore-retry-applied", "owner": "qq_draw",
                                      "ownerPid": os.getpid(), "attempt": attempt,
                                      "noCudaGraph": applied,
                                      "detail": ("launch.json 已带 --no-cuda-graph"
                                                 if applied else
                                                 "已传 -ExtraArgs 但 launch.json 没有该参数：透传没生效")})
                        if not applied:
                            log("warn", "已传 -ExtraArgs --no-cuda-graph，但 launch.json 未包含该参数："
                                        "参数在 engine-control.ps1 里被丢掉了")
                except Exception as exc:  # noqa: BLE001
                    log("error", f"restore 第 {attempt} 次抛异常: {exc}")
                    restored = False
                if restored:
                    break
                failures.append(f"attempt{attempt}(kv={capacity}) failed")
                if attempt == 1:
                    log("warn", f"chat model reload failed; retrying in 3s with "
                                f"degraded kv-capacity={DEGRADED_KV_CAPACITY}")
                    await asyncio.sleep(3)
            if paused_at:
                if restored:
                    log("info", f"QQ 回复恢复：出图中断 {time.time() - paused_at:.1f}s（engine restore OK）")
                else:
                    engine_alive = await _engine_process_alive()
                    engine_ready = await _engine_ready()
                    engine_state = ("ready" if engine_ready
                                    else "starting" if engine_alive else "unloaded")
                    marker = PENDING_RESTORE_MARKER.is_file()
                    log("error", f"QQ 回复仍未恢复（已中断 {time.time() - paused_at:.1f}s）；"
                                 f"引擎状态={engine_state}，pending 标记={marker}；"
                                 "engine-restore-watchdog 会兜底重启")
                    audit_engine({"phase": "restore-exhausted", "owner": "qq_draw",
                                  "ownerPid": os.getpid(), "reason": "finally 两次都失败",
                                  "failures": failures,
                                  "pausedSec": int(time.time() - paused_at),
                                  "engineState": engine_state,
                                  "pendingRestoreMarker": marker,
                                  "qqReply": "down",
                                  "detail": "引擎为出图卸载后两次恢复都失败（第一次满配、"
                                            "第二次降级 kv-capacity=" f"{DEGRADED_KV_CAPACITY}）；"
                                            "QQ 没有回复是因为当前没有可用聊天模型。"
                                            + ("pending 标记在，engine-restore-watchdog 会继续拉起。"
                                               if marker else
                                               "pending 标记缺失，需人工执行 engine-control restore。")})
        # 顺序不能反：引擎恢复成功之后再拉 TTS。引擎没起来时显存不够，
        # TTS 拉起会「端口起得来但首次 /voice CUDA OOM」（实测只剩 362 MiB，脚本 exit 11）。
        if tts_yielded:
            if restored:
                try:
                    await restore_tts_after_draw()
                except Exception as exc:  # noqa: BLE001
                    # 不让 TTS 的异常盖住真正的出图错误 / 恢复结果
                    log("error", f"TTS restore 异常（已记审计，不影响出图结果）: {exc}")
            else:
                audit_engine({"phase": "tts-restore-skipped", "owner": "qq_draw",
                              "ownerPid": os.getpid(), "reason": "引擎恢复失败",
                              "intent": "tts-left-yielded-needs-outer",
                              "detail": "引擎没恢复成功，不逆序拉起 TTS（显存不足会 CUDA OOM）；"
                                        "需在引擎恢复后由外层/守护执行 tts-yield.ps1 -Mode restore"})
                log("error", "TTS 保持让路态：引擎未恢复，未执行 restore（见 tts-restore-skipped 审计）")
        try:
            release_lease(str((lease.get("lease") or {}).get("id")))
        except Exception as exc:  # noqa: BLE001
            log("warn", f"release lease 异常: {exc}")
    if outcome is None:
        raise DrawFailed("没有生成出图片")
    outcome["restored"] = restored
    return outcome


# --------------------------------------------------------------------------- #
# 审图
# --------------------------------------------------------------------------- #
def _prepare_png(path: str) -> bytes | None:
    try:
        from PIL import Image
        import io

        with Image.open(path) as im:
            im.seek(0)
            im = im.convert("RGB")
            im.thumbnail((768, 768))
            buf = io.BytesIO()
            im.save(buf, format="PNG", compress_level=9)
            return buf.getvalue()
    except Exception:
        return None


def _extract_json(text: str) -> dict[str, Any] | None:
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        value = json.loads(text[start : end + 1])
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _normalize_verdict(parsed: dict[str, Any]) -> dict[str, Any]:
    fields: dict[str, bool] = {}
    missing = False
    for name in FIELDS:
        if isinstance(parsed.get(name), bool):
            fields[name] = bool(parsed[name])
        else:
            fields[name] = False
            missing = True
    try:
        score = max(0, min(100, round(float(parsed.get("score")))))
    except (TypeError, ValueError):
        score = 0
    defects = [re.sub(r"\s+", " ", str(item)).strip() for item in (parsed.get("defects") or [])]
    defects = [item for item in defects if item][:8]
    passed = (not missing) and all(fields[name] for name in FIELDS) and score >= 60
    if not passed and not defects:
        defects = [FIELD_LABEL[name] + "不合格" for name in FIELDS if fields[name] is False]
        if not defects:
            defects = ["评分表不完整" if missing else f"总分偏低（{score}）"]
    return {"fields": fields, "score": score, "defects": defects, "verdict": "pass" if passed else "fail"}


def _append_review(record: dict[str, Any]) -> None:
    try:
        REVIEW_LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(REVIEW_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        pass


async def _call_review(png: bytes, prompt: str, timeout: float = 20.0) -> dict[str, Any]:
    import aiohttp
    import base64

    data_url = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
    messages = [
        {"role": "system", "content": REVIEW_SYSTEM + "\n\n" + REVIEW_RUBRIC},
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "画面描述（只作参考，不要被它带偏）：" + (prompt[:400] if prompt else "（无）")
                    + "\n\n按评分表看这张图，只输出 JSON。",
                },
                {"type": "image_url", "image_url": {"url": data_url}},
            ],
        },
    ]
    cfg = backend()
    url = str(cfg.get("baseUrl") or "").rstrip("/") + "/chat/completions"
    headers = {"Content-Type": "application/json"}
    if cfg.get("apiKey"):
        headers["Authorization"] = f"Bearer {cfg['apiKey']}"
    payload = {
        "model": cfg.get("model") or "local",
        "messages": messages,
        "max_tokens": 200,
        "temperature": 0.0,
        "top_p": 0.1,
        "stream": False,
    }
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as session:
        async with session.post(url, json=payload, headers=headers) as resp:
            raw = await resp.text()
            if resp.status >= 400:
                raise RuntimeError(f"review upstream status {resp.status} body={raw[:300]}")
    try:
        data = json.loads(raw)
        text = str(data["choices"][0]["message"]["content"])
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise RuntimeError("review 返回格式异常") from exc
    parsed = _extract_json(text)
    if parsed is None:
        raise RuntimeError("review 返回不是 JSON：" + re.sub(r"\s+", " ", text)[:300])
    return {**_normalize_verdict(parsed), "raw": text[:600]}


def _is_timeout(exc: BaseException) -> bool:
    return isinstance(exc, asyncio.TimeoutError) or "timeout" in str(exc).lower()


async def review_image(path: str, prompt: str = "", attempt: int = 1) -> dict[str, Any]:
    global _REVIEW_WAITING
    started = time.time()
    base = {
        "id": f"{int(started * 1000)}-{attempt}",
        "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "attempt": attempt,
        "path": path,
        "prompt": (prompt or "")[:300],
    }
    if _REVIEW_WAITING >= MAX_REVIEW_QUEUE:
        record = {**base, "reviewMs": 0, "verdict": "failed", "decision": "failed", "reason": f"审图队列已满（{MAX_REVIEW_QUEUE}），本次没审成"}
        _append_review(record)
        return record
    _REVIEW_WAITING += 1
    try:
        async with _REVIEW_LOCK:
            try:
                with open(path, "rb") as f:
                    raw = f.read()
            except OSError as exc:
                record = {**base, "reviewMs": int((time.time() - started) * 1000), "verdict": "failed", "decision": "failed", "reason": f"图片读不到：{exc}"}
                _append_review(record)
                return record
            sha256 = hashlib.sha256(raw).hexdigest()
            if len(raw) > MAX_IMAGE_BYTES:
                record = {**base, "sha256": sha256, "bytes": len(raw), "reviewMs": 0, "verdict": "failed", "decision": "failed", "reason": f"图片超过 {MAX_IMAGE_BYTES} 字节，跳过审图"}
                _append_review(record)
                return record
            png = _prepare_png(path)
            if png is None:
                record = {**base, "sha256": sha256, "bytes": len(raw), "reviewMs": 0, "verdict": "failed", "decision": "failed", "reason": "图片格式无法解码"}
                _append_review(record)
                return record
            errors: list[dict[str, Any]] = []
            review: dict[str, Any] | None = None
            for index in range(3):
                try:
                    review = await _call_review(png, prompt)
                    break
                except Exception as exc:
                    timed_out = _is_timeout(exc)
                    errors.append({
                        "call": index + 1,
                        "timeout": timed_out,
                        "reason": str(exc)[:300],
                        "ms": int((time.time() - started) * 1000),
                    })
                    if timed_out or index >= 2:
                        break
                    await asyncio.sleep(0.8 * (index + 1))
            review_ms = int((time.time() - started) * 1000)
            if review is not None:
                record = {
                    **base, "sha256": sha256, "bytes": len(raw), "scaled": len(png),
                    "reviewMs": review_ms, "score": review["score"], "fields": review["fields"],
                    "defects": review["defects"], "verdict": review["verdict"],
                    "decision": "pass" if review["verdict"] == "pass" else "blocked",
                    "reviewCalls": len(errors) + 1, "raw": review.get("raw", ""),
                }
                _append_review(record)
                return record
            timed_out = bool(errors) and all(item["timeout"] for item in errors)
            last = errors[-1] if errors else {"reason": "unknown"}
            record = {
                **base, "sha256": sha256, "bytes": len(raw), "scaled": len(png),
                "reviewMs": review_ms,
                "verdict": "unknown" if timed_out else "failed",
                "decision": "pass-timeout" if timed_out else "failed",
                "degraded": "timeout" if timed_out else None,
                "reviewCalls": len(errors),
                "reason": last.get("reason", "unknown"),
                "errors": errors,
            }
            _append_review(record)
            return record
    finally:
        _REVIEW_WAITING -= 1


def defect_tags(defects: list[str], fields: dict[str, bool]) -> dict[str, list[str]]:
    positive: list[str] = []
    negative: list[str] = []

    def add(pos: list[str], neg: list[str]) -> None:
        positive.extend(pos)
        negative.extend(neg)

    if fields.get("hands_ok") is False:
        add(["perfect hands", "five fingers"], ["extra fingers", "missing fingers", "fused fingers", "malformed hands"])
    if fields.get("limbs_ok") is False:
        add(["correct anatomy"], ["extra limbs", "missing limbs", "twisted limbs", "deformed body"])
    if fields.get("face_ok") is False:
        add(["detailed symmetric face", "clear eyes"], ["deformed face", "asymmetric eyes", "broken face"])
    if fields.get("text_ok") is False:
        add([], ["text", "watermark", "signature", "logo", "garbled letters"])
    if fields.get("composition_ok") is False:
        add(["full scene", "centered subject", "sharp focus"], ["empty background", "cropped subject", "blurry"])
    if fields.get("noise_ok") is False:
        add(["clean image", "smooth shading"], ["noise", "jpeg artifacts", "banding", "color blotches"])
    if not positive and not negative and defects:
        add(["best quality", "correct anatomy"], ["bad anatomy", "blurry", "low quality"])
    return {"positive": list(dict.fromkeys(positive)), "negative": list(dict.fromkeys(negative))}


async def draw_with_review(
    prompt: str,
    options: dict[str, Any],
    *,
    on_ready=None,
    on_image=None,
    attempt_limit: int = 2,
) -> dict[str, Any]:
    records: list[dict[str, Any]] = []
    current_prompt = prompt
    current_negative = str(options.get("negative") or "")
    result: dict[str, Any] | None = None
    for attempt in range(1, max(1, attempt_limit) + 1):
        result = await generate_image(
            {**options, "prompt": current_prompt, "negative": current_negative},
            on_ready=on_ready if attempt == 1 else None,
            on_image=on_image,
        )
        log("info", f"draw attempt {attempt} done in {result.get('seconds')}s: {result.get('path')}")
        record = await review_image(str(result.get("path")), current_prompt, attempt)
        records.append(record)
        if record["decision"] in ("pass", "pass-timeout"):
            log(
                "info",
                f"draw review pass attempt={attempt} score={record.get('score', '—')}"
                + (" degraded=timeout" if record.get("degraded") == "timeout" else ""),
            )
            return {
                "pass": True,
                "degraded": record.get("degraded"),
                "result": result,
                "review": record,
                "attempts": attempt,
                "records": records,
            }
        if record["decision"] == "failed":
            log("warn", f"draw review failed attempt={attempt} reason={record.get('reason')}")
            return {
                "pass": False,
                "reviewFailed": True,
                "result": result,
                "review": record,
                "attempts": attempt,
                "records": records,
            }
        tags = defect_tags(record.get("defects") or [], record.get("fields") or {})
        if attempt < attempt_limit:
            log(
                "warn",
                "draw review blocked attempt="
                + str(attempt)
                + f" score={record.get('score')} defects={'；'.join(record.get('defects') or [])} → 重画一次",
            )
            current_prompt = ", ".join([prompt, *tags["positive"]]).strip(", ")
            current_negative = ", ".join([str(options.get("negative") or ""), *tags["negative"]]).strip(", ")
        else:
            log("warn", f"draw review blocked attempt={attempt} → 丢弃，不发送")
    last = records[-1] if records else {}
    _append_review({
        "id": last.get("id"),
        "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "event": "summary",
        "attempt": len(records),
        "path": (result or {}).get("path") or last.get("path") or "",
        "score": last.get("score"),
        "defects": last.get("defects") or [],
        "verdict": "fail",
        "decision": last.get("decision") or "blocked",
        "reason": "重画一次仍未过审，丢弃不发送",
    })
    return {"pass": False, "result": None, "review": last, "attempts": len(records), "records": records}


# --------------------------------------------------------------------------- #
# 账本与待审队列
# --------------------------------------------------------------------------- #
def record_draw(patch: dict[str, Any]) -> None:
    try:
        previous = read_json(UNSENT_DRAW, {})
        if not isinstance(previous, dict):
            previous = {}
        nxt = {**previous, **patch, "updatedAt": int(time.time() * 1000)}
        if patch.get("path") is not None and patch.get("path") != previous.get("path"):
            nxt["createdAt"] = int(time.time() * 1000)
        write_json_atomic(UNSENT_DRAW, nxt)
    except OSError:
        pass


def read_unsent_draw(now_ms: int | None = None, ttl_ms: int = 30 * 60_000) -> dict[str, Any] | None:
    record = read_json(UNSENT_DRAW, None)
    if not isinstance(record, dict):
        return None
    repostable = record.get("status") == "generated" or (
        record.get("status") == "queued" and record.get("queueId") is None
    )
    if not repostable or not record.get("path"):
        return None
    try:
        updated = int(record.get("updatedAt") or record.get("createdAt") or 0)
    except (TypeError, ValueError):
        return None
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    if now - updated > ttl_ms or now - updated < 0:
        return None
    return record


def _load_queue() -> dict[str, Any]:
    state = read_json(IMAGE_QUEUE, None)
    if not isinstance(state, dict):
        state = {}
    items = [item for item in (state.get("items") or []) if isinstance(item, dict)]
    next_id = state.get("nextId")
    if not isinstance(next_id, int) or next_id <= 0:
        next_id = len(items) + 1
    return {"nextId": next_id, "items": items}


def _save_queue(state: dict[str, Any]) -> None:
    write_json_atomic(IMAGE_QUEUE, state)


def _prune_queue(state: dict[str, Any]) -> None:
    now = int(time.time() * 1000)
    kept = []
    for item in state["items"]:
        try:
            age = now - int(time.mktime(time.strptime(str(item.get("createdAt"))[:19], "%Y-%m-%dT%H:%M:%S")) * 1000)
        except (ValueError, OverflowError):
            continue
        if item.get("status") == "pending":
            if age < 7 * 24 * 3600_000:
                kept.append(item)
        elif age < 3 * 24 * 3600_000:
            kept.append(item)
    state["items"] = kept[-60:]


def add_pending(record: dict[str, Any]) -> dict[str, Any]:
    state = _load_queue()
    _prune_queue(state)
    item = {
        "id": state["nextId"],
        "status": "pending",
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "chatId": str(record.get("chatId") or ""),
        "requester": str(record.get("requester") or ""),
        "requesterQq": str(record.get("requesterQq") or ""),
        "prompt": str(record.get("prompt") or "")[:500],
        "path": str(record.get("path") or ""),
        "width": int(record.get("width") or 0),
        "height": int(record.get("height") or 0),
        "style": str(record.get("style") or ""),
    }
    state["nextId"] = item["id"] + 1
    state["items"].append(item)
    _save_queue(state)
    return item


def list_pending() -> list[dict[str, Any]]:
    state = _load_queue()
    _prune_queue(state)
    return [item for item in state["items"] if item.get("status") == "pending"]


def get_pending(item_id: Any) -> dict[str, Any] | None:
    state = _load_queue()
    _prune_queue(state)
    for item in state["items"]:
        if item.get("id") == int(item_id):
            return item
    return None


def resolve_pending(item_id: Any, status: str) -> dict[str, Any] | None:
    state = _load_queue()
    for item in state["items"]:
        if item.get("id") == int(item_id):
            item["status"] = "approved" if status == "approved" else "rejected"
            item["resolvedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
            _save_queue(state)
            return item
    return None


def discard_image(path: str) -> bool:
    try:
        resolved = Path(path).resolve()
        root = MEDIA_DIR.resolve()
        if root not in resolved.parents:
            return False
        if not resolved.is_file():
            return False
        resolved.unlink()
        return True
    except (OSError, ValueError):
        return False
