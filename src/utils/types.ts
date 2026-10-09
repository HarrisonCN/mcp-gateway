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
  /** 4.5: mTLS / SPIFFE settings for an HTTPS upstream. */
  tls?: import('../security/mtls.js').ServerTlsConfig;
  /** 4.4: calls allowed to wait for a `maxConcurrency` slot; beyond it calls fail fast with `-32014` (default unbounded). */
  maxQueue?: number;
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
  /** Relative cost per call, for `strategy: smart` (3.4). */
  cost?: number;
  /** Where the server processes data, e.g. `eu-west-1` (3.7: data residency). */
  region?: string;
  /** Per-call credentials from `secrets:` providers, per tenant / client (3.5). */
  inject?: SecretInjection[];
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
  /** Relative cost per call, for `strategy: smart` (3.4). */
  cost?: number;
  enabled?: boolean;
}

export interface LoadBalancingConfig {
  /** `round-robin` (default), `random`, `weighted`, `failover` (primary first) or `smart` (3.4). `least-latency` was removed in 4.0. */
  strategy?: 'round-robin' | 'random' | 'weighted' | 'failover' | 'smart';
  /** `smart` only: weights of the score terms (defaults latency 1, errorRate 1, cost 0). */
  score?: { latency?: number; errorRate?: number; cost?: number };
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
  /** Ecosystem marketplace GA (9.8). */
  ecosystem?: import('../features/ecosystem.js').EcosystemConfig;
  /** Post-quantum TLS (9.7). */
  postQuantumTls?: import('../features/pq-tls.js').PqTlsConfig;
  /** Self-healing (9.6). */
  selfHealing?: import('../features/self-healing.js').SelfHealingConfig;
  /** SLA monitoring & credit reports (9.5). */
  sla?: import('../features/sla.js').SlaConfig;
  /** Global tool registry (9.4). */
  toolRegistry?: import('../features/tool-registry.js').ToolRegistryConfig;
  /** Confidential computing / TEE (9.3). */
  confidential?: import('../features/confidential.js').ConfidentialConfig;
  /** Edge WASM runtime 2.0 (9.2). */
  edgeRuntime?: import('../features/edge-runtime.js').EdgeRuntimeConfig;
  /** Multimodal tools (9.1). */
  multimodal?: import('../features/multimodal.js').MultimodalConfig;
  /** Chaos testing (8.8). */
  chaos?: import('../features/chaos.js').ChaosConfig;
  /** Natural-language config assistant (8.7). */
  configAssistant?: import('../features/config-assistant.js').ConfigAssistantConfig;
  /** Data lineage (8.6). */
  dataLineage?: import('../features/data-lineage.js').DataLineageConfig;
  /** Zero-downtime blue/green upgrades (8.5). */
  blueGreen?: import('../features/blue-green.js').BlueGreenConfig;
  /** Cost optimization advisor (8.4). */
  costAdvisor?: import('../features/cost-advisor.js').CostAdvisorConfig;
  /** Live collaborative debugging (8.3). */
  debugSessions?: import('../features/debug-sessions.js').DebugSessionsConfig;
  /** Cross-gateway A2A federation (8.2). */
  a2aFederation?: import('../features/a2a-federation.js').A2aFederationConfig;
  /** Agent identity & delegated auth (8.1). */
  agentIdentity?: import('../features/agent-identity.js').AgentIdentityConfig;
  /** Automated compliance reports (7.8). */
  complianceReports?: import('../features/compliance-reports.js').ComplianceReportsConfig;
  /** Approvals 2.0 (7.7). */
  approvalFlows?: import('../features/approval-flows.js').ApprovalFlowsConfig;
  /** Offline desktop gateway (7.6). */
  offline?: import('../features/offline.js').OfflineConfig;
  /** Tool versioning and gradual rollout (7.5). */
  rollouts?: import('../features/rollouts.js').RolloutsConfig;
  /** Semantic cache (7.4). */
  semanticCache?: import('../features/semantic-cache.js').SemanticCacheConfig;
  /** Prompt-injection defence and output sanitisation (7.3). */
  sanitize?: import('../features/sanitize.js').SanitizeConfig;
  /** SaaS console (7.2). */
  console?: import('../features/console.js').ConsoleConfig;
  /** Usage billing and invoices (6.7). */
  billing?: import('../features/billing.js').BillingConfig;
  /** Anomaly detection (6.6). */
  anomaly?: import('../features/anomaly.js').AnomalyConfig;
  /** Policy simulation: shadow policy (6.5). */
  policyShadow?: import('../features/policy-sim.js').PolicyShadowConfig;
  /** Enterprise SSO (OIDC) and SCIM 2.0 (6.4). */
  identity?: import('../features/identity.js').IdentityConfig;
  /** OpenTelemetry GenAI semantic conventions (6.3). */
  genaiTelemetry?: import('../features/genai-otel.js').GenaiTelemetryConfig;
  /** Workflow engine (multi-tool DAG) (6.2). */
  workflows?: import('../features/workflows.js').WorkflowsConfig;
  /** GraphQL / gRPC upstreams (6.1). */
  apiUpstreams?: import('../features/api-upstreams.js').ApiUpstreamsConfig;
  /** Adaptive routing 2.0 (5.8). */
  adaptive?: import('../features/adaptive.js').AdaptiveConfig;
  /** Data loss prevention (5.6). */
  dlp?: import('../features/dlp.js').DlpConfig;
  /** Agent session recordings (5.5). */
  sessions?: import('../features/sessions.js').SessionsConfig;
  /** Signed plugins: trusted keys, require signatures (5.4). */
  pluginTrust?: import('../plugins/trust.js').PluginTrustConfig;
  /** Plugin marketplace indexes (5.4). */
  marketplace?: import('../features/marketplace.js').MarketplaceConfig;
  /** Managed edge nodes (5.3). */
  edgeFleet?: import('../features/edge-fleet.js').EdgeFleetConfig;
  /** Multi-region active-active (5.2). */
  regions?: import('../features/regions.js').RegionsConfig;
  /** Zero-trust upstream mTLS (SPIFFE, certificate rotation) (4.5). */
  mtls?: import('../security/mtls.js').MtlsConfig;
  /** Streaming tool results: SSE backpressure limits (4.4). */
  streaming?: import('../gateway/stream.js').StreamLimits;
  /** Cost accounting per LLM call and budget alerts (4.3). */
  costs?: import('../costs/index.js').CostsConfig;
  /** Tool chains / multi-agent orchestration (4.2). */
  chains?: import('../orchestration/chains.js').ChainsConfig;
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
  /** Config schema version (`7`; optional). */
  version?: 7 | 8;
  /** CORS: allowed browser origins (default `["*"]`). */
  cors?: { origins?: string[] };
  /** Health checks: ping interval (ms, default 30000). Restart required. */
  health?: { intervalMs?: number };
  /** Role (all / control / data) and control-plane settings: config API, dashboard, data-plane sync (7.0). */
  controlPlane?: import('../gateway/control-plane.js').ControlPlaneConfig;
  /** Deprecated keys found by `loadConfig` (set by the loader). */
  deprecations?: Deprecation[];
  /** Log level */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  /** Automatic reconnect of crashed / disconnected servers */
  reconnect?: Partial<ReconnectConfig>;
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
  /** Request capture + replay / debugger (3.2). Off by default. */
  replay?: ReplayConfig;
  /** Developer portal: self-serve keys, usage, tool docs (3.8). */
  portal?: PortalConfig;
  /** PII detection / redaction, data residency, compliance reports (3.7). */
  compliance?: ComplianceConfig;
  /** Peering with gateways in other regions: catalog sync and failover (3.6). */
  federation?: FederationConfig;
  /** Secret providers (Vault / KMS / env / file) and rotation (3.5). */
  secrets?: SecretsConfig;
  /** Traffic splits: canary / A-B across servers (3.4). */
  routing?: RoutingConfig;
  /** Plugins (hooks: onRequest, onToolCall before policy, onResponse after the output filter). */
  plugins?: PluginConfig[];
  /** OpenAI-compatible tools proxy (`/openai/v1/tools`, `/tool_calls`, `/chat/completions`). */
  openai?: OpenAIBridgeConfig;
  /** A2A (Agent2Agent) bridge: agent card at `/.well-known/agent-card.json` + JSON-RPC endpoint. */
  a2a?: A2ABridgeConfig;
  /** Directory of the loaded config file (set by `loadConfig`; plugin paths resolve against it). */
  configDir?: string;
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
  /** Path (relative to the config file) or package name of an ES module. Exactly one of `module` / `component`. */
  module?: string;
  /** Path of a plugin API v5 WASM plugin (7.9): the core module of a `mcp-gateway:plugin@5.0.0` component (canonical ABI). */
  component?: string;
  /** WASM / component only: one sandbox per tenant (default), per client, or one shared. */
  isolation?: 'tenant' | 'client' | 'shared';
  /** WASM component only: per-sandbox limits. */
  limits?: WasmPluginLimits;
  /** Override the plugin's own name. */
  name?: string;
  enabled?: boolean;
  /** Passed to a factory export as `ctx.options`. */
  options?: Record<string, unknown>;
  /** 5.4: signature file (default `<module or component>.sig`), checked against `pluginTrust`. */
  signature?: string;
  /** Plugin API v3 (4.0): secrets the plugin may read via `ctx.secrets.get(name)` — name → `secret://provider/path`. */
  secrets?: Record<string, string>;
}

