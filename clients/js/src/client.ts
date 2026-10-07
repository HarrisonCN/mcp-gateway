import type {
  CallToolResponse,
  CallToolResult,
  HealthResponse,
  MetricsResponse,
  ReadinessResponse,
  RequestRecord,
  RequestQuery,
  RequestPage,
  Resource,
  ResourceTemplate,
  Prompt,
  ReadResourceResponse,
  GetPromptResponse,
  ServerDetails,
  ServerSummary,
  Tool,
  ToolSchemaFormat,
  ToolSchemasResponse,
} from './types.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GatewayClientOptions {
  /** Gateway base URL, e.g. `http://localhost:4000` (no `/api/v1`). */
  baseUrl: string;
  /** API key (sent as `Authorization: Bearer …`). */
  apiKey?: string;
  /** JWT (sent as `Authorization: Bearer …`). Ignored when `apiKey` is set. */
  token?: string | (() => string | undefined | Promise<string | undefined>);
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  /** Custom fetch (defaults to the global `fetch`). */
  fetch?: FetchLike;
  /** Per-request timeout in ms (default 60000; 0 = none). */
  timeoutMs?: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Override the client's timeout for this call. */
  timeoutMs?: number;
}

export interface CallToolOptions extends RequestOptions {
  /** Server id; required when the tool name exists on several servers. */
  server?: string;
}

/** Error for non-2xx responses (and network / timeout failures, with `status` 0). */
export class GatewayError extends Error {
  constructor(
    message: string,
    /** HTTP status (0 for network errors and timeouts). */
    readonly status: number,
    /** Parsed response body, when there was one. */
    readonly body?: unknown,
    /** `Retry-After` in seconds for 429 / 503 responses. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'GatewayError';
  }

  /** Gateway error code from the body (`-32003` policy denied, `-32004` approval rejected, `-32005` output blocked, `-32006` plugin refused, …). */
  get code(): number | undefined {
    return isRecord(this.body) && typeof this.body.code === 'number' ? this.body.code : undefined;
  }

  /** True when a gateway policy (rule, approval or output filter) refused the call. */
  get isPolicyError(): boolean {
    return this.code === -32003 || this.code === -32004 || this.code === -32005 || this.code === -32006;
  }
}

/** A tool call held by a policy rule with `effect: approve` (`GET /approvals`). */
export interface ApprovalRequest {
  id: string;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
  clientId?: string;
  serverId: string;
  tool: string;
  arguments: unknown;
  rule?: string;
  message?: string;
  via: 'rest' | 'mcp';
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
}

/**
 * Typed client for the mcp-gateway REST API. Uses only `fetch`, so it runs in
 * browsers, Node 18+, Deno, Bun and React Native.
 */
export class GatewayClient {
  readonly baseUrl: string;
  private readonly opts: GatewayClientOptions;
  private readonly fetchImpl: FetchLike;

  constructor(options: GatewayClientOptions) {
    if (!options?.baseUrl) throw new TypeError('baseUrl is required');
    this.opts = options;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    const f = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) throw new TypeError('No fetch implementation available; pass options.fetch');
    this.fetchImpl = (input, init) => f(input, init);
  }

  // ─── Health ─────────────────────────────────────────────────────────────────

  /** `GET /health` — gateway status and server summary (207 "degraded" is not an error). */
  health(options?: RequestOptions): Promise<HealthResponse> {
    return this.request('GET', '/api/v1/health', undefined, options, [207]);
  }

  /** `GET /health/ready` — resolves with the readiness body for both 200 and 503. */
  async ready(min?: number, options?: RequestOptions): Promise<ReadinessResponse & { ready: boolean }> {
    const q = min === undefined ? '' : `?min=${encodeURIComponent(String(min))}`;
    const body = await this.request<ReadinessResponse>('GET', `/api/v1/health/ready${q}`, undefined, options, [503]);
    return { ...body, ready: body.status === 'ready' };
  }

  /** `GET /metrics` (JSON). `windowMs` limits the aggregation window. */
  metrics(windowMs?: number, options?: RequestOptions): Promise<MetricsResponse> {
    const q = windowMs === undefined ? '?format=json' : `?format=json&window=${windowMs}`;
    return this.request('GET', `/api/v1/metrics${q}`, undefined, options);
  }

