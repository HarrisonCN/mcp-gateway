/**
 * Downstream MCP endpoint — MCP Streamable HTTP server (spec 2025-06-18,
 * 2025-03-26 accepted) that aggregates every upstream server behind one URL.
 *
 *  - `POST <path>`: JSON-RPC requests / notifications / responses (batches
 *    accepted for 2025-03-26 clients). Answers with `application/json`.
 *  - `GET <path>`: server→client SSE stream for notifications
 *    (`notifications/{tools,resources,prompts}/list_changed`,
 *    `notifications/resources/updated`, `notifications/message`).
 *  - `DELETE <path>`: ends the session.
 *
 * A `tools/call` carrying `_meta.progressToken` from a client that accepts
 * `text/event-stream` is answered as an SSE stream as soon as the upstream
 * server reports progress: `notifications/progress` events, then the result.
 * `logging/setLevel`, `completion/complete` and `resources/subscribe` /
 * `unsubscribe` are routed to the owning upstream servers.
 *
 * Sessions (`Mcp-Session-Id`) are bound to the authenticated client: a
 * session id presented with another key is treated as unknown. Auth, rate
 * limiting (per `tools/call`), `maxConcurrency`, timeouts, metrics and the
 * request log are shared with the REST API.
 *
 * @module mcp/endpoint
 */

import { ToolInvoker } from '../gateway/invoker.js';
import type { StateStore } from '../state/store.js';
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
import { isLoopbackOrigin, isSameOrigin } from '../security/network.js';
import type { AuthedRequest } from '../auth/middleware.js';
import { filterToolsByScope, isToolInScope, type AccessScope } from '../auth/scopes.js';
import { logger } from '../utils/logger.js';
import { VERSION } from '../utils/version.js';
import { buildToolIndex, toMcpTool, type ToolIndex } from './naming.js';
import {
  buildPromptIndex,
  dedupeResources,
  routeResource,
  toMcpPrompt,
  toMcpResource,
  toMcpResourceTemplate,
} from './catalog.js';
import { isServerInScope } from '../auth/scopes.js';
import { matchesUriTemplate } from './catalog.js';

/** MCP logging levels (RFC 5424 severities), least severe first. */
export const LOG_LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'] as const;
export type McpLogLevel = (typeof LOG_LEVELS)[number];
const levelIndex = (l: unknown) => LOG_LEVELS.indexOf(l as McpLogLevel);

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
  eventBufferSize: 256,
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
  resourcesFingerprint?: string;
  promptsFingerprint?: string;
  eventSeq: number;
  /** Recently sent server-to-client events, for `Last-Event-ID` replay (resumability). */
  eventLog: Array<{ id: number; data: string }>;
  /** Identity + scope of the client, refreshed on every request (used for notifications). */
  auth: ClientIdentity;
  /** Minimum level of forwarded `notifications/message` (unset = none forwarded). */
  logLevel?: McpLogLevel;
  /** Resource subscriptions, as `<serverId>\0<uri>` keys. */
  subscriptions: Set<string>;
  /** Last time the shared-store record was refreshed (ms). */
  storeTouchedAt?: number;
}

interface StoredSession {
  clientId?: string;
  protocolVersion: string;
  clientInfo?: { name?: string; version?: string };
  createdAt: string;
}

/** Lazily opened SSE reply for one POST (used for progress notifications). */
interface ReplyStream {
  started: boolean;
  send(msg: JsonRpcMessage): void;
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
  takeRateLimit: (req: Request) => RateLimitDecision | undefined | Promise<RateLimitDecision | undefined>;
  /**
   * Shared store for session metadata (multi-instance mode): a session opened
   * on one gateway instance is accepted by every instance sharing the store.
   */
  sessionStore?: StateStore;
  /** Gateway CORS origins (used when `mcp.allowedOrigins` is unset). */
  corsOrigins: () => readonly string[] | undefined;
  /** Whether request logging is on. */
  requestLog: () => boolean;
  /**
   * Current scope of a client id, used to re-evaluate open sessions after an
   * auth hot reload (`known: false` ends the session). Optional.
   */
  resolveClient?: (clientId: string | undefined) => { known: boolean; scope?: AccessScope } | undefined;
  /**
   * DNS-rebinding protection: when true, browser requests are only accepted
   * from the same origin, loopback origins or explicitly listed origins
   * ("*" is ignored).
   */
  strictOrigins?: () => boolean;
  /** Maximum request body (bytes, default 10 MiB). */
  maxBodyBytes?: () => number;
  /** Maximum `arguments` size of tools/call / prompts/get / completion (bytes, 0 = no limit). */
  maxArgumentsBytes?: () => number;
  /** Upstream call pipeline shared with the REST API (created when absent). */
  invoker?: ToolInvoker;
}

