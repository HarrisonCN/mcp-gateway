import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { EdgeFleetSchema, fleetView, selectNodes, pushToNodes } from '../src/features/edge-fleet.js';
import type { EdgeNode } from '../src/gateway/edge-control.js';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';

const node = (edgeId: string, etag?: string, ageMs = 0): EdgeNode => ({ edgeId, firstSeen: new Date().toISOString(), lastSeen: new Date(Date.now() - ageMs).toISOString(), snapshotEtag: etag, events: 1, errors: 0, queuedCalls: 2, replayed: 0 });

let h: FeatureGw | undefined;
let srv: Server | undefined;
afterEach(async () => {
  await h?.stop();
  srv?.close();
  h = undefined;
  srv = undefined;
});

describe('managed edge fleet (5.3)', () => {
  const cfg = EdgeFleetSchema.parse({ nodes: [
    { id: 'a', url: 'https://a.example', labels: { ring: 'canary' } },
    { id: 'b', url: 'https://b.example', labels: { ring: 'stable' } },
    { id: 'c', url: 'https://c.example' },
    { id: 'd', url: 'https://d.example' },
  ] });

  it('classifies drift', () => {
    const v = fleetView(cfg, [node('a', 'e1'), node('b', 'old'), node('d', 'e1', 3_600_000), node('x', 'e1'), node('y')], ['e1']);
    expect(Object.fromEntries(v.map((n) => [n.id, n.drift]))).toEqual({ a: 'in-sync', b: 'stale', c: 'never-synced', d: 'offline', x: 'unmanaged', y: 'unmanaged' });
    expect(v.find((n) => n.id === 'x')!.managed).toBe(false);
  });

  it('selects push targets by id, label and drift', () => {
    const v = fleetView(cfg, [node('a', 'e1'), node('b', 'old')], ['e1']);
    expect(selectNodes(cfg, v, { labels: { ring: 'canary' } }).map((n) => n.id)).toEqual(['a']);
    expect(selectNodes(cfg, v, { nodes: ['a', 'b'], onlyDrifted: true }).map((n) => n.id)).toEqual(['b']);
    expect(selectNodes(cfg, v, {}).length).toBe(4);
  });

  it('pushes and reports per-node failures', async () => {
    const f = (async (url: string, init: RequestInit) => {
      if (url.startsWith('https://a')) {
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer k');
        return new Response(JSON.stringify({ config: 'updated' }), { headers: { 'content-type': 'application/json' } });
      }
      if (url.startsWith('https://b')) return new Response(JSON.stringify({ message: 'sync is not configured' }), { status: 404 });
      if (url.startsWith('https://c')) return new Response('not json', { status: 500 });
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const nodes = EdgeFleetSchema.parse({ nodes: [{ id: 'a', url: 'https://a.example/', apiKey: 'k' }, { id: 'b', url: 'https://b.example' }, { id: 'c', url: 'https://c.example' }, { id: 'd', url: 'https://d.example' }] }).nodes;
    const r = await pushToNodes(nodes, 1000, f);
    expect(r.map((x) => [x.id, x.ok, x.config ?? x.error])).toEqual([['a', true, 'updated'], ['b', false, 'sync is not configured'], ['c', false, 'HTTP 500'], ['d', false, 'ECONNREFUSED']]);
  });

  it('serves the fleet view and pushes to a live edge', async () => {
    let pushes = 0;
    const edge = express();
    edge.post('/api/v1/edge/sync', (_q, s) => { pushes++; s.json({ config: 'unchanged' }); });
    srv = edge.listen(0, '127.0.0.1');
    await new Promise((r) => srv!.once('listening', r));
    const edgeUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    h = await startFeatureGw({ edgeFleet: { nodes: [{ id: 'e1', url: edgeUrl, labels: { ring: 'canary' } }, { id: 'e2', url: 'http://127.0.0.1:1', labels: { ring: 'stable' } }] } } as never);
    // e1 pulls a snapshot → in-sync
    const snap = await fetch(`${h.base}/api/v1/admin/edge/snapshot`, { headers: { authorization: 'Bearer op', 'x-edge-id': 'e1' } });
    expect(snap.status).toBe(200);
    const view = await h.admin('edge-fleet');
    expect(view.body.counts).toEqual({ 'in-sync': 1, 'never-synced': 1 });
    expect(view.body.etag).toMatch(/^[0-9a-f]{32}$/);
    const p = await h.admin('edge-fleet/push', { labels: { ring: 'canary' } });
    expect(p.body).toMatchObject({ pushed: 1, failed: 0 });
    expect(pushes).toBe(1);
    const all = await h.admin('edge-fleet/push', { onlyDrifted: true });
    expect(all.body).toMatchObject({ pushed: 0, failed: 1 });
    expect((await h.admin('edge-fleet/push', { nodes: 'x' })).status).toBe(400);
    expect((await h.admin('edge-fleet/push', { labels: [1] })).status).toBe(400);
    expect((await h.admin('edge-fleet/push', [])).status).toBe(400);
  });

  it('404s a push without managed nodes', async () => {
    h = await startFeatureGw({ kernel: { modules: 'eager' } } as never); // 11.0: eager, so the unconfigured module is mounted
    expect((await h.admin('edge-fleet')).body.nodes).toEqual([]);
    expect((await h.admin('edge-fleet/push', {})).status).toBe(404);
  });
});
