/**
 * Config schema of the `rollouts` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/rollouts
 */

import { z } from 'zod';

export const RolloutSchema = z
  .object({
    id: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/),
    stable: z.string().min(1),
    canary: z.string().min(1),
    tools: z.array(z.string().min(1)).default(['*']),
    percent: z.number().min(0).max(100).default(0),
    clients: z.array(z.string().min(1)).default([]),
    exclude: z.array(z.string().min(1)).default([]),
    autoRollback: z.object({ maxErrorRate: z.number().min(0).max(1).default(0.2), minCalls: z.number().int().min(1).default(20), window: z.number().int().min(10).max(100_000).default(200) }).strict().optional(),
  })
  .strict()
  .refine((r) => r.stable !== r.canary, { message: '`stable` and `canary` must be different servers' });
export const RolloutsSchema = z.array(RolloutSchema).superRefine((rs, ctx) => {
  const ids = new Set<string>();
  const stables = new Set<string>();
  for (const r of rs) {
    if (ids.has(r.id)) ctx.addIssue({ code: 'custom', message: `duplicate rollout id "${r.id}"` });
    if (stables.has(r.stable)) ctx.addIssue({ code: 'custom', message: `server "${r.stable}" has more than one rollout` });
    ids.add(r.id);
    stables.add(r.stable);
  }
});
export type RolloutsConfig = z.input<typeof RolloutsSchema>;
