/**
 * Gateway bootstrap — wires together all subsystems
 */

import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { GatewayConfig, McpServerConfig } from '../utils/types.js';
import { ServerRegistry } from '../registry/index.js';
import { McpProxy } from '../proxy/index.js';
import { MetricsCollector } from '../monitor/index.js';
import { createApiRouter, type ApiRouter } from './api.js';
import { ServerSupervisor } from './supervisor.js';
import { corsMiddleware } from '../middleware/cors.js';
import { requestIdMiddleware } from '../middleware/request-id.js';
import { errorHandler, notFoundHandler } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';
import { Mutex } from '../utils/mutex.js';
import { VERSION } from '../utils/version.js';
import { McpEndpoint } from '../mcp/endpoint.js';

function findDashboard(): string | undefined {
  // src/gateway → ../../dashboard (tsx) and dist/gateway → ../../dashboard (built)
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(here, '../../dashboard/index.html');
  return existsSync(file) ? file : undefined;
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
  private cors: express.RequestHandler;
  private readonly reloadLock = new Mutex();
  private started = false;
  private stopping?: Promise<void>;

  constructor(private config: GatewayConfig) {
    this.registry = new ServerRegistry(config.healthCheckIntervalMs ?? 30_000);
    this.proxy = new McpProxy();
    this.metrics = new MetricsCollector(config.monitor);
    this.supervisor = new ServerSupervisor(this.proxy, this.registry, { reconnect: config.reconnect });
    this.cors = corsMiddleware({ origins: config.corsOrigins ?? ['*'] });
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('Gateway already started');
    this.started = true;
    logger.setLevel(this.config.logLevel ?? 'info');

    // Builds auth/rate-limit; throws on insecure misconfiguration (fail closed)
    this.router = createApiRouter(this.config, this.registry, this.proxy, this.metrics, {
      supervisor: this.supervisor,
      isShuttingDown: () => this.stopping !== undefined,
    });

    this.app.disable('x-powered-by');
    this.app.use(requestIdMiddleware);
    // Previously an inline handler joined multiple origins into one
    // Access-Control-Allow-Origin value, which browsers reject.
    // Indirection so CORS origins can be hot reloaded.
    this.app.use((req, res, next) => this.cors(req, res, next));

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
        requestLog: () => this.config.monitor?.requestLog !== false,
      });
      this.app.use(this.mcp.router());
    }

    this.app.use(express.json({ limit: '10mb' }));

    this.app.use('/api/v1', this.router);

    const dashboard = this.config.dashboard?.enabled === false ? undefined : findDashboard();
    if (dashboard) {
      this.app.get('/dashboard', (_req, res) => res.sendFile(dashboard));
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
    this.app.use(errorHandler);

    this.metrics.start();

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
    this.supervisor.stop();
    this.registry.stopHealthChecks();
    this.metrics.stop();
    this.router?.close();
    await this.proxy.disconnectAll();
  }

  /**
   * Apply a new configuration without restarting:
   *  - servers that were removed or disabled are disconnected, new or changed
   *    ones (re)connected;
   *  - auth (strategy, keys, secret, protect flags), rate limits, CORS origins,
   *    monitor.requestLog / monitor.prometheus, reconnect policy and logLevel
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
      for (const field of ['port', 'host', 'healthCheckIntervalMs', 'dashboard'] as const) {
        if (!same(this.config[field], next[field])) {
          logger.warn(`Config "${field}" changed — restart required for it to take effect`);
        }
      }
      if (this.config.monitor?.retentionHours !== next.monitor?.retentionHours) {
        logger.warn('Config "monitor.retentionHours" changed — restart required for it to take effect');
      }

      // Router-level settings (auth may be rejected and kept; the router logs that).
      this.router?.update(next);
      if (!same(this.config.auth, next.auth)) applied.push('auth');
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
      };
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
