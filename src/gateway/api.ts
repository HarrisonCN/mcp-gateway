/**
 * Gateway HTTP API
 * Exposes REST endpoints for tool invocation, server management, and monitoring
 */

import express from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { GatewayConfig, McpServerConfig } from '../utils/types.js';
import type { ServerRegistry } from '../registry/index.js';
import { ERR_TIMEOUT, type McpProxy } from '../proxy/index.js';
import type { MetricsCollector } from '../monitor/index.js';
import { createAuthMiddleware, type AuthedRequest } from '../auth/middleware.js';
import { createRateLimiter } from '../auth/ratelimit.js';
import { logger } from '../utils/logger.js';
import { VERSION } from '../utils/version.js';

export type ApiRouter = express.Router & { close(): void };

/** Wrap async handlers so a thrown error reaches the error middleware instead
 *  of becoming an unhandled promise rejection (Express 4 does not do this). */
const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

/** Never expose env values (tokens are commonly configured there). */
export function redactServer(server: McpServerConfig): McpServerConfig {
  if (!server.env) return server;
  const env: Record<string, string> = {};
  for (const k of Object.keys(server.env)) env[k] = '***';
  return { ...server, env };
}

function parseIntParam(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function wantsPrometheus(req: Request): boolean {
  if (req.query.format === 'prometheus') return true;
  if (req.query.format === 'json') return false;
  const accept = String(req.headers.accept ?? '');
  // Prometheus scrapers send text/plain or openmetrics. A bare "*/*" (curl,
  // browsers, fetch()) gets JSON so the dashboard keeps working.
  return /text\/plain|application\/openmetrics-text/.test(accept);
}

export function createApiRouter(
  config: GatewayConfig,
  registry: ServerRegistry,
  proxy: McpProxy,
  metrics: MetricsCollector,
): ApiRouter {
  const router = express.Router() as ApiRouter;
  const auth = createAuthMiddleware(config.auth);
  const rateLimit = createRateLimiter(config.rateLimit);
  router.close = () => rateLimit.close();

  // ─── Health & Status ────────────────────────────────────────────────────────

  router.get('/health', (_req, res) => {
    const summary = registry.getSummary();
    const status = summary.offline > 0 ? 'degraded' : 'ok';
    res.status(status === 'ok' ? 200 : 207).json({
      status,
      version: VERSION,
      uptime: process.uptime(),
      servers: summary,
    });
  });

  router.get('/metrics', (req, res) => {
    if (config.monitor?.prometheus && wantsPrometheus(req)) {
      res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8').send(metrics.toPrometheusText());
      return;
    }
    const windowMs = parseIntParam(req.query.window, 3_600_000, 1_000, 365 * 24 * 3_600_000);
    res.json(metrics.aggregate(windowMs));
  });

  // ─── Server Registry ────────────────────────────────────────────────────────

  router.get('/servers', auth, (_req, res) => {
    const servers = registry.getAllServers().map((s) => ({
      ...redactServer(s),
      health: registry.getHealth(s.id),
      toolCount: registry.getTools(s.id).length,
    }));
    res.json({ servers, total: servers.length });
  });

  router.get('/servers/:id', auth, (req, res) => {
    const server = registry.getServer(req.params.id!);
    if (!server) {
      res.status(404).json({ error: 'Server not found' });
      return;
    }
    res.json({
      ...redactServer(server),
      health: registry.getHealth(server.id),
      tools: registry.getTools(server.id),
    });
  });

  // ─── Tool Discovery ─────────────────────────────────────────────────────────

  router.get('/tools', auth, (req, res) => {
    const serverId = typeof req.query.server === 'string' ? req.query.server : undefined;
    const tag = typeof req.query.tag === 'string' ? req.query.tag : undefined;

    let tools = serverId ? registry.getTools(serverId) : registry.getAllTools();
    if (tag) {
      const taggedServerIds = new Set(registry.getServersByTag(tag).map((s) => s.id));
      tools = tools.filter((t) => taggedServerIds.has(t.serverId));
    }

    res.json({ tools, total: tools.length });
  });

  // ─── Tool Invocation ────────────────────────────────────────────────────────

  router.post(
    '/tools/call',
    auth,
    rateLimit,
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { tool, server: serverId } = body;
      const args = body.arguments ?? {};

      if (typeof tool !== 'string' || tool.length === 0) {
        res.status(400).json({ error: 'Bad Request', message: '"tool" must be a non-empty string' });
        return;
      }
      if (serverId !== undefined && typeof serverId !== 'string') {
        res.status(400).json({ error: 'Bad Request', message: '"server" must be a string' });
        return;
      }
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        res.status(400).json({ error: 'Bad Request', message: '"arguments" must be an object' });
        return;
      }

      // Resolve server: use explicit serverId or auto-discover from tool name
      let targetServerId = serverId;
      if (!targetServerId) {
        const candidates = registry.findTools(tool);
        if (candidates.length === 0) {
          res.status(404).json({ error: 'Not Found', message: `Tool "${tool}" not found in any server` });
          return;
        }
        if (candidates.length > 1) {
          // Previously the first match was used silently, so a call could hit
          // an unintended server depending on registration order.
          res.status(409).json({
            error: 'Conflict',
            message: `Tool "${tool}" is provided by several servers; pass "server" to choose one`,
            servers: candidates.map((c) => c.serverId),
          });
          return;
        }
        targetServerId = candidates[0]!.serverId;
      }

      const server = registry.getServer(targetServerId);
      if (!server) {
        res.status(404).json({ error: 'Not Found', message: `Server "${targetServerId}" not found` });
        return;
      }

      if (!proxy.isConnected(targetServerId)) {
        res.status(503).json({ error: 'Service Unavailable', message: `Server "${targetServerId}" is not connected` });
        return;
      }

      // Argument values may contain secrets; log only their keys.
      logger.debug(`Tool call: ${tool} → ${targetServerId}`, { argKeys: Object.keys(args) });

      const result = await proxy.callTool(targetServerId, tool, args as Record<string, unknown>, server.timeout);

      metrics.record({
        serverId: targetServerId,
        toolName: tool,
        durationMs: result.durationMs,
        success: result.success,
        errorMessage: result.error?.message,
        clientId: (req as AuthedRequest).clientId,
      });
      if (config.monitor?.requestLog !== false) {
        logger.info(`${tool} → ${targetServerId} ${result.success ? 'ok' : 'failed'} ${result.durationMs}ms`);
      }

      if (res.headersSent) return;

      if (!result.success) {
        // 504 for upstream timeouts, 502 for upstream errors (was always 500).
        const status = result.error?.code === ERR_TIMEOUT ? 504 : 502;
        res.status(status).json({
          error: status === 504 ? 'Gateway Timeout' : 'Tool Execution Failed',
          message: result.error?.message,
          code: result.error?.code,
          durationMs: result.durationMs,
        });
        return;
      }

      res.json({
        result: result.result,
        server: targetServerId,
        tool,
        durationMs: result.durationMs,
      });
    }),
  );

  // ─── Recent Requests ────────────────────────────────────────────────────────

  router.get('/requests', auth, (req, res) => {
    const limit = parseIntParam(req.query.limit, 50, 1, 500);
    res.json({ requests: metrics.getRecent(limit) });
  });

  return router;
}
