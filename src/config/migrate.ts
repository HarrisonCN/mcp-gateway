/**
 * `mcp-gateway migrate` (3.9): rewrites a config file to schema v4, keeping comments and layout (YAML documents are
 * edited in place). Changes:
 *
 *  - `version: 3` (or none) → `version: 4`;
 *  - `auth.apiKeys[]` flat scope fields (`servers`, `tools`, `rateLimit`) → `scope: { servers, tools, rateLimit }`;
 *  - `loadBalancing.strategy: least-latency` → `strategy: smart` with `score: { latency: 1, errorRate: 0, cost: 0 }`
 *    (same ordering);
 *  - plugins: listed as a reminder only (plugin code is not rewritten).
 *
 * 3.9 reads both forms, so a migrated file works before and after upgrading to 4.0.
 *
 * @module config/migrate
 */

import { parseDocument, isMap, isSeq, YAMLMap, type Document } from 'yaml';

export interface MigrationResult {
  text: string;
  changes: string[];
  /** Things the tool cannot change for you. */
  notes: string[];
  changed: boolean;
}

export const SCOPE_FIELDS = ['servers', 'tools', 'rateLimit'] as const;

/** Migrate a config file's text. `format` is guessed from the content when omitted. */
export function migrateConfigText(text: string, format?: 'yaml' | 'json', to = 4): MigrationResult {
  if (to !== 4) throw new Error(`Only migration to schema v4 is supported (got ${to})`);
  const fmt = format ?? (/^\s*[{[]/.test(text) ? 'json' : 'yaml');
  const doc = parseDocument(text, { keepSourceTokens: true });
  if (doc.errors.length) throw new Error(`Cannot parse the config: ${doc.errors[0]!.message}`);
  const changes: string[] = [];
  const notes: string[] = [];
  migrateDoc(doc, changes, notes);
  const out = changes.length === 0 ? text : fmt === 'json' ? JSON.stringify(doc.toJS(), null, 2) + '\n' : doc.toString({ lineWidth: 0 });
  return { text: out, changes, notes, changed: changes.length > 0 };
}

function migrateDoc(doc: Document, changes: string[], notes: string[]): void {
  const root = doc.contents;
  if (!isMap(root)) throw new Error('The config must be a mapping at the top level');
  const version = doc.get('version');
  if (version !== 4) {
    if (version === undefined) {
      // Put `version` first so it is easy to see.
      (root as YAMLMap).items.unshift(doc.createPair('version', 4) as never);
    } else doc.set('version', 4);
    changes.push(`version: ${version === undefined ? '(none)' : JSON.stringify(version)} → 4`);
  }

  const keys = doc.getIn(['auth', 'apiKeys']);
  if (isSeq(keys)) {
    keys.items.forEach((item, i) => {
      if (!isMap(item)) return;
      const moved = SCOPE_FIELDS.filter((f) => item.has(f));
      if (moved.length === 0) return;
      let scope = item.get('scope');
      if (!isMap(scope)) {
        scope = doc.createNode({});
        item.set('scope', scope);
      }
      for (const f of moved) {
        (scope as YAMLMap).set(f, item.get(f, true));
        item.delete(f);
      }
      const name = item.get('name');
      changes.push(`auth.apiKeys[${i}]${typeof name === 'string' ? ` (${name})` : ''}: ${moved.join(', ')} → scope`);
    });
  }

  const servers = doc.get('servers');
  if (isSeq(servers)) {
    servers.items.forEach((s, i) => {
      if (!isMap(s)) return;
      const lb = s.get('loadBalancing');
      if (isMap(lb) && lb.get('strategy') === 'least-latency') {
        lb.set('strategy', 'smart');
        if (!lb.has('score')) lb.set('score', doc.createNode({ latency: 1, errorRate: 0, cost: 0 }));
        changes.push(`servers[${i}] (${String(s.get('id'))}): loadBalancing.strategy least-latency → smart (latency-only score)`);
      }
    });
  }

  const plugins = doc.get('plugins');
  if (isSeq(plugins) && plugins.items.some((p) => isMap(p) && p.has('module'))) {
    notes.push('JS plugins: declare `apiVersion: 3` (v1 is refused since 4.0; v2 still loads with a warning until 5.0).');
  }
}

/** Plain-object variant (for validation / tests). */
export function migrateConfigObject(raw: Record<string, unknown>): { config: Record<string, unknown>; changes: string[] } {
  const r = migrateConfigText(JSON.stringify(raw), 'json');
  return { config: JSON.parse(r.text) as Record<string, unknown>, changes: r.changes };
}
