# 上游依赖、OneBot 接口契约与魔改点

本仓库**不包含任何上游项目的源码或发行物**（包括改过的），只包含我们写的插件、桥接、脚本、控制台和示例配置。下面是跑通整套所需的上游、我们对上游做过的最小改动，以及协议端需要满足的接口契约。

## 1. 上游清单

| 上游 | 版本 / 范围 | 作用 | 安装与准备 |
|---|---|---|---|
| AstrBot | **4.14.6（锁定）** | 机器人框架，加载 xzy 插件 | 建议独立 venv；数据根需存在 `.astrbot` 与 `data/cmd_config.json`；版本不符时 `version_compat.py` 会告警并进入 degraded |
| OneBot 11 协议端 | 任意可用实现（需自备） | 把 QQ 账号转换成 OneBot 11 事件与动作 | 需监听 3000 HTTP / 3001 WS；满足第 3 节的接口契约；安装、登录与运行由你自行管理 |
| QQ 账号 | 由你的协议端管理 | 机器人身份 | 自行登录；本仓库不保存账号、密码与登录态 |
| 本地模型服务 | OpenAI 兼容 `/v1` | 对话、判定、二审、视觉 | 默认 `127.0.0.1:8094`；模型名、上下文、并发由你的引擎决定 |
| DeepSeek Harness（DSH） | 桌面端 `0.2.1-rc.5` 一类 | 旧链路宿主，加载 `dsh-onebot-qq` | 仅旧链路需要；宿主与插件安装不在本仓库 |
| `dsh-onebot-qq` | `^0.9.6` | DSH 的 OneBot 通道 | 仅旧链路需要；`cordis` 配置见 `harness/cordis.patch.example.yml` |
| Python | 3.10+（与 AstrBot 一致） | 插件、bridge、补丁器 | bridge 依赖 `aiohttp` |
| Node.js | 20+ | proxy、控制台、OneBot 插件 | 控制台/proxy 无第三方运行时依赖 |
| TTS（可选） | Style-Bert-VITS2 一类 | 语音出站 | 默认 `127.0.0.1:5000`，`tts.enabled=false` 时不注册工具 |
| ComfyUI（可选） | 任意 | 出图 | `127.0.0.1:8188`；脚本只探测，不拉起 |
| ffmpeg / ffprobe（可选） | 任意 | 视频抽帧 | 需在 PATH |

## 2. 对 AstrBot 的改动（最小补丁）

只改 P01–P06 共 7 个落点，全部带 `# [XZY-Pxx]` 标记。完整锚点、原因、升级复核方法见
**[astrbot-plugin/patches/registry.md](../astrbot-plugin/patches/registry.md)**。

| ID | 文件（相对 `venv/Lib/site-packages/`） | 一句话 |
|---|---|---|
| P01 | `astrbot/core/provider/manager.py` | 找不到配置的 provider 时报错并置空，禁止静默回落到 `provider_insts[0]` |
| P02 | `astrbot/core/astr_main_agent.py` | provider 缺 `tool_use` 时保留工具，只报错（原生会静默清空） |
| P03 | `astrbot/core/star/star_manager.py` | 用 `hasattr` 识别继承来的 `terminate`，确保后台任务被回收 |
| P04a | `astrbot/core/astr_agent_run_util.py` | 上游异常只记日志，不把错误原文发到会话 |
| P04b | `astrbot/core/pipeline/.../internal.py` | 同上，抑制第二处英文异常外发 |
| P05a/b | 同上 `internal.py` | 历史写回前做快照 + `writeback`/`request_only` 双模式，避免截断不可恢复 |
| P06 | `astrbot/core/provider/sources/openai_source.py` | 对 5xx/连接错误做 3 次退避重试；关掉 SDK 自带重试，避免相乘 |

使用方式：

