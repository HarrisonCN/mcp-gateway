import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { Gateway } from '../src/gateway/index.js';
import { LoadBalancer, expandReplicas } from '../src/gateway/balancer.js';
import { classifyFailure, ToolInvoker } from '../src/gateway/invoker.js';
import { markTransportFailure } from '../src/proxy/index.js';
import { MetricsCollector } from '../src/monitor/index.js';
import { loadConfig } from '../src/config/loader.js';
import type { McpServerConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));

const base = (extra: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: 'svc',
  name: 'Svc',
  transport: 'streamable-http',
  url: 'http://a/mcp',
  replicas: [{ url: 'http://b/mcp' }, { url: 'http://c/mcp', weight: 3 }],
  ...extra,
});

function lb(servers: McpServerConfig[], opts: { down?: string[]; degraded?: string[]; now?: () => number; random?: () => number } = {}) {
  return new LoadBalancer({
    servers: () => servers,
    isConnected: (id) => !(opts.down ?? []).includes(id),
    healthStatus: (id) => ((opts.degraded ?? []).includes(id) ? 'degraded' : 'online'),
    now: opts.now,
    random: opts.random,
  });
}

describe('expandReplicas', () => {
  it('adds internal replica servers that inherit the primary', () => {
    const out = expandReplicas([base({ tags: ['t'], loadBalancing: { strategy: 'failover' } }), { id: 'x', name: 'X', transport: 'stdio', command: 'x' }]);
    expect(out.map((s) => s.id)).toEqual(['svc', 'svc~1', 'svc~2', 'x']);
    expect(out[1]).toMatchObject({ url: 'http://b/mcp', replicaOf: 'svc', name: 'Svc (replica 1)', tags: ['t'], transport: 'streamable-http' });
    expect(out[1]!.replicas).toBeUndefined();
    expect(out[1]!.loadBalancing).toBeUndefined();
    expect(out[2]!.weight).toBe(3);
  });
});

describe('LoadBalancer', () => {
  it('round-robin over healthy members, unhealthy ones last', () => {
    const servers = expandReplicas([base()]);
    const b = lb(servers, { down: ['svc~1'] });
    expect(b.members('svc')).toEqual(['svc', 'svc~1', 'svc~2']);
    expect(b.order('svc')).toEqual(['svc', 'svc~2', 'svc~1']);
    expect(b.order('svc')).toEqual(['svc~2', 'svc', 'svc~1']);
    expect(b.order('other')).toEqual(['other']);
    expect(b.anyConnected('svc')).toBe(true);
    expect(b.groups()).toEqual(['svc']);
    // nobody healthy → everyone, in config order
    expect(lb(servers, { down: ['svc', 'svc~1', 'svc~2'] }).order('svc')).toEqual(['svc', 'svc~1', 'svc~2']);
  });

  it('failover, weighted and random strategies (least-latency removed in 4.0)', () => {
    const mk = (strategy: 'failover' | 'weighted' | 'random', o = {}) => lb(expandReplicas([base({ loadBalancing: { strategy } })]), o);
    expect(mk('failover', { degraded: ['svc'] }).order('svc')).toEqual(['svc~1', 'svc~2', 'svc']);
    // weights 1,1,3 → cumulative 0.2, 0.4, 1.0
    expect(mk('weighted', { random: () => 0.1 }).order('svc')[0]).toBe('svc');
    expect(mk('weighted', { random: () => 0.3 }).order('svc')[0]).toBe('svc~1');
    expect(mk('weighted', { random: () => 0.9 }).order('svc')[0]).toBe('svc~2');
    expect(mk('random', { random: () => 0 }).order('svc')).toHaveLength(3);
  });

  it('ejects a member after consecutive failures and brings it back', () => {
    let t = 1000;
    const b = lb(expandReplicas([base({ loadBalancing: { strategy: 'failover', ejectAfter: 2, ejectMs: 500 } })]), { now: () => t });
    b.report('svc', 'svc', 'not-connected', 0);
    expect(b.isHealthy('svc')).toBe(true);
    b.report('svc', 'svc', 'timeout', 0);
    expect(b.isHealthy('svc')).toBe(false);
    expect(b.order('svc')[0]).toBe('svc~1');
    const snap = b.snapshot()[0]!;
    expect(snap).toMatchObject({ server: 'svc', strategy: 'failover', failoverOn: ['not-connected'] });
    expect(snap.members[0]).toMatchObject({ id: 'svc', healthy: false, calls: 2, errors: 2 });
    expect(snap.members[0]!.ejectedUntil).toBeDefined();
    t += 600;
    expect(b.isHealthy('svc')).toBe(true);
    expect(b.settings('svc').retries).toBe(2);
    b.prune();
  });

  it('classifies upstream failures', () => {
    expect(classifyFailure({ success: true, durationMs: 1 })).toBeUndefined();
    // 13.3.0: only failures the gateway produced (marked by the proxy) are transport failures
    expect(classifyFailure(markTransportFailure({ success: false, durationMs: 1, error: { code: -32000, message: '' } }, 'not-connected'))).toBe('not-connected');
    expect(classifyFailure(markTransportFailure({ success: false, durationMs: 1, error: { code: -32001, message: '' } }, 'timeout'))).toBe('timeout');
    expect(classifyFailure({ success: false, durationMs: 1, error: { code: -32000, message: 'upstream says server error' } })).toBe('error');
    expect(classifyFailure({ success: false, durationMs: 1, error: { code: -1, message: '' } })).toBe('error');
  });

  it('validates replicas in config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgw-lb-'));
    const file = join(dir, 'gw.yml');
    writeFileSync(file, 'servers:\n  - id: a\n    name: A\n    transport: streamable-http\n    url: http://a/mcp\n    replicas:\n      - url: http://b/mcp\n    loadBalancing: { strategy: weighted, failoverOn: [not-connected, timeout] }\n');
    expect((await loadConfig(file)).servers[0]!.replicas).toHaveLength(1);
    writeFileSync(file, 'servers:\n  - id: a~1\n    name: A\n    transport: stdio\n    command: x\n');
    await expect(loadConfig(file)).rejects.toThrow(/reserved/);
    writeFileSync(file, 'servers:\n  - id: a\n    name: A\n    transport: stdio\n    command: x\n    replicas:\n      - transport: websocket\n');
    await expect(loadConfig(file)).rejects.toThrow(/replicas\.0\.url/);
  });
});

