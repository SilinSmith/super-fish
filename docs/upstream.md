# 上游依赖与魔改点

本仓库**不包含任何上游项目的源码或发行物**（包括改过的），只包含我们写的插件、桥接、脚本、控制台和示例配置。下面是跑通整套所需的上游，以及我们对上游做过的最小改动。

## 1. 上游清单

| 上游 | 版本 / 范围 | 作用 | 安装与准备 |
|---|---|---|---|
| AstrBot | **4.14.6（锁定）** | 机器人框架，加载 xzy 插件 | 建议独立 venv；数据根需存在 `.astrbot` 与 `data/cmd_config.json`；版本不符时 `version_compat.py` 会告警并进入 degraded |
| SnowLuma | **2.2.1** | OneBot 11 实现，原生 hook 注入 QQ NT | 需要 Node `^24.22.1 \|\| >=26.12.1`；原生 `snowluma-win32-x64.node/.dll` 由发行物提供 |
| QQ NT | 随 SnowLuma 兼容版本 | 被注入宿主 | 登录机器人账号；路径由 `orchestration/start-dsh.ps1` 的 `$QqClientPath` 指定 |
| 本地模型服务 | OpenAI 兼容 `/v1` | 对话、判定、二审、视觉 | 默认 `127.0.0.1:8094`；模型名、上下文、并发由你的引擎决定 |
| DeepSeek Harness（DSH） | 桌面端 `0.2.1-rc.5` 一类 | 旧链路宿主，加载 `dsh-onebot-qq` | 仅旧链路需要；宿主与插件安装不在本仓库 |
| `dsh-onebot-qq` | `^0.9.6` | DSH 的 OneBot 通道 | 仅旧链路需要；`cordis` 配置见 `harness/cordis.patch.example.yml` |
| Python | 3.10+（与 AstrBot 一致） | 插件、bridge、补丁器 | bridge 依赖 `aiohttp` |
| Node.js | 20+（SnowLuma 另有要求） | proxy、控制台、SnowLuma | 控制台/proxy 无第三方运行时依赖 |
| TTS（可选） | Style-Bert-VITS2 一类 | 语音出站 | 默认 `127.0.0.1:5000`，`tts.enabled=false` 时不注册工具 |
| ComfyUI（可选） | 任意 | 出图 | `127.0.0.1:8188`；脚本只探测，不拉起 |
| ffmpeg / ffprobe（可选） | 任意 | 视频抽帧 | 需在 PATH |

> NapCat 不是必需项：`dsh-onebot-qq` 兼容 NapCat，但本方案实际使用 SnowLuma。仓库不含 NapCat。

## 2. 对 AstrBot 的改动（最小补丁）

只改 6 处，全部带 `# [XZY-Pxx]` 标记。完整锚点、原因、升级复核方法见
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

## 3. 对 Harness 配置的改动（非源码）

旧链路需要在 DSH profile 的 `cordis.patch.yml` 里改接线，示例见
[config-examples/cordis.patch.example.yml](../config-examples/cordis.patch.example.yml)。要点：

- 停用 `im-qqbot`（官方 QQ 机器人通道），避免两套人设/两条连接互相打架；
- `dsh-onebot` 改为 `mode: forward`，主动连 `ws://127.0.0.1:3001`；
- `accessToken` 与你的 SnowLuma OneBot 配置保持一致（默认空）；
- 固定 `provider: ninfer`，不让 QQ 链路继承全局默认模型；
- `workspacePath` 指向允许读写的会话工作区（沙箱边界）；
- 调试注入保持 `injectEnabled: false`、`injectDryRun: true`，避免注入回合真的发出消息。

## 4. 对 SnowLuma 的改动

不需要改上游源码。我们通过：

- `qq-channel/snowluma-inject.mjs` 调原生 hook；
- 环境变量 `SNOWLUMA_HOOK_AUTOLOAD_UINS` 指定允许注入的账号；
- SnowLuma 自带的 `config/onebot_<uin>.json` 配 OneBot；
- 编排脚本只负责拉起与探测 3000/3001/5099。

## 5. 升级上游时的检查单

1. AstrBot 升级：先跑 `apply.py --check`，锚点不匹配会直接失败（这是有意的，避免错位打补丁）；再跑 `verify.py`；最后启动看 `version_compat` 是否 degraded。
2. SnowLuma 升级：确认原生 `.node/.dll` 路径与 Node 版本要求；注入脚本只依赖公开 hook 接口。
3. DSH / `dsh-onebot-qq` 升级：`dsh-onebot` 会覆盖 `lib/event.js` 的垫片，proxy 的漂移自检会告警；按 `qq-channel/platform/` 重新接回归一化层。
4. 模型服务换实现：只改 `harness/proxy/llm-backend.json` 与 AstrBot 的 provider 配置，不改代码。
