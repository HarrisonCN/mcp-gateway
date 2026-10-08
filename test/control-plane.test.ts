/** 7.0: control plane / data plane split — config pull (ETag), heartbeats, admin API blocked on data planes. */
import { describe, it, expect, afterEach } from 'vitest';
import { Gateway } from '../src/gateway/index.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { startFeatureGw, fakeServer, op, scoped, type FeatureGw } from './helpers/feature-gw.js';

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s().catch(() => undefined);
});

async function control(extra: Partial<GatewayConfig> = {}): Promise<FeatureGw> {
  const h = await startFeatureGw({ controlPlane: { role: 'control', configApi: true }, ...extra });
  stops.push(h.stop);
  return h;
}

async function dataPlane(url: string, token = 'op', nodeId = 'dp-1') {
  const gw = new Gateway({
    port: 0,
    host: '127.0.0.1',
    logLevel: 'error',
    monitor: { requestLog: false },
    servers: [],
    controlPlane: { role: 'data', url, token, nodeId, pullIntervalMs: 60_000 },
  } as GatewayConfig);
  await gw.start();
  stops.push(() => gw.stop());
  const base = `http://127.0.0.1:${gw.address()!.port}`;
  const get = async (path: string, headers: Record<string, string> = op) => {
    const r = await fetch(base + path, { headers });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  return { gw, base, get };
}

describe('control plane (7.0)', () => {
  it('serves the config with an ETag (304 when unchanged); operators only; role control only', async () => {
    const cp = await control();
    const r = await fetch(`${cp.base}/api/v1/admin/data-planes/config`, { headers: op });
    expect(r.status).toBe(200);
    const etag = r.headers.get('etag')!;
    const body = (await r.json()) as { etag: string; config: Record<string, unknown> };
    expect(body.etag).toBe(etag);
    expect(body.config).toMatchObject({ version: 8, servers: [{ id: 'fake' }] });
    expect(body.config).not.toHaveProperty('controlPlane');
    expect(body.config).not.toHaveProperty('port');
    expect((body.config.auth as { apiKeys: unknown[] }).apiKeys[0]).toBe('op'); // secrets included for data planes
    const again = await fetch(`${cp.base}/api/v1/admin/data-planes/config`, { headers: { ...op, 'if-none-match': etag } });
    expect(again.status).toBe(304);
    expect((await cp.admin('data-planes/config', undefined, 'GET', scoped)).status).toBe(403);
    expect((await cp.admin('data-planes/heartbeat', { nodeId: '' })).status).toBe(400);
    expect((await cp.admin('data-planes/heartbeat', [])).status).toBe(400);
    expect((await cp.admin('data-planes/nope', undefined, 'DELETE')).status).toBe(404);

    const all = await startFeatureGw();
    stops.push(all.stop);
    expect((await all.admin('data-planes/config')).status).toBe(409);
    expect((await all.admin('data-planes/heartbeat', { nodeId: 'x' })).status).toBe(409);
    expect((await all.admin('data-planes')).body).toMatchObject({ role: 'all', dataPlanes: [] });
    expect((await all.admin('features')).status).toBe(200);
  });

  it('a data plane pulls, applies and reports in; picks up control-plane changes', async () => {
    const cp = await control();
    const dp = await dataPlane(cp.base);
    await dp.gw.dataPlane!.sync();
    const st = await dp.get('/api/v1/data-plane');
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ role: 'data', nodeId: 'dp-1', ready: true, applied: 1, controlPlane: cp.base });
    // the pulled config is live: servers + auth came from the control plane
    let tools: any = { status: 0 }; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (let i = 0; i < 50 && !(tools.status === 200 && tools.body.tools?.length); i++) {
      tools = await dp.get('/api/v1/tools');
      if (!(tools.status === 200 && tools.body.tools?.length)) await new Promise((r) => setTimeout(r, 100));
    }
    expect(tools.body.tools.map((t: { name: string }) => t.name)).toContain('echo');
    expect((await dp.get('/api/v1/tools', { authorization: 'Bearer nope' })).status).toBe(401);
    // admin API is on the control plane
    const blocked = await dp.get('/api/v1/admin/config');
    expect(blocked.status).toBe(403);
    expect(blocked.body.controlPlane).toBe(cp.base);
    expect((await dp.get('/api/v1/admin/features')).status).toBe(403);

    const list = await cp.admin('data-planes');
    expect(list.body.role).toBe('control');
    expect(list.body.dataPlanes).toHaveLength(1);
    expect(list.body.dataPlanes[0]).toMatchObject({ nodeId: 'dp-1', inSync: true, status: 'online', configEtag: st.body.configEtag, servers: { total: 1 } });
    expect(list.body.summary).toEqual({ total: 1, online: 1, inSync: 1 });

    // change the control plane's config → the data plane is out of sync until its next pull
    const cur = (await cp.admin('config')).body.config;
    const put = await cp.admin('config', { ...cur, rateLimit: { windowSeconds: 60, limit: 500 } }, 'PUT');
    expect(put.status).toBe(200);
    expect((await cp.admin('data-planes')).body.dataPlanes[0].inSync).toBe(false);
    await dp.gw.dataPlane!.sync();
    expect(dp.gw.dataPlane!.status()).toMatchObject({ applied: 2, pulls: 2 });
    expect((await cp.admin('data-planes')).body.dataPlanes[0].inSync).toBe(true);
    await dp.gw.dataPlane!.sync(); // unchanged → 304, nothing applied
    expect(dp.gw.dataPlane!.status()).toMatchObject({ applied: 2, pulls: 3, failures: 0 });

    expect((await cp.admin('data-planes/dp-1', undefined, 'DELETE')).body).toEqual({ removed: 'dp-1' });
    expect((await cp.admin('data-planes')).body.dataPlanes).toEqual([]);
  });

  it('fails closed until the first config arrives; a bad token keeps it closed', async () => {
    const cp = await control();
    const dp = await dataPlane(cp.base, 'wrong', 'dp-bad');
    await dp.gw.dataPlane!.sync();
    expect((await dp.get('/api/v1/tools')).status).toBe(503);
    expect((await dp.get('/mcp')).status).toBe(503);
    expect((await dp.get('/api/v1/health/live')).status).toBe(200);
    expect((await dp.get('/api/v1/health/ready')).status).toBe(503);
    expect((await dp.get('/api/v1/admin/data-planes')).status).toBe(403);
    const st = await dp.get('/api/v1/data-plane', {});
    expect(st.body).toMatchObject({ ready: false, applied: 0 });
    expect(st.body.failures).toBeGreaterThanOrEqual(1);
    expect(st.body.lastError).toMatch(/HTTP 401/);
    expect((await cp.admin('data-planes')).body.dataPlanes).toEqual([]);

    const down = await dataPlane('http://127.0.0.1:9', 'op', 'dp-down');
    await down.gw.dataPlane!.sync();
    expect(down.gw.dataPlane!.status().ready).toBe(false);
    expect(down.gw.dataPlane!.status().lastError).toBeTruthy();
  });

  it('a gateway that is not a data plane has no /api/v1/data-plane', async () => {
    const h = await startFeatureGw({ servers: [fakeServer('fake')] });
    stops.push(h.stop);
    const r = await fetch(`${h.base}/api/v1/data-plane`, { headers: op });
    expect(r.status).toBe(404);
  });
});
