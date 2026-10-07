import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { writeFileSync, mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Gateway } from '../src/gateway/index.js';
import { BUILTIN_CATALOG, Catalog, buildServerConfig, loadCatalogSource, InstalledServers } from '../src/catalog/index.js';
import { loadConfig } from '../src/config/loader.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'mgw-cat-'));

describe('catalog', () => {
  it('builds server configs from entries (args, env, ${VAR} substitution)', () => {
    const fs = BUILTIN_CATALOG.find((e) => e.id === 'filesystem')!;
    const cfg = buildServerConfig(fs, { args: ['/srv'] });
    expect(cfg).toMatchObject({ id: 'filesystem', name: 'Filesystem', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/srv'] });
    expect(cfg.tags).toContain('catalog');
    expect(buildServerConfig(fs, {}).args!.at(-1)).toBe('/data'); // default
    const gh = BUILTIN_CATALOG.find((e) => e.id === 'github')!;
    expect(() => buildServerConfig(gh, {})).toThrow(/GITHUB_TOKEN is required/);
    expect(buildServerConfig(gh, { serverId: 'gh', env: { GITHUB_TOKEN: 't0k' } }).headers).toEqual({ Authorization: 'Bearer t0k' });
    expect(() => buildServerConfig(gh, { serverId: 'bad id', env: { GITHUB_TOKEN: 'x' } })).toThrow(/serverId/);
    const git = BUILTIN_CATALOG.find((e) => e.id === 'git')!;
    expect(() => buildServerConfig(git, {})).toThrow(/args\[0\]/);
    const mem = BUILTIN_CATALOG.find((e) => e.id === 'memory')!;
    expect(buildServerConfig(mem, { env: { A: '1' } }).env).toEqual({ A: '1' });
  });

  it('merges sources (file + URL), skips invalid entries and failing sources', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'cat.json'), JSON.stringify({ entries: [{ id: 'memory', name: 'My memory', template: { transport: 'stdio', command: 'm' } }, { id: 'x' }] }));
    writeFileSync(join(dir, 'arr.json'), JSON.stringify([{ id: 'extra', name: 'Extra', description: 'd', template: { transport: 'sse', url: 'http://x' } }]));
    expect(await loadCatalogSource('arr.json', dir)).toHaveLength(1);
    const fakeFetch = (async () => new Response(JSON.stringify([{ id: 'remote', name: 'R', template: { transport: 'stdio', command: 'r' } }]))) as unknown as typeof fetch;
    const c = new Catalog(() => ({ sources: ['cat.json', 'arr.json', 'https://example.com/c.json', 'missing.json'] }), () => dir);
    await c.refresh(fakeFetch);
    expect(c.get('memory')!.name).toBe('My memory');
    expect(c.get('extra')).toBeDefined();
    expect(c.get('remote')!.source).toBe('https://example.com/c.json');
    expect(c.installEnabled()).toBe(false);
    const only = new Catalog(() => ({ builtins: false }));
    await only.refresh();
    expect(only.list()).toHaveLength(0);
    await expect(loadCatalogSource('https://example.com/x', dir, (async () => new Response('', { status: 500 })) as unknown as typeof fetch)).rejects.toThrow(/HTTP 500/);
    writeFileSync(join(dir, 'bad.json'), '{"nope":1}');
    await expect(loadCatalogSource('bad.json', dir)).rejects.toThrow(/expected an array/);
  });

  it('persists installed servers', async () => {
    const f = join(tmp(), 'installed.json');
    const s = new InstalledServers(() => f);
    expect(s.load()).toEqual([]);
    await s.add({ id: 'a', name: 'A', transport: 'stdio', command: 'x' });
    expect(JSON.parse(readFileSync(f, 'utf8')).servers).toHaveLength(1);
    expect(new InstalledServers(() => f).load()).toHaveLength(1);
    expect(await s.remove('nope')).toBe(false);
    expect(await s.remove('a')).toBe(true);
    writeFileSync(f, 'not json');
    expect(new InstalledServers(() => f).load()).toEqual([]);
  });

  it('validates the catalog block', async () => {
    const file = join(tmp(), 'gw.yml');
    writeFileSync(file, 'catalog:\n  install: true\n  sources: [./c.json]\n  serversFile: installed.json\n');
    expect((await loadConfig(file)).catalog).toMatchObject({ install: true });
    writeFileSync(file, 'catalog:\n  nope: 1\n');
    await expect(loadConfig(file)).rejects.toThrow(/catalog/);
  });
});

