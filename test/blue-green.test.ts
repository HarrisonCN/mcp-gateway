/** 8.5: zero-downtime blue/green upgrades. */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { startFeatureGw, fakeServer, type FeatureGw } from './helpers/feature-gw.js';
import { validateConfig } from '../src/config/loader.js';
import { blueGreenState } from '../src/features/blue-green.js';
import { debugState } from '../src/features/debug-sessions.js';

let h: FeatureGw | undefined;
beforeEach(() => {
  blueGreenState.reset();
  debugState.reset();
});
afterEach(async () => {
  await h?.stop();
  h = undefined;
});
const call = async (args: Record<string, unknown> = {}) => {
  const r = await fetch(`${h!.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json' }, body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: args }) });
  return JSON.stringify(await r.json());
};

describe('blue/green (8.5)', () => {
  it('validates deployments', () => {
    expect(() => validateConfig({ servers: [], features: { blueGreen: [{ id: 'a', blue: 'x', green: 'x' }] } })).toThrow(/must be different servers/);
    expect(() => validateConfig({ servers: [], features: { blueGreen: [{ id: 'a', blue: 'x', green: 'y' }, { id: 'a', blue: 'z', green: 'w' }] } })).toThrow(/duplicate blue\/green id/);
    expect(() => validateConfig({ servers: [], features: { blueGreen: [{ id: 'a', blue: 'x', green: 'y' }, { id: 'b', blue: 'x', green: 'w' }] } })).toThrow(/already the blue side/);
    expect(validateConfig({ version: 10, servers: [], features: { blueGreen: [{ id: 'a', blue: 'x', green: 'y', active: 'green' }] } }).blueGreen).toBeDefined();
  });

  it('probed switch, routing, rollback', async () => {
    h = await startFeatureGw({ servers: [fakeServer('fake'), fakeServer('v2', { SERVER_TAG: 'v2' })], blueGreen: [{ id: 'svc', blue: 'fake', green: 'v2', probe: { tool: 'health' }, verify: { seconds: 0 } }], debugSessions: {} } as never);
    const dbg = (await h.admin('debug-sessions', {})).body.id as string;
    expect(await call()).not.toContain('v2');
    // Hooks that track calls by their arguments object coexist (debug session still sees the result).
    expect((await h.admin(`debug-sessions/${dbg}`)).body.events.map((e: { type: string }) => e.type)).toEqual(['join', 'call', 'result']);
    const sw = await h.admin('blue-green/svc/switch', {});
    expect(sw.body).toMatchObject({ active: 'green', activeServer: 'v2', changed: true, probe: { ok: true } });
    expect(await call({ n: 1 })).toContain('\\"_server\\":\\"v2\\"');
    expect((await h.admin('blue-green/svc/switch', { to: 'green' })).body.changed).toBe(false);
    const st = (await h.admin('blue-green')).body.deployments[0];
    expect(st).toMatchObject({ active: 'green', calls: { blue: 1, green: 1 }, inFlight: { blue: 0, green: 0 } });
    expect(st.history[0]).toMatchObject({ from: 'blue', to: 'green', reason: 'manual switch' });
    expect((await h.admin('blue-green/svc/rollback', {})).body).toMatchObject({ active: 'blue', activeServer: 'fake' });
    expect(await call()).not.toContain('v2');
    expect((await h.admin('blue-green/nope/switch', {})).status).toBe(404);
    expect((await h.admin('blue-green/svc/switch', { to: 'red' })).status).toBe(400);
  });

  it('refuses a switch when the probe fails; auto-rolls back on errors after a forced switch', async () => {
    h = await startFeatureGw({ blueGreen: [{ id: 'svc', blue: 'fake', green: 'missing', probe: { tool: 'health' }, verify: { seconds: 60, maxErrorRate: 0.5, minCalls: 2 } }] } as never);
    const refused = await h.admin('blue-green/svc/switch', {});
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/probe "health" failed on green/);
    expect((await h.admin('blue-green/svc/switch', { force: true })).body).toMatchObject({ active: 'green', probe: { ok: false } });
    await call();
    await call();
    const st = (await h.admin('blue-green')).body.deployments[0];
    expect(st.active).toBe('blue');
    expect(st.history[0].reason).toMatch(/auto-rollback: 2\/2 errors after switching to green/);
    expect(await call()).toContain('content');
  });
});
