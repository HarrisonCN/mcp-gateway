/**
 * Semantic cache (7.4): answer a tool call from an earlier call whose arguments *mean* the same thing.
 *
 * The 2.2 cache matches arguments exactly; `semanticCache` matches the **text** in the arguments by embedding
 * similarity, for tools where paraphrases give the same answer (search, docs lookup, FAQ). Non-text arguments
 * (numbers, booleans, `null`) must still match exactly, so `{ q: "weather in Paris", days: 3 }` never answers
 * `{ q: "Paris weather", days: 7 }`.
 *
 * ```yaml
 * semanticCache:
 *   tools: ["search/*", "docs/lookup"]   # opt-in, server/tool globs
 *   threshold: 0.9                       # cosine similarity (0..1)
 *   ttlSeconds: 3600
 *   maxEntries: 5000
 *   scope: tenant                        # tenant (default) | client | global — entries are never shared across scopes
 *   embedding:
 *     provider: local                    # local (hashed n-grams, no network) | openai (any /v1/embeddings API)
 *     # url: https://api.openai.com/v1
 *     # model: text-embedding-3-small
 *     # apiKeyEnv: OPENAI_API_KEY
 * ```
 *
 * Hits are answered without calling the upstream and carry `_meta["mcp-gateway/semantic-cache"]`
 * (`similarity`, `cachedAt`). Only successful results are stored. An embedding failure means a miss, never an error.
 *
 * - `GET    /admin/semantic-cache` — settings and counters (hits, misses, stores, evictions, entries).
 * - `POST   /admin/semantic-cache/similarity` — `{ a, b }` → cosine similarity with the configured embedding.
 * - `DELETE /admin/semantic-cache[?tool=server/tool]` — purge.
 *
 * @module features/semantic-cache
 */

import { z } from 'zod';
import { registerFeature, objectBody, badRequest } from '../gateway/features.js';
import { registerCallHook, type HookCall } from '../gateway/hooks.js';
import { globToRegExp } from '../utils/tool-filter.js';
import type { GatewayConfig, ProxyResponse } from '../utils/types.js';

export const SemanticCacheSchema = z
  .object({
    enabled: z.boolean().default(true),
    tools: z.array(z.string().min(1)).min(1),
    threshold: z.number().min(0.5).max(1).default(0.9),
    ttlSeconds: z.number().int().min(1).default(3600),
    maxEntries: z.number().int().min(1).max(1_000_000).default(5000),
    scope: z.enum(['tenant', 'client', 'global']).default('tenant'),
    embedding: z
      .object({
        provider: z.enum(['local', 'openai']).default('local'),
        url: z.string().url().optional(),
        model: z.string().min(1).default('text-embedding-3-small'),
        apiKeyEnv: z.string().min(1).optional(),
        dimensions: z.number().int().min(64).max(4096).default(512),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.embedding.provider === 'openai' && !c.embedding.url) ctx.addIssue({ code: 'custom', path: ['embedding', 'url'], message: 'the openai provider needs `url` (e.g. https://api.openai.com/v1)' });
  });
export type SemanticCacheConfig = z.input<typeof SemanticCacheSchema>;
type Cfg = z.output<typeof SemanticCacheSchema>;

const settings = (cfg: GatewayConfig): Cfg | undefined => {
  if (!cfg.semanticCache) return undefined;
  const c = SemanticCacheSchema.parse(cfg.semanticCache);
  return c.enabled ? c : undefined;
};

/** Split arguments into the text that is compared semantically and a key of everything else (compared exactly). */
export function splitArgs(args: unknown): { text: string; exact: string } {
  const texts: string[] = [];
  const walk = (v: unknown, path: string): unknown => {
    if (typeof v === 'string') {
      texts.push(`${path}: ${v}`);
      return '§';
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, walk((v as Record<string, unknown>)[k], path ? `${path}.${k}` : k)]));
    return v;
  };
  const exact = JSON.stringify(walk(args ?? {}, ''));
  return { text: texts.join('\n'), exact };
}

