/**
 * Config schema of the `blue-green` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/blue-green
 */

import { z } from 'zod';

export const Color = z.enum(['blue', 'green']);
export type Color = z.infer<typeof Color>;

export const Deployment = z
  .object({
    id: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/),
    blue: z.string().min(1),
    green: z.string().min(1),
    active: Color.default('blue'),
    tools: z.array(z.string().min(1)).default(['*']),
    probe: z.object({ tool: z.string().min(1), arguments: z.record(z.unknown()).default({}) }).strict().optional(),
    verify: z.object({ seconds: z.number().int().min(0).max(86_400).default(120), maxErrorRate: z.number().min(0).max(1).default(0.1), minCalls: z.number().int().min(1).default(10) }).strict().default({}),
  })
  .strict()
  .refine((d) => d.blue !== d.green, { message: '`blue` and `green` must be different servers' });

export const BlueGreenSchema = z.array(Deployment).superRefine((ds, ctx) => {
  const ids = new Set<string>();
  const blues = new Set<string>();
  ds.forEach((d, i) => {
    if (ids.has(d.id)) ctx.addIssue({ code: 'custom', path: [i, 'id'], message: `duplicate blue/green id "${d.id}"` });
    if (blues.has(d.blue)) ctx.addIssue({ code: 'custom', path: [i, 'blue'], message: `server "${d.blue}" is already the blue side of another deployment` });
    ids.add(d.id);
    blues.add(d.blue);
  });
});
export type BlueGreenConfig = z.input<typeof BlueGreenSchema>;
