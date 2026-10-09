/**
 * Edge WASM runtime 2.0 (9.2): run lightweight **tools** (not only plugins) as WebAssembly on any gateway — typically
 * edge nodes of the edge fleet — with a warm instance pool, compiled-module cache, per-tool quotas and SHA-256 pins.
 *
 * ```yaml
 * edgeRuntime:
 *   tools:
 *     - name: geo-lookup
 *       wasm: ./tools/geo.wasm
 *       sha256: 9f2c…            # optional pin; a mismatch refuses to load the tool
 *       export: run              # (ptr, len) -> i64 — same core ABI as WASM plugins (`memory`, `alloc`)
 *       description: Country for an IP
 *       limits: { timeoutMs: 50, memoryMb: 8, maxConcurrent: 4 }
 *       warm: 2                  # instances kept started (no cold start on the hot path)
 *   idleSeconds: 300             # extra instances above `warm` are stopped after this
 * ```
 *
 * A call passes the JSON arguments to the export; the export returns `(ptr << 32) | len` of a JSON result (an MCP
 * tool result like `{ "content": [...] }`, or any JSON value, wrapped as text). Traps, timeouts, the memory limit and
 * a full concurrency quota fail the call with JSON-RPC **-32023** (`ERR_EDGE_RUNTIME`); a crashed instance is replaced.
 *
 * - `GET  /admin/edge-runtime` — tools, pin status, pool (warm / busy / started), calls, errors, cold starts and p50 / max latency.
 * - `POST /admin/edge-runtime/reload` — re-read and re-pin every module (drops the pool).
 * - `GET  /api/v1/features/edge-runtime/tools` · `POST /api/v1/features/edge-runtime/tools/:name/call` `{ arguments }`.
 *
 * @module features/edge-runtime
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { registerFeature, objectBody } from '../gateway/features.js';
import { WasmSandbox } from '../plugins/wasm.js';
import { logger } from '../utils/logger.js';
import type { GatewayConfig } from '../utils/types.js';

/** JSON-RPC error of an edge WASM tool failure or quota (9.2). */
export const ERR_EDGE_RUNTIME = -32023;

const Tool = z
  .object({
    name: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/),
    wasm: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    export: z.string().min(1).default('run'),
    description: z.string().default(''),
    inputSchema: z.record(z.unknown()).default({ type: 'object' }),
    limits: z
      .object({ timeoutMs: z.number().int().min(1).max(60_000).default(100), memoryMb: z.number().int().min(1).max(1024).default(16), maxConcurrent: z.number().int().min(1).max(256).default(4) })
      .strict()
      .default({}),
    warm: z.number().int().min(0).max(64).default(1),
  })
  .strict()
  .refine((t) => t.warm <= t.limits.maxConcurrent, { message: 'warm must not exceed limits.maxConcurrent', path: ['warm'] });

export const EdgeRuntimeSchema = z
  .object({ enabled: z.boolean().default(true), idleSeconds: z.number().int().min(1).default(300), tools: z.array(Tool).default([]) })
  .strict()
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.tools.forEach((t, i) => {
      if (seen.has(t.name)) ctx.addIssue({ code: 'custom', path: ['tools', i, 'name'], message: `duplicate edge tool "${t.name}"` });
      seen.add(t.name);
    });
  });
export type EdgeRuntimeConfig = z.input<typeof EdgeRuntimeSchema>;
type T = z.output<typeof Tool>;

interface Pool {
  key: string;
  bytes?: Uint8Array;
  sha256?: string;
  error?: string;
  idle: WasmSandbox[];
  busy: number;
  started: number;
  calls: number;
  errors: number;
  coldStarts: number;
  latencies: number[];
}

/** Runtime state; exported for tests. */
export const edgeRuntimeState = {
  pools: new Map<string, Pool>(),
  baseDir: process.cwd(),
  async reset() {
    for (const p of this.pools.values()) for (const s of p.idle) await s.close();
    this.pools.clear();
  },
};

const settings = (cfg: GatewayConfig) => {
  if (!cfg.edgeRuntime) return undefined;
  const c = EdgeRuntimeSchema.parse(cfg.edgeRuntime);
  return c.enabled ? c : undefined;
};
const keyOf = (t: T) => JSON.stringify([t.wasm, t.sha256, t.export, t.limits]);

async function pool(t: T): Promise<Pool> {
  let p = edgeRuntimeState.pools.get(t.name);
  if (p && p.key !== keyOf(t)) {
    for (const s of p.idle) await s.close();
    p = undefined;
  }
  if (!p) {
    p = { key: keyOf(t), idle: [], busy: 0, started: 0, calls: 0, errors: 0, coldStarts: 0, latencies: [] };
    edgeRuntimeState.pools.set(t.name, p);
    try {
      const bytes = new Uint8Array(await readFile(isAbsolute(t.wasm) ? t.wasm : resolve(edgeRuntimeState.baseDir, t.wasm)));
      const sha = createHash('sha256').update(bytes).digest('hex');
      p.sha256 = sha;
      if (t.sha256 && t.sha256 !== sha) throw new Error(`sha256 mismatch (pinned ${t.sha256.slice(0, 12)}…, file ${sha.slice(0, 12)}…)`);
      p.bytes = bytes;
    } catch (e) {
      p.error = (e as Error).message;
      logger.error(`edge runtime: tool "${t.name}" not loaded: ${p.error}`);
    }
  }
  return p;
}

const sandbox = (t: T, p: Pool) => {
  p.started++;
  return new WasmSandbox(p.bytes!, { timeoutMs: t.limits.timeoutMs, memoryMb: t.limits.memoryMb, maxInstances: t.limits.maxConcurrent }, `edge tool ${t.name}`);
};

