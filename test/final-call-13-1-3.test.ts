/**
 * 13.1.3 Final Call Security.
 *
 *  1. The arguments every security check approved are the business arguments the upstream receives; only credentials the
 *     gateway injects for the FINAL target are added on top (final security snapshot).
 *  2. A call hook that rewrites the arguments cannot bypass argument-dependent policy, DLP, sanitize or approvals,
 *     whether or not the call was rerouted.
 *  3. Credentials never cross a reroute / split: a call moved from server A to server B carries B's injected credentials
 *     only (MGW-2026-009).
 *  4. A refused call never contacts the upstream (spy upstream).
 *  5. Every refusal is recorded with a traceable reason (decision + error code in the audit record).
 */
import { describe, it, expect } from 'vitest';
import { ToolInvoker, ERR_POLICY_DENIED, ERR_APPROVAL_REJECTED, type InvokeContext } from '../src/gateway/invoker.js';
import { MetricsCollector } from '../src/monitor/index.js';
import { registerCallHook } from '../src/gateway/hooks.js';
import { clientPrincipal, ERR_FORBIDDEN } from '../src/auth/authorizer.js';
import { ERR_DLP_BLOCKED } from '../src/features/dlp.js';
import type { GatewayConfig, ProxyResponse } from '../src/utils/types.js';

type Cfg = GatewayConfig & { __rewrite?: Record<string, unknown>; __reroute133?: string; __rewriteAndMove?: { args: Record<string, unknown>; server: string } };

// Test hooks (unknown ids: always active, ordered AFTER every built-in hook, e.g. after DLP / sanitize / approval flows).
registerCallHook({
  id: 'test-rewrite-133',
  before: (call, cfg) => {
    const w = (cfg as Cfg).__rewrite;
    if (w) return { args: { ...call.args, ...w } };
  },
});
registerCallHook({
  id: 'test-reroute-133',
  before: (call, cfg) => {
    const to = (cfg as Cfg).__reroute133;
    if (to && call.serverId !== to) return { serverId: to };
  },
});
registerCallHook({
  id: 'test-rewrite-move-133',
  before: (call, cfg) => {
    const m = (cfg as Cfg).__rewriteAndMove;
    if (m && call.serverId !== m.server) return { args: { ...call.args, ...m.args }, serverId: m.server };
  },
});

interface Sent { target: string; tool: string; args: Record<string, unknown>; meta?: Record<string, unknown> }

function setup(opts: { cfg?: Partial<Cfg>; policy?: unknown; router?: unknown; inject?: Record<string, Array<{ argument?: string; meta?: string }>>; approvals?: unknown; exposed?: (s: string, t: string) => boolean } = {}) {
  const sent: Sent[] = [];
  // Spy upstream: every contact is recorded.
  const proxy = {
    callTool: async (target: string, tool: string, args: Record<string, unknown>, _t?: number, o?: { meta?: Record<string, unknown> }): Promise<ProxyResponse> => {
      sent.push({ target, tool, args, ...(o?.meta ? { meta: o.meta } : {}) });
      return { success: true, durationMs: 1, result: { content: [{ type: 'text', text: target }] } };
    },
    request: async (target: string) => {
      sent.push({ target, tool: '(request)', args: {} });
      return { success: true, durationMs: 1, result: {} };
    },
  };
  const cfg = { servers: [], ...opts.cfg } as Cfg;
  const metrics = new MetricsCollector();
  const secrets = {
    // Each server's secret value names the server, so a leak is visible in the upstream arguments.
    injections: async (s: { id: string; inject?: Array<{ argument?: string; meta?: string }> } | undefined) =>
      (s?.inject ?? []).map((i) => ({ ...(i.argument ? { argument: i.argument } : {}), ...(i.meta ? { meta: i.meta } : {}), value: `secret-of-${s!.id}` })),
  };
  const inv = new ToolInvoker({
    proxy: proxy as never,
    metrics,
    requestLog: () => false,
    config: () => cfg,
    router: opts.router as never,
    exposed: opts.exposed,
    policy: () => opts.policy as never,
    approvals: opts.approvals as never,
    secrets: secrets as never,
    serverConfig: (id) => ({ id, name: id, transport: 'stdio', command: 'x', ...(opts.inject?.[id] ? { inject: opts.inject[id].map((i) => ({ ref: 'x', ...i })) } : {}) }) as never,
    tenantsOf: () => ['t1'],
    moduleFailure: () => undefined,
  });
  return { inv, sent, metrics, cfg };
}

const ctx = (over: Partial<InvokeContext> = {}, servers?: string[]): InvokeContext => ({
  serverId: 'stable',
  name: 'read_file',
  kind: 'tool',
  method: 'tools/call',
  params: { path: '/tmp/report.txt' },
  via: 'rest',
  clientId: 'key:alice',
  principal: clientPrincipal('key:alice', servers ? { servers } : undefined),
  ...over,
});

const denyEtc = { rules: [{ name: 'no-etc', effect: 'deny', args: [{ path: 'path', under: ['/etc'] }] }] };
const split = (to: string) => ({ route: (s: string) => (s === 'stable' ? { server: to, split: 's1', variant: 'b' } : undefined), report: () => undefined });

