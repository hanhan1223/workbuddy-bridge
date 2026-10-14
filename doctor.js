#!/usr/bin/env node
/**
 * Standalone diagnostic: inspect this computer and report which WorkBuddy
 * editions can actually serve requests here.
 *
 * Run with `node doctor.js`. Add `--refresh` to also force a token refresh, and
 * `--json` for machine-readable output.
 *
 * The distinction this script exists to make: "the app is installed" and "this
 * bridge can use it" are different facts. A binary can be present while the app
 * was never logged in, or while its at-rest key has rotated. Only the second
 * fact matters, so every check below runs end-to-end rather than looking for
 * files and stopping.
 */

import { existsSync } from 'node:fs';
import { homedir, release, arch, cpus, totalmem, freemem, platform } from 'node:os';
import { join } from 'node:path';

import { describeDiscovery, EDITION_LABEL } from './locate.js';
import { getProviders, refreshProvider, getModels, invalidateCaches } from './providers.js';
import { chat } from './upstream.js';
import { probeModels, looksChatCapable } from './probe.js';

/** Parse `--refresh` / `--json` / `--help` / `--probe-models[=N]` / `--model=id`. */
function parseArgs(argv) {
  const opts = { refresh: false, json: false, help: false, probeModels: false, probeLimit: undefined, model: undefined };
  for (const arg of argv) {
    if (arg === '--refresh' || arg === '-r') opts.refresh = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--probe-models') opts.probeModels = true;
    else if (arg.startsWith('--probe-models=')) {
      opts.probeModels = true;
      const n = Number(arg.slice('--probe-models='.length));
      if (Number.isInteger(n) && n > 0) opts.probeLimit = n;
      else console.error(`--probe-models expects a positive count, got "${arg}"`);
    } else if (arg.startsWith('--model=')) {
      const id = arg.slice('--model='.length).trim();
      if (id !== '') {
        opts.probeModels = true;
        opts.model = id;
      }
    } else console.error(`unknown option: ${arg}`);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  console.log(`workbuddy-doctor — check this machine for a usable WorkBuddy account

Usage
  workbuddy-doctor [options]        (installed via npm)
  node doctor.js [options]          (from a cloned checkout)

Options
  --refresh, -r        Force a token refresh for every detected edition
  --probe-models[=N]   Test which listed models actually answer a chat request
                       (default: first ${20} likely-chat ids; each probe spends quota)
  --model=<id>         Probe a single model id, e.g. --model=deepseek-v4.1-flash
  --json               Emit the report as JSON
  -h, --help           Show this help

Checks performed
  1. Node.js version and host platform
  2. Environment overrides that affect discovery
  3. Both editions: executable discovery (env / install root / registry / cache)
  4. Both editions: credential decrypt + account identity
  5. Both editions: live model catalog fetch
  6. Live chat round-trip against the active provider
  7. With --probe-models: which catalog entries are really callable

Why probing matters
  The catalog from /v3/config is the account's whole roster, and it mixes real
  chat models with completion-only, small-parameter, and image entries. Those
  exist in the list but fail with 11102/11103 when a chat request uses them,
  so being listed does not mean being usable.`);
  process.exit(0);
}

/** Collected report; printed as text or JSON at the end. */
const DEFAULT_PORT = 8799;

const report = {
  machine: {},
  environment: {},
  editions: [],
  checks: [],
  ok: false,
};

function check(name, passed, detail) {
  report.checks.push({ name, passed, detail });
  return passed;
}

if (!opts.json) {
  console.log('=== Machine ===');
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
const nodeOk = nodeMajor >= 20;
report.machine = {
  node: process.versions.node,
  platform: platform(),
  release: release(),
  arch: arch(),
  cpus: cpus().length,
  memoryGB: Number((totalmem() / 1024 ** 3).toFixed(1)),
  freeMemoryGB: Number((freemem() / 1024 ** 3).toFixed(1)),
  localAppData: process.env.LOCALAPPDATA ?? null,
  dshHome: process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'),
};

if (!opts.json) {
  console.log(`  node              ${process.versions.node}${nodeOk ? '' : '  (needs 20+)'}`);
  console.log(`  os                ${platform()} ${release()} ${arch()}`);
  console.log(`  cpu / memory      ${report.machine.cpus} cores, ${report.machine.memoryGB} GB total, ${report.machine.freeMemoryGB} GB free`);
  console.log(`  LOCALAPPDATA      ${report.machine.localAppData ?? '(not set)'}`);
  console.log(`  DSH_HOME          ${report.machine.dshHome}`);
}
check('node version >= 20', nodeOk, process.versions.node);

// The bridge runs only on Windows today: discovery reads the Windows uninstall
// registry and both apps are Electron/Windows builds.
const windows = platform() === 'win32';
check('windows platform', windows, platform());

if (!opts.json) {
  console.log('');
  console.log('=== Environment overrides ===');
}

const OVERRIDE_VARS = [
  'WORKBUDDY_AI_ELECTRON_BIN',
  'WORKBUDDY_ELECTRON_BIN',
  'WORKBUDDY_AI_AUTH_FILE',
  'WORKBUDDY_AUTH_FILE',
  'WORKBUDDY_EDITION',
  'WORKBUDDY_MODEL',
  'WORKBUDDY_CLIENT_ID',
  'WORKBUDDY_MCP_PORT',
];
for (const name of OVERRIDE_VARS) {
  const value = process.env[name]?.trim();
  report.environment[name] = value ?? null;
  if (!opts.json) {
    const shown = value === undefined ? '(not set)' : value;
    const exists = value !== undefined && (name.includes('BIN') || name.includes('FILE')) && !existsSync(value);
    console.log(`  ${name.padEnd(26)} ${shown}${exists ? '   <-- path does not exist!' : ''}`);
  }
}

if (!opts.json) {
  console.log('');
  console.log('=== Locating the WorkBuddy apps ===');
}

const discovery = describeDiscovery({ refresh: true });

for (const entry of discovery.editions) {
  const out = {
    edition: entry.edition,
    label: entry.label,
    overrideVar: entry.overrideVar,
    override: entry.override,
    strategies: entry.strategies,
    resolved: entry.resolved,
    layout: entry.layout,
    error: entry.error,
  };
  report.editions.push(out);

  if (opts.json) continue;

  console.log(`  [${entry.edition}] ${entry.label}`);
  console.log(`    ${entry.overrideVar.padEnd(24)} ${entry.override ?? '(not set)'}`);
  if (entry.overrideError) console.log(`    override error        ${entry.overrideError}`);

  for (const s of entry.strategies) {
    if (s.error) {
      console.log(`    ${s.name.padEnd(20)} error: ${s.error}`);
    } else if (s.found.length === 0) {
      console.log(`    ${s.name.padEnd(20)} no match`);
    } else {
      for (const f of s.found) console.log(`    ${s.name.padEnd(20)} ${f.path}  (${f.how})`);
    }
  }

  if (entry.error) {
    console.log(`    resolved             (none) — ${entry.error}`);
  } else {
    console.log(`    resolved             ${entry.resolved}`);
    console.log(
      `    layout               version=${entry.layout?.hasVersionFile} app.asar=${entry.layout?.hasAppAsar}`,
    );
  }
  console.log('');
}

if (!opts.json) {
  console.log('=== Checking credentials ===');
}

invalidateCaches();
const registry = await getProviders({ refresh: true });

for (const entry of registry.entries) {
  const record = report.editions.find((e) => e.edition === entry.edition);
  record.available = entry.available;
  record.domain = entry.domain;
  record.uid = entry.uid;
  record.defaultModel = entry.defaultModel;
  record.authFile = entry.authFile;
  record.expiresAt = entry.expiresAt;
  record.error = entry.error;

  if (opts.json) continue;

  console.log(`  [${entry.edition}] ${entry.label}`);
  if (entry.authFile) console.log(`    auth file            ${entry.authFile}`);
  if (entry.available) {
    console.log('    status               decrypted OK');
    console.log(`    uid                  ${entry.uid || '(none)'}`);
    console.log(`    domain               ${entry.domain}`);
    console.log(
      `    token expires        ${
        entry.expiresAt !== undefined ? new Date(entry.expiresAt).toISOString() : 'unknown'
      }`,
    );
    console.log(`    default model        ${entry.defaultModel}`);
  } else {
    console.log(`    status               unavailable — ${entry.error}`);
  }
  console.log('');
}

const usable = registry.availableEditions;
check('at least one usable edition', usable.length > 0, usable.join(', ') || '(none)');

if (usable.length === 0) {
  if (!opts.json) {
    console.error('No usable WorkBuddy account was found.');
    console.error('Install and log into the WorkBuddy desktop app, then run this again.');
  }
  report.ok = false;
  await finish();
}

if (!opts.json) {
  console.log('=== Fetching model catalog ===');
}

for (const entry of registry.available) {
  const record = report.editions.find((e) => e.edition === entry.edition);
  try {
    const models = await getModels(entry.edition);
    record.models = models.length;
    record.modelSample = models.slice(0, 8).map((m) => m.id);
    if (!opts.json) {
      console.log(`  [${entry.edition}] ${models.length} models`);
      for (const m of models.slice(0, 8)) {
        console.log(`     - ${m.id}${m.name && m.name !== m.id ? ` — ${m.name}` : ''}`);
      }
      if (models.length > 8) console.log(`     ... and ${models.length - 8} more`);
    }
    check(`model catalog (${entry.edition})`, true, `${models.length} models`);
  } catch (error) {
    record.modelError = String(error?.message ?? error);
    if (!opts.json) console.error(`  [${entry.edition}] FAILED: ${error.message}`);
    check(`model catalog (${entry.edition})`, false, String(error?.message ?? error));
  }
}

// Probing is opt-in because every probe is a real request against the account's
// quota; a plain doctor run must stay free.
if (opts.probeModels) {
  if (!opts.json) {
    console.log('');
    console.log('=== Probing which models actually respond ===');
  }

  for (const entry of registry.available) {
    const record = report.editions.find((e) => e.edition === entry.edition);
    let probe;
    try {
      probe = await probeModels(entry.edition, {
        refresh: true,
        limit: opts.probeLimit ?? 20,
        only: opts.model,
      });
    } catch (error) {
      record.probe = { error: String(error?.message ?? error) };
      if (!opts.json) console.error(`  [${entry.edition}] FAILED: ${error.message}`);
      check(`model probe (${entry.edition})`, false, String(error?.message ?? error));
      continue;
    }

    const usable = probe.results.filter((r) => r.ok === true);
    const unusable = probe.results.filter((r) => r.ok === false);
    const unknown = probe.results.filter((r) => r.ok === null);

    record.probe = {
      total: probe.total,
      probed: probe.probed,
      usable: usable.map((r) => r.model),
      unusable: unusable.map((r) => ({ model: r.model, reason: r.reason })),
      unknown: unknown.map((r) => r.model),
    };

    if (opts.json) continue;

    // A requested id that is absent from this account's catalog is almost always
    // a model name borrowed from the other edition, which is worth saying
    // outright rather than printing "0 probed".
    if (probe.notInCatalog !== undefined) {
      const nearby = (await getModels(entry.edition))
        .map((m) => m.id)
        .filter((id) => id.includes(probe.notInCatalog.slice(0, 4)))
        .slice(0, 6);
      console.log(
        `  [${entry.edition}] "${probe.notInCatalog}" is not in this account's catalog (${probe.total} models).`,
      );
      if (nearby.length > 0) console.log(`     similar ids here: ${nearby.join(', ')}`);
      console.log('     model ids are not shared between the international and China editions.');
      check(`model probe (${entry.edition})`, false, `"${probe.notInCatalog}" not in catalog`);
      continue;
    }

    console.log(
      `  [${entry.edition}] probed ${probe.probed} of ${probe.total} — ` +
        `${usable.length} usable, ${unusable.length} unusable` +
        (unknown.length > 0 ? `, ${unknown.length} undetermined` : ''),
    );

    if (usable.length > 0) {
      console.log('     usable:');
      for (const r of usable) console.log(`       ✓ ${r.model.padEnd(24)} ${r.ms}ms`);
    }
    if (unusable.length > 0) {
      console.log('     unusable (listed but not callable):');
      for (const r of unusable) {
        console.log(`       ✗ ${r.model.padEnd(24)} ${r.reason}${r.detail ? ` — ${r.detail.slice(0, 70)}` : ''}`);
      }
    }
    if (unknown.length > 0) {
      console.log('     undetermined (upstream was busy, retry later):');
      for (const r of unknown) console.log(`       ? ${r.model}`);
    }

    const hinted = probe.results.filter((r) => looksChatCapable(r.model) && r.ok === false);
    if (hinted.length > 0) {
      console.log(
        `     note: ${hinted.map((r) => r.model).join(', ')} look chat-capable but failed; ` +
          'this may be an account entitlement rather than a model-shape problem.',
      );
    }

    check(
      `model probe (${entry.edition})`,
      usable.length > 0,
      `${usable.length} usable of ${probe.probed} probed`,
    );
  }
}

// Refresh is opt-in by default: it consumes a round-trip against the auth
// server and, when the client id is not configured, is expected to fail.
if (opts.refresh) {
  if (!opts.json) {
    console.log('');
    console.log('=== Refreshing tokens ===');
  }
  const results = await refreshProvider();
  const registryAfter = await getProviders({ refresh: true });
  for (const r of results) {
    const record = report.editions.find((e) => e.edition === r.edition);
    record.refresh = { ok: r.ok, reason: r.reason, expiresAt: r.expiresAt };
    if (!opts.json) {
      console.log(
        `  [${r.edition}] ${r.ok ? 'refreshed OK' : `refresh failed — ${r.reason}`}` +
          (r.ok && r.expiresAt !== undefined ? `, new expiry ${new Date(r.expiresAt).toISOString()}` : ''),
      );
    }
    if (!r.ok && !opts.json) {
      console.log(
        `     hint: set WORKBUDDY_CLIENT_ID to the OAuth client id, or open the ` +
          `${EDITION_LABEL[r.edition]} app once to re-login.`,
      );
    }
    check(`token refresh (${r.edition})`, r.ok === true, r.reason ?? 'ok');
  }
  report.availableAfterRefresh = registryAfter.availableEditions;
}

if (!opts.json) {
  console.log('');
  console.log('=== Live chat round-trip ===');
}

const active = registry.available.find((e) => e.edition === registry.defaultEdition);
report.activeEdition = registry.defaultEdition;

if (active !== undefined) {
  try {
    const started = Date.now();
    const result = await chat(
      {
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Reply with exactly: DOCTOR_OK' },
        ],
        model: active.defaultModel,
      },
      { edition: active.edition },
    );
    const elapsed = Date.now() - started;
    const reply = result.text.trim();
    report.chat = { edition: active.edition, model: active.defaultModel, reply, ms: elapsed };
    if (!opts.json) {
      console.log(`  edition            ${active.edition} (${active.domain})`);
      console.log(`  model              ${active.defaultModel}`);
      console.log(`  reply              ${JSON.stringify(reply.slice(0, 120))}`);
      console.log(`  elapsed            ${elapsed} ms`);
    }
    check('live chat round-trip', reply !== '', reply.slice(0, 80));
  } catch (error) {
    report.chat = { edition: active.edition, error: String(error?.message ?? error) };
    if (!opts.json) console.error(`  FAILED: ${error.message}`);
    check('live chat round-trip', false, String(error?.message ?? error));
  }
}

report.ok = report.checks.every((c) => c.passed);
await finish();

async function finish() {
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  }

  console.log('');
  console.log('=== Summary ===');
  if (usable.length > 0) {
    console.log(`  detected editions    ${usable.join(', ')}`);
    console.log(`  active edition       ${registry.defaultEdition} (${EDITION_LABEL[registry.defaultEdition]})`);
  }

  // Say whether the server is actually up.
  //
  // A bare "all checks passed" reads as "everything is ready to use", which is
  // how people end up curling port 8799 against a process they never started.
  // This command only proves the account and the pipeline work; serving needs a
  // separate long-running process, so name that explicitly.
  const running = await isServerRunning();
  if (running !== undefined) {
    console.log('');
    console.log(`  server               running on http://127.0.0.1:${running.port}`);
    if (running.edition !== undefined) {
      console.log(`  serving edition      ${running.edition}`);
    }
    console.log('                       endpoints are ready to use.');
  }

  const failed = report.checks.filter((c) => !c.passed);
  if (report.ok && running === undefined) {
    console.log('');
    console.log('  All checks passed — the account and pipeline work.');
    console.log('');
    console.log('  This command does NOT start the server. It exits when it finishes.');
    console.log('  To use the API, start the server and leave that terminal open:');
    console.log('');
    console.log('      workbuddy-bridge');
    console.log('');
    console.log(`  Then query it from another terminal, e.g.:`);
    console.log(`      curl http://127.0.0.1:${DEFAULT_PORT}/v1/models`);
  } else if (report.ok) {
    console.log('  All checks passed.');
  } else {
    console.log(`  ${failed.length} check(s) failed:`);
    for (const f of failed) console.log(`    - ${f.name}: ${f.detail}`);
  }
  process.exit(report.ok ? 0 : 1);
}

/**
 * Is a bridge already listening?
 *
 * Returns `{ port, edition }` when one answers, otherwise undefined. Any failure
 * means "no server", which is the expected state and must not fail the run.
 */
async function isServerRunning() {
  const port = Number(process.env.WORKBUDDY_MCP_PORT ?? '') || DEFAULT_PORT;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return { port };
    const body = await response.json();
    return { port, edition: body.defaultEdition ?? body.provider };
  } catch {
    return undefined;
  }
}
