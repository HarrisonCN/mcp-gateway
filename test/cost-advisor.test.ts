/** 8.4: cost optimization advisor. */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';
import { validateConfig } from '../src/config/loader.js';
import { CostAdvisorSchema, analyse, argsHash, advisorState, type Observation } from '../src/features/cost-advisor.js';
import type { GatewayConfig, ToolInfo } from '../src/utils/types.js';

let h: FeatureGw | undefined;
beforeEach(() => advisorState.reset());
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const now = Date.parse('2026-10-08T17:00:00Z');
const obs = (tool: string, n: number, opts: { server?: string; repeat?: boolean; fail?: number; cost?: number } = {}): Observation[] =>
  Array.from({ length: n }, (_, i) => ({ at: now - 1000 * i, serverId: opts.server ?? 'search', tool, argsHash: opts.repeat ? 'same' : `h${i}`, cost: opts.cost ?? 0.01, success: i >= (opts.fail ?? 0) }));

describe('cost advisor (8.4)', () => {
  it('config and stable argument hashes', () => {
    expect(() => validateConfig({ servers: [], features: { costAdvisor: { repeatThreshold: 2 } } })).toThrow();
    expect(validateConfig({ version: 11, servers: [], features: { costAdvisor: {} } }).costAdvisor).toBeDefined();
    expect(argsHash({ a: 1, b: [1, { c: 2 }] })).toBe(argsHash({ b: [1, { c: 2 }], a: 1 }));
    expect(argsHash({ a: 1 })).not.toBe(argsHash({ a: 2 }));
  });

  it('recommends caching, flags failures, finds cheaper upstreams and missing budgets', () => {
    const c = CostAdvisorSchema.parse({ minCalls: 10 });
    const cfg = { servers: [], costs: { currency: 'EUR', tools: [{ match: 'search/*', perCall: 0.01 }, { match: 'search-lite/*', perCall: 0.002 }] } } as unknown as GatewayConfig;
    const tools = [{ name: 'query', serverId: 'search' }, { name: 'query', serverId: 'search-lite' }] as ToolInfo[];
    const all = [...obs('query', 40, { repeat: true }), ...obs('flaky', 20, { fail: 10 }), ...obs('rare', 3, { repeat: true }), ...obs('old', 50).map((o) => ({ ...o, at: now - 2 * 86_400_000 }))];
    const r = analyse(cfg, c, all, tools, now);
    expect(r.currency).toBe('EUR');
    expect(r.window.calls).toBe(63);
    expect(r.spend).toBe(0.63);
    expect(r.recommendations.map((x) => x.id)).toEqual(['cache:search/query', 'cheaper-upstream:search/query', 'failures:search/flaky', 'budget']);
    const cache = r.recommendations[0]!;
    expect(cache.savings).toBe(0.39);
    expect(cache.suggestion).toEqual({ cache: { enabled: true, rules: [{ servers: ['search'], tools: ['query'], ttlSeconds: 300 }] } });
    expect(r.recommendations[1]!.savings).toBe(0.32);
    expect(r.recommendations[2]!.savings).toBe(0.1);
    expect(r.totalSavings).toBe(0.81);
    // Already cached + budget set → those recommendations disappear.
    const tuned = { ...cfg, cache: { enabled: true, rules: [{ servers: ['search'], ttlSeconds: 60 }] }, costs: { ...(cfg.costs as object), budgets: [{ name: 'm', period: 'month', limit: 10 }] } } as unknown as GatewayConfig;
    expect(analyse(tuned, c, all, tools, now).recommendations.map((x) => x.kind)).toEqual(['cheaper-upstream', 'failures']);
  });

  it('observes live calls and serves the report', async () => {
    h = await startFeatureGw({ costAdvisor: { minCalls: 3 }, costs: { tools: [{ match: 'fake/*', perCall: 0.5 }] } } as never);
    for (let i = 0; i < 4; i++) {
      await fetch(`${h.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json' }, body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: { q: 'same' } }) });
    }
    expect(advisorState.obs).toHaveLength(4);
    const r = (await h.admin('cost-advisor')).body;
    expect(r.spend).toBe(2);
    expect(r.recommendations[0]).toMatchObject({ kind: 'cache', tool: 'fake/echo', savings: 1.5 });
    expect((await h.admin('cost-advisor?windowMinutes=5')).body.window.minutes).toBe(5);
  });
});
