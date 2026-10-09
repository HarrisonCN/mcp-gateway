// 10.5 policy-as-code 2.0: Cedar parser / evaluator, OPA queries, the policy-engine call hook, tests and impact.
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import fc from 'fast-check';
import { parseCedar, evaluateCedar, toCedarRequest, cedarLike, CedarSyntaxError } from '../src/policy/cedar.js';
import { PolicyEngineSchema, decide, runEngineTests, cedarImpact, queryOpa } from '../src/features/policy-engine.js';
import { validateConfig } from '../src/config/loader.js';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';

const req = (o: { client?: string; tenant?: string; server?: string; tool?: string; args?: Record<string, unknown> }) =>
  toCedarRequest({ clientId: o.client ?? 'key:alice', tenant: o.tenant, serverId: o.server ?? 'fs', tool: o.tool ?? 'read_file', args: o.args ?? {} }, new Date('2026-10-09T10:00:00Z'));

describe('Cedar subset (10.5)', () => {
  const policies = parseCedar(`
    // read tools for everyone
    @id("read")
    permit(principal, action == Action::"callTool", resource) when { resource.tool like "read_*" };
    @id("fs-tmp-writes")
    permit(principal, action, resource in Server::"fs") when { resource.tool == "write_file" && context.args.path like "/tmp/*" };
    @id("interns-no-delete")
    forbid(principal in Tenant::"interns", action, resource) when { resource.tool like "*delete*" };
    @id("ops-delete")
    permit(principal == Client::"key:ops", action, resource is Tool) unless { context.args has force && context.args.force == true };
    @id("big-batches")
    forbid(principal, action, resource) when { context.args has items && context.args.items.contains("*") || (context.args has n && context.args.n > 100) };
  `);

  it('parses ids, effects and scopes', () => {
    expect(policies.map((p) => `${p.effect}:${p.id}`)).toEqual(['permit:read', 'permit:fs-tmp-writes', 'forbid:interns-no-delete', 'permit:ops-delete', 'forbid:big-batches']);
  });

  it('default deny, permit, forbid overrides permit', () => {
    expect(evaluateCedar(policies, req({ tool: 'read_file' }))).toMatchObject({ decision: 'allow', reasons: ['read'] });
    expect(evaluateCedar(policies, req({ tool: 'list' })).decision).toBe('deny');
    expect(evaluateCedar(policies, req({ tool: 'write_file', args: { path: '/tmp/a' } })).decision).toBe('allow');
    expect(evaluateCedar(policies, req({ tool: 'write_file', args: { path: '/etc/passwd' } })).decision).toBe('deny');
    expect(evaluateCedar(policies, req({ tool: 'write_file', server: 'other', args: { path: '/tmp/a' } })).decision).toBe('deny');
    expect(evaluateCedar(policies, req({ client: 'key:ops', tool: 'delete_all' })).decision).toBe('allow');
    expect(evaluateCedar(policies, req({ client: 'key:ops', tool: 'delete_all', args: { force: true } })).decision).toBe('deny');
    expect(evaluateCedar(policies, req({ client: 'key:ops', tenant: 'interns', tool: 'delete_all' }))).toMatchObject({ decision: 'deny', reasons: ['interns-no-delete'] });
    expect(evaluateCedar(policies, req({ tool: 'read_x', args: { n: 101 } }))).toMatchObject({ decision: 'deny', reasons: ['big-batches'] });
    expect(evaluateCedar(policies, req({ tool: 'read_x', args: { items: ['a', '*'] } })).decision).toBe('deny');
  });

  it('a policy whose condition errors does not apply and is reported', () => {
    const p = parseCedar('@id("e") permit(principal, action, resource) when { context.args.missing == 1 };');
    const d = evaluateCedar(p, req({}));
    expect(d.decision).toBe('deny');
    expect(d.errors[0]).toMatchObject({ policy: 'e' });
    expect(d.errors[0]!.message).toMatch(/missing/);
  });

  it('expressions: arithmetic, if-then-else, sets, records, containsAll / Any, isEmpty, is ... in', () => {
    const p = parseCedar(`
      @id("x") permit(principal is Client in Tenant::"t", action in [Action::"callTool", Action::"other"], resource)
        when { (if context.hour >= 9 then context.hour - 9 + 1 else 0) * 2 == 4
               && ["a", "b", "c"].containsAll(["a", "c"]) && [1, 2].containsAny([2, 3]) && ![].isEmpty() == false
               && {k: "v", n: 1}.k == "v" && resource["server"] == "fs" && principal is Client in Tenant::"t" && context.weekday != -1 };`);
    expect(evaluateCedar(p, req({ tenant: 't' })).decision).toBe('allow');
    expect(evaluateCedar(p, req({})).decision).toBe('deny');
  });

  it('like: wildcards and escaped stars', () => {
    expect(cedarLike('read_file', 'read_*')).toBe(true);
    expect(cedarLike('a*b', 'a\\*b')).toBe(true);
    expect(cedarLike('axb', 'a\\*b')).toBe(false);
    expect(cedarLike('x.y', 'x.y')).toBe(true);
    expect(cedarLike('xzy', 'x.y')).toBe(false);
    const p = parseCedar('permit(principal, action, resource) when { context.args.p like "a\\*b" };');
    expect(evaluateCedar(p, req({ args: { p: 'a*b' } })).decision).toBe('allow');
  });

  it('rejects unsupported constructs and syntax errors with a line number', () => {
    expect(() => parseCedar('permit(principal, action, resource) when { ip("1.2.3.4") == 1 };')).toThrow(/extension function "ip\(\)" is not supported/);
    expect(() => parseCedar('permit(principal == ?principal, action, resource);')).toThrow(CedarSyntaxError);
    expect(() => parseCedar('permit(principal, action, resource)\n when { true }')).toThrow(/line 2.*expected ";"/);
    expect(() => parseCedar('allow(principal, action, resource);')).toThrow(/permit" or "forbid/);
    expect(() => parseCedar('@id("a") permit(principal, action, resource); @id("a") forbid(principal, action, resource);')).toThrow(/duplicate policy id/);
  });

  it('never throws on arbitrary arguments (property)', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const d = evaluateCedar(policies, req({ tool: 'write_file', args: { path: v as never, n: v as never, items: v as never } }));
        expect(['allow', 'deny']).toContain(d.decision);
      }),
      { numRuns: 200 },
    );
  });
});

