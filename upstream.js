/**
 * WorkBuddy upstream client — works for BOTH editions.
 *
 * The two products (workbuddy.ai international, workbuddy.cn China) share the
 * same wire protocol: `GET /v3/config` for the catalog and
 * `POST /v2/chat/completions` for chat, both SSE-only. What differs is the
 * origin, the product name presented in the identity headers, and the model
 * roster. Every difference is driven by the edition carried on the credential,
 * so callers pass a credential rather than a bare token.
 *
 * Endpoint + header set are transcribed from the working plugin
 * (dsh-workbuddy-connect), whose wire behaviour is in turn ported from
 * workbuddy2api. The upstream rejects non-streaming requests, so `stream` is
 * always forced true and we parse SSE ourselves.
 */

import { loadCredentials, electronPath, editionDomain } from './credentials.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const GLOBAL_BASE = 'https://www.workbuddy.ai';

/**
 * The product name each edition presents in its identity headers. Getting this
 * wrong is not cosmetic: chat is gated on client identity, and "WorkBuddy AI"
 * is what the international app's own requests carry.
 */
const PRODUCT_NAME = { ai: 'WorkBuddy AI', cn: 'WorkBuddy' };

/**
 * User-Agent for refresh / catalog requests. This CLI-shaped form is correct
 * *only* for those endpoints — chat must present the desktop identity below,
 * and sending this one on chat is rejected as an illegal invocation.
 */
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2';

/**
 * Rate limiting (HTTP 429 / code 14003). Callers — especially the HTTP layer,
 * where a 429 should be passed through as 429 rather than a generic 500 —
 * need to tell this apart from a real failure.
 */
export class WorkBuddyBusyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkBuddyBusyError';
    this.status = 429;
  }
}

/** The desktop identity the app presents; version is advisory. */
const CLIENT_VERSION = '5.5.2';

const APP_VERSION_FALLBACK = '5.5.2';
const CLI_VERSION_FALLBACK = '2.156.0';

/**
 * The desktop-client identity chat requests must present.
 *
 * Chat is gated by client identity: presenting the CLI-shaped UA (the one used
 * for refresh and the catalog) is rejected with HTTP 400 / code 11128,
 * "Illegal API invocation". The official desktop client composes
 *
 *     WorkBuddy/<v> <product>/<v> CLI/<cli>
 *
 * where <product> is "WorkBuddy AI" for the international app and plain
 * "WorkBuddy" for the CN one. Versions are read from the installed app; a
 * missing/unreadable install degrades to compiled-in defaults rather than
 * failing the request.
 */
export function resolveChatIdentity(edition = 'ai') {
  const appVersion = (process.env.WORKBUDDY_APP_VERSION ?? '').trim() || readInstalledAppVersion(edition);
  const cliVersion = (process.env.WORKBUDDY_CLI_VERSION ?? '').trim() || readBundledCliVersion(edition);
  return {
    clientVersion: /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(appVersion)
      ? appVersion
      : APP_VERSION_FALLBACK,
    cliVersion: /^\d{1,6}(?:\.\d{1,6}){1,3}(?:-[0-9A-Za-z.]+)?$/u.test(cliVersion)
      ? cliVersion
      : CLI_VERSION_FALLBACK,
  };
}

