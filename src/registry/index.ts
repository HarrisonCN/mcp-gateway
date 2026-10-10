/**
 * MCP Server Registry
 * Manages the lifecycle of all registered MCP servers
 */

import { EventEmitter } from 'events';
import type {
  McpServerConfig,
  PromptInfo,
  ResourceInfo,
  ResourceTemplateInfo,
  ServerCatalog,
  ServerHealth,
  ServerStatus,
  ToolInfo,
} from '../utils/types.js';
import { logger } from '../utils/logger.js';
import { filterTools, isToolAllowed } from '../utils/tool-filter.js';

export class ServerRegistry extends EventEmitter {
  private servers = new Map<string, McpServerConfig>();
  private health = new Map<string, ServerHealth>();
  private tools = new Map<string, ToolInfo[]>(); // serverId -> tools
  private replicaTools = new Map<string, ToolInfo[]>(); // replica id -> tools (mapped to the primary)
  private catalogs = new Map<string, ServerCatalog>(); // serverId -> resources / prompts
  /**
   * 13.1.1: servers registered by a hot reload's Prepare phase. They connect and fill their tools / catalog, but every
   * query below hides them — not listed, not routable — until {@link commitStaged}; a failed reload unregisters them.
   */
  private staged = new Set<string>();
  private healthCheckInterval?: NodeJS.Timeout;

  constructor(private readonly healthCheckMs = 30_000) {
    super();
  }

  // ─── Registration ───────────────────────────────────────────────────────────

  register(config: McpServerConfig, opts: { staged?: boolean } = {}): void {
    if (this.servers.has(config.id)) {
      logger.warn(`Server "${config.id}" is already registered. Overwriting.`);
    }
    this.servers.set(config.id, config);
    if (opts.staged) {
      this.staged.add(config.id);
      this.health.set(config.id, { serverId: config.id, status: 'unknown', lastChecked: new Date() });
      logger.info(`Staged MCP server: ${config.id} (${config.name}) — hidden until the reload commits`);
      return;
    }
    this.staged.delete(config.id);
    this.health.set(config.id, {
      serverId: config.id,
      status: 'unknown',
      lastChecked: new Date(),
    });
    logger.info(`Registered MCP server: ${config.id} (${config.name})`);
    this.emit('registered', config);
  }

  unregister(serverId: string): boolean {
    if (!this.servers.has(serverId)) return false;
    const wasStaged = this.staged.delete(serverId);
    this.servers.delete(serverId);
    this.health.delete(serverId);
    this.tools.delete(serverId);
    this.replicaTools.delete(serverId);
    this.catalogs.delete(serverId);
    logger.info(`Unregistered MCP server: ${serverId}`);
    if (!wasStaged) this.emit('unregistered', serverId);
    return true;
  }

  /** Whether a server is staged by an uncommitted hot reload (13.1.1). */
  isStaged(serverId: string): boolean {
    return this.staged.has(serverId);
  }

  /**
   * Make staged servers visible (13.1.1: hot reload Commit). Emits `registered`, `tools-updated` and `catalog-updated`
   * for each, as if they had connected now.
   */
  commitStaged(ids: Iterable<string> = [...this.staged]): void {
    for (const id of ids) {
      if (!this.staged.delete(id)) continue;
      const config = this.servers.get(id);
      if (!config) continue;
      logger.info(`Registered MCP server: ${id} (${config.name})`);
      this.emit('registered', config);
      const tools = this.tools.get(id);
      if (tools) this.emit('tools-updated', id, tools);
      const primary = config.replicaOf;
      const mapped = this.replicaTools.get(id);
      if (primary && mapped?.length && (this.tools.get(primary)?.length ?? 0) === 0 && this.servers.has(primary)) {
        this.tools.set(primary, mapped);
        if (!this.staged.has(primary)) this.emit('tools-updated', primary, mapped);
      }
      const catalog = this.catalogs.get(id);
      if (catalog) this.emit('catalog-updated', id, catalog);
    }
  }

  /** Visible (committed) entries of a per-server map. */
  private visible<T>(m: Map<string, T>): T[] {
    if (!this.staged.size) return [...m.values()];
    return [...m.entries()].filter(([id]) => !this.staged.has(id)).map(([, v]) => v);
  }

