/**
 * Config schema of the `adaptive` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/adaptive
 */

import { z } from 'zod';

export const Candidate = z
  .object({ id: z.string().min(1), server: z.string().min(1), tool: z.string().min(1), args: z.record(z.unknown()).default({}), costPerCall: z.number().min(0).default(0) })
  .strict();
export const Pool = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
    objective: z.object({ quality: z.number().min(0).default(0.6), cost: z.number().min(0).default(0.3), latency: z.number().min(0).default(0.1) }).strict().default({}),
    maxCostPerCall: z.number().min(0).optional(),
    candidates: z.array(Candidate).min(1),
  })
  .strict();
export const AdaptiveSchema = z.object({ pools: z.array(Pool).default([]) }).strict();
export type AdaptiveConfig = z.input<typeof AdaptiveSchema>;
