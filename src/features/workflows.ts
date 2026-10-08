/**
 * Workflow engine (6.2): multi-tool DAGs that run inside the gateway.
 *
 * Unlike chains (4.2, an ordered pipeline), a workflow is a graph: each node names the nodes it `needs`, and every
 * node whose dependencies are done runs at once (bounded by `concurrency`). Nodes can be conditional (`if`), retry
 * with exponential backoff, and either fail the run or let it `continue`. Runs are asynchronous and kept in memory.
 *
 * ```yaml
 * workflows:
 *   - id: enrich-lead
 *     concurrency: 4
 *     nodes:
 *       - { id: company, tool: crm/lookup, args: { domain: "{{input.domain}}" } }
 *       - { id: news,    tool: search/web, args: { q: "{{input.domain}} funding" }, retry: { attempts: 3, backoffMs: 200 } }
 *       - { id: score,   tool: llm/score, needs: [company, news], args: { company: "{{nodes.company.text}}", news: "{{nodes.news.text}}" } }
 *       - { id: notify,  tool: slack/post, needs: [score], if: "nodes.score.structuredContent.hot", onError: continue }
 *     output: "{{nodes.score.structuredContent}}"
 * ```
 *
 * Templates use the chain syntax (`{{input.x}}`, `{{nodes.<id>.text | structuredContent | …}}`). Calls go through
 * the full invoker pipeline (policy, quotas, audit) as client `workflow:<id>`.
 *
 * - `GET  /admin/workflows` — workflows with their execution layers.
 * - `POST /admin/workflows/run` — `{ workflow, input?, wait? }` → `202 { runId }` (or the finished run with `wait: true`).
 * - `GET  /admin/workflows/runs` / `GET /admin/workflows/runs/:id` — run history and one run with per-node status.
 *
 * @module features/workflows
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { registerFeature, objectBody, badRequest } from '../gateway/features.js';
import { parseTarget, readPath, render, stepValue } from '../orchestration/chains.js';
import type { GatewayConfig, ProxyResponse } from '../utils/types.js';

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Node = z
  .object({
    id: Id,
    tool: z.string().refine((t) => !!parseTarget(t), 'tool must be "server/tool"'),
    args: z.record(z.unknown()).default({}),
    needs: z.array(Id).default([]),
    if: z.string().optional(),
    retry: z.object({ attempts: z.number().int().min(1).max(10).default(1), backoffMs: z.number().int().min(0).max(60_000).default(100) }).strict().default({}),
    onError: z.enum(['fail', 'continue']).default('fail'),
  })
  .strict();
const Workflow = z
  .object({ id: Id, description: z.string().optional(), concurrency: z.number().int().min(1).max(64).default(8), nodes: z.array(Node).min(1), output: z.unknown().optional() })
  .strict()
  .superRefine((w, ctx) => {
    const ids = new Set<string>();
    for (const n of w.nodes) {
      if (ids.has(n.id)) ctx.addIssue({ code: 'custom', message: `workflow ${w.id}: duplicate node ${n.id}` });
      ids.add(n.id);
    }
    let known = true;
    for (const n of w.nodes)
      for (const d of n.needs)
        if (!ids.has(d)) {
          known = false;
          ctx.addIssue({ code: 'custom', message: `workflow ${w.id}: node ${n.id} needs unknown node ${d}` });
        }
    if (known && ids.size === w.nodes.length && !topoLayers(w.nodes)) ctx.addIssue({ code: 'custom', message: `workflow ${w.id}: dependency cycle` });
  });
export const WorkflowsSchema = z.array(Workflow);
export type WorkflowsConfig = z.input<typeof WorkflowsSchema>;
type WorkflowCfg = z.output<typeof Workflow>;
type NodeCfg = z.output<typeof Node>;

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

export type NodeStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
export interface NodeRun {
  id: string;
  status: NodeStatus;
  attempts: number;
  startedAt?: string;
  durationMs?: number;
  error?: string;
}
export interface WorkflowRun {
  runId: string;
  workflow: string;
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt?: string;
  nodes: NodeRun[];
  output?: unknown;
  error?: string;
}

export type WorkflowInvoke = (serverId: string, tool: string, args: Record<string, unknown>) => Promise<ProxyResponse>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run a workflow to completion. `onUpdate` sees the run object as it changes (same reference). */
export async function runWorkflow(wf: WorkflowCfg, input: Record<string, unknown>, invoke: WorkflowInvoke, opts: { runId?: string; run?: WorkflowRun; sleepFn?: (ms: number) => Promise<unknown> } = {}): Promise<WorkflowRun> {
  const run: WorkflowRun = opts.run ?? { runId: opts.runId ?? randomUUID(), workflow: wf.id, status: 'running', startedAt: new Date().toISOString(), nodes: [] };
  run.nodes = wf.nodes.map((n) => ({ id: n.id, status: 'pending', attempts: 0 }));
  const byId = new Map(run.nodes.map((n) => [n.id, n]));
  const values: Record<string, unknown> = {};
  const scope = () => ({ input, nodes: values });
  const wait = opts.sleepFn ?? sleep;
  let failed: string | undefined;

  const exec = async (n: NodeCfg): Promise<void> => {
    const rec = byId.get(n.id)!;
    const blocked = n.needs.some((d) => byId.get(d)!.status === 'failed' || byId.get(d)!.status === 'skipped');
    if (failed || blocked || (n.if !== undefined && !readPath(scope(), n.if))) {
      rec.status = 'skipped';
      return;
    }
    rec.status = 'running';
    rec.startedAt = new Date().toISOString();
    const t0 = Date.now();
    const { serverId, tool } = parseTarget(n.tool)!;
    for (let a = 1; a <= n.retry.attempts; a++) {
      rec.attempts = a;
      let r: ProxyResponse;
      try {
        r = await invoke(serverId, tool, render(n.args, scope()) as Record<string, unknown>);
      } catch (e) {
        r = { success: false, durationMs: 0, error: { code: -32603, message: (e as Error).message } };
      }
      if (r.success) {
        values[n.id] = stepValue(r.result);
        rec.status = 'succeeded';
        rec.durationMs = Date.now() - t0;
        delete rec.error;
        return;
      }
      rec.error = r.error?.message ?? 'failed';
      if (a < n.retry.attempts) await wait(n.retry.backoffMs * 2 ** (a - 1));
    }
    rec.status = 'failed';
    rec.durationMs = Date.now() - t0;
    if (n.onError === 'fail' && !failed) failed = `node ${n.id}: ${rec.error}`;
  };

  // Event-driven scheduling: start every node whose needs are settled, up to `concurrency` at once.
  const nodes = new Map(wf.nodes.map((n) => [n.id, n]));
  const settled = (id: string) => ['succeeded', 'failed', 'skipped'].includes(byId.get(id)!.status);
  const started = new Set<string>();
  const inflight = new Set<Promise<void>>();
  for (;;) {
    for (const n of nodes.values()) {
      if (inflight.size >= wf.concurrency) break;
      if (started.has(n.id) || !n.needs.every(settled)) continue;
      started.add(n.id);
      const p: Promise<void> = exec(n).finally(() => inflight.delete(p));
      inflight.add(p);
    }
    if (!inflight.size) break;
    await Promise.race(inflight);
  }
  run.status = failed ? 'failed' : 'succeeded';
  if (failed) run.error = failed;
  else if (wf.output !== undefined) run.output = render(wf.output, scope());
  run.finishedAt = new Date().toISOString();
  return run;
}

