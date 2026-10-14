/**
 * Locate the WorkBuddy desktop executables — BOTH editions.
 *
 * There are two products that look almost identical and are easy to confuse:
 *
 *   international (AI)  WorkBuddyAI.exe   workbuddy.ai   auth: workbuddy-desktop-ai.info
 *   China         (CN)  WorkBuddy.exe    workbuddy.cn   auth: workbuddy-desktop.info
 *
 * They can be installed side by side and, crucially, they belong to DIFFERENT
 * accounts. Pointing the bridge at the wrong one silently spends the wrong
 * quota, so this module never guesses: it classifies every candidate by the
 * executable name and by the uninstall entry's DisplayName, and reports what
 * it found instead of collapsing the answer to a single path.
 *
 * Both editions store their tokens encrypted at rest and both expose the same
 * private Electron binding, so each one can only be unwrapped by spawning its
 * OWN binary. Discovery therefore has to find the specific binary that belongs
 * to the edition being used — finding "a WorkBuddy" is not enough.
 *
 * Discovery chain, most specific first:
 *
 *   1. explicit env overrides   — WORKBUDDY_AI_ELECTRON_BIN / WORKBUDDY_ELECTRON_BIN
 *   2. conventional install roots — %LOCALAPPDATA%\Programs, Program Files, ...
 *   3. Windows uninstall registry — DisplayIcon of a matching product entry
 *   4. a saved cache             — the last binary that actually worked
 *
 * Every candidate is validated before it is accepted. Ambiguity within ONE
 * edition is an error (the caller must disambiguate); ambiguity BETWEEN
 * editions is not, because that is the normal dual-install case.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** The two editions, in priority order. */
export const EDITIONS = ['ai', 'cn'];

/** Human-readable labels used in diagnostics. */
export const EDITION_LABEL = {
  ai: 'international (workbuddy.ai)',
  cn: 'China (workbuddy.cn)',
};

/** Executable names each edition has shipped under. */
const AI_EXE_NAMES = ['workbuddyai.exe'];
const CN_EXE_NAMES = ['workbuddy.exe'];

/** A build that ships the product name verbatim, e.g. "WorkBuddy AI.exe". */
const VERBATIM_AI_EXE = /^workbuddy[\s_.-]*ai\.exe$/iu;

/** Where each edition installs, relative to a root directory. */
const INSTALL_SUBPATHS = {
  ai: [['Programs', 'WorkBuddy AI'], ['Programs', 'WorkBuddyAI'], ['WorkBuddy AI'], ['WorkBuddyAI']],
  cn: [['Programs', 'WorkBuddy'], ['WorkBuddy']],
};

/** Matches a product DisplayName belonging to each edition. */
const AI_DISPLAY_NAME = /^WorkBuddy\s*AI\b/iu;
/** "WorkBuddy" not followed by "AI" — the CN product. */
const CN_DISPLAY_NAME = /^WorkBuddy(?!\s*AI)/iu;

const UNINSTALL_ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

/** The env var that overrides discovery for each edition. */
export function overrideEnvVar(edition) {
  return edition === 'ai' ? 'WORKBUDDY_AI_ELECTRON_BIN' : 'WORKBUDDY_ELECTRON_BIN';
}

/**
 * Classify a path as one edition or the other.
 * Returns 'ai', 'cn', or 'unknown'.
 */
export function classifyBinary(path) {
  if (typeof path !== 'string') return 'unknown';
  const name = basename(path).trim().toLowerCase();
  if (CN_EXE_NAMES.includes(name)) return 'cn';
  if (AI_EXE_NAMES.includes(name)) return 'ai';
  if (VERBATIM_AI_EXE.test(name)) return 'ai';
  return 'unknown';
}

/**
 * Validate a candidate path for a given edition.
 *
 * Returns the path when it is a usable binary of that edition, otherwise
 * `undefined`. The companion `version` / `resources\app.asar` files are strong
 * signals but not required: a build that lacks them can still be the real app,
 * and rejecting it would recreate the very failure this module exists to fix.
 */
