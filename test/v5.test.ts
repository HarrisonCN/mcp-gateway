/** 5.0: schema v5, removals, `migrate` (to v5), plugin API v4 (v2 refused, v3 deprecated). */
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

describe('schema v5 (5.0)', () => {
  it('reads version 5 (or none) with servers[].timeoutMs (internally timeout)', () => {
    const cfg = validateConfig({ version: 5, servers: [{ id: 'a', name: 'a', transport: 'stdio', command: 'x', timeoutMs: 1234 }] });
    expect(cfg.version).toBe(5);
    expect(cfg.servers[0]!.timeout).toBe(1234);
    expect(cfg.deprecations).toBeUndefined();
    expect(validateConfig({ servers: [{ id: 'b', name: 'b', transport: 'stdio', command: 'x' }] }).servers[0]!.timeout).toBe(30000);
  });

  it('refuses the v4 forms with the migration hint', () => {
    expect(() => validateConfig({ version: 4, servers: [] })).toThrow(/config schema v4 was removed in 5.0 — use `version: 5`; run `mcp-gateway migrate`/);
    expect(() => validateConfig({ servers: [{ id: 'a', transport: 'stdio', command: 'x', timeout: 5 }] })).toThrow(/servers.0.timeout: removed in 5.0 — use `timeoutMs`/);
    expect(removedConfigKeys({ version: 4, servers: [{ id: 'a', timeout: 1 }] })).toHaveLength(2);
    expect(() => validateConfig({ version: 6, servers: [] })).toThrow(/5.x reads `version: 5`/);
    expect(configDeprecations({ version: 5, servers: [] })).toEqual([]);
  });

  it('admin round trip uses schema v5 field names', () => {
    const cfg = validateConfig({ version: 5, servers: [{ id: 'a', name: 'a', transport: 'stdio', command: 'x', timeoutMs: 99 }] });
    const p = portableConfig(cfg) as { servers: Array<Record<string, unknown>> };
    expect(p.servers[0]).toMatchObject({ timeoutMs: 99 });
    expect(p.servers[0]).not.toHaveProperty('timeout');
    expect(validateConfig(p).servers[0]!.timeout).toBe(99);
  });

  it('removed normalizeV4Preview(); the only runtime deprecation left is plugin API v3', async () => {
    const mod = (await import('../src/utils/deprecations.js')) as Record<string, unknown>;
    expect(mod.normalizeV4Preview).toBeUndefined();
    expect(Object.values(DEPRECATIONS).map((d) => `${d.id}@${d.removedIn}`)).toEqual(['plugin-api-v3@6.0.0']);
  });
});

describe('mcp-gateway migrate --to 5', () => {
  it('rewrites v4 YAML to v5 in place, keeping comments; idempotent', () => {
    const r = migrateConfigText(V4);
    expect(r.changes).toEqual(['version: 4 → 5', 'servers[0] (search): timeout → timeoutMs']);
    expect(r.notes[0]).toMatch(/apiVersion: 4/);
    expect(r.text).toContain('# prod gateway');
    expect(r.text).toContain('timeoutMs: 15000 # slow upstream');
    expect(r.text.indexOf('timeoutMs')).toBeLessThan(r.text.indexOf('id: fs'));
    const cfg = validateConfig(parseYaml(r.text));
    expect(cfg.version).toBe(5);
    expect(cfg.servers[0]!.timeout).toBe(15000);
    expect(cfg.deprecations).toBeUndefined();
    expect(migrateConfigText(r.text).changed).toBe(false);
  });

  it('migrates v3 straight to v5 and JSON files', () => {
    const r = migrateConfigText(JSON.stringify({ version: 3, auth: { strategy: 'api-key', apiKeys: [{ key: 'k', servers: ['a'] }] }, servers: [{ id: 'a', name: 'a', transport: 'stdio', command: 'x', timeout: 3 }] }), 'json');
    expect(r.changes).toEqual(['version: 3 → 5', 'auth.apiKeys[0]: servers → scope', 'servers[0] (a): timeout → timeoutMs']);
    const out = JSON.parse(r.text);
    expect(out.servers[0]).toEqual({ id: 'a', name: 'a', transport: 'stdio', command: 'x', timeoutMs: 3 });
    expect(validateConfig(out).auth!.apiKeys![0]).toMatchObject({ servers: ['a'] });
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

  it('gives v4 plugins ctx.state (persisting across calls), not v3 ones', async () => {
    expect(PLUGIN_API_VERSION).toBe(4);
    const seen: Array<{ name: string; ctx: PluginHookContext }> = [];
    const counter = {
      name: 'counter',
      apiVersion: 4,
      onToolCall: (_c: unknown, ctx: PluginHookContext) => {
        const n = (ctx.state!.get<number>('calls') ?? 0) + 1;
        ctx.state!.set('calls', n);
        seen.push({ name: 'counter', ctx });
        return undefined;
      },
    };
    const old = { name: 'old', apiVersion: 3, onToolCall: (_c: unknown, ctx: PluginHookContext) => void seen.push({ name: 'old', ctx }) };
    const host = new PluginHost();
    await host.set(await PluginHost.build(undefined, [counter, old]));
    const call = { serverId: 's', name: 't', kind: 'tool' as const, method: 'tools/call', arguments: {} };
    await host.beforeCall({ ...call });
    await host.beforeCall({ ...call });
    const c = seen.filter((x) => x.name === 'counter');
    expect(c[1]!.ctx.state!.get('calls')).toBe(2);
    expect(c[1]!.ctx.apiVersion).toBe(4);
    expect(seen.find((x) => x.name === 'old')!.ctx.state).toBeUndefined();
  });

  it('refuses v2 and warns for v3', async () => {
    resetDeprecations();
    await expect(PluginHost.build(undefined, [{ name: 'v2', apiVersion: 2 }])).rejects.toThrow(/plugin API v2, which was removed in 5.0 — declare `apiVersion: 4`/);
    await PluginHost.build(undefined, [{ name: 'v3', apiVersion: 3 }, { name: 'v4', apiVersion: 4 }]);
    expect(runtimeDeprecations().map((d) => `${d.id}:${d.detail}`)).toEqual(['plugin-api-v3:plugin "v3"']);
  });
});
