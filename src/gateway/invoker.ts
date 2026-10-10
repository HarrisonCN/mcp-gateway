/**
 * The one place every upstream call goes through, for both the REST API and
 * the `/mcp` endpoint: tool calls, `resources/read` and `prompts/get`.
 *
 * It records metrics, writes the request log, and wraps the call in a trace
 * span. Later pipeline stages (policy, approvals, caching, quotas, plugins)
 * hook in here so REST and MCP behave the same.
 *
 * @module gateway/invoker
 */

import { activeCallHooks, type CallHook, type HookCall } from './hooks.js';

/**
 * Security guard hooks (backport of 13.1): their `before` decision depends on the call's target, so they are evaluated
 * again against the final target when a hook or routing split reroutes the call.
 */
const GUARD_HOOKS = new Set(['dlp', 'agent-identity', 'confidential', 'policy-engine', 'privacy', 'sanitize', 'approval-flows']);
const isGuardHook = (id: string): boolean => GUARD_HOOKS.has(id);
import { authorize, principalChain, type Principal } from '../auth/authorizer.js';
import { actorOf, identityOf, type CallIdentity } from '../auth/identity.js';
import type { McpProxy, ProgressUpdate, RelayCaller } from '../proxy/index.js';
import type { MetricsCollector } from '../monitor/index.js';
import type { McpServerConfig, ProxyResponse, ToolPolicyConfig } from '../utils/types.js';
import { evaluateActorPolicy, evaluatePolicy } from '../policy/tool-policy.js';
import { ApprovalQueue } from '../policy/approvals.js';
import { OutputFilter } from '../policy/output-filter.js';

/** Call refused by `policy.rules` (also used for forbidden scopes). */
export const ERR_POLICY_DENIED = -32003;
/** Call held for approval and then denied, expired or cancelled. */
export const ERR_APPROVAL_REJECTED = -32004;
/** Tool output blocked by `policy.outputFilter` (action `block`). */
export const ERR_OUTPUT_BLOCKED = -32005;

/** Error codes produced by the gateway's own policy layer (REST maps them to 403). */
export const POLICY_ERROR_CODES = new Set([ERR_POLICY_DENIED, ERR_APPROVAL_REJECTED, ERR_OUTPUT_BLOCKED, ERR_PLUGIN_REJECTED, ERR_QUOTA_EXCEEDED]);
import { ERR_PLUGIN_REJECTED, PluginError, type PluginCall, type PluginHost } from '../plugins/index.js';
import { ERR_PII_BLOCKED, ERR_RESIDENCY, type ComplianceEngine } from '../policy/compliance.js';
POLICY_ERROR_CODES.add(ERR_RESIDENCY);
POLICY_ERROR_CODES.add(ERR_PII_BLOCKED);
export { ERR_PLUGIN_REJECTED };
import { logger } from '../utils/logger.js';
import { ERR_NOT_CONNECTED, ERR_TIMEOUT } from '../proxy/index.js';
import { expandReplicas, type FailureKind, type LoadBalancer } from './balancer.js';
import type { RouteDecision, SmartRouter } from './routing.js';
import type { SecretManager } from '../secrets/index.js';
import type { Federation } from './federation.js';
import type { ToolCache } from './cache.js';
import { ERR_QUOTA_EXCEEDED, type UsageMeter } from './usage.js';
import { ERR_BUDGET_EXCEEDED, type CostLedger } from '../costs/index.js';
export { ERR_QUOTA_EXCEEDED };
import { NOOP_TRACER, type Tracer } from '../observability/tracing.js';
import { ERR_FORBIDDEN as ERR_FORBIDDEN_TARGET } from '../auth/authorizer.js';
import type { ReplayRecorder } from './replay.js';
import { argsDigest, makeSnapshot, snapshotMismatch, type FinalCallSnapshot } from './final-call.js';
export type { FinalCallSnapshot } from './final-call.js';

export type CallKind = 'tool' | 'resource' | 'prompt';

/** A per-call credential could not be resolved (3.5). */
export const ERR_SECRET_UNAVAILABLE = -32010;
/** A security guard hook threw while re-checking a rerouted call (backport of 13.1). */
const ERR_MODULE_UNAVAILABLE = -32003;

/**
 * The target a call was authorized for (13.1), frozen by the final authorization: the upstream send refuses a call
 * whose server / name / kind differ from it, so nothing can change the target after the last check.
 */
export type AuthorizedTarget = Readonly<{ serverId: string; name: string; kind: CallKind; principal: string }>;

export interface InvokeContext {
  serverId: string;
  /** Upstream tool / prompt name or resource URI. */
  name: string;
  kind: CallKind;
  /** JSON-RPC method (`tools/call`, `resources/read`, `prompts/get`). */
  method: string;
  /** Tool arguments (tools) or full request params (resources / prompts). */
  params: Record<string, unknown>;
  timeoutMs?: number;
  clientId?: string;
  via: 'rest' | 'mcp';
  signal?: AbortSignal;
  onProgress?: (u: ProgressUpdate) => void;
  /** Downstream caller (MCP session) for sampling / elicitation / roots passthrough (3.1). */
  caller?: RelayCaller;
  /** Request id of the call this one replays (3.2). */
  replayOf?: string;
  /** Incoming W3C `traceparent` (parent span). */
  traceparent?: string;
  /** Extra `_meta` for the upstream request (3.5: injected credentials; never logged). */
  meta?: Record<string, unknown>;
  /** Set on calls that arrived from a peer gateway: never forwarded again (3.6). */
  fromPeer?: string;
  /**
   * Who the call is made for (11.1). Required: `invoke()` authorizes every call against it before anything else
   * (see auth/authorizer); a call without one is refused.
   */
  principal: Principal;
  /** Set by the invoker (13.1): the target of the last successful authorization. Callers must not set it. */
  authorizedTarget?: AuthorizedTarget;
  /**
   * Set by the invoker from `principal` (MGW-2026-007) — callers must not set it. `clientId` is rewritten to
   * `identity.subject`, so every module (policy, tenancy, quotas, budgets, residency, credentials, caches, audit)
   * sees the original caller, never the agent that acts for it (see auth/identity).
   */
  identity?: CallIdentity;
  /**
   * Set by the invoker (13.1.3) — callers must not set it: the final security snapshot (principal, upstream server,
   * tool, approved business arguments, credential target). The upstream send refuses a call that differs from it.
   */
  snapshot?: FinalCallSnapshot;
  /** Set by the invoker (13.1.3): argument names the credential injection added, and the server they belong to. */
  injected?: { target: string; arguments: readonly string[] };
  /**
   * Set by the invoker (MGW-2026-011) — callers must not set it: the gateway config the call started with. A hot reload
   * replaces the config object; the send refuses a call whose target server config, policy or tenants changed since.
   */
  configAtStart?: import('../utils/types.js').GatewayConfig;
}

