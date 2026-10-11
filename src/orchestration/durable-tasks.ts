/**
 * Durable task execution (14.4.0, "持久化任务执行") for task graphs — `features.taskGraphs.durable`.
 *
 * Additive on the 10.7 task-graph engine (`./task-graphs.ts`): the engine still schedules nodes, retries and
 * compensates; this layer makes an execution survive gateway restarts and run exactly once across gateway instances.
 *
 * - **Persisted state** — every run change is written to the configured backend before the engine moves on: the
 *   gateway store (`store.backend`: sqlite / redis / eventlog / memory) or the checkpoint `dir` (files, 0600).
 * - **Leases + fencing** — an execution holds a heartbeat lease (`leaseMs`) and a fencing epoch (an atomic counter
 *   per run). A run whose lease lapsed (crash, kill -9) is taken over by exactly one instance (the one whose epoch
 *   increment is current); a stale executor notices at its next write and stops.
 * - **Resume** — on start (`resumeOnStart`) and on every sweep, runs left `running` / `compensating` without a live
 *   lease continue from their last committed step: committed node results are reused, compensations already run are
 *   not repeated.
 * - **Idempotency keys** — per task (`Idempotency-Key` header / `idempotencyKey`, scoped to the submitting client: a
 *   duplicate returns the same run, a different payload under the same key is 409) and per tool call (the stable key
 *   `<runId>:<node>`; `idempotencyArg` passes it to the upstream).
 * - **Intent log (outbox semantics)** — before a call the executor records an intent, after it the result (commit).
 *   An intent without a commit means the gateway died (or timed out) between call and commit: a non-repeatable node
 *   (`idempotent: false`, no `idempotencyArg`) is then never executed again automatically — it becomes
 *   `outcome_unknown` and the run goes to the DLQ for an operator decision (replay with `force`, or discard).
 * - **Failure queue (DLQ)** — a run that fails is parked (`dead_letter`) instead of compensating at once; it is
 *   re-run with the retry policy (`dlq.retry`: attempts, exponential backoff, jitter); when retries are exhausted (or
 *   the failure is not retryable) it waits for an operator: inspect / replay / discard (discard runs the compensations).
 * - **Approval resume** — a node with `approval` pauses the run (`awaiting_approval`, persisted, no lease held); it
 *   survives restarts and resumes on approve, fails and compensates on deny or timeout; every decision is audited.
 *
 * @module orchestration/durable-tasks
 */

import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { StateStore } from '../state/store.js';
import { MemoryStateStore } from '../state/store.js';
import type { ProxyResponse } from '../utils/types.js';
import { logger } from '../utils/logger.js';
// type-only: the engine itself is injected (DurableDeps) — the core never imports a feature module
import type { CallGuard, CallInfo, RunOptions, TaskExecutor, TaskRun, TaskRunStatus } from '../features/task-graphs.js';
import type { DurableSchema } from '../features/schemas/task-graphs.js';
import type { z } from 'zod';

export type DurableCfg = z.output<typeof DurableSchema>;

// ─── test hooks ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Thrown by a fault hook to simulate a crash at that point: the execution stops and writes nothing more. */
export class SimulatedCrash extends Error {
  constructor() {
    super('simulated crash');
    this.name = 'SimulatedCrash';
  }
}
/** The executor lost its lease (another instance took the run over) or the gateway is stopping. */
export class LeaseLost extends Error {
  constructor(m = 'lease lost') {
    super(m);
    this.name = 'LeaseLost';
  }
}
/**
 * Fault injection for crash tests (process-wide; unset in production). `afterCall` runs after a tool call returned and
 * before its result is committed, `afterCommit` after the commit and before the run record is updated, `heartbeat`
 * on every lease renewal. Throwing {@link SimulatedCrash} makes that execution behave like a killed process.
 */
export const durableFaults: {
  afterCall?: (p: CallInfo) => void;
  afterCommit?: (p: CallInfo) => void;
  heartbeat?: (p: { instance: string; runId: string }) => void;
} = {};

// ─── persistence ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Minimal key/value contract the durable layer needs (implemented over a StateStore or a directory). */
export interface DurableKv {
  readonly kind: string;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Atomically create `key` (expiring after `ttlMs`); true for exactly one caller until it expires. */
  claim(key: string, ttlMs: number): Promise<boolean>;
  /** Atomic counter (no practical expiry). */
  incr(key: string): Promise<number>;
  /** Append `id` to the index `list`; {@link list} returns ids in insertion order. */
  add(list: 'runs' | 'dlq', id: string): Promise<void>;
  list(list: 'runs' | 'dlq'): Promise<string[]>;
}

const LONG = 400 * 86_400_000;

