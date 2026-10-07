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
  private debounceMs: number;
  private stopped = true;

  constructor(configPath: string, logger: Logger, debounceMs = 500) {
    super();
    this.configPath = path.resolve(configPath);
    this.logger = logger;
    this.debounceMs = debounceMs;
  }

  start(): void {
    if (this.watcher) return;
    this.stopped = false;
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Cannot watch ${this.configPath}: ${msg}`);
      this.watcher = null;
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

  private async _reload(): Promise<void> {
    try {
      const newConfig: GatewayConfig = await loadConfig(this.configPath);
      if (this.stopped) return;
      this.logger.info('Config file changed — applying hot reload');
      this.emit('reload', newConfig);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Config reload failed (keeping current config): ${msg}`);
      // Only emit when someone listens: an 'error'-like event without a
      // listener is fine for custom names, but keep it explicit.
      if (this.listenerCount('reload-error') > 0) this.emit('reload-error', err);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.watcher?.close();
    this.watcher = null;
    this.logger.debug('Config watcher stopped');
  }
}