const fnv = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
};

/** Local embedding: hashed word unigrams / bigrams and character trigrams, L2-normalised. Deterministic, offline. */
export function localEmbedding(text: string, dims = 512): Float32Array {
  const v = new Float32Array(dims);
  const norm = text.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const words = norm.split(/\s+/).filter(Boolean);
  const add = (f: string, w: number) => {
    const h = fnv(f);
    v[h % dims]! += (h & 0x80000000 ? -1 : 1) * w;
  };
  words.forEach((w, i) => {
    add(`w:${w}`, 1);
    if (i > 0) add(`b:${words[i - 1]} ${w}`, 0.5);
    const p = ` ${w} `;
    for (let j = 0; j + 3 <= p.length; j++) add(`c:${p.slice(j, j + 3)}`, 0.3);
  });
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < dims; i++) v[i]! /= n;
  return v;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const memo = new Map<string, Float32Array>();
/** Embed `text` with the configured provider (memoised; throws on provider errors). */
export async function embed(text: string, c: Cfg, fetchImpl: typeof fetch = fetch): Promise<Float32Array> {
  const key = `${c.embedding.provider}:${c.embedding.model}:${c.embedding.dimensions}:${text}`;
  const hit = memo.get(key);
  if (hit) return hit;
  let v: Float32Array;
  if (c.embedding.provider === 'local') v = localEmbedding(text, c.embedding.dimensions);
  else {
    const token = c.embedding.apiKeyEnv ? process.env[c.embedding.apiKeyEnv] : undefined;
    const res = await fetchImpl(`${c.embedding.url!.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ model: c.embedding.model, input: text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`embedding API: HTTP ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const e = body.data?.[0]?.embedding;
    if (!Array.isArray(e) || !e.length) throw new Error('embedding API: no embedding in the response');
    v = Float32Array.from(e);
  }
  if (memo.size >= 2000) memo.delete(memo.keys().next().value!);
  memo.set(key, v);
  return v;
}

interface Entry {
  vec: Float32Array;
  text: string;
  result: ProxyResponse;
  at: number;
  hits: number;
}

export class SemanticStore {
  private parts = new Map<string, Entry[]>();
  size = 0;
  stats = { hits: 0, misses: 0, stores: 0, evictions: 0, errors: 0 };
  constructor(private readonly now: () => number = Date.now) {}

  private expire(list: Entry[], ttlMs: number): Entry[] {
    const t = this.now();
    const keep = list.filter((e) => t - e.at < ttlMs);
    this.size -= list.length - keep.length;
    return keep;
  }

  lookup(part: string, vec: Float32Array, c: Cfg): { entry: Entry; similarity: number } | undefined {
    const list = this.expire(this.parts.get(part) ?? [], c.ttlSeconds * 1000);
    this.parts.set(part, list);
    let best: { entry: Entry; similarity: number } | undefined;
    for (const e of list) {
      const s = cosine(vec, e.vec);
      if (s >= c.threshold && (!best || s > best.similarity)) best = { entry: e, similarity: s };
    }
    return best;
  }

  store(part: string, vec: Float32Array, text: string, result: ProxyResponse, c: Cfg): void {
    const list = this.parts.get(part) ?? [];
    list.push({ vec, text, result, at: this.now(), hits: 0 });
    this.parts.set(part, list);
    this.size++;
    this.stats.stores++;
    while (this.size > c.maxEntries) {
      // evict the oldest entry overall
      let oldest: [string, number] | undefined;
      let at = Infinity;
      for (const [k, l] of this.parts) if (l.length && l[0]!.at < at) (at = l[0]!.at), (oldest = [k, 0]);
      if (!oldest) break;
      this.parts.get(oldest[0])!.shift();
      this.size--;
      this.stats.evictions++;
    }
  }

  purge(prefix?: string): number {
    let n = 0;
    for (const [k, l] of [...this.parts]) {
      if (!prefix || k.startsWith(`${prefix}\u0000`)) {
        n += l.length;
        this.parts.delete(k);
      }
    }
    this.size -= n;
    return n;
  }
}

export const semanticStore = new SemanticStore();
const MARK = 'mcp-gateway/semantic-cache';

const applies = (c: Cfg, call: HookCall) => c.tools.some((p) => globToRegExp(p).test(`${call.serverId}/${call.tool}`));
const partition = (c: Cfg, call: HookCall, exact: string) => {
  const subject = c.scope === 'global' ? '*' : c.scope === 'client' ? call.clientId ?? 'anonymous' : call.tenant ?? call.clientId ?? 'anonymous';
  // MGW-2026-005: keyed on the server the call is routed to (routing splits), so split targets never share entries.
  const target = call.routedTo?.() ?? call.serverId;
  const server = target !== call.serverId ? `${call.serverId}>${target}` : call.serverId;
  return `${server}/${call.tool}\u0000${subject}\u0000${exact}`;
};
const fromCache = (r: ProxyResponse) => {
  const res = r.result as { _meta?: Record<string, unknown> } | undefined;
  return !!res && typeof res === 'object' && !!res._meta?.[MARK];
};

registerCallHook({
  id: 'semantic-cache',
  before: async (call, cfg) => {
    const c = settings(cfg);
    if (!c || !applies(c, call)) return;
    const { text, exact } = splitArgs(call.args);
    if (!text) return;
    let vec: Float32Array;
    try {
      vec = await embed(text, c);
    } catch {
      semanticStore.stats.errors++;
      return;
    }
    const hit = semanticStore.lookup(partition(c, call, exact), vec, c);
    if (!hit) {
      semanticStore.stats.misses++;
      return;
    }
    semanticStore.stats.hits++;
    hit.entry.hits++;
    const r = hit.entry.result;
    const base = r.result && typeof r.result === 'object' && !Array.isArray(r.result) ? (r.result as Record<string, unknown>) : { value: r.result };
    return {
      respond: {
        ...r,
        durationMs: 0,
        result: { ...base, _meta: { ...((base._meta as object) ?? {}), [MARK]: { hit: true, similarity: Math.round(hit.similarity * 1000) / 1000, cachedAt: new Date(hit.entry.at).toISOString() } } },
      },
    };
  },
  after: async (call, result, cfg) => {
    const c = settings(cfg);
    if (!c || !result.success || fromCache(result) || !applies(c, call)) return;
    const { text, exact } = splitArgs(call.args);
    if (!text) return;
    try {
      semanticStore.store(partition(c, call, exact), await embed(text, c), text, result, c);
    } catch {
      semanticStore.stats.errors++;
    }
  },
});

registerFeature({
  id: 'semantic-cache',
  since: '7.4.0',
  summary: 'Semantic cache: answer paraphrased tool calls from earlier results by embedding similarity (tenant-isolated)',
  mount: (router, ctx) => {
    router.get('/', (_req, res) => {
      const c = settings(ctx.config());
      res.json({ enabled: !!c, settings: c ?? null, entries: semanticStore.size, stats: semanticStore.stats });
    });
    router.post('/similarity', async (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      if (typeof b.a !== 'string' || typeof b.b !== 'string') return badRequest(res, 'Body must be { "a": "<text>", "b": "<text>" }');
      const c = settings(ctx.config()) ?? SemanticCacheSchema.parse({ tools: ['*'] });
      try {
        const s = cosine(await embed(b.a, c), await embed(b.b, c));
        res.json({ similarity: Math.round(s * 1000) / 1000, threshold: c.threshold, match: s >= c.threshold, provider: c.embedding.provider });
      } catch (err) {
        res.status(502).json({ error: 'Bad Gateway', message: err instanceof Error ? err.message : String(err) });
      }
    });
    router.delete('/', (req, res) => {
      const tool = typeof req.query.tool === 'string' ? req.query.tool : undefined;
      res.json({ purged: semanticStore.purge(tool) });
    });
  },
});
