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
import { corsMiddleware } from '../middleware/cors.js';
import { requestIdMiddleware } from '../middleware/request-id.js';
import { errorHandler, notFoundHandler } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';
import { Mutex } from '../utils/mutex.js';
import { VERSION } from '../utils/version.js';

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
  private router?: ApiRouter;
  private readonly reloadLock = new Mutex();
  private started = false;
  private stopping?: Promise<void>;

  constructor(private config: GatewayConfig) {
    this.registry = new ServerRegistry();
    this.proxy = new McpProxy();
    this.metrics = new MetricsCollector(config.monitor);
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('Gateway already started');
    this.started = true;
    logger.setLevel(this.config.logLevel ?? 'info');

    // Builds auth/rate-limit; throws on insecure misconfiguration (fail closed)
    this.router = createApiRouter(this.config, this.registry, this.proxy, this.metrics);

    this.app.disable('x-powered-by');
    this.app.use(requestIdMiddleware);
    // Previously an inline handler joined multiple origins into one
    // Access-Control-Allow-Origin value, which browsers reject.
    this.app.use(corsMiddleware({ origins: this.config.corsOrigins ?? ['*'] }));
    this.app.use(express.json({ limit: '10mb' }));

    this.app.use('/api/v1', this.router);

    const dashboard = findDashboard();
    if (dashboard) {
      this.app.get('/dashboard', (_req, res) => res.sendFile(dashboard));
    }

    this.app.get('/', (_req, res) => {
      res.json({
        name: 'mcp-gateway',
        version: VERSION,
        docs: '/api/v1/health',
        dashboard: dashboard ? '/dashboard' : 'not available (dashboard/index.html missing)',
      });
    });

    this.app.use(notFoundHandler);
    this.app.use(errorHandler);

    this.metrics.start();

    await this.connectServers(this.config.servers);

    this.registry.startHealthChecks(async (serverId) => {
      const isConnected = this.proxy.isConnected(serverId);
      this.registry.updateHealth(serverId, isConnected ? 'online' : 'offline');
    });

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

  private async shutdownInternals(): Promise<void> {
    this.registry.stopHealthChecks();
    this.metrics.stop();
    this.router?.close();
    await this.proxy.disconnectAll();
  }

  /**
   * Apply a new configuration's server list without restarting: servers that
   * were removed or disabled are disconnected, new or changed ones (re)connected.
   * Other settings (port, auth, rate limits, CORS) require a restart.
   */
  async reload(next: GatewayConfig): Promise<void> {
    await this.reloadLock.runExclusive(async () => {
      if (this.stopping) return;
      const key = (s: McpServerConfig) => JSON.stringify(s);
      const current = new Map(this.config.servers.filter((s) => s.enabled !== false).map((s) => [s.id, s]));
      const wanted = new Map(next.servers.filter((s) => s.enabled !== false).map((s) => [s.id, s]));

      const toRemove = [...current.keys()].filter((id) => !wanted.has(id));
      const toConnect = [...wanted.values()].filter((s) => {
        const prev = current.get(s.id);
        return !prev || key(prev) !== key(s);
      });

      for (const field of ['port', 'host', 'auth', 'rateLimit', 'corsOrigins', 'monitor'] as const) {
        if (JSON.stringify(this.config[field]) !== JSON.stringify(next[field])) {
          logger.warn(`Config "${field}" changed — restart required for it to take effect`);
        }
      }
      if (next.logLevel && next.logLevel !== this.config.logLevel) logger.setLevel(next.logLevel);

      await Promise.all(
        toRemove.map(async (id) => {
          await this.proxy.disconnect(id);
          this.registry.unregister(id);
        }),
      );

      this.config = { ...this.config, servers: next.servers, logLevel: next.logLevel ?? this.config.logLevel };
      await this.connectServers(toConnect);
      logger.info(`Hot reload applied: ${toConnect.length} (re)connected, ${toRemove.length} removed`);
    });
  }

  private async connectServers(servers: McpServerConfig[]): Promise<void> {
    const enabled = servers.filter((s) => s.enabled !== false);
    if (enabled.length === 0) return;
    logger.info(`Connecting to ${enabled.length} MCP server(s)...`);

    const outcomes = await Promise.all(
      enabled.map(async (serverConfig) => {
        this.registry.register(serverConfig);
        try {
          const tools = await this.proxy.connect(serverConfig);
          this.registry.setTools(serverConfig.id, tools);
          this.registry.updateHealth(serverConfig.id, 'online');
          logger.info(`✓ ${serverConfig.name} — ${tools.length} tools available`);
          return true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.registry.setTools(serverConfig.id, []);
          this.registry.updateHealth(serverConfig.id, 'offline', undefined, msg);
          logger.warn(`✗ ${serverConfig.name} — failed to connect: ${msg}`);
          return false;
        }
      }),
    );

    // Previously every server counted as "connected" because errors were
    // caught inside the settled promises.
    const succeeded = outcomes.filter(Boolean).length;
    logger.info(`Connected: ${succeeded}/${enabled.length} servers (${enabled.length - succeeded} failed)`);
  }
}
