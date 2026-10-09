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

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { registerFeature, objectBody, badRequest, principalOf } from '../gateway/features.js';
import { deniedPrincipal, type Principal } from '../auth/authorizer.js';
import { parseTarget, readPath, render, stepValue } from '../orchestration/chains.js';
import { A2aFederationSchema, sendToRemote } from './a2a-federation.js';
import type { GatewayConfig, ProxyResponse } from '../utils/types.js';
import { logger } from '../utils/logger.js';

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Target = z.string().refine((t) => !!parseTarget(t), 'must be "server/tool"');

const Retry = z
  .object({
    attempts: z.number().int().min(1).max(20).default(1),
    backoffMs: z.number().int().min(0).max(600_000).default(200),
    factor: z.number().min(1).max(10).default(2),
    maxBackoffMs: z.number().int().min(0).max(3_600_000).default(30_000),
    jitter: z.boolean().default(false),
  })
  .strict();

const NodeSchema = z
  .object({
    id: Id,
    tool: Target.optional(),
    remote: z.object({ gateway: z.string().min(1), skill: z.string().min(1) }).strict().optional(),
    args: z.record(z.unknown()).default({}),
    needs: z.array(Id).default([]),
    if: z.string().optional(),
    retry: Retry.default({}),
    timeoutMs: z.number().int().min(1).max(3_600_000).optional(),
    onError: z.enum(['fail', 'continue']).default('fail'),
    compensate: z.object({ tool: Target, args: z.record(z.unknown()).default({}) }).strict().optional(),
  })
  .strict()
  .refine((n) => (n.tool === undefined) !== (n.remote === undefined), { message: 'a node needs exactly one of "tool" or "remote"' });

const GraphSchema = z
  .object({ id: Id, description: z.string().optional(), concurrency: z.number().int().min(1).max(64).default(8), nodes: z.array(NodeSchema).min(1), output: z.unknown().optional() })
  .strict()
  .superRefine((g, ctx) => {
    const ids = new Set<string>();
    for (const n of g.nodes) {
      if (ids.has(n.id)) ctx.addIssue({ code: 'custom', message: `task graph ${g.id}: duplicate node ${n.id}` });
      ids.add(n.id);
    }
    for (const n of g.nodes) for (const d of n.needs) if (!ids.has(d)) ctx.addIssue({ code: 'custom', message: `task graph ${g.id}: node ${n.id} needs unknown node ${d}` });
    if (!topoLayers(g.nodes)) ctx.addIssue({ code: 'custom', message: `task graph ${g.id}: the nodes form a cycle` });
  });

export const TaskGraphsSchema = z
  .object({
    enabled: z.boolean().default(true),
    dir: z.string().min(1).optional(),
    maxRuns: z.number().int().min(1).max(100_000).default(500),
    graphs: z.array(GraphSchema).min(1),
  })
  .strict()
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.graphs.forEach((g, i) => {
      if (seen.has(g.id)) ctx.addIssue({ code: 'custom', path: ['graphs', i, 'id'], message: `duplicate task graph "${g.id}"` });
      seen.add(g.id);
    });
  });
export type TaskGraphsConfig = z.input<typeof TaskGraphsSchema>;
type Parsed = z.output<typeof TaskGraphsSchema>;
export type GraphCfg = z.output<typeof GraphSchema>;
type NodeCfg = z.output<typeof NodeSchema>;

export type TaskNodeStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'compensated' | 'compensation_failed';
export interface TaskNodeRun {
  id: string;
  status: TaskNodeStatus;
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  output?: Record<string, unknown>;
  compensationError?: string;
}
export type TaskRunStatus = 'running' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled' | 'compensating' | 'compensated' | 'compensation_failed';
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
}

/** How one node is executed. Local tools go through the invoker; remote ones through A2A federation. */
export interface TaskExecutor {
  tool: (serverId: string, tool: string, args: Record<string, unknown>, clientId: string | undefined) => Promise<ProxyResponse>;
  remote: (gateway: string, skill: string, args: Record<string, unknown>, clientId: string | undefined) => Promise<ProxyResponse>;
}

