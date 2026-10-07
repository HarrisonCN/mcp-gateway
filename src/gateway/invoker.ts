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
import type { ProxyResponse } from '../utils/types.js';
import { logger } from '../utils/logger.js';
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
}

export class ToolInvoker {
  constructor(private readonly deps: InvokerDeps) {}

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
    let result: ProxyResponse;
    try {
      result =
        ctx.kind === 'tool'
          ? await this.deps.proxy.callTool(ctx.serverId, ctx.name, ctx.params, ctx.timeoutMs, {
              signal: ctx.signal,
              onProgress: ctx.onProgress,
            })
          : await this.deps.proxy.request(ctx.serverId, ctx.method, ctx.params, ctx.timeoutMs, { signal: ctx.signal });
    } catch (err) {
      span.setError(err instanceof Error ? err.message : String(err));
      span.end();
      throw err;
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
