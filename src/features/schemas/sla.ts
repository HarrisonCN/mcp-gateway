/**
 * Config schema of the `sla` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/sla
 */

import { z } from 'zod';

export const HOUR = 3_600_000;
/** Histogram upper bounds in ms (log scale); the last bucket is open-ended. */
export const BOUNDS = [1, 2, 5, 10, 20, 50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10_000, 20_000, 30_000, 60_000, Infinity];

export const Target = z
  .object({
    id: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/),
    servers: z.array(z.string().min(1)).default(['*']),
    tenants: z.array(z.string().min(1)).default(['*']),
    availability: z.number().min(0).max(100),
    latencyP95Ms: z.number().int().min(1).optional(),
    windowDays: z.number().int().min(1).max(92).default(30),
    monthlyFee: z.number().min(0).optional(),
    currency: z.string().min(1).default('USD'),
    credits: z.array(z.object({ below: z.number().min(0).max(100), percent: z.number().min(0).max(100) }).strict()).default([]),
    excludeErrorCodes: z.array(z.number().int()).default([]),
  })
  .strict();

export const SlaSchema = z
  .object({ enabled: z.boolean().default(true), targets: z.array(Target).default([]) })
  .strict()
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    c.targets.forEach((t, i) => {
      if (ids.has(t.id)) ctx.addIssue({ code: 'custom', path: ['targets', i, 'id'], message: `duplicate SLA target "${t.id}"` });
      ids.add(t.id);
    });
  });
export type SlaConfig = z.input<typeof SlaSchema>;
