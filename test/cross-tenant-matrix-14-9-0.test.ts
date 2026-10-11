/**
 * 14.9.0 cross-tenant matrix on a real gateway: every principal × every server × every entry surface, against one
 * oracle. Complements the property test in tenancy-14-2-0 (I-oracle, in-process) with the HTTP surfaces a client uses.
 *
 * Tenants: acme (acme-*), labs (labs-*). Principals: alice (acme admin), vic (acme viewer), bob (labs admin), dual
 * (admin in both), ops (operator, no tenant). Both servers inject a per-tenant secret (`{tenant}`).
 * Surfaces: REST tools/call, REST tool listing, MCP tools/list + tools/call, request history, durable task runs,
 * operations-console traces. Invariants: a call is executed iff the oracle allows it (the upstream ledger proves a
 * refused call never reached it), the injected secret is always the server owner's, listings show exactly the
 * visible servers, and no principal reads another principal's history, runs or traces.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Gateway } from '../src/gateway/index.js';
import { taskRuns } from '../src/features/task-graphs.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
/* eslint-disable @typescript-eslint/no-explicit-any */
const LEDGER = resolve(__dirname, 'fixtures', 'ledger-mcp-server.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PRINCIPALS = { ops: 'k-ops', alice: 'k-alice', vic: 'k-vic', bob: 'k-bob', dual: 'k-dual' } as const;
type P = keyof typeof PRINCIPALS;
const SERVERS = ['acme-db', 'labs-db'] as const;
type S = (typeof SERVERS)[number];
const OWNER: Record<S, string> = { 'acme-db': 'acme', 'labs-db': 'labs' };
const ORACLE: Record<P, { see: S[]; call: S[] }> = {
  // operators belong to no tenant: a `{tenant}` credential cannot be resolved for them, so the call fails closed
  // (-32010) instead of borrowing some tenant's secret
  ops: { see: ['acme-db', 'labs-db'], call: [] },
  alice: { see: ['acme-db'], call: ['acme-db'] },
  vic: { see: ['acme-db'], call: [] },
  bob: { see: ['labs-db'], call: ['labs-db'] },
  dual: { see: ['acme-db', 'labs-db'], call: ['acme-db', 'labs-db'] },
};

let gw: Gateway;
let base: string;
let ledger: string;
const ledgerOf = (): Array<{ tool: string; args: Record<string, any> }> => (existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const req = async (key: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const t = await r.text();
  let b: any = t;
  try { b = JSON.parse(t); } catch { /* text */ }
  return { status: r.status, body: b, headers: r.headers };
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xt-matrix-'));
  ledger = join(dir, 'ledger.jsonl');
  process.env.MGW_XT_KEY_acme = 'secret-acme';
  process.env.MGW_XT_KEY_labs = 'secret-labs';
  const inject = [{ ref: 'secret://env/MGW_XT_KEY_{tenant}', argument: 'api_key' }];
  const srv = (id: string) => ({ id, name: id, transport: 'stdio', command: process.execPath, args: [LEDGER], env: { LEDGER: ledger }, timeout: 10_000, inject });
  gw = new Gateway({
    port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: true },
    auth: { strategy: 'api-key', apiKeys: Object.entries(PRINCIPALS).map(([name, key]) => ({ name, key })) },
    secrets: { providers: [{ id: 'env', type: 'env' }] },
    servers: SERVERS.map(srv),
    tenants: [
      { id: 'acme', servers: ['acme-*'], members: [{ client: 'key:alice', role: 'admin' }, { client: 'key:vic', role: 'viewer' }, { client: 'key:dual', role: 'admin' }] },
      { id: 'labs', servers: ['labs-*'], members: [{ client: 'key:bob', role: 'admin' }, { client: 'key:dual', role: 'admin' }] },
    ],
    taskGraphs: { durable: { leaseMs: 1000, sweepIntervalMs: 100 }, graphs: SERVERS.map((s) => ({ id: `g-${s}`, clients: true, nodes: [{ id: 'a', tool: `${s}/upsert`, args: { key: `run-${s}-{{input.n}}` } }] })) },
    controlPlane: { console: { viewers: [] } },
    mcp: { toolNaming: 'prefix' }, // server__tool names, so the listing shows which server each tool is on
  } as unknown as GatewayConfig);
  await gw.start();
  base = `http://127.0.0.1:${gw.address()!.port}`;
}, 30_000);
afterAll(async () => {
  await gw?.stop();
  taskRuns.reset();
});

