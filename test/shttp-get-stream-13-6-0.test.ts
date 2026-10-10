/** 13.6.0 (backported to 12.0.9 / 10.9.10): Streamable HTTP upstreams deliver unsolicited list_changed via the GET stream. */
import { describe, it, expect, afterEach } from 'vitest';
import { McpProxy } from '../src/proxy/index.js';
import type { McpServerConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';
import { startStreamableHttpServer, type RemoteServer } from './fixtures/remote-servers.js';

logger.setLevel('error');
let proxy: McpProxy | undefined;
let remote: RemoteServer | undefined;
afterEach(async () => {
  await proxy?.disconnectAll();
  await remote?.close();
  proxy = undefined;
  remote = undefined;
});
const cfg = (url: string): McpServerConfig => ({ id: 'remote', name: 'Remote', transport: 'streamable-http', url, timeout: 5000 });
const waitFor = async (pred: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('Streamable HTTP upstream: standalone GET stream', () => {
  it('follows list_changed sent without a related request', async () => {
    remote = await startStreamableHttpServer();
    proxy = new McpProxy();
    await proxy.connect(cfg(remote.url));
    const changed: string[][] = [];
    proxy.on('tools-changed', (_id: string, t: Array<{ name: string }>) => changed.push(t.map((x) => x.name)));
    await new Promise((r) => setTimeout(r, 150));
    remote.servers.at(-1)!.registerTool('late-get', { description: 'runtime' }, async () => ({ content: [{ type: 'text', text: 'x' }] }));
    await waitFor(() => changed.length > 0);
    expect(changed.at(-1)).toContain('late-get');
    expect(remote.seenHeaders.some((h) => String(h.accept ?? '').includes('text/event-stream') && !String(h['content-type'] ?? '').includes('json'))).toBe(true);
  });

  it('closing the channel ends the GET stream (no reconnect after close)', async () => {
    remote = await startStreamableHttpServer();
    proxy = new McpProxy();
    await proxy.connect(cfg(remote.url));
    await new Promise((r) => setTimeout(r, 100));
    await proxy.disconnectAll();
    const n = remote.seenHeaders.length;
    await new Promise((r) => setTimeout(r, 600));
    expect(remote.seenHeaders.length).toBe(n);
  });
});
