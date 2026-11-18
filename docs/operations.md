# 运维手册

## 1. 启停

```powershell
# 仅基础设施：引擎 8094 → TTS 5000（可选）→ proxy 1240 → 控制台 1242
.\orchestration\start-bot.ps1

# 接 QQ 流量：额外 SnowLuma 3001 + QQ 客户端 → bridge → AstrBot 6199/6299 → Harness（可选）
.\orchestration\start-bot.ps1 -ConnectTraffic

# 完整 9 步启动（含引擎恢复守护、QQ 注入等待）
.\orchestration\start-dsh.ps1 -ConnectTraffic

# 只看计划与就绪状态
.\orchestration\start-bot.ps1 -ConnectTraffic -DryRun

# 停止（先落守护停机标记，再停守护，停完不会自动复活）
.\orchestration\stop-dsh.ps1
```

- 启动是**幂等**的：逐项真实探测，已就绪就跳过。
- 退出码 `0` 表示全部就绪；`10` 表示有组件未就绪（fail-closed）。
- 双击 `orchestration/start-dsh.vbs` 等价于「仅基础设施」，不会接 QQ 流量。

## 2. 启动后自检

1. `window-check.ps1`：统计本轮拉起进程的可视窗口数，非零会告警并打印进程名/PID/命令行。正常应为 0。
2. 端口：8094、1240、1242；接流量后加 3000、3001、5099、6199、6299。
3. AstrBot 插件列表里 `xzy` 为启用态；日志出现 `WS 已连接`。
4. `bridge-mode.json` 不是 `old`，且目标群在 `group_ids` 里。
5. 控制台 1242 打开后，各卡片状态为 healthy。

## 3. 日志

| 组件 | 位置（默认，按部署改） |
|---|---|
| 启动脚本 | `<DSH_ROOT>\2026-11-10\qqbot-ninfer-bridge\work\start-bot.log` |
| 引擎 | `<NINFER_ROOT>` 下的启动/恢复日志（`llm-backend.json` 里可配） |
| proxy | `harness/proxy/proxy.stdout.log`、`proxy.stderr.log` |
| bridge | `<CUTOVER_DIR>\bridge.log`、`bridge.console.log` |
| AstrBot | `<ASTRBOT_ROOT>\logs\run-hidden.out.log`、`run-hidden.err.log` |
| 插件审计 | `<ASTRBOT_DATA>\xzy\audit\*.jsonl` |
| 控制台 | 其自身 stdout / 控制台日志页 |

## 4. 常见故障

| 现象 | 先查什么 |
|---|---|
| 群里完全不回 | `bridge-mode.json` 是否 `old`；bridge 是否在跑；AstrBot 插件是否启用；`access.allowGroups` 是否包含该群 |
| 回复是「在呢，你说」一类空话 | 检查是否为主动/重说回合的空回复兜底；空回复应直接沉默 |
| 模型 401 / MISSING_CREDENTIAL | 模型服务鉴权；`NINFER_API_KEY` 是否在 `%USERPROFILE%\.dsh\.env` 或进程环境 |
| 模型 5xx 后整条回复消失 | 预期行为：补丁 P04 抑制错误外发，P06 重试耗尽后本轮沉默；查 `upstream-faults.jsonl` |
| 引擎起不来 / 参数被拒 | 看 `start-ninfer.ps1` 日志；**不要**为了让测试收尾去写 `engine.stop`（只能由用户显式要求停引擎） |
| 宿主窗口不出现、进程 2 分钟后退出 | DSH 启动时写入的 `dsh-auth-*` cookie 过多导致 welcome 鉴权失败；`harness-watchdog.ps1` 会在拉起前只删 `dsh-auth-*`，保留登录 cookie |
| 出现黑色控制台窗口 | 说明某组件绕过了隐藏链；跑 `window-check.ps1` 定位，改走 `hidden-launch.ps1` / `run-detached.vbs` |
| 撤回失败 | OneBot 只允许 2 分钟内撤回；超时会明确报失败，不静默 |
| 配置改了不生效 | 控制台保存会触发热重载；手改文件需 `reload-xzy.ps1`；`version` 是进程内加载计数，不是文件版本 |
| B 站工具不工作 | 未设置 `QQ_BILI_APPKEY` / `QQ_BILI_APP_SECRET`，或 `bili-cookies.json` 缺失/过期 |

## 5. 灰度与回滚

1. `bridge-mode.json` 改 `old` → 立即停止向 AstrBot 转发（bridge 按 mtime 重读）。
2. `stop-dsh.ps1` 停止整栈；不会自动复活。
3. 插件回滚：用上一版 `xzy` 目录覆盖后 `reload-xzy.ps1`。
4. AstrBot 补丁回滚：用同版本未改文件覆盖，重启；`version_compat` 会因标记消失进入 degraded，属预期。

## 6. 安全边界

- 控制台只监听 `127.0.0.1`，无登录体系，不要暴露到公网。
- QQ 链路的文件/命令工具限制在会话工作区（`workspacePath`）；宿主沙箱是硬边界，proxy 侧还有一层路径拦截。
- 写操作类接口（踢人、禁言、群管理、文件操作）默认不实现，需明确确认后才加。
- 不在仓库、日志、聊天里输出密钥；配置示例永远用占位。

## 7. 进程与窗口约束

- 所有组件必须经隐藏链拉起，不允许产生可被用户关闭的可见控制台窗口。
- 不要用强杀方式停 dsh（会损坏本地认证缓存，导致连续崩溃）；优先 `stop-dsh.ps1`。
- 启动脚本用 Win32 进程创建在终端作业外拉起，确保终端关闭后进程仍在。
