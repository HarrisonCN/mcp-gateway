/**
 * Config schema of the `edge-runtime` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/edge-runtime
 */

import { z } from 'zod';

/** JSON-RPC error of an edge WASM tool failure or quota (9.2). */
export const ERR_EDGE_RUNTIME = -32023;

export const Tool = z
  .object({
    name: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/),
    wasm: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    export: z.string().min(1).default('run'),
    description: z.string().default(''),
    inputSchema: z.record(z.unknown()).default({ type: 'object' }),
    limits: z
      .object({ timeoutMs: z.number().int().min(1).max(60_000).default(100), memoryMb: z.number().int().min(1).max(1024).default(16), maxConcurrent: z.number().int().min(1).max(256).default(4) })
      .strict()
      .default({}),
    warm: z.number().int().min(0).max(64).default(1),
  })
  .strict()
  .refine((t) => t.warm <= t.limits.maxConcurrent, { message: 'warm must not exceed limits.maxConcurrent', path: ['warm'] });

export const EdgeRuntimeSchema = z
  .object({ enabled: z.boolean().default(true), idleSeconds: z.number().int().min(1).default(300), tools: z.array(Tool).default([]) })
  .strict()
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.tools.forEach((t, i) => {
      if (seen.has(t.name)) ctx.addIssue({ code: 'custom', path: ['tools', i, 'name'], message: `duplicate edge tool "${t.name}"` });
      seen.add(t.name);
    });
  });
export type EdgeRuntimeConfig = z.input<typeof EdgeRuntimeSchema>;
