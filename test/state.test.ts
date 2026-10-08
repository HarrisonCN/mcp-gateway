import { describe, it, expect, afterEach } from 'vitest';
import { Gateway } from '../src/gateway/index.js';
import { MemoryStateStore, PrefixedStateStore, RedisStateStore, RespParser, createStateStore, encodeCommand } from '../src/state/index.js';
import { createStoreRateLimiter, StoreAuthLockout } from '../src/state/shared.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';
import { startFakeRedis, type FakeRedis } from './fixtures/fake-redis.js';
import type { Request } from 'express';

logger.setLevel('error');

let redis: FakeRedis | undefined;
let gateways: Gateway[] = [];
let stores: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const g of gateways) await g.stop();
  gateways = [];
  for (const s of stores) await s.close();
  stores = [];
  await redis?.close();
  redis = undefined;
});

const base: GatewayConfig = { port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false }, servers: [] };

async function start(config: GatewayConfig): Promise<string> {
  const g = new Gateway(config);
  await g.start();
  gateways.push(g);
  return `http://127.0.0.1:${g.address()!.port}`;
}

describe('RESP protocol', () => {
  it('parses values split across chunks', () => {
    const p = new RespParser();
    expect(p.push(Buffer.from('+OK\r\n:4'))).toEqual(['OK']);
    expect(p.push(Buffer.from('2\r\n$5\r\nhel'))).toEqual([42]);
    expect(p.push(Buffer.from('lo\r\n$-1\r\n*2\r\n:1\r\n*1\r\n+x\r\n'))).toEqual(['hello', null, [1, ['x']]]);
    const [err] = p.push(Buffer.from('-ERR boom\r\n'));
    expect(err).toBeInstanceOf(Error);
    expect(() => new RespParser().push(Buffer.from('?\r\n'))).toThrow(/protocol error/);
  });

  it('encodes commands as RESP arrays of bulk strings', () => {
    expect(encodeCommand(['SET', 'k', 'ü', 5]).toString()).toBe('*4\r\n$3\r\nSET\r\n$1\r\nk\r\n$2\r\nü\r\n$1\r\n5\r\n');
  });
});

