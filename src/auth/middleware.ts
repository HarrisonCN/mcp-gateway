/**
 * Authentication middleware for the gateway HTTP API
 *
 * Security notes:
 *  - API keys are compared in constant time (SHA-256 digest + timingSafeEqual)
 *    so response timing does not leak how much of a key matched.
 *  - Misconfiguration fails CLOSED: an unknown / unimplemented strategy, an
 *    `api-key` strategy with no keys, or a `jwt` strategy with no secret throws
 *    at startup instead of silently disabling authentication.
 *  - The client id attached to a request is a hash fingerprint of the key,
 *    never a prefix of the key itself (prefixes were leaking into logs and the
 *    /requests endpoint, and keys sharing a prefix shared a rate-limit bucket).
 *  - Keys may be stored as SHA-256 digests (`sha256:<hex>`), so the config
 *    file never holds a usable key. A digest key and its plain form produce
 *    the same client id.
 *  - Keys can expire (`expiresAt`) or be switched off (`disabled`).
 *  - JWTs: HMAC secret, PEM public key or JWKS URL; algorithm allowlist that
 *    never mixes HMAC and asymmetric algorithms; optional issuer / audience /
 *    exp / max-age checks and clock tolerance.
 */

import { createHash, createPublicKey, timingSafeEqual, type KeyObject } from 'crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTVerifyOptions } from 'jose';
import type { ApiKeyConfig, AuthConfig, JwtConfig } from '../utils/types.js';
import { logger } from '../utils/logger.js';
import { scopeFromJwt, type AccessScope } from './scopes.js';

export type AuthedRequest = Request & {
  clientId?: string;
  jwtPayload?: unknown;
  /** Servers / tools / rate limit this client is restricted to (absent = unrestricted). */
  scope?: AccessScope;
};

/** An auth middleware that can also look up the current scope of a known client id (api keys). */
export type AuthMiddleware = RequestHandler & {
  /**
   * Current scope for `clientId`: `{ known: false }` when no configured key
   * produces that id any more. Undefined for strategies whose scopes travel
   * with the credential (JWT).
   */
  resolveClient?: (clientId: string | undefined) => { known: boolean; scope?: AccessScope };
};

/** Normalise `auth.apiKeys` entries (plain strings or objects). */
export function normalizeApiKeys(keys: AuthConfig['apiKeys']): ApiKeyConfig[] {
  return (keys ?? [])
    .map((k) => (typeof k === 'string' ? { key: k } : k))
    .filter((k): k is ApiKeyConfig => !!k && typeof k.key === 'string' && k.key.length > 0);
}

function scopeOf(entry: ApiKeyConfig): AccessScope | undefined {
  const scope: AccessScope = {};
  if (entry.name) scope.name = entry.name;
  if (entry.servers) scope.servers = [...entry.servers];
  if (entry.tools) scope.tools = [...entry.tools];
  if (entry.rateLimit) scope.rateLimit = { ...entry.rateLimit, perKey: true };
  return Object.keys(scope).length > 0 ? scope : undefined;
}

export const HMAC_ALGORITHMS = ['HS256', 'HS384', 'HS512'];
export const ASYMMETRIC_ALGORITHMS = [
  'RS256', 'RS384', 'RS512',
  'PS256', 'PS384', 'PS512',
  'ES256', 'ES384', 'ES512',
  'EdDSA',
];

const HASHED_KEY_RE = /^sha256:([0-9a-f]{64})$/i;

/** Whether a configured key is a `sha256:<hex>` digest rather than the key itself. */
export function isHashedKey(key: string): boolean {
  return HASHED_KEY_RE.test(key);
}

/** `sha256:<hex>` digest of a key, the form to store in the config file. */
export function hashApiKey(key: string): string {
  return `sha256:${createHash('sha256').update(key, 'utf8').digest('hex')}`;
}

/** Expiry of a key entry as epoch ms (undefined = never; NaN for an unparsable date). */
export function keyExpiry(entry: ApiKeyConfig): number | undefined {
  if (entry.expiresAt === undefined) return undefined;
  return Date.parse(entry.expiresAt);
}

/** Why a key is currently unusable, or undefined when it is active. */
export function keyInactiveReason(entry: ApiKeyConfig, now = Date.now()): 'disabled' | 'expired' | undefined {
  if (entry.disabled) return 'disabled';
  const exp = keyExpiry(entry);
  if (exp !== undefined && !(exp > now)) return 'expired';
  return undefined;
}

