/** MGW-2026-014 (backport of 13.7.0): no Redis command runs before AUTH + SELECT completed. Needs redis-server. */
import { describe, it, expect, afterEach } from 'vitest';
import { RedisStateStore } from '../src/state/index.js';
import { redisServerAvailable, startRealRedis, startFaultProxy } from './fixtures/real-redis.js';

let cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f().catch(() => undefined);
  cleanup = [];
});

describe.runIf(redisServerAvailable)('MGW-2026-014 Redis connection setup', () => {
  it('no command runs before AUTH + SELECT finished on a (re)connected socket', async () => {
    const r = await startRealRedis({ password: 'pw-13-7' });
    cleanup.push(() => r.close());
    const p = await startFaultProxy(r.port);
    cleanup.push(() => p.close());
    const seed = new RedisStateStore({ url: `${r.url}/5` });
    await seed.set('who', 'db5');
    await seed.close();
    await r.cmd('SET', 'who', 'db0');
    p.latency(25);
    const s = new RedisStateStore({ url: `${p.url(r.url)}/5` });
    cleanup.push(() => s.close());
    const results: Array<Promise<string | undefined>> = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 150) {
      results.push(s.get('who'));
      await new Promise((res) => setImmediate(res));
    }
    const got = await Promise.all(results);
    expect(got.length).toBeGreaterThan(5);
    expect(new Set(got)).toEqual(new Set(['db5']));
  });
});
