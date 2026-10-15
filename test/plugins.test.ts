import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Gateway } from '../src/gateway/index.js';
import { PluginHost, loadPlugin, grantSecrets, PLUGIN_API_VERSION, type GatewayPlugin } from '../src/plugins/index.js';
import { resetDeprecations, runtimeDeprecations } from '../src/utils/deprecations.js';
import { loadConfig, validateConfig } from '../src/config/loader.js';
import { ConfigWatcher } from '../src/config/watcher.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'mgw-plugins-'));
}

describe('PluginHost', () => {
  it('runs onToolCall in order: rewrite, deny, respond; onResponse chains', async () => {
    const seen: string[] = [];
    const host = new PluginHost();
    await host.set([
      // 17.0.0-alpha.1: plugin API v6 only — { action } outcomes (the v4-era shapes fail the hook, see v17-core K3)
      { name: 'a', onToolCall: (c) => (seen.push('a'), { action: 'rewrite', arguments: { ...c.arguments, a: 1 } }) },
      { name: 'b', onToolCall: (c) => (seen.push('b'), c.arguments.stop ? { action: 'deny', reason: 'stopped' } : undefined) },
      { name: 'c', onResponse: (_c, r) => ({ action: 'replace', result: { wrapped: r.result } }) },
      { name: 'd', onResponse: () => undefined },
    ]);
    const call = { serverId: 's', name: 't', kind: 'tool' as const, method: 'tools/call', arguments: {}, via: 'rest' as const, state: new Map() };
    expect(await host.beforeCall(call)).toBeUndefined();
    expect(call.arguments).toEqual({ a: 1 });
    expect(seen).toEqual(['a', 'b']);
    expect(await host.beforeCall({ ...call, arguments: { stop: true } })).toEqual({ deny: 'stopped', plugin: 'b' });
    expect((await host.afterCall(call, { success: true, durationMs: 1, result: 1 })).result).toEqual({ wrapped: 1 });
    await host.close();
    expect(host.size).toBe(0);
  });

  it('wraps hook errors, rejects bad plugins and newer API versions, closes dropped plugins', async () => {
    const host = new PluginHost();
    let closed = 0;
    const p: GatewayPlugin = { name: 'boom', onToolCall: () => { throw new Error('nope'); }, close: () => void closed++ };
    await host.set([p]);
    const call = { serverId: 's', name: 't', kind: 'tool' as const, method: 'tools/call', arguments: {}, via: 'mcp' as const, state: new Map() };
    await expect(host.beforeCall(call)).rejects.toThrow(/Plugin "boom" failed: nope/);
    await host.set([]);
    expect(closed).toBe(1);
    await expect(PluginHost.build(undefined, [{ name: 'x', apiVersion: 6 }, { name: 'x', apiVersion: 6 }])).rejects.toThrow(/Duplicate plugin name/);
    await expect(PluginHost.build(undefined, [(() => ({})) as never])).rejects.toThrow(/must export a plugin object/);
    await expect(PluginHost.build(undefined, [{ name: 'future', apiVersion: PLUGIN_API_VERSION + 1 }])).rejects.toThrow(/needs plugin API/);
  });

  it('hooks get a context, onError observes failures; v1 / v2 / v3 refused (6.0)', async () => {
    resetDeprecations();
    const seen: string[] = [];
    const host = new PluginHost();
    const plugins = await PluginHost.build(undefined, [
      { name: 'v3', apiVersion: 6, onToolCall: (_c, ctx) => void seen.push(`call:${ctx.plugin}:${ctx.apiVersion}`), onError: (_c, e, ctx) => void seen.push(`err:${ctx.plugin}:${e.message}`) },
      { name: 'broken-observer', apiVersion: 6, onError: () => { throw new Error('ignored'); } },
    ]);
    await host.set(plugins);
    expect(runtimeDeprecations()).toEqual([]); // 8.0
    await expect(PluginHost.build(undefined, [{ name: 'old', apiVersion: 3 }])).rejects.toThrow(/plugin API v3, which was removed in 6.0/);
    await expect(PluginHost.build(undefined, [{ name: 'legacy', onResponse: (_c, r) => r }])).rejects.toThrow(/plugin API v1, which was removed in 4.0/);
    const call = { serverId: 's', name: 't', kind: 'tool' as const, method: 'tools/call', arguments: {}, via: 'rest' as const, state: new Map() };
    await host.beforeCall(call);
    const failed = await host.afterCall(call, { success: false, durationMs: 1, error: { code: -32000, message: 'upstream down' } });
    expect(failed.success).toBe(false);
    await host.afterCall(call, { success: true, durationMs: 1, result: 1 });
    // 16.9.0: hooks see the contract the plugin declared; 17.0.0-alpha.1: that is always 6 (v5 is refused)
    expect(seen).toEqual(['call:v3:6', 'err:v3:upstream down']);
    await expect(PluginHost.build(undefined, [{ name: 'five', apiVersion: 5 }])).rejects.toThrow(/plugin API v5, which was removed in 17\.0/);
    const seen6: number[] = [];
    const host6 = new PluginHost();
    await host6.set(await PluginHost.build(undefined, [{ name: 'v6', apiVersion: 6, onToolCall: (_c, ctx) => void seen6.push(ctx.apiVersion) }]));
    await host6.beforeCall({ ...call, state: new Map() });
    expect(seen6).toEqual([PLUGIN_API_VERSION]);
    await host6.close();
    await expect(PluginHost.build(undefined, [{ name: 'old', apiVersion: 2 }])).rejects.toThrow(/plugin API v2, which was removed in 5.0/);
    await expect(PluginHost.build(undefined, [{ name: 'zero', apiVersion: 0 }])).rejects.toThrow(/unsupported plugin API v0/);
    await host.close();
  });

  it('API v3: ctx.secrets (granted names only), ctx.tenant and onConfigChange', async () => {
    const seen: string[] = [];
    const host = new PluginHost({
      resolveSecret: async (ref, plugin) => `${plugin}<-${ref}`,
      tenantOf: (clientId) => (clientId === 'key:a' ? { id: 'acme', name: 'Acme', role: 'admin' } : undefined),
    });
    const p: GatewayPlugin = grantSecrets(
      {
        name: 'v3',
        apiVersion: 6,
        onToolCall: async (_c, ctx) => {
          seen.push(`${ctx.tenant?.id ?? '-'}:${ctx.tenant?.role ?? '-'}:${await ctx.secrets!.get('TOKEN')}`);
          await expect(ctx.secrets!.get('OTHER')).rejects.toThrow(/not granted/);
          seen.push(ctx.secrets!.names().join(','));
        },
        onConfigChange: (ch, ctx) => void seen.push(`cfg:${ctx.plugin}:${ch.applied.join('+')}:${ch.servers.join('+')}`),
      },
      { TOKEN: 'secret://vault/kv/t#v' },
    );
    const v2: GatewayPlugin = { name: 'v2', apiVersion: 2, onToolCall: (_c, ctx) => void seen.push(`v2:${'secrets' in ctx}:${'tenant' in ctx}`), onConfigChange: () => void seen.push('v2cfg') };
    await host.set([p, v2]);
    const call = { serverId: 's', name: 't', kind: 'tool' as const, method: 'tools/call', arguments: {}, clientId: 'key:a', via: 'rest' as const, state: new Map() };
    await host.beforeCall(call);
    await host.beforeCall({ ...call, clientId: 'key:b' });
    await host.configChanged({ applied: ['policy'], servers: ['s'], at: new Date(0).toISOString() });
    expect(seen).toEqual([
      'acme:admin:v3<-secret://vault/kv/t#v', 'TOKEN', 'v2:false:false',
      '-:-:v3<-secret://vault/kv/t#v', 'TOKEN', 'v2:false:false',
      'cfg:v3:policy:s', 'v2cfg',
    ]);
    const fail = new PluginHost();
    await fail.set([{ name: 'bad', apiVersion: 6, onConfigChange: () => { throw new Error('x'); } }]);
    await expect(fail.configChanged({ applied: [], servers: [], at: '' })).resolves.toBeUndefined();
  });

  it('plugins[].secrets must be secret:// references', () => {
    expect(validateConfig({ plugins: [{ module: './p.mjs', secrets: { T: 'secret://env/T' } }] }).plugins![0]!.secrets).toEqual({ T: 'secret://env/T' });
    expect(() => validateConfig({ plugins: [{ module: './p.mjs', secrets: { T: 'plain' } }] })).toThrow(/secret:\/\/provider\/path/);
  });

  it('loads a module path relative to the config dir with options (factory export)', async () => {
    const dir = tmp();
    writeFileSync(
      join(dir, 'tagger.mjs'),
      'export default (ctx) => ({ name: "tagger", apiVersion: 6, onResponse: (_c, r) => ({ action: "replace", result: { tag: ctx.options.tag, v: ctx.apiVersion, r: r.result } }) });',
    );
    // 17.0.0-alpha.1: module plugins run in a worker (inline was removed); the proxy returns the plugin's outcome
    const p = await loadPlugin({ module: './tagger.mjs', runtime: 'worker', options: { tag: 'x' } }, dir);
    expect(p.name).toBe('tagger');
    const out = await p.onResponse!({ serverId: 's', name: 't', kind: 'tool', method: 'tools/call', arguments: {}, via: 'rest', state: new Map() } as never, { success: true, durationMs: 0, result: 5 }, {} as never);
    expect(out).toMatchObject({ result: { tag: 'x', v: PLUGIN_API_VERSION, r: 5 } });
    const renamed = await loadPlugin({ module: join(dir, 'tagger.mjs'), runtime: 'worker', name: 'renamed' }, '/');
    expect(renamed.name).toBe('renamed');
    await p.close?.();
    await renamed.close?.();
  });

  it('validates the plugins: config block and records configDir', async () => {
    const dir = tmp();
    const file = join(dir, 'gw.yml');
    writeFileSync(file, 'plugins:\n  - module: ./p.mjs\n    options: { a: 1 }\n');
    const cfg = await loadConfig(file);
    expect(cfg.plugins).toEqual([{ module: './p.mjs', options: { a: 1 } }]);
    expect(cfg.configDir).toBe(dir);
    writeFileSync(file, 'plugins:\n  - path: ./p.mjs\n');
    await expect(loadConfig(file)).rejects.toThrow(/plugins/);
  });
});

