/** 5.0 → 6.0: schema v6 only, removals, `migrate`, plugin API v4 (v2 and v3 refused since 6.0). */
import { describe, it, expect, beforeEach } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { validateConfig } from '../src/config/loader.js';
import { migrateConfigText } from '../src/config/migrate.js';
import { configDeprecations, removedConfigKeys, runtimeDeprecations, resetDeprecations, DEPRECATIONS } from '../src/utils/deprecations.js';
import { PluginHost, createPluginState, PLUGIN_API_VERSION, type PluginHookContext } from '../src/plugins/index.js';
import { portableConfig } from '../src/gateway/admin.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');

const V4 = `# prod gateway
version: 4
servers:
  - id: search
    name: Search
    transport: streamable-http
    url: https://a.example/mcp
    timeout: 15000   # slow upstream
  - id: fs
    name: Files
    transport: stdio
    command: node
plugins:
  - module: ./audit.mjs
`;

describe('schema v8 (8.0)', () => {
  it('reads version 8 (or none) with servers[].timeoutMs (internally timeout)', () => {
    const cfg = validateConfig({ version: 9, servers: [{ id: 'a', name: 'a', transport: 'stdio', command: 'x', timeoutMs: 1234 }] });
    expect(cfg.version).toBe(9);
    expect(cfg.servers[0]!.timeout).toBe(1234);
    expect(cfg.deprecations).toBeUndefined();
    expect(validateConfig({ servers: [{ id: 'b', name: 'b', transport: 'stdio', command: 'x' }] }).servers[0]!.timeout).toBe(30000);
  });

  it('refuses the v4, v5, v6 and v7 forms with the migration hint', () => {
    expect(() => validateConfig({ version: 4, servers: [] })).toThrow(/config schema v4 was removed in 5.0 — use `version: 9`/);
    expect(() => validateConfig({ version: 5, servers: [] })).toThrow(/config schema v5 was removed in 6.0 — use `version: 9`/);
    expect(() => validateConfig({ version: 6, servers: [] })).toThrow(/config schema v6 was removed in 7.0 — use `version: 9`/);
    expect(() => validateConfig({ servers: [{ id: 'a', transport: 'stdio', command: 'x', timeout: 5 }] })).toThrow(/servers.0.timeout: removed in 5.0 — use `timeoutMs`/);
    expect(removedConfigKeys({ version: 4, servers: [{ id: 'a', timeout: 1 }] })).toHaveLength(2);
    expect(() => validateConfig({ version: 11, servers: [] })).toThrow(/9.9 reads `version: 9` or `version: 10`/);
    expect(() => validateConfig({ version: 7, servers: [] })).toThrow(/config schema v7 was removed in 8.0 — use `version: 9`/);
    expect(configDeprecations({ version: 7, servers: [] })).toEqual([]); // 8.0
  });

  it('admin round trip uses schema v8 field names', () => {
    const cfg = validateConfig({ version: 9, servers: [{ id: 'a', name: 'a', transport: 'stdio', command: 'x', timeoutMs: 99 }] });
    const p = portableConfig(cfg) as { servers: Array<Record<string, unknown>> };
    expect(p.servers[0]).toMatchObject({ timeoutMs: 99 });
    expect(p.servers[0]).not.toHaveProperty('timeout');
    expect(validateConfig(p).servers[0]!.timeout).toBe(99);
  });

  it('removed normalizeV4Preview() and normalizeControlPlane(); 8.9 deprecates schema v8 and state', async () => {
    const mod = (await import('../src/utils/deprecations.js')) as Record<string, unknown>;
    expect(mod.normalizeV4Preview).toBeUndefined();
    expect(mod.normalizeControlPlane).toBeUndefined();
    expect(Object.values(DEPRECATIONS)).toEqual([]); // 9.0
  });
});

