/**
 * Gateway HTTP API
 * Exposes REST endpoints for tool invocation, server management, and monitoring
 */

import { DlpSchema, dlpStats, policyFor as dlpPolicyFor } from '../features/dlp.js';
import { SseWriter } from './stream.js';
import { ERR_SERVER_BUSY } from '../proxy/index.js';
import { PROTOCOL_VERSIONS, featuresOf } from '../mcp/compat.js';
import express from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { GatewayConfig, McpServerConfig, TenantConfig, TenantRole } from '../utils/types.js';
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
import type { CatalogEntry, InstallRequest } from '../catalog/index.js';
import { withTenantScope, canCall, highestRole, roleIn, ROLE_RANK, membershipsOf } from '../auth/tenants.js';
import { globToRegExp } from '../utils/tool-filter.js';
import { ERR_QUOTA_EXCEEDED, usageCsv, type UsageGroup } from './usage.js';
import { ToolInvoker, POLICY_ERROR_CODES, ERR_OUTPUT_BLOCKED } from './invoker.js';
import { ApprovalError } from '../policy/approvals.js';
import { jsonDiff } from './replay.js';
import { FEDERATION_HEADER, verifyFederation } from './federation.js';
import { buildReport, reportMarkdown, PII_CATEGORIES } from '../policy/compliance.js';
import { PortalError, exampleArgs, publicKey, toolSnippets, type PortalStore } from '../portal/index.js';


/** 6.0: the compliance view of PII handling comes from `dlp` (compliance.pii was removed). */
function dlpSummary(cfg: GatewayConfig): { action: string; scope: string; categories: string[]; servers: string[] } | undefined {
  if (!cfg.dlp) return undefined;
  const d = DlpSchema.parse(cfg.dlp);
  if (!d.enabled) return undefined;
  const pol = dlpPolicyFor(d, undefined);
  return { action: pol.clearance === 'restricted' ? 'tag' : pol.strategy, scope: d.scope, categories: PII_CATEGORIES.filter((c) => (d.levels[c] ?? 'x') !== 'public'), servers: d.servers ?? ['*'] };
}

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
  /** Whether the authenticated caller is an operator (no key scope / tenant restriction). */
  isOperator(req: Request): boolean;
  /** REST-semantics tool call (after `authenticate`), for bridges. */
  runToolCall(req: Request, body: Record<string, unknown>, res: ToolCallResponse, opts?: { replayOf?: string; fromPeer?: string }): Promise<void>;
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

/** The subset of an Express response used by `runToolCall` (lets bridges capture results). */
export interface ToolCallResponse {
  status(code: number): ToolCallResponse;
  json(body: unknown): unknown;
  set(field: string, value: string): unknown;
  readonly headersSent: boolean;
}

/** Collects a `runToolCall` outcome instead of writing it to a socket. */
export class CapturedResponse implements ToolCallResponse {
  statusCode = 200;
  body: unknown;
  headers: Record<string, string> = {};
  headersSent = false;
  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  json(body: unknown): this {
    this.body = body;
    this.headersSent = true;
    return this;
  }
  set(field: string, value: string): this {
    this.headers[field.toLowerCase()] = value;
    return this;
  }
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
  /** Called after tenant members change at runtime (refreshes MCP sessions). */
  onTenantsChanged?: () => void;
  /** Developer portal key store (3.8). */
  portal?: PortalStore;
  /** Secrets (3.5): status (never values) and on-demand rotation. */
  secrets?: {
    providers(): Array<{ id: string; type: string }>;
    status(): Array<Record<string, unknown>>;
    rotationSeconds(): number | undefined;
    rotate(): Promise<string[]>;
  };
  /** Upstream catalog (GET /catalog, one-click install). */
  catalog?: {
    installEnabled(): boolean;
    entries(): Array<CatalogEntry & { installed: string[] }>;
    install(id: string, req: InstallRequest): Promise<{ status: number; body: Record<string, unknown> }>;
    uninstall(id: string): Promise<boolean>;
    installedIds(): string[];
  };
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
  // Tenant memberships narrow the scope (servers of the client's tenants, read-only for viewers).
  const applyTenant = (req: Request) => {
    if (!cfg.tenants?.length) return;
    const r = req as AuthedRequest;
    const scoped = withTenantScope(cfg.tenants, r.clientId, r.scope);
    if (scoped) r.scope = scoped;
  };
  const auth: RequestHandler = withLockout(
    (req, res, next) =>
      authMw(req, res, (err?: unknown) => {
        if (err) return next(err);
        applyTenant(req);
        next();
      }),
    () => lockout,
  );
  const rateLimit: RequestHandler = (req, res, next) => limiterFor(req)(req, res, next);
  const protectable =
    (flag: 'health' | 'metrics'): RequestHandler =>
    (req, res, next) =>
      cfg.auth?.protect?.[flag] ? auth(req, res, next) : next();
  const argLimit = () => cfg.security?.maxToolArgumentsBytes;
  const tooLarge = (res: Pick<ToolCallResponse, "status">) =>
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
  router.resolveClient = (clientId) => {
    const r = authMw.resolveClient?.(clientId);
    return r && cfg.tenants?.length ? { ...r, scope: withTenantScope(cfg.tenants, clientId, r.scope) } : r;
  };
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
    cfg = { ...cfg, auth: nextAuth, rateLimit: next.rateLimit, monitor: next.monitor, mcp: next.mcp, security: next.security, policy: next.policy, tenants: next.tenants, quotas: next.quotas, host: cfg.host };
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

