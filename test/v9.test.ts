/** 9.0: schema v9 only (`store` replaces `state`), event-sourced store (`store.backend: eventlog`). */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { validateConfig, generateDefaultConfig, loadConfig } from '../src/config/loader.js';
import { migrateConfigText } from '../src/config/migrate.js';
import { configDeprecations, removedConfigKeys, normalizeStoreV9, DEPRECATIONS } from '../src/utils/deprecations.js';
import { portableConfig } from '../src/gateway/admin.js';
import { distributedConfig } from '../src/gateway/control-plane.js';
import { EventLogStateStore, createStateStore } from '../src/state/index.js';
import { Gateway } from '../src/gateway/index.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const tmp = () => mkdtempSync(join(tmpdir(), 'mcpgw-v9-'));
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  delete process.env.MCP_GATEWAY_REDIS_URL;
});

describe('9.0: schema v9', () => {
  it('reads only schema v9; `state` and v8 are refused with the migration hint; nothing deprecated', () => {
    expect(Object.keys(DEPRECATIONS)).toEqual([]); // 11.0
    expect(configDeprecations({ version: 11, state: {} })).toEqual([]);
    expect(() => validateConfig({ version: 8, servers: [] })).toThrow(/version: config schema v8 was removed in 9.0 — use `version: 11`; run `mcp-gateway migrate --to 11`/);
    expect(() => validateConfig({ version: 11, servers: [], state: { store: 'memory' } })).toThrow(/state: removed in 9.0 — use `store: \{ backend, … \}` \(`state.store` → `store.backend`\)/);
    expect(() => validateConfig({ servers: [], state: {} })).toThrow(/state: removed in 9.0/);
    expect(() => validateConfig({ version: 12, servers: [] })).toThrow(/11.0 reads `version: 11`/);
    const v9 = validateConfig({ version: 11, servers: [], store: { backend: 'redis', redis: { url: 'redis://r:6379' }, failureMode: 'closed' } });
    expect(v9.state).toEqual({ store: 'redis', redis: { url: 'redis://r:6379' }, failureMode: 'closed' });
    expect(v9.deprecations?.map((d) => d.id)).toBeUndefined(); // 11.0: nothing deprecated
    expect(validateConfig({ servers: [], store: { backend: 'memory' } }).state?.store).toBe('memory'); // version optional
    expect(() => validateConfig({ version: 11, servers: [], store: { backend: 'redis' } })).toThrow(/store.redis.url is required/);
    expect(() => validateConfig({ version: 11, servers: [], store: { backend: 'sqlite' } })).toThrow();
    expect(removedConfigKeys({ version: 11 })).toEqual([]);
    expect(normalizeStoreV9({ a: 1 })).toEqual({ a: 1 });
    expect(parse(generateDefaultConfig()).version).toBe(11);
  });

  it('eventlog backend: defaults, validation, round trip through portableConfig; data planes get v10 (10.0)', () => {
    const c = validateConfig({ version: 11, servers: [], store: { backend: 'eventlog' } });
    expect(c.state).toEqual({ store: 'eventlog', failureMode: 'open' });
    const e = validateConfig({ version: 11, servers: [], store: { backend: 'eventlog', eventlog: { dir: '/data/s', fsync: true } } });
    expect(e.state?.eventlog).toEqual({ dir: '/data/s', snapshotEvery: 10000, fsync: true });
    expect(() => validateConfig({ servers: [], store: { backend: 'eventlog', eventlog: { snapshotEvery: 0 } } })).toThrow();
    expect(() => validateConfig({ servers: [], store: { backend: 'eventlog', eventlog: { extra: 1 } } })).toThrow();
    const p = portableConfig(e);
    expect(p.store).toEqual({ backend: 'eventlog', eventlog: { dir: '/data/s', snapshotEvery: 10000, fsync: true }, failureMode: 'open' });
    expect(p).not.toHaveProperty('state');
    expect(validateConfig(p).state).toEqual(e.state);
    // no `version` in the file: still converted (8.9 only converted v9 files, so a re-validate of such configs broke).
    expect(portableConfig(validateConfig({ servers: [], store: { backend: 'memory' } })).store).toEqual({ backend: 'memory', failureMode: 'open' });
    expect(distributedConfig({ servers: [] }).version).toBe(10); // 10.0
  });

  it('MCP_GATEWAY_REDIS_URL sets store.backend: redis on a v9 file (8.9 wrote the conflicting `state` block)', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'mcp-gateway.yml'), 'version: 11\nstore: { failureMode: closed }\nservers: []\n');
    process.env.MCP_GATEWAY_REDIS_URL = 'redis://env:6379';
    const cfg = await loadConfig(join(dir, 'mcp-gateway.yml'));
    expect(cfg.state).toMatchObject({ store: 'redis', redis: { url: 'redis://env:6379' }, failureMode: 'closed' });
  });

  it('migrate --to 9 still writes schema v9 (10.0 loads it after --to 10)', () => {
    const src = '# gw\nversion: 8\nstate:\n  store: redis # shared\n  redis: { url: "redis://r:6379" }\nservers: []\n';
    const r = migrateConfigText(src, undefined, 9); // 9.9: the default is --to 10
    expect(r.changes).toEqual(['version: 8 → 9', 'state → store (store → backend)']);
    expect(r.text).toContain('backend: redis # shared');
    expect(() => validateConfig(parse(r.text))).toThrow(/schema v9 was removed in 10.0/); // 10.0
    expect(validateConfig(parse(migrateConfigText(r.text).text)).state?.store).toBe('redis');
    expect(() => validateConfig(parse(src))).toThrow(/schema v8 was removed in 9.0/);
    expect(migrateConfigText(r.text, undefined, 9).changed).toBe(false);
    expect(migrateConfigText('version: 6\nadmin: { configApi: true }\nservers: []\n', undefined, 9).changes).toEqual(['version: 6 → 9', 'admin.configApi → controlPlane.configApi']);
  });
});

