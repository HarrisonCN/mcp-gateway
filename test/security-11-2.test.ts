/** 11.2: multimodal blob ownership + budgets; shared, persistent agent-token revocation (fail-closed). */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway } from '../src/gateway/index.js';
import { startFeatureGw, fakeServer, type FeatureGw } from './helpers/feature-gw.js';
import { startFakeRedis, type FakeRedis } from './fixtures/fake-redis.js';
import { applyMultimodal, multimodalState, mayRead, storedFiles, MultimodalSchema } from '../src/features/multimodal.js';
import { agentState, isRevoked, revokeToken } from '../src/features/agent-identity.js';
import { clientPrincipal } from '../src/auth/authorizer.js';
import { SqliteStateStore, MemoryStateStore } from '../src/state/index.js';
import { validateConfig } from '../src/config/loader.js';
import { securityWarnings } from '../src/security/posture.js';
import type { GatewayConfig, ProxyResponse } from '../src/utils/types.js';

const KEY = 'k'.repeat(40);
const b64 = (n: number) => Buffer.alloc(n, 9).toString('base64');
const img = (n: number): ProxyResponse => ({ success: true, durationMs: 1, result: { content: [{ type: 'image', data: b64(n), mimeType: 'image/png' }] } });
const cfgOf = (mm: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ servers: [], multimodal: { offloadAboveBytes: 100, ...mm }, ...extra }) as unknown as GatewayConfig;
const linkOf = (r: ProxyResponse) => (r.result as { content: Array<{ uri: string }> }).content[0]!.uri;

