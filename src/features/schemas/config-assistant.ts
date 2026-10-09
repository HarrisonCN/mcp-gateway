/**
 * Config schema of the `config-assistant` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/config-assistant
 */

import { z } from 'zod';

export const ConfigAssistantSchema = z
  .object({
    enabled: z.boolean().default(true),
    llm: z.object({ baseUrl: z.string().url(), model: z.string().min(1), apiKey: z.string().min(1).optional(), timeoutMs: z.number().int().min(1000).max(120_000).default(30_000) }).strict().optional(),
  })
  .strict();
export type ConfigAssistantConfig = z.input<typeof ConfigAssistantSchema>;
