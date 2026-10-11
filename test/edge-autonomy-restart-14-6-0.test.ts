// 14.6.0: crash during reconnect reconciliation. A real gateway process (node --import tsx src/cli.ts start) with a
// persisted, sealed edge queue is SIGKILLed while a replay is in flight, then started again on the same directory:
// the intent log (14.4 DurableKv) decides — committed replays are not sent again, an in-doubt non-idempotent replay
// goes to the review queue (never executed twice), an in-doubt idempotent replay is resent with the same key, and
// entries that were never started are replayed in order.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { Gateway } from '../src/gateway/index.js';
import * as EA from '../src/features/edge-autonomy.js';
const { edgeState } = EA;
const edgeFaults = ((EA as Record<string, unknown>).edgeFaults ?? {}) as { afterCommit?: () => void };
import { SimulatedCrash } from '../src/orchestration/durable-tasks.js';
import type { GatewayConfig } from '../src/utils/types.js';

const CLI = resolve(__dirname, '..', 'src', 'cli.ts');
const FIXTURE = resolve(__dirname, 'fixtures', 'edge-ledger-mcp-server.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const children: ChildProcess[] = [];
const gws: Gateway[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL');
  for (const g of gws.splice(0)) await g.stop().catch(() => undefined);
  edgeState.reset();
  for (const k of Object.keys(edgeFaults)) delete (edgeFaults as Record<string, unknown>)[k];
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
async function until<T>(f: () => Promise<T> | T, ok: (v: T) => boolean, ms = 15000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out; last ${JSON.stringify(v)}`);
    await sleep(100);
  }
}

const KEYS = [{ key: 'op', name: 'ops' }, { key: 'k-alice', name: 'alice' }, { key: 'k-bob', name: 'bob' }];
function setup(edgeExtra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'edge-kill-'));
  const ledger = join(dir, 'ledger.jsonl');
  const edge = {
    dir: join(dir, 'edge'),
    rules: [{ match: 'ledger/*', action: 'queue' }],
    policies: [{ match: 'ledger/hang', offline: 'allow' }, { match: 'ledger/slow', offline: 'allow', idempotent: true }, { match: 'ledger/rename', offline: 'allow', idempotent: true }],
    reconcile: { intervalMs: 3_600_000, leaseMs: 1000, idempotencyArg: 'idem' },
    ...edgeExtra,
  };
  const config = {
    host: '127.0.0.1', logLevel: 'warn',
    auth: { strategy: 'api-key', apiKeys: KEYS },
    servers: [{ id: 'ledger', name: 'ledger', transport: 'stdio', command: process.execPath, args: [FIXTURE], env: { LEDGER: ledger }, timeout: 60_000 }],
    features: { edgeAutonomy: edge },
  };
  writeFileSync(join(dir, 'gw.json'), JSON.stringify(config));
  const ledgerOf = () => (existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { tool: string; args: Record<string, unknown> }) : []);
  return { dir, cfg: join(dir, 'gw.json'), ledgerOf, config };
}

async function boot(cfg: string, port: number) {
  const p = spawn(process.execPath, ['--import', 'tsx', CLI, 'start', '--config', cfg, '--port', String(port)], { cwd: resolve(__dirname, '..'), env: { ...process.env, MCP_GATEWAY_PORT: '', MCP_GATEWAY_API_KEYS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(p);
  let log = '';
  p.stdout!.on('data', (c) => (log += c));
  p.stderr!.on('data', (c) => (log += c));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(`${base}/health`)).status < 500) break;
    } catch { /* not up */ }
    if (p.exitCode !== null) throw new Error(`gateway exited ${p.exitCode}: ${log}`);
    await sleep(100);
  }
  const req = async (path: string, body?: unknown, key = 'op') => {
    const r = await fetch(`${base}/api/v1/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: (await r.json().catch(() => undefined)) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const call = (tool: string, args: Record<string, unknown>, key = 'k-alice') => req('tools/call', { server: 'ledger', tool, arguments: args }, key);
  return { p, req, call, log: () => log };
}
const kill9 = async (p: ChildProcess) => {
  p.kill('SIGKILL');
  await until(() => p.exitCode !== null || p.signalCode !== null, Boolean, 5000);
};

describe('14.6.0 kill -9 mid-reconcile', () => {
  it('committed replays are not resent, an in-doubt non-idempotent replay goes to review, the rest replay in order exactly once', async () => {
    const s = setup();
    const port = await freePort();
    const g1 = await boot(s.cfg, port);
    await sleep(300);
    expect((await g1.req('admin/edge-autonomy/connectivity', { disconnected: true })).status).toBe(200);
    const ids: string[] = [];
    for (const [tool, args, key] of [['rename', { id: 1, name: 'first' }, 'k-alice'], ['hang', { n: 2 }, 'k-bob'], ['rename', { id: 3, name: 'third' }, 'op']] as const) {
      const r = await g1.call(tool, args as Record<string, unknown>, key);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      ids.push(r.body.result.structuredContent.outboxId);
    }
    await g1.req('admin/edge-autonomy/connectivity', { disconnected: false });
    void g1.req('admin/edge-autonomy/reconcile', {}).catch(() => undefined); // blocks on `hang`
    await until(() => s.ledgerOf().map((l) => l.tool), (t) => t.includes('hang'));
    await sleep(100);
    await kill9(g1.p);
    expect(s.ledgerOf().map((l) => l.tool)).toEqual(['rename', 'hang']);

    const g2 = await boot(s.cfg, port);
    await sleep(1200); // the dead process's reconcile lease (leaseMs 1000) lapses
    const r = await until(() => g2.req('admin/edge-autonomy/reconcile', {}), (x) => x.status === 200 && !x.body.busy);
    expect(r.body).toMatchObject({ applied: 1, review: 1 });
    const ob = (await g2.req('admin/edge-autonomy/outbox')).body.entries;
    expect(ob.find((e: { id: string }) => e.id === ids[0]).status).toBe('applied');
    expect(ob.find((e: { id: string }) => e.id === ids[1])).toMatchObject({ status: 'review', reviewReason: 'outcome-unknown' });
    expect(ob.find((e: { id: string }) => e.id === ids[2]).status).toBe('applied');
    const ledger = s.ledgerOf();
    expect(ledger.map((l) => l.tool)).toEqual(['rename', 'hang', 'rename']);
    expect(ledger.filter((l) => l.tool === 'hang')).toHaveLength(1); // never executed twice
    expect(ledger.map((l) => l.args.idem)).toEqual([ids[0], ids[1], ids[2]]);
    const rep = (await g2.req('admin/edge-autonomy/report')).body;
    expect(rep.reconcile.outcomeUnknown).toBeGreaterThanOrEqual(1);
    await kill9(g2.p);
  }, 90_000);

  it('an in-doubt idempotent replay is resent with the same idempotency key after the restart', async () => {
    const s = setup();
    const port = await freePort();
    const g1 = await boot(s.cfg, port);
    await sleep(300);
    await g1.req('admin/edge-autonomy/connectivity', { disconnected: true });
    const id = (await g1.call('slow', { ms: 20_000 })).body.result.structuredContent.outboxId;
    await g1.req('admin/edge-autonomy/connectivity', { disconnected: false });
    void g1.req('admin/edge-autonomy/reconcile', {}).catch(() => undefined);
    await until(() => s.ledgerOf().length, (n) => n === 1);
    await kill9(g1.p);

    const g2 = await boot(s.cfg, port);
    await sleep(1200);
    await g2.req('admin/edge-autonomy/connectivity', { disconnected: false });
    void g2.req('admin/edge-autonomy/reconcile', {}).catch(() => undefined);
    await until(() => s.ledgerOf().length, (n) => n === 2);
    const l = s.ledgerOf();
    expect(l.map((x) => x.args.idem)).toEqual([id, id]); // same key both times: the upstream can de-duplicate
    await kill9(g2.p);
  }, 90_000);

  it('a crash after the upstream answered but before the queue was written: the commit in the intent log prevents a second send', async () => {
    const s = setup();
    const start = async () => {
      const gw = new Gateway({ ...(s.config as object), port: 0, logLevel: 'error', monitor: { requestLog: false }, ...(s.config.features as object) } as unknown as GatewayConfig);
      await gw.start();
      gws.push(gw);
      const base = `http://127.0.0.1:${gw.address()!.port}`;
      const req = async (path: string, body?: unknown, key = 'op') => {
        const r = await fetch(`${base}/api/v1/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: r.status, body: (await r.json().catch(() => undefined)) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
      };
      await sleep(250);
      return { gw, req };
    };
    const a = await start();
    await a.req('admin/edge-autonomy/connectivity', { disconnected: true });
    const r = await a.req('tools/call', { server: 'ledger', tool: 'rename', arguments: { id: 5, name: 'once' } }, 'k-alice');
    const id = r.body.result.structuredContent.outboxId;
    await a.req('admin/edge-autonomy/connectivity', { disconnected: false });
    edgeFaults.afterCommit = () => { throw new SimulatedCrash(); };
    await a.req('admin/edge-autonomy/reconcile', {});
    delete edgeFaults.afterCommit;
    expect(s.ledgerOf()).toHaveLength(1);
    await a.gw.stop();
    edgeState.reset();
    const b = await start();
    const out = (await b.req('admin/edge-autonomy/reconcile', {})).body;
    expect(out).toMatchObject({ applied: 0, deduplicated: 1 });
    expect((await b.req('admin/edge-autonomy/outbox')).body.entries.find((e: { id: string }) => e.id === id).status).toBe('applied');
    expect(s.ledgerOf()).toHaveLength(1);
  }, 60_000);
});
