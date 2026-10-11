// 14.6.0: Edge Autonomy 正式化 — offline permission boundaries (high-risk calls denied offline by default), queue
// expiry, conflict handling through the durable intent log (14.4), ordered + fenced reconnect reconciliation that
// honours revocations learned on reconnect (14.5 replicated revocations), a sealed queue at rest, metrics, the
// `edge` CLI. The kill -9 mid-reconcile runs live in edge-autonomy-restart-14-6-0.test.ts.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, statSync, writeFileSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Gateway } from '../src/gateway/index.js';
import * as EA from '../src/features/edge-autonomy.js';
// namespace access: the new 14.6 exports are resolved per test, so the failing-before run fails test by test
const { EdgeAutonomySchema, edgeState, ERR_EDGE_DENIED } = EA;
type Faults = { beforeReplay?: (e: { id: string }, ctl: { index: number; supersede: () => Promise<void> }) => void | Promise<void>; afterCommit?: () => void };
const edgeFaults: Faults = ((EA as Record<string, unknown>).edgeFaults ?? {}) as Faults;
const classifyOffline = (...a: unknown[]) => ((EA as Record<string, unknown>).classifyOffline as (...x: unknown[]) => unknown)(...a);
import { announceRevocation } from '../src/gateway/revocations.js';
import { runInScope } from '../src/kernel/instance.js';
import { regionFaults, resetRegionFaults, ERR_REGION_REVOKED } from '../src/features/regions.js';
import { validateConfig } from '../src/config/loader.js';
import type { GatewayConfig } from '../src/utils/types.js';

const FIXTURE = resolve(__dirname, 'fixtures', 'edge-ledger-mcp-server.mjs');
const CLI = resolve(__dirname, '..', 'src', 'cli.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gws: Gateway[] = [];
afterEach(async () => {
  for (const g of gws.splice(0)) await g.stop().catch(() => undefined);
  edgeState.reset();
  resetRegionFaults();
  for (const k of Object.keys(edgeFaults)) delete (edgeFaults as Record<string, unknown>)[k];
  delete process.env.EDGE_TEST_SEAL_KEY;
});

const KEYS = [{ key: 'op', name: 'ops' }, { key: 'k-alice', name: 'alice' }, { key: 'k-bob', name: 'bob' }];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'edge-146-'));
  const ledger = join(dir, 'ledger.jsonl');
  const ledgerOf = () => (existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { tool: string; args: Record<string, unknown> }) : []);
  const server = { id: 'ledger', name: 'ledger', transport: 'stdio', command: process.execPath, args: [FIXTURE], env: { LEDGER: ledger }, timeout: 10_000 };
  return { dir, ledger, ledgerOf, server, state: join(dir, 'edge') };
}

