"""工具 schema 白名单与 FunctionTool 构造（唯一入口）。

原生 `ToolSchema.validate_parameters` 用 Draft202012 META_SCHEMA 校验；写成
`{"type": "json"}` 会直接抛 ValidationError（历史上有 19 处这种写法）。
这里在构造前先做一次递归检查，报错时带上工具名与路径，避免插件整体起不来。

四态渲染统一走 `tool_result.render()`；handler 一律用 `safe_call` 包住，
禁止抛异常、禁止返回 None（原因见 evidence/tools.md §1）。
"""

from __future__ import annotations

from typing import Any

from astrbot.core.agent.tool import FunctionTool

try:
    from . import loop_guard
    from .tool_result import safe_call
except ImportError:  # AstrBot 以扁平模块方式加载时走这里
    import loop_guard  # type: ignore
    from tool_result import safe_call  # type: ignore

SUPPORTED_TYPES = {"object", "array", "string", "number", "integer", "boolean", "null"}


class SchemaError(ValueError):
    """schema 不在原生白名单内。"""


def check_schema(schema: Any, tool_name: str, path: str = "$") -> None:
    if not isinstance(schema, dict):
        raise SchemaError(f"{tool_name}: {path} 不是 JSON Schema 对象")
    typ = schema.get("type")
    if typ is not None:
        types = typ if isinstance(typ, list) else [typ]
        for item in types:
            if item not in SUPPORTED_TYPES:
                raise SchemaError(
                    f"{tool_name}: {path}.type={item!r} 不在白名单 "
                    f"{sorted(SUPPORTED_TYPES)} 内（原生 META_SCHEMA 会拒绝）"
                )
    for key in ("properties",):
        props = schema.get(key) or {}
        if not isinstance(props, dict):
            raise SchemaError(f"{tool_name}: {path}.{key} 必须是对象")
        for name, sub in props.items():
            check_schema(sub, tool_name, f"{path}.properties.{name}")
    if "items" in schema:
        check_schema(schema["items"], tool_name, f"{path}.items")
    for key in ("anyOf", "oneOf", "allOf"):
        if key in schema:
            if not isinstance(schema[key], list):
                raise SchemaError(f"{tool_name}: {path}.{key} 必须是数组")
            for i, sub in enumerate(schema[key]):
                check_schema(sub, tool_name, f"{path}.{key}[{i}]")
    extra = schema.get("additionalProperties")
    if isinstance(extra, dict):
        check_schema(extra, tool_name, f"{path}.additionalProperties")


def param_map_to_schema(params: dict[str, Any] | None) -> dict[str, Any]:
    """旧栈 `parameters` 映射 → 标准 JSON Schema（object）。

    旧格式： {name: {type, required?, description?, items?, enum?, ...}}
    """
    properties: dict[str, Any] = {}
    required: list[str] = []
    for name, spec in (params or {}).items():
        spec = dict(spec or {})
        prop: dict[str, Any] = {"type": spec.get("type", "string")}
        for key in ("description", "enum", "minimum", "maximum", "default"):
            if key in spec:
                prop[key] = spec[key]
        if prop["type"] == "array":
            item_spec = dict(spec.get("items") or {})
            prop["items"] = {"type": item_spec.get("type", "string")}
            if isinstance(item_spec.get("properties"), dict):
                prop["items"]["properties"] = item_spec["properties"]
        elif prop["type"] == "object" and isinstance(spec.get("properties"), dict):
            prop["properties"] = spec["properties"]
        properties[name] = prop
        if spec.get("required") is True:
            required.append(name)
    out: dict[str, Any] = {"type": "object", "properties": properties}
    if required:
        out["required"] = required
    return out


def make_tool(
    name: str,
    description: str,
    parameters: dict[str, Any] | None,
    handler,
) -> FunctionTool:
    """构造 FunctionTool：先白名单检查，再包 safe_call。"""
    schema = param_map_to_schema(parameters)
    check_schema(schema, name)
    wrapped = safe_call(loop_guard.wrap_handler(handler, name), name)
    wrapped.__name__ = name
    return FunctionTool(
        name=name,
        description=description,
        parameters=schema,
        handler=wrapped,
    )
