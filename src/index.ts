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
  OAuthVerifier,
  protectedResourceMetadata,
  bearerChallenge,
  PROTECTED_RESOURCE_METADATA_PATH,
} from './auth/oauth.js';
export { computeReadiness } from './gateway/api.js';
export type { Readiness } from './gateway/api.js';
export { ServerRegistry } from './registry/index.js';
export { McpProxy, defaultChannelFactory, MCP_PROTOCOL_VERSION } from './proxy/index.js';
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
  ResourceInfo,
  ResourceTemplateInfo,
  PromptInfo,
  PromptArgumentInfo,
  ServerCatalog,
} from './utils/types.js';
