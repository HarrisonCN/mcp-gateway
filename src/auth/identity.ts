/**
 * One identity context per call (13.1.2).
 *
 * A call has three identity facts, and every module reads them from here instead of guessing from a free-form
 * `clientId` string:
 *
 *  - **subject** — who the call is made FOR: the original caller (the delegator of an agent token, the client that
 *    asked for a replay / debug session / adaptive retry / task graph). Client policy rules, tenancy, quotas, budgets,
 *    data residency, per-tenant credentials, cache partitions, metering and the audit record's `clientId` all key on
 *    the subject. For gateway-internal work (`system` principals) the subject is the component label the caller gave.
 *  - **actors** — who EXECUTES it on the subject's behalf: every delegation hop (`agent:<id>`, outermost delegator
 *    first). Actors can only narrow: their grants are intersected by the central authorizer, and policy rules that
 *    explicitly name an actor may deny or hold the call but never allow what the subject may not do.
 *  - **effective scope** — `principal.scope` ∩ every hop's grant (decided by {@link ./authorizer.authorize}).
 *
 * The single rule for `Principal` vs `clientId`: **the principal is authoritative**. A client principal's `id` is the
 * subject; a `clientId` passed next to it is only a label of the initiating component (`origin`) and never selects a
 * tenant, a quota bucket, a policy rule or a cache partition.
 *
 * Identity keys of token-based clients (13.1.2): `sub` is only unique per issuer. When more than one issuer is
 * trusted (`auth.oauth.issuer` / `authorizationServers`, `auth.jwt.issuer`), client ids carry the issuer:
 * `oauth:<issuer>#<sub>` / `jwt:<issuer>#<sub>`. With a single issuer the id stays `oauth:<sub>` / `jwt:<sub>`.
 *
 * @module auth/identity
 */

import type { Principal } from './authorizer.js';

export interface CallIdentity {
  /** Who the call is made for (undefined only for an anonymous caller without a client id, as before 13.1.2). */
  subject: string | undefined;
  /** Delegation hops acting for the subject (`agent:<id>`), outermost first. Empty for direct calls. */
  actors: string[];
  /** Label of the initiating component when it differs from the subject and the actors (`replay:…`, `debug:…`). */
  origin?: string;
  /** `[subject, ...actors]` — the audit chain. */
  chain: string[];
}

/** Split a delegation hop label (`agent:a > agent:b`, pre-13.1.2 joined form) into hops. */
const hopsOf = (agent: string): string[] => agent.split(' > ').map((s) => s.trim()).filter(Boolean);

/**
 * The identity context of a call made for `principal`, with `label` the client id the call site passed.
 * Pure; never throws.
 */
export function identityOf(principal: Principal | undefined, label?: string): CallIdentity {
  if (!principal || typeof principal.id !== 'string') {
    return { subject: label, actors: [], chain: label ? [label] : [] };
  }
  const actors = (principal.delegation ?? []).flatMap((d) => hopsOf(d.agent));
  let subject: string | undefined;
  if (principal.kind === 'system') subject = label ?? principal.id;
  else subject = principal.id === 'anonymous' && label === undefined ? undefined : principal.id;
  const known = new Set([subject, principal.id, ...actors]);
  const origin = label !== undefined && !known.has(label) ? label : undefined;
  return { subject, actors, ...(origin ? { origin } : {}), chain: [subject ?? 'anonymous', ...actors] };
}

/** The most recent actor of a call (the agent that executes it), or its origin label. */
export const actorOf = (id: CallIdentity): string | undefined => id.actors[id.actors.length - 1] ?? id.origin;

// ── issuer-qualified identity keys ─────────────────────────────────────────────────────────────────────────────────

const asList = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

interface AuthLike {
  strategy?: string;
  jwt?: { issuer?: string | string[] };
  oauth?: { issuer?: string | string[]; authorizationServers?: string[] };
}

/** Issuers whose tokens the configured strategy accepts (empty = issuer not checked). */
export function trustedIssuers(auth: AuthLike | undefined): string[] {
  if (!auth) return [];
  if (auth.strategy === 'oauth2') return asList(auth.oauth?.issuer).length ? asList(auth.oauth?.issuer) : [...(auth.oauth?.authorizationServers ?? [])];
  if (auth.strategy === 'jwt') return asList(auth.jwt?.issuer);
  return [];
}

/** Whether client ids of this auth configuration must carry the token issuer (more than one issuer trusted). */
export const issuerQualified = (auth: AuthLike | undefined): boolean => new Set(trustedIssuers(auth)).size > 1;

/**
 * Client id of a token-authenticated caller: `<prefix>:<sub>`, or `<prefix>:<iss>#<sub>` when several issuers are
 * trusted. Issuer URLs never contain `#` (RFC 8414 §2: no fragment), so the split is unambiguous.
 */
export function tokenClientId(prefix: 'jwt' | 'oauth', subject: string, issuer: string | undefined, qualified: boolean): string {
  return qualified ? `${prefix}:${issuer ?? '(no-issuer)'}#${subject}` : `${prefix}:${subject}`;
}

/** Glob patterns on client ids that are ambiguous under issuer-qualified ids (`oauth:alice`, `jwt:user-*`). */
export function ambiguousClientPatterns(auth: AuthLike | undefined, patterns: Iterable<{ path: string; pattern: string }>): Array<{ path: string; pattern: string }> {
  if (!issuerQualified(auth)) return [];
  const prefix = auth?.strategy === 'oauth2' ? 'oauth:' : 'jwt:';
  const out: Array<{ path: string; pattern: string }> = [];
  for (const p of patterns) {
    if (typeof p.pattern !== 'string' || !p.pattern.startsWith(prefix)) continue;
    const rest = p.pattern.slice(prefix.length);
    if (rest === '*' || rest.includes('#')) continue;
    out.push(p);
  }
  return out;
}

/** Every client-id glob in a raw config (tenant members, policy rules, quotas, budgets, agent delegators). */
export function clientPatternsOf(c: Record<string, unknown>): Array<{ path: string; pattern: string }> {
  const out: Array<{ path: string; pattern: string }> = [];
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
  arr(c.tenants).forEach((t, i) => arr(obj(t).members).forEach((m, j) => out.push({ path: `tenants.${i}.members.${j}.client`, pattern: obj(m).client as string })));
  arr(obj(c.policy).rules).forEach((r, i) => arr(obj(r).clients).forEach((p, j) => out.push({ path: `policy.rules.${i}.clients.${j}`, pattern: p as string })));
  arr(obj(c.quotas).rules).forEach((r, i) => arr(obj(r).clients).forEach((p, j) => out.push({ path: `quotas.rules.${i}.clients.${j}`, pattern: p as string })));
  arr(obj(c.costs).budgets).forEach((r, i) => arr(obj(r).clients).forEach((p, j) => out.push({ path: `costs.budgets.${i}.clients.${j}`, pattern: p as string })));
  arr(obj(c.agentIdentity).agents).forEach((a, i) => arr(obj(a).delegators).forEach((p, j) => out.push({ path: `agentIdentity.agents.${i}.delegators.${j}`, pattern: p as string })));
  return out;
}
