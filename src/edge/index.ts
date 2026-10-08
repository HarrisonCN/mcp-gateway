/**
 * Edge gateway: a dependency-free, Fetch-API implementation of the gateway's
 * HTTP surface for runtimes without Node's `http` / `child_process` —
 * Cloudflare Workers, Deno, Bun (and Node via `serveNode`).
 *
 * Scope: remote upstreams over Streamable HTTP only (no stdio / WebSocket),
 * API-key auth (plain or `sha256:` keys), per-server tool filters, the `/mcp`
 * endpoint (stateless JSON responses: initialize, ping, tools/list,
 * tools/call) and the REST subset `GET /api/v1/health`, `GET /api/v1/tools`,
 * `POST /api/v1/tools/call`. Everything else stays in the full Node gateway.
 *
 * This module must not import Node built-ins.
 *
 * @module edge
 */

import { globToRegExp } from '../utils/tool-filter.js';
import type { ToolFilterConfig } from '../utils/types.js';
import { EdgeSync, type EdgeCatalogTool, type EdgeEvent, type EdgeSnapshot, type EdgeSyncOptions, type PullResult } from './sync.js';

export const EDGE_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export interface EdgeServerConfig {
  id: string;
  name?: string;
  /** Streamable HTTP endpoint of the upstream MCP server. */
  url: string;
  headers?: Record<string, string>;
  tools?: ToolFilterConfig;
  timeoutMs?: number;
  /** Known tools (from a control-plane snapshot): served by `tools/list` while the upstream is unreachable. */
  catalog?: EdgeCatalogTool[];
}

export interface EdgeOfflineConfig {
  /**
   * Tools (globs on the exposed name, or `<server>__<tool>`) whose calls are queued while their upstream is
   * unreachable and replayed on the next sync. Needs `sync`. Only for idempotent / fire-and-forget tools.
   */
  queueTools?: string[];
}

export interface EdgeConfig {
  servers: EdgeServerConfig[];
  /** Accepted API keys (plain, or `sha256:<hex>`). Empty / absent = no auth. */
  apiKeys?: string[];
  /** Downstream MCP path (default `/mcp`). */
  mcpPath?: string;
  /** `prefix` always names tools `<server>__<tool>`; `auto` (default) only on collisions. */
  toolNaming?: 'auto' | 'prefix';
  /** CORS allowed origins (default none). */
  corsOrigins?: string[];
  /** fetch implementation (tests, custom agents). */
  fetch?: typeof fetch;
  name?: string;
  version?: string;
  /** Control-plane sync (4.8): config snapshots, usage outbox, offline queue. */
  sync?: EdgeSync | EdgeSyncOptions;
  /** Minimum time between background syncs triggered by requests (default 60 s; 0 = only explicit `sync()`). */
  syncIntervalMs?: number;
  offline?: EdgeOfflineConfig;
}

interface UpstreamTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  title?: string;
  annotations?: unknown;
  outputSchema?: unknown;
}

interface Session {
  id?: string;
  version: string;
  ready?: Promise<void>;
}

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function allowed(name: string, f?: ToolFilterConfig): boolean {
  if (!f) return true;
  if (f.allow && !f.allow.some((p) => globToRegExp(p).test(name))) return false;
  if (f.deny && f.deny.some((p) => globToRegExp(p).test(name))) return false;
  return true;
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** Parse a JSON or SSE MCP reply and return the JSON-RPC message with `id`. */
export async function readRpcReply(res: Response, id: number | string): Promise<Json> {
  const type = res.headers.get('content-type') ?? '';
  const text = await res.text();
  if (type.includes('text/event-stream')) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) continue;
      try {
        const msg = JSON.parse(data) as unknown;
        const list = Array.isArray(msg) ? msg : [msg];
        const hit = list.find((m) => isObj(m) && m.id === id && ('result' in m || 'error' in m));
        if (hit) return hit as Json;
      } catch {
        /* keep scanning */
      }
    }
    throw new Error('No response in event stream');
  }
  const msg = JSON.parse(text) as unknown;
  const list = Array.isArray(msg) ? msg : [msg];
  const hit = list.find((m) => isObj(m) && m.id === id);
  if (!hit) throw new Error('No matching JSON-RPC response');
  return hit as Json;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
    /** The upstream could not be reached or answered 5xx (worth queueing / retrying). */
    readonly transient = false,
  ) {
    super(message);
  }
}

