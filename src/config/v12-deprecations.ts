/**
 * Config schema v12 — the runtime schema since 14.0.0 — and the v11 inventory (13.9.0). Kept free of heavy imports
 * (no `yaml`): the loader runs it on every config load. The migration tool lives in {@link ./v12.ts}.
 *
 * 14.0.0: a v11 file (`version: 11`, or no `version` and a v11-only field) is migrated in memory
 * ({@link normalizeSchemaVersion}) with one deprecation warning per v11 field and a startup notice
 * ({@link schemaNotice}); v11 files are read until 15.0.0. A v12 file may not use the five v11 fields.
 *
 * Internally the gateway keeps the v11 names (`kernel.*`, `genaiTelemetry`, `policyShadow`, `postQuantumTls`): the
 * v12 file form is adapted to them here, so feature modules and embedders that build a {@link GatewayConfig} object
 * in code are unchanged (roadmap: adapters and incremental migration, no big-bang rewrite).
 *
 * @module config/v12-deprecations
 */

import type { Deprecation } from '../utils/deprecations.js';

export interface V12Deprecation extends Deprecation {
  /** Path in a v11 config file (dot separated). */
  path: string;
  /** Path in a v12 config file. */
  replacement: string;
  since: string;
}

/** Feature sections renamed in v12 so that every section is the camelCase of its module id. */
export const V12_SECTION_RENAMES: Readonly<Record<string, string>> = {
  genaiTelemetry: 'genaiOtel',
  policyShadow: 'policySim',
  postQuantumTls: 'pqTls',
};

const dep = (id: string, path: string, replacement: string, why: string): V12Deprecation => ({
  id: `v12.${id}`,
  path,
  replacement,
  since: '13.9.0',
  removedIn: '15.0.0',
  message: `\`${path}\` is a config schema v11 field, read through the in-memory migration to schema v12 \`${replacement}\` (${why}); v11 files are no longer read from 15.0.0 — run \`mcp-gateway config migrate --to v12 --in-place\` (docs/deprecations.md)`,
});

/** Every v11 field that schema v12 removes or renames (13.9.0 inventory). */
export const V12_DEPRECATIONS: readonly V12Deprecation[] = [
  dep('kernel.modules', 'kernel.modules', 'modules.activation', 'module lifecycle settings move to the `modules` block'),
  dep('kernel.failurePolicy', 'kernel.failurePolicy', 'modules.failurePolicy', 'module lifecycle settings move to the `modules` block'),
  ...Object.entries(V12_SECTION_RENAMES).map(([from, to]) => dep(`features.${from}`, `features.${from}`, `features.${to}`, 'feature sections are named after their module id')),
];

/** Deprecated v11 fields used in a raw (file-form) config. */
export function v12DeprecationsIn(raw: unknown): V12Deprecation[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const r = raw as Record<string, unknown>;
  const has = (path: string) => {
    let v: unknown = r;
    for (const k of path.split('.')) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
      v = (v as Record<string, unknown>)[k];
    }
    return v !== undefined;
  };
  return V12_DEPRECATIONS.filter((d) => has(d.path));
}


/** Runtime capabilities a module may declare (14.0.0, `modules.capabilities.<id>.deny`). */
export const MODULE_CAPABILITIES = ['admin-routes', 'client-routes', 'call-hook', 'security-guard', 'background-timers', 'state-store', 'outbound-network', 'filesystem', 'signing-keys', 'invoke-tools'] as const;
export type ModuleCapability = (typeof MODULE_CAPABILITIES)[number];

/** Config schema the gateway runs (14.0.0). */
export const RUNTIME_SCHEMA = 12;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const BACK: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(V12_SECTION_RENAMES).map(([a, b]) => [b, a]));

export interface SchemaVersionResult {
  /** The raw config in the internal form (v11 names; `version` kept as written). */
  raw: unknown;
  /** Schema the file was written in (undefined: not an object, left to the schema to report). */
  schemaVersion?: 11 | 12;
  errors: string[];
}

