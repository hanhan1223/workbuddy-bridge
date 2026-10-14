# workbuddy-bridge

**把本机 WorkBuddy 桌面账号，变成 Claude Code / Codex 的模型供应商。**

国际版（`workbuddy.ai`）与国内版（`workbuddy.cn`）**都支持，自动检测**。

[English](README.md) | **中文**

[![npm version](https://img.shields.io/npm/v/workbuddy-bridge.svg)](https://www.npmjs.com/package/workbuddy-bridge)
[![npm downloads](https://img.shields.io/npm/dm/workbuddy-bridge.svg)](https://www.npmjs.com/package/workbuddy-bridge)
[![license](https://img.shields.io/npm/l/workbuddy-bridge.svg)](LICENSE)
[![node](https://img.shields.io/node/v/workbuddy-bridge.svg)](https://nodejs.org)

---

## 它解决什么问题

WorkBuddy 桌面 App 里的模型额度，默认只能在 App 自己的界面里用。
本项目把它开放成本地 API，于是 **Claude Code、Codex、CC Switch，以及任何
兼容 OpenAI / Anthropic 协议的工具**，都能直接把它当作模型供应商。

| 版本 | 可执行文件 | 域名 | 凭据文件 |
|---|---|---|---|
| **国际版 `ai`** | `WorkBuddyAI.exe` | `www.workbuddy.ai` | `workbuddy-desktop-ai.info` |
| **国内版 `cn`** | `WorkBuddy.exe` | `www.workbuddy.cn` | `workbuddy-desktop.info` |

规则很简单：**有国际版就用国际版，没有就用国内版；两个都有，两个都能用。**

> 两个 App 可以**同时装在同一台机器**上，但属于**不同账号**。
> 选错会消耗错误的额度，所以本服务从不猜测 —— 它逐个探测、逐个验证。

链路是这样的：

```
你的 agent（Claude Code / Codex / ...）
   │  HTTP
   ▼
workbuddy-bridge  ──① 读 ──▶ 桌面 App 的凭据文件（AES-256-GCM 加密）
   │                              │
   │                    ② 解密：spawn App 自己的 exe
   │                       (ELECTRON_RUN_AS_NODE=1)
   │                       取其私有存储绑定里的 atRestSecretKey
   │
   └──③ HTTPS ──▶ 官方云端接口 /v2/chat/completions
                  （用你已登录的账号令牌）
```

> 走的是**官方云端接口**，复用你桌面 App 已登录的账号。
> 消耗的是**你自己账号的额度**，不绕过计费。

---

## 安装

### 方式一：npm（推荐）

```bash
npm install -g workbuddy-bridge
```

安装后有三个命令可用：

| 命令 | 用途 |
|---|---|
| `workbuddy-doctor` | **环境检测**，装完先跑这个 |
| `workbuddy-bridge` | 启动 HTTP 服务 |
| `workbuddy-bridge-mcp` | 启动 MCP 服务 |

### 方式二：免安装直接跑

```bash
npx workbuddy-bridge          # 启动服务
npx -p workbuddy-bridge workbuddy-doctor   # 环境检测
```

### 方式三：克隆源码

```bash
git clone https://github.com/hanhan1223/workbuddy-bridge.git
cd workbuddy-bridge
node doctor.js
```

> 零运行时依赖。`@modelcontextprotocol/sdk` 只有用 MCP 模式才需要，
> 且是 optional dependency。

---

## 前置条件

| 需要 | 说明 |
|---|---|
| **Windows** | 目前只支持 Windows（发现逻辑依赖卸载注册表，两个 App 也都是 Windows 版）|
| **Node.js 20.3+** | 用到了 `AbortSignal.any` |
| **WorkBuddy 桌面 App** | 国际版或国内版，**且已登录** |

**不需要手动配置路径。** 服务会自动找到 App，按以下顺序尝试：

| 顺序 | 方式 |
|---|---|
| 1 | 环境变量（`WORKBUDDY_AI_ELECTRON_BIN` / `WORKBUDDY_ELECTRON_BIN`）|
| 2 | 常见安装位置（`%LOCALAPPDATA%\Programs` 等）|
| 3 | Windows 卸载注册表（覆盖非标准路径）|
| 4 | 上次成功解密用过的路径（缓存）|

---

## 快速开始

### 1. 环境检测

```bash
workbuddy-doctor
```

它会把整台机器查一遍：Node 版本、环境变量、**两个版本各自的探测过程**、
凭据能否解密、模型目录，最后跑一次**真实对话往返**。

实测输出（只装了国内版的机器）：

```
=== Locating the WorkBuddy apps ===
  [ai] international (workbuddy.ai)
    install root   no match
    registry       no match
    resolved       (none) — Could not find the international ... executable.

  [cn] China (workbuddy.cn)
    registry       D:\WorkBuddy\data\WorkBuddy.exe  (registry: WorkBuddy 5.8.2)
    resolved       D:\WorkBuddy\data\WorkBuddy.exe

=== Checking credentials ===
  [cn] China (workbuddy.cn)
    status         decrypted OK
    domain         www.workbuddy.cn
    default model  auto

=== Summary ===
  detected editions    cn
  active edition       cn (China (workbuddy.cn))
  All checks passed. The bridge should work.
```

只看两个字段就够：

| 字段 | 含义 |
|---|---|
| `detected editions` | 实际可用的版本（`ai` / `cn` / 两者）|
| `active edition` | 默认消耗哪个账号的额度 |

### 2. 启动服务

```bash
workbuddy-bridge
```

```
[workbuddy-http] listening on http://127.0.0.1:8799
[workbuddy-http] provider ai: unavailable — Could not find the international ... executable.
[workbuddy-http] provider cn: OK  domain=www.workbuddy.cn default=auto
[workbuddy-http] active provider: cn
```

启动即打印**实际检测结果** —— 正在消耗谁的额度，一眼可见。

> 服务**只监听 `127.0.0.1`**，因为进程持有你的账号令牌，绝不能对外网开放。

### 3. 接入你的 agent

| 协议 | 端点 |
|---|---|
| Anthropic Messages | `http://127.0.0.1:8799/v1/messages` |
| OpenAI Chat Completions | `http://127.0.0.1:8799/v1/chat/completions` |
| OpenAI Responses | `http://127.0.0.1:8799/v1/responses` |
| 模型列表 | `http://127.0.0.1:8799/v1/models` |
| 健康检查 | `http://127.0.0.1:8799/health` |

#### Claude Code

写入 `~/.claude/settings.json`：

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

> 模型 id 用 `workbuddy-doctor` 列出的、你**实际检测到的版本**的目录里的。
> `ANTHROPIC_AUTH_TOKEN` 填**任意非空字符串**即可 —— 服务端不校验它
> （真实令牌在服务端内部解密，不会传给你），但 Claude Code 拒绝空值。

#### Codex

写入 `~/.codex/config.toml`：

```toml
model = "auto"
model_provider = "workbuddy"

[model_providers.workbuddy]
name = "workbuddy"
base_url = "http://127.0.0.1:8799/v1"
wire_api = "responses"          # ← 必须是 responses
requires_openai_auth = false
```

> ⚠️ `wire_api` 必须是 **`responses`**。Codex 原生说 Responses 协议，
> 写 `chat/completions` 也能通，但多一层没必要的转换。

#### 其他工具

任何支持上述三种协议之一的工具都能用。**CC Switch** 作为自定义供应商接入时，
上游格式选 **Anthropic Messages（原生）**，不要选 OpenAI 格式（会导致双重转换）。

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

App 装了但从没登录过 —— **不算**。这很重要：路由到一个登出状态的 App，
会在请求时炸出一个跟请求无关的错误。

### 两个都装了，怎么指定

| 方式 | 示例 |
|---|---|
| URL 前缀 | `POST http://127.0.0.1:8799/cn/v1/chat/completions` |
| 请求头 | `X-WorkBuddy-Edition: cn` |
| 请求体字段 | `{"edition": "cn", ...}` |

查当前状态：

```bash
curl http://127.0.0.1:8799/health
```

```json
{
  "status": "ok",
  "defaultEdition": "cn",
  "availableEditions": ["cn"],
  "domain": "www.workbuddy.cn",
  "providers": [
    { "edition": "ai", "available": false, "error": "..." },
    { "edition": "cn", "available": true, "domain": "www.workbuddy.cn" }
  ]
}
```

---

## 令牌刷新

原版没有刷新，令牌过期只能手动开 App。现在有三种机制：

| 机制 | 触发 |
|---|---|
| **自动刷新** | 令牌在 5 分钟内过期时，请求前自动刷新 |
| **401 重试** | 撞上 401 → 刷新一次 → 用新令牌重试 |
| **手动刷新** | `POST /refresh`，同时**重新检测整台机器** |

刷新结果缓存在 `$DSH_HOME/.workbuddy-<edition>-auth.json`，
**不会写回 App 自己的凭据文件**。

```bash
curl -X POST http://127.0.0.1:8799/refresh
workbuddy-doctor --refresh
```

> **关于 `WORKBUDDY_CLIENT_ID`**：刷新走 Keycloak 的 `refresh_token` grant，
> 需要一个 `client_id`。桌面 App 没有把可靠的 client_id 留在磁盘上，
> 默认用 `console`（令牌 `azp` 声明里的值）—— **实测该值被服务端拒绝**。
> 若你拿到了真实 client_id，设置该环境变量即可。
>
> 刷新失败**不影响正常使用**：会优雅降级为「用现有令牌」，
> 只有真过期了才提示你打开 App 重新登录。

---

## 支持的 agent

| Agent | 协议 | 状态 |
|---|---|---|
| **Claude Code** | Anthropic Messages | ✅ 已实测（含工具调用）|
| **Codex** | OpenAI Responses | ✅ 已实测（含工具调用）|
| **CC Switch** | 自定义供应商 | ✅ 兼容 |
| OpenCode / 其他 | Chat Completions | ⚪ 未实测 |

### 实测覆盖

改造后在**双版本场景**下跑过 55 项回归，全部通过：

```
单版本(cn) / 双版本(ai+cn) 两套环境各跑一遍：
  Anthropic 非流式 + 流式      ✅
  OpenAI Chat 非流式 + 流式    ✅
  OpenAI Responses 非流式+流式 ✅
  工具调用 + 完整工具循环       ✅
  三种 edition 路由方式         ✅
  模型目录（按版本打标）         ✅
  /refresh + 404               ✅
```

---

## 配置项

### 命令行

```
workbuddy-bridge [options]

  -p, --port <n>         端口（默认 8799）
  -m, --model <id>       默认模型
  -e, --edition <ai|cn>  强制某个版本
  -h, --help             帮助
  -v, --version          版本
```

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
| `WORKBUDDY_MODEL` | 按版本 | 默认模型 |
| `WORKBUDDY_TIMEOUT_MS` | `300000` | 上游请求超时 |
| `WORKBUDDY_SLOW_MS` | `60000` | 超过此耗时打印慢请求日志 |
| `WORKBUDDY_DEBUG` | — | 设为 `1` 打印上游请求详情 |

> 两个版本的 `*_ELECTRON_BIN` **不要混用** —— 指错了会明确报错，
> 因为那会消耗另一个账号的额度。

---

## MCP 模式

除 HTTP 服务外，还提供 MCP 服务，让 agent **主动调用** WorkBuddy：

```bash
claude mcp add workbuddy -- npx -y workbuddy-bridge-mcp
```

| 工具 | 说明 |
|---|---|
| `workbuddy_ask` | 发一条 prompt（可带 `edition` 参数）|
| `workbuddy_models` | 列出某版本可用的模型 |
| `workbuddy_status` | 检测到的版本 + 各自身份 |
| `workbuddy_refresh` | 重新检测机器 + 刷新令牌 |

**什么时候用 MCP 而不是 HTTP？**

| 你想要 | 用哪个 |
|---|---|
| agent 把 WorkBuddy 当**模型供应商**（可切换、可聚合）| **HTTP** |
| agent 在对话中**主动问** WorkBuddy 一个问题 | **MCP** |

两者可以共存，互不冲突。

---

## 故障排查

### 先看这个

```bash
workbuddy-doctor
```

它把两个版本的每一步都列出来，绝大多数问题在这里就能定位。

### 报错速查

WorkBuddy 的错误码**含义不唯一**，同一个 `code` 可能是完全不同的原因。
**看 `msg`，不要只看 `code`。**

| 错误 | 真正含义 | 怎么办 |
|---|---|---|
| `11128` / `unapproved channel` | system 提示词含**竞品客户端标识** | 见下方专节 |
| `11128` / `first message is not system prompt` | 首条消息不是 system | 已自动处理 |
| `11148` / `tool calls and tool results do not match` | 工具调用与结果配对不上 | 已修复 |
| `11102` / `model … service info not found` | 模型名不存在 | 检查模型 id（去掉 `[1M]` 之类后缀）|
| `14003` / `too many requests` | **限流** | 等 1–2 分钟，或换负载低的模型 |

### `11128 / unapproved channel`

**最容易误诊的一个。** 文案写着"被安全策略拦截"，看起来像风控问题，
实际上**只是 system 提示词里出现了 WorkBuddy 不认的客户端名称**：

| system 里的内容 | 结果 |
|---|---|
| `You are a helpful assistant.` | ✅ |
| `You are a Claude agent... Claude Agent SDK.` | ✅ |
| `OpenAI`（单独出现）| ✅ |
| **`Claude Code`** | ❌ |
| **`Codex CLI`** | ❌ |
| **`x-anthropic-billing-header`** | ❌ |

本服务会**自动中性化**这些标识（只替换客户端的自我描述，不动任何用户内容）。
接新 agent 又撞上这个错误，说明它的提示词里有新的触发词 ——
用 `WORKBUDDY_DEBUG=1` 启动，据此扩展 `upstream.js` 的 `stripClientPreamble()`。

### 找不到某个版本的 App

`workbuddy-doctor` 会逐个列出四种探测策略的结果：

- `registry` 显示 `no match` → App 可能没装，或装在未登记的位置
- 探测到多个 → 用对应的 `*_ELECTRON_BIN` 指定其中一个

### 解密失败

```
status  unavailable — Failed to decrypt accessToken.
```

- 确认能自动探测到 exe（`workbuddy-doctor` 会显示）
- **打开一次桌面 App**（App 升级后密钥可能轮换）
- 确认是**新的**终端会话（旧会话可能继承旧环境变量）

### 401 / 令牌过期

1. 会自动尝试刷新（见[令牌刷新](#令牌刷新)）
2. 刷新也失败 → 打开桌面 App 重新登录
3. 再调一次即可

---

## 工作原理

桌面 App 的令牌在磁盘上是**加密**存储的（AES-256-GCM）：

```json
"accessToken": { "$wbEncrypted": 1, "envelope": "<base64>" }
```

密钥来自机器本地的一个 secret，而它**只能通过 WorkBuddy 自己魔改过的
Electron 的私有绑定拿到**：

```js
process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()
```

普通 Node 进程调不了这个私有绑定。所以本项目会**以 `ELECTRON_RUN_AS_NODE=1`
启动 App 自己的二进制**，让它以「纯 Node」模式跑一行脚本把 secret 吐出来。

> 这就是为什么**两个版本都必须绑定各自的 App 二进制** ——
> 而且必须绑定**正确的那一个**，因为两个 App 的密钥互不相通。

---

## 文件结构

```
workbuddy-bridge/
├── http-server.js   HTTP 服务：三套协议的路由与响应转换
├── providers.js     提供方注册表：哪个版本能用、默认用哪个
├── responses.js     OpenAI Responses 协议的双向转换
├── upstream.js      调用上游：请求头、SSE 解析、工具调用重组
├── credentials.js   令牌读取/解密（AES-256-GCM）+ 自动刷新
├── locate.js        双版本可执行文件定位
├── server.js        MCP 服务
└── doctor.js        环境检测
```

| 文件 | 负责 |
|---|---|
| `locate.js` | 按版本分类探测 exe（环境变量/安装目录/注册表/缓存）|
| `credentials.js` | 定位凭据 → spawn 对应 exe 取密钥 → 解密 → 刷新 |
| `providers.js` | 判断「装了」还是「能用」，决定默认版本 |
| `upstream.js` | 按版本差异化 origin、身份头、默认模型 |
| `http-server.js` | 路由、版本选择、三协议转换 |

---

## 已知限制

1. **只支持 Windows。** 两个 App 都是 Windows 版，发现逻辑也依赖卸载注册表。

2. **依赖桌面 App 的二进制做解密。** App 升级若改变密钥派生方式会导致解密
   失败，重新打开一次 App 通常可恢复。

3. **令牌刷新需要 client_id。** 默认值实测被拒（见[令牌刷新](#令牌刷新)）。
   失败时优雅降级，不影响正常使用。

4. **没有限流退避机制。** 连续快速请求会触发 429，出现时如实返回 429，
   客户端（如 CC Switch 的故障转移）可据此切换。

5. **接口是逆向得到的**，WorkBuddy 改版可能失效。

6. **服务必须保持运行。** 停了 agent 就连不上。

---

## 免责声明

- 本项目**非官方**，与 WorkBuddy、Anthropic、OpenAI 均无隶属或背书关系。
- 它使用**你自己账号**的令牌访问官方接口，**不绕过计费**。
- 使用它**可能与上游服务商的用户协议冲突**，请自行评估风险。

完整说明见 [`DISCLAIMER.md`](DISCLAIMER.md)。

---

## 许可

[MIT](LICENSE) © 2026 hanhan1223

---

## 致谢

- 上游端点与请求格式的还原，参考了 [`dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect) 的公开实现与实测记录。
