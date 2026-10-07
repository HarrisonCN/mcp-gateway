/**
 * Gateway bootstrap — wires together all subsystems
 */

import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { GatewayConfig, McpServerConfig } from '../utils/types.js';
import { ServerRegistry } from '../registry/index.js';
import { McpProxy } from '../proxy/index.js';
import { MetricsCollector } from '../monitor/index.js';
import { createApiRouter, type ApiRouter } from './api.js';
import { ServerSupervisor } from './supervisor.js';
import { createLiveRouter, type LiveRouter } from './live.js';
import { corsMiddleware } from '../middleware/cors.js';
import { requestIdMiddleware } from '../middleware/request-id.js';
import { createErrorHandler, notFoundHandler } from '../middleware/error-handler.js';
import { dashboardCsp, securityHeadersMiddleware } from '../security/headers.js';
import { defaultAllowedHosts, hostCheckMiddleware, ipAllowlistMiddleware } from '../security/network.js';
import { configureRedaction } from '../security/redact.js';
import { securityWarnings } from '../security/posture.js';
import { logger } from '../utils/logger.js';
import { Mutex } from '../utils/mutex.js';
import { VERSION } from '../utils/version.js';
import { McpEndpoint } from '../mcp/endpoint.js';
import { SqliteAuditStore } from '../monitor/audit.js';
import { createStateStore, type StateStore } from '../state/index.js';
import { PROTECTED_RESOURCE_METADATA_PATH, protectedResourceMetadata } from '../auth/oauth.js';

function findDashboard(): string | undefined {
  // src/gateway → ../../dashboard (tsx) and dist/gateway → ../../dashboard (built)
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(here, '../../dashboard/index.html');
  return existsSync(file) ? file : undefined;
}

export interface GatewayOptions {
  /** Use this state store instead of building one from `config.state` (embedding / custom backends). */
  stateStore?: StateStore;
}

export class Gateway {
  private readonly app = express();
  private readonly server: Server = createServer(this.app);
  private readonly registry: ServerRegistry;
  private readonly proxy: McpProxy;
  private readonly metrics: MetricsCollector;
  private readonly supervisor: ServerSupervisor;
  private router?: ApiRouter;
  private mcp?: McpEndpoint;
  private live?: LiveRouter;
  private cors: express.RequestHandler;
  private ipFilter?: express.RequestHandler;
  private jsonParser: express.RequestHandler;
  private readonly reloadLock = new Mutex();
  private started = false;
  private stopping?: Promise<void>;
  private stateStore?: StateStore;

  constructor(
    private config: GatewayConfig,
    private readonly options: GatewayOptions = {},
  ) {
    this.registry = new ServerRegistry(config.healthCheckIntervalMs ?? 30_000);
    this.proxy = new McpProxy();
    this.metrics = new MetricsCollector(config.monitor);
    this.supervisor = new ServerSupervisor(this.proxy, this.registry, { reconnect: config.reconnect });
    this.cors = corsMiddleware({ origins: config.corsOrigins ?? ['*'] });
    this.jsonParser = express.json({ limit: this.maxBodyBytes() });
    configureRedaction(config.security?.redactPatterns);
    this.ipFilter = config.security?.ipAllowlist ? ipAllowlistMiddleware(config.security.ipAllowlist) : undefined;
  }

  private maxBodyBytes(): number {
    return this.config.security?.maxBodyBytes ?? 10 * 1024 * 1024;
  }

  /** Host header patterns to enforce (undefined = no check). */
  private allowedHosts(): readonly string[] | undefined {
    const sec = this.config.security;
    if (sec?.allowedHosts) return sec.allowedHosts;
    return sec?.dnsRebindingProtection ? defaultAllowedHosts(this.config.host) : undefined;
  }

