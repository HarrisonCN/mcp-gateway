/**
 * mcp-gateway public API
 * Use this when embedding the gateway as a library
 */

export { Gateway } from './gateway/index.js';
export { ServerRegistry } from './registry/index.js';
export { McpProxy, defaultChannelFactory, MCP_PROTOCOL_VERSION } from './proxy/index.js';
export type { ProxyOptions, SessionInfo } from './proxy/index.js';
export { ServerSupervisor, computeBackoff, DEFAULT_RECONNECT } from './gateway/supervisor.js';
export type { UpstreamChannel, ChannelFactory, ChannelOptions, JsonRpcMessage } from './transport/channel.js';
export { MetricsCollector } from './monitor/index.js';
export { loadConfig, generateDefaultConfig } from './config/loader.js';
export { logger } from './utils/logger.js';
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
} from './utils/types.js';
