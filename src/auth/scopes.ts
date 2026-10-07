/**
 * Per-client access scopes.
 *
 * A scope limits which upstream servers and tools a client (an API key or a
 * JWT) may see and call:
 *  - `servers`: glob patterns matched against server ids.
 *  - `tools`: glob patterns matched against tool names. A pattern containing
 *    `/` is matched against `<serverId>/<tool>` instead, so a tool can be
 *    allowed on one server only (`github/create_issue`, `fs/read_*`).
 *
 * An absent list means "no restriction"; an empty list allows nothing. Both
 * lists must allow a tool for it to be visible / callable. Scopes are applied
 * on top of each server's own `tools` filter, never instead of it.
 *
 * JWTs carry scopes in the `mcp_servers` / `mcp_tools` claims (an array of
 * patterns, or one string of space- or comma-separated patterns).
 *
 * @module auth/scopes
 */

import type { RateLimitConfig, ToolInfo } from '../utils/types.js';
import { globToRegExp } from '../utils/tool-filter.js';

export interface AccessScope {
  /** Optional label (API key `name`), used in client ids and logs. */
  name?: string;
  servers?: string[];
  tools?: string[];
  /** Own rate limit for this client (replaces the global `rateLimit`). */
  rateLimit?: RateLimitConfig;
}

export const JWT_SERVERS_CLAIM = 'mcp_servers';
export const JWT_TOOLS_CLAIM = 'mcp_tools';

const matches = (value: string, patterns: readonly string[]) => patterns.some((p) => globToRegExp(p).test(value));

/** Whether the scope lets the client use `serverId` at all. */
export function isServerInScope(scope: AccessScope | undefined, serverId: string): boolean {
  if (!scope?.servers) return true;
  return matches(serverId, scope.servers);
}

/** Whether the scope lets the client see / call `toolName` on `serverId`. */
export function isToolInScope(scope: AccessScope | undefined, serverId: string, toolName: string): boolean {
  if (!scope) return true;
  if (!isServerInScope(scope, serverId)) return false;
  if (!scope.tools) return true;
  const qualified = `${serverId}/${toolName}`;
  return scope.tools.some((p) => globToRegExp(p).test(p.includes('/') ? qualified : toolName));
}

export function filterToolsByScope<T extends Pick<ToolInfo, 'serverId' | 'name'>>(
  scope: AccessScope | undefined,
  tools: readonly T[],
): T[] {
  if (!scope || (!scope.servers && !scope.tools)) return [...tools];
  return tools.filter((t) => isToolInScope(scope, t.serverId, t.name));
}

/** Whether a scope restricts anything (unrestricted clients skip filtering). */
export function isRestricted(scope: AccessScope | undefined): boolean {
  return !!scope && (scope.servers !== undefined || scope.tools !== undefined);
}

function claimList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (typeof value === 'string') return value.split(/[\s,]+/).filter(Boolean);
  // A malformed claim must not widen access: treat it as "nothing allowed".
  return [];
}

/** Scope from a verified JWT payload (undefined when it carries no scope claims). */
export function scopeFromJwt(payload: unknown): AccessScope | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  const servers = claimList(p[JWT_SERVERS_CLAIM]);
  const tools = claimList(p[JWT_TOOLS_CLAIM]);
  if (servers === undefined && tools === undefined) return undefined;
  const scope: AccessScope = {};
  if (servers !== undefined) scope.servers = servers;
  if (tools !== undefined) scope.tools = tools;
  return scope;
}
