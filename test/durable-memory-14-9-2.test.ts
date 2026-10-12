// 14.9.2 (found by the 90-minute soak of 15.0.0-rc.2 and the in-process harness): after 14.9.1 the durable layer still
// kept every retained run id in memory twice — StoreKv's listing cache and the manager's finished set — ~0.2 KB per run
// until `retentionHours` deleted it: ~4 MB/h at the soak's 6 runs/s, ~680 MB at the default 168 h. Fixed: StoreKv keeps
// at most `maxIds` recent ids (older ones are read back from the store index by a full listing), the frequent sweep pass
// visits the recent ids plus the runs this instance knows are still open, and the finished set is bounded the same way.
import { describe, it, expect } from 'vitest';
import { DurableTasks, StoreKv, STORE_KV_MAX_IDS, type DurableKv } from '../src/orchestration/durable-tasks.js';
import { DurableSchema } from '../src/features/schemas/task-graphs.js';
import { MemoryStateStore } from '../src/state/store.js';

/** Counts reads of run records (`run:<id>`) and index slots (`runs:<n>`). */
class CountingStore extends MemoryStateStore {
  runReads = 0;
  slotReads = 0;
  override async get(k: string) {
    if (k.startsWith('task-graphs:run:')) this.runReads++;
    else if (/^task-graphs:runs:\d+$/.test(k)) this.slotReads++;
    return super.get(k);
  }
}
const deps = { exec: () => ({}) as never, engine: { executeRun: async (r: unknown) => r, finishCompensation: async (r: unknown) => r }, setInterval: () => 0 as never, clear: () => undefined } as never;
function instance(store: MemoryStateStore, maxIds: number, retentionHours = 168) {
  const kv = new StoreKv(store as never, 'task-graphs:', maxIds);
  const dt = new DurableTasks(kv, DurableSchema.parse({ sweepIntervalMs: 50, retentionHours }) as never, deps);
  return { kv, dt };
}
async function put(kv: DurableKv, id: string, status: string, finishedAgoMs: number) {
  const at = new Date(Date.now() - finishedAgoMs).toISOString();
  await kv.set(`run:${id}`, JSON.stringify({ id, graph: 'g', status, nodes: [{ id: 'n', status: 'succeeded' }], startedAt: at, ...(status === 'awaiting_approval' ? {} : { finishedAt: at }), input: { id } }));
  await kv.add('runs', id);
}
const priv = (dt: DurableTasks) => dt as unknown as { terminal: Set<string>; open: Set<string>; sweeps: number };
/** Run one frequent (not full) sweep pass: full passes are the first and every 30th. */
async function frequentPass(dt: DurableTasks) {
  if (priv(dt).sweeps === 0 || (priv(dt).sweeps + 1) % 30 === 0) priv(dt).sweeps++;
  await dt.sweep();
}
const indexSlots = async (store: MemoryStateStore, n: number) => {
  let live = 0;
  for (let i = 1; i <= n; i++) if ((await MemoryStateStore.prototype.get.call(store, `task-graphs:runs:${i}`)) !== undefined) live++;
  return live;
};

describe('14.9.2 durable run ids in memory are bounded', () => {
  it('memory holds at most maxIds ids however many runs are retained; listings stay complete and in index order', async () => {
    const store = new CountingStore();
    const { kv, dt } = instance(store, 100);
    for (let i = 0; i < 3000; i++) await put(kv, `r${i}`, 'succeeded', 1000);
    await dt.sweep(); // first pass: full
    expect(kv.cachedIds).toBeLessThanOrEqual(100); // 14.9.1: 3000 (grew with every retained run)
    expect(priv(dt).terminal.size).toBeLessThanOrEqual(100); // 14.9.1: 3000
    const all = await kv.list('runs');
    expect(all).toEqual(Array.from({ length: 3000 }, (_, i) => `r${i}`));
    expect((await dt.list()).length).toBe(3000);
    // a peer with the default window sees the same index (no state format change)
    expect(await new StoreKv(store as never).list('runs')).toEqual(all);
    expect(STORE_KV_MAX_IDS).toBeGreaterThanOrEqual(10_000);
  });

  it('the frequent pass reads no out-of-memory slots or finished records, but still visits an old open run', async () => {
    const store = new CountingStore();
    const { kv, dt } = instance(store, 100);
    await put(kv, 'old-open', 'awaiting_approval', 1000); // slot 1: leaves memory once 100 newer runs exist
    for (let i = 0; i < 2000; i++) await put(kv, `r${i}`, 'succeeded', 1000);
    await dt.sweep(); // full: classifies everything
    expect(priv(dt).open.has('old-open')).toBe(true);
    await put(kv, 'fresh', 'succeeded', 10);
    store.runReads = 0;
    store.slotReads = 0;
    await frequentPass(dt);
    expect(store.slotReads).toBeLessThanOrEqual(1); // only the one new slot (14.9.1-style full listing: 2002)
    expect(store.runReads).toBeLessThanOrEqual(2); // the new run + the open one
    expect(dt.metrics.awaiting).toBe(1); // the old awaiting run is still seen by every frequent pass
    expect(kv.cachedIds).toBeLessThanOrEqual(100);
  });

  it('retention deletes out-of-memory runs and their index slots (memory and store)', async () => {
    const store = new CountingStore();
    const { kv, dt } = instance(store, 50, 24);
    const day = 86_400_000;
    for (let i = 0; i < 2000; i++) await put(kv, `old${i}`, 'succeeded', 3 * day);
    for (let i = 0; i < 10; i++) await put(kv, `new${i}`, 'succeeded', 1000);
    await dt.sweep(); // full: expires the old runs (most of them are out of memory)
    expect((await kv.list('runs')).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `new${i}`).sort());
    expect(await indexSlots(store, 2010)).toBe(10); // slots of forgotten out-of-memory ids were deleted by the listing
    expect(kv.cachedIds).toBeLessThanOrEqual(50);
    expect(priv(dt).terminal.size).toBeLessThanOrEqual(50);
  });

  it('below maxIds nothing changes: no store reads beyond new slots, open set empty once runs finish', async () => {
    const store = new CountingStore();
    const { kv, dt } = instance(store, 1000);
    for (let i = 0; i < 200; i++) await put(kv, `r${i}`, 'succeeded', 1000);
    await dt.sweep();
    store.slotReads = 0;
    expect((await kv.list('runs')).length).toBe(200);
    expect(store.slotReads).toBe(0);
    expect(kv.cachedIds).toBe(200);
    expect(priv(dt).open.size).toBe(0);
  });
});
