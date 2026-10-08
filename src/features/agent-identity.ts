/**
 * Agent identity & delegated auth (8.1): first-class identities for AI agents and scoped, short-lived delegation
 * tokens that let an agent act **on behalf of** a user (OAuth 2.0 token exchange, RFC 8693 `act` claim semantics).
 *
 * ```yaml
 * agentIdentity:
 *   signingKey: ${AGENT_TOKEN_KEY}       # HMAC-SHA256 key, ≥ 32 characters
 *   issuer: mcp-gateway                  # `iss` of issued tokens
 *   tokenTtlSeconds: 900                 # default / maximum lifetime
 *   maxDelegationDepth: 2                # agent → sub-agent chains
 *   requireAgentFor: ["payments/*"]      # server/tool globs callable only with an agent token (-32019 otherwise)
 *   agents:
 *     - { id: travel-bot, name: Travel bot, tools: ["flights/*", "hotels/search"], delegators: ["key:alice", "jwt:*"] }
 * ```
 *
 * Flow: a user (any authenticated client listed in the agent's `delegators`) exchanges its own credentials for a
 * delegation token: `POST /api/v1/features/agent-identity/token` `{ agent, tools?, ttlSeconds?, subjectToken? }`.
 * The token's scope is the intersection of the agent's `tools` and the requested `tools`; `sub` is the user, `act`
 * the agent (nested for sub-agent chains via `subjectToken`, scope narrowed at each hop). The agent then calls tools with
 * `POST /api/v1/features/agent-identity/call` `{ token, server, tool, arguments? }`; the call runs through the full
 * pipeline as client `agent:<id>` and the audit trail records `sub` and the delegation chain.
 *
 * Operators: `GET /api/v1/admin/agent-identity` (agents, issued / active / revoked counts, recent tokens),
 * `POST /api/v1/admin/agent-identity/introspect` `{ token }` (RFC 7662 shape), `POST …/revoke` `{ jti }`.
 *
 * @module features/agent-identity
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { registerFeature, objectBody, badRequest, clientIdOf } from '../gateway/features.js';
import { registerCallHook } from '../gateway/hooks.js';
import { globToRegExp } from '../utils/tool-filter.js';
import type { GatewayConfig } from '../utils/types.js';

/** JSON-RPC error: the tool needs an agent delegation token (8.1). */
export const ERR_AGENT_REQUIRED = -32019;

const Agent = z
  .object({
    id: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/),
    name: z.string().optional(),
    tools: z.array(z.string().min(1)).min(1),
    delegators: z.array(z.string().min(1)).default(['*']),
    enabled: z.boolean().default(true),
  })
  .strict();

export const AgentIdentitySchema = z
  .object({
    enabled: z.boolean().default(true),
    signingKey: z.string().min(32, 'signingKey must be at least 32 characters'),
    issuer: z.string().min(1).default('mcp-gateway'),
    tokenTtlSeconds: z.number().int().min(10).max(86_400).default(900),
    maxDelegationDepth: z.number().int().min(1).max(8).default(2),
    requireAgentFor: z.array(z.string().min(1)).default([]),
    agents: z.array(Agent).default([]),
  })
  .strict()
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.agents.forEach((a, i) => {
      if (seen.has(a.id)) ctx.addIssue({ code: 'custom', path: ['agents', i, 'id'], message: `duplicate agent id "${a.id}"` });
      seen.add(a.id);
    });
  });
export type AgentIdentityConfig = z.input<typeof AgentIdentitySchema>;
type Cfg = z.output<typeof AgentIdentitySchema>;

export interface Actor {
  sub: string;
  act?: Actor;
}
export interface AgentTokenClaims {
  iss: string;
  /** The user the agent acts for. */
  sub: string;
  /** The acting agent (`agent:<id>`), nested for chains (RFC 8693 §4.1). */
  act: Actor;
  /** Agent id (innermost actor). */
  agent: string;
  /** server/tool globs the token may call. */
  scope: string[];
  iat: number;
  exp: number;
  jti: string;
}

