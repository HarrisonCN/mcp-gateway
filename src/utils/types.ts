import type { Deprecation } from './deprecations.js';
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
  /**
   * Forward this server's sampling / elicitation / roots requests to the downstream MCP client that made the
   * call (default true; `mcp.passthrough` sets which features). `false` keeps the server isolated.
   */
  passthrough?: boolean;
  /** Expose only some of this server's tools (glob patterns; deny wins) */
  tools?: ToolFilterConfig;
  /** Extra upstream endpoints for this server (load balancing + failover). Fields override the primary's. */
  replicas?: ReplicaConfig[];
  /** How calls are spread over the primary and its replicas. */
  loadBalancing?: LoadBalancingConfig;
  /** Relative weight for `strategy: weighted` (default 1). */
  weight?: number;
  /** Set on the internal replica servers (`<id>~<n>`): id of the logical server. */
  replicaOf?: string;
}

/** One replica of a server: transport fields that differ from the primary. */
export interface ReplicaConfig {
  name?: string;
  transport?: McpServerConfig['transport'];
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  weight?: number;
  enabled?: boolean;
}

export interface LoadBalancingConfig {
  /** `round-robin` (default), `random`, `weighted`, `least-latency` or `failover` (primary first). */
  strategy?: 'round-robin' | 'random' | 'weighted' | 'least-latency' | 'failover';
  /** Failure kinds retried on the next member (default `[not-connected]`; `timeout` / `error` may re-run a tool). */
  failoverOn?: Array<'not-connected' | 'timeout' | 'error'>;
  /** Extra attempts per call (default: members - 1). */
  retries?: number;
  /** Consecutive failed calls before a member is ejected (default 3, 0 = never). */
  ejectAfter?: number;
  /** How long an ejected member is skipped (ms, default 30000). */
  ejectMs?: number;
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
  /** Config schema version (`3`; optional). */
  version?: 3;
  /** CORS: allowed browser origins (default `["*"]`). */
  cors?: { origins?: string[] };
  /** Health checks: ping interval (ms, default 30000). Restart required. */
  health?: { intervalMs?: number };
  /** Admin REST API (`/api/v1/admin`). */
  admin?: AdminConfig;
  /** Deprecated keys found by `loadConfig` (set by the loader). */
  deprecations?: Deprecation[];
  /** Log level */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  /** Automatic reconnect of crashed / disconnected servers */
  reconnect?: Partial<ReconnectConfig>;
  /** Web dashboard */
  dashboard?: { enabled?: boolean };
  /** Downstream MCP endpoint (Streamable HTTP) that aggregates every server */
  mcp?: McpEndpointConfig;
  /** Persistent audit log of requests (optional SQLite) */
  audit?: AuditConfig;
  /** Hardening options (headers, body limits, IP allowlist, DNS-rebinding protection, lockout, redaction). */
  security?: SecurityConfig;
  /** Shared state for multi-instance deployments (rate limits, lockouts, MCP sessions). */
  state?: StateConfig;
  /** Tracing (OpenTelemetry / OTLP). */
  observability?: ObservabilityConfig;
  /** Tool policy: argument rules, human approval, output filtering. */
  policy?: ToolPolicyConfig;
  /** Usage quotas and metering export. */
  quotas?: QuotasConfig;
  /** Upstream catalog (one-click add of well-known MCP servers). */
  catalog?: CatalogConfig;
  /** Tenants / workspaces with owner / admin / viewer roles. */
  tenants?: TenantConfig[];
  /** Tool result caching (per-tool opt-in) and in-flight de-duplication. */
  cache?: CacheConfig;
  /** Plugins (hooks: onRequest, onToolCall before policy, onResponse after the output filter). */
  plugins?: PluginConfig[];
  /** OpenAI-compatible tools proxy (`/openai/v1/tools`, `/tool_calls`, `/chat/completions`). */
  openai?: OpenAIBridgeConfig;
  /** A2A (Agent2Agent) bridge: agent card at `/.well-known/agent-card.json` + JSON-RPC endpoint. */
  a2a?: A2ABridgeConfig;
  /** Directory of the loaded config file (set by `loadConfig`; plugin paths resolve against it). */
  configDir?: string;
}

