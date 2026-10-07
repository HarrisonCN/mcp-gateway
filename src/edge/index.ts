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
    if (!res.ok) throw new RpcError(-32000, `Upstream "${this.cfg.id}" HTTP ${res.status}`);
    const reply = await readRpcReply(res, id);
    if (isObj(reply.error)) throw new RpcError(Number(reply.error.code ?? -32603), String(reply.error.message ?? 'error'), reply.error.data);
    return reply.result;
  }

  async tools(maxAgeMs = 30_000): Promise<UpstreamTool[]> {
    if (this.toolsCache && Date.now() - this.toolsCache.at < maxAgeMs) return this.toolsCache.tools;
    const all: UpstreamTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = (await this.request('tools/list', cursor ? { cursor } : undefined)) as { tools?: UpstreamTool[]; nextCursor?: string };
      all.push(...(r?.tools ?? []));
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    const tools = all.filter((t) => allowed(t.name, this.cfg.tools));
    this.toolsCache = { at: Date.now(), tools };
    return tools;
  }
}

interface IndexedTool {
  exposed: string;
  serverId: string;
  tool: UpstreamTool;
}

export interface EdgeGateway {
  fetch(request: Request): Promise<Response>;
  upstreams: ReadonlyMap<string, EdgeUpstream>;
}

/** Build the edge gateway's Fetch handler. */
export function createEdgeGateway(config: EdgeConfig): EdgeGateway {
  const fetchImpl = config.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const upstreams = new Map(config.servers.map((s) => [s.id, new EdgeUpstream(s, fetchImpl)]));
  const mcpPath = config.mcpPath ?? '/mcp';
  const keys = (config.apiKeys ?? []).filter(Boolean);

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
      exposed: config.toolNaming === 'prefix' || (count.get(t.tool.name) ?? 0) > 1 ? `${t.serverId}__${t.tool.name}` : t.tool.name,
    }));
    return { list, errors };
  }

  async function callTool(name: string, args: Json, server?: string): Promise<{ serverId: string; result: unknown }> {
    const { list } = await index();
    const hit = server ? list.find((t) => t.serverId === server && t.tool.name === name) : list.find((t) => t.exposed === name) ?? list.find((t) => t.tool.name === name);
    if (!hit) throw new RpcError(-32602, `Unknown tool: ${name}`);
    const result = await upstreams.get(hit.serverId)!.request('tools/call', { name: hit.tool.name, arguments: args });
    return { serverId: hit.serverId, result };
  }

  function cors(req: Request, res: Response): Response {
    const origin = req.headers.get('origin');
    const allowedOrigins = config.corsOrigins ?? [];
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
        return json(200, { result: r.result, server: r.serverId, tool: b.tool, durationMs: Date.now() - started });
      } catch (err) {
        const e = err instanceof RpcError ? err : new RpcError(-32603, err instanceof Error ? err.message : String(err));
        return json(e.code === -32602 ? 404 : 502, { error: e.code === -32602 ? 'Not Found' : 'Bad Gateway', message: e.message, code: e.code });
      }
    }
    return json(404, { error: 'Not Found' });
  }

  return {
    upstreams,
    async fetch(request: Request): Promise<Response> {
      return cors(request, await route(request));
    },
  };
}
