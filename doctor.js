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

/** Parse `--refresh` / `--json` / `--help`. */
function parseArgs(argv) {
  const opts = { refresh: false, json: false, help: false };
  for (const arg of argv) {
    if (arg === '--refresh' || arg === '-r') opts.refresh = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else console.error(`unknown option: ${arg}`);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  console.log(`workbuddy-bridge doctor — check this machine for a usable WorkBuddy account

Usage
  node doctor.js [options]

Options
  --refresh, -r    Force a token refresh for every detected edition
  --json           Emit the report as JSON
  -h, --help       Show this help

Checks performed
  1. Node.js version and host platform
  2. Environment overrides that affect discovery
  3. Both editions: executable discovery (env / install root / registry / cache)
  4. Both editions: credential decrypt + account identity
  5. Both editions: live model catalog fetch
  6. Live chat round-trip against the active provider`);
  process.exit(0);
}

/** Collected report; printed as text or JSON at the end. */
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
  finish();
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
finish();

function finish() {
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
  const failed = report.checks.filter((c) => !c.passed);
  if (report.ok) {
    console.log('  All checks passed. The bridge should work.');
  } else {
    console.log(`  ${failed.length} check(s) failed:`);
    for (const f of failed) console.log(`    - ${f.name}: ${f.detail}`);
  }
  process.exit(report.ok ? 0 : 1);
}