```powershell
# 先设好你的 venv（默认值是作者机器上的路径）
$env:ASTRBOT_VENV = "C:\astrbot\venv"
python astrbot-plugin\patches\apply.py --check   # 只检查
python astrbot-plugin\patches\apply.py           # 打补丁（幂等）
python astrbot-plugin\patches\verify.py          # 标记 + 行为校验，全绿才启动
```

`patches/original/` 是首次改动前的原文件备份，**未随仓库发布**（属于上游源码）。需要回滚时用你自己的安装副本覆盖，或重装同版本 AstrBot。

## 3. OneBot 协议端接口契约

本仓库不绑定具体协议端，只要求它提供 OneBot 11 的事件与动作。所谓「需自备」指：你需要自己安装、登录、启动并保证 3000/3001 可用；本仓库不包含协议端代码，也不提供启动或接入脚本。

### 3.1 事件（WS 3001 上报）

最低要求：

- `post_type=message`（`message_type=private` / `group`）：
  至少包含 `message_id`、`user_id`、`group_id`、`raw_message`、`message`、`sender`；
- `post_type=notice`：`group_recall`、`friend_recall`、`group_increase`、`group_decrease`、
  `group_admin`、`group_upload`、`group_ban`、`group_card`；
- `post_type=meta_event`：`lifecycle`、`heartbeat`。

`notify/input_status` 会被 bridge 当作噪声丢弃，不影响其他事件。

### 3.2 动作（HTTP 3000 或 WS 调用）

最低要求：

| 动作 | 用途 |
|---|---|
| `send_msg` / `send_private_msg` / `send_group_msg` | 发送消息（文本、图片、表情、语音等 CQ 码或消息段） |
| `get_msg` | 读取消息详情 |
| `delete_msg` | 撤回自己的消息 |
| `set_input_status(user_id, event_type)` | 私聊「正在输入」状态；群聊不要求支持 |
| `get_login_info` | 启动自检时确认登录账号 |

写操作类动作（踢人、禁言、群管理、文件操作）默认不实现；需要时按 [operations.md](operations.md) 的安全边界自行扩展。

### 3.3 部署要求

- 3000/3001 建议只监听 `127.0.0.1`，不要暴露到公网；
- 协议端与 bridge 的地址、鉴权方式由你在各自配置中保持一致；
- 协议端是否在线由 `orchestration/` 只做端口探测，未就绪只记警告，不阻塞其余组件。

## 4. 对 Harness 配置的改动（非源码）

旧链路需要在 DSH profile 的 `cordis.patch.yml` 里改接线，示例见
[config-examples/cordis.patch.example.yml](../config-examples/cordis.patch.example.yml)。要点：

- 停用 `im-qqbot`（官方 QQ 机器人通道），避免两套人设/两条连接互相打架；
- `dsh-onebot` 改为 `mode: forward`，主动连 `ws://127.0.0.1:3001`；
- `accessToken` 与你的协议端 OneBot 配置保持一致（默认空）；
- 固定 `provider: ninfer`，不让 QQ 链路继承全局默认模型；
- `workspacePath` 指向允许读写的会话工作区（沙箱边界）；
- 调试注入保持 `injectEnabled: false`、`injectDryRun: true`，避免注入回合真的发出消息。

## 5. 升级上游时的检查单

1. AstrBot 升级：先跑 `apply.py --check`，锚点不匹配会直接失败（这是有意的，避免错位打补丁）；再跑 `verify.py`；最后启动看 `version_compat` 是否 degraded。
2. 协议端升级：确认仍满足第 3 节的事件与动作契约，3000/3001 端口不变；本仓库没有需要同步修改的接入脚本。
3. DSH / `dsh-onebot-qq` 升级：`dsh-onebot` 会覆盖 `lib/event.js` 的垫片，proxy 的漂移自检会告警；按 `qq-channel/platform/` 重新接回归一化层。
4. 模型服务换实现：只改 `harness/proxy/llm-backend.json` 与 AstrBot 的 provider 配置，不改代码。