const settings = (cfg: GatewayConfig): Cfg | undefined => {
  if (!cfg.agentIdentity) return undefined;
  const c = AgentIdentitySchema.parse(cfg.agentIdentity);
  return c.enabled ? c : undefined;
};

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const sign = (key: string, data: string) => createHmac('sha256', key).update(data).digest('base64url');

/** Sign claims as a compact JWS (HS256). */
export function signAgentToken(claims: AgentTokenClaims, key: string): string {
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'agent+jwt' }));
  const body = b64(JSON.stringify(claims));
  return `${head}.${body}.${sign(key, `${head}.${body}`)}`;
}

/** Verify a token's signature, issuer and expiry; returns the claims or an error string. */
export function verifyAgentToken(token: string, key: string, issuer: string, now = Date.now()): { claims?: AgentTokenClaims; error?: string } {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) return { error: 'malformed token' };
  const want = Buffer.from(sign(key, `${parts[0]}.${parts[1]}`));
  const got = Buffer.from(parts[2]!);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { error: 'bad signature' };
  let claims: AgentTokenClaims;
  try {
    const head = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as { alg?: string; typ?: string };
    if (head.alg !== 'HS256' || head.typ !== 'agent+jwt') return { error: 'unsupported token type' };
    claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as AgentTokenClaims;
  } catch {
    return { error: 'malformed token' };
  }
  if (claims.iss !== issuer) return { error: 'wrong issuer' };
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return { error: 'token expired' };
  return { claims };
}

/** Depth of a delegation chain (1 = a single agent). */
export const chainDepth = (a: Actor | undefined): number => (a ? 1 + chainDepth(a.act) : 0);
/** `agent:a → agent:b → …` (outermost first). */
export const chainOf = (a: Actor | undefined): string[] => (a ? [a.sub, ...chainOf(a.act)] : []);

const matchAny = (globs: string[], s: string) => globs.some((g) => globToRegExp(g).test(s));

/** Scope narrowing: requested globs kept only when every tool they could match is inside `allowed` (exact containment by glob test). */
export function narrowScope(allowed: string[], requested?: string[]): string[] {
  if (!requested?.length) return [...allowed];
  return requested.filter((r) => allowed.includes(r) || matchAny(allowed, r));
}

interface Issued {
  jti: string;
  agent: string;
  sub: string;
  chain: string[];
  scope: string[];
  issuedAt: string;
  expiresAt: string;
  calls: number;
}

/** Runtime state (issued tokens and revocations); exported for tests. */
export const agentState = {
  issued: new Map<string, Issued>(),
  revoked: new Set<string>(),
  reset() {
    this.issued.clear();
    this.revoked.clear();
  },
};

function prune(now = Date.now()) {
  for (const [k, v] of agentState.issued) if (Date.parse(v.expiresAt) < now - 3_600_000) agentState.issued.delete(k);
  if (agentState.issued.size > 10_000) {
    const old = [...agentState.issued.keys()].slice(0, agentState.issued.size - 10_000);
    for (const k of old) agentState.issued.delete(k);
  }
}

export interface IssueRequest {
  agent: string;
  /** Authenticated client asking for the token (the user, or an agent presenting `subjectToken`). */
  clientId: string;
  tools?: string[];
  ttlSeconds?: number;
  subjectToken?: string;
}

