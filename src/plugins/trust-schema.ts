/**
 * `pluginTrust` config schema (5.4 / 10.8), split from plugins/trust in 13.3.0 so validating a config does not load
 * the signature code and its post-quantum backend.
 *
 * @module plugins/trust-schema
 */
import { z } from 'zod';

export const PluginTrustSchema = z
  .object({
    requireSigned: z.boolean().default(false),
    /** 10.8 (EXPERIMENTAL): refuse signatures without a valid ML-DSA part (hybrid only). */
    requirePostQuantum: z.boolean().default(false),
    keys: z
      .array(
        z
          .object({
            id: z.string().min(1),
            publicKey: z.string().min(1),
            /** 10.8: ML-DSA public key `{ kty: "ML-DSA", alg, pub }` — with it, signatures from this key must be hybrid. */
            mldsa: z.object({ kty: z.literal('ML-DSA'), alg: z.enum(['ml-dsa-44', 'ml-dsa-65', 'ml-dsa-87']), pub: z.string().min(1) }).strict().optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type PluginTrustConfig = z.input<typeof PluginTrustSchema>;
