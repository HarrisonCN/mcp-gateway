import { describe, it, expect, afterEach } from 'vitest';
import { simulatePolicy, CandidatePolicySchema, ShadowRecorder, shadowRecorder } from '../src/features/policy-sim.js';
import { validateConfig } from '../src/config/loader.js';
import type { ToolPolicyConfig } from '../src/utils/types.js';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';

let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const calls = [
  { clientId: 'key:ci', serverId: 'fs', tool: 'read_file', args: { path: '/srv/a' } },
  { clientId: 'key:ci', serverId: 'fs', tool: 'write_file', args: { path: '/etc/passwd' } },
  { clientId: 'key:bot', serverId: 'gh', tool: 'delete_repo', args: {} },
  { serverId: 'gh', tool: 'search' },
];

describe('policy simulation and dry-run (6.5)', () => {
  it('diffs decisions between the current and a candidate policy', () => {
    const current: ToolPolicyConfig = { rules: [{ name: 'no-delete', effect: 'deny', tools: ['delete_*'] }] };
    const candidate = CandidatePolicySchema.parse({ default: 'deny', rules: [{ name: 'reads', effect: 'allow', tools: ['read_*', 'search'] }, { name: 'etc', effect: 'approve', args: [{ path: 'path', under: ['/etc'] }] }] }) as ToolPolicyConfig;
    const r = simulatePolicy(current, candidate, calls, 'test');
    expect(r).toMatchObject({ source: 'test', calls: 4, withArguments: 2, unchanged: 3, changed: 1, transitions: { 'allow→approve': 1 } });
    expect(r.byRule).toEqual({ reads: 2, etc: 1, '(default)': 1 });
    expect(r.byTool['fs/write_file']).toEqual({ changed: 1, newlyDenied: 0 });
    expect(r.examples[0]!.after.rule).toBe('etc');
    const strict = simulatePolicy(undefined, { default: 'deny' }, calls, 'x', 1);
    expect(strict.transitions).toEqual({ 'allow→deny': 4 });
    expect(strict.byClient.anonymous).toEqual({ changed: 1, newlyDenied: 1 });
    expect(strict.examples).toHaveLength(1);
  });

  it('validates candidate and shadow policies', () => {
    expect(() => CandidatePolicySchema.parse({ rules: [{ effect: 'maybe' }] })).toThrow();
    expect(() => CandidatePolicySchema.parse({ rules: [{ effect: 'deny', args: [{ path: 'a', regex: '(' }] }] })).toThrow(/invalid regex/);
    expect(() => validateConfig({ servers: [], features: { policyShadow: { default: 'deny', rules: [{ effect: 'allow', tools: ['read_*'] }] } } })).not.toThrow();
    expect(() => validateConfig({ servers: [], features: { policyShadow: { nope: 1 } } })).toThrow();
  });

  it('shadow recorder counts agreement and keeps bounded divergences', () => {
    const s = new ShadowRecorder(2);
    const allow = { effect: 'allow' as const };
    const deny = { effect: 'deny' as const, rule: 'r' };
    s.record(allow, allow, { serverId: 'a', tool: 't' });
    for (let i = 0; i < 3; i++) s.record(allow, deny, { serverId: 'a', tool: `t${i}` });
    expect([s.evaluated, s.agree, s.transitions['allow→deny']]).toEqual([4, 1, 3]);
    expect(s.divergences.map((d) => d.tool)).toEqual(['t1', 't2']);
    s.reset();
    expect([s.evaluated, s.divergences.length]).toEqual([0, 0]);
  });

  it('admin API: simulate from replay / metrics / request, dry-run, shadow', async () => {
    shadowRecorder.reset();
    h = await startFeatureGw({ replay: { enabled: true }, policy: { rules: [{ name: 'no-secret', effect: 'deny', args: [{ path: 'secret', exists: true }] }] }, policyShadow: { default: 'deny', rules: [{ name: 'echo-ok', effect: 'allow', tools: ['echo'], args: [{ path: 'safe', equals: true }] }] } } as never);
    const call = (args: Record<string, unknown>) => fetch(`${h!.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json' }, body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: args }) });
    expect((await call({ safe: true })).status).toBe(200);
    expect((await call({ safe: false })).status).toBe(200);
    expect((await call({ secret: 1 })).status).toBe(403);
    const sh = await h.admin('policy-sim/shadow');
    expect(sh.body).toMatchObject({ enabled: true, evaluated: 2, agree: 1, diverged: 1, transitions: { 'allow→deny': 1 } });
    expect(sh.body.divergences[0]).toMatchObject({ tool: 'echo', shadow: { effect: 'deny' } });
    const sim = await h.admin('policy-sim/simulate', { policy: { default: 'deny', rules: [{ effect: 'allow', args: [{ path: 'safe', equals: true }] }] } });
    expect(sim.body.source).toBe('replay');
    expect(sim.body.calls).toBeGreaterThanOrEqual(2);
    expect(sim.body.transitions['allow→deny']).toBeGreaterThanOrEqual(1);
    const met = await h.admin('policy-sim/simulate', { source: 'metrics', policy: { default: 'deny' } });
    expect(met.body.source).toBe('metrics');
    expect(met.body.withArguments).toBe(0);
    const given = await h.admin('policy-sim/simulate', { policy: {}, calls: [{ serverId: 'fake', tool: 'echo', args: { secret: 'x' } }] });
    expect(given.body).toMatchObject({ source: 'request', transitions: { 'deny→allow': 1 } });
    expect((await h.admin('policy-sim/simulate', { policy: { rules: [{ effect: 'x' }] } })).status).toBe(400);
    expect((await h.admin('policy-sim/simulate', { calls: [{ tool: 'x' }] })).status).toBe(400);
    const dr = await h.admin('policy-sim/dry-run', { server: 'fake', tool: 'echo', arguments: { secret: 1 }, clientId: 'key:x' });
    expect(dr.body).toMatchObject({ enforced: { effect: 'deny', rule: 'no-secret' }, shadow: { effect: 'deny' } });
    expect((await h.admin('policy-sim/dry-run', { server: 'fake' })).status).toBe(400);
    expect((await h.admin('policy-sim/dry-run', { server: 'fake', tool: 'x', arguments: 3 })).status).toBe(400);
    expect((await h.admin('policy-sim/shadow/reset', {})).body.reset).toBe(true);
    expect((await h.admin('policy-sim/shadow')).body.evaluated).toBe(0);
    expect((await h.admin('policy-sim/simulate', [])).status).toBe(400);
  });
});
