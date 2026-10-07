import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { Gateway } from '../src/gateway/index.js';
import { withTenantScope, membershipsOf, roleIn, canCall, highestRole, invalidTenants } from '../src/auth/tenants.js';
import { isServerInScope, filterToolsByScope, isRestricted } from '../src/auth/scopes.js';
import type { GatewayConfig, TenantConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));

const tenants: TenantConfig[] = [
  { id: 'acme', name: 'Acme', servers: ['acme-*'], members: [{ client: 'key:alice', role: 'owner' }, { client: 'key:bob', role: 'viewer' }, { client: 'key:b*', role: 'admin' }] },
  { id: 'labs', servers: ['labs'], members: [{ client: 'key:bob', role: 'viewer' }] },
];

describe('tenant scopes', () => {
  it('roles, memberships and confinement', () => {
    expect(roleIn(tenants[0]!, 'key:alice')).toBe('owner');
    expect(roleIn(tenants[0]!, 'key:bob')).toBe('admin'); // highest matching entry
    expect(roleIn(tenants[0]!, undefined)).toBeUndefined();
    expect(membershipsOf(tenants, 'key:bob').map((m) => [m.tenant, m.role])).toEqual([['acme', 'admin'], ['labs', 'viewer']]);
    expect(withTenantScope(tenants, 'key:ops', undefined)).toBeUndefined();
    const bob = withTenantScope(tenants, 'key:bob', { name: 'bob' })!;
    expect(bob).toMatchObject({ name: 'bob', tenantServers: ['acme-*', 'labs'], writableServers: ['acme-*'] });
    expect(isRestricted(bob)).toBe(true);
    expect(highestRole(bob)).toBe('admin');
    expect(highestRole(undefined)).toBeUndefined();
    expect(isServerInScope(bob, 'acme-db')).toBe(true);
    expect(isServerInScope(bob, 'labs')).toBe(true);
    expect(isServerInScope(bob, 'other')).toBe(false);
    expect(canCall(bob, 'acme-db')).toBe(true);
    expect(canCall(bob, 'labs')).toBe(false);
    expect(canCall(undefined, 'x')).toBe(true);
    expect(filterToolsByScope(bob, [{ serverId: 'labs', name: 't' }, { serverId: 'x', name: 't' }])).toHaveLength(1);
    expect(invalidTenants([{ id: 'a', servers: [] }, { id: 'a', servers: [] }])).toMatch(/duplicate/);
  });
});

