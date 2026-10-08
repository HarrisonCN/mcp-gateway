/**
 * Static checks for the dashboard page and its GitHub Pages demo backend (dashboard/demo/mock.js).
 * Regression tests for 3.0.1: list rows laid out in the 8px dot column, demo gaps for the 1.6 – 3.0
 * features, stale demo version.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import vm from 'vm';
import { VERSION } from '../src/utils/version.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const html = readFileSync(`${root}dashboard/index.html`, 'utf8');
const mockSrc = readFileSync(`${root}dashboard/demo/mock.js`, 'utf8');

function i18n(): Record<string, Record<string, string>> {
  const start = html.indexOf('const I18N = {');
  let depth = 0;
  let end = start + 'const I18N = '.length;
  for (; end < html.length; end++) {
    if (html[end] === '{') depth++;
    else if (html[end] === '}' && --depth === 0) break;
  }
  return vm.runInNewContext(`(${html.slice(start + 'const I18N = '.length, end + 1)})`) as Record<string, Record<string, string>>;
}

/** Load mock.js in a sandbox and return its fetch. Long timers are dropped so nothing keeps running. */
function demoFetch(): (path: string, init?: RequestInit) => Promise<Response> {
  const origin = 'https://demo.example';
  const win: Record<string, unknown> = { fetch: () => Promise.reject(new Error('real fetch')) };
  const ctx = vm.createContext({
    window: win,
    location: { href: `${origin}/mcp-gateway/`, origin },
    localStorage: { getItem: () => '1', setItem: () => {} },
    document: { readyState: 'complete', addEventListener: () => {}, createElement: () => ({ style: {}, setAttribute: () => {}, append: () => {}, appendChild: () => {}, addEventListener: () => {}, querySelector: () => null }), body: { append: () => {}, appendChild: () => {} }, querySelector: () => null, getElementById: () => null, head: { append: () => {}, appendChild: () => {} } },
    crypto: globalThis.crypto,
    URL, Response, ReadableStream, TextEncoder, DOMException, Math, Date, JSON, Promise, Map, Set, Number, String, Array, Object,
    setTimeout: (fn: () => void, ms: number) => (ms <= 200 ? setTimeout(fn, 0) : 0),
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  });
  vm.runInContext(mockSrc, ctx);
  const f = win.fetch as (u: string, i?: RequestInit) => Promise<Response>;
  return (path, init) => f(`${origin}${path}`, init);
}

describe('dashboard page', () => {
  it('English and Chinese have the same keys, and every data-i18n key exists', () => {
    const { en, zh } = i18n();
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    const used = [...html.matchAll(/data-i18n(?:-title|-ph|-aria)?="([^"]+)"/g)].map((m) => m[1]!);
    expect(used.filter((k) => !(k in en))).toEqual([]);
  });

  it('action lists (approvals, workspaces, catalog) use the row layout, not the 8px status-dot column', () => {
    for (const id of ['approvals', 'tenants', 'catalog']) expect(html).toContain(`<ul class="stream rows" id="${id}">`);
    expect(html).toMatch(/\.stream\.rows li \{ grid-template-columns: minmax\(0, 1fr\) auto auto; \}/);
  });

  it('tolerates tenants without serverIds / servers', () => {
    expect(html).toContain("(tn.servers || []).join(', ')");
  });

  it('has cards for quotas, load balancing and the result cache', () => {
    for (const id of ['quotasCard', 'lbCard', 'cacheCard', 'cachePurge']) expect(html).toContain(`id="${id}"`);
  });
});

