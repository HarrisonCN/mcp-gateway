import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { Gateway } from '../src/gateway/index.js';
import type { GatewayConfig, McpServerConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';
import { startSseServer, startStreamableHttpServer, stats, type RemoteServer } from './fixtures/remote-servers.js';

logger.setLevel('error');
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

const base: GatewayConfig = {
  port: 0,
  host: '127.0.0.1',
  logLevel: 'error',
  monitor: { requestLog: false },
  reconnect: { initialDelayMs: 30, maxDelayMs: 200, jitter: 0 },
  servers: [],
};

let gw: Gateway | undefined;
let remotes: RemoteServer[] = [];
let clients: Client[] = [];
afterEach(async () => {
  for (const c of clients) await c.close().catch(() => {});
  clients = [];
  await gw?.stop();
  gw = undefined;
  for (const r of remotes) await r.close();
  remotes = [];
});

async function start(config: GatewayConfig): Promise<string> {
  gw = new Gateway(config);
  await gw.start();
  return `http://127.0.0.1:${gw.address()!.port}`;
}

const waitFor = async (pred: () => Promise<boolean> | boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

async function sdkClient(url: string, headers: Record<string, string> = {}) {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers } });
  await client.connect(transport);
  clients.push(client);
  return { client, transport };
}

