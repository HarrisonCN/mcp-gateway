/**
 * Gateway bootstrap — wires together all subsystems
 */

import express, { type Request } from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { GatewayConfig, McpServerConfig, RequestMetric } from '../utils/types.js';
import { ServerRegistry } from '../registry/index.js';
import { McpProxy } from '../proxy/index.js';
import { MetricsCollector } from '../monitor/index.js';
import { createApiRouter, serverStateSamples, type ApiRouter, type ToolCallResponse } from './api.js';
import { createOpenAIRouter } from '../bridges/openai.js';
import { createAdminRouter } from './admin.js';
import { createEdgeControlRouter } from './edge-control.js';
import { createFeatureRouter, featureSections } from './features.js';
import '../features/index.js';
import { deprecate } from '../utils/deprecations.js';
import { createA2ARouter } from '../bridges/a2a.js';
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
import { AuditExporter, type ExporterStats } from '../monitor/siem.js';
import { createStateStore, type StateStore } from '../state/index.js';
import { createTracer, NOOP_TRACER, type Tracer } from '../observability/tracing.js';
import { ToolInvoker } from './invoker.js';
import { LoadBalancer, expandReplicas } from './balancer.js';
import { SmartRouter } from './routing.js';
import { SecretManager } from '../secrets/index.js';
import { Federation } from './federation.js';
import { ComplianceEngine } from '../policy/compliance.js';
import { PortalStore } from '../portal/index.js';
import { ToolCache } from './cache.js';
import { ReplayRecorder } from './replay.js';
import { UsageMeter } from './usage.js';
import { membershipsOf } from '../auth/tenants.js';
import { Catalog, InstalledServers, buildServerConfig, type InstallRequest } from '../catalog/index.js';
import { ChainService } from '../orchestration/service.js';
import { MtlsManager, setUpstreamTls } from '../security/mtls.js';
import { CostLedger, costsRouter } from '../costs/index.js';
import { PluginHost, type PluginSource } from '../plugins/index.js';
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
  /** Plugins supplied in code (run before the ones from `config.plugins`). */
  plugins?: PluginSource[];
  /** Re-read the config from its source (enables `POST /api/v1/admin/reload`; set by the CLI). */
  reloadFromDisk?: () => Promise<GatewayConfig>;
}

export class Gateway {
  private readonly app = express();
  private readonly server: Server = createServer(this.app);
  private readonly registry: ServerRegistry;
  private readonly proxy: McpProxy;
  private readonly metrics: MetricsCollector;
  private auditExporter?: AuditExporter;
  private onMetric?: (m: RequestMetric) => void;
  private readonly supervisor: ServerSupervisor;
  private router?: ApiRouter;
  private mcp?: McpEndpoint;
  private live?: LiveRouter;
  private cors: express.RequestHandler;
  private ipFilter?: express.RequestHandler;
  private jsonParser: express.RequestHandler;
  /** 5.2: cleanups registered by feature modules. */
  private readonly featureStops: Array<() => void | Promise<void>> = [];
  private readonly reloadLock = new Mutex();
  /** Developer portal keys (3.8). */
  readonly portal: PortalStore;
  /** Peer gateways (3.6). */
  federation?: Federation;
  /** Secret providers, resolution and rotation (3.5). */
  readonly secrets: SecretManager;
  private started = false;
  private stopping?: Promise<void>;
  private stateStore?: StateStore;
  private tracer: Tracer = NOOP_TRACER;
  private invoker?: ToolInvoker;
  /** 4.5: upstream mTLS / SPIFFE identity. */
  readonly mtls = new MtlsManager(() => this.config.mtls, () => this.config.configDir ?? process.cwd());
  /** 4.3: cost accounting and budgets. */
  readonly costs = new CostLedger(() => this.config.costs);
  /** 4.2: tool chains. */
  readonly chains = new ChainService({
    config: () => this.config.chains,
    invoke: (serverId, name, params, clientId, via) =>
      this.invoker!.invoke({ serverId, name, kind: 'tool', method: 'tools/call', params, clientId, via, timeoutMs: this.registry.getServer(serverId)?.timeout }),
  });
  private readonly plugins = new PluginHost({
    resolveSecret: (ref, plugin) => this.secrets.get(ref, { user: `plugin:${plugin}` }),
    tenantOf: (clientId) => {
      const m = this.config.tenants?.length ? membershipsOf(this.config.tenants, clientId)[0] : undefined;
      return m ? { id: m.tenant, name: m.name, role: m.role } : undefined;
    },
  });
  private readonly catalog = new Catalog(() => this.config.catalog, () => this.config.configDir);
  private readonly installed = new InstalledServers(() => {
    const f = this.config.catalog?.serversFile;
    return f ? resolve(this.config.configDir ?? process.cwd(), f) : undefined;
  });