  private applyTrustProxy(): void {
    const tp = this.config.security?.trustProxy ?? false;
    try {
      this.app.set('trust proxy', tp);
    } catch (err) {
      throw new Error(`Invalid security.trustProxy: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('Gateway already started');
    this.started = true;
    logger.setLevel(this.config.logLevel ?? 'info');

    this.stateStore = this.options.stateStore ?? createStateStore(this.config.state);
    const shared = this.stateStore.kind === 'memory' ? undefined : { store: this.stateStore, failureMode: this.config.state?.failureMode };
    if (shared) {
      try {
        await this.stateStore.ping();
        logger.info(`Shared state store: ${this.stateStore.kind}`);
      } catch (err) {
        logger.warn(
          `Shared state store (${this.stateStore.kind}) is not reachable yet: ${err instanceof Error ? err.message : String(err)}` +
            ` — failing ${this.config.state?.failureMode ?? 'open'} until it is`,
        );
      }
    }

    // Builds auth/rate-limit; throws on insecure misconfiguration (fail closed)
    this.router = createApiRouter(this.config, this.registry, this.proxy, this.metrics, {
      supervisor: this.supervisor,
      isShuttingDown: () => this.stopping !== undefined,
      shared,
    });

    this.app.disable('x-powered-by');
    this.applyTrustProxy();
    this.app.use(requestIdMiddleware);
    this.app.use(securityHeadersMiddleware(() => this.config.security));
    // Network guards first: nothing else (not even CORS preflights) runs for
    // a disallowed client address or Host header.
    this.app.use((req, res, next) => (this.ipFilter ? this.ipFilter(req, res, next) : next()));
    this.app.use(hostCheckMiddleware(() => this.allowedHosts()));
    // Previously an inline handler joined multiple origins into one
    // Access-Control-Allow-Origin value, which browsers reject.
    // Indirection so CORS origins can be hot reloaded.
    this.app.use((req, res, next) => this.cors(req, res, next));

    // OAuth 2.1 Protected Resource Metadata (RFC 9728), public. Served at the
    // root well-known URL and at the path-suffixed form for the MCP endpoint.
    const mcpPath = () => this.config.mcp?.path ?? '/mcp';
    this.app.get([PROTECTED_RESOURCE_METADATA_PATH, `${PROTECTED_RESOURCE_METADATA_PATH}/*`], (req, res, next) => {
      const auth = this.config.auth;
      if (auth?.strategy !== 'oauth2' || !auth.oauth) return next();
      const suffix = req.path.slice(PROTECTED_RESOURCE_METADATA_PATH.length);
      if (suffix && suffix !== mcpPath()) return next();
      res.set('Cache-Control', 'public, max-age=300');
      res.json(protectedResourceMetadata(auth.oauth, req, mcpPath()));
    });

    // Downstream MCP endpoint (parses its own body so JSON errors become JSON-RPC errors).
    if (this.config.mcp?.enabled !== false) {
      const router = this.router;
      this.mcp = new McpEndpoint(this.config.mcp, {
        registry: this.registry,
        proxy: this.proxy,
        metrics: this.metrics,
        authenticate: router.authenticate,
        takeRateLimit: (req) => router.takeRateLimit(req),
        corsOrigins: () => this.config.corsOrigins,
        resolveClient: (clientId) => router.resolveClient(clientId),
        requestLog: () => this.config.monitor?.requestLog !== false,
        strictOrigins: () => this.config.security?.dnsRebindingProtection === true,
        maxBodyBytes: () => this.maxBodyBytes(),
        maxArgumentsBytes: () => this.config.security?.maxToolArgumentsBytes ?? 0,
        sessionStore: shared?.store,
      });
      this.app.use(this.mcp.router());
    }

    this.app.use((req, res, next) => this.jsonParser(req, res, next));

    // Live dashboard data: GET /api/v1/stats and the /api/v1/events SSE stream.
    this.live = createLiveRouter(this.metrics, this.registry, { authenticate: this.router.authenticate });
    this.app.use('/api/v1', this.live);
    this.app.use('/api/v1', this.router);

    const dashboard = this.config.dashboard?.enabled === false ? undefined : findDashboard();
    if (dashboard) {
      this.app.get('/dashboard', (_req, res, next) => {
        // Read per request (small file) so the CSP hash always matches the served script.
        readFile(dashboard, 'utf8').then((html) => {
          if (this.config.security?.headers !== false) res.setHeader('Content-Security-Policy', dashboardCsp(html));
          res.type('html').set('Cache-Control', 'no-cache').send(html);
        }, next);
      });
    }

    this.app.get('/', (_req, res) => {
      res.json({
        name: 'mcp-gateway',
        version: VERSION,
        docs: '/api/v1/health',
        mcp: this.mcp ? this.mcp.path : 'disabled',
        dashboard: dashboard
          ? '/dashboard'
          : this.config.dashboard?.enabled === false
            ? 'disabled'
            : 'not available (dashboard/index.html missing)',
      });
    });

    this.app.use(notFoundHandler);
    this.app.use(createErrorHandler(() => this.config.security?.exposeErrorDetails === true));

    this.metrics.start();
    if (this.config.audit?.enabled) {
      try {
        const store = new SqliteAuditStore(this.config.audit.path ?? 'mcp-gateway-audit.db');
        this.metrics.setAuditStore(store, this.config.audit.retentionDays ?? 30);
        logger.info(`Audit log: ${store.path}`);
      } catch (err) {
        await this.shutdownInternals();
        throw err;
      }
    }

    await this.connectServers(this.config.servers);

    this.registry.startHealthChecks((serverId) => this.checkHealth(serverId));

    // Reject on listen errors (EADDRINUSE, EACCES) instead of hanging forever
    // and crashing with an unhandled 'error' event.
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (err: Error) => {
        this.server.off('listening', onListening);
        rejectListen(err);
      };
      const onListening = () => {
        this.server.off('error', onError);
        const { port } = this.address() ?? { port: this.config.port };
        logger.info(`mcp-gateway v${VERSION} listening on http://${this.config.host}:${port}`);
        logger.info(`API: http://${this.config.host}:${port}/api/v1`);
        for (const w of securityWarnings(this.config)) {
          if (w.level === 'warn') logger.warn(`Security: ${w.message}`);
          else logger.info(`Security hint: ${w.message}`);
        }
        resolveListen();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.config.port, this.config.host);
    }).catch(async (err) => {
      await this.shutdownInternals();
      throw err;
    });

    this.server.on('error', (err) => logger.error(`HTTP server error: ${err.message}`));
  }

  /** Bound address (useful when listening on port 0). */
  address(): AddressInfo | undefined {
    const a = this.server.address();
    return a && typeof a === 'object' ? a : undefined;
  }

  /** Idempotent: concurrent/double calls (e.g. SIGINT twice) share one shutdown. */
  stop(): Promise<void> {
    this.stopping ??= this._stop();
    return this.stopping;
  }

  private async _stop(): Promise<void> {
    logger.info('Shutting down mcp-gateway...');
    const closed = this.server.listening
      ? new Promise<void>((res, rej) => this.server.close((err) => (err ? rej(err) : res())))
      : Promise.resolve();
    // Idle keep-alive sockets would otherwise hold close() open indefinitely.
    this.server.closeIdleConnections?.();
    await this.shutdownInternals();
    const force = setTimeout(() => this.server.closeAllConnections?.(), 5_000);
    force.unref();
    try {
      await closed;
    } finally {
      clearTimeout(force);
    }
    logger.info('Gateway stopped.');
  }

  /**
   * One health check: an MCP `ping` for connected servers (records latency,
   * marks `degraded` when it fails); disconnected servers are `reconnecting`
   * while the supervisor is on it, otherwise `offline`.
   */
  private async checkHealth(serverId: string): Promise<void> {
    if (this.proxy.isConnected(serverId)) {
      const timeout = Math.min(this.registry.getServer(serverId)?.timeout ?? 5_000, 5_000);
      try {
        const latency = await this.proxy.ping(serverId, timeout);
        if (this.proxy.isConnected(serverId)) this.registry.updateHealth(serverId, 'online', latency);
      } catch (err) {
        if (!this.proxy.isConnected(serverId)) return; // the disconnect handler owns the status now
        const msg = err instanceof Error ? err.message : String(err);
        this.registry.updateHealth(serverId, 'degraded', undefined, `health ping failed: ${msg}`);
      }
      return;
    }
    if (this.supervisor.isRecovering(serverId)) return;
    const prev = this.registry.getHealth(serverId);
    this.registry.updateHealth(serverId, 'offline', undefined, prev?.errorMessage);
  }

  private async shutdownInternals(): Promise<void> {
    this.mcp?.close();
    this.live?.close();
    this.supervisor.stop();
    this.registry.stopHealthChecks();
    this.metrics.stop();
    const audit = this.metrics.getAuditStore();
    if (audit) {
      this.metrics.setAuditStore(undefined);
      try {
        audit.close();
      } catch {
        /* already closed */
      }
    }
    this.router?.close();
    await this.proxy.disconnectAll();
    if (this.stateStore && !this.options.stateStore) await this.stateStore.close().catch(() => undefined);
  }

  /**
   * Apply a new configuration without restarting:
   *  - servers that were removed or disabled are disconnected, new or changed
   *    ones (re)connected;
   *  - auth (strategy, keys, secret, protect flags), rate limits, CORS origins,
   *    monitor.requestLog / monitor.prometheus, reconnect policy, logLevel and
   *    `security` (headers, trustProxy, ipAllowlist, allowedHosts,
   *    dnsRebindingProtection, body / argument limits, lockout, redaction)
   *    take effect immediately.
   * port, host, monitor.retentionHours, healthCheckIntervalMs and dashboard
   * still require a restart.
   */
  async reload(next: GatewayConfig): Promise<void> {
    await this.reloadLock.runExclusive(async () => {
      if (this.stopping) return;
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      const key = (s: McpServerConfig) => JSON.stringify(s);
      const current = new Map(this.config.servers.filter((s) => s.enabled !== false).map((s) => [s.id, s]));
      const wanted = new Map(next.servers.filter((s) => s.enabled !== false).map((s) => [s.id, s]));

      const toRemove = [...current.keys()].filter((id) => !wanted.has(id));
      const reconnectChanged = !same(this.config.reconnect, next.reconnect);
      const toConnect = [...wanted.values()].filter((s) => {
        const prev = current.get(s.id);
        return !prev || key(prev) !== key(s);
      });

      const applied: string[] = [];
      for (const field of ['port', 'host', 'healthCheckIntervalMs', 'dashboard', 'audit', 'state'] as const) {
        if (!same(this.config[field], next[field])) {
          logger.warn(`Config "${field}" changed — restart required for it to take effect`);
        }
      }
      if (this.config.monitor?.retentionHours !== next.monitor?.retentionHours) {
        logger.warn('Config "monitor.retentionHours" changed — restart required for it to take effect');
      }

      // Router-level settings (auth may be rejected and kept; the router logs that).
      this.router?.update(next);
      if (!same(this.config.auth, next.auth)) {
        applied.push('auth');
        this.mcp?.refreshClients();
      }
      if (!same(this.config.rateLimit, next.rateLimit)) applied.push('rateLimit');
      if (!same(this.config.monitor, next.monitor)) applied.push('monitor');
      if (!same(this.config.mcp, next.mcp)) {
        this.mcp?.update(next.mcp);
        applied.push('mcp');
      }
      if (!same(this.config.corsOrigins, next.corsOrigins)) {
        this.cors = corsMiddleware({ origins: next.corsOrigins ?? ['*'] });
        applied.push('corsOrigins');
      }
      if (!same(this.config.security, next.security)) {
        const sec = next.security;
        configureRedaction(sec?.redactPatterns);
        this.ipFilter = sec?.ipAllowlist ? ipAllowlistMiddleware(sec.ipAllowlist) : undefined;
        if ((sec?.maxBodyBytes ?? 0) !== (this.config.security?.maxBodyBytes ?? 0)) {
          this.jsonParser = express.json({ limit: sec?.maxBodyBytes ?? 10 * 1024 * 1024 });
        }
        applied.push('security');
      }
      if (reconnectChanged) {
        this.supervisor.setReconnectDefaults(next.reconnect);
        applied.push('reconnect');
      }
      if (next.logLevel && next.logLevel !== this.config.logLevel) {
        logger.setLevel(next.logLevel);
        applied.push('logLevel');
      }

      await Promise.all(
        toRemove.map(async (id) => {
          this.supervisor.forget(id);
          await this.proxy.disconnect(id);
          this.registry.unregister(id);
        }),
      );

      this.config = {
        ...this.config,
        servers: next.servers,
        logLevel: next.logLevel ?? this.config.logLevel,
        auth: next.auth,
        rateLimit: next.rateLimit,
        monitor: next.monitor ? { ...next.monitor, retentionHours: this.config.monitor?.retentionHours } : next.monitor,
        corsOrigins: next.corsOrigins,
        reconnect: next.reconnect,
        mcp: next.mcp,
        security: next.security,
      };
      if (applied.includes('security')) {
        try {
          this.applyTrustProxy();
        } catch (err) {
          logger.error(err instanceof Error ? err.message : String(err));
        }
      }
      await this.connectServers(toConnect);
      logger.info(
        `Hot reload applied: ${toConnect.length} (re)connected, ${toRemove.length} removed` +
          (applied.length ? `; updated ${applied.join(', ')}` : ''),
      );
    });
  }

  private async connectServers(servers: McpServerConfig[]): Promise<void> {
    const enabled = servers.filter((s) => s.enabled !== false);
    if (enabled.length === 0) return;
    logger.info(`Connecting to ${enabled.length} MCP server(s)...`);

    const outcomes = await Promise.all(
      enabled.map((serverConfig) => {
        this.registry.register(serverConfig);
        // Failed servers are retried in the background with backoff.
        return this.supervisor.connect(serverConfig);
      }),
    );

    const succeeded = outcomes.filter(Boolean).length;
    logger.info(`Connected: ${succeeded}/${enabled.length} servers (${enabled.length - succeeded} failed)`);
  }

  /** The downstream MCP endpoint (undefined when `mcp.enabled` is false or before start). */
  getMcpEndpoint(): McpEndpoint | undefined {
    return this.mcp;
  }

  /** Server registry (read-only use when embedding). */
  getRegistry(): ServerRegistry {
    return this.registry;
  }
}
