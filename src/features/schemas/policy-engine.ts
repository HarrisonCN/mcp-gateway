/**
 * Config schema of the `policy-engine` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/policy-engine
 */

import { z } from 'zod';
import { parseCedar } from '../../policy/cedar.js';

export const TestSchema = z
  .object({
    name: z.string().min(1),
    request: z
      .object({
        client: z.string().optional(),
        tenant: z.string().optional(),
        server: z.string().min(1),
        tool: z.string().min(1),
        args: z.record(z.unknown()).optional(),
      })
      .strict(),
    expect: z.enum(['allow', 'deny']),
  })
  .strict();

export const PolicyEngineSchema = z
  .object({
    enabled: z.boolean().default(true),
    mode: z.enum(['enforce', 'shadow']).default('enforce'),
    cedar: z.string().optional(),
    cedarFiles: z.array(z.string().min(1)).optional(),
    opa: z
      .object({
        url: z.string().url(),
        path: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_/.-]*$/, 'a data path like mcp/gateway/allow'),
        timeoutMs: z.number().int().positive().max(30_000).default(500),
        onError: z.enum(['deny', 'allow']).default('deny'),
        headers: z.record(z.string()).optional(),
      })
      .strict()
      .optional(),
    tests: z.array(TestSchema).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.cedar !== undefined) {
      try {
        parseCedar(c.cedar);
      } catch (err) {
        ctx.addIssue({ code: 'custom', path: ['cedar'], message: err instanceof Error ? err.message : String(err) });
      }
    }
    if (c.enabled && c.cedar === undefined && !c.cedarFiles?.length && !c.opa) ctx.addIssue({ code: 'custom', message: 'configure cedar, cedarFiles or opa' });
  });
export type PolicyEngineConfig = z.input<typeof PolicyEngineSchema>;
