// 14.4.0: several gateways sharing one real Redis — no double execution. Idempotency keys are claimed cluster-wide,
// a live owner keeps its runs (heartbeat lease), and when an owner dies exactly one survivor takes the run over
// (fencing epoch) without re-executing the call that was in flight.
// Skipped when no `redis-server` binary is available (CI job "Multi-instance reliability (real Redis)" installs it).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Gateway } from '../src/gateway/index.js';
import { durableFaults, SimulatedCrash } from '../src/features/task-durable.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';
import { redisServerAvailable, startRealRedis, type RealRedis } from './fixtures/real-redis.js';

logger.setLevel('error');
const LEDGER_FIXTURE = resolve(__dirname, 'fixtures', 'ledger-mcp-server.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  durableFaults.heartbeat = undefined;
  for (const f of cleanup.reverse()) await Promise.resolve(f()).catch(() => undefined);
  cleanup = [];
});

async function cluster(n: number, graphs: unknown[]) {
  const r: RealRedis = await startRealRedis();
  cleanup.push(() => r.close());
  const dir = mkdtempSync(join(tmpdir(), 'durable-multi-'));
  const ledger = join(dir, 'ledger.jsonl');
  const gws: Array<{ gw: Gateway; call: (p: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any }> }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let i = 0; i < n; i++) {
    const gw = new Gateway({
      port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false },
      servers: [{ id: 'ledger', name: 'ledger', transport: 'stdio', command: process.execPath, args: [LEDGER_FIXTURE], env: { LEDGER: ledger }, timeout: 30_000 }],
      auth: { strategy: 'api-key', apiKeys: [{ key: 'op', name: 'ops' }] },
      state: { store: 'redis', redis: { url: r.url, connectTimeoutMs: 500, commandTimeoutMs: 1000, keyPrefix: 'mgw-durable:' } },
      taskGraphs: { durable: { leaseMs: 1000, sweepIntervalMs: 100 }, graphs },
    } as unknown as GatewayConfig);
    await gw.start();
    cleanup.push(() => gw.stop());
    const base = `http://127.0.0.1:${gw.address()!.port}`;
    gws.push({
      gw,
      call: async (p, body, headers = {}) => {
        const res = await fetch(`${base}/api/v1/admin/task-graphs${p}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: res.status, body: await res.json() };
      },
    });
  }
  const ledgerOf = () => (existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { tool: string; args: Record<string, unknown> }) : []);
  return { gws, ledgerOf };
}
async function until<T>(f: () => Promise<T> | T, ok: (v: T) => boolean, ms = 15000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out; last ${JSON.stringify(v)}`);
    await sleep(50);
  }
}

describe.runIf(redisServerAvailable)('durable tasks: two gateways sharing Redis (14.4.0)', () => {
  it('the same idempotency key on both gateways at once → one run, executed once, visible on both', async () => {
    const { gws, ledgerOf } = await cluster(2, [{ id: 'pay', nodes: [{ id: 'a', tool: 'ledger/charge', args: { id: '{{input.id}}' } }] }]);
    const H = { 'idempotency-key': 'cluster-1' };
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => gws[i % 2]!.call('/run', { graph: 'pay', input: { id: 'X' } }, H)));
    const ids = new Set(rs.map((r) => r.body.runId));
    expect(ids.size).toBe(1);
    const [id] = [...ids];
    await until(() => gws[1]!.call(`/runs/${id}`).then((r) => r.body.status), (s) => s === 'succeeded');
    expect((await gws[0]!.call(`/runs/${id}`)).body.status).toBe('succeeded');
    expect(ledgerOf().filter((l) => l.tool === 'charge')).toHaveLength(1);
    expect(rs.filter((r) => r.body.duplicate === true)).toHaveLength(5);
  }, 30_000);

  it('a live owner keeps its run: the other gateway never steals it while the heartbeat lease holds', async () => {
    const { gws, ledgerOf } = await cluster(2, [{ id: 'g', nodes: [{ id: 's', tool: 'ledger/slow', args: { ms: 2500 } }, { id: 'z', tool: 'ledger/charge', needs: ['s'], args: { id: 'Z' } }] }]);
    const { body } = await gws[0]!.call('/run', { graph: 'g', input: {} });
    const run = await until(() => gws[1]!.call(`/runs/${body.runId}`).then((r) => r.body), (r) => r.status === 'succeeded');
    expect(ledgerOf().filter((l) => l.tool === 'slow')).toHaveLength(1);
    expect(ledgerOf().filter((l) => l.tool === 'charge')).toHaveLength(1);
    expect(run.audit.filter((a: { action: string }) => a.action === 'takeover')).toHaveLength(0);
  }, 30_000);

  it('the owner dies mid-call: exactly one survivor takes over, the in-flight non-idempotent call is not executed again', async () => {
    const { gws, ledgerOf } = await cluster(3, [{ id: 'g', nodes: [{ id: 'a', tool: 'ledger/charge', args: { id: 'A' } }, { id: 'h', tool: 'ledger/hang', needs: ['a'] }, { id: 'z', tool: 'ledger/charge', needs: ['h'], args: { id: 'Z' } }] }]);
    const { body } = await gws[0]!.call('/run', { graph: 'g', input: {} });
    await until(() => ledgerOf().filter((l) => l.tool === 'hang').length, (n) => n === 1);
    const owner = (await gws[0]!.call(`/runs/${body.runId}`)).body.executor as string;
    expect(owner).toBeTruthy();
    durableFaults.heartbeat = (i) => { if (i.instance === owner) throw new SimulatedCrash(); }; // the owner "dies": its lease lapses
    const run = await until(() => gws[1]!.call(`/runs/${body.runId}`).then((r) => r.body), (r) => r.status === 'dead_letter');
    expect(run.executor).not.toBe(owner);
    expect(run.audit.filter((a: { action: string }) => a.action === 'takeover')).toHaveLength(1);
    await sleep(800);
    const l = ledgerOf();
    expect(l.filter((x) => x.tool === 'hang')).toHaveLength(1);
    expect(l.filter((x) => x.tool === 'charge' && x.args.id === 'A')).toHaveLength(1);
    expect(l.filter((x) => x.args.id === 'Z')).toHaveLength(0);
    expect(run.nodes.map((n: { status: string }) => n.status)).toEqual(['succeeded', 'outcome_unknown', 'skipped']);
  }, 30_000);
});
