import { describe, it, expect, vi, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { SignJWT } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { isServerInScope, isToolInScope, filterToolsByScope, scopeFromJwt } from '../src/auth/scopes.js';
import { createAuthMiddleware } from '../src/auth/middleware.js';
import { loadConfig } from '../src/config/loader.js';
import { Gateway } from '../src/gateway/index.js';
import type { GatewayConfig, McpServerConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

logger.setLevel('error');

describe('scope matching', () => {
  const tools = [
    { serverId: 'github', name: 'create_issue' },
    { serverId: 'github', name: 'delete_repo' },
    { serverId: 'fs-a', name: 'read_file' },
    { serverId: 'fs-a', name: 'write_file' },
    { serverId: 'db', name: 'read_file' },
  ];

  it('no scope or absent lists allow everything', () => {
    expect(filterToolsByScope(undefined, tools)).toHaveLength(5);
    expect(filterToolsByScope({ name: 'x' }, tools)).toHaveLength(5);
    expect(isServerInScope({}, 'any')).toBe(true);
  });

  it('servers globs restrict servers; empty list allows nothing', () => {
    const s = { servers: ['github', 'fs-*'] };
    expect(isServerInScope(s, 'fs-a')).toBe(true);
    expect(isServerInScope(s, 'db')).toBe(false);
    expect(filterToolsByScope(s, tools).map((t) => t.serverId)).toEqual(['github', 'github', 'fs-a', 'fs-a']);
    expect(filterToolsByScope({ servers: [] }, tools)).toEqual([]);
  });

  it('tool globs match the name, or "<server>/<tool>" when they contain a slash', () => {
    const s = { tools: ['read_*', 'github/create_issue'] };
    expect(filterToolsByScope(s, tools).map((t) => `${t.serverId}/${t.name}`)).toEqual([
      'github/create_issue',
      'fs-a/read_file',
      'db/read_file',
    ]);
    expect(isToolInScope({ servers: ['fs-*'], tools: ['read_*'] }, 'db', 'read_file')).toBe(false);
  });

  it('reads JWT claims as arrays or space/comma separated strings; malformed claims allow nothing', () => {
    expect(scopeFromJwt({ sub: 'a' })).toBeUndefined();
    expect(scopeFromJwt({ mcp_servers: ['a', 'b*'] })).toEqual({ servers: ['a', 'b*'] });
    expect(scopeFromJwt({ mcp_tools: 'read_* github/x, y' })).toEqual({ tools: ['read_*', 'github/x', 'y'] });
    expect(scopeFromJwt({ mcp_servers: 42 })).toEqual({ servers: [] });
    expect(scopeFromJwt(null)).toBeUndefined();
  });
});

describe('auth middleware with key objects', () => {
  const res = () => {
    const r: any = { statusCode: 200 };
    r.status = (c: number) => ((r.statusCode = c), r);
    r.json = () => r;
    return r;
  };

  it('attaches scope and a name-based client id; plain keys stay unscoped', () => {
    const mw = createAuthMiddleware({
      strategy: 'api-key',
      apiKeys: ['plain', { key: 'scoped', name: 'aura', servers: ['gh'], rateLimit: { limit: 2, windowSeconds: 60 } }],
    });
    const a: any = { headers: { authorization: 'Bearer scoped' } };
    const next = vi.fn();
    mw(a, res(), next);
    expect(next).toHaveBeenCalled();
    expect(a.clientId).toBe('key:aura');
    expect(a.scope).toMatchObject({ name: 'aura', servers: ['gh'], rateLimit: { limit: 2 } });
    const b: any = { headers: { 'x-api-key': 'plain' } };
    mw(b, res(), vi.fn());
    expect(b.clientId).toMatch(/^key:[0-9a-f]{12}$/);
    expect(b.scope).toBeUndefined();
    expect(mw.resolveClient!('key:aura')).toMatchObject({ known: true, scope: { servers: ['gh'] } });
    expect(mw.resolveClient!('key:gone')).toEqual({ known: false });
  });

  it('rejects duplicate key names', () => {
    expect(() =>
      createAuthMiddleware({ strategy: 'api-key', apiKeys: [{ key: 'a', name: 'x' }, { key: 'b', name: 'x' }] }),
    ).toThrow(/duplicate/);
  });

  it('JWT scopes come from claims', async () => {
    const secret = 'x'.repeat(40);
    const mw = createAuthMiddleware({ strategy: 'jwt', jwtSecret: secret });
    const token = await new SignJWT({ mcp_servers: ['gh'] })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u1')
      .sign(new TextEncoder().encode(secret));
    const r: any = { headers: { authorization: `Bearer ${token}` } };
    await new Promise<void>((done) => mw(r, res(), () => done()));
    expect(r.scope).toEqual({ servers: ['gh'] });
    expect(mw.resolveClient).toBeUndefined();
  });
});

describe('config: api key objects', () => {
  const dirs: string[] = [];
  afterEach(() => {
    dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
    delete process.env.TEST_SCOPED_KEY;
  });
  const file = (content: string) => {
    const d = mkdtempSync(join(tmpdir(), 'mcpgw-scope-'));
    dirs.push(d);
    const p = join(d, 'gw.yml');
    writeFileSync(p, content);
    return p;
  };

  it('accepts mixed strings and objects and expands ${VAR} in object keys', async () => {
    process.env.TEST_SCOPED_KEY = 'from-env';
    const c = await loadConfig(
      file(
        'auth:\n  strategy: api-key\n  apiKeys:\n    - plain\n    - key: ${TEST_SCOPED_KEY}\n      name: aura\n      scope:\n        servers: [gh]\n        tools: ["read_*"]\n        rateLimit: {limit: 5, windowSeconds: 10}\n',
      ),
    );
    expect(c.auth!.apiKeys).toEqual([
      'plain',
      { key: 'from-env', name: 'aura', servers: ['gh'], tools: ['read_*'], rateLimit: { limit: 5, windowSeconds: 10 } },
    ]);
  });

  it('rejects unknown fields, duplicate names, bad names and empty keys', async () => {
    const bad = [
      'auth: {strategy: api-key, apiKeys: [{key: a, nope: 1}]}',
      'auth: {strategy: api-key, apiKeys: [{key: a, name: x}, {key: b, name: x}]}',
      'auth: {strategy: api-key, apiKeys: [{key: a, name: "has space"}]}',
      'auth: {strategy: api-key, apiKeys: [{key: "${UNSET_VAR_FOR_TEST}"}]}',
      'auth: {strategy: api-key, apiKeys: [{key: a, scope: {servers: [""]}}]}',
      'auth: {strategy: api-key, apiKeys: [{key: a, servers: [x]}]}',
    ];
    for (const b of bad) await expect(loadConfig(file(b + '\n')), b).rejects.toThrow(/apiKeys/);
  });
});

// ─── End to end ──────────────────────────────────────────────────────────────

const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
const stdio = (id: string, env: Record<string, string> = {}): McpServerConfig => ({
  id,
  name: id,
  transport: 'stdio',
  command: process.execPath,
  args: [fixture],
  env,
  timeout: 2000,
});

let gw: Gateway | undefined;
let clients: Client[] = [];
afterEach(async () => {
  for (const c of clients) await c.close().catch(() => {});
  clients = [];
  await gw?.stop();
  gw = undefined;
});

const auth = {
  strategy: 'api-key' as const,
  apiKeys: [
    'admin',
    { key: 'only-a', name: 'only-a', servers: ['a'] },
    { key: 'pages', name: 'pages', tools: ['b/echo1', 'echo'] },
    { key: 'slow-lane', name: 'slow-lane', rateLimit: { limit: 1, windowSeconds: 60 } },
  ],
};
const config: GatewayConfig = {
  port: 0,
  host: '127.0.0.1',
  logLevel: 'error',
  monitor: { requestLog: false },
  auth,
  rateLimit: { limit: 100, windowSeconds: 60 },
  servers: [stdio('a'), stdio('b', { TOOL_PAGES: '2' })],
};

async function start(cfg: GatewayConfig = config) {
  gw = new Gateway(cfg);
  await gw.start();
  return `http://127.0.0.1:${gw.address()!.port}`;
}
const get = (url: string, path: string, key: string) =>
  fetch(`${url}/api/v1${path}`, { headers: { authorization: `Bearer ${key}` } });
const call = (url: string, key: string, body: unknown) =>
  fetch(`${url}/api/v1/tools/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });

describe('scopes on the REST API', () => {
  it('hides out-of-scope servers and tools from discovery', async () => {
    const url = await start();
    const names = async (key: string) =>
      ((await (await get(url, '/tools', key)).json()) as any).tools.map((t: any) => `${t.serverId}/${t.name}`).sort();
    expect(await names('admin')).toEqual(['a/echo', 'b/echo', 'b/echo1']);
    expect(await names('only-a')).toEqual(['a/echo']);
    expect(await names('pages')).toEqual(['a/echo', 'b/echo', 'b/echo1']);

    const servers: any = await (await get(url, '/servers', 'only-a')).json();
    expect(servers.servers.map((s: any) => s.id)).toEqual(['a']);
    expect((await get(url, '/servers/b', 'only-a')).status).toBe(404);
    expect((await get(url, '/servers/a', 'only-a')).status).toBe(200);
  });

  it('refuses out-of-scope calls with 403 and auto-routes among allowed servers', async () => {
    const url = await start();
    // "echo" exists on a and b: admin must disambiguate, only-a is routed to a
    expect((await call(url, 'admin', { tool: 'echo' })).status).toBe(409);
    const r = await call(url, 'only-a', { tool: 'echo', arguments: { x: 1 } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).server).toBe('a');
    expect((await call(url, 'only-a', { tool: 'echo', server: 'b' })).status).toBe(403);
    expect((await call(url, 'only-a', { tool: 'echo1' })).status).toBe(403);
    expect((await call(url, 'only-a', { tool: 'nope' })).status).toBe(404);
    expect((await fetch(`${url}/api/v1/servers/b/reconnect`, { method: 'POST', headers: { authorization: 'Bearer only-a' } })).status).toBe(403);
    // tool-scoped key: b/echo1 allowed, a/echo allowed by bare pattern
    expect((await call(url, 'pages', { tool: 'echo1' })).status).toBe(200);
  });

  it('applies a key-specific rate limit and keeps the global one for other keys', async () => {
    const url = await start();
    expect((await call(url, 'slow-lane', { tool: 'echo', server: 'a' })).status).toBe(200);
    const limited = await call(url, 'slow-lane', { tool: 'echo', server: 'a' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('x-ratelimit-limit')).toBe('1');
    const other = await call(url, 'admin', { tool: 'echo', server: 'a' });
    expect(other.status).toBe(200);
    expect(other.headers.get('x-ratelimit-limit')).toBe('100');
  });

  it('shows restricted keys only their own request history', async () => {
    const url = await start();
    await call(url, 'admin', { tool: 'echo', server: 'b' });
    await call(url, 'only-a', { tool: 'echo', server: 'a' });
    const mine: any = await (await get(url, '/requests', 'only-a')).json();
    expect(mine.requests.map((r: any) => r.clientId)).toEqual(['key:only-a']);
    const all: any = await (await get(url, '/requests', 'admin')).json();
    expect(all.requests).toHaveLength(2);
  });

  it('hot reloads scopes', async () => {
    const url = await start();
    expect((await call(url, 'only-a', { tool: 'echo', server: 'b' })).status).toBe(403);
    await gw!.reload({ ...config, auth: { ...auth, apiKeys: ['admin', { key: 'only-a', name: 'only-a', servers: ['b'] }] } });
    expect((await call(url, 'only-a', { tool: 'echo', server: 'b' })).status).toBe(200);
    expect((await call(url, 'only-a', { tool: 'echo', server: 'a' })).status).toBe(403);
  });
});

describe('scopes on /mcp', () => {
  async function sdk(url: string, key: string) {
    const client = new Client({ name: 't', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }),
    );
    clients.push(client);
    return client;
  }

  it('lists only allowed tools and refuses others with a JSON-RPC error', async () => {
    const url = await start();
    const admin = await sdk(url, 'admin');
    expect((await admin.listTools()).tools.map((t) => t.name).sort()).toEqual(['a__echo', 'b__echo', 'echo1']);

    const onlyA = await sdk(url, 'only-a');
    // no collision within its scope → bare name
    expect((await onlyA.listTools()).tools.map((t) => t.name)).toEqual(['echo']);
    const ok: any = await onlyA.callTool({ name: 'echo', arguments: { v: 1 } });
    expect(ok.content[0].text).toBe('{"v":1}');
    await expect(onlyA.callTool({ name: 'b__echo', arguments: {} })).rejects.toThrow(/Forbidden/);
    await expect(onlyA.callTool({ name: 'echo1', arguments: {} })).rejects.toThrow(/Forbidden/);
    await expect(onlyA.callTool({ name: 'zzz', arguments: {} })).rejects.toThrow(/Unknown tool/);
  });

  it('applies key rate limits on /mcp', async () => {
    const url = await start();
    const c = await sdk(url, 'slow-lane');
    await c.callTool({ name: 'a__echo', arguments: {} });
    await expect(c.callTool({ name: 'a__echo', arguments: {} })).rejects.toThrow(/Rate limit/);
  });

  it('notifies sessions whose scope changes on reload and ends sessions of removed keys', async () => {
    const url = await start();
    const onlyA = await sdk(url, 'only-a');
    let changed = 0;
    onlyA.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      changed++;
    });
    expect((await onlyA.listTools()).tools.map((t) => t.name)).toEqual(['echo']);
    const ep = gw!.getMcpEndpoint()!;
    const waitFor = async (p: () => boolean) => {
      const end = Date.now() + 5000;
      while (!p()) {
        if (Date.now() > end) throw new Error('timeout');
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    await waitFor(() => ep.getSessions().some((s) => s.clientId === 'key:only-a' && s.streams > 0));
    await sdk(url, 'pages');
    await gw!.reload({ ...config, auth: { ...auth, apiKeys: ['admin', { key: 'only-a', name: 'only-a', servers: ['b'] }] } });
    await waitFor(() => changed > 0);
    expect((await onlyA.listTools()).tools.map((t) => t.name).sort()).toEqual(['echo', 'echo1']);
    // "pages" key was removed → its session is gone
    await waitFor(() => !ep.getSessions().some((s) => s.clientId === 'key:pages'));
  });
});
