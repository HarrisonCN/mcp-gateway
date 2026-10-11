/**
 * 14.2.0 租户隔离强化 — tenant boundaries for credentials, policies, budgets, caches and tool catalogs, plus the
 * centralized `tenancy.isolation` block (default deny cross-tenant, explicit audited sharing grants) and the
 * `mcp-gateway tenancy report`.
 *
 *  I1  acting tenant = the caller's tenant that owns the called server (not the caller's first membership)
 *  I2  credentials: `{tenant}` injection resolves the acting tenant's secret, never another tenant's (MGW-2026-015)
 *  I3  budgets: a call is charged to / blocked by the acting tenant only (no cross-tenant spend)
 *  I4  audit: every call record carries the acting tenant; GET /requests?tenant= filters
 *  I5  isolation: overlapping tenant globs → owner = first tenant; others denied (catalog + call) unless granted
 *  I6  isolation grants are audited (record tenant + tenantGrant); denials are recorded with decision cross-tenant
 *  I7  config validation of tenancy.isolation; no block = legacy behaviour (additive)
 *  I8  tenancy report (function + CLI): overlaps, ungranted sharing, shared credentials, global caches
 *  I9  property-based isolation matrix: resources × operations × principals
 *  I10 list_changed per tenant: a change to tenant B's server does not notify tenant A's session
 *  I11 semantic cache partition: tenant and client subjects can never collide
 */
import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import fc from 'fast-check';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { Gateway } from '../src/gateway/index.js';
import { withTenantScope, actingTenant } from '../src/auth/tenants.js';
import { authorize, clientPrincipal } from '../src/auth/authorizer.js';
import { filterToolsByScope } from '../src/auth/scopes.js';
import { tenancyReport } from '../src/auth/isolation.js';
import { validateConfig } from '../src/config/loader.js';
import type { GatewayConfig, TenantConfig, TenancyConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
const srv = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, transport: 'stdio' as const, command: process.execPath, args: [fixture], timeout: 5000, ...extra });

process.env.MGW_T142_KEY_acme = 'acme-secret';
process.env.MGW_T142_KEY_labs = 'labs-secret';

describe('I1 acting tenant', () => {
  const tenants: TenantConfig[] = [
    { id: 'acme', servers: ['acme-*'], members: [{ client: 'key:dual', role: 'admin' }] },
    { id: 'labs', servers: ['labs-*'], members: [{ client: 'key:dual', role: 'admin' }, { client: 'key:lab2', role: 'viewer' }] },
  ];
  it('is the member tenant owning the server', () => {
    expect(actingTenant(tenants, undefined, 'key:dual', 'acme-db')).toBe('acme');
    expect(actingTenant(tenants, undefined, 'key:dual', 'labs-db')).toBe('labs');
    expect(actingTenant(tenants, undefined, 'key:lab2', 'labs-db')).toBe('labs');
    expect(actingTenant(tenants, undefined, 'key:ops', 'labs-db')).toBeUndefined();
  });
});

