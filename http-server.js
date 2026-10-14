#!/usr/bin/env node
/**
 * WorkBuddy — local HTTP bridge, both editions.
 *
 * Exposes a WorkBuddy desktop account as a local HTTP endpoint that coding
 * agents can use as their model provider. Two editions can serve:
 *
 *   ai  international  workbuddy.ai   WorkBuddyAI.exe
 *   cn  China          workbuddy.cn   WorkBuddy.exe
 *
 * The edition is detected from the machine, not configured. When both are
 * installed and logged in, both are exposed and the international one is the
 * default; a request can name its provider with `"edition": "cn"` in the body,
 * an `X-WorkBuddy-Edition` header, or an `/ai/` or `/cn/` URL prefix.
 *
 * Three API surfaces, because different clients speak different dialects:
 *
 *   POST /v1/messages           — Anthropic Messages (Claude Code)
 *   POST /v1/chat/completions   — OpenAI Chat Completions
 *   POST /v1/responses          — OpenAI Responses (Codex)
 *   GET  /v1/models             — model list (OpenAI shape)
 *   GET  /health                — readiness + which providers are live
 *   POST /refresh               — re-detect the machine and refresh tokens
 *
 * Bind address is deliberately loopback-only: this process holds a live
 * account token and must never be reachable from the network.
 */

import { createServer } from 'node:http';

import { chat, WorkBuddyBusyError } from './upstream.js';
import { getProviders, resolveProvider, refreshProvider, getModels, invalidateCaches } from './providers.js';
import { probeModels, readProbeCache, clearProbeCache } from './probe.js';
import { responsesToChat, buildResponseObject, createResponsesStream } from './responses.js';

/** Parse `--port N` / `--port=N` / `--model X` / `--edition X` / `--help` / `--version`. */
function parseArgs(argv) {
  const opts = { port: undefined, model: undefined, edition: undefined, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.includes('=') ? arg.split(/=(.*)/su, 2) : [arg, undefined];
    const next = () => inline ?? argv[++i];
    switch (flag) {
      case '-p':
      case '--port':
        opts.port = Number(next());
        break;
      case '-m':
      case '--model':
        opts.model = next();
        break;
      case '-e':
      case '--edition':
        opts.edition = String(next()).trim().toLowerCase();
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '-v':
      case '--version':
        opts.version = true;
        break;
      default:
        if (arg.startsWith('-')) {
          console.error(`unknown option: ${arg}`);
          opts.help = true;
        }
    }
  }
  return opts;
}

const cli = parseArgs(process.argv.slice(2));

if (cli.version) {
  const pkg = JSON.parse(
    await (await import('node:fs/promises')).readFile(new URL('./package.json', import.meta.url), 'utf8'),
  );
  console.log(pkg.version);
  process.exit(0);
}

if (cli.help) {
  console.log(`workbuddy-bridge — expose a WorkBuddy account as a local API

Usage
  workbuddy-bridge [options]

Options
  -p, --port <n>     Port to listen on (default 8799, or $WORKBUDDY_MCP_PORT)
  -m, --model <id>   Default model (per edition, or $WORKBUDDY_MODEL)
  -e, --edition <ai|cn>
                     Force one edition instead of auto-detecting
  -h, --help         Show this help
  -v, --version      Show version

Endpoints
  POST /v1/messages           Anthropic Messages   (Claude Code)
  POST /v1/chat/completions   OpenAI Chat          (generic)
  POST /v1/responses          OpenAI Responses     (Codex)
  GET  /v1/models             Model list
  GET  /health                Readiness + detected providers
  POST /refresh               Re-detect the machine and refresh tokens

Choosing an edition (when both are installed)
  "edition": "cn" in the request body, an X-WorkBuddy-Edition header,
  or an /ai/ /cn/ prefix on any endpoint above.

Environment
  WORKBUDDY_AI_ELECTRON_BIN   Path to WorkBuddyAI.exe (international)
  WORKBUDDY_ELECTRON_BIN      Path to WorkBuddy.exe  (China)
  WORKBUDDY_AI_AUTH_FILE      Override the international auth file location
  WORKBUDDY_AUTH_FILE         Override the China auth file location
  WORKBUDDY_EDITION           ai | cn — force one edition
  WORKBUDDY_CLIENT_ID         OAuth client id used for token refresh
  WORKBUDDY_DEBUG=1           Log upstream requests to stderr

The server binds to 127.0.0.1 only. It holds your account token, so never
expose it to a network.`);
  process.exit(0);
}

