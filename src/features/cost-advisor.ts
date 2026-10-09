/**
 * Cost optimization advisor (8.4): turns recent traffic and the price list (`costs`) into concrete, quantified
 * recommendations — what to cache, which failing tools burn money, which calls could go to a cheaper upstream, and
 * whether budgets are missing.
 *
 * ```yaml
 * costAdvisor:
 *   windowMinutes: 1440        # traffic analysed (rolling)
 *   minCalls: 20               # ignore tools with fewer calls in the window
 *   repeatThreshold: 0.3       # share of identical calls (same tool + arguments) that suggests caching
 *   errorThreshold: 0.2        # failure rate that flags wasted spend
 * ```
 *
 * The advisor observes every tool call (tool, a hash of the arguments, price, outcome) in a bounded rolling window;
 * nothing else is stored. `GET /api/v1/admin/cost-advisor` returns
 * `{ currency, window, spend, totalSavings, recommendations: [{ id, kind, tool, savings, detail, suggestion }] }`,
 * sorted by estimated savings (per window). Kinds: `cache`, `failures`, `cheaper-upstream`, `budget`.
 *
 * @module features/cost-advisor
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { registerFeature } from '../gateway/features.js';
import { registerCallHook } from '../gateway/hooks.js';
import { priceCall, usageOf, type CostsConfig } from '../costs/index.js';
import { globToRegExp } from '../utils/tool-filter.js';
import type { GatewayConfig, ToolInfo } from '../utils/types.js';
import { type CostAdvisorConfig, CostAdvisorSchema } from './schemas/cost-advisor.js';
export { type CostAdvisorConfig, CostAdvisorSchema } from './schemas/cost-advisor.js';
type Cfg = z.output<typeof CostAdvisorSchema>;

export interface Observation {
  at: number;
  serverId: string;
  tool: string;
  argsHash: string;
  cost: number;
  success: boolean;
}
export interface Recommendation {
  id: string;
  kind: 'cache' | 'failures' | 'cheaper-upstream' | 'budget';
  tool?: string;
  /** Estimated savings over the analysed window, in `currency`. */
  savings: number;
  detail: string;
  /** Config to add (YAML-shaped object). */
  suggestion?: Record<string, unknown>;
}

const settings = (cfg: GatewayConfig): Cfg | undefined => {
  if (!cfg.costAdvisor) return undefined;
  const c = CostAdvisorSchema.parse(cfg.costAdvisor);
  return c.enabled ? c : undefined;
};
const round = (n: number) => Math.round(n * 1e4) / 1e4;
const stable = (v: unknown): string =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
    : Array.isArray(v)
      ? `[${v.map(stable).join(',')}]`
      : JSON.stringify(v) ?? 'null';
export const argsHash = (args: unknown) => createHash('sha256').update(stable(args)).digest('hex').slice(0, 16);

/** Rolling observations; exported for tests. */
export const advisorState = {
  obs: [] as Observation[],
  pending: new WeakMap<object, { hash: string; at: number }>(),
  reset() {
    this.obs.length = 0;
  },
};

export function observe(o: Observation, max: number): void {
  advisorState.obs.push(o);
  if (advisorState.obs.length > max) advisorState.obs.splice(0, advisorState.obs.length - max);
}

const isCached = (cfg: GatewayConfig, serverId: string, tool: string): boolean => {
  const cache = cfg.cache as { enabled?: boolean; rules?: Array<{ servers?: string[]; tools?: string[]; ttlSeconds?: number; dedupeOnly?: boolean }> } | undefined;
  if (!cache?.enabled) return false;
  return (cache.rules ?? []).some((r) => !r.dedupeOnly && (r.ttlSeconds ?? 1) > 0 && (!r.servers?.length || r.servers.some((g) => globToRegExp(g).test(serverId))) && (!r.tools?.length || r.tools.some((g) => globToRegExp(g).test(tool) || globToRegExp(g).test(`${serverId}/${tool}`))));
};

