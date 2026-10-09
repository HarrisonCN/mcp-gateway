/**
 * Config schema of the `marketplace` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/marketplace
 */

import { z } from 'zod';

export const MarketplaceSchema = z
  .object({
    dir: z.string().min(1).default('plugins'),
    indexes: z.array(z.string().url()).default([]),
    /** Max artifact size (default 5 MiB). */
    maxBytes: z.number().int().positive().default(5 * 1024 * 1024),
  })
  .strict();
export type MarketplaceConfig = z.input<typeof MarketplaceSchema>;
