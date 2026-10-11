/**
 * 14.8.0: operations console — cluster status, call traces, policy denial explanation, incident timeline,
 * troubleshooting wizard, operator / viewer RBAC (`/api/v1/admin/ops/*`, `controlPlane.console`).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';
import { validateConfig } from '../src/config/loader.js';
import { runInScope } from '../src/kernel/instance.js';
import { announceRevocation } from '../src/gateway/revocations.js';

let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const OP = 'op-SECRET-7f3a9c';
const VIEW = 'viewer-SECRET-41be';
const CI = 'ci-SECRET-90dd';
const SCOPED = 'scoped-SECRET-55aa';
const hdr = (k: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json', ...extra });
// programmatic configs keep the internal (flat) key scope — see docs/guides/migrating-to-v4.md#4
const auth = {
  strategy: 'api-key',
  apiKeys: [
    { key: OP, name: 'ops' },
    { key: VIEW, name: 'oncall', servers: ['fake'] },
    { key: CI, name: 'ci', servers: ['fake'] },
    { key: SCOPED, name: 'narrow', servers: ['fake'], tools: ['add'] },
  ],
};
const policy = { rules: [{ name: 'ci-no-echo', clients: ['key:ci'], tools: ['echo'], effect: 'deny', message: 'CI may not echo' }] };
const SECRETS = [OP, VIEW, CI, SCOPED];

async function start(extra: Record<string, unknown> = {}, cp: Record<string, unknown> = {}) {
  h = await startFeatureGw({ auth, policy, controlPlane: { configApi: true, console: { viewers: ['key:oncall'], ...cp } }, ...extra } as never);
  return h;
}
const get = async (path: string, key = OP) => {
  const r = await fetch(`${h!.base}/api/v1/admin/ops/${path}`, { headers: hdr(key) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const post = async (path: string, body: unknown, key = OP) => {
  const r = await fetch(`${h!.base}/api/v1/admin/ops/${path}`, { method: 'POST', headers: hdr(key), body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const call = async (key: string, tool: string, args: Record<string, unknown> = { text: 'hi' }, extra: Record<string, string> = {}) => {
  const r = await fetch(`${h!.base}/api/v1/tools/call`, { method: 'POST', headers: hdr(key, extra), body: JSON.stringify({ server: 'fake', tool, arguments: args }) });
  return { status: r.status, body: (await r.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const noSecrets = (v: unknown) => {
  const s = JSON.stringify(v);
  for (const k of SECRETS) expect(s).not.toContain(k);
};

describe('operations console (14.8.0)', () => {
  it('O1 schema: controlPlane.console', () => {
    expect(() => validateConfig({ servers: [], controlPlane: { console: { viewers: ['key:oncall'], traceBuffer: 100, timelineBuffer: 200, explainDenials: true } } })).not.toThrow();
    expect(() => validateConfig({ servers: [], controlPlane: { console: { viewers: [''] } } })).toThrow();
    expect(() => validateConfig({ servers: [], controlPlane: { console: { traceBuffer: 0 } } })).toThrow();
    expect(() => validateConfig({ servers: [], controlPlane: { console: { bogus: 1 } } })).toThrow();
  });

  it('O2 cluster status: generations, data planes, edges, plugins, regions, DLQ — operator + viewer, not scoped keys', async () => {
    await start();
    const r = await get('cluster');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ role: 'all', generation: { current: expect.any(Number) }, dataPlanes: { total: 0, online: 0, inSync: 0, diverged: [] }, edges: { total: 0, queued: 0 }, plugins: { total: 0, open: [] } });
    expect(r.body).toHaveProperty('regions');
    expect(r.body).toHaveProperty('dlq');
    expect(r.body.servers).toMatchObject({ total: 1 });
    noSecrets(r.body);
    expect((await get('cluster', VIEW)).status).toBe(200);
    expect((await get('cluster', CI)).status).toBe(403);
    expect((await get('cluster', SCOPED)).status).toBe(403);
  });

  it('O3 call trace: auth → tenant → policy → plugins → route → upstream → cache → response with timings', async () => {
    await start();
    const ok = await call(OP, 'echo');
    expect(ok.status).toBe(200);
    const id = ok.body.requestId;
    expect(typeof id).toBe('string');
    const t = await get(`traces/${encodeURIComponent(id)}`);
    expect(t.status).toBe(200);
    expect(t.body.steps.map((s: { step: string }) => s.step)).toEqual(['auth', 'tenant', 'policy', 'plugins', 'route', 'upstream', 'cache', 'response']);
    for (const s of t.body.steps) expect(['ok', 'skipped']).toContain(s.status);
    expect(t.body.steps.find((s: { step: string }) => s.step === 'upstream')).toMatchObject({ status: 'ok', ms: expect.any(Number) });
    expect(t.body).toMatchObject({ requestId: id, serverId: 'fake', tool: 'echo', success: true, clientId: 'key:ops' });
    expect(typeof t.body.totalMs).toBe('number');
    const list = await get('traces?limit=5');
    expect(list.body.traces[0]).toMatchObject({ requestId: id });
    expect((await get(`traces/${encodeURIComponent(id)}`, VIEW)).status).toBe(200);
    expect((await get(`traces/${encodeURIComponent(id)}`, CI)).status).toBe(403);
    expect((await get('traces/nope')).status).toBe(404);
    // request data used as lookup keys must not reach prototype properties
    expect((await get('traces/__proto__')).status).toBe(404);
    expect((await get('traces/constructor')).status).toBe(404);
  });

  it('O4 denial explanation: rule, layer and config path in the trace / explain API; never in client errors', async () => {
    await start();
    const denied = await call(CI, 'echo', {}, { 'x-mcp-explain': '1' });
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).not.toContain('configPath');
    expect(denied.body.explain).toBeUndefined();
    expect(denied.body.policy?.explain).toBeUndefined();
    const list = await get('traces?outcome=denied&client=key:ci');
    expect(list.status).toBe(200);
    const tr = list.body.traces[0];
    expect(tr).toMatchObject({ success: false, decision: 'deny' });
    const full = await get(`traces/${encodeURIComponent(tr.requestId)}`);
    expect(full.body.explain).toMatchObject({ decision: 'deny', layer: 'policy', rule: 'ci-no-echo', configPath: 'policy.rules[0]', client: 'key:ci' });
    const steps = full.body.steps as Array<{ step: string; status: string }>;
    expect(steps.find((s) => s.step === 'policy')!.status).toBe('denied');
    expect(steps.find((s) => s.step === 'upstream')!.status).toBe('skipped');
    // explain any call without making it: scope (key scope tools) and policy
    const sc = await post('explain', { client: 'key:narrow', server: 'fake', tool: 'echo' });
    expect(sc.status).toBe(200);
    expect(sc.body).toMatchObject({ allowed: false, layer: 'scope', configPath: 'auth.apiKeys[3].scope.tools' });
    const pol = await post('explain', { client: 'key:ci', server: 'fake', tool: 'echo' });
    expect(pol.body).toMatchObject({ allowed: false, layer: 'policy', rule: 'ci-no-echo', configPath: 'policy.rules[0]' });
    const al = await post('explain', { client: 'key:ops', server: 'fake', tool: 'echo' });
    expect(al.body).toMatchObject({ allowed: true });
    expect((await post('explain', { client: 'key:ci', server: 'fake', tool: 'echo' }, VIEW)).status).toBe(200);
    expect((await post('explain', { client: 'key:ci', server: 'fake', tool: 'echo' }, CI)).status).toBe(403);
    expect((await post('explain', { client: 'key:ci', server: 'fake' })).status).toBe(400);
    noSecrets(full.body);
  });

  it('O4b explainDenials: explanation in error data for operators only (admin flag), never for other clients', async () => {
    await start({ policy: { rules: [{ name: 'ops-no-echo', clients: ['key:ops', 'key:oncall'], tools: ['echo'], effect: 'deny' }, ...policy.rules] } }, { explainDenials: true });
    const asOp = await call(OP, 'echo', {}, { 'x-mcp-explain': '1' });
    expect(asOp.status).toBe(403);
    expect(asOp.body.policy.explain).toMatchObject({ layer: 'policy', rule: 'ops-no-echo', configPath: 'policy.rules[0]' });
    // the admin flag is the config switch: operator callers get it with or without the header
    const opNoHeader = await call(OP, 'echo', {});
    expect(opNoHeader.body.policy.explain).toMatchObject({ rule: 'ops-no-echo' });
    const ci = await call(CI, 'echo', {}, { 'x-mcp-explain': '1' });
    expect(ci.status).toBe(403);
    expect(JSON.stringify(ci.body)).not.toContain('configPath');
    const viewer = await call(VIEW, 'echo', {}, { 'x-mcp-explain': '1' });
    expect(JSON.stringify(viewer.body)).not.toContain('configPath');
  });

  it('O5 incident timeline: restart, config apply, revocation, denials (audit) with kind / time filters', async () => {
    await start();
    const desired = (await h!.admin('config', undefined, 'GET', hdr(OP))).body.config;
    expect((await fetch(`${h!.base}/api/v1/admin/config`, { method: 'PUT', headers: hdr(OP), body: JSON.stringify({ ...desired, logLevel: 'warn' }) })).status).toBe(200);
    runInScope(h!.gw['instanceScope'], () => announceRevocation('key:portal-x', 'test revocation'));
    await call(CI, 'echo');
    const t = await get('timeline');
    expect(t.status).toBe(200);
    const kinds = new Set(t.body.events.map((e: { kind: string }) => e.kind));
    for (const k of ['restart', 'config-apply', 'revocation', 'audit']) expect(kinds).toContain(k);
    for (const e of t.body.events) expect(typeof e.at).toBe('string');
    const sorted = [...t.body.events].map((e: { at: string }) => e.at);
    expect(sorted).toEqual([...sorted].sort().reverse());
    const only = await get('timeline?kind=revocation');
    expect(only.body.events.length).toBe(1);
    expect(only.body.events[0]).toMatchObject({ kind: 'revocation', subject: 'key:portal-x' });
    const future = await get(`timeline?since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`);
    expect(future.body.events).toEqual([]);
    expect((await get('timeline?kind=nope')).status).toBe(400);
    expect((await get('timeline', VIEW)).status).toBe(200);
    expect((await get('timeline', CI)).status).toBe(403);
    noSecrets(t.body);
  });

  it('O6 troubleshooting wizard: guided checks → redacted shareable report (operators only)', async () => {
    await start();
    const r = await post('troubleshoot', { client: 'key:ci', server: 'fake', tool: 'echo', arguments: { token: 'arg-SECRET-zz', text: 'x' } });
    expect(r.status).toBe(200);
    const ids = r.body.checks.map((c: { id: string }) => c.id);
    expect(ids).toEqual(['upstream', 'auth', 'tenancy', 'policy', 'rate-limit', 'plugins']);
    const by = (id: string) => r.body.checks.find((c: { id: string }) => c.id === id);
    expect(by('upstream').status).toBe('pass');
    expect(by('auth').status).toBe('pass');
    expect(by('policy')).toMatchObject({ status: 'fail' });
    expect(by('policy').detail).toContain('ci-no-echo');
    expect(r.body).toMatchObject({ redacted: true, verdict: 'fail', input: { client: 'key:ci', server: 'fake', tool: 'echo' } });
    expect(JSON.stringify(r.body)).not.toContain('arg-SECRET-zz');
    noSecrets(r.body);
    const shared = await get(`reports/${encodeURIComponent(r.body.id)}`);
    expect(shared.status).toBe(200);
    expect(shared.body.id).toBe(r.body.id);
    expect((await get(`reports/${encodeURIComponent(r.body.id)}`, VIEW)).status).toBe(200);
    expect((await get('reports/__proto__')).status).toBe(404);
    const unknown = await post('troubleshoot', { client: 'key:ghost', server: 'fake', tool: 'echo' });
    expect(unknown.body.checks.find((c: { id: string }) => c.id === 'auth').status).toBe('fail');
    const missing = await post('troubleshoot', { client: 'key:ops', server: 'nope', tool: 'echo' });
    expect(missing.body.checks.find((c: { id: string }) => c.id === 'upstream').status).toBe('fail');
    expect((await post('troubleshoot', { server: 'fake' })).status).toBe(400);
    expect((await post('troubleshoot', { client: 'key:ci', server: 'fake', tool: 'echo' }, VIEW)).status).toBe(403);
    expect((await post('troubleshoot', { client: 'key:ci', server: 'fake', tool: 'echo' }, CI)).status).toBe(403);
  });

  it('O9 troubleshooting wizard is rate limited per client (429 with RateLimit headers)', async () => {
    await start();
    const body = { client: 'key:ops', server: 'fake', tool: 'echo' };
    for (let i = 0; i < 30; i++) expect((await post('troubleshoot', body)).status).toBe(200);
    const r = await fetch(`${h!.base}/api/v1/admin/ops/troubleshoot`, { method: 'POST', headers: hdr(OP), body: JSON.stringify(body) });
    expect(r.status).toBe(429);
    expect(r.headers.get('ratelimit-policy')).toContain('30');
    expect(((await r.json()) as { error: string }).error).toBe('Too Many Requests');
    // another client has its own budget; reads are not limited by the wizard's budget
    expect((await post('troubleshoot', body, VIEW)).status).toBe(403);
    expect((await get('cluster')).status).toBe(200);
  });

  it('O7 console disabled: ops routes answer 404; viewers do not gain other admin access', async () => {
    await start({}, { enabled: false });
    expect((await get('cluster')).status).toBe(404);
    await h!.stop();
    await start();
    expect((await h!.admin('config', undefined, 'GET', hdr(VIEW))).status).toBe(403);
    expect((await h!.admin('gitops/status', undefined, 'GET', hdr(VIEW))).status).toBe(403);
  });

  it('O8 dashboard: Operations page with accessible tabs, labelled forms and a live region', () => {
    const html = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
    expect(html).toContain('data-page="ops"');
    expect(html).toMatch(/role="tablist"[^>]*aria-label="[^"]+"/);
    for (const tab of ['cluster', 'traces', 'timeline', 'troubleshoot']) {
      expect(html).toMatch(new RegExp(`role="tab"[^>]*id="ops-tab-${tab}"[^>]*aria-controls="ops-panel-${tab}"`));
      expect(html).toMatch(new RegExp(`role="tabpanel"[^>]*id="ops-panel-${tab}"[^>]*aria-labelledby="ops-tab-${tab}"`));
    }
    expect(html).toMatch(/id="ops-status"[^>]*aria-live="polite"/);
    for (const f of ['ops-ts-client', 'ops-ts-server', 'ops-ts-tool', 'ops-tl-kind']) expect(html).toMatch(new RegExp(`<label[^>]*for="${f}"`));
    expect(html).toContain('/api/v1/admin/ops/');
  });
});
