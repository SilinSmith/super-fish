# QQ 链路恢复清单（2026-11-14 手动全停后）

> 停机原因：用户腾机器，QQ 连接与引擎由另一会话全部停掉。
> 当前**没有任何一方在服务真实流量**；P1 私聊切换既未回滚也未推进。
> 恢复期间：**不要开 P2**；同一时刻只能有一处对真实消息出站。

## 0. 停机快照（只读采样，2026-11-14）

| 项 | 观察值 |
|---|---|
| 8094 引擎 | closed |
| 1240 proxy | closed |
| 3000/3001 SnowLuma | closed |
| 6199 / 6299 AstrBot | closed |
| bridge.py / bot-child-watchdog / harness-watchdog | 无进程 |
| `DeepSeek Harness` 宿主 | 0 个 |
| 1242 qq-console | LISTEN（仅状态面板，不承载 QQ 流量） |
| `harness.watchdog.pause` | 存在 |
| `state/cutover.json` | `stage=paused`、`mode=none`、`oldStackServing=false` |
| `bridge-mode.json` | `mode=private`（上一次 P1 留下的值） |

## 1. 先做决定（三选一，别边跑边改主意）

| 选择 | 什么时候用 | 入口 |
|---|---|---|
| A. 继续 P1（私聊切 AstrBot） | 引擎/proxy 稳定、准备继续验收 | 跑 `cutover.ps1 -Stage private` |
| B. 回滚 P1（旧栈全量） | 不想继续切，先恢复旧栈 | 先确认 bot-child 守护没在跑，再跑 `rollback.ps1` |
| C. 只保活、不碰切换 | 还需要观察/腾机器 | 只跑第 2 步引擎 + 第 3 步 proxy，起完就停手 |

> **关键事实（2026-11-15 按代码核对）**：`start-dsh.ps1` 的 [3.6/5] `bot-child-watchdog`（起 AstrBot + bridge、清 `bot-child.watchdog.pause`）和 [5/5] 宿主**都只在 `-ConnectTraffic` 下执行**；不带该开关时只起引擎/proxy/console。
> `restart-host.ps1` 调用的正是不带 `-ConnectTraffic` 的那条路径，所以它**只重启宿主**（自己经 `hidden-launch.ps1` 拉起 `harness-watchdog.ps1`），不再连带起 AstrBot 与 bridge。
> `bridge-mode.json` 仍必须在任何会拉起 bridge 的动作**之前**设好（bridge 只在进程启动时读一次）。

## 1.1 启动入口与退出码（2026-11-15 核对）

推荐入口 `Y:\dsh\start-bot.ps1`：**默认仅基础设施，不接流量**；接 QQ 流量必须显式 `-ConnectTraffic`。

| 脚本 | 退出码 | 含义 |
|---|---|---|
| `start-bot.ps1` | `0` | 全部就绪（含「本来就在跑」的幂等直返） |
| | `10` | 任一组件未就绪 / 接流量被拒绝（fail-closed）；**下层 `start-dsh` 的 1–7 一律映射为 10**，原因看日志 `[FAIL]` 行 |
| `start-dsh.ps1` | `0` | 全部就绪 |
| | `1` | 有未就绪项（未加 `-FailFast`，其余组件继续） |
| | `2` | 参数/配置错误（如 `-SkipQQ` 与 `-ConnectTraffic` 同用） |
| | `3` / `4` / `5` / `6` | 引擎 / proxy / QQ 配置 / Harness 未就绪 |
| | `7` | `bridge-mode.json` 不合格（`old`、未知值、`one-group` 缺 `group_id`） |
| | `10` | `-FailFast` 下任一组件未就绪 |
| `restart-host.ps1` | `0` / `10` | 宿主起来（附 `RESTART_HOST_OK` 行）/ 150 秒内没起来 |
| `stop-dsh.ps1` | `0` / `5` / `1` | 全停且无残留 / 仍有残留 / 脚本异常 |

日志：`work\start-bot.log`、`work\start-dsh.log`、`work\stop-dsh.log`、`work\harness.watchdog.log`。

