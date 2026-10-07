/**
 * Deprecations scheduled for removal in 3.0.
 *
 * Config deprecations are detected on the raw (pre-validation) config by `loadConfig` and stored on
 * `config.deprecations`; runtime deprecations (legacy endpoints) are recorded once per id with
 * {@link deprecate}. Both are logged as warnings and listed by `GET /api/v1/admin/deprecations` and
 * `mcp-gateway validate`. See docs/guides/migrating-to-v3.md.
 *
 * @module utils/deprecations
 */

import { logger } from './logger.js';

export interface Deprecation {
  id: string;
  message: string;
  /** Version that removes it. */
  removedIn: '3.0.0';
  /** What to use instead. */
  replacement?: string;
}

export const DEPRECATIONS = {
  corsOrigins: { id: 'corsOrigins', removedIn: '3.0.0', replacement: 'cors.origins', message: '`corsOrigins` is deprecated; use `cors: { origins: [...] }`' },
  healthCheckIntervalMs: { id: 'healthCheckIntervalMs', removedIn: '3.0.0', replacement: 'health.intervalMs', message: '`healthCheckIntervalMs` is deprecated; use `health: { intervalMs: ... }`' },
  agentJson: { id: 'well-known-agent-json', removedIn: '3.0.0', replacement: '/.well-known/agent-card.json', message: '`/.well-known/agent.json` is deprecated; use `/.well-known/agent-card.json`' },
} as const satisfies Record<string, Deprecation>;

/** Deprecated keys used in a raw config object. */
export function configDeprecations(raw: unknown): Deprecation[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const r = raw as Record<string, unknown>;
  const out: Deprecation[] = [];
  if (r.corsOrigins !== undefined) out.push(DEPRECATIONS.corsOrigins);
  if (r.healthCheckIntervalMs !== undefined) out.push(DEPRECATIONS.healthCheckIntervalMs);
  return out;
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