  // ─── Queries ────────────────────────────────────────────────────────────────

  /** A committed server (`includeStaged`: also one staged by an uncommitted reload — supervisor / health only). */
  getServer(id: string, opts: { includeStaged?: boolean } = {}): McpServerConfig | undefined {
    if (!opts.includeStaged && this.staged.has(id)) return undefined;
    return this.servers.get(id);
  }

  getAllServers(): McpServerConfig[] {
    return this.visible(this.servers);
  }

  getEnabledServers(): McpServerConfig[] {
    return this.getAllServers().filter((s) => s.enabled !== false);
  }

  getServersByTag(tag: string): McpServerConfig[] {
    return this.getAllServers().filter((s) => s.tags?.includes(tag));
  }

  getHealth(serverId: string, opts: { includeStaged?: boolean } = {}): ServerHealth | undefined {
    if (!opts.includeStaged && this.staged.has(serverId)) return undefined;
    return this.health.get(serverId);
  }

  getAllHealth(): ServerHealth[] {
    return this.visible(this.health);
  }

  // ─── Tool Registry ──────────────────────────────────────────────────────────

  /**
   * Store a server's tool list, applying its `tools` allow/deny filter.
   * Only exposed tools are kept, so discovery, routing and counts never see
   * filtered ones.
   */
  setTools(serverId: string, all: ToolInfo[]): void {
    // Replicas serve the logical server's tools; they are never exposed on their own.
    // Their list stands in for the primary's while the primary has none (e.g. it is down at start).
    const primaryId = this.servers.get(serverId)?.replicaOf;
    if (primaryId) {
      const primary = this.servers.get(primaryId);
      if (!primary) return;
      const mapped = filterTools(all, primary.tools).map((t) => ({ ...t, serverId: primaryId, serverName: primary.name }));
      this.replicaTools.set(serverId, mapped);
      // 13.1.1: a staged replica stands in for its primary only after the reload commits.
      if (this.staged.has(serverId)) return;
      if ((this.tools.get(primaryId)?.length ?? 0) === 0 && mapped.length > 0) {
        this.tools.set(primaryId, mapped);
        if (!this.staged.has(primaryId)) this.emit('tools-updated', primaryId, mapped);
      }
      return;
    }
    if (all.length === 0) {
      const standIn = [...this.replicaTools.entries()].find(([id, t]) => this.servers.get(id)?.replicaOf === serverId && t.length > 0);
      if (standIn) {
        this.tools.set(serverId, standIn[1]);
        if (!this.staged.has(serverId)) this.emit('tools-updated', serverId, standIn[1]);
        return;
      }
    }
    const tools = filterTools(all, this.servers.get(serverId)?.tools);
    if (tools.length !== all.length) {
      logger.debug(`Server "${serverId}": ${all.length - tools.length} of ${all.length} tools hidden by its tools filter`);
    }
    for (const t of tools) {
      const owners = this.findTools(t.name).filter((o) => o.serverId !== serverId);
      if (owners.length > 0) {
        logger.warn(
          `Tool "${t.name}" is exposed by multiple servers (${[serverId, ...owners.map((o) => o.serverId)].join(', ')}); ` +
            'callers must pass "server" to disambiguate',
        );
      }
    }
    this.tools.set(serverId, tools);
    if (!this.staged.has(serverId)) this.emit('tools-updated', serverId, tools);
  }

  /** Whether the server's `tools` filter lets `toolName` through. */
  isToolExposed(serverId: string, toolName: string): boolean {
    if (this.staged.has(serverId)) return false;
    return isToolAllowed(toolName, this.servers.get(serverId)?.tools);
  }

  getTools(serverId: string): ToolInfo[] {
    if (this.staged.has(serverId)) return [];
    return this.tools.get(serverId) ?? [];
  }

  getAllTools(): ToolInfo[] {
    return this.visible(this.tools).flat();
  }