const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const rpc = (id: number, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${url}/mcp`, { method: 'POST', headers: { ...H, ...headers }, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : undefined };
}

async function openSession(url: string, headers: Record<string, string> = {}, protocolVersion = '2025-06-18') {
  const r = await post(url, rpc(1, 'initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'raw', version: '0' } }), headers);
  expect(r.status).toBe(200);
  const sid = r.headers.get('mcp-session-id')!;
  expect(sid).toBeTruthy();
  await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, { ...headers, 'mcp-session-id': sid });
  return { sid, init: r.body };
}

describe('/mcp with the official SDK client', () => {
  it('initializes, lists aggregated tools, calls them and pings', async () => {
    const http = await startStreamableHttpServer();
    remotes.push(http);
    const url = await start({
      ...base,
      servers: [stdio('local'), { id: 'remote', name: 'Remote', transport: 'streamable-http', url: http.url, timeout: 3000 }],
    });
    const { client, transport } = await sdkClient(url);
    expect(client.getServerVersion()?.name).toBe('mcp-gateway');
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
    expect(transport.sessionId).toBeTruthy();

    const { tools } = await client.listTools();
    // "echo" exists on both servers → both prefixed; the rest keep their names
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['add-tool', 'local__echo', 'remote__echo', 'slow'].sort());
    expect(tools.find((t) => t.name === 'remote__echo')?.inputSchema).toMatchObject({ type: 'object' });

    const r1: any = await client.callTool({ name: 'remote__echo', arguments: { msg: 'hi' } });
    expect(r1.content[0].text).toBe('echo:hi');
    const r2: any = await client.callTool({ name: 'local__echo', arguments: { a: 1 } });
    expect(r2.content[0].text).toBe('{"a":1}');
    await expect(client.ping()).resolves.toBeDefined();

    // call metrics are shared with REST and tagged
    const recent: any = await (await fetch(`${url}/api/v1/requests`)).json();
    expect(recent.requests[0]).toMatchObject({ via: 'mcp', serverId: 'local', toolName: 'echo' });

    await transport.terminateSession();
    expect(gw!.getMcpEndpoint()!.getSessions()).toHaveLength(0);
  });

  it('sends notifications/tools/list_changed when an upstream tool list changes', async () => {
    // (the SSE upstream delivers unsolicited list_changed; see streamable-http channel notes)
    const sse = await startSseServer();
    remotes.push(sse);
    const url = await start({
      ...base,
      servers: [{ id: 'remote', name: 'Remote', transport: 'sse', url: sse.url, timeout: 3000 }],
    });
    const { client } = await sdkClient(url);
    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      changed++;
    });
    await client.listTools();
    // wait for the SDK client to open its GET stream
    await waitFor(() => (gw!.getMcpEndpoint()!.getSessions()[0]?.streams ?? 0) > 0);
    await client.callTool({ name: 'add-tool', arguments: {} });
    await waitFor(() => changed > 0);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('late');
  });

  it('notifies when a server is removed by hot reload', async () => {
    const config: GatewayConfig = { ...base, servers: [stdio('a'), stdio('b')] };
    const url = await start(config);
    const { client } = await sdkClient(url);
    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      changed++;
    });
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['a__echo', 'b__echo']);
    await waitFor(() => (gw!.getMcpEndpoint()!.getSessions()[0]?.streams ?? 0) > 0);
    await gw!.reload({ ...config, servers: [stdio('a')] });
    await waitFor(() => changed > 0);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['echo']);
  });

  it('propagates cancellation to the upstream server', async () => {
    const http = await startStreamableHttpServer();
    remotes.push(http);
    const url = await start({
      ...base,
      servers: [{ id: 'remote', name: 'Remote', transport: 'streamable-http', url: http.url, timeout: 5000 }],
    });
    const { client } = await sdkClient(url);
    const before = stats.cancelled;
    const ac = new AbortController();
    const p = client.callTool({ name: 'slow', arguments: { ms: 3000 } }, undefined, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 200));
    ac.abort();
    await expect(p).rejects.toThrow();
    await waitFor(() => stats.cancelled > before);
  });

  it('works with api-key auth and binds sessions to the key', async () => {
    const url = await start({ ...base, auth: { strategy: 'api-key', apiKeys: ['k1', 'k2'] }, servers: [stdio('one')] });
    expect((await post(url, rpc(1, 'initialize', { protocolVersion: '2025-06-18' }))).status).toBe(401);

    const { client } = await sdkClient(url, { authorization: 'Bearer k1' });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['echo']);

    const { sid } = await openSession(url, { authorization: 'Bearer k1' });
    const same = await post(url, rpc(2, 'ping'), { authorization: 'Bearer k1', 'mcp-session-id': sid });
    expect(same.status).toBe(200);
    const other = await post(url, rpc(2, 'ping'), { authorization: 'Bearer k2', 'mcp-session-id': sid });
    expect(other.status).toBe(404);
  });
});

describe('/mcp protocol details (raw HTTP)', () => {
  it('negotiates the protocol version', async () => {
    const url = await start({ ...base });
    expect((await openSession(url, {}, '2025-03-26')).init.result.protocolVersion).toBe('2025-03-26');
    expect((await openSession(url, {}, '2099-01-01')).init.result.protocolVersion).toBe('2025-06-18');
  });

  it('validates session and protocol headers', async () => {
    const url = await start({ ...base, servers: [stdio('one')] });
    const missing = await post(url, rpc(1, 'tools/list'));
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toMatch(/Mcp-Session-Id/);
    expect((await post(url, rpc(1, 'tools/list'), { 'mcp-session-id': 'nope' })).status).toBe(404);

    const { sid } = await openSession(url);
    const badVersion = await post(url, rpc(1, 'ping'), { 'mcp-session-id': sid, 'mcp-protocol-version': '1999-01-01' });
    expect(badVersion.status).toBe(400);
    const ok = await post(url, rpc(1, 'ping'), { 'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18' });
    expect(ok.body).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });

  it('handles notifications, batches, unknown methods and parse errors', async () => {
    const url = await start({ ...base, servers: [stdio('one')] });
    const { sid } = await openSession(url, {}, '2025-03-26');
    const S = { 'mcp-session-id': sid };

    const n = await post(url, { jsonrpc: '2.0', method: 'notifications/whatever' }, S);
    expect(n.status).toBe(202);
    expect(n.body).toBeUndefined();

    const batch = await post(url, [rpc(1, 'ping'), rpc(2, 'tools/list'), { jsonrpc: '2.0', method: 'notifications/x' }], S);
    expect(batch.status).toBe(200);
    expect(batch.body).toHaveLength(2);
    expect(batch.body[1].result.tools.map((t: any) => t.name)).toEqual(['echo']);

    const unknown = await post(url, rpc(3, 'sampling/createMessage'), S);
    expect(unknown.body.error.code).toBe(-32601);

    // initialize always starts a new session
    const again = await post(url, rpc(4, 'initialize', {}), S);
    expect(again.status).toBe(200);
    expect(again.headers.get('mcp-session-id')).not.toBe(sid);
    expect((await post(url, [rpc(5, 'initialize', {}), rpc(6, 'ping')])).status).toBe(400);

    const r = await fetch(`${url}/mcp`, { method: 'POST', headers: { ...H, ...S }, body: '{bad json' });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error.code).toBe(-32700);

    const invalid = await post(url, { hello: 'world' }, S);
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe(-32600);

    expect((await fetch(`${url}/mcp`, { method: 'PUT' })).status).toBe(405);
  });

  it('reports tool errors: unknown tool, bad arguments, offline server, upstream timeout', async () => {
    const url = await start({
      ...base,
      reconnect: { enabled: false },
      servers: [stdio('one')],
    });
    const { sid } = await openSession(url);
    const S = { 'mcp-session-id': sid };
    const call = (name: string, args?: unknown) => post(url, rpc(7, 'tools/call', { name, arguments: args }), S);

    expect((await call('nope')).body.error.code).toBe(-32602);
    expect((await call('echo', [1, 2])).body.error.code).toBe(-32602);
    expect((await post(url, rpc(7, 'tools/call', {}), S)).body.error.code).toBe(-32602);

    // alias with explicit server prefix works in auto mode
    const alias = await call('one__echo', { x: 1 });
    expect(alias.body.result.content[0].text).toBe('{"x":1}');

  });

  it('turns an upstream timeout into an isError result', async () => {
    const http = await startStreamableHttpServer();
    remotes.push(http);
    const url = await start({
      ...base,
      servers: [{ id: 'remote', name: 'Remote', transport: 'streamable-http', url: http.url, timeout: 400 }],
    });
    const { sid } = await openSession(url);
    const r = await post(url, rpc(8, 'tools/call', { name: 'slow', arguments: { ms: 2000 } }), { 'mcp-session-id': sid });
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.content[0].text).toMatch(/timed out/);
  });

  it('returns an isError result when the server is not connected', async () => {
    const url = await start({ ...base, reconnect: { enabled: false }, servers: [stdio('one')] });
    const { sid } = await openSession(url);
    const S = { 'mcp-session-id': sid };
    // crash the server (fake server exits on "crash"), tools stay registered
    await fetch(`${url}/api/v1/tools/call`, { method: 'POST', headers: H, body: JSON.stringify({ tool: 'crash', server: 'one' }) });
    await waitFor(async () => {
      const s: any = await (await fetch(`${url}/api/v1/servers/one`)).json();
      return s.health.status === 'offline';
    });
    const r = await post(url, rpc(1, 'tools/call', { name: 'echo', arguments: {} }), S);
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.content[0].text).toMatch(/not connected/);
  });

  it('applies the gateway rate limit to tools/call as a JSON-RPC error', async () => {
    const url = await start({ ...base, rateLimit: { limit: 1, windowSeconds: 60 }, servers: [stdio('one')] });
    const { sid } = await openSession(url);
    const S = { 'mcp-session-id': sid };
    const first = await post(url, rpc(1, 'tools/call', { name: 'echo', arguments: {} }), S);
    expect(first.body.result).toBeDefined();
    expect(first.headers.get('x-ratelimit-limit')).toBe('1');
    // list / ping are not rate limited
    expect((await post(url, rpc(2, 'tools/list'), S)).body.result).toBeDefined();
    const second = await post(url, rpc(3, 'tools/call', { name: 'echo', arguments: {} }), S);
    expect(second.body.error.code).toBe(-32029);
    expect(second.body.error.data.retryAfter).toBeGreaterThan(0);
    expect(second.headers.get('retry-after')).toBeTruthy();
  });

  it('paginates tools/list', async () => {
    const url = await start({ ...base, mcp: { pageSize: 1 }, servers: [stdio('one', { TOOL_PAGES: '3' })] });
    const { sid } = await openSession(url);
    const S = { 'mcp-session-id': sid };
    const names: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const r = await post(url, rpc(i, 'tools/list', cursor ? { cursor } : undefined), S);
      names.push(...r.body.result.tools.map((t: any) => t.name));
      cursor = r.body.result.nextCursor;
      if (!cursor) break;
    }
    expect(names).toEqual(['echo', 'echo1', 'echo2']);
    expect((await post(url, rpc(9, 'tools/list', { cursor: '!!' }), S)).body.error.code).toBe(-32602);
  });

  it('supports toolNaming: prefix and hot reload of it', async () => {
    const config: GatewayConfig = { ...base, mcp: { toolNaming: 'prefix' }, servers: [stdio('one')] };
    const url = await start(config);
    const { sid } = await openSession(url);
    const S = { 'mcp-session-id': sid };
    expect((await post(url, rpc(1, 'tools/list'), S)).body.result.tools.map((t: any) => t.name)).toEqual(['one__echo']);
    expect((await post(url, rpc(2, 'tools/call', { name: 'echo' }), S)).body.error.code).toBe(-32602);
    await gw!.reload({ ...config, mcp: { toolNaming: 'auto' } });
    expect((await post(url, rpc(3, 'tools/list'), S)).body.result.tools.map((t: any) => t.name)).toEqual(['echo']);
  });

  it('serves the SSE stream and ends sessions with DELETE', async () => {
    const url = await start({ ...base });
    const { sid } = await openSession(url);
    expect((await fetch(`${url}/mcp`, { headers: { accept: 'application/json', 'mcp-session-id': sid } })).status).toBe(406);
    const ac = new AbortController();
    const stream = await fetch(`${url}/mcp`, { headers: { accept: 'text/event-stream', 'mcp-session-id': sid }, signal: ac.signal });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(gw!.getMcpEndpoint()!.getSessions()[0]!.streams).toBe(1);
    ac.abort();

    const del = await fetch(`${url}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': sid } });
    expect(del.status).toBe(204);
    expect((await post(url, rpc(1, 'ping'), { 'mcp-session-id': sid })).status).toBe(404);
  });

  it('rejects disallowed browser origins (DNS rebinding protection)', async () => {
    const url = await start({ ...base, cors: { origins: ['https://app.example'] } });
    const init = rpc(1, 'initialize', { protocolVersion: '2025-06-18' });
    expect((await post(url, init, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(url, init, { origin: 'https://app.example' })).status).toBe(200);
    expect((await post(url, init)).status).toBe(200);
    await gw!.stop();
    const url2 = await start({ ...base, mcp: { allowedOrigins: ['https://only.example'] } });
    expect((await post(url2, init, { origin: 'https://app.example' })).status).toBe(403);
  });

  it('expires idle sessions and evicts the least recently used one at maxSessions', async () => {
    const url = await start({ ...base, mcp: { maxSessions: 2, sessionIdleTimeoutSeconds: 60 } });
    const tick = () => new Promise((r) => setTimeout(r, 5)); // distinct lastSeen timestamps
    const a = await openSession(url);
    await tick();
    const b = await openSession(url);
    await tick();
    await post(url, rpc(1, 'ping'), { 'mcp-session-id': a.sid }); // a is now more recent than b
    await openSession(url);
    const ids = gw!.getMcpEndpoint()!.getSessions().map((s) => s.id);
    expect(ids).toContain(a.sid);
    expect(ids).not.toContain(b.sid);
    gw!.getMcpEndpoint()!.sweepNow(Date.now() + 61_000);
    expect(gw!.getMcpEndpoint()!.getSessions()).toHaveLength(0);
  });

  it('can be disabled or moved', async () => {
    let url = await start({ ...base, mcp: { enabled: false } });
    expect((await post(url, rpc(1, 'initialize', {}))).status).toBe(404);
    expect(((await (await fetch(url)).json()) as any).mcp).toBe('disabled');
    await gw!.stop();
    url = await start({ ...base, mcp: { path: '/v1/mcp' } });
    const r = await fetch(`${url}/v1/mcp`, { method: 'POST', headers: H, body: JSON.stringify(rpc(1, 'initialize', {})) });
    expect(r.status).toBe(200);
  });
});
