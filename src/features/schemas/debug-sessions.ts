/**
 * Config schema of the `debug-sessions` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/debug-sessions
 */

import { z } from 'zod';

/** JSON-RPC error: a call paused at a debug breakpoint was aborted or timed out (8.3). */
export const ERR_DEBUG_ABORTED = -32020;

export const DebugSessionsSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxSessions: z.number().int().min(1).max(100).default(10),
    holdTimeoutSeconds: z.number().int().min(1).max(3600).default(60),
    maxEvents: z.number().int().min(10).max(10_000).default(500),
  })
  .strict();
export type DebugSessionsConfig = z.input<typeof DebugSessionsSchema>;
