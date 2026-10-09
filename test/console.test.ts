/** 7.2: SaaS console — organisations, plans, daily limits, suspension. */
import { describe, it, expect, afterEach } from 'vitest';
import { startFeatureGw, scoped, type FeatureGw } from './helpers/feature-gw.js';
import { validateConfig } from '../src/config/loader.js';
import { ConsoleSchema, DailyCounter, admitCall, consoleCounter, ERR_ORG_REFUSED } from '../src/features/console.js';

let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const plans = { free: { servers: ['fake'], callsPerDay: 2 }, pro: { name: 'Pro', servers: ['*'] } };

describe('SaaS console (7.2)', () => {
  it('schema: plans must exist; counter rolls over by UTC day', () => {
    expect(() => validateConfig({ servers: [], features: { console: { plans, orgs: { a: { plan: 'gold' } } } } })).toThrow(/unknown plan "gold"/);
    expect(() => validateConfig({ servers: [], features: { console: { plans, defaultPlan: 'x' } } })).toThrow(/unknown plan "x"/);
    expect(() => validateConfig({ servers: [], features: { console: { plans: { p: { servers: [] } } } } })).toThrow();
    let now = new Date('2026-01-01T23:59:00Z');
    const c = new DailyCounter(() => now);
    const cfg = ConsoleSchema.parse({ plans, orgs: { a: { plan: 'free' }, s: { plan: 'pro', suspended: true } } });
    expect(admitCall(cfg, 'a', c).ok).toBe(true);
    expect(admitCall(cfg, 'a', c).ok).toBe(true);
    expect(admitCall(cfg, 'a', c)).toMatchObject({ ok: false, reason: 'limit', data: { limit: 2, used: 2, plan: 'free' } });
    expect(admitCall(cfg, 's', c)).toMatchObject({ ok: false, reason: 'suspended' });
    expect(admitCall(cfg, 'other', c).ok).toBe(true);
    now = new Date('2026-01-02T00:00:01Z');
    expect(admitCall(cfg, 'a', c).ok).toBe(true);
  });

  it('onboards, limits, suspends, re-plans and offboards an organisation', async () => {
    consoleCounter.reset('acme');
    h = await startFeatureGw({
      controlPlane: { configApi: true },
      auth: { strategy: 'api-key', apiKeys: ['op', { key: 'scoped', servers: ['fake'] }, { key: 'acme-key', name: 'acme-ci' }] },
      console: { plans, defaultPlan: 'free' },
    } as never);
    expect((await h.admin('console')).body).toMatchObject({ defaultPlan: 'free', orgs: [], totals: { orgs: 0 } });
    const created = await h.admin('console/orgs', { id: 'acme', name: 'ACME', owner: 'key:acme*' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: 'acme', name: 'ACME', plan: 'free', tenant: 'ok', servers: ['fake'], members: [{ client: 'key:acme*', role: 'owner' }], usage: { today: 0, limit: 2, remaining: 2 } });
    expect((await h.admin('console/orgs', { id: 'acme' })).status).toBe(409);
    expect((await h.admin('console/orgs', { id: 'x', plan: 'gold' })).status).toBe(400);
    expect((await h.admin('console/orgs', { id: 'bad id' })).status).toBe(400);

    const call = () => fetch(`${h!.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: 'Bearer acme-key', 'content-type': 'application/json' }, body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: { a: 1 } }) });
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    const over = await call();
    expect(over.status).toBeGreaterThanOrEqual(400);
    const ob = JSON.stringify(await over.json());
    expect(ob).toContain(String(ERR_ORG_REFUSED));
    expect(ob).toContain('daily limit of 2');
    expect((await h.admin('console/orgs/acme')).body.usage).toEqual({ today: 2, limit: 2, remaining: 0 });

    // upgrade: unlimited, servers re-scoped
    const up = await h.admin('console/orgs/acme', { plan: 'pro' }, 'PATCH');
    expect(up.body).toMatchObject({ plan: 'pro', servers: ['*'], usage: { limit: null, remaining: null } });
    expect((await call()).status).toBe(200);
    // suspend
    expect((await h.admin('console/orgs/acme', { suspended: true }, 'PATCH')).body.suspended).toBe(true);
    const sus = await call();
    expect(JSON.stringify(await sus.json())).toContain('suspended');
    expect((await h.admin('console/orgs/acme', { suspended: 'yes' }, 'PATCH')).status).toBe(400);
    expect((await h.admin('console/orgs/acme', { plan: 'gold' }, 'PATCH')).status).toBe(400);
    expect((await h.admin('console/orgs/acme', { suspended: false }, 'PATCH')).status).toBe(200);
    expect((await h.admin('console/orgs/acme/reset-usage', {})).body.usage.today).toBe(0);

    const all = (await h.admin('console')).body;
    expect(all.plans.map((p: any) => `${p.id}:${p.orgs}`)).toEqual(['free:0', 'pro:1']); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(all.totals).toMatchObject({ orgs: 1, suspended: 0 });

    expect((await h.admin('console/orgs/acme', undefined, 'DELETE')).body).toEqual({ removed: 'acme' });
    expect(h.gw['config'].tenants).toBeUndefined();
    expect((await h.admin('console/orgs/acme')).status).toBe(404);
    expect((await h.admin('console/orgs/acme', undefined, 'DELETE')).status).toBe(404);
    expect((await h.admin('console', undefined, 'GET', scoped)).status).toBe(403);
  });

  it('is off without console config; writes need controlPlane.configApi', async () => {
    h = await startFeatureGw();
    expect((await h.admin('console')).status).toBe(404);
    await h.stop();
    h = await startFeatureGw({ console: { plans } } as never);
    expect((await h.admin('console/orgs', { id: 'a', plan: 'free' })).status).toBe(403);
  });
});