const PORT = Number(cli.port ?? process.env.WORKBUDDY_MCP_PORT ?? 8799);
const HOST = '127.0.0.1';

/**
 * The upstream always streams; we buffer when the client asked for JSON.
 *
 * No compiled-in default model: the two editions have different rosters
 * (`deepseek-v4.1-flash` vs `auto`), so the default is resolved per provider at
 * request time. WORKBUDDY_MODEL or --model overrides both.
 */
const MODEL_OVERRIDE = cli.model || (process.env.WORKBUDDY_MODEL ?? '').trim() || undefined;
const EDITION_OVERRIDE =
  cli.edition === 'ai' || cli.edition === 'cn'
    ? cli.edition
    : (process.env.WORKBUDDY_EDITION ?? '').trim().toLowerCase() || undefined;

/** Resolve the default model for a provider, honouring the override. */
function defaultModelFor(provider) {
  return MODEL_OVERRIDE ?? provider.defaultModel;
}

/**
 * Which edition a request wants.
 *
 * Three spellings are accepted because clients differ in what they can set:
 * a URL prefix (easiest for a provider switcher), a header, and a body field.
 */
function requestedEdition(req, body) {
  const header = req.headers['x-workbuddy-edition'];
  if (typeof header === 'string' && header.trim() !== '') {
    const h = header.trim().toLowerCase();
    if (h === 'ai' || h === 'cn') return h;
  }
  if (body !== null && typeof body === 'object' && typeof body.edition === 'string') {
    const b = body.edition.trim().toLowerCase();
    if (b === 'ai' || b === 'cn') return b;
  }
  return EDITION_OVERRIDE;
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Cap on request size. A coding agent's prompt is never anywhere near this. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Read and parse a JSON request body.
 *
 * The size cap must be reported before the socket is torn down. Destroying the
 * request first makes the client see ECONNRESET — a bare "connection reset" —
 * instead of the 413 that explains what happened, so the error looks like a
 * crash rather than an oversized payload.
 */
function readBody(req, res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    const tooLarge = () => {
      if (res.headersSent) return;
      json(res, 413, {
        error: {
          type: 'request_too_large',
          message: `request body exceeds the ${MAX_BODY_BYTES / 1024 / 1024}MB limit`,
        },
      });
      // Let the client read the 413, then close.
      res.on('finish', () => req.destroy());
      if (res.writableEnded) req.destroy();
      else req.resume();
    };

    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Convert ONE Anthropic message into the upstream's chat shape.
 *
 * Tool-related blocks are load-bearing, not decoration:
 *
 * - an assistant `tool_use` block must become a `tool_calls` entry, otherwise
 *   the model cannot see that it already made the call and re-issues it
 *   forever (observed as an endless "let me actually call the tool" loop);
 * - a user `tool_result` block must become a `tool` message, otherwise the
 *   model never sees the command output and retries.
 *
 * Text blocks in the same message are preserved alongside them.
 */
function fromAnthropicMessage(message) {
  const role = message?.role === 'assistant' ? 'assistant' : 'user';
  const content = message?.content;

  // Plain string content: nothing structured to translate.
  if (typeof content === 'string') {
    return content === '' ? null : { role, content };
  }
  if (!Array.isArray(content)) return null;

  const textParts = [];
  const toolCalls = [];
  const toolResults = [];

  for (const block of content) {
    if (typeof block === 'string') {
      if (block !== '') textParts.push(block);
      continue;
    }
    if (block === null || typeof block !== 'object') continue;

    if (block.type === 'text' && typeof block.text === 'string') {
      if (block.text !== '') textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: typeof block.id === 'string' ? block.id : `call_${toolCalls.length}`,
        type: 'function',
        function: {
          name: typeof block.name === 'string' ? block.name : '',
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    } else if (block.type === 'tool_result') {
      toolResults.push({
        // `role: 'tool'` is required: without it the upstream sees a message
        // with a tool_call_id but no role and answers 11148 ("tool calls and
        // tool results do not match"), because it cannot pair the result with
        // the call.
        role: 'tool',
        tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
        content: anthropicToolResultToText(block.content),
      });
    }
  }

  // A tool_result belongs to its own `tool` message, not to the user turn.
  if (toolResults.length > 0) return toolResults;

  const text = textParts.join('\n');
  if (toolCalls.length > 0) {
    const out = { role: 'assistant', content: text, tool_calls: toolCalls };
    return out;
  }
  return text === '' ? null : { role, content: text };
}

/** Flatten an Anthropic tool_result payload into plain text. */
function anthropicToolResultToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (block?.type === 'text' && typeof block.text === 'string') return block.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Flatten Anthropic content blocks into a single string. */
function anthropicContentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (block?.type === 'text' && typeof block.text === 'string') return block.text;
      // Non-text blocks (images etc.) are not supported by this upstream.
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Convert an Anthropic Messages request into the upstream's chat shape.
 *
 * Tools are translated into the OpenAI function shape and passed through, so
 * Claude Code's tool use keeps working. The upstream requires a leading system
 * message and a string `tool_choice`; upstream.js normalizes both.
 */
function fromAnthropic(body, defaultModel) {
  const messages = [];

  if (typeof body.system === 'string' && body.system.trim() !== '') {
    messages.push({ role: 'system', content: body.system });
  } else if (Array.isArray(body.system)) {
    const sys = anthropicContentToText(body.system);
    if (sys.trim() !== '') messages.push({ role: 'system', content: sys });
  }

  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    const converted = fromAnthropicMessage(m);
    if (converted === null) continue;
    if (Array.isArray(converted)) messages.push(...converted);
    else messages.push(converted);
  }

  const out = {
    model: typeof body.model === 'string' && body.model !== '' ? body.model : defaultModel,
    messages,
    max_tokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
  };

  // Anthropic tools -> OpenAI function tools.
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools
      .filter((t) => typeof t?.name === 'string' && t.name !== '')
      .map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: typeof t.description === 'string' ? t.description : undefined,
          parameters: t.input_schema ?? { type: 'object', properties: {} },
        },
      }));
  }

  // Anthropic tool_choice -> the upstream's string form.
  const tc = body.tool_choice;
  if (tc !== undefined) {
    if (typeof tc === 'string') out.tool_choice = tc;
    else if (tc !== null && typeof tc === 'object') {
      const type = typeof tc.type === 'string' ? tc.type.toLowerCase() : '';
      if (type === 'auto' || type === 'any' || type === 'required') out.tool_choice = 'auto';
      else if (type === 'none') out.tool_choice = 'none';
      else if (type === 'tool' && typeof tc.name === 'string') {
        out.tool_choice = { type: 'function', function: { name: tc.name } };
      }
    }
  }

  return out;
}

