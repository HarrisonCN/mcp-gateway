/**
 * Policy simulation and dry-run (6.5): know what a policy change does before you ship it.
 *
 * - **Simulate:** `POST /admin/policy-sim/simulate` evaluates a candidate policy (`{ rules, default }`) against past
 *   calls — the replay recorder's captured calls (with arguments) when `replay.enabled`, otherwise recent request
 *   metrics (no arguments), or calls you pass in — and diffs every decision against the running `policy`: which
 *   calls would become denied, allowed or held for approval, by client, tool and rule.
 * - **Dry-run:** `POST /admin/policy-sim/dry-run` decides one hypothetical call under the running policy (and the
 *   shadow policy) without calling anything.
 * - **Shadow mode:** `policyShadow` is evaluated on live traffic next to the enforced policy, never blocks, and
 *   records where the two disagree (`GET /admin/policy-sim/shadow`). Promote it once the divergences look right.
 *
 * ```yaml
 * policyShadow:
 *   default: deny
 *   rules:
 *     - { name: read-only, effect: allow, tools: ["*read*", "*list*", "*search*"] }
 * ```
 *
 * @module features/policy-sim
 */

import { z } from 'zod';
import { registerFeature, objectBody, badRequest } from '../gateway/features.js';
import { registerCallHook } from '../gateway/hooks.js';
import { evaluatePolicy, invalidPolicy, type PolicyDecision } from '../policy/tool-policy.js';
import { PolicyRuleSchema } from '../policy/rule-schema.js';
import type { GatewayConfig, ToolPolicyConfig } from '../utils/types.js';
import { CandidatePolicySchema, PolicyShadowConfig, PolicyShadowSchema, policyFields, validRegexes } from './schemas/policy-sim.js';
export { CandidatePolicySchema, PolicyShadowConfig, PolicyShadowSchema } from './schemas/policy-sim.js';
export interface SimCall {
  clientId?: string;
  serverId: string;
  tool: string;
  args?: Record<string, unknown>;
  timestamp?: string;
}

export interface SimulationReport {
  source: string;
  calls: number;
  withArguments: number;
  unchanged: number;
  changed: number;
  transitions: Record<string, number>;
  byRule: Record<string, number>;
  byClient: Record<string, { changed: number; newlyDenied: number }>;
  byTool: Record<string, { changed: number; newlyDenied: number }>;
  examples: Array<SimCall & { before: PolicyDecision; after: PolicyDecision }>;
}

/** Diff the decisions of `current` and `candidate` over `calls`. */
export function simulatePolicy(current: ToolPolicyConfig | undefined, candidate: ToolPolicyConfig, calls: readonly SimCall[], source = 'calls', maxExamples = 50): SimulationReport {
  const r: SimulationReport = { source, calls: calls.length, withArguments: 0, unchanged: 0, changed: 0, transitions: {}, byRule: {}, byClient: {}, byTool: {}, examples: [] };
  for (const c of calls) {
    if (c.args && Object.keys(c.args).length) r.withArguments++;
    const req = { clientId: c.clientId, serverId: c.serverId, tool: c.tool, args: c.args ?? {} };
    const before = evaluatePolicy(current, req);
    const after = evaluatePolicy(candidate, req);
    const rule = after.rule ?? '(default)';
    r.byRule[rule] = (r.byRule[rule] ?? 0) + 1;
    if (before.effect === after.effect) {
      r.unchanged++;
      continue;
    }
    r.changed++;
    const t = `${before.effect}→${after.effect}`;
    r.transitions[t] = (r.transitions[t] ?? 0) + 1;
    const denied = after.effect === 'deny' ? 1 : 0;
    const client = c.clientId ?? 'anonymous';
    const tool = `${c.serverId}/${c.tool}`;
    r.byClient[client] = { changed: (r.byClient[client]?.changed ?? 0) + 1, newlyDenied: (r.byClient[client]?.newlyDenied ?? 0) + denied };
    r.byTool[tool] = { changed: (r.byTool[tool]?.changed ?? 0) + 1, newlyDenied: (r.byTool[tool]?.newlyDenied ?? 0) + denied };
    if (r.examples.length < maxExamples) r.examples.push({ ...c, before, after });
  }
  return r;
}

export interface Divergence {
  timestamp: string;
  clientId?: string;
  serverId: string;
  tool: string;
  enforced: PolicyDecision;
  shadow: PolicyDecision;
}

