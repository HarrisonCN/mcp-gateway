/**
 * Chaos testing (8.8): inject latency, errors, timeouts and broken results into selected tool calls — on a schedule or
 * on demand — to prove that retries, failover (federation, blue/green, rollouts), approvals and the agents themselves
 * cope. Experiments stop by themselves after `durationSeconds`, and abort early when the steady-state guard trips.
 *
 * ```yaml
 * chaos:
 *   experiments:
 *     - id: slow-search
 *       servers: [search]           # server globs (default all)
 *       tools: ["*"]                # tool globs
 *       clients: ["key:staging-*"]  # only these callers (default all — be careful in production)
 *       percent: 25                 # share of matching calls affected
 *       fault: { latencyMs: 1500 }  # and/or errorRate, timeoutRate, corruptRate (0..1 of affected calls)
 *       durationSeconds: 300
 *       abortIfErrorRateAbove: 0.5  # steady-state guard over all matching calls
 *       every: daily                # optional schedule: hourly | daily | weekly (runs durationSeconds each time)
 * ```
 *
 * Faults: `latencyMs` delays the call; `errorRate` refuses it with JSON-RPC **-32021** (or `errorCode`);
 * `timeoutRate` holds it for `timeoutMs` (default 30 s) then fails it like an upstream timeout; `corruptRate` replaces
 * a successful result with an error ("chaos: corrupted result").
 *
 * - `GET  /admin/chaos` — experiments, state (`idle` | `running` | `aborted`), injected faults, calls and errors seen.
 * - `POST /admin/chaos/:id/start` `{ durationSeconds? }`, `POST /admin/chaos/:id/stop`, `POST /admin/chaos/stop-all`.
 *
 * @module features/chaos
 */

import { z } from 'zod';
import { registerFeature, objectBody } from '../gateway/features.js';
import { registerCallHook } from '../gateway/hooks.js';
import { globToRegExp } from '../utils/tool-filter.js';
import { logger } from '../utils/logger.js';
import type { GatewayConfig } from '../utils/types.js';
import { type ChaosConfig, ChaosSchema, ERR_CHAOS_INJECTED, EVERY_MS, Experiment } from './schemas/chaos.js';
export { type ChaosConfig, ChaosSchema, ERR_CHAOS_INJECTED } from './schemas/chaos.js';
type Exp = z.output<typeof Experiment>;

interface Run {
  state: 'idle' | 'running' | 'aborted';
  startedAt?: number;
  until?: number;
  lastRunAt?: number;
  reason?: string;
  injected: { latency: number; error: number; timeout: number; corrupt: number };
  calls: number;
  errors: number;
}

/** Runtime state; exported for tests. Random source is replaceable for deterministic tests. */
export const chaosState = {
  runs: new Map<string, Run>(),
  pending: new WeakMap<object, Array<{ id: string; corrupt: boolean }>>(),
  random: Math.random as () => number,
  reset() {
    this.runs.clear();
    this.random = Math.random;
  },
};

const experiments = (cfg: GatewayConfig): Exp[] => {
  if (!cfg.chaos) return [];
  const c = ChaosSchema.parse(cfg.chaos);
  return c.enabled ? c.experiments : [];
};
const run = (id: string): Run => {
  let r = chaosState.runs.get(id);
  if (!r) chaosState.runs.set(id, (r = { state: 'idle', injected: { latency: 0, error: 0, timeout: 0, corrupt: 0 }, calls: 0, errors: 0 }));
  return r;
};
const glob = (gs: string[], s: string | undefined) => gs.some((g) => globToRegExp(g).test(s ?? ''));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref());

export function startExperiment(e: Exp, durationSeconds?: number, now = Date.now()): Run {
  const r = run(e.id);
  Object.assign(r, { state: 'running', startedAt: now, until: now + (durationSeconds ?? e.durationSeconds) * 1000, lastRunAt: now, reason: undefined, injected: { latency: 0, error: 0, timeout: 0, corrupt: 0 }, calls: 0, errors: 0 });
  logger.warn(`chaos: experiment "${e.id}" started for ${durationSeconds ?? e.durationSeconds}s`);
  return r;
}
export function stopExperiment(id: string, reason: string, state: Run['state'] = 'idle'): void {
  const r = run(id);
  if (r.state !== 'running') return;
  r.state = state;
  r.reason = reason;
  logger.warn(`chaos: experiment "${id}" ${state === 'aborted' ? 'aborted' : 'stopped'} (${reason})`);
}

/** Is the experiment running now (expiring it when its time is up)? */
function active(e: Exp, now = Date.now()): boolean {
  const r = chaosState.runs.get(e.id);
  if (!r || r.state !== 'running') return false;
  if (r.until !== undefined && now >= r.until) {
    stopExperiment(e.id, 'duration elapsed');
    return false;
  }
  return true;
}

