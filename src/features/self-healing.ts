/**
 * Self-healing (9.6): watch every upstream's error rate and latency and act on its own — eject a failing server (or
 * fail over to a backup), roll a bad version back to the stable one, or throttle an overloaded upstream — then lift
 * the action again after a cool-down.
 *
 * ```yaml
 * selfHealing:
 *   windowSeconds: 60          # sliding window per server
 *   minCalls: 20               # don't judge on fewer calls
 *   rules:
 *     - id: search-down
 *       servers: ["search"]
 *       when: { errorRateAbove: 0.5 }
 *       action: eject           # eject | rollback | throttle
 *       fallback: search-backup # eject: route here instead of refusing
 *       cooldownSeconds: 120
 *     - id: search-v2-bad
 *       servers: ["search-v2"]
 *       when: { errorRateAbove: 0.1, p95Above: 1500 }   # any condition trips the rule
 *       action: rollback
 *       rollbackTo: search
 *       cooldownSeconds: 900
 *     - id: github-slow
 *       servers: ["github"]
 *       when: { p95Above: 3000 }
 *       action: throttle
 *       maxPerSecond: 5
 *       cooldownSeconds: 60
 * ```
 *
 * While a rule is active: `eject` refuses calls to the server with JSON-RPC **-32025** (`ERR_SELF_HEALING`) or
 * routes them to `fallback`; `rollback` routes them to `rollbackTo`; `throttle` lets `maxPerSecond` calls through
 * and refuses the rest with -32025. After `cooldownSeconds` the action is lifted and the window starts fresh; if the
 * server is still unhealthy the rule trips again.
 *
 * - `GET /admin/self-healing` — rules, active actions, per-server window stats, recent actions.
 * - `POST /admin/self-healing/:id/trigger` `{ server }` · `POST /admin/self-healing/:id/clear` `{ server? }`.
 *
 * @module features/self-healing
 */

import { z } from 'zod';
import { registerFeature, objectBody, badRequest } from '../gateway/features.js';
import { registerCallHook } from '../gateway/hooks.js';
import { globToRegExp } from '../utils/tool-filter.js';
import { logger } from '../utils/logger.js';
import type { GatewayConfig } from '../utils/types.js';
import { ERR_SELF_HEALING, Rule, SelfHealingConfig, SelfHealingSchema } from './schemas/self-healing.js';
export { ERR_SELF_HEALING, SelfHealingConfig, SelfHealingSchema } from './schemas/self-healing.js';
type R = z.output<typeof Rule>;

interface Active {
  rule: string;
  server: string;
  action: R['action'];
  since: number;
  until: number;
  reason: string;
  refused: number;
  rerouted: number;
  tokens: { second: number; used: number };
}

/** Runtime state; exported for tests. */
export const selfHealingState = {
  samples: new Map<string, Array<{ at: number; ok: boolean; ms: number }>>(),
  active: new Map<string, Active>(),
  history: [] as Array<{ at: string; rule: string; server: string; action: string; event: 'triggered' | 'lifted' | 'cleared'; reason: string }>,
  pending: new WeakMap<object, string>(),
  reset() {
    this.samples.clear();
    this.active.clear();
    this.history = [];
  },
};

const settings = (cfg: GatewayConfig) => {
  if (!cfg.selfHealing) return undefined;
  const c = SelfHealingSchema.parse(cfg.selfHealing);
  return c.enabled ? c : undefined;
};
const glob = (gs: string[], s: string) => gs.some((g) => globToRegExp(g).test(s));
const key = (rule: string, server: string) => `${rule}\u0000${server}`;
const note = (a: Pick<Active, 'rule' | 'server' | 'action'>, event: 'triggered' | 'lifted' | 'cleared', reason: string) => {
  selfHealingState.history.unshift({ at: new Date().toISOString(), rule: a.rule, server: a.server, action: a.action, event, reason });
  selfHealingState.history.length = Math.min(selfHealingState.history.length, 100);
  (event === 'triggered' ? logger.warn : logger.info).call(logger, `self-healing: ${a.action} ${a.server} ${event} (rule "${a.rule}": ${reason})`);
};

/** Window stats of a server. */
export function windowStats(server: string, windowSeconds: number, now = Date.now()) {
  const list = (selfHealingState.samples.get(server) ?? []).filter((s) => s.at > now - windowSeconds * 1000);
  selfHealingState.samples.set(server, list);
  const ms = list.map((s) => s.ms).sort((a, b) => a - b);
  const errors = list.filter((s) => !s.ok).length;
  return { calls: list.length, errors, errorRate: list.length ? errors / list.length : 0, p95: ms.length ? ms[Math.min(ms.length - 1, Math.floor(0.95 * ms.length))] : 0 };
}

export function trigger(r: R, server: string, reason: string, now = Date.now()): Active {
  const a: Active = { rule: r.id, server, action: r.action, since: now, until: now + r.cooldownSeconds * 1000, reason, refused: 0, rerouted: 0, tokens: { second: 0, used: 0 } };
  selfHealingState.active.set(key(r.id, server), a);
  note(a, 'triggered', reason);
  return a;
}

function current(r: R, server: string, now = Date.now()): Active | undefined {
  const a = selfHealingState.active.get(key(r.id, server));
  if (!a) return undefined;
  if (now >= a.until) {
    selfHealingState.active.delete(key(r.id, server));
    selfHealingState.samples.delete(server);
    note(a, 'lifted', 'cool-down elapsed');
    return undefined;
  }
  return a;
}