/** Limits of one WASM plugin sandbox (3.3). */
export interface WasmPluginLimits {
  /** Per hook call (default 100). */
  timeoutMs?: number;
  /** Linear memory + worker heap cap (default 16). */
  memoryMb?: number;
  /** Sandboxes kept per plugin; the least recently used is closed beyond this (default 64). */
  maxInstances?: number;
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
  /** `memory` (default, single instance), `redis` (shared between instances) or `eventlog` (9.0, durable, single instance). */
  store?: 'memory' | 'redis' | 'eventlog';
  /** Event-sourced store (9.0): append-only `events.log` + `snapshot.json` in `dir` (relative to the config file). */
  eventlog?: { dir?: string; snapshotEvery?: number; fsync?: boolean };
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
  /** MCP revisions accepted downstream (4.1; default all the gateway speaks, newest first). */
  protocolVersions?: string[];
  /** Optional `instructions` returned from `initialize`. */
  instructions?: string;
  /** Events kept per session for `Last-Event-ID` resumability (default 256, 0 = off). */
  eventBufferSize?: number;
  /** Server→client request passthrough (sampling, elicitation, roots) to downstream clients. */
  passthrough?: McpPassthroughConfig;
}

/** Which upstream→client requests are relayed to the downstream client that made the call (3.1). */
/** Developer portal (3.8). Requires `auth.strategy: api-key`. */
export interface PortalConfig {
  enabled?: boolean;
  /** `open`: keys work immediately; `approval` (default): an operator approves; `closed`: no self-service. */
  signup?: 'open' | 'approval' | 'closed';
  /** Only these e-mail domains may sign up. */
  allowedEmailDomains?: string[];
  /** Active + pending keys per e-mail address (default 3). */
  maxKeysPerEmail?: number;
  /** Scope of issued keys. */
  defaults?: { servers?: string[]; tools?: string[]; rateLimit?: { limit: number; windowSeconds: number }; keyTtlDays?: number };
  /** JSON file for issued keys (hashed), relative to the config file. Absent = in memory. */
  keysFile?: string;
  /** Shown on the portal page. */
  title?: string;
  /** Public base URL used in snippets (default: the request's origin). */
  publicUrl?: string;
}

