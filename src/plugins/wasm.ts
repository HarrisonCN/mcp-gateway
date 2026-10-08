/**
 * WASM plugin sandbox (3.3).
 *
 * A plugin entry with `wasm: ./policy.wasm` instead of `module:` runs a WebAssembly module — written in any language
 * that compiles to WASM (Rust, Go/TinyGo, AssemblyScript, C, Zig…) — inside a worker thread. Each isolation key
 * (`isolation: tenant` (default) | `client` | `shared`) gets its own worker and module instance, so tenants never
 * share linear memory or globals, and a plugin that hangs or blows its memory limit only takes its own sandbox down.
 * The module gets no WASI and no host access: its only import is `env.log(ptr, len)`.
 *
 * ABI (all strings UTF-8 JSON in the module's exported `memory`):
 *  - `alloc(len: i32) -> i32` — buffer for the host to write the input into;
 *  - `on_tool_call(ptr: i32, len: i32) -> i64` (optional) — input
 *    `{ server, tool, kind, method, arguments, clientId, tenant, via }`; output `{}` / `{ "arguments": {…} }` /
 *    `{ "deny": "reason" }` / `{ "respond": <result> }`;
 *  - `on_response(ptr: i32, len: i32) -> i64` (optional) — input adds `success`, `result`, `error`; output `{}` or
 *    `{ "result": <replacement> }`.
 *  Return `0` for "no change", else `(ptr << 32) | len` of the output JSON.
 *
 * **Component ABI (7.9, plugin API v5)** — `component:` entries load the core module of a component for the WIT world
 * `mcp-gateway:plugin@5.0.0` (`wit/mcp-gateway-plugin.wit`, e.g. `wit-bindgen` / `cargo component` output before
 * `wasm-tools component new`), called with the canonical ABI: exports `memory`, `cabi_realloc` and
 * `mcp-gateway:plugin/hooks@5.0.0#on-tool-call` / `#on-response` (`(ptr, len) -> retptr`, `option<string>` at
 * `retptr`: discriminant byte, then pointer and length as u32 at +4 / +8), optional `cabi_post_*`. The JSON contract is
 * the v5 outcome (`{ "action": "continue" | "rewrite" | "deny" | "respond" | "replace", … }`).
 *
 * Failures (trap, timeout, memory limit, bad JSON) fail the call closed (`-32006`), like a throwing JS plugin; the
 * sandbox is recreated on the next call.
 *
 * @module plugins/wasm
 */

import { Worker } from 'worker_threads';
import { readFile } from 'fs/promises';
import { isAbsolute, resolve } from 'path';
import type { ProxyResponse, WasmPluginLimits } from '../utils/types.js';
import { logger } from '../utils/logger.js';
import type { GatewayPlugin, PluginCall, ToolCallOutcome } from './index.js';

// The DOM-free TypeScript lib has no WebAssembly typings; only module validation is needed here.
declare const WebAssembly: {
  Module: { new (bytes: Uint8Array): object; exports(m: object): Array<{ name: string; kind: string }> };
};

export type WasmIsolation = 'tenant' | 'client' | 'shared';

export const DEFAULT_WASM_LIMITS: Required<WasmPluginLimits> = { timeoutMs: 100, memoryMb: 16, maxInstances: 64 };

export type WasmAbi = 'core' | 'component';
/** Export names of the v5 component world. */
export const COMPONENT_EXPORTS = { on_tool_call: 'mcp-gateway:plugin/hooks@5.0.0#on-tool-call', on_response: 'mcp-gateway:plugin/hooks@5.0.0#on-response' } as const;

const WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
const COMPONENT = workerData.abi === 'component';
const enc = new TextEncoder(), dec = new TextDecoder();
let inst;
const log = (p, l) => { try { parentPort.postMessage({ log: dec.decode(new Uint8Array(inst.exports.memory.buffer, p, l)) }); } catch {} };
const HOST = 'mcp-gateway:plugin/host@5.0.0';
const imports = { env: { log }, [HOST]: { log } };
try {
  const mod = new WebAssembly.Module(workerData.bytes);
  const wanted = WebAssembly.Module.imports(mod).filter((i) => !(i.name === 'log' && (COMPONENT ? i.module === HOST : i.module === 'env')));
  if (wanted.length) throw new Error('unsupported imports: ' + wanted.map((i) => i.module + '.' + i.name).join(', ') + ' (only ' + (COMPONENT ? HOST : 'env') + '.log is provided)');
  inst = new WebAssembly.Instance(mod, imports);
  for (const k of COMPONENT ? ['memory', 'cabi_realloc'] : ['memory', 'alloc']) if (!inst.exports[k]) throw new Error('module must export "' + k + '"');
  parentPort.postMessage({ ready: true, exports: Object.keys(inst.exports), mem: inst.exports.memory.buffer.byteLength });
} catch (e) {
  parentPort.postMessage({ ready: false, error: String((e && e.message) || e) });
}
parentPort.on('message', ({ id, fn, input }) => {
  try {
    const f = inst.exports[fn];
    if (typeof f !== 'function') return parentPort.postMessage({ id, out: null, mem: inst.exports.memory.buffer.byteLength });
    const bytes = enc.encode(input);
    if (COMPONENT) {
      const ptr = inst.exports.cabi_realloc(0, 0, 1, bytes.length);
      new Uint8Array(inst.exports.memory.buffer, ptr, bytes.length).set(bytes);
      const ret = f(ptr, bytes.length) >>> 0;
      const dv = new DataView(inst.exports.memory.buffer);
      let out = null;
      const disc = dv.getUint8(ret);
      if (disc === 1) out = dec.decode(new Uint8Array(inst.exports.memory.buffer, dv.getUint32(ret + 4, true), dv.getUint32(ret + 8, true)));
      else if (disc !== 0) throw new Error('bad option<string> discriminant ' + disc);
      const post = inst.exports['cabi_post_' + fn];
      if (typeof post === 'function') post(ret);
      return parentPort.postMessage({ id, out, mem: inst.exports.memory.buffer.byteLength });
    }
    const ptr = inst.exports.alloc(bytes.length);
    new Uint8Array(inst.exports.memory.buffer, ptr, bytes.length).set(bytes);
    const r = BigInt.asUintN(64, BigInt(f(ptr, bytes.length)));
    const mem = inst.exports.memory.buffer.byteLength;
    if (r === 0n) return parentPort.postMessage({ id, out: null, mem });
    const p = Number(r >> 32n), l = Number(r & 0xffffffffn);
    parentPort.postMessage({ id, out: dec.decode(new Uint8Array(inst.exports.memory.buffer, p, l)), mem });
  } catch (e) {
    parentPort.postMessage({ id, error: String((e && e.message) || e) });
  }
});
`;

interface Pending {
  resolve: (out: string | null) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** One worker + module instance. */
export class WasmSandbox {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private seq = 0;
  private dead?: Error;
  readonly ready: Promise<string[]>;
  calls = 0;
  lastUsed = Date.now();

  constructor(
    bytes: Uint8Array,
    private readonly limits: Required<WasmPluginLimits>,
    private readonly label: string,
    abi: WasmAbi = 'core',
  ) {
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { bytes, abi },
      resourceLimits: { maxOldGenerationSizeMb: Math.max(8, limits.memoryMb), maxYoungGenerationSizeMb: 4, stackSizeMb: 2 },
    });
    this.worker.unref();
    let ready!: (v: string[]) => void;
    let fail!: (e: Error) => void;
    this.ready = new Promise<string[]>((res, rej) => ((ready = res), (fail = rej)));
    this.ready.catch(() => {});
    this.worker.on('message', (m: { ready?: boolean; exports?: string[]; error?: string; id?: number; out?: string | null; mem?: number; log?: string }) => {
      if (m.log !== undefined) return void logger.info(`[wasm ${this.label}] ${m.log}`);
      if (m.ready !== undefined) {
        if (m.ready) ready(m.exports ?? []);
        else this.kill(new Error(`WASM plugin ${this.label}: ${m.error}`), fail);
        return;
      }
      const p = this.pending.get(m.id!);
      if (!p) return;
      this.pending.delete(m.id!);
      clearTimeout(p.timer);
      if (m.error !== undefined) return p.reject(new Error(`WASM plugin ${this.label} trapped: ${m.error}`));
      if (m.mem !== undefined && m.mem > this.limits.memoryMb * 1024 * 1024) {
        p.reject(new Error(`WASM plugin ${this.label} exceeded its memory limit (${this.limits.memoryMb} MB)`));
        return this.kill(new Error('memory limit exceeded'));
      }
      p.resolve(m.out ?? null);
    });
    this.worker.on('error', (err) => this.kill(err, fail));
    this.worker.on('exit', () => this.kill(new Error('sandbox exited'), fail));
  }

  get alive(): boolean {
    return !this.dead;
  }

  async call(fn: string, input: string): Promise<string | null> {
    await this.ready;
    if (this.dead) throw this.dead;
    this.calls++;
    this.lastUsed = Date.now();
    return new Promise<string | null>((resolvePromise, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`WASM plugin ${this.label} timed out after ${this.limits.timeoutMs}ms`));
        this.kill(new Error('timed out'));
      }, this.limits.timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.worker.postMessage({ id, fn, input });
    });
  }

  private kill(err: Error, onReadyFail?: (e: Error) => void): void {
    if (this.dead) return;
    this.dead = err;
    onReadyFail?.(err);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    void this.worker.terminate().catch(() => {});
  }

  close(): Promise<void> {
    this.kill(new Error('closed'));
    return Promise.resolve();
  }
}

export interface WasmPluginOptions {
  name: string;
  bytes: Uint8Array;
  isolation?: WasmIsolation;
  limits?: WasmPluginLimits;
  /** `core` (3.3 ABI, default) or `component` (7.9, plugin API v5). */
  abi?: WasmAbi;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A plugin backed by a WASM module, one sandbox per isolation key. */
export class WasmPlugin implements GatewayPlugin {
  readonly name: string;
  readonly apiVersion: number;
  readonly abi: WasmAbi;
  private readonly sandboxes = new Map<string, WasmSandbox>();
  private readonly limits: Required<WasmPluginLimits>;
  readonly isolation: WasmIsolation;
  private readonly bytes: Uint8Array;
  private readonly module: object;

  constructor(opts: WasmPluginOptions) {
    this.name = opts.name;
    this.bytes = opts.bytes;
    this.isolation = opts.isolation ?? 'tenant';
    this.limits = { ...DEFAULT_WASM_LIMITS, ...Object.fromEntries(Object.entries(opts.limits ?? {}).filter(([, v]) => v !== undefined)) };
    // Validate up front (fails config load instead of the first call).
    this.abi = opts.abi ?? 'core';
    this.apiVersion = this.abi === 'component' ? 5 : 3;
    if (this.bytes.length >= 8 && this.bytes[4] === 0x0d && this.bytes[6] === 0x01) {
      throw new Error(`WASM plugin "${this.name}" is a component binary; load its core module (wit-bindgen output before \`wasm-tools component new\`, or \`wasm-tools component unbundle\`) with \`component:\``);
    }
    this.module = new WebAssembly.Module(this.bytes);
    const exports = WebAssembly.Module.exports(this.module).map((e) => e.name);
    const required = this.abi === 'component' ? ['memory', 'cabi_realloc'] : ['memory', 'alloc'];
    for (const k of required) if (!exports.includes(k)) throw new Error(`WASM plugin "${this.name}" must export "${k}"`);
    if (!exports.includes(this.fnName('on_tool_call')) && !exports.includes(this.fnName('on_response'))) {
      throw new Error(`WASM plugin "${this.name}" exports neither ${this.fnName('on_tool_call')} nor ${this.fnName('on_response')}`);
    }
    this.exported = new Set(exports);
  }

  private readonly exported: Set<string>;

  private fnName(hook: 'on_tool_call' | 'on_response'): string {
    return this.abi === 'component' ? COMPONENT_EXPORTS[hook] : hook;
  }

  /** Sandbox key of a call. */
  keyOf(call: PluginCall): string {
    if (this.isolation === 'shared') return 'shared';
    if (this.isolation === 'client') return `client:${call.clientId ?? 'anonymous'}`;
    return `tenant:${call.tenant ?? '-'}`;
  }

  private sandbox(key: string): WasmSandbox {
    let sb = this.sandboxes.get(key);
    if (sb && !sb.alive) {
      this.sandboxes.delete(key);
      sb = undefined;
    }
    if (!sb) {
      while (this.sandboxes.size >= this.limits.maxInstances) {
        const lru = [...this.sandboxes.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]!;
        void lru[1].close();
        this.sandboxes.delete(lru[0]);
      }
      sb = new WasmSandbox(this.bytes, this.limits, `${this.name}/${key}`, this.abi);
      this.sandboxes.set(key, sb);
    }
    return sb;
  }

  private async run(fn: string, call: PluginCall, extra: Record<string, unknown> = {}): Promise<Record<string, unknown> | undefined> {
    const input = JSON.stringify({
      server: call.serverId,
      tool: call.name,
      kind: call.kind,
      method: call.method,
      arguments: call.arguments,
      clientId: call.clientId,
      tenant: call.tenant,
      via: call.via,
      ...extra,
    });
    const out = await this.sandbox(this.keyOf(call)).call(this.fnName(fn as 'on_tool_call' | 'on_response'), input);
    if (out === null || out.trim() === '') return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(out);
    } catch {
      throw new Error(`WASM plugin ${this.name}: ${fn} returned invalid JSON`);
    }
    if (!isObj(parsed)) throw new Error(`WASM plugin ${this.name}: ${fn} must return a JSON object`);
    return parsed;
  }

  async onToolCall(call: PluginCall): Promise<ToolCallOutcome> {
    const raw = await this.run('on_tool_call', call);
    if (!raw) return undefined;
    if ('action' in raw) {
      const { normalizeToolCallOutcome } = await import('./index.js');
      return normalizeToolCallOutcome(raw);
    }
    const r = raw;
    if (typeof r.deny === 'string') return { deny: r.deny };
    if ('respond' in r) return { respond: r.respond };
    if (isObj(r.arguments)) return { arguments: r.arguments };
    return undefined;
  }

  async onResponse(call: PluginCall, result: ProxyResponse): Promise<ProxyResponse | void> {
    const r = await this.run('on_response', call, { success: result.success, result: result.result, error: result.error });
    if (r && 'action' in r) {
      if (r.action === 'replace' && result.success) return { ...result, result: r.result };
      if (r.action === 'continue') return undefined;
      throw new Error(`WASM plugin ${this.name}: unknown outcome action ${JSON.stringify(r.action)}`);
    }
    if (r && 'result' in r && result.success) return { ...result, result: r.result };
    return undefined;
  }

  /** Live sandboxes (for stats / tests). */
  stats(): Array<{ key: string; calls: number; alive: boolean }> {
    return [...this.sandboxes.entries()].map(([key, s]) => ({ key, calls: s.calls, alive: s.alive }));
  }

  async close(): Promise<void> {
    await Promise.all([...this.sandboxes.values()].map((s) => s.close()));
    this.sandboxes.clear();
  }
}

/** Load a `wasm:` plugin entry (path relative to `baseDir`). */
export async function loadWasmPlugin(
  cfg: { wasm: string; name?: string; isolation?: WasmIsolation; limits?: WasmPluginLimits; abi?: WasmAbi },
  baseDir = process.cwd(),
): Promise<WasmPlugin> {
  const path = isAbsolute(cfg.wasm) ? cfg.wasm : resolve(baseDir, cfg.wasm);
  const bytes = new Uint8Array(await readFile(path));
  return new WasmPlugin({ name: cfg.name ?? cfg.wasm.replace(/^.*[\\/]/, '').replace(/\.wasm$/, ''), bytes, isolation: cfg.isolation, limits: cfg.limits, abi: cfg.abi });
}