describe('tenants in the gateway', () => {
  let gw: Gateway | undefined;
  afterEach(async () => {
    await gw?.stop();
    gw = undefined;
  });

  const srv = (id: string) => ({ id, name: id, transport: 'stdio' as const, command: process.execPath, args: [fixture], timeout: 5000 });
  async function start(extra: Partial<GatewayConfig> = {}) {
    gw = new Gateway({
      port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false },
      auth: { strategy: 'api-key', apiKeys: [{ key: 'k-ops', name: 'ops' }, { key: 'k-alice', name: 'alice' }, { key: 'k-bob', name: 'bob' }, { key: 'k-carol', name: 'carol' }] },
      servers: [srv('acme-db'), srv('labs')],
      tenants: [
        { id: 'acme', servers: ['acme-*'], members: [{ client: 'key:alice', role: 'owner' }, { client: 'key:bob', role: 'admin' }, { client: 'key:carol', role: 'viewer' }] },
        { id: 'labs', servers: ['labs'], members: [{ client: 'key:carol', role: 'owner' }] },
      ],
      policy: { rules: [{ name: 'hold', effect: 'approve', tools: ['echo'], args: [{ path: 'hold', exists: true }] }], approval: { timeoutSeconds: 30 } },
      ...extra,
    });
    await gw.start();
    return `http://127.0.0.1:${gw.address()!.port}`;
  }
  const H = (k: string) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json' });

  it('confines members to their tenants and makes viewers read-only (REST + /mcp)', async () => {
    const url = await start();
    const tools = async (k: string) => ((await (await fetch(`${url}/api/v1/tools`, { headers: H(k) })).json()) as { tools: Array<{ serverId: string }> }).tools.map((t) => t.serverId).sort();
    expect(await tools('k-ops')).toEqual(['acme-db', 'labs']);
    expect(await tools('k-bob')).toEqual(['acme-db']);
    expect(await tools('k-carol')).toEqual(['acme-db', 'labs']);

    const call = (k: string, server: string, args = {}) =>
      fetch(`${url}/api/v1/tools/call`, { method: 'POST', headers: H(k), body: JSON.stringify({ tool: 'echo', server, arguments: args }) });
    expect((await call('k-bob', 'acme-db')).status).toBe(200);
    expect((await call('k-bob', 'labs')).status).toBe(403);
    const viewer = await call('k-carol', 'acme-db');
    expect(viewer.status).toBe(403);
    expect(((await viewer.json()) as { message: string }).message).toMatch(/Read-only role/);
    expect((await call('k-carol', 'labs')).status).toBe(200);

    // /mcp: viewer cannot call on acme-db
    const MH = { ...H('k-carol'), accept: 'application/json, text/event-stream' };
    const init = await fetch(`${url}/mcp`, { method: 'POST', headers: MH, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) });
    const sid = init.headers.get('mcp-session-id')!;
    const list = (await (await fetch(`${url}/mcp`, { method: 'POST', headers: { ...MH, accept: 'application/json', 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) })).json()) as { result: { tools: Array<{ name: string }> } };
    const acmeTool = list.result.tools.map((t) => t.name).find((n) => n.includes('acme'))!;
    const r = (await (await fetch(`${url}/mcp`, { method: 'POST', headers: { ...MH, accept: 'application/json', 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: acmeTool, arguments: {} } }) })).json()) as { error?: { message: string } };
    expect(r.error?.message).toMatch(/read-only role/);
  });

  it('lists tenants by role and lets owners manage members', async () => {
    const url = await start();
    const get = async (k: string, p = '/tenants') => (await fetch(`${url}/api/v1${p}`, { headers: H(k) })).json() as Promise<Record<string, unknown>>;
    const ops = (await get('k-ops')) as { tenants: Array<{ id: string; role: string; members?: unknown[]; serverIds: string[] }>; operator: boolean };
    expect(ops.operator).toBe(true);
    expect(ops.tenants.map((t) => [t.id, t.role, t.serverIds])).toEqual([['acme', 'operator', ['acme-db']], ['labs', 'operator', ['labs']]]);
    const carol = (await get('k-carol')) as { tenants: Array<{ id: string; role: string; members?: unknown[] }> };
    expect(carol.tenants.map((t) => [t.id, t.role, !!t.members])).toEqual([['acme', 'viewer', false], ['labs', 'owner', true]]);
    expect((await fetch(`${url}/api/v1/tenants/labs`, { headers: H('k-bob') })).status).toBe(404);
    expect(((await get('k-bob', '/tenants/acme')) as { members: unknown[] }).members).toHaveLength(3);

    const put = (k: string, id: string, body: unknown) => fetch(`${url}/api/v1/tenants/${id}/members`, { method: 'PUT', headers: H(k), body: JSON.stringify(body) });
    expect((await put('k-bob', 'acme', { client: 'key:carol', role: 'admin' })).status).toBe(403);
    expect((await put('k-alice', 'acme', { client: 'key:carol', role: 'nope' })).status).toBe(400);
    expect((await put('k-alice', 'acme', { client: 'key:carol', role: 'admin' })).status).toBe(200);
    expect((await fetch(`${url}/api/v1/tools/call`, { method: 'POST', headers: H('k-carol'), body: JSON.stringify({ tool: 'echo', server: 'acme-db', arguments: {} }) })).status).toBe(200);
    expect((await put('k-ops', 'labs', { client: 'key:dave', role: 'viewer' })).status).toBe(200);

    const del = (k: string, id: string, c: string) => fetch(`${url}/api/v1/tenants/${id}/members/${encodeURIComponent(c)}`, { method: 'DELETE', headers: H(k) });
    expect((await del('k-alice', 'acme', 'key:nobody')).status).toBe(404);
    expect((await del('k-alice', 'acme', 'key:alice')).status).toBe(409);
    expect((await del('k-alice', 'acme', 'key:bob')).status).toBe(200);
    expect((await fetch(`${url}/api/v1/tools`, { headers: H('k-bob') }).then((r) => r.json()) as { tools: unknown[] }).tools).toHaveLength(2); // bob is in no tenant now
    expect((await fetch(`${url}/api/v1/tenants/nope`, { headers: H('k-ops') })).status).toBe(404);
  });

  it('tenant admins see and decide only their tenants\' approvals', async () => {
    const url = await start();
    const held = fetch(`${url}/api/v1/tools/call`, { method: 'POST', headers: H('k-ops'), body: JSON.stringify({ tool: 'echo', server: 'labs', arguments: { hold: 1 } }) });
    let ops: { pending: Array<{ id: string }> } = { pending: [] };
    for (let i = 0; i < 50 && ops.pending.length === 0; i++) {
      ops = (await (await fetch(`${url}/api/v1/approvals`, { headers: H('k-ops') })).json()) as typeof ops;
      if (ops.pending.length === 0) await new Promise((r) => setTimeout(r, 20));
    }
    const id = ops.pending[0]!.id;
    const bob = (await (await fetch(`${url}/api/v1/approvals`, { headers: H('k-bob') })).json()) as { pending: unknown[] };
    expect(bob.pending).toHaveLength(0);
    expect((await fetch(`${url}/api/v1/approvals/${id}/approve`, { method: 'POST', headers: H('k-bob'), body: '{}' })).status).toBe(404);
    expect((await fetch(`${url}/api/v1/approvals/${id}`, { headers: H('k-carol') })).status).toBe(200);
    expect((await fetch(`${url}/api/v1/approvals/${id}/approve`, { method: 'POST', headers: H('k-carol'), body: '{}' })).status).toBe(200);
    expect((await held).status).toBe(200);
  });
});
