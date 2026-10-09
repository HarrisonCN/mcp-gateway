/**
 * OpenTelemetry GenAI semantic conventions (6.3).
 *
 * Every tool call through the gateway is described with the [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/):
 *
 * - a span `execute_tool <tool>` with `gen_ai.operation.name = execute_tool`, `gen_ai.tool.name`,
 *   `gen_ai.tool.call.id`, `gen_ai.tool.type = function`, `error.type` on failure, and `mcp.server.id`;
 * - for servers mapped to a GenAI provider (`systems`), calls are `chat` operations with `gen_ai.provider.name`,
 *   `gen_ai.request.model` (from the argument named by `modelArg`) and `gen_ai.usage.input_tokens` /
 *   `output_tokens` read from the result (`usage`, `_meta.usage`, or `structuredContent.usage`; OpenAI and Anthropic
 *   field names);
 * - metrics `gen_ai.client.operation.duration` (s) and `gen_ai.client.token.usage` ({token}) as histograms with the
 *   bucket boundaries the conventions recommend.
 *
 * Message content is not recorded unless `captureContent: true` (`gen_ai.input.messages` / `gen_ai.output.messages`
 * hold the JSON arguments / result, truncated to 4 KB).
 *
 * ```yaml
 * genaiTelemetry:
 *   systems: { llm: openai, claude: anthropic }   # server id → gen_ai.provider.name
 *   modelArg: model
 *   captureContent: false
 *   otlpEndpoint: http://otel-collector:4318      # optional: push spans + metrics as OTLP/HTTP JSON
 *   exportIntervalMs: 10000
 * ```
 *
 * - `GET /admin/genai-otel` — metric summary per operation / tool / model.
 * - `GET /admin/genai-otel/spans?limit=` — recent GenAI spans (newest first).
 * - `GET /admin/genai-otel/otlp` — the current metrics as an OTLP/JSON `resourceMetrics` payload.
 *
 * @module features/genai-otel
 */

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { registerFeature } from '../gateway/features.js';
import { registerCallHook, type HookCall } from '../gateway/hooks.js';
import type { GatewayConfig, ProxyResponse } from '../utils/types.js';
import { VERSION } from '../utils/version.js';
import { GenaiTelemetryConfig, GenaiTelemetrySchema } from './schemas/genai-otel.js';
export { GenaiTelemetryConfig, GenaiTelemetrySchema } from './schemas/genai-otel.js';
type Cfg = z.output<typeof GenaiTelemetrySchema>;

/** Recommended explicit bucket boundaries (GenAI semconv). */
export const GENAI_DURATION_BUCKETS = [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92];
export const GENAI_TOKEN_BUCKETS = [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864];

