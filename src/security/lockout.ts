/**
 * Brute-force protection: lock out client IPs after repeated authentication
 * failures (`security.authLockout`).
 *
 * Failures are counted per IP in a fixed window; reaching `maxFailures` locks
 * the IP for `lockoutSeconds` (every request then gets `429` before the
 * credential is even checked). A successful authentication clears the count.
 *
 * @module security/lockout
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { AuthLockoutConfig } from '../utils/types.js';
import { logger } from '../utils/logger.js';

export const DEFAULT_LOCKOUT: Required<AuthLockoutConfig> = {
  maxFailures: 10,
  windowSeconds: 300,
  lockoutSeconds: 900,
};

interface Entry {
  failures: number;
  windowStart: number;
  lockedUntil?: number;
}

export interface LockoutStatus {
  lockedClients: number;
  trackedClients: number;
}

export class AuthLockout {
  readonly config: Required<AuthLockoutConfig>;
  private readonly entries = new Map<string, Entry>();
  private readonly timer: NodeJS.Timeout;
  private total = 0;

  constructor(config: AuthLockoutConfig = {}, private readonly now: () => number = Date.now) {
    this.config = { ...DEFAULT_LOCKOUT, ...Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined)) };
    this.timer = setInterval(() => this.prune(), 60_000);
    this.timer.unref();
  }

  /** Seconds the IP stays locked, or 0. */
  lockedFor(ip: string): number {
    const e = this.entries.get(ip);
    const t = this.now();
    if (!e?.lockedUntil) return 0;
    if (e.lockedUntil <= t) {
      this.entries.delete(ip);
      return 0;
    }
    return Math.ceil((e.lockedUntil - t) / 1000);
  }

  /** Record a failure; returns true when this failure triggered a lockout. */
  fail(ip: string): boolean {
    const t = this.now();
    let e = this.entries.get(ip);
    if (!e || t - e.windowStart >= this.config.windowSeconds * 1000) {
      e = { failures: 0, windowStart: t };
      this.entries.set(ip, e);
    }
    if (e.lockedUntil && e.lockedUntil > t) return false;
    e.failures++;
    if (e.failures >= this.config.maxFailures) {
      e.lockedUntil = t + this.config.lockoutSeconds * 1000;
      this.total++;
      logger.warn(
        `Locked out ${ip} for ${this.config.lockoutSeconds}s after ${e.failures} failed authentication attempts`,
      );
      return true;
    }
    return false;
  }

  success(ip: string): void {
    const e = this.entries.get(ip);
    if (e && !(e.lockedUntil && e.lockedUntil > this.now())) this.entries.delete(ip);
  }

  status(): LockoutStatus & { lockoutsTotal: number } {
    const t = this.now();
    let locked = 0;
    for (const e of this.entries.values()) if (e.lockedUntil && e.lockedUntil > t) locked++;
    return { lockedClients: locked, trackedClients: this.entries.size, lockoutsTotal: this.total };
  }

  private prune(): void {
    const t = this.now();
    for (const [ip, e] of this.entries) {
      const expired = e.lockedUntil ? e.lockedUntil <= t : t - e.windowStart >= this.config.windowSeconds * 1000;
      if (expired) this.entries.delete(ip);
    }
  }

  close(): void {
    clearInterval(this.timer);
    this.entries.clear();
  }
}

/**
 * Wrap an auth middleware: locked IPs get `429`, a `401` / `403` answer from
 * the auth middleware counts as a failure, reaching `next()` as a success.
 */
export function withLockout(auth: RequestHandler, lockout: () => AuthLockout | undefined): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const lo = lockout();
    if (!lo) return auth(req, res, next);
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const wait = lo.lockedFor(ip);
    if (wait > 0) {
      res.status(429).set('Retry-After', String(wait)).json({
        error: 'Too Many Requests',
        message: 'Too many failed authentication attempts; try again later',
        retryAfter: wait,
      });
      return;
    }
    let passed = false;
    res.once('finish', () => {
      if (!passed && res.statusCode === 401) lo.fail(ip);
    });
    auth(req, res, (err?: unknown) => {
      passed = true;
      lo.success(ip);
      next(err as never);
    });
  };
}
