# WorkBuddy Bridge（双版本）

把本机 **WorkBuddy** 桌面账号的模型额度，接入 **Claude Code**、**Codex** 以及任何兼容的 AI 编程工具。

**两个版本都支持，自动检测**：

| 版本 | 可执行文件 | 域名 | 凭据文件 |
|---|---|---|---|
| **国际版 `ai`** | `WorkBuddyAI.exe` | `www.workbuddy.ai` | `workbuddy-desktop-ai.info` |
| **国内版 `cn`** | `WorkBuddy.exe` | `www.workbuddy.cn` | `workbuddy-desktop.info` |

规则很简单：**有国际版就用国际版，没有就用国内版；两个都有，两个都能用。**

> 两个 App 可以**同时装在同一台机器**上，但属于**不同账号**。
> 选错会消耗错误的额度，所以本服务从不猜测 —— 它逐个探测、逐个验证，
> 并让你明确选择用哪个。

---

## 目录

- [快速开始](#快速开始)
- [双版本是怎么选的](#双版本是怎么选的)
- [环境检测（doctor）](#环境检测doctor)
- [令牌刷新](#令牌刷新)
- [支持的 agent](#支持的-agent)
- [配置项](#配置项)
- [故障排查](#故障排查)
- [已知限制](#已知限制)
- [附录：文件说明与 MCP 模式](#附录文件说明与-mcp-模式)

---

## 快速开始

### 1. 环境检测

```powershell
cd <本目录>
node doctor.js
```

它会把这台电脑查一遍：Node 版本、环境变量、**两个版本各自的探测过程**
（环境变量 → 安装目录 → 注册表 → 缓存）、凭据能否解密、模型目录、
最后跑一次**真实对话**往返。

实测输出（本机只装了国内版）：

```
=== Locating the WorkBuddy apps ===
  [ai] international (workbuddy.ai)
    install root         no match
    registry             no match
    resolved             (none) — Could not find the international ... executable.

  [cn] China (workbuddy.cn)
    registry             D:\WorkBuddy\data\WorkBuddy.exe  (registry: WorkBuddy 5.8.2)
    resolved             D:\WorkBuddy\data\WorkBuddy.exe

=== Checking credentials ===
  [cn] China (workbuddy.cn)
    status               decrypted OK
    domain               www.workbuddy.cn
    default model        auto

=== Summary ===
  detected editions    cn
  active edition       cn (China (workbuddy.cn))
  All checks passed. The bridge should work.
```

看两个字段就够了：

| 字段 | 说明 |
|---|---|
| `detected editions` | 实际可用的版本（`ai` / `cn` / 两者） |
| `active edition` | 默认会消耗哪个账号的额度 |

### 2. 启动服务

```powershell
node http-server.js
```

```
[workbuddy-http] listening on http://127.0.0.1:8799
[workbuddy-http] provider ai: unavailable — Could not find the international ... executable.
[workbuddy-http] provider cn: OK  domain=www.workbuddy.cn default=auto
[workbuddy-http] active provider: cn
```

启动即打印**实际检测结果** —— 正在消耗谁的额度，一眼可见。

### 3. 接入 agent

三套协议都就绪，端点与版本无关：

| 协议 | 端点 |
|---|---|
| Anthropic Messages | `http://127.0.0.1:8799/v1/messages` |
| OpenAI Chat Completions | `http://127.0.0.1:8799/v1/chat/completions` |
| OpenAI Responses | `http://127.0.0.1:8799/v1/responses` |

**Claude Code** — 写入 `~/.claude/settings.json`：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8799",
    "ANTHROPIC_AUTH_TOKEN": "local",
    "ANTHROPIC_MODEL": "auto",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "auto",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-pro",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4.1-flash"
  }
}
```

模型 id 用你**实际检测到的版本**的目录里的（`node doctor.js` 会列出）。
`ANTHROPIC_AUTH_TOKEN` 填任意非空字符串即可。

**Codex** — 写入 `~/.codex/config.toml`：

```toml
model = "auto"
model_provider = "workbuddy"

[model_providers.workbuddy]
name = "workbuddy"
base_url = "http://127.0.0.1:8799/v1"
wire_api = "responses"          # ← 必须是 responses
requires_openai_auth = false
```

> ⚠️ `wire_api` 必须是 **`responses`**，写 `chat/completions` 也能通但多一层转换。

---

## 双版本是怎么选的

### 自动优先级

```
1. 环境变量强制指定（WORKBUDDY_EDITION / --edition）
2. 国际版 ai（如果两个都可用）
3. 国内版 cn
```

### 什么算「可用」

**装了 ≠ 能用。** 一个版本要成为提供方，必须同时满足：

1. 找到它的可执行文件
2. 它的凭据文件存在且**解密成功**
3. 里面有可用的 access token

App 装了但从没登录过 —— **不算**。这很重要：路由到一个登出状态的
App 会在请求时炸出一个跟请求无关的错误。

### 两个都装了，怎么指定

三种写法，按你的工具能设哪种来选：

| 方式 | 示例 |
|---|---|
| URL 前缀 | `POST http://127.0.0.1:8799/cn/v1/chat/completions` |
| 请求头 | `X-WorkBuddy-Edition: cn` |
| 请求体字段 | `{"edition": "cn", ...}` |

不指定就用默认的那个。查当前状态：

```powershell
Invoke-RestMethod http://127.0.0.1:8799/health
```

```json
{
  "status": "ok",
  "defaultEdition": "cn",
  "availableEditions": ["cn"],
  "domain": "www.workbuddy.cn",
  "providers": [
    { "edition": "ai", "available": false, "error": "..." },
    { "edition": "cn", "available": true, "domain": "www.workbuddy.cn", ... }
  ]
}
```

---

## 环境检测（doctor）

`doctor.js` 就是你说的「电脑环境检测」。它按这个顺序查：

| 步骤 | 查什么 |
|---|---|
| 1 | Node 版本、操作系统、CPU/内存 |
| 2 | 影响探测的环境变量（含路径是否真实存在） |
| 3 | **两个版本**的可执行文件探测（四种策略逐个列出） |
| 4 | **两个版本**的凭据解密 + 账号身份 |
| 5 | **两个版本**的模型目录拉取 |
| 6 | 对默认版本做一次**真实对话往返** |

```powershell
node doctor.js            # 标准检测
node doctor.js --refresh  # 额外强制刷新令牌
node doctor.js --json     # 机器可读输出
```

退出码：全部通过为 `0`，否则为 `1`（可直接用于 CI 或脚本判断）。

---

## 令牌刷新

原版本没有刷新，令牌过期只能手动开 App。现在有三种刷新机制：

### 1. 自动刷新（请求时）

令牌在 **5 分钟内过期**时，下一次请求前自动刷新。刷新结果缓存到
`$DSH_HOME/.workbuddy-<edition>-auth.json`，**不会写回 App 自己的凭据文件**。

### 2. 401 自动重试

请求撞上 401 → 刷新一次 → 用新令牌重试。都失败了才报错，
并且错误信息会说明原因，而不是只丢一个 401。

### 3. 手动刷新

```powershell
# HTTP
Invoke-RestMethod -Method POST http://127.0.0.1:8799/refresh

# 命令行
node doctor.js --refresh

# MCP
workbuddy_refresh
```

`POST /refresh` 还会**重新检测整台机器** —— 服务开着的时候新装或新登录了
App，不用重启就能生效。

### 关于 `WORKBUDDY_CLIENT_ID`

刷新走 Keycloak 的 `refresh_token` grant
（`https://<domain>/auth/realms/copilot/protocol/openid-connect/token`），
需要一个 `client_id`。桌面 App 没有把可靠的 client_id 留在磁盘上，
所以默认用 `console`（令牌 `azp` 声明里的值）。

**实测该值被服务端拒绝**，因此刷新目前会失败并给出明确提示。
若你拿到了真实 client_id：

```powershell
[Environment]::SetEnvironmentVariable('WORKBUDDY_CLIENT_ID', '<真实值>', 'User')
```

> 刷新失败**不影响正常使用** —— 它会优雅降级为「用现有令牌」，
> 只有真的过期了才会提示你打开 App 重新登录。
> 令牌实测有效期约一个月（本次到 2026-11-10），通常不会遇到。

---

## 支持的 agent

| Agent | 协议 | 状态 |
|---|---|---|
| **Claude Code** | Anthropic Messages | ✅ 已实测（含工具调用） |
| **Codex** | OpenAI Responses | ✅ 已实测（含工具调用） |
| **CC Switch** | 作为自定义供应商 | ✅ 兼容（选 Anthropic Messages 格式） |
| OpenCode / 其他 | Chat Completions | ⚪ 未实测 |

> **CC Switch**：上游格式选 **Anthropic Messages（原生）**，不要选 OpenAI
> 格式（会导致双重转换）。本服务已直出三种协议，可以直连。

### 实测证据

本次改造后在国内版上完整跑过：

```
Anthropic 非流式    → "ANTHROPIC_OK"
Anthropic 流式      → message_start → content_block_delta → message_stop
OpenAI 非流式       → "OPENAI_OK"
OpenAI 流式         → 4 chunks，文本 "OSTREAM_OK"
Responses 非流式    → status=completed, "RESP_OK"
Responses 流式      → 9 类事件完整生命周期
工具调用（Anthropic）→ stop_reason=tool_use, {"city":"Paris"}
工具流式分片重组    → input_json_delta: {"city":"Tokyo"}
完整工具循环        → "The weather in Paris is currently sunny, 24°C."
完整工具循环（OpenAI）→ "The weather in Berlin is currently rainy, 12°C."
```

工具链路上原项目踩过的三个坑（tools 被丢弃、流式分片丢失、工具历史被抹掉）
均已验证正常。

---

## 配置项

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `WORKBUDDY_EDITION` | 自动检测 | 强制 `ai` 或 `cn` |
| `WORKBUDDY_AI_ELECTRON_BIN` | 自动探测 | 国际版 exe 路径 |
| `WORKBUDDY_ELECTRON_BIN` | 自动探测 | 国内版 exe 路径 |
| `WORKBUDDY_AI_AUTH_FILE` | `%LOCALAPPDATA%\CodeBuddyExtension\…\workbuddy-desktop-ai.info` | 国际版凭据文件 |
| `WORKBUDDY_AUTH_FILE` | `%LOCALAPPDATA%\CodeBuddyExtension\…\workbuddy-desktop.info` | 国内版凭据文件 |
| `WORKBUDDY_CLIENT_ID` | `console` | 刷新用的 OAuth client id |
| `WORKBUDDY_MCP_PORT` | `8799` | HTTP 端口 |
| `WORKBUDDY_MODEL` | 按版本（`ai`: `deepseek-v4.1-flash`，`cn`: `auto`） | 默认模型 |
| `WORKBUDDY_DEBUG` | — | 设为 `1` 打印上游请求详情 |
| `WORKBUDDY_APP_VERSION` | 自动读取 | 覆盖上报的 App 版本 |
| `WORKBUDDY_CLI_VERSION` | 自动读取 | 覆盖上报的 CLI 版本 |

> 两个版本的 `*_ELECTRON_BIN` **不要混用** —— 指错了会明确报错，
> 因为那会消耗另一个账号的额度。

### 后台常驻（可选）

```powershell
$action  = New-ScheduledTaskAction -Execute "node" `
  -Argument "C:\path\to\workbuddy-bridge\http-server.js" `
  -WorkingDirectory "C:\path\to\workbuddy-bridge"
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "WorkBuddy Bridge" -Action $action -Trigger $trigger
```

---

## 故障排查

### 先看这个

```powershell
node doctor.js
```

它把两个版本的每一步都列出来，绝大多数问题在这里就能定位。

### 报错速查

WorkBuddy 的错误码**含义不唯一**，同一个 `code` 可能是完全不同的原因。
**看 `msg`，不要只看 `code`。**

| 错误 | 真正含义 | 怎么办 |
|---|---|---|
| `11128` / `unapproved channel` | system 提示词含**竞品客户端标识** | 见下方专门章节 |
| `11128` / `first message is not system prompt` | 首条消息不是 system | 已自动处理 |
| `11148` / `tool calls and tool results do not match` | 工具调用与结果配对不上 | 已修复 |
| `11102` / `model … service info not found` | 模型名不存在 | 检查模型 id（去掉 `[1M]` 之类后缀） |
| `14003` / `too many requests` | **限流** | 等 1–2 分钟，或换负载低的模型 |

### `11128 / unapproved channel`

**最容易误诊的一个。** 文案写着"被安全策略拦截"，看起来像网络或风控问题，
实际上**只是 system 提示词里出现了 WorkBuddy 不认的客户端名称**：

| system 里的内容 | 结果 |
|---|---|
| `You are a helpful assistant.` | ✅ |
| `You are a Claude agent... Claude Agent SDK.` | ✅ |
| `OpenAI`（单独出现） | ✅ |
| **`Claude Code`** | ❌ |
| **`Codex CLI`** | ❌ |
| **`x-anthropic-billing-header`** | ❌ |

本服务会**自动中性化**这些标识（只替换客户端的自我描述，不动任何用户内容）。
接新 agent 又撞上这个错误，说明它的提示词里有新的触发词 ——
用 `WORKBUDDY_DEBUG=1` 启动，据此扩展 `upstream.js` 的 `stripClientPreamble()`。

### 找不到某个版本的 App

`doctor.js` 会逐个列出四种探测策略的结果：

- `registry` 显示 `no match` → App 可能没装，或装在未登记的位置
- 探测到多个 → 用对应的 `*_ELECTRON_BIN` 指定其中一个

### 解密失败

```
status  unavailable — Failed to decrypt accessToken.
```

- 确认能自动探测到 exe（`doctor.js` 会显示）
- **打开一次桌面 App**（App 升级后密钥可能轮换）
- 确认是**新的**终端会话（旧会话可能继承旧环境变量）

### 401 / 令牌过期

1. 会自动尝试刷新（见[令牌刷新](#令牌刷新)）
2. 刷新也失败 → 打开桌面 App 重新登录
3. 再调一次即可

> 刷新失败时错误信息会明确说明原因，不会只丢一个 401。

---

## 已知限制

1. **依赖桌面 App 的二进制做解密。** 两个版本都是加密存储，都必须 spawn
   各自的 exe 才能取到密钥。App 升级若改变密钥派生方式会导致解密失败，
   重新打开一次 App 通常可恢复。

2. **令牌刷新需要 client_id。** 默认 `console` 实测被拒（见
   [令牌刷新](#令牌刷新)）。失败时优雅降级，不影响正常使用。

3. **没有限流退避机制。** 连续快速请求会触发 429。出现时如实返回 429，
   客户端（如 CC Switch 的故障转移）可据此切换。

4. **接口是逆向得到的**，WorkBuddy 改版可能失效。

5. **非官方桥接。** 使用你自己的账号令牌访问官方接口，**不绕过计费** ——
   消耗的就是你账号的额度。请自行评估厂商 ToS 风险。

6. **服务必须保持运行。** 停了 agent 就连不上。

---

## 附录：文件说明与 MCP 模式

```
workbuddy-bridge/
├── http-server.js   HTTP 服务：三套协议的路由与响应转换
├── providers.js     提供方注册表：哪个版本能用、默认用哪个
├── responses.js     OpenAI Responses 协议的双向转换
├── upstream.js      调用上游：请求头、SSE 解析、工具调用重组、system 中性化
├── credentials.js   令牌读取/解密（AES-256-GCM + AAD）+ 自动刷新
├── locate.js        双版本可执行文件定位
├── server.js        MCP 服务（见下）
├── doctor.js        环境检测脚本
└── HTTP-BRIDGE.md   原版详细技术文档（含踩坑记录）
```

**核心职责划分：**

| 文件 | 负责 |
|---|---|
| `locate.js` | 按版本分类探测 exe（环境变量/安装目录/注册表/缓存） |
| `credentials.js` | 定位凭据 → spawn 对应 exe 取密钥 → 解密 → 刷新 |
| `providers.js` | 判断「装了」还是「能用」，决定默认版本 |
| `upstream.js` | 按版本差异化 origin、身份头、默认模型 |
| `http-server.js` | 路由、版本选择、三协议转换 |

### MCP 模式

让 agent **主动调用** WorkBuddy：

```powershell
claude mcp add workbuddy -- node "<本目录>\server.js"
```

| 工具 | 说明 |
|---|---|
| `workbuddy_ask` | 发一条 prompt（可带 `edition` 参数） |
| `workbuddy_models` | 列出某版本可用的模型 |
| `workbuddy_status` | 检测到的版本 + 各自身份 |
| `workbuddy_refresh` | 重新检测机器 + 刷新令牌 |

**什么时候用 MCP 而不是 HTTP？**

| 你想要 | 用哪个 |
|---|---|
| agent 把 WorkBuddy 当**模型供应商**（可切换、可聚合） | **HTTP** |
| agent 在对话中**主动问** WorkBuddy 一个问题 | **MCP** |

两者可以共存，互不冲突。

---

## 深入阅读

`HTTP-BRIDGE.md` 记录了原版的完整开发与调试过程，包括：

- WorkBuddy 渠道识别的全部触发词及实测方法
- 工具调用链路上踩过的三个连环 bug（含 A/B 对照实验）
- 各种错误码的真实含义
- 一份关于"如何避免误诊"的复盘

排查疑难问题时值得一读。
