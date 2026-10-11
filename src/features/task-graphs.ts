/**
 * Multi-agent orchestration 2.0: durable task graphs (10.7).
 *
 * Task graphs (10.7; the 6.2 workflow engine they replaced was removed in 11.0) add what long-running multi-agent work needs:
 *
 * - **Cross-gateway nodes** — a node either calls a tool on this gateway (`tool: server/tool`, full invoker pipeline)
 *   or hands a task to an agent behind another gateway (`remote: { gateway, skill }`, via `features.a2aFederation`
 *   remotes, A2A `message/send`).
 * - **Checkpoints** — the run (status of every node, its outputs and attempts) is written to `dir` after every
 *   state change, atomically (write + rename). After a crash or restart, runs that were in flight are listed as
 *   `interrupted`.
 * - **Resume** — `POST /admin/task-graphs/runs/:id/resume` continues a failed / interrupted / cancelled run from its
 *   checkpoint: succeeded nodes are not executed again, failed and pending ones are.
 * - **Retry** — per node: attempts, exponential backoff (`backoffMs × factor^n`, capped by `maxBackoffMs`, optional
 *   full jitter) and a per-attempt `timeoutMs`.
 * - **Compensation (saga)** — a node may declare `compensate: { tool, args }`. When a run fails (or is cancelled) the
 *   compensations of the nodes that had succeeded run in reverse completion order; the run ends `compensated` or
 *   `compensation_failed` (with the errors). Compensation args are templates that can read the node's own output
 *   (`{{self.text}}`, `{{self.structuredContent.id}}`).
 *
 * ```yaml
 * features:
 *   taskGraphs:
 *     dir: .mcp-gateway/task-graphs     # checkpoints (relative to the config file); omit = memory only
 *     graphs:
 *       - id: onboard-customer
 *         concurrency: 4
 *         nodes:
 *           - id: account
 *             tool: crm/create_account
 *             args: { name: "{{input.name}}" }
 *             compensate: { tool: crm/delete_account, args: { id: "{{self.structuredContent.id}}" } }
 *           - id: kyc
 *             remote: { gateway: eu-gateway, skill: kyc/check }     # an agent behind another gateway
 *             args: { name: "{{input.name}}" }
 *             retry: { attempts: 4, backoffMs: 500, factor: 2, maxBackoffMs: 5000, jitter: true }
 *             timeoutMs: 30000
 *           - id: welcome
 *             needs: [account, kyc]
 *             tool: mail/send
 *             args: { to: "{{input.email}}", text: "Account {{nodes.account.structuredContent.id}} ready" }
 *         output: "{{nodes.account.structuredContent}}"
 * ```
 *
 * Exactly-once is **not** guaranteed: a node interrupted mid-call is executed again on resume. Make node tools
 * idempotent; every call carries the arguments the template produced plus nothing hidden, so put an idempotency key
 * in the args yourself (e.g. `"{{run.id}}-account"`).
 *
 * @module features/task-graphs
 */

import { registerOpsSource } from '../gateway/ops-events.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { registerFeature, objectBody, badRequest, principalOf, clientIdOf, type FeatureContext } from '../gateway/features.js';
import { membershipsOf } from '../auth/tenants.js';
import { registerMetricSource } from '../monitor/index.js';
import { DurableTasks, DurableMetrics, HttpError, durableKv, globMatch } from '../orchestration/durable-tasks.js';
import { clientPrincipal, deniedPrincipal, type Principal } from '../auth/authorizer.js';
import { parseTarget, readPath, render, stepValue } from '../orchestration/chains.js';
import type { GatewayConfig, ProxyResponse } from '../utils/types.js';
import { logger } from '../utils/logger.js';
import { GraphSchema, Id, NodeSchema, Retry, Target, type TaskGraphsConfig, TaskGraphsSchema, topoLayers } from './schemas/task-graphs.js';
export { type TaskGraphsConfig, TaskGraphsSchema, topoLayers } from './schemas/task-graphs.js';
import { A2aFederationSchema } from './schemas/a2a-federation.js';
import { requireDependency } from '../gateway/kernel-runtime.js';
import { instanceLocal } from '../kernel/instance.js';
// 13.0: declared dependency (manifest dependsOn) instead of a static import of another feature module.
const { sendToRemote } = await requireDependency<typeof import('./a2a-federation.js')>('task-graphs', 'a2a-federation');
type Parsed = z.output<typeof TaskGraphsSchema>;
export type GraphCfg = z.output<typeof GraphSchema>;
type NodeCfg = z.output<typeof NodeSchema>;

export type TaskNodeStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'compensated' | 'compensation_failed' | 'awaiting_approval' | 'outcome_unknown';
/** 14.4.0: approval gate state of a node (persisted with the run, so a paused run survives restarts). */
export interface NodeApproval {
  state: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
  approvers: string[];
  required: number;
  requestedAt: string;
  expiresAt: string;
  decisions: Array<{ by: string; decision: 'approve' | 'deny'; at: string; reason?: string }>;
  error?: string;
}
export interface TaskNodeRun {
  id: string;
  status: TaskNodeStatus;
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  output?: Record<string, unknown>;
  compensationError?: string;
  /** 14.4.0 */
  approval?: NodeApproval;
}
/** 14.4.0: one audited action on a run (approve / deny / timeout / resume / takeover / replay / discard / cancel). */
export interface TaskAuditEntry {
  at: string;
  action: string;
  actor: string;
  node?: string;
  reason?: string;
  instance?: string;
}
export type TaskRunStatus = 'running' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled' | 'compensating' | 'compensated' | 'compensation_failed' | 'awaiting_approval' | 'dead_letter';
export interface TaskRun {
  id: string;
  graph: string;
  /** Hash-free copy of the graph definition the run started with (resume uses it even if the config changed). */
  definition: GraphCfg;
  input: Record<string, unknown>;
  clientId?: string;
  /** Principal that started the run (11.1): every node call is authorized as this caller. */
  principal?: Principal;
  status: TaskRunStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  resumes: number;
  /** Node ids in the order they succeeded (compensation runs in reverse). */
  completed: string[];
  nodes: TaskNodeRun[];
  output?: unknown;
  error?: string;
  /** 14.4.0 durable execution: the submission's idempotency key (scoped to the owner). */
  idempotencyKey?: string;
  /** 14.4.0: who submitted the run — client id and every tenant membership at submission (never only the first). */
  owner?: { clientId?: string; tenants: string[] };
  /** 14.4.0: fencing epoch of the current executor (incremented on every claim / takeover). */
  epoch?: number;
  /** 14.4.0: gateway instance holding the run's lease. */
  executor?: string;
  audit?: TaskAuditEntry[];
  /** 14.4.0: DLQ entry id while the run is parked. */
  dlq?: string;
  /** 14.4.0: id of the node whose failure ended the last execution. */
  failedNode?: string;
}

