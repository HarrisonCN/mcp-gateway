/**
 * Managed edge nodes (5.3): the control plane knows its edge fleet, reports config drift and pushes new config.
 *
 * Edges (`@winstonsayno/mcp-gateway/edge` with `sync`) pull snapshots on their own schedule. With `edgeFleet`
 * configured the Node gateway can also *push*: it calls each edge's `POST /api/v1/edge/sync`, which makes the
 * edge pull the current snapshot, replay queued calls and upload usage right away.
 *
 * ```yaml
 * edgeFleet:
 *   pushTimeoutMs: 10000
 *   nodes:
 *     - { id: cf-hkg, url: https://edge-hkg.example.workers.dev, apiKey: ${EDGE_KEY}, labels: { ring: canary } }
 *     - { id: deno-fra, url: https://fra.example.deno.dev, apiKey: ${EDGE_KEY}, labels: { ring: stable } }
 * ```
 *
 * - `GET  /admin/edge-fleet` — configured + seen edges with drift: `in-sync`, `stale` (applied an older snapshot),
 *   `never-synced`, `unmanaged` (syncs but is not in `nodes`), `offline` (not seen for `offlineAfterMs`).
 * - `POST /admin/edge-fleet/push` — `{ nodes?: string[], labels?: Record<string,string>, onlyDrifted?: boolean }`
 *   → per-node result. Rolling out by ring: push `labels: { ring: canary }` first, then the rest.
 *
 * @module features/edge-fleet
 */

import { z } from 'zod';
import { registerFeature, objectBody, badRequest } from '../gateway/features.js';
import { buildEdgeSnapshot, type EdgeNode } from '../gateway/edge-control.js';

export const EdgeFleetSchema = z
  .object({
    pushTimeoutMs: z.number().int().min(100).default(10_000),
    offlineAfterMs: z.number().int().min(1000).default(15 * 60_000),
    nodes: z
      .array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/), url: z.string().url(), apiKey: z.string().optional(), labels: z.record(z.string()).default({}) }).strict())
      .default([]),
  })
  .strict();
export type EdgeFleetConfig = z.input<typeof EdgeFleetSchema>;
type Resolved = z.output<typeof EdgeFleetSchema>;

export type Drift = 'in-sync' | 'stale' | 'never-synced' | 'unmanaged' | 'offline';
export interface FleetNode {
  id: string;
  url?: string;
  labels: Record<string, string>;
  managed: boolean;
  drift: Drift;
  appliedEtag?: string;
  lastSeen?: string;
  lastSync?: string;
  queuedCalls: number;
  errors: number;
}
export interface PushResult {
  id: string;
  ok: boolean;
  status?: number;
  config?: string;
  error?: string;
  durationMs: number;
}

/** Merge configured nodes with nodes seen by the control plane and classify drift. */
export function fleetView(cfg: Resolved, seen: EdgeNode[], currentEtags: string[], now = Date.now()): FleetNode[] {
  const byId = new Map(seen.map((n) => [n.edgeId, n]));
  const out: FleetNode[] = [];
  const classify = (n: EdgeNode | undefined, managed: boolean): Drift => {
    if (!n || !n.snapshotEtag) return n && !managed ? 'unmanaged' : 'never-synced';
    if (now - Date.parse(n.lastSeen) > cfg.offlineAfterMs) return 'offline';
    if (!managed) return 'unmanaged';
    return currentEtags.includes(n.snapshotEtag) ? 'in-sync' : 'stale';
  };
  for (const c of cfg.nodes) {
    const n = byId.get(c.id);
    out.push({ id: c.id, url: c.url, labels: c.labels, managed: true, drift: classify(n, true), appliedEtag: n?.snapshotEtag, lastSeen: n?.lastSeen, lastSync: n?.lastSync, queuedCalls: n?.queuedCalls ?? 0, errors: n?.errors ?? 0 });
    byId.delete(c.id);
  }
  for (const n of byId.values()) {
    out.push({ id: n.edgeId, labels: {}, managed: false, drift: classify(n, false), appliedEtag: n.snapshotEtag, lastSeen: n.lastSeen, lastSync: n.lastSync, queuedCalls: n.queuedCalls, errors: n.errors });
  }
  return out;
}

/** Which configured nodes a push targets. */
export function selectNodes(cfg: Resolved, view: FleetNode[], sel: { nodes?: string[]; labels?: Record<string, string>; onlyDrifted?: boolean }): Resolved['nodes'] {
  return cfg.nodes.filter((n) => {
    if (sel.nodes?.length && !sel.nodes.includes(n.id)) return false;
    if (sel.labels && !Object.entries(sel.labels).every(([k, v]) => n.labels[k] === v)) return false;
    if (sel.onlyDrifted && view.find((v) => v.id === n.id)?.drift === 'in-sync') return false;
    return true;
  });
}

/** Ask each edge to sync now. */
export async function pushToNodes(nodes: Resolved['nodes'], timeoutMs: number, f: typeof fetch = fetch): Promise<PushResult[]> {
  return Promise.all(
    nodes.map(async (n) => {
      const started = Date.now();
      try {
        const res = await f(`${n.url.replace(/\/$/, '')}/api/v1/edge/sync`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(n.apiKey ? { authorization: `Bearer ${n.apiKey}` } : {}) },
          body: '{}',
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body = (await res.json().catch(() => ({}))) as { config?: string; message?: string };
        return { id: n.id, ok: res.ok, status: res.status, ...(body.config ? { config: body.config } : {}), ...(!res.ok ? { error: body.message ?? `HTTP ${res.status}` } : {}), durationMs: Date.now() - started };
      } catch (e) {
        return { id: n.id, ok: false, error: (e as Error).message, durationMs: Date.now() - started };
      }
    }),
  );
}

registerFeature({
  id: 'edge-fleet',
  since: '5.3.0',
  summary: 'Managed edge nodes: fleet view with config drift, push config to edges',
  mount: (router, ctx) => {
    const resolve = () => EdgeFleetSchema.parse(ctx.config().edgeFleet ?? {});
    const etags = () => [buildEdgeSnapshot(ctx.config(), ctx.tools(), false).etag, buildEdgeSnapshot(ctx.config(), ctx.tools(), true).etag];
    router.get('/', (_req, res) => {
      const cfg = resolve();
      const [etag] = etags();
      const nodes = fleetView(cfg, ctx.edgeNodes?.() ?? [], etags());
      const counts = nodes.reduce<Record<string, number>>((m, n) => ((m[n.drift] = (m[n.drift] ?? 0) + 1), m), {});
      res.json({ etag, counts, nodes });
    });
    router.post('/push', async (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      if (b.nodes !== undefined && !(Array.isArray(b.nodes) && b.nodes.every((x) => typeof x === 'string'))) return badRequest(res, '"nodes" must be an array of ids');
      if (b.labels !== undefined && (typeof b.labels !== 'object' || b.labels === null || Array.isArray(b.labels))) return badRequest(res, '"labels" must be an object');
      const cfg = resolve();
      if (!cfg.nodes.length) return void res.status(404).json({ error: 'Not Found', message: 'no managed edge nodes (`edgeFleet.nodes`)' });
      const view = fleetView(cfg, ctx.edgeNodes?.() ?? [], etags());
      const targets = selectNodes(cfg, view, { nodes: b.nodes as string[] | undefined, labels: b.labels as Record<string, string> | undefined, onlyDrifted: b.onlyDrifted === true });
      const results = await pushToNodes(targets, cfg.pushTimeoutMs);
      res.json({ pushed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results });
    });
  },
});
