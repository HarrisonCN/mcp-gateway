import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { globToRegExp, isToolAllowed, filterTools } from '../src/utils/tool-filter.js';
import { ServerRegistry } from '../src/registry/index.js';
import { Gateway } from '../src/gateway/index.js';
import { loadConfig } from '../src/config/loader.js';
import { logger } from '../src/utils/logger.js';
import type { GatewayConfig, McpServerConfig, ToolInfo } from '../src/utils/types.js';

logger.setLevel('error');

describe('globToRegExp / isToolAllowed', () => {
  it('matches whole names with * and ?', () => {
    expect(globToRegExp('read_*').test('read_file')).toBe(true);
    expect(globToRegExp('read_*').test('xread_file')).toBe(false);
    expect(globToRegExp('get_?').test('get_a')).toBe(true);
    expect(globToRegExp('get_?').test('get_ab')).toBe(false);
    expect(globToRegExp('*').test('')).toBe(true);
  });

  it('treats regex metacharacters literally', () => {
    expect(globToRegExp('a.b').test('a.b')).toBe(true);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
    expect(globToRegExp('f(x)+[y]').test('f(x)+[y]')).toBe(true);
    expect(globToRegExp('^$|\\').test('^$|\\')).toBe(true);
  });

  it('is case-sensitive', () => {
    expect(isToolAllowed('Delete', { deny: ['delete'] })).toBe(true);
  });

  it('applies allow, then deny (deny wins)', () => {
    const f = { allow: ['read_*', 'list_*'], deny: ['*_secret'] };
    expect(isToolAllowed('read_file', f)).toBe(true);
    expect(isToolAllowed('list_dirs', f)).toBe(true);
    expect(isToolAllowed('write_file', f)).toBe(false);
    expect(isToolAllowed('read_secret', f)).toBe(false);
  });

  it('allows everything without a filter or with empty lists', () => {
    expect(isToolAllowed('x')).toBe(true);
    expect(isToolAllowed('x', {})).toBe(true);
    expect(isToolAllowed('x', { allow: [], deny: [] })).toBe(true);
    expect(isToolAllowed('x', { deny: ['y'] })).toBe(true);
  });

  it('filterTools keeps order and returns a copy', () => {
    const tools = [{ name: 'a1' }, { name: 'b1' }, { name: 'a2' }];
    expect(filterTools(tools, { allow: ['a*'] }).map((t) => t.name)).toEqual(['a1', 'a2']);
    const copy = filterTools(tools);
    expect(copy).toEqual(tools);
    expect(copy).not.toBe(tools);
  });
});

describe('ServerRegistry with a tools filter', () => {
  const tool = (name: string, serverId: string): ToolInfo => ({ name, serverId, serverName: serverId });

  it('stores only exposed tools and reports exposure', () => {
    const r = new ServerRegistry();
    r.register({ id: 'fs', name: 'fs', transport: 'stdio', command: 'x', tools: { deny: ['write_*', 'delete_*'] } });
    r.register({ id: 'other', name: 'other', transport: 'stdio', command: 'x' });
    r.setTools('fs', ['read_file', 'write_file', 'delete_file'].map((n) => tool(n, 'fs')));
    r.setTools('other', [tool('write_file', 'other')]);

    expect(r.getTools('fs').map((t) => t.name)).toEqual(['read_file']);
    // A tool name hidden on one server is no longer ambiguous.
    expect(r.findTools('write_file').map((t) => t.serverId)).toEqual(['other']);
    expect(r.isToolExposed('fs', 'write_file')).toBe(false);
    expect(r.isToolExposed('fs', 'read_file')).toBe(true);
    expect(r.isToolExposed('other', 'write_file')).toBe(true);
    expect(r.getSummary().totalTools).toBe(2);
  });
});

describe('config: servers[].tools', () => {
  const write = (body: string) => {
    const p = join(mkdtempSync(join(tmpdir(), 'mcpgw-tf-')), 'mcp-gateway.yml');
    writeFileSync(p, body);
    return p;
  };

  it('parses allow/deny lists', async () => {
    const c = await loadConfig(
      write('servers:\n  - {id: a, name: A, transport: stdio, command: x, tools: {allow: ["read_*"], deny: [read_secret]}}\n'),
    );
    expect(c.servers[0]!.tools).toEqual({ allow: ['read_*'], deny: ['read_secret'] });
  });

  it('rejects unknown keys and empty patterns', async () => {
    await expect(
      loadConfig(write('servers:\n  - {id: a, name: A, transport: stdio, command: x, tools: {include: [x]}}\n')),
    ).rejects.toThrow(/servers\.0\.tools/);
    await expect(
      loadConfig(write('servers:\n  - {id: a, name: A, transport: stdio, command: x, tools: {deny: [""]}}\n')),
    ).rejects.toThrow(/patterns must be non-empty/);
  });
});

describe('Gateway with a tools filter', () => {
  const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
  // The fixture exposes echo, echo1, echo2 with TOOL_PAGES=3 and answers any tools/call.
  const server = (tools?: McpServerConfig['tools']): McpServerConfig => ({
    id: 'fake',
    name: 'fake',
    transport: 'stdio',
    command: process.execPath,
    args: [fixture],
    env: { TOOL_PAGES: '3' },
    timeout: 2000,
    ...(tools ? { tools } : {}),
  });
  const config = (s: McpServerConfig): GatewayConfig => ({
    port: 0,
    host: '127.0.0.1',
    logLevel: 'error',
    monitor: { prometheus: false, requestLog: false, retentionHours: 1 },
    servers: [s],
  });

  let gw: Gateway | undefined;
  afterEach(async () => {
    await gw?.stop();
    gw = undefined;
  });

  async function start(s: McpServerConfig) {
    gw = new Gateway(config(s));
    await gw.start();
    return `http://127.0.0.1:${gw.address()!.port}/api/v1`;
  }
  const names = async (url: string) =>
    ((await (await fetch(`${url}/tools`)).json()) as { tools: ToolInfo[] }).tools.map((t) => t.name).sort();
  const call = (url: string, body: unknown) =>
    fetch(`${url}/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('hides filtered tools from discovery and blocks calls to them', async () => {
    const url = await start(server({ allow: ['echo*'], deny: ['echo2'] }));
    expect(await names(url)).toEqual(['echo', 'echo1']);

    const detail = (await (await fetch(`${url}/servers/fake`)).json()) as { tools: ToolInfo[] };
    expect(detail.tools.map((t) => t.name).sort()).toEqual(['echo', 'echo1']);

    expect((await call(url, { tool: 'echo1', arguments: { a: 1 } })).status).toBe(200);

    // Auto-routing cannot find a hidden tool...
    expect((await call(url, { tool: 'echo2' })).status).toBe(404);
    // ...and naming the server explicitly does not bypass the filter.
    const forced = await call(url, { tool: 'echo2', server: 'fake' });
    expect(forced.status).toBe(403);
    expect(((await forced.json()) as { message: string }).message).toMatch(/not exposed by server "fake"/);
  });

  it('exposes everything without a filter', async () => {
    const url = await start(server());
    expect(await names(url)).toEqual(['echo', 'echo1', 'echo2']);
  });

  it('applies a changed filter on hot reload', async () => {
    const url = await start(server({ deny: ['echo1', 'echo2'] }));
    expect(await names(url)).toEqual(['echo']);
    await gw!.reload(config(server({ allow: ['echo2'] })));
    expect(await names(url)).toEqual(['echo2']);
    expect((await call(url, { tool: 'echo', server: 'fake' })).status).toBe(403);
    expect((await call(url, { tool: 'echo2' })).status).toBe(200);
  });
});
