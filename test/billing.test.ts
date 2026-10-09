import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BillingSchema, UsageMeter, priceFor, buildInvoice, invoiceCsv, usageMeter } from '../src/features/billing.js';
import { validateConfig } from '../src/config/loader.js';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';

let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const cfg = BillingSchema.parse({
  currency: 'EUR',
  taxPct: 20,
  priceBook: [{ match: 'llm/*', perInputToken: 0.000002, perOutputToken: 0.00001 }, { match: 'search/*', perCall: 0.004, perSecond: 0.01 }, { match: 'free/*' }],
  accounts: { acme: { name: 'ACME', discountPct: 10, taxPct: 0 }, tiny: { monthlyMinimum: 25 } },
});

describe('usage billing and invoices (6.7)', () => {
  it('meters by period / account / target and persists', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'bill-')), 'u.json');
    const m = new UsageMeter(p);
    const oct = new Date('2026-10-05T12:00:00Z');
    m.add('acme', 'llm/complete', { inputTokens: 1000, outputTokens: 200, ms: 800 }, oct);
    m.add('acme', 'llm/complete', { inputTokens: 500, outputTokens: 100, ms: 400 }, oct);
    m.add('acme', 'search/web', { ms: 250 }, new Date('2026-09-30T23:59:59Z'));
    expect(m.usage('2026-10', 'acme')).toEqual({ acme: { 'llm/complete': { calls: 2, inputTokens: 1500, outputTokens: 300, ms: 1200 } } });
    expect(Object.keys(m.usage('2026-09'))).toEqual(['acme']);
    expect(m.usage('2026-10', 'nobody')).toEqual({});
    m.flush();
    expect(new UsageMeter(p).usage('2026-10').acme!['llm/complete']!.calls).toBe(2);
    expect(priceFor(cfg, 'search/web')!.perCall).toBe(0.004);
    expect(priceFor(cfg, 'other/x')).toBeUndefined();
  });

  it('builds invoices with discount, minimum, tax and CSV', () => {
    const inv = buildInvoice(cfg, 'acme', '2026-10', {
      'llm/complete': { calls: 2, inputTokens: 1_500_000, outputTokens: 300_000, ms: 1200 },
      'search/web': { calls: 1000, inputTokens: 0, outputTokens: 0, ms: 500_000 },
      'free/ping': { calls: 9, inputTokens: 0, outputTokens: 0, ms: 9 },
      'x/unpriced': { calls: 1, inputTokens: 0, outputTokens: 0, ms: 1 },
    });
    expect(inv.lines.map((l) => [l.target, l.amount, l.rate])).toEqual([
      ['free/ping', 0, 'free'],
      ['llm/complete', 6, '0.000002/in-token + 0.00001/out-token'],
      ['search/web', 9, '0.004/call + 0.01/s'],
      ['x/unpriced', 0, 'unpriced'],
    ]);
    expect(inv).toMatchObject({ number: 'INV-202610-ACME', name: 'ACME', currency: 'EUR', subtotal: 15, discount: 1.5, minimumTopUp: 0, tax: 0, total: 13.5 });
    const tiny = buildInvoice(cfg, 'tiny', '2026-10', { 'search/web': { calls: 100, inputTokens: 0, outputTokens: 0, ms: 0 } });
    expect(tiny).toMatchObject({ subtotal: 0.4, minimumTopUp: 24.6, tax: 5, total: 30 });
    const csv = invoiceCsv(inv);
    expect(csv.split('\n')[0]).toBe('invoice,account,period,target,calls,input_tokens,output_tokens,seconds,rate,amount_eur');
    expect(csv).toContain('INV-202610-ACME,acme,2026-10,total,,,,,,13.5');
    expect(invoiceCsv(buildInvoice(cfg, 'a,b', '2026-10', {}))).toContain('"a,b"');
    expect(() => validateConfig({ servers: [], features: { billing: cfg } })).not.toThrow();
    expect(() => validateConfig({ servers: [], features: { billing: { currency: 'euro' } } })).toThrow();
  });

  it('meters gateway traffic per account and serves usage / invoices', async () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'bill-')), 'u.json');
    h = await startFeatureGw({
      auth: { strategy: 'api-key', apiKeys: ['op', { name: 'acme', key: 'acme-key' }] },
      billing: { storePath, priceBook: [{ match: 'fake/*', perCall: 0.5 }], accounts: { 'key:acme': { name: 'ACME' }, big: { monthlyMinimum: 100 } } },
    } as never);
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${h.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: 'Bearer acme-key', 'content-type': 'application/json' }, body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: { i } }) });
      expect(r.status).toBe(200);
    }
    const u = await h.admin('billing/usage?account=key:acme');
    expect(u.body.usage['key:acme']['fake/echo'].calls).toBe(3);
    const all = await h.admin('billing/invoices');
    expect(all.body.invoices.map((i: any) => `${i.account}:${i.total}`)).toEqual(['big:100', 'key:acme:1.5']);
    expect(all.body.total).toBe(101.5);
    const one = await h.admin('billing/invoices/key:acme');
    expect(one.body.lines).toEqual([expect.objectContaining({ target: 'fake/echo', calls: 3, amount: 1.5 })]);
    const csv = await fetch(`${h.base}/api/v1/admin/billing/invoices/key:acme?format=csv`, { headers: { authorization: 'Bearer op' } });
    expect(csv.headers.get('content-type')).toMatch(/text\/csv/);
    expect(await csv.text()).toContain('fake/echo,3');
    expect((await h.admin('billing/usage?period=1999-01')).body.usage).toEqual({});
    await h.stop();
    h = undefined;
    expect(existsSync(storePath)).toBe(true);
    expect(JSON.stringify(JSON.parse(readFileSync(storePath, 'utf8')))).toContain('fake/echo');
    expect(usageMeter(BillingSchema.parse({ storePath })).usage(Object.keys(JSON.parse(readFileSync(storePath, 'utf8')))[0]!)['key:acme']).toBeDefined();
  });

  it('404s without billing config', async () => {
    h = await startFeatureGw({});
    expect((await h.admin('billing/usage')).status).toBe(404);
    expect((await h.admin('billing/invoices')).status).toBe(404);
    expect((await h.admin('billing/invoices/x')).status).toBe(404);
  });
});
