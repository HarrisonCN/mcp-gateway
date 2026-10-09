/**
 * 10.2: authorization matrix over every /api/v1/admin/* route the gateway mounts (enumerated from the live Express
 * router, so new routes are covered automatically) × (no credentials, invalid key, scoped key, tenant member of
 * another tenant). Every combination must be refused with 401 / 403 before any handler runs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'url';
import { Gateway } from '../src/gateway/index.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: Layer[] };
  regexp: RegExp & { fast_slash?: boolean };
}

/** Every `METHOD path` mounted on an Express app (Express 4 router internals). */
export function listRoutes(app: { _router: { stack: Layer[] } }): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  const walk = (stack: Layer[], prefix: string) => {
    for (const l of stack) {
      if (l.route) for (const m of Object.keys(l.route.methods)) out.push({ method: m.toUpperCase(), path: prefix + l.route.path });
      else if (l.handle?.stack) {
        const mount = l.regexp.fast_slash ? '' : l.regexp.source.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\\\//g, '/');
        walk(l.handle.stack, prefix + mount);
      }
    }
  };
  walk(app._router.stack, '');
  return out;
}

const concrete = (path: string) => path.replace(/:[A-Za-z]+/g, 'x').replace(/\/$/, '') || '/';

describe('admin API authorization matrix', () => {
  let gw: Gateway;
  let url: string;
  let routes: Array<{ method: string; path: string }>;

  beforeAll(async () => {
    const srv = (id: string) => ({ id, name: id, transport: 'stdio' as const, command: process.execPath, args: [fixture], timeout: 5000 });
    gw = new Gateway({
      port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false },
      auth: {
        strategy: 'api-key',
        apiKeys: [
          { key: 'k-ops', name: 'ops' },
          { key: 'k-scoped', name: 'scoped', servers: ['acme-db'] },
          { key: 'k-tools', name: 'tools', tools: ['echo'] },
          { key: 'k-alice', name: 'alice' },
          { key: 'k-labs', name: 'labs-owner' },
        ],
      },
      servers: [srv('acme-db'), srv('labs')],
      tenants: [
        { id: 'acme', servers: ['acme-*'], members: [{ client: 'key:alice', role: 'owner' }] },
        { id: 'labs', servers: ['labs'], members: [{ client: 'key:labs-owner', role: 'owner' }] },
      ],
    } as never);
    await gw.start();
    url = `http://127.0.0.1:${gw.address()!.port}`;
    routes = listRoutes((gw as unknown as { app: { _router: { stack: Layer[] } } }).app).filter((r) => r.path.startsWith('/api/v1/admin'));
  });
  afterAll(() => gw.stop());

  it('enumerates the admin surface (sanity)', () => {
    expect(routes.length).toBeGreaterThan(100);
    for (const p of ['/api/v1/admin/config', '/api/v1/admin/reload', '/api/v1/admin/features', '/api/v1/admin/data-planes', '/api/v1/admin/edge/sync']) {
      expect(routes.map((r) => r.path)).toContain(p);
    }
  });

  const callers: Array<[string, Record<string, string>, number[]]> = [
    ['no credentials', {}, [401]],
    ['invalid key', { authorization: 'Bearer nope' }, [401]],
    ['x-api-key invalid', { 'x-api-key': 'nope' }, [401]],
    ['server-scoped key', { authorization: 'Bearer k-scoped' }, [403]],
    ['tool-scoped key', { authorization: 'Bearer k-tools' }, [403]],
    ['tenant owner (acme)', { authorization: 'Bearer k-alice' }, [403]],
    ['tenant owner (labs, cross-tenant)', { authorization: 'Bearer k-labs' }, [403]],
  ];

  for (const [who, headers, expected] of callers) {
    it(`${who} → ${expected.join('/')} on every admin route`, async () => {
      const wrong: string[] = [];
      for (const r of routes) {
        const res = await fetch(url + concrete(r.path), {
          method: r.method,
          headers: { ...headers, 'content-type': 'application/json' },
          body: ['GET', 'HEAD', 'DELETE'].includes(r.method) ? undefined : JSON.stringify({ servers: [], tenant: 'labs', client: '*', role: 'owner' }),
        });
        await res.arrayBuffer();
        if (!expected.includes(res.status)) wrong.push(`${r.method} ${r.path} → ${res.status}`);
      }
      expect(wrong).toEqual([]);
    });
  }

  it('the operator key is authorized (never 401) on every admin route', async () => {
    const wrong: string[] = [];
    for (const r of routes.filter((x) => x.method === 'GET')) {
      const res = await fetch(url + concrete(r.path), { headers: { authorization: 'Bearer k-ops' } });
      await res.arrayBuffer();
      if (res.status === 401) wrong.push(`${r.method} ${r.path} → ${res.status}`);
    }
    expect(wrong).toEqual([]);
  });

  it('tenant routes: cross-tenant reads are 404 and member writes are 403', async () => {
    const H = (k: string) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json' });
    expect((await fetch(`${url}/api/v1/tenants/labs`, { headers: H('k-alice') })).status).toBe(404);
    expect((await fetch(`${url}/api/v1/tenants/labs/members`, { method: 'PUT', headers: H('k-alice'), body: JSON.stringify({ client: 'key:alice', role: 'owner' }) })).status).toBe(404);
    expect((await fetch(`${url}/api/v1/tenants/acme/members/${encodeURIComponent('key:alice')}`, { method: 'DELETE', headers: H('k-labs') })).status).toBe(404);
    expect((await fetch(`${url}/api/v1/usage?tenant=labs`, { headers: H('k-alice') })).status).toBe(403);
    expect((await fetch(`${url}/api/v1/tools/call`, { method: 'POST', headers: H('k-alice'), body: JSON.stringify({ tool: 'echo', server: 'labs', arguments: {} }) })).status).toBe(403);
  });
});
