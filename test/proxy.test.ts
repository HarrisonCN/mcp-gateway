import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { McpProxy, ERR_TIMEOUT, ERR_CANCELLED } from '../src/proxy/index.js';
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

  it('rejects unknown transports clearly', async () => {
    proxy = new McpProxy();
    await expect(proxy.connect(cfg({ transport: 'carrier-pigeon' as any }))).rejects.toThrow(/Unknown transport/);
  });

  it('emits "disconnected" when a connected server crashes', async () => {
    proxy = new McpProxy();
    await proxy.connect(cfg());
    const lost = new Promise<string>((r) => proxy.once('disconnected', (id: string) => r(id)));
    await proxy.callTool('fake', 'crash', {});
    expect(await lost).toBe('fake');
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

describe('McpProxy health ping', () => {
  it('measures ping latency over stdio', async () => {
    proxy = new McpProxy();
    await proxy.connect(cfg());
    expect(await proxy.ping('fake')).toBeGreaterThanOrEqual(0);
    await expect(proxy.ping('nope')).rejects.toThrow(/not connected/);
  });
});

describe('McpProxy cancellation', () => {
  it('cancels an in-flight request via AbortSignal', async () => {
    proxy = new McpProxy();
    await proxy.connect(cfg({ env: { SLOW_MS: '2000' } }));
    const ac = new AbortController();
    const p = proxy.callTool('fake', 'slow', {}, 5000, { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    const r = await p;
    expect(r.error?.code).toBe(ERR_CANCELLED);
    expect(r.durationMs).toBeLessThan(1500);
    // the session is still usable
    expect((await proxy.callTool('fake', 'echo', {})).success).toBe(true);
  });

  it('returns cancelled immediately for an already-aborted signal and while queued', async () => {
    proxy = new McpProxy();
    await proxy.connect(cfg({ env: { SLOW_MS: '300' }, maxConcurrency: 1 }));
    const ac = new AbortController();
    ac.abort();
    expect((await proxy.callTool('fake', 'echo', {}, 1000, { signal: ac.signal })).error?.code).toBe(ERR_CANCELLED);

    const busy = proxy.callTool('fake', 'slow', {});
    const ac2 = new AbortController();
    const queued = proxy.callTool('fake', 'echo', {}, 5000, { signal: ac2.signal });
    setTimeout(() => ac2.abort(), 30);
    expect((await queued).error?.code).toBe(ERR_CANCELLED);
    expect((await busy).success).toBe(true);
  });

  it('request() sends arbitrary methods', async () => {
    proxy = new McpProxy();
    await proxy.connect(cfg());
    expect((await proxy.request('fake', 'ping')).success).toBe(true);
    expect((await proxy.request('fake', 'nope/method', {})).error?.code).toBe(-32601);
    expect((await proxy.request('missing', 'ping')).success).toBe(false);
  });
});
