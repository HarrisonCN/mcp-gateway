/**
 * LTS backport of the 13.1.2 identity fixes (MGW-2026-007, MGW-2026-008): one identity context per call. A delegated (agent) call is made FOR the original caller: tenancy, client
 * policy rules, quotas, budgets, data residency, cache partitions and audit all see the delegator, the agent is
 * recorded as the actor, and the effective scope is delegator ∩ every delegation hop. Identity keys of token-based
 * clients include the issuer when more than one issuer is trusted. REST, MCP and the agent API decide alike.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from 'jose';
import { startFeatureGw, fakeServer, type FeatureGw } from './helpers/feature-gw.js';
import { validateConfig } from '../src/config/loader.js';

const KEY = 'k'.repeat(40);
let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

type Res = { status: number; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = (key: string, path: string, body?: unknown, method = 'POST'): Promise<Res> =>
  fetch(`${h!.base}${path}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then(async (r) => {
    const t = await r.text();
    let b: unknown = t;
    try {
      b = JSON.parse(t);
    } catch {
      /* text */
    }
    return { status: r.status, body: b };
  });

/** Two tenants (alice in ta, bob in tb) sharing one agent `helper`; `runner` is the agent runtime's own key. */
const base = (extra: Record<string, unknown> = {}) => ({
  servers: [{ ...fakeServer('fake'), region: 'us' }],
  auth: { strategy: 'api-key', apiKeys: ['op', { key: 'alice-key', name: 'alice' }, { key: 'bob-key', name: 'bob' }, { key: 'runner-key', name: 'runner' }] },
  tenants: [
    { id: 'ta', servers: ['fake'], members: [{ client: 'key:alice', role: 'admin' }] },
    { id: 'tb', servers: ['fake'], members: [{ client: 'key:bob', role: 'admin' }] },
  ],
  agentIdentity: { signingKey: KEY, agents: [{ id: 'helper', tools: ['fake/*'], delegators: ['key:alice', 'key:bob'] }] },
  ...extra,
});

const mint = async (who: string): Promise<string> => {
  const r = await call(who, '/api/v1/features/agent-identity/token', { agent: 'helper' });
  expect(r.status).toBe(200);
  return r.body.access_token as string;
};
const viaAgent = (token: string, args: Record<string, unknown>, tool = 'echo') => call('runner-key', '/api/v1/features/agent-identity/call', { token, server: 'fake', tool, arguments: args });
const direct = (key: string, args: Record<string, unknown>, tool = 'echo') => call(key, '/api/v1/tools/call', { server: 'fake', tool, arguments: args });

async function mcpCall(key: string, args: Record<string, unknown>): Promise<{ error?: { code: number; message: string }; result?: unknown }> {
  const MH = { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const init = await fetch(`${h!.base}/mcp`, { method: 'POST', headers: MH, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) });
  const sid = init.headers.get('mcp-session-id')!;
  await init.text();
  const H = { ...MH, accept: 'application/json', 'mcp-session-id': sid };
  const list = (await (await fetch(`${h!.base}/mcp`, { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) })).json()) as { result: { tools: Array<{ name: string }> } };
  const name = list.result.tools.map((t) => t.name).find((n) => /echo$/.test(n))!;
  return (await (await fetch(`${h!.base}/mcp`, { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }) })).json()) as { error?: { code: number; message: string } };
}

const cacheStats = async () => (await call('op', '/api/v1/cache', undefined, 'GET')).body as { hits: number; misses: number };

describe('acceptance 1: tenants sharing one agent never share cache entries', () => {
  it('tool cache (scope: client) partitions delegated calls by the delegator, not by the agent', async () => {
    h = await startFeatureGw(base({ cache: { rules: [{ tools: ['fake/echo'], ttlSeconds: 60 }] } }) as never);
    const ta = await mint('alice-key');
    const tb = await mint('bob-key');
    expect((await viaAgent(ta, { q: 'report' })).status).toBe(200);
    const before = await cacheStats();
    expect((await viaAgent(tb, { q: 'report' })).status).toBe(200);
    const after = await cacheStats();
    expect(after.hits - before.hits).toBe(0); // bob must not be served alice's entry
    // the same delegator through the agent and directly is one caller: alice's own entry may serve her
    expect((await viaAgent(ta, { q: 'report' })).status).toBe(200);
    expect((await cacheStats()).hits - after.hits).toBe(1);
  });

  it('semantic cache (scope: tenant) never answers tenant B from tenant A through a shared agent', async () => {
    h = await startFeatureGw(base({ semanticCache: { tools: ['fake/echo'], threshold: 0.8, scope: 'tenant' } }) as never);
    await h.admin('semantic-cache', undefined, 'DELETE');
    const ta = await mint('alice-key');
    const tb = await mint('bob-key');
    const a = await viaAgent(ta, { q: 'tenant A payroll export, account 4711' });
    expect(a.status).toBe(200);
    const b = await viaAgent(tb, { q: 'tenant A payroll export, account 4711' });
    expect(b.status).toBe(200);
    expect(b.body.result?._meta?.['mcp-gateway/semantic-cache']).toBeUndefined();
  });
});

