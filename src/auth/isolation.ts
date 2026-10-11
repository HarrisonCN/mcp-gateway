/**
 * Tenant isolation (14.2.0): one place that decides which tenant a call acts for, which tenant owns a server, and
 * whether a principal may cross a tenant boundary.
 *
 * **Acting tenant.** Every per-call tenant decision — `{tenant}` credential injection, cost budgets and quotas, the
 * tool / semantic cache partition, policy and call hooks, data residency, the audit record — uses the *acting tenant*:
 * the caller's tenant that is entitled to the called server (the owning tenant, or the grantee of a sharing grant),
 * never simply the caller's first membership (MGW-2026-015) and never a tenant the caller does not belong to.
 *
 * **Isolation** (`tenancy.isolation`, optional; off when the block is absent = the 13.x/14.1 behaviour):
 *
 * ```yaml
 * tenancy:
 *   isolation:
 *     crossTenant: deny          # deny (default) | audit (allow as before, but record every crossing)
 *     grants:                    # explicit, audited sharing; the only way across a tenant boundary
 *       - owner: acme            # tenant that owns the servers
 *         tenants: [labs]        # tenants that may use them (their own role applies)
 *         servers: [shared-kb]   # server id globs (must be owned by `owner`)
 *         access: call           # call (default) | read (catalog only)
 *         reason: "shared knowledge base pilot"
 * ```
 *
 * With isolation on, a server belongs to exactly one tenant: the first tenant (config order) whose `servers` globs
 * match it. Members of other tenants whose globs also match it no longer see or call it unless a grant shares it;
 * a refused crossing is recorded with decision `cross-tenant`, a granted call with `tenant` + `tenantGrant`.
 * Clients that belong to no tenant (operators) are unaffected.
 *
 * @module auth/isolation
 */

import { globToRegExp } from '../utils/tool-filter.js';
import type { GatewayConfig, TenancyConfig, TenancyGrant, TenantConfig, TenantRole } from '../utils/types.js';

const RANK: Record<TenantRole, number> = { viewer: 1, admin: 2, owner: 3 };
const matches = (value: string, patterns: readonly string[]) => patterns.some((p) => globToRegExp(p).test(value));

/** Serializable isolation view carried on a client's scope. */
export interface IsolationView {
  mode: 'deny' | 'audit';
  /** Every tenant's server globs, in config order (ownership). */
  owners: Array<{ id: string; servers: string[] }>;
  grants: TenancyGrant[];
}

export function isolationMode(tenancy: TenancyConfig | undefined): 'off' | 'deny' | 'audit' {
  const iso = tenancy?.isolation;
  if (!iso || iso.enabled === false) return 'off';
  return iso.crossTenant ?? 'deny';
}

export function isolationView(tenants: readonly TenantConfig[] | undefined, tenancy: TenancyConfig | undefined): IsolationView | undefined {
  const mode = isolationMode(tenancy);
  if (mode === 'off' || !tenants?.length) return undefined;
  return { mode, owners: tenants.map((t) => ({ id: t.id, servers: t.servers })), grants: tenancy?.isolation?.grants ?? [] };
}

/** The tenant owning `serverId` (first tenant in config order whose globs match), if any. */
export function ownerOf(owners: ReadonlyArray<{ id: string; servers: readonly string[] }>, serverId: string): string | undefined {
  return owners.find((t) => matches(serverId, t.servers))?.id;
}

export interface Entitlement {
  tenant: string;
  role: TenantRole;
  /** May call tools (role admin/owner and not a read-only grant). */
  call: boolean;
  /** `owner->tenant` when the entitlement comes from a sharing grant. */
  grant?: string;
}

/**
 * The caller's entitlements to an owned server under isolation: its membership of the owner, then grants from the
 * owner to its other tenants. Callable entitlements first (the owner before grantees), so `[0]` is the acting tenant.
 */
export function entitlements(view: IsolationView, memberships: ReadonlyArray<{ id: string; role: TenantRole }>, serverId: string, owner = ownerOf(view.owners, serverId)): Entitlement[] {
  if (!owner) return [];
  const out: Entitlement[] = [];
  const own = memberships.find((m) => m.id === owner);
  if (own) out.push({ tenant: owner, role: own.role, call: RANK[own.role] >= RANK.admin });
  for (const g of view.grants) {
    if (g.owner !== owner || !matches(serverId, g.servers)) continue;
    for (const t of g.tenants) {
      const m = memberships.find((x) => x.id === t);
      if (!m) continue;
      const call = RANK[m.role] >= RANK.admin && (g.access ?? 'call') === 'call';
      const prev = out.find((e) => e.tenant === t);
      if (prev) prev.call ||= call; // several grants to one tenant: the widest access wins
      else out.push({ tenant: t, role: m.role, call, grant: `${owner}->${t}` });
    }
  }
  return out.sort((a, b) => Number(b.call) - Number(a.call));
}