/** Minimal Streamable HTTP MCP client for one upstream. */
export class EdgeUpstream {
  private session?: Session;
  private seq = 0;
  private toolsCache?: { at: number; tools: UpstreamTool[] };

  constructor(
    readonly cfg: EdgeServerConfig,
    private readonly fetchImpl: typeof fetch,
  ) {}

  private async post(body: Json, sessionId?: string, version = EDGE_PROTOCOL_VERSION): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': version,
      ...(this.cfg.headers ?? {}),
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    return this.fetchImpl(this.cfg.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
    });
  }

  private async init(): Promise<Session> {
    if (this.session?.ready) {
      await this.session.ready;
      return this.session;
    }
    const s: Session = { version: EDGE_PROTOCOL_VERSION };
    this.session = s;
    s.ready = (async () => {
      const id = ++this.seq;
      const res = await this.post({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: EDGE_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'mcp-gateway-edge', version: '1' } } });
      if (!res.ok) throw new Error(`initialize failed: HTTP ${res.status}`);
      s.id = res.headers.get('mcp-session-id') ?? undefined;
      const reply = await readRpcReply(res, id);
      if (reply.error) throw new Error(`initialize failed: ${JSON.stringify(reply.error)}`);
      const v = isObj(reply.result) && typeof reply.result.protocolVersion === 'string' ? reply.result.protocolVersion : EDGE_PROTOCOL_VERSION;
      s.version = v;
      const n = await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, s.id, v);
      await n.body?.cancel().catch(() => undefined);
    })();
    try {
      await s.ready;
    } catch (err) {
      this.session = undefined;
      throw err;
    }
    return s;
  }

  async request(method: string, params?: Json, retried = false): Promise<unknown> {
    const s = await this.init();
    const id = ++this.seq;
    const res = await this.post({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }, s.id, s.version);
    if (res.status === 404 && s.id && !retried) {
      // Session expired upstream: start a new one once.
      this.session = undefined;
      return this.request(method, params, true);
    }
    if (!res.ok) throw new RpcError(-32000, `Upstream "${this.cfg.id}" HTTP ${res.status}`, undefined, res.status >= 500);
    const reply = await readRpcReply(res, id);
    if (isObj(reply.error)) throw new RpcError(Number(reply.error.code ?? -32603), String(reply.error.message ?? 'error'), reply.error.data);
    return reply.result;
  }

  /** True while the last tools/list failed and tools come from the stale cache or the snapshot catalog. */
  offline = false;

  async tools(maxAgeMs = 30_000): Promise<UpstreamTool[]> {
    if (this.toolsCache && Date.now() - this.toolsCache.at < maxAgeMs) return this.toolsCache.tools;
    const all: UpstreamTool[] = [];
    let cursor: string | undefined;
    try {
      for (let page = 0; page < 50; page++) {
        const r = (await this.request('tools/list', cursor ? { cursor } : undefined)) as { tools?: UpstreamTool[]; nextCursor?: string };
        all.push(...(r?.tools ?? []));
        cursor = r?.nextCursor;
        if (!cursor) break;
      }
    } catch (err) {
      // Offline: keep serving the last known tool list (or the control-plane catalog).
      const known = this.toolsCache?.tools ?? this.cfg.catalog?.filter((t) => allowed(t.name, this.cfg.tools));
      if (known?.length && isTransient(err)) {
        this.offline = true;
        return known;
      }
      throw err;
    }
    this.offline = false;
    const tools = all.filter((t) => allowed(t.name, this.cfg.tools));
    this.toolsCache = { at: Date.now(), tools };
    return tools;
  }

  /** Carry the session and tool cache over to a replacement with the same endpoint. */
  adopt(prev: EdgeUpstream): void {
    this.session = prev.session;
    this.seq = prev.seq;
    this.toolsCache = prev.toolsCache;
  }
}