describe('policy engine (10.5)', () => {
  let opa: Server | undefined;
  let fx: FeatureGw | undefined;
  afterEach(async () => {
    await fx?.stop();
    fx = undefined;
    await new Promise((r) => (opa ? opa.close(r) : r(undefined)));
    opa = undefined;
  });

  const startOpa = async (answer: (input: Record<string, unknown>) => unknown, status = 200): Promise<string> => {
    opa = createServer((rq, rs) => {
      let b = '';
      rq.on('data', (c) => (b += c));
      rq.on('end', () => {
        if (rq.url !== '/v1/data/mcp/allow') return void rs.writeHead(404).end('{}');
        const input = (JSON.parse(b) as { input: Record<string, unknown> }).input;
        rs.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ result: answer(input) }));
      });
    });
    await new Promise<void>((r) => opa!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(opa!.address() as { port: number }).port}`;
  };

  it('schema: validates Cedar at config time and needs a policy source', () => {
    expect(() => validateConfig({ version: 11, servers: [], features: { policyEngine: { cedar: 'permit(principal, action, resource);' } } })).not.toThrow();
    expect(() => validateConfig({ version: 11, servers: [], features: { policyEngine: { cedar: 'permit(principal, action);' } } })).toThrow(/Cedar syntax error/);
    expect(() => validateConfig({ version: 11, servers: [], features: { policyEngine: {} } })).toThrow(/configure cedar, cedarFiles or opa/);
  });

  it('OPA: boolean and { allow, reason } results, undefined = deny, errors follow onError', async () => {
    const url = await startOpa((i) => (i.tool === 'ok' ? true : i.tool === 'obj' ? { allow: false, reason: 'nope' } : undefined));
    const cfg = PolicyEngineSchema.parse({ opa: { url, path: 'mcp/allow' } });
    expect((await decide(cfg, { serverId: 's', tool: 'ok' })).decision).toBe('allow');
    expect((await decide(cfg, { serverId: 's', tool: 'obj' })).opa).toEqual({ decision: 'deny', reason: 'nope' });
    expect((await decide(cfg, { serverId: 's', tool: 'x' })).opa?.reason).toMatch(/undefined result/);
    const down = PolicyEngineSchema.parse({ opa: { url: 'http://127.0.0.1:1', path: 'mcp/allow', onError: 'allow' } });
    const d = await queryOpa(down.opa!, {});
    expect(d.decision).toBe('allow');
    expect(d.error).toBeTruthy();
    const wrongPath = PolicyEngineSchema.parse({ opa: { url, path: 'other' } });
    expect((await decide(wrongPath, { serverId: 's', tool: 'ok' })).opa).toMatchObject({ decision: 'deny', error: 'OPA answered HTTP 404' });
  });

  it('cedarFiles are read relative to the config dir; tests report pass / fail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgw-cedar-'));
    writeFileSync(join(dir, 'base.cedar'), '@id("echo") permit(principal, action, resource) when { resource.tool == "echo" };');
    const cfg = PolicyEngineSchema.parse({
      cedarFiles: ['base.cedar'],
      tests: [
        { name: 'echo allowed', request: { server: 'fake', tool: 'echo' }, expect: 'allow' },
        { name: 'wrong expectation', request: { server: 'fake', tool: 'other' }, expect: 'allow' },
      ],
    });
    const r = await runEngineTests(cfg, cfg.tests, { configDir: dir });
    expect(r.map((x) => x.passed)).toEqual([true, false]);
    expect(r[0]!.reasons).toEqual(['echo']);
  });

  it('impact analysis lists changed decisions', () => {
    const cur = parseCedar('permit(principal, action, resource);');
    const cand = parseCedar('@id("no-rm") forbid(principal, action, resource) when { resource.tool == "rm" }; permit(principal, action, resource);');
    const r = cedarImpact(cur, cand, [{ serverId: 's', tool: 'rm' }, { serverId: 's', tool: 'ls' }], 'request');
    expect(r).toMatchObject({ calls: 2, changed: 1, becameDenied: 1, becameAllowed: 0 });
    expect(r.changes[0]).toMatchObject({ tool: 'rm', before: 'allow', after: 'deny', reasons: ['no-rm'] });
  });

  it('enforces on live calls (REST), shadow mode never blocks, admin API evaluates / tests / impact', async () => {
    const url = await startOpa((i) => i.client !== 'key:blocked');
    fx = await startFeatureGw({
      auth: { strategy: 'api-key', apiKeys: [{ key: 'op', name: 'op' }, { key: 'blocked', name: 'blocked' }] },
      policyEngine: {
        cedar: '@id("echo-only") permit(principal, action, resource) when { resource.tool == "echo" && !(context.args has evil) };',
        opa: { url, path: 'mcp/allow' },
        tests: [{ name: 'evil denied', request: { server: 'fake', tool: 'echo', args: { evil: 1 } }, expect: 'deny' }],
      },
    } as never);
    const call = (key: string, args: Record<string, unknown>) =>
      fetch(`${fx!.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: args }) });
    expect((await call('op', { msg: 'hi' })).status).toBe(200);
    const denied = await call('op', { evil: true });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { message: string }).message).toMatch(/no Cedar policy permits it/);
    const opaDenied = await call('blocked', {});
    expect(opaDenied.status).toBe(403);
    expect(((await opaDenied.json()) as { message: string }).message).toMatch(/denied by OPA/);

    const st = await fx.admin('policy-engine');
    expect(st.body).toMatchObject({ enabled: true, mode: 'enforce', cedar: { policies: [{ id: 'echo-only', effect: 'permit' }] }, tests: 1 });
    const ev = await fx.admin('policy-engine/evaluate', { client: 'key:op', server: 'fake', tool: 'other' });
    expect(ev.body).toMatchObject({ decision: 'deny', cedar: { decision: 'deny' }, opa: { decision: 'allow' } });
    expect((await fx.admin('policy-engine/evaluate', { tool: 'x' })).status).toBe(400);
    const t = await fx.admin('policy-engine/test', {});
    expect(t.body).toMatchObject({ total: 1, failed: 0 });
    const imp = await fx.admin('policy-engine/impact', { cedar: 'permit(principal, action, resource);', calls: [{ server: 'fake', tool: 'other' }] });
    expect(imp.body).toMatchObject({ source: 'request', changed: 1, becameAllowed: 1 });
    expect((await fx.admin('policy-engine/impact', { cedar: 'nonsense' })).status).toBe(400);

    // shadow: same policies, nothing blocked, would-deny recorded
    await fx.gw.reload({ ...(fx.gw as any).config, policyEngine: { mode: 'shadow', cedar: 'forbid(principal, action, resource);' } } as never);
    expect((await call('op', { evil: true })).status).toBe(200);
    const sh = await fx.admin('policy-engine');
    expect(sh.body.mode).toBe('shadow');
    expect(sh.body.shadow.wouldDeny).toBeGreaterThan(0);
  });
});
