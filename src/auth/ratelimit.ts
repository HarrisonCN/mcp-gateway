/**
 * In-memory rate limiter (sliding window)
 * For production, replace with Redis-backed implementation
 */

import type { Request, Response, NextFunction } from 'express';
import type { RateLimitConfig } from '../utils/types.js';
import { logger } from '../utils/logger.js';

interface WindowEntry {
  count: number;
  resetAt: number;
}

export function createRateLimiter(config?: RateLimitConfig) {
  if (!config) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  const { limit, windowSeconds, perKey = true } = config;
  const windowMs = windowSeconds * 1000;
  const store = new Map<string, WindowEntry>();
  let nextCleanupAt = Date.now() + windowMs;

  return (req: Request, res: Response, next: NextFunction) => {
    const clientId = perKey
      ? ((req as Request & { clientId?: string }).clientId ?? req.ip ?? 'anonymous')
      : 'global';

    const now = Date.now();
    if (now >= nextCleanupAt) {
      for (const [key, value] of store.entries()) {
        if (value.resetAt <= now) {
          store.delete(key);
        }
      }
      nextCleanupAt = now + windowMs;
    }

    const entry = store.get(clientId);

    if (!entry || entry.resetAt <= now) {
      store.set(clientId, { count: 1, resetAt: now + windowMs });
      setRateLimitHeaders(res, limit, limit - 1, now + windowMs);
      next();
      return;
    }

    if (entry.count >= limit) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      logger.warn(`Rate limit exceeded for ${clientId}`);
      res.status(429).set('Retry-After', String(retryAfter)).json({
        error: 'Too Many Requests',
        message: `Rate limit of ${limit} requests per ${windowSeconds}s exceeded`,
        retryAfter,
      });
      return;
    }

    entry.count++;
    setRateLimitHeaders(res, limit, limit - entry.count, entry.resetAt);
    next();
  };
}

function setRateLimitHeaders(
  res: Response,
  limit: number,
  remaining: number,
  resetAt: number
): void {
  res.set({
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': String(Math.max(0, remaining)),
    'X-RateLimit-Reset': String(Math.ceil(resetAt / 1000)),
  });
}
