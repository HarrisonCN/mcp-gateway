/**
 * Config schema of the `offline` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/offline
 */

import { z } from 'zod';

export const ERR_OFFLINE = -32018;

export const OfflineSchema = z
  .object({
    enabled: z.boolean().default(true),
    mode: z.enum(['auto', 'online', 'offline']).default('auto'),
    probeUrl: z.string().url().default('https://1.1.1.1/'),
    probeIntervalMs: z.number().int().min(1000).max(3_600_000).default(15_000),
    probeTimeoutMs: z.number().int().min(100).max(60_000).default(3000),
    allowRemote: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type OfflineConfig = z.input<typeof OfflineSchema>;
