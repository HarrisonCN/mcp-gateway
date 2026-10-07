import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  LoggingMessageNotificationSchema,
  ResourceUpdatedNotificationSchema,
  type LoggingMessageNotification,
} from '@modelcontextprotocol/sdk/types.js';
import { Gateway } from '../src/gateway/index.js';
import type { GatewayConfig, McpServerConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';
import { McpProxy } from '../src/proxy/index.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
const stdio = (id: string, env: Record<string, string> = {}): McpServerConfig => ({
  id,
  name: id,
  transport: 'stdio',
  command: process.execPath,
  args: [fixture],
  env,
  timeout: 3000,
});
const feat = (id = 'feat') => stdio(id, { FEATURES: '1' });

const base: GatewayConfig = {
  port: 0,
  host: '127.0.0.1',
  logLevel: 'error',
  monitor: { requestLog: false },
  reconnect: { initialDelayMs: 30, maxDelayMs: 200, jitter: 0 },
  servers: [],
};

let gw: Gateway | undefined;
let clients: Client[] = [];
afterEach(async () => {
  for (const c of clients) await c.close().catch(() => {});
  clients = [];
  await gw?.stop();
  gw = undefined;
});

async function start(config: GatewayConfig): Promise<string> {
  gw = new Gateway(config);
  await gw.start();
  return `http://127.0.0.1:${gw.address()!.port}`;
}

async function sdkClient(url: string) {
  const client = new Client({ name: 'feature-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`));
  await client.connect(transport);
  clients.push(client);
  return client;
}

const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const text = (r: any) => r.content?.[0]?.text;

describe('/mcp: advertised capabilities', () => {
  it('announces logging, completions and resource subscriptions', async () => {
    const url = await start({ ...base, servers: [feat()] });
    const c = await sdkClient(url);
    const caps = c.getServerCapabilities()!;
    expect(caps.logging).toEqual({});
    expect(caps.completions).toEqual({});
    expect(caps.resources).toMatchObject({ subscribe: true, listChanged: true });
  });
});

describe('/mcp: progress notifications', () => {
  it('streams upstream progress to the caller as SSE, with the caller\'s token', async () => {
    const url = await start({ ...base, servers: [feat()] });
    const c = await sdkClient(url);
    const updates: Array<{ progress: number; total?: number; message?: string }> = [];
    const r = await c.callTool({ name: 'progress', arguments: {} }, undefined, { onprogress: (p) => updates.push(p) });
    expect(text(r)).toBe('done');
    expect(updates.map((u) => u.progress)).toEqual([1, 2, 3]);
    expect(updates[0]).toMatchObject({ total: 3, message: 'step 1' });
  });

  it('answers with plain JSON when the client sends no token or does not accept SSE', async () => {
    const url = await start({ ...base, servers: [feat()] });
    const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const init = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } }),
    });
    const sid = init.headers.get('mcp-session-id')!;
    const call = async (accept: string, meta?: unknown) => {
      const r = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: { ...H, accept, 'mcp-session-id': sid },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'progress', arguments: {}, ...(meta ? { _meta: meta } : {}) } }),
      });
      return { type: r.headers.get('content-type'), body: await r.text() };
    };
    const noToken = await call('application/json, text/event-stream');
    expect(noToken.type).toMatch(/application\/json/);
    expect(JSON.parse(noToken.body).result.content[0].text).toBe('no-token');
    const noSse = await call('application/json', { progressToken: 'p1' });
    expect(noSse.type).toMatch(/application\/json/);
    const sse = await call('text/event-stream, application/json', { progressToken: 'p1' });
    expect(sse.type).toMatch(/text\/event-stream/);
    const events = sse.body
      .split('\n\n')
      .filter((e) => e.includes('data: '))
      .map((e) => JSON.parse(e.slice(e.indexOf('data: ') + 6)));
    expect(events.filter((e) => e.method === 'notifications/progress').map((e) => e.params.progressToken)).toEqual(['p1', 'p1', 'p1']);
    expect(events[events.length - 1]).toMatchObject({ id: 2, result: { content: [{ text: 'done' }] } });
  });

  it('proxy: progress tokens are rewritten per request and stripped after completion', async () => {
    const proxy = new McpProxy();
    try {
      await proxy.connect(feat('p'));
      const seen: number[] = [];
      const r = await proxy.callTool('p', 'progress', {}, 3000, { onProgress: (u) => seen.push(u.progress) });
      expect(r.success).toBe(true);
      expect(seen).toEqual([1, 2, 3]);
      expect((proxy as any).sessions.get('p').progress.size).toBe(0);
    } finally {
      await proxy.disconnectAll();
    }
  });
});

