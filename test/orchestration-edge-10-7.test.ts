// 10.7: multi-agent orchestration 2.0 (durable task graphs) and edge autonomy (EXPERIMENTAL).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TaskGraphsSchema, executeRun, newRun, backoff, TaskRunStore, taskRuns, type TaskExecutor, type GraphCfg } from '../src/features/task-graphs.js';
import { EdgeAutonomySchema, edgeState } from '../src/features/edge-autonomy.js';
import { federationState } from '../src/features/a2a-federation.js';
import { edgeRuntimeState } from '../src/features/edge-runtime.js';
import { validateConfig } from '../src/config/loader.js';
import { experimentalFeatureWarnings } from '../src/security/posture.js';
import { Gateway } from '../src/gateway/index.js';
import { startFeatureGw, fakeServer, type FeatureGw } from './helpers/feature-gw.js';
import { respondWasm } from './fixtures/wasm-plugins.js';
import type { GatewayConfig, ProxyResponse } from '../src/utils/types.js';

let fx: FeatureGw | undefined;
let remote: Gateway | undefined;
afterEach(async () => {
  await fx?.stop();
  await remote?.stop();
  fx = undefined;
  remote = undefined;
  taskRuns.reset();
  edgeState.reset();
  federationState.reset();
  await edgeRuntimeState.reset();
});

const ok = (v: unknown): ProxyResponse => ({ success: true, durationMs: 1, result: { content: [{ type: 'text', text: JSON.stringify(v) }], structuredContent: v } });
const fail = (m: string): ProxyResponse => ({ success: false, durationMs: 1, error: { code: -32603, message: m } });
const graph = (g: unknown): GraphCfg => TaskGraphsSchema.parse({ graphs: [g] }).graphs[0]!;

