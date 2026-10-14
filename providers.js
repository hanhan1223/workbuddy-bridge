/**
 * Provider registry: which WorkBuddy editions this machine can actually serve.
 *
 * The point of this module is to turn "is the international app installed?" from
 * an assumption into a measurement. A provider is only reported as available
 * when all three things hold:
 *
 *   1. its executable was located,
 *   2. its credential file exists and decrypts, and
 *   3. it carries a usable access token.
 *
 * A binary that is installed but never logged in is NOT a provider — routing to
 * it would fail at request time with an error that has nothing to do with the
 * request. Checking up front is what makes the "prefer international, fall back
 * to China" rule safe rather than a guess.
 *
 * When both editions qualify, both are exposed and the caller can pick one per
 * request via an `edition` field or an `/ai/` `/cn/` URL prefix. The default is
 * the international edition, because its model roster is the one the original
 * bridge was built around; that is overridable with WORKBUDDY_EDITION.
 */

import { discoverEditions, EDITIONS, EDITION_LABEL } from './locate.js';
import { loadCredentials, editionDefaultModel, tryRefresh, desktopAuthPath } from './credentials.js';
import { listModels } from './upstream.js';

/** Default edition preference when both are installed. */
const DEFAULT_PRIORITY = ['ai', 'cn'];

/** Cache of the last successful discovery, keyed by nothing (process-lifetime). */
let registryCache;
let registryCacheAt = 0;
const REGISTRY_TTL_MS = 60 * 1000;

/**
 * Probe one edition end-to-end: binary → credential → token.
 * Never throws; the failure is recorded on the entry.
 */
async function probeEdition(edition, { refresh = false } = {}) {
  const entry = {
    edition,
    label: EDITION_LABEL[edition],
    path: undefined,
    authFile: undefined,
    credential: undefined,
    error: undefined,
    available: false,
  };

  const discovery = refresh ? discoverEditions({ refresh: true }) : undefined;
  const located = discovery?.all.find((e) => e.edition === edition);

  if (located?.error) {
    entry.error = located.error;
    return entry;
  }
  if (located?.path) entry.path = located.path;

  try {
    entry.authFile = desktopAuthPath(edition);
  } catch (error) {
    entry.error = String(error?.message ?? error);
    return entry;
  }

  try {
    const credential = await loadCredentials(edition);
    entry.credential = credential;
    entry.path = credential.path ? entry.path : entry.path;
    entry.uid = credential.uid;
    entry.domain = credential.domain;
    entry.expiresAt = credential.expiresAt;
    entry.refreshExpiresAt = credential.refreshExpiresAt;
    entry.defaultModel = editionDefaultModel(edition);
    entry.available = true;
    if (located?.path) entry.path = located.path;
  } catch (error) {
    entry.error = String(error?.message ?? error);
  }

  return entry;
}

/**
 * Discover and validate every edition.
 *
 * `refresh: true` forces re-discovery (used by the doctor and by
 * `POST /refresh`), skipping both the discovery cache and the install-path
 * cache so a newly installed app is picked up without a restart.
 */
export async function getProviders({ refresh = false } = {}) {
  if (!refresh && registryCache !== undefined && Date.now() - registryCacheAt < REGISTRY_TTL_MS) {
    return registryCache;
  }

  const entries = await Promise.all(EDITIONS.map((edition) => probeEdition(edition, { refresh })));
  const available = entries.filter((e) => e.available);

  const preferred = (process.env.WORKBUDDY_EDITION ?? '').trim().toLowerCase();
  const order = preferred === 'ai' || preferred === 'cn' ? [preferred] : DEFAULT_PRIORITY;

  const registry = {
    entries,
    available,
    availableEditions: available.map((e) => e.edition),
    defaultEdition:
      order.find((edition) => available.some((e) => e.edition === edition)) ??
      available[0]?.edition,
    checkedAt: Date.now(),
  };

  registryCache = registry;
  registryCacheAt = registry.checkedAt;
  return registry;
}

/** Resolve which provider a request should use. */
export async function resolveProvider(requested) {
  const registry = await getProviders();
  if (registry.available.length === 0) {
    const reasons = registry.entries.map((e) => `  ${e.edition}: ${e.error ?? 'not available'}`).join('\n');
    throw new Error(
      `No usable WorkBuddy account was found on this machine.\n${reasons}\n` +
        'Install and log into the WorkBuddy desktop app (international or China edition), then retry.',
    );
  }

  if (requested === 'ai' || requested === 'cn') {
    const entry = registry.available.find((e) => e.edition === requested);
    if (entry === undefined) {
      throw new Error(
        `The ${requested.toUpperCase()} edition was requested but is not available on this machine. ` +
          `Available: ${registry.availableEditions.join(', ') || '(none)'}.`,
      );
    }
    return entry;
  }

  return registry.available.find((e) => e.edition === registry.defaultEdition) ?? registry.available[0];
}

/** Force a re-check and refresh the token for one (or every) edition. */
export async function refreshProvider(edition) {
  const targets = edition === 'ai' || edition === 'cn' ? [edition] : [...EDITIONS];
  const results = [];

  for (const target of targets) {
    const result = await tryRefresh(target);
    results.push({
      edition: target,
      ok: result.ok === true,
      reason: result.ok ? undefined : result.reason,
      expiresAt: result.ok ? result.credential?.expiresAt : undefined,
    });
  }

  // The registry now holds stale credentials; drop it so the next call re-probes.
  registryCache = undefined;
  return results;
}

/** Model catalog for one provider, with a short cache. */
const modelCache = new Map();
const MODEL_TTL_MS = 5 * 60 * 1000;

export async function getModels(edition) {
  const cached = modelCache.get(edition);
  if (cached !== undefined && Date.now() - cached.at < MODEL_TTL_MS) return cached.models;

  const models = await listModels(undefined, edition);
  modelCache.set(edition, { models, at: Date.now() });
  return models;
}

/** Drop every cache so the next call re-probes the machine. */
export function invalidateCaches() {
  registryCache = undefined;
  modelCache.clear();
}
