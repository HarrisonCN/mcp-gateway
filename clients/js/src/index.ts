/**
 * @winstonsayno/mcp-gateway-client — typed, dependency-free client for mcp-gateway.
 */
export { GatewayClient, GatewayError } from './client.js';
export type { GatewayClientOptions, RequestOptions, CallToolOptions, FetchLike, ApprovalRequest } from './client.js';
export { McpSession, McpError, connectMcp, MCP_PROTOCOL_VERSION } from './mcp.js';
export type { McpTool, McpInitializeResult, McpSessionOptions } from './mcp.js';
export type * from './types.js';
