# 配置项与需要自己填的内容

配置分四层：**上游配置**（AstrBot / OneBot 协议端 / DSH）、**本仓库示例配置**、**私有数据文件**、**环境变量**。仓库只提供脱敏示例，真实值一律自备。

## 1. 上游配置（不在本仓库）

| 文件 | 要填什么 |
|---|---|
| `ASTRBOT_DATA/cmd_config.json` | AstrBot 的 provider（`base_url` 指向你的模型服务、`api_key`、模型名）、aiocqhttp 平台（监听 6199）、WebUI 端口 6299、登录密码。**含密码哈希与 JWT secret，绝不要提交** |
| `ASTRBOT_DATA/data/plugins/xzy/` | 放置本仓库的 `astrbot-plugin/xzy/`（整目录复制，保留目录名 `xzy`） |
| 你的 OneBot 协议端配置（需自备） | OneBot HTTP 3000 / WS 3001、上报格式；具体文件名与格式由所选协议端决定，本仓库不提供 |
| DSH profile `cordis.patch.yml` | 见 `config-examples/cordis.patch.example.yml` |

AstrBot 的根目录判定是 `cwd + .astrbot`，所以启动时的 `-WorkingDirectory` 必须是实例目录（例如 `...\inst`），不是 venv 根。

## 2. 插件 xzy：`ASTRBOT_DATA/xzy/xzy-config.json`

示例：[config-examples/xzy-config.example.json](../config-examples/xzy-config.example.json)。
文件不存在时插件会把内置默认值写出来。配置是**深合并**：示例里没写的键自动用内置默认值。

必须自己确认的字段：

| 字段 | 说明 |
|---|---|
| `master_qq` | 主人 QQ；只有主人能触发特权指令 |
| `persona_path` | 人格文件 `character.md`（**自备，仓库不含**） |
| `notebook_path` | 长期记忆 JSON（**自备**） |
| `media_dir` | 媒体落盘目录，留空用 AstrBot 数据根下的默认目录 |
| `access.allowUsers` / `allowGroups` | 白名单；`allowAll=false` 时未列入的私聊/群一律不响应 |
| `trigger.*` | 触发方式（`at`/`keyword`/`regex`/`random`/`reply`/`always`）、昵称、是否回应机器人 |
| `judge.enabled/groups` | 判定器白名单群；`proxyBase` 指向 1240 |
| `free_chat.groups` | 自由参与群及每群节流 |
| `review.enabled/url/model` | 二审；关闭时只跑机器硬规则 |
| `tts.enabled/url/modelName/speakerName` | 语音；默认关闭 |
| `limits` / `dnd` / `night_quiet` | 限流、免打扰、夜间静默 |
| `self_iter.auto_apply` | 必须保持 `false`：自迭代只出提案 |

`identity.dir` 留空时用 `ASTRBOT_DATA/xzy/identity`。

## 3. 人格与记忆（自备，仓库不含）

放在 `ASTRBOT_DATA/xzy/persona/`：

| 文件 | 用途 | 说明 |
|---|---|---|
| `character.md` | 人格正文，只读注入 | 由你撰写；插件不会自动改写 |
| `notebook.json` | 长期记忆 | 由 `qq_notebook` 工具写入 |
| `diary.jsonl` | 日记 | 追加式 |
| `identity-index.jsonl` / `identity-candidates.json` | 看图身份索引 | 首次运行可为空 |
| `recall-ledger.jsonl` | bridge 撤回台账 | bridge 自动生成 |
| `ask-queue.jsonl` / `ask-answers.jsonl` / `asks.jsonl` | 「问主人」慢通道 | 由 `ask-gate.mjs` 维护 |
| `media/` | 图片/语音缓存 | 大文件，不入库 |
| `bili-cookies.json` | B 站登录态 | 敏感，不入库 |

以上路径都可由环境变量覆盖（见第 6 节）。**仓库里一个都没有**，需要自己创建空文件或让程序首次运行时生成。

## 4. 桥接与代理

### `bridge-mode.json`

示例：[config-examples/bridge-mode.example.json](../config-examples/bridge-mode.example.json)。
放在 bridge 工作目录（`--home`，默认脚本同目录），或 `--mode-file` 指定。

- `old`：不转发（停机/回滚用）
- `private`：只转发私聊
- `one-group`：私聊 + 单个 `group_id`
- `groups`：私聊 + `group_ids` 列表
- `all`：全部

### `harness/proxy/llm-backend.json`

示例：[config-examples/llm-backend.example.json](../config-examples/llm-backend.example.json)。

必填：`baseUrl`（模型服务 `/v1`）、`model`、`apiKey`（本地服务通常空）、
`engineControl.*`（如果你希望 proxy 能拉起/停止引擎）、`qq.*`（OneBot 协议端的 3000/3001 端口与就绪超时）。

`engineControl.mode=external` 表示引擎由外部脚本管理，proxy 只探测健康。

