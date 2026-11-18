# QQ 机器人栈（AstrBot × OneBot × Harness）

一套 QQ 群 / 私聊机器人的**整合方案快照**：把「AstrBot 插件」「OneBot 接入与平台归一化层」「bridge 与 Harness 接线」「本地服务编排与启停」「控制台」放在同一个仓库里，便于阅读、复用和二次改造。

> **这不是开箱即跑的项目。** 仓库里只有我们自己写的代码；AstrBot、DeepSeek Harness 等上游需要你自己安装（见 [docs/upstream.md](docs/upstream.md)），协议端、模型服务、QQ 账号、人格文件、记忆数据都需要自备（见 [docs/excluded.md](docs/excluded.md)）。

> 兼容性说明：本仓库开发期使用的协议端为 SnowLuma 2.2.1（基于 QQ NT 的注入式 OneBot 实现，需自备）；它不是必须的选择，任何能提供 OneBot 11 事件与动作的协议端都可以替换。

---

## 1. 四个部件分别是什么

| 部件 | 目录 | 职责 | 运行形态 |
|---|---|---|---|
| AstrBot 插件 `xzy` | `astrbot-plugin/xzy/` | 对话策略、触发判定、防抖合批、工具调用、记忆/人格注入、出站清洗、审校与撤回、图片/视频/B 站等媒体能力 | AstrBot 进程内加载的 Python 插件 |
| 上游补丁器 | `astrbot-plugin/patches/` | 对 AstrBot 4.14.6 的 P01–P06 共 7 个落点做最小改动，幂等打补丁 + 校验 | 独立 Python 脚本 |
| bridge / Harness 接线 | `bridge/`、`harness/` | bridge 把 OneBot 事件按模式过滤后转给 AstrBot；harness 是旧的 DSH 链路（persona 代理 1240、自迭代、`cordis` 配置示例） | Python 进程 + Node 进程 |
| QQ 通道（OneBot 接入） | `qq-channel/` | 自研 OneBot 插件与平台归一化层；通过 OneBot 11 与外部协议端对接，不负责协议端本身 | Node 侧 WS/HTTP |
| 本地服务编排与启停 | `orchestration/` | 按契约顺序探测并拉起引擎、TTS、proxy、bridge、AstrBot、控制台；守护、重载、无窗口自检 | PowerShell 5 + VBS 隐藏链 |
| 控制台 | `console/` | 本地 WebUI（127.0.0.1:1242）：状态、配置读写、启停、日志 | Node HTTP 服务 |

### 数据流（当前主链路）

```
QQ 账号
  └─ OneBot 11 协议端（外部依赖，需自备）
       ├─ OneBot 11 HTTP  :3000
       └─ OneBot 11 WS    :3001
             └─ bridge/bridge.py ──过滤(bridge-mode.json)──> AstrBot aiocqhttp :6199/ws
                                                            └─ xzy 插件（策略/工具/审校）
                                                                 ├─ 本地模型  :8094（OpenAI 兼容）
                                                                 ├─ persona proxy :1240（判定/二审/媒体，可选）
                                                                 ├─ TTS :5000（可选）
                                                                 └─ ComfyUI :8188（可选）
```

### 旧链路（DSH Harness，保留兼容）

```
QQ → OneBot 协议端 → dsh-onebot 插件 → persona proxy(1240) → 本地模型(8094)
```

当前生产以 AstrBot + xzy 为主；`harness/` 与 `qq-channel/onebot-plugin/` 是旧链路与灰度通道，默认不接流量。两条链路共用同一个本地模型服务和媒体队列。

---

## 2. 端口

| 端口 | 组件 | 说明 |
|---|---|---|
| 8094 | 本地模型服务（ninfer） | OpenAI 兼容 `/v1`，健康检查 `/v1/models` |
| 1240 | persona proxy | `/health`、`/review`、媒体与判定接口 |
| 1242 | 控制台 | 仅监听 127.0.0.1 |
| 3000 / 3001 | OneBot 协议端（外部） | HTTP / WebSocket；由你自备并启动，脚本只探测 |
| 6199 / 6299 | AstrBot | OneBot WS / WebUI |
| 5000 | TTS | 可选 |
| 8188 | ComfyUI | 可选，用户自管，脚本只探测不拉起 |

---

## 3. 启动顺序

顺序即契约，`start-bot.ps1` / `start-dsh.ps1` 按此逐项**真实探测**（不是看进程在不在）：

1. 模型服务 8094
2. TTS 5000（可选）
3. persona proxy 1240
4. OneBot 协议端 3000/3001（外部依赖，只探测不拉起）
5. bridge（先起，自带 2 秒重连循环）
6. AstrBot 6299/6199（内含 xzy 插件）
7. 控制台 1242
8. DeepSeek Harness 宿主（旧链路，可选）

