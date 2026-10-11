// 14.9.0 (found by the 30-minute soak): the durable sweep loaded EVERY run record ever written on every sweep
// (default every 2 s) and run records were never deleted — Redis traffic, latency and gateway memory grew with the
// number of runs. Fixed: a sweep only loads runs that are not known to be finished (a full sweep every 30th pass
// re-checks the rest), and finished runs older than `taskGraphs.durable.retentionHours` (default 168) are deleted.
import { describe, it, expect } from 'vitest';
import { DurableTasks, StoreKv, type DurableKv } from '../src/orchestration/durable-tasks.js';
import { DurableSchema } from '../src/features/schemas/task-graphs.js';
import { MemoryStateStore } from '../src/state/store.js';

class CountingKv implements DurableKv {
  runGets = 0;
  constructor(private readonly inner: DurableKv) {}
  get kind() { return this.inner.kind; }
  get(k: string) { if (k.startsWith('run:')) this.runGets++; return this.inner.get(k); }
  set(k: string, v: string, t?: number) { return this.inner.set(k, v, t); }
  del(k: string) { return this.inner.del(k); }
  claim(k: string, t: number) { return this.inner.claim(k, t); }
  incr(k: string) { return this.inner.incr(k); }
  add(l: 'runs' | 'dlq', id: string) { return this.inner.add(l, id); }
  list(l: 'runs' | 'dlq') { return this.inner.list(l); }
}

function setup(retentionHours?: number) {
  const kv = new CountingKv(new StoreKv(new MemoryStateStore() as never));
  const cfg = DurableSchema.parse({ sweepIntervalMs: 50, ...(retentionHours !== undefined ? { retentionHours } : {}) });
  const dt = new DurableTasks(kv, cfg as never, { exec: () => ({}) as never, engine: { executeRun: async (r) => r, finishCompensation: async (r) => r }, setInterval: () => 0 as never, clear: () => undefined });
  const put = async (id: string, status: string, finishedAgoMs = 0) => {
    const at = new Date(Date.now() - finishedAgoMs).toISOString();
    await kv.set(`run:${id}`, JSON.stringify({ id, graph: 'g', status, nodes: [], startedAt: at, finishedAt: at, input: {} }));
    await kv.add('runs', id);
  };
  return { kv, dt, put };
}

describe('durable sweep cost and retention (14.9.0)', () => {
  it('after the first pass, a sweep does not load finished runs again', async () => {
    const { kv, dt, put } = setup();
    for (let i = 0; i < 300; i++) await put(`r${i}`, 'succeeded');
    await put('live', 'awaiting_approval');
    await dt.sweep(); // first sweep: full
    kv.runGets = 0;
    await dt.sweep();
    expect(kv.runGets).toBe(1); // only the run that is not finished
  });

  it('a full sweep deletes finished runs older than retentionHours; recent, dead-lettered and open runs stay', async () => {
    const { kv, dt, put } = setup(24);
    const day = 86_400_000;
    await put('old-ok', 'succeeded', 3 * day);
    await put('old-failed', 'failed', 3 * day);
    await put('old-dlq', 'dead_letter', 3 * day);
    await put('old-compfail', 'compensation_failed', 3 * day);
    await put('new-ok', 'succeeded', 1000);
    await put('open', 'awaiting_approval', 3 * day);
    await dt.sweep();
    expect(await kv.get('run:old-ok')).toBeUndefined();
    expect(await kv.get('run:old-failed')).toBeUndefined();
    for (const id of ['old-dlq', 'old-compfail', 'new-ok', 'open']) expect(await kv.get(`run:${id}`), id).toBeDefined();
    expect((await dt.list()).map((r) => r.id).sort()).toEqual(['new-ok', 'old-compfail', 'old-dlq', 'open']);
  });

  it('retentionHours defaults to 168 and 0 keeps finished runs forever', async () => {
    expect(DurableSchema.parse({}).retentionHours).toBe(168);
    const { kv, dt, put } = setup(0);
    await put('ancient', 'succeeded', 400 * 86_400_000);
    await dt.sweep();
    expect(await kv.get('run:ancient')).toBeDefined();
  });
});
