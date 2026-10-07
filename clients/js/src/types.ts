/** Response types of the mcp-gateway REST API (`/api/v1`). */

export type ServerStatus = 'online' | 'offline' | 'degraded' | 'reconnecting' | 'unknown';

export interface Tool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  serverId: string;
  serverName: string;
}

export interface ReconnectState {
  state: 'idle' | 'scheduled' | 'connecting' | 'gave-up' | 'disabled';
  attempt: number;
  reconnects: number;
  nextAttemptAt?: string;
  lastError?: string;
  lastDisconnectAt?: string;
}

export interface ServerHealth {
  serverId: string;
  status: ServerStatus;
  /** ISO timestamp */
  lastChecked: string;
  latencyMs?: number;
  errorMessage?: string;
  toolCount?: number;
  connectedSince?: string;
  reconnect?: ReconnectState;
}

export interface SessionInfo {
  transport: string;
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string };
  connectedAt?: string;
}

export interface ServerSummary {
  id: string;
  name: string;
  description?: string;
  transport: 'stdio' | 'sse' | 'websocket' | 'streamable-http';
  tags?: string[];
  enabled?: boolean;
  timeout?: number;
  maxConcurrency?: number;
  url?: string;
  health?: ServerHealth;
  session?: SessionInfo;
  toolCount: number;
  [key: string]: unknown;
}

export interface ServerDetails extends Omit<ServerSummary, 'toolCount'> {
  tools: Tool[];
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  version: string;
  uptime: number;
  servers: {
    total: number;
    online: number;
    offline: number;
    degraded: number;
    reconnecting: number;
    unknown: number;
    totalTools: number;
  };
}

export interface ReadinessResponse {
  status: 'ready' | 'not_ready' | 'shutting_down';
  servers: { ready: number; total: number; required: number };
}

/** MCP `CallToolResult` as returned by the upstream server. */
export interface CallToolResult {
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

export interface CallToolResponse<R = CallToolResult> {
  result: R;
  server: string;
  tool: string;
  durationMs: number;
}

export interface RequestRecord {
  id: string;
  timestamp: string;
  serverId: string;
  toolName: string;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
  clientId?: string;
  via?: 'rest' | 'mcp';
  kind?: 'tool' | 'resource' | 'prompt';
}

export interface RequestQuery {
  limit?: number;
  server?: string;
  tool?: string;
  client?: string;
  success?: boolean;
  via?: 'rest' | 'mcp';
  kind?: 'tool' | 'resource' | 'prompt';
  /** ISO date, Date or epoch ms */
  since?: string | number | Date;
  until?: string | number | Date;
  cursor?: string;
}

export interface RequestPage {
  requests: RequestRecord[];
  nextCursor?: string;
  /** `audit` when the persistent audit log is enabled (gateway ≥ 0.8). */
  source?: 'audit' | 'memory';
}

export interface Resource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  serverId: string;
  serverName: string;
}

export interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  serverId: string;
  serverName: string;
}

export interface Prompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; title?: string; description?: string; required?: boolean }>;
  serverId: string;
  serverName: string;
}

export interface ReadResourceResponse {
  result: { contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }> };
  server: string;
  uri: string;
  durationMs: number;
}

export interface GetPromptResponse {
  result: { description?: string; messages: Array<{ role: 'user' | 'assistant'; content: Record<string, unknown> }> };
  server: string;
  name: string;
  durationMs: number;
}

export interface MetricsResponse {
  totalRequests: number;
  successRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  requestsPerMinute: number;
  topTools: Array<{ name: string; count: number }>;
  topServers: Array<{ id: string; count: number }>;
  errorsByServer: Record<string, number>;
  servers: Array<{ id: string; status: string; up: number; reconnects: number; reconnectAttempt: number; latencyMs?: number }>;
}

export type ToolSchemaFormat = 'openai' | 'openai-responses' | 'anthropic';

export interface ToolSchemasResponse {
  format: ToolSchemaFormat;
  /** Pass as the provider's `tools` parameter. */
  tools: Array<Record<string, unknown>>;
  /** LLM tool name → gateway target. */
  mapping: Record<string, { server: string; tool: string }>;
  total: number;
}
