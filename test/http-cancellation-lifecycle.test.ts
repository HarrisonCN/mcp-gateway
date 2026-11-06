import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpProxy, ERR_CANCELLED, ERR_TIMEOUT } from '../src/proxy/index.js';
import { StreamableHttpChannel } from '../src/transport/streamable-http.js';
import type { JsonRpcMessage } from '../src/transport/channel.js';

let server: Server | undefined;
let proxy: McpProxy | undefined;
let channel: StreamableHttpChannel | undefined;

afterEach(async () => {
  await proxy?.disconnectAll();
  await channel?.close();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
  server = undefined;
  proxy = undefined;
  channel = undefined;
});

async function upstream(callBody: 'sse' | 'error', controlBody: 'headers' | 'error' = 'headers') {
  const state = { calls: [] as string[], requestClosed: false, controlSeen: false, controlClosed: false };
  const app = express();
  app.use(express.json());
  app.get('/mcp', (_request, response) => { response.sendStatus(405); });
  app.post('/mcp', (request, response) => {
    const message = request.body as JsonRpcMessage;
    if (message.method === 'notifications/cancelled' || message.method === undefined) {
      state.controlSeen = true;
      response.on('close', () => { state.controlClosed = true; });
      if (controlBody === 'error') {
        response.writeHead(503, { 'Content-Type': 'text/plain' });
        response.write('unavailable');
      }
      return;
    }
    if (message.method === 'initialize') {
      response.json({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'lifecycle', version: '1' } } });
      return;
    }
    if (message.method === 'tools/list') {
      response.json({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'hang' }, { name: 'echo' }] } });
      return;
    }
    if (message.method === 'tools/call') {
      const name = (message.params as { name: string }).name;
      state.calls.push(name);
      if (name === 'hang') {
        response.on('close', () => { state.requestClosed = true; });
        response.writeHead(callBody === 'error' ? 503 : 200, { 'Content-Type': callBody === 'error' ? 'text/plain' : 'text/event-stream' });
        response.write(callBody === 'error' ? 'unavailable' : ': waiting\n\n');
        return;
      }
      response.json({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'echo' }] } });
      return;
    }
    response.sendStatus(202);
  });
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const config = { id: 'remote', name: 'remote', transport: 'streamable-http' as const, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, timeout: 500 };
  return { state, config };
}

describe('Streamable HTTP cancellation resources', () => {
  describe.each(['sse', 'error'] as const)('%s response body', (body) => {
    it.each(['abort', 'timeout'] as const)('releases an abandoned call and a stalled cancellation POST on %s', async (reason) => {
      const { state, config } = await upstream(body);
      proxy = new McpProxy();
      await proxy.connect(config);
      const controller = new AbortController();
      const call = proxy.callTool('remote', 'hang', {}, reason === 'timeout' ? 500 : 5000, { signal: controller.signal });
      await vi.waitFor(() => expect(state.calls).toEqual(['hang']));
      if (reason === 'abort') controller.abort();
      expect((await call).error?.code).toBe(reason === 'abort' ? ERR_CANCELLED : ERR_TIMEOUT);
      await vi.waitFor(() => {
        expect(state.requestClosed).toBe(true);
        expect(state.controlSeen).toBe(true);
        expect(state.controlClosed).toBe(true);
      }, { timeout: 2000 });
      expect((await proxy.callTool('remote', 'echo', {})).success).toBe(true);
      expect(state.calls).toEqual(['hang', 'echo']);
    });
  });

  describe.each(['headers', 'error'] as const)('stalled control %s', (body) => {
    it.each([
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
      { jsonrpc: '2.0', id: 'server-request', result: {} },
    ] as JsonRpcMessage[])('bounds a control POST without losing the channel ($method)', async (message) => {
      const { state, config } = await upstream('sse', body);
      channel = new StreamableHttpChannel(config, { connectTimeoutMs: 500, killGraceMs: 100 });
      channel.onclose = vi.fn();
      let failure: unknown;
      void channel.send(message).catch((error) => { failure = error; });
      await vi.waitFor(() => expect(failure).toBeInstanceOf(Error), { timeout: 2000 });
      await vi.waitFor(() => expect(state.controlClosed).toBe(true));
      expect(channel.onclose).not.toHaveBeenCalled();
      await expect(channel.send({ jsonrpc: '2.0', id: 2, method: 'ping' })).resolves.toBeUndefined();
    });
  });
});
