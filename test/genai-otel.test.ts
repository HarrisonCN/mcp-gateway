import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { GenaiRecorder, GenaiTelemetrySchema, extractUsage, genaiAttributes, GENAI_DURATION_BUCKETS } from '../src/features/genai-otel.js';
import { validateConfig } from '../src/config/loader.js';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';

const cfg = GenaiTelemetrySchema.parse({ systems: { llm: 'openai' } });
const call = (serverId: string, tool: string, args: Record<string, unknown> = {}) => ({ serverId, tool, args, clientId: 'key:a' });

let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

describe('OpenTelemetry GenAI semantic conventions (6.3)', () => {
  it('reads token usage in OpenAI, Anthropic and _meta shapes', () => {
    expect(extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 3 } })).toEqual({ input: 10, output: 3 });
    expect(extractUsage({ _meta: { usage: { input_tokens: 5, output_tokens: 7 } } })).toEqual({ input: 5, output: 7 });
    expect(extractUsage({ structuredContent: { usage: { inputTokens: 1 } } })).toEqual({ input: 1, output: undefined });
    expect(extractUsage({ usage: { foo: 1 } })).toBeUndefined();
    expect(extractUsage('x')).toBeUndefined();
  });

  it('builds execute_tool and chat attributes; content only when enabled', () => {
    const t = genaiAttributes(call('fs', 'read'), { success: false, durationMs: 5, error: { code: -32001, message: 'x' } }, cfg, 'id1');
    expect(t).toMatchObject({ 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'read', 'gen_ai.tool.call.id': 'id1', 'gen_ai.tool.type': 'function', 'error.type': '-32001', 'mcp.server.id': 'fs' });
    expect(t['gen_ai.input.messages']).toBeUndefined();
    const c = genaiAttributes(call('llm', 'complete', { model: 'gpt-x', prompt: 'hi' }), { success: true, durationMs: 5, result: { model: 'gpt-x-2026', usage: { prompt_tokens: 12, completion_tokens: 4 } } }, { ...cfg, captureContent: true }, 'id2');
    expect(c).toMatchObject({ 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'openai', 'gen_ai.request.model': 'gpt-x', 'gen_ai.response.model': 'gpt-x-2026', 'gen_ai.usage.input_tokens': 12, 'gen_ai.usage.output_tokens': 4 });
    expect(JSON.parse(String(c['gen_ai.input.messages']))).toEqual({ model: 'gpt-x', prompt: 'hi' });
    const big = genaiAttributes(call('fs', 't', { s: 'x'.repeat(5000) }), { success: true, durationMs: 1, result: 1 }, { ...cfg, captureContent: true }, 'i');
    expect(String(big['gen_ai.input.messages']).length).toBe(4097);
  });

  it('records spans, duration and token histograms, and OTLP payloads', () => {
    const r = new GenaiRecorder(2);
    r.record(call('llm', 'complete', { model: 'm' }), { success: true, durationMs: 300, result: { usage: { input_tokens: 100, output_tokens: 20 } } }, cfg);
    r.record(call('llm', 'complete', { model: 'm' }), { success: true, durationMs: 50, result: { usage: { input_tokens: 3, output_tokens: 1 } } }, cfg);
    const s = r.record(call('fs', 'read'), { success: true, durationMs: 1, result: {} }, cfg);
    expect(r.spans).toHaveLength(2);
    expect(s.name).toBe('execute_tool read');
    expect(r.spans[0]!.name).toBe('chat m');
    const sum = r.summary() as any;
    const chat = sum['gen_ai.client.operation.duration'].find((x: any) => x.attributes['gen_ai.operation.name'] === 'chat');
    expect(chat).toMatchObject({ count: 2, sum: 0.35, min: 0.05, max: 0.3 });
    expect(sum['gen_ai.client.token.usage'].map((x: any) => `${x.attributes['gen_ai.token.type']}:${x.sum}`)).toEqual(['input:103', 'output:21']);
    const otlp = r.otlpMetrics('svc') as any;
    const m = otlp.resourceMetrics[0].scopeMetrics[0].metrics;
    expect(m.map((x: any) => `${x.name}/${x.unit}`)).toEqual(['gen_ai.client.operation.duration/s', 'gen_ai.client.token.usage/{token}']);
    const dp = m[0].histogram.dataPoints.find((d: any) => d.count === '2');
    expect(dp.explicitBounds).toEqual(GENAI_DURATION_BUCKETS);
    expect(dp.bucketCounts.reduce((a: number, b: string) => a + Number(b), 0)).toBe(2);
    expect(m[0].histogram.aggregationTemporality).toBe(2);
    const tr = r.otlpSpans(r.spans, 'svc') as any;
    expect(tr.resourceSpans[0].scopeSpans[0].spans[0].attributes.find((a: any) => a.key === 'gen_ai.usage.input_tokens').value).toEqual({ intValue: '3' });
  });

  it('validates config', () => {
    expect(() => validateConfig({ servers: [], genaiTelemetry: { systems: { llm: 'openai' }, otlpEndpoint: 'http://c:4318' } })).not.toThrow();
    expect(() => validateConfig({ servers: [], genaiTelemetry: { exportIntervalMs: 5 } })).toThrow();
  });

  it('records gateway traffic, serves spans / OTLP and pushes on stop', async () => {
    const got: string[] = [];
    const col = createServer((req, res) => {
      got.push(req.url!);
      req.resume();
      req.on('end', () => res.end('{}'));
    });
    await new Promise<void>((r) => col.listen(0, '127.0.0.1', r));
    const port = (col.address() as { port: number }).port;
    h = await startFeatureGw({ genaiTelemetry: { systems: { fake: 'openai' }, otlpEndpoint: `http://127.0.0.1:${port}` } } as never);
    const r = await fetch(`${h.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json' }, body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: { model: 'demo-1' } }) });
    expect(r.status).toBe(200);
    const sp = await h.admin('genai-otel/spans?limit=1');
    expect(sp.body.spans[0].attributes).toMatchObject({ 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'openai', 'gen_ai.request.model': 'demo-1', 'gen_ai.tool.name': 'echo' });
    const st = await h.admin('genai-otel');
    expect(st.body.enabled).toBe(true);
    expect(st.body.spans).toBeGreaterThan(0);
    expect((await h.admin('genai-otel/otlp')).body.resourceMetrics).toHaveLength(1);
    await h.stop();
    h = undefined;
    expect(got).toEqual(expect.arrayContaining(['/v1/traces', '/v1/metrics']));
    await new Promise<void>((r) => col.close(() => r()));
  });
});
