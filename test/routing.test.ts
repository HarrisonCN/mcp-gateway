/** 3.4: smart routing — traffic splits (canary / A-B) and the `smart` load-balancing strategy. */
import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { SmartRouter, stableFraction } from '../src/gateway/routing.js';
import { LoadBalancer } from '../src/gateway/balancer.js';
import { Gateway } from '../src/gateway/index.js';
import { validateConfig } from '../src/config/loader.js';
import type { McpServerConfig, RoutingConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));

const routing = (over: Partial<RoutingConfig['splits'] extends (infer T)[] | undefined ? T : never> = {}): RoutingConfig => ({
  splits: [
    {
      name: 'search-canary',
      server: 'search',
      variants: [
        { server: 'search', weight: 90, label: 'stable' },
        { server: 'search-v2', weight: 10, label: 'canary', guard: { maxErrorRate: 0.2, minCalls: 10 } },
      ],
      ...over,
    },
  ],
});

describe('SmartRouter', () => {
  it('splits traffic by weight, sticky per client by default', () => {
    const r = new SmartRouter(() => routing());
    expect(r.route('other', 'x', 'c')).toBeUndefined();
    const counts: Record<string, number> = {};
    for (let i = 0; i < 2000; i++) {
      const d = r.route('search', 'q', `client-${i}`)!;
      counts[d.variant] = (counts[d.variant] ?? 0) + 1;
    }
    expect(counts.canary! / 2000).toBeGreaterThan(0.06);
    expect(counts.canary! / 2000).toBeLessThan(0.14);
    // Sticky: the same client always lands on the same variant.
    const first = r.route('search', 'q', 'alice')!.variant;
    for (let i = 0; i < 20; i++) expect(r.route('search', 'q', 'alice')!.variant).toBe(first);
    expect(stableFraction('a')).toBe(stableFraction('a'));
  });

  it('per-call random split, tool globs, and disabled splits', () => {
    let x = 0.95;
    const r = new SmartRouter(() => routing({ sticky: 'none', tools: ['brave_*'] }), { random: () => x });
    expect(r.route('search', 'other_tool', 'c')).toBeUndefined();
    expect(r.route('search', 'brave_web_search', 'c')!.server).toBe('search-v2');
    x = 0.1;
    expect(r.route('search', 'brave_web_search', 'c')!.server).toBe('search');
    const off = new SmartRouter(() => routing({ enabled: false }));
    expect(off.route('search', 'q', 'c')).toBeUndefined();
  });

  it('rolls a guarded canary back on its error rate, and reset clears it', () => {
    const r = new SmartRouter(() => routing({ sticky: 'none' }), { random: () => 0.99 });
    const d = r.route('search', 'q')!;
    expect(d.variant).toBe('canary');
    for (let i = 0; i < 9; i++) r.report(d, i % 2 === 0, 50);
    expect(r.snapshot()[0]!.variants[1]!.rolledBack).toBeUndefined();
    r.report(d, false, 50);
    const snap = r.snapshot()[0]!.variants[1]!;
    expect(snap.rolledBack?.reason).toMatch(/error rate/);
    expect(snap.effectiveWeight).toBe(0);
    expect(r.route('search', 'q')!.variant).toBe('stable');
    expect(r.reset('search-canary')).toBe(true);
    expect(r.route('search', 'q')!.variant).toBe('canary');
  });

  it('rolls back on latency, and skips disconnected variants', () => {
    const r = new SmartRouter(
      () => ({ splits: [{ name: 's', server: 'a', sticky: 'none', variants: [{ server: 'a', weight: 1 }, { server: 'b', weight: 1, guard: { maxLatencyMs: 100, minCalls: 2 } }] }] }),
      { random: () => 0.9, isConnected: (id) => id !== 'c' },
    );
    const d = r.route('a', 't')!;
    expect(d.server).toBe('b');
    r.report(d, true, 500);
    r.report(d, true, 500);
    expect(r.snapshot()[0]!.variants[1]!.rolledBack?.reason).toMatch(/latency/);
    const r2 = new SmartRouter(() => ({ splits: [{ name: 's', server: 'a', sticky: 'none', variants: [{ server: 'a', weight: 1 }, { server: 'c', weight: 9 }] }] }), { random: () => 0.9, isConnected: (id) => id !== 'c' });
    expect(r2.route('a', 't')!.server).toBe('a');
  });

  it('validates routing config', () => {
    const servers = [{ id: 'search', name: 's', transport: 'stdio', command: 'x' }, { id: 'search-v2', name: 's2', transport: 'stdio', command: 'x' }];
    expect(() => validateConfig({ servers, routing: routing() })).not.toThrow();
    expect(() => validateConfig({ servers: servers.slice(0, 1), routing: routing() })).toThrow(/unknown server "search-v2"/);
    expect(() => validateConfig({ servers, routing: { splits: [{ name: 'x', server: 'search', variants: [{ server: 'search', weight: 0 }] }] } })).toThrow(/weight > 0/);
    expect(() => validateConfig({ servers, routing: { splits: [routing().splits![0]!, routing().splits![0]!] } })).toThrow(/duplicate split/);
  });
});