/** Token exchange: returns a signed delegation token or an error (status + message). */
export function issueAgentToken(c: Cfg, req: IssueRequest, now = Date.now()): { token?: string; claims?: AgentTokenClaims; status?: number; error?: string } {
  const agent = c.agents.find((a) => a.id === req.agent && a.enabled);
  if (!agent) return { status: 404, error: `unknown agent "${req.agent}"` };
  let sub = req.clientId;
  let act: Actor = { sub: `agent:${agent.id}` };
  let allowed = agent.tools;
  if (req.subjectToken !== undefined) {
    const v = verifyAgentToken(req.subjectToken, c.signingKey, c.issuer, now);
    if (!v.claims) return { status: 401, error: `subjectToken: ${v.error}` };
    if (agentState.revoked.has(v.claims.jti)) return { status: 401, error: 'subjectToken: revoked' };
    sub = v.claims.sub;
    act = { sub: `agent:${agent.id}`, act: v.claims.act };
    const parent = v.claims.scope;
    allowed = agent.tools.filter((t) => parent.includes(t) || matchAny(parent, t));
    if (chainDepth(act) > c.maxDelegationDepth) return { status: 403, error: `delegation chain longer than maxDelegationDepth (${c.maxDelegationDepth})` };
  } else if (!matchAny(agent.delegators, req.clientId)) {
    return { status: 403, error: `client "${req.clientId}" may not delegate to agent "${agent.id}"` };
  }
  const scope = narrowScope(allowed, req.tools);
  if (!scope.length) return { status: 403, error: 'requested tools are outside the agent\'s scope' };
  const ttl = Math.min(req.ttlSeconds ?? c.tokenTtlSeconds, c.tokenTtlSeconds);
  const iat = Math.floor(now / 1000);
  const claims: AgentTokenClaims = { iss: c.issuer, sub, act, agent: agent.id, scope, iat, exp: iat + ttl, jti: randomUUID() };
  prune(now);
  agentState.issued.set(claims.jti, { jti: claims.jti, agent: agent.id, sub, chain: chainOf(act), scope, issuedAt: new Date(iat * 1000).toISOString(), expiresAt: new Date(claims.exp * 1000).toISOString(), calls: 0 });
  return { token: signAgentToken(claims, c.signingKey), claims };
}

/** RFC 7662-style introspection. */
export function introspect(c: Cfg, token: string, now = Date.now()): Record<string, unknown> {
  const v = verifyAgentToken(token, c.signingKey, c.issuer, now);
  if (!v.claims || agentState.revoked.has(v.claims.jti)) return { active: false, ...(v.error ? { reason: v.error } : { reason: 'revoked' }) };
  const k = v.claims;
  return { active: true, iss: k.iss, sub: k.sub, act: k.act, agent: k.agent, scope: k.scope.join(' '), exp: k.exp, iat: k.iat, jti: k.jti, chain: chainOf(k.act) };
}

registerCallHook({
  id: 'agent-identity',
  before: (call, cfg) => {
    const c = settings(cfg);
    if (!c || !c.requireAgentFor.length) return;
    const name = `${call.serverId}/${call.tool}`;
    if (!matchAny(c.requireAgentFor, name)) return;
    if (call.clientId?.startsWith('agent:')) return;
    return { refuse: { code: ERR_AGENT_REQUIRED, message: `Tool "${name}" requires an agent delegation token (agentIdentity.requireAgentFor)`, data: { tool: name } } };
  },
});

