import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { Gateway } from '../src/gateway/index.js';
import { UsageMeter, periodBounds, usageCsv } from '../src/gateway/usage.js';
import type { QuotasConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
const T0 = Date.UTC(2026, 9, 7, 10, 30);

describe('UsageMeter', () => {
  it('period bounds are UTC calendar periods', () => {
    expect(periodBounds('hour', T0)).toEqual([Date.UTC(2026, 9, 7, 10), Date.UTC(2026, 9, 7, 11)]);
    expect(periodBounds('day', T0)).toEqual([Date.UTC(2026, 9, 7), Date.UTC(2026, 9, 8)]);
    expect(periodBounds('month', T0)).toEqual([Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1)]);
  });

  it('enforces per-client and per-tenant quotas, scoped by server / tool', () => {
    let t = T0;
    const cfg: QuotasConfig = {
      rules: [
        { name: 'search', limit: 2, period: 'hour', tools: ['search*'] },
        { name: 'team', limit: 3, period: 'day', per: 'tenant', tenants: ['acme'] },
        { name: 'free', limit: 1, period: 'month', clients: ['key:free-*'], servers: ['paid'] },
      ],
    };
    const m = new UsageMeter(() => cfg, () => t);
    const call = (clientId: string, tool = 'search', serverId = 's', tenants: string[] = []) => m.take({ clientId, tool, serverId, tenants });
    expect(call('a')).toBeUndefined();
    expect(call('a')).toBeUndefined();
    expect(call('a')).toMatchObject({ rule: 'search', subject: 'a', limit: 2, used: 2, resetsAt: Date.UTC(2026, 9, 7, 11) });
    expect(call('b')).toBeUndefined();
    t += 3_600_000;
    expect(call('a')).toBeUndefined();
    // tenant pool shared by its members
    expect(call('x', 'other', 's', ['acme'])).toBeUndefined();
    expect(call('y', 'other', 's', ['acme'])).toBeUndefined();
    expect(call('x', 'other', 's', ['acme'])).toBeUndefined();
    expect(call('z', 'other', 's', ['acme'])).toMatchObject({ rule: 'team', subject: 'tenant:acme' });
    expect(call('z', 'other', 's', ['labs'])).toBeUndefined();
    expect(call('key:free-1', 'x', 'paid')).toBeUndefined();
    expect(call('key:free-1', 'x', 'paid')).toMatchObject({ rule: 'free' });
    expect(call('key:pro', 'x', 'paid')).toBeUndefined();
    expect(m.quotaStatus().find((q) => q.subject === 'tenant:acme')).toMatchObject({ used: 3, limit: 3, period: 'day' });
  });

  it('meters calls and reports grouped rows; CSV is injection-safe', () => {
    const m = new UsageMeter(() => ({}), () => T0);
    m.record({ clientId: 'key:a', serverId: 's', tool: 't', success: true, durationMs: 10 });
    m.record({ clientId: 'key:a', serverId: 's', tool: 't', success: false, durationMs: 5 });
    m.record({ clientId: 'key:b', tenants: ['acme', 'labs'], serverId: 's2', tool: 'u', success: true, durationMs: 1 });
    expect(m.report()).toEqual([
      { client: 'key:a', calls: 2, errors: 1, durationMs: 15 },
      { client: 'key:b', calls: 1, errors: 0, durationMs: 1 },
    ]);
    expect(m.report({ group: ['tenant'] }).map((r) => [r.tenant, r.calls])).toEqual([['', 2], ['acme', 1], ['labs', 1]]);
    expect(m.report({ group: ['tool', 'day'], tenant: 'acme' })).toEqual([{ tool: 's2/u', day: '2026-10-07', calls: 1, errors: 0, durationMs: 1 }]);
    expect(m.report({ since: T0 + 7_200_000 })).toEqual([]);
    expect(m.report({ until: T0 - 7_200_000 })).toEqual([]);
    expect(m.report({ client: 'key:b', server: 's2', group: ['hour'] })[0]!.hour).toBe('2026-10-07T10:00:00.000Z');
    const csv = usageCsv([{ client: '=cmd()', calls: 1, errors: 0, durationMs: 2 }, { client: 'a,"b"', calls: 1, errors: 0, durationMs: 0 }], ['client']);
    expect(csv).toBe('client,calls,errors,durationMs\r\n\'=cmd(),1,0,2\r\n"a,""b""",1,0,0\r\n');
  });
});

describe('quotas and usage in the gateway', () => {
  let gw: Gateway | undefined;
  afterEach(async () => {
    await gw?.stop();
    gw = undefined;
  });

  it('429 over quota (REST + /mcp), usage JSON / CSV, tenant admins see their tenant only', async () => {
    gw = new Gateway({
      port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false },
      auth: { strategy: 'api-key', apiKeys: [{ key: 'ops', name: 'ops' }, { key: 'al', name: 'alice' }, { key: 'vi', name: 'vic' }] },
      servers: [{ id: 'fake', name: 'fake', transport: 'stdio', command: process.execPath, args: [fixture], timeout: 5000 }],
      tenants: [{ id: 'acme', servers: ['*'], members: [{ client: 'key:alice', role: 'admin' }, { client: 'key:vic', role: 'viewer' }] }],
      quotas: { rules: [{ name: 'per-key', limit: 2, period: 'day' }] },
    });
    await gw.start();
    const url = `http://127.0.0.1:${gw.address()!.port}`;
    const H = (k: string) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json' });
    const call = (k: string) => fetch(`${url}/api/v1/tools/call`, { method: 'POST', headers: H(k), body: JSON.stringify({ tool: 'echo', arguments: {} }) });
    expect((await call('al')).status).toBe(200);
    expect((await call('al')).status).toBe(200);
    const over = await call('al');
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await over.json()).toMatchObject({ code: -32007, quota: { quota: 'per-key', limit: 2 } });
    expect((await call('ops')).status).toBe(200);

    const usage = (await (await fetch(`${url}/api/v1/usage?group=client,tenant`, { headers: H('ops') })).json()) as { rows: Array<{ client: string; tenant: string; calls: number }> };
    expect(usage.rows.map((r) => [r.client, r.tenant, r.calls])).toEqual([['key:alice', 'acme', 2], ['key:ops', '', 1]]);
    const csv = await fetch(`${url}/api/v1/usage?format=csv&group=server`, { headers: H('ops') });
    expect(csv.headers.get('content-type')).toMatch(/text\/csv/);
    expect(await csv.text()).toBe('server,calls,errors,durationMs\r\nfake,3,0,' + (await (await fetch(`${url}/api/v1/usage?group=server`, { headers: H('ops') })).json() as { rows: Array<{ durationMs: number }> }).rows[0]!.durationMs + '\r\n');
    const mine = (await (await fetch(`${url}/api/v1/usage`, { headers: H('al') })).json()) as { rows: Array<{ client: string }> };
    expect(mine.rows.map((r) => r.client)).toEqual(['key:alice']);
    expect((await fetch(`${url}/api/v1/usage?tenant=other`, { headers: H('al') })).status).toBe(403);
    expect((await fetch(`${url}/api/v1/usage`, { headers: H('vi') })).status).toBe(403);
    const q = (await (await fetch(`${url}/api/v1/quotas`, { headers: H('ops') })).json()) as { usage: Array<{ subject: string; used: number }> };
    expect(q.usage.find((u) => u.subject === 'key:alice')!.used).toBe(2);
    expect(((await (await fetch(`${url}/api/v1/quotas`, { headers: H('al') })).json()) as { usage: unknown[] }).usage).toEqual([]);
  });
});
