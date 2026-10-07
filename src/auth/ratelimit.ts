/**
 * In-memory rate limiter (sliding-window counter).
 *
 * Each client keeps the request count of the current and the previous fixed
 * window. The effective count is `current + previous * overlap`, where
 * `overlap` is the fraction of the previous window still inside the sliding
 * window. This smooths the 2x burst a plain fixed window allows at window
 * boundaries while staying O(1) in memory per client.
 *
 * For multi-instance deployments, replace with a shared (e.g. Redis) store.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { RateLimitConfig } from '../utils/types.js';
import { logger } from '../utils/logger.js';

interface WindowEntry {
  /** Start of the current fixed window (ms epoch) */
  windowStart: number;
  current: number;
  previous: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** End of the current window (ms epoch). */
  resetAt: number;
  /** Seconds until a retry can succeed (only when not allowed). */
  retryAfter?: number;
}

export interface RateLimiter extends RequestHandler {
  /** Stop the background cleanup timer and drop all state. */
  close(): void;
  /**
   * Count one request for `req` without responding (used by `/mcp`, where a
   * limit hit becomes a JSON-RPC error). Returns undefined when unlimited.
   */
  take(req: Request): RateLimitDecision | undefined;
}

export function createRateLimiter(
  config?: RateLimitConfig,
  now: () => number = Date.now,
): RateLimiter {
  if (!config) {
    const passthrough = ((_req: Request, _res: Response, next: NextFunction) => next()) as RateLimiter;
    passthrough.close = () => {};
    passthrough.take = () => undefined;
    return passthrough;
  }

  const { limit, windowSeconds, perKey = true } = config;
  const windowMs = windowSeconds * 1000;
  const store = new Map<string, WindowEntry>();

  // Periodically drop clients idle for two full windows. unref() so the timer
  // never keeps the process alive (it previously blocked clean shutdown).
  const cleanup = setInterval(() => {
    const t = now();
    for (const [key, entry] of store) {
      if (t - entry.windowStart >= 2 * windowMs) store.delete(key);
    }
  }, Math.max(windowMs, 1000));
  cleanup.unref();

  const take = (req: Request): RateLimitDecision => {
    const clientId = perKey
      ? ((req as Request & { clientId?: string }).clientId ?? req.ip ?? 'anonymous')
      : 'global';

    const t = now();
    const windowStart = Math.floor(t / windowMs) * windowMs;
    let entry = store.get(clientId);

    if (!entry) {
      entry = { windowStart, current: 0, previous: 0 };
      store.set(clientId, entry);
    } else if (entry.windowStart !== windowStart) {
      // Roll the window forward. If more than one window has elapsed the
      // previous window is empty.
      entry.previous = windowStart - entry.windowStart === windowMs ? entry.current : 0;
      entry.current = 0;
      entry.windowStart = windowStart;
    }

    const overlap = 1 - (t - windowStart) / windowMs;
    const estimated = entry.current + entry.previous * overlap;
    const resetAt = windowStart + windowMs;

    if (estimated >= limit) {
      logger.warn(`Rate limit exceeded for ${clientId}`);
      return { allowed: false, limit, remaining: 0, resetAt, retryAfter: Math.max(1, Math.ceil((resetAt - t) / 1000)) };
    }

    entry.current++;
    return { allowed: true, limit, remaining: Math.max(0, Math.floor(limit - estimated - 1)), resetAt };
  };

  const limiter = ((req: Request, res: Response, next: NextFunction) => {
    const d = take(req);
    setRateLimitHeaders(res, d.limit, d.remaining, d.resetAt);
    if (!d.allowed) {
      res.status(429).set('Retry-After', String(d.retryAfter)).json({
        error: 'Too Many Requests',
        message: `Rate limit of ${limit} requests per ${windowSeconds}s exceeded`,
        retryAfter: d.retryAfter,
      });
      return;
    }
    next();
  }) as RateLimiter;

  limiter.take = take;

  limiter.close = () => {
    clearInterval(cleanup);
    store.clear();
  };

  return limiter;
}

export function setRateLimitHeaders(
  res: Response,
  limit: number,
  remaining: number,
  resetAt: number,
): void {
  res.set({
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': String(Math.max(0, remaining)),
    'X-RateLimit-Reset': String(Math.ceil(resetAt / 1000)),
  });
}