  // ─── Servers ────────────────────────────────────────────────────────────────

  /** `GET /servers` — servers visible to this key. */
  async servers(options?: RequestOptions): Promise<ServerSummary[]> {
    const body = await this.request<{ servers: ServerSummary[] }>('GET', '/api/v1/servers', undefined, options);
    return body.servers;
  }

  /** `GET /servers/:id` — one server with its tools. */
  server(id: string, options?: RequestOptions): Promise<ServerDetails> {
    return this.request('GET', `/api/v1/servers/${encodeURIComponent(id)}`, undefined, options);
  }

  /** `POST /servers/:id/reconnect` — reconnect now (resets backoff). */
  reconnect(id: string, options?: RequestOptions): Promise<{ server: string; connected: boolean }> {
    return this.request('POST', `/api/v1/servers/${encodeURIComponent(id)}/reconnect`, undefined, options, [502]);
  }

  // ─── Tools ──────────────────────────────────────────────────────────────────

  /** `GET /tools` — every tool visible to this key (optionally one server / tag). */
  async listTools(filter: { server?: string; tag?: string } = {}, options?: RequestOptions): Promise<Tool[]> {
    const body = await this.request<{ tools: Tool[] }>('GET', `/api/v1/tools${query(filter)}`, undefined, options);
    return body.tools;
  }

  /**
   * `GET /tools?format=` — tool schemas ready for an LLM API
   * (`openai` Chat Completions, `openai-responses`, `anthropic`).
   */
  toolSchemas(
    format: ToolSchemaFormat,
    filter: { server?: string; tag?: string } = {},
    options?: RequestOptions,
  ): Promise<ToolSchemasResponse> {
    return this.request('GET', `/api/v1/tools${query({ ...filter, format })}`, undefined, options);
  }

  /** `POST /tools/call` — call a tool (auto-routed unless `server` is given). */
  callTool<R = CallToolResult>(
    tool: string,
    args: Record<string, unknown> = {},
    options: CallToolOptions = {},
  ): Promise<CallToolResponse<R>> {
    const body: Record<string, unknown> = { tool, arguments: args };
    if (options.server) body.server = options.server;
    return this.request('POST', '/api/v1/tools/call', body, options);
  }

  /**
   * Execute a tool call an LLM produced from {@link toolSchemas}: resolves the
   * LLM tool name through `mapping` and calls the right server.
   */
  callLlmTool<R = CallToolResult>(
    schemas: Pick<ToolSchemasResponse, 'mapping'>,
    name: string,
    args: Record<string, unknown> | string = {},
    options: RequestOptions = {},
  ): Promise<CallToolResponse<R>> {
    const target = schemas.mapping[name];
    if (!target) return Promise.reject(new GatewayError(`Unknown LLM tool name "${name}"`, 0));
    const parsed = typeof args === 'string' ? (args ? (JSON.parse(args) as Record<string, unknown>) : {}) : args;
    return this.callTool<R>(target.tool, parsed, { ...options, server: target.server });
  }

  // ─── Requests ───────────────────────────────────────────────────────────────

  /** `GET /requests` — recent calls (newest first). */
  async requests(limit = 50, options?: RequestOptions): Promise<RequestRecord[]> {
    return (await this.history({ limit }, options)).requests;
  }

  /**
   * `GET /requests` with filters and cursor paging (from the persistent audit
   * log when the gateway has it enabled). Pass `nextCursor` back as `cursor`.
   */
  history(q: RequestQuery = {}, options?: RequestOptions): Promise<RequestPage> {
    const time = (v: RequestQuery['since']) => (v instanceof Date ? v.toISOString() : v);
    return this.request(
      'GET',
      `/api/v1/requests${query({
        limit: q.limit,
        server: q.server,
        tool: q.tool,
        client: q.client,
        success: q.success === undefined ? undefined : String(q.success),
        via: q.via,
        kind: q.kind,
        since: time(q.since),
        until: time(q.until),
        cursor: q.cursor,
      })}`,
      undefined,
      options,
    );
  }

  // ─── Resources & prompts (gateway ≥ 0.8) ───────────────────────────────────

  async listResources(filter: { server?: string } = {}, options?: RequestOptions): Promise<Resource[]> {
    return (await this.request<{ resources: Resource[] }>('GET', `/api/v1/resources${query(filter)}`, undefined, options)).resources;
  }

