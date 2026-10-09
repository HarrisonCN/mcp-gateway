/**
 * Config schema of the `sessions` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/sessions
 */

import { z } from 'zod';

export const SessionsSchema = z.object({ dir: z.string().min(1).optional(), maxRecordings: z.number().int().positive().default(100) }).strict();
export type SessionsConfig = z.input<typeof SessionsSchema>;
