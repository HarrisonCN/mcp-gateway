import { describe, it, expect } from 'vitest';
import { MetricsCollector } from '../src/monitor/index.js';

const rec = (m: MetricsCollector, ms: number, success = true, serverId = 's1') =>
  m.record({ serverId, toolName: 't', durationMs: ms, success });

describe('MetricsCollector', () => {
  it('computes nearest-rank percentiles', () => {
    const m = new MetricsCollector();
    for (let i = 1; i <= 100; i++) rec(m, i);
    const a = m.aggregate(60_000);
    expect(a.p95LatencyMs).toBe(95);
    expect(a.p99LatencyMs).toBe(99);
    expect(a.avgLatencyMs).toBe(50.5);
  });

  it('prometheus totals are monotonic counters with escaped labels', () => {
    const m = new MetricsCollector();
    rec(m, 1, true, 'a"b');
    rec(m, 1, false, 'a"b');
    const text = m.toPrometheusText();
    expect(text).toContain('mcp_gateway_requests_total 2');
    expect(text).toContain('mcp_gateway_errors_total 1');
    expect(text).toContain('server="a\\"b"');
  });

  it('caps stored entries', () => {
    const m = new MetricsCollector(undefined, { maxEntries: 10 });
    for (let i = 0; i < 100; i++) rec(m, i);
    expect(m.getRecent(1000).length).toBeLessThanOrEqual(11);
    expect(m.toPrometheusText()).toContain('mcp_gateway_requests_total 100');
  });

  it('handles bad window / limit input', () => {
    const m = new MetricsCollector();
    rec(m, 5);
    expect(m.aggregate(NaN).totalRequests).toBe(1);
    expect(m.getRecent(NaN)).toEqual([]);
  });
});
