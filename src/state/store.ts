/**
 * Pluggable shared state for multi-instance deployments.
 *
 * Rate-limit windows, brute-force lockouts and MCP session metadata go
 * through a `StateStore`. The default `MemoryStateStore` keeps everything in
 * the process (single instance, the pre-1.4 behaviour); `RedisStateStore`
 * (see `./redis.ts`) shares it between gateway replicas behind a load
 * balancer, so limits hold cluster-wide and an MCP session opened on one
 * replica is accepted by the others.
 *
 * @module state/store
 */

export interface StateStore {
  /** `memory`, `redis`, or a custom name. */
  readonly kind: string;
  /**
   * Atomically add `by` (default 1) to the integer at `key` and return the new
   * value. A missing key starts at 0 and expires after `ttlMs`; an existing
   * key keeps its expiry.
   */
  incr(key: string, ttlMs: number, by?: number): Promise<number>;
  get(key: string): Promise<string | undefined>;
  /** Set `key` (optionally expiring after `ttlMs`). */
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Remaining time to live in ms; -1 = no expiry, -2 = missing. */
  pttl(key: string): Promise<number>;
  /** Health check (resolves when reachable). */
  ping(): Promise<void>;
  close(): Promise<void>;
  /** 13.3.0: breaker state of a guarded shared store (see state/guard). */
  health?(): import('./guard.js').StoreHealth;
}

interface Entry {
  value: string;
  expiresAt?: number;
}

/** In-process store (default). */
export class MemoryStateStore implements StateStore {
  readonly kind = 'memory';
  private readonly data = new Map<string, Entry>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly now: () => number = Date.now) {
    this.timer = setInterval(() => this.sweep(), 30_000);
    this.timer.unref();
  }

  private live(key: string): Entry | undefined {
    const e = this.data.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== undefined && e.expiresAt <= this.now()) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }

  async incr(key: string, ttlMs: number, by = 1): Promise<number> {
    return this.incrSync(key, ttlMs, by);
  }

  /** Synchronous variant (used by the in-memory fast paths). */
  incrSync(key: string, ttlMs: number, by = 1): number {
    const e = this.live(key);
    if (!e) {
      this.data.set(key, { value: String(by), expiresAt: ttlMs > 0 ? this.now() + ttlMs : undefined });
      return by;
    }
    const n = (Number.parseInt(e.value, 10) || 0) + by;
    e.value = String(n);
    return n;
  }

  async get(key: string): Promise<string | undefined> {
    return this.live(key)?.value;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.data.set(key, { value, expiresAt: ttlMs && ttlMs > 0 ? this.now() + ttlMs : undefined });
  }

  async del(key: string): Promise<void> {
    this.data.delete(key);
  }

  async pttl(key: string): Promise<number> {
    const e = this.live(key);
    if (!e) return -2;
    return e.expiresAt === undefined ? -1 : Math.max(0, e.expiresAt - this.now());
  }

  async ping(): Promise<void> {}

  /** Number of live keys (tests / diagnostics). */
  size(): number {
    this.sweep();
    return this.data.size;
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, e] of this.data) if (e.expiresAt !== undefined && e.expiresAt <= t) this.data.delete(k);
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    this.data.clear();
  }
}

/** Prefixes every key (namespacing several gateways in one Redis). */
export class PrefixedStateStore implements StateStore {
  constructor(
    private readonly inner: StateStore,
    private readonly prefix: string,
  ) {}
  get kind(): string {
    return this.inner.kind;
  }
  incr(key: string, ttlMs: number, by?: number) {
    return this.inner.incr(this.prefix + key, ttlMs, by);
  }
  get(key: string) {
    return this.inner.get(this.prefix + key);
  }
  set(key: string, value: string, ttlMs?: number) {
    return this.inner.set(this.prefix + key, value, ttlMs);
  }
  del(key: string) {
    return this.inner.del(this.prefix + key);
  }
  pttl(key: string) {
    return this.inner.pttl(this.prefix + key);
  }
  ping() {
    return this.inner.ping();
  }
  close() {
    return this.inner.close();
  }
  health() {
    return this.inner.health?.() ?? { state: 'closed' as const, failures: 0, fastFails: 0, trips: 0 };
  }
}