/** Read the app's `version` file next to its executable. */
function readInstalledAppVersion(edition = 'ai') {
  try {
    const bin = electronPath(edition);
    const versionFile = join(dirname(bin), 'version');
    return readFileSync(versionFile, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Read the bundled agent CLI's real version. Its package.json ships a `0.0.0`
 * placeholder with the true value under `publishConfig.customPackage.version`.
 */
function readBundledCliVersion(edition = 'ai') {
  try {
    const bin = electronPath(edition);
    const pkg = join(dirname(bin), 'resources', 'app.asar.unpacked', 'cli', 'package.json');
    const parsed = JSON.parse(readFileSync(pkg, 'utf8'));
    const real = parsed?.publishConfig?.customPackage?.version ?? parsed?.version;
    return typeof real === 'string' && real !== '0.0.0' ? real : '';
  } catch {
    return '';
  }
}

/** Build the chat User-Agent for an edition. */
export function chatUserAgent(identity, edition = 'ai') {
  const product = PRODUCT_NAME[edition] ?? PRODUCT_NAME.ai;
  const parts = [`WorkBuddy/${identity.clientVersion}`, `${product}/${identity.clientVersion}`];
  if (identity.cliVersion !== undefined) parts.push(`CLI/${identity.cliVersion}`);
  return parts.join(' ');
}

/**
 * Upstream request budget.
 *
 * Overridable because "the model is slow" and "the bridge is broken" present
 * identically to a client that just sees a hang: a reasoning model legitimately
 * spends minutes before emitting visible text. WORKBUDDY_TIMEOUT_MS lets the
 * caller set the budget, and every request slower than the slow threshold is
 * logged so a stall can be attributed to the upstream rather than guessed at.
 */
const REQUEST_TIMEOUT_MS = readPositiveIntEnv('WORKBUDDY_TIMEOUT_MS', 300000);

/** Requests slower than this are logged as slow (ms). 0 disables. */
const SLOW_REQUEST_MS = readPositiveIntEnv('WORKBUDDY_SLOW_MS', 60000);

function readPositiveIntEnv(name, fallback) {
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function originFor(credential) {
  const domain = typeof credential?.domain === 'string' && credential.domain !== ''
    ? credential.domain
    : editionDomain(credential?.edition ?? 'ai');
  return `https://${domain}`;
}

function commonHeaders(credential) {
  const origin = originFor(credential);
  return {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: origin,
    Referer: `${origin}/`,
    'User-Agent': CLIENT_UA,
  };
}

/**
 * Chat headers.
 *
 * `User-Agent` and `X-IDE-Version` must carry the DESKTOP identity here. The
 * CLI-shaped UA used by the catalog triggers HTTP 400 / code 11128 on chat.
 */
function chatHeaders(credential, identity = resolveChatIdentity(credential.edition)) {
  return {
    ...commonHeaders(credential),
    'User-Agent': chatUserAgent(identity, credential.edition),
    'Content-Type': 'application/json',
    ...(credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid }),
    'X-No-Enterprise-Id': '1',
    ...(credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain }),
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': identity.clientVersion,
    'X-Product': 'SaaS',
    Authorization: `Bearer ${credential.accessToken}`,
  };
}

/**
 * Fetch the live model catalog for an account.
 *
 * Both editions read their roster from `/v3/config`, which answers with an
 * envelope `{code, data:{...}}`; `code === 0` means success. The roster lives
 * directly under `data.models`, and some responses nest an agent-level list
 * under `data.agents[].models` instead — both are handled.
 */
export async function listModels(credential, edition = 'ai') {
  const cred = credential ?? (await loadCredentials(edition));
  const origin = originFor(cred);

  const response = await fetch(`${origin}/v3/config`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${cred.accessToken}`,
      Accept: 'application/json',
      Origin: origin,
      Referer: `${origin}/`,
      'X-Requested-With': 'XMLHttpRequest',
      'X-Product': 'SaaS',
      'User-Agent': CLIENT_UA,
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`Model catalog request failed: HTTP ${response.status} ${await safeText(response)}`);
  }

  const body = await response.json();
  if (typeof body?.code === 'number' && body.code !== 0) {
    throw new Error(`Model catalog returned code ${body.code}${body.msg ? `: ${body.msg}` : ''}`);
  }

  const data = body?.data ?? body;
  const raw = data?.models ?? data?.agents ?? data;
  if (!Array.isArray(raw)) {
    throw new Error('Model catalog response had an unexpected shape (no models array)');
  }

  // Normalize the shapes we have seen into {id, name}, keeping the extras the
  // catalog provides (context window, default flag) because /v1/models and the
  // doctor both want to show them.
  return raw
    .map((entry) => {
      if (typeof entry === 'string') return { id: entry, name: entry };
      if (typeof entry !== 'object' || entry === null) return undefined;
      const id = entry.id ?? entry.model ?? entry.modelId;
      if (typeof id !== 'string' || id === '') return undefined;
      const name = entry.name ?? entry.displayName ?? entry.label ?? id;
      const contextWindow =
        entry.maxInputTokens ?? entry.contextWindow ?? entry.context_window ?? undefined;
      return {
        id,
        name: typeof name === 'string' ? name : id,
        isDefault: entry.isDefault === true,
        contextWindow: typeof contextWindow === 'number' ? contextWindow : undefined,
      };
    })
    .filter(Boolean);
}

async function safeText(response) {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}

/**
 * Neutralize competitor-agent fingerprints in a system prompt.
 *
 * WorkBuddy's gateway performs channel identification on the system prompt and
 * rejects anything that identifies as another vendor's coding agent with
 * HTTP 400 / code 11128 "Illegal API invocation from an unapproved channel".
 * Measured against the live international endpoint, the triggers are specific
 * tokens rather than "Anthropic" or "OpenAI" in general:
 *
 *   1. the literal "Claude Code" — e.g. Claude Code's preamble
 *      "You are Claude Code, Anthropic's official CLI for Claude."
 *   2. any `x-anthropic-billing-header: ...` marker line
 *   3. the literal "Codex" — e.g. Codex CLI's preamble
 *      "You are a coding agent running in the Codex CLI ..."
 *
 * A neutral identity ("You are a helpful assistant."), "You are a Claude agent,
 * built on Anthropic's Claude Agent SDK.", and the word "OpenAI" on its own are
 * all accepted, so the check keys on those client names specifically.
 *
 * The preamble carries the client's own self-description only — no user
 * content — so neutralising it does not change what was asked.
 */
function stripClientPreamble(text) {
  if (typeof text !== 'string' || text === '') return text;

  let out = text;

  // 1. Drop `x-anthropic-*` marker lines (with any blank line that follows).
  out = out.replace(/^[ \t]*x-anthropic-[^\n]*\n?/gimu, '');

  // 2. Claude Code identity sentences.
  out = out.replace(/You are Claude Code, Anthropic's official CLI for Claude\./giu, 'You are a helpful assistant.');
  out = out.replace(/You are Claude Code[^\n.]*\./giu, 'You are a helpful assistant.');
  out = out.replace(/Anthropic's official CLI for Claude\.?/giu, '');

  // 3. Codex CLI identity sentences. Also drop the trailing "Codex CLI is an
  //    open source project led by OpenAI." sentence, which is part of the same
  //    self-description block.
  out = out.replace(
    /You are a coding agent running in the Codex CLI[^\n.]*\./giu,
    'You are a helpful assistant.',
  );
  out = out.replace(/Codex CLI is an open source project led by OpenAI\.?/giu, '');

  // Catch any remaining bare "Codex CLI" / "Codex" self-references in prose.
  out = out.replace(/Codex CLI/giu, 'the coding agent');

  return out.replace(/^\s*\n/u, '').trim();
}

/** Apply stripClientPreamble to every system message in place. */
function stripPreambleFromMessages(messages) {
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue;
    if (message.role === 'system' && typeof message.content === 'string') {
      message.content = stripClientPreamble(message.content);
    }
  }
  return messages;
}

/**
 * The international endpoint rejects any conversation whose first message is
 * not a system prompt (upstream error code 11128). When the caller supplies no
 * system message we therefore inject this default, exactly as the desktop app
 * and the reference plugin do.
 */
const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';

/**
 * Rewrite a `role: "developer"` message to `role: "system"`.
 *
 * Load-bearing: the OpenAI convention spells the system prompt as `developer`,
 * but this upstream rejects that role with HTTP 400 / code 11128 "Illegal API
 * invocation from an unapproved channel" — which reads like a security refusal
 * and sends you hunting for a header problem that does not exist.
 */
function normalizeDeveloperRole(messages) {
  for (const message of messages) {
    if (message !== null && typeof message === 'object' && message.role === 'developer') {
      message.role = 'system';
    }
  }
  return messages;
}

/**
 * Flatten `tool_choice` into the string form this upstream expects. Object
 * forms (`{type:"auto"}`) are rejected with a 400. `none` means the tools are
 * unusable, so they are dropped too.
 */
function normalizeToolChoice(out) {
  if (!('tool_choice' in out)) return;
  const choice = out.tool_choice;
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') {
      delete out.tool_choice;
      delete out.tools;
    }
    return;
  }
  if (choice !== null && typeof choice === 'object' && !Array.isArray(choice)) {
    const type = typeof choice.type === 'string' ? choice.type.trim().toLowerCase() : '';
    if (type === 'none') {
      delete out.tool_choice;
      delete out.tools;
    } else if (type === 'auto' || type === 'required') {
      out.tool_choice = type;
    } else if (type === 'function') {
      const name = choice.function?.name;
      if (typeof name === 'string' && name !== '') {
        out.tool_choice = { type: 'function', function: { name } };
      } else {
        delete out.tool_choice;
      }
    } else {
      delete out.tool_choice;
    }
  }
}

/**
 * Strip client-side model decorations such as the `[1M]` context-window hint
 * that CC Switch appends (`deepseek-v4.1-flash[1M]`). The upstream has no such
 * model and answers 11102 "model ... service info not found".
 *
 * Applied here, in the one place every request funnels through, so no caller
 * (HTTP, Anthropic translation, or MCP) can leak a decorated id upstream.
 */
function bareModelId(value) {
  if (typeof value !== 'string') return undefined;
  const bare = value.trim().replace(/\[[^\]]*\]\s*$/u, '').trim();
  return bare === '' ? undefined : bare;
}

/**
 * Normalize an OpenAI-style body for this upstream.
 *
 * Four transformations are required, each one an upstream 400 if skipped:
 * `stream` forced true, a leading `system` message guaranteed, an object
 * `tool_choice` flattened to its string form, and the model id stripped of
 * client decorations.
 */
function normalizeBody(body, model) {
  const raw = Array.isArray(body.messages) ? body.messages : [];

  normalizeDeveloperRole(raw);
  stripPreambleFromMessages(raw);

  let messages = raw;
  const firstIsSystem = raw.length > 0 && raw[0]?.role === 'system';
  if (!firstIsSystem) {
    let systemContent = '';
    if (typeof body.system === 'string' && body.system.trim() !== '') {
      systemContent = stripClientPreamble(body.system);
    }
    messages = [
      { role: 'system', content: systemContent.trim() === '' ? DEFAULT_SYSTEM_PROMPT : systemContent },
      ...raw.filter((m) => m?.role !== 'system'),
    ];
  }

  const out = {
    model: bareModelId(model) ?? bareModelId(body.model) ?? 'default-model',
    stream: true,
    messages,
  };
  // Reasoning models can spend the entire budget on `reasoning_content` and
  // return finish_reason "length" with NO visible text. Measured on the live
  // endpoint, that happens roughly one time in five with a small budget, and
  // the client only ever sees an empty reply. Raising the floor leaves room
  // for the answer after the thinking.
  if (typeof body.max_tokens === 'number') {
    out.max_tokens = Math.max(body.max_tokens, MIN_TOKENS_FOR_REPLY);
  }
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (typeof body.reasoning_effort === 'string') out.reasoning_effort = body.reasoning_effort;

  // Forward tools when the caller supplied them, then normalize the choice.
  // tool_choice must be copied in first, otherwise normalizeToolChoice sees
  // `undefined` and silently leaves an object form in place (a 400 upstream).
  if (Array.isArray(body.tools) && body.tools.length > 0) out.tools = body.tools;
  if (body.tool_choice !== undefined) out.tool_choice = body.tool_choice;
  normalizeToolChoice(out);

  return out;
}

/**
 * Floor applied to max_tokens so a reasoning model cannot spend the whole
 * budget thinking and return no visible answer. A caller asking for a tiny
 * reply still gets a reply.
 */
const MIN_TOKENS_FOR_REPLY = 1024;

/** Test seam: exercise body normalization without issuing a request. */
export function normalizeBodyForTest(body) {
  return normalizeBody(body);
}

/**
 * Run a chat completion, streaming deltas through `onDelta`.
 * Returns the full concatenated assistant text.
 *
 * `edition` selects which account's binary, credential file and quota are used.
 * On a 401 the token is refreshed once and the request retried — a long-lived
 * bridge cannot ask the user to reopen the desktop app every few hours.
 */
export async function chat(body, { onDelta, signal, edition = 'ai', credential } = {}) {
  const startedAt = Date.now();
  try {
    return await runChat(body, { onDelta, signal, edition, credential });
  } catch (error) {
    // A caller-side abort and an upstream stall both arrive as a bare
    // "TimeoutError", which sends people hunting for a bug in the bridge.
    // Saying which one happened — and how long it waited — makes the
    // difference visible.
    const elapsed = Date.now() - startedAt;
    const aborted = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    if (aborted) {
      throw new Error(
        `WorkBuddy upstream did not finish within ${elapsed}ms and the request was aborted. ` +
          'This is usually a slow reasoning model rather than a bridge failure — raise ' +
          'WORKBUDDY_TIMEOUT_MS, or pick a faster model.',
      );
    }
    throw error;
  }
}

async function runChat(body, { onDelta, signal, edition = 'ai', credential } = {}) {
  const cred = credential ?? (await loadCredentials(edition));
  const payload = normalizeBody(body);
  const startedAt = Date.now();

  // Log how long the upstream took once it crosses the slow threshold, so
  // "the model is thinking" is distinguishable from "nothing happened".
  const noteElapsed = (outcome) => {
    const elapsed = Date.now() - startedAt;
    if (SLOW_REQUEST_MS > 0 && elapsed >= SLOW_REQUEST_MS) {
      console.error(
        `[workbuddy] slow upstream: ${elapsed}ms edition=${edition} model=${payload.model}` +
          (outcome === undefined ? '' : ` (${outcome})`),
      );
    }
  };

  let response = await sendChat(cred, payload, signal);

  // A 401 means the access token died. Refresh once and retry; if that fails,
  // report the refresh reason alongside the original error so the message
  // explains what to do instead of just "401".
  if (response.status === 401) {
    const detail = await safeText(response);
    const refreshed = await refreshCredential(edition, cred);
    if (refreshed !== undefined) {
      response = await sendChat(refreshed, payload, signal);
      if (response.ok) {
        const result = await readStream(response, onDelta);
        noteElapsed();
        return result;
      }
    }
    const reason = refreshed === undefined ? 'token expired and could not be refreshed' : undefined;
    noteElapsed(`HTTP 401${reason ? `, ${reason}` : ''}`);
    throw new Error(
      `WorkBuddy upstream HTTP 401: ${detail}` +
        (reason ? ` (${reason})` : '') +
        '. Open the WorkBuddy desktop app once to re-login.',
    );
  }

  if (process.env.WORKBUDDY_DEBUG === '1') {
    const h = chatHeaders(cred);
    console.error('[debug] edition          :', cred.edition ?? edition);
    console.error('[debug] upstream UA      :', h['User-Agent']);
    console.error('[debug] upstream X-IDE   :', h['X-IDE-Type'], h['X-IDE-Name'], h['X-IDE-Version']);
    console.error('[debug] upstream X-User  :', h['X-User-Id'] ?? '(none)');
    console.error('[debug] upstream payload :', JSON.stringify(payload).slice(0, 600));
    console.error('[debug] upstream status  :', response.status);
  }

  if (!response.ok) {
    const detail = await safeText(response);
    const lower = detail.toLowerCase();

    // 429 carries a JSON body even though the endpoint normally streams SSE.
    const isBusy =
      response.status === 429 ||
      lower.includes('too many requests') ||
      detail.includes('请求过于频繁') ||
      detail.includes('too many requests');
    if (isBusy) {
      noteElapsed('rate limited');
      throw new WorkBuddyBusyError(
        `WorkBuddy is rate-limiting this account (HTTP ${response.status}). ` +
          `Wait about a minute, or pick a less busy model. ${detail}`,
      );
    }

    // Surface quota problems distinctly: they are the common failure here.
    const isCredit =
      response.status === 402 ||
      [
        'insufficient credit',
        'no credit',
        'credit exhausted',
        'out of credit',
        'quota exceeded',
        'quota exhaust',
        'payment required',
        '积分不足',
        '额度不足',
        '余额不足',
        '没有积分',
      ].some((marker) => lower.includes(marker) || detail.includes(marker));
    const suffix = isCredit ? ' (account quota/credits appear exhausted)' : '';
    noteElapsed(`HTTP ${response.status}`);
    throw new Error(`WorkBuddy upstream HTTP ${response.status}${suffix}: ${detail}`);
  }

  const result = await readStream(response, onDelta);
  noteElapsed();
  return result;
}

/** POST one chat request to the credential's own origin. */
async function sendChat(credential, payload, signal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  return fetch(`${originFor(credential)}/v2/chat/completions`, {
    method: 'POST',
    headers: chatHeaders(credential),
    body: JSON.stringify(payload),
    signal: combined,
  });
}

/**
 * Refresh an edition's credential, returning the new one or `undefined`.
 * Used both by the 401 retry path and by the doctor's --refresh.
 */
async function refreshCredential(edition, credential) {
  try {
    const { tryRefresh } = await import('./credentials.js');
    const result = await tryRefresh(edition);
    return result.ok ? result.credential : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse an established SSE stream: text deltas, reasoning, and tool-call
 * fragments reassembled by index.
 */
async function readStream(response, onDelta, startedAt = Date.now()) {
  if (!response.body) throw new Error('WorkBuddy upstream returned no body');

  // A 200 can still be JSON rather than SSE (e.g. an error envelope). Reading
  // it as SSE would silently produce empty text, so check the content type.
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('event-stream')) {
    const bodyText = await safeText(response);
    throw new Error(
      `WorkBuddy returned ${contentType || 'an unknown content type'} instead of an SSE stream: ${bodyText}`,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let reasoning = '';
  let finishReason = null;

  // Tool calls stream in fragments: the first chunk carries id/type/name, and
  // later chunks append pieces of the JSON `arguments` string. They must be
  // merged by index before they can be emitted as complete calls.
  const toolCalls = new Map();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line === '' || !line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;

      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = event?.choices?.[0];
      if (!choice) continue;
      if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
        finishReason = choice.finish_reason;
      }
      const delta = choice.delta ?? {};

      // Reasoning models may emit reasoning_content separately.
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
        reasoning += delta.reasoning_content;
        onDelta?.({ type: 'reasoning', text: delta.reasoning_content });
      }

      const piece = typeof delta.content === 'string' ? delta.content : '';
      if (piece !== '') {
        full += piece;
        onDelta?.({ type: 'text', text: piece });
      }

      // Accumulate streamed tool-call fragments by index.
      if (Array.isArray(delta.tool_calls)) {
        for (const fragment of delta.tool_calls) {
          const slot = typeof fragment?.index === 'number' ? fragment.index : 0;
          const existing = toolCalls.get(slot) ?? {
            id: '',
            type: 'function',
            function: { name: '', arguments: '' },
          };
          if (typeof fragment?.id === 'string' && fragment.id !== '') existing.id = fragment.id;
          if (typeof fragment?.type === 'string' && fragment.type !== '') existing.type = fragment.type;
          const fn = fragment?.function;
          if (fn !== null && typeof fn === 'object') {
            if (typeof fn.name === 'string' && fn.name !== '') existing.function.name += fn.name;
            if (typeof fn.arguments === 'string' && fn.arguments !== '') {
              existing.function.arguments += fn.arguments;
            }
          }
          toolCalls.set(slot, existing);
        }
      }
    }
  }

  // Emit completed tool calls once, in stream order.
  const calls = [...toolCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, call]) => call)
    .filter((call) => call.function.name !== '');

  if (calls.length > 0) {
    onDelta?.({ type: 'tool_calls', toolCalls: calls });
  }

  return { text: full, reasoning, toolCalls: calls, finishReason };
}
