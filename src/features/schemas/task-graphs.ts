/**
 * Config schema of the `task-graphs` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/task-graphs
 */

import { z } from 'zod';
import { parseTarget } from '../../orchestration/chains.js';

export const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const Target = z.string().refine((t) => !!parseTarget(t), 'must be "server/tool"');

export const Retry = z
  .object({
    attempts: z.number().int().min(1).max(20).default(1),
    backoffMs: z.number().int().min(0).max(600_000).default(200),
    factor: z.number().min(1).max(10).default(2),
    maxBackoffMs: z.number().int().min(0).max(3_600_000).default(30_000),
    jitter: z.boolean().default(false),
  })
  .strict();

/** 14.4.0: name of the argument that carries the gateway's stable per-call idempotency key. */
export const ArgName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/, 'must be an argument name');

/** 14.4.0: a node that waits for human approval before it runs (durable: survives restarts). */
export const Approval = z
  .object({
    approvers: z.array(z.string().min(1)).min(1),
    required: z.number().int().min(1).max(20).default(1),
    timeoutSeconds: z.number().int().min(1).max(30 * 86_400).default(86_400),
    reason: z.string().max(500).optional(),
  })
  .strict();

/** 14.4.0: `taskGraphs.durable` — durable execution (persisted state, leases, idempotency, DLQ). */
export const DurableSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Where run state lives: the gateway store (`store.backend`), the checkpoint `dir`, or memory; `auto` picks store → dir → memory. */
    backend: z.enum(['auto', 'store', 'dir', 'memory']).default('auto'),
    resumeOnStart: z.boolean().default(true),
    leaseMs: z.number().int().min(1000).max(600_000).default(15_000),
    sweepIntervalMs: z.number().int().min(50).max(600_000).default(2_000),
    idempotencyTtlSeconds: z.number().int().min(60).max(90 * 86_400).default(86_400),
    /** 14.9.0: finished runs (succeeded / failed / cancelled / compensated) are deleted this long after they ended; 0 = keep. */
    retentionHours: z.number().int().min(0).max(100 * 8760).default(168),
    dlq: z
      .object({
        enabled: z.boolean().default(true),
        retry: z
          .object({
            attempts: z.number().int().min(0).max(100).default(3),
            backoffMs: z.number().int().min(0).max(86_400_000).default(30_000),
            factor: z.number().min(1).max(10).default(2),
            maxBackoffMs: z.number().int().min(0).max(7 * 86_400_000).default(3_600_000),
            jitter: z.boolean().default(false),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
  })
  .strict();

export const NodeSchema = z
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
    compensate: z.object({ tool: Target, args: z.record(z.unknown()).default({}), idempotencyArg: ArgName.optional() }).strict().optional(),
    // 14.4.0 (durable execution): repeat-safety of the call and a human approval gate.
    idempotent: z.boolean().default(false),
    idempotencyArg: ArgName.optional(),
    approval: Approval.optional(),
  })
  .strict()
  .refine((n) => (n.tool === undefined) !== (n.remote === undefined), { message: 'a node needs exactly one of "tool" or "remote"' });

export const GraphSchema = z
  .object({ id: Id, description: z.string().optional(), clients: z.boolean().default(false), concurrency: z.number().int().min(1).max(64).default(8), nodes: z.array(NodeSchema).min(1), output: z.unknown().optional() })
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
    durable: DurableSchema.optional(),
    graphs: z.array(GraphSchema).min(1),
  })
  .strict()
  .superRefine((c, ctx) => {
    // 14.4.0: approval gates and client-startable graphs keep their state in the durable layer
    if (!c.durable || !c.durable.enabled)
      c.graphs.forEach((g, i) => {
        if (g.clients) ctx.addIssue({ code: 'custom', path: ['graphs', i, 'clients'], message: `task graph "${g.id}": clients: true needs features.taskGraphs.durable` });
        g.nodes.forEach((n, j) => {
          if (n.approval) ctx.addIssue({ code: 'custom', path: ['graphs', i, 'nodes', j, 'approval'], message: `task graph "${g.id}" node "${n.id}": approval needs features.taskGraphs.durable` });
        });
      });
    const seen = new Set<string>();
    c.graphs.forEach((g, i) => {
      if (seen.has(g.id)) ctx.addIssue({ code: 'custom', path: ['graphs', i, 'id'], message: `duplicate task graph "${g.id}"` });
      seen.add(g.id);
    });
  });
export type TaskGraphsConfig = z.input<typeof TaskGraphsSchema>;

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
