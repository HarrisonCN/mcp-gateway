/**
 * Policy-as-code 2.0 (10.5): Cedar policies evaluated in-process and Rego policies evaluated by an external
 * [Open Policy Agent](https://www.openpolicyagent.org/), on every tool call, with policy unit tests and change-impact
 * analysis. Runs as a call hook after the built-in `policy.rules`, so both must allow a call.
 *
 * ```yaml
 * features:
 *   policyEngine:
 *     mode: enforce              # or shadow: evaluate and record, never block
 *     cedar: |
 *       @id("read-anything")
 *       permit(principal, action == Action::"callTool", resource) when { resource.tool like "read_*" };
 *       @id("no-deletes-for-interns")
 *       forbid(principal in Tenant::"interns", action, resource) when { resource.tool like "*delete*" };
 *     cedarFiles: [policies/base.cedar]     # relative to the config file
 *     opa:                                  # Rego lives in OPA; the gateway sends { input } to its data API
 *       url: http://opa:8181
 *       path: mcp/gateway/allow             # POST <url>/v1/data/<path>; result true / { allow, reason }
 *       timeoutMs: 500
 *       onError: deny                       # or allow
 *     tests:
 *       - { name: interns cannot delete, request: { client: "key:bob", tenant: interns, server: fs, tool: delete_file }, expect: deny }
 * ```
 *
 * When Cedar policies are configured the Cedar default applies: a call no `permit` matches is **denied**. With
 * both engines, a call must be allowed by both (deny overrides).
 *
 * Admin API (`/api/v1/admin/policy-engine`, operators): `GET /` status and shadow divergences; `POST /evaluate`
 * one request with the deciding policies; `POST /test` the configured (or given) tests; `POST /impact` a candidate
 * Cedar policy set replayed against past calls (captured calls with arguments when `replay.enabled`, otherwise
 * recent metrics without arguments) with every changed decision. `mcp-gateway policy test` runs the tests too.
 *
 * @module features/policy-engine
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod';
import { registerFeature, objectBody, badRequest } from '../gateway/features.js';
import { registerCallHook } from '../gateway/hooks.js';
import { evaluateCedar, parseCedar, toCedarRequest, type CedarDecision, type CedarPolicy } from '../policy/cedar.js';
import type { GatewayConfig } from '../utils/types.js';
import { logger } from '../utils/logger.js';
import { type PolicyEngineConfig, PolicyEngineSchema, TestSchema } from './schemas/policy-engine.js';
export { type PolicyEngineConfig, PolicyEngineSchema } from './schemas/policy-engine.js';
type Parsed = z.output<typeof PolicyEngineSchema>;

export interface EngineRequest {
  clientId?: string;
  tenant?: string;
  serverId: string;
  tool: string;
  args?: Record<string, unknown>;
  via?: string;
}

export interface EngineDecision {
  decision: 'allow' | 'deny';
  cedar?: CedarDecision;
  opa?: { decision: 'allow' | 'deny'; reason?: string; error?: string };
}

/** Same code as `policy.rules` denials (REST maps it to 403). */
const ERR_POLICY_DENIED = -32003;

const cache = new Map<string, CedarPolicy[]>();

/** All Cedar policies of a config (inline text + files), parsed; cached by source. */
export function cedarPolicies(cfg: Parsed, configDir?: string): CedarPolicy[] | undefined {
  const sources: string[] = [];
  if (cfg.cedar !== undefined) sources.push(cfg.cedar);
  for (const f of cfg.cedarFiles ?? []) sources.push(readFileSync(resolve(configDir ?? process.cwd(), f), 'utf8'));
  if (!sources.length) return undefined;
  const key = sources.join('\n\u0000\n');
  let list = cache.get(key);
  if (!list) {
    list = parseCedar(sources.join('\n'));
    if (cache.size > 32) cache.clear();
    cache.set(key, list);
  }
  return list;
}

