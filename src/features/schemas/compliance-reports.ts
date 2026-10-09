/**
 * Config schema of the `compliance-reports` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/compliance-reports
 */

import { z } from 'zod';

export const Framework = z.enum(['soc2', 'iso27001', 'gdpr']);
export type Framework = z.infer<typeof Framework>;
export const EVERY_MS = { daily: 86_400_000, weekly: 7 * 86_400_000, monthly: 30 * 86_400_000 } as const;

export const ComplianceReportsSchema = z
  .object({
    enabled: z.boolean().default(true),
    outputDir: z.string().min(1).default('./compliance'),
    keep: z.number().int().min(1).max(1000).default(12),
    schedules: z
      .array(
        z
          .object({
            id: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/),
            frameworks: z.array(Framework).min(1).default(['soc2', 'iso27001', 'gdpr']),
            every: z.enum(['daily', 'weekly', 'monthly']).default('monthly'),
            periodDays: z.number().int().min(1).max(366).default(30),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type ComplianceReportsConfig = z.input<typeof ComplianceReportsSchema>;
