import { describe, it, expect, afterEach } from 'vitest';
import { McpProxy, ERR_TIMEOUT } from '../src/proxy/index.js';
import type { McpServerConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';
import { SseParser, type SseEvent } from '../src/transport/sse-parser.js';
import {
  startSseServer,
  startStreamableHttpServer,
  startWebSocketServer,
  stats,
  type RemoteServer,
} from './fixtures/remote-servers.js';

logger.setLevel('error');

let proxy: McpProxy | undefined;
let remote: RemoteServer | undefined;
afterEach(async () => {
  await proxy?.disconnectAll();
  await remote?.close();
  proxy = undefined;
  remote = undefined;
});

const cfg = (over: Partial<McpServerConfig>): McpServerConfig => ({
  id: 'remote',
  name: 'Remote',
  transport: 'streamable-http',
  timeout: 5000,
  ...over,
});

const text = (r: { result?: unknown }) => (r.result as { content: Array<{ text: string }> }).content[0]!.text;

const waitFor = async (pred: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('SseParser', () => {
  it('handles events, comments, CRLF and chunk splits anywhere', () => {
    const events: SseEvent[] = [];
    const p = new SseParser((e) => events.push(e));
    const raw = ': keep-alive\r\nevent: endpoint\r\ndata: /messages?sessionId=1\r\n\r\ndata: {"a":\r\ndata: 1}\n\nid: 7\ndata:x\n\n';
    for (const ch of raw) p.push(ch); // worst case: one character per chunk
    expect(events).toEqual([
      { event: 'endpoint', data: '/messages?sessionId=1' },
      { event: 'message', data: '{"a":\n1}' },
      { event: 'message', data: 'x', id: '7' },
    ]);
  });
});

describe('Streamable HTTP transport (official SDK server)', () => {
  it('initializes a session, lists tools and calls one', async () => {
    remote = await startStreamableHttpServer();
    proxy = new McpProxy();
    const tools = await proxy.connect(cfg({ url: remote.url }));
    expect(tools.map((t) => t.name).sort()).toEqual(['add-tool', 'echo', 'slow']);
    const r = await proxy.callTool('remote', 'echo', { msg: 'hi' });
    expect(r.success).toBe(true);
    expect(text(r)).toBe('echo:hi');
    const info = proxy.getSessionInfo('remote')!;
    expect(info.transport).toBe('streamable-http');
    expect(info.protocolVersion).toBeTruthy();
    expect(info.serverInfo?.name).toBe('sdk-test-server');
    // Session id and negotiated protocol version are echoed after initialize
    const last = remote.seenHeaders.at(-1)!;
    expect(last['mcp-session-id']).toBeTruthy();
    expect(last['mcp-protocol-version']).toBe(info.protocolVersion);
  });

  it('sends configured headers with ${VAR} expansion', async () => {
    process.env.TEST_REMOTE_TOKEN = 's3cret';
    remote = await startStreamableHttpServer({ requireHeader: ['authorization', 'Bearer s3cret'] });
    proxy = new McpProxy();
    await expect(proxy.connect(cfg({ url: remote.url }))).rejects.toThrow(/401/);
    const tools = await proxy.connect(cfg({ url: remote.url, headers: { Authorization: 'Bearer ${TEST_REMOTE_TOKEN}' } }));
    expect(tools.length).toBe(3);
  });

  it('times out slow calls and the server sees the cancellation', async () => {
    remote = await startStreamableHttpServer();
    proxy = new McpProxy();
    await proxy.connect(cfg({ url: remote.url }));
    const before = stats.cancelled;
    const r = await proxy.callTool('remote', 'slow', { ms: 3000 }, 150);
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe(ERR_TIMEOUT);
    await waitFor(() => stats.cancelled > before);
    // still usable afterwards
    expect((await proxy.callTool('remote', 'echo', { msg: 'x' })).success).toBe(true);
  });

  it('answers ping for health checks', async () => {
    remote = await startStreamableHttpServer();
    proxy = new McpProxy();
    await proxy.connect(cfg({ url: remote.url }));
    expect(await proxy.ping('remote')).toBeGreaterThanOrEqual(0);
  });

  it('reports an expired session (HTTP 404) as a disconnect', async () => {
    remote = await startStreamableHttpServer();
    proxy = new McpProxy();
    await proxy.connect(cfg({ url: remote.url }));
    const lost: string[] = [];
    proxy.on('disconnected', (id: string) => lost.push(id));
    await remote.dropSessions();
    const r = await proxy.callTool('remote', 'echo', { msg: 'x' });
    expect(r.success).toBe(false);
    expect(lost).toEqual(['remote']);
    expect(proxy.isConnected('remote')).toBe(false);
  });

  it('fails clearly when nothing listens', async () => {
    proxy = new McpProxy();
    await expect(proxy.connect(cfg({ url: 'http://127.0.0.1:1/mcp' }))).rejects.toThrow(/failed/);
    expect(proxy.isConnected('remote')).toBe(false);
  });
});

describe('HTTP+SSE transport (official SDK server)', () => {
  it('connects via the endpoint event, calls tools and follows list_changed', async () => {
    remote = await startSseServer();
    proxy = new McpProxy();
    const tools = await proxy.connect(cfg({ transport: 'sse', url: remote.url }));
    expect(tools.map((t) => t.name).sort()).toEqual(['add-tool', 'echo', 'slow']);
    const r = await proxy.callTool('remote', 'echo', { msg: 'sse' });
    expect(text(r)).toBe('echo:sse');

    const changed: string[][] = [];
    proxy.on('tools-changed', (_id: string, t: Array<{ name: string }>) => changed.push(t.map((x) => x.name)));
    await proxy.callTool('remote', 'add-tool', {});
    await waitFor(() => changed.length > 0);
    expect(changed[0]).toContain('late');
  });

  it('rejects an endpoint on another origin', async () => {
    remote = await startSseServer({ endpointOverride: 'http://evil.example/steal' });
    proxy = new McpProxy();
    await expect(proxy.connect(cfg({ transport: 'sse', url: remote.url }))).rejects.toThrow(/origin/);
  });

  it('reports a dropped stream as a disconnect', async () => {
    remote = await startSseServer();
    proxy = new McpProxy();
    await proxy.connect(cfg({ transport: 'sse', url: remote.url }));
    const lost: string[] = [];
    proxy.on('disconnected', (id: string) => lost.push(id));
    await remote.dropSessions();
    await waitFor(() => lost.length > 0);
    expect(proxy.isConnected('remote')).toBe(false);
  });
});

describe('WebSocket transport', () => {
  it('connects with the mcp subprotocol, forwards headers and calls tools', async () => {
    remote = await startWebSocketServer();
    proxy = new McpProxy();
    const tools = await proxy.connect(cfg({ transport: 'websocket', url: remote.url, headers: { 'x-token': 'abc' } }));
    expect(tools.map((t) => t.name)).toContain('echo');
    expect(remote.seenHeaders[0]!['x-token']).toBe('abc');
    expect(remote.seenHeaders[0]!['sec-websocket-protocol']).toBe('mcp');
    const r = await proxy.callTool('remote', 'echo', { msg: 'ws' });
    expect(text(r)).toBe('echo:ws');
  });

  it('follows list_changed notifications', async () => {
    remote = await startWebSocketServer();
    proxy = new McpProxy();
    await proxy.connect(cfg({ transport: 'websocket', url: remote.url }));
    const changed: string[][] = [];
    proxy.on('tools-changed', (_id: string, t: Array<{ name: string }>) => changed.push(t.map((x) => x.name)));
    await proxy.callTool('remote', 'add-tool', {});
    await waitFor(() => changed.length > 0);
    expect(changed[0]).toContain('late');
  });

  it('reports a closed socket as a disconnect and rejects in-flight calls', async () => {
    remote = await startWebSocketServer();
    proxy = new McpProxy();
    await proxy.connect(cfg({ transport: 'websocket', url: remote.url }));
    const lost: string[] = [];
    proxy.on('disconnected', (id: string) => lost.push(id));
    const inflight = proxy.callTool('remote', 'slow', { ms: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    await remote.dropSessions();
    const r = await inflight;
    expect(r.success).toBe(false);
    await waitFor(() => lost.length > 0);
    expect(proxy.isConnected('remote')).toBe(false);
  });

  it('intentional disconnect does not emit "disconnected"', async () => {
    remote = await startWebSocketServer();
    proxy = new McpProxy();
    await proxy.connect(cfg({ transport: 'websocket', url: remote.url }));
    const lost: string[] = [];
    proxy.on('disconnected', (id: string) => lost.push(id));
    await proxy.disconnect('remote');
    await new Promise((r) => setTimeout(r, 50));
    expect(lost).toEqual([]);
  });
});