/** 14.4.0: what a call looks like to the durable layer. */
export interface CallInfo {
  runId: string;
  node: string;
  kind: 'action' | 'compensate';
  attempt: number;
}

/**
 * 14.4.0: the durable layer's per-call protocol (intent log / outbox). The engine asks it, around every tool call of a
 * durable run, for a committed result (no call), whether an earlier execution left the call in doubt, and records
 * intent → commit / failure. Any method may throw to stop the execution at once (lease lost, gateway stopping,
 * simulated crash): the engine then writes nothing more.
 */
export interface CallGuard {
  fence(): Promise<void>;
  committed(key: string): Promise<ProxyResponse | undefined>;
  inDoubt(key: string): Promise<boolean>;
  begin(key: string, info: CallInfo): Promise<void>;
  commit(key: string, r: ProxyResponse, info: CallInfo): Promise<void>;
  fail(key: string, info: CallInfo): Promise<void>;
  fault(point: 'afterCall' | 'afterCommit', info: CallInfo): void;
}

/** 14.4.0: a call whose outcome cannot be known (timeout / transport exception): it may or may not have run upstream. */
export const isAmbiguous = (r: ProxyResponse): boolean => !r.success && (r.error?.code === -32001 || (r.error?.data as { ambiguous?: boolean } | undefined)?.ambiguous === true);

/** How one node is executed. Local tools go through the invoker; remote ones through A2A federation. */
export interface TaskExecutor {
  tool: (serverId: string, tool: string, args: Record<string, unknown>, clientId: string | undefined) => Promise<ProxyResponse>;
  remote: (gateway: string, skill: string, args: Record<string, unknown>, clientId: string | undefined) => Promise<ProxyResponse>;
}

export interface RunOptions {
  /** Persist the run after each change (14.4.0: may be async; the engine waits for it before the next call). */
  checkpoint?: (run: TaskRun) => void | Promise<void>;
  /** 14.4.0: durable per-call protocol (intent log, committed results, fencing). */
  guard?: CallGuard;
  /** 14.4.0: on a retryable failure — `park` leaves the run `dead_letter` (DLQ) instead of compensating now. */
  onFailure?: (run: TaskRun) => 'park' | 'compensate' | Promise<'park' | 'compensate'>;
  sleep?: (ms: number) => Promise<unknown>;
  random?: () => number;
  /** Checked between attempts / nodes; when it returns true the run stops as `cancelled` and compensates. */
  cancelled?: () => boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

/** Backoff before attempt `a + 1` (a ≥ 1). */
export function backoff(r: NodeCfg['retry'], a: number, random: () => number = Math.random): number {
  const base = Math.min(r.maxBackoffMs, r.backoffMs * r.factor ** (a - 1));
  return r.jitter ? Math.floor(random() * base) : base;
}

class TimeoutError extends Error {}
function withTimeout<T>(p: Promise<T>, ms: number | undefined, what: string): Promise<T> {
  if (!ms) return p;
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(new TimeoutError(`${what} timed out after ${ms} ms`)), ms)))]).finally(() => clearTimeout(t));
}

/** 14.4.0: the stable idempotency key of a node's call (`kind` compensate gets its own). */
export const callKeyOf = (runId: string, node: string, kind: 'action' | 'compensate' = 'action') => (kind === 'action' ? `${runId}:${node}` : `${runId}:${node}:compensate`);

/**
 * 14.4.0: one guarded call. Returns the response, or `'unknown'` when an earlier execution left this non-repeatable
 * call in doubt (or this one timed out): it is then never executed (again) automatically.
 */
async function guardedCall(guard: CallGuard | undefined, key: string, info: CallInfo, safe: boolean, run: () => Promise<ProxyResponse>): Promise<ProxyResponse | 'unknown'> {
  if (!guard) return run();
  await guard.fence();
  const prior = await guard.committed(key);
  if (prior) return prior;
  if (!safe && (await guard.inDoubt(key))) return 'unknown';
  await guard.begin(key, info);
  const r = await run();
  guard.fault('afterCall', info);
  if (r.success) {
    await guard.commit(key, r, info);
    guard.fault('afterCommit', info);
    return r;
  }
  if (!safe && isAmbiguous(r)) {
    await guard.fence();
    return 'unknown';
  }
  await guard.fail(key, info);
  return r;
}
const UNKNOWN = 'outcome unknown: the call may have run upstream before the gateway stopped or timed out; it is not repeated automatically (DLQ: replay with force, or discard)';

export function newRun(g: GraphCfg, input: Record<string, unknown>, clientId?: string): TaskRun {
  const t = now();
  return { id: randomUUID(), graph: g.id, definition: g, input, clientId, status: 'running', startedAt: t, updatedAt: t, resumes: 0, completed: [], nodes: g.nodes.map((n) => ({ id: n.id, status: 'pending', attempts: 0 })) };
}