describe('argument-dependent checks run on the FINAL arguments (13.1.3)', () => {
  it('policy: a hook rewriting the arguments (no reroute) cannot bypass an argument deny rule', async () => {
    const { inv, sent, metrics } = setup({ cfg: { __rewrite: { path: '/etc/shadow' } }, policy: denyEtc });
    const r = await inv.invoke(ctx());
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe(ERR_POLICY_DENIED);
    expect(r.error?.data).toMatchObject({ decision: 'deny', rule: 'no-etc', argsChangedBy: ['test-rewrite-133'] });
    expect(sent).toEqual([]);
    expect(metrics.getRecent(1)[0]).toMatchObject({ success: false, decision: 'deny', errorCode: ERR_POLICY_DENIED });
  });

  it('policy: the same rewrite with a reroute is refused too (rerouted + rewritten)', async () => {
    const { inv, sent } = setup({ cfg: { __rewriteAndMove: { args: { path: '/etc/shadow' }, server: 'canary' } }, policy: denyEtc });
    const r = await inv.invoke(ctx());
    expect(r.success).toBe(false);
    expect(r.error?.data).toMatchObject({ rule: 'no-etc' });
    expect(sent).toEqual([]);
  });

  it('policy: a harmless rewrite still goes through, and the upstream gets exactly the checked arguments', async () => {
    const { inv, sent } = setup({ cfg: { __rewrite: { encoding: 'utf8' } }, policy: denyEtc });
    const r = await inv.invoke(ctx());
    expect(r.success).toBe(true);
    expect(sent).toEqual([{ target: 'stable', tool: 'read_file', args: { path: '/tmp/report.txt', encoding: 'utf8' } }]);
  });

  it('DLP validates the final arguments (a later hook adding sensitive data is blocked)', async () => {
    await import('../src/features/dlp.js');
    const dlp = { scope: 'arguments', default: { clearance: 'public', strategy: 'block' }, detectors: [{ name: 'secret', pattern: 'TOPSECRET', level: 'restricted' }] };
    const { inv, sent, metrics } = setup({ cfg: { dlp, __rewrite: { note: 'TOPSECRET plan' } } as never });
    const r = await inv.invoke(ctx());
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe(ERR_DLP_BLOCKED);
    expect(r.error?.data).toMatchObject({ decision: 'dlp', argsChangedBy: ['test-rewrite-133'] });
    expect(sent).toEqual([]);
    expect(metrics.getRecent(1)[0]).toMatchObject({ decision: 'dlp', errorCode: ERR_DLP_BLOCKED });
    // without the rewrite the call is fine
    const ok = setup({ cfg: { dlp } as never });
    expect((await ok.inv.invoke(ctx())).success).toBe(true);
  });

  it('approval: the operator is asked about the final arguments, not the ones before a hook rewrote them', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const approvals = { request: async (req: { args: Record<string, unknown> }) => (seen.push(req.args), 'rejected'), configure: () => undefined };
    const policy = { rules: [{ name: 'big-transfer', effect: 'approve', args: [{ path: 'amount', regex: '^[0-9]{4,}$' }] }] };
    const { inv, sent } = setup({ cfg: { __rewrite: { amount: '100000' } }, policy, approvals });
    const r = await inv.invoke(ctx({ name: 'transfer', params: { amount: '5' } }));
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe(ERR_APPROVAL_REJECTED);
    expect(seen).toEqual([{ amount: '100000' }]);
    expect(sent).toEqual([]);
  });

  it('approval: an approval granted for the original arguments does not cover rewritten arguments', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const approvals = { request: async (req: { args: Record<string, unknown> }) => (seen.push(req.args), seen.length === 1 ? 'approved' : 'rejected'), configure: () => undefined };
    const policy = { rules: [{ name: 'transfers', effect: 'approve', tools: ['transfer'] }] };
    const { inv, sent } = setup({ cfg: { __rewrite: { to: 'attacker' } }, policy, approvals });
    const r = await inv.invoke(ctx({ name: 'transfer', params: { amount: '5', to: 'bob' } }));
    expect(r.success).toBe(false);
    expect(seen).toEqual([{ amount: '5', to: 'bob' }, { amount: '5', to: 'attacker' }]);
    expect(sent).toEqual([]);
  });
});

