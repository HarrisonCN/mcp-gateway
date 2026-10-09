/**
 * Config schema of the `sanitize` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/sanitize
 */

import { z } from 'zod';

export const ERR_INJECTION_BLOCKED = -32017;

export const SanitizeSchema = z
  .object({
    enabled: z.boolean().default(true),
    servers: z.array(z.string().min(1)).default(['*']),
    exempt: z.array(z.string().min(1)).default([]),
    invisible: z.boolean().default(true),
    ansi: z.boolean().default(true),
    html: z.boolean().default(true),
    images: z.enum(['keep', 'strip']).default('strip'),
    allowedImageHosts: z.array(z.string().min(1)).default([]),
    maxChars: z.number().int().min(100).optional(),
    injection: z.object({ action: z.enum(['off', 'flag', 'mark', 'block']).default('flag'), threshold: z.number().min(0).max(1).default(0.6) }).strict().default({}),
    inbound: z.enum(['off', 'block']).default('off'),
    spotlight: z.boolean().default(false),
  })
  .strict();
export type SanitizeConfig = z.input<typeof SanitizeSchema>;