describe('catalog in the gateway', () => {
  let gw: Gateway | undefined;
  afterEach(async () => {
    await gw?.stop();
    gw = undefined;
  });

  async function start(extra: Partial<GatewayConfig>) {
    gw = new Gateway({ port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false }, servers: [], ...extra });
    await gw.start();
    return `http://127.0.0.1:${gw.address()!.port}`;
  }

  it('installs, persists, lists and removes a server', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'cat.json'), JSON.stringify([{ id: 'fake', name: 'Fake', description: 'test', template: { transport: 'stdio', command: process.execPath, args: [fixture] } }]));
    const url = await start({ configDir: dir, catalog: { install: true, sources: ['cat.json'], serversFile: 'installed.json' } });
    const cat = (await (await fetch(`${url}/api/v1/catalog`)).json()) as { install: boolean; entries: Array<{ id: string; installed: string[] }> };
    expect(cat.install).toBe(true);
    expect(cat.entries.some((e) => e.id === 'filesystem')).toBe(true);
    const post = (id: string, body: unknown) => fetch(`${url}/api/v1/catalog/${id}/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const r = await post('fake', { serverId: 'fake1' });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ server: 'fake1', connected: true, persisted: true });
    expect((await post('fake', { serverId: 'fake1' })).status).toBe(409);
    expect((await post('nope', {})).status).toBe(404);
    expect((await post('git', {})).status).toBe(400);
    expect(existsSync(join(dir, 'installed.json'))).toBe(true);
    const tools = (await (await fetch(`${url}/api/v1/tools`)).json()) as { tools: Array<{ serverId: string }> };
    expect(tools.tools.map((t) => t.serverId)).toEqual(['fake1']);
    const after = (await (await fetch(`${url}/api/v1/catalog`)).json()) as { entries: Array<{ id: string; installed: string[] }> };
    expect(after.entries.find((e) => e.id === 'fake')!.installed).toEqual(['fake1']);
    // survives a reload that does not list it
    await gw!.reload({ port: 0, host: '127.0.0.1', servers: [], configDir: dir, catalog: { install: true, sources: ['cat.json'], serversFile: 'installed.json' } });
    expect((await (await fetch(`${url}/api/v1/servers`)).json() as { servers: Array<{ id: string }> }).servers.map((s) => s.id)).toEqual(['fake1']);
    expect((await fetch(`${url}/api/v1/catalog/servers/nope`, { method: 'DELETE' })).status).toBe(404);
    expect((await fetch(`${url}/api/v1/catalog/servers/fake1`, { method: 'DELETE' })).status).toBe(200);
    expect(JSON.parse(readFileSync(join(dir, 'installed.json'), 'utf8')).servers).toEqual([]);
  });

  it('refuses installs unless catalog.install is on, and scoped keys', async () => {
    const url = await start({ auth: { strategy: 'api-key', apiKeys: [{ key: 'ops', name: 'ops' }, { key: 'sc', name: 'sc', servers: ['x'] }] } });
    const post = (k: string) => fetch(`${url}/api/v1/catalog/memory/install`, { method: 'POST', headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' }, body: '{}' });
    expect((await post('ops')).status).toBe(403);
    expect((await fetch(`${url}/api/v1/catalog`, { headers: { authorization: 'Bearer sc' } })).status).toBe(403);
  });
});