/** Network failure, timeout, or upstream 5xx: the call may succeed later. */
function isTransient(err: unknown): boolean {
  return err instanceof RpcError ? err.transient : true;
}

interface IndexedTool {
  exposed: string;
  serverId: string;
  tool: UpstreamTool;
}

export interface EdgeSyncReport {
  config: PullResult['status'] | 'disabled';
  etag?: string;
  replayed: number;
  failed: number;
  pending: number;
  pushed: number;
  offline: boolean;
  errors: string[];
}

export interface EdgeGateway {
  /** Fetch handler; `waitUntil` (Workers `ctx.waitUntil`) keeps background syncs alive after the response. */
  fetch(request: Request, waitUntil?: (p: Promise<unknown>) => void): Promise<Response>;
  upstreams: ReadonlyMap<string, EdgeUpstream>;
  /** Pull config, replay queued calls, push usage events (no-op report when `sync` is not configured). */
  sync(): Promise<EdgeSyncReport>;
  /** The sync client, when configured. */
  readonly syncClient?: EdgeSync;
}

/** Build the edge gateway's Fetch handler. */
export function createEdgeGateway(config: EdgeConfig): EdgeGateway {
  const fetchImpl = config.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const upstreams = new Map(config.servers.map((s) => [s.id, new EdgeUpstream(s, fetchImpl)]));
  const mcpPath = config.mcpPath ?? '/mcp';
  let keys = (config.apiKeys ?? []).filter(Boolean);
  let toolNaming = config.toolNaming;
  let corsOrigins = config.corsOrigins;
  const sync = config.sync instanceof EdgeSync ? config.sync : config.sync ? new EdgeSync({ fetch: config.fetch, ...config.sync }) : undefined;
  const queueRes = (config.offline?.queueTools ?? []).map((g) => globToRegExp(g));
  const syncInterval = config.syncIntervalMs ?? 60_000;
  let appliedEtag: string | undefined;
  let lastSync = 0;
  let lastReport: EdgeSyncReport | undefined;
  let syncing: Promise<EdgeSyncReport> | undefined;
  let booted: Promise<void> | undefined;

  /** Merge a control-plane snapshot with the local config (local servers / headers / settings win). */
  function applySnapshot(snap: EdgeSnapshot): void {
    if (snap.etag === appliedEtag) return;
    appliedEtag = snap.etag;
    const local = new Map(config.servers.map((s) => [s.id, s]));
    const merged: EdgeServerConfig[] = snap.config.servers.map((s) => {
      const l = local.get(s.id);
      return l ? { ...s, ...l, headers: { ...(s.headers ?? {}), ...(l.headers ?? {}) }, catalog: l.catalog ?? s.catalog } : s;
    });
    for (const l of config.servers) if (!merged.some((m) => m.id === l.id)) merged.push(l);
    const next = new Map<string, EdgeUpstream>();
    for (const s of merged) {
      const u = new EdgeUpstream(s, fetchImpl);
      const prev = upstreams.get(s.id);
      if (prev && prev.cfg.url === s.url && JSON.stringify(prev.cfg.headers ?? {}) === JSON.stringify(s.headers ?? {})) u.adopt(prev);
      next.set(s.id, u);
    }
    upstreams.clear();
    for (const [k, v] of next) upstreams.set(k, v);
    keys = [...new Set([...(config.apiKeys ?? []), ...(snap.config.apiKeys ?? [])].filter(Boolean))];
    toolNaming = config.toolNaming ?? snap.config.toolNaming;
    corsOrigins = config.corsOrigins ?? snap.config.corsOrigins;
  }

  /** First request: apply the cached snapshot, or pull one when nothing is cached. */
  function boot(): Promise<void> {
    if (!sync) return Promise.resolve();
    booted ??= (async () => {
      const cached = await sync.cached();
      if (cached) applySnapshot(cached);
      else await runSync();
    })().catch(() => undefined);
    return booted;
  }

  async function runSync(): Promise<EdgeSyncReport> {
    if (!sync) return { config: 'disabled', replayed: 0, failed: 0, pending: 0, pushed: 0, offline: false, errors: [] };
    syncing ??= (async () => {
      const errors: string[] = [];
      const pulled = await sync.pull();
      if (pulled.snapshot) applySnapshot(pulled.snapshot);
      if (pulled.error) errors.push(`pull: ${pulled.error}`);
      // Replay queued calls (oldest first); stop at the first upstream that is still unreachable.
      let replayed = 0;
      let failed = 0;
      const done: string[] = [];
      const retry: string[] = [];
      const down = new Set<string>();
      for (const q of await sync.queued()) {
        if (down.has(q.server)) {
          retry.push(q.id);
          continue;
        }
        const started = Date.now();
        try {
          const u = upstreams.get(q.server);
          if (!u) throw new RpcError(-32602, `Unknown server: ${q.server}`);
          await u.request('tools/call', { name: q.tool, arguments: q.arguments });
          replayed++;
          done.push(q.id);
          await sync.record({ ts: new Date().toISOString(), server: q.server, tool: q.tool, durationMs: Date.now() - started, ok: true, mode: 'replayed' });
        } catch (err) {
          if (isTransient(err)) {
            down.add(q.server);
            retry.push(q.id);
          } else {
            failed++;
            done.push(q.id);
            const msg = err instanceof Error ? err.message : String(err);
            await sync.record({ ts: new Date().toISOString(), server: q.server, tool: q.tool, durationMs: Date.now() - started, ok: false, mode: 'replayed', error: msg });
          }
        }
      }
      if (done.length || retry.length) await sync.settle(done, retry);
      const pushed = await sync.push();
      if (pushed.error) errors.push(`push: ${pushed.error}`);
      lastSync = Date.now();
      lastReport = {
        config: pulled.status,
        etag: pulled.snapshot?.etag,
        replayed,
        failed,
        pending: retry.length,
        pushed: pushed.sent,
        offline: pulled.status === 'offline' || pulled.status === 'none' || pushed.offline,
        errors,
      };
      return lastReport;
    })().finally(() => {
      syncing = undefined;
    });
    return syncing;
  }

  function record(ev: EdgeEvent): void {
    if (sync) void sync.record(ev).catch(() => undefined);
  }

  const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });

  async function authorized(req: Request): Promise<boolean> {
    if (keys.length === 0) return true;
    const h = req.headers.get('authorization') ?? '';
    const token = /^Bearer\s+(.+)$/i.exec(h)?.[1]?.trim() ?? req.headers.get('x-api-key') ?? '';
    if (!token) return false;
    const digest = keys.some((k) => k.startsWith('sha256:')) ? await sha256Hex(token) : '';
    return keys.some((k) => (k.startsWith('sha256:') ? safeEqual(`sha256:${digest}`, k.toLowerCase()) : safeEqual(token, k)));
  }

  async function index(): Promise<{ list: IndexedTool[]; errors: Record<string, string> }> {
    const errors: Record<string, string> = {};
    const per = await Promise.all(
      [...upstreams.values()].map(async (u) => {
        try {
          return (await u.tools()).map((tool) => ({ serverId: u.cfg.id, tool }));
        } catch (err) {
          errors[u.cfg.id] = err instanceof Error ? err.message : String(err);
          return [];
        }
      }),
    );
    const flat = per.flat();
    const count = new Map<string, number>();
    for (const t of flat) count.set(t.tool.name, (count.get(t.tool.name) ?? 0) + 1);
    const list = flat.map((t) => ({
      ...t,
      exposed: toolNaming === 'prefix' || (count.get(t.tool.name) ?? 0) > 1 ? `${t.serverId}__${t.tool.name}` : t.tool.name,
    }));
    return { list, errors };
  }

  async function callTool(name: string, args: Json, server?: string): Promise<{ serverId: string; result: unknown; queued?: string }> {
    const { list } = await index();
    const hit = server ? list.find((t) => t.serverId === server && t.tool.name === name) : list.find((t) => t.exposed === name) ?? list.find((t) => t.tool.name === name);
    if (!hit) throw new RpcError(-32602, `Unknown tool: ${name}`);
    const started = Date.now();
    const ev = { server: hit.serverId, tool: hit.tool.name };
    try {
      const result = await upstreams.get(hit.serverId)!.request('tools/call', { name: hit.tool.name, arguments: args });
      record({ ts: new Date().toISOString(), ...ev, durationMs: Date.now() - started, ok: true, mode: 'live' });
      return { serverId: hit.serverId, result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const queueable = sync && isTransient(err) && queueRes.some((re) => re.test(hit.exposed) || re.test(`${hit.serverId}__${hit.tool.name}`));
      if (queueable) {
        const q = await sync.enqueue({ server: hit.serverId, tool: hit.tool.name, arguments: args });
        record({ ts: new Date().toISOString(), ...ev, durationMs: Date.now() - started, ok: true, mode: 'queued', error: msg });
        return {
          serverId: hit.serverId,
          queued: q.id,
          result: {
            content: [{ type: 'text', text: `Upstream "${hit.serverId}" is unreachable; the call was queued for delivery (${q.id}).` }],
            structuredContent: { queued: true, id: q.id },
            _meta: { 'mcp-gateway/queued': q.id },
          },
        };
      }
      record({ ts: new Date().toISOString(), ...ev, durationMs: Date.now() - started, ok: false, mode: 'live', error: msg });
      throw err;
    }
  }

  function cors(req: Request, res: Response): Response {
    const origin = req.headers.get('origin');
    const allowedOrigins = corsOrigins ?? [];
    if (origin && (allowedOrigins.includes('*') || allowedOrigins.includes(origin))) {
      res.headers.set('access-control-allow-origin', allowedOrigins.includes('*') ? '*' : origin);
      res.headers.set('access-control-allow-headers', 'authorization, content-type, mcp-session-id, mcp-protocol-version, x-api-key');
      res.headers.set('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
      res.headers.set('access-control-expose-headers', 'mcp-session-id');
      res.headers.append('vary', 'Origin');
    }
    return res;
  }

  async function handleRpc(msg: Json): Promise<Json | undefined> {
    const id = msg.id as string | number | undefined;
    const method = typeof msg.method === 'string' ? msg.method : '';
    if (id === undefined) return undefined; // notification
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
    try {
      switch (method) {
        case 'initialize': {
          const asked = isObj(msg.params) && typeof msg.params.protocolVersion === 'string' ? msg.params.protocolVersion : EDGE_PROTOCOL_VERSION;
          return ok({
            protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : EDGE_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: config.name ?? 'mcp-gateway-edge', version: config.version ?? '1' },
          });
        }
        case 'ping':
          return ok({});
        case 'tools/list': {
          const { list } = await index();
          return ok({ tools: list.map((t) => ({ ...t.tool, name: t.exposed })) });
        }
        case 'tools/call': {
          const p = isObj(msg.params) ? msg.params : {};
          if (typeof p.name !== 'string') throw new RpcError(-32602, 'params.name is required');
          const r = await callTool(p.name, isObj(p.arguments) ? p.arguments : {});
          return ok(r.result);
        }
        default:
          throw new RpcError(-32601, `Method not supported by the edge gateway: ${method}`);
      }
    } catch (err) {
      const e = err instanceof RpcError ? err : new RpcError(-32603, err instanceof Error ? err.message : String(err));
      return { jsonrpc: '2.0', id, error: { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) } };
    }
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
    if (path === '/' && req.method === 'GET') return json(200, { name: 'mcp-gateway (edge)', mcp: mcpPath, servers: upstreams.size });
    if (path === '/api/v1/health/live') return json(200, { status: 'ok' });
    if (!(await authorized(req))) return json(401, { error: 'Unauthorized', message: 'missing or invalid API key' }, { 'www-authenticate': 'Bearer' });

    if (path === mcpPath) {
      if (req.method === 'GET') return json(405, { error: 'Method Not Allowed', message: 'The edge gateway does not offer a server-to-client stream' }, { allow: 'POST, DELETE' });
      if (req.method === 'DELETE') return new Response(null, { status: 204 });
      if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' }, { allow: 'POST, DELETE' });
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      const batch = Array.isArray(body);
      const msgs = (batch ? body : [body]) as unknown[];
      if (msgs.length === 0 || !msgs.every(isObj)) return json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      const out = (await Promise.all(msgs.map((m) => handleRpc(m as Json)))).filter((m): m is Json => m !== undefined);
      if (out.length === 0) return new Response(null, { status: 202 });
      return json(200, batch ? out : out[0]);
    }

    if (path === '/api/v1/health' && req.method === 'GET') {
      const { list, errors } = await index();
      const down = Object.keys(errors).length;
      return json(down === 0 ? 200 : 207, { status: down === 0 ? 'healthy' : down === upstreams.size ? 'unhealthy' : 'degraded', runtime: 'edge', servers: { total: upstreams.size, online: upstreams.size - down, offline: down, totalTools: list.length }, errors });
    }
    if (path === '/api/v1/tools' && req.method === 'GET') {
      const { list } = await index();
      const server = url.searchParams.get('server');
      const tools = list.filter((t) => !server || t.serverId === server).map((t) => ({ ...t.tool, serverId: t.serverId, serverName: upstreams.get(t.serverId)!.cfg.name ?? t.serverId, exposedName: t.exposed }));
      return json(200, { tools, total: tools.length });
    }
    if (path === '/api/v1/tools/call' && req.method === 'POST') {
      let b: unknown;
      try {
        b = await req.json();
      } catch {
        return json(400, { error: 'Bad Request', message: 'Invalid JSON body' });
      }
      if (!isObj(b) || typeof b.tool !== 'string') return json(400, { error: 'Bad Request', message: '"tool" is required' });
      const started = Date.now();
      try {
        const r = await callTool(b.tool, isObj(b.arguments) ? b.arguments : {}, typeof b.server === 'string' ? b.server : undefined);
        return json(r.queued ? 202 : 200, { result: r.result, server: r.serverId, tool: b.tool, durationMs: Date.now() - started, ...(r.queued ? { queued: r.queued } : {}) });
      } catch (err) {
        const e = err instanceof RpcError ? err : new RpcError(-32603, err instanceof Error ? err.message : String(err));
        return json(e.code === -32602 ? 404 : 502, { error: e.code === -32602 ? 'Not Found' : 'Bad Gateway', message: e.message, code: e.code });
      }
    }
    if (path === '/api/v1/edge/status' && req.method === 'GET') {
      return json(200, {
        sync: !!sync,
        edgeId: sync ? await sync.id() : undefined,
        etag: appliedEtag ?? null,
        lastSync: lastSync ? new Date(lastSync).toISOString() : null,
        lastReport: lastReport ?? null,
        outbox: sync ? (await sync.outbox()).length : 0,
        queued: sync ? (await sync.queued()).length : 0,
        offlineServers: [...upstreams.values()].filter((u) => u.offline).map((u) => u.cfg.id),
      });
    }
    if (path === '/api/v1/edge/sync' && req.method === 'POST') {
      return json(sync ? 200 : 404, sync ? await runSync() : { error: 'Not Found', message: 'sync is not configured' });
    }
    return json(404, { error: 'Not Found' });
  }

  return {
    upstreams,
    syncClient: sync,
    sync: runSync,
    async fetch(request: Request, waitUntil?: (p: Promise<unknown>) => void): Promise<Response> {
      await boot();
      if (sync && syncInterval > 0 && !syncing && Date.now() - lastSync >= syncInterval) {
        // Mark now so concurrent requests do not each start a sync.
        lastSync = Date.now();
        const p = runSync().catch(() => undefined);
        waitUntil?.(p);
      }
      return cors(request, await route(request));
    },
  };
}
