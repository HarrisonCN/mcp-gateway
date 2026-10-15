/**
 * `mcp-gateway config migrate --to v13` — the codemod for the 16.0 config changes (docs/migrating-to-v16.md; the 16.0
 * list is frozen from 16.0.0-rc.1).
 *
 * 15.9.0-canary.1 applied only the schema-v12-compatible part. 16.0.0-alpha.1 reads schema v13 (config/v13.ts), so the
 * codemod now writes `version: 13`: `isolation: worker|process|inline` on a module plugin becomes `runtime:`, inline
 * module plugins get `allowInline: true` (keeping today's behaviour explicitly), and `2024-11-05` is dropped from
 * `mcp.protocolVersions` (16.0's `/mcp` ignores it already; a list that named only it is removed). `pending` keeps what
 * a file cannot say (Node.js 24). Idempotent: a v13 file is checked and left as it is. Loaded on demand by the CLI only.
 *
 * 17.0.0-alpha.1: the codemod targets 17.0 — inline module plugins move to `runtime: worker` (and `allowInline` goes,
 * also from a 16.x v13 file), reported in `pending` because a plugin with HTTP hooks needs a person; a file without
 * `version:` that already is valid v13 only gets `version: 13`, one that is not is read as 16.x did (v12) and migrated.
 *
 * @module config/v13-prep
 */

import { parseDocument, isMap, isSeq, isScalar, type Document, type YAMLMap, type Pair, type Scalar } from 'yaml';
import { validateConfig, validateV12ForMigration } from './loader.js';
import { unifiedDiff, type CompatibilityReport } from './v12.js';

/** A 16.0 (schema v13) change the codemod cannot apply on 15.x. */
export interface V13Pending {
  /** Deprecation id family (docs/deprecations.md), e.g. `v16.plugins.1.inline`; `v16.node` for the runtime. */
  id: string;
  /** Where in the file (`plugins[1]`, `mcp.protocolVersions`, or `(runtime)`). */
  path: string;
  /** What to do on 15.9 (if anything). */
  now: string;
  /** What the v13 file will say / what 16.0 needs. */
  v13: string;
}

export interface V13Plan {
  /** The rewritten file (schema v13); the input when nothing changes or on errors. */
  text: string;
  changes: string[];
  pending: V13Pending[];
  report: CompatibilityReport;
  diff: string;
  ok: boolean;
}

const keyOf = (p: Pair): unknown => (isScalar(p.key) ? (p.key as Scalar).value : p.key);
const ALIAS = new Set(['worker', 'process', 'inline']);
const NODE24: V13Pending = { id: 'v16.node', path: '(runtime)', now: 'run on Node.js 24 LTS', v13: '16.0 needs Node.js 24 or newer' };

