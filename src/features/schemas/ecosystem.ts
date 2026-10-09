/**
 * Config schema of the `ecosystem` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/ecosystem
 */

import { z } from 'zod';

export const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const EcosystemSchema = z
  .object({
    enabled: z.boolean().default(true),
    file: z.string().min(1).optional(),
    autoApproveVerified: z.boolean().default(false),
    publishers: z
      .array(z.object({ id: z.string().regex(ID), name: z.string().min(1), domain: z.string().regex(/^[a-z0-9.-]+(:\d+)?$/i).optional(), keyIds: z.array(z.string().min(1)).default([]), wellKnownUrl: z.string().url().optional() }).strict())
      .default([]),
  })
  .strict()
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    c.publishers.forEach((p, i) => {
      if (ids.has(p.id)) ctx.addIssue({ code: 'custom', path: ['publishers', i, 'id'], message: `duplicate publisher "${p.id}"` });
      ids.add(p.id);
    });
  });
export type EcosystemConfig = z.input<typeof EcosystemSchema>;