export function validateCandidate(path, edition) {
  if (typeof path !== 'string' || path.trim() === '') return undefined;
  const trimmed = path.trim();
  if (!/\.exe$/iu.test(trimmed)) return undefined;

  // Reject the other edition before touching the filesystem. This is the one
  // check that must never be skipped: the two apps coexist on real machines.
  const kind = classifyBinary(trimmed);
  if (kind !== 'unknown' && kind !== edition) return undefined;

  try {
    if (!statSync(trimmed).isFile()) return undefined;
  } catch {
    return undefined;
  }

  // Command-line switches or icon indices must not survive into a spawn.
  return trimmed.replace(/,\d+$/u, '');
}

/** Interpret the layout beside an exe as supporting evidence. */
export function describeLayout(exePath) {
  const dir = join(exePath, '..');
  return {
    hasVersionFile: existsSync(join(dir, 'version')),
    hasAppAsar: existsSync(join(dir, 'resources', 'app.asar')),
  };
}

/** Strategy 2: conventional install locations under the usual roots. */
function fromInstallRoots(edition) {
  const roots = [
    process.env.LOCALAPPDATA,
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
    process.env.ProgramW6432,
  ].filter((r) => typeof r === 'string' && r.trim() !== '');

  const exeNames = edition === 'ai' ? ['WorkBuddyAI.exe', 'WorkBuddy AI.exe'] : ['WorkBuddy.exe'];
  const found = [];
  for (const root of roots) {
    for (const sub of INSTALL_SUBPATHS[edition]) {
      for (const exe of exeNames) {
        const candidate = validateCandidate(join(root, ...sub, exe), edition);
        if (candidate !== undefined) found.push({ path: candidate, how: `install root: ${root}` });
      }
    }
  }
  return found;
}

/**
 * Read one uninstall root as JSON, tolerating every kind of unreadable root.
 *
 * The script is passed as `-EncodedCommand` (UTF-16LE base64) rather than as
 * command text. Passing it as text lets PowerShell's own argument parsing
 * strip the inner quotes, turning `GetValue("DisplayName")` into
 * `GetValue(DisplayName)` — a parse error that silently produces "no products
 * found" and makes discovery look like it failed when the app is installed.
 * Encoding sidesteps quoting entirely.
 */
function readUninstallRoot(root) {
  const script = [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8;',
    '$Root=$env:WB_UNINSTALL_ROOT;',
    '$path="Registry::"+$Root;',
    'if (-not (Test-Path -LiteralPath $path)) { exit 2 };',
    'try { $k=Get-Item -LiteralPath $path -ErrorAction Stop } catch { exit 3 };',
    '$out=@();',
    'foreach ($n in $k.GetSubKeyNames()) {',
    '  try { $p=$k.OpenSubKey($n) } catch { continue };',
    '  if ($null -eq $p) { continue };',
    '  $d=$p.GetValue("DisplayName"); $i=$p.GetValue("DisplayIcon");',
    '  if ($null -ne $d -or $null -ne $i) {',
    '    $out += [pscustomobject]@{ displayName=[string]$d; displayIcon=[string]$i }',
    '  }',
    '};',
    'ConvertTo-Json -InputObject @($out) -Compress -Depth 3',
  ].join('\n');

  const powershell = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );

  // -EncodedCommand takes UTF-16LE base64 and needs no quoting or escaping.
  // The root travels in an environment variable because -EncodedCommand cannot
  // be combined with positional script arguments.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');

  const stdout = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, WB_UNINSTALL_ROOT: root },
  });

  const text = String(stdout).trim();
  if (text === '') return [];

  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Strip a `"path,index"` / `path,index` DisplayIcon value down to its path. */
