/** 7.5: tool versioning and gradual rollout. */
import { describe, it, expect, afterEach } from 'vitest';
import { startFeatureGw, fakeServer, type FeatureGw } from './helpers/feature-gw.js';
import { validateConfig } from '../src/config/loader.js';
import { RolloutsSchema, RolloutManager, bucketOf, rolloutManager } from '../src/features/rollouts.js';

let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

describe('rollouts (7.5)', () => {
  it('schema, sticky buckets and automatic rollback', () => {
    expect(() => validateConfig({ servers: [], features: { rollouts: [{ id: 'a', stable: 'x', canary: 'x' }] } })).toThrow(/different servers/);
    expect(() => validateConfig({ servers: [], features: { rollouts: [{ id: 'a', stable: 'x', canary: 'y' }, { id: 'a', stable: 'z', canary: 'y' }] } })).toThrow(/duplicate rollout id/);
    expect(() => validateConfig({ servers: [], features: { rollouts: [{ id: 'a', stable: 'x', canary: 'y' }, { id: 'b', stable: 'x', canary: 'z' }] } })).toThrow(/more than one rollout/);
    expect(bucketOf('r', 'key:a')).toBe(bucketOf('r', 'key:a'));
    const [r] = RolloutsSchema.parse([{ id: 'r', stable: 's', canary: 'c', percent: 30, clients: ['key:beta-*'], exclude: ['key:vip'], autoRollback: { maxErrorRate: 0.5, minCalls: 4 } }]);
    const m = new RolloutManager();
    const canaries = Array.from({ length: 1000 }, (_, i) => m.pick(r!, `key:c${i}`)).filter((v) => v === 'canary').length;
    expect(canaries).toBeGreaterThan(220);
    expect(canaries).toBeLessThan(380);
    expect(m.pick(r!, 'key:beta-1')).toBe('canary');
    expect(m.pick(r!, 'key:vip')).toBe('stable');
    m.record(r!, 'canary', false);
    m.record(r!, 'canary', true);
    m.record(r!, 'canary', true);
    expect(m.view(r!).state).toBe('active');
    m.record(r!, 'canary', true);
    const v = m.view(r!);
    expect(v).toMatchObject({ state: 'rolled-back', percent: 0, configuredPercent: 30 });
    expect(v.reason).toMatch(/canary error rate 75.0% > 50.0% over 4 calls/);
    expect(m.pick(r!, 'key:beta-1')).toBe('stable');
    m.reset('r');
    expect(m.view(r!)).toMatchObject({ state: 'active', percent: 30 });
  });

  it('gateway: routes canary clients to the new version; promote / rollback / percent / persist', async () => {
    rolloutManager.states.clear();
    h = await startFeatureGw({
      controlPlane: { configApi: true },
      servers: [fakeServer('fake'), fakeServer('v2', { SERVER_TAG: 'v2' })],
      auth: { strategy: 'api-key', apiKeys: ['op', { key: 'beta-key', name: 'beta-1' }] },
      rollouts: [{ id: 'fake-v2', stable: 'fake', canary: 'v2', percent: 0, clients: ['key:beta-*'] }],
    } as never);
    const call = async (key = 'op') => {
      const r = await fetch(`${h!.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: { a: 1 } }) });
      return JSON.stringify(await r.json());
    };
    expect(await call()).not.toContain('v2');
    const beta = await call('beta-key');
    expect(beta).toContain('\\"_server\\":\\"v2\\"');
    expect(beta).toContain('mcp-gateway/rollout');
    let st = (await h.admin('rollouts')).body.rollouts[0];
    expect(st).toMatchObject({ id: 'fake-v2', percent: 0, state: 'active', versions: { stable: { calls: 1 }, canary: { calls: 1 } } });

    expect((await h.admin('rollouts/fake-v2/promote', {})).body).toMatchObject({ percent: 100, state: 'promoted' });
    expect(await call()).toContain('v2');
    expect((await h.admin('rollouts/fake-v2/rollback', {})).body).toMatchObject({ percent: 0, state: 'rolled-back' });
    expect(await call('beta-key')).not.toContain('v2');
    expect((await h.admin('rollouts/fake-v2/reset', {})).body).toMatchObject({ percent: 0, state: 'active' });
    expect(await call('beta-key')).toContain('v2');
    expect((await h.admin('rollouts/fake-v2/percent', { percent: 101 })).status).toBe(400);
    expect((await h.admin('rollouts/fake-v2/percent?persist=true', { percent: 100 })).body.percent).toBe(100);
    expect(h.gw['config'].rollouts[0].percent).toBe(100);
    st = (await h.admin('rollouts/fake-v2')).body;
    expect(st.configuredPercent).toBe(100);
    expect((await h.admin('rollouts/nope')).status).toBe(404);
    expect((await h.admin('rollouts/nope/promote', {})).status).toBe(404);
  });
});
