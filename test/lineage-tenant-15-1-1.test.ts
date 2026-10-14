/**
 * 15.1.0-canary.1: tenant-scoped lineage / trace viewers, the cost rollup `GET /api/v1/admin/ops/costs`, call lineage
 * over `/mcp`, and the dashboard lineage view.
 *
 * - `controlPlane.console.tenantViewers: true` (new, optional, default false) lets tenant members (role owner / admin /
 *   viewer) read the traces, lineage and cost rollup of their own tenants — and nothing else on the console.
 * - `GET /admin/ops/costs?by=tenant|client|tool|day&since=<ISO>` sums the cost ledger; tenant viewers see only calls
 *   charged to their tenants.
 * Additive only: without the new key nothing changes for tenant members (403), operators and console viewers keep
 * their full view, and no frozen route, field or schema key changes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { startFeatureGw, fakeServer, type FeatureGw } from './helpers/feature-gw.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const K = { ops: 'k-ops-SECRET-1', alice: 'k-alice-SECRET-2', vic: 'k-vic-SECRET-3', bob: 'k-bob-SECRET-4', dual: 'k-dual-SECRET-5', nobody: 'k-nobody-SECRET-6', oncall: 'k-oncall-SECRET-7' } as const;
type P = keyof typeof K;
const hdr = (p: P, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${K[p]}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra });

async function start(console: Record<string, unknown> = { tenantViewers: true }, extra: Record<string, unknown> = {}) {
  h = await startFeatureGw({
    servers: [fakeServer('acme-db'), fakeServer('labs-db')],
    auth: { strategy: 'api-key', apiKeys: Object.entries(K).map(([name, key]) => (name === 'ops' ? { key, name } : { key, name, servers: name === 'oncall' || name === 'nobody' ? ['acme-db', 'labs-db'] : ['acme-db', 'labs-db'] })) },
    tenants: [
      { id: 'acme', servers: ['acme-*'], members: [{ client: 'key:alice', role: 'admin' }, { client: 'key:vic', role: 'viewer' }, { client: 'key:dual', role: 'admin' }] },
      { id: 'labs', servers: ['labs-*'], members: [{ client: 'key:bob', role: 'admin' }, { client: 'key:dual', role: 'owner' }] },
    ],
    costs: { currency: 'EUR', tools: [{ match: 'acme-db/*', perCall: 0.5 }, { match: 'labs-db/*', perCall: 2 }] },
    controlPlane: { console: { viewers: ['key:oncall'], ...console } },
    ...extra,
  } as never);
  return h;
}
const get = async (path: string, p: P = 'ops') => {
  const r = await fetch(`${h!.base}/api/v1/admin/ops/${path}`, { headers: hdr(p) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};
const call = async (p: P, server: string, tool = 'echo', extra: Record<string, string> = {}) => {
  const r = await fetch(`${h!.base}/api/v1/tools/call`, { method: 'POST', headers: hdr(p, extra), body: JSON.stringify({ server, tool, arguments: { text: 'hi' } }) });
  return { status: r.status, body: (await r.json()) as any };
};
const noSecrets = (v: unknown) => {
  const s = JSON.stringify(v);
  for (const k of Object.values(K)) expect(s).not.toContain(k);
};
const tenantsOf = (list: Array<{ tenant?: string | null }>) => [...new Set(list.map((t) => t.tenant ?? null))].sort();

describe('tenant-scoped console viewers (15.1.0-canary.1)', () => {
  it('TV1 a tenant member sees only the traces and lineage of its own tenants', async () => {
    await start();
    const a = await call('alice', 'acme-db', 'echo', { 'x-request-id': 'edit-1' });
    const b = await call('bob', 'labs-db', 'echo', { 'x-request-id': 'edit-1' });
    const d = await call('dual', 'labs-db');
    expect([a.status, b.status, d.status]).toEqual([200, 200, 200]);
    // alice (acme admin): acme only
    const ta = await get('traces', 'alice');
    expect(ta.status).toBe(200);
    expect(ta.body.traces.map((t: any) => t.requestId)).toEqual([a.body.requestId]);
    expect(tenantsOf(ta.body.traces)).toEqual(['acme']);
    // vic (acme viewer role) reads the same tenant
    expect((await get('traces', 'vic')).body.traces.map((t: any) => t.requestId)).toEqual([a.body.requestId]);
    // bob (labs admin): labs only — his and dual's labs call
    expect((await get('traces', 'bob')).body.traces.map((t: any) => t.requestId).sort()).toEqual([b.body.requestId, d.body.requestId].sort());
    // dual (admin of acme, owner of labs): both
    expect((await get('traces', 'dual')).body.total).toBe(3);
    // single trace and lineage: another tenant's call is "not found", never "forbidden" (no existence oracle)
    expect((await get(`traces/${encodeURIComponent(a.body.requestId)}`, 'alice')).status).toBe(200);
    expect((await get(`traces/${encodeURIComponent(b.body.requestId)}`, 'alice')).status).toBe(404);
    expect((await get(`lineage/${encodeURIComponent(b.body.requestId)}`, 'alice')).status).toBe(404);
    const la = await get(`lineage/${encodeURIComponent(a.body.requestId)}`, 'alice');
    expect(la.status).toBe(200);
    expect(la.body).toMatchObject({ requestId: a.body.requestId, tenant: 'acme', cost: 0.5, correlationId: 'edit-1' });
    // the same correlation id in two tenants: each sees its own call only
    expect((await get('lineage?correlationId=edit-1', 'alice')).body.lineage.map((l: any) => l.requestId)).toEqual([a.body.requestId]);
    expect((await get('lineage?correlationId=edit-1', 'bob')).body.lineage.map((l: any) => l.requestId)).toEqual([b.body.requestId]);
    expect((await get('lineage?correlationId=edit-1')).body.total).toBe(2); // operator: all
    noSecrets([ta.body, la.body]);
  });

  it('TV2 a tenant member reads nothing else on the console; a non-member and a call without a tenant stay hidden', async () => {
    await start();
    await call('ops', 'acme-db'); // operator call: no tenant
    const n = await call('nobody', 'acme-db'); // non-member call
    for (const path of ['cluster', 'timeline', 'reports/x']) expect((await get(path, 'alice')).status).toBe(403);
    for (const path of ['explain', 'troubleshoot']) {
      const r = await fetch(`${h!.base}/api/v1/admin/ops/${path}`, { method: 'POST', headers: hdr('alice'), body: JSON.stringify({ client: 'key:alice', server: 'acme-db', tool: 'echo' }) });
      expect(r.status).toBe(403);
    }
    // a client that is no tenant member gets no console at all
    for (const path of ['traces', 'lineage?correlationId=x', 'costs']) expect((await get(path, 'nobody')).status).toBe(403);
    // tenant viewers never see calls without a tenant
    expect((await get('traces', 'alice')).body.total).toBe(0);
    if (n.status === 200) expect((await get(`lineage/${encodeURIComponent(n.body.requestId)}`, 'alice')).status).toBe(404);
  });

  it('TV3 without controlPlane.console.tenantViewers nothing changes: tenant members get 403, operators and viewers see all', async () => {
    await start({});
    const a = await call('alice', 'acme-db');
    await call('bob', 'labs-db');
    for (const path of ['traces', `traces/${encodeURIComponent(a.body.requestId)}`, `lineage/${encodeURIComponent(a.body.requestId)}`, 'lineage?correlationId=x', 'costs']) {
      expect((await get(path, 'alice')).status).toBe(403);
      expect((await get(path, 'vic')).status).toBe(403);
    }
    expect((await get('traces')).body.total).toBe(2);
    expect((await get('traces', 'oncall')).body.total).toBe(2);
    // and with tenantViewers on, operators and console viewers keep the full view
    await h!.stop();
    await start();
    await call('alice', 'acme-db');
    await call('bob', 'labs-db');
    expect((await get('traces')).body.total).toBe(2);
    expect((await get('traces', 'oncall')).body.total).toBe(2);
  });

  it('TV4 the key is validated: a non-boolean tenantViewers disables the console (an invalid section never widens access)', async () => {
    await start({ tenantViewers: 'yes' });
    await call('alice', 'acme-db');
    expect((await get('traces', 'alice')).status).toBe(404);
  });
});

describe('cost rollup GET /admin/ops/costs (15.1.0-canary.1)', () => {
  it('C1 operators: totals by tenant, client, tool and day, with currency and since', async () => {
    await start();
    await call('alice', 'acme-db', 'echo');
    await call('alice', 'acme-db', 'add');
    await call('bob', 'labs-db', 'echo');
    await call('dual', 'acme-db', 'echo');
    const t = await get('costs?by=tenant');
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ currency: 'EUR', by: 'tenant', since: null });
    const row = (rows: any[], key: string) => rows.find((r) => r.key === key);
    expect(row(t.body.totals, 'acme')).toMatchObject({ cost: 1.5, calls: 3 });
    expect(row(t.body.totals, 'labs')).toMatchObject({ cost: 2, calls: 1 });
    expect(t.body.total).toMatchObject({ cost: 3.5, calls: 4 });
    const c = await get('costs?by=client');
    expect(row(c.body.totals, 'key:alice')).toMatchObject({ cost: 1, calls: 2 });
    expect(row(c.body.totals, 'key:bob')).toMatchObject({ cost: 2, calls: 1 });
    const tool = await get('costs?by=tool');
    expect(row(tool.body.totals, 'acme-db/echo')).toMatchObject({ cost: 1, calls: 2 });
    const day = await get('costs?by=day');
    expect(day.body.totals).toHaveLength(1);
    expect(day.body.totals[0]).toMatchObject({ key: new Date().toISOString().slice(0, 10), cost: 3.5, calls: 4 });
    // default dimension: tenant
    expect((await get('costs')).body.by).toBe('tenant');
    // since: a future instant → nothing; a past one → everything
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect((await get(`costs?by=tenant&since=${encodeURIComponent(future)}`)).body).toMatchObject({ totals: [], total: { cost: 0, calls: 0 }, since: future });
    expect((await get(`costs?since=${encodeURIComponent('2020-01-01')}`)).body.total.calls).toBe(4);
    // console viewers read it too
    expect((await get('costs?by=tenant', 'oncall')).status).toBe(200);
  });

  it('C2 bad input is refused; prototype keys are plain keys', async () => {
    await start();
    expect((await get('costs?by=model')).status).toBe(400);
    expect((await get('costs?by=__proto__')).status).toBe(400);
    expect((await get('costs?since=yesterday')).status).toBe(400);
    expect((await get('costs?since=')).status).toBe(400);
  });

  it('C3 tenant viewers see only the cost of calls charged to their tenants', async () => {
    await start();
    await call('alice', 'acme-db');
    await call('bob', 'labs-db');
    await call('dual', 'labs-db');
    await call('ops', 'acme-db'); // no tenant
    const a = await get('costs?by=tenant', 'alice');
    expect(a.status).toBe(200);
    expect(a.body.totals.map((r: any) => r.key)).toEqual(['acme']);
    expect(a.body.total).toMatchObject({ cost: 0.5, calls: 1 });
    const ac = await get('costs?by=client', 'alice');
    expect(ac.body.totals.map((r: any) => r.key)).toEqual(['key:alice']);
    const bc = await get('costs?by=client', 'bob');
    expect(bc.body.totals.map((r: any) => r.key).sort()).toEqual(['key:bob', 'key:dual']);
    const dt = await get('costs?by=tenant', 'dual');
    expect(dt.body.totals.map((r: any) => r.key).sort()).toEqual(['acme', 'labs']);
    // operator: the call without a tenant is "(none)"
    const o = await get('costs?by=tenant');
    expect(o.body.totals.map((r: any) => r.key).sort()).toEqual(['(none)', 'acme', 'labs']);
    noSecrets([a.body, ac.body, bc.body, o.body]);
  });

  it('C4 the 4.3 GET /api/v1/costs is unchanged (operators only, same shape)', async () => {
    await start();
    await call('alice', 'acme-db');
    const r = await fetch(`${h!.base}/api/v1/costs?by=tenant`, { headers: hdr('ops') });
    expect(r.status).toBe(200);
    const b = (await r.json()) as any;
    expect(Object.keys(b).sort()).toEqual(['alerts', 'budgets', 'by', 'currency', 'period', 'totals']);
    expect((await fetch(`${h!.base}/api/v1/costs`, { headers: hdr('alice') })).status).toBe(403);
  });
});

describe('lineage over /mcp (15.1.0-canary.1)', () => {
  it('M1 an MCP tools/call with X-Request-Id is found by correlation id, via mcp, with its tenant', async () => {
    await start();
    const post = (body: unknown, extra: Record<string, string> = {}) => fetch(`${h!.base}/mcp`, { method: 'POST', headers: hdr('alice', extra), body: JSON.stringify(body) });
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    expect(init.status).toBe(200);
    const sid = init.headers.get('mcp-session-id')!;
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': sid });
    const tools = JSON.parse(await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': sid })).text());
    const echo = (tools.result.tools as Array<{ name: string }>).map((t) => t.name).find((n) => /echo/.test(n) && /acme/.test(n)) ?? (tools.result.tools as Array<{ name: string }>).map((t) => t.name).find((n) => /echo/.test(n));
    expect(echo).toBeTruthy();
    const res = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: echo, arguments: { text: 'hi' } } }, { 'mcp-session-id': sid, 'x-request-id': 'motionary-mcp-9' });
    expect(res.status).toBe(200);
    const l = await get('lineage?correlationId=motionary-mcp-9');
    expect(l.status).toBe(200);
    expect(l.body.total).toBe(1);
    expect(l.body.lineage[0]).toMatchObject({ correlationId: 'motionary-mcp-9', identity: { subject: 'key:alice' }, target: { tool: 'echo', via: 'mcp' }, decision: { outcome: 'ok' } });
    // the acting tenant's member reads it; the other tenant's does not
    expect((await get('lineage?correlationId=motionary-mcp-9', 'alice')).body.total).toBe(l.body.lineage[0].tenant === 'acme' ? 1 : 0);
    expect((await get('lineage?correlationId=motionary-mcp-9', 'bob')).body.total).toBe(0);
    // the generated request id of the call is the unique lineage key
    const one = await get(`lineage/${encodeURIComponent(l.body.lineage[0].requestId)}`);
    expect(one.body.requestId).toBe(l.body.lineage[0].requestId);
  });
});

describe('dashboard lineage view (15.1.0-canary.1)', () => {
  const html = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
  it('D1 Operations page: an accessible Lineage tab with a labelled lookup form, wired to /admin/ops/lineage and /admin/ops/costs', () => {
    expect(html).toMatch(/role="tab"[^>]*id="ops-tab-lineage"[^>]*aria-controls="ops-panel-lineage"/);
    expect(html).toMatch(/role="tabpanel"[^>]*id="ops-panel-lineage"[^>]*aria-labelledby="ops-tab-lineage"/);
    for (const f of ['ops-ln-id', 'ops-ln-cid', 'ops-cost-by']) expect(html).toMatch(new RegExp(`<label[^>]*for="${f}"`));
    expect(html).toContain('/admin/ops/lineage');
    expect(html).toContain('/admin/ops/costs');
    expect(html).toContain("const OPS_TABS = ['cluster', 'traces', 'lineage', 'timeline', 'troubleshoot'];");
  });
  it('D2 the demo mock answers the lineage and cost routes', () => {
    const mock = readFileSync(new URL('../dashboard/demo/mock.js', import.meta.url), 'utf8');
    expect(mock).toContain("'/admin/ops/lineage'");
    expect(mock).toContain("'/admin/ops/costs'");
  });
});