export function createAuthMiddleware(config?: AuthConfig): AuthMiddleware {
  if (!config || config.strategy === 'none') {
    const none: AuthMiddleware = (_req: Request, _res: Response, next: NextFunction) => next();
    none.resolveClient = () => ({ known: true });
    return none;
  }

  switch (config.strategy) {
    case 'api-key': {
      const keys = normalizeApiKeys(config.apiKeys);
      if (keys.length === 0) {
        throw new Error('auth.strategy is "api-key" but no auth.apiKeys are configured');
      }
      const names = new Set<string>();
      for (const k of keys) {
        if (!k.name) continue;
        if (names.has(k.name)) throw new Error(`auth.apiKeys: duplicate key name "${k.name}"`);
        names.add(k.name);
      }
      return apiKeyMiddleware(keys);
    }
    case 'jwt':
      return jwtMiddleware(buildJwtVerifier(config));
    default:
      // Fail closed. Previously this fell back to *no auth*, so configuring the
      // advertised-but-unimplemented "oauth2" strategy exposed every endpoint.
      throw new Error(`Auth strategy "${String(config.strategy)}" is not supported yet`);
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Digest of a configured key: the stored digest for `sha256:` keys, else SHA-256 of the key. */
function configuredDigest(key: string): Buffer {
  const m = HASHED_KEY_RE.exec(key);
  return m ? Buffer.from(m[1]!, 'hex') : digest(key);
}

export function fingerprint(key: string): string {
  const m = HASHED_KEY_RE.exec(key);
  if (m) return m[1]!.toLowerCase().slice(0, 12);
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 12);
}

/** Constant-time membership check against a pre-hashed key list. */
export function matchesAnyKey(candidate: string, keyDigests: Buffer[]): boolean {
  return matchKeyIndex(candidate, keyDigests) >= 0;
}

/** Constant-time lookup: index of the matching key digest, or -1. */
export function matchKeyIndex(candidate: string, keyDigests: Buffer[]): number {
  const c = digest(candidate);
  let index = -1;
  // Compare against every key (no early exit) to keep timing independent of position.
  keyDigests.forEach((k, i) => {
    if (timingSafeEqual(c, k) && index < 0) index = i;
  });
  return index;
}

function extractKey(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader && /^Bearer /i.test(authHeader)) {
    return authHeader.slice(7).trim() || undefined;
  }
  const apiKeyHeader = req.headers['x-api-key'];
  if (typeof apiKeyHeader === 'string' && apiKeyHeader.length > 0) return apiKeyHeader;
  return undefined;
}

function apiKeyMiddleware(entries: ApiKeyConfig[]): AuthMiddleware {
  for (const e of entries) {
    if (e.expiresAt !== undefined && Number.isNaN(keyExpiry(e))) {
      throw new Error(`auth.apiKeys: invalid expiresAt "${e.expiresAt}"${e.name ? ` (key "${e.name}")` : ''}`);
    }
  }
  const keyDigests = entries.map((e) => configuredDigest(e.key));
  const clients = entries.map((e) => ({
    clientId: e.name ? `key:${e.name}` : `key:${fingerprint(e.key)}`,
    scope: scopeOf(e),
  }));
  const byClientId = new Map(clients.map((c) => [c.clientId, c]));

  const mw: AuthMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const key = extractKey(req);
    const index = key ? matchKeyIndex(key, keyDigests) : -1;

    if (index < 0) {
      logger.warn(`Unauthorized request from ${req.ip}: missing or invalid API key`);
      res.status(401).json({ error: 'Unauthorized', message: 'Valid API key required' });
      return;
    }

    const client = clients[index]!;
    const inactive = keyInactiveReason(entries[index]!);
    if (inactive) {
      logger.warn(`Unauthorized request from ${req.ip}: API key ${client.clientId} is ${inactive}`);
      res.status(401).json({ error: 'Unauthorized', message: 'Valid API key required' });
      return;
    }
    (req as AuthedRequest).clientId = client.clientId;
    if (client.scope) (req as AuthedRequest).scope = client.scope;
    next();
  };
  mw.resolveClient = (clientId) => {
    const c = clientId ? byClientId.get(clientId) : undefined;
    if (!c || keyInactiveReason(entries[clients.indexOf(c)]!)) return { known: false };
    return { known: true, scope: c.scope };
  };
  return mw;
}