  async listResourceTemplates(filter: { server?: string } = {}, options?: RequestOptions): Promise<ResourceTemplate[]> {
    const body = await this.request<{ resourceTemplates: ResourceTemplate[] }>(
      'GET', `/api/v1/resources/templates${query(filter)}`, undefined, options,
    );
    return body.resourceTemplates;
  }

  readResource(uri: string, options: CallToolOptions = {}): Promise<ReadResourceResponse> {
    return this.request('POST', '/api/v1/resources/read', { uri, ...(options.server ? { server: options.server } : {}) }, options);
  }

  async listPrompts(filter: { server?: string } = {}, options?: RequestOptions): Promise<Prompt[]> {
    return (await this.request<{ prompts: Prompt[] }>('GET', `/api/v1/prompts${query(filter)}`, undefined, options)).prompts;
  }

  getPrompt(name: string, args: Record<string, string> = {}, options: CallToolOptions = {}): Promise<GetPromptResponse> {
    return this.request(
      'POST', '/api/v1/prompts/get', { name, arguments: args, ...(options.server ? { server: options.server } : {}) }, options,
    );
  }

  // ─── Approvals (gateway ≥ 1.6, operator keys) ───────────────────────────────

  /** `GET /approvals` — pending and recently decided held tool calls. */
  approvals(options?: RequestOptions): Promise<{ pending: ApprovalRequest[]; recent: ApprovalRequest[] }> {
    return this.request('GET', '/api/v1/approvals', undefined, options);
  }

  /** `POST /approvals/:id/approve`. */
  approve(id: string, reason?: string, options?: RequestOptions): Promise<ApprovalRequest> {
    return this.request('POST', `/api/v1/approvals/${encodeURIComponent(id)}/approve`, reason ? { reason } : {}, options);
  }

  /** `POST /approvals/:id/deny`. */
  deny(id: string, reason?: string, options?: RequestOptions): Promise<ApprovalRequest> {
    return this.request('POST', `/api/v1/approvals/${encodeURIComponent(id)}/deny`, reason ? { reason } : {}, options);
  }

  // ─── Plumbing ───────────────────────────────────────────────────────────────

  /** Authorization + custom headers for a request (also used by the MCP helper). */
  async authHeaders(): Promise<Record<string, string>> {
    const h: Record<string, string> = { ...(this.opts.headers ?? {}) };
    let bearer = this.opts.apiKey;
    if (!bearer && this.opts.token) bearer = typeof this.opts.token === 'function' ? await this.opts.token() : this.opts.token;
    if (bearer) h.Authorization = `Bearer ${bearer}`;
    return h;
  }

  /** fetch with auth headers and the client timeout (used by the MCP helper). */
  async rawFetch(path: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<Response> {
    const headers = { ...(await this.authHeaders()), ...((init.headers as Record<string, string> | undefined) ?? {}) };
    const timeoutMs = options.timeoutMs ?? this.opts.timeoutMs ?? 60_000;
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(options.signal?.reason);
    if (options.signal) {
      if (options.signal.aborted) ctrl.abort(options.signal.reason);
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            ctrl.abort();
          }, timeoutMs)
        : undefined;
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers, signal: ctrl.signal });
    } catch (err) {
      if (timedOut) throw new GatewayError(`Request timed out after ${timeoutMs}ms`, 0);
      if (options.signal?.aborted) throw err;
      throw new GatewayError(`Network error: ${err instanceof Error ? err.message : String(err)}`, 0);
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
    okStatuses: number[] = [],
  ): Promise<T> {
    const init: RequestInit = { method, headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { ...(init.headers as Record<string, string>), 'Content-Type': 'application/json' };
    }
    const res = await this.rawFetch(path, init, options);
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (res.ok || okStatuses.includes(res.status)) return parsed as T;
    const retry = res.headers.get('retry-after');
    const message =
      (isRecord(parsed) && typeof parsed.message === 'string' && parsed.message) ||
      (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === 'string' && parsed.error.message) ||
      (isRecord(parsed) && typeof parsed.error === 'string' && parsed.error) ||
      `HTTP ${res.status}`;
    throw new GatewayError(message, res.status, parsed, retry ? Number(retry) : undefined);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function query(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}