describe("acceptance 2: an agent cannot bypass the delegator's client-specific deny rules", () => {
  it('policy rule naming the delegator also applies to its delegated calls', async () => {
    h = await startFeatureGw(base({ policy: { rules: [{ name: 'bob-no-echo', clients: ['key:bob'], tools: ['fake/echo'], effect: 'deny' }] } }) as never);
    expect((await direct('bob-key', { x: 1 })).status).toBe(403);
    const tb = await mint('bob-key');
    const r = await viaAgent(tb, { x: 1 });
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/bob-no-echo|denied by policy/);
    expect((await viaAgent(await mint('alice-key'), { x: 1 })).status).toBe(200);
  });

  it('an allow rule naming the agent never lends the delegator access it does not have', async () => {
    h = await startFeatureGw(base({ policy: { default: 'deny', rules: [{ name: 'agent-allowed', clients: ['agent:helper'], effect: 'allow' }, { name: 'alice-ok', clients: ['key:alice'], effect: 'allow' }] } }) as never);
    expect((await direct('bob-key', { x: 1 })).status).toBe(403);
    expect((await viaAgent(await mint('bob-key'), { x: 1 })).status).toBe(403);
    expect((await viaAgent(await mint('alice-key'), { x: 1 })).status).toBe(200);
  });

  it('an explicit deny rule for the agent applies to its delegated calls', async () => {
    h = await startFeatureGw(base({ policy: { rules: [{ name: 'no-agent-echo', clients: ['agent:helper'], tools: ['fake/echo'], effect: 'deny' }] } }) as never);
    expect((await direct('alice-key', { x: 1 })).status).toBe(200);
    expect((await viaAgent(await mint('alice-key'), { x: 1 })).status).toBe(403);
  });
});

describe('acceptance 3: delegated and direct calls obey the same tenant, quota, budget and residency limits', () => {
  it('per-tenant quota counts and blocks delegated calls of the tenant member', async () => {
    h = await startFeatureGw(base({ quotas: { rules: [{ name: 'tb-1', limit: 1, period: 'day', per: 'tenant', tenants: ['tb'] }] } }) as never);
    expect((await direct('bob-key', { n: 1 })).status).toBe(200);
    expect((await direct('bob-key', { n: 2 })).status).toBe(429);
    const r = await viaAgent(await mint('bob-key'), { n: 3 });
    expect(r.status).not.toBe(200); // LTS: the agent API keeps its pre-13.1.2 status mapping (502)
    expect(r.body.error?.code).toBe(-32007);
  });

  it('per-client quota of the delegator is consumed by its agent calls', async () => {
    h = await startFeatureGw(base({ quotas: { rules: [{ name: 'bob-1', limit: 1, period: 'day', clients: ['key:bob'] }] } }) as never);
    const tb = await mint('bob-key');
    expect((await viaAgent(tb, { n: 1 })).status).toBe(200);
    expect((await direct('bob-key', { n: 2 })).status).toBe(429);
  });

  it('tenant budget (action: block) applies to delegated calls', async () => {
    h = await startFeatureGw(base({ costs: { tools: [{ match: 'fake/echo', perCall: 1 }], budgets: [{ name: 'tb-budget', tenants: ['tb'], period: 'day', limit: 1, action: 'block' }] } }) as never);
    expect((await direct('bob-key', { n: 1 })).status).toBe(200);
    expect((await direct('bob-key', { n: 2 })).status).toBe(429);
    const r = await viaAgent(await mint('bob-key'), { n: 3 });
    expect(r.status).not.toBe(200);
    expect(r.body.error?.code).toBe(-32013);
  });

  it('data residency of the delegator tenant applies to delegated calls', async () => {
    h = await startFeatureGw(base({ compliance: { residency: { rules: [{ tenants: ['tb'], regions: ['eu'] }] } } }) as never);
    expect((await direct('bob-key', { n: 1 })).status).toBe(403);
    expect((await direct('alice-key', { n: 1 })).status).toBe(200);
    const r = await viaAgent(await mint('bob-key'), { n: 2 });
    expect(r.status).not.toBe(200);
    expect(r.body.error?.code).toBe(-32011);
  });

  it('usage, costs and the audit record are attributed to the delegator with the agent as actor', async () => {
    h = await startFeatureGw(base() as never);
    const r = await viaAgent(await mint('bob-key'), { n: 1 });
    expect(r.status).toBe(200);
    const recs = (await call('op', '/api/v1/requests?limit=5', undefined, 'GET')).body;
    const list = (Array.isArray(recs) ? recs : recs.requests) as Array<Record<string, unknown>>;
    const rec = list.find((x) => x.toolName === 'echo')!;
    expect(rec.clientId).toBe('key:bob');
    expect(rec.actor).toBe('agent:helper');
    expect(rec.chain).toEqual(['key:bob', 'agent:helper']);
  });
});

