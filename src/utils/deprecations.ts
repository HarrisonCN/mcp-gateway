/**
 * Deprecations and removals.
 *
 * 3.0 removed the 2.x deprecations, 4.0 the 3.x ones (`version: 3`, flat API-key scope fields, `least-latency`,
 * plugin API v1), 5.0 the 4.x ones (`version: 4`, `servers[].timeout`, plugin API v2, `normalizeV4Preview`):
 * using a removed form is a validation error naming its replacement ({@link removedConfigKeys}).
 * 6.0 removed the 5.x ones (`version: 5`, `compliance.pii`, plugin API v3), 7.0 the 6.x ones (`version: 6`, top-level
 * `admin` / `dashboard` → `controlPlane`), 8.0 the 7.x ones (`version: 7`, `plugins[].wasm`, plugin API v4). 9.0 the 8.x ones (`version: 8`,
 * the `state` block → `store`). Nothing is deprecated in 9.0; future deprecations are recorded once per id with {@link deprecate}, logged as warnings and listed
 * by `GET /api/v1/admin/deprecations` and `mcp-gateway validate`.
 * See docs/guides/migrating-to-v5.md.
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

/** Active deprecations (9.0: none — schema v8 and the `state` block were removed). */
export const DEPRECATIONS: Record<string, Deprecation> = {};

/** Config keys removed in 3.0 → replacement. */
export const REMOVED_IN_3: Record<string, string> = {
  corsOrigins: 'cors: { origins: [...] }',
  healthCheckIntervalMs: 'health: { intervalMs: ... }',
};

const GUIDE4 = 'run `mcp-gateway migrate` (see docs/guides/migrating-to-v4.md)';
const GUIDE5 = 'run `mcp-gateway migrate` (see docs/guides/migrating-to-v5.md)';
const GUIDE7 = 'run `mcp-gateway migrate --to 7` (see docs/guides/migrating-to-v7.md)';
const GUIDE8 = 'run `mcp-gateway migrate --to 8` (see docs/guides/migrating-to-v8.md)';
const GUIDE9 = 'run `mcp-gateway migrate --to 9` (see docs/guides/migrating-to-v9.md)';

/** Validation errors for removed keys / forms used in a raw config object (3.0 and 4.0 removals). */
export function removedConfigKeys(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const r = raw as Record<string, unknown>;
  const out = Object.entries(REMOVED_IN_3)
    .filter(([k]) => r[k] !== undefined)
    .map(([k, v]) => `${k}: removed in 3.0 — use \`${v}\` (see docs/guides/migrating-to-v3.md)`);
  if (r.version === 3) out.push(`version: config schema v3 was removed in 4.0 — use \`version: 4\`; ${GUIDE4}`);
  else if (r.version === 4) out.push(`version: config schema v4 was removed in 5.0 — use \`version: 9\`; ${GUIDE9}`);
  else if (r.version === 5) out.push(`version: config schema v5 was removed in 6.0 — use \`version: 9\`; ${GUIDE9}`);
  else if (r.version === 6) out.push(`version: config schema v6 was removed in 7.0 — use \`version: 9\`; ${GUIDE9}`);
  else if (r.version === 7) out.push(`version: config schema v7 was removed in 8.0 — use \`version: 9\`; ${GUIDE9}`);
  else if (r.version === 8) out.push(`version: config schema v8 was removed in 9.0 — use \`version: 9\`; ${GUIDE9}`);
  else if (r.version !== undefined && r.version !== 9) out.push(`version: config version ${JSON.stringify(r.version)} is not supported — 9.0 reads \`version: 9\` (see docs/guides/migrating-to-v9.md)`);
  // 9.0: the shared store is `store: { backend, … }`; the 8.x `state` block was removed.
  if (r.state !== undefined) out.push(`state: removed in 9.0 — use \`store: { backend, … }\` (\`state.store\` → \`store.backend\`); ${GUIDE9}`);
  // 8.0: core-ABI WASM plugins (`plugins[].wasm`) were removed — plugin API v5 components only.
  ((r.plugins as unknown[] | undefined) ?? []).forEach((p, i) => {
    if (p && typeof p === 'object' && (p as Record<string, unknown>).wasm !== undefined) out.push(`plugins.${i}.wasm: removed in 8.0 — rebuild against wit/mcp-gateway-plugin.wit (plugin API v5) and use \`component\`; ${GUIDE8}`);
  });
  // 7.0: `admin` / `dashboard` moved under `controlPlane`.
  if (r.admin !== undefined) out.push(`admin: removed in 7.0 — use \`controlPlane.configApi\`; ${GUIDE7}`);
  if (r.dashboard !== undefined) out.push(`dashboard: removed in 7.0 — use \`controlPlane.dashboard\`; ${GUIDE7}`);
  if ((r.compliance as { pii?: unknown } | undefined)?.pii !== undefined) out.push(`compliance.pii: removed in 6.0 — use \`dlp\`; ${GUIDE7}`);
  ((r.servers as unknown[] | undefined) ?? []).forEach((s, i) => {
    if (!s || typeof s !== 'object') return;
    if ((s as Record<string, unknown>).timeout !== undefined) out.push(`servers.${i}.timeout: removed in 5.0 — use \`timeoutMs\`; ${GUIDE5}`);
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

/** Deprecated keys used in a raw config object (9.0: none). */
export function configDeprecations(raw: unknown): Array<Deprecation & { detail?: string }> {
  if (typeof raw !== 'object' || raw === null) return [];
  return [];
}

/** Schema v9: `store: { backend, redis, failureMode }` → the internal `state` shape. */
export function normalizeStoreV9(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || (raw as { store?: unknown }).store === undefined) return raw;
  const { store, ...rest } = raw as Record<string, unknown>;
  if (!store || typeof store !== 'object' || Array.isArray(store)) return { ...rest, state: store };
  const { backend, ...st } = store as Record<string, unknown>;
  return { ...rest, state: { ...st, ...(backend !== undefined ? { store: backend } : {}) } };
}

/** Schema v5 → internal shape: `servers[].timeoutMs` becomes the internal `timeout`. */
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
