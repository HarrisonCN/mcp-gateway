/**
 * Config schema of the `pq-identity` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/pq-identity
 */

import { z } from 'zod';

export const PqIdentitySchema = z
  .object({
    enabled: z.boolean().default(true),
    keyFile: z.string().min(1),
    keyId: z.string().min(1).max(128),
    gatewayId: z.string().min(1).optional(),
    validityDays: z.number().int().min(1).max(3650).default(90),
    toolManifest: z.boolean().default(true),
    auditLog: z
      .object({
        enabled: z.boolean().default(true),
        dir: z.string().min(1).optional(),
        maxEntries: z.number().int().min(100).max(1_000_000).default(50_000),
        checkpointEvery: z.number().int().min(1).max(1_000_000).default(100),
        checkpointSeconds: z.number().int().min(1).max(86_400).default(300),
      })
      .strict()
      .default({}),
  })
  .strict();
export type PqIdentityConfig = z.input<typeof PqIdentitySchema>;
