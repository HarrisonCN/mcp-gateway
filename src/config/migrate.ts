/**
 * To v11 (10.9, the default): everything for v10, then `version: 11` and `features.workflows` → `features.taskGraphs`
 * (each workflow becomes a task graph with the same nodes). Schema v11 activates feature modules lazily — a note
 * suggests `kernel: { modules: eager }` for the 10.x behaviour. 10.9 reads v10 and v11; 11.0 reads v11 only.
 *
 * To v10 (9.9): everything for v9, then `version: 10` and every top-level feature section (`chaos`, `sla`,
 * `dlp`, … — {@link FEATURE_CONFIG_KEYS}) moves under `features`. 9.9 reads v9 and v10; 10.0 reads v10 only.
 *
 * To v9 (8.9): everything for v8, then `version: 9` and `state` → `store` (`state.store` → `store.backend`).
 * 8.9 reads v8 and v9.
 *
 * To v8 (7.9): everything for v7, then `version: 8`; `plugins[].wasm` entries are reported (rebuild as
 * plugin API v5 components, `component:`), JS plugins are reminded to declare `apiVersion: 5`. 8.0 reads v8 only.
 *
 * To v7 (6.9): everything for v6, then `version: 7` and `admin.configApi` → `controlPlane.configApi`,
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
import { FEATURE_CONFIG_KEYS } from '../gateway/features.js';

export interface MigrationResult {
  text: string;
  changes: string[];
  /** Things the tool cannot change for you. */
  notes: string[];
  changed: boolean;
}

export const SCOPE_FIELDS = ['servers', 'tools', 'rateLimit'] as const;

