/**
 * Config schema v12 — DRAFT (13.9.0, "v14 migration preparation"). Schema v11 stays the runtime schema in 13.x: a
 * `version: 12` file is refused. This module holds what 14.0 will build on:
 *
 *  - the v12 deprecation inventory ({@link V12_DEPRECATIONS}): every v11 field 14.0 removes or renames. 13.9 warns
 *    about each one at run time (once per field; `MCP_GATEWAY_SILENCE_DEPRECATIONS`), see docs/deprecations.md;
 *  - the migration preview ({@link migrateToV12}): v11 text → v12 text (comments and layout kept), a unified diff and a
 *    compatibility report (errors / warnings / manual steps) — `mcp-gateway config migrate --to v12 --dry-run` and
 *    `mcp-gateway config diff --to v12`;
 *  - {@link downgradeFromV12} (v12 → the v11 form 13.x runs), used to prove round trips and to validate v12 output
 *    with the v11 runtime schema;
 *  - the JSON Schemas under schema/v12-draft ({@link buildV12ConfigSchema}, {@link buildV12ModuleSchema}) and the v12
 *    module declaration derived from each manifest entry ({@link moduleDeclarationV12}).
 *
 * Design: docs/design/schema-v12.md.
 *
 * @module config/v12
 */

import { parseDocument, isMap, isScalar, type Document, type YAMLMap, type Pair, type Scalar } from 'yaml';
import { validateConfig, CONFIG_FILE_KEYS } from './loader.js';
import type { FeatureManifestEntry, FailurePolicy } from '../features/manifest.js';
import { FEATURE_MANIFEST, failurePolicyOf } from '../features/manifest.js';
import { FEATURE_CONFIG_KEYS, type FeatureModule } from '../gateway/features.js';

export { V12_SECTION_RENAMES, V12_DEPRECATIONS, v12DeprecationsIn, type V12Deprecation, MODULE_CAPABILITIES, type ModuleCapability, schemaNotice, normalizeSchemaVersion, RUNTIME_SCHEMA } from './v12-deprecations.js';
import { V12_SECTION_RENAMES, MODULE_CAPABILITIES as MODULE_CAPABILITIES_ } from './v12-deprecations.js';

// ─── migration preview ────────────────────────────────────────────────────────────────────────────────────────────

export interface CompatibilityReport {
  /** The file cannot be migrated as it is. */
  errors: string[];
  warnings: string[];
  /** What the tool cannot change for you. */
  manual: string[];
}

export interface V12Migration {
  text: string;
  /** The v12 config as an object (empty when it could not be produced). */
  config: Record<string, unknown>;
  changes: string[];
  report: CompatibilityReport;
  /** Unified diff input → output ('' when nothing changes). */
  diff: string;
  /** No errors. */
  ok: boolean;
}



const keyOf = (p: Pair): unknown => (isScalar(p.key) ? (p.key as Scalar).value : p.key);
function renameKey(map: YAMLMap, from: string, to: string): boolean {
  const pair = map.items.find((p) => keyOf(p as Pair) === from) as Pair | undefined;
  if (!pair) return false;
  if (isScalar(pair.key)) (pair.key as Scalar).value = to;
  else (pair as { key: unknown }).key = to;
  return true;
}

