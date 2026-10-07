import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { McpProxy, ERR_TIMEOUT } from '../src/proxy/index.js';
import type { McpServerConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
const cfg = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: 'fake',
  name: 'Fake',
  transport: 'stdio',
  command: process.execPath,
  args: [fixture],
  timeout: 5000,
  ...over,
});

let proxy: McpProxy;
afterEach(async () => {
  await proxy?.disconnectAll();
});

describe('McpProxy (stdio)', () => {
  it('connects, lists tools and calls one', async () => {
    proxy = new McpProxy();
    const tools = await proxy.connect(cfg());
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    const r = await proxy.callTool('fake', 'echo', { a: 1 });
    expect(r.success).toBe(true);
    expect(JSON.stringify(r.result)).toContain('{\\"a\\":1}');
  });

  it('follows tools/list pagination', async () => {
    proxy = new McpProxy();
    const tools = await proxy.connect(cfg({ env: { TOOL_PAGES: '3' } }));
    expect(tools.map((t) => t.name)).toEqual(['echo', 'echo1', 'echo2']);
  });

  it('does not leave a session behind when initialize fails', async () => {
    proxy = new McpProxy();
    await expect(proxy.connect(cfg({ env: { FAIL_INIT: '1' } }))).rejects.toThrow(/initialize/);
    expect(proxy.isConnected('fake')).toBe(false);
  });

  it('rejects non-stdio transports clearly', async () => {
    proxy = new McpProxy();
    await expect(proxy.connect(cfg({ transport: 'sse', url: 'http://x/sse' }))).rejects.toThrow(/not supported/);
  });

  it('decodes multi-byte UTF-8 split across chunks', async () => {
    proxy = new McpProxy();
    await proxy.connect(cfg());
    const r = await proxy.callTool('fake', 'unicode', {});
    expect((r.result as any).text).toBe('你好世界');
  });

  it('does not treat a server request with a colliding id as the response', async () => {
    proxy = new McpProxy();
    await proxy.connect(cfg());
    const r = await proxy.callTool('fake', 'ping-collide', { x: 2 });
    expect(r.success).toBe(true);
    expect(JSON.stringify(r.result)).toContain('{\\"x\\":2}');
  });

  it('times out with ERR_TIMEOUT', async () => {
    proxy = new McpProxy();
    await proxy.connect(cfg({ env: { SLOW_MS: '2000' } }));
    const r = await proxy.callTool('fake', 'slow', {}, 100);
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe(ERR_TIMEOUT);
  });

  it('enforces maxConcurrency', async () => {
    proxy = new McpProxy();
    await proxy.connect(cfg({ env: { SLOW_MS: '150' }, maxConcurrency: 1 }));
    const start = Date.now();
    const rs = await Promise.all([1, 2, 3].map(() => proxy.callTool('fake', 'slow', {})));
    expect(rs.every((r) => r.success)).toBe(true);
    expect(Date.now() - start).toBeGreaterThanOrEqual(400);
  });

  it('survives a crashing server and reports it disconnected', async () => {
    proxy = new McpProxy();
    await proxy.connect(cfg());
    const r = await proxy.callTool('fake', 'crash', {});
    expect(r.success).toBe(false);
    expect(proxy.isConnected('fake')).toBe(false);
    // writing to the dead server must not crash the process
    const r2 = await proxy.callTool('fake', 'echo', {});
    expect(r2.success).toBe(false);
  });

  it('reconnecting replaces the old process', async () => {
    proxy = new McpProxy();
    await proxy.connect(cfg());
    await proxy.connect(cfg());
    expect(proxy.isConnected('fake')).toBe(true);
    const r = await proxy.callTool('fake', 'echo', {});
    expect(r.success).toBe(true);
  });

  it('reports spawn failures', async () => {
    proxy = new McpProxy();
    await expect(proxy.connect(cfg({ command: '/nonexistent/binary' }))).rejects.toThrow();
    expect(proxy.isConnected('fake')).toBe(false);
  });
});
