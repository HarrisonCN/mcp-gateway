import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { createEdgeGateway, readRpcReply, workersHandler, serveNode, configFromEnv, serveDeno, serveBun } from '../src/edge/entry.js';

/** Fake Streamable HTTP upstream: sessions, SSE or JSON replies, paging, session expiry. */
function fakeUpstream(opts: { tools: string[]; sse?: boolean; tag: string; failInit?: boolean }) {
  const sessions = new Set<string>();
  let n = 0;
  const calls: string[] = [];
  const f = (async (_url: string | URL | Request, init?: RequestInit) => {
    const msg = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { cursor?: string; name?: string; arguments?: unknown } };
    const h = new Headers(init?.headers);
    calls.push(msg.method);
    const reply = (result: unknown, extra: Record<string, string> = {}) => {
      const body = { jsonrpc: '2.0', id: msg.id, result };
      return opts.sse
        ? new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\nevent: message\ndata: ${JSON.stringify(body)}\n\n`, { headers: { 'content-type': 'text/event-stream', ...extra } })
        : new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...extra } });
    };
    if (msg.method === 'initialize') {
      if (opts.failInit) return new Response('nope', { status: 500 });
      const sid = `s${++n}`;
      sessions.add(sid);
      return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: opts.tag, version: '1' } }, { 'mcp-session-id': sid });
    }
    if (!sessions.has(h.get('mcp-session-id') ?? '')) return new Response('', { status: 404 });
    if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (msg.method === 'tools/list') {
      const page = msg.params?.cursor ? 1 : 0;
      const tools = opts.tools.slice(page, page + 1).map((name) => ({ name, inputSchema: { type: 'object' } }));
      return reply({ tools, ...(page + 1 < opts.tools.length ? { nextCursor: 'p2' } : {}) });
    }
    if (msg.method === 'tools/call') {
      if (msg.params?.name === 'fail') return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32010, message: 'tool broke' } }), { headers: { 'content-type': 'application/json' } });
      return reply({ content: [{ type: 'text', text: `${opts.tag}:${msg.params?.name}:${JSON.stringify(msg.params?.arguments)}` }] });
    }
    return reply({});
  }) as unknown as typeof fetch;
  return { f, sessions, calls };
}

function gateway(extra: Partial<Parameters<typeof createEdgeGateway>[0]> = {}) {
  const a = fakeUpstream({ tools: ['echo', 'fail'], tag: 'A', sse: true });
  const b = fakeUpstream({ tools: ['echo', 'only_b'], tag: 'B' });
  const f = ((url: string | URL | Request, init?: RequestInit) => (String(url).includes('a.example') ? a.f(url, init) : b.f(url, init))) as typeof fetch;
  const gw = createEdgeGateway({
    servers: [
      { id: 'a', url: 'https://a.example/mcp' },
      { id: 'b', url: 'https://b.example/mcp', tools: { deny: ['secret*'] } },
    ],
    fetch: f,
    ...extra,
  });
  return { gw, a, b };
}

const rpc = (gw: ReturnType<typeof createEdgeGateway>, body: unknown, headers: Record<string, string> = {}) =>
  gw.fetch(new Request('https://edge.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));

describe('edge gateway', () => {
  it('serves /mcp: initialize, ping, aggregated tools/list with collision prefixes, tools/call', async () => {
    const { gw, b } = gateway();
    const init = (await (await rpc(gw, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })).json()) as { result: { protocolVersion: string } };
    expect(init.result.protocolVersion).toBe('2025-03-26');
    expect((await rpc(gw, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    const list = (await (await rpc(gw, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((t) => t.name).sort()).toEqual(['a__echo', 'b__echo', 'fail', 'only_b']);
    const call = (await (await rpc(gw, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'b__echo', arguments: { x: 1 } } })).json()) as { result: { content: Array<{ text: string }> } };
    expect(call.result.content[0]!.text).toBe('B:echo:{"x":1}');
    const batch = (await (await rpc(gw, [{ jsonrpc: '2.0', id: 4, method: 'ping' }, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'fail' } }, { jsonrpc: '2.0', id: 6, method: 'nope' }])).json()) as Array<{ id: number; error?: { code: number } }>;
    expect(batch.map((m) => [m.id, m.error?.code])).toEqual([[4, undefined], [5, -32010], [6, -32601]]);
    expect(((await (await rpc(gw, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'zzz' } })).json()) as { error: { code: number } }).error.code).toBe(-32602);
    expect(b.calls.filter((c) => c === 'initialize')).toHaveLength(1); // session reused
    // upstream session expiry → re-initialize once
    b.sessions.clear();
    gw.upstreams.get('b')!['toolsCache' as never] = undefined as never;
    expect((await rpc(gw, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'only_b' } })).status).toBe(200);
    expect(b.calls.filter((c) => c === 'initialize')).toHaveLength(2);
    // protocol errors
    expect((await gw.fetch(new Request('https://e/mcp', { method: 'POST', body: '{' }))).status).toBe(400);
    expect((await gw.fetch(new Request('https://e/mcp', { method: 'POST', body: '[]' }))).status).toBe(400);
    expect((await gw.fetch(new Request('https://e/mcp'))).status).toBe(405);
    expect((await gw.fetch(new Request('https://e/mcp', { method: 'DELETE' }))).status).toBe(204);
    expect((await gw.fetch(new Request('https://e/mcp', { method: 'PUT' }))).status).toBe(405);
  });

  it('REST subset, prefix naming, auth (plain + sha256), CORS, health with a failing upstream', async () => {
    const digest = 'sha256:' + Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('hashed'))).toString('hex');
    const { gw } = gateway({ apiKeys: ['plain', digest], toolNaming: 'prefix', corsOrigins: ['https://app.example'] });
    expect((await gw.fetch(new Request('https://e/api/v1/tools'))).status).toBe(401);
    expect((await gw.fetch(new Request('https://e/api/v1/tools', { headers: { authorization: 'Bearer wrong' } }))).status).toBe(401);
    expect((await gw.fetch(new Request('https://e/api/v1/health/live'))).status).toBe(200);
    const tools = (await (await gw.fetch(new Request('https://e/api/v1/tools?server=a', { headers: { authorization: 'Bearer hashed', origin: 'https://app.example' } }))).json()) as { tools: Array<{ exposedName: string }> };
    expect(tools.tools.map((t) => t.exposedName)).toEqual(['a__echo', 'a__fail']);
    const callRes = await gw.fetch(new Request('https://e/api/v1/tools/call', { method: 'POST', headers: { 'x-api-key': 'plain', origin: 'https://app.example' }, body: JSON.stringify({ tool: 'echo', server: 'a', arguments: { y: 2 } }) }));
    expect(callRes.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(await callRes.json()).toMatchObject({ server: 'a', tool: 'echo', result: { content: [{ text: 'A:echo:{"y":2}' }] } });
    const H = { authorization: 'Bearer plain' };
    expect((await gw.fetch(new Request('https://e/api/v1/tools/call', { method: 'POST', headers: H, body: '{}' }))).status).toBe(400);
    expect((await gw.fetch(new Request('https://e/api/v1/tools/call', { method: 'POST', headers: H, body: 'x' }))).status).toBe(400);
    expect((await gw.fetch(new Request('https://e/api/v1/tools/call', { method: 'POST', headers: H, body: JSON.stringify({ tool: 'zzz' }) }))).status).toBe(404);
    expect((await gw.fetch(new Request('https://e/api/v1/tools/call', { method: 'POST', headers: H, body: JSON.stringify({ tool: 'a__fail' }) }))).status).toBe(502);
    expect((await gw.fetch(new Request('https://e/nope', { headers: H }))).status).toBe(404);
    expect((await gw.fetch(new Request('https://e/', { method: 'GET' }))).status).toBe(200);
    expect((await gw.fetch(new Request('https://e/mcp', { method: 'OPTIONS' }))).status).toBe(204);

    const bad = fakeUpstream({ tools: [], tag: 'X', failInit: true });
    const h = createEdgeGateway({ servers: [{ id: 'x', url: 'https://x/mcp' }], fetch: bad.f });
    const health = await h.fetch(new Request('https://e/api/v1/health'));
    expect(health.status).toBe(207);
    expect(await health.json()).toMatchObject({ status: 'unhealthy', servers: { offline: 1 } });
  });

  it('readRpcReply handles JSON arrays and SSE without a match', async () => {
    expect(await readRpcReply(new Response('[{"id":2,"result":1}]', { headers: { 'content-type': 'application/json' } }), 2)).toMatchObject({ result: 1 });
    await expect(readRpcReply(new Response('data: {"id":9,"result":1}\n\n', { headers: { 'content-type': 'text/event-stream' } }), 1)).rejects.toThrow(/No response/);
    await expect(readRpcReply(new Response('{"id":9}', { headers: { 'content-type': 'application/json' } }), 1)).rejects.toThrow(/No matching/);
  });

  it('adapters: Workers handler, env config, Node server; Deno / Bun need their runtime', async () => {
    const env = { MCP_GATEWAY_SERVERS: JSON.stringify([{ id: 'a', url: 'https://a.example/mcp' }]), MCP_GATEWAY_API_KEYS: 'k1, k2', MCP_GATEWAY_TOOL_NAMING: 'prefix', MCP_GATEWAY_CORS_ORIGINS: '*' };
    expect(configFromEnv(env)).toMatchObject({ servers: [{ id: 'a' }], apiKeys: ['k1', 'k2'], toolNaming: 'prefix', corsOrigins: ['*'] });
    expect(() => configFromEnv({ MCP_GATEWAY_SERVERS: '{}' })).toThrow(/JSON array/);
    const up = fakeUpstream({ tools: ['echo'], tag: 'W' });
    const worker = workersHandler((e) => ({ ...configFromEnv(e), fetch: up.f }));
    const r = await worker.fetch(new Request('https://w/api/v1/tools', { headers: { authorization: 'Bearer k1' } }), env);
    expect(((await r.json()) as { total: number }).total).toBe(1);
    expect(() => serveDeno({ servers: [] })).toThrow(/Deno/);
    expect(() => serveBun({ servers: [] })).toThrow(/Bun/);
    const node = await serveNode({ servers: [{ id: 'a', url: 'https://a.example/mcp' }], fetch: up.f });
    try {
      const res = await fetch(`http://127.0.0.1:${node.port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
      expect(((await res.json()) as { result: { tools: unknown[] } }).result.tools).toHaveLength(1);
    } finally {
      await node.close();
    }
  });

  it('imports no Node built-ins (except the lazy node:http in serveNode)', () => {
    for (const f of ['index.ts', 'adapters.ts', 'entry.ts']) {
      const src = readFileSync(new URL(`../src/edge/${f}`, import.meta.url), 'utf8');
      expect(src).not.toMatch(/from ['"](node:)?(fs|path|http|https|child_process|crypto|net|os|url|events)['"]/);
    }
  });
});
