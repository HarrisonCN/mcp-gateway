/**
 * Tool versioning and gradual rollout (7.5): send a share of a tool's traffic to a new upstream version.
 *
 * A rollout names a **stable** server and a **canary** server (the new version, same tool names). Calls to the stable
 * server's matching tools go to the canary for `percent` % of callers (sticky per client: the same client always gets
 * the same version), for every client matching `clients`, and never for clients matching `exclude`. The canary's
 * error rate is watched: above `autoRollback.maxErrorRate` (after `minCalls` canary calls in the window) the rollout
 * is rolled back automatically.
 *
 * ```yaml
 * rollouts:
 *   - id: search-v2
 *     stable: search          # server id clients call
 *     canary: search-v2       # server id of the new version
 *     tools: ["*"]            # tool globs on the stable server (default all)
 *     percent: 10
 *     clients: ["key:beta-*"] # always canary
 *     autoRollback: { maxErrorRate: 0.2, minCalls: 20, window: 200 }
 * ```
 *
 * Results routed to the canary carry `_meta["mcp-gateway/rollout"]` (`id`, `version: canary`).
 *
 * - `GET  /admin/rollouts` — each rollout: effective percent, state (`active` | `promoted` | `rolled-back`), calls and
 *   error rates per version.
 * - `POST /admin/rollouts/:id/percent` `{ percent }`, `/promote` (100 %), `/rollback` (0 %), `/reset` (back to config).
 *   Runtime overrides; `?persist=true` also writes `percent` into the config (`controlPlane.configApi: true`).
 *
 * @module features/rollouts
 */

import { z } from 'zod';
import { registerFeature, objectBody, badRequest } from '../gateway/features.js';
import { registerCallHook } from '../gateway/hooks.js';
import { portableConfig, featureSection, withFeatureSection } from '../gateway/admin.js';
import { globToRegExp } from '../utils/tool-filter.js';
import { logger } from '../utils/logger.js';
import type { GatewayConfig } from '../utils/types.js';
import { RolloutSchema, type RolloutsConfig, RolloutsSchema } from './schemas/rollouts.js';
export { type RolloutsConfig, RolloutsSchema } from './schemas/rollouts.js';
type Rollout = z.output<typeof RolloutSchema>;

const fnv = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
};
/** Sticky bucket 0..99.99 for a client in a rollout. */
export const bucketOf = (rolloutId: string, client: string) => (fnv(`${rolloutId}\u0000${client}`) % 10_000) / 100;

interface Arm {
  calls: number;
  errors: number;
  recent: boolean[]; // true = error
}
interface State {
  override?: number;
  state: 'active' | 'promoted' | 'rolled-back';
  reason?: string;
  stable: Arm;
  canary: Arm;
}

export class RolloutManager {
  readonly states = new Map<string, State>();
  private st(id: string): State {
    let s = this.states.get(id);
    if (!s) this.states.set(id, (s = { state: 'active', stable: { calls: 0, errors: 0, recent: [] }, canary: { calls: 0, errors: 0, recent: [] } }));
    return s;
  }
  percent(r: Rollout): number {
    const s = this.st(r.id);
    return s.override ?? r.percent;
  }
  /** Version for a call by `client`. */
  pick(r: Rollout, client: string): 'stable' | 'canary' {
    if (r.exclude.some((p) => globToRegExp(p).test(client))) return 'stable';
    if (this.st(r.id).state === 'rolled-back') return 'stable';
    if (r.clients.some((p) => globToRegExp(p).test(client))) return 'canary';
    return bucketOf(r.id, client) < this.percent(r) ? 'canary' : 'stable';
  }
  record(r: Rollout, version: 'stable' | 'canary', error: boolean): void {
    const s = this.st(r.id);
    const arm = s[version];
    arm.calls++;
    if (error) arm.errors++;
    arm.recent.push(error);
    const win = r.autoRollback?.window ?? 200;
    if (arm.recent.length > win) arm.recent.splice(0, arm.recent.length - win);
    const ar = r.autoRollback;
    if (ar && version === 'canary' && s.state !== 'rolled-back' && arm.recent.length >= ar.minCalls) {
      const rate = arm.recent.filter(Boolean).length / arm.recent.length;
      if (rate > ar.maxErrorRate) {
        s.state = 'rolled-back';
        s.override = 0;
        s.reason = `canary error rate ${(rate * 100).toFixed(1)}% > ${(ar.maxErrorRate * 100).toFixed(1)}% over ${arm.recent.length} calls`;
        logger.warn(`Rollout ${r.id}: rolled back automatically (${s.reason})`);
      }
    }
  }
  set(id: string, percent: number, state: State['state'], reason?: string): void {
    const s = this.st(id);
    s.override = percent;
    s.state = state;
    s.reason = reason;
    for (const arm of [s.stable, s.canary]) arm.recent = [];
  }
  reset(id: string): void {
    const s = this.st(id);
    delete s.override;
    delete s.reason;
    s.state = 'active';
    for (const arm of [s.stable, s.canary]) arm.recent = [];
  }
  view(r: Rollout) {
    const s = this.st(r.id);
    const arm = (a: Arm) => ({ calls: a.calls, errors: a.errors, errorRate: a.calls ? Math.round((a.errors / a.calls) * 1000) / 1000 : 0, windowErrorRate: a.recent.length ? Math.round((a.recent.filter(Boolean).length / a.recent.length) * 1000) / 1000 : 0 });
    return { ...r, configuredPercent: r.percent, percent: this.percent(r), state: s.state, ...(s.reason ? { reason: s.reason } : {}), versions: { stable: arm(s.stable), canary: arm(s.canary) } };
  }
}

