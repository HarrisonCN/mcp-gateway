/** 9.5: SLA monitoring & credit reports. */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';
import { validateConfig } from '../src/config/loader.js';
import { recordSla, slaState } from '../src/features/sla.js';
import type { GatewayConfig } from '../src/utils/types.js';

let h: FeatureGw | undefined;
beforeEach(() => slaState.reset());
afterEach(async () => {
  await h?.stop();
  h = undefined;
});
const target = { id: 'gold', servers: ['fake'], availability: 99.5, latencyP95Ms: 300, monthlyFee: 1000, currency: 'EUR', credits: [{ below: 99.5, percent: 10 }, { below: 98, percent: 25 }], excludeErrorCodes: [-32003] };
const ok = (ms: number) => ({ success: true, durationMs: ms });
const fail = (code = -32000) => ({ success: false, durationMs: 5, error: { code, message: 'x' } });

describe('SLA monitoring (9.5)', () => {
  it('validates targets', () => {
    expect(() => validateConfig({ version: 10, servers: [], features: { sla: { targets: [{ id: 'a', availability: 101 }] } } })).toThrow();
    expect(() => validateConfig({ version: 10, servers: [], features: { sla: { targets: [{ id: 'a', availability: 99 }, { id: 'a', availability: 99 }] } } })).toThrow(/duplicate SLA target/);
  });

  it('measures availability, p95, error budget, breaches and credits; reports JSON and CSV', async () => {
    h = await startFeatureGw({ sla: { targets: [target, { id: 'all', availability: 90 }] } } as never);
    const cfg = { servers: [], sla: { targets: [target, { id: 'all', availability: 90 }] } } as unknown as GatewayConfig;
    const now = Date.now();
    for (let i = 0; i < 970; i++) recordSla({ serverId: 'fake', tenant: i % 2 ? 'acme' : 'globex' }, ok(i < 900 ? 40 : 900), cfg, now);
    for (let i = 0; i < 30; i++) recordSla({ serverId: 'fake', tenant: 'acme' }, fail(), cfg, now);
    for (let i = 0; i < 50; i++) recordSla({ serverId: 'fake', tenant: 'acme' }, fail(-32003), cfg, now); // excluded from gold
    recordSla({ serverId: 'other' }, ok(1), cfg, now);
    recordSla({ serverId: 'fake' }, ok(1), cfg, now - 31 * 86_400_000); // outside the window
    const r = await h.admin('sla');
    const gold = r.body.targets.find((t: any) => t.id === 'gold');
    expect(gold).toMatchObject({ calls: 1000, failures: 30, availability: 97, met: false, latencyP95Ms: 1000 });
    expect(gold.breaches).toEqual(['availability 97% < 99.5%', 'p95 1000ms > 300ms']);
    expect(gold.credit).toEqual({ percent: 25, amount: 250, currency: 'EUR' });
    expect(gold.errorBudget).toMatchObject({ allowedFailures: 5, remaining: -25, remainingPercent: -500 });
    expect(gold.tenants.find((t: any) => t.tenant === 'acme')).toMatchObject({ calls: 515, failures: 30 });
    const all = r.body.targets.find((t: any) => t.id === 'all');
    expect(all).toMatchObject({ calls: 1051, failures: 80, met: true });
    const rep = await h.admin('sla/report?target=gold');
    expect(rep.body.totalCredit).toBe(250);
    const csv = await fetch(`${h.base}/api/v1/admin/sla/report?format=csv`, { headers: { authorization: 'Bearer op' } });
    expect(csv.headers.get('content-type')).toContain('text/csv');
    const lines = (await csv.text()).trim().split('\n');
    expect(lines[0]).toContain('credit_percent');
    expect(lines[1]).toMatch(/^gold,\*,.*,1000,30,97,99\.5,1000,false,25,250,EUR$/);
    expect((await h.admin('sla/report?target=nope')).status).toBe(404);
    expect((await h.admin('sla/report?format=xml')).status).toBe(400);
    expect((await h.admin('sla/reset', {})).body.reset).toBe(true);
    expect((await h.admin('sla')).body.targets[0].calls).toBe(0);
  });

  it('counts real tool calls', async () => {
    h = await startFeatureGw({ sla: { targets: [{ id: 'live', availability: 99 }] } } as never);
    await fetch(`${h.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json' }, body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: {} }) });
    expect((await h.admin('sla')).body.targets[0]).toMatchObject({ calls: 1, failures: 0, availability: 100, met: true });
  });
});
