// 10.6: full-chain replay / time-travel journal and real-time (sliding-window) cost and carbon budgets.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Journal, TimeTravelSchema, configSnapshot, resetJournal } from '../src/features/time-travel.js';
import { RealtimeBudgets, RealtimeBudgetsSchema, carbonOf, realtimeBudgets } from '../src/features/realtime-budgets.js';
import { validateConfig } from '../src/config/loader.js';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';
import type { GatewayConfig } from '../src/utils/types.js';

let fx: FeatureGw | undefined;
afterEach(async () => {
  await fx?.stop();
  fx = undefined;
  resetJournal();
  realtimeBudgets.reset();
});

const call = (base: string, args: Record<string, unknown>, key = 'op') =>
  fetch(`${base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: args }) });

describe('time-travel journal (10.6)', () => {
  it('records configs only when they change, redacts secrets, truncates large payloads', () => {
    const p = TimeTravelSchema.parse({ maxEntries: 100, maxBytes: 256 });
    const j = new Journal(() => p);
    const cfg = { port: 1, servers: [], auth: { strategy: 'api-key', apiKeys: ['sk-live-abcdefghijklmnop'] } } as unknown as GatewayConfig;
    const h1 = j.noteConfig(cfg, new Date(1000));
    expect(j.noteConfig({ ...cfg } as GatewayConfig, new Date(2000))).toBe(h1);
    expect(j.configs()).toHaveLength(1);
    expect(JSON.stringify(j.configs()[0]!.config)).not.toContain('sk-live-abcdefghijklmnop');
    j.noteConfig({ ...cfg, port: 2 } as GatewayConfig, new Date(3000));
    expect(j.configs()).toHaveLength(2);
    expect(j.configAt(2500)!.hash).toBe(h1);
    expect(j.configAt(500)).toBeUndefined();
    const e = j.noteCall({ serverId: 's', tool: 't', args: { password: 'hunter2', big: 'x'.repeat(10) }, success: true, result: { text: 'y'.repeat(1000) } });
    expect(e.args).toBeDefined();
    expect(JSON.stringify(e.args)).not.toContain('hunter2');
    expect(e.result).toBeUndefined();
    expect(e.resultTruncated).toBe(true);
  });

  it('caps entries and persists / reloads daily JSONL files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tt-'));
    const p = TimeTravelSchema.parse({ dir, maxEntries: 100 });
    const j = new Journal(() => p);
    j.load();
    for (let i = 0; i < 150; i++) j.noteCall({ serverId: 's', tool: `t${i}`, success: true });
    expect(j.events).toHaveLength(100);
    expect(j.calls()[0]!.tool).toBe('t50');
    const files = readdirSync(dir);
    expect(files.every((f) => /^journal-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))).toBe(true);
    expect(readFileSync(join(dir, files[0]!), 'utf8').split('\n').filter(Boolean).length).toBe(150);
    const again = new Journal(() => p);
    again.load();
    expect(again.calls()).toHaveLength(100);
    expect(again.calls().at(-1)!.tool).toBe('t149');
  });

  it('configSnapshot ignores bookkeeping keys', () => {
    const a = configSnapshot({ port: 1, servers: [], configDir: '/a' } as unknown as GatewayConfig);
    const b = configSnapshot({ port: 1, servers: [], configDir: '/b' } as unknown as GatewayConfig);
    expect(a.hash).toBe(b.hash);
  });

  it('journals live calls; state-at, calls, chain, config-diff and replay (policy then vs now, execute + diff)', async () => {
    fx = await startFeatureGw({ timeTravel: { results: true } } as never);
    expect((await call(fx.base, { msg: 'one' })).status).toBe(200);
    expect((await call(fx.base, { msg: 'two' })).status).toBe(200);
    const mid = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 15));
    await fx.gw.reload({ ...(fx.gw as any).config, policy: { rules: [{ name: 'no-echo', effect: 'deny', tools: ['echo'] }] } } as never); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await call(fx.base, { msg: 'three' })).status).toBe(403);

    const st = await fx.admin('time-travel');
    expect(st.body).toMatchObject({ enabled: true, persisted: false, calls: 3 });
    expect(st.body.configs).toBeGreaterThanOrEqual(2);

    const at = await fx.admin(`time-travel/state?at=${encodeURIComponent(mid)}`);
    expect(at.status).toBe(200);
    expect(at.body.calls.total).toBe(2);
    expect(at.body.config.servers).toEqual(['fake']);
    expect(at.body.config.config.policy).toBeUndefined();

    const calls = await fx.admin('time-travel/calls?tool=echo');
    expect(calls.body.total).toBe(3);
    const [last, , first] = calls.body.calls;
    expect(last.success).toBe(false);
    expect(first.args).toEqual({ msg: 'one' });

    const chain = await fx.admin(`time-travel/chain/${first.id}`);
    expect(chain.body.chain).toHaveLength(3);
    expect(chain.body.chain.find((c: { current: boolean }) => c.current).id).toBe(first.id);
    expect((await fx.admin('time-travel/chain/nope')).status).toBe(404);

    const diff = await fx.admin(`time-travel/config-diff?from=${encodeURIComponent(mid)}`);
    expect(diff.body.changes.length).toBeGreaterThan(0);
    expect(JSON.stringify(diff.body.changes)).toContain('policy');

    const rp = await fx.admin('time-travel/replay', { ids: [first.id] });
    expect(rp.body).toMatchObject({ calls: 1, executed: false, policyChanged: 1 });
    expect(rp.body.results[0].policy).toEqual({ then: 'allow', now: 'deny', changed: true });

    await fx.gw.reload({ ...(fx.gw as any).config, policy: undefined } as never); // eslint-disable-line @typescript-eslint/no-explicit-any
    const ex = await fx.admin('time-travel/replay', { ids: [first.id], execute: true });
    expect(ex.body.results[0].replay).toMatchObject({ success: true, outcomeChanged: false });
    expect(Array.isArray(ex.body.results[0].replay.diff)).toBe(true);

    expect((await fx.admin('time-travel/state?at=yesterday-ish')).status).toBe(400);
    expect((await fx.admin('time-travel/replay', { ids: 'x' })).status).toBe(400);
  });

  it('admin API answers 400 when the feature is not configured (eager) / 404 (lazy, 11.0 default)', async () => {
    expect((await (fx = await startFeatureGw()).admin('time-travel')).status).toBe(404);
    await fx.stop();
    fx = await startFeatureGw({ kernel: { modules: 'eager' } } as never);
    expect((await fx.admin('time-travel')).body.enabled).toBe(false);
    expect((await fx.admin('time-travel/calls')).status).toBe(400);
  });
});

describe('real-time budgets (10.6)', () => {
  const base = { budgets: [{ name: 'b', metric: 'cost', limit: 1, windowSeconds: 60 }] };

  it('schema: downgrade needs a block, names are unique, defaults', () => {
    expect(RealtimeBudgetsSchema.parse(base).budgets[0]).toMatchObject({ per: 'client', onExceed: 'reject', warnAt: [0.8] });
    expect(() => RealtimeBudgetsSchema.parse({ budgets: [{ ...base.budgets[0], onExceed: 'downgrade' }] })).toThrow(/downgrade/);
    expect(() => RealtimeBudgetsSchema.parse({ budgets: [base.budgets[0], base.budgets[0]] })).toThrow(/duplicate/);
    expect(() => validateConfig({ servers: [], features: { realtimeBudgets: { budgets: [] } } })).toThrow();
  });

  it('carbon estimate: per call, per token, per-server intensity, tool rules', () => {
    const c = RealtimeBudgetsSchema.parse(base).carbon;
    expect(carbonOf(c, 's', 't', undefined)).toBeCloseTo((0.02 / 1000) * 400, 9);
    expect(carbonOf({ ...c, servers: { 'eu-*': 100 } }, 'eu-1', 't', undefined)).toBeCloseTo((0.02 / 1000) * 100, 9);
    expect(carbonOf(c, 's', 't', { inputTokens: 1000, outputTokens: 1000 })).toBeCloseTo(((0.02 + 0.3 + 1.2) / 1000) * 400, 6);
    expect(carbonOf({ ...c, tools: [{ match: 'llm/*', perCallWh: 0.5 }] }, 'llm', 'chat', undefined)).toBeCloseTo((0.5 / 1000) * 400, 9);
  });

  it('sliding window: warns once, exceeds, expires, retryAfter points at the oldest bucket', () => {
    const hooks: string[] = [];
    const rt = new RealtimeBudgets(async (u, i) => void hooks.push(`${u} ${i.body}`));
    const cfg = RealtimeBudgetsSchema.parse({ budgets: [{ name: 'b', metric: 'cost', limit: 1, windowSeconds: 60, warnAt: [0.5], webhook: 'https://hooks.invalid/x' }] });
    const costs = { tools: [{ match: '*', perCall: 0.3 }] };
    const c = { clientId: 'key:a', serverId: 's', tool: 't' };
    const t0 = 1_000_000_000;
    rt.record(cfg, costs, c, {}, t0);
    rt.record(cfg, costs, c, {}, t0 + 1000);
    expect(rt.alerts.map((a) => a.kind)).toEqual(['warning']);
    expect(rt.check(cfg, c, t0 + 2000)).toHaveLength(0);
    rt.record(cfg, costs, c, {}, t0 + 30_000);
    rt.record(cfg, costs, c, {}, t0 + 31_000);
    expect(rt.alerts.map((a) => a.kind)).toEqual(['warning', 'exceeded']);
    const over = rt.check(cfg, c, t0 + 32_000);
    expect(over).toHaveLength(1);
    // usage drops below 1 once the first bucket (t0) leaves the 60 s window
    expect(over[0]!.retryAfterSeconds).toBeGreaterThanOrEqual(27);
    expect(over[0]!.retryAfterSeconds).toBeLessThanOrEqual(29);
    expect(rt.check(cfg, { ...c, clientId: 'key:other' }, t0 + 32_000)).toHaveLength(0);
    expect(rt.check(cfg, c, t0 + 61_500)).toHaveLength(0);
    expect(hooks).toHaveLength(2);
    expect(hooks[0]).toContain('realtime-budget.alert');
  });

  it('REST: reject maps to 429 with Retry-After; /mcp returns JSON-RPC error -32013 with data.decision "budget"', async () => {
    fx = await startFeatureGw({
      costs: { tools: [{ match: 'fake/*', perCall: 1 }] },
      realtimeBudgets: { budgets: [{ name: 'hourly', metric: 'cost', limit: 2, windowSeconds: 3600 }] },
    } as never);
    expect((await call(fx.base, { msg: 1 })).status).toBe(200);
    expect((await call(fx.base, { msg: 2 })).status).toBe(200);
    const r = await call(fx.base, { msg: 3 });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(3000);
    const body = (await r.json()) as { code: number; message: string; budget: Record<string, unknown> };
    expect(body.code).toBe(-32013);
    expect(body.message).toMatch(/Real-time budget "hourly" exceeded/);
    expect(body.budget).toMatchObject({ decision: 'budget', budget: 'hourly', metric: 'cost', used: 2, limit: 2 });

    const H = { authorization: 'Bearer op', 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const init = await fetch(`${fx.base}/mcp`, { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } }) });
    const sid = init.headers.get('mcp-session-id')!;
    const rpc = async (id: number, method: string, params: unknown) => {
      const res = await fetch(`${fx!.base}/mcp`, { method: 'POST', headers: { ...H, accept: 'application/json', 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
      return JSON.parse(await res.text());
    };
    const tools = await rpc(2, 'tools/list', {});
    const name = tools.result.tools.map((t: { name: string }) => t.name).find((n: string) => n.endsWith('echo'));
    const m = await rpc(3, 'tools/call', { name, arguments: { msg: 4 } });
    expect(m.error).toMatchObject({ code: -32013, data: { decision: 'budget', budget: 'hourly' } });

    const st = await fx.admin('realtime-budgets');
    expect(st.body.budgets[0]).toMatchObject({ name: 'hourly', rejected: 2 });
    expect(st.body.usage[0]).toMatchObject({ subject: expect.any(String), used: 2, limit: 2, fraction: 1 });
    expect((await fx.admin('realtime-budgets/alerts')).body.alerts[0]).toMatchObject({ kind: 'exceeded' });
    const est = await fx.admin('realtime-budgets/estimate', { server: 'fake', tool: 'echo', usage: { inputTokens: 10, outputTokens: 10 } });
    expect(est.body).toMatchObject({ cost: 1, unit: { carbon: 'gCO2e (estimate)' } });
    expect((await fx.admin('realtime-budgets/reset', {})).body.reset).toBe(true);
    expect((await call(fx.base, { msg: 5 })).status).toBe(200);
  });

  it('calendar budgets (costs.budgets, action: block) now answer REST 429 too', async () => {
    fx = await startFeatureGw({ costs: { tools: [{ match: 'fake/*', perCall: 1 }], budgets: [{ name: 'day', period: 'day', limit: 1, action: 'block' }] } } as never);
    expect((await call(fx.base, {})).status).toBe(200);
    const r = await call(fx.base, {});
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(((await r.json()) as { budget: { decision: string } }).budget.decision).toBe('budget');
  });

  it('downgrade overrides arguments (and server) instead of refusing; warn never blocks', async () => {
    fx = await startFeatureGw({
      costs: { tools: [{ match: 'fake/*', perCall: 1 }] },
      realtimeBudgets: {
        budgets: [
          { name: 'down', metric: 'cost', limit: 1, onExceed: 'downgrade', downgrade: { args: { model: 'small' } } },
          { name: 'w', metric: 'carbon', limit: 0.000001, onExceed: 'warn' },
        ],
      },
    } as never);
    expect((await call(fx.base, { msg: 'a', model: 'big' })).status).toBe(200);
    const r = await call(fx.base, { msg: 'b', model: 'big' });
    expect(r.status).toBe(200);
    expect(JSON.stringify(await r.json())).toContain('small');
    const st = await fx.admin('realtime-budgets');
    expect(st.body.budgets.find((b: { name: string }) => b.name === 'down').downgraded).toBe(1);
  });
});