/** Compliance suite (3.7). */
export type PiiCategory = 'email' | 'phone' | 'credit-card' | 'ssn' | 'iban' | 'ipv4' | 'cn-id';

export interface ComplianceConfig {
  residency?: {
    /** First matching rule wins. A rule without `tenants` applies to everybody. */
    rules?: Array<{ tenants?: string[]; regions: string[] }>;
    /** Allow servers / peers without a `region` for pinned tenants (default false). */
    allowUnknown?: boolean;
  };
}

/** Federated gateways (3.6). */
export interface FederationConfig {
  enabled?: boolean;
  /** This gateway's id, as peers know it. */
  gatewayId: string;
  region?: string;
  /** HMAC-SHA256 secret shared by every peer (≥ 32 characters). */
  sharedSecret: string;
  peers?: Array<{ id: string; url: string; region?: string; /** Lower is preferred (default 100). */ priority?: number }>;
  /** Server id globs exported to peers (default all). */
  export?: string[];
  /** Server id globs accepted from peers (default all). */
  import?: string[];
  sync?: { intervalSeconds?: number };
  /** Forward calls to a peer when a local server is down. */
  failover?: { enabled?: boolean; servers?: string[] };
}

/** Secrets management (3.5). */
export interface SecretsConfig {
  providers?: SecretProviderConfig[];
  /** How long a resolved value is cached (default 300 s). */
  cacheSeconds?: number;
  /** Re-resolve server credentials periodically and reconnect servers whose credentials changed. */
  rotation?: { intervalSeconds?: number };
}