describe('acceptance 4: REST, MCP and the agent API decide alike', () => {
  it('the same refusal is decided on every surface (same JSON-RPC code)', async () => {
    h = await startFeatureGw(base({ compliance: { residency: { rules: [{ tenants: ['tb'], regions: ['eu'] }] } }, quotas: { rules: [{ name: 'ta-2', limit: 2, period: 'day', per: 'tenant', tenants: ['ta'] }] } }) as never);
    const rest = await direct('bob-key', { n: 1 });
    const mcp = await mcpCall('bob-key', { n: 1 });
    const agent = await viaAgent(await mint('bob-key'), { n: 1 });
    expect(rest.status).toBe(403);
    expect(mcp.error?.code).toBe(rest.body.code);
    expect(agent.status).not.toBe(200);
    expect(agent.body.error?.code ?? agent.body.code).toBe(rest.body.code);
    expect((await direct('alice-key', { n: 1 })).status).toBe(200);
    expect((await mcpCall('alice-key', { n: 2 })).error).toBeUndefined();
    const q = await direct('alice-key', { n: 3 });
    expect(q.status).toBe(429);
    const qa = await viaAgent(await mint('alice-key'), { n: 4 });
    expect(qa.status).not.toBe(200);
    expect(qa.body.error?.code ?? qa.body.code).toBe(q.body.code);
  });
});

// ── acceptance 5 / multiple issuers ────────────────────────────────────────────────────────────────────────────

let privateKey: KeyLike;
let jwk: Record<string, unknown>;
beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  jwk = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
});

