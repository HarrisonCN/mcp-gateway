/**
 * MCP Proxy
 * Routes tool-call requests to the appropriate upstream MCP server over any
 * supported transport: `stdio`, `sse` (HTTP+SSE, 2024-11-05), `websocket`
 * and `streamable-http` (2025-03-26+).
 *
 * The proxy is split in two layers:
 *  - a *channel* per transport (`src/transport/*`) that only moves JSON-RPC
 *    messages, and
 *  - this transport-independent *session* layer: MCP handshake, request/
 *    response correlation, timeouts + upstream cancellation, `maxConcurrency`,
 *    answering server→client requests (`ping`), `tools/list` pagination and
 *    `notifications/tools/list_changed`.
 *
 * Events:
 *  - `disconnected` (serverId, error) — a session was lost unexpectedly
 *    (process exit, socket/stream closed, session expired). Not emitted for
 *    `disconnect()`. The gateway supervisor uses it to reconnect.
 *  - `tools-changed` (serverId, tools) — the server announced a new tool list.
 *  - `catalog-changed` (serverId, catalog) — new resource / prompt lists.
 *  - `connected` (serverId) — a session finished its handshake.
 *  - `notification` (serverId, message) — any other server notification
 *    (`notifications/message`, `notifications/resources/updated`, …);
 *    `notifications/progress` goes to the request's `onProgress` instead.
 *
 * Fixes kept from v0.2.0 / the audit: per-server connect mutex (BUG-001),
 * monotonic ids (BUG-002), no leaked sessions on failed `initialize`, an old
 * session's exit can never remove a newer one, server requests with colliding
 * ids are answered instead of mistaken for responses.
 *
 * @module proxy
 */

import { EventEmitter } from 'events';
import type {
  McpServerConfig,
  PromptInfo,
  ProxyResponse,
  ResourceInfo,
  ResourceTemplateInfo,
  ServerCatalog,
  ToolInfo,
} from '../utils/types.js';
import { logger } from '../utils/logger.js';
import { Mutex } from '../utils/mutex.js';
import { Semaphore } from '../utils/semaphore.js';
import { VERSION } from '../utils/version.js';
import type { ChannelFactory, ChannelOptions, JsonRpcId, JsonRpcMessage, UpstreamChannel } from '../transport/channel.js';
import { StdioChannel } from '../transport/stdio.js';
import { SseChannel } from '../transport/sse.js';
import { WebSocketChannel } from '../transport/websocket.js';
import { StreamableHttpChannel } from '../transport/streamable-http.js';

/** Protocol version the gateway asks for in `initialize`. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';
/** Versions the gateway understands; servers may answer with any of them. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const MAX_TOOL_PAGES = 100;
const DEFAULT_TIMEOUT_MS = 30_000;

// JSON-RPC error codes used by the gateway
export const ERR_NOT_CONNECTED = -32000;
export const ERR_TIMEOUT = -32001;
/** 4.4: the server's queue (`maxQueue`) is full. */
export const ERR_SERVER_BUSY = -32014;
/** The caller cancelled the request (e.g. a downstream `notifications/cancelled`). */
export const ERR_CANCELLED = -32800;

export interface ProgressUpdate {
  progress: number;
  total?: number;
  message?: string;
}

export interface RequestOptions {
  /** Extra `_meta` fields for `tools/call` (3.5: injected credentials). */
  meta?: Record<string, unknown>;
  /** Abort the request: upstream gets `notifications/cancelled`, the result is `ERR_CANCELLED`. */
  signal?: AbortSignal;
  /**
   * Receive `notifications/progress` for this request. The proxy sends its own
   * unique `_meta.progressToken` upstream, so tokens of different clients
   * never collide.
   */
  onProgress?: (update: ProgressUpdate) => void;
  /**
   * Opaque reference to the downstream caller (3.1). Sampling / elicitation / roots requests the server sends
   * while this request is in flight are handed to the client request handler together with this value.
   */
  caller?: RelayCaller;
}

/** Downstream caller of a request; `key` identifies the client session (callers with equal keys are the same). */
export interface RelayCaller {
  key: string;
}

/** Server→client requests the gateway can relay to the downstream client (3.1). */
export const PASSTHROUGH_METHODS = ['sampling/createMessage', 'elicitation/create', 'roots/list'] as const;
export type PassthroughMethod = (typeof PASSTHROUGH_METHODS)[number];

