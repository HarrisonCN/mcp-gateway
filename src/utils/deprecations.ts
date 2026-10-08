/**
 * Deprecations and removals.
 *
 * 3.0 removed the 2.x deprecations, 4.0 the 3.x ones (`version: 3`, flat API-key scope fields, `least-latency`,
 * plugin API v1), 5.0 the 4.x ones (`version: 4`, `servers[].timeout`, plugin API v2, `normalizeV4Preview`):
 * using a removed form is a validation error naming its replacement ({@link removedConfigKeys}).
 * 6.0 removed the 5.x ones (`version: 5`, `compliance.pii`, plugin API v3). Current deprecations (6.9: schema v6,
 * `admin`, `dashboard` → `controlPlane`; removed in 7.0) are recorded once per id with {@link deprecate}, logged as
 * warnings and listed by `GET /api/v1/admin/deprecations` and `mcp-gateway validate`.
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

export const DEPRECATIONS = {
  // 6.9: schema v6 and the top-level `admin` / `dashboard` sections are replaced by schema v7's `controlPlane` (7.0).
  schemaV6: { id: 'schema-v6', removedIn: '7.0.0', replacement: 'version: 7', message: 'config schema v6 is deprecated; `mcp-gateway migrate --to 7` writes `version: 7`' },
  adminSection: { id: 'admin-section', removedIn: '7.0.0', replacement: 'controlPlane: { configApi }', message: '`admin.configApi` is deprecated; use `controlPlane.configApi` (`mcp-gateway migrate --to 7` moves it)' },
  dashboardSection: { id: 'dashboard-section', removedIn: '7.0.0', replacement: 'controlPlane: { dashboard }', message: '`dashboard.enabled` is deprecated; use `controlPlane.dashboard` (`mcp-gateway migrate --to 7` moves it)' },
} as const satisfies Record<string, Deprecation>;

/** Config keys removed in 3.0 → replacement. */
export const REMOVED_IN_3: Record<string, string> = {
  corsOrigins: 'cors: { origins: [...] }',
  healthCheckIntervalMs: 'health: { intervalMs: ... }',
};

const GUIDE4 = 'run `mcp-gateway migrate` (see docs/guides/migrating-to-v4.md)';
const GUIDE5 = 'run `mcp-gateway migrate` (see docs/guides/migrating-to-v5.md)';
const GUIDE6 = 'run `mcp-gateway migrate --to 6` (see docs/guides/migrating-to-v6.md)';
const GUIDE7 = 'run `mcp-gateway migrate --to 7` (see docs/guides/migrating-to-v7.md)';

/** Validation errors for removed keys / forms used in a raw config object (3.0 and 4.0 removals). */
export function removedConfigKeys(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const r = raw as Record<string, unknown>;
  const out = Object.entries(REMOVED_IN_3)
    .filter(([k]) => r[k] !== undefined)
    .map(([k, v]) => `${k}: removed in 3.0 — use \`${v}\` (see docs/guides/migrating-to-v3.md)`);
  if (r.version === 3) out.push(`version: config schema v3 was removed in 4.0 — use \`version: 4\`; ${GUIDE4}`);
  else if (r.version === 4) out.push(`version: config schema v4 was removed in 5.0 — use \`version: 6\`; ${GUIDE6}`);
  else if (r.version === 5) out.push(`version: config schema v5 was removed in 6.0 — use \`version: 6\`; ${GUIDE6}`);
  else if (r.version !== undefined && r.version !== 6 && r.version !== 7) out.push(`version: config version ${JSON.stringify(r.version)} is not supported — 6.9 reads \`version: 6\` or \`version: 7\` (see docs/guides/migrating-to-v7.md)`);
  // 6.9: schema v7 preview — `admin` / `dashboard` moved under `controlPlane`.
  if (r.version === 7) {
    if (r.admin !== undefined) out.push(`admin: not part of config schema v7 — use \`controlPlane.configApi\`; ${GUIDE7}`);
    if (r.dashboard !== undefined) out.push(`dashboard: not part of config schema v7 — use \`controlPlane.dashboard\`; ${GUIDE7}`);
  }
  const cp = r.controlPlane as Record<string, unknown> | undefined;
  if (cp && typeof cp === 'object' && ((cp.configApi !== undefined && r.admin !== undefined) || (cp.dashboard !== undefined && r.dashboard !== undefined))) out.push(`controlPlane: set either \`controlPlane\` or the deprecated \`admin\` / \`dashboard\` sections, not both; ${GUIDE7}`);
  if ((r.compliance as { pii?: unknown } | undefined)?.pii !== undefined) out.push(`compliance.pii: removed in 6.0 — use \`dlp\`; ${GUIDE6}`);
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

/** Deprecated keys used in a raw config object (6.9: schema v6, `admin`, `dashboard`; removed in 7.0). */
export function configDeprecations(raw: unknown): Array<Deprecation & { detail?: string }> {
  if (typeof raw !== 'object' || raw === null) return [];
  const r = raw as Record<string, unknown>;
  const out: Array<Deprecation & { detail?: string }> = [];
  if (r.version === 6) out.push({ ...DEPRECATIONS.schemaV6, detail: 'version: 6' });
  if (r.admin !== undefined) out.push({ ...DEPRECATIONS.adminSection, detail: 'admin' });
  if (r.dashboard !== undefined) out.push({ ...DEPRECATIONS.dashboardSection, detail: 'dashboard' });
  return out;
}

/** Schema v7 preview (6.9) → internal shape: `controlPlane.configApi` / `.dashboard` become `admin` / `dashboard`. */
export function normalizeControlPlane(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const r = raw as Record<string, unknown>;
  const cp = r.controlPlane as { configApi?: unknown; dashboard?: unknown } | undefined;
  if (!cp || typeof cp !== 'object') return raw;
  const { controlPlane: _c, ...rest } = r;
  const extra = Object.fromEntries(Object.entries(cp).filter(([k]) => k !== 'configApi' && k !== 'dashboard'));
  return {
    ...rest,
    ...(Object.keys(extra).length ? { controlPlane: extra } : {}),
    ...(cp.configApi !== undefined ? { admin: { ...((r.admin as object) ?? {}), configApi: cp.configApi } } : {}),
    ...(cp.dashboard !== undefined ? { dashboard: { ...((r.dashboard as object) ?? {}), enabled: cp.dashboard } } : {}),
  };
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
