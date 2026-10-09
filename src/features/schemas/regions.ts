/**
 * Config schema of the `regions` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/regions
 */

import { z } from 'zod';

export const RegionsSchema = z
  .object({
    self: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes'),
    syncIntervalMs: z.number().int().min(250).default(5000),
    /** Consecutive failed syncs before a peer is considered down. */
    downAfter: z.number().int().min(1).default(3),
    peers: z
      .array(z.object({ id: z.string().min(1), url: z.string().url(), apiKey: z.string().optional(), priority: z.number().int().min(0).default(100) }).strict())
      .default([]),
  })
  .strict();
export type RegionsConfig = z.input<typeof RegionsSchema>;
