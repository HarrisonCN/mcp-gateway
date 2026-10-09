/**
 * Privacy computing (10.8, EXPERIMENTAL): differentially private aggregation of tool results and federated queries
 * across gateways, so that raw rows never leave the domain that holds them.
 *
 * ```yaml
 * features:
 *   privacy:
 *     protect: ["hr/*"]               # raw results of these tools never leave the gateway: direct calls are refused,
 *                                     # only DP aggregates over them are answered
 *     maxEpsilonPerQuery: 1
 *     budget: { epsilon: 10, windowSeconds: 86400 }   # per client key, sequential composition
 *     peers:                          # federated queries: other gateways with features.privacy
 *       - { id: eu, url: https://eu-gw.example.com, token: ${EU_GATEWAY_KEY} }
 * ```
 *
 * `POST /api/v1/features/privacy/aggregate` (any authenticated client allowed to call the tool):
 *
 * ```json
 * { "server": "hr", "tool": "list_employees", "arguments": {}, "rows": "structuredContent.rows",
 *   "field": "salary", "op": "mean", "bounds": [0, 300000], "epsilon": 0.5 }
 * ```
 *
 * The gateway calls the tool (full pipeline, as the caller), takes the row array at `rows` (a path into the result:
 * `structuredContent.*`, or `json.*` for text content that is JSON), clamps `field` to
 * `bounds`, and answers **only** the noisy aggregate: `count` (sensitivity 1), `sum` (sensitivity max(|min|, |max|)),
 * `mean` (ε split between a noisy sum and a noisy count) or `histogram` (`bins` edges; sensitivity 1 per bin,
 * parallel composition). Noise is Laplace(sensitivity / ε) from a cryptographic RNG. ε is charged to the caller's
 * budget before the tool runs; an exhausted budget answers `429`.
 *
 * `POST /api/v1/features/privacy/federated` `{ query, targets: [{ server, tool, arguments? } | { peer, server, tool,
 * arguments? }] }` runs the aggregate in each domain — locally or by calling the peer gateway's `/aggregate` — and
 * combines the noisy partial results (counts and sums add; means combine noisy sums and counts; histograms add per
 * bin). Every domain spends ε on its own data (parallel composition over disjoint datasets).
 *
 * EXPERIMENTAL — what the guarantee rests on: each individual contributes **at most one row** per domain (the gateway
 * cannot check this), the bounds are set independently of the data, and the tool returns the same rows for the same
 * arguments. Floating-point Laplace sampling has known side channels (Mironov 2012); outputs are rounded but not
 * "snapped". Budgets are per process and reset when the window passes or the gateway restarts.
 *
 * @module features/privacy
 */

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { registerFeature, objectBody, badRequest, clientIdOf } from '../gateway/features.js';
import { registerCallHook } from '../gateway/hooks.js';
import { readPath, stepValue } from '../orchestration/chains.js';
import { globToRegExp } from '../utils/tool-filter.js';
import { isToolInScope } from '../auth/scopes.js';
import type { AuthedRequest } from '../auth/middleware.js';
import type { GatewayConfig } from '../utils/types.js';

export const ERR_PRIVACY_PROTECTED = -32003; // same as a policy denial

export const PrivacySchema = z
  .object({
    enabled: z.boolean().default(true),
    protect: z.array(z.string().min(1)).default([]),
    maxEpsilonPerQuery: z.number().positive().max(10).default(1),
    budget: z
      .object({ epsilon: z.number().positive().max(1000).default(10), windowSeconds: z.number().int().min(1).max(366 * 86_400).default(86_400) })
      .strict()
      .default({}),
    peers: z.array(z.object({ id: z.string().min(1), url: z.string().url(), token: z.string().min(1).optional(), timeoutMs: z.number().int().min(100).max(120_000).default(10_000) }).strict()).default([]),
    maxRows: z.number().int().min(1).max(10_000_000).default(1_000_000),
  })
  .strict();
export type PrivacyConfig = z.input<typeof PrivacySchema>;
type Parsed = z.output<typeof PrivacySchema>;

