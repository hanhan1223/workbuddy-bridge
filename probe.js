/**
 * Model availability probing.
 *
 * `/v3/config` returns the account's entire roster, which is not the same as the
 * set of models that can actually answer a chat request. Measured on a China
 * account, 4 of 13 sampled ids were unusable:
 *
 *   codewise-completions   11102  model [completion-077] service info not found
 *   hunyuan-3b             11102  model [hunyuan-3b] service info not found
 *   hunyuan-image-alpha    11103  Backend [hunyuan-stream] is not supported
 *   space-bunny            no response within the timeout
 *
 * Those are completion-only, small-parameter, or image models: they exist in the
 * catalog but cannot serve `/v2/chat/completions`. Picking one from a list is
 * therefore a reliable way to get a confusing failure, which is exactly what
 * this module removes.
 *
 * Two properties matter and shape the implementation:
 *
 *   - The upstream rate-limits (HTTP 429 / code 14003) on bursts, so probes run
 *     with a small concurrency limit rather than all at once.
 *   - A probe costs real quota, so results are cached. The cache is keyed by
 *     edition and invalidated explicitly, never silently re-run per request.
 */

import { chat, WorkBuddyBusyError } from './upstream.js';
import { getModels } from './providers.js';

/** Probing every model in a large roster is slow and costs quota. */
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_LIMIT = 20;

/** Cache TTL. Availability tracks the account, which changes slowly. */
const CACHE_TTL_MS = 30 * 60 * 1000;

/** How long a single probe may take before it counts as unusable. */
const PROBE_TIMEOUT_MS = 45000;

/** Results are cached per edition: the two rosters are different. */
const cache = new Map();

/**
 * Whether an id is even a candidate for a chat request.
 *
 * Not a substitute for probing — it is a cheap hint used to order the queue, so
 * that if the caller caps the number of probes the useful models are tried
 * first. Everything flagged here is still reported, just labelled.
 */
export function looksChatCapable(id) {
  if (typeof id !== 'string' || id === '') return false;
  // Completion-only, code-completion, and image backends cannot serve chat.
  if (/^codewise-/.test(id)) return false;
  if (/image/.test(id)) return false;
  if (/^hunyuan-\d/.test(id)) return false;
  if (/completion/.test(id)) return false;
  if (/^wb-lite$/.test(id)) return false;
  return true;
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

/** One model, one minimal request. */
async function probeOne(edition, model) {
  const started = Date.now();
  try {
    const result = await chat(
      {
        model,
        max_tokens: 16,
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Say OK' },
        ],
      },
      { edition, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
    );

    const text = (result.text ?? '').trim();
    const elapsed = Date.now() - started;

    if (text === '' && (result.toolCalls ?? []).length === 0) {
      return { model, ok: false, reason: 'empty reply', detail: 'model returned no visible text', ms: elapsed };
    }
    return { model, ok: true, ms: elapsed, sample: text.slice(0, 60) };
  } catch (error) {
    const elapsed = Date.now() - started;

    // Busy is transient and says nothing about the model, so it must not be
    // recorded as "unavailable" — a cached 429 would hide a working model.
    if (error instanceof WorkBuddyBusyError) {
      return { model, ok: null, reason: 'rate limited', detail: 'upstream is busy; retry later', ms: elapsed };
    }

    const message = String(error?.message ?? error);
    let reason = 'error';
    if (/11102/.test(message)) reason = 'not a chat model';
    else if (/11103/.test(message)) reason = 'backend not supported';
    else if (/no such model|not found/i.test(message)) reason = 'unknown to upstream';
    else if (/did not finish within|aborted/i.test(message)) reason = 'timed out';

    return { model, ok: false, reason, detail: message.slice(0, 160), ms: elapsed };
  }
}

/**
 * Cache key.
 *
 * Keyed by the request shape, not just by edition. A single-model probe and a
 * 5-model probe are different measurements, so caching them under one key made
 * a later `--model=other-id` return the earlier run's answer — a wrong result
 * reported as a cache hit, which is worse than no cache at all.
 * `refresh` is deliberately excluded so a refresh still overwrites the entry
 * for the same shape.
 */
function cacheKey(edition, { limit, only }) {
  return typeof only === 'string' && only !== '' ? `${edition}\u0000model:${only}` : `${edition}\u0000limit:${limit}`;
}

/**
 * Probe models for an edition.
 *
 * Returns `{ edition, total, probed, results, cached, probedAt }`. Entries carry
 * `ok: true | false | null` where null means "not determined" (rate limited), so
 * a caller never mistakes a transient failure for an unusable model.
 */
export async function probeModels(
  edition,
  { refresh = false, limit = DEFAULT_LIMIT, concurrency = DEFAULT_CONCURRENCY, only } = {},
) {
  const key = cacheKey(edition, { limit, only });
  const cached = cache.get(key);
  if (!refresh && cached !== undefined && Date.now() - cached.probedAt < CACHE_TTL_MS) {
    return { ...cached, cached: true };
  }

  const all = await getModels(edition);

  // Order so that likely-chat models are probed first: if `limit` truncates the
  // run, the useful half is the half that got measured.
  const ordered = [
    ...all.filter((m) => looksChatCapable(m.id)),
    ...all.filter((m) => !looksChatCapable(m.id)),
  ];

  const candidates =
    typeof only === 'string' && only !== ''
      ? ordered.filter((m) => m.id === only)
      : ordered.slice(0, Math.max(1, limit));

  // An id that is not in the catalog cannot be probed at all. Reporting that
  // explicitly beats returning an empty result the caller has to interpret,
  // and it is the common case when a model id from the other edition is used.
  if (candidates.length === 0 && typeof only === 'string' && only !== '') {
    return {
      edition,
      total: all.length,
      probed: 0,
      results: [],
      probedAt: Date.now(),
      cached: false,
      notInCatalog: only,
    };
  }

  const results = await mapWithConcurrency(candidates, Math.max(1, concurrency), (m) =>
    probeOne(edition, m.id),
  );

  const report = {
    edition,
    total: all.length,
    probed: results.length,
    results,
    probedAt: Date.now(),
    cached: false,
  };

  // Only cache a run that produced at least one definitive answer; a run that
  // was entirely rate limited would otherwise pin "unknown" for the whole TTL.
  if (results.some((r) => r.ok !== null)) cache.set(key, report);

  return report;
}

/**
 * Cached results only — never issues a request.
 *
 * `only`/`limit` select the same shapes cached by `probeModels`, so a caller
 * asking for the cached answer to the question it actually asked gets it.
 */
export function readProbeCache(edition, { limit = DEFAULT_LIMIT, only } = {}) {
  const key = cacheKey(edition, { limit, only });
  const cached = cache.get(key);
  if (cached === undefined) return undefined;
  return { ...cached, cached: true, stale: Date.now() - cached.probedAt >= CACHE_TTL_MS };
}

/** Every cached entry for an edition, regardless of request shape. */
export function readAllProbeCache(edition) {
  const entries = [];
  for (const [key, value] of cache.entries()) {
    if (value.edition !== edition) continue;
    entries.push({ ...value, cached: true, stale: Date.now() - value.probedAt >= CACHE_TTL_MS, key });
  }
  return entries;
}

/** Drop cached probe results, for one edition or all of them. */
export function clearProbeCache(edition) {
  if (edition === undefined) {
    cache.clear();
    return;
  }
  // Entries are keyed by edition + request shape, so match on the stored edition.
  for (const [key, value] of [...cache.entries()]) {
    if (value.edition === edition) cache.delete(key);
  }
}
