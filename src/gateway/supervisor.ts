/**
 * Server supervisor — keeps every enabled MCP server connected.
 *
 * - Connects servers and publishes their tools and health to the registry.
 * - When a server fails to connect, crashes or disconnects (`proxy` emits
 *   `disconnected`), it schedules a reconnect with exponential backoff and
 *   jitter, re-running the full MCP handshake on a fresh channel.
 * - Reconnect state (attempt, next attempt time, last error, reconnect count)
 *   is mirrored into the registry so `/servers`, `/health`, the dashboard and
 *   Prometheus can show it.
 *
 * Each server carries a generation number; a hot reload or removal bumps it so
 * an in-flight attempt that finishes late can never resurrect stale state.
 *
 * @module gateway/supervisor
 */

import type { McpServerConfig, ReconnectConfig, ReconnectState, ServerCatalog, ToolInfo } from '../utils/types.js';
import { SupersededError, type McpProxy, type PreparedSession } from '../proxy/index.js';
import { serverKey } from './generation.js';
import type { ServerRegistry } from '../registry/index.js';
import { logger } from '../utils/logger.js';

export const DEFAULT_RECONNECT: ReconnectConfig = {
  enabled: true,
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  multiplier: 2,
  jitter: 0.2,
  maxAttempts: 0,
};

export function resolveReconnect(
  gateway?: Partial<ReconnectConfig>,
  server?: Partial<ReconnectConfig>,
): ReconnectConfig {
  const strip = (o?: Partial<ReconnectConfig>) =>
    Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<ReconnectConfig>;
  const merged = { ...DEFAULT_RECONNECT, ...strip(gateway), ...strip(server) };
  merged.maxDelayMs = Math.max(merged.maxDelayMs, merged.initialDelayMs);
  return merged;
}

/**
 * Delay before reconnect attempt `attempt` (1-based):
 * `min(maxDelay, initialDelay * multiplier^(attempt-1))`, then ±jitter.
 */
export function computeBackoff(attempt: number, cfg: ReconnectConfig, random: () => number = Math.random): number {
  const exp = cfg.initialDelayMs * Math.pow(cfg.multiplier, Math.max(0, attempt - 1));
  const base = Math.min(cfg.maxDelayMs, exp);
  const spread = base * cfg.jitter;
  const jittered = base - spread + random() * 2 * spread;
  return Math.max(0, Math.round(Math.min(cfg.maxDelayMs, jittered)));
}

interface Entry {
  config: McpServerConfig;
  policy: ReconnectConfig;
  gen: number;
  timer?: NodeJS.Timeout;
  state: ReconnectState;
}

export interface SupervisorOptions {
  /** Gateway-wide reconnect defaults (merged with each server's `reconnect`). */
  reconnect?: Partial<ReconnectConfig>;
  random?: () => number;
  /** Turns the registered config into the one to connect with (3.5: resolves `secret://` references). */
  prepare?: (config: McpServerConfig) => Promise<McpServerConfig>;
}

export class ServerSupervisor {
  private readonly entries = new Map<string, Entry>();
  private readonly prepare?: (config: McpServerConfig) => Promise<McpServerConfig>;
  private reconnectDefaults?: Partial<ReconnectConfig>;
  private readonly random: () => number;
  private stopped = false;
  private readonly onDisconnected = (serverId: string, err: Error) => this.handleDisconnect(serverId, err);
  private readonly onToolsChanged = (serverId: string, tools: ToolInfo[]) => {
    if (!this.entries.has(serverId)) return;
    this.registry.setTools(serverId, tools);
    logger.info(`Server "${serverId}" updated its tool list (${tools.length} tools)`);
  };
  private readonly onCatalogChanged = (serverId: string, catalog: ServerCatalog) => {
    if (!this.entries.has(serverId)) return;
    this.registry.setCatalog(serverId, catalog);
    logger.info(
      `Server "${serverId}" updated its resources / prompts (${catalog.resources.length} resources, ${catalog.prompts.length} prompts)`,
    );
  };

