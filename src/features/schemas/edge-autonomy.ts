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

/** Offline risk levels (14.6.0); `high` and `critical` are denied offline unless a policy allows them. */
export const RISKS = ['low', 'medium', 'high', 'critical'] as const;
export type OfflineRisk = (typeof RISKS)[number];

/** A declared offline policy for matching `server/tool` (14.6.0; first match wins). */
export const OfflinePolicy = z
  .object({
    match: z.string().min(1),
    /** `allow`: may be answered / queued offline whatever its risk; `deny`: never; unset: by risk (`highRisk`). */
    offline: z.enum(['allow', 'deny']).optional(),
    /** Declared risk; replaces the classifier (annotations, tool-name heuristics). */
    risk: z.enum(RISKS).optional(),
    /** The call may be repeated safely (an in-doubt replay is resent with the same idempotency key). */
    idempotent: z.boolean().optional(),
    /** Argument names identifying the record a call writes: concurrent offline writes by different clients go to review. */
    conflictKey: z.array(z.string().min(1)).min(1).optional(),
    /** Queue TTL for matching calls (overrides `queue.ttlSeconds`). */
    ttlSeconds: z.number().int().min(1).max(365 * 86_400).optional(),
  })
  .strict();

export const EdgeAutonomySchema = z
  .object({
    enabled: z.boolean().default(true),
    dir: z.string().min(1).optional(),
    rules: z.array(Rule).min(1),
    /** 14.6.0: declared per server / tool offline policies (first match on "server/tool"). */
    policies: z.array(OfflinePolicy).default([]),
    /** 14.6.0: what happens offline to a high / critical risk call no policy allows (writes, deletes, payments, non-idempotent). */
    highRisk: z.enum(['deny', 'allow']).default('deny'),
    cacheEntries: z.number().int().min(1).max(100_000).default(1000),
    /** Maximum queued calls (also `queue.maxItems`, which wins). */
    outboxLimit: z.number().int().min(1).max(100_000).default(10_000),
    /** 14.6.0: queue expiry. */
    queue: z
      .object({
        ttlSeconds: z.number().int().min(1).max(365 * 86_400).default(86_400),
        maxItems: z.number().int().min(1).max(100_000).optional(),
        /** `review`: an expired call is parked for an operator; `drop`: it is removed. Never replayed either way. */
        onExpiry: z.enum(['review', 'drop']).default('review'),
      })
      .strict()
      .default({}),
    reconcile: z
      .object({
        intervalMs: z.number().int().min(100).max(3_600_000).default(5000),
        maxAttempts: z.number().int().min(1).max(100).default(5),
        idempotencyArg: z.string().min(1).optional(),
        /** 14.6.0: reconcile lease (one reconciler at a time; a crashed one is taken over after this). */
        leaseMs: z.number().int().min(500).max(3_600_000).default(30_000),
        /** 14.6.0: replay only after revocations are confirmed fresh (multi-region peers synced since reconnect). */
        requireFreshRevocations: z.boolean().default(true),
      })
      .strict()
      .default({}),
    /** 14.6.0: sealing of the persisted queue / cache (AES-256-GCM). Key: env var `keyEnv` (32 bytes, base64 or hex), else `<dir>/.seal.key`. */
    seal: z
      .object({
        keyEnv: z.string().min(1).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type EdgeAutonomyConfig = z.input<typeof EdgeAutonomySchema>;
