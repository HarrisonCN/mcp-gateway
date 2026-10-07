/**
 * Tool policy (`policy.rules`): per-client / per-server / per-tool rules with
 * argument conditions, evaluated before every tool call (REST and `/mcp`).
 *
 * Rules are checked in order; the first rule whose conditions all hold
 * decides:
 *  - `deny`    — the call is refused (`403` / JSON-RPC `-32003`);
 *  - `approve` — the call is held until an operator approves it in the
 *                dashboard / `POST /api/v1/approvals/:id/approve` (or it times out);
 *  - `allow`   — the call proceeds (use it to carve exceptions before broader rules).
 * No matching rule → allowed (the default can be flipped with `policy.default`).
 *
 * Conditions: `clients` (globs on the client id, e.g. `key:aura`, `oauth:*`),
 * `servers` (globs on server ids), `tools` (globs on tool names; a pattern
 * with `/` matches `<server>/<tool>`) and `args`: a list of argument matchers,
 * each addressing a value by dotted path (`path`, `options.mode`, `items.0`)
 * with one or more operators (`equals`, `in`, `glob`, `notGlob`, `regex`,
 * `notRegex`, `exists`, `longerThan`, `under` / `notUnder` — path containment after
 * normalising `..`). All of a rule's conditions must hold.
 *
 * @module policy/tool-policy
 */

import type { PolicyArgMatcher, PolicyRule, ToolPolicyConfig } from '../utils/types.js';
import { posix } from 'path';
import { globToRegExp } from '../utils/tool-filter.js';

/** Whether `value` (a path, normalised, `..` resolved) lies inside one of `dirs`. */
export function isUnder(value: string, dirs: readonly string[]): boolean {
  const norm = posix.normalize(value.replace(/\\/g, '/'));
  return dirs.some((d) => {
    const dir = posix.normalize(d.replace(/\\/g, '/')).replace(/\/$/, '');
    return norm === dir || norm.startsWith(`${dir}/`);
  });
}

export type PolicyEffect = 'allow' | 'deny' | 'approve';

export interface PolicyRequest {
  clientId?: string;
  serverId: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  /** Name (or index) of the deciding rule; undefined for the default. */
  rule?: string;
  message?: string;
}

/** Value at a dotted path (`a.b.0.c`). */
export function valueAt(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(part)];
    else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

const asText = (v: unknown): string => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v));

const regexCache = new Map<string, RegExp>();
function re(pattern: string): RegExp {
  let r = regexCache.get(pattern);
  if (!r) {
    r = new RegExp(pattern);
    if (regexCache.size > 1000) regexCache.clear();
    regexCache.set(pattern, r);
  }
  return r;
}

/** Whether one argument matcher holds for `args`. */
export function argMatches(m: PolicyArgMatcher, args: Record<string, unknown>): boolean {
  const v = valueAt(args, m.path);
  const present = v !== undefined;
  if (m.exists !== undefined && m.exists !== present) return false;
  const text = asText(v);
  if (m.equals !== undefined && !(present && (v === m.equals || text === String(m.equals)))) return false;
  if (m.in !== undefined && !(present && m.in.some((x) => v === x || text === String(x)))) return false;
  if (m.glob !== undefined && !(present && m.glob.some((g) => globToRegExp(g).test(text)))) return false;
  if (m.notGlob !== undefined && present && m.notGlob.some((g) => globToRegExp(g).test(text))) return false;
  if (m.notGlob !== undefined && !present) return false;
  if (m.regex !== undefined && !(present && re(m.regex).test(text))) return false;
  if (m.notRegex !== undefined && (!present || re(m.notRegex).test(text))) return false;
  if (m.longerThan !== undefined && !(present && text.length > m.longerThan)) return false;
  if (m.under !== undefined && !(present && isUnder(text, m.under))) return false;
  if (m.notUnder !== undefined && (!present || isUnder(text, m.notUnder))) return false;
  return true;
}

const any = (value: string | undefined, patterns: string[] | undefined) =>
  patterns === undefined || (value !== undefined && patterns.some((p) => globToRegExp(p).test(value)));

export function ruleMatches(rule: PolicyRule, req: PolicyRequest): boolean {
  if (!any(req.clientId ?? 'anonymous', rule.clients)) return false;
  if (!any(req.serverId, rule.servers)) return false;
  if (rule.tools && !rule.tools.some((p) => globToRegExp(p).test(p.includes('/') ? `${req.serverId}/${req.tool}` : req.tool))) {
    return false;
  }
  return (rule.args ?? []).every((m) => argMatches(m, req.args));
}

/** Evaluate `policy.rules` for one call. */
export function evaluatePolicy(policy: ToolPolicyConfig | undefined, req: PolicyRequest): PolicyDecision {
  const rules = policy?.rules ?? [];
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!;
    if (ruleMatches(rule, req)) return { effect: rule.effect, rule: rule.name ?? `#${i + 1}`, message: rule.message };
  }
  return { effect: policy?.default ?? 'allow' };
}

/** Validate rules (regexes compile); returns an error message or undefined. */
export function invalidPolicy(policy: ToolPolicyConfig | undefined): string | undefined {
  for (const [i, rule] of (policy?.rules ?? []).entries()) {
    for (const m of rule.args ?? []) {
      for (const p of [m.regex, m.notRegex]) {
        if (p === undefined) continue;
        try {
          new RegExp(p);
        } catch (err) {
          return `policy.rules[${i}] (${rule.name ?? 'unnamed'}): invalid regex "${p}": ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }
  }
  return undefined;
}
