/**
 * Rate limiting and brute-force lockout on top of a shared `StateStore`
 * (used when `state.store` is not `memory`).
 *
 * Both fail open by default when the store is unreachable (a Redis outage
 * must not take every tool call down); set `state.failureMode: closed` to
 * reject requests instead.
 *
 * @module state/shared
 */

import type { Request, Response, NextFunction } from 'express';
import type { AuthLockoutConfig, RateLimitConfig } from '../utils/types.js';
import { setRateLimitHeaders, type RateLimitDecision, type RateLimiter } from '../auth/ratelimit.js';
import { DEFAULT_LOCKOUT, type LockoutTracker } from '../security/lockout.js';
import { logger } from '../utils/logger.js';
import type { StateStore } from './store.js';

export type FailureMode = 'open' | 'closed';

let lastStoreWarning = 0;
function storeFailed(what: string, err: unknown): void {
  const t = Date.now();
  if (t - lastStoreWarning > 10_000) {
    lastStoreWarning = t;
    logger.warn(`State store unavailable (${what}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Sliding-window rate limiter whose counters live in the store, so the limit
 * holds across every gateway instance sharing it.
 */
export function createStoreRateLimiter(
  config: RateLimitConfig,
  store: StateStore,
  options: { failureMode?: FailureMode; now?: () => number; namespace?: string } = {},
): RateLimiter {
  const { limit, windowSeconds, perKey = true } = config;
  const windowMs = windowSeconds * 1000;
  const now = options.now ?? Date.now;
  const ns = options.namespace ?? 'rl';

  const take = async (req: Request): Promise<RateLimitDecision> => {
    const clientId = perKey ? ((req as Request & { clientId?: string }).clientId ?? req.ip ?? 'anonymous') : 'global';
    const t = now();
    const index = Math.floor(t / windowMs);
    const windowStart = index * windowMs;
    const resetAt = windowStart + windowMs;
    const key = (i: number) => `${ns}:${windowSeconds}:${clientId}:${i}`;
    try {
      const [current, previousRaw] = await Promise.all([store.incr(key(index), 2 * windowMs), store.get(key(index - 1))]);
      const previous = Number(previousRaw ?? 0) || 0;
      const overlap = 1 - (t - windowStart) / windowMs;
      const estimated = current - 1 + previous * overlap;
      if (estimated >= limit) {
        // Denied requests do not count towards the limit.
        await store.incr(key(index), 2 * windowMs, -1).catch(() => undefined);
        logger.warn(`Rate limit exceeded for ${clientId}`);
        return { allowed: false, limit, remaining: 0, resetAt, retryAfter: Math.max(1, Math.ceil((resetAt - t) / 1000)) };
      }
      return { allowed: true, limit, remaining: Math.max(0, Math.floor(limit - estimated - 1)), resetAt };
    } catch (err) {
      storeFailed('rate limit', err);
      if (options.failureMode === 'closed') return { allowed: false, limit, remaining: 0, resetAt, retryAfter: 1 };
      return { allowed: true, limit, remaining: limit, resetAt };
    }
  };

  const limiter = ((req: Request, res: Response, next: NextFunction) => {
    take(req).then((d) => {
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
    }, next);
  }) as RateLimiter;
  limiter.take = take;
  limiter.close = () => {};
  return limiter;
}

/** Brute-force lockout with failure counters and locks kept in the store. */
export class StoreAuthLockout implements LockoutTracker {
  readonly config: Required<AuthLockoutConfig>;
  private total = 0;
  private readonly recent = new Map<string, number>();

  constructor(
    config: AuthLockoutConfig,
    private readonly store: StateStore,
    private readonly failureMode: FailureMode = 'open',
  ) {
    this.config = { ...DEFAULT_LOCKOUT, ...Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined)) };
  }

  async lockedFor(ip: string): Promise<number> {
    try {
      const ttl = await this.store.pttl(`lo:l:${ip}`);
      return ttl > 0 ? Math.ceil(ttl / 1000) : ttl === -1 ? this.config.lockoutSeconds : 0;
    } catch (err) {
      storeFailed('auth lockout', err);
      return this.failureMode === 'closed' ? 1 : 0;
    }
  }

  async fail(ip: string): Promise<boolean> {
    try {
      const n = await this.store.incr(`lo:f:${ip}`, this.config.windowSeconds * 1000);
      if (n >= this.config.maxFailures) {
        await this.store.set(`lo:l:${ip}`, '1', this.config.lockoutSeconds * 1000);
        await this.store.del(`lo:f:${ip}`);
        this.total++;
        this.recent.set(ip, Date.now() + this.config.lockoutSeconds * 1000);
        logger.warn(`Locked out ${ip} for ${this.config.lockoutSeconds}s after ${n} failed authentication attempts`);
        return true;
      }
    } catch (err) {
      storeFailed('auth lockout', err);
    }
    return false;
  }

  async success(ip: string): Promise<void> {
    await this.store.del(`lo:f:${ip}`).catch((err) => storeFailed('auth lockout', err));
  }

  /** Lockouts triggered by this instance (the store holds the cluster-wide state). */
  status() {
    const t = Date.now();
    for (const [ip, until] of this.recent) if (until <= t) this.recent.delete(ip);
    return { lockedClients: this.recent.size, trackedClients: this.recent.size, lockoutsTotal: this.total, shared: true };
  }

  close(): void {
    this.recent.clear();
  }
}
