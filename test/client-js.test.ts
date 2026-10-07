// Integration test: the JS client package (clients/js) against a real gateway.
import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { GatewayClient, GatewayError, connectMcp, McpError } from '../clients/js/src/index.js';
import { Gateway } from '../src/gateway/index.js';
import type { McpServerConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
const stdio = (id: string, env: Record<string, string> = {}): McpServerConfig => ({
  id, name: id, transport: 'stdio', command: process.execPath, args: [fixture], env, timeout: 3000,
});

let gw: Gateway | undefined;
afterEach(async () => {
  await gw?.stop();
  gw = undefined;
});

async function start() {
  gw = new Gateway({
    port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false },
    auth: { strategy: 'api-key', apiKeys: ['admin', { key: 'scoped', name: 'scoped', servers: ['a'] }] },
    servers: [stdio('a'), stdio('b', { SLOW_MS: '2000' })],
  });
  await gw.start();
  return `http://127.0.0.1:${gw.address()!.port}`;
}

describe('JS client against a real gateway', () => {
  it('REST: health, servers, tools, schemas, calls, errors', async () => {
    const baseUrl = await start();
    const c = new GatewayClient({ baseUrl, apiKey: 'admin' });
    expect((await c.health()).status).toBe('ok');
    expect((await c.ready()).ready).toBe(true);
    expect((await c.servers()).map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect((await c.server('a')).tools.map((t) => t.name)).toEqual(['echo']);
    expect((await c.listTools()).length).toBe(2);
    const r = await c.callTool('echo', { hi: 1 }, { server: 'a' });
    expect(r.server).toBe('a');
    expect(r.result.content![0]!.text).toBe('{"hi":1}');
    const conflict = (await c.callTool('echo').catch((e) => e)) as GatewayError;
    expect(conflict.status).toBe(409);

    const schemas = await c.toolSchemas('openai');
    expect(schemas.tools.map((t: any) => t.function.name)).toEqual(['a__echo', 'b__echo']);
    const viaLlm = await c.callLlmTool(schemas, 'b__echo', JSON.stringify({ z: 3 }));
    expect(viaLlm.server).toBe('b');
    expect((await c.requests(10)).length).toBe(2);
    expect((await c.metrics()).totalRequests).toBe(2);

    const scoped = new GatewayClient({ baseUrl, apiKey: 'scoped' });
    expect((await scoped.listTools()).map((t) => t.serverId)).toEqual(['a']);
    expect(((await scoped.callTool('echo', {}, { server: 'b' }).catch((e) => e)) as GatewayError).status).toBe(403);
  });

  it('MCP helper: initialize, list, call, cancel, close', async () => {
    const baseUrl = await start();
    const s = await connectMcp(new GatewayClient({ baseUrl, apiKey: 'admin' }));
    expect(s.info?.serverInfo.name).toBe('mcp-gateway');
    expect((await s.listTools()).map((t) => t.name)).toEqual(['a__echo', 'b__echo']);
    const r = await s.callTool('a__echo', { q: 1 });
    expect(r.content![0]!.text).toBe('{"q":1}');
    await expect(s.callTool('nope')).rejects.toBeInstanceOf(McpError);
    await s.ping();
    await s.close();
    expect(gw!.getMcpEndpoint()!.getSessions()).toHaveLength(0);
  });
});

describe('JS client: resources, prompts and history (gateway ≥ 0.8)', () => {
  it('lists / reads / gets and pages history', async () => {
    const { startStreamableHttpServer } = await import('./fixtures/remote-servers.js');
    const h = await startStreamableHttpServer();
    try {
      gw = new Gateway({
        port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false },
        servers: [{ id: 'h', name: 'H', transport: 'streamable-http', url: h.url, timeout: 3000 }],
      });
      await gw.start();
      const c = new GatewayClient({ baseUrl: `http://127.0.0.1:${gw.address()!.port}` });
      expect((await c.listResources()).map((r) => r.uri)).toEqual(['docs://readme']);
      expect((await c.listResourceTemplates({ server: 'h' }))[0]!.uriTemplate).toBe('notes://{id}');
      expect((await c.readResource('notes://3')).result.contents[0]!.text).toBe('note 3');
      expect((await c.listPrompts())[0]!.name).toBe('greet');
      const p = await c.getPrompt('greet', { name: 'Zed' });
      expect(JSON.stringify(p.result.messages)).toContain('Hello, Zed!');
      await c.callTool('echo', { msg: 'x' });
      const page1 = await c.history({ limit: 2 });
      expect(page1.source).toBe('memory');
      expect(page1.requests.map((r) => r.kind ?? 'tool')).toEqual(['tool', 'prompt']);
      const page2 = await c.history({ limit: 2, cursor: page1.nextCursor });
      expect(page2.requests.map((r) => r.kind)).toEqual(['resource']);
      expect((await c.history({ kind: 'prompt', since: new Date(0) })).requests).toHaveLength(1);
    } finally {
      await gw?.stop();
      gw = undefined;
      await h.close();
    }
  });
});
