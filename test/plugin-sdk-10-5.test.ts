// 10.5 kernel plugin SDK: configSchema validation, admin / client routes, hook time limits.
import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import { Gateway } from '../src/gateway/index.js';
import { PluginHost, definePlugin, loadPlugin, validatePluginOptions, PLUGIN_API_VERSION } from '../src/plugins/index.js';
import { validateConfig } from '../src/config/loader.js';
import { logger } from '../src/utils/logger.js';
import type { GatewayConfig } from '../src/utils/types.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));

describe('kernel plugin SDK (10.5)', () => {
  let gw: Gateway | undefined;
  afterEach(async () => {
    await gw?.stop();
    gw = undefined;
  });

  it('definePlugin sets the API version; configSchema accepts zod or a function', () => {
    const p = definePlugin({ name: 'p', configSchema: z.object({ n: z.number().int().default(3) }).strict() });
    expect(p.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(validatePluginOptions(p, {})).toEqual({ n: 3 });
    expect(() => validatePluginOptions(p, { n: 'x' })).toThrow(/Plugin "p" options are invalid: n:/);
    expect(() => validatePluginOptions(p, { extra: 1 })).toThrow(/invalid/);
    const f = definePlugin({ name: 'f', configSchema: (o: Record<string, unknown>) => (o.url ? [] : ['url is required']) });
    expect(() => validatePluginOptions(f, {})).toThrow(/url is required/);
    expect(validatePluginOptions(f, { url: 'x' })).toEqual({ url: 'x' });
  });

  it('a module plugin with invalid options is refused at load', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgw-sdk-'));
    writeFileSync(join(dir, 'p.mjs'), `export default { name: 'm', apiVersion: 5, configSchema: (o) => (typeof o.limit === 'number' ? [] : ['limit must be a number']) };`);
    await expect(loadPlugin({ module: './p.mjs', options: {} }, dir)).rejects.toThrow(/limit must be a number/);
    const ok = await loadPlugin({ module: './p.mjs', options: { limit: 2 } }, dir);
    expect(ok.name).toBe('m');
  });

  it('timeoutMs fails a slow hook closed; config validation accepts it for modules only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgw-sdk-'));
    writeFileSync(join(dir, 'slow.mjs'), `export default { name: 'slow', apiVersion: 5, onToolCall: () => new Promise((r) => setTimeout(r, 500)) };`);
    const p = await loadPlugin({ module: './slow.mjs', timeoutMs: 50 }, dir);
    const host = new PluginHost();
    await host.set([p]);
    const call = { serverId: 's', name: 't', kind: 'tool' as const, method: 'tools/call', arguments: {}, via: 'rest' as const, state: new Map() };
    const t0 = Date.now();
    await expect(host.beforeCall(call)).rejects.toThrow(/onToolCall timed out after 50 ms/);
    expect(Date.now() - t0).toBeLessThan(400);
    await host.close();
    const base = { version: 10, servers: [] } as Record<string, unknown>;
    expect(() => validateConfig({ ...base, plugins: [{ module: './x.mjs', timeoutMs: 100 }] })).not.toThrow();
    expect(() => validateConfig({ ...base, plugins: [{ component: './x.wasm', timeoutMs: 100 }] })).toThrow(/timeoutMs/);
  });

  it('mounts admin routes for operators and client routes for any authenticated client', async () => {
    const notes: string[] = [];
    const plugin = definePlugin({
      name: 'notes',
      configSchema: z.object({ max: z.number().int().positive().default(2) }),
      routes: {
        admin: (r, ctx) => {
          r.get('/', (_req, res) => void res.json({ plugin: ctx.plugin, options: ctx.options, notes, tools: ctx.tools().map((t) => t.name) }));
          r.post('/call', async (req, res) => {
            const out = await ctx.invoke('fake', 'echo', req.body ?? {}, ctx.clientOf(req));
            res.json({ success: out.success });
          });
        },
        client: (r, ctx) => {
          r.post('/', (req, res) => {
            if (notes.length >= (ctx.options.max as number)) return void res.status(429).json({ error: 'full' });
            notes.push(`${ctx.clientOf(req)}:${String((req.body as { text?: string }).text)}`);
            res.status(201).json({ count: notes.length });
          });
        },
      },
    });
    const cfg: GatewayConfig = {
      port: 0,
      host: '127.0.0.1',
      logLevel: 'error',
      monitor: { requestLog: false },
      auth: { strategy: 'api-key', apiKeys: [{ key: 'op-key', name: 'op' }, { key: 'user-key', name: 'user', servers: ['fake'] }] },
      servers: [{ id: 'fake', name: 'fake', transport: 'stdio', command: process.execPath, args: [fixture], timeout: 5000 }],
    } as GatewayConfig;
    gw = new Gateway(cfg, { plugins: [plugin] });
    await gw.start();
    const url = `http://127.0.0.1:${gw.address()!.port}/api/v1`;
    const h = (k: string) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json' });

    const a = await fetch(`${url}/admin/plugins/notes`, { headers: h('op-key') });
    expect(a.status).toBe(200);
    const body = (await a.json()) as { plugin: string; options: { max: number }; tools: string[] };
    expect(body).toMatchObject({ plugin: 'notes', options: { max: 2 } });
    expect(body.tools).toContain('echo');
    expect((await fetch(`${url}/admin/plugins/notes`, { headers: h('user-key') })).status).toBe(403);
    expect((await fetch(`${url}/admin/plugins/notes`)).status).toBe(401);
    expect((await fetch(`${url}/admin/plugins/nope`, { headers: h('op-key') })).status).toBe(404);
    expect((await fetch(`${url}/admin/plugins/notes/missing`, { headers: h('op-key') })).status).toBe(404);
    const call = await fetch(`${url}/admin/plugins/notes/call`, { method: 'POST', headers: h('op-key'), body: JSON.stringify({ msg: 'hi' }) });
    expect(await call.json()).toEqual({ success: true });

    for (const expected of [201, 201, 429]) {
      const r = await fetch(`${url}/features/plugins/notes`, { method: 'POST', headers: h('user-key'), body: JSON.stringify({ text: 'n' }) });
      expect(r.status).toBe(expected);
    }
    expect(notes).toEqual(['key:user:n', 'key:user:n']);
    expect((await fetch(`${url}/features/plugins/notes`, { method: 'POST', body: '{}' })).status).toBe(401);
  });
});