function parseDisplayIcon(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') return undefined;
  const quoted = /^"([^"]+)"/u.exec(raw);
  const path = quoted !== null ? quoted[1] : raw.replace(/,\d+$/u, '');
  const cleaned = path.trim().replace(/,\d+$/u, '');
  return /\.exe$/iu.test(cleaned) ? cleaned : undefined;
}

/** Strategy 3: the Windows uninstall registry. */
function fromRegistry(edition) {
  const wanted = edition === 'ai' ? AI_DISPLAY_NAME : CN_DISPLAY_NAME;
  const rejected = edition === 'ai' ? CN_DISPLAY_NAME : AI_DISPLAY_NAME;

  const found = [];
  for (const root of UNINSTALL_ROOTS) {
    let entries;
    try {
      entries = readUninstallRoot(root);
    } catch {
      // A missing or unreadable root only removes one source of candidates;
      // other strategies still run, so this is never fatal.
      continue;
    }

    for (const entry of entries) {
      const name = String(entry?.displayName ?? '').trim();
      if (name === '') continue;
      // The other edition (or another vendor's product) is not our business here.
      if (rejected.test(name)) continue;
      if (!wanted.test(name)) continue;

      const icon = parseDisplayIcon(entry?.displayIcon);
      if (icon === undefined) continue;
      const candidate = validateCandidate(icon, edition);
      if (candidate !== undefined) found.push({ path: candidate, how: `registry: ${name}` });
    }
  }
  return found;
}

/** One cache file per edition: they are different binaries. */
function cachePath(edition) {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  return join(home, `.workbuddy-${edition}-electron.json`);
}

/** Strategy 4: the last binary of this edition that successfully decrypted a token. */
function fromCache(edition) {
  try {
    const saved = JSON.parse(readFileSync(cachePath(edition), 'utf8'));
    const candidate = validateCandidate(saved?.path, edition);
    if (candidate === undefined) return [];
    return [{ path: candidate, how: 'cache' }];
  } catch {
    return [];
  }
}

