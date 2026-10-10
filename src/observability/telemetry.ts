/**
 * Reliability telemetry (13.3.0): the counters and gauges operators need to see WHY a call went where it went, who
 * it ran for, and what failed — rendered as Prometheus text on `/metrics` and, when `observability.metrics.otlp` is
 * set, pushed as OTLP/HTTP JSON (`resourceMetrics`) to an OpenTelemetry collector. No SDK dependency.
 *
 * | metric | type | labels |
 * |---|---|---|
 * | `mcp_gateway_route_final_total` | counter | `server` (logical, after reroutes / splits), `upstream` (member that answered) |
 * | `mcp_gateway_calls_by_principal_total` | counter | `principal_type` = direct / delegated / anonymous |
 * | `mcp_gateway_policy_denials_by_reason_total` | counter | `reason` (the audit `decision`: deny, scope, budget, quota, reroute-denied, …) |
 * | `mcp_gateway_module_failures_total` | counter | `module` |
 * | `mcp_gateway_module_failed` | gauge | `module` (1 while failed) |
 * | `mcp_gateway_config_generation` | gauge | — |
 * | `mcp_gateway_config_generations_alive` | gauge | — (current + draining) |
 * | `mcp_gateway_reloads_total` | counter | `result` = committed / rolled_back |
 * | `mcp_gateway_upstream_failovers_total` | counter | `server` |
 * | `mcp_gateway_upstream_resends_total` | counter | — (session-expired resends) |
 * | `mcp_gateway_upstream_recycles_total` | counter | — (hung sessions recycled) |
 * | `mcp_gateway_state_store_up` | gauge | `backend` (0 while the store breaker is open) |
 * | `mcp_gateway_state_store_failures_total` | counter | `backend` |
 *
 * Label values never carry a principal: the effective principal (subject / actor) appears only on spans, and there
 * as a keyed hash by default (`observability.principal`, see {@link principalAttribute}).
 *
 * @module observability/telemetry
 */

import { createHmac, randomBytes } from 'node:crypto';
import { logger } from '../utils/logger.js';

export type PrincipalAttributeMode = 'hash' | 'plain' | 'omit';

export interface PrincipalTelemetryConfig {
  /** How subject / actor ids appear on spans: `hash` (default, HMAC-SHA256, 16 hex chars), `plain`, or `omit`. */
  mode?: PrincipalAttributeMode;
  /** HMAC key (supports `${ENV}`), so hashes correlate across instances and restarts; random per process when unset. */
  hashKey?: string;
}

export interface MetricsExportConfig {
  otlp?: { endpoint: string; headers?: Record<string, string>; intervalMs?: number };
}

type Labels = Record<string, string>;

const keyOf = (l: Labels) => JSON.stringify(Object.entries(l).sort(([a], [b]) => a.localeCompare(b)));
const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const fmt = (l: Labels) => {
  const e = Object.entries(l);
  return e.length ? `{${e.map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}` : '';
};

/** A counter with labels (bounded label sets only). */
export class Counter {
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, by = 1): void {
    const k = keyOf(labels);
    const cur = this.values.get(k);
    if (cur) cur.value += by;
    else this.values.set(k, { labels, value: by });
  }
  get(labels: Labels = {}): number {
    return this.values.get(keyOf(labels))?.value ?? 0;
  }
  series(): Array<{ labels: Labels; value: number }> {
    return [...this.values.values()];
  }
}

/** A gauge read at scrape time. */
export interface GaugeDef {
  name: string;
  help: string;
  read: () => Array<{ labels: Labels; value: number }>;
}

const MAX_SERIES = 1_000;

export class Telemetry {
  readonly routeFinal = new Counter('mcp_gateway_route_final_total', 'Calls by final route: logical server after reroutes / splits and the upstream member that answered (13.3)');
  readonly principals = new Counter('mcp_gateway_calls_by_principal_total', 'Calls by effective principal type (direct / delegated / anonymous) (13.3)');
  readonly denials = new Counter('mcp_gateway_policy_denials_by_reason_total', 'Calls refused by the gateway, by audit decision / reason (13.3)');
  readonly moduleFailures = new Counter('mcp_gateway_module_failures_total', 'Feature module failures (init / reconfigure / runtime) per module (13.3)');
  readonly reloads = new Counter('mcp_gateway_reloads_total', 'Hot reloads by result (committed / rolled_back) (13.3)');
  readonly failovers = new Counter('mcp_gateway_upstream_failovers_total', 'Calls retried on another load-balanced member (13.3)');
  readonly resends = new Counter('mcp_gateway_upstream_resends_total', 'Calls resent once after the upstream refused them unprocessed (session expired) (13.3)');
  readonly recycles = new Counter('mcp_gateway_upstream_recycles_total', 'Upstream sessions recycled after failing consecutive health pings (13.3)');
  readonly storeFailures = new Counter('mcp_gateway_state_store_failures_total', 'Shared state store operations that failed (13.3)');
  private readonly gauges: GaugeDef[] = [];
  private readonly counters: Counter[] = [this.routeFinal, this.principals, this.denials, this.moduleFailures, this.reloads, this.failovers, this.resends, this.recycles, this.storeFailures];
  private readonly hashKey: Buffer;
  private readonly mode: PrincipalAttributeMode;
  private exportTimer?: NodeJS.Timeout;

