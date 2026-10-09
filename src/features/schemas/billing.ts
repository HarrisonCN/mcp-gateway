/**
 * Config schema of the `billing` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/billing
 */

import { z } from 'zod';

export const Money = z.number().min(0);
export const BillingSchema = z
  .object({
    enabled: z.boolean().default(true),
    currency: z.string().regex(/^[A-Z]{3}$/).default('USD'),
    taxPct: z.number().min(0).max(100).default(0),
    priceBook: z.array(z.object({ match: z.string().min(1), perCall: Money.default(0), perInputToken: Money.default(0), perOutputToken: Money.default(0), perSecond: Money.default(0) }).strict()).default([]),
    accounts: z.record(z.object({ name: z.string().optional(), discountPct: z.number().min(0).max(100).default(0), monthlyMinimum: Money.default(0), taxPct: z.number().min(0).max(100).optional() }).strict()).default({}),
    storePath: z.string().optional(),
  })
  .strict();
export type BillingConfig = z.input<typeof BillingSchema>;
