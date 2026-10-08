/** Zod schema for one `policy.rules[]` entry (shared by the config loader and policy simulation, 6.5). */
import { z } from 'zod';

export const PolicyRuleSchema = z
  .object({
    name: z.string().optional(),
    effect: z.enum(['allow', 'deny', 'approve']),
    clients: z.array(z.string()).optional(),
    servers: z.array(z.string()).optional(),
    tools: z.array(z.string()).optional(),
    args: z
      .array(
        z
          .object({
            path: z.string().min(1),
            exists: z.boolean().optional(),
            equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
            in: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
            glob: z.array(z.string()).optional(),
            notGlob: z.array(z.string()).optional(),
            regex: z.string().optional(),
            notRegex: z.string().optional(),
            longerThan: z.number().int().min(0).optional(),
            under: z.array(z.string()).optional(),
            notUnder: z.array(z.string()).optional(),
          })
          .strict(),
      )
      .optional(),
    message: z.string().optional(),
  })
  .strict();