/**
 * Execute (or continue) a run. Nodes that already succeeded keep their checkpointed output and are not executed.
 * Returns the same run object.
 */
export async function executeRun(run: TaskRun, exec: TaskExecutor, opts: RunOptions = {}): Promise<TaskRun> {
  const g = run.definition;
  const wait = opts.sleep ?? sleep;
  const random = opts.random ?? Math.random;
  let abort: unknown;
  const save = async () => {
    if (abort) throw abort;
    run.updatedAt = now();
    await opts.checkpoint?.(run);
  };
  const byId = new Map(run.nodes.map((n) => [n.id, n]));
  const cfgOf = new Map(g.nodes.map((n) => [n.id, n]));
  // On resume: anything not succeeded / skipped-by-condition starts over.
  for (const n of run.nodes) if (n.status !== 'succeeded') Object.assign(n, { status: 'pending', error: undefined, finishedAt: undefined });
  run.status = 'running';
  delete run.error;
  delete run.finishedAt;
  delete run.failedNode;
  await save();

  const values = (): Record<string, unknown> => Object.fromEntries(run.nodes.filter((n) => n.output).map((n) => [n.id, n.output]));
  const scope = () => ({ input: run.input, nodes: values(), run: { id: run.id, graph: run.graph } });
  let failed: string | undefined;
  /** 14.4.0: the failure is final (approval denied / expired): compensate, never park in the DLQ. */
  let finalFailure = false;

  const call = async (n: NodeCfg, args: Record<string, unknown>): Promise<ProxyResponse> => {
    try {
      if (n.tool) {
        const t = parseTarget(n.tool)!;
        return await withTimeout(exec.tool(t.serverId, t.tool, args, run.clientId), n.timeoutMs, `node ${n.id}`);
      }
      return await withTimeout(exec.remote(n.remote!.gateway, n.remote!.skill, args, run.clientId), n.timeoutMs, `node ${n.id}`);
    } catch (e) {
      return { success: false, durationMs: 0, error: { code: e instanceof TimeoutError ? -32001 : -32603, message: (e as Error).message, data: { ambiguous: true } } };
    }
  };

  const runNode = async (n: NodeCfg): Promise<void> => {
    const rec = byId.get(n.id)!;
    const blocked = n.needs.some((d) => ['failed', 'skipped'].includes(byId.get(d)!.status));
    if (failed || blocked || opts.cancelled?.() || (n.if !== undefined && !readPath(scope(), n.if))) {
      rec.status = 'skipped';
      await save();
      return;
    }
    // 14.4.0: approval gate — the node waits (persisted) until approved; denied / expired fails it for good.
    if (n.approval) {
      const ap = rec.approval;
      if (ap && (ap.state === 'denied' || ap.state === 'expired')) {
        rec.status = 'failed';
        rec.error = ap.error ?? `approval ${ap.state}`;
        rec.finishedAt = now();
        if (!failed) failed = `node ${n.id}: ${rec.error}`;
        finalFailure = true;
        await save();
        return;
      }
      if (ap?.state !== 'approved') {
        if (!ap || ap.state === 'cancelled') {
          const t = Date.now();
          rec.approval = { state: 'pending', approvers: [...n.approval.approvers], required: n.approval.required, requestedAt: new Date(t).toISOString(), expiresAt: new Date(t + n.approval.timeoutSeconds * 1000).toISOString(), decisions: [] };
        }
        rec.status = 'awaiting_approval';
        await save();
        return;
      }
    }
    rec.status = 'running';
    rec.startedAt = now();
    rec.attempts = 0;
    await save();
    const safe = n.idempotent || !!n.idempotencyArg;
    const key = callKeyOf(run.id, n.id);
    for (let a = 1; a <= n.retry.attempts; a++) {
      rec.attempts = a;
      const args = render(n.args, scope()) as Record<string, unknown>;
      if (n.idempotencyArg) args[n.idempotencyArg] = key;
      const r = await guardedCall(opts.guard, key, { runId: run.id, node: n.id, kind: 'action', attempt: a }, safe, () => call(n, args));
      if (r === 'unknown') {
        rec.status = 'outcome_unknown';
        rec.error = UNKNOWN;
        rec.finishedAt = now();
        if (!failed) failed = `node ${n.id}: ${UNKNOWN}`;
        run.failedNode ??= n.id;
        await save();
        return;
      }
      if (r.success) {
        rec.output = stepValue(r.result);
        rec.status = 'succeeded';
        rec.finishedAt = now();
        delete rec.error;
        run.completed.push(n.id);
        await save();
        return;
      }
      rec.error = r.error?.message ?? 'failed';
      await save();
      if (a < n.retry.attempts) {
        if (opts.cancelled?.()) break;
        await wait(backoff(n.retry, a, random));
      }
    }
    rec.status = 'failed';
    rec.finishedAt = now();
    if (n.onError === 'fail' && !failed) {
      failed = `node ${n.id}: ${rec.error}`;
      run.failedNode ??= n.id;
    }
    await save();
  };

  const settled = (id: string) => !['pending', 'running', 'awaiting_approval'].includes(byId.get(id)!.status);
  const started = new Set(run.nodes.filter((n) => n.status === 'succeeded').map((n) => n.id));
  const inflight = new Set<Promise<void>>();
  for (;;) {
    for (const n of g.nodes) {
      if (inflight.size >= g.concurrency) break;
      if (started.has(n.id) || !n.needs.every(settled)) continue;
      started.add(n.id);
      const p: Promise<void> = runNode(n)
        .catch((e) => void (abort ??= e))
        .finally(() => inflight.delete(p));
      inflight.add(p);
    }
    if (abort) throw abort; // 14.4.0: lease lost / stopping / crash — stop here, write nothing more
    if (!inflight.size) break;
    await Promise.race(inflight);
  }

  const cancelled = opts.cancelled?.() ?? false;
  const waiting = run.nodes.filter((n) => n.status === 'awaiting_approval');
  if (!failed && !cancelled && waiting.length) {
    run.status = 'awaiting_approval';
    await save();
    return run;
  }
  for (const n of waiting) {
    n.status = 'skipped';
    if (n.approval) n.approval.state = 'cancelled';
  }
  if (!failed && !cancelled) {
    run.status = 'succeeded';
    if (g.output !== undefined) run.output = render(g.output, scope());
    run.finishedAt = now();
    await save();
    return run;
  }
  run.error = cancelled ? 'cancelled' : failed;
  if (!cancelled && !finalFailure && opts.onFailure && (await opts.onFailure(run)) === 'park') {
    run.status = 'dead_letter';
    await save();
    return run;
  }
  return finishCompensation(run, exec, opts);
}

