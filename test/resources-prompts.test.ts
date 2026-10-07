import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ResourceListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Gateway } from '../src/gateway/index.js';
import { dedupeResources, matchesUriTemplate, routeResource } from '../src/mcp/catalog.js';
import type { GatewayConfig, ResourceInfo } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';
import { startSseServer, startStreamableHttpServer, type RemoteServer } from './fixtures/remote-servers.js';

logger.setLevel('error');

describe('catalog helpers', () => {
  const r = (serverId: string, uri: string): ResourceInfo => ({ serverId, serverName: serverId, uri, name: uri });

  it('dedupes resources by URI, lowest server id first', () => {
    expect(dedupeResources([r('b', 'x://1'), r('a', 'x://1'), r('b', 'x://2')]).map((x) => `${x.serverId}:${x.uri}`)).toEqual([
      'a:x://1',
      'b:x://2',
    ]);
  });

  it('matches RFC 6570 templates', () => {
    expect(matchesUriTemplate('notes://{id}', 'notes://42')).toBe(true);
    expect(matchesUriTemplate('notes://{id}', 'notes://42/x')).toBe(false);
    expect(matchesUriTemplate('file:///{+path}', 'file:///a/b.txt')).toBe(true);
    expect(matchesUriTemplate('search://q{?term,page}', 'search://q?term=a&page=2')).toBe(true);
    expect(matchesUriTemplate('a.b://{x}', 'aXb://1')).toBe(false); // literal dots are escaped
    expect(matchesUriTemplate('x://{/seg}', 'x:///a/b')).toBe(true);
  });

  it('routes by exact URI, then template, then the only resource server', () => {
    const t = [{ serverId: 'b', serverName: 'b', uriTemplate: 'notes://{id}', name: 'n' }];
    expect(routeResource('x://1', [r('a', 'x://1')], t, ['a', 'b'])).toBe('a');
    expect(routeResource('notes://9', [], t, ['a', 'b'])).toBe('b');
    expect(routeResource('other://1', [], [], ['a'])).toBe('a');
    expect(routeResource('other://1', [], [], ['a', 'b'])).toBeUndefined();
  });
});

let gw: Gateway | undefined;
let remotes: RemoteServer[] = [];
let clients: Client[] = [];
afterEach(async () => {
  for (const c of clients) await c.close().catch(() => {});
  clients = [];
  await gw?.stop();
  gw = undefined;
  for (const x of remotes) await x.close();
  remotes = [];
});

async function setup(extra: Partial<GatewayConfig> = {}) {
  const h = await startStreamableHttpServer();
  const s = await startSseServer();
  remotes.push(h, s);
  gw = new Gateway({
    port: 0,
    host: '127.0.0.1',
    logLevel: 'error',
    monitor: { requestLog: false },
    servers: [
      { id: 'h', name: 'H', transport: 'streamable-http', url: h.url, timeout: 3000 },
      { id: 's', name: 'S', transport: 'sse', url: s.url, timeout: 3000 },
    ],
    ...extra,
  });
  await gw.start();
  return { url: `http://127.0.0.1:${gw.address()!.port}`, h, s };
}

