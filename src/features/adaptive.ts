/**
 * Adaptive routing 2.0 (5.8): pick the upstream (and model) for a job by quality, cost and latency, and learn.
 *
 * A **pool** groups interchangeable candidates — the same tool on several servers, or one LLM tool with several
 * models. Each candidate has a price; the gateway learns its **latency** and **error rate** from real traffic (every
 * call to `server/tool` updates its candidate) and its **quality** from feedback (`0..1`, e.g. from an eval or a
 * thumbs-up). Picking uses Thompson sampling over a Beta posterior of quality, so new or uncertain candidates still
 * get explored while proven ones take most traffic, combined with the pool's objective weights:
 *
 *   score = quality·w.quality − normCost·w.cost − normLatency·w.latency
 *
 * ```yaml
 * adaptive:
 *   pools:
 *     - id: summarize
 *       objective: { quality: 0.6, cost: 0.3, latency: 0.1 }
 *       maxCostPerCall: 0.02            # never pick candidates above this price
 *       candidates:
 *         - { id: small, server: llm, tool: complete, args: { model: gpt-mini }, costPerCall: 0.001 }
 *         - { id: large, server: llm, tool: complete, args: { model: gpt-large }, costPerCall: 0.015 }
 * ```
 *
 * - `GET  /admin/adaptive` — pools with per-candidate stats (calls, error rate, latency EWMA, quality mean, picks).
 * - `POST /admin/adaptive/pick` — `{ pool, explore?: boolean }` → `{ candidate, server, tool, args, scores }`.
 * - `POST /admin/adaptive/call` — `{ pool, arguments }` → picks and calls (candidate `args` merged under the caller's).
 * - `POST /admin/adaptive/feedback` — `{ pool, candidate, quality }`.
 *
 * @module features/adaptive
 */

import { z } from 'zod';
import { registerFeature, objectBody, badRequest, principalOf } from '../gateway/features.js';
import { registerCallHook } from '../gateway/hooks.js';
import type { GatewayConfig } from '../utils/types.js';

const Candidate = z
  .object({ id: z.string().min(1), server: z.string().min(1), tool: z.string().min(1), args: z.record(z.unknown()).default({}), costPerCall: z.number().min(0).default(0) })
  .strict();
const Pool = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
    objective: z.object({ quality: z.number().min(0).default(0.6), cost: z.number().min(0).default(0.3), latency: z.number().min(0).default(0.1) }).strict().default({}),
    maxCostPerCall: z.number().min(0).optional(),
    candidates: z.array(Candidate).min(1),
  })
  .strict();
export const AdaptiveSchema = z.object({ pools: z.array(Pool).default([]) }).strict();
export type AdaptiveConfig = z.input<typeof AdaptiveSchema>;
type PoolCfg = z.output<typeof Pool>;

export interface CandidateStats {
  calls: number;
  errors: number;
  latencyMs: number; // EWMA
  /** Beta posterior of quality: alpha = 1 + Σq, beta = 1 + Σ(1−q). */
  alpha: number;
  beta: number;
  picks: number;
}

const fresh = (): CandidateStats => ({ calls: 0, errors: 0, latencyMs: 0, alpha: 1, beta: 1, picks: 0 });

/** Sample Beta(a, b) via two Gamma draws (Marsaglia–Tsang). */
export function sampleBeta(a: number, b: number, rnd: () => number): number {
  const gamma = (k: number): number => {
    if (k < 1) return gamma(k + 1) * Math.pow(rnd() || 1e-12, 1 / k);
    const d = k - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number;
      let v: number;
      do {
        // Box–Muller normal
        const u1 = rnd() || 1e-12;
        x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rnd());
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = rnd() || 1e-12;
      if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
    }
  };
  const x = gamma(a);
  const y = gamma(b);
  return x / (x + y);
}

export interface Scored {
  id: string;
  quality: number;
  normCost: number;
  normLatency: number;
  errorRate: number;
  score: number;
}

export class AdaptiveRouter {
  readonly stats = new Map<string, CandidateStats>(); // key: pool/candidate

  constructor(private readonly rnd: () => number = Math.random) {}

  private key(pool: string, cand: string): string {
    return `${pool}/${cand}`;
  }

  get(pool: string, cand: string): CandidateStats {
    const k = this.key(pool, cand);
    let s = this.stats.get(k);
    if (!s) this.stats.set(k, (s = fresh()));
    return s;
  }

  /** Record a real call outcome (latency EWMA α = 0.2). */
  observe(pool: string, cand: string, ok: boolean, latencyMs: number): void {
    const s = this.get(pool, cand);
    s.calls++;
    if (!ok) s.errors++;
    s.latencyMs = s.calls === 1 ? latencyMs : s.latencyMs * 0.8 + latencyMs * 0.2;
  }

  feedback(pool: string, cand: string, quality: number): void {
    const q = Math.max(0, Math.min(1, quality));
    const s = this.get(pool, cand);
    s.alpha += q;
    s.beta += 1 - q;
  }

