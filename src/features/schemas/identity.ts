/**
 * Config schema of the `identity` feature module (13.0: split from the module so validating a config never
 * evaluates the module itself).
 *
 * @module features/schemas/identity
 */

import { z } from 'zod';

export const Role = z.enum(['viewer', 'admin', 'owner']);
export const IdentitySchema = z
  .object({
    oidc: z
      .object({
        issuer: z.string().url(),
        clientId: z.string().min(1),
        redirectUri: z.string().url().optional(),
        scopes: z.array(z.string()).default(['openid', 'email', 'profile', 'groups']),
        groupsClaim: z.string().default('groups'),
        jwksUrl: z.string().url().optional(),
        jwks: z.object({ keys: z.array(z.record(z.unknown())) }).optional(),
        authorizationEndpoint: z.string().url().optional(),
      })
      .strict()
      .optional(),
    groupRoles: z.array(z.object({ group: z.string().min(1), tenant: z.string().min(1), role: Role.default('viewer') }).strict()).default([]),
    storePath: z.string().optional(),
  })
  .strict();
export type IdentityConfig = z.input<typeof IdentitySchema>;
