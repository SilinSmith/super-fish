# AstrBot 补丁登记表（唯一清单）

- 目标版本：**4.14.6**（`E:\Bonsai\astrbot-eval\venv`）。升级/重装 venv 后必须先 `python apply.py` 再 `python verify.py`，全绿才允许启动。
- 规则：只改本表登记的文件；每处改动带 `# [XZY-Pxx]` 标记；`apply.py` 幂等、锚点必须精确唯一、找不到即报错退出；`original/` 保存首次改动前的原文件。
- 回滚：用 `original/` 下对应文件覆盖 venv，再重启。插件 `version_compat.assert_patches()` 会因标记消失进入 degraded。

| ID | 文件（相对 `venv/Lib/site-packages/`） | 锚点 | 改法 | 为什么原生不够 | 升级复核 |
|---|---|---|---|---|---|
| P01 | `astrbot/core/provider/manager.py` | `get_using_provider` 内 `if not provider:` 分支的 chat 回落 `provider = self.provider_insts[0] if self.provider_insts else None`（约 L180-190；L209 的 warning 在回落后永不触发） | 找不到配置 ID 时 `logger.error` 并 `provider = None`，禁止回落 | 静默换模型，日志不可见；REPORT §4 已实测 | `grep -n "provider_insts\[0\]"`；把 `default_provider_id` 改成不存在 ID 跑一次，断言出现 `[XZY-P01]` ERROR 且请求不落到 8094 |
| P02 | `astrbot/core/astr_main_agent.py` | `if req.func_tool:` 下 `if "tool_use" not in provider_cfg:` 分支（L625-631，含 `req.func_tool = None`） | 保留 `req.func_tool`，仅 `logger.error` | 静默清空全部工具，模型以为没有工具；REPORT §1 已实测 | `grep -n "clearing tools"` 应无输出；启动自检断言 `modalities` 含 `tool_use` |
| P03 | `astrbot/core/star/star_manager.py` | `_terminate_plugin` 内 `elif "terminate" in star_metadata.star_cls_type.__dict__:`（L936） | 改为 `elif hasattr(star_metadata.star_cls_type, "terminate"):` | 只认类体直写，继承来的 `terminate` 被跳过，后台任务不回收 | `grep -n "star_cls_type.__dict__"` 应无输出；重载审计断言出现 `plugin_terminate` 且 tick 只有一份 |
| P04a | `astrbot/core/astr_agent_run_util.py` | `run_agent` 的 `except Exception as e:` 分支（L135-155，`err_msg = "AstrBot 请求失败。错误类型..."` + `set_result/yield`） | 只 `logger.error`，`completion_text=""`，不 `set_result` / 不 `yield` 错误文本 | 把上游 400/503 原文直接发到会话；REPORT §8 已实测 | `grep -n "AstrBot 请求失败"` 后确认后面无 send/set_result；503 演练断言群里无错误文本 |
| P04b | `astrbot/core/pipeline/process_stage/method/agent_sub_stages/internal.py` | `except Exception as e:` 分支（L324-330，`await event.send(MessageChain().message(f"Error occurred while processing agent request: {e}"))`） | 只 `logger.error` + `event.clear_result()` | 同上，第二处外发点 | `grep -n "Error occurred while processing agent request"` 应无输出 |
| P05a | 同上 `internal.py` | `_save_to_history` 末尾 `await self.conv_manager.update_conversation(...)`（L368-373） | 写回前调用 `_xzy_p05_history_guard(...)`，按 `history_mode` 得到要写回的历史 | 截断后写回会不可恢复地覆盖旧历史（实测 46→16），原生没有快照/回滚 | `grep -n "_xzy_p05_history_guard"`；长会话跑一轮，断言 `history_snapshots/` 出现快照且 `dropped_count>0` |
| P05b | 同上 `internal.py` | `# we prevent astrbot from connecting to known malicious hosts` 之前 | 插入 `_xzy_p05_history_guard`：快照落盘 + `writeback`/`request_only` 双模式 + `audit/history_writeback.jsonl` | 同上；模式开关与快照必须集中在一处 | `grep -n "history_snapshots\|request_only"`；把 `history_mode.json` 改 `request_only`，断言下轮 pre_count 不再下降 |
| P06 | `astrbot/core/provider/sources/openai_source.py` | `_query` 里 `completion = await self.client.chat.completions.create(... stream=False ...)`（L115-119）与 `_query_stream` 里 `stream = await ...create(... stream=True ...)`（L163-167）；辅助函数插在 `from ..register import register_provider_adapter` 与 `@register_provider_adapter(` 之间；两个客户端构造处（`AsyncOpenAI` / `AsyncAzureOpenAI`）与 `from openai._exceptions import NotFoundError` | 两处 create 改走 `_xzy_p06_create_with_retry`：重试范围 = 500/502/503/504 + `APIConnectionError`/`APITimeoutError`，退避 200-500ms 起逐次翻倍、±15% 抖动，最多 3 次尝试；成功打 `重试后成功`，耗尽管 `重试耗尽` 并附上游原文；400/401/422/429 原样抛出。两个客户端均设 `max_retries=0`，让 P06 成为唯一重试策略 | 引擎 `prepared shared candidates exceeded the fixed subset bound` 的 500 属于准入期瞬时错误，原生 `_handle_api_error` 直接 raise，P04 抑制后整条回复消失；SDK 自带 2 次重试会与 P06 相乘，关掉后单次运行最多 3 个实际请求 | `grep -n "_xzy_p06_create_with_retry"` 应有 1 处定义 + 2 处调用；`grep -n "max_retries=0"` 应有 2 处；`venv\Scripts\python.exe patches\test_p06.py` 五场景全 PASS（连接拒绝耗尽、第 2 次成功、三次 500 耗尽、400 不重试、provider 实际请求数=3） |

> 事实修正（相对旧 REPORT / 旧 spec）：
> 1. 4.14.6 的**重载会调用 `terminate`**（实测 `runtime_start → plugin_terminate → runtime_start`）；真坑是 `__dict__` 只认类体直写 + `activated` 为假时跳过。
> 2. 4.14.6 的压缩**没有**「保留最近 15%」逻辑，实际是 `truncate_by_turns` 丢最旧 1 轮 + 仍超则腰斩 50%。
> 3. 「错误类型」原文出自 `astr_agent_run_util.py:138`，不是 `internal.py`；`internal.py` 另有一处英文异常外发。故 P04 拆成 a/b 两处。

> 不打的候选：压缩阈值、工具进度文案——先用配置对齐，无实测证据前不魔改。
