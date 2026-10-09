/**
 * Metrics collection and aggregation for mcp-gateway
 *
 * Audit fixes:
 *  - Prometheus `*_total` series were the count of the *last minute*, which
 *    goes down over time and breaks `rate()`; they are now real monotonic
 *    counters kept independently of the retention window.
 *  - Label values are escaped per the exposition format.
 *  - Percentiles use the nearest-rank method; `requestsPerMinute` without a
 *    window is computed from the actual time span instead of request count.
 *  - The in-memory log is capped (`maxEntries`) so high traffic within the
 *    retention window cannot exhaust memory; cleanup timer is unref()'d.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { RequestMetric, AggregatedMetrics, MonitorConfig } from '../utils/types.js';
import { matchesQuery, type AuditPage, type AuditQuery, type AuditStore } from './audit.js';
import { logger } from '../utils/logger.js';
import { redactString } from '../security/redact.js';

export interface MetricsOptions {
  /** Hard cap on retained request records (oldest dropped first). Default 100k. */
  maxEntries?: number;
}

/** Per-server connection state exported as Prometheus gauges / counters. */
export interface ServerStateSample {
  id: string;
  status: string;
  /** 1 when connected (online or degraded), else 0. */
  up: number;
  /** Successful automatic reconnects since start (monotonic). */
  reconnects: number;
  /** Consecutive failed reconnect attempts right now. */
  reconnectAttempt: number;
  latencyMs?: number;
}

const SERVER_STATUSES = ['online', 'degraded', 'reconnecting', 'offline', 'unknown'];

interface ServerCounters {
  requests: number;
  errors: number;
  durationMsSum: number;
  /** Cumulative histogram bucket counts (aligned with LATENCY_BUCKETS_SECONDS). */
  buckets: number[];
}

/** Bucket bounds (seconds) of `mcp_gateway_request_duration_seconds`. */
export const LATENCY_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

/** Extra Prometheus lines from feature modules (11.2), keyed by source id (re-registering replaces). */
const metricSources = new Map<string, () => string[]>();
export function registerMetricSource(id: string, fn: () => string[]): void {
  metricSources.set(id, fn);
}

export class MetricsCollector extends EventEmitter {
  private metrics: RequestMetric[] = [];
  private readonly retentionMs: number;
  private readonly maxEntries: number;
  private cleanupInterval?: NodeJS.Timeout;
  private readonly counters = new Map<string, ServerCounters>();
  private audit?: AuditStore;
  private auditTimer?: NodeJS.Timeout;
  private auditFailures = 0;

  constructor(config?: MonitorConfig, options: MetricsOptions = {}) {
    super();
    this.retentionMs = (config?.retentionHours ?? 24) * 60 * 60 * 1000;
    this.maxEntries = Math.max(1, options.maxEntries ?? 100_000);
  }

  // ─── Recording ──────────────────────────────────────────────────────────────

  record(metric: Omit<RequestMetric, 'id' | 'timestamp'>): RequestMetric {
    const full: RequestMetric = {
      ...metric,
      id: randomUUID(),
      timestamp: new Date(),
    };
    // Upstream error messages often echo arguments / tokens: mask them before
    // they reach the request log, the audit log, the API and the dashboard.
    if (full.errorMessage) full.errorMessage = redactString(full.errorMessage);
    this.metrics.push(full);
    // Trim in batches to keep this amortised O(1).
    if (this.metrics.length > this.maxEntries * 1.1) {
      this.metrics.splice(0, this.metrics.length - this.maxEntries);
    }

    const c = this.counters.get(metric.serverId) ?? {
      requests: 0,
      errors: 0,
      durationMsSum: 0,
      buckets: new Array<number>(LATENCY_BUCKETS_SECONDS.length).fill(0),
    };
    c.requests++;
    if (!metric.success) c.errors++;
    c.durationMsSum += metric.durationMs;
    const sec = metric.durationMs / 1000;
    LATENCY_BUCKETS_SECONDS.forEach((le, i) => {
      if (sec <= le) c.buckets[i]!++;
    });
    this.counters.set(metric.serverId, c);