  /** Every server's entry for a tool name (more than one means the name is ambiguous). */
  findTools(toolName: string): ToolInfo[] {
    const found: ToolInfo[] = [];
    for (const tools of this.visible(this.tools)) {
      const t = tools.find((x) => x.name === toolName);
      if (t) found.push(t);
    }
    return found;
  }

  findTool(toolName: string): ToolInfo | undefined {
    for (const tools of this.visible(this.tools)) {
      const found = tools.find((t) => t.name === toolName);
      if (found) return found;
    }
    return undefined;
  }

  // ─── Resources & prompts ────────────────────────────────────────────────────

  /** Store a server's resources, resource templates and prompts. */
  setCatalog(serverId: string, catalog: ServerCatalog): void {
    if (!this.servers.has(serverId) || this.servers.get(serverId)?.replicaOf) return;
    this.catalogs.set(serverId, catalog);
    if (!this.staged.has(serverId)) this.emit('catalog-updated', serverId, catalog);
  }

  getCatalog(serverId: string): ServerCatalog {
    if (this.staged.has(serverId)) return { resources: [], resourceTemplates: [], prompts: [] };
    return this.catalogs.get(serverId) ?? { resources: [], resourceTemplates: [], prompts: [] };
  }

  getAllResources(): ResourceInfo[] {
    return this.visible(this.catalogs).flatMap((c) => c.resources);
  }

  getAllResourceTemplates(): ResourceTemplateInfo[] {
    return this.visible(this.catalogs).flatMap((c) => c.resourceTemplates);
  }

  getAllPrompts(): PromptInfo[] {
    return this.visible(this.catalogs).flatMap((c) => c.prompts);
  }

  // ─── Health Updates ─────────────────────────────────────────────────────────

  updateHealth(
    serverId: string,
    status: ServerStatus,
    latencyMs?: number,
    errorMessage?: string,
    extra: Pick<ServerHealth, 'connectedSince' | 'reconnect'> = {},
  ): void {
    if (!this.servers.has(serverId)) return; // never resurrect an unregistered server
    const prev = this.health.get(serverId);
    const updated: ServerHealth = {
      serverId,
      status,
      lastChecked: new Date(),
      latencyMs,
      errorMessage,
      toolCount: this.tools.get(serverId)?.length,
      connectedSince: 'connectedSince' in extra ? extra.connectedSince : prev?.connectedSince,
      reconnect: 'reconnect' in extra ? extra.reconnect : prev?.reconnect,
    };
    if (!updated.connectedSince) delete updated.connectedSince;
    if (!updated.reconnect) delete updated.reconnect;
    this.health.set(serverId, updated);

    if (prev?.status !== status) {
      logger.info(`Server "${serverId}" status changed: ${prev?.status ?? 'unknown'} → ${status}`);
      this.emit('health-changed', updated);
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  startHealthChecks(checkFn: (serverId: string) => Promise<void>): void {
    this.stopHealthChecks(); // never stack multiple intervals
    let running = false;
    this.healthCheckInterval = setInterval(() => {
      if (running) return; // skip a tick rather than overlap slow checks
      running = true;
      void Promise.allSettled(
        this.getEnabledServers().map((server) =>
          checkFn(server.id).catch((err: unknown) => {
            logger.debug(`Health check failed for ${server.id}: ${String(err)}`);
          }),
        ),
      ).finally(() => {
        running = false;
      });
    }, this.healthCheckMs);
    this.healthCheckInterval.unref();
  }

  stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }
  }

  // ─── Summary ────────────────────────────────────────────────────────────────

  getSummary(): {
    total: number;
    online: number;
    offline: number;
    degraded: number;
    reconnecting: number;
    unknown: number;
    totalTools: number;
  } {
    const allHealth = this.getAllHealth();
    return {
      total: allHealth.length,
      online: allHealth.filter((h) => h.status === 'online').length,
      offline: allHealth.filter((h) => h.status === 'offline').length,
      degraded: allHealth.filter((h) => h.status === 'degraded').length,
      reconnecting: allHealth.filter((h) => h.status === 'reconnecting').length,
      unknown: allHealth.filter((h) => h.status === 'unknown').length,
      totalTools: this.getAllTools().length,
    };
  }
}
