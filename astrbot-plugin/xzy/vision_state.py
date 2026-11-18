"""视觉环境观察：旧栈 `vision.mjs` 的 Python 版。

口径（与旧栈一致）：
- 只存一句话观察，不存图片副本；滚动 40 条 / 60 分钟；
- 注入取 30 分钟内最多 3 条；
- 最小间隔 8s、队列 32、单图 8MB；
- 失败只写 `audit/vision.jsonl`，不影响回合。
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Awaitable, Callable

logger = logging.getLogger("astrbot")

PROMPT = (
    "用一句话描述这张图里发生了什么，只写观察，不评价、不猜测人物身份，"
    "不超过 40 个汉字。"
)
INJECT_RETENTION_SEC = 30 * 60
STATE_RETENTION_SEC = 60 * 60
STATE_MAX = 40
INJECT_MAX = 3


def _ref_key(ref: str) -> str:
    return ref.strip()[:512]


def _as_image_ref(ref: str, max_bytes: int) -> str | None:
    """把入站引用折成 AstrBot provider 能吃的形式。

    provider 的 `resolve_image_part` 只认 http(s) / file:/// / base64:// / 本地路径，
    传 data: URI 会被当成文件路径 open() 而失败。
    """
    ref = (ref or "").strip()
    if not ref:
        return None
    low = ref.lower()
    if low.startswith(("http://", "https://", "base64://", "file:///")):
        return ref
    try:
        size = os.path.getsize(ref)
    except OSError:
        return None
    if max_bytes and size > max_bytes:
        return None
    return ref


class VisionState:
    def __init__(self, cfg: dict[str, Any], state_dir: str):
        self.cfg = cfg or {}
        self.state_dir = state_dir
        self.path = os.path.join(state_dir, "vision-state.json")
        self.audit_path = os.path.join(state_dir, "audit", "vision.jsonl")
        self.min_gap = float(self.cfg.get("minGapSec") or 8.0)
        self.max_bytes = int(self.cfg.get("maxBytes") or 8388608)
        self.queue_limit = int(self.cfg.get("queueLimit") or 32)
        self._last = 0.0
        self._queued = 0
        self._seen: dict[str, float] = {}

    # -- 读 --------------------------------------------------------------- #
    def _enabled(self) -> bool:
        return self.cfg.get("enabled") is not False

    def _read(self) -> list[dict[str, Any]]:
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                doc = json.load(fh)
        except FileNotFoundError:
            return []
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[xzy] vision-state 读取失败: {type(exc).__name__}: {exc}")
            return []
        entries = doc.get("entries") if isinstance(doc, dict) else doc
        return [e for e in (entries or []) if isinstance(e, dict)]

    def _write(self, entries: list[dict[str, Any]]) -> None:
        os.makedirs(self.state_dir, exist_ok=True)
        doc = {
            "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
            "entries": entries[-STATE_MAX:],
        }
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, ensure_ascii=False)
        os.replace(tmp, self.path)

    def _audit(self, record: dict[str, Any]) -> None:
        try:
            os.makedirs(os.path.dirname(self.audit_path), exist_ok=True)
            record = {"wall": time.strftime("%Y-%m-%d %H:%M:%S"), **record}
            with open(self.audit_path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[xzy] vision 审计写入失败: {type(exc).__name__}: {exc}")

    # -- 观察 ------------------------------------------------------------- #
    async def observe(
        self,
        image_ref: str,
        chat_id: str,
        caption: Callable[[str, str], Awaitable[str]],
    ) -> dict[str, Any]:
        if not self._enabled():
            return {"ok": False, "skipped": "disabled"}
        now = time.time()
        if now - self._last < self.min_gap:
            return {"ok": False, "skipped": "gap"}
        key = _ref_key(image_ref)
        if key in self._seen and now - self._seen[key] < STATE_RETENTION_SEC:
            return {"ok": False, "skipped": "dup"}
        if self._queued >= self.queue_limit:
            return {"ok": False, "skipped": "queue"}
        self._queued += 1
        try:
            url = _as_image_ref(image_ref, self.max_bytes)
            if not url:
                self._audit(
                    {"chat": chat_id, "source": image_ref, "result": "failed",
                     "error": "图片不可读或超过 8MB"}
                )
                return {"ok": False, "skipped": "unreadable"}
            text = (await caption(PROMPT, url) or "").strip()
            if not text:
                self._audit(
                    {"chat": chat_id, "source": image_ref, "result": "failed",
                     "error": "模型返回空"}
                )
                return {"ok": False, "skipped": "empty"}
            self._last = time.time()
            self._seen[key] = self._last
            entry = {
                "at": self._last,
                "wall": time.strftime("%Y-%m-%d %H:%M:%S"),
                "chatId": chat_id,
                "text": text,
                "source": "chat",
            }
            cutoff = self._last - STATE_RETENTION_SEC
            rows = [e for e in self._read() if float(e.get("at") or 0) >= cutoff]
            rows.append(entry)
            self._write(rows)
            self._audit({"chat": chat_id, "result": "ok", "text": text})
            return {"ok": True, "text": text}
        except Exception as exc:  # noqa: BLE001
            self._audit(
                {"chat": chat_id, "source": image_ref, "result": "failed",
                 "error": f"{type(exc).__name__}: {exc}"}
            )
            raise
        finally:
            self._queued -= 1

    # -- 注入 ------------------------------------------------------------- #
    def note(self, chat_id: str) -> str:
        if not self._enabled():
            return ""
        now = time.time()
        rows = [
            e for e in self._read()
            if now - float(e.get("at") or 0) <= INJECT_RETENTION_SEC
            and str(e.get("chatId") or "") == chat_id
        ][-INJECT_MAX:]
        if not rows:
            rows = [
                e for e in self._read()
                if now - float(e.get("at") or 0) <= INJECT_RETENTION_SEC
            ][-INJECT_MAX:]
        if not rows:
            return ""
        lines = "\n".join(f"- {e.get('text', '')}" for e in rows)
        return f"【最近看到的画面（你看到的，不必主动提）】\n{lines}"