    if (this.audit) {
      try {
        this.audit.append(full);
        this.auditFailures = 0;
      } catch (err) {
        // Never fail a request because the audit log is unwritable; log, but not on every call.
        if (this.auditFailures++ % 100 === 0) {
          logger.error(`Audit log write failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    this.emit('metric', full);
    return full;
  }

  // ─── Audit log ──────────────────────────────────────────────────────────────

  /**
   * Persist every record to `store` as well (history beyond the in-memory
   * retention and across restarts). `retentionDays` > 0 prunes hourly.
   */
  setAuditStore(store: AuditStore | undefined, retentionDays = 0): void {
    clearInterval(this.auditTimer);
    this.auditTimer = undefined;
    this.audit = store;
    if (store && retentionDays > 0) {
      const prune = () => {
        try {
          const n = store.prune(Date.now() - retentionDays * 86_400_000);
          if (n > 0) logger.debug(`Audit log: pruned ${n} records older than ${retentionDays} days`);
        } catch (err) {
          logger.warn(`Audit log prune failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      prune();
      this.auditTimer = setInterval(prune, 3_600_000);
      this.auditTimer.unref();
    }
  }

  getAuditStore(): AuditStore | undefined {
    return this.audit;
  }

  /**
   * Query request history, newest first: the audit store when one is set,
   * otherwise the in-memory log. Throws RangeError on an invalid cursor.
   */
  queryRequests(q: AuditQuery): AuditPage & { source: 'audit' | 'memory' } {
    if (this.audit) return { ...this.audit.query(q), source: 'audit' };
    let start = this.metrics.length - 1;
    if (q.cursor !== undefined) {
      const m = /^m(.+)$/.exec(q.cursor);
      const idx = m ? this.metrics.findIndex((x) => x.id === m[1]) : -1;
      if (idx < 0) throw new RangeError('invalid cursor');
      start = idx - 1;
    }
    const out: RequestMetric[] = [];
    let i = start;
    for (; i >= 0 && out.length < q.limit; i--) {
      if (matchesQuery(this.metrics[i]!, q)) out.push(this.metrics[i]!);
    }
    // Is there anything older that matches?
    let more = false;
    for (let j = i; j >= 0; j--) {
      if (matchesQuery(this.metrics[j]!, q)) {
        more = true;
        break;
      }
    }
    const last = out[out.length - 1];
    return more && last ? { requests: out, nextCursor: `m${last.id}`, source: 'memory' } : { requests: out, source: 'memory' };
  }

  // ─── Aggregation ────────────────────────────────────────────────────────────

  aggregate(windowMs?: number): AggregatedMetrics {
    const now = Date.now();
    const validWindow = windowMs !== undefined && Number.isFinite(windowMs) && windowMs > 0;
    const cutoff = validWindow ? now - windowMs : 0;
    const recent = cutoff > 0 ? this.metrics.filter((m) => m.timestamp.getTime() >= cutoff) : this.metrics;

    if (recent.length === 0) {
      return {
        totalRequests: 0,
        successRate: 1,
        avgLatencyMs: 0,
        p95LatencyMs: 0,
        p99LatencyMs: 0,
        requestsPerMinute: 0,
        topTools: [],
        topServers: [],
        errorsByServer: {},
      };
    }

    let successCount = 0;
    let latencySum = 0;
    const latencies = new Array<number>(recent.length);
    const toolCounts = new Map<string, number>();
    const serverCounts = new Map<string, number>();
    const errorsByServer: Record<string, number> = {};

    recent.forEach((m, i) => {
      latencies[i] = m.durationMs;
      latencySum += m.durationMs;
      if (m.success) successCount++;
      else errorsByServer[m.serverId] = (errorsByServer[m.serverId] ?? 0) + 1;
      toolCounts.set(m.toolName, (toolCounts.get(m.toolName) ?? 0) + 1);
      serverCounts.set(m.serverId, (serverCounts.get(m.serverId) ?? 0) + 1);
    });
    latencies.sort((a, b) => a - b);

    const spanMs = validWindow ? windowMs : Math.max(60_000, now - recent[0]!.timestamp.getTime());

    return {
      totalRequests: recent.length,
      successRate: successCount / recent.length,
      avgLatencyMs: latencySum / recent.length,
      p95LatencyMs: percentile(latencies, 0.95),
      p99LatencyMs: percentile(latencies, 0.99),
      requestsPerMinute: recent.length / (spanMs / 60_000),
      topTools: topN(toolCounts).map(([name, count]) => ({ name, count })),
      topServers: topN(serverCounts).map(([id, count]) => ({ id, count })),
      errorsByServer,
    };
  }

  // ─── Prometheus Format ──────────────────────────────────────────────────────

  toPrometheusText(servers: ServerStateSample[] = []): string {
    const agg = this.aggregate(60_000); // gauges over the last minute
    let total = 0;
    let errors = 0;
    for (const c of this.counters.values()) {
      total += c.requests;
      errors += c.errors;
    }

    const lines: string[] = [
      '# HELP mcp_gateway_requests_total Total number of tool calls since start',
      '# TYPE mcp_gateway_requests_total counter',
      `mcp_gateway_requests_total ${total}`,
      '# HELP mcp_gateway_errors_total Total number of failed tool calls since start',
      '# TYPE mcp_gateway_errors_total counter',
      `mcp_gateway_errors_total ${errors}`,
      '# HELP mcp_gateway_server_requests_total Tool calls per server since start',
      '# TYPE mcp_gateway_server_requests_total counter',
    ];
    for (const [id, c] of this.counters) {
      lines.push(`mcp_gateway_server_requests_total{server="${escapeLabel(id)}"} ${c.requests}`);
    }
    lines.push(
      '# HELP mcp_gateway_server_errors_total Failed tool calls per server since start',
      '# TYPE mcp_gateway_server_errors_total counter',
    );
    for (const [id, c] of this.counters) {
      lines.push(`mcp_gateway_server_errors_total{server="${escapeLabel(id)}"} ${c.errors}`);
    }
    lines.push(
      '# HELP mcp_gateway_server_duration_ms_sum Sum of tool call latency per server since start (ms)',
      '# TYPE mcp_gateway_server_duration_ms_sum counter',
    );
    for (const [id, c] of this.counters) {
      lines.push(`mcp_gateway_server_duration_ms_sum{server="${escapeLabel(id)}"} ${c.durationMsSum}`);
    }
    lines.push(
      '# HELP mcp_gateway_request_duration_seconds Upstream call latency per server (histogram)',
      '# TYPE mcp_gateway_request_duration_seconds histogram',
    );
    for (const [id, c] of this.counters) {
      const server = escapeLabel(id);
      LATENCY_BUCKETS_SECONDS.forEach((le, i) => {
        lines.push(`mcp_gateway_request_duration_seconds_bucket{server="${server}",le="${le}"} ${c.buckets[i]}`);
      });
      lines.push(`mcp_gateway_request_duration_seconds_bucket{server="${server}",le="+Inf"} ${c.requests}`);
      lines.push(`mcp_gateway_request_duration_seconds_sum{server="${server}"} ${(c.durationMsSum / 1000).toFixed(6)}`);
      lines.push(`mcp_gateway_request_duration_seconds_count{server="${server}"} ${c.requests}`);
    }
    lines.push(
      '# HELP mcp_gateway_success_rate Request success rate over the last minute (0-1)',
      '# TYPE mcp_gateway_success_rate gauge',
      `mcp_gateway_success_rate ${agg.successRate.toFixed(4)}`,
      '# HELP mcp_gateway_latency_avg_ms Average latency over the last minute (ms)',
      '# TYPE mcp_gateway_latency_avg_ms gauge',
      `mcp_gateway_latency_avg_ms ${agg.avgLatencyMs.toFixed(2)}`,
      '# HELP mcp_gateway_latency_p95_ms P95 latency over the last minute (ms)',
      '# TYPE mcp_gateway_latency_p95_ms gauge',
      `mcp_gateway_latency_p95_ms ${agg.p95LatencyMs.toFixed(2)}`,
      '# HELP mcp_gateway_latency_p99_ms P99 latency over the last minute (ms)',
      '# TYPE mcp_gateway_latency_p99_ms gauge',
      `mcp_gateway_latency_p99_ms ${agg.p99LatencyMs.toFixed(2)}`,
    );

    if (servers.length > 0) {
      lines.push(
        '# HELP mcp_gateway_server_up Whether the gateway currently has a session with the server (1/0)',
        '# TYPE mcp_gateway_server_up gauge',
      );
      for (const s of servers) lines.push(`mcp_gateway_server_up{server="${escapeLabel(s.id)}"} ${s.up}`);
      lines.push(
        '# HELP mcp_gateway_server_status Current server status (1 for the active status label)',
        '# TYPE mcp_gateway_server_status gauge',
      );
      for (const s of servers) {
        for (const st of SERVER_STATUSES) {
          lines.push(
            `mcp_gateway_server_status{server="${escapeLabel(s.id)}",status="${st}"} ${s.status === st ? 1 : 0}`,
          );
        }
      }
      lines.push(
        '# HELP mcp_gateway_server_reconnects_total Successful automatic reconnects per server since start',
        '# TYPE mcp_gateway_server_reconnects_total counter',
      );
      for (const s of servers) {
        lines.push(`mcp_gateway_server_reconnects_total{server="${escapeLabel(s.id)}"} ${s.reconnects}`);
      }
      lines.push(
        '# HELP mcp_gateway_server_reconnect_attempt Consecutive failed reconnect attempts (0 when healthy)',
        '# TYPE mcp_gateway_server_reconnect_attempt gauge',
      );
      for (const s of servers) {
        lines.push(`mcp_gateway_server_reconnect_attempt{server="${escapeLabel(s.id)}"} ${s.reconnectAttempt}`);
      }
      const pinged = servers.filter((s) => typeof s.latencyMs === 'number');
      if (pinged.length > 0) {
        lines.push(
          '# HELP mcp_gateway_server_ping_ms Latency of the last health ping (ms)',
          '# TYPE mcp_gateway_server_ping_ms gauge',
        );
        for (const s of pinged) lines.push(`mcp_gateway_server_ping_ms{server="${escapeLabel(s.id)}"} ${s.latencyMs}`);
      }
    }
    lines.push('');

    for (const src of metricSources.values()) {
      try {
        lines.push(...src());
      } catch {
        /* a failing source never breaks /metrics */
      }
    }
    return lines.join('\n');
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  start(): void {
    this.stop();
    this.cleanupInterval = setInterval(() => this.prune(), 60_000);
    this.cleanupInterval.unref();
  }

  /** Drop records older than the retention period. */
  prune(now = Date.now()): number {
    const cutoff = now - this.retentionMs;
    // Records are appended in time order: find the first one to keep.
    let i = 0;
    while (i < this.metrics.length && this.metrics[i]!.timestamp.getTime() < cutoff) i++;
    if (i > 0) this.metrics.splice(0, i);
    return i;
  }

  stop(): void {
    clearInterval(this.auditTimer);
    this.auditTimer = undefined;
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
  }

  getRecent(limit = 100): RequestMetric[] {
    if (!Number.isFinite(limit) || limit <= 0) return [];
    return this.metrics.slice(-Math.floor(limit)).reverse();
  }

  /** Newest-first records matching `pred`, at most `limit`. */
  getRecentWhere(limit: number, pred: (m: RequestMetric) => boolean): RequestMetric[] {
    const out: RequestMetric[] = [];
    for (let i = this.metrics.length - 1; i >= 0 && out.length < limit; i--) {
      if (pred(this.metrics[i]!)) out.push(this.metrics[i]!);
    }
    return out;
  }

  clear(): void {
    this.metrics = [];
    this.counters.clear();
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

function topN(counts: Map<string, number>, n = 10): Array<[string, number]> {
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}