/** `admin:` — admin REST API. */
export interface AdminConfig {
  /** Allow `PUT /api/v1/admin/config` and `POST /api/v1/admin/reload` (default false; read-only endpoints are always on for operators). */
  configApi?: boolean;
}

/** `openai:` — OpenAI-compatible tools proxy. */
export interface OpenAIBridgeConfig {
  /** Serve the proxy (default true when the `openai:` block is present). */
  enabled?: boolean;
  /** Mount path (default "/openai/v1"). Restart required. */
  path?: string;
  /** Add the gateway tools to `chat/completions` requests (default true). */
  injectTools?: boolean;
  /** Maximum gateway tool-call rounds per `chat/completions` request (default 5). */
  maxToolRounds?: number;
  /** OpenAI-compatible upstream for `chat/completions` (omit to serve only `tools` / `tool_calls`). */
  upstream?: {
    /** e.g. https://api.openai.com/v1 */
    baseUrl: string;
    apiKey?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
  };
}

/** `a2a:` — Agent2Agent bridge. */
export interface A2ABridgeConfig {
  /** Serve the agent card and JSON-RPC endpoint (default false). */
  enabled?: boolean;
  /** JSON-RPC path (default "/a2a"). */
  path?: string;
  /** Public base URL advertised in the card (default: from the request). */
  url?: string;
  name?: string;
  description?: string;
  provider?: { organization: string; url?: string };
  /** Serve the agent card without authentication (skills = tools visible to anonymous callers). */
  public?: boolean;
  /** How long finished tasks stay readable via `tasks/get` (default 600 s). */
  taskRetentionSeconds?: number;
}

/** One `plugins:` entry. */
export interface PluginConfig {
  /** Path (relative to the config file) or package name of an ES module. */
  module: string;
  /** Override the plugin's own name. */
  name?: string;
  enabled?: boolean;
  /** Passed to a factory export as `ctx.options`. */
  options?: Record<string, unknown>;
}

// ─── Security ────────────────────────────────────────────────────────────────

export interface TracingConfig {
  enabled?: boolean;
  /** `otlp-http` (default, built-in OTLP/HTTP JSON exporter), `console`, or `otel-api` (use @opentelemetry/api). */
  exporter?: 'otlp-http' | 'console' | 'otel-api';
  /** OTLP traces endpoint (default env OTEL_EXPORTER_OTLP_TRACES_ENDPOINT or http://localhost:4318/v1/traces). */
  endpoint?: string;
  headers?: Record<string, string>;
  serviceName?: string;
  resourceAttributes?: Record<string, string>;
  /** Fraction of new traces recorded (0–1, default 1). Incoming sampled `traceparent`s are always followed. */
  sampleRatio?: number;
  flushIntervalMs?: number;
}

/** One argument condition of a policy rule (all given operators must hold). */
export interface PolicyArgMatcher {
  /** Dotted path into the tool arguments (`path`, `options.mode`, `files.0`). */
  path: string;
  exists?: boolean;
  equals?: string | number | boolean;
  in?: Array<string | number | boolean>;
  /** Value matches one of these globs. */
  glob?: string[];
  /** Value is present and matches none of these globs. */
  notGlob?: string[];
  regex?: string;
  /** Value is present and does not match this regex. */
  notRegex?: string;
  /** String form is longer than this. */
  longerThan?: number;
  /** Path (normalised, `..` resolved) is inside one of these directories. */
  under?: string[];
  /** Path (normalised) is present and outside all of these directories. */
  notUnder?: string[];
}

export interface PolicyRule {
  name?: string;
  effect: 'allow' | 'deny' | 'approve';
  /** Globs on the client id (`key:aura`, `oauth:*`, `anonymous`). */
  clients?: string[];
  servers?: string[];
  /** Globs on tool names; patterns containing `/` match `<server>/<tool>`. */
  tools?: string[];
  args?: PolicyArgMatcher[];
  /** Shown to the client when the rule denies / holds a call. */
  message?: string;
}

export interface OutputFilterConfig {
  enabled?: boolean;
  /** `redact` (default), `flag` or `block`. */
  action?: 'flag' | 'redact' | 'block';
  /** Use the built-in prompt-injection detectors (default true). */
  builtins?: boolean;
  /** Extra regexes (case-insensitive). */
  patterns?: string[];
  /** Only filter these tools (globs, `<server>/<tool>` allowed). Default: all. */
  tools?: string[];
}