/**
 * 14.0.0: which schema a raw (file-form) config is written in, and its internal form.
 *
 * - `version: 12` → schema v12: `modules: { activation, failurePolicy, lifecycle, capabilities }`, feature sections
 *   named after their module id; the five v11 fields are errors.
 * - `version: 11` → schema v11, migrated in memory (identical internal form; deprecations reported by the caller).
 * - no `version` → v11 when a v11-only field is used, else v12 (both read the same).
 * Other versions are reported by `removedConfigKeys`.
 */
export function normalizeSchemaVersion(raw: unknown): SchemaVersionResult {
  if (!isObj(raw)) return { raw, errors: [] };
  const { version, ...r } = raw;
  const errors: string[] = [];
  const v11Fields = v12DeprecationsIn(raw).map((d) => d.path);
  const usesV11 = v11Fields.length > 0 || r.kernel !== undefined;
  const schemaVersion: 11 | 12 | undefined = version === 12 ? 12 : version === 11 ? 11 : version === undefined ? (usesV11 ? 11 : 12) : undefined;
  if (schemaVersion === undefined) return { raw: r, errors }; // reported by removedConfigKeys
  const features = isObj(r.features) ? r.features : undefined;
  if (schemaVersion === 12) {
    if (r.kernel !== undefined) errors.push('kernel: `kernel` is not part of config schema v12 — use `modules.activation` (was `kernel.modules`) and `modules.failurePolicy` (was `kernel.failurePolicy`); a `version: 11` file is still read (migrated in memory) until 15.0.0, `mcp-gateway config migrate --to v12` rewrites it');
    for (const [from, to] of Object.entries(V12_SECTION_RENAMES)) {
      if (features?.[from] !== undefined) errors.push(`features.${from}: \`features.${from}\` is not part of config schema v12 — use \`features.${to}\``);
    }
    if (errors.length) return { raw: r, schemaVersion, errors };
    const out: Record<string, unknown> = { ...r, ...(version !== undefined ? { version } : {}) };
    if (features) out.features = Object.fromEntries(Object.entries(features).map(([k, v]) => [BACK[k] ?? k, v]));
    if (r.modules !== undefined) {
      if (!isObj(r.modules)) return { raw: out, schemaVersion, errors: ['modules: must be an object'] };
      const { activation, failurePolicy, ...mods } = r.modules;
      const kernel: Record<string, unknown> = {};
      if (activation !== undefined) kernel.modules = activation;
      if (failurePolicy !== undefined) kernel.failurePolicy = failurePolicy;
      if (Object.keys(kernel).length) out.kernel = kernel;
      if (Object.keys(mods).length) out.modules = mods;
      else delete out.modules;
    }
    return { raw: out, schemaVersion, errors };
  }
  // schema v11
  if (r.modules !== undefined) {
    errors.push(version === undefined
      ? 'modules: both v11 fields (`kernel` / ' + (v11Fields.filter((f) => !f.startsWith('kernel')).join(', ') || 'none') + ') and the v12 `modules` block are used — write the file in one schema (`mcp-gateway config migrate --to v12`)'
      : 'modules: the `modules` block is config schema v12 — set `version: 12` (and migrate the file with `mcp-gateway config migrate --to v12`)');
  }
  for (const to of Object.values(V12_SECTION_RENAMES)) {
    if (features?.[to] !== undefined) errors.push(`features.${to}: \`features.${to}\` is the config schema v12 name — set \`version: 12\` (migrate with \`mcp-gateway config migrate --to v12\`) or use \`features.${BACK[to]}\` in a v11 file`);
  }
  return { raw: version !== undefined ? { ...r, version } : r, schemaVersion, errors };
}

/**
 * The one startup notice for a config file written in schema v11 (14.0.0); undefined for a v12 config. Logged once
 * at start (the per-field deprecation warnings come with it).
 */
export function schemaNotice(cfg: { schemaVersion?: number; deprecations?: unknown[] } | undefined): string | undefined {
  if (cfg?.schemaVersion !== 11) return undefined;
  const n = cfg.deprecations?.length ?? 0;
  return `Config file uses schema v11: it was migrated in memory to schema v12 by 14.x${n ? ` (${n} v11 field${n === 1 ? '' : 's'}, see the deprecation warnings)` : ''}. Schema v11 files are read until 15.0.0 — rewrite it with \`mcp-gateway config migrate --to v12 --in-place -c <file>\` (docs/migration/v13-to-v14.md)`;
}