registerFeature({
  id: 'agent-identity',
  since: '8.1.0',
  summary: 'Agent identity & delegated auth: agent registry, on-behalf-of delegation tokens (RFC 8693 act chains), scoped agent calls',
  mount(router, ctx) {
    router.get('/', (_req, res) => {
      const c = settings(ctx.config());
      if (!c) return void res.json({ enabled: false, agents: [], tokens: { issued: 0, active: 0, revoked: 0 }, recent: [] });
      const now = Date.now();
      const all = [...agentState.issued.values()];
      res.json({
        enabled: true,
        issuer: c.issuer,
        tokenTtlSeconds: c.tokenTtlSeconds,
        maxDelegationDepth: c.maxDelegationDepth,
        requireAgentFor: c.requireAgentFor,
        agents: c.agents.map((a) => ({ id: a.id, name: a.name ?? a.id, tools: a.tools, delegators: a.delegators, enabled: a.enabled, activeTokens: all.filter((t) => t.agent === a.id && Date.parse(t.expiresAt) > now && !agentState.revoked.has(t.jti)).length })),
        tokens: { issued: all.length, active: all.filter((t) => Date.parse(t.expiresAt) > now && !agentState.revoked.has(t.jti)).length, revoked: agentState.revoked.size },
        recent: all.slice(-20).reverse().map((t) => ({ ...t, revoked: agentState.revoked.has(t.jti) })),
      });
    });
    router.post('/introspect', (req, res) => {
      const c = settings(ctx.config());
      if (!c) return badRequest(res, 'agentIdentity is not configured');
      const b = objectBody(req, res);
      if (!b) return;
      if (typeof b.token !== 'string') return badRequest(res, 'Body must be { "token": "<agent token>" }');
      res.json(introspect(c, b.token));
    });
    router.post('/revoke', (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      if (typeof b.jti !== 'string' || !b.jti) return badRequest(res, 'Body must be { "jti": "<token id>" }');
      agentState.revoked.add(b.jti);
      res.json({ revoked: b.jti, known: agentState.issued.has(b.jti) });
    });
  },
  mountClient(router, ctx) {
    router.post('/token', (req, res) => {
      const c = settings(ctx.config());
      if (!c) return void res.status(404).json({ error: 'Not Found', message: 'agentIdentity is not configured' });
      const b = objectBody(req, res);
      if (!b) return;
      if (typeof b.agent !== 'string') return badRequest(res, 'Body must be { "agent": "<id>", "tools"?: [...], "ttlSeconds"?, "subjectToken"? }');
      if (b.tools !== undefined && (!Array.isArray(b.tools) || b.tools.some((t) => typeof t !== 'string'))) return badRequest(res, '"tools" must be an array of strings');
      const r = issueAgentToken(c, { agent: b.agent, clientId: clientIdOf(req) ?? 'anonymous', tools: b.tools as string[] | undefined, ttlSeconds: typeof b.ttlSeconds === 'number' ? b.ttlSeconds : undefined, subjectToken: typeof b.subjectToken === 'string' ? b.subjectToken : undefined });
      if (!r.token) return void res.status(r.status ?? 400).json({ error: r.status === 404 ? 'Not Found' : r.status === 401 ? 'Unauthorized' : 'Forbidden', message: r.error });
      res.json({ access_token: r.token, token_type: 'agent+jwt', issued_token_type: 'urn:ietf:params:oauth:token-type:jwt', expires_in: r.claims!.exp - r.claims!.iat, scope: r.claims!.scope.join(' '), sub: r.claims!.sub, act: r.claims!.act, jti: r.claims!.jti });
    });
    router.post('/call', async (req, res) => {
      const c = settings(ctx.config());
      if (!c) return void res.status(404).json({ error: 'Not Found', message: 'agentIdentity is not configured' });
      const b = objectBody(req, res);
      if (!b) return;
      if (typeof b.token !== 'string' || typeof b.server !== 'string' || typeof b.tool !== 'string') return badRequest(res, 'Body must be { "token", "server", "tool", "arguments"? }');
      const v = verifyAgentToken(b.token, c.signingKey, c.issuer);
      if (!v.claims) return void res.status(401).json({ error: 'Unauthorized', message: v.error });
      if (agentState.revoked.has(v.claims.jti)) return void res.status(401).json({ error: 'Unauthorized', message: 'token revoked' });
      const name = `${b.server}/${b.tool}`;
      if (!matchAny(v.claims.scope, name)) return void res.status(403).json({ error: 'Forbidden', message: `"${name}" is outside the token's scope`, scope: v.claims.scope });
      const args = b.arguments && typeof b.arguments === 'object' && !Array.isArray(b.arguments) ? (b.arguments as Record<string, unknown>) : {};
      const rec = agentState.issued.get(v.claims.jti);
      if (rec) rec.calls++;
      const r = await ctx.invoke(b.server, b.tool, args, `agent:${v.claims.agent}`);
      res.status(r.success ? 200 : 502).json({ ...r, onBehalfOf: v.claims.sub, chain: chainOf(v.claims.act) });
    });
  },
});