type Attr = string | number | boolean;
export interface GenaiSpan {
  traceId: string;
  spanId: string;
  name: string;
  startMs: number;
  endMs: number;
  attributes: Record<string, Attr>;
  error?: string;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** Token usage from a tool result (OpenAI `prompt_tokens` / `completion_tokens`, Anthropic / semconv `input_tokens` / `output_tokens`). */
export function extractUsage(result: unknown): { input?: number; output?: number } | undefined {
  const r = obj(result);
  const u = obj(r?.usage) ?? obj(obj(r?._meta)?.usage) ?? obj(obj(r?.structuredContent)?.usage);
  if (!u) return undefined;
  const input = num(u.input_tokens) ?? num(u.prompt_tokens) ?? num(u.inputTokens);
  const output = num(u.output_tokens) ?? num(u.completion_tokens) ?? num(u.outputTokens);
  return input === undefined && output === undefined ? undefined : { input, output };
}

const clip = (v: unknown) => {
  const s = JSON.stringify(v) ?? '';
  return s.length > 4096 ? s.slice(0, 4096) + '…' : s;
};

/** GenAI semconv attributes for one call. */
export function genaiAttributes(call: HookCall, result: ProxyResponse, cfg: Cfg, callId: string): Record<string, Attr> {
  const provider = cfg.systems[call.serverId];
  const a: Record<string, Attr> = {
    'gen_ai.operation.name': provider ? 'chat' : 'execute_tool',
    'gen_ai.tool.name': call.tool,
    'gen_ai.tool.call.id': callId,
    'gen_ai.tool.type': 'function',
    'mcp.server.id': call.serverId,
  };
  if (provider) {
    a['gen_ai.provider.name'] = provider;
    const model = call.args[cfg.modelArg];
    if (typeof model === 'string') a['gen_ai.request.model'] = model;
    const u = extractUsage(result.result);
    if (u?.input !== undefined) a['gen_ai.usage.input_tokens'] = u.input;
    if (u?.output !== undefined) a['gen_ai.usage.output_tokens'] = u.output;
    const rm = obj(result.result)?.model;
    if (typeof rm === 'string') a['gen_ai.response.model'] = rm;
  }
  if (!result.success) a['error.type'] = String(result.error?.code ?? 'error');
  if (cfg.captureContent) {
    a['gen_ai.input.messages'] = clip(call.args);
    if (result.success) a['gen_ai.output.messages'] = clip(result.result);
  }
  if (call.clientId) a['mcp.client.id'] = call.clientId;
  return a;
}

class Histogram {
  readonly counts: number[];
  count = 0;
  sum = 0;
  min = Infinity;
  max = -Infinity;
  constructor(readonly bounds: number[]) {
    this.counts = new Array(bounds.length + 1).fill(0);
  }
  record(v: number): void {
    let i = this.bounds.findIndex((b) => v <= b);
    if (i < 0) i = this.bounds.length;
    this.counts[i]!++;
    this.count++;
    this.sum += v;
    this.min = Math.min(this.min, v);
    this.max = Math.max(this.max, v);
  }
}

const KEY_ATTRS = ['gen_ai.operation.name', 'gen_ai.provider.name', 'gen_ai.request.model', 'gen_ai.tool.name', 'error.type'] as const;

/** Spans and metrics for GenAI calls (process-wide; bounded span buffer). */
export class GenaiRecorder {
  readonly spans: GenaiSpan[] = [];
  readonly duration = new Map<string, { attrs: Record<string, Attr>; h: Histogram }>();
  readonly tokens = new Map<string, { attrs: Record<string, Attr>; h: Histogram }>();
  private readonly startMs = Date.now();
  constructor(private readonly maxSpans = 1000) {}

  record(call: HookCall, result: ProxyResponse, cfg: Cfg, now = Date.now()): GenaiSpan {
    const callId = randomBytes(8).toString('hex');
    const attributes = genaiAttributes(call, result, cfg, callId);
    const op = String(attributes['gen_ai.operation.name']);
    const span: GenaiSpan = {
      traceId: randomBytes(16).toString('hex'),
      spanId: callId,
      name: op === 'chat' ? `chat ${attributes['gen_ai.request.model'] ?? call.tool}` : `execute_tool ${call.tool}`,
      startMs: now - result.durationMs,
      endMs: now,
      attributes,
      ...(result.success ? {} : { error: result.error?.message ?? 'error' }),
    };
    this.spans.push(span);
    if (this.spans.length > this.maxSpans) this.spans.splice(0, this.spans.length - this.maxSpans);
    const key = Object.fromEntries(KEY_ATTRS.filter((k) => attributes[k] !== undefined).map((k) => [k, attributes[k]!]));
    const put = (m: GenaiRecorder['duration'], attrs: Record<string, Attr>, bounds: number[], v: number) => {
      const k = JSON.stringify(attrs);
      let e = m.get(k);
      if (!e) m.set(k, (e = { attrs, h: new Histogram(bounds) }));
      e.h.record(v);
    };
    put(this.duration, key, GENAI_DURATION_BUCKETS, result.durationMs / 1000);
    const { 'error.type': _e, ...tk } = key;
    if (typeof attributes['gen_ai.usage.input_tokens'] === 'number') put(this.tokens, { ...tk, 'gen_ai.token.type': 'input' }, GENAI_TOKEN_BUCKETS, attributes['gen_ai.usage.input_tokens']);
    if (typeof attributes['gen_ai.usage.output_tokens'] === 'number') put(this.tokens, { ...tk, 'gen_ai.token.type': 'output' }, GENAI_TOKEN_BUCKETS, attributes['gen_ai.usage.output_tokens']);
    return span;
  }

  summary() {
    const rows = (m: GenaiRecorder['duration']) => [...m.values()].map(({ attrs, h }) => ({ attributes: attrs, count: h.count, sum: Math.round(h.sum * 1e6) / 1e6, min: h.min, max: h.max }));
    return { spans: this.spans.length, 'gen_ai.client.operation.duration': rows(this.duration), 'gen_ai.client.token.usage': rows(this.tokens) };
  }