```powershell
# 仅基础设施（引擎 + proxy + 控制台），不接 QQ 流量
powershell -NoProfile -ExecutionPolicy Bypass -File .\orchestration\start-bot.ps1

# 接流量（额外要求外部 OneBot 协议端 / AstrBot / bridge / Harness）
powershell -NoProfile -ExecutionPolicy Bypass -File .\orchestration\start-bot.ps1 -ConnectTraffic

# 只打印计划与就绪状态，不启动任何进程
powershell -NoProfile -ExecutionPolicy Bypass -File .\orchestration\start-bot.ps1 -ConnectTraffic -DryRun

# 停止
powershell -NoProfile -ExecutionPolicy Bypass -File .\orchestration\stop-dsh.ps1
```

退出码：`0` 全部就绪；`10` 有组件未就绪（fail-closed）。外部协议端未就绪只记为警告，不改变退出码。

---

## 4. 依赖与你必须自备的部分

### 需要你自己准备的上游

- **AstrBot 4.14.6**（锁版本，装进 venv 后先跑 `astrbot-plugin/patches/apply.py` 再跑 `verify.py`）
- **一个能提供 OneBot 11 事件与动作的协议端**（需自备；需监听 3000 HTTP / 3001 WS，动作至少覆盖 `send_msg`、`get_msg`、`delete_msg`、`set_input_status`，事件至少覆盖群/私聊消息与通知）
- **一个可登录的 QQ 账号**（由你的协议端管理）
- **本地模型服务**：OpenAI 兼容 `/v1`，默认 `127.0.0.1:8094`，模型名不写死
- **DeepSeek Harness 宿主 + `dsh-onebot-qq` 插件**（仅旧链路需要）
- 可选：TTS（Style-Bert-VITS2 一类）、ComfyUI、ffmpeg

版本、安装步骤、需要改上游的地方、OneBot 接口契约见 **[docs/upstream.md](docs/upstream.md)**。

### 需要你自己准备的私有内容

人格文件（`character.md`）、记忆/日记/身份索引、表情表 `faces.json`、`config.json` 里的账号与白名单、bridge 模式文件、各类 cookie/token。仓库只给脱敏示例，见 **[docs/configuration.md](docs/configuration.md)**；`faces.json` 的生成方法见 **[docs/faces.md](docs/faces.md)**。

---

## 5. 目录结构

```
qq-stack/
├── astrbot-plugin/
│   ├── xzy/                  # 插件源码（Python + 少量 mjs 桥接 + 文生图模板）
│   └── patches/              # apply.py / verify.py / registry.md（上游改动登记表）
├── bridge/                   # bridge.py + 切流/回滚/重启脚本
├── qq-channel/
│   ├── onebot-plugin/        # 自研 OneBot 通道插件（旧链路 / 灰度）
│   └── platform/             # 入站事件归一化层（单一事实源）
├── harness/
│   ├── proxy/                # persona proxy（判定/媒体/记忆/审校/工具目录）
│   ├── self-iter/            # 自迭代（只出提案，不自动改人格）
│   └── cordis.patch.example.yml
├── orchestration/            # 启动/停止/守护/重载/无窗口自检
├── console/                  # 本地控制台（WebUI + 静态资源）
├── config-examples/          # 全部脱敏示例配置
└── docs/
```

---

## 6. 这份仓库与「线上那一套」的差异

为了能发布，做了四类**只影响可移植性**的改动，逻辑没动：

1. 所有账号、群号、角色名替换为占位（`10000` / `10001` / `100000001` / `小助手`）。
2. 少量写死的绝对路径改为环境变量 + 相对路径默认值（见 docs/configuration.md 的环境变量表）。
3. 编排脚本之间的互调用改为按 `$PSScriptRoot` 解析，VBS 也改为相对自身目录找脚本；外部组件路径（协议端、venv、工作目录）仍是示例值，需要按机器改。
4. AstrBot / DSH 的第三方模块路径改为可覆盖的默认值，缺失时按原有降级逻辑跳过。

除此之外，插件、bridge、编排脚本、控制台均按线上版本快照复制。协议端只保留能力要求与接口契约，不包含任何具体协议端的接入脚本或逐步操作说明。

---

## 7. 没定的事

- 模型名与推理引擎参数（上下文长度、KV 池、并发）依赖具体硬件，仓库只给占位。
- 人格文件格式、记忆 schema 只做了文字说明，没有随仓库提供真实样本。
- 表情表 `faces.json` 不入库，按 [docs/faces.md](docs/faces.md) 从协议端落盘的 QQ 系统表情目录自行导出。

---

## 8. 合规声明

本项目仅用于技术交流与自用整合。使用本项目（包括接入 QQ 及任何第三方服务）时，你需要自行遵守相关平台的服务条款、当地法律法规与账号使用规则；由此产生的任何后果由使用者自行承担，与本仓库作者无关。

---

## 9. 许可证

本项目采用 **MIT License**，版权人 **SilinSmith**，全文见 [LICENSE](LICENSE)。

---

## 10. 相关文档

- [架构与职责边界](docs/architecture.md)
- [上游依赖、OneBot 接口契约与魔改点](docs/upstream.md)
- [配置项与需要自己填的内容](docs/configuration.md)
- [被排除的内容与原因](docs/excluded.md)
- [系统表情表 faces.json 的生成方法](docs/faces.md)
- [运维手册（启停/日志/排障）](docs/operations.md)
