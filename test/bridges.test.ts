import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { Gateway } from '../src/gateway/index.js';
import { validateConfig } from '../src/config/loader.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));

const base = (extra: Partial<GatewayConfig>): GatewayConfig => ({
  port: 0,
  host: '127.0.0.1',
  logLevel: 'error',
  monitor: { requestLog: false },
  servers: [{ id: 'fake', name: 'fake', transport: 'stdio', command: process.execPath, args: [fixture], timeout: 5000 }],
  ...extra,
});

/** Fake OpenAI-compatible upstream: first asks for the gateway `echo` tool, then answers with the tool result. */
function fakeLlm(): Promise<{ server: Server; url: string; bodies: Array<Record<string, unknown>> }> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as { messages: Array<{ role: string; content?: string }> };
      bodies.push(body as unknown as Record<string, unknown>);
      const toolMsg = body.messages.find((m) => m.role === 'tool');
      const message = toolMsg
        ? { role: 'assistant', content: `got: ${toolMsg.content}` }
        : { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"hello":"world"}' } }] };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message, finish_reason: toolMsg ? 'stop' : 'tool_calls' }] }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies })));
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('bridge config schema', () => {
  it('accepts openai / a2a blocks and rejects unknown keys', () => {
    expect(() => validateConfig({ servers: [], openai: { path: '/oai', maxToolRounds: 3, upstream: { baseUrl: 'https://api.openai.com/v1' } }, a2a: { enabled: true, public: true } })).not.toThrow();
    expect(() => validateConfig({ servers: [], openai: { nope: 1 } })).toThrow();
    expect(() => validateConfig({ servers: [], a2a: { path: 'no-slash' } })).toThrow();
    expect(() => validateConfig({ servers: [], openai: { upstream: { baseUrl: 'not a url' } } })).toThrow();
  });
});

describe('OpenAI-compatible tools proxy', () => {
  let gw: Gateway | undefined;
  let llm: Server | undefined;
  afterEach(async () => {
    await gw?.stop();
    llm?.close();
    gw = undefined;
    llm = undefined;
  });

  it('is off without an openai block', async () => {
    gw = new Gateway(base({}));
    await gw.start();
    const res = await fetch(`http://127.0.0.1:${gw.address()!.port}/openai/v1/tools`);
    expect(res.status).toBe(404);
  });

  it('lists tools, executes tool_calls and runs the chat/completions loop', async () => {
    const up = await fakeLlm();
    llm = up.server;
    gw = new Gateway(base({ openai: { upstream: { baseUrl: up.url, apiKey: 'sk-test' } } }));
    await gw.start();
    const url = `http://127.0.0.1:${gw.address()!.port}/openai/v1`;

    const tools = (await (await fetch(`${url}/tools`)).json()) as { tools: Array<{ type: string; function: { name: string } }>; mapping: Record<string, unknown> };
    expect(tools.tools[0]).toMatchObject({ type: 'function', function: { name: 'echo' } });
    expect(tools.mapping.echo).toEqual({ server: 'fake', tool: 'echo' });

    const tc = (await (await post(`${url}/tool_calls`, { message: { role: 'assistant', tool_calls: [
      { id: 'a', function: { name: 'echo', arguments: '{"x":1}' } },
      { id: 'b', function: { name: 'missing', arguments: '{}' } },
      { id: 'c', function: { name: 'echo', arguments: '{bad' } },
    ] } })).json()) as { messages: Array<{ role: string; tool_call_id: string; content: string }> };
    expect(tc.messages.map((m) => m.tool_call_id)).toEqual(['a', 'b', 'c']);
    expect(tc.messages[0].role).toBe('tool');
    expect(tc.messages[1].content).toContain('Unknown tool');
    expect(tc.messages[2].content).toContain('not valid JSON');
    expect((await post(`${url}/tool_calls`, { nope: true })).status).toBe(400);

    const chat = (await (await post(`${url}/chat/completions`, { model: 'm', messages: [{ role: 'user', content: 'hi' }] })).json()) as {
      choices: Array<{ message: { content: string } }>;
      x_mcp_gateway: { toolRounds: number; toolCallsExecuted: number };
    };
    expect(chat.x_mcp_gateway).toEqual({ toolRounds: 1, toolCallsExecuted: 1 });
    expect(chat.choices[0].message.content.startsWith('got: ')).toBe(true);
    expect(up.bodies).toHaveLength(2);
    expect((up.bodies[0].tools as unknown[]).length).toBeGreaterThan(0);
  });

  it('returns 501 for chat/completions without an upstream and enforces auth', async () => {
    gw = new Gateway(base({ openai: {}, auth: { strategy: 'api-key', apiKeys: ['k1'] } }));
    await gw.start();
    const url = `http://127.0.0.1:${gw.address()!.port}/openai/v1`;
    expect((await fetch(`${url}/tools`)).status).toBe(401);
    const auth = { authorization: 'Bearer k1' };
    expect((await fetch(`${url}/tools`, { headers: auth })).status).toBe(200);
    expect((await post(`${url}/chat/completions`, { messages: [] }, auth)).status).toBe(501);
  });
});