let h: FeatureGw | undefined;
const gws: Gateway[] = [];
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'mgw-112-'));
  dirs.push(d);
  return d;
};
beforeEach(() => {
  multimodalState.reset();
  agentState.reset();
});
afterEach(async () => {
  await h?.stop();
  h = undefined;
  for (const g of gws.splice(0)) await g.stop();
  multimodalState.reset();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('multimodal blobs: ownership (11.2)', () => {
  const auth = {
    strategy: 'api-key',
    apiKeys: ['op', { key: 'alice-key', name: 'alice' }, { key: 'bob-key', name: 'bob' }, { key: 'carol-key', name: 'carol' }, { key: 'dave-key', name: 'dave', servers: ['other'] }],
  };
  const tenants = [{ id: 't1', servers: ['*'], members: [{ client: 'key:alice', role: 'admin' }, { client: 'key:bob', role: 'admin' }] }, { id: 't2', servers: ['*'], members: [{ client: 'key:carol', role: 'admin' }] }];

  it('only the owner or a tenant mate with the tool permission can read; everyone else gets 404', async () => {
    h = await startFeatureGw({ auth, tenants, multimodal: { offloadAboveBytes: 100 } } as never);
    const get = (key: string, uri: string) => fetch(`${h!.base}${uri}`, { headers: { authorization: `Bearer ${key}` } });
    const cfg = cfgOf({}, { tenants });
    const owned = linkOf(applyMultimodal(img(5000), 'fake', 'cam', cfg, Date.now(), { clientId: 'key:alice', tenant: 't1' })!);
    expect(owned).toMatch(/^\/api\/v1\/features\/multimodal\/blobs\/[A-Za-z0-9_-]{32}$/);
    expect((await get('alice-key', owned)).status).toBe(200);
    expect((await get('bob-key', owned)).status).toBe(200); // same tenant, may call fake/cam
    expect((await get('carol-key', owned)).status).toBe(404); // leaked URL, other tenant
    expect((await get('op', owned)).status).toBe(404); // not the owner, not in the tenant
    const solo = linkOf(applyMultimodal(img(5000), 'fake', 'cam', cfg, Date.now(), { clientId: 'key:dave' })!);
    expect((await get('dave-key', solo)).status).toBe(404); // owner, but no longer allowed to call fake/cam
    const unowned = linkOf(applyMultimodal(img(5000), 'fake', 'cam', cfg)!);
    expect((await get('op', unowned)).status).toBe(404);
    expect(multimodalState.stats.deniedReads).toBe(4);
    expect(mayRead(clientPrincipal('key:x', undefined), { serverId: 'fake', tool: 'cam' })).toBe(false);
  });

  it('signed links: bound to the owner, rejected after expiry or when tampered', async () => {
    const signedLinks = { key: 's'.repeat(40), ttlSeconds: 10 };
    h = await startFeatureGw({ auth, multimodal: { offloadAboveBytes: 100, signedLinks } } as never);
    const cfg = cfgOf({ signedLinks });
    const get = (uri: string) => fetch(`${h!.base}${uri}`, { headers: { authorization: 'Bearer alice-key' } });
    const uri = linkOf(applyMultimodal(img(5000), 'fake', 'cam', cfg, Date.now(), { clientId: 'key:alice' })!);
    expect(uri).toMatch(/\?exp=\d+&sig=/);
    expect((await get(uri)).status).toBe(200);
    expect((await get(uri.replace(/sig=.{4}/, 'sig=AAAA'))).status).toBe(404);
    expect((await get(uri.split('?')[0]!)).status).toBe(404);
    const old = linkOf(applyMultimodal(img(5000), 'fake', 'cam', cfg, Date.now() - 11_000, { clientId: 'key:alice' })!);
    multimodalState.blobs.forEach((b) => (b.expires = Date.now() + 60_000)); // blob still held, link expired
    expect((await get(old)).status).toBe(404);
    expect(() => MultimodalSchema.parse({ signedLinks: { key: 'short' } })).toThrow(/at least 32/);
  });

  it('filesystem storage is shared between instances; ownership still applies', async () => {
    const dir = tmp();
    const storage = { type: 'filesystem', dir };
    h = await startFeatureGw({ auth, multimodal: { offloadAboveBytes: 100, storage } } as never);
    const uri = linkOf(applyMultimodal(img(5000), 'fake', 'cam', cfgOf({ storage }), Date.now(), { clientId: 'key:alice' })!);
    expect(storedFiles()).toBe(1);
    multimodalState.blobs.clear(); // "another instance": nothing in this process's map
    expect((await fetch(`${h.base}${uri}`, { headers: { authorization: 'Bearer alice-key' } })).status).toBe(200);
    expect((await fetch(`${h.base}${uri}`, { headers: { authorization: 'Bearer bob-key' } })).status).toBe(404);
  });
});

describe('multimodal budgets (11.2)', () => {
  it('global and per-tenant byte budgets hold under concurrent offloads (LRU eviction, refuse when too big)', async () => {
    const cfg = cfgOf({ maxStoredBytes: 50_000, maxTenantStoredBytes: 20_000, maxItemBytes: 30_000, maxTotalBytes: 30_000 });
    let maxHeld = 0;
    const perBucket = new Map<string, number>();
    await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        Promise.resolve().then(() => {
          const r = applyMultimodal(img(3_000 + (i % 7) * 500), 'fake', 'cam', cfg, Date.now() + i, { clientId: `key:c${i % 5}`, tenant: `t${i % 4}` })!;
          expect(r.success).toBe(true);
          let held = 0;
          perBucket.clear();
          for (const b of multimodalState.blobs.values()) {
            held += b.size;
            perBucket.set(b.bucket, (perBucket.get(b.bucket) ?? 0) + b.size);
          }
          maxHeld = Math.max(maxHeld, held);
          for (const v of perBucket.values()) expect(v).toBeLessThanOrEqual(20_000);
        }),
      ),
    );
    expect(maxHeld).toBeLessThanOrEqual(50_000);
    expect(multimodalState.stats.evicted).toBeGreaterThan(0);
    expect(multimodalState.stats.heldBytes).toBeLessThanOrEqual(50_000);
    const big = applyMultimodal(img(25_000), 'fake', 'cam', cfg, Date.now(), { clientId: 'key:z' })!;
    expect(big.success).toBe(false);
    expect(big.error!.message).toMatch(/blob budget/);
    const stripped = applyMultimodal(img(25_000), 'fake', 'cam', cfgOf({ maxTenantStoredBytes: 20_000, onViolation: 'strip' }), Date.now(), { clientId: 'key:z' })!;
    expect(JSON.stringify(stripped.result)).toMatch(/does not fit the blob budget/);
    expect(multimodalState.stats.overBudget).toBe(2);
    const d = MultimodalSchema.parse({});
    expect(d.maxStoredBytes).toBe(256 * 1024 * 1024);
    expect(d.maxTenantStoredBytes).toBe(64 * 1024 * 1024);
  });
});

