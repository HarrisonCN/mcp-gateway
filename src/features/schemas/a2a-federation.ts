/**
 * Config schema of the `a2a-federation` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/a2a-federation
 */

import { z } from 'zod';

export const Remote = z
  .object({
    id: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/),
    url: z.string().url(),
    token: z.string().min(1).optional(),
    skills: z.array(z.string().min(1)).default(['*']),
    clients: z.array(z.string().min(1)).default(['*']),
    enabled: z.boolean().default(true),
  })
  .strict();

export const A2aFederationSchema = z
  .object({
    enabled: z.boolean().default(true),
    gatewayId: z.string().min(1).optional(),
    refreshSeconds: z.number().int().min(5).max(86_400).default(60),
    timeoutMs: z.number().int().min(100).max(300_000).default(15_000),
    remotes: z.array(Remote).default([]),
  })
  .strict()
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    c.remotes.forEach((r, i) => {
      if (ids.has(r.id)) ctx.addIssue({ code: 'custom', path: ['remotes', i, 'id'], message: `duplicate remote id "${r.id}"` });
      ids.add(r.id);
    });
  });
export type A2aFederationConfig = z.input<typeof A2aFederationSchema>;
