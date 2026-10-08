/**
 * Cost accounting per LLM call and budget alerts (4.3).
 *
 * Every tool call is priced from:
 *  - `costs.tools[]` — a flat price per call matched by `server/tool` glob (first match wins);
 *  - LLM usage reported by the upstream in the result's `_meta.usage` (`{ model, inputTokens, outputTokens }`;
 *    OpenAI-style `prompt_tokens` / `completion_tokens` and Anthropic-style `input_tokens` / `output_tokens` are
 *    accepted too) priced with `costs.models[model]` (per 1K tokens).
 *
 * Costs accrue per client, tenant, server and model in calendar periods (UTC day / month). `costs.budgets[]` set a
 * limit per subject (`clients` / `tenants` globs, or everyone); crossing an `alertAt` fraction fires an alert once per
 * period (logged, listed in `GET /api/v1/costs`, optionally POSTed to `webhook`), and `action: block` refuses further
 * calls (`-32013`) until the period resets.
 *
 * @module costs
 */

import express, { type Request, type RequestHandler } from 'express';
import { globToRegExp } from '../utils/tool-filter.js';
import { logger } from '../utils/logger.js';

export const ERR_BUDGET_EXCEEDED = -32013;

export interface ModelPrice {
  /** Price per 1K input tokens. */
  input: number;
  /** Price per 1K output tokens. */
  output: number;
}

export interface BudgetConfig {
  name: string;
  /** Client id globs (default: everyone, pooled). */
  clients?: string[];
  /** Tenant ids; the budget applies per tenant. */
  tenants?: string[];
  /** `perClient: true` gives every matching client its own budget. */
  perClient?: boolean;
  period: 'day' | 'month';
  limit: number;
  /** Fractions of the limit that fire an alert (default [0.8, 1]). */
  alertAt?: number[];
  /** `alert` (default) only notifies; `block` also refuses calls once the limit is reached. */
  action?: 'alert' | 'block';
  webhook?: string;
}

export interface CostsConfig {
  currency?: string;
  tools?: Array<{ match: string; perCall: number }>;
  models?: Record<string, ModelPrice>;
  budgets?: BudgetConfig[];
}

export interface LlmUsage {
  model?: string;
  inputTokens: number;
  outputTokens: number;
}

export interface CostEntry {
  at: number;
  clientId?: string;
  tenants?: string[];
  serverId: string;
  tool: string;
  usage?: LlmUsage;
  cost: number;
}