describe('9.0: event-sourced store', () => {
  it('appends events, replays them after a restart and keeps absolute expiry', async () => {
    const dir = tmp();
    let t = 1_000_000;
    const now = () => t;
    const a = new EventLogStateStore({ dir, now });
    expect(await a.incr('rl', 60_000)).toBe(1);
    expect(await a.incr('rl', 60_000, 2)).toBe(3);
    await a.set('sess', 'x', 10_000);
    await a.set('keep', 'forever');
    await a.set('gone', '1');
    await a.del('gone');
    await a.del('missing'); // no event
    expect(a.stats()).toMatchObject({ kind: 'eventlog', keys: 3, totalEvents: 6, eventsSinceSnapshot: 6, snapshots: 0 });
    expect(readFileSync(join(dir, 'events.log'), 'utf8').trim().split('\n')).toHaveLength(6);
    // crash: no close(), a torn last line
    appendFileSync(join(dir, 'events.log'), '{"op":"set","k":"torn"');
    t += 5_000;
    const b = new EventLogStateStore({ dir, now });
    closers.push(() => b.close());
    expect(b.stats().replayed).toBe(6);
    expect(await b.get('rl')).toBe('3');
    expect(await b.pttl('rl')).toBe(55_000);
    expect(await b.get('sess')).toBe('x');
    expect(await b.pttl('keep')).toBe(-1);
    expect(await b.get('gone')).toBeUndefined();
    expect(await b.get('torn')).toBeUndefined();
    expect(b.stats().snapshots).toBe(1); // the torn log was compacted on open
    await b.set('after', 'crash');
    const c = new EventLogStateStore({ dir, now });
    closers.push(() => c.close());
    expect(await c.get('after')).toBe('crash');
    t += 6_000; // the session expired while the gateway was down
    expect(await b.get('sess')).toBeUndefined();
    expect(await b.pttl('sess')).toBe(-2);
  });

  it('compacts into a snapshot every snapshotEvery events and on close; loads snapshot + log', async () => {
    const dir = tmp();
    const a = new EventLogStateStore({ dir, snapshotEvery: 3 });
    for (let i = 0; i < 4; i++) await a.incr('n', 0);
    expect(a.stats()).toMatchObject({ snapshots: 1, eventsSinceSnapshot: 1, totalEvents: 4 });
    expect(existsSync(join(dir, 'snapshot.json'))).toBe(true);
    expect(readFileSync(join(dir, 'events.log'), 'utf8').trim().split('\n')).toHaveLength(1);
    await a.close();
    expect(readFileSync(join(dir, 'events.log'), 'utf8')).toBe('');
    await expect(a.set('x', '1')).rejects.toThrow(/closed/);
    await expect(a.ping()).rejects.toThrow(/closed/);
    const b = new EventLogStateStore({ dir });
    closers.push(() => b.close());
    expect(await b.get('n')).toBe('4');
    expect(b.stats().replayed).toBe(0);
    // corrupt snapshot: ignored (logged), the store still starts
    writeFileSync(join(dir, 'snapshot.json'), '{nope');
    const c = new EventLogStateStore({ dir: dir });
    closers.push(() => c.close());
    expect(await c.get('n')).toBeUndefined();
  });

  it('createStateStore resolves a relative dir against the config directory', async () => {
    const base = tmp();
    const s = createStateStore({ store: 'eventlog', eventlog: { dir: 'st' } }, base) as EventLogStateStore;
    closers.push(() => s.close());
    expect(s.kind).toBe('eventlog');
    expect(s.stats().dir).toBe(join(base, 'st'));
    expect(() => createStateStore({ store: 'redis' })).toThrow(/store.redis.url is not set/);
  });

  it('gateway: rate-limit windows survive a restart; GET /admin/store and compaction', async () => {
    const dir = tmp();
    const key = 'k'.repeat(32);
    const cfg: GatewayConfig = {
      port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false }, servers: [], configDir: dir,
      auth: { strategy: 'api-key', apiKeys: [key] },
      rateLimit: { limit: 3, windowSeconds: 3600, perKey: true },
      state: { store: 'eventlog', eventlog: { dir: 'store' }, failureMode: 'open' },
    } as GatewayConfig;
    const H = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
    const boot = async () => {
      const g = new Gateway(cfg);
      await g.start();
      return { g, u: `http://127.0.0.1:${g.address()!.port}` };
    };
    const call = (u: string) => fetch(`${u}/api/v1/tools/call`, { method: 'POST', headers: H, body: JSON.stringify({ tool: 'nope' }) });
    const one = await boot();
    expect((await call(one.u)).status).toBe(404);
    expect((await call(one.u)).status).toBe(404);
    const st = (await (await fetch(`${one.u}/api/v1/admin/store`, { headers: H })).json()) as any;
    expect(st.backend).toBe('eventlog');
    expect(st.eventlog.dir).toBe(join(dir, 'store'));
    expect(st.eventlog.totalEvents).toBeGreaterThan(0);
    const comp = await fetch(`${one.u}/api/v1/admin/store/compact`, { method: 'POST', headers: H });
    expect(((await comp.json()) as any).eventlog.eventsSinceSnapshot).toBe(0);
    await one.g.stop();
    const two = await boot();
    closers.push(() => two.g.stop());
    let limited = await call(two.u);
    if (limited.status !== 429) limited = await call(two.u);
    expect(limited.status).toBe(429);
  });

  it('GET /admin/store on the memory backend; compaction needs eventlog', async () => {
    const key = 'k'.repeat(32);
    const g = new Gateway({ port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false }, servers: [], auth: { strategy: 'api-key', apiKeys: [key] } } as GatewayConfig);
    await g.start();
    closers.push(() => g.stop());
    const u = `http://127.0.0.1:${g.address()!.port}`;
    const H = { authorization: `Bearer ${key}` };
    expect(await (await fetch(`${u}/api/v1/admin/store`, { headers: H })).json()).toEqual({ backend: 'memory', failureMode: 'open' });
    expect((await fetch(`${u}/api/v1/admin/store/compact`, { method: 'POST', headers: H })).status).toBe(409);
  });
});