describe('cross-tenant matrix (14.9.0)', () => {
  it('REST tools/call: executed iff allowed; the injected secret is always the owning tenant\'s', async () => {
    for (const [p, key] of Object.entries(PRINCIPALS) as Array<[P, string]>) {
      for (const s of SERVERS) {
        const tag = `rest-${p}-${s}`;
        const r = await req(key, '/api/v1/tools/call', { server: s, tool: 'upsert', arguments: { key: tag, api_key: 'caller-smuggled' } });
        const ran = ledgerOf().filter((l) => l.args.key === tag);
        if (ORACLE[p].call.includes(s)) {
          expect(r.status, `${p} → ${s}: ${JSON.stringify(r.body)}`).toBe(200);
          expect(ran, `${p} → ${s}`).toHaveLength(1);
          expect(ran[0]!.args.api_key, `${p} → ${s}`).toBe(`secret-${OWNER[s]}`);
        } else {
          expect(r.status, `${p} → ${s}`).toBeGreaterThanOrEqual(400);
          expect(ran, `${p} → ${s} reached the upstream`).toHaveLength(0);
        }
      }
    }
  });

  it('REST listing shows exactly the visible servers', async () => {
    for (const [p, key] of Object.entries(PRINCIPALS) as Array<[P, string]>) {
      const r = await req(key, '/api/v1/tools');
      expect(r.status).toBe(200);
      const tools = (Array.isArray(r.body) ? r.body : r.body.tools) as Array<{ serverId: string }>;
      expect([...new Set(tools.map((t) => t.serverId))].sort(), p).toEqual([...ORACLE[p].see].sort());
    }
  });

  it('MCP: tools/list shows the visible servers; tools/call runs iff allowed', async () => {
    for (const [p, key] of Object.entries(PRINCIPALS) as Array<[P, string]>) {
      const init = await req(key, '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'xt', version: '1' } } });
      const sid = init.headers.get('mcp-session-id')!;
      expect(sid, p).toBeTruthy();
      const H = { 'mcp-session-id': sid };
      await req(key, '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, H);
      const listed = (await req(key, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, H)).body;
      const names: string[] = listed.result.tools.map((t: { name: string }) => t.name);
      for (const s of SERVERS) expect(names.some((n) => n.startsWith(`${s}__`)), `${p} lists ${s}`).toBe(ORACLE[p].see.includes(s));
      for (const s of SERVERS) {
        const tag = `mcp-${p}-${s}`;
        const called = (await req(key, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: `${s}__upsert`, arguments: { key: tag } } }, H)).body;
        const ran = ledgerOf().filter((l) => l.args.key === tag);
        if (ORACLE[p].call.includes(s)) {
          expect(called.error, `${p} → ${s}`).toBeUndefined();
          expect(ran).toHaveLength(1);
          expect(ran[0]!.args.api_key).toBe(`secret-${OWNER[s]}`);
        } else {
          expect(called.error ?? called.result?.isError, `${p} → ${s}`).toBeTruthy();
          expect(ran, `${p} → ${s} reached the upstream via MCP`).toHaveLength(0);
        }
      }
    }
  });

  it('request history: a tenant member sees only its own calls', async () => {
    for (const p of ['alice', 'vic', 'bob', 'dual'] as P[]) {
      const r = await req(PRINCIPALS[p], '/api/v1/requests?limit=500');
      expect(r.status, p).toBe(200);
      const rows = (r.body.requests ?? r.body.items ?? r.body.entries ?? []) as Array<{ clientId?: string }>;
      for (const row of rows) expect(row.clientId, p).toBe(`key:${p}`);
      for (const other of Object.keys(PRINCIPALS).filter((x) => x !== p)) expect(JSON.stringify(r.body).includes(`"key:${other}"`), `${p} sees key:${other}`).toBe(false);
    }
  });

  it('durable task runs are owner-scoped: another tenant (or the same tenant\'s other members) cannot read or act on them', async () => {
    const mine = await req(PRINCIPALS.alice, '/api/v1/features/task-graphs/run', { graph: 'g-acme-db', input: { n: 1 } });
    expect(mine.status, JSON.stringify(mine.body)).toBeLessThan(300);
    const id = mine.body.runId as string;
    for (let i = 0; i < 100; i++) {
      if ((await req(PRINCIPALS.alice, `/api/v1/features/task-graphs/runs/${id}`)).body.status === 'succeeded') break;
      await sleep(50);
    }
    const own = await req(PRINCIPALS.alice, `/api/v1/features/task-graphs/runs/${id}`);
    expect(own.status).toBe(200);
    expect(own.body.status).toBe('succeeded');
    expect(ledgerOf().filter((l) => l.args.key === 'run-acme-db-1')[0]!.args.api_key).toBe('secret-acme');
    for (const p of ['bob', 'vic', 'dual'] as P[]) {
      const r = await req(PRINCIPALS[p], `/api/v1/features/task-graphs/runs/${id}`);
      expect(r.status, `${p} reads alice's run`).toBeGreaterThanOrEqual(403);
      const c = await req(PRINCIPALS[p], `/api/v1/features/task-graphs/runs/${id}/cancel`, {});
      expect(c.status, `${p} cancels alice's run`).toBeGreaterThanOrEqual(403);
    }
    // a tenant member cannot start a graph on another tenant's server
    const cross = await req(PRINCIPALS.bob, '/api/v1/features/task-graphs/run', { graph: 'g-acme-db', input: { n: 2 } });
    if (cross.status < 300) {
      for (let i = 0; i < 100; i++) {
        const st = (await req(PRINCIPALS.bob, `/api/v1/features/task-graphs/runs/${cross.body.runId}`)).body.status;
        if (st && st !== 'running' && st !== 'pending') break;
        await sleep(50);
      }
    }
    expect(ledgerOf().filter((l) => l.args.key === 'run-acme-db-2')).toHaveLength(0);
  });

  it('operations console traces: tenant members are refused; the operator sees them', async () => {
    for (const p of ['alice', 'vic', 'bob', 'dual'] as P[]) expect((await req(PRINCIPALS[p], '/api/v1/admin/ops/traces')).status, p).toBe(403);
    expect((await req(PRINCIPALS.ops, '/api/v1/admin/ops/traces')).status).toBe(200);
  });
});
