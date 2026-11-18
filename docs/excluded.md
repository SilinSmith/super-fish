# 被排除的内容与原因

仓库只保留「我们自己写的代码」。以下内容**没有纳入**，不要以为克隆下来就能跑。

## 1. 隐私与身份

| 内容 | 具体例子 | 原因 |
|---|---|---|
| 人格文件 | `persona/character.md`、`self-iter` 的人格补丁 | 个人创作，且含大量个人设定 |
| 记忆与日记 | `notebook.json`、`diary.jsonl`、`memory-*.jsonl`、`identity-index.jsonl` | 真实聊天对象与关系数据 |
| 聊天与审计日志 | `bridge.log`、`audit/*.jsonl`、`answer-ledger.jsonl`、`review-audit.log`、`asks.jsonl`、`conversation-feed.jsonl` | 含真实消息、QQ 号、昵称 |
| 入站/出站原始事件 | `recall-ledger.jsonl`、`group-state/*.json`、`sessions/*` | 可反推群成员与内容 |
| 账号标识 | 真实 QQ 号、群号、昵称、角色名 | 已统一替换为 `10000` / `10001` / `100000001` / `小助手` 等占位 |
| 登录态 | `bili-cookies.json`、`SESSDATA`、`bili_jct`、DSH 登录 cookie | 直接可用的凭据 |
| 配置里的密钥 | `appSecret`、`password` 哈希、`jwt_secret`、`accessToken` | 泄露即被接管 |

## 2. 体积与可重建

| 内容 | 处理 | 原因 |
|---|---|---|
| `venv/`（AstrBot 环境） | 排除 | 可重建；含上游代码 |
| `node_modules/` | 排除 | 可 `npm i` 重建；含上游代码 |
| 模型权重 | 排除 | 数 GB～数十 GB |
| 数据库 / 原始数据 | 排除 | 运行产物 |
| 媒体与取证音频 | 排除（图片、语音、视频、抽帧、TTS 输出） | 体积大且含隐私 |
| 缓存与备份 | 排除（`__pycache__`、`*.bak`、`backups/`、`state/`） | 可再生 |
| 可执行文件 | 排除（`PCL-Deepseek-Harness-Launcher.exe`、原生 `.node/.dll`） | 二进制发行物 |

## 3. 上游项目（无论是否改过）

按发布口径，以下上游的源码或发行物**一律不进来**：

- AstrBot（含我们打过补丁的 `site-packages` 副本；只保留 `patches/` 里的补丁器与登记表）
- SnowLuma（含原生 `.node/.dll`）
- QQ NT
- DeepSeek Harness 宿主与 `dsh-onebot-qq` 插件
- NapCat（本方案未使用）
- 任何从上游复制的表情目录（`faces.json` 属于 SnowLuma 表情目录的衍生物，未纳入；缺失时插件自动降级为不发表情）

需要改上游的地方，用 `astrbot-plugin/patches/registry.md` 的逐处说明 + `apply.py` 记录，不整份拷贝。

## 4. 因此你需要自己创建的东西

- `ASTRBOT_DATA/xzy/persona/character.md`（人格）
- `notebook.json`、`diary.jsonl`（记忆/日记，可先建空文件）
- `bili-cookies.json`（如果要用 B 站功能）
- `xzy-config.json`、`bridge-mode.json`、`llm-backend.json`、`onebot-plugin/config.json`（从 `config-examples/` 复制后改）
- SnowLuma 的 `config/onebot_<uin>.json`
- 模型服务的地址、模型名与鉴权

## 5. 核对方式

发布前做了以下检查（可在你自己的分支重复）：

```powershell
# 1) 不应出现真实账号/角色名/用户名（把下面的占位换成你自己的真实值再查）
git grep -nE "你的QQ号|你的群号|你的昵称|你的用户名"

# 2) 不应出现密钥样式
git grep -niE "appsecret|sessdata|bili_jct|sk-[A-Za-z0-9]{16,}"

# 3) 不应有大文件
git ls-files | ForEach-Object { Get-Item $_ } | Where-Object Length -gt 2MB
```
