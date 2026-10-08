/**
 * Usage billing and invoices (6.7): meter tool usage per tenant and turn it into invoices.
 *
 * Every successful call is metered for its account — the caller's tenant (first membership), or its client id
 * when it has none — by month (UTC) and `server/tool`, counting calls, input / output tokens (from the result's
 * `usage`, as in 6.3) and duration. A **price book** prices each meter; the first entry whose `match` glob fits
 * `server/tool` wins. Accounts can have a discount, a monthly minimum and tax.
 *
 * ```yaml
 * billing:
 *   currency: USD
 *   taxPct: 0
 *   priceBook:
 *     - { match: "llm/*", perCall: 0, perInputToken: 0.000002, perOutputToken: 0.000008 }
 *     - { match: "search/*", perCall: 0.004 }
 *     - { match: "*", perCall: 0.001 }
 *   accounts:
 *     acme: { name: "ACME Corp", discountPct: 10, monthlyMinimum: 50, taxPct: 8.25 }
 *   storePath: ./data/usage.json     # optional: persist the meter
 * ```
 *
 * - `GET /admin/billing/usage?account=&period=YYYY-MM` — metered usage.
 * - `GET /admin/billing/invoices?period=` — invoice totals for every account with usage or a minimum.
 * - `GET /admin/billing/invoices/:account?period=&format=json|csv` — one invoice with line items.
 *
 * @module features/billing
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { registerFeature } from '../gateway/features.js';
import { registerCallHook } from '../gateway/hooks.js';
import { extractUsage } from './genai-otel.js';
import { globToRegExp } from '../utils/tool-filter.js';
import type { GatewayConfig } from '../utils/types.js';

const Money = z.number().min(0);
export const BillingSchema = z
  .object({
    enabled: z.boolean().default(true),
    currency: z.string().regex(/^[A-Z]{3}$/).default('USD'),
    taxPct: z.number().min(0).max(100).default(0),
    priceBook: z.array(z.object({ match: z.string().min(1), perCall: Money.default(0), perInputToken: Money.default(0), perOutputToken: Money.default(0), perSecond: Money.default(0) }).strict()).default([]),
    accounts: z.record(z.object({ name: z.string().optional(), discountPct: z.number().min(0).max(100).default(0), monthlyMinimum: Money.default(0), taxPct: z.number().min(0).max(100).optional() }).strict()).default({}),
    storePath: z.string().optional(),
  })
  .strict();
export type BillingConfig = z.input<typeof BillingSchema>;
type Cfg = z.output<typeof BillingSchema>;
type Price = Cfg['priceBook'][number];

export interface Meter {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
}
const zero = (): Meter => ({ calls: 0, inputTokens: 0, outputTokens: 0, ms: 0 });

export const periodOf = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/** usage[period][account][server/tool] */
export class UsageMeter {
  data: Record<string, Record<string, Record<string, Meter>>> = {};
  private dirty = false;
  constructor(private readonly storePath?: string) {
    if (storePath && existsSync(storePath)) this.data = JSON.parse(readFileSync(storePath, 'utf8'));
  }
  add(account: string, target: string, m: Partial<Meter>, at = new Date()): void {
    const p = periodOf(at);
    const row = (((this.data[p] ??= {})[account] ??= {})[target] ??= zero());
    row.calls += m.calls ?? 1;
    row.inputTokens += m.inputTokens ?? 0;
    row.outputTokens += m.outputTokens ?? 0;
    row.ms += m.ms ?? 0;
    this.dirty = true;
  }
  flush(): void {
    if (!this.storePath || !this.dirty) return;
    mkdirSync(dirname(this.storePath), { recursive: true });
    writeFileSync(this.storePath, JSON.stringify(this.data));
    this.dirty = false;
  }
  usage(period: string, account?: string): Record<string, Record<string, Meter>> {
    const all = this.data[period] ?? {};
    return account ? (all[account] ? { [account]: all[account]! } : {}) : all;
  }
}

/** First price-book entry matching `server/tool`. */
export function priceFor(cfg: Cfg, target: string): Price | undefined {
  return cfg.priceBook.find((p) => globToRegExp(p.match).test(target));
}

export interface InvoiceLine {
  target: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  seconds: number;
  rate: string;
  amount: number;
}
export interface Invoice {
  number: string;
  account: string;
  name?: string;
  period: string;
  currency: string;
  lines: InvoiceLine[];
  subtotal: number;
  discount: number;
  minimumTopUp: number;
  tax: number;
  total: number;
}

const round = (n: number, d = 6) => Math.round(n * 10 ** d) / 10 ** d;
const cents = (n: number) => Math.round(n * 100) / 100;

