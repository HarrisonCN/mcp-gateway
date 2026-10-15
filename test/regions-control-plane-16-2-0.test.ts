// 16.2.0-canary.0: multi-region control plane 2.0 — cross-region rollups (costs + call lineage summary per region,
// carried in the sync exchange), region-qualified lineage ids that are unique across regions (`<region>:<requestId>`,
// resolvable from any region), and a revocation propagation SLO (latency of a revocation from the region that issued
// it to this one; breaches counted, on the operations timeline and in metrics).
import { describe, it, expect, afterEach } from 'vitest';
import { RegionMesh, resolveRegions, regionFaults, resetRegionFaults, mergeRollups, type RegionRollup } from '../src/features/regions.js';
import { validateConfig } from '../src/config/loader.js';
import { startFeatureGw, fakeServer, type FeatureGw } from './helpers/feature-gw.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const AUTH = { strategy: 'api-key', apiKeys: ['op', { key: 'scoped', servers: ['fake'] }] };
const H = (k: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json', ...extra });
const mesh = (self: string, peers: Array<{ id: string; url: string }> = [], now?: () => number, consistency: Record<string, unknown> = {}) =>
  new RegionMesh(resolveRegions({ self, peers, downAfter: 2, consistency }), now);

let gws: FeatureGw[] = [];
afterEach(async () => {
  resetRegionFaults();
  for (const g of gws) await g.stop();
  gws = [];
});

async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out; last ${JSON.stringify(v)}`);
    await sleep(50);
  }
}

describe('16.2.0 revocation propagation SLO (unit)', () => {
  it('measures the latency of a revocation issued elsewhere (skew-corrected) and counts breaches of revocationSloMs', () => {
    let t = 1_000_000;
    const b = mesh('b', [{ id: 'a', url: 'http://a' }, { id: 'c', url: 'http://c' }], () => t, { revocationSloMs: 2000, maxStalenessMs: 30_000 });
    // a's clock runs 500 ms ahead of b's: a revocation stamped at a-time t+500 happened at b-time t
    b.sawPeer('a', [], 0, { now: t + 500 });
    t += 1200;
    expect(b.mergeRevocations([{ clientId: 'key:x', at: 1_000_500, region: 'a' }])).toBe(1);
    t += 3000;
    expect(b.mergeRevocations([{ clientId: 'key:y', at: 1_001_200, region: 'c' }])).toBe(1); // c: no skew known → 3000 ms
    // already known, from this region (instance siblings via the region store) or re-delivered: not sampled
    b.mergeRevocations([{ clientId: 'key:x', at: 1_000_400, region: 'a' }]);
    b.mergeRevocations([{ clientId: 'key:z', at: t - 10, region: 'b' }]);
    const p = b.revocationPropagation();
    expect(p.sloMs).toBe(2000);
    expect(p.samples).toBe(2);
    expect(p.breaches).toBe(1);
    expect(p.maxMs).toBe(3000);
    expect(p.recent.map((r) => [r.clientId, r.from, r.latencyMs, r.breached])).toEqual([
      ['key:y', 'c', 3000, true],
      ['key:x', 'a', 1200, false],
    ]);
    expect(p.p50Ms).toBeGreaterThanOrEqual(1200);
    expect(p.p99Ms).toBe(3000);
    expect(b.report().revocationPropagation).toMatchObject({ sloMs: 2000, samples: 2, breaches: 1 });
    const prom = b.prometheus().join('\n');
    expect(prom).toContain('mcp_gateway_region_revocation_slo_breaches_total 1');
    expect(prom).toMatch(/mcp_gateway_region_revocation_propagation_seconds\{quantile="0.99"\} 3\.000/);
    expect(prom).toContain('mcp_gateway_region_revocation_slo_seconds 2.000');
  });

  it('latency is never negative (clock noise) and the SLO defaults to maxStalenessMs', () => {
    const t = 5_000_000;
    const b = mesh('b', [{ id: 'a', url: 'http://a' }], () => t, { maxStalenessMs: 12_000 });
    b.mergeRevocations([{ clientId: 'key:early', at: t + 400, region: 'a' }]);
    const p = b.revocationPropagation();
    expect(p.sloMs).toBe(12_000);
    expect(p.recent[0]!.latencyMs).toBe(0);
  });

  it('config: revocationSloMs is optional, an integer ≥ 100', () => {
    const cfg = (consistency: Record<string, unknown>) => ({ servers: [], features: { regions: { self: 'a', consistency } } });
    expect(() => validateConfig(cfg({ revocationSloMs: 5000 }))).not.toThrow();
    expect(() => validateConfig(cfg({ revocationSloMs: 50 }))).toThrow(/revocationSloMs/);
    expect(() => validateConfig(cfg({ revocationSloMs: 1.5 }))).toThrow(/revocationSloMs/);
    expect(resolveRegions({ self: 'a', consistency: { revocationSloMs: 700 } }).consistency.revocationSloMs).toBe(700);
    expect(resolveRegions({ self: 'a' }).consistency.revocationSloMs).toBeUndefined();
  });
});

describe('16.2.0 rollups (unit)', () => {
  const ru = (region: string, cost: number, calls: number, lineage: Partial<RegionRollup['lineage']> = {}): RegionRollup => ({
    region,
    asOf: '2026-10-14T00:00:00.000Z',
    costs: { currency: 'USD', since: '2026-10-14T00:00:00.000Z', total: { cost, calls, inputTokens: 0, outputTokens: 0 }, byTenant: [{ key: 't1', cost, calls, inputTokens: 0, outputTokens: 0 }] },
    lineage: { kept: calls, ok: calls, denied: 0, error: 0, ...lineage },
  });

  it('mergeRollups sums every region, keeps one row per region and marks the result incomplete when a region is missing or stale', () => {
    const m = mergeRollups(ru('a', 0.25, 2), [
      { id: 'b', rollup: ru('b', 0.5, 3, { denied: 1, kept: 4 }), fresh: true, lagMs: 10 },
      { id: 'c', fresh: false, lagMs: null },
    ]);
    expect(m.regions.map((r) => [r.region, r.status])).toEqual([
      ['a', 'self'],
      ['b', 'fresh'],
      ['c', 'missing'],
    ]);
    expect(m.total.costs).toEqual({ cost: 0.75, calls: 5, inputTokens: 0, outputTokens: 0 });
    expect(m.total.byTenant).toEqual([{ key: 't1', cost: 0.75, calls: 5, inputTokens: 0, outputTokens: 0 }]);
    expect(m.total.lineage).toEqual({ kept: 6, ok: 5, denied: 1, error: 0 });
    expect(m.complete).toBe(false);
    expect(mergeRollups(ru('a', 1, 1), [{ id: 'b', rollup: ru('b', 1, 1), fresh: true, lagMs: 0 }]).complete).toBe(true);
    expect(mergeRollups(ru('a', 1, 1), [{ id: 'b', rollup: ru('b', 1, 1), fresh: false, lagMs: 99_999 }]).regions[1]!.status).toBe('stale');
  });

  it('a peer rollup is taken from the sync exchange and only from a configured peer', () => {
    const a = mesh('a', [{ id: 'b', url: 'http://b' }]);
    a.sawPeer('b', [], 0, { rollup: ru('b', 2, 2) });
    a.sawPeer('zz', [], 0, { rollup: ru('zz', 9, 9) });
    expect(a.peerRollups().map((p) => [p.id, p.rollup?.costs.total.cost])).toEqual([['b', 2]]);
    // a rollup that claims another region, or is malformed, is ignored
    a.sawPeer('b', [], 0, { rollup: { ...ru('c', 5, 5) } });
    a.sawPeer('b', [], 0, { rollup: { region: 'b', costs: 'x' } });
    expect(a.peerRollups()[0]!.rollup?.costs.total.cost).toBe(2);
  });
});

const regionsCfg = (self: string, peer: { id: string; url: string }, consistency: Record<string, unknown> = {}) => ({ self, syncIntervalMs: 250, downAfter: 2, consistency: { maxStalenessMs: 1500, ...consistency }, peers: [{ ...peer, apiKey: 'op' }] });
const COSTS = { currency: 'USD', tools: [{ match: 'fake/echo', perCall: 0.25 }] };

async function pair(consistency: Record<string, unknown> = {}) {
  const a = await startFeatureGw({ servers: [fakeServer('fake')], auth: AUTH, costs: COSTS, monitor: { requestLog: false, prometheus: true } } as never);
  gws.push(a);
  const b = await startFeatureGw({ servers: [fakeServer('fake')], auth: AUTH, costs: COSTS, monitor: { requestLog: false, prometheus: true }, regions: regionsCfg('b', { id: 'a', url: a.base }, consistency) } as never);
  gws.push(b);
  await a.gw.reload({ ...(a.gw as any).config, regions: regionsCfg('a', { id: 'b', url: b.base }, consistency) }); // eslint-disable-line @typescript-eslint/no-explicit-any
  await until(async () => [(await a.admin('regions/health')).status, (await b.admin('regions/health')).status], (s) => s[0] === 200 && s[1] === 200);
  return { a, b };
}
const callEcho = (g: FeatureGw, key = 'op', requestId?: string) =>
  fetch(`${g.base}/api/v1/tools/call`, { method: 'POST', headers: H(key, requestId ? { 'x-request-id': requestId } : {}), body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: { q: 'hi' } }) }).then(async (r) => ({ status: r.status, text: await r.text() }));

describe('16.2.0 two regions (in-process)', () => {
  it('GET /admin/regions/rollup: costs and lineage of every region, summed, with per-region freshness', async () => {
    const { a, b } = await pair();
    for (let i = 0; i < 2; i++) expect((await callEcho(a)).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await callEcho(b)).status).toBe(200);
    const r = await until(() => a.admin('regions/rollup'), (x) => x.body?.regions?.find((y: any) => y.region === 'b')?.costs?.total?.calls === 3, 4000); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(r.status).toBe(200);
    expect(r.body.self).toBe('a');
    expect(r.body.complete).toBe(true);
    expect(r.body.regions.map((x: any) => [x.region, x.status])).toEqual([['a', 'self'], ['b', 'fresh']]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(r.body.total.costs).toMatchObject({ cost: 1.25, calls: 5 });
    expect(r.body.total.lineage.ok).toBeGreaterThanOrEqual(5);
    expect(r.body.currency).toBe('USD');
    // the console cluster source carries the same per-region view
    const cl = await a.admin('ops/cluster');
    expect(cl.status).toBe(200);
    expect(JSON.stringify(cl.body)).toContain('"rollup"');
    // regions not configured → 404 as for every regions route
    const solo = await startFeatureGw({ servers: [fakeServer('fake')], auth: AUTH } as never);
    gws.push(solo);
    expect((await solo.admin('regions/rollup')).status).toBe(404);
  }, 30_000);

  it('lineage ids are region-qualified and unique across regions, and resolvable from any region', async () => {
    const { a, b } = await pair();
    // the same client correlation id in both regions (X-Request-Id): two calls, two region-qualified ids
    const ca = await callEcho(a, 'op', 'dup-1');
    const cb = await callEcho(b, 'scoped', 'dup-1');
    expect(ca.status).toBe(200);
    expect(cb.status).toBe(200);
    const ra = JSON.parse(ca.text).requestId as string;
    const rb = JSON.parse(cb.text).requestId as string;
    const la = await a.admin(`ops/lineage/${encodeURIComponent(ra)}`);
    const lb = await b.admin(`ops/lineage/${encodeURIComponent(rb)}`);
    expect(la.body).toMatchObject({ requestId: ra, correlationId: 'dup-1', region: 'a', globalId: `a:${ra}` });
    expect(lb.body).toMatchObject({ requestId: rb, correlationId: 'dup-1', region: 'b', globalId: `b:${rb}` });
    expect(la.body.globalId).not.toBe(lb.body.globalId);
    const byCorr = await a.admin('ops/lineage?correlationId=dup-1');
    expect(byCorr.body.lineage.map((l: any) => l.globalId)).toEqual([`a:${ra}`]); // eslint-disable-line @typescript-eslint/no-explicit-any
    // from region a: its own record and region b's (fetched from the peer), each with its identity
    const own = await a.admin(`regions/lineage/${encodeURIComponent(`a:${ra}`)}`);
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ region: 'a', globalId: `a:${ra}`, identity: la.body.identity });
    const remote = await a.admin(`regions/lineage/${encodeURIComponent(`b:${rb}`)}`);
    expect(remote.status).toBe(200);
    expect(remote.body).toMatchObject({ region: 'b', globalId: `b:${rb}`, correlationId: 'dup-1', identity: lb.body.identity });
    expect(remote.body.identity.subject).not.toBe(own.body.identity.subject);
    // a request id of region b looked up as region a's is not found: the region is part of the identity
    expect((await a.admin(`regions/lineage/${encodeURIComponent(`a:${rb}`)}`)).status).toBe(404);
    expect((await a.admin('regions/lineage/b:nope')).status).toBe(404);
    expect((await a.admin(`regions/lineage/zz:${ra}`)).status).toBe(404);
    expect((await a.admin('regions/lineage/no-region-part')).status).toBe(400);
    // a gateway without regions keeps the 15.1 lineage shape (no region / globalId)
    const solo = await startFeatureGw({ servers: [fakeServer('fake')], auth: AUTH } as never);
    gws.push(solo);
    const cs = await callEcho(solo, 'op', 'solo-1');
    const ls = await solo.admin(`ops/lineage/${encodeURIComponent(JSON.parse(cs.text).requestId)}`);
    expect(ls.status).toBe(200);
    expect(ls.body.region).toBeUndefined();
    expect(ls.body.globalId).toBeUndefined();
  }, 30_000);

  it('revocation propagation beyond the SLO is a breach: report, metrics and the operations timeline', async () => {
    const { a, b } = await pair({ revocationSloMs: 300 });
    regionFaults.partitioned.add('a|b');
    await a.admin('regions/revocations', { clientId: 'key:late', reason: 'test' });
    await sleep(900);
    regionFaults.partitioned.clear();
    const rep = await until(() => b.admin('regions/report'), (x) => x.body?.revocationPropagation?.samples >= 1, 5000);
    expect(rep.body.revocationPropagation).toMatchObject({ sloMs: 300, breaches: 1 });
    expect(rep.body.revocationPropagation.recent[0]).toMatchObject({ clientId: 'key:late', from: 'a', breached: true });
    expect(rep.body.revocationPropagation.recent[0].latencyMs).toBeGreaterThanOrEqual(800);
    const m = await (await fetch(`${b.base}/metrics`, { headers: H('op') })).text();
    expect(m).toContain('mcp_gateway_region_revocation_slo_breaches_total 1');
    const tl = await b.admin('ops/timeline');
    expect(JSON.stringify(tl.body)).toContain('revocation-slo');
  }, 30_000);
});
