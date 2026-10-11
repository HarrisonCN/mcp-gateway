/**
 * Load protection (13.8.0): admission control in front of tool calls (REST `/tools/call`, `/tools/stream` and the MCP
 * endpoint's POSTs). Off unless `overload.enabled: true`.
 *
 *  - Concurrency limit: at most `limit` requests run at once. With `concurrency.adaptive` (default) the limit follows
 *    the latency: per window of ~`limit` completions, the window's mean latency is compared with a slow moving average
 *    (gradient, as in Netflix concurrency-limits "gradient2"); a window more than `tolerance`× slower — or above
 *    `targetLatencyMs` when set — multiplies the limit by 0.9, a healthy window in which the limit was (nearly) used
 *    adds 1. Clamped to [min, max].
 *  - Bounded queue: requests over the limit wait in a queue of at most `queue.maxSize` (and `queue.perTenant` per
 *    tenant), for at most `queue.timeoutMs`; otherwise they are shed (HTTP 503 + Retry-After, JSON-RPC -32030).
 *  - Fair scheduling: the queue is a weighted fair queue across tenants (start-time fair queuing: each waiter gets a
 *    virtual finish tag `max(V, lastFinish[tenant]) + 1/weight`; the smallest tag is served first), so a tenant that
 *    floods the gateway is served at its weighted share and cannot starve the others. A client without a tenant is its
 *    own flow.
 *
 * @module gateway/overload
 */

export interface OverloadConfig {
  enabled?: boolean;
  concurrency?: { initial?: number; min?: number; max?: number; adaptive?: boolean; targetLatencyMs?: number; tolerance?: number };
  queue?: { maxSize?: number; perTenant?: number; timeoutMs?: number };
  fairness?: { weights?: Record<string, number>; defaultWeight?: number };
  retryAfterSeconds?: number;
}

export type ShedReason = 'queue-full' | 'tenant-queue-full' | 'queue-timeout' | 'aborted';

export interface AdmissionTicket {
  ok: true;
  /** Milliseconds spent queued. */
  waitedMs: number;
  /** Ends the request (idempotent); feeds its latency to the adaptive limit. */
  release(): void;
}
export interface AdmissionRefusal {
  ok: false;
  reason: ShedReason;
  retryAfterSeconds: number;
}
export type Admission = AdmissionTicket | AdmissionRefusal;

interface Waiter {
  tenant: string;
  finish: number;
  start: number;
  enqueuedAt: number;
  resolve: (a: Admission) => void;
  timer?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  signal?: AbortSignal;
}

export const ERR_OVERLOADED = -32030;

export class OverloadController {
  private cfg: Required<Pick<OverloadConfig, 'retryAfterSeconds'>> & OverloadConfig = { retryAfterSeconds: 1 };
  private lim = 64;
  private inflight = 0;
  private readonly flows = new Map<string, Waiter[]>();
  private readonly lastFinish = new Map<string, number>();
  private vtime = 0;
  private queued = 0;
  // adaptive state
  private longAvg = 0;
  private winSum = 0;
  private winN = 0;
  private winMaxInflight = 0;
  // stats
  admitted = 0;
  readonly shed: Record<ShedReason, number> = { 'queue-full': 0, 'tenant-queue-full': 0, 'queue-timeout': 0, aborted: 0 };
  private readonly waits = new Float64Array(1024);
  private waitN = 0;
  private latAvg = 0;

  constructor(cfg: OverloadConfig = {}) {
    this.configure(cfg, true);
  }

  get enabled(): boolean {
    return this.cfg.enabled === true;
  }

  configure(cfg: OverloadConfig = {}, initial = false): void {
    const prevInitial = this.cfg.concurrency?.initial;
    this.cfg = { ...cfg, retryAfterSeconds: cfg.retryAfterSeconds ?? 1 };
    const c = cfg.concurrency ?? {};
    if (initial || c.initial !== prevInitial || !c.adaptive) this.lim = c.initial ?? 64;
    this.lim = Math.min(this.max, Math.max(this.min, this.lim));
    this.pump();
  }

  private get min(): number {
    return this.cfg.concurrency?.min ?? 1;
  }
  private get max(): number {
    return this.cfg.concurrency?.max ?? Math.max(1024, this.cfg.concurrency?.initial ?? 64);
  }
  private get adaptive(): boolean {
    return this.cfg.concurrency?.adaptive !== false;
  }
  private weight(tenant: string): number {
    return this.cfg.fairness?.weights?.[tenant] ?? this.cfg.fairness?.defaultWeight ?? 1;
  }

  /** Current concurrency limit (integer slots). */
  get limit(): number {
    return Math.max(1, Math.floor(this.lim));
  }

  private retryAfter(): number {
    // time for the queue ahead to drain at the current limit, never below the configured floor, capped at 60 s
    const est = this.latAvg > 0 ? Math.ceil(((this.queued + 1) * this.latAvg) / this.limit / 1000) : 0;
    return Math.min(60, Math.max(this.cfg.retryAfterSeconds, est, 1));
  }

