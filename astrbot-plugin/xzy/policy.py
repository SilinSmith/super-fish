"""判定规则层：`qq-onebot-plugin/src/policy.js` 的 Python 移植。

覆盖 `decide()` 的全部确定性规则：免打扰 → 访问 → 触发（@/点名/引用/主人 cue/
数字接龙/关键词/正则/随机/全量）→ 概率 → 频次与冷却。模型判定不在这里，
白名单群的 `judgeEligible` 由调用方在 `no:*` 之后再问 1240。
"""

from __future__ import annotations

import random
import re
from datetime import datetime
from typing import Any

# 主人「追问/点名」信号：只认整句或句末语气，不再做裸子串匹配。
# 旧版是 `(?:...|不是|不对|错了|吗|呢|[?？])` 的无锚点匹配，主人任何一句
# 只要含「不是」就会判成 cue（实测「后来发现世界上并不是只有一台舞萌」命中
# span=(8,10)='不是'），属于误触发。
MASTER_ASK_RE = re.compile(
    r"^\s*(?:在吗|在不在|继续|接着|然后|第二|第三|看看|说一下|讲讲|重来|重新)\s*$"
    r"|(?:[?？]|[吗呢])\s*$"
)
MASTER_CUE_RE = MASTER_ASK_RE
MASTER_TASK_RE = re.compile(
    r"(?:做出来|做一下|解题|解答|解一下|计算|求(?:出|解|值|和|导)?|证明|推导|分析|解释|翻译|总结|锐评|评价|写(?:一下|个|段|代码|脚本|函数)?|改(?:一下|改)?|实现|检查|看看|看一下|这道题|题目|答案|步骤|过程|代码)"
)
DIGIT_CHAIN_RE = re.compile(r"^([0-9])\1{2,5}$")
# 直接冲着它问/质问：没 @、没引用、过了窗口也要回。
# 2026-11-15 21:54:11「那你怎么不回了」被 model 判成「过期追问」沉默了——
# 这类是明确的追问信号，不能让「过旧不回」把它吃掉。
ASK_BOT_RE = re.compile(
    r"(?:你|您)(?:怎么|为什么|咋|为啥)?(?:不|没)(?:回|理|说话|出声|答)"
    r"|(?:为什么|怎么|咋|为啥)(?:不|没)?(?:回我|理我)"
    r"|(?:半天|这么久|一直|还)(?:都)?(?:不|没)(?:回|理|说话)"
    r"|^\s*(?:在吗|在不在|人呢|有人吗|还在吗|你还在吗)\s*[?？。.!！~]*\s*$"
    r"|(?:你说话|说句话|回我一句|回我一下|理理我|理我一下)"
    r"|(?:你说错了|你不对|你说反了)"
)

MASTER_CUE_LABELS = {
    "task": "主人下达任务",
    "ask": "主人追问/点名",
    "image": "主人发图",
}


def _master_cue_source(text: str, has_image: bool) -> str:
    """区分 master:cue 的三种来源：image > task > ask。

    只影响审计文案，不改变「是否开口」；rule 字段仍是 master:cue，
    避免下游按 rule 做等值匹配的地方被打断。
    """
    if has_image:
        return "image"
    if MASTER_TASK_RE.search(text or ""):
        return "task"
    return "ask"

TRIGGER_MODES = ("at", "keyword", "regex", "random", "reply", "always")


def _verdict(
    speak: bool,
    rule: str,
    reason: str,
    gate: str,
    addressed_to_bot: bool = False,
    should_reply: bool = False,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "speak": speak,
        "addressed_to_bot": addressed_to_bot,
        "should_reply": should_reply,
        "reason": reason,
        "rule": rule,
        "gate": gate,
        "details": details or {},
    }


# --------------------------------------------------------------------------- #
# 免打扰
# --------------------------------------------------------------------------- #
def _local_minutes(now: datetime, tz_name: str) -> int:
    try:
        from zoneinfo import ZoneInfo

        local = now.astimezone(ZoneInfo(tz_name))
    except Exception:
        local = now.astimezone()
    return local.hour * 60 + local.minute


