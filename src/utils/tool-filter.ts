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

/** Compile a glob into an anchored RegExp (cached). */
export function globToRegExp(glob: string): RegExp {
  let re = cache.get(glob);
  if (!re) {
    const body = glob
      .split('')
      .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[\\^$.|+()[\]{}]/g, '\\$&')))
      .join('');
    re = new RegExp(`^${body}$`, 's');
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
