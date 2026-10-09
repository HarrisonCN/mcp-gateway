/**
 * Config schema of the `time-travel` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/time-travel
 */

import { z } from 'zod';

export const TimeTravelSchema = z
  .object({
    enabled: z.boolean().default(true),
    dir: z.string().min(1).optional(),
    retentionDays: z.number().int().min(1).max(3650).default(7),
    maxEntries: z.number().int().min(100).max(1_000_000).default(20_000),
    results: z.boolean().default(true),
    maxBytes: z.number().int().min(256).max(1_048_576).default(16_384),
  })
  .strict();
export type TimeTravelConfig = z.input<typeof TimeTravelSchema>;
