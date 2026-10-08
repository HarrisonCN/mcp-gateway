/** 8.9: 9.0 preparation — schema v9 preview (`store` replaces `state`), deprecations, migrate --to 9. */
import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import { validateConfig, generateDefaultConfig } from '../src/config/loader.js';
import { migrateConfigText } from '../src/config/migrate.js';
import { configDeprecations, removedConfigKeys, normalizeStoreV9, DEPRECATIONS } from '../src/utils/deprecations.js';
import { portableConfig } from '../src/gateway/admin.js';
import { distributedConfig } from '../src/gateway/control-plane.js';

describe('9.0 preparation (8.9)', () => {
  it('deprecates schema v8 and `state`; schema v9 preview with `store`', () => {
    expect(Object.values(DEPRECATIONS).map((d) => `${d.id}@${d.removedIn}`)).toEqual(['schema-v8@9.0.0', 'state-block@9.0.0']);
    expect(configDeprecations({ version: 8, state: { store: 'memory' } }).map((d) => `${d.id}:${d.detail}`)).toEqual(['schema-v8:version: 8', 'state-block:state']);
    expect(configDeprecations({ state: {} }).map((d) => d.id)).toEqual(['state-block']);
    expect(configDeprecations({ version: 9, store: { backend: 'memory' } })).toEqual([]);
    const v9 = validateConfig({ version: 9, servers: [], store: { backend: 'redis', redis: { url: 'redis://r:6379' }, failureMode: 'closed' } });
    expect(v9.version).toBe(9);
    expect(v9.deprecations).toBeUndefined();
    expect(v9.state).toEqual({ store: 'redis', redis: { url: 'redis://r:6379' }, failureMode: 'closed' });
    expect(() => validateConfig({ version: 9, servers: [], state: { store: 'memory' } })).toThrow(/state: not part of config schema v9 — use `store: \{ backend, … \}`/);
    expect(() => validateConfig({ version: 9, servers: [], store: {}, state: {} })).toThrow(/cannot both be set/);
    expect(() => validateConfig({ version: 8, servers: [], store: {} })).toThrow(/`store` is part of config schema v9/);
    expect(() => validateConfig({ version: 9, servers: [], store: { backend: 'redis' } })).toThrow(/state.redis.url is required/);
    expect(validateConfig({ version: 8, servers: [], state: { store: 'memory' } }).deprecations?.map((d) => d.id)).toEqual(['schema-v8', 'state-block']);
    expect(removedConfigKeys({ version: 9 })).toEqual([]);
    expect(normalizeStoreV9({ a: 1 })).toEqual({ a: 1 });
    expect(parse(generateDefaultConfig()).version).toBe(9);
  });

  it('round trips: portableConfig writes `store` on v9, data planes keep the schema version', () => {
    const v9 = validateConfig({ version: 9, servers: [], store: { backend: 'memory', failureMode: 'open' } });
    const p = portableConfig(v9);
    expect(p.store).toEqual({ backend: 'memory', failureMode: 'open' });
    expect(p).not.toHaveProperty('state');
    expect(validateConfig(p).state).toEqual(v9.state);
    const v8 = portableConfig(validateConfig({ version: 8, servers: [], state: { store: 'memory' } }));
    expect(v8.state).toBeDefined();
    expect(distributedConfig({ version: 9, servers: [] }).version).toBe(9);
    expect(distributedConfig({ servers: [] }).version).toBe(8);
  });

  it('migrate --to 9 (default): version 9, state → store (store → backend), keeps comments', () => {
    const src = '# gw\nversion: 8\nstate:\n  store: redis # shared\n  redis: { url: "redis://r:6379" }\nservers: []\n';
    const r = migrateConfigText(src);
    expect(r.changes).toEqual(['version: 8 → 9', 'state → store (store → backend)']);
    expect(r.text).toContain('# gw');
    expect(r.text).toContain('backend: redis # shared');
    const cfg = validateConfig(parse(r.text));
    expect(cfg.state?.store).toBe('redis');
    expect(cfg.deprecations).toBeUndefined();
    expect(migrateConfigText(r.text).changed).toBe(false);
    expect(migrateConfigText('version: 8\nstate: {}\nstore: {}\n').notes.join()).toMatch(/both set/);
    expect(migrateConfigText('version: 6\nadmin: { configApi: true }\nservers: []\n').changes).toEqual(['version: 6 → 9', 'admin.configApi → controlPlane.configApi']);
  });
});
