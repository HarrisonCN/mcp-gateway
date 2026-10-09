/**
 * Config schema of the `self-healing` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/self-healing
 */

import { z } from 'zod';

/** JSON-RPC error of a call refused by an active self-healing action (9.6). */
export const ERR_SELF_HEALING = -32025;

export const Rule = z
  .object({
    id: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/),
    servers: z.array(z.string().min(1)).min(1),
    when: z
      .object({ errorRateAbove: z.number().min(0).max(1).optional(), p95Above: z.number().int().min(1).optional() })
      .strict()
      .refine((w) => w.errorRateAbove !== undefined || w.p95Above !== undefined, 'when needs errorRateAbove or p95Above'),
    action: z.enum(['eject', 'rollback', 'throttle']),
    fallback: z.string().min(1).optional(),
    rollbackTo: z.string().min(1).optional(),
    maxPerSecond: z.number().int().min(1).optional(),
    cooldownSeconds: z.number().int().min(1).max(86_400).default(120),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.action === 'rollback' && !r.rollbackTo) ctx.addIssue({ code: 'custom', path: ['rollbackTo'], message: 'action rollback needs rollbackTo' });
    if (r.action === 'throttle' && !r.maxPerSecond) ctx.addIssue({ code: 'custom', path: ['maxPerSecond'], message: 'action throttle needs maxPerSecond' });
  });

export const SelfHealingSchema = z
  .object({
    enabled: z.boolean().default(true),
    windowSeconds: z.number().int().min(5).max(3600).default(60),
    minCalls: z.number().int().min(1).default(20),
    rules: z.array(Rule).default([]),
  })
  .strict()
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    c.rules.forEach((r, i) => {
      if (ids.has(r.id)) ctx.addIssue({ code: 'custom', path: ['rules', i, 'id'], message: `duplicate self-healing rule "${r.id}"` });
      ids.add(r.id);
    });
  });
export type SelfHealingConfig = z.input<typeof SelfHealingSchema>;
