/**
 * 13.1 security fixes:
 *  - P0-1 mandatory final authorization against the FINAL target after a hook / routing split reroutes a call;
 *  - P0-2 per-module failure policies (security modules fail closed, analytics open, presentation degrade);
 *  - P1-1 module runtime failures are per gateway, not per process.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ToolInvoker, ERR_MODULE_UNAVAILABLE, type InvokeContext } from '../src/gateway/invoker.js';
import { MetricsCollector } from '../src/monitor/index.js';
import { registerCallHook, callHookPlan } from '../src/gateway/hooks.js';
import { clientPrincipal, ERR_FORBIDDEN } from '../src/auth/authorizer.js';
import { ComplianceEngine } from '../src/policy/compliance.js';
import { createFeatureRouter } from '../src/gateway/features.js';
import { failurePolicyOf, FEATURE_MANIFEST } from '../src/features/manifest.js';
import { validateConfig } from '../src/config/loader.js';
import { startFeatureGw, fakeServer, type FeatureGw } from './helpers/feature-gw.js';
import { rolloutManager } from '../src/features/rollouts.js';
import '../src/features/agent-identity.js';
import type { GatewayConfig, ProxyResponse } from '../src/utils/types.js';

type Cfg = GatewayConfig & { __reroute?: string; __guard131?: boolean };

// Test hooks (unknown ids: always active, ordered after every manifest hook).
registerCallHook({
  id: 'test-reroute-131',
  before: (call, cfg) => {
    const to = (cfg as Cfg).__reroute;
    if (to && call.serverId !== to) return { serverId: to };
  },
});
registerCallHook({ id: 'test-blocking-131', before: () => undefined });

function setup(opts: { cfg?: Partial<Cfg>; failures?: Record<string, string>; exposed?: (s: string, t: string) => boolean; compliance?: ComplianceEngine; router?: unknown; policy?: unknown; region?: Record<string, string> } = {}) {
  const sent: string[] = [];
  const proxy = {
    callTool: async (target: string, tool: string): Promise<ProxyResponse> => {
      sent.push(`${target}/${tool}`);
      return { success: true, durationMs: 1, result: { content: [{ type: 'text', text: target }] } };
    },
    request: async () => ({ success: true, durationMs: 1, result: {} }),
  };
  const cfg = { servers: [], ...opts.cfg } as Cfg;
  const metrics = new MetricsCollector();
  const inv = new ToolInvoker({
    proxy: proxy as never,
    metrics,
    requestLog: () => false,
    config: () => cfg,
    exposed: opts.exposed,
    compliance: opts.compliance,
    router: opts.router as never,
    policy: () => opts.policy as never,
    serverConfig: (id) => ({ id, name: id, transport: 'stdio', command: 'x', ...(opts.region?.[id] ? { region: opts.region[id] } : {}) }) as never,
    tenantsOf: () => ['t1'],
    moduleFailure: (id) => opts.failures?.[id],
  });
  return { inv, sent, metrics, cfg };
}

const ctx = (servers: string[] | undefined, over: Partial<InvokeContext> = {}): InvokeContext => ({
  serverId: 'stable',
  name: 'echo',
  kind: 'tool',
  method: 'tools/call',
  params: { a: 1 },
  via: 'rest',
  clientId: 'key:alice',
  principal: clientPrincipal('key:alice', servers ? { servers } : undefined),
  ...over,
});

describe('P0-1: final authorization after a reroute (13.1)', () => {
  it('client allowed on stable, denied on canary, rollout-style hook reroutes → denied, upstream never contacted, audited', async () => {
    const { inv, sent, metrics } = setup({ cfg: { __reroute: 'canary' } });
    const r = await inv.invoke(ctx(['stable']));
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe(ERR_FORBIDDEN);
    expect(r.error?.data).toMatchObject({ decision: 'reroute-denied', reason: 'scope', from: 'stable', to: 'canary', reroutedBy: ['test-reroute-131'] });
    expect(r.error?.message).toMatch(/Rerouted call refused/);
    expect(sent).toEqual([]);
    expect(inv.rerouteDenials).toBe(1);
    // audit trail: the refusal is a recorded request (history / audit store / SIEM)
    expect(metrics.getRecent(5)[0]).toMatchObject({ success: false, serverId: 'canary' });
  });

  it('a client allowed on both reaches the canary', async () => {
    const { inv, sent } = setup({ cfg: { __reroute: 'canary' } });
    const r = await inv.invoke(ctx(['stable', 'canary']));
    expect(r.success).toBe(true);
    expect(sent).toEqual(['canary/echo']);
    expect(inv.rerouteDenials).toBe(0);
  });

  it('tool exposure of the final target is enforced', async () => {
    const { inv, sent } = setup({ cfg: { __reroute: 'canary' }, exposed: (s) => s !== 'canary' });
    const r = await inv.invoke(ctx(undefined));
    expect(r.error?.data).toMatchObject({ decision: 'reroute-denied', reason: 'not-exposed' });
    expect(sent).toEqual([]);
  });

  it('tool policy rules are evaluated for the final target', async () => {
    const { inv, sent } = setup({ cfg: { __reroute: 'canary' }, policy: { rules: [{ name: 'no-canary', effect: 'deny', servers: ['canary'] }] } });
    const r = await inv.invoke(ctx(undefined));
    expect(r.error?.data).toMatchObject({ decision: 'reroute-denied', reason: 'deny', rule: 'no-canary' });
    expect(sent).toEqual([]);
  });

  it('data residency is evaluated for the final target', async () => {
    const compliance = new ComplianceEngine(() => ({ residency: { rules: [{ tenants: ['t1'], regions: ['eu-*'] }] } }) as never);
    const { inv, sent } = setup({ cfg: { __reroute: 'canary' }, compliance, region: { stable: 'eu-west-1', canary: 'us-east-1' } });
    const r = await inv.invoke(ctx(undefined));
    expect(r.error?.data).toMatchObject({ decision: 'reroute-denied', reason: 'residency', region: 'us-east-1' });
    expect(sent).toEqual([]);
  });

  it('security guard hooks that saw the old target run again for the final target (agent identity)', async () => {
    const agentIdentity = { signingKey: 'k'.repeat(40), requireAgentFor: ['canary/*'] };
    const { inv, sent } = setup({ cfg: { __reroute: 'canary', agentIdentity } as never });
    const r = await inv.invoke(ctx(undefined));
    expect(r.error?.data).toMatchObject({ decision: 'reroute-denied', reason: 'agent-identity', from: 'stable', to: 'canary' });
    expect(sent).toEqual([]);
    // without the reroute the same call is fine
    const ok = await setup({ cfg: { agentIdentity } as never }).inv.invoke(ctx(undefined));
    expect(ok.success).toBe(true);
  });

  it('a routing split that moves the call is authorized too', async () => {
    const reports: boolean[] = [];
    const router = { route: () => ({ server: 'canary', split: 's1', variant: 'b' }), report: (_r: unknown, ok: boolean) => reports.push(ok) };
    const { inv, sent } = setup({ router });
    const r = await inv.invoke(ctx(['stable']));
    expect(r.success).toBe(false);
    expect(r.error?.data).toMatchObject({ decision: 'reroute-denied', to: 'canary', reroutedBy: ['routing:s1'] });
    expect(sent).toEqual([]);
    expect(reports).toEqual([false]);
    const both = setup({ router });
    expect((await both.inv.invoke(ctx(['stable', 'canary']))).success).toBe(true);
    expect(both.sent).toEqual(['canary/echo']);
  });

  it('the upstream send refuses a target that differs from the frozen authorized one', async () => {
    const { inv, sent } = setup();
    const send = (inv as unknown as { send: (c: InvokeContext, t: string) => Promise<ProxyResponse> }).send.bind(inv);
    const unauthorized = await send(ctx(undefined), 'stable');
    expect(unauthorized.error?.data).toMatchObject({ reason: 'target-changed-after-authorization' });
    const frozen = Object.freeze({ serverId: 'stable', name: 'echo', kind: 'tool' as const, principal: 'key:alice' });
    expect(Object.isFrozen(frozen)).toBe(true);
    const moved = await send(ctx(undefined, { serverId: 'canary', authorizedTarget: frozen }), 'canary');
    expect(moved.error?.code).toBe(ERR_FORBIDDEN);
    expect(sent).toEqual([]);
    expect((await send(ctx(undefined, { authorizedTarget: frozen }), 'stable')).success).toBe(true);
  });
});

describe('P0-2: failure policies (13.1)', () => {
  it('every hook module declares a failure policy; security modules are closed and not configurable', () => {
    for (const e of FEATURE_MANIFEST.filter((x) => x.hook)) expect(e.failurePolicy, e.id).toBeDefined();
    for (const id of ['dlp', 'agent-identity', 'confidential', 'policy-engine', 'privacy', 'sanitize', 'approval-flows']) {
      expect(failurePolicyOf(id)).toBe('closed');
      expect(failurePolicyOf(id, { servers: [], kernel: { failurePolicy: { [id]: 'open' } } } as GatewayConfig)).toBe('closed');
    }
    expect(failurePolicyOf('genai-otel')).toBe('open');
    expect(failurePolicyOf('time-travel')).toBe('open');
    expect(failurePolicyOf('self-healing')).toBe('degrade');
    expect(failurePolicyOf('realtime-budgets')).toBe('closed');
    expect(failurePolicyOf('console')).toBe('closed');
    // unknown modules with a request-blocking hook default to closed
    expect(failurePolicyOf('some-plugin-module')).toBe('closed');
    expect(failurePolicyOf('some-plugin-module', undefined, false)).toBe('open');
    expect(() => validateConfig({ version: 11, servers: [], kernel: { failurePolicy: { dlp: 'open' } } })).toThrow(/failure policy of "dlp" is fixed/);
    expect(() => validateConfig({ version: 11, servers: [], kernel: { failurePolicy: { nope: 'open' } } })).toThrow(/unknown module "nope"/);
    expect(() => validateConfig({ version: 11, servers: [], kernel: { failurePolicy: { 'realtime-budgets': 'open', billing: 'closed' } } })).not.toThrow();
  });

  it('closed: a failed DLP module refuses the calls (clear code, audited); other modules keep working', async () => {
    const { inv, sent, metrics } = setup({ cfg: { dlp: {} } as never, failures: { dlp: 'init: boom' } });
    const r = await inv.invoke(ctx(undefined));
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe(ERR_MODULE_UNAVAILABLE);
    expect(r.error?.data).toMatchObject({ decision: 'module-failed', failurePolicy: 'closed', modules: ['dlp'] });
    expect(sent).toEqual([]);
    expect(inv.moduleFailureDenials).toBe(1);
    expect(metrics.getRecent(1)[0]).toMatchObject({ success: false });
    // the same invoker still serves calls once the module is healthy / not configured
    expect((await setup({ cfg: { dlp: {} } as never }).inv.invoke(ctx(undefined))).success).toBe(true);
  });

  it('closed: a security module that failed to load (its hook never registered) still refuses', async () => {
    const plan = callHookPlan({ servers: [], confidential: { servers: [] } } as never, (id) => (id === 'confidential' ? 'load: missing' : undefined));
    expect(plan.closed.map((m) => m.id)).toEqual(['confidential']);
    const { inv, sent } = setup({ cfg: { policyEngine: {} } as never, failures: { 'policy-engine': 'load: SyntaxError' } });
    const r = await inv.invoke(ctx(undefined));
    expect(r.error?.code).toBe(ERR_MODULE_UNAVAILABLE);
    expect(sent).toEqual([]);
  });

  it('closed by default: an unknown module with a request-blocking hook', async () => {
    const { inv, sent } = setup({ failures: { 'test-blocking-131': 'crashed' } });
    const r = await inv.invoke(ctx(undefined));
    expect(r.error?.data).toMatchObject({ modules: ['test-blocking-131'] });
    expect(sent).toEqual([]);
  });

  it('open: a failed analytics module is skipped and the call goes through', async () => {
    const { inv, sent } = setup({ cfg: { genaiTelemetry: {} } as never, failures: { 'genai-otel': 'init: boom' } });
    const r = await inv.invoke(ctx(undefined));
    expect(r.success).toBe(true);
    expect(sent).toEqual(['stable/echo']);
    expect((r.result as { _meta?: unknown })._meta).toBeUndefined();
  });

  it('degrade: the call goes through and the result is marked degraded', async () => {
    const { inv, sent } = setup({ cfg: { selfHealing: { rules: [] } } as never, failures: { 'self-healing': 'reconfigure: boom' } });
    const r = await inv.invoke(ctx(undefined));
    expect(r.success).toBe(true);
    expect(sent).toEqual(['stable/echo']);
    expect((r.result as { _meta: Record<string, unknown> })._meta['mcp-gateway/degraded']).toEqual({ modules: ['self-healing'] });
    expect(inv.degradedCalls).toBe(1);
  });

  it('configurable: realtime budgets are closed by default, kernel.failurePolicy may open them', async () => {
    const closed = setup({ cfg: { realtimeBudgets: { budgets: [] } } as never, failures: { 'realtime-budgets': 'boom' } });
    expect((await closed.inv.invoke(ctx(undefined))).error?.code).toBe(ERR_MODULE_UNAVAILABLE);
    const open = setup({ cfg: { realtimeBudgets: { budgets: [] }, kernel: { failurePolicy: { 'realtime-budgets': 'open' } } } as never, failures: { 'realtime-budgets': 'boom' } });
    expect((await open.inv.invoke(ctx(undefined))).success).toBe(true);
  });
});

describe('P1-1: module failures are per gateway (13.1)', () => {
  it('a module failure in kernel A does not affect kernel B in the same process', async () => {
    const cfg = { servers: [], dlp: {} } as unknown as GatewayConfig;
    let fail = true;
    const make = () =>
      createFeatureRouter({
        authenticate: (_q, _s, n) => n(),
        isOperator: () => true,
        context: { config: () => cfg, tools: () => [], invoke: async () => ({ success: true, durationMs: 0 }), recent: () => [], baseUrl: () => undefined },
        features: [{ id: 'dlp', since: '5.6.0', summary: 'x', mount: () => {}, init: () => { if (fail) throw new Error('boom'); } }],
      });
    const a = make();
    await a.activate();
    fail = false;
    const b = make();
    await b.activate();
    expect(a.failureOf('dlp')).toMatch(/init: boom/);
    expect(b.failureOf('dlp')).toBeUndefined();
    expect(a.modules().find((m) => m.id === 'dlp')).toMatchObject({ state: 'failed', failurePolicy: 'closed' });
    expect(b.modules().find((m) => m.id === 'dlp')).toMatchObject({ state: 'active' });
    registerCallHook({ id: 'dlp', before: () => undefined });
    expect(callHookPlan(cfg, a.failureOf).closed.map((m) => m.id)).toEqual(['dlp']);
    expect(callHookPlan(cfg, b.failureOf).closed).toEqual([]);
    await a.dispose();
    expect(a.failureOf('dlp')).toBeUndefined();
    await b.dispose();
  });
});

let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

describe('P0-1 on a real gateway (rollouts)', () => {
  it('a key scoped to the stable server is refused when the rollout picks the canary', async () => {
    rolloutManager.states.clear();
    h = await startFeatureGw({
      servers: [fakeServer('fake'), fakeServer('v2', { SERVER_TAG: 'v2' })],
      auth: { strategy: 'api-key', apiKeys: ['op', { key: 'beta-key', name: 'beta-1', servers: ['fake'] }, { key: 'beta-both', name: 'beta-2', servers: ['fake', 'v2'] }] },
      rollouts: [{ id: 'fake-v2', stable: 'fake', canary: 'v2', percent: 0, clients: ['key:beta-*'] }],
    } as never);
    const call = async (key: string) => {
      const r = await fetch(`${h!.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: { a: 1 } }) });
      return { status: r.status, text: JSON.stringify(await r.json()) };
    };
    const denied = await call('beta-key');
    expect(denied.status).toBe(403);
    expect(denied.text).toContain('reroute-denied');
    expect(denied.text).not.toContain('\\"_server\\":\\"v2\\"');
    const allowed = await call('beta-both');
    expect(allowed.status).toBe(200);
    expect(allowed.text).toContain('\\"_server\\":\\"v2\\"');
    const prom = await fetch(`${h.base}/metrics`, { headers: { authorization: 'Bearer op' } });
    if (prom.status === 200) expect(await prom.text()).toMatch(/mcp_gateway_reroute_denials_total 1/);
  });
});

describe('P1-2: hot reload is Prepare → Validate → Commit (13.1)', () => {
  type ReloadGw = { reload: (c: GatewayConfig) => Promise<void>; catalog: { prepare: () => Promise<unknown>; commit: (e: unknown) => void }; config: GatewayConfig; rollbacks: number; proxy: { isConnected: (id: string) => boolean }; plugins: { set: (p: unknown) => Promise<void> } };
  const callOn = (server: string) =>
    fetch(`${h!.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json' }, body: JSON.stringify({ server, tool: 'echo', arguments: { x: 1 } }) }).then((r) => r.status);

  it('a catalog failure after a server was removed leaves the old server connected and serving', async () => {
    h = await startFeatureGw({ servers: [fakeServer('fake'), fakeServer('b')] } as never);
    const gw = h.gw as unknown as ReloadGw;
    expect(gw.proxy.isConnected('b')).toBe(true);
    const before = gw.config;
    gw.catalog.prepare = () => Promise.reject(new Error('catalog backend down'));
    const next = { ...before, servers: [fakeServer('fake'), fakeServer('c')], catalog: { serversFile: 'x.json' } } as unknown as GatewayConfig;
    await expect(gw.reload(next)).rejects.toThrow(/catalog backend down/);
    expect(gw.config).toBe(before);
    expect(gw.rollbacks).toBe(1);
    expect(gw.proxy.isConnected('b')).toBe(true);
    expect(await callOn('b')).toBe(200);
    // nothing prepared is left behind
    expect(gw.proxy.isConnected('c')).toBe(false);
  }, 30_000);

  it('a failure during commit restores the config, disposes new servers and keeps removed ones serving', async () => {
    h = await startFeatureGw({ servers: [fakeServer('fake'), fakeServer('b')] } as never);
    const gw = h.gw as unknown as ReloadGw;
    const before = gw.config;
    const prepared = await gw.catalog.prepare();
    gw.catalog.prepare = async () => prepared;
    gw.catalog.commit = () => {
      throw new Error('commit exploded');
    };
    const next = { ...before, servers: [fakeServer('fake'), fakeServer('c')], catalog: { builtins: false } } as unknown as GatewayConfig;
    await expect(gw.reload(next)).rejects.toThrow(/commit exploded/);
    expect(gw.config).toBe(before);
    expect(gw.proxy.isConnected('b')).toBe(true);
    expect(gw.proxy.isConnected('c')).toBe(false);
    expect(await callOn('b')).toBe(200);
  }, 30_000);

  it('a successful reload disconnects removed servers only after the commit', async () => {
    h = await startFeatureGw({ servers: [fakeServer('fake'), fakeServer('b')] } as never);
    const gw = h.gw as unknown as ReloadGw;
    const next = { ...gw.config, servers: [fakeServer('fake'), fakeServer('c')] } as unknown as GatewayConfig;
    await gw.reload(next);
    expect(gw.proxy.isConnected('b')).toBe(false);
    expect(gw.proxy.isConnected('c')).toBe(true);
    expect(await callOn('c')).toBe(200);
    expect(await callOn('b')).not.toBe(200);
  }, 30_000);
});
