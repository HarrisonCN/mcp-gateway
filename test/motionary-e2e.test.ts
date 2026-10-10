/**
 * 13.6.0 joint milestone (gateway half of MCP 13.6 + Motionary 13.7): the gateway proxies an external Motionary MCP
 * server. Runs only when MGW_MOTIONARY_BIN points at an installed `motionary-mcp.mjs` (CI job "MCP compat matrix"
 * installs it from npm into a scratch dir; Motionary is never a dependency of the gateway). See examples/motionary.
 *
 * Tolerant by design: only a core tool set is required; MOTIONARY_EXPECT_TOOLS adds more; extra tools are fine.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Gateway } from '../src/gateway/index.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const BIN = process.env.MGW_MOTIONARY_BIN;
const CORE = ['list_components', 'search_components', 'get_component'];
const EXTRA = (process.env.MOTIONARY_EXPECT_TOOLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

describe.skipIf(!BIN || !existsSync(BIN))('gateway → Motionary MCP server (E2E)', () => {
  let gw: Gateway;
  let client: Client;
  beforeAll(async () => {
    gw = new Gateway({
      port: 0,
      host: '127.0.0.1',
      logLevel: 'error',
      monitor: { requestLog: false },
      auth: { strategy: 'api-key', apiKeys: ['op'] },
      servers: [{ id: 'motionary', name: 'Motionary MCP', transport: 'stdio', command: process.execPath, args: [BIN!], timeout: 20_000 }],
    } as GatewayConfig);
    await gw.start();
    client = new Client({ name: 'motionary-e2e', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gw.address()!.port}/mcp`), { requestInit: { headers: { authorization: 'Bearer op' } } }));
  }, 60_000);
  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await gw?.stop();
  });

  it('exposes the Motionary tools through the gateway', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([...CORE, ...EXTRA]));
  });

  it('search_components and get_component answer through the gateway', async () => {
    const search = await client.callTool({ name: 'search_components', arguments: { query: 'counter', limit: 3 } });
    expect(search.isError ?? false).toBe(false);
    const text = (search.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('\n');
    expect(text.length).toBeGreaterThan(0);
    const tag = /usa-[a-z0-9-]+/.exec(text)?.[0];
    expect(tag).toBeTruthy();
    const comp = await client.callTool({ name: 'get_component', arguments: { tag: tag! } });
    expect(comp.isError ?? false).toBe(false);
    expect(JSON.stringify(comp.content)).toContain(tag!);
  });

  it('Motionary resources are reachable (when the server lists them)', async () => {
    const caps = client.getServerCapabilities();
    if (!caps?.resources) return;
    const uris = (await client.listResources()).resources.map((r) => r.uri);
    if (!uris.includes('motionary://manifest')) return;
    const r = await client.readResource({ uri: 'motionary://manifest' });
    expect(r.contents.length).toBeGreaterThan(0);
  });
});