async function jwksServer(): Promise<{ url: string; close: () => Promise<void> }> {
  let base = '';
  const s: Server = createServer((req, res) => {
    res.writeHead(req.url === '/jwks' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/jwks' ? { keys: [jwk] } : {}));
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  return { url: base, close: () => new Promise((r) => s.close(() => r())) };
}

describe('acceptance 5: identity keys include the issuer when several issuers are trusted', () => {
  let js: Awaited<ReturnType<typeof jwksServer>> | undefined;
  afterEach(async () => {
    await js?.close();
    js = undefined;
  });
  const token = (iss: string, sub: string) => new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(iss).setAudience('gw').setSubject(sub).setIssuedAt().setExpirationTime('5m').sign(privateKey);

  it('oauth2: the same `sub` from two issuers is two different clients (cache, audit)', async () => {
    js = await jwksServer();
    const A = `${js.url}/tenant-a`;
    const B = `${js.url}/tenant-b`;
    h = await startFeatureGw({ servers: [fakeServer('fake')], cache: { rules: [{ tools: ['fake/echo'], ttlSeconds: 60 }] }, auth: { strategy: 'oauth2', oauth: { authorizationServers: [A, B], audience: 'gw', jwksUrl: `${js.url}/jwks` } } } as never);
    const ta = await token(A, 'alice');
    const tb = await token(B, 'alice');
    expect((await call(ta, '/api/v1/tools/call', { server: 'fake', tool: 'echo', arguments: { q: 'mail' } })).status).toBe(200);
    const s1 = (await call(ta, '/api/v1/cache', undefined, 'GET')).body;
    expect((await call(tb, '/api/v1/tools/call', { server: 'fake', tool: 'echo', arguments: { q: 'mail' } })).status).toBe(200);
    const s2 = (await call(ta, '/api/v1/cache', undefined, 'GET')).body;
    expect(s2.hits - s1.hits).toBe(0);
    const recs = (await call(ta, '/api/v1/requests?limit=5', undefined, 'GET')).body;
    const ids = new Set(((Array.isArray(recs) ? recs : recs.requests) as Array<{ clientId: string }>).map((r) => r.clientId));
    expect(ids.size).toBe(2);
    expect([...ids].sort()).toEqual([`oauth:${A}#alice`, `oauth:${B}#alice`]);
  });

  it('oauth2 with one issuer keeps the 13.1.1 id (oauth:<sub>)', async () => {
    js = await jwksServer();
    const A = `${js.url}/tenant-a`;
    h = await startFeatureGw({ servers: [fakeServer('fake')], auth: { strategy: 'oauth2', oauth: { authorizationServers: [A], audience: 'gw', jwksUrl: `${js.url}/jwks` } } } as never);
    const ta = await token(A, 'alice');
    expect((await call(ta, '/api/v1/tools/call', { server: 'fake', tool: 'echo', arguments: {} })).status).toBe(200);
    const recs = (await call(ta, '/api/v1/requests?limit=5', undefined, 'GET')).body;
    expect(((Array.isArray(recs) ? recs : recs.requests) as Array<{ clientId: string }>)[0]!.clientId).toBe('oauth:alice');
  });

  it('jwt strategy with several issuers qualifies ids too', async () => {
    const secret = 's'.repeat(40);
    h = await startFeatureGw({ servers: [fakeServer('fake')], auth: { strategy: 'jwt', jwtSecret: secret, jwt: { issuer: ['https://a.example', 'https://b.example'] } } } as never);
    const mk = (iss: string) => new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setIssuer(iss).setSubject('alice').setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(secret));
    expect((await call(await mk('https://a.example'), '/api/v1/tools/call', { server: 'fake', tool: 'echo', arguments: {} })).status).toBe(200);
    expect((await call(await mk('https://b.example'), '/api/v1/tools/call', { server: 'fake', tool: 'echo', arguments: {} })).status).toBe(200);
    const recs = (await call(await mk('https://a.example'), '/api/v1/requests?limit=5', undefined, 'GET')).body;
    const ids = new Set(((Array.isArray(recs) ? recs : recs.requests) as Array<{ clientId: string }>).map((r) => r.clientId));
    expect([...ids].sort()).toEqual(['jwt:https://a.example#alice', 'jwt:https://b.example#alice']);
  });

  it('config with several issuers refuses ambiguous unqualified client patterns', () => {
    const cfg = (extra: Record<string, unknown>) => ({ version: 10, servers: [], auth: { strategy: 'oauth2', oauth: { authorizationServers: ['https://a.example', 'https://b.example'] } }, ...extra });
    expect(() => validateConfig(cfg({ tenants: [{ id: 't', servers: ['*'], members: [{ client: 'oauth:alice', role: 'admin' }] }] }))).toThrow(/issuer/);
    expect(() => validateConfig(cfg({ policy: { rules: [{ clients: ['oauth:bob'], effect: 'deny' }] } }))).toThrow(/issuer/);
    expect(() => validateConfig(cfg({ tenants: [{ id: 't', servers: ['*'], members: [{ client: 'oauth:https://a.example#alice', role: 'admin' }] }] }))).not.toThrow();
    expect(() => validateConfig(cfg({ policy: { rules: [{ clients: ['oauth:*'], effect: 'deny' }] } }))).not.toThrow();
  });
});

describe('identity context (13.1.2 design)', () => {
  it('identityOf: the principal is authoritative; labels are origins, delegation hops are actors', async () => {
    const { identityOf, actorOf } = await import('../src/auth/identity.js');
    const { clientPrincipal, systemPrincipal } = await import('../src/auth/authorizer.js');
    expect(identityOf(clientPrincipal('key:bob', undefined), 'key:bob')).toEqual({ subject: 'key:bob', actors: [], chain: ['key:bob'] });
    const d = { ...clientPrincipal('key:bob', undefined), delegation: [{ agent: 'agent:a', tools: ['*'] }, { agent: 'agent:b', tools: ['*'] }] };
    const id = identityOf(d, 'agent:b');
    expect(id).toEqual({ subject: 'key:bob', actors: ['agent:a', 'agent:b'], chain: ['key:bob', 'agent:a', 'agent:b'] });
    expect(actorOf(id)).toBe('agent:b');
    expect(identityOf(clientPrincipal('key:bob', undefined), 'replay:key:bob')).toMatchObject({ subject: 'key:bob', origin: 'replay:key:bob' });
    expect(identityOf(systemPrincipal('blue-green'), 'blue-green').subject).toBe('blue-green');
    expect(identityOf(clientPrincipal(undefined, undefined), undefined).subject).toBeUndefined();
    // pre-13.1.2 joined hop label
    expect(identityOf({ ...clientPrincipal('key:x', undefined), delegation: [{ agent: 'agent:a > agent:b', tools: ['*'] }] }).actors).toEqual(['agent:a', 'agent:b']);
  });

  it('evaluateActorPolicy: only rules naming the actor apply, and only to restrict', async () => {
    const { evaluateActorPolicy } = await import('../src/policy/tool-policy.js');
    const req = { serverId: 'fake', tool: 'echo', args: {} };
    expect(evaluateActorPolicy({ rules: [{ clients: ['*'], effect: 'deny' }] }, ['agent:a'], req)).toBeUndefined();
    expect(evaluateActorPolicy({ rules: [{ clients: ['agent:a'], effect: 'allow' }] }, ['agent:a'], req)).toBeUndefined();
    expect(evaluateActorPolicy({ rules: [{ name: 'r', clients: ['agent:*'], effect: 'approve' }] }, ['agent:a'], req)).toMatchObject({ effect: 'approve', rule: 'r', actor: 'agent:a' });
    expect(evaluateActorPolicy({ rules: [{ name: 'x', clients: ['agent:b'], effect: 'deny' }, { name: 'y', clients: ['agent:a'], effect: 'approve' }] }, ['agent:a', 'agent:b'], req)).toMatchObject({ effect: 'deny', actor: 'agent:b' });
  });

  it('sub-agent chains: the audit chain is [delegator, agent, sub-agent]; the persistent audit log and SIEM events keep it', async () => {
    h = await startFeatureGw(base({ audit: { enabled: true, path: ':memory:' }, agentIdentity: { signingKey: KEY, agents: [{ id: 'helper', tools: ['fake/*'], delegators: ['key:alice', 'key:bob'] }, { id: 'sub', tools: ['fake/echo'], delegators: [] }] } }) as never);
    const parent = await mint('alice-key');
    const child = await call('runner-key', '/api/v1/features/agent-identity/token', { agent: 'sub', subjectToken: parent });
    expect(child.status).toBe(200);
    expect((await viaAgent(child.body.access_token, { n: 1 })).status).toBe(200);
    const page = (await call('op', '/api/v1/requests?limit=5', undefined, 'GET')).body as { requests: Array<Record<string, unknown>>; source: string };
    expect(page.source).toBe('audit');
    const rec = page.requests.find((x) => x.toolName === 'echo')!;
    expect(rec).toMatchObject({ clientId: 'key:alice', actor: 'agent:sub', chain: ['key:alice', 'agent:helper', 'agent:sub'] });
    const { toAuditEvent } = await import('../src/monitor/siem.js');
    expect(toAuditEvent({ ...(rec as never), timestamp: new Date() })).toMatchObject({ client: 'key:alice', actor: 'agent:sub', chain: ['key:alice', 'agent:helper', 'agent:sub'] });
  });

  it('direct calls keep their 13.1.1 records (no actor / chain fields)', async () => {
    h = await startFeatureGw(base() as never);
    expect((await direct('alice-key', { n: 1 })).status).toBe(200);
    const page = (await call('op', '/api/v1/requests?limit=5', undefined, 'GET')).body as { requests: Array<Record<string, unknown>> };
    const rec = page.requests.find((x) => x.toolName === 'echo')!;
    expect(rec.clientId).toBe('key:alice');
    expect(rec.actor).toBeUndefined();
    expect(rec.chain).toBeUndefined();
  });
});
