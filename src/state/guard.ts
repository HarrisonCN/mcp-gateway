/**
 * State-store circuit breaker (13.3.0).
 *
 * A shared store that stalls (Redis accepts the connection but never answers, a SQLite file locked by another
 * process) used to cost EVERY request the full command timeout before the configured failure mode applied. The guard
 * trips after one failed operation: for `cooldownMs` every operation fails at once with {@link StoreUnavailableError}
 * (callers then fail open or closed exactly as before, just without the wait); after the cooldown ONE operation is let
 * through as a probe (half-open) — success closes the breaker, failure re-opens it for another cooldown.
 *
 * Errors the store itself answered with (a Redis `-ERR …` reply) prove it is reachable and do not trip the breaker.
 *
 * @module state/guard
 */

import type { StateStore } from './store.js';
import { RespError } from './redis.js';
import { logger } from '../utils/logger.js';

export class StoreUnavailableError extends Error {
  constructor(kind: string, detail?: string) {
    super(`state store (${kind}) unavailable: breaker open${detail ? ` after "${detail}"` : ''}`);
    this.name = 'StoreUnavailableError';
  }
}

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface StoreHealth {
  state: BreakerState;
  /** Operations that failed against the store. */
  failures: number;
  /** Operations refused at once while the breaker was open. */
  fastFails: number;
  /** Times the breaker opened. */
  trips: number;
  lastError?: string;
  openedAt?: string;
}

export interface StoreGuardOptions {
  /** How long the breaker stays open before a probe (ms, default 1000). */
  cooldownMs?: number;
  now?: () => number;
}

export class GuardedStateStore implements StateStore {
  private state: BreakerState = 'closed';
  private openedAt = 0;
  private probing = false;
  private readonly stats = { failures: 0, fastFails: 0, trips: 0, lastError: undefined as string | undefined };
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(
    readonly inner: StateStore,
    options: StoreGuardOptions = {},
  ) {
    this.cooldownMs = options.cooldownMs ?? 1_000;
    this.now = options.now ?? Date.now;
  }

  get kind(): string {
    return this.inner.kind;
  }

  health(): StoreHealth {
    // an expired cooldown reads as half-open even before the next operation probes
    const state = this.state === 'open' && this.now() - this.openedAt >= this.cooldownMs ? 'half-open' : this.state;
    return { state, ...this.stats, ...(this.state !== 'closed' ? { openedAt: new Date(this.openedAt).toISOString() } : {}) };
  }

  private async run<T>(op: () => Promise<T>): Promise<T> {
    if (this.state !== 'closed') {
      const cooled = this.now() - this.openedAt >= this.cooldownMs;
      if (!cooled || this.probing) {
        this.stats.fastFails++;
        throw new StoreUnavailableError(this.inner.kind, this.stats.lastError);
      }
      this.state = 'half-open';
      this.probing = true;
    }
    try {
      const v = await op();
      if (this.state !== 'closed') logger.info(`State store (${this.inner.kind}) reachable again: breaker closed`);
      this.state = 'closed';
      return v;
    } catch (err) {
      if (err instanceof RespError) {
        // the store answered: it is reachable
        this.state = 'closed';
        throw err;
      }
      this.stats.failures++;
      this.stats.lastError = err instanceof Error ? err.message : String(err);
      if (this.state === 'closed') {
        this.stats.trips++;
        logger.warn(`State store (${this.inner.kind}) failed (${this.stats.lastError}): breaker open for ${this.cooldownMs} ms`);
      }
      this.state = 'open';
      this.openedAt = this.now();
      throw err;
    } finally {
      this.probing = false;
    }
  }

  incr(key: string, ttlMs: number, by?: number) {
    return this.run(() => this.inner.incr(key, ttlMs, by));
  }
  get(key: string) {
    return this.run(() => this.inner.get(key));
  }
  set(key: string, value: string, ttlMs?: number) {
    return this.run(() => this.inner.set(key, value, ttlMs));
  }
  del(key: string) {
    return this.run(() => this.inner.del(key));
  }
  pttl(key: string) {
    return this.run(() => this.inner.pttl(key));
  }
  ping() {
    return this.run(() => this.inner.ping());
  }
  close() {
    return this.inner.close();
  }
}