/** Migrate a v11 config file's text to the v12 draft. `format` is guessed from the content when omitted. */
export function migrateToV12(text: string, format?: 'yaml' | 'json', names: { from?: string; to?: string } = {}): V12Migration {
  const fmt = format ?? (/^\s*[{[]/.test(text) ? 'json' : 'yaml');
  const report: CompatibilityReport = { errors: [], warnings: [], manual: [] };
  const changes: string[] = [];
  const fail = (msg: string): V12Migration => {
    report.errors.push(msg);
    return { text, config: {}, changes, report, diff: '', ok: false };
  };
  let doc: Document;
  try {
    doc = parseDocument(text, { keepSourceTokens: true });
  } catch (e) {
    return fail(`cannot parse the config: ${(e as Error).message}`);
  }
  if (doc.errors.length) return fail(`cannot parse the config: ${doc.errors[0]!.message}`);
  const root = doc.contents;
  if (!isMap(root)) return fail('the config must be a mapping at the top level');
  const version = doc.get('version');
  if (version === 12) {
    // already v12 (14.0.0: the runtime schema): validate it as it is
    const obj = doc.toJS() as Record<string, unknown>;
    try {
      validateConfig(obj);
    } catch (e) {
      report.errors.push(`the v12 file is not valid: ${(e as Error).message}`);
    }
    return { text, config: obj, changes, report, diff: '', ok: report.errors.length === 0 };
  }
  if (typeof version === 'number' && version < 11) return fail(`the config is on schema v${version}: run \`mcp-gateway migrate --to 11\` first (docs/guides/migrating-to-v11.md), then migrate to v12`);
  if (version !== undefined && version !== 11) return fail(`unsupported config version ${JSON.stringify(version)} (expected 11)`);
  if (version === undefined) report.warnings.push('no `version:` in the file — read as schema v11 (it uses v11 fields) or v12; `version: 12` is added');
  try {
    validateConfig(doc.toJS());
  } catch (e) {
    report.errors.push(`the file is not a valid v11 config — fix it first:\n${(e as Error).message.replace(/^Invalid configuration:\n?/, '')}`);
  }

  // version
  if (version === undefined) (root as YAMLMap).items.unshift(doc.createPair('version', 12) as never);
  else doc.set('version', 12);
  changes.push(`version: ${version === undefined ? '(none)' : '11'} → 12`);

  // kernel → modules
  const kernel = doc.get('kernel');
  if (kernel !== undefined) {
    if (doc.has('modules')) report.errors.push('both `kernel` and `modules` are present: merge `kernel` into `modules` by hand');
    else if (!isMap(kernel)) report.errors.push('`kernel` is not a mapping: rewrite it as `modules: { activation, failurePolicy }` by hand');
    else {
      renameKey(root as YAMLMap, 'kernel', 'modules');
      if (renameKey(kernel as YAMLMap, 'modules', 'activation')) changes.push('kernel.modules → modules.activation');
      if ((kernel as YAMLMap).has('failurePolicy')) changes.push('kernel.failurePolicy → modules.failurePolicy');
      if ((kernel as YAMLMap).items.length === 0) (root as YAMLMap).delete('modules');
    }
  }

  // feature section renames
  const features = doc.get('features');
  if (isMap(features)) {
    for (const [from, to] of Object.entries(V12_SECTION_RENAMES)) {
      if (!features.has(from)) continue;
      if (features.has(to)) {
        report.errors.push(`both \`features.${from}\` and \`features.${to}\` are present: keep one (\`${to}\` is the v12 name)`);
        continue;
      }
      renameKey(features, from, to);
      changes.push(`features.${from} → features.${to}`);
      report.manual.push(`Update anything else that reads or writes \`features.${from}\` (Helm values, Terraform / CI scripts, clients of \`PUT /api/v1/admin/config\`) to \`features.${to}\`.`);
    }
  }
  if (changes.some((c) => c.startsWith('kernel.'))) report.manual.push('Update tooling that reads or writes `kernel.*` (Helm values, Terraform / CI scripts, clients of `PUT /api/v1/admin/config`) to `modules.*`.');
  if (report.errors.length) return { text, config: {}, changes, report, diff: '', ok: false };

  const out = fmt === 'json' ? JSON.stringify(doc.toJS(), null, 2) + '\n' : doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  const config = doc.toJS() as Record<string, unknown>;
  const input = fmt === 'json' ? JSON.stringify(JSON.parse(text), null, 2) + '\n' : text;
  return { text: out, config, changes, report, diff: unifiedDiff(input, out, names.from ?? 'v11', names.to ?? 'v12'), ok: true };
}

/** A v12 (draft) config object → the v11 form 13.x runs (drops v12-only keys: `modules.lifecycle`, `modules.capabilities`). */
export function downgradeFromV12(cfg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (k === 'version') out.version = v === 12 ? 11 : v;
    else if (k === 'modules' && v && typeof v === 'object' && !Array.isArray(v)) {
      const { activation, failurePolicy } = v as Record<string, unknown>;
      const kernel: Record<string, unknown> = {};
      if (activation !== undefined) kernel.modules = activation;
      if (failurePolicy !== undefined) kernel.failurePolicy = failurePolicy;
      if (Object.keys(kernel).length) out.kernel = kernel;
    } else if (k === 'features' && v && typeof v === 'object' && !Array.isArray(v)) {
      const back = Object.fromEntries(Object.entries(V12_SECTION_RENAMES).map(([a, b]) => [b, a]));
      out.features = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([fk, fv]) => [back[fk] ?? fk, fv]));
    } else out[k] = v;
  }
  return out;
}

