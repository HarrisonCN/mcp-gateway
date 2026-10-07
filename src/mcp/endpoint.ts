/**
 * Downstream MCP endpoint — MCP Streamable HTTP server (spec 2025-06-18,
 * 2025-03-26 accepted) that aggregates every upstream server behind one URL.
 *
 *  - `POST <path>`: JSON-RPC requests / notifications / responses (batches
 *    accepted for 2025-03-26 clients). Answers with `application/json`.
 *  - `GET <path>`: server→client SSE stream for notifications
 *    (`notifications/tools/list_changed`).
 *  - `DELETE <path>`: ends the session.
 *
 * Sessions (`Mcp-Session-Id`) are bound to the authenticated client: a
 * session id presented with another key is treated as unknown. Auth, rate
 * limiting (per `tools/call`), `maxConcurrency`, timeouts, metrics and the
 * request log are shared with the REST API.
 *
 * @module mcp/endpoint
 */

import express from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { randomUUID, createHash } from 'crypto';
import type { McpEndpointConfig } from '../utils/types.js';
import type { ServerRegistry } from '../registry/index.js';
import { ERR_CANCELLED, ERR_NOT_CONNECTED, ERR_TIMEOUT, type McpProxy } from '../proxy/index.js';
import type { MetricsCollector } from '../monitor/index.js';
import type { RateLimitDecision } from '../auth/ratelimit.js';
import { setRateLimitHeaders } from '../auth/ratelimit.js';
import { originAllowed } from '../middleware/cors.js';
import type { AuthedRequest } from '../auth/middleware.js';
import { filterToolsByScope, isToolInScope, type AccessScope } from '../auth/scopes.js';
import { logger } from '../utils/logger.js';
import { VERSION } from '../utils/version.js';
import { buildToolIndex, toMcpTool, type ToolIndex } from './naming.js';

/** Protocol versions the endpoint speaks, newest first. */
export const DOWNSTREAM_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'];
export const LATEST_PROTOCOL_VERSION = DOWNSTREAM_PROTOCOL_VERSIONS[0]!;

// JSON-RPC error codes
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;
/** Gateway rate limit hit on `tools/call` (`data.retryAfter` in seconds). */
export const ERR_RATE_LIMITED = -32029;
/** The caller's scopes do not allow this server / tool. */
export const ERR_FORBIDDEN = -32003;

export const DEFAULT_MCP_CONFIG: Required<Omit<McpEndpointConfig, 'allowedOrigins' | 'instructions'>> = {
  enabled: true,
  path: '/mcp',
  toolNaming: 'auto',
  pageSize: 500,
  sessionIdleTimeoutSeconds: 1800,
  maxSessions: 1000,
};

type JsonRpcId = string | number;
interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface DownstreamSession {
  id: string;
  clientId?: string;
  protocolVersion: string;
  clientInfo?: { name?: string; version?: string };
  createdAt: Date;
  lastSeen: number;
  /** Open GET streams, most recent last. */
  streams: Response[];
  /** In-flight requests by JSON-RPC id, for `notifications/cancelled`. */
  inflight: Map<string, AbortController>;
  /** Fingerprint of the tool list this session last saw. */
  toolsFingerprint?: string;
  eventSeq: number;
  /** Identity + scope of the client, refreshed on every request (used for notifications). */
  auth: ClientIdentity;
}

interface ClientIdentity {
  clientId?: string;
  scope?: AccessScope;
}

const identityOf = (req: Request): ClientIdentity => ({
  clientId: (req as AuthedRequest).clientId,
  scope: (req as AuthedRequest).scope,
});

export interface McpSessionSummary {
  id: string;
  clientId?: string;
  protocolVersion: string;
  clientInfo?: { name?: string; version?: string };
  createdAt: Date;
  lastSeen: Date;
  streams: number;
  inflight: number;
}

export interface McpEndpointDeps {
  registry: ServerRegistry;
  proxy: McpProxy;
  metrics: MetricsCollector;
  /** Auth middleware (sets `clientId`). */
  authenticate: RequestHandler;
  /** Count one rate-limited call for the request. */
  takeRateLimit: (req: Request) => RateLimitDecision | undefined;
  /** Gateway CORS origins (used when `mcp.allowedOrigins` is unset). */
  corsOrigins: () => readonly string[] | undefined;
  /** Whether request logging is on. */
  requestLog: () => boolean;
  /**
   * Current scope of a client id, used to re-evaluate open sessions after an
   * auth hot reload (`known: false` ends the session). Optional.
   */
  resolveClient?: (clientId: string | undefined) => { known: boolean; scope?: AccessScope } | undefined;
}

