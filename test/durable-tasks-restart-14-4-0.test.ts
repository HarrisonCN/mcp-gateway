// 14.4.0: kill -9 restarts. A real gateway process (tsx src/cli.ts start) with the sqlite store is SIGKILLed while a
// task run is in flight, then started again on the same config: the run resumes from its last committed step, a
// non-idempotent call that was in flight is never executed twice, and a run paused for approval survives.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';

const CLI = resolve(__dirname, '..', 'src', 'cli.ts');
const LEDGER_FIXTURE = resolve(__dirname, 'fixtures', 'ledger-mcp-server.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL');
});

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

function setup(graphs: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), 'durable-kill-'));
  const ledger = join(dir, 'ledger.jsonl');
  const config = {
    host: '127.0.0.1',
    logLevel: 'warn',
    auth: { strategy: 'api-key', apiKeys: [{ key: 'op', name: 'ops' }, { key: 'k-lead', name: 'lead-1' }, { key: 'k-alice', name: 'alice' }] },
    store: { backend: 'sqlite', sqlite: { path: join(dir, 'state.db') } },
    servers: [{ id: 'ledger', name: 'ledger', transport: 'stdio', command: process.execPath, args: [LEDGER_FIXTURE], env: { LEDGER: ledger }, timeoutMs: 30000 }],
    features: { taskGraphs: { durable: { leaseMs: 1000, sweepIntervalMs: 100 }, graphs } },
  };
  writeFileSync(join(dir, 'gw.json'), JSON.stringify(config));
  const ledgerOf = () => (existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { tool: string; args: Record<string, unknown> }) : []);
  return { dir, cfg: join(dir, 'gw.json'), ledgerOf };
}

async function boot(cfg: string, port: number) {
  // node --import tsx: one process (the tsx CLI would fork a child that survives a SIGKILL of its parent)
  const p = spawn(process.execPath, ['--import', 'tsx', CLI, 'start', '--config', cfg, '--port', String(port)], { cwd: resolve(__dirname, '..'), env: { ...process.env, MCP_GATEWAY_PORT: '', MCP_GATEWAY_API_KEYS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(p);
  let log = '';
  p.stdout!.on('data', (c) => (log += c));
  p.stderr!.on('data', (c) => (log += c));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${base}/health`)).status < 500) break;
    } catch { /* not up */ }
    if (p.exitCode !== null) throw new Error(`gateway exited ${p.exitCode}: ${log}`);
    await sleep(100);
  }
  const call = async (path: string, body?: unknown, key = 'op') => {
    const r = await fetch(`${base}/api/v1/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: (await r.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  return { p, call, log: () => log };
}

async function until<T>(f: () => Promise<T> | T, ok: (v: T) => boolean, ms = 15000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out; last ${JSON.stringify(v)}`);
    await sleep(100);
  }
}
const kill9 = async (p: ChildProcess) => {
  p.kill('SIGKILL');
  await until(() => p.exitCode !== null || p.signalCode !== null, Boolean, 5000);
};

describe('durable tasks across kill -9 (14.4.0)', () => {
  it('in-flight non-idempotent call: never executed twice; the run lands in the DLQ as outcome unknown; earlier steps are not repeated', async () => {
    const s = setup([{ id: 'g', nodes: [{ id: 'a', tool: 'ledger/charge', args: { id: 'A' } }, { id: 'h', tool: 'ledger/hang', needs: ['a'] }, { id: 'z', tool: 'ledger/charge', needs: ['h'], args: { id: 'Z' } }] }]);
    const port = await freePort();
    let gw = await boot(s.cfg, port);
    const { body } = await gw.call('admin/task-graphs/run', { graph: 'g', input: {} });
    await until(() => s.ledgerOf().filter((l) => l.tool === 'hang').length, (n) => n === 1);
    await kill9(gw.p);
    gw = await boot(s.cfg, port);
    const run = await until(() => gw.call(`admin/task-graphs/runs/${body.runId}`).then((r) => r.body), (r) => r.status === 'dead_letter');
    expect(run.nodes.map((n: { status: string }) => n.status)).toEqual(['succeeded', 'outcome_unknown', 'skipped']);
    await sleep(1500);
    const l = s.ledgerOf();
    expect(l.filter((x) => x.tool === 'hang')).toHaveLength(1);
    expect(l.filter((x) => x.tool === 'charge' && x.args.id === 'A')).toHaveLength(1);
    expect(l.filter((x) => x.args.id === 'Z')).toHaveLength(0);
    expect((await gw.call('admin/task-graphs/dlq')).body.entries[0]).toMatchObject({ runId: body.runId, node: 'h', retryable: false });
  }, 60_000);

  it('in-flight idempotent step: resumed automatically after kill -9 and finished; committed steps run once', async () => {
    const s = setup([{ id: 'g', nodes: [{ id: 'a', tool: 'ledger/charge', args: { id: 'A' } }, { id: 's', tool: 'ledger/slow', needs: ['a'], args: { ms: 3000 }, idempotent: true }, { id: 'z', tool: 'ledger/charge', needs: ['s'], args: { id: 'Z' } }] }]);
    const port = await freePort();
    let gw = await boot(s.cfg, port);
    const { body } = await gw.call('admin/task-graphs/run', { graph: 'g', input: {} });
    await until(() => s.ledgerOf().filter((l) => l.tool === 'slow').length, (n) => n === 1);
    await kill9(gw.p);
    gw = await boot(s.cfg, port);
    const run = await until(() => gw.call(`admin/task-graphs/runs/${body.runId}`).then((r) => r.body), (r) => r.status === 'succeeded', 20000);
    const l = s.ledgerOf();
    expect(l.filter((x) => x.tool === 'charge' && x.args.id === 'A')).toHaveLength(1);
    expect(l.filter((x) => x.tool === 'slow')).toHaveLength(2);
    expect(l.filter((x) => x.tool === 'charge' && x.args.id === 'Z')).toHaveLength(1);
    expect(run.audit.map((a: { action: string }) => a.action)).toContain('resume');
  }, 60_000);

  it('a run paused for approval survives kill -9 and resumes on approve', async () => {
    const s = setup([{ id: 'w', clients: true, nodes: [{ id: 'pay', tool: 'ledger/charge', args: { id: 'W' }, approval: { approvers: ['key:lead-*'] } }] }]);
    const port = await freePort();
    let gw = await boot(s.cfg, port);
    const { body } = await gw.call('features/task-graphs/run', { graph: 'w', input: {} }, 'k-alice');
    await until(() => gw.call(`admin/task-graphs/runs/${body.runId}`).then((r) => r.body.status), (st) => st === 'awaiting_approval');
    await kill9(gw.p);
    gw = await boot(s.cfg, port);
    await sleep(1500);
    expect((await gw.call(`admin/task-graphs/runs/${body.runId}`)).body.status).toBe('awaiting_approval');
    expect((await gw.call(`features/task-graphs/runs/${body.runId}/approve`, { node: 'pay' }, 'k-lead')).status).toBe(200);
    await until(() => gw.call(`admin/task-graphs/runs/${body.runId}`).then((r) => r.body.status), (st) => st === 'succeeded');
    expect(s.ledgerOf().filter((x) => x.tool === 'charge')).toHaveLength(1);
  }, 60_000);
});