/** Start instances until `warm` are idle (exported for tests). */
export async function warmUp(t: T): Promise<void> {
  const p = await pool(t);
  if (!p.bytes) return;
  while (p.idle.length < t.warm && p.idle.length + p.busy < t.limits.maxConcurrent) {
    const s = sandbox(t, p);
    try {
      await s.ready;
      p.idle.push(s);
    } catch (e) {
      p.error = (e as Error).message;
      return;
    }
  }
}

export interface EdgeCallResult {
  ok: boolean;
  result?: unknown;
  error?: { code: number; message: string };
  durationMs: number;
  cold: boolean;
}

/** Run an edge tool with JSON arguments. */
export async function callEdgeTool(t: T, args: Record<string, unknown>): Promise<EdgeCallResult> {
  const t0 = Date.now();
  const p = await pool(t);
  const fail = (message: string): EdgeCallResult => {
    p.errors++;
    return { ok: false, error: { code: ERR_EDGE_RUNTIME, message: `edge tool "${t.name}": ${message}` }, durationMs: Date.now() - t0, cold: false };
  };
  if (!p.bytes) return fail(p.error ?? 'not loaded');
  if (p.busy >= t.limits.maxConcurrent) return fail(`concurrency quota reached (${t.limits.maxConcurrent})`);
  p.calls++;
  p.busy++;
  let s = p.idle.pop();
  while (s && !s.alive) s = p.idle.pop();
  const cold = !s;
  if (!s) {
    p.coldStarts++;
    s = sandbox(t, p);
  }
  try {
    const out = await s.call(t.export, JSON.stringify(args ?? {}));
    let result: unknown;
    if (out === null) result = { content: [] };
    else {
      const v = JSON.parse(out) as unknown;
      result = v && typeof v === 'object' && Array.isArray((v as { content?: unknown }).content) ? v : { content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] };
    }
    if (s.alive) p.idle.push(s);
    const ms = Date.now() - t0;
    p.latencies.push(ms);
    if (p.latencies.length > 200) p.latencies.shift();
    return { ok: true, result, durationMs: ms, cold };
  } catch (e) {
    void s.close();
    return fail((e as Error).message.replace(/^WASM plugin edge tool \S+ /, ''));
  } finally {
    p.busy--;
    void warmUp(t).catch(() => {});
  }
}

const pct = (xs: number[], q: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

registerFeature({
  id: 'edge-runtime',
  since: '9.2.0',
  summary: 'Edge WASM runtime 2.0: WebAssembly tools with a warm instance pool, SHA-256 pins and per-tool time / memory / concurrency quotas',
  mount(router, ctx) {
    const tools = () => settings(ctx.config())?.tools ?? [];
    const timer = setInterval(() => {
      const s = settings(ctx.config());
      if (!s) return;
      const cutoff = Date.now() - s.idleSeconds * 1000;
      for (const t of s.tools) {
        const p = edgeRuntimeState.pools.get(t.name);
        if (!p) continue;
        while (p.idle.length > t.warm && p.idle[0].lastUsed < cutoff) void p.idle.shift()!.close();
      }
    }, 10_000);
    timer.unref();
    ctx.onStop?.(() => {
      clearInterval(timer);
      void edgeRuntimeState.reset();
    });
    setImmediate(() => {
      for (const t of tools()) void warmUp(t).catch(() => {});
    });
    router.get('/', async (_req, res) => {
      const out = [];
      for (const t of tools()) {
        const p = await pool(t);
        out.push({
          name: t.name, wasm: t.wasm, export: t.export, sha256: p.sha256 ?? null, pinned: !!t.sha256, loaded: !!p.bytes, error: p.error ?? null,
          limits: t.limits, pool: { warm: t.warm, idle: p.idle.length, busy: p.busy, started: p.started },
          calls: p.calls, errors: p.errors, coldStarts: p.coldStarts, latencyMs: { p50: pct(p.latencies, 0.5), max: p.latencies.length ? Math.max(...p.latencies) : null },
        });
      }
      res.json({ enabled: !!settings(ctx.config()), tools: out });
    });
    router.post('/reload', async (_req, res) => {
      await edgeRuntimeState.reset();
      for (const t of tools()) await warmUp(t);
      res.json({ reloaded: tools().map((t) => ({ name: t.name, loaded: !!edgeRuntimeState.pools.get(t.name)?.bytes, error: edgeRuntimeState.pools.get(t.name)?.error ?? null })) });
    });
  },
  mountClient(router, ctx) {
    const find = (n: string) => settings(ctx.config())?.tools.find((t) => t.name === n);
    router.get('/tools', (_req, res) => {
      res.json({ tools: (settings(ctx.config())?.tools ?? []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    });
    router.post('/tools/:name/call', async (req, res) => {
      const t = find(String(req.params.name));
      if (!t) return void res.status(404).json({ error: 'Not Found', message: `no edge tool "${req.params.name}"` });
      const b = objectBody(req, res);
      if (!b) return;
      const args = b.arguments && typeof b.arguments === 'object' && !Array.isArray(b.arguments) ? (b.arguments as Record<string, unknown>) : {};
      const r = await callEdgeTool(t, args);
      if (!r.ok) return void res.status(r.error!.message.includes('quota') ? 429 : 502).json({ success: false, error: r.error, durationMs: r.durationMs });
      res.json({ success: true, result: r.result, durationMs: r.durationMs, cold: r.cold });
    });
  },
});
