# QQ 机器人栈（xzy × SnowLuma × AstrBot × Harness）

一套自用 QQ 群 / 私聊机器人的**整合方案快照**：把「AstrBot 插件」「SnowLuma → AstrBot 的桥接」「QQ 通道接法」「本地服务编排与启停」「控制台」放在同一个仓库里，便于阅读、复用和二次改造。

> **这不是开箱即跑的项目。** 仓库里只有我们自己写的代码；AstrBot、SnowLuma、QQ NT、DeepSeek Harness 等上游需要你自己安装（见 [docs/upstream.md](docs/upstream.md)），模型服务、QQ 账号、人格文件、记忆数据都需要自备（见 [docs/excluded.md](docs/excluded.md)）。

---

## 1. 四个部件分别是什么

| 部件 | 目录 | 职责 | 运行形态 |
|---|---|---|---|
| AstrBot 插件 `xzy` | `astrbot-plugin/xzy/` | 对话策略、触发判定、防抖合批、工具调用、记忆/人格注入、出站清洗、审校与撤回、图片/视频/B 站等媒体能力 | AstrBot 进程内加载的 Python 插件 |
| 上游补丁器 | `astrbot-plugin/patches/` | 对 AstrBot 4.14.6 的 P01–P06 共 7 个落点做最小改动，幂等打补丁 + 校验 | 独立 Python 脚本 |
| bridge / Harness 接线 | `bridge/`、`harness/` | bridge 把 SnowLuma 的 OneBot 事件按模式过滤后转给 AstrBot；harness 是旧的 DSH 链路（persona 代理 1240、自迭代、`cordis` 配置示例） | Python 进程 + Node 进程 |
| QQ 通道（SnowLuma 注入形态） | `qq-channel/` | SnowLuma 以原生 hook 注入 QQ NT，暴露 OneBot 11（3001 WS / 3000 HTTP）；附带自研 OneBot 插件与平台归一化层 | QQ NT 内注入 + Node 侧 WS |
| 本地服务编排与启停 | `orchestration/` | 按契约顺序探测并拉起引擎、TTS、proxy、SnowLuma、bridge、AstrBot、控制台；守护、重载、无窗口自检 | PowerShell 5 + VBS 隐藏链 |
| 控制台 | `console/` | 本地 WebUI（127.0.0.1:1242）：状态、配置读写、启停、日志 | Node HTTP 服务 |

### 数据流（当前主链路）

```
QQ 客户端
  └─ SnowLuma（注入 QQ NT）
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
QQ → SnowLuma → dsh-onebot 插件 → persona proxy(1240) → 本地模型(8094)
```

当前生产以 AstrBot + xzy 为主；`harness/` 与 `qq-channel/onebot-plugin/` 是旧链路与灰度通道，默认不接流量。两条链路共用同一个本地模型服务和媒体队列。

---

## 2. 端口

| 端口 | 组件 | 说明 |
|---|---|---|
| 8094 | 本地模型服务（ninfer） | OpenAI 兼容 `/v1`，健康检查 `/v1/models` |
| 1240 | persona proxy | `/health`、`/review`、媒体与判定接口 |
| 1242 | 控制台 | 仅监听 127.0.0.1 |
| 3000 / 3001 | SnowLuma OneBot | HTTP / WebSocket |
| 5099 | SnowLuma WebUI | 上游自带 |
| 6199 / 6299 | AstrBot | OneBot WS / WebUI |
| 5000 | TTS | 可选 |
| 8188 | ComfyUI | 可选，用户自管，脚本只探测不拉起 |

---

## 3. 启动顺序

顺序即契约，`start-bot.ps1` / `start-dsh.ps1` 按此逐项**真实探测**（不是看进程在不在）：