/** Analyse observations against the config (pure; `now` for tests). */
export function analyse(cfg: GatewayConfig, c: Cfg, obs: Observation[], tools: ToolInfo[], now = Date.now()) {
  const since = now - c.windowMinutes * 60_000;
  const win = obs.filter((o) => o.at >= since);
  const costs = cfg.costs as CostsConfig | undefined;
  const recs: Recommendation[] = [];
  const byTool = new Map<string, Observation[]>();
  for (const o of win) {
    const k = `${o.serverId}/${o.tool}`;
    (byTool.get(k) ?? byTool.set(k, []).get(k)!).push(o);
  }
  const spend = round(win.reduce((s, o) => s + o.cost, 0));
  for (const [name, list] of byTool) {
    if (list.length < c.minCalls) continue;
    const [serverId, ...rest] = name.split('/');
    const tool = rest.join('/');
    const avg = list.reduce((s, o) => s + o.cost, 0) / list.length;
    // Identical calls (same arguments) after the first of each kind could be served from cache.
    const ok = list.filter((o) => o.success);
    const distinct = new Set(ok.map((o) => o.argsHash)).size;
    const repeats = ok.length - distinct;
    if (ok.length && repeats / list.length >= c.repeatThreshold && !isCached(cfg, serverId!, tool)) {
      recs.push({
        id: `cache:${name}`,
        kind: 'cache',
        tool: name,
        savings: round(repeats * avg),
        detail: `${repeats} of ${list.length} calls repeated identical arguments (${Math.round((repeats / list.length) * 100)}%)`,
        suggestion: { cache: { enabled: true, rules: [{ servers: [serverId], tools: [tool], ttlSeconds: 300 }] } },
      });
    }
    const failed = list.length - ok.length;
    if (failed / list.length >= c.errorThreshold) {
      const wasted = list.filter((o) => !o.success).reduce((s, o) => s + o.cost, 0);
      recs.push({
        id: `failures:${name}`,
        kind: 'failures',
        tool: name,
        savings: round(wasted),
        detail: `${failed} of ${list.length} calls failed (${Math.round((failed / list.length) * 100)}%) — failed calls are still billed; fix the upstream or the callers' arguments, or fail over (federation / rollouts)`,
      });
    }
    // Same tool name on another server with a lower per-call price.
    const here = priceCall(costs, serverId!, tool, undefined);
    const alt = tools
      .filter((t) => t.name === tool && t.serverId !== serverId)
      .map((t) => ({ serverId: t.serverId, price: priceCall(costs, t.serverId, tool, undefined) }))
      .filter((a) => a.price < here)
      .sort((a, b) => a.price - b.price)[0];
    if (alt) {
      recs.push({
        id: `cheaper-upstream:${name}`,
        kind: 'cheaper-upstream',
        tool: name,
        savings: round(list.length * (here - alt.price)),
        detail: `"${tool}" is also served by "${alt.serverId}" at ${alt.price} per call (vs ${here})`,
        suggestion: { rollouts: [{ id: `${tool}-to-${alt.serverId}`, stable: serverId, canary: alt.serverId, tools: [tool], percent: 10 }] },
      });
    }
  }
  if (spend > 0 && !(costs?.budgets?.length)) {
    recs.push({ id: 'budget', kind: 'budget', savings: 0, detail: `${spend} spent in the window with no budget configured`, suggestion: { costs: { budgets: [{ name: 'monthly', period: 'month', limit: Math.ceil(spend * (43_200 / c.windowMinutes) * 1.2), alertAt: [0.8, 1] }] } } });
  }
  recs.sort((a, b) => b.savings - a.savings);
  return {
    currency: costs?.currency ?? 'USD',
    window: { minutes: c.windowMinutes, since: new Date(since).toISOString(), calls: win.length },
    spend,
    totalSavings: round(recs.reduce((s, r) => s + r.savings, 0)),
    recommendations: recs,
  };
}

registerCallHook({
  id: 'cost-advisor',
  before(call, cfg) {
    if (!settings(cfg)) return;
    advisorState.pending.set(call.args, { hash: argsHash(call.args), at: Date.now() });
  },
  after(call, result, cfg) {
    const c = settings(cfg);
    if (!c) return;
    const p = advisorState.pending.get(call.args);
    observe({ at: p?.at ?? Date.now(), serverId: call.serverId, tool: call.tool, argsHash: p?.hash ?? argsHash(call.args), cost: priceCall(cfg.costs as CostsConfig | undefined, call.serverId, call.tool, result.success ? usageOf(result.result) : undefined), success: result.success }, c.maxObservations);
  },
});

registerFeature({
  id: 'cost-advisor',
  since: '8.4.0',
  summary: 'Cost optimization advisor: quantified caching, failure, cheaper-upstream and budget recommendations from live traffic',
  mount(router, ctx) {
    router.get('/', (req, res) => {
      const c = settings(ctx.config());
      if (!c) return void res.json({ enabled: false, recommendations: [] });
      const minutes = Number(req.query.windowMinutes);
      const cc = Number.isInteger(minutes) && minutes > 0 ? { ...c, windowMinutes: Math.min(minutes, 43_200) } : c;
      res.json({ enabled: true, ...analyse(ctx.config(), cc, advisorState.obs, ctx.tools()) });
    });
  },
});
