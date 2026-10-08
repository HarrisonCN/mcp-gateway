/**
 * Edge control plane (4.8): lets edge gateways (`@winstonsayno/mcp-gateway/edge` with `sync`) pull their
 * configuration from this Node gateway and push usage back. Operators only (unscoped keys).
 *
 * - `GET  /admin/edge/snapshot[?secrets=true]` — edge config derived from the running config: enabled
 *   `streamable-http` servers (id, name, url, tool filters, timeout, known tool catalog), unscoped API keys as
 *   `sha256:` digests, tool naming and CORS origins. `ETag` / `If-None-Match` → 304. Upstream `headers` are
 *   included only with `?secrets=true`, which additionally requires `admin.configApi: true`.
 * - `POST /admin/edge/sync` — `{ edgeId, events: EdgeEvent[], queued }`: events land in the metrics / request
 *   log (client `edge:<edgeId>`); the edge is tracked in the node list.
 * - `GET  /admin/edge/nodes` — known edges: last seen, snapshot ETag served, event / error / queued counts.
 *
 * @module gateway/edge-control
 */

import { createHash } from 'node:crypto';
import express, { type Request, type RequestHandler } from 'express';
import type { GatewayConfig, ToolInfo, RequestMetric } from '../utils/types.js';
import type { EdgeSnapshot, EdgeEvent } from '../edge/sync.js';
import { VERSION } from '../utils/version.js';

export interface EdgeControlDeps {
  config: () => GatewayConfig;
  tools: () => ToolInfo[];
  record: (m: Omit<RequestMetric, 'id' | 'timestamp'>) => void;
  authenticate: RequestHandler;
  isOperator: (req: Request) => boolean;
}

export interface EdgeNode {
  edgeId: string;
  firstSeen: string;
  lastSeen: string;
  lastSync?: string;
  snapshotEtag?: string;
  events: number;
  errors: number;
  queuedCalls: number;
  replayed: number;
}

const MAX_EVENTS_PER_SYNC = 5000;
const MAX_NODES = 1000;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Build the snapshot an edge gateway applies (pure; exported for tests and the CLI). */
export function buildEdgeSnapshot(cfg: GatewayConfig, tools: ToolInfo[], withSecrets = false): EdgeSnapshot {
  const servers = cfg.servers
    .filter((s) => s.transport === 'streamable-http' && s.enabled !== false && !!s.url)
    .map((s) => ({
      id: s.id,
      ...(s.name && s.name !== s.id ? { name: s.name } : {}),
      url: s.url!,
      ...(s.tools ? { tools: s.tools } : {}),
      ...(s.timeout ? { timeoutMs: s.timeout } : {}),
      ...(withSecrets && s.headers ? { headers: s.headers } : {}),
      catalog: tools
        .filter((t) => t.serverId === s.id)
        .map((t) => ({
          name: t.name,
          ...(t.title ? { title: t.title } : {}),
          ...(t.description ? { description: t.description } : {}),
          ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
          ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
          ...(t.annotations ? { annotations: t.annotations } : {}),
        })),
    }));
  const auth = cfg.auth;
  const now = Date.now();
  const apiKeys =
    auth?.strategy === 'api-key'
      ? (auth.apiKeys ?? [])
          .map((k) => (typeof k === 'string' ? { key: k } : k))
          .filter((k) => !('disabled' in k && k.disabled))
          .filter((k) => !('expiresAt' in k && k.expiresAt && Date.parse(k.expiresAt) <= now))
          // The edge has no per-key scopes: only unscoped keys are handed out.
          .filter((k) => !('servers' in k && k.servers?.length) && !('tools' in k && k.tools?.length))
          .map((k) => (k.key.startsWith('sha256:') ? k.key.toLowerCase() : `sha256:${sha(k.key)}`))
      : undefined;
  const config: EdgeSnapshot['config'] = {
    servers,
    ...(apiKeys ? { apiKeys } : {}),
    ...(cfg.mcp?.toolNaming === 'prefix' || cfg.mcp?.toolNaming === 'auto' ? { toolNaming: cfg.mcp.toolNaming } : {}),
    ...(cfg.cors?.origins ? { corsOrigins: cfg.cors.origins } : {}),
  };
  const etag = sha(JSON.stringify({ v: VERSION, s: withSecrets, config })).slice(0, 32);
  return { version: VERSION, generatedAt: new Date().toISOString(), etag, config };
}