### `qq-channel/onebot-plugin/config.json`（旧链路 / 灰度）

示例：[config-examples/onebot-plugin-config.example.json](../config-examples/onebot-plugin-config.example.json)。

三层合并：`default` → `groups[群号]` → `dm`。群级只允许行为字段（触发、概率、限流、免打扰、审校、上下文），出现 persona/tone 会被判为配置错误。

必填：`bot.qq`、`bot.masterQQ`、`runtime.cwd`、`runtime.provider/model`、`default.access.*`、`groups`。

## 5. 控制台

无配置文件。启动时读环境变量 `QQ_CONSOLE_PORT`（默认 1242），只监听 `127.0.0.1`。
它读写 `qq-onebot-plugin/config.json` 与 xzy 的人格目录，保存前做与热重载相同的校验。

## 6. 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `QQ_SELF_ID` | 机器人自己的 QQ（bridge 丢弃回声、识别自撤回） | `10001` |
| `QQ_CUTOVER_DIR` | bridge 工作目录（模式/日志） | 脚本所在目录 |
| `QQ_CONSOLE_ONEBOT_LOG_DIR` | 控制台读取外部协议端日志的目录（可选，留空则不展示） | 空 |
| `QQ_CONSOLE_PORT` | 控制台端口 | `1242` |
| `QQ_DSH_ROOT` | 控制台读日志/状态的 DSH 根 | `Y:\dsh` |
| `XZY_PERSONA_DIR` | AstrBot 人格目录 | `E:\Bonsai\...\xzy\persona` |
| `XZY_CUTOVER_DIR` | xzy 读撤回台账的目录 | `Y:\dsh\home\qq-cutover` |
| `QQ_PROXY_ROOT` / `QQ_PERSONA_HOME` / `QQ_PERSONA_ROOT` | proxy 的状态根 | `Y:\dsh\home\qq-persona` |
| `QQ_UPSTREAM_MAX_CONCURRENCY` / `QQ_UPSTREAM_QUEUE_LIMIT` | 模型并发与排队上限 | `3` / `8` |
| `ASTRBOT_VENV` | 补丁器目标 venv | `E:\Bonsai\astrbot-eval\venv` |
| `NODE_EXE` | proxy 启动用 node | PATH 中的 `node` |
| `QQ_BILI_APPKEY` / `QQ_BILI_APP_SECRET` | B 站上传签名（仓库不内置） | 空 |
| `DSH_QQ_PLATFORM_EVENT` / `DSH_ONEBOT_EVENT_PATH` / `DSH_TOOLS_ENTRY` | 旧链路模块路径覆盖 | 见代码 |
| `NINFER_API_KEY` | 模型服务鉴权（如需要），放在 `%USERPROFILE%\.dsh\.env` 或进程环境 | 空 |

> 代码中的默认绝对路径是作者机器的部署布局，仅作示例；迁移时用环境变量或配置覆盖，不要改代码逻辑。

## 7. 编排脚本里的部署路径

同目录的脚本现在按 `$PSScriptRoot` 互相查找（`start-bot` → `start-dsh` → watchdog / `run-detached.vbs` / `window-check`），所以仓库放在哪个盘都能串起来。仍需按你的机器修改的是**外部组件与工作目录**：

| 文件 | 常量 / 位置 | 说明 |
|---|---|---|
| `orchestration/start-dsh.ps1` | `$Root`、`$PersonaRoot`、`$WorkDir` | DSH 部署根、persona 根、日志工作目录 |
| `orchestration/start-bot.ps1` | `$Root`、`$LogPath`、`$script:PluginLog`、`$script:ModelId` | 部署根、启动日志、旧插件日志、日志里展示的模型名 |
| `orchestration/bot-child-watchdog.ps1` | `$Components` 里的 `filePath` / `arguments` / `cwd` / `outLog` | venv python、`bridge.py`、AstrBot 实例目录（必须是含 `.astrbot` 的目录） |
| `orchestration/stop-dsh.ps1` | `$WatchdogScripts`、`$Root\home\...` | 控制台/日志监看看护脚本的位置；不存在会跳过 |
| `orchestration/harness-watchdog.ps1` | `$Definition` / `$Root` | Harness 可执行文件、profile 路径 |
| `orchestration/reload-xzy.ps1` | AstrBot 数据根与插件目录 | 重载时复制/触达的路径 |
| `console/watchdog.ps1` | `$server`、`$log` | 控制台入口与日志路径 |

日志目录（`$WorkDir`）默认是 `<Root>\2026-11-10\qqbot-ninfer-bridge\work`，这是历史命名；换目录时同步改 `start-bot.ps1` 的 `$LogPath` 和 VBS 里的 `logPath`。

外部 OneBot 协议端不在编排脚本的拉起范围，因此不需要在这里配置它的安装路径或启动命令；只需保证 3000/3001 可用。