const SSE_KEEPALIVE_MS = 25_000;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const idKey = (id: JsonRpcId) => `${typeof id}:${String(id)}`;

function rpcError(id: JsonRpcId | null | undefined, error: JsonRpcError): JsonRpcMessage {
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: unknown): number | undefined {
  if (typeof cursor !== 'string') return undefined;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown };
    return typeof v.o === 'number' && Number.isSafeInteger(v.o) && v.o >= 0 ? v.o : undefined;
  } catch {
    return undefined;
  }
}

function acceptsEventStream(req: Request): boolean {
  const a = String(req.headers.accept ?? '');
  return a.includes('text/event-stream') || a.includes('*/*');
}

export class McpEndpoint {
  private cfg: McpEndpointConfig & typeof DEFAULT_MCP_CONFIG;
  private readonly sessions = new Map<string, DownstreamSession>();
  private sweepTimer?: NodeJS.Timeout;
  private keepaliveTimer?: NodeJS.Timeout;
  private notifyTimer?: NodeJS.Timeout;
  private closed = false;
  private readonly onRegistryChange = () => this.scheduleListChanged();

  constructor(
    config: McpEndpointConfig | undefined,
    private readonly deps: McpEndpointDeps,
  ) {
    this.cfg = { ...DEFAULT_MCP_CONFIG, ...stripUndefined(config ?? {}) };
    deps.registry.on('tools-updated', this.onRegistryChange);
    deps.registry.on('unregistered', this.onRegistryChange);
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref();
    this.keepaliveTimer = setInterval(() => this.keepalive(), SSE_KEEPALIVE_MS);
    this.keepaliveTimer.unref();
  }

  get path(): string {
    return this.cfg.path;
  }

  /** Apply hot-reloadable settings (everything except `enabled` and `path`). */
  update(config: McpEndpointConfig | undefined): void {
    const next = { ...DEFAULT_MCP_CONFIG, ...stripUndefined(config ?? {}) };
    if (next.enabled !== this.cfg.enabled || next.path !== this.cfg.path) {
      logger.warn('Config "mcp.enabled" / "mcp.path" changed — restart required for it to take effect');
    }
    const namingChanged = next.toolNaming !== this.cfg.toolNaming;
    this.cfg = { ...next, enabled: this.cfg.enabled, path: this.cfg.path };
    if (namingChanged) this.scheduleListChanged();
  }

