/**
 * Config schema of the `agent-identity` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/agent-identity
 */

import { z } from 'zod';

/** JSON-RPC error: the tool needs an agent delegation token (8.1). */
export const ERR_AGENT_REQUIRED = -32019;

export const Agent = z
  .object({
    id: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/),
    name: z.string().optional(),
    tools: z.array(z.string().min(1)).min(1),
    delegators: z.array(z.string().min(1)).default(['*']),
    enabled: z.boolean().default(true),
  })
  .strict();

export const AgentIdentitySchema = z
  .object({
    enabled: z.boolean().default(true),
    signingKey: z.string().min(32, 'signingKey must be at least 32 characters'),
    issuer: z.string().min(1).default('mcp-gateway'),
    tokenTtlSeconds: z.number().int().min(10).max(86_400).default(900),
    maxDelegationDepth: z.number().int().min(1).max(8).default(2),
    requireAgentFor: z.array(z.string().min(1)).default([]),
    agents: z.array(Agent).default([]),
    /**
     * Token revocation (11.2): revocations and issued-token records live in the shared state store (`store.backend`:
     * redis for several instances / Kubernetes, sqlite or eventlog for a durable single node, memory for development
     * only) with TTL = token expiry. `failureMode: closed` (default) denies token-authenticated agent calls while the
     * store is unreachable; `open` accepts them (logged + counted).
     */
    revocation: z.object({ failureMode: z.enum(['closed', 'open']).default('closed') }).strict().default({}),
  })
  .strict()
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.agents.forEach((a, i) => {
      if (seen.has(a.id)) ctx.addIssue({ code: 'custom', path: ['agents', i, 'id'], message: `duplicate agent id "${a.id}"` });
      seen.add(a.id);
    });
  });
export type AgentIdentityConfig = z.input<typeof AgentIdentitySchema>;
