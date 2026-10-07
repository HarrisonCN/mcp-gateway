import { describe, it, expect } from 'vitest';
import { Mutex } from '../src/utils/mutex.js';
import { Semaphore } from '../src/utils/semaphore.js';

describe('Mutex', () => {
  it('serialises critical sections', async () => {
    const m = new Mutex();
    const order: string[] = [];
    await Promise.all(
      ['a', 'b', 'c'].map((x) =>
        m.runExclusive(async () => {
          order.push(`${x}+`);
          await new Promise((r) => setTimeout(r, 5));
          order.push(`${x}-`);
        }),
      ),
    );
    expect(order).toEqual(['a+', 'a-', 'b+', 'b-', 'c+', 'c-']);
  });

  it('double release does not unlock for another holder', async () => {
    const m = new Mutex();
    const r1 = await m.acquire();
    const p2 = m.acquire();
    r1();
    const r2 = await p2;
    r1(); // stray second release
    expect(m.isLocked).toBe(true);
    r2();
    expect(m.isLocked).toBe(false);
  });
});

describe('Semaphore', () => {
  it('limits concurrency', async () => {
    const s = new Semaphore(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        const release = await s.acquire();
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        release();
      }),
    );
    expect(peak).toBe(2);
  });
});
