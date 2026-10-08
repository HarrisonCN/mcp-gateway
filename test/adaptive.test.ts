import { describe, it, expect, afterEach } from 'vitest';
import { AdaptiveRouter, AdaptiveSchema, sampleBeta, adaptiveRouter } from '../src/features/adaptive.js';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';

const seeded = (s = 42) => () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pool = AdaptiveSchema.parse({ pools: [{ id: 'p', objective: { quality: 1, cost: 0.5, latency: 0 }, candidates: [
  { id: 'cheap', server: 's', tool: 'a', costPerCall: 0.001 },
  { id: 'good', server: 's', tool: 'b', costPerCall: 0.01 },
] }] }).pools[0]!;

let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

describe('adaptive routing 2.0 (5.8)', () => {
  it('Beta samples stay in (0,1) and track the mean', () => {
    const r = seeded();
    const xs = Array.from({ length: 2000 }, () => sampleBeta(8, 2, r));
    expect(Math.min(...xs)).toBeGreaterThan(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.75);
    expect(mean).toBeLessThan(0.85);
    expect(sampleBeta(0.5, 0.5, r)).toBeGreaterThan(0);
  });

  it('learns from feedback: quality beats price once proven', () => {
    const router = new AdaptiveRouter(seeded(7));
    for (let i = 0; i < 30; i++) {
      router.feedback('p', 'good', 0.95);
      router.feedback('p', 'cheap', 0.2);
    }
    const picks = { cheap: 0, good: 0 } as Record<string, number>;
    for (let i = 0; i < 200; i++) picks[router.pick(pool)!.candidate.id]++;
    expect(picks.good).toBeGreaterThan(150);
    expect(router.pick(pool, false)!.candidate.id).toBe('good');
  });

  it('errors and latency lower the score; maxCostPerCall filters', () => {
    const router = new AdaptiveRouter(seeded(3));
    const p = { ...pool, objective: { quality: 0, cost: 0, latency: 1 } };
    router.observe('p', 'cheap', true, 500);
    router.observe('p', 'cheap', true, 100);
    router.observe('p', 'good', true, 50);
    expect(router.get('p', 'cheap').latencyMs).toBeCloseTo(420);
    expect(router.pick(p, false)!.candidate.id).toBe('good');
    router.observe('p', 'good', false, 50);
    expect(router.score(p, false).find((s) => s.id === 'good')!.errorRate).toBe(0.5);
    expect(router.pick({ ...pool, maxCostPerCall: 0.005 })!.candidate.id).toBe('cheap');
    expect(router.pick({ ...pool, maxCostPerCall: 0 })).toBeUndefined();
    router.feedback('p', 'good', 7);
    expect(router.get('p', 'good').alpha).toBe(2);
  });

  it('admin API: pick, call (learns from traffic), feedback', async () => {
    h = await startFeatureGw({ adaptive: { pools: [{ id: 'echoes', candidates: [{ id: 'one', server: 'fake', tool: 'echo', args: { via: 'one' }, costPerCall: 0.002 }, { id: 'two', server: 'fake', tool: 'echo', args: { via: 'two' } }] }] } } as never);
    const pk = await h.admin('adaptive/pick', { pool: 'echoes', explore: false });
    expect(pk.status).toBe(200);
    expect(pk.body.scores).toHaveLength(2);
    const c = await h.admin('adaptive/call', { pool: 'echoes', arguments: { hello: 'x' } });
    expect(c.status).toBe(200);
    expect(JSON.stringify(c.body.result)).toMatch(/"via\\?":\\?"(one|two)/);
    const st = await h.admin('adaptive');
    expect(st.body.pools[0].candidates.reduce((n: number, x: any) => n + x.calls, 0)).toBeGreaterThanOrEqual(2); // same server+tool → both learn
    expect((await h.admin('adaptive/feedback', { pool: 'echoes', candidate: 'one', quality: 1 })).body.quality).toBeGreaterThan(0.5);
    expect((await h.admin('adaptive/feedback', { pool: 'echoes', candidate: 'zz', quality: 1 })).status).toBe(400);
    expect((await h.admin('adaptive/feedback', { pool: 'echoes', candidate: 'one', quality: 2 })).status).toBe(400);
    expect((await h.admin('adaptive/pick', { pool: 'nope' })).status).toBe(404);
    expect((await h.admin('adaptive/call', { pool: 'echoes', arguments: [] })).status).toBe(400);
    expect((await h.admin('adaptive/pick', [])).status).toBe(400);
    expect((await h.admin('adaptive/call', [])).status).toBe(400);
    expect((await h.admin('adaptive/feedback', [])).status).toBe(400);
    expect((await h.admin('adaptive/call', { pool: 'nope' })).status).toBe(404);
    expect((await h.admin('adaptive/feedback', { pool: 'nope' })).status).toBe(404);
    await h.gw.reload({ ...(h.gw as any).config, adaptive: { pools: [{ id: 'echoes', maxCostPerCall: 0, candidates: [{ id: 'one', server: 'fake', tool: 'echo', costPerCall: 1 }] }] } });
    expect((await h.admin('adaptive/pick', { pool: 'echoes' })).status).toBe(422);
    expect((await h.admin('adaptive/call', { pool: 'echoes' })).status).toBe(422);
    const bad = new AdaptiveRouter();
    expect(bad.stats.size).toBe(0);
    expect(adaptiveRouter.get('echoes', 'one').picks + adaptiveRouter.get('echoes', 'two').picks).toBeGreaterThan(0);
  });

  it('reports 502 when the picked call fails', async () => {
    h = await startFeatureGw({ adaptive: { pools: [{ id: 'bad', candidates: [{ id: 'x', server: 'ghost', tool: 'nope' }] }] } } as never);
    expect((await h.admin('adaptive/call', { pool: 'bad' })).status).toBe(502);
  });
});
