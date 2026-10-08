/** 4.3: cost accounting per LLM call and budget alerts. */
import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { CostLedger, priceCall, usageOf, periodStart, ERR_BUDGET_EXCEEDED, type CostsConfig } from '../src/costs/index.js';
import { Gateway } from '../src/gateway/index.js';
import { validateConfig } from '../src/config/loader.js';
import { logger } from '../src/utils/logger.js';
import type { GatewayConfig } from '../src/utils/types.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
const cfg: CostsConfig = {
  currency: 'USD',
  tools: [{ match: 'search/*', perCall: 0.01 }],
  models: { 'gpt-4o': { input: 0.005, output: 0.015 }, 'claude-*': { input: 0.003, output: 0.015 } },
};
const llm = (model: string, i: number, o: number) => ({ content: [], _meta: { usage: { model, inputTokens: i, outputTokens: o } } });

describe('pricing', () => {
  it('reads usage in several shapes and prices calls', () => {
    expect(usageOf(llm('gpt-4o', 1000, 500))).toEqual({ model: 'gpt-4o', inputTokens: 1000, outputTokens: 500 });
    expect(usageOf({ _meta: { model: 'm', usage: { prompt_tokens: 10, completion_tokens: 2 } } })).toEqual({ model: 'm', inputTokens: 10, outputTokens: 2 });
    expect(usageOf({ _meta: { usage: { input_tokens: 3 } } })).toEqual({ model: undefined, inputTokens: 3, outputTokens: 0 });
    expect(usageOf({ content: [] })).toBeUndefined();
    expect(priceCall(cfg, 'search', 'web', undefined)).toBe(0.01);
    expect(priceCall(cfg, 'llm', 'chat', { model: 'gpt-4o', inputTokens: 1000, outputTokens: 500 })).toBe(0.0125);
    expect(priceCall(cfg, 'llm', 'chat', { model: 'claude-sonnet', inputTokens: 2000, outputTokens: 0 })).toBe(0.006);
    expect(priceCall(cfg, 'x', 'y', { model: 'unknown', inputTokens: 5, outputTokens: 5 })).toBe(0);
    expect(new Date(periodStart(Date.UTC(2026, 9, 8, 15), 'month')).toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('ledger and budgets', () => {
  it('totals by dimension, alerts once per threshold and blocks', async () => {
    let t = Date.UTC(2026, 9, 8, 12);
    const hooks: unknown[] = [];
    const ledger = new CostLedger(() => ({ ...cfg, budgets: [{ name: 'team', clients: ['key:a*'], perClient: true, period: 'day', limit: 0.02, alertAt: [0.5, 1], action: 'block', webhook: 'https://hooks.example/b' }] }), {
      now: () => t,
      fetch: async (_u, i) => void hooks.push(JSON.parse(i.body)),
    });
    expect(ledger.enabled).toBe(true);
    ledger.record({ clientId: 'key:alice', serverId: 'search', tool: 'web' });
    expect(ledger.recentAlerts().map((a) => a.threshold)).toEqual([0.5]);
    expect(ledger.blocked('key:alice', undefined)).toBeUndefined();
    ledger.record({ clientId: 'key:alice', serverId: 'search', tool: 'web' });
    ledger.record({ clientId: 'key:alice', serverId: 'search', tool: 'web' });
    expect(ledger.recentAlerts().map((a) => a.threshold)).toEqual([1, 0.5]);
    expect(ledger.blocked('key:alice', undefined)).toMatchObject({ budget: 'team', subject: 'key:alice', resetsAt: '2026-10-09T00:00:00.000Z' });
    expect(ledger.blocked('key:amy', undefined)).toBeUndefined();
    expect(ledger.blocked('key:bob', undefined)).toBeUndefined();
    ledger.record({ clientId: 'key:bob', serverId: 'llm', tool: 'chat', result: llm('gpt-4o', 1000, 1000) });
    expect(ledger.totals('client').map((x) => [x.key, x.cost])).toEqual([['key:alice', 0.03], ['key:bob', 0.02]]);
    expect(ledger.totals('model').find((x) => x.key === 'gpt-4o')).toMatchObject({ inputTokens: 1000, outputTokens: 1000 });
    expect(ledger.budgets()).toEqual([expect.objectContaining({ subject: 'key:alice', spent: 0.03, used: 1.5, action: 'block' })]);
    await new Promise((r) => setTimeout(r, 10));
    expect(hooks).toHaveLength(2);
    t += 86_400_000;
    expect(ledger.blocked('key:alice', undefined)).toBeUndefined();
  });

  it('validates the costs block', () => {
    expect(validateConfig({ costs: { budgets: [{ name: 'b', period: 'month', limit: 5 }] } }).costs!.budgets![0]!.limit).toBe(5);
    expect(() => validateConfig({ costs: { budgets: [{ name: 'b', period: 'week', limit: 5 }] } })).toThrow(/period/);
  });
});

describe('budgets in the gateway', () => {
  let gw: Gateway | undefined;
  afterEach(async () => {
    await gw?.stop();
    gw = undefined;
  });

  it('prices calls, blocks with -32013 and reports on /api/v1/costs', async () => {
    gw = new Gateway({
      port: 0,
      host: '127.0.0.1',
      logLevel: 'error',
      monitor: { requestLog: false },
      servers: [{ id: 'fake', name: 'fake', transport: 'stdio', command: process.execPath, args: [fixture], timeout: 5000 }],
      costs: { tools: [{ match: 'fake/*', perCall: 1 }], budgets: [{ name: 'all', period: 'month', limit: 2, action: 'block' }] },
    } as GatewayConfig);
    await gw.start();
    const url = `http://127.0.0.1:${gw.address()!.port}/api/v1`;
    const call = () => fetch(`${url}/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'echo', arguments: {} }) });
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    const blocked = await call();
    expect(blocked.status).toBeGreaterThanOrEqual(400);
    expect(await blocked.json()).toMatchObject({ code: ERR_BUDGET_EXCEEDED });
    const report = (await (await fetch(`${url}/costs?by=tool`)).json()) as { totals: Array<{ key: string; cost: number; calls: number }>; budgets: Array<{ spent: number }>; alerts: unknown[] };
    expect(report.totals).toEqual([expect.objectContaining({ key: 'fake/echo', cost: 2, calls: 2 })]);
    expect(report.budgets[0]!.spent).toBe(2);
    expect(report.alerts.length).toBe(2);
    expect((await fetch(`${url}/costs?by=nope`)).status).toBe(400);
  }, 30_000);
});
