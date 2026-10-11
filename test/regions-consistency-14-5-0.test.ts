// 14.5.0: multi-region consistency. Explicit eventual-consistency boundaries (what is replicated vs region-local),
// replicated revocations that fail closed during a partition (bounded staleness), version vectors + generation
// fencing for replicated config (kv), clock-skew bounds, region health, replication-lag metrics, `regions report`.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { RegionMesh, resolveRegions, regionFaults, resetRegionFaults, GenerationConflict, ERR_REGION_STALE, ERR_REGION_REVOKED, type ReplicatedEntry } from '../src/features/regions.js';
import { validateConfig } from '../src/config/loader.js';
import { startFeatureGw, fakeServer, type FeatureGw } from './helpers/feature-gw.js';

const require = createRequire(import.meta.url);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mesh = (self: string, peers: Array<{ id: string; url: string }> = [], now?: () => number, consistency: Record<string, unknown> = {}) =>
  new RegionMesh(resolveRegions({ self, peers, downAfter: 2, consistency }), now);

let gws: FeatureGw[] = [];
afterEach(async () => {
  resetRegionFaults();
  for (const g of gws) await g.stop();
  gws = [];
});

describe('14.5.0 RegionMesh consistency (unit)', () => {
  it('error codes are stable', () => {
    expect(ERR_REGION_STALE).toBe(-32027);
    expect(ERR_REGION_REVOKED).toBe(-32028);
  });

  it('bounds clock skew: entries stamped beyond now + maxClockSkewMs are rejected and never advance the clock', () => {
    const t = 1_000_000;
    const a = mesh('a', [], () => t, { maxClockSkewMs: 1000 });
    expect(a.merge([{ key: 'k', value: 1, ts: t + 10_000, region: 'b' }])).toBe(0);
    expect(a.merge([{ key: 'j', value: 1, ts: 1e300, region: 'b' }])).toBe(0);
    expect(a.get('k')).toBeUndefined();
    expect(a.stats().rejected.clockSkew).toBe(2);
    const e = a.put('x', 1);
    expect(e.ts).toBeLessThanOrEqual(t + 1000);
    expect(a.merge([{ key: 'ok', value: 1, ts: t + 500, region: 'b' }])).toBe(1);
    expect(a.get('ok')).toBe(1);
  });

  it('version vectors: causality beats wall clock, concurrent writes converge and are counted as conflicts', () => {
    let t = 1000;
    const a = mesh('a', [], () => t);
    const b = mesh('b', [], () => t);
    a.put('k', 'v1');
    b.merge(a.delta());
    b.put('k', 'v2'); // causally after v1
    const v2 = b.entry('k')!;
    expect(v2.vv).toEqual({ a: 1, b: 1 });
    expect(v2.gen).toBe(2);
    // a delayed / replayed copy of v1 with a later timestamp must not overwrite v2 (14.4: last-writer-wins took it)
    const replay: ReplicatedEntry = { ...a.entry('k')!, ts: v2.ts + 5 };
    expect(b.merge([replay])).toBe(0);
    expect(b.get('k')).toBe('v2');
    expect(b.stats().rejected.stale).toBe(1);
    // concurrent writes on both sides converge to one value with the joined vector
    t = 2000;
    a.put('c', 'from-a');
    b.put('c', 'from-b');
    a.merge(b.delta());
    b.merge(a.delta());
    expect(a.get('c')).toBe(b.get('c'));
    expect(a.entry('c')!.vv).toEqual({ a: 1, b: 1 });
    expect(b.entry('c')!.vv).toEqual(a.entry('c')!.vv);
    expect(a.stats().conflicts + b.stats().conflicts).toBeGreaterThanOrEqual(1);
  });

  it('generation fencing: a write that names a stale generation is refused', () => {
    const a = mesh('a');
    expect(a.put('cfg', { v: 1 }).gen).toBe(1);
    expect(a.put('cfg', { v: 2 }, { ifGeneration: 1 }).gen).toBe(2);
    expect(() => a.put('cfg', { v: 3 }, { ifGeneration: 1 })).toThrow(GenerationConflict);
    expect(() => a.put('new', 1, { ifGeneration: 0 })).not.toThrow();
    expect(() => a.put('new', 1, { ifGeneration: 0 })).toThrow(GenerationConflict);
    expect(a.get('cfg')).toEqual({ v: 2 });
  });

  it('revocations are a grow-only set: union on merge, never undone, earliest time kept', () => {
    let t = 100;
    const a = mesh('a', [], () => t);
    const b = mesh('b', [], () => t);
    a.revoke('key:x', 'leaked');
    t = 200;
    b.revoke('key:y');
    b.revoke('key:x');
    a.mergeRevocations(b.revocationList());
    b.mergeRevocations(a.revocationList());
    for (const m of [a, b]) {
      expect(m.isRevoked('key:x')).toBe(true);
      expect(m.isRevoked('key:y')).toBe(true);
      expect(m.isRevoked('key:z')).toBe(false);
    }
    expect(b.revocationList().find((r) => r.clientId === 'key:x')).toMatchObject({ at: 100, region: 'a', reason: 'leaked' });
    expect(a.mergeRevocations([{ clientId: 'key:x', at: 50, region: 'c' } as never])).toBe(0); // already revoked: no-op except earliest time
    expect(a.mergeRevocations([null as never, { clientId: 7 } as never])).toBe(0);
  });

  it('freshness: a region is fresh only while every peer synced within maxStalenessMs', () => {
    let t = 0;
    const a = mesh('a', [{ id: 'b', url: 'https://b.example' }], () => t, { maxStalenessMs: 10_000 });
    expect(a.freshness()).toMatchObject({ fresh: false, stale: ['b'] });
    a.sawPeer('b', []);
    expect(a.freshness()).toMatchObject({ fresh: true, stale: [], maxLagMs: 0 });
    t = 10_001;
    expect(a.freshness()).toMatchObject({ fresh: false, stale: ['b'] });
    expect(mesh('solo').freshness().fresh).toBe(true);
  });

  it('config: consistency defaults and validation', () => {
    expect(resolveRegions({ self: 'a' }).consistency).toEqual({ maxStalenessMs: 30_000, maxClockSkewMs: 30_000, onStale: 'deny' });
    expect(() => validateConfig({ servers: [], features: { regions: { self: 'a', syncIntervalMs: 5000, consistency: { maxStalenessMs: 6000 } } } })).toThrow(/maxStalenessMs/);
    expect(() => validateConfig({ servers: [], features: { regions: { self: 'a', consistency: { onStale: 'maybe' } } } })).toThrow();
    expect(() => validateConfig({ servers: [], features: { regions: { self: 'a', consistency: { onStale: 'allow', maxStalenessMs: 60_000 } } } })).not.toThrow();
  });
});

