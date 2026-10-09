/** 9.6: self-healing. */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { startFeatureGw, fakeServer, type FeatureGw } from './helpers/feature-gw.js';
import { validateConfig } from '../src/config/loader.js';
import { observe, selfHealingState, ERR_SELF_HEALING } from '../src/features/self-healing.js';
import type { GatewayConfig } from '../src/utils/types.js';

let h: FeatureGw | undefined;
beforeEach(() => selfHealingState.reset());
afterEach(async () => {
  await h?.stop();
  h = undefined;
});
const call = async (server = 'fake') => {
  const r = await fetch(`${h!.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json' }, body: JSON.stringify({ server, tool: 'echo', arguments: {} }) });
  return JSON.stringify(await r.json());
};
const servers = [fakeServer('fake', { SERVER_TAG: 'fake' }), fakeServer('backup', { SERVER_TAG: 'backup' })];
const keys = { strategy: 'api-key', apiKeys: ['op', { key: 'scoped', servers: ['fake'] }] };

describe('self-healing (9.6)', () => {
  it('validates rules', () => {
    expect(() => validateConfig({ version: 11, servers: [], features: { selfHealing: { rules: [{ id: 'a', servers: ['x'], when: {}, action: 'eject' }] } } })).toThrow(/errorRateAbove or p95Above/);
    expect(() => validateConfig({ version: 11, servers: [], features: { selfHealing: { rules: [{ id: 'a', servers: ['x'], when: { p95Above: 10 }, action: 'rollback' }] } } })).toThrow(/rollbackTo/);
    expect(() => validateConfig({ version: 11, servers: [], features: { selfHealing: { rules: [{ id: 'a', servers: ['x'], when: { p95Above: 10 }, action: 'throttle' }] } } })).toThrow(/maxPerSecond/);
    expect(ERR_SELF_HEALING).toBe(-32025);
  });

  it('trips on the error rate, ejects and fails over, lifts after the cool-down', () => {
    const cfg = { servers: [], selfHealing: { minCalls: 10, rules: [{ id: 'down', servers: ['fake'], when: { errorRateAbove: 0.5 }, action: 'eject', cooldownSeconds: 30 }] } } as unknown as GatewayConfig;
    const t = Date.now();
    for (let i = 0; i < 9; i++) observe(cfg, 'fake', false, 5, t);
    expect(selfHealingState.active.size).toBe(0); // below minCalls
    observe(cfg, 'fake', false, 5, t);
    expect([...selfHealingState.active.values()][0]).toMatchObject({ rule: 'down', server: 'fake', action: 'eject' });
    expect(selfHealingState.history[0].reason).toContain('error rate 1.00 > 0.5 over 10 calls');
    observe(cfg, 'fake', true, 5, t + 31_000); // cool-down elapsed: lifted, window fresh
    expect(selfHealingState.active.size).toBe(0);
    expect(selfHealingState.history[0].event).toBe('lifted');
  });

  it('routes around an ejected server, rolls back, throttles; operator trigger and clear', async () => {
    h = await startFeatureGw({ servers, auth: keys, selfHealing: { rules: [
      { id: 'down', servers: ['fake'], when: { errorRateAbove: 0.5 }, action: 'eject', fallback: 'backup' },
      { id: 'bad-version', servers: ['backup'], when: { p95Above: 5000 }, action: 'rollback', rollbackTo: 'fake' },
      { id: 'slow', servers: ['fake'], when: { p95Above: 5000 }, action: 'throttle', maxPerSecond: 1 },
      { id: 'hard', servers: ['fake'], when: { errorRateAbove: 0.9 }, action: 'eject' },
    ] } } as never);
    expect(await call()).toContain('\\"_server\\":\\"fake\\"');
    expect((await h.admin('self-healing/down/trigger', { server: 'fake' })).body.action).toBe('eject');
    expect(await call()).toContain('\\"_server\\":\\"backup\\"');
    await h.admin('self-healing/down/clear', {});
    expect((await h.admin('self-healing/bad-version/trigger', { server: 'backup' })).status).toBe(200);
    expect(await call('backup')).toContain('\\"_server\\":\\"fake\\"');
    await h.admin('self-healing/bad-version/clear', { server: 'backup' });
    await h.admin('self-healing/slow/trigger', { server: 'fake' });
    const rs = await Promise.all([call(), call(), call()]);
    expect(rs.filter((r) => r.includes(String(ERR_SELF_HEALING))).length).toBeGreaterThanOrEqual(1);
    expect(rs.filter((r) => r.includes('_server')).length).toBeGreaterThanOrEqual(1);
    await h.admin('self-healing/slow/clear', {});
    await h.admin('self-healing/hard/trigger', { server: 'fake' });
    expect(await call()).toContain('is ejected');
    const st = await h.admin('self-healing');
    expect(st.body.active).toEqual([expect.objectContaining({ rule: 'hard', server: 'fake', refused: 1, to: null })]);
    expect(st.body.history.map((x: any) => `${x.rule}:${x.event}`).slice(0, 3)).toEqual(['hard:triggered', 'slow:cleared', 'slow:triggered']);
    expect((await h.admin('self-healing/hard/trigger', { server: 'backup' })).status).toBe(400);
    expect((await h.admin('self-healing/nope/clear', {})).status).toBe(404);
  });
});
