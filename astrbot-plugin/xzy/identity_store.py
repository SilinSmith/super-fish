"""身份索引（AstrBot 侧自有写入端，2026-11-15 拍板口径）。

与旧栈 `Y:\\dsh\\home\\qq-persona\\identity-index.jsonl` 不共享写入：旧栈那份只做
一次性导入（`source=legacy-import`），导入后不再读，也不回写。

存储
----
- 记录：`inst/data/xzy/identity/identity.jsonl`（追加写，一行一条）
- 导入标记：`inst/data/xzy/identity/legacy-import.json`（记源文件 mtime + 导入条数）
- 内存索引：启动时读一遍，按 `signature` 建索引；写时先追加，再更新内存

字段
----
| 字段 | 含义 |
|---|---|
| `id` | `ident_astrbot_<6hex>`，与旧栈 `ident_auto_*` 不混 |
| `identity` | 名字；空串表示未命名 |
| `display` | 展示名（未命名时为「未命名形象 #xxxx」） |
| `aliases` | 别名列表 |
| `signature` | 规范化特征串，去重主键 |
| `features` | hairColor/hairStyle/eyeColor/earType/proportion/palette/markers |
| `evidence` | `[{ref, material, at, source, frame?}]`，只存引用不存图片 |
| `confidence` | 0–1，按证据条数与来源给分 |
| `authority` | `heuristic`（自动） / `manual`（主人确认） |
| `status` | `pending` / `confirmed` / `rejected` |
| `origin` | `astrbot` / `legacy-import` |
| `seenGroups` | 出现过的群号（私聊不记） |
| `createdAt` / `updatedAt` | ISO 时间 |

写入时机
--------
1. 真实入站图片的视觉特征产出后调用 `observe()`（不在每条文字消息上写）。
2. 主人明确确认/改名 → `confirm()`，写 `authority=manual / status=confirmed`。
3. 旧栈一次性导入：`import_legacy()`，只跑一次，标记文件存在就跳过。
4. 同一 `signature` 再次出现只追加 evidence 并更新计数，不新增记录。

只读/无副作用：不 import AstrBot、不发消息、不读 8188/8299。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import time
from typing import Any

DEFAULT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "xzy", "identity")
FEATURE_KEYS = ("hairColor", "hairStyle", "eyeColor", "earType", "proportion", "palette", "markers")
MAX_LINES = 20000


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def signature_of(features: dict[str, Any]) -> str:
    parts = []
    for key in FEATURE_KEYS:
        values = features.get(key) or []
        if isinstance(values, str):
            values = [values]
        if values:
            parts.append(f"{key}:" + "|".join(str(item) for item in values))
    return ";".join(parts)


def _confidence(evidence: int, authority: str) -> float:
    if authority == "manual":
        return 0.95
    if evidence >= 3:
        return 0.8
    if evidence == 2:
        return 0.65
    return 0.5


class IdentityStore:
    def __init__(self, directory: str = DEFAULT_DIR) -> None:
        self.dir = os.path.abspath(directory)
        self.path = os.path.join(self.dir, "identity.jsonl")
        self.marker = os.path.join(self.dir, "legacy-import.json")
        self._by_signature: dict[str, dict[str, Any]] = {}
        self._lines = 0
        os.makedirs(self.dir, exist_ok=True)
        self._load()

    # ---------------------------------------------------------------- 读
    def _load(self) -> None:
        try:
            with open(self.path, "r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    self._lines += 1
                    try:
                        record = json.loads(line)
                    except ValueError:
                        continue
                    if record.get("status") == "rejected":
                        continue
                    self._by_signature[record.get("signature", "")] = record
        except OSError:
            pass

    def lookup(self, signature: str = "", limit: int = 5) -> list[dict[str, Any]]:
        if signature:
            record = self._by_signature.get(signature)
            return [record] if record else []
        records = sorted(self._by_signature.values(), key=lambda item: item.get("updatedAt", ""), reverse=True)
        return records[:limit]

    def stats(self) -> dict[str, Any]:
        pending = sum(1 for item in self._by_signature.values() if item.get("status") == "pending")
        return {
            "dir": self.dir,
            "records": len(self._by_signature),
            "pending": pending,
            "lines": self._lines,
            "legacy_imported": os.path.exists(self.marker),
        }

    # ---------------------------------------------------------------- 写
    def _append(self, record: dict[str, Any]) -> None:
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        self._lines += 1
        self._by_signature[record["signature"]] = record
        if self._lines > MAX_LINES:
            self.compact()

    def observe(
        self,
        features: dict[str, Any],
        evidence: dict[str, Any],
        *,
        group_id: str = "",
        source: str = "read_image",
        authority: str = "heuristic",
    ) -> dict[str, Any]:
        signature = signature_of(features)
        if not signature:
            raise ValueError("features 全空，无法生成 signature")
        stamp = _now()
        ref = str(evidence.get("ref") or evidence.get("material") or "")
        record = self._by_signature.get(signature)
        if record is None:
            record = {
                "id": "ident_astrbot_" + secrets.token_hex(3),
                "identity": "",
                "display": "未命名形象 #" + secrets.token_hex(2),
                "aliases": [],
                "signature": signature,
                "features": features,
                "evidence": [],
                "confidence": 0.5,
                "authority": authority,
                "status": "pending",
                "origin": "astrbot",
                "seenGroups": [],
                "createdAt": stamp,
                "updatedAt": stamp,
                "count": 0,
            }
        if ref and any(item.get("ref") == ref for item in record["evidence"]):
            return record
        if ref:
            record["evidence"].append({
                "ref": ref,
                "material": str(evidence.get("material") or ""),
                "at": evidence.get("at") or int(time.time() * 1000),
                "source": source,
                "frame": evidence.get("frame", ""),
            })
        record["count"] = int(record.get("count", 0)) + 1
        if group_id and group_id not in record["seenGroups"]:
            record["seenGroups"].append(group_id)
        if authority == "manual":
            record["authority"] = "manual"
            record["status"] = "confirmed"
        record["confidence"] = _confidence(len(record["evidence"]), record["authority"])
        record["updatedAt"] = stamp
        self._append(record)
        return record

    def confirm(self, identity_id: str, name: str, aliases: list[str] | None = None) -> dict[str, Any] | None:
        for record in self._by_signature.values():
            if record.get("id") != identity_id:
                continue
            record["identity"] = name
            record["display"] = name or record["display"]
            if aliases:
                merged = list(dict.fromkeys(list(record.get("aliases") or []) + aliases))
                record["aliases"] = merged
            record["authority"] = "manual"
            record["status"] = "confirmed"
            record["confidence"] = _confidence(len(record["evidence"]), "manual")
            record["updatedAt"] = _now()
            self._append(record)
            return record
        return None

    def audit(self, record: dict[str, Any]) -> None:
        """写 `inst/data/xzy/audit/identity.jsonl`（注入/观察/确认/查询都记）。"""
        path = os.path.join(os.path.dirname(self.dir), "audit", "identity.jsonl")
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            row = {"wall": time.strftime("%Y-%m-%dT%H:%M:%S%z"), **record}
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
        except OSError:
            pass

    def compact(self) -> int:
        """把追加日志压成「每个 signature 一条最新记录」，返回压缩后行数。"""
        latest = list(self._by_signature.values())
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            for record in latest:
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        os.replace(tmp, self.path)
        self._lines = len(latest)
        return self._lines

    # ---------------------------------------------------------------- 一次性导入
    def import_legacy(self, index_path: str, candidates_path: str = "") -> dict[str, Any]:
        if os.path.exists(self.marker):
            with open(self.marker, "r", encoding="utf-8") as fh:
                return {"skipped": True, **json.load(fh)}
        imported = 0
        skipped = 0
        sources: dict[str, float] = {}
        try:
            sources[index_path] = os.path.getmtime(index_path)
        except OSError:
            sources[index_path] = 0.0
        if candidates_path and os.path.exists(candidates_path):
            sources[candidates_path] = os.path.getmtime(candidates_path)
        try:
            with open(index_path, "r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    try:
                        old = json.loads(line)
                    except ValueError:
                        continue
                    signature = str(old.get("signature") or signature_of(old.get("features") or {}))
                    if not signature or signature in self._by_signature:
                        skipped += 1
                        continue
                    record = {
                        "id": "ident_astrbot_" + hashlib.sha1(signature.encode("utf-8")).hexdigest()[:6],
                        "identity": str(old.get("identity") or ""),
                        "display": str(old.get("display") or ""),
                        "aliases": list(old.get("aliases") or []),
                        "signature": signature,
                        "features": old.get("features") or {},
                        "evidence": list(old.get("evidence") or []),
                        "confidence": float(old.get("confidence") or 0.5),
                        "authority": "manual" if old.get("authority") == "manual" else "heuristic",
                        "status": str(old.get("status") or "pending"),
                        "origin": "legacy-import",
                        "seenGroups": [],
                        "createdAt": str(old.get("createdAt") or _now()),
                        "updatedAt": str(old.get("updatedAt") or _now()),
                        "count": len(old.get("evidence") or []),
                    }
                    self._append(record)
                    imported += 1
        except OSError as exc:
            return {"skipped": False, "error": str(exc), "imported": imported}
        summary = {
            "skipped": False,
            "imported": imported,
            "duplicates": skipped,
            "sources": sources,
            "at": _now(),
        }
        with open(self.marker, "w", encoding="utf-8") as fh:
            json.dump(summary, fh, ensure_ascii=False, indent=2)
        return summary


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", default=DEFAULT_DIR)
    parser.add_argument("--stats", action="store_true")
    parser.add_argument("--import-legacy", action="store_true")
    parser.add_argument("--legacy", default=r"E:\Bonsai\astrbot-eval\inst\data\xzy\persona\identity-index.jsonl")
    parser.add_argument("--candidates", default=r"E:\Bonsai\astrbot-eval\inst\data\xzy\persona\identity-candidates.json")
    parser.add_argument("--compact", action="store_true")
    args = parser.parse_args()

    store = IdentityStore(args.dir)
    if args.import_legacy:
        print(json.dumps(store.import_legacy(args.legacy, args.candidates), ensure_ascii=False))
    if args.compact:
        print(json.dumps({"compacted_lines": store.compact()}, ensure_ascii=False))
    print(json.dumps(store.stats(), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
