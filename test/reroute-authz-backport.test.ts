/** 12.0.1: backport of the 13.1 fix MGW-2026-001 — final authorization against the final target after a reroute. */
import { describe, it, expect, afterEach } from 'vitest';
import { ToolInvoker, type InvokeContext } from '../src/gateway/invoker.js';
import { MetricsCollector } from '../src/monitor/index.js';
import { registerCallHook } from '../src/gateway/hooks.js';
import { clientPrincipal, ERR_FORBIDDEN } from '../src/auth/authorizer.js';
import { ComplianceEngine } from '../src/policy/compliance.js';
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

describe('P0-1: final authorization after a reroute (12.0.1, backport of 13.1)', () => {
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

