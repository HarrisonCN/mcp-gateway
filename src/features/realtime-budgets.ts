/**
 * Real-time cost and carbon budgets (10.6).
 *
 * `costs.budgets` (4.3) count calendar periods (UTC day / month). Real-time budgets use **sliding windows** (e.g.
 * the last hour) per client, tenant or the whole gateway, on two metrics:
 *
 * - `cost` — priced with the `costs` table (per call / per LLM token from the result's `_meta.usage`);
 * - `carbon` — an **estimate** in grams of CO2e: energy per call (and per input / output token when usage is
 *   reported) × grid carbon intensity. The defaults are placeholders, not measurements — set factors that match your
 *   providers. The gateway cannot measure the energy an upstream actually uses.
 *
 * Before the limit: alerts at `warnAt` fractions (log, webhook, `GET /admin/realtime-budgets/alerts`). At the limit:
 * `reject` the call (JSON-RPC error `-32013` on `/mcp` with `data.decision: "budget"`; REST `429` with
 * `Retry-After`), `downgrade` it (reroute to a cheaper server and / or override arguments
 * such as `model`), or only `warn`.
 *
 * ```yaml
 * features:
 *   realtimeBudgets:
 *     carbon:
 *       gridIntensity: 400            # gCO2e per kWh (default)
 *       servers: { "eu-*": 250 }      # per-server intensity (globs)
 *       perCallWh: 0.02               # default energy per call
 *       perInputTokenWh: 0.0003       # per token, when the result reports usage
 *       perOutputTokenWh: 0.0012
 *       tools: [{ match: "llm/*", perCallWh: 0.5 }]
 *     budgets:
 *       - name: agent-hourly-spend
 *         metric: cost
 *         per: client                 # client | tenant | global
 *         clients: ["key:agent-*"]
 *         windowSeconds: 3600
 *         limit: 2
 *         warnAt: [0.8]
 *         onExceed: downgrade
 *         downgrade: { server: llm-small, args: { model: gpt-4o-mini } }
 *       - name: tenant-carbon-daily
 *         metric: carbon
 *         per: tenant
 *         windowSeconds: 86400
 *         limit: 500                  # grams CO2e
 *         onExceed: reject
 *         webhook: https://hooks.example.com/budgets
 * ```
 *
 * State is per process (in memory); with several replicas each enforces its own share.
 *
 * @module features/realtime-budgets
 */

import { z } from 'zod';
import { registerFeature, objectBody, badRequest } from '../gateway/features.js';
import { registerCallHook } from '../gateway/hooks.js';
import { priceCall, usageOf, type LlmUsage } from '../costs/index.js';
import { globToRegExp } from '../utils/tool-filter.js';
import type { GatewayConfig } from '../utils/types.js';
import { logger } from '../utils/logger.js';

/** Same code as calendar budgets (`costs.budgets`, action block). */
export const ERR_BUDGET_EXCEEDED = -32013;

const BudgetSchema = z
  .object({
    name: z.string().min(1),
    metric: z.enum(['cost', 'carbon']),
    per: z.enum(['client', 'tenant', 'global']).default('client'),
    clients: z.array(z.string().min(1)).optional(),
    tenants: z.array(z.string().min(1)).optional(),
    tools: z.array(z.string().min(1)).optional(),
    windowSeconds: z.number().int().min(1).max(31 * 86_400).default(3600),
    limit: z.number().positive(),
    warnAt: z.array(z.number().gt(0).lt(1)).default([0.8]),
    onExceed: z.enum(['reject', 'downgrade', 'warn']).default('reject'),
    downgrade: z
      .object({ server: z.string().min(1).optional(), args: z.record(z.unknown()).optional() })
      .strict()
      .refine((d) => d.server !== undefined || d.args !== undefined, 'downgrade needs "server" and / or "args"')
      .optional(),
    webhook: z.string().url().optional(),
  })
  .strict()
  .refine((b) => b.onExceed !== 'downgrade' || b.downgrade, { message: 'onExceed: downgrade needs a "downgrade" block' });

