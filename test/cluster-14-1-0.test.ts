/**
 * 14.1.0 集群协调 — cluster config rollout coordination (tests-first).
 *
 * Contract:
 *  R1 every distributed config is a numbered generation (monotonic; same content → same generation)
 *  R2 all-at-once: every data plane targets the newest generation
 *  R3 canary: only the canary nodes target the new generation; promotion after every canary node ran it for bakeMs
 *  R4 failure rollback: a failed apply / health check of the target generation (≥ failureThreshold nodes) rolls the
 *     cluster back to the last good generation as a NEW generation (generation switching stays monotonic); the failed
 *     generation is marked bad and is not re-published without force
 *  R5 manual rollback to any kept generation; history bounded
 *  R6 divergence: a node off its target generation for > maxDivergenceMs is reported (converged=false); nodes that are
 *     legitimately on the previous generation during a canary are NOT diverged
 *  R7 data plane: post-apply health check failure → local rollback to the previous config, failed generation reported,
 *     the same bad etag is not re-applied in a loop
 *  R8 HTTP: per-node target via the config pull (x-node-id → X-Config-Generation); GET /api/v1/admin/cluster/rollout;
 *     POST /api/v1/admin/cluster/rollback
 *  R9 config: controlPlane.rollout validated (control role only)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { RolloutCoordinator, RolloutError } from '../src/gateway/rollout.js';
import { DataPlaneSync } from '../src/gateway/control-plane.js';
import { validateConfig } from '../src/config/loader.js';
import { Gateway } from '../src/gateway/index.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { startFeatureGw, op } from './helpers/feature-gw.js';
import Ajv from 'ajv';
import { readFileSync } from 'fs';

const cfgA = { servers: [], rateLimit: { windowSeconds: 60, limit: 100 } };
const cfgB = { servers: [], rateLimit: { windowSeconds: 60, limit: 200 } };
const cfgC = { servers: [], rateLimit: { windowSeconds: 60, limit: 300 } };

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

/** Nodes report what they run (etag of the generation they applied). */
const runTarget = (rc: RolloutCoordinator, node: string) => {
  const g = rc.targetFor(node)!;
  rc.report(node, { generation: g.generation, etag: g.etag });
  return g;
};

