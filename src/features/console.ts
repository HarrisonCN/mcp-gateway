/**
 * Multi-tenant SaaS console (7.2): organisations on top of tenants, with plans, daily call limits and suspension.
 *
 * An **organisation** is a tenant (`tenants[]`, 2.x) plus an entry in `console.orgs` that gives it a **plan**. A plan
 * decides which servers the org's tenant gets (`servers` globs) and how many tool calls its members may make per UTC
 * day (`callsPerDay`). Calls over the limit, or from a suspended org, are refused with JSON-RPC error **-32016**
 * (`data.reason`: `limit` | `suspended`).
 *
 * ```yaml
 * console:
 *   defaultPlan: free
 *   plans:
 *     free: { servers: ["search"], callsPerDay: 1000 }
 *     pro:  { servers: ["*"], callsPerDay: 100000 }
 *   orgs:
 *     acme: { plan: pro }
 * tenants:
 *   - { id: acme, name: ACME, servers: ["*"], members: [{ client: "key:acme-*", role: owner }] }
 * ```
 *
 * - `GET    /admin/console` — plans, orgs (members, plan, usage today, remaining), totals.
 * - `POST   /admin/console/orgs` — onboard `{ id, name?, plan?, owner? }`: creates the tenant (plan servers, `owner`
 *   as its owner member) and the org entry. Needs `controlPlane.configApi: true`.
 * - `GET    /admin/console/orgs/:id` — one org.
 * - `PATCH  /admin/console/orgs/:id` — `{ plan?, name?, suspended? }`; a plan change re-scopes the tenant's servers.
 * - `DELETE /admin/console/orgs/:id` — offboard (removes the org and its tenant).
 * - `POST   /admin/console/orgs/:id/reset-usage` — clear today's counter.
 *
 * @module features/console
 */

import type { Response, Router } from 'express';
import { z } from 'zod';
import { registerFeature, objectBody, badRequest, type FeatureContext } from '../gateway/features.js';
import { registerCallHook } from '../gateway/hooks.js';
import { portableConfig } from '../gateway/admin.js';
import type { GatewayConfig } from '../utils/types.js';

export const ERR_ORG_REFUSED = -32016;

const Id = z.string().min(1).regex(/^[A-Za-z0-9._-]+$/, 'letters, digits, ".", "_" and "-" only');
const PlanSchema = z.object({ name: z.string().optional(), servers: z.array(z.string().min(1)).min(1), callsPerDay: z.number().int().min(0).optional() }).strict();
export const ConsoleSchema = z
  .object({
    enabled: z.boolean().default(true),
    defaultPlan: z.string().min(1).optional(),
    plans: z.record(PlanSchema).default({}),
    orgs: z.record(z.object({ plan: z.string().min(1), suspended: z.boolean().default(false) }).strict()).default({}),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.defaultPlan && !c.plans[c.defaultPlan]) ctx.addIssue({ code: 'custom', path: ['defaultPlan'], message: `unknown plan "${c.defaultPlan}"` });
    for (const [id, o] of Object.entries(c.orgs)) {
      if (!Id.safeParse(id).success) ctx.addIssue({ code: 'custom', path: ['orgs', id], message: 'org ids are letters, digits, ".", "_" and "-"' });
      if (!c.plans[o.plan]) ctx.addIssue({ code: 'custom', path: ['orgs', id, 'plan'], message: `unknown plan "${o.plan}"` });
    }
  });
export type ConsoleConfig = z.input<typeof ConsoleSchema>;
type Cfg = z.output<typeof ConsoleSchema>;

const settings = (cfg: GatewayConfig): Cfg | undefined => {
  if (!cfg.console) return undefined;
  const c = ConsoleSchema.parse(cfg.console);
  return c.enabled ? c : undefined;
};

const dayOf = (d = new Date()) => d.toISOString().slice(0, 10);

/** Calls per org for the current UTC day. */
export class DailyCounter {
  private day = dayOf();
  private counts = new Map<string, number>();
  constructor(private readonly now: () => Date = () => new Date()) {}
  private roll(): void {
    const d = dayOf(this.now());
    if (d !== this.day) {
      this.day = d;
      this.counts.clear();
    }
  }
  get(org: string): number {
    this.roll();
    return this.counts.get(org) ?? 0;
  }
  inc(org: string): number {
    this.roll();
    const n = (this.counts.get(org) ?? 0) + 1;
    this.counts.set(org, n);
    return n;
  }
  reset(org: string): void {
    this.counts.delete(org);
  }
}