export interface IsolationDecision {
  /** Server visible (catalog, resources, prompts). */
  see: boolean;
  /** Tools callable. */
  call: boolean;
  owner?: string;
  /** True when the server is owned and the decision came from isolation (not the legacy globs). */
  owned: boolean;
}

/**
 * Isolation decision for a tenant member (undefined `view` = isolation off). `legacy` is the pre-14.2 answer from the
 * member's own tenant globs; `audit` mode keeps it (crossings are recorded, not refused).
 */
export function isolationDecision(view: IsolationView, memberships: ReadonlyArray<{ id: string; role: TenantRole }>, serverId: string, legacy: { see: boolean; call: boolean }): IsolationDecision {
  const owner = ownerOf(view.owners, serverId);
  if (!owner) return { ...legacy, owned: false };
  const ents = entitlements(view, memberships, serverId, owner);
  const d = { see: ents.length > 0, call: ents.some((e) => e.call), owner, owned: true };
  if (view.mode === 'audit') return { see: d.see || legacy.see, call: d.call || legacy.call, owner, owned: true };
  return d;
}

/** Whether a call by these memberships to `serverId` crosses a tenant boundary (member of a non-owner tenant only). */
export function crossesBoundary(view: IsolationView, memberships: ReadonlyArray<{ id: string }>, serverId: string): { owner: string } | undefined {
  const owner = ownerOf(view.owners, serverId);
  if (!owner || memberships.some((m) => m.id === owner)) return undefined;
  return { owner };
}

/** Whether a client scope is refused `serverId` as a cross-tenant crossing (owned by a tenant it has no entitlement to). */
export function isCrossTenantRefusal(scope: { isolation?: IsolationView; tenants?: Array<{ id: string; role: TenantRole }>; tenantServers?: string[] } | undefined, serverId: string): boolean {
  if (!scope?.isolation || !scope.tenants || !scope.tenantServers) return false;
  const d = isolationDecision(scope.isolation, scope.tenants, serverId, { see: false, call: false });
  return d.owned && !d.see;
}

// ─── Report ──────────────────────────────────────────────────────────────────

export interface TenancyFinding {
  severity: 'violation' | 'warning' | 'info';
  code: 'isolation-off' | 'overlap-ungranted' | 'overlap-granted' | 'shared-credential' | 'global-cache' | 'unowned-server' | 'grant-unowned-server' | 'pooled-budget' | 'member-glob';
  message: string;
  server?: string;
  tenant?: string;
}

export interface TenancyReport {
  isolation: 'off' | 'deny' | 'audit';
  tenants: Array<{ id: string; members: number; servers: string[] }>;
  servers: Array<{ server: string; owner: string | null; alsoMatchedBy: string[]; grantedTo: string[]; credentials: 'none' | 'per-tenant' | 'shared' }>;
  grants: TenancyGrant[];
  findings: TenancyFinding[];
  /** Violations make the CLI exit 1. */
  violations: number;
}

const injectsShared = (s: GatewayConfig['servers'][number]): 'none' | 'per-tenant' | 'shared' => {
  const inj = s.inject ?? [];
  const refs = [...inj.map((i) => i.ref), ...Object.values(s.env ?? {}), ...Object.values((s as { headers?: Record<string, string> }).headers ?? {})].filter((v) => typeof v === 'string' && v.includes('secret://'));
  if (!refs.length) return 'none';
  return inj.length && inj.every((i) => i.ref.includes('{tenant}')) && refs.length === inj.length ? 'per-tenant' : 'shared';
};