/** Record a call outcome for a server and trip rules (exported for tests). */
export function observe(cfg: GatewayConfig, server: string, ok: boolean, ms: number, now = Date.now()): void {
  const s = settings(cfg);
  if (!s) return;
  const rules = s.rules.filter((r) => glob(r.servers, server));
  if (!rules.length) return;
  for (const r of rules) current(r, server, now); // lift expired actions first (fresh window)
  const list = selfHealingState.samples.get(server) ?? [];
  list.push({ at: now, ok, ms });
  if (list.length > 10_000) list.shift();
  selfHealingState.samples.set(server, list);
  const st = windowStats(server, s.windowSeconds, now);
  if (st.calls < s.minCalls) return;
  for (const r of rules) {
    if (current(r, server, now)) continue;
    const why: string[] = [];
    if (r.when.errorRateAbove !== undefined && st.errorRate > r.when.errorRateAbove) why.push(`error rate ${st.errorRate.toFixed(2)} > ${r.when.errorRateAbove}`);
    if (r.when.p95Above !== undefined && st.p95 > r.when.p95Above) why.push(`p95 ${st.p95}ms > ${r.when.p95Above}ms`);
    if (why.length) trigger(r, server, `${why.join(', ')} over ${st.calls} calls`, now);
  }
}

registerCallHook({
  id: 'self-healing',
  before(call, cfg) {
    const s = settings(cfg);
    if (!s) return;
    const now = Date.now();
    for (const r of s.rules) {
      if (!glob(r.servers, call.serverId)) continue;
      const a = current(r, call.serverId, now);
      if (!a) continue;
      const refuse = (why: string) => {
        a.refused++;
        return { refuse: { code: ERR_SELF_HEALING, message: `self-healing: ${why} (rule "${r.id}": ${a.reason})`, data: { rule: r.id, server: call.serverId, action: a.action, retryAfterSeconds: Math.ceil((a.until - now) / 1000) } } };
      };
      if (a.action === 'throttle') {
        const sec = Math.floor(now / 1000);
        if (a.tokens.second !== sec) a.tokens = { second: sec, used: 0 };
        if (++a.tokens.used > r.maxPerSecond!) return refuse(`"${call.serverId}" is throttled to ${r.maxPerSecond}/s`);
        continue;
      }
      const to = a.action === 'rollback' ? r.rollbackTo : r.fallback;
      if (to && to !== call.serverId) {
        a.rerouted++;
        return { serverId: to };
      }
      return refuse(`"${call.serverId}" is ejected`);
    }
    selfHealingState.pending.set(call.args, call.serverId);
  },
  after(call, result, cfg) {
    const server = selfHealingState.pending.get(call.args);
    if (server === undefined) return;
    selfHealingState.pending.delete(call.args);
    observe(cfg, server, result.success, result.durationMs);
  },
});

registerFeature({
  id: 'self-healing',
  since: '9.6.0',
  summary: 'Self-healing: eject / fail over, roll back or throttle unhealthy upstreams automatically, lifted after a cool-down',
  mount(router, ctx) {
    const find = (id: string) => settings(ctx.config())?.rules.find((r) => r.id === id);
    router.get('/', (_req, res) => {
      const s = settings(ctx.config());
      const now = Date.now();
      const active = [];
      for (const r of s?.rules ?? []) for (const a of selfHealingState.active.values()) if (a.rule === r.id && current(r, a.server, now)) active.push({ rule: a.rule, server: a.server, action: a.action, reason: a.reason, since: new Date(a.since).toISOString(), until: new Date(a.until).toISOString(), refused: a.refused, rerouted: a.rerouted, to: a.action === 'rollback' ? r.rollbackTo : a.action === 'eject' ? (r.fallback ?? null) : null });
      res.json({
        enabled: !!s,
        windowSeconds: s?.windowSeconds ?? null,
        rules: s?.rules ?? [],
        active,
        servers: [...selfHealingState.samples.keys()].map((id) => ({ id, ...windowStats(id, s?.windowSeconds ?? 60, now) })),
        history: selfHealingState.history.slice(0, 50),
      });
    });
    router.post('/:id/trigger', (req, res) => {
      const r = find(String(req.params.id));
      if (!r) return void res.status(404).json({ error: 'Not Found', message: `no self-healing rule "${req.params.id}"` });
      const b = objectBody(req, res);
      if (!b) return;
      if (typeof b.server !== 'string' || !glob(r.servers, b.server)) return badRequest(res, `"server" must be a server matched by rule "${r.id}"`);
      const a = trigger(r, b.server, 'triggered by an operator');
      res.json({ rule: r.id, server: a.server, action: a.action, until: new Date(a.until).toISOString() });
    });
    router.post('/:id/clear', (req, res) => {
      const r = find(String(req.params.id));
      if (!r) return void res.status(404).json({ error: 'Not Found', message: `no self-healing rule "${req.params.id}"` });
      const b = (req.body && typeof req.body === 'object' ? req.body : {}) as { server?: unknown };
      const cleared: string[] = [];
      for (const [k, a] of selfHealingState.active) {
        if (a.rule !== r.id || (typeof b.server === 'string' && a.server !== b.server)) continue;
        selfHealingState.active.delete(k);
        selfHealingState.samples.delete(a.server);
        note(a, 'cleared', 'cleared by an operator');
        cleared.push(a.server);
      }
      res.json({ rule: r.id, cleared });
    });
  },
});