## 2. 引擎（8094）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File Y:\workspace\ninfer\start-ninfer.ps1 -AllowDirect
```

验证（两条都过才算起）：

```powershell
Get-NetTCPConnection -LocalPort 8094 -State Listen | Select-Object OwningProcess
(Invoke-WebRequest http://127.0.0.1:8094/v1/models -UseBasicParsing -TimeoutSec 5).StatusCode   # 期望 200
```

## 3. proxy（1240）与宿主

proxy（旧栈模型网关，`/review`、`/decide`、`/v1/chat/completions` 都在这里；不承载 QQ 流量）：

```powershell
wscript.exe //B //Nologo Y:\dsh\home\qq-persona\start-proxy.vbs
(Invoke-WebRequest http://127.0.0.1:1240/health -UseBasicParsing -TimeoutSec 5).StatusCode     # 期望 200
```

宿主（两种走向，按第 1 步的选择）：

- 选 A：先跑 `cutover.ps1 -Stage private`（它会停 bridge → 装 disabled 配置 → `restart-host.ps1` → `bridge-mode=private` → 起 bridge）。
  **注意**：它只重写 `cutover.json` 为 `split`，**不拉起也不校验 AstrBot**。跑完立刻执行 `start-bot.ps1 -ConnectTraffic`（幂等，经 bot-child 守护拉起 AstrBot 并逐项验证 6299/6199），再按第 4 节验证。
- 选 B：先跑 `rollback.ps1`（恢复 `cordis.patch.yml.original` → `restart-host.ps1` → 自检宿主到 3001 ≥2 条连接）。
- 选 C：**不要**跑任何会重启宿主的脚本；宿主保持停止即可。

宿主的旁证（只读）：

```powershell
(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count
# P1 进行中（dsh-onebot 已 disabled）：宿主到 3001 应只有 1 条（qq-onebot 只读影子）
# 回滚后（dsh-onebot 已加载）：应 ≥2 条
Get-NetTCPConnection -RemotePort 3001 -State Established |
  Where-Object { (Get-Process -Name 'DeepSeek Harness').Id -contains [int]$_.OwningProcess }
```

## 4. AstrBot（6199 / 6299）

走 A：`restart-host.ps1` **不会再**拉起 AstrBot（[3.6] 已被 `-ConnectTraffic` 门控），必须显式跑 `start-bot.ps1 -ConnectTraffic` 让 bot-child 守护起它；走 B（回滚）不需要 AstrBot。
无论走 A 还是 B，AstrBot 都**不要**手动起第二份。之后只做验证：

```powershell
Get-NetTCPConnection -LocalPort 6199 -State Listen | Select-Object OwningProcess
(Invoke-WebRequest http://127.0.0.1:6299 -UseBasicParsing -TimeoutSec 5).StatusCode   # WebUI 可打开
Get-Content E:\Bonsai\astrbot-eval\inst\data\logs\astrbot.log -Tail 30               # 期望 WebSocket server started / aiocqhttp 6199
```

若 bot-child 守护没起来（`test -not (Get-Process -Name powershell ... bot-child-watchdog)`），单独拉起：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File Y:\dsh\bot-child-watchdog.ps1
```

## 5. bridge（queue 桥）

正常路径：`cutover.ps1 -Stage private` 已经起过 bridge 并自检；只在“bridge 挂了但宿主/AstrBot 都在”时才单独拉起。

验证（三项同时满足）：

```powershell
Get-Content Y:\dsh\home\qq-cutover\bridge.pid
Get-Process -Id (Get-Content Y:\dsh\home\qq-cutover\bridge.pid)          # 进程在
$bp=[int](Get-Content Y:\dsh\home\qq-cutover\bridge.pid)
Get-NetTCPConnection -State Established |
  Where-Object { [int]$_.OwningProcess -eq $bp } |
  Select-Object RemotePort, State                                        # 应同时有 3001 与 6199
Get-Content Y:\dsh\home\qq-cutover\bridge-mode.json                       # 恢复后先确认过滤档
Get-Content Y:\dsh\home\qq-cutover\bridge.console.log -Tail 20           # 无 traceback
```

`bridge-mode.json`：`old`（不回 AstrBot）/ `private`（P1）/ `one-group`（P2，带 group_id）/ `all`。
**只改这个文件即可扩群，不要重启宿主或 bridge。**

## 6. 恢复后的验收顺序（每步停一下，贴证据）

1. `state/cutover.json` 与真实状态一致（stage/mode 与实际出站方一致）。
2. 真实私聊回合：入站 1 条 → `audit/turns.jsonl` 有回合 → `audit/outbound.jsonl` 1 条 → 群里/私聊只收到 1 条最终文本。
3. `audit/clean.jsonl`：出现 `hit=true` 时确认 `reason` 与 `dropped` 符合预期（candidate-only 应 `dropped=true`）。
4. 旧栈零出站：`qq-actions.log` 不再新增（P1 期间唯一出站方是 AstrBot）。
5. 群侧（P3 前不做）：`bridge-mode=all` 后先测单群 @ 与不 @。

## 7. 已知未验证点（恢复时逐条确认）

1. **真实私聊回合**：P1 只验证到“连接建立 + 状态落盘”，未跑过真实的用户私聊往返。
2. **真实群消息**：@ 与不 @ 两条路径在真实群均未跑（仅 fake_onebot / 旧栈日志）。
3. **窄清洗真实命中**：`clean.jsonl` 至今没有真实 `hit=true`（修复后无真实出站）。
4. **bridge action 转发**：真实 action 回传（发图/表情/文件）只做了离线四态验证，未在真实群闭环。
5. **rollback 与 bot-child 守护的冲突**：rollback 自检要求 `bridgeProcs=0`、6199 无连接。2026-11-15 起 `restart-host.ps1` 不再拉起 bot-child 守护（[3.6] 被 `-ConnectTraffic` 门控），正常回滚流程下该冲突已消除；但若你先跑过 `start-bot.ps1 -ConnectTraffic` 让守护在跑，再跑 rollback 仍会撞上，回滚前先确认守护没在跑。
6. **P1 空窗时长**：上次实测约 14s，但当时是短窗口；恢复后要重新计时，不得直接引用旧值。
7. **二审启用风险**：`review.enabled=true` 时默认打 `1240/review`；实测 proxy 不在线时每条出站都会 `action=drop source=review-failed`（即使 `failOpen=true`），即**静默全丢**。启用前必须 1240 + 8094 都在线。
8. **`tool_call_timeout=60s`**：B 站类调用实测 78–475 秒，会被截断；正式跑之前调大（≥300s）并重启 AstrBot。
9. **白名单展示差异**：`E:\ComfyUI` 是 junction，`media_fence` 的 realpath 显示为 `Y:\ConfyIO\output`，属正常。
10. **`cutover.json` 10 分钟过期**：面板会把过期文件显示为 `unknown`，不影响脚本判定。

## 8. 禁止项（恢复期间）

- 不开 P2，不扩到第二个群。
- 不同时让旧栈与 AstrBot 对同一会话出站。
- 不启用计划任务/开机自启。
- 不删旧栈代码、配置、状态与备份（`backup\cordis.patch.yml.original` 是回滚唯一依据）。
- 引擎 8094、ComfyUI 8188 不动。