export interface BudgetAlert {
  budget: string;
  subject: string;
  threshold: number;
  spent: number;
  limit: number;
  at: string;
  period: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/** LLM usage reported in a tool result's `_meta.usage` (several vendor shapes). */
export function usageOf(result: unknown): LlmUsage | undefined {
  if (!isObj(result) || !isObj(result._meta)) return undefined;
  const u = result._meta.usage ?? result._meta['llm/usage'];
  if (!isObj(u)) return undefined;
  const input = num(u.inputTokens) ?? num(u.input_tokens) ?? num(u.prompt_tokens);
  const output = num(u.outputTokens) ?? num(u.output_tokens) ?? num(u.completion_tokens);
  if (input === undefined && output === undefined) return undefined;
  return { model: typeof u.model === 'string' ? u.model : typeof result._meta.model === 'string' ? (result._meta.model as string) : undefined, inputTokens: input ?? 0, outputTokens: output ?? 0 };
}

/** Price one call. */
export function priceCall(cfg: CostsConfig | undefined, serverId: string, tool: string, usage: LlmUsage | undefined): number {
  let cost = 0;
  const rule = cfg?.tools?.find((t) => globToRegExp(t.match).test(`${serverId}/${tool}`));
  if (rule) cost += rule.perCall;
  if (usage) {
    const models = cfg?.models ?? {};
    const price = (usage.model && (models[usage.model] ?? Object.entries(models).find(([k]) => k.includes('*') && globToRegExp(k).test(usage.model!))?.[1])) || models['*'];
    if (price) cost += (usage.inputTokens / 1000) * price.input + (usage.outputTokens / 1000) * price.output;
  }
  return Math.round(cost * 1e6) / 1e6;
}

/** Start of the period containing `t` (UTC). */
export function periodStart(t: number, period: 'day' | 'month'): number {
  const d = new Date(t);
  return period === 'day' ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<unknown>;

export class CostLedger {
  private entries: CostEntry[] = [];
  private readonly fired = new Set<string>();
  private readonly alerts: BudgetAlert[] = [];

  constructor(
    private readonly config: () => CostsConfig | undefined,
    private readonly opts: { now?: () => number; fetch?: FetchFn; maxEntries?: number } = {},
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  get enabled(): boolean {
    const c = this.config();
    return !!c && !!(c.tools?.length || Object.keys(c.models ?? {}).length || c.budgets?.length);
  }

  /** Subjects of a budget a call belongs to (empty: the budget does not apply). */
  private subjects(b: BudgetConfig, clientId: string | undefined, tenants: string[] | undefined): string[] {
    const id = clientId ?? 'anonymous';
    if (b.tenants?.length) return (tenants ?? []).filter((t) => b.tenants!.includes(t)).map((t) => `tenant:${t}`);
    if (b.clients?.length && !b.clients.some((p) => globToRegExp(p).test(id))) return [];
    return [b.perClient ? id : '*'];
  }

  private spent(b: BudgetConfig, subject: string, since: number): number {
    let total = 0;
    for (const e of this.entries) {
      if (e.at < since) continue;
      const s = this.subjects(b, e.clientId, e.tenants);
      if (s.includes(subject)) total += e.cost;
    }
    return Math.round(total * 1e6) / 1e6;
  }

  /** A blocking budget that is used up for this caller, if any. */
  blocked(clientId: string | undefined, tenants: string[] | undefined): { budget: string; subject: string; limit: number; spent: number; resetsAt: string } | undefined {
    const now = this.now();
    for (const b of this.config()?.budgets ?? []) {
      if (b.action !== 'block') continue;
      const since = periodStart(now, b.period);
      for (const subject of this.subjects(b, clientId, tenants)) {
        const spent = this.spent(b, subject, since);
        if (spent >= b.limit) {
          const d = new Date(since);
          const resets = b.period === 'day' ? since + 86_400_000 : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
          return { budget: b.name, subject, limit: b.limit, spent, resetsAt: new Date(resets).toISOString() };
        }
      }
    }
    return undefined;
  }

  /** Record a finished call; returns its cost. */
  record(e: Omit<CostEntry, 'at' | 'cost' | 'usage'> & { result?: unknown }): CostEntry {
    const usage = usageOf(e.result);
    const entry: CostEntry = { at: this.now(), clientId: e.clientId, tenants: e.tenants, serverId: e.serverId, tool: e.tool, usage, cost: priceCall(this.config(), e.serverId, e.tool, usage) };
    if (entry.cost === 0 && !usage) return entry;
    this.entries.push(entry);
    const max = this.opts.maxEntries ?? 100_000;
    if (this.entries.length > max) this.entries.splice(0, this.entries.length - max);
    this.checkBudgets(entry);
    return entry;
  }

  private checkBudgets(entry: CostEntry): void {
    const now = entry.at;
    for (const b of this.config()?.budgets ?? []) {
      const since = periodStart(now, b.period);
      for (const subject of this.subjects(b, entry.clientId, entry.tenants)) {
        const spent = this.spent(b, subject, since);
        for (const th of [...(b.alertAt ?? [0.8, 1])].sort()) {
          const key = `${b.name}\u0000${subject}\u0000${since}\u0000${th}`;
          if (spent < b.limit * th || this.fired.has(key)) continue;
          this.fired.add(key);
          const alert: BudgetAlert = { budget: b.name, subject, threshold: th, spent, limit: b.limit, at: new Date(now).toISOString(), period: new Date(since).toISOString().slice(0, b.period === 'day' ? 10 : 7) };
          this.alerts.unshift(alert);
          this.alerts.length = Math.min(this.alerts.length, 200);
          logger.warn(`Budget "${b.name}" for ${subject}: ${Math.round(th * 100)}% reached (${spent} of ${b.limit} ${this.config()?.currency ?? 'USD'})`);
          if (b.webhook) {
            const f = this.opts.fetch ?? ((u: string, i: RequestInit) => fetch(u, i));
            Promise.resolve(f(b.webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'budget.alert', ...alert }) })).catch((err: unknown) =>
              logger.warn(`Budget webhook failed: ${err instanceof Error ? err.message : String(err)}`),
            );
          }
        }
      }
    }
  }