describe('R1 generations', () => {
  it('numbers published configs monotonically; identical content keeps the generation', () => {
    const rc = new RolloutCoordinator();
    const g1 = rc.publish(cfgA);
    expect(g1.generation).toBe(1);
    expect(g1.etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(rc.publish({ rateLimit: { limit: 100, windowSeconds: 60 }, servers: [] }).generation).toBe(1); // order independent
    const g2 = rc.publish(cfgB);
    expect(g2.generation).toBe(2);
    expect(rc.current()!.generation).toBe(2);
    expect(rc.status().history.map((h: { generation: number }) => h.generation)).toEqual([1, 2]);
  });
});

describe('R2 all-at-once', () => {
  it('every node targets the newest generation and the cluster converges', () => {
    const c = clock();
    const rc = new RolloutCoordinator({ strategy: 'all-at-once' }, { now: c.now });
    rc.publish(cfgA);
    for (const n of ['a', 'b', 'c']) runTarget(rc, n);
    expect(rc.status().converged).toBe(true);
    const g2 = rc.publish(cfgB);
    for (const n of ['a', 'b', 'c']) expect(rc.targetFor(n)!.generation).toBe(g2.generation);
    expect(rc.status().converged).toBe(false);
    for (const n of ['a', 'b', 'c']) runTarget(rc, n);
    expect(rc.status()).toMatchObject({ state: 'complete', generation: 2, converged: true });
  });
});

describe('R3 canary', () => {
  it('targets the canary nodes only, then promotes after bakeMs', () => {
    const c = clock();
    const rc = new RolloutCoordinator({ strategy: 'canary', canary: { nodes: 1 }, bakeMs: 30_000 }, { now: c.now });
    rc.publish(cfgA);
    for (const n of ['n3', 'n1', 'n2']) runTarget(rc, n);
    const g2 = rc.publish(cfgB);
    const st = rc.status();
    expect(st.state).toBe('canary');
    expect(st.canaryNodes).toEqual(['n1']); // deterministic: sorted node ids
    expect(rc.targetFor('n1')!.generation).toBe(2);
    expect(rc.targetFor('n2')!.generation).toBe(1);
    expect(rc.targetFor('n3')!.generation).toBe(1);
    expect(rc.targetFor('new-node')!.generation).toBe(1); // a node joining mid-canary gets the stable generation
    runTarget(rc, 'n1');
    c.advance(29_000);
    rc.tick();
    expect(rc.status().state).toBe('canary');
    c.advance(2_000);
    rc.tick();
    expect(rc.status().state).toBe('complete');
    for (const n of ['n2', 'n3', 'new-node']) expect(rc.targetFor(n)!.generation).toBe(g2.generation);
  });

  it('percent canary rounds up to at least one node', () => {
    const rc = new RolloutCoordinator({ strategy: 'canary', canary: { percent: 25 } });
    rc.publish(cfgA);
    for (const n of ['a', 'b', 'c', 'd', 'e']) runTarget(rc, n);
    rc.publish(cfgB);
    expect(rc.status().canaryNodes).toEqual(['a', 'b']); // ceil(5 * 0.25) = 2
  });

  it('the first generation goes to every node (nothing to canary against)', () => {
    const rc = new RolloutCoordinator({ strategy: 'canary', canary: { nodes: 1 } });
    rc.publish(cfgA);
    expect(rc.targetFor('a')!.generation).toBe(1);
    expect(rc.targetFor('b')!.generation).toBe(1);
  });
});

describe('R4 failure rollback', () => {
  it('a canary failing to apply rolls the cluster back to the last good config as a new generation', () => {
    const c = clock();
    const rc = new RolloutCoordinator({ strategy: 'canary', canary: { nodes: 1 }, bakeMs: 1000 }, { now: c.now });
    const g1 = rc.publish(cfgA);
    for (const n of ['a', 'b']) runTarget(rc, n);
    const g2 = rc.publish(cfgB);
    rc.report('a', { generation: 1, etag: g1.etag, failedGeneration: 2, error: 'upstream "x" unreachable' });
    const st = rc.status();
    expect(st.state).toBe('rolled-back');
    expect(st.generation).toBe(3);
    const g3 = rc.current()!;
    expect(g3).toMatchObject({ generation: 3, source: 'rollback', rollbackOf: 2, etag: g1.etag });
    expect(st.lastRollback).toMatchObject({ from: 2, to: 3, restored: 1 });
    expect(st.lastRollback.reason).toContain('upstream "x" unreachable');
    expect(st.history.find((h: { generation: number }) => h.generation === g2.generation).bad).toBe(true);
    // nodes running generation 1's content are immediately in sync with generation 3 (same etag)
    expect(rc.status().converged).toBe(true);
    // the bad content is refused without force; force publishes it again as a new generation
    expect(() => rc.publish(cfgB)).toThrow(RolloutError);
    expect(rc.publish(cfgB, { force: true }).generation).toBe(4);
  });

  it('failureThreshold > 1 waits for more failures; autoRollback false only reports', () => {
    const rc = new RolloutCoordinator({ failureThreshold: 2 });
    rc.publish(cfgA);
    for (const n of ['a', 'b', 'c']) runTarget(rc, n);
    rc.publish(cfgB);
    rc.report('a', { failedGeneration: 2, error: 'x' });
    expect(rc.status().state).not.toBe('rolled-back');
    rc.report('b', { failedGeneration: 2, error: 'y' });
    expect(rc.status().state).toBe('rolled-back');

    const manual = new RolloutCoordinator({ autoRollback: false });
    manual.publish(cfgA);
    manual.publish(cfgB);
    manual.report('a', { failedGeneration: 2, error: 'boom' });
    expect(manual.status()).toMatchObject({ state: 'failed', generation: 2 });
    expect(manual.status().failures).toEqual([{ nodeId: 'a', generation: 2, error: 'boom' }]);
  });

  it('a failure report for an older generation does not roll back the current one', () => {
    const rc = new RolloutCoordinator();
    rc.publish(cfgA);
    rc.publish(cfgB);
    rc.report('a', { failedGeneration: 1, error: 'old' });
    expect(rc.status()).toMatchObject({ state: 'complete', generation: 2 });
  });
});

describe('R5 manual rollback + history', () => {
  it('rolls back to a kept generation; refuses unknown ones; keeps at most `history` generations', () => {
    const rc = new RolloutCoordinator({ history: 3 });
    const g1 = rc.publish(cfgA);
    rc.publish(cfgB);
    rc.publish(cfgC);
    const r = rc.rollback(1, 'operator');
    expect(r).toMatchObject({ generation: 4, source: 'rollback', rollbackOf: 3, etag: g1.etag });
    expect(rc.status().history.map((h: { generation: number }) => h.generation)).toEqual([2, 3, 4]);
    expect(() => rc.rollback(1)).toThrow(RolloutError); // evicted
    expect(rc.rollback().etag).toBe(rc.status().history.find((h: { generation: number }) => h.generation === 3).etag); // default: previous generation
  });
});

describe('R6 divergence', () => {
  it('reports a node off its target for longer than maxDivergenceMs, and clears when it catches up', () => {
    const c = clock();
    const rc = new RolloutCoordinator({ maxDivergenceMs: 60_000 }, { now: c.now });
    const g1 = rc.publish(cfgA);
    for (const n of ['a', 'b']) runTarget(rc, n);
    rc.publish(cfgB);
    runTarget(rc, 'a');
    rc.report('b', { generation: 1, etag: g1.etag });
    c.advance(30_000);
    rc.tick();
    expect(rc.status().diverged).toEqual([]);
    c.advance(31_000);
    rc.tick();
    const st = rc.status();
    expect(st.converged).toBe(false);
    expect(st.diverged).toEqual(['b']);
    expect(st.nodes.find((n: { nodeId: string }) => n.nodeId === 'b')).toMatchObject({ generation: 1, target: 2, inSync: false, diverged: true });
    expect(st.nodes.find((n: { nodeId: string }) => n.nodeId === 'b').divergedForMs).toBeGreaterThanOrEqual(61_000);
    runTarget(rc, 'b');
    expect(rc.status()).toMatchObject({ converged: true, diverged: [] });
  });

  it('non-canary nodes on the stable generation during a canary are not diverged', () => {
    const c = clock();
    const rc = new RolloutCoordinator({ strategy: 'canary', canary: { nodes: 1 }, bakeMs: 600_000, maxDivergenceMs: 1000 }, { now: c.now });
    rc.publish(cfgA);
    for (const n of ['a', 'b']) runTarget(rc, n);
    rc.publish(cfgB);
    runTarget(rc, 'a');
    c.advance(5000);
    rc.tick();
    expect(rc.status().diverged).toEqual([]);
  });
});

describe('R7 data plane local rollback', () => {
  type Body = { etag: string; generation: number; config: Record<string, unknown> };
  function fakeCp(serve: () => Body) {
    const beats: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const pulls: Array<Record<string, string>> = [];
    const f = (async (url: string, init: { headers?: Record<string, string>; body?: string } = {}) => {
      if (url.endsWith('/heartbeat')) {
        beats.push(JSON.parse(init.body!));
        return new Response('{}', { status: 200 });
      }
      pulls.push(init.headers ?? {});
      const b = serve();
      if (init.headers?.['if-none-match'] === b.etag) return new Response(null, { status: 304 });
      return new Response(JSON.stringify(b), { status: 200, headers: { etag: b.etag, 'x-config-generation': String(b.generation) } });
    }) as unknown as typeof fetch;
    return { f, beats, pulls };
  }

  it('reverts to the previous config when the post-apply health check fails, reports it, and does not loop', async () => {
    let body: Body = { etag: '"g1"', generation: 1, config: cfgA };
    const cp = fakeCp(() => body);
    const applied: unknown[] = [];
    let healthy = true;
    const dp = new DataPlaneSync({
      config: { role: 'data', url: 'http://cp', token: 't', nodeId: 'dp-x', pullIntervalMs: 60_000 },
      apply: async (c) => void applied.push(c),
      healthCheck: async () => healthy,
      fetch: cp.f,
    });
    await dp.sync();
    expect(dp.status()).toMatchObject({ configEtag: '"g1"', generation: 1 });
    expect(cp.pulls[0]['x-node-id']).toBe('dp-x');

    body = { etag: '"g2"', generation: 2, config: cfgB };
    healthy = false;
    await dp.sync();
    expect(applied).toEqual([cfgA, cfgB, cfgA]); // applied g2, health check failed, re-applied g1
    expect(dp.status()).toMatchObject({ configEtag: '"g1"', generation: 1, failedGeneration: 2, rollbacks: 1 });
    expect(dp.status().lastError).toMatch(/generation 2 failed its health check.*rolled back to generation 1/);
    expect(cp.beats.at(-1)).toMatchObject({ nodeId: 'dp-x', configEtag: '"g1"', generation: 1, failedGeneration: 2 });

    healthy = true;
    await dp.sync(); // control plane still serves the bad g2 → not applied again
    expect(applied).toHaveLength(3);
    body = { etag: '"g3"', generation: 3, config: cfgC };
    await dp.sync();
    expect(applied.at(-1)).toEqual(cfgC);
    expect(dp.status()).toMatchObject({ configEtag: '"g3"', generation: 3 });
    expect(dp.status().failedGeneration).toBeUndefined();
  });

  it('an apply that throws reports the failed generation and keeps the running one', async () => {
    let body: Body = { etag: '"g1"', generation: 1, config: cfgA };
    const cp = fakeCp(() => body);
    const dp = new DataPlaneSync({
      config: { role: 'data', url: 'http://cp', token: 't', nodeId: 'dp-y', pullIntervalMs: 60_000 },
      apply: async (c) => {
        if ((c as typeof cfgB).rateLimit?.limit === 200) throw new Error('invalid: servers[0].url'); // pulled configs arrive as JSON
      },
      fetch: cp.f,
    });
    await dp.sync();
    body = { etag: '"g2"', generation: 2, config: cfgB };
    await dp.sync();
    expect(dp.status()).toMatchObject({ configEtag: '"g1"', generation: 1, failedGeneration: 2 });
    expect(cp.beats.at(-1)).toMatchObject({ generation: 1, failedGeneration: 2 });
    expect(cp.beats.at(-1).lastError).toContain('invalid: servers[0].url');
  });
});

describe('R8 HTTP integration', () => {
  const stops: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const s of stops.splice(0).reverse()) await s().catch(() => undefined);
  });

  async function dataPlane(url: string, nodeId: string) {
    const gw = new Gateway({
      port: 0,
      host: '127.0.0.1',
      logLevel: 'error',
      monitor: { requestLog: false },
      servers: [],
      controlPlane: { role: 'data', url, token: 'op', nodeId, pullIntervalMs: 60_000 },
    } as GatewayConfig);
    await gw.start();
    stops.push(() => gw.stop());
    return gw;
  }

  it('canary rollout over HTTP: per-node targets, rollout status, manual rollback', async () => {
    const cp = await startFeatureGw({
      controlPlane: { role: 'control', configApi: true, rollout: { strategy: 'canary', canary: { nodes: 1 }, bakeMs: 3_600_000 } },
    } as Partial<GatewayConfig>);
    stops.push(cp.stop);
    const a = await dataPlane(cp.base, 'dp-a');
    const b = await dataPlane(cp.base, 'dp-b');
    await a.dataPlane!.sync();
    await b.dataPlane!.sync();
    let ro = await cp.admin('cluster/rollout');
    expect(ro.status).toBe(200);
    expect(ro.body).toMatchObject({ generation: 1, converged: true });

    const cur = (await cp.admin('config')).body.config;
    expect((await cp.admin('config', { ...cur, rateLimit: { windowSeconds: 60, limit: 777 } }, 'PUT')).status).toBe(200);
    const r = await fetch(`${cp.base}/api/v1/admin/data-planes/config`, { headers: { ...op, 'x-node-id': 'dp-a' } });
    expect(r.headers.get('x-config-generation')).toBe('2');
    const rb = await fetch(`${cp.base}/api/v1/admin/data-planes/config`, { headers: { ...op, 'x-node-id': 'dp-b' } });
    expect(rb.headers.get('x-config-generation')).toBe('1');
    await a.dataPlane!.sync();
    await b.dataPlane!.sync();
    expect(a.dataPlane!.status().generation).toBe(2);
    expect(b.dataPlane!.status().generation).toBe(1);
    ro = await cp.admin('cluster/rollout');
    expect(ro.body).toMatchObject({ state: 'canary', generation: 2, canaryNodes: ['dp-a'], diverged: [] });

    const back = await cp.admin('cluster/rollback', { reason: 'canary looks wrong' }, 'POST');
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ generation: 3, rollbackOf: 2 });
    await a.dataPlane!.sync();
    expect(a.dataPlane!.status().generation).toBe(3);
    expect((await cp.admin('cluster/rollout')).body).toMatchObject({ state: 'rolled-back', generation: 3 });
  });

  it('rollout routes are operator-only and control-plane-only', async () => {
    const cp = await startFeatureGw({ controlPlane: { role: 'control' } } as Partial<GatewayConfig>);
    stops.push(cp.stop);
    expect((await cp.admin('cluster/rollout', undefined, 'GET', { authorization: 'Bearer nope' })).status).toBe(401);
    const all = await startFeatureGw({});
    stops.push(all.stop);
    expect((await all.admin('cluster/rollout')).status).toBe(409);
  });
});

