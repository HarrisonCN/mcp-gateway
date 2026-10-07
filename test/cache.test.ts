import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { Gateway } from '../src/gateway/index.js';
import { ToolCache, canonicalJson } from '../src/gateway/cache.js';
import type { CacheConfig, ProxyResponse } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));

const ok = (v: unknown): ProxyResponse => ({ success: true, durationMs: 5, result: v });

describe('ToolCache', () => {
  it('canonical JSON ignores key order and undefined', () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: undefined }] })).toBe('{"a":[1,{"d":2}],"b":1}');
    expect(canonicalJson(undefined)).toBe('null');
  });

  it('caches only opted-in tools, per client by default, with TTL and LRU', async () => {
    let t = 0;
    const cfg: CacheConfig = { maxEntries: 2, rules: [{ tools: ['search*'], ttlSeconds: 10 }, { tools: ['gh/list'], scope: 'shared' }] };
    const c = new ToolCache(() => cfg, () => t);
    let n = 0;
    const fetch = () => Promise.resolve(ok(++n));
    const k = { serverId: 'gh', tool: 'search', args: { q: 'x' }, clientId: 'a' };
    expect(await c.run(k, fetch)).toMatchObject({ status: 'miss', result: { result: 1 } });
    expect(await c.run({ ...k, args: { q: 'x' } }, fetch)).toMatchObject({ status: 'hit', result: { result: 1 } });
    expect(await c.run({ ...k, clientId: 'b' }, fetch)).toMatchObject({ status: 'miss', result: { result: 2 } });
    expect(await c.run({ serverId: 'gh', tool: 'other', args: {} }, fetch)).toMatchObject({ status: 'bypass' });
    // shared scope ignores the caller; default TTL 60 s
    expect((await c.run({ serverId: 'gh', tool: 'list', args: {}, clientId: 'a' }, fetch)).status).toBe('miss');
    expect(c.snapshot()).toMatchObject({ entries: 2, evictions: 1, hits: 1 });
    expect((await c.run({ serverId: 'gh', tool: 'list', args: {}, clientId: 'z' }, fetch)).status).toBe('hit');
    t += 11_000;
    expect((await c.run({ ...k, clientId: 'b' }, fetch)).status).toBe('miss');
    expect(c.purge('nope')).toBe(0);
    expect(c.purge('gh')).toBeGreaterThan(0);
    expect(c.snapshot().entries).toBe(0);
  });

  it('never caches failures or isError results, de-duplicates in-flight calls', async () => {
    const c = new ToolCache(() => ({ rules: [{ tools: ['*'] }] }));
    expect((await c.run({ serverId: 's', tool: 't', args: {} }, async () => ({ success: false, durationMs: 1 }))).status).toBe('miss');
    expect((await c.run({ serverId: 's', tool: 't', args: {} }, async () => ok({ isError: true }))).status).toBe('miss');
    expect(c.snapshot().entries).toBe(0);
    let calls = 0;
    let release!: () => void;
    const slow = () => new Promise<ProxyResponse>((r) => { calls++; release = () => r(ok('slow')); });
    const k = { serverId: 's', tool: 'x', args: { a: 1 } };
    const p1 = c.run(k, slow);
    const p2 = c.run(k, slow);
    await new Promise((r) => setTimeout(r, 5));
    release();
    expect([(await p1).status, (await p2).status]).toEqual(['miss', 'shared']);
    expect(calls).toBe(1);
    expect(c.snapshot().deduped).toBe(1);
  });

  it('dedupeOnly shares in-flight calls without caching; disabled cache bypasses', async () => {
    const c = new ToolCache(() => ({ rules: [{ dedupeOnly: true }] }));
    await c.run({ serverId: 's', tool: 't', args: {} }, async () => ok(1));
    expect((await c.run({ serverId: 's', tool: 't', args: {} }, async () => ok(2))).result.result).toBe(2);
    const off = new ToolCache(() => ({ enabled: false, rules: [{}] }));
    expect((await off.run({ serverId: 's', tool: 't', args: {} }, async () => ok(1))).status).toBe('bypass');
    expect(off.snapshot().enabled).toBe(false);
  });
});

describe('cache in the gateway', () => {
  let gw: Gateway | undefined;
  afterEach(async () => {
    await gw?.stop();
    gw = undefined;
  });

  it('serves repeated calls from the cache, after policy, and purges on DELETE', async () => {
    gw = new Gateway({
      port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false },
      servers: [{ id: 'fake', name: 'fake', transport: 'stdio', command: process.execPath, args: [fixture], timeout: 5000 }],
      cache: { rules: [{ tools: ['echo'], ttlSeconds: 60 }] },
      policy: { rules: [{ name: 'no-x', effect: 'deny', tools: ['echo'], args: [{ path: 'x', exists: true }] }] },
    });
    await gw.start();
    const url = `http://127.0.0.1:${gw.address()!.port}`;
    const call = (args: Record<string, unknown>) =>
      fetch(`${url}/api/v1/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'echo', arguments: args }) });
    expect((await call({ a: 1 })).status).toBe(200);
    const second = (await (await call({ a: 1 })).json()) as { durationMs: number };
    expect(second.durationMs).toBe(0);
    expect((await call({ x: 1 })).status).toBe(403);
    const stats = (await (await fetch(`${url}/api/v1/cache`)).json()) as { hits: number; misses: number; entries: number };
    expect(stats).toMatchObject({ hits: 1, misses: 1, entries: 1 });
    const purged = (await (await fetch(`${url}/api/v1/cache?server=fake`, { method: 'DELETE' })).json()) as { purged: number };
    expect(purged.purged).toBe(1);
  });
});
