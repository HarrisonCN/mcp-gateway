/**
 * Config schema of the `confidential` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/confidential
 */

import { createPublicKey } from 'node:crypto';
import { z } from 'zod';

/** JSON-RPC error when a call needs an attested TEE upstream (9.3). */
export const ERR_ATTESTATION_REQUIRED = -32024;
export const TEE_PLATFORMS = ['sev-snp', 'tdx', 'nitro', 'sgx'] as const;

export const Rule = z
  .object({
    match: z.string().min(1),
    platforms: z.array(z.enum(TEE_PLATFORMS)).min(1).default(['sev-snp', 'tdx', 'nitro', 'sgx']),
    measurements: z.array(z.string().regex(/^[a-f0-9]{32,128}$/, 'measurements are lower-case hex')).min(1),
    trustedKeys: z
      .array(z.string().min(1))
      .min(1)
      .superRefine((ks, ctx) => {
        ks.forEach((k, i) => {
          try {
            createPublicKey(k);
          } catch {
            ctx.addIssue({ code: 'custom', path: [i], message: 'not a PEM public key' });
          }
        });
      }),
    validitySeconds: z.number().int().min(10).max(7 * 86_400).default(3600),
    allowDebug: z.boolean().default(false),
  })
  .strict();

export const ConfidentialSchema = z
  .object({ enabled: z.boolean().default(true), nonceTtlSeconds: z.number().int().min(5).max(3600).default(120), servers: z.array(Rule).default([]) })
  .strict();
export type ConfidentialConfig = z.input<typeof ConfidentialSchema>;