describe('/mcp: logging', () => {
  it('validates the level, forwards upstream log messages at or above each session level, and sets the upstream level', async () => {
    const url = await start({ ...base, servers: [feat()] });
    const verbose = await sdkClient(url);
    const quiet = await sdkClient(url);
    const silent = await sdkClient(url); // never sets a level: receives nothing
    const got = { verbose: [] as LoggingMessageNotification['params'][], quiet: [] as any[], silent: [] as any[] };
    verbose.setNotificationHandler(LoggingMessageNotificationSchema, (n) => void got.verbose.push(n.params));
    quiet.setNotificationHandler(LoggingMessageNotificationSchema, (n) => void got.quiet.push(n.params));
    silent.setNotificationHandler(LoggingMessageNotificationSchema, (n) => void got.silent.push(n.params));

    await expect(verbose.setLoggingLevel('loud' as any)).rejects.toThrow(/level/);
    await verbose.setLoggingLevel('debug');
    await quiet.setLoggingLevel('error');
    // Give the GET streams a moment to be established.
    await waitFor(() => (gw!.getMcpEndpoint()!.getSessions().filter((s) => s.streams > 0).length ?? 0) >= 3);
    await waitFor(() => (gw!.getMcpEndpoint() as any).upstreamLogLevel.get('feat') === 'debug');

    await verbose.callTool({ name: 'log', arguments: {} });
    await waitFor(() => got.verbose.length >= 3 && got.quiet.length >= 1);
    expect(got.verbose.map((m) => m.data)).toEqual(['dbg', 'inf', { problem: 'err' }]);
    expect(got.verbose[0]!.logger).toBe('feat/fake');
    expect(got.quiet.map((m) => m.level)).toEqual(['error']);
    expect(got.silent).toEqual([]);
  });
});

describe('/mcp: completion', () => {
  it('routes prompt and resource-template completions upstream', async () => {
    const url = await start({ ...base, servers: [feat()] });
    const c = await sdkClient(url);
    const p = await c.complete({ ref: { type: 'ref/prompt', name: 'greet' }, argument: { name: 'lang', value: 'e' } });
    expect(p.completion.values).toEqual(['en', 'es', 'eo']);
    const r = await c.complete({ ref: { type: 'ref/resource', uri: 'live://item/{id}' }, argument: { name: 'id', value: '1' } });
    expect(r.completion.values).toEqual(['1', '10']);
    await expect(c.complete({ ref: { type: 'ref/prompt', name: 'nope' }, argument: { name: 'a', value: '' } })).rejects.toThrow(/Unknown prompt/);
    await expect(c.complete({ ref: { type: 'ref/resource', uri: 'zzz://none' }, argument: { name: 'a', value: '' } })).rejects.toThrow(/not found/i);
  });

  it('returns an empty completion for servers without the capability and validates params', async () => {
    const url = await start({ ...base, servers: [feat()] });
    const ep = gw!.getMcpEndpoint()!;
    const proxy = (ep as any).deps.proxy as McpProxy;
    const orig = proxy.hasCapability.bind(proxy);
    proxy.hasCapability = (id, cap) => (cap === 'completions' ? false : orig(id, cap));
    const c = await sdkClient(url);
    const p = await c.complete({ ref: { type: 'ref/prompt', name: 'greet' }, argument: { name: 'lang', value: 'e' } });
    expect(p.completion).toEqual({ values: [], hasMore: false });
    await expect(c.request({ method: 'completion/complete', params: { ref: { type: 'ref/other' }, argument: { name: 'a', value: '' } } } as any, (await import('@modelcontextprotocol/sdk/types.js')).CompleteResultSchema)).rejects.toThrow(/ref.type/);
  });
});

