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

import type { McpProxy, ProgressUpdate } from '../proxy/index.js';
import type { MetricsCollector } from '../monitor/index.js';
import type { ProxyResponse, ToolPolicyConfig } from '../utils/types.js';
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
export const POLICY_ERROR_CODES = new Set([ERR_POLICY_DENIED, ERR_APPROVAL_REJECTED, ERR_OUTPUT_BLOCKED, ERR_PLUGIN_REJECTED]);
import { ERR_PLUGIN_REJECTED, PluginError, type PluginCall, type PluginHost } from '../plugins/index.js';
export { ERR_PLUGIN_REJECTED };
import { logger } from '../utils/logger.js';
import { ERR_NOT_CONNECTED, ERR_TIMEOUT } from '../proxy/index.js';
import type { FailureKind, LoadBalancer } from './balancer.js';
import { NOOP_TRACER, type Tracer } from '../observability/tracing.js';

export type CallKind = 'tool' | 'resource' | 'prompt';

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
  /** Incoming W3C `traceparent` (parent span). */
  traceparent?: string;
}

export interface InvokeResult extends ProxyResponse {
  /** `traceparent` of the gateway span (empty when tracing is off). */
  traceparent: string;
}

export interface InvokerDeps {
  proxy: McpProxy;
  metrics: MetricsCollector;
  tracer?: () => Tracer;
  requestLog?: () => boolean;
  /** Current `policy` config (rules, approval, output filter). */
  policy?: () => ToolPolicyConfig | undefined;
  /** Queue for `approve` rules; created when absent. */
  approvals?: ApprovalQueue;
  /** Plugin hooks (`onToolCall` before policy, `onResponse` after the output filter). */
  plugins?: PluginHost;
  /** Routes calls on servers with `replicas:` (load balancing + failover). */
  balancer?: LoadBalancer;
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
      ? { serverId: ctx.serverId, name: ctx.name, kind: ctx.kind, method: ctx.method, arguments: ctx.params, clientId: ctx.clientId, via: ctx.via, state: new Map() }
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
    let result: ProxyResponse;
    try {
      result = await this.callUpstream(ctx, span);
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
    return this.finish(ctx, call, result, span);
  }

  get balancer(): LoadBalancer | undefined {
    return this.deps.balancer;
  }

  private send(ctx: InvokeContext, target: string): Promise<ProxyResponse> {
    return ctx.kind === 'tool'
      ? this.deps.proxy.callTool(target, ctx.name, ctx.params, ctx.timeoutMs, { signal: ctx.signal, onProgress: ctx.onProgress })
      : this.deps.proxy.request(target, ctx.method, ctx.params, ctx.timeoutMs, { signal: ctx.signal });
  }

  /** One upstream call, spread over replicas and failed over when the server has `replicas:`. */
  private async callUpstream(ctx: InvokeContext, span: ReturnType<Tracer['startSpan']>): Promise<ProxyResponse> {
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
    this.deps.metrics.record({
      serverId: ctx.serverId,
      toolName: ctx.name,
      durationMs: result.durationMs,
      success: result.success,
      errorMessage: result.error?.message,
      clientId: ctx.clientId,
      via: ctx.via,
      ...(ctx.kind === 'tool' ? {} : { kind: ctx.kind }),
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
    return { ...result, traceparent: span.traceparent() };
  }
}

/** Failure kind of an upstream result (undefined = success or an application-level tool error). */
export function classifyFailure(r: ProxyResponse): FailureKind | undefined {
  if (r.success) return undefined;
  if (r.error?.code === ERR_NOT_CONNECTED) return 'not-connected';
  if (r.error?.code === ERR_TIMEOUT) return 'timeout';
  return 'error';
}
