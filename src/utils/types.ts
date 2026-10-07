/**
 * Core type definitions for mcp-gateway
 */

// ─── Server Registry ──────────────────────────────────────────────────────────

export type ServerTransport = 'stdio' | 'sse' | 'websocket' | 'streamable-http';
/**
 * - `online`: connected and answering
 * - `degraded`: connected but the last health ping failed
 * - `reconnecting`: connection lost, an automatic reconnect is scheduled / running
 * - `offline`: not connected and no reconnect pending (disabled, or gave up)
 */
export type ServerStatus = 'online' | 'offline' | 'degraded' | 'reconnecting' | 'unknown';

export interface ReconnectConfig {
  /** Reconnect servers that crash or disconnect (default true). */
  enabled: boolean;
  /** Delay before the first retry (ms, default 1000). */
  initialDelayMs: number;
  /** Upper bound for the delay (ms, default 60000). */
  maxDelayMs: number;
  /** Growth factor per failed attempt (default 2). */
  multiplier: number;
  /** Random jitter as a fraction of the delay, 0-1 (default 0.2). */
  jitter: number;
  /** Give up after this many consecutive failures; 0 = retry forever (default 0). */
  maxAttempts: number;
}

export interface ReconnectState {
  state: 'idle' | 'scheduled' | 'connecting' | 'gave-up' | 'disabled';
  /** Consecutive failed attempts since the last successful connection. */
  attempt: number;
  /** Successful reconnects since the gateway started. */
  reconnects: number;
  nextAttemptAt?: Date;
  lastError?: string;
  lastDisconnectAt?: Date;
}

export interface McpServerConfig {
  /** Unique identifier for this server */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Optional description */
  description?: string;
  /** Transport type */
  transport: ServerTransport;
  /** For stdio: command to run */
  command?: string;
  /** For stdio: command arguments */
  args?: string[];
  /** For sse/websocket/streamable-http: URL to connect to */
  url?: string;
  /** For sse/websocket/streamable-http: extra HTTP headers (supports ${VAR}) */
  headers?: Record<string, string>;
  /** For websocket: subprotocol to request (default "mcp"; "" for none) */
  subprotocol?: string;
  /** Per-server overrides for automatic reconnect */
  reconnect?: Partial<ReconnectConfig>;
  /** Environment variables to pass to the server process */
  env?: Record<string, string>;
  /** Tags for grouping and filtering */
  tags?: string[];
  /** Whether this server is enabled */
  enabled?: boolean;
  /** Timeout in milliseconds for tool calls */
  timeout?: number;
  /** Maximum concurrent requests */
  maxConcurrency?: number;
  /** Expose only some of this server's tools (glob patterns; deny wins) */
  tools?: ToolFilterConfig;
}

export interface ToolFilterConfig {
  /** Only tools matching at least one pattern are exposed (empty/absent = all). */
  allow?: string[];
  /** Tools matching any pattern are hidden, even if allowed. */
  deny?: string[];
}

export interface ServerHealth {
  serverId: string;
  status: ServerStatus;
  lastChecked: Date;
  latencyMs?: number;
  errorMessage?: string;
  toolCount?: number;
  /** When the current session was established. */
  connectedSince?: Date;
  /** Automatic reconnect bookkeeping. */
  reconnect?: ReconnectState;
}

// ─── Gateway Config ───────────────────────────────────────────────────────────

export interface GatewayConfig {
  /** Gateway HTTP port */
  port: number;
  /** Host to bind to */
  host: string;
  /** Authentication configuration */
  auth?: AuthConfig;
  /** Rate limiting configuration */
  rateLimit?: RateLimitConfig;
  /** Monitoring configuration */
  monitor?: MonitorConfig;
  /** Registered MCP servers */
  servers: McpServerConfig[];
  /** CORS origins */
  corsOrigins?: string[];
  /** Log level */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  /** Automatic reconnect of crashed / disconnected servers */
  reconnect?: Partial<ReconnectConfig>;
  /** Interval between health pings (ms, default 30000) */
  healthCheckIntervalMs?: number;
  /** Web dashboard */
  dashboard?: { enabled?: boolean };
  /** Downstream MCP endpoint (Streamable HTTP) that aggregates every server */
  mcp?: McpEndpointConfig;
  /** Persistent audit log of requests (optional SQLite) */
  audit?: AuditConfig;
}

// ─── Downstream MCP endpoint ─────────────────────────────────────────────────

/**
 * How tool names are exposed on `/mcp`:
 * - `auto` (default): a tool keeps its name unless another server exposes the
 *   same name; then every copy is exposed as `<serverId>__<tool>`.
 * - `prefix`: every tool is exposed as `<serverId>__<tool>`.
 */
export type ToolNaming = 'auto' | 'prefix';