const CarbonSchema = z
  .object({
    gridIntensity: z.number().min(0).max(5000).default(400),
    servers: z.record(z.number().min(0).max(5000)).optional(),
    perCallWh: z.number().min(0).default(0.02),
    perInputTokenWh: z.number().min(0).default(0.0003),
    perOutputTokenWh: z.number().min(0).default(0.0012),
    tools: z.array(z.object({ match: z.string().min(1), perCallWh: z.number().min(0) }).strict()).optional(),
  })
  .strict();

export const RealtimeBudgetsSchema = z
  .object({
    enabled: z.boolean().default(true),
    carbon: CarbonSchema.default({}),
    budgets: z.array(BudgetSchema).min(1),
  })
  .strict()
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.budgets.forEach((b, i) => {
      if (seen.has(b.name)) ctx.addIssue({ code: 'custom', path: ['budgets', i, 'name'], message: `duplicate budget name "${b.name}"` });
      seen.add(b.name);
    });
  });
export type RealtimeBudgetsConfig = z.input<typeof RealtimeBudgetsSchema>;
type Parsed = z.output<typeof RealtimeBudgetsSchema>;
type Budget = Parsed['budgets'][number];

/** Estimated grams CO2e of one call. */
export function carbonOf(c: Parsed['carbon'], serverId: string, tool: string, usage: LlmUsage | undefined): number {
  const rule = c.tools?.find((t) => globToRegExp(t.match).test(`${serverId}/${tool}`));
  let wh = rule ? rule.perCallWh : c.perCallWh;
  if (usage) wh += usage.inputTokens * c.perInputTokenWh + usage.outputTokens * c.perOutputTokenWh;
  const intensity = Object.entries(c.servers ?? {}).find(([k]) => globToRegExp(k).test(serverId))?.[1] ?? c.gridIntensity;
  return Math.round((wh / 1000) * intensity * 1e6) / 1e6;
}

/** Sliding window as 60 buckets. */
class Window {
  private readonly buckets = new Map<number, number>();
  constructor(private readonly windowMs: number) {}
  private get width() {
    return Math.max(1, Math.floor(this.windowMs / 60));
  }
  add(v: number, now: number): void {
    const k = Math.floor(now / this.width);
    this.buckets.set(k, (this.buckets.get(k) ?? 0) + v);
    this.prune(now);
  }
  sum(now: number): number {
    this.prune(now);
    let s = 0;
    for (const v of this.buckets.values()) s += v;
    return s;
  }
  /** Milliseconds until the window sum drops below `limit` (oldest buckets expire first); 0 when already below. */
  msUntilBelow(limit: number, now: number): number {
    let total = this.sum(now);
    if (total < limit) return 0;
    for (const k of [...this.buckets.keys()].sort((a, b) => a - b)) {
      total -= this.buckets.get(k)!;
      if (total < limit) return Math.max(1, k * this.width + this.windowMs - now);
    }
    return this.windowMs;
  }
  private prune(now: number): void {
    const min = Math.floor((now - this.windowMs) / this.width);
    for (const k of this.buckets.keys()) if (k <= min) this.buckets.delete(k);
  }
}

export interface RtAlert {
  budget: string;
  subject: string;
  metric: 'cost' | 'carbon';
  threshold: number;
  used: number;
  limit: number;
  at: string;
  kind: 'warning' | 'exceeded';
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<unknown>;

/** Real-time budget state (one per process). */
export class RealtimeBudgets {
  private windows = new Map<string, Window>();
  private fired = new Map<string, number>();
  readonly alerts: RtAlert[] = [];
  readonly downgraded = new Map<string, number>();
  readonly rejected = new Map<string, number>();
  constructor(private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i)) {}

  private applies(b: Budget, call: { clientId?: string; tenant?: string; serverId: string; tool: string }): string | undefined {
    if (b.clients && !b.clients.some((g) => globToRegExp(g).test(call.clientId ?? ''))) return undefined;
    if (b.tenants && !b.tenants.some((g) => globToRegExp(g).test(call.tenant ?? ''))) return undefined;
    if (b.tools && !b.tools.some((g) => globToRegExp(g).test(g.includes('/') ? `${call.serverId}/${call.tool}` : call.tool))) return undefined;
    if (b.per === 'global') return '*';
    if (b.per === 'tenant') return call.tenant;
    return call.clientId ?? 'anonymous';
  }