describe('smart load balancing', () => {
  const svc: McpServerConfig = {
    id: 'svc', name: 'Svc', transport: 'streamable-http', url: 'http://a/mcp', cost: 10,
    replicas: [{ url: 'http://b/mcp', cost: 1 }, { url: 'http://c/mcp', cost: 1 }],
    loadBalancing: { strategy: 'smart', score: { latency: 1, errorRate: 2, cost: 1 } },
  };
  it('orders members by latency, error rate and cost', async () => {
    const { expandReplicas } = await import('../src/gateway/balancer.js');
    const servers = expandReplicas([svc]);
    const lb = new LoadBalancer({ servers: () => servers, isConnected: () => true, healthStatus: () => 'online' });
    lb.report('svc', 'svc', undefined, 50);
    lb.report('svc~1', 'svc', undefined, 50);
    lb.report('svc~2', 'svc', undefined, 50);
    // Equal latency: the cheap members come first.
    expect(lb.order('svc')[2]).toBe('svc');
    // Errors push svc~1 behind svc~2.
    lb.report('svc~1', 'svc', 'error', 0);
    expect(lb.order('svc').slice(0, 1)).toEqual(['svc~2']);
    const snap = lb.snapshot()[0]!;
    expect(snap.strategy).toBe('smart');
    expect(snap.members.every((m) => typeof m.score === 'number')).toBe(true);
  });
});

describe('traffic split end to end', () => {
  let gw: Gateway | undefined;
  afterEach(async () => {
    await gw?.stop();
    gw = undefined;
  });

  it('routes the split share to the canary server and reports it on GET /routing', async () => {
    const srv = (id: string): McpServerConfig => ({ id, name: id, transport: 'stdio', command: process.execPath, args: [fixture], env: { SERVER_TAG: id } });
    gw = new Gateway({
      port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false },
      servers: [srv('stable'), srv('canary')],
      routing: { splits: [{ name: 'c', server: 'stable', sticky: 'none', variants: [{ server: 'stable', weight: 0 }, { server: 'canary', weight: 1, label: 'next' }] }] },
    });
    await gw.start();
    const api = `http://127.0.0.1:${gw.address()!.port}/api/v1`;
    const r = (await (await fetch(`${api}/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ server: 'stable', tool: 'echo', arguments: { a: 1 } }) })).json()) as any;
    expect(JSON.parse(r.result.content[0].text)._server).toBe('canary');
    const snap = (await (await fetch(`${api}/routing`)).json()) as any;
    expect(snap.splits[0].variants[1]).toMatchObject({ label: 'next', calls: 1, errors: 0 });
    const reset = (await (await fetch(`${api}/routing/splits/c/reset`, { method: 'POST' })).json()) as any;
    expect(reset.split.variants[1].calls).toBe(0);
    expect((await fetch(`${api}/routing/splits/nope/reset`, { method: 'POST' })).status).toBe(404);
  });
});
