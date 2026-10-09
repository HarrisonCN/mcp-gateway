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
import { registerFeature, objectBody, badRequest, clientIdOf, principalOf } from '../gateway/features.js';
import { authorize, clientPrincipal, deniedPrincipal, grantCovers, type Principal } from '../auth/authorizer.js';
import { isRestricted, type AccessScope } from '../auth/scopes.js';
import { registerCallHook } from '../gateway/hooks.js';
import { logger } from '../utils/logger.js';
import { registerMetricSource } from '../monitor/index.js';
import { ERR_FORBIDDEN } from '../auth/authorizer.js';
import { globToRegExp } from '../utils/tool-filter.js';
import type { GatewayConfig } from '../utils/types.js';
import { Agent, AgentIdentityConfig, AgentIdentitySchema, ERR_AGENT_REQUIRED } from './schemas/agent-identity.js';
export { AgentIdentityConfig, AgentIdentitySchema, ERR_AGENT_REQUIRED } from './schemas/agent-identity.js';
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
  /**
   * Delegator scope snapshot at issuance (11.1): used at call time when the delegator's current scope cannot be
   * re-resolved (JWT / OAuth clients). API-key delegators are always re-resolved, so a removed or narrowed key
   * narrows its agents' tokens immediately.
   */
  dsc?: AccessScope;
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

const isGlob = (p: string) => /[*?]/.test(p);

/**
 * Strict scope narrowing (11.1). A requested entry is granted only when
 *  (a) it is exactly identical to an allowed pattern, or
 *  (b) it is a literal `server/tool` name that an allowed pattern matches (a one-element set — containment is exact), or
 *  (c) otherwise it is resolved against the concrete tool catalog (`server/tool` names currently known): the grant is
 *      the concrete tools matched by BOTH the requested and an allowed pattern — never the requested glob itself.
 *
 * Testing an allowed glob against the requested *pattern string* (≤ 11.0) is unsound: `vault/read?` matches the string
 * `vault/read*`, yet `vault/read*` admits longer names. Glob-vs-glob containment is not used.
 */
export function narrowScope(allowed: readonly string[], requested?: readonly string[], catalog: readonly string[] = []): string[] {
  if (!requested?.length) return [...allowed];
  const out = new Set<string>();
  for (const r of requested) {
    if (allowed.includes(r)) out.add(r);
    else if (!isGlob(r)) {
      if (matchAny([...allowed], r)) out.add(r);
    } else {
      const re = globToRegExp(r);
      for (const n of catalog) if (re.test(n) && matchAny([...allowed], n)) out.add(n);
    }
  }
  return [...out];
}