export interface JwtVerifier {
  key: Uint8Array | KeyObject | JWTVerifyGetKey;
  options: JWTVerifyOptions;
}

const asList = (v: string | string[] | undefined) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);

/**
 * Key source + verification options for the `jwt` strategy. Throws on
 * misconfiguration (missing / conflicting key sources, algorithms that do not
 * fit the key type, non-HTTPS JWKS URL).
 */
export function buildJwtVerifier(config: AuthConfig): JwtVerifier {
  const jwt: JwtConfig = config.jwt ?? {};
  const sources = [config.jwtSecret ? 'jwtSecret' : '', jwt.publicKey ? 'jwt.publicKey' : '', jwt.jwksUrl ? 'jwt.jwksUrl' : ''].filter(Boolean);
  if (sources.length === 0) {
    throw new Error('auth.strategy is "jwt" but none of auth.jwtSecret, auth.jwt.publicKey or auth.jwt.jwksUrl is configured');
  }
  if (sources.length > 1) throw new Error(`auth: configure only one of ${sources.join(', ')}`);
  const hmac = !!config.jwtSecret;
  const allowed = hmac ? HMAC_ALGORITHMS : ASYMMETRIC_ALGORITHMS;
  const algorithms = jwt.algorithms ?? allowed;
  if (algorithms.length === 0) throw new Error('auth.jwt.algorithms must not be empty');
  const bad = algorithms.filter((a) => !allowed.includes(a));
  if (bad.length > 0) {
    throw new Error(
      `auth.jwt.algorithms: ${bad.join(', ')} cannot be used with ${sources[0]} (allowed: ${allowed.join(', ')})`,
    );
  }

  let key: JwtVerifier['key'];
  if (config.jwtSecret) {
    if (config.jwtSecret.length < 32) {
      logger.warn('auth.jwtSecret is shorter than 32 characters; use a longer random secret');
    }
    key = new TextEncoder().encode(config.jwtSecret);
  } else if (jwt.publicKey) {
    try {
      key = createPublicKey(jwt.publicKey);
    } catch (err) {
      throw new Error(`auth.jwt.publicKey is not a valid PEM public key: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    let url: URL;
    try {
      url = new URL(jwt.jwksUrl!);
    } catch {
      throw new Error(`auth.jwt.jwksUrl is not a valid URL: ${jwt.jwksUrl}`);
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
      throw new Error('auth.jwt.jwksUrl must use https:// (http:// is only allowed for localhost)');
    }
    key = createRemoteJWKSet(url, {
      cacheMaxAge: (jwt.jwksCacheSeconds ?? 600) * 1000,
      cooldownDuration: 30_000,
      timeoutDuration: 5_000,
    });
  }

  const options: JWTVerifyOptions = { algorithms };
  const issuer = asList(jwt.issuer);
  const audience = asList(jwt.audience);
  if (issuer) options.issuer = issuer;
  if (audience) options.audience = audience;
  if (jwt.clockToleranceSeconds) options.clockTolerance = jwt.clockToleranceSeconds;
  if (jwt.requireExp) options.requiredClaims = ['exp'];
  if (jwt.maxTokenAgeSeconds) options.maxTokenAge = jwt.maxTokenAgeSeconds;
  return { key, options };
}

function jwtMiddleware(verifier: JwtVerifier): AuthMiddleware {
  const verify = (token: string) =>
    typeof verifier.key === 'function'
      ? jwtVerify(token, verifier.key, verifier.options)
      : jwtVerify(token, verifier.key, verifier.options);

  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !/^Bearer /i.test(authHeader)) {
      res.status(401).json({ error: 'Unauthorized', message: 'Bearer token required' });
      return;
    }

    const token = authHeader.slice(7).trim();

    // Two-argument then(): an error thrown downstream of next() must not be
    // misreported as an auth failure.
    verify(token).then(
      ({ payload }) => {
        (req as AuthedRequest).jwtPayload = payload;
        (req as AuthedRequest).clientId = `jwt:${String(payload.sub ?? 'unknown')}`;
        const scope = scopeFromJwt(payload);
        if (scope) (req as AuthedRequest).scope = scope;
        next();
      },
      (err: unknown) => {
        logger.warn(`JWT verification failed from ${req.ip}: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) {
          res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token' });
        }
      },
    );
  };
}