// ─── two gateways in one process; partitions and clock skew injected in the sync path ────────────

const AUTH = { strategy: 'api-key', apiKeys: ['op', { key: 'scoped', name: 'scoped', servers: ['fake'] }, { key: 'other', name: 'other', servers: ['fake'] }] };
const H = (key: string) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' });
const callTool = async (g: FeatureGw, key: string) => {
  const res = await fetch(`${g.base}/api/v1/tools/call`, { method: 'POST', headers: H(key), body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: { q: 'hi' } }) });
  return { status: res.status, text: await res.text() };
};
async function until<T>(f: () => Promise<T> | T, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out; last ${JSON.stringify(v)}`);
    await sleep(50);
  }
}
const regionsCfg = (self: string, peer: { id: string; url: string }, consistency: Record<string, unknown> = {}) => ({ self, syncIntervalMs: 250, downAfter: 2, consistency: { maxStalenessMs: 1500, ...consistency }, peers: [{ ...peer, apiKey: 'op' }] });

async function pair(consistency: Record<string, unknown> = {}) {
  const a = await startFeatureGw({ servers: [fakeServer('fake')], auth: AUTH } as never);
  gws.push(a);
  const b = await startFeatureGw({ servers: [fakeServer('fake')], auth: AUTH, monitor: { requestLog: false, prometheus: true }, regions: regionsCfg('b', { id: 'a', url: a.base }, consistency) } as never);
  gws.push(b);
  await a.gw.reload({ ...(a.gw as any).config, regions: regionsCfg('a', { id: 'b', url: b.base }, consistency) }); // eslint-disable-line @typescript-eslint/no-explicit-any
  await until(async () => [(await a.admin('regions/health')).status, (await b.admin('regions/health')).status], (s) => s[0] === 200 && s[1] === 200);
  return { a, b };
}

describe('14.5.0 two regions (in-process)', () => {
  it('a key revoked in region A is refused in region B within bounded staleness', async () => {
    const { a, b } = await pair();
    expect((await callTool(b, 'scoped')).status).toBe(200);
    const r = await a.admin('regions/revocations', { clientId: 'key:scoped', reason: 'leaked' });
    expect(r.status).toBe(200);
    const t0 = Date.now();
    const refused = await until(() => callTool(b, 'scoped'), (x) => x.text.includes(String(ERR_REGION_REVOKED)), 3000);
    expect(Date.now() - t0).toBeLessThan(1500 + 1000);
    expect(refused.text).toContain('revoked');
    expect((await callTool(a, 'scoped')).text).toContain(String(ERR_REGION_REVOKED));
    expect((await callTool(b, 'op')).status).toBe(200);
    const list = await b.admin('regions/revocations');
    expect(list.body.revocations).toEqual([expect.objectContaining({ clientId: 'key:scoped', region: 'a', reason: 'leaked' })]);
    expect((await a.admin('regions/revocations', { reason: 'x' })).status).toBe(400);
  });

  it('partition: B cannot confirm freshness → fails closed (tool calls refused, health 503); heals and enforces the revocation', async () => {
    const { a, b } = await pair();
    regionFaults.partitioned.add('a|b');
    await a.admin('regions/revocations', { clientId: 'key:other' });
    await until(() => b.admin('regions/health'), (h) => h.status === 503, 4000);
    for (const k of ['other', 'scoped', 'op']) {
      const r = await callTool(b, k);
      expect(r.text).toContain(String(ERR_REGION_STALE));
    }
    const rep = await b.admin('regions/report');
    expect(rep.status).toBe(200);
    expect(rep.body.fresh).toBe(false);
    expect(rep.body.peers[0]).toMatchObject({ id: 'a', fresh: false });
    // opt-out: onStale allow keeps serving (14.4 behaviour) but still enforces revocations it knows about
    await b.gw.reload({ ...(b.gw as any).config, regions: regionsCfg('b', { id: 'a', url: a.base }, { onStale: 'allow' }) }); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await callTool(b, 'op')).status).toBe(200);
    await b.gw.reload({ ...(b.gw as any).config, regions: regionsCfg('b', { id: 'a', url: a.base }) }); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await callTool(b, 'op')).text).toContain(String(ERR_REGION_STALE));
    regionFaults.partitioned.clear();
    await until(() => b.admin('regions/health'), (h) => h.status === 200, 4000);
    expect((await callTool(b, 'other')).text).toContain(String(ERR_REGION_REVOKED));
    expect((await callTool(b, 'scoped')).status).toBe(200);
  });

  it('kv: version vectors replicate, ifGeneration fences stale writers (409)', async () => {
    const { a, b } = await pair();
    const w = await a.admin('regions/kv/cfg', { value: { v: 1 } }, 'PUT');
    expect(w.body).toMatchObject({ gen: 1, vv: { a: 1 } });
    const got = await until(() => b.admin('regions/kv/cfg'), (x) => x.status === 200);
    expect(got.body).toMatchObject({ value: { v: 1 }, gen: 1 });
    expect((await b.admin('regions/kv/cfg', { value: { v: 2 }, ifGeneration: 1 }, 'PUT')).body).toMatchObject({ gen: 2, vv: { a: 1, b: 1 } });
    const stale = await b.admin('regions/kv/cfg', { value: { v: 3 }, ifGeneration: 1 }, 'PUT');
    expect(stale.status).toBe(409);
    expect(stale.body.currentGeneration).toBe(2);
    expect((await b.admin('regions/kv/cfg', { value: 1, ifGeneration: 'x' }, 'PUT')).status).toBe(400);
  });

  it('clock skew: a peer clock beyond maxClockSkewMs is flagged and its kv writes rejected; revocations still replicate', async () => {
    regionFaults.clockSkewMs.b = 600_000;
    const { a, b } = await pair({ maxClockSkewMs: 5000 });
    await b.admin('regions/kv/skewed', { value: 1 }, 'PUT');
    await b.admin('regions/revocations', { clientId: 'key:other' });
    await until(() => callTool(a, 'other'), (x) => x.text.includes(String(ERR_REGION_REVOKED)), 3000);
    const rep = await until(() => a.admin('regions/report'), (r) => r.body.rejected?.clockSkew >= 1, 3000);
    expect(rep.body.peers[0].clockSkew).toBe('exceeded');
    expect(Math.abs(rep.body.peers[0].skewMs - 600_000)).toBeLessThan(5000);
    expect((await a.admin('regions/kv/skewed')).status).toBe(404);
  });

  it('report, health, metrics and the `regions report` CLI', async () => {
    const { a, b } = await pair();
    const rep = await b.admin('regions/report');
    expect(rep.body).toMatchObject({ self: 'b', fresh: true, onStale: 'deny', maxStalenessMs: 1500 });
    expect(rep.body.boundaries.replicated).toEqual(expect.arrayContaining(['revocations', 'kv', 'server-availability']));
    expect(rep.body.boundaries.regionLocal).toEqual(expect.arrayContaining(['sessions', 'rate-limits', 'quotas', 'policy', 'config', 'portal-keys']));
    expect(rep.body.peers[0]).toMatchObject({ id: 'a', status: 'up', fresh: true });
    expect(typeof rep.body.peers[0].lagMs).toBe('number');
    expect((await b.admin('regions/health')).body).toMatchObject({ region: 'b', fresh: true });
    const m = await (await fetch(`${b.base}/metrics`, { headers: H('op') })).text();
    expect(m).toMatch(/mcp_gateway_region_replication_lag_seconds\{peer="a"\} [0-9.]+/);
    expect(m).toContain('mcp_gateway_region_fresh 1');
    expect(m).toMatch(/mcp_gateway_region_peer_up\{peer="a"\} 1/);
    expect(m).toContain('mcp_gateway_region_denied_total');
    const TSX = join(require.resolve('tsx/package.json'), '..', 'dist', 'cli.mjs');
    const CLI = resolve(__dirname, '..', 'src', 'cli.ts');
    const cli = (args: string[]) => new Promise<{ code: number | null; out: string }>((res) => {
      const p = spawn(process.execPath, [TSX, CLI, ...args, '--url', a.base, '--key', 'op'], { env: { ...process.env, MCP_GATEWAY_PORT: '', MCP_GATEWAY_API_KEYS: '' } });
      let out = '';
      p.stdout.on('data', (c) => (out += c));
      p.on('close', (code) => res({ code, out }));
    });
    const j = await cli(['regions', 'report', '--json']);
    expect(j.code).toBe(0);
    expect(JSON.parse(j.out)).toMatchObject({ self: 'a', fresh: true });
    const human = await cli(['regions', 'report']);
    expect(human.code).toBe(0);
    expect(human.out).toContain('region a');
    expect(human.out).toMatch(/b\s+up/);
  }, 30_000);

  it('portal key revocations are recorded as replicated revocations', async () => {
    const g = await startFeatureGw({ servers: [fakeServer('fake')], auth: { strategy: 'api-key', apiKeys: ['op'] }, portal: { enabled: true, signup: 'open' }, regions: { self: 'solo', peers: [] } } as never);
    gws.push(g);
    const s = await fetch(`${g.base}/api/v1/portal/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'dev', email: 'dev@example.com' }) });
    const sb = (await s.json()) as { id?: string; record?: { id: string } };
    const id = sb.id ?? sb.record!.id;
    const rv = await fetch(`${g.base}/api/v1/portal/keys/${id}/revoke`, { method: 'POST', headers: H('op'), body: '{}' });
    expect(rv.status).toBe(200);
    const list = await g.admin('regions/revocations');
    expect(list.body.revocations.map((r: { clientId: string }) => r.clientId)).toContain(`key:portal-${id}`);
  });
});