describe('agent-token revocation store (11.2)', () => {
  const agentCfg = { signingKey: KEY, agents: [{ id: 'helper', tools: ['fake/*'], delegators: ['*'] }] };
  const base = (extra: Record<string, unknown>) =>
    ({ port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false, prometheus: true }, servers: [fakeServer('fake')], auth: { strategy: 'api-key', apiKeys: ['op', { key: 'alice-key', name: 'alice' }] }, agentIdentity: agentCfg, ...extra }) as unknown as GatewayConfig;
  const boot = async (cfg: GatewayConfig) => {
    const g = new Gateway(cfg);
    await g.start();
    gws.push(g);
    return { g, url: `http://127.0.0.1:${g.address()!.port}` };
  };
  const post = (url: string, key: string, path: string, body: unknown) =>
    fetch(`${url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: (await r.json()) as any })); // eslint-disable-line @typescript-eslint/no-explicit-any
  const mint = async (url: string) => (await post(url, 'alice-key', '/api/v1/features/agent-identity/token', { agent: 'helper' })).body as { access_token: string; jti: string };
  const call = (url: string, token: string) => post(url, 'alice-key', '/api/v1/features/agent-identity/call', { token, server: 'fake', tool: 'echo' });

  let redis: FakeRedis | undefined;
  afterEach(async () => {
    await redis?.close();
    redis = undefined;
  });

  it('revoked on instance A is rejected on instance B (shared Redis)', async () => {
    redis = await startFakeRedis();
    const shared = { state: { store: 'redis', redis: { url: redis.url } } };
    const a = await boot(base(shared));
    const b = await boot(base(shared));
    const t = await mint(a.url);
    expect((await call(b.url, t.access_token)).status).toBe(200);
    const rv = await post(a.url, 'op', '/api/v1/admin/agent-identity/revoke', { jti: t.jti });
    expect(rv.body).toMatchObject({ revoked: t.jti, known: true, shared: true });
    agentState.reset(); // B shares this process in tests: drop the local cache so B must ask the store
    expect((await call(b.url, t.access_token)).status).toBe(401);
    expect(redis.commands.some((c) => c[0]!.toUpperCase() === 'SET' && c[1]!.includes(`agent-identity:revoked:${t.jti}`) && c.map((x) => x.toUpperCase()).includes('PX'))).toBe(true);
  }, 30_000);

  it('survives a restart (sqlite store)', async () => {
    const path = join(tmp(), 'state.db');
    const durable = { state: { store: 'sqlite', sqlite: { path } } };
    const first = await boot(base(durable));
    const t = await mint(first.url);
    await post(first.url, 'op', '/api/v1/admin/agent-identity/revoke', { jti: t.jti });
    await first.g.stop();
    gws.splice(gws.indexOf(first.g), 1);
    agentState.reset();
    const second = await boot(base(durable));
    expect((await call(second.url, t.access_token)).status).toBe(401);
    const other = await mint(second.url);
    expect((await call(second.url, other.access_token)).status).toBe(200);
  }, 30_000);

  it('fails closed when the store is unreachable (default) and open when configured', async () => {
    const dead = { state: { store: 'redis', redis: { url: 'redis://127.0.0.1:1', connectTimeoutMs: 200, commandTimeoutMs: 200 } } };
    const { url } = await boot(base(dead));
    const t = await mint(url);
    const r = await call(url, t.access_token);
    expect(r.status).toBe(503);
    expect(r.body.message).toMatch(/revocation store unavailable/);
    expect(agentState.stats.deniedStoreUnavailable).toBeGreaterThan(0);
    const m = await (await fetch(`${url}/api/v1/metrics?format=prometheus`, { headers: { authorization: 'Bearer op', accept: 'text/plain' } })).text();
    expect(m).toMatch(/mcp_gateway_agent_revocation_store_errors_total [1-9]/);
    expect(m).toMatch(/mcp_gateway_agent_store_unavailable_total\{decision="deny"\} [1-9]/);
    const open = await boot(base({ ...dead, agentIdentity: { ...agentCfg, revocation: { failureMode: 'open' } } }));
    const t2 = await mint(open.url);
    expect((await call(open.url, t2.access_token)).status).toBe(200);
    expect(agentState.stats.allowedStoreUnavailable).toBeGreaterThan(0);
  }, 30_000);

  it('store helpers: TTL = token expiry; sqlite store basics; config + posture', async () => {
    const s = new MemoryStateStore();
    await revokeToken(s, 'j1', Math.floor(Date.now() / 1000) + 100);
    const ttl = await s.pttl('agent-identity:revoked:j1');
    expect(ttl).toBeGreaterThan(100_000);
    expect(ttl).toBeLessThanOrEqual(161_000);
    agentState.reset();
    expect(await isRevoked(s, 'j1')).toBe(true);
    expect(await isRevoked(s, 'j2')).toBe(false);
    const broken = { kind: 'x', get: () => Promise.reject(new Error('down')) } as never;
    expect(await isRevoked(broken, 'j3')).toBe('unavailable');
    expect(await isRevoked(broken, 'j3', 'open')).toBe(false);
    const sq = new SqliteStateStore(':memory:');
    expect(await sq.incr('a', 1000)).toBe(1);
    expect(await sq.incr('a', 1000, 4)).toBe(5);
    await sq.set('b', 'x', 5);
    await new Promise((r) => setTimeout(r, 10));
    expect(await sq.get('b')).toBeUndefined();
    expect(await sq.pttl('a')).toBeGreaterThan(0);
    await sq.close();
    expect(validateConfig({ version: 10, servers: [], store: { backend: 'sqlite', sqlite: { path: 'x.db' } } }).state?.store).toBe('sqlite');
    expect(() => validateConfig({ version: 10, servers: [], features: { agentIdentity: { signingKey: KEY, revocation: { failureMode: 'maybe' } } } })).toThrow();
    expect(securityWarnings({ servers: [], agentIdentity: agentCfg } as never).some((w) => w.id === 'agent-revocation-in-memory')).toBe(true);
    expect(securityWarnings({ servers: [], agentIdentity: agentCfg, state: { store: 'redis', redis: { url: 'redis://x' } } } as never).some((w) => w.id === 'agent-revocation-in-memory')).toBe(false);
  });
});
