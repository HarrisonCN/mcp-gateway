/**
 * Config schema of the `pq-tls` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/pq-tls
 */

import { z } from 'zod';

export const GROUP = /^[A-Za-z0-9_-]+$/;
export const PqTlsSchema = z
  .object({
    mode: z.enum(['off', 'prefer', 'require']).default('prefer'),
    groups: z.array(z.string().regex(GROUP)).min(1).default(['X25519MLKEM768']),
    classicalGroups: z.array(z.string().regex(GROUP)).default(['X25519', 'P-256']),
    servers: z.array(z.string().min(1)).default(['*']),
    certificatePolicy: z
      .object({
        minRsaBits: z.number().int().min(1024).default(3072),
        allowedKeyTypes: z.array(z.enum(['ec', 'ed25519', 'ed448', 'rsa', 'rsa-pss', 'ml-dsa'])).default(['ec', 'ed25519', 'ed448', 'rsa', 'rsa-pss', 'ml-dsa']),
        maxValidityDays: z.number().int().min(1).optional(),
        rejectSha1: z.boolean().default(true),
      })
      .strict()
      .default({}),
  })
  .strict();
export type PqTlsConfig = z.input<typeof PqTlsSchema>;
