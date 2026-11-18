"""身份索引工具 `qq_identity`（lookup / confirm）+ 与主链路共用同一个 IdentityStore。

接线位置（2026-11-15）：
- `main.on_llm_request` 末尾注入「【身份索引】」段（store 无记录则不注入）；
- `main._observe_image` 视觉特征产出后调 `identity_store.observe()`；
- 本工具：`lookup` 查记录，`confirm` 只有主人能命名。
审计：`inst/data/xzy/audit/identity.jsonl`（action=inject / observe / tool-lookup / tool-confirm）。

旧栈数据导入命令（**已备好，未执行**）：
    E:\\Bonsai\\astrbot-eval\\venv\\Scripts\\python.exe identity_store.py --import <index.json> [candidates.json]
"""

from __future__ import annotations

from typing import Any

try:
    from . import identity_store
    from . import tool_result as tr
except ImportError:  # AstrBot 以扁平模块方式加载时走这里
    import identity_store  # type: ignore
    import tool_result as tr  # type: ignore

CFG: dict[str, Any] = {}
STORE: identity_store.IdentityStore | None = None


def configure(
    cfg: dict[str, Any], store: identity_store.IdentityStore | None = None
) -> None:
    global STORE
    CFG.clear()
    CFG.update(cfg or {})
    if store is not None:
        STORE = store
        return
    if STORE is None:
        raw = CFG.get("identity")
        opts = raw if isinstance(raw, dict) else {}
        directory = str(opts.get("dir") or "").strip() or identity_store.DEFAULT_DIR
        STORE = identity_store.IdentityStore(directory)


def store() -> identity_store.IdentityStore:
    if STORE is None:
        configure(CFG)
    if STORE is None:  # pragma: no cover - configure 必定赋值
        raise RuntimeError("identity store 未配置")
    return STORE


def _is_master(event: Any) -> bool:
    if event is None:
        return False
    try:
        return str(event.get_sender_id()) == str(CFG.get("master_qq") or "")
    except Exception:  # noqa: BLE001
        return False


def _row_view(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row.get("id"),
        "display": row.get("display"),
        "aliases": row.get("aliases") or [],
        "status": row.get("status"),
        "authority": row.get("authority"),
        "confidence": row.get("confidence"),
        "count": row.get("count"),
        "seenGroups": row.get("seenGroups") or [],
        "signature": row.get("signature"),
        "updatedAt": row.get("updatedAt"),
    }


async def qq_identity(
    event: Any = None,
    action: str = "lookup",
    identity_id: str = "",
    name: str = "",
    aliases: Any = None,
    signature: str = "",
    limit: Any = 5,
    **_: Any,
) -> dict[str, Any]:
    state = store()
    act = str(action or "lookup").strip().lower()
    try:
        size = max(1, min(20, int(limit)))
    except (TypeError, ValueError):
        size = 5

    if act == "lookup":
        rows = state.lookup(str(signature or ""), size)
        state.audit(
            {"action": "tool-lookup", "hits": len(rows), "signature": str(signature or "")}
        )
        if not rows:
            return tr.result_done(
                "no-result",
                why="身份索引里没有匹配的记录。",
                data={"records": []},
            )
        return tr.result_ok(
            why=f"查到 {len(rows)} 条身份记录。",
            data={"records": [_row_view(row) for row in rows]},
        )

    if act == "confirm":
        if not _is_master(event):
            state.audit({"action": "tool-confirm", "ok": False, "reason": "forbidden"})
            return tr.result_blocked(
                "forbidden", why="只有主人能确认身份命名。"
            )
        target = str(identity_id or "").strip()
        label = str(name or "").strip()
        if not target or not label:
            return tr.result_fail(
                "bad-args", why="confirm 需要 identity_id 和 name 两个参数。"
            )
        if isinstance(aliases, str):
            alias_list = [item.strip() for item in aliases.split(",") if item.strip()]
        elif isinstance(aliases, list):
            alias_list = [str(item).strip() for item in aliases if str(item).strip()]
        else:
            alias_list = []
        row = state.confirm(target, label, alias_list or None)
        if row is None:
            state.audit({"action": "tool-confirm", "ok": False, "reason": "not-found", "id": target})
            return tr.result_done(
                "no-result", why=f"身份索引里没有 id={target} 的记录。"
            )
        state.audit(
            {"action": "tool-confirm", "ok": True, "id": target, "name": label}
        )
        return tr.result_ok(
            why=f"已把 {target} 命名为「{label}」。",
            data={"record": _row_view(row)},
        )

    return tr.result_fail(
        "bad-args", why="action 只支持 lookup / confirm。"
    )


TOOL_SPECS: list[dict[str, Any]] = [
    {
        "name": "qq_identity",
        "description": "查身份索引（你见过的形象记录），或由主人给某条记录命名。"
        "lookup：按 signature 精确查，或按最近更新时间列出；confirm：主人确认命名（非主人会被拒）。"
        "记录来自真实看图，只代表外形特征，不代表身份结论。",
        "parameters": {
            "action": {
                "type": "string",
                "enum": ["lookup", "confirm"],
                "description": "lookup 查记录；confirm 命名（仅主人）",
            },
            "identity_id": {"type": "string", "description": "confirm 时的记录 id，如 ident_astrbot_ab12cd"},
            "name": {"type": "string", "description": "confirm 时的名字"},
            "aliases": {"type": "string", "description": "可选别名，逗号分隔"},
            "signature": {"type": "string", "description": "lookup 时可给特征 signature 精确查"},
            "limit": {"type": "number", "description": "lookup 返回条数，默认 5，上限 20"},
        },
        "handler": qq_identity,
    },
]