  constructor(
    private config: GatewayConfig,
    private readonly options: GatewayOptions = {},
  ) {
    this.registry = new ServerRegistry(config.health?.intervalMs ?? 30_000);
    this.proxy = new McpProxy();
    this.metrics = new MetricsCollector(config.monitor);
    this.portal = new PortalStore(() => this.config.portal, {
      baseDir: () => this.config.configDir,
      onChange: () => this.router?.update(this.withPortalKeys(this.config)),
    });
    this.secrets = new SecretManager(() => this.config.secrets, { baseDir: () => this.config.configDir });
    this.supervisor = new ServerSupervisor(this.proxy, this.registry, {
      reconnect: config.reconnect,
      prepare: (c) => (SecretManager.usesSecrets(c) ? this.secrets.resolveServer(c) : Promise.resolve(c)),
    });
    this.cors = corsMiddleware({ origins: config.cors?.origins ?? ['*'] });
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
    if (this.config.mtls) {
      this.mtls.start();
      setUpstreamTls(this.mtls);
    }

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

    try {
      await this.plugins.set(await PluginHost.build(this.config.plugins, this.options.plugins, this.config.configDir, this.config.pluginTrust));
    } catch (err) {
      this.started = false;
      if (!this.options.stateStore) await this.stateStore.close().catch(() => undefined);
      throw err;
    }
    if (this.plugins.size > 0) logger.info(`Plugins: ${this.plugins.list().map((p) => p.name).join(', ')}`);

    this.tracer = await createTracer(this.config.observability?.tracing);
    if (this.tracer.enabled) logger.info(`Tracing enabled (${this.config.observability?.tracing?.exporter ?? 'otlp-http'})`);
    this.invoker = new ToolInvoker({
      proxy: this.proxy,
      metrics: this.metrics,
      tracer: () => this.tracer,
      requestLog: () => this.config.monitor?.requestLog !== false,
      policy: () => this.config.policy,
      plugins: this.plugins,
      cache: new ToolCache(() => this.config.cache),
      recorder: new ReplayRecorder(() => this.config.replay),
      usage: new UsageMeter(() => this.config.quotas),
      costs: this.costs,
      tenantsOf: (clientId) => (this.config.tenants?.length ? membershipsOf(this.config.tenants, clientId).map((m) => m.tenant) : []),
      secrets: this.secrets,
      serverConfig: (id) => this.registry.getServer(id),
      compliance: new ComplianceEngine(() => this.config.compliance),
      federation: (this.federation = new Federation({
        config: () => this.config.federation,
        version: VERSION,
        localServers: () =>
          this.registry
            .getAllServers()
            .filter((s) => s.enabled !== false && !s.replicaOf)
            .map((s) => ({
              id: s.id,
              name: s.name,
              status: this.invoker?.balancer?.anyConnected(s.id) ?? this.proxy.isConnected(s.id) ? 'online' : (this.registry.getHealth(s.id)?.status ?? 'offline'),
              tools: this.registry.getTools(s.id).filter((t) => this.registry.isToolExposed(s.id, t.name)).map((t) => t.name),
            })),
      })),
      router: new SmartRouter(() => this.config.routing, { isConnected: (id) => this.proxy.isConnected(id) }),
      balancer: new LoadBalancer({
        servers: () => this.registry.getAllServers(),
        isConnected: (id) => this.proxy.isConnected(id),
        healthStatus: (id) => this.registry.getHealth(id)?.status,
      }),
    });

    // Builds auth/rate-limit; throws on insecure misconfiguration (fail closed)
    this.router = createApiRouter(this.withPortalKeys(this.config), this.registry, this.proxy, this.metrics, {
      portal: this.portal,
      supervisor: this.supervisor,
      isShuttingDown: () => this.stopping !== undefined,
      shared,
      invoker: this.invoker,
      onTenantsChanged: () => this.mcp?.refreshClients(),
      secrets: {
        providers: () => this.secrets.providerList(),
        status: () => this.secrets.status() as unknown as Array<Record<string, unknown>>,
        rotationSeconds: () => this.config.secrets?.rotation?.intervalSeconds,
        rotate: () => this.rotateSecrets(),
      },
      catalog: {
        installEnabled: () => this.catalog.installEnabled(),
        entries: () =>
          this.catalog.list().map((e) => ({
            ...e,
            installed: this.withInstalled(this.config.servers).filter((s) => s.tags?.includes(`catalog:${e.id}`)).map((s) => s.id),
          })),
        install: (id, req) => this.installFromCatalog(id, req),
        uninstall: (id) => this.uninstallCatalogServer(id),
        installedIds: () => this.installed.list().map((s) => s.id),
      },
    });

    this.app.disable('x-powered-by');
    this.applyTrustProxy();
    this.app.use(requestIdMiddleware);
    this.app.use(securityHeadersMiddleware(() => this.config.security));
    // Network guards first: nothing else (not even CORS preflights) runs for
    // a disallowed client address or Host header.
    this.app.use((req, res, next) => (this.ipFilter ? this.ipFilter(req, res, next) : next()));
    this.app.use(hostCheckMiddleware(() => this.allowedHosts()));
    // Plugin onRequest hooks: after the network guards, before CORS, auth and routes.
    const pluginMiddleware = this.plugins.middleware();
    this.app.use((req, res, next) => (this.plugins.size > 0 ? pluginMiddleware(req, res, next) : next()));
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
        corsOrigins: () => this.config.cors?.origins,
        resolveClient: (clientId) => router.resolveClient(clientId),
        requestLog: () => this.config.monitor?.requestLog !== false,
        strictOrigins: () => this.config.security?.dnsRebindingProtection === true,
        maxBodyBytes: () => this.maxBodyBytes(),
        maxArgumentsBytes: () => this.config.security?.maxToolArgumentsBytes ?? 0,
        sessionStore: shared?.store,
        invoker: this.invoker,
        chains: this.chains,
      });
      this.app.use(this.mcp.router());
    }

    this.app.use((req, res, next) => this.jsonParser(req, res, next));

    // Live dashboard data: GET /api/v1/stats and the /api/v1/events SSE stream.
    this.live = createLiveRouter(this.metrics, this.registry, { authenticate: this.router.authenticate });
    this.app.use('/api/v1', this.live);
    this.app.use(
      '/api/v1',
      createAdminRouter({
        config: () => this.config,
        apply: (next) => this.reload(next),
        reloadFromDisk: this.options.reloadFromDisk,
        authenticate: this.router.authenticate,
        isOperator: (req) => this.router!.isOperator(req),
      }),
    );
    const edgeControl = createEdgeControlRouter({
      config: () => this.config,
      tools: () => this.registry.getAllTools(),
      record: (m) => void this.metrics.record(m),
      authenticate: this.router.authenticate,
      isOperator: (req) => this.router!.isOperator(req),
    });
    this.app.use('/api/v1', edgeControl);
    // 5.1: feature modules under /api/v1/admin/<id> (src/features).
    this.app.use(
      '/api/v1',
      createFeatureRouter({
        authenticate: this.router.authenticate,
        isOperator: (req) => this.router!.isOperator(req),
        context: {
          config: () => this.config,
          tools: () => this.registry.getAllTools(),
          invoke: (serverId, name, args, clientId) =>
            this.invoker!.invoke({ serverId, name, kind: 'tool', method: 'tools/call', params: { name, arguments: args }, clientId: clientId ?? 'feature', via: 'rest', timeoutMs: this.registry.getServer(serverId)?.timeout }),
          recent: (limit) => this.metrics.getRecent(limit),
          onlineServers: () => this.registry.getAllServers().filter((s) => this.registry.getHealth(s.id)?.status === 'online').map((s) => s.id),
          onStop: (fn) => void this.featureStops.push(fn),
          edgeNodes: () => [...edgeControl.nodes.values()],
          baseUrl: () => {
            const a = this.address();
            if (!a) return undefined;
            const host = a.address === '::' || a.address === '0.0.0.0' ? '127.0.0.1' : a.address.includes(':') ? `[${a.address}]` : a.address;
            return `http://${host}:${a.port}`;
          },
        },
      }),
    );
    this.app.use('/api/v1', this.router);
    this.app.use('/api/v1', this.chains.router(this.router.authenticate));
    this.app.get('/api/v1/mtls', this.router.authenticate, (req, res) => {
      if (!this.router!.isOperator(req)) return void res.status(403).json({ error: 'Forbidden', message: 'Operator access required' });
      res.json({
        ...this.mtls.status(),
        servers: this.registry.getAllServers().map((s) => ({ id: s.id, mtls: this.mtls.applies(s), spiffeId: s.tls?.spiffeId ?? null })),
      });
    });
    this.app.use('/api/v1', costsRouter(this.costs, () => this.config.costs, this.router.authenticate, (req) => this.router!.isOperator(req)));

    // Bridges: OpenAI-compatible tools proxy and A2A agent card / JSON-RPC (after the JSON parser).
    const bridgeBase = {
      tools: () => this.registry.getAllTools(),
      naming: () => this.config.mcp?.toolNaming ?? 'auto',
      authenticate: this.router.authenticate,
      runToolCall: (req: Request, body: Record<string, unknown>, res: ToolCallResponse) => this.router!.runToolCall(req, body, res),
    } as const;
    this.app.use(this.config.openai?.path ?? '/openai/v1', createOpenAIRouter({ ...bridgeBase, config: () => this.config.openai }));
    this.app.use(
      createA2ARouter({
        ...bridgeBase,
        config: () => this.config.a2a,
        authRequired: () => (this.config.auth?.strategy ?? 'none') !== 'none',
      }),
    );

    // Conventional Prometheus scrape path (same data as GET /api/v1/metrics?format=prometheus).
    this.app.get('/metrics', (req, res, next) => {
      if (!this.config.monitor?.prometheus) return next();
      const send = () =>
        res
          .set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
          .send(this.metrics.toPrometheusText(serverStateSamples(this.registry, this.proxy)));
      if (this.config.auth?.protect?.metrics) return this.router!.authenticate(req, res, () => send());
      send();
    });

    const dashboard = this.config.dashboard?.enabled === false ? undefined : findDashboard();
    // 3.8: developer portal page (same CSP as the dashboard).
    const portalPage = dashboard ? resolve(dirname(dashboard), 'portal.html') : undefined;
    this.app.get('/portal', (_req, res, next) => {
      if (!this.config.portal?.enabled || !portalPage || !existsSync(portalPage)) return next();
      readFile(portalPage, 'utf8').then((html) => {
        if (this.config.security?.headers !== false) res.setHeader('Content-Security-Policy', dashboardCsp(html));
        res.type('html').set('Cache-Control', 'no-cache').send(html);
      }, next);
    });
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

    for (const d of this.config.deprecations ?? []) deprecate(d);

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

    if (this.config.audit?.export?.length) {
      const exporter = new AuditExporter(this.config.audit.export);
      if (exporter.size > 0) {
        this.auditExporter = exporter;
        this.onMetric = (m: RequestMetric) => exporter.push(m);
        this.metrics.on('metric', this.onMetric);
        logger.info(`Audit export: ${exporter.stats().map((s) => `${s.type} ${s.target}`).join(', ')}`);
      }
    }

    this.installed.load();
    await this.catalog.refresh();
    await this.connectServers(expandReplicas(this.withInstalled(this.config.servers)));
    this.startSecretRotation();
    this.federation?.start();

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
    for (const fn of this.featureStops.splice(0)) await Promise.resolve(fn()).catch(() => {});
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
    this.invoker?.approvals.close();
    await this.plugins.close();
    this.mcp?.close();
    this.live?.close();
    this.supervisor.stop();
    this.registry.stopHealthChecks();
    this.metrics.stop();
    if (this.onMetric) this.metrics.off('metric', this.onMetric);
    this.onMetric = undefined;
    await this.auditExporter?.close();
    this.auditExporter = undefined;
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
    this.secrets.stopRotation();
    this.mtls.stop();
    setUpstreamTls(undefined);
    this.federation?.stop();
    await this.proxy.disconnectAll();
    if (this.stateStore && !this.options.stateStore) await this.stateStore.close().catch(() => undefined);
    await this.tracer.shutdown().catch(() => undefined);
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
   * port, host, monitor.retentionHours, health and dashboard
   * still require a restart.
   */
  async reload(next: GatewayConfig): Promise<void> {
    await this.reloadLock.runExclusive(async () => {
      if (this.stopping) return;
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      const key = (s: McpServerConfig) => JSON.stringify(s);
      const current = new Map(expandReplicas(this.withInstalled(this.config.servers)).filter((s) => s.enabled !== false).map((s) => [s.id, s]));
      const wanted = new Map(expandReplicas(this.withInstalled(next.servers)).filter((s) => s.enabled !== false).map((s) => [s.id, s]));

      const toRemove = [...current.keys()].filter((id) => !wanted.has(id));
      const reconnectChanged = !same(this.config.reconnect, next.reconnect);
      const toConnect = [...wanted.values()].filter((s) => {
        const prev = current.get(s.id);
        return !prev || key(prev) !== key(s);
      });

      const applied: string[] = [];
      const prevPolicy = this.config.policy;
      const prevPlugins = this.config.plugins;
      const prevTrust = this.config.pluginTrust;
      const prevMtls = this.config.mtls;
      const prevCache = this.config.cache;
      const prevSecrets = this.config.secrets;
      const prevFederation = this.config.federation;
      const prevTenants = this.config.tenants;
      const prevCatalog = this.config.catalog;
      for (const field of ['port', 'host', 'health', 'dashboard', 'audit', 'state', 'observability'] as const) {
        if (!same(this.config[field], next[field])) {
          logger.warn(`Config "${field}" changed — restart required for it to take effect`);
        }
      }
      if (this.config.monitor?.retentionHours !== next.monitor?.retentionHours) {
        logger.warn('Config "monitor.retentionHours" changed — restart required for it to take effect');
      }

      // Router-level settings (auth may be rejected and kept; the router logs that).
      this.router?.update(this.withPortalKeys(next));
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
      if (!same(this.config.cors?.origins, next.cors?.origins)) {
        this.cors = corsMiddleware({ origins: next.cors?.origins ?? ['*'] });
        applied.push('cors');
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
        cors: next.cors,
        reconnect: next.reconnect,
        mcp: next.mcp,
        security: next.security,
        policy: next.policy,
        plugins: next.plugins,
        cache: next.cache,
        tenants: next.tenants,
        catalog: next.catalog,
        quotas: next.quotas,
        routing: next.routing,
        secrets: next.secrets,
        federation: next.federation,
        compliance: next.compliance,
        portal: next.portal,
        // openai.path is fixed at start; other bridge settings hot reload
        openai: next.openai ? { ...next.openai, path: this.config.openai?.path } : next.openai,
        a2a: next.a2a,
        ...featureSections(next),
        configDir: next.configDir ?? this.config.configDir,
      };
      if (!same(prevCatalog, next.catalog)) {
        await this.catalog.refresh();
        applied.push('catalog');
      }
      if (!same(prevTenants, next.tenants)) {
        this.mcp?.refreshClients();
        applied.push('tenants');
      }
      if (!same(prevFederation, next.federation)) {
        this.federation?.refreshPeers();
        this.federation?.start();
        applied.push('federation');
      }
      if (!same(prevMtls, next.mtls)) {
        this.mtls.stop();
        if (next.mtls) {
          this.mtls.start();
          setUpstreamTls(this.mtls);
        } else setUpstreamTls(undefined);
        applied.push('mtls');
      }
      if (!same(prevSecrets, next.secrets)) {
        this.secrets.configure();
        this.startSecretRotation();
        applied.push('secrets');
      }
      if (!same(prevCache, next.cache)) {
        this.invoker?.cache?.purge();
        applied.push('cache');
      }
      if (!same(prevPlugins, next.plugins) || !same(prevTrust, next.pluginTrust)) {
        try {
          await this.plugins.set(await PluginHost.build(next.plugins, this.options.plugins, this.config.configDir, next.pluginTrust));
          applied.push('plugins');
        } catch (err) {
          logger.error(`Plugins not reloaded (keeping the current ones): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (!same(prevPolicy, next.policy)) {
        this.invoker?.refreshPolicy();
        applied.push('policy');
      }
      if (applied.includes('security')) {
        try {
          this.applyTrustProxy();
        } catch (err) {
          logger.error(err instanceof Error ? err.message : String(err));
        }
      }
      await this.connectServers(toConnect);
      this.invoker?.balancer?.prune();
      logger.info(
        `Hot reload applied: ${toConnect.length} (re)connected, ${toRemove.length} removed` +
          (applied.length ? `; updated ${applied.join(', ')}` : ''),
      );
      await this.plugins.configChanged({ applied, servers: (next.servers ?? []).map((x) => x.id), at: new Date().toISOString() });
    });
  }

  /** `auth.apiKeys` plus the active developer-portal keys (3.8). */
  private withPortalKeys(cfg: GatewayConfig): GatewayConfig {
    if (!cfg.portal?.enabled || cfg.auth?.strategy !== 'api-key') return cfg;
    return { ...cfg, auth: { ...cfg.auth, apiKeys: [...(cfg.auth.apiKeys ?? []), ...this.portal.apiKeys()] } };
  }

  private startSecretRotation(): void {
    this.secrets.startRotation(
      () => this.registry.getAllServers(),
      async (next) => {
        const reg = this.registry.getServer(next.id);
        if (reg) await this.supervisor.connect(reg);
      },
    );
  }

  /** Re-resolve every secret now and reconnect servers whose credentials changed (3.5). */
  async rotateSecrets(): Promise<string[]> {
    return this.secrets.rotateAll(this.registry.getAllServers(), async (next) => {
      const reg = this.registry.getServer(next.id);
      if (reg) await this.supervisor.connect(reg);
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

  /** Configured servers plus the ones installed from the catalog (config wins on id clashes). */
  private withInstalled(servers: McpServerConfig[]): McpServerConfig[] {
    const ids = new Set(servers.map((s) => s.id));
    return [...servers, ...this.installed.list().filter((s) => !ids.has(s.id))];
  }

  /** Install a catalog entry as a new server and connect it. */
  async installFromCatalog(entryId: string, req: InstallRequest): Promise<{ status: number; body: Record<string, unknown> }> {
    if (!this.catalog.installEnabled()) return { status: 403, body: { error: 'Forbidden', message: 'Installing from the catalog is disabled (catalog.install: true enables it)' } };
    const entry = this.catalog.get(entryId);
    if (!entry) return { status: 404, body: { error: 'Not Found', message: `Catalog entry "${entryId}" not found` } };
    let server: McpServerConfig;
    try {
      server = buildServerConfig(entry, req);
    } catch (err) {
      return { status: 400, body: { error: 'Bad Request', message: err instanceof Error ? err.message : String(err) } };
    }
    server.tags = [...(server.tags ?? []), `catalog:${entry.id}`];
    return this.reloadLock.runExclusive(async () => {
      if (this.registry.getServer(server.id) || this.withInstalled(this.config.servers).some((s) => s.id === server.id)) {
        return { status: 409, body: { error: 'Conflict', message: `Server "${server.id}" already exists` } };
      }
      await this.installed.add(server);
      await this.connectServers([server]);
      logger.info(`Installed "${server.id}" from catalog entry "${entry.id}"`);
      return { status: 201, body: { server: server.id, entry: entry.id, connected: this.proxy.isConnected(server.id), persisted: !!this.config.catalog?.serversFile } };
    });
  }

  /** Remove a server that was installed from the catalog. */
  async uninstallCatalogServer(id: string): Promise<boolean> {
    return this.reloadLock.runExclusive(async () => {
      if (!this.installed.list().some((s) => s.id === id)) return false;
      await this.installed.remove(id);
      if (!this.config.servers.some((s) => s.id === id)) {
        this.supervisor.forget(id);
        await this.proxy.disconnect(id);
        this.registry.unregister(id);
      }
      return true;
    });
  }

  /** Active plugins (in hook order). */
  /** Per-target SIEM export counters (empty when `audit.export` is not configured). */
  auditExportStats(): ExporterStats[] {
    return this.auditExporter?.stats() ?? [];
  }

  /** Send queued audit export records now. */
  flushAuditExport(): Promise<void> {
    return this.auditExporter?.flush() ?? Promise.resolve();
  }

  getPlugins(): readonly string[] {
    return this.plugins.list().map((p) => p.name);
  }

  /** Server registry (read-only use when embedding). */
  getRegistry(): ServerRegistry {
    return this.registry;
  }
}