/** Over the gateway's StateStore (memory / redis / sqlite / eventlog). Keys are prefixed `task-graphs:`. */
export class StoreKv implements DurableKv {
  private readonly cache = { runs: [] as string[], dlq: [] as string[] };
  constructor(private readonly store: StateStore, private readonly prefix = 'task-graphs:') {}
  get kind() {
    return this.store.kind;
  }
  get(k: string) {
    return this.store.get(this.prefix + k);
  }
  set(k: string, v: string, ttlMs?: number) {
    return this.store.set(this.prefix + k, v, ttlMs);
  }
  del(k: string) {
    return this.store.del(this.prefix + k);
  }
  async claim(k: string, ttlMs: number) {
    return (await this.store.incr(this.prefix + k, ttlMs)) === 1;
  }
  incr(k: string) {
    return this.store.incr(this.prefix + k, LONG);
  }
  async add(list: 'runs' | 'dlq', id: string) {
    const n = await this.store.incr(`${this.prefix}${list}:seq`, LONG);
    await this.store.set(`${this.prefix}${list}:${n}`, id);
  }
  async list(list: 'runs' | 'dlq') {
    const seq = Number((await this.store.get(`${this.prefix}${list}:seq`)) ?? 0);
    const known = this.cache[list];
    for (let i = known.length + 1; i <= seq; i++) {
      const id = await this.store.get(`${this.prefix}${list}:${i}`);
      if (id === undefined) {
        // written by another instance a moment ago: retry on the next listing
        if (i > seq - 5) break;
        known.push('');
        continue;
      }
      known.push(id);
    }
    return known.filter(Boolean);
  }
}

const enc = (k: string) => Buffer.from(k).toString('base64url');

/**
 * Over a directory (the task graphs' `dir`): runs stay `<dir>/<id>.json` (the 10.7 checkpoint layout), the rest under
 * `<dir>/.durable/`. Claims use O_EXCL files, so several gateway processes on one host can share the directory.
 * Files are written 0600 (directories 0700): runs carry inputs, outputs and the caller's principal.
 */
