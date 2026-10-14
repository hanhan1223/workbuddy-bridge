/**
 * WorkBuddy credential access for both editions (AI / CN).
 *
 * Both products store `auth.accessToken` / `auth.refreshToken` encrypted at
 * rest as `{$wbEncrypted:1, envelope}` wrappers. The envelope is AES-256-GCM
 * under a protector key derived from a machine-local secret that ONLY a
 * WorkBuddy-modified Electron exposes, via its private `workbuddy_storage`
 * binding — and each edition's binary unwraps only its own edition's secret.
 *
 * We therefore cannot decrypt in-process (this runs in stock Node). We spawn
 * the edition's own binary once with ELECTRON_RUN_AS_NODE=1 and a tiny -e
 * script that prints the sealed payload.
 *
 * The crypto below is a faithful re-implementation of the algorithm read out
 * of dsh-workbuddy-connect; the AAD layout is byte-exact, because getting it
 * subtly wrong yields "wrong key" style failures rather than anything
 * diagnosable.
 *
 * Tokens are also REFRESHABLE: both editions issue Keycloak tokens from
 * `https://<domain>/auth/realms/copilot`, so a refresh_token grant can extend
 * the session without opening the desktop app. The refreshed copy is cached in
 * our own file — never written back into the app's auth file.
 */

import { execFile } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { findElectronBinary, rememberElectronPath } from './locate.js';

/** The -e script run inside WorkBuddy's Electron; prints only the payload. */
const HELPER_SCRIPT =
  'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))';

/** Per-edition defaults. */
const EDITION_CONFIG = {
  ai: {
    domain: 'www.workbuddy.ai',
    authFile: ['CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop-ai.info'],
    authFileEnv: 'WORKBUDDY_AI_AUTH_FILE',
    defaultModel: 'deepseek-v4.1-flash',
  },
  cn: {
    domain: 'www.workbuddy.cn',
    authFile: ['CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'],
    authFileEnv: 'WORKBUDDY_AUTH_FILE',
    defaultModel: 'auto',
  },
};

/** The desktop auth file written by each edition. */
export function desktopAuthPath(edition) {
  const config = EDITION_CONFIG[edition];
  const override = process.env[config.authFileEnv]?.trim();
  if (override) return override;
  const local = process.env.LOCALAPPDATA?.trim();
  if (!local) throw new Error(`LOCALAPPDATA is not set; cannot locate the ${edition.toUpperCase()} auth file`);
  return join(local, ...config.authFile);
}

/** The canonical domain for an edition. */
export function editionDomain(edition) {
  return EDITION_CONFIG[edition].domain;
}

/** The model to use when the caller does not name one. */
export function editionDefaultModel(edition) {
  return (process.env.WORKBUDDY_MODEL ?? '').trim() || EDITION_CONFIG[edition].defaultModel;
}

/**
 * The Electron binary used to unwrap the at-rest key for one edition.
 *
 * Discovery lives in locate.js and probes an environment override, the usual
 * install roots, the Windows uninstall registry, and a cache of the last
 * binary that worked. It throws a message naming every strategy it tried when
 * all of them fail.
 */
export function electronPath(edition) {
  return findElectronBinary(edition);
}

/** base64 decode with exact length / canonical-form checks. */
function parseBase64(value, expectedLength) {
  if (typeof value !== 'string' || value === '') return undefined;
  let decoded;
  try {
    decoded = Buffer.from(value, 'base64');
  } catch {
    return undefined;
  }
  if (decoded.length === 0) return undefined;
  if (decoded.toString('base64').replace(/=+$/u, '') !== value.replace(/=+$/u, '')) return undefined;
  if (expectedLength !== undefined && decoded.length !== expectedLength) return undefined;
  return decoded;
}

/**
 * AAD for one field envelope (WBEV1 / sym-v1 / suite 1).
 * Transcribed byte-for-byte from the app's buildAuthenticatedContextAad.
 */
