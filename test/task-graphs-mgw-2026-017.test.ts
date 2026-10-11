// MGW-2026-017 regression (14.4.0; LTS backports): task-graph runs
//  (1) kept acting with the principal (scope) captured when the run started — a key removed or re-scoped while the
//      run was in flight (or before an operator resumed it) still had its calls executed;
//  (2) wrote checkpoint files with the process umask (typically world-readable 0644) although they carry run inputs,
//      node outputs and the caller's principal.
// Self-contained (inline upstream fixture), no durable mode: the same file runs on the LTS lines.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway } from '../src/gateway/index.js';
import { taskRuns } from '../src/features/task-graphs.js';
import type { GatewayConfig } from '../src/utils/types.js';

const FIXTURE = `
const { createInterface } = require('readline');
const { appendFileSync } = require('fs');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const ok = (id, v) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(v) }] } });
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ledger', version: '1' } } });
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: ['slow', 'charge'].map((name) => ({ name, description: name, inputSchema: { type: 'object' } })) } });
  if (msg.method === 'ping') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'tools/call') {
    const name = msg.params.name, args = msg.params.arguments || {};
    appendFileSync(process.env.LEDGER, JSON.stringify({ tool: name, args }) + '\\n');
    if (name === 'slow') return void setTimeout(() => ok(msg.id, { slow: true }), Number(args.ms || 100));
    return ok(msg.id, { charged: args.id || null });
  }
  if (msg.result === undefined && msg.error === undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown' } });
});
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gws: Gateway[] = [];
afterEach(async () => {
  for (const g of gws.splice(0)) await g.stop().catch(() => undefined);
  taskRuns.reset();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mgw-017-'));
  const fixture = join(dir, 'ledger.cjs');
  writeFileSync(fixture, FIXTURE);
  const ledger = join(dir, 'ledger.jsonl');
  const charges = () => (existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.tool === 'charge').length : 0);
  return { dir, fixture, ledger, charges, checkpoints: join(dir, 'runs') };
}

const KEYS = [{ key: 'op', name: 'ops' }, { key: 'k-temp', name: 'temp' }];

async function start(s: ReturnType<typeof setup>) {
  const config = {
    port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false },
    servers: [{ id: 'ledger', name: 'ledger', transport: 'stdio', command: process.execPath, args: [s.fixture], env: { LEDGER: s.ledger }, timeout: 10_000 }],
    auth: { strategy: 'api-key', apiKeys: KEYS },
    taskGraphs: {
      dir: s.checkpoints,
      graphs: [{ id: 'pay', nodes: [{ id: 'wait', tool: 'ledger/slow', args: { ms: 700 } }, { id: 'charge', tool: 'ledger/charge', needs: ['wait'], args: { id: 'X' } }] }],
    },
  } as unknown as GatewayConfig;
  const gw = new Gateway(config);
  await gw.start();
  gws.push(gw);
  const base = `http://127.0.0.1:${gw.address()!.port}`;
  const admin = async (path: string, body?: unknown, key = 'op') => {
    const r = await fetch(`${base}/api/v1/admin/task-graphs${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json().catch(() => undefined) };
  };
  return { gw, config, admin };
}

async function settle(admin: Awaited<ReturnType<typeof start>>['admin'], id: string) {
  const t0 = Date.now();
  for (;;) {
    const r = (await admin(`/runs/${id}`)).body;
    if (r && !['running', 'compensating'].includes(r.status)) return r;
    if (Date.now() - t0 > 10_000) throw new Error(`run ${id} did not settle: ${JSON.stringify(r)}`);
    await sleep(50);
  }
}

describe('MGW-2026-017: task-graph runs act as the caller as it is now; checkpoints are owner-only', () => {
  it('a key removed while its run is in flight cannot act through the run', async () => {
    const s = setup();
    const g = await start(s);
    const r = await g.admin('/run', { graph: 'pay', input: {} }, 'k-temp');
    expect(r.status).toBeLessThan(300);
    const id = r.body.runId;
    await sleep(150); // node "wait" is running
    await g.gw.reload({ ...g.config, auth: { strategy: 'api-key', apiKeys: KEYS.filter((k) => k.name !== 'temp') } } as GatewayConfig);
    const run = await settle(g.admin, id);
    expect(s.charges()).toBe(0);
    expect(run.status).not.toBe('succeeded');
  });

  it('a run of a key that still exists completes (control)', async () => {
    const s = setup();
    const g = await start(s);
    const id = (await g.admin('/run', { graph: 'pay', input: {} }, 'k-temp')).body.runId;
    const run = await settle(g.admin, id);
    expect(run.status).toBe('succeeded');
    expect(s.charges()).toBe(1);
  });

  it.skipIf(process.platform === 'win32')('checkpoint files are 0600 in a 0700 directory', async () => {
    const s = setup();
    const g = await start(s);
    const id = (await g.admin('/run', { graph: 'pay', input: { secret: 's3cr3t' } })).body.runId;
    await settle(g.admin, id);
    const file = join(s.checkpoints, `${id}.json`);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o077).toBe(0);
    expect(statSync(s.checkpoints).mode & 0o077).toBe(0);
  });
});
