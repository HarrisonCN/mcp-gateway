/**
 * Failure scope of a feature module (13.1.1): which tool calls a module would have governed, read from its own config
 * section, so a failed `closed` module refuses only those calls instead of every call of the gateway.
 *
 * The scope is derived defensively from the RAW config section (the module may have failed precisely because its
 * config does not parse): any value that is missing where the module has no default, malformed, or describes the
 * whole gateway (no server / tool / client / tenant restriction) yields `undefined` — **global** — and the caller keeps
 * refusing every call (the 13.1.0 behaviour). Matching mirrors each module's own `before` hook conservatively: a scope
 * may cover more calls than the hook would act on (e.g. `when` conditions of approval flows are ignored), never fewer.
 *
 * @module gateway/failure-scope
 */

import type { GatewayConfig } from '../utils/types.js';
import { globToRegExp } from '../utils/tool-filter.js';
import { manifestEntry } from '../features/manifest.js';

/** What a failure scope is matched against: the target of a tool call and who makes it. */
export interface ScopeCall {
  serverId: string;
  tool: string;
  clientId?: string;
  /** First tenant of the caller (as call hooks see it). */
  tenant?: string;
  principal?: { delegation?: readonly unknown[] };
}

export interface FailureScope {
  /** Human-readable summary for logs / the kernel admin view (`servers: a, b`). */
  describe: string;
  matches(call: ScopeCall): boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
/** A list of non-empty strings, or undefined when `v` is anything else. */
const strList = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0) ? (v as string[]) : undefined);
const any = (globs: readonly string[], s: string) => globs.some((g) => globToRegExp(g).test(s));
const target = (c: ScopeCall) => `${c.serverId}/${c.tool}`;
const client = (c: ScopeCall) => c.clientId ?? 'anonymous';
/** A non-empty list where the module has a default for a missing value (`dflt`). */
const listOr = (v: unknown, dflt: string[]): string[] | undefined => {
  const l = v === undefined ? dflt : strList(v);
  return l && l.length ? l : undefined;
};

type Derive = (section: Obj) => FailureScope | undefined;

