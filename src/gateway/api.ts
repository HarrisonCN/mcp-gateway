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
import {
  createAuthMiddleware,
  isHashedKey,
  keyExpiry,
  keyInactiveReason,
  normalizeApiKeys,
  type AuthedRequest,
  type AuthMiddleware,
} from '../auth/middleware.js';
import { AuthLockout, withLockout, type LockoutTracker } from '../security/lockout.js';
import { StoreAuthLockout, createStoreRateLimiter, type FailureMode } from '../state/shared.js';
import type { StateStore } from '../state/store.js';
import { securityWarnings } from '../security/posture.js';
import { createRateLimiter, type RateLimitDecision, type RateLimiter } from '../auth/ratelimit.js';
import { filterToolsByScope, isRestricted, isServerInScope, isToolInScope, type AccessScope } from '../auth/scopes.js';
import { logger } from '../utils/logger.js';
import { dedupeResources, routeResource } from '../mcp/catalog.js';
import { LLM_SCHEMA_FORMATS, toLlmToolSchemas, type LlmSchemaFormat } from '../mcp/llm-schemas.js';
import { VERSION } from '../utils/version.js';
import { redactArgs } from '../security/redact.js';
import { ToolInvoker, POLICY_ERROR_CODES, ERR_OUTPUT_BLOCKED } from './invoker.js';
import { ApprovalError } from '../policy/approvals.js';

export type ApiRouter = express.Router & {
  close(): void;
  /**
   * Apply hot-reloadable settings from a new config: auth (strategy, keys,
   * secret, protect flags), rate limits and monitor flags. Invalid auth keeps
   * the current middleware (fail safe).
   */
  update(next: GatewayConfig): void;
  /** The current auth middleware (hot-swapped on reload), for other endpoints such as `/mcp`. */
  authenticate: RequestHandler;
  /** Count one rate-limited request for `req` (undefined when no limit is configured). */
  takeRateLimit(req: Request): RateLimitDecision | undefined | Promise<RateLimitDecision | undefined>;
  /** Current scope of a client id (api keys); see `AuthMiddleware.resolveClient`. */
  resolveClient(clientId: string | undefined): { known: boolean; scope?: AccessScope } | undefined;
  /** The brute-force lockout tracker (undefined unless `security.authLockout`). */
  lockout(): LockoutTracker | undefined;
};

/** Whether `args` serialise to more than `limit` bytes (0 / undefined = no limit). */
export function argumentsTooLarge(args: unknown, limit: number | undefined): boolean {
  if (!limit) return false;
  return Buffer.byteLength(JSON.stringify(args ?? {}), 'utf8') > limit;
}

function lockoutFor(config: GatewayConfig, shared?: SharedState): LockoutTracker | undefined {
  const lo = config.security?.authLockout;
  if (!lo || config.auth?.strategy === undefined || config.auth.strategy === 'none') return undefined;
  const settings = lo === true ? {} : lo;
  return shared ? new StoreAuthLockout(settings, shared.store, shared.failureMode) : new AuthLockout(settings);
}

/** A shared state store (multi-instance mode). */
export interface SharedState {
  store: StateStore;
  failureMode?: FailureMode;
}

export interface ApiRouterOptions {
  /** Enables POST /servers/:id/reconnect and reconnect info. */
  supervisor?: ServerSupervisor;
  /** Makes GET /health/ready answer 503 while the gateway is shutting down. */
  isShuttingDown?: () => boolean;
  /** Shared state store: rate limits and lockouts hold across gateway instances. */
  shared?: SharedState;
  /** Upstream call pipeline (metrics, logging, tracing, …); created when absent. */
  invoker?: ToolInvoker;
}

const traceparentOf = (req: Request): string | undefined =>
  typeof req.headers.traceparent === 'string' ? req.headers.traceparent : undefined;

export interface Readiness {
  ready: boolean;
  /** Enabled servers that are connected and not `degraded`. */
  readyServers: number;
  /** Enabled servers. */
  totalServers: number;
  /** Servers that must be ready (`?min=`, default: all of them). */
  required: number;
  shuttingDown: boolean;
}