describe('state stores', () => {
  it('memory store: incr keeps the first TTL, set/get/del/pttl', async () => {
    let t = 1_000;
    const s = new MemoryStateStore(() => t);
    stores.push(s);
    expect(await s.incr('a', 100)).toBe(1);
    t += 60;
    expect(await s.incr('a', 100, 5)).toBe(6);
    expect(await s.pttl('a')).toBe(40);
    t += 50;
    expect(await s.get('a')).toBeUndefined();
    await s.set('b', 'x');
    expect(await s.pttl('b')).toBe(-1);
    expect(await s.pttl('nope')).toBe(-2);
    await s.del('b');
    expect(s.size()).toBe(0);
  });

  it('redis store against a RESP server (auth, transactions, prefixes)', async () => {
    redis = await startFakeRedis({ password: 's3cret' });
    const store = createStateStore({ store: 'redis', redis: { url: `${redis.url}/2`, keyPrefix: 'gw1:' } });
    stores.push(store);
    expect(store.kind).toBe('redis');
    await store.ping();
    expect(await store.incr('n', 10_000)).toBe(1);
    expect(await store.incr('n', 10_000, 2)).toBe(3);
    expect(await store.pttl('n')).toBeGreaterThan(9_000);
    await store.set('k', 'v', 5_000);
    expect(await store.get('k')).toBe('v');
    await store.set('p', 'forever');
    expect(await store.pttl('p')).toBe(-1);
    await store.del('k');
    expect(await store.get('k')).toBeUndefined();
    expect(redis.commands.some((c) => c[0] === 'AUTH' && c[1] === 's3cret')).toBe(true);
    expect(redis.commands.some((c) => c[0] === 'SELECT' && c[1] === '2')).toBe(true);
    expect(redis.commands.some((c) => c[1] === 'gw1:n')).toBe(true);
  });

  it('redis store: a failed AUTH never leaves an unauthenticated connection behind (3.0.1)', async () => {
    redis = await startFakeRedis({ password: 'right' });
    const wrong = new RedisStateStore({ url: redis.url.replace(':right@', ':wrong@') });
    await expect(wrong.ping()).rejects.toThrow(/WRONGPASS/);
    // Second command must authenticate again (and fail the same way), not reuse the socket without AUTH.
    await expect(wrong.ping()).rejects.toThrow(/WRONGPASS/);
    expect(redis.commands.filter((c) => c[0] === 'AUTH').length).toBe(2);
    await wrong.close();
  });

  it('redis store rejects bad URLs and reports connection failures', async () => {
    expect(() => new RedisStateStore({ url: 'http://x' })).toThrow(/redis:\/\//);
    expect(() => createStateStore({ store: 'redis' })).toThrow(/url/);
    const s = new RedisStateStore({ url: 'redis://127.0.0.1:1', connectTimeoutMs: 500 });
    await expect(s.ping()).rejects.toThrow();
    await s.close();
    await expect(s.get('x')).rejects.toThrow(/closed/);
    expect(createStateStore(undefined).kind).toBe('memory');
  });

  it('store rate limiter: shared sliding window, denied requests are not counted, fails open', async () => {
    const mem = new PrefixedStateStore(new MemoryStateStore(), 'x:');
    stores.push(mem);
    const req = { clientId: 'c1', ip: '1.1.1.1' } as unknown as Request;
    const a = createStoreRateLimiter({ limit: 2, windowSeconds: 60 }, mem, { now: () => 30_000 });
    const b = createStoreRateLimiter({ limit: 2, windowSeconds: 60 }, mem, { now: () => 30_000 });
    expect((await a.take(req))!.allowed).toBe(true);
    expect((await b.take(req))!.allowed).toBe(true);
    const denied = (await a.take(req))!;
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfter).toBe(30);
    expect(await mem.get('rl:60:c1:0')).toBe('2');

    const broken = { kind: 'broken', incr: () => Promise.reject(new Error('down')), get: () => Promise.reject(new Error('down')) } as never;
    expect((await createStoreRateLimiter({ limit: 1, windowSeconds: 1 }, broken).take(req))!.allowed).toBe(true);
    expect((await createStoreRateLimiter({ limit: 1, windowSeconds: 1 }, broken, { failureMode: 'closed' }).take(req))!.allowed).toBe(false);
  });

  it('store lockout: failures on any instance lock the IP everywhere', async () => {
    const mem = new MemoryStateStore();
    stores.push(mem);
    const a = new StoreAuthLockout({ maxFailures: 2, lockoutSeconds: 30 }, mem);
    const b = new StoreAuthLockout({ maxFailures: 2, lockoutSeconds: 30 }, mem);
    expect(await a.fail('9.9.9.9')).toBe(false);
    expect(await b.fail('9.9.9.9')).toBe(true);
    expect(await a.lockedFor('9.9.9.9')).toBe(30);
    expect(b.status()).toMatchObject({ lockedClients: 1, lockoutsTotal: 1, shared: true });
    await a.success('8.8.8.8');
    expect(await a.lockedFor('8.8.8.8')).toBe(0);
  });
});

