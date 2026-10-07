/**
 * State store factory (`state` config block).
 *
 * @module state
 */

import type { StateConfig } from '../utils/types.js';
import { MemoryStateStore, PrefixedStateStore, type StateStore } from './store.js';
import { RedisStateStore } from './redis.js';

export { MemoryStateStore, PrefixedStateStore } from './store.js';
export type { StateStore } from './store.js';
export { RedisStateStore, RedisClient, RespParser, encodeCommand } from './redis.js';
export { createStoreRateLimiter, StoreAuthLockout } from './shared.js';

/** Build the configured store; `memory` when `state` is absent. */
export function createStateStore(config: StateConfig | undefined): StateStore {
  if (!config || (config.store ?? 'memory') === 'memory') return new MemoryStateStore();
  if (config.store === 'redis') {
    if (!config.redis?.url) throw new Error('state.store is "redis" but state.redis.url is not set');
    const redis = new RedisStateStore({
      url: config.redis.url,
      connectTimeoutMs: config.redis.connectTimeoutMs,
      commandTimeoutMs: config.redis.commandTimeoutMs,
    });
    return new PrefixedStateStore(redis, config.redis.keyPrefix ?? 'mcp-gateway:');
  }
  throw new Error(`Unknown state.store "${String(config.store)}"`);
}
