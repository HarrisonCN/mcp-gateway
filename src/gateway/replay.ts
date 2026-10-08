/**
 * Request capture, replay and structural diffs (3.2).
 *
 * The audit log keeps metadata only. With `replay.enabled` the gateway also keeps the redacted arguments (and,
 * unless `replay.results: false`, the result) of the most recent calls in memory, keyed by the request id of the
 * history / audit record, so the dashboard can show a call in full and replay it — with the same or edited
 * arguments, through the normal pipeline (auth, scopes, policy, quotas) — and diff the two responses.
 *
 * Captured payloads are redacted with the gateway's secret patterns (`security.redactPatterns` included) and
 * truncated at `replay.maxBytes`; a truncated payload cannot be replayed.
 *
 * @module gateway/replay
 */

import type { ReplayConfig } from '../utils/types.js';
import { redactValue } from '../security/redact.js';

export interface CapturedCall {
  id: string;
  timestamp: string;
  serverId: string;
  tool: string;
  kind: 'tool' | 'resource' | 'prompt';
  clientId?: string;
  via: 'rest' | 'mcp';
  durationMs: number;
  success: boolean;
  /** Redacted arguments (undefined when truncated). */
  arguments?: Record<string, unknown>;
  /** Redacted result / error (omitted with `replay.results: false`). */
  result?: unknown;
  error?: { code: number; message: string };
  truncated?: boolean;
  /** Request id this call replayed, when it was a replay. */
  replayOf?: string;
}

export const DEFAULT_REPLAY = { maxEntries: 500, maxBytes: 64 * 1024, results: true } as const;

const size = (v: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(v) ?? '');
  } catch {
    return Infinity;
  }
};

export class ReplayRecorder {
  private readonly entries = new Map<string, CapturedCall>();

  constructor(private readonly config: () => ReplayConfig | undefined) {}

  get enabled(): boolean {
    return this.config()?.enabled === true;
  }

  capture(call: Omit<CapturedCall, 'truncated' | 'arguments' | 'result'> & { arguments: unknown; result?: unknown }): void {
    const cfg = this.config();
    if (cfg?.enabled !== true) return;
    const maxBytes = cfg.maxBytes ?? DEFAULT_REPLAY.maxBytes;
    const entry: CapturedCall = { ...call, arguments: undefined, result: undefined };
    const args = redactValue(call.arguments ?? {}) as Record<string, unknown>;
    if (size(args) <= maxBytes) entry.arguments = args;
    else entry.truncated = true;
    if ((cfg.results ?? DEFAULT_REPLAY.results) && call.result !== undefined) {
      const res = redactValue(call.result);
      if (size(res) <= maxBytes) entry.result = res;
      else entry.truncated = true;
    } else delete entry.result;
    if (entry.arguments === undefined) delete entry.arguments;
    this.entries.set(entry.id, entry);
    const max = cfg.maxEntries ?? DEFAULT_REPLAY.maxEntries;
    while (this.entries.size > max) this.entries.delete(this.entries.keys().next().value!);
  }

  get(id: string): CapturedCall | undefined {
    return this.entries.get(id);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

export interface JsonChange {
  /** JSON path, e.g. `content[0].text` (empty = the whole value). */
  path: string;
  change: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

/** Structural diff of two JSON values (object keys by name, arrays by index), at most `limit` changes. */
export function jsonDiff(before: unknown, after: unknown, limit = 200): JsonChange[] {
  const out: JsonChange[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const walk = (a: unknown, b: unknown, path: string) => {
    if (out.length >= limit) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const p = `${path}[${i}]`;
        if (i >= a.length) out.push({ path: p, change: 'added', after: b[i] });
        else if (i >= b.length) out.push({ path: p, change: 'removed', before: a[i] });
        else walk(a[i], b[i], p);
      }
      return;
    }
    if (isObj(a) && isObj(b)) {
      for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        const p = path ? `${path}.${k}` : k;
        if (!(k in a)) out.push({ path: p, change: 'added', after: b[k] });
        else if (!(k in b)) out.push({ path: p, change: 'removed', before: a[k] });
        else walk(a[k], b[k], p);
      }
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path, change: 'changed', before: a, after: b });
  };
  walk(before, after, '');
  return out.slice(0, limit);
}