export const consoleCounter = new DailyCounter();

/** Decide whether `org` may make one more call (and count it when allowed). */
export function admitCall(c: Cfg, org: string, counter = consoleCounter): { ok: true } | { ok: false; reason: 'suspended' | 'limit'; message: string; data: Record<string, unknown> } {
  const o = c.orgs[org];
  if (!o) return { ok: true };
  if (o.suspended) return { ok: false, reason: 'suspended', message: `Organisation "${org}" is suspended`, data: { org, reason: 'suspended' } };
  const limit = c.plans[o.plan]?.callsPerDay;
  if (limit !== undefined && counter.get(org) >= limit) {
    return { ok: false, reason: 'limit', message: `Organisation "${org}" reached its daily limit of ${limit} calls (plan ${o.plan})`, data: { org, reason: 'limit', plan: o.plan, limit, used: counter.get(org) } };
  }
  counter.inc(org);
  return { ok: true };
}

registerCallHook({
  id: 'console',
  before: (call, cfg) => {
    const c = settings(cfg);
    if (!c || !call.tenant) return;
    const r = admitCall(c, call.tenant);
    if (!r.ok) return { refuse: { code: ERR_ORG_REFUSED, message: r.message, data: r.data } };
  },
});

type Obj = Record<string, unknown>;