def in_dnd(cfg: dict[str, Any], now: datetime | None = None) -> bool:
    dnd = cfg.get("dnd") or {}
    start, end = str(dnd.get("start") or ""), str(dnd.get("end") or "")
    if not start or not end:
        return False

    def to_minutes(value: str) -> int:
        hour, minute = value.split(":")[:2]
        return int(hour) * 60 + int(minute)

    start_m, end_m = to_minutes(start), to_minutes(end)
    current = _local_minutes(now or datetime.now(), str(dnd.get("timezone") or "Asia/Shanghai"))
    if start_m <= end_m:
        return start_m <= current < end_m
    return current >= start_m or current < end_m


# --------------------------------------------------------------------------- #
# 访问控制
# --------------------------------------------------------------------------- #
def access_allowed(
    kind: str,
    user_id: str,
    group_id: str,
    chat_id: str,
    cfg: dict[str, Any],
) -> tuple[bool, str, str]:
    access = cfg.get("access") or {}
    deny_users = [str(x) for x in (access.get("denyUsers") or [])]
    deny_groups = [str(x) for x in (access.get("denyGroups") or [])]
    if user_id in deny_users:
        return False, "access:deny-user", "用户在黑名单"
    if group_id and group_id in deny_groups:
        return False, "access:deny-group", "群在黑名单"
    if not group_id and chat_id and chat_id in deny_groups:
        return False, "access:deny-group", "群在黑名单"

    if kind == "dm":
        policy = str(access.get("dmPolicy") or "allowlist")
        allow_users = [str(x) for x in (access.get("allowUsers") or [])]
        if policy == "disabled":
            return False, "access:dm-disabled", "私聊已禁用"
        if policy == "allowlist" and user_id not in allow_users:
            return False, "access:dm-allowlist", "用户不在私聊白名单"
        if (
            policy == "open"
            and access.get("allowAll") is not True
            and user_id not in allow_users
            and user_id != str(cfg.get("master_qq", ""))
        ):
            return False, "access:dm-open", "私聊开放但未放行该用户"
        return True, "", ""

    policy = str(access.get("groupPolicy") or "allowlist")
    allow_groups = [str(x) for x in (access.get("allowGroups") or [])]
    if policy == "disabled":
        return False, "access:group-disabled", "群聊已禁用"
    if policy == "allowlist" and group_id not in allow_groups:
        return False, "access:group-allowlist", "群不在白名单"
    return True, "", ""


# --------------------------------------------------------------------------- #
# 批次构造（policy.js makeBatch + mergedText）
# --------------------------------------------------------------------------- #
def third_party_header(entry: dict[str, Any]) -> str:
    """引用别人的话时，给模型一段可读的「第三方视角」标注。

    口径：引用别人 -> 可以按旁观者插一句，但必须知道自己不是被喊的那一方。
    字段缺失一律写「对方未知」，绝不默认成它自己。
    """
    if entry.get("quoted_me") is True:
        # 引用的是它自己发过的消息：这是确定事实，直接标出来，别让它当成别人说的话
        return "（[引用] 指向的是你自己刚发的那条消息，不是别人说的）"
    if entry.get("mentioned") is True:
        # 真的被 @ 了：它就是被喊的一方，不能再贴「你不是被喊的」标注
        return ""
    if entry.get("quoted_other") is not True:
        return ""
    author = str(entry.get("reply_author_nick") or "").strip()
    author_id = str(entry.get("reply_author_id") or "").strip()
    if not author:
        author = f"QQ{author_id}" if author_id else "对方未知"
    targets = [str(t) for t in (entry.get("reply_targets") or []) if str(t).strip()]
    target = "、".join(f"QQ{t}" for t in targets) if targets else "对方未知"
    head = (
        f"（下面是 {author} 对 {target} 说的话，你不是被喊的那一方，"
        "只是旁观；要接就按插一句来，不要答成「他们在跟你说话」）"
    )
    quoted = str(entry.get("reply_text") or "").strip()
    if quoted:
        head += f"\n被引用的原话（{author} 说）：{quoted}"
    return head


