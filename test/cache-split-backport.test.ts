/** Backport of the 13.1.1 fix MGW-2026-005 — tool / semantic cache keys include the routing-split target, and a split target is authorized before any cache lookup. */
import { describe, it, expect } from 'vitest';
import { ToolInvoker, type InvokeContext } from '../src/gateway/invoker.js';
import { MetricsCollector } from '../src/monitor/index.js';
import { clientPrincipal, ERR_FORBIDDEN } from '../src/auth/authorizer.js';
import { ToolCache } from '../src/gateway/cache.js';
import '../src/features/semantic-cache.js';
import type { GatewayConfig, ProxyResponse } from '../src/utils/types.js';

function setup(opts: { cfg?: Record<string, unknown>; router?: unknown; cache?: ToolCache } = {}) {
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
  const cfg = { servers: [], ...opts.cfg } as unknown as GatewayConfig;
  const inv = new ToolInvoker({
    proxy: proxy as never,
    metrics: new MetricsCollector(),
    requestLog: () => false,
    config: () => cfg,
    router: opts.router as never,
    cache: opts.cache,
    serverConfig: (id) => ({ id, name: id, transport: 'stdio', command: 'x' }) as never,
    tenantsOf: () => ['t1'],
  });
  return { inv, sent };
}

const caller = (id: string, scope?: string[]): InvokeContext => ({
  serverId: 's',
  name: 'echo',
  kind: 'tool',
  method: 'tools/call',
  params: { q: 'hello world' },
  via: 'rest',
  clientId: id,
  principal: clientPrincipal(id, scope ? { servers: scope } : undefined),
});
const text = (r: { result?: unknown }) => (r.result as { content: { text: string }[] }).content[0]!.text;
const router = { route: (_s: string, _t: string, client?: string) => ({ server: client === 'key:b-user' ? 'b' : 'a', split: 'ab', variant: client === 'key:b-user' ? 'b' : 'a' }), report: () => {} };

describe('MGW-2026-005: caches and routing splits', () => {
  it('tool cache: split targets never share entries; a target the caller may not use is refused before the lookup', async () => {
    const cache = new ToolCache(() => ({ rules: [{ tools: ['echo'], ttlSeconds: 60, scope: 'shared' }] }) as never);
    const { inv, sent } = setup({ router, cache });
    expect(text(await inv.invoke(caller('key:a-user')))).toBe('a#1');
    expect(text(await inv.invoke(caller('key:b-user')))).toBe('b#2');
    const denied = await inv.invoke(caller('key:a-limited', ['s']));
    expect(denied.success).toBe(false);
    expect(denied.error?.code).toBe(ERR_FORBIDDEN);
    expect(denied.error?.data).toMatchObject({ decision: 'reroute-denied', to: 'a', reroutedBy: ['routing:ab'] });
    expect(text(await inv.invoke(caller('key:a-other')))).toBe('a#1');
    expect(sent).toEqual(['a/echo', 'b/echo']);
  });

  it('semantic cache: entries are partitioned by the routed target', async () => {
    const { inv, sent } = setup({ router, cfg: { semanticCache: { tools: ['s/echo'], scope: 'global', threshold: 0.9 } } });
    expect(text(await inv.invoke(caller('key:a-user')))).toBe('a#1');
    expect(text(await inv.invoke(caller('key:b-user')))).toBe('b#2');
    expect(text(await inv.invoke(caller('key:a-user2')))).toBe('a#1');
    expect(sent).toEqual(['a/echo', 'b/echo']);
  });
});
