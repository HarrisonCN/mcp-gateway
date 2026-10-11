/**
 * 14.1.0 集群协调 — multi-node HTTP tests: one control plane + three real data-plane gateways.
 *
 *  M1 canary over HTTP: only the canary pulls the new generation; promotion after bakeMs; the cluster converges
 *  M2 a generation that fails the data-plane post-apply health check (wired in the gateway: every upstream offline
 *     after the apply) is rolled back locally, reported, and the control plane rolls the cluster back automatically;
 *     the bad generation is refused until force-published (POST /admin/cluster/rollout { force: true })
 *  M3 divergence: a stopped data plane is reported diverged after maxDivergenceMs (rollout status, data-plane list, metrics)
 *  M4 cluster metrics on the control plane and on data planes
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Gateway } from '../src/gateway/index.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { startFeatureGw, op, type FeatureGw } from './helpers/feature-gw.js';

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s().catch(() => undefined);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function controlPlane(rollout: Record<string, unknown>): Promise<FeatureGw> {
  const cp = await startFeatureGw({ monitor: { requestLog: false, prometheus: true }, controlPlane: { role: 'control', configApi: true, rollout } } as Partial<GatewayConfig>);
  stops.push(cp.stop);
  return cp;
}

/** A data plane; pullIntervalMs 2000 → a 1 s post-apply health-check grace. Tests drive `sync()` themselves. */
async function dataPlane(url: string, nodeId: string) {
  const gw = new Gateway({
    port: 0,
    host: '127.0.0.1',
    logLevel: 'error',
    monitor: { requestLog: false },
    servers: [],
    controlPlane: { role: 'data', url, token: 'op', nodeId, pullIntervalMs: 2_000 },
  } as GatewayConfig);
  await gw.start();
  await gw.dataPlane!.stop(); // no background ticks: the test decides when each node syncs
  let stopped = false;
  const stop = async () => {
    if (!stopped) await gw.stop();
    stopped = true;
  };
  stops.push(stop);
  const base = `http://127.0.0.1:${gw.address()!.port}`;
  return { gw, base, stop, sync: () => gw.dataPlane!.sync(), gen: () => gw.dataPlane!.status().generation };
}

async function cluster(rollout: Record<string, unknown>) {
  const cp = await controlPlane(rollout);
  const nodes = [await dataPlane(cp.base, 'dp-a'), await dataPlane(cp.base, 'dp-b'), await dataPlane(cp.base, 'dp-c')];
  for (const n of nodes) await n.sync();
  return { cp, nodes };
}

/** Wait until every upstream of a data plane is online (the fake stdio server needs a moment to start). */
async function online(gw: Gateway, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const all = gw.registry.getAllServers();
    if (all.length > 0 && all.every((s) => gw.registry.getHealth(s.id)?.status === 'online')) return;
    if (Date.now() > until) throw new Error('upstreams did not come online');
    await sleep(100);
  }
}

const runningConfig = async (cp: FeatureGw) => (await cp.admin('config')).body.config as Record<string, unknown>;
const put = async (cp: FeatureGw, config: Record<string, unknown>) => {
  const r = await cp.admin('config', config, 'PUT');
  expect(r.status).toBe(200);
};
const metrics = async (base: string) => (await fetch(`${base}/api/v1/metrics?format=prometheus`, { headers: op })).text();

