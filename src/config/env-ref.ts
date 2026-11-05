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

function missingRefs(value: string): string[] {
  if (!value.includes('${')) return [];
  return [...new Set([...value.matchAll(REF)].map((m) => m[1]!).filter((n) => !process.env[n]))];
}

/** Adds a config issue when a credential references an unset `${VAR}`. */
export function checkCredential(value: string, ctx: z.RefinementCtx): void {
  const missing = missingRefs(value);
  if (missing.length) {
    ctx.addIssue({ code: 'custom', message: `references environment variable${missing.length > 1 ? 's' : ''} ${missing.join(', ')}, which ${missing.length > 1 ? 'are' : 'is'} not set (a \${VAR} reference is never used as a literal key)` });
  }
}

/** Expand `${VAR}` in a credential; keeps the value unchanged when a referenced variable is unset. */
export function expandCredentialValue(value: string): string {
  if (!value.includes('${') || missingRefs(value).length) return value;
  return expandEnv(value);
}

/**
 * A credential string: unset references are reported by a refinement, then the value is expanded. Inside a
 * `z.union`, validate with `checkCredential` in the branches and expand after the union instead (17.0.2: zod 4 does
 * not pick a branch whose transform pipe failed, so the "not set" issue would surface only as "Invalid input").
 */
export function credentialString<T extends z.ZodString>(base: T) {
  return base.superRefine(checkCredential).transform(expandCredentialValue);
}