export interface SecretProviderConfig {
  /** Referenced as `secret://<id>/...`. */
  id: string;
  type: 'vault' | 'aws-kms' | 'gcp-kms' | 'env' | 'file';
  /** vault: server address. */
  address?: string;
  /** vault: token; gcp-kms: OAuth access token. */
  token?: string;
  /** vault: AppRole login (instead of token). */
  roleId?: string;
  secretId?: string;
  /** vault: KV v2 mount (default `secret`). */
  mount?: string;
  namespace?: string;
  /** aws-kms. */
  region?: string;
  keyId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /** aws-kms / gcp-kms: API endpoint override. */
  endpoint?: string;
  /** file: base directory (default: the config directory). */
  baseDir?: string;
}

/** One per-call credential injected into a server's calls (3.5). */
export interface SecretInjection {
  /** `secret://…` reference; `{tenant}` / `{client}` are replaced per call. */
  ref: string;
  /** Tool argument to set (tools only). */
  argument?: string;
  /** `_meta` key to set. */
  meta?: string;
  /** e.g. `Bearer {value}`. */
  format?: string;
  /** Refuse the call when `{tenant}` is used and the caller has no tenant (default true). */
  required?: boolean;
}

/** Smart routing (3.4). */
export interface RoutingConfig {
  splits?: TrafficSplitConfig[];
}

/** One traffic split: calls for `server` (optionally only `tools`) spread over `variants` by weight. */
export interface TrafficSplitConfig {
  name: string;
  /** Server id the clients call. */
  server: string;
  /** Tool globs the split applies to (default: every tool). */
  tools?: string[];
  /** `client` (default): a client always gets the same variant; `none`: per call. */
  sticky?: 'client' | 'none';
  enabled?: boolean;
  variants: Array<{
    /** Server id that serves this share (the baseline is usually `server` itself). */
    server: string;
    weight: number;
    label?: string;
    /** Automatic rollback of this variant (weight 0) when a limit is crossed after `minCalls` (default 20). */
    guard?: { maxErrorRate?: number; maxLatencyMs?: number; minCalls?: number };
  }>;
}

/** Request capture for the replay debugger (3.2). */
export interface ReplayConfig {
  /** Keep redacted arguments / results of recent calls in memory and allow replays (default false). */
  enabled?: boolean;
  /** Calls kept (default 500). */
  maxEntries?: number;
  /** Max bytes per captured arguments / result; larger payloads are dropped (default 65536). */
  maxBytes?: number;
  /** Also capture results (default true). */
  results?: boolean;
}

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