  constructor(
    private readonly proxy: McpProxy,
    private readonly registry: ServerRegistry,
    options: SupervisorOptions = {},
  ) {
    this.reconnectDefaults = options.reconnect;
    this.random = options.random ?? Math.random;
    this.prepare = options.prepare;
    proxy.on('disconnected', this.onDisconnected);
    proxy.on('tools-changed', this.onToolsChanged);
    proxy.on('catalog-changed', this.onCatalogChanged);
  }

  /** Update gateway-wide reconnect defaults (hot reload). Applies to future attempts. */
  setReconnectDefaults(reconnect?: Partial<ReconnectConfig>): void {
    this.reconnectDefaults = reconnect;
    for (const e of this.entries.values()) e.policy = resolveReconnect(reconnect, e.config.reconnect);
  }

  /** Connect (or reconnect with a new config) now. Resolves true on success. */
  async connect(config: McpServerConfig): Promise<boolean> {
    if (this.stopped) return false;
    const prev = this.entries.get(config.id);
    if (prev?.timer) clearTimeout(prev.timer);
    const entry: Entry = {
      config,
      policy: resolveReconnect(this.reconnectDefaults, config.reconnect),
      gen: (prev?.gen ?? 0) + 1,
      state: { state: 'connecting', attempt: 0, reconnects: prev?.state.reconnects ?? 0 },
    };
    this.entries.set(config.id, entry);
    this.publish(entry);
    return this.attempt(entry, entry.gen, false);
  }

  /**
   * 13.2.0 hot reload Prepare: resolve `config`'s secrets and open a session for it aside (the current session keeps
   * serving). Throws when it cannot be opened.
   */
  async prepareSession(config: McpServerConfig): Promise<PreparedSession> {
    const resolved = this.prepare ? await this.prepare(config) : config;
    return this.proxy.prepare(resolved, { key: serverKey(config) });
  }

  /**
   * 13.2.0 hot reload Commit: manage `config` from now on with the session that was prepared and installed for it
   * (supersedes any pending or in-flight reconnect of the previous config) and publish its tools and health.
   */
  adopt(config: McpServerConfig, prepared: Pick<PreparedSession, 'tools' | 'catalog'>): void {
    const prev = this.entries.get(config.id);
    if (prev?.timer) clearTimeout(prev.timer);
    const entry: Entry = {
      config,
      policy: resolveReconnect(this.reconnectDefaults, config.reconnect),
      gen: (prev?.gen ?? 0) + 1,
      state: { state: 'idle', attempt: 0, reconnects: prev?.state.reconnects ?? 0 },
    };
    this.entries.set(config.id, entry);
    this.registry.setTools(config.id, prepared.tools);
    this.registry.setCatalog(config.id, prepared.catalog);
    this.registry.updateHealth(config.id, 'online', undefined, undefined, { connectedSince: new Date(), reconnect: { ...entry.state } });
  }

  /** Stop managing a server (cancel pending reconnects). Does not disconnect it. */
  forget(serverId: string): void {
    const e = this.entries.get(serverId);
    if (!e) return;
    if (e.timer) clearTimeout(e.timer);
    this.entries.delete(serverId);
  }

  /** Is a reconnect scheduled or in progress for this server? */
  isRecovering(serverId: string): boolean {
    const s = this.entries.get(serverId)?.state.state;
    return s === 'scheduled' || s === 'connecting';
  }

  getState(serverId: string): ReconnectState | undefined {
    const e = this.entries.get(serverId);
    return e ? { ...e.state } : undefined;
  }

