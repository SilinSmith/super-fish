# 架构与职责边界

## 1. 总览

栈里有两条链路，共用同一个本地模型服务与媒体设施：

```text
【当前主链路】
QQ 账号 ──> OneBot 11 协议端（外部，需自备） ──OneBot 11──> bridge ──过滤──> AstrBot ──> xzy 插件
                                                                             └──> 本地模型 8094

【旧链路 / 灰度】
QQ 账号 ──> OneBot 11 协议端（外部） ──OneBot 11──> dsh-onebot 插件 ──> persona proxy 1240 ──> 8094
```

选择 AstrBot 作为主链路的原因：原生 agent 循环、工具注册、会话历史管理、WebUI 都已具备。xzy 只补「原生没有的」：人格只读注入、presence、审计、审校、记忆、媒体工具、防抖与拆条。

协议端是外部依赖：本仓库不包含、也不管理任何具体协议端的安装与运行，只要求它提供 OneBot 11 事件与动作。能力要求与接口契约见 [upstream.md](upstream.md#3-onebot-协议端接口契约)。

## 2. 部件职责

### 2.1 AstrBot 插件 `xzy`

| 模块 | 职责 | 不做什么 |
|---|---|---|
| `main.py` | 插件生命周期、配置合并、入站/出站主流程、防抖合批、限流、拆条 | 不直接判定「该不该接话」的语义（交给 `judge` / `policy`） |
| `policy.py` / `judge.py` | 是否响应、是否指向机器人、接话判定、自由参与群 | 不发送消息 |
| `persona_inject.py` | 只读注入人格、记忆、presence、输出规范 | 不写人格文件 |
| `memory_context.py` / `tools_memory.py` | 记忆检索与 `qq_notebook` 写入 | 不跨场景泄露（按来源过滤） |
| `review.py` / `review_gate.py` / `outbound_clean.py` / `bubbles.py` | 二审、清洗、拆条、发送前闸门 | 不决定是否撤回 |
| `send_dedupe.py` / `tool_send.py` / `answer_ledger.py` | 去重、发送、台账 | 不生成内容 |
| `self_iter.py` / `self_iter_store.py` | 闲时自迭代，只产出提案 | 不自动 apply（`auto_apply=false`） |
| `media_*.py` | 出图、视频抽帧、B 站、TTS、身份索引 | 不越过 `media_fence` 的并发/配额 |
| `mood.py` / `presence` | 情绪与专注度状态 | 不参与硬规则判定 |

### 2.2 bridge

`bridge/bridge.py` 是一个无状态的 OneBot 事件转发器，只做三件事：

1. 连接 OneBot 协议端（3001）与 AstrBot（6199/ws），双向转发；
2. 按 `bridge-mode.json` 过滤入站：`old`（不转发）/ `private` / `one-group` / `groups` / `all`；
3. 落台账：撤回需要的 `message_id`、入站原始事件与运行日志。

它**不解析业务语义**，也不重试业务失败；重连由自带循环负责。

### 2.3 QQ 通道（我们自研的部分）

- `qq-channel/onebot-plugin/`：自研 OneBot 插件，走 DSH 宿主，三层配置合并（默认 → 群 → 私信），只做协议接入与策略判定。
- `qq-channel/platform/`：入站事件归一化层（`【元】{json}` 信封），插件与 proxy 共用，避免各写一套解析。

这两部分只消费 OneBot 11 事件与动作，不依赖任何特定协议端的实现细节。协议端本身需要你自备。

### 2.4 persona proxy（Harness 侧）

`harness/proxy/proxy.mjs` 是旧链路的网关，也是当前链路的可选依赖（判定、二审、媒体队列）：

- 模型调用与 prompt 预算（`llm-config.mjs`）；
- 人格/记忆/任务状态注入；
- 工具目录与主宿主的工具调用改写（`tool-catalog.mjs`、`workspace-guard.mjs`）；
- 二审、回声守卫、10 字窗口判重、延时队列、B 站与出图任务。

### 2.5 编排

`orchestration/` 只做「探测 → 拉起 → 复核」：

- `start-bot.ps1`：幂等入口，按契约顺序探测；`-ConnectTraffic` 才进 QQ 链路。
- `start-dsh.ps1`：更完整的 9 步启动，含引擎恢复守护与外部协议端就绪探测。
- `bot-child-watchdog.ps1`：看守 AstrBot 与 bridge，消失即退避拉起。
- `harness-watchdog.ps1`：看守 Harness 宿主，并在启动前清理失效的 `dsh-auth-*` cookie。
- `engine-restore-watchdog.ps1`：引擎掉线恢复（只读 `engine.stop` 标记，绝不主动写）。
- `hidden-launch.ps1` / `run-detached.vbs`：统一隐藏窗口拉起，避免终端关闭带走进程。
- `window-check.ps1`：启动后自检是否产生了可见窗口，非零即告警。
- `reload-host.ps1` / `reload-xzy.ps1`：重载 Harness 配置 / 重载 xzy 插件。

### 2.6 控制台

`console/server.mjs` 仅监听 `127.0.0.1:1242`：读状态、读写配置、调用既有 ps1 启停、查看日志。保存配置前执行与热重载一致的校验；非法拒绝并回显原因，合法才原子写入。

## 3. 关键设计约束

1. **单向依赖**：连接 → 放行判定 → 上下文 → 模型调用 → 清洗 → 出站。撤回是 outbound 的显式独立动作（策略与执行分离）。
2. **fail-closed**：硬规则（路径越界、权限、工具名）命中即拒绝；软规则失败才允许降级。
3. **影子先行**：新通道先只记录判定、不发送；比对一致后切主。
4. **隐私隔离**：记忆按来源场景/对象/敏感级别存储，检索时按当前场景过滤，不靠提示词约束。
5. **不改上游源码**：对 AstrBot 只做 P01–P06 共 7 个落点的最小补丁，登记在 `astrbot-plugin/patches/registry.md`。
6. **可回滚**：配置整份原子替换；bridge 模式可一键切回 `old`；补丁用 `original/` 覆盖回滚。

## 4. 失败与降级

| 场景 | 行为 |
|---|---|
| 模型 5xx / 超时 | 上游错误不透传到群里；重试耗尽后本轮沉默（补丁 P04/P06） |
| 引擎瞬时 500（共享前缀准入） | 200–500ms 起指数退避，最多 3 次 |
| judge 超时 | 按配置降级为「不接话」，不阻塞主流程 |
| 二审不可用 | `review.failOpen=true` 时放行，但硬规则仍先执行 |
| bridge 断线 | 2 秒重连；期间消息不补发（避免陈旧回复） |
| 外部协议端未就绪 | 只记警告，不阻塞其余组件；退出码不受影响 |
| 控制台配置非法 | 拒绝保存并保留上一份有效配置 |
| 插件被重载 | `terminate` 回收后台任务，避免 tick 重复 |