function isEvent(e: unknown): e is EdgeEvent {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return typeof o.server === 'string' && typeof o.tool === 'string' && typeof o.ok === 'boolean' && typeof o.durationMs === 'number';
}

export function createEdgeControlRouter(deps: EdgeControlDeps): express.Router & { nodes: Map<string, EdgeNode> } {
  const router = express.Router() as express.Router & { nodes: Map<string, EdgeNode> };
  const nodes = new Map<string, EdgeNode>();
  router.nodes = nodes;
  const operator: RequestHandler = (req, res, next) =>
    deps.isOperator(req) ? next() : void res.status(403).json({ error: 'Forbidden', message: 'The edge control plane is for operators (unscoped keys)' });
  const guard = [deps.authenticate, operator];

  const touch = (edgeId: string): EdgeNode => {
    const now = new Date().toISOString();
    let n = nodes.get(edgeId);
    if (!n) {
      if (nodes.size >= MAX_NODES) {
        const oldest = [...nodes.values()].sort((a, b) => a.lastSeen.localeCompare(b.lastSeen))[0];
        if (oldest) nodes.delete(oldest.edgeId);
      }
      n = { edgeId, firstSeen: now, lastSeen: now, events: 0, errors: 0, queuedCalls: 0, replayed: 0 };
      nodes.set(edgeId, n);
    }
    n.lastSeen = now;
    return n;
  };
  const validId = (v: unknown): v is string => typeof v === 'string' && /^[\w.:-]{1,128}$/.test(v);

  router.get('/admin/edge/snapshot', ...guard, (req, res) => {
    const secrets = req.query.secrets === 'true' || req.query.secrets === '1';
    if (secrets && deps.config().admin?.configApi !== true) {
      return void res.status(403).json({ error: 'Forbidden', message: 'Snapshots with upstream headers need admin.configApi: true' });
    }
    const snap = buildEdgeSnapshot(deps.config(), deps.tools(), secrets);
    const edgeId = req.get('x-edge-id');
    if (validId(edgeId)) touch(edgeId).snapshotEtag = snap.etag;
    res.setHeader('ETag', `"${snap.etag}"`);
    res.setHeader('Cache-Control', 'no-store');
    const inm = req.get('if-none-match');
    if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === `"${snap.etag}"`)) return void res.status(304).end();
    res.json(snap);
  });

  router.post('/admin/edge/sync', ...guard, (req, res) => {
    const b = req.body as { edgeId?: unknown; events?: unknown; queued?: unknown } | undefined;
    if (!b || !validId(b.edgeId)) return void res.status(400).json({ error: 'Bad Request', message: '"edgeId" is required ([A-Za-z0-9_.:-], ≤ 128 chars)' });
    if (b.events !== undefined && !Array.isArray(b.events)) return void res.status(400).json({ error: 'Bad Request', message: '"events" must be an array' });
    const events = ((b.events as unknown[] | undefined) ?? []).slice(0, MAX_EVENTS_PER_SYNC).filter(isEvent);
    const n = touch(b.edgeId);
    n.lastSync = n.lastSeen;
    n.queuedCalls = typeof b.queued === 'number' && b.queued >= 0 ? Math.floor(b.queued) : 0;
    for (const e of events) {
      n.events++;
      if (!e.ok) n.errors++;
      if (e.mode === 'replayed') n.replayed++;
      deps.record({
        serverId: e.server.slice(0, 200),
        toolName: e.tool.slice(0, 200),
        durationMs: Math.max(0, Math.min(e.durationMs, 3_600_000)),
        success: e.ok,
        ...(e.error ? { errorMessage: String(e.error).slice(0, 500) } : {}),
        clientId: `edge:${b.edgeId}`,
      });
    }
    res.json({ accepted: events.length, dropped: ((b.events as unknown[] | undefined) ?? []).length - events.length });
  });

  router.get('/admin/edge/nodes', ...guard, (_req, res) => {
    res.json({ nodes: [...nodes.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)) });
  });

  return router;
}