export interface RunOptions {
  /** Persist the run after each change. */
  checkpoint?: (run: TaskRun) => void;
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

function withTimeout<T>(p: Promise<T>, ms: number | undefined, what: string): Promise<T> {
  if (!ms) return p;
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms)))]).finally(() => clearTimeout(t));
}

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
  const save = () => {
    run.updatedAt = now();
    opts.checkpoint?.(run);
  };
  const byId = new Map(run.nodes.map((n) => [n.id, n]));
  const cfgOf = new Map(g.nodes.map((n) => [n.id, n]));
  // On resume: anything not succeeded / skipped-by-condition starts over.
  for (const n of run.nodes) if (n.status !== 'succeeded') Object.assign(n, { status: 'pending', error: undefined, finishedAt: undefined });
  run.status = 'running';
  delete run.error;
  delete run.finishedAt;
  save();

  const values = (): Record<string, unknown> => Object.fromEntries(run.nodes.filter((n) => n.output).map((n) => [n.id, n.output]));
  const scope = () => ({ input: run.input, nodes: values(), run: { id: run.id, graph: run.graph } });
  let failed: string | undefined;

  const call = async (n: NodeCfg, args: Record<string, unknown>): Promise<ProxyResponse> => {
    try {
      if (n.tool) {
        const t = parseTarget(n.tool)!;
        return await withTimeout(exec.tool(t.serverId, t.tool, args, run.clientId), n.timeoutMs, `node ${n.id}`);
      }
      return await withTimeout(exec.remote(n.remote!.gateway, n.remote!.skill, args, run.clientId), n.timeoutMs, `node ${n.id}`);
    } catch (e) {
      return { success: false, durationMs: 0, error: { code: -32603, message: (e as Error).message } };
    }
  };

  const runNode = async (n: NodeCfg): Promise<void> => {
    const rec = byId.get(n.id)!;
    const blocked = n.needs.some((d) => ['failed', 'skipped'].includes(byId.get(d)!.status));
    if (failed || blocked || opts.cancelled?.() || (n.if !== undefined && !readPath(scope(), n.if))) {
      rec.status = 'skipped';
      save();
      return;
    }
    rec.status = 'running';
    rec.startedAt = now();
    rec.attempts = 0;
    save();
    for (let a = 1; a <= n.retry.attempts; a++) {
      rec.attempts = a;
      const r = await call(n, render(n.args, scope()) as Record<string, unknown>);
      if (r.success) {
        rec.output = stepValue(r.result);
        rec.status = 'succeeded';
        rec.finishedAt = now();
        delete rec.error;
        run.completed.push(n.id);
        save();
        return;
      }
      rec.error = r.error?.message ?? 'failed';
      save();
      if (a < n.retry.attempts) {
        if (opts.cancelled?.()) break;
        await wait(backoff(n.retry, a, random));
      }
    }
    rec.status = 'failed';
    rec.finishedAt = now();
    if (n.onError === 'fail' && !failed) failed = `node ${n.id}: ${rec.error}`;
    save();
  };

  const settled = (id: string) => !['pending', 'running'].includes(byId.get(id)!.status);
  const started = new Set(run.nodes.filter((n) => n.status === 'succeeded').map((n) => n.id));
  const inflight = new Set<Promise<void>>();
  for (;;) {
    for (const n of g.nodes) {
      if (inflight.size >= g.concurrency) break;
      if (started.has(n.id) || !n.needs.every(settled)) continue;
      started.add(n.id);
      const p: Promise<void> = runNode(n).finally(() => inflight.delete(p));
      inflight.add(p);
    }
    if (!inflight.size) break;
    await Promise.race(inflight);
  }

  const cancelled = opts.cancelled?.() ?? false;
  if (!failed && !cancelled) {
    run.status = 'succeeded';
    if (g.output !== undefined) run.output = render(g.output, scope());
    run.finishedAt = now();
    save();
    return run;
  }
  run.error = cancelled ? 'cancelled' : failed;
  await compensate(run, exec, cfgOf, save);
  if (cancelled && (run.status as TaskRunStatus) === 'compensated') run.status = 'cancelled';
  run.finishedAt = now();
  save();
  return run;
}

