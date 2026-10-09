/**
 * Config schema of the `multimodal` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/multimodal
 */

import { z } from 'zod';

/** JSON-RPC error when a tool result breaks the multimodal policy (9.1). */
export const ERR_MEDIA_REFUSED = -32022;
export const CHUNK = 64 * 1024;

export const MultimodalSchema = z
  .object({
    enabled: z.boolean().default(true),
    allowedTypes: z.array(z.string().min(1)).default(['image/*', 'audio/*']),
    maxItemBytes: z.number().int().min(1).default(4 * 1024 * 1024), // 12.0: 10 MiB → 4 MiB
    maxTotalBytes: z.number().int().min(1).default(16 * 1024 * 1024), // 12.0: 32 MiB → 16 MiB
    onViolation: z.enum(['refuse', 'strip']).default('refuse'),
    offloadAboveBytes: z.number().int().min(1).optional(),
    blobTtlSeconds: z.number().int().min(1).max(86_400).default(600),
    maxBlobs: z.number().int().min(1).default(256),
    servers: z.array(z.string().min(1)).default(['*']),
    maxStoredBytes: z.number().int().min(1).default(256 * 1024 * 1024),
    maxTenantStoredBytes: z.number().int().min(1).default(64 * 1024 * 1024),
    storage: z
      .discriminatedUnion('type', [z.object({ type: z.literal('memory') }).strict(), z.object({ type: z.literal('filesystem'), dir: z.string().min(1) }).strict()])
      .default({ type: 'memory' }),
    signedLinks: z.object({ key: z.string().min(32, 'signedLinks.key must be at least 32 characters'), ttlSeconds: z.number().int().min(10).max(86_400).default(300) }).strict().optional(),
  })
  .strict()
  .refine((c) => c.maxItemBytes <= c.maxTotalBytes, { message: 'maxItemBytes must not exceed maxTotalBytes', path: ['maxItemBytes'] });
export type MultimodalConfig = z.input<typeof MultimodalSchema>;
