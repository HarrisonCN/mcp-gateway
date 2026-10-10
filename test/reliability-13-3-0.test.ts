/**
 * 13.3.0 Production Reliability — failure matrix (written first, against 13.2.0; see notes/13.3.0-failing-before.txt).
 *
 * Every row injects one fault into one dependency and asserts the gateway (a) answers within a bound while the fault
 * lasts — no frozen event loop, no unbounded wait — and (b) recovers on its own once the fault clears:
 *
 *   dependency     | kill / down        | stall                    | slow            | flap
 *   Redis store    | fail open / closed | breaker: one timeout,    | (= stall below  | reconnect, replies
 *                  |                    | then fast-fail           |  the timeout)   | stay aligned
 *   SQLite store   | —                  | lock held by another     | —               | —
 *                  |                    | process: bounded wait    |                 |
 *   HTTP upstream  | ECONNREFUSED → 502 | timeout → 504            | latency only    | down/up loop
 *                  | restart: session   |                          |                 |
 *                  | 404 → re-init      |                          |                 |
 *   stdio child    | SIGKILL → respawn  | hung child recycled      | latency only    | kill loop
 *                  |                    | after failed pings       |                 |
 *
 * Plus the combined behaviour of load balancing / ejection (the per-member circuit breaker), rate limit, budgets and
 * cache: an upstream's own JSON-RPC error is not a transport failure (the tool is not re-run on another member and the
 * member is not ejected); a timeout fails over; cost is charged once per call.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { Gateway } from '../src/gateway/index.js';
import { validateConfig } from '../src/config/loader.js';
import { RedisClient } from '../src/state/redis.js';
import { createStateStore } from '../src/state/index.js';
import { classifyFailure } from '../src/gateway/invoker.js';
import { logger } from '../src/utils/logger.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain ESM helpers shared with bench/load.mjs
import { startHttpUpstream, startFakeRedis, STDIO_SERVER } from '../bench/lib/upstreams.mjs';

/* eslint-disable @typescript-eslint/no-explicit-any */
logger.setLevel('error');
const KEY = 'k'.repeat(40);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  while (cleanups.length) await Promise.resolve(cleanups.pop()!()).catch(() => undefined);
});

