/**
 * Per-stage latency of the call pipeline (13.8.0): a fixed-size ring of recent samples per stage, read as
 * p50 / p95 / p99 / max / mean. Recording is a couple of array writes, so it is always on.
 *
 * Stages (see docs/perf/p99-analysis.md):
 *  - `queue`    waiting for admission (`overload:`; only when load protection is on)
 *  - `auth`     HTTP authentication (API key / JWT / OAuth, lockout, tenant scope), plus the rate limit on REST
 *  - `authz`    the central authorizer (client / tenant / delegation scope, tool exposure)
 *  - `policy`   plugin `onToolCall`, tool policy rules / approvals, residency, quotas and budgets
 *  - `hooks`    feature-module call hooks (before + after) and the output filter
 *  - `routing`  final authorization, routing split, security snapshot
 *  - `cache`    result cache lookup / store and in-flight de-duplication (excluding the upstream call it wraps)
 *  - `upstream` the upstream call (secrets injection, balancing, failover, resend)
 *  - `finish`   `onResponse` plugins, metrics, request log
 *  - `total`    whole call inside the invoker
 *
 * @module gateway/stages
 */

export const STAGES = ['queue', 'auth', 'authz', 'policy', 'hooks', 'routing', 'cache', 'upstream', 'finish', 'total'] as const;
export type Stage = (typeof STAGES)[number];

export interface StageSummary {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

class Ring {
  private readonly buf: Float64Array;
  private n = 0;
  total = 0;
  constructor(size: number) {
    this.buf = new Float64Array(size);
  }
  push(v: number): void {
    this.buf[this.n % this.buf.length] = v;
    this.n++;
    this.total++;
  }
  summary(): StageSummary {
    const len = Math.min(this.n, this.buf.length);
    if (!len) return { count: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    const s = Array.from(this.buf.subarray(0, len)).sort((a, b) => a - b);
    const at = (p: number) => s[Math.min(len - 1, Math.max(0, Math.ceil(p * len) - 1))];
    const r = (x: number) => Math.round(x * 1000) / 1000;
    return { count: this.total, mean: r(s.reduce((a, b) => a + b, 0) / len), p50: r(at(0.5)), p95: r(at(0.95)), p99: r(at(0.99)), max: r(s[len - 1]) };
  }
}

export class StageTimer {
  private readonly rings = new Map<Stage, Ring>();
  constructor(private readonly window = 4096) {}

  record(stage: Stage, ms: number): void {
    if (!(ms >= 0)) return;
    let r = this.rings.get(stage);
    if (!r) this.rings.set(stage, (r = new Ring(this.window)));
    r.push(ms);
  }

  report(): { window: number; stages: Partial<Record<Stage, StageSummary>> } {
    const stages: Partial<Record<Stage, StageSummary>> = {};
    for (const s of STAGES) {
      const r = this.rings.get(s);
      if (r) stages[s] = r.summary();
    }
    return { window: this.window, stages };
  }

  reset(): void {
    this.rings.clear();
  }

  /** Prometheus summary samples (`mcp_gateway_stage_duration_ms{stage,quantile}`). */
  prometheus(): string[] {
    const out = ['# HELP mcp_gateway_stage_duration_ms Call pipeline latency per stage over the recent window, milliseconds (13.8)', '# TYPE mcp_gateway_stage_duration_ms summary'];
    const rep = this.report().stages;
    for (const s of STAGES) {
      const v = rep[s];
      if (!v) continue;
      out.push(`mcp_gateway_stage_duration_ms{stage="${s}",quantile="0.5"} ${v.p50}`);
      out.push(`mcp_gateway_stage_duration_ms{stage="${s}",quantile="0.95"} ${v.p95}`);
      out.push(`mcp_gateway_stage_duration_ms{stage="${s}",quantile="0.99"} ${v.p99}`);
      out.push(`mcp_gateway_stage_duration_ms_count{stage="${s}"} ${v.count}`);
    }
    return out;
  }
}

/**
 * Per-call lap clock: `lap(stage)` adds the time since the previous lap to `stage`, `add(stage, ms)` adds a measured
 * span (and moves the lap mark), `flush()` records each stage the call reached once, plus `total`.
 */
export class CallClock {
  private readonly t0 = performance.now();
  private last = this.t0;
  private readonly acc = new Map<Stage, number>();
  constructor(private readonly timer: StageTimer | undefined) {}
  lap(stage: Stage): void {
    const now = performance.now();
    this.acc.set(stage, (this.acc.get(stage) ?? 0) + (now - this.last));
    this.last = now;
  }
  add(stage: Stage, ms: number): void {
    this.acc.set(stage, (this.acc.get(stage) ?? 0) + ms);
  }
  mark(): void {
    this.last = performance.now();
  }
  /** 14.8.0: per-call annotations for the call trace (cache status, final route). */
  readonly notes = new Map<string, string>();
  note(key: string, value: string): void {
    this.notes.set(key, value);
  }
  /** 14.8.0: this call's stage times so far (ms) and its elapsed time — read before {@link flush}. */
  view(): { stages: Map<Stage, number>; totalMs: number } {
    return { stages: new Map(this.acc), totalMs: performance.now() - this.t0 };
  }
  flush(): void {
    if (!this.timer) return;
    for (const [s, ms] of this.acc) this.timer.record(s, ms);
    this.timer.record('total', performance.now() - this.t0);
    this.acc.clear();
  }
}
