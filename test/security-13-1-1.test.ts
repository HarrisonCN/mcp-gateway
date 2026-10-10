/**
 * 13.1.1 hardening of two 13.1.0 rough edges plus a cache key fix:
 *  - fail-closed is scoped: a failed `closed` module refuses only the calls it would have governed;
 *  - servers prepared by a hot reload stay hidden (not listed, not routable) until the commit;
 *  - tool / semantic cache keys include the routing-split target, and a split target is authorized before any lookup.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ToolInvoker, ERR_MODULE_UNAVAILABLE, type InvokeContext } from '../src/gateway/invoker.js';
import { MetricsCollector } from '../src/monitor/index.js';
import { registerCallHook, callHookPlan, closedFor } from '../src/gateway/hooks.js';
import { failureScopeOf } from '../src/gateway/failure-scope.js';
import { clientPrincipal, ERR_FORBIDDEN, type Principal } from '../src/auth/authorizer.js';
import { ToolCache } from '../src/gateway/cache.js';
import { ServerRegistry } from '../src/registry/index.js';
import { ERR_NOT_CONNECTED } from '../src/proxy/index.js';
import { semanticStore } from '../src/features/semantic-cache.js';
import '../src/features/semantic-cache.js';
import { startFeatureGw, fakeServer, type FeatureGw } from './helpers/feature-gw.js';
import type { GatewayConfig, ProxyResponse } from '../src/utils/types.js';

type Cfg = GatewayConfig & { __reroute1311?: string };

registerCallHook({
  id: 'test-reroute-1311',
  before: (call, cfg) => {
    const to = (cfg as Cfg).__reroute1311;
    if (to && call.serverId !== to) return { serverId: to };
  },
});

interface SetupOpts {
  cfg?: Record<string, unknown>;
  failures?: Record<string, string>;
  router?: unknown;
  cache?: ToolCache;
  staged?: (id: string) => boolean;
  tenant?: string;
}

function setup(opts: SetupOpts = {}) {
  const sent: string[] = [];
  let n = 0;
  const proxy = {
    callTool: async (target: string, tool: string): Promise<ProxyResponse> => {
      sent.push(`${target}/${tool}`);
      n++;
      return { success: true, durationMs: 1, result: { content: [{ type: 'text', text: `${target}#${n}` }] } };
    },
    request: async () => ({ success: true, durationMs: 1, result: {} }),
  };
  const cfg = { servers: [], ...opts.cfg } as unknown as Cfg;
  const inv = new ToolInvoker({
    proxy: proxy as never,
    metrics: new MetricsCollector(),
    requestLog: () => false,
    config: () => cfg,
    router: opts.router as never,
    cache: opts.cache,
    staged: opts.staged,
    serverConfig: (id) => ({ id, name: id, transport: 'stdio', command: 'x' }) as never,
    tenantsOf: () => [opts.tenant ?? 't1'],
    moduleFailure: (id) => opts.failures?.[id],
  });
  return { inv, sent, cfg };
}

const call = (serverId: string, over: Partial<InvokeContext> & { scope?: string[]; principal?: Principal } = {}): InvokeContext => {
  const { scope, ...rest } = over;
  return {
    serverId,
    name: 'echo',
    kind: 'tool',
    method: 'tools/call',
    params: { q: 'hello world' },
    via: 'rest',
    clientId: 'key:alice',
    principal: clientPrincipal(over.clientId ?? 'key:alice', scope ? { servers: scope } : undefined),
    ...rest,
  };
};
const text = (r: { result?: unknown }) => (r.result as { content: { text: string }[] }).content[0]!.text;

describe('scoped fail-closed (13.1.1)', () => {
  it('a failed DLP module scoped to server A refuses calls to A only; calls to B succeed', async () => {
    const { inv, sent } = setup({ cfg: { dlp: { servers: ['a'] } }, failures: { dlp: 'init: boom' } });
    const ra = await inv.invoke(call('a'));
    expect(ra.success).toBe(false);
    expect(ra.error?.code).toBe(ERR_MODULE_UNAVAILABLE);
    expect(ra.error?.data).toMatchObject({ decision: 'module-failed', failurePolicy: 'closed', modules: ['dlp'] });
    const rb = await inv.invoke(call('b'));
    expect(rb.success).toBe(true);
    expect(sent).toEqual(['b/echo']);
    expect(inv.moduleFailureDenials).toBe(1);
  });

  it('a module with a global scope (no restriction) still refuses every call', async () => {
    const { inv, sent } = setup({ cfg: { dlp: {} }, failures: { dlp: 'init: boom' } });
    for (const s of ['a', 'b']) expect((await inv.invoke(call(s))).error?.code).toBe(ERR_MODULE_UNAVAILABLE);
    expect(sent).toEqual([]);
  });

  it('an unparseable module config is treated as global (safe default)', async () => {
    for (const dlp of [{ servers: 'a' }, { servers: [1] }, { servers: [] }, 'oops']) {
      const { inv, sent } = setup({ cfg: { dlp }, failures: { dlp: 'reconfigure: invalid config' } });
      expect((await inv.invoke(call('b'))).error?.code, JSON.stringify(dlp)).toBe(ERR_MODULE_UNAVAILABLE);
      expect(sent).toEqual([]);
    }
    expect(failureScopeOf('policy-engine', { servers: [], policyEngine: { cedar: 'permit(principal, action, resource);' } } as never)).toBeUndefined();
    expect(failureScopeOf('some-plugin', { servers: [] } as never)).toBeUndefined();
  });

  it('a reroute into the failed module’s scope is refused by the final authorization', async () => {
    const { inv, sent } = setup({ cfg: { dlp: { servers: ['a'] }, __reroute1311: 'a' }, failures: { dlp: 'init: boom' } });
    const r = await inv.invoke(call('b'));
    expect(r.error?.code).toBe(ERR_MODULE_UNAVAILABLE);
    expect(r.error?.data).toMatchObject({ decision: 'reroute-denied', reason: 'module-failed', from: 'b', to: 'a', modules: ['dlp'] });
    expect(sent).toEqual([]);
  });

  it('scopes of the other closed modules follow their own config', async () => {
    const cases: { id: string; key: string; section: unknown; inScope: InvokeContext; outOfScope: InvokeContext }[] = [
      { id: 'sanitize', key: 'sanitize', section: { servers: ['web-*'] }, inScope: call('web-1'), outOfScope: call('db') },
      { id: 'sanitize', key: 'sanitize', section: { exempt: ['internal/*'] }, inScope: call('web'), outOfScope: call('internal') },
      { id: 'multimodal', key: 'multimodal', section: { servers: ['img'] }, inScope: call('img'), outOfScope: call('db') },
      { id: 'confidential', key: 'confidential', section: { servers: [{ match: 'vault*', measurements: ['ab'.repeat(16)], trustedKeys: ['k'] }] }, inScope: call('vault-1'), outOfScope: call('web') },
      { id: 'approval-flows', key: 'approvalFlows', section: { flows: [{ id: 'f', tools: ['pay/*'], steps: [{ name: 's', approvers: ['x'] }] }] }, inScope: call('pay'), outOfScope: call('web') },
      { id: 'approval-flows', key: 'approvalFlows', section: { flows: [{ id: 'f', tools: ['*'], clients: ['key:bob'], steps: [{ name: 's', approvers: ['x'] }] }] }, inScope: call('web', { clientId: 'key:bob' }), outOfScope: call('web') },
      { id: 'privacy', key: 'privacy', section: { protect: ['hr/*'] }, inScope: call('hr'), outOfScope: call('web') },
      { id: 'realtime-budgets', key: 'realtimeBudgets', section: { budgets: [{ name: 'b', metric: 'cost', limit: 1, tools: ['llm/*'] }] }, inScope: call('llm'), outOfScope: call('web') },
      { id: 'console', key: 'console', section: { plans: { p: { servers: ['*'] } }, orgs: { t1: { plan: 'p' } } }, inScope: call('web'), outOfScope: call('web', { clientId: 'key:solo' }) },
      { id: 'anomaly', key: 'anomaly', section: { exempt: ['key:ops-*'] }, inScope: call('web'), outOfScope: call('web', { clientId: 'key:ops-1' }) },
      {
        id: 'agent-identity',
        key: 'agentIdentity',
        section: { signingKey: 'x'.repeat(32), requireAgentFor: ['deploy/*'] },
        inScope: call('web', { principal: { ...clientPrincipal('key:alice'), delegation: [{ agent: 'bot', tools: ['*'] }] } as Principal }),
        outOfScope: call('web'),
      },
    ];
    for (const c of cases) {
      const tenantOf = (x: InvokeContext) => (x.clientId === 'key:solo' ? 'solo' : 't1');
      const failing = { [c.id]: 'init: boom' };
      const a = setup({ cfg: { [c.key]: c.section }, failures: failing, tenant: tenantOf(c.inScope) });
      expect((await a.inv.invoke(c.inScope)).error?.code, `${c.id} in scope`).toBe(ERR_MODULE_UNAVAILABLE);
      const b = setup({ cfg: { [c.key]: c.section }, failures: failing, tenant: tenantOf(c.outOfScope) });
      const r = await b.inv.invoke(c.outOfScope);
      expect(r.success, `${c.id} out of scope: ${JSON.stringify(r.error)}`).toBe(true);
    }
  });

  it('the plan keeps every failed closed module; closedFor() picks the ones governing a call', () => {
    const cfg = { servers: [], dlp: { servers: ['a'] }, privacy: { protect: ['*'] } } as unknown as GatewayConfig;
    const plan = callHookPlan(cfg, (id) => (id === 'dlp' || id === 'privacy' ? 'boom' : undefined));
    expect(plan.closed.map((m) => m.id).sort()).toEqual(['dlp', 'privacy']);
    expect(plan.closed.find((m) => m.id === 'dlp')?.scope?.describe).toBe('servers: a');
    expect(plan.closed.find((m) => m.id === 'privacy')?.scope).toBeUndefined(); // "*" = global
    expect(closedFor(plan, { serverId: 'b', tool: 't' }).map((m) => m.id)).toEqual(['privacy']);
  });
});

describe('cache keys include the routing-split target (13.1.1)', () => {
  const caller = (id: string, scope?: string[]) => call('s', { clientId: id, principal: clientPrincipal(id, scope ? { servers: scope } : undefined) });

  it('tool cache: split targets never share entries, and a target the caller may not use is refused before the lookup', async () => {
    const router = { route: (_s: string, _t: string, client?: string) => ({ server: client === 'key:b-user' ? 'b' : 'a', split: 'ab', variant: client === 'key:b-user' ? 'b' : 'a' }), report: () => {} };
    const cache = new ToolCache(() => ({ rules: [{ tools: ['echo'], ttlSeconds: 60, scope: 'shared' }] }) as never);
    const { inv, sent } = setup({ router, cache });
    const first = await inv.invoke(caller('key:a-user'));
    expect(text(first)).toBe('a#1');
    // another caller routed to b gets b's answer, not a's cached one
    const second = await inv.invoke(caller('key:b-user'));
    expect(text(second)).toBe('b#2');
    // a caller allowed on s but not on a: routed to a → refused, never served a's cached result
    const denied = await inv.invoke(caller('key:a-limited', ['s']));
    expect(denied.success).toBe(false);
    expect(denied.error?.code).toBe(ERR_FORBIDDEN);
    expect(denied.error?.data).toMatchObject({ decision: 'reroute-denied', to: 'a', reroutedBy: ['routing:ab'] });
    // same target → shared entry
    expect(text(await inv.invoke(caller('key:a-other')))).toBe('a#1');
    expect(sent).toEqual(['a/echo', 'b/echo']);
  });

  it('semantic cache: entries are partitioned by the routed target', async () => {
    semanticStore.clear?.();
    const router = { route: (_s: string, _t: string, client?: string) => ({ server: client === 'key:b-user' ? 'b' : 'a', split: 'ab', variant: 'v' }), report: () => {} };
    const { inv, sent } = setup({ router, cfg: { semanticCache: { tools: ['s/echo'], scope: 'global', threshold: 0.9 } } });
    expect(text(await inv.invoke(caller('key:a-user')))).toBe('a#1');
    expect(text(await inv.invoke(caller('key:b-user')))).toBe('b#2');
    expect(text(await inv.invoke(caller('key:a-user2')))).toBe('a#1');
    expect(sent).toEqual(['a/echo', 'b/echo']);
  });
});

describe('servers prepared by a hot reload stay hidden until commit (13.1.1)', () => {
  it('registry: staged servers are not listed, not exposed and not found until commitStaged()', () => {
    const r = new ServerRegistry();
    const events: string[] = [];
    r.on('registered', (c) => events.push(`registered:${c.id}`));
    r.on('tools-updated', (id) => events.push(`tools:${id}`));
    r.register({ id: 'new', name: 'new', transport: 'stdio', command: 'x' } as never, { staged: true });
    r.setTools('new', [{ name: 'echo', serverId: 'new', serverName: 'new' } as never]);
    r.setCatalog('new', { resources: [{ uri: 'x://1', name: 'r', serverId: 'new' } as never], resourceTemplates: [], prompts: [] });
    expect(r.isStaged('new')).toBe(true);
    expect(r.getServer('new')).toBeUndefined();
    expect(r.getServer('new', { includeStaged: true })?.id).toBe('new');
    expect(r.getAllServers()).toEqual([]);
    expect(r.getAllTools()).toEqual([]);
    expect(r.findTool('echo')).toBeUndefined();
    expect(r.getAllResources()).toEqual([]);
    expect(r.isToolExposed('new', 'echo')).toBe(false);
    expect(events).toEqual([]);
    r.commitStaged(['new']);
    expect(r.getAllTools().map((t) => t.name)).toEqual(['echo']);
    expect(r.getAllResources()).toHaveLength(1);
    expect(events).toEqual(['registered:new', 'tools:new']);
  });

  it('invoker: a routing split or rollout that points at a staged server is never sent', async () => {
    const router = { route: () => ({ server: 'new', split: 'x', variant: 'v' }), report: () => {} };
    const { inv, sent } = setup({ router, staged: (id) => id === 'new' });
    const r = await inv.invoke(call('s'));
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe(ERR_NOT_CONNECTED);
    expect(r.error?.data).toMatchObject({ reason: 'not-committed' });
    expect(sent).toEqual([]);
  });

  let h: FeatureGw | undefined;
  afterEach(async () => {
    await h?.stop();
    h = undefined;
  });

  type Gw = { reload: (c: GatewayConfig) => Promise<void>; config: GatewayConfig; featureRouter: { reconcile: (p: GatewayConfig) => Promise<string[]> }; proxy: { isConnected: (id: string) => boolean }; registry: ServerRegistry };
  const callOn = (server: string) =>
    fetch(`${h!.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json' }, body: JSON.stringify({ server, tool: 'echo', arguments: { x: 1 } }) }).then((r) => r.status);
  const listed = async () => {
    const r = await fetch(`${h!.base}/api/v1/tools`, { headers: { authorization: 'Bearer op' } });
    return JSON.stringify(await r.json());
  };
  const gate = (gw: Gw, fail?: string) => {
    let open!: () => void;
    let reached!: () => void;
    const atCommit = new Promise<void>((r) => (reached = r));
    const released = new Promise<void>((r) => (open = r));
    const orig = gw.featureRouter.reconcile.bind(gw.featureRouter);
    gw.featureRouter.reconcile = async (p) => {
      reached();
      await released;
      if (fail) throw new Error(fail);
      return orig(p);
    };
    return { atCommit, open: () => open() };
  };

  it('a new server is connected but not listed or callable mid-reload, and works after the commit', async () => {
    h = await startFeatureGw({ servers: [fakeServer('fake')] } as never);
    const gw = h.gw as unknown as Gw;
    const g = gate(gw);
    const reload = gw.reload({ ...gw.config, servers: [fakeServer('fake'), fakeServer('c')] } as GatewayConfig);
    await g.atCommit;
    expect(gw.proxy.isConnected('c')).toBe(true);
    expect(gw.registry.isStaged('c')).toBe(true);
    expect(await callOn('c')).toBe(404);
    expect(await listed()).not.toContain('"serverId":"c"');
    g.open();
    await reload;
    expect(gw.registry.isStaged('c')).toBe(false);
    expect(await callOn('c')).toBe(200);
    expect(await listed()).toContain('"serverId":"c"');
  }, 30_000);

  it('after a failed reload the prepared server was never visible and is disposed', async () => {
    h = await startFeatureGw({ servers: [fakeServer('fake')] } as never);
    const gw = h.gw as unknown as Gw;
    const g = gate(gw, 'commit exploded');
    const reload = gw.reload({ ...gw.config, servers: [fakeServer('fake'), fakeServer('c')] } as GatewayConfig);
    await g.atCommit;
    expect(await callOn('c')).toBe(404);
    g.open();
    await expect(reload).rejects.toThrow(/commit exploded/);
    expect(gw.proxy.isConnected('c')).toBe(false);
    expect(gw.registry.getServer('c', { includeStaged: true })).toBeUndefined();
    expect(await callOn('c')).toBe(404);
    expect(await listed()).not.toContain('"serverId":"c"');
    expect(await callOn('fake')).toBe(200);
  }, 30_000);
});
