/**
 * Config schema of the `semantic-cache` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/semantic-cache
 */

import { z } from 'zod';

export const SemanticCacheSchema = z
  .object({
    enabled: z.boolean().default(true),
    tools: z.array(z.string().min(1)).min(1),
    threshold: z.number().min(0.5).max(1).default(0.9),
    ttlSeconds: z.number().int().min(1).default(3600),
    maxEntries: z.number().int().min(1).max(1_000_000).default(5000),
    scope: z.enum(['tenant', 'client', 'global']).default('tenant'),
    embedding: z
      .object({
        provider: z.enum(['local', 'openai']).default('local'),
        url: z.string().url().optional(),
        model: z.string().min(1).default('text-embedding-3-small'),
        apiKeyEnv: z.string().min(1).optional(),
        dimensions: z.number().int().min(64).max(4096).default(512),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.embedding.provider === 'openai' && !c.embedding.url) ctx.addIssue({ code: 'custom', path: ['embedding', 'url'], message: 'the openai provider needs `url` (e.g. https://api.openai.com/v1)' });
  });
export type SemanticCacheConfig = z.input<typeof SemanticCacheSchema>;
