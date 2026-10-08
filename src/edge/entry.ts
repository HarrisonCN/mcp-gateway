/**
 * `@winstonsayno/mcp-gateway/edge` — Fetch-API gateway for Cloudflare Workers, Deno and Bun.
 * Imports nothing from Node (except `serveNode`, which loads `node:http` lazily).
 */
export { createEdgeGateway, EdgeUpstream, readRpcReply, EDGE_PROTOCOL_VERSION } from './index.js';
export type { EdgeConfig, EdgeServerConfig, EdgeGateway, EdgeOfflineConfig, EdgeSyncReport } from './index.js';
export { EdgeSync, memoryStore } from './sync.js';
export type { EdgeSyncOptions, EdgeSyncStore, EdgeSnapshot, EdgeEvent, QueuedCall, PullResult, EdgeCatalogTool } from './sync.js';
export { workersHandler, serveDeno, serveBun, serveNode, configFromEnv } from './adapters.js';
