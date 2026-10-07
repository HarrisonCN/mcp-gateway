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
 */

import { createHash, timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { jwtVerify } from 'jose';
import type { ApiKeyConfig, AuthConfig } from '../utils/types.js';
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

const JWT_ALGORITHMS = ['HS256', 'HS384', 'HS512'];

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
    case 'jwt': {
      if (!config.jwtSecret) {
        throw new Error('auth.strategy is "jwt" but auth.jwtSecret is not configured');
      }
      if (config.jwtSecret.length < 32) {
        logger.warn('auth.jwtSecret is shorter than 32 characters; use a longer random secret');
      }
      return jwtMiddleware(config.jwtSecret);
    }
    default:
      // Fail closed. Previously this fell back to *no auth*, so configuring the
      // advertised-but-unimplemented "oauth2" strategy exposed every endpoint.
      throw new Error(`Auth strategy "${String(config.strategy)}" is not supported yet`);
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function fingerprint(key: string): string {
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
  const keyDigests = entries.map((e) => digest(e.key));
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
    (req as AuthedRequest).clientId = client.clientId;
    if (client.scope) (req as AuthedRequest).scope = client.scope;
    next();
  };
  mw.resolveClient = (clientId) => {
    const c = clientId ? byClientId.get(clientId) : undefined;
    return c ? { known: true, scope: c.scope } : { known: false };
  };
  return mw;
}

function jwtMiddleware(secret: string): AuthMiddleware {
  const secretKey = new TextEncoder().encode(secret);

  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !/^Bearer /i.test(authHeader)) {
      res.status(401).json({ error: 'Unauthorized', message: 'Bearer token required' });
      return;
    }

    const token = authHeader.slice(7).trim();

    // Two-argument then(): an error thrown downstream of next() must not be
    // misreported as an auth failure.
    jwtVerify(token, secretKey, { algorithms: JWT_ALGORITHMS }).then(
      ({ payload }) => {
        (req as AuthedRequest).jwtPayload = payload;
        (req as AuthedRequest).clientId = `jwt:${String(payload.sub ?? 'unknown')}`;
        const scope = scopeFromJwt(payload);
        if (scope) (req as AuthedRequest).scope = scope;
        next();
      },
      (err: unknown) => {
        logger.warn(`JWT verification failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) {
          res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token' });
        }
      },
    );
  };
}
