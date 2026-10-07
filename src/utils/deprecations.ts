/**
 * Deprecations and removals.
 *
 * 3.0 removed the 2.x deprecations (`corsOrigins`, `healthCheckIntervalMs`, `/.well-known/agent.json`): using a
 * removed config key is a validation error naming its replacement ({@link removedConfigKeys}). Current deprecations
 * (scheduled for 4.0) are recorded once per id with {@link deprecate}, logged as warnings and listed by
 * `GET /api/v1/admin/deprecations` and `mcp-gateway validate`. See docs/guides/migrating-to-v3.md.
 *
 * @module utils/deprecations
 */

import { logger } from './logger.js';

export interface Deprecation {
  id: string;
  message: string;
  /** Version that removes it. */
  removedIn: string;
  /** What to use instead. */
  replacement?: string;
}

export const DEPRECATIONS = {
  pluginApiV1: { id: 'plugin-api-v1', removedIn: '4.0.0', replacement: 'apiVersion: 2', message: 'plugin API v1 is deprecated; declare `apiVersion: 2` (hooks receive a context argument)' },
} as const satisfies Record<string, Deprecation>;

/** Config keys removed in 3.0 → replacement. */
export const REMOVED_IN_3: Record<string, string> = {
  corsOrigins: 'cors: { origins: [...] }',
  healthCheckIntervalMs: 'health: { intervalMs: ... }',
};

/** Validation errors for removed keys used in a raw config object. */
export function removedConfigKeys(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const r = raw as Record<string, unknown>;
  const out = Object.entries(REMOVED_IN_3)
    .filter(([k]) => r[k] !== undefined)
    .map(([k, v]) => `${k}: removed in 3.0 — use \`${v}\` (see docs/guides/migrating-to-v3.md)`);
  if (r.version !== undefined && r.version !== 3) out.push(`version: config version ${JSON.stringify(r.version)} is not supported — 3.x reads \`version: 3\` (see docs/guides/migrating-to-v3.md)`);
  return out;
}

/** Deprecated keys used in a raw config object (none in 3.0; kept for the 4.0 cycle). */
export function configDeprecations(_raw: unknown): Deprecation[] {
  return [];
}

const seen = new Map<string, Deprecation & { detail?: string }>();

/** Record (and log once) a runtime deprecation. */
export function deprecate(d: Deprecation, detail?: string): void {
  const key = `${d.id}\u0000${detail ?? ''}`;
  if (seen.has(key)) return;
  seen.set(key, { ...d, detail });
  logger.warn(`DEPRECATED (removed in ${d.removedIn}): ${d.message}${detail ? ` — ${detail}` : ''}`);
}

export function runtimeDeprecations(): Array<Deprecation & { detail?: string }> {
  return [...seen.values()];
}

/** Test helper. */
export function resetDeprecations(): void {
  seen.clear();
}