export interface InvokeResult extends ProxyResponse {
  /** `traceparent` of the gateway span (empty when tracing is off). */
  traceparent: string;
  /** Id of the history / audit record of this call. */
  requestId?: string;
}

export interface InvokerDeps {
  /** 5.6: running config, handed to call hooks (hooks are skipped without it). */
  config?: () => import('../utils/types.js').GatewayConfig;
  /** 4.3: cost accounting and budgets. */
  costs?: CostLedger;
  proxy: McpProxy;
  /** Captures calls for the replay debugger (3.2). */
  recorder?: ReplayRecorder;
  metrics: MetricsCollector;
  tracer?: () => Tracer;
  requestLog?: () => boolean;
  /** Current `policy` config (rules, approval, output filter). */
  policy?: () => ToolPolicyConfig | undefined;
  /** Queue for `approve` rules; created when absent. */
  approvals?: ApprovalQueue;
  /** Plugin hooks (`onToolCall` before policy, `onResponse` after the output filter). */
  plugins?: PluginHost;
  /** Secret resolution for per-call credential injection (3.5). */
  secrets?: SecretManager;
  /** Config of a server id (for `inject:`). */
  serverConfig?: (id: string) => McpServerConfig | undefined;
  /** Traffic splits (canary / A-B) across servers (3.4). */
  router?: SmartRouter;
  /** Cross-region failover to peer gateways (3.6). */
  federation?: Federation;
  /** PII scanning + data residency (3.7). */
  compliance?: ComplianceEngine;
  /** Routes calls on servers with `replicas:` (load balancing + failover). */
  balancer?: LoadBalancer;
  /** Tool result cache + in-flight de-duplication (`cache:` config). */
  cache?: ToolCache;
  /** Quotas + metering (`quotas:` config). */
  usage?: UsageMeter;
  /** Tenant ids of a client (for per-tenant quotas and metering). */
  tenantsOf?: (clientId: string | undefined) => string[];
  /** 11.1: server tool filter, enforced by the central authorizer for every caller. */
  exposed?: (serverId: string, tool: string) => boolean;
}

/** A routing-split decision made once per call and authorized before any cache lookup (MGW-2026-005). */
interface PreRoute {
  route: RouteDecision;
  /** The call moved to `route.server`, with the frozen authorized target of the final authorization. */
  ctx: InvokeContext;
}

/** Why the final authorization refused a call (13.1). */
interface FinalDenial {
  code: number;
  message: string;
  data: Record<string, unknown>;
}

/** What the target-dependent and argument-dependent checks saw before the final authorization (13.1.3). */
interface CheckedState {
  /** Digest of the arguments the tool policy evaluated. */
  policyDigest?: string;
  /** The policy asked for an approval hold: held on the FINAL arguments in the final authorization. */
  approvalPending?: boolean;
  /** Guard hooks: target and argument digest each one approved. */
  guards?: Map<string, { serverId: string; digest: string }>;
  /** Hooks that rewrote the arguments after the policy check. */
  argsChangedBy?: string[];
}

/** Rounds of re-checking when guard hooks keep rewriting the arguments of each other (13.1.3). */
const MAX_FINAL_ROUNDS = 3;

export class ToolInvoker {
  readonly approvals: ApprovalQueue;
  private filter?: { config: unknown; filter: OutputFilter };
  /** Prompt-injection findings since start (per pattern). */
  readonly filterFindings = new Map<string, number>();
  /** Calls refused by the central authorizer since start (11.1). */
  authzDenials = 0;
  /** Rerouted calls refused by the final authorization since start (13.1). */
  rerouteDenials = 0;

  constructor(private readonly deps: InvokerDeps) {
    this.approvals = deps.approvals ?? new ApprovalQueue(deps.policy?.()?.approval);
  }

  /** Re-read `policy.approval` settings (hot reload). */
  refreshPolicy(): void {
    this.approvals.configure(this.deps.policy?.()?.approval);
  }

  private outputFilter(): OutputFilter | undefined {
    const cfg = this.deps.policy?.()?.outputFilter;
    if (!cfg || cfg.enabled === false) return undefined;
    if (this.filter?.config !== cfg) this.filter = { config: cfg, filter: new OutputFilter(cfg) };
    return this.filter.filter;
  }

  /** Delegation / origin fields of the audit record (MGW-2026-007): absent for plain direct calls. */
  private auditOf(ctx: InvokeContext): { actor?: string; chain?: string[] } {
    const id = ctx.identity;
    if (!id || (!id.actors.length && !id.origin)) return {};
    return { actor: actorOf(id), chain: id.origin ? [...id.chain, id.origin] : id.chain };
  }