describe('GitHub Pages demo backend', () => {
  it('reports the package version', async () => {
    const f = demoFetch();
    expect(((await (await f('/')).json()) as { version: string }).version).toBe(VERSION);
  });

  it('serves every endpoint the dashboard reads, in the gateway shapes', async () => {
    const f = demoFetch();
    const get = async (p: string) => {
      const r = await f(`/api/v1${p}`);
      expect(r.status, p).toBe(200);
      return r.json() as Promise<Record<string, any>>;
    };
    expect((await get('/health')).version).toBe(VERSION);
    expect((await get('/servers')).servers.length).toBeGreaterThan(0);
    expect((await get('/approvals')).pending.length).toBe(1);
    expect((await get('/tenants')).tenants.length).toBe(2);
    expect((await get('/catalog')).entries.length).toBeGreaterThan(0);
    const q = await get('/quotas');
    expect(q.rules.length).toBeGreaterThan(0);
    for (const u of q.usage) expect(u.used).toBeLessThanOrEqual(u.limit);
    expect((await get('/load-balancing')).groups[0].members.length).toBeGreaterThan(1);
    const c = await get('/cache');
    expect(c.enabled).toBe(true);
    expect(((await (await f('/api/v1/cache', { method: 'DELETE' })).json()) as { purged: number }).purged).toBeGreaterThanOrEqual(0);
    expect((await get('/policy')).outputFilter.enabled).toBe(true);
    expect((await get('/usage')).rows).toBeInstanceOf(Array);
    expect((await get('/servers/github')).id).toBe('github');
    expect((await f('/api/v1/servers/nope')).status).toBe(404);
  });

  it('approving the demo approval works', async () => {
    const f = demoFetch();
    const r = await f('/api/v1/approvals/demo-approval-1/approve', { method: 'POST', body: '{}' });
    expect(((await r.json()) as { status: string }).status).toBe('approved');
    expect(((await (await f('/api/v1/approvals')).json()) as { pending: unknown[] }).pending).toHaveLength(0);
  });

  it('serves request details and replays them (3.2)', async () => {
    const f = demoFetch();
    const list = (await (await f('/api/v1/requests?limit=5&success=true')).json()) as { requests: Array<{ id: string }> };
    const id = list.requests[0]!.id;
    const c = (await (await f(`/api/v1/requests/${id}`)).json()) as any;
    expect(c.id).toBe(id);
    expect(c.arguments).toBeTypeOf('object');
    const r = (await (await f(`/api/v1/requests/${id}/replay`, { method: 'POST', body: JSON.stringify({}) })).json()) as any;
    expect(r.original.id).toBe(id);
    expect([200, 503]).toContain(r.replay.status);
    expect((await f('/api/v1/requests/nope')).status).toBe(404);
  });
});

