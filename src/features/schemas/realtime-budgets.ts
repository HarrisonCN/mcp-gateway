/**
 * Config schema of the `realtime-budgets` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/realtime-budgets
 */

import { z } from 'zod';

/** Same code as calendar budgets (`costs.budgets`, action block). */
export const ERR_BUDGET_EXCEEDED = -32013;

export const BudgetSchema = z
  .object({
    name: z.string().min(1),
    metric: z.enum(['cost', 'carbon']),
    per: z.enum(['client', 'tenant', 'global']).default('client'),
    clients: z.array(z.string().min(1)).optional(),
    tenants: z.array(z.string().min(1)).optional(),
    tools: z.array(z.string().min(1)).optional(),
    windowSeconds: z.number().int().min(1).max(31 * 86_400).default(3600),
    limit: z.number().positive(),
    warnAt: z.array(z.number().gt(0).lt(1)).default([0.8]),
    onExceed: z.enum(['reject', 'downgrade', 'warn']).default('reject'),
    downgrade: z
      .object({ server: z.string().min(1).optional(), args: z.record(z.unknown()).optional() })
      .strict()
      .refine((d) => d.server !== undefined || d.args !== undefined, 'downgrade needs "server" and / or "args"')
      .optional(),
    webhook: z.string().url().optional(),
  })
  .strict()
  .refine((b) => b.onExceed !== 'downgrade' || b.downgrade, { message: 'onExceed: downgrade needs a "downgrade" block' });

export const CarbonSchema = z
  .object({
    gridIntensity: z.number().min(0).max(5000).default(400),
    servers: z.record(z.number().min(0).max(5000)).optional(),
    perCallWh: z.number().min(0).default(0.02),
    perInputTokenWh: z.number().min(0).default(0.0003),
    perOutputTokenWh: z.number().min(0).default(0.0012),
    tools: z.array(z.object({ match: z.string().min(1), perCallWh: z.number().min(0) }).strict()).optional(),
  })
  .strict();

export const RealtimeBudgetsSchema = z
  .object({
    enabled: z.boolean().default(true),
    carbon: CarbonSchema.default({}),
    budgets: z.array(BudgetSchema).min(1),
  })
  .strict()
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.budgets.forEach((b, i) => {
      if (seen.has(b.name)) ctx.addIssue({ code: 'custom', path: ['budgets', i, 'name'], message: `duplicate budget name "${b.name}"` });
      seen.add(b.name);
    });
  });
export type RealtimeBudgetsConfig = z.input<typeof RealtimeBudgetsSchema>;
