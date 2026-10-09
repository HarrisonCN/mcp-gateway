/**
 * Config schema of the `console` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/console
 */

import { z } from 'zod';

export const ERR_ORG_REFUSED = -32016;

export const Id = z.string().min(1).regex(/^[A-Za-z0-9._-]+$/, 'letters, digits, ".", "_" and "-" only');
export const PlanSchema = z.object({ name: z.string().optional(), servers: z.array(z.string().min(1)).min(1), callsPerDay: z.number().int().min(0).optional() }).strict();
export const ConsoleSchema = z
  .object({
    enabled: z.boolean().default(true),
    defaultPlan: z.string().min(1).optional(),
    plans: z.record(PlanSchema).default({}),
    orgs: z.record(z.object({ plan: z.string().min(1), suspended: z.boolean().default(false) }).strict()).default({}),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.defaultPlan && !c.plans[c.defaultPlan]) ctx.addIssue({ code: 'custom', path: ['defaultPlan'], message: `unknown plan "${c.defaultPlan}"` });
    for (const [id, o] of Object.entries(c.orgs)) {
      if (!Id.safeParse(id).success) ctx.addIssue({ code: 'custom', path: ['orgs', id], message: 'org ids are letters, digits, ".", "_" and "-"' });
      if (!c.plans[o.plan]) ctx.addIssue({ code: 'custom', path: ['orgs', id, 'plan'], message: `unknown plan "${o.plan}"` });
    }
  });
export type ConsoleConfig = z.input<typeof ConsoleSchema>;