/** Static isolation report of a config (`mcp-gateway tenancy report`). Pure. */
export function tenancyReport(cfg: GatewayConfig): TenancyReport {
  const tenants = cfg.tenants ?? [];
  const mode = isolationMode(cfg.tenancy);
  const grants = cfg.tenancy?.isolation?.grants ?? [];
  const findings: TenancyFinding[] = [];
  if (tenants.length && mode === 'off') findings.push({ severity: 'warning', code: 'isolation-off', message: 'tenancy.isolation is not configured: overlapping tenant globs share servers implicitly (add `tenancy: { isolation: {} }` to deny cross-tenant access by default)' });
  const servers = (cfg.servers ?? []).map((s) => {
    const matched = tenants.filter((t) => matches(s.id, t.servers)).map((t) => t.id);
    const owner = matched[0] ?? null;
    const grantedTo = owner ? [...new Set(grants.filter((g) => g.owner === owner && matches(s.id, g.servers)).flatMap((g) => g.tenants))] : [];
    const credentials = injectsShared(s);
    const alsoMatchedBy = matched.slice(1);
    for (const t of alsoMatchedBy) {
      if (grantedTo.includes(t)) findings.push({ severity: 'info', code: 'overlap-granted', server: s.id, tenant: t, message: `server "${s.id}" (owner ${owner}) is shared with tenant "${t}" by an explicit grant` });
      else if (mode === 'deny') findings.push({ severity: 'info', code: 'overlap-granted', server: s.id, tenant: t, message: `server "${s.id}" also matches tenant "${t}"'s globs; isolation denies "${t}" (owner ${owner})` });
      else findings.push({ severity: 'violation', code: 'overlap-ungranted', server: s.id, tenant: t, message: `server "${s.id}" is owned by "${owner}" but tenant "${t}" reaches it through overlapping globs without a grant${mode === 'audit' ? ' (audit mode: allowed and recorded)' : ''}` });
    }
    const sharedWith = mode === 'off' ? alsoMatchedBy : mode === 'audit' ? [...new Set([...alsoMatchedBy, ...grantedTo])] : grantedTo;
    if (credentials === 'shared' && sharedWith.length) findings.push({ severity: 'warning', code: 'shared-credential', server: s.id, message: `server "${s.id}" uses one credential for tenants ${[owner, ...sharedWith].join(', ')}; use an \`inject\` reference with {tenant} for per-tenant credentials` });
    if (!owner && tenants.length) findings.push({ severity: 'info', code: 'unowned-server', server: s.id, message: `server "${s.id}" belongs to no tenant (operators only)` });
    return { server: s.id, owner, alsoMatchedBy, grantedTo, credentials };
  });
  for (const g of grants) {
    const ownsAny = servers.some((s) => s.owner === g.owner && matches(s.server, g.servers));
    if (!ownsAny) findings.push({ severity: 'warning', code: 'grant-unowned-server', tenant: g.owner, message: `grant ${g.owner} -> ${g.tenants.join(', ')} (${g.servers.join(', ')}) matches no server owned by "${g.owner}"` });
  }
  const sem = (cfg as { features?: { semanticCache?: { enabled?: boolean; scope?: string } } }).features?.semanticCache;
  if (sem && sem.enabled !== false && sem.scope === 'global' && tenants.length) findings.push({ severity: 'warning', code: 'global-cache', message: 'features.semanticCache.scope is "global": semantic cache entries are shared across tenants' });
  for (const b of (cfg.costs as { budgets?: Array<{ name: string; tenants?: string[]; clients?: string[]; perClient?: boolean }> } | undefined)?.budgets ?? []) {
    if (!b.tenants?.length && !b.perClient && !b.clients?.length && tenants.length) findings.push({ severity: 'info', code: 'pooled-budget', message: `costs budget "${b.name}" is pooled across all tenants` });
  }
  for (const t of tenants) for (const m of t.members ?? []) if (m.client === '*') findings.push({ severity: 'warning', code: 'member-glob', tenant: t.id, message: `tenant "${t.id}" enrols every client ("*")` });
  return {
    isolation: mode,
    tenants: tenants.map((t) => ({ id: t.id, members: t.members?.length ?? 0, servers: servers.filter((s) => s.owner === t.id).map((s) => s.server) })),
    servers,
    grants,
    findings,
    violations: findings.filter((f) => f.severity === 'violation').length,
  };
}

/** Human-readable report. */
export function formatTenancyReport(r: TenancyReport): string {
  const lines = [`Tenant isolation: ${r.isolation}`, '', 'Servers:'];
  for (const s of r.servers) lines.push(`  ${s.server.padEnd(24)} owner ${s.owner ?? '(none)'}${s.alsoMatchedBy.length ? `  also matched by ${s.alsoMatchedBy.join(', ')}` : ''}${s.grantedTo.length ? `  granted to ${s.grantedTo.join(', ')}` : ''}  credentials ${s.credentials}`);
  lines.push('', `Grants: ${r.grants.length ? '' : '(none)'}`);
  for (const g of r.grants) lines.push(`  ${g.owner} -> ${g.tenants.join(', ')}: ${g.servers.join(', ')} (${g.access ?? 'call'})${g.reason ? ` — ${g.reason}` : ''}`);
  lines.push('', `Findings: ${r.findings.length ? '' : '(none)'}`);
  for (const f of r.findings) lines.push(`  [${f.severity}] ${f.code}: ${f.message}`);
  lines.push('', r.violations ? `${r.violations} violation(s)` : 'No violations');
  return lines.join('\n');
}

/** Validation message for a tenancy block against the tenants (undefined = valid). */
export function invalidTenancy(tenancy: TenancyConfig | undefined, tenants: readonly TenantConfig[] | undefined): string | undefined {
  const ids = new Set((tenants ?? []).map((t) => t.id));
  for (const g of tenancy?.isolation?.grants ?? []) {
    if (!ids.has(g.owner)) return `tenancy.isolation.grants: unknown tenant "${g.owner}"`;
    for (const t of g.tenants) {
      if (!ids.has(t)) return `tenancy.isolation.grants: unknown tenant "${t}"`;
      if (t === g.owner) return `tenancy.isolation.grants: tenant "${t}" cannot be granted its own servers (a grant to itself)`;
    }
  }
  return undefined;
}