function buildAad(keyId, suite) {
  const lengthPrefixed = (value) => {
    const bytes = Buffer.from(value, 'utf8');
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(bytes.length);
    return Buffer.concat([header, bytes]);
  };
  const suiteBytes = Buffer.allocUnsafe(4);
  suiteBytes.writeUInt32BE(suite);
  return Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'),
    Buffer.from([1]),
    lengthPrefixed('WBEV1'),
    lengthPrefixed('sym-v1'),
    suiteBytes,
    lengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

/** Open one `{$wbEncrypted:1, envelope}` wrapper with the protector key. */
function openField(protectorKey, wrapped) {
  if (typeof wrapped !== 'object' || wrapped === null) return undefined;
  if (wrapped.$wbEncrypted !== 1 || typeof wrapped.envelope !== 'string') return undefined;

  let inner;
  try {
    inner = JSON.parse(Buffer.from(wrapped.envelope, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof inner !== 'object' || inner === null) return undefined;
  if (inner.suite !== 1 || typeof inner.keyId !== 'string' || !/^[0-9a-f]{16}$/u.test(inner.keyId)) {
    return undefined;
  }

  const nonce = parseBase64(inner.nonce, 12);
  const authTag = parseBase64(inner.authTag, 16);
  const ciphertext = parseBase64(inner.ciphertext);
  if (nonce === undefined || authTag === undefined || ciphertext === undefined) return undefined;

  try {
    const decipher = createDecipheriv('aes-256-gcm', protectorKey, nonce, { authTagLength: 16 });
    decipher.setAAD(buildAad(inner.keyId, inner.suite));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

/** One at-rest secret per edition: they are different binaries and keys. */
const payloadCache = new Map();

/** Run the helper inside the edition's Electron to obtain the sealed payload. */
export function fetchAtRestPayload(edition) {
  const cached = payloadCache.get(edition);
  if (cached) return Promise.resolve(cached);

  const bin = electronPath(edition);
  if (!existsSync(bin)) {
    return Promise.reject(
      new Error(
        `WorkBuddy ${edition.toUpperCase()} Electron binary not found at "${bin}". ` +
          `Set ${edition === 'ai' ? 'WORKBUDDY_AI_ELECTRON_BIN' : 'WORKBUDDY_ELECTRON_BIN'} to the app's executable.`,
      ),
    );
  }
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ['-e', HELPER_SCRIPT],
      {
        timeout: 20000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      },
      (error, stdout) => {
        if (error) {
          reject(
            new Error(
              `WorkBuddy key helper failed (${bin}): ${
                error.killed ? 'timed out' : `exit ${error.code ?? 'unknown'}`
              }`,
            ),
          );
          return;
        }
        const text = String(stdout).trim();
        if (text === '') {
          reject(new Error(`WorkBuddy key helper (${bin}) produced no payload`));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          reject(new Error('WorkBuddy key helper returned malformed JSON'));
          return;
        }
        const secret = parsed?.atRestSecretKey;
        if (parsed?.version !== 1 || typeof secret !== 'string' || secret === '') {
          reject(new Error('WorkBuddy at-rest payload has an unexpected shape'));
          return;
        }
        const raw = Buffer.from(secret, 'base64');
        if (raw.length !== 32) {
          reject(new Error('WorkBuddy at-rest secret is not 32 bytes'));
          return;
        }
        payloadCache.set(edition, secret);
        // This binary demonstrably works, so let future runs reuse it instead
        // of re-running the whole discovery chain.
        rememberElectronPath(bin);
        resolve(secret);
      },
    );
  });
}

/**
 * Read and decrypt an edition's auth file.
 *
 * Returns the raw credential record: tokens plus the identity fields the
 * upstream needs (uid, domain, expiry). Decryption is done here so that a
 * failure is reported as "cannot decrypt" rather than surfacing later as a
 * confusing 401 from the upstream.
 */
async function readAuthFile(edition) {
  const path = desktopAuthPath(edition);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read WorkBuddy ${edition.toUpperCase()} auth file at "${path}": ${error.message}`);
  }

  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error(`WorkBuddy ${edition.toUpperCase()} auth file at "${path}" is not valid JSON`);
  }

  const auth = typeof document.auth === 'object' && document.auth !== null ? document.auth : document;
  const account =
    typeof document.account === 'object' && document.account !== null ? document.account : {};

  let accessToken = auth.accessToken;
  let refreshToken = auth.refreshToken;

  const isWrapped = (v) => typeof v === 'object' && v !== null && v.$wbEncrypted === 1;

  if (isWrapped(accessToken) || isWrapped(refreshToken)) {
    const secret = await fetchAtRestPayload(edition);
    const protectorKey = createHash('sha256').update(secret, 'utf8').digest();

    if (isWrapped(accessToken)) {
      accessToken = openField(protectorKey, accessToken);
      if (accessToken === undefined) {
        throw new Error(
          'Failed to decrypt accessToken. The app may have rotated its at-rest key; ' +
            `re-run the WorkBuddy ${edition.toUpperCase()} app once and retry.`,
        );
      }
    }
    if (isWrapped(refreshToken)) {
      refreshToken = openField(protectorKey, refreshToken);
    }
  }

  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new Error(`No usable accessToken in the WorkBuddy ${edition.toUpperCase()} auth file`);
  }

  return {
    edition,
    accessToken,
    refreshToken: typeof refreshToken === 'string' ? refreshToken : undefined,
    uid: typeof account.uid === 'string' ? account.uid : '',
    domain: typeof auth.domain === 'string' && auth.domain !== '' ? auth.domain : editionDomain(edition),
    expiresAt: typeof auth.expiresAt === 'number' ? auth.expiresAt : undefined,
    refreshExpiresAt: typeof auth.refreshExpiresAt === 'number' ? auth.refreshExpiresAt : undefined,
    sessionState: typeof auth.sessionState === 'string' ? auth.sessionState : undefined,
    path,
  };
}

/** Where a refreshed token copy is cached (never overwrites the app's file). */
export function ownAuthPath(edition) {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  return join(home, `.workbuddy-${edition}-auth.json`);
}

/** Read the cached refreshed copy, if one exists and is still valid. */
async function readCachedCredential(edition) {
  try {
    const saved = JSON.parse(await readFile(ownAuthPath(edition), 'utf8'));
    if (typeof saved?.accessToken !== 'string' || saved.accessToken === '') return undefined;
    if (typeof saved.expiresAt === 'number' && saved.expiresAt <= Date.now() + REFRESH_MARGIN_MS) {
      return undefined;
    }
    return saved;
  } catch {
    return undefined;
  }
}

async function writeCachedCredential(edition, credential) {
  try {
    const file = ownAuthPath(edition);
    await mkdirSync(dirname(file), { recursive: true });
    await writeFile(
      file,
      `${JSON.stringify(
        {
          edition,
          accessToken: credential.accessToken,
          refreshToken: credential.refreshToken,
          uid: credential.uid,
          domain: credential.domain,
          expiresAt: credential.expiresAt,
          refreshExpiresAt: credential.refreshExpiresAt,
          sessionState: credential.sessionState,
          refreshedAt: Date.now(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  } catch {
    // A cache that cannot be written must never break the request.
  }
}

/** Refresh this far ahead of expiry, so a request never races the deadline. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Exchange a refresh_token for a new access_token.
 *
 * Both editions issue Keycloak tokens from `/auth/realms/copilot`, so the
 * standard refresh_token grant applies. The grant needs a client_id, which the
 * desktop app does not expose on disk in a form we can rely on; it is taken
 * from WORKBUDDY_CLIENT_ID when set, otherwise `console` (the value in the
 * token's own `azp` claim) is tried.
 *
 * A failure is returned, not thrown: a refresh that stops working must degrade
 * to "use the existing token and tell the user to reopen the app", never to
 * "the bridge is broken".
 */
async function refreshWithUpstream(edition, credential) {
  if (typeof credential.refreshToken !== 'string' || credential.refreshToken === '') {
    return { ok: false, reason: 'the auth file has no refresh token' };
  }
  if (typeof credential.refreshExpiresAt === 'number' && credential.refreshExpiresAt <= Date.now()) {
    return { ok: false, reason: 'the refresh token itself has expired; log in again in the desktop app' };
  }

  const origin = `https://${credential.domain}`;
  const url = `${origin}/auth/realms/copilot/protocol/openid-connect/token`;

  const clientId = (process.env.WORKBUDDY_CLIENT_ID ?? '').trim() || 'console';
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: credential.refreshToken,
    client_id: clientId,
  });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Origin: origin,
        Referer: `${origin}/`,
      },
      body: params.toString(),
      signal: AbortSignal.timeout(30000),
    });

    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, reason: `refresh returned a non-JSON response (HTTP ${response.status})` };
    }

    if (typeof body.access_token !== 'string' || body.access_token === '') {
      const detail = body.error_description ?? body.error ?? body.msg ?? text.slice(0, 200);
      return { ok: false, reason: `refresh rejected (HTTP ${response.status}): ${detail}` };
    }

    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    const refreshExpiresIn = typeof body.refresh_expires_in === 'number' ? body.refresh_expires_in : expiresIn;
    const now = Date.now();

    const refreshed = {
      ...credential,
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' && body.refresh_token !== ''
        ? body.refresh_token
        : credential.refreshToken,
      expiresAt: now + expiresIn * 1000,
      refreshExpiresAt: now + refreshExpiresIn * 1000,
      refreshedAt: now,
    };

    await writeCachedCredential(edition, refreshed);
    return { ok: true, credential: refreshed };
  } catch (error) {
    return { ok: false, reason: `refresh request failed: ${error?.message ?? error}` };
  }
}

