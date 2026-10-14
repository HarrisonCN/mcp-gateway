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
 *  - the JSON Schemas under schema/v12 (14.0.0; `schema/v12-draft` is a deprecated alias copy until 15.0.0) ({@link buildV12ConfigSchema}, {@link buildV12ModuleSchema}) and the v12
 *    module declaration derived from each manifest entry ({@link moduleDeclarationV12}).
 *
 * Design: docs/design/schema-v12.md.
 *
 * @module config/v12
 */

import { parseDocument, isMap, isScalar, type Document, type YAMLMap, type Pair, type Scalar } from 'yaml';
import { validateConfig, validateV11ForMigration, CONFIG_FILE_KEYS } from './loader.js';
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
    validateV11ForMigration(doc.toJS()); // 15.0.0: the loader refuses v11; migration still reads it
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
/**
 * 14.9.0: the v12 settings {@link downgradeFromV12} cannot express in schema v11 (and therefore leaves out), as
 * `modules.<key>` paths — everything under `modules` except `activation` / `failurePolicy`. Empty: the downgrade is
 * lossless. `config rollback` restores the saved v11 file instead, so this matters for hand-written v12 files.
 */
export function downgradeLoss(cfg: Record<string, unknown>): string[] {
  const m = cfg.modules;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return [];
  return Object.keys(m).filter((k) => k !== 'activation' && k !== 'failurePolicy').map((k) => `modules.${k}`);
}

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

// ─── JSON Schemas (schema/v12) ────────────────────────────────────────────────────────────────────────────────────

/** Capability vocabulary of the v12 module declaration. */
export const V12_CAPABILITIES = MODULE_CAPABILITIES_;
export type V12Capability = (typeof V12_CAPABILITIES)[number];

const SCHEMA_BASE = 'https://github.com/HarrisonCN/mcp-gateway/blob/main/schema/v12/';
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
    title: 'MCP Gateway config schema v12 (14.0)',
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
        properties: {
          ...Object.fromEntries(featureKeys.map((k) => [k, { ...unchanged, type: ['object', 'array'] }])),
          // 14.4.0: durable task execution keys described
          ...(featureKeys.includes('taskGraphs') ? { taskGraphs: TASK_GRAPHS_V12 } : {}),
          // 14.5.0: multi-region consistency keys described
          ...(featureKeys.includes('regions') ? { regions: REGIONS_V12 } : {}),
          // 14.6.0: edge autonomy keys described (offline policy, queue expiry, reconcile, seal)
          ...(featureKeys.includes('edgeAutonomy') ? { edgeAutonomy: EDGE_AUTONOMY_V12 } : {}),
        },
      },
      ...Object.fromEntries(others.map((k) => [k, unchanged])),
      // 14.1.0: optional `controlPlane.rollout` (control role only); the rest of the section is unchanged
      ...(others.includes('controlPlane') ? { controlPlane: CONTROL_PLANE_V12 } : {}),
      // 14.2.0: optional centralized tenant isolation rules
      ...(others.includes('tenancy') ? { tenancy: TENANCY_V12 } : {}),
      // 14.3.0: plugin security runtime (runtime / failure / limits / permissions)
      ...(others.includes('plugins') ? { plugins: PLUGINS_V12 } : {}),
    },
  };
}

const ONOFF = { enum: ['open', 'closed'] };