  /** Refuse a call without contacting the upstream server (still recorded). */
  private refuse(ctx: InvokeContext, code: number, message: string, data: Record<string, unknown>, span: ReturnType<Tracer['startSpan']>): InvokeResult {
    this.deps.metrics.record({
      serverId: ctx.serverId,
      toolName: ctx.name,
      durationMs: 0,
      success: false,
      errorMessage: message,
      clientId: ctx.clientId,
      via: ctx.via,
      ...this.auditOf(ctx),
    });
    if (this.deps.requestLog?.() !== false) logger.info(`${ctx.name} → ${ctx.serverId} refused: ${message}`);
    const hookCfg = ctx.kind === 'tool' ? this.deps.config?.() : undefined;
    if (hookCfg) {
      const call: HookCall = { serverId: ctx.serverId, tool: ctx.name, clientId: ctx.clientId, tenant: this.deps.tenantsOf?.(ctx.clientId)?.[0], args: ctx.params };
      for (const h of activeCallHooks(hookCfg)) {
        try {
          h.refused?.(call, { code, message, data }, hookCfg);
        } catch (err) {
          logger.warn(`call hook ${h.id} (refused) failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    span.setAttribute('mcp.policy.decision', String(data.decision ?? 'deny'));
    span.setError(message);
    span.end();
    return { success: false, durationMs: 0, error: { code, message, data }, traceparent: span.traceparent() };
  }

  /** Policy rules + approval hold. Returns a refusal, or undefined to proceed. */
  private async checkPolicy(ctx: InvokeContext, span: ReturnType<Tracer['startSpan']>, defer?: { pending: boolean }): Promise<InvokeResult | undefined> {
    const d = await this.policyDenial(ctx, span, { deferApproval: defer });
    return d ? this.refuse(ctx, d.code, d.message, d.data, span) : undefined;
  }

  /** Policy rules + approval hold for `ctx`'s target (undefined = allowed). */
  private async policyDenial(ctx: InvokeContext, span: ReturnType<Tracer['startSpan']>, opts: { deferApproval?: { pending: boolean } } = {}): Promise<FinalDenial | undefined> {
    const policy = this.deps.policy?.();
    if (!policy || ctx.kind !== 'tool') return undefined;
    let decision: import('../policy/tool-policy.js').PolicyDecision = evaluatePolicy(policy, { clientId: ctx.clientId, serverId: ctx.serverId, tool: ctx.name, args: ctx.params });
    // MGW-2026-007: rules naming an actor of a delegated call (agent:<id>) may restrict it further, never widen it.
    const actors = ctx.identity?.actors ?? [];
    if (actors.length && decision.effect !== 'deny') {
      const a = evaluateActorPolicy(policy, actors, { clientId: ctx.clientId, serverId: ctx.serverId, tool: ctx.name, args: ctx.params });
      if (a && (a.effect === 'deny' || decision.effect === 'allow')) decision = { effect: a.effect, rule: a.rule, message: a.message ?? (a.effect === 'deny' ? `Tool call denied by policy (rule ${a.rule}, actor ${a.actor})` : undefined) };
    }
    if (decision.effect === 'allow') return undefined;
    if (decision.effect === 'deny') {
      const message = decision.message ?? `Tool call denied by policy${decision.rule ? ` (rule ${decision.rule})` : ''}`;
      return { code: ERR_POLICY_DENIED, message, data: { decision: 'deny', rule: decision.rule } };
    }
    // 13.1.3: the hold is placed in the final authorization, on the arguments the upstream will receive.
    if (opts.deferApproval) {
      opts.deferApproval.pending = true;
      return undefined;
    }
    logger.info(`${ctx.name} → ${ctx.serverId} held for approval (rule ${decision.rule ?? 'default'})`);
    const status = await this.approvals.request(
      { clientId: ctx.clientId, serverId: ctx.serverId, tool: ctx.name, args: ctx.params, rule: decision.rule, message: decision.message, via: ctx.via },
      ctx.signal,
    );
    span.setAttribute('mcp.approval.status', status);
    if (status === 'approved') return undefined;
    const message =
      status === 'expired'
        ? 'Tool call was not approved in time'
        : status === 'cancelled'
          ? 'Tool call was cancelled while waiting for approval'
          : 'Tool call was denied by an operator';
    return { code: ERR_APPROVAL_REJECTED, message, data: { decision: 'approve', approval: status, rule: decision.rule } };
  }

  /** Data-residency check of `ctx`'s target (undefined = allowed). */
  private residencyDenial(ctx: InvokeContext): FinalDenial | undefined {
    const comp = this.deps.compliance;
    if (!comp || ctx.kind !== 'tool' || ctx.fromPeer) return undefined;
    const tenant = this.deps.tenantsOf?.(ctx.clientId)?.[0];
    const region = this.deps.serverConfig?.(ctx.serverId)?.region;
    if (comp.residencyAllows(tenant, region)) return undefined;
    comp.noteResidencyBlock();
    const message = `Data residency: ${tenant ? `tenant "${tenant}"` : 'this client'} may not send data to region ${region ?? '(unknown)'}`;
    return { code: ERR_RESIDENCY, message, data: { decision: 'residency', region: region ?? null, allowed: comp.regionsFor(tenant) } };
  }

  /**
   * Final authorization (13.1), immediately before the upstream is contacted, against the FINAL target. The central
   * authorizer (client / tenant / delegation scope ∩ server tool exposure) always runs again. When the target differs
   * from the one last authorized — a call hook (rollouts, blue/green, self-healing, budget downgrade) or a routing
   * split rerouted it — the whole target-dependent decision runs again for the new target: tool policy rules (incl.
   * approval holds), data residency, and the `before` hooks of security guard modules that did not see the final
   * target (DLP, agent identity, confidential computing, policy engine, privacy, sanitize, approval flows). Any
   * refusal of a changed target is a reroute denial (audited, counted). On success the target is frozen into
   * `ctx.authorizedTarget`.
   */
  private async finalAuthorization(
    ctx: InvokeContext,
    span: ReturnType<Tracer['startSpan']>,
    reroute: { by: string[]; guardsSeen?: Map<string, { serverId: string; digest: string }>; hooks?: readonly CallHook[]; checked?: CheckedState },
  ): Promise<{ ctx: InvokeContext } | { denial: FinalDenial }> {
    const prev = ctx.authorizedTarget;
    const changed = !prev || prev.serverId !== ctx.serverId || prev.name !== ctx.name || prev.kind !== ctx.kind;
    const checked = reroute.checked;
    // 13.1.3: arguments rewritten after the policy check (by a call hook) are checked again, also without a reroute.
    const argsChanged = ctx.kind === 'tool' && !!checked && checked.policyDigest !== undefined && checked.policyDigest !== argsDigest(ctx.params);
    const changedBy = argsChanged ? (checked?.argsChangedBy ?? []) : [];
    const wrap = (d: FinalDenial): FinalDenial => {
      const withArgs = changedBy.length ? { ...d, data: { ...d.data, argsChangedBy: changedBy } } : d;
      if (!changed) {
        if (argsChanged) logger.warn(`audit: ${ctx.name} -> ${ctx.serverId} refused for ${ctx.principal?.id} after its arguments were rewritten by ${changedBy.join(', ') || 'a call hook'}: ${d.message}`);
        return withArgs;
      }
      this.rerouteDenials++;
      const from = prev?.serverId ?? '(unauthorized)';
      logger.warn(`audit: rerouted call ${ctx.name} ${from} -> ${ctx.serverId} (by ${reroute.by.join(', ') || 'unknown'}) refused for ${ctx.principal?.id}: ${d.message}`);
      span.setAttribute('mcp.reroute.denied', `${from}->${ctx.serverId}`);
      return {
        code: d.code,
        message: `Rerouted call refused: ${d.message} (route "${from}" -> "${ctx.serverId}" by ${reroute.by.join(', ') || 'unknown'})`,
        data: { ...withArgs.data, decision: 'reroute-denied', reason: d.data.reason ?? d.data.decision ?? null, from, to: ctx.serverId, reroutedBy: reroute.by, chain: principalChain(ctx.principal) },
      };
    };
    const denied = authorize(ctx.principal, { serverId: ctx.serverId, name: ctx.name, kind: ctx.kind }, { exposed: this.deps.exposed });
    if (denied) {
      this.authzDenials++;
      return { denial: wrap({ code: denied.code, message: denied.message, data: { ...denied.data, chain: principalChain(ctx.principal) } }) };
    }
    if (ctx.kind === 'tool' && (changed || argsChanged || checked?.approvalPending)) {
      const cfgNow = this.deps.config?.();
      const plan = cfgNow ? { hooks: reroute.hooks ?? activeCallHooks(cfgNow) } : undefined;
      if (changed) {
        const res = this.residencyDenial(ctx);
        if (res) return { denial: wrap(res) };
      }
      // Policy (deny rules) and the security guard hooks, until the arguments are stable: a guard that rewrites the
      // arguments (DLP redaction) makes the policy and the other guards look at the new ones.
      const approval = { pending: false };
      const seen = new Map(reroute.guardsSeen ?? []);
      let policyDigest: string | undefined = changed ? undefined : checked?.policyDigest;
      for (let round = 0; ; round++) {
        const digest = argsDigest(ctx.params);
        if (policyDigest !== digest) {
          approval.pending = false;
          const pol = await this.policyDenial(ctx, span, { deferApproval: approval });
          if (pol) return { denial: wrap(pol) };
          policyDigest = digest;
        } else if (round === 0 && checked?.approvalPending) approval.pending = true;
        let rewritten = false;
        if (cfgNow && plan) {
          const call: HookCall = { serverId: ctx.serverId, tool: ctx.name, clientId: ctx.clientId, tenant: this.deps.tenantsOf?.(ctx.clientId)?.[0], args: ctx.params, principal: ctx.principal };
          for (const h of plan.hooks) {
            if (!h.before || !isGuardHook(h.id)) continue;
            const s = seen.get(h.id);
            if (s && s.serverId === ctx.serverId && s.digest === argsDigest(ctx.params)) continue;
            let out: Awaited<ReturnType<NonNullable<CallHook['before']>>>;
            try {
              out = await h.before(call, cfgNow);
            } catch (err) {
              return { denial: wrap({ code: ERR_MODULE_UNAVAILABLE, message: `security module ${h.id} failed: ${err instanceof Error ? err.message : String(err)}`, data: { decision: 'module-failed', module: h.id } }) };
            }
            if (out?.refuse) return { denial: wrap({ code: out.refuse.code, message: out.refuse.message, data: { decision: h.id, ...(out.refuse.data ?? {}) } }) };
            if (out?.serverId && out.serverId !== ctx.serverId) {
              // A guard may not move the call again: the target it was asked about is the one that gets the call.
              return { denial: wrap({ code: ERR_FORBIDDEN_TARGET, message: `security module ${h.id} tried to reroute the call during final authorization`, data: { decision: 'reroute-loop', module: h.id } }) };
            }
            if (out?.args && argsDigest(out.args) !== argsDigest(ctx.params)) {
              call.args = out.args;
              ctx = { ...ctx, params: out.args };
              rewritten = true;
            }
            seen.set(h.id, { serverId: ctx.serverId, digest: argsDigest(ctx.params) });
          }
        }
        if (!rewritten && policyDigest === argsDigest(ctx.params)) break;
        if (round + 1 >= MAX_FINAL_ROUNDS) {
          return { denial: wrap({ code: ERR_FORBIDDEN_TARGET, message: 'Call arguments did not settle: security modules kept rewriting them during final authorization', data: { decision: 'args-unstable' } }) };
        }
      }
      // 13.1.3: approval holds are placed last, on the final target and the final arguments.
      if (approval.pending) {
        const held = await this.policyDenial(ctx, span);
        if (held) return { denial: wrap(held) };
      }
      if (prev && changed) logger.info(`audit: call ${ctx.name} rerouted ${prev.serverId} -> ${ctx.serverId} (by ${reroute.by.join(', ') || 'unknown'}) re-authorized for ${ctx.principal?.id}`);
      if (argsChanged) logger.info(`audit: call ${ctx.name} -> ${ctx.serverId} re-checked for ${ctx.principal?.id} after its arguments were rewritten by ${changedBy.join(', ') || 'a call hook'}`);
    }
    const authorizedTarget: AuthorizedTarget = Object.freeze({ serverId: ctx.serverId, name: ctx.name, kind: ctx.kind, principal: ctx.principal.id });
    return { ctx: { ...ctx, authorizedTarget } };
  }

  private tracer(): Tracer {
    return this.deps.tracer?.() ?? NOOP_TRACER;
  }

  async invoke(ctx: InvokeContext): Promise<InvokeResult> {
    // MGW-2026-007: one identity context. The principal is authoritative: `clientId` becomes the call's subject (the
    // original caller of a delegated call); a different label from the call site is kept only as the audit origin.
    const identity = identityOf(ctx.principal, ctx.clientId);
    ctx = { ...ctx, clientId: identity.subject, identity, configAtStart: this.deps.config?.() };
    const span = this.tracer().startSpan(`mcp.${ctx.method} ${ctx.name}`, {
      parent: ctx.traceparent,
      kind: 'server',
      attributes: {
        'mcp.method': ctx.method,
        'mcp.server.id': ctx.serverId,
        [ctx.kind === 'tool' ? 'mcp.tool.name' : ctx.kind === 'prompt' ? 'mcp.prompt.name' : 'mcp.resource.uri']: ctx.name,
        'mcp.via': ctx.via,
        'mcp.client.id': ctx.clientId,
      },
    });
    // 11.1: the single, non-bypassable authorization decision point (fail-closed without a principal).
    const denied = authorize(ctx.principal, { serverId: ctx.serverId, name: ctx.name, kind: ctx.kind }, { exposed: this.deps.exposed });
    if (denied) {
      this.authzDenials++;
      return this.refuse(ctx, denied.code, denied.message, { ...denied.data, chain: principalChain(ctx.principal) }, span);
    }
    if (ctx.principal.delegation?.length) span.setAttribute('mcp.principal.chain', principalChain(ctx.principal).join(' > '));
    const actor = actorOf(identity);
    if (actor) span.setAttribute('mcp.actor', actor);
    ctx = { ...ctx, authorizedTarget: Object.freeze({ serverId: ctx.serverId, name: ctx.name, kind: ctx.kind, principal: ctx.principal.id }) };
    const plugins = this.deps.plugins && this.deps.plugins.size > 0 ? this.deps.plugins : undefined;
    const call: PluginCall | undefined = plugins
      ? { serverId: ctx.serverId, name: ctx.name, kind: ctx.kind, method: ctx.method, arguments: ctx.params, clientId: ctx.clientId, tenant: this.deps.tenantsOf?.(ctx.clientId)?.[0], via: ctx.via, state: new Map() }
      : undefined;
    if (plugins && call) {
      try {
        const pre = await plugins.beforeCall(call);
        if (pre && 'deny' in pre) {
          return this.refuse(ctx, ERR_PLUGIN_REJECTED, pre.deny, { decision: 'deny', plugin: pre.plugin }, span);
        }
        if (pre && 'respond' in pre) {
          span.setAttribute('mcp.plugin.respond', pre.plugin);
          return this.finish(ctx, call, { success: true, durationMs: 0, result: pre.respond }, span);
        }
      } catch (err) {
        const plugin = err instanceof PluginError ? err.plugin : undefined;
        return this.refuse(ctx, ERR_PLUGIN_REJECTED, err instanceof Error ? err.message : String(err), { decision: 'error', plugin }, span);
      }
      ctx = { ...ctx, params: call.arguments };
    }
    const approvalHold = { pending: false };
    const refused = await this.checkPolicy(ctx, span, approvalHold);
    if (refused) return refused;
    const checked: CheckedState = { policyDigest: ctx.kind === 'tool' ? argsDigest(ctx.params) : undefined, approvalPending: approvalHold.pending, argsChangedBy: [] };
    const residency = this.residencyDenial(ctx);
    if (residency) return this.refuse(ctx, residency.code, residency.message, residency.data, span);
    // 5.6: feature call hooks (before).
    const hookCfg = this.deps.config?.();
    // MGW-2026-005: one routing-split decision per (call, server), shared by cache keys, the final authorization and the send.
    const routes = new Map<string, RouteDecision | null>();
    const routeOf = (serverId: string): RouteDecision | undefined => {
      const router = ctx.kind === 'tool' ? this.deps.router : undefined;
      if (!router) return undefined;
      if (!routes.has(serverId)) routes.set(serverId, router.route(serverId, ctx.name, ctx.clientId) ?? null);
      return routes.get(serverId) ?? undefined;
    };
    const hookCall = (): HookCall => ({ serverId: ctx.serverId, tool: ctx.name, clientId: ctx.clientId, tenant: this.deps.tenantsOf?.(ctx.clientId)?.[0], args: ctx.params, principal: ctx.principal, routedTo: () => routeOf(ctx.serverId)?.server ?? ctx.serverId });
    let preset: ProxyResponse | undefined;
    const plan = hookCfg && ctx.kind === 'tool' ? { hooks: activeCallHooks(hookCfg) } : undefined;
    const rerouteBy: string[] = [];
    const guardsSeen = new Map<string, { serverId: string; digest: string }>();
    if (hookCfg && plan) {
      for (const h of plan.hooks) {
        if (!h.before) continue;
        const out = await h.before(hookCall(), hookCfg);
        if (out?.refuse) return this.refuse(ctx, out.refuse.code, out.refuse.message, { decision: h.id, ...(out.refuse.data ?? {}) }, span);
        if (out?.args && argsDigest(out.args) !== argsDigest(ctx.params)) {
          ctx = { ...ctx, params: out.args };
          checked.argsChangedBy!.push(h.id);
          span.setAttribute('mcp.args.rewritten_by', checked.argsChangedBy!.join(','));
        }
        // What this hook approved: the target and the arguments as it left them.
        guardsSeen.set(h.id, { serverId: out?.serverId ?? ctx.serverId, digest: argsDigest(ctx.params) });
        if (out?.serverId && out.serverId !== ctx.serverId) {
          span.setAttribute('mcp.rerouted', `${ctx.serverId}->${out.serverId}`);
          rerouteBy.push(h.id);
          ctx = { ...ctx, serverId: out.serverId };
        }
        if (out?.respond) {
          preset = out.respond;
          span.setAttribute('mcp.hook_response', h.id);
          break;
        }
      }
    }
    // 13.1: mandatory final authorization against the final target (re-runs the target checks after a reroute).
    const fin = await this.finalAuthorization(ctx, span, { by: rerouteBy, guardsSeen, hooks: plan?.hooks, checked });
    if ('denial' in fin) return this.refuse(ctx, fin.denial.code, fin.denial.message, fin.denial.data, span);
    ctx = fin.ctx;
    // MGW-2026-005: a routing split that moves the call is decided and authorized BEFORE any cache lookup, so a cached
    // answer is never served for a target the caller was not authorized on, and split targets never share cache entries.
    let pre: PreRoute | undefined;
    const route = routeOf(ctx.serverId);
    if (route) {
      span.setAttribute('mcp.route.split', route.split);
      span.setAttribute('mcp.route.variant', route.variant);
      if (route.server !== ctx.serverId) {
        const moved = await this.finalAuthorization({ ...ctx, serverId: route.server }, span, { by: [`routing:${route.split}`] });
        if ('denial' in moved) {
          this.deps.router!.report(route, false, 0);
          return this.refuse(ctx, moved.denial.code, moved.denial.message, moved.denial.data, span);
        }
        pre = { route, ctx: moved.ctx };
      } else pre = { route, ctx };
    }
    // 13.1.3: the final security snapshot — what the upstream may receive, compared again at the send.
    const sendCtx = pre?.ctx ?? ctx;
    const snapshot = makeSnapshot({ principal: ctx.principal.id, subject: identity.subject, actors: identity.actors, serverId: sendCtx.serverId, requestedServer: ctx.serverId, tool: sendCtx.name, kind: sendCtx.kind, args: sendCtx.params });
    ctx = { ...ctx, snapshot: sendCtx === ctx ? snapshot : ctx.snapshot };
    if (pre) pre = { route: pre.route, ctx: { ...pre.ctx, snapshot } };
    if (!pre) ctx = { ...ctx, snapshot };
    span.setAttribute('mcp.final.server', snapshot.serverId);
    const usage = this.deps.usage;
    if (usage && ctx.kind === 'tool') {
      const over = usage.take({ clientId: ctx.clientId, tenants: this.deps.tenantsOf?.(ctx.clientId), serverId: ctx.serverId, tool: ctx.name });
      if (over) {
        const message = `Quota "${over.rule}" exceeded for ${over.subject} (${over.limit} per period)`;
        return this.refuse(ctx, ERR_QUOTA_EXCEEDED, message, { decision: 'quota', quota: over.rule, limit: over.limit, resetsAt: new Date(over.resetsAt).toISOString() }, span);
      }
    }
    const costs = this.deps.costs;
    if (costs && ctx.kind === 'tool') {
      const over = costs.blocked(ctx.clientId, this.deps.tenantsOf?.(ctx.clientId));
      if (over) {
        const message = `Budget "${over.budget}" exhausted for ${over.subject} (${over.spent} of ${over.limit}); resets ${over.resetsAt}`;
        return this.refuse(ctx, ERR_BUDGET_EXCEEDED, message, { decision: 'budget', budget: over.budget, limit: over.limit, spent: over.spent, resetsAt: over.resetsAt }, span);
      }
    }
    let result: ProxyResponse;
    try {
      const cache = ctx.kind === 'tool' ? this.deps.cache : undefined;
      if (preset) {
        result = preset;
      } else if (cache) {
        const out = await cache.run({ serverId: ctx.serverId, target: pre?.ctx.serverId, tool: ctx.name, args: pre?.ctx.params ?? ctx.params, clientId: ctx.clientId }, () => this.callUpstream(ctx, span, pre));
        if (out.status !== 'bypass') span.setAttribute('mcp.cache', out.status);
        result = out.status === 'hit' || out.status === 'shared' ? { ...out.result, durationMs: out.status === 'hit' ? 0 : out.result.durationMs } : out.result;
      } else {
        result = await this.callUpstream(ctx, span, pre);
      }
    } catch (err) {
      span.setError(err instanceof Error ? err.message : String(err));
      span.end();
      throw err;
    }
    const filter = ctx.kind === 'tool' && result.success ? this.outputFilter() : undefined;
    if (filter && filter.appliesTo(ctx.serverId, ctx.name)) {
      const out = filter.apply(result.result);
      if (out.findings.length > 0) {
        for (const f of out.findings) this.filterFindings.set(f.pattern, (this.filterFindings.get(f.pattern) ?? 0) + 1);
        const ids = [...new Set(out.findings.map((f) => f.pattern))];
        logger.warn(`Possible prompt injection in ${ctx.serverId}/${ctx.name} output (${ids.join(', ')}): ${filter.action}`);
        span.setAttribute('mcp.output_filter', ids.join(','));
        result = out.blocked
          ? {
              success: false,
              durationMs: result.durationMs,
              error: { code: ERR_OUTPUT_BLOCKED, message: 'Tool output blocked: possible prompt injection', data: { patterns: ids, result: out.result } },
            }
          : { ...result, result: out.result };
      }
    }
    // 5.6: feature call hooks (after).
    if (hookCfg && plan) {
      for (const h of plan.hooks) {
        if (!h.after) continue;
        const out = await h.after(hookCall(), result, hookCfg);
        if (out) result = out;
      }
    }
    const done = await this.finish(ctx, call, result, span);
    // Non-enumerable: never serialized into API responses.
    Object.defineProperty(done, 'snapshot', { value: snapshot, enumerable: false });
    return done;
  }

  get compliance(): ComplianceEngine | undefined {
    return this.deps.compliance;
  }

  get cache(): ToolCache | undefined {
    return this.deps.cache;
  }

  get balancer(): LoadBalancer | undefined {
    return this.deps.balancer;
  }

  /** Active plugins (3.3: `GET /api/v1/plugins`). */
  get pluginHost(): PluginHost | undefined {
    return this.deps.plugins;
  }

  /**
   * MGW-2026-011: what changed, since the call started, in the config the call was authorized under (undefined = the
   * call may be sent). A call that was held (approval, slow hook / plugin) across a hot reload must not be sent with the
   * new config's server settings / credentials, nor escape the new policy or tenant mapping.
   */
  private configChange(ctx: InvokeContext, target: string): string[] | undefined {
    const was = ctx.configAtStart;
    const now = this.deps.config?.();
    if (!was || !now || was === now) return undefined;
    const j = (v: unknown) => JSON.stringify(v ?? null);
    const server = (c: import('../utils/types.js').GatewayConfig, id: string) => expandReplicas(c.servers ?? []).find((s) => s.id === id);
    const changed: string[] = [];
    for (const id of new Set([target, ctx.serverId])) if (j(server(was, id)) !== j(server(now, id))) changed.push(`server ${id}`);
    if (j(was.policy) !== j(now.policy)) changed.push('policy');
    if (j(was.tenants) !== j(now.tenants)) changed.push('tenants');
    return changed.length ? changed : undefined;
  }

  private send(ctx: InvokeContext, target: string): Promise<ProxyResponse> {
    const changed = this.configChange(ctx, target);
    if (changed) {
      const message = `The gateway configuration changed while this call was in flight (${changed.join(', ')}); it was not sent — retry`;
      logger.warn(`audit: ${ctx.name} -> ${target} refused for ${ctx.principal?.id}: ${message}`);
      return Promise.resolve({ success: false, durationMs: 0, error: { code: ERR_POLICY_DENIED, message, data: { decision: 'config-changed', changed } } });
    }
    // 13.1: the target is frozen by the final authorization; anything that changed it afterwards is refused.
    const t = ctx.authorizedTarget;
    if (!t || t.serverId !== ctx.serverId || t.name !== ctx.name || t.kind !== ctx.kind || t.principal !== ctx.principal?.id) {
      this.rerouteDenials++;
      const message = `Call target changed after final authorization (authorized ${t ? `${t.serverId}/${t.name}` : 'nothing'}, sending ${ctx.serverId}/${ctx.name}): refused`;
      logger.error(`audit: ${message} for ${ctx.principal?.id}`);
      return Promise.resolve({ success: false, durationMs: 0, error: { code: ERR_FORBIDDEN_TARGET, message, data: { decision: 'reroute-denied', reason: 'target-changed-after-authorization', from: t?.serverId ?? null, to: ctx.serverId } } });
    }
    // MGW-2026-010: the call must be the one the final security snapshot approved (business arguments, credential target).
    if (ctx.snapshot) {
      const why = snapshotMismatch(ctx.snapshot, { serverId: ctx.serverId, name: ctx.name, kind: ctx.kind, principal: ctx.principal?.id, params: ctx.params }, ctx.injected);
      if (why) {
        this.rerouteDenials++;
        const message = `Call differs from its final security snapshot (${why}): refused`;
        logger.error(`audit: ${ctx.name} -> ${ctx.serverId}: ${message} for ${ctx.principal?.id}`);
        return Promise.resolve({ success: false, durationMs: 0, error: { code: ERR_FORBIDDEN_TARGET, message, data: { decision: 'snapshot-mismatch', reason: why, server: ctx.serverId } } });
      }
    }
    return ctx.kind === 'tool'
      ? this.deps.proxy.callTool(target, ctx.name, ctx.params, ctx.timeoutMs, { signal: ctx.signal, onProgress: ctx.onProgress, caller: ctx.caller, meta: ctx.meta })
      : this.deps.proxy.request(target, ctx.method, ctx.meta ? { ...ctx.params, _meta: { ...((ctx.params._meta as Record<string, unknown>) ?? {}), ...ctx.meta } } : ctx.params, ctx.timeoutMs, { signal: ctx.signal, caller: ctx.caller });
  }

  /** One upstream call, spread over replicas and failed over when the server has `replicas:`. */
  /**
   * Per-call credentials (`inject:`), added after plugins, policy, cache keys and capture saw the call (3.5). 13.1.3:
   * always the credentials of the server the call is SENT to (`ctx.serverId` after reroutes and splits) — the
   * credentials of the server the caller asked for never cross to another upstream.
   */
  private async injectSecrets(ctx: InvokeContext): Promise<InvokeContext> {
    const secrets = this.deps.secrets;
    const server = this.deps.serverConfig?.(ctx.serverId);
    if (!secrets || !server?.inject?.length) return ctx;
    const values = await secrets.injections(server, { tenant: this.deps.tenantsOf?.(ctx.clientId)?.[0], clientId: ctx.clientId });
    let params = ctx.params;
    let meta = ctx.meta;
    const names: string[] = [];
    for (const v of values) {
      if (v.argument && ctx.kind === 'tool') {
        params = { ...params, [v.argument]: v.value };
        names.push(v.argument);
      }
      if (v.meta) meta = { ...(meta ?? {}), [v.meta]: v.value };
    }
    return { ...ctx, params, meta, injected: { target: ctx.serverId, arguments: names } };
  }

  private async callUpstream(ctx: InvokeContext, span: ReturnType<Tracer['startSpan']>, pre?: PreRoute): Promise<ProxyResponse> {
    const fed = this.deps.federation;
    const canFailover = ctx.kind === 'tool' && !ctx.fromPeer && !!fed?.failsOver(ctx.serverId);
    const local = await this.callLocal(ctx, span, pre);
    if (!canFailover || classifyFailure(local) !== 'not-connected') return local;
    const tenant = this.deps.tenantsOf?.(ctx.clientId)?.[0];
    const peers = fed!.candidates(ctx.serverId, ctx.name).filter((p) => this.deps.compliance?.residencyAllows(tenant, p.region) ?? true);
    for (const peer of peers) {
      logger.warn(`${ctx.serverId}/${ctx.name}: local server unavailable; failing over to peer gateway "${peer.id}"`);
      const r = await fed!.forward(peer, { server: ctx.serverId, tool: ctx.name, arguments: ctx.params, clientId: ctx.clientId, tenant: this.deps.tenantsOf?.(ctx.clientId)?.[0] }, ctx.timeoutMs);
      span.setAttribute('mcp.federation.peer', peer.id);
      if (r.success || classifyFailure(r) !== 'not-connected') {
        const { peer: _p, ...rest } = r;
        void _p;
        return rest;
      }
    }
    return local;
  }

  get federation(): Federation | undefined {
    return this.deps.federation;
  }

  private async callLocal(ctx: InvokeContext, span: ReturnType<Tracer['startSpan']>, pre?: PreRoute): Promise<ProxyResponse> {
    let routed: InvokeContext | undefined;
    try {
      // MGW-2026-009: the split target's own credentials (earlier versions injected the requested server's).
      if (pre) routed = await this.injectSecrets(pre.ctx);
      else ctx = await this.injectSecrets(ctx);
    } catch (err) {
      const message = `Credential injection failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.warn(`${ctx.serverId}/${ctx.name}: ${message}`);
      return { success: false, durationMs: 0, error: { code: ERR_SECRET_UNAVAILABLE, message } };
    }
    // MGW-2026-005: the routing split was decided and authorized in invoke(), before the cache (see PreRoute).
    if (pre && routed) {
      try {
        const r = await this.balancedCall(routed, span);
        this.deps.router!.report(pre.route, r.success, r.durationMs);
        return r;
      } catch (err) {
        this.deps.router!.report(pre.route, false, 0);
        throw err;
      }
    }
    return this.balancedCall(ctx, span);
  }

  get router(): SmartRouter | undefined {
    return this.deps.router;
  }

  private async balancedCall(ctx: InvokeContext, span: ReturnType<Tracer['startSpan']>): Promise<ProxyResponse> {
    const lb = this.deps.balancer;
    const targets = lb ? lb.order(ctx.serverId) : [ctx.serverId];
    if (!lb || targets.length === 1) return this.send(ctx, ctx.serverId);
    const { failoverOn, retries } = lb.settings(ctx.serverId);
    const attempts = Math.min(targets.length, retries + 1);
    const tried: string[] = [];
    for (let i = 0; i < attempts; i++) {
      const target = targets[i]!;
      tried.push(target);
      let result: ProxyResponse | undefined;
      let failure: FailureKind | undefined;
      let thrown: unknown;
      try {
        result = await this.send(ctx, target);
        failure = classifyFailure(result);
      } catch (err) {
        thrown = err;
        failure = 'error';
      }
      lb.report(target, ctx.serverId, failure, result?.durationMs ?? 0);
      const last = i === attempts - 1 || ctx.signal?.aborted;
      if (failure === undefined || !failoverOn.includes(failure) || last) {
        span.setAttribute('mcp.upstream.id', target);
        if (tried.length > 1) span.setAttribute('mcp.upstream.attempts', tried.length);
        if (thrown !== undefined) throw thrown;
        return result!;
      }
      logger.warn(`${ctx.name} → ${target} failed (${failure}); failing over to ${targets[i + 1]}`);
    }
    /* c8 ignore next */
    throw new Error('unreachable');
  }

  get usage(): UsageMeter | undefined {
    return this.deps.usage;
  }

  /** `onResponse` hooks, metrics, request log and span end. */
  private async finish(ctx: InvokeContext, call: PluginCall | undefined, result: ProxyResponse, span: ReturnType<Tracer['startSpan']>): Promise<InvokeResult> {

    if (call && this.deps.plugins) {
      try {
        result = await this.deps.plugins.afterCall(call, result);
      } catch (err) {
        const plugin = err instanceof PluginError ? err.plugin : undefined;
        result = { success: false, durationMs: result.durationMs, error: { code: ERR_PLUGIN_REJECTED, message: err instanceof Error ? err.message : String(err), data: { plugin } } };
      }
    }
    if (ctx.kind === 'tool') {
      this.deps.usage?.record({ clientId: ctx.clientId, tenants: this.deps.tenantsOf?.(ctx.clientId), serverId: ctx.serverId, tool: ctx.name, success: result.success, durationMs: result.durationMs });
      if (result.success && this.deps.costs?.enabled) {
        const c = this.deps.costs.record({ clientId: ctx.clientId, tenants: this.deps.tenantsOf?.(ctx.clientId), serverId: ctx.serverId, tool: ctx.name, result: result.result });
        if (c.cost) span.setAttribute('mcp.cost', c.cost);
        if (c.usage) span.setAttribute('gen_ai.usage.input_tokens', c.usage.inputTokens), span.setAttribute('gen_ai.usage.output_tokens', c.usage.outputTokens);
      }
    }
    const record = this.deps.metrics.record({
      serverId: ctx.serverId,
      toolName: ctx.name,
      durationMs: result.durationMs,
      success: result.success,
      errorMessage: result.error?.message,
      clientId: ctx.clientId,
      via: ctx.via,
      ...(ctx.kind === 'tool' ? {} : { kind: ctx.kind }),
      ...this.auditOf(ctx),
    });
    this.deps.recorder?.capture({
      id: record.id,
      timestamp: record.timestamp.toISOString(),
      serverId: ctx.serverId,
      tool: ctx.name,
      kind: ctx.kind,
      clientId: ctx.clientId,
      via: ctx.via,
      durationMs: result.durationMs,
      success: result.success,
      arguments: ctx.params,
      ...(result.success ? { result: result.result } : { error: result.error ? { code: result.error.code, message: record.errorMessage ?? result.error.message } : undefined }),
      ...(ctx.replayOf ? { replayOf: ctx.replayOf } : {}),
    });
    if (this.deps.requestLog?.() !== false) {
      const label = ctx.kind === 'tool' ? ctx.name : `${ctx.method} ${ctx.name}`;
      logger.info(`${label} → ${ctx.serverId} ${result.success ? 'ok' : 'failed'} ${result.durationMs}ms${ctx.via === 'mcp' ? ' (mcp)' : ''}`);
    }
    span.setAttribute('mcp.duration_ms', result.durationMs);
    span.setAttribute('mcp.success', result.success);
    if (!result.success) {
      span.setAttribute('mcp.error.code', result.error?.code);
      span.setError(result.error?.message ?? 'error');
    }
    span.end();
    return { ...result, traceparent: span.traceparent(), requestId: record.id };
  }

  get recorder(): ReplayRecorder | undefined {
    return this.deps.recorder;
  }
}

/** Failure kind of an upstream result (undefined = success or an application-level tool error). */
export function classifyFailure(r: ProxyResponse): FailureKind | undefined {
  if (r.success) return undefined;
  if (r.error?.code === ERR_NOT_CONNECTED) return 'not-connected';
  if (r.error?.code === ERR_TIMEOUT) return 'timeout';
  return 'error';
}
