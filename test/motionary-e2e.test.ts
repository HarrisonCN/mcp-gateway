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

/**
 * 14.2.0 joint milestone (gateway half of MCP 14.2 + Motionary 14.4 — Studio's controlled AI tool access): two tenants
 * each get their own Motionary MCP server behind the gateway (same external binary, separate upstreams). Tenant A can
 * neither see nor call tenant B's Motionary tools, and every call — allowed or refused — is in the audit log with the
 * caller and the acting tenant. See examples/motionary-studio.
 */
describe.skipIf(!BIN || !existsSync(BIN))('gateway → Motionary MCP server: per-tenant scoped access + audit (14.2.0)', () => {
  let gw: Gateway;
  let dir: string;
  const H = (k: string) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json' });
  let api = '';
  beforeAll(async () => {
    const { mkdtempSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    dir = mkdtempSync(join(tmpdir(), 'mgw-motionary-audit-'));
    const motionary = (id: string) => ({ id, name: id, transport: 'stdio' as const, command: process.execPath, args: [BIN!], timeout: 20_000 });
    gw = new Gateway({
      port: 0,
      host: '127.0.0.1',
      logLevel: 'error',
      monitor: { requestLog: false },
      audit: { enabled: true, path: join(dir, 'audit.db') },
      auth: { strategy: 'api-key', apiKeys: [{ key: 'k-ops', name: 'ops' }, { key: 'k-studio-a', name: 'studio-a' }, { key: 'k-studio-b', name: 'studio-b' }] },
      servers: [motionary('motionary-a'), motionary('motionary-b')],
      tenants: [
        { id: 'studio-a', servers: ['motionary-a'], members: [{ client: 'key:studio-a', role: 'admin' }] },
        { id: 'studio-b', servers: ['motionary-b'], members: [{ client: 'key:studio-b', role: 'admin' }] },
      ],
      tenancy: { isolation: { crossTenant: 'deny' } },
    } as GatewayConfig);
    await gw.start();
    api = `http://127.0.0.1:${gw.address()!.port}/api/v1`;
  }, 60_000);
  afterAll(async () => {
    await gw?.stop();
  });
  const call = (k: string, server: string, tool: string, args: Record<string, unknown>) =>
    fetch(`${api}/tools/call`, { method: 'POST', headers: H(k), body: JSON.stringify({ server, tool, arguments: args }) });

  it("tenant A sees only its own Motionary tools, and cannot call tenant B's", async () => {
    const servers = async (k: string) => [...new Set(((await (await fetch(`${api}/tools`, { headers: H(k) })).json()) as { tools: Array<{ serverId: string }> }).tools.map((t) => t.serverId))];
    expect(await servers('k-studio-a')).toEqual(['motionary-a']);
    expect(await servers('k-studio-b')).toEqual(['motionary-b']);
    // the same tool names exist on both servers; A's catalog never lists B's
    const a = ((await (await fetch(`${api}/tools`, { headers: H('k-studio-a') })).json()) as { tools: Array<{ name: string; serverId: string }> }).tools;
    expect(a.map((t) => t.name)).toEqual(expect.arrayContaining(CORE));
    expect((await call('k-studio-a', 'motionary-a', 'search_components', { query: 'counter', limit: 2 })).status).toBe(200);
    expect((await call('k-studio-a', 'motionary-b', 'search_components', { query: 'counter', limit: 2 })).status).toBe(403);
    expect((await call('k-studio-b', 'motionary-b', 'list_components', {})).status).toBe(200);
  }, 60_000);

  it('every Motionary call is audited with caller and acting tenant (allowed and refused)', async () => {
    const q = async (server: string) => ((await (await fetch(`${api}/requests?server=${server}&limit=50`, { headers: H('k-ops') })).json()) as { requests: Array<Record<string, unknown>> }).requests;
    const a = await q('motionary-a');
    const b = await q('motionary-b');
    expect(a).toEqual([expect.objectContaining({ clientId: 'key:studio-a', tenant: 'studio-a', toolName: 'search_components', success: true })]);
    expect(b).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clientId: 'key:studio-b', tenant: 'studio-b', toolName: 'list_components', success: true }),
        expect.objectContaining({ clientId: 'key:studio-a', toolName: 'search_components', success: false, decision: expect.stringMatching(/cross-tenant|scope/) }),
      ]),
    );
    expect(b).toHaveLength(2);
    // tenant members only see their own calls in the history
    const own = ((await (await fetch(`${api}/requests?limit=50`, { headers: H('k-studio-a') })).json()) as { requests: Array<{ clientId: string }> }).requests;
    expect(own.every((r) => r.clientId === 'key:studio-a')).toBe(true);
  });
});