  /**
   * One REST-semantics tool call (auth scope, tenants, routing, policy, quotas, status mapping).
   * Used by POST /tools/call and the OpenAI / A2A bridges.
   */
  async function runToolCall(req: Request, body: Record<string, unknown>, res: ToolCallResponse, opts: { replayOf?: string; fromPeer?: string; onProgress?: (u: { progress: number; total?: number; message?: string }) => void; signal?: AbortSignal } = {}): Promise<void> {
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

    // 3.6: `server: "<id>@<peer>"` calls a server of a peer gateway.
    const fed = invoker.federation;
    if (typeof serverId === 'string' && serverId.includes('@') && fed?.enabled && !opts.fromPeer) {
      const at = serverId.lastIndexOf('@');
      const remoteId = serverId.slice(0, at);
      const peer = fed.peer(serverId.slice(at + 1));
      if (!peer || !peer.servers.some((s) => s.id === remoteId)) {
        return void res.status(404).json({ error: 'Not Found', message: `Server "${serverId}" is not exported by any peer gateway` });
      }
      if (!isToolInScope(scope, serverId, tool) || !canCall(scope, serverId)) return void forbidden(`Tool "${tool}" on server "${serverId}" is not allowed for this client`);
      const tenant0 = cfg.tenants?.length ? membershipsOf(cfg.tenants, (req as AuthedRequest).clientId).map((m) => m.tenant)[0] : undefined;
      if (invoker.compliance && !invoker.compliance.residencyAllows(tenant0, peer.region)) {
        invoker.compliance.noteResidencyBlock();
        return void forbidden(`Data residency: peer "${peer.id}" (${peer.region ?? 'unknown region'}) is outside the allowed regions`);
      }
      const r = await fed.forward(peer, { server: remoteId, tool, arguments: args as Record<string, unknown>, clientId: (req as AuthedRequest).clientId });
      if (res.headersSent) return;
      if (r.success) return void res.json({ result: r.result, server: serverId, tool, durationMs: r.durationMs, peer: peer.id });
      return void res.status(502).json({ error: 'Bad Gateway', message: r.error?.message, code: r.error?.code, peer: peer.id });
    }

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

    if (isToolInScope(scope, targetServerId, tool) && !canCall(scope, targetServerId)) {
      forbidden(`Read-only role: tool calls on server "${targetServerId}" need the admin or owner role`);
      return;
    }
    if (!isToolInScope(scope, targetServerId, tool)) {
      forbidden(`Tool "${tool}" on server "${targetServerId}" is not allowed for this client`);
      return;
    }

    if (opts.fromPeer && !invoker.federation?.exports(targetServerId)) {
      return void forbidden(`Server "${targetServerId}" is not exported to peer gateways`);
    }
    const peerFailover = !opts.fromPeer && !!invoker.federation?.failsOver(targetServerId) && invoker.federation.candidates(targetServerId, tool).length > 0;
    if (!peerFailover && !(invoker.balancer?.anyConnected(targetServerId) ?? proxy.isConnected(targetServerId))) {
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
      ...(opts.replayOf ? { replayOf: opts.replayOf } : {}),
      ...(opts.fromPeer ? { fromPeer: opts.fromPeer } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    if (res.headersSent) return;
    if (result.traceparent) res.set('traceparent', result.traceparent);

    if (!result.success && result.error?.code === ERR_QUOTA_EXCEEDED) {
      const data = result.error.data as { resetsAt?: string } | undefined;
      const reset = data?.resetsAt ? Date.parse(data.resetsAt) : NaN;
      if (Number.isFinite(reset)) res.set('Retry-After', String(Math.max(1, Math.ceil((reset - Date.now()) / 1000))));
      res.status(429).json({ error: 'Too Many Requests', message: result.error.message, code: result.error.code, quota: result.error.data });
      return;
    }
    if (!result.success && result.error && POLICY_ERROR_CODES.has(result.error.code)) {
      res.status(result.error.code === ERR_OUTPUT_BLOCKED ? 502 : 403).json({
        error: result.error.code === ERR_OUTPUT_BLOCKED ? 'Tool Output Blocked' : 'Forbidden',
        message: result.error.message,
        code: result.error.code,
        policy: result.error.data,
      });
      return;
    }

    if (!result.success && result.error?.code === ERR_SERVER_BUSY) {
      res.set('Retry-After', '1');
      res.status(503).json({ error: 'Service Unavailable', message: result.error.message, code: result.error.code });
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
      ...(result.requestId ? { requestId: result.requestId } : {}),
    });
  }
  router.runToolCall = runToolCall;
  router.isOperator = (req: Request) => !isRestricted(scopeOf(req));

  router.post(
    '/tools/call',
    auth,
    rateLimit,
    asyncHandler(async (req, res) => {
      await runToolCall(req, (req.body ?? {}) as Record<string, unknown>, res);
    }),
  );

  // 4.4: streaming tool results (SSE) with backpressure.
  router.post(
    '/tools/stream',
    auth,
    rateLimit,
    asyncHandler(async (req, res) => {
      const limits = cfg.streaming ?? {};
      res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      const sse = new SseWriter(res, limits);
      const abort = new AbortController();
      res.once('close', () => {
        if (!res.writableFinished) abort.abort();
      });
      const captured = new CapturedResponse();
      await runToolCall(req, (req.body ?? {}) as Record<string, unknown>, captured, {
        signal: abort.signal,
        onProgress: (u) => {
          sse.send('progress', u, true);
          if (typeof u.message === 'string' && u.message) sse.send('partial', { text: u.message }, true);
        },
      });
      if (sse.isClosed) return;
      const ok = captured.statusCode < 400;
      sse.send(ok ? 'result' : 'error', { status: captured.statusCode, ...(captured.body as Record<string, unknown>) });
      sse.send('end', { coalesced: sse.stats.coalesced });
      sse.close();
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
  /** Operators, or tenant admins / owners (for their tenants' servers) without key-level restrictions. */
  const approverOnly = (req: Request, res: Response): boolean => {
    const scope = scopeOf(req);
    if (!isRestricted(scope)) return true;
    const role = highestRole(scope);
    if (scope && !scope.servers && !scope.tools && role && ROLE_RANK[role] >= ROLE_RANK.admin) return true;
    res.status(403).json({ error: 'Forbidden', message: 'Scoped clients cannot manage approvals' });
    return false;
  };
  const approvalVisible = (req: Request, serverId: string) => canCall(scopeOf(req), serverId) && isServerInScope(scopeOf(req), serverId);

  router.get('/approvals', auth, (req, res) => {
    if (!approverOnly(req, res)) return;
    const list = invoker.approvals.list();
    const mine = (a: { serverId: string }) => approvalVisible(req, a.serverId);
    res.set('Cache-Control', 'no-store').json({ ...list, pending: list.pending.filter(mine), recent: list.recent.filter(mine) });
  });

  router.get('/approvals/:id', auth, (req, res) => {
    if (!approverOnly(req, res)) return;
    const a = invoker.approvals.get(req.params.id!);
    if (!a || !approvalVisible(req, a.serverId)) return void res.status(404).json({ error: 'Not Found', message: 'Approval request not found' });
    res.json(a);
  });

  for (const action of ['approve', 'deny'] as const) {
    router.post(`/approvals/:id/${action}`, auth, (req, res) => {
      if (!approverOnly(req, res)) return;
      const held = invoker.approvals.get(req.params.id!);
      if (held && !approvalVisible(req, held.serverId)) return void res.status(404).json({ error: 'Not Found', message: 'Approval request not found' });
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

  // ─── Tenants (workspaces, RBAC) ─────────────────────────────────────────────

  const tenantView = (t: TenantConfig, role: TenantRole | undefined, operator: boolean) => ({
    id: t.id,
    name: t.name ?? t.id,
    role: role ?? (operator ? 'operator' : undefined),
    servers: t.servers,
    serverIds: registry
      .getAllServers()
      .filter((s) => !s.replicaOf && t.servers.some((p) => globToRegExp(p).test(s.id)))
      .map((s) => s.id),
    ...(operator || (role && ROLE_RANK[role] >= ROLE_RANK.admin) ? { members: t.members ?? [] } : {}),
  });
  const isOperator = (req: Request) => !isRestricted(scopeOf(req));
  const findTenant = (id: string) => cfg.tenants?.find((t) => t.id === id);

  router.get('/tenants', auth, (req, res) => {
    const clientId = (req as AuthedRequest).clientId;
    const operator = isOperator(req);
    const list = (cfg.tenants ?? [])
      .map((t) => ({ t, role: roleIn(t, clientId) }))
      .filter(({ role }) => operator || role)
      .map(({ t, role }) => tenantView(t, role, operator));
    res.json({ tenants: list, clientId: clientId ?? 'anonymous', operator });
  });

  router.get('/tenants/:id', auth, (req, res) => {
    const t = findTenant(req.params.id!);
    const role = t ? roleIn(t, (req as AuthedRequest).clientId) : undefined;
    if (!t || (!role && !isOperator(req))) return void res.status(404).json({ error: 'Not Found', message: 'Tenant not found' });
    res.json(tenantView(t, role, isOperator(req)));
  });

  // Owners (and operators) manage members at runtime. Not persisted: also update the config file.
  const ownerOf = (req: Request, res: Response): TenantConfig | undefined => {
    const t = findTenant(req.params.id!);
    const role = t ? roleIn(t, (req as AuthedRequest).clientId) : undefined;
    if (!t || (!role && !isOperator(req))) return void res.status(404).json({ error: 'Not Found', message: 'Tenant not found' });
    if (!isOperator(req) && role !== 'owner') return void res.status(403).json({ error: 'Forbidden', message: 'Only tenant owners can manage members' });
    return t;
  };
  router.put('/tenants/:id/members', auth, (req, res) => {
    const t = ownerOf(req, res);
    if (!t) return;
    const body = (req.body ?? {}) as { client?: unknown; role?: unknown };
    if (typeof body.client !== 'string' || !body.client || !['owner', 'admin', 'viewer'].includes(String(body.role))) {
      return void res.status(400).json({ error: 'Bad Request', message: 'Body must be { "client": "<client id glob>", "role": "owner" | "admin" | "viewer" }' });
    }
    const members = (t.members ??= []);
    const existing = members.find((m) => m.client === body.client);
    if (existing) existing.role = body.role as TenantRole;
    else members.push({ client: body.client, role: body.role as TenantRole });
    logger.info(`Tenant ${t.id}: ${body.client} is now ${String(body.role)} (by ${(req as AuthedRequest).clientId ?? 'operator'})`);
    options.onTenantsChanged?.();
    res.json(tenantView(t, roleIn(t, (req as AuthedRequest).clientId), isOperator(req)));
  });
  router.delete('/tenants/:id/members/:client', auth, (req, res) => {
    const t = ownerOf(req, res);
    if (!t) return;
    const before = t.members?.length ?? 0;
    const remaining = (t.members ?? []).filter((m) => m.client !== req.params.client);
    if (remaining.length === before) return void res.status(404).json({ error: 'Not Found', message: 'Member not found' });
    if (!remaining.some((m) => m.role === 'owner') && (t.members ?? []).some((m) => m.role === 'owner')) {
      return void res.status(409).json({ error: 'Conflict', message: 'A tenant must keep at least one owner' });
    }
    t.members = remaining;
    options.onTenantsChanged?.();
    res.json(tenantView(t, roleIn(t, (req as AuthedRequest).clientId), isOperator(req)));
  });

  // ─── Usage metering + quotas ───────────────────────────────────────────────

  /** Tenant filter for the caller: operators any (or none); tenant admins / owners only their tenants. */
  const usageTenant = (req: Request, res: Response): { ok: boolean; tenant?: string } => {
    const q = typeof req.query.tenant === 'string' && req.query.tenant ? req.query.tenant : undefined;
    if (isOperator(req)) return { ok: true, tenant: q };
    const admin = (scopeOf(req)?.tenants ?? []).filter((t) => ROLE_RANK[t.role] >= ROLE_RANK.admin).map((t) => t.id);
    const tenant = q ?? admin[0];
    if (!tenant || !admin.includes(tenant)) {
      res.status(403).json({ error: 'Forbidden', message: 'Usage is available to operators and tenant admins / owners' });
      return { ok: false };
    }
    return { ok: true, tenant };
  };
  const GROUPS: UsageGroup[] = ['client', 'tenant', 'server', 'tool', 'hour', 'day'];

  router.get('/usage', auth, (req, res) => {
    const scope = usageTenant(req, res);
    if (!scope.ok) return;
    const time = (k: string): number | undefined => {
      const v = typeof req.query[k] === 'string' ? (req.query[k] as string) : '';
      if (!v) return undefined;
      const t = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
      return Number.isFinite(t) ? t : undefined;
    };
    const group = (typeof req.query.group === 'string' ? req.query.group.split(',') : ['client']).filter((g): g is UsageGroup => (GROUPS as string[]).includes(g));
    const rows = invoker.usage?.report({
      since: time('since'),
      until: time('until'),
      group,
      tenant: scope.tenant,
      client: typeof req.query.client === 'string' && req.query.client ? req.query.client : undefined,
      server: typeof req.query.server === 'string' && req.query.server ? req.query.server : undefined,
    }) ?? [];
    if (req.query.format === 'csv') {
      res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="mcp-gateway-usage.csv"').send(usageCsv(rows, group));
      return;
    }
    res.json({ group: group.length ? group : ['client'], rows, generatedAt: new Date().toISOString() });
  });

  router.get('/quotas', auth, (req, res) => {
    const scope = usageTenant(req, res);
    if (!scope.ok) return;
    const all = invoker.usage?.quotaStatus() ?? [];
    res.json({
      rules: cfg.quotas?.rules ?? [],
      usage: isOperator(req) && !scope.tenant ? all : all.filter((u) => u.subject === `tenant:${scope.tenant}`),
    });
  });

  // ─── Catalog (operator) ─────────────────────────────────────────────────────

  // 4.1: MCP revisions — what /mcp accepts, which features each revision gets, what each upstream negotiated.
  router.get('/mcp/protocol', auth, (req, res) => {
    const scope = scopeOf(req);
    res.json({
      latest: PROTOCOL_VERSIONS[0],
      supported: [...PROTOCOL_VERSIONS],
      features: Object.fromEntries(PROTOCOL_VERSIONS.map((v) => [v, featuresOf(v)])),
      upstream: registry
        .getAllServers()
        .filter((s) => isServerInScope(scope, s.id))
        .map((s) => ({ server: s.id, protocolVersion: proxy.getSessionInfo(s.id)?.protocolVersion ?? null })),
    });
  });

  router.get('/catalog', auth, (req, res) => {
    if (!operatorOnly(req, res)) return;
    const c = options.catalog;
    res.json({ install: c?.installEnabled() ?? false, entries: c?.entries() ?? [], installedServers: c?.installedIds() ?? [] });
  });
  router.post(
    '/catalog/:id/install',
    auth,
    asyncHandler(async (req, res) => {
      if (!operatorOnly(req, res)) return;
      if (!options.catalog) return void res.status(501).json({ error: 'Not Implemented' });
      const b = (req.body ?? {}) as Record<string, unknown>;
      const strMap = (v: unknown) =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === 'string')) as Record<string, string>
          : undefined;
      const r = await options.catalog.install(req.params.id!, {
        serverId: typeof b.serverId === 'string' && b.serverId ? b.serverId : undefined,
        name: typeof b.name === 'string' && b.name ? b.name : undefined,
        env: strMap(b.env),
        args: Array.isArray(b.args) ? b.args.filter((x): x is string => typeof x === 'string') : undefined,
        tags: Array.isArray(b.tags) ? b.tags.filter((x): x is string => typeof x === 'string') : undefined,
      });
      res.status(r.status).json(r.body);
    }),
  );
  router.delete(
    '/catalog/servers/:id',
    auth,
    asyncHandler(async (req, res) => {
      if (!operatorOnly(req, res)) return;
      const ok = (await options.catalog?.uninstall(req.params.id!)) ?? false;
      if (!ok) return void res.status(404).json({ error: 'Not Found', message: 'No catalog-installed server with that id' });
      res.json({ removed: req.params.id });
    }),
  );

  // Tool result cache: stats and purge (operator view).
  router.get('/cache', auth, (req, res) => {
    if (!operatorOnly(req, res)) return;
    res.json(invoker.cache?.snapshot() ?? { enabled: false });
  });
  router.delete('/cache', auth, (req, res) => {
    if (!operatorOnly(req, res)) return;
    const server = typeof req.query.server === 'string' && req.query.server ? req.query.server : undefined;
    res.json({ purged: invoker.cache?.purge(server) ?? 0 });
  });

  // Load balancing: members, health and ejection per server with replicas (operator view).
  router.get('/load-balancing', auth, (req, res) => {
    if (!operatorOnly(req, res)) return;
    res.json({ groups: invoker.balancer?.snapshot() ?? [] });
  });

  // ─── Developer portal (3.8) ─────────────────────────────────────────────────
  const portal = options.portal;
  const portalOn = (res: Response): boolean => {
    if (!portal || !cfg.portal?.enabled) {
      res.status(404).json({ error: 'Not Found', message: 'The developer portal is not enabled' });
      return false;
    }
    return true;
  };
  const portalFail = (res: Response, err: unknown) => {
    if (err instanceof PortalError) return void res.status(err.status).json({ error: err.status === 404 ? 'Not Found' : err.status === 403 ? 'Forbidden' : err.status === 409 ? 'Conflict' : 'Bad Request', message: err.message });
    throw err;
  };
  // Per-IP signup throttle (in memory): 10 per hour.
  const signups = new Map<string, number[]>();
  const publicBase = (req: Request) => (cfg.portal?.publicUrl ?? `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

  router.get('/portal/info', (_req, res) => {
    if (!portalOn(res)) return;
    res.json({ title: cfg.portal!.title ?? 'MCP Gateway developer portal', signup: cfg.portal!.signup ?? 'approval', allowedEmailDomains: cfg.portal!.allowedEmailDomains ?? [], version: VERSION, defaults: { servers: cfg.portal!.defaults?.servers ?? ['*'], rateLimit: cfg.portal!.defaults?.rateLimit ?? null, keyTtlDays: cfg.portal!.defaults?.keyTtlDays ?? null } });
  });

  router.post('/portal/signup', (req, res) => {
    if (!portalOn(res)) return;
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    const recent = (signups.get(ip) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= 10) return void res.status(429).json({ error: 'Too Many Requests', message: 'Too many signups from this address; try again later' });
    try {
      const { record, key } = portal!.signup((req.body ?? {}) as Record<string, unknown>);
      signups.set(ip, [...recent, now]);
      res.status(201).set('Cache-Control', 'no-store').json({
        ...publicKey(record),
        key,
        message: record.status === 'active' ? 'Your key is active. It is shown only once — store it now.' : 'Your key was created and waits for an operator to approve it. It is shown only once — store it now.',
      });
    } catch (err) {
      portalFail(res, err);
    }
  });

  /** The portal key of the caller (developer endpoints). */
  const myKey = (req: Request, res: Response) => {
    if (!portalOn(res)) return undefined;
    const k = portal!.byClientId((req as AuthedRequest).clientId);
    if (!k || k.status !== 'active') {
      res.status(403).json({ error: 'Forbidden', message: 'This endpoint is for developer-portal keys' });
      return undefined;
    }
    return k;
  };

  router.get('/portal/me', auth, (req, res) => {
    const k = myKey(req, res);
    if (!k) return;
    const since = Date.now() - 7 * 86_400_000;
    const byTool = new Map<string, number>();
    const byDay = new Map<string, number>();
    let calls = 0, errors = 0, totalMs = 0;
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const p = metrics.queryRequests({ limit: 500, cursor, since, clientId: `key:portal-${k.id}` });
      for (const r of p.requests) {
        calls++;
        if (!r.success) errors++;
        totalMs += r.durationMs;
        const tool = `${r.serverId}/${r.toolName}`;
        byTool.set(tool, (byTool.get(tool) ?? 0) + 1);
        const day = new Date(r.timestamp).toISOString().slice(0, 10);
        byDay.set(day, (byDay.get(day) ?? 0) + 1);
      }
      if (!p.nextCursor) break;
      cursor = p.nextCursor;
    }
    res.set('Cache-Control', 'no-store').json({
      key: publicKey(k),
      usage: {
        since: new Date(since).toISOString(),
        calls, errors, avgLatencyMs: calls ? Math.round(totalMs / calls) : 0,
        byTool: [...byTool.entries()].sort((a, b) => b[1] - a[1]).map(([tool, n]) => ({ tool, calls: n })),
        byDay: [...byDay.entries()].sort().map(([day, n]) => ({ day, calls: n })),
      },
    });
  });

  router.post('/portal/me/rotate', auth, (req, res) => {
    const k = myKey(req, res);
    if (!k) return;
    const { record, key } = portal!.rotate(k.id);
    res.set('Cache-Control', 'no-store').json({ ...publicKey(record), key, message: 'New key issued; the previous one no longer works.' });
  });

  router.delete('/portal/me', auth, (req, res) => {
    const k = myKey(req, res);
    if (!k) return;
    res.json(publicKey(portal!.revoke(k.id)));
  });

  // Interactive docs: the tools the caller may use, with example arguments and snippets.
  router.get('/portal/tools', auth, (req, res) => {
    if (!portalOn(res)) return;
    const base = publicBase(req);
    const tools = filterToolsByScope(scopeOf(req), registry.getAllTools()).map((t) => {
      const example = exampleArgs(t.inputSchema ?? { type: 'object' });
      return { server: t.serverId, name: t.name, description: t.description, inputSchema: t.inputSchema, example, snippets: toolSnippets(base, t.serverId, t.name, example) };
    });
    res.json({ tools, total: tools.length, tryIt: `${base}/api/v1/tools/call` });
  });

  // Operators: review keys.
  router.get('/portal/keys', auth, (req, res) => {
    if (!operatorOnly(req, res) || !portalOn(res)) return;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    res.set('Cache-Control', 'no-store').json({ keys: portal!.list().filter((k) => !status || k.status === status).map(publicKey) });
  });

  router.post('/portal/keys/:id/:action', auth, (req, res) => {
    if (!operatorOnly(req, res) || !portalOn(res)) return;
    const { id, action } = req.params as { id: string; action: string };
    try {
      if (action === 'approve' || action === 'deny') return void res.json(publicKey(portal!.decide(id, action === 'approve')));
      if (action === 'revoke') return void res.json(publicKey(portal!.revoke(id)));
      res.status(404).json({ error: 'Not Found', message: 'action must be approve, deny or revoke' });
    } catch (err) {
      portalFail(res, err);
    }
  });

  // ─── Compliance (3.7) ───────────────────────────────────────────────────────
  router.get('/compliance', auth, (req, res) => {
    if (!operatorOnly(req, res)) return;
    const comp = invoker.compliance;
    const c = cfg.compliance;
    res.json({
      pii: dlpSummary(cfg) ?? null,
      residency: { rules: c?.residency?.rules ?? [], allowUnknown: c?.residency?.allowUnknown === true, servers: cfg.servers.filter((s) => s.region).map((s) => ({ id: s.id, region: s.region })) },
      findings: { ...dlpStats.byCategory },
      blocked: { pii: dlpStats.byAction.block ?? 0, residency: comp?.blocked.residency ?? 0 },
    });
  });

  router.get('/compliance/report', auth, (req, res) => {
    if (!operatorOnly(req, res)) return;
    const framework = String(req.query.framework ?? 'soc2');
    if (framework !== 'soc2' && framework !== 'gdpr') return void res.status(400).json({ error: 'Bad Request', message: '"framework" must be soc2 or gdpr' });
    const t = (v: unknown, d: number) => {
      if (typeof v !== 'string' || !v) return d;
      const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
      return Number.isFinite(n) ? n : NaN;
    };
    const until = t(req.query.until, Date.now());
    const since = t(req.query.since, until - 30 * 86_400_000);
    if (!Number.isFinite(since) || !Number.isFinite(until)) return void res.status(400).json({ error: 'Bad Request', message: '"since" / "until" must be ISO dates or epoch milliseconds' });
    // Walk the history (memory or audit log), bounded.
    let calls = 0, errors = 0, denied = 0;
    const clients = new Map<string, number>();
    let cursor: string | undefined;
    for (let page = 0; page < 40; page++) {
      const p = metrics.queryRequests({ limit: 500, cursor, since, until });
      for (const r of p.requests) {
        calls++;
        if (!r.success) {
          errors++;
          if (r.durationMs === 0) denied++;
        }
        const c = r.clientId ?? 'anonymous';
        clients.set(c, (clients.get(c) ?? 0) + 1);
      }
      if (!p.nextCursor) break;
      cursor = p.nextCursor;
    }
    const comp = invoker.compliance;
    const remote = cfg.servers.filter((s) => s.url);
    const report = buildReport({
      framework,
      generatedAt: new Date().toISOString(),
      gatewayVersion: VERSION,
      period: { since: new Date(since).toISOString(), until: new Date(until).toISOString() },
      config: {
        authStrategy: cfg.auth?.strategy ?? 'none',
        tenants: cfg.tenants?.length ?? 0,
        auditEnabled: cfg.audit?.enabled === true,
        auditRetentionDays: cfg.audit?.enabled ? (cfg.audit.retentionDays ?? 30) : undefined,
        tlsUpstreams: remote.filter((s) => /^(https|wss):/.test(s.url!)).length,
        plainUpstreams: remote.filter((s) => /^(http|ws):/.test(s.url!) && !/^(https?|wss?):\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(s.url!)).length,
        policyRules: cfg.policy?.rules?.length ?? 0,
        approvals: (cfg.policy?.rules ?? []).some((r) => (r as { effect?: string }).effect === 'approve'),
        outputFilter: !!cfg.policy?.outputFilter && cfg.policy.outputFilter.enabled !== false,
        pii: dlpSummary(cfg),
        residencyRules: cfg.compliance?.residency?.rules?.length ?? 0,
        secretsProviders: cfg.secrets?.providers?.length ?? 0,
        rotationSeconds: cfg.secrets?.rotation?.intervalSeconds,
        rateLimit: !!cfg.rateLimit,
        authLockout: !!cfg.security?.authLockout,
        redactPatterns: cfg.security?.redactPatterns?.length ?? 0,
      },
      activity: {
        calls, errors, denied,
        clients: [...clients.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([client, n]) => ({ client, calls: n })),
        piiFindings: { ...dlpStats.byCategory },
        blocked: { pii: dlpStats.byAction.block ?? 0, residency: comp?.blocked.residency ?? 0 },
      },
      warnings: securityWarnings(cfg).map((w) => ({ id: w.id, severity: w.level, message: w.message })),
    });
    res.set('Cache-Control', 'no-store');
    if (req.query.format === 'md' || req.query.format === 'markdown') return void res.type('text/markdown').send(reportMarkdown(report));
    res.json(report);
  });

  // ─── Federation (3.6) ───────────────────────────────────────────────────────
  /** Peer endpoints are authenticated by the federation HMAC, not by client credentials. */
  const peerAuth = (req: Request, res: Response): string | undefined => {
    const fed = invoker.federation;
    const fcfg = cfg.federation;
    if (!fed?.enabled || !fcfg) {
      res.status(404).json({ error: 'Not Found', message: 'Federation is not enabled' });
      return undefined;
    }
    const body = req.method === 'GET' ? '' : JSON.stringify(req.body ?? {});
    const v = verifyFederation(req.get(FEDERATION_HEADER), fcfg.sharedSecret, req.method, req.originalUrl.split('?')[0]!, body);
    if ('error' in v) {
      res.status(401).json({ error: 'Unauthorized', message: v.error });
      return undefined;
    }
    if (!(fcfg.peers ?? []).some((p) => p.id === v.peer)) {
      res.status(403).json({ error: 'Forbidden', message: `"${v.peer}" is not a configured peer` });
      return undefined;
    }
    return v.peer;
  };

  router.get('/federation/catalog', (req, res) => {
    if (!peerAuth(req, res)) return;
    res.set('Cache-Control', 'no-store').json(invoker.federation!.catalog());
  });

  router.post(
    '/federation/call',
    asyncHandler(async (req, res) => {
      const peer = peerAuth(req, res);
      if (!peer) return;
      const b = (req.body ?? {}) as Record<string, unknown>;
      (req as AuthedRequest).clientId = `peer:${peer}`;
      await runToolCall(req, { server: b.server, tool: b.tool, arguments: b.arguments ?? {} }, res as unknown as ToolCallResponse, { fromPeer: peer });
    }),
  );

  router.get('/federation', auth, (req, res) => {
    if (!operatorOnly(req, res)) return;
    const fed = invoker.federation;
    res.json(fed ? { ...fed.snapshot(), exported: fed.enabled ? fed.catalog().servers.map((s) => s.id) : [] } : { enabled: false, peers: [] });
  });

  router.post(
    '/federation/sync',
    auth,
    asyncHandler(async (req, res) => {
      if (!operatorOnly(req, res)) return;
      const fed = invoker.federation;
      if (!fed?.enabled) return void res.status(404).json({ error: 'Not Found', message: 'Federation is not enabled' });
      await fed.sync();
      res.json(fed.snapshot());
    }),
  );

  // ─── Secrets (3.5) ──────────────────────────────────────────────────────────
  router.get('/secrets', auth, (req, res) => {
    if (!operatorOnly(req, res)) return;
    const sec = options.secrets;
    res.set('Cache-Control', 'no-store').json({
      providers: sec?.providers() ?? [],
      rotation: { intervalSeconds: sec?.rotationSeconds() ?? null },
      secrets: sec?.status() ?? [],
    });
  });

  router.post(
    '/secrets/rotate',
    auth,
    asyncHandler(async (req, res) => {
      if (!operatorOnly(req, res)) return;
      if (!options.secrets) return void res.status(501).json({ error: 'Not Implemented', message: 'Secrets are not available' });
      const rotated = await options.secrets.rotate();
      logger.info(`Secret rotation requested via API: ${rotated.length} server(s) reconnected`);
      res.json({ rotated });
    }),
  );

  // ─── Smart routing (3.4) ────────────────────────────────────────────────────
  router.get('/routing', auth, (req, res) => {
    if (!operatorOnly(req, res)) return;
    res.json({
      splits: invoker.router?.snapshot() ?? [],
      groups: (invoker.balancer?.snapshot() ?? []).filter((g) => g.strategy === 'smart'),
    });
  });

  router.post('/routing/splits/:name/reset', auth, (req, res) => {
    if (!operatorOnly(req, res)) return;
    const name = req.params.name!;
    if (!(invoker.router?.snapshot() ?? []).some((s) => s.name === name)) {
      return void res.status(404).json({ error: 'Not Found', message: `No traffic split "${name}"` });
    }
    invoker.router!.reset(name);
    logger.info(`Traffic split "${name}" reset (stats and rollbacks cleared)`);
    res.json({ ok: true, split: invoker.router!.snapshot().find((s) => s.name === name) });
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

  // ─── Plugins (3.3) ──────────────────────────────────────────────────────────
  router.get('/plugins', auth, (req, res) => {
    if (!operatorOnly(req, res)) return;
    const list = invoker.pluginHost?.list() ?? [];
    res.json({
      plugins: list.map((p) => {
        const w = p as unknown as { stats?: () => Array<{ key: string; calls: number; alive: boolean }>; isolation?: string };
        const hooks = (['onRequest', 'onToolCall', 'onResponse', 'onError', 'onConfigChange'] as const).filter((h) => typeof (p as unknown as Record<string, unknown>)[h] === 'function');
        return {
          name: p.name,
          apiVersion: p.apiVersion ?? 1,
          kind: typeof w.stats === 'function' ? 'wasm' : 'module',
          hooks,
          ...(typeof w.stats === 'function' ? { isolation: w.isolation, sandboxes: w.stats() } : {}),
        };
      }),
    });
  });

  // ─── Replay / debugger (3.2) ────────────────────────────────────────────────

  /** A captured call the caller may see: operators any, restricted clients only their own. */
  const capturedFor = (req: Request, res: Response) => {
    const rec = invoker.recorder;
    if (!rec?.enabled) {
      res.status(404).json({ error: 'Not Found', message: 'Request capture is off (replay.enabled: true turns it on)' });
      return undefined;
    }
    const c = rec.get(req.params.id!);
    const own = isRestricted(scopeOf(req)) ? (req as AuthedRequest).clientId ?? '' : undefined;
    if (!c || (own !== undefined && (c.clientId ?? '') !== own)) {
      res.status(404).json({ error: 'Not Found', message: 'No captured call with that id (it may have been evicted)' });
      return undefined;
    }
    return c;
  };

  router.get('/requests/:id', auth, (req, res) => {
    const c = capturedFor(req, res);
    if (c) res.set('Cache-Control', 'no-store').json(c);
  });

  router.post(
    '/requests/:id/replay',
    auth,
    asyncHandler(async (req, res) => {
      const c = capturedFor(req, res);
      if (!c) return;
      if (c.kind !== 'tool') return void res.status(400).json({ error: 'Bad Request', message: 'Only tool calls can be replayed' });
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (b.arguments !== undefined && (typeof b.arguments !== 'object' || b.arguments === null || Array.isArray(b.arguments))) {
        return void res.status(400).json({ error: 'Bad Request', message: '"arguments" must be an object' });
      }
      const args = (b.arguments as Record<string, unknown> | undefined) ?? c.arguments;
      if (!args) return void res.status(409).json({ error: 'Conflict', message: 'The arguments of this call were not captured (too large); pass "arguments"' });
      const server = typeof b.server === 'string' && b.server ? b.server : c.serverId;
      const out = new CapturedResponse();
      // Through the normal pipeline with the caller's own credentials (scopes, policy, quotas, rate limits apply).
      await runToolCall(req, { tool: c.tool, server, arguments: args }, out, { replayOf: c.id });
      const replayBody = out.body as Record<string, unknown> | undefined;
      const replayResult = out.statusCode === 200 ? replayBody?.result : undefined;
      res.json({
        original: { id: c.id, serverId: c.serverId, arguments: c.arguments, success: c.success, durationMs: c.durationMs, result: c.result, error: c.error },
        replay: { status: out.statusCode, requestId: replayBody?.requestId, server, arguments: args, durationMs: replayBody?.durationMs, body: replayBody },
        diff: c.result !== undefined && replayResult !== undefined ? jsonDiff(c.result, replayResult) : null,
        identical: c.result !== undefined && replayResult !== undefined ? jsonDiff(c.result, replayResult, 1).length === 0 : null,
      });
    }),
  );

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
