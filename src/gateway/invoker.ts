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

import { callHooks, type HookCall } from './hooks.js';
import type { McpProxy, ProgressUpdate, RelayCaller } from '../proxy/index.js';
import type { MetricsCollector } from '../monitor/index.js';
import type { McpServerConfig, ProxyResponse, ToolPolicyConfig } from '../utils/types.js';
import { evaluatePolicy } from '../policy/tool-policy.js';
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
import type { FailureKind, LoadBalancer } from './balancer.js';
import type { RouteDecision, SmartRouter } from './routing.js';
import type { SecretManager } from '../secrets/index.js';
import type { Federation } from './federation.js';
import type { ToolCache } from './cache.js';
import { ERR_QUOTA_EXCEEDED, type UsageMeter } from './usage.js';
import { ERR_BUDGET_EXCEEDED, type CostLedger } from '../costs/index.js';
export { ERR_QUOTA_EXCEEDED };
import { NOOP_TRACER, type Tracer } from '../observability/tracing.js';
import type { ReplayRecorder } from './replay.js';

export type CallKind = 'tool' | 'resource' | 'prompt';

/** A per-call credential could not be resolved (3.5). */
export const ERR_SECRET_UNAVAILABLE = -32010;

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
}

export class ToolInvoker {
  readonly approvals: ApprovalQueue;
  private filter?: { config: unknown; filter: OutputFilter };
  /** Prompt-injection findings since start (per pattern). */
  readonly filterFindings = new Map<string, number>();

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
    });
    if (this.deps.requestLog?.() !== false) logger.info(`${ctx.name} → ${ctx.serverId} refused: ${message}`);
    const hookCfg = ctx.kind === 'tool' ? this.deps.config?.() : undefined;
    if (hookCfg) {
      const call: HookCall = { serverId: ctx.serverId, tool: ctx.name, clientId: ctx.clientId, tenant: this.deps.tenantsOf?.(ctx.clientId)?.[0], args: ctx.params };
      for (const h of callHooks()) {
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
  private async checkPolicy(ctx: InvokeContext, span: ReturnType<Tracer['startSpan']>): Promise<InvokeResult | undefined> {
    const policy = this.deps.policy?.();
    if (!policy || ctx.kind !== 'tool') return undefined;
    const decision = evaluatePolicy(policy, { clientId: ctx.clientId, serverId: ctx.serverId, tool: ctx.name, args: ctx.params });
    if (decision.effect === 'allow') return undefined;
    if (decision.effect === 'deny') {
      const message = decision.message ?? `Tool call denied by policy${decision.rule ? ` (rule ${decision.rule})` : ''}`;
      return this.refuse(ctx, ERR_POLICY_DENIED, message, { decision: 'deny', rule: decision.rule }, span);
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
    return this.refuse(ctx, ERR_APPROVAL_REJECTED, message, { decision: 'approve', approval: status, rule: decision.rule }, span);
  }

  private tracer(): Tracer {
    return this.deps.tracer?.() ?? NOOP_TRACER;
  }

  async invoke(ctx: InvokeContext): Promise<InvokeResult> {
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
    const refused = await this.checkPolicy(ctx, span);
    if (refused) return refused;
    const comp = this.deps.compliance;
    if (comp && ctx.kind === 'tool') {
      const tenant = this.deps.tenantsOf?.(ctx.clientId)?.[0];
      const region = this.deps.serverConfig?.(ctx.serverId)?.region;
      if (!ctx.fromPeer && !comp.residencyAllows(tenant, region)) {
        comp.noteResidencyBlock();
        const message = `Data residency: ${tenant ? `tenant "${tenant}"` : 'this client'} may not send data to region ${region ?? '(unknown)'}`;
        return this.refuse(ctx, ERR_RESIDENCY, message, { decision: 'residency', region: region ?? null, allowed: comp.regionsFor(tenant) }, span);
      }
    }
    // 5.6: feature call hooks (before).
    const hookCfg = this.deps.config?.();
    const hookCall = (): HookCall => ({ serverId: ctx.serverId, tool: ctx.name, clientId: ctx.clientId, tenant: this.deps.tenantsOf?.(ctx.clientId)?.[0], args: ctx.params });
    let preset: ProxyResponse | undefined;
    if (hookCfg && ctx.kind === 'tool') {
      for (const h of callHooks()) {
        if (!h.before) continue;
        const out = await h.before(hookCall(), hookCfg);
        if (out?.refuse) return this.refuse(ctx, out.refuse.code, out.refuse.message, { decision: h.id, ...(out.refuse.data ?? {}) }, span);
        if (out?.args) ctx = { ...ctx, params: out.args };
        if (out?.serverId && out.serverId !== ctx.serverId) {
          span.setAttribute('mcp.rerouted', `${ctx.serverId}->${out.serverId}`);
          ctx = { ...ctx, serverId: out.serverId };
        }
        if (out?.respond) {
          preset = out.respond;
          span.setAttribute('mcp.hook_response', h.id);
          break;
        }
      }
    }
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
        const out = await cache.run({ serverId: ctx.serverId, tool: ctx.name, args: ctx.params, clientId: ctx.clientId }, () => this.callUpstream(ctx, span));
        if (out.status !== 'bypass') span.setAttribute('mcp.cache', out.status);
        result = out.status === 'hit' || out.status === 'shared' ? { ...out.result, durationMs: out.status === 'hit' ? 0 : out.result.durationMs } : out.result;
      } else {
        result = await this.callUpstream(ctx, span);
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
    if (hookCfg && ctx.kind === 'tool') {
      for (const h of callHooks()) {
        if (!h.after) continue;
        const out = await h.after(hookCall(), result, hookCfg);
        if (out) result = out;
      }
    }
    return this.finish(ctx, call, result, span);
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

  private send(ctx: InvokeContext, target: string): Promise<ProxyResponse> {
    return ctx.kind === 'tool'
      ? this.deps.proxy.callTool(target, ctx.name, ctx.params, ctx.timeoutMs, { signal: ctx.signal, onProgress: ctx.onProgress, caller: ctx.caller, meta: ctx.meta })
      : this.deps.proxy.request(target, ctx.method, ctx.meta ? { ...ctx.params, _meta: { ...((ctx.params._meta as Record<string, unknown>) ?? {}), ...ctx.meta } } : ctx.params, ctx.timeoutMs, { signal: ctx.signal, caller: ctx.caller });
  }

  /** One upstream call, spread over replicas and failed over when the server has `replicas:`. */
  /** Per-call credentials (`inject:`), added after plugins, policy, cache keys and capture saw the call (3.5). */
  private async injectSecrets(ctx: InvokeContext): Promise<InvokeContext> {
    const secrets = this.deps.secrets;
    const server = this.deps.serverConfig?.(ctx.serverId);
    if (!secrets || !server?.inject?.length) return ctx;
    const values = await secrets.injections(server, { tenant: this.deps.tenantsOf?.(ctx.clientId)?.[0], clientId: ctx.clientId });
    let params = ctx.params;
    let meta = ctx.meta;
    for (const v of values) {
      if (v.argument && ctx.kind === 'tool') params = { ...params, [v.argument]: v.value };
      if (v.meta) meta = { ...(meta ?? {}), [v.meta]: v.value };
    }
    return { ...ctx, params, meta };
  }

  private async callUpstream(ctx: InvokeContext, span: ReturnType<Tracer['startSpan']>): Promise<ProxyResponse> {
    const fed = this.deps.federation;
    const canFailover = ctx.kind === 'tool' && !ctx.fromPeer && !!fed?.failsOver(ctx.serverId);
    const local = await this.callLocal(ctx, span);
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

  private async callLocal(ctx: InvokeContext, span: ReturnType<Tracer['startSpan']>): Promise<ProxyResponse> {
    try {
      ctx = await this.injectSecrets(ctx);
    } catch (err) {
      const message = `Credential injection failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.warn(`${ctx.serverId}/${ctx.name}: ${message}`);
      return { success: false, durationMs: 0, error: { code: ERR_SECRET_UNAVAILABLE, message } };
    }
    const route: RouteDecision | undefined = ctx.kind === 'tool' ? this.deps.router?.route(ctx.serverId, ctx.name, ctx.clientId) : undefined;
    if (route) {
      span.setAttribute('mcp.route.split', route.split);
      span.setAttribute('mcp.route.variant', route.variant);
      const routed = { ...ctx, serverId: route.server };
      try {
        const r = await this.balancedCall(routed, span);
        this.deps.router!.report(route, r.success, r.durationMs);
        return r;
      } catch (err) {
        this.deps.router!.report(route, false, 0);
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