describe('A2A bridge', () => {
  let gw: Gateway | undefined;
  afterEach(async () => {
    await gw?.stop();
    gw = undefined;
  });

  it('serves the agent card and runs skills over JSON-RPC', async () => {
    gw = new Gateway(base({ a2a: { enabled: true, name: 'my-agent', provider: { organization: 'Acme' } } }));
    await gw.start();
    const root = `http://127.0.0.1:${gw.address()!.port}`;
    const card = (await (await fetch(`${root}/.well-known/agent-card.json`)).json()) as { name: string; url: string; skills: Array<{ id: string }>; protocolVersion: string };
    expect(card.name).toBe('my-agent');
    expect(card.url).toBe(`${root}/a2a`);
    expect(card.skills.map((s) => s.id)).toContain('echo');
    expect((await fetch(`${root}/.well-known/agent.json`)).status).toBe(404); // removed in 3.0

    const send = (await (await post(`${root}/a2a`, {
      jsonrpc: '2.0', id: 1, method: 'message/send',
      params: { message: { kind: 'message', role: 'user', messageId: 'm1', parts: [{ kind: 'data', data: { skill: 'echo', arguments: { a: 1 } } }] } },
    })).json()) as { id: number; result: { id: string; status: { state: string }; artifacts: Array<{ parts: Array<{ kind: string }> }> } };
    expect(send.id).toBe(1);
    expect(send.result.status.state).toBe('completed');
    expect(send.result.artifacts[0].parts.some((p) => p.kind === 'data')).toBe(true);

    const got = (await (await post(`${root}/a2a`, { jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: send.result.id } })).json()) as { result: { id: string } };
    expect(got.result.id).toBe(send.result.id);

    const unknown = (await (await post(`${root}/a2a`, {
      jsonrpc: '2.0', id: 3, method: 'message/send',
      params: { message: { parts: [{ kind: 'data', data: { skill: 'nope' } }] } },
    })).json()) as { result: { status: { state: string } } };
    expect(unknown.result.status.state).toBe('rejected');

    const bad = (await (await post(`${root}/a2a`, { jsonrpc: '2.0', id: 4, method: 'foo/bar' })).json()) as { error: { code: number } };
    expect(bad.error.code).toBe(-32601);
    const missing = (await (await post(`${root}/a2a`, { jsonrpc: '2.0', id: 5, method: 'tasks/get', params: { id: 'x' } })).json()) as { error: { code: number } };
    expect(missing.error.code).toBe(-32001);
  });

  it('is disabled by default and requires auth for the card unless public', async () => {
    gw = new Gateway(base({}));
    await gw.start();
    expect((await fetch(`http://127.0.0.1:${gw.address()!.port}/.well-known/agent-card.json`)).status).toBe(404);
    await gw.stop();

    gw = new Gateway(base({ a2a: { enabled: true }, auth: { strategy: 'api-key', apiKeys: ['k1'] } }));
    await gw.start();
    const root = `http://127.0.0.1:${gw.address()!.port}`;
    expect((await fetch(`${root}/.well-known/agent-card.json`)).status).toBe(401);
    const card = (await (await fetch(`${root}/.well-known/agent-card.json`, { headers: { authorization: 'Bearer k1' } })).json()) as { security: unknown[] };
    expect(card.security).toEqual([{ bearer: [] }]);
    expect((await post(`${root}/a2a`, { jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'x' } })).status).toBe(401);
  });
});