async function gateway(extra: Record<string, unknown>, servers: unknown[]) {
  const cfg = validateConfig({ version: 11, servers, monitor: { requestLog: false }, ...extra } as any);
  const gw = new Gateway({ ...cfg, port: 0, host: '127.0.0.1', logLevel: 'error', auth: { strategy: 'api-key', apiKeys: [{ name: 'k1', key: KEY }, { name: 'k2', key: 'z'.repeat(40) }] } } as any);
  await gw.start();
  cleanups.push(() => gw.stop());
  const base = `http://127.0.0.1:${gw.address()!.port}`;
  const call = async (server: string, tool = 'echo', args: Record<string, unknown> = {}, key = KEY) => {
    const t = performance.now();
    const r = await fetch(`${base}/api/v1/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ server, tool, arguments: args }) });
    const b: any = await r.json().catch(() => ({}));
    let payload: any = {};
    try {
      payload = JSON.parse(b.result?.content?.[0]?.text ?? '{}');
    } catch {
      /* not ours */
    }
    return { status: r.status, ok: r.status === 200 && b.success !== false, code: b.error?.code, ms: performance.now() - t, upstream: payload.upstream as string | undefined, pid: payload.pid as number | undefined, body: b };
  };
  return { gw: gw as any, base, call };
}

async function until(cond: () => Promise<boolean> | boolean, ms = 10_000, step = 50): Promise<number> {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await cond()) return Date.now() - t;
    await sleep(step);
  }
  throw new Error(`condition not met within ${ms} ms`);
}

/** Longest gap between event-loop turns while `fn` runs (a frozen loop shows up as one huge gap). */
async function maxLoopGap<T>(fn: () => Promise<T>): Promise<{ gap: number; value: T }> {
  let last = performance.now();
  let gap = 0;
  const iv = setInterval(() => {
    const n = performance.now();
    gap = Math.max(gap, n - last);
    last = n;
  }, 10);
  try {
    const value = await fn();
    gap = Math.max(gap, performance.now() - last);
    return { gap, value };
  } finally {
    clearInterval(iv);
  }
}

const fast = { reconnect: { initialDelayMs: 100, maxDelayMs: 500, jitter: 0 } };

describe('13.3.0 failure matrix — Redis state store', () => {
  it('replies stay aligned with their commands across a command timeout and the reconnect that follows', async () => {
    const r = await startFakeRedis();
    cleanups.push(() => r.close());
    const c = new RedisClient({ url: r.url, commandTimeoutMs: 200 });
    cleanups.push(() => c.close());
    await c.command('SET', 'a', 'A');
    await c.command('SET', 'b', 'B');
    r.setMode('stall');
    const seen: string[] = [];
    await c.command('GET', 'x').catch(async () => {
      r.setMode('ok');
      // issued on the NEW connection before the old one has finished closing
      const b = await c.command('GET', 'b').catch((e: Error) => `error:${e.message}`);
      seen.push(`b=${String(b)}`);
      seen.push(`a=${String(await c.command('GET', 'a'))}`);
    });
    for (let i = 0; i < 6; i++) seen.push(`${i % 2 ? 'a' : 'b'}=${String(await c.command('GET', i % 2 ? 'a' : 'b'))}`);
    // never another command's reply; the command sent on the new connection is not failed by the old one's close
    expect(seen[0]).toBe('b=B');
    for (const s of seen) expect(s === 'a=A' || s === 'b=B').toBe(true);
  });

  it('a stalled Redis costs one command timeout, then the store breaker fails fast until Redis answers again', async () => {
    const r = await startFakeRedis();
    cleanups.push(() => r.close());
    const store: any = createStateStore({ store: 'redis', redis: { url: r.url, commandTimeoutMs: 300, connectTimeoutMs: 300 } } as any);
    cleanups.push(() => store.close());
    await store.set('k', 'v');
    r.setMode('stall');
    let t = performance.now();
    await expect(store.get('k')).rejects.toThrow();
    expect(performance.now() - t).toBeGreaterThanOrEqual(250);
    t = performance.now();
    await expect(store.get('k')).rejects.toThrow(/unavailable|breaker/i);
    expect(performance.now() - t).toBeLessThan(50);
    expect(store.health().state).toBe('open');
    r.setMode('ok');
    const ms = await until(async () => (await store.get('k').catch(() => undefined)) === 'v', 5000, 50);
    expect(ms).toBeLessThan(3000);
    expect(store.health().state).toBe('closed');
  });

  it('rate limit through Redis: fails open while Redis is down / stalled (bounded latency) and counts again after', async () => {
    const r = await startFakeRedis();
    cleanups.push(() => r.close());
    const { call } = await gateway(
      { store: { backend: 'redis', redis: { url: r.url, commandTimeoutMs: 300, connectTimeoutMs: 300 } }, rateLimit: { limit: 1000, windowSeconds: 60 } },
      [{ id: 's', name: 's', transport: 'stdio', command: process.execPath, args: [STDIO_SERVER], timeoutMs: 3000 }],
    );
    expect((await call('s')).ok).toBe(true);
    r.setMode('stall');
    const during = [];
    for (let i = 0; i < 5; i++) during.push(await call('s'));
    expect(during.every((x) => x.ok)).toBe(true);
    // one store timeout at most, then fast: total well below 5 × commandTimeout
    expect(during.reduce((n, x) => n + x.ms, 0)).toBeLessThan(1000);
    r.setMode('ok');
    await r.down();
    expect((await call('s')).ok).toBe(true);
    await r.up();
    const before = r.state.commands;
    await until(async () => (await call('s')).ok && r.state.commands > before, 5000);
  });

  it('failureMode closed refuses while the store is unreachable and serves again after recovery', async () => {
    const r = await startFakeRedis();
    cleanups.push(() => r.close());
    const { call } = await gateway(
      { store: { backend: 'redis', failureMode: 'closed', redis: { url: r.url, commandTimeoutMs: 300, connectTimeoutMs: 300 } }, rateLimit: { limit: 1000, windowSeconds: 60 } },
      [{ id: 's', name: 's', transport: 'stdio', command: process.execPath, args: [STDIO_SERVER], timeoutMs: 3000 }],
    );
    expect((await call('s')).ok).toBe(true);
    await r.down();
    expect((await call('s')).status).toBe(429);
    await r.up();
    await until(async () => (await call('s')).ok, 5000);
  });
});

describe('13.3.0 failure matrix — SQLite state store', () => {
  it('a lock held by another process is a bounded store failure, not a frozen event loop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgw-sq-'));
    const file = join(dir, 'state.db');
    const store: any = createStateStore({ store: 'sqlite', sqlite: { path: file } } as any);
    cleanups.push(() => store.close());
    await store.set('k', 'v');
    // another process holds an exclusive write lock (a backup tool, a second gateway mid-transaction, …)
    const holder = spawn(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(${JSON.stringify(file)});d.exec('BEGIN EXCLUSIVE');process.stdout.write('locked\\n');setTimeout(()=>{d.exec('COMMIT');process.exit(0)},4000)`], { stdio: ['ignore', 'pipe', 'ignore'] });
    cleanups.push(() => holder.kill('SIGKILL'));
    await new Promise<void>((res) => holder.stdout!.once('data', () => res()));
    const { gap, value } = await maxLoopGap(async () => {
      const t = performance.now();
      const err = await store.incr('n', 60_000).then(() => undefined, (e: Error) => e);
      return { err, ms: performance.now() - t };
    });
    expect(value.err).toBeInstanceOf(Error);
    expect(value.ms).toBeLessThan(1000);
    expect(gap).toBeLessThan(1000);
    await new Promise((res) => holder.once('exit', res));
    await until(async () => (await store.incr('n', 60_000).catch(() => 0)) > 0, 5000);
  });

  it('busyTimeoutMs is configurable (schema-compatible addition)', () => {
    expect(() => validateConfig({ version: 11, servers: [], store: { backend: 'sqlite', sqlite: { path: ':memory:', busyTimeoutMs: 250 } } } as any)).not.toThrow();
  });
});