export interface McpEndpointConfig {
  /** Serve the MCP endpoint (default true). Restart required. */
  enabled?: boolean;
  /** URL path (default "/mcp"). Restart required. */
  path?: string;
  /** Tool naming / collision strategy (default "auto"). */
  toolNaming?: ToolNaming;
  /** Tools per `tools/list` page (default 500). */
  pageSize?: number;
  /** Drop sessions idle (no requests, no open stream) for this long (default 1800). */
  sessionIdleTimeoutSeconds?: number;
  /** Upper bound on concurrent sessions; the least recently used idle one is evicted (default 1000). */
  maxSessions?: number;
  /** Origins allowed to call the endpoint from a browser (default: `corsOrigins`). */
  allowedOrigins?: string[];
  /** Optional `instructions` returned from `initialize`. */
  instructions?: string;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export type AuthStrategy = 'none' | 'api-key' | 'jwt' | 'oauth2';

export interface AuthConfig {
  strategy: AuthStrategy;
  /**
   * For api-key: valid keys. A plain string grants full access; an object can
   * restrict the key to some servers / tools and give it its own rate limit.
   */
  apiKeys?: Array<string | ApiKeyConfig>;
  /** For jwt: secret or public key */
  jwtSecret?: string;
  /**
   * Endpoints that are public by default and can be put behind auth.
   * The dashboard page itself is a static shell; when auth is on it asks for
   * a key and sends it with every API call.
   */
  protect?: {
    /** Require auth for GET /api/v1/health (default false). /api/v1/health/live stays public. */
    health?: boolean;
    /** Require auth for GET /api/v1/metrics, incl. Prometheus scrapes (default false). */
    metrics?: boolean;
  };
  /** For oauth2: provider config */
  oauth2?: {
    issuer: string;
    audience: string;
  };
}

export interface ApiKeyConfig {
  /** The secret key (supports ${VAR} via env overrides in the config file). */
  key: string;
  /** Label used in client ids, logs and metrics instead of the key fingerprint (unique). */
  name?: string;
  /** Server ids this key may use (glob patterns). Absent = all servers. */
  servers?: string[];
  /** Tools this key may use (globs on the tool name, or on "<serverId>/<tool>" when the pattern has a "/"). Absent = all tools. */
  tools?: string[];
  /** Own rate limit for this key (replaces the global `rateLimit`). */
  rateLimit?: { limit: number; windowSeconds: number };
}

// ─── Rate Limiting ────────────────────────────────────────────────────────────

export interface RateLimitConfig {
  /** Requests per window */
  limit: number;
  /** Window duration in seconds */
  windowSeconds: number;
  /** Whether to apply per-key or globally */
  perKey?: boolean;
}

// ─── Monitoring ───────────────────────────────────────────────────────────────

export interface MonitorConfig {
  /** Enable Prometheus metrics endpoint */
  prometheus?: boolean;
  /** Enable request logging */
  requestLog?: boolean;
  /** Retention period for metrics (hours) */
  retentionHours?: number;
}

export interface RequestMetric {
  id: string;
  timestamp: Date;
  serverId: string;
  toolName: string;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
  clientId?: string;
  tokenCount?: number;
  /** Which downstream interface served the call: REST API or the `/mcp` endpoint. */
  via?: 'rest' | 'mcp';
  /** What was called: a tool (default), a resource read (`toolName` = URI) or a prompt get. */
  kind?: 'tool' | 'resource' | 'prompt';
}

export interface AggregatedMetrics {
  totalRequests: number;
  successRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  requestsPerMinute: number;
  topTools: Array<{ name: string; count: number }>;
  topServers: Array<{ id: string; count: number }>;
  errorsByServer: Record<string, number>;
}

// ─── Proxy ────────────────────────────────────────────────────────────────────

export interface ProxyRequest {
  serverId: string;
  method: string;
  params?: unknown;
  requestId?: string | number;
}

export interface ProxyResponse {
  success: boolean;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
  durationMs: number;
}

// ─── Tool Registry ────────────────────────────────────────────────────────────

export interface ToolInfo {
  name: string;
  /** Human-readable title (MCP 2025-06-18), passed through from the server. */
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** JSON Schema of `structuredContent` (MCP 2025-06-18), passed through. */
  outputSchema?: Record<string, unknown>;
  /** Tool annotations (`readOnlyHint`, `destructiveHint`, …), passed through. */
  annotations?: Record<string, unknown>;
  serverId: string;
  serverName: string;
}

// ─── Resources & prompts (passthrough) ───────────────────────────────────────

export interface ResourceInfo {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  annotations?: Record<string, unknown>;
  serverId: string;
  serverName: string;
}

export interface ResourceTemplateInfo {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: Record<string, unknown>;
  serverId: string;
  serverName: string;
}

export interface PromptArgumentInfo {
  name: string;
  title?: string;
  description?: string;
  required?: boolean;
}

export interface PromptInfo {
  name: string;
  title?: string;
  description?: string;
  arguments?: PromptArgumentInfo[];
  serverId: string;
  serverName: string;
}

/** Resources, resource templates and prompts a server announced. */
export interface ServerCatalog {
  resources: ResourceInfo[];
  resourceTemplates: ResourceTemplateInfo[];
  prompts: PromptInfo[];
}

// ─── Audit log ───────────────────────────────────────────────────────────────

export interface AuditConfig {
  /** Persist every request record to SQLite (default false; needs Node 22.5+ `node:sqlite`). */
  enabled?: boolean;
  /** Database file (default "mcp-gateway-audit.db", relative to the working directory). */
  path?: string;
  /** Delete records older than this many days (default 30; 0 = keep forever). */
  retentionDays?: number;
}

// ─── JSON-RPC (used by network transports) ───────────────────────────────────

export interface MCPRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: unknown;
}

export interface MCPResponse {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
  params?: unknown;
}