  acquire(tenant: string, opts: { signal?: AbortSignal } = {}): Promise<Admission> {
    if (this.inflight < this.limit && this.queued === 0) return Promise.resolve(this.grant(0));
    const q = this.cfg.queue ?? {};
    const maxSize = q.maxSize ?? 256;
    if (this.queued >= maxSize) return Promise.resolve(this.refuse('queue-full'));
    const flow = this.flows.get(tenant);
    if (q.perTenant !== undefined && (flow?.length ?? 0) >= q.perTenant) return Promise.resolve(this.refuse('tenant-queue-full'));
    return new Promise<Admission>((resolve) => {
      const start = Math.max(this.vtime, this.lastFinish.get(tenant) ?? 0);
      const finish = start + 1 / Math.max(0.0001, this.weight(tenant));
      this.lastFinish.set(tenant, finish);
      const w: Waiter = { tenant, start, finish, enqueuedAt: performance.now(), resolve, signal: opts.signal };
      const timeoutMs = q.timeoutMs ?? 1000;
      w.timer = setTimeout(() => this.drop(w, 'queue-timeout'), timeoutMs);
      if (opts.signal) {
        if (opts.signal.aborted) {
          clearTimeout(w.timer);
          resolve(this.refuse('aborted'));
          return;
        }
        w.onAbort = () => this.drop(w, 'aborted');
        opts.signal.addEventListener('abort', w.onAbort, { once: true });
      }
      if (flow) flow.push(w);
      else this.flows.set(tenant, [w]);
      this.queued++;
    });
  }

  private drop(w: Waiter, reason: ShedReason): void {
    const flow = this.flows.get(w.tenant);
    const i = flow ? flow.indexOf(w) : -1;
    if (i < 0) return;
    flow!.splice(i, 1);
    if (!flow!.length) this.flows.delete(w.tenant);
    this.queued--;
    this.cleanup(w);
    w.resolve(this.refuse(reason));
  }

  private cleanup(w: Waiter): void {
    if (w.timer) clearTimeout(w.timer);
    if (w.onAbort) w.signal?.removeEventListener('abort', w.onAbort);
  }

  private refuse(reason: ShedReason): AdmissionRefusal {
    this.shed[reason]++;
    return { ok: false, reason, retryAfterSeconds: this.retryAfter() };
  }

  private grant(waitedMs: number): AdmissionTicket {
    this.inflight++;
    this.admitted++;
    this.waits[this.waitN++ % this.waits.length] = waitedMs;
    const t0 = performance.now();
    let done = false;
    const atStart = this.inflight;
    return {
      ok: true,
      waitedMs,
      release: () => {
        if (done) return;
        done = true;
        this.inflight--;
        this.observe(performance.now() - t0, atStart);
        this.pump();
      },
    };
  }

  /** Next waiter by weighted fair queuing (smallest virtual finish tag; FIFO within a tenant). */
  private pump(): void {
    while (this.queued > 0 && this.inflight < this.limit) {
      let best: Waiter | undefined;
      for (const flow of this.flows.values()) {
        const h = flow[0];
        if (h && (!best || h.finish < best.finish)) best = h;
      }
      if (!best) return;
      const flow = this.flows.get(best.tenant)!;
      flow.shift();
      if (!flow.length) this.flows.delete(best.tenant);
      this.queued--;
      this.vtime = Math.max(this.vtime, best.start);
      this.cleanup(best);
      best.resolve(this.grant(performance.now() - best.enqueuedAt));
    }
    if (this.queued === 0 && this.inflight === 0) {
      // idle: forget virtual time so a returning tenant does not carry old tags
      this.vtime = 0;
      this.lastFinish.clear();
    }
  }

  /**
   * One completed request: its latency and the in-flight count it ran with. Drives the adaptive limit (exposed for
   * tests and simulations).
   */
  observe(latencyMs: number, inflight: number): void {
    this.latAvg = this.latAvg ? this.latAvg * 0.95 + latencyMs * 0.05 : latencyMs;
    if (!this.adaptive) return;
    this.winSum += latencyMs;
    this.winN++;
    this.winMaxInflight = Math.max(this.winMaxInflight, inflight);
    if (this.winN < Math.max(4, Math.min(64, this.limit))) return;
    const mean = this.winSum / this.winN;
    const tol = this.cfg.concurrency?.tolerance ?? 1.5;
    const target = this.cfg.concurrency?.targetLatencyMs;
    if (!this.longAvg) this.longAvg = mean;
    const congested = mean > this.longAvg * tol || (target !== undefined && mean > target);
    if (congested) this.lim = Math.max(this.min, this.lim * 0.9);
    else if (this.winMaxInflight >= this.limit * 0.8) this.lim = Math.min(this.max, this.lim + 1);
    // the long-term average follows slowly, and never learns from a congested window faster than from a healthy one
    this.longAvg = this.longAvg * (congested ? 0.98 : 0.9) + mean * (congested ? 0.02 : 0.1);
    this.winSum = 0;
    this.winN = 0;
    this.winMaxInflight = 0;
  }

  stats(): { enabled: boolean; limit: number; inflight: number; queued: number; queuedByTenant: Record<string, number>; admitted: number; shed: Record<ShedReason, number>; queueWaitMs: { p50: number; p99: number } } {
    const byTenant: Record<string, number> = {};
    for (const [t, f] of this.flows) byTenant[t] = f.length;
    const n = Math.min(this.waitN, this.waits.length);
    const s = Array.from(this.waits.subarray(0, n)).sort((a, b) => a - b);
    const at = (p: number) => (n ? Math.round(s[Math.min(n - 1, Math.ceil(p * n) - 1)] * 1000) / 1000 : 0);
    return { enabled: this.enabled, limit: this.limit, inflight: this.inflight, queued: this.queued, queuedByTenant: byTenant, admitted: this.admitted, shed: { ...this.shed }, queueWaitMs: { p50: at(0.5), p99: at(0.99) } };
  }

  /** Refuse everything still queued (shutdown). */
  close(): void {
    for (const flow of [...this.flows.values()]) for (const w of [...flow]) this.drop(w, 'aborted');
  }
}
