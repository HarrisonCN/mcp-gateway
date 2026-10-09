/**
 * Config schema of the `chaos` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/chaos
 */

import { z } from 'zod';

/** JSON-RPC error of an injected chaos fault (8.8). */
export const ERR_CHAOS_INJECTED = -32021;
export const EVERY_MS = { hourly: 3_600_000, daily: 86_400_000, weekly: 7 * 86_400_000 } as const;

export const Experiment = z
  .object({
    id: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/),
    servers: z.array(z.string().min(1)).default(['*']),
    tools: z.array(z.string().min(1)).default(['*']),
    clients: z.array(z.string().min(1)).default(['*']),
    percent: z.number().min(0).max(100).default(100),
    fault: z
      .object({
        latencyMs: z.number().int().min(0).max(120_000).optional(),
        errorRate: z.number().min(0).max(1).optional(),
        errorCode: z.number().int().optional(),
        timeoutRate: z.number().min(0).max(1).optional(),
        timeoutMs: z.number().int().min(1).max(600_000).default(30_000),
        corruptRate: z.number().min(0).max(1).optional(),
      })
      .strict()
      .refine((f) => f.latencyMs || f.errorRate || f.timeoutRate || f.corruptRate, 'a fault needs latencyMs, errorRate, timeoutRate or corruptRate'),
    durationSeconds: z.number().int().min(1).max(86_400).default(300),
    abortIfErrorRateAbove: z.number().min(0).max(1).optional(),
    minCallsForAbort: z.number().int().min(1).default(10),
    every: z.enum(['hourly', 'daily', 'weekly']).optional(),
  })
  .strict();

export const ChaosSchema = z
  .object({ enabled: z.boolean().default(true), experiments: z.array(Experiment).default([]) })
  .strict()
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    c.experiments.forEach((e, i) => {
      if (ids.has(e.id)) ctx.addIssue({ code: 'custom', path: ['experiments', i, 'id'], message: `duplicate experiment id "${e.id}"` });
      ids.add(e.id);
    });
  });
export type ChaosConfig = z.input<typeof ChaosSchema>;