/** Answers an upstream server's request on behalf of the downstream client. */
export type ClientRequestHandler = (
  serverId: string,
  method: PassthroughMethod,
  params: unknown,
  caller: RelayCaller | undefined,
) => Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }>;

// ── Monotonic ID counter (fix BUG-002) ──────────────────────────────────────
let _idSeq = 0;
function nextId(): number {
  return ++_idSeq;
}

/** Default channel per transport. */
export const defaultChannelFactory: ChannelFactory = (config, options) => {
  switch (config.transport) {
    case 'stdio':
      return new StdioChannel(config, options);
    case 'sse':
      return new SseChannel(config, options);
    case 'websocket':
      return new WebSocketChannel(config, options);
    case 'streamable-http':
      return new StreamableHttpChannel(config, options);
    default:
      throw new Error(`Unknown transport "${String((config as McpServerConfig).transport)}" (server "${config.id}")`);
  }
};

// ─── Session ──────────────────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: ProxyResponse) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface Session {
  config: McpServerConfig;
  channel: UpstreamChannel;
  pendingRequests: Map<JsonRpcId, PendingRequest>;
  limiter: Semaphore;
  closed: boolean;
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string };
  connectedAt?: Date;
  capabilities?: Record<string, unknown>;
  catalog: ServerCatalog;
  /** Progress callbacks by the progress token the gateway sent upstream. */
  progress: Map<string, (update: ProgressUpdate) => void>;
  /** Downstream callers of in-flight requests, oldest first (sampling / elicitation routing). */
  callers: Array<{ token?: string; caller: RelayCaller }>;
}

export interface SessionInfo {
  transport: string;
  protocolVersion?: string;
  /** Capabilities the server announced in `initialize`. */
  capabilities?: Record<string, unknown>;
  serverInfo?: { name?: string; version?: string };
  connectedAt?: Date;
}

export interface ProxyOptions {
  /** Grace period between closing stdin / SIGTERM / SIGKILL (and for WS/HTTP close). */
  killGraceMs?: number;
  /** Override how channels are created (for tests or custom transports). */
  channelFactory?: ChannelFactory;
  /** 10.9.1: stdio settings read at spawn time (`security.stdioEnvPassthrough`). */
  stdio?: () => { envPassthrough?: string[] };
}

/** Client capabilities the gateway announces upstream for the relayed features. */
export function passthroughCapabilities(methods: readonly PassthroughMethod[]): Record<string, unknown> {
  const caps: Record<string, unknown> = {};
  if (methods.includes('sampling/createMessage')) caps.sampling = {};
  if (methods.includes('elicitation/create')) caps.elicitation = {};
  if (methods.includes('roots/list')) caps.roots = { listChanged: true };
  return caps;
}

export class McpProxy extends EventEmitter {
  private sessions = new Map<string, Session>();
  // Per-server connect mutex (fix BUG-001)
  private spawnLocks = new Map<string, Mutex>();
  private readonly killGraceMs: number;
  private readonly channelFactory: ChannelFactory;

  private clientRequestHandler?: ClientRequestHandler;
  private passthroughMethods: () => readonly PassthroughMethod[] = () => [];

  /** Relay sampling / elicitation / roots requests from upstream servers (3.1). */
  setClientRequestHandler(handler: ClientRequestHandler | undefined, methods: () => readonly PassthroughMethod[] = () => PASSTHROUGH_METHODS): void {
    this.clientRequestHandler = handler;
    this.passthroughMethods = handler ? methods : () => [];
  }

  private relays(session: Session): readonly PassthroughMethod[] {
    return session.config.passthrough === false ? [] : this.passthroughMethods();
  }

