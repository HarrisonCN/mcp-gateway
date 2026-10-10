/**
 * Per-server tool filtering.
 *
 * `servers[].tools.allow` / `servers[].tools.deny` take glob patterns
 * (`*` = any run of characters, `?` = one character, matched against the
 * whole tool name, case-sensitive). A tool is exposed when it matches at least
 * one `allow` pattern (or `allow` is absent/empty) and matches no `deny`
 * pattern — deny always wins.
 *
 * Filtered tools are hidden from discovery and cannot be called through the
 * gateway, even when the caller names the server explicitly.
 *
 * @module utils/tool-filter
 */

import type { ToolFilterConfig } from './types.js';

const cache = new Map<string, RegExp>();

/**
 * Linear-time glob match (`*` = any run, `?` = one UTF-16 code unit, everything else literal; newlines included).
 * 13.5.0 (MGW-2026-013): the ≤ 13.4 regex translation (`*` → `.*`) backtracked catastrophically on patterns such as
 * `*a*a*a…x` — and some patterns are client-supplied (agent-identity token requests), so one request could block the
 * event loop for minutes. This greedy matcher with single-star backtracking is O(pattern × name) worst case.
 */
export function globMatch(glob: string, s: string): boolean {
  let p = 0;
  let i = 0;
  let star = -1;
  let mark = 0;
  while (i < s.length) {
    const c = glob.charCodeAt(p);
    if (p < glob.length && c !== 42 /* * */ && (c === 63 /* ? */ || c === s.charCodeAt(i))) {
      p++;
      i++;
    } else if (p < glob.length && c === 42) {
      star = p++;
      mark = i;
    } else if (star >= 0) {
      p = star + 1;
      i = ++mark;
    } else return false;
  }
  while (p < glob.length && glob.charCodeAt(p) === 42) p++;
  return p === glob.length;
}

/** A RegExp whose `test` is the linear {@link globMatch} (the source stays the equivalent regex, for display only). */
class GlobRegExp extends RegExp {
  constructor(readonly glob: string, body: string) {
    super(`^${body}$`, 's');
  }
  override test(s: string): boolean {
    this.lastIndex = 0;
    return globMatch(this.glob, String(s));
  }
}

/** Compile a glob into an anchored RegExp (cached; `test` is linear — see globMatch). */
export function globToRegExp(glob: string): RegExp {
  let re = cache.get(glob);
  if (!re) {
    // 13.5.0: patterns can be client-supplied, so the compile cache is bounded
    if (cache.size >= 10_000) cache.clear();
    const body = glob
      .split('')
      .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[\\^$.|+()[\]{}]/g, '\\$&')))
      .join('');
    re = new GlobRegExp(glob, body);
    cache.set(glob, re);
  }
  return re;
}

function matchesAny(name: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(name));
}

/** Whether `filter` lets the tool `name` through. No filter = everything. */
export function isToolAllowed(name: string, filter?: ToolFilterConfig): boolean {
  if (!filter) return true;
  if (filter.allow && filter.allow.length > 0 && !matchesAny(name, filter.allow)) return false;
  if (filter.deny && filter.deny.length > 0 && matchesAny(name, filter.deny)) return false;
  return true;
}

/** Keep only the tools `filter` exposes. */
export function filterTools<T extends { name: string }>(tools: readonly T[], filter?: ToolFilterConfig): T[] {
  if (!filter) return [...tools];
  return tools.filter((t) => isToolAllowed(t.name, filter));
}
