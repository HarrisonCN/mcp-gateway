import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { fileURLToPath } from 'url';
import { Gateway } from '../src/gateway/index.js';
import {
  BatchTracer,
  NOOP_TRACER,
  createTracer,
  formatTraceparent,
  parseTraceparent,
  toOtlpJson,
  type SpanExporter,
} from '../src/observability/tracing.js';
import { MetricsCollector, LATENCY_BUCKETS_SECONDS } from '../src/monitor/index.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));

let gw: Gateway | undefined;
let sink: { server: Server; url: string; bodies: unknown[] } | undefined;
afterEach(async () => {
  await gw?.stop();
  gw = undefined;
  if (sink) await new Promise<void>((r) => sink!.server.close(() => r()));
  sink = undefined;
});

async function startSink() {
  const bodies: unknown[] = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      bodies.push(JSON.parse(data));
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  sink = { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`, bodies };
  return sink;
}

const PARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

describe('trace context', () => {
  it('parses and formats W3C traceparent', () => {
    const ctx = parseTraceparent(PARENT)!;
    expect(ctx).toEqual({ traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331', sampled: true });
    expect(formatTraceparent(ctx)).toBe(PARENT);
    expect(parseTraceparent('00-00000000000000000000000000000000-b7ad6b7169203331-01')).toBeUndefined();
    expect(parseTraceparent('garbage')).toBeUndefined();
    expect(parseTraceparent(undefined)).toBeUndefined();
    expect(parseTraceparent(PARENT.replace(/-01$/, '-00'))!.sampled).toBe(false);
  });

  it('noop tracer passes an incoming context through', () => {
    const span = NOOP_TRACER.startSpan('x', { parent: PARENT });
    expect(span.traceparent()).toBe(PARENT);
    span.setAttribute('a', 1);
    span.setError('e');
    span.end();
    expect(NOOP_TRACER.startSpan('y').traceparent()).toBe('');
  });

  it('batch tracer exports child spans and honours sampling', async () => {
    const exported: unknown[][] = [];
    const exporter: SpanExporter = { export: async (spans) => void exported.push(spans) };
    const tracer = new BatchTracer(exporter, { flushIntervalMs: 60_000 });
    const span = tracer.startSpan('op', { parent: PARENT, attributes: { a: 'b', skip: undefined } });
    expect(span.context.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(span.context.spanId).not.toBe('b7ad6b7169203331');
    span.setAttribute('n', 2);
    span.setError('boom');
    span.end();
    span.end(); // idempotent
    tracer.startSpan('unsampled', { parent: PARENT.replace(/-01$/, '-00') }).end();
    new BatchTracer(exporter, { sampleRatio: 0 }).startSpan('never').end();
    await tracer.shutdown();
    expect(exported).toHaveLength(1);
    const [s] = exported[0] as Array<{ name: string; parentSpanId: string; attributes: Record<string, unknown>; error: string }>;
    expect(s).toMatchObject({ name: 'op', parentSpanId: 'b7ad6b7169203331', attributes: { a: 'b', n: 2 }, error: 'boom' });
    expect('skip' in s!.attributes).toBe(false);
  });

  it('builds OTLP JSON', () => {
    const json = toOtlpJson(
      [
        {
          name: 'n',
          kind: 'server',
          context: { traceId: 't'.repeat(32), spanId: 's'.repeat(16), sampled: true },
          startNs: 1n,
          endNs: 2n,
          attributes: { str: 'x', int: 3, dbl: 1.5, bool: true },
        },
      ],
      'svc',
      { env: 'test' },
    ) as { resourceSpans: Array<{ resource: { attributes: unknown[] }; scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }> };
    const rs = json.resourceSpans[0]!;
    expect(rs.resource.attributes).toContainEqual({ key: 'service.name', value: { stringValue: 'svc' } });
    const span = rs.scopeSpans[0]!.spans[0]!;
    expect(span).toMatchObject({ kind: 2, startTimeUnixNano: '1', status: { code: 1 } });
    expect(span.attributes).toContainEqual({ key: 'int', value: { intValue: '3' } });
    expect(span.attributes).toContainEqual({ key: 'dbl', value: { doubleValue: 1.5 } });
    expect(span.attributes).toContainEqual({ key: 'bool', value: { boolValue: true } });
  });

  it('createTracer: disabled → noop, console exporter, otel-api needs the package', async () => {
    expect((await createTracer(undefined)).enabled).toBe(false);
    const c = await createTracer({ enabled: true, exporter: 'console' });
    expect(c.enabled).toBe(true);
    c.startSpan('x').end();
    await c.shutdown();
    await expect(createTracer({ enabled: true, exporter: 'otel-api' })).rejects.toThrow(/@opentelemetry\/api/);
  });
});

describe('gateway tracing + Prometheus', () => {
  const base = (extra: Partial<GatewayConfig> = {}): GatewayConfig => ({
    port: 0,
    host: '127.0.0.1',
    logLevel: 'error',
    monitor: { prometheus: true, requestLog: false },
    servers: [{ id: 'fake', name: 'fake', transport: 'stdio', command: process.execPath, args: [fixture], timeout: 3000 }],
    ...extra,
  });

  it('exports a span per tool call (REST and /mcp), continuing the caller trace', async () => {
    const s = await startSink();
    gw = new Gateway(base({ observability: { tracing: { enabled: true, endpoint: s.url, serviceName: 'gw-test', flushIntervalMs: 100 } } }));
    await gw.start();
    const url = `http://127.0.0.1:${gw.address()!.port}`;
    const r = await fetch(`${url}/api/v1/tools/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', traceparent: PARENT },
      body: JSON.stringify({ tool: 'echo', arguments: { a: 1 } }),
    });
    expect(r.status).toBe(200);
    const tp = parseTraceparent(r.headers.get('traceparent')!)!;
    expect(tp.traceId).toBe('0af7651916cd43dd8448eb211c80319c');

    const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const init = await fetch(`${url}/mcp`, { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) });
    const sid = init.headers.get('mcp-session-id')!;
    const call = await fetch(`${url}/mcp`, { method: 'POST', headers: { ...H, 'mcp-session-id': sid, accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: {} } }) });
    expect(call.headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    await gw.stop();
    gw = undefined;
    const spans = s.bodies.flatMap(
      (b) => (b as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string; parentSpanId?: string; attributes: Array<{ key: string; value: Record<string, unknown> }> }> }> }> }).resourceSpans[0]!.scopeSpans[0]!.spans,
    );
    expect(spans.map((x) => x.name)).toEqual(['mcp.tools/call echo', 'mcp.tools/call echo']);
    expect(spans[0]!.parentSpanId).toBe('b7ad6b7169203331');
    const attr = (k: string) => spans[1]!.attributes.find((a) => a.key === k)?.value;
    expect(attr('mcp.via')).toEqual({ stringValue: 'mcp' });
    expect(attr('mcp.server.id')).toEqual({ stringValue: 'fake' });
    expect(attr('mcp.success')).toEqual({ boolValue: true });
  });

  it('serves a latency histogram at /metrics', async () => {
    gw = new Gateway(base());
    await gw.start();
    const url = `http://127.0.0.1:${gw.address()!.port}`;
    await fetch(`${url}/api/v1/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'echo' }) });
    const text = await (await fetch(`${url}/metrics`)).text();
    expect(text).toContain('# TYPE mcp_gateway_request_duration_seconds histogram');
    expect(text).toMatch(/mcp_gateway_request_duration_seconds_bucket\{server="fake",le="\+Inf"\} 1/);
    expect(text).toMatch(/mcp_gateway_request_duration_seconds_count\{server="fake"\} 1/);
    expect(r(text)).toBeGreaterThan(0);
    function r(t: string) {
      return t.split('\n').filter((l) => l.startsWith('mcp_gateway_request_duration_seconds_bucket')).length;
    }
  });

  it('protects /metrics with auth.protect.metrics and hides it without prometheus', async () => {
    gw = new Gateway(base({ auth: { strategy: 'api-key', apiKeys: ['x'.repeat(32)], protect: { metrics: true } } }));
    await gw.start();
    const url = `http://127.0.0.1:${gw.address()!.port}`;
    expect((await fetch(`${url}/metrics`)).status).toBe(401);
    expect((await fetch(`${url}/metrics`, { headers: { authorization: `Bearer ${'x'.repeat(32)}` } })).status).toBe(200);
    await gw.stop();
    gw = new Gateway(base({ monitor: { prometheus: false, requestLog: false } }));
    await gw.start();
    expect((await fetch(`http://127.0.0.1:${gw.address()!.port}/metrics`)).status).toBe(404);
  });

  it('histogram buckets are cumulative', () => {
    const m = new MetricsCollector();
    m.record({ serverId: 's', toolName: 't', durationMs: 30, success: true });
    m.record({ serverId: 's', toolName: 't', durationMs: 3000, success: false });
    const text = m.toPrometheusText();
    expect(text).toContain('mcp_gateway_request_duration_seconds_bucket{server="s",le="0.05"} 1');
    expect(text).toContain('mcp_gateway_request_duration_seconds_bucket{server="s",le="5"} 2');
    expect(text).toContain('mcp_gateway_request_duration_seconds_sum{server="s"} 3.030000');
    expect(LATENCY_BUCKETS_SECONDS.length).toBeGreaterThan(5);
  });
});
