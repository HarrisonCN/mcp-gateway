/**
 * Live dashboard API
 *
 *  - GET /stats   → windowed time series (count, errors, p50/p95 per bucket),
 *                   summary (p50/p95/p99, error rate, req/min), top tools,
 *                   per-server and per-client (API key) usage.
 *  - GET /events  → Server-Sent Events: a `request` event for every recorded
 *                   call and a `snapshot` (server health + summary) every few
 *                   seconds. Auth uses the normal headers, so browsers read it
 *                   with fetch() streaming rather than EventSource.
 *
 * Both use the regular auth middleware. Clients restricted by a scope only
 * ever see their own calls (same rule as GET /requests).
 *
 * @module gateway/live
 */

import express from 'express';
import type { Request, RequestHandler } from 'express';
import type { MetricsCollector } from '../monitor/index.js';
import type { ServerRegistry } from '../registry/index.js';
import type { RequestMetric } from '../utils/types.js';
import { isRestricted, isServerInScope } from '../auth/scopes.js';
import type { AuthedRequest } from '../auth/middleware.js';

export interface LiveRouterOptions {
  /** Auth middleware (the API router's hot-swappable one). */
  authenticate: RequestHandler;
  /** Interval between `snapshot` events (default 2000 ms). */
  snapshotIntervalMs?: number;
  /** Interval between keep-alive comments (default 15000 ms). */
  heartbeatMs?: number;
  /** Maximum concurrent /events streams (default 50); more get 503. */
  maxStreams?: number;
}

export interface StatsBucket {
  /** Bucket start, epoch ms. */
  t: number;
  count: number;
  errors: number;
  p50: number;
  p95: number;
}

export interface LiveStats {
  windowMs: number;
  bucketMs: number;
  now: number;
  summary: {
    total: number;
    errors: number;
    errorRate: number;
    requestsPerMinute: number;
    p50: number;
    p95: number;
    p99: number;
  };
  series: StatsBucket[];
  tools: Array<{ name: string; serverId: string; count: number; errors: number; p95: number }>;
  servers: Array<{ id: string; count: number; errors: number; p95: number }>;
  clients: Array<{ id: string; count: number; errors: number; lastSeen: number }>;
}

/** Nearest-rank percentile of an ascending array. */
export function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

/** Compute live stats over `records` (any order) for the window ending at `now`. */
export function computeLiveStats(records: readonly RequestMetric[], windowMs: number, bucketMs: number, now = Date.now()): LiveStats {
  const nBuckets = Math.max(1, Math.ceil(windowMs / bucketMs));
  // Align buckets so the last one ends at the current bucket boundary.
  const end = Math.floor(now / bucketMs) * bucketMs + bucketMs;
  const start = end - nBuckets * bucketMs;
  const bucketLat: number[][] = Array.from({ length: nBuckets }, () => []);
  const bucketErr = new Array<number>(nBuckets).fill(0);
  const all: number[] = [];
  let errors = 0;
  type Acc = { count: number; errors: number; lat: number[] };
  const tools = new Map<string, Acc & { name: string; serverId: string }>();
  const servers = new Map<string, Acc>();
  const clients = new Map<string, { count: number; errors: number; lastSeen: number }>();
  const cutoff = now - windowMs;

  for (const m of records) {
    const ts = m.timestamp.getTime();
    if (ts < cutoff || ts > now) continue;
    const i = Math.min(nBuckets - 1, Math.max(0, Math.floor((ts - start) / bucketMs)));
    bucketLat[i]!.push(m.durationMs);
    all.push(m.durationMs);
    if (!m.success) {
      bucketErr[i]!++;
      errors++;
    }
    const tk = `${m.serverId}\u0000${m.toolName}`;
    const t = tools.get(tk) ?? { name: m.toolName, serverId: m.serverId, count: 0, errors: 0, lat: [] };
    t.count++;
    if (!m.success) t.errors++;
    t.lat.push(m.durationMs);
    tools.set(tk, t);
    const s = servers.get(m.serverId) ?? { count: 0, errors: 0, lat: [] };
    s.count++;
    if (!m.success) s.errors++;
    s.lat.push(m.durationMs);
    servers.set(m.serverId, s);
    const cid = m.clientId ?? 'anonymous';
    const c = clients.get(cid) ?? { count: 0, errors: 0, lastSeen: 0 };
    c.count++;
    if (!m.success) c.errors++;
    c.lastSeen = Math.max(c.lastSeen, ts);
    clients.set(cid, c);
  }

  const asc = (a: number, b: number) => a - b;
  all.sort(asc);
  const p95Of = (lat: number[]) => pct(lat.sort(asc), 0.95);
  const byCount = <T extends { count: number }>(a: T, b: T) => b.count - a.count;

  return {
    windowMs,
    bucketMs,
    now,
    summary: {
      total: all.length,
      errors,
      errorRate: all.length ? errors / all.length : 0,
      requestsPerMinute: all.length / (windowMs / 60_000),
      p50: pct(all, 0.5),
      p95: pct(all, 0.95),
      p99: pct(all, 0.99),
    },
    series: bucketLat.map((lat, i) => {
      lat.sort(asc);
      return { t: start + i * bucketMs, count: lat.length, errors: bucketErr[i]!, p50: pct(lat, 0.5), p95: pct(lat, 0.95) };
    }),
    tools: [...tools.values()]
      .map((t) => ({ name: t.name, serverId: t.serverId, count: t.count, errors: t.errors, p95: p95Of(t.lat) }))
      .sort(byCount)
      .slice(0, 10),
    servers: [...servers.entries()]
      .map(([id, s]) => ({ id, count: s.count, errors: s.errors, p95: p95Of(s.lat) }))
      .sort(byCount),
    clients: [...clients.entries()]
      .map(([id, c]) => ({ id, ...c }))
      .sort(byCount)
      .slice(0, 20),
  };
}

