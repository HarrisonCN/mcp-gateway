/** 11.1: single, non-bypassable authorization point; agent delegation ∩ original caller; strict scope narrowing. */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { startFeatureGw, fakeServer, type FeatureGw } from './helpers/feature-gw.js';
import { authorize, clientPrincipal, deniedPrincipal, systemPrincipal, grantCovers, ERR_FORBIDDEN, type Principal } from '../src/auth/authorizer.js';
import { narrowScope, restrictToPrincipal, signAgentToken, delegatedPrincipal, type AgentTokenClaims } from '../src/features/agent-identity.js';
import { globToRegExp } from '../src/utils/tool-filter.js';

const KEY = 'k'.repeat(40);
let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const tool = (serverId: string, name: string) => ({ serverId, name, kind: 'tool' as const });

describe('central authorizer (11.1)', () => {
  it('fails closed without a principal and checks scope, tenant role, server filter and delegation', () => {
    expect(authorize(undefined, tool('s', 't'))?.code).toBe(ERR_FORBIDDEN);
    expect(authorize({ kind: 'nope', id: 'x' } as unknown as Principal, tool('s', 't'))).toBeDefined();
    expect(authorize(clientPrincipal('key:op', undefined), tool('s', 't'))).toBeUndefined();
    const alice = clientPrincipal('key:alice', { servers: ['fake'], tools: ['echo'] });
    expect(authorize(alice, tool('fake', 'echo'))).toBeUndefined();
    expect(authorize(alice, tool('vault', 'echo'))?.data.reason).toBe('scope');
    expect(authorize(alice, tool('fake', 'other'))?.data.reason).toBe('scope');
    const viewer = clientPrincipal('key:v', { tenantServers: ['fake'], writableServers: [] });
    expect(authorize(viewer, tool('fake', 'echo'))?.data.reason).toBe('tenant-role');
    expect(authorize(viewer, { serverId: 'fake', name: 'live://x', kind: 'resource' })).toBeUndefined();
    expect(authorize(systemPrincipal('probe'), tool('fake', 'hidden'), { exposed: () => false })?.data.reason).toBe('not-exposed');
    const agent = { ...clientPrincipal('key:op', undefined), delegation: [{ agent: 'agent:a', tools: ['fake/echo'] }] };
    expect(authorize(agent, tool('fake', 'echo'))).toBeUndefined();
    expect(authorize(agent, tool('fake', 'drop'))?.data.reason).toBe('delegation');
    expect(authorize(agent, { serverId: 'fake', name: 'live://x', kind: 'resource' })?.data.reason).toBe('delegation');
    expect(authorize(deniedPrincipal('key:ghost'), tool('fake', 'echo'))).toBeDefined();
  });
});

