/** 6.9: 7.0 preparation — schema v7 preview (`controlPlane`), deprecations, `migrate --to 7`. */
import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import { validateConfig } from '../src/config/loader.js';
import { migrateConfigText, migrateConfigObject } from '../src/config/migrate.js';
import { configDeprecations, normalizeControlPlane, removedConfigKeys } from '../src/utils/deprecations.js';

const V6 = `# gateway
version: 6
admin:
  configApi: true   # allow PUT /admin/config
dashboard:
  enabled: false
servers: []
`;

describe('7.0 preparation (6.9)', () => {
  it('deprecates schema v6, admin and dashboard', () => {
    expect(configDeprecations({ version: 6, admin: { configApi: true }, dashboard: { enabled: false } }).map((d) => `${d.id}@${d.removedIn}:${d.detail}`)).toEqual([
      'schema-v6@7.0.0:version: 6',
      'admin-section@7.0.0:admin',
      'dashboard-section@7.0.0:dashboard',
    ]);
    expect(configDeprecations({ version: 7, controlPlane: { configApi: true } })).toEqual([]);
    expect(configDeprecations({})).toEqual([]);
  });

  it('schema v7 preview: controlPlane maps to the same runtime settings', () => {
    const v7 = validateConfig({ version: 7, servers: [], controlPlane: { configApi: true, dashboard: false } });
    expect(v7.version).toBe(7);
    expect(v7.admin?.configApi).toBe(true);
    expect(v7.dashboard?.enabled).toBe(false);
    expect(v7.deprecations).toBeUndefined();
    const v6 = validateConfig({ version: 6, servers: [], admin: { configApi: true }, dashboard: { enabled: false } });
    expect([v6.admin?.configApi, v6.dashboard?.enabled]).toEqual([true, false]);
    expect(() => validateConfig({ version: 7, servers: [], admin: { configApi: true } })).toThrow(/admin: not part of config schema v7 — use `controlPlane.configApi`/);
    expect(() => validateConfig({ version: 7, servers: [], dashboard: { enabled: true } })).toThrow(/dashboard: not part of config schema v7/);
    expect(() => validateConfig({ servers: [], admin: { configApi: true }, controlPlane: { configApi: false } })).toThrow(/not both/);
    expect(() => validateConfig({ version: 7, servers: [], controlPlane: { role: 'data' } })).toThrow();
    expect(removedConfigKeys({ version: 7 })).toEqual([]);
    expect(normalizeControlPlane({ controlPlane: { dashboard: true } })).toEqual({ dashboard: { enabled: true } });
    expect(normalizeControlPlane('x')).toBe('x');
  });

  it('migrate --to 7 (default) moves admin / dashboard under controlPlane, keeping comments', () => {
    const r = migrateConfigText(V6);
    expect(r.changes).toEqual(['version: 6 → 7', 'admin.configApi → controlPlane.configApi', 'dashboard.enabled → controlPlane.dashboard']);
    expect(r.text).toContain('# gateway');
    const cfg = parse(r.text);
    expect(cfg.controlPlane).toEqual({ configApi: true, dashboard: false });
    expect(cfg.admin).toBeUndefined();
    expect(cfg.dashboard).toBeUndefined();
    const v = validateConfig(cfg);
    expect(v.deprecations).toBeUndefined();
    expect(v.admin?.configApi).toBe(true);
    expect(migrateConfigText(r.text).changed).toBe(false);
    // v5 → v7 in one go (compliance.pii → dlp too)
    const old = migrateConfigObject({ version: 5, compliance: { pii: { action: 'redact' } }, dashboard: {}, servers: [] });
    expect(old.changes).toEqual(['version: 5 → 7', 'compliance.pii (action redact) → dlp', 'dashboard.enabled → controlPlane.dashboard']);
    expect(old.config.controlPlane).toBeUndefined();
    expect(migrateConfigObject({ admin: 1, servers: [] }).changes).toContain('admin (empty) removed');
    expect(migrateConfigText(JSON.stringify({ admin: { configApi: true, extra: 1 }, servers: [] }), 'json').notes.join()).toMatch(/admin: keys other than configApi/);
  });
});
