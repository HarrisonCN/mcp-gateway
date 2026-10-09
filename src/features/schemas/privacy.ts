/**
 * Config schema of the `privacy` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/privacy
 */

import { z } from 'zod';

export const ERR_PRIVACY_PROTECTED = -32003; // same as a policy denial

export const PrivacySchema = z
  .object({
    enabled: z.boolean().default(true),
    protect: z.array(z.string().min(1)).default([]),
    maxEpsilonPerQuery: z.number().positive().max(10).default(1),
    budget: z
      .object({ epsilon: z.number().positive().max(1000).default(10), windowSeconds: z.number().int().min(1).max(366 * 86_400).default(86_400) })
      .strict()
      .default({}),
    peers: z.array(z.object({ id: z.string().min(1), url: z.string().url(), token: z.string().min(1).optional(), timeoutMs: z.number().int().min(100).max(120_000).default(10_000) }).strict()).default([]),
    maxRows: z.number().int().min(1).max(10_000_000).default(1_000_000),
  })
  .strict();
export type PrivacyConfig = z.input<typeof PrivacySchema>;