const RISK_V12 = { enum: ['low', 'medium', 'high', 'critical'] };
/** `features.edgeAutonomy` in the v12 JSON Schema (14.6.0; validated at run time too). */
const EDGE_AUTONOMY_V12 = {
  type: 'object',
  description: 'Edge autonomy (10.7; GA in 14.6): local decisions while an upstream is unreachable, offline permission boundaries (high-risk calls denied offline by default), sealed queue with expiry, fenced reconcile honouring revocations. See docs/guides/edge-autonomy.md.',
  additionalProperties: false,
  required: ['rules'],
  properties: {
    enabled: { type: 'boolean', default: true },
    dir: { type: 'string', minLength: 1, description: 'Persist the sealed queue, last-good cache and intent log here (0700; files 0600). Relative to the config file.' },
    rules: {
      type: 'array',
      minItems: 1,
      description: 'First match on "server/tool" decides what a call does while its server is disconnected.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['match', 'action'],
        properties: {
          match: { type: 'string', minLength: 1 },
          action: { enum: ['cache', 'wasm', 'queue', 'deny'] },
          maxAgeSeconds: { type: 'integer', minimum: 1, maximum: 31536000, default: 86400 },
          wasmTool: { type: 'string', minLength: 1 },
          message: { type: 'string' },
        },
      },
    },
    policies: {
      type: 'array',
      default: [],
      description: 'NEW in 14.6: declared offline policy per server / tool (first match on "server/tool").',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['match'],
        properties: {
          match: { type: 'string', minLength: 1 },
          offline: { enum: ['allow', 'deny'], description: 'allow: may be answered / queued offline whatever its risk; deny: never; unset: by risk (highRisk).' },
          risk: { ...RISK_V12, description: 'Declared risk; replaces the classifier (annotations, tool-name heuristics).' },
          idempotent: { type: 'boolean', description: 'Safe to repeat: an in-doubt replay is resent with the same idempotency key.' },
          conflictKey: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: 'Argument names identifying the record written; concurrent offline writes by different clients go to review.' },
          ttlSeconds: { type: 'integer', minimum: 1, maximum: 31536000, description: 'Queue TTL for matching calls.' },
        },
      },
    },
    highRisk: { enum: ['deny', 'allow'], default: 'deny', description: 'NEW in 14.6 (behaviour change): offline handling of high / critical risk calls (writes, deletes, payments, non-idempotent) that no policy allows.' },
    cacheEntries: { type: 'integer', minimum: 1, maximum: 100000, default: 1000 },
    outboxLimit: { type: 'integer', minimum: 1, maximum: 100000, default: 10000, description: 'Maximum queued calls (queue.maxItems wins).' },
    queue: {
      type: 'object',
      additionalProperties: false,
      default: {},
      description: 'NEW in 14.6: queue expiry.',
      properties: {
        ttlSeconds: { type: 'integer', minimum: 1, maximum: 31536000, default: 86400 },
        maxItems: { type: 'integer', minimum: 1, maximum: 100000 },
        onExpiry: { enum: ['review', 'drop'], default: 'review', description: 'An expired call is never replayed: parked for review, or dropped.' },
      },
    },
    reconcile: {
      type: 'object',
      additionalProperties: false,
      default: {},
      properties: {
        intervalMs: { type: 'integer', minimum: 100, maximum: 3600000, default: 5000 },
        maxAttempts: { type: 'integer', minimum: 1, maximum: 100, default: 5 },
        idempotencyArg: { type: 'string', minLength: 1, description: 'Argument carrying the idempotency key (the client\'s own, else the outbox id).' },
        leaseMs: { type: 'integer', minimum: 500, maximum: 3600000, default: 30000, description: 'NEW in 14.6: reconcile lease; a crashed reconciler is taken over after this (fencing epoch).' },
        requireFreshRevocations: { type: 'boolean', default: true, description: 'NEW in 14.6: replay only after revocation authorities (multi-region) are confirmed fresh since reconnect.' },
      },
    },
    seal: {
      type: 'object',
      additionalProperties: false,
      default: {},
      description: 'NEW in 14.6: AES-256-GCM sealing of the persisted queue / cache.',
      properties: { keyEnv: { type: 'string', minLength: 1, description: 'Environment variable holding a 32-byte key (base64 or hex); default: a generated <dir>/.seal.key (0600).' } },
    },
  },
};