const SSE_KEEPALIVE_MS = 25_000;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const idKey = (id: JsonRpcId) => `${typeof id}:${String(id)}`;

const traceparentOf = (req: Request): string | undefined =>
  typeof req.headers.traceparent === 'string' ? req.headers.traceparent : undefined;

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
  /** Upstream resource subscriptions: `<serverId>\0<uri>` → subscribed session ids. */
  private readonly upstreamSubs = new Map<string, Set<string>>();
  /** Last `logging/setLevel` sent to each upstream server. */
  private readonly upstreamLogLevel = new Map<string, McpLogLevel>();
  private readonly onUpstreamNotification = (serverId: string, msg: JsonRpcMessage) =>
    this.handleUpstreamNotification(serverId, msg);
  private readonly onUpstreamConnected = (serverId: string) => this.handleUpstreamConnected(serverId);
  private readonly onUpstreamDisconnected = (serverId: string) => this.upstreamLogLevel.delete(serverId);
  private jsonParser?: { limit: number; mw: RequestHandler };
  private readonly invoker: ToolInvoker;

  constructor(
    config: McpEndpointConfig | undefined,
    private readonly deps: McpEndpointDeps,
  ) {
    this.cfg = { ...DEFAULT_MCP_CONFIG, ...stripUndefined(config ?? {}) };
    this.invoker = deps.invoker ?? new ToolInvoker({ proxy: deps.proxy, metrics: deps.metrics, requestLog: () => deps.requestLog() });
    deps.registry.on('tools-updated', this.onRegistryChange);
    deps.registry.on('unregistered', this.onRegistryChange);
    deps.registry.on('catalog-updated', this.onRegistryChange);
    deps.proxy.on('notification', this.onUpstreamNotification);
    deps.proxy.on('connected', this.onUpstreamConnected);
    deps.proxy.on('disconnected', this.onUpstreamDisconnected);
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
    const json: RequestHandler = (req, res, next) => {
      const limit = this.deps.maxBodyBytes?.() ?? 10 * 1024 * 1024;
      if (this.jsonParser?.limit !== limit) {
        this.jsonParser = { limit, mw: express.json({ limit, type: ['application/json', 'application/*+json'] }) };
      }
      this.jsonParser.mw(req, res, next);
    };
    const path = this.cfg.path;
    const guard: RequestHandler = (req, res, next) => this.checkOrigin(req, res, next);
    r.post(path, guard, this.deps.authenticate, json, (req, res, next) => {
      this.handlePost(req, res).catch(next);
    });
    r.get(path, guard, this.deps.authenticate, (req, res, next) => {
      this.handleGet(req, res).catch(next);
    });
    r.delete(path, guard, this.deps.authenticate, (req, res, next) => {
      this.handleDelete(req, res).catch(next);
    });
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
    this.deps.registry.off('catalog-updated', this.onRegistryChange);
    this.deps.proxy.off('notification', this.onUpstreamNotification);
    this.deps.proxy.off('connected', this.onUpstreamConnected);
    this.deps.proxy.off('disconnected', this.onUpstreamDisconnected);
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
      const configured = this.cfg.allowedOrigins ?? this.deps.corsOrigins();
      const strict = this.deps.strictOrigins?.() === true;
      const ok = strict
        ? isSameOrigin(origin, req.headers.host) ||
          isLoopbackOrigin(origin) ||
          originAllowed((configured ?? []).filter((o) => o !== '*'), origin)
        : originAllowed(configured ?? ['*'], origin);
      if (!ok) {
        logger.warn(`Rejected /mcp request from Origin ${origin}`);
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

    const session = await this.resolveSession(req, res);
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

    // Single requests from clients accepting SSE may be upgraded to an SSE
    // reply (progress notifications before the result).
    const stream = !batch && acceptsEventStream(req) ? this.replyStream(res, session) : undefined;

    const replies = await Promise.all(
      requests.map((m) => {
        const ctrl = new AbortController();
        controllers.push(ctrl);
        const key = idKey(m.id as JsonRpcId);
        session.inflight.set(key, ctrl);
        return this.handleRequest(session, req, res, m, ctrl.signal, !batch, stream)
          .catch((err: unknown): JsonRpcMessage => {
            logger.error(`MCP ${m.method} failed: ${err instanceof Error ? err.message : String(err)}`);
            return rpcError(m.id, { code: JSONRPC_INTERNAL_ERROR, message: 'Internal error' });
          })
          .finally(() => {
            if (session.inflight.get(key) === ctrl) session.inflight.delete(key);
          });
      }),
    );
    if (stream?.started) {
      if (!res.writableEnded) {
        stream.send(replies[0]!);
        res.end();
      }
      return;
    }
    if (res.headersSent || res.destroyed) return;
    res.status(200).json(batch ? replies : replies[0]);
  }

  private replyStream(res: Response, session: DownstreamSession): ReplyStream {
    const stream: ReplyStream = {
      started: false,
      send: (msg) => {
        if (res.writableEnded || res.destroyed) return;
        if (!stream.started) {
          stream.started = true;
          res.status(200).set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Mcp-Session-Id': session.id,
          });
          res.flushHeaders();
        }
        res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
      },
    };
    return stream;
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
      eventLog: [],
      auth: identityOf(req),
      subscriptions: new Set(),
    };
    session.toolsFingerprint = this.fingerprint(this.toolIndex(session.auth));
    session.resourcesFingerprint = this.resourcesFingerprint(session.auth);
    session.promptsFingerprint = this.promptsFingerprint(session.auth);
    this.sessions.set(session.id, session);
    this.storeSession(session);
    logger.info(
      `MCP session ${session.id.slice(0, 8)} opened by ${clientInfo?.name ?? 'unknown client'}` +
        ` (protocol ${protocolVersion}${session.clientId ? `, ${session.clientId}` : ''})`,
    );

    const result: Record<string, unknown> = {
      protocolVersion,
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
        prompts: { listChanged: true },
        logging: {},
        completions: {},
      },
      serverInfo: { name: 'mcp-gateway', title: 'mcp-gateway', version: VERSION },
    };
    if (this.cfg.instructions) result.instructions = this.cfg.instructions;
    res.set('Mcp-Session-Id', session.id).status(200).json({ jsonrpc: '2.0', id: msg.id, result });
  }

  /** Validate session + protocol headers; on failure the response is already sent. */
  private sessionTtlMs(): number {
    return this.cfg.sessionIdleTimeoutSeconds * 1000;
  }

  /** Write / refresh the shared-store record of a session (multi-instance mode). */
  private storeSession(session: DownstreamSession): void {
    const store = this.deps.sessionStore;
    if (!store) return;
    session.storeTouchedAt = Date.now();
    const rec: StoredSession = {
      clientId: session.clientId,
      protocolVersion: session.protocolVersion,
      clientInfo: session.clientInfo,
      createdAt: session.createdAt.toISOString(),
    };
    store.set(`sess:${session.id}`, JSON.stringify(rec), this.sessionTtlMs()).catch((err: unknown) => {
      logger.warn(`Could not store MCP session: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Re-create a session another instance opened (shared store), or undefined. */
  private async loadSession(id: string, req: Request): Promise<DownstreamSession | undefined> {
    const store = this.deps.sessionStore;
    if (!store || !/^[0-9a-f-]{36}$/i.test(id)) return undefined;
    let raw: string | undefined;
    try {
      raw = await store.get(`sess:${id}`);
    } catch (err) {
      logger.warn(`Could not load MCP session: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    if (!raw) return undefined;
    let rec: StoredSession;
    try {
      rec = JSON.parse(raw) as StoredSession;
    } catch {
      return undefined;
    }
    if (rec.clientId !== (req as AuthedRequest).clientId) return undefined;
    const existing = this.sessions.get(id);
    if (existing) return existing;
    if (this.sessions.size >= this.cfg.maxSessions && !this.evictOne()) return undefined;
    const session: DownstreamSession = {
      id,
      clientId: rec.clientId,
      protocolVersion: rec.protocolVersion,
      clientInfo: rec.clientInfo,
      createdAt: new Date(rec.createdAt),
      lastSeen: Date.now(),
      streams: [],
      inflight: new Map(),
      eventSeq: 0,
      eventLog: [],
      auth: identityOf(req),
      subscriptions: new Set(),
      storeTouchedAt: Date.now(),
    };
    session.toolsFingerprint = this.fingerprint(this.toolIndex(session.auth));
    session.resourcesFingerprint = this.resourcesFingerprint(session.auth);
    session.promptsFingerprint = this.promptsFingerprint(session.auth);
    this.sessions.set(id, session);
    logger.debug(`MCP session ${id.slice(0, 8)} adopted from the shared state store`);
    return session;
  }

  private async resolveSession(req: Request, res: Response): Promise<DownstreamSession | undefined> {
    const id = req.headers['mcp-session-id'];
    if (typeof id !== 'string' || id.length === 0) {
      res.status(400).json(rpcError(null, { code: JSONRPC_INVALID_REQUEST, message: 'Bad Request: Mcp-Session-Id header is required' }));
      return undefined;
    }
    const session = this.sessions.get(id) ?? (await this.loadSession(id, req));
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
    if (this.deps.sessionStore && Date.now() - (session.storeTouchedAt ?? 0) > Math.min(60_000, this.sessionTtlMs() / 4)) {
      this.storeSession(session);
    }
    return session;
  }

  private async handleGet(req: Request, res: Response): Promise<void> {
    if (!acceptsEventStream(req)) {
      res.status(406).json(rpcError(null, { code: JSONRPC_INVALID_REQUEST, message: 'Not Acceptable: client must accept text/event-stream' }));
      return;
    }
    const session = await this.resolveSession(req, res);
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
    // Resumability: replay events the client missed after a dropped stream.
    const lastEventId = req.headers['last-event-id'];
    if (typeof lastEventId === 'string' && /^\d+$/.test(lastEventId.trim())) {
      const after = Number(lastEventId.trim());
      const missed = session.eventLog.filter((e) => e.id > after);
      for (const e of missed) res.write(`id: ${e.id}\nevent: message\ndata: ${e.data}\n\n`);
      if (missed.length) logger.debug(`MCP session ${session.id.slice(0, 8)} resumed: replayed ${missed.length} event(s)`);
    }
    session.streams.push(res);
    req.socket.setTimeout(0);
    res.on('close', () => {
      session.streams = session.streams.filter((s) => s !== res);
      session.lastSeen = Date.now();
    });
  }

  private async handleDelete(req: Request, res: Response): Promise<void> {
    const session = await this.resolveSession(req, res);
    if (!session) return;
    this.endSession(session);
    void this.deps.sessionStore?.del(`sess:${session.id}`).catch(() => undefined);
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
    stream?: ReplyStream,
  ): Promise<JsonRpcMessage> {
    const id = msg.id as JsonRpcId;
    const ok = (result: unknown): JsonRpcMessage => ({ jsonrpc: '2.0', id, result });
    switch (msg.method) {
      case 'logging/setLevel':
        return this.setLogLevel(session, msg);
      case 'completion/complete':
        return this.complete(session, msg, signal);
      case 'resources/subscribe':
        return this.subscribe(session, msg);
      case 'resources/unsubscribe':
        return this.unsubscribe(session, msg);
      case 'ping':
        return ok({});
      case 'initialize':
        return rpcError(id, { code: JSONRPC_INVALID_REQUEST, message: 'Session already initialized' });
      case 'tools/list':
        return this.listTools(session, msg);
      case 'tools/call':
        return this.callTool(session, req, res, msg, signal, single, stream);
      case 'resources/list': {
        const list = this.resources(session.auth);
        if (isFirstPage(msg)) session.resourcesFingerprint = hashList(list);
        return this.paginate(msg, list.map(toMcpResource), 'resources');
      }
      case 'resources/templates/list':
        return this.paginate(msg, this.templates(session.auth).map(toMcpResourceTemplate), 'resourceTemplates');
      case 'resources/read':
        return this.readResource(session, req, res, msg, signal, single);
      case 'prompts/list': {
        const index = this.promptIndex(session.auth);
        if (isFirstPage(msg)) session.promptsFingerprint = this.promptsFingerprint(session.auth);
        return this.paginate(msg, index.list.map(({ name, item }) => toMcpPrompt(name, item)), 'prompts');
      }
      case 'prompts/get':
        return this.getPrompt(session, req, res, msg, signal, single);
      default:
        return rpcError(id, { code: JSONRPC_METHOD_NOT_FOUND, message: `Method not found: ${String(msg.method)}` });
    }
  }

  /** Tools visible to a client (server filters + its scope), with exposed names. */
  private toolIndex(identity: ClientIdentity): ToolIndex {
    const tools = filterToolsByScope(identity.scope, this.deps.registry.getAllTools());
    return buildToolIndex(tools, this.cfg.toolNaming);
  }

  private resources(identity: ClientIdentity) {
    return dedupeResources(
      this.deps.registry.getAllResources().filter((r) => isServerInScope(identity.scope, r.serverId)),
    );
  }

  private templates(identity: ClientIdentity) {
    return this.deps.registry
      .getAllResourceTemplates()
      .filter((t) => isServerInScope(identity.scope, t.serverId))
      .sort((a, b) => (a.serverId < b.serverId ? -1 : a.serverId > b.serverId ? 1 : 0));
  }

  private promptIndex(identity: ClientIdentity) {
    const prompts = this.deps.registry.getAllPrompts().filter((p) => isServerInScope(identity.scope, p.serverId));
    return buildPromptIndex(prompts, this.cfg.toolNaming);
  }

  private resourcesFingerprint(identity: ClientIdentity): string {
    return hashList([...this.resources(identity), ...this.templates(identity)]);
  }

  private promptsFingerprint(identity: ClientIdentity): string {
    return hashList(this.promptIndex(identity).list.map(({ name, item }) => toMcpPrompt(name, item)));
  }

  /** Cursor pagination over a list (same scheme as tools/list). */
  private paginate(msg: JsonRpcMessage, items: unknown[], key: string): JsonRpcMessage {
    const params = isObject(msg.params) ? msg.params : {};
    let offset = 0;
    if (params.cursor !== undefined) {
      const o = decodeCursor(params.cursor);
      if (o === undefined) return rpcError(msg.id, { code: JSONRPC_INVALID_PARAMS, message: 'Invalid cursor' });
      offset = o;
    }
    const page = items.slice(offset, offset + this.cfg.pageSize);
    const result: Record<string, unknown> = { [key]: page };
    const next = offset + page.length;
    if (next < items.length) result.nextCursor = encodeCursor(next);
    return { jsonrpc: '2.0', id: msg.id as JsonRpcId, result };
  }

  /** Forward resources/read or prompts/get with shared rate limit, metrics and error mapping. */
  private async forward(
    req: Request,
    res: Response,
    msg: JsonRpcMessage,
    serverId: string,
    method: string,
    params: unknown,
    kind: 'resource' | 'prompt',
    label: string,
    signal: AbortSignal,
    single: boolean,
  ): Promise<JsonRpcMessage> {
    const id = msg.id as JsonRpcId;
    const limited = await this.applyRateLimit(req, res, id, single);
    if (limited) return limited;
    const server = this.deps.registry.getServer(serverId);
    if (!server || !this.deps.proxy.isConnected(serverId)) {
      return rpcError(id, { code: ERR_NOT_CONNECTED, message: `Server "${serverId}" is not connected` });
    }
    const result = await this.invoker.invoke({
      serverId,
      name: label,
      kind,
      method,
      params: params as Record<string, unknown>,
      timeoutMs: server.timeout,
      clientId: (req as AuthedRequest).clientId,
      via: 'mcp',
      signal,
      traceparent: traceparentOf(req),
    });
    if (result.success) return { jsonrpc: '2.0', id, result: result.result ?? {} };
    const err = result.error ?? { code: JSONRPC_INTERNAL_ERROR, message: 'Unknown error' };
    return rpcError(id, err.code === ERR_CANCELLED ? { code: ERR_CANCELLED, message: 'Request cancelled' } : err);
  }

  private readResource(
    session: DownstreamSession,
    req: Request,
    res: Response,
    msg: JsonRpcMessage,
    signal: AbortSignal,
    single: boolean,
  ): Promise<JsonRpcMessage> | JsonRpcMessage {
    const params = isObject(msg.params) ? msg.params : {};
    const uri = params.uri;
    if (typeof uri !== 'string' || uri.length === 0) {
      return rpcError(msg.id, { code: JSONRPC_INVALID_PARAMS, message: '"uri" must be a non-empty string' });
    }
    const scope = session.auth.scope;
    const serverId = routeResource(
      uri,
      this.resources(session.auth),
      this.templates(session.auth),
      this.deps.registry
        .getEnabledServers()
        .map((s) => s.id)
        .filter((id) => isServerInScope(scope, id) && this.deps.proxy.hasCapability(id, 'resources')),
    );
    if (!serverId) return rpcError(msg.id, { code: -32002, message: 'Resource not found', data: { uri } });
    return this.forward(req, res, msg, serverId, 'resources/read', { uri }, 'resource', uri, signal, single);
  }

  private getPrompt(
    session: DownstreamSession,
    req: Request,
    res: Response,
    msg: JsonRpcMessage,
    signal: AbortSignal,
    single: boolean,
  ): Promise<JsonRpcMessage> | JsonRpcMessage {
    const params = isObject(msg.params) ? msg.params : {};
    const name = params.name;
    const args = params.arguments ?? {};
    if (typeof name !== 'string' || name.length === 0) {
      return rpcError(msg.id, { code: JSONRPC_INVALID_PARAMS, message: '"name" must be a non-empty string' });
    }
    if (!isObject(args)) return rpcError(msg.id, { code: JSONRPC_INVALID_PARAMS, message: '"arguments" must be an object' });
    const tooLarge = this.argumentsTooLarge(msg.id, args);
    if (tooLarge) return tooLarge;
    const prompt = this.promptIndex(session.auth).byName.get(name);
    if (!prompt) return rpcError(msg.id, { code: JSONRPC_INVALID_PARAMS, message: `Unknown prompt: ${name}` });
    return this.forward(
      req, res, msg, prompt.serverId, 'prompts/get', { name: prompt.name, arguments: args }, 'prompt', prompt.name, signal, single,
    );
  }

  /** Count one call against the client's rate limit; returns an error reply when exceeded. */
  private async applyRateLimit(req: Request, res: Response, id: JsonRpcId, single: boolean): Promise<JsonRpcMessage | undefined> {
    const decision = await this.deps.takeRateLimit(req);
    if (!decision) return undefined;
    if (single && !res.headersSent) setRateLimitHeaders(res, decision.limit, decision.remaining, decision.resetAt);
    if (decision.allowed) return undefined;
    if (single && !res.headersSent) res.set('Retry-After', String(decision.retryAfter));
    return rpcError(id, {
      code: ERR_RATE_LIMITED,
      message: `Rate limit exceeded; retry after ${decision.retryAfter}s`,
      data: { retryAfter: decision.retryAfter },
    });
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
    stream?: ReplyStream,
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
    const tooLarge = this.argumentsTooLarge(id, args);
    if (tooLarge) return tooLarge;
    const meta = isObject(params._meta) ? params._meta : {};
    const progressToken = typeof meta.progressToken === 'string' || typeof meta.progressToken === 'number' ? meta.progressToken : undefined;
    const onProgress =
      progressToken !== undefined && stream
        ? (u: { progress: number; total?: number; message?: string }) =>
            stream.send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, ...u } })
        : undefined;

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

    const limited = await this.applyRateLimit(req, res, id, single);
    if (limited) return limited;

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

    const result = await this.invoker.invoke({
      serverId,
      name: tool.name,
      kind: 'tool',
      method: 'tools/call',
      params: args,
      timeoutMs: server.timeout,
      clientId: (req as AuthedRequest).clientId,
      via: 'mcp',
      signal,
      onProgress,
      traceparent: traceparentOf(req),
    });
    if (single && result.traceparent && !res.headersSent) res.set('traceparent', result.traceparent);

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

  private argumentsTooLarge(id: JsonRpcId | null | undefined, args: unknown): JsonRpcMessage | undefined {
    const limit = this.deps.maxArgumentsBytes?.() ?? 0;
    if (!limit || Buffer.byteLength(JSON.stringify(args ?? {}), 'utf8') <= limit) return undefined;
    return rpcError(id, { code: JSONRPC_INVALID_PARAMS, message: `"arguments" exceed the gateway limit of ${limit} bytes` });
  }

  // ─── Logging ────────────────────────────────────────────────────────────────

  private setLogLevel(session: DownstreamSession, msg: JsonRpcMessage): JsonRpcMessage {
    const params = isObject(msg.params) ? msg.params : {};
    if (levelIndex(params.level) < 0) {
      return rpcError(msg.id, { code: JSONRPC_INVALID_PARAMS, message: `"level" must be one of: ${LOG_LEVELS.join(', ')}` });
    }
    session.logLevel = params.level as McpLogLevel;
    this.pushUpstreamLogLevel();
    return { jsonrpc: '2.0', id: msg.id as JsonRpcId, result: {} };
  }

  /** Most verbose level any session asked for (undefined when none did). */
  private wantedLogLevel(): McpLogLevel | undefined {
    let min = -1;
    for (const s of this.sessions.values()) {
      const i = levelIndex(s.logLevel);
      if (i >= 0 && (min < 0 || i < min)) min = i;
    }
    return min >= 0 ? LOG_LEVELS[min] : undefined;
  }

  /** Send `logging/setLevel` to upstream servers with the `logging` capability when the wanted level changed. */
  private pushUpstreamLogLevel(only?: string): void {
    const level = this.wantedLogLevel();
    if (!level) return;
    const ids = only ? [only] : this.deps.registry.getEnabledServers().map((s) => s.id);
    for (const serverId of ids) {
      if (!this.deps.proxy.hasCapability(serverId, 'logging')) continue;
      if (this.upstreamLogLevel.get(serverId) === level) continue;
      this.upstreamLogLevel.set(serverId, level);
      void this.deps.proxy.request(serverId, 'logging/setLevel', { level }, 5_000).then((r) => {
        if (!r.success) logger.debug(`[${serverId}] logging/setLevel failed: ${r.error?.message}`);
      });
    }
  }

  // ─── Completion ─────────────────────────────────────────────────────────────

  private async complete(session: DownstreamSession, msg: JsonRpcMessage, signal: AbortSignal): Promise<JsonRpcMessage> {
    const id = msg.id as JsonRpcId;
    const params = isObject(msg.params) ? msg.params : {};
    const ref = isObject(params.ref) ? params.ref : undefined;
    const argument = isObject(params.argument) ? params.argument : undefined;
    if (!ref || !argument || typeof argument.name !== 'string' || typeof argument.value !== 'string') {
      return rpcError(id, { code: JSONRPC_INVALID_PARAMS, message: '"ref" and "argument" { name, value } are required' });
    }
    const tooLarge = this.argumentsTooLarge(id, params.context ?? {});
    if (tooLarge) return tooLarge;
    let serverId: string | undefined;
    let upstreamRef: Record<string, unknown> = ref;
    if (ref.type === 'ref/prompt' && typeof ref.name === 'string') {
      const prompt = this.promptIndex(session.auth).byName.get(ref.name);
      if (!prompt) return rpcError(id, { code: JSONRPC_INVALID_PARAMS, message: `Unknown prompt: ${ref.name}` });
      serverId = prompt.serverId;
      upstreamRef = { ...ref, name: prompt.name };
    } else if (ref.type === 'ref/resource' && typeof ref.uri === 'string') {
      const uri = ref.uri;
      const template = this.templates(session.auth).find((t) => t.uriTemplate === uri);
      serverId =
        template?.serverId ??
        this.resources(session.auth).find((r) => r.uri === uri)?.serverId ??
        this.templates(session.auth).find((t) => matchesUriTemplate(t.uriTemplate, uri))?.serverId;
      if (!serverId) return rpcError(id, { code: -32002, message: 'Resource not found', data: { uri } });
    } else {
      return rpcError(id, { code: JSONRPC_INVALID_PARAMS, message: '"ref.type" must be "ref/prompt" or "ref/resource"' });
    }
    const empty = { completion: { values: [], hasMore: false } };
    if (!this.deps.proxy.isConnected(serverId) || !this.deps.proxy.hasCapability(serverId, 'completions')) {
      return { jsonrpc: '2.0', id, result: empty };
    }
    const upstreamParams: Record<string, unknown> = { ref: upstreamRef, argument };
    if (isObject(params.context)) upstreamParams.context = params.context;
    const server = this.deps.registry.getServer(serverId);
    const r = await this.deps.proxy.request(serverId, 'completion/complete', upstreamParams, server?.timeout, { signal });
    if (r.success) return { jsonrpc: '2.0', id, result: r.result ?? empty };
    if (r.error?.code === ERR_CANCELLED) return rpcError(id, { code: ERR_CANCELLED, message: 'Request cancelled' });
    return rpcError(id, r.error ?? { code: JSONRPC_INTERNAL_ERROR, message: 'Unknown error' });
  }

  // ─── Resource subscriptions ─────────────────────────────────────────────────

  private routeUri(session: DownstreamSession, uri: string): string | undefined {
    const scope = session.auth.scope;
    return routeResource(
      uri,
      this.resources(session.auth),
      this.templates(session.auth),
      this.deps.registry
        .getEnabledServers()
        .map((s) => s.id)
        .filter((sid) => isServerInScope(scope, sid) && this.deps.proxy.hasCapability(sid, 'resources')),
    );
  }

  private async subscribe(session: DownstreamSession, msg: JsonRpcMessage): Promise<JsonRpcMessage> {
    const id = msg.id as JsonRpcId;
    const params = isObject(msg.params) ? msg.params : {};
    const uri = params.uri;
    if (typeof uri !== 'string' || uri.length === 0) {
      return rpcError(id, { code: JSONRPC_INVALID_PARAMS, message: '"uri" must be a non-empty string' });
    }
    const serverId = this.routeUri(session, uri);
    if (!serverId) return rpcError(id, { code: -32002, message: 'Resource not found', data: { uri } });
    const caps = this.deps.proxy.getSessionInfo(serverId)?.capabilities;
    const resCaps = isObject(caps?.resources) ? caps.resources : {};
    if (resCaps.subscribe !== true) {
      return rpcError(id, { code: JSONRPC_METHOD_NOT_FOUND, message: `Server "${serverId}" does not support resource subscriptions` });
    }
    const key = `${serverId}\u0000${uri}`;
    if (session.subscriptions.has(key)) return { jsonrpc: '2.0', id, result: {} };
    let subs = this.upstreamSubs.get(key);
    if (!subs || subs.size === 0) {
      const r = await this.deps.proxy.request(serverId, 'resources/subscribe', { uri }, 10_000);
      if (!r.success) return rpcError(id, r.error ?? { code: JSONRPC_INTERNAL_ERROR, message: 'Subscribe failed' });
      subs = this.upstreamSubs.get(key) ?? new Set();
      this.upstreamSubs.set(key, subs);
    }
    if (!this.sessions.has(session.id)) {
      // The session ended while subscribing.
      if (subs.size === 0) this.dropUpstreamSub(key);
      return rpcError(id, { code: -32001, message: 'Session not found' });
    }
    subs.add(session.id);
    session.subscriptions.add(key);
    return { jsonrpc: '2.0', id, result: {} };
  }

  private unsubscribe(session: DownstreamSession, msg: JsonRpcMessage): JsonRpcMessage {
    const params = isObject(msg.params) ? msg.params : {};
    const uri = params.uri;
    if (typeof uri !== 'string' || uri.length === 0) {
      return rpcError(msg.id, { code: JSONRPC_INVALID_PARAMS, message: '"uri" must be a non-empty string' });
    }
    for (const key of [...session.subscriptions]) {
      if (key.slice(key.indexOf('\u0000') + 1) === uri) this.releaseSub(session, key);
    }
    return { jsonrpc: '2.0', id: msg.id as JsonRpcId, result: {} };
  }

  private releaseSub(session: DownstreamSession, key: string): void {
    session.subscriptions.delete(key);
    const subs = this.upstreamSubs.get(key);
    if (!subs) return;
    subs.delete(session.id);
    if (subs.size === 0) this.dropUpstreamSub(key);
  }

  private dropUpstreamSub(key: string): void {
    this.upstreamSubs.delete(key);
    const i = key.indexOf('\u0000');
    const serverId = key.slice(0, i);
    if (!this.deps.proxy.isConnected(serverId)) return;
    void this.deps.proxy.request(serverId, 'resources/unsubscribe', { uri: key.slice(i + 1) }, 10_000);
  }

  /** Number of upstream subscriptions (for tests / monitoring). */
  subscriptionCount(): number {
    return this.upstreamSubs.size;
  }

  // ─── Upstream notifications ─────────────────────────────────────────────────

  private handleUpstreamConnected(serverId: string): void {
    // Subscriptions and the log level do not survive a reconnect: restore them.
    for (const key of this.upstreamSubs.keys()) {
      const i = key.indexOf('\u0000');
      if (key.slice(0, i) !== serverId) continue;
      void this.deps.proxy.request(serverId, 'resources/subscribe', { uri: key.slice(i + 1) }, 10_000);
    }
    this.upstreamLogLevel.delete(serverId);
    this.pushUpstreamLogLevel(serverId);
  }

  private handleUpstreamNotification(serverId: string, msg: JsonRpcMessage): void {
    const params = isObject(msg.params) ? msg.params : {};
    if (msg.method === 'notifications/resources/updated' && typeof params.uri === 'string') {
      const subs = this.upstreamSubs.get(`${serverId}\u0000${params.uri}`);
      for (const sid of subs ?? []) {
        const s = this.sessions.get(sid);
        if (s && isServerInScope(s.auth.scope, serverId)) {
          this.send(s, { jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: params.uri } });
        }
      }
      return;
    }
    if (msg.method === 'notifications/message') {
      const lvl = levelIndex(params.level);
      if (lvl < 0) return;
      const name = typeof params.logger === 'string' && params.logger ? `${serverId}/${params.logger}` : serverId;
      for (const s of this.sessions.values()) {
        const min = levelIndex(s.logLevel);
        if (min < 0 || lvl < min || !isServerInScope(s.auth.scope, serverId)) continue;
        this.send(s, { jsonrpc: '2.0', method: 'notifications/message', params: { level: params.level, logger: name, data: params.data } });
      }
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
        void this.deps.sessionStore?.del(`sess:${s.id}`).catch(() => undefined);
        continue;
      }
      if (current) s.auth = { ...s.auth, scope: current.scope };
      if (s.streams.length === 0) continue;
      const fp = this.fingerprint(this.toolIndex(s.auth));
      if (fp !== s.toolsFingerprint) {
        s.toolsFingerprint = fp;
        this.send(s, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      }
      const rfp = this.resourcesFingerprint(s.auth);
      if (rfp !== s.resourcesFingerprint) {
        s.resourcesFingerprint = rfp;
        this.send(s, { jsonrpc: '2.0', method: 'notifications/resources/list_changed' });
      }
      const pfp = this.promptsFingerprint(s.auth);
      if (pfp !== s.promptsFingerprint) {
        s.promptsFingerprint = pfp;
        this.send(s, { jsonrpc: '2.0', method: 'notifications/prompts/list_changed' });
      }
    }
  }

  /** Send a message on the session's most recent stream. */
  /**
   * Send a message on the session's most recent stream. Every event gets a
   * session-wide id and is kept in a bounded buffer (`mcp.eventBufferSize`),
   * so a client that reconnects with `Last-Event-ID` receives what it missed —
   * including events emitted while no stream was open.
   */
  private send(session: DownstreamSession, msg: JsonRpcMessage): boolean {
    const id = ++session.eventSeq;
    const data = JSON.stringify(msg);
    const cap = this.cfg.eventBufferSize;
    if (cap > 0) {
      session.eventLog.push({ id, data });
      if (session.eventLog.length > cap) session.eventLog.splice(0, session.eventLog.length - cap);
    }
    const stream = session.streams[session.streams.length - 1];
    if (!stream) return false;
    stream.write(`id: ${id}\nevent: message\ndata: ${data}\n\n`);
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
    for (const key of [...session.subscriptions]) this.releaseSub(session, key);
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

function isFirstPage(msg: JsonRpcMessage): boolean {
  return !isObject(msg.params) || msg.params.cursor === undefined;
}

function hashList(items: unknown[]): string {
  const h = createHash('sha256');
  for (const i of items) h.update(JSON.stringify(i)).update('\n');
  return h.digest('hex');
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
