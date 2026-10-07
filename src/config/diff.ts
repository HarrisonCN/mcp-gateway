/**
 * Config redaction and structural diffs, used by the admin config API and `mcp-gateway diff / apply`.
 *
 * @module config/diff
 */

import type { GatewayConfig } from '../utils/types.js';

export const REDACTED = '<redacted>';

/** Keys whose values are secrets anywhere in the config. */
const SECRET_KEYS = /^(apiKeys?|key|secret|password|token|clientSecret|signingKey|authorization|webhookSecret)$/i;
/** Maps whose every value is secret (env vars, HTTP headers). */
const SECRET_MAPS = /^(env|headers)$/;

/** Deep copy with secrets replaced by `<redacted>`. */
export function redactConfig<T>(value: T): T {
  const walk = (v: unknown, key?: string): unknown => {
    if (key !== undefined && SECRET_KEYS.test(key)) {
      if (typeof v === 'string') return REDACTED;
      if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? REDACTED : walk(x)));
    }
    if (key !== undefined && SECRET_MAPS.test(key) && v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, typeof x === 'string' ? REDACTED : walk(x, k)]));
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value) as T;
}

/** Put the current values back wherever `next` still holds `<redacted>` (round-tripping GET → PUT). */
export function restoreRedacted(next: unknown, current: unknown): unknown {
  if (next === REDACTED) return current;
  if (Array.isArray(next)) {
    const cur = Array.isArray(current) ? current : [];
    // Servers and similar lists: match by id when entries have one, else by index.
    const byId = new Map(cur.filter((c) => c && typeof c === 'object' && 'id' in c).map((c) => [(c as { id: unknown }).id, c]));
    return next.map((x, i) => restoreRedacted(x, x && typeof x === 'object' && 'id' in x && byId.has((x as { id: unknown }).id) ? byId.get((x as { id: unknown }).id) : cur[i]));
  }
  if (next && typeof next === 'object') {
    const cur = current && typeof current === 'object' ? (current as Record<string, unknown>) : {};
    return Object.fromEntries(Object.entries(next as Record<string, unknown>).map(([k, v]) => [k, restoreRedacted(v, cur[k])]));
  }
  return next;
}

export interface ConfigChange {
  path: string;
  change: 'added' | 'removed' | 'changed';
  /** The change only takes effect after a restart. */
  restart?: boolean;
  before?: unknown;
  after?: unknown;
}

const RESTART_KEYS = new Set(['port', 'host', 'healthCheckIntervalMs', 'health', 'dashboard', 'audit', 'state', 'observability']);
const IGNORED = new Set(['configDir', 'deprecations']);

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

/** Structural diff: one entry per changed top-level section, per server (by id) and per changed server field. */
export function diffConfigs(before: Partial<GatewayConfig>, after: Partial<GatewayConfig>, opts: { redact?: boolean } = {}): ConfigChange[] {
  const red = (v: unknown) => (opts.redact === false ? v : redactConfig(v));
  const rk = (k: string, v: unknown) => (opts.redact === false ? v : (redactConfig({ [k]: v }) as Record<string, unknown>)[k]);
  const out: ConfigChange[] = [];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !IGNORED.has(k)).sort();
  for (const k of keys) {
    const a = (before as Record<string, unknown>)[k];
    const b = (after as Record<string, unknown>)[k];
    if (k === 'servers') {
      const am = new Map((before.servers ?? []).map((s) => [s.id, s]));
      const bm = new Map((after.servers ?? []).map((s) => [s.id, s]));
      for (const [id, s] of bm) {
        const prev = am.get(id);
        if (!prev) out.push({ path: `servers.${id}`, change: 'added', after: red(s) });
        else if (stable(prev) !== stable(s)) {
          const fields = [...new Set([...Object.keys(prev), ...Object.keys(s)])].sort();
          for (const f of fields) {
            const x = (prev as unknown as Record<string, unknown>)[f];
            const y = (s as unknown as Record<string, unknown>)[f];
            if (stable(x) === stable(y)) continue;
            out.push({ path: `servers.${id}.${f}`, change: x === undefined ? 'added' : y === undefined ? 'removed' : 'changed', before: rk(f, x), after: rk(f, y) });
          }
        }
      }
      for (const id of am.keys()) if (!bm.has(id)) out.push({ path: `servers.${id}`, change: 'removed', before: red(am.get(id)) });
      continue;
    }
    if (stable(a) === stable(b)) continue;
    const ch: ConfigChange = { path: k, change: a === undefined ? 'added' : b === undefined ? 'removed' : 'changed', before: rk(k, a), after: rk(k, b) };
    if (RESTART_KEYS.has(k)) ch.restart = true;
    out.push(ch);
  }
  return out;
}

/** Human-readable diff lines (`+`, `-`, `~`; `(restart)` marks changes that need a restart). */
export function formatDiff(changes: ConfigChange[]): string {
  if (changes.length === 0) return 'No changes.';
  const sym = { added: '+', removed: '-', changed: '~' } as const;
  return changes
    .map((c) => {
      const val = (v: unknown) => (v === undefined ? '' : JSON.stringify(v).slice(0, 200));
      const detail = c.change === 'changed' ? `${val(c.before)} → ${val(c.after)}` : val(c.change === 'added' ? c.after : c.before);
      return `${sym[c.change]} ${c.path}${c.restart ? ' (restart)' : ''}${detail ? `: ${detail}` : ''}`;
    })
    .join('\n');
}