describe('14.1.0 multi-node cluster rollout (HTTP, 1 control plane + 3 data planes)', () => {
  it('M1 canary: only the canary gets the new generation, promotion after bakeMs, the cluster converges', async () => {
    const { cp, nodes } = await cluster({ strategy: 'canary', canary: { nodes: 1 }, bakeMs: 400 });
    expect(nodes.map((n) => n.gen())).toEqual([1, 1, 1]);
    expect((await cp.admin('cluster/rollout')).body).toMatchObject({ state: 'complete', generation: 1, converged: true });

    const cur = await runningConfig(cp);
    await put(cp, { ...cur, rateLimit: { windowSeconds: 60, limit: 4242 } });
    for (const n of nodes) await n.sync();
    expect(nodes.map((n) => n.gen())).toEqual([2, 1, 1]);
    let ro = (await cp.admin('cluster/rollout')).body;
    expect(ro).toMatchObject({ state: 'canary', generation: 2, stableGeneration: 1, canaryNodes: ['dp-a'], converged: true, diverged: [] });
    expect(ro.nodes.map((n: { target: number }) => n.target)).toEqual([2, 1, 1]);

    await sleep(500); // bake
    ro = (await cp.admin('cluster/rollout')).body;
    expect(ro).toMatchObject({ state: 'complete', generation: 2, canaryNodes: [] });
    expect(ro.converged).toBe(false); // dp-b / dp-c now target 2 and have not pulled yet
    for (const n of nodes) await n.sync();
    expect(nodes.map((n) => n.gen())).toEqual([2, 2, 2]);
    expect((await cp.admin('cluster/rollout')).body).toMatchObject({ state: 'complete', converged: true, diverged: [] });
    const list = (await cp.admin('data-planes')).body;
    expect(list.summary).toMatchObject({ total: 3, inSync: 3 });

    const m = await metrics(cp.base);
    expect(m).toContain('mcp_gateway_cluster_config_generation{role="control"} 2');
    expect(m).toContain('mcp_gateway_cluster_rollout_state{state="complete"} 1');
    expect(m).toContain('mcp_gateway_cluster_rollout_state{state="canary"} 0');
    expect(m).toContain('mcp_gateway_cluster_diverged_nodes 0');
    expect(m).not.toContain('role="data"'); // gateway-level metric sources are per instance (several gateways in one process)
    expect(await metrics(nodes[1].base)).toContain('mcp_gateway_cluster_config_generation{role="data"} 2');
  }, 30_000);

  it('M2 failed post-apply health check → local rollback + automatic cluster rollback; bad generation needs force', async () => {
    const { cp, nodes } = await cluster({ strategy: 'canary', canary: { nodes: 1 }, bakeMs: 3_600_000 });
    for (const n of nodes) await online(n.gw);
    const good = await runningConfig(cp);
    // generation 2 swaps the working upstream for one nobody listens on → every upstream offline after the apply
    const bad = { ...good, servers: [{ id: 'gone', name: 'gone', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp', timeoutMs: 500 }] };
    await put(cp, bad);
    await nodes[0].sync(); // the canary applies it, fails the health check, re-applies generation 1 and reports
    const a = nodes[0].gw.dataPlane!.status();
    expect(a).toMatchObject({ generation: 1, failedGeneration: 2, rollbacks: 1 });
    expect(a.lastError).toMatch(/generation 2 failed its health check after apply; rolled back to generation 1/);
    expect(nodes[0].gw.registry.getAllServers().map((s) => s.id)).toEqual(['fake']); // running the old config again

    let ro = (await cp.admin('cluster/rollout')).body;
    expect(ro).toMatchObject({ state: 'rolled-back', generation: 3, lastRollback: { from: 2, to: 3, restored: 1 } });
    expect(ro.lastRollback.reason).toMatch(/generation 2 failed on dp-a/);
    expect(ro.history.find((g: { generation: number }) => g.generation === 2)).toMatchObject({ bad: true });
    // non-canary nodes never left the good config; everyone converges on generation 3 (same content as 1)
    for (const n of nodes) await n.sync();
    expect(nodes.every((n) => n.gw.registry.getAllServers().map((s) => s.id).join() === 'fake')).toBe(true);
    ro = (await cp.admin('cluster/rollout')).body;
    expect(ro).toMatchObject({ converged: true, diverged: [] });
    // no re-apply loop on the canary: the same bad etag is not pulled again (the control plane no longer serves it)
    await nodes[0].sync();
    expect(nodes[0].gw.dataPlane!.status().rollbacks).toBe(1);

    // the rollback changed what is distributed, not the control plane's running config
    expect(((await runningConfig(cp)).servers as Array<{ id: string }>).map((s) => s.id)).toEqual(['gone']);
    // a good change becomes generation 4; re-submitting the bad content is refused (no new generation) without force
    await put(cp, { ...good, rateLimit: { windowSeconds: 60, limit: 31337 } });
    expect((await cp.admin('cluster/rollout')).body).toMatchObject({ generation: 4, state: 'canary' });
    await put(cp, bad);
    ro = (await cp.admin('cluster/rollout')).body;
    expect(ro.generation).toBe(4);
    expect(ro.refused).toMatchObject({ badGeneration: 2 });
    const pulled = await fetch(`${cp.base}/api/v1/admin/data-planes/config`, { headers: { ...op, 'x-node-id': 'dp-a' } });
    expect(pulled.headers.get('x-config-generation')).toBe('4');
    expect((await cp.admin('cluster/rollout', {}, 'POST')).status).toBe(400);
    const forced = await cp.admin('cluster/rollout', { force: true }, 'POST');
    expect(forced.status).toBe(200);
    expect(forced.body).toMatchObject({ generation: 5 });
    expect(forced.body.status.refused).toBeUndefined();

    const m = await metrics(cp.base);
    expect(m).toContain('mcp_gateway_cluster_rollbacks_total{role="control",trigger="automatic"} 1');
    expect(m).toContain('mcp_gateway_cluster_rollbacks_total{role="control",trigger="manual"} 0');
    expect(await metrics(nodes[0].base)).toContain('mcp_gateway_cluster_rollbacks_total{role="data",trigger="health_check"} 1');
  }, 40_000);

  it('M2b an upstream outage that predates the change does not block a new generation', async () => {
    const cp = await controlPlane({});
    const good = await runningConfig(cp);
    const down = { ...good, servers: [{ id: 'gone', name: 'gone', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp', timeoutMs: 500 }] };
    await put(cp, down);
    const dp = await dataPlane(cp.base, 'dp-a'); // the first config it gets has its only upstream down
    await dp.sync();
    const first = dp.gen()!;
    await put(cp, { ...down, rateLimit: { windowSeconds: 60, limit: 99 } });
    await dp.sync(); // upstreams were already offline → healthy
    expect(dp.gw.dataPlane!.status()).toMatchObject({ generation: first + 1, rollbacks: 0 });
    expect(dp.gw.dataPlane!.status().failedGeneration).toBeUndefined();
  }, 30_000);

  it('M3 divergence: a data plane that stops pulling is reported after maxDivergenceMs', async () => {
    const { cp, nodes } = await cluster({ maxDivergenceMs: 1_000 });
    await nodes[2].stop();
    const cur = await runningConfig(cp);
    await put(cp, { ...cur, rateLimit: { windowSeconds: 60, limit: 555 } });
    await nodes[0].sync();
    await nodes[1].sync();
    let ro = (await cp.admin('cluster/rollout')).body;
    expect(ro).toMatchObject({ generation: 2, converged: false, diverged: [] }); // off target, but not for long yet
    await sleep(1_200);
    ro = (await cp.admin('cluster/rollout')).body;
    expect(ro.diverged).toEqual(['dp-c']);
    expect(ro.nodes.find((n: { nodeId: string }) => n.nodeId === 'dp-c')).toMatchObject({ generation: 1, target: 2, inSync: false, diverged: true });
    const list = (await cp.admin('data-planes')).body;
    expect(list.dataPlanes.find((n: { nodeId: string }) => n.nodeId === 'dp-c')).toMatchObject({ inSync: false });
    expect(list.summary).toMatchObject({ total: 3, inSync: 2 });
    expect(await metrics(cp.base)).toContain('mcp_gateway_cluster_diverged_nodes 1');
    // forgetting the node (DELETE) clears it from the rollout as well
    expect((await cp.admin('data-planes/dp-c', undefined, 'DELETE')).status).toBe(200);
    expect((await cp.admin('cluster/rollout')).body).toMatchObject({ converged: true, diverged: [] });
  }, 30_000);
});
