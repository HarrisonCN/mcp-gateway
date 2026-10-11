/**
 * `${VAR}` references in credentials (MGW-2026-019, 14.7.0): expanded from the gateway's environment in every API key
 * form (`auth.apiKeys: ["${KEY}"]` and `{ key: "${KEY}" }`) and in `controlPlane.token`. A reference to an unset or
 * empty variable is a config error — it is never used literally (anyone could send the literal text) nor as an empty key.
 *
 * @module config/env-ref
 */
import { z } from 'zod';
import { expandEnv } from '../transport/channel.js';

const REF = /\$\{([^}]+)\}/g;

/** Expand `${VAR}` in a credential; adds a config issue (and keeps the value) when a referenced variable is unset. */
export function expandCredential(value: string, ctx: z.RefinementCtx): string {
  if (!value.includes('${')) return value;
  const missing = [...new Set([...value.matchAll(REF)].map((m) => m[1]!).filter((n) => !process.env[n]))];
  if (missing.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `references environment variable${missing.length > 1 ? 's' : ''} ${missing.join(', ')}, which ${missing.length > 1 ? 'are' : 'is'} not set (a \${VAR} reference is never used as a literal key)` });
    return value;
  }
  return expandEnv(value);
}
