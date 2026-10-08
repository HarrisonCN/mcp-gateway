/** 7.4: semantic cache. */
import { describe, it, expect, afterEach } from 'vitest';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';
import { validateConfig } from '../src/config/loader.js';
import { SemanticCacheSchema, SemanticStore, localEmbedding, cosine, splitArgs, embed, semanticStore } from '../src/features/semantic-cache.js';

let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

describe('semantic cache (7.4)', () => {
  it('local embeddings: reorderings / case match, different subjects do not', () => {
    const s = (a: string, b: string) => cosine(localEmbedding(a), localEmbedding(b));
    expect(s('weather in Paris today', 'today weather in Paris')).toBeGreaterThan(0.9);
    expect(s('How do I reset my password', 'how do i reset my password?')).toBeCloseTo(1, 5);
    expect(s('weather in Paris today', 'weather in Berlin today')).toBeLessThan(0.9);
    expect(s('reset my password', 'delete my account')).toBeLessThan(0.7);
    expect(splitArgs({ q: 'x', days: 3, o: { l: 'en', n: [1, 'y'] } })).toEqual({ text: 'o.l: en\no.n[1]: y\nq: x', exact: '{"days":3,"o":{"l":"§","n":[1,"§"]},"q":"§"}' });
    expect(() => validateConfig({ servers: [], semanticCache: { tools: [] } })).toThrow();
    expect(() => validateConfig({ servers: [], semanticCache: { tools: ['*'], embedding: { provider: 'openai' } } })).toThrow(/needs `url`/);
  });

  it('store: threshold, TTL, eviction and purge', () => {
    let t = 0;
    const st = new SemanticStore(() => t);
    const c = SemanticCacheSchema.parse({ tools: ['*'], ttlSeconds: 10, maxEntries: 2 });
    const r = (n: number) => ({ success: true, result: { n }, durationMs: 1 });
    st.store('s/t\u0000a\u0000{}', localEmbedding('alpha beta'), 'alpha beta', r(1), c);
    expect(st.lookup('s/t\u0000a\u0000{}', localEmbedding('beta alpha'), c)?.entry.result.result).toEqual({ n: 1 });
    expect(st.lookup('s/t\u0000b\u0000{}', localEmbedding('beta alpha'), c)).toBeUndefined();
    t = 5_000;
    st.store('s/t\u0000a\u0000{}', localEmbedding('gamma'), 'gamma', r(2), c);
    st.store('s/u\u0000a\u0000{}', localEmbedding('delta'), 'delta', r(3), c);
    expect(st.stats.evictions).toBe(1);
    expect(st.lookup('s/t\u0000a\u0000{}', localEmbedding('alpha beta'), c)).toBeUndefined();
    t = 16_000;
    expect(st.lookup('s/t\u0000a\u0000{}', localEmbedding('gamma'), c)).toBeUndefined();
    expect(st.purge('s/u')).toBe(1);
    expect(st.size).toBe(0);
  });

  it('openai-compatible embeddings API', async () => {
    const c = SemanticCacheSchema.parse({ tools: ['*'], embedding: { provider: 'openai', url: 'http://emb.local/v1', model: 'm' } });
    let body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const f = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
    }) as unknown as typeof fetch;
    expect(Array.from(await embed('hello openai', c, f))).toEqual([0.1, 0.2, 0.3].map((x) => Math.fround(x)));
    expect(body).toEqual({ model: 'm', input: 'hello openai' });
    const bad = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch;
    await expect(embed('other text', c, bad)).rejects.toThrow(/HTTP 500/);
  });

  it('gateway: answers a reordered query from the cache; exact args and clients are isolated', async () => {
    semanticStore.purge();
    h = await startFeatureGw({ semanticCache: { tools: ['fake/echo'], scope: 'client' } } as never);
    const call = async (args: Record<string, unknown>, key = 'op') => {
      const r = await fetch(`${h!.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: args }) });
      return JSON.stringify(await r.json());
    };
    const first = await call({ q: 'weather in Paris today', days: 3 });
    expect(first).not.toContain('semantic-cache');
    const hit = await call({ q: 'today weather in Paris', days: 3 });
    expect(hit).toContain('mcp-gateway/semantic-cache');
    expect(hit).toContain('weather in Paris today'); // the cached (first) answer
    expect(await call({ q: 'today weather in Paris', days: 4 })).not.toContain('semantic-cache');
    expect(await call({ q: 'weather in Berlin today', days: 3 })).not.toContain('semantic-cache');
    expect(await call({ q: 'today weather in Paris', days: 3 }, 'scoped')).not.toContain('semantic-cache');
    const st = await h.admin('semantic-cache');
    expect(st.body).toMatchObject({ enabled: true, stats: { hits: 1 } });
    expect(st.body.entries).toBeGreaterThanOrEqual(4);
    const sim = await h.admin('semantic-cache/similarity', { a: 'weather in Paris today', b: 'today weather in Paris' });
    expect(sim.body).toMatchObject({ match: true, provider: 'local', threshold: 0.9 });
    expect((await h.admin('semantic-cache/similarity', { a: 1 })).status).toBe(400);
    expect((await h.admin('semantic-cache?tool=fake/echo', undefined, 'DELETE')).body.purged).toBeGreaterThanOrEqual(4);
    expect(await call({ q: 'today weather in Paris', days: 3 })).not.toContain('semantic-cache');
  });
});
