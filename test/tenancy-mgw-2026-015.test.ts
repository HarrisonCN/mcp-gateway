/**
 * MGW-2026-015 (LTS backport of the 14.2.0 fix): a client enrolled in several tenants must act for the tenant that
 * owns the called server — never its first membership — for `{tenant}` credential injection, budgets and quotas.
 *
 *  T1 actingTenant = the caller's membership covering the server
 *  T2 credentials: `{tenant}` injection resolves the acting tenant's secret (acme's secret never reaches labs' upstream)
 *  T3 budgets: a call is charged to / blocked by the acting tenant only (no cross-tenant spend or block)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { Gateway } from '../src/gateway/index.js';
import { actingTenant } from '../src/auth/tenants.js';
import type { GatewayConfig, TenantConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
const srv = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, transport: 'stdio' as const, command: process.execPath, args: [fixture], timeout: 5000, ...extra });

process.env.MGW_T015_KEY_acme = 'acme-secret';
process.env.MGW_T015_KEY_labs = 'labs-secret';

describe('MGW-2026-015 T1 acting tenant', () => {
  const tenants: TenantConfig[] = [
    { id: 'acme', servers: ['acme-*'], members: [{ client: 'key:dual', role: 'admin' }] },
    { id: 'labs', servers: ['labs-*'], members: [{ client: 'key:dual', role: 'admin' }, { client: 'key:lab2', role: 'viewer' }] },
  ] as TenantConfig[];
  it('is the member tenant covering the server', () => {
    expect(actingTenant(tenants, 'key:dual', 'acme-db')).toBe('acme');
    expect(actingTenant(tenants, 'key:dual', 'labs-db')).toBe('labs');
    expect(actingTenant(tenants, 'key:lab2', 'labs-db')).toBe('labs');
    expect(actingTenant(tenants, 'key:ops', 'labs-db')).toBeUndefined();
  });
});

describe('MGW-2026-015 tenant boundaries in the gateway', () => {
  let gw: Gateway | undefined;
  afterEach(async () => {
    await gw?.stop();
    gw = undefined;
  });
  const keys = [{ key: 'k-ops', name: 'ops' }, { key: 'k-dual', name: 'dual' }, { key: 'k-alice', name: 'alice' }, { key: 'k-lab2', name: 'lab2' }];
  const inject = [{ ref: 'secret://env/MGW_T015_KEY_{tenant}', argument: 'api_key' }];
  async function start(extra: Partial<GatewayConfig> = {}) {
    gw = new Gateway({
      port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false },
      auth: { strategy: 'api-key', apiKeys: keys },
      secrets: { providers: [{ id: 'env', type: 'env' }] },
      servers: [srv('acme-db', { inject }), srv('labs-db', { inject })],
      tenants: [
        { id: 'acme', servers: ['acme-*'], members: [{ client: 'key:dual', role: 'admin' }, { client: 'key:alice', role: 'admin' }] },
        { id: 'labs', servers: ['labs-*'], members: [{ client: 'key:dual', role: 'admin' }, { client: 'key:lab2', role: 'admin' }] },
      ],
      ...extra,
    } as unknown as GatewayConfig);
    await gw.start();
    return `http://127.0.0.1:${gw.address()!.port}/api/v1`;
  }
  const H = (k: string) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json' });
  const call = async (api: string, k: string, server: string, args: Record<string, unknown> = {}, tool = 'echo') => {
    const r = await fetch(`${api}/tools/call`, { method: 'POST', headers: H(k), body: JSON.stringify({ tool, server, arguments: args }) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const echoed = (b: any) => JSON.parse(b.result.content[0].text);

  it('T2 credentials: {tenant} injection uses the tenant owning the called server', async () => {
    const api = await start();
    expect(echoed((await call(api, 'k-dual', 'acme-db')).body).api_key).toBe('acme-secret');
    // vulnerable: the caller's FIRST tenant (acme) — acme's credential was sent to labs' upstream
    expect(echoed((await call(api, 'k-dual', 'labs-db')).body).api_key).toBe('labs-secret');
    expect(echoed((await call(api, 'k-lab2', 'labs-db')).body).api_key).toBe('labs-secret');
  });

  it('T3 budgets: spend and blocks follow the acting tenant only', async () => {
    const api = await start({
      costs: { tools: [{ match: '*', perCall: 1 }], budgets: [{ name: 'acme-cap', tenants: ['acme'], period: 'day', limit: 1, action: 'block' }] },
    } as unknown as Partial<GatewayConfig>);
    expect((await call(api, 'k-dual', 'labs-db')).status).toBe(200);
    expect((await call(api, 'k-dual', 'labs-db')).status).toBe(200);
    const t = (await (await fetch(`${api}/costs?by=tenant&period=all`, { headers: H('k-ops') })).json()) as any;
    const rows: Array<{ key: string; cost: number }> = t.totals ?? t.rows ?? t.items ?? t;
    expect(rows.find((r) => r.key === 'labs')?.cost).toBe(2);
    expect(rows.find((r) => r.key === 'acme')).toBeUndefined();
    expect((await call(api, 'k-alice', 'acme-db')).status).toBe(200);
    expect((await call(api, 'k-alice', 'acme-db')).status).not.toBe(200);
    expect((await call(api, 'k-dual', 'labs-db')).status).toBe(200);
  });
});
