// 14.9.1 (P0, found by the 14.9.0 30-minute soak: RSS +620 MB/h vs 30 MB/h for 13.3.0): the durable sweep's full pass
// (every 30th pass) loaded EVERY retained run record at once, so its peak heap — and the process RSS, which does not
// shrink back — grew with the number of runs kept (168 h by default); the run index also kept every id ever added, in
// memory and in the store. Fixed: records are read in chunks of SWEEP_CHUNK, and ids of deleted runs leave the index.
import { describe, it, expect } from 'vitest';
import { DurableTasks, StoreKv, SWEEP_CHUNK, type DurableKv } from '../src/orchestration/durable-tasks.js';
import { DurableSchema } from '../src/features/schemas/task-graphs.js';
import { MemoryStateStore } from '../src/state/store.js';

/** Counts run-record reads in flight (the sweep's working set) and in total. */
class MeteredKv implements DurableKv {
  inFlight = 0;
  peak = 0;
  runGets = 0;
  constructor(readonly inner: StoreKv) {}
  get kind() { return this.inner.kind; }
  async get(k: string) {
    if (!k.startsWith('run:')) return this.inner.get(k);
    this.runGets++;
    this.peak = Math.max(this.peak, ++this.inFlight);
    try {
      await new Promise((r) => setImmediate(r));
      return await this.inner.get(k);
    } finally {
      this.inFlight--;
    }
  }
  set(k: string, v: string, t?: number) { return this.inner.set(k, v, t); }
  del(k: string) { return this.inner.del(k); }
  claim(k: string, t: number) { return this.inner.claim(k, t); }
  incr(k: string) { return this.inner.incr(k); }
  add(l: 'runs' | 'dlq', id: string) { return this.inner.add(l, id); }
  list(l: 'runs' | 'dlq') { return this.inner.list(l); }
  forget(l: 'runs' | 'dlq', id: string) { return this.inner.forget(l, id); }
}

const deps = { exec: () => ({}) as never, engine: { executeRun: async (r: unknown) => r, finishCompensation: async (r: unknown) => r }, setInterval: () => 0 as never, clear: () => undefined } as never;
function instance(store: MemoryStateStore, retentionHours = 168) {
  const kv = new MeteredKv(new StoreKv(store as never));
  const dt = new DurableTasks(kv, DurableSchema.parse({ sweepIntervalMs: 50, retentionHours }) as never, deps);
  return { kv, dt };
}
async function put(kv: DurableKv, id: string, status: string, finishedAgoMs: number) {
  const at = new Date(Date.now() - finishedAgoMs).toISOString();
  // a realistic record size (~2 KB: audit trail, node results)
  await kv.set(`run:${id}`, JSON.stringify({ id, graph: 'g', status, nodes: [{ id: 'n', status: 'succeeded', result: 'x'.repeat(1500) }], startedAt: at, finishedAt: at, input: { id } }));
  await kv.add('runs', id);
}
const indexSlots = async (store: MemoryStateStore, n: number) => {
  let live = 0;
  for (let i = 1; i <= n; i++) if ((await store.get(`task-graphs:runs:${i}`)) !== undefined) live++;
  return live;
};

describe('14.9.1 durable sweep memory is bounded', () => {
  it('a full sweep over 3000 retained runs never holds more than SWEEP_CHUNK records at once', async () => {
    const store = new MemoryStateStore();
    const { kv, dt } = instance(store);
    for (let i = 0; i < 3000; i++) await put(kv, `r${i}`, 'succeeded', 1000);
    await put(kv, 'open', 'awaiting_approval', 1000);
    await dt.sweep(); // first pass: full
    expect(kv.runGets).toBeGreaterThanOrEqual(3001); // every record was still checked …
    expect(kv.peak).toBeLessThanOrEqual(SWEEP_CHUNK); // … but never more than a chunk at a time (14.9.0: 3001)
    expect(SWEEP_CHUNK).toBeLessThanOrEqual(256);
  });

  it('ids of runs deleted by retention leave the index (memory and store): size follows retained runs, not runs ever started', async () => {
    const store = new MemoryStateStore();
    const { kv, dt } = instance(store, 24);
    const day = 86_400_000;
    for (let i = 0; i < 2000; i++) await put(kv, `old${i}`, 'succeeded', 3 * day);
    for (let i = 0; i < 10; i++) await put(kv, `new${i}`, 'succeeded', 1000);
    await dt.sweep();
    expect(kv.inner.cachedIds).toBe(10); // 14.9.0: 2010, for ever
    expect(await indexSlots(store, 2010)).toBe(10); // 14.9.0: 2010 index keys left in the store
    expect((await kv.list('runs')).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `new${i}`).sort());
  });

  it('a peer that listed runs another instance deleted forgets them on its next full sweep', async () => {
    const store = new MemoryStateStore();
    const a = instance(store, 24);
    const b = instance(store, 24);
    for (let i = 0; i < 300; i++) await put(a.kv, `x${i}`, 'succeeded', 3 * 86_400_000);
    await b.kv.list('runs'); // B has seen all 300
    expect(b.kv.inner.cachedIds).toBe(300);
    await a.dt.sweep(); // A deletes them
    await b.dt.sweep(); // B's first pass is full: records are gone → ids dropped
    expect(b.kv.inner.cachedIds).toBe(0);
    expect(await b.dt.list()).toEqual([]);
  });

  it('repeated create → finish → expire cycles keep the in-memory index flat', async () => {
    const store = new MemoryStateStore();
    const { kv, dt } = instance(store, 24);
    const sizes: number[] = [];
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 400; i++) await put(kv, `c${round}-${i}`, 'succeeded', 3 * 86_400_000);
      await dt.sweep(); // full on the first pass; force the rest
      for (let k = 0; k < 29; k++) await dt.sweep();
      sizes.push(kv.inner.cachedIds);
    }
    expect(sizes).toEqual([0, 0, 0, 0, 0]);
  });
});
