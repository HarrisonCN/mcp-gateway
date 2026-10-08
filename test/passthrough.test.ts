/**
 * 3.1: sampling / elicitation / roots passthrough — upstream servers' requests reach the downstream MCP client
 * that made the call, through the official SDK client.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CreateMessageRequestSchema, ElicitRequestSchema, ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Gateway } from '../src/gateway/index.js';
import { validateConfig } from '../src/config/loader.js';
import { passthroughCapabilities, PASSTHROUGH_METHODS } from '../src/proxy/index.js';
import type { GatewayConfig, McpServerConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/passthrough-server.mjs', import.meta.url));
const server = (id = 'pt', extra: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id,
  name: id,
  transport: 'stdio',
  command: process.execPath,
  args: [fixture],
  timeout: 5000,
  ...extra,
});
const base = (extra: Partial<GatewayConfig> = {}): GatewayConfig => ({
  port: 0,
  host: '127.0.0.1',
  logLevel: 'error',
  monitor: { requestLog: false },
  servers: [server()],
  ...extra,
});

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

async function client(url: string, caps: Record<string, unknown>) {
  const c = new Client({ name: 'pt-test', version: '1.0.0' }, { capabilities: caps });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  clients.push(c);
  return c;
}
const text = (r: any) => r.content?.[0]?.text as string;

describe('passthrough capabilities', () => {
  it('maps relayed methods to client capabilities', () => {
    expect(passthroughCapabilities(PASSTHROUGH_METHODS)).toEqual({ sampling: {}, elicitation: {}, roots: { listChanged: true } });
    expect(passthroughCapabilities([])).toEqual({});
  });

  it('validates mcp.passthrough and servers[].passthrough', () => {
    expect(() => validateConfig({ servers: [], mcp: { passthrough: { sampling: false, timeoutSeconds: 30 } } })).not.toThrow();
    expect(() => validateConfig({ servers: [], mcp: { passthrough: { nope: true } } })).toThrow();
    expect(() => validateConfig({ servers: [{ id: 'a', name: 'a', transport: 'stdio', command: 'x', passthrough: false }] })).not.toThrow();
  });
});

describe('/mcp: sampling, elicitation and roots reach the calling client', () => {
  it('announces the client capabilities upstream', async () => {
    const url = await start(base());
    const c = await client(url, {});
    const caps = JSON.parse(text(await c.callTool({ name: 'client_caps', arguments: {} })));
    expect(caps).toEqual({ sampling: {}, elicitation: {}, roots: { listChanged: true } });
  });

  it('relays sampling/createMessage and returns the client answer to the server', async () => {
    const url = await start(base());
    const c = await client(url, { sampling: {} });
    let seen: any;
    c.setRequestHandler(CreateMessageRequestSchema, async (req) => {
      seen = req.params;
      return { role: 'assistant', content: { type: 'text', text: 'pong from the client LLM' }, model: 'test-model' };
    });
    const r = await c.callTool({ name: 'ask_llm', arguments: { prompt: 'ping' } });
    expect(JSON.parse(text(r))).toMatchObject({ model: 'test-model', content: { text: 'pong from the client LLM' } });
    expect(seen.messages[0].content.text).toBe('ping');
    // The gateway's own upstream progress token is not leaked to the client.
    expect(seen._meta?.progressToken).toBeUndefined();
  });

  it('relays elicitation/create and roots/list', async () => {
    const url = await start(base());
    const c = await client(url, { elicitation: {}, roots: { listChanged: true } });
    c.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: { name: 'Ada' } }));
    c.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: 'file:///work', name: 'work' }] }));
    expect(JSON.parse(text(await c.callTool({ name: 'ask_user', arguments: {} })))).toEqual({ action: 'accept', content: { name: 'Ada' } });
    expect(JSON.parse(text(await c.callTool({ name: 'list_roots', arguments: {} })))).toEqual({ roots: [{ uri: 'file:///work', name: 'work' }] });
    await c.sendRootsListChanged();
    let n = '0';
    for (let i = 0; i < 40 && n === '0'; i++) {
      await new Promise((r) => setTimeout(r, 25));
      n = text(await c.callTool({ name: 'roots_changed', arguments: {} }));
    }
    expect(n).toBe('1');
  });

  it('answers "not supported" when the client lacks the capability, and an empty root list', async () => {
    const url = await start(base());
    const c = await client(url, {});
    const r = JSON.parse(text(await c.callTool({ name: 'ask_llm', arguments: {} })));
    expect(r.error.message).toMatch(/does not support sampling/);
    expect(JSON.parse(text(await c.callTool({ name: 'list_roots', arguments: {} })))).toEqual({ roots: [] });
  });

  it('REST calls have no MCP client to relay to', async () => {
    const url = await start(base());
    const r = await fetch(`${url}/api/v1/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'ask_llm', server: 'pt', arguments: {} }) });
    const body = (await r.json()) as any;
    expect(JSON.parse(body.result.content[0].text).error.message).toMatch(/No MCP client/);
  });

  it('can be switched off per feature (mcp.passthrough) and per server', async () => {
    const url = await start(base({ mcp: { passthrough: { sampling: false } }, servers: [server('pt'), server('iso', { passthrough: false })] }));
    const c = await client(url, { sampling: {}, elicitation: {} });
    c.setRequestHandler(CreateMessageRequestSchema, async () => ({ role: 'assistant', content: { type: 'text', text: 'x' }, model: 'm' }));
    c.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'decline' }));
    expect(JSON.parse(text(await c.callTool({ name: 'pt__client_caps', arguments: {} })))).toEqual({ elicitation: {}, roots: { listChanged: true } });
    expect(JSON.parse(text(await c.callTool({ name: 'iso__client_caps', arguments: {} })))).toEqual({});
    expect(JSON.parse(text(await c.callTool({ name: 'pt__ask_llm', arguments: {} }))).error.code).toBe(-32601);
    expect(JSON.parse(text(await c.callTool({ name: 'pt__ask_user', arguments: {} })))).toEqual({ action: 'decline' });
    expect(JSON.parse(text(await c.callTool({ name: 'iso__ask_user', arguments: {} }))).error.code).toBe(-32601);
  });

  it('without an echoed token, routes only when all in-flight calls come from one client', async () => {
    const url = await start(base({ servers: [server('pt', { env: { NO_TOKEN: '1', ASK_DELAY_MS: '300' } })] }));
    const mk = async (answer: string) => {
      const c = await client(url, { sampling: {} });
      c.setRequestHandler(CreateMessageRequestSchema, async () => ({ role: 'assistant', content: { type: 'text', text: answer }, model: 'm' }));
      return c;
    };
    const a = await mk('from A');
    expect(JSON.parse(text(await a.callTool({ name: 'ask_llm', arguments: {} }))).content.text).toBe('from A');
    const b = await mk('from B');
    const [ra, rb] = await Promise.all([a.callTool({ name: 'ask_llm', arguments: {} }), b.callTool({ name: 'ask_llm', arguments: {} })]);
    // Ambiguous while both are in flight: a request is refused rather than sent to the other client.
    const outcome = (r: any, own: string) => {
      const v = JSON.parse(text(r));
      if (v.error) return expect(v.error.message).toMatch(/No MCP client/), 'refused';
      expect(v.content.text).toBe(own);
      return 'own';
    };
    const results = [outcome(ra, 'from A'), outcome(rb, 'from B')];
    expect(results).toContain('refused');
  });
});