def merged_text(entries: list[dict[str, Any]]) -> str:
    latest = entries[-1]
    if len(entries) <= 1:
        return str(latest.get("text") or "")
    prior: list[str] = []
    for index, item in enumerate(entries[:-1], 1):
        label = f"[{item.get('nick')}({item.get('sender')})] " if item.get("chat") == "group" else ""
        prior.append(f"{index}. {label}{item.get('text') or ''}")
    tail_label = f"[{latest.get('nick')}({latest.get('sender')})] " if latest.get("chat") == "group" else ""
    return (
        f"【连续消息】同一人短时间发来 {len(entries)} 条，先结合全部内容理解，再只回一次，不要逐条回复：\n"
        + "\n".join(prior)
        + f"\n最后一条：{tail_label}{latest.get('text') or ''}"
    )


def make_batch(entries: list[dict[str, Any]], cfg: dict[str, Any]) -> dict[str, Any]:
    latest = entries[-1]
    text = merged_text(entries)
    kind = "dm" if latest.get("is_private") else "group"
    group_id = str(latest.get("group_id") or "")
    chat_id = group_id or ("private:" + str(latest.get("sender") or ""))
    # @全体成员不是「点名叫机器人」：以前把 at_all 并进 at_me，导致一条 @全体 就被当成
    # 直接点名（2026-11-15 21:5x 起在自由群里表现为「@别人也回」的同一处判据）。
    at_me = any(e.get("mentioned") is True for e in entries)
    at_all = any(e.get("at_all") is True for e in entries)
    has_image = any("Image" in (e.get("components") or []) for e in entries)
    at_others = latest.get("at_other") is True
    reply_to_bot = latest.get("quoted_me") is True
    reply_to_other = latest.get("quoted_other") is True
    addressed_elsewhere = at_others or reply_to_other
    # 口径（2026-11-15 22:0x）：@别人（不是引用）一律不插嘴；引用别人的话允许按
    # 「第三方旁观插一句」开口，所以两者必须分开判，不能合成一个 addressed_elsewhere。
    at_others_only = at_others and not reply_to_other
    # 直接冲着它问/质问（「你怎么不回」「在吗」「人呢」）：这是硬信号，必须回。
    # 但「冲着别人说」的（@别人 / 引用别人）不算，避免把两人互聊一刀切成「全回」。
    asks_bot = bool(ASK_BOT_RE.search(text)) and not addressed_elsewhere
    # 转发来的 B 站视频卡片：群里没人 @ 也要看一眼，否则这条消息等于被吞掉
    bili_card = any(bool(e.get("bili_cards")) for e in entries)
    names = [str(n) for n in (cfg.get("trigger", {}).get("mentionNames") or [])]
    name_hit = any(n and n in text for n in names)
    master_cue = bool(MASTER_TASK_RE.search(text) or MASTER_CUE_RE.search(text) or has_image)
    digit_text = str(latest.get("text") or "").strip()
    raw_digit_chain = bool(DIGIT_CHAIN_RE.match(digit_text))
    digit_chain = raw_digit_chain and digit_text != "111"
    master_bypass = (
        latest.get("is_master") is True
        and not addressed_elsewhere
        and not (kind == "group" and raw_digit_chain)
        and master_cue
    )
    banter = (
        kind == "group"
        and cfg.get("trigger", {}).get("banter") is True
        and digit_chain
        and not addressed_elsewhere
    )
    return {
        "kind": kind,
        "chat_id": chat_id,
        "group_id": group_id,
        "user_id": str(latest.get("sender") or ""),
        "self_id": str(latest.get("self_id") or ""),
        "text": text,
        "at_me": at_me,
        "at_all": at_all,
        "name_hit": name_hit,
        "reply_to_bot": reply_to_bot,
        "reply_to_other": reply_to_other,
        "addressed_elsewhere": addressed_elsewhere,
        "at_others_only": at_others_only,
        "asks_bot": asks_bot,
        "at_others": at_others,
        "has_image": has_image,
        "digit_chain": digit_chain,
        "master_bypass": master_bypass,
        "banter": banter,
        "bili_card": bili_card,
        "addressed": kind == "group"
        and (at_me or name_hit or reply_to_bot or master_bypass or bili_card),
        "entries": entries,
    }