/** `features.regions` in the v12 JSON Schema (14.5.0: consistency boundaries described; validated at run time too). */
const REGIONS_V12 = {
  type: 'object',
  description: 'Multi-region active-active (5.2). 14.5 adds explicit consistency boundaries: replicated revocations, bounded staleness (fail closed), version vectors, clock-skew bounds. See docs/guides/multi-region.md.',
  additionalProperties: false,
  required: ['self'],
  properties: {
    self: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$', description: 'this region id' },
    syncIntervalMs: { type: 'integer', minimum: 250, default: 5000 },
    downAfter: { type: 'integer', minimum: 1, default: 3, description: 'consecutive failed syncs before a peer is down' },
    peers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'url'],
        properties: { id: { type: 'string', minLength: 1 }, url: { type: 'string', format: 'uri' }, apiKey: { type: 'string', description: 'operator (unscoped) key on the peer' }, priority: { type: 'integer', minimum: 0, default: 100 } },
      },
    },
    consistency: {
      type: 'object',
      description: 'NEW in 14.5: bounded staleness and clock-skew bounds',
      additionalProperties: false,
      properties: {
        maxStalenessMs: { type: 'integer', minimum: 500, description: 'a region is fresh while every peer synced within this window (default max(30000, 3 × syncIntervalMs); at least 2 × syncIntervalMs)' },
        maxClockSkewMs: { type: 'integer', minimum: 0, default: 30000, description: 'replicated writes stamped further ahead are rejected' },
        onStale: { enum: ['deny', 'allow'], default: 'deny', description: 'deny = refuse tool calls while not fresh (fail closed, -32027)' },
      },
    },
  },
};

/** `features.taskGraphs` in the v12 JSON Schema (14.4.0: durable execution keys described; the rest validated at run time). */
const TASK_GRAPHS_V12 = {
  type: 'object',
  description: 'Task graphs (10.7). 14.4 adds durable execution: resume after restart, idempotency keys, DLQ, approval resume. See docs/guides/durable-tasks.md.',
  properties: {
    enabled: { type: 'boolean', default: true },
    dir: { type: 'string', minLength: 1, description: 'checkpoint directory (relative to the config file)' },
    maxRuns: { type: 'integer', minimum: 1, maximum: 100000, default: 500 },
    durable: {
      type: 'object',
      description: 'NEW in 14.4: durable execution (absent = 10.7 checkpoints)',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', default: true },
        backend: { enum: ['auto', 'store', 'dir', 'memory'], default: 'auto', description: 'auto: the gateway store when it is not memory, else dir, else memory' },
        resumeOnStart: { type: 'boolean', default: true, description: 'continue runs left in flight (lease lapsed) from their last committed step' },
        leaseMs: { type: 'integer', minimum: 1000, maximum: 600000, default: 15000, description: 'heartbeat lease of an executing gateway' },
        sweepIntervalMs: { type: 'integer', minimum: 50, maximum: 600000, default: 2000 },
        idempotencyTtlSeconds: { type: 'integer', minimum: 60, maximum: 7776000, default: 86400, description: 'how long a submission idempotency key is remembered' },
        retentionHours: { type: 'integer', minimum: 0, maximum: 876000, default: 168, description: 'NEW in 14.9: delete finished runs (succeeded, failed, cancelled, compensated) this long after they ended; 0 = keep forever' },
        dlq: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean', default: true },
            retry: {
              type: 'object',
              additionalProperties: false,
              properties: {
                attempts: { type: 'integer', minimum: 0, maximum: 100, default: 3 },
                backoffMs: { type: 'integer', minimum: 0, maximum: 86400000, default: 30000 },
                factor: { type: 'number', minimum: 1, maximum: 10, default: 2 },
                maxBackoffMs: { type: 'integer', minimum: 0, maximum: 604800000, default: 3600000 },
                jitter: { type: 'boolean', default: false },
              },
            },
          },
        },
      },
    },
    graphs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          clients: { type: 'boolean', default: false, description: 'NEW in 14.4 (durable): any authenticated client may start it under /api/v1/features/task-graphs' },
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                idempotent: { type: 'boolean', default: false, description: 'NEW in 14.4: safe to execute again after a crash between call and commit' },
                idempotencyArg: { type: 'string', description: 'NEW in 14.4: argument that receives the stable per-call key <runId>:<node> (implies repeat-safe)' },
                approval: {
                  type: 'object',
                  description: 'NEW in 14.4 (durable): wait for human approval before the node runs',
                  additionalProperties: false,
                  required: ['approvers'],
                  properties: {
                    approvers: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: 'client id globs' },
                    required: { type: 'integer', minimum: 1, maximum: 20, default: 1 },
                    timeoutSeconds: { type: 'integer', minimum: 1, maximum: 2592000, default: 86400 },
                    reason: { type: 'string', maxLength: 500 },
                  },
                },
                compensate: { type: 'object', properties: { tool: { type: 'string' }, args: { type: 'object' }, idempotencyArg: { type: 'string', description: 'NEW in 14.4' } } },
              },
            },
          },
        },
      },
    },
  },
};
const GLOBS = { type: 'array', items: { type: 'string', minLength: 1 } };

