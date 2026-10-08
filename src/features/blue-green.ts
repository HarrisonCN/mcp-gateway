/**
 * Zero-downtime blue/green upgrades (8.5): run the old (blue) and new (green) version of an upstream side by side and
 * switch **all** traffic atomically once the idle colour passes its health probe — with in-flight draining,
 * post-switch verification and one-call rollback. (Gradual percentage shifts are `rollouts`, 7.5.)
 *
 * ```yaml
 * blueGreen:
 *   - id: search
 *     blue: search-v1            # server id clients call (the stable name)
 *     green: search-v2           # the new version, deployed alongside
 *     active: blue               # colour serving traffic at start
 *     probe: { tool: health, arguments: {} }   # must succeed on the target before a switch
 *     verify: { seconds: 120, maxErrorRate: 0.1, minCalls: 10 }   # auto-rollback window after a switch
 * ```
 *
 * Clients keep calling `blue`'s server id; when green is active, calls are routed to `green`. Calls already running
 * on the previous colour finish there (drain); `GET /admin/blue-green` shows in-flight calls per colour.
 *
 * - `GET  /admin/blue-green` — deployments: active colour, in-flight, calls / errors per colour, verification state,
 *   history.
 * - `POST /admin/blue-green/:id/switch` `{ to?: "blue" | "green", force? }` — probe the target, then switch
 *   (409 when the probe fails, unless `force`).
 * - `POST /admin/blue-green/:id/rollback` — switch back to the previous colour immediately (no probe).
 *
 * During `verify.seconds` after a switch, an error rate above `maxErrorRate` (after `minCalls` calls) rolls back
 * automatically.
 *
 * @module features/blue-green
 */

import { z } from 'zod';
import { registerFeature, objectBody, badRequest } from '../gateway/features.js';
import { registerCallHook } from '../gateway/hooks.js';
import { globToRegExp } from '../utils/tool-filter.js';
import { logger } from '../utils/logger.js';
import type { GatewayConfig } from '../utils/types.js';

const Color = z.enum(['blue', 'green']);
type Color = z.infer<typeof Color>;

const Deployment = z
  .object({
    id: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/),
    blue: z.string().min(1),
    green: z.string().min(1),
    active: Color.default('blue'),
    tools: z.array(z.string().min(1)).default(['*']),
    probe: z.object({ tool: z.string().min(1), arguments: z.record(z.unknown()).default({}) }).strict().optional(),
    verify: z.object({ seconds: z.number().int().min(0).max(86_400).default(120), maxErrorRate: z.number().min(0).max(1).default(0.1), minCalls: z.number().int().min(1).default(10) }).strict().default({}),
  })
  .strict()
  .refine((d) => d.blue !== d.green, { message: '`blue` and `green` must be different servers' });

export const BlueGreenSchema = z.array(Deployment).superRefine((ds, ctx) => {
  const ids = new Set<string>();
  const blues = new Set<string>();
  ds.forEach((d, i) => {
    if (ids.has(d.id)) ctx.addIssue({ code: 'custom', path: [i, 'id'], message: `duplicate blue/green id "${d.id}"` });
    if (blues.has(d.blue)) ctx.addIssue({ code: 'custom', path: [i, 'blue'], message: `server "${d.blue}" is already the blue side of another deployment` });
    ids.add(d.id);
    blues.add(d.blue);
  });
});
export type BlueGreenConfig = z.input<typeof BlueGreenSchema>;
type Dep = z.output<typeof Deployment>;

interface Runtime {
  active?: Color;
  inFlight: Record<Color, number>;
  calls: Record<Color, number>;
  errors: Record<Color, number>;
  verify?: { color: Color; previous: Color; until: number; calls: number; errors: number };
  history: Array<{ at: string; from: Color; to: Color; reason: string }>;
}

/** Runtime state per deployment id; exported for tests. */
export const blueGreenState = {
  deps: new Map<string, Runtime>(),
  pending: new WeakMap<object, { id: string; color: Color }>(),
  reset() {
    this.deps.clear();
  },
};

const deployments = (cfg: GatewayConfig): Dep[] => (cfg.blueGreen ? BlueGreenSchema.parse(cfg.blueGreen) : []);
const rt = (d: Dep): Runtime => {
  let r = blueGreenState.deps.get(d.id);
  if (!r) {
    r = { inFlight: { blue: 0, green: 0 }, calls: { blue: 0, green: 0 }, errors: { blue: 0, green: 0 }, history: [] };
    blueGreenState.deps.set(d.id, r);
  }
  return r;
};
export const activeColor = (d: Dep): Color => blueGreenState.deps.get(d.id)?.active ?? d.active;
const other = (c: Color): Color => (c === 'blue' ? 'green' : 'blue');
const serverOf = (d: Dep, c: Color) => (c === 'blue' ? d.blue : d.green);

