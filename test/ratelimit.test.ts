import { describe, it, expect } from 'vitest';
import { createRateLimiter } from '../src/auth/ratelimit.js';

function run(limiter: any, clientId = 'c') {
  const res: any = { statusCode: 200, headers: {} as Record<string, string> };
  res.set = (k: any, v?: string) => (typeof k === 'string' ? (res.headers[k] = v) : Object.assign(res.headers, k), res);
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = () => res;
  let passed = false;
  limiter({ clientId, ip: '1.1.1.1' }, res, () => (passed = true));
  return { passed, res };
}

describe('rate limiter', () => {
  it('allows up to the limit then returns 429 with Retry-After', () => {
    let t = 1_000_000;
    const rl = createRateLimiter({ limit: 3, windowSeconds: 10 }, () => t);
    expect([1, 2, 3].map(() => run(rl).passed)).toEqual([true, true, true]);
    const blocked = run(rl);
    expect(blocked.passed).toBe(false);
    expect(blocked.res.statusCode).toBe(429);
    expect(Number(blocked.res.headers['Retry-After'])).toBeGreaterThanOrEqual(1);
    rl.close();
  });

  it('sliding window prevents a 2x burst at the window boundary', () => {
    let t = 10_000 * 100 + 9_900; // near the end of a window
    const rl = createRateLimiter({ limit: 10, windowSeconds: 10 }, () => t);
    for (let i = 0; i < 10; i++) expect(run(rl).passed).toBe(true);
    t += 200; // just into the next window: previous window still ~99% weighted
    // A fixed window would allow 10 more right away; sliding allows at most 1.
    const allowed = Array.from({ length: 10 }, () => run(rl).passed).filter(Boolean).length;
    expect(allowed).toBeLessThanOrEqual(1);
    t += 10_000; // a full window later everything has decayed
    expect(run(rl).passed).toBe(true);
    rl.close();
  });

  it('tracks clients separately when perKey', () => {
    const rl = createRateLimiter({ limit: 1, windowSeconds: 60 });
    expect(run(rl, 'a').passed).toBe(true);
    expect(run(rl, 'b').passed).toBe(true);
    expect(run(rl, 'a').passed).toBe(false);
    rl.close();
  });

  it('is a passthrough without config', () => {
    const rl = createRateLimiter(undefined);
    expect(run(rl).passed).toBe(true);
  });
});
