/**
 * Config schema of the `cost-advisor` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/cost-advisor
 */

import { z } from 'zod';

export const CostAdvisorSchema = z
  .object({
    enabled: z.boolean().default(true),
    windowMinutes: z.number().int().min(1).max(43_200).default(1440),
    minCalls: z.number().int().min(1).default(20),
    repeatThreshold: z.number().gt(0).max(1).default(0.3),
    errorThreshold: z.number().gt(0).max(1).default(0.2),
    maxObservations: z.number().int().min(100).max(1_000_000).default(50_000),
  })
  .strict();
export type CostAdvisorConfig = z.input<typeof CostAdvisorSchema>;
