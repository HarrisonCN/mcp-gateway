import { describe, it, expect, afterEach, vi } from 'vitest';
import { Logger } from '../src/utils/logger.js';
import { Semaphore } from '../src/utils/semaphore.js';
import { VERSION } from '../src/utils/version.js';
import pkg from '../package.json' with { type: 'json' };

afterEach(() => vi.restoreAllMocks());

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s: any) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s: any) => (err.push(String(s)), true));
  return { out, err };
}

describe('Logger', () => {
  it('filters below the configured level and routes warn/error to stderr', () => {
    const { out, err } = capture();
    const l = new Logger();
    l.debug('hidden');
    l.info('shown');
    l.warn('careful');
    l.error('broken');
    expect(out.join('')).not.toMatch(/hidden/);
    expect(out.join('')).toMatch(/\[INFO \] shown/);
    expect(err.join('')).toMatch(/\[WARN \] careful/);
    expect(err.join('')).toMatch(/\[ERROR\] broken/);

    l.setLevel('debug');
    l.debug('now visible');
    expect(out.join('')).toMatch(/\[DEBUG\] now visible/);

    l.setLevel('error');
    l.warn('suppressed');
    expect(err.join('')).not.toMatch(/suppressed/);
  });

  it('serialises meta, including bigints and circular values', () => {
    const { out } = capture();
    const l = new Logger();
    l.info('m', { n: 1n, s: 'x' });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    l.info('c', circular);
    expect(out[0]).toMatch(/m \{"n":"1","s":"x"\}/);
    expect(out[1]).toMatch(/c \[unserializable meta\]/);
  });
});

describe('Semaphore', () => {
  it('limits concurrency and hands slots to waiters in FIFO order', async () => {
    const s = new Semaphore(2);
    const r1 = await s.acquire();
    const r2 = await s.acquire();
    expect(s.inFlight).toBe(2);
    const order: number[] = [];
    const p3 = s.acquire().then((r) => (order.push(3), r));
    const p4 = s.acquire().then((r) => (order.push(4), r));
    expect(s.pending).toBe(2);
    r1();
    r1(); // double release is a no-op
    const r3 = await p3;
    expect(s.inFlight).toBe(2);
    expect(s.pending).toBe(1);
    r2();
    const r4 = await p4;
    expect(order).toEqual([3, 4]);
    r3();
    r4();
    expect(s.inFlight).toBe(0);
  });

  it('treats a non-positive or non-finite max as unlimited', async () => {
    for (const max of [0, -1, NaN]) {
      const s = new Semaphore(max);
      await Promise.all(Array.from({ length: 50 }, () => s.acquire()));
      expect(s.inFlight).toBe(50);
      expect(s.pending).toBe(0);
    }
  });
});

describe('VERSION', () => {
  it('matches package.json', () => {
    expect(VERSION).toBe(pkg.version);
  });
});