/** Migrate a config file's text. `format` is guessed from the content when omitted. */
export function migrateConfigText(text: string, format?: 'yaml' | 'json', to = 11): MigrationResult {
  if (![4, 5, 6, 7, 8, 9, 10, 11].includes(to)) throw new Error(`Only migration to schema v4, v5, v6, v7, v8, v9, v10 or v11 is supported (got ${to})`);
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

  if (to >= 9) {
    // 8.9 → 9.0: `state` becomes `store` (`state.store` → `store.backend`).
    const st = doc.get('state', true);
    if (st !== undefined) {
      if (doc.has('store')) notes.push('state and store are both set: merge state into store by hand, then remove state.');
      else {
        const pair = (root as YAMLMap).items.find((p) => (p.key as { value?: unknown })?.value === 'state' || p.key === 'state');
        if (pair && pair.key && typeof pair.key === 'object' && 'value' in pair.key) (pair.key as { value: unknown }).value = 'store';
        else if (pair) (pair as { key: unknown }).key = doc.createNode('store');
        const store = doc.get('store');
        let detail = '';
        if (isMap(store) && store.has('store')) {
          const sp = store.items.find((p) => (p.key as { value?: unknown })?.value === 'store' || p.key === 'store');
          if (sp && sp.key && typeof sp.key === 'object' && 'value' in sp.key) (sp.key as { value: unknown }).value = 'backend';
          else if (sp) (sp as { key: unknown }).key = doc.createNode('backend');
          detail = ' (store → backend)';
        }
        changes.push(`state → store${detail}`);
      }
    }
  }

  if (to >= 10) {
    // 9.9 → 10.0: every feature section moves under `features` (pairs are moved, so comments travel with them).
    const items = (root as YAMLMap).items;
    const moving = items.filter((p) => (FEATURE_CONFIG_KEYS as readonly string[]).includes(String((p.key as { value?: unknown })?.value ?? p.key)));
    if (moving.length) {
      let features = doc.get('features');
      if (features !== undefined && !isMap(features)) notes.push('features is not a mapping: move the feature sections under it by hand.');
      else {
        if (!isMap(features)) {
          features = doc.createNode({});
          doc.set('features', features);
        }
        for (const p of moving) {
          const k = String((p.key as { value?: unknown })?.value ?? p.key);
          if ((features as YAMLMap).has(k)) {
            notes.push(`features.${k} and top-level ${k} are both set: merge them by hand.`);
            continue;
          }
          items.splice(items.indexOf(p), 1);
          (features as YAMLMap).items.push(p as never);
          changes.push(`${k} → features.${k}`);
        }
      }
    }
  }

  if (to >= 11) {
    // 10.9 → 11.0: features.workflows (6.2) → features.taskGraphs (10.7).
    const features = doc.get('features');
    const wf = isMap(features) ? features.get('workflows') : undefined;
    if (isMap(features) && wf !== undefined) {
      const list = (isSeq(wf) ? (wf.toJSON() as unknown[]) : []) as Array<Record<string, unknown>>;
      const graphs = list.map(workflowToTaskGraph);
      let tg = features.get('taskGraphs');
      if (tg !== undefined && !isMap(tg)) notes.push('features.taskGraphs is not a mapping: move the converted workflows by hand.');
      else {
        if (!isMap(tg)) {
          tg = doc.createNode({ graphs: [] });
          features.set('taskGraphs', tg);
        }
        let gs = (tg as YAMLMap).get('graphs');
        if (!isSeq(gs)) {
          gs = doc.createNode([]);
          (tg as YAMLMap).set('graphs', gs);
        }
        const existing = new Set(((gs as { toJSON(): unknown }).toJSON() as Array<{ id?: string }>).map((g) => g.id));
        for (const g of graphs) {
          if (existing.has(g.id as string)) {
            notes.push(`task graph "${String(g.id)}" already exists: workflow "${String(g.id)}" was not converted — merge it by hand.`);
            continue;
          }
          (gs as { items: unknown[] }).items.push(doc.createNode(g));
        }
        features.delete('workflows');
        changes.push(`features.workflows (${graphs.length}) → features.taskGraphs.graphs`);
        notes.push(
          'Workflows are now task graphs: run them with POST /api/v1/admin/task-graphs/run `{ graph, input, wait }` (was /admin/workflows/run `{ workflow, … }`); ' +
            'calls run as the client that started the run (workflows used `workflow:<id>`) — adjust policy rules that matched `workflow:*`. Comments inside `workflows` were not carried over.',
        );
      }
    }
    if (!doc.hasIn(['kernel', 'modules'])) {
      notes.push('Schema v11 activates feature modules lazily: only configured `features.*` sections are mounted (others answer 404). Add `kernel: { modules: eager }` to keep the 10.x behaviour.');
    }
  }

  const plugins = doc.get('plugins');
  if (to >= 8 && isSeq(plugins)) {
    plugins.items.forEach((p, i) => {
      if (isMap(p) && p.has('wasm')) {
        notes.push(`plugins[${i}] (${String(p.get('name') ?? p.get('wasm'))}): core-ABI WASM plugins are not part of schema v8 — rebuild against wit/mcp-gateway-plugin.wit (plugin API v5) and replace \`wasm:\` with \`component:\` (see docs/guides/migrating-to-v8.md).`);
      }
    });
  }
  if (isSeq(plugins) && plugins.items.some((p) => isMap(p) && p.has('module'))) {
    notes.push(
      to >= 8
        ? 'JS plugins: declare `apiVersion: 5` (plugin API v4 is refused by 8.0; hooks may return `{ action }` outcomes).'
        : to >= 6
        ? 'JS plugins: declare `apiVersion: 4` (plugin API v3 is refused by 6.0).'
        : to === 5
        ? 'JS plugins: declare `apiVersion: 4` (v2 is refused by 5.0; v3 keeps loading with a deprecation warning until 6.0).'
        : 'JS plugins: declare `apiVersion: 3` or `4` (v1 is refused since 4.0; v2 still loads with a warning until 5.0).',
    );
  }
}

/** One 6.2 workflow → a 10.7 task graph (same nodes; retry backoff keeps doubling, uncapped as before). */
export function workflowToTaskGraph(w: Record<string, unknown>): Record<string, unknown> {
  const nodes = (Array.isArray(w.nodes) ? w.nodes : []) as Array<Record<string, unknown>>;
  return {
    id: w.id,
    ...(w.description !== undefined ? { description: w.description } : {}),
    ...(w.concurrency !== undefined ? { concurrency: w.concurrency } : {}),
    nodes: nodes.map((n) => {
      const { retry, ...rest } = n;
      const r = retry as { attempts?: number; backoffMs?: number } | undefined;
      return { ...rest, ...(r ? { retry: { ...(r.attempts !== undefined ? { attempts: r.attempts } : {}), ...(r.backoffMs !== undefined ? { backoffMs: r.backoffMs } : {}), factor: 2, maxBackoffMs: 3_600_000 } } : {}) };
    }),
    ...(w.output !== undefined ? { output: w.output } : {}),
  };
}

/** Plain-object variant (for validation / tests). */
export function migrateConfigObject(raw: Record<string, unknown>, to = 11): { config: Record<string, unknown>; changes: string[] } {
  const r = migrateConfigText(JSON.stringify(raw), 'json', to);
  return { config: JSON.parse(r.text) as Record<string, unknown>, changes: r.changes };
}
