# 生成 `faces.json`（系统表情 id → 中文名）

插件里的 `faces.py` 需要一个与它同目录的 `faces.json`。这个文件是 **SnowLuma 落盘的 QQ 官方系统表情目录的衍生数据**，会随 QQ 版本变化，所以不随仓库分发；按下面步骤自己生成即可。

生成后：

- 目标文件：`astrbot-plugin/xzy/faces.json`（与 `faces.py` 同目录）
- 插件按 mtime 热加载；文件缺失或损坏时退回上一份有效表，只是不发表情，不会崩
- 不要把生成结果提交到仓库（已在 `.gitignore` 中排除）

## 1. 数据来源

SnowLuma 会把 QQ 官方系统表情目录落盘到：

```
<SNOWLUMA_ROOT>/data/sys-face-catalog.json
```

结构（节选）：

```json
{
  "schemaVersion": 1,
  "fetchedAt": 1794992024809,
  "packs": [
    {
      "packName": "超级表情",
      "emojis": [
        { "qSid": "5", "qDes": "/流泪", "emCode": "105", "...": "..." },
        { "qSid": "311", "qDes": "/打call", "...": "..." }
      ]
    }
  ]
}
```

如果你的 SnowLuma 版本没有这个文件，先正常启动一次，并使用一次表情相关功能，让它通过 QQ 的 sysface 接口拉取并落盘；仍没有就升级 SnowLuma。

## 2. 目标格式

```json
{
  "meta": {
    "schemaVersion": 1,
    "generated": "2026-11-16",
    "source": "SnowLuma 落盘的 QQ 官方系统表情目录 <路径>（fetchedAt=<时间戳>）",
    "idSpace": "等于 [CQ:face,id=N] 与 AstrBot Face 组件的 id 字段",
    "nameRule": "取目录里的 qDes 去掉 QQ 的名称前缀 /；非数字 qSid（emoji 字符表情包）不收录；同名 id 只保留首次出现",
    "count": 299
  },
  "faces": {
    "0": "惊讶",
    "1": "撇嘴",
    "5": "流泪"
  }
}
```

转换规则：

1. 遍历 `packs[].emojis[]`；
2. `qSid` 必须是纯数字（对应 `[CQ:face,id=N]` 与 AstrBot `Face` 组件的 `id`）；非数字的 emoji 表情包跳过；
3. `qDes` 去掉开头的 `/` 作为中文名；去完为空则跳过；
4. 同一个 `id` 只保留首次出现的名称；
5. `faces` 的键按数值升序排列，便于 diff；
6. `meta.count` 写实际条数（2026-11 导出的 QQ 目录是 299 条，仅作参考，不是硬性要求）。

## 3. 生成脚本

把 `<SNOWLUMA_ROOT>` 换成你的实际路径，在仓库根目录运行：

```python
# tools/export_faces.py（示例，不必提交）
import json
from datetime import date
from pathlib import Path

CATALOG = Path(r"<SNOWLUMA_ROOT>/data/sys-face-catalog.json")
TARGET = Path(r"astrbot-plugin/xzy/faces.json")

catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
faces: dict[str, str] = {}
for pack in catalog.get("packs", []):
    for em in pack.get("emojis", []):
        sid = str(em.get("qSid", "")).strip()
        des = str(em.get("qDes", "")).strip()
        if not sid.isdigit() or not des:
            continue
        name = des[1:] if des.startswith("/") else des
        name = name.strip()
        if not name:
            continue
        faces.setdefault(sid, name)

ordered = {k: faces[k] for k in sorted(faces, key=int)}
out = {
    "meta": {
        "schemaVersion": 1,
        "generated": date.today().isoformat(),
        "source": f"SnowLuma 落盘的 QQ 官方系统表情目录 {CATALOG}（fetchedAt={catalog.get('fetchedAt')}）",
        "idSpace": "等于 [CQ:face,id=N] 与 AstrBot Face 组件的 id 字段",
        "nameRule": "取目录里的 qDes 去掉 QQ 的名称前缀 /；非数字 qSid（emoji 字符表情包）不收录；同名 id 只保留首次出现",
        "count": len(ordered),
    },
    "faces": ordered,
}
TARGET.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"wrote {TARGET} ({len(ordered)} faces)")
```

## 4. 验证

```powershell
python -c "import json;d=json.load(open(r'astrbot-plugin/xzy/faces.json',encoding='utf-8'));print(len(d['faces']), d['faces'].get('5'))"
# 期望类似：299 流泪
```

然后在 AstrBot 里重载 xzy 插件，发一个 `[CQ:face,id=5]` 或让模型调用表情工具，确认表情能正常发出。若名称对不上，说明 QQ 改了目录文案，重新导出即可。