describe('13.3.0 failure matrix — HTTP upstream', () => {
  it('kill → fast 502, recovers after restart; restart with lost sessions is transparent (re-initialize + one resend)', async () => {
    const up = await startHttpUpstream();
    cleanups.push(() => up.close());
    const { call } = await gateway({}, [{ id: 'h', name: 'h', transport: 'streamable-http', url: up.url, timeoutMs: 1000, ...fast }]);
    expect((await call('h')).ok).toBe(true);
    await up.down();
    const down = await call('h');
    expect(down.ok).toBe(false);
    expect(down.ms).toBeLessThan(1000);
    await up.up();
    expect(await until(async () => (await call('h')).ok, 5000)).toBeLessThan(3000);
    // the server restarts and forgets every session: the next call must not fail
    await up.restart();
    const after = await call('h');
    expect(after.ok).toBe(true);
    expect(up.stats().calls).toBeGreaterThan(0);
  });

  it('stall → 504 at the timeout, no stuck upstream requests, recovery is immediate', async () => {
    const up = await startHttpUpstream();
    cleanups.push(() => up.close());
    const { call } = await gateway({}, [{ id: 'h', name: 'h', transport: 'streamable-http', url: up.url, timeoutMs: 400, ...fast }]);
    expect((await call('h')).ok).toBe(true);
    up.setMode('stall');
    const s = await call('h');
    expect(s.status).toBe(504);
    expect(s.ms).toBeLessThan(1500);
    up.setMode('ok');
    expect((await call('h')).ok).toBe(true);
    await until(() => up.stats().stalled === 0, 3000);
  });

  it('slow → latency only; 503 → error without losing the session; flap → recovers', async () => {
    const up = await startHttpUpstream({ delayMs: 150 });
    cleanups.push(() => up.close());
    const { call } = await gateway({}, [{ id: 'h', name: 'h', transport: 'streamable-http', url: up.url, timeoutMs: 2000, ...fast }]);
    up.setMode('slow');
    const slow = await call('h');
    expect(slow.ok).toBe(true);
    expect(slow.ms).toBeGreaterThanOrEqual(140);
    up.setMode('error');
    expect((await call('h')).status).toBe(502);
    up.setMode('ok');
    const sessions = up.stats().sessions;
    expect((await call('h')).ok).toBe(true);
    expect(up.stats().sessions).toBe(sessions);
    for (let i = 0; i < 6; i++) {
      await up.down();
      await sleep(80);
      await up.up();
      await sleep(80);
    }
    expect(await until(async () => (await call('h')).ok, 5000)).toBeLessThan(3000);
  });

  it('keep-alive: concurrent calls reuse a bounded set of upstream connections', async () => {
    const up = await startHttpUpstream();
    cleanups.push(() => up.close());
    const { call } = await gateway({}, [{ id: 'h', name: 'h', transport: 'streamable-http', url: up.url, timeoutMs: 2000, ...fast }]);
    await call('h');
    const c0 = up.stats().connections;
    await Promise.all(Array.from({ length: 16 }, async () => {
      for (let i = 0; i < 10; i++) await call('h');
    }));
    // 160 calls at concurrency 16 → at most ~one connection per concurrent call, not one per call
    expect(up.stats().connections - c0).toBeLessThanOrEqual(24);
  });
});

