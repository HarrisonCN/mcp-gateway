/**
 * Tenants (workspaces) with role-based access control.
 *
 * A tenant groups upstream servers (`servers` globs) and members. A member is
 * matched by client id glob (`key:alice`, `jwt:user-*`, `oauth:…`) and has one
 * role per tenant:
 *
 *  | role   | sees the tenant's servers | calls tools, manages approvals / cache | manages members |
 *  |--------|:--:|:--:|:--:|
 *  | viewer | ✓ |   |   |
 *  | admin  | ✓ | ✓ |   |
 *  | owner  | ✓ | ✓ | ✓ |
 *
 * A client that belongs to at least one tenant is confined to the union of its
 * tenants' servers (on top of its own key / token scope), and may only call
 * tools on servers of tenants where it is `admin` or `owner`. Clients that
 * belong to no tenant keep their 1.x behaviour (operators).
 *
 * @module auth/tenants
 */

import { globToRegExp } from '../utils/tool-filter.js';
import type { TenantConfig, TenantRole } from '../utils/types.js';
import type { AccessScope } from './scopes.js';

export const ROLE_RANK: Record<TenantRole, number> = { viewer: 1, admin: 2, owner: 3 };

export interface Membership {
  tenant: string;
  name?: string;
  role: TenantRole;
  servers: string[];
}

const matches = (value: string, patterns: readonly string[]) => patterns.some((p) => globToRegExp(p).test(value));

/** The role of a client in a tenant (highest matching member entry). */
export function roleIn(tenant: TenantConfig, clientId: string | undefined): TenantRole | undefined {
  const id = clientId ?? 'anonymous';
  let best: TenantRole | undefined;
  for (const m of tenant.members ?? []) {
    if (globToRegExp(m.client).test(id) && (!best || ROLE_RANK[m.role] > ROLE_RANK[best])) best = m.role;
  }
  return best;
}

export function membershipsOf(tenants: readonly TenantConfig[] | undefined, clientId: string | undefined): Membership[] {
  const out: Membership[] = [];
  for (const t of tenants ?? []) {
    const role = roleIn(t, clientId);
    if (role) out.push({ tenant: t.id, name: t.name, role, servers: t.servers });
  }
  return out;
}

/** Add tenant confinement to a client's scope (unchanged for clients in no tenant). */
export function withTenantScope(
  tenants: readonly TenantConfig[] | undefined,
  clientId: string | undefined,
  scope: AccessScope | undefined,
): AccessScope | undefined {
  const ms = membershipsOf(tenants, clientId);
  if (ms.length === 0) return scope;
  return {
    ...(scope ?? {}),
    tenantServers: [...new Set(ms.flatMap((m) => m.servers))],
    writableServers: [...new Set(ms.filter((m) => ROLE_RANK[m.role] >= ROLE_RANK.admin).flatMap((m) => m.servers))],
    tenants: ms.map((m) => ({ id: m.tenant, role: m.role })),
  };
}

/** Whether the scope may call tools on `serverId` (viewers are read-only). */
export function canCall(scope: AccessScope | undefined, serverId: string): boolean {
  if (!scope?.writableServers) return true;
  return matches(serverId, scope.writableServers);
}

/** Highest role the scope holds in any tenant (undefined = not a tenant member). */
export function highestRole(scope: AccessScope | undefined): TenantRole | undefined {
  let best: TenantRole | undefined;
  for (const t of scope?.tenants ?? []) if (!best || ROLE_RANK[t.role] > ROLE_RANK[best]) best = t.role;
  return best;
}

/**
 * Why a non-operator tenant owner may not grant `client` a role (undefined = allowed).
 *
 * 10.1 hardening: owners manage *their* tenant only. A glob (`*`, `?`) would enrol every matching
 * client — including operators and members of other tenants — and membership confines a client to
 * the tenant's servers, so an owner could demote operators or pull foreign clients into the tenant.
 * Owners therefore grant exact client ids, and never to a client that is currently an operator
 * (`targetIsOperator`). Operators keep full glob support.
 */
export function memberGrantError(client: string, targetIsOperator: boolean): string | undefined {
  if (/[*?]/.test(client)) return 'Only operators can add members by glob; tenant owners must name an exact client id';
  if (targetIsOperator) return 'Tenant owners cannot enrol an operator client';
  return undefined;
}

/** Validation message for a tenants block (undefined = valid). */
export function invalidTenants(tenants: readonly TenantConfig[] | undefined): string | undefined {
  const ids = new Set<string>();
  for (const t of tenants ?? []) {
    if (ids.has(t.id)) return `duplicate tenant id "${t.id}"`;
    ids.add(t.id);
  }
  return undefined;
}
