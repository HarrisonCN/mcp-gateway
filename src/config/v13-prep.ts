/**
 * 15.9.0-canary.1: `mcp-gateway config migrate --to v13` — the codemod for the 16.0 config changes
 * (docs/migrating-to-v16.md; the 16.0 list is a proposal until 16.0.0-rc.1).
 *
 * Config schema v13 itself lands in 16.0.0-alpha.1, so on 15.x this applies only the rewrites that are valid schema v12
 * and mean exactly the same thing on 15.x — `isolation: worker|process|inline` on a module plugin becomes `runtime:` —
 * and keeps `version: 12`. The v13-only changes (the per-plugin `allowInline: true` opt-in for inline module plugins,
 * dropping `/mcp` revision 2024-11-05, Node.js 24) are returned as `pending` and never written. Idempotent: running it
 * on its own output changes nothing. Loaded on demand by the CLI only (not part of the gateway's start-up graph).
 *
 * @module config/v13-prep
 */

import { parseDocument, isMap, isSeq, isScalar, type Document, type YAMLMap, type Pair, type Scalar } from 'yaml';
import { validateConfig } from './loader.js';
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
  /** The rewritten file (still schema v12); the input when nothing changes or on errors. */
  text: string;
  changes: string[];
  pending: V13Pending[];
  report: CompatibilityReport;
  diff: string;
  ok: boolean;
}

const keyOf = (p: Pair): unknown => (isScalar(p.key) ? (p.key as Scalar).value : p.key);
const ALIAS = new Set(['worker', 'process', 'inline']);

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
  if (version === 13) {
    report.errors.push('the file already says `version: 13`: config schema v13 is read from 16.0.0-alpha.1 on — 15.x cannot load it');
    return done(false);
  }
  if (version !== 12) {
    report.errors.push(`the config is on schema ${version === undefined ? '(no version)' : `v${String(version)}`}: run \`mcp-gateway config migrate --to v12\` first, then \`--to v13\``);
    return done(false);
  }
  try {
    validateConfig(doc.toJS());
  } catch (e) {
    report.errors.push(`the v12 file is not valid — fix it first:\n${(e as Error).message.replace(/^Invalid configuration:\n?/, '')}`);
    return done(false);
  }

  const plugins = doc.get('plugins');
  if (isSeq(plugins)) {
    plugins.items.forEach((item, i) => {
      if (!isMap(item)) return;
      const m = item as YAMLMap;
      if (typeof m.get('module') !== 'string' || m.has('component')) return; // WASM components keep `isolation`
      const iso = m.get('isolation');
      const rt = m.get('runtime');
      if (typeof iso === 'string' && ALIAS.has(iso)) {
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
      if ((m.get('runtime') ?? m.get('isolation')) === 'inline') {
        pending.push({
          id: `v16.plugins.${i}.inline`,
          path: `plugins[${i}]`,
          now: 'move it to `runtime: worker` (or `process`) if it does not need HTTP hooks',
          v13: 'an inline module plugin needs `allowInline: true` on its entry in schema v13',
        });
      }
    });
  }
  const pv = doc.getIn(['mcp', 'protocolVersions']);
  if (isSeq(pv) && pv.items.some((x) => (isScalar(x) ? x.value : x) === '2024-11-05')) {
    pending.push({
      id: 'v16.mcp.protocol-2024-11-05',
      path: 'mcp.protocolVersions',
      now: 'upgrade the clients that still initialize /mcp with 2024-11-05, then drop it from the list',
      v13: '16.0 does not accept 2024-11-05 on /mcp (upstream HTTP+SSE servers stay supported)',
    });
  }
  pending.push({ id: 'v16.node', path: '(runtime)', now: 'run on Node.js 24 LTS', v13: '16.0 needs Node.js 24 or newer' });
  if (report.errors.length) return done(false);
  if (!changes.length) return done(true);

  const out = fmt === 'json' ? JSON.stringify(doc.toJS(), null, 2) + '\n' : doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  try {
    if ((validateConfig(doc.toJS()) as { schemaVersion?: number }).schemaVersion !== 12) throw new Error('not read as schema v12');
  } catch (e) {
    report.errors.push(`internal: the rewritten file does not load on 15.x (${(e as Error).message}) — nothing written`);
    return done(false);
  }
  const input = fmt === 'json' ? JSON.stringify(JSON.parse(text), null, 2) + '\n' : text;
  return done(true, out, unifiedDiff(input, out, names.from ?? 'v12', names.to ?? 'v12 (v13-ready)'));
}
