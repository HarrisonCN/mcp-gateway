// 14.4.0 "持久化任务执行": durable task execution on the existing task graphs — resumable execution from the last
// committed step, idempotency keys (per task and per tool call, intent log / outbox), DLQ with retry policy, approval
// resume, idempotent saga compensation, tenant isolation of tasks, metrics, CLI. Restart here is a soft restart (a new
// Gateway on the same store); kill -9 restarts are in durable-tasks-restart-14-4-0.test.ts and two gateways sharing
// Redis in durable-tasks-multi-14-4-0.test.ts.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { Gateway } from '../src/gateway/index.js';
import { validateConfig } from '../src/config/loader.js';
import { buildV12ConfigSchema } from '../src/config/v12.js';
import { taskRuns } from '../src/features/task-graphs.js';
import { durableFaults, SimulatedCrash } from '../src/orchestration/durable-tasks.js';
import type { GatewayConfig } from '../src/utils/types.js';

const LEDGER_FIXTURE = resolve(__dirname, 'fixtures', 'ledger-mcp-server.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Env { dir: string; ledger: string; store: string }
const env = (): Env => {
  const dir = mkdtempSync(join(tmpdir(), 'durable-'));
  return { dir, ledger: join(dir, 'ledger.jsonl'), store: join(dir, 'state.db') };
};
const ledgerOf = (e: Env): Array<{ tool: string; args: Record<string, unknown>; dup?: boolean }> =>
  existsSync(e.ledger) ? readFileSync(e.ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const count = (e: Env, tool: string, pred: (a: Record<string, unknown>) => boolean = () => true) => ledgerOf(e).filter((l) => l.tool === tool && pred(l.args)).length;

const gws: Gateway[] = [];
afterEach(async () => {
  durableFaults.afterCall = undefined;
  durableFaults.afterCommit = undefined;
  for (const g of gws.splice(0)) await g.stop().catch(() => undefined);
  taskRuns.reset();
});

const KEYS = [{ key: 'op', name: 'ops' }, { key: 'k-alice', name: 'alice' }, { key: 'k-bob', name: 'bob' }, { key: 'k-lead', name: 'lead-1' }, { key: 'k-carol', name: 'carol' }];
const TENANTS = [
  { id: 'acme', servers: ['ledger'], members: [{ client: 'key:alice', role: 'admin' }, { client: 'key:lead-1', role: 'admin' }, { client: 'key:carol', role: 'admin' }] },
  { id: 'labs', servers: ['ledger', 'labs-*'], members: [{ client: 'key:bob', role: 'admin' }, { client: 'key:carol', role: 'admin' }] },
];

async function start(e: Env, taskGraphs: Record<string, unknown>, extra: Partial<GatewayConfig> = {}) {
  const gw = new Gateway({
    port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false },
    servers: [{ id: 'ledger', name: 'ledger', transport: 'stdio', command: process.execPath, args: [LEDGER_FIXTURE], env: { LEDGER: e.ledger }, timeout: 10_000 }],
    auth: { strategy: 'api-key', apiKeys: KEYS },
    tenants: TENANTS,
    state: { store: 'sqlite', sqlite: { path: e.store } },
    taskGraphs,
    ...extra,
  } as unknown as GatewayConfig);
  await gw.start();
  gws.push(gw);
  const base = `http://127.0.0.1:${gw.address()!.port}`;
  const req = async (path: string, body?: unknown, key = 'op', headers: Record<string, string> = {}, method?: string) => {
    const r = await fetch(`${base}/api/v1/${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const t = await r.text();
    let b: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try { b = JSON.parse(t); } catch { b = t; }
    return { status: r.status, body: b, headers: r.headers };
  };
  const admin = (p: string, body?: unknown, headers?: Record<string, string>, method?: string) => req(`admin/task-graphs${p}`, body, 'op', headers, method);
  const client = (key: string, p: string, body?: unknown, headers?: Record<string, string>, method?: string) => req(`features/task-graphs${p}`, body, key, headers, method);
  return { gw, base, req, admin, client };
}
type Gw = Awaited<ReturnType<typeof start>>;

async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting; last value ${JSON.stringify(v)}`);
    await sleep(50);
  }
}
const runOf = (g: Gw, id: string) => g.admin(`/runs/${id}`).then((r) => r.body);
const settled = (g: Gw, id: string, statuses = ['succeeded', 'failed', 'compensated', 'compensation_failed', 'dead_letter', 'cancelled', 'awaiting_approval']) => until(() => runOf(g, id), (r) => statuses.includes(r.status));

const DURABLE = { leaseMs: 1000, sweepIntervalMs: 100, dlq: { retry: { attempts: 3, backoffMs: 50, factor: 2, maxBackoffMs: 1000 } } };
const node = (id: string, tool: string, more: Record<string, unknown> = {}) => ({ id, tool: `ledger/${tool}`, ...more });

describe('durable task execution (14.4.0)', () => {
  it('config: the durable block, node idempotency / approval, client graphs validate; bad values are refused; schema v12 describes them', () => {
    const cfg = validateConfig({ version: 12, servers: [], features: { taskGraphs: { durable: { backend: 'store', leaseMs: 2000, dlq: { retry: { attempts: 2 } } }, graphs: [{ id: 'g', clients: true, nodes: [{ id: 'a', tool: 's/t', idempotencyArg: 'idempotencyKey', approval: { approvers: ['key:lead-*'], required: 1, timeoutSeconds: 60 }, compensate: { tool: 's/u', idempotencyArg: 'key' } }] }] } } });
    expect(cfg.taskGraphs).toBeDefined();
    expect(() => validateConfig({ servers: [], features: { taskGraphs: { durable: { leaseMs: 10 }, graphs: [{ id: 'g', nodes: [{ id: 'a', tool: 's/t' }] }] } } })).toThrow();
    expect(() => validateConfig({ servers: [], features: { taskGraphs: { durable: { backend: 'nope' }, graphs: [{ id: 'g', nodes: [{ id: 'a', tool: 's/t' }] }] } } })).toThrow();
    expect(() => validateConfig({ servers: [], features: { taskGraphs: { graphs: [{ id: 'g', nodes: [{ id: 'a', tool: 's/t', approval: { approvers: [] } }] }] } } })).toThrow();
    const s = JSON.stringify(buildV12ConfigSchema());
    for (const k of ['resumeOnStart', 'idempotencyTtlSeconds', 'idempotencyArg', 'approvers', 'leaseMs']) expect(s).toContain(k);
    expect(existsSync(resolve(__dirname, '..', 'docs', 'guides', 'durable-tasks.md'))).toBe(true);
  });

  it('resumes after a restart from the last committed step: committed nodes are not executed again', async () => {
    const e = env();
    const tg = { durable: DURABLE, graphs: [{ id: 'order', nodes: [node('a', 'charge', { args: { id: 'A' } }), node('b', 'slow', { needs: ['a'], args: { ms: 1500 }, idempotent: true }), node('c', 'charge', { needs: ['b'], args: { id: 'C' } })] }] };
    let g = await start(e, tg);
    const { body } = await g.admin('/run', { graph: 'order', input: {} });
    await until(async () => count(e, 'slow'), (n) => n === 1);
    await g.gw.stop(); // restart while b is in flight
    gws.length = 0;
    g = await start(e, tg); // resumeOnStart picks the run up
    const run = await settled(g, body.runId, ['succeeded']);
    expect(run.nodes.map((n: { status: string }) => n.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(count(e, 'charge', (a) => a.id === 'A')).toBe(1); // committed before the restart: not again
    expect(count(e, 'slow')).toBe(2); // in flight at the restart, idempotent: executed again
    expect(count(e, 'charge', (a) => a.id === 'C')).toBe(1);
    expect(run.epoch).toBeGreaterThanOrEqual(2);
    expect(run.audit.map((x: { action: string }) => x.action)).toContain('resume');
  });

  it('idempotency key per task: duplicates (concurrent, and after a restart) return the same run, a different payload is 409, keys are per client', async () => {
    const e = env();
    const tg = { durable: DURABLE, graphs: [{ id: 'pay', clients: true, nodes: [node('a', 'charge', { args: { id: '{{input.id}}' } })] }] };
    let g = await start(e, tg);
    const H = { 'idempotency-key': 'order-42' };
    const [r1, r2, r3] = await Promise.all([g.admin('/run', { graph: 'pay', input: { id: 'X' }, wait: true }, H), g.admin('/run', { graph: 'pay', input: { id: 'X' }, wait: true }, H), g.admin('/run', { graph: 'pay', input: { id: 'X' }, idempotencyKey: 'order-42' })]);
    expect(r1.status).toBe(200);
    expect(r2.body.id ?? r2.body.runId).toBe(r1.body.id);
    expect(r3.body.runId).toBe(r1.body.id);
    expect([r1, r2].some((r) => r.headers.get('idempotent-replayed') === 'true') || r3.body.duplicate === true).toBe(true);
    expect(count(e, 'charge')).toBe(1);
    expect((await g.admin('/run', { graph: 'pay', input: { id: 'Y' } }, H)).status).toBe(409);
    // another client with the same key gets its own run (keys are namespaced per client)
    const other = await g.client('k-alice', '/run', { graph: 'pay', input: { id: 'X' }, wait: true }, H);
    expect(other.status).toBe(200);
    expect(other.body.id).not.toBe(r1.body.id);
    expect(count(e, 'charge')).toBe(2);
    await g.gw.stop();
    gws.length = 0;
    g = await start(e, tg);
    const again = await g.admin('/run', { graph: 'pay', input: { id: 'X' } }, H);
    expect(again.body).toMatchObject({ runId: r1.body.id, duplicate: true });
    expect(count(e, 'charge')).toBe(2);
    // without durable, an idempotency key is refused rather than ignored
    const e2 = env();
    const plain = await start(e2, { graphs: [{ ...tg.graphs[0], clients: false }] });
    expect((await plain.admin('/run', { graph: 'pay', input: {} }, H)).status).toBe(400);
  });

  it('per tool call: a crash between the call and its commit never re-executes a non-idempotent call (outcome unknown → DLQ); replay needs force', async () => {
    const e = env();
    const tg = { durable: DURABLE, graphs: [{ id: 'g', nodes: [node('a', 'charge', { args: { id: 'A' } }), node('pay', 'charge', { needs: ['a'], args: { id: 'P' } }), node('z', 'charge', { needs: ['pay'], args: { id: 'Z' } })] }] };
    let g = await start(e, tg);
    durableFaults.afterCall = (p) => { if (p.node === 'pay' && p.kind === 'action') throw new SimulatedCrash(); };
    const { body } = await g.admin('/run', { graph: 'g', input: {} });
    await until(async () => count(e, 'charge', (a) => a.id === 'P'), (n) => n === 1);
    await sleep(100);
    durableFaults.afterCall = undefined;
    await g.gw.stop();
    gws.length = 0;
    g = await start(e, tg);
    const run = await settled(g, body.runId, ['dead_letter']);
    expect(run.nodes.find((n: { id: string }) => n.id === 'pay')).toMatchObject({ status: 'outcome_unknown' });
    expect(count(e, 'charge', (a) => a.id === 'P')).toBe(1);
    expect(count(e, 'charge', (a) => a.id === 'Z')).toBe(0);
    const dlq = (await g.admin('/dlq')).body.entries;
    expect(dlq).toHaveLength(1);
    expect(dlq[0]).toMatchObject({ runId: body.runId, node: 'pay', retryable: false });
    expect(dlq[0].reason).toMatch(/outcome unknown/i);
    await sleep(400); // not retried automatically
    expect(count(e, 'charge', (a) => a.id === 'P')).toBe(1);
    expect((await g.admin(`/dlq/${dlq[0].id}/replay`, {})).status).toBe(409);
    const replayed = await g.admin(`/dlq/${dlq[0].id}/replay`, { force: true, wait: true });
    expect(replayed.body.status).toBe('succeeded');
    expect(count(e, 'charge', (a) => a.id === 'P')).toBe(2); // the operator chose to execute it again
    expect(count(e, 'charge', (a) => a.id === 'A')).toBe(1);
    expect((await g.admin(`/dlq/${dlq[0].id}`)).body.status).toBe('replayed');
  });

  it('per tool call: a crash after the commit reuses the committed result; an idempotent node is re-executed with the same key', async () => {
    const e = env();
    const tg = { durable: DURABLE, graphs: [
      { id: 'g1', nodes: [node('pay', 'charge', { args: { id: 'P1' } }), node('z', 'charge', { needs: ['pay'], args: { id: 'Z1', from: '{{nodes.pay.structuredContent.charged}}' } })] },
      { id: 'g2', nodes: [node('up', 'upsert', { idempotencyArg: 'key' })] },
    ] };
    let g = await start(e, tg);
    durableFaults.afterCommit = (p) => { if (p.node === 'pay') throw new SimulatedCrash(); };
    durableFaults.afterCall = (p) => { if (p.node === 'up') throw new SimulatedCrash(); };
    const r1 = (await g.admin('/run', { graph: 'g1', input: {} })).body.runId;
    const r2 = (await g.admin('/run', { graph: 'g2', input: {} })).body.runId;
    await until(async () => count(e, 'charge', (a) => a.id === 'P1') + count(e, 'upsert'), (n) => n === 2);
    await sleep(100);
    durableFaults.afterCall = durableFaults.afterCommit = undefined;
    await g.gw.stop();
    gws.length = 0;
    g = await start(e, tg);
    const a = await settled(g, r1, ['succeeded']);
    expect(count(e, 'charge', (x) => x.id === 'P1')).toBe(1);
    expect(a.nodes[1].output.structuredContent).toMatchObject({ charged: 'Z1' });
    expect(count(e, 'charge', (x) => x.id === 'Z1' && x.from === 'P1')).toBe(1);
    const b = await settled(g, r2, ['succeeded']);
    const ups = ledgerOf(e).filter((l) => l.tool === 'upsert');
    expect(ups).toHaveLength(2);
    expect(ups[0]!.args.key).toBe(`${r2}:up`);
    expect(ups[1]).toMatchObject({ dup: true, args: { key: `${r2}:up` } }); // same key: the upstream deduplicated it
    expect(b.status).toBe('succeeded');
  });

  it('DLQ: retry policy with backoff, inspect, auto-replay to success; exhausted entries wait for the operator; discard runs the compensations', async () => {
    const e = env();
    const tg = { durable: DURABLE, graphs: [
      { id: 'flaky', nodes: [node('f', 'flaky', { args: { failures: 3 } })] },
      { id: 'doomed', nodes: [node('a', 'charge', { args: { id: 'A' }, compensate: { tool: 'ledger/refund', args: { id: '{{self.structuredContent.charged}}' } } }), node('b', 'fail', { needs: ['a'] })] },
    ] };
    const g = await start(e, tg);
    const f = (await g.admin('/run', { graph: 'flaky', input: {} })).body.runId;
    const ok = await settled(g, f, ['succeeded']);
    expect(count(e, 'flaky')).toBe(4); // 1 + 3 DLQ retries
    const [entry] = (await g.admin(`/dlq?runId=${f}`)).body.entries;
    expect(entry).toMatchObject({ status: 'replayed', retries: 3, node: 'f' });
    const delays = entry.history.filter((h: { action: string }) => h.action === 'scheduled').map((h: { delayMs: number }) => h.delayMs);
    expect(delays).toEqual([50, 100, 200]);
    expect(ok.status).toBe('succeeded');

    const d = (await g.admin('/run', { graph: 'doomed', input: {} })).body.runId;
    const parked = await until(() => g.admin(`/dlq?runId=${d}`).then((r) => r.body.entries[0]), (x) => x?.status === 'exhausted');
    expect(count(e, 'fail')).toBe(4);
    expect(count(e, 'refund')).toBe(0); // compensation waits until the operator gives up
    expect((await runOf(g, d)).status).toBe('dead_letter');
    expect((await g.admin(`/dlq/${parked.id}`)).body).toMatchObject({ error: expect.stringMatching(/upstream refused/), retryable: true });
    const disc = await g.admin(`/dlq/${parked.id}/discard`, { wait: true });
    expect(disc.body).toMatchObject({ status: 'discarded', run: { status: 'compensated' } });
    expect(count(e, 'refund', (x) => x.id === 'A')).toBe(1);
    expect((await g.admin('/dlq?status=exhausted')).body.entries).toHaveLength(0);
    expect((await g.admin('/dlq/nope')).status).toBe(404);
  });

  it('approval resume: a run paused for approval survives a restart; requester cannot approve; approve resumes, deny compensates, both audited', async () => {
    const e = env();
    const tg = { durable: DURABLE, graphs: [{ id: 'wire', clients: true, nodes: [
      node('hold', 'charge', { args: { id: 'H' }, compensate: { tool: 'ledger/refund', args: { id: 'H' } } }),
      node('pay', 'charge', { needs: ['hold'], args: { id: '{{input.id}}' }, approval: { approvers: ['key:lead-*'], timeoutSeconds: 3600 } }),
    ] }] };
    let g = await start(e, tg);
    const r1 = (await g.client('k-alice', '/run', { graph: 'wire', input: { id: 'W1' } })).body.runId;
    const r2 = (await g.client('k-alice', '/run', { graph: 'wire', input: { id: 'W2' } })).body.runId;
    await settled(g, r1, ['awaiting_approval']);
    await settled(g, r2, ['awaiting_approval']);
    await g.gw.stop();
    gws.length = 0;
    g = await start(e, tg);
    await sleep(300);
    expect((await runOf(g, r1)).status).toBe('awaiting_approval'); // not "interrupted", not executed
    expect(count(e, 'charge', (a) => a.id === 'W1')).toBe(0);
    const inbox = (await g.client('k-lead', '/approvals')).body.approvals;
    expect(inbox.map((a: { runId: string }) => a.runId).sort()).toEqual([r1, r2].sort());
    expect((await g.client('k-alice', '/approvals')).body.approvals).toHaveLength(0);
    expect((await g.client('k-alice', `/runs/${r1}/approve`, { node: 'pay' })).status).toBe(403); // requester
    expect((await g.client('k-bob', `/runs/${r1}/approve`, { node: 'pay' })).status).toBe(403); // not an approver
    expect((await g.client('k-lead', `/runs/${r1}/approve`, { node: 'pay', reason: 'ok' })).status).toBe(200);
    const done = await settled(g, r1, ['succeeded']);
    expect(count(e, 'charge', (a) => a.id === 'W1')).toBe(1);
    expect(done.audit).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'approve', actor: 'key:lead-1', node: 'pay', reason: 'ok' })]));
    expect((await g.client('k-lead', `/runs/${r2}/deny`, { node: 'pay', reason: 'no' })).status).toBe(200);
    const denied = await settled(g, r2, ['compensated']);
    expect(count(e, 'charge', (a) => a.id === 'W2')).toBe(0);
    expect(count(e, 'refund')).toBe(1);
    expect(denied.nodes.find((n: { id: string }) => n.id === 'pay').error).toMatch(/denied by key:lead-1/);
    expect(denied.audit.map((x: { action: string }) => x.action)).toEqual(expect.arrayContaining(['deny']));
    expect((await g.admin('/dlq')).body.entries).toHaveLength(0); // a denial is final, not a DLQ entry
  });

  it('approval timeout denies; a key removed while the run waited cannot act through it (principal re-resolved per call)', async () => {
    const e = env();
    const tg = { durable: DURABLE, graphs: [{ id: 'g', clients: true, nodes: [node('pay', 'charge', { args: { id: '{{input.id}}' }, approval: { approvers: ['key:lead-*'], timeoutSeconds: 1 } })] }, { id: 'h', clients: true, nodes: [node('pay', 'charge', { args: { id: 'R' }, approval: { approvers: ['key:lead-*'] } })] }] };
    const g = await start(e, tg);
    const t = (await g.client('k-alice', '/run', { graph: 'g', input: { id: 'T' } })).body.runId;
    const timedOut = await settled(g, t, ['failed', 'compensated']);
    expect(timedOut.audit).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'timeout', actor: 'system:approval-timeout' })]));
    expect(count(e, 'charge')).toBe(0);
    const r = (await g.client('k-alice', '/run', { graph: 'h', input: {} })).body.runId;
    await settled(g, r, ['awaiting_approval']);
    const cfg = (g.gw as any).config as GatewayConfig; // eslint-disable-line @typescript-eslint/no-explicit-any
    await g.gw.reload({ ...cfg, auth: { strategy: 'api-key', apiKeys: KEYS.filter((k) => k.name !== 'alice') } } as GatewayConfig);
    await g.client('k-lead', `/runs/${r}/approve`, { node: 'pay' });
    const after = await settled(g, r, ['failed', 'dead_letter', 'compensated']);
    expect(count(e, 'charge', (a) => a.id === 'R')).toBe(0);
    expect(JSON.stringify(after.nodes[0].error)).toMatch(/denied|not allowed|forbidden|unknown/i);
  });

  it('compensations run in reverse and are idempotent: a crash mid-compensation does not repeat finished ones; an idempotent one is re-run with its key', async () => {
    const e = env();
    const tg = { durable: DURABLE, graphs: [{ id: 'saga', nodes: [
      node('a', 'charge', { args: { id: 'A' }, compensate: { tool: 'ledger/refund', args: { id: 'A' } } }),
      node('b', 'charge', { needs: ['a'], args: { id: 'B' }, compensate: { tool: 'ledger/upsert', args: { undo: 'B' }, idempotencyArg: 'key' } }),
      node('c', 'charge', { needs: ['b'], args: { id: 'C' }, compensate: { tool: 'ledger/refund', args: { id: 'C' } } }),
      node('x', 'fail', { needs: ['c'] }),
    ] }] };
    let g = await start(e, { ...tg, durable: { ...DURABLE, dlq: { enabled: false } } });
    durableFaults.afterCall = (p) => { if (p.node === 'b' && p.kind === 'compensate') throw new SimulatedCrash(); };
    const id = (await g.admin('/run', { graph: 'saga', input: {} })).body.runId;
    await until(async () => count(e, 'upsert'), (n) => n === 1);
    await sleep(100);
    durableFaults.afterCall = undefined;
    await g.gw.stop();
    gws.length = 0;
    g = await start(e, { ...tg, durable: { ...DURABLE, dlq: { enabled: false } } });
    const run = await settled(g, id, ['compensated']);
    expect(ledgerOf(e).filter((l) => l.tool === 'refund' || l.tool === 'upsert').map((l) => `${l.tool}:${l.args.id ?? l.args.undo}${l.dup ? ':dup' : ''}`)).toEqual(['refund:C', 'upsert:B', 'upsert:B:dup', 'refund:A']);
    expect(run.nodes.slice(0, 3).map((n: { status: string }) => n.status)).toEqual(['compensated', 'compensated', 'compensated']);
  });

  it('tenant isolation: client runs are visible / cancellable / approvable only within their owner; operators see all; DLQ is operator-only', async () => {
    const e = env();
    const tg = { durable: DURABLE, graphs: [{ id: 'pub', clients: true, nodes: [node('s', 'slow', { args: { ms: 800 } })] }, { id: 'internal', nodes: [node('a', 'charge')] }] };
    const g = await start(e, tg);
    expect((await g.client('k-alice', '/run', { graph: 'internal', input: {} })).status).toBe(404);
    expect((await g.client('k-alice', '')).body.graphs.map((x: { id: string }) => x.id)).toEqual(['pub']);
    const a = (await g.client('k-alice', '/run', { graph: 'pub', input: {} }, { 'idempotency-key': 'same' })).body.runId;
    const b = (await g.client('k-bob', '/run', { graph: 'pub', input: {} }, { 'idempotency-key': 'same' })).body.runId;
    expect(a).not.toBe(b);
    expect((await g.client('k-bob', `/runs/${a}`)).status).toBe(404);
    expect((await g.client('k-bob', `/runs/${a}/cancel`, {})).status).toBe(404);
    expect((await g.client('k-bob', '/runs')).body.runs.map((r: { id: string }) => r.id)).toEqual([b]);
    const mine = (await g.client('k-alice', `/runs/${a}`)).body;
    expect(mine.owner).toEqual({ clientId: 'key:alice', tenants: ['acme'] });
    expect(mine.principal).toBeUndefined(); // the stored principal is not echoed to clients
    const carol = (await g.client('k-carol', '/run', { graph: 'pub', input: {}, wait: true })).body;
    expect(carol.owner).toEqual({ clientId: 'key:carol', tenants: ['acme', 'labs'] }); // every membership, not the first
    expect((await g.req('admin/task-graphs/dlq', undefined, 'k-alice')).status).toBe(403);
    const all = (await g.admin('/runs')).body.runs.map((r: { id: string }) => r.id);
    expect(all).toEqual(expect.arrayContaining([a, b, carol.id]));
    expect((await g.admin('/runs?tenant=labs')).body.runs.map((r: { id: string }) => r.id).sort()).toEqual([b, carol.id].sort());
    expect((await g.admin(`/runs?client=key:alice`)).body.runs.map((r: { id: string }) => r.id)).toEqual([a]);
  });

  it('metrics, checkpoint file permissions (dir backend) and the tasks CLI', async () => {
    const e = env();
    const tg = { dir: join(e.dir, 'tg'), durable: { ...DURABLE, backend: 'dir', dlq: { retry: { attempts: 1, backoffMs: 10 } } }, graphs: [{ id: 'bad', nodes: [node('f', 'fail')] }, { id: 'good', nodes: [node('a', 'charge')] }] };
    const g = await start(e, tg, { state: undefined, monitor: { requestLog: false, prometheus: true } } as never);
    await g.admin('/run', { graph: 'good', input: {}, wait: true }, { 'idempotency-key': 'k1' });
    await g.admin('/run', { graph: 'good', input: {}, wait: true }, { 'idempotency-key': 'k1' });
    const bad = (await g.admin('/run', { graph: 'bad', input: {} })).body.runId;
    const entry = await until(() => g.admin(`/dlq?runId=${bad}`).then((r) => r.body.entries[0]), (x) => x?.status === 'exhausted');
    expect((statSync(join(e.dir, 'tg', `${bad}.json`)).mode & 0o077)).toBe(0);
    const m = await (await fetch(`${g.base}/metrics`, { headers: { authorization: 'Bearer op' } })).text();
    expect(m).toMatch(/mcp_gateway_task_runs_total\{status="succeeded"\} 1/);
    expect(m).toMatch(/mcp_gateway_task_idempotent_hits_total\{kind="run"\} 1/);
    expect(m).toMatch(/mcp_gateway_task_dlq_entries\{status="exhausted"\} 1/);
    expect(m).toMatch(/mcp_gateway_task_dlq_retries_total 1/);
    expect(m).toContain('mcp_gateway_task_awaiting_approval');
    const require = createRequire(import.meta.url);
    const TSX = join(require.resolve('tsx/package.json'), '..', 'dist', 'cli.mjs');
    const CLI = resolve(__dirname, '..', 'src', 'cli.ts');
    const cli = (args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((res) => {
      const p = spawn(process.execPath, [TSX, CLI, ...args, '--url', g.base, '--key', 'op'], { env: { ...process.env, MCP_GATEWAY_PORT: '', MCP_GATEWAY_API_KEYS: '' } });
      let out = '';
      let err = '';
      p.stdout.on('data', (c) => (out += c));
      p.stderr.on('data', (c) => (err += c));
      p.on('close', (code) => res({ code, out, err }));
    });
    const list = await cli(['tasks', 'dlq', 'list', '--json']);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.out).entries[0].id).toBe(entry.id);
    const show = await cli(['tasks', 'dlq', 'show', entry.id]);
    expect(show.out).toContain('upstream refused');
    const disc = await cli(['tasks', 'dlq', 'discard', entry.id]);
    expect(disc.code).toBe(0);
    expect((await g.admin(`/dlq/${entry.id}`)).body.status).toBe('discarded');
    const runs = await cli(['tasks', 'runs', '--json']);
    expect(JSON.parse(runs.out).runs.length).toBe(2);
  }, 60_000);
});
