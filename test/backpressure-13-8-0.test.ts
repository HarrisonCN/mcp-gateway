/**
 * 13.8.0 Performance and backpressure — written first, against 13.7.0 (see notes/13.8.0-failing-before.txt).
 *
 *  - load protection: `overload:` (optional, off by default) — an adaptive concurrency limit in front of tool calls
 *    (REST + MCP), excess requests wait in a bounded queue and are shed with 503 + Retry-After;
 *  - fair scheduling: the queue is a per-tenant weighted fair queue, so one tenant flooding the gateway cannot starve
 *    the others (FIFO would serve the flood first);
 *  - bounded queues: total cap, per-tenant cap, queue timeout, metrics;
 *  - end-to-end p99 analysis: per-stage latency (auth, policy, hooks, routing, cache, upstream, queue, total) at
 *    GET /api/v1/perf/stages and as Prometheus summaries;
 *  - per-module cost report committed as docs/perf/module-costs.{md,json} for all 46 feature modules.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { Gateway } from '../src/gateway/index.js';
import { validateConfig } from '../src/config/loader.js';
import { FEATURE_MANIFEST } from '../src/features/manifest.js';
import { OverloadController, type AdmissionTicket } from '../src/gateway/overload.js';
import { StageTimer } from '../src/gateway/stages.js';
import { logger } from '../src/utils/logger.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain ESM helpers shared with bench/load.mjs
import { startHttpUpstream } from '../bench/lib/upstreams.mjs';

/* eslint-disable @typescript-eslint/no-explicit-any */
logger.setLevel('error');
const KEY_A = 'a'.repeat(40);
const KEY_B = 'b'.repeat(40);
const KEY_OPS = 'o'.repeat(40);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  while (cleanups.length) await Promise.resolve(cleanups.pop()!()).catch(() => undefined);
});

function controller(cfg: Record<string, unknown>) {
  return new OverloadController({ enabled: true, ...cfg } as any);
}

