/**
 * Core type definitions for mcp-gateway
 */

// ─── Server Registry ──────────────────────────────────────────────────────────

export type ServerTransport = 'stdio' | 'sse' | 'websocket';
export type ServerStatus = 'online' | 'offline' | 'degraded' | 'unknown';

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
  /** For sse/websocket: URL to connect to */
  url?: string;
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
}

export interface ServerHealth {
  serverId: string;
  status: ServerStatus;
  lastChecked: Date;
  latencyMs?: number;
  errorMessage?: string;
  toolCount?: number;
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
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export type AuthStrategy = 'none' | 'api-key' | 'jwt' | 'oauth2';

export interface AuthConfig {
  strategy: AuthStrategy;
  /** For api-key: list of valid keys */
  apiKeys?: string[];
  /** For jwt: secret or public key */
  jwtSecret?: string;
  /** For oauth2: provider config */
  oauth2?: {
    issuer: string;
    audience: string;
  };
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
  description?: string;
  inputSchema?: Record<string, unknown>;
  serverId: string;
  serverName: string;
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