  private win(b: Budget, subject: string): Window {
    const k = `${b.name}\u0000${subject}\u0000${b.windowSeconds}`;
    let w = this.windows.get(k);
    if (!w) {
      w = new Window(b.windowSeconds * 1000);
      this.windows.set(k, w);
    }
    return w;
  }

  used(b: Budget, subject: string, now = Date.now()): number {
    return Math.round(this.win(b, subject).sum(now) * 1e6) / 1e6;
  }

  /** Budgets this call is over (before it runs), with the seconds until each window drops below its limit. */
  check(cfg: Parsed, call: { clientId?: string; tenant?: string; serverId: string; tool: string }, now = Date.now()): Array<{ budget: Budget; subject: string; used: number; retryAfterSeconds: number }> {
    const out = [];
    for (const b of cfg.budgets) {
      const subject = this.applies(b, call);
      if (subject === undefined) continue;
      const used = this.used(b, subject, now);
      if (used >= b.limit) out.push({ budget: b, subject, used, retryAfterSeconds: Math.max(1, Math.ceil(this.win(b, subject).msUntilBelow(b.limit, now) / 1000)) });
    }
    return out;
  }

  /** Account a finished call. */
  record(cfg: Parsed, costs: GatewayConfig['costs'], call: { clientId?: string; tenant?: string; serverId: string; tool: string }, result: unknown, now = Date.now()): { cost: number; carbon: number } {
    const usage = usageOf(result);
    const cost = priceCall(costs, call.serverId, call.tool, usage);
    const carbon = carbonOf(cfg.carbon, call.serverId, call.tool, usage);
    for (const b of cfg.budgets) {
      const subject = this.applies(b, call);
      if (subject === undefined) continue;
      const v = b.metric === 'cost' ? cost : carbon;
      if (v <= 0) continue;
      const before = this.used(b, subject, now);
      this.win(b, subject).add(v, now);
      const after = before + v;
      for (const t of [...b.warnAt, 1]) {
        if (before < t * b.limit && after >= t * b.limit) this.alert(b, subject, t, after, now);
      }
    }
    return { cost, carbon };
  }

