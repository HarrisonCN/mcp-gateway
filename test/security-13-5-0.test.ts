/**
 * 13.5.0 security verification 2.0 — combined checks across cross-tenant isolation × agent / proxy authorization ×
 * routing × caching, plus misconfigurations that must fail closed (safe rejection with a clear error).
 *
 *  - tool cache keys carry tenant + principal (subject, actors, kind) + scope, and are unambiguous (no separator
 *    collisions between server ids, routed targets, client ids and arguments);
 *  - a cached result is never served to a call the authorizer refuses (scope, tenant role, delegation, routed target);
 *  - glob matching is linear (no catastrophic backtracking on client-supplied patterns — MGW-2026-013);
 *  - configs that would silently weaken auth or routing are refused at load time.
 */
import { describe, it, expect } from 'vitest';
import { ToolInvoker, type InvokeContext } from '../src/gateway/invoker.js';
import { MetricsCollector } from '../src/monitor/index.js';
import { clientPrincipal, systemPrincipal, ERR_FORBIDDEN, type Principal, type Delegation } from '../src/auth/authorizer.js';
import { ToolCache } from '../src/gateway/cache.js';
import { withTenantScope } from '../src/auth/tenants.js';
import { globToRegExp } from '../src/utils/tool-filter.js';
import { narrowScope } from '../src/features/agent-identity.js';
import { validateConfig } from '../src/config/loader.js';
import type { CacheConfig, ProxyResponse, TenantConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');

interface SetupOpts {
  cacheCfg?: CacheConfig;
  router?: unknown;
  tenantsOf?: (clientId: string | undefined) => string[];
}

function setup(opts: SetupOpts = {}) {
  const sent: string[] = [];
  let n = 0;
  const proxy = {
    callTool: async (target: string, tool: string): Promise<ProxyResponse> => {
      sent.push(`${target}/${tool}`);
      n++;
      return { success: true, durationMs: 1, result: { content: [{ type: 'text', text: `${target}#${n}` }] } };
    },
    request: async () => ({ success: true, durationMs: 1, result: {} }),
  };
  const cacheCfg: CacheConfig = opts.cacheCfg ?? { enabled: true, rules: [{ tools: ['*'], ttlSeconds: 60 }] };
  const cache = new ToolCache(() => cacheCfg);
  const cfg = { servers: [] } as never;
  const inv = new ToolInvoker({
    proxy: proxy as never,
    metrics: new MetricsCollector(),
    requestLog: () => false,
    config: () => cfg,
    router: opts.router as never,
    cache,
    serverConfig: (id) => ({ id, name: id, transport: 'stdio', command: 'x' }) as never,
    tenantsOf: opts.tenantsOf ?? (() => []),
  });
  return { inv, sent, cache };
}

const call = (serverId: string, clientId: string, principal: Principal, over: Partial<InvokeContext> = {}): InvokeContext => ({
  serverId,
  name: 'echo',
  kind: 'tool',
  method: 'tools/call',
  params: { q: 'hello' },
  via: 'rest',
  clientId,
  principal,
  ...over,
});

const text = (r: ProxyResponse) => (r.result as { content?: Array<{ text: string }> } | undefined)?.content?.[0]?.text;

const tenants: TenantConfig[] = [
  { id: 't1', servers: ['s1', 'shared'], members: [{ client: 'key:alice', role: 'admin' }, { client: 'key:viewer', role: 'viewer' }] },
  { id: 't2', servers: ['s2', 'shared'], members: [{ client: 'key:bob', role: 'admin' }, { client: 'key:alice', role: 'admin' }] },
] as TenantConfig[];
const tenantPrincipal = (id: string, delegation?: Delegation[]) => clientPrincipal(id, withTenantScope(tenants, id, undefined), delegation);

describe('13.5.0 cache × tenant × principal × scope', () => {
  it('a client switched to another tenant never sees the previous tenant\'s cached entry', async () => {
    let tenant = 't1';
    const { inv, sent } = setup({ tenantsOf: () => [tenant] });
    const p = clientPrincipal('key:carol', undefined);
    const a = await inv.invoke(call('shared', 'key:carol', p));
    tenant = 't2';
    const b = await inv.invoke(call('shared', 'key:carol', p));
    expect(sent).toHaveLength(2);
    expect(text(a)).not.toBe(text(b));
  });

  it('a delegated agent call and the subject\'s direct call do not share entries (actors are part of the key)', async () => {
    const { inv, sent } = setup();
    await inv.invoke(call('s1', 'key:alice', tenantPrincipal('key:alice')));
    await inv.invoke(call('s1', 'key:alice', tenantPrincipal('key:alice', [{ agent: 'agent:bot', tools: ['s1/echo'] }])));
    expect(sent).toHaveLength(2);
  });

  it('the same subject with a different scope (another token / key scope) gets its own entry', async () => {
    const { inv, sent } = setup();
    await inv.invoke(call('s1', 'jwt:u1', clientPrincipal('jwt:u1', { servers: ['s1', 's2'] })));
    await inv.invoke(call('s1', 'jwt:u1', clientPrincipal('jwt:u1', { servers: ['s1'] })));
    expect(sent).toHaveLength(2);
  });

  it('identical subject, tenant, actors and scope still hit the cache (no needless regression)', async () => {
    const { inv, sent } = setup();
    const r1 = await inv.invoke(call('s1', 'key:alice', tenantPrincipal('key:alice')));
    const r2 = await inv.invoke(call('s1', 'key:alice', tenantPrincipal('key:alice')));
    expect(sent).toHaveLength(1);
    expect(text(r1)).toBe(text(r2));
  });

  it('scope: shared rules share within a tenant but never across tenants', async () => {
    const tenantsOf = (id?: string) => (id === 'key:bob' ? ['t2'] : id === 'key:dave' ? ['t2'] : ['t1']);
    const { inv, sent } = setup({ tenantsOf, cacheCfg: { enabled: true, rules: [{ tools: ['*'], scope: 'shared' }] } });
    await inv.invoke(call('shared', 'key:alice', clientPrincipal('key:alice', undefined)));
    await inv.invoke(call('shared', 'key:bob', clientPrincipal('key:bob', undefined)));
    expect(sent).toHaveLength(2); // t1 → t2: not shared
    await inv.invoke(call('shared', 'key:dave', clientPrincipal('key:dave', undefined)));
    expect(sent).toHaveLength(2); // t2 → t2: shared
  });

  it('a refused call never reads the cache: scope, tenant role and delegation all checked before the lookup', async () => {
    const { inv, sent } = setup();
    await inv.invoke(call('s1', 'key:alice', tenantPrincipal('key:alice')));
    expect(sent).toHaveLength(1);
    // another tenant's member (no s1 in its tenants)
    const bob = await inv.invoke(call('s1', 'key:bob', tenantPrincipal('key:bob')));
    expect(bob.success).toBe(false);
    expect(bob.error?.code).toBe(ERR_FORBIDDEN);
    // viewer of t1: read-only
    const viewer = await inv.invoke(call('s1', 'key:viewer', tenantPrincipal('key:viewer')));
    expect(viewer.error?.code).toBe(ERR_FORBIDDEN);
    // delegation that does not cover the tool, same subject as the cached entry
    const agent = await inv.invoke(call('s1', 'key:alice', tenantPrincipal('key:alice', [{ agent: 'agent:bot', tools: ['s1/other'] }])));
    expect(agent.error?.code).toBe(ERR_FORBIDDEN);
    expect(sent).toHaveLength(1);
  });

  it('a routing split cannot escalate: a variant outside the caller\'s tenant is refused before cache and upstream', async () => {
    const router = { route: () => ({ server: 's2', split: 'x', variant: 'v' }), report: () => {} };
    const { inv, sent } = setup({ router });
    const r = await inv.invoke(call('s1', 'key:viewer2', clientPrincipal('key:viewer2', { tenantServers: ['s1'], writableServers: ['s1'] })));
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe(ERR_FORBIDDEN);
    expect(sent).toHaveLength(0);
  });

  it('a system principal labelled with a client id does not share that client\'s entries', async () => {
    const { inv, sent } = setup();
    await inv.invoke(call('s1', 'key:alice', systemPrincipal('replay')));
    await inv.invoke(call('s1', 'key:alice', tenantPrincipal('key:alice')));
    expect(sent).toHaveLength(2);
  });
});

describe('13.5.0 cache key encoding is unambiguous', () => {
  const cache = new ToolCache(() => ({ enabled: true, rules: [{ tools: ['*'] }] }));
  const rule = { tools: ['*'] };
  it('server "a>b" and server "a" routed to "b" are different keys', () => {
    expect(cache.key(rule, { serverId: 'a>b', tool: 't', args: {} })).not.toBe(cache.key(rule, { serverId: 'a', target: 'b', tool: 't', args: {} }));
  });
  it('separator characters inside client ids / tools cannot forge another key', () => {
    const k1 = cache.key(rule, { serverId: 's', tool: 't\u0000x', args: {}, clientId: 'c' });
    const k2 = cache.key(rule, { serverId: 's', tool: 't', args: {}, clientId: 'x\u0000c' });
    expect(k1).not.toBe(k2);
  });
});

describe('13.5.0 glob matching is linear (MGW-2026-013)', () => {
  it('a hostile pattern against a long name finishes fast and still matches correctly', () => {
    const t = Date.now();
    expect(globToRegExp('*a'.repeat(30) + 'x').test('a'.repeat(200))).toBe(false);
    expect(globToRegExp('*a'.repeat(30) + 'x').test('a'.repeat(60) + 'x')).toBe(true);
    expect(Date.now() - t).toBeLessThan(500);
  });
  it('agent-identity scope narrowing with a client-supplied hostile glob does not hang', () => {
    const catalog = Array.from({ length: 50 }, (_, i) => `srv/${'a'.repeat(60)}${i}`);
    const t = Date.now();
    expect(narrowScope(['srv/*'], ['*a'.repeat(25) + 'zz'], catalog)).toEqual([]);
    expect(Date.now() - t).toBeLessThan(500);
  });
  it('semantics unchanged: * / ? / literal metacharacters', () => {
    expect(globToRegExp('github/search_*').test('github/search_code')).toBe(true);
    expect(globToRegExp('a?c').test('abc')).toBe(true);
    expect(globToRegExp('a?c').test('ac')).toBe(false);
    expect(globToRegExp('a.c').test('abc')).toBe(false);
    expect(globToRegExp('(x)+[y]').test('(x)+[y]')).toBe(true);
    expect(globToRegExp('*').test('multi\nline')).toBe(true);
    expect(globToRegExp('').test('')).toBe(true);
    expect(globToRegExp('').test('a')).toBe(false);
  });
});

describe('13.5.0 misconfiguration fails closed', () => {
  const srv = (id: string) => ({ id, name: id, transport: 'stdio', command: 'node' });
  const base = { servers: [srv('a'), srv('b')] };
  const reject = (raw: unknown, msg: RegExp) => {
    expect(() => validateConfig(raw)).toThrow(/Invalid configuration/);
    expect(() => validateConfig(raw)).toThrow(msg);
  };
  it('two API keys with the same secret (identity ambiguity: one key\'s scope would silently apply to the other)', () => {
    reject({ ...base, auth: { strategy: 'api-key', apiKeys: [{ name: 'a', key: 'k'.repeat(32) }, { name: 'b', key: 'k'.repeat(32) }] } }, /same key as/);
  });
  it('an auth block with credentials or unknown keys that resolves to strategy "none" (auth silently off)', () => {
    reject({ ...base, auth: { enabled: true } }, /strategy/);
    reject({ ...base, auth: { stratgy: 'api-key', apiKeys: ['k'.repeat(32)] } }, /strategy/);
    reject({ ...base, auth: { apiKeys: ['k'.repeat(32)] } }, /strategy/);
  });
  it('explicit strategy "none" stays valid (no breaking change)', () => {
    expect(() => validateConfig({ ...base, auth: { strategy: 'none' } })).not.toThrow();
    expect(() => validateConfig({ ...base })).not.toThrow();
  });
  it('an empty host (would listen on every interface)', () => {
    reject({ ...base, host: '' }, /host/);
  });
  it('a non-finite routing weight', () => {
    reject({ ...base, routing: { splits: [{ name: 's', server: 'a', variants: [{ server: 'b', weight: Infinity }] }] } }, /weight/);
  });
  it('server ids with control characters (log / key injection)', () => {
    reject({ servers: [srv('a\u0000b')] }, /servers\.0\.id/);
    reject({ servers: [srv('a\nb')] }, /servers\.0\.id/);
  });
  it('valid configs of every kind above still load', () => {
    expect(() => validateConfig({ ...base, host: '127.0.0.1', auth: { strategy: 'api-key', apiKeys: [{ name: 'a', key: 'k'.repeat(32) }, { name: 'b', key: 'j'.repeat(32) }] }, routing: { splits: [{ name: 's', server: 'a', variants: [{ server: 'b', weight: 1 }] }] } })).not.toThrow();
  });
});
