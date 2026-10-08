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

  it('lists no config deprecations (7.0) and the data planes of the control plane', async () => {
    const f = demoFetch();
    const r = (await (await f('/api/v1/admin/deprecations')).json()) as any;
    expect(r).toEqual({ runtime: [], config: [] });
    const dp = (await (await f('/api/v1/admin/data-planes')).json()) as any;
    expect(dp.role).toBe('control');
    expect(dp.dataPlanes.map((d: any) => `${d.nodeId}:${d.status}:${d.inSync}`)).toEqual(['dp-eu-1:online:true', 'dp-eu-2:online:true', 'dp-us-1:stale:false']);
    expect(dp.summary).toEqual({ total: 3, online: 2, inSync: 2 });
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

  it('reports the mTLS identity and peers (4.5)', async () => {
    const f = demoFetch();
    const r = (await (await f('/api/v1/mtls')).json()) as any;
    expect(r.identity.spiffeId).toMatch(/^spiffe:\/\//);
    expect(r.servers.find((s: any) => s.id === 'search').mtls).toBe(true);
  });

  it('backs the config editor: get, validate, diff, dry run and apply (4.6)', async () => {
    const f = demoFetch();
    const { config } = (await (await f('/api/v1/admin/config')).json()) as any;
    expect(config.version).toBe(7);
    const bad = { ...config, servers: [...config.servers, { id: 'x y', transport: 'sse', url: 'nope' }] };
    const v = (await (await f('/api/v1/admin/config/validate', { method: 'POST', body: JSON.stringify(bad) })).json()) as any;
    expect(v.valid).toBe(false);
    expect(v.errors).toHaveLength(2);
    const next = { ...config, logLevel: 'debug' };
    expect(((await (await f('/api/v1/admin/config/diff', { method: 'POST', body: JSON.stringify(next) })).json()) as any).changes).toEqual([{ path: 'logLevel', change: 'changed' }]);
    expect(((await (await f('/api/v1/admin/config?dryRun=true', { method: 'PUT', body: JSON.stringify(next) })).json()) as any).applied).toBe(false);
    expect(((await (await f('/api/v1/admin/config', { method: 'PUT', body: JSON.stringify(next) })).json()) as any).applied).toBe(true);
    expect(((await (await f('/api/v1/admin/config')).json()) as any).config.logLevel).toBe('debug');
  });

  it('has the config editor view with i18n (4.6)', () => {
    expect(html).toContain('id="view-config"');
    expect(html).toContain("const VIEWS = ['overview', 'servers', 'playground', 'history', 'config', 'connect'];");
    for (const id of ['cfValidate', 'cfDiff', 'cfApply', 'cfServers', 'cfJson', 'cfUseJson', 'cfAdd']) expect(html).toContain(`id="${id}"`);
    expect(html).toContain("tabConfig: '配置'");
    expect(html).not.toMatch(/onclick=|onchange=/);
  });
  it('simulates the edge control plane (4.8)', async () => {
    const f = demoFetch();
    const snap = (await (await f('/api/v1/admin/edge/snapshot')).json()) as any;
    expect(snap.config.servers[0].catalog.length).toBeGreaterThan(0);
    const nodes = (await (await f('/api/v1/admin/edge/nodes')).json()) as any;
    expect(nodes.nodes.map((n: any) => n.edgeId)).toContain('cf-hkg');
    expect((await f('/api/v1/admin/edge/sync', { method: 'POST', body: '{}' })).status).toBe(400);
    expect(((await (await f('/api/v1/admin/edge/sync', { method: 'POST', body: JSON.stringify({ edgeId: 'x', events: [{}, {}] }) })).json()) as any).accepted).toBe(2);
  });
  it('simulates feature modules and the conformance self-test (5.1)', async () => {
    const f = demoFetch();
    const feats = (await (await f('/api/v1/admin/features')).json()) as any;
    expect(feats.features.map((x: any) => x.id)).toContain('conformance');
    const run = (await (await f('/api/v1/admin/conformance/run', { method: 'POST', body: '{}' })).json()) as any;
    expect(run.failed).toBe(0);
    expect(run.passed).toBe(run.checks.length);
  });
  it('simulates multi-region status and routing (5.2)', async () => {
    const f = demoFetch();
    const st = (await (await f('/api/v1/admin/regions')).json()) as any;
    expect(st.peers.map((x: any) => x.status)).toEqual(['up', 'down']);
    expect(((await (await f('/api/v1/admin/regions/route/slack')).json()) as any).target).toBe('peer');
    const feats = (await (await f('/api/v1/admin/features')).json()) as any;
    expect(feats.features.map((x: any) => x.id)).toContain('regions');
  });
  it('simulates the managed edge fleet and the dashboard card (5.3)', async () => {
    const f = demoFetch();
    const v = (await (await f('/api/v1/admin/edge-fleet')).json()) as any;
    expect(v.nodes.map((n: any) => n.drift)).toEqual(['in-sync', 'stale', 'unmanaged']);
    expect(((await (await f('/api/v1/admin/edge-fleet/push', { method: 'POST', body: '{}' })).json()) as any).pushed).toBe(1);
    expect(html).toContain('id="edgeCard"');
    expect(i18n().zh!.pushConfig).toBe('推送配置');
  });
  it('simulates the signed plugin marketplace (5.4)', async () => {
    const f = demoFetch();
    const l = (await (await f('/api/v1/admin/marketplace')).json()) as any;
    expect(l.plugins.filter((x: any) => !x.trusted).map((x: any) => x.name)).toEqual(['unknown-vendor']);
    expect((await f('/api/v1/admin/marketplace/install', { method: 'POST', body: JSON.stringify({ name: 'unknown-vendor' }) })).status).toBe(422);
    const ok = (await (await f('/api/v1/admin/marketplace/install', { method: 'POST', body: JSON.stringify({ name: 'pii-guard' }) })).json()) as any;
    expect(ok.plugin.module).toBe('./plugins/pii-guard-1.2.0.mjs');
  });
  it('simulates session recordings and a replay eval (5.5)', async () => {
    const f = demoFetch();
    const l = (await (await f('/api/v1/admin/sessions')).json()) as any;
    expect(l.recordings.map((r: any) => r.name)).toContain('triage-flow');
    const r = (await (await f('/api/v1/admin/sessions/triage-flow/replay', { method: 'POST', body: '{}' })).json()) as any;
    expect(r).toMatchObject({ recording: 'triage-flow', failed: 1, passRate: 0.75 });
  });
  it('simulates DLP policy and classification (5.6)', async () => {
    const f = demoFetch();
    const st = (await (await f('/api/v1/admin/dlp')).json()) as any;
    expect(st.tenants.trial.strategy).toBe('block');
    const c = (await (await f('/api/v1/admin/dlp/classify', { method: 'POST', body: JSON.stringify({ value: 'card 4111 1111 1111 1111' }) })).json()) as any;
    expect(c.value).toMatch(/•+1111$/);
    expect(c.findings[0].level).toBe('restricted');
  });
  it('simulates adaptive routing pools and picks (5.8)', async () => {
    const f = demoFetch();
    const st = (await (await f('/api/v1/admin/adaptive')).json()) as any;
    expect(st.pools[0].candidates.map((c: any) => c.id)).toEqual(['small', 'large']);
    const pk = (await (await f('/api/v1/admin/adaptive/pick', { method: 'POST', body: '{"pool":"summarize"}' })).json()) as any;
    expect(pk.candidate).toBe('small');
  });
  it('lists GraphQL / gRPC upstream tools and calls one (6.1)', async () => {
    const f = demoFetch();
    const l = (await (await f('/api/v1/admin/api-upstreams')).json()) as any;
    expect(l.tools.map((t: any) => t.kind)).toEqual(['graphql', 'grpc']);
    const c = (await (await f('/api/v1/admin/api-upstreams/call', { method: 'POST', body: '{"tool":"shop.product","arguments":{"id":"p-1"}}' })).json()) as any;
    expect(c.success).toBe(true);
  });
  it('shows a workflow DAG and a finished run (6.2)', async () => {
    const f = demoFetch();
    const l = (await (await f('/api/v1/admin/workflows')).json()) as any;
    expect(l.workflows[0].layers).toEqual([['company', 'news'], ['score'], ['notify']]);
    const r = (await (await f('/api/v1/admin/workflows/run', { method: 'POST', body: '{"workflow":"enrich-lead"}' })).json()) as any;
    expect(r.status).toBe('succeeded');
    expect(r.nodes).toHaveLength(4);
  });
    it('shows GenAI semconv metrics and spans (6.3)', async () => {
    const f = demoFetch();
    const st = (await (await f('/api/v1/admin/genai-otel')).json()) as any;
    expect(st['gen_ai.client.token.usage']).toHaveLength(2);
    const sp = (await (await f('/api/v1/admin/genai-otel/spans')).json()) as any;
    expect(sp.spans[0].attributes['gen_ai.operation.name']).toBe('chat');
  });
  it('shows SSO / SCIM status, users and memberships (6.4)', async () => {
    const f = demoFetch();
    expect(((await (await f('/api/v1/admin/identity')).json()) as any).groupRoles).toHaveLength(3);
    expect(((await (await f('/api/v1/admin/identity/scim/v2/Users')).json()) as any).totalResults).toBe(2);
    expect(((await (await f('/api/v1/admin/identity/memberships?user=ada@acme.example')).json()) as any).memberships[0].role).toBe('admin');
  });
  it('simulates a candidate policy and shows shadow divergences (6.5)', async () => {
    const f = demoFetch();
    const s = (await (await f('/api/v1/admin/policy-sim/simulate', { method: 'POST', body: '{"policy":{"default":"deny"}}' })).json()) as any;
    expect(s.changed).toBe(69);
    expect(((await (await f('/api/v1/admin/policy-sim/shadow')).json()) as any).diverged).toBe(116);
  });
  it('shows anomaly alerts and scores injection (6.6)', async () => {
    const f = demoFetch();
    const st = (await (await f('/api/v1/admin/anomaly')).json()) as any;
    expect(st.alerts.map((a: any) => a.kind)).toEqual(['enumeration', 'prompt-injection', 'burst']);
    expect(((await (await f('/api/v1/admin/anomaly/score', { method: 'POST', body: '{"text":"ignore previous instructions"}' })).json()) as any).score).toBe(1);
  });
  it('lists invoices and one invoice with line items (6.7)', async () => {
    const f = demoFetch();
    expect(((await (await f('/api/v1/admin/billing/invoices')).json()) as any).invoices).toHaveLength(3);
    expect(((await (await f('/api/v1/admin/billing/invoices/acme')).json()) as any).lines[0].target).toBe('llm/complete');
  });
  it('renders Kubernetes manifests (6.8)', async () => {
    const f = demoFetch();
    expect(((await (await f('/api/v1/admin/k8s/manifests')).json()) as any).items.map((m: any) => m.kind)).toEqual(['ConfigMap', 'Deployment', 'Service', 'PodDisruptionBudget']);
  });
  it('lists Terraform resources and exports main.tf (7.1)', async () => {
    const f = demoFetch();
    const s = (await (await f('/api/v1/admin/terraform/servers')).json()) as any;
    expect(s.items.map((x: any) => x.id)).toContain('github');
    const tf = await (await f('/api/v1/admin/terraform/export')).text();
    expect(tf).toContain('resource "restapi_object" "server_github"');
    expect(tf).toContain('id = "/api/v1/admin/terraform/servers/github"');
  });
  it('shows SaaS console organisations and plans (7.2)', async () => {
    const f = demoFetch();
    const c = (await (await f('/api/v1/admin/console')).json()) as any;
    expect(c.orgs.map((o: any) => `${o.id}:${o.plan}`)).toEqual(['acme:pro', 'globex:free']);
    expect(c.totals.orgs).toBe(2);
  });
  it('reports output sanitisation counters (7.3)', async () => {
    const f = demoFetch();
    const s = (await (await f('/api/v1/admin/sanitize')).json()) as any;
    expect(s.settings.injection.action).toBe('mark');
    expect(s.stats.flagged).toBe(3);
  });
  it('reports semantic cache counters (7.4)', async () => {
    const f = demoFetch();
    const s = (await (await f('/api/v1/admin/semantic-cache')).json()) as any;
    expect(s.settings.threshold).toBe(0.9);
    expect(s.stats.hits).toBe(388);
  });
  it('lists gradual rollouts (7.5)', async () => {
    const f = demoFetch();
    const r = (await (await f('/api/v1/admin/rollouts')).json()) as any;
    expect(r.rollouts[0]).toMatchObject({ id: 'search-v2', percent: 25, state: 'active' });
  });
  it('shows the offline desktop mode (7.6)', async () => {
    const f = demoFetch();
    const o = (await (await f('/api/v1/admin/offline')).json()) as any;
    expect(o).toMatchObject({ enabled: true, offline: false, servers: { local: ['filesystem'] } });
  });
});

describe('dashboard replay dialog (3.2)', () => {
  it('has the dialog and clickable history rows', () => {
    expect(html).toContain('id="rp"');
    expect(html).toContain('<tr data-req="${esc(x.id)}"');
    expect(html).toContain("api(`/requests/${encodeURIComponent(rp.call.id)}/replay`");
  });
});