  private alert(b: Budget, subject: string, threshold: number, used: number, now: number): void {
    const key = `${b.name}\u0000${subject}\u0000${threshold}`;
    const last = this.fired.get(key);
    if (last !== undefined && now - last < b.windowSeconds * 1000) return; // once per window
    this.fired.set(key, now);
    const a: RtAlert = { budget: b.name, subject, metric: b.metric, threshold, used: Math.round(used * 1e6) / 1e6, limit: b.limit, at: new Date(now).toISOString(), kind: threshold >= 1 ? 'exceeded' : 'warning' };
    this.alerts.push(a);
    if (this.alerts.length > 500) this.alerts.shift();
    logger.warn(`Real-time budget "${b.name}" (${b.metric}) for ${subject}: ${Math.round(threshold * 100)}% reached (${a.used} / ${b.limit})`);
    if (b.webhook) {
      this.fetchImpl(b.webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'realtime-budget.alert', ...a }) }).catch((err: unknown) =>
        logger.warn(`Real-time budget webhook failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  }

  status(cfg: Parsed, now = Date.now()) {
    const out: Array<{ budget: string; metric: string; per: string; subject: string; used: number; limit: number; fraction: number; windowSeconds: number; onExceed: string }> = [];
    for (const [k] of this.windows) {
      const [name, subject] = k.split('\u0000') as [string, string];
      const b = cfg.budgets.find((x) => x.name === name);
      if (!b) continue;
      const used = this.used(b, subject, now);
      out.push({ budget: b.name, metric: b.metric, per: b.per, subject, used, limit: b.limit, fraction: Math.round((used / b.limit) * 1000) / 1000, windowSeconds: b.windowSeconds, onExceed: b.onExceed });
    }
    return out;
  }

  reset(): void {
    this.windows.clear();
    this.fired.clear();
    this.alerts.length = 0;
    this.downgraded.clear();
    this.rejected.clear();
  }
}

export const realtimeBudgets = new RealtimeBudgets();

export function rtOf(cfg: GatewayConfig): Parsed | undefined {
  const raw = cfg.realtimeBudgets;
  if (!raw) return undefined;
  const p = RealtimeBudgetsSchema.parse(raw);
  return p.enabled ? p : undefined;
}

registerCallHook({
  id: 'realtime-budgets',
  before: (call, cfg) => {
    const rt = rtOf(cfg);
    if (!rt) return;
    const over = realtimeBudgets.check(rt, call);
    if (!over.length) return;
    const reject = over.find((o) => o.budget.onExceed === 'reject');
    if (reject) {
      realtimeBudgets.rejected.set(reject.budget.name, (realtimeBudgets.rejected.get(reject.budget.name) ?? 0) + 1);
      const unit = reject.budget.metric === 'carbon' ? ' gCO2e' : '';
      return {
        refuse: {
          code: ERR_BUDGET_EXCEEDED,
          message: `Real-time budget "${reject.budget.name}" exceeded for ${reject.subject}: ${reject.used}${unit} of ${reject.budget.limit}${unit} in the last ${reject.budget.windowSeconds} s`,
          data: { decision: 'budget', budget: reject.budget.name, metric: reject.budget.metric, used: reject.used, limit: reject.budget.limit, windowSeconds: reject.budget.windowSeconds, retryAfterSeconds: reject.retryAfterSeconds },
        },
      };
    }
    const down = over.find((o) => o.budget.onExceed === 'downgrade');
    if (down?.budget.downgrade) {
      realtimeBudgets.downgraded.set(down.budget.name, (realtimeBudgets.downgraded.get(down.budget.name) ?? 0) + 1);
      const d = down.budget.downgrade;
      return { ...(d.args ? { args: { ...call.args, ...d.args } } : {}), ...(d.server ? { serverId: d.server } : {}) };
    }
    return undefined; // warn only
  },
  after: (call, result, cfg) => {
    const rt = rtOf(cfg);
    if (!rt || !result.success) return;
    realtimeBudgets.record(rt, cfg.costs, call, result.result);
  },
});

registerFeature({
  id: 'realtime-budgets',
  since: '10.6.0',
  summary: 'Real-time cost and carbon budgets: sliding windows per client / tenant, warnings, reject or downgrade',
  mount: (router, ctx) => {
    router.get('/', (_req, res) => {
      const rt = rtOf(ctx.config());
      if (!rt) return badRequest(res, 'features.realtimeBudgets is not configured');
      res.json({
        budgets: rt.budgets.map((b) => ({ name: b.name, metric: b.metric, per: b.per, limit: b.limit, windowSeconds: b.windowSeconds, onExceed: b.onExceed, rejected: realtimeBudgets.rejected.get(b.name) ?? 0, downgraded: realtimeBudgets.downgraded.get(b.name) ?? 0 })),
        usage: realtimeBudgets.status(rt),
        carbon: { ...rt.carbon, unit: 'gCO2e (estimate)' },
      });
    });
    router.get('/alerts', (_req, res) => res.json({ alerts: [...realtimeBudgets.alerts].reverse() }));
    router.post('/estimate', (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      const rt = rtOf(ctx.config());
      if (!rt) return badRequest(res, 'features.realtimeBudgets is not configured');
      if (typeof b.server !== 'string' || typeof b.tool !== 'string') return badRequest(res, '"server" and "tool" are required');
      const usage = b.usage && typeof b.usage === 'object' ? usageOf({ _meta: { usage: b.usage } }) : undefined;
      res.json({ cost: priceCall(ctx.config().costs, b.server, b.tool, usage), carbon: carbonOf(rt.carbon, b.server, b.tool, usage), unit: { carbon: 'gCO2e (estimate)', cost: ctx.config().costs?.currency ?? 'USD' } });
    });
    router.post('/reset', (_req, res) => {
      realtimeBudgets.reset();
      res.json({ reset: true });
    });
  },
});