  /** Send a notification to every connected server (e.g. `notifications/roots/list_changed`). */
  async notifyAll(method: string, params?: unknown, filter: (serverId: string) => boolean = () => true): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].filter((s) => !s.closed && s.connectedAt && filter(s.config.id)).map((s) => this._notify(s, method, params)),
    );
  }

  /** Whether the server was told it may send `method` (its passthrough capability). */
  relaysTo(serverId: string, method: PassthroughMethod): boolean {
    const s = this.sessions.get(serverId);
    return !!s && this.relays(s).includes(method);
  }

  constructor(options: ProxyOptions = {}) {
    super();
    this.killGraceMs = options.killGraceMs ?? 2_000;
    this.channelFactory = options.channelFactory ?? defaultChannelFactory;
    this.stdioOptions = options.stdio;
  }
  private readonly stdioOptions?: () => { envPassthrough?: string[] };

  private getSpawnLock(serverId: string): Mutex {
    let lock = this.spawnLocks.get(serverId);
    if (!lock) {
      lock = new Mutex();
      this.spawnLocks.set(serverId, lock);
    }
    return lock;
  }

  // ─── Connection Management ──────────────────────────────────────────────────

  async connect(config: McpServerConfig): Promise<ToolInfo[]> {
    // Serialise concurrent connect calls for the same server (fix BUG-001)
    return this.getSpawnLock(config.id).runExclusive(async () => {
      // Replace (and clean up) any existing session for this id.
      if (this.sessions.has(config.id)) {
        await this._disconnectUnlocked(config.id);
      }

      const timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
      const options: ChannelOptions = { connectTimeoutMs: timeout, killGraceMs: this.killGraceMs, ...(this.stdioOptions?.() ?? {}) };
      const channel = this.channelFactory(config, options);
      const session: Session = {
        config,
        channel,
        pendingRequests: new Map(),
        limiter: new Semaphore(config.maxConcurrency ?? Infinity),
        closed: false,
        catalog: { resources: [], resourceTemplates: [], prompts: [] },
        progress: new Map(),
        callers: [],
      };

      channel.onmessage = (msg) => this._onMessage(session, msg);
      channel.onclose = (err) => this._onChannelLost(session, err);

      try {
        await withTimeout(channel.start(), timeout, `Connecting to "${config.id}" timed out after ${timeout}ms`);
      } catch (err) {
        session.closed = true;
        await channel.close().catch(() => {});
        throw err;
      }

      this.sessions.set(config.id, session);
      try {
        const tools = await this._handshake(session);
        session.connectedAt = new Date();
        this.emit('connected', config.id);
        return tools;
      } catch (err) {
        await this._disconnectUnlocked(config.id);
        throw err;
      }
    });
  }

  private async _handshake(session: Session): Promise<ToolInfo[]> {
    const { config } = session;
    const timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
    const initResult = await this._sendRequest(
      session,
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: passthroughCapabilities(this.relays(session)),
        clientInfo: { name: 'mcp-gateway', version: VERSION },
      },
      timeout,
      false,
    );

    if (!initResult.success) {
      throw new Error(`Failed to initialize server "${config.id}": ${initResult.error?.message}`);
    }

    const init = (initResult.result ?? {}) as {
      protocolVersion?: unknown;
      serverInfo?: { name?: string; version?: string };
      capabilities?: unknown;
    };
    session.capabilities = isPlainObject(init.capabilities) ? init.capabilities : {};
    if (typeof init.protocolVersion === 'string') {
      session.protocolVersion = init.protocolVersion;
      if (!SUPPORTED_PROTOCOL_VERSIONS.includes(init.protocolVersion)) {
        logger.warn(`Server "${config.id}" negotiated unknown protocol version ${init.protocolVersion}; continuing`);
      }
      session.channel.setProtocolVersion?.(init.protocolVersion);
    }
    session.serverInfo = init.serverInfo;

    await this._notify(session, 'notifications/initialized');
    const tools = await this._listTools(session);
    session.catalog = await this._listCatalog(session);
    return tools;
  }

  /** Fetch every page of a list method (`resources/list`, `prompts/list`, …). */
  private async _listAll(session: Session, method: string, key: string): Promise<Record<string, unknown>[]> {
    const timeout = session.config.timeout ?? DEFAULT_TIMEOUT_MS;
    const items: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const r = await this._sendRequest(session, method, cursor ? { cursor } : {}, timeout, false);
      if (!r.success) {
        logger.warn(`Could not ${method} for "${session.config.id}": ${r.error?.message}`);
        break;
      }
      const result = (r.result ?? {}) as Record<string, unknown>;
      const list = result[key];
      if (Array.isArray(list)) for (const it of list) if (isPlainObject(it)) items.push(it);
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return items;
  }

  /** Resources, templates and prompts, for servers that announce those capabilities. */
  private async _listCatalog(session: Session): Promise<ServerCatalog> {
    const { config } = session;
    const caps = session.capabilities ?? {};
    const pick = <T>(o: Record<string, unknown>, keys: string[]): Partial<T> => {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
      return out as Partial<T>;
    };
    const owner = { serverId: config.id, serverName: config.name };
    const catalog: ServerCatalog = { resources: [], resourceTemplates: [], prompts: [] };
    if (caps.resources) {
      for (const r of await this._listAll(session, 'resources/list', 'resources')) {
        if (typeof r.uri !== 'string') continue;
        catalog.resources.push({
          ...pick<ResourceInfo>(r, ['title', 'description', 'mimeType', 'size', 'annotations']),
          uri: r.uri,
          name: typeof r.name === 'string' ? r.name : r.uri,
          ...owner,
        });
      }
      for (const t of await this._listAll(session, 'resources/templates/list', 'resourceTemplates')) {
        if (typeof t.uriTemplate !== 'string') continue;
        catalog.resourceTemplates.push({
          ...pick<ResourceTemplateInfo>(t, ['title', 'description', 'mimeType', 'annotations']),
          uriTemplate: t.uriTemplate,
          name: typeof t.name === 'string' ? t.name : t.uriTemplate,
          ...owner,
        });
      }
    }
    if (caps.prompts) {
      for (const p of await this._listAll(session, 'prompts/list', 'prompts')) {
        if (typeof p.name !== 'string') continue;
        catalog.prompts.push({
          ...pick<PromptInfo>(p, ['title', 'description', 'arguments']),
          name: p.name,
          ...owner,
        });
      }
    }
    return catalog;
  }

  /** Whether a connected server announced a capability (e.g. "resources"). */
  hasCapability(serverId: string, capability: string): boolean {
    const s = this.sessions.get(serverId);
    return !!s && !s.closed && !!s.capabilities?.[capability];
  }

  /** Resources, templates and prompts announced by a connected server. */
  getCatalog(serverId: string): ServerCatalog {
    const s = this.sessions.get(serverId);
    return s && !s.closed ? s.catalog : { resources: [], resourceTemplates: [], prompts: [] };
  }

  private async _listTools(session: Session): Promise<ToolInfo[]> {
    const { config } = session;
    const timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
    const tools: ToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const toolsResult = await this._sendRequest(session, 'tools/list', cursor ? { cursor } : {}, timeout, false);

      if (!toolsResult.success) {
        logger.warn(`Could not list tools for "${config.id}": ${toolsResult.error?.message}`);
        break;
      }

      const result = (toolsResult.result ?? {}) as { tools?: unknown[]; nextCursor?: unknown };
      for (const t of result.tools ?? []) {
        const tool = t as {
          name?: unknown;
          title?: unknown;
          description?: string;
          inputSchema?: Record<string, unknown>;
          outputSchema?: unknown;
          annotations?: unknown;
        };
        if (typeof tool?.name !== 'string') continue;
        const info: ToolInfo = {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          serverId: config.id,
          serverName: config.name,
        };
        if (typeof tool.title === 'string') info.title = tool.title;
        if (isPlainObject(tool.outputSchema)) info.outputSchema = tool.outputSchema;
        if (isPlainObject(tool.annotations)) info.annotations = tool.annotations;
        tools.push(info);
      }

      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  async disconnect(serverId: string): Promise<void> {
    await this.getSpawnLock(serverId).runExclusive(() => this._disconnectUnlocked(serverId));
  }

  private async _disconnectUnlocked(serverId: string): Promise<void> {
    const session = this.sessions.get(serverId);
    if (!session) return;
    this.sessions.delete(serverId);
    session.closed = true;
    this._rejectAll(session, new Error('Server disconnected'));
    await session.channel.close().catch((err: unknown) => {
      logger.debug(`[${serverId}] error while closing: ${String(err)}`);
    });
    logger.info(`Disconnected from server: ${serverId}`);
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.disconnect(id)));
  }

  // ─── Tool Execution ─────────────────────────────────────────────────────────

  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    timeout?: number,
    options: RequestOptions = {},
  ): Promise<ProxyResponse> {
    return this.request(serverId, 'tools/call', { name: toolName, arguments: args, ...(options.meta ? { _meta: options.meta } : {}) }, timeout, options);
  }

  /**
   * Send any MCP request to a connected server through the session layer
   * (timeout, `maxConcurrency`, upstream cancellation).
   */
  async request(
    serverId: string,
    method: string,
    params?: unknown,
    timeout?: number,
    options: RequestOptions = {},
  ): Promise<ProxyResponse> {
    const session = this.sessions.get(serverId);
    // Requests are only forwarded once the handshake (initialize → initialized) is done.
    if (!session || session.closed || !session.connectedAt) {
      return {
        success: false,
        error: { code: ERR_NOT_CONNECTED, message: `Server "${serverId}" is not connected` },
        durationMs: 0,
      };
    }
    return this._sendRequest(
      session,
      method,
      params,
      timeout ?? session.config.timeout ?? DEFAULT_TIMEOUT_MS,
      true,
      options.signal,
      options.onProgress,
      options.caller,
    );
  }

  /** MCP `ping`: resolves with the round-trip latency (ms), or rejects if the server does not answer. */
  async ping(serverId: string, timeout = 5_000): Promise<number> {
    const session = this.sessions.get(serverId);
    if (!session || session.closed) throw new Error(`Server "${serverId}" is not connected`);
    const r = await this._sendRequest(session, 'ping', undefined, timeout, false);
    // Any JSON-RPC answer (even "method not found" from a non-compliant
    // server) proves the server is alive; only timeouts / transport errors fail.
    if (!r.success && (r.error?.code === ERR_TIMEOUT || r.error?.code === ERR_NOT_CONNECTED)) {
      throw new Error(r.error.message);
    }
    return r.durationMs;
  }

  /** True once the MCP handshake has completed (not while it is still in progress). */
  isConnected(serverId: string): boolean {
    const s = this.sessions.get(serverId);
    return !!s && !s.closed && !!s.connectedAt;
  }

  /** Negotiated session details (for /servers). */
  getSessionInfo(serverId: string): SessionInfo | undefined {
    const s = this.sessions.get(serverId);
    if (!s || s.closed) return undefined;
    return {
      transport: s.channel.kind,
      protocolVersion: s.protocolVersion,
      capabilities: s.capabilities,
      serverInfo: s.serverInfo,
      connectedAt: s.connectedAt,
    };
  }

  /** In-flight and queued tool calls for a server (for monitoring). */
  getLoad(serverId: string): { inFlight: number; queued: number } | undefined {
    const s = this.sessions.get(serverId);
    return s ? { inFlight: s.limiter.inFlight, queued: s.limiter.pending } : undefined;
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  private _onChannelLost(session: Session, err: Error): void {
    if (session.closed) return;
    session.closed = true;
    this._rejectAll(session, err);
    // Only drop the session if it is still the current one for this id.
    if (this.sessions.get(session.config.id) === session) {
      this.sessions.delete(session.config.id);
      // A loss during the handshake surfaces as a connect() failure instead.
      if (session.connectedAt) this.emit('disconnected', session.config.id, err);
    }
  }

  private _rejectAll(session: Session, err: Error): void {
    for (const [, pending] of session.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    session.pendingRequests.clear();
  }

  private _onMessage(session: Session, msg: JsonRpcMessage): void {
    if (!msg || typeof msg !== 'object') return;

    if (typeof msg.method === 'string') {
      if (msg.id !== undefined && msg.id !== null) {
        if ((this.relays(session) as readonly string[]).includes(msg.method) && this.clientRequestHandler) {
          void this._relayServerRequest(session, msg.id, msg.method as PassthroughMethod, msg.params);
        } else {
          this._answerServerRequest(session, msg.id, msg.method);
        }
      } else if (msg.method === 'notifications/tools/list_changed') {
        this._refreshTools(session);
      } else if (
        msg.method === 'notifications/resources/list_changed' ||
        msg.method === 'notifications/prompts/list_changed'
      ) {
        this._refreshCatalog(session);
      } else if (msg.method === 'notifications/progress') {
        const p = isPlainObject(msg.params) ? msg.params : {};
        const cb = session.progress.get(String(p.progressToken));
        if (cb && typeof p.progress === 'number') {
          const update: ProgressUpdate = { progress: p.progress };
          if (typeof p.total === 'number') update.total = p.total;
          if (typeof p.message === 'string') update.message = p.message;
          try {
            cb(update);
          } catch (err) {
            logger.debug(`[${session.config.id}] progress handler failed: ${String(err)}`);
          }
        }
      } else if (session.connectedAt) {
        this.emit('notification', session.config.id, msg);
      }
      return;
    }

    if (msg.id === undefined || msg.id === null) return;
    const pending = session.pendingRequests.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    session.pendingRequests.delete(msg.id);

    if (msg.error) {
      pending.resolve({ success: false, error: msg.error, durationMs: 0 });
    } else {
      pending.resolve({ success: true, result: msg.result, durationMs: 0 });
    }
  }

  private _refreshTools(session: Session): void {
    if (!session.connectedAt) return; // still handshaking: the initial list is fetched anyway
    void this._listTools(session).then(
      (tools) => {
        if (!session.closed) this.emit('tools-changed', session.config.id, tools);
      },
      (err: unknown) => logger.warn(`[${session.config.id}] could not refresh tools: ${String(err)}`),
    );
  }

  private _refreshCatalog(session: Session): void {
    if (!session.connectedAt) return;
    void this._listCatalog(session).then(
      (catalog) => {
        if (session.closed) return;
        session.catalog = catalog;
        this.emit('catalog-changed', session.config.id, catalog);
      },
      (err: unknown) => logger.warn(`[${session.config.id}] could not refresh resources/prompts: ${String(err)}`),
    );
  }

  /** The downstream caller a server request belongs to: matched by progress token, else the latest call. */
  private _callerFor(session: Session, params: unknown): RelayCaller | undefined {
    const meta = isPlainObject(params) && isPlainObject(params._meta) ? params._meta : undefined;
    const token = meta && (typeof meta.progressToken === 'string' || typeof meta.progressToken === 'number') ? String(meta.progressToken) : undefined;
    if (token) {
      const hit = session.callers.find((c) => c.token === token);
      if (hit) return hit.caller;
    }
    // No token echoed: only route when every in-flight call comes from the same client, so one client's
    // sampling / elicitation request can never reach another client.
    const keys = new Set(session.callers.map((c) => c.caller.key));
    return keys.size === 1 ? session.callers[session.callers.length - 1]!.caller : undefined;
  }

  private async _relayServerRequest(session: Session, id: JsonRpcId, method: PassthroughMethod, params: unknown): Promise<void> {
    let reply: JsonRpcMessage;
    try {
      const r = await this.clientRequestHandler!(session.config.id, method, params, this._callerFor(session, params));
      reply = r.error ? { jsonrpc: '2.0', id, error: r.error } : { jsonrpc: '2.0', id, result: r.result ?? {} };
    } catch (err) {
      reply = { jsonrpc: '2.0', id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } };
    }
    if (session.closed) return;
    await session.channel.send(reply).catch(() => {});
  }

  private _answerServerRequest(session: Session, id: JsonRpcId, method: string): void {
    const reply: JsonRpcMessage =
      method === 'ping'
        ? { jsonrpc: '2.0', id, result: {} }
        : { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not supported by gateway: ${method}` } };
    void session.channel.send(reply).catch(() => {});
  }

  private async _notify(session: Session, method: string, params?: unknown): Promise<void> {
    const msg: JsonRpcMessage = params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params };
    await session.channel.send(msg).catch((err: unknown) => {
      logger.debug(`[${session.config.id}] failed to send ${method}: ${String(err)}`);
    });
  }

  private async _sendRequest(
    session: Session,
    method: string,
    params: unknown,
    timeout = DEFAULT_TIMEOUT_MS,
    limited = true,
    signal?: AbortSignal,
    onProgress?: (update: ProgressUpdate) => void,
    caller?: RelayCaller,
  ): Promise<ProxyResponse> {
    const serverId = session.config.id;
    const startTime = Date.now();
    const deadline = startTime + timeout;
    const timedOut = (): ProxyResponse => ({
      success: false,
      error: { code: ERR_TIMEOUT, message: `Request timed out after ${timeout}ms` },
      durationMs: Date.now() - startTime,
    });
    const notConnected = (message: string): ProxyResponse => ({
      success: false,
      error: { code: ERR_NOT_CONNECTED, message },
      durationMs: Date.now() - startTime,
    });

    const cancelled = (): ProxyResponse => ({
      success: false,
      error: { code: ERR_CANCELLED, message: 'Request cancelled' },
      durationMs: Date.now() - startTime,
    });

    if (session.closed) return notConnected(`No session for server "${serverId}"`);
    if (signal?.aborted) return cancelled();

    // Enforce maxConcurrency; the timeout covers time spent queued.
    let release: (() => void) | undefined;
    if (limited && session.config.maxQueue !== undefined && session.limiter.inFlight >= (session.config.maxConcurrency ?? Infinity) && session.limiter.pending >= session.config.maxQueue) {
      // 4.4 backpressure: shed load instead of queueing without bound.
      return { success: false, error: { code: ERR_SERVER_BUSY, message: `Server "${serverId}" is busy (${session.limiter.pending} calls queued)`, data: { queued: session.limiter.pending } }, durationMs: Date.now() - startTime };
    }
    if (limited) {
      let queueTimer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;
      const slot = session.limiter.acquire();
      const winner = await Promise.race([
        slot.then((r) => ({ release: r })),
        new Promise<'timeout'>((r) => (queueTimer = setTimeout(() => r('timeout'), timeout))),
        new Promise<'aborted'>((r) => {
          if (!signal) return;
          onAbort = () => r('aborted');
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
      clearTimeout(queueTimer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      if (winner === 'timeout' || winner === 'aborted') {
        // Give the slot back as soon as it is granted.
        void slot.then((r) => r());
        return winner === 'timeout' ? timedOut() : cancelled();
      }
      release = winner.release;
    }

    try {
      if (session.closed) return notConnected(`Server "${serverId}" disconnected`);

      if (signal?.aborted) return cancelled();

      return await new Promise<ProxyResponse>((resolveRaw) => {
        const id = nextId();
        const remaining = Math.max(0, deadline - Date.now());
        // A progress token also ties relayed sampling / elicitation requests to their caller.
        const relayed = caller !== undefined && this.relays(session).length > 0;
        const progressToken = onProgress || relayed ? `mcp-gateway-${id}` : undefined;
        if (progressToken && onProgress) session.progress.set(progressToken, onProgress);
        const callerEntry = relayed ? { token: progressToken, caller: caller! } : undefined;
        if (callerEntry) session.callers.push(callerEntry);
        const resolve = (r: ProxyResponse) => {
          if (progressToken) session.progress.delete(progressToken);
          if (callerEntry) {
            const i = session.callers.indexOf(callerEntry);
            if (i >= 0) session.callers.splice(i, 1);
          }
          resolveRaw(r);
        };

        // Ask the server to stop working on it, then free channel resources.
        const cancelUpstream = (reason: string) => {
          void session.channel
            .send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason } })
            .catch(() => {})
            .finally(() => session.channel.abandon?.(id));
        };
        const onAbort = () => {
          if (!session.pendingRequests.has(id)) return;
          clearTimeout(timer);
          session.pendingRequests.delete(id);
          cancelUpstream('cancelled by client');
          resolve(cancelled());
        };
        const settle = (response: ProxyResponse) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(response);
        };

        const timer = setTimeout(() => {
          session.pendingRequests.delete(id);
          signal?.removeEventListener('abort', onAbort);
          cancelUpstream('timeout');
          resolve(timedOut());
        }, remaining);

        session.pendingRequests.set(id, {
          resolve: (response) => settle({ ...response, durationMs: Date.now() - startTime }),
          reject: (err) => settle(notConnected(err.message)),
          timer,
        });
        signal?.addEventListener('abort', onAbort, { once: true });

        let sendParams = params;
        if (progressToken) {
          const base = isPlainObject(params) ? params : {};
          const meta = isPlainObject(base._meta) ? base._meta : {};
          sendParams = { ...base, _meta: { ...meta, progressToken } };
        }
        const payload: JsonRpcMessage =
          sendParams === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params: sendParams };
        session.channel.send(payload).catch((err: unknown) => {
          const pending = session.pendingRequests.get(id);
          if (!pending) return; // already answered / timed out
          clearTimeout(timer);
          session.pendingRequests.delete(id);
          const message = err instanceof Error ? err.message : String(err);
          settle(notConnected(`Request to "${serverId}" failed: ${message}`));
        });
      });
    } finally {
      release?.();
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}
