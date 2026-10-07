import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GatewayClient, GatewayError, connectMcp, McpError } from '../src/index.js';

// A tiny fake gateway that records requests and answers like mcp-gateway.
interface Seen { method: string; url: string; headers: IncomingMessage['headers']; body?: any }
const seen: Seen[] = [];
let server: Server;
let base: string;
let cancelled: unknown[] = [];

const tools = [{ name: 'echo', serverId: 'a', serverName: 'A', inputSchema: { type: 'object' } }];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : undefined;
    seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    const json = (status: number, b: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(b));
    };
    const u = new URL(req.url!, 'http://x');
    if (req.headers.authorization !== 'Bearer k' && u.pathname !== '/api/v1/health/ready') return json(401, { error: 'Unauthorized', message: 'Valid API key required' });
    switch (`${req.method} ${u.pathname}`) {
      case 'GET /api/v1/health':
        return json(207, { status: 'degraded', version: '0.7.0', uptime: 1, servers: { total: 1 } });
      case 'GET /api/v1/health/ready':
        return json(503, { status: 'not_ready', servers: { ready: 0, total: 1, required: Number(u.searchParams.get('min') ?? 1) } });
      case 'GET /api/v1/metrics':
        return json(200, { totalRequests: 3, window: u.searchParams.get('window') });
      case 'GET /api/v1/servers':
        return json(200, { servers: [{ id: 'a', name: 'A', transport: 'stdio', toolCount: 1 }], total: 1 });
      case 'GET /api/v1/servers/a':
        return json(200, { id: 'a', name: 'A', transport: 'stdio', tools });
      case 'POST /api/v1/servers/a/reconnect':
        return json(502, { server: 'a', connected: false });
      case 'GET /api/v1/tools':
        if (u.searchParams.get('format')) return json(200, { format: u.searchParams.get('format'), tools: [{ name: 'a__echo' }], mapping: { a__echo: { server: 'a', tool: 'echo' } }, total: 1 });
        return json(200, { tools: u.searchParams.get('server') === 'none' ? [] : tools, total: 1 });
      case 'POST /api/v1/tools/call':
        if (body.tool === 'busy') return json(429, { error: 'Too Many Requests', message: 'Rate limit of 1 requests per 60s exceeded' }, { 'retry-after': '7' });
        if (body.tool === 'hang') return; // never answers
        return json(200, { result: { content: [{ type: 'text', text: JSON.stringify(body) }] }, server: body.server ?? 'a', tool: body.tool, durationMs: 1 });
      case 'GET /api/v1/requests':
        return json(200, { requests: [{ id: '1', toolName: 'echo', limit: u.searchParams.get('limit') }] });
      case 'POST /mcp': {
        if (body.method === 'initialize') return json(200, { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mcp-gateway', version: 'x' } } }, { 'mcp-session-id': 'sid-1' });
        if (req.headers['mcp-session-id'] !== 'sid-1') return json(404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } });
        if (body.id === undefined) {
          if (body.method === 'notifications/cancelled') cancelled.push(body.params.requestId);
          res.writeHead(202).end();
          return;
        }
        if (body.method === 'tools/list') {
          const page = body.params?.cursor === 'p2' ? 2 : 1;
          return json(200, { jsonrpc: '2.0', id: body.id, result: { tools: [{ name: `t${page}`, inputSchema: {} }], ...(page === 1 ? { nextCursor: 'p2' } : {}) } });
        }
        if (body.method === 'tools/call') {
          if (body.params.name === 'slow') return; // hang until aborted
          if (body.params.name === 'nope') return json(200, { jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Unknown tool: nope' } });
          // answer as SSE to exercise that path
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'sse' }] } })}\n\n`);
          return;
        }
        return json(200, { jsonrpc: '2.0', id: body.id, result: {} });
      }
      case 'DELETE /mcp':
        res.writeHead(204).end();
        return;
      default:
        return json(404, { error: { code: 'NOT_FOUND', message: `Route ${req.method} ${u.pathname} not found` } });
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const client = (over: Partial<ConstructorParameters<typeof GatewayClient>[0]> = {}) =>
  new GatewayClient({ baseUrl: base, apiKey: 'k', ...over });

describe('GatewayClient (REST)', () => {
  it('requires a baseUrl and strips trailing slashes', () => {
    expect(() => new GatewayClient({ baseUrl: '' })).toThrow(TypeError);
    expect(client().baseUrl).toBe(base.slice(0, -1));
  });

  it('sends the API key and parses typed responses', async () => {
    const c = client({ headers: { 'x-extra': '1' } });
    expect((await c.health()).status).toBe('degraded');
    const last = seen[seen.length - 1]!;
    expect(last.headers.authorization).toBe('Bearer k');
    expect(last.headers['x-extra']).toBe('1');
    expect(await c.ready(2)).toMatchObject({ ready: false, servers: { required: 2 } });
    expect(((await c.metrics(5000)) as any).window).toBe('5000');
    expect((await c.servers())[0]!.id).toBe('a');
    expect((await c.server('a')).tools[0]!.name).toBe('echo');
    expect((await c.reconnect('a')).connected).toBe(false);
    expect(await c.listTools({ server: 'none' })).toEqual([]);
    expect(seen[seen.length - 1]!.url).toBe('/api/v1/tools?server=none');
    expect((await c.requests(5))[0]).toMatchObject({ toolName: 'echo', limit: '5' });
  });

  it('supports a token provider function', async () => {
    const c = new GatewayClient({ baseUrl: base, token: async () => 'k' });
    await c.servers();
    expect(seen[seen.length - 1]!.headers.authorization).toBe('Bearer k');
  });

  it('calls tools and LLM tool calls via the schema mapping', async () => {
    const c = client();
    const r = await c.callTool('echo', { x: 1 }, { server: 'a' });
    expect(JSON.parse(r.result.content![0]!.text!)).toEqual({ tool: 'echo', arguments: { x: 1 }, server: 'a' });
    const schemas = await c.toolSchemas('anthropic', { tag: 't' });
    expect(seen[seen.length - 1]!.url).toBe('/api/v1/tools?tag=t&format=anthropic');
    const viaLlm = await c.callLlmTool(schemas, 'a__echo', '{"y":2}');
    expect(viaLlm.server).toBe('a');
    expect(JSON.parse(viaLlm.result.content![0]!.text!).arguments).toEqual({ y: 2 });
    await expect(c.callLlmTool(schemas, 'zzz')).rejects.toBeInstanceOf(GatewayError);
  });

  it('throws GatewayError with status, body and Retry-After', async () => {
    const bad = client({ apiKey: 'wrong' });
    const e1 = (await bad.servers().catch((e) => e)) as GatewayError;
    expect(e1).toBeInstanceOf(GatewayError);
    expect(e1.status).toBe(401);
    expect(e1.message).toBe('Valid API key required');
    const e2 = (await client().callTool('busy').catch((e) => e)) as GatewayError;
    expect(e2.status).toBe(429);
    expect(e2.retryAfter).toBe(7);
    const e3 = (await client().server('missing').catch((e) => e)) as GatewayError;
    expect(e3.status).toBe(404);
    expect(e3.message).toMatch(/not found/);
  });

  it('times out, honours AbortSignal and reports network errors', async () => {
    const e = (await client({ timeoutMs: 100 }).callTool('hang').catch((x) => x)) as GatewayError;
    expect(e.status).toBe(0);
    expect(e.message).toMatch(/timed out/);
    const ac = new AbortController();
    const p = client().callTool('hang', {}, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow();
    const net = (await new GatewayClient({ baseUrl: 'http://127.0.0.1:1' }).health().catch((x) => x)) as GatewayError;
    expect(net.message).toMatch(/Network error/);
  });

  it('uses a custom fetch', async () => {
    const calls: string[] = [];
    const c = new GatewayClient({
      baseUrl: 'http://gw',
      fetch: async (url) => {
        calls.push(url);
        return new Response(JSON.stringify({ tools: [], total: 0 }), { status: 200 });
      },
    });
    expect(await c.listTools()).toEqual([]);
    expect(calls).toEqual(['http://gw/api/v1/tools']);
  });
});

describe('McpSession (/mcp)', () => {
  it('initializes, pages tools, calls (JSON and SSE replies), pings and closes', async () => {
    const s = await connectMcp(client(), { clientInfo: { name: 'test', version: '1' } });
    expect(s.id).toBe('sid-1');
    expect(s.info?.serverInfo.name).toBe('mcp-gateway');
    expect(seen.some((x) => x.body?.method === 'notifications/initialized')).toBe(true);
    expect((await s.listTools()).map((t) => t.name)).toEqual(['t1', 't2']);
    const last = seen[seen.length - 1]!;
    expect(last.headers['mcp-session-id']).toBe('sid-1');
    expect(last.headers['mcp-protocol-version']).toBe('2025-06-18');
    expect((await s.callTool('x')).content![0]!.text).toBe('sse');
    await expect(s.callTool('nope')).rejects.toBeInstanceOf(McpError);
    await s.ping();
    await s.close();
    expect(s.id).toBeUndefined();
    await expect(s.ping()).rejects.toThrow(/Not connected/);
  });

  it('sends notifications/cancelled when a call is aborted', async () => {
    cancelled = [];
    const s = await connectMcp(client());
    const ac = new AbortController();
    const p = s.callTool('slow', {}, { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 100));
    expect(cancelled).toHaveLength(1);
  });
});
