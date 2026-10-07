import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { toLlmToolSchemas, sanitizeToolName, toParameters } from '../src/mcp/llm-schemas.js';
import { Gateway } from '../src/gateway/index.js';
import type { ToolInfo, McpServerConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const t = (serverId: string, name: string, extra: Partial<ToolInfo> = {}): ToolInfo => ({ serverId, serverName: serverId, name, ...extra });

describe('LLM tool schemas', () => {
  const tools = [
    t('github', 'create_issue', { description: 'Create', inputSchema: { $schema: 'x', type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } }),
    t('a', 'echo'),
    t('b', 'echo', { title: 'Echo B' }),
    t('fs', 'read.file'),
  ];

  it('openai (chat completions)', () => {
    const r = toLlmToolSchemas(tools, 'openai');
    expect(r.total).toBe(4);
    expect(r.tools[0]).toEqual({ type: 'function', function: { name: 'a__echo', description: '', parameters: { type: 'object', properties: {} } } });
    const gh = r.tools.find((x: any) => x.function.name === 'create_issue') as any;
    expect(gh.function.parameters).toEqual({ type: 'object', properties: { title: { type: 'string' } }, required: ['title'] });
    expect(r.mapping['read_file']).toEqual({ server: 'fs', tool: 'read.file' });
    expect(r.mapping['b__echo']).toEqual({ server: 'b', tool: 'echo' });
    expect((r.tools[1] as any).function.description).toBe('Echo B');
  });

  it('openai-responses and anthropic shapes', () => {
    expect(toLlmToolSchemas([t('a', 'x')], 'openai-responses').tools[0]).toEqual({
      type: 'function', name: 'x', description: '', parameters: { type: 'object', properties: {} },
    });
    expect(toLlmToolSchemas([t('a', 'x', { description: 'd' })], 'anthropic').tools[0]).toEqual({
      name: 'x', description: 'd', input_schema: { type: 'object', properties: {} },
    });
  });

  it('sanitises and de-duplicates names', () => {
    expect(sanitizeToolName('a b/c')).toBe('a_b_c');
    expect(sanitizeToolName('')).toBe('tool');
    const long = sanitizeToolName('x'.repeat(100));
    expect(long).toHaveLength(64);
    expect(long).toMatch(/^[a-zA-Z0-9_-]+$/);
    const r = toLlmToolSchemas([t('a', 'p.q'), t('a', 'p_q')], 'anthropic');
    expect(Object.keys(r.mapping).sort()).toEqual(['p_q', 'p_q_2']);
    expect(toParameters({ type: 'array' })).toEqual({ type: 'array' });
  });
});

const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
const stdio = (id: string): McpServerConfig => ({ id, name: id, transport: 'stdio', command: process.execPath, args: [fixture], timeout: 2000 });
let gw: Gateway | undefined;
afterEach(async () => {
  await gw?.stop();
  gw = undefined;
});

describe('GET /api/v1/tools?format=', () => {
  it('returns provider schemas respecting scopes, and rejects unknown formats', async () => {
    gw = new Gateway({
      port: 0, host: '127.0.0.1', logLevel: 'error', servers: [stdio('a'), stdio('b')],
      auth: { strategy: 'api-key', apiKeys: ['admin', { key: 'k', name: 'k', servers: ['a'] }] },
    });
    await gw.start();
    const url = `http://127.0.0.1:${gw.address()!.port}/api/v1/tools`;
    const get = (q: string, key = 'admin') => fetch(`${url}${q}`, { headers: { authorization: `Bearer ${key}` } });
    const oa: any = await (await get('?format=openai')).json();
    expect(oa.format).toBe('openai');
    expect(oa.tools.map((x: any) => x.function.name)).toEqual(['a__echo', 'b__echo']);
    expect(oa.mapping.a__echo).toEqual({ server: 'a', tool: 'echo' });
    const an: any = await (await get('?format=anthropic', 'k')).json();
    expect(an.tools).toEqual([{ name: 'echo', description: 'echo', input_schema: { type: 'object', properties: {} } }]);
    const filtered: any = await (await get('?format=openai-responses&server=b')).json();
    expect(filtered.tools.map((x: any) => x.name)).toEqual(['echo']);
    expect((await get('?format=gemini')).status).toBe(400);
    // Plain MCP listing: order follows server connect order, which is not deterministic.
    const plain: any = await (await get('?format=mcp')).json();
    expect(plain.tools.map((x: any) => x.serverId).sort()).toEqual(['a', 'b']);
  });
});
