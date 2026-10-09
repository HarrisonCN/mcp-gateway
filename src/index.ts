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
  EventLogStateStore,
  RedisClient,
  createStoreRateLimiter,
  StoreAuthLockout,
} from './state/index.js';
export type { StateStore, EventLogOptions, EventLogStats } from './state/index.js';
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
export { PluginHost, PluginError, loadPlugin, grantSecrets, definePlugin, validatePluginOptions, PLUGIN_API_VERSION, PLUGIN_API_MIN_VERSION } from './plugins/index.js';
export { WasmPlugin, WasmSandbox, loadWasmPlugin, DEFAULT_WASM_LIMITS } from './plugins/wasm.js';
export type { WasmIsolation, WasmPluginOptions } from './plugins/wasm.js';
export type { GatewayPlugin, PluginCall, PluginContext, PluginFactory, PluginSource, ToolCallOutcome, PluginHookContext, PluginSecrets, PluginTenant, PluginConfigChange, PluginEnv, PluginConfigSchema, PluginRouteContext, PluginRouteEnv } from './plugins/index.js';
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
export { ApiUpstreamsSchema, apiUpstreamTools, callApiUpstream, graphqlVariables } from './features/api-upstreams.js';
export type { ApiUpstreamsConfig, ApiUpstreamTool } from './features/api-upstreams.js';
export { topoLayers } from './features/task-graphs.js';
export { GenaiTelemetrySchema, GenaiRecorder, genaiRecorder, genaiAttributes, extractUsage, GENAI_DURATION_BUCKETS, GENAI_TOKEN_BUCKETS } from './features/genai-otel.js';
export type { GenaiTelemetryConfig, GenaiSpan } from './features/genai-otel.js';
export { IdentitySchema, ScimDirectory, scimFilter, resolveMemberships, verifyIdToken, authorizeUrl } from './features/identity.js';
export type { IdentityConfig, ScimUser, ScimGroup } from './features/identity.js';
export { PolicyShadowSchema, CandidatePolicySchema, simulatePolicy, ShadowRecorder, shadowRecorder } from './features/policy-sim.js';
export type { PolicyShadowConfig, SimulationReport, SimCall } from './features/policy-sim.js';
export { AnomalySchema, AnomalyDetector, anomalyDetector, injectionScore, ERR_ANOMALY_QUARANTINED } from './features/anomaly.js';
export type { AnomalyConfig, AnomalyAlert } from './features/anomaly.js';
export { BillingSchema, UsageMeter as BillingUsageMeter, usageMeter, priceFor, buildInvoice, invoiceCsv } from './features/billing.js';
export type { BillingConfig, Invoice, InvoiceLine } from './features/billing.js';
export { renderManifests, McpGatewaySpecSchema, K8sOperator, inClusterApi, configHash, MCPGATEWAY_CRD } from './features/k8s.js';
export type { McpGatewaySpec, K8sApi } from './features/k8s.js';
export { ControlPlaneSchema, DataPlaneSync, configEtag, distributedConfig, createControlPlaneRouter } from './gateway/control-plane.js';
export type { ControlPlaneConfig, DataPlaneNode, DataPlaneStatus } from './gateway/control-plane.js';
export { exportHcl, toHcl, KINDS as TERRAFORM_KINDS } from './features/terraform.js';
export type { ResourceKind } from './features/terraform.js';
export { ConsoleSchema, DailyCounter, admitCall, ERR_ORG_REFUSED } from './features/console.js';
export type { ConsoleConfig } from './features/console.js';
export { SanitizeSchema, sanitizeResult, sanitizeText, ERR_INJECTION_BLOCKED } from './features/sanitize.js';
export type { SanitizeConfig, SanitizeReport } from './features/sanitize.js';
export { SemanticCacheSchema, SemanticStore, localEmbedding, cosine, splitArgs } from './features/semantic-cache.js';
export type { SemanticCacheConfig } from './features/semantic-cache.js';
export { RolloutsSchema, RolloutManager, bucketOf } from './features/rollouts.js';
export type { RolloutsConfig } from './features/rollouts.js';
export { OfflineSchema, importDesktopServers, desktopConfig, ERR_OFFLINE } from './features/offline.js';
export type { OfflineConfig } from './features/offline.js';
export { ApprovalFlowsSchema, FlowQueue, matchFlow } from './features/approval-flows.js';
export type { ApprovalFlowsConfig, FlowRequest } from './features/approval-flows.js';
export { ComplianceReportsSchema, writeBundle, verifyBundle, renderFramework, iso27001Controls } from './features/compliance-reports.js';
export type { ComplianceReportsConfig, Manifest as ComplianceManifest } from './features/compliance-reports.js';
export { AgentIdentitySchema, signAgentToken, verifyAgentToken, issueAgentToken, ERR_AGENT_REQUIRED } from './features/agent-identity.js';
export type { AgentIdentityConfig, AgentTokenClaims } from './features/agent-identity.js';
export { A2aFederationSchema, refreshRemote, sendToRemote } from './features/a2a-federation.js';
export type { A2aFederationConfig, RemoteState as A2aRemoteState } from './features/a2a-federation.js';
export { DebugSessionsSchema, ERR_DEBUG_ABORTED } from './features/debug-sessions.js';
export type { DebugSessionsConfig, DebugEvent, DebugBreakpoint } from './features/debug-sessions.js';
export { CostAdvisorSchema, analyse as analyseCosts } from './features/cost-advisor.js';
export type { CostAdvisorConfig, Recommendation as CostRecommendation } from './features/cost-advisor.js';
export { BlueGreenSchema } from './features/blue-green.js';
export type { BlueGreenConfig } from './features/blue-green.js';
export { DataLineageSchema } from './features/data-lineage.js';
export type { DataLineageConfig, LineageNode, LineageEdge } from './features/data-lineage.js';
export { ConfigAssistantSchema, parseInstruction } from './features/config-assistant.js';
export type { ConfigAssistantConfig } from './features/config-assistant.js';
export { ChaosSchema, ERR_CHAOS_INJECTED } from './features/chaos.js';
export type { ChaosConfig } from './features/chaos.js';
export { MultimodalSchema, ERR_MEDIA_REFUSED, applyMultimodal } from './features/multimodal.js';
export type { MultimodalConfig } from './features/multimodal.js';
export { EdgeRuntimeSchema, ERR_EDGE_RUNTIME, callEdgeTool } from './features/edge-runtime.js';
export type { EdgeRuntimeConfig } from './features/edge-runtime.js';
export { ConfidentialSchema, ERR_ATTESTATION_REQUIRED, verifyEvidence } from './features/confidential.js';
export type { ConfidentialConfig } from './features/confidential.js';
export { ToolRegistrySchema, satisfies, resolveVersion } from './features/tool-registry.js';
export type { ToolRegistryConfig, ToolManifest } from './features/tool-registry.js';
export { SlaSchema, recordSla } from './features/sla.js';
export type { SlaConfig } from './features/sla.js';
export { SelfHealingSchema, ERR_SELF_HEALING } from './features/self-healing.js';
export type { SelfHealingConfig } from './features/self-healing.js';
export { PqTlsSchema, groupsSupported, effectiveGroups } from './features/pq-tls.js';
export type { PqTlsConfig } from './features/pq-tls.js';
export { EcosystemSchema, verifyPublisher } from './features/ecosystem.js';
export type { EcosystemConfig } from './features/ecosystem.js';
export { CONFIG_SCHEMA_VERSION, LTS, ltsStatus } from './features/kernel.js';
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
