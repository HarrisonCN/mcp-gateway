/**
 * Approvals 2.0 (7.7): multi-step, conditional approval flows with named approvers and escalation.
 *
 * The 1.x approvals hold a call until *an operator* approves it. An **approval flow** holds matching calls until each
 * of its **steps** is approved by the required number of **approvers** (client-id globs — any authenticated client,
 * not only operators). Flows and steps can be **conditional** on the arguments; a step can **escalate** to more
 * approvers after a while. A denial at any step, or the flow timeout, refuses the call (JSON-RPC -32004, as 1.x).
 *
 * ```yaml
 * approvalFlows:
 *   flows:
 *     - id: payments
 *       tools: ["payments/transfer"]          # server/tool globs
 *       when: [{ path: amount, op: gte, value: 1000 }]
 *       timeoutSeconds: 900
 *       steps:
 *         - { name: lead, approvers: ["key:lead-*"] }
 *         - name: finance
 *           approvers: ["key:fin-*"]
 *           required: 2
 *           when: [{ path: amount, op: gte, value: 10000 }]   # only for large transfers
 *           escalateAfterSeconds: 300
 *           escalateTo: ["key:cfo"]
 * ```
 *
 * Conditions: `{ path, op, value }` on the arguments (dot path), `op` ∈ `eq ne gt gte lt lte in matches exists`.
 * The requester can never approve its own call; one approval per client per step.
 *
 * Approvers (any client): `GET /api/v1/features/approval-flows/inbox`, `GET …/mine`,
 * `POST /api/v1/features/approval-flows/:id/approve|deny` `{ reason? }`.
 * Operators: `GET /api/v1/admin/approval-flows`, `POST /api/v1/admin/approval-flows/:id/approve|deny` (override),
 * `POST /api/v1/admin/approval-flows/evaluate` `{ server, tool, client?, arguments? }` (which flow / steps would apply).
 *
 * @module features/approval-flows
 */

import { randomUUID } from 'node:crypto';
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { registerFeature, objectBody, badRequest, clientIdOf } from '../gateway/features.js';
import { registerCallHook } from '../gateway/hooks.js';
import { ERR_APPROVAL_REJECTED } from '../gateway/invoker.js';
import { globToRegExp } from '../utils/tool-filter.js';
import { redactValue } from '../security/redact.js';
import type { GatewayConfig } from '../utils/types.js';
import { ApprovalFlowsConfig, ApprovalFlowsSchema, Cond, Flow, Step } from './schemas/approval-flows.js';
export { ApprovalFlowsConfig, ApprovalFlowsSchema } from './schemas/approval-flows.js';
type Cfg = z.output<typeof ApprovalFlowsSchema>;
type FlowT = z.output<typeof Flow>;
type CondT = z.output<typeof Cond>;

const get = (obj: unknown, path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);

/** Evaluate one condition against the call arguments. */
export function test(c: CondT, args: unknown): boolean {
  const v = get(args, c.path);
  switch (c.op) {
    case 'exists':
      return v !== undefined;
    case 'eq':
      return JSON.stringify(v) === JSON.stringify(c.value);
    case 'ne':
      return JSON.stringify(v) !== JSON.stringify(c.value);
    case 'in':
      return (c.value as unknown[]).some((x) => JSON.stringify(x) === JSON.stringify(v));
    case 'matches':
      return typeof v === 'string' && new RegExp(String(c.value)).test(v);
    default: {
      const a = Number(v);
      const b = Number(c.value);
      if (v === undefined || v === null || Number.isNaN(a) || Number.isNaN(b)) return false;
      return c.op === 'gt' ? a > b : c.op === 'gte' ? a >= b : c.op === 'lt' ? a < b : a <= b;
    }
  }
}
const all = (cs: CondT[], args: unknown) => cs.every((c) => test(c, args));
const anyGlob = (ps: readonly string[], v: string) => ps.some((p) => globToRegExp(p).test(v));

/** First flow matching a call, with the steps that apply to it. */
export function matchFlow(c: Cfg, call: { serverId: string; tool: string; clientId?: string; args: unknown }): { flow: FlowT; steps: FlowT['steps'] } | undefined {
  const target = `${call.serverId}/${call.tool}`;
  for (const f of c.flows) {
    if (!anyGlob(f.tools, target)) continue;
    if (f.clients && !anyGlob(f.clients, call.clientId ?? 'anonymous')) continue;
    if (!all(f.when, call.args)) continue;
    return { flow: f, steps: f.steps.filter((s) => all(s.when, call.args)) };
  }
  return undefined;
}