/** Record a binary that worked, so later runs can skip the search. */
export function rememberElectronPath(path) {
  const kind = classifyBinary(path);
  if (kind !== 'ai' && kind !== 'cn') return;
  const candidate = validateCandidate(path, kind);
  if (candidate === undefined) return;
  try {
    const file = cachePath(kind);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ path: candidate, savedAt: Date.now() }, null, 2)}\n`);
  } catch {
    // A cache that cannot be written must never break the request.
  }
}

/** Strategy 1: an explicit override for this edition. */
function fromOverride(edition) {
  const varName = overrideEnvVar(edition);
  const override = process.env[varName]?.trim();
  if (!override) return { varName, value: null, found: [] };

  const kind = classifyBinary(override);
  const other = edition === 'ai' ? 'cn' : 'ai';
  if (kind !== 'unknown' && kind !== edition) {
    return {
      varName,
      value: override,
      error:
        `${varName} points at the ${EDITION_LABEL[kind]} app ("${override}"). ` +
        `That is the ${other.toUpperCase()} binary; the ${edition.toUpperCase()} edition uses a different ` +
        'credential file and a different quota. Point it at the correct executable instead.',
      found: [],
    };
  }

  const candidate = validateCandidate(override, edition);
  if (candidate === undefined) {
    return {
      varName,
      value: override,
      error:
        `${varName} is set to "${override}", but no usable executable is there. ` +
        'Check the path, or unset the variable to let discovery find the app.',
      found: [],
    };
  }
  return { varName, value: override, found: [{ path: candidate, how: `${varName}` }] };
}

const strategyList = [
  ['install root', fromInstallRoots],
  ['registry', fromRegistry],
  ['cache', fromCache],
];

/** De-duplicate candidates, keeping the first `how` for each path. */
function uniquePaths(results) {
  return [...new Map(results.map((r) => [r.path.toLowerCase(), r])).values()];
}

const cache = new Map();

/**
 * Locate one edition's executable.
 *
 * Returns the path, or throws with a message naming every strategy tried.
 * Ambiguity within an edition is an error: two installs of the same product
 * mean the caller cannot know which account it would use.
 */
export function findElectronBinary(edition, { refresh = false } = {}) {
  if (!refresh && cache.has(edition)) return cache.get(edition);

  const override = fromOverride(edition);
  if (override.error) throw new Error(override.error);
  if (override.found.length > 0) {
    cache.set(edition, override.found[0].path);
    return override.found[0].path;
  }

  const tried = [];
  for (const [label, strategy] of strategyList) {
    let results = [];
    try {
      results = strategy(edition);
    } catch {
      tried.push(`${label} (errored)`);
      continue;
    }

    const unique = uniquePaths(results);
    if (unique.length === 1) {
      cache.set(edition, unique[0].path);
      return unique[0].path;
    }
    if (unique.length > 1) {
      const listed = unique.map((r) => `  - ${r.path}  (${r.how})`).join('\n');
      throw new Error(
        `more than one ${EDITION_LABEL[edition]} install was found, so none was chosen:\n${listed}\n` +
          `Set ${overrideEnvVar(edition)} to the one to use.`,
      );
    }
    tried.push(label);
  }

  throw new Error(
    `Could not find the ${EDITION_LABEL[edition]} executable. Tried: ${tried.join(', ')}. ` +
      'Install the app, or set ' +
      `${overrideEnvVar(edition)} to its .exe` +
      (edition === 'ai'
        ? ' (for example "C:\\Program Files\\WorkBuddy AI\\WorkBuddyAI.exe").'
        : ' (for example "C:\\Program Files\\WorkBuddy\\WorkBuddy.exe").'),
  );
}

/**
 * Probe one edition without throwing.
 *
 * `available` is true only when a binary was found AND its credential file
 * exists AND the token decrypts — a binary alone is not a usable provider,
 * because the app may simply be installed but never logged in.
 */
function probeEdition(edition, { refresh = false } = {}) {
  const report = { edition, label: EDITION_LABEL[edition], path: undefined, layout: undefined, error: undefined, available: false };

  let path;
  try {
    path = findElectronBinary(edition, { refresh });
  } catch (error) {
    report.error = String(error?.message ?? error);
    return report;
  }
  report.path = path;
  report.layout = describeLayout(path);
  return report;
}

/**
 * Discover every installed edition.
 *
 * Returns `{ available: [...], all: [...] }` where each entry carries the
 * edition, the resolved binary path, and — when credentials were checked —
 * whether it is actually usable. Ordered by edition priority (AI first).
 */
export function discoverEditions({ refresh = false } = {}) {
  const all = EDITIONS.map((edition) => probeEdition(edition, { refresh }));
  return { all, available: all.filter((e) => e.error === undefined) };
}

/** Diagnostic view of discovery, used by doctor.js. */
export function describeDiscovery({ refresh = false } = {}) {
  const report = { editions: [] };

  for (const edition of EDITIONS) {
    const entry = { edition, label: EDITION_LABEL[edition] };

    const override = fromOverride(edition);
    entry.overrideVar = override.varName;
    entry.override = override.value;
    if (override.error) entry.overrideError = override.error;

    entry.strategies = [];
    for (const [label, strategy] of strategyList) {
      try {
        const unique = uniquePaths(strategy(edition));
        entry.strategies.push({ name: label, found: unique.map((r) => ({ path: r.path, how: r.how })) });
      } catch (error) {
        entry.strategies.push({ name: label, error: String(error?.message ?? error) });
      }
    }

    const probe = probeEdition(edition, { refresh });
    entry.resolved = probe.path;
    entry.layout = probe.layout;
    entry.error = probe.error;

    report.editions.push(entry);
  }

  return report;
}

/** Forget cached resolutions — used by the doctor's --refresh flag. */
export function clearCache() {
  cache.clear();
}