const DERIVE: Record<string, Derive> = {
  // dlp hook: `servers` (server globs) restricts it; absent / empty = every server.
  dlp: (s) => {
    const servers = s.servers === undefined ? undefined : strList(s.servers);
    if (!servers?.length) return undefined;
    return { describe: `servers: ${servers.join(', ')}`, matches: (c) => any(servers, c.serverId) };
  },
  // sanitize: `servers` (default ["*"]) minus `exempt` (server/tool globs).
  sanitize: (s) => {
    const servers = listOr(s.servers, ['*']);
    const exempt = s.exempt === undefined ? [] : strList(s.exempt);
    if (!servers || !exempt || (servers.includes('*') && !exempt.length)) return undefined;
    return { describe: `servers: ${servers.join(', ')}${exempt.length ? `; exempt: ${exempt.join(', ')}` : ''}`, matches: (c) => any(servers, c.serverId) && !any(exempt, target(c)) };
  },
  // multimodal: `servers` (default ["*"]).
  multimodal: (s) => {
    const servers = listOr(s.servers, ['*']);
    if (!servers || servers.includes('*')) return undefined;
    return { describe: `servers: ${servers.join(', ')}`, matches: (c) => any(servers, c.serverId) };
  },
  // confidential: `servers[].match` (server globs) are the protected servers.
  confidential: (s) => {
    if (!Array.isArray(s.servers) || !s.servers.length) return undefined;
    const globs: string[] = [];
    for (const r of s.servers) {
      if (!isObj(r) || typeof r.match !== 'string' || !r.match) return undefined;
      globs.push(r.match);
    }
    if (globs.includes('*')) return undefined;
    return { describe: `servers: ${globs.join(', ')}`, matches: (c) => any(globs, c.serverId) };
  },
  // approval flows: `flows[].tools` (server/tool globs), optionally narrowed by `flows[].clients`. `when` is ignored
  // (conservative: a flow's tools are governed whatever the arguments).
  'approval-flows': (s) => {
    if (!Array.isArray(s.flows) || !s.flows.length) return undefined;
    const flows: { tools: string[]; clients?: string[] }[] = [];
    for (const f of s.flows) {
      if (!isObj(f)) return undefined;
      const tools = strList(f.tools);
      const clients = f.clients === undefined ? undefined : strList(f.clients);
      if (!tools?.length || (f.clients !== undefined && !clients)) return undefined;
      flows.push({ tools, ...(clients ? { clients } : {}) });
    }
    if (flows.some((f) => (f.tools.includes('*/*') || f.tools.includes('*')) && !f.clients)) return undefined;
    return {
      describe: `tools: ${[...new Set(flows.flatMap((f) => f.tools))].join(', ')}`,
      matches: (c) => flows.some((f) => any(f.tools, target(c)) && (!f.clients || any(f.clients, client(c)))),
    };
  },
  // agent identity: calls made with an agent delegation token, plus the tools in `requireAgentFor`.
  'agent-identity': (s) => {
    const req = s.requireAgentFor === undefined ? [] : strList(s.requireAgentFor);
    if (!req || req.includes('*') || req.includes('*/*')) return undefined;
    return {
      describe: `agent (delegated) calls${req.length ? `; requireAgentFor: ${req.join(', ')}` : ''}`,
      matches: (c) => !!c.principal?.delegation?.length || (req.length > 0 && any(req, target(c))),
    };
  },
  // privacy: `protect` (server/tool globs).
  privacy: (s) => {
    const protect = s.protect === undefined ? undefined : strList(s.protect);
    if (!protect?.length || protect.includes('*') || protect.includes('*/*')) return undefined;
    return { describe: `protect: ${protect.join(', ')}`, matches: (c) => any(protect, target(c)) };
  },
  // realtime budgets: a call is governed by a budget when every filter the budget sets matches; a budget without
  // `clients` / `tenants` / `tools` governs every call.
  'realtime-budgets': (s) => {
    if (!Array.isArray(s.budgets) || !s.budgets.length) return undefined;
    const rules: { clients?: string[]; tenants?: string[]; tools?: string[] }[] = [];
    for (const b of s.budgets) {
      if (!isObj(b)) return undefined;
      const r: { clients?: string[]; tenants?: string[]; tools?: string[] } = {};
      for (const k of ['clients', 'tenants', 'tools'] as const) {
        if (b[k] === undefined) continue;
        const l = strList(b[k]);
        if (!l?.length) return undefined;
        r[k] = l;
      }
      if (!r.clients && !r.tenants && !r.tools) return undefined;
      rules.push(r);
    }
    return {
      describe: `budgets: ${rules.length}`,
      matches: (c) =>
        rules.some(
          (r) =>
            (!r.clients || any(r.clients, c.clientId ?? '')) &&
            (!r.tenants || any(r.tenants, c.tenant ?? '')) &&
            (!r.tools || r.tools.some((g) => globToRegExp(g).test(g.includes('/') ? target(c) : c.tool))),
        ),
    };
  },
  // console: calls of tenants that are organisations (`orgs`).
  console: (s) => {
    if (!isObj(s.orgs)) return undefined;
    const orgs = Object.keys(s.orgs);
    if (!orgs.length) return undefined;
    return { describe: `orgs: ${orgs.join(', ')}`, matches: (c) => !!c.tenant && orgs.includes(c.tenant) };
  },
  // anomaly: every client except `exempt` (client globs).
  anomaly: (s) => {
    const exempt = s.exempt === undefined ? undefined : strList(s.exempt);
    if (!exempt?.length) return undefined;
    return { describe: `clients except ${exempt.join(', ')}`, matches: (c) => !any(exempt, client(c)) };
  },
};

/**
 * Failure scope of module `id` under `cfg`, or `undefined` = global (the module governs every tool call, or its scope
 * cannot be determined: unknown module, plugin, global policy engine, unparseable config).
 */
export function failureScopeOf(id: string, cfg: GatewayConfig): FailureScope | undefined {
  const derive = DERIVE[id];
  const key = manifestEntry(id)?.activation?.[0];
  if (!derive || !key) return undefined;
  const section = (cfg as unknown as Obj)[key as string];
  if (!isObj(section)) return undefined;
  try {
    return derive(section);
  } catch {
    return undefined;
  }
}
