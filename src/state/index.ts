/**
 * State store factory (`store` config block; internally `state`).
 *
 * @module state
 */

import type { StateConfig } from '../utils/types.js';
import { isAbsolute, resolve } from 'node:path';
import { MemoryStateStore, PrefixedStateStore, type StateStore } from './store.js';
import { RedisStateStore } from './redis.js';
import { EventLogStateStore } from './eventlog.js';
import { SqliteStateStore } from './sqlite.js';
import { GuardedStateStore } from './guard.js';

export { MemoryStateStore, PrefixedStateStore } from './store.js';
export type { StateStore } from './store.js';
export { RedisStateStore, RedisClient, RespParser, encodeCommand } from './redis.js';
export { EventLogStateStore } from './eventlog.js';
export { SqliteStateStore } from './sqlite.js';
export { GuardedStateStore, StoreUnavailableError, type StoreHealth, type BreakerState } from './guard.js';
export type { EventLogOptions, EventLogStats } from './eventlog.js';
export { createStoreRateLimiter, StoreAuthLockout } from './shared.js';

/** Build the configured store; `memory` when `store` is absent. `baseDir` resolves a relative `eventlog.dir`. */
export function createStateStore(config: StateConfig | undefined, baseDir: string = process.cwd()): StateStore {
  if (!config || (config.store ?? 'memory') === 'memory') return new MemoryStateStore();
  if (config.store === 'redis') {
    if (!config.redis?.url) throw new Error('store.backend is "redis" but store.redis.url is not set');
    const redis = new RedisStateStore({
      url: config.redis.url,
      connectTimeoutMs: config.redis.connectTimeoutMs,
      commandTimeoutMs: config.redis.commandTimeoutMs,
    });
    // 13.3.0: a stalled / unreachable store fails fast after one timeout (see state/guard)
    return new PrefixedStateStore(new GuardedStateStore(redis), config.redis.keyPrefix ?? 'mcp-gateway:');
  }
  if (config.store === 'eventlog') {
    const dir = config.eventlog?.dir ?? '.mcp-gateway/store';
    return new EventLogStateStore({ dir: isAbsolute(dir) ? dir : resolve(baseDir, dir), snapshotEvery: config.eventlog?.snapshotEvery, fsync: config.eventlog?.fsync });
  }
  if (config.store === 'sqlite') {
    const p = config.sqlite?.path ?? '.mcp-gateway/state.db';
    return new GuardedStateStore(new SqliteStateStore(p === ':memory:' || isAbsolute(p) ? p : resolve(baseDir, p), { busyTimeoutMs: config.sqlite?.busyTimeoutMs }));
  }
  throw new Error(`Unknown store.backend "${String(config.store)}"`);
}
