import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { fileURLToPath } from 'url';
import { createLiveRouter, computeLiveStats, pct, type LiveRouter } from '../src/gateway/live.js';
import { MetricsCollector } from '../src/monitor/index.js';
import { ServerRegistry } from '../src/registry/index.js';
import { createAuthMiddleware } from '../src/auth/middleware.js';
import { Gateway } from '../src/gateway/index.js';
import type { RequestMetric } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');

const rec = (ms: number, ago: number, extra: Partial<RequestMetric> = {}): RequestMetric => ({
  id: String(Math.random()),
  timestamp: new Date(1_000_000 - ago),
  serverId: 'a',
  toolName: 'echo',
  durationMs: ms,
  success: true,
  ...extra,
});

describe('computeLiveStats', () => {
  it('percentiles use nearest rank', () => {
    expect(pct([], 0.5)).toBe(0);
    expect(pct([1, 2, 3, 4], 0.5)).toBe(2);
    expect(pct([1, 2, 3, 4], 0.95)).toBe(4);
  });

  it('buckets, summarises and ranks records inside the window', () => {
    const records = [
      rec(10, 1_000),
      rec(20, 2_000, { success: false, clientId: 'key:ci' }),
      rec(30, 15_000, { toolName: 'add', serverId: 'b', clientId: 'key:ci' }),
      rec(40, 61_000), // outside the 60s window
      rec(50, -5_000), // in the future
    ];
    const s = computeLiveStats(records, 60_000, 10_000, 1_000_000);
    expect(s.summary.total).toBe(3);
    expect(s.summary.errors).toBe(1);
    expect(s.summary.errorRate).toBeCloseTo(1 / 3);
    expect(s.summary.requestsPerMinute).toBe(3);
    expect(s.summary.p50).toBe(20);
    expect(s.summary.p95).toBe(30);
    expect(s.series).toHaveLength(6);
    expect(s.series.reduce((n, b) => n + b.count, 0)).toBe(3);
    expect(s.series.at(-2)!.count).toBe(2); // last bucket is the current, partial one
    expect(s.series.at(-2)!.errors).toBe(1);
    expect(s.tools[0]).toMatchObject({ name: 'echo', serverId: 'a', count: 2, errors: 1, p95: 20 });
    expect(s.servers.map((x) => x.id)).toEqual(['a', 'b']);
    expect(s.clients[0]).toMatchObject({ id: 'key:ci', count: 2, errors: 1 });
    expect(s.clients.find((c) => c.id === 'anonymous')!.count).toBe(1);
  });

  it('returns empty buckets with no data', () => {
    const s = computeLiveStats([], 30_000, 10_000, 1_000_000);
    expect(s.summary).toMatchObject({ total: 0, errorRate: 0, p50: 0, p95: 0 });
    expect(s.series.every((b) => b.count === 0)).toBe(true);
  });
});