describe('plugins in the gateway', () => {
  let gw: Gateway | undefined;
  afterEach(async () => {
    await gw?.stop();
    gw = undefined;
  });

  async function start(extra: Partial<GatewayConfig>, plugins: GatewayPlugin[] = []) {
    gw = new Gateway(
      {
        port: 0,
        host: '127.0.0.1',
        logLevel: 'error',
        monitor: { requestLog: false },
        servers: [{ id: 'fake', name: 'fake', transport: 'stdio', command: process.execPath, args: [fixture], timeout: 5000 }],
        ...extra,
      },
      { plugins },
    );
    await gw.start();
    return `http://127.0.0.1:${gw.address()!.port}`;
  }
  const call = (url: string, args: Record<string, unknown>) =>
    fetch(`${url}/api/v1/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'echo', arguments: args }) });

  it('onRequest middleware, onToolCall before policy, onResponse after the output filter', async () => {
    const order: string[] = [];
    const url = await start(
      {
        policy: {
          rules: [{ name: 'no-root', effect: 'deny', tools: ['echo'], args: [{ path: 'path', equals: '/' }] }],
          outputFilter: { action: 'redact', builtins: false, patterns: ['SECRET'] },
        },
      },
      [
        {
          name: 'hdr',
          apiVersion: 6, // 17.0.0-alpha.1: programmatic (embedding API) plugins keep onRequest; module plugins cannot
          onRequest: (req, res, next) => {
            if (req.path === '/blocked') return void res.status(418).json({ teapot: true });
            res.setHeader('x-plugin', 'hdr');
            next();
          },
        },
        {
          name: 'rewrite',
          apiVersion: 6,
          onToolCall: (c) => {
            order.push(`call:${JSON.stringify(c.arguments)}`);
            if (c.arguments.path === '/safe-alias') return { action: 'rewrite', arguments: { ...c.arguments, path: '/' } };
            if (c.arguments.cached) return { action: 'respond', result: { content: [{ type: 'text', text: 'from plugin' }] } };
            if (c.arguments.reject) return { action: 'deny', reason: 'plugin says no' };
            return undefined;
          },
          onResponse: (_c, r) => {
            order.push(`resp:${JSON.stringify(r.result).includes('SECRET') ? 'raw' : 'filtered'}`);
            return { action: 'continue' };
          },
        },
      ],
    );
    expect(gw!.getPlugins()).toEqual(['hdr', 'rewrite']);

    const blocked = await fetch(`${url}/blocked`);
    expect(blocked.status).toBe(418);

    const ok = await call(url, { msg: 'SECRET' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-plugin')).toBe('hdr');
    expect(order.at(-1)).toBe('resp:filtered');

    // Rewritten arguments are what the policy sees.
    const denied = await call(url, { path: '/safe-alias' });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: -32003 });

    const rejected = await call(url, { reject: true });
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ code: -32006, message: 'plugin says no' });

    const cached = await call(url, { cached: true });
    expect(cached.status).toBe(200);
    expect(JSON.stringify(await cached.json())).toContain('from plugin');
  });

  it('a failing hook fails the call closed; plugins reload with the config', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'p.mjs'), 'export default (ctx) => ({ name: "cfg", apiVersion: 6, onToolCall: () => (ctx.options.deny ? { action: "deny", reason: "cfg deny" } : undefined) });');
    const url = await start({ configDir: dir, plugins: [{ module: './p.mjs', options: { deny: false } }] }, [
      { name: 'thrower', apiVersion: 6, onToolCall: (c) => { if (c.arguments.boom) throw new Error('kaput'); } },
    ]);
    const boom = await call(url, { boom: true });
    expect(boom.status).toBe(403);
    expect(await boom.json()).toMatchObject({ code: -32006 });
    expect((await call(url, {})).status).toBe(200);

    const base = { port: 0, host: '127.0.0.1', logLevel: 'error' as const, monitor: { requestLog: false }, servers: [{ id: 'fake', name: 'fake', transport: 'stdio' as const, command: process.execPath, args: [fixture], timeout: 5000 }] };
    await gw!.reload({ ...base, configDir: dir, plugins: [{ module: './p.mjs', options: { deny: true } }] });
    const denied = await call(url, {});
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ message: 'cfg deny' });
    // A broken plugin config keeps the current plugins — 13.2.0: and fails the whole reload (nothing else applied).
    await expect(gw!.reload({ ...base, logLevel: 'warn', configDir: dir, plugins: [{ module: './missing.mjs' }] })).rejects.toThrow(/plugins: .*missing\.mjs.*current plugins keep running/);
    expect(gw!.getPlugins()).toEqual(['thrower', 'cfg']);
    expect((await call(url, {})).status).toBe(403);
  });

  it('refuses to start with a plugin that cannot be loaded', async () => {
    await expect(start({ plugins: [{ module: './does-not-exist.mjs' }], configDir: tmp() })).rejects.toThrow();
    gw = undefined;
  });
});

describe('ConfigWatcher.reloadNow (SIGHUP)', () => {
  it('reloads without watching and stops after stop()', async () => {
    const dir = tmp();
    const file = join(dir, 'gw.yml');
    writeFileSync(file, 'port: 4100\n');
    const w = new ConfigWatcher(file, logger);
    const got: number[] = [];
    w.on('reload', (c: GatewayConfig) => got.push(c.port));
    await w.reloadNow();
    expect(got).toEqual([4100]);
    w.stop();
    await w.reloadNow();
    expect(got).toEqual([4100]);
  });
});
