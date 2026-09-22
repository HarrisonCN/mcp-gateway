/**
 * Metrics collection and aggregation for mcp-gateway
 */

import { EventEmitter } from 'events';
import type { RequestMetric, AggregatedMetrics, MonitorConfig } from '../utils/types.js';

export class MetricsCollector extends EventEmitter {
  private metrics: RequestMetric[] = [];
  private readonly retentionMs: number;
  private cleanupInterval?: NodeJS.Timeout;
  private readonly aggregateCache = new Map<number, AggregatedMetrics>();

  constructor(config?: MonitorConfig) {
    super();
    this.retentionMs = (config?.retentionHours ?? 24) * 60 * 60 * 1000;
  }

  // ─── Recording ──────────────────────────────────────────────────────────────

  record(metric: Omit<RequestMetric, 'id' | 'timestamp'>): RequestMetric {
    const full: RequestMetric = {
      ...metric,
      id: crypto.randomUUID(),
      timestamp: new Date(),
    };
    this.metrics.push(full);
    this.aggregateCache.clear();
    this.emit('metric', full);
    return full;
  }

  // ─── Aggregation ────────────────────────────────────────────────────────────

  aggregate(windowMs?: number): AggregatedMetrics {
    const cacheKey = windowMs ?? -1;
    const cached = this.aggregateCache.get(cacheKey);
    if (cached) return cached;

    const cutoff = windowMs ? Date.now() - windowMs : 0;
    const recentLatencies: number[] = [];
    const toolCounts = new Map<string, number>();
    const serverCounts = new Map<string, number>();
    const errorsByServer: Record<string, number> = {};
    let totalRequests = 0;
    let successful = 0;
    let latencySum = 0;

    for (const metric of this.metrics) {
      if (metric.timestamp.getTime() < cutoff) {
        continue;
      }
      totalRequests++;
      if (metric.success) successful++;
      recentLatencies.push(metric.durationMs);
      latencySum += metric.durationMs;
      toolCounts.set(metric.toolName, (toolCounts.get(metric.toolName) ?? 0) + 1);
      serverCounts.set(metric.serverId, (serverCounts.get(metric.serverId) ?? 0) + 1);
      if (!metric.success) {
        errorsByServer[metric.serverId] = (errorsByServer[metric.serverId] ?? 0) + 1;
      }
    }

    if (totalRequests === 0) {
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

    recentLatencies.sort((a, b) => a - b);
    const windowMinutes = windowMs ? windowMs / 60_000 : totalRequests;

    const aggregated: AggregatedMetrics = {
      totalRequests,
      successRate: successful / totalRequests,
      avgLatencyMs: latencySum / recentLatencies.length,
      p95LatencyMs: recentLatencies[Math.floor(recentLatencies.length * 0.95)] ?? 0,
      p99LatencyMs: recentLatencies[Math.floor(recentLatencies.length * 0.99)] ?? 0,
      requestsPerMinute: totalRequests / Math.max(1, windowMinutes),
      topTools: Array.from(toolCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, count]) => ({ name, count })),
      topServers: Array.from(serverCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([id, count]) => ({ id, count })),
      errorsByServer,
    };

    this.aggregateCache.set(cacheKey, aggregated);
    return aggregated;
  }

  // ─── Prometheus Format ──────────────────────────────────────────────────────

  toPrometheusText(): string {
    const agg = this.aggregate(60_000); // last 1 minute
    const lines: string[] = [
      '# HELP mcp_gateway_requests_total Total number of requests',
      '# TYPE mcp_gateway_requests_total counter',
      `mcp_gateway_requests_total ${agg.totalRequests}`,
      '',
      '# HELP mcp_gateway_success_rate Request success rate (0-1)',
      '# TYPE mcp_gateway_success_rate gauge',
      `mcp_gateway_success_rate ${agg.successRate.toFixed(4)}`,
      '',
      '# HELP mcp_gateway_latency_avg_ms Average request latency in milliseconds',
      '# TYPE mcp_gateway_latency_avg_ms gauge',
      `mcp_gateway_latency_avg_ms ${agg.avgLatencyMs.toFixed(2)}`,
      '',
      '# HELP mcp_gateway_latency_p95_ms P95 request latency in milliseconds',
      '# TYPE mcp_gateway_latency_p95_ms gauge',
      `mcp_gateway_latency_p95_ms ${agg.p95LatencyMs.toFixed(2)}`,
      '',
    ];

    for (const { id, count } of agg.topServers) {
      lines.push(
        `mcp_gateway_server_requests_total{server="${id}"} ${count}`
      );
    }

    return lines.join('\n');
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  start(): void {
    this.cleanupInterval = setInterval(() => {
      const cutoff = Date.now() - this.retentionMs;
      const before = this.metrics.length;
      this.metrics = this.metrics.filter((m) => m.timestamp.getTime() >= cutoff);
      const removed = before - this.metrics.length;
      if (removed > 0) {
        this.aggregateCache.clear();
        // logger.debug(`Cleaned up ${removed} expired metrics`);
      }
    }, 60_000);
    this.cleanupInterval.unref();
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  getRecent(limit = 100): RequestMetric[] {
    return this.metrics.slice(-limit).reverse();
  }

  clear(): void {
    this.metrics = [];
    this.aggregateCache.clear();
  }
}