describe('live router', () => {
  const metrics = new MetricsCollector();
  const registry = new ServerRegistry(60_000);
  registry.register({ id: 'a', name: 'a', transport: 'stdio', command: 'x' });
  registry.register({ id: 'b', name: 'b', transport: 'stdio', command: 'x' });
  const auth = createAuthMiddleware({
    strategy: 'api-key',
    apiKeys: [{ key: 'admin', name: 'admin' }, { key: 'scoped', name: 'scoped', servers: ['a'] }],
  });
  let live: LiveRouter;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    live = createLiveRouter(metrics, registry, { authenticate: auth, snapshotIntervalMs: 50, heartbeatMs: 30, maxStreams: 2 });
    const app = express();
    app.use('/api/v1', live);
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
    metrics.record({ serverId: 'a', toolName: 'echo', durationMs: 5, success: true, clientId: 'key:admin' });
    metrics.record({ serverId: 'a', toolName: 'echo', durationMs: 9, success: false, clientId: 'key:scoped' });
  });
  afterAll(async () => {
    live.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('requires auth', async () => {
    expect((await fetch(`${base}/stats`)).status).toBe(401);
    expect((await fetch(`${base}/events`)).status).toBe(401);
  });

  it('GET /stats returns the window with clamped params', async () => {
    const r = await fetch(`${base}/stats?window=60000&bucket=5000`, { headers: { 'x-api-key': 'admin' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const b: any = await r.json();
    expect(b.windowMs).toBe(60_000);
    expect(b.bucketMs).toBe(5_000);
    expect(b.series).toHaveLength(12);
    expect(b.summary.total).toBe(2);
    expect(b.clients.map((c: any) => c.id).sort()).toEqual(['key:admin', 'key:scoped']);
    const d: any = await (await fetch(`${base}/stats?window=abc&bucket=1`, { headers: { 'x-api-key': 'admin' } })).json();
    expect(d.windowMs).toBe(15 * 60_000);
    expect(d.bucketMs).toBeGreaterThanOrEqual(2_500);
  });

  it('restricted clients only see their own calls', async () => {
    const b: any = await (await fetch(`${base}/stats`, { headers: { 'x-api-key': 'scoped' } })).json();
    expect(b.summary.total).toBe(1);
    expect(b.clients).toEqual([expect.objectContaining({ id: 'key:scoped' })]);
  });

  /** Read SSE events until `until` returns true. */
  async function readEvents(key: string, until: (evs: Array<{ event: string; data: any }>) => boolean, onOpen?: () => void) {
    const ac = new AbortController();
    const r = await fetch(`${base}/events`, { headers: { 'x-api-key': key }, signal: ac.signal });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let raw = '';
    const evs: Array<{ event: string; data: any }> = [];
    onOpen?.();
    while (!until(evs)) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      raw += chunk;
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (ev && data) evs.push({ event: ev, data: JSON.parse(data) });
      }
    }
    ac.abort();
    return { evs, raw };
  }

  it('GET /events streams snapshots, requests and heartbeats', async () => {
    const { evs, raw } = await readEvents(
      'admin',
      (e) => e.some((x) => x.event === 'request') && e.filter((x) => x.event === 'snapshot').length >= 2,
      () => setTimeout(() => metrics.record({ serverId: 'b', toolName: 'add', durationMs: 3, success: true }), 20),
    );
    const snap = evs.find((e) => e.event === 'snapshot')!.data;
    expect(snap.health.map((h: any) => h.serverId).sort()).toEqual(['a', 'b']);
    expect(snap.summary.total).toBeGreaterThanOrEqual(2);
    const req = evs.find((e) => e.event === 'request')!.data;
    expect(req).toMatchObject({ serverId: 'b', toolName: 'add' });
    expect(typeof req.timestamp).toBe('string');
    expect(raw).toContain('retry: 3000');
    // Give the server a moment to notice the disconnect and clean up.
    await new Promise((r) => setTimeout(r, 100));
    expect(live.streams()).toBe(0);
  });

  it('scoped streams hide other clients and out-of-scope servers', async () => {
    const { evs } = await readEvents(
      'scoped',
      (e) => e.some((x) => x.event === 'request'),
      () =>
        setTimeout(() => {
          metrics.record({ serverId: 'b', toolName: 'other', durationMs: 1, success: true, clientId: 'key:admin' });
          metrics.record({ serverId: 'a', toolName: 'mine', durationMs: 1, success: true, clientId: 'key:scoped' });
        }, 20),
    );
    const reqs = evs.filter((e) => e.event === 'request').map((e) => e.data.toolName);
    expect(reqs).toEqual(['mine']);
    expect(evs[0]!.data.health.map((h: any) => h.serverId)).toEqual(['a']);
  });

  it('caps concurrent streams and close() ends them', async () => {
    const a1 = new AbortController();
    const a2 = new AbortController();
    const s1 = await fetch(`${base}/events`, { headers: { 'x-api-key': 'admin' }, signal: a1.signal });
    const s2 = await fetch(`${base}/events`, { headers: { 'x-api-key': 'admin' }, signal: a2.signal });
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    expect(live.streams()).toBe(2);
    expect((await fetch(`${base}/events`, { headers: { 'x-api-key': 'admin' } })).status).toBe(503);
    live.close();
    expect(live.streams()).toBe(0);
    // The stream ends on the server side.
    const reader = s1.body!.getReader();
    let done = false;
    while (!done) done = (await reader.read()).done;
    expect(done).toBe(true);
    a1.abort();
    a2.abort();
  });
});

describe('Gateway mounts the live API and serves the dashboard', () => {
  const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
  let gw: Gateway;
  let base: string;
  beforeAll(async () => {
    gw = new Gateway({
      port: 0,
      host: '127.0.0.1',
      logLevel: 'error',
      auth: { strategy: 'api-key', apiKeys: ['k'] },
      monitor: { requestLog: false },
      servers: [{ id: 'one', name: 'one', transport: 'stdio', command: process.execPath, args: [fixture], timeout: 2000 }],
    });
    await gw.start();
    base = `http://127.0.0.1:${gw.address()!.port}`;
  });
  afterAll(async () => {
    await gw.stop();
  });

  it('records REST tool calls into /api/v1/stats', async () => {
    const H = { 'content-type': 'application/json', 'x-api-key': 'k' };
    const call = await fetch(`${base}/api/v1/tools/call`, { method: 'POST', headers: H, body: JSON.stringify({ tool: 'echo', arguments: { x: 1 } }) });
    expect(call.status).toBe(200);
    const s: any = await (await fetch(`${base}/api/v1/stats?window=60000`, { headers: H })).json();
    expect(s.summary.total).toBe(1);
    expect(s.tools[0]).toMatchObject({ name: 'echo', serverId: 'one' });
    expect((await fetch(`${base}/api/v1/stats`)).status).toBe(401);
    // Existing routes still work behind the live router.
    expect((await fetch(`${base}/api/v1/servers`, { headers: H })).status).toBe(200);
  });

  it('serves the dashboard page', async () => {
    const r = await fetch(`${base}/dashboard`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('id="app"');
    expect(html).not.toMatch(/<script[^>]+src="https?:/);
  });

  it('stop() ends open event streams', async () => {
    const r = await fetch(`${base}/api/v1/events`, { headers: { 'x-api-key': 'k' } });
    expect(r.status).toBe(200);
    const reader = r.body!.getReader();
    await reader.read();
    const t = Date.now();
    const stopping = gw.stop();
    let done = false;
    while (!done) done = (await reader.read()).done;
    expect(Date.now() - t).toBeLessThan(2_000);
    await stopping;
  });
});