  stop(): void {
    this.stopped = true;
    for (const e of this.entries.values()) if (e.timer) clearTimeout(e.timer);
    this.entries.clear();
    this.proxy.off('disconnected', this.onDisconnected);
    this.proxy.off('tools-changed', this.onToolsChanged);
    this.proxy.off('catalog-changed', this.onCatalogChanged);
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  private current(entry: Entry, gen: number): boolean {
    return !this.stopped && this.entries.get(entry.config.id) === entry && entry.gen === gen;
  }

  private async attempt(entry: Entry, gen: number, isReconnect: boolean): Promise<boolean> {
    const { config } = entry;
    entry.state.state = 'connecting';
    entry.state.nextAttemptAt = undefined;
    this.publish(entry);
    try {
      const resolved = this.prepare ? await this.prepare(config) : config;
      if (!this.current(entry, gen)) return false; // superseded by reload/removal
      // 13.2.0: the guard is re-checked under the proxy's connect lock, so a late reconnect of an old config can never
      // replace a session a hot reload installed meanwhile.
      const tools = await this.proxy.connect(resolved, { key: serverKey(config), guard: () => this.current(entry, gen) });
      if (!this.current(entry, gen)) return false; // superseded by reload/removal
      entry.state = {
        state: 'idle',
        attempt: 0,
        reconnects: entry.state.reconnects + (isReconnect ? 1 : 0),
        lastDisconnectAt: entry.state.lastDisconnectAt,
      };
      this.registry.setTools(config.id, tools);
      this.registry.setCatalog(config.id, this.proxy.getCatalog(config.id));
      this.registry.updateHealth(config.id, 'online', undefined, undefined, {
        connectedSince: new Date(),
        reconnect: { ...entry.state },
      });
      logger.info(`✓ ${config.name} — ${tools.length} tools available${isReconnect ? ' (reconnected)' : ''}`);
      return true;
    } catch (err) {
      if (err instanceof SupersededError || !this.current(entry, gen)) return false;
      const msg = err instanceof Error ? err.message : String(err);
      entry.state.lastError = msg;
      if (!isReconnect) {
        this.registry.setTools(config.id, []);
        this.registry.setCatalog(config.id, { resources: [], resourceTemplates: [], prompts: [] });
      }
      logger.warn(`✗ ${config.name} — failed to connect: ${msg}`);
      this.scheduleRetry(entry, gen);
      return false;
    }
  }

  private handleDisconnect(serverId: string, err: Error): void {
    const entry = this.entries.get(serverId);
    if (!entry || this.stopped) return;
    entry.state.lastError = err.message;
    entry.state.lastDisconnectAt = new Date();
    entry.state.attempt = 0;
    // Tools stay listed (marked unavailable via health) so clients see what will come back.
    logger.warn(`Server "${serverId}" disconnected: ${err.message}`);
    this.scheduleRetry(entry, entry.gen);
  }

  private scheduleRetry(entry: Entry, gen: number): void {
    const { policy } = entry;
    if (!policy.enabled) {
      entry.state.state = 'disabled';
      this.publish(entry, 'offline');
      return;
    }
    if (policy.maxAttempts > 0 && entry.state.attempt >= policy.maxAttempts) {
      entry.state.state = 'gave-up';
      logger.error(`Server "${entry.config.id}": giving up after ${entry.state.attempt} reconnect attempts`);
      this.publish(entry, 'offline');
      return;
    }
    entry.state.attempt++;
    const delay = computeBackoff(entry.state.attempt, policy, this.random);
    entry.state.state = 'scheduled';
    entry.state.nextAttemptAt = new Date(Date.now() + delay);
    logger.info(`Reconnecting "${entry.config.id}" in ${delay}ms (attempt ${entry.state.attempt})`);
    this.publish(entry, 'reconnecting');
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (this.current(entry, gen)) void this.attempt(entry, gen, true);
    }, delay);
    entry.timer.unref();
  }

  private publish(entry: Entry, status?: 'reconnecting' | 'offline'): void {
    const id = entry.config.id;
    if (!this.registry.getServer(id, { includeStaged: true })) return;
    const prev = this.registry.getHealth(id, { includeStaged: true });
    const next = status ?? prev?.status ?? 'unknown';
    this.registry.updateHealth(id, next, undefined, entry.state.lastError, {
      reconnect: { ...entry.state },
      connectedSince: status ? undefined : prev?.connectedSince,
    });
  }
}