describe('13.3.0 failure matrix — stdio child process', () => {
  const stdio = (extra: Record<string, unknown> = {}) => ({ id: 's', name: 's', transport: 'stdio', command: process.execPath, args: [STDIO_SERVER], timeoutMs: 600, ...fast, ...extra });

  it('SIGKILL → respawned; kill loop (flap) → recovers', async () => {
    const { call } = await gateway({}, [stdio()]);
    const first = await call('s');
    process.kill(first.pid!, 'SIGKILL');
    expect(await until(async () => (await call('s')).ok, 5000)).toBeLessThan(3000);
    for (let i = 0; i < 4; i++) {
      const p = (await call('s')).pid;
      if (p) process.kill(p, 'SIGKILL');
      await sleep(150);
    }
    await until(async () => (await call('s')).ok, 5000);
  });

  it('a hung child (alive, never answers) is recycled after `health.restartAfter` failed pings', async () => {
    const { call } = await gateway({ health: { intervalMs: 1000, restartAfter: 2 } }, [stdio()]);
    const first = await call('s');
    expect(first.ok).toBe(true);
    process.kill(first.pid!, 'SIGUSR1'); // stall
    await sleep(150);
    expect((await call('s')).status).toBe(504);
    const ms = await until(async () => {
      const r = await call('s');
      return r.ok && r.pid !== first.pid;
    }, 9000, 200);
    expect(ms).toBeLessThan(8000);
  }, 20_000);

  it('slow child → latency only', async () => {
    const { call } = await gateway({}, [stdio({ timeoutMs: 2000 })]);
    const first = await call('s');
    process.kill(first.pid!, 'SIGUSR2');
    await sleep(150);
    const slow = await call('s');
    expect(slow.ok).toBe(true);
    expect(slow.ms).toBeGreaterThanOrEqual(180);
  });
});

describe('13.3.0 combined: load balancing + ejection + rate limit + budgets + cache', () => {
  async function combo(lb: Record<string, unknown> = {}) {
    const A = await startHttpUpstream({ tag: 'A' });
    const B = await startHttpUpstream({ tag: 'B' });
    cleanups.push(() => A.close(), () => B.close());
    const g = await gateway(
      {
        rateLimit: { limit: 1000, windowSeconds: 60 },
        cache: { rules: [{ tools: ['cached'], ttlSeconds: 60, scope: 'shared' }] },
        costs: { tools: [{ match: 'r/priced', perCall: 1 }], budgets: [{ name: 'b', period: 'day', limit: 3, action: 'block', perClient: true }] },
      },
      [{ id: 'r', name: 'r', transport: 'streamable-http', url: A.url, timeoutMs: 400, ...fast, replicas: [{ url: B.url }], loadBalancing: { strategy: 'round-robin', ejectAfter: 2, ejectMs: 60_000, ...lb } }],
    );
    return { A, B, ...g };
  }

  it("an upstream's own JSON-RPC error (-32000) is not a transport failure: no re-run on another member, no ejection", async () => {
    const { A, B, call, gw } = await combo();
    const before = A.stats().calls + B.stats().calls;
    for (let i = 0; i < 6; i++) expect((await call('r', 'fail')).ok).toBe(false);
    // default failoverOn [not-connected]: each failing call ran exactly once
    expect(A.stats().calls + B.stats().calls - before).toBe(6);
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) seen.add((await call('r')).upstream!);
    expect([...seen].sort()).toEqual(['A', 'B']);
    expect(gw.balancer?.snapshot?.()[0]?.members.every((m: any) => !m.ejectedUntil)).toBe(true);
  });

  it('classifyFailure: only gateway-side transport failures are not-connected', () => {
    expect(classifyFailure({ success: false, durationMs: 1, error: { code: -32000, message: 'tool failed' } } as any)).toBe('error');
    // an upstream that itself answers -32001 did not time out at the gateway
    expect(classifyFailure({ success: false, durationMs: 1, error: { code: -32001, message: 'upstream says timeout' } } as any)).toBe('error');
  });

  it('timeouts fail over (when configured) and eject; cost is charged once; cache hits skip upstream and balancer', async () => {
    const { A, B, call } = await combo({ failoverOn: ['not-connected', 'timeout'] });
    A.setMode('stall');
    const r1 = await call('r', 'priced');
    const r2 = await call('r', 'priced');
    expect(r1.ok && r2.ok).toBe(true);
    // budget 3 per client: two charged calls so far (failover attempts are not charged twice)
    expect((await call('r', 'priced')).ok).toBe(true);
    const over = await call('r', 'priced');
    expect(over.ok).toBe(false);
    expect(over.status).toBe(429);
    // other client unaffected
    expect((await call('r', 'priced', {}, 'z'.repeat(40))).ok).toBe(true);
    A.setMode('ok');
    const c0 = A.stats().calls + B.stats().calls;
    const c = [];
    for (let i = 0; i < 4; i++) c.push(await call('r', 'cached', { q: 1 }, 'z'.repeat(40))); // k1's budget is spent (budgets cover every tool)
    expect(c.map((x) => `${x.status}:${x.code ?? ""}:${JSON.stringify(x.body).slice(0, 160)}`).filter((x) => !x.startsWith("200"))).toEqual([]);
    expect(A.stats().calls + B.stats().calls - c0).toBe(1);
  });
});
