/**
 * Config schema of the `approval-flows` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/approval-flows
 */

import { z } from 'zod';

export const Cond = z
  .object({ path: z.string().min(1), op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'matches', 'exists']), value: z.unknown().optional() })
  .strict()
  .superRefine((c, ctx) => {
    if (c.op === 'matches') {
      try {
        new RegExp(String(c.value));
      } catch {
        ctx.addIssue({ code: 'custom', message: `invalid regular expression ${JSON.stringify(c.value)}` });
      }
    }
    if (c.op === 'in' && !Array.isArray(c.value)) ctx.addIssue({ code: 'custom', message: '`in` needs an array value' });
  });
export const Step = z
  .object({
    name: z.string().min(1),
    approvers: z.array(z.string().min(1)).min(1),
    required: z.number().int().min(1).default(1),
    when: z.array(Cond).default([]),
    escalateAfterSeconds: z.number().int().min(1).optional(),
    escalateTo: z.array(z.string().min(1)).default([]),
  })
  .strict();
export const Flow = z
  .object({
    id: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/),
    tools: z.array(z.string().min(1)).min(1),
    clients: z.array(z.string().min(1)).optional(),
    when: z.array(Cond).default([]),
    timeoutSeconds: z.number().int().min(1).max(7 * 86400).default(900),
    steps: z.array(Step).min(1),
  })
  .strict();
export const ApprovalFlowsSchema = z
  .object({ enabled: z.boolean().default(true), flows: z.array(Flow).default([]), historySize: z.number().int().min(1).max(10_000).default(200) })
  .strict()
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    for (const f of c.flows) {
      if (ids.has(f.id)) ctx.addIssue({ code: 'custom', message: `duplicate flow id "${f.id}"` });
      ids.add(f.id);
    }
  });
export type ApprovalFlowsConfig = z.input<typeof ApprovalFlowsSchema>;
