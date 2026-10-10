/**
 * 13.5.0 property-based / fuzz tests (fast-check, devDependency only) on top of the 10.2 suite (test/property.test.ts):
 * glob matching (routing rules, tenants, grants), cache key injectivity, routing / tenant config parsing, tenant
 * isolation of the authorizer, and API-key header parsing. Every property is an invariant a security decision rests on.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { globToRegExp } from '../src/utils/tool-filter.js';
import { ToolCache } from '../src/gateway/cache.js';
import { validateConfig } from '../src/config/loader.js';
import { authorize, clientPrincipal } from '../src/auth/authorizer.js';
import { withTenantScope } from '../src/auth/tenants.js';
import { createAuthMiddleware } from '../src/auth/middleware.js';
import type { TenantConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const RUNS = Number(process.env.FC_RUNS ?? 200);

/** Reference semantics of a glob (the ≤ 13.4 regex translation), used on inputs small enough not to backtrack badly. */
const reference = (glob: string, s: string) =>
  new RegExp(`^${glob.split('').map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[\\^$.|+()[\]{}]/g, '\\$&'))).join('')}$`, 's').test(s);

const alpha = fc.constantFrom('a', 'b', '/', '.', '*', '?', '(', '\n', '_');
const small = (max: number) => fc.array(alpha, { maxLength: max }).map((a) => a.join(''));

