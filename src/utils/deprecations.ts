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
  // 3.9: config schema v4 previews (run `mcp-gateway migrate`).
  configVersion3: { id: 'config-version-3', removedIn: '4.0.0', replacement: 'version: 4', message: 'config schema v3 (`version: 3`) is deprecated; 4.0 reads `version: 4` — run `mcp-gateway migrate`' },
  apiKeyFlatScope: { id: 'api-key-flat-scope', removedIn: '4.0.0', replacement: 'auth.apiKeys[].scope: { servers, tools, rateLimit }', message: '`servers` / `tools` / `rateLimit` directly on an API key are deprecated; nest them under `scope:` — run `mcp-gateway migrate`' },
  leastLatency: { id: 'least-latency-strategy', removedIn: '4.0.0', replacement: 'strategy: smart, score: { latency: 1, errorRate: 0, cost: 0 }', message: '`loadBalancing.strategy: least-latency` is deprecated; use `smart` with a latency-only score — run `mcp-gateway migrate`' },
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
  if (r.version !== undefined && r.version !== 3 && r.version !== 4) out.push(`version: config version ${JSON.stringify(r.version)} is not supported — 3.9 reads \`version: 3\` or \`version: 4\` (see docs/guides/migrating-to-v3.md)`);
  return out;
}

/** Deprecated keys used in a raw config object (3.9: the v3 forms that 4.0 removes). */
export function configDeprecations(raw: unknown): Array<Deprecation & { detail?: string }> {
  if (typeof raw !== 'object' || raw === null) return [];
  const r = raw as Record<string, unknown>;
  const out: Array<Deprecation & { detail?: string }> = [];
  if (r.version === 3) out.push({ ...DEPRECATIONS.configVersion3 });
  const keys = (r.auth as { apiKeys?: unknown[] } | undefined)?.apiKeys ?? [];
  const flat = keys
    .map((k, i) => (k && typeof k === 'object' && ['servers', 'tools', 'rateLimit'].some((f) => f in (k as object)) ? ((k as { name?: string }).name ?? `#${i}`) : undefined))
    .filter((x): x is string => x !== undefined);
  if (flat.length) out.push({ ...DEPRECATIONS.apiKeyFlatScope, detail: `keys: ${flat.join(', ')}` });
  const ll = ((r.servers as unknown[] | undefined) ?? [])
    .filter((s) => (s as { loadBalancing?: { strategy?: string } })?.loadBalancing?.strategy === 'least-latency')
    .map((s) => String((s as { id?: unknown }).id));
  if (ll.length) out.push({ ...DEPRECATIONS.leastLatency, detail: `servers: ${ll.join(', ')}` });
  return out;
}

/** Normalise the v4 forms 3.9 already accepts into the v3 shape the schema validates (3.9). */
export function normalizeV4Preview(raw: unknown): { raw: unknown; errors: string[] } {
  if (typeof raw !== 'object' || raw === null) return { raw, errors: [] };
  const r = { ...(raw as Record<string, unknown>) };
  const errors: string[] = [];
  const auth = r.auth as { apiKeys?: unknown[] } | undefined;
  if (auth?.apiKeys) {
    r.auth = {
      ...auth,
      apiKeys: auth.apiKeys.map((k, i) => {
        if (!k || typeof k !== 'object' || !('scope' in (k as object))) return k;
        const { scope, ...rest } = k as Record<string, unknown> & { scope?: Record<string, unknown> };
        const clash = ['servers', 'tools', 'rateLimit'].filter((f) => f in rest && scope && f in scope);
        if (clash.length) errors.push(`auth.apiKeys.${i}: ${clash.join(', ')} set both directly and under scope`);
        if (scope !== undefined && (typeof scope !== 'object' || scope === null || Array.isArray(scope))) {
          errors.push(`auth.apiKeys.${i}.scope: must be an object`);
          return rest;
        }
        const extra = Object.keys(scope ?? {}).filter((f) => !['servers', 'tools', 'rateLimit'].includes(f));
        if (extra.length) errors.push(`auth.apiKeys.${i}.scope: unknown key(s) ${extra.join(', ')}`);
        return { ...rest, ...(scope ?? {}) };
      }),
    };
  }
  return { raw: r, errors };
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