describe('strict scope narrowing (11.1)', () => {
  const catalog = ['vault/read', 'vault/readX', 'vault/reader', 'vault/read_all', 'vault/write', 'fs/[a]', 'fs/a', 'fs/x\\y', 'a/b/c'];
  it('never widens: vault/read? does not grant vault/read*', () => {
    const g = narrowScope(['vault/read?'], ['vault/read*'], catalog);
    expect(g.sort()).toEqual(['vault/readX']);
    expect(grantCovers(g, 'vault', 'reader')).toBe(false);
    expect(grantCovers(g, 'vault', 'read_all')).toBe(false);
    expect(narrowScope(['vault/read?'], ['vault/read?'], catalog)).toEqual(['vault/read?']); // identical pattern
    expect(narrowScope(['vault/read?'], ['vault/readZ'], [])).toEqual(['vault/readZ']); // literal inside
    expect(narrowScope(['vault/read?'], ['vault/readZZ'], [])).toEqual([]);
    expect(narrowScope(['vault/*'], ['*'], catalog).sort()).toEqual(['vault/read', 'vault/readX', 'vault/read_all', 'vault/reader', 'vault/write']);
    expect(narrowScope(['a/*'], ['b/c'])).toEqual([]);
  });
  it('[] classes, ** and escapes are literal / concrete only', () => {
    expect(narrowScope(['fs/[a]'], ['fs/?'], catalog)).toEqual([]); // `[a]` is literal: only "fs/[a]" (3 chars) would match
    expect(narrowScope(['fs/[a]'], ['fs/[*'], catalog)).toEqual(['fs/[a]']);
    expect(narrowScope(['fs/a'], ['fs/[a]'], catalog)).toEqual([]);
    expect(narrowScope(['a/*'], ['**'], catalog)).toEqual(['a/b/c']);
    expect(narrowScope(['fs/x\\y'], ['fs/x\\*'], catalog)).toEqual(['fs/x\\y']);
    expect(narrowScope(['fs/x\\y'], ['fs/x*'], [])).toEqual([]);
  });
  it('property: every name the grant covers is covered by the allowed set (fuzz)', () => {
    const ch = fc.constantFrom('a', 'b', '/', '*', '?', '[', ']', '\\', '.');
    const pat = fc.array(ch, { minLength: 1, maxLength: 6 }).map((a) => a.join(''));
    const name = fc.array(fc.constantFrom('a', 'b', '/', '[', ']', '\\', '.', 'c'), { minLength: 0, maxLength: 7 }).map((a) => a.join(''));
    fc.assert(
      fc.property(fc.array(pat, { minLength: 1, maxLength: 3 }), fc.array(pat, { minLength: 1, maxLength: 3 }), fc.array(name, { maxLength: 12 }), fc.array(name, { maxLength: 30 }), (allowed, requested, cat, probes) => {
        const grant = narrowScope(allowed, requested, cat);
        const covers = (ps: string[], n: string) => ps.some((p) => p === n || globToRegExp(p).test(n));
        for (const n of [...cat, ...probes, ...requested]) if (covers(grant, n)) expect(covers(allowed, n)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });
  it('a restricted delegator never gets a token broader than its own scope', () => {
    const p = clientPrincipal('key:alice', { servers: ['fake'] });
    expect(restrictToPrincipal(['*'], p, ['fake/echo', 'vault/echo'])).toEqual(['fake/echo']);
    expect(restrictToPrincipal(['vault/echo'], p, ['fake/echo', 'vault/echo'])).toEqual([]);
    expect(restrictToPrincipal(['*'], clientPrincipal('key:op', undefined), [])).toEqual(['*']);
  });
});

describe('P0 regression: delegated calls are bounded by the original caller (11.1)', () => {
  const start = () =>
    startFeatureGw({
      servers: [fakeServer('fake'), fakeServer('vault')],
      auth: { strategy: 'api-key', apiKeys: ['op', { key: 'alice-key', name: 'alice', servers: ['fake'] }] },
      agentIdentity: { signingKey: KEY, agents: [{ id: 'helper', tools: ['*'], delegators: ['*'] }] },
      chains: { chains: [{ name: 'leak', steps: [{ id: 'a', tool: 'vault/echo', args: {} }] }] },
    } as never);
  const post = (key: string, path: string, body: unknown) =>
    fetch(`${h!.base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: (await r.json()) as any, headers: r.headers })); // eslint-disable-line @typescript-eslint/no-explicit-any

  it('restricted key → agent token → out-of-scope tool is denied on mint and on /call', async () => {
    h = await start();
    const minted = await post('alice-key', '/api/v1/features/agent-identity/token', { agent: 'helper' });
    expect(minted.status).toBe(200);
    expect(minted.body.scope).toBe('fake/echo'); // agent '*' ∩ alice (servers: fake) → concrete tools
    expect((await post('alice-key', '/api/v1/features/agent-identity/token', { agent: 'helper', tools: ['vault/echo'] })).status).toBe(403);
    expect((await post('alice-key', '/api/v1/features/agent-identity/token', { agent: 'helper', tools: ['vault/*'] })).status).toBe(403);
    const ok = await post('alice-key', '/api/v1/features/agent-identity/call', { token: minted.body.access_token, server: 'fake', tool: 'echo', arguments: { a: 1 } });
    expect(ok.status).toBe(200);
    expect((await post('alice-key', '/api/v1/features/agent-identity/call', { token: minted.body.access_token, server: 'vault', tool: 'echo' })).status).toBe(403);
    // A broad token (e.g. minted by ≤ 11.0) is still intersected with alice's CURRENT scope at call time.
    const now = Math.floor(Date.now() / 1000);
    const claims: AgentTokenClaims = { iss: 'mcp-gateway', sub: 'key:alice', act: { sub: 'agent:helper' }, agent: 'helper', scope: ['*'], iat: now, exp: now + 60, jti: 'legacy-1' };
    const broad = signAgentToken(claims, KEY);
    const denied = await post('alice-key', '/api/v1/features/agent-identity/call', { token: broad, server: 'vault', tool: 'echo' });
    expect(denied.status).toBe(403);
    expect(denied.body.message).toMatch(/not allowed for this client/);
    expect((await post('alice-key', '/api/v1/features/agent-identity/call', { token: broad, server: 'fake', tool: 'echo' })).status).toBe(200);
    // A token whose delegator key no longer exists may call nothing.
    const ghost = signAgentToken({ ...claims, sub: 'key:ghost', jti: 'ghost-1' }, KEY);
    expect((await post('alice-key', '/api/v1/features/agent-identity/call', { token: ghost, server: 'fake', tool: 'echo' })).status).toBe(403);
    // Operator delegation keeps working.
    const opTok = await post('op', '/api/v1/features/agent-identity/token', { agent: 'helper' });
    expect(opTok.body.scope).toBe('*');
    expect((await post('alice-key', '/api/v1/features/agent-identity/call', { token: opTok.body.access_token, server: 'vault', tool: 'echo' })).status).toBe(200);
  }, 30_000);

  it('every other entry path refuses the out-of-scope tool for the restricted key', async () => {
    h = await start();
    // REST
    expect((await post('alice-key', '/api/v1/tools/call', { server: 'vault', tool: 'echo', arguments: {} })).status).toBe(403);
    expect((await post('alice-key', '/api/v1/tools/call', { server: 'fake', tool: 'echo', arguments: {} })).status).toBe(200);
    // tool chains (REST + /mcp share ChainService)
    expect((await post('alice-key', '/api/v1/chains/leak/run', { input: {} })).status).toBe(403);
    // /mcp
    const init = await post('alice-key', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    const sid = init.headers.get('mcp-session-id')!;
    const mcp = (body: unknown) =>
      fetch(`${h!.base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer alice-key', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sid }, body: JSON.stringify(body) }).then(async (r) => { const t = await r.text(); return (t ? JSON.parse(t) : {}) as any; }); // eslint-disable-line @typescript-eslint/no-explicit-any
    await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const listed = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(JSON.stringify(listed.result.tools)).not.toMatch(/vault/);
    const called = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'vault__echo', arguments: {} } });
    expect(called.error ?? called.result?.isError).toBeTruthy();
    // Feature context (task graphs, privacy, edge autonomy, debug, replays, plugins): the invoker refuses directly.
    const gw = h.gw as unknown as { invoker: { invoke: (c: unknown) => Promise<{ success: boolean; error?: { code: number } }> } };
    const base = { serverId: 'vault', name: 'echo', kind: 'tool', method: 'tools/call', params: {}, via: 'rest' };
    expect((await gw.invoker.invoke({ ...base })).error?.code).toBe(ERR_FORBIDDEN); // no principal → fail-closed
    expect((await gw.invoker.invoke({ ...base, principal: clientPrincipal('key:alice', { servers: ['fake'] }) })).error?.code).toBe(ERR_FORBIDDEN);
    expect((await gw.invoker.invoke({ ...base, principal: (h.gw as unknown as { principalFor: (id: string) => Principal }).principalFor('key:alice') })).error?.code).toBe(ERR_FORBIDDEN);
    expect((await gw.invoker.invoke({ ...base, principal: deniedPrincipal('key:ghost') })).error?.code).toBe(ERR_FORBIDDEN);
    expect((await gw.invoker.invoke({ ...base, principal: systemPrincipal('test') })).success).toBe(true);
    // delegated principal helper: removed key → nothing; JWT snapshot is used when scopes cannot be re-resolved.
    const k = { sub: 'jwt:bob', scope: ['*'], act: { sub: 'agent:helper' }, jti: 'j', dsc: { servers: ['fake'] } } as unknown as AgentTokenClaims;
    const p = delegatedPrincipal({ resolveScope: () => undefined }, k);
    expect(authorize(p, tool('vault', 'echo'))).toBeDefined();
    expect(authorize(p, tool('fake', 'echo'))).toBeUndefined();
    expect(authorize(delegatedPrincipal({ resolveScope: () => ({ known: false }) }, k), tool('fake', 'echo'))).toBeDefined();
  }, 30_000);
});

describe('no call site bypasses the authorizer (11.1)', () => {
  const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : f.endsWith('.ts') ? [join(d, f)] : []));
  const src = files(join(__dirname, '..', 'src')).map((f) => ({ f: f.replace(/.*\/src\//, 'src/'), s: readFileSync(f, 'utf8') }));
  /** Text of the call starting at `i` (balanced parentheses). */
  const callAt = (s: string, i: number) => {
    let depth = 0;
    for (let j = s.indexOf('(', i); j < s.length; j++) {
      if (s[j] === '(') depth++;
      else if (s[j] === ')' && --depth === 0) return s.slice(i, j + 1);
    }
    return s.slice(i);
  };
  it('every ToolInvoker.invoke({…}) call passes a principal', () => {
    const sites: string[] = [];
    for (const { f, s } of src) for (const m of s.matchAll(/invoker!?\.invoke\(\{/g)) {
      const call = callAt(s, m.index!);
      sites.push(f);
      expect(call, `${f}: invoke without principal`).toMatch(/\bprincipal\b/);
    }
    expect(sites.length).toBeGreaterThanOrEqual(7); // REST ×2, /mcp ×2, chains, feature ctx, plugin routes
  });
  it('every feature ctx.invoke(…) passes a principal argument', () => {
    let n = 0;
    for (const { f, s } of src) for (const m of s.matchAll(/ctx\.invoke\(/g)) {
      const call = callAt(s, m.index!);
      n++;
      // 4 top-level arguments at least: server, tool, args, principal.
      let depth = 0, commas = 0;
      for (const c of call.slice(call.indexOf('(') + 1, -1)) {
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth--;
        else if (c === ',' && depth === 0) commas++;
      }
      expect(commas, `${f}: ${call.slice(0, 80)}`).toBeGreaterThanOrEqual(3);
    }
    expect(n).toBeGreaterThanOrEqual(6);
  });
  it('only the invoker (and the edge runtime, after its authorize call) sends tools/call upstream', () => {
    for (const { f, s } of src) {
      if (f === 'src/gateway/invoker.ts' || f === 'src/proxy/index.ts' || f === 'src/bench/index.ts') continue;
      expect(/\.callTool\(\s*(target|serverId)/.test(s), `${f} calls proxy.callTool`).toBe(false);
      for (const m of s.matchAll(/\.request\(\s*['"]tools\/call['"]/g)) {
        expect(f, 'tools/call sent outside the invoker').toBe('src/edge/index.ts');
        expect(s.slice(Math.max(0, m.index! - 300), m.index!)).toMatch(/edgeAuthorize\(/);
      }
    }
    const inv = src.find((x) => x.f === 'src/gateway/invoker.ts')!.s;
    const body = inv.slice(inv.indexOf('async invoke(ctx: InvokeContext)'));
    expect(body.indexOf('authorize(ctx.principal')).toBeGreaterThan(0);
    expect(body.indexOf('authorize(ctx.principal')).toBeLessThan(body.indexOf('beforeCall'));
    expect(inv).toMatch(/private async callUpstream/);
  });
});
