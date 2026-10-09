/**
 * Data lineage (8.6): where did the data in a tool call come from, and where did a tool's output go?
 *
 * Every tool call becomes a **node** (tool, client, time, outcome). The gateway fingerprints the string values in each
 * successful result (SHA-256 of values of at least `minValueLength` characters, never the values themselves) and,
 * when a later call's **arguments** contain one of those values, records an **edge** `producer → consumer` with the
 * argument path that carried it. Calls are linked within the same client (default), tenant or globally, inside the
 * time window — which covers agent loops, chains and workflows without any change to clients or servers.
 *
 * ```yaml
 * dataLineage:
 *   scope: client             # client | tenant | global — whose outputs a call may derive from
 *   windowMinutes: 60
 *   minValueLength: 8         # shorter values (ids like "1", "yes") are ignored
 *   maxNodes: 5000
 * ```
 *
 * - `GET /admin/data-lineage` — recent nodes with in / out edge counts.
 * - `GET /admin/data-lineage/nodes/:id?depth=3` — the node with its upstream and downstream graph.
 * - `POST /admin/data-lineage/trace` `{ value }` — every call that produced or consumed this exact value.
 * - `GET /admin/data-lineage/export` — OpenLineage-style run events (`inputs` / `outputs` datasets per call).
 *
 * @module features/data-lineage
 */

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { registerFeature, objectBody, badRequest } from '../gateway/features.js';
import { registerCallHook } from '../gateway/hooks.js';
import type { GatewayConfig } from '../utils/types.js';
import { type DataLineageConfig, DataLineageSchema } from './schemas/data-lineage.js';
export { type DataLineageConfig, DataLineageSchema } from './schemas/data-lineage.js';
type Cfg = z.output<typeof DataLineageSchema>;

export interface LineageNode {
  id: string;
  at: number;
  tool: string;
  client?: string;
  tenant?: string;
  success?: boolean;
  /** Fingerprints of the values in the result. */
  produced: string[];
  /** Fingerprints of the values in the arguments (path → fingerprint). */
  consumed: Array<{ path: string; fp: string }>;
}
export interface LineageEdge {
  from: string;
  to: string;
  /** Argument path of the consumer that carried the value. */
  path: string;
  fp: string;
}

const settings = (cfg: GatewayConfig): Cfg | undefined => {
  if (!cfg.dataLineage) return undefined;
  const c = DataLineageSchema.parse(cfg.dataLineage);
  return c.enabled ? c : undefined;
};

export const fingerprint = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 24);

/** String values (≥ min length) of a JSON value with their paths; JSON text inside strings is walked too. */
export function values(v: unknown, min: number, path = '', out: Array<{ path: string; value: string }> = [], depth = 0): Array<{ path: string; value: string }> {
  if (depth > 12 || out.length > 500) return out;
  if (typeof v === 'string') {
    const t = v.trim();
    if ((t.startsWith('{') || t.startsWith('[')) && t.length < 200_000) {
      try {
        return values(JSON.parse(t), min, path, out, depth + 1);
      } catch {
        /* plain text */
      }
    }
    if (t.length >= min) out.push({ path: path || '$', value: t });
  } else if (typeof v === 'number' && String(v).length >= min) {
    out.push({ path: path || '$', value: String(v) });
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => values(x, min, `${path}[${i}]`, out, depth + 1));
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) values(x, min, path ? `${path}.${k}` : k, out, depth + 1);
  }
  return out;
}

/** Lineage graph; exported for tests. */
export const lineageState = {
  nodes: new Map<string, LineageNode>(),
  edges: [] as LineageEdge[],
  /** fingerprint → producer node ids (newest last). */
  producers: new Map<string, string[]>(),
  pending: new WeakMap<object, string>(),
  reset() {
    this.nodes.clear();
    this.edges.length = 0;
    this.producers.clear();
  },
};

const scopeKey = (c: Cfg, n: Pick<LineageNode, 'client' | 'tenant'>) => (c.scope === 'global' ? '*' : c.scope === 'tenant' ? n.tenant ?? n.client ?? '' : n.client ?? '');

function evict(c: Cfg, now: number): void {
  const cutoff = now - c.windowMinutes * 60_000;
  const over = lineageState.nodes.size - c.maxNodes;
  let i = 0;
  for (const [id, n] of lineageState.nodes) {
    if (n.at >= cutoff && i >= over) break;
    lineageState.nodes.delete(id);
    i++;
  }
  if (i) {
    lineageState.edges = lineageState.edges.filter((e) => lineageState.nodes.has(e.from) && lineageState.nodes.has(e.to));
    for (const [fp, ids] of lineageState.producers) {
      const keep = ids.filter((x) => lineageState.nodes.has(x));
      if (keep.length) lineageState.producers.set(fp, keep);
      else lineageState.producers.delete(fp);
    }
  }
}

/** Record a call's arguments (start); returns the node id. */
export function recordCall(c: Cfg, n: { tool: string; client?: string; tenant?: string; args: unknown }, now = Date.now()): string {
  evict(c, now);
  const node: LineageNode = { id: randomUUID().slice(0, 12), at: now, tool: n.tool, client: n.client, tenant: n.tenant, produced: [], consumed: values(n.args, c.minValueLength).map((x) => ({ path: x.path, fp: fingerprint(x.value) })) };
  lineageState.nodes.set(node.id, node);
  const key = scopeKey(c, node);
  const seen = new Set<string>();
  for (const { path, fp } of node.consumed) {
    const prod = (lineageState.producers.get(fp) ?? []).map((id) => lineageState.nodes.get(id)).filter((p): p is LineageNode => !!p && p.id !== node.id && scopeKey(c, p) === key);
    const p = prod[prod.length - 1];
    if (p && !seen.has(`${p.id}:${path}`)) {
      seen.add(`${p.id}:${path}`);
      lineageState.edges.push({ from: p.id, to: node.id, path, fp });
    }
  }
  return node.id;
}