type Req = (path: string, body?: unknown, key?: string, method?: string) => Promise<{ status: number; body: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function start(extra: Record<string, unknown>, s = setup()): Promise<{ gw: Gateway; base: string; req: Req; call: (tool: string, args?: Record<string, unknown>, key?: string) => ReturnType<Req>; s: ReturnType<typeof setup>; config: GatewayConfig }> {
  const config = {
    port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false, prometheus: true },
    servers: [s.server], auth: { strategy: 'api-key', apiKeys: KEYS },
    ...extra,
  } as unknown as GatewayConfig;
  const gw = new Gateway(config);
  await gw.start();
  gws.push(gw);
  const base = `http://127.0.0.1:${gw.address()!.port}`;
  const req: Req = async (path, body, key = 'op', method) => {
    const r = await fetch(`${base}/api/v1/${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const t = await r.text();
    let b: unknown = t;
    try { b = JSON.parse(t); } catch { /* text */ }
    return { status: r.status, body: b };
  };
  const call = (tool: string, args: Record<string, unknown> = {}, key = 'k-alice') => req('tools/call', { server: 'ledger', tool, arguments: args }, key);
  await sleep(250); // let the start-up reconcile pass run
  return { gw, base, req, call, s, config };
}
const edge = (rules: unknown[], more: Record<string, unknown> = {}, s?: ReturnType<typeof setup>) => ({ edgeAutonomy: { ...(s ? { dir: s.state } : {}), rules, reconcile: { intervalMs: 3_600_000, leaseMs: 2000 }, ...more } });
const offline = (req: Req, disconnected = true) => req('admin/edge-autonomy/connectivity', { disconnected });
const errOf = (r: { body: any }) => ({ message: typeof r.body?.message === 'string' ? r.body.message : r.body?.error?.message }) as { message?: string }; // eslint-disable-line @typescript-eslint/no-explicit-any
const metricsOf = async (base: string) => (await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer op' } })).text();
const receipt = (r: { body: any }) => r.body?.result?.structuredContent as { queued: boolean; outboxId: string; duplicate?: boolean; review?: string }; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('14.6.0 offline permission boundaries', () => {
  it('schema: defaults (high-risk denied offline, queue TTL / size / on-expiry, lease) and validation', () => {
    const p = EdgeAutonomySchema.parse({ rules: [{ match: '*', action: 'queue' }] });
    expect(p.highRisk).toBe('deny');
    expect(p.queue).toEqual({ ttlSeconds: 86_400, onExpiry: 'review' });
    expect(p.reconcile).toMatchObject({ intervalMs: 5000, maxAttempts: 5, leaseMs: 30_000, requireFreshRevocations: true });
    expect(EdgeAutonomySchema.parse({ rules: [{ match: '*', action: 'queue' }], policies: [{ match: 'crm/update_*', offline: 'allow', idempotent: true, conflictKey: ['id'], ttlSeconds: 60 }] }).policies[0]).toMatchObject({ offline: 'allow' });
    expect(() => EdgeAutonomySchema.parse({ rules: [{ match: '*', action: 'queue' }], policies: [{ match: 'x', risk: 'extreme' }] })).toThrow();
    expect(() => EdgeAutonomySchema.parse({ rules: [{ match: '*', action: 'queue' }], queue: { onExpiry: 'replay' } })).toThrow();
    expect(() => EdgeAutonomySchema.parse({ rules: [{ match: '*', action: 'queue' }], queue: { ttlSeconds: 0 } })).toThrow();
    expect(() => validateConfig({ servers: [], features: { edgeAutonomy: { rules: [{ match: '*', action: 'queue' }], highRisk: 'allow', seal: { keyEnv: 'EDGE_KEY' } } } })).not.toThrow();
    expect(ERR_EDGE_DENIED).toBe(-32018);
  });

  it('classifier: declared risk > MCP annotations > tool-name heuristics', () => {
    const c = EdgeAutonomySchema.parse({ rules: [{ match: '*', action: 'queue' }], policies: [{ match: 'crm/sync_now', risk: 'high' }, { match: 'crm/delete_draft', risk: 'low' }] });
    expect(classifyOffline(c, 'crm', 'get_contact')).toMatchObject({ risk: 'low' });
    expect(classifyOffline(c, 'crm', 'note')).toMatchObject({ risk: 'medium' });
    expect(classifyOffline(c, 'crm', 'update_contact')).toMatchObject({ risk: 'high', reasons: expect.arrayContaining(['write']) });
    expect(classifyOffline(c, 'crm', 'deleteContact')).toMatchObject({ risk: 'high', reasons: expect.arrayContaining(['delete']) });
    expect(classifyOffline(c, 'pay', 'create_charge')).toMatchObject({ risk: 'critical', reasons: expect.arrayContaining(['payment']) });
    expect(classifyOffline(c, 'bank', 'transfer_funds')).toMatchObject({ risk: 'critical' });
    expect(classifyOffline(c, 'crm', 'sync_now')).toMatchObject({ risk: 'high', reasons: ['declared'] });
    expect(classifyOffline(c, 'crm', 'delete_draft')).toMatchObject({ risk: 'low', reasons: ['declared'] });
    expect(classifyOffline(c, 'x', 'mystery', { readOnlyHint: true })).toMatchObject({ risk: 'low' });
    expect(classifyOffline(c, 'x', 'get_thing', { destructiveHint: true })).toMatchObject({ risk: 'high', reasons: expect.arrayContaining(['destructive']) });
    expect(classifyOffline(c, 'x', 'mystery', { readOnlyHint: false })).toMatchObject({ risk: 'high', reasons: expect.arrayContaining(['write']) });
    expect(classifyOffline(c, 'x', 'mystery', { readOnlyHint: false, idempotentHint: false })).toMatchObject({ reasons: expect.arrayContaining(['non-idempotent']) });
  });

  it('while offline: writes, deletes, payments and declared high-risk tools are denied by default — for queue, cache and wasm rules alike', async () => {
    const g = await start(edge([{ match: 'ledger/lookup', action: 'cache' }, { match: 'ledger/*', action: 'queue' }], { policies: [{ match: 'ledger/note', risk: 'high' }] }));
    expect((await g.call('lookup', { q: 1 })).status).toBe(200);
    await offline(g.req);
    for (const tool of ['rename', 'wipe', 'charge', 'note']) {
      const r = await g.call(tool, { id: 1 });
      expect(r.status, tool).toBe(502);
      expect(errOf(r).message, tool).toMatch(/high-risk|not allowed offline/i);
    }
    const den = (await g.req('admin/edge-autonomy/decisions')).body.decisions.filter((d: { action: string }) => d.action === 'deny');
    expect(den.map((d: { tool: string; risk: string }) => [d.tool, d.risk]).sort()).toEqual([['charge', 'critical'], ['note', 'high'], ['rename', 'high'], ['wipe', 'high']]);
    // reads keep their local answers
    expect((await g.call('lookup', { q: 1 })).status).toBe(200);
    expect((await g.req('admin/edge-autonomy/outbox')).body.entries).toHaveLength(0);
    await offline(g.req, false);
    await g.req('admin/edge-autonomy/reconcile', {});
    expect(g.s.ledgerOf().filter((l) => l.tool !== 'lookup')).toHaveLength(0);
  });

  it('a declared policy allows a high-risk tool offline; offline: deny blocks even low-risk tools; highRisk: allow restores the 10.7 behaviour', async () => {
    const g = await start(edge([{ match: 'ledger/*', action: 'queue' }], { policies: [{ match: 'ledger/rename', offline: 'allow', idempotent: true }, { match: 'ledger/lookup', offline: 'deny' }] }));
    await offline(g.req);
    expect(receipt(await g.call('rename', { id: 1, name: 'x' })).queued).toBe(true);
    expect(errOf(await g.call('lookup', {})).message).toMatch(/not allowed offline/);
    expect((await g.call('charge', {})).status).toBe(502);
    await g.gw.reload({ ...g.config, ...edge([{ match: 'ledger/*', action: 'queue' }], { highRisk: 'allow' }) } as never);
    expect(receipt(await g.call('charge', { id: 9 })).queued).toBe(true);
  });
});

describe('14.6.0 queue expiry and size', () => {
  it('items expire after their TTL (policy ttlSeconds over queue.ttlSeconds) into the review queue, or are dropped; a full queue denies', async () => {
    const g = await start(edge([{ match: 'ledger/*', action: 'queue' }], { queue: { ttlSeconds: 3600, maxItems: 3 }, policies: [{ match: 'ledger/note', ttlSeconds: 1 }] }));
    await offline(g.req);
    const short = receipt(await g.call('note', { n: 1 })).outboxId;
    const long = receipt(await g.call('slow', { ms: 1, n: 2 }, 'k-alice')).outboxId;
    expect(receipt(await g.call('lookup', { n: 3 })).queued).toBe(true);
    const full = await g.call('lookup', { n: 4 });
    expect(full.status).toBe(502);
    expect(errOf(full).message).toMatch(/queue is full \(3/);
    const ob = (await g.req('admin/edge-autonomy/outbox')).body.entries;
    expect(ob.find((e: { id: string }) => e.id === short).expiresAt).toBeDefined();
    await sleep(1200);
    await offline(g.req, false);
    const r = (await g.req('admin/edge-autonomy/reconcile', {})).body;
    expect(r).toMatchObject({ expired: 1, applied: 2 });
    const rev = (await g.req('admin/edge-autonomy/review')).body.entries;
    expect(rev).toEqual([expect.objectContaining({ id: short, status: 'review', reviewReason: 'expired' })]);
    expect(g.s.ledgerOf().map((l) => l.tool).sort()).toEqual(['lookup', 'slow']);
    expect((await g.req('admin/edge-autonomy/outbox')).body.entries.find((e: { id: string }) => e.id === long).status).toBe('applied');
    // onExpiry: drop
    await g.gw.reload({ ...g.config, ...edge([{ match: 'ledger/*', action: 'queue' }], { queue: { ttlSeconds: 1, onExpiry: 'drop' } }) } as never);
    await offline(g.req);
    const gone = receipt(await g.call('note', {})).outboxId;
    await sleep(1200);
    await offline(g.req, false);
    expect((await g.req('admin/edge-autonomy/reconcile', {})).body).toMatchObject({ expired: 1, applied: 0 });
    expect((await g.req('admin/edge-autonomy/outbox')).body.entries.some((e: { id: string }) => e.id === gone)).toBe(false);
  });
});

describe('14.6.0 conflicts, idempotency and the review queue', () => {
  it('idempotency keys: a repeated key with the same payload returns the first receipt; with another payload it goes to review; the upstream sees the key once', async () => {
    const g = await start(edge([{ match: 'ledger/*', action: 'queue' }], { policies: [{ match: 'ledger/rename', offline: 'allow' }], reconcile: { intervalMs: 3_600_000, idempotencyArg: 'idem' } }));
    await offline(g.req);
    const a = receipt(await g.call('rename', { id: 1, name: 'A', idem: 'k1' }));
    const again = receipt(await g.call('rename', { id: 1, name: 'A', idem: 'k1' }));
    expect(again).toMatchObject({ outboxId: a.outboxId, duplicate: true });
    const other = receipt(await g.call('rename', { id: 1, name: 'B', idem: 'k1' }));
    expect(other.outboxId).not.toBe(a.outboxId);
    expect(other.review).toBe('idempotency-conflict');
    const generated = receipt(await g.call('rename', { id: 2, name: 'C' })).outboxId;
    await offline(g.req, false);
    expect((await g.req('admin/edge-autonomy/reconcile', {})).body).toMatchObject({ applied: 2 });
    const calls = g.s.ledgerOf().filter((l) => l.tool === 'rename');
    expect(calls.map((c) => c.args.idem)).toEqual(['k1', generated]); // the client's key, else the outbox id
    // a committed replay is never sent twice, even when an operator re-queues it
    const [rv] = (await g.req('admin/edge-autonomy/review')).body.entries;
    expect(rv).toMatchObject({ id: other.outboxId, reviewReason: 'idempotency-conflict' });
    expect((await g.req(`admin/edge-autonomy/outbox/${a.outboxId}/retry`, {})).status).toBe(409);
  });

  it('conflict keys: concurrent offline writes to the same record by different clients go to review; one client\'s writes replay in order', async () => {
    const g = await start(edge([{ match: 'ledger/*', action: 'queue' }], { policies: [{ match: 'ledger/rename', offline: 'allow', idempotent: true, conflictKey: ['id'] }] }));
    await offline(g.req);
    const a1 = receipt(await g.call('rename', { id: 7, name: 'a1' }, 'k-alice')).outboxId;
    const a2 = receipt(await g.call('rename', { id: 7, name: 'a2' }, 'k-alice')).outboxId;
    const b1 = receipt(await g.call('rename', { id: 7, name: 'b1' }, 'k-bob')).outboxId;
    const b2 = receipt(await g.call('rename', { id: 8, name: 'b2' }, 'k-bob')).outboxId;
    await offline(g.req, false);
    const r = (await g.req('admin/edge-autonomy/reconcile', {})).body;
    expect(r).toMatchObject({ applied: 3, review: 1 });
    expect(g.s.ledgerOf().map((l) => l.args.name)).toEqual(['a1', 'a2', 'b2']);
    const rev = (await g.req('admin/edge-autonomy/review')).body.entries;
    expect(rev).toEqual([expect.objectContaining({ id: b1, reviewReason: 'conflict-key', conflictWith: expect.arrayContaining([a1, a2]) })]);
    void b2;
    // the operator decides: replay it anyway (operator retry) or discard
    expect((await g.req(`admin/edge-autonomy/outbox/${b1}/retry`, {})).body.status).toBe('queued');
    expect((await g.req('admin/edge-autonomy/reconcile', {})).body).toMatchObject({ applied: 1 });
    expect(g.s.ledgerOf().map((l) => l.args.name)).toEqual(['a1', 'a2', 'b2', 'b1']);
  });

  it('a stale write the upstream rejects as a conflict goes to review at once (no retries); an earlier pending entry holds back later entries of the same client', async () => {
    const g = await start(edge([{ match: 'ledger/*', action: 'queue' }], { policies: [{ match: 'ledger/*', offline: 'allow', idempotent: true }], reconcile: { intervalMs: 3_600_000, maxAttempts: 5 } }));
    await offline(g.req);
    const stale = receipt(await g.call('reject', { id: 1 })).outboxId;
    const after = receipt(await g.call('rename', { id: 1, name: 'z' })).outboxId;
    await offline(g.req, false);
    const r = (await g.req('admin/edge-autonomy/reconcile', {})).body;
    expect(r).toMatchObject({ review: 1, applied: 1 });
    const [rv] = (await g.req('admin/edge-autonomy/review')).body.entries;
    expect(rv).toMatchObject({ id: stale, reviewReason: 'upstream-conflict', attempts: 1 });
    expect(rv.lastError).toMatch(/version conflict/);
    void after;
    // ordering: a pending entry (server offline again) blocks the same client's later entries, other clients proceed
    await g.req('admin/edge-autonomy/connectivity', { servers: ['ledger'], disconnected: true });
    const first = receipt(await g.call('slow', { ms: 10 }, 'k-alice')).outboxId;
    edgeFaults.beforeReplay = (e) => { if (e.id === first) throw new Error('transient: socket hang up'); };
    const second = receipt(await g.call('rename', { id: 2, name: 'second' }, 'k-alice')).outboxId;
    const bob = receipt(await g.call('rename', { id: 3, name: 'bob' }, 'k-bob')).outboxId;
    await offline(g.req, false);
    const r2 = (await g.req('admin/edge-autonomy/reconcile', {})).body;
    expect(r2).toMatchObject({ failed: 1, applied: 1, held: 1 });
    const ob = (await g.req('admin/edge-autonomy/outbox')).body.entries;
    expect(ob.find((e: { id: string }) => e.id === second).status).toBe('queued');
    expect(ob.find((e: { id: string }) => e.id === bob).status).toBe('applied');
    delete edgeFaults.beforeReplay;
    expect((await g.req('admin/edge-autonomy/reconcile', {})).body).toMatchObject({ applied: 2 });
    const names = g.s.ledgerOf().filter((l) => l.tool === 'slow' || l.args.name === 'second').map((l) => l.tool);
    expect(names).toEqual(['slow', 'rename']); // in queue order
  });
});

describe('14.6.0 reconnect reconciliation: fencing and revocations', () => {
  it('a reconciler whose fencing epoch is superseded stops before its next replay', async () => {
    const g = await start(edge([{ match: 'ledger/*', action: 'queue' }]));
    await offline(g.req);
    for (let i = 0; i < 3; i++) await g.call('note', { i });
    await offline(g.req, false);
    edgeFaults.beforeReplay = async (_e, ctl) => { if (ctl.index === 1) await ctl.supersede(); };
    const r = (await g.req('admin/edge-autonomy/reconcile', {})).body;
    expect(r).toMatchObject({ applied: 1, fenced: true });
    expect(g.s.ledgerOf()).toHaveLength(1);
    delete edgeFaults.beforeReplay;
    expect((await g.req('admin/edge-autonomy/reconcile', {})).body).toMatchObject({ applied: 2, fenced: false });
    const rep = (await g.req('admin/edge-autonomy/report')).body;
    expect(rep.reconcile.epoch).toBeGreaterThanOrEqual(3);
  });

  it('queued calls of a key removed or revoked while offline are rejected, never executed; the current scope applies to the rest', async () => {
    const g = await start(edge([{ match: 'ledger/*', action: 'queue' }]));
    await offline(g.req);
    const removed = receipt(await g.call('note', { who: 'alice' }, 'k-alice')).outboxId;
    const revoked = receipt(await g.call('note', { who: 'bob' }, 'k-bob')).outboxId;
    const opq = receipt(await g.call('note', { who: 'op' }, 'op')).outboxId;
    await g.gw.reload({ ...g.config, auth: { strategy: 'api-key', apiKeys: [KEYS[0], KEYS[2]] } } as never);
    // a revocation announced by the core (developer portal / operator) while offline
    const bobId = (await g.req('admin/edge-autonomy/outbox')).body.entries.find((e: { id: string }) => e.id === revoked).clientId;
    runInScope(g.gw.instanceScope, () => announceRevocation(bobId, 'leaked'));
    await offline(g.req, false);
    const r = (await g.req('admin/edge-autonomy/reconcile', {})).body;
    expect(r).toMatchObject({ rejected: 2, applied: 1 });
    expect(g.s.ledgerOf().map((l) => l.args.who)).toEqual(['op']);
    const ob = (await g.req('admin/edge-autonomy/outbox')).body.entries;
    expect(ob.find((e: { id: string }) => e.id === removed)).toMatchObject({ status: 'rejected', reviewReason: 'credential-removed' });
    expect(ob.find((e: { id: string }) => e.id === revoked)).toMatchObject({ status: 'rejected', reviewReason: 'revoked' });
    expect(ob.find((e: { id: string }) => e.id === opq).status).toBe('applied');
    expect((await g.req(`admin/edge-autonomy/outbox/${removed}/retry`, {})).status).toBe(409); // never re-queued
  });

  it('simulated outage: a client revoked in another region while the edge was offline does not have its queued calls executed on reconnect', async () => {
    const AUTH = { strategy: 'api-key', apiKeys: KEYS };
    const a = await start({ auth: AUTH });
    const s = setup();
    // edge region B keeps serving while partitioned (onStale: allow) — the edge's whole point — and syncs slowly
    const regionsB = (url: string) => ({ self: 'b', syncIntervalMs: 2000, downAfter: 2, consistency: { maxStalenessMs: 30_000, onStale: 'allow' }, peers: [{ id: 'a', url, apiKey: 'op' }] });
    const b = await start({ auth: AUTH, regions: regionsB(a.base), ...edge([{ match: 'ledger/*', action: 'queue' }], {}, s) }, s);
    await a.gw.reload({ ...a.config, regions: { self: 'a', syncIntervalMs: 2000, downAfter: 2, consistency: { maxStalenessMs: 30_000, onStale: 'allow' }, peers: [{ id: 'b', url: b.base, apiKey: 'op' }] } } as never);
    await sleep(300);
    expect((await b.req('admin/regions/health')).status).toBe(200);

    // outage: the edge loses its upstream and its peer region
    regionFaults.partitioned.add('a|b');
    await offline(b.req);
    const q1 = receipt(await b.call('note', { who: 'alice' }, 'k-alice')).outboxId;
    const q2 = receipt(await b.call('note', { who: 'bob' }, 'k-bob')).outboxId;
    const aliceId = (await b.req('admin/edge-autonomy/outbox')).body.entries.find((e: { id: string }) => e.id === q1).clientId;
    // during the outage region A revokes alice
    expect((await a.req('admin/regions/revocations', { clientId: aliceId, reason: 'stolen laptop' })).status).toBe(200);
    expect((await b.req('admin/regions/revocations')).body.revocations).toHaveLength(0); // B cannot know yet

    // reconnect: partition heals and the upstream is back; reconcile runs at once (before the next periodic sync)
    regionFaults.partitioned.clear();
    await offline(b.req, false);
    const r = (await b.req('admin/edge-autonomy/reconcile', {})).body;
    expect(r).toMatchObject({ rejected: 1, applied: 1 });
    expect(s.ledgerOf().map((l) => l.args.who)).toEqual(['bob']);
    const ob = (await b.req('admin/edge-autonomy/outbox')).body.entries;
    expect(ob.find((e: { id: string }) => e.id === q1)).toMatchObject({ status: 'rejected', reviewReason: 'revoked' });
    expect(ob.find((e: { id: string }) => e.id === q2).status).toBe('applied');
    // and the revocation is now enforced for live calls in B as well
    expect(JSON.stringify((await b.call('lookup', {}, 'k-alice')).body)).toContain(String(ERR_REGION_REVOKED));
  });

  it('when revocations cannot be confirmed fresh after reconnect, queued calls wait (pending) instead of running', async () => {
    const AUTH = { strategy: 'api-key', apiKeys: KEYS };
    const s = setup();
    const b = await start({ auth: AUTH, regions: { self: 'b', syncIntervalMs: 2000, downAfter: 1, consistency: { maxStalenessMs: 30_000, onStale: 'allow' }, peers: [{ id: 'a', url: 'http://127.0.0.1:9', apiKey: 'op' }] }, ...edge([{ match: 'ledger/*', action: 'queue' }], {}, s) }, s);
    await offline(b.req);
    receipt(await b.call('note', {}, 'k-alice'));
    await offline(b.req, false);
    const r = (await b.req('admin/edge-autonomy/reconcile', {})).body;
    expect(r).toMatchObject({ applied: 0, pending: 1, waiting: expect.stringMatching(/revocation/) });
    expect(s.ledgerOf()).toHaveLength(0);
    // the operator may opt out (requireFreshRevocations: false) — the local checks still apply
    await b.gw.reload({ ...(b.config as object), ...edge([{ match: 'ledger/*', action: 'queue' }], { reconcile: { intervalMs: 3_600_000, requireFreshRevocations: false } }, s) } as never);
    expect((await b.req('admin/edge-autonomy/reconcile', {})).body).toMatchObject({ applied: 1 });
  });
});

describe('14.6.0 sealed queue at rest', () => {
  it('outbox and cache are sealed (AES-256-GCM), 0600 files in a 0700 directory; tampering is detected and quarantined', async () => {
    const s = setup();
    const g = await start(edge([{ match: 'ledger/lookup', action: 'cache' }, { match: 'ledger/*', action: 'queue' }], {}, s), s);
    expect((await g.call('lookup', { secret: 'cached-sensitive-value' })).status).toBe(200);
    await offline(g.req);
    receipt(await g.call('note', { secret: 'queued-sensitive-value' }));
    expect(statSync(s.state).mode & 0o777).toBe(0o700);
    for (const f of ['outbox.json', 'cache.json', '.seal.key']) expect(statSync(join(s.state, f)).mode & 0o777, f).toBe(0o600);
    const raw = readFileSync(join(s.state, 'outbox.json'), 'utf8');
    expect(raw).not.toContain('queued-sensitive-value');
    expect(raw).not.toContain('alice');
    expect(JSON.parse(raw)).toMatchObject({ sealed: 'aes-256-gcm', v: 1 });
    expect(readFileSync(join(s.state, 'cache.json'), 'utf8')).not.toContain('cached-sensitive-value');

    // tamper with the sealed outbox, restart the gateway on the same dir
    const doc = JSON.parse(raw);
    doc.data = Buffer.from(Buffer.from(doc.data, 'base64').map((b, i) => (i === 3 ? b ^ 1 : b))).toString('base64');
    writeFileSync(join(s.state, 'outbox.json'), JSON.stringify(doc));
    await g.gw.stop();
    edgeState.reset();
    const g2 = await start(edge([{ match: 'ledger/*', action: 'queue' }], {}, s), s);
    const st = (await g2.req('admin/edge-autonomy')).body;
    expect(st.seal).toMatchObject({ ok: false, error: expect.stringMatching(/tamper|authenticat/i) });
    expect(st.outbox.queued).toBe(0);
    expect(readdirSync(s.state).some((f) => f.startsWith('outbox.json.tampered-'))).toBe(true);
    await g2.req('admin/edge-autonomy/reconcile', {});
    expect(s.ledgerOf().filter((l) => l.tool === 'note')).toHaveLength(0);
    expect(await metricsOf(g2.base)).toMatch(/mcp_gateway_edge_seal_failures_total [1-9]/);
  });

  it('seal.keyEnv supplies the key; a legacy plaintext outbox (≤ 14.5) is migrated sealed once', async () => {
    const s = setup();
    process.env.EDGE_TEST_SEAL_KEY = Buffer.alloc(32, 7).toString('base64');
    const legacy = [{ id: 'ob-legacy', at: new Date().toISOString(), clientId: 'key:ops', serverId: 'ledger', tool: 'lookup', args: { q: 'legacy' }, status: 'queued', attempts: 0 }];
    const { mkdirSync } = await import('node:fs');
    mkdirSync(s.state, { recursive: true });
    writeFileSync(join(s.state, 'outbox.json'), JSON.stringify(legacy));
    chmodSync(join(s.state, 'outbox.json'), 0o644);
    const g = await start(edge([{ match: 'ledger/*', action: 'queue' }], { seal: { keyEnv: 'EDGE_TEST_SEAL_KEY' } }, s), s);
    await offline(g.req);
    const ob = (await g.req('admin/edge-autonomy/outbox')).body.entries;
    expect(ob).toEqual([expect.objectContaining({ id: 'ob-legacy', seq: 1 })]); // migrated (and replayed by the start-up pass)
    expect(existsSync(join(s.state, '.seal.key'))).toBe(false);
    const raw = readFileSync(join(s.state, 'outbox.json'), 'utf8');
    expect(raw).not.toContain('legacy');
    expect(statSync(join(s.state, 'outbox.json')).mode & 0o777).toBe(0o600);
  });
});

describe('14.6.0 metrics, report and the edge CLI', () => {
  it('Prometheus metrics, GET /report, and `mcp-gateway edge report|queue|reconcile`', async () => {
    const g = await start(edge([{ match: 'ledger/*', action: 'queue' }]));
    await offline(g.req);
    receipt(await g.call('note', {}));
    expect((await g.call('charge', {})).status).toBe(502);
    const m = await metricsOf(g.base);
    expect(m).toMatch(/mcp_gateway_edge_queue_items\{status="queued"\} 1/);
    expect(m).toMatch(/mcp_gateway_edge_offline_denied_total\{risk="critical"\} 1/);
    expect(m).toMatch(/mcp_gateway_edge_queue_oldest_age_seconds \d/);
    const rep = (await g.req('admin/edge-autonomy/report')).body;
    expect(rep).toMatchObject({ highRisk: 'deny', queue: { queued: 1, maxItems: 10_000, ttlSeconds: 86_400, onExpiry: 'review' }, servers: [{ id: 'ledger', disconnected: 'forced by operator' }] });
    expect(rep.denied.critical).toBe(1);

    const cli = (args: string[]) => new Promise<{ code: number | null; out: string }>((res) => {
      const p = spawn(process.execPath, ['--import', 'tsx', CLI, ...args, '--url', g.base, '--key', 'op'], { cwd: resolve(__dirname, '..'), env: { ...process.env, MCP_GATEWAY_URL: '', MCP_GATEWAY_ADMIN_KEY: '' } });
      let out = '';
      p.stdout.on('data', (c) => (out += c));
      p.stderr.on('data', (c) => (out += c));
      p.on('close', (code) => res({ code, out }));
    });
    const r1 = await cli(['edge', 'report']);
    expect(r1.code, r1.out).toBe(0);
    expect(r1.out).toMatch(/queued 1/);
    expect(r1.out).toMatch(/ledger\s+DISCONNECTED/);
    const r2 = await cli(['edge', 'queue', '--json']);
    expect(JSON.parse(r2.out).entries).toHaveLength(1);
    await offline(g.req, false);
    const r3 = await cli(['edge', 'reconcile']);
    expect(r3.code, r3.out).toBe(0);
    expect(r3.out).toMatch(/applied 1/);
    expect(await metricsOf(g.base)).toMatch(/mcp_gateway_edge_reconcile_total\{result="applied"\} 1/);
  }, 60_000);
});