/** Intersect a grant with what `p` may call (concrete expansion of patterns when `p` is restricted). */
export function restrictToPrincipal(grant: readonly string[], p: Principal, catalog: readonly string[]): string[] {
  if (p.kind === 'system' || !isRestricted(p.scope)) return [...grant];
  const ok = (n: string) => {
    const i = n.indexOf('/');
    return i > 0 && !authorize(p, { serverId: n.slice(0, i), name: n.slice(i + 1), kind: 'tool' });
  };
  const out = new Set<string>();
  for (const g of grant) {
    if (!isGlob(g)) {
      if (ok(g)) out.add(g);
    } else {
      const re = globToRegExp(g);
      for (const n of catalog) if (re.test(n) && ok(n)) out.add(n);
    }
  }
  return [...out];
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

/**
 * Runtime state; exported for tests. `issued` / `revoked` are this instance's local cache and listing; the shared
 * state store (11.2) is authoritative for revocation across instances and restarts.
 */
export const agentState = {
  issued: new Map<string, Issued>(),
  revoked: new Set<string>(),
  stats: { revocationChecks: 0, revokedHits: 0, storeErrors: 0, deniedStoreUnavailable: 0, allowedStoreUnavailable: 0 },
  reset() {
    this.issued.clear();
    this.revoked.clear();
    this.stats = { revocationChecks: 0, revokedHits: 0, storeErrors: 0, deniedStoreUnavailable: 0, allowedStoreUnavailable: 0 };
  },
};

type Store = import('../state/store.js').StateStore;
const RKEY = (jti: string) => `agent-identity:revoked:${jti}`;
const IKEY = (jti: string) => `agent-identity:issued:${jti}`;
let lastAlert = 0;
function storeAlert(what: string, err: unknown): void {
  agentState.stats.storeErrors++;
  const t = Date.now();
  if (t - lastAlert > 10_000) {
    lastAlert = t;
    logger.error(`agent-identity: revocation store unavailable (${what}): ${err instanceof Error ? err.message : String(err)} — ALERT: token-authenticated agent calls are affected (metric mcp_gateway_agent_revocation_store_errors_total)`);
  }
}

/** Revoke `jti` in the shared store until `expSec` (unix seconds; + 60 s slack). Throws when the store fails. */
export async function revokeToken(store: Store | undefined, jti: string, expSec: number, now = Date.now()): Promise<void> {
  agentState.revoked.add(jti);
  if (!store) return;
  const ttl = Math.max(1_000, expSec * 1000 - now + 60_000);
  try {
    await store.set(RKEY(jti), '1', ttl);
  } catch (err) {
    storeAlert('revoke', err);
    throw err;
  }
}

/**
 * Whether `jti` is revoked: `true` / `false`, or `'unavailable'` when the store cannot answer and the failure
 * policy is `closed` (callers deny). With `open` an unreachable store answers from the local cache.
 */
export async function isRevoked(store: Store | undefined, jti: string, failureMode: 'closed' | 'open' = 'closed'): Promise<boolean | 'unavailable'> {
  agentState.stats.revocationChecks++;
  if (agentState.revoked.has(jti)) return (agentState.stats.revokedHits++, true);
  if (!store) return false;
  try {
    const v = await store.get(RKEY(jti));
    if (v !== undefined) {
      agentState.revoked.add(jti);
      agentState.stats.revokedHits++;
      return true;
    }
    return false;
  } catch (err) {
    storeAlert('check', err);
    if (failureMode === 'closed') return (agentState.stats.deniedStoreUnavailable++, 'unavailable');
    agentState.stats.allowedStoreUnavailable++;
    return false;
  }
}

registerMetricSource('agent-identity', () => {
  const s = agentState.stats;
  return [
    '# HELP mcp_gateway_agent_revocation_checks_total Agent-token revocation checks',
    '# TYPE mcp_gateway_agent_revocation_checks_total counter',
    `mcp_gateway_agent_revocation_checks_total ${s.revocationChecks}`,
    '# HELP mcp_gateway_agent_revocation_store_errors_total Revocation store failures (alert on any increase)',
    '# TYPE mcp_gateway_agent_revocation_store_errors_total counter',
    `mcp_gateway_agent_revocation_store_errors_total ${s.storeErrors}`,
    '# HELP mcp_gateway_agent_store_unavailable_total Agent calls decided while the revocation store was unreachable',
    '# TYPE mcp_gateway_agent_store_unavailable_total counter',
    `mcp_gateway_agent_store_unavailable_total{decision="deny"} ${s.deniedStoreUnavailable}`,
    `mcp_gateway_agent_store_unavailable_total{decision="allow"} ${s.allowedStoreUnavailable}`,
  ];
});

async function recordIssued(store: Store | undefined, rec: Issued, expSec: number): Promise<void> {
  if (!store) return;
  await store.set(IKEY(rec.jti), JSON.stringify(rec), Math.max(1_000, expSec * 1000 - Date.now() + 3_600_000)).catch((err: unknown) => storeAlert('record', err));
}

function prune(now = Date.now()) {
  for (const [k, v] of agentState.issued) if (Date.parse(v.expiresAt) < now - 3_600_000) agentState.issued.delete(k);
  if (agentState.issued.size > 10_000) {
    const old = [...agentState.issued.keys()].slice(0, agentState.issued.size - 10_000);
    for (const k of old) agentState.issued.delete(k);
  }
}

export interface IssueRequest {
  agent: string;
  /** Delegator's principal (scope) — the token never grants more than it may call (11.1). Default: unrestricted. */
  principal?: Principal;
  /** Concrete `server/tool` names currently known (for strict narrowing of glob requests). */
  catalog?: readonly string[];
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
    // 11.1: strict — agent patterns identical to a parent entry, else concrete tools in both.
    allowed = narrowScope(v.claims.scope, agent.tools, req.catalog);
    if (v.claims.dsc) req = { ...req, principal: clientPrincipal(v.claims.sub, v.claims.dsc) };
    if (chainDepth(act) > c.maxDelegationDepth) return { status: 403, error: `delegation chain longer than maxDelegationDepth (${c.maxDelegationDepth})` };
  } else if (!matchAny(agent.delegators, req.clientId)) {
    return { status: 403, error: `client "${req.clientId}" may not delegate to agent "${agent.id}"` };
  }
  const delegator = req.principal ?? clientPrincipal(sub, undefined);
  const scope = restrictToPrincipal(narrowScope(allowed, req.tools, req.catalog), delegator, req.catalog ?? []);
  if (!scope.length) return { status: 403, error: 'requested tools are outside the agent\'s scope or the delegator\'s own permissions' };
  const ttl = Math.min(req.ttlSeconds ?? c.tokenTtlSeconds, c.tokenTtlSeconds);
  const iat = Math.floor(now / 1000);
  const claims: AgentTokenClaims = { iss: c.issuer, sub, act, agent: agent.id, scope, iat, exp: iat + ttl, jti: randomUUID(), ...(delegator.scope ? { dsc: delegator.scope } : {}) };
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
    if (call.principal?.delegation?.length) return;
    return { refuse: { code: ERR_AGENT_REQUIRED, message: `Tool "${name}" requires an agent delegation token (agentIdentity.requireAgentFor)`, data: { tool: name } } };
  },
});