/** Unified diff (`diff -u` format, `context` lines around each change) of two texts; '' when equal. */
export function unifiedDiff(a: string, b: string, fromName: string, toName: string, context = 3): string {
  if (a === b) return '';
  const x = a.replace(/\n$/, '').split('\n');
  const y = b.replace(/\n$/, '').split('\n');
  const n = x.length;
  const m = y.length;
  // LCS table (config files are small)
  const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = x[i] === y[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const ops: Array<{ t: ' ' | '-' | '+'; s: string; i: number; j: number }> = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) ops.push({ t: ' ', s: x[i]!, i: i++, j: j++ });
    else if (i < n && (j >= m || L[i + 1]![j]! >= L[i]![j + 1]!)) ops.push({ t: '-', s: x[i]!, i: i++, j });
    else ops.push({ t: '+', s: y[j]!, i, j: j++ });
  }
  const out = [`--- ${fromName}`, `+++ ${toName}`];
  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.t === ' ') {
      k++;
      continue;
    }
    let start = Math.max(0, k - context);
    let end = k;
    // extend while changes are within 2*context of each other
    for (let p = k; p < ops.length; p++) {
      if (ops[p]!.t !== ' ') end = p;
      else if (p - end > 2 * context) break;
    }
    const stop = Math.min(ops.length, end + context + 1);
    const hunk = ops.slice(start, stop);
    const aCount = hunk.filter((o) => o.t !== '+').length;
    const bCount = hunk.filter((o) => o.t !== '-').length;
    const aStart = aCount ? hunk.find((o) => o.t !== '+')!.i + 1 : hunk[0]!.i;
    const bStart = bCount ? hunk.find((o) => o.t !== '-')!.j + 1 : hunk[0]!.j;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const o of hunk) out.push(o.t + o.s);
    k = stop;
    start = stop;
  }
  return out.join('\n') + '\n';
}

// ─── JSON Schemas (schema/v12-draft) ──────────────────────────────────────────────────────────────────────────────

/** Capability vocabulary of the v12 module declaration. */
export const V12_CAPABILITIES = MODULE_CAPABILITIES_;
export type V12Capability = (typeof V12_CAPABILITIES)[number];

const SCHEMA_BASE = 'https://github.com/HarrisonCN/mcp-gateway/blob/main/schema/v12-draft/';
const POLICIES: FailurePolicy[] = ['open', 'closed', 'degrade'];

/** v12 name of a v11 feature section. */
export const v12Section = (k: string): string => V12_SECTION_RENAMES[k] ?? k;

/**
 * The v12 config JSON Schema (draft-07). Precise where v12 differs from v11 (`version`, `modules`, the set of feature
 * sections); section bodies are unchanged from v11 and are validated by the v11 runtime schema after
 * {@link downgradeFromV12}. `topLevelKeys` = the file-form top-level keys of schema v11 (`CONFIG_FILE_KEYS`).
 */
export function buildV12ConfigSchema(topLevelKeys: readonly string[] = CONFIG_FILE_KEYS): Record<string, unknown> {
  const unchanged = { $comment: 'unchanged from schema v11 (validated by the runtime schema)' };
  const featureKeys = (FEATURE_CONFIG_KEYS as readonly string[]).map(v12Section).sort();
  const skip = new Set(['version', 'features', 'kernel', 'state', 'configDir', 'deprecations', ...(FEATURE_CONFIG_KEYS as readonly string[])]);
  const others = [...new Set(topLevelKeys)].filter((k) => !skip.has(k)).sort();
  const configurable = FEATURE_MANIFEST.filter((e) => e.failurePolicyConfigurable).map((e) => e.id).sort();
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: SCHEMA_BASE + 'config.schema.json',
    title: 'MCP Gateway config schema v12 (DRAFT, 13.9.0)',
    description: 'Draft of the config schema 14.0 will run. 13.x runs schema v11 and refuses version 12. See docs/design/schema-v12.md.',
    type: 'object',
    required: ['version'],
    additionalProperties: false,
    properties: {
      version: { const: 12 },
      modules: {
        type: 'object',
        description: 'Unified module lifecycle settings (v11: kernel.*).',
        additionalProperties: false,
        properties: {
          activation: { enum: ['lazy', 'eager'], default: 'lazy', description: 'v11 kernel.modules' },
          failurePolicy: {
            type: 'object',
            description: 'v11 kernel.failurePolicy: per-module override, only for modules whose policy is configurable',
            propertyNames: { enum: configurable },
            additionalProperties: { enum: POLICIES },
          },
          lifecycle: {
            type: 'object',
            description: 'NEW in v12 (not read by 13.x): bounds for the lifecycle calls',
            additionalProperties: false,
            properties: {
              initTimeoutMs: { type: 'integer', minimum: 1, maximum: 600000 },
              unloadTimeoutMs: { type: 'integer', minimum: 1, maximum: 600000 },
              drainMs: { type: 'integer', minimum: 0, maximum: 600000 },
            },
          },
          capabilities: {
            type: 'object',
            description: 'NEW in v12 (not read by 13.x): per-module capability denials; a module that declares a denied capability fails to activate',
            propertyNames: { enum: FEATURE_MANIFEST.map((e) => e.id).sort() },
            additionalProperties: { type: 'object', additionalProperties: false, properties: { deny: { type: 'array', uniqueItems: true, items: { enum: [...V12_CAPABILITIES] } } } },
          },
        },
      },
      features: {
        type: 'object',
        description: 'Feature module sections, each named after its module id (camelCase).',
        additionalProperties: false,
        properties: Object.fromEntries(featureKeys.map((k) => [k, { ...unchanged, type: ['object', 'array'] }])),
      },
      ...Object.fromEntries(others.map((k) => [k, unchanged])),
    },
  };
}