  constructor(principal: PrincipalTelemetryConfig = {}) {
    this.mode = principal.mode ?? 'hash';
    this.hashKey = principal.hashKey ? Buffer.from(principal.hashKey) : randomBytes(32);
  }

  gauge(def: GaugeDef): void {
    this.gauges.push(def);
  }

  private readonly collectors: Array<() => void> = [];
  /** Run `fn` before every render (sync counters kept elsewhere, e.g. the store breaker's failure count). */
  onCollect(fn: () => void): void {
    this.collectors.push(fn);
  }
  private collect(): void {
    for (const f of this.collectors) {
      try {
        f();
      } catch {
        /* a broken collector never breaks the scrape */
      }
    }
  }

  /** Set a counter series to an absolute value (for counts kept by another component). */
  static set(c: Counter, labels: Record<string, string>, value: number): void {
    c.inc(labels, value - c.get(labels));
  }

  /** Span attribute value for a principal id (subject / actor) under `observability.principal.mode`. */
  principalAttribute(id: string | undefined): string | undefined {
    if (id === undefined || id === '') return undefined;
    if (this.mode === 'omit') return undefined;
    if (this.mode === 'plain') return id;
    return createHmac('sha256', this.hashKey).update(id).digest('hex').slice(0, 16);
  }

  get principalMode(): PrincipalAttributeMode {
    return this.mode;
  }

  /** Count a series only while the counter stays bounded (never let a label explode memory). */
  private bounded(c: Counter, labels: Labels): void {
    if (c.series().length >= MAX_SERIES && c.get(labels) === 0) return;
    c.inc(labels);
  }

  route(server: string, upstream: string): void {
    this.bounded(this.routeFinal, { server, upstream });
  }

  deny(reason: string): void {
    this.bounded(this.denials, { reason });
  }

  principal(type: 'direct' | 'delegated' | 'anonymous'): void {
    this.principals.inc({ principal_type: type });
  }

  /** Prometheus exposition lines. */
  prometheus(): string[] {
    this.collect();
    const out: string[] = [];
    for (const c of this.counters) {
      out.push(`# HELP ${c.name} ${c.help}`, `# TYPE ${c.name} counter`);
      const series = c.series();
      if (!series.length) out.push(`${c.name} 0`);
      for (const s of series) out.push(`${c.name}${fmt(s.labels)} ${s.value}`);
    }
    for (const g of this.gauges) {
      out.push(`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} gauge`);
      for (const s of g.read()) out.push(`${g.name}${fmt(s.labels)} ${s.value}`);
    }
    return out;
  }

  /** OTLP/JSON `ExportMetricsServiceRequest` body (cumulative sums + gauges). */
  otlp(resource: Record<string, string>, startNs: string, nowNs = `${BigInt(Date.now()) * 1_000_000n}`): unknown {
    this.collect();
    const attrs = (l: Labels) => Object.entries(l).map(([key, v]) => ({ key, value: { stringValue: v } }));
    const metrics: unknown[] = [];
    for (const c of this.counters) {
      metrics.push({
        name: c.name.replace(/_total$/, '').replace(/_/g, '.'),
        description: c.help,
        sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: c.series().map((s) => ({ attributes: attrs(s.labels), startTimeUnixNano: startNs, timeUnixNano: nowNs, asInt: String(s.value) })) },
      });
    }
    for (const g of this.gauges) {
      metrics.push({ name: g.name.replace(/_/g, '.'), description: g.help, gauge: { dataPoints: g.read().map((s) => ({ attributes: attrs(s.labels), timeUnixNano: nowNs, asDouble: s.value })) } });
    }
    return {
      resourceMetrics: [
        {
          resource: { attributes: attrs(resource) },
          scopeMetrics: [{ scope: { name: 'mcp-gateway' }, metrics }],
        },
      ],
    };
  }

  /** Push {@link otlp} every `intervalMs` (default 15 s) to an OTLP/HTTP metrics endpoint. */
  startExport(cfg: MetricsExportConfig['otlp'], resource: Record<string, string>, post: (url: string, body: string, headers: Record<string, string>) => Promise<unknown> = defaultPost): void {
    if (!cfg?.endpoint) return;
    const start = `${BigInt(Date.now()) * 1_000_000n}`;
    const push = () =>
      post(cfg.endpoint, JSON.stringify(this.otlp(resource, start)), { 'content-type': 'application/json', ...(cfg.headers ?? {}) }).catch((err: unknown) =>
        logger.debug(`OTLP metrics export failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    this.exportTimer = setInterval(push, cfg.intervalMs ?? 15_000);
    this.exportTimer.unref();
  }

  stop(): void {
    if (this.exportTimer) clearInterval(this.exportTimer);
    this.exportTimer = undefined;
  }
}

let current: Telemetry | undefined;
/** Make `t` the process-wide principal-attribute policy (the gateway that started last). */
export function setCurrentTelemetry(t: Telemetry | undefined): void {
  current = t;
}
const fallback = new Telemetry();
/** Span attribute for a principal id under the running gateway's `observability.principal` (hash by default). */
export function principalAttr(id: string | undefined): string | undefined {
  return (current ?? fallback).principalAttribute(id);
}

async function defaultPost(url: string, body: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { method: 'POST', body, headers, signal: AbortSignal.timeout(5_000) });
  await res.body?.cancel().catch(() => undefined);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return undefined;
}
