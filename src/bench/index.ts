/**
 * Built-in benchmark (3.9): `mcp-gateway bench`.
 *
 * Starts an in-process gateway on 127.0.0.1 with a minimal stdio echo MCP server (written to a temp file, run with the
 * current Node binary) and drives it with N concurrent keep-alive clients for a fixed time per scenario:
 *
 *  - `rest`: `POST /api/v1/tools/call` (auth off) — the full pipeline (scopes, policy, quotas, audit in memory);
 *  - `rest-auth`: the same with an API key and a rate-limit-free key;
 *  - `cache`: a cached tool (`cache.rules`) — the gateway's own overhead without the upstream round trip;
 *  - `mcp`: JSON-RPC `tools/call` on the streamable-HTTP `/mcp` endpoint (one session per client).
 *
 * Reports requests/s, mean and p50 / p95 / p99 latency, and errors. Numbers depend on the machine; compare runs on
 * the same host.
 *
 * @module bench
 */

import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Gateway } from '../gateway/index.js';
import type { GatewayConfig } from '../utils/types.js';

export type BenchScenario = 'rest' | 'rest-auth' | 'cache' | 'mcp';
export const BENCH_SCENARIOS: BenchScenario[] = ['rest', 'rest-auth', 'cache', 'mcp'];

export interface BenchOptions {
  durationMs?: number;
  concurrency?: number;
  scenarios?: BenchScenario[];
  /** Warm-up per scenario (not measured). */
  warmupMs?: number;
}

export interface BenchResult {
  scenario: BenchScenario;
  requests: number;
  errors: number;
  rps: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface BenchReport {
  node: string;
  platform: string;
  cpus: number;
  concurrency: number;
  durationMs: number;
  results: BenchResult[];
}

const ECHO_SERVER = `
const rl = require('readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'bench-echo', version: '1' } } });
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }, { name: 'cached', description: 'Cached echo', inputSchema: { type: 'object' } }] } });
  if (msg.method === 'tools/call') return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(msg.params.arguments || {}) }] } });
  if (msg.method === 'ping') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.id !== undefined && msg.method) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown' } });
});
`;

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i]!;
}

export function summarize(scenario: BenchScenario, latencies: number[], errors: number, elapsedMs: number): BenchResult {
  const s = [...latencies].sort((a, b) => a - b);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    scenario,
    requests: s.length,
    errors,
    rps: Math.round((s.length / Math.max(1, elapsedMs)) * 1000),
    meanMs: r2(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)),
    p50Ms: r2(percentile(s, 0.5)),
    p95Ms: r2(percentile(s, 0.95)),
    p99Ms: r2(percentile(s, 0.99)),
    maxMs: r2(s[s.length - 1] ?? 0),
  };
}

async function drive(durationMs: number, concurrency: number, once: (worker: number) => Promise<boolean>): Promise<{ latencies: number[]; errors: number; elapsed: number }> {
  const latencies: number[] = [];
  let errors = 0;
  const t0 = performance.now();
  const end = t0 + durationMs;
  await Promise.all(
    Array.from({ length: concurrency }, async (_, w) => {
      while (performance.now() < end) {
        const s = performance.now();
        let ok = false;
        try {
          ok = await once(w);
        } catch {
          ok = false;
        }
        if (ok) latencies.push(performance.now() - s);
        else errors++;
      }
    }),
  );
  return { latencies, errors, elapsed: performance.now() - t0 };
}

export async function runBenchmark(opts: BenchOptions = {}): Promise<BenchReport> {
  const durationMs = opts.durationMs ?? 10_000;
  const concurrency = opts.concurrency ?? 32;
  const warmupMs = opts.warmupMs ?? Math.min(1000, durationMs / 5);
  const scenarios = opts.scenarios ?? BENCH_SCENARIOS;
  const dir = mkdtempSync(join(tmpdir(), 'mgw-bench-'));
  const script = join(dir, 'echo.cjs');
  writeFileSync(script, ECHO_SERVER);
  const KEY = 'bench-key-0123456789abcdef';
  const config: GatewayConfig = {
    port: 0,
    host: '127.0.0.1',
    logLevel: 'error',
    monitor: { requestLog: false },
    servers: [{ id: 'echo', name: 'echo', transport: 'stdio', command: process.execPath, args: [script], maxConcurrency: Math.max(64, concurrency * 2) }],
    cache: { enabled: true, rules: [{ tools: ['cached'], ttlSeconds: 3600, scope: 'shared' }] },
  } as GatewayConfig;
  const results: BenchResult[] = [];
  const gw = new Gateway(config);
  const gwAuth = new Gateway({ ...config, auth: { strategy: 'api-key', apiKeys: [{ name: 'bench', key: KEY }] } } as GatewayConfig);
  try {
    await gw.start();
    if (scenarios.includes('rest-auth')) await gwAuth.start();
    const base = `http://127.0.0.1:${gw.address()!.port}`;
    const baseAuth = scenarios.includes('rest-auth') ? `http://127.0.0.1:${gwAuth.address()!.port}` : '';
    const call = (url: string, tool: string, headers: Record<string, string> = {}) => async () => {
      const r = await fetch(`${url}/api/v1/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ server: 'echo', tool, arguments: { n: 1 } }) });
      await r.arrayBuffer();
      return r.ok;
    };
    for (const sc of scenarios) {
      let once: (w: number) => Promise<boolean>;
      if (sc === 'rest') once = call(base, 'echo');
      else if (sc === 'rest-auth') once = call(baseAuth, 'echo', { authorization: `Bearer ${KEY}` });
      else if (sc === 'cache') once = call(base, 'cached');
      else {
        // One MCP session per worker.
        const sessions: string[] = [];
        for (let w = 0; w < concurrency; w++) {
          const r = await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bench', version: '1' } } }),
          });
          await r.arrayBuffer();
          const sid = r.headers.get('mcp-session-id') ?? '';
          sessions.push(sid);
          await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }).then((x) => x.arrayBuffer());
        }
        let id = 1;
        once = async (w) => {
          const sid = sessions[w]!;
          const r = await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) },
            body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name: 'echo', arguments: { n: 1 } } }),
          });
          const text = await r.text();
          return r.ok && text.includes('"result"');
        };
      }
      await drive(warmupMs, concurrency, once);
      const { latencies, errors, elapsed } = await drive(durationMs, concurrency, once);
      results.push(summarize(sc, latencies, errors, elapsed));
    }
  } finally {
    await gw.stop().catch(() => undefined);
    await gwAuth.stop().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
  const os = await import('os');
  return { node: process.version, platform: `${process.platform}-${process.arch}`, cpus: os.cpus().length, concurrency, durationMs, results };
}

/** Markdown table of a report. */
export function benchMarkdown(r: BenchReport): string {
  const head = `Node ${r.node} · ${r.platform} · ${r.cpus} CPU · concurrency ${r.concurrency} · ${r.durationMs / 1000}s per scenario\n\n`;
  const rows = r.results.map((x) => `| ${x.scenario} | ${x.rps} | ${x.meanMs} | ${x.p50Ms} | ${x.p95Ms} | ${x.p99Ms} | ${x.errors} |`);
  return head + ['| Scenario | req/s | mean ms | p50 ms | p95 ms | p99 ms | errors |', '|---|---:|---:|---:|---:|---:|---:|', ...rows].join('\n') + '\n';
}