describe('tenant boundaries in the gateway', () => {
  let gw: Gateway | undefined;
  afterEach(async () => {
    await gw?.stop();
    gw = undefined;
  });
  const keys = [{ key: 'k-ops', name: 'ops' }, { key: 'k-dual', name: 'dual' }, { key: 'k-alice', name: 'alice' }, { key: 'k-lab2', name: 'lab2' }];
  const inject = [{ ref: 'secret://env/MGW_T142_KEY_{tenant}', argument: 'api_key' }];
  async function start(extra: Partial<GatewayConfig> = {}, tenants?: TenantConfig[]) {
    gw = new Gateway({
      port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false },
      auth: { strategy: 'api-key', apiKeys: keys },
      secrets: { providers: [{ id: 'env', type: 'env' }] },
      servers: [srv('acme-db', { inject }), srv('labs-db', { inject })],
      tenants: tenants ?? [
        { id: 'acme', servers: ['acme-*'], members: [{ client: 'key:dual', role: 'admin' }, { client: 'key:alice', role: 'admin' }] },
        { id: 'labs', servers: ['labs-*'], members: [{ client: 'key:dual', role: 'admin' }, { client: 'key:lab2', role: 'admin' }] },
      ],
      ...extra,
    } as GatewayConfig);
    await gw.start();
    return `http://127.0.0.1:${gw.address()!.port}/api/v1`;
  }
  const H = (k: string) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json' });
  const call = async (api: string, k: string, server: string, args: Record<string, unknown> = {}, tool = 'echo') => {
    const r = await fetch(`${api}/tools/call`, { method: 'POST', headers: H(k), body: JSON.stringify({ tool, server, arguments: args }) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const echoed = (b: any) => JSON.parse(b.result.content[0].text);

  it('I2 credentials: {tenant} injection uses the tenant owning the called server (MGW-2026-015)', async () => {
    const api = await start();
    expect(echoed((await call(api, 'k-dual', 'acme-db')).body).api_key).toBe('acme-secret');
    // before 14.2: the caller's FIRST tenant (acme) — acme's credential was sent to labs' upstream
    expect(echoed((await call(api, 'k-dual', 'labs-db')).body).api_key).toBe('labs-secret');
    expect(echoed((await call(api, 'k-lab2', 'labs-db')).body).api_key).toBe('labs-secret');
  });

  it('I3 budgets: spend and blocks follow the acting tenant only', async () => {
    const api = await start({
      costs: { tools: [{ match: '*', perCall: 1 }], budgets: [{ name: 'acme-cap', tenants: ['acme'], period: 'day', limit: 1, action: 'block' }] },
    } as Partial<GatewayConfig>);
    expect((await call(api, 'k-dual', 'labs-db')).status).toBe(200);
    expect((await call(api, 'k-dual', 'labs-db')).status).toBe(200);
    const byTenant = async () => ((await (await fetch(`${api}/costs?by=tenant&period=all`, { headers: H('k-ops') })).json()) as any);
    const t = await byTenant();
    const rows: Array<{ key: string; cost: number }> = t.totals ?? t.rows ?? t.items ?? t;
    expect(rows.find((r) => r.key === 'labs')?.cost).toBe(2);
    expect(rows.find((r) => r.key === 'acme')).toBeUndefined();
    // acme's budget is still untouched by labs spend
    expect((await call(api, 'k-alice', 'acme-db')).status).toBe(200);
    // acme now at its cap: acme calls are blocked, the dual member's labs calls are not
    expect((await call(api, 'k-alice', 'acme-db')).status).not.toBe(200);
    expect((await call(api, 'k-dual', 'labs-db')).status).toBe(200);
  });

  it('I4 audit records carry the acting tenant (GET /requests?tenant=)', async () => {
    const api = await start();
    await call(api, 'k-dual', 'labs-db');
    await call(api, 'k-dual', 'acme-db');
    const page = (await (await fetch(`${api}/requests?tenant=labs`, { headers: H('k-ops') })).json()) as any;
    expect(page.requests).toHaveLength(1);
    expect(page.requests[0]).toMatchObject({ serverId: 'labs-db', clientId: 'key:dual', tenant: 'labs' });
  });

  const overlap: TenantConfig[] = [
    { id: 'acme', servers: ['acme-*', 'shared-*'], members: [{ client: 'key:alice', role: 'admin' }] },
    { id: 'labs', servers: ['labs-*', 'shared-*'], members: [{ client: 'key:lab2', role: 'admin' }] },
  ];
  const tools = async (api: string, k: string) => ((await (await fetch(`${api}/tools`, { headers: H(k) })).json()) as { tools: Array<{ serverId: string }> }).tools.map((t) => t.serverId).sort();

  it('I5/I6 isolation: overlapping servers belong to the first tenant; others are denied unless granted (audited)', async () => {
    const servers = [srv('acme-db'), srv('labs-db'), srv('shared-kb')];
    // legacy (no tenancy block): overlap shares the server
    let api = await start({ servers }, overlap);
    expect(await tools(api, 'k-lab2')).toEqual(['labs-db', 'shared-kb']);
    await gw!.stop();
    // isolation: default deny cross-tenant
    api = await start({ servers, tenancy: { isolation: {} } } as Partial<GatewayConfig>, overlap);
    expect(await tools(api, 'k-alice')).toEqual(['acme-db', 'shared-kb']);
    expect(await tools(api, 'k-lab2')).toEqual(['labs-db']);
    const denied = await call(api, 'k-lab2', 'shared-kb');
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).toMatch(/cross-tenant/i);
    let page = (await (await fetch(`${api}/requests?server=shared-kb`, { headers: H('k-ops') })).json()) as any;
    expect(page.requests[0]).toMatchObject({ clientId: 'key:lab2', success: false, decision: 'cross-tenant' });
    await gw!.stop();
    // explicit grant: acme shares shared-kb with labs → allowed, audited with the grant
    api = await start({ servers, tenancy: { isolation: { grants: [{ owner: 'acme', tenants: ['labs'], servers: ['shared-kb'] }] } } } as Partial<GatewayConfig>, overlap);
    expect(await tools(api, 'k-lab2')).toEqual(['labs-db', 'shared-kb']);
    expect((await call(api, 'k-lab2', 'shared-kb')).status).toBe(200);
    page = (await (await fetch(`${api}/requests?server=shared-kb`, { headers: H('k-ops') })).json()) as any;
    expect(page.requests[0]).toMatchObject({ clientId: 'key:lab2', success: true, tenant: 'labs', tenantGrant: 'acme->labs' });
    // a grant can share a server outside the grantee's own globs
    await gw!.stop();
    api = await start({ servers, tenancy: { isolation: { grants: [{ owner: 'acme', tenants: ['labs'], servers: ['acme-db'], access: 'read' }] } } } as Partial<GatewayConfig>, overlap);
    expect(await tools(api, 'k-lab2')).toEqual(['acme-db', 'labs-db']);
    expect((await call(api, 'k-lab2', 'acme-db')).status).toBe(403); // read-only grant
  });

  it('I10 list_changed is per tenant', async () => {
    const tenants: TenantConfig[] = [
      { id: 'acme', servers: ['acme-*'], members: [{ client: 'key:alice', role: 'admin' }] },
      { id: 'labs', servers: ['labs-*'], members: [{ client: 'key:lab2', role: 'admin' }] },
    ];
    const cfg = { port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false }, auth: { strategy: 'api-key', apiKeys: keys }, servers: [srv('acme-db'), srv('labs-db')], tenants, tenancy: { isolation: {} } } as GatewayConfig;
    gw = new Gateway(cfg);
    await gw.start();
    const base = `http://127.0.0.1:${gw.address()!.port}/mcp`;
    const counts: Record<string, number> = { alice: 0, lab2: 0 };
    const clients: Client[] = [];
    for (const who of ['alice', 'lab2']) {
      const c = new Client({ name: who, version: '1' });
      await c.connect(new StreamableHTTPClientTransport(new URL(base), { requestInit: { headers: { authorization: `Bearer k-${who}` } } }));
      c.setNotificationHandler(ToolListChangedNotificationSchema, async () => void counts[who]!++);
      await c.listTools();
      clients.push(c);
    }
    const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 50)); };
    await until(() => gw!.getMcpEndpoint()!.getSessions().every((s) => s.streams > 0));
    await gw.reload({ ...cfg, servers: [srv('acme-db'), srv('labs-db'), srv('labs-kb')] });
    await until(() => counts.lab2! > 0);
    await new Promise((r) => setTimeout(r, 300));
    expect(counts.lab2).toBeGreaterThan(0);
    expect(counts.alice).toBe(0);
    for (const c of clients) await c.close().catch(() => undefined);
  }, 20_000);
});