/**
 * Readiness for load balancers / Kubernetes: ready when at least `min`
 * enabled servers (default: every one) are connected and answering pings.
 * A gateway with no enabled servers is ready; a shutting-down one never is.
 */
export function computeReadiness(
  registry: ServerRegistry,
  proxy: McpProxy,
  min?: number,
  shuttingDown = false,
): Readiness {
  const enabled = registry.getEnabledServers();
  const readyServers = enabled.filter(
    (s) => proxy.isConnected(s.id) && registry.getHealth(s.id)?.status !== 'degraded',
  ).length;
  const required = min === undefined ? enabled.length : min;
  return {
    ready: !shuttingDown && readyServers >= required,
    readyServers,
    totalServers: enabled.length,
    required,
    shuttingDown,
  };
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
  if (server.args) out.args = redactArgs(server.args);
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
  const invoker =
    options.invoker ?? new ToolInvoker({ proxy, metrics, requestLog: () => cfg.monitor?.requestLog !== false, policy: () => cfg.policy });
  // Built eagerly so a misconfiguration fails at startup (fail closed).
  const authOptions = { mcpPath: () => cfg.mcp?.path ?? '/mcp' };
  let authMw: AuthMiddleware = createAuthMiddleware(cfg.auth, authOptions);
  const shared = options.shared;
  const makeLimiter = (rl: GatewayConfig['rateLimit'], namespace = 'rl'): RateLimiter =>
    rl && shared ? createStoreRateLimiter(rl, shared.store, { failureMode: shared.failureMode, namespace }) : createRateLimiter(rl);
  let rateLimiter = makeLimiter(cfg.rateLimit);
  // Keys with their own `rateLimit` get their own limiter (created lazily).
  let keyLimiters = new Map<string, RateLimiter>();
  const resetKeyLimiters = () => {
    for (const l of keyLimiters.values()) l.close();
    keyLimiters = new Map();
  };
  const limiterFor = (req: Request): RateLimiter => {
    const { scope, clientId } = req as AuthedRequest;
    if (!scope?.rateLimit) return rateLimiter;
    const id = clientId ?? 'anonymous';
    let l = keyLimiters.get(id);
    if (!l) {
      l = makeLimiter(scope.rateLimit, 'rlk');
      keyLimiters.set(id, l);
    }
    return l;
  };
  const scopeOf = (req: Request): AccessScope | undefined => (req as AuthedRequest).scope;

  // Stable wrappers: routes keep pointing at these while the inner
  // middleware is swapped on hot reload.
  let lockout = lockoutFor(cfg, shared);
  const auth: RequestHandler = withLockout((req, res, next) => authMw(req, res, next), () => lockout);
  const rateLimit: RequestHandler = (req, res, next) => limiterFor(req)(req, res, next);
  const protectable =
    (flag: 'health' | 'metrics'): RequestHandler =>
    (req, res, next) =>
      cfg.auth?.protect?.[flag] ? auth(req, res, next) : next();
  const argLimit = () => cfg.security?.maxToolArgumentsBytes;
  const tooLarge = (res: Response) =>
    res.status(413).json({
      error: 'Payload Too Large',
      message: `"arguments" exceed security.maxToolArgumentsBytes (${argLimit()} bytes)`,
    });

  router.close = () => {
    rateLimiter.close();
    resetKeyLimiters();
    lockout?.close();
  };
  router.lockout = () => lockout;
  router.authenticate = auth;
  router.takeRateLimit = (req) => limiterFor(req).take(req);
  router.resolveClient = (clientId) => authMw.resolveClient?.(clientId);
  router.update = (next: GatewayConfig) => {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    let nextAuth = cfg.auth;
    if (!same(cfg.auth, next.auth)) {
      try {
        authMw = createAuthMiddleware(next.auth, authOptions);
        nextAuth = next.auth;
        resetKeyLimiters();
        logger.info(`Auth settings reloaded (strategy: ${next.auth?.strategy ?? 'none'})`);
      } catch (err) {
        logger.error(
          `Auth reload rejected, keeping current auth: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (!same(cfg.rateLimit, next.rateLimit)) {
      const old = rateLimiter;
      rateLimiter = makeLimiter(next.rateLimit);
      old.close();
      logger.info(
        next.rateLimit
          ? `Rate limit reloaded: ${next.rateLimit.limit} per ${next.rateLimit.windowSeconds}s`
          : 'Rate limit disabled',
      );
    }
    if (!same(cfg.security?.authLockout, next.security?.authLockout) || !same(cfg.auth?.strategy, nextAuth?.strategy)) {
      lockout?.close();
      lockout = lockoutFor({ ...next, auth: nextAuth }, shared);
    }
    cfg = { ...cfg, auth: nextAuth, rateLimit: next.rateLimit, monitor: next.monitor, mcp: next.mcp, security: next.security, policy: next.policy, host: cfg.host };
    invoker.refreshPolicy();
  };

  // ─── Security posture ───────────────────────────────────────────────────────

  // Configuration warnings and key hygiene (never key material). Restricted
  // (scoped) clients are refused: this is an operator view.
  router.get('/security', auth, (req, res) => {
    if (isRestricted(scopeOf(req))) {
      res.status(403).json({ error: 'Forbidden', message: 'Scoped clients cannot read the security posture' });
      return;
    }
    const now = Date.now();
    const keys = cfg.auth?.strategy === 'api-key' ? normalizeApiKeys(cfg.auth.apiKeys) : [];
    const sec = cfg.security ?? {};
    const lo = lockout?.config;
    res.set('Cache-Control', 'no-store');
    res.json({
      authStrategy: cfg.auth?.strategy ?? 'none',
      warnings: securityWarnings(cfg, now),
      apiKeys: {
        total: keys.length,
        hashed: keys.filter((k) => isHashedKey(k.key)).length,
        disabled: keys.filter((k) => keyInactiveReason(k, now) === 'disabled').length,
        expired: keys.filter((k) => keyInactiveReason(k, now) === 'expired').length,
        expiring: keys
          .filter((k) => !keyInactiveReason(k, now) && keyExpiry(k) !== undefined)
          .map((k) => ({ name: k.name ?? null, expiresAt: new Date(keyExpiry(k)!).toISOString() }))
          .sort((a, b) => (a.expiresAt < b.expiresAt ? -1 : 1)),
      },
      jwt:
        cfg.auth?.strategy === 'jwt'
          ? {
              keySource: cfg.auth.jwt?.jwksUrl ? 'jwks' : cfg.auth.jwt?.publicKey ? 'publicKey' : 'secret',
              issuer: cfg.auth.jwt?.issuer ?? null,
              audience: cfg.auth.jwt?.audience ?? null,
              requireExp: cfg.auth.jwt?.requireExp ?? false,
            }
          : null,
      settings: {
        headers: sec.headers !== false,
        hsts: !!sec.hsts,
        dnsRebindingProtection: !!sec.dnsRebindingProtection,
        allowedHosts: sec.allowedHosts ?? null,
        ipAllowlist: sec.ipAllowlist?.length ?? 0,
        trustProxy: sec.trustProxy ?? false,
        maxBodyBytes: sec.maxBodyBytes ?? 10 * 1024 * 1024,
        maxToolArgumentsBytes: sec.maxToolArgumentsBytes ?? 0,
        redactPatterns: sec.redactPatterns?.length ?? 0,
        authLockout: lo ?? null,
      },
      oauth:
        cfg.auth?.strategy === 'oauth2' && cfg.auth.oauth
          ? {
              authorizationServers: cfg.auth.oauth.authorizationServers,
              resource: cfg.auth.oauth.resource ?? null,
              validation: cfg.auth.oauth.jwksUrl ? 'jwks' : cfg.auth.oauth.introspection ? 'introspection' : 'jwks-discovery',
              requiredScopes: cfg.auth.oauth.requiredScopes ?? [],
            }
          : null,
      lockout: lockout ? lockout.status() : null,
    });
  });

  // ─── Health & Status ────────────────────────────────────────────────────────

  // Liveness probe: always public, reveals nothing (for Docker / k8s).
  router.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Readiness probe: always public, reveals only counts (for k8s / load balancers).
  // ?min=N requires at least N ready servers instead of all of them.
  router.get('/health/ready', (req, res) => {
    const rawMin = req.query.min;
    let min: number | undefined;
    if (rawMin !== undefined) {
      min = typeof rawMin === 'string' && /^\d+$/.test(rawMin) ? Number(rawMin) : NaN;
      if (!Number.isSafeInteger(min)) {
        res.status(400).json({ error: 'Bad Request', message: '"min" must be a non-negative integer' });
        return;
      }
    }
    const r = computeReadiness(registry, proxy, min, options.isShuttingDown?.() ?? false);
    res.set('Cache-Control', 'no-store');
    res.status(r.ready ? 200 : 503).json({
      status: r.ready ? 'ready' : r.shuttingDown ? 'shutting_down' : 'not_ready',
      servers: { ready: r.readyServers, total: r.totalServers, required: r.required },
    });
  });

  router.get('/health', protectable('health'), (_req, res) => {
    const summary = registry.getSummary();
    const status = summary.offline > 0 || summary.reconnecting > 0 ? 'degraded' : 'ok';
    res.status(status === 'ok' ? 200 : 207).json({
      status,
      version: VERSION,
      uptime: process.uptime(),
      servers: summary,
      state: shared ? shared.store.kind : 'memory',
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

  router.get('/servers', auth, (req, res) => {
    const scope = scopeOf(req);
    const servers = registry
      .getAllServers()
      .filter((s) => isServerInScope(scope, s.id))
      .map((s) => ({
        ...redactServer(s),
        health: registry.getHealth(s.id),
        session: proxy.getSessionInfo(s.id),
        toolCount: filterToolsByScope(scope, registry.getTools(s.id)).length,
      }));
    res.json({ servers, total: servers.length });
  });

  router.get('/servers/:id', auth, (req, res) => {
    const server = registry.getServer(req.params.id!);
    // Out-of-scope servers are hidden from discovery.
    if (!server || !isServerInScope(scopeOf(req), server.id)) {
      res.status(404).json({ error: 'Server not found' });
      return;
    }
    res.json({
      ...redactServer(server),
      health: registry.getHealth(server.id),
      session: proxy.getSessionInfo(server.id),
      tools: filterToolsByScope(scopeOf(req), registry.getTools(server.id)),
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
      if (!isServerInScope(scopeOf(req), server.id)) {
        res.status(403).json({ error: 'Forbidden', message: `Server "${server.id}" is not allowed for this client` });
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
    tools = filterToolsByScope(scopeOf(req), tools);

    // ?format=openai|openai-responses|anthropic → LLM function-calling schemas
    const format = req.query.format;
    if (format !== undefined && format !== 'mcp') {
      if (typeof format !== 'string' || !(LLM_SCHEMA_FORMATS as readonly string[]).includes(format)) {
        res.status(400).json({
          error: 'Bad Request',
          message: `"format" must be one of: mcp, ${LLM_SCHEMA_FORMATS.join(', ')}`,
        });
        return;
      }
      res.json(toLlmToolSchemas(tools, format as LlmSchemaFormat, cfg.mcp?.toolNaming ?? 'auto'));
      return;
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
      if (argumentsTooLarge(args, argLimit())) return void tooLarge(res);

      const scope = scopeOf(req);
      const forbidden = (message: string) => res.status(403).json({ error: 'Forbidden', message });

      // Resolve server: use explicit serverId or auto-discover from tool name
      let targetServerId = serverId;
      if (!targetServerId) {
        const all = registry.findTools(tool);
        if (all.length === 0) {
          res.status(404).json({ error: 'Not Found', message: `Tool "${tool}" not found in any server` });
          return;
        }
        // Only servers the client may use take part in auto-routing.
        const candidates = all.filter((c) => isToolInScope(scope, c.serverId, c.name));
        if (candidates.length === 0) {
          forbidden(`Tool "${tool}" is not allowed for this client`);
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

      if (!isServerInScope(scope, targetServerId)) {
        forbidden(`Server "${targetServerId}" is not allowed for this client`);
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

      if (!isToolInScope(scope, targetServerId, tool)) {
        forbidden(`Tool "${tool}" on server "${targetServerId}" is not allowed for this client`);
        return;
      }

      if (!(invoker.balancer?.anyConnected(targetServerId) ?? proxy.isConnected(targetServerId))) {
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

      const result = await invoker.invoke({
        serverId: targetServerId,
        name: tool,
        kind: 'tool',
        method: 'tools/call',
        params: args as Record<string, unknown>,
        timeoutMs: server.timeout,
        clientId: (req as AuthedRequest).clientId,
        via: 'rest',
        traceparent: traceparentOf(req),
      });

      if (res.headersSent) return;
      if (result.traceparent) res.set('traceparent', result.traceparent);

      if (!result.success && result.error && POLICY_ERROR_CODES.has(result.error.code)) {
        res.status(result.error.code === ERR_OUTPUT_BLOCKED ? 502 : 403).json({
          error: result.error.code === ERR_OUTPUT_BLOCKED ? 'Tool Output Blocked' : 'Forbidden',
          message: result.error.message,
          code: result.error.code,
          policy: result.error.data,
        });
        return;
      }

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

  // ─── Resources & Prompts ────────────────────────────────────────────────────

  const serverFilter = (req: Request) => (typeof req.query.server === 'string' ? req.query.server : undefined);
  const visible = <T extends { serverId: string }>(req: Request, items: T[]): T[] => {
    const only = serverFilter(req);
    return items.filter((i) => isServerInScope(scopeOf(req), i.serverId) && (!only || i.serverId === only));
  };

  router.get('/resources', auth, (req, res) => {
    const resources = dedupeResources(visible(req, registry.getAllResources()));
    res.json({ resources, total: resources.length });
  });

  router.get('/resources/templates', auth, (req, res) => {
    const resourceTemplates = visible(req, registry.getAllResourceTemplates());
    res.json({ resourceTemplates, total: resourceTemplates.length });
  });

  router.get('/prompts', auth, (req, res) => {
    const prompts = visible(req, registry.getAllPrompts());
    res.json({ prompts, total: prompts.length });
  });

  /** Forward one upstream request with the shared checks, metrics and status mapping. */
  async function forward(
    req: Request,
    res: Response,
    serverId: string,
    method: string,
    params: unknown,
    kind: 'resource' | 'prompt',
    label: string,
    reply: (result: unknown, durationMs: number) => Record<string, unknown>,
  ): Promise<void> {
    const server = registry.getServer(serverId);
    if (!server) {
      res.status(404).json({ error: 'Not Found', message: `Server "${serverId}" not found` });
      return;
    }
    if (!isServerInScope(scopeOf(req), serverId)) {
      res.status(403).json({ error: 'Forbidden', message: `Server "${serverId}" is not allowed for this client` });
      return;
    }
    if (!(invoker.balancer?.anyConnected(serverId) ?? proxy.isConnected(serverId))) {
      res.status(503).json({
        error: 'Service Unavailable',
        message: `Server "${serverId}" is not connected`,
        status: registry.getHealth(serverId)?.status,
      });
      return;
    }
    const result = await invoker.invoke({
      serverId,
      name: label,
      kind,
      method,
      params: params as Record<string, unknown>,
      timeoutMs: server.timeout,
      clientId: (req as AuthedRequest).clientId,
      via: 'rest',
      traceparent: traceparentOf(req),
    });
    if (result.traceparent && !res.headersSent) res.set('traceparent', result.traceparent);
    if (res.headersSent) return;
    if (!result.success) {
      const status = result.error?.code === ERR_TIMEOUT ? 504 : 502;
      res.status(status).json({
        error: status === 504 ? 'Gateway Timeout' : 'Upstream Error',
        message: result.error?.message,
        code: result.error?.code,
        durationMs: result.durationMs,
      });
      return;
    }
    res.json(reply(result.result, result.durationMs));
  }

  router.post(
    '/resources/read',
    auth,
    rateLimit,
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { uri, server } = body;
      if (typeof uri !== 'string' || uri.length === 0) {
        res.status(400).json({ error: 'Bad Request', message: '"uri" must be a non-empty string' });
        return;
      }
      if (server !== undefined && typeof server !== 'string') {
        res.status(400).json({ error: 'Bad Request', message: '"server" must be a string' });
        return;
      }
      let target = server;
      if (!target) {
        const scope = scopeOf(req);
        const inScope = (id: string) => isServerInScope(scope, id);
        target = routeResource(
          uri,
          registry.getAllResources().filter((r) => inScope(r.serverId)),
          registry.getAllResourceTemplates().filter((t) => inScope(t.serverId)),
          registry.getEnabledServers().map((s) => s.id).filter((id) => inScope(id) && proxy.hasCapability(id, 'resources')),
        );
        if (!target) {
          res.status(404).json({ error: 'Not Found', message: `No server provides resource "${uri}"; pass "server"` });
          return;
        }
      }
      await forward(req, res, target, 'resources/read', { uri }, 'resource', uri, (result, durationMs) => ({
        result,
        server: target,
        uri,
        durationMs,
      }));
    }),
  );

  router.post(
    '/prompts/get',
    auth,
    rateLimit,
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { name, server } = body;
      const args = body.arguments ?? {};
      if (typeof name !== 'string' || name.length === 0) {
        res.status(400).json({ error: 'Bad Request', message: '"name" must be a non-empty string' });
        return;
      }
      if (server !== undefined && typeof server !== 'string') {
        res.status(400).json({ error: 'Bad Request', message: '"server" must be a string' });
        return;
      }
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        res.status(400).json({ error: 'Bad Request', message: '"arguments" must be an object' });
        return;
      }
      if (argumentsTooLarge(args, argLimit())) return void tooLarge(res);
      let target = server;
      if (!target) {
        const all = registry.getAllPrompts().filter((p) => p.name === name);
        if (all.length === 0) {
          res.status(404).json({ error: 'Not Found', message: `Prompt "${name}" not found in any server` });
          return;
        }
        const allowed = all.filter((p) => isServerInScope(scopeOf(req), p.serverId));
        if (allowed.length === 0) {
          res.status(403).json({ error: 'Forbidden', message: `Prompt "${name}" is not allowed for this client` });
          return;
        }
        if (allowed.length > 1) {
          res.status(409).json({
            error: 'Conflict',
            message: `Prompt "${name}" is provided by several servers; pass "server" to choose one`,
            servers: allowed.map((p) => p.serverId),
          });
          return;
        }
        target = allowed[0]!.serverId;
      }
      await forward(req, res, target, 'prompts/get', { name, arguments: args }, 'prompt', name, (result, durationMs) => ({
        result,
        server: target,
        name,
        durationMs,
      }));
    }),
  );

  // ─── Approvals (policy rules with effect "approve") ─────────────────────────

  const operatorOnly = (req: Request, res: Response): boolean => {
    if (!isRestricted(scopeOf(req))) return true;
    res.status(403).json({ error: 'Forbidden', message: 'Scoped clients cannot manage approvals' });
    return false;
  };

  router.get('/approvals', auth, (req, res) => {
    if (!operatorOnly(req, res)) return;
    res.set('Cache-Control', 'no-store').json(invoker.approvals.list());
  });

  router.get('/approvals/:id', auth, (req, res) => {
    if (!operatorOnly(req, res)) return;
    const a = invoker.approvals.get(req.params.id!);
    if (!a) return void res.status(404).json({ error: 'Not Found', message: 'Approval request not found' });
    res.json(a);
  });

  for (const action of ['approve', 'deny'] as const) {
    router.post(`/approvals/:id/${action}`, auth, (req, res) => {
      if (!operatorOnly(req, res)) return;
      const body = (req.body ?? {}) as { reason?: unknown };
      const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined;
      try {
        const decided = invoker.approvals.decide(req.params.id!, action === 'approve', (req as AuthedRequest).clientId, reason);
        logger.info(`Approval ${decided.id.slice(0, 8)} ${decided.status} by ${decided.decidedBy ?? 'operator'} (${decided.serverId}/${decided.tool})`);
        res.json(decided);
      } catch (err) {
        if (err instanceof ApprovalError) return void res.status(err.status).json({ error: err.message });
        throw err;
      }
    });
  }

  // Load balancing: members, health and ejection per server with replicas (operator view).
  router.get('/load-balancing', auth, (req, res) => {
    if (!operatorOnly(req, res)) return;
    res.json({ groups: invoker.balancer?.snapshot() ?? [] });
  });

  // Output-filter findings since start (operator view).
  router.get('/policy', auth, (req, res) => {
    if (!operatorOnly(req, res)) return;
    res.json({
      rules: cfg.policy?.rules?.length ?? 0,
      default: cfg.policy?.default ?? 'allow',
      approval: { pending: invoker.approvals.pendingCount(), timeoutSeconds: cfg.policy?.approval?.timeoutSeconds ?? 300 },
      outputFilter: cfg.policy?.outputFilter
        ? { enabled: cfg.policy.outputFilter.enabled !== false, action: cfg.policy.outputFilter.action ?? 'redact', findings: Object.fromEntries(invoker.filterFindings) }
        : null,
    });
  });

  // ─── Recent Requests ────────────────────────────────────────────────────────

  // History: in-memory log, or the persistent audit log when `audit.enabled`.
  // Filters: server, tool, client, success, via, kind, since, until (ISO or ms), cursor.
  router.get('/requests', auth, (req, res) => {
    const limit = parseIntParam(req.query.limit, 50, 1, 500);
    const str = (k: string) => (typeof req.query[k] === 'string' && req.query[k] !== '' ? (req.query[k] as string) : undefined);
    const bad = (message: string) => res.status(400).json({ error: 'Bad Request', message });
    const time = (k: string): number | undefined | null => {
      const v = str(k);
      if (v === undefined) return undefined;
      const t = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
      return Number.isFinite(t) ? t : null;
    };
    const since = time('since');
    const until = time('until');
    if (since === null || until === null) return void bad('"since" / "until" must be ISO dates or epoch milliseconds');
    const success = str('success');
    if (success !== undefined && success !== 'true' && success !== 'false') return void bad('"success" must be true or false');
    const via = str('via');
    if (via !== undefined && via !== 'rest' && via !== 'mcp') return void bad('"via" must be rest or mcp');
    const kind = str('kind');
    if (kind !== undefined && !['tool', 'resource', 'prompt'].includes(kind)) return void bad('"kind" must be tool, resource or prompt');

    // Restricted clients only see their own calls.
    const own = isRestricted(scopeOf(req)) ? (req as AuthedRequest).clientId ?? '' : undefined;
    try {
      const page = metrics.queryRequests({
        limit,
        cursor: str('cursor'),
        since,
        until,
        server: str('server'),
        tool: str('tool'),
        clientId: own ?? str('client'),
        success: success === undefined ? undefined : success === 'true',
        via: via as 'rest' | 'mcp' | undefined,
        kind: kind as 'tool' | 'resource' | 'prompt' | undefined,
      });
      res.json(page);
    } catch (err) {
      if (err instanceof RangeError) return void bad('invalid "cursor"');
      throw err;
    }
  });

  return router;
}