export const QuerySchema = z
  .object({
    rows: z.string().min(1).default('structuredContent.rows'),
    field: z.string().min(1).optional(),
    op: z.enum(['count', 'sum', 'mean', 'histogram']),
    bounds: z.tuple([z.number(), z.number()]).optional(),
    bins: z.array(z.number()).min(2).max(1000).optional(),
    epsilon: z.number().positive(),
    round: z.number().int().min(0).max(6).default(2),
  })
  .strict()
  .superRefine((q, ctx) => {
    if (q.op !== 'count' && !q.field) ctx.addIssue({ code: 'custom', message: `op "${q.op}" needs "field"` });
    if ((q.op === 'sum' || q.op === 'mean') && !q.bounds) ctx.addIssue({ code: 'custom', message: `op "${q.op}" needs "bounds": [min, max] chosen independently of the data` });
    if (q.bounds && !(q.bounds[0] < q.bounds[1])) ctx.addIssue({ code: 'custom', message: '"bounds" must be [min, max] with min < max' });
    if (q.op === 'histogram' && (!q.bins || q.bins.some((b, i) => i > 0 && b <= q.bins![i - 1]!))) ctx.addIssue({ code: 'custom', message: 'op "histogram" needs strictly increasing "bins" edges' });
  });
export type PrivacyQuery = z.input<typeof QuerySchema>;
type Q = z.output<typeof QuerySchema>;

/** Uniform in (0, 1) from 53 random bits (never 0). */
function uniform(): number {
  const b = randomBytes(8);
  const x = (b.readUInt32BE(0) * 2 ** 21 + (b.readUInt32BE(4) >>> 11)) / 2 ** 53;
  return x === 0 ? 2 ** -53 : x;
}

/** Laplace(0, scale) sample. `u` is injectable for tests. */
export function laplace(scale: number, u: () => number = uniform): number {
  const v = u() - 0.5;
  return -scale * Math.sign(v) * Math.log(1 - 2 * Math.abs(v));
}

export interface Aggregate {
  op: Q['op'];
  epsilon: number;
  value: number | number[];
  /** Mean only: the noisy parts (so federated queries can combine domains). */
  parts?: { sum: number; count: number };
  bins?: number[];
  noise: { mechanism: 'laplace'; scale: number | { sum: number; count: number } };
}

const r = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
const clamp = (v: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, v));

/** The DP aggregate of `rows`. Rows whose field is not a finite number count as `bounds[0]` (sum / mean) — never skipped, so the row count stays the sensitivity unit. */
export function dpAggregate(rows: unknown[], q: Q, u?: () => number): Aggregate {
  const val = (row: unknown) => {
    const v = Number(q.field ? readPath(row && typeof row === 'object' ? (row as Record<string, unknown>) : { value: row }, q.field) : NaN);
    return Number.isFinite(v) ? v : undefined;
  };
  const e = q.epsilon;
  switch (q.op) {
    case 'count':
      return { op: 'count', epsilon: e, value: r(rows.length + laplace(1 / e, u), q.round), noise: { mechanism: 'laplace', scale: 1 / e } };
    case 'sum': {
      const sens = Math.max(Math.abs(q.bounds![0]), Math.abs(q.bounds![1]));
      const s = rows.reduce<number>((a, row) => a + clamp(val(row) ?? q.bounds![0], q.bounds!), 0);
      return { op: 'sum', epsilon: e, value: r(s + laplace(sens / e, u), q.round), noise: { mechanism: 'laplace', scale: sens / e } };
    }
    case 'mean': {
      const sens = Math.max(Math.abs(q.bounds![0]), Math.abs(q.bounds![1]));
      const s = rows.reduce<number>((a, row) => a + clamp(val(row) ?? q.bounds![0], q.bounds!), 0) + laplace(sens / (e / 2), u);
      const c = rows.length + laplace(1 / (e / 2), u);
      const mean = c >= 1 ? clamp(s / c, q.bounds!) : (q.bounds![0] + q.bounds![1]) / 2;
      return { op: 'mean', epsilon: e, value: r(mean, q.round), parts: { sum: r(s, q.round), count: r(c, q.round) }, noise: { mechanism: 'laplace', scale: { sum: (2 * sens) / e, count: 2 / e } } };
    }
    case 'histogram': {
      const edges = q.bins!;
      const counts = new Array<number>(edges.length - 1).fill(0);
      for (const row of rows) {
        const v = val(row);
        if (v === undefined) continue;
        const c = clamp(v, [edges[0]!, edges.at(-1)!]);
        let i = edges.findIndex((b, k) => k > 0 && c < b) - 1;
        if (i < 0) i = counts.length - 1;
        counts[i]!++;
      }
      return { op: 'histogram', epsilon: e, value: counts.map((n) => r(n + laplace(1 / e, u), q.round)), bins: edges, noise: { mechanism: 'laplace', scale: 1 / e } };
    }
  }
}