1. 模型服务 8094
2. TTS 5000（可选）
3. persona proxy 1240
4. SnowLuma 3001 + QQ 客户端（注入宿主）
5. bridge（先起，自带 2 秒重连循环）
6. AstrBot 6299/6199（内含 xzy 插件）
7. 控制台 1242
8. DeepSeek Harness 宿主（旧链路，可选）

```powershell
# 仅基础设施（引擎 + proxy + 控制台），不接 QQ 流量
powershell -NoProfile -ExecutionPolicy Bypass -File .\orchestration\start-bot.ps1

# 接流量（额外要求 SnowLuma / AstrBot / bridge / Harness）
powershell -NoProfile -ExecutionPolicy Bypass -File .\orchestration\start-bot.ps1 -ConnectTraffic

# 只打印计划与就绪状态，不启动任何进程
powershell -NoProfile -ExecutionPolicy Bypass -File .\orchestration\start-bot.ps1 -ConnectTraffic -DryRun

# 停止
powershell -NoProfile -ExecutionPolicy Bypass -File .\orchestration\stop-dsh.ps1
```

退出码：`0` 全部就绪；`10` 有组件未就绪（fail-closed）。

---

## 4. 依赖与你必须自备的部分

### 需要你自己准备的上游

- **AstrBot 4.14.6**（锁版本，装进 venv 后先跑 `astrbot-plugin/patches/apply.py` 再跑 `verify.py`）
- **SnowLuma**（OneBot 11 实现，注入 QQ NT）
- **QQ NT 客户端**
- **本地模型服务**：OpenAI 兼容 `/v1`，默认 `127.0.0.1:8094`，模型名不写死
- **DeepSeek Harness 宿主 + `dsh-onebot-qq` 插件**（仅旧链路需要）
- 可选：TTS（Style-Bert-VITS2 一类）、ComfyUI、ffmpeg

版本、安装步骤、需要改上游的地方见 **[docs/upstream.md](docs/upstream.md)**。

### 需要你自己准备的私有内容

人格文件（`character.md`）、记忆/日记/身份索引、`config.json` 里的账号与白名单、bridge 模式文件、各类 cookie/token。仓库只给脱敏示例，见 **[docs/configuration.md](docs/configuration.md)**。

---

## 5. 目录结构

```
qq-stack/
├── astrbot-plugin/
│   ├── xzy/                  # 插件源码（Python + 少量 mjs 桥接 + 文生图模板）
│   └── patches/              # apply.py / verify.py / registry.md（上游改动登记表）
├── bridge/                   # bridge.py + 切流/回滚/重启/恢复清单
├── qq-channel/
│   ├── snowluma-inject.mjs   # SnowLuma 原生 hook 注入脚本
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

为了能发布，做了三类**只影响可移植性**的改动，逻辑没动：

1. 所有账号、群号、角色名替换为占位（`10000` / `10001` / `100000001` / `小助手`）。
2. 少量写死的绝对路径改为环境变量 + 相对路径默认值（见 docs/configuration.md 的环境变量表）。
3. AstrBot / DSH 的第三方模块路径改为可覆盖的默认值，缺失时按原有降级逻辑跳过。

除此之外，插件、bridge、编排脚本、控制台均按线上版本快照复制。

---

## 7. 没定的事

- **许可证未定**（作者尚未决定，暂不添加 `LICENSE`；对外使用前请先确认）。
- 模型名与推理引擎参数（上下文长度、KV 池、并发）依赖具体硬件，仓库只给占位。
- `astrbot-plugin/xzy/faces.json` 是上游表情目录的衍生物，未纳入；插件在文件缺失时降级为不发表情。
- 人格文件格式、记忆 schema 只做了文字说明，没有随仓库提供真实样本。

---

## 8. 相关文档

- [架构与职责边界](docs/architecture.md)
- [上游依赖与魔改点](docs/upstream.md)
- [配置项与需要自己填的内容](docs/configuration.md)
- [被排除的内容与原因](docs/excluded.md)
- [运维手册（启停/日志/排障）](docs/operations.md)