function switchTo(d: Dep, to: Color, reason: string, verify = true): void {
  const r = rt(d);
  const from = activeColor(d);
  if (from === to) return;
  r.active = to;
  r.history.push({ at: new Date().toISOString(), from, to, reason });
  if (r.history.length > 50) r.history.splice(0, r.history.length - 50);
  r.verify = verify && d.verify.seconds > 0 ? { color: to, previous: from, until: Date.now() + d.verify.seconds * 1000, calls: 0, errors: 0 } : undefined;
  logger.info(`blue/green "${d.id}": ${from} → ${to} (${reason})`);
}

registerCallHook({
  id: 'blue-green',
  before(call, cfg) {
    for (const d of deployments(cfg)) {
      if (call.serverId !== d.blue || !d.tools.some((g) => globToRegExp(g).test(call.tool))) continue;
      const color = activeColor(d);
      const r = rt(d);
      r.inFlight[color]++;
      // Keyed by the arguments object (unchanged, so the after hook sees the same one and other hooks keep theirs).
      blueGreenState.pending.set(call.args, { id: d.id, color });
      return color === 'green' ? { serverId: d.green } : undefined;
    }
  },
  after(call, result, cfg) {
    const p = blueGreenState.pending.get(call.args);
    if (!p) return;
    blueGreenState.pending.delete(call.args);
    const d = deployments(cfg).find((x) => x.id === p.id);
    const r = blueGreenState.deps.get(p.id);
    if (!r) return;
    r.inFlight[p.color] = Math.max(0, r.inFlight[p.color] - 1);
    r.calls[p.color]++;
    if (!result.success) r.errors[p.color]++;
    const v = r.verify;
    if (!d || !v || v.color !== p.color) return;
    if (Date.now() > v.until) {
      r.verify = undefined;
      return;
    }
    v.calls++;
    if (!result.success) v.errors++;
    if (v.calls >= d.verify.minCalls && v.errors / v.calls > d.verify.maxErrorRate) {
      switchTo(d, v.previous, `auto-rollback: ${v.errors}/${v.calls} errors after switching to ${v.color}`, false);
    }
  },
});

registerFeature({
  id: 'blue-green',
  since: '8.5.0',
  summary: 'Zero-downtime blue/green upgrades: probed atomic switch, in-flight drain, verification window with auto-rollback',
  mount(router, ctx) {
    const find = (id: string) => deployments(ctx.config()).find((d) => d.id === id);
    router.get('/', (_req, res) => {
      const now = Date.now();
      res.json({
        deployments: deployments(ctx.config()).map((d) => {
          const r = rt(d);
          return {
            id: d.id,
            blue: d.blue,
            green: d.green,
            active: activeColor(d),
            activeServer: serverOf(d, activeColor(d)),
            tools: d.tools,
            inFlight: r.inFlight,
            calls: r.calls,
            errors: r.errors,
            verifying: r.verify && r.verify.until > now ? { color: r.verify.color, remainingSeconds: Math.ceil((r.verify.until - now) / 1000), calls: r.verify.calls, errors: r.verify.errors } : null,
            history: r.history.slice().reverse(),
          };
        }),
      });
    });
    router.post('/:id/switch', async (req, res) => {
      const d = find(String(req.params.id));
      if (!d) return void res.status(404).json({ error: 'Not Found', message: `no blue/green deployment "${req.params.id}"` });
      const b = objectBody(req, res);
      if (!b) return;
      if (b.to !== undefined && b.to !== 'blue' && b.to !== 'green') return badRequest(res, '"to" must be "blue" or "green"');
      const to = (b.to as Color | undefined) ?? other(activeColor(d));
      if (to === activeColor(d)) return void res.json({ id: d.id, active: to, changed: false });
      let probe: { ok: boolean; error?: unknown } | undefined;
      if (d.probe) {
        const r = await ctx.invoke(serverOf(d, to), d.probe.tool, d.probe.arguments, 'blue-green');
        probe = r.success ? { ok: true } : { ok: false, error: r.error };
        if (!r.success && b.force !== true) return void res.status(409).json({ error: 'Conflict', message: `probe "${d.probe.tool}" failed on ${to} (${serverOf(d, to)}); not switching`, probe });
      }
      switchTo(d, to, b.force === true && probe && !probe.ok ? 'forced switch (probe failed)' : 'manual switch');
      res.json({ id: d.id, active: to, activeServer: serverOf(d, to), changed: true, probe, drainingInFlight: rt(d).inFlight[other(to)] });
    });
    router.post('/:id/rollback', (req, res) => {
      const d = find(String(req.params.id));
      if (!d) return void res.status(404).json({ error: 'Not Found', message: `no blue/green deployment "${req.params.id}"` });
      const r = rt(d);
      const last = r.history[r.history.length - 1];
      const to = last ? last.from : other(activeColor(d));
      switchTo(d, to, 'manual rollback', false);
      res.json({ id: d.id, active: activeColor(d), activeServer: serverOf(d, activeColor(d)) });
    });
  },
});
