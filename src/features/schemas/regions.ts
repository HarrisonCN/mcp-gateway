/**
 * Config schema of the `regions` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/regions
 */

import { z } from 'zod';

/**
 * 14.5.0: consistency contract of the mesh — how stale a region may be before it stops serving tool calls, and how far
 * a peer's clock may run ahead before its stamped writes are refused.
 */
export const RegionConsistencySchema = z
  .object({
    /**
     * Bounded staleness: a region is *fresh* while every peer has synced with it within this window. A key revoked in
     * any region is refused everywhere within it — or a region that cannot confirm it (partition, peer down) refuses.
     * Default: the larger of 30 s and 3 × `syncIntervalMs`; at least 2 × `syncIntervalMs` when set.
     */
    maxStalenessMs: z.number().int().min(500).optional(),
    /** Replicated writes stamped further than this ahead of the local clock are rejected (and never move the clock). */
    maxClockSkewMs: z.number().int().min(0).default(30_000),
    /** What a region does with tool calls while it is not fresh: `deny` (fail closed, default) or `allow` (14.4 behaviour). */
    onStale: z.enum(['deny', 'allow']).default('deny'),
  })
  .strict();

export const RegionsSchema = z
  .object({
    self: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes'),
    syncIntervalMs: z.number().int().min(250).default(5000),
    /** Consecutive failed syncs before a peer is considered down. */
    downAfter: z.number().int().min(1).default(3),
    peers: z
      .array(z.object({ id: z.string().min(1), url: z.string().url(), apiKey: z.string().optional(), priority: z.number().int().min(0).default(100) }).strict())
      .default([]),
    /** 14.5.0: consistency boundaries (bounded staleness, clock skew, fail-closed partitions). */
    consistency: RegionConsistencySchema.default({}),
  })
  .strict()
  .superRefine((c, ctx) => {
    const m = c.consistency.maxStalenessMs;
    if (m !== undefined && m < 2 * c.syncIntervalMs)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['consistency', 'maxStalenessMs'], message: `consistency.maxStalenessMs (${m}) must be at least 2 × syncIntervalMs (${2 * c.syncIntervalMs})` });
  })
  .transform((c) => ({ ...c, consistency: { ...c.consistency, maxStalenessMs: c.consistency.maxStalenessMs ?? Math.max(30_000, 3 * c.syncIntervalMs) } }));
export type RegionsConfig = z.input<typeof RegionsSchema>;