/** Ask OPA. */
export async function queryOpa(opa: NonNullable<Parsed['opa']>, input: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<NonNullable<EngineDecision['opa']>> {
  const url = `${opa.url.replace(/\/$/, '')}/v1/data/${opa.path.replace(/^\//, '')}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opa.timeoutMs);
  timer.unref?.();
  try {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(opa.headers ?? {}) }, body: JSON.stringify({ input }), signal: ac.signal });
    if (!res.ok) throw new Error(`OPA answered HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown };
    const r = body.result;
    if (typeof r === 'boolean') return { decision: r ? 'allow' : 'deny' };
    if (r && typeof r === 'object' && typeof (r as { allow?: unknown }).allow === 'boolean') {
      const o = r as { allow: boolean; reason?: unknown };
      return { decision: o.allow ? 'allow' : 'deny', ...(typeof o.reason === 'string' ? { reason: o.reason } : {}) };
    }
    return { decision: 'deny', reason: r === undefined ? 'no decision (undefined result — check the policy path)' : 'result is neither a boolean nor { allow }' };
  } catch (err) {
    const message = (err as Error).name === 'AbortError' ? `timed out after ${opa.timeoutMs} ms` : err instanceof Error ? err.message : String(err);
    return { decision: opa.onError, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/** OPA input document for a call. */
export function opaInput(r: EngineRequest, now = new Date()): Record<string, unknown> {
  return { client: r.clientId ?? 'anonymous', tenant: r.tenant ?? null, server: r.serverId, tool: r.tool, arguments: r.args ?? {}, via: r.via ?? 'rest', time: now.toISOString() };
}

/** Decide one call with a parsed engine config. */
export async function decide(cfg: Parsed, r: EngineRequest, opts: { configDir?: string; policies?: CedarPolicy[]; fetch?: typeof fetch; now?: Date } = {}): Promise<EngineDecision> {
  const out: EngineDecision = { decision: 'allow' };
  const policies = opts.policies ?? cedarPolicies(cfg, opts.configDir);
  if (policies) {
    out.cedar = evaluateCedar(policies, toCedarRequest(r, opts.now));
    if (out.cedar.decision === 'deny') out.decision = 'deny';
  }
  if (cfg.opa) {
    out.opa = await queryOpa(cfg.opa, opaInput(r, opts.now), opts.fetch);
    if (out.opa.decision === 'deny') out.decision = 'deny';
  }
  return out;
}

export interface TestResult {
  name: string;
  expected: 'allow' | 'deny';
  actual: 'allow' | 'deny';
  passed: boolean;
  reasons: string[];
  errors?: string[];
}

/** Run policy tests (`features.policyEngine.tests` or the ones given). */
export async function runEngineTests(cfg: Parsed, tests: z.output<typeof TestSchema>[] = cfg.tests ?? [], opts: { configDir?: string; fetch?: typeof fetch } = {}): Promise<TestResult[]> {
  const out: TestResult[] = [];
  for (const t of tests) {
    const d = await decide(cfg, { clientId: t.request.client, tenant: t.request.tenant, serverId: t.request.server, tool: t.request.tool, args: t.request.args }, opts);
    const errors = [...(d.cedar?.errors.map((e) => `${e.policy}: ${e.message}`) ?? []), ...(d.opa?.error ? [`opa: ${d.opa.error}`] : [])];
    out.push({ name: t.name, expected: t.expect, actual: d.decision, passed: d.decision === t.expect, reasons: [...(d.cedar?.reasons ?? []), ...(d.opa?.reason ? [`opa: ${d.opa.reason}`] : [])], ...(errors.length ? { errors } : {}) });
  }
  return out;
}

/** Parsed engine config of a gateway config, or undefined when off. */
export function engineOf(cfg: GatewayConfig): Parsed | undefined {
  const raw = cfg.policyEngine;
  if (!raw) return undefined;
  const p = PolicyEngineSchema.parse(raw);
  return p.enabled ? p : undefined;
}

export interface ImpactReport {
  source: 'request' | 'replay' | 'metrics';
  calls: number;
  withArguments: number;
  changed: number;
  becameDenied: number;
  becameAllowed: number;
  changes: Array<{ clientId?: string; serverId: string; tool: string; before: 'allow' | 'deny'; after: 'allow' | 'deny'; reasons: string[] }>;
}

/** Replay calls under the current Cedar policies and a candidate set (Cedar only; OPA is not replayed). */
export function cedarImpact(current: CedarPolicy[] | undefined, candidate: CedarPolicy[], calls: EngineRequest[], source: ImpactReport['source']): ImpactReport {
  const changes: ImpactReport['changes'] = [];
  let becameDenied = 0;
  let becameAllowed = 0;
  for (const c of calls) {
    const req = toCedarRequest(c);
    const before = current ? evaluateCedar(current, req).decision : 'allow';
    const a = evaluateCedar(candidate, req);
    if (before !== a.decision) {
      if (a.decision === 'deny') becameDenied++;
      else becameAllowed++;
      if (changes.length < 200) changes.push({ clientId: c.clientId, serverId: c.serverId, tool: c.tool, before, after: a.decision, reasons: a.reasons });
    }
  }
  return { source, calls: calls.length, withArguments: calls.filter((c) => c.args !== undefined).length, changed: becameDenied + becameAllowed, becameDenied, becameAllowed, changes };
}

// ─── Shadow recorder ──────────────────────────────────────────────────────────

const shadow = { evaluated: 0, wouldDeny: 0, recent: [] as Array<{ at: string; clientId?: string; serverId: string; tool: string; reasons: string[] }> };

registerCallHook({
  id: 'policy-engine',
  before: async (call, cfg) => {
    const engine = engineOf(cfg);
    if (!engine) return;
    let d: EngineDecision;
    try {
      d = await decide(engine, { clientId: call.clientId, tenant: call.tenant, serverId: call.serverId, tool: call.tool, args: call.args }, { configDir: cfg.configDir });
    } catch (err) {
      // e.g. an unreadable cedarFile after a reload: fail closed in enforce mode
      const message = `policy engine error: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(message);
      if (engine.mode === 'shadow') return;
      return { refuse: { code: ERR_POLICY_DENIED, message, data: { decision: 'deny' } } };
    }
    if (engine.mode === 'shadow') shadow.evaluated++;
    for (const e of d.cedar?.errors ?? []) logger.warn(`Cedar policy "${e.policy}" errored for ${call.serverId}/${call.tool}: ${e.message}`);
    if (d.decision === 'allow') return;
    const reasons = [...(d.cedar?.reasons ?? []), ...(d.opa ? [`opa${d.opa.reason ? `: ${d.opa.reason}` : ''}${d.opa.error ? ` (error: ${d.opa.error})` : ''}`] : [])];
    if (engine.mode === 'shadow') {
      shadow.wouldDeny++;
      shadow.recent.push({ at: new Date().toISOString(), clientId: call.clientId, serverId: call.serverId, tool: call.tool, reasons });
      if (shadow.recent.length > 200) shadow.recent.shift();
      return;
    }
    const why = d.cedar?.decision === 'deny' ? (d.cedar.reasons.length ? `forbidden by Cedar policy ${d.cedar.reasons.join(', ')}` : 'no Cedar policy permits it') : `denied by OPA${d.opa?.reason ? ` (${d.opa.reason})` : ''}${d.opa?.error ? ` (${d.opa.error})` : ''}`;
    return { refuse: { code: ERR_POLICY_DENIED, message: `Call to ${call.serverId}/${call.tool} ${why}`, data: { decision: 'deny', engine: d.cedar?.decision === 'deny' ? 'cedar' : 'opa', policies: d.cedar?.reasons ?? [] } } };
  },
});

const parseReq = (b: Record<string, unknown>): EngineRequest | string => {
  if (typeof b.server !== 'string' || typeof b.tool !== 'string') return '"server" and "tool" are required';
  if (b.arguments !== undefined && (typeof b.arguments !== 'object' || b.arguments === null || Array.isArray(b.arguments))) return '"arguments" must be an object';
  return { clientId: typeof b.client === 'string' ? b.client : undefined, tenant: typeof b.tenant === 'string' ? b.tenant : undefined, serverId: b.server, tool: b.tool, args: (b.arguments as Record<string, unknown>) ?? {} };
};

registerFeature({
  id: 'policy-engine',
  since: '10.5.0',
  summary: 'Policy-as-code 2.0: Cedar policies in-process, Rego via OPA, policy unit tests and change-impact analysis',
  mount: (router, ctx) => {
    router.get('/', (_req, res) => {
      const cfg = ctx.config();
      const engine = engineOf(cfg);
      let policies: Array<{ id: string; effect: string }> = [];
      let error: string | undefined;
      try {
        policies = engine ? (cedarPolicies(engine, cfg.configDir) ?? []).map((p) => ({ id: p.id, effect: p.effect })) : [];
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      res.json({
        enabled: !!engine,
        mode: engine?.mode ?? null,
        cedar: { policies, ...(error ? { error } : {}) },
        opa: engine?.opa ? { url: engine.opa.url, path: engine.opa.path, onError: engine.opa.onError } : null,
        tests: engine?.tests?.length ?? 0,
        shadow: engine?.mode === 'shadow' ? { evaluated: shadow.evaluated, wouldDeny: shadow.wouldDeny, recent: [...shadow.recent].reverse().slice(0, 50) } : null,
      });
    });
    router.post('/evaluate', async (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      const r = parseReq(b);
      if (typeof r === 'string') return badRequest(res, r);
      const cfg = ctx.config();
      const engine = engineOf(cfg);
      if (!engine) return badRequest(res, 'features.policyEngine is not configured');
      res.json({ request: r, ...(await decide(engine, r, { configDir: cfg.configDir })) });
    });
    router.post('/test', async (req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const cfg = ctx.config();
      const engine = engineOf(cfg);
      if (!engine) return badRequest(res, 'features.policyEngine is not configured');
      let tests = engine.tests ?? [];
      if (b.tests !== undefined) {
        const t = z.array(TestSchema).safeParse(b.tests);
        if (!t.success) return badRequest(res, `invalid tests: ${t.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
        tests = t.data;
      }
      const results = await runEngineTests(engine, tests, { configDir: cfg.configDir });
      res.json({ total: results.length, failed: results.filter((r) => !r.passed).length, results });
    });
    router.post('/impact', (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      if (typeof b.cedar !== 'string') return badRequest(res, '"cedar" (the candidate policy set) is required');
      let candidate: CedarPolicy[];
      try {
        candidate = parseCedar(b.cedar);
      } catch (err) {
        return badRequest(res, err instanceof Error ? err.message : String(err));
      }
      const cfg = ctx.config();
      const engine = engineOf(cfg);
      let current: CedarPolicy[] | undefined;
      try {
        current = engine ? cedarPolicies(engine, cfg.configDir) : undefined;
      } catch (err) {
        return badRequest(res, `current policies: ${err instanceof Error ? err.message : String(err)}`);
      }
      let calls: EngineRequest[];
      let source: ImpactReport['source'];
      if (Array.isArray(b.calls)) {
        const parsed = b.calls.map((c) => (c && typeof c === 'object' ? parseReq(c as Record<string, unknown>) : 'invalid call'));
        const bad = parsed.find((p) => typeof p === 'string');
        if (bad) return badRequest(res, `calls: ${bad}`);
        calls = parsed as EngineRequest[];
        source = 'request';
      } else {
        const captured = (ctx.capturedCalls?.() ?? []).filter((c) => c.kind === 'tool');
        if (captured.length) {
          calls = captured.map((c) => ({ clientId: c.clientId, serverId: c.serverId, tool: c.tool, args: c.arguments ?? {} }));
          source = 'replay';
        } else {
          calls = ctx.recent(Number(b.limit) || 1000).filter((m) => (m.kind ?? 'tool') === 'tool').map((m) => ({ clientId: m.clientId, serverId: m.serverId, tool: m.toolName }));
          source = 'metrics';
        }
      }
      res.json(cedarImpact(current, candidate, calls, source));
    });
  },
});