/** Combine noisy partial aggregates of disjoint datasets. */
export function combine(parts: Aggregate[], round = 2): Aggregate {
  const op = parts[0]!.op;
  if (parts.some((p) => p.op !== op)) throw new Error('cannot combine different operations');
  const eps = Math.max(...parts.map((p) => p.epsilon));
  if (op === 'count' || op === 'sum') return { op, epsilon: eps, value: r(parts.reduce((a, p) => a + (p.value as number), 0), round), noise: { mechanism: 'laplace', scale: parts.map((p) => p.noise.scale as number).reduce((a, b) => a + b, 0) } };
  if (op === 'histogram') {
    const len = (parts[0]!.value as number[]).length;
    if (parts.some((p) => (p.value as number[]).length !== len)) throw new Error('histograms have different bins');
    return { op, epsilon: eps, bins: parts[0]!.bins, value: Array.from({ length: len }, (_, i) => r(parts.reduce((a, p) => a + (p.value as number[])[i]!, 0), round)), noise: parts[0]!.noise };
  }
  const sum = parts.reduce((a, p) => a + (p.parts?.sum ?? 0), 0);
  const count = parts.reduce((a, p) => a + (p.parts?.count ?? 0), 0);
  return { op, epsilon: eps, value: r(count >= 1 ? sum / count : NaN, round), parts: { sum: r(sum, round), count: r(count, round) }, noise: parts[0]!.noise };
}

/** ε spent per subject in the current window. */
export class EpsilonLedger {
  private spent = new Map<string, Array<{ at: number; e: number }>>();
  used(subject: string, windowMs: number, now = Date.now()): number {
    const l = (this.spent.get(subject) ?? []).filter((x) => now - x.at < windowMs);
    this.spent.set(subject, l);
    return l.reduce((a, x) => a + x.e, 0);
  }
  /** Charge ε when it fits; false when the budget would be exceeded. */
  charge(subject: string, e: number, limit: number, windowMs: number, now = Date.now()): boolean {
    if (this.used(subject, windowMs, now) + e > limit + 1e-12) return false;
    this.spent.get(subject)!.push({ at: now, e });
    return true;
  }
  reset(): void {
    this.spent.clear();
  }
}
export const epsilonLedger = new EpsilonLedger();

export function privacyOf(cfg: GatewayConfig): Parsed | undefined {
  if (!cfg.privacy) return undefined;
  const p = PrivacySchema.parse(cfg.privacy);
  return p.enabled ? p : undefined;
}

const protectedTool = (c: Parsed, serverId: string, tool: string) => c.protect.some((g) => globToRegExp(g).test(`${serverId}/${tool}`));
/** Argument objects of calls made by the aggregator itself (allowed through `protect`). */
const internal = new WeakSet<object>();

registerCallHook({
  id: 'privacy',
  before: (call, cfg) => {
    const c = privacyOf(cfg);
    if (!c || !protectedTool(c, call.serverId, call.tool) || internal.has(call.args)) return;
    return { refuse: { code: ERR_PRIVACY_PROTECTED, message: `"${call.serverId}/${call.tool}" is privacy-protected: only differentially private aggregates are available (POST /api/v1/features/privacy/aggregate)`, data: { decision: 'privacy' } } };
  },
});