describe('13.8.0 overload controller: bounded queue', () => {
  it('admits up to the limit, queues up to queue.maxSize, sheds the rest with a Retry-After', async () => {
    const c = controller({ concurrency: { initial: 1, adaptive: false }, queue: { maxSize: 2, timeoutMs: 5000 } });
    const t1 = await c.acquire('t');
    expect(t1.ok).toBe(true);
    const q1 = c.acquire('t');
    const q2 = c.acquire('t');
    const r = await c.acquire('t');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('queue-full');
      expect(r.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
    expect(c.stats().queued).toBe(2);
    (t1 as AdmissionTicket).release();
    const a1 = await q1;
    expect(a1.ok).toBe(true);
    (a1 as AdmissionTicket).release();
    const a2 = await q2;
    expect(a2.ok).toBe(true);
    (a2 as AdmissionTicket).release();
    const s = c.stats();
    expect(s.inflight).toBe(0);
    expect(s.shed['queue-full']).toBe(1);
    expect(s.admitted).toBe(3);
  });

  it('a queued request that waits longer than queue.timeoutMs is shed (queue-timeout)', async () => {
    const c = controller({ concurrency: { initial: 1, adaptive: false }, queue: { maxSize: 10, timeoutMs: 40 } });
    const t1 = (await c.acquire('t')) as AdmissionTicket;
    const t0 = performance.now();
    const r = await c.acquire('t');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('queue-timeout');
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(c.stats().queued).toBe(0);
    t1.release();
  });

  it('per-tenant queue cap: one tenant cannot fill the whole queue', async () => {
    const c = controller({ concurrency: { initial: 1, adaptive: false }, queue: { maxSize: 10, perTenant: 2, timeoutMs: 5000 } });
    const t1 = (await c.acquire('a')) as AdmissionTicket;
    const qa = [c.acquire('a'), c.acquire('a')];
    const over = await c.acquire('a');
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe('tenant-queue-full');
    const qb = c.acquire('b');
    expect(c.stats().queued).toBe(3);
    t1.release();
    for (const p of [...qa, qb]) ((await Promise.race([p, sleep(50).then(() => undefined)])) as AdmissionTicket | undefined)?.release?.();
    for (const p of [...qa, qb]) ((await p) as AdmissionTicket).release();
  });

  it('a waiter whose request is aborted leaves the queue', async () => {
    const c = controller({ concurrency: { initial: 1, adaptive: false }, queue: { maxSize: 10, timeoutMs: 5000 } });
    const t1 = (await c.acquire('t')) as AdmissionTicket;
    const ac = new AbortController();
    const p = c.acquire('t', { signal: ac.signal });
    expect(c.stats().queued).toBe(1);
    ac.abort();
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('aborted');
    expect(c.stats().queued).toBe(0);
    t1.release();
  });
});

describe('13.8.0 overload controller: weighted fair queue across tenants', () => {
  async function drain(c: OverloadController, first: AdmissionTicket, pending: Array<{ tenant: string; p: Promise<any> }>) {
    const order: string[] = [];
    const done = new Set<number>();
    first.release();
    while (done.size < pending.length) {
      await sleep(0);
      for (let i = 0; i < pending.length; i++) {
        if (done.has(i)) continue;
        const r = await Promise.race([pending[i].p, Promise.resolve(undefined)]);
        if (r?.ok) {
          done.add(i);
          order.push(pending[i].tenant);
          r.release();
          break;
        }
      }
    }
    return order;
  }

  it('a flooding tenant does not starve a light one (equal weights interleave)', async () => {
    const c = controller({ concurrency: { initial: 1, adaptive: false }, queue: { maxSize: 100, timeoutMs: 10_000 } });
    const first = (await c.acquire('flood')) as AdmissionTicket;
    const pending: Array<{ tenant: string; p: Promise<any> }> = [];
    for (let i = 0; i < 20; i++) pending.push({ tenant: 'flood', p: c.acquire('flood') });
    for (let i = 0; i < 3; i++) pending.push({ tenant: 'light', p: c.acquire('light') });
    const order = await drain(c, first, pending);
    const lastLight = order.lastIndexOf('light');
    // FIFO would serve the 3 light requests at positions 20..22; fair queuing interleaves them early.
    expect(lastLight).toBeLessThan(8);
  });

  it('weights split capacity proportionally (3:1)', async () => {
    const c = controller({ concurrency: { initial: 1, adaptive: false }, queue: { maxSize: 200, timeoutMs: 10_000 }, fairness: { weights: { gold: 3, bronze: 1 } } });
    const first = (await c.acquire('gold')) as AdmissionTicket;
    const pending: Array<{ tenant: string; p: Promise<any> }> = [];
    for (let i = 0; i < 40; i++) pending.push({ tenant: 'bronze', p: c.acquire('bronze') });
    for (let i = 0; i < 40; i++) pending.push({ tenant: 'gold', p: c.acquire('gold') });
    const order = await drain(c, first, pending);
    const head = order.slice(0, 20);
    const gold = head.filter((t) => t === 'gold').length;
    expect(gold).toBeGreaterThanOrEqual(13);
    expect(gold).toBeLessThanOrEqual(17);
  });
});

describe('13.8.0 overload controller: adaptive concurrency limit', () => {
  it('shrinks when latency rises well above its long-term level, grows back when healthy and saturated, within min/max', () => {
    const c = controller({ concurrency: { initial: 20, min: 2, max: 40, adaptive: true } });
    // healthy baseline: 10 ms
    for (let i = 0; i < 400; i++) c.observe(10, 20);
    const before = c.stats().limit;
    expect(before).toBeGreaterThanOrEqual(20);
    expect(before).toBeLessThanOrEqual(40);
    // congestion: latency 8x
    for (let i = 0; i < 400; i++) c.observe(80, Math.ceil(c.stats().limit));
    const congested = c.stats().limit;
    expect(congested).toBeLessThan(before);
    expect(congested).toBeGreaterThanOrEqual(2);
    // recovery
    for (let i = 0; i < 2000; i++) c.observe(10, Math.ceil(c.stats().limit));
    expect(c.stats().limit).toBeGreaterThan(congested);
    expect(c.stats().limit).toBeLessThanOrEqual(40);
  });

  it('targetLatencyMs is a hard ceiling: windows above it shrink the limit even at a steady latency', () => {
    const c = controller({ concurrency: { initial: 32, min: 4, max: 64, adaptive: true, targetLatencyMs: 50 } });
    for (let i = 0; i < 600; i++) c.observe(120, 32);
    expect(c.stats().limit).toBeLessThan(32);
    expect(c.stats().limit).toBeGreaterThanOrEqual(4);
  });
});

describe('13.8.0 stage timer', () => {
  it('records per-stage samples and reports p50 / p95 / p99', () => {
    const s = new StageTimer(1000);
    for (let i = 1; i <= 100; i++) s.record('upstream', i);
    s.record('auth', 0.5);
    const r = s.report();
    expect(r.stages.upstream.count).toBe(100);
    expect(r.stages.upstream.p50).toBe(50);
    expect(r.stages.upstream.p99).toBe(99);
    expect(r.stages.auth.count).toBe(1);
  });
});

describe('13.8.0 config (schema v11 compatible)', () => {
  it('overload is optional, validates, and rejects inconsistent limits', () => {
    expect(validateConfig({ version: 11, servers: [] } as any).overload).toBeUndefined();
    const c = validateConfig({ version: 11, servers: [], overload: { enabled: true, concurrency: { initial: 8, min: 2, max: 16 }, queue: { maxSize: 32, timeoutMs: 500, perTenant: 8 }, fairness: { weights: { acme: 2 } }, retryAfterSeconds: 2 } } as any);
    expect(c.overload?.enabled).toBe(true);
    expect(() => validateConfig({ version: 11, servers: [], overload: { concurrency: { min: 10, max: 5 } } } as any)).toThrow();
    expect(() => validateConfig({ version: 11, servers: [], overload: { bogus: 1 } } as any)).toThrow();
  });
});

async function gateway(extra: Record<string, unknown>) {
  const up = await startHttpUpstream({ tag: 'h' });
  cleanups.push(() => up.down());
  const cfg = validateConfig({
    version: 11,
    monitor: { requestLog: false, prometheus: true },
    servers: [{ id: 'h', name: 'h', transport: 'streamable-http', url: up.url, timeoutMs: 5000 }],
    tenants: [
      { id: 'ta', servers: ['h'], members: [{ client: 'ka', role: 'owner' }] },
      { id: 'tb', servers: ['h'], members: [{ client: 'kb', role: 'owner' }] },
    ],
    ...extra,
  } as any);
  const gw = new Gateway({ ...cfg, port: 0, host: '127.0.0.1', logLevel: 'error', auth: { strategy: 'api-key', apiKeys: [{ name: 'ka', key: KEY_A }, { name: 'kb', key: KEY_B }, { name: 'ops', key: KEY_OPS }] } } as any);
  await gw.start();
  cleanups.push(() => gw.stop());
  const base = `http://127.0.0.1:${gw.address()!.port}`;
  const call = async (tool: string, args: Record<string, unknown> = {}, key = KEY_A) => {
    const r = await fetch(`${base}/api/v1/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ server: 'h', tool, arguments: args }) });
    return { status: r.status, retryAfter: r.headers.get('retry-after'), body: (await r.json().catch(() => ({}))) as any };
  };
  return { gw, base, call, up };
}

describe('13.8.0 gateway: load shedding over HTTP', () => {
  it('without overload config nothing is shed (default unchanged)', async () => {
    const { call } = await gateway({});
    const rs = await Promise.all(Array.from({ length: 12 }, () => call('slow', { ms: 30 })));
    expect(rs.every((r) => r.status === 200)).toBe(true);
  });

  it('REST: beyond limit + queue the gateway answers 503 with Retry-After; metrics show it', async () => {
    const { call, base } = await gateway({ overload: { enabled: true, concurrency: { initial: 1, adaptive: false }, queue: { maxSize: 1, timeoutMs: 5000 }, retryAfterSeconds: 2 } });
    await call('echo'); // warm the upstream session
    const rs = await Promise.all(Array.from({ length: 4 }, () => call('slow', { ms: 150 })));
    const ok = rs.filter((r) => r.status === 200);
    const shed = rs.filter((r) => r.status === 503);
    expect(ok.length).toBe(2);
    expect(shed.length).toBe(2);
    for (const r of shed) {
      expect(Number(r.retryAfter)).toBeGreaterThanOrEqual(2);
      expect(r.body.reason).toBe('queue-full');
    }
    const m = await (await fetch(`${base}/metrics`)).text();
    expect(m).toMatch(/mcp_gateway_overload_shed_total\{reason="queue-full"\} 2/);
    expect(m).toMatch(/mcp_gateway_overload_limit 1/);
    expect(m).toMatch(/mcp_gateway_overload_inflight 0/);
  });

  it('MCP endpoint: an overloaded POST gets HTTP 503 + Retry-After and a JSON-RPC error', async () => {
    const { base, call } = await gateway({ overload: { enabled: true, concurrency: { initial: 1, adaptive: false }, queue: { maxSize: 0 } } });
    const slow = call('slow', { ms: 300 });
    await sleep(60);
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${KEY_A}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    });
    expect(r.status).toBe(503);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    const b: any = await r.json();
    expect(b.jsonrpc).toBe('2.0');
    expect(b.error.code).toBe(-32030);
    expect((await slow).status).toBe(200);
  });

  it('tenant B is served while tenant A floods the queue', async () => {
    const { call } = await gateway({ overload: { enabled: true, concurrency: { initial: 1, adaptive: false }, queue: { maxSize: 50, timeoutMs: 10_000 } } });
    await call('echo');
    const flood = Array.from({ length: 12 }, () => call('slow', { ms: 40 }, KEY_A));
    await sleep(20);
    const t0 = performance.now();
    const b = await call('slow', { ms: 40 }, KEY_B);
    const waited = performance.now() - t0;
    expect(b.status).toBe(200);
    // FIFO: ~12 × 40 ms behind the flood; fair queuing: at most a couple of A calls first
    expect(waited).toBeLessThan(250);
    await Promise.all(flood);
  });
});

describe('13.8.0 gateway: per-stage latency', () => {
  it('GET /api/v1/perf/stages breaks calls down by pipeline stage; Prometheus exports the summaries', async () => {
    const { call, base } = await gateway({ cache: { rules: [{ tools: ['echo'], ttlSeconds: 60 }] }, policy: { rules: [{ name: 'no-admin', tools: ['admin_*'], effect: 'deny' }] } });
    for (let i = 0; i < 10; i++) expect((await call('echo', { n: i % 3 })).status).toBe(200);
    const r = await fetch(`${base}/api/v1/perf/stages`, { headers: { authorization: `Bearer ${KEY_OPS}` } });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    for (const st of ['auth', 'policy', 'hooks', 'routing', 'cache', 'upstream', 'total']) {
      expect(b.stages[st], st).toBeDefined();
      expect(b.stages[st].count, st).toBeGreaterThan(0);
      expect(b.stages[st].p99, st).toBeGreaterThanOrEqual(0);
    }
    expect(b.stages.upstream.count).toBe(3); // 7 cache hits never reach the upstream
    const m = await (await fetch(`${base}/metrics`)).text();
    expect(m).toMatch(/mcp_gateway_stage_duration_ms\{stage="upstream",quantile="0.99"\} [0-9.]+/);
  });
});

describe('13.8.0 per-module cost report', () => {
  it('docs/perf/module-costs.json covers every feature module in the manifest', () => {
    expect(FEATURE_MANIFEST.length).toBe(46);
    expect(existsSync('docs/perf/module-costs.md')).toBe(true);
    const j = JSON.parse(readFileSync('docs/perf/module-costs.json', 'utf8'));
    const ids = new Set(j.modules.map((m: any) => m.id));
    for (const e of FEATURE_MANIFEST) expect(ids.has(e.id), e.id).toBe(true);
    for (const m of j.modules) {
      expect(typeof m.import.ms).toBe('number');
      expect(['measured', 'not-on-call-path', 'not-activated']).toContain(m.call.status);
    }
    expect(existsSync('scripts/module-costs.mjs')).toBe(true);
  });
});
