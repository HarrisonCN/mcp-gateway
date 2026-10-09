/**
 * Config schema of the `dlp` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/dlp
 */

import { z } from 'zod';

export const LEVELS = ['public', 'internal', 'confidential', 'restricted'] as const;
export type Level = (typeof LEVELS)[number];
export type Strategy = 'redact' | 'mask' | 'hash' | 'block';
export const ERR_DLP_BLOCKED = -32013;

export const TenantPolicy = z.object({ clearance: z.enum(LEVELS).optional(), strategy: z.enum(['redact', 'mask', 'hash', 'block']).optional(), salt: z.string().optional() }).strict();
export const DlpSchema = z
  .object({
    enabled: z.boolean().default(true),
    scope: z.enum(['arguments', 'results', 'both']).default('results'),
    servers: z.array(z.string()).optional(),
    default: TenantPolicy.default({}),
    tenants: z.record(TenantPolicy).default({}),
    levels: z.record(z.enum(LEVELS)).default({}),
    detectors: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
            pattern: z.string().min(1).refine((p) => { try { new RegExp(p); return true; } catch { return false; } }, 'invalid regular expression'),
            level: z.enum(LEVELS).default('confidential'),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type DlpConfig = z.input<typeof DlpSchema>;