export interface FlowStepState {
  name: string;
  approvers: string[];
  required: number;
  escalateTo: string[];
  escalated: boolean;
  status: 'waiting' | 'pending' | 'approved';
  approvals: Array<{ by: string; at: string; reason?: string }>;
}
export interface FlowRequest {
  id: string;
  flow: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  clientId?: string;
  serverId: string;
  tool: string;
  arguments: unknown;
  steps: FlowStepState[];
  current: number;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
}

export class FlowError extends Error {
  constructor(message: string, readonly status: 403 | 404 | 409) {
    super(message);
  }
}

interface Held {
  req: FlowRequest;
  resolve: (r: FlowRequest) => void;
  timers: NodeJS.Timeout[];
}

export class FlowQueue {
  private held = new Map<string, Held>();
  history: FlowRequest[] = [];
  constructor(private historySize = 200) {}

  start(flow: FlowT, steps: FlowT['steps'], call: { serverId: string; tool: string; clientId?: string; args: unknown }): Promise<FlowRequest> {
    const now = Date.now();
    const req: FlowRequest = {
      id: randomUUID(),
      flow: flow.id,
      status: 'pending',
      clientId: call.clientId,
      serverId: call.serverId,
      tool: call.tool,
      arguments: redactValue(call.args),
      steps: steps.map((s, i) => ({ name: s.name, approvers: s.approvers, required: s.required, escalateTo: s.escalateTo, escalated: false, status: i === 0 ? 'pending' : 'waiting', approvals: [] })),
      current: 0,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + flow.timeoutSeconds * 1000).toISOString(),
    };
    return new Promise<FlowRequest>((resolve) => {
      const h: Held = { req, resolve, timers: [] };
      this.held.set(req.id, h);
      const t = setTimeout(() => this.finish(req.id, 'expired', undefined, 'not approved in time'), flow.timeoutSeconds * 1000);
      t.unref();
      h.timers.push(t);
      this.armEscalation(h, steps);
    });
  }

  private armEscalation(h: Held, steps: FlowT['steps']): void {
    const s = steps[h.req.current];
    if (!s?.escalateAfterSeconds || !s.escalateTo.length) return;
    const idx = h.req.current;
    const t = setTimeout(() => {
      if (h.req.status === 'pending' && h.req.current === idx) h.req.steps[idx]!.escalated = true;
    }, s.escalateAfterSeconds * 1000);
    t.unref();
    h.timers.push(t);
    (h as Held & { steps?: FlowT['steps'] }).steps = steps;
  }

  private finish(id: string, status: FlowRequest['status'], by?: string, reason?: string): FlowRequest | undefined {
    const h = this.held.get(id);
    if (!h) return undefined;
    this.held.delete(id);
    for (const t of h.timers) clearTimeout(t);
    h.req.status = status;
    h.req.decidedAt = new Date().toISOString();
    if (by) h.req.decidedBy = by;
    if (reason) h.req.reason = reason;
    this.history.unshift(h.req);
    if (this.history.length > this.historySize) this.history.length = this.historySize;
    h.resolve(h.req);
    return h.req;
  }

  /** May `client` act on the current step of `req`? */
  canApprove(req: FlowRequest, client: string): boolean {
    const s = req.steps[req.current];
    if (!s || req.status !== 'pending' || client === req.clientId) return false;
    return anyGlob(s.approvers, client) || (s.escalated && anyGlob(s.escalateTo, client));
  }

  /** Approve / deny the current step. `override` (operators) skips the approver check and completes the step. */
  decide(id: string, approve: boolean, by: string, reason?: string, override = false): FlowRequest {
    const h = this.held.get(id);
    if (!h) {
      if (this.history.some((x) => x.id === id)) throw new FlowError('Approval request was already decided', 409);
      throw new FlowError('Approval request not found', 404);
    }
    const req = h.req;
    if (by === req.clientId && !override) throw new FlowError('A client cannot approve its own tool call', 403);
    if (!override && !this.canApprove(req, by)) throw new FlowError(`Not an approver of step "${req.steps[req.current]!.name}"`, 403);
    const step = req.steps[req.current]!;
    if (!approve) return this.finish(id, 'denied', by, reason ?? `denied at step "${step.name}"`)!;
    if (step.approvals.some((a) => a.by === by)) throw new FlowError('Already approved this step', 409);
    step.approvals.push({ by, at: new Date().toISOString(), ...(reason ? { reason } : {}) });
    if (override || step.approvals.length >= step.required) {
      step.status = 'approved';
      req.current++;
      if (req.current >= req.steps.length) return this.finish(id, 'approved', by)!;
      req.steps[req.current]!.status = 'pending';
      const steps = (h as Held & { steps?: FlowT['steps'] }).steps;
      if (steps) this.armEscalation(h, steps);
    }
    return req;
  }

  pending(): FlowRequest[] {
    return [...this.held.values()].map((h) => h.req);
  }
  get(id: string): FlowRequest | undefined {
    return this.held.get(id)?.req ?? this.history.find((x) => x.id === id);
  }
  close(): void {
    for (const id of [...this.held.keys()]) this.finish(id, 'expired', undefined, 'gateway stopped');
  }
}

