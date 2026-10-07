/**
 * Gateway HTTP API
 * Exposes REST endpoints for tool invocation, server management, and monitoring
 */

import express from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { GatewayConfig, McpServerConfig } from '../utils/types.js';
import type { ServerRegistry } from '../registry/index.js';
import { ERR_TIMEOUT, type McpProxy } from '../proxy/index.js';
import type { MetricsCollector, ServerStateSample } from '../monitor/index.js';
import type { ServerSupervisor } from './supervisor.js';
import { createAuthMiddleware, type AuthedRequest } from '../auth/middleware.js';
import { createRateLimiter } from '../auth/ratelimit.js';
import { logger } from '../utils/logger.js';
import { VERSION } from '../utils/version.js';

export type ApiRouter = express.Router & {
  close(): void;
  /**
   * Apply hot-reloadable settings from a new config: auth (strategy, keys,
   * secret, protect flags), rate limits and monitor flags. Invalid auth keeps
   * the current middleware (fail safe).
   */
  update(next: GatewayConfig): void;
};

export interface ApiRouterOptions {
  /** Enables POST /servers/:id/reconnect and reconnect info. */
  supervisor?: ServerSupervisor;
}

/** Wrap async handlers so a thrown error reaches the error middleware instead
 *  of becoming an unhandled promise rejection (Express 4 does not do this). */
const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

/** Never expose env values (tokens are commonly configured there). */
export function redactServer(server: McpServerConfig): McpServerConfig {
  const mask = (r: Record<string, string>) => Object.fromEntries(Object.keys(r).map((k) => [k, '***']));
  const out = { ...server };
  if (server.env) out.env = mask(server.env);
  if (server.headers) out.headers = mask(server.headers);
  if (server.url) out.url = redactUrl(server.url);
  return out;
}

/** Strip credentials and query values (tokens are often passed there) from a URL. */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '';
    }
    for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, '***');
    return u.toString();
  } catch {
    return raw;
  }
}

/** Per-server state for /metrics and Prometheus. */
export function serverStateSamples(registry: ServerRegistry, proxy: McpProxy): ServerStateSample[] {
  return registry.getAllServers().map((s) => {
    const h = registry.getHealth(s.id);
    return {
      id: s.id,
      status: h?.status ?? 'unknown',
      up: proxy.isConnected(s.id) ? 1 : 0,
      reconnects: h?.reconnect?.reconnects ?? 0,
      reconnectAttempt: h?.reconnect?.attempt ?? 0,
      latencyMs: h?.latencyMs,
    };
  });
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
  options: ApiRouterOptions = {},
): ApiRouter {
  const router = express.Router() as ApiRouter;
  let cfg = config;
  // Built eagerly so a misconfiguration fails at startup (fail closed).
  let authMw = createAuthMiddleware(cfg.auth);
  let rateLimiter = createRateLimiter(cfg.rateLimit);

  // Stable wrappers: routes keep pointing at these while the inner
  // middleware is swapped on hot reload.
  const auth: RequestHandler = (req, res, next) => authMw(req, res, next);
  const rateLimit: RequestHandler = (req, res, next) => rateLimiter(req, res, next);
  const protectable =
    (flag: 'health' | 'metrics'): RequestHandler =>
    (req, res, next) =>
      cfg.auth?.protect?.[flag] ? authMw(req, res, next) : next();

  router.close = () => rateLimiter.close();
  router.update = (next: GatewayConfig) => {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    let nextAuth = cfg.auth;
    if (!same(cfg.auth, next.auth)) {
      try {
        authMw = createAuthMiddleware(next.auth);
        nextAuth = next.auth;
        logger.info(`Auth settings reloaded (strategy: ${next.auth?.strategy ?? 'none'})`);
      } catch (err) {
        logger.error(
          `Auth reload rejected, keeping current auth: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (!same(cfg.rateLimit, next.rateLimit)) {
      const old = rateLimiter;
      rateLimiter = createRateLimiter(next.rateLimit);
      old.close();
      logger.info(
        next.rateLimit
          ? `Rate limit reloaded: ${next.rateLimit.limit} per ${next.rateLimit.windowSeconds}s`
          : 'Rate limit disabled',
      );
    }
    cfg = { ...cfg, auth: nextAuth, rateLimit: next.rateLimit, monitor: next.monitor };
  };

  // ─── Health & Status ────────────────────────────────────────────────────────

  // Liveness probe: always public, reveals nothing (for Docker / k8s).
  router.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/health', protectable('health'), (_req, res) => {
    const summary = registry.getSummary();
    const status = summary.offline > 0 || summary.reconnecting > 0 ? 'degraded' : 'ok';
    res.status(status === 'ok' ? 200 : 207).json({
      status,
      version: VERSION,
      uptime: process.uptime(),
      servers: summary,
    });
  });

  router.get('/metrics', protectable('metrics'), (req, res) => {
    const samples = serverStateSamples(registry, proxy);
    if (cfg.monitor?.prometheus && wantsPrometheus(req)) {
      res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8').send(metrics.toPrometheusText(samples));
      return;
    }
    const windowMs = parseIntParam(req.query.window, 3_600_000, 1_000, 365 * 24 * 3_600_000);
    res.json({ ...metrics.aggregate(windowMs), servers: samples });
  });

  // ─── Server Registry ────────────────────────────────────────────────────────

  router.get('/servers', auth, (_req, res) => {
    const servers = registry.getAllServers().map((s) => ({
      ...redactServer(s),
      health: registry.getHealth(s.id),
      session: proxy.getSessionInfo(s.id),
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
      session: proxy.getSessionInfo(server.id),
      tools: registry.getTools(server.id),
    });
  });

  // Force an immediate (re)connect, resetting any backoff.
  router.post(
    '/servers/:id/reconnect',
    auth,
    rateLimit,
    asyncHandler(async (req, res) => {
      const server = registry.getServer(req.params.id!);
      if (!server) {
        res.status(404).json({ error: 'Server not found' });
        return;
      }
      if (!options.supervisor) {
        res.status(501).json({ error: 'Not Implemented', message: 'Reconnect is not available' });
        return;
      }
      const ok = await options.supervisor.connect(server);
      res.status(ok ? 200 : 502).json({
        server: server.id,
        connected: ok,
        health: registry.getHealth(server.id),
      });
    }),
  );

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

      // Enforced here too: an explicit "server" must not bypass the filter.
      if (!registry.isToolExposed(targetServerId, tool)) {
        res.status(403).json({
          error: 'Forbidden',
          message: `Tool "${tool}" is not exposed by server "${targetServerId}"`,
        });
        return;
      }

      if (!proxy.isConnected(targetServerId)) {
        const health = registry.getHealth(targetServerId);
        const retryAt = health?.reconnect?.state === 'scheduled' ? health.reconnect.nextAttemptAt : undefined;
        if (retryAt) res.set('Retry-After', String(Math.max(1, Math.ceil((retryAt.getTime() - Date.now()) / 1000))));
        res.status(503).json({
          error: 'Service Unavailable',
          message: `Server "${targetServerId}" is not connected`,
          status: health?.status,
        });
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
      if (cfg.monitor?.requestLog !== false) {
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
