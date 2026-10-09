/**
 * Config schema of the `edge-fleet` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/edge-fleet
 */

import { z } from 'zod';

export const EdgeFleetSchema = z
  .object({
    pushTimeoutMs: z.number().int().min(100).default(10_000),
    offlineAfterMs: z.number().int().min(1000).default(15 * 60_000),
    nodes: z
      .array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/), url: z.string().url(), apiKey: z.string().optional(), labels: z.record(z.string()).default({}) }).strict())
      .default([]),
  })
  .strict();
export type EdgeFleetConfig = z.input<typeof EdgeFleetSchema>;