export class DirKv implements DurableKv {
  readonly kind = 'dir';
  private readonly kv: string;
  private readonly dlqDir: string;
  constructor(private readonly dir: string) {
    this.kv = join(dir, '.durable', 'kv');
    this.dlqDir = join(dir, '.durable', 'dlq');
    for (const d of [dir, this.kv, this.dlqDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  private path(k: string): string {
    if (k.startsWith('run:')) return join(this.dir, `${k.slice(4)}.json`);
    if (k.startsWith('dlq:')) return join(this.dlqDir, `${k.slice(4)}.json`);
    return join(this.kv, enc(k));
  }
  private write(p: string, text: string) {
    const tmp = `${p}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, p);
  }
  async get(k: string) {
    const c = this.ctrValue(k);
    if (c !== undefined) return String(c);
    const p = this.path(k);
    if (!existsSync(p)) return undefined;
    try {
      const text = readFileSync(p, 'utf8');
      if (k.startsWith('run:') || k.startsWith('dlq:')) return text;
      const e = JSON.parse(text) as { v: string; exp?: number };
      if (e.exp !== undefined && e.exp <= Date.now()) return undefined;
      return e.v;
    } catch {
      return undefined;
    }
  }
  async set(k: string, v: string, ttlMs?: number) {
    const p = this.path(k);
    this.write(p, k.startsWith('run:') || k.startsWith('dlq:') ? v : JSON.stringify({ v, ...(ttlMs ? { exp: Date.now() + ttlMs } : {}) }));
  }
  async del(k: string) {
    try {
      unlinkSync(this.path(k));
    } catch {
      /* gone */
    }
  }
  async claim(k: string, ttlMs: number) {
    const p = this.path(k);
    for (let i = 0; i < 2; i++) {
      try {
        const fd = openSync(p, 'wx', 0o600);
        writeSync(fd, JSON.stringify({ v: '1', exp: Date.now() + ttlMs }));
        closeSync(fd);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        if ((await this.get(k)) !== undefined) return false;
        // expired: exactly one contender wins the rename, then retries the exclusive create
        try {
          renameSync(p, `${p}.${process.pid}.${randomUUID().slice(0, 8)}.stale`);
        } catch {
          /* someone else moved it */
        }
        for (const f of readdirSync(this.kv).filter((x) => x.startsWith(enc(k)) && x.endsWith('.stale'))) {
          try {
            unlinkSync(join(this.kv, f));
          } catch {
            /* gone */
          }
        }
      }
    }
    return false;
  }
  /** Counters are a directory of O_EXCL files (`kv/ctr/<key>/<n>`); the value is the highest n. */
  private ctr(k: string): string {
    return join(this.kv, 'ctr', enc(k));
  }
  private ctrValue(k: string): number | undefined {
    const d = this.ctr(k);
    if (!existsSync(d)) return undefined;
    return readdirSync(d).reduce((m, f) => Math.max(m, Number(f) || 0), 0);
  }
  async incr(k: string) {
    const d = this.ctr(k);
    mkdirSync(d, { recursive: true, mode: 0o700 });
    let n = this.ctrValue(k) ?? 0;
    for (;;) {
      n++;
      try {
        closeSync(openSync(join(d, String(n)), 'wx', 0o600));
        return n;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
  }
  async add() {
    /* the directory listing is the index */
  }
  async list(list: 'runs' | 'dlq') {
    const d = list === 'runs' ? this.dir : this.dlqDir;
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
      .map((f) => f.slice(0, -5));
  }
}

// ─── DLQ ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type DlqStatus = 'pending' | 'replaying' | 'exhausted' | 'replayed' | 'discarded';
export interface DlqEntry {
  id: string;
  runId: string;
  graph: string;
  node?: string;
  owner?: TaskRun['owner'];
  reason: string;
  error?: string;
  /** False when the failure is an unknown outcome: never retried automatically. */
  retryable: boolean;
  status: DlqStatus;
  retries: number;
  maxRetries: number;
  nextRetryAt?: string;
  createdAt: string;
  updatedAt: string;
  manual?: boolean;
  history: Array<{ at: string; action: string; delayMs?: number; error?: string; actor?: string }>;
}

// ─── metrics ─────────────────────────────────────────────────────────────────────────────────────────────────────

export class DurableMetrics {
  runs = new Map<string, number>();
  idempotentHits = { run: 0, call: 0 };
  resumes = new Map<string, number>();
  takeovers = 0;
  leaseLost = 0;
  outcomeUnknown = 0;
  dlqRetries = 0;
  compensations = { succeeded: 0, failed: 0 };
  dlq = new Map<string, DlqStatus>();
  awaiting = 0;
  inc(m: Map<string, number>, k: string) {
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  prometheus(): string[] {
    const out: string[] = ['# HELP mcp_gateway_task_runs_total Task-graph runs that reached an outcome, by status (14.4.0)', '# TYPE mcp_gateway_task_runs_total counter'];
    for (const [s, n] of this.runs) out.push(`mcp_gateway_task_runs_total{status="${s}"} ${n}`);
    out.push('# HELP mcp_gateway_task_idempotent_hits_total Duplicate submissions / calls answered from the stored result', '# TYPE mcp_gateway_task_idempotent_hits_total counter');
    out.push(`mcp_gateway_task_idempotent_hits_total{kind="run"} ${this.idempotentHits.run}`, `mcp_gateway_task_idempotent_hits_total{kind="call"} ${this.idempotentHits.call}`);
    out.push('# HELP mcp_gateway_task_resumes_total Executions continued from persisted state, by reason', '# TYPE mcp_gateway_task_resumes_total counter');
    for (const [r, n] of this.resumes) out.push(`mcp_gateway_task_resumes_total{reason="${r}"} ${n}`);
    out.push('# TYPE mcp_gateway_task_takeovers_total counter', `mcp_gateway_task_takeovers_total ${this.takeovers}`);
    out.push('# TYPE mcp_gateway_task_lease_lost_total counter', `mcp_gateway_task_lease_lost_total ${this.leaseLost}`);
    out.push('# HELP mcp_gateway_task_outcome_unknown_total Calls left in doubt by a crash or timeout (not repeated)', '# TYPE mcp_gateway_task_outcome_unknown_total counter', `mcp_gateway_task_outcome_unknown_total ${this.outcomeUnknown}`);
    out.push('# TYPE mcp_gateway_task_dlq_retries_total counter', `mcp_gateway_task_dlq_retries_total ${this.dlqRetries}`);
    out.push('# TYPE mcp_gateway_task_compensations_total counter', `mcp_gateway_task_compensations_total{result="succeeded"} ${this.compensations.succeeded}`, `mcp_gateway_task_compensations_total{result="failed"} ${this.compensations.failed}`);
    out.push('# HELP mcp_gateway_task_dlq_entries DLQ entries by status (as last seen by this instance)', '# TYPE mcp_gateway_task_dlq_entries gauge');
    const by = new Map<string, number>();
    for (const s of this.dlq.values()) by.set(s, (by.get(s) ?? 0) + 1);
    for (const s of ['pending', 'replaying', 'exhausted', 'replayed', 'discarded']) out.push(`mcp_gateway_task_dlq_entries{status="${s}"} ${by.get(s) ?? 0}`);
    out.push('# TYPE mcp_gateway_task_awaiting_approval gauge', `mcp_gateway_task_awaiting_approval ${this.awaiting}`);
    return out;
  }
}

// ─── the manager ─────────────────────────────────────────────────────────────────────────────────────────────────

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL: TaskRunStatus[] = ['succeeded', 'failed', 'cancelled', 'compensated', 'compensation_failed', 'interrupted'];

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface Active {
  epoch: number;
  cancel: boolean;
  crashed: boolean;
  hb?: NodeJS.Timeout;
  done: Promise<TaskRun>;
}

export interface DurableDeps {
  exec: (run: TaskRun) => TaskExecutor;
  /** The task-graph engine (injected by the task-graphs module). */
  engine: {
    executeRun: (run: TaskRun, exec: TaskExecutor, opts: RunOptions) => Promise<TaskRun>;
    finishCompensation: (run: TaskRun, exec: TaskExecutor, opts: RunOptions) => Promise<TaskRun>;
  };
  setInterval: (fn: () => void, ms: number) => NodeJS.Timeout;
  clear: (t: NodeJS.Timeout | undefined) => void;
  /** Whether the upstream servers the run still needs are connected (resume waits for them after a start). */
  ready?: (run: TaskRun) => boolean;
}

/** How long a resume / DLQ retry waits for the run's upstream servers to connect after the gateway started. */
export const READY_GRACE_MS = 60_000;

export class DurableTasks {
  readonly instance = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  readonly active = new Map<string, Active>();
  readonly metrics: DurableMetrics;
  private stopping = false;
  private sweeper?: NodeJS.Timeout;
  private sweeping = false;
  private sweeps = 0;
  private readonly terminal = new Set<string>();

  constructor(readonly kv: DurableKv, readonly cfg: DurableCfg, private readonly deps: DurableDeps, metrics?: DurableMetrics) {
    this.metrics = metrics ?? new DurableMetrics();
  }

  get backend(): string {
    return this.kv.kind;
  }

  private startedAt = Date.now();
  /** False while the run's servers are still connecting (bounded by {@link READY_GRACE_MS} after start). */
  private ready(r: TaskRun): boolean {
    return !this.deps.ready || this.deps.ready(r) || Date.now() - this.startedAt > READY_GRACE_MS;
  }

  start(): void {
    this.startedAt = Date.now();
    this.sweeper = this.deps.setInterval(() => void this.sweep(), this.cfg.sweepIntervalMs);
    setTimeout(() => void this.sweep(), 0).unref?.();
  }

  /** Graceful stop: executions stop at their next step, leases are released so a restart (or a peer) resumes at once. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.deps.clear(this.sweeper);
    for (const [id, a] of this.active) {
      this.deps.clear(a.hb);
      if (a.crashed) continue;
      try {
        const doc = await this.load(id);
        if (doc && doc.epoch === a.epoch && (await this.epochOf(id)) === a.epoch) {
          delete doc.executor;
          await this.kv.set(`run:${id}`, JSON.stringify(doc));
        }
        await this.kv.del(`hb:${id}`);
      } catch (e) {
        logger.warn(`task-graphs: releasing run ${id} on stop failed: ${(e as Error).message}`);
      }
    }
    this.active.clear();
  }

  // runs

  async load(id: string): Promise<TaskRun | undefined> {
    const t = await this.kv.get(`run:${id}`);
    if (!t) return undefined;
    try {
      return JSON.parse(t) as TaskRun;
    } catch {
      return undefined;
    }
  }

  async list(): Promise<TaskRun[]> {
    const ids = await this.kv.list('runs');
    const runs = await Promise.all(ids.map((id) => this.load(id)));
    return runs.filter((r): r is TaskRun => !!r);
  }

  private async epochOf(id: string): Promise<number> {
    return Number((await this.kv.get(`epoch:${id}`)) ?? 0);
  }

  private async fence(id: string, a: Active): Promise<void> {
    if (a.crashed) throw new SimulatedCrash();
    if (this.stopping) throw new LeaseLost('the gateway is stopping');
    if ((await this.epochOf(id)) !== a.epoch) {
      this.metrics.leaseLost++;
      throw new LeaseLost(`run ${id}: another instance holds the lease`);
    }
  }

  private async put(run: TaskRun, fresh = false): Promise<void> {
    await this.kv.set(`run:${run.id}`, JSON.stringify(run));
    if (fresh) await this.kv.add('runs', run.id);
  }

  private audit(run: TaskRun, action: string, actor: string, extra: { node?: string; reason?: string } = {}): void {
    (run.audit ??= []).push({ at: now(), action, actor, ...extra, instance: this.instance });
    if (run.audit.length > 200) run.audit.splice(0, run.audit.length - 200);
    logger.info(`audit: task-graphs run ${run.id} (${run.graph}) ${action} by ${actor}${extra.node ? ` node ${extra.node}` : ''}${extra.reason ? `: ${extra.reason}` : ''}`);
  }

  /** Per-run mutation lock for API changes to runs no executor holds (approve, replay, discard, timeout). */
  private async locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const key = `lock:${id}`;
    for (let i = 0; !(await this.kv.claim(key, 5_000)); i++) {
      if (i > 60) throw new HttpError(409, `run ${id} is being changed by another request; try again`);
      await sleep(50);
    }
    try {
      return await fn();
    } finally {
      await this.kv.del(key);
    }
  }

  /** Claim the run (new fencing epoch + lease) and execute it here. `mode` compensate continues a saga rollback. */
  private async acquireAndRun(run: TaskRun, mode: 'run' | 'compensate', reason?: string): Promise<{ run: TaskRun; done: Promise<TaskRun> }> {
    const epoch = await this.kv.incr(`epoch:${run.id}`);
    run.epoch = epoch;
    run.executor = this.instance;
    await this.kv.set(`hb:${run.id}`, `${this.instance}#${epoch}`, this.cfg.leaseMs);
    if (reason) this.metrics.inc(this.metrics.resumes, reason);
    const a: Active = { epoch, cancel: false, crashed: false, done: undefined as unknown as Promise<TaskRun> };
    this.active.set(run.id, a);
    this.terminal.delete(run.id);
    a.hb = this.deps.setInterval(() => void this.heartbeat(run.id, a), Math.max(100, Math.floor(this.cfg.leaseMs / 3)));
    const guard = this.guard(run, a);
    const opts = {
      checkpoint: async (r: TaskRun) => {
        await this.fence(r.id, a);
        await this.put(r);
      },
      guard,
      cancelled: () => a.cancel,
      onFailure: (r: TaskRun) => this.onFailure(r),
    };
    const exec = this.deps.exec(run);
    const go = mode === 'compensate' ? this.deps.engine.finishCompensation(run, exec, opts) : this.deps.engine.executeRun(run, exec, opts);
    a.done = go
      .then(async (r) => {
        await this.finished(r, a);
        return r;
      })
      .catch((e) => {
        if (e instanceof SimulatedCrash) a.crashed = true;
        else if (!(e instanceof LeaseLost)) logger.error(`task-graphs: run ${run.id} execution failed: ${(e as Error).message}`);
        return run;
      })
      .finally(() => {
        this.deps.clear(a.hb);
        if (this.active.get(run.id) === a) this.active.delete(run.id);
      });
    return { run, done: a.done };
  }

  private async heartbeat(id: string, a: Active): Promise<void> {
    if (a.crashed) return;
    try {
      durableFaults.heartbeat?.({ instance: this.instance, runId: id });
    } catch (e) {
      if (e instanceof SimulatedCrash) {
        a.crashed = true;
        this.deps.clear(a.hb);
        return;
      }
    }
    try {
      if ((await this.epochOf(id)) !== a.epoch) return void this.deps.clear(a.hb);
      await this.kv.set(`hb:${id}`, `${this.instance}#${a.epoch}`, this.cfg.leaseMs);
      if (await this.kv.get(`cancel:${id}`)) a.cancel = true;
    } catch (e) {
      logger.warn(`task-graphs: lease renewal for run ${id} failed: ${(e as Error).message}`);
    }
  }

  private async finished(r: TaskRun, a: Active): Promise<void> {
    if (a.crashed) return;
    if (TERMINAL.includes(r.status) || r.status === 'dead_letter') this.metrics.inc(this.metrics.runs, r.status);
    for (const n of r.nodes) {
      if (n.status === 'compensated') this.metrics.compensations.succeeded++;
      if (n.status === 'compensation_failed') this.metrics.compensations.failed++;
    }
    if (r.dlq && r.status !== 'dead_letter') {
      const e = await this.dlqEntry(r.dlq);
      if (e && (e.status === 'replaying' || e.status === 'pending')) {
        e.status = r.status === 'succeeded' ? 'replayed' : e.status;
        if (e.status === 'replaying') e.status = 'exhausted';
        e.history.push({ at: now(), action: r.status === 'succeeded' ? 'succeeded' : `ended ${r.status}` });
        await this.saveDlq(e);
      }
    }
    if ((await this.epochOf(r.id)) === a.epoch) {
      await this.kv.del(`hb:${r.id}`);
      await this.kv.del(`cancel:${r.id}`);
    }
    if (TERMINAL.includes(r.status)) this.terminal.add(r.id);
  }

  private guard(run: TaskRun, a: Active): CallGuard {
    const fault = (point: 'afterCall' | 'afterCommit', info: CallInfo) => {
      try {
        durableFaults[point]?.(info);
      } catch (e) {
        if (e instanceof SimulatedCrash) a.crashed = true;
        throw e;
      }
    };
    return {
      fence: () => this.fence(run.id, a),
      committed: async (key) => {
        const t = await this.kv.get(`result:${key}`);
        if (!t) return undefined;
        this.metrics.idempotentHits.call++;
        return JSON.parse(t) as ProxyResponse;
      },
      inDoubt: async (key) => {
        const t = await this.kv.get(`intent:${key}`);
        const doubt = !!t && (JSON.parse(t) as { state: string }).state === 'started';
        if (doubt) this.metrics.outcomeUnknown++;
        return doubt;
      },
      begin: async (key, info) => {
        await this.kv.set(`intent:${key}`, JSON.stringify({ state: 'started', epoch: a.epoch, instance: this.instance, attempt: info.attempt, at: now() }));
        await this.fence(run.id, a); // Dekker-style: a taker-over either sees this intent or we see its epoch
      },
      commit: async (key, r) => {
        await this.kv.set(`result:${key}`, JSON.stringify(r));
        await this.kv.set(`intent:${key}`, JSON.stringify({ state: 'committed', epoch: a.epoch, at: now() }));
        await this.fence(run.id, a);
      },
      fail: async (key) => {
        await this.fence(run.id, a);
        await this.kv.set(`intent:${key}`, JSON.stringify({ state: 'failed', epoch: a.epoch, at: now() }));
      },
      fault,
    };
  }

  // DLQ

  async dlqEntry(id: string): Promise<DlqEntry | undefined> {
    const t = await this.kv.get(`dlq:${id}`);
    if (!t) return undefined;
    const e = JSON.parse(t) as DlqEntry;
    this.metrics.dlq.set(e.id, e.status);
    return e;
  }
  private async saveDlq(e: DlqEntry, fresh = false): Promise<void> {
    e.updatedAt = now();
    await this.kv.set(`dlq:${e.id}`, JSON.stringify(e));
    if (fresh) await this.kv.add('dlq', e.id);
    this.metrics.dlq.set(e.id, e.status);
  }
  async dlqList(): Promise<DlqEntry[]> {
    const ids = await this.kv.list('dlq');
    const es = await Promise.all(ids.map((id) => this.dlqEntry(id)));
    return es.filter((e): e is DlqEntry => !!e);
  }

  /** Engine callback on a retryable failure: park the run in the DLQ (and schedule a retry) or compensate now. */
  private async onFailure(run: TaskRun): Promise<'park' | 'compensate'> {
    if (!this.cfg.dlq.enabled) return 'compensate';
    const node = run.failedNode ? run.nodes.find((n) => n.id === run.failedNode) : undefined;
    const retryable = node?.status !== 'outcome_unknown';
    const policy = this.cfg.dlq.retry;
    let e = run.dlq ? await this.dlqEntry(run.dlq) : undefined;
    const fresh = !e || e.status === 'replayed' || e.status === 'discarded';
    if (fresh) {
      e = { id: `dlq-${randomUUID()}`, runId: run.id, graph: run.graph, node: node?.id, owner: run.owner, reason: '', retryable, status: 'pending', retries: 0, maxRetries: policy.attempts, createdAt: now(), updatedAt: now(), history: [] };
      run.dlq = e.id;
    }
    const entry = e!;
    entry.node = node?.id;
    entry.retryable = retryable;
    entry.error = node?.error ?? run.error;
    entry.reason = retryable ? `node ${node?.id ?? '?'} failed: ${entry.error ?? 'failed'}` : `node ${node?.id ?? '?'}: outcome unknown — the call may have run upstream; not repeated automatically`;
    const manual = entry.status === 'replaying' && entry.manual;
    if (retryable && !manual && entry.retries < policy.attempts) {
      const base = Math.min(policy.maxBackoffMs, policy.backoffMs * policy.factor ** entry.retries);
      const delay = policy.jitter ? Math.floor(Math.random() * base) : base;
      entry.status = 'pending';
      entry.nextRetryAt = new Date(Date.now() + delay).toISOString();
      entry.history.push({ at: now(), action: 'scheduled', delayMs: delay, error: entry.error });
    } else {
      entry.status = 'exhausted';
      delete entry.nextRetryAt;
      entry.history.push({ at: now(), action: retryable ? (manual ? 'replay failed' : 'exhausted') : 'held (outcome unknown)', error: entry.error });
    }
    delete entry.manual;
    await this.saveDlq(entry, fresh);
    this.audit(run, 'dead_letter', 'system:dlq', { node: node?.id, reason: entry.reason });
    return 'park';
  }

  // sweeping: takeovers, approval timeouts, DLQ retries

  async sweep(): Promise<void> {
    if (this.sweeping || this.stopping) return;
    this.sweeping = true;
    const first = this.sweeps++ === 0;
    try {
      const runs = await this.list();
      let awaiting = 0;
      const full = first || this.sweeps % 30 === 0;
      for (const r of runs) {
        if (this.stopping) return;
        if (this.active.has(r.id) || (!full && this.terminal.has(r.id))) continue;
        if (TERMINAL.includes(r.status)) {
          this.terminal.add(r.id);
          continue;
        }
        if (r.status === 'running' || r.status === 'compensating') await this.maybeTakeOver(r);
        else if (r.status === 'awaiting_approval') {
          awaiting++;
          await this.expireApprovals(r);
        }
      }
      this.metrics.awaiting = awaiting;
      const due = (await this.dlqList()).filter((e) => e.status === 'pending' && e.nextRetryAt && Date.parse(e.nextRetryAt) <= Date.now());
      for (const e of due) {
        const run = runs.find((x) => x.id === e.runId);
        if (run && !this.ready(run)) continue;
        await this.retry(e);
      }
    } catch (e) {
      logger.warn(`task-graphs: durable sweep failed: ${(e as Error).message}`);
    } finally {
      this.sweeping = false;
    }
  }

  private async maybeTakeOver(r: TaskRun): Promise<void> {
    if (await this.kv.get(`hb:${r.id}`)) return;
    if (!this.ready(r)) return; // just started: wait until the upstream servers it needs are connected
    // one contender per epoch: the claim keeps two sweepers from both incrementing for the same lapsed lease
    if (!(await this.kv.claim(`takeover:${r.id}:${r.epoch ?? 0}`, this.cfg.leaseMs * 2))) return;
    const fresh = await this.load(r.id);
    if (!fresh || !['running', 'compensating'].includes(fresh.status) || (fresh.epoch ?? 0) !== (r.epoch ?? 0) || (await this.kv.get(`hb:${r.id}`))) return;
    if (!this.cfg.resumeOnStart) {
      fresh.status = 'interrupted';
      fresh.error = 'the gateway stopped while the run was in flight (durable.resumeOnStart is off: resume it via the API)';
      for (const n of fresh.nodes) if (n.status === 'running') n.status = 'pending';
      this.audit(fresh, 'interrupted', 'system:durable');
      await this.put(fresh);
      return;
    }
    const lapsed = !!fresh.executor; // released on a graceful stop → plain resume
    if (lapsed) {
      this.metrics.takeovers++;
      this.audit(fresh, 'takeover', 'system:durable', { reason: `lease of ${fresh.executor} lapsed` });
    }
    this.audit(fresh, 'resume', 'system:durable', { reason: lapsed ? 'lease lapsed' : 'restart' });
    fresh.resumes++;
    await this.acquireAndRun(fresh, fresh.status === 'compensating' ? 'compensate' : 'run', lapsed ? 'takeover' : 'restart');
  }

  private async expireApprovals(r: TaskRun): Promise<void> {
    const due = r.nodes.filter((n) => n.status === 'awaiting_approval' && n.approval?.state === 'pending' && Date.parse(n.approval.expiresAt) <= Date.now());
    if (!due.length) return;
    if (!(await this.kv.claim(`expire:${r.id}:${due.map((n) => n.id).join(',')}`, 60_000))) return;
    await this.locked(r.id, async () => {
      const run = await this.load(r.id);
      if (!run || run.status !== 'awaiting_approval') return;
      let changed = false;
      for (const n of run.nodes) {
        if (n.status !== 'awaiting_approval' || n.approval?.state !== 'pending' || Date.parse(n.approval.expiresAt) > Date.now()) continue;
        n.approval.state = 'expired';
        n.approval.error = `approval timed out after ${Math.round((Date.parse(n.approval.expiresAt) - Date.parse(n.approval.requestedAt)) / 1000)} s`;
        this.audit(run, 'timeout', 'system:approval-timeout', { node: n.id });
        changed = true;
      }
      if (changed) await this.acquireAndRun(run, 'run', 'approval');
    });
  }

  private async retry(e: DlqEntry): Promise<void> {
    if (!(await this.kv.claim(`dlqretry:${e.id}:${e.retries + 1}`, LONG))) return;
    await this.locked(e.runId, async () => {
      const entry = await this.dlqEntry(e.id);
      const run = await this.load(e.runId);
      if (!entry || entry.status !== 'pending' || !run || run.status !== 'dead_letter') return;
      entry.retries++;
      entry.status = 'replaying';
      entry.history.push({ at: now(), action: 'retry', actor: 'system:dlq' });
      await this.saveDlq(entry);
      this.metrics.dlqRetries++;
      this.audit(run, 'retry', 'system:dlq', { reason: `DLQ retry ${entry.retries}/${entry.maxRetries}` });
      await this.acquireAndRun(run, 'run', 'dlq');
    });
  }

  // API operations

  /** Start a new run, or return the run an earlier submission with the same (owner, key) started. */
  async submit(run: TaskRun, key: string | undefined): Promise<{ run: TaskRun; duplicate: boolean; done?: Promise<TaskRun> }> {
    if (key !== undefined) {
      const ns = `${sha(run.owner?.clientId ?? 'anonymous')}:${sha(key)}`;
      const fp = sha(JSON.stringify([run.graph, run.input]));
      const ttl = this.cfg.idempotencyTtlSeconds * 1000;
      if (!(await this.kv.claim(`idem:${ns}`, ttl))) {
        for (let i = 0; i < 100; i++) {
          const t = await this.kv.get(`idemrun:${ns}`);
          if (t) {
            const ref = JSON.parse(t) as { runId: string; fp: string };
            if (ref.fp !== fp) throw new HttpError(409, 'this idempotency key was used for a different request (graph / input differ)');
            const prev = await this.load(ref.runId);
            if (prev) {
              this.metrics.idempotentHits.run++;
              return { run: prev, duplicate: true };
            }
          }
          await sleep(50);
        }
        throw new HttpError(409, 'a request with this idempotency key is still being accepted; retry shortly');
      }
      run.idempotencyKey = key;
      this.audit(run, 'submit', run.owner?.clientId ?? 'anonymous');
      await this.put(run, true);
      await this.kv.set(`idemrun:${ns}`, JSON.stringify({ runId: run.id, fp }), ttl);
    } else {
      this.audit(run, 'submit', run.owner?.clientId ?? 'anonymous');
      await this.put(run, true);
    }
    const { done } = await this.acquireAndRun(run, 'run');
    return { run, duplicate: false, done };
  }

  /** Approve / deny one approval-gated node. Resumes the run when no decision is outstanding. */
  async decide(id: string, nodeId: string | undefined, actor: string, decision: 'approve' | 'deny', reason: string | undefined, override: boolean): Promise<{ run: TaskRun; done?: Promise<TaskRun> }> {
    return this.locked(id, async () => {
      const run = await this.load(id);
      if (!run) throw new HttpError(404, `no run ${id}`);
      if (run.status !== 'awaiting_approval') throw new HttpError(409, `run is ${run.status}, not awaiting approval`);
      const pending = run.nodes.filter((n) => n.status === 'awaiting_approval' && n.approval?.state === 'pending');
      const node = nodeId ? pending.find((n) => n.id === nodeId) : pending.length === 1 ? pending[0] : undefined;
      if (!node) throw new HttpError(nodeId ? 404 : 400, nodeId ? `node ${nodeId} is not awaiting approval` : `several nodes await approval; name one (${pending.map((n) => n.id).join(', ')})`);
      const ap = node.approval!;
      if (!override) {
        if (actor === run.owner?.clientId) throw new HttpError(403, 'the requester cannot decide on its own run');
        if (!ap.approvers.some((p) => globMatch(p, actor))) throw new HttpError(403, `${actor} is not an approver of node ${node.id}`);
        if (ap.decisions.some((d) => d.by === actor)) throw new HttpError(409, `${actor} already decided on node ${node.id}`);
      }
      ap.decisions.push({ by: actor, decision, at: now(), ...(reason ? { reason } : {}) });
      this.audit(run, decision, actor, { node: node.id, ...(reason ? { reason } : {}), ...(override ? {} : {}) });
      if (decision === 'deny') {
        ap.state = 'denied';
        ap.error = `approval denied by ${actor}${reason ? `: ${reason}` : ''}`;
      } else if (override || ap.decisions.filter((d) => d.decision === 'approve').length >= ap.required) ap.state = 'approved';
      const outstanding = run.nodes.some((n) => n.status === 'awaiting_approval' && n.approval?.state === 'pending');
      if (outstanding && ap.state !== 'denied') {
        await this.put(run);
        return { run };
      }
      const { done } = await this.acquireAndRun(run, 'run', 'approval');
      return { run, done };
    });
  }

  /** Operator resume of a failed / interrupted / cancelled / compensated run (10.7 semantics, durable). */
  async resume(id: string, actor: string): Promise<{ run: TaskRun; done: Promise<TaskRun> }> {
    return this.locked(id, async () => {
      const r = await this.load(id);
      if (!r) throw new HttpError(404, `no run ${id}`);
      const RESUMABLE: TaskRunStatus[] = ['failed', 'interrupted', 'cancelled', 'compensated', 'compensation_failed'];
      if (this.active.has(id) || !RESUMABLE.includes(r.status)) throw new HttpError(409, `run is ${this.active.has(id) ? 'in flight' : r.status}; only ${RESUMABLE.join(' / ')} runs can be resumed`);
      for (const n of r.nodes)
        if (n.status === 'compensated' || n.status === 'compensation_failed') {
          n.status = 'pending';
          delete n.output;
          r.completed = r.completed.filter((x) => x !== n.id);
          await this.kv.del(`result:${r.id}:${n.id}`);
          await this.kv.del(`intent:${r.id}:${n.id}`);
          await this.kv.del(`result:${r.id}:${n.id}:compensate`);
          await this.kv.del(`intent:${r.id}:${n.id}:compensate`);
        }
      r.resumes++;
      this.audit(r, 'resume', actor);
      return this.acquireAndRun(r, 'run', 'operator');
    });
  }

  async cancel(id: string, actor: string): Promise<{ status: string; done?: Promise<TaskRun> }> {
    const local = this.active.get(id);
    if (local) {
      local.cancel = true;
      return { status: 'cancelling', done: local.done };
    }
    return this.locked(id, async () => {
      const r = await this.load(id);
      if (!r) throw new HttpError(404, `no run ${id}`);
      if (r.status === 'running' || r.status === 'compensating') {
        await this.kv.set(`cancel:${id}`, actor, 86_400_000);
        return { status: 'cancelling' };
      }
      if (r.status !== 'awaiting_approval' && r.status !== 'dead_letter') throw new HttpError(409, 'run is not in flight');
      this.audit(r, 'cancel', actor);
      r.error = 'cancelled';
      for (const n of r.nodes) if (n.status === 'awaiting_approval') Object.assign(n, { status: 'skipped', approval: n.approval ? { ...n.approval, state: 'cancelled' } : undefined });
      if (r.dlq) await this.closeDlq(r.dlq, 'discarded', actor, 'run cancelled');
      const { done } = await this.acquireAndRun(r, 'compensate');
      return { status: 'cancelling', done };
    });
  }

  private async closeDlq(id: string, status: DlqStatus, actor: string, action: string): Promise<void> {
    const e = await this.dlqEntry(id);
    if (!e) return;
    e.status = status;
    delete e.nextRetryAt;
    e.history.push({ at: now(), action, actor });
    await this.saveDlq(e);
  }

  async replay(id: string, force: boolean, actor: string): Promise<{ entry: DlqEntry; done: Promise<TaskRun> }> {
    const e0 = await this.dlqEntry(id);
    if (!e0) throw new HttpError(404, `no DLQ entry ${id}`);
    return this.locked(e0.runId, async () => {
      const e = (await this.dlqEntry(id))!;
      if (!['pending', 'exhausted'].includes(e.status)) throw new HttpError(409, `DLQ entry is ${e.status}`);
      const run = await this.load(e.runId);
      if (!run || run.status !== 'dead_letter') throw new HttpError(409, `run is ${run?.status ?? 'missing'}`);
      const unknown = run.nodes.filter((n) => n.status === 'outcome_unknown');
      if (unknown.length && !force)
        throw new HttpError(409, `node(s) ${unknown.map((n) => n.id).join(', ')} have an unknown outcome (the call may have run upstream); replay with {"force":true} to execute again, or discard`);
      for (const n of unknown) await this.kv.set(`intent:${run.id}:${n.id}`, JSON.stringify({ state: 'forced', by: actor, at: now() }));
      e.status = 'replaying';
      e.manual = true;
      e.history.push({ at: now(), action: force ? 'replay (force)' : 'replay', actor });
      await this.saveDlq(e);
      this.audit(run, 'replay', actor, force ? { reason: 'force: unknown outcomes executed again' } : {});
      run.resumes++;
      const { done } = await this.acquireAndRun(run, 'run', 'dlq');
      return { entry: e, done };
    });
  }

  async discard(id: string, compensate: boolean, actor: string): Promise<{ entry: DlqEntry; done: Promise<TaskRun | undefined> }> {
    const e0 = await this.dlqEntry(id);
    if (!e0) throw new HttpError(404, `no DLQ entry ${id}`);
    return this.locked(e0.runId, async () => {
      const e = (await this.dlqEntry(id))!;
      if (!['pending', 'exhausted'].includes(e.status)) throw new HttpError(409, `DLQ entry is ${e.status}`);
      const run = await this.load(e.runId);
      e.status = 'discarded';
      delete e.nextRetryAt;
      e.history.push({ at: now(), action: compensate ? 'discard (compensate)' : 'discard', actor });
      await this.saveDlq(e);
      if (!run || run.status !== 'dead_letter') return { entry: e, done: Promise.resolve(run) };
      this.audit(run, 'discard', actor);
      if (!compensate) {
        run.status = 'failed';
        run.finishedAt = now();
        await this.put(run);
        return { entry: e, done: Promise.resolve(run) };
      }
      const { done } = await this.acquireAndRun(run, 'compensate');
      return { entry: e, done };
    });
  }
}

/** Client-id glob (`*`, `?`). */
export function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return re.test(value);
}

/** Build the persistence for a durable config: gateway store → checkpoint dir → memory (`auto`). */
export function durableKv(cfg: DurableCfg, store: StateStore | undefined, dir: string | undefined): DurableKv {
  const b = cfg.backend;
  if ((b === 'store' || b === 'auto') && store && store.kind !== 'memory') return new StoreKv(store);
  if ((b === 'dir' || b === 'auto') && dir) return new DirKv(dir);
  if (b === 'dir' && !dir) throw new Error('features.taskGraphs.durable.backend is "dir" but features.taskGraphs.dir is not set');
  if (b === 'store' && store) return new StoreKv(store);
  return new StoreKv(new MemoryStateStore());
}
