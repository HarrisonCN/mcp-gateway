/** 7.6: offline desktop gateway. */
import { describe, it, expect, afterEach } from 'vitest';
import { startFeatureGw, fakeServer, type FeatureGw } from './helpers/feature-gw.js';
import { validateConfig } from '../src/config/loader.js';
import { callHooks } from '../src/gateway/hooks.js';
import { OfflineSchema, importDesktopServers, desktopConfig, probe, isOffline, offlineState, ERR_OFFLINE } from '../src/features/offline.js';

let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
  offlineState.override = undefined;
  offlineState.reachable = undefined;
});

describe('offline desktop gateway (7.6)', () => {
  it('imports Claude Desktop / Cursor / VS Code server lists', () => {
    const claude = importDesktopServers({
      mcpServers: {
        'File System': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], env: { DEBUG: 1 } },
        github: { url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer x' } },
        legacy: { url: 'https://old.example/sse' },
        off: { command: 'x', disabled: true },
        weird: { foo: 1 },
      },
    });
    expect(claude.servers).toEqual([
      { id: 'file-system', name: 'File System', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], env: { DEBUG: '1' } },
      { id: 'github', name: 'github', transport: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer x' } },
      { id: 'legacy', name: 'legacy', transport: 'sse', url: 'https://old.example/sse' },
    ]);
    expect(claude.skipped).toEqual(['off', 'weird']);
    const vscode = importDesktopServers({ servers: { 'my server': { type: 'sse', url: 'http://localhost:9/x' }, 'My Server': { command: 'y' } } });
    expect(vscode.servers.map((s) => `${s.id}:${s.transport}`)).toEqual(['my-server:sse', 'my-server-2:stdio']);
    expect(importDesktopServers(null)).toEqual({ servers: [], skipped: [] });
  });

  it('desktop profile validates; loopback, generated key, offline on', () => {
    const { config, apiKey } = desktopConfig({ servers: importDesktopServers({ mcpServers: { a: { command: 'node', args: ['a.js'] } } }).servers });
    expect(apiKey).toMatch(/^mgw_[A-Za-z0-9_-]{32}$/);
    const v = validateConfig(config);
    expect(v.host).toBe('127.0.0.1');
    expect(v.offline).toMatchObject({ mode: 'auto' });
    expect(v.servers[0]).toMatchObject({ id: 'a', transport: 'stdio' });
    expect(desktopConfig({ apiKey: 'k', port: 5000 }).config).toMatchObject({ port: 5000, auth: { apiKeys: ['k'] } });
  });

  it('probe and modes', async () => {
    const c = OfflineSchema.parse({ probeUrl: 'http://probe.local/' });
    const ok = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const down = (async () => { throw new Error('ENETUNREACH'); }) as unknown as typeof fetch;
    expect(await probe(c, down)).toBe(false);
    expect(offlineState.lastError).toBe('ENETUNREACH');
    expect(isOffline(c)).toBe(true);
    expect(await probe(c, ok)).toBe(true);
    expect(isOffline(c)).toBe(false);
    expect(isOffline(OfflineSchema.parse({ mode: 'offline' }))).toBe(true);
    offlineState.reachable = false;
    expect(isOffline(OfflineSchema.parse({ mode: 'online' }))).toBe(false);
  });

  it('gateway: remote upstreams fail fast offline, local stdio keeps working; admin API', async () => {
    h = await startFeatureGw({
      servers: [fakeServer('fake'), { id: 'cloud', name: 'cloud', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp', timeout: 5000 }, { id: 'nas-1', name: 'nas', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp', timeout: 5000 }],
      offline: { mode: 'online', allowRemote: ['nas-*'] },
    } as never);
    const call = async (server: string) => {
      const r = await fetch(`${h!.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json' }, body: JSON.stringify({ server, tool: 'echo', arguments: {} }) });
      return { status: r.status, body: JSON.stringify(await r.json()) };
    };
    let st = await h.admin('offline');
    expect(st.body).toMatchObject({ enabled: true, mode: 'online', offline: false, servers: { local: ['fake'], remote: ['cloud', 'nas-1'], allowRemote: ['nas-*'] } });
    expect((await h.admin('offline', { mode: 'offline' })).body).toMatchObject({ mode: 'offline', offline: true });
    expect((await call('fake')).status).toBe(200);
    const t0 = Date.now();
    expect((await call('cloud')).status).toBeGreaterThanOrEqual(400); // never connected: refused before the invoker
    expect(Date.now() - t0).toBeLessThan(2000);
    // the call hook refuses remote upstreams (connected ones would otherwise hang until their timeout)
    const hook = callHooks().find((x) => x.id === 'offline')!;
    const cfg = h.gw['config'];
    const refused = (await hook.before!({ serverId: 'cloud', tool: 'echo', args: {} }, cfg)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(refused.refuse).toMatchObject({ code: ERR_OFFLINE, data: { server: 'cloud', mode: 'offline' } });
    expect(await hook.before!({ serverId: 'nas-1', tool: 'echo', args: {} }, cfg)).toBeUndefined();
    expect(await hook.before!({ serverId: 'fake', tool: 'echo', args: {} }, cfg)).toBeUndefined();
    st = await h.admin('offline');
    expect(st.body.refused).toBeGreaterThanOrEqual(1);
    expect((await h.admin('offline', { mode: 'online' })).body).toMatchObject({ mode: 'online', offline: false });
    expect(await hook.before!({ serverId: 'cloud', tool: 'echo', args: {} }, cfg)).toBeUndefined();
    expect((await h.admin('offline', { mode: 'sideways' })).status).toBe(400);
    const imp = await h.admin('offline/import', { config: { mcpServers: { x: { command: 'y' } } } });
    expect(imp.body.servers[0]).toMatchObject({ id: 'x', transport: 'stdio' });
    expect((await h.admin('offline/import', {})).status).toBe(400);
  });
});
