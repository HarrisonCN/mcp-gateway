/**
 * 15.0.0 enforces what 14.9.0 announced one minor ahead (docs/versions.md "Deprecations"; docs/deprecations.md).
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

/** Id prefixes of the 15.0.0 deprecations (docs/deprecations.md, docs/v15/freeze.md). */
export const V15_DEPRECATION_IDS = ['v15.plugins.<i>.runtime', 'v15.config.unknown-key.<key>', 'schema.v11'] as const;

/**
 * Top-level keys of config schema v12 (frozen for 15.0, docs/v15/freeze.md) plus `$schema`, which editors add.
 * Listed here rather than derived from `buildV12ConfigSchema()` so the loader does not import the schema builder
 * (and every feature schema) at start; test/v15-deprecations-14-9-0.test.ts keeps the two in sync.
 */
export const V12_TOP_LEVEL_KEYS: readonly string[] = [
  '$schema', 'version', 'modules', 'features', 'a2a', 'audit', 'auth', 'cache', 'catalog', 'chains', 'compliance',
  'controlPlane', 'cors', 'costs', 'federation', 'health', 'host', 'logLevel', 'mcp', 'monitor', 'mtls', 'observability',
  'openai', 'overload', 'plugins', 'policy', 'port', 'portal', 'quotas', 'rateLimit', 'reconnect', 'replay', 'routing',
  'secrets', 'security', 'servers', 'store', 'streaming', 'tenancy', 'tenants',
];
let topLevel: Set<string> | undefined;
/** Top-level keys of config schema v12 (plus `$schema`). */
export function v12TopLevelKeys(): Set<string> {
  topLevel ??= new Set(V12_TOP_LEVEL_KEYS);
  return topLevel;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * 15.0.0: the errors for what 14.9.0 announced as `v15.config.unknown-key.<key>` — a top-level key of a `version: 12`
 * file that is not part of config schema v12 refuses the file. (Module plugins without `runtime` now run in a worker
 * — `v15.plugins.<i>.runtime` needs no error; schema v11 files are refused by the loader.)
 */
export function v15ConfigErrors(raw: unknown): string[] {
  if (!isObj(raw) || raw.version !== 12) return [];
  const known = v12TopLevelKeys();
  return Object.keys(raw)
    .filter((k) => !known.has(k))
    .map((k) => `${k}: \`${k}\` is not a top-level key of config schema v12 (15.0.0 refuses unknown keys; 14.x ignored them and 14.9 reported \`v15.config.unknown-key.${k}\`) — remove it or fix the typo; GitOps fragments with \`include:\` are rendered with \`mcp-gateway gitops render\`, not loaded directly`);
}