/** A probe of refresh without side effects beyond writing our own cache. */
export async function tryRefresh(edition) {
  let credential;
  try {
    credential = await readAuthFile(edition);
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
  const result = await refreshWithUpstream(edition, credential);
  return result.ok ? { ok: true, credential: result.credential } : result;
}

/**
 * Load credentials for an edition, refreshing when the token is near expiry.
 *
 * Order: a valid cached copy wins; otherwise read and decrypt the app's file,
 * then refresh it if it expires within the margin. A refresh failure leaves the
 * existing token in place — it may still be valid, and the upstream's own 401
 * is a more accurate signal than our guess.
 */
export async function loadCredentials(edition = 'ai', { allowRefresh = true } = {}) {
  const cached = await readCachedCredential(edition);
  if (cached !== undefined) {
    return { ...cached, edition, path: cached.path ?? ownAuthPath(edition), source: 'cache' };
  }

  const credential = await readAuthFile(edition);

  const expiringSoon =
    typeof credential.expiresAt === 'number' && credential.expiresAt <= Date.now() + REFRESH_MARGIN_MS;
  if (allowRefresh && expiringSoon) {
    const result = await refreshWithUpstream(edition, credential);
    if (result.ok) return { ...result.credential, source: 'refreshed' };
    // Remember why, so the caller can surface it instead of a bare 401.
    credential.refreshError = result.reason;
  }

  return { ...credential, source: 'file' };
}
