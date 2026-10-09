/**
 * Config schema of the `edge-autonomy` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/edge-autonomy
 */

import { z } from 'zod';

/** Same code as the offline feature: refused because the network / upstream is gone. */
export const ERR_EDGE_DENIED = -32018;

export const Rule = z
  .object({
    match: z.string().min(1),
    action: z.enum(['cache', 'wasm', 'queue', 'deny']),
    maxAgeSeconds: z.number().int().min(1).max(365 * 86_400).default(86_400),
    wasmTool: z.string().min(1).optional(),
    message: z.string().optional(),
  })
  .strict()
  .refine((r) => r.action !== 'wasm' || r.wasmTool, { message: 'action: wasm needs "wasmTool" (a features.edgeRuntime tool name)' });

export const EdgeAutonomySchema = z
  .object({
    enabled: z.boolean().default(true),
    dir: z.string().min(1).optional(),
    rules: z.array(Rule).min(1),
    cacheEntries: z.number().int().min(1).max(100_000).default(1000),
    outboxLimit: z.number().int().min(1).max(100_000).default(10_000),
    reconcile: z
      .object({
        intervalMs: z.number().int().min(100).max(3_600_000).default(5000),
        maxAttempts: z.number().int().min(1).max(100).default(5),
        idempotencyArg: z.string().min(1).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type EdgeAutonomyConfig = z.input<typeof EdgeAutonomySchema>;
