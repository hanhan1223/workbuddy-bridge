#!/usr/bin/env node
/**
 * WorkBuddy MCP bridge — both editions.
 *
 * Exposes the local WorkBuddy account's chat quota to any MCP client
 * (Claude Code, DSH, ...) as a set of tools. The edition is detected from the
 * machine: the international app when present, otherwise the China one. When
 * both are available both are listed and each tool call can name its edition.
 *
 * Everything is stdio JSON-RPC, so the client launches this as a subprocess.
 * Diagnostics go to stderr ONLY — stdout is the protocol channel and any stray
 * byte there corrupts the session.
 */

import { getProviders, resolveProvider, refreshProvider, getModels, invalidateCaches } from './providers.js';
import { chat } from './upstream.js';
import { probeModels, clearProbeCache } from './probe.js';

// The MCP SDK is an optional dependency: the HTTP server in this package has
// no external dependencies at all, so installing the package does not pull it
// in. Importing it lazily lets MCP users get a clear instruction instead of an
// opaque module-resolution stack trace.
let Server;
let StdioServerTransport;
let CallToolRequestSchema;
let ListToolsRequestSchema;

try {
  ({ Server } = await import('@modelcontextprotocol/sdk/server/index.js'));
  ({ StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js'));
  ({ CallToolRequestSchema, ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js'));
} catch (error) {
  console.error('[workbuddy-bridge-mcp] The MCP mode needs @modelcontextprotocol/sdk, which is an');
  console.error('[workbuddy-bridge-mcp] optional dependency of this package. Install it with:');
  console.error('[workbuddy-bridge-mcp]');
  console.error('[workbuddy-bridge-mcp]     npm install @modelcontextprotocol/sdk');
  console.error('[workbuddy-bridge-mcp]');
  console.error('[workbuddy-bridge-mcp] Or use the HTTP server instead, which needs no dependencies:');
  console.error('[workbuddy-bridge-mcp]');
  console.error('[workbuddy-bridge-mcp]     npx workbuddy-bridge');
  console.error('[workbuddy-bridge-mcp]');
  console.error(`[workbuddy-bridge-mcp] (original error: ${error?.message ?? error})`);
  process.exit(1);
}

const server = new Server(
  { name: 'workbuddy', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

const EDITION_ARG = {
  type: 'string',
  enum: ['ai', 'cn'],
  description:
    'Which account to use: "ai" = international (workbuddy.ai), "cn" = China (workbuddy.cn). ' +
    'Omit to use the detected default.',
};

const TOOLS = [
  {
    name: 'workbuddy_ask',
    description:
      'Send a prompt to WorkBuddy and return its reply, consuming your WorkBuddy ' +
      'account quota. Use this to offload a question or task to a WorkBuddy model.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The user message to send.' },
        system: { type: 'string', description: 'Optional system prompt.' },
        model: {
          type: 'string',
          description: 'Model id. Omit to use the edition default.',
        },
        edition: EDITION_ARG,
        reasoning_effort: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'xhigh', 'max'],
          description: 'Optional reasoning effort, for models that support it.',
        },
        max_tokens: { type: 'number', description: 'Optional cap on generated tokens.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'workbuddy_models',
    description:
      'List the WorkBuddy models available to your account. The listing is the account ' +
      'roster, which includes some entries that cannot serve chat; use workbuddy_probe ' +
      'to find out which ones actually respond.',
    inputSchema: { type: 'object', properties: { edition: EDITION_ARG } },
  },
  {
    name: 'workbuddy_probe',
    description:
      'Test which WorkBuddy models actually answer a chat request, and return the usable ' +
      'ids. The catalog from /v3/config mixes real chat models with completion-only, ' +
      'small-parameter and image entries; those appear in workbuddy_models but fail with ' +
      '11102/11103 when used. Call this before choosing a model, or after a model fails. ' +
      'Each probe spends a small amount of account quota, so results are cached.',
    inputSchema: {
      type: 'object',
      properties: {
        edition: EDITION_ARG,
        model: {
          type: 'string',
          description:
            'Probe a single model id instead of the default sample, e.g. "deepseek-v4.1-flash".',
        },
        limit: {
          type: 'number',
          description: 'How many models to probe (default 20, max 50).',
        },
        refresh: {
          type: 'boolean',
          description: 'Ignore the cached probe results and measure again.',
        },
      },
    },
  },
  {
    name: 'workbuddy_status',
    description:
      'Check WorkBuddy connection status: which editions were detected, whether their ' +
      'credentials decrypt, and the account identity behind each.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'workbuddy_refresh',
    description:
      'Re-detect the installed WorkBuddy apps and refresh their access tokens. Use when ' +
      'a request fails with 401, or after installing/logging into an app while the bridge ' +
      'was already running.',
    inputSchema: { type: 'object', properties: { edition: EDITION_ARG } },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

/** Normalize an `edition` argument into 'ai' | 'cn' | undefined. */
function normalizeEdition(value) {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return v === 'ai' || v === 'cn' ? v : undefined;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    if (name === 'workbuddy_status') {
      const registry = await getProviders({ refresh: true });
      const lines = registry.entries.map((entry) => {
        if (!entry.available) {
          return `${entry.edition} (${entry.label}): unavailable — ${entry.error ?? 'unknown reason'}`;
        }
        const expires =
          entry.expiresAt !== undefined ? new Date(entry.expiresAt).toISOString() : 'unknown';
        return [
          `${entry.edition} (${entry.label}): connected`,
          `  domain: ${entry.domain}`,
          `  uid: ${entry.uid || '(none)'}`,
          `  default model: ${entry.defaultModel}`,
          `  token expires: ${expires}`,
          `  app: ${entry.path ?? '(unknown)'}`,
        ].join('\n');
      });
      const available = registry.availableEditions;
      lines.unshift(
        available.length === 0
          ? 'No usable WorkBuddy account detected.'
          : `Detected: ${available.join(', ')} — active: ${registry.defaultEdition}`,
      );
      return text(lines.join('\n'));
    }

    if (name === 'workbuddy_refresh') {
      invalidateCaches();
      clearProbeCache();
      const results = await refreshProvider(normalizeEdition(args.edition));
      const registry = await getProviders({ refresh: true });
      const lines = results.map((r) =>
        r.ok
          ? `${r.edition}: refreshed, expires ${new Date(r.expiresAt).toISOString()}`
          : `${r.edition}: refresh failed — ${r.reason}`,
      );
      lines.push(`Available now: ${registry.availableEditions.join(', ') || '(none)'}`);
      return text(lines.join('\n'), !results.some((r) => r.ok));
    }

    if (name === 'workbuddy_models') {
      const provider = await resolveProvider(normalizeEdition(args.edition));
      const models = await getModels(provider.edition);
      if (models.length === 0) return text('No models returned.');
      const lines = models.map((m) => {
        const label = m.name && m.name !== m.id ? ` — ${m.name}` : '';
        const ctx = m.contextWindow ? ` (ctx ${m.contextWindow})` : '';
        return `${m.id}${label}${ctx}`;
      });
      return text(
        `Edition: ${provider.edition} (${provider.domain})\n${lines.join('\n')}\n\n` +
          'Note: this is the account roster. Some entries cannot serve chat requests; ' +
          'call workbuddy_probe to find out which ones actually respond.',
      );
    }

    if (name === 'workbuddy_probe') {
      const provider = await resolveProvider(normalizeEdition(args.edition));
      const rawLimit = typeof args.limit === 'number' ? args.limit : undefined;
      const probe = await probeModels(provider.edition, {
        refresh: args.refresh === true,
        limit: rawLimit !== undefined ? Math.min(Math.max(1, Math.floor(rawLimit)), 50) : undefined,
        only: typeof args.model === 'string' && args.model !== '' ? args.model : undefined,
      });

      if (probe.notInCatalog !== undefined) {
        const ids = (await getModels(provider.edition)).map((m) => m.id);
        const nearby = ids.filter((id) => id.includes(probe.notInCatalog.slice(0, 4))).slice(0, 6);
        return text(
          `"${probe.notInCatalog}" is not in the ${provider.edition} catalog (${probe.total} models).` +
            (nearby.length > 0 ? `\nSimilar ids here: ${nearby.join(', ')}` : '') +
            '\nModel ids are not shared between the international and China editions.',
          true,
        );
      }

      const usable = probe.results.filter((r) => r.ok === true);
      const unusable = probe.results.filter((r) => r.ok === false);
      const unknown = probe.results.filter((r) => r.ok === null);

      const lines = [
        `Edition: ${provider.edition} — probed ${probe.probed} of ${probe.total}` +
          (probe.cached ? ' (cached)' : ''),
        '',
        `Usable (${usable.length}):`,
        ...usable.map((r) => `  ${r.model}  ${r.ms}ms`),
      ];
      if (unusable.length > 0) {
        lines.push('', `Unusable — listed but not callable (${unusable.length}):`);
        for (const r of unusable) lines.push(`  ${r.model}  ${r.reason}`);
      }
      if (unknown.length > 0) {
        lines.push(
          '',
          `Undetermined — upstream was busy, retry later (${unknown.length}):`,
          `  ${unknown.map((r) => r.model).join(', ')}`,
        );
      }
      return text(lines.join('\n'), usable.length === 0);
    }

    if (name === 'workbuddy_ask') {
      const prompt = typeof args.prompt === 'string' ? args.prompt : '';
      if (prompt.trim() === '') return text('Error: "prompt" is required.', true);

      const provider = await resolveProvider(normalizeEdition(args.edition));
      const messages = [];
      if (typeof args.system === 'string' && args.system.trim() !== '') {
        messages.push({ role: 'system', content: args.system });
      }
      messages.push({ role: 'user', content: prompt });

      const { text: answer, reasoning } = await chat(
        {
          messages,
          model: typeof args.model === 'string' && args.model !== '' ? args.model : provider.defaultModel,
          reasoning_effort: typeof args.reasoning_effort === 'string' ? args.reasoning_effort : undefined,
          max_tokens: typeof args.max_tokens === 'number' ? args.max_tokens : undefined,
        },
        { edition: provider.edition },
      );

      if (answer.trim() === '') {
        const note = reasoning.trim() !== '' ? '\n\n(model produced reasoning but no final text)' : '';
        return text(`WorkBuddy returned an empty response.${note}`, true);
      }
      return text(answer);
    }

    return text(`Unknown tool: ${name}`, true);
  } catch (error) {
    return text(`WorkBuddy error: ${error?.message ?? String(error)}`, true);
  }
});

function text(value, isError = false) {
  return { content: [{ type: 'text', text: String(value) }], isError };
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[workbuddy-mcp] ready on stdio');
