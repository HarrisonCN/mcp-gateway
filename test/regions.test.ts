import { describe, it, expect, afterEach } from 'vitest';
import { RegionMesh, resolveRegions, newer, type ReplicatedEntry } from '../src/features/regions.js';
import { validateConfig } from '../src/config/loader.js';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';

const mesh = (self: string, peers: Array<{ id: string; url: string }> = [], now?: () => number) =>
  new RegionMesh(resolveRegions({ self, peers, downAfter: 2 }), now);

let gws: FeatureGw[] = [];
afterEach(async () => {
  for (const g of gws) await g.stop();
  gws = [];
});

describe('multi-region mesh (5.2)', () => {
  it('last-writer-wins with region tie-break, tombstones and deltas', () => {
    let t = 1000;
    const a = mesh('a', [], () => t);
    const b = mesh('b', [], () => t);
    a.put('k', 1);
    b.put('k', 2); // same ts → "b" wins
    expect(a.merge(b.delta())).toBe(1);
    expect(b.merge(a.delta())).toBe(0);
    expect(a.get('k')).toBe(2);
    t = 2000;
    a.delete('k');
    b.merge(a.delta(1000));
    expect(b.get('k')).toBeUndefined();
    expect(b.size()).toBe(0);
    expect(a.delete('missing')).toBe(false);
    expect(newer({ key: 'x', value: 1, ts: 1, region: 'a' }, undefined)).toBe(true);
    expect(a.merge([null as unknown as ReplicatedEntry, { key: 1 } as unknown as ReplicatedEntry])).toBe(0);
  });

  it('clock stays monotonic when wall time goes backwards', () => {
    let t = 5000;
    const a = mesh('a', [], () => t);
    const e1 = a.put('x', 1);
    t = 10;
    expect(a.put('x', 2).ts).toBeGreaterThan(e1.ts);
  });

  it('tracks peer health and routes to a peer that has the server', async () => {
    const a = mesh('a', [{ id: 'b', url: 'https://b.example' }, { id: 'c', url: 'https://c.example' }]);
    expect(a.route('s1', ['s1'])).toEqual({ target: 'local' });
    expect(a.route('s1', [])).toEqual({ target: 'none' });
    let fail = false;
    const f = (async (url: string) => {
      if (fail || url.startsWith('https://c')) throw new Error('down');
      return new Response(JSON.stringify({ entries: [{ key: 'r', value: 'v', ts: 99, region: 'b' }], servers: ['s1'] }), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    await a.syncOnce([], f);
    expect(a.get('r')).toBe('v');
    expect(a.route('s1', [])).toMatchObject({ target: 'peer', peer: 'b' });
    await a.syncOnce([], f);
    const c = a.peerList().find((p) => p.id === 'c')!;
    expect(c).toMatchObject({ status: 'down', failures: 2, lastError: 'down' });
    fail = true;
    await a.syncOnce([], f);
    await a.syncOnce([], f);
    expect(a.route('s1', [])).toEqual({ target: 'none' });
    a.configure(resolveRegions({ self: 'a', peers: [{ id: 'b', url: 'https://b2.example' }] }));
    expect(a.peerList().map((p) => p.url)).toEqual(['https://b2.example']);
    a.sawPeer('zz', []);
    a.peerFailed('zz', 'x');
    a.start(() => []); a.stop();
  });

  it('non-2xx sync responses count as failures', async () => {
    const a = mesh('a', [{ id: 'b', url: 'https://b.example' }]);
    await a.syncOnce([], (async () => new Response('no', { status: 500 })) as unknown as typeof fetch);
    expect(a.peerList()[0]!.lastError).toBe('HTTP 500');
  });

  it('validates the regions config section', () => {
    expect(() => validateConfig({ servers: [], features: { regions: { self: 'Bad Region' } } })).toThrow();
    const c = validateConfig({ servers: [], features: { regions: { self: 'eu', peers: [{ id: 'us', url: 'https://us.example' }] } } });
    expect(resolveRegions(c.regions)).toMatchObject({ syncIntervalMs: 5000, peers: [{ priority: 100 }] });
  });

  it('two gateways replicate state over the admin API', async () => {
    const a = await startFeatureGw();
    gws.push(a);
    const b = await startFeatureGw({ regions: { self: 'b', syncIntervalMs: 250, peers: [{ id: 'a', url: a.base, apiKey: 'op' }] } } as never);
    gws.push(b);
    // a learns about b via hot reload
    await a.gw.reload({ ...(a.gw as any).config, regions: { self: 'a', syncIntervalMs: 250, peers: [{ id: 'b', url: b.base, apiKey: 'op' }] } });
    expect((await a.admin('regions/kv/flag', { value: { on: true } }, 'PUT')).status).toBe(200);
    const deadline = Date.now() + 5000;
    let got: any;
    while (Date.now() < deadline) {
      got = await b.admin('regions/kv/flag');
      if (got.status === 200) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(got.body.value).toEqual({ on: true });
    const st = await b.admin('regions');
    expect(st.body.peers[0]).toMatchObject({ id: 'a', status: 'up' });
    expect((await b.admin('regions/route/fake')).body.target).toMatch(/local|peer/);
    expect((await b.admin('regions/kv/flag', undefined, 'DELETE')).body.deleted).toBe(true);
    expect((await b.admin('regions/kv/flag')).status).toBe(404);
    expect((await b.admin('regions/kv/x', { value: null }, 'PUT')).status).toBe(400);
    expect((await b.admin('regions/sync', { region: 'nope' })).status).toBe(403);
    expect((await b.admin('regions/sync', { nope: 1 })).status).toBe(400);
    expect((await b.admin('regions/sync', [1])).status).toBe(400);
  });

  it('404s when regions are not configured', async () => {
    const g = await startFeatureGw();
    gws.push(g);
    expect((await g.admin('regions')).status).toBe(404);
    expect((await g.admin('regions/kv/a')).status).toBe(404);
    expect((await g.admin('regions/route/a')).status).toBe(404);
    expect((await g.admin('regions/kv/a', undefined, 'DELETE')).status).toBe(404);
    expect((await g.admin('regions/kv/a', { value: 1 }, 'PUT')).status).toBe(404);
    expect((await g.admin('regions/sync', {})).status).toBe(404);
  });
});