describe('mcp-gateway migrate --to 5', () => {
  it('rewrites v4 YAML to v5 in place, keeping comments; idempotent', () => {
    const r = migrateConfigText(V4, undefined, 5);
    expect(r.changes).toEqual(['version: 4 → 5', 'servers[0] (search): timeout → timeoutMs']);
    expect(r.notes[0]).toMatch(/apiVersion: 4/);
    expect(r.text).toContain('# prod gateway');
    expect(r.text).toContain('timeoutMs: 15000 # slow upstream');
    expect(r.text.indexOf('timeoutMs')).toBeLessThan(r.text.indexOf('id: fs'));
    expect(() => validateConfig(parseYaml(r.text))).toThrow(/schema v5 was removed in 6.0/);
    expect(migrateConfigText(r.text, undefined, 5).changed).toBe(false);
    const v6 = validateConfig(parseYaml(migrateConfigText(V4).text));
    expect(v6.version).toBe(9);
    expect(v6.servers[0]!.timeout).toBe(15000);
  });

  it('migrates v3 straight to v5 and JSON files', () => {
    const r = migrateConfigText(JSON.stringify({ version: 3, auth: { strategy: 'api-key', apiKeys: [{ key: 'k', servers: ['a'] }] }, servers: [{ id: 'a', name: 'a', transport: 'stdio', command: 'x', timeout: 3 }] }), 'json', 5);
    expect(r.changes).toEqual(['version: 3 → 5', 'auth.apiKeys[0]: servers → scope', 'servers[0] (a): timeout → timeoutMs']);
    const out = JSON.parse(r.text);
    expect(out.servers[0]).toEqual({ id: 'a', name: 'a', transport: 'stdio', command: 'x', timeoutMs: 3 });
    expect(validateConfig({ ...out, version: 9 }).auth!.apiKeys![0]).toMatchObject({ servers: ['a'] });
  });
});

describe('plugin API v4 (5.0)', () => {
  let t = 0;
  beforeEach(() => {
    t = 1000;
  });

  it('PluginState: get / set / ttl / delete / size / eviction', () => {
    const s = createPluginState(() => t);
    s.set('a', 1);
    s.set('b', { n: 2 }, 50);
    expect(s.get('a')).toBe(1);
    expect(s.get<{ n: number }>('b')?.n).toBe(2);
    expect(s.size()).toBe(2);
    t += 60;
    expect(s.has('b')).toBe(false);
    expect(s.size()).toBe(1);
    expect(s.delete('a')).toBe(true);
    expect(s.get('a')).toBeUndefined();
    for (let i = 0; i < 10_005; i++) s.set(`k${i}`, i);
    expect(s.size()).toBe(10_000);
    expect(s.has('k0')).toBe(false);
    expect(s.has('k10004')).toBe(true);
    s.clear();
    expect(s.size()).toBe(0);
  });

  it('gives v5 plugins ctx.state (persisting across calls)', async () => {
    expect(PLUGIN_API_VERSION).toBe(5);
    const seen: Array<{ name: string; ctx: PluginHookContext }> = [];
    const counter = {
      name: 'counter',
      apiVersion: 5,
      onToolCall: (_c: unknown, ctx: PluginHookContext) => {
        const n = (ctx.state!.get<number>('calls') ?? 0) + 1;
        ctx.state!.set('calls', n);
        seen.push({ name: 'counter', ctx });
        return undefined;
      },
    };
    const host = new PluginHost();
    await host.set(await PluginHost.build(undefined, [counter]));
    const call = { serverId: 's', name: 't', kind: 'tool' as const, method: 'tools/call', arguments: {} };
    await host.beforeCall({ ...call });
    await host.beforeCall({ ...call });
    const c = seen.filter((x) => x.name === 'counter');
    expect(c[1]!.ctx.state!.get('calls')).toBe(2);
    expect(c[1]!.ctx.apiVersion).toBe(5);
  });

  it('refuses v2, (6.0) v3 and (8.0) v4', async () => {
    resetDeprecations();
    await expect(PluginHost.build(undefined, [{ name: 'v2', apiVersion: 2 }])).rejects.toThrow(/plugin API v2, which was removed in 5.0 — declare `apiVersion: 5`/);
    await expect(PluginHost.build(undefined, [{ name: 'v3', apiVersion: 3 }])).rejects.toThrow(/plugin API v3, which was removed in 6.0 — declare `apiVersion: 5`/);
    await expect(PluginHost.build(undefined, [{ name: 'v4', apiVersion: 4 }])).rejects.toThrow(/plugin API v4, which was removed in 8.0 — declare `apiVersion: 5`/);
    await PluginHost.build(undefined, [{ name: 'v5', apiVersion: 5 }]);
    expect(runtimeDeprecations()).toEqual([]); // 8.0
  });
});