describe('glob matching', () => {
  it('matches exactly what the regex translation matched (same semantics as ≤ 13.4)', () => {
    fc.assert(
      fc.property(small(8), small(10), (g, s) => {
        expect(globToRegExp(g).test(s)).toBe(reference(g, s));
      }),
      { numRuns: RUNS * 5 },
    );
  });
  it('is linear: any pattern against any name of ≤ 2000 chars finishes quickly', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('*', 'a', '?', 'b'), { maxLength: 80 }).map((a) => a.join('')), fc.integer({ min: 0, max: 2000 }), (g, n) => {
        const t = performance.now();
        globToRegExp(g).test('a'.repeat(n));
        expect(performance.now() - t).toBeLessThan(200);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('cache keys', () => {
  const cache = new ToolCache(() => ({ enabled: true, rules: [{ tools: ['*'] }] }));
  const rule = { tools: ['*'] };
  const part = fc.string({ maxLength: 6, unit: fc.constantFrom('a', '>', '\u0000', '/', '"', '#', ':') });
  const input = fc.record({
    serverId: part,
    target: fc.option(part, { nil: undefined }),
    tool: part,
    clientId: fc.option(part, { nil: undefined }),
    tenant: fc.option(part, { nil: undefined }),
    args: fc.dictionary(part, fc.jsonValue({ maxDepth: 1 }), { maxKeys: 2 }),
  });
  it('different call identities never produce the same key (injective encoding)', () => {
    fc.assert(
      fc.property(input, input, (a, b) => {
        const ka = cache.key(rule, a);
        const kb = cache.key(rule, b);
        const norm = (x: typeof a) => JSON.stringify([x.serverId, x.target && x.target !== x.serverId ? x.target : null, x.tool, x.clientId ?? 'anonymous', x.tenant ?? null, JSON.parse(JSON.stringify(x.args))]);
        if (norm(a) !== norm(b)) {
          // args are compared canonically (key order does not matter), so only assert on structurally different calls
          const sameArgs = JSON.stringify(Object.entries(a.args).sort()) === JSON.stringify(Object.entries(b.args).sort());
          const sameRest = JSON.stringify([a.serverId, a.target && a.target !== a.serverId ? a.target : null, a.tool, a.clientId ?? 'anonymous', a.tenant ?? null]) === JSON.stringify([b.serverId, b.target && b.target !== b.serverId ? b.target : null, b.tool, b.clientId ?? 'anonymous', b.tenant ?? null]);
          if (!(sameArgs && sameRest)) expect(ka).not.toBe(kb);
        } else expect(ka).toBe(kb);
      }),
      { numRuns: RUNS * 5 },
    );
  });
});

describe('routing / tenant config parsing', () => {
  const ids = fc.constantFrom('a', 'b', 'c', 'zz', '', 'a>b');
  const split = fc.record({
    name: fc.constantFrom('s1', 's2', ''),
    server: ids,
    variants: fc.array(fc.record({ server: ids, weight: fc.oneof(fc.double(), fc.integer({ min: -2, max: 5 })) }), { maxLength: 3 }),
  });
  it('an accepted config only routes to configured servers with finite, non-negative weights', () => {
    fc.assert(
      fc.property(fc.array(split, { maxLength: 3 }), (splits) => {
        const raw = { servers: ['a', 'b', 'c'].map((id) => ({ id, name: id, transport: 'stdio', command: 'node' })), routing: { splits } };
        let c;
        try {
          c = validateConfig(raw);
        } catch (err) {
          expect(String(err)).toMatch(/^Error: Invalid configuration/);
          return;
        }
        for (const sp of c.routing?.splits ?? []) {
          for (const s of [sp.server, ...sp.variants.map((v) => v.server)]) expect(['a', 'b', 'c']).toContain(s);
          for (const v of sp.variants) expect(Number.isFinite(v.weight) && v.weight >= 0).toBe(true);
          expect(sp.variants.some((v) => v.weight > 0)).toBe(true);
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe('tenant isolation of the authorizer', () => {
  const servers = ['s1', 's2', 's3', 'x-1'];
  const clients = ['key:a', 'key:b', 'key:c'];
  const tenantArb = fc.array(
    fc.record({
      servers: fc.subarray(servers, { minLength: 1 }),
      members: fc.array(fc.record({ client: fc.constantFrom(...clients, 'key:*'), role: fc.constantFrom('viewer', 'admin', 'owner') }), { maxLength: 3 }),
    }),
    { minLength: 1, maxLength: 3 },
  ).map((ts) => ts.map((t, i) => ({ id: `t${i}`, ...t })) as TenantConfig[]);
  it('a tenant member can call a tool only on servers of a tenant where it is admin / owner', () => {
    fc.assert(
      fc.property(tenantArb, fc.constantFrom(...clients), fc.constantFrom(...servers), (tenants, client, server) => {
        const scope = withTenantScope(tenants, client, undefined);
        const denied = authorize(clientPrincipal(client, scope), { serverId: server, name: 'echo', kind: 'tool' });
        const member = tenants.filter((t) => (t.members ?? []).some((m) => globToRegExp(m.client).test(client)));
        if (member.length === 0) return; // not a tenant member: operator behaviour
        const writable = member.some((t) => t.servers.includes(server) && (t.members ?? []).some((m) => globToRegExp(m.client).test(client) && m.role !== 'viewer'));
        expect(denied === undefined).toBe(writable);
      }),
      { numRuns: RUNS * 2 },
    );
  });
});

describe('API key headers', () => {
  const mw = createAuthMiddleware({ strategy: 'api-key', apiKeys: [{ name: 'a', key: 'k'.repeat(32) }] } as never);
  const run = (headers: Record<string, unknown>) =>
    new Promise<boolean>((resolve, reject) => {
      const res = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json() { resolve(false); return this; }, setHeader() {}, set() { return this; } };
      try {
        mw({ headers, ip: '127.0.0.1', query: {} } as never, res as never, () => resolve(true));
      } catch (e) {
        reject(e);
      }
    });
  it('random / duplicated / array-valued auth headers never throw and never authenticate without the exact key', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          authorization: fc.option(fc.oneof(fc.string({ maxLength: 80 }), fc.constant(`Bearer ${'k'.repeat(31)}`), fc.constant(`bearer  ${'k'.repeat(32)}x`)), { nil: undefined }),
          'x-api-key': fc.option(fc.oneof(fc.string({ maxLength: 80 }), fc.array(fc.string({ maxLength: 40 }), { maxLength: 3 })), { nil: undefined }),
        }),
        async (h) => {
          const headers = Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined));
          expect(await run(headers)).toBe(false);
        },
      ),
      { numRuns: RUNS },
    );
  });
  it('the exact key authenticates', async () => {
    expect(await run({ authorization: `Bearer ${'k'.repeat(32)}` })).toBe(true);
  });
});