function intParam(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'string' ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Restricted clients only see their own calls. */
function visibilityFilter(req: Request): (m: RequestMetric) => boolean {
  const r = req as AuthedRequest;
  if (!isRestricted(r.scope)) return () => true;
  const own = r.clientId ?? '';
  return (m) => m.clientId === own;
}

/** Public shape of a request record on the wire. */
function wire(m: RequestMetric) {
  return { ...m, timestamp: m.timestamp.toISOString() };
}

export type LiveRouter = express.Router & {
  /** End every open /events stream (gateway shutdown). */
  close(): void;
  /** Number of open /events streams. */
  streams(): number;
};

export function createLiveRouter(
  metrics: MetricsCollector,
  registry: ServerRegistry,
  options: LiveRouterOptions,
): LiveRouter {
  const router = express.Router() as LiveRouter;
  const snapshotMs = options.snapshotIntervalMs ?? 2_000;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const maxStreams = options.maxStreams ?? 50;
  const open = new Set<() => void>();

  const statsFor = (req: Request, windowMs: number, bucketMs: number) => {
    const visible = visibilityFilter(req);
    const cutoff = Date.now() - windowMs;
    // Newest first: stop scanning once records are older than the window.
    const records = metrics.getRecentWhere(Number.POSITIVE_INFINITY, (m) => m.timestamp.getTime() >= cutoff && visible(m));
    return computeLiveStats(records, windowMs, bucketMs);
  };

  const parseWindow = (req: Request) => {
    const windowMs = intParam(req.query.window, 15 * 60_000, 10_000, 24 * 3_600_000);
    // At most 360 buckets so a response stays small.
    const minBucket = Math.max(1_000, Math.ceil(windowMs / 360));
    const bucketMs = intParam(req.query.bucket, Math.max(minBucket, Math.round(windowMs / 60)), minBucket, windowMs);
    return { windowMs, bucketMs };
  };

  router.get('/stats', options.authenticate, (req, res) => {
    const { windowMs, bucketMs } = parseWindow(req);
    res.set('Cache-Control', 'no-store');
    res.json(statsFor(req, windowMs, bucketMs));
  });

  router.get('/events', options.authenticate, (req, res) => {
    if (open.size >= maxStreams) {
      res.status(503).json({ error: 'Service Unavailable', message: 'Too many open event streams' });
      return;
    }
    const { windowMs, bucketMs } = parseWindow(req);
    const visible = visibilityFilter(req);
    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(`retry: 3000\n\n`);

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const scope = (req as AuthedRequest).scope;
    const snapshot = () => {
      const stats = statsFor(req, windowMs, bucketMs);
      send('snapshot', {
        now: stats.now,
        health: registry.getAllHealth().filter((h) => isServerInScope(scope, h.serverId)),
        summary: stats.summary,
        last: stats.series[stats.series.length - 1],
      });
    };
    const onMetric = (m: RequestMetric) => {
      if (visible(m)) send('request', wire(m));
    };

    metrics.on('metric', onMetric);
    snapshot();
    const snapTimer = setInterval(snapshot, snapshotMs);
    const beatTimer = setInterval(() => res.write(`: ping\n\n`), heartbeatMs);
    snapTimer.unref();
    beatTimer.unref();

    const cleanup = () => {
      if (!open.has(cleanup)) return;
      open.delete(cleanup);
      clearInterval(snapTimer);
      clearInterval(beatTimer);
      metrics.off('metric', onMetric);
      if (!res.writableEnded) res.end();
    };
    open.add(cleanup);
    req.on('close', cleanup);
    res.on('error', cleanup);
  });

  router.close = () => {
    for (const c of [...open]) c();
  };
  router.streams = () => open.size;
  return router;
}