export const flowQueue = new FlowQueue();

const settings = (cfg: GatewayConfig): Cfg | undefined => {
  if (!cfg.approvalFlows) return undefined;
  const c = ApprovalFlowsSchema.parse(cfg.approvalFlows);
  return c.enabled ? c : undefined;
};

registerCallHook({
  id: 'approval-flows',
  before: async (call, cfg) => {
    const c = settings(cfg);
    if (!c) return;
    const m = matchFlow(c, call);
    if (!m || !m.steps.length) return;
    const r = await flowQueue.start(m.flow, m.steps, call);
    if (r.status === 'approved') return;
    const step = r.steps[Math.min(r.current, r.steps.length - 1)];
    return {
      refuse: {
        code: ERR_APPROVAL_REJECTED,
        message: r.status === 'expired' ? `Tool call was not approved in time (flow ${r.flow}, step ${step?.name})` : `Tool call was denied (flow ${r.flow}, step ${step?.name})`,
        data: { flow: r.flow, step: step?.name, approval: r.status, requestId: r.id, ...(r.reason ? { reason: r.reason } : {}) },
      },
    };
  },
});

function decideRoute(router: Router, operator: boolean): void {
  for (const action of ['approve', 'deny'] as const) {
    router.post(`/:id/${action}`, (req: Request, res: Response) => {
      const b = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
      const by = clientIdOf(req) ?? 'anonymous';
      try {
        const r = flowQueue.decide(String(req.params.id), action === 'approve', operator ? `operator:${by}` : by, typeof b.reason === 'string' ? b.reason : undefined, operator);
        res.json(r);
      } catch (err) {
        if (err instanceof FlowError) return void res.status(err.status).json({ error: err.status === 404 ? 'Not Found' : err.status === 409 ? 'Conflict' : 'Forbidden', message: err.message });
        throw err;
      }
    });
  }
}

registerFeature({
  id: 'approval-flows',
  since: '7.7.0',
  summary: 'Approvals 2.0: multi-step, conditional approval flows with named approvers and escalation',
  mount: (router, ctx) => {
    ctx.onStop?.(() => flowQueue.close());
    router.get('/', (_req, res) => {
      const c = settings(ctx.config());
      res.json({ enabled: !!c, flows: c?.flows ?? [], pending: flowQueue.pending(), recent: flowQueue.history.slice(0, 50) });
    });
    router.post('/evaluate', (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      if (typeof b.server !== 'string' || typeof b.tool !== 'string') return badRequest(res, 'Body must be { "server", "tool", "client"?, "arguments"? }');
      const c = settings(ctx.config());
      const m = c ? matchFlow(c, { serverId: b.server, tool: b.tool, clientId: typeof b.client === 'string' ? b.client : undefined, args: b.arguments ?? {} }) : undefined;
      res.json(m ? { flow: m.flow.id, steps: m.steps.map((s) => ({ name: s.name, approvers: s.approvers, required: s.required })), held: m.steps.length > 0 } : { flow: null, steps: [], held: false });
    });
    router.get('/:id', (req, res) => {
      const r = flowQueue.get(req.params.id!);
      if (!r) return void res.status(404).json({ error: 'Not Found', message: 'Approval request not found' });
      res.json(r);
    });
    decideRoute(router, true);
  },
  mountClient: (router) => {
    router.get('/inbox', (req, res) => {
      const me = clientIdOf(req) ?? 'anonymous';
      res.json({ client: me, pending: flowQueue.pending().filter((r) => flowQueue.canApprove(r, me)) });
    });
    router.get('/mine', (req, res) => {
      const me = clientIdOf(req) ?? 'anonymous';
      res.json({ client: me, pending: flowQueue.pending().filter((r) => r.clientId === me), recent: flowQueue.history.filter((r) => r.clientId === me).slice(0, 50) });
    });
    decideRoute(router, false);
  },
});