/**
 * Map a client-requested model id onto one the upstream actually serves.
 *
 * Provider switchers (notably CC Switch) decorate model ids with bracketed
 * capability hints such as `deepseek-v4.1-flash[1M]`. The upstream has no such
 * model and answers `11102 "model ... service info not found"`, so the
 * decoration must be stripped before forwarding. The suffix is a client-side
 * context-window request, not part of the model's real name.
 */
function resolveModel(requested, defaultModel) {
  if (typeof requested !== 'string' || requested.trim() === '') return defaultModel;
  const bare = requested.trim().replace(/\[[^\]]*\]\s*$/u, '').trim();
  return bare === '' ? defaultModel : bare;
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Anthropic-shaped streaming response, which is what Claude Code consumes.
 * Note the SSE event names differ from OpenAI's: message_start,
 * content_block_delta, message_delta, message_stop.
 */
async function handleAnthropicMessages(req, res, body, provider) {
  const wantsStream = body.stream === true;
  const model = resolveModel(body.model, defaultModelFor(provider));
  const upstreamBody = fromAnthropic(body, defaultModelFor(provider));
  const edition = provider.edition;

  if (process.env.WORKBUDDY_DEBUG === '1') {
    console.error('[debug] /v1/messages incoming keys:', Object.keys(body).join(','));
    console.error(
      '[debug] translated ->',
      JSON.stringify({
        model: upstreamBody.model,
        roles: upstreamBody.messages.map((m) => m.role),
        tool_choice: upstreamBody.tool_choice,
        tools: upstreamBody.tools?.length ?? 0,
        max_tokens: upstreamBody.max_tokens,
      }),
    );
    console.error(
      '[debug] tool id map ->',
      JSON.stringify(
        upstreamBody.messages
          .map((m) =>
            m.tool_calls
              ? `assistant.calls=[${m.tool_calls.map((c) => c.id).join(',')}]`
              : m.role === 'tool'
                ? `tool.result=${m.tool_call_id}`
                : null,
          )
          .filter(Boolean),
      ),
    );
  }

  if (!wantsStream) {
    const result = await chat(upstreamBody, { edition });
    const content = [];
    if (result.text !== '') content.push({ type: 'text', text: result.text });
    for (const call of result.toolCalls ?? []) {
      let input = {};
      try {
        input = call.function.arguments === '' ? {} : JSON.parse(call.function.arguments);
      } catch {
        input = { _raw: call.function.arguments };
      }
      content.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
    }
    if (content.length === 0) content.push({ type: 'text', text: '' });

    const hasTools = (result.toolCalls ?? []).length > 0 || result.finishReason === 'tool_calls';
    return json(res, 200, {
      id: `msg_${Date.now().toString(36)}`,
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: hasTools ? 'tool_use' : result.finishReason === 'length' ? 'max_tokens' : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const id = `msg_${Date.now().toString(36)}`;
  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  // The text block is opened lazily: a pure tool-call response must not emit an
  // empty text block before its tool_use blocks. Claude Code reads the content
  // blocks positionally, and a leading empty text block makes it treat the turn
  // as "assistant said nothing" instead of "assistant wants a tool".
  let textBlockOpen = false;
  const openTextBlock = () => {
    if (textBlockOpen) return;
    textBlockOpen = true;
    sse(res, 'content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
  };

  let chars = 0;
  let stopReason = 'end_turn';
  try {
    const result = await chat(upstreamBody, {
      edition,
      onDelta: (d) => {
        if (d.type !== 'text' || d.text === '') return;
        openTextBlock();
        chars += d.text.length;
        sse(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: d.text },
        });
      },
    });

    const calls = result.toolCalls ?? [];

    // Close the text block only if one was actually opened. When the model
    // emitted no prose we close nothing and start the tool blocks at index 0.
    if (textBlockOpen) {
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    }

    // Tool calls arrive complete (already reassembled from stream fragments),
    // so each one is emitted as its own tool_use content block.
    let blockIndex = textBlockOpen ? 1 : 0;
    for (const call of calls) {
      let input = {};
      try {
        input = call.function.arguments === '' ? {} : JSON.parse(call.function.arguments);
      } catch {
        // Malformed arguments must not kill the stream; surface them as-is.
        input = { _raw: call.function.arguments };
      }
      sse(res, 'content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'tool_use', id: call.id, name: call.function.name, input: {} },
      });
      sse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      });
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
      blockIndex++;
    }

    // Report the real reason: Claude Code drives its tool loop off this.
    if (calls.length > 0 || result.finishReason === 'tool_calls') stopReason = 'tool_use';
    else if (result.finishReason === 'length') stopReason = 'max_tokens';

    // A reasoning model can burn its whole budget thinking and return no
    // visible text at all. Sending an empty reply looks like a broken bridge,
    // so say what actually happened and let the client retry with a larger
    // budget instead of showing the user a blank answer.
    if (result.text === '' && calls.length === 0) {
      sse(res, 'message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: 'max_tokens',
          stop_sequence: null,
        },
        usage: { output_tokens: chars },
      });
      sse(res, 'error', {
        type: 'error',
        error: {
          type: 'max_tokens_exhausted',
          message:
            'The model spent its entire output budget on internal reasoning and produced no visible text. ' +
            'Raise max_tokens (this bridge already enforces a minimum) or choose a non-reasoning model.',
        },
      });
      sse(res, 'message_stop', { type: 'message_stop' });
      res.end();
      return;
    }

    sse(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: chars },
    });
    sse(res, 'message_stop', { type: 'message_stop' });
  } catch (error) {
    // Mid-stream errors must be reported in-band; the status line is already sent.
    sse(res, 'error', {
      type: 'error',
      error: { type: 'api_error', message: String(error?.message ?? error) },
    });
  }
  res.end();
}