/** A policy unit test (`policy.tests` or a policy file's `tests`), run by `mcp-gateway policy test`. */
export interface PolicyTest {
  name?: string;
  call: { client?: string; server: string; tool: string; args?: Record<string, unknown> };
  expect: 'allow' | 'deny' | 'approve';
  /** Expected matching rule name (optional). */
  rule?: string;
}

export interface ToolPolicyConfig {
  rules?: PolicyRule[];
  /** Policy-as-code files (YAML / JSON, relative to the config file) appended after the inline rules. */
  files?: string[];
  /** Policy unit tests. */
  tests?: PolicyTest[];
  /** Decision when no rule matches (default `allow`). */
  default?: 'allow' | 'deny' | 'approve';
  approval?: {
    /** How long a held call waits for a decision (default 300 s; then denied). */
    timeoutSeconds?: number;
    /** Allow a client to approve its own call (default false). */
    allowSelfApproval?: boolean;
  };
  outputFilter?: OutputFilterConfig;
}

export interface ObservabilityConfig {
  tracing?: TracingConfig;
}

/** `state` — where rate-limit windows, lockouts and MCP session metadata live. */
export interface StateConfig {
  /** `memory` (default, single instance) or `redis` (shared between instances). */
  store?: 'memory' | 'redis';
  redis?: {
    /** `redis://[user:password@]host:port/db` or `rediss://…` (TLS). */
    url: string;
    /** Prefix for every key (default `mcp-gateway:`). */
    keyPrefix?: string;
    connectTimeoutMs?: number;
    commandTimeoutMs?: number;
  };
  /** When the store is unreachable: `open` (default) lets requests through, `closed` rejects them. */
  failureMode?: 'open' | 'closed';
}

export interface AuthLockoutConfig {
  /** Failed authentications from one IP within `windowSeconds` that trigger a lockout (default 10). */
  maxFailures?: number;
  /** Window for counting failures (default 300). */
  windowSeconds?: number;
  /** How long a locked-out IP gets `429` (default 900). */
  lockoutSeconds?: number;
}

export interface SecurityConfig {
  /** Send security headers (nosniff, frame-ancestors, Referrer-Policy, CSP) on every response (default true). */
  headers?: boolean;
  /** Also send `Strict-Transport-Security` (only behind HTTPS; default false). */
  hsts?: boolean | { maxAgeSeconds?: number; includeSubDomains?: boolean };
  /**
   * Express "trust proxy" setting: false (default), true, a hop count, or a
   * list of trusted proxy addresses / CIDRs. Controls `req.ip` (rate limits,
   * lockout, IP allowlist, logs).
   */
  trustProxy?: boolean | number | string | string[];
  /** Only these client IPs / CIDRs may call the gateway (liveness / readiness probes stay open). */
  ipAllowlist?: string[];
  /** Accepted `Host` header values (hostnames, `host:port`, `*.example.com`). Unset = any (unless `dnsRebindingProtection`). */
  allowedHosts?: string[];
  /**
   * DNS-rebinding protection (default false): `Host` must be in
   * `allowedHosts` (default: localhost names + the bind address), and `/mcp`
   * accepts browser requests only from the same origin or loopback origins
   * unless `mcp.allowedOrigins` / `cors.origins` list others.
   */
  dnsRebindingProtection?: boolean;
  /** Maximum JSON request body in bytes (default 10 MiB). */
  maxBodyBytes?: number;
  /** Maximum size of a tool call's / prompt's `arguments` as JSON, in bytes (default 0 = no limit). */
  maxToolArgumentsBytes?: number;
  /** Lock out IPs after repeated authentication failures (off unless set; `true` = defaults). */
  authLockout?: boolean | AuthLockoutConfig;
  /** Extra regular expressions whose matches are masked in logs, the request log / audit log and API output. */
  redactPatterns?: string[];
  /** Include error messages / stack traces of unexpected 500s in responses (default false; NODE_ENV=development also enables it). */
  exposeErrorDetails?: boolean;
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
  /** Origins allowed to call the endpoint from a browser (default: `cors.origins`). */
  allowedOrigins?: string[];
  /** Optional `instructions` returned from `initialize`. */
  instructions?: string;
  /** Events kept per session for `Last-Event-ID` resumability (default 256, 0 = off). */
  eventBufferSize?: number;
  /** Server→client request passthrough (sampling, elicitation, roots) to downstream clients. */
  passthrough?: McpPassthroughConfig;
}