/** Steady-state guard: abort experiments whose observed error rate is too high. */
function guard(cfg: GatewayConfig): void {
  for (const e of experiments(cfg)) {
    const r = chaosState.runs.get(e.id);
    if (r?.state === 'running' && e.abortIfErrorRateAbove !== undefined && r.calls >= e.minCallsForAbort && r.errors / r.calls > e.abortIfErrorRateAbove) {
      stopExperiment(e.id, `steady-state guard: error rate ${(r.errors / r.calls).toFixed(2)} > ${e.abortIfErrorRateAbove}`, 'aborted');
    }
  }
}

registerCallHook({
  id: 'chaos',
  async before(call, cfg) {
    const list = experiments(cfg);
    if (!list.length) return;
    const marks: Array<{ id: string; corrupt: boolean }> = [];
    for (const e of list) {
      if (!active(e) || !glob(e.servers, call.serverId) || !glob(e.tools, call.tool) || !glob(e.clients, call.clientId ?? 'anonymous')) continue;
      const r = run(e.id);
      r.calls++;
      if (chaosState.random() * 100 >= e.percent) {
        marks.push({ id: e.id, corrupt: false });
        continue;
      }
      const f = e.fault;
      if (f.latencyMs) {
        r.injected.latency++;
        await sleep(f.latencyMs);
      }
      if (f.errorRate && chaosState.random() < f.errorRate) {
        r.injected.error++;
        r.errors++;
        guard(cfg);
        return { refuse: { code: f.errorCode ?? ERR_CHAOS_INJECTED, message: `chaos: injected error (experiment "${e.id}")`, data: { experiment: e.id } } };
      }
      if (f.timeoutRate && chaosState.random() < f.timeoutRate) {
        r.injected.timeout++;
        r.errors++;
        guard(cfg);
        await sleep(f.timeoutMs);
        return { refuse: { code: ERR_CHAOS_INJECTED, message: `chaos: injected timeout after ${f.timeoutMs}ms (experiment "${e.id}")`, data: { experiment: e.id, timeout: true } } };
      }
      marks.push({ id: e.id, corrupt: !!f.corruptRate && chaosState.random() < f.corruptRate });
    }
    if (marks.length) chaosState.pending.set(call.args, marks);
  },
  after(call, result, cfg) {
    const marks = chaosState.pending.get(call.args);
    if (!marks) return;
    chaosState.pending.delete(call.args);
    let out = result;
    for (const m of marks) {
      const r = run(m.id);
      if (m.corrupt && out.success) {
        r.injected.corrupt++;
        out = { success: false, error: { code: ERR_CHAOS_INJECTED, message: `chaos: corrupted result (experiment "${m.id}")` }, durationMs: out.durationMs };
      }
      if (!out.success && !m.corrupt) r.errors++;
      if (m.corrupt) r.errors++;
    }
    guard(cfg);
    return out === result ? undefined : out;
  },
});

registerFeature({
  id: 'chaos',
  since: '8.8.0',
  summary: 'Chaos testing: scheduled or on-demand latency / error / timeout / corruption injection with a steady-state guard',
  mount(router, ctx) {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const e of experiments(ctx.config())) {
        active(e, now);
        const r = chaosState.runs.get(e.id);
        if (e.every && r?.state !== 'running' && (!r?.lastRunAt || now - r.lastRunAt >= EVERY_MS[e.every])) startExperiment(e, undefined, now);
      }
    }, 5000);
    timer.unref();
    ctx.onStop?.(() => clearInterval(timer));
    const find = (id: string) => experiments(ctx.config()).find((e) => e.id === id);
    router.get('/', (_req, res) => {
      const now = Date.now();
      res.json({
        experiments: experiments(ctx.config()).map((e) => {
          active(e, now);
          const r = run(e.id);
          return { id: e.id, servers: e.servers, tools: e.tools, clients: e.clients, percent: e.percent, fault: e.fault, every: e.every ?? null, state: r.state, reason: r.reason ?? null, startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : null, remainingSeconds: r.state === 'running' && r.until ? Math.ceil((r.until - now) / 1000) : 0, injected: r.injected, calls: r.calls, errors: r.errors };
        }),
      });
    });
    router.post('/stop-all', (_req, res) => {
      const stopped = experiments(ctx.config()).filter((e) => chaosState.runs.get(e.id)?.state === 'running').map((e) => e.id);
      for (const id of stopped) stopExperiment(id, 'stopped by an operator');
      res.json({ stopped });
    });
    router.post('/:id/start', (req, res) => {
      const e = find(String(req.params.id));
      if (!e) return void res.status(404).json({ error: 'Not Found', message: `no chaos experiment "${req.params.id}"` });
      const b = objectBody(req, res);
      if (!b) return;
      const d = typeof b.durationSeconds === 'number' && b.durationSeconds > 0 ? Math.min(Math.floor(b.durationSeconds), 86_400) : undefined;
      const r = startExperiment(e, d);
      res.json({ id: e.id, state: r.state, until: new Date(r.until!).toISOString() });
    });
    router.post('/:id/stop', (req, res) => {
      const e = find(String(req.params.id));
      if (!e) return void res.status(404).json({ error: 'Not Found', message: `no chaos experiment "${req.params.id}"` });
      stopExperiment(e.id, 'stopped by an operator');
      res.json({ id: e.id, state: run(e.id).state });
    });
  },
});
