/** 7.0: schema v7 only — `admin` / `dashboard` removed (now `controlPlane`), `migrate --to 7`. */
import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import { validateConfig } from '../src/config/loader.js';
import { migrateConfigText, migrateConfigObject } from '../src/config/migrate.js';
import { configDeprecations, removedConfigKeys } from '../src/utils/deprecations.js';
import { configEtag, distributedConfig } from '../src/gateway/control-plane.js';

const V6 = `# gateway
version: 6
admin:
  configApi: true   # allow PUT /admin/config
dashboard:
  enabled: false
servers: []
`;

describe('7.0: schema v7', () => {
  it('refuses schema v6 and the top-level admin / dashboard sections with the migration hint', () => {
    expect(() => validateConfig({ version: 6, servers: [] })).toThrow(/config schema v6 was removed in 7.0 — use `version: 11`; run `mcp-gateway migrate --to 11`/);
    expect(() => validateConfig({ servers: [], admin: { configApi: true } })).toThrow(/admin: removed in 7.0 — use `controlPlane.configApi`/);
    expect(() => validateConfig({ version: 11, servers: [], dashboard: { enabled: true } })).toThrow(/dashboard: removed in 7.0 — use `controlPlane.dashboard`/);
    expect(removedConfigKeys({ version: 6, admin: {}, dashboard: {} })).toHaveLength(3);
    expect(removedConfigKeys({ version: 11 })).toEqual([]);
    expect(configDeprecations({ version: 6, admin: {} })).toEqual([]);
  });

  it('controlPlane: role defaults to all; data planes need url + token; url/token only on data planes', () => {
    const v7 = validateConfig({ version: 11, servers: [], controlPlane: { configApi: true, dashboard: false } });
    expect(v7.controlPlane).toEqual({ role: 'all', configApi: true, dashboard: false, pullIntervalMs: 10000 });
    expect(v7.deprecations?.map((d) => d.id)).toBeUndefined(); // 11.0: nothing deprecated
    expect(validateConfig({ servers: [] }).controlPlane).toBeUndefined();
    const dp = validateConfig({ servers: [], controlPlane: { role: 'data', url: 'http://cp:4000', token: 't', pullIntervalMs: 2000, nodeId: 'dp-1' } });
    expect(dp.controlPlane).toMatchObject({ role: 'data', url: 'http://cp:4000', nodeId: 'dp-1', pullIntervalMs: 2000 });
    expect(() => validateConfig({ servers: [], controlPlane: { role: 'data' } })).toThrow(/controlPlane.url.*\n.*controlPlane.token/s);
    expect(() => validateConfig({ servers: [], controlPlane: { role: 'control', url: 'http://x' } })).toThrow(/data-plane setting/);
    expect(() => validateConfig({ servers: [], controlPlane: { role: 'edge' } })).toThrow();
    expect(() => validateConfig({ servers: [], controlPlane: { role: 'data', url: 'http://x', token: 't', pullIntervalMs: 10 } })).toThrow();
    expect(() => validateConfig({ servers: [], controlPlane: { extra: 1 } })).toThrow();
  });

  it('distributed config drops controlPlane / port / host; ETag is order independent', () => {
    const d = distributedConfig({ version: 11, port: 1, host: 'h', controlPlane: { role: 'control' }, servers: [], logLevel: 'info' });
    expect(d).toEqual({ version: 11, servers: [], logLevel: 'info' });
    expect(configEtag({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(configEtag({ b: [1, { d: 3, c: 2 }], a: 1 }));
    expect(configEtag({ a: 1 })).not.toBe(configEtag({ a: 2 }));
    expect(configEtag({ a: 1 })).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it('migrate --to 7 still upgrades 6.x files, keeping comments', () => {
    const r = migrateConfigText(V6, undefined, 7);
    expect(r.changes).toEqual(['version: 6 → 7', 'admin.configApi → controlPlane.configApi', 'dashboard.enabled → controlPlane.dashboard']);
    expect(r.text).toContain('# gateway');
    const cfg = parse(r.text);
    expect(cfg.controlPlane).toEqual({ configApi: true, dashboard: false });
    // 8.0 refuses the v7 output; the default migration (--to 8) produces a loadable file.
    expect(() => validateConfig(cfg)).toThrow(/schema v7 was removed in 8.0/);
    const v = validateConfig(parse(migrateConfigText(V6).text));
    expect(v.controlPlane?.configApi).toBe(true);
    expect(v.deprecations).toBeUndefined();
    expect(migrateConfigText(r.text, undefined, 7).changed).toBe(false);
    const old = migrateConfigObject({ version: 5, compliance: { pii: { action: 'redact' } }, dashboard: {}, servers: [] }, 7);
    expect(old.changes).toEqual(['version: 5 → 7', 'compliance.pii (action redact) → dlp', 'dashboard.enabled → controlPlane.dashboard']);
    expect(() => validateConfig(migrateConfigObject(old.config, 11).config)).not.toThrow(); // 11.0: dlp → features.dlp, version 11
    expect(migrateConfigObject({ admin: 1, servers: [] }).changes).toContain('admin (empty) removed');
    expect(migrateConfigText(JSON.stringify({ admin: { configApi: true, extra: 1 }, servers: [] }), 'json').notes.join()).toMatch(/admin: keys other than configApi/);
  });
});
