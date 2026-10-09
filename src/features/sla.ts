/**
 * SLA monitoring & credit reports (9.5): availability and latency objectives per server / tenant, measured on every
 * tool call, with breach detection and service-credit reports.
 *
 * ```yaml
 * sla:
 *   targets:
 *     - id: search-gold
 *       servers: ["search*"]          # server globs (default all)
 *       tenants: ["*"]                # tenant globs (calls without a tenant count as "-")
 *       availability: 99.9            # percent of successful calls
 *       latencyP95Ms: 800             # optional
 *       windowDays: 30                # rolling window
 *       monthlyFee: 2000              # optional, to turn credit percents into amounts
 *       currency: EUR
 *       credits:                      # first matching tier wins (lowest availability first)
 *         - { below: 99.0, percent: 25 }
 *         - { below: 99.9, percent: 10 }
 *       excludeErrorCodes: [-32003]   # failures that are not the provider's fault (e.g. policy refusals)
 * ```
 *
 * Calls are counted in hourly buckets (bounded memory: `windowDays × 24` per target). Latency p95 comes from a
 * fixed log-scale histogram.
 *
 * - `GET /admin/sla` — every target: calls, availability, p95, error budget left, `met`, breaches and credit.
 * - `GET /admin/sla/report?target=&format=json|csv` — credit report (per target and per tenant).
 * - `POST /admin/sla/reset` — clear the counters.
 *
 * @module features/sla
 */

import { z } from 'zod';
import { registerFeature, badRequest } from '../gateway/features.js';
import { registerCallHook, type HookCall } from '../gateway/hooks.js';
import { globToRegExp } from '../utils/tool-filter.js';
import type { GatewayConfig, ProxyResponse } from '../utils/types.js';
import { BOUNDS, HOUR, type SlaConfig, SlaSchema, Target } from './schemas/sla.js';
export { type SlaConfig, SlaSchema } from './schemas/sla.js';
type T = z.output<typeof Target>;

interface Bucket {
  hour: number;
  calls: number;
  failures: number;
  hist: number[];
  byTenant: Map<string, { calls: number; failures: number }>;
}

/** Runtime state; exported for tests. */
export const slaState = {
  buckets: new Map<string, Bucket[]>(),
  reset() {
    this.buckets.clear();
  },
};

const settings = (cfg: GatewayConfig) => {
  if (!cfg.sla) return undefined;
  const c = SlaSchema.parse(cfg.sla);
  return c.enabled ? c : undefined;
};
const glob = (gs: string[], s: string) => gs.some((g) => globToRegExp(g).test(s));

/** Count one call against every matching target (exported for tests). */
export function recordSla(call: Pick<HookCall, 'serverId' | 'tenant'>, result: Pick<ProxyResponse, 'success' | 'error' | 'durationMs'>, cfg: GatewayConfig, now = Date.now()): void {
  const s = settings(cfg);
  if (!s) return;
  const tenant = call.tenant ?? '-';
  for (const t of s.targets) {
    if (!glob(t.servers, call.serverId) || !glob(t.tenants, tenant)) continue;
    if (!result.success && result.error && t.excludeErrorCodes.includes(result.error.code)) continue;
    const hour = Math.floor(now / HOUR);
    let list = slaState.buckets.get(t.id);
    if (!list) slaState.buckets.set(t.id, (list = []));
    let b = list[list.length - 1];
    if (!b || b.hour !== hour) {
      list.push((b = { hour, calls: 0, failures: 0, hist: BOUNDS.map(() => 0), byTenant: new Map() }));
      const keep = hour - t.windowDays * 24;
      while (list.length && list[0].hour <= keep) list.shift();
    }
    b.calls++;
    if (!result.success) b.failures++;
    b.hist[BOUNDS.findIndex((x) => result.durationMs <= x)]++;
    const bt = b.byTenant.get(tenant) ?? { calls: 0, failures: 0 };
    bt.calls++;
    if (!result.success) bt.failures++;
    b.byTenant.set(tenant, bt);
  }
}

const p95 = (hist: number[]): number | null => {
  const n = hist.reduce((a, b) => a + b, 0);
  if (!n) return null;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= 0.95 * n) return BOUNDS[i] === Infinity ? BOUNDS[i - 1] : BOUNDS[i];
  }
  return null;
};
const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