/** Which upstream→client requests are relayed to the downstream client that made the call (3.1). */
export interface McpPassthroughConfig {
  /** `sampling/createMessage` (default true). */
  sampling?: boolean;
  /** `elicitation/create` (default true). */
  elicitation?: boolean;
  /** `roots/list` and `notifications/roots/list_changed` (default true). */
  roots?: boolean;
  /** How long to wait for the downstream client's answer (default 300). */
  timeoutSeconds?: number;
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
  /** For jwt: HMAC secret (HS256/384/512). Not needed when `jwt.jwksUrl` or `jwt.publicKey` is set. */
  jwtSecret?: string;
  /** For jwt: verification options (issuer, audience, algorithms, JWKS, clock skew). */
  jwt?: JwtConfig;
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
  /** For oauth2: OAuth 2.1 resource-server settings (MCP authorization spec). */
  oauth?: OAuthConfig;
}

/** `auth.oauth` — the gateway as an OAuth 2.1 protected resource (RFC 9728 / RFC 8707 / RFC 7662). */
export interface OAuthConfig {
  /** Authorization server issuer URLs advertised in the protected-resource metadata. */
  authorizationServers: string[];
  /** Canonical resource URI (default: `<scheme>://<host><mcp.path>` of the request). */
  resource?: string;
  /** Accepted `iss` values (default: `authorizationServers`). */
  issuer?: string | string[];
  /** Accepted `aud` values (default: the resource URI). */
  audience?: string | string[];
  /** JWKS for JWT access tokens (default: `jwks_uri` discovered from the issuer metadata). */
  jwksUrl?: string;
  jwksCacheSeconds?: number;
  /** Accepted JWT algorithms (asymmetric only; default RS/PS/ES/EdDSA). */
  algorithms?: string[];
  clockToleranceSeconds?: number;
  /** RFC 7662 token introspection for opaque tokens. */
  introspection?: {
    url: string;
    clientId?: string;
    clientSecret?: string;
    /** Cache active results (seconds, default 60, capped at token expiry). */
    cacheSeconds?: number;
    /** Reject introspected tokens without `aud` (default true). */
    requireAudience?: boolean;
    /** Introspect JWTs too instead of verifying them locally. */
    preferForJwt?: boolean;
  };
  /** `scopes_supported` in the metadata. */
  scopesSupported?: string[];
  /** Scopes every token must carry (else 403 insufficient_scope). */
  requiredScopes?: string[];
  resourceName?: string;
  documentation?: string;
}

export interface JwtConfig {
  /** Required `iss` claim (string or list). */
  issuer?: string | string[];
  /** Required `aud` claim (string or list; the token must contain one of them). */
  audience?: string | string[];
  /**
   * Accepted `alg` values. Default: HS256/384/512 with `jwtSecret`,
   * RS/PS/ES 256-512 + EdDSA with `publicKey` / `jwksUrl`. Mixing HMAC and
   * asymmetric algorithms is rejected (algorithm confusion).
   */
  algorithms?: string[];
  /** Allowed clock skew for `exp` / `nbf` / `iat` (seconds, default 0). */
  clockToleranceSeconds?: number;
  /** Fetch verification keys from a JWKS endpoint (cached, refreshed on unknown `kid`). */
  jwksUrl?: string;
  /** How long fetched JWKS are cached (seconds, default 600). */
  jwksCacheSeconds?: number;
  /** PEM-encoded public key (SPKI) or X.509 certificate for RS/PS/ES/EdDSA tokens. */
  publicKey?: string;
  /** Reject tokens without an `exp` claim (default false). */
  requireExp?: boolean;
  /** Reject tokens whose `iat` is older than this (seconds). */
  maxTokenAgeSeconds?: number;
}