/** OpenAI-shaped streaming response. */
async function handleOpenAIChat(req, res, body, provider) {
  const wantsStream = body.stream === true;
  const model = resolveModel(body.model, defaultModelFor(provider));
  const edition = provider.edition;
  const id = `chatcmpl_${Date.now().toString(36)}`;

  // Forward the caller's body as-is: normalizeBody already handles every
  // transformation (stream, system prompt, tool_choice, model id), and
  // rebuilding the object here would silently drop `tools`, which makes the
  // model fall back to describing tool calls in prose instead of emitting them.
  const upstreamRequest = { ...body, model };

  if (!wantsStream) {
    const result = await chat(upstreamRequest, { edition });
    const calls = result.toolCalls ?? [];
    const message = { role: 'assistant', content: result.text === '' ? null : result.text };
    if (calls.length > 0) {
      message.tool_calls = calls.map((call, i) => ({
        index: i,
        id: call.id,
        type: 'function',
        function: { name: call.function.name, arguments: call.function.arguments },
      }));
    }
    return json(res, 200, {
      id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: calls.length > 0 ? 'tool_calls' : result.finishReason === 'length' ? 'length' : 'stop',
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const created = Math.floor(Date.now() / 1000);
  const frame = (delta, finish = null) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  res.write(`data: ${JSON.stringify(frame({ role: 'assistant', content: '' }))}\n\n`);
  try {
    const result = await chat(upstreamRequest, {
      edition,
      onDelta: (d) => {
        if (d.type !== 'text' || d.text === '') return;
        res.write(`data: ${JSON.stringify(frame({ content: d.text }))}\n\n`);
      },
    });

    // Emit reassembled tool calls in the OpenAI streaming shape.
    const calls = result.toolCalls ?? [];
    if (calls.length > 0) {
      res.write(
        `data: ${JSON.stringify(
          frame({
            tool_calls: calls.map((call, i) => ({
              index: i,
              id: call.id,
              type: 'function',
              function: { name: call.function.name, arguments: call.function.arguments },
            })),
          }),
        )}\n\n`,
      );
    }

    const finish = calls.length > 0 ? 'tool_calls' : result.finishReason === 'length' ? 'length' : 'stop';
    res.write(`data: ${JSON.stringify(frame({}, finish))}\n\n`);
    res.write('data: [DONE]\n\n');
  } catch (error) {
    res.write(
      `data: ${JSON.stringify({ error: { message: String(error?.message ?? error), type: 'api_error' } })}\n\n`,
    );
  }
  res.end();
}

/**
 * OpenAI Responses API. Codex speaks this protocol rather than Chat
 * Completions, so it needs its own request translation and event vocabulary.
 */
async function handleResponses(req, res, body, provider) {
  const wantsStream = body.stream === true;
  const edition = provider.edition;
  const id = `resp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const upstreamRequest = responsesToChat(body, defaultModelFor(provider));
  const model = upstreamRequest.model;

  if (process.env.WORKBUDDY_DEBUG === '1') {
    console.error('[debug] /v1/responses incoming keys:', Object.keys(body).join(','));
    console.error(
      '[debug] responses instructions:',
      JSON.stringify(String(upstreamRequest.messages[0]?.content ?? '').slice(0, 200)),
    );
    console.error(
      '[debug] responses -> roles:',
      upstreamRequest.messages.map((m) => m.role).join(','),
      '| tools:',
      upstreamRequest.tools?.length ?? 0,
    );
  }

  if (!wantsStream) {
    const result = await chat(upstreamRequest, { edition });
    return json(res, 200, buildResponseObject({
      id,
      model,
      text: result.text,
      toolCalls: result.toolCalls,
      createdAt,
    }));
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Responses events are named SSE frames, not bare `data:` lines.
  const write = (eventName, data) => {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const stream = createResponsesStream({ id, model, createdAt, write });
  stream.responseCreated();

  try {
    const result = await chat(upstreamRequest, {
      edition,
      onDelta: (d) => {
        if (d.type === 'text' && d.text !== '') stream.onTextDelta(d.text);
      },
    });
    stream.finish(result.toolCalls);
  } catch (error) {
    // The status line is already sent, so the failure travels in-band.
    stream.fail(String(error?.message ?? error));
  }
  res.end();
}

/**
 * Split an `/ai/` or `/cn/` prefix off a request path.
 *
 * A provider switcher that wants to pin one edition cannot set a header or a
 * body field, so the prefix is the only spelling available to it.
 */
function splitEditionPrefix(pathname) {
  const match = /^\/(ai|cn)(\/.*)?$/iu.exec(pathname);
  if (match === null) return { edition: undefined, path: pathname };
  return { edition: match[1].toLowerCase(), path: match[2] ?? '/' };
}

/** One provider's public summary, safe to put in /health. */
function providerSummary(entry) {
  return {
    edition: entry.edition,
    available: entry.available,
    domain: entry.domain,
    uid: entry.uid,
    defaultModel: entry.defaultModel,
    path: entry.path,
    expiresAt: entry.expiresAt !== undefined ? new Date(entry.expiresAt).toISOString() : undefined,
    error: entry.error,
  };
}

/**
 * Shape a probe run for the model-list response.
 *
 * `available` is the answer callers actually want: the ids that were measured
 * to work. `unusable` is what saves them — an id that is listed but not
 * callable, with the reason, so a failure can be diagnosed without probing.
 */
function describeProbe(probe, models) {
  const byId = new Map(probe.results.map((r) => [r.model, r]));
  return {
    edition: probe.edition,
    cached: probe.cached === true,
    stale: probe.stale === true,
    probedAt: new Date(probe.probedAt).toISOString(),
    total: probe.total,
    probed: probe.probed,
    available: probe.results.filter((r) => r.ok === true).map((r) => r.model),
    unusable: probe.results
      .filter((r) => r.ok === false)
      .map((r) => ({ id: r.model, reason: r.reason, detail: r.detail })),
    undetermined: probe.results.filter((r) => r.ok === null).map((r) => r.model),
    // Every catalog entry, annotated when it was measured.
    data: models.map((m) => {
      const r = byId.get(m.id);
      return r === undefined
        ? { id: m.id, object: 'model', owned_by: `workbuddy-${probe.edition}`, probe: 'not-tested' }
        : {
            id: m.id,
            object: 'model',
            owned_by: `workbuddy-${probe.edition}`,
            probe: r.ok === true ? 'usable' : r.ok === false ? 'unusable' : 'undetermined',
            ...(r.ok === false ? { reason: r.reason } : {}),
          };
    }),
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const prefixed = splitEditionPrefix(url.pathname);
  const path = prefixed.path.replace(/\/+$/u, '') || '/';

  try {
    if (req.method === 'GET' && (path === '/health' || path === '/')) {
      const registry = await getProviders();
      if (registry.available.length === 0) {
        return json(res, 503, {
          status: 'error',
          message: 'No usable WorkBuddy account was detected on this machine.',
          providers: registry.entries.map(providerSummary),
        });
      }
      const active = registry.available.find((e) => e.edition === registry.defaultEdition);
      return json(res, 200, {
        status: 'ok',
        provider: active.edition,
        defaultEdition: registry.defaultEdition,
        availableEditions: registry.availableEditions,
        uid: active.uid,
        domain: active.domain,
        defaultModel: defaultModelFor(active),
        providers: registry.entries.map(providerSummary),
      });
    }

    /**
     * Re-detect the machine and refresh tokens.
     *
     * The bridge is long-lived, but the machine is not static: an app can be
     * installed or logged into after startup. This endpoint forces a fresh
     * discovery instead of making the user restart the process.
     */
    if (req.method === 'POST' && path === '/refresh') {
      invalidateCaches();
      clearProbeCache();
      const body = await readBody(req, res);
      const requested = prefixed.edition ?? requestedEdition(req, body);
      const results = await refreshProvider(requested);
      const registry = await getProviders({ refresh: true });
      return json(res, 200, {
        status: results.some((r) => r.ok) ? 'ok' : 'error',
        refreshed: results.map((r) => ({
          edition: r.edition,
          ok: r.ok,
          reason: r.reason,
          expiresAt: r.expiresAt !== undefined ? new Date(r.expiresAt).toISOString() : undefined,
        })),
        providers: registry.entries.map(providerSummary),
      });
    }

    /**
     * Model list.
     *
     * `?probe=true` additionally reports which entries actually answer a chat
     * request. The catalog mixes real chat models with completion-only, small,
     * and image entries; those appear in the list but fail with 11102/11103 when
     * used, so a caller choosing from the plain list can pick an unusable id.
     *
     * Probing costs quota, so it is opt-in, bounded, and cached; `?probe=cached`
     * returns a previous run without making new requests.
     */
    if (req.method === 'GET' && path === '/v1/models') {
      const provider = await resolveProvider(prefixed.edition ?? requestedEdition(req, null));
      const models = await getModels(provider.edition);

      const probeParam = (url.searchParams.get('probe') ?? '').toLowerCase();
      const base = {
        object: 'list',
        data: models.map((m) => ({ id: m.id, object: 'model', owned_by: `workbuddy-${provider.edition}` })),
      };

      if (probeParam === '' || probeParam === 'false') return json(res, 200, base);

      const requestedLimit = Number(url.searchParams.get('limit'));
      const probeLimit =
        Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 50) : undefined;

      if (probeParam === 'cached') {
        // Match on the same shape a probe run would have used, so asking for the
        // cached answer to a specific limit returns that limit's measurement.
        const cached = readProbeCache(provider.edition, { limit: probeLimit ?? 20 });
        if (cached === undefined) {
          return json(res, 200, {
            ...base,
            probe: { edition: provider.edition, cached: true, available: false, note: 'no cached probe; call ?probe=true first' },
          });
        }
        return json(res, 200, { ...base, probe: describeProbe(cached, models) });
      }

      const probe = await probeModels(provider.edition, {
        refresh: probeParam === 'refresh',
        limit: probeLimit,
      });
      return json(res, 200, { ...base, probe: describeProbe(probe, models) });
    }

    if (req.method === 'POST' && path === '/v1/messages') {
      const body = await readBody(req, res);
      const provider = await resolveProvider(prefixed.edition ?? requestedEdition(req, body));
      return await handleAnthropicMessages(req, res, body, provider);
    }

    if (req.method === 'POST' && path === '/v1/chat/completions') {
      const body = await readBody(req, res);
      const provider = await resolveProvider(prefixed.edition ?? requestedEdition(req, body));
      return await handleOpenAIChat(req, res, body, provider);
    }

    if (req.method === 'POST' && path === '/v1/responses') {
      const body = await readBody(req, res);
      const provider = await resolveProvider(prefixed.edition ?? requestedEdition(req, body));
      return await handleResponses(req, res, body, provider);
    }

    return json(res, 404, { error: { message: `no route for ${req.method} ${path}`, type: 'not_found' } });
  } catch (error) {
    // A rate limit should reach the client as 429 so CC Switch can fail over.
    const status = error instanceof WorkBuddyBusyError ? 429 : 500;
    if (!res.headersSent) {
      return json(res, status, {
        error: { message: String(error?.message ?? error), type: 'api_error' },
      });
    }
    res.end();
  }
});

server.on('error', (error) => {
  // A listen conflict is by far the most common case: a second copy of the
  // bridge is already running. Say so instead of dumping a raw EADDRINUSE.
  const code = error?.code;
  if (code === 'EADDRINUSE') {
    console.error(`[workbuddy-http] port ${PORT} is already in use.`);
    console.error('[workbuddy-http] Another instance is probably already running. Check with:');
    console.error(`[workbuddy-http]   netstat -ano | findstr :${PORT}`);
    console.error('[workbuddy-http] Or pick a different port: workbuddy-bridge --port 8800');
    process.exit(1);
  }
  if (code === 'EACCES') {
    console.error(`[workbuddy-http] not allowed to listen on port ${PORT}. Pick a port above 1024.`);
    process.exit(1);
  }
  console.error(`[workbuddy-http] server error: ${error?.message ?? error}`);
  process.exit(1);
});

// A client that disconnects mid-stream must not take the process down.
process.on('uncaughtException', (error) => {
  const code = error?.code;
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ERR_STREAM_PREMATURE_CLOSE') {
    // Expected when an agent cancels a request. Nothing to report.
    return;
  }
  console.error(`[workbuddy-http] uncaught exception: ${error?.stack ?? error}`);
});

process.on('unhandledRejection', (reason) => {
  const code = reason?.code;
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ERR_STREAM_PREMATURE_CLOSE') return;
  console.error(`[workbuddy-http] unhandled rejection: ${reason?.stack ?? reason}`);
});

server.listen(PORT, HOST, async () => {
  console.error(`[workbuddy-http] listening on http://${HOST}:${PORT}`);
  console.error(`[workbuddy-http]   Anthropic : POST http://${HOST}:${PORT}/v1/messages`);
  console.error(`[workbuddy-http]   OpenAI    : POST http://${HOST}:${PORT}/v1/chat/completions`);
  console.error(`[workbuddy-http]   Responses : POST http://${HOST}:${PORT}/v1/responses`);
  console.error(`[workbuddy-http]   Models    : GET  http://${HOST}:${PORT}/v1/models`);
  console.error(`[workbuddy-http]   Health    : GET  http://${HOST}:${PORT}/health`);
  console.error(`[workbuddy-http]   Refresh   : POST http://${HOST}:${PORT}/refresh`);

  // Report what was actually detected, so "which quota is being spent" is
  // visible at startup rather than discovered later from an unexpected bill.
  try {
    const registry = await getProviders({ refresh: true });
    for (const entry of registry.entries) {
      if (entry.available) {
        console.error(
          `[workbuddy-http] provider ${entry.edition}: OK  domain=${entry.domain} ` +
            `default=${defaultModelFor(entry)}`,
        );
      } else {
        console.error(`[workbuddy-http] provider ${entry.edition}: unavailable — ${entry.error}`);
      }
    }
    if (registry.defaultEdition !== undefined) {
      console.error(`[workbuddy-http] active provider: ${registry.defaultEdition}`);
    } else {
      console.error('[workbuddy-http] WARNING: no usable account detected; requests will fail.');
    }
  } catch (error) {
    console.error(`[workbuddy-http] provider detection failed: ${error?.message ?? error}`);
  }

  // State the two things a first-time user gets wrong: this process must keep
  // running, and requests come from a second terminal.
  console.error('[workbuddy-http]');
  console.error('[workbuddy-http] Ready. Leave this window open — closing it stops the bridge.');
  console.error(`[workbuddy-http] Query it from another terminal, e.g.:`);
  console.error(`[workbuddy-http]   curl http://${HOST}:${PORT}/health`);
  console.error(`[workbuddy-http]   curl http://${HOST}:${PORT}/v1/models`);
  console.error('[workbuddy-http] Press Ctrl+C to stop.');
});