type Ctx = Parameters<Parameters<typeof registerFeature>[0]['mount']>[1];
type Res = import('express').Response;

async function runLocal(ctx: Ctx, req: import('express').Request, c: Parsed, target: { server: string; tool: string; arguments?: unknown }, q: Q): Promise<{ status: number; body: Record<string, unknown> }> {
  const scope = (req as AuthedRequest).scope;
  if (!isToolInScope(scope, target.server, target.tool)) return { status: 403, body: { error: 'Forbidden', message: `"${target.server}/${target.tool}" is outside this key's scope` } };
  const args = target.arguments && typeof target.arguments === 'object' && !Array.isArray(target.arguments) ? { ...(target.arguments as Record<string, unknown>) } : {};
  internal.add(args);
  const res = await ctx.invoke(target.server, target.tool, args, clientIdOf(req));
  if (!res.success) return { status: 502, body: { error: 'Tool Execution Failed', message: res.error?.message ?? 'failed', code: res.error?.code } };
  const v = stepValue(res.result);
  let json: unknown;
  if (typeof v.text === 'string') {
    try {
      json = JSON.parse(v.text);
    } catch {
      /* not JSON */
    }
  }
  const rows = readPath({ ...v, json }, q.rows);
  if (!Array.isArray(rows)) return { status: 422, body: { error: 'Unprocessable Entity', message: `"${q.rows}" in the tool result is not an array of rows` } };
  if (rows.length > c.maxRows) return { status: 422, body: { error: 'Unprocessable Entity', message: `more than ${c.maxRows} rows` } };
  return { status: 200, body: { server: target.server, tool: target.tool, ...dpAggregate(rows, q) } };
}