/** `plugins` in the v12 JSON Schema (14.3.0: plugin security runtime keys described). */
const PLUGINS_V12 = {
  type: 'array',
  description: 'Plugins in configuration order. 14.3 adds runtime / failure / permissions and module-plugin limits. See docs/guides/plugin-security.md.',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      module: { type: 'string', minLength: 1, description: 'ES module path (relative to the config file) or package name' },
      component: { type: 'string', minLength: 1, description: 'plugin API v5 WASM component' },
      signature: { type: 'string', minLength: 1 },
      name: { type: 'string', minLength: 1 },
      enabled: { type: 'boolean' },
      options: { type: 'object' },
      secrets: { type: 'object', additionalProperties: { type: 'string', pattern: '^secret://[A-Za-z0-9_-]+/\\S+$' } },
      isolation: { enum: ['tenant', 'client', 'shared', 'inline', 'worker', 'process'], description: 'components: sandbox per tenant | client | shared; module plugins (14.3): alias of runtime' },
      runtime: { enum: ['inline', 'worker', 'process'], default: 'inline', description: 'NEW in 14.3 (module plugins): where the plugin runs; worker becomes the default in 15.0' },
      failure: {
        description: 'NEW in 14.3 (module plugins): what a failed hook does',
        oneOf: [ONOFF, { type: 'object', additionalProperties: false, properties: { default: ONOFF, onToolCall: ONOFF, onResponse: ONOFF } }],
      },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 60000, description: 'inline module plugins: per hook call' },
      limits: {
        type: 'object',
        additionalProperties: false,
        properties: {
          timeoutMs: { type: 'integer', minimum: 1, maximum: 60000 },
          memoryMb: { type: 'integer', minimum: 1, maximum: 4096 },
          maxInstances: { type: 'integer', minimum: 1, maximum: 10000, description: 'components only' },
          maxFailures: { type: 'integer', minimum: 1, maximum: 10000, description: 'NEW in 14.3 (module plugins): circuit breaker threshold' },
          cooldownMs: { type: 'integer', minimum: 1, maximum: 3600000, description: 'NEW in 14.3 (module plugins)' },
          maxConcurrent: { type: 'integer', minimum: 1, maximum: 10000, description: 'NEW in 14.3 (isolated module plugins)' },
        },
      },
      permissions: {
        type: 'object',
        description: 'NEW in 14.3 (module plugins): declared capabilities; network / env / fs need runtime worker or process',
        additionalProperties: false,
        properties: {
          args: { enum: ['read', 'write'], default: 'write' },
          response: { enum: ['read', 'write'], default: 'write' },
          secrets: GLOBS,
          servers: GLOBS,
          tools: GLOBS,
          hooks: { type: 'array', items: { enum: ['onToolCall', 'onResponse', 'onError', 'onConfigChange'] } },
          network: { oneOf: [{ const: false }, { type: 'array', items: { type: 'string', minLength: 1, maxLength: 255 } }] },
          env: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' } },
          fs: { type: 'object', additionalProperties: false, properties: { read: GLOBS, write: GLOBS } },
        },
      },
    },
    oneOf: [{ required: ['module'] }, { required: ['component'] }],
  },
};