/** Counts shadow decisions and keeps the latest divergences. */
export class ShadowRecorder {
  evaluated = 0;
  agree = 0;
  readonly transitions: Record<string, number> = {};
  readonly divergences: Divergence[] = [];
  constructor(private readonly max = 200) {}
  record(enforced: PolicyDecision, shadow: PolicyDecision, call: { clientId?: string; serverId: string; tool: string }): void {
    this.evaluated++;
    if (enforced.effect === shadow.effect) return void this.agree++;
    const t = `${enforced.effect}→${shadow.effect}`;
    this.transitions[t] = (this.transitions[t] ?? 0) + 1;
    this.divergences.push({ timestamp: new Date().toISOString(), ...call, enforced, shadow });
    if (this.divergences.length > this.max) this.divergences.shift();
  }
  reset(): void {
    this.evaluated = this.agree = 0;
    for (const k of Object.keys(this.transitions)) delete this.transitions[k];
    this.divergences.length = 0;
  }
}

export const shadowRecorder = new ShadowRecorder();

const shadowOf = (cfg: GatewayConfig): ToolPolicyConfig | undefined => {
  if (!cfg.policyShadow) return undefined;
  const { enabled, ...p } = PolicyShadowSchema.parse(cfg.policyShadow);
  return enabled ? (p as ToolPolicyConfig) : undefined;
};

// Shadow mode: evaluate next to the enforced policy; never refuses. (Calls the enforced policy denied never reach
// call hooks, so those are covered by `simulate`, not here.)
registerCallHook({
  id: 'policy-shadow',
  before: (call, cfg) => {
    const shadow = shadowOf(cfg);
    if (!shadow) return;
    const req = { clientId: call.clientId, serverId: call.serverId, tool: call.tool, args: call.args };
    shadowRecorder.record(evaluatePolicy(cfg.policy, req), evaluatePolicy(shadow, req), { clientId: call.clientId, serverId: call.serverId, tool: call.tool });
  },
});

registerFeature({
  id: 'policy-sim',
  since: '6.5.0',
  summary: 'Policy simulation and dry-run: replay history against a candidate policy, shadow policies on live traffic',
  mount: (router, ctx) => {
    router.post('/simulate', (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      const cand = CandidatePolicySchema.safeParse(b.policy ?? {});
      if (!cand.success) return badRequest(res, `invalid policy: ${cand.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
      let calls: SimCall[];
      let source: string;
      if (Array.isArray(b.calls)) {
        if (!b.calls.every((c) => c && typeof c === 'object' && typeof (c as SimCall).serverId === 'string' && typeof (c as SimCall).tool === 'string')) return badRequest(res, 'each call needs serverId and tool');
        calls = b.calls as SimCall[];
        source = 'request';
      } else {
        const captured = (ctx.capturedCalls?.() ?? []).filter((c) => c.kind === 'tool');
        if (captured.length && b.source !== 'metrics') {
          calls = captured.map((c) => ({ clientId: c.clientId, serverId: c.serverId, tool: c.tool, args: c.arguments ?? {}, timestamp: c.timestamp }));
          source = 'replay';
        } else {
          calls = ctx.recent(Number(b.limit) || 1000).filter((m) => (m.kind ?? 'tool') === 'tool').map((m) => ({ clientId: m.clientId, serverId: m.serverId, tool: m.toolName, timestamp: new Date(m.timestamp).toISOString() }));
          source = 'metrics';
        }
      }
      res.json(simulatePolicy(ctx.config().policy, cand.data as ToolPolicyConfig, calls, source));
    });
    router.post('/dry-run', (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      if (typeof b.server !== 'string' || typeof b.tool !== 'string') return badRequest(res, '"server" and "tool" are required');
      if (b.arguments !== undefined && (typeof b.arguments !== 'object' || b.arguments === null || Array.isArray(b.arguments))) return badRequest(res, '"arguments" must be an object');
      const reqP = { clientId: typeof b.clientId === 'string' ? b.clientId : undefined, serverId: b.server, tool: b.tool, args: (b.arguments as Record<string, unknown>) ?? {} };
      const cfg = ctx.config();
      const shadow = shadowOf(cfg);
      res.json({ call: reqP, enforced: evaluatePolicy(cfg.policy, reqP), ...(shadow ? { shadow: evaluatePolicy(shadow, reqP) } : {}) });
    });
    router.get('/shadow', (_req, res) => {
      const s = shadowRecorder;
      res.json({ enabled: !!shadowOf(ctx.config()), evaluated: s.evaluated, agree: s.agree, diverged: s.evaluated - s.agree, transitions: s.transitions, divergences: [...s.divergences].reverse().slice(0, 50) });
    });
    router.post('/shadow/reset', (_req, res) => {
      shadowRecorder.reset();
      res.json({ reset: true });
    });
  },
});