/** Record a call's result (end). */
export function recordResult(c: Cfg, id: string, success: boolean, result: unknown): void {
  const node = lineageState.nodes.get(id);
  if (!node) return;
  node.success = success;
  if (!success) return;
  node.produced = [...new Set(values(result, c.minValueLength).map((x) => fingerprint(x.value)))];
  for (const fp of node.produced) {
    const ids = lineageState.producers.get(fp) ?? [];
    ids.push(id);
    if (ids.length > 20) ids.shift();
    lineageState.producers.set(fp, ids);
  }
}

const summary = (n: LineageNode) => ({ id: n.id, at: new Date(n.at).toISOString(), tool: n.tool, client: n.client, tenant: n.tenant, success: n.success, inputs: lineageState.edges.filter((e) => e.to === n.id).length, outputs: lineageState.edges.filter((e) => e.from === n.id).length });

/** Upstream / downstream graph of a node up to `depth` hops. */
export function graphOf(id: string, depth: number) {
  const walk = (dir: 'up' | 'down') => {
    const nodes = new Set<string>();
    const edges: LineageEdge[] = [];
    let frontier = [id];
    for (let d = 0; d < depth && frontier.length; d++) {
      const next: string[] = [];
      for (const f of frontier) {
        for (const e of lineageState.edges.filter((x) => (dir === 'up' ? x.to === f : x.from === f))) {
          edges.push(e);
          const o = dir === 'up' ? e.from : e.to;
          if (!nodes.has(o)) {
            nodes.add(o);
            next.push(o);
          }
        }
      }
      frontier = next;
    }
    return { nodes: [...nodes].map((x) => lineageState.nodes.get(x)).filter((n): n is LineageNode => !!n).map(summary), edges: edges.map(({ from, to, path }) => ({ from, to, path })) };
  };
  return { upstream: walk('up'), downstream: walk('down') };
}

registerCallHook({
  id: 'data-lineage',
  before(call, cfg) {
    const c = settings(cfg);
    if (!c) return;
    lineageState.pending.set(call.args, recordCall(c, { tool: `${call.serverId}/${call.tool}`, client: call.clientId, tenant: call.tenant, args: call.args }));
  },
  after(call, result, cfg) {
    const c = settings(cfg);
    const id = lineageState.pending.get(call.args);
    if (!c || !id) return;
    lineageState.pending.delete(call.args);
    recordResult(c, id, result.success, result.result);
  },
});

registerFeature({
  id: 'data-lineage',
  since: '8.6.0',
  summary: 'Data lineage: value fingerprints link tool outputs to later tool inputs (graph, trace by value, OpenLineage export)',
  mount(router, ctx) {
    router.get('/', (req, res) => {
      const c = settings(ctx.config());
      const limit = Math.min(Number(req.query.limit) || 100, 1000);
      res.json({ enabled: !!c, scope: c?.scope, nodes: lineageState.nodes.size, edges: lineageState.edges.length, recent: [...lineageState.nodes.values()].slice(-limit).reverse().map(summary) });
    });
    router.get('/nodes/:id', (req, res) => {
      const n = lineageState.nodes.get(String(req.params.id));
      if (!n) return void res.status(404).json({ error: 'Not Found', message: `no lineage node "${req.params.id}"` });
      const depth = Math.min(Math.max(Number(req.query.depth) || 3, 1), 20);
      res.json({ node: summary(n), ...graphOf(n.id, depth) });
    });
    router.post('/trace', (req, res) => {
      const c = settings(ctx.config());
      if (!c) return badRequest(res, 'dataLineage is not configured');
      const b = objectBody(req, res);
      if (!b) return;
      if (typeof b.value !== 'string' && typeof b.value !== 'number') return badRequest(res, 'Body must be { "value": "<string or number>" }');
      const fp = fingerprint(String(b.value).trim());
      const all = [...lineageState.nodes.values()];
      res.json({
        fingerprint: fp,
        producedBy: all.filter((n) => n.produced.includes(fp)).map(summary),
        consumedBy: all.filter((n) => n.consumed.some((x) => x.fp === fp)).map((n) => ({ ...summary(n), paths: n.consumed.filter((x) => x.fp === fp).map((x) => x.path) })),
      });
    });
    router.get('/export', (_req, res) => {
      const ns = 'mcp-gateway';
      res.json({
        events: [...lineageState.nodes.values()].map((n) => ({
          eventType: n.success === undefined ? 'START' : n.success ? 'COMPLETE' : 'FAIL',
          eventTime: new Date(n.at).toISOString(),
          run: { runId: n.id, facets: { client: n.client, tenant: n.tenant } },
          job: { namespace: ns, name: n.tool },
          inputs: lineageState.edges.filter((e) => e.to === n.id).map((e) => ({ namespace: ns, name: `${lineageState.nodes.get(e.from)?.tool ?? '?'}#${e.from}`, facets: { path: e.path } })),
          outputs: n.produced.length ? [{ namespace: ns, name: `${n.tool}#${n.id}`, facets: { values: n.produced.length } }] : [],
        })),
      });
    });
  },
});
