/**
 * Config schema v12 deprecation inventory (13.9.0) — kept free of heavy imports (no `yaml`): the loader reads it on
 * every config load. The migration preview lives in {@link ./v12.ts}.
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
  removedIn: '14.0.0',
  message: `\`${path}\` is renamed to \`${replacement}\` in config schema v12 (${why}); run \`mcp-gateway config migrate --to v12 --dry-run\` to preview (docs/deprecations.md)`,
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