describe('/mcp: resource subscriptions', () => {
  it('shares one upstream subscription, forwards updates to subscribers only, and cleans up', async () => {
    const url = await start({ ...base, servers: [feat()] });
    const a = await sdkClient(url);
    const b = await sdkClient(url);
    const updates = { a: [] as string[], b: [] as string[] };
    a.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => void updates.a.push(n.params.uri));
    b.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => void updates.b.push(n.params.uri));
    const ep = gw!.getMcpEndpoint()!;
    await waitFor(() => ep.getSessions().filter((s) => s.streams > 0).length >= 2);

    await a.subscribeResource({ uri: 'live://counter' });
    await a.subscribeResource({ uri: 'live://counter' }); // idempotent
    expect(ep.subscriptionCount()).toBe(1);
    const touch = async () => text(await a.callTool({ name: 'touch', arguments: {} }));
    expect(await touch()).toBe('live://counter');
    await waitFor(() => updates.a.length === 1);
    expect(updates.b).toEqual([]);

    await b.subscribeResource({ uri: 'live://counter' });
    expect(ep.subscriptionCount()).toBe(1);
    await a.unsubscribeResource({ uri: 'live://counter' });
    expect(await touch()).toBe('live://counter'); // b still subscribed upstream
    await waitFor(() => updates.b.length === 1);
    expect(updates.a).toHaveLength(1); // a unsubscribed

    await (b.transport as StreamableHTTPClientTransport).terminateSession(); // DELETE ends the session
    await waitFor(() => ep.subscriptionCount() === 0);
    await waitFor(async () => (await touch()) === '');
    await expect(a.subscribeResource({ uri: '' })).rejects.toThrow(/uri/);
  });

  it('re-subscribes upstream after a reconnect', async () => {
    const url = await start({ ...base, servers: [feat()] });
    const a = await sdkClient(url);
    await a.subscribeResource({ uri: 'live://counter' });
    await a.callTool({ name: 'crash', arguments: {} }).catch(() => {});
    const proxy = (gw!.getMcpEndpoint() as any).deps.proxy as McpProxy;
    await waitFor(() => proxy.isConnected('feat'), 8000);
    await waitFor(async () => text(await a.callTool({ name: 'touch', arguments: {} })) === 'live://counter', 8000);
  });

  it('refuses servers that do not support subscriptions', async () => {
    const url = await start({ ...base, servers: [feat()] });
    const proxy = (gw!.getMcpEndpoint() as any).deps.proxy as McpProxy;
    const orig = proxy.getSessionInfo.bind(proxy);
    proxy.getSessionInfo = (id) => {
      const info = orig(id);
      return info && { ...info, capabilities: { ...info.capabilities, resources: {} } };
    };
    const a = await sdkClient(url);
    await expect(a.subscribeResource({ uri: 'live://counter' })).rejects.toThrow(/does not support/);
    await expect(a.subscribeResource({ uri: 'zzz://unknown' })).rejects.toThrow();
  });
});

describe('/mcp: argument size limit', () => {
  it('rejects oversized tools/call and prompts/get arguments', async () => {
    const url = await start({ ...base, servers: [feat()], security: { maxToolArgumentsBytes: 32 } });
    const c = await sdkClient(url);
    await expect(c.callTool({ name: 'echo', arguments: { blob: 'x'.repeat(100) } })).rejects.toThrow(/exceed/);
    await expect(c.getPrompt({ name: 'greet', arguments: { lang: 'x'.repeat(100) } })).rejects.toThrow(/exceed/);
    expect(text(await c.callTool({ name: 'echo', arguments: { a: 1 } }))).toBe('{"a":1}');
  });
});
