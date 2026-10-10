/**
 * Lazily loaded dependencies (13.3.0 cold start): packages only some configurations need are required on first use
 * instead of at import time, so a gateway that does not use them never pays for evaluating them.
 *
 *  - `jose` (≈130 KB, 80+ modules): JWT / OAuth / agent-identity verification;
 *  - `ws` (≈130 KB): WebSocket upstreams;
 *  - `yaml`: reading YAML config files (config/loader).
 *
 * All three ship CommonJS entry points, so `createRequire` loads them synchronously where the call sites need it.
 *
 * @module utils/lazy
 */
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const cache = new Map<string, unknown>();

function load<T>(id: string): T {
  let m = cache.get(id);
  if (m === undefined) cache.set(id, (m = req(id)));
  return m as T;
}

export const jose = (): typeof import('jose') => load<typeof import('jose')>('jose');
export const ws = (): typeof import('ws') => load<typeof import('ws')>('ws');
export const yaml = (): typeof import('yaml') => load<typeof import('yaml')>('yaml');