function mount(router: Router, ctx: FeatureContext): void {
  const need = (res: Response): Cfg | undefined => {
    const c = settings(ctx.config());
    if (!c) res.status(404).json({ error: 'Not Found', message: 'The console is off (configure `console.plans`)' });
    return c;
  };
  const writable = (res: Response): boolean => {
    if (ctx.config().controlPlane?.configApi !== true || !ctx.applyConfig) {
      res.status(403).json({ error: 'Forbidden', message: 'Console changes need controlPlane.configApi: true' });
      return false;
    }
    return true;
  };
  const view = (c: Cfg, id: string) => {
    const o = c.orgs[id]!;
    const t = (ctx.config().tenants ?? []).find((x) => x.id === id);
    const plan = c.plans[o.plan];
    const used = consoleCounter.get(id);
    return {
      id,
      name: t?.name ?? id,
      plan: o.plan,
      suspended: o.suspended,
      tenant: t ? 'ok' : 'missing',
      servers: t?.servers ?? [],
      members: t?.members ?? [],
      usage: { today: used, limit: plan?.callsPerDay ?? null, remaining: plan?.callsPerDay === undefined ? null : Math.max(0, plan.callsPerDay - used) },
    };
  };
  const write = async (res: Response, next: Obj, status: number, body: () => unknown) => {
    try {
      await ctx.applyConfig!(next);
      res.status(status).json(body());
    } catch (err) {
      badRequest(res, err instanceof Error ? err.message : String(err));
    }
  };
  const parts = () => {
    const p = portableConfig(ctx.config());
    const cons = { ...((p.console as Obj) ?? {}) };
    const orgs = { ...((cons.orgs as Record<string, Obj>) ?? {}) };
    const tenants = ((p.tenants as Obj[]) ?? []).slice();
    return { p, cons, orgs, tenants };
  };

  router.get('/', (_req, res) => {
    const c = need(res);
    if (!c) return;
    const orgs = Object.keys(c.orgs).sort().map((id) => view(c, id));
    res.json({
      defaultPlan: c.defaultPlan ?? null,
      plans: Object.entries(c.plans).map(([id, p]) => ({ id, name: p.name ?? id, servers: p.servers, callsPerDay: p.callsPerDay ?? null, orgs: orgs.filter((o) => o.plan === id).length })),
      orgs,
      totals: { orgs: orgs.length, suspended: orgs.filter((o) => o.suspended).length, callsToday: orgs.reduce((a, o) => a + o.usage.today, 0) },
    });
  });

  router.get('/orgs/:id', (req, res) => {
    const c = need(res);
    if (!c) return;
    if (!c.orgs[req.params.id!]) return void res.status(404).json({ error: 'Not Found', message: `No organisation "${req.params.id}"` });
    res.json(view(c, req.params.id!));
  });

  router.post('/orgs', async (req, res) => {
    const c = need(res);
    if (!c || !writable(res)) return;
    const b = objectBody(req, res);
    if (!b) return;
    const id = Id.safeParse(b.id);
    if (!id.success) return badRequest(res, 'Body needs an "id" (letters, digits, ".", "_" and "-")');
    const plan = typeof b.plan === 'string' ? b.plan : c.defaultPlan;
    if (!plan || !c.plans[plan]) return badRequest(res, plan ? `Unknown plan "${plan}"` : 'Body needs a "plan" (no console.defaultPlan)');
    if (b.owner !== undefined && (typeof b.owner !== 'string' || !b.owner)) return badRequest(res, '"owner" must be a client id glob (e.g. "key:acme-*")');
    const { p, cons, orgs, tenants } = parts();
    if (orgs[id.data] || tenants.some((t) => t.id === id.data)) return void res.status(409).json({ error: 'Conflict', message: `"${id.data}" already exists` });
    orgs[id.data] = { plan };
    tenants.push({ id: id.data, ...(typeof b.name === 'string' && b.name ? { name: b.name } : {}), servers: c.plans[plan]!.servers, ...(b.owner ? { members: [{ client: b.owner, role: 'owner' }] } : {}) });
    await write(res, { ...p, console: { ...cons, orgs }, tenants }, 201, () => view(settings(ctx.config())!, id.data));
  });

  router.patch('/orgs/:id', async (req, res) => {
    const c = need(res);
    if (!c || !writable(res)) return;
    const b = objectBody(req, res);
    if (!b) return;
    const oid = req.params.id!;
    const { p, cons, orgs, tenants } = parts();
    if (!orgs[oid]) return void res.status(404).json({ error: 'Not Found', message: `No organisation "${oid}"` });
    if (b.plan !== undefined && (typeof b.plan !== 'string' || !c.plans[b.plan])) return badRequest(res, `Unknown plan "${String(b.plan)}"`);
    if (b.suspended !== undefined && typeof b.suspended !== 'boolean') return badRequest(res, '"suspended" must be a boolean');
    const org = { ...orgs[oid]!, ...(b.plan ? { plan: b.plan } : {}), ...(b.suspended !== undefined ? { suspended: b.suspended } : {}) };
    orgs[oid] = org;
    const ti = tenants.findIndex((t) => t.id === oid);
    if (ti >= 0) {
      tenants[ti] = { ...tenants[ti]!, ...(b.plan ? { servers: c.plans[b.plan as string]!.servers } : {}), ...(typeof b.name === 'string' && b.name ? { name: b.name } : {}) };
    }
    await write(res, { ...p, console: { ...cons, orgs }, ...(tenants.length ? { tenants } : {}) }, 200, () => view(settings(ctx.config())!, oid));
  });

  router.delete('/orgs/:id', async (req, res) => {
    const c = need(res);
    if (!c || !writable(res)) return;
    const oid = req.params.id!;
    const { p, cons, orgs, tenants } = parts();
    if (!orgs[oid]) return void res.status(404).json({ error: 'Not Found', message: `No organisation "${oid}"` });
    delete orgs[oid];
    const rest = tenants.filter((t) => t.id !== oid);
    const { tenants: _t, ...base } = p;
    consoleCounter.reset(oid);
    await write(res, { ...base, console: { ...cons, orgs }, ...(rest.length ? { tenants: rest } : {}) }, 200, () => ({ removed: oid }));
  });

  router.post('/orgs/:id/reset-usage', (req, res) => {
    const c = need(res);
    if (!c) return;
    if (!c.orgs[req.params.id!]) return void res.status(404).json({ error: 'Not Found', message: `No organisation "${req.params.id}"` });
    consoleCounter.reset(req.params.id!);
    res.json(view(c, req.params.id!));
  });
}

registerFeature({
  id: 'console',
  since: '7.2.0',
  summary: 'SaaS console: organisations with plans (servers, daily call limits), onboarding, suspension',
  mount,
});