# --------------------------------------------------------------------------- #
# 频次 / 冷却（每 chat 一份状态，与 policy.js 的 limits Map 同构）
# --------------------------------------------------------------------------- #
def check_limits(
    state: dict[str, Any], chat_id: str, cfg: dict[str, Any], now_ms: float
) -> tuple[bool, str, str]:
    limit = cfg.get("limits") or {}
    slot = state.setdefault(chat_id, {"minute": [], "hour": [], "day": [], "lastAt": 0})
    slot["minute"] = [ts for ts in slot["minute"] if now_ms - ts < 60_000]
    slot["hour"] = [ts for ts in slot["hour"] if now_ms - ts < 3_600_000]
    slot["day"] = [ts for ts in slot["day"] if now_ms - ts < 86_400_000]
    cooldown = float(limit.get("cooldownSec") or 0)
    if cooldown > 0 and slot["lastAt"] > 0 and now_ms - slot["lastAt"] < cooldown * 1000:
        return False, "limit:cooldown", f"冷却中（{cooldown:g}s）"
    per_minute = int(limit.get("perMinute") or 0)
    if per_minute > 0 and len(slot["minute"]) >= per_minute:
        return False, "limit:minute", f"超过每分钟上限 {per_minute}"
    per_hour = int(limit.get("perHour") or 0)
    if per_hour > 0 and len(slot["hour"]) >= per_hour:
        return False, "limit:hour", f"超过每小时上限 {per_hour}"
    per_day = int(limit.get("perDay") or 0)
    if per_day > 0 and len(slot["day"]) >= per_day:
        return False, "limit:day", f"超过每天上限 {per_day}"
    slot["minute"].append(now_ms)
    slot["hour"].append(now_ms)
    slot["day"].append(now_ms)
    slot["lastAt"] = now_ms
    return True, "", ""


def post_trigger(
    cfg: dict[str, Any],
    limits_state: dict[str, Any],
    chat_id: str,
    now: datetime | None = None,
    rng=None,
    skip_limits: bool = False,
) -> tuple[bool, str, str]:
    """触发之后的概率与频次；硬定向只免限流，概率仍生效。"""
    rng = rng or random.random
    now = now or datetime.now()
    chance = float(cfg.get("replyChance", 1.0))
    if chance < 1 and rng() >= chance:
        return False, "chance", f"触发后概率未通过（{chance:g}）"
    if skip_limits:
        return True, "", ""
    return check_limits(limits_state, chat_id, cfg, now.timestamp() * 1000)


# --------------------------------------------------------------------------- #
# 主判定
# --------------------------------------------------------------------------- #
def _keyword_trigger(text: str, keywords: list[Any]) -> tuple[bool, str, str]:
    for word in keywords:
        if word and str(word) in text:
            return True, "keyword:" + str(word), f"命中关键词「{word}」"
    return False, "no:keyword", "关键词未命中"


