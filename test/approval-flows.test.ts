/** 7.7: approvals 2.0. */
import { describe, it, expect, afterEach } from 'vitest';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';
import { validateConfig } from '../src/config/loader.js';
import { ApprovalFlowsSchema, FlowQueue, matchFlow, test as cond } from '../src/features/approval-flows.js';

let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const flows = {
  flows: [
    {
      id: 'payments',
      tools: ['fake/echo'],
      when: [{ path: 'amount', op: 'gte', value: 1000 }],
      steps: [
        { name: 'lead', approvers: ['key:lead-*'] },
        { name: 'finance', approvers: ['key:fin-*'], required: 2, when: [{ path: 'amount', op: 'gte', value: 10000 }] },
      ],
    },
  ],
};

describe('approvals 2.0 (7.7)', () => {
  it('conditions, matching and validation', () => {
    expect(cond({ path: 'a.b', op: 'eq', value: 1 }, { a: { b: 1 } })).toBe(true);
    expect(cond({ path: 'x', op: 'in', value: ['p', 'q'] }, { x: 'q' })).toBe(true);
    expect(cond({ path: 'x', op: 'matches', value: '^prod' }, { x: 'prod-eu' })).toBe(true);
    expect(cond({ path: 'x', op: 'gt', value: 5 }, { x: 'nope' })).toBe(false);
    expect(cond({ path: 'x', op: 'exists' }, {})).toBe(false);
    expect(cond({ path: 'x', op: 'ne', value: 1 }, { x: 2 })).toBe(true);
    expect(cond({ path: 'x', op: 'lte', value: 5 }, { x: 5 })).toBe(true);
    const c = ApprovalFlowsSchema.parse(flows);
    expect(matchFlow(c, { serverId: 'fake', tool: 'echo', args: { amount: 10 } })).toBeUndefined();
    expect(matchFlow(c, { serverId: 'fake', tool: 'echo', args: { amount: 5000 } })!.steps.map((s) => s.name)).toEqual(['lead']);
    expect(matchFlow(c, { serverId: 'fake', tool: 'echo', args: { amount: 50000 } })!.steps.map((s) => s.name)).toEqual(['lead', 'finance']);
    expect(() => validateConfig({ servers: [], approvalFlows: { flows: [{ id: 'a', tools: ['*'], steps: [] }] } })).toThrow();
    expect(() => validateConfig({ servers: [], approvalFlows: { flows: [{ id: 'a', tools: ['*'], steps: [{ name: 's', approvers: ['x'], when: [{ path: 'p', op: 'matches', value: '(' }] }] }] } })).toThrow(/invalid regular expression/);
  });

  it('queue: steps, required counts, self-approval, escalation, expiry', async () => {
    const q = new FlowQueue();
    const f = ApprovalFlowsSchema.parse({ flows: [{ id: 'f', tools: ['*'], timeoutSeconds: 1, steps: [{ name: 'a', approvers: ['key:a*'], required: 2, escalateAfterSeconds: 1, escalateTo: ['key:boss'] }, { name: 'b', approvers: ['key:b'] }] }] }).flows[0]!;
    const p = q.start(f, f.steps, { serverId: 's', tool: 't', clientId: 'key:a1', args: {} });
    const id = q.pending()[0]!.id;
    expect(() => q.decide(id, true, 'key:a1')).toThrow(/own tool call/);
    expect(() => q.decide(id, true, 'key:b')).toThrow(/Not an approver of step "a"/);
    q.decide(id, true, 'key:a2');
    expect(() => q.decide(id, true, 'key:a2')).toThrow(/Already approved/);
    expect(q.canApprove(q.get(id)!, 'key:boss')).toBe(false);
    await new Promise((r) => setTimeout(r, 1100));
    // escalation and expiry share the 1 s; whichever fired, the request ends expired
    const r = await p;
    expect(r.status).toBe('expired');
    expect(() => q.decide(id, true, 'key:a3')).toThrow(/already decided/);
    const p2 = q.start(f, f.steps, { serverId: 's', tool: 't', clientId: 'key:x', args: {} });
    const id2 = q.pending()[0]!.id;
    q.decide(id2, true, 'operator:op', undefined, true);
    expect(q.get(id2)!.current).toBe(1);
    q.decide(id2, false, 'key:b', 'no');
    expect((await p2).status).toBe('denied');
    expect(() => q.decide('nope', true, 'x')).toThrow(/not found/);
  });

  it('gateway: two-step flow approved by named clients (not operators), denial refuses', async () => {
    h = await startFeatureGw({
      auth: { strategy: 'api-key', apiKeys: ['op', { key: 'req-key', name: 'req' }, { key: 'lead-key', name: 'lead-1' }, { key: 'fin1', name: 'fin-1' }, { key: 'fin2', name: 'fin-2' }] },
      approvalFlows: flows,
    } as never);
    const as = (key: string) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' });
    const call = (amount: number) => fetch(`${h!.base}/api/v1/tools/call`, { method: 'POST', headers: as('req-key'), body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: { amount } }) }).then(async (r) => ({ status: r.status, body: JSON.stringify(await r.json()) }));
    const feat = (key: string, path: string, body?: unknown) => fetch(`${h!.base}/api/v1/features/approval-flows/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: as(key), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then(async (r) => ({ status: r.status, body: (await r.json()) as any })); // eslint-disable-line @typescript-eslint/no-explicit-any
    const waitPending = async () => {
      for (let i = 0; i < 50; i++) {
        const p = (await h!.admin('approval-flows')).body.pending;
        if (p.length) return p[0];
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('no pending request');
    };

    expect((await call(10)).status).toBe(200); // below the threshold: not held
    const big = call(20000);
    const req = await waitPending();
    expect(req.steps.map((s: any) => `${s.name}:${s.status}`)).toEqual(['lead:pending', 'finance:waiting']); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await feat('fin1', 'inbox')).body.pending).toEqual([]);
    expect((await feat('lead-key', 'inbox')).body.pending).toHaveLength(1);
    expect((await feat('req-key', `${req.id}/approve`, {})).status).toBe(403);
    expect((await feat('req-key', 'mine')).body.pending).toHaveLength(1);
    expect((await feat('lead-key', `${req.id}/approve`, { reason: 'ok' })).body.current).toBe(1);
    expect((await feat('fin1', 'inbox')).body.pending).toHaveLength(1);
    expect((await feat('fin1', `${req.id}/approve`, {})).body.steps[1].approvals).toHaveLength(1);
    expect((await feat('fin2', `${req.id}/approve`, {})).body.status).toBe('approved');
    expect((await big).status).toBe(200);

    const denied = call(5000);
    const r2 = await waitPending();
    expect((await feat('lead-key', `${r2.id}/deny`, { reason: 'too much' })).body.status).toBe('denied');
    const d = await denied;
    expect(d.body).toContain('-32004');
    expect(d.body).toContain('payments');
    expect((await feat('lead-key', `${r2.id}/approve`, {})).status).toBe(409);
    expect((await feat('lead-key', 'nope/approve', {})).status).toBe(404);

    // operator override + evaluate
    const ov = call(5000);
    const r3 = await waitPending();
    expect((await h.admin(`approval-flows/${r3.id}/approve`, {})).body.status).toBe('approved');
    expect((await ov).status).toBe(200);
    expect((await h.admin(`approval-flows/${r3.id}`)).body.decidedBy).toMatch(/^operator:/);
    const ev = await h.admin('approval-flows/evaluate', { server: 'fake', tool: 'echo', arguments: { amount: 99999 } });
    expect(ev.body).toMatchObject({ flow: 'payments', held: true, steps: [{ name: 'lead' }, { name: 'finance', required: 2 }] });
    expect((await h.admin('approval-flows/evaluate', { server: 'x', tool: 'y' })).body.held).toBe(false);
    expect((await h.admin('approval-flows/evaluate', {})).status).toBe(400);
  });
});
