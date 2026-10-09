/**
 * Config schema of the `api-upstreams` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/api-upstreams
 */

import { z } from 'zod';

export const Name = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const Common = { id: Name, url: z.string().url(), headers: z.record(z.string()).default({}), timeoutMs: z.number().int().min(100).max(120_000).default(15_000) };
export const GraphqlUpstream = z
  .object({ ...Common, kind: z.literal('graphql'), operations: z.array(z.object({ name: Name, description: z.string().optional(), document: z.string().min(1) }).strict()).min(1) })
  .strict();
export const GrpcUpstream = z
  .object({
    ...Common,
    kind: z.literal('grpc'),
    methods: z
      .array(z.object({ name: Name, description: z.string().optional(), service: z.string().regex(/^[A-Za-z_][\w.]*$/), method: z.string().regex(/^[A-Za-z_]\w*$/), inputSchema: z.record(z.unknown()).optional() }).strict())
      .min(1),
  })
  .strict();
export const ApiUpstreamsSchema = z
  .array(z.discriminatedUnion('kind', [GraphqlUpstream, GrpcUpstream]))
  .superRefine((ups, ctx) => {
    const seen = new Set<string>();
    ups.forEach((u, i) => {
      if (seen.has(u.id)) ctx.addIssue({ code: 'custom', path: [i, 'id'], message: `duplicate upstream id "${u.id}"` });
      seen.add(u.id);
    });
  });
export type ApiUpstreamsConfig = z.input<typeof ApiUpstreamsSchema>;