def decide(
    batch: dict[str, Any],
    cfg: dict[str, Any],
    limits_state: dict[str, Any],
    now: datetime | None = None,
    rng=None,
) -> dict[str, Any]:
    rng = rng or random.random
    now = now or datetime.now()
    trigger = cfg.get("trigger") or {}
    mode = str(trigger.get("mode") or "at")

    if mode not in TRIGGER_MODES:
        return _verdict(False, "config:mode", "触发模式非法", "rule")

    if in_dnd(cfg, now):
        return _verdict(False, "dnd", "免打扰时段", "rule")

    ok, rule, reason = access_allowed(
        batch["kind"], batch["user_id"], batch["group_id"], batch["chat_id"], cfg
    )
    if not ok:
        return _verdict(False, rule, reason, "rule")

    details = {
        k: batch[k]
        for k in (
            "at_me",
            "at_all",
            "name_hit",
            "reply_to_bot",
            "reply_to_other",
            "master_bypass",
            "digit_chain",
            "banter",
            "at_others",
            "at_others_only",
            "asks_bot",
            "has_image",
        )
    }

    triggered = False
    rule = ""
    reason = ""
    # 引用别人的话不算「别人在叫它」，但允许按第三方旁观插一句：
    # 只在 at/reply 这两种「看指向」的模式下生效，keyword/random 群不受影响。
    reply_other_addressed = bool(batch.get("reply_to_other")) and mode in ("at", "reply")

    if batch["kind"] == "dm":
        dm_mode = str(((cfg.get("dm") or {}).get("trigger") or {}).get("mode") or "always")
        if dm_mode == "keyword":
            triggered, rule, reason = _keyword_trigger(batch["text"], trigger.get("keywords") or [])
        elif dm_mode == "regex":
            pattern = str(trigger.get("regex") or "")
            if pattern == "":
                triggered, rule, reason = True, "regex", "私聊（正则为空，放行）"
            else:
                try:
                    hit = bool(re.search(pattern, batch["text"]))
                except re.error:
                    hit = False
                triggered, rule, reason = (
                    (True, "regex", "命中正则") if hit else (False, "no:regex", "私聊正则未命中")
                )
        elif dm_mode == "random":
            chance = float(trigger.get("chance") or 1.0)
            if rng() < chance:
                triggered, rule, reason = True, "random", f"随机命中（{chance:g}）"
            else:
                triggered, rule, reason = False, "no:random", "私聊随机未命中"
        else:
            triggered, rule, reason = True, "dm:always", "私聊消息"
    elif batch["addressed"] or reply_other_addressed:
        triggered = True
        if batch["at_me"]:
            rule = "at:segment"
        elif batch["name_hit"]:
            rule = "at:name"
        elif batch["reply_to_bot"]:
            rule = "reply:bot"
        elif batch["bili_card"]:
            rule = "bili:card"
        elif reply_other_addressed:
            rule = "reply:other"
        else:
            rule = "master:cue"
        if rule == "master:cue":
            # 旧版这里对四种规则共用「消息直接指向机器人」，主人 cue 并没有
            # 被指向的含义，按来源分开写，审计才解释得通。
            src = _master_cue_source(batch["text"], batch["has_image"])
            reason = f"{MASTER_CUE_LABELS[src]}（master:cue:{src}）"
        elif rule == "bili:card":
            reason = "转发了 B 站视频卡片（bili:card）"
        elif rule == "reply:other":
            reason = "引用的是别人的话，按第三方旁观插一句（reply:other）"
        else:
            reason = "消息直接指向机器人（" + rule + "）"
    elif batch["asks_bot"]:
        # 硬规则：直接冲它问/质问，即使没 @、没引用、离上一句很久，也必须回。
        # 21:54:11「那你怎么不回了」曾被走到 R5:model 判成「过期追问」沉默。
        triggered, rule = True, "ask:bot"
        reason = "直接追问/质问机器人（没 @ 也算被叫到），回一句短的即可（ask:bot）"
    elif batch["banter"]:
        triggered, rule, reason = True, "banter:digit", "数字接龙"
    elif mode == "keyword":
        triggered, rule, reason = _keyword_trigger(batch["text"], trigger.get("keywords") or [])
    elif mode == "regex":
        pattern = str(trigger.get("regex") or "")
        if pattern != "":
            try:
                hit = bool(re.search(pattern, batch["text"]))
            except re.error:
                hit = False
            triggered, rule, reason = (
                (True, "regex", "命中正则") if hit else (False, "no:regex", "正则未命中")
            )
        else:
            triggered, rule, reason = False, "no:regex", "正则为空，未触发"
    elif mode == "random":
        chance = float(trigger.get("chance") or 1.0)
        if rng() < chance:
            triggered, rule, reason = True, "random", f"随机命中（{chance:g}）"
        else:
            triggered, rule, reason = False, "no:random", "随机未命中"
    elif mode == "always":
        triggered, rule, reason = True, "always", "全量触发"
    elif mode == "reply":
        triggered, rule, reason = False, "no:reply", "未回复机器人"
    else:
        triggered, rule, reason = False, "no:at", "未 @、未点名、未回复机器人"

    if not triggered:
        return _verdict(False, rule or ("no:" + mode), reason or "未触发", "rule", details=details)

    # 硬定向（@ / 点名 / 引用机器人 / 主人 cue）是判定层已经拍板的「该回」：
    # 免限流，但 replyChance 仍生效（现网 @ 也过 chance；judge 分支才两者都不经）。
    if batch["addressed"]:
        ok, rule2, reason2 = post_trigger(
            cfg, limits_state, batch["chat_id"], now, rng, skip_limits=True
        )
        if not ok:
            return _verdict(False, rule2, reason2, "policy", details=details)
        return _verdict(True, rule, reason, "rule", True, True, details)

    ok, rule2, reason2 = post_trigger(cfg, limits_state, batch["chat_id"], now, rng)
    if not ok:
        return _verdict(False, rule2, reason2, "rule", details=details)

    return _verdict(True, rule, reason, "rule", True, True, details)