registerFeature({
  id: 'privacy',
  since: '10.8.0',
  summary: 'Privacy computing (EXPERIMENTAL): differentially private aggregates of tool results, federated queries, ε budgets',
  mount: (router, ctx) => {
    router.get('/', (_req, res) => {
      const c = privacyOf(ctx.config());
      if (!c) return badRequest(res, 'features.privacy is not configured');
      res.json({ experimental: true, protect: c.protect, maxEpsilonPerQuery: c.maxEpsilonPerQuery, budget: c.budget, peers: c.peers.map((p) => ({ id: p.id, url: p.url })) });
    });
    router.post('/reset-budgets', (_req, res) => {
      epsilonLedger.reset();
      res.json({ reset: true });
    });
  },
  mountClient: (router, ctx) => {
    const prep = (req: import('express').Request, res: Res, raw: unknown): { c: Parsed; q: Q; subject: string; windowMs: number } | undefined => {
      const c = privacyOf(ctx.config());
      if (!c) return void res.status(404).json({ error: 'Not Found', message: 'features.privacy is not configured' });
      const parsed = QuerySchema.safeParse(raw);
      if (!parsed.success) return void badRequest(res, parsed.error.issues.map((i) => i.message).join('; '));
      const q = parsed.data;
      if (q.epsilon > c.maxEpsilonPerQuery) return void badRequest(res, `epsilon ${q.epsilon} exceeds maxEpsilonPerQuery ${c.maxEpsilonPerQuery}`);
      const subject = clientIdOf(req) ?? 'anonymous';
      return { c, q, subject, windowMs: c.budget.windowSeconds * 1000 };
    };
    const charge = (res: Res, p: { c: Parsed; q: Q; subject: string; windowMs: number }) => {
      if (epsilonLedger.charge(p.subject, p.q.epsilon, p.c.budget.epsilon, p.windowMs)) return true;
      res.status(429).json({ error: 'Too Many Requests', message: `privacy budget exhausted for ${p.subject}: ${epsilonLedger.used(p.subject, p.windowMs).toFixed(3)} of ε=${p.c.budget.epsilon} spent in the window`, budget: { epsilon: p.c.budget.epsilon, spent: epsilonLedger.used(p.subject, p.windowMs), windowSeconds: p.c.budget.windowSeconds } });
      return false;
    };

    router.get('/budget', (req, res) => {
      const c = privacyOf(ctx.config());
      if (!c) return void res.status(404).json({ error: 'Not Found', message: 'features.privacy is not configured' });
      const subject = clientIdOf(req) ?? 'anonymous';
      const spent = epsilonLedger.used(subject, c.budget.windowSeconds * 1000);
      res.json({ subject, epsilon: c.budget.epsilon, spent, remaining: Math.max(0, c.budget.epsilon - spent), windowSeconds: c.budget.windowSeconds });
    });

    router.post('/aggregate', async (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      const { server, tool, arguments: args, ...query } = b as { server?: unknown; tool?: unknown; arguments?: unknown } & Record<string, unknown>;
      if (typeof server !== 'string' || typeof tool !== 'string') return badRequest(res, '"server" and "tool" are required');
      const p = prep(req, res, query);
      if (!p || !charge(res, p)) return;
      const out = await runLocal(ctx, req, p.c, { server, tool, arguments: args }, p.q);
      res.status(out.status).json({ ...out.body, ...(out.status === 200 ? { budget: { spent: epsilonLedger.used(p.subject, p.windowMs), epsilon: p.c.budget.epsilon } } : {}) });
    });

    router.post('/federated', async (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      if (!Array.isArray(b.targets) || !b.targets.length || b.targets.length > 50) return badRequest(res, '"targets" must be a non-empty array (max 50)');
      const p = prep(req, res, b.query);
      if (!p) return;
      const targets = b.targets as Array<{ peer?: unknown; server?: unknown; tool?: unknown; arguments?: unknown }>;
      if (!targets.every((t) => typeof t.server === 'string' && typeof t.tool === 'string' && (t.peer === undefined || typeof t.peer === 'string'))) return badRequest(res, 'each target needs "server" and "tool" (and optional "peer")');
      for (const t of targets) if (t.peer !== undefined && !p.c.peers.some((x) => x.id === t.peer)) return badRequest(res, `unknown peer "${String(t.peer)}"`);
      // Local targets share this gateway's data: each one is a separate query on it (sequential composition).
      const local = targets.filter((t) => t.peer === undefined).length;
      if (local > 0 && !epsilonLedger.charge(p.subject, p.q.epsilon * local, p.c.budget.epsilon, p.windowMs)) {
        return void res.status(429).json({ error: 'Too Many Requests', message: `privacy budget exhausted for ${p.subject} (needs ε=${p.q.epsilon * local})` });
      }
      const results = await Promise.all(
        targets.map(async (t) => {
          if (t.peer === undefined) return { target: `${t.server}/${t.tool}`, ...(await runLocal(ctx, req, p.c, { server: t.server as string, tool: t.tool as string, arguments: t.arguments }, p.q)) };
          const peer = p.c.peers.find((x) => x.id === t.peer)!;
          try {
            const r2 = await fetch(`${peer.url.replace(/\/$/, '')}/api/v1/features/privacy/aggregate`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...(peer.token ? { authorization: `Bearer ${peer.token}` } : {}) },
              body: JSON.stringify({ server: t.server, tool: t.tool, arguments: t.arguments ?? {}, ...(b.query as object) }),
              signal: AbortSignal.timeout(peer.timeoutMs),
            });
            return { target: `${peer.id}:${String(t.server)}/${String(t.tool)}`, status: r2.status, body: (await r2.json().catch(() => ({}))) as Record<string, unknown> };
          } catch (e) {
            return { target: `${peer.id}:${String(t.server)}/${String(t.tool)}`, status: 502, body: { error: 'Bad Gateway', message: (e as Error).message } };
          }
        }),
      );
      const okParts = results.filter((x) => x.status === 200).map((x) => x.body as unknown as Aggregate);
      const failed = results.filter((x) => x.status !== 200).map((x) => ({ target: x.target, status: x.status, message: x.body.message }));
      if (!okParts.length) return void res.status(502).json({ error: 'Bad Gateway', message: 'no domain answered', failed });
      res.json({ ...combine(okParts, p.q.round), domains: results.map((x) => ({ target: x.target, status: x.status })), ...(failed.length ? { partial: true, failed } : {}) });
    });
  },
});