describe('multi-instance gateways sharing Redis', () => {
  const sharedConfig = (url: string): GatewayConfig => ({
    ...base,
    auth: { strategy: 'api-key', apiKeys: [{ key: 'k'.repeat(32), name: 'aura' }] },
    rateLimit: { limit: 3, windowSeconds: 3600, perKey: true },
    security: { authLockout: { maxFailures: 2, lockoutSeconds: 60 } },
    state: { store: 'redis', redis: { url } },
  });
  const key = { authorization: `Bearer ${'k'.repeat(32)}`, 'content-type': 'application/json' };

  it('enforces one rate limit across instances', async () => {
    redis = await startFakeRedis();
    const [a, b] = [await start(sharedConfig(redis.url)), await start(sharedConfig(redis.url))];
    const call = (u: string) => fetch(`${u}/api/v1/tools/call`, { method: 'POST', headers: key, body: JSON.stringify({ tool: 'nope' }) });
    expect((await call(a)).status).toBe(404);
    expect((await call(b)).status).toBe(404);
    expect((await call(a)).status).toBe(404);
    // Sliding window: right after a window boundary the previous window is
    // weighted slightly below 1, so allow one extra call before the limit hits.
    let limited = await call(b);
    if (limited.status !== 429) limited = await call(a);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    const health = (await (await fetch(`${a}/api/v1/health`)).json()) as { state: string };
    expect(health.state).toBe('redis');
  });

  it('locks out an IP cluster-wide', async () => {
    redis = await startFakeRedis();
    const [a, b] = [await start(sharedConfig(redis.url)), await start(sharedConfig(redis.url))];
    const bad = { authorization: 'Bearer wrong' };
    expect((await fetch(`${a}/api/v1/tools`, { headers: bad })).status).toBe(401);
    expect((await fetch(`${b}/api/v1/tools`, { headers: bad })).status).toBe(401);
    // allow the async failure bookkeeping to land
    await new Promise((r) => setTimeout(r, 50));
    const locked = await fetch(`${a}/api/v1/tools`, { headers: key });
    expect(locked.status).toBe(429);
  });

  it('accepts an MCP session opened on another instance', async () => {
    redis = await startFakeRedis();
    const [a, b] = [await start(sharedConfig(redis.url)), await start(sharedConfig(redis.url))];
    const H = { ...key, accept: 'application/json, text/event-stream' };
    const init = await fetch(`${a}/mcp`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'aura', version: '1' } } }),
    });
    const sid = init.headers.get('mcp-session-id')!;
    await new Promise((r) => setTimeout(r, 30));
    const list = await fetch(`${b}/mcp`, { method: 'POST', headers: { ...H, 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { result: { tools: unknown[] } }).result.tools).toEqual([]);
    const sessions = gateways[1]!.getMcpEndpoint()!.getSessions();
    expect(sessions.map((s) => s.id)).toEqual([sid]);
    expect(sessions[0]!.clientInfo?.name).toBe('aura');
    // a different client cannot adopt it
    const other = await fetch(`${b}/mcp`, { method: 'POST', headers: { ...H, authorization: 'Bearer nope', 'mcp-session-id': sid }, body: '{}' });
    expect(other.status).toBe(401);
    const del = await fetch(`${b}/mcp`, { method: 'DELETE', headers: { ...H, 'mcp-session-id': sid } });
    expect(del.status).toBe(204);
  });

  it('starts and fails open when Redis is unreachable', async () => {
    const url = await start({ ...sharedConfig('redis://127.0.0.1:1'), state: { store: 'redis', redis: { url: 'redis://127.0.0.1:1', connectTimeoutMs: 200 } } });
    const r = await fetch(`${url}/api/v1/tools/call`, { method: 'POST', headers: key, body: JSON.stringify({ tool: 'nope' }) });
    expect(r.status).toBe(404);
  });
});

describe.runIf(!!process.env.REDIS_URL)('real Redis (REDIS_URL)', () => {
  it('round-trips through a real server', async () => {
    const store = createStateStore({ store: 'redis', redis: { url: process.env.REDIS_URL!, keyPrefix: `test:${Date.now()}:` } });
    stores.push(store);
    expect(await store.incr('n', 5_000)).toBe(1);
    expect(await store.incr('n', 5_000)).toBe(2);
    expect(await store.pttl('n')).toBeGreaterThan(0);
    await store.set('s', 'v');
    expect(await store.get('s')).toBe('v');
    await store.del('s');
    await store.del('n');
  });
});
