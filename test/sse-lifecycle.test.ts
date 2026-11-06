import { spawn } from 'node:child_process';
import { createServer, type Server, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SseChannel } from '../src/transport/sse.js';

let server: Server | undefined;
let channel: SseChannel | undefined;

afterEach(async () => {
  await channel?.close();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
  server = undefined;
  channel = undefined;
});

async function listen(handler: RequestListener): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/sse`;
}

function connect(url: string, timeout = 100): SseChannel {
  channel = new SseChannel({ id: 'sse', name: 'SSE', transport: 'sse', url }, { connectTimeoutMs: timeout, killGraceMs: 100 });
  return channel;
}

describe('SSE startup lifecycle', () => {
  it('catches the startup timeout and closes the request when the upstream never returns headers', async () => {
    let closed = false;
    const url = await listen((_request, response) => {
      response.on('close', () => { closed = true; });
    });
    const source = new URL('../src/transport/sse.ts', import.meta.url).href;
    const script = `
      import { SseChannel } from ${JSON.stringify(source)};
      const channel = new SseChannel(
        { id: 'sse', name: 'SSE', transport: 'sse', url: process.argv[1] },
        { connectTimeoutMs: 500, killGraceMs: 100 },
      );
      try {
        await channel.start();
        process.exitCode = 2;
      } catch (error) {
        process.stdout.write(error.message);
      } finally {
        await channel.close();
      }
    `;
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--unhandled-rejections=strict', '--import', 'tsx', '--input-type=module', '--eval', script, url]);
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk.toString(); });
      child.stderr.on('data', (chunk) => { output += chunk.toString(); });
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
    });
    expect(result.output).toContain('SSE server did not announce an endpoint within 500ms');
    expect(result.code, result.output).toBe(0);
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  it('closes the stream when headers arrive but the endpoint never does', async () => {
    let closed = false;
    const url = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.flushHeaders();
      response.on('close', () => { closed = true; });
    });
    await expect(connect(url).start()).rejects.toThrow('did not announce an endpoint within 100ms');
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  it('rejects startup promptly when closed before the endpoint and suppresses a disconnect notification', async () => {
    let headersSent!: () => void;
    const accepted = new Promise<void>((resolve) => { headersSent = resolve; });
    const url = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.flushHeaders();
      headersSent();
    });
    const current = connect(url, 2000);
    current.onclose = vi.fn();
    const failure = expect(current.start()).rejects.toThrow(/aborted|SSE stream/);
    await accepted;
    await current.close();
    await failure;
    expect(current.onclose).not.toHaveBeenCalled();
  });

  it.each([
    { status: 503, type: 'text/plain', error: 'SSE server returned HTTP 503' },
    { status: 200, type: 'application/json', error: 'unexpected content-type' },
  ])('preserves the startup error for HTTP $status and $type', async ({ status, type, error }) => {
    const url = await listen((_request, response) => {
      response.writeHead(status, { 'Content-Type': type });
      response.end('{}');
    });
    await expect(connect(url).start()).rejects.toThrow(error);
  });

  it('keeps an established stream usable after the startup deadline', async () => {
    const url = await listen((request, response) => {
      if (request.method === 'POST') {
        response.writeHead(202).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('event: endpoint\ndata: /messages\n\n');
    });
    const current = connect(url);
    current.onclose = vi.fn();
    await current.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(current.send({ jsonrpc: '2.0', id: 1, method: 'ping' })).resolves.toBeUndefined();
    expect(current.onclose).not.toHaveBeenCalled();
  });
});