const H = { 'content-type': 'application/json' };
const post = (url: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}/api/v1${path}`, { method: 'POST', headers: { ...H, ...headers }, body: JSON.stringify(body) });

describe('resources & prompts on the REST API', () => {
  it('lists, reads and gets', async () => {
    const { url } = await setup();
    const res: any = await (await fetch(`${url}/api/v1/resources`)).json();
    // both servers list docs://readme → one copy, from "h"
    expect(res.resources).toEqual([expect.objectContaining({ uri: 'docs://readme', serverId: 'h', title: 'Readme', mimeType: 'text/plain' })]);
    const tpl: any = await (await fetch(`${url}/api/v1/resources/templates?server=s`)).json();
    expect(tpl.resourceTemplates).toEqual([expect.objectContaining({ uriTemplate: 'notes://{id}', serverId: 's' })]);
    const prompts: any = await (await fetch(`${url}/api/v1/prompts`)).json();
    expect(prompts.prompts.map((p: any) => `${p.serverId}/${p.name}`).sort()).toEqual(['h/greet', 's/greet']);
    expect(prompts.prompts[0].arguments[0]).toMatchObject({ name: 'name', required: true });

    const read = await post(url, '/resources/read', { uri: 'docs://readme' });
    expect(read.status).toBe(200);
    const rb: any = await read.json();
    expect(rb).toMatchObject({ server: 'h', uri: 'docs://readme' });
    expect(rb.result.contents[0].text).toBe('hello from readme');
    const viaTpl: any = await (await post(url, '/resources/read', { uri: 'notes://7', server: 's' })).json();
    expect(viaTpl.result.contents[0].text).toBe('note 7');
    expect((await post(url, '/resources/read', { uri: 'nope://x' })).status).toBe(404);
    expect((await post(url, '/resources/read', {})).status).toBe(400);
    expect((await post(url, '/resources/read', { uri: 'docs://readme', server: 'zz' })).status).toBe(404);
    expect((await post(url, '/resources/read', { uri: 'docs://missing', server: 'h' })).status).toBe(502);

    expect((await post(url, '/prompts/get', { name: 'greet', arguments: { name: 'Ada' } })).status).toBe(409);
    const got: any = await (await post(url, '/prompts/get', { name: 'greet', server: 's', arguments: { name: 'Ada' } })).json();
    expect(got.result.messages[0].content.text).toBe('Hello, Ada!');
    expect((await post(url, '/prompts/get', { name: 'nope' })).status).toBe(404);
    expect((await post(url, '/prompts/get', { name: 'greet', arguments: [] })).status).toBe(400);

    const recent: any = await (await fetch(`${url}/api/v1/requests?kind=resource`)).json();
    expect(recent.requests.map((x: any) => x.toolName)).toContain('docs://readme');
  });

  it('respects scopes', async () => {
    const { url } = await setup({ auth: { strategy: 'api-key', apiKeys: [{ key: 'k', name: 'k', servers: ['s'] }] } });
    const A = { authorization: 'Bearer k' };
    const res: any = await (await fetch(`${url}/api/v1/resources`, { headers: A })).json();
    expect(res.resources.map((r: any) => r.serverId)).toEqual(['s']);
    const prompts: any = await (await fetch(`${url}/api/v1/prompts`, { headers: A })).json();
    expect(prompts.prompts.map((p: any) => p.serverId)).toEqual(['s']);
    // routed to the only allowed server
    const read: any = await (await post(url, '/resources/read', { uri: 'docs://readme' }, A)).json();
    expect(read.server).toBe('s');
    expect((await post(url, '/resources/read', { uri: 'docs://readme', server: 'h' }, A)).status).toBe(403);
    const got: any = await (await post(url, '/prompts/get', { name: 'greet', arguments: { name: 'x' } }, A)).json();
    expect(got.server).toBe('s');
  });
});

describe('resources & prompts on /mcp', () => {
  async function sdk(url: string) {
    const c = new Client({ name: 't', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
    clients.push(c);
    return c;
  }

  it('aggregates and forwards with the SDK client', async () => {
    const { url } = await setup();
    const c = await sdk(url);
    const caps = c.getServerCapabilities();
    expect(caps?.resources?.listChanged).toBe(true);
    expect(caps?.prompts?.listChanged).toBe(true);
    expect((await c.listResources()).resources.map((r) => r.uri)).toEqual(['docs://readme']);
    expect((await c.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate)).toEqual(['notes://{id}', 'notes://{id}']);
    const read = await c.readResource({ uri: 'notes://5' });
    expect((read.contents[0] as any).text).toBe('note 5');
    const prompts = (await c.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toEqual(['h__greet', 's__greet']);
    const got = await c.getPrompt({ name: 's__greet', arguments: { name: 'Bo' } });
    expect((got.messages[0]!.content as any).text).toBe('Hello, Bo!');
    await expect(c.getPrompt({ name: 'greet', arguments: { name: 'x' } })).rejects.toThrow(/Unknown prompt/);
    await expect(c.readResource({ uri: 'nope://1' })).rejects.toThrow(/Resource not found/);
  });

  it('sends resources / prompts list_changed when an upstream changes', async () => {
    const { url, s } = await setup();
    const c = await sdk(url);
    let resChanged = 0;
    let promptChanged = 0;
    c.setNotificationHandler(ResourceListChangedNotificationSchema, async () => void resChanged++);
    c.setNotificationHandler(PromptListChangedNotificationSchema, async () => void promptChanged++);
    await c.listResources();
    const ep = gw!.getMcpEndpoint()!;
    const waitFor = async (p: () => boolean) => {
      const end = Date.now() + 5000;
      while (!p()) {
        if (Date.now() > end) throw new Error('timeout');
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    await waitFor(() => (ep.getSessions()[0]?.streams ?? 0) > 0);
    // the SSE upstream announces list changes
    s.servers[0]!.registerResource('extra', 'docs://extra', {}, async (uri) => ({ contents: [{ uri: uri.href, text: 'x' }] }));
    await waitFor(() => resChanged > 0);
    expect((await c.listResources()).resources.map((r) => r.uri)).toContain('docs://extra');
    s.servers[0]!.registerPrompt('bye', { description: 'bye' }, () => ({ messages: [] }));
    await waitFor(() => promptChanged > 0);
    expect((await c.listPrompts()).prompts.map((p) => p.name)).toContain('bye');
  });
});
