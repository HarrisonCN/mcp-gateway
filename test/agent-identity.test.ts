/** 8.1: agent identity & delegated auth. */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';
import { validateConfig } from '../src/config/loader.js';
import { AgentIdentitySchema, issueAgentToken, verifyAgentToken, introspect, agentState, chainOf, narrowScope, ERR_AGENT_REQUIRED } from '../src/features/agent-identity.js';

const KEY = 'k'.repeat(40);
const conf = (extra: Record<string, unknown> = {}) => AgentIdentitySchema.parse({ signingKey: KEY, agents: [{ id: 'travel', tools: ['flights/*', 'hotels/search'], delegators: ['key:alice'] }, { id: 'booker', tools: ['flights/book', 'payments/*'] }], ...extra });

let h: FeatureGw | undefined;
beforeEach(() => agentState.reset());
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

describe('agent identity (8.1)', () => {
  it('validates config: signing key length, duplicate agent ids', () => {
    expect(() => validateConfig({ servers: [], features: { agentIdentity: { signingKey: 'short', agents: [] } } })).toThrow(/at least 32 characters/);
    expect(() => validateConfig({ servers: [], features: { agentIdentity: { signingKey: KEY, agents: [{ id: 'a', tools: ['*'] }, { id: 'a', tools: ['*'] }] } } })).toThrow(/duplicate agent id/);
    expect(validateConfig({ version: 10, servers: [], features: { agentIdentity: { signingKey: KEY } } }).agentIdentity).toBeDefined();
    expect(ERR_AGENT_REQUIRED).toBe(-32019);
  });

  it('token exchange: delegators, scope narrowing, expiry, tampering, chains', () => {
    const c = conf();
    expect(issueAgentToken(c, { agent: 'nope', clientId: 'key:alice' }).status).toBe(404);
    expect(issueAgentToken(c, { agent: 'travel', clientId: 'key:mallory' }).status).toBe(403);
    const t = issueAgentToken(c, { agent: 'travel', clientId: 'key:alice', tools: ['flights/*', 'payments/pay'], ttlSeconds: 99_999 });
    expect(t.claims).toMatchObject({ sub: 'key:alice', act: { sub: 'agent:travel' }, scope: ['flights/*'] });
    expect(t.claims!.exp - t.claims!.iat).toBe(900);
    expect(verifyAgentToken(t.token!, KEY, 'mcp-gateway').claims?.jti).toBe(t.claims!.jti);
    expect(verifyAgentToken(t.token!, KEY, 'mcp-gateway', Date.now() + 901_000).error).toBe('token expired');
    expect(verifyAgentToken(t.token!.slice(0, -2) + 'xx', KEY, 'mcp-gateway').error).toBe('bad signature');
    expect(verifyAgentToken(t.token!, 'x'.repeat(40), 'mcp-gateway').error).toBe('bad signature');
    expect(verifyAgentToken(t.token!, KEY, 'other').error).toBe('wrong issuer');
    expect(narrowScope(['a/*'], ['b/c'])).toEqual([]);
    // Sub-agent: booker acts for alice through travel; scope = booker ∩ travel token.
    const sub = issueAgentToken(c, { agent: 'booker', clientId: 'key:whatever', subjectToken: t.token });
    expect(sub.claims).toMatchObject({ sub: 'key:alice', scope: ['flights/book'] });
    expect(chainOf(sub.claims!.act)).toEqual(['agent:booker', 'agent:travel']);
    expect(issueAgentToken(c, { agent: 'booker', clientId: 'x', subjectToken: sub.token }).error).toMatch(/maxDelegationDepth \(2\)/);
    expect(issueAgentToken(conf({ maxDelegationDepth: 1 }), { agent: 'booker', clientId: 'x', subjectToken: t.token }).status).toBe(403);
    expect(introspect(c, sub.token!)).toMatchObject({ active: true, sub: 'key:alice', scope: 'flights/book', chain: ['agent:booker', 'agent:travel'] });
    agentState.revoked.add(t.claims!.jti);
    expect(introspect(c, t.token!)).toEqual({ active: false, reason: 'revoked' });
    expect(issueAgentToken(c, { agent: 'booker', clientId: 'x', subjectToken: t.token }).error).toBe('subjectToken: revoked');
  });

  it('end to end: exchange, scoped agent call, requireAgentFor (-32019), admin introspect / revoke', async () => {
    h = await startFeatureGw({
      auth: { strategy: 'api-key', apiKeys: ['op', { key: 'alice-key', name: 'alice', servers: ['fake'] }, { key: 'bob-key', name: 'bob', servers: ['fake'] }] },
      agentIdentity: { signingKey: KEY, requireAgentFor: ['fake/echo'], agents: [{ id: 'helper', tools: ['fake/*'], delegators: ['key:alice'] }] },
    } as never);
    const feat = (key: string, path: string, body: unknown) =>
      fetch(`${h!.base}/api/v1/features/agent-identity/${path}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: (await r.json()) as any })); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await feat('bob-key', 'token', { agent: 'helper' })).status).toBe(403);
    const tok = await feat('alice-key', 'token', { agent: 'helper', tools: ['fake/echo'] });
    expect(tok.status).toBe(200);
    expect(tok.body).toMatchObject({ token_type: 'agent+jwt', scope: 'fake/echo', sub: 'key:alice', act: { sub: 'agent:helper' }, expires_in: 900 });
    // Direct call to a requireAgentFor tool is refused with -32019.
    const direct = await fetch(`${h.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: 'Bearer alice-key', 'content-type': 'application/json' }, body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: {} }) });
    expect(JSON.stringify(await direct.json())).toContain(String(ERR_AGENT_REQUIRED));
    const call = await feat('alice-key', 'call', { token: tok.body.access_token, server: 'fake', tool: 'echo', arguments: { hi: 1 } });
    expect(call.status).toBe(200);
    expect(call.body).toMatchObject({ success: true, onBehalfOf: 'key:alice', chain: ['agent:helper'] });
    expect((await feat('alice-key', 'call', { token: tok.body.access_token, server: 'fake', tool: 'other' })).status).toBe(403);
    expect((await feat('alice-key', 'call', { token: 'a.b.c', server: 'fake', tool: 'echo' })).status).toBe(401);
    const intro = await h.admin('agent-identity/introspect', { token: tok.body.access_token });
    expect(intro.body).toMatchObject({ active: true, agent: 'helper' });
    const list = await h.admin('agent-identity');
    expect(list.body.tokens).toEqual({ issued: 1, active: 1, revoked: 0 });
    expect(list.body.recent[0]).toMatchObject({ agent: 'helper', calls: 1 });
    expect((await h.admin('agent-identity/revoke', { jti: tok.body.jti })).body).toEqual({ revoked: tok.body.jti, known: true });
    expect((await feat('alice-key', 'call', { token: tok.body.access_token, server: 'fake', tool: 'echo' })).status).toBe(401);
    expect((await fetch(`${h.base}/api/v1/admin/agent-identity`, { headers: { authorization: 'Bearer alice-key' } })).status).toBe(403);
  });
});
