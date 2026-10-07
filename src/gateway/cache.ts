/**
 * Tool result caching with per-tool opt-in, plus in-flight de-duplication.
 *
 * Only tool calls matched by a `cache.rules` entry are cached: by server /
 * tool glob (`tools: ['search_*']` or `['github/search_*']`), for `ttlSeconds`.
 * The key is the server, the tool, the canonical JSON of the arguments and —
 * with `scope: client` (default) — the caller, so one client never sees
 * another's results. Only successful results that are not `isError` are kept.
 *
 * Identical calls that arrive while the first one is still running share its
 * upstream request (`dedupe`, default on for cached tools; `dedupeOnly: true`
 * de-duplicates without caching).
 *
 * The cache sits after the policy (refused calls never hit it) and before the
 * output filter / `onResponse` hooks (they run on cached results too).
 *
 * @module gateway/cache
 */

import { globToRegExp } from '../utils/tool-filter.js';
import type { CacheConfig, CacheRule, ProxyResponse } from '../utils/types.js';

export interface CacheKeyInput {
  serverId: string;
  tool: string;
  args: Record<string, unknown>;
  clientId?: string;
}

/** Stable JSON (sorted object keys) for cache keys. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

function toolMatches(patterns: string[] | undefined, serverId: string, tool: string): boolean {
  if (!patterns) return true;
  return patterns.some((p) => globToRegExp(p).test(p.includes('/') ? `${serverId}/${tool}` : tool));
}

interface Entry {
  value: ProxyResponse;
  expires: number;
  serverId: string;
}

export interface CacheStats {
  enabled: boolean;
  entries: number;
  maxEntries: number;
  hits: number;
  misses: number;
  deduped: number;
  evictions: number;
}

export class ToolCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<ProxyResponse>>();
  private stats = { hits: 0, misses: 0, deduped: 0, evictions: 0 };

  constructor(
    private readonly config: () => CacheConfig | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  private cfg(): CacheConfig | undefined {
    const c = this.config();
    return c && c.enabled !== false ? c : undefined;
  }

  /** The first rule matching a call (undefined = not cached). */
  rule(serverId: string, tool: string): CacheRule | undefined {
    return this.cfg()?.rules?.find(
      (r) => (r.servers === undefined || r.servers.some((p) => globToRegExp(p).test(serverId))) && toolMatches(r.tools, serverId, tool),
    );
  }

  key(rule: CacheRule, k: CacheKeyInput): string {
    const who = (rule.scope ?? 'client') === 'client' ? (k.clientId ?? 'anonymous') : '*';
    return `${k.serverId}\u0000${k.tool}\u0000${who}\u0000${canonicalJson(k.args)}`;
  }

  /**
   * Run `fetch` through the cache. Returns the result and whether it came from
   * the cache (`hit`) or a concurrent identical call (`shared`).
   */
  async run(k: CacheKeyInput, fetch: () => Promise<ProxyResponse>): Promise<{ result: ProxyResponse; status: 'hit' | 'miss' | 'shared' | 'bypass' }> {
    const rule = this.rule(k.serverId, k.tool);
    if (!rule) return { result: await fetch(), status: 'bypass' };
    const key = this.key(rule, k);
    const cached = rule.dedupeOnly ? undefined : this.entries.get(key);
    if (cached && cached.expires > this.now()) {
      this.stats.hits++;
      // LRU: move to the end
      this.entries.delete(key);
      this.entries.set(key, cached);
      return { result: cached.value, status: 'hit' };
    }
    if (cached) this.entries.delete(key);
    if (rule.dedupe !== false) {
      const pending = this.inflight.get(key);
      if (pending) {
        this.stats.deduped++;
        return { result: await pending, status: 'shared' };
      }
    }
    this.stats.misses++;
    const p = fetch();
    if (rule.dedupe !== false) this.inflight.set(key, p);
    try {
      const result = await p;
      if (!rule.dedupeOnly && cacheable(result)) this.store(key, k.serverId, result, rule.ttlSeconds ?? this.cfg()?.defaultTtlSeconds ?? 60);
      return { result, status: 'miss' };
    } finally {
      if (this.inflight.get(key) === p) this.inflight.delete(key);
    }
  }

  private store(key: string, serverId: string, value: ProxyResponse, ttlSeconds: number): void {
    if (ttlSeconds <= 0) return;
    const max = this.cfg()?.maxEntries ?? 1000;
    this.entries.set(key, { value, expires: this.now() + ttlSeconds * 1000, serverId });
    while (this.entries.size > max) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
      this.stats.evictions++;
    }
  }

  /** Drop entries (all, or one server's). Returns how many were removed. */
  purge(serverId?: string): number {
    let n = 0;
    for (const [k, e] of this.entries) {
      if (serverId === undefined || e.serverId === serverId) {
        this.entries.delete(k);
        n++;
      }
    }
    return n;
  }

  snapshot(): CacheStats {
    const now = this.now();
    for (const [k, e] of this.entries) if (e.expires <= now) this.entries.delete(k);
    return {
      enabled: this.cfg() !== undefined,
      entries: this.entries.size,
      maxEntries: this.cfg()?.maxEntries ?? 1000,
      ...this.stats,
    };
  }
}

function cacheable(r: ProxyResponse): boolean {
  if (!r.success) return false;
  const res = r.result as { isError?: unknown } | undefined;
  return !(res && typeof res === 'object' && res.isError === true);
}
