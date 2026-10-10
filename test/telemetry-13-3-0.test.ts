/**
 * 13.3.0 reliability telemetry: final route, effective principal (never raw on spans by default, never a metric
 * label), denials by reason, module failures, reload generations, failovers / resends / recycles, store breaker —
 * as Prometheus text and as OTLP/HTTP JSON.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import { Gateway } from '../src/gateway/index.js';
import { validateConfig } from '../src/config/loader.js';
import { Telemetry, Counter, principalAttr, setCurrentTelemetry } from '../src/observability/telemetry.js';
import { principalType } from '../src/gateway/invoker.js';
import { logger } from '../src/utils/logger.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain ESM helpers shared with bench/load.mjs
import { startHttpUpstream, STDIO_SERVER } from '../bench/lib/upstreams.mjs';

/* eslint-disable @typescript-eslint/no-explicit-any */
logger.setLevel('error');
const KEY = 'k'.repeat(40);
const HASH_KEY = 'telemetry-test-hash-key-0123456789';
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await Promise.resolve(cleanups.pop()!()).catch(() => undefined);
  setCurrentTelemetry(undefined);
});

interface Captured {
  name: string;
  attrs: Record<string, unknown>;
}

async function gateway(extra: Record<string, unknown>, servers: unknown[]) {
  const cfg = validateConfig({ version: 11, servers, monitor: { requestLog: false, prometheus: true }, ...extra } as any);
  const full: any = { ...cfg, port: 0, host: '127.0.0.1', logLevel: 'error', auth: { strategy: 'api-key', apiKeys: [{ name: 'alice@example.com', key: KEY }] } };
  const gw: any = new Gateway(full);
  await gw.start();
  cleanups.push(() => gw.stop());
  // capture spans
  const spans: Captured[] = [];
  gw.tracer = {
    enabled: true,
    startSpan(name: string, o?: { attributes?: Record<string, unknown> }) {
      const s: Captured = { name, attrs: { ...(o?.attributes ?? {}) } };
      spans.push(s);
      return { context: { traceId: '1'.repeat(32), spanId: '2'.repeat(16), sampled: true }, setAttribute: (k: string, v: unknown) => (s.attrs[k] = v), setError() {}, end() {}, traceparent: () => '' };
    },
    flush: async () => undefined,
    shutdown: async () => undefined,
  };
  const base = `http://127.0.0.1:${gw.address()!.port}`;
  const call = async (server: string, tool = 'echo') => {
    const r = await fetch(`${base}/api/v1/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify({ server, tool, arguments: {} }) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const metrics = async () => (await fetch(`${base}/metrics`)).text();
  return { gw, base, call, metrics, spans, full };
}

const hmac = (id: string) => createHmac('sha256', HASH_KEY).update(id).digest('hex').slice(0, 16);

describe('13.3.0 telemetry — spans', () => {
  it('final route + effective principal as a keyed hash (default), never the raw subject', async () => {
    const A = await startHttpUpstream({ tag: 'A' });
    const B = await startHttpUpstream({ tag: 'B' });
    cleanups.push(() => A.close(), () => B.close());
    const { call, spans } = await gateway({ observability: { principal: { hashKey: HASH_KEY } } }, [
      { id: 'r', name: 'r', transport: 'streamable-http', url: A.url, timeoutMs: 2000, replicas: [{ url: B.url }] },
    ]);
    expect((await call('r')).status).toBe(200);
    expect((await call('r')).status).toBe(200);
    const s = spans.filter((x) => x.name.includes('tools/call'));
    expect(s.length).toBe(2);
    const upstreams = s.map((x) => x.attrs['mcp.route.final.upstream']).sort();
    expect(upstreams).toEqual(['r', 'r~1']);
    expect(s[0]!.attrs['mcp.route.final.server']).toBe('r');
    expect(s[0]!.attrs['mcp.principal.type']).toBe('direct');
    expect(s[0]!.attrs['mcp.principal.subject']).toBe(hmac('key:alice@example.com'));
    expect(s[0]!.attrs['mcp.client.id']).toBe(hmac('key:alice@example.com'));
    expect(JSON.stringify(spans)).not.toContain('alice@example.com');
  });

  it('observability.principal.mode plain / omit', async () => {
    const plain = await gateway({ observability: { principal: { mode: 'plain' } } }, [{ id: 's', name: 's', transport: 'stdio', command: process.execPath, args: [STDIO_SERVER] }]);
    await plain.call('s');
    expect(plain.spans.find((x) => x.name.includes('tools/call'))!.attrs['mcp.principal.subject']).toBe('key:alice@example.com');
    await plain.gw.stop();
    const omit = await gateway({ observability: { principal: { mode: 'omit' } } }, [{ id: 's', name: 's', transport: 'stdio', command: process.execPath, args: [STDIO_SERVER] }]);
    await omit.call('s');
    const sp = omit.spans.find((x) => x.name.includes('tools/call'))!;
    expect(sp.attrs['mcp.principal.subject']).toBeUndefined();
    expect(sp.attrs['mcp.client.id']).toBeUndefined();
    expect(sp.attrs['mcp.principal.type']).toBe('direct');
  });

  it('denied calls carry the deny reason', async () => {
    const { call, spans } = await gateway({ policy: { rules: [{ name: 'no-echo', tools: ['echo'], effect: 'deny' }] } }, [{ id: 's', name: 's', transport: 'stdio', command: process.execPath, args: [STDIO_SERVER] }]);
    expect((await call('s')).status).toBe(403);
    expect(spans.find((x) => x.name.includes('tools/call'))!.attrs['mcp.policy.deny_reason']).toBe('deny');
  });
});

describe('13.3.0 telemetry — metrics', () => {
  it('route, principal type, denials by reason, generation + reloads, store / module gauges on /metrics — no principal in labels', async () => {
    const servers = [{ id: 's', name: 's', transport: 'stdio', command: process.execPath, args: [STDIO_SERVER] }];
    const { gw, call, metrics, full } = await gateway({}, servers);
    expect((await call('s')).status).toBe(200);
    let m = await metrics();
    expect(m).toContain('mcp_gateway_route_final_total{server="s",upstream="s"} 1');
    expect(m).toContain('mcp_gateway_calls_by_principal_total{principal_type="direct"} 1');
    expect(m).toContain('mcp_gateway_config_generation 1');
    expect(m).toMatch(/# TYPE mcp_gateway_upstream_resends_total counter/);
    expect(m).toMatch(/# TYPE mcp_gateway_upstream_recycles_total counter/);
    expect(m).not.toContain('alice');
    // a policy deny after a hot reload
    await gw.reload({ ...full, policy: { rules: [{ name: 'no', tools: ['echo'], effect: 'deny' }] } });
    expect((await call('s')).status).toBe(403);
    m = await metrics();
    expect(m).toContain('mcp_gateway_config_generation 2');
    expect(m).toContain('mcp_gateway_reloads_total{result="committed"} 1');
    expect(m).toContain('mcp_gateway_policy_denials_by_reason_total{reason="deny"} 1');
    // module failure registry feeds the counter
    gw.moduleFailures.mark('dlp', 'boom');
    m = await metrics();
    expect(m).toContain('mcp_gateway_module_failures_total{module="dlp"} 1');
    expect(m).not.toContain('alice');
  });

  it('state store gauge follows the breaker', async () => {
    const { metrics, gw } = await gateway({ store: { backend: 'redis', redis: { url: 'redis://127.0.0.1:1', connectTimeoutMs: 100, commandTimeoutMs: 100 } } }, []);
    await gw.stateStore.get('x').catch(() => undefined);
    const m = await metrics();
    expect(m).toContain('mcp_gateway_state_store_up{backend="redis"} 0');
    expect(m).toMatch(/mcp_gateway_state_store_failures_total\{backend="redis"\} [1-9]/);
  });

  it('OTLP/HTTP JSON export: cumulative sums + gauges with resource attributes', async () => {
    const t = new Telemetry();
    t.route('s', 's~1');
    t.deny('scope');
    t.gauge({ name: 'mcp_gateway_config_generation', help: 'g', read: () => [{ labels: {}, value: 3 }] });
    const bodies: any[] = [];
    t.startExport({ endpoint: 'http://collector:4318/v1/metrics', intervalMs: 1000, headers: { 'x-k': 'v' } }, { 'service.name': 'mcp-gateway' }, async (url, body, headers) => {
      bodies.push({ url, body: JSON.parse(body), headers });
    });
    cleanups.push(() => t.stop());
    await new Promise((r) => setTimeout(r, 1100));
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    const b = bodies[0];
    expect(b.url).toBe('http://collector:4318/v1/metrics');
    expect(b.headers['x-k']).toBe('v');
    const rm = b.body.resourceMetrics[0];
    expect(rm.resource.attributes).toContainEqual({ key: 'service.name', value: { stringValue: 'mcp-gateway' } });
    const metrics = rm.scopeMetrics[0].metrics;
    const route = metrics.find((x: any) => x.name === 'mcp.gateway.route.final');
    expect(route.sum.isMonotonic).toBe(true);
    expect(route.sum.dataPoints[0].asInt).toBe('1');
    expect(route.sum.dataPoints[0].attributes).toContainEqual({ key: 'upstream', value: { stringValue: 's~1' } });
    expect(metrics.find((x: any) => x.name === 'mcp.gateway.config.generation').gauge.dataPoints[0].asDouble).toBe(3);
    t.stop();
    t.startExport(undefined, {});
  });

  it('bounded label sets; Counter / principal helpers', () => {
    const t = new Telemetry({ mode: 'hash', hashKey: HASH_KEY });
    for (let i = 0; i < 1100; i++) t.deny(`r${i}`);
    expect(t.denials.series().length).toBe(1000);
    t.deny('r1');
    expect(t.denials.get({ reason: 'r1' })).toBe(2);
    const c = new Counter('x_total', 'x');
    Telemetry.set(c, { a: 'b' }, 5);
    Telemetry.set(c, { a: 'b' }, 7);
    expect(c.get({ a: 'b' })).toBe(7);
    expect(t.principalAttribute(undefined)).toBeUndefined();
    expect(t.principalAttribute('u')).toBe(hmac('u'));
    expect(t.principalMode).toBe('hash');
    setCurrentTelemetry(t);
    expect(principalAttr('u')).toBe(hmac('u'));
    setCurrentTelemetry(undefined);
    expect(principalAttr('u')).toMatch(/^[0-9a-f]{16}$/);
    expect(principalType({ subject: 'a', actors: ['agent:x'] } as any)).toBe('delegated');
    expect(principalType({ subject: 'anonymous', actors: [] } as any)).toBe('anonymous');
    t.onCollect(() => {
      throw new Error('broken collector');
    });
    expect(t.prometheus().join('\n')).toContain('mcp_gateway_policy_denials_by_reason_total');
  });
});