describe('I7 config', () => {
  const base = { servers: [srv('acme-db')], tenants: [{ id: 'acme', servers: ['acme-*'] }, { id: 'labs', servers: ['labs-*'] }] };
  it('validates tenancy.isolation', () => {
    expect(() => validateConfig({ ...base, tenancy: { isolation: {} } })).not.toThrow();
    expect(() => validateConfig({ ...base, tenancy: { isolation: { crossTenant: 'audit', grants: [{ owner: 'acme', tenants: ['labs'], servers: ['acme-db'], access: 'call', reason: 'pilot' }] } } })).not.toThrow();
    expect(() => validateConfig({ ...base, tenancy: { isolation: { crossTenant: 'allow-all' } } })).toThrow();
    expect(() => validateConfig({ ...base, tenancy: { isolation: { grants: [{ owner: 'nope', tenants: ['labs'], servers: ['x'] }] } } })).toThrow(/unknown tenant "nope"/);
    expect(() => validateConfig({ ...base, tenancy: { isolation: { grants: [{ owner: 'acme', tenants: ['ghost'], servers: ['x'] }] } } })).toThrow(/unknown tenant "ghost"/);
    expect(() => validateConfig({ ...base, tenancy: { isolation: { grants: [{ owner: 'acme', tenants: ['acme'], servers: ['x'] }] } } })).toThrow(/itself/);
  });
});