/** `tenancy` in the v12 JSON Schema (14.2.0, optional). */
const TENANCY_V12 = {
  type: 'object',
  description: 'NEW in 14.2 (optional): centralized tenant isolation. Absent = pre-14.2 behaviour. See docs/guides/tenant-isolation.md.',
  additionalProperties: false,
  properties: {
    isolation: {
      type: 'object',
      additionalProperties: false,
      description: 'With isolation on, each server belongs to the first tenant (config order) whose `servers` globs match it; other tenants reach it only through a grant.',
      properties: {
        enabled: { type: 'boolean', default: true },
        crossTenant: { enum: ['deny', 'audit'], default: 'deny', description: 'deny: cross-tenant access only through grants; audit: allowed as before, every crossing recorded' },
        grants: {
          type: 'array',
          items: {
            type: 'object',
            required: ['owner', 'tenants', 'servers'],
            additionalProperties: false,
            properties: {
              owner: { type: 'string', minLength: 1, description: 'tenant owning the servers' },
              tenants: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: 'tenants whose members may use them (their own role applies)' },
              servers: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: 'server id globs owned by `owner`' },
              access: { enum: ['call', 'read'], default: 'call' },
              reason: { type: 'string', maxLength: 500 },
            },
          },
        },
      },
    },
  },
};

