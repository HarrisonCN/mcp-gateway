/**
 * Config File Watcher — Hot Reload Support
 *
 * Watches the active config file for changes and emits a 'reload' event
 * so the gateway can apply new server registrations without restarting.
 *
 * Many editors save atomically (write temp file + rename), which surfaces as a
 * 'rename' event and silently detaches an fs.watch handle from the path. The
 * watcher therefore treats 'rename' as a change and re-attaches itself.
 *
 * @module config/watcher
 */

import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import type { Logger } from '../utils/logger.js';
import { loadConfig } from './loader.js';
import type { GatewayConfig } from '../utils/types.js';

export class ConfigWatcher extends EventEmitter {
  private configPath: string;
  private logger: Logger;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  /** Retries attaching while the file is missing (mid atomic save, or deleted and recreated). */
  private retryTimer: NodeJS.Timeout | null = null;
  private attachFailures = 0;
  private debounceMs: number;
  private stopped = true;
  /** Set by stop(): no further reloads, not even reloadNow(). */
  private closed = false;

  constructor(configPath: string, logger: Logger, debounceMs = 500) {
    super();
    this.configPath = path.resolve(configPath);
    this.logger = logger;
    this.debounceMs = debounceMs;
  }

  start(): void {
    if (this.watcher) return;
    this.stopped = false;
    this.closed = false;
    this._attach();
    this.logger.info(`Config hot-reload enabled — watching ${this.configPath}`);
  }

  private _attach(): void {
    try {
      this.watcher = fs.watch(this.configPath, (eventType) => {
        if (eventType === 'rename') {
          // File was replaced; the old handle is now stale.
          this.watcher?.close();
          this.watcher = null;
        }
        this._schedule();
      });
      this.watcher.on('error', (err) => {
        this.logger.warn(`Config watcher error: ${err.message}`);
      });
      if (this.attachFailures > 0) {
        // The file came back after being missing: it was (re)written in the meantime.
        this.attachFailures = 0;
        this._schedule();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.attachFailures++ === 0) this.logger.warn(`Cannot watch ${this.configPath}: ${msg} (retrying)`);
      this.watcher = null;
      // Without a handle no further event arrives, so keep trying instead of silently ending hot reload.
      if (!this.stopped && !this.retryTimer) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          if (!this.stopped && !this.watcher) this._attach();
        }, Math.min(5_000, Math.max(100, this.debounceMs) * Math.min(this.attachFailures, 10)));
        this.retryTimer.unref?.();
      }
    }
  }

  private _schedule(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.stopped) return;
      if (!this.watcher) this._attach();
      void this._reload();
    }, this.debounceMs);
  }

  private async _reload(force = false): Promise<void> {
    try {
      const newConfig: GatewayConfig = await loadConfig(this.configPath);
      if (this.closed || (!force && this.stopped)) return;
      this.logger.info(force ? 'Reloading configuration' : 'Config file changed — applying hot reload');
      this.emit('reload', newConfig);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Config reload failed (keeping current config): ${msg}`);
      // Only emit when someone listens: an 'error'-like event without a
      // listener is fine for custom names, but keep it explicit.
      if (this.listenerCount('reload-error') > 0) this.emit('reload-error', err);
    }
  }

  /** Reload now (e.g. on SIGHUP), whether or not the file is being watched. */
  reloadNow(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    return this._reload(true);
  }

  stop(): void {
    this.stopped = true;
    this.closed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.watcher?.close();
    this.watcher = null;
    this.logger.debug('Config watcher stopped');
  }
}
