/**
 * 13.7.0 multi-instance reliability: real Redis (spawned `redis-server`), TCP fault injection (latency, stalls,
 * resets, partitions, server crash + restart), and several gateway instances sharing one store.
 *
 * Covers: the Redis client's reconnect path (MGW-2026-012 reply-queue regression, AUTH / SELECT ordering), the breaker
 * across a crash and restart, shared rate limits across N instances, token revocation across instances and through a
 * partition, MCP session recovery on another instance (resume, termination, store data loss), and connection
 * migration (cancellation and progress for a call in flight on another instance).
 *
 * Skipped when no `redis-server` binary is available (CI job "Multi-instance reliability (real Redis)" installs it).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Gateway } from '../src/gateway/index.js';
import { RedisStateStore, createStateStore, StoreUnavailableError, type StateStore } from '../src/state/index.js';
import { createStoreRateLimiter } from '../src/state/shared.js';
import { agentState } from '../src/features/agent-identity.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';
import { fakeServer } from './helpers/feature-gw.js';
import { redisServerAvailable, startRealRedis, startFaultProxy, type RealRedis, type FaultProxy } from './fixtures/real-redis.js';
import type { Request } from 'express';

logger.setLevel('error');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await Promise.resolve(f()).catch(() => undefined);
  cleanup = [];
  agentState.reset();
});

async function redis(opts: { password?: string } = {}): Promise<RealRedis> {
  const r = await startRealRedis(opts);
  cleanup.push(() => r.close());
  return r;
}
async function proxy(r: RealRedis): Promise<FaultProxy> {
  const p = await startFaultProxy(r.port);
  cleanup.push(() => p.close());
  return p;
}
function store(url: string, extra: { commandTimeoutMs?: number; connectTimeoutMs?: number } = {}): RedisStateStore {
  const s = new RedisStateStore({ url, commandTimeoutMs: 1_000, connectTimeoutMs: 1_000, ...extra });
  cleanup.push(() => s.close());
  return s;
}
async function poll<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms: number, step = 50): Promise<{ v: T; after: number }> {
  const t0 = Date.now();
  let v = await fn();
  while (!ok(v) && Date.now() - t0 < ms) {
    await sleep(step);
    v = await fn();
  }
  return { v, after: Date.now() - t0 };
}

describe.runIf(redisServerAvailable)('13.7.0 real Redis client: reconnect, faults, ordering', () => {
  it('no command runs before AUTH + SELECT finished on a (re)connected socket', async () => {
    const r = await redis({ password: 'pw-13-7' });
    const p = await proxy(r);
    // db 5 holds the value; db 0 a decoy a command would read if it overtook SELECT
    const seed5 = store(`${r.url}/5`);
    await seed5.set('who', 'db5');
    await seed5.close();
    await r.cmd('SET', 'who', 'db0');
    p.latency(25); // widen the connect → AUTH → SELECT window
    const s = store(`${p.url(r.url)}/5`);
    const results: Array<Promise<string | undefined>> = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 150) {
      results.push(s.get('who'));
      await new Promise((res) => setImmediate(res));
    }
    const got = await Promise.all(results);
    expect(got.length).toBeGreaterThan(5);
    expect(new Set(got)).toEqual(new Set(['db5']));
  });

  it('MGW-2026-012 regression: late replies after timeouts + reconnect are never handed to other commands', async () => {
    const r = await redis();
    const p = await proxy(r);
    const s = store(p.url(r.url), { commandTimeoutMs: 150 });
    for (let i = 0; i < 40; i++) await s.set(`k${i}`, `v${i}`);
    // replies slower than the command timeout: every command times out, its reply arrives on a discarded socket
    p.latency(300);
    const slow = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => s.get(`k${i}`)));
    expect(slow.every((x) => x.status === 'rejected')).toBe(true);
    p.heal();
    await sleep(400); // the late replies have arrived by now
    for (let round = 0; round < 3; round++) {
      const got = await Promise.all(Array.from({ length: 40 }, (_, i) => s.get(`k${i}`)));
      expect(got).toEqual(Array.from({ length: 40 }, (_, i) => `v${i}`));
    }
    expect(p.accepted).toBeGreaterThan(1); // it did reconnect
  });

  it('connection reset mid-pipeline: each command fails or gets ITS reply, then the client recovers', async () => {
    const r = await redis();
    const p = await proxy(r);
    const s = store(p.url(r.url));
    for (let i = 0; i < 50; i++) await s.set(`r${i}`, `x${i}`);
    for (let round = 0; round < 5; round++) {
      const all = Promise.allSettled(Array.from({ length: 300 }, (_, i) => s.get(`r${i % 50}`).then((v) => [i % 50, v] as const)));
      await sleep(1 + round);
      p.reset();
      for (const x of await all) if (x.status === 'fulfilled') expect(x.value[1]).toBe(`x${x.value[0]}`);
    }
    await sleep(50); // the drop has been noticed (commands written to the half-closed socket before that fail, they never mis-match)
    expect(await Promise.all([0, 1, 2].map((i) => s.get(`r${i}`)))).toEqual(['x0', 'x1', 'x2']);
  });

  it('server crash: the guarded store fails fast while down and recovers after restart', async () => {
    const r = await redis();
    const g = createStateStore({ store: 'redis', redis: { url: r.url, connectTimeoutMs: 300, commandTimeoutMs: 300 } });
    cleanup.push(() => g.close());
    await g.set('a', '1');
    await r.kill();
    await expect(g.get('a')).rejects.toThrow();
    const t0 = Date.now();
    await expect(g.get('a')).rejects.toBeInstanceOf(StoreUnavailableError);
    expect(Date.now() - t0).toBeLessThan(50);
    await r.restart();
    const { v } = await poll(() => g.ping().then(() => true, () => false), (x) => x, 5_000, 200);
    expect(v).toBe(true);
    expect(g.health?.().state).toBe('closed');
    expect(await g.get('a')).toBeUndefined(); // no persistence: data is gone, the client is fine
  });
});

describe.runIf(redisServerAvailable)('13.7.0 shared rate limit across N instances (real Redis)', () => {
  it('N=4 instances, 80 concurrent requests, limit 10: exactly 10 allowed', async () => {
    const r = await redis();
    const ns = `rl-${Date.now()}`;
    const limiters = Array.from({ length: 4 }, () => createStoreRateLimiter({ limit: 10, windowSeconds: 3600, perKey: true }, store(r.url), { namespace: ns, failureMode: 'closed' }));
    const req = { clientId: 'aura' } as unknown as Request;
    const d = await Promise.all(Array.from({ length: 80 }, (_, i) => limiters[i % 4]!.take!(req)));
    expect(d.filter((x) => x.allowed).length).toBe(10);
    // denied requests were not counted: still exactly 10 in the window
    expect(Number(await r.cmd('GET', `${ns}:3600:aura:${Math.floor(Date.now() / 3_600_000)}`))).toBe(10);
  });

  it('three gateways: the cluster-wide limit holds under a concurrent burst; a partitioned instance fails closed', async () => {
    const r = await redis();
    const p = await proxy(r);
    const prefix = `gw-${Date.now()}:`;
    const cfg = (url: string): GatewayConfig => ({
      port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false }, servers: [],
      auth: { strategy: 'api-key', apiKeys: [{ key: 'k'.repeat(32), name: 'aura' }] },
      rateLimit: { limit: 6, windowSeconds: 3600, perKey: true },
      state: { store: 'redis', failureMode: 'closed', redis: { url, connectTimeoutMs: 300, commandTimeoutMs: 300, keyPrefix: prefix } },
    } as GatewayConfig);
    const urls: string[] = [];
    for (const u of [r.url, r.url, p.url(r.url)]) {
      const g = new Gateway(cfg(u));
      await g.start();
      cleanup.push(() => g.stop());
      urls.push(`http://127.0.0.1:${g.address()!.port}`);
    }
    const H = { authorization: `Bearer ${'k'.repeat(32)}`, 'content-type': 'application/json' };
    const call = (u: string) => fetch(`${u}/api/v1/tools/call`, { method: 'POST', headers: H, body: JSON.stringify({ tool: 'nope' }) }).then((x) => x.status);
    const st = await Promise.all(Array.from({ length: 30 }, (_, i) => call(urls[i % 3]!)));
    expect(st.filter((s) => s !== 429).length).toBe(6);
    p.refuse();
    expect(await call(urls[2]!)).toBe(429); // store unreachable + failureMode closed
  });
});

const KEY = 'k'.repeat(40);
const agentCfg = { signingKey: KEY, agents: [{ id: 'helper', tools: ['fake/*'], delegators: ['*'] }] };
const H = (key: string) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' });
async function gateway(redisUrl: string, extra: Partial<GatewayConfig> = {}): Promise<string> {
  const g = new Gateway({
    port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false },
    servers: [fakeServer('fake', { SLOW_MS: '3000', FEATURES: '1', EXTRA_TOOLS: 'slow' })],
    auth: { strategy: 'api-key', apiKeys: ['op', { key: 'alice-key', name: 'alice' }] },
    agentIdentity: agentCfg,
    state: { store: 'redis', redis: { url: redisUrl, connectTimeoutMs: 300, commandTimeoutMs: 300 } },
    ...extra,
  } as unknown as GatewayConfig);
  await g.start();
  cleanup.push(() => g.stop());
  return `http://127.0.0.1:${g.address()!.port}`;
}
const post = (url: string, key: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}${path}`, { method: 'POST', headers: { ...H(key), ...headers }, body: JSON.stringify(body) });

describe.runIf(redisServerAvailable)('13.7.0 token revocation consistency (real Redis)', () => {
  const mint = async (url: string) => (await (await post(url, 'alice-key', '/api/v1/features/agent-identity/token', { agent: 'helper' })).json()) as { access_token: string; jti: string };
  const call = (url: string, token: string) => post(url, 'alice-key', '/api/v1/features/agent-identity/call', { token, server: 'fake', tool: 'echo' }).then((r) => r.status);
  const revoke = (url: string, jti: string) => post(url, 'op', '/api/v1/admin/agent-identity/revoke', { jti }).then((r) => r.status);

  it('revoked on A is rejected on B and C at once (no positive cache of "not revoked")', async () => {
    const r = await redis();
    const [a, b, c] = [await gateway(r.url), await gateway(r.url), await gateway(r.url)];
    const t = await mint(a);
    expect(await call(b, t.access_token)).toBe(200);
    expect(await call(c, t.access_token)).toBe(200);
    expect(await revoke(a, t.jti)).toBe(200);
    agentState.reset(); // instances share this process: drop the local cache so B / C must ask the store
    expect(await call(b, t.access_token)).toBe(401);
    expect(await call(c, t.access_token)).toBe(401);
  }, 30_000);

  it('partition: A cut off from Redis denies (503, fail closed) and rejects the token revoked meanwhile once healed', async () => {
    const r = await redis();
    const p = await proxy(r);
    const a = await gateway(p.url(r.url));
    const b = await gateway(r.url);
    const t = await mint(b);
    expect(await call(a, t.access_token)).toBe(200);
    p.refuse();
    expect(await revoke(b, t.jti)).toBe(200);
    agentState.reset();
    expect(await call(a, t.access_token)).toBe(503);
    p.heal();
    const { v, after } = await poll(() => call(a, t.access_token), (s) => s === 401, 5_000, 100);
    expect(v).toBe(401);
    expect(after).toBeLessThan(2_500); // breaker cooldown (1 s) + one probe
  }, 30_000);
});

describe.runIf(redisServerAvailable)('13.7.0 MCP session recovery + connection migration (real Redis)', () => {
  const init = async (url: string) => {
    const res = await post(url, 'alice-key', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'aura', version: '1' } } });
    expect(res.status).toBe(200);
    const sid = res.headers.get('mcp-session-id')!;
    await post(url, 'alice-key', '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': sid });
    return sid;
  };
  const rpc = (url: string, sid: string, msg: Record<string, unknown>) => post(url, 'alice-key', '/mcp', { jsonrpc: '2.0', ...msg }, { 'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18' });
  const list = (url: string, sid: string) => rpc(url, sid, { id: 2, method: 'tools/list' }).then((r) => r.status);

  it('a session created on A resumes on B and C (shared store)', async () => {
    const r = await redis();
    const [a, b, c] = [await gateway(r.url), await gateway(r.url), await gateway(r.url)];
    const sid = await init(a);
    await sleep(50);
    expect(await list(b, sid)).toBe(200);
    expect(await list(c, sid)).toBe(200);
    expect(await list(a, sid)).toBe(200);
  }, 30_000);

  it('DELETE on A ends the session on every instance within the bound (no resurrection by a refresh on B)', async () => {
    const r = await redis();
    const [a, b] = [await gateway(r.url), await gateway(r.url)];
    const sid = await init(a);
    await sleep(50);
    expect(await list(b, sid)).toBe(200); // B adopted it
    const del = await fetch(`${a}/mcp`, { method: 'DELETE', headers: { ...H('alice-key'), 'mcp-session-id': sid } });
    expect(del.status).toBe(204);
    const { v, after } = await poll(() => list(b, sid), (s) => s === 404, 3_000, 100);
    expect(v).toBe(404);
    expect(after).toBeLessThan(1_500);
    const c = await gateway(r.url);
    expect(await list(c, sid)).toBe(404);
    expect(await list(a, sid)).toBe(404);
  }, 30_000);

  it('store data loss (Redis restart): live sessions keep working and are re-published for other instances', async () => {
    const r = await redis();
    const [a, b] = [await gateway(r.url), await gateway(r.url)];
    const sid = await init(a);
    await r.kill();
    await r.restart();
    await sleep(1_100); // breaker cooldown
    const { v } = await poll(() => list(a, sid), (s) => s === 200, 3_000, 100);
    expect(v).toBe(200);
    const { v: vb, after } = await poll(() => list(b, sid), (s) => s === 200, 3_000, 100);
    expect(vb).toBe(200);
    expect(after).toBeLessThan(1_500);
  }, 30_000);

  it('migration: a cancel sent to B stops the call in flight on A', async () => {
    const r = await redis();
    const [a, b] = [await gateway(r.url), await gateway(r.url)];
    const sid = await init(a);
    await sleep(50);
    expect(await list(b, sid)).toBe(200);
    const t0 = Date.now();
    const inflight = rpc(a, sid, { id: 77, method: 'tools/call', params: { name: 'fake__slow', arguments: {} } }).then(async (res) => ({ status: res.status, body: await res.text(), ms: Date.now() - t0 }));
    await sleep(200);
    const cancel = await rpc(b, sid, { method: 'notifications/cancelled', params: { requestId: 77, reason: 'client moved' } });
    expect(cancel.status).toBe(202);
    const done = await inflight;
    expect(done.ms).toBeLessThan(2_000); // the upstream call takes 3 s when not cancelled
    expect(done.body).not.toMatch(/"content"/); // no tool result for a cancelled request
  }, 30_000);

  it('migration: progress for a call stays on its own stream (A) while the client works on B', async () => {
    const r = await redis();
    const [a, b] = [await gateway(r.url), await gateway(r.url)];
    const sid = await init(a);
    const res = await rpc(a, sid, { id: 9, method: 'tools/call', params: { name: 'fake__progress', arguments: {}, _meta: { progressToken: 'p1' } } });
    expect(await list(b, sid)).toBe(200);
    const text = await res.text();
    const progress = [...text.matchAll(/"progress":(\d)/g)].map((m) => Number(m[1]));
    expect(progress).toEqual([1, 2, 3]);
    expect(text).toMatch(/"id":9/);
    expect(text).toMatch(/done/);
  }, 30_000);
});
