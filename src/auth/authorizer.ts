/**
 * The single authorization decision point for upstream calls (11.1).
 *
 * Every tool call, resource read and prompt fetch — whichever transport or feature module it came from (REST,
 * `/mcp`, the OpenAI bridge, A2A, tool chains, task graphs, agent delegation, plugins, federation, edge autonomy,
 * replays) — reaches the upstream only through {@link ../gateway/invoker.ToolInvoker.invoke}, and `invoke()` calls
 * {@link authorize} before anything else (plugins, policy, hooks, cache). A call without a {@link Principal} is
 * refused (fail-closed), so a new call site cannot forget authorization silently.
 *
 * The effective permission of a call is the intersection of
 *  - the original caller's scope (API key / JWT `servers` + `tools`, tenant confinement and tenant write permission),
 *  - every delegation hop's tool grant (agent tokens: agent `tools` ∩ requested ∩ parent token), and
 *  - the server's own tool filter (`exposed`), then the configured tool policy (in the invoker, after this check).
 *
 * @module auth/authorizer
 */

import { isServerInScope, isToolInScope, type AccessScope } from './scopes.js';
import { canCall } from './tenants.js';
import { globToRegExp } from '../utils/tool-filter.js';

/** JSON-RPC error of a call the authorizer refused (same code as policy denials: REST maps it to 403). */
export const ERR_FORBIDDEN = -32003;

/** One delegation hop: an agent acting for the principal with a narrowed tool grant. */
export interface Delegation {
  /** `agent:<id>` of the acting agent. */
  agent: string;
  /** `server/tool` globs (or exact names) this hop may call. Always intersected with the caller's scope. */
  tools: string[];
  /** Token id (agent identity), for audit. */
  jti?: string;
}

/**
 * Who a call is made for. `client`: an authenticated caller with its effective scope (`scope` undefined =
 * unrestricted operator key / auth off, exactly as on the REST route). `system`: gateway-internal work that an
 * operator configured or triggered (probes, operator replays); it skips client scopes but not the server's tool filter.
 */
export interface Principal {
  kind: 'client' | 'system';
  /** Client id (`key:alice`, `jwt:…`) or `system:<component>`. */
  id: string;
  scope?: AccessScope;
  /** Delegation chain, outermost first: each hop narrows what the principal may call. */
  delegation?: Delegation[];
}

export interface AuthzCall {
  serverId: string;
  /** Tool / prompt name or resource URI. */
  name: string;
  kind: 'tool' | 'resource' | 'prompt';
}

export interface AuthzDenial {
  code: number;
  message: string;
  data: Record<string, unknown>;
}

export interface AuthorizerDeps {
  /** Server tool filter (`servers[].tools`): a tool the server does not expose is never callable. */
  exposed?: (serverId: string, tool: string) => boolean;
}

/** Principal of an authenticated client (scope as set by the auth middleware, tenant confinement applied). */
export const clientPrincipal = (id: string | undefined, scope: AccessScope | undefined, delegation?: Delegation[]): Principal => ({
  kind: 'client',
  id: id ?? 'anonymous',
  ...(scope ? { scope } : {}),
  ...(delegation?.length ? { delegation } : {}),
});

/** Principal of gateway-internal work (`system:<component>`). */
export const systemPrincipal = (component: string): Principal => ({ kind: 'system', id: `system:${component}` });

/** A principal that may call nothing (unknown / removed client). */
export const deniedPrincipal = (id: string | undefined): Principal => ({ kind: 'client', id: id ?? 'anonymous', scope: { servers: [], tools: [] } });

const deny = (message: string, data: Record<string, unknown> = {}): AuthzDenial => ({ code: ERR_FORBIDDEN, message, data: { decision: 'forbidden', ...data } });

/** Whether a delegation grant (list of `server/tool` patterns) covers `server/tool`. */
export function grantCovers(grant: readonly string[], serverId: string, tool: string): boolean {
  const q = `${serverId}/${tool}`;
  return grant.some((g) => g === q || globToRegExp(g).test(q));
}

/** The one authorization decision (undefined = allowed). Pure; never throws. */
export function authorize(p: Principal | undefined, call: AuthzCall, deps: AuthorizerDeps = {}): AuthzDenial | undefined {
  if (!p || (p.kind !== 'client' && p.kind !== 'system') || typeof p.id !== 'string') {
    return deny('Call has no principal: refused (fail-closed authorization)');
  }
  if (call.kind === 'tool' && deps.exposed && !deps.exposed(call.serverId, call.name)) {
    return deny(`Tool "${call.name}" is not exposed by server "${call.serverId}"`, { reason: 'not-exposed' });
  }
  if (p.kind === 'system') return undefined;
  const s = p.scope;
  if (!isServerInScope(s, call.serverId)) return deny(`Server "${call.serverId}" is not allowed for this client`, { reason: 'scope', principal: p.id });
  if (call.kind === 'tool') {
    if (!isToolInScope(s, call.serverId, call.name)) return deny(`Tool "${call.name}" on server "${call.serverId}" is not allowed for this client`, { reason: 'scope', principal: p.id });
    if (!canCall(s, call.serverId)) return deny(`Read-only role: tool calls on server "${call.serverId}" need the admin or owner role`, { reason: 'tenant-role', principal: p.id });
  }
  for (const d of p.delegation ?? []) {
    if (call.kind !== 'tool') return deny(`Delegated principal (${d.agent}) may only call tools`, { reason: 'delegation', agent: d.agent });
    if (!grantCovers(d.tools, call.serverId, call.name)) {
      return deny(`"${call.serverId}/${call.name}" is outside the delegation granted to ${d.agent}`, { reason: 'delegation', agent: d.agent, principal: p.id });
    }
  }
  return undefined;
}

/** Audit chain of a principal: `[original, agent:a, agent:b, …]`. */
export const principalChain = (p: Principal | undefined): string[] => (p ? [p.id, ...(p.delegation ?? []).map((d) => d.agent)] : []);