/** Bounded in-memory run history (newest last). */
export class WorkflowRuns {
  private readonly runs = new Map<string, WorkflowRun>();
  constructor(private readonly max = 200) {}
  add(r: WorkflowRun): void {
    this.runs.set(r.runId, r);
    while (this.runs.size > this.max) this.runs.delete(this.runs.keys().next().value!);
  }
  get(id: string): WorkflowRun | undefined {
    return this.runs.get(id);
  }
  list(workflow?: string): WorkflowRun[] {
    return [...this.runs.values()].filter((r) => !workflow || r.workflow === workflow).reverse();
  }
}

const workflows = (cfg: GatewayConfig): WorkflowCfg[] => (cfg.workflows ? WorkflowsSchema.parse(cfg.workflows) : []);

registerFeature({
  id: 'workflows',
  since: '6.2.0',
  summary: 'Workflow engine: multi-tool DAGs with dependencies, parallelism, conditions and retries',
  mount: (router, ctx) => {
    const history = new WorkflowRuns();
    router.get('/', (_req, res) => {
      res.json({ workflows: workflows(ctx.config()).map((w) => ({ id: w.id, description: w.description, concurrency: w.concurrency, nodes: w.nodes.map((n) => ({ id: n.id, tool: n.tool, needs: n.needs, if: n.if, onError: n.onError })), layers: topoLayers(w.nodes) })) });
    });
    router.post('/run', async (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      const wf = workflows(ctx.config()).find((w) => w.id === b.workflow);
      if (!wf) return void res.status(404).json({ error: 'Not Found', message: `no workflow "${String(b.workflow)}"` });
      if (b.input !== undefined && (typeof b.input !== 'object' || b.input === null || Array.isArray(b.input))) return badRequest(res, '"input" must be an object');
      const run: WorkflowRun = { runId: randomUUID(), workflow: wf.id, status: 'running', startedAt: new Date().toISOString(), nodes: [] };
      history.add(run);
      const done = runWorkflow(wf, (b.input as Record<string, unknown>) ?? {}, (s, t, a) => ctx.invoke(s, t, a, `workflow:${wf.id}`), { run });
      if (b.wait === true) return void res.json(await done);
      res.status(202).json({ runId: run.runId, status: run.status });
    });
    router.get('/runs', (req, res) => {
      res.json({ runs: history.list(typeof req.query.workflow === 'string' ? req.query.workflow : undefined).map(({ nodes: _n, output: _o, ...r }) => r) });
    });
    router.get('/runs/:id', (req, res) => {
      const r = history.get(req.params.id);
      if (!r) return void res.status(404).json({ error: 'Not Found', message: 'no such run' });
      res.json(r);
    });
  },
});