/** Run the compensations of the succeeded nodes, newest first. */
async function compensate(run: TaskRun, exec: TaskExecutor, cfgOf: Map<string, NodeCfg>, save: () => void): Promise<void> {
  const todo = [...run.completed].reverse().filter((id) => cfgOf.get(id)?.compensate && run.nodes.find((n) => n.id === id)!.status === 'succeeded');
  if (!todo.length) {
    run.status = run.error === 'cancelled' ? 'cancelled' : 'failed';
    return;
  }
  run.status = 'compensating';
  save();
  const errors: string[] = [];
  for (const id of todo) {
    const node = run.nodes.find((n) => n.id === id)!;
    const c = cfgOf.get(id)!.compensate!;
    const t = parseTarget(c.tool)!;
    const scope = { input: run.input, nodes: Object.fromEntries(run.nodes.filter((n) => n.output).map((n) => [n.id, n.output])), self: node.output ?? {}, run: { id: run.id, graph: run.graph } };
    let r: ProxyResponse;
    try {
      r = await exec.tool(t.serverId, t.tool, render(c.args, scope) as Record<string, unknown>, run.clientId);
    } catch (e) {
      r = { success: false, durationMs: 0, error: { code: -32603, message: (e as Error).message } };
    }
    if (r.success) node.status = 'compensated';
    else {
      node.status = 'compensation_failed';
      node.compensationError = r.error?.message ?? 'failed';
      errors.push(`${id}: ${node.compensationError}`);
    }
    save();
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
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `.${run.id}.tmp`);
      writeFileSync(tmp, JSON.stringify(run));
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

export const taskRuns = new TaskRunStore();
const active = new Map<string, { cancel: boolean; done: Promise<TaskRun> }>();

export function taskGraphsOf(cfg: GatewayConfig): Parsed | undefined {
  if (!cfg.taskGraphs) return undefined;
  const p = TaskGraphsSchema.parse(cfg.taskGraphs);
  return p.enabled ? p : undefined;
}

const RESUMABLE: TaskRunStatus[] = ['failed', 'interrupted', 'cancelled', 'compensated', 'compensation_failed'];

registerFeature({
  id: 'task-graphs',
  since: '10.7.0',
  summary: 'Multi-agent orchestration 2.0: cross-gateway task graphs with checkpoints, resume, retry with backoff and saga compensation',
  mount: (router, ctx) => {
    const dirOf = (c: Parsed) => (c.dir ? resolve(ctx.config().configDir ?? process.cwd(), c.dir) : undefined);
    // 11.1: nodes run as the principal that started the run (re-authorized per call), else the client's current scope.
    const exec = (run: TaskRun): TaskExecutor => ({
      tool: (s, t, a, client) => ctx.invoke(s, t, a, run.principal ?? (ctx.principalFor ?? deniedPrincipal)(client), client ?? 'task-graph'),
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
    const conf = (res: import('express').Response): Parsed | undefined => {
      const c = taskGraphsOf(ctx.config());
      if (!c) badRequest(res, 'features.taskGraphs is not configured');
      else taskRuns.load(dirOf(c));
      return c;
    };
    const start = (run: TaskRun, c: Parsed) => {
      const st = { cancel: false, done: undefined as unknown as Promise<TaskRun> };
      st.done = executeRun(run, exec(run), { checkpoint: (r) => taskRuns.save(r, dirOf(c)), cancelled: () => st.cancel }).finally(() => active.delete(run.id));
      active.set(run.id, st);
      return st.done;
    };
    const summary = (r: TaskRun) => ({ id: r.id, graph: r.graph, status: r.status, startedAt: r.startedAt, updatedAt: r.updatedAt, finishedAt: r.finishedAt ?? null, resumes: r.resumes, error: r.error });

    router.get('/', (_req, res) => {
      const c = conf(res);
      if (!c) return;
      res.json({ persisted: !!c.dir, graphs: c.graphs.map((g) => ({ id: g.id, description: g.description, nodes: g.nodes.length, layers: topoLayers(g.nodes), remoteNodes: g.nodes.filter((n) => n.remote).map((n) => n.id), compensable: g.nodes.filter((n) => n.compensate).map((n) => n.id) })), active: active.size });
    });
    router.post('/run', async (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      const c = conf(res);
      if (!c) return;
      const g = c.graphs.find((x) => x.id === b.graph);
      if (!g) return void res.status(404).json({ error: 'Not Found', message: `unknown task graph ${JSON.stringify(b.graph)}` });
      if (b.input !== undefined && (typeof b.input !== 'object' || b.input === null || Array.isArray(b.input))) return badRequest(res, '"input" must be an object');
      const run = newRun(g, (b.input as Record<string, unknown>) ?? {}, (req as { clientId?: string }).clientId);
      run.principal = principalOf(req);
      const done = start(run, c);
      if (b.wait === true) return void res.json(await done);
      res.status(202).json({ runId: run.id, status: run.status });
    });
    router.get('/runs', (req, res) => {
      const c = conf(res);
      if (!c) return;
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      res.json({ runs: [...taskRuns.runs.values()].filter((r) => !status || r.status === status).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(summary) });
    });
    router.get('/runs/:id', (req, res) => {
      if (!conf(res)) return;
      const r = taskRuns.runs.get(req.params.id);
      if (!r) return void res.status(404).json({ error: 'Not Found', message: `no run ${req.params.id}` });
      res.json(r);
    });
    router.post('/runs/:id/resume', async (req, res) => {
      const c = conf(res);
      if (!c) return;
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
      const b = (req.body ?? {}) as { wait?: unknown };
      if (b.wait === true) return void res.json(await done);
      res.status(202).json({ runId: r.id, status: 'running', resumes: r.resumes });
    });
    router.post('/runs/:id/cancel', async (req, res) => {
      if (!conf(res)) return;
      const st = active.get(req.params.id);
      if (!st) return void res.status(409).json({ error: 'Conflict', message: 'run is not in flight' });
      st.cancel = true;
      const r = await st.done;
      res.json({ runId: r.id, status: r.status });
    });
  },
});

/** Kahn layering: nodes in each layer depend only on earlier layers; `undefined` on a cycle. */
export function topoLayers(nodes: ReadonlyArray<{ id: string; needs: readonly string[] }>): string[][] | undefined {
  const left = new Map(nodes.map((n) => [n.id, new Set(n.needs)]));
  const layers: string[][] = [];
  while (left.size) {
    const ready = [...left].filter(([, d]) => d.size === 0).map(([id]) => id);
    if (!ready.length) return undefined;
    layers.push(ready);
    for (const id of ready) left.delete(id);
    for (const d of left.values()) for (const id of ready) d.delete(id);
  }
  return layers;
}
