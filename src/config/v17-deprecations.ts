/**
 * 16.9.0-canary.0: the removals planned for 17.0.0, announced one minor ahead (docs/migrating-to-v17.md — a proposal
 * until the 17.0 list is frozen in 17.0.0-rc.1). Nothing here changes behaviour; each use is a
 * `DEPRECATED (removed in 17.0.0)` warning, listed by `mcp-gateway validate` and `GET /api/v1/admin/deprecations`.
 *
 * - `v17.plugins.<i>.inline` — a config schema v13 file with an inline module plugin (`runtime: inline` +
 *   `allowInline: true`); 17.0 (plugin API v6) runs module plugins only in a worker or a child process. Schema v12
 *   files are covered by `v16.plugins.<i>.inline` (also removed in 17.0.0) and by `schema.v12`.
 * - `v17.plugins.<name>.api-v5` — a loaded module plugin declaring plugin API v5; 17.0 loads v6 only
 *   (`mcp-gateway plugin migrate --to v6`).
 * - `v17.plugins.<name>.legacy-outcome` — a v5 plugin hook returned a v4-era shape (`{ deny }`, `{ respond }`,
 *   `{ arguments }`, a full response from `onResponse`); v6 accepts only `{ action }` outcomes.
 * - `v17.plugins.<name>.http-hooks` — a plugin with `onRequest` / `routes` (possible inline only); v6 module plugins
 *   cannot have HTTP hooks.
 *
 * @module config/v17-deprecations
 */

import type { Deprecation } from '../utils/deprecations.js';

/** Id families of the 17.0.0 deprecations (docs/deprecations.md). */
export const V17_DEPRECATION_IDS = ['v17.plugins.<i>.inline', 'v17.plugins.<name>.api-v5', 'v17.plugins.<name>.legacy-outcome', 'v17.plugins.<name>.http-hooks'] as const;

const R = '17.0.0';
const GUIDE = 'docs/migrating-to-v17.md';
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The 17.0.0 deprecations a raw config file uses (schema v13 files; v12 files are covered by the v16.* entries). */
export function v17DeprecationsIn(raw: unknown): Deprecation[] {
  if (!isObj(raw) || raw.version !== 13) return [];
  const out: Deprecation[] = [];
  (Array.isArray(raw.plugins) ? raw.plugins : []).forEach((p, i) => {
    if (!isObj(p) || typeof p.module !== 'string' || p.component !== undefined) return;
    if (p.runtime === 'inline' || p.allowInline === true) {
      out.push({ id: `v17.plugins.${i}.inline`, message: `plugins[${i}] (${String(p.name ?? p.module)}) runs inline, in the gateway process; 17.0.0 (plugin API v6) runs module plugins only in a worker or a child process (${GUIDE})`, removedIn: R, replacement: 'runtime: worker (or process), and drop allowInline' });
    }
  });
  return out;
}

/** A loaded module plugin on plugin API v5. */
export const apiV5 = (name: string): Deprecation => ({
  id: `v17.plugins.${name}.api-v5`,
  message: `plugin "${name}" declares plugin API v5; 17.0.0 loads plugin API v6 only — run \`mcp-gateway plugin migrate --to v6 <file>\` (${GUIDE})`,
  removedIn: R,
  replacement: 'apiVersion: 6 ({ action } outcomes only, worker or process runtime)',
});

/** A v5 plugin hook returned a v4-era outcome. */
export const legacyOutcome = (name: string, hook: string): Deprecation => ({
  id: `v17.plugins.${name}.legacy-outcome`,
  message: `plugin "${name}" ${hook} returned a v4-era outcome; plugin API v6 (17.0.0) accepts only { action } outcomes (${GUIDE})`,
  removedIn: R,
  replacement: hook === 'onResponse' ? "return { action: 'replace', result } (or { action: 'continue' })" : "return { action: 'deny', reason } / { action: 'respond', result } / { action: 'rewrite', arguments } / { action: 'continue' }",
});

/** A plugin with HTTP hooks (`onRequest` / `routes`). */
export const httpHooks = (name: string): Deprecation => ({
  id: `v17.plugins.${name}.http-hooks`,
  message: `plugin "${name}" has onRequest / routes, which run only inline; plugin API v6 (17.0.0) module plugins run in a worker or a child process and cannot have HTTP hooks (${GUIDE})`,
  removedIn: R,
  replacement: 'move request handling into gateway config (auth, policy, routes of a feature module) or a separate service in front of the gateway',
});