describe('task graphs (10.7)', () => {
  it('schema: exactly one of tool / remote, unknown needs, cycles, duplicate ids', () => {
    expect(() => graph({ id: 'g', nodes: [{ id: 'a' }] })).toThrow(/exactly one/);
    expect(() => graph({ id: 'g', nodes: [{ id: 'a', tool: 's/t', remote: { gateway: 'x', skill: 'y' } }] })).toThrow(/exactly one/);
    expect(() => graph({ id: 'g', nodes: [{ id: 'a', tool: 's/t', needs: ['b'] }] })).toThrow(/unknown node b/);
    expect(() => graph({ id: 'g', nodes: [{ id: 'a', tool: 's/t', needs: ['b'] }, { id: 'b', tool: 's/t', needs: ['a'] }] })).toThrow(/cycle/);
    expect(() => TaskGraphsSchema.parse({ graphs: [{ id: 'g', nodes: [{ id: 'a', tool: 's/t' }] }, { id: 'g', nodes: [{ id: 'a', tool: 's/t' }] }] })).toThrow(/duplicate task graph/);
    expect(validateConfig({ version: 11, servers: [], features: { taskGraphs: { graphs: [{ id: 'g', nodes: [{ id: 'a', tool: 's/t' }] }] } } }).taskGraphs).toBeDefined();
  });

  it('backoff: exponential, capped, full jitter', () => {
    const r = { attempts: 5, backoffMs: 100, factor: 3, maxBackoffMs: 500, jitter: false };
    expect([1, 2, 3].map((a) => backoff(r, a))).toEqual([100, 300, 500]);
    expect(backoff({ ...r, jitter: true }, 2, () => 0.5)).toBe(150);
  });

  it('runs a DAG with templates, retries with backoff, routes remote nodes, checkpoints every change', async () => {
    const g = graph({
      id: 'g',
      nodes: [
        { id: 'a', tool: 'crm/create', args: { name: '{{input.name}}' } },
        { id: 'b', remote: { gateway: 'eu', skill: 'kyc' }, args: { who: '{{nodes.a.structuredContent.id}}' }, retry: { attempts: 3, backoffMs: 10 } },
        { id: 'c', tool: 'mail/send', needs: ['a', 'b'], args: { text: 'id {{nodes.a.structuredContent.id}} {{nodes.b.structuredContent.ok}} run {{run.id}}' } },
      ],
      output: '{{nodes.c.structuredContent}}',
    });
    let remoteCalls = 0;
    const seen: unknown[] = [];
    const exec: TaskExecutor = {
      tool: async (s, t, a) => (seen.push([s, t, a]), ok(t === 'create' ? { id: 'acc-1' } : { sent: a.text })),
      remote: async (gw, skill, a) => (++remoteCalls < 3 ? fail('busy') : ok({ ok: true, gw, skill, a })),
    };
    const sleeps: number[] = [];
    const checkpoints: string[] = [];
    const run = newRun(g, { name: 'Ada' }, 'key:op');
    await executeRun(run, exec, { sleep: async (ms) => void sleeps.push(ms), checkpoint: (r) => checkpoints.push(r.status) });
    expect(run.status).toBe('succeeded');
    expect(run.nodes.find((n) => n.id === 'b')!.attempts).toBe(3);
    expect(sleeps).toEqual([10, 20]);
    expect(seen[0]).toEqual(['crm', 'create', { name: 'Ada' }]);
    expect(run.output).toEqual({ sent: `id acc-1 true run ${run.id}` });
    expect(run.completed).toEqual(['a', 'b', 'c']);
    expect(checkpoints.length).toBeGreaterThan(6);
  });

  it('a failure compensates succeeded nodes in reverse order with their own output; resume re-runs from the checkpoint', async () => {
    const g = graph({
      id: 'saga',
      concurrency: 1,
      nodes: [
        { id: 'reserve', tool: 'inv/reserve', compensate: { tool: 'inv/release', args: { id: '{{self.structuredContent.id}}' } } },
        { id: 'charge', tool: 'pay/charge', needs: ['reserve'], compensate: { tool: 'pay/refund', args: { id: '{{self.structuredContent.id}}' } } },
        { id: 'ship', tool: 'ship/create', needs: ['charge'] },
        { id: 'notify', tool: 'mail/send', needs: ['ship'] },
      ],
    });
    const calls: string[] = [];
    let shipDown = true;
    const exec: TaskExecutor = {
      tool: async (s, t, a) => {
        calls.push(`${s}/${t}${a.id ? `:${a.id}` : ''}`);
        if (t === 'create' && shipDown) return fail('carrier down');
        return ok({ id: `${t}-1` });
      },
      remote: async () => fail('no'),
    };
    const run = newRun(g, {});
    await executeRun(run, exec, { sleep: async () => undefined });
    expect(run.status).toBe('compensated');
    expect(run.error).toMatch(/node ship: carrier down/);
    expect(calls).toEqual(['inv/reserve', 'pay/charge', 'ship/create', 'pay/refund:charge-1', 'inv/release:reserve-1']);
    expect(run.nodes.map((n) => n.status)).toEqual(['compensated', 'compensated', 'failed', 'skipped']);

    // a failed run without compensations resumes without repeating succeeded nodes
    const g2 = graph({ id: 'plain', concurrency: 1, nodes: [{ id: 'x', tool: 'a/x' }, { id: 'y', tool: 'ship/create', needs: ['x'] }, { id: 'z', tool: 'a/z', needs: ['y'] }] });
    calls.length = 0;
    const r2 = newRun(g2, {});
    await executeRun(r2, exec);
    expect(r2.status).toBe('failed');
    shipDown = false;
    await executeRun(r2, exec);
    expect(r2.status).toBe('succeeded');
    expect(calls).toEqual(['a/x', 'ship/create', 'ship/create', 'a/z']);
  });

  it('compensation failures are reported; per-attempt timeouts; onError: continue; cancellation', async () => {
    const g = graph({ id: 'g', concurrency: 1, nodes: [
      { id: 'a', tool: 's/a', compensate: { tool: 's/undo-fails' } },
      { id: 'slow', tool: 's/slow', needs: ['a'], timeoutMs: 20, onError: 'continue' },
      { id: 'b', tool: 's/boom', needs: ['a'] },
    ] });
    const exec: TaskExecutor = {
      tool: async (_s, t) => (t === 'slow' ? new Promise((r) => setTimeout(() => r(ok(1)), 200)) : t === 'boom' || t === 'undo-fails' ? fail(t) : ok({})),
      remote: async () => fail('no'),
    };
    const run = await executeRun(newRun(g, {}), exec);
    expect(run.status).toBe('compensation_failed');
    expect(run.nodes.find((n) => n.id === 'slow')).toMatchObject({ status: 'failed', error: expect.stringMatching(/timed out after 20 ms/) });
    expect(run.error).toMatch(/compensation failed for a: undo-fails/);

    let cancel = false;
    const g2 = graph({ id: 'c', concurrency: 1, nodes: [{ id: 'a', tool: 's/a' }, { id: 'b', tool: 's/b', needs: ['a'] }] });
    const r2 = await executeRun(newRun(g2, {}), { tool: async () => ((cancel = true), ok({})), remote: async () => fail('x') }, { cancelled: () => cancel });
    expect(r2.status).toBe('cancelled');
    expect(r2.nodes.map((n) => n.status)).toEqual(['succeeded', 'skipped']);
  });

  it('store: atomic checkpoints, in-flight runs load as interrupted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-'));
    const s = new TaskRunStore();
    const r = newRun(graph({ id: 'g', nodes: [{ id: 'a', tool: 's/t' }] }), {});
    r.nodes[0]!.status = 'running';
    s.save(r, dir);
    expect(readdirSync(dir)).toEqual([`${r.id}.json`]);
    const s2 = new TaskRunStore();
    s2.load(dir);
    expect(s2.runs.get(r.id)).toMatchObject({ status: 'interrupted', nodes: [{ status: 'pending' }] });
    expect(JSON.parse(readFileSync(join(dir, `${r.id}.json`), 'utf8')).status).toBe('interrupted');
  });

  it('end to end: admin run / runs / resume of an interrupted run, and a node on another gateway via A2A', async () => {
    remote = new Gateway({ port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false }, servers: [fakeServer('fake')], auth: { strategy: 'api-key', apiKeys: ['remote-key'] }, a2a: { enabled: true, name: 'eu-gateway' } } as GatewayConfig);
    await remote.start();
    const url = `http://127.0.0.1:${remote.address()!.port}`;
    const dir = mkdtempSync(join(tmpdir(), 'tg-e2e-'));
    // a checkpoint left behind by a gateway that stopped mid-run
    const def = graph({ id: 'pipeline', nodes: [{ id: 'local', tool: 'fake/echo', args: { step: 'local' } }, { id: 'eu', remote: { gateway: 'eu', skill: 'echo' }, needs: ['local'], args: { from: '{{nodes.local.text}}' } }] });
    const stale = newRun(def, {});
    stale.nodes[0]!.status = 'succeeded';
    stale.nodes[0]!.output = { text: 'from-before-crash' };
    stale.completed = ['local'];
    stale.nodes[1]!.status = 'running';
    writeFileSync(join(dir, `${stale.id}.json`), JSON.stringify(stale));

    fx = await startFeatureGw({
      a2aFederation: { remotes: [{ id: 'eu', url, token: 'remote-key' }] },
      taskGraphs: { dir, graphs: [def] },
    } as never);
    const list = await fx.admin('task-graphs');
    expect(list.body.graphs[0]).toMatchObject({ id: 'pipeline', remoteNodes: ['eu'] });
    const run = await fx.admin('task-graphs/run', { graph: 'pipeline', input: {}, wait: true });
    expect(run.status).toBe(200);
    expect(run.body.status).toBe('succeeded');
    expect(JSON.stringify(run.body.nodes[1].output)).toContain('completed');

    const runs = await fx.admin('task-graphs/runs?status=interrupted');
    expect(runs.body.runs.map((r: { id: string }) => r.id)).toEqual([stale.id]);
    expect((await fx.admin(`task-graphs/runs/${run.body.id}/resume`, {})).status).toBe(409);
    const resumed = await fx.admin(`task-graphs/runs/${stale.id}/resume`, { wait: true });
    expect(resumed.body).toMatchObject({ status: 'succeeded', resumes: 1 });
    // the local node was not executed again: its checkpointed output fed the remote node
    expect(JSON.stringify(resumed.body.nodes[1].output)).toContain('from-before-crash');
    expect(JSON.parse(readFileSync(join(dir, `${stale.id}.json`), 'utf8')).status).toBe('succeeded');
    expect((await fx.admin('task-graphs/run', { graph: 'nope' })).status).toBe(404);
    expect((await fx.admin('task-graphs/runs/nope')).status).toBe(404);
  });
});

