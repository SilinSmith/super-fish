"""小助手 · AstrBot 原生优先迁移（XzyPlugin）。

设计约束（Y:\\dsh\\.trae\\specs\\migrate-qq-to-astrbot\\spec.md）：
- **不调用** event.should_call_llm(False) 接管原生链路；推理 / 压缩 / 发送 / 会话存储全部走 AstrBot 原生；
- 插件只补原生没有的：判定（policy.js）、防抖合批、人格只读注入、presence 注入、审计；
- 判定分工：`policy.py` 管确定性规则（dnd/access/@/点名/引用/主人 cue/接龙/概率/频次/冷却），
  `judge.py` 只在白名单群、规则未触发时问一次 1240；
- **抑制靠 `should_call_llm(True)`**：`stop_event()` 在普通协程 handler 里会被
  `star_request` 的 `clear_result()` 清掉（见 spec §10.1），只作双保险；
- 状态全部落盘（JSONL + mono_ns/wall）；terminate 取消全部 asyncio task，防双份定时器。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import sys
import time
import uuid
from typing import Any

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star
from astrbot.core.agent.tool import FunctionTool
from astrbot.core.provider.entities import ProviderRequest

try:
    from . import answer_ledger
    from . import bili_proactive
    from . import bubbles
    from . import continuation
    from . import draftbook
    from . import faces
    from . import identity_store
    from . import image_prep
    from . import inbound_expand
    from . import judge as judge_mod
    from . import loop_guard
    from . import media_fence
    from . import media_platform as mp
    from . import members
    from . import memory_context as memory_ctx
    from . import mutation_policy
    from . import night_quiet
    from . import outbound_clean
    from . import output_spec_gate
    from . import persona_inject
    from . import policy
    from . import review_gate
    from . import self_iter
    from . import send_dedupe
    from . import tool_context
    from . import tool_result as tr
    from . import tool_round_guard
    from . import tool_send
    from . import tools_batch1
    from . import tools_batch2
    from . import tools_batch3
    from . import tools_batch4
    from . import tools_draft
    from . import tools_identity
    from . import tools_memory
    from . import tools_sticker
    from . import typing_indicator
    from . import vision_state
    from .mood import MoodStore
    from .tool_schema import make_tool
    from .version_compat import TARGET_VERSION, installed_version, version_warnings
except ImportError:  # AstrBot 以模块方式加载时走这里
    import answer_ledger  # type: ignore
    import bili_proactive  # type: ignore
    import bubbles  # type: ignore
    import continuation  # type: ignore
    import draftbook  # type: ignore
    import faces  # type: ignore
    import identity_store  # type: ignore
    import image_prep  # type: ignore
    import inbound_expand  # type: ignore
    import judge as judge_mod  # type: ignore
    import loop_guard  # type: ignore
    import media_fence  # type: ignore
    import media_platform as mp  # type: ignore
    import members  # type: ignore
    import memory_context as memory_ctx  # type: ignore
    import mutation_policy  # type: ignore
    import night_quiet  # type: ignore
    import outbound_clean  # type: ignore
    import output_spec_gate  # type: ignore
    import persona_inject  # type: ignore
    import policy  # type: ignore
    import review_gate  # type: ignore
    import self_iter  # type: ignore
    import send_dedupe  # type: ignore
    import tool_context  # type: ignore
    import tool_result as tr  # type: ignore
    import tool_round_guard  # type: ignore
    import tool_send  # type: ignore
    import tools_batch1  # type: ignore
    import tools_batch2  # type: ignore
    import tools_batch3  # type: ignore
    import tools_batch4  # type: ignore
    import tools_draft  # type: ignore
    import tools_identity  # type: ignore
    import tools_memory  # type: ignore
    import tools_sticker  # type: ignore
    import typing_indicator  # type: ignore
    import vision_state  # type: ignore
    from mood import MoodStore  # type: ignore
    from tool_schema import make_tool  # type: ignore
    from version_compat import (  # type: ignore
        TARGET_VERSION,
        installed_version,
        version_warnings,
    )


PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_ROOT = os.path.abspath(os.path.join(PLUGIN_DIR, "..", ".."))
STATE_DIR = os.path.join(DATA_ROOT, "xzy")
AUDIT_DIR = os.path.join(STATE_DIR, "audit")
CONFIG_PATH = os.path.join(STATE_DIR, "xzy-config.json")
PRESENCE_JSON = os.path.join(STATE_DIR, "presence.json")
# bridge 台账（撤回自己的回复需要 OneBot 侧的 message_id，只有 bridge 拿得到）
CUTOVER_DIR = os.environ.get("XZY_CUTOVER_DIR", r"Y:\dsh\home\qq-cutover")
RECALL_LEDGER = os.path.join(CUTOVER_DIR, "recall-ledger.jsonl")

# 撤回：notice 类型 + `/撤回` 指令的入站窗口（照旧栈 recall.js，秒）
RECALL_NOTICE_TYPES = frozenset({"group_recall", "friend_recall"})
RECALL_INBOUND_WINDOW_SEC = 110.0
# 2026-11-15：联动撤回（跟着对方撤回自动 delete_msg）已撤销，改由模型调用 qq_recall 自主决定。
RECALL_NOTE_TTL_SEC = 1800.0
RECALL_NOTE_MAX = 8
# 模型自主撤回（qq_recall）：只撤自己发出的消息；失败如实回 code，不静默当成功
RECALL_TOOL_MAX = 3
RECALL_TOOL_WINDOW_SEC = 600.0
# 拍回：旧栈 bridge.js POKE_BACK_COOLDOWN_MS=5000 / POKE_BACK_DELAY_MS=2000
POKE_BACK_COOLDOWN_SEC = 5.0
POKE_BACK_DELAY_SEC = 2.0
# /撤回 [messageId]（旧栈 recall.js handleCommand）
_RECALL_CMD_RE = re.compile(r"^[／/]撤回(?:\s+(\d{3,}))?\s*$")

# 身份索引（identity_store）：看图后只抽「能用来认出同一外形」的特征，不猜身份。
# 输出必须是一个 JSON 对象；解析失败按 observe-empty 记审计，不写入记录。
IDENTITY_PROMPT = (
    "只看画面里的角色形象，抽取以后能认出同一个形象的外形特征。"
    "只输出一个 JSON 对象，不要解释、不要代码块，字段固定为："
    '{"hairColor":[],"hairStyle":[],"eyeColor":[],"earType":[],"proportion":[],"palette":[],"markers":[]}。'
    "每项填 1~3 个简短中文描述（例如 hairColor:[\"银白\"]、earType:[\"猫耳\"]、"
    "markers:[\"左眼下泪痣\"]）；看不出来的项给空数组。"
    "不是人物/角色（风景、界面、纯文字）时全部给空数组。"
    "不要输出姓名、身份、现实里可能是谁。"
)

# 默认值逐条取现网：config.js DEFAULTS + config.json 实际值
DEFAULT_CONFIG: dict[str, Any] = {
    "master_qq": "10000",
    "persona_path": r"E:\Bonsai\astrbot-eval\inst\data\xzy\persona\character.md",
    "notebook_path": r"E:\Bonsai\astrbot-eval\inst\data\xzy\persona\notebook.json",
    "presence_decay_interval_s": 300,
    # 防抖合批：aligned = 现网 config.js DEFAULTS.debounce；fast = 上一轮那套更快的档
    # 2026-11-15：原生空 @ 的 60s 等待关掉后，用更长的合批窗口替代「@ 完再补一句」。
    # 取值：单聊 2.5s / 群聊 4.0s / 图片 9.0s / 空 @ 10.0s；代价是每条回复多等这么久才开始。
    "debounce_profile": "aligned",
    "debounce": {
        "enabled": True,
        "baseMs": 2500,
        "groupMs": 4000,
        "imageMs": 9000,
        # 只有 @、没有正文时的独立窗口：等对方「@ 完再补一句」。
        # 与 groupMs 是两套语义：groupMs 管普通群消息，本项只在空 @ 上生效。
        # 10s 依据：实测 @ 与随后补话间隔约 5.4s（12:37:29.0 @ → 12:37:34.4 正文），
        # 取 6~10s 区间的上界，保证「@ 后 10s 内补的话」都并进同一轮。
        # 代价：只 @ 不说话时，回复要等满 10s 才开始生成。
        "emptyMentionMs": 10000,
        "maxBatch": 12,
        "hardMs": 0,
    },
    "debounce_fast": {
        "enabled": True,
        "baseMs": 1200,
        "groupMs": 1200,
        "imageMs": 1200,
        "maxBatch": 20,
        "hardMs": 4000,
    },
    "dedupWindowSec": 300,
    # 拆条：长回复按句子边界拆成 2~3 条（真生效，不是展示字段）。
    # maxChars 是单段上限，maxParts 是段数上限，gapMs 是段间停顿（像真人一句句发）。
    "bubbles": {"enabled": True, "maxChars": 45, "maxParts": 3, "gapMs": 600},
    "judge": {
        "enabled": True,
        "groups": ["100000002", "100000001"],
        "mergeWindowMs": 5000,
        "timeoutMs": 3000,
        "queueLimit": 3,
        "proxyBase": "http://127.0.0.1:1240",
        # 接话窗口：机器人最后一句是问句、且这句话在窗口内 → 直接判接话（不调模型）。
        # 30s 依据：实测「@ 完补一句」约 5.4s，接话一般也在十几秒内；30s 之外
        # 话头已经凉了，交模型按上下文判，不硬接。
        "continuationWindowMs": 30000,
        # 超窗灰区上界：30s~120s 之间仍交给模型（有历史可依），超过 120s 也交模型但通常判沉默。
        "continuationStaleMs": 120000,
    },
    "trigger": {
        "mode": "at",
        "keywords": [],
        "regex": "",
        "chance": 1.0,
        "replyToBot": True,
        "mentionNames": ["小助手", "助手", "helper"],
        "banter": True,
    },
    "replyChance": 1.0,
    # 出站「对方正在输入…」：OneBot set_input_status，仅私聊（协议层 chatType=0）
    "typing": {"enabled": True, "intervalSec": 4.0, "ttlSec": 180.0},
    # 视觉环境观察：旧栈 vision.mjs 口径（一句话、不存图副本、8s 最小间隔、队列 32）
    "vision": {
        "enabled": True,
        "minGapSec": 8.0,
        "maxBytes": 8388608,
        "queueLimit": 32,
    },
    # 入模前图片压缩：长边 768 = 360~576 vision tokens（原图 3840x2400 是 9000）
    "image_prep": {
        "enabled": True,
        "maxEdge": 768,
        "maxBytes": 98304,
        "inputMaxBytes": 12582912,
        "timeoutSec": 10.0,
    },
    # 视频抽帧：从「固定 12 帧 + 0.5/1.2/3/5/8/12/20/30s 刻度」改成
    # 「按时长分档封顶 + 前段加密 + 场景边界优先」。
    # - frameTiers：≤30s 16 帧、≤120s 18、≤300s 20、更长 22；hardCap 24 兜底，
    #   长视频不再线性膨胀（改动前一律 12 帧）；
    # - frontWindowSec/frontTicks：0–5s 六拍（0.3~4.5s），开头信息密度最高；
    # - sceneQuota 优先于固定 tick，宁可少几个 tick 也要保住场景边界；
    # - minGapSec 去重间隔；keyframeQuota 关键帧均匀铺开数；
    # - frameMaxEdge 单帧长边仍 768：视觉 token 只跟像素有关，不能跟帧数一起涨。
    "video": {
        "frameTiers": [[30, 16], [120, 18], [300, 20], [0, 22]],
        "hardCap": 24,
        "frontWindowSec": 5.0,
        "frontTicks": [0.3, 0.8, 1.5, 2.5, 3.5, 4.5],
        "minGapSec": 0.8,
        "sceneThreshold": 0.32,
        "sceneQuota": 4,
        "keyframeQuota": 8,
        "maxRescueGop": 12,
        "frameMaxEdge": 768,
    },
    # B 站看片帧数上限：只能把 video.frameTiers 的预算压小，不能抬高
    "bili": {"maxFrames": 24},
    # 自迭代：灰度期只出提案，notebook 由 qq_notebook 唯一写，自动 apply 关闭。
    # auto = spec §16.2 的闲时自动触发：连续 idleMinutes 无活动、每 gapHours ≤1 次、
    # 每天 ≤maxPerDay 次；只跑 propose，绝不调 apply_proposal（代码/只读区永远不自动写）。
    "self_iter": {
        "enabled": True,
        "auto_apply": False,
        "auto": {
            "enabled": True,
            "idleMinutes": 10,
            "gapHours": 3,
            "maxPerDay": 8,
            "materialLimit": 30,
            "pollSeconds": 60,
        },
    },
    # 身份索引（identity_store）：看图特征落库 + 每轮注入已知形象 + qq_identity 查询/主人命名。
    # dir 为空用 inst/data/xzy/identity；enabled=false 时既不注入也不 observe。
    "identity": {"enabled": True, "dir": "", "injectLimit": 3},
    "limits": {"perMinute": 30, "perHour": 0, "perDay": 0, "cooldownSec": 0},
    # 自由参与群（按群配置，不是全局开关）：不看 @、不走「是否指向机器人」判定，
    # 直接进对话；靠每群自己的节流防刷屏。`groups` 里出现群号即启用。
    # 示例：{"enabled": true, "groups": {"100000004": {"minIntervalSec": 15,
    #        "perMinute": 3, "perHour": 24}}}
    "free_chat": {"enabled": True, "groups": {}},
    "dnd": {"start": "", "end": "", "timezone": "Asia/Shanghai"},
    # 夜间静默窗口：不是 dnd（dnd 管回不回话），这里管「不跑长时间高负载任务」。
    # 窗口内 B站主动刷与自迭代重活整轮跳过（不补跑）；超过 longVideoSec 的视频
    # 只给 ffprobe 元数据，不抽帧/转写/做画面观察；秒级单图描述不受影响。
    # longVideoSec=300：与 video.frameTiers 的 300 秒分档边界一致；300s 以内 whisper
    # small 转写≤126s、抽帧≤20，属有界负载，超过后 ASR 与逐帧视觉会随片长一起涨。
    "night_quiet": {
        "enabled": True,
        "start": "23:30",
        "end": "06:00",
        "timezone": "Asia/Shanghai",
        "longVideoSec": 300,
        "auditCooldownSec": 600,
    },
    "access": {
        "allowAll": False,
        "dmPolicy": "allowlist",
        "allowUsers": [],
        "denyUsers": [],
        "groupPolicy": "allowlist",
        "allowGroups": [],
        "denyGroups": [],
    },
    "dm": {"trigger": {"mode": "always"}},
    # 媒体与二审：默认值逐条对齐旧栈 index.js（reviewEnabled=false → 只跑机器硬规则）
    "media_dir": "",
    "engine_nonce": True,
    "reviewForward": True,
    # 步数闸阈值：必须小于 AstrBot 的 max_agent_step（现网 30），否则永远不触发
    "loop_guard": {"stepCap": 24},
    "review": {
        "enabled": False,
        "url": "http://127.0.0.1:1240/review",
        "model": "qwen3.5-9b",
        "timeoutMs": 12000,
        "maxAttempts": 2,
        "failOpen": True,
    },
    "tts": {
        # 语音出站总开关：2026-11-17 事故（一次对话里连发 8 条 TTS 私聊语音）后
        # 默认关闭。关闭时 qq_send_tts / qq_send_voice 既不注册给模型，
        # tool_send 也会硬拦 record 段；改 true 需重载插件。
        "enabled": False,
        # 开启后的兜底：同一会话 windowSeconds 内最多 maxPerWindow 条，
        # 且同一句台词（忽略 emotion）只发一次。
        "maxPerWindow": 2,
        "windowSeconds": 120,
        "url": "http://127.0.0.1:5000",
        "modelName": "Fusetsu-v1.5",
        "speakerName": "Fusetsu_v1.5",
        "style": "Neutral",
        "styleWeight": 1.0,
        "length": 1.0,
        "language": "JP",
        "timeoutMs": 120000,
        "maxChars": 500,
        "kanaOnly": True,
    },
}

# 语音工具：受 tts.enabled 总开关控制（关闭时不注册，见 _register_tools）
VOICE_TOOLS = ("qq_send_tts", "qq_send_voice")

# 工具模块注册表：三路 worker 各自只提交模块文件（含 TOOL_SPECS / configure），
# 由整合方在这里追加一行完成合并。注册顺序即模型看到的工具顺序。
TOOL_MODULES = (
    tools_batch1,
    tools_batch2,
    tools_batch3,
    tools_batch4,
    tools_draft,
    tools_identity,
    tools_memory,
    tools_sticker,
    self_iter,
)


# --------------------------------------------------------------------------- #
# 落盘工具
# --------------------------------------------------------------------------- #
def _stamp() -> dict[str, Any]:
    return {
        "mono_ns": time.monotonic_ns(),
        # wall_ms：毫秒级墙钟。接话判定算「机器人上一句距今多久」要用它
        # （mono_ns 跨进程无效，`wall` 只有秒级精度）。
        "wall_ms": int(time.time() * 1000),
        "wall": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }


def _ensure_dirs() -> None:
    os.makedirs(STATE_DIR, exist_ok=True)
    os.makedirs(AUDIT_DIR, exist_ok=True)


def _append_jsonl(name: str, record: dict[str, Any]) -> None:
    _ensure_dirs()
    record = {**_stamp(), **record}
    with open(os.path.join(AUDIT_DIR, name), "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
        f.flush()


def _timing_row(entry: dict[str, Any], stage: str, t_now: float) -> None:
    """入站时序插桩：只追加时间戳，不改判定、不改发送、不阻塞。"""
    try:
        event_ms = int(entry.get("_t_event_ms") or 0)
        enter = float(entry.get("_t_enter") or t_now)
        now_ms = int(t_now * 1000)
        _append_jsonl(
            "inbound_timing.jsonl",
            {
                "trace": entry.get("trace"),
                "umo": entry.get("umo"),
                "message_id": entry.get("message_id"),
                "stage": stage,
                "wall_ms": now_ms,
                "from_event_ms": (now_ms - event_ms) if event_ms else None,
                "from_enter_ms": int((t_now - enter) * 1000),
            },
        )
    except Exception:
        pass


def _read_json(path: str, default: Any) -> Any:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _json_object(text: str) -> dict[str, Any] | None:
    """从模型输出里抠第一个 JSON 对象（容忍代码块/前后缀）；失败返回 None。"""
    raw = str(text or "").strip()
    if not raw:
        return None
    match = re.search(r"\{[\s\S]*\}", raw)
    if not match:
        return None
    try:
        value = json.loads(match.group(0))
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _write_json_atomic(path: str, data: Any) -> None:
    _ensure_dirs()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _deep_merge(base: Any, override: Any) -> Any:
    """与 config.js deepMerge 同语义：对象递归、数组整体替换。"""
    if not isinstance(override, dict):
        return override
    out = dict(base) if isinstance(base, dict) else {}
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def _load_config() -> dict[str, Any]:
    disk = _read_json(CONFIG_PATH, {})
    cfg = _deep_merge(DEFAULT_CONFIG, disk if isinstance(disk, dict) else {})
    if not os.path.exists(CONFIG_PATH):
        _write_json_atomic(CONFIG_PATH, cfg)
    return cfg


_CFG: dict[str, Any] = {}

# 自由参与群的节流状态（进程内，monotonic）。按群号分桶，不影响普通群的 limits。
_FREE_STATE: dict[str, dict[str, Any]] = {}

# 拆条待发的后几段：umo -> (parts, queued_at)。第一段由原生 respond 发出，
# 其余在 after_message_sent 里按 gapMs 补发；超过 60s 未消费视为失效，丢弃。
_BUBBLE_PENDING: dict[str, tuple[list[str], float]] = {}

# 单条出站最多带几个 QQ 原生表情，超出的标记直接丢，避免刷表情
MAX_FACES = 2


def _face_comps(text: str, used: int = 0) -> tuple[list[Any] | None, int]:
    """正文 → [Plain/Face 组件]；没有表情标记返回 None（调用方保持原组件不动）。

    名字查不到时 `faces.tokens` 会保留原文标记，于是这条消息自动退化成纯文本。
    """
    try:
        from astrbot.core.message.components import Face, Plain
    except Exception:  # noqa: BLE001 - 组件不可用时按纯文本走
        return None, used
    toks = faces.tokens(text or "")
    if not any(kind == "face" for kind, _ in toks):
        return None, used
    comps: list[Any] = []
    for kind, value in toks:
        if kind == "text":
            if value:
                comps.append(Plain(value))
        elif used < MAX_FACES:
            try:
                comps.append(Face(id=int(value)))
            except (TypeError, ValueError):
                comps.append(Plain(f"[表情:{value}]"))
                continue
            used += 1
    return comps, used


def _expand_faces_in_chain(result: Any) -> int:
    """就地展开 result.chain 里的表情标记。

    第一段走原生 respond，不经过 tool_send，所以这条路径只能改组件链；
    拆条后的后续段在 after_message_sent 走 tool_send.send_segments，由那边展开。
    """
    chain = getattr(result, "chain", None)
    if not chain:
        return 0
    try:
        from astrbot.core.message.components import Plain
    except Exception:  # noqa: BLE001
        return 0
    used = 0
    changed = False
    out: list[Any] = []
    for comp in chain:
        if not isinstance(comp, Plain):
            out.append(comp)
            continue
        comps, used_after = _face_comps(getattr(comp, "text", "") or "", used)
        if comps is None:
            out.append(comp)
            continue
        changed = True
        used = used_after
        out.extend(comps)
    if changed:
        try:
            chain[:] = out
        except TypeError:
            return 0
    return used


def _exc_summary(exc: BaseException) -> tuple[str, Any]:
    """异常的类型名 + 能拿到的 retcode。

    `aiocqhttp.exceptions.ApiNotAvailable` 的文本是空串，只打 `{exc}` 等于什么
    都没写，所以失败日志与审计一律带上类型名；retcode 取自 ActionFailed 的
    `retcode` 或 `result["retcode"]`，拿不到就是 None。
    """
    retcode = getattr(exc, "retcode", None)
    if retcode is None:
        result = getattr(exc, "result", None)
        if isinstance(result, dict):
            retcode = result.get("retcode")
    return type(exc).__name__, retcode


# --------------------------------------------------------------------------- #
# 原生工具（四态契约见 tool_result.py）
# --------------------------------------------------------------------------- #
async def system_echo(
    event: AstrMessageEvent = None, text: str = "", **_: Any
) -> dict[str, Any]:
    return tr.result_ok("原样返回", text=text)


# memory_search 由 tools_memory 模块声明（与旧栈 search_entries 语义对齐），此处不再重复内置。


# --------------------------------------------------------------------------- #
# 入站归一化与合批（policy.js 的 textOf / debounce 段移植）
# --------------------------------------------------------------------------- #
_COMPONENT_TEXT = {
    "Image": "[图片]",
    "Record": "[语音]",
    "Video": "[视频]",
    "File": "[文件]",
    "Forward": "[合并转发]",
}


def _component_type(comp: Any) -> str:
    # 4.14.6 的 comp.type 是枚举，类名才是稳定标识
    return comp.__class__.__name__ or str(getattr(comp, "type", ""))


def _non_plain_components(result: Any) -> list[Any]:
    """结果链里的非文本组件（表情/图片/文件等）：纯空文本但有它们时仍然要发。"""
    return [
        comp
        for comp in ((getattr(result, "chain", None) or []) if result is not None else [])
        if _component_type(comp) != "Plain"
    ]


def _bigrams(text: str) -> set[str]:
    s = "".join(ch for ch in text if not ch.isspace())
    return {s[i : i + 2] for i in range(len(s) - 1)}


def _strip_video_recital(text: str, captions: list[str]) -> dict[str, Any]:
    """视频回合的出站闸：开头的画面复述句必须去掉，判断才留得下。

    判定：某一小句与任一 caption 的二元组重合率 ≥ 0.5 且长度 ≥ 8 字，即视为照抄
    画面描述。只看开头连续的小句（最多两句），遇到第一句非复述就停，不改动后半段。
    """
    out = {"hit": False, "text": text, "dropped": False, "stripped": 0}
    caps = [_bigrams(str(item)) for item in (captions or []) if str(item or "").strip()]
    if not caps or not text.strip():
        return out
    pieces = [p for p in re.split(r"(?<=[。！？!?；;\n])", text) if p.strip()]
    cut = 0
    for index, piece in enumerate(pieces[:2]):
        grams = _bigrams(piece)
        if len(grams) < 6:
            break
        ratio = max((len(grams & cap) / len(grams)) for cap in caps)
        if ratio < 0.5:
            break
        cut = index + 1
    if not cut:
        return out
    rest = "".join(pieces[cut:]).strip()
    out.update(
        {
            "hit": True,
            "text": rest,
            "dropped": len(rest) < 6,
            "stripped": cut,
        }
    )
    return out


# QQ 转发 B 站视频落成 json/xml 卡片，卡片载荷里才有链接；text 是空的，
# 不解析的话模型只看到「[Json]」，等于这条消息被吞掉。
_BILI_URL_RE = re.compile(
    r"https?://(?:b23\.tv|bili2233\.cn|(?:www\.|m\.)?bilibili\.com/video)/[^\s\"'<>\\]+",
    re.IGNORECASE,
)
_BV_RE = re.compile(r"BV[0-9A-Za-z]{10}")


def _card_texts(value: Any, out: list[str], depth: int = 0) -> None:
    """把卡片载荷摊平成文本；data.data 常是再套一层的 JSON 字符串。"""
    if depth > 5:
        return
    if isinstance(value, str):
        out.append(value)
        if value.lstrip().startswith("{"):
            try:
                _card_texts(json.loads(value), out, depth + 1)
            except Exception:  # noqa: BLE001
                pass
    elif isinstance(value, dict):
        for item in value.values():
            _card_texts(item, out, depth + 1)
    elif isinstance(value, (list, tuple)):
        for item in value:
            _card_texts(item, out, depth + 1)


def _card_title(value: Any, key: str = "title", depth: int = 0) -> str:
    if depth > 5:
        return ""
    if isinstance(value, dict):
        item = value.get(key)
        if isinstance(item, str) and item.strip() and not item.lstrip().startswith("{"):
            return item.strip()[:80]
        for item in value.values():
            got = _card_title(item, key, depth + 1)
            if got:
                return got
    elif isinstance(value, (list, tuple)):
        for item in value:
            got = _card_title(item, key, depth + 1)
            if got:
                return got
    elif isinstance(value, str) and value.lstrip().startswith("{"):
        try:
            return _card_title(json.loads(value), key, depth + 1)
        except Exception:  # noqa: BLE001
            return ""
    return ""


def _bili_card(comp: Any) -> dict[str, str] | None:
    """从分享卡片里摘出 B 站链接和标题；不是 B 站卡片返回 None。"""
    texts: list[str] = []
    _card_texts(getattr(comp, "data", None), texts)
    if not texts:
        return None
    blob = "\n".join(texts).replace("\\/", "/")
    match = _BILI_URL_RE.search(blob)
    if match:
        url = match.group(0).rstrip("，。；、）)]}。")
    else:
        bv = _BV_RE.search(blob)
        if not bv:
            return None
        url = "https://www.bilibili.com/video/" + bv.group(0)
    return {"url": url, "title": _card_title(getattr(comp, "data", None), "title")
            or _card_title(getattr(comp, "data", None), "desc")}


def _recall_error_code(exc: BaseException) -> str:
    """旧栈 classifyRecallError：把 OneBot 失败折成五类回执码。"""
    text = f"{exc}".lower()
    if "timeout" in text or "unavailable" in text or "network" in text:
        return "unavailable"
    if "not found" in text or "-404" in text:
        return "not-found"
    if "permission" in text or "forbidden" in text or "-403" in text:
        return "forbidden"
    if "expired" in text or "too old" in text:
        return "too-old"
    return "failed"


def _ledger_lookup(chat_key: str, message_id: str = "") -> dict[str, Any] | None:
    """读 bridge 台账（recall-ledger.jsonl）。target 为空时取同 chat 最近一条。"""
    try:
        with open(RECALL_LEDGER, "r", encoding="utf-8") as fh:
            rows = [json.loads(line) for line in fh if line.strip()]
    except FileNotFoundError:
        return None
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[xzy] 读撤回台账失败: {type(exc).__name__}: {exc}")
        return None
    hit = None
    for row in rows:
        if str(row.get("chat") or "") != chat_key:
            continue
        if message_id and str(row.get("message_id") or "") != message_id:
            continue
        hit = row
    return hit


def _notice_of(event: AstrMessageEvent) -> dict[str, str]:
    """OneBot notice 三元组：撤回通知的原始 message_id 只有 raw_message 里有。

    适配器给 notice 事件的 `message_obj.message_id` 是新生成的 uuid4
    （aiocqhttp_platform_adapter.py 的 notice 分支），不能拿来当被撤回的消息 id。
    """
    raw = getattr(getattr(event, "message_obj", None), "raw_message", None)
    if not isinstance(raw, dict):
        return {}
    if str(raw.get("post_type") or "") != "notice":
        return {}
    return {
        "type": str(raw.get("notice_type") or ""),
        "sub_type": str(raw.get("sub_type") or ""),
        "message_id": str(raw.get("message_id") or ""),
        "operator": str(raw.get("operator_id") or raw.get("user_id") or ""),
        "group_id": str(raw.get("group_id") or ""),
    }


class _Cell:
    """人维度：某人在某个 chat 里待处理的批次；出站只由该格的 owner_event 触发。"""

    __slots__ = ("key", "items", "owner_event", "ready", "verdict", "final_items", "context")

    def __init__(self, key: str) -> None:
        self.key = key
        self.items: list[dict[str, Any]] = []
        self.owner_event: Any = None
        self.ready = asyncio.Event()
        self.verdict: dict[str, Any] | None = None
        self.final_items: list[dict[str, Any]] = []
        self.context: list[dict[str, Any]] = []


class _GroupWindow:
    """群维度：一个 chat 共享的窗口时钟、消息时间线，以及按人拆开的格子。"""

    __slots__ = ("chat_key", "cells", "timeline", "first_mono", "last_mono", "delay", "closed")

    def __init__(self, chat_key: str) -> None:
        self.chat_key = chat_key
        self.cells: dict[str, _Cell] = {}
        self.timeline: list[dict[str, Any]] = []
        self.first_mono = 0.0
        self.last_mono = 0.0
        self.delay = 0.0
        self.closed = False


# --------------------------------------------------------------------------- #
# 插件入口
# --------------------------------------------------------------------------- #
class XzyPlugin(Star):
    def __init__(self, context: Context):
        super().__init__(context)
        global _CFG
        self.cfg = _load_config()
        _CFG = self.cfg
        self.degraded = False
        self._tasks: set[asyncio.Task] = set()
        self._tools: list[FunctionTool] = []
        self.presence: MoodStore | None = None
        self.typing = typing_indicator.TypingIndicator(self.cfg.get("typing") or {})
        # 群 × 人二维：chat_key -> 群窗口；窗口内 user_key -> 待处理格子
        self._buffers: dict[str, _GroupWindow] = {}
        self._judge_windows: dict[str, _GroupWindow] = {}
        self._dedup: dict[str, float] = {}
        self._limits: dict[str, dict[str, Any]] = {}
        # 拍回：chat#sender -> 上次回拍时刻（旧栈按 chatId+userId 冷却）
        self._poke_back_at: dict[str, float] = {}
        # 撤回收尾提示：umo -> [{at, text}]，on_llm_request 注入
        self._recall_notes: dict[str, list[dict[str, Any]]] = {}
        # 撤回墓碑：message_id -> 撤回时刻。窗口已弹出的批也要在送模型前按 id 摘掉
        self._recalled_ids: dict[str, float] = {}
        # 模型自主撤回：chat -> 撤回时刻列表（限频）；message_id -> 撤回时刻（防重复）
        self._recall_tool_hits: dict[str, list[float]] = {}
        self._recall_tool_at: dict[str, float] = {}
        self.vision = vision_state.VisionState(self.cfg.get("vision") or {}, STATE_DIR)
        _identity_cfg = self.cfg.get("identity")
        _identity_cfg = _identity_cfg if isinstance(_identity_cfg, dict) else {}
        self._identity_on = _identity_cfg.get("enabled") is not False
        try:
            self._identity_limit = max(1, min(10, int(_identity_cfg.get("injectLimit") or 3)))
        except (TypeError, ValueError):
            self._identity_limit = 3
        self.identity = identity_store.IdentityStore(
            str(_identity_cfg.get("dir") or "").strip() or identity_store.DEFAULT_DIR
        )
        tools_identity.configure(self.cfg, self.identity)
        image_prep.configure(self.cfg, STATE_DIR)

    async def initialize(self) -> None:
        _ensure_dirs()
        logger.info(
            f"[xzy] TARGET_VERSION={TARGET_VERSION} installed={installed_version()} "
            f"state={STATE_DIR}"
        )

        warnings = version_warnings()
        for w in warnings:
            logger.error(f"[xzy] 版本自检告警: {w}")
            _append_jsonl("version_warnings.jsonl", {"kind": "warning", "text": w})
        self.degraded = bool(warnings)
        if self.degraded:
            logger.error("[xzy] 进入 degraded：补丁或版本与锁定不一致，仅作观测，不保证行为")

        # 跨重载单例：同 pid 旧实例先收尾，防双份定时器
        old = getattr(sys, "_xzy_instance", None)
        if isinstance(old, XzyPlugin) and old is not self:
            logger.warning("[xzy] 发现旧实例，先 terminate 再接管")
            try:
                await old.terminate()
            except Exception as e:  # noqa: BLE001
                logger.error(f"[xzy] 旧实例 terminate 失败: {e}")
        sys._xzy_instance = self

        # 自迭代写入 hook：写完 xzy-config.json 后把值 patch 进运行中的 self.cfg。
        # 没注册成功时 mutation_policy 只返回 applied-pending-reload，不谎报已生效。
        mutation_policy.configure(self.cfg)
        registered = mutation_policy.register_apply_hook(self._apply_runtime_cfg)
        logger.info(
            f"[xzy] 自迭代写入 hook: {'已注册' if registered else '未注册（配置写入只会 applied-pending-reload）'} "
            f"output_spec={mutation_policy.output_spec_path()} revision={mutation_policy.spec_revision()}"
        )

        self.presence = MoodStore(PRESENCE_JSON)
        _p = self.presence.get("")
        logger.info(
            f"[xzy] presence 已加载: file={PRESENCE_JSON} "
            f"actors={len(_p.get('patienceByActor') or {})} "
            f"mood={_p.get('mood')} heat={_p.get('heat')} focus={_p.get('focus')}"
        )
        _append_jsonl(
            "presence.jsonl",
            {
                "kind": "startup_state",
                "file": PRESENCE_JSON,
                "actors": len(_p.get("patienceByActor") or {}),
                "mood": _p.get("mood"),
                "heat": _p.get("heat"),
                "focus": _p.get("focus"),
            },
        )
        debounce = self._debounce()
        logger.info(
            f"[xzy] 判定配置: profile={self.cfg.get('debounce_profile')} "
            f"debounce={debounce} judge_merge_ms={(self.cfg.get('judge') or {}).get('mergeWindowMs')} "
            f"trigger={self.cfg.get('trigger')} limits={self.cfg.get('limits')} "
            f"dnd={self.cfg.get('dnd')} access={self.cfg.get('access')}"
        )
        persona_inject.configure(self.cfg)
        loop_guard.configure(self.cfg)
        # 出站本地文件白名单 + 跨会话目标（master 才可指定别的 chat）
        media_fence.configure(self.cfg)
        # 夜间静默窗口：窗口内只拦长任务，秒级任务不受影响；配置改动需重载插件生效
        night_quiet.configure(self.cfg)
        _nq = night_quiet.status()
        logger.info(
            f"[xzy] 夜间静默窗口: enabled={_nq['enabled']} {_nq['windowLabel']} "
            f"longVideo>{_nq['longVideoSec']}s audit={_nq['auditPath']}"
        )
        # tool_calls 回合 content 标注：核心文件补丁要等进程重启才 import，
        # 这里挂一层让插件重载即生效（重复加载自动跳过）。
        _guard = tool_round_guard.install()
        logger.info(
            f"[xzy] tool_calls 回合标注: {'已挂载' if _guard else '未挂载（已挂载过或核心结构不符）'}"
        )
        tool_send.configure(self.cfg)
        bubbles.configure(self.cfg.get("bubbles"))
        _, meta = persona_inject.persona_text(self.cfg)
        _append_jsonl("persona.jsonl", {"kind": "startup", **meta})
        logger.info(f"[xzy] 人格只读注入源: {meta}")

        self._register_tools()
        logger.info(
            f"[xzy] 身份索引: enabled={self._identity_on} dir={self.identity.dir} "
            f"stats={self.identity.stats()}"
        )
        self._spawn(self._decay_loop())
        self._spawn(self._self_iter_auto_loop())
        logger.info(
            f"[xzy] 自迭代自动触发: {self.cfg.get('self_iter', {}).get('auto')} "
            f"（进程内定时器，只出提案）"
        )
        # B 站主动刷：旧栈 bili-proactive.mjs 的插件侧实现，空闲判据走本机回合台账
        # （与 self_iter.auto_gate 同口径），不再依赖已停用的 1240 proxy。
        bili_proactive.configure(self.cfg, self._send_proactive)
        _bp = bili_proactive.status()
        self._spawn(bili_proactive.run_loop())
        logger.info(
            f"[xzy] B站主动刷: enabled={_bp['enabled']} pause={_bp['paused']} "
            f"idle>={_bp['idleMinutes']}min gap>={_bp['minGapMinutes']}min "
            f"perHour<={_bp['maxPerHour']} visionQuiet={_bp['visionQuietSeconds']}s "
            f"platform={_bp['platform'] or '(未识别)'} "
            f"targets={[(t['kind'], t['id'], t['perDay']) for t in _bp['targets']]} "
            f"state={_bp['statePath']}"
        )
        logger.info("[xzy] initialize 完成（原生链路，未接管）")

    # -- 生命周期 -------------------------------------------------------- #
    def _spawn(self, coro) -> None:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _decay_loop(self) -> None:
        interval = int(self.cfg.get("presence_decay_interval_s", 300))
        while True:
            await asyncio.sleep(interval)
            if self.presence is None:
                continue
            state = self.presence.get("")
            _append_jsonl(
                "presence_decay.jsonl",
                {
                    "kind": "decay",
                    "mood": state.get("mood"),
                    "focus": state.get("focus"),
                    "heat": state.get("heat"),
                    "moodLevel": state.get("moodLevel"),
                },
            )

    async def _self_iter_auto_loop(self) -> None:
        """spec §16.2 的进程内定时器：存活方式是本进程里的 asyncio task。

        terminate 会 cancel 全部 `_tasks`，重载后由新实例重新拉起；宿主进程退出后
        就没有调度了——那种情况下只能靠外部调度（计划任务/守护）另行拉起。
        每次只调 `self_iter.auto_tick()`：它自己判闲时与频率，产出 pending 提案。
        """
        auto = self.cfg.get("self_iter", {})
        auto = auto.get("auto") if isinstance(auto, dict) else {}
        auto = auto if isinstance(auto, dict) else {}
        try:
            poll = max(15, min(900, int(auto.get("pollSeconds") or 60)))
        except (TypeError, ValueError):
            poll = 60
        await asyncio.sleep(min(30, poll))
        while True:
            try:
                out = await self_iter.auto_tick()
                if out.get("ran"):
                    logger.info(
                        f"[xzy] 自迭代自动触发: ok={out.get('ok')} code={out.get('code')} "
                        f"proposals={out.get('proposals')} idle_ms={out.get('idleMs')}"
                    )
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - 定时器不能因单次失败退出
                logger.error(f"[xzy] 自迭代自动触发失败: {e}")
            await asyncio.sleep(poll)

    async def _send_proactive(self, umo: str, text: str) -> bool:
        """主动刷分享的出口：按 umo 找到平台实例发一条纯文本（不经过 event 链路）。"""
        try:
            from astrbot.core.message.components import Plain
            from astrbot.core.message.message_event_result import MessageChain
        except ImportError as exc:
            logger.error(f"[xzy] 主动刷发送器缺少消息组件: {exc}")
            return False
        comps, _used = _face_comps(text)
        try:
            return bool(
                await self.context.send_message(
                    umo, MessageChain(comps if comps is not None else [Plain(text)])
                )
            )
        except Exception as e:  # noqa: BLE001 - 发送失败只记一条
            logger.error(f"[xzy] 主动刷分享发送失败 umo={umo} type={type(e).__name__} err={e}")
            return False

    async def terminate(self) -> None:
        try:
            await self.typing.shutdown()
        except Exception as e:  # noqa: BLE001
            logger.error(f"[xzy] typing shutdown 失败: {e}")
        tasks = list(self._tasks)
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()
        try:
            members.flush(force=True)
        except Exception:  # noqa: BLE001
            pass
        if getattr(sys, "_xzy_instance", None) is self:
            sys._xzy_instance = None
        logger.info(f"[xzy] terminate: 已取消 {len(tasks)} 个 task")

    # -- 自迭代写入 hook -------------------------------------------------- #
    def _apply_runtime_cfg(self, patch: dict[str, Any]) -> bool:
        """把已落盘的配置值 patch 进运行中的 self.cfg（_CFG 是同一对象）。

        只接受字典；空 patch 视为失败，让调用方落 applied-pending-reload。
        """
        if not isinstance(patch, dict) or not patch:
            return False
        for key, value in patch.items():
            if isinstance(value, dict):
                node = self.cfg.get(key)
                if not isinstance(node, dict):
                    node = {}
                    self.cfg[key] = node
                node.update(value)
            else:
                self.cfg[key] = value
        if "night_quiet" in patch:
            night_quiet.configure(self.cfg)
        logger.info(
            f"[xzy] 配置热更新: keys={sorted(patch)} dnd={self.cfg.get('dnd')}"
        )
        return True

    # -- 工具 ------------------------------------------------------------ #
    def _register_tools(self) -> None:
        self._tools = [
            FunctionTool(
                name="system_echo",
                description="连通性自检：原样返回给定文本，用于确认工具链路可用。",
                parameters={
                    "type": "object",
                    "properties": {"text": {"type": "string", "description": "要回显的文本"}},
                    "required": ["text"],
                },
                handler=tr.safe_call(
                    loop_guard.wrap_handler(system_echo, "system_echo"), "system_echo"
                ),
            ),
            FunctionTool(
                name="qq_recall",
                description=(
                    "撤回我自己在这条会话里发过的消息。只有当你自己觉得刚才那句话"
                    "说错了、或不该留在聊天记录里时才用；撤不了别人发的消息，"
                    "也不能跨会话撤。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "message_id": {
                            "type": "string",
                            "description": "要撤回的那条我自己发的消息 ID；省略时撤我最近发的一条",
                        }
                    },
                },
                handler=tr.safe_call(
                    loop_guard.wrap_handler(self._tool_recall, "qq_recall"), "qq_recall"
                ),
            ),
        ]
        # 迁移工具：共享层（tool_result / tool_schema / 本注册入口 / tool_send）由整合方维护，
        # 各路 worker 只提交自己的模块文件 + TOOL_SPECS，这里按模块列表合并。
        declared = len(self._tools)  # 内置 1 个 + 各模块声明
        _voice_on = bool((self.cfg.get("tts") or {}).get("enabled") is True)
        for module in TOOL_MODULES:
            module.configure(self.cfg)
            for spec in module.TOOL_SPECS:
                if spec["name"] in VOICE_TOOLS and not _voice_on:
                    continue
                declared += 1
                self._tools.append(
                    make_tool(
                        name=spec["name"],
                        description=spec["description"],
                        parameters=spec["parameters"],
                        handler=spec["handler"],
                    )
                )
        if not _voice_on:
            logger.warning(
                "[xzy] 语音出站已关闭（tts.enabled=false）：未注册 qq_send_tts / qq_send_voice"
            )
        self.context.add_llm_tools(*self._tools)
        names = [t.name for t in self._tools]
        if len(set(names)) != len(names):
            duplicated = sorted({n for n in names if names.count(n) > 1})
            logger.error(f"[xzy] 工具重名，注册失败: {duplicated}")
            raise RuntimeError(f"工具重名: {duplicated}")
        logger.info(
            f"[xzy] 工具注册: 声明={declared} 注册={len(self._tools)} 名称={names}"
        )
        if declared != len(self._tools):
            logger.error(
                f"[xzy] 声明数({declared}) != 注册数({len(self._tools)})，请检查 TOOL_SPECS"
            )

    # -- 配置读取 -------------------------------------------------------- #
    def _debounce(self) -> dict[str, Any]:
        base = dict(self.cfg.get("debounce") or DEFAULT_CONFIG["debounce"])
        if str(self.cfg.get("debounce_profile") or "aligned") == "fast":
            base = _deep_merge(base, self.cfg.get("debounce_fast") or {})
        return base

    def _judge_merge_s(self) -> float:
        judge = self.cfg.get("judge") or {}
        if judge.get("enabled") is False:
            return 0.0
        try:
            return max(0.0, float(judge.get("mergeWindowMs") or 0) / 1000.0)
        except (TypeError, ValueError):
            return 0.0

    # -- 原生钩子 -------------------------------------------------------- #
    def _actor_key(self, event: AstrMessageEvent) -> str:
        gid = str(event.get_group_id() or "")
        uid = str(event.get_sender_id() or "")
        return f"{gid}:{uid}" if gid else uid

    def _normalize_event(self, event: AstrMessageEvent) -> dict[str, Any]:
        group_id = str(event.get_group_id() or "")
        sender_id = str(event.get_sender_id() or "")
        self_id = str(event.get_self_id() or "")
        is_group = bool(group_id)
        texts: list[str] = []
        components: list[str] = []
        raw_components: list[Any] = []
        mentioned = quoted_me = at_other = quoted_other = at_all = has_reply = False
        reply_author_id = ""
        reply_author_nick = ""
        reply_text = ""
        reply_targets: list[str] = []
        media: list[str] = []
        image_refs: list[str] = []
        bili_cards: list[dict[str, str]] = []
        for comp in event.get_messages():
            ctype = _component_type(comp)
            components.append(ctype)
            raw_components.append(comp)
            if ctype == "Plain":
                texts.append(str(getattr(comp, "text", "")))
            elif ctype in ("At", "AtAll"):
                qq = str(getattr(comp, "qq", "") or ("all" if ctype == "AtAll" else ""))
                if qq and qq == "all":
                    at_all = True
                    texts.append("@全体成员 ")
                elif qq and self_id and qq == self_id:
                    mentioned = True
                    texts.append("@你 ")
                else:
                    if qq:
                        at_other = True
                    texts.append(f"@{qq} " if qq else "@ ")
            elif ctype == "Reply":
                has_reply = True
                sender = str(getattr(comp, "sender_id", "") or "")
                # 被引用那条的作者/原话/@ 目标：用于给模型「第三方视角」标注
                reply_author_id = reply_author_id or sender
                reply_author_nick = reply_author_nick or str(
                    getattr(comp, "sender_nickname", "") or ""
                )
                reply_text = reply_text or str(getattr(comp, "message_str", "") or "")
                for sub in (getattr(comp, "chain", None) or []):
                    stype = _component_type(sub)
                    if stype in ("At", "AtAll"):
                        qq = str(
                            getattr(sub, "qq", "") or ("all" if stype == "AtAll" else "")
                        )
                        if qq and qq not in reply_targets:
                            reply_targets.append(qq)
                if sender and self_id and sender == self_id:
                    quoted_me = True
                elif sender:
                    quoted_other = True
                texts.append("[引用] ")
            elif ctype == "Face":
                # QQ 原生表情：id 是情绪信息（[CQ:face,id=277] → 汪汪），不能只留 [Face]
                texts.append(faces.label(getattr(comp, "id", "")))
                media.append(ctype)
            elif ctype in ("Json", "Xml"):
                card = _bili_card(comp)
                if card is not None:
                    bili_cards.append(card)
                    head = f"[转发的B站视频]《{card['title']}》" if card["title"] else "[转发的B站视频]"
                    card["label"] = f"{head} {card['url']}"
                    texts.append(f"{card['label']} ")
                else:
                    label = _COMPONENT_TEXT.get(ctype, f"[{ctype}]")
                    texts.append(label)
                    media.append(ctype)
            else:
                label = _COMPONENT_TEXT.get(ctype, f"[{ctype}]")
                texts.append(label)
                media.append(ctype)
                if ctype == "Image":
                    ref = str(getattr(comp, "url", "") or getattr(comp, "file", "") or "")
                    if ref:
                        image_refs.append(ref)
        # forward id 与 video 源地址只在原始报文里，组件层拿不到（见 inbound_expand 注释）
        forward_ids = inbound_expand.collect_forward_ids(event)
        video_segs = inbound_expand.collect_video_segments(event)
        return {
            "umo": event.unified_msg_origin,
            "trace": f"tk-{uuid.uuid4().hex[:12]}",
            "chat": "group" if is_group else "private",
            "group_id": group_id,
            "self_id": self_id,
            "sender": sender_id,
            "nick": event.get_sender_name(),
            "is_master": sender_id == str(self.cfg.get("master_qq", "")),
            "is_private": not is_group,
            "text": "".join(texts).strip(),
            "components": components,
            "raw": raw_components,
            "media": media,
            "image_refs": image_refs,
            "bili_cards": bili_cards,
            "forward_ids": forward_ids,
            "video_segs": video_segs,
            "notice": _notice_of(event),
            "mentioned": mentioned,
            "at_all": at_all,
            "quoted_me": quoted_me,
            "quoted_other": quoted_other,
            "has_reply": has_reply,
            "at_other": at_other,
            "reply_author_id": reply_author_id,
            "reply_author_nick": reply_author_nick,
            "reply_text": reply_text,
            "reply_targets": reply_targets,
            "addressed_elsewhere": at_other or quoted_other,
            "message_id": str(getattr(getattr(event, "message_obj", None), "message_id", "") or ""),
        }

    # -- 去重（policy.js dedup：chatId#messageId，dedupWindowSec） --------- #
    def _is_duplicate(self, chat_key: str, message_id: str, now: float) -> bool:
        if not message_id:
            return False
        key = f"{chat_key}#{message_id}"
        window = float(self.cfg.get("dedupWindowSec", 300))
        prior = self._dedup.get(key)
        if prior is not None and now - prior < window:
            return True
        self._dedup[key] = now
        if len(self._dedup) > 4096:
            cutoff = now - window
            self._dedup = {k: v for k, v in self._dedup.items() if v >= cutoff}
            if len(self._dedup) > 4096:
                for k in list(self._dedup)[: len(self._dedup) - 4096]:
                    self._dedup.pop(k, None)
        return False

    # -- 撤回（旧栈 recall.js：handleNotice / handleCommand） -------------- #
    async def _handle_recall_notice(
        self, entry: dict[str, Any], chat_key: str
    ) -> None:
        """入站撤回：取消待发批 + 收尾提示；不再连带撤回自己的回复（模型自主决定）。"""
        notice = entry.get("notice") or {}
        message_id = str(notice.get("message_id") or "")
        operator = str(notice.get("operator") or "")
        self_recall = bool(entry["self_id"]) and operator == entry["self_id"]
        self._mark_recalled(message_id)
        cancelled = self._cancel_pending(chat_key, message_id)
        if self_recall and message_id:
            self._remember_recall_note(entry["umo"], message_id)
        # 来源消息被撤回 -> 对应笔记条目退出检索（对齐旧栈 applyRevocations）
        revoked: dict[str, Any] = {"changed": [], "cascaded": []}
        if message_id:
            try:
                revoked = tools_memory.revoke_source(message_id, operator)
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"[xzy] 撤回联动记忆失败: {type(exc).__name__}: {exc}")
        _append_jsonl(
            "recall.jsonl",
            {
                "kind": "notice",
                "notice_type": notice.get("type"),
                "sub_type": notice.get("sub_type"),
                "umo": entry["umo"],
                "chat": chat_key,
                "message_id": message_id,
                "operator": operator,
                "self_recall": self_recall,
                "cancelled": cancelled,
                "memory_changed": len(revoked.get("changed") or []),
                "memory_cascaded": len(revoked.get("cascaded") or []),
            },
        )
        logger.info(
            f"[xzy] 撤回通知: chat={chat_key} id={message_id} operator={operator} "
            f"self={self_recall} 取消待发={cancelled} "
            f"记忆失效={len(revoked.get('changed') or [])}"
        )

    def _mark_recalled(self, message_id: str) -> None:
        """打撤回墓碑：窗口已弹出的批也要在送模型前按 id 摘掉。"""
        if not message_id:
            return
        now = time.time()
        self._recalled_ids[message_id] = now
        if len(self._recalled_ids) > 2048:
            cutoff = now - RECALL_NOTE_TTL_SEC
            self._recalled_ids = {
                k: v for k, v in self._recalled_ids.items() if v >= cutoff
            }

    def _is_recalled(self, entry: dict[str, Any]) -> bool:
        mid = str(entry.get("message_id") or "")
        if not mid:
            return False
        at = self._recalled_ids.get(mid)
        if at is None:
            return False
        if time.time() - at > RECALL_NOTE_TTL_SEC:
            self._recalled_ids.pop(mid, None)
            return False
        return True

    def _cancel_pending(self, chat_key: str, message_id: str) -> int:
        """从群窗口/人格子与 judge 窗里删掉被撤回的条目；删空的格子直接不出站。"""
        if not message_id:
            return 0
        removed = 0
        for store in (self._buffers, self._judge_windows):
            gw = store.get(chat_key)
            if gw is None:
                continue
            gw.timeline = [
                e for e in gw.timeline if str(e.get("message_id") or "") != message_id
            ]
            for cell in list(gw.cells.values()):
                keep = [
                    it
                    for it in cell.items
                    if str(it["entry"].get("message_id") or "") != message_id
                ]
                if len(keep) == len(cell.items):
                    continue
                removed += len(cell.items) - len(keep)
                cell.items = keep
                if keep:
                    cell.owner_event = keep[-1]["event"]
                else:
                    cell.owner_event = None
                    cell.verdict = None
                    cell.final_items = []
                    cell.ready.set()
        return removed

    def _remember_recall_note(self, umo: str, message_id: str) -> None:
        """旧栈 afterOwnRecall：让模型知道那句已撤回，不要当成说过的话。"""
        now = time.time()
        notes = [
            n
            for n in self._recall_notes.get(umo, [])
            if now - float(n.get("at") or 0) <= RECALL_NOTE_TTL_SEC
        ]
        notes.append(
            {
                "at": now,
                "text": (
                    f"[撤回] 我刚才发出的那条消息已撤回（messageId={message_id}），"
                    "后续不要把它当成我说过的话，也不要复述它。"
                ),
            }
        )
        self._recall_notes[umo] = notes[-RECALL_NOTE_MAX:]

    def _recall_lines(self, umo: str) -> str:
        now = time.time()
        notes = [
            n
            for n in self._recall_notes.get(umo, [])
            if now - float(n.get("at") or 0) <= RECALL_NOTE_TTL_SEC
        ]
        if not notes:
            return ""
        self._recall_notes[umo] = notes
        return "\n".join(str(n["text"]) for n in notes)

    async def _recall_command(
        self, entry: dict[str, Any], chat_key: str, event: AstrMessageEvent
    ) -> None:
        """`/撤回 [messageId]`：仅主人；缺省撤本会话最近一条自己发出的。"""
        m = _RECALL_CMD_RE.match(entry["text"] or "")
        target = (m.group(1) if m else "") or ""
        if not entry["is_master"]:
            _append_jsonl(
                "recall.jsonl",
                {"kind": "command", "chat": chat_key, "result": "forbidden",
                 "operator": entry["sender"], "message_id": target},
            )
            await event.send(event.plain_result("撤回失败：这个指令只有主人能用。"))
            return
        rec = _ledger_lookup(chat_key, target)
        if rec is None:
            _append_jsonl(
                "recall.jsonl",
                {"kind": "command", "chat": chat_key, "result": "not-found",
                 "operator": entry["sender"], "message_id": target},
            )
            await event.send(event.plain_result("撤回失败：这个会话里没有我发出的那条消息记录。"))
            return
        message_id = str(rec.get("message_id") or "")
        age = time.time() - float(rec.get("at") or 0)
        if age > RECALL_INBOUND_WINDOW_SEC:
            _append_jsonl(
                "recall.jsonl",
                {"kind": "command", "chat": chat_key, "result": "too-old",
                 "operator": entry["sender"], "message_id": message_id, "age": round(age, 1)},
            )
            await event.send(
                event.plain_result(f"撤回失败：超过可撤回时限（{int(age)} 秒前发的）。")
            )
            return
        bot = getattr(event, "bot", None)
        try:
            if bot is None or not hasattr(bot, "call_action"):
                raise RuntimeError("bot 不可用")
            await bot.call_action("delete_msg", message_id=int(message_id))
        except Exception as exc:  # noqa: BLE001
            code = _recall_error_code(exc)
            _append_jsonl(
                "recall.jsonl",
                {"kind": "command", "chat": chat_key, "result": "failed",
                 "operator": entry["sender"], "message_id": message_id,
                 "code": code, "error": f"{type(exc).__name__}: {exc}"},
            )
            logger.warning(f"[xzy] /撤回 失败 id={message_id} code={code}: {exc}")
            await event.send(event.plain_result(f"撤回失败：{code}。"))
            return
        _append_jsonl(
            "recall.jsonl",
            {"kind": "command", "chat": chat_key, "result": "recalled",
             "operator": entry["sender"], "message_id": message_id, "age": round(age, 1)},
        )
        await event.send(event.plain_result(f"已撤回（messageId={message_id}）。"))

    async def _tool_recall(
        self, event: AstrMessageEvent = None, message_id: str = "", **_: Any
    ) -> dict[str, Any]:
        """模型自主撤回：只认 bridge 台账里「我自己发出的」消息，失败回 code。

        权限与归属判断：
        - 台账 `recall-ledger.jsonl` 由 bridge 在 `send_private_msg/send_group_msg` 成功时写入，
          只包含机器人自己发出的 message_id，因此「在台账里」= 归属成立；
        - 只能撤当前会话（群号 / private:<QQ>）的记录，跨会话一律拒绝；
        - 不在台账里的 id → blocked，不触达 QQ。
        """
        if event is None:
            return tr.result_fail("internal", "缺少事件上下文", final=True)
        gid = str(event.get_group_id() or "")
        chat_key = gid if gid else f"private:{event.get_sender_id()}"
        wanted = str(message_id or "").strip()
        rec = _ledger_lookup(chat_key, wanted)
        if rec is None:
            _append_jsonl(
                "recall.jsonl",
                {"kind": "tool", "chat": chat_key, "result": "not-found",
                 "message_id": wanted},
            )
            return tr.result_blocked(
                "missing-target",
                "这条不在我的发送台账里，撤不了（只能撤我自己发出的消息）。",
                "确认要撤的是不是我自己发的那条；不是就别再调这个工具。",
                final=True,
            )
        mid = str(rec.get("message_id") or "")
        now = time.time()
        if now - float(self._recall_tool_at.get(mid) or 0) < RECALL_TOOL_WINDOW_SEC:
            return tr.result_done("already-done", "这条已经撤过了", "")
        hits = [
            t for t in self._recall_tool_hits.get(chat_key, [])
            if now - t < RECALL_TOOL_WINDOW_SEC
        ]
        if len(hits) >= RECALL_TOOL_MAX:
            _append_jsonl(
                "recall.jsonl",
                {"kind": "tool", "chat": chat_key, "result": "rate-limited",
                 "message_id": mid},
            )
            return tr.result_blocked(
                "cooldown",
                f"这个会话 {int(RECALL_TOOL_WINDOW_SEC / 60)} 分钟内已经撤了 "
                f"{RECALL_TOOL_MAX} 条，不再撤。",
                "不要重试，也不要为此解释；继续说别的。",
                final=True,
            )
        bot = getattr(event, "bot", None)
        try:
            if bot is None or not hasattr(bot, "call_action"):
                raise RuntimeError("bot 不可用")
            await bot.call_action(
                "delete_msg", message_id=int(mid) if mid.isdigit() else mid
            )
        except Exception as exc:  # noqa: BLE001
            code = _recall_error_code(exc)
            _append_jsonl(
                "recall.jsonl",
                {"kind": "tool", "chat": chat_key, "result": "failed",
                 "message_id": mid, "code": code,
                 "error": f"{type(exc).__name__}: {exc}"},
            )
            logger.warning(f"[xzy] qq_recall 失败 id={mid} code={code}: {exc}")
            return tr.result_fail(
                "failed",
                f"撤回没有成功（{code}）。到此为止，不要重试，也不要把系统错误说给对方。",
                "",
                final=True,
            )
        self._recall_tool_at[mid] = now
        self._recall_tool_hits[chat_key] = (hits + [now])[-8:]
        _append_jsonl(
            "recall.jsonl",
            {"kind": "tool", "chat": chat_key, "result": "recalled",
             "message_id": mid, "age": round(now - float(rec.get("at") or 0), 1)},
        )
        logger.info(f"[xzy] 模型自主撤回: chat={chat_key} id={mid}")
        return tr.result_ok(
            "已撤回我刚才发的那条",
            messageId=mid,
            next_="被撤的那句不要再复述；对方问起就简短说明，不要解释撤回机制。",
        )

    # -- 拍回（旧栈 bridge.js:933-1031） ---------------------------------- #
    def _maybe_poke_back(self, event: AstrMessageEvent, entry: dict[str, Any]) -> None:
        """只回拍「拍机器人自己」的那一下；冷却 5s，延迟 2s，失败静默。"""
        target = ""
        for comp, ctype in zip(entry["raw"], entry["components"]):
            if ctype == "Poke":
                target = str(getattr(comp, "qq", "") or "")
                break
        self_id = entry["self_id"]
        poker = entry["sender"]
        if not target or not self_id or target != self_id:
            return
        if not poker or poker == self_id:
            return
        key = f"{entry['group_id'] or 'private'}#{poker}"
        now = time.monotonic()
        last = self._poke_back_at.get(key)
        if last is not None and now - last < POKE_BACK_COOLDOWN_SEC:
            logger.info(
                f"[xzy] 拍回冷却中，跳过: key={key} 间隔={now - last:.1f}s"
            )
            return
        self._poke_back_at[key] = now
        params: dict[str, Any] = {"user_id": int(poker)}
        if entry["group_id"]:
            params["group_id"] = int(entry["group_id"])
        bot = getattr(event, "bot", None)

        async def _fire() -> None:
            await asyncio.sleep(POKE_BACK_DELAY_SEC)
            try:
                if bot is None or not hasattr(bot, "call_action"):
                    raise RuntimeError("bot 不可用")
                await bot.call_action("send_poke", **params)
                logger.info(f"[xzy] 已自动拍回: key={key}")
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    f"[xzy] 自动拍回失败（静默）: key={key} "
                    f"{type(exc).__name__}: {exc}"
                )

        logger.info(
            f"[xzy] 被拍一拍: key={key}，{POKE_BACK_DELAY_SEC:.0f}s 后回拍"
        )
        self._spawn(_fire())

    # -- 视觉（旧栈 vision.mjs 的 observeImage / noteForChat） ------------- #
    async def _observe_image(self, entry: dict[str, Any], chat_key: str) -> None:
        refs = list(entry.get("image_refs") or [])
        if not refs:
            return
        umo = entry["umo"]

        async def _caption(prompt: str, image_url: str) -> str:
            provider = self.context.get_using_provider(umo)
            if provider is None:
                raise RuntimeError("没有可用的对话模型")
            path = await image_prep.shrink_one(image_url)
            if not path:
                raise RuntimeError("图片压缩失败，跳过观察")
            resp = await provider.text_chat(
                prompt=prompt, image_urls=[path], contexts=[]
            )
            return str(getattr(resp, "completion_text", "") or "")

        try:
            await self.vision.observe(refs[0], chat_key, _caption)
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[xzy] 视觉观察失败（不影响回合）: {type(exc).__name__}: {exc}")

        # 身份索引：视觉特征产出后 observe()（spec §3.3）。只在外形特征可解析时落库；
        # 失败只记审计，不影响回合、不影响上面的画面记录。
        if not self._identity_on:
            return
        ref = str(refs[0])
        try:
            raw = await _caption(IDENTITY_PROMPT, ref)
            feats = _json_object(raw)
            if not feats:
                self.identity.audit(
                    {"action": "observe-empty", "ref": ref, "head": str(raw)[:200]}
                )
                return
            record = self.identity.observe(
                feats,
                {
                    "ref": ref,
                    "material": "chat-image",
                    "at": int(time.time() * 1000),
                },
                group_id=str(entry.get("group_id") or ""),
                source="chat-image",
            )
            self.identity.audit(
                {
                    "action": "observe",
                    "ref": ref,
                    "identityId": record.get("id"),
                    "signature": record.get("signature"),
                    "features": feats,
                    "evidence": len(record.get("evidence") or []),
                    "count": record.get("count"),
                }
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                f"[xzy] 身份观察失败（不影响回合）: {type(exc).__name__}: {exc}"
            )
            self.identity.audit(
                {
                    "action": "observe-failed",
                    "ref": ref,
                    "error": f"{type(exc).__name__}: {exc}",
                }
            )

    # -- 防抖（policy.js shouldDebounce / enqueue） ----------------------- #
    def _should_debounce(self, entry: dict[str, Any]) -> bool:
        debounce = self._debounce()
        if debounce.get("enabled") is not True:
            return False
        if entry["sender"] and entry["sender"] == entry["self_id"]:
            return False
        if entry["has_reply"]:
            return False
        if "Forward" in entry["components"]:
            return False
        if re.match(r"^\s*/", entry["text"]):
            return False
        return True

    def _is_empty_mention(self, entry: dict[str, Any]) -> bool:
        """「只有 @、没有正文」：有 At 段，且除 At/AtAll 外没有任何内容段。

        不能用 entry["text"] 判断——@ 会被渲染成「@你 」，永远非空。
        """
        has_at = False
        for comp in entry.get("raw") or []:
            ctype = _component_type(comp)
            if ctype in ("At", "AtAll"):
                has_at = True
                continue
            if ctype == "Plain":
                if str(getattr(comp, "text", "") or "").strip():
                    return False
                continue
            # 图片/表情/语音/引用等都算有内容（图片另有 imageMs 优先）
            return False
        return has_at

    def _delay_s(self, entry: dict[str, Any]) -> float:
        debounce = self._debounce()
        base = float(debounce.get("baseMs") or 2500) / 1000.0
        if "Image" in entry["components"]:
            return max(base, float(debounce.get("imageMs") or 9000) / 1000.0)
        if entry["chat"] == "group" and self._is_empty_mention(entry):
            return max(base, float(debounce.get("emptyMentionMs") or 10000) / 1000.0)
        if entry["chat"] == "group":
            return max(base, float(debounce.get("groupMs") or 4000) / 1000.0)
        return base

    def _enqueue(
        self,
        store: dict[str, _GroupWindow],
        chat_key: str,
        user_key: str,
        event: AstrMessageEvent,
        entry: dict[str, Any],
        delay_s: float,
        max_batch: int,
        judge_merge_s: float = 0.0,
    ) -> _Cell:
        """群维度开窗（一次性定时器），人维度入格；同群不同人各占一格。"""
        now = time.monotonic()
        gw = store.get(chat_key)
        if gw is None:
            gw = _GroupWindow(chat_key)
            gw.first_mono = now
            store[chat_key] = gw
            if judge_merge_s > 0:
                self._spawn(self._run_judge_window(gw, judge_merge_s))
            else:
                self._spawn(self._run_debounce_window(gw))
        cell = gw.cells.get(user_key)
        if cell is None:
            cell = _Cell(user_key)
            gw.cells[user_key] = cell
        cell.items.append({"event": event, "entry": entry})
        cell.owner_event = event
        gw.timeline.append(entry)
        gw.last_mono = now
        gw.delay = max(0.05, delay_s)

        if max_batch > 0 and len(cell.items) > max_batch:
            overflow = cell.items[:-max_batch]
            del cell.items[: len(overflow)]
            for item in overflow:
                self._audit_row(
                    item["entry"],
                    should=False,
                    skip="drop:overflow",
                    gate="debounce",
                    reason="超出 maxBatch，按现网 slice(-maxBatch) 丢弃",
                    merged_count=len(cell.items) + len(overflow),
                )
        return cell

    async def _run_debounce_window(self, gw: _GroupWindow) -> None:
        """群维度拍板：窗口时长只由本群最新一条决定，关闭后按人格并发判定。"""
        debounce = self._debounce()
        hard = float(debounce.get("hardMs") or 0) / 1000.0
        try:
            while True:
                if self._buffers.get(gw.chat_key) is not gw:
                    return
                deadline = gw.last_mono + gw.delay
                if hard > 0:
                    deadline = min(gw.first_mono + hard, deadline)
                now = time.monotonic()
                if now < deadline:
                    # 轮询：群内新消息可能把窗口从「含图 7s」改回「群 2.2s」
                    await asyncio.sleep(min(deadline - now, 0.05))
                    continue
                if self._buffers.get(gw.chat_key) is gw:
                    self._buffers.pop(gw.chat_key, None)
                gw.closed = True
                await self._resolve_debounce(gw)
                return
        except asyncio.CancelledError:
            for cell in gw.cells.values():
                cell.ready.set()
            raise
        except Exception:
            logger.exception("[xzy] 防抖窗口处理异常")
        finally:
            for cell in gw.cells.values():
                cell.ready.set()

    async def _resolve_debounce(self, gw: _GroupWindow) -> None:
        async def one(cell: _Cell) -> None:
            cell.context = [e for e in gw.timeline if e["sender"] != cell.key]
            try:
                verdict, items = await self._decide_batch(cell.owner_event, cell.items, allow_merge=True)
            except Exception:
                logger.exception("[xzy] 批次判定异常")
                verdict, items = None, cell.items
            cell.verdict = verdict
            cell.final_items = items
            cell.ready.set()

        await asyncio.gather(*(one(cell) for cell in gw.cells.values()))

    async def _run_judge_window(self, gw: _GroupWindow, merge_s: float) -> None:
        """judge 合并窗：按群计时（从首条进入算起、不顺延），按人格各判各的。"""
        deadline = gw.first_mono + merge_s
        try:
            while True:
                if self._judge_windows.get(gw.chat_key) is not gw:
                    return
                now = time.monotonic()
                if now < deadline:
                    await asyncio.sleep(min(deadline - now, 0.05))
                    continue
                if self._judge_windows.get(gw.chat_key) is gw:
                    self._judge_windows.pop(gw.chat_key, None)
                gw.closed = True
                await self._resolve_judge(gw)
                return
        except asyncio.CancelledError:
            for cell in gw.cells.values():
                cell.ready.set()
            raise
        except Exception:
            logger.exception("[xzy] judge 窗口处理异常")
        finally:
            for cell in gw.cells.values():
                cell.ready.set()

    # -- 判定上下文：会话历史（含机器人自己的话）+ 统一记忆检索 ---------- #
    async def _conversation_history(self, umo: str) -> Any:
        """读本会话已落库的原生 history；读不到就返回空，不影响判定。"""
        try:
            cm = getattr(self.context, "conversation_manager", None)
            if cm is None or not umo:
                return []
            conversation_id = await cm.get_curr_conversation_id(umo)
            if not conversation_id:
                return []
            conversation = await cm.get_conversation(umo, conversation_id)
            return getattr(conversation, "history", None) or []
        except Exception as exc:  # noqa: BLE001
            logger.debug(f"[xzy] 读取会话历史失败（不影响判定）: {type(exc).__name__}: {exc}")
            return []

    async def _judge_prompt_extras(
        self, entries: list[dict[str, Any]], event: Any
    ) -> tuple[list[str], str, dict[str, Any], dict[str, Any]]:
        """判定侧上下文：会话历史 + 统一记忆 + 结构化字段（三样都写进 judge_context）。"""
        opts = {**persona_inject.DEFAULT_MEMORY, **(self.cfg.get("memory_inject") or {})}
        umo = str(entries[-1].get("umo") or "")
        history = await self._conversation_history(umo)
        history_lines = memory_ctx.format_history(
            history,
            turns=int(opts.get("judge_history_turns") or 2),
            max_chars=int(opts.get("judge_history_max_chars") or 480),
        )
        scene = persona_inject.scene_of(event, self.cfg) if event is not None else None
        recent = memory_ctx.history_user_texts(history, int(opts.get("query_messages") or 4))
        query = memory_ctx.query_text(recent, str(entries[-1].get("text") or ""))
        memory = memory_ctx.retrieve(
            self.cfg,
            scene,
            query,
            limit=int(opts.get("judge_detail_limit") or 4),
            max_chars=int(opts.get("judge_detail_max_chars") or 600),
            min_score=float(opts.get("min_score") or 0.75),
            include_diary=bool(opts.get("diary_enabled", True)),
            diary_lines=int(opts.get("diary_scan_lines") or memory_ctx.DIARY_SCAN_LINES),
        )
        fields = continuation.build_fields(
            entries,
            history_lines,
            umo=umo,
            audit_path=os.path.join(AUDIT_DIR, "outbound.jsonl"),
        )
        return history_lines, memory["block"], fields, memory["stats"]

    def _judge_audit(
        self,
        entries: list[dict[str, Any]],
        fields: dict[str, Any],
        history_lines: list[str],
        memory_stats: dict[str, Any],
        rule_hit: str,
        model_called: bool,
        model_decision: dict[str, Any] | None,
        verdict: dict[str, Any],
    ) -> None:
        """判定可统计：给了哪些字段、哪条规则先命中、模型判了什么、最终结论。"""
        _append_jsonl(
            "judge_context.jsonl",
            {
                "umo": str(entries[-1].get("umo") or ""),
                "message_id": entries[-1].get("message_id"),
                "history_lines": len(history_lines),
                "history_chars": sum(len(line) for line in history_lines),
                "memory_ids": memory_stats.get("memory_entry_ids") or [],
                "memory_sources": memory_stats.get("memory_sources") or [],
                "memory_chars": memory_stats.get("memory_detail_chars") or 0,
                "memory_truncated": memory_stats.get("memory_truncated") is True,
                "fields": fields,
                "rule_hit": rule_hit,
                "model_called": model_called,
                "model_decision": model_decision,
                "final": {
                    "speak": bool(verdict.get("speak")),
                    "addressed_to_bot": bool(verdict.get("addressed_to_bot")),
                    "should_reply": bool(verdict.get("should_reply")),
                    "rule": verdict.get("rule"),
                    "gate": verdict.get("gate"),
                    "reason": verdict.get("reason"),
                },
            },
        )

    async def _judge_verdict(
        self, entries: list[dict[str, Any]], event: Any
    ) -> dict[str, Any]:
        """规则优先、模型兜底：命中 R1/R2 不进模型。"""
        history_lines, memory_block, fields, memory_stats = await self._judge_prompt_extras(
            entries, event
        )
        rule_hit, verdict = continuation.decide(fields, self.cfg)
        model_called = verdict is None
        if model_called:
            verdict = await judge_mod.judge_model(
                entries, self.cfg, history_lines, memory_block, fields
            )
            model_decision = {
                "addressed_to_bot": verdict.get("addressed_to_bot"),
                "should_reply": verdict.get("should_reply"),
                "speak": bool(verdict.get("speak")),
                "rule": verdict.get("rule"),
            }
        else:
            model_decision = None
        self._judge_audit(
            entries,
            fields,
            history_lines,
            memory_stats,
            rule_hit,
            model_called,
            model_decision,
            verdict,
        )
        return verdict

    async def _resolve_judge(self, gw: _GroupWindow) -> None:
        async def one(cell: _Cell) -> None:
            batch = policy.make_batch([it["entry"] for it in cell.items], self.cfg)
            verdict = policy.decide(batch, self.cfg, self._limits)
            if not verdict["speak"] and str(verdict["rule"]).startswith("no:"):
                # 现网 judge 分支不走 policy.decide：模型放行即放行，不再叠 replyChance/limits。
                # 规则优先（R1/R2 不调模型），灰区才问 1240。
                verdict = await self._judge_verdict(batch["entries"], cell.owner_event)
            cell.verdict = verdict
            cell.final_items = cell.items
            cell.ready.set()

        await asyncio.gather(*(one(cell) for cell in gw.cells.values()))

    # -- 判定 ------------------------------------------------------------ #
    def _judge_eligible(self, batch: dict[str, Any]) -> bool:
        if batch["kind"] != "group":
            return False
        # 现网 judgeEligible 末尾的 && !awaitingImage：等图回图不交给 judge
        if any(it.get("awaiting_image") for it in (batch.get("entries") or [])):
            return False
        judge = self.cfg.get("judge") or {}
        if judge.get("enabled") is False:
            return False
        groups = [str(g) for g in (judge.get("groups") or [])]
        if batch["group_id"] not in groups:
            return False
        # 现网 judgeEligible：!mentioned && !banter && !masterBypass
        return not (
            batch["at_me"]
            or batch["name_hit"]
            or batch["reply_to_bot"]
            or batch["master_bypass"]
            or batch["banter"]
        )

    def _free_chat_verdict(self, batch: dict[str, Any]) -> dict[str, Any] | None:
        """自由参与群：不看 @、不走「是否指向机器人」判定；只做 dnd/access 与按群节流。

        返回 None 表示这个群不在这份配置里（走原来的规则）。配置形状：
        free_chat.groups[群号] = {minIntervalSec, perMinute, perHour}；出现即启用。
        """
        fc = self.cfg.get("free_chat") or {}
        if fc.get("enabled") is False or batch["kind"] != "group":
            return None
        gid = str(batch.get("group_id") or "")
        spec = (fc.get("groups") or {}).get(gid)
        if not isinstance(spec, dict) or spec.get("enabled") is False:
            return None

        def verdict(speak: bool, rule: str, reason: str, gate: str) -> dict[str, Any]:
            return {
                "speak": speak,
                "addressed_to_bot": False,
                "should_reply": speak,
                "reason": reason,
                "rule": rule,
                "gate": gate,
                "details": {
                    "free_chat": True,
                    "group_id": gid,
                    "limits": {
                        "minIntervalSec": spec.get("minIntervalSec"),
                        "perMinute": spec.get("perMinute"),
                        "perHour": spec.get("perHour"),
                    },
                    # 对账用：自由群必须能事后看出「这条冲着谁说的」
                    "addressed_elsewhere": bool(batch.get("addressed_elsewhere")),
                    "at_others": bool(batch.get("at_others")),
                    "reply_to_other": bool(batch.get("reply_to_other")),
                    "third_party": bool(batch.get("reply_to_other")),
                },
            }

        if policy.in_dnd(self.cfg):
            v = verdict(False, "dnd", "免打扰时段，自由群也不开口", "rule")
        else:
            ok, arule, areason = policy.access_allowed(
                batch["kind"], batch["user_id"], gid, batch["chat_id"], self.cfg
            )
            if not ok:
                v = verdict(False, arule, areason, "rule")
            elif batch.get("at_others_only"):
                # @别人（不是引用）：一律不插嘴。21:55:58 @4017642686 你叫什么 曾在这里被放行。
                v = verdict(False, "free:skip-at-other", "自由群，但这条 @ 的是别人", "rule")
            elif batch.get("at_all"):
                # @全体不是点名，也不是「别人对别人的对话」，自由群不因它开口
                v = verdict(False, "free:skip-at-all", "自由群，但这条是 @全体", "rule")
            else:
                limit_cfg = {
                    "limits": {
                        "cooldownSec": float(spec.get("minIntervalSec") or 0),
                        "perMinute": int(spec.get("perMinute") or 0),
                        "perHour": int(spec.get("perHour") or 0),
                    }
                }
                state = _FREE_STATE.setdefault(gid, {})
                passed, lrule, lreason = policy.check_limits(
                    state, gid, limit_cfg, time.time() * 1000
                )
                slot = state.get(gid) or {}
                if not passed:
                    v = verdict(False, lrule, lreason, "limit")
                elif batch.get("reply_to_other"):
                    # 引用别人的话：可以开口，但按第三方旁观插一句（上下文里带角色标注）
                    v = verdict(
                        True,
                        "free:chat-third-party",
                        "自由群：引用的是别人的话，按第三方旁观插一句",
                        "rule",
                    )
                else:
                    v = verdict(
                        True,
                        "free:chat",
                        "自由参与群：不看 @、不走判定",
                        "rule",
                    )
                v["details"]["counts"] = {
                    "minute": len(slot.get("minute") or []),
                    "hour": len(slot.get("hour") or []),
                }

        last = (batch.get("entries") or [{}])[-1]
        _append_jsonl(
            "free_chat.jsonl",
            {
                "group_id": gid,
                "chat": batch.get("chat_id"),
                "user_id": batch.get("user_id"),
                "message_id": last.get("message_id"),
                "trace": last.get("trace"),
                "items": len(batch.get("entries") or []),
                "speak": v["speak"],
                "rule": v["rule"],
                "reason": v["reason"],
                "details": v["details"],
            },
        )
        if v["gate"] == "limit":
            logger.info(f"[xzy] 自由群节流 {gid}: {v['rule']} {v['reason']}")
        return v

    def _enqueue_judge(
        self, chat_key: str, user_key: str, event: AstrMessageEvent, items: list[dict[str, Any]], merge_s: float
    ) -> _Cell:
        """judge 窗也是二维：群开一个 5s 窗，人格各自一格。"""
        now = time.monotonic()
        gw = self._judge_windows.get(chat_key)
        if gw is None:
            gw = _GroupWindow(chat_key)
            gw.first_mono = now
            self._judge_windows[chat_key] = gw
            self._spawn(self._run_judge_window(gw, merge_s))
        cell = gw.cells.get(user_key)
        if cell is None:
            cell = _Cell(user_key)
            gw.cells[user_key] = cell
        cell.items.extend(items)
        cell.owner_event = event
        gw.timeline.extend(it["entry"] for it in items)
        return cell

    async def _decide_batch(
        self, event: AstrMessageEvent, items: list[dict[str, Any]], allow_merge: bool
    ) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
        batch = policy.make_batch([it["entry"] for it in items], self.cfg)
        free = self._free_chat_verdict(batch)
        if free is not None:
            return free, items
        verdict = policy.decide(batch, self.cfg, self._limits)
        if (
            not verdict["speak"]
            and str(verdict["rule"]).startswith("no:")
            and batch.get("has_image")
            and any(it["entry"].get("awaiting_image") for it in items)
        ):
            # #22 awaitingImage：群里刚被要求发图、本条是回图 → 直接放行，不交给 judge
            return (
                {
                    "speak": True,
                    "addressed_to_bot": False,
                    "should_reply": True,
                    "reason": "等图请求命中：本条是对方按要求的回图",
                    "rule": "policy:awaiting-image",
                    "gate": "policy",
                    "details": {},
                },
                items,
            )
        if (
            verdict["speak"]
            or not str(verdict["rule"]).startswith("no:")
            or not self._judge_eligible(batch)
        ):
            return verdict, items
        merge_s = self._judge_merge_s()
        if not allow_merge or merge_s <= 0:
            # 现网 judge 分支不走 policy.decide：模型放行即放行，不再叠 replyChance/limits
            return (await self._judge_verdict(batch["entries"], event), items)
        cell = self._enqueue_judge(batch["chat_id"], batch["user_id"], event, items, merge_s)
        await cell.ready.wait()
        if cell.verdict is None:
            return (
                {
                    "speak": False,
                    "addressed_to_bot": False,
                    "should_reply": False,
                    "reason": "judge 窗口异常",
                    "rule": "judge:error",
                    "gate": "model",
                },
                items,
            )
        return cell.verdict, cell.final_items

    def _audit_row(
        self,
        entry: dict[str, Any],
        should: bool,
        skip: str,
        gate: str,
        reason: str,
        merged_count: int = 1,
        batch_position: int = 1,
        details: dict[str, Any] | None = None,
    ) -> None:
        _append_jsonl(
            "inbound.jsonl",
            {
                "ts": int(time.time() * 1000),
                "trace": entry["trace"],
                "umo": entry["umo"],
                "chat": entry["chat"],
                "group_id": entry["group_id"],
                "sender": entry["sender"],
                "nick": entry["nick"],
                "is_master": entry["is_master"],
                "text": entry["text"],
                "components": entry["components"],
                "media": entry["media"],
                "mentioned": entry["mentioned"],
                "quoted_me": entry["quoted_me"],
                "quoted_other": entry["quoted_other"],
                "at_all": entry["at_all"],
                "at_other": entry["at_other"],
                "self_id": entry["self_id"],
                "message_id": entry["message_id"],
                "batch_position": batch_position,
                "merged_count": merged_count,
                "should_reply": should,
                "skip_reason": skip,
                "gate": gate,
                "reason": reason,
                "details": details or {},
            },
        )

    def _audit_inbound(self, items: list[dict[str, Any]], verdict: dict[str, Any]) -> None:
        total = len(items)
        for idx, item in enumerate(items):
            owner = idx == total - 1
            if not owner:
                self._audit_row(
                    item["entry"],
                    should=False,
                    skip=judge_mod.RULES["MERGED"],
                    gate="merged",
                    reason="与后续消息合并判定",
                    merged_count=total,
                    batch_position=idx + 1,
                )
                continue
            self._audit_row(
                item["entry"],
                should=bool(verdict["speak"]),
                skip="" if verdict["speak"] else str(verdict["rule"]),
                gate=str(verdict["gate"]),
                reason=str(verdict["reason"]),
                merged_count=total,
                batch_position=idx + 1,
                details=verdict.get("details") or {},
            )

    # -- 出站：合并消息链 ------------------------------------------------ #
    async def _consume_asked_image(self, entry: dict[str, Any]) -> None:
        """qq_ask_image 的入站侧：命中 pending、本人回图 → 视觉理解进上下文并消费。"""
        state_key = (
            f"group:{entry['group_id']}"
            if entry.get("chat") == "group"
            else f"private:{entry['sender']}"
        )
        pending = tools_batch3.peek_pending_image_request(state_key, entry["sender"])
        if pending is None:
            # 非本人回图（或已超时）：不消费，只留一行日志
            raw = tools_batch3.peek_pending_image_request(state_key)
            if (
                raw is not None
                and "Image" in entry["media"]
                and str(raw.get("requester") or "") not in ("", entry["sender"])
            ):
                logger.info(
                    f"[xzy] 等图未消费: chat={state_key} 回图者={entry['sender']} "
                    f"请求者={raw.get('requester')}"
                )
            return
        if "Image" not in entry["media"]:
            return
        path = ""
        for comp in entry["raw"]:
            if _component_type(comp) != "Image":
                continue
            # 入站图片可能是 base64:// / http(s):// / file:/// / 本地路径，
            # convert_to_file_path() 会统一下载或落成临时文件
            converter = getattr(comp, "convert_to_file_path", None)
            if callable(converter):
                try:
                    path = str(await converter() or "")
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        f"[xzy] 等图落地失败: chat={state_key} {type(exc).__name__}: {exc}"
                    )
            if not path or not os.path.exists(path):
                for attr in ("path", "file"):
                    candidate = str(getattr(comp, attr, "") or "")
                    if candidate.startswith("file:///"):
                        candidate = candidate[8:]
                    if candidate and os.path.exists(candidate):
                        path = candidate
                        break
            break
        if not path or not os.path.exists(path):
            logger.warning(f"[xzy] 等图命中但拿不到本地文件: chat={state_key} path={path!r}")
            return
        prompt = (
            f"用户发来一张图，作为对「{str(pending.get('reason') or '要一张图')}」的回应。"
            "用一两句中文描述画面主体、动作/场景和图中的文字；如果明显不是在回应这个请求，"
            "就在最后补一句“可能不是你要的图”。"
        )
        try:
            caption = await mp.describe_image(path, prompt)
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[xzy] 等图理解失败，保持 pending: chat={state_key} {type(exc).__name__}: {exc}")
            return
        caption = str(caption or "").strip()
        if not caption:
            logger.warning(f"[xzy] 等图理解为空，保持 pending: chat={state_key}")
            return
        tools_batch3.take_pending_image_request(state_key, entry["sender"])
        entry["text"] = (entry["text"] + f"\n\n【对方按要求发来的图】{caption}").strip()
        logger.info(
            f"[xzy] 等图命中: chat={state_key} requester={entry['sender']} path={path} "
            f"caption_chars={len(caption)} pending=false"
        )

    def _apply_batch(
        self,
        event: AstrMessageEvent,
        items: list[dict[str, Any]],
        context_entries: list[dict[str, Any]] | None = None,
    ) -> None:
        """合批文本 + 合并消息链：早期消息的图片/表情也进多模态上下文。"""
        entries = [it["entry"] for it in items]
        if len(entries) > 1:
            text = policy.merged_text(entries)
        else:
            text = entries[0]["text"]
        # 引用别人的话：先给第三方视角标注，再放正文；否则模型会把「A 对 B 说的」当成对它说的
        header = policy.third_party_header(entries[-1])
        if header:
            text = header + "\n" + text
        if context_entries:
            # 群维度上下文：同窗口内其他人的消息只用于理解，不逐条回复、不并入本轮消息链
            lines = []
            for ctx in context_entries:
                body = ctx.get("text") or ""
                if not body and ctx.get("components"):
                    body = "[" + "/".join(ctx["components"]) + "]"
                lines.append(f"- [{ctx.get('nick')}({ctx.get('sender')})] {body}")
            text += (
                "\n\n【同群其他人的消息（仅供理解上下文，不要逐条回复他们）】\n"
                + "\n".join(lines)
            )
        event.message_str = text
        # 聊天记录里的图片：作为真正的图片一起进多模态上下文（原生链只有 Forward 组件，看不到）
        fwd_images: list[str] = []
        for entry in entries:
            fwd_images.extend(entry.get("forward_images") or [])
        if fwd_images:
            event.set_extra("xzy_forward_images", fwd_images[:4])
        chain: list[Any] = []
        for idx, entry in enumerate(entries):
            last = idx == len(entries) - 1
            for comp in entry["raw"]:
                ctype = _component_type(comp)
                if not last and ctype in ("Reply", "At", "AtAll"):
                    continue
                chain.append(comp)
        message_obj = getattr(event, "message_obj", None)
        if message_obj is not None:
            message_obj.message = chain
        if not event.is_at_or_wake_command:
            # 白名单群没有 @ 也要能进原生 agent：判定已经同意开口。
            event.is_at_or_wake_command = True

    @filter.event_message_type(filter.EventMessageType.ALL)
    async def on_message(self, event: AstrMessageEvent):
        """判定 + 防抖合批 + 审计；不调用 should_call_llm(False) 接管原生链路。"""
        entry = self._normalize_event(event)
        if entry["sender"] and entry["sender"] == entry["self_id"]:
            return
        # 本地群成员名字表：随流量自然积累 id → 昵称，供判定做「文字叫别人名字」信号
        members.note_entry(entry)

        # 入站时序插桩（只记时间戳）：event_ms 来自平台消息时间，
        # from_event_ms 即「平台收到 → 插件拿到事件」的分发延迟。
        _t_enter = time.time()
        entry["_t_enter"] = _t_enter
        entry["_t_event_ms"] = (
            int(getattr(getattr(event, "message_obj", None), "timestamp", 0) or 0) * 1000
        )
        _timing_row(entry, "plugin_entry", _t_enter)

        # 幂等：同一条入站消息只允许一次文本出站。谁先答谁占键；
        # 迟到重投、等待器超时后再次流进来的同一事件，在这里直接放弃。
        _answered_by = answer_ledger.answered(
            entry["umo"], [entry["message_id"]] if entry["message_id"] else []
        )
        if _answered_by:
            _append_jsonl(
                "idempotency.jsonl",
                {
                    "umo": entry["umo"],
                    "trace": entry["trace"],
                    "message_id": entry["message_id"],
                    "action": "skip_round",
                    "source": _answered_by,
                },
            )
            logger.info(
                f"[xzy] 幂等跳过：该消息已由 {_answered_by} 答复 "
                f"umo={entry['umo']} id={entry['message_id']}"
            )
            event.should_call_llm(True)
            event.stop_event()
            return

        # 循环闸按「回合」隔离：同群并发两人共用一个 umo，但 turn_id 不同
        turn_id = uuid.uuid4().hex
        event.set_extra("xzy_turn_id", turn_id)
        loop_guard.GUARD.start_turn(event.unified_msg_origin, turn_id)

        now = time.monotonic()
        chat_key = entry["group_id"] or f"private:{entry['sender']}"

        # 撤回通知：不进判定、不唤醒模型（否则 dm:always 会把空消息送进模型）
        notice = entry.get("notice") or {}
        if notice.get("type") in RECALL_NOTICE_TYPES:
            await self._handle_recall_notice(entry, chat_key)
            event.should_call_llm(True)
            event.stop_event()
            return

        # /撤回：主人指令，撤自己发出的消息（旧栈 recall.js 的 handleCommand）
        if _RECALL_CMD_RE.match(entry["text"] or ""):
            await self._recall_command(entry, chat_key, event)
            event.should_call_llm(True)
            event.stop_event()
            return

        # 旧栈 chat.lastMessageId / lastUserId：每条入站都刷新，工具省略目标时读这里
        tool_context.note(chat_key, entry["message_id"], entry["sender"])
        if self._is_duplicate(chat_key, entry["message_id"], now):
            self._audit_row(
                entry,
                should=False,
                skip="dedup",
                gate="dedup",
                reason=f"{self.cfg.get('dedupWindowSec')}s 内重复 message_id",
            )
            event.should_call_llm(True)
            event.stop_event()
            return

        # 合并转发 / 视频 / B 站卡片：折叠内容展开后再进判定与合批，
        # 否则模型只看到「[合并转发]」「[视频]」，等于这条消息被吞掉。
        if entry.get("forward_ids") or entry.get("video_segs") or entry.get("bili_cards"):
            try:
                await inbound_expand.expand(event, entry)
                _timing_row(entry, "media_expand", time.time())
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"[xzy] 入站折叠内容展开失败：{type(exc).__name__}: {exc}")

        if self.presence is not None:
            self.presence.note_interaction(
                {
                    "kind": "message",
                    "userId": entry["sender"],
                    "chatId": chat_key,
                    "role": "master" if entry["is_master"] else "member",
                }
            )

        # 等图入站侧：pending 命中且本人带图 → 视觉理解后并入本轮上下文，一次性消费
        # #22 awaitingImage：必须在消费前记录，否则 pending 被清掉后判定看不到等图态
        ask_key = (
            f"group:{entry['group_id']}"
            if entry.get("chat") == "group"
            else f"private:{entry['sender']}"
        )
        entry["awaiting_image"] = bool(
            "Image" in entry["media"]
            and tools_batch3.peek_pending_image_request(ask_key) is not None
        )
        await self._consume_asked_image(entry)

        # 被拍就拍回去：旧栈在 bridge 里做，这里挂在判定之前，不受判定结果影响
        self._maybe_poke_back(event, entry)

        # 视觉环境观察：落盘一句话 + 供后续回合注入（旧栈 vision.mjs 的 ambient 观察）
        if "Image" in entry["media"] and entry.get("image_refs"):
            self._spawn(self._observe_image(entry, chat_key))

        debounce_on = self._should_debounce(entry)
        chat_key = entry["group_id"] or f"private:{entry['sender']}"
        context_entries: list[dict[str, Any]] = []
        verdict: dict[str, Any] | None
        final_items: list[dict[str, Any]]
        if debounce_on:
            # 群 × 人：同群共用一个窗口时钟，人格各占一格，只有本格最后一条能出站
            cell = self._enqueue(
                self._buffers,
                chat_key,
                entry["sender"],
                event,
                entry,
                self._delay_s(entry),
                int(self._debounce().get("maxBatch") or 8),
            )
            await cell.ready.wait()
            if cell.owner_event is not event:
                event.should_call_llm(True)
                event.stop_event()
                return
            verdict, final_items = cell.verdict, cell.final_items
            context_entries = cell.context
        else:
            final_items = [{"event": event, "entry": entry}]
            verdict, final_items = await self._decide_batch(event, final_items, allow_merge=False)

        # 撤回墓碑兜底：窗口已弹出的批（_cancel_pending 够不到）在这里按 id 摘干净，
        # 摘空就整批不出站。已送进模型的回合不追发，取舍写进 spec §15.1。
        pruned = [it for it in final_items if not self._is_recalled(it["entry"])]
        if len(pruned) != len(final_items):
            dropped = [
                it["entry"]["trace"] for it in final_items
                if self._is_recalled(it["entry"])
            ]
            _append_jsonl(
                "recall.jsonl",
                {"kind": "batch-prune", "chat": chat_key, "dropped": dropped,
                 "left": len(pruned)},
            )
            logger.info(
                f"[xzy] 撤回摘除: chat={chat_key} 摘掉 {len(final_items) - len(pruned)} 条，"
                f"剩 {len(pruned)}"
            )
            final_items = pruned
            context_entries = [e for e in context_entries if not self._is_recalled(e)]
        if not final_items:
            event.should_call_llm(True)
            event.stop_event()
            return

        if verdict is None:
            event.should_call_llm(True)
            event.stop_event()
            return

        if not isinstance(verdict.get("details"), dict):
            verdict["details"] = {}
        verdict["details"]["context_count"] = len(context_entries)

        _timing_row(final_items[-1]["entry"], "verdict_done", time.time())
        self._audit_inbound(final_items, verdict)
        _timing_row(final_items[-1]["entry"], "inbound_written", time.time())
        logger.info(
            f"[xzy] 判定: umo={event.unified_msg_origin} merged={len(final_items)} "
            f"ctx={len(context_entries)} speak={verdict['speak']} gate={verdict['gate']} "
            f"rule={verdict['rule']} reason={verdict['reason']}"
        )
        event.set_extra("xzy_judge", verdict)
        event.set_extra(
            "xzy_batch",
            {
                "merged_count": len(final_items),
                "traces": [it["entry"]["trace"] for it in final_items],
                "message_ids": [
                    it["entry"].get("message_id")
                    for it in final_items
                    if it["entry"].get("message_id")
                ],
                "profile": self.cfg.get("debounce_profile"),
                "group_context_count": len(context_entries),
            },
        )

        if not verdict["speak"]:
            event.should_call_llm(True)
            event.stop_event()
            return

        self._apply_batch(event, final_items, context_entries)
        # 判定已同意开口：立刻让对面看到「正在输入…」，随后由 on_llm_request 续着
        await self.typing.begin(event)

    def _identity_block(self) -> tuple[str, dict[str, Any]]:
        """身份索引注入（spec §3.3）：只写外形特征与证据数，不给身份结论。"""
        # 2026-11-16：先按 updatedAt 取最近 N 条再排 confirmed，会把唯一的自身记录
        # 挤出窗口（它停在 11-15，被 20+ 条 pending 噪声顶掉），模型只看到「未命名形象」。
        # 这里先取足够多，再按 confirmed 优先截断，自身记录才进得去。
        try:
            rows = self.identity.lookup(limit=max(200, self._identity_limit))
        except Exception as exc:  # noqa: BLE001
            return "", {"state": "error", "error": f"{type(exc).__name__}: {exc}"}
        if not rows:
            return "", {"state": "empty", "records": 0}
        rows = sorted(
            rows,
            key=lambda row: (
                1 if row.get("status") == "confirmed" else 0,
                str(row.get("updatedAt") or ""),
            ),
            reverse=True,
        )[: self._identity_limit]
        lines = [
            "【身份索引】下面是你以前看图时记下的形象（只代表外形，不代表身份；"
            "没把握就说不确定，别编现实身份）："
        ]
        for row in rows:
            name = str(row.get("identity") or "").strip() or str(row.get("display") or "")
            aliases = [str(item) for item in (row.get("aliases") or []) if str(item).strip()]
            if "小助手" in name or "小助手" in aliases:
                name += "（这是你自己）"
            alias_text = f"（别名：{'、'.join(aliases)}）" if aliases else ""
            lines.append(
                f"- {name}{alias_text}：id={row.get('id')}，"
                f"置信度 {float(row.get('confidence') or 0):.2f}，"
                f"证据 {len(row.get('evidence') or [])} 条，"
                f"见过 {int(row.get('count') or 0)} 次"
            )
        lines.append(
            "要查详情或用 signature 精确对照就用 qq_identity；主人给某个形象命名也用 "
            "qq_identity confirm。"
        )
        text = "\n".join(lines)
        meta: dict[str, Any] = {
            "state": "injected",
            "records": len(rows),
            "ids": [row.get("id") for row in rows],
            "chars": len(text),
        }
        # 审计里带原文，便于核对「这轮 system_prompt 里确实有这段」
        self.identity.audit({"action": "inject", **meta, "text": text})
        return text, meta

    @filter.on_llm_request()
    async def on_llm_request(self, event: AstrMessageEvent, req: ProviderRequest):
        await self.typing.begin(event)
        # 同轮出站去重：先重置本轮状态，等工具集确定后再包发送工具
        send_dedupe.begin_turn(event.unified_msg_origin)
        extra_blocks: list[str] = []
        if self.presence is not None:
            line = self.presence.prompt_line(self._actor_key(event))
            if line:
                extra_blocks.append(line)
        # 撤回收尾：告诉模型哪句已被撤回，不要当成自己说过的话（旧栈 afterOwnRecall）
        recall_lines = self._recall_lines(event.unified_msg_origin)
        if recall_lines:
            extra_blocks.append(recall_lines)
        # 视觉：最近看到的画面（旧栈 noteForChat，30 分钟内最多 3 条）
        _gid = str(getattr(getattr(event, "message_obj", None), "group_id", "") or "")
        vision_line = self.vision.note(_gid or f"private:{event.get_sender_id()}")
        if vision_line:
            extra_blocks.append(vision_line)
        # 身份索引：有记录才注入（无记录不占 token），开关关闭时整段不碰。
        identity_meta: dict[str, Any] = {"state": "disabled"}
        if self._identity_on:
            identity_text, identity_meta = self._identity_block()
            if identity_text:
                extra_blocks.append(identity_text)
        # 看图口径：画面只是素材，回复要落在自己的判断上（避免把描述原样念给用户）
        _has_media = bool(
            event.get_extra("xzy_forward_images")
            or any(
                _component_type(c) in ("Image", "Forward", "Video")
                for c in (event.get_messages() or [])
            )
        )
        if _has_media:
            extra_blocks.append(
                "【看图口径】随消息附带的图和上面的画面记录都只是素材，不是让你向用户念的说明。"
                "回复要落在你自己的判断：喜不喜欢、哪一点出彩、哪一点不行、跟你的口味合不合，用你平时的口气；"
                "不要把画面逐项描述一遍，也不要复述那句画面记录。"
                "真有值得留下的判断（不是每张表情包）就用 qq_media_note 记一条：path 填图片来源，"
                "verdict 填你的一句话判断；不值得就不用调。"
            )
        # 草稿本：有未提交草稿就提醒一句，避免模型以为已经说过了（草稿从不自动发送）
        _draft = draftbook.current(event.unified_msg_origin)
        _draft_text = str(_draft.get("text") or "")
        if _draft_text.strip():
            extra_blocks.append(
                f"草稿本里有未提交的第 {int(_draft.get('version') or 0)} 版草稿（{len(_draft_text)} 字）："
                "它还没发出去。要发用 qq_draft_submit，要改用 qq_draft_write，不要当成已经说过。"
            )
        # 人格 + 记忆注入统一走 persona_inject：它会先删掉原生/旧块再写，保证是替换不是叠加。
        stats = persona_inject.apply(event, req, self.cfg, extra_blocks=extra_blocks)
        if req.func_tool is not None and send_dedupe.install(
            req.func_tool, RECALL_LEDGER
        ):
            _append_jsonl(
                "dedupe.jsonl",
                {"umo": event.unified_msg_origin, "action": "tool_wrapped", "tool": send_dedupe.TOOL_NAME},
            )

        if self.cfg.get("engine_nonce"):
            # ninfer 前缀缓存 bug 规避：同一段大前缀（工具块+系统提示）连续命中时会
            # 500 "prepared shared candidates exceeded the fixed subset bound"。
            # 每次请求换一个 12 位前缀，等于放弃前缀复用，换取稳定；证据见
            # evidence/tools.md §6。
            req.system_prompt = f"[req {uuid.uuid4().hex[:12]}] " + (req.system_prompt or "")

        image_urls = list(getattr(req, "image_urls", None) or [])
        for extra_img in event.get_extra("xzy_forward_images") or []:
            if extra_img not in image_urls:
                image_urls.append(extra_img)
        images_in = len(image_urls)
        if image_urls:
            # 入模前统一压缩（spec §15.9）：原图 3840x2400 = 9000 vision tokens(141 页)，
            # 768 长边 = 360(6 页)。压不了就丢掉这张图继续，不整回合失败。
            image_urls = await image_prep.shrink_many(image_urls)
            req.image_urls = image_urls
        chain_types = [_component_type(c) for c in (event.get_messages() or [])]
        _append_jsonl(
            "llm_request.jsonl",
            {
                "umo": event.unified_msg_origin,
                "contexts": len(req.contexts or []),
                "prompt_chars": len(req.prompt or ""),
                "system_prompt_chars": len(req.system_prompt or ""),
                "persona_injected": stats["persona_injected"],
                "tools": len(req.func_tool.tools) if req.func_tool else 0,
                "image_urls": len(image_urls),
                "image_head": [os.path.basename(p) for p in image_urls[:4]],
                "images_dropped": images_in - len(image_urls),
                "chain": chain_types,
                "system_prompt_sha256": hashlib.sha256(
                    (req.system_prompt or "").encode("utf-8")
                ).hexdigest(),
                "output_spec": stats.get("output_spec") or {},
                "identity": identity_meta,
            },
        )

        batch = event.get_extra("xzy_batch") or {}
        _append_jsonl(
            "turns.jsonl",
            {
                "kind": "llm_request",
                "umo": event.unified_msg_origin,
                "traces": batch.get("traces", []),
                "merged_count": batch.get("merged_count", 1),
                "profile": batch.get("profile"),
                "judge": event.get_extra("xzy_judge") or {},
                "contexts": len(req.contexts or []),
                "prompt_chars": len(req.prompt or ""),
                "prompt_head": (req.prompt or "")[:400],
                "tools": len(req.func_tool.tools) if req.func_tool else 0,
                "image_urls": len(image_urls),
                "chain": chain_types,
            },
        )

    @filter.on_decorating_result()
    async def on_decorating_result(self, event: AstrMessageEvent):
        result = event.get_result()
        text = ""
        if result is not None:
            try:
                text = result.get_plain_text()
            except Exception:
                text = str(result)
        # tool_calls 回合的 content 不是最终答复（核心在 step() 里打标，[XZY-P07]）：
        # 这一轮模型只是说了句「要去做事」的旁白，真正的话由工具或后续最终回合发。
        # 这里丢掉文本、不占幂等键、不记出站时刻；仍跑一遍清洗只为留证，
        # 且不存在「插件自己再发一次」的路径，所以推理成分不会因此绕过清洗。
        # 工具确实没发出正文（失败/被拒/只读）时键是空的，final 照常走完整链路出站。
        if event.get_extra("xzy_tool_round"):
            _dropped = outbound_clean.clean_outbound(text)
            _kept = [
                comp
                for comp in ((result.chain if result is not None else None) or [])
                if _component_type(comp) != "Plain"
            ]
            _append_jsonl(
                "tool_round.jsonl",
                {
                    "umo": event.unified_msg_origin,
                    "message_ids": answer_ledger.event_ids(event),
                    "action": "dropped",
                    "chars": len(text),
                    "text": text[:200],
                    "clean_hit": _dropped["hit"],
                    "clean_inner_hit": _dropped.get("inner_hit", False),
                    "clean_dropped": _dropped["dropped"],
                    "clean_reason": _dropped["reason"],
                    "kept_non_text": len(_kept),
                },
            )
            logger.info(
                f"[xzy] tool_calls 回合的 content 不作为最终答复出站（不占幂等键） "
                f"chars={len(text)} 保留非文本={len(_kept)} umo={event.unified_msg_origin}"
            )
            if not _kept:
                event.clear_result()
                return
            try:
                result.chain = _kept
            except Exception:
                event.clear_result()
            return
        # 出站台账挪到「确定要发」之后写（见下方 note_outbound 前），
        # 避免被幂等/去重/清洗/二审拦下的正文留下一个假的发送时刻。
        # 幂等：这条消息已经被别的路径回答过（原生等待器 / 发送工具），
        # 最终正文整条不再发；只有文本才占用幂等键，纯媒体不占。
        _ids = answer_ledger.event_ids(event)
        _answered_by = (
            answer_ledger.answered(event.unified_msg_origin, _ids) if text else None
        )
        if _answered_by:
            _append_jsonl(
                "idempotency.jsonl",
                {
                    "umo": event.unified_msg_origin,
                    "message_ids": _ids,
                    "action": "suppressed",
                    "source": _answered_by,
                    "text": text[:200],
                },
            )
            logger.info(
                f"[xzy] 幂等拦下最终正文：该消息已由 {_answered_by} 答复 "
                f"umo={event.unified_msg_origin}"
            )
            event.clear_result()
            await self.typing.end(event)
            return
        # 同轮去重：本轮已经用 send_message_to_user 发过同样正文，最终结果不再发第二条。
        # 只认内容重复；工具发的是别的意思时照常放行。
        if text and send_dedupe.is_duplicate(event.unified_msg_origin, text):
            _append_jsonl(
                "dedupe.jsonl",
                {
                    "umo": event.unified_msg_origin,
                    "action": "suppressed",
                    "text": text[:200],
                },
            )
            logger.info(
                f"[xzy] 同轮重复出站已拦下（send_message_to_user 已发过同样正文） "
                f"umo={event.unified_msg_origin}"
            )
            event.clear_result()
            await self.typing.end(event)
            return
        # 出站窄清洗：先剥人格内心 `【内心】`（剥空即静默不出站），再处理
        # 「最终：」草稿格式；没有标记的文本一字不动。放在二审之前。
        cleaned = outbound_clean.clean_outbound(
            text,
            cap_tripped=loop_guard.GUARD.cap_tripped(
                event.unified_msg_origin, event.get_extra("xzy_turn_id") or "default"
            ),
        )
        _append_jsonl(
            "clean.jsonl",
            {
                "umo": event.unified_msg_origin,
                "hit": cleaned["hit"],
                "inner_hit": cleaned.get("inner_hit", False),
                "self_tag_hit": cleaned.get("self_tag_hit", False),
                "self_tag_stripped": cleaned.get("self_tag_stripped", 0),
                "cut_candidate": cleaned["cut_candidate"],
                "dropped": cleaned["dropped"],
                "reason": cleaned["reason"],
                "fingerprint": cleaned.get("fingerprint", ""),
                "original_chars": cleaned["original_chars"],
                "cleaned_chars": cleaned["cleaned_chars"],
                "original_head": text[:200],
                "cleaned_head": cleaned["text"][:200],
            },
        )
        if cleaned["hit"]:
            if cleaned["dropped"]:
                held = cleaned.get("held") or ""
                if held:
                    _why = cleaned.get("hold_reason") or "held:unlabeled-multi"
                    _label = {
                        "held:self-correction": "未定稿的自我改口",
                        "held:unlabeled-multi": "无正文标签的多段内心",
                    }.get(_why, _why)
                    draftbook.hold(
                        event.unified_msg_origin,
                        held,
                        reason=f"出站清洗：{_label}",
                    )
                    logger.warning(
                        f"[xzy] 出站清洗拦下{_label}（{len(held)} 字），已存入草稿本、未发送 "
                        f"umo={event.unified_msg_origin}"
                    )
                logger.warning(
                    f"[xzy] 出站清洗命中但无可发正文（{cleaned['reason']}"
                    f"{'，指纹=' + cleaned.get('fingerprint', '') if cleaned.get('fingerprint') else ''}），"
                    f"整条不出站 umo={event.unified_msg_origin}"
                )
                event.clear_result()
                await self.typing.end(event)
                return
            if not outbound_clean.apply_text(result, cleaned["text"]):
                logger.warning(
                    f"[xzy] 出站清洗命中但替换失败，整条不出站 umo={event.unified_msg_origin}"
                )
                event.clear_result()
                await self.typing.end(event)
                return
            text = cleaned["text"]
        # 视频回合：正文开头如果是照抄 caption 的画面描述，去掉；只剩复述就整条不发。
        recital = _strip_video_recital(text, event.get_extra("xzy_video_captions") or [])
        if recital["hit"]:
            _append_jsonl(
                "clean.jsonl",
                {
                    "umo": event.unified_msg_origin,
                    "hit": True,
                    "inner_hit": False,
                    "self_tag_hit": False,
                    "self_tag_stripped": 0,
                    "cut_candidate": False,
                    "dropped": recital["dropped"],
                    "reason": "video-recital-stripped",
                    "fingerprint": "",
                    "original_chars": len(text),
                    "cleaned_chars": len(recital["text"]),
                    "original_head": text[:200],
                    "cleaned_head": recital["text"][:200],
                },
            )
            if recital["dropped"] or not outbound_clean.apply_text(result, recital["text"]):
                logger.warning(
                    f"[xzy] 视频回合正文只有画面复述、没有判断，整条不出站 "
                    f"stripped={recital['stripped']} umo={event.unified_msg_origin}"
                )
                event.clear_result()
                await self.typing.end(event)
                return
            text = recital["text"]
            logger.info(
                f"[xzy] 视频回合去掉开头画面复述 {recital['stripped']} 句，保留判断 "
                f"chars={len(text)} umo={event.unified_msg_origin}"
            )
        # 空正文绝不出站（纯媒体组件不受影响）
        if not text.strip() and not _non_plain_components(result):
            logger.warning(
                f"[xzy] 出站正文为空，整条不发 umo={event.unified_msg_origin}"
            )
            event.clear_result()
            await self.typing.end(event)
            return
        # 出站二审闸门：只判「发/不发」，allow 时不动原文，drop 时清空结果
        await review_gate.gate_event(event, self.cfg)
        if event.get_result() is None:
            # 被二审 drop：respond 阶段不会发送，也就不会有 after_message_sent
            await self.typing.end(event)
            return
        # 出站规范校验（口癖/字数/emoji）：只判不改，违规落 audit/output_spec.jsonl
        spec_check = output_spec_gate.check_event(event, self.cfg)
        _spec = spec_check.get("checks") or {}
        # 出站台账：到这里幂等 / 去重 / 清洗 / 二审都已放行，respond 紧接着真发，
        # 所以这一行的 wall_ms 就是「这条正文要出站的时刻」。被拦下的正文不写这里
        # （各自的 suppressed 行在 idempotency.jsonl / dedupe.jsonl / clean.jsonl）。
        _append_jsonl(
            "outbound.jsonl",
            {
                "umo": event.unified_msg_origin,
                "chars": len(text),
                "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "text": text[:500],
                "stage": "decorating_result",
                "specRevision": _spec.get("specRevision", 0),
                "specViolations": _spec.get("violations", []),
            },
        )
        # 接话判定的「机器人最后一句」：这里记的是清洗、二审都过了的正文，
        # 进程内用单调时钟算「距今多久」，重启后回落到 outbound.jsonl 的 wall_ms。
        continuation.note_outbound(event.unified_msg_origin, text)
        # 二审放行：占键。此后同一 message_id 的任何路径都不再出站。
        if text:
            answer_ledger.mark(event.unified_msg_origin, _ids, "final", text)
        # 拆条：长回复按句子边界拆成 2~3 条（第一段走原生 respond，其余在
        # after_message_sent 按 gapMs 补发）。幂等/去重/台账都已在「整条」上
        # 完成，拆段只是发送形态，不会让多段互相挡。
        bcfg = self.cfg.get("bubbles") or {}
        if text and bcfg.get("enabled", True):
            # 只有表情的碎片并进相邻文本段，别让它单独占一条气泡
            _parts = faces.merge_mark_only_parts(bubbles.split_text(text))
            if len(_parts) > 1 and outbound_clean.apply_text(result, _parts[0]):
                self._watch_first_send(event)
                _BUBBLE_PENDING[event.unified_msg_origin] = (_parts[1:], time.time())
                _append_jsonl(
                    "bubbles.jsonl",
                    {
                        "umo": event.unified_msg_origin,
                        "stage": "decorating_result",
                        "original_chars": len(text),
                        "original_head": text[:200],
                        "first_id": None,
                        **bubbles.describe(_parts),
                    },
                )
        # 表情标记 → Face 组件：放在清洗/二审/幂等/拆条全部定稿之后做，
        # 这样标记不可能被截断、也不会参与字数与去重口径。
        faces_used = _expand_faces_in_chain(event.get_result())
        if faces_used:
            logger.info(
                f"[xzy] 出站带 QQ 原生表情 {faces_used} 个 umo={event.unified_msg_origin}"
            )

    @staticmethod
    def _watch_first_send(event: AstrMessageEvent) -> None:
        """记录第一段（原生 respond）到底发没发出去。

        respond.stage 会把发送异常吞掉（只打 ERRO）再触发 after_message_sent，
        钩子里看不到成败。这里在事件实例上包一层 `send`，记下调用次数、失败次数
        和异常类型/retcode；异常照原样再抛，不改变原有发送行为。
        """
        state: dict[str, Any] = {"calls": 0, "failed": 0, "error_type": "", "retcode": None}
        original = event.send

        async def _send_probe(chain):
            state["calls"] += 1
            try:
                return await original(chain)
            except Exception as exc:  # noqa: BLE001  原样抛出，只做记录
                state["failed"] += 1
                state["error_type"], state["retcode"] = _exc_summary(exc)
                raise

        event.send = _send_probe  # type: ignore[method-assign]
        event._xzy_send_orig = original  # type: ignore[attr-defined]
        event._xzy_bubble_send = state  # type: ignore[attr-defined]

    @filter.after_message_sent()
    async def after_message_sent(self, event: AstrMessageEvent):
        await self.typing.end(event)
        # 补发拆条的后几段：只有第一段确实发出去了才补，否则整轮不发后续段，
        # 避免留下孤立的第 2 段；判不准（没观察到 send 调用）同样按「没发」处理。
        pending = _BUBBLE_PENDING.pop(event.unified_msg_origin, None)
        state = getattr(event, "_xzy_bubble_send", None) or {}
        original = getattr(event, "_xzy_send_orig", None)
        if original is not None:  # 还原被观测包装的 send，别把状态留在事件上
            event.send = original
        if pending:
            rest, queued_at = pending
            first_ok = (
                state.get("calls", 0) > 0
                and state.get("failed", 0) == 0
                and bool(getattr(event, "_has_send_oper", False))
            )
            if time.time() - queued_at > 60:
                reason = "pending-expired"
            elif not first_ok:
                reason = "first-send-failed" if state.get("failed") else "first-send-unknown"
            else:
                reason = ""
            if reason:
                # 后续段没有发：逐段落审计（含原文片段），不静默丢弃
                logger.warning(
                    f"[xzy] 拆条：第一段未确认发出（{reason}"
                    f"{'/' + state.get('error_type', '') if state.get('error_type') else ''}），"
                    f"跳过后续 {len(rest)} 段 umo={event.unified_msg_origin}"
                )
                for index, part in enumerate(rest, start=2):
                    _append_jsonl(
                        "bubbles.jsonl",
                        {
                            "umo": event.unified_msg_origin,
                            "stage": "after_sent",
                            "part": index,
                            "chars": len(part),
                            "text": part[:200],
                            "message_id": None,
                            "skipped": reason,
                            "first_calls": state.get("calls", 0),
                            "first_error_type": state.get("error_type", ""),
                            "first_retcode": state.get("retcode"),
                        },
                    )
            else:
                gap = (
                    float((self.cfg.get("bubbles") or {}).get("gapMs") or 600) / 1000.0
                )
                chat = tool_send.current_chat(event)
                for index, part in enumerate(rest, start=2):
                    await asyncio.sleep(gap)
                    try:
                        mid = await tool_send.send_segments(
                            event, chat, [tool_send.text_seg(part)]
                        )
                    except Exception as exc:  # 单段失败不影响其它段，如实落审计
                        etype, retcode = _exc_summary(exc)
                        logger.warning(
                            f"[xzy] 拆条第 {index} 段发送失败：{etype} retcode={retcode} "
                            f"{exc} umo={event.unified_msg_origin}"
                        )
                        _append_jsonl(
                            "bubbles.jsonl",
                            {
                                "umo": event.unified_msg_origin,
                                "stage": "after_sent",
                                "part": index,
                                "chars": len(part),
                                "message_id": None,
                                "error_type": etype,
                                "retcode": retcode,
                                "error": str(exc),
                            },
                        )
                        continue
                    _append_jsonl(
                        "bubbles.jsonl",
                        {
                            "umo": event.unified_msg_origin,
                            "stage": "after_sent",
                            "part": index,
                            "chars": len(part),
                            "message_id": mid,
                        },
                    )
        _append_jsonl(
            "sent.jsonl",
            {
                "umo": event.unified_msg_origin,
                "stage": "after_message_sent",
            },
        )
