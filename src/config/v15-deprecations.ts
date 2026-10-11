/**
 * 14.9.0: what 15.0.0 changes, announced one minor ahead (docs/versions.md "Deprecations"; docs/deprecations.md).
 *
 * - `v15.plugins.<i>.runtime` — a module plugin without `runtime` / `isolation` runs inline in 14.x; 15.0.0 runs module
 *   plugins in a `worker` by default. Set `runtime: worker` (recommended) or keep the 14.x behaviour with `runtime: inline`.
 * - `v15.config.unknown-key.<key>` — a top-level key that is not part of config schema v12 is ignored by 14.x (a typo,
 *   or a GitOps fragment's `include:` loaded as a plain file); 15.0.0 refuses the file.
 * - `schema.v11` — schema v11 files are migrated in memory by 14.x and refused by 15.0.0 (logged by the gateway at start;
 *   the v11 field list is in v12-deprecations.ts).
 *
 * @module config/v15-deprecations
 */
import type { Deprecation } from '../utils/deprecations.js';
import { buildV12ConfigSchema } from './v12.js';

/** Id prefixes of the 15.0.0 deprecations (docs/deprecations.md, docs/v15/freeze.md). */
export const V15_DEPRECATION_IDS = ['v15.plugins.<i>.runtime', 'v15.config.unknown-key.<key>', 'schema.v11'] as const;

let topLevel: Set<string> | undefined;
/** Top-level keys of config schema v12 (plus `$schema`, which editors add). */
export function v12TopLevelKeys(): Set<string> {
  topLevel ??= new Set(['$schema', ...Object.keys((buildV12ConfigSchema() as { properties?: object }).properties ?? {})]);
  return topLevel;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The 15.0.0 deprecations a raw config (file object, before normalisation) uses. */
export function v15DeprecationsIn(raw: unknown): Deprecation[] {
  if (!isObj(raw)) return [];
  const out: Deprecation[] = [];
  const plugins = Array.isArray(raw.plugins) ? raw.plugins : [];
  plugins.forEach((p, i) => {
    if (!isObj(p) || typeof p.module !== 'string' || p.component !== undefined) return;
    if (p.runtime !== undefined || p.isolation !== undefined) return;
    out.push({
      id: `v15.plugins.${i}.runtime`,
      message: `plugins[${i}] (${String(p.name ?? p.module)}) has no \`runtime\`: it runs inline in 14.x, and in a worker by default from 15.0.0`,
      removedIn: '15.0.0',
      replacement: 'set `runtime: worker` (isolation, limits, permissions; recommended) or `runtime: inline` to keep running in the gateway process',
    });
  });
  if (raw.version === 12) {
    const known = v12TopLevelKeys();
    for (const k of Object.keys(raw)) {
      if (known.has(k)) continue;
      out.push({ id: `v15.config.unknown-key.${k}`, message: `top-level key \`${k}\` is not part of config schema v12 and is ignored; 15.0.0 refuses unknown keys`, removedIn: '15.0.0', replacement: 'remove it (or fix the typo); GitOps fragments with `include:` are rendered with `mcp-gateway gitops render`, not loaded directly' });
    }
  }
  return out;
}
