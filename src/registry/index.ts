/**
 * MCP Server Registry
 * Manages the lifecycle of all registered MCP servers
 */

import { EventEmitter } from 'events';
import type {
  McpServerConfig,
  ServerHealth,
  ServerStatus,
  ToolInfo,
} from '../utils/types.js';
import { logger } from '../utils/logger.js';

export class ServerRegistry extends EventEmitter {
  private servers = new Map<string, McpServerConfig>();
  private health = new Map<string, ServerHealth>();
  private tools = new Map<string, ToolInfo[]>(); // serverId -> tools
  private healthCheckInterval?: NodeJS.Timeout;

  constructor(private readonly healthCheckMs = 30_000) {
    super();
  }

  // ─── Registration ───────────────────────────────────────────────────────────

  register(config: McpServerConfig): void {
    if (this.servers.has(config.id)) {
      logger.warn(`Server "${config.id}" is already registered. Overwriting.`);
    }
    this.servers.set(config.id, config);
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
    this.servers.delete(serverId);
    this.health.delete(serverId);
    this.tools.delete(serverId);
    logger.info(`Unregistered MCP server: ${serverId}`);
    this.emit('unregistered', serverId);
    return true;
  }

  // ─── Queries ────────────────────────────────────────────────────────────────

  getServer(id: string): McpServerConfig | undefined {
    return this.servers.get(id);
  }

  getAllServers(): McpServerConfig[] {
    return Array.from(this.servers.values());
  }

  getEnabledServers(): McpServerConfig[] {
    return this.getAllServers().filter((s) => s.enabled !== false);
  }

  getServersByTag(tag: string): McpServerConfig[] {
    return this.getAllServers().filter((s) => s.tags?.includes(tag));
  }

  getHealth(serverId: string): ServerHealth | undefined {
    return this.health.get(serverId);
  }

  getAllHealth(): ServerHealth[] {
    return Array.from(this.health.values());
  }

  // ─── Tool Registry ──────────────────────────────────────────────────────────

  setTools(serverId: string, tools: ToolInfo[]): void {
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
    this.emit('tools-updated', serverId, tools);
  }

  getTools(serverId: string): ToolInfo[] {
    return this.tools.get(serverId) ?? [];
  }

  getAllTools(): ToolInfo[] {
    return Array.from(this.tools.values()).flat();
  }

  /** Every server's entry for a tool name (more than one means the name is ambiguous). */
  findTools(toolName: string): ToolInfo[] {
    const found: ToolInfo[] = [];
    for (const tools of this.tools.values()) {
      const t = tools.find((x) => x.name === toolName);
      if (t) found.push(t);
    }
    return found;
  }

  findTool(toolName: string): ToolInfo | undefined {
    for (const tools of this.tools.values()) {
      const found = tools.find((t) => t.name === toolName);
      if (found) return found;
    }
    return undefined;
  }

  // ─── Health Updates ─────────────────────────────────────────────────────────

  updateHealth(
    serverId: string,
    status: ServerStatus,
    latencyMs?: number,
    errorMessage?: string
  ): void {
    const prev = this.health.get(serverId);
    const updated: ServerHealth = {
      serverId,
      status,
      lastChecked: new Date(),
      latencyMs,
      errorMessage,
      toolCount: this.tools.get(serverId)?.length,
    };
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
    unknown: number;
    totalTools: number;
  } {
    const allHealth = this.getAllHealth();
    return {
      total: allHealth.length,
      online: allHealth.filter((h) => h.status === 'online').length,
      offline: allHealth.filter((h) => h.status === 'offline').length,
      degraded: allHealth.filter((h) => h.status === 'degraded').length,
      unknown: allHealth.filter((h) => h.status === 'unknown').length,
      totalTools: this.getAllTools().length,
    };
  }
}
