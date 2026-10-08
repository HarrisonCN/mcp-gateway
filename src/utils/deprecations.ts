/**
 * Deprecations and removals.
 *
 * 3.0 removed the 2.x deprecations and 4.0 the 3.x ones (`version: 3`, flat API-key scope fields, `least-latency`,
 * plugin API v1): using a removed form is a validation error naming its replacement ({@link removedConfigKeys}).
 * Current deprecations (all scheduled for 5.0: plugin API v2, `version: 4`, `servers[].timeout`) are recorded once per
 * id with {@link deprecate}, logged as warnings and listed by `GET /api/v1/admin/deprecations` and
 * `mcp-gateway validate`. 4.9 already reads schema v5 (`version: 5`, `servers[].timeoutMs`), so a file migrated with
 * `mcp-gateway migrate --to 5` works before and after upgrading. See docs/guides/migrating-to-v5.md.
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
  // 4.0: plugin API v2 keeps loading until 5.0.
  pluginApiV2: { id: 'plugin-api-v2', removedIn: '5.0.0', replacement: 'apiVersion: 4', message: 'plugin API v2 is deprecated and refused by 5.0; declare `apiVersion: 4` (adds ctx.secrets, ctx.tenant, onConfigChange and ctx.state)' },
  // 4.9: schema v5 preview — the v4 forms below are refused by 5.0.
  configVersion4: { id: 'config-version-4', removedIn: '5.0.0', replacement: 'version: 5', message: 'config schema v4 is deprecated; 5.0 reads `version: 5` — run `mcp-gateway migrate --to 5`' },
  serverTimeout: { id: 'config-server-timeout', removedIn: '5.0.0', replacement: 'servers[].timeoutMs', message: '`servers[].timeout` is renamed to `timeoutMs` in schema v5 — run `mcp-gateway migrate --to 5`' },
  normalizeV4Preview: { id: 'api-normalizeV4Preview', removedIn: '5.0.0', replacement: 'normalizeApiKeyScopes', message: '`normalizeV4Preview()` is removed in 5.0; use `normalizeApiKeyScopes()`' },
} as const satisfies Record<string, Deprecation>;

/** Config keys removed in 3.0 → replacement. */
export const REMOVED_IN_3: Record<string, string> = {
  corsOrigins: 'cors: { origins: [...] }',
  healthCheckIntervalMs: 'health: { intervalMs: ... }',
};

const GUIDE4 = 'run `mcp-gateway migrate` (see docs/guides/migrating-to-v4.md)';
const GUIDE5 = 'run `mcp-gateway migrate --to 5` (see docs/guides/migrating-to-v5.md)';

/** Validation errors for removed keys / forms used in a raw config object (3.0 and 4.0 removals). */
export function removedConfigKeys(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const r = raw as Record<string, unknown>;
  const out = Object.entries(REMOVED_IN_3)
    .filter(([k]) => r[k] !== undefined)
    .map(([k, v]) => `${k}: removed in 3.0 — use \`${v}\` (see docs/guides/migrating-to-v3.md)`);
  if (r.version === 3) out.push(`version: config schema v3 was removed in 4.0 — use \`version: 4\`; ${GUIDE4}`);
  else if (r.version !== undefined && r.version !== 4 && r.version !== 5) out.push(`version: config version ${JSON.stringify(r.version)} is not supported — 4.9 reads \`version: 4\` and \`version: 5\` (see docs/guides/migrating-to-v5.md)`);
  ((r.servers as unknown[] | undefined) ?? []).forEach((s, i) => {
    if (!s || typeof s !== 'object') return;
    const o = s as Record<string, unknown>;
    if (r.version === 5 && o.timeout !== undefined) out.push(`servers.${i}.timeout: schema v5 names it \`timeoutMs\`; ${GUIDE5}`);
    else if (o.timeout !== undefined && o.timeoutMs !== undefined) out.push(`servers.${i}: set either \`timeout\` (v4) or \`timeoutMs\` (v5), not both`);
  });
  const keys = (r.auth as { apiKeys?: unknown[] } | undefined)?.apiKeys ?? [];
  keys.forEach((k, i) => {
    if (!k || typeof k !== 'object') return;
    const flat = ['servers', 'tools', 'rateLimit'].filter((f) => f in (k as object));
    if (flat.length) out.push(`auth.apiKeys.${i}: ${flat.join(', ')} directly on an API key was removed in 4.0 — nest under \`scope: { servers, tools, rateLimit }\`; ${GUIDE4}`);
  });
  ((r.servers as unknown[] | undefined) ?? []).forEach((s, i) => {
    if ((s as { loadBalancing?: { strategy?: string } })?.loadBalancing?.strategy === 'least-latency') {
      out.push(`servers.${i}.loadBalancing.strategy: least-latency was removed in 4.0 — use \`strategy: smart\` with \`score: { latency: 1, errorRate: 0, cost: 0 }\`; ${GUIDE4}`);
    }
  });
  return out;
}

/** Deprecated keys used in a raw config object (4.9: the v4 forms that 5.0 refuses). */
export function configDeprecations(raw: unknown): Array<Deprecation & { detail?: string }> {
  if (typeof raw !== 'object' || raw === null) return [];
  const r = raw as Record<string, unknown>;
  const out: Array<Deprecation & { detail?: string }> = [];
  if (r.version === 4) out.push({ ...DEPRECATIONS.configVersion4 });
  const ids = ((r.servers as unknown[] | undefined) ?? [])
    .filter((s) => s && typeof s === 'object' && (s as Record<string, unknown>).timeout !== undefined)
    .map((s) => String((s as Record<string, unknown>).id));
  if (ids.length) out.push({ ...DEPRECATIONS.serverTimeout, detail: `servers: ${ids.join(', ')}` });
  return out;
}

/** Schema v5 → internal shape: `servers[].timeoutMs` becomes the internal `timeout` (4.9 reads both). */
export function normalizeSchemaV5(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { servers?: unknown }).servers)) return raw;
  const r = raw as Record<string, unknown> & { servers: unknown[] };
  return {
    ...r,
    servers: r.servers.map((s) => {
      if (!s || typeof s !== 'object' || !('timeoutMs' in (s as object))) return s;
      const { timeoutMs, ...rest } = s as Record<string, unknown>;
      return { ...rest, timeout: timeoutMs };
    }),
  };
}

/** Flatten `auth.apiKeys[].scope` into the internal key shape (the v4 schema nests scope; internals stay flat). */
export function normalizeApiKeyScopes(raw: unknown): { raw: unknown; errors: string[] } {
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

/** @deprecated 3.9 name of {@link normalizeApiKeyScopes}; removed in 5.0. */
export function normalizeV4Preview(raw: unknown): { raw: unknown; errors: string[] } {
  deprecate(DEPRECATIONS.normalizeV4Preview);
  return normalizeApiKeyScopes(raw);
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
