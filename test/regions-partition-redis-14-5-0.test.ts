// 14.5.0: two regions, each a gateway with its OWN real Redis (region-local state), peered through TCP fault proxies
// (toxiproxy-style). Shows the consistency boundaries end to end: rate-limit state stays in its region, revocations
// replicate, and a partition makes both regions fail closed until they can confirm freshness again.
// Skipped when no `redis-server` binary is available (CI job "Multi-instance reliability (real Redis)" installs it).
import { describe, it, expect, afterEach } from 'vitest';
import { Gateway } from '../src/gateway/index.js';
import { ERR_REGION_STALE, ERR_REGION_REVOKED, resetRegionFaults } from '../src/features/regions.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';
import { fakeServer } from './helpers/feature-gw.js';
import { redisServerAvailable, startRealRedis, startFaultProxy, type FaultProxy } from './fixtures/real-redis.js';

logger.setLevel('error');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  resetRegionFaults();
  for (const f of cleanup.reverse()) await Promise.resolve(f()).catch(() => undefined);
  cleanup = [];
});
async function until<T>(f: () => Promise<T> | T, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out; last ${JSON.stringify(v)}`);
    await sleep(50);
  }
}

const H = (key: string) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' });

async function region(redisUrl: string) {
  const cfg = {
    port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false },
    servers: [fakeServer('fake')],
    auth: { strategy: 'api-key', apiKeys: ['op', { key: 'scoped', name: 'scoped', servers: ['fake'], rateLimit: { limit: 2, windowSeconds: 60 } }, { key: 'other', name: 'other', servers: ['fake'] }, { key: 'third', name: 'third', servers: ['fake'] }] },
    state: { store: 'redis', redis: { url: redisUrl, connectTimeoutMs: 500, commandTimeoutMs: 1000, keyPrefix: 'mgw-region:' } },
  } as unknown as GatewayConfig;
  const gw = new Gateway(cfg);
  await gw.start();
  cleanup.push(() => gw.stop());
  const base = `http://127.0.0.1:${gw.address()!.port}`;
  const call = async (key: string) => {
    const res = await fetch(`${base}/api/v1/tools/call`, { method: 'POST', headers: H(key), body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: { q: 'x' } }) });
    return { status: res.status, text: await res.text() };
  };
  const admin = async (p: string, body?: unknown) => {
    const res = await fetch(`${base}/api/v1/admin/regions${p}`, { method: body === undefined ? 'GET' : 'POST', headers: H('op'), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  return { gw, cfg, base, port: gw.address()!.port, call, admin };
}

describe.skipIf(!redisServerAvailable)('14.5.0 regions: partition with two gateways + two Redis', () => {
  it('region-local rate limits, replicated revocation, fail-closed partition and recovery', async () => {
    const r1 = await startRealRedis();
    const r2 = await startRealRedis();
    cleanup.push(() => r1.close(), () => r2.close());
    const A = await region(r1.url);
    const B = await region(r2.url);
    const toB: FaultProxy = await startFaultProxy(B.port); // A → B
    const toA: FaultProxy = await startFaultProxy(A.port); // B → A
    cleanup.push(() => toB.close(), () => toA.close());
    const regions = (self: string, id: string, port: number) => ({ self, syncIntervalMs: 250, downAfter: 2, consistency: { maxStalenessMs: 1500 }, peers: [{ id, url: `http://127.0.0.1:${port}`, apiKey: 'op' }] });
    await A.gw.reload({ ...A.cfg, regions: regions('a', 'b', toB.port) } as GatewayConfig);
    await B.gw.reload({ ...B.cfg, regions: regions('b', 'a', toA.port) } as GatewayConfig);
    await until(async () => [(await A.admin('/health')).status, (await B.admin('/health')).status], (s) => s[0] === 200 && s[1] === 200);

    // region-local boundary: the per-key rate limit is counted in each region's own Redis
    expect((await A.call('scoped')).status).toBe(200);
    expect((await A.call('scoped')).status).toBe(200);
    expect((await A.call('scoped')).status).toBe(429);
    expect((await B.call('scoped')).status).toBe(200);
    expect((await B.call('scoped')).status).toBe(200);
    const rep = await B.admin('/report');
    expect(rep.body.boundaries.regionLocal).toContain('rate-limits');

    // replicated boundary: a revocation in A reaches B within bounded staleness
    await A.admin('/revocations', { clientId: 'key:other', reason: 'compromised' });
    await until(() => B.call('other'), (x) => x.text.includes(String(ERR_REGION_REVOKED)), 1500 + 1500);

    expect((await A.call('third')).status).toBe(200);
    // hard partition (both directions): neither region can confirm freshness → both fail closed
    toB.refuse();
    toA.refuse();
    await until(async () => [(await A.admin('/health')).status, (await B.admin('/health')).status], (s) => s[0] === 503 && s[1] === 503, 6000);
    expect((await B.call('op')).text).toContain(String(ERR_REGION_STALE));
    expect((await A.call('op')).text).toContain(String(ERR_REGION_STALE));
    // a revocation issued during the partition is applied in B once it heals; B never served while unsure
    expect((await A.call('third')).text).toContain(String(ERR_REGION_STALE));
    await B.admin('/revocations', { clientId: 'key:third' });
    toB.heal();
    toA.heal();
    await until(async () => [(await A.admin('/health')).status, (await B.admin('/health')).status], (s) => s[0] === 200 && s[1] === 200, 8000);
    expect((await A.call('third')).text).toContain(String(ERR_REGION_REVOKED));
    expect((await A.call('op')).status).toBe(200);
    const report = await A.admin('/report');
    expect(report.body.revocations).toBe(2);
    expect(report.body.peers[0]).toMatchObject({ id: 'b', status: 'up', fresh: true });
    expect(report.body.store).toMatchObject({ status: 'ok' });

    // a second instance of region A (same Redis) learns the region's revocations through the shared store
    const A2 = await region(r1.url);
    await A2.gw.reload({ ...A2.cfg, regions: { self: 'a', syncIntervalMs: 250, consistency: { maxStalenessMs: 1500 }, peers: [] } } as GatewayConfig);
    await until(() => A2.call('other'), (x) => x.text.includes(String(ERR_REGION_REVOKED)), 3000);
    expect((await A2.call('op')).status).toBe(200);
    // the region store goes away → the instance cannot confirm freshness → fail closed
    await r1.kill();
    await until(() => A2.call('op'), (x) => x.text.includes(String(ERR_REGION_STALE)), 6000);
  }, 60_000);
});
