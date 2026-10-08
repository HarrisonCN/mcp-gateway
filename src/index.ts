/**
 * mcp-gateway public API
 * Use this when embedding the gateway as a library
 */

export { Gateway } from './gateway/index.js';
export type { GatewayOptions } from './gateway/index.js';
export {
  createStateStore,
  MemoryStateStore,
  PrefixedStateStore,
  RedisStateStore,
  RedisClient,
  createStoreRateLimiter,
  StoreAuthLockout,
} from './state/index.js';
export type { StateStore } from './state/index.js';
export {
  createTracer,
  BatchTracer,
  OtlpHttpExporter,
  NOOP_TRACER,
  parseTraceparent,
  formatTraceparent,
  toOtlpJson,
} from './observability/tracing.js';
export type { Tracer, Span, SpanExporter } from './observability/tracing.js';
export { ToolInvoker, ERR_POLICY_DENIED, ERR_APPROVAL_REJECTED, ERR_OUTPUT_BLOCKED, ERR_PLUGIN_REJECTED } from './gateway/invoker.js';
export { withTenantScope, membershipsOf, roleIn, canCall, ROLE_RANK } from './auth/tenants.js';
export { Catalog, InstalledServers, BUILTIN_CATALOG, buildServerConfig, loadCatalogSource } from './catalog/index.js';
export type { CatalogEntry, InstallRequest } from './catalog/index.js';
export { UsageMeter, usageCsv, periodBounds, ERR_QUOTA_EXCEEDED } from './gateway/usage.js';
export type { UsageRow, UsageGroup } from './gateway/usage.js';
export { ToolCache, canonicalJson } from './gateway/cache.js';
export { ReplayRecorder, jsonDiff } from './gateway/replay.js';
export type { CapturedCall, JsonChange } from './gateway/replay.js';
export type { CacheStats } from './gateway/cache.js';
export { LoadBalancer, expandReplicas } from './gateway/balancer.js';
export { SmartRouter, stableFraction } from './gateway/routing.js';
export type { RouteDecision, SplitSnapshot, SplitVariantStats } from './gateway/routing.js';
export { PluginHost, PluginError, loadPlugin, PLUGIN_API_VERSION } from './plugins/index.js';
export { WasmPlugin, WasmSandbox, loadWasmPlugin, DEFAULT_WASM_LIMITS } from './plugins/wasm.js';
export type { WasmIsolation, WasmPluginOptions } from './plugins/wasm.js';
export type { GatewayPlugin, PluginCall, PluginContext, PluginFactory, PluginSource, ToolCallOutcome } from './plugins/index.js';
export { evaluatePolicy, argMatches, isUnder } from './policy/tool-policy.js';
export type { PolicyDecision, PolicyRequest, PolicyEffect } from './policy/tool-policy.js';
export { ApprovalQueue, ApprovalError } from './policy/approvals.js';
export type { ApprovalRequest, ApprovalStatus } from './policy/approvals.js';
export { OutputFilter, BUILTIN_INJECTION_PATTERNS } from './policy/output-filter.js';
export type { InvokeContext, InvokeResult } from './gateway/invoker.js';
export { LATENCY_BUCKETS_SECONDS } from './monitor/index.js';
export {
  OAuthVerifier,
  protectedResourceMetadata,
  bearerChallenge,
  PROTECTED_RESOURCE_METADATA_PATH,
} from './auth/oauth.js';
export { computeReadiness } from './gateway/api.js';
export type { Readiness } from './gateway/api.js';
export { ServerRegistry } from './registry/index.js';
export { McpProxy, defaultChannelFactory, MCP_PROTOCOL_VERSION, PASSTHROUGH_METHODS, passthroughCapabilities } from './proxy/index.js';
export type { ClientRequestHandler, PassthroughMethod, RelayCaller } from './proxy/index.js';
export type { ProxyOptions, SessionInfo, RequestOptions, ProgressUpdate } from './proxy/index.js';
export { ServerSupervisor, computeBackoff, DEFAULT_RECONNECT } from './gateway/supervisor.js';
export type { UpstreamChannel, ChannelFactory, ChannelOptions, JsonRpcMessage } from './transport/channel.js';
export { MetricsCollector } from './monitor/index.js';
export { SqliteAuditStore, sqliteAvailable } from './monitor/audit.js';
export type { AuditStore, AuditQuery, AuditPage } from './monitor/audit.js';
export {
  dedupeResources,
  routeResource,
  matchesUriTemplate,
  buildPromptIndex,
} from './mcp/catalog.js';
export { loadConfig, generateDefaultConfig } from './config/loader.js';
export { ConfigWatcher } from './config/watcher.js';
export { logger } from './utils/logger.js';
export { isToolAllowed, filterTools } from './utils/tool-filter.js';
export {
  isServerInScope,
  isToolInScope,
  filterToolsByScope,
  scopeFromJwt,
  JWT_SERVERS_CLAIM,
  JWT_TOOLS_CLAIM,
} from './auth/scopes.js';
export type { AccessScope } from './auth/scopes.js';
export { McpEndpoint, DOWNSTREAM_PROTOCOL_VERSIONS, ERR_RATE_LIMITED, LOG_LEVELS } from './mcp/endpoint.js';
export type { McpLogLevel } from './mcp/endpoint.js';
export { hashApiKey, isHashedKey, buildJwtVerifier, HMAC_ALGORITHMS, ASYMMETRIC_ALGORITHMS } from './auth/middleware.js';
export { redactString, redactValue, redactArgs, configureRedaction } from './security/redact.js';
export { securityWarnings } from './security/posture.js';
export type { SecurityWarning } from './security/posture.js';
export { AuthLockout } from './security/lockout.js';
export { createIpMatcher, hostAllowed } from './security/network.js';
export { dashboardCsp, inlineScriptHashes } from './security/headers.js';
export type { McpSessionSummary } from './mcp/endpoint.js';
export { toLlmToolSchemas, sanitizeToolName, LLM_SCHEMA_FORMATS } from './mcp/llm-schemas.js';
export type { LlmSchemaFormat, LlmToolSchemas } from './mcp/llm-schemas.js';
export { buildToolIndex, prefixedName, TOOL_NAME_SEPARATOR } from './mcp/naming.js';
export type {
  GatewayConfig,
  McpServerConfig,
  ServerHealth,
  ServerStatus,
  ServerTransport,
  ToolInfo,
  RequestMetric,
  AggregatedMetrics,
  AuthConfig,
  RateLimitConfig,
  MonitorConfig,
  ReconnectConfig,
  ReconnectState,
  ToolFilterConfig,
  McpEndpointConfig,
  ToolNaming,
  ApiKeyConfig,
  JwtConfig,
  SecurityConfig,
  AuthLockoutConfig,
  AuditConfig,
  OAuthConfig,
  StateConfig,
  TracingConfig,
  ToolPolicyConfig,
  PolicyRule,
  PolicyArgMatcher,
  OutputFilterConfig,
  ObservabilityConfig,
  ResourceInfo,
  ResourceTemplateInfo,
  PromptInfo,
  PromptArgumentInfo,
  ServerCatalog,
  RoutingConfig,
  TrafficSplitConfig,
  LoadBalancingConfig,
} from './utils/types.js';