  /** Score every eligible candidate; `explore` samples quality, otherwise uses the posterior mean. */
  score(pool: PoolCfg, explore = true): Scored[] {
    const eligible = pool.candidates.filter((c) => pool.maxCostPerCall === undefined || c.costPerCall <= pool.maxCostPerCall);
    const maxCost = Math.max(0, ...eligible.map((c) => c.costPerCall));
    const lat = eligible.map((c) => this.get(pool.id, c.id).latencyMs);
    const maxLat = Math.max(0, ...lat);
    return eligible.map((c) => {
      const s = this.get(pool.id, c.id);
      const errorRate = s.calls ? s.errors / s.calls : 0;
      const q = (explore ? sampleBeta(s.alpha, s.beta, this.rnd) : s.alpha / (s.alpha + s.beta)) * (1 - errorRate);
      const normCost = maxCost ? c.costPerCall / maxCost : 0;
      const normLatency = maxLat ? s.latencyMs / maxLat : 0;
      const w = pool.objective;
      return { id: c.id, quality: q, normCost, normLatency, errorRate, score: q * w.quality - normCost * w.cost - normLatency * w.latency };
    });
  }

  pick(pool: PoolCfg, explore = true): { candidate: PoolCfg['candidates'][number]; scores: Scored[] } | undefined {
    const scores = this.score(pool, explore);
    if (!scores.length) return undefined;
    const best = scores.reduce((a, b) => (b.score > a.score ? b : a));
    this.get(pool.id, best.id).picks++;
    return { candidate: pool.candidates.find((c) => c.id === best.id)!, scores };
  }
}

/** Process-wide router (stats survive config reloads). */
export const adaptiveRouter = new AdaptiveRouter();

const pools = (cfg: GatewayConfig): PoolCfg[] => (cfg.adaptive ? AdaptiveSchema.parse(cfg.adaptive).pools : []);

// Learn latency / errors from every call that matches a candidate's server + tool.
registerCallHook({
  id: 'adaptive',
  after: (call, result, cfg) => {
    for (const p of pools(cfg)) for (const c of p.candidates) if (c.server === call.serverId && c.tool === call.tool) adaptiveRouter.observe(p.id, c.id, result.success, result.durationMs);
  },
});

registerFeature({
  id: 'adaptive',
  since: '5.8.0',
  summary: 'Adaptive routing 2.0: pick upstream / model by quality, cost and latency (Thompson sampling)',
  mount: (router, ctx) => {
    const find = (res: import('express').Response, id: unknown) => {
      const p = pools(ctx.config()).find((x) => x.id === id);
      if (!p) res.status(404).json({ error: 'Not Found', message: `no adaptive pool "${String(id)}"` });
      return p;
    };
    router.get('/', (_req, res) => {
      res.json({
        pools: pools(ctx.config()).map((p) => ({
          id: p.id,
          objective: p.objective,
          maxCostPerCall: p.maxCostPerCall,
          candidates: p.candidates.map((c) => {
            const s = adaptiveRouter.get(p.id, c.id);
            return { id: c.id, server: c.server, tool: c.tool, costPerCall: c.costPerCall, calls: s.calls, errorRate: s.calls ? s.errors / s.calls : 0, latencyMs: Math.round(s.latencyMs), quality: s.alpha / (s.alpha + s.beta), feedback: Math.round(s.alpha + s.beta - 2), picks: s.picks };
          }),
        })),
      });
    });
    router.post('/pick', (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      const p = find(res, b.pool);
      if (!p) return;
      const r = adaptiveRouter.pick(p, b.explore !== false);
      if (!r) return void res.status(422).json({ error: 'Unprocessable Entity', message: 'no candidate within maxCostPerCall' });
      res.json({ pool: p.id, candidate: r.candidate.id, server: r.candidate.server, tool: r.candidate.tool, args: r.candidate.args, scores: r.scores });
    });
    router.post('/call', async (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      const p = find(res, b.pool);
      if (!p) return;
      if (b.arguments !== undefined && (typeof b.arguments !== 'object' || b.arguments === null || Array.isArray(b.arguments))) return badRequest(res, '"arguments" must be an object');
      const r = adaptiveRouter.pick(p, true);
      if (!r) return void res.status(422).json({ error: 'Unprocessable Entity', message: 'no candidate within maxCostPerCall' });
      const out = await ctx.invoke(r.candidate.server, r.candidate.tool, { ...r.candidate.args, ...((b.arguments as Record<string, unknown>) ?? {}) }, principalOf(req), `adaptive:${p.id}`);
      res.status(out.success ? 200 : 502).json({ pool: p.id, candidate: r.candidate.id, costPerCall: r.candidate.costPerCall, ...out });
    });
    router.post('/feedback', (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      const p = find(res, b.pool);
      if (!p) return;
      if (!p.candidates.some((c) => c.id === b.candidate)) return badRequest(res, `unknown candidate "${String(b.candidate)}"`);
      if (typeof b.quality !== 'number' || !(b.quality >= 0 && b.quality <= 1)) return badRequest(res, '"quality" must be a number in 0..1');
      adaptiveRouter.feedback(p.id, String(b.candidate), b.quality);
      const s = adaptiveRouter.get(p.id, String(b.candidate));
      res.json({ pool: p.id, candidate: b.candidate, quality: s.alpha / (s.alpha + s.beta) });
    });
  },
});