export function buildInvoice(cfg: Cfg, account: string, period: string, usage: Record<string, Meter>): Invoice {
  const lines: InvoiceLine[] = Object.entries(usage)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([target, m]) => {
      const p = priceFor(cfg, target);
      const amount = p ? m.calls * p.perCall + m.inputTokens * p.perInputToken + m.outputTokens * p.perOutputToken + (m.ms / 1000) * p.perSecond : 0;
      const rate = p ? [p.perCall && `${p.perCall}/call`, p.perInputToken && `${p.perInputToken}/in-token`, p.perOutputToken && `${p.perOutputToken}/out-token`, p.perSecond && `${p.perSecond}/s`].filter(Boolean).join(' + ') || 'free' : 'unpriced';
      return { target, calls: m.calls, inputTokens: m.inputTokens, outputTokens: m.outputTokens, seconds: round(m.ms / 1000, 3), rate, amount: round(amount) };
    });
  const acct = cfg.accounts[account];
  const subtotal = cents(lines.reduce((s, l) => s + l.amount, 0));
  const discount = cents((subtotal * (acct?.discountPct ?? 0)) / 100);
  const minimumTopUp = cents(Math.max(0, (acct?.monthlyMinimum ?? 0) - (subtotal - discount)));
  const taxable = subtotal - discount + minimumTopUp;
  const tax = cents((taxable * (acct?.taxPct ?? cfg.taxPct)) / 100);
  const slug = account.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toUpperCase() || 'ACCOUNT';
  return { number: `INV-${period.replace('-', '')}-${slug}`, account, ...(acct?.name ? { name: acct.name } : {}), period, currency: cfg.currency, lines, subtotal, discount, minimumTopUp, tax, total: cents(taxable + tax) };
}

export function invoiceCsv(inv: Invoice): string {
  const esc = (v: unknown) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = [['invoice', 'account', 'period', 'target', 'calls', 'input_tokens', 'output_tokens', 'seconds', 'rate', `amount_${inv.currency.toLowerCase()}`]];
  for (const l of inv.lines) rows.push([inv.number, inv.account, inv.period, l.target, String(l.calls), String(l.inputTokens), String(l.outputTokens), String(l.seconds), l.rate, String(l.amount)]);
  for (const [k, v] of [['subtotal', inv.subtotal], ['discount', -inv.discount], ['minimum top-up', inv.minimumTopUp], ['tax', inv.tax], ['total', inv.total]] as const) rows.push([inv.number, inv.account, inv.period, k, '', '', '', '', '', String(v)]);
  return rows.map((r) => r.map(esc).join(',')).join('\n') + '\n';
}

const settings = (cfg: GatewayConfig): Cfg | undefined => {
  if (!cfg.billing) return undefined;
  const c = BillingSchema.parse(cfg.billing);
  return c.enabled ? c : undefined;
};
const meters = new Map<string, UsageMeter>();
/** The meter for a config's `storePath` (process-wide; in-memory when unset). */
export function usageMeter(cfg: Cfg): UsageMeter {
  const k = cfg.storePath ?? '';
  let m = meters.get(k);
  if (!m) meters.set(k, (m = new UsageMeter(cfg.storePath)));
  return m;
}

registerCallHook({
  id: 'billing',
  after: (call, result, cfg) => {
    const c = settings(cfg);
    if (!c || !result.success) return;
    const u = extractUsage(result.result);
    usageMeter(c).add(call.tenant ?? call.clientId ?? 'anonymous', `${call.serverId}/${call.tool}`, { calls: 1, inputTokens: u?.input ?? 0, outputTokens: u?.output ?? 0, ms: result.durationMs });
  },
});

registerFeature({
  id: 'billing',
  since: '6.7.0',
  summary: 'Usage billing: per-tenant metering against a price book, monthly invoices (JSON / CSV)',
  mount: (router, ctx) => {
    const timer = setInterval(() => {
      const c = settings(ctx.config());
      if (c) usageMeter(c).flush();
    }, 5000);
    timer.unref();
    ctx.onStop?.(() => {
      clearInterval(timer);
      const c = settings(ctx.config());
      if (c) usageMeter(c).flush();
    });
    const need = (res: import('express').Response) => {
      const c = settings(ctx.config());
      if (!c) res.status(404).json({ error: 'Not Found', message: 'billing is not configured' });
      return c;
    };
    const period = (q: unknown) => (typeof q === 'string' && /^\d{4}-\d{2}$/.test(q) ? q : periodOf(new Date()));
    router.get('/usage', (req, res) => {
      const c = need(res);
      if (!c) return;
      const p = period(req.query.period);
      res.json({ period: p, usage: usageMeter(c).usage(p, typeof req.query.account === 'string' ? req.query.account : undefined) });
    });
    router.get('/invoices', (req, res) => {
      const c = need(res);
      if (!c) return;
      const p = period(req.query.period);
      const used = usageMeter(c).usage(p);
      const accounts = [...new Set([...Object.keys(used), ...Object.entries(c.accounts).filter(([, a]) => a.monthlyMinimum > 0).map(([k]) => k)])].sort();
      const invoices = accounts.map((a) => buildInvoice(c, a, p, used[a] ?? {}));
      res.json({ period: p, currency: c.currency, total: cents(invoices.reduce((s, i) => s + i.total, 0)), invoices: invoices.map(({ lines: _l, ...i }) => i) });
    });
    router.get('/invoices/:account', (req, res) => {
      const c = need(res);
      if (!c) return;
      const p = period(req.query.period);
      const inv = buildInvoice(c, req.params.account, p, usageMeter(c).usage(p)[req.params.account] ?? {});
      if (req.query.format === 'csv') return void res.type('text/csv').setHeader('content-disposition', `attachment; filename="${inv.number}.csv"`).send(invoiceCsv(inv));
      res.json(inv);
    });
  },
});