describe('ToolInvoker failover', () => {
  function invoker(responses: Record<string, () => unknown>, failoverOn?: Array<'not-connected' | 'timeout' | 'error'>) {
    const servers = expandReplicas([base({ loadBalancing: { strategy: 'failover', failoverOn } })]);
    const calls: string[] = [];
    const proxy = {
      callTool: async (id: string) => {
        calls.push(id);
        const r = responses[id]!();
        if (r instanceof Error) throw r;
        return r;
      },
    };
    const inv = new ToolInvoker({ proxy: proxy as never, metrics: new MetricsCollector(), requestLog: () => false, balancer: lb(servers) });
    const run = () => inv.invoke({ serverId: 'svc', name: 'echo', kind: 'tool', method: 'tools/call', params: {}, via: 'rest', principal: { kind: 'system', id: 'system:test' } });
    return { run, calls };
  }
  const ok = () => ({ success: true, durationMs: 1, result: 'ok' });
  const down = () => markTransportFailure({ success: false, durationMs: 0, error: { code: -32000, message: 'down' } }, 'not-connected');
  const slow = () => markTransportFailure({ success: false, durationMs: 9, error: { code: -32001, message: 'timeout' } }, 'timeout');

  it('retries the next member on not-connected, not on timeouts by default', async () => {
    const a = invoker({ svc: down, 'svc~1': ok, 'svc~2': ok });
    expect((await a.run()).result).toBe('ok');
    expect(a.calls).toEqual(['svc', 'svc~1']);
    const b = invoker({ svc: slow, 'svc~1': ok, 'svc~2': ok });
    expect((await b.run()).success).toBe(false);
    expect(b.calls).toEqual(['svc']);
    const c = invoker({ svc: slow, 'svc~1': () => new Error('boom'), 'svc~2': ok }, ['timeout', 'error']);
    expect((await c.run()).result).toBe('ok');
    expect(c.calls).toEqual(['svc', 'svc~1', 'svc~2']);
    const d = invoker({ svc: down, 'svc~1': down, 'svc~2': () => new Error('last') }, ['not-connected', 'error']);
    await expect(d.run()).rejects.toThrow('last');
  });
});

describe('load balancing in the gateway', () => {
  let gw: Gateway | undefined;
  afterEach(async () => {
    await gw?.stop();
    gw = undefined;
  });

  const call = (url: string, args: Record<string, unknown> = {}) =>
    fetch(`${url}/api/v1/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'echo', arguments: args }) }).then(async (r) => ({
      status: r.status,
      text: JSON.stringify(await r.json()),
    }));

  async function start(server: McpServerConfig) {
    gw = new Gateway({ port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false }, servers: [server] });
    await gw.start();
    return `http://127.0.0.1:${gw.address()!.port}`;
  }

  it('spreads calls round-robin and exposes the logical server only', async () => {
    const url = await start({
      id: 'svc', name: 'Svc', transport: 'stdio', command: process.execPath, args: [fixture], env: { SERVER_TAG: 'a' }, timeout: 5000,
      replicas: [{ env: { SERVER_TAG: 'b' } }],
    });
    const a = await call(url);
    const b = await call(url);
    expect([a.text.includes('\\"_server\\":\\"a\\"'), b.text.includes('\\"_server\\":\\"b\\"')]).toEqual([true, true]);
    const tools = (await (await fetch(`${url}/api/v1/tools`)).json()) as { tools: Array<{ serverId: string }> };
    expect(tools.tools.map((t) => t.serverId)).toEqual(['svc']);
    const lbInfo = (await (await fetch(`${url}/api/v1/load-balancing`)).json()) as { groups: Array<{ members: Array<{ id: string; calls: number }> }> };
    expect(lbInfo.groups[0]!.members.map((m) => [m.id, m.calls])).toEqual([['svc', 1], ['svc~1', 1]]);
  });

  it('fails over when the primary is down (tools come from the replica)', async () => {
    const url = await start({
      id: 'svc', name: 'Svc', transport: 'stdio', command: process.execPath, args: [fixture], env: { FAIL_INIT: '1' }, timeout: 5000,
      reconnect: { enabled: false },
      replicas: [{ env: { SERVER_TAG: 'b' } }],
      loadBalancing: { strategy: 'failover' },
    });
    for (let i = 0; i < 3; i++) {
      const r = await call(url, { i });
      expect(r.status).toBe(200);
      expect(r.text).toContain('\\"_server\\":\\"b\\"');
    }
    const tools = (await (await fetch(`${url}/api/v1/tools`)).json()) as { tools: Array<{ name: string; serverId: string }> };
    expect(tools.tools).toMatchObject([{ name: 'echo', serverId: 'svc' }]);
  });
});
