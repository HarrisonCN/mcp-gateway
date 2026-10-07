/**
 * Optional distributed tracing (`observability.tracing`).
 *
 * A small span implementation with W3C Trace Context propagation and an
 * OTLP/HTTP JSON exporter, so traces reach any OpenTelemetry collector
 * (Jaeger, Tempo, Honeycomb, Datadog, …) without adding the OpenTelemetry SDK
 * as a dependency. With `exporter: otel-api`, spans are created through
 * `@opentelemetry/api` instead (install it and register your own SDK /
 * TracerProvider; the gateway then joins your process-wide tracing setup).
 *
 * Spans: one per tool / resource / prompt call (`mcp.tools/call <tool>`),
 * child of the caller's `traceparent` when the request carries one, with
 * attributes `mcp.server.id`, `mcp.tool.name`, `mcp.via`, `mcp.client.id`,
 * `mcp.duration_ms` and error status. The response carries `traceparent`.
 *
 * @module observability/tracing
 */

import { randomBytes } from 'crypto';
import type { TracingConfig } from '../utils/types.js';
import { logger } from '../utils/logger.js';

export interface SpanContext {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

export type AttributeValue = string | number | boolean;

export interface Span {
  readonly context: SpanContext;
  setAttribute(key: string, value: AttributeValue | undefined): void;
  setError(message: string): void;
  end(): void;
  /** `traceparent` header value for this span. */
  traceparent(): string;
}

export interface Tracer {
  readonly enabled: boolean;
  startSpan(name: string, options?: { parent?: string; attributes?: Record<string, AttributeValue | undefined>; kind?: SpanKind }): Span;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export type SpanKind = 'internal' | 'server' | 'client';
const KIND_CODE: Record<SpanKind, number> = { internal: 1, server: 2, client: 3 };

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** Parse a W3C `traceparent` header (version 00). */
export function parseTraceparent(header: string | undefined): SpanContext | undefined {
  if (!header) return undefined;
  const m = TRACEPARENT_RE.exec(header.trim().toLowerCase());
  if (!m) return undefined;
  const [, traceId, spanId, flags] = m;
  if (/^0+$/.test(traceId!) || /^0+$/.test(spanId!)) return undefined;
  return { traceId: traceId!, spanId: spanId!, sampled: (parseInt(flags!, 16) & 1) === 1 };
}

export function formatTraceparent(ctx: SpanContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.sampled ? '01' : '00'}`;
}

const hex = (bytes: number) => randomBytes(bytes).toString('hex');

/** No-op tracer (tracing disabled). */
export const NOOP_TRACER: Tracer = {
  enabled: false,
  startSpan(_name, options) {
    const parent = parseTraceparent(options?.parent);
    const context = parent ?? { traceId: '0'.repeat(32), spanId: '0'.repeat(16), sampled: false };
    return {
      context,
      setAttribute() {},
      setError() {},
      end() {},
      traceparent: () => (parent ? formatTraceparent(parent) : ''),
    };
  },
  flush: async () => {},
  shutdown: async () => {},
};

interface FinishedSpan {
  name: string;
  kind: SpanKind;
  context: SpanContext;
  parentSpanId?: string;
  startNs: bigint;
  endNs: bigint;
  attributes: Record<string, AttributeValue>;
  error?: string;
}

export interface SpanExporter {
  export(spans: FinishedSpan[]): Promise<void>;
}

function otlpValue(v: AttributeValue): Record<string, unknown> {
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: v };
}

/** OTLP/HTTP JSON payload for a batch of spans. */
export function toOtlpJson(spans: FinishedSpan[], serviceName: string, resourceAttributes: Record<string, string> = {}): unknown {
  const attrs = (o: Record<string, AttributeValue>) => Object.entries(o).map(([key, value]) => ({ key, value: otlpValue(value) }));
  return {
    resourceSpans: [
      {
        resource: { attributes: attrs({ 'service.name': serviceName, ...resourceAttributes }) },
        scopeSpans: [
          {
            scope: { name: 'mcp-gateway' },
            spans: spans.map((s) => ({
              traceId: s.context.traceId,
              spanId: s.context.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: KIND_CODE[s.kind],
              startTimeUnixNano: s.startNs.toString(),
              endTimeUnixNano: s.endNs.toString(),
              attributes: attrs(s.attributes),
              status: s.error ? { code: 2, message: s.error } : { code: 1 },
            })),
          },
        ],
      },
    ],
  };
}

export class OtlpHttpExporter implements SpanExporter {
  constructor(
    private readonly endpoint: string,
    private readonly serviceName: string,
    private readonly headers: Record<string, string> = {},
    private readonly resourceAttributes: Record<string, string> = {},
  ) {}

  async export(spans: FinishedSpan[]): Promise<void> {
    const r = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers },
      body: JSON.stringify(toOtlpJson(spans, this.serviceName, this.resourceAttributes)),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`OTLP export answered ${r.status}`);
  }
}

export class ConsoleExporter implements SpanExporter {
  async export(spans: FinishedSpan[]): Promise<void> {
    for (const s of spans) {
      const ms = Number(s.endNs - s.startNs) / 1e6;
      logger.info(`[trace] ${s.name} ${s.context.traceId}/${s.context.spanId} ${ms.toFixed(1)}ms${s.error ? ` error=${s.error}` : ''}`);
    }
  }
}

const nowNs = () => BigInt(Date.now()) * 1_000_000n + (process.hrtime.bigint() % 1_000_000n);

/** Batching tracer used for the built-in exporters. */
export class BatchTracer implements Tracer {
  readonly enabled = true;
  private queue: FinishedSpan[] = [];
  private timer?: NodeJS.Timeout;
  private exporting?: Promise<void>;
  private dropped = 0;

  constructor(
    private readonly exporter: SpanExporter,
    private readonly options: { sampleRatio?: number; maxQueue?: number; batchSize?: number; flushIntervalMs?: number } = {},
  ) {
    this.timer = setInterval(() => void this.flush(), options.flushIntervalMs ?? 2_000);
    this.timer.unref();
  }

  startSpan(name: string, options: { parent?: string; attributes?: Record<string, AttributeValue | undefined>; kind?: SpanKind } = {}): Span {
    const parent = parseTraceparent(options.parent);
    const sampled = parent ? parent.sampled : Math.random() < (this.options.sampleRatio ?? 1);
    const context: SpanContext = { traceId: parent?.traceId ?? hex(16), spanId: hex(8), sampled };
    const attributes: Record<string, AttributeValue> = {};
    for (const [k, v] of Object.entries(options.attributes ?? {})) if (v !== undefined) attributes[k] = v;
    const startNs = nowNs();
    let error: string | undefined;
    let ended = false;
    return {
      context,
      setAttribute: (k, v) => {
        if (v !== undefined) attributes[k] = v;
      },
      setError: (m) => {
        error = m;
      },
      traceparent: () => formatTraceparent(context),
      end: () => {
        if (ended || !sampled) return;
        ended = true;
        this.enqueue({ name, kind: options.kind ?? 'server', context, parentSpanId: parent?.spanId, startNs, endNs: nowNs(), attributes, error });
      },
    };
  }

  private enqueue(span: FinishedSpan): void {
    if (this.queue.length >= (this.options.maxQueue ?? 2048)) {
      this.dropped++;
      return;
    }
    this.queue.push(span);
    if (this.queue.length >= (this.options.batchSize ?? 256)) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.exporting) await this.exporting;
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    this.exporting = this.exporter.export(batch).catch((err: unknown) => {
      logger.warn(`Trace export failed (${batch.length} spans dropped): ${err instanceof Error ? err.message : String(err)}`);
    });
    await this.exporting;
    this.exporting = undefined;
    if (this.dropped > 0) {
      logger.warn(`Tracing queue full: ${this.dropped} spans dropped`);
      this.dropped = 0;
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }
}

/** Tracer backed by `@opentelemetry/api` (loaded dynamically; optional peer dependency). */
export async function createOtelApiTracer(serviceName: string): Promise<Tracer> {
  const spec = '@opentelemetry/api';
  let api: {
    trace: { getTracer(n: string): { startSpan(n: string, o: unknown, ctx?: unknown): OtelSpan }; setSpanContext(ctx: unknown, sc: unknown): unknown };
    context: { active(): unknown };
    propagation: { extract(ctx: unknown, carrier: Record<string, string>): unknown };
    SpanStatusCode: { ERROR: number };
  };
  try {
    api = (await import(spec)) as typeof api;
  } catch {
    throw new Error('observability.tracing.exporter "otel-api" requires the @opentelemetry/api package (npm i @opentelemetry/api)');
  }
  interface OtelSpan {
    spanContext(): { traceId: string; spanId: string; traceFlags: number };
    setAttribute(k: string, v: AttributeValue): void;
    setStatus(s: { code: number; message?: string }): void;
    end(): void;
  }
  const tracer = api.trace.getTracer(serviceName);
  return {
    enabled: true,
    startSpan(name, options = {}) {
      const parentCtx = options.parent ? api.propagation.extract(api.context.active(), { traceparent: options.parent }) : api.context.active();
      const s = tracer.startSpan(name, { kind: KIND_CODE[options.kind ?? 'server'], attributes: options.attributes }, parentCtx);
      const sc = s.spanContext();
      const context = { traceId: sc.traceId, spanId: sc.spanId, sampled: (sc.traceFlags & 1) === 1 };
      return {
        context,
        setAttribute: (k, v) => {
          if (v !== undefined) s.setAttribute(k, v);
        },
        setError: (m) => s.setStatus({ code: api.SpanStatusCode.ERROR, message: m }),
        end: () => s.end(),
        traceparent: () => formatTraceparent(context),
      };
    },
    flush: async () => {},
    shutdown: async () => {},
  };
}

/** Build the configured tracer (no-op when disabled). */
export async function createTracer(config: TracingConfig | undefined): Promise<Tracer> {
  if (!config?.enabled) return NOOP_TRACER;
  const serviceName = config.serviceName ?? 'mcp-gateway';
  const exporter = config.exporter ?? 'otlp-http';
  if (exporter === 'otel-api') return createOtelApiTracer(serviceName);
  const ex =
    exporter === 'console'
      ? new ConsoleExporter()
      : new OtlpHttpExporter(
          config.endpoint ?? process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? 'http://localhost:4318/v1/traces',
          serviceName,
          config.headers,
          config.resourceAttributes,
        );
  return new BatchTracer(ex, { sampleRatio: config.sampleRatio, flushIntervalMs: config.flushIntervalMs });
}