export interface ApiKeyConfig {
  /**
   * The secret key (supports ${VAR} via env overrides in the config file), or
   * its SHA-256 digest as `sha256:<64 hex chars>` (see `mcp-gateway hash-key`).
   */
  key: string;
  /** Reject the key from this moment on (ISO 8601 date / date-time). */
  expiresAt?: string;
  /** Temporarily reject the key without removing it. */
  disabled?: boolean;
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
  /** Forward every record to SIEM targets (works with or without the SQLite store). */
  export?: AuditExportTarget[];
}

interface AuditExportCommon {
  enabled?: boolean;
  /** Only export these kinds (default all). */
  kinds?: Array<'tool' | 'resource' | 'prompt'>;
  /** Only export failed requests. */
  failuresOnly?: boolean;
  /** Records per send (default 1 for syslog, 100 for webhooks). */
  batchSize?: number;
  /** Max wait before a partial batch is sent (default 1000 ms). */
  flushIntervalMs?: number;
  /** Retries per batch (default 2, exponential backoff). */
  retries?: number;
  /** Queue bound; oldest records are dropped beyond it (default 10000). */
  maxQueue?: number;
}

/** One `audit.export` target: RFC 5424 syslog or an HTTP webhook. */
export type AuditExportTarget =
  | (AuditExportCommon & {
      type: 'syslog';
      host: string;
      /** Default 514 (udp / tcp) or 6514 (tls). */
      port?: number;
      protocol?: 'udp' | 'tcp' | 'tls';
      facility?: string;
      appName?: string;
    })
  | (AuditExportCommon & {
      type: 'webhook';
      url: string;
      headers?: Record<string, string>;
      /** `json` (default: `{ "events": [...] }`) or `ndjson`. */
      format?: 'json' | 'ndjson';
      timeoutMs?: number;
    });

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

// ─── Cache ───────────────────────────────────────────────────────────────────

export interface CacheRule {
  /** Server id globs (default: all). */
  servers?: string[];
  /** Tool globs (`search_*`, or `server/tool` globs). Default: all tools of the matched servers. */
  tools?: string[];
  /** Time to live (seconds, default `cache.defaultTtlSeconds`). */
  ttlSeconds?: number;
  /** `client` (default): one cache per caller; `shared`: one for everybody. */
  scope?: 'client' | 'shared';
  /** Share identical in-flight calls (default true). */
  dedupe?: boolean;
  /** Only de-duplicate in-flight calls, never cache. */
  dedupeOnly?: boolean;
}

export interface CacheConfig {
  enabled?: boolean;
  /** Most entries kept (LRU, default 1000). */
  maxEntries?: number;
  defaultTtlSeconds?: number;
  /** First matching rule wins; tools that match no rule are never cached. */
  rules?: CacheRule[];
}

// ─── Tenants ─────────────────────────────────────────────────────────────────

export type TenantRole = 'owner' | 'admin' | 'viewer';

export interface TenantMember {
  /** Client id glob: `key:<api key name>`, `jwt:<sub>`, `oauth:<sub>`, … */
  client: string;
  role: TenantRole;
}

export interface TenantConfig {
  id: string;
  name?: string;
  /** Server id globs that belong to the tenant. */
  servers: string[];
  members?: TenantMember[];
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

export interface CatalogConfig {
  /** Include the built-in entries (default true). */
  builtins?: boolean;
  /** Extra catalogs: JSON files (relative to the config file) or http(s) URLs. */
  sources?: string[];
  /** Allow installing entries through the API / dashboard (default false: it spawns processes). */
  install?: boolean;
  /** JSON file where installed servers are kept (relative to the config file). Absent = runtime only. */
  serversFile?: string;
}

// ─── Quotas / metering ───────────────────────────────────────────────────────

export interface QuotaRule {
  name?: string;
  /** Tool calls allowed per period. */
  limit: number;
  period: 'hour' | 'day' | 'month';
  /** Count per client (default) or per tenant. */
  per?: 'client' | 'tenant';
  /** Client id globs (per client) — default all. */
  clients?: string[];
  /** Tenant id globs — default all (per tenant), or only clients in these tenants (per client). */
  tenants?: string[];
  servers?: string[];
  tools?: string[];
}

export interface QuotasConfig {
  rules?: QuotaRule[];
  /** How long hourly metering buckets are kept (days, default 35). */
  meteringRetentionDays?: number;
}
