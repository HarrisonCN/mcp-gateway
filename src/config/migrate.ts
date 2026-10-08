/**
 * To v7 (6.9, the default): everything for v6, then `version: 7` and `admin.configApi` → `controlPlane.configApi`,
 * `dashboard.enabled` → `controlPlane.dashboard`. 6.9 reads v6 and v7.
 *
 * To v6 (5.9): everything for v5, then `version: 6` and `compliance.pii` → `dlp` (redact → strategy
 * `redact`, block → `block`, both with clearance `public`; tag → clearance `restricted`, i.e. detect and count only;
 * `scope` / `servers` kept; categories not listed get level `public`). 5.9 reads v5 and v6.
 *
 * `mcp-gateway migrate` (3.9; `--to 5` since 4.9): rewrites a config file to schema v5 (or v4), keeping
 * comments and layout (YAML documents are edited in place). 5.x only reads v5; `--to 4` is kept for 4.x deployments.
 *
 * To v5 (4.9): everything below for v4, then `version: 5` and `servers[].timeout` → `timeoutMs`; plugins are listed
 * as a reminder (v2 is refused by 5.0, v3 keeps loading with a deprecation — declare `apiVersion: 4`).
 * 4.9 reads both v4 and v5 files, so a migrated file works before and after upgrading to 5.0.
 *
 * To v4 (3.9) changes:
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
export function migrateConfigText(text: string, format?: 'yaml' | 'json', to = 7): MigrationResult {
  if (![4, 5, 6, 7].includes(to)) throw new Error(`Only migration to schema v4, v5, v6 or v7 is supported (got ${to})`);
  const fmt = format ?? (/^\s*[{[]/.test(text) ? 'json' : 'yaml');
  const doc = parseDocument(text, { keepSourceTokens: true });
  if (doc.errors.length) throw new Error(`Cannot parse the config: ${doc.errors[0]!.message}`);
  const changes: string[] = [];
  const notes: string[] = [];
  migrateDoc(doc, changes, notes, to);
  const out = changes.length === 0 ? text : fmt === 'json' ? JSON.stringify(doc.toJS(), null, 2) + '\n' : doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  return { text: out, changes, notes, changed: changes.length > 0 };
}

function migrateDoc(doc: Document, changes: string[], notes: string[], to: number): void {
  const root = doc.contents;
  if (!isMap(root)) throw new Error('The config must be a mapping at the top level');
  const version = doc.get('version');
  if (typeof version === 'number' && version > to) throw new Error(`The config is already on schema v${version} (downgrading is not supported)`);
  if (version !== to) {
    if (version === undefined) {
      // Put `version` first so it is easy to see.
      (root as YAMLMap).items.unshift(doc.createPair('version', to) as never);
    } else doc.set('version', to);
    changes.push(`version: ${version === undefined ? '(none)' : JSON.stringify(version)} → ${to}`);
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

  if (to >= 5 && isSeq(servers)) {
    servers.items.forEach((s, i) => {
      if (!isMap(s) || !s.has('timeout')) return;
      // Rename in place (keeps the key's position and comments).
      const pair = s.items.find((p) => (p.key as { value?: unknown })?.value === 'timeout' || p.key === 'timeout');
      if (pair && pair.key && typeof pair.key === 'object' && 'value' in pair.key) (pair.key as { value: unknown }).value = 'timeoutMs';
      else if (pair) (pair as { key: unknown }).key = doc.createNode('timeoutMs');
      changes.push(`servers[${i}] (${String(s.get('id'))}): timeout → timeoutMs`);
    });
  }

  if (to >= 6) {
    const pii = doc.getIn(['compliance', 'pii']);
    if (isMap(pii)) {
      if (doc.has('dlp')) {
        notes.push('compliance.pii and dlp are both set: merge compliance.pii into dlp by hand, then remove compliance.pii.');
      } else {
        const p = pii.toJSON() as { enabled?: boolean; categories?: string[]; action?: string; scope?: string; servers?: string[] };
        const action = p.action ?? 'redact';
        const all = ['email', 'phone', 'credit-card', 'ssn', 'iban', 'ipv4', 'cn-id'];
        const dlp: Record<string, unknown> = {
          ...(p.enabled === false ? { enabled: false } : {}),
          scope: p.scope ?? 'both',
          ...(p.servers ? { servers: p.servers } : {}),
          default: action === 'tag' ? { clearance: 'restricted' } : { clearance: 'public', strategy: action === 'block' ? 'block' : 'redact' },
        };
        if (p.categories?.length) {
          const off = all.filter((c) => !p.categories!.includes(c));
          if (off.length) dlp.levels = Object.fromEntries(off.map((c) => [c, 'public']));
        }
        doc.set('dlp', doc.createNode(dlp));
        (doc.get('compliance') as YAMLMap).delete('pii');
        if ((doc.get('compliance') as YAMLMap).items.length === 0) doc.delete('compliance');
        changes.push(`compliance.pii (action ${action}) → dlp`);
        if (action === 'block') notes.push('DLP refuses with error code -32013 (compliance.pii used -32012); update clients that match on the code.');
      }
    }
  }

  if (to >= 7) {
    // 6.9 → 7.0: `admin` / `dashboard` move under `controlPlane`.
    const moves: Array<[string, string, string]> = [['admin', 'configApi', 'configApi'], ['dashboard', 'enabled', 'dashboard']];
    for (const [section, key, target] of moves) {
      const sec = doc.get(section);
      if (sec === undefined) continue;
      if (isMap(sec)) {
        const v = sec.get(key);
        const other = sec.items.filter((p) => (p.key as { value?: unknown })?.value !== key && p.key !== key);
        if (v !== undefined) {
          let cp = doc.get('controlPlane');
          if (!isMap(cp)) {
            cp = doc.createNode({});
            doc.set('controlPlane', cp);
          }
          (cp as YAMLMap).set(target, v);
        }
        if (other.length) notes.push(`${section}: keys other than ${key} are not part of schema v7; review them by hand.`);
        else doc.delete(section);
        changes.push(`${section}.${key} → controlPlane.${target}`);
      } else {
        doc.delete(section);
        changes.push(`${section} (empty) removed`);
      }
    }
  }

  const plugins = doc.get('plugins');
  if (isSeq(plugins) && plugins.items.some((p) => isMap(p) && p.has('module'))) {
    notes.push(
      to >= 6
        ? 'JS plugins: declare `apiVersion: 4` (plugin API v3 is refused by 6.0).'
        : to === 5
        ? 'JS plugins: declare `apiVersion: 4` (v2 is refused by 5.0; v3 keeps loading with a deprecation warning until 6.0).'
        : 'JS plugins: declare `apiVersion: 3` or `4` (v1 is refused since 4.0; v2 still loads with a warning until 5.0).',
    );
  }
}

/** Plain-object variant (for validation / tests). */
export function migrateConfigObject(raw: Record<string, unknown>, to = 7): { config: Record<string, unknown>; changes: string[] } {
  const r = migrateConfigText(JSON.stringify(raw), 'json', to);
  return { config: JSON.parse(r.text) as Record<string, unknown>, changes: r.changes };
}