describe('edge autonomy (10.7, EXPERIMENTAL)', () => {
  const call = (base: string, tool: string, args: Record<string, unknown>) =>
    fetch(`${base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json' }, body: JSON.stringify({ server: 'fake', tool, arguments: args }) });

  it('schema: wasm needs wasmTool; labelled EXPERIMENTAL in the security posture', () => {
    expect(experimentalFeatureWarnings({ edgeAutonomy: { rules: [{ match: '*', action: 'cache' }] } } as never).map((w) => w.id)).toEqual(['experimental-edge-autonomy']);
    expect(() => EdgeAutonomySchema.parse({ rules: [{ match: '*', action: 'wasm' }] })).toThrow(/wasmTool/);
    expect(EdgeAutonomySchema.parse({ rules: [{ match: '*', action: 'cache' }] }).reconcile).toMatchObject({ intervalMs: 5000, maxAttempts: 5 });
  });

  it('while disconnected: cache, WASM fallback, queue, deny; policy still applies; reconcile replays the outbox with an idempotency key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'edge-'));
    const wasm = join(dir, 'hello.wasm');
    writeFileSync(wasm, respondWasm());
    fx = await startFeatureGw({
      policy: { rules: [{ name: 'no-secret', effect: 'deny', tools: ['secret'] }] },
      timeTravel: {},
      edgeRuntime: { tools: [{ name: 'hello', wasm, export: 'on_tool_call', warm: 0 }] },
      edgeAutonomy: {
        dir,
        rules: [
          { match: 'fake/echo', action: 'cache', maxAgeSeconds: 60 },
          { match: 'fake/calc', action: 'wasm', wasmTool: 'hello' },
          { match: 'fake/update_*', action: 'queue' },
          { match: 'fake/pay', action: 'deny', message: 'payments need a connection' },
          { match: 'fake/secret', action: 'queue' },
        ],
        reconcile: { intervalMs: 3_600_000, maxAttempts: 2, idempotencyArg: 'idempotencyKey' },
      },
    } as never);
    // online: result recorded for the cache rule
    expect((await call(fx.base, 'echo', { q: 1 })).status).toBe(200);
    expect((await fx.admin('edge-autonomy/connectivity', { servers: ['fake'], disconnected: true })).body.forced).toEqual(['fake']);
    expect((await fx.admin('edge-autonomy')).body.servers[0]).toMatchObject({ id: 'fake', disconnected: 'forced by operator' });

    const cached = await call(fx.base, 'echo', { q: 1 });
    expect(cached.status).toBe(200);
    const cb = (await cached.json()) as { result: { content: Array<{ text: string }>; _meta: Record<string, { decision: string }> } };
    expect(cb.result.content[0]!.text).toBe('{"q":1}');
    expect(cb.result._meta['mcp-gateway/edge']!.decision).toBe('cache');
    expect((await call(fx.base, 'echo', { q: 2 })).status).toBe(502); // cache miss: fails as usual

    const w = await call(fx.base, 'calc', {});
    expect(w.status).toBe(200);
    expect(JSON.stringify(await w.json())).toContain('from wasm');

    const q = await call(fx.base, 'update_contact', { id: 7, name: 'Ada' });
    expect(q.status).toBe(200);
    const receipt = ((await q.json()) as { result: { structuredContent: { outboxId: string } } }).result.structuredContent.outboxId;
    expect(receipt).toMatch(/^ob-/);
    expect(JSON.parse(readFileSync(join(dir, 'outbox.json'), 'utf8'))[0]).toMatchObject({ id: receipt, status: 'queued' });

    const p = await call(fx.base, 'pay', {});
    expect(p.status).toBe(502);
    expect(((await p.json()) as { message: string }).message).toBe('payments need a connection');
    expect((await call(fx.base, 'secret', {})).status).toBe(403); // local policy decides first, nothing queued

    expect((await fx.admin('edge-autonomy/reconcile', {})).body).toMatchObject({ applied: 0, pending: 1 });
    await fx.admin('edge-autonomy/connectivity', { disconnected: false });
    expect((await fx.admin('edge-autonomy/reconcile', {})).body).toMatchObject({ applied: 1, pending: 0 });
    const ob = (await fx.admin('edge-autonomy/outbox')).body.entries;
    expect(ob).toHaveLength(1);
    expect(ob[0]).toMatchObject({ id: receipt, status: 'applied', attempts: 1 });
    // the replay reached the upstream with the idempotency key
    const journaled = (await fx.admin('time-travel/calls?tool=update_contact')).body.calls;
    expect(journaled[0]).toMatchObject({ success: true, args: { id: 7, name: 'Ada', idempotencyKey: receipt } });
    const decisions = (await fx.admin('edge-autonomy/decisions')).body.decisions.map((d: { action: string }) => d.action);
    expect(decisions).toEqual(expect.arrayContaining(['cache', 'miss', 'wasm', 'queue', 'deny']));
    expect((await fx.admin('edge-autonomy/outbox/nope', undefined, 'DELETE')).status).toBe(404);
  });

  it('reconcile parks a replay the upstream keeps rejecting as a conflict; operators can retry or drop it', async () => {
    fx = await startFeatureGw({
      edgeAutonomy: { rules: [{ match: 'fake/*', action: 'queue' }], reconcile: { intervalMs: 3_600_000, maxAttempts: 2 } },
    } as never);
    // Let the start-up reconcile pass (100 ms after activation) run first: otherwise it can land between the two manual
    // reconciles below on a slow runner (coverage) and take the second attempt itself (13.1.1 de-flake).
    await new Promise((r) => setTimeout(r, 250));
    await fx.admin('edge-autonomy/connectivity', { disconnected: true });
    expect((await call(fx.base, 'later', {})).status).toBe(200);
    await fx.admin('edge-autonomy/connectivity', { disconnected: false });
    await fx.gw.reload({ ...(fx.gw as any).config, policy: { rules: [{ name: 'x', effect: 'deny', tools: ['later'] }] } } as never); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await fx.admin('edge-autonomy/reconcile', {})).body).toMatchObject({ failed: 1 });
    expect((await fx.admin('edge-autonomy/reconcile', {})).body).toMatchObject({ conflicts: 1 });
    const [e] = (await fx.admin('edge-autonomy/outbox?status=conflict')).body.entries;
    expect(e.lastError).toMatch(/denied|policy|not allowed/i);
    expect((await fx.admin(`edge-autonomy/outbox/${e.id}/retry`, {})).body.status).toBe('queued');
    expect((await fx.admin(`edge-autonomy/outbox/${e.id}`, undefined, 'DELETE')).body.deleted).toBe(e.id);
  });
});