/**
 * Run (or, 14.4.0, continue after a restart) the compensations of a failed / cancelled run and finish it. Compensations
 * that already ran are not run again; with a guard each one goes through the intent log like a node call.
 */
export async function finishCompensation(run: TaskRun, exec: TaskExecutor, opts: RunOptions = {}): Promise<TaskRun> {
  const cfgOf = new Map(run.definition.nodes.map((n) => [n.id, n]));
  const save = async () => {
    run.updatedAt = now();
    await opts.checkpoint?.(run);
  };
  const cancelled = run.error === 'cancelled';
  await compensate(run, exec, cfgOf, save, opts.guard);
  if (cancelled && (run.status as TaskRunStatus) === 'compensated') run.status = 'cancelled';
  run.finishedAt = now();
  await save();
  return run;
}

/** Run the compensations of the succeeded nodes, newest first. */
async function compensate(run: TaskRun, exec: TaskExecutor, cfgOf: Map<string, NodeCfg>, save: () => Promise<void>, guard?: CallGuard): Promise<void> {
  const todo = [...run.completed].reverse().filter((id) => cfgOf.get(id)?.compensate && run.nodes.find((n) => n.id === id)!.status === 'succeeded');
  if (!todo.length) {
    run.status = run.error === 'cancelled' ? 'cancelled' : 'failed';
    return;
  }
  run.status = 'compensating';
  await save();
  const errors: string[] = [];
  for (const id of todo) {
    const node = run.nodes.find((n) => n.id === id)!;
    const c = cfgOf.get(id)!.compensate!;
    const t = parseTarget(c.tool)!;
    const scope = { input: run.input, nodes: Object.fromEntries(run.nodes.filter((n) => n.output).map((n) => [n.id, n.output])), self: node.output ?? {}, run: { id: run.id, graph: run.graph } };
    const key = callKeyOf(run.id, id, 'compensate');
    const args = render(c.args, scope) as Record<string, unknown>;
    if (c.idempotencyArg) args[c.idempotencyArg] = key;
    const r = await guardedCall(guard, key, { runId: run.id, node: id, kind: 'compensate', attempt: 1 }, !!c.idempotencyArg, async () => {
      try {
        return await exec.tool(t.serverId, t.tool, args, run.clientId);
      } catch (e) {
        return { success: false, durationMs: 0, error: { code: -32603, message: (e as Error).message, data: { ambiguous: true } } };
      }
    });
    if (r !== 'unknown' && r.success) node.status = 'compensated';
    else {
      node.status = 'compensation_failed';
      node.compensationError = r === 'unknown' ? UNKNOWN : (r.error?.message ?? 'failed');
      errors.push(`${id}: ${node.compensationError}`);
    }
    await save();
  }
  run.status = errors.length ? 'compensation_failed' : 'compensated';
  if (errors.length) run.error = `${run.error}; compensation failed for ${errors.join('; ')}`;
}

/** Run store with optional checkpoint directory. */
export class TaskRunStore {
  readonly runs = new Map<string, TaskRun>();
  private loadedDir?: string;
  constructor(private readonly max = 500) {}

  load(dir: string | undefined): void {
    if (!dir || this.loadedDir === dir) return;
    this.loadedDir = dir;
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      try {
        const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as TaskRun;
        if (r.status === 'running' || r.status === 'compensating') {
          r.status = 'interrupted';
          r.error = 'the gateway stopped while the run was in flight';
          for (const n of r.nodes) if (n.status === 'running') n.status = 'pending';
          this.save(r, dir);
        }
        this.runs.set(r.id, r);
      } catch (e) {
        logger.warn(`task-graphs: skipping unreadable checkpoint ${f}: ${(e as Error).message}`);
      }
    }
    this.trim();
  }

  save(run: TaskRun, dir: string | undefined): void {
    this.runs.set(run.id, run);
    this.trim();
    if (!dir) return;
    try {
      // 14.4.0: runs carry inputs, outputs and the caller's principal — owner-only files (was the umask default)
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = join(dir, `.${run.id}.tmp`);
      writeFileSync(tmp, JSON.stringify(run), { mode: 0o600 });
      renameSync(tmp, join(dir, `${run.id}.json`));
    } catch (e) {
      logger.warn(`task-graphs: checkpoint write failed: ${(e as Error).message}`);
    }
  }

  private trim(): void {
    if (this.runs.size <= this.max) return;
    const done = [...this.runs.values()].filter((r) => r.finishedAt).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (const r of done) {
      if (this.runs.size <= this.max) break;
      this.runs.delete(r.id);
    }
  }

  reset(): void {
    this.runs.clear();
    this.loadedDir = undefined;
  }
}

