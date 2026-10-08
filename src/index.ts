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
export { ToolInvoker, ERR_SECRET_UNAVAILABLE, ERR_POLICY_DENIED, ERR_APPROVAL_REJECTED, ERR_OUTPUT_BLOCKED, ERR_PLUGIN_REJECTED } from './gateway/invoker.js';
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
export {
  SecretManager,
  VaultProvider,
  AwsKmsProvider,
  GcpKmsProvider,
  EnvProvider,
  FileProvider,
  createProvider,
  parseSecretRef,
  sigv4,
} from './secrets/index.js';
export type { SecretProvider, SecretStatus, SecretRef } from './secrets/index.js';
export { PortalStore, PortalError, exampleArgs, toolSnippets, publicKey } from './portal/index.js';
export type { PortalKey, PortalKeyStatus } from './portal/index.js';
export { ComplianceEngine, scanPii, buildReport, reportMarkdown, evaluateControls, PII_CATEGORIES, ERR_RESIDENCY, ERR_PII_BLOCKED } from './policy/compliance.js';
export type { PiiFinding, ControlResult } from './policy/compliance.js';
export { Federation, signFederation, verifyFederation, FEDERATION_HEADER } from './gateway/federation.js';
export type { PeerCatalog, PeerState, ExportedServer } from './gateway/federation.js';
export { SmartRouter, stableFraction } from './gateway/routing.js';
export type { RouteDecision, SplitSnapshot, SplitVariantStats } from './gateway/routing.js';
export { PluginHost, PluginError, loadPlugin, grantSecrets, PLUGIN_API_VERSION, PLUGIN_API_MIN_VERSION } from './plugins/index.js';
export { WasmPlugin, WasmSandbox, loadWasmPlugin, DEFAULT_WASM_LIMITS } from './plugins/wasm.js';
export type { WasmIsolation, WasmPluginOptions } from './plugins/wasm.js';
export type { GatewayPlugin, PluginCall, PluginContext, PluginFactory, PluginSource, ToolCallOutcome, PluginHookContext, PluginSecrets, PluginTenant, PluginConfigChange, PluginEnv } from './plugins/index.js';
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
export { MtlsManager, spiffeIdsOf } from './security/mtls.js';
export { SseWriter, DEFAULT_STREAM_LIMITS } from './gateway/stream.js';
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
export { migrateConfigText, migrateConfigObject } from './config/migrate.js';
export type { MigrationResult } from './config/migrate.js';
export { runBenchmark, benchMarkdown, BENCH_SCENARIOS } from './bench/index.js';
export type { BenchReport, BenchResult, BenchScenario, BenchOptions } from './bench/index.js';
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
export { PROTOCOL_VERSIONS, supports as protocolSupports, negotiateVersion, adaptTool, adaptToolResult } from './mcp/compat.js';
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
export { createFeatureRouter, registerFeature, listFeatures } from './features/index.js';
export type { FeatureModule, FeatureContext } from './gateway/features.js';
export { runConformance, formatReport as formatConformanceReport, CHECKS as CONFORMANCE_CHECKS } from './features/conformance.js';
export type { ConformanceReport, CheckResult as ConformanceCheck } from './features/conformance.js';
export { RegionMesh, RegionsSchema, resolveRegions } from './features/regions.js';
export type { RegionsConfig, ReplicatedEntry, PeerState as RegionPeerState } from './features/regions.js';
export { EdgeFleetSchema, fleetView, selectNodes, pushToNodes } from './features/edge-fleet.js';
export type { EdgeFleetConfig, FleetNode, Drift as EdgeDrift, PushResult as EdgePushResult } from './features/edge-fleet.js';
export { PluginTrustSchema, generateSigningKey, signArtifact, verifyArtifact } from './plugins/trust.js';
export type { PluginTrustConfig, PluginSignature } from './plugins/trust.js';
export { MarketplaceSchema, parseIndex as parseMarketplaceIndex, installEntry as installMarketplaceEntry, compareVersions } from './features/marketplace.js';
export type { MarketplaceConfig, MarketplaceEntry } from './features/marketplace.js';
export { SessionsSchema, recordFrom, replayRecording, grade as gradeStep, RecordingStore } from './features/sessions.js';
export type { SessionsConfig, Recording, RecordedStep, EvalReport, EvalMode } from './features/sessions.js';
export { registerCallHook, callHooks } from './gateway/hooks.js';
export type { CallHook, HookCall } from './gateway/hooks.js';
export { DlpSchema, applyDlp, maskValue, policyFor as dlpPolicyFor, DEFAULT_LEVELS as DLP_DEFAULT_LEVELS, ERR_DLP_BLOCKED } from './features/dlp.js';
export type { DlpConfig, DlpFinding } from './features/dlp.js';
export { AdaptiveSchema, AdaptiveRouter, adaptiveRouter, sampleBeta } from './features/adaptive.js';
export type { AdaptiveConfig, CandidateStats } from './features/adaptive.js';
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
  SecretsConfig,
  FederationConfig,
  ComplianceConfig,
  PortalConfig,
  PiiCategory,
  SecretProviderConfig,
  SecretInjection,
  TrafficSplitConfig,
  LoadBalancingConfig,
} from './utils/types.js';
