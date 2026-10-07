import { GatewayClient, GatewayError, type RequestOptions } from './client.js';
import type { CallToolResult } from './types.js';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: { name: string; version: string; title?: string };
  instructions?: string;
}

/** A JSON-RPC error returned by the MCP endpoint. */
export class McpError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

export interface McpSessionOptions {
  /** Endpoint path (default `/mcp`). */
  path?: string;
  clientInfo?: { name: string; version: string };
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
}

/**
 * Minimal MCP Streamable HTTP client for the gateway's `/mcp` endpoint
 * (request/response only; no server→client notification stream). For a
 * full-featured client use `@modelcontextprotocol/sdk` — the gateway is a
 * standard MCP server.
 */
export class McpSession {
  private sessionId?: string;
  private protocolVersion?: string;
  private seq = 0;
  private readonly path: string;
  /** Result of `initialize` once connected. */
  info?: McpInitializeResult;

  constructor(
    private readonly gateway: GatewayClient,
    private readonly options: McpSessionOptions = {},
  ) {
    this.path = options.path ?? '/mcp';
  }

  get id(): string | undefined {
    return this.sessionId;
  }

  /** `initialize` + `notifications/initialized`. */
  async connect(options?: RequestOptions): Promise<McpInitializeResult> {
    const res = await this.post(
      {
        jsonrpc: '2.0',
        id: ++this.seq,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: this.options.clientInfo ?? { name: 'mcp-gateway-client', version: '0.1.0' },
        },
      },
      options,
    );
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const info = (await this.read(res)) as McpInitializeResult;
    this.info = info;
    this.protocolVersion = info.protocolVersion;
    await this.notify('notifications/initialized');
    return info;
  }

  /** Every tool (follows `nextCursor`). */
  async listTools(options?: RequestOptions): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const r = (await this.request('tools/list', cursor ? { cursor } : undefined, options)) as {
        tools: McpTool[];
        nextCursor?: string;
      };
      tools.push(...(r.tools ?? []));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  /**
   * `tools/call`. Aborting `options.signal` sends `notifications/cancelled`,
   * which the gateway forwards to the upstream server.
   */
  async callTool<R = CallToolResult>(name: string, args: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<R> {
    return (await this.request('tools/call', { name, arguments: args }, options)) as R;
  }

  async ping(options?: RequestOptions): Promise<void> {
    await this.request('ping', undefined, options);
  }

  /** Send any JSON-RPC request and return its `result`. */
  async request(method: string, params?: unknown, options: RequestOptions = {}): Promise<unknown> {
    if (!this.sessionId) throw new GatewayError('Not connected: call connect() first', 0);
    const id = ++this.seq;
    const onAbort = () => {
      void this.notify('notifications/cancelled', { requestId: id, reason: 'aborted by client' }).catch(() => {});
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await this.post({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }, options);
      return await this.read(res, id);
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const res = await this.post({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
    await res.text().catch(() => '');
  }

  /** End the session (`DELETE`). */
  async close(): Promise<void> {
    if (!this.sessionId) return;
    const res = await this.gateway.rawFetch(this.path, { method: 'DELETE', headers: this.headers() });
    await res.text().catch(() => '');
    this.sessionId = undefined;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    if (this.protocolVersion) h['MCP-Protocol-Version'] = this.protocolVersion;
    return h;
  }

  private async post(message: unknown, options: RequestOptions = {}): Promise<Response> {
    const res = await this.gateway.rawFetch(
      this.path,
      {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify(message),
      },
      options,
    );
    if (!res.ok && res.status !== 202) {
      const text = await res.text().catch(() => '');
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* keep text */
      }
      const err = (body as JsonRpcResponse | undefined)?.error;
      if (res.status === 404 && this.sessionId) this.sessionId = undefined; // session expired
      throw new GatewayError(err?.message ?? `HTTP ${res.status}`, res.status, body);
    }
    return res;
  }

  /** Parse a JSON or SSE response and return the result for `id`. */
  private async read(res: Response, id?: number): Promise<unknown> {
    const type = res.headers.get('content-type') ?? '';
    let messages: JsonRpcResponse[] = [];
    if (type.includes('text/event-stream')) {
      const text = await res.text();
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (data) messages.push(JSON.parse(data) as JsonRpcResponse);
      }
    } else {
      const body = (await res.json()) as JsonRpcResponse | JsonRpcResponse[];
      messages = Array.isArray(body) ? body : [body];
    }
    const reply = messages.find((m) => m.method === undefined && (id === undefined || m.id === id));
    if (!reply) throw new GatewayError('No JSON-RPC response in reply', res.status);
    if (reply.error) throw new McpError(reply.error.message, reply.error.code, reply.error.data);
    return reply.result;
  }
}

/** Open an MCP session on the gateway's `/mcp` endpoint. */
export async function connectMcp(gateway: GatewayClient, options?: McpSessionOptions): Promise<McpSession> {
  const s = new McpSession(gateway, options);
  await s.connect();
  return s;
}