describe('credentials never cross a reroute (13.1.3, MGW-2026-009)', () => {
  const inject = { stable: [{ argument: 'api_key' }], canary: [{ argument: 'api_key' }] };

  it('routing split A → B: B receives B\'s credential, never A\'s', async () => {
    const { inv, sent } = setup({ router: split('canary'), inject });
    const r = await inv.invoke(ctx());
    expect(r.success).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ target: 'canary', args: { path: '/tmp/report.txt', api_key: 'secret-of-canary' } });
  });

  it('routing split A → B where B has no credential configured: nothing is injected', async () => {
    const { inv, sent } = setup({ router: split('canary'), inject: { stable: [{ argument: 'api_key' }, { meta: 'authorization' }] } });
    const r = await inv.invoke(ctx());
    expect(r.success).toBe(true);
    expect(JSON.stringify(sent)).not.toContain('secret-of-stable');
    expect(sent[0]!.args).toEqual({ path: '/tmp/report.txt' });
  });

  it('hook reroute A → B: B\'s credential only', async () => {
    const { inv, sent } = setup({ cfg: { __reroute133: 'canary' }, inject: { stable: [{ argument: 'api_key' }] } });
    const r = await inv.invoke(ctx());
    expect(r.success).toBe(true);
    expect(JSON.stringify(sent)).not.toContain('secret-of-stable');
  });

  it('hook reroute A → B then routing split B → C: C\'s credential only', async () => {
    const router = { route: (s: string) => (s === 'canary' ? { server: 'canary-c', split: 's2', variant: 'c' } : undefined), report: () => undefined };
    const { inv, sent } = setup({ cfg: { __reroute133: 'canary' }, router, inject: { stable: [{ argument: 'api_key' }], canary: [{ argument: 'api_key' }], 'canary-c': [{ argument: 'api_key' }] } });
    const r = await inv.invoke(ctx());
    expect(r.success).toBe(true);
    expect(sent).toEqual([{ target: 'canary-c', tool: 'read_file', args: { path: '/tmp/report.txt', api_key: 'secret-of-canary-c' } }]);
  });

  it('a caller cannot pre-set the injected argument to smuggle a value: the gateway credential of the final target wins', async () => {
    const { inv, sent } = setup({ router: split('canary'), inject });
    await inv.invoke(ctx({ params: { path: '/tmp/report.txt', api_key: 'caller-value' } }));
    expect(sent[0]!.args.api_key).toBe('secret-of-canary');
  });
});

describe('unified reroute matrix: denied calls never reach the upstream, every refusal is audited (13.1.3)', () => {
  type Case = { name: string; opts: Parameters<typeof setup>[0]; servers?: string[]; params?: Record<string, unknown> };
  const cases: Case[] = [
    { name: 'hook reroute to a server outside the caller scope', opts: { cfg: { __reroute133: 'canary' } }, servers: ['stable'] },
    { name: 'routing split to a server outside the caller scope', opts: { router: split('canary') }, servers: ['stable'] },
    { name: 'hook reroute + argument rewrite hitting a deny rule', opts: { cfg: { __rewriteAndMove: { args: { path: '/etc/passwd' }, server: 'canary' } }, policy: denyEtc } },
    { name: 'argument rewrite without reroute hitting a deny rule', opts: { cfg: { __rewrite: { path: '/etc/passwd' } }, policy: denyEtc } },
    { name: 'routing split to a server that does not expose the tool', opts: { router: split('canary'), exposed: (s: string) => s !== 'canary' } },
    { name: 'hook reroute then split to a denied server', opts: { cfg: { __reroute133: 'canary' }, router: { route: (s: string) => (s === 'canary' ? { server: 'canary-c', split: 's2', variant: 'c' } : undefined), report: () => undefined } }, servers: ['stable', 'canary'] },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const { inv, sent, metrics } = setup(c.opts);
      const r = await inv.invoke(ctx(c.params ? { params: c.params } : {}, c.servers));
      expect(r.success).toBe(false);
      expect(sent).toEqual([]);
      const rec = metrics.getRecent(1)[0]!;
      expect(rec.success).toBe(false);
      expect(typeof rec.decision).toBe('string');
      expect(rec.decision!.length).toBeGreaterThan(0);
      expect(rec.errorCode).toBe(r.error?.code);
      expect(rec.errorMessage).toBe(r.error?.message);
    });
  }
});

describe('final security snapshot (13.1.3)', () => {
  it('the upstream send refuses arguments that differ from the authorized snapshot', async () => {
    const { inv, sent } = setup({ inject: { stable: [{ argument: 'api_key' }] } });
    const r = await inv.invoke(ctx());
    expect(r.success).toBe(true);
    const snap = (r as unknown as { snapshot?: { serverId: string; tool: string; credentialTarget: string; principal: string; args: Record<string, unknown> } }).snapshot;
    expect(snap).toMatchObject({ serverId: 'stable', tool: 'read_file', credentialTarget: 'stable', principal: 'key:alice', args: { path: '/tmp/report.txt' } });
    expect(Object.isFrozen(snap)).toBe(true);
    // Something that changes the arguments after the snapshot (simulated) is refused at the send.
    const send = (inv as unknown as { send: (c: InvokeContext, t: string) => Promise<ProxyResponse> }).send.bind(inv);
    const authorizedTarget = Object.freeze({ serverId: 'stable', name: 'read_file', kind: 'tool' as const, principal: 'key:alice' });
    const tampered = await send(ctx({ authorizedTarget, snapshot: snap, params: { path: '/etc/shadow' } } as never), 'stable');
    expect(tampered.success).toBe(false);
    expect(tampered.error?.code).toBe(ERR_FORBIDDEN);
    expect(tampered.error?.data).toMatchObject({ decision: 'snapshot-mismatch', reason: 'arguments-changed-after-authorization' });
    expect(sent).toHaveLength(1);
  });
});