export const taskRuns = instanceLocal('task-graphs', 'taskRuns', () => new TaskRunStore()); // 14.0.0: per gateway instance (F3)
const active = instanceLocal('task-graphs', 'active', () => new Map<string, { cancel: boolean; done: Promise<TaskRun> }>()); // 14.0.0: per gateway instance (F3)

export function taskGraphsOf(cfg: GatewayConfig): Parsed | undefined {
  if (!cfg.taskGraphs) return undefined;
  const p = TaskGraphsSchema.parse(cfg.taskGraphs);
  return p.enabled ? p : undefined;
}

const RESUMABLE: TaskRunStatus[] = ['failed', 'interrupted', 'cancelled', 'compensated', 'compensation_failed'];

/** 14.4.0: per gateway instance — the durable manager for the current durable config (re-created when it changes). */
const durableState = instanceLocal('task-graphs', 'durable', () => ({ sig: '', mgr: undefined as DurableTasks | undefined, metrics: new DurableMetrics() }));

/** 14.4.0: principal for a run's next call — re-resolved, so a removed / re-scoped key cannot act through a stored run. */
function runPrincipal(ctx: FeatureContext, run: TaskRun, client: string | undefined): Principal {
  const p = run.principal;
  if (!p) return (ctx.principalFor ?? deniedPrincipal)(client);
  if (p.kind !== 'client' || !ctx.resolveScope) return p;
  const r = ctx.resolveScope(p.id);
  if (r === undefined) return p; // the scope travels with the credential (JWT / OAuth): the stored one applies
  if (!r.known) return deniedPrincipal(p.id); // key removed since the run was submitted
  // current scope; a delegation chain only ever narrows, so it is kept
  return { ...clientPrincipal(p.id, r.scope), ...(p.delegation?.length ? { delegation: p.delegation } : {}) };
}

const send = (res: import('express').Response, e: unknown) => {
  if (e instanceof HttpError) return void res.status(e.status).json({ error: e.status === 404 ? 'Not Found' : e.status === 403 ? 'Forbidden' : e.status === 409 ? 'Conflict' : 'Bad Request', message: e.message });
  res.status(500).json({ error: 'Internal Server Error', message: (e as Error).message });
};
const keyOf = (req: import('express').Request, b: Record<string, unknown>): string | undefined | null => {
  const h = req.header('idempotency-key');
  const k = h ?? b.idempotencyKey;
  if (k === undefined) return undefined;
  if (typeof k !== 'string' || !k.length || k.length > 255) return null;
  return k;
};
/** What a client may see of its own run (no stored principal). */
const clientView = (r: TaskRun) => {
  const { principal: _p, definition: _d, ...rest } = r;
  return rest;
};

