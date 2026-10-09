/**
 * Config schema of the `data-lineage` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/data-lineage
 */

import { z } from 'zod';

export const DataLineageSchema = z
  .object({
    enabled: z.boolean().default(true),
    scope: z.enum(['client', 'tenant', 'global']).default('client'),
    windowMinutes: z.number().int().min(1).max(10_080).default(60),
    minValueLength: z.number().int().min(4).max(1000).default(8),
    maxNodes: z.number().int().min(100).max(1_000_000).default(5000),
  })
  .strict();
export type DataLineageConfig = z.input<typeof DataLineageSchema>;