/**
 * Principal of a delegated call (11.1): the ORIGINAL caller (`sub`) with its current scope — re-resolved for API keys,
 * the issuance snapshot (`dsc`) otherwise; an unknown / removed key may call nothing — plus the token's grant as a
 * delegation hop. The central authorizer intersects both on every call.
 */
export function delegatedPrincipal(ctx: { resolveScope?: (id: string | undefined) => { known: boolean; scope?: AccessScope } | undefined }, k: AgentTokenClaims, _token?: string): Principal {
  const r = ctx.resolveScope?.(k.sub);
  const base = r ? (r.known ? clientPrincipal(k.sub, r.scope) : deniedPrincipal(k.sub)) : clientPrincipal(k.sub, k.dsc ?? { servers: [], tools: [] });
  return { ...base, delegation: [{ agent: chainOf(k.act).join(' > '), tools: k.scope, jti: k.jti }] };
}

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
        revocation: { store: ctx.store?.()?.kind ?? 'memory', failureMode: c.revocation.failureMode, shared: (ctx.store?.()?.kind ?? 'memory') !== 'memory', ...agentState.stats },
        recent: all.slice(-20).reverse().map((t) => ({ ...t, revoked: agentState.revoked.has(t.jti) })),
      });
    });
    router.post('/introspect', async (req, res) => {
      const c = settings(ctx.config());
      if (!c) return badRequest(res, 'agentIdentity is not configured');
      const b = objectBody(req, res);
      if (!b) return;
      if (typeof b.token !== 'string') return badRequest(res, 'Body must be { "token": "<agent token>" }');
      const v = verifyAgentToken(b.token, c.signingKey, c.issuer);
      if (v.claims) {
        const r = await isRevoked(ctx.store?.(), v.claims.jti, c.revocation.failureMode);
        if (r === 'unavailable') return void res.status(503).json({ error: 'Service Unavailable', message: 'revocation store unavailable (agentIdentity.revocation.failureMode: closed)' });
      }
      res.json(introspect(c, b.token));
    });
    router.post('/revoke', async (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      if (typeof b.jti !== 'string' || !b.jti) return badRequest(res, 'Body must be { "jti": "<token id>" }');
      const c = settings(ctx.config());
      const store = ctx.store?.();
      let rec = agentState.issued.get(b.jti);
      if (!rec && store) rec = await store.get(IKEY(b.jti)).then((v) => (v ? (JSON.parse(v) as Issued) : undefined)).catch(() => undefined);
      // Unknown expiry: keep the revocation for the longest lifetime a token can have.
      const exp = rec ? Math.ceil(Date.parse(rec.expiresAt) / 1000) : Math.ceil(Date.now() / 1000) + (c?.tokenTtlSeconds ?? 86_400);
      try {
        await revokeToken(store, b.jti, exp);
      } catch (err) {
        return void res.status(503).json({ error: 'Service Unavailable', message: `revocation not persisted: ${(err as Error).message}`, revokedLocally: true });
      }
      res.json({ revoked: b.jti, known: !!rec, shared: (store?.kind ?? 'memory') !== 'memory' });
    });
  },
  mountClient(router, ctx) {
    router.post('/token', async (req, res) => {
      const c = settings(ctx.config());
      if (!c) return void res.status(404).json({ error: 'Not Found', message: 'agentIdentity is not configured' });
      const b = objectBody(req, res);
      if (!b) return;
      if (typeof b.agent !== 'string') return badRequest(res, 'Body must be { "agent": "<id>", "tools"?: [...], "ttlSeconds"?, "subjectToken"? }');
      if (b.tools !== undefined && (!Array.isArray(b.tools) || b.tools.some((t) => typeof t !== 'string'))) return badRequest(res, '"tools" must be an array of strings');
      if (typeof b.subjectToken === 'string') {
        const sv = verifyAgentToken(b.subjectToken, c.signingKey, c.issuer);
        if (sv.claims) {
          const rv = await isRevoked(ctx.store?.(), sv.claims.jti, c.revocation.failureMode);
          if (rv === 'unavailable') return void res.status(503).json({ error: 'Service Unavailable', message: 'revocation store unavailable (agentIdentity.revocation.failureMode: closed)' });
          if (rv) return void res.status(401).json({ error: 'Unauthorized', message: 'subjectToken: revoked' });
        }
      }
      const r = issueAgentToken(c, { agent: b.agent, clientId: clientIdOf(req) ?? 'anonymous', principal: principalOf(req), catalog: ctx.tools().map((t) => `${t.serverId}/${t.name}`), tools: b.tools as string[] | undefined, ttlSeconds: typeof b.ttlSeconds === 'number' ? b.ttlSeconds : undefined, subjectToken: typeof b.subjectToken === 'string' ? b.subjectToken : undefined });
      if (r.claims) await recordIssued(ctx.store?.(), agentState.issued.get(r.claims.jti)!, r.claims.exp);
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
      const rv = await isRevoked(ctx.store?.(), v.claims.jti, c.revocation.failureMode);
      if (rv === 'unavailable') return void res.status(503).json({ error: 'Service Unavailable', message: 'revocation store unavailable: agent calls are denied (agentIdentity.revocation.failureMode: closed)' });
      if (rv) return void res.status(401).json({ error: 'Unauthorized', message: 'token revoked' });
      const name = `${b.server}/${b.tool}`;
      if (!grantCovers(v.claims.scope, b.server, b.tool)) return void res.status(403).json({ error: 'Forbidden', message: `"${name}" is outside the token's scope`, scope: v.claims.scope });
      const args = b.arguments && typeof b.arguments === 'object' && !Array.isArray(b.arguments) ? (b.arguments as Record<string, unknown>) : {};
      const rec = agentState.issued.get(v.claims.jti);
      if (rec) rec.calls++;
      // 11.1: authorized centrally as delegator scope ∩ token grant (∩ tenant ∩ server filter ∩ policy).
      const r = await ctx.invoke(b.server, b.tool, args, delegatedPrincipal(ctx, v.claims, b.token), `agent:${v.claims.agent}`);
      if (!r.success && r.error?.code === ERR_FORBIDDEN) return void res.status(403).json({ error: 'Forbidden', message: r.error.message, scope: v.claims.scope });
      res.status(r.success ? 200 : 502).json({ ...r, onBehalfOf: v.claims.sub, chain: chainOf(v.claims.act) });
    });
  },
});