registerFeature({
  id: 'task-graphs',
  since: '10.7.0',
  summary: 'Multi-agent orchestration 2.0: cross-gateway task graphs with checkpoints, resume, retry with backoff and saga compensation',
  mount: (router, ctx) => {
    const dirOf = (c: Parsed) => (c.dir ? resolve(ctx.config().configDir ?? process.cwd(), c.dir) : undefined);
    // 11.1: nodes run as the principal that started the run (re-authorized per call), else the client's current scope.
    // 14.4.0: the principal is re-resolved per call (runPrincipal).
    const exec = (run: TaskRun): TaskExecutor => ({
      tool: (s, t, a, client) => ctx.invoke(s, t, a, runPrincipal(ctx, run, client), client ?? 'task-graph'),
      remote: async (gw, skill, args, client) => {
        const raw = ctx.config().a2aFederation;
        if (!raw) return { success: false, durationMs: 0, error: { code: -32603, message: 'features.a2aFederation is not configured (needed for remote nodes)' } };
        const t0 = Date.now();
        const r = await sendToRemote(A2aFederationSchema.parse(raw), gw, skill, args, client);
        if (r.status !== 200) return { success: false, durationMs: Date.now() - t0, error: { code: -32603, message: String(r.body.message ?? `remote ${gw} failed`) } };
        const task = r.body.task as { status?: { state?: string }; artifacts?: unknown } | undefined;
        const state = task?.status?.state;
        if (state && !['completed', 'working', 'submitted'].includes(state)) return { success: false, durationMs: Date.now() - t0, error: { code: -32603, message: `remote task ended "${state}"` } };
        return { success: true, durationMs: Date.now() - t0, result: { structuredContent: task ?? {}, content: [{ type: 'text', text: JSON.stringify(task ?? {}) }] } };
      },
    });
    const ds = durableState;
    registerMetricSource('task-graphs', () => ds.metrics.prometheus());
    // 14.8.0: DLQ counts on the operations console cluster view (statuses counted in a Map, not keyed objects)
    registerOpsSource('dlq', async () => {
      if (!ds.mgr) return null;
      const by = new Map<string, number>();
      const es = await ds.mgr.dlqList();
      for (const e of es) by.set(String(e.status), (by.get(String(e.status)) ?? 0) + 1);
      return { total: es.length, byStatus: Object.fromEntries(by) };
    });
    /** 14.4.0: the durable manager for the current config (undefined = 10.7 checkpoints). */
    const durable = (c: Parsed): DurableTasks | undefined => {
      if (!c.durable?.enabled) {
        if (ds.mgr) void ds.mgr.stop();
        ds.mgr = undefined;
        ds.sig = '';
        return undefined;
      }
      const store = ctx.store?.();
      const dir = dirOf(c);
      const sig = JSON.stringify([c.durable, store?.kind, dir]);
      if (ds.mgr && ds.sig === sig) return ds.mgr;
      if (ds.mgr) void ds.mgr.stop();
      const t = ctx.timers;
      const m = new DurableTasks(durableKv(c.durable, store, dir), c.durable, {
        exec,
        engine: { executeRun, finishCompensation },
        setInterval: (fn, ms) => (t ? t.setInterval(fn, ms) : setInterval(fn, ms).unref()),
        clear: (x) => (t ? t.clear(x) : clearInterval(x)),
        ready: (run) => {
          const online = ctx.onlineServers?.();
          if (!online) return true;
          const need = run.definition.nodes.filter((n) => n.tool && run.nodes.find((x) => x.id === n.id)?.status !== 'succeeded').map((n) => parseTarget(n.tool!)!.serverId);
          return need.every((sid) => online.includes(sid));
        },
      }, ds.metrics);
      ds.mgr = m;
      ds.sig = sig;
      m.start();
      return m;
    };
    ctx.onStop?.(async () => {
      await ds.mgr?.stop();
      ds.mgr = undefined;
      ds.sig = '';
    });
    const conf = (res: import('express').Response): Parsed | undefined => {
      const c = taskGraphsOf(ctx.config());
      if (!c) badRequest(res, 'features.taskGraphs is not configured');
      else if (!c.durable?.enabled) taskRuns.load(dirOf(c));
      return c;
    };
    // activate the durable layer at mount, so runs left in flight resume without waiting for a request
    try {
      const c0 = taskGraphsOf(ctx.config());
      if (c0) durable(c0);
    } catch (e) {
      logger.warn(`task-graphs: durable layer not started: ${(e as Error).message}`);
    }
    const start = (run: TaskRun, c: Parsed) => {
      const st = { cancel: false, done: undefined as unknown as Promise<TaskRun> };
      st.done = executeRun(run, exec(run), { checkpoint: (r) => taskRuns.save(r, dirOf(c)), cancelled: () => st.cancel }).finally(() => active.delete(run.id));
      active.set(run.id, st);
      return st.done;
    };
    const summary = (r: TaskRun) => ({ id: r.id, graph: r.graph, status: r.status, startedAt: r.startedAt, updatedAt: r.updatedAt, finishedAt: r.finishedAt ?? null, resumes: r.resumes, error: r.error, ...(r.owner ? { owner: r.owner } : {}), ...(r.idempotencyKey ? { idempotencyKey: r.idempotencyKey } : {}), ...(r.dlq ? { dlq: r.dlq } : {}) });
    const ownerOf = (clientId: string | undefined) => ({ clientId, tenants: [...new Set(membershipsOf(ctx.config().tenants, clientId).map((m) => m.tenant))] });

    /** Start (or deduplicate) a run — shared by the admin and the client route. */
    const submit = async (req: import('express').Request, res: import('express').Response, c: Parsed, g: GraphCfg, b: Record<string, unknown>, view: (r: TaskRun) => unknown) => {
      const key = keyOf(req, b);
      if (key === null) return badRequest(res, 'the idempotency key must be a non-empty string of at most 255 characters');
      const m = durable(c);
      if (!m) {
        if (key !== undefined) return badRequest(res, 'idempotency keys need features.taskGraphs.durable');
        const run = newRun(g, (b.input as Record<string, unknown>) ?? {}, clientIdOf(req));
        run.principal = principalOf(req);
        const done = start(run, c);
        if (b.wait === true) return void res.json(view(await done));
        return void res.status(202).json({ runId: run.id, status: run.status });
      }
      const run = newRun(g, (b.input as Record<string, unknown>) ?? {}, clientIdOf(req));
      run.principal = principalOf(req);
      run.owner = ownerOf(clientIdOf(req));
      try {
        const r = await m.submit(run, key);
        if (b.wait === true) {
          const fin = r.done ? await r.done : await waitSettled(m, r.run.id);
          if (r.duplicate) res.setHeader('Idempotent-Replayed', 'true');
          return void res.json(view(fin));
        }
        res.status(r.duplicate ? 200 : 202).json({ runId: r.run.id, status: r.run.status, ...(r.duplicate ? { duplicate: true } : {}) });
      } catch (e) {
        send(res, e);
      }
    };

    router.get('/', (_req, res) => {
      const c = conf(res);
      if (!c) return;
      const m = durable(c);
      res.json({ persisted: !!c.dir || (!!m && m.backend !== 'memory'), durable: m ? { backend: m.backend, instance: m.instance, resumeOnStart: c.durable!.resumeOnStart, leaseMs: c.durable!.leaseMs, dlq: c.durable!.dlq.enabled, executing: m.active.size } : null, graphs: c.graphs.map((g) => ({ id: g.id, description: g.description, clients: g.clients, nodes: g.nodes.length, layers: topoLayers(g.nodes), remoteNodes: g.nodes.filter((n) => n.remote).map((n) => n.id), compensable: g.nodes.filter((n) => n.compensate).map((n) => n.id), approvals: g.nodes.filter((n) => n.approval).map((n) => n.id) })), active: m ? m.active.size : active.size });
    });
    router.post('/run', async (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      const c = conf(res);
      if (!c) return;
      const g = c.graphs.find((x) => x.id === b.graph);
      if (!g) return void res.status(404).json({ error: 'Not Found', message: `unknown task graph ${JSON.stringify(b.graph)}` });
      if (b.input !== undefined && (typeof b.input !== 'object' || b.input === null || Array.isArray(b.input))) return badRequest(res, '"input" must be an object');
      await submit(req, res, c, g, b, (r) => r);
    });
    router.get('/runs', async (req, res) => {
      const c = conf(res);
      if (!c) return;
      const q = (k: string) => (typeof req.query[k] === 'string' ? (req.query[k] as string) : undefined);
      const status = q('status');
      const client = q('client');
      const tenant = q('tenant');
      const m = durable(c);
      const all = m ? await m.list() : [...taskRuns.runs.values()];
      res.json({ runs: all.filter((r) => (!status || r.status === status) && (!client || r.owner?.clientId === client || r.clientId === client) && (!tenant || r.owner?.tenants.includes(tenant))).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(summary) });
    });
    router.get('/runs/:id', async (req, res) => {
      const c = conf(res);
      if (!c) return;
      const m = durable(c);
      const r = m ? await m.load(req.params.id) : taskRuns.runs.get(req.params.id);
      if (!r) return void res.status(404).json({ error: 'Not Found', message: `no run ${req.params.id}` });
      res.json(r);
    });
    router.post('/runs/:id/resume', async (req, res) => {
      const c = conf(res);
      if (!c) return;
      const b = (req.body ?? {}) as { wait?: unknown };
      const m = durable(c);
      if (m) {
        try {
          const { run, done } = await m.resume(req.params.id, clientIdOf(req) ?? 'operator');
          if (b.wait === true) return void res.json(await done);
          return void res.status(202).json({ runId: run.id, status: 'running', resumes: run.resumes });
        } catch (e) {
          return send(res, e);
        }
      }
      const r = taskRuns.runs.get(req.params.id);
      if (!r) return void res.status(404).json({ error: 'Not Found', message: `no run ${req.params.id}` });
      if (active.has(r.id) || !RESUMABLE.includes(r.status)) return void res.status(409).json({ error: 'Conflict', message: `run is ${active.has(r.id) ? 'in flight' : r.status}; only ${RESUMABLE.join(' / ')} runs can be resumed` });
      // Compensated nodes did their undo: they run again on resume.
      for (const n of r.nodes) if (n.status === 'compensated' || n.status === 'compensation_failed') {
        n.status = 'pending';
        delete n.output;
        r.completed = r.completed.filter((x) => x !== n.id);
      }
      r.resumes++;
      const done = start(r, c);
      if (b.wait === true) return void res.json(await done);
      res.status(202).json({ runId: r.id, status: 'running', resumes: r.resumes });
    });
    router.post('/runs/:id/cancel', async (req, res) => {
      const c = conf(res);
      if (!c) return;
      const m = durable(c);
      if (m) {
        try {
          const r = await m.cancel(req.params.id, clientIdOf(req) ?? 'operator');
          if (r.done) {
            const fin = await r.done;
            return void res.json({ runId: fin.id, status: fin.status });
          }
          return void res.status(202).json({ runId: req.params.id, status: r.status });
        } catch (e) {
          return send(res, e);
        }
      }
      const st = active.get(req.params.id);
      if (!st) return void res.status(409).json({ error: 'Conflict', message: 'run is not in flight' });
      st.cancel = true;
      const r = await st.done;
      res.json({ runId: r.id, status: r.status });
    });
    // 14.4.0: operator approval override, and the DLQ
    for (const decision of ['approve', 'deny'] as const)
      router.post(`/runs/:id/${decision}`, async (req, res) => {
        const c = conf(res);
        if (!c) return;
        const m = durable(c);
        if (!m) return badRequest(res, 'approvals need features.taskGraphs.durable');
        const b = (req.body ?? {}) as { node?: unknown; reason?: unknown; wait?: unknown };
        try {
          const r = await m.decide(req.params.id, typeof b.node === 'string' ? b.node : undefined, clientIdOf(req) ?? 'operator', decision, typeof b.reason === 'string' ? b.reason.slice(0, 500) : undefined, true);
          if (b.wait === true && r.done) return void res.json(await r.done);
          res.json({ runId: r.run.id, status: r.done ? 'running' : r.run.status });
        } catch (e) {
          send(res, e);
        }
      });
    const dlqOf = (res: import('express').Response): DurableTasks | undefined => {
      const c = conf(res);
      if (!c) return undefined;
      const m = durable(c);
      if (!m) badRequest(res, 'the DLQ needs features.taskGraphs.durable');
      return m;
    };
    router.get('/dlq', async (req, res) => {
      const m = dlqOf(res);
      if (!m) return;
      const st = typeof req.query.status === 'string' ? req.query.status : undefined;
      const runId = typeof req.query.runId === 'string' ? req.query.runId : undefined;
      const es = (await m.dlqList()).filter((e) => (!st || e.status === st) && (!runId || e.runId === runId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      res.json({ entries: es });
    });
    router.get('/dlq/:id', async (req, res) => {
      const m = dlqOf(res);
      if (!m) return;
      const e = await m.dlqEntry(req.params.id);
      if (!e) return void res.status(404).json({ error: 'Not Found', message: `no DLQ entry ${req.params.id}` });
      res.json({ ...e, run: await m.load(e.runId) });
    });
    router.post('/dlq/:id/replay', async (req, res) => {
      const m = dlqOf(res);
      if (!m) return;
      const b = (req.body ?? {}) as { force?: unknown; wait?: unknown };
      try {
        const r = await m.replay(req.params.id, b.force === true, clientIdOf(req) ?? 'operator');
        if (b.wait === true) return void res.json(await r.done);
        res.status(202).json({ id: r.entry.id, runId: r.entry.runId, status: 'running' });
      } catch (e) {
        send(res, e);
      }
    });
    router.post('/dlq/:id/discard', async (req, res) => {
      const m = dlqOf(res);
      if (!m) return;
      const b = (req.body ?? {}) as { compensate?: unknown; wait?: unknown };
      try {
        const r = await m.discard(req.params.id, b.compensate !== false, clientIdOf(req) ?? 'operator');
        const run = b.wait === true ? await r.done : undefined;
        res.json({ id: r.entry.id, status: r.entry.status, runId: r.entry.runId, ...(run ? { run: { id: run.id, status: run.status } } : {}) });
      } catch (e) {
        send(res, e);
      }
    });
  },
  // 14.4.0: any authenticated client — graphs with `clients: true`; a client sees and acts on its own runs only.
  mountClient: (router, ctx) => {
    const ds = durableState;
    const need = (res: import('express').Response): { c: Parsed; m: DurableTasks } | undefined => {
      const c = taskGraphsOf(ctx.config());
      const m = ds.mgr;
      if (!c || !c.durable?.enabled || !m) {
        res.status(404).json({ error: 'Not Found', message: 'client task routes need features.taskGraphs.durable' });
        return undefined;
      }
      return { c, m };
    };
    const own = async (req: import('express').Request, res: import('express').Response, m: DurableTasks): Promise<TaskRun | undefined> => {
      const r = await m.load(req.params.id!);
      if (!r || !r.owner || r.owner.clientId !== clientIdOf(req)) {
        res.status(404).json({ error: 'Not Found', message: `no run ${req.params.id}` });
        return undefined;
      }
      return r;
    };
    router.get('/', (_req, res) => {
      const x = need(res);
      if (!x) return;
      res.json({ graphs: x.c.graphs.filter((g) => g.clients).map((g) => ({ id: g.id, description: g.description, nodes: g.nodes.length, approvals: g.nodes.filter((n) => n.approval).map((n) => n.id) })) });
    });
    router.post('/run', async (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      const x = need(res);
      if (!x) return;
      const g = x.c.graphs.find((y) => y.id === b.graph && y.clients);
      if (!g) return void res.status(404).json({ error: 'Not Found', message: `unknown task graph ${JSON.stringify(b.graph)}` });
      if (b.input !== undefined && (typeof b.input !== 'object' || b.input === null || Array.isArray(b.input))) return badRequest(res, '"input" must be an object');
      const key = keyOf(req, b);
      if (key === null) return badRequest(res, 'the idempotency key must be a non-empty string of at most 255 characters');
      const run = newRun(g, (b.input as Record<string, unknown>) ?? {}, clientIdOf(req));
      run.principal = principalOf(req);
      run.owner = { clientId: clientIdOf(req), tenants: [...new Set(membershipsOf(ctx.config().tenants, clientIdOf(req)).map((m) => m.tenant))] };
      try {
        const r = await x.m.submit(run, key);
        if (b.wait === true) {
          const fin = r.done ? await r.done : await waitSettled(x.m, r.run.id);
          if (r.duplicate) res.setHeader('Idempotent-Replayed', 'true');
          return void res.json(clientView(fin));
        }
        res.status(r.duplicate ? 200 : 202).json({ runId: r.run.id, status: r.run.status, ...(r.duplicate ? { duplicate: true } : {}) });
      } catch (e) {
        send(res, e);
      }
    });
    router.get('/runs', async (req, res) => {
      const x = need(res);
      if (!x) return;
      const me = clientIdOf(req);
      res.json({ runs: (await x.m.list()).filter((r) => r.owner?.clientId === me).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map((r) => ({ id: r.id, graph: r.graph, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt ?? null, error: r.error })) });
    });
    router.get('/approvals', async (req, res) => {
      const x = need(res);
      if (!x) return;
      const me = clientIdOf(req) ?? '';
      const out: unknown[] = [];
      for (const r of await x.m.list()) {
        if (r.status !== 'awaiting_approval' || r.owner?.clientId === me) continue;
        for (const n of r.nodes)
          if (n.status === 'awaiting_approval' && n.approval?.state === 'pending' && n.approval.approvers.some((p) => globMatch(p, me)) && !n.approval.decisions.some((d) => d.by === me))
            out.push({ runId: r.id, graph: r.graph, node: n.id, requester: r.owner?.clientId, required: n.approval.required, approvals: n.approval.decisions.filter((d) => d.decision === 'approve').length, requestedAt: n.approval.requestedAt, expiresAt: n.approval.expiresAt, input: r.input });
      }
      res.json({ approvals: out });
    });
    router.get('/runs/:id', async (req, res) => {
      const x = need(res);
      if (!x) return;
      const r = await own(req, res, x.m);
      if (r) res.json(clientView(r));
    });
    router.post('/runs/:id/cancel', async (req, res) => {
      const x = need(res);
      if (!x) return;
      const r = await own(req, res, x.m);
      if (!r) return;
      try {
        const c = await x.m.cancel(r.id, clientIdOf(req) ?? 'client');
        if (c.done) {
          const fin = await c.done;
          return void res.json({ runId: fin.id, status: fin.status });
        }
        res.status(202).json({ runId: r.id, status: c.status });
      } catch (e) {
        send(res, e);
      }
    });
    for (const decision of ['approve', 'deny'] as const)
      router.post(`/runs/:id/${decision}`, async (req, res) => {
        const x = need(res);
        if (!x) return;
        const b = (req.body ?? {}) as { node?: unknown; reason?: unknown };
        const me = clientIdOf(req);
        if (!me) return void res.status(403).json({ error: 'Forbidden', message: 'unidentified clients cannot decide' });
        try {
          const r = await x.m.decide(req.params.id, typeof b.node === 'string' ? b.node : undefined, me, decision, typeof b.reason === 'string' ? b.reason.slice(0, 500) : undefined, false);
          res.json({ runId: r.run.id, status: r.done ? 'running' : r.run.status });
        } catch (e) {
          // a run the caller may not decide on stays invisible to it
          if (e instanceof HttpError && e.status === 404 && !/node/.test(e.message)) return void res.status(404).json({ error: 'Not Found', message: `no run ${req.params.id}` });
          send(res, e);
        }
      });
  },
});

/** Wait until a run (executing on any instance) leaves `running` / `compensating`. */
async function waitSettled(m: DurableTasks, id: string, ms = 600_000): Promise<TaskRun> {
  const t0 = Date.now();
  for (;;) {
    const r = await m.load(id);
    if (r && !['running', 'compensating'].includes(r.status)) return r;
    if (Date.now() - t0 > ms) return r!;
    await new Promise((res) => setTimeout(res, 100));
  }
}