describe('I8 tenancy report', () => {
  const cfg = {
    servers: [srv('acme-db'), srv('labs-db'), srv('shared-kb', { inject: [{ ref: 'secret://env/SHARED_KEY', argument: 'k' }] }), srv('free')],
    tenants: [
      { id: 'acme', servers: ['acme-*', 'shared-*'], members: [{ client: 'key:a', role: 'admin' }] },
      { id: 'labs', servers: ['labs-*', 'shared-*'], members: [{ client: 'key:l', role: 'admin' }] },
    ],
    features: { 'semantic-cache': { enabled: true, scope: 'global', tools: ['*'] } },
  } as unknown as GatewayConfig;
  it('lists owners, ungranted sharing, shared credentials and global caches', () => {
    const r = tenancyReport(cfg);
    expect(r.isolation).toBe('off');
    expect(r.servers.find((s) => s.server === 'shared-kb')).toMatchObject({ owner: 'acme', alsoMatchedBy: ['labs'] });
    expect(r.servers.find((s) => s.server === 'free')).toMatchObject({ owner: null });
    expect(r.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['isolation-off', 'overlap-ungranted', 'shared-credential', 'global-cache', 'unowned-server']));
    const on = tenancyReport({ ...cfg, tenancy: { isolation: { grants: [{ owner: 'acme', tenants: ['labs'], servers: ['shared-kb'] }] } } } as GatewayConfig);
    expect(on.isolation).toBe('deny');
    expect(on.findings.map((f) => f.code)).not.toContain('overlap-ungranted');
    expect(on.grants).toEqual([expect.objectContaining({ owner: 'acme', tenants: ['labs'], servers: ['shared-kb'] })]);
  });
  it('CLI: mcp-gateway tenancy report (exit 1 on violations, --json)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgw-tenancy-'));
    const file = join(dir, 'mcp-gateway.json');
    writeFileSync(file, JSON.stringify({ ...cfg, servers: cfg.servers.map(({ inject: _i, ...s }: any) => s) }));
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    let code = 0;
    let out = '';
    try {
      out = execFileSync(process.execPath, ['--import', 'tsx', cli, 'tenancy', 'report', '-c', file, '--json'], { encoding: 'utf8' });
    } catch (e: any) {
      code = e.status;
      out = e.stdout;
    }
    expect(code).toBe(1);
    expect(JSON.parse(out).findings.some((f: any) => f.code === 'overlap-ungranted')).toBe(true);
  }, 30_000);
});

