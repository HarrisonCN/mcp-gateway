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
import type { AuthConfig } from '../utils/types.js';
import { logger } from '../utils/logger.js';

export type AuthedRequest = Request & { clientId?: string; jwtPayload?: unknown };

const JWT_ALGORITHMS = ['HS256', 'HS384', 'HS512'];

export function createAuthMiddleware(config?: AuthConfig): RequestHandler {
  if (!config || config.strategy === 'none') {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  switch (config.strategy) {
    case 'api-key': {
      const keys = (config.apiKeys ?? []).filter((k) => k.length > 0);
      if (keys.length === 0) {
        throw new Error('auth.strategy is "api-key" but no auth.apiKeys are configured');
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
  const c = digest(candidate);
  let match = false;
  // Compare against every key (no early exit) to keep timing independent of position.
  for (const k of keyDigests) {
    if (timingSafeEqual(c, k)) match = true;
  }
  return match;
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

function apiKeyMiddleware(validKeys: string[]): RequestHandler {
  const keyDigests = validKeys.map(digest);

  return (req: Request, res: Response, next: NextFunction) => {
    const key = extractKey(req);

    if (!key || !matchesAnyKey(key, keyDigests)) {
      logger.warn(`Unauthorized request from ${req.ip}: missing or invalid API key`);
      res.status(401).json({ error: 'Unauthorized', message: 'Valid API key required' });
      return;
    }

    (req as AuthedRequest).clientId = `key:${fingerprint(key)}`;
    next();
  };
}

function jwtMiddleware(secret: string): RequestHandler {
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
