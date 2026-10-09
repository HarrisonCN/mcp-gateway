/**
 * Config schema of the `anomaly` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/anomaly
 */

import { z } from 'zod';
import { POLICY_ERROR_CODES } from '../../gateway/invoker.js';

export const ERR_ANOMALY_QUARANTINED = -32015;
// REST answers 403 for it, like other policy refusals.
POLICY_ERROR_CODES.add(ERR_ANOMALY_QUARANTINED);

export const AnomalySchema = z
  .object({
    enabled: z.boolean().default(true),
    action: z.enum(['alert', 'quarantine']).default('alert'),
    quarantineSeconds: z.number().int().min(1).max(86_400).default(300),
    windowMinutes: z.number().int().min(1).max(60).default(5),
    burst: z.object({ factor: z.number().min(1).default(5), min: z.number().int().min(1).default(30) }).strict().default({}),
    errors: z.object({ ratio: z.number().min(0).max(1).default(0.5), min: z.number().int().min(1).default(20) }).strict().default({}),
    enumeration: z.object({ distinctTools: z.number().int().min(2).default(25) }).strict().default({}),
    injection: z.object({ threshold: z.number().min(0).max(1).default(0.6), scan: z.enum(['arguments', 'results', 'both', 'off']).default('both') }).strict().default({}),
    exempt: z.array(z.string()).default([]),
  })
  .strict();
export type AnomalyConfig = z.input<typeof AnomalySchema>;
