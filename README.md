# workbuddy-bridge

**Turn your local WorkBuddy desktop account into a model provider for Claude Code and Codex.**

Both editions are supported and auto-detected: international (`workbuddy.ai`) and China (`workbuddy.cn`).

**English** | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/workbuddy-bridge.svg)](https://www.npmjs.com/package/workbuddy-bridge)
[![npm downloads](https://img.shields.io/npm/dm/workbuddy-bridge.svg)](https://www.npmjs.com/package/workbuddy-bridge)
[![license](https://img.shields.io/npm/l/workbuddy-bridge.svg)](LICENSE)
[![node](https://img.shields.io/node/v/workbuddy-bridge.svg)](https://nodejs.org)

---

## What it solves

The models included with the WorkBuddy desktop app are normally usable only inside
the app's own interface. This project exposes them as a local API, so **Claude Code,
Codex, CC Switch, and any tool that speaks OpenAI- or Anthropic-compatible
protocols** can use it directly as a model provider.

| Edition | Executable | Domain | Credential file |
|---|---|---|---|
| **International `ai`** | `WorkBuddyAI.exe` | `www.workbuddy.ai` | `workbuddy-desktop-ai.info` |
| **China `cn`** | `WorkBuddy.exe` | `www.workbuddy.cn` | `workbuddy-desktop.info` |

The rule is simple: **use the international edition when present, otherwise the
China one; when both are present, both are usable.**

> The two apps can be installed **side by side on the same machine**, but they
> belong to **different accounts**. Picking the wrong one silently spends the wrong
> quota, so this bridge never guesses — it probes each edition and validates it.

How the chain works:

```
your agent (Claude Code / Codex / ...)
   │  HTTP
   ▼
workbuddy-bridge  ──① reads ──▶ desktop app credential file (AES-256-GCM encrypted)
   │                                  │
   │                    ② decrypt: spawn the app's own exe
   │                       (ELECTRON_RUN_AS_NODE=1)
   │                       to read atRestSecretKey from its private storage binding
   │
   └──③ HTTPS ──▶ official cloud endpoint /v2/chat/completions
                  (using your already signed-in account token)
```

> Requests go to the **official cloud endpoint** and reuse the account your desktop
> app is already signed into. They consume **your own account's quota**;
> billing is not bypassed.

---

## Install

### Option 1: npm (recommended)

```bash
npm install -g workbuddy-bridge
```

Three commands become available:

| Command | Purpose |
|---|---|
| `workbuddy-doctor` | **Environment check** — run this first |
| `workbuddy-bridge` | Start the HTTP server |
| `workbuddy-bridge-mcp` | Start the MCP server |

### Option 2: run without installing

```bash
npx workbuddy-bridge                        # start the server
npx -p workbuddy-bridge workbuddy-doctor    # environment check
```

### Option 3: clone the source

```bash
git clone https://github.com/hanhan1223/workbuddy-bridge.git
cd workbuddy-bridge
node doctor.js
```

> Zero runtime dependencies. `@modelcontextprotocol/sdk` is needed only for MCP
> mode, and is an optional dependency.

---

## Requirements

| Requirement | Notes |
|---|---|
| **Windows** | Windows only for now (discovery reads the uninstall registry, and both apps are Windows builds) |
| **Node.js 20.3+** | Uses `AbortSignal.any` |
| **WorkBuddy desktop app** | International or China edition, **and signed in** |

**No path configuration needed.** The bridge locates the app automatically, trying:

| Order | Strategy |
|---|---|
| 1 | Environment variable (`WORKBUDDY_AI_ELECTRON_BIN` / `WORKBUDDY_ELECTRON_BIN`) |
| 2 | Conventional install locations (`%LOCALAPPDATA%\Programs`, etc.) |
| 3 | Windows uninstall registry (covers non-standard installs) |
| 4 | The last path that successfully decrypted a token (cache) |

---

## Quick start

### 1. Environment check

```bash
workbuddy-doctor
```

It inspects the whole machine: Node version, environment variables, **the discovery
process for each edition**, whether credentials decrypt, the model catalog, and
finally a **live chat round-trip**.

Sample output (on a machine with only the China edition installed):

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

Two fields are all you need:

| Field | Meaning |
|---|---|
| `detected editions` | Which editions are actually usable (`ai` / `cn` / both) |
| `active edition` | Which account's quota is spent by default |

> ⚠️ **`workbuddy-doctor` is a one-shot check — it does not start the server.**
> It verifies that the account works and then exits. If you curl port 8799 right
> after, you will get `Could not connect to server`, because nothing is listening
> yet. Starting the server is the next step.

### 2. Start the server

```bash
workbuddy-bridge
```

```
[workbuddy-http] listening on http://127.0.0.1:8799
[workbuddy-http] provider ai: unavailable — Could not find the international ... executable.
[workbuddy-http] provider cn: OK  domain=www.workbuddy.cn default=auto
[workbuddy-http] active provider: cn
[workbuddy-http]
[workbuddy-http] Ready. Leave this window open — closing it stops the bridge.
[workbuddy-http] Query it from another terminal, e.g.:
[workbuddy-http]   curl http://127.0.0.1:8799/health
```

**Two things to know:**

1. **This window must stay open.** The bridge runs in the foreground; closing the
   terminal or pressing `Ctrl+C` stops it, and your agent loses connection.
   To run it in the background instead, see
   [Running in the background](#running-in-the-background).
2. **Send requests from a second terminal.** The first one is occupied by the
   server. Commands like `curl` need their own window.

The detected result is printed at startup, so **which quota is being spent** is
visible immediately.

> The server binds to **`127.0.0.1` only**, because the process holds your account
> token and must never be reachable from the network.

### 3. Connect your agent

| Protocol | Endpoint |
|---|---|
| Anthropic Messages | `http://127.0.0.1:8799/v1/messages` |
| OpenAI Chat Completions | `http://127.0.0.1:8799/v1/chat/completions` |
| OpenAI Responses | `http://127.0.0.1:8799/v1/responses` |
| Model list | `http://127.0.0.1:8799/v1/models` |
| Health check | `http://127.0.0.1:8799/health` |

#### Claude Code

Write to `~/.claude/settings.json`:

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

> Use model ids from the catalog of the edition you **actually detected** — run
> `workbuddy-doctor` to list them.
> `ANTHROPIC_AUTH_TOKEN` can be **any non-empty string**: the server does not
> validate it (the real token is decrypted server-side and never sent to you),
> but Claude Code rejects an empty value.

#### Codex

Write to `~/.codex/config.toml`:

```toml
model = "auto"
model_provider = "workbuddy"

[model_providers.workbuddy]
name = "workbuddy"
base_url = "http://127.0.0.1:8799/v1"
wire_api = "responses"          # ← must be responses
requires_openai_auth = false
```

> ⚠️ `wire_api` must be **`responses`**. Codex speaks the Responses protocol
> natively; `chat/completions` also works but adds an unnecessary conversion layer.

#### Other tools

Any tool supporting one of the three protocols above will work. When connecting
**CC Switch** as a custom provider, pick **Anthropic Messages (native)** as the
upstream format — not the OpenAI format, which would cause double conversion.

---

## How the edition is chosen

### Automatic priority

```
1. Explicit override (WORKBUDDY_EDITION / --edition)
2. International ai (when both are usable)
3. China cn
```

### What counts as "usable"

**Installed ≠ usable.** An edition becomes a provider only when all three hold:

1. Its executable was located
2. Its credential file exists and **decrypts**
3. It carries a usable access token

An app that is installed but was never signed in **does not count**. This matters:
routing to a signed-out app fails at request time with an error unrelated to the
request itself.

### Choosing when both are installed

| Method | Example |
|---|---|
| URL prefix | `POST http://127.0.0.1:8799/cn/v1/chat/completions` |
| Request header | `X-WorkBuddy-Edition: cn` |
| Body field | `{"edition": "cn", ...}` |

Check current status:

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

## Token refresh

The original had no refresh: an expired token meant opening the desktop app by
hand. There are now three mechanisms:

| Mechanism | Trigger |
|---|---|
| **Automatic** | Refreshed before a request when the token expires within 5 minutes |
| **401 retry** | On a 401 → refresh once → retry with the new token |
| **Manual** | `POST /refresh`, which also **re-detects the whole machine** |

Refreshed tokens are cached at `$DSH_HOME/.workbuddy-<edition>-auth.json` and
**never written back into the app's own credential file**.

```bash
curl -X POST http://127.0.0.1:8799/refresh
workbuddy-doctor --refresh
```

> **About `WORKBUDDY_CLIENT_ID`**: refresh uses the Keycloak `refresh_token` grant,
> which needs a `client_id`. The desktop app does not leave a reliable client_id on
> disk, so `console` (the value in the token's own `azp` claim) is used by default —
> **and that value was measured to be rejected by the server**. If you obtain the
> real client_id, set this environment variable.
>
> A failed refresh **does not break normal use**: it degrades gracefully to "keep
> using the current token", and only reports when the token has truly expired.

---

## Finding out which models you can use

### Listing the catalog

```bash
curl http://127.0.0.1:8799/v1/models
```

```bash
workbuddy-doctor                     # shows the model catalog section
workbuddy-doctor --json | jq '.editions[].modelSample'
```

### The catalog is not the same as "callable"

`/v3/config` returns the account's **entire roster**, and it mixes real chat
models with entries that cannot serve a chat request — completion-only models,
small-parameter models, and image backends. Those appear in the list but fail
when used:

| Model | Result | Reason |
|---|---|---|
| `minimax-m2.5` | ❌ `11102` | model not found for this account |
| `glm-5.1` | ❌ `11102` | model not found for this account |
| `hunyuan-image-alpha` | ❌ `11103` | `Backend [hunyuan-stream] is not supported` |
| `codewise-completions` | ❌ `11102` | completion-only entry |

So **picking an id from the plain list is a reliable way to get a confusing
failure.** Measure instead:

```bash
workbuddy-doctor --probe-models        # probe the first 20 likely-chat ids
workbuddy-doctor --probe-models=50     # probe more
workbuddy-doctor --model=deepseek-v4.1-flash   # probe exactly one id
```

```
=== Probing which models actually respond ===
  [cn] probed 6 of 33 — 5 usable, 1 unusable
     usable:
       ✓ default                  1137ms
       ✓ deepseek-v4-pro          1489ms
       ✓ deepseek-v4-flash         901ms
       ✓ deepseek-v4.1-flash       980ms
       ✓ deepseek-v3-2-volc       1478ms
     unusable (listed but not callable):
       ✗ minimax-m2.5             not a chat model
```

Through HTTP, the same measurement is available as an annotated model list:

```bash
curl 'http://127.0.0.1:8799/v1/models?probe=true&limit=5'
```

```json
{
  "object": "list",
  "data": [ { "id": "deepseek-v4.1-flash", "probe": "usable" } ],
  "probe": {
    "edition": "cn",
    "probed": 5,
    "available": ["default", "deepseek-v4-pro", "deepseek-v4-flash", "..."],
    "unusable": [{ "id": "minimax-m2.5", "reason": "not a chat model" }],
    "undetermined": []
  }
}
```

| Query | Behaviour |
|---|---|
| `/v1/models` | Plain list. Unchanged shape — existing clients are unaffected. |
| `/v1/models?probe=true` | Measure, then annotate every entry |
| `/v1/models?probe=true&limit=N` | Bound how many are measured (max 50) |
| `/v1/models?probe=cached` | Return the last run without new requests |
| `/v1/models?probe=refresh` | Ignore the cache and measure again |

Over MCP, the `workbuddy_probe` tool does the same, so an agent can check before
choosing a model.

### Cost and caching

Each probe is a **real request that spends account quota**, so:

- probing is **opt-in** — a plain `workbuddy-doctor` run stays free
- only the first **20** likely-chat models are probed by default (raise with `=N`)
- results are cached for **30 minutes** per edition
- probes run **3 at a time** to avoid the upstream's 429 rate limit
- a rate-limited probe is reported as `undetermined`, **never as unusable** — a
  transient 429 must not make a working model look broken
- `POST /refresh` and `workbuddy_refresh` clear the cache

---

## Supported agents

| Agent | Protocol | Status |
|---|---|---|
| **Claude Code** | Anthropic Messages | ✅ Tested (including tool calls) |
| **Codex** | OpenAI Responses | ✅ Tested (including tool calls) |
| **CC Switch** | Custom provider | ✅ Compatible |
| OpenCode / others | Chat Completions | ⚪ Untested |

### Measured coverage

55 regression assertions were run in a **dual-edition** setup, all passing:

```
Both single-edition (cn) and dual-edition (ai+cn) runs:
  Anthropic non-stream + stream      ✅
  OpenAI Chat non-stream + stream    ✅
  OpenAI Responses non-stream + stream ✅
  Tool calls + full tool loop        ✅
  All three edition-routing methods  ✅
  Model catalog (tagged per edition) ✅
  /refresh + 404                     ✅
```

---

## Running in the background

The bridge runs in the foreground, so it stops when you close the terminal or log
out. To keep it available, register it as a scheduled task that starts at logon:

```powershell
# Find the install location first
npm root -g
# e.g. C:\Users\<you>\AppData\Roaming\npm\node_modules

$dir = "C:\Users\<you>\AppData\Roaming\npm\node_modules\workbuddy-bridge"

$action  = New-ScheduledTaskAction -Execute "node" -Argument "$dir\http-server.js" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "WorkBuddy Bridge" -Action $action -Trigger $trigger
```

Then manage it with:

```powershell
Start-ScheduledTask  -TaskName "WorkBuddy Bridge"
Stop-ScheduledTask   -TaskName "WorkBuddy Bridge"
Unregister-ScheduledTask -TaskName "WorkBuddy Bridge" -Confirm:$false
```

**Check whether it is running:**

```powershell
curl http://127.0.0.1:8799/health
```

A `Could not connect to server` here means the bridge is not running — that is the
only thing that error ever means, and it is not a configuration problem.

> `workbuddy-doctor` reports whether a server is already listening, so it is a
> quick way to check without a curl.

---

## Configuration

### Command line

```
workbuddy-bridge [options]

  -p, --port <n>         Port (default 8799)
  -m, --model <id>       Default model
  -e, --edition <ai|cn>  Force one edition
  -h, --help             Help
  -v, --version          Version
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `WORKBUDDY_EDITION` | auto-detect | Force `ai` or `cn` |
| `WORKBUDDY_AI_ELECTRON_BIN` | auto-detect | International exe path |
| `WORKBUDDY_ELECTRON_BIN` | auto-detect | China exe path |
| `WORKBUDDY_AI_AUTH_FILE` | `%LOCALAPPDATA%\CodeBuddyExtension\…\workbuddy-desktop-ai.info` | International credential file |
| `WORKBUDDY_AUTH_FILE` | `%LOCALAPPDATA%\CodeBuddyExtension\…\workbuddy-desktop.info` | China credential file |
| `WORKBUDDY_CLIENT_ID` | `console` | OAuth client id used for refresh |
| `WORKBUDDY_MCP_PORT` | `8799` | HTTP port |
| `WORKBUDDY_MODEL` | per edition | Default model |
| `WORKBUDDY_TIMEOUT_MS` | `300000` | Upstream request timeout |
| `WORKBUDDY_SLOW_MS` | `60000` | Log requests slower than this |
| `WORKBUDDY_DEBUG` | — | Set to `1` to log upstream request details |

> Do **not** mix the two `*_ELECTRON_BIN` variables. Pointing one at the other
> edition's binary fails explicitly, because it would spend the other account's quota.

---

## MCP mode

Besides the HTTP server, an MCP server lets an agent **call WorkBuddy on its own**:

```bash
claude mcp add workbuddy -- npx -y workbuddy-bridge-mcp
```

| Tool | Purpose |
|---|---|
| `workbuddy_ask` | Send a prompt (accepts an `edition` argument) |
| `workbuddy_models` | List models available to an edition |
| `workbuddy_probe` | Test which models actually respond |
| `workbuddy_status` | Detected editions and their identities |
| `workbuddy_refresh` | Re-detect the machine and refresh tokens |

**When to use MCP instead of HTTP?**

| You want | Use |
|---|---|
| WorkBuddy as a **model provider** (switchable, aggregatable) | **HTTP** |
| The agent to **ask** WorkBuddy a question mid-conversation | **MCP** |

Both can coexist without conflict.

---

## Troubleshooting

### Start here

```bash
workbuddy-doctor
```

It lists every step for both editions; most problems are identified there.

### Error reference

WorkBuddy error codes are **not unique** — the same `code` can mean entirely
different things. **Read `msg`, not just `code`.**

| Error | Real meaning | What to do |
|---|---|---|
| `11128` / `unapproved channel` | system prompt contains a **competitor client identifier** | See the section below |
| `11128` / `first message is not system prompt` | First message is not system | Handled automatically |
| `11148` / `tool calls and tool results do not match` | Tool calls and results cannot be paired | Fixed |
| `11102` / `model … service info not found` | Model name does not exist | Check the model id (strip suffixes like `[1M]`) |
| `14003` / `too many requests` | **Rate limited** | Wait 1–2 minutes, or pick a less busy model |

### `11128 / unapproved channel`

**The most commonly misdiagnosed one.** The message sounds like a security policy
block, so it reads as a network or risk-control problem. In reality it **just means
the system prompt contains a client name WorkBuddy does not recognise**:

| Content in system | Result |
|---|---|
| `You are a helpful assistant.` | ✅ |
| `You are a Claude agent... Claude Agent SDK.` | ✅ |
| `OpenAI` (on its own) | ✅ |
| **`Claude Code`** | ❌ |
| **`Codex CLI`** | ❌ |
| **`x-anthropic-billing-header`** | ❌ |

The bridge **neutralises these automatically** — it only replaces the client's own
self-description and never touches user content. If a new agent hits this error, its
prompt contains a new trigger word: start with `WORKBUDDY_DEBUG=1` and extend
`stripClientPreamble()` in `upstream.js` accordingly.

### An edition's app is not found

`workbuddy-doctor` lists the result of each of the four discovery strategies:

- `registry` shows `no match` → the app may not be installed, or is in an unregistered location
- Several were found → point the matching `*_ELECTRON_BIN` at the one to use

### Decryption fails

```
status  unavailable — Failed to decrypt accessToken.
```

- Confirm the exe is located (`workbuddy-doctor` shows this)
- **Open the desktop app once** (the key may rotate after an app upgrade)
- Confirm you are in a **new** terminal session (an old one may hold stale environment variables)

### 401 / expired token

1. A refresh is attempted automatically (see [Token refresh](#token-refresh))
2. If refresh also fails → open the desktop app and sign in again
3. Call again

---

## How it works

The desktop app stores its tokens **encrypted** on disk (AES-256-GCM):

```json
"accessToken": { "$wbEncrypted": 1, "envelope": "<base64>" }
```

The key derives from a machine-local secret that is **only obtainable through the
private binding of WorkBuddy's modified Electron**:

```js
process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()
```

A stock Node process cannot call this private binding. So the bridge **starts the
app's own binary with `ELECTRON_RUN_AS_NODE=1`**, letting it run a one-line script
in "pure Node" mode that prints the secret.

> This is why **each edition must bind its own app binary** — and specifically the
> **correct** one, since the two apps' keys are mutually exclusive.

---

## File layout

```
workbuddy-bridge/
├── http-server.js   HTTP server: routing and response translation for three protocols
├── providers.js     Provider registry: which edition is usable, which is default
├── probe.js         Model availability probing and caching
├── responses.js     Bidirectional OpenAI Responses protocol translation
├── upstream.js      Upstream calls: headers, SSE parsing, tool-call reassembly
├── credentials.js   Token read/decrypt (AES-256-GCM) + automatic refresh
├── locate.js        Dual-edition executable discovery
├── server.js        MCP server
└── doctor.js        Environment diagnostics
```

| File | Responsibility |
|---|---|
| `locate.js` | Classify and discover exes per edition (env / install root / registry / cache) |
| `credentials.js` | Locate credentials → spawn the matching exe for the key → decrypt → refresh |
| `providers.js` | Decide "installed" vs "usable", and pick the default edition |
| `probe.js` | Measure which catalog entries answer a chat request, with caching |
| `upstream.js` | Per-edition origin, identity headers, and default model |
| `http-server.js` | Routing, edition selection, three-protocol translation |

---

## Known limitations

1. **Windows only.** Both apps are Windows builds and discovery reads the uninstall registry.

2. **Decryption depends on the desktop app's binary.** An app upgrade that changes
   key derivation will break decryption; reopening the app once usually restores it.

3. **Token refresh needs a client_id.** The default value was measured to be rejected
   (see [Token refresh](#token-refresh)). Failure degrades gracefully and does not
   affect normal use.

4. **No rate-limit backoff.** Rapid consecutive requests trigger 429; it is returned
   as-is so clients (e.g. CC Switch failover) can react.

5. **The API is reverse-engineered** and may break when WorkBuddy changes.

6. **The server must stay running.** Stop it and the agent cannot connect.

---

## Disclaimer

- This project is **unofficial**, with no affiliation with or endorsement by
  WorkBuddy, Anthropic, or OpenAI.
- It accesses official endpoints using **your own account's** token and
  **does not bypass billing**.
- Using it **may conflict with the upstream provider's terms of service**; assess
  that risk yourself.

See [`DISCLAIMER.md`](DISCLAIMER.md) for the full statement.

---

## License

[MIT](LICENSE) © 2026 hanhan1223

---

## Acknowledgements

- Restoration of the upstream endpoints and request formats referenced the public
  implementation and measured findings of [`dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect).
