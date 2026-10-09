/**
 * Config schema of the `genai-otel` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/genai-otel
 */

import { z } from 'zod';

export const GenaiTelemetrySchema = z
  .object({
    enabled: z.boolean().default(true),
    systems: z.record(z.string().min(1)).default({}),
    modelArg: z.string().min(1).default('model'),
    captureContent: z.boolean().default(false),
    otlpEndpoint: z.string().url().optional(),
    exportIntervalMs: z.number().int().min(1000).max(600_000).default(10_000),
    serviceName: z.string().min(1).default('mcp-gateway'),
  })
  .strict();
export type GenaiTelemetryConfig = z.input<typeof GenaiTelemetrySchema>;
