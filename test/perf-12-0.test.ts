/** 12.0: concurrent tool-call load, multimodal memory pressure, transactional hot reload (rollback). */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { startFeatureGw, fakeServer, type FeatureGw } from './helpers/feature-gw.js';
import { applyMultimodal, multimodalState } from '../src/features/multimodal.js';
import type { GatewayConfig, ProxyResponse } from '../src/utils/types.js';

let h: FeatureGw | undefined;
beforeEach(() => multimodalState.reset());
afterEach(async () => {
  await h?.stop();
  h = undefined;
  multimodalState.reset();
});

describe('concurrent tool-call load (12.0)', () => {
  it('500 concurrent calls: all answered, scoped denials exact, metrics consistent', async () => {
    h = await startFeatureGw({
      servers: [{ ...fakeServer('fake'), maxConcurrency: 8, maxQueue: 1000 }, fakeServer('vault')],
      auth: { strategy: 'api-key', apiKeys: ['op', { key: 'scoped', servers: ['fake'] }] },
    } as never);
    const call = (key: string, server: string, i: number) =>
      fetch(`${h!.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ server, tool: 'echo', arguments: { i } }) }).then((r) => r.status);
    const t0 = Date.now();
    const statuses = await Promise.all(Array.from({ length: 500 }, (_, i) => (i % 5 === 4 ? call('scoped', 'vault', i) : call(i % 2 ? 'scoped' : 'op', 'fake', i))));
    const ms = Date.now() - t0;
    expect(statuses.filter((s) => s === 200)).toHaveLength(400);
    expect(statuses.filter((s) => s === 403)).toHaveLength(100);
    const gw = h.gw as unknown as { invoker: { authzDenials: number } };
    expect(gw.invoker.authzDenials).toBe(0); // REST refused them before the invoker; the invoker re-checks the rest
    const m = (await h.admin('../metrics')).body as { totalRequests?: number };
    if (typeof m.totalRequests === 'number') expect(m.totalRequests).toBeGreaterThanOrEqual(400);
    // Recorded for the CI log (not a threshold).
    console.log(`[perf] 500 concurrent REST tool calls in ${ms} ms (${Math.round(500_000 / ms)} req/s)`);
  }, 60_000);
});

describe('multimodal memory pressure (12.0)', () => {
  it('held bytes stay inside the budget while 300 × 1 MiB images flow through', () => {
    const cfg = { servers: [], multimodal: { offloadAboveBytes: 1024, maxStoredBytes: 16 * 1024 * 1024, maxTenantStoredBytes: 8 * 1024 * 1024 } } as unknown as GatewayConfig;
    const data = Buffer.alloc(1024 * 1024, 3).toString('base64');
    const res: ProxyResponse = { success: true, durationMs: 1, result: { content: [{ type: 'image', data, mimeType: 'image/png' }] } };
    const heap0 = process.memoryUsage().heapUsed;
    let peak = 0;
    for (let i = 0; i < 300; i++) {
      const r = applyMultimodal(res, 'fake', 'cam', cfg, Date.now() + i, { clientId: `key:c${i % 3}`, tenant: `t${i % 3}` })!;
      expect(r.success).toBe(true);
      peak = Math.max(peak, multimodalState.stats.heldBytes);
    }
    expect(peak).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(multimodalState.stats.evicted).toBeGreaterThanOrEqual(300 - 16);
    const growth = (process.memoryUsage().heapUsed - heap0) / 1024 / 1024;
    console.log(`[perf] multimodal pressure: peak held ${(peak / 1048576).toFixed(1)} MiB, heap growth ${growth.toFixed(1)} MiB, evicted ${multimodalState.stats.evicted}`);
  });
});

describe('transactional hot reload (12.0)', () => {
  it('a reload that fails midway rolls back to the previous config', async () => {
    h = await startFeatureGw({ policy: { rules: [{ id: 'deny-echo', match: { tool: 'echo' }, effect: 'deny' }] } } as never);
    const gw = h.gw as unknown as { reload: (c: GatewayConfig) => Promise<void>; catalog: { prepare: () => Promise<unknown> }; config: GatewayConfig; rollbacks: number };
    const before = gw.config;
    const call = () => fetch(`${h!.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json' }, body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: {} }) }).then((r) => r.status);
    expect(await call()).toBe(403);
    gw.catalog.prepare = () => Promise.reject(new Error('catalog backend down'));
    const next = { ...before, policy: undefined, catalog: { serversFile: 'x.json' }, auth: { strategy: 'api-key', apiKeys: ['other'] } } as unknown as GatewayConfig;
    await expect(gw.reload(next)).rejects.toThrow(/catalog backend down/);
    expect(gw.rollbacks).toBe(1);
    expect(gw.config).toBe(before);
    expect(await call()).toBe(403); // old key still valid, old policy still enforced
    expect((await fetch(`${h.base}/api/v1/tools`, { headers: { authorization: 'Bearer other' } })).status).toBe(401);
  }, 30_000);
});