  /** Totals since `since` grouped by a dimension. */
  totals(by: 'client' | 'tenant' | 'server' | 'model' | 'tool', since = 0): Array<{ key: string; cost: number; calls: number; inputTokens: number; outputTokens: number }> {
    const m = new Map<string, { key: string; cost: number; calls: number; inputTokens: number; outputTokens: number }>();
    for (const e of this.entries) {
      if (e.at < since) continue;
      const keys =
        by === 'client' ? [e.clientId ?? 'anonymous'] : by === 'tenant' ? (e.tenants?.length ? e.tenants : ['(none)']) : by === 'server' ? [e.serverId] : by === 'tool' ? [`${e.serverId}/${e.tool}`] : [e.usage?.model ?? '(none)'];
      for (const key of keys) {
        const t = m.get(key) ?? { key, cost: 0, calls: 0, inputTokens: 0, outputTokens: 0 };
        t.cost = Math.round((t.cost + e.cost) * 1e6) / 1e6;
        t.calls++;
        t.inputTokens += e.usage?.inputTokens ?? 0;
        t.outputTokens += e.usage?.outputTokens ?? 0;
        m.set(key, t);
      }
    }
    return [...m.values()].sort((a, b) => b.cost - a.cost);
  }

  /** Budget status for every subject seen in the current periods. */
  budgets(): Array<{ name: string; subject: string; period: string; limit: number; spent: number; used: number; action: string }> {
    const now = this.now();
    const out: Array<{ name: string; subject: string; period: string; limit: number; spent: number; used: number; action: string }> = [];
    for (const b of this.config()?.budgets ?? []) {
      const since = periodStart(now, b.period);
      const subjects = new Set<string>();
      for (const e of this.entries) if (e.at >= since) for (const s of this.subjects(b, e.clientId, e.tenants)) subjects.add(s);
      if (!subjects.size && !b.perClient && !b.tenants?.length) subjects.add('*');
      for (const subject of subjects) {
        const spent = this.spent(b, subject, since);
        out.push({ name: b.name, subject, period: b.period, limit: b.limit, spent, used: b.limit ? Math.round((spent / b.limit) * 1000) / 1000 : 0, action: b.action ?? 'alert' });
      }
    }
    return out;
  }

  recentAlerts(): BudgetAlert[] {
    return this.alerts;
  }
}


/** `GET /costs?by=client|tenant|server|model|tool&period=day|month|all` (operators). */
export function costsRouter(ledger: CostLedger, config: () => CostsConfig | undefined, authenticate: RequestHandler, isOperator: (req: Request) => boolean): express.Router {
  const r = express.Router();
  r.get('/costs', authenticate, (req, res) => {
    if (!isOperator(req)) return void res.status(403).json({ error: 'Forbidden', message: 'Operator access required' });
    const by = String(req.query.by ?? 'client');
    if (!['client', 'tenant', 'server', 'model', 'tool'].includes(by)) return void res.status(400).json({ error: 'Bad Request', message: '"by" must be client, tenant, server, model or tool' });
    const period = String(req.query.period ?? 'month');
    const since = period === 'all' ? 0 : periodStart(Date.now(), period === 'day' ? 'day' : 'month');
    res.json({
      currency: config()?.currency ?? 'USD',
      period,
      by,
      totals: ledger.totals(by as 'client', since),
      budgets: ledger.budgets(),
      alerts: ledger.recentAlerts().slice(0, 50),
    });
  });
  return r;
}
