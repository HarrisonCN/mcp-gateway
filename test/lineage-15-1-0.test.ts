/**
 * 15.1.0: call lineage — `GET /api/v1/admin/ops/lineage/:requestId` and `GET /api/v1/admin/ops/lineage?correlationId=`.
 * One call → who (subject + delegation chain), which tenant, which config generation, which decision (and the rule /
 * config path of a refusal), which target, how the upstream answered, what it cost, and the client's correlation id
 * (`X-Request-Id` / `X-Correlation-Id`) so another system (Motionary's AI edit history) can join its own records.
 * Additive only: no frozen route, field or schema key changes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';

let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const OP = 'op-SECRET-7f3a9c';
const VIEW = 'viewer-SECRET-41be';
const CI = 'ci-SECRET-90dd';
const SECRETS = [OP, VIEW, CI];
const hdr = (k: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json', ...extra });
const auth = {
  strategy: 'api-key',
  apiKeys: [
    { key: OP, name: 'ops' },
    { key: VIEW, name: 'oncall', servers: ['fake'] },
    { key: CI, name: 'ci', servers: ['fake'] },
  ],
};
const policy = { rules: [{ name: 'ci-no-echo', clients: ['key:ci'], tools: ['echo'], effect: 'deny', message: 'CI may not echo' }] };

async function start(extra: Record<string, unknown> = {}) {
  h = await startFeatureGw({ auth, policy, controlPlane: { configApi: true, console: { viewers: ['key:oncall'] } }, ...extra } as never);
  return h;
}
const get = async (path: string, key = OP) => {
  const r = await fetch(`${h!.base}/api/v1/admin/ops/${path}`, { headers: hdr(key) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const call = async (key: string, tool: string, extra: Record<string, string> = {}) => {
  const r = await fetch(`${h!.base}/api/v1/tools/call`, { method: 'POST', headers: hdr(key, extra), body: JSON.stringify({ server: 'fake', tool, arguments: { text: 'hi' } }) });
  return { status: r.status, body: (await r.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const noSecrets = (v: unknown) => {
  const s = JSON.stringify(v);
  for (const k of SECRETS) expect(s).not.toContain(k);
};

describe('call lineage (15.1.0)', () => {
  it('L1 one call → identity, generation, decision, target, upstream, correlation id', async () => {
    await start();
    const ok = await call(OP, 'echo', { 'x-request-id': 'motionary-edit-42' });
    expect(ok.status).toBe(200);
    const id = ok.body.requestId as string;
    const l = await get(`lineage/${encodeURIComponent(id)}`);
    expect(l.status).toBe(200);
    const gen = (await get('cluster')).body.generation.current;
    expect(l.body).toMatchObject({
      requestId: id,
      correlationId: 'motionary-edit-42',
      identity: { subject: 'key:ops', chain: ['key:ops'] },
      tenant: null,
      generation: gen,
      target: { serverId: 'fake', tool: 'echo', kind: 'tool', via: 'rest' },
      decision: { outcome: 'ok' },
      upstream: { status: 'ok', ms: expect.any(Number) },
      cost: null,
    });
    expect(typeof l.body.at).toBe('string');
    noSecrets(l.body);
  });

  it('L2 lookup by correlation id; the gateway request id stays the unique key', async () => {
    await start();
    const a = await call(OP, 'echo', { 'x-correlation-id': 'edit-7' });
    const b = await call(OP, 'add', { 'x-correlation-id': 'edit-7' });
    await call(OP, 'echo');
    expect(a.body.requestId).not.toBe(b.body.requestId);
    const l = await get('lineage?correlationId=edit-7');
    expect(l.status).toBe(200);
    expect(l.body.lineage.map((x: { requestId: string }) => x.requestId).sort()).toEqual([a.body.requestId, b.body.requestId].sort());
    expect(l.body.total).toBe(2);
    expect((await get('lineage?correlationId=nothing-here')).body).toMatchObject({ lineage: [], total: 0 });
    // the same charset / length rule as the X-Request-Id header
    expect((await get(`lineage?correlationId=${encodeURIComponent('bad id\n')}`)).status).toBe(400);
    expect((await get('lineage')).status).toBe(400);
    // a call without a client correlation id has none in its lineage (the generated header id is not a correlation id)
    const plain = await call(OP, 'echo');
    expect((await get(`lineage/${encodeURIComponent(plain.body.requestId)}`)).body.correlationId).toBeNull();
  });

  it('L3 a refused call: the deciding layer, rule and config path', async () => {
    await start();
    const denied = await call(CI, 'echo', { 'x-request-id': 'ci-run-1' });
    expect(denied.status).toBeGreaterThanOrEqual(400);
    const id = (await get('traces?outcome=denied&limit=1')).body.traces[0].requestId;
    const l = await get(`lineage/${encodeURIComponent(id)}`);
    expect(l.status).toBe(200);
    expect(l.body).toMatchObject({ correlationId: 'ci-run-1', identity: { subject: 'key:ci' }, decision: { outcome: 'denied', decision: 'deny', rule: 'ci-no-echo' } });
    expect(String(l.body.decision.configPath)).toMatch(/^policy\.rules\[0\]/);
    expect(l.body.upstream).toMatchObject({ status: 'skipped' });
    noSecrets(l.body);
  });

  it('L4 tenant and cost of the call', async () => {
    await start({
      tenants: [{ id: 'acme', servers: ['fake'], members: [{ client: 'key:ci', role: 'admin' }] }],
      policy: { rules: [] },
      costs: { tools: [{ match: 'fake/*', perCall: 0.25 }] },
    });
    const ok = await call(CI, 'echo');
    expect(ok.status).toBe(200);
    const l = await get(`lineage/${encodeURIComponent(ok.body.requestId)}`);
    expect(l.body).toMatchObject({ tenant: 'acme', cost: 0.25, identity: { subject: 'key:ci' } });
  });

  it('L5 access: operators and console viewers only; unknown ids 404, prototype keys never match', async () => {
    await start();
    const ok = await call(OP, 'echo', { 'x-request-id': 'r-1' });
    const id = encodeURIComponent(ok.body.requestId);
    expect((await get(`lineage/${id}`, VIEW)).status).toBe(200);
    expect((await get(`lineage/${id}`, CI)).status).toBe(403);
    expect((await get('lineage?correlationId=r-1', CI)).status).toBe(403);
    expect((await get('lineage/nope')).status).toBe(404);
    expect((await get('lineage/__proto__')).status).toBe(404);
    expect((await get('lineage/constructor')).status).toBe(404);
    expect((await get('lineage?correlationId=__proto__')).body).toMatchObject({ lineage: [], total: 0 });
  });

  it('L6 frozen surface unchanged: the 14.8 trace keeps its fields; lineage fields are additions', async () => {
    await start();
    const ok = await call(OP, 'echo', { 'x-request-id': 'r-2' });
    const t = await get(`traces/${encodeURIComponent(ok.body.requestId)}`);
    expect(t.status).toBe(200);
    for (const k of ['requestId', 'at', 'serverId', 'tool', 'kind', 'via', 'clientId', 'success', 'outcome', 'totalMs', 'steps']) expect(t.body).toHaveProperty(k);
    // the REST response of the call itself is unchanged (no lineage fields leak to clients)
    expect(Object.keys(ok.body).sort()).not.toContain('lineage');
    expect(ok.body).not.toHaveProperty('correlationId');
    expect(ok.body).not.toHaveProperty('generation');
  });
});