export const rolloutManager = new RolloutManager();
const list = (cfg: GatewayConfig): Rollout[] => (cfg.rollouts ? RolloutsSchema.parse(cfg.rollouts) : []);
const MARK = 'mcp-gateway/rollout';

registerCallHook({
  id: 'rollouts',
  before: (call, cfg) => {
    const r = list(cfg).find((x) => x.stable === call.serverId && x.tools.some((p) => globToRegExp(p).test(call.tool)));
    if (!r) return;
    if (rolloutManager.pick(r, call.clientId ?? 'anonymous') === 'canary') return { serverId: r.canary };
  },
  after: (call, result, cfg) => {
    const rs = list(cfg);
    const canary = rs.find((x) => x.canary === call.serverId && x.tools.some((p) => globToRegExp(p).test(call.tool)));
    const stable = canary ? undefined : rs.find((x) => x.stable === call.serverId && x.tools.some((p) => globToRegExp(p).test(call.tool)));
    const r = canary ?? stable;
    if (!r) return;
    const isError = !result.success || (result.result as { isError?: boolean } | undefined)?.isError === true;
    rolloutManager.record(r, canary ? 'canary' : 'stable', isError);
    if (canary && result.success && result.result && typeof result.result === 'object' && !Array.isArray(result.result)) {
      const o = result.result as Record<string, unknown>;
      return { ...result, result: { ...o, _meta: { ...((o._meta as object) ?? {}), [MARK]: { id: r.id, version: 'canary', server: r.canary } } } };
    }
  },
});

registerFeature({
  id: 'rollouts',
  since: '7.5.0',
  summary: 'Tool versioning and gradual rollout: sticky percentage canaries per server with automatic rollback',
  mount: (router, ctx) => {
    const find = (id: string) => list(ctx.config()).find((r) => r.id === id);
    router.get('/', (_req, res) => {
      res.json({ rollouts: list(ctx.config()).map((r) => rolloutManager.view(r)) });
    });
    router.get('/:id', (req, res) => {
      const r = find(req.params.id!);
      if (!r) return void res.status(404).json({ error: 'Not Found', message: `No rollout "${req.params.id}"` });
      res.json(rolloutManager.view(r));
    });
    const action = (name: 'percent' | 'promote' | 'rollback' | 'reset') =>
      router.post(`/:id/${name}`, async (req, res) => {
        const r = find(req.params.id!);
        if (!r) return void res.status(404).json({ error: 'Not Found', message: `No rollout "${req.params.id}"` });
        let percent: number | undefined;
        if (name === 'percent') {
          const b = objectBody(req, res);
          if (!b) return;
          if (typeof b.percent !== 'number' || b.percent < 0 || b.percent > 100) return badRequest(res, 'Body must be { "percent": 0..100 }');
          percent = b.percent;
          rolloutManager.set(r.id, percent, 'active', 'set over the admin API');
        } else if (name === 'promote') rolloutManager.set(r.id, (percent = 100), 'promoted', 'promoted over the admin API');
        else if (name === 'rollback') rolloutManager.set(r.id, (percent = 0), 'rolled-back', 'rolled back over the admin API');
        else rolloutManager.reset(r.id);
        if (req.query.persist === 'true' && percent !== undefined) {
          if (ctx.config().controlPlane?.configApi !== true || !ctx.applyConfig) return void res.status(403).json({ error: 'Forbidden', message: 'persist=true needs controlPlane.configApi: true' });
          const p = portableConfig(ctx.config());
          const next = ((featureSection(p, 'rollouts') as Array<Record<string, unknown>>) ?? []).map((x) => (x.id === r.id ? { ...x, percent } : x));
          try {
            await ctx.applyConfig(withFeatureSection(p, 'rollouts', next));
          } catch (err) {
            return badRequest(res, err instanceof Error ? err.message : String(err));
          }
        }
        res.json(rolloutManager.view(find(r.id)!));
      });
    action('percent');
    action('promote');
    action('rollback');
    action('reset');
  },
});