  /** OTLP/JSON metrics payload (cumulative histograms). */
  otlpMetrics(serviceName: string, now = Date.now()): unknown {
    const attrs = (o: Record<string, Attr>) => Object.entries(o).map(([key, v]) => ({ key, value: typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : typeof v === 'boolean' ? { boolValue: v } : { stringValue: v } }));
    const ns = (ms: number) => `${BigInt(Math.round(ms)) * 1_000_000n}`;
    const metric = (name: string, unit: string, m: GenaiRecorder['duration']) => ({
      name,
      unit,
      histogram: {
        aggregationTemporality: 2,
        dataPoints: [...m.values()].map(({ attrs: a, h }) => ({ attributes: attrs(a), startTimeUnixNano: ns(this.startMs), timeUnixNano: ns(now), count: String(h.count), sum: h.sum, min: h.min, max: h.max, explicitBounds: h.bounds, bucketCounts: h.counts.map(String) })),
      },
    });
    return {
      resourceMetrics: [
        {
          resource: { attributes: attrs({ 'service.name': serviceName, 'service.version': VERSION }) },
          scopeMetrics: [{ scope: { name: 'mcp-gateway.genai' }, metrics: [metric('gen_ai.client.operation.duration', 's', this.duration), metric('gen_ai.client.token.usage', '{token}', this.tokens)] }],
        },
      ],
    };
  }

  /** OTLP/JSON traces payload for the given spans. */
  otlpSpans(spans: GenaiSpan[], serviceName: string): unknown {
    const attrs = (o: Record<string, Attr>) => Object.entries(o).map(([key, v]) => ({ key, value: typeof v === 'number' ? { intValue: String(v) } : typeof v === 'boolean' ? { boolValue: v } : { stringValue: v } }));
    return {
      resourceSpans: [
        {
          resource: { attributes: attrs({ 'service.name': serviceName }) },
          scopeSpans: [{ scope: { name: 'mcp-gateway.genai' }, spans: spans.map((s) => ({ traceId: s.traceId, spanId: s.spanId, name: s.name, kind: 3, startTimeUnixNano: `${BigInt(s.startMs) * 1_000_000n}`, endTimeUnixNano: `${BigInt(s.endMs) * 1_000_000n}`, attributes: attrs(s.attributes), status: s.error ? { code: 2, message: s.error } : { code: 1 } })) }],
        },
      ],
    };
  }
}

export const genaiRecorder = new GenaiRecorder();

const settings = (cfg: GatewayConfig): Cfg | undefined => {
  if (!cfg.genaiTelemetry) return undefined;
  const c = GenaiTelemetrySchema.parse(cfg.genaiTelemetry);
  return c.enabled ? c : undefined;
};

registerCallHook({
  id: 'genai-otel',
  after: (call, result, cfg) => {
    const c = settings(cfg);
    if (c) genaiRecorder.record(call, result, c);
  },
});

registerFeature({
  id: 'genai-otel',
  since: '6.3.0',
  summary: 'OpenTelemetry GenAI semantic conventions: execute_tool spans, operation duration and token usage metrics, OTLP export',
  mount: (router, ctx) => {
    let exported = genaiRecorder.spans.length ? genaiRecorder.spans.at(-1)! : undefined;
    const push = async () => {
      const c = settings(ctx.config());
      if (!c?.otlpEndpoint) return;
      const i = exported ? genaiRecorder.spans.indexOf(exported) + 1 : 0;
      const fresh = genaiRecorder.spans.slice(i);
      exported = genaiRecorder.spans.at(-1);
      const base = c.otlpEndpoint.replace(/\/+$/, '');
      const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) }).catch(() => undefined);
      if (fresh.length) await post('/v1/traces', genaiRecorder.otlpSpans(fresh, c.serviceName));
      await post('/v1/metrics', genaiRecorder.otlpMetrics(c.serviceName));
    };
    const iv = settings(ctx.config())?.exportIntervalMs ?? 10_000;
    const timer = setInterval(() => void push(), iv);
    timer.unref();
    ctx.onStop?.(async () => {
      clearInterval(timer);
      await push();
    });
    router.get('/', (_req, res) => {
      const c = settings(ctx.config());
      res.json({ enabled: !!c, systems: c?.systems ?? {}, captureContent: c?.captureContent ?? false, otlpEndpoint: c?.otlpEndpoint ?? null, ...genaiRecorder.summary() });
    });
    router.get('/spans', (req, res) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 1000);
      res.json({ spans: genaiRecorder.spans.slice(-limit).reverse() });
    });
    router.get('/otlp', (_req, res) => {
      res.json(genaiRecorder.otlpMetrics(settings(ctx.config())?.serviceName ?? 'mcp-gateway'));
    });
  },
});