/** Plan (and apply the v12-compatible part of) the move of a schema v12 config to schema v13. */
export function planV13(text: string, format?: 'yaml' | 'json', names: { from?: string; to?: string } = {}): V13Plan {
  const fmt = format ?? (/^\s*[{[]/.test(text) ? 'json' : 'yaml');
  const report: CompatibilityReport = { errors: [], warnings: [], manual: [] };
  const changes: string[] = [];
  const pending: V13Pending[] = [];
  const done = (ok: boolean, out = text, diff = ''): V13Plan => ({ text: out, changes: ok ? changes : [], pending, report, diff, ok });
  let doc: Document;
  try {
    doc = parseDocument(text, { keepSourceTokens: true });
  } catch (e) {
    report.errors.push(`cannot parse the config: ${(e as Error).message}`);
    return done(false);
  }
  if (doc.errors.length) {
    report.errors.push(`cannot parse the config: ${doc.errors[0]!.message}`);
    return done(false);
  }
  if (!isMap(doc.contents)) {
    report.errors.push('the config must be a mapping at the top level');
    return done(false);
  }
  const version = doc.get('version');
  if (version !== 12 && version !== 13 && version !== undefined) {
    report.errors.push(`the config is on schema v${String(version)}: run \`mcp-gateway config migrate --to v12\` first, then \`--to v13\``);
    return done(false);
  }
  const reason = (e: unknown) => (e as Error).message.replace(/^Invalid configuration:\n?/, '');
  // 17.0.0-alpha.1: a file without `version:` is read as v13 — when it already is valid v13, it only gets `version: 13`
  let unversionedV13 = false;
  if (version === undefined) {
    try {
      validateConfig(doc.toJS());
      unversionedV13 = true;
    } catch {
      /* not v13 as written: read it as 16.x did (schema v12) and migrate */
    }
  }
  const from: 12 | 13 = version === 13 || unversionedV13 ? 13 : 12;
  if (from === 12) {
    try {
      validateV12ForMigration(doc.toJS());
    } catch (e) {
      report.errors.push(`the v12 file is not valid — fix it first:\n${reason(e)}`);
      return done(false);
    }
  }

  const plugins = doc.get('plugins');
  if (isSeq(plugins)) {
    plugins.items.forEach((item, i) => {
      if (!isMap(item)) return;
      const m = item as YAMLMap;
      if (typeof m.get('module') !== 'string' || m.has('component')) return; // WASM components keep `isolation`
      const iso = m.get('isolation');
      const rt = m.get('runtime');
      if (from === 12 && typeof iso === 'string' && ALIAS.has(iso)) {
        if (rt === undefined) {
          const pair = m.items.find((p) => keyOf(p as Pair) === 'isolation') as Pair;
          if (isScalar(pair.key)) (pair.key as Scalar).value = 'runtime';
          else (pair as { key: unknown }).key = 'runtime';
          changes.push(`plugins[${i}].isolation: ${iso} → runtime: ${iso}`);
        } else if (rt === iso) {
          m.delete('isolation');
          changes.push(`plugins[${i}].isolation: ${iso} (same as runtime) removed`);
        } else {
          report.errors.push(`plugins[${i}] says \`isolation: ${iso}\` and \`runtime: ${String(rt)}\`: keep one (\`runtime\` is what 16.0 reads)`);
        }
      }
      // 17.0.0-alpha.1: plugin API v6 runs module plugins in a worker or a child process only (16.x: allowInline: true)
      if (m.get('runtime') === 'inline') {
        m.set('runtime', 'worker');
        changes.push(`plugins[${i}]: runtime: inline → runtime: worker (17.0 runs module plugins only in a worker or a child process)`);
        pending.push({ id: `v17.plugins.${i}.inline`, path: `plugins[${i}]`, now: 'check the plugin runs in a worker: move onRequest / routes out of it and run `mcp-gateway plugin migrate --to v6 <file>` (plugin API v6)', v13: 'runtime: worker' });
      }
      if (m.has('allowInline')) {
        m.delete('allowInline');
        changes.push(`plugins[${i}].allowInline removed (17.0 has no inline module plugins)`);
      }
    });
  }
  const pv = doc.getIn(['mcp', 'protocolVersions']);
  if (isSeq(pv) && pv.items.some((x) => (isScalar(x) ? x.value : x) === '2024-11-05')) {
    pv.items = pv.items.filter((x) => (isScalar(x) ? x.value : x) !== '2024-11-05');
    if (pv.items.length === 0) {
      const mcp = doc.get('mcp') as YAMLMap;
      mcp.delete('protocolVersions');
      if (mcp.items.length === 0) (doc.contents as YAMLMap).delete('mcp');
      changes.push('mcp.protocolVersions: [2024-11-05] removed (16.0 accepts every supported revision again)');
    } else changes.push('mcp.protocolVersions: 2024-11-05 dropped (16.0 no longer accepts it on /mcp)');
  }
  pending.push(NODE24);
  if (report.errors.length) return done(false);
  if (version === undefined) {
    (doc.contents as YAMLMap).items.unshift(doc.createPair('version', 13) as never);
    changes.unshift(`version: (none, read as ${from}) → 13`);
  } else if (version === 12) {
    doc.set('version', 13);
    changes.unshift('version: 12 → 13');
  }
  if (changes.length === 0) {
    // already v13: check it as it is (idempotent)
    try {
      validateConfig(doc.toJS());
    } catch (e) {
      report.errors.push(`the v13 file is not valid:\n${reason(e)}`);
      return done(false);
    }
    return done(true);
  }

  const out = fmt === 'json' ? JSON.stringify(doc.toJS(), null, 2) + '\n' : doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  try {
    if ((validateConfig(doc.toJS()) as { schemaVersion?: number }).schemaVersion !== 13) throw new Error('not read as schema v13');
  } catch (e) {
    report.errors.push(`internal: the rewritten file does not load as schema v13 (${(e as Error).message}) — nothing written`);
    return done(false);
  }
  const input = fmt === 'json' ? JSON.stringify(JSON.parse(text), null, 2) + '\n' : text;
  return done(true, out, unifiedDiff(input, out, names.from ?? `v${from}`, names.to ?? 'v13'));
}