describe('I9 isolation matrix (property-based)', () => {
  // Independent oracle: owner = first tenant (config order) whose globs match the server (exact ids here);
  // a principal sees a server iff it is a member of the owner or of a tenant granted the server by the owner;
  // it may call iff that membership (owner or grantee) has role admin/owner and the grant is not read-only.
  const SERVERS = ['s0', 's1', 's2', 's3', 's4'];
  const TENANTS = ['t0', 't1', 't2'];
  const PRINCIPALS = ['p0', 'p1', 'p2', 'p3'];
  const roleArb = fc.constantFrom('viewer' as const, 'admin' as const, 'owner' as const);
  const arb = fc.record({
    owned: fc.array(fc.subarray(SERVERS), { minLength: 3, maxLength: 3 }),
    members: fc.array(fc.array(fc.option(roleArb, { nil: undefined }), { minLength: 4, maxLength: 4 }), { minLength: 3, maxLength: 3 }),
    grants: fc.array(fc.record({ owner: fc.constantFrom(...TENANTS), to: fc.constantFrom(...TENANTS), server: fc.constantFrom(...SERVERS), read: fc.boolean() }), { maxLength: 4 }),
  });
  it('catalog, call authorization and acting tenant agree with the oracle for every principal × server × operation', () => {
    fc.assert(
      fc.property(arb, ({ owned, members, grants }) => {
        const tenants: TenantConfig[] = TENANTS.map((id, i) => ({
          id,
          servers: owned[i]!,
          members: PRINCIPALS.flatMap((p, j) => (members[i]![j] ? [{ client: `key:${p}`, role: members[i]![j]! }] : [])),
        }));
        const gs = grants.filter((g) => g.owner !== g.to).map((g) => ({ owner: g.owner, tenants: [g.to], servers: [g.server], ...(g.read ? { access: 'read' as const } : {}) }));
        const tenancy: TenancyConfig = { isolation: { grants: gs } };
        const owner = (s: string) => tenants.find((t) => t.servers.includes(s))?.id;
        const roleOf = (t: string, p: string) => tenants.find((x) => x.id === t)!.members!.find((m) => m.client === `key:${p}`)?.role;
        for (const p of PRINCIPALS) {
          const scope = withTenantScope(tenants, `key:${p}`, undefined, tenancy);
          const memberOfAny = tenants.some((t) => roleOf(t.id, p));
          const visible = filterToolsByScope(scope, SERVERS.map((s) => ({ serverId: s, name: 'echo' }))).map((t) => t.serverId);
          for (const s of SERVERS) {
            const o = owner(s);
            let see = false;
            let callOk = false;
            const via: string[] = [];
            if (!memberOfAny) {
              see = true; // operators (no tenant) keep their unrestricted scope
              callOk = true;
            } else if (o) {
              const r = roleOf(o, p);
              if (r) (see = true), (callOk = r !== 'viewer'), via.push(o);
              for (const g of gs.filter((g) => g.owner === o && g.servers.includes(s))) {
                const gr = roleOf(g.tenants[0]!, p);
                if (gr) {
                  see = true;
                  if (gr !== 'viewer' && !g.access) callOk = true;
                  via.push(g.tenants[0]!);
                }
              }
            }
            expect(visible.includes(s), `${p} sees ${s}`).toBe(see);
            const denied = authorize(clientPrincipal(`key:${p}`, scope), { serverId: s, name: 'echo', kind: 'tool' });
            expect(!denied, `${p} calls ${s}`).toBe(callOk);
            if (callOk && memberOfAny) {
              // credentials / budgets / caches are resolved for a tenant the caller belongs to, entitled to s
              expect(via).toContain(actingTenant(tenants, tenancy, `key:${p}`, s));
            }
          }
        }
      }),
      { numRuns: 300, seed: 1420 },
    );
  });
});

describe('I11 semantic cache partitions', () => {
  it('a tenant id never collides with a client id', async () => {
    const { semanticPartition } = await import('../src/features/semantic-cache.js');
    const c = { scope: 'tenant', tools: ['*'] } as never;
    const asTenant = semanticPartition(c, { serverId: 's', tool: 't', tenant: 'key:bob' } as never, 'x');
    const asClient = semanticPartition(c, { serverId: 's', tool: 't', clientId: 'key:bob' } as never, 'x');
    expect(asTenant).not.toBe(asClient);
  });
});