  /** Express router serving POST / GET / DELETE on the configured path. */
  router(): express.Router {
    const r = express.Router();
    const json = express.json({ limit: '10mb', type: ['application/json', 'application/*+json'] });
    const path = this.cfg.path;
    const guard: RequestHandler = (req, res, next) => this.checkOrigin(req, res, next);
    r.post(path, guard, this.deps.authenticate, json, (req, res, next) => {
      this.handlePost(req, res).catch(next);
    });
    r.get(path, guard, this.deps.authenticate, (req, res) => this.handleGet(req, res));
    r.delete(path, guard, this.deps.authenticate, (req, res) => this.handleDelete(req, res));
    r.all(path, (_req, res) => {
      res.set('Allow', 'GET, POST, DELETE').status(405).json(rpcError(null, { code: JSONRPC_INVALID_REQUEST, message: 'Method not allowed' }));
    });
    // Malformed JSON bodies become JSON-RPC parse errors instead of REST error envelopes.
    r.use(path, (err: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (res.headersSent) return next(err);
      const status = (err as { status?: number })?.status;
      if (status === 413) {
        res.status(413).json(rpcError(null, { code: JSONRPC_INVALID_REQUEST, message: 'Payload too large' }));
        return;
      }
      if (status && status >= 400 && status < 500) {
        res.status(400).json(rpcError(null, { code: JSONRPC_PARSE_ERROR, message: 'Parse error' }));
        return;
      }
      logger.error(`MCP endpoint error: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json(rpcError(null, { code: JSONRPC_INTERNAL_ERROR, message: 'Internal error' }));
    });
    return r;
  }

  /** Close every stream and session (gateway shutdown). */
  close(): void {
    this.closed = true;
    clearInterval(this.sweepTimer);
    clearInterval(this.keepaliveTimer);
    clearTimeout(this.notifyTimer);
    this.deps.registry.off('tools-updated', this.onRegistryChange);
    this.deps.registry.off('unregistered', this.onRegistryChange);
    for (const s of [...this.sessions.values()]) this.endSession(s);
  }

  getSessions(): McpSessionSummary[] {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      clientId: s.clientId,
      protocolVersion: s.protocolVersion,
      clientInfo: s.clientInfo,
      createdAt: s.createdAt,
      lastSeen: new Date(s.lastSeen),
      streams: s.streams.length,
      inflight: s.inflight.size,
    }));
  }

  // ─── HTTP handlers ──────────────────────────────────────────────────────────

  private checkOrigin(req: Request, res: Response, next: NextFunction): void {
    // DNS-rebinding protection: browsers always send Origin on cross-origin
    // requests; non-browser clients usually send none.
    const origin = req.headers.origin;
    if (origin) {
      const allowed = this.cfg.allowedOrigins ?? this.deps.corsOrigins() ?? ['*'];
      if (!originAllowed(allowed, origin)) {
        res.status(403).json(rpcError(null, { code: JSONRPC_INVALID_REQUEST, message: 'Origin not allowed' }));
        return;
      }
    }
    next();
  }

  private async handlePost(req: Request, res: Response): Promise<void> {
    const body: unknown = req.body;
    const batch = Array.isArray(body);
    const messages: unknown[] = batch ? body : [body];
    if (body === undefined || (batch && messages.length === 0)) {
      res.status(400).json(rpcError(null, { code: JSONRPC_INVALID_REQUEST, message: 'Invalid Request: expected a JSON-RPC message' }));
      return;
    }
    for (const m of messages) {
      if (!isObject(m) || m.jsonrpc !== '2.0' || (m.method !== undefined && typeof m.method !== 'string')) {
        res.status(400).json(rpcError(isObject(m) ? (m.id as JsonRpcId) : null, { code: JSONRPC_INVALID_REQUEST, message: 'Invalid Request' }));
        return;
      }
    }
    const msgs = messages as JsonRpcMessage[];

    // ── initialize: creates the session ──
    const init = msgs.find((m) => m.method === 'initialize');
    if (init) {
      if (msgs.length > 1) {
        res.status(400).json(rpcError(init.id, { code: JSONRPC_INVALID_REQUEST, message: 'initialize must not be batched' }));
        return;
      }
      if (init.id === undefined || init.id === null) {
        res.status(400).json(rpcError(null, { code: JSONRPC_INVALID_REQUEST, message: 'initialize must be a request' }));
        return;
      }
      this.initialize(req, res, init);
      return;
    }

    const session = this.resolveSession(req, res);
    if (!session) return;

    const requests: JsonRpcMessage[] = [];
    for (const m of msgs) {
      if (m.method === undefined) continue; // a response to a server request: we send none
      if (m.id === undefined || m.id === null) this.handleNotification(session, m);
      else requests.push(m);
    }
    if (requests.length === 0) {
      res.status(202).end();
      return;
    }

    // Abort in-flight upstream calls if the client goes away.
    const controllers: AbortController[] = [];
    res.on('close', () => {
      if (!res.writableFinished) for (const c of controllers) c.abort();
    });

    const replies = await Promise.all(
      requests.map((m) => {
        const ctrl = new AbortController();
        controllers.push(ctrl);
        const key = idKey(m.id as JsonRpcId);
        session.inflight.set(key, ctrl);
        return this.handleRequest(session, req, res, m, ctrl.signal, !batch)
          .catch((err: unknown): JsonRpcMessage => {
            logger.error(`MCP ${m.method} failed: ${err instanceof Error ? err.message : String(err)}`);
            return rpcError(m.id, { code: JSONRPC_INTERNAL_ERROR, message: 'Internal error' });
          })
          .finally(() => {
            if (session.inflight.get(key) === ctrl) session.inflight.delete(key);
          });
      }),
    );
    if (res.headersSent || res.destroyed) return;
    res.status(200).json(batch ? replies : replies[0]);
  }

  private initialize(req: Request, res: Response, msg: JsonRpcMessage): void {
    const params = isObject(msg.params) ? msg.params : {};
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
    const protocolVersion =
      requested && DOWNSTREAM_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;

    if (this.sessions.size >= this.cfg.maxSessions && !this.evictOne()) {
      res.status(503).json(rpcError(msg.id, { code: JSONRPC_INTERNAL_ERROR, message: 'Too many sessions' }));
      return;
    }

    const clientInfo = isObject(params.clientInfo)
      ? {
          name: typeof params.clientInfo.name === 'string' ? params.clientInfo.name : undefined,
          version: typeof params.clientInfo.version === 'string' ? params.clientInfo.version : undefined,
        }
      : undefined;
    const session: DownstreamSession = {
      id: randomUUID(),
      clientId: (req as AuthedRequest).clientId,
      protocolVersion,
      clientInfo,
      createdAt: new Date(),
      lastSeen: Date.now(),
      streams: [],
      inflight: new Map(),
      eventSeq: 0,
      auth: identityOf(req),
    };
    session.toolsFingerprint = this.fingerprint(this.toolIndex(session.auth));
    this.sessions.set(session.id, session);
    logger.info(
      `MCP session ${session.id.slice(0, 8)} opened by ${clientInfo?.name ?? 'unknown client'}` +
        ` (protocol ${protocolVersion}${session.clientId ? `, ${session.clientId}` : ''})`,
    );

    const result: Record<string, unknown> = {
      protocolVersion,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'mcp-gateway', title: 'mcp-gateway', version: VERSION },
    };
    if (this.cfg.instructions) result.instructions = this.cfg.instructions;
    res.set('Mcp-Session-Id', session.id).status(200).json({ jsonrpc: '2.0', id: msg.id, result });
  }

  /** Validate session + protocol headers; on failure the response is already sent. */
  private resolveSession(req: Request, res: Response): DownstreamSession | undefined {
    const id = req.headers['mcp-session-id'];
    if (typeof id !== 'string' || id.length === 0) {
      res.status(400).json(rpcError(null, { code: JSONRPC_INVALID_REQUEST, message: 'Bad Request: Mcp-Session-Id header is required' }));
      return undefined;
    }
    const session = this.sessions.get(id);
    // A session presented by a different client is treated as unknown.
    if (!session || session.clientId !== (req as AuthedRequest).clientId) {
      res.status(404).json(rpcError(null, { code: -32001, message: 'Session not found' }));
      return undefined;
    }
    const version = req.headers['mcp-protocol-version'];
    if (typeof version === 'string' && !DOWNSTREAM_PROTOCOL_VERSIONS.includes(version)) {
      res.status(400).json(rpcError(null, { code: JSONRPC_INVALID_REQUEST, message: `Bad Request: unsupported MCP-Protocol-Version "${version}"` }));
      return undefined;
    }
    session.lastSeen = Date.now();
    session.auth = identityOf(req);
    return session;
  }

  private handleGet(req: Request, res: Response): void {
    if (!acceptsEventStream(req)) {
      res.status(406).json(rpcError(null, { code: JSONRPC_INVALID_REQUEST, message: 'Not Acceptable: client must accept text/event-stream' }));
      return;
    }
    const session = this.resolveSession(req, res);
    if (!session) return;
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Mcp-Session-Id': session.id,
    });
    res.flushHeaders();
    res.write(': connected\n\n');
    session.streams.push(res);
    req.socket.setTimeout(0);
    res.on('close', () => {
      session.streams = session.streams.filter((s) => s !== res);
      session.lastSeen = Date.now();
    });
  }

  private handleDelete(req: Request, res: Response): void {
    const session = this.resolveSession(req, res);
    if (!session) return;
    this.endSession(session);
    logger.info(`MCP session ${session.id.slice(0, 8)} closed by client`);
    res.status(204).end();
  }

  // ─── JSON-RPC ───────────────────────────────────────────────────────────────

  private handleNotification(session: DownstreamSession, msg: JsonRpcMessage): void {
    if (msg.method === 'notifications/cancelled') {
      const params = isObject(msg.params) ? msg.params : {};
      const rid = params.requestId;
      if (typeof rid === 'string' || typeof rid === 'number') {
        session.inflight.get(idKey(rid))?.abort();
      }
    }
    // notifications/initialized and others need no action.
  }

  private async handleRequest(
    session: DownstreamSession,
    req: Request,
    res: Response,
    msg: JsonRpcMessage,
    signal: AbortSignal,
    single: boolean,
  ): Promise<JsonRpcMessage> {
    const id = msg.id as JsonRpcId;
    const ok = (result: unknown): JsonRpcMessage => ({ jsonrpc: '2.0', id, result });
    switch (msg.method) {
      case 'ping':
        return ok({});
      case 'initialize':
        return rpcError(id, { code: JSONRPC_INVALID_REQUEST, message: 'Session already initialized' });
      case 'tools/list':
        return this.listTools(session, msg);
      case 'tools/call':
        return this.callTool(session, req, res, msg, signal, single);
      default:
        return rpcError(id, { code: JSONRPC_METHOD_NOT_FOUND, message: `Method not found: ${String(msg.method)}` });
    }
  }

  /** Tools visible to a client (server filters + its scope), with exposed names. */
  private toolIndex(identity: ClientIdentity): ToolIndex {
    const tools = filterToolsByScope(identity.scope, this.deps.registry.getAllTools());
    return buildToolIndex(tools, this.cfg.toolNaming);
  }

  private fingerprint(index: ToolIndex): string {
    const h = createHash('sha256');
    for (const t of index.list) h.update(JSON.stringify(toMcpTool(t))).update('\n');
    return h.digest('hex');
  }

  private listTools(session: DownstreamSession, msg: JsonRpcMessage): JsonRpcMessage {
    const params = isObject(msg.params) ? msg.params : {};
    let offset = 0;
    if (params.cursor !== undefined) {
      const o = decodeCursor(params.cursor);
      if (o === undefined) {
        return rpcError(msg.id, { code: JSONRPC_INVALID_PARAMS, message: 'Invalid cursor' });
      }
      offset = o;
    }
    const index = this.toolIndex(session.auth);
    if (offset === 0) session.toolsFingerprint = this.fingerprint(index);
    const page = index.list.slice(offset, offset + this.cfg.pageSize);
    const result: Record<string, unknown> = { tools: page.map(toMcpTool) };
    const next = offset + page.length;
    if (next < index.list.length) result.nextCursor = encodeCursor(next);
    return { jsonrpc: '2.0', id: msg.id as JsonRpcId, result };
  }

  private async callTool(
    session: DownstreamSession,
    req: Request,
    res: Response,
    msg: JsonRpcMessage,
    signal: AbortSignal,
    single: boolean,
  ): Promise<JsonRpcMessage> {
    const id = msg.id as JsonRpcId;
    const params = isObject(msg.params) ? msg.params : {};
    const name = params.name;
    const args = params.arguments ?? {};
    if (typeof name !== 'string' || name.length === 0) {
      return rpcError(id, { code: JSONRPC_INVALID_PARAMS, message: '"name" must be a non-empty string' });
    }
    if (!isObject(args)) {
      return rpcError(id, { code: JSONRPC_INVALID_PARAMS, message: '"arguments" must be an object' });
    }

    const tool = this.toolIndex(session.auth).byName.get(name);
    if (!tool) {
      // A tool that exists but is outside the client's scope is refused with
      // ERR_FORBIDDEN (the REST API's 403); it never appears in tools/list.
      if (session.auth.scope) {
        const unscoped = buildToolIndex(this.deps.registry.getAllTools(), this.cfg.toolNaming).byName.get(name);
        const anyServer = this.deps.registry.findTools(name);
        const target = unscoped ?? (anyServer.length > 0 ? anyServer[0] : undefined);
        if (target && !isToolInScope(session.auth.scope, target.serverId, target.name)) {
          return rpcError(id, { code: ERR_FORBIDDEN, message: `Forbidden: tool "${name}" is not allowed for this client` });
        }
      }
      return rpcError(id, { code: JSONRPC_INVALID_PARAMS, message: `Unknown tool: ${name}` });
    }
    const { serverId } = tool;
    if (!this.deps.registry.isToolExposed(serverId, tool.name)) {
      return rpcError(id, { code: JSONRPC_INVALID_PARAMS, message: `Unknown tool: ${name}` });
    }

    const decision = this.deps.takeRateLimit(req);
    if (decision) {
      if (single && !res.headersSent) setRateLimitHeaders(res, decision.limit, decision.remaining, decision.resetAt);
      if (!decision.allowed) {
        if (single && !res.headersSent) res.set('Retry-After', String(decision.retryAfter));
        return rpcError(id, {
          code: ERR_RATE_LIMITED,
          message: `Rate limit exceeded; retry after ${decision.retryAfter}s`,
          data: { retryAfter: decision.retryAfter },
        });
      }
    }

    const server = this.deps.registry.getServer(serverId);
    const toolError = (text: string): JsonRpcMessage => ({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text }], isError: true },
    });
    if (!server || !this.deps.proxy.isConnected(serverId)) {
      const status = this.deps.registry.getHealth(serverId)?.status;
      return toolError(`Server "${serverId}" is not connected${status ? ` (${status})` : ''}; try again later.`);
    }

    const result = await this.deps.proxy.callTool(serverId, tool.name, args, server.timeout, { signal });
    this.deps.metrics.record({
      serverId,
      toolName: tool.name,
      durationMs: result.durationMs,
      success: result.success,
      errorMessage: result.error?.message,
      clientId: (req as AuthedRequest).clientId,
      via: 'mcp',
    });
    if (this.deps.requestLog()) {
      logger.info(`${tool.name} → ${serverId} ${result.success ? 'ok' : 'failed'} ${result.durationMs}ms (mcp)`);
    }

    if (result.success) return { jsonrpc: '2.0', id, result: result.result ?? { content: [] } };
    const err = result.error ?? { code: JSONRPC_INTERNAL_ERROR, message: 'Unknown error' };
    switch (err.code) {
      case ERR_CANCELLED:
        return rpcError(id, { code: ERR_CANCELLED, message: 'Request cancelled' });
      case ERR_TIMEOUT:
        return toolError(`Tool "${name}" timed out after ${result.durationMs}ms`);
      case ERR_NOT_CONNECTED:
        return toolError(`Server "${serverId}" is not connected: ${err.message}`);
      default:
        // Upstream JSON-RPC error: forward unchanged.
        return rpcError(id, err);
    }
  }

  // ─── Notifications / housekeeping ───────────────────────────────────────────

  private scheduleListChanged(): void {
    if (this.closed) return;
    clearTimeout(this.notifyTimer);
    this.notifyTimer = setTimeout(() => this.sendListChanged(), 50);
    this.notifyTimer.unref();
  }

  /** Re-evaluate every session's scope (after an auth hot reload) and notify changes. */
  refreshClients(): void {
    this.scheduleListChanged();
  }

  private sendListChanged(): void {
    for (const s of [...this.sessions.values()]) {
      const current = this.deps.resolveClient?.(s.auth.clientId);
      if (current && !current.known) {
        // The key that opened this session is gone.
        logger.info(`MCP session ${s.id.slice(0, 8)} ended: its credentials were removed`);
        this.endSession(s);
        continue;
      }
      if (current) s.auth = { ...s.auth, scope: current.scope };
      if (s.streams.length === 0) continue;
      const fp = this.fingerprint(this.toolIndex(s.auth));
      if (fp === s.toolsFingerprint) continue;
      s.toolsFingerprint = fp;
      this.send(s, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    }
  }

  /** Send a message on the session's most recent stream. */
  private send(session: DownstreamSession, msg: JsonRpcMessage): boolean {
    const stream = session.streams[session.streams.length - 1];
    if (!stream) return false;
    session.eventSeq++;
    stream.write(`id: ${session.eventSeq}\nevent: message\ndata: ${JSON.stringify(msg)}\n\n`);
    return true;
  }

  private keepalive(): void {
    for (const s of this.sessions.values()) for (const st of s.streams) st.write(': keepalive\n\n');
  }

  private sweep(now = Date.now()): void {
    const ttl = this.cfg.sessionIdleTimeoutSeconds * 1000;
    for (const s of [...this.sessions.values()]) {
      if (s.streams.length === 0 && s.inflight.size === 0 && now - s.lastSeen > ttl) {
        logger.debug(`MCP session ${s.id.slice(0, 8)} expired`);
        this.endSession(s);
      }
    }
  }

  /** Evict the least recently used idle session; false if none is idle. */
  private evictOne(): boolean {
    let victim: DownstreamSession | undefined;
    for (const s of this.sessions.values()) {
      if (s.streams.length > 0 || s.inflight.size > 0) continue;
      if (!victim || s.lastSeen < victim.lastSeen) victim = s;
    }
    if (!victim) return false;
    this.endSession(victim);
    return true;
  }

  private endSession(session: DownstreamSession): void {
    this.sessions.delete(session.id);
    for (const c of session.inflight.values()) c.abort();
    session.inflight.clear();
    for (const st of session.streams) st.end();
    session.streams = [];
  }

  /** Test hook: expire idle sessions now. */
  sweepNow(now?: number): void {
    this.sweep(now);
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