describe('GitHub Pages demo backend: 3.3+ APIs', () => {
  it('lists plugins with their WASM sandboxes (3.3)', async () => {
    const f = demoFetch();
    const r = (await (await f('/api/v1/plugins')).json()) as any;
    expect(r.plugins.find((p: { kind: string }) => p.kind === 'wasm').sandboxes.length).toBe(2);
  });

  it('serves traffic splits and smart groups (3.4)', async () => {
    const f = demoFetch();
    const r = (await (await f('/api/v1/routing')).json()) as any;
    expect(r.splits[0].variants.map((v: { label: string }) => v.label)).toEqual(['stable', 'canary']);
    expect(r.groups[0].strategy).toBe('smart');
    expect((await f('/api/v1/routing/splits/search-canary/reset', { method: 'POST' })).status).toBe(200);
  });

  it('serves secret status without values, and rotation (3.5)', async () => {
    const f = demoFetch();
    const r = (await (await f('/api/v1/secrets')).json()) as any;
    expect(r.secrets.length).toBeGreaterThan(0);
    expect(r.secrets.every((s: { ref: string }) => s.ref.startsWith('secret://'))).toBe(true);
    expect(((await (await f('/api/v1/secrets/rotate', { method: 'POST' })).json()) as any).rotated).toEqual(['github']);
  });

  it('serves federation peers (3.6)', async () => {
    const f = demoFetch();
    const r = (await (await f('/api/v1/federation')).json()) as any;
    expect(r.enabled).toBe(true);
    expect(r.peers.length).toBe(2);
    expect(r.peers[0].servers.length).toBeGreaterThan(0);
    expect((await f('/api/v1/federation/sync', { method: 'POST' })).status).toBe(200);
  });

  it('serves compliance status and reports (3.7)', async () => {
    const f = demoFetch();
    expect(((await (await f('/api/v1/compliance')).json()) as any).pii.action).toBe('redact');
    const rep = (await (await f('/api/v1/compliance/report?framework=gdpr')).json()) as any;
    expect(rep.framework).toBe('gdpr');
    expect(rep.controls.length).toBeGreaterThan(0);
    expect(await (await f('/api/v1/compliance/report?framework=soc2&format=md')).text()).toMatch(/^# SOC 2/);
    expect((await f('/api/v1/compliance/report?framework=x')).status).toBe(400);
  });

  it('serves the developer portal (3.8)', async () => {
    const f = demoFetch();
    expect(((await (await f('/api/v1/portal/info')).json()) as any).signup).toBe('open');
    const su = await f('/api/v1/portal/signup', { method: 'POST', body: JSON.stringify({ name: 'x', email: 'x@example.com' }) });
    expect(su.status).toBe(201);
    expect(((await su.json()) as any).key).toMatch(/^mgw_demo_/);
    expect((await f('/api/v1/portal/signup', { method: 'POST', body: '{}' })).status).toBe(400);
    const me = (await (await f('/api/v1/portal/me')).json()) as any;
    expect(me.usage.byDay).toHaveLength(7);
    const tools = (await (await f('/api/v1/portal/tools')).json()) as any;
    expect(tools.tools.length).toBeGreaterThan(0);
    expect(tools.tools[0].snippets.curl).toContain('/api/v1/tools/call');
    expect(((await (await f('/api/v1/portal/keys/pend0001/approve', { method: 'POST' })).json()) as any).status).toBe('active');
  });

  it('lists the 5.0 deprecations (4.0: plugin API v2)', async () => {
    const f = demoFetch();
    const r = (await (await f('/api/v1/admin/deprecations')).json()) as any;
    expect(r.runtime.map((d: { id: string; removedIn: string }) => `${d.id}@${d.removedIn}`)).toEqual(['plugin-api-v2@5.0.0']);
    expect(r.config).toEqual([]);
  });

  it('reports MCP revisions and features (4.1)', async () => {
    const f = demoFetch();
    const r = (await (await f('/api/v1/mcp/protocol')).json()) as any;
    expect(r.latest).toBe('2025-11-25');
    expect(r.features['2024-11-05'].structuredContent).toBe(false);
    expect(r.features['2025-06-18'].resourceLink).toBe(true);
    expect(r.upstream.length).toBeGreaterThan(0);
  });

  it('lists and runs tool chains (4.2)', async () => {
    const f = demoFetch();
    const r = (await (await f('/api/v1/chains')).json()) as any;
    expect(r.chains.map((c: any) => c.tool)).toEqual(['chain_triage', 'chain_research']);
    const run = (await (await f('/api/v1/chains/triage/run', { method: 'POST', body: '{}' })).json()) as any;
    expect(run).toMatchObject({ chain: 'triage', success: true });
  });

  it('reports costs and budgets (4.3)', async () => {
    const f = demoFetch();
    const r = (await (await f('/api/v1/costs?by=model')).json()) as any;
    expect(r.totals[0]).toMatchObject({ key: 'gpt-4o' });
    expect(r.budgets.map((b: any) => b.action)).toEqual(['alert', 'block']);
    expect(r.alerts[0].threshold).toBe(0.8);
  });

  it('streams a tool call as SSE (4.4)', async () => {
    const f = demoFetch();
    const r = await f('/api/v1/tools/stream', { method: 'POST', body: '{}' });
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    const t = await r.text();
    expect(t.match(/event: progress/g)).toHaveLength(3);
    expect(t).toContain('event: result');
  });
});

describe('dashboard replay dialog (3.2)', () => {
  it('has the dialog and clickable history rows', () => {
    expect(html).toContain('id="rp"');
    expect(html).toContain('<tr data-req="${esc(x.id)}"');
    expect(html).toContain("api(`/requests/${encodeURIComponent(rp.call.id)}/replay`");
  });
});
