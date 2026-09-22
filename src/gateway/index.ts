/**
 * Gateway bootstrap — wires together all subsystems
 */

import express from 'express';
import { createServer } from 'http';
import type { GatewayConfig, McpServerConfig, ToolInfo } from '../utils/types.js';
import { ServerRegistry } from '../registry/index.js';
import { McpProxy } from '../proxy/index.js';
import { MetricsCollector } from '../monitor/index.js';
import { createApiRouter } from './api.js';
import { logger } from '../utils/logger.js';

export class Gateway {
  private readonly app = express();
  private readonly server = createServer(this.app);
  private readonly registry: ServerRegistry;
  private readonly proxy: McpProxy;
  private readonly metrics: MetricsCollector;

  constructor(private readonly config: GatewayConfig) {
    this.registry = new ServerRegistry();
    this.proxy = new McpProxy();
    this.metrics = new MetricsCollector(config.monitor);
  }

  async start(): Promise<void> {
    logger.setLevel(this.config.logLevel ?? 'info');

    // Middleware
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));

    // CORS
    const origins = this.config.corsOrigins ?? ['*'];
    this.app.use((_req, res, next) => {
      const origin = origins.includes('*') ? '*' : origins.join(', ');
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');
      if (_req.method === 'OPTIONS') { res.sendStatus(204); return; }
      next();
    });

    // API routes
    this.app.use('/api/v1', createApiRouter(this.config, this.registry, this.proxy, this.metrics));

    // Dashboard (static files if built)
    this.app.get('/', (_req, res) => {
      res.json({
        name: 'mcp-gateway',
        version: '0.1.0',
        docs: '/api/v1/health',
        dashboard: 'Run `pnpm dashboard:build` to enable the web dashboard',
      });
    });

    // Start HTTP server
    await new Promise<void>((resolve) => {
      this.server.listen(this.config.port, this.config.host, () => {
        logger.info(`mcp-gateway listening on http://${this.config.host}:${this.config.port}`);
        logger.info(`API: http://${this.config.host}:${this.config.port}/api/v1`);
        resolve();
      });
    });

    // Start metrics collection
    this.metrics.start();

    // Start health checks
    this.registry.startHealthChecks(async (serverId) => {
      const isConnected = this.proxy.isConnected(serverId);
      this.registry.updateHealth(serverId, isConnected ? 'online' : 'offline');
    });

    // Register and connect enabled servers without blocking HTTP availability
    void this.connectServers();
  }

  async stop(): Promise<void> {
    logger.info('Shutting down mcp-gateway...');
    this.registry.stopHealthChecks();
    this.metrics.stop();
    await this.proxy.disconnectAll();
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
    logger.info('Gateway stopped.');
  }

  private async connectServers(): Promise<void> {
    const enabled = this.config.servers.filter((s) => s.enabled !== false);
    logger.info(`Connecting to ${enabled.length} MCP server(s)...`);

    const results = await Promise.allSettled(
      enabled.map(async (serverConfig) => {
        this.registry.register(serverConfig);
        const tools = await this.connectServerWithRetry(serverConfig);
        this.registry.setTools(serverConfig.id, tools);
      })
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - succeeded;
    logger.info(`Connected: ${succeeded}/${enabled.length} servers (${failed} failed)`);
  }

  private async connectServerWithRetry(serverConfig: McpServerConfig): Promise<ToolInfo[]> {
    const attempts = 3;
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const tools = await this.proxy.connect(serverConfig);
        this.registry.updateHealth(serverConfig.id, 'online', undefined, undefined);
        logger.info(`✓ ${serverConfig.name} — ${tools.length} tools available`);
        return tools;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.registry.updateHealth(serverConfig.id, 'degraded', undefined, lastError);
        logger.warn(`✗ ${serverConfig.name} — connect attempt ${attempt}/${attempts} failed: ${lastError}`);
        if (attempt < attempts) {
          await new Promise<void>((resolve) => setTimeout(resolve, attempt * 500));
        }
      }
    }

    this.registry.updateHealth(serverConfig.id, 'offline', undefined, lastError);
    logger.warn(`✗ ${serverConfig.name} — marked offline after ${attempts} attempts`);
    return [];
  }
}