describe('R9 config', () => {
  const base = { servers: [] };
  it('accepts controlPlane.rollout on a control plane with defaults', () => {
    const c = validateConfig({ ...base, version: 13, controlPlane: { role: 'control', rollout: { strategy: 'canary', canary: { percent: 10 } } } });
    expect(c.controlPlane!.rollout).toMatchObject({ strategy: 'canary', canary: { percent: 10 }, bakeMs: 30_000, failureThreshold: 1, autoRollback: true, maxDivergenceMs: 60_000, history: 10 });
  });
  it('rejects rollout on a data plane, a canary without a size, and bad values', () => {
    expect(() => validateConfig({ ...base, version: 13, controlPlane: { role: 'data', url: 'http://cp', token: 't', rollout: { strategy: 'all-at-once' } } })).toThrow(/rollout/);
    expect(() => validateConfig({ ...base, version: 13, controlPlane: { role: 'control', rollout: { strategy: 'canary' } } })).toThrow(/canary/);
    expect(() => validateConfig({ ...base, version: 13, controlPlane: { role: 'control', rollout: { history: 0 } } })).toThrow();
    expect(() => validateConfig({ ...base, version: 13, controlPlane: { role: 'control', rollout: { canary: { percent: 150 } } } })).toThrow();
  });
  it('schema/v12 JSON Schema: rollout is optional and described; v12 files without it stay valid (backward compatible)', () => {
    const schema = JSON.parse(readFileSync(new URL('../schema/v12/config.schema.json', import.meta.url), 'utf8'));
    const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
    expect(validate({ version: 12, controlPlane: { role: 'control' } })).toBe(true);
    expect(validate({ version: 12, controlPlane: { role: 'data', url: 'http://cp', token: 't' } })).toBe(true);
    expect(validate({ version: 12, controlPlane: { role: 'control', rollout: { strategy: 'canary', canary: { nodes: 2 }, bakeMs: 0 } } })).toBe(true);
    expect(validate({ version: 12, controlPlane: { role: 'control', rollout: { strategy: 'blue-green' } } })).toBe(false);
    expect(validate({ version: 12, controlPlane: { role: 'control', rollout: { bogus: 1 } } })).toBe(false);
  });
});
