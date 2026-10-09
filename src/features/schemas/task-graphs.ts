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
    compensate: z.object({ tool: Target, args: z.record(z.unknown()).default({}) }).strict().optional(),
  })
  .strict()
  .refine((n) => (n.tool === undefined) !== (n.remote === undefined), { message: 'a node needs exactly one of "tool" or "remote"' });

export const GraphSchema = z
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