/** Evaluate one target over its rolling window. */
export function evaluate(t: T, now = Date.now()) {
  const from = Math.floor(now / HOUR) - t.windowDays * 24;
  const list = (slaState.buckets.get(t.id) ?? []).filter((b) => b.hour > from);
  const calls = list.reduce((a, b) => a + b.calls, 0);
  const failures = list.reduce((a, b) => a + b.failures, 0);
  const hist = BOUNDS.map((_, i) => list.reduce((a, b) => a + b.hist[i], 0));
  const availability = calls ? round((100 * (calls - failures)) / calls) : 100;
  const latency = p95(hist);
  const breaches: string[] = [];
  if (availability < t.availability) breaches.push(`availability ${availability}% < ${t.availability}%`);
  if (t.latencyP95Ms !== undefined && latency !== null && latency > t.latencyP95Ms) breaches.push(`p95 ${latency}ms > ${t.latencyP95Ms}ms`);
  const tier = [...t.credits].sort((a, b) => a.below - b.below).find((c) => availability < c.below);
  const allowed = calls * (1 - t.availability / 100);
  const tenants = new Map<string, { calls: number; failures: number }>();
  for (const b of list) for (const [k, v] of b.byTenant) { const x = tenants.get(k) ?? { calls: 0, failures: 0 }; x.calls += v.calls; x.failures += v.failures; tenants.set(k, x); }
  return {
    id: t.id,
    windowDays: t.windowDays,
    from: new Date((from + 1) * HOUR).toISOString(),
    calls,
    failures,
    availability,
    objective: { availability: t.availability, latencyP95Ms: t.latencyP95Ms ?? null },
    latencyP95Ms: latency,
    errorBudget: { allowedFailures: round(allowed, 2), remaining: round(allowed - failures, 2), remainingPercent: allowed > 0 ? round((100 * (allowed - failures)) / allowed, 2) : failures ? 0 : 100 },
    met: breaches.length === 0,
    breaches,
    credit: { percent: tier?.percent ?? 0, amount: tier && t.monthlyFee !== undefined ? round((t.monthlyFee * tier.percent) / 100, 2) : null, currency: t.currency },
    tenants: [...tenants].map(([tenant, v]) => ({ tenant, calls: v.calls, failures: v.failures, availability: v.calls ? round((100 * (v.calls - v.failures)) / v.calls) : 100 })),
  };
}

registerCallHook({
  id: 'sla',
  after(call, result, cfg) {
    recordSla(call, result, cfg);
  },
});

registerFeature({
  id: 'sla',
  since: '9.5.0',
  summary: 'SLA monitoring: availability / p95 latency objectives per server and tenant, error budgets, breaches and service-credit reports',
  mount(router, ctx) {
    router.get('/', (_req, res) => {
      const s = settings(ctx.config());
      res.json({ enabled: !!s, generatedAt: new Date().toISOString(), targets: (s?.targets ?? []).map((t) => evaluate(t)) });
    });
    router.get('/report', (req, res) => {
      const s = settings(ctx.config());
      const want = typeof req.query.target === 'string' ? req.query.target : undefined;
      const ts = (s?.targets ?? []).filter((t) => !want || t.id === want);
      if (want && !ts.length) return void res.status(404).json({ error: 'Not Found', message: `no SLA target "${want}"` });
      const rows = ts.map((t) => evaluate(t));
      const format = String(req.query.format ?? 'json');
      if (format === 'csv') {
        const q = (v: unknown) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
        const lines = ['target,tenant,from,calls,failures,availability,objective,p95_ms,met,credit_percent,credit_amount,currency'];
        for (const r of rows) {
          lines.push([r.id, '*', r.from, r.calls, r.failures, r.availability, r.objective.availability, r.latencyP95Ms ?? '', r.met, r.credit.percent, r.credit.amount ?? '', r.credit.currency].map(q).join(','));
          for (const x of r.tenants) lines.push([r.id, x.tenant, r.from, x.calls, x.failures, x.availability, r.objective.availability, '', x.availability >= r.objective.availability, '', '', ''].map(q).join(','));
        }
        res.setHeader('content-type', 'text/csv; charset=utf-8');
        res.setHeader('content-disposition', 'attachment; filename="sla-report.csv"');
        return void res.send(lines.join('\n') + '\n');
      }
      if (format !== 'json') return badRequest(res, 'format must be json or csv');
      res.json({ generatedAt: new Date().toISOString(), targets: rows, totalCredit: rows.reduce((a, r) => a + (r.credit.amount ?? 0), 0) });
    });
    router.post('/reset', (_req, res) => {
      slaState.reset();
      res.json({ reset: true });
    });
  },
});