/** The v12 module declaration JSON Schema (draft-07). */
export function buildV12ModuleSchema(): Record<string, unknown> {
  const flag = { type: 'boolean' };
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: SCHEMA_BASE + 'module.schema.json',
    title: 'MCP Gateway feature module declaration v12 (DRAFT, 13.9.0)',
    description: 'What a feature module declares to the 14.0 kernel: lifecycle methods, capabilities, config sections, dependencies, failure policy. 13.9 derives it from the manifest (moduleDeclarationV12).',
    type: 'object',
    required: ['id', 'since', 'summary', 'apiVersion', 'lifecycle', 'capabilities', 'configSections', 'dependsOn'],
    additionalProperties: false,
    properties: {
      id: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
      since: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
      summary: { type: 'string', minLength: 1 },
      apiVersion: { const: 'v12-draft' },
      configSections: { type: 'array', uniqueItems: true, items: { type: 'string', pattern: '^[a-z][A-Za-z0-9]*$' } },
      dependsOn: { type: 'array', uniqueItems: true, items: { type: 'string' } },
      hook: { type: 'string' },
      lifecycle: {
        type: 'object',
        required: ['mount', 'init', 'reconfigure', 'disable', 'dispose', 'health'],
        additionalProperties: false,
        properties: { mount: flag, init: flag, reconfigure: flag, disable: flag, dispose: flag, health: flag },
      },
      capabilities: { type: 'array', uniqueItems: true, items: { enum: [...V12_CAPABILITIES] } },
      failurePolicy: {
        type: 'object',
        required: ['default', 'configurable'],
        additionalProperties: false,
        properties: { default: { enum: POLICIES }, configurable: flag },
      },
    },
    allOf: [
      { if: { required: ['hook'] }, then: { required: ['failurePolicy'], properties: { capabilities: { contains: { const: 'call-hook' } } } } },
      {
        if: { properties: { capabilities: { contains: { const: 'security-guard' } } } },
        then: { required: ['failurePolicy'], properties: { failurePolicy: { properties: { default: { const: 'closed' }, configurable: { const: false } } } } },
      },
    ],
  };
}

/**
 * The v12 declaration of a 13.x manifest entry. Capabilities are only those the manifest and registration prove
 * (routes, call hook, security guard); runtime capabilities (timers, network, filesystem, …) are declared by the
 * modules themselves in 14.0.
 */
export function moduleDeclarationV12(e: FeatureManifestEntry, mod?: FeatureModule): Record<string, unknown> {
  const caps: V12Capability[] = ['admin-routes'];
  if (mod?.mountClient) caps.push('client-routes');
  if (e.hook) caps.push('call-hook');
  if (e.guard) caps.push('security-guard');
  const sections = [...(e.activation ?? []), ...(e.hookWhen ? [e.hookWhen] : [])].map((k) => v12Section(String(k)));
  return {
    id: e.id,
    since: e.since,
    summary: e.summary,
    apiVersion: 'v12-draft',
    configSections: [...new Set(sections)],
    dependsOn: [...(e.dependsOn ?? [])],
    ...(e.hook ? { hook: e.hook } : {}),
    lifecycle: { mount: typeof mod?.mount === 'function', init: !!mod?.init, reconfigure: !!mod?.reconfigure, disable: !!mod?.disable, dispose: !!mod?.dispose, health: !!mod?.health },
    capabilities: caps,
    ...(e.hook || e.guard ? { failurePolicy: { default: failurePolicyOf(e.id), configurable: !!e.failurePolicyConfigurable } } : {}),
  };
}