/** `controlPlane` in the v12 JSON Schema: other keys as in v11; `rollout` (14.1.0), `gitops` (14.7.0) and `console` (14.8.0) described precisely. */
const CONTROL_PLANE_V12 = {
  $comment: 'unchanged from schema v11 (validated by the runtime schema) except the optional `rollout` (14.1), `gitops` (14.7) and `console` (14.8)',
  type: 'object',
  properties: {
    console: {
      type: 'object',
      description: 'NEW in 14.8 (optional): operations console — /api/v1/admin/ops/* and the dashboard Operations page. See docs/guides/operations-console.md.',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', default: true, description: 'Serve /api/v1/admin/ops/* and record call traces.' },
        viewers: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 200 }, description: 'Client id globs (key:oncall) with read-only console access.' },
        traceBuffer: { type: 'integer', minimum: 10, maximum: 100000, default: 500, description: 'Call traces kept in memory.' },
        timelineBuffer: { type: 'integer', minimum: 10, maximum: 100000, default: 1000, description: 'Incidents kept in memory.' },
        explainDenials: { type: 'boolean', default: false, description: 'Add the denial explanation (with the config path) to refused REST tool calls made by operators; other clients never get it.' },
        tenantViewers: { type: 'boolean', default: false, description: 'NEW in 15.1 (optional): tenant members (role owner / admin / viewer) read the call traces, lineage and cost rollup (GET /admin/ops/costs) of their own tenants, and nothing else on the console.' },
      },
    },
    token: { type: 'string', minLength: 1, description: 'Data plane: an operator API key of the control plane. ${VAR} references are expanded; an unset variable is a config error (14.7, MGW-2026-019).' },
    gitops: {
      type: 'object',
      description: 'NEW in 14.7 (optional; control plane or role all): GitOps — signed release manifests (ed25519), required approvals per environment, enforcement, drift detection. See docs/guides/gitops.md.',
      additionalProperties: false,
      required: ['environment'],
      properties: {
        environment: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$', description: 'the environment this gateway runs (bundles and manifests for another environment are refused)' },
        enforce: { type: 'boolean', default: false, description: 'only signed, sufficiently approved releases may change the config; PUT /admin/config and /admin/reload answer 409' },
        trustedKeys: {
          type: 'array',
          maxItems: 100,
          default: [],
          description: 'release signing keys (enforce: true needs at least one)',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'name', 'publicKey'],
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 128, description: 'key id named in manifests (--key-id)' },
              name: { type: 'string', minLength: 1, maxLength: 200, description: 'the person or bot holding the key; approvals count once per name and never for the author' },
              publicKey: { type: 'string', minLength: 1, description: 'ed25519:<base64 raw key> (mcp-gateway gitops keygen) or an SPKI PEM' },
              roles: { type: 'array', minItems: 1, items: { enum: ['author', 'approver'] }, default: ['author', 'approver'] },
            },
          },
        },
        requiredApprovals: {
          description: 'approvals a release needs: a number, or per environment with "*" as fallback (default: 2 for prod / production, else 0)',
          oneOf: [
            { type: 'integer', minimum: 0, maximum: 20 },
            { type: 'object', additionalProperties: { type: 'integer', minimum: 0, maximum: 20 } },
          ],
        },
        maxManifestAgeSeconds: { type: 'integer', minimum: 60, maximum: 31536000, default: 2592000, description: 'manifests older than this are refused' },
        driftCheckIntervalMs: { type: 'integer', minimum: 1000, maximum: 86400000, default: 60000 },
        recordFile: { type: 'string', minLength: 1, description: 'persist the applied release (replay protection and drift baseline across restarts); relative to the config file' },
      },
    },
    rollout: {
      type: 'object',
      description: 'NEW in 14.1 (optional; control plane only): how config generations roll out to data planes. See docs/guides/cluster-rollout.md.',
      additionalProperties: false,
      properties: {
        strategy: { enum: ['all-at-once', 'canary'], default: 'all-at-once' },
        canary: {
          type: 'object',
          description: 'canary size: a data-plane count or a percentage of the known data planes (strategy canary needs one)',
          additionalProperties: false,
          properties: { nodes: { type: 'integer', minimum: 1, maximum: 1000 }, percent: { type: 'number', minimum: 1, maximum: 100 } },
        },
        bakeMs: { type: 'integer', minimum: 0, maximum: 86400000, default: 30000 },
        failureThreshold: { type: 'integer', minimum: 1, maximum: 1000, default: 1 },
        autoRollback: { type: 'boolean', default: true },
        maxDivergenceMs: { type: 'integer', minimum: 1000, maximum: 86400000, default: 60000 },
        history: { type: 'integer', minimum: 2, maximum: 100, default: 10 },
      },
    },
  },
};

/** The v12 module declaration JSON Schema (draft-07). */
export function buildV12ModuleSchema(): Record<string, unknown> {
  const flag = { type: 'boolean' };
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: SCHEMA_BASE + 'module.schema.json',
    title: 'MCP Gateway feature module declaration v12 (14.0)',
    description: 'What a feature module declares to the 14.0 kernel: lifecycle methods, capabilities, config sections, dependencies, failure policy. 13.9 derives it from the manifest (moduleDeclarationV12).',
    type: 'object',
    required: ['id', 'since', 'summary', 'apiVersion', 'lifecycle', 'capabilities', 'configSections', 'dependsOn'],
    additionalProperties: false,
    properties: {
      id: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
      since: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
      summary: { type: 'string', minLength: 1 },
      apiVersion: { enum: ['v12', 'v12-draft'], description: "'v12' (14.0). 'v12-draft' (13.9) is accepted as a deprecated alias until 15.0.0." },
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
  // 14.0.0: runtime capabilities declared in the manifest (and by the module)
  for (const c of [...(e.capabilities ?? []), ...(mod?.capabilities ?? [])]) if (!caps.includes(c)) caps.push(c);
  const sections = [...(e.activation ?? []), ...(e.hookWhen ? [e.hookWhen] : [])].map((k) => v12Section(String(k)));
  return {
    id: e.id,
    since: e.since,
    summary: e.summary,
    apiVersion: 'v12',
    configSections: [...new Set(sections)],
    dependsOn: [...(e.dependsOn ?? [])],
    ...(e.hook ? { hook: e.hook } : {}),
    lifecycle: { mount: typeof mod?.mount === 'function', init: !!mod?.init, reconfigure: !!mod?.reconfigure, disable: !!mod?.disable, dispose: !!mod?.dispose, health: !!mod?.health },
    capabilities: caps,
    ...(e.hook || e.guard ? { failurePolicy: { default: failurePolicyOf(e.id), configurable: !!e.failurePolicyConfigurable } } : {}),
  };
}

