/**
 * 14.3.0 plugin security runtime: JS module plugins in an isolated runtime.
 *
 *  - `runtime: worker`  — a `worker_threads` Worker per plugin (V8 heap cap via `resourceLimits`, own `process.env`);
 *  - `runtime: process` — a child Node.js process per plugin (`--max-old-space-size`, Node permission model for the
 *    file system, no child processes / workers / addons, own environment).
 *
 * The plugin talks to the gateway only through structured-clone messages: hook calls in, outcomes out, `ctx.secrets`
 * reads and log lines proxied back to the parent (which enforces `permissions.secrets`). A crash, `process.exit()`, an
 * uncaught async error, an endless loop (per-call timeout → the runtime is terminated) or a heap blow-up only ends that
 * plugin's runtime; the next call starts a fresh one (with exponential backoff after repeated crashes).
 *
 * Signed plugins are loaded from the bytes whose signature was verified (a `data:` URL built from that buffer), never
 * re-read from disk — see `checkSignature` / MGW-2026-016.
 *
 * @module plugins/runtime
 */

import { Worker } from 'node:worker_threads';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../utils/logger.js';

export type IsolatedRuntime = 'worker' | 'process';

/** `plugins[].permissions` (14.3.0). Absent fields keep the pre-14.3 behaviour unless noted. */
export interface PluginPermissions {
  /** `read`: argument rewrites (returned or in place) are dropped. Default `write`. */
  args?: 'read' | 'write';
  /** `read`: `onResponse` replacements are dropped. Default `write`. */
  response?: 'read' | 'write';
  /** Names (from `plugins[].secrets`) the plugin may resolve. Default: all granted names. */
  secrets?: string[];
  /** Server id globs whose calls the hooks see. Default: all. */
  servers?: string[];
  /** Tool / prompt / resource name globs whose calls the hooks see. Default: all. */
  tools?: string[];
  /** Hooks that may run. Default: all the plugin defines. */
  hooks?: Array<'onToolCall' | 'onResponse' | 'onError' | 'onConfigChange'>;
  /** Isolated runtimes: `false` = no outbound connections; a list = only these hosts (`host`, `host:port`, `*.domain`). Default: unrestricted. */
  network?: false | string[];
  /** Isolated runtimes: environment variables visible to the plugin. Default: none. */
  env?: string[];
  /** Isolated runtimes: file-system access. `process`: enforced by the Node permission model (default: read-only plugin directory); `worker`: best-effort guard (default: unrestricted). */
  fs?: { read?: string[]; write?: string[] };
}

/** `plugins[].limits` for module plugins (14.3.0). */
export interface ModulePluginLimits {
  /** Per hook call (isolated default 5000). A timed-out call terminates the runtime. */
  timeoutMs?: number;
  /** Heap cap of the runtime (default 128). */
  memoryMb?: number;
  /** Consecutive failures that open the circuit breaker (isolated default 5). */
  maxFailures?: number;
  /** How long an open circuit stays open before one trial call (default 30000). */
  cooldownMs?: number;
  /** Hook calls in flight per plugin; more fail as "busy" (default 16). */
  maxConcurrent?: number;
}

export type HookName = 'onToolCall' | 'onResponse' | 'onError' | 'onConfigChange';

/** The runtime ended (crash, exit, out of memory, terminated). */
export class PluginCrash extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginCrash';
  }
}

/** Too many calls in flight (`limits.maxConcurrent`): not counted by the circuit breaker. */
export class PluginBusy extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginBusy';
  }
}

/** A hook call exceeded its time limit. */
export class PluginTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginTimeout';
  }
}

export const RUNTIME = Symbol.for('mcp-gateway.plugin.runtime');

// ─── code running inside the worker / child process ─────────────────────────
// Plain JS (eval'd Worker / `node -e`), so it works the same from the TypeScript sources and the built package.
const BOOTSTRAP = String.raw`
'use strict';
const wt = require('node:worker_threads');
const inWorker = !!wt.parentPort;
const send = (m) => (inWorker ? wt.parentPort.postMessage(m) : process.send(m));
const onMsg = (fn) => (inWorker ? wt.parentPort.on('message', fn) : process.on('message', fn));
if (!inWorker) process.on('disconnect', () => process.exit(0));
let plugin = null, base = null, seq = 0;
const pending = new Map();
const rpc = (op, args) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); send({ type: 'rpc', id, op, ...args }); });
const fmt = (a) => a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' ');
const logger = {};
for (const level of ['debug', 'info', 'warn', 'error']) logger[level] = (...a) => send({ type: 'log', level, msg: fmt(a) });
logger.child = () => logger;
logger.setLevel = () => {};
function createState() {
  const m = new Map();
  const live = (k) => { const e = m.get(k); if (!e) return undefined; if (e.exp !== undefined && e.exp <= Date.now()) { m.delete(k); return undefined; } return e; };
  return {
    get: (k) => live(k)?.v,
    set(k, v, ttl) { m.delete(k); m.set(k, { v, ...(ttl > 0 ? { exp: Date.now() + ttl } : {}) }); while (m.size > 10000) m.delete(m.keys().next().value); },
    has: (k) => live(k) !== undefined,
    delete: (k) => m.delete(k),
    size() { for (const k of [...m.keys()]) live(k); return m.size; },
    clear: () => m.clear(),
  };
}
function glob(p) { return new RegExp('^' + p.replace(/[.+^$()|[\]{}\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i'); }
function guardNetwork(rule) {
  if (rule === undefined || (Array.isArray(rule) && rule.includes('*'))) return;
  const allow = (rule || []).map((r) => { const m = /^(.*?)(?::(\d+))?$/.exec(r); return { host: glob(m[1].replace(/^\[|\]$/g, '')), port: m[2] ? Number(m[2]) : undefined }; });
  const ok = (host, port) => allow.some((a) => a.host.test(String(host)) && (a.port === undefined || a.port === Number(port)));
  const deny = (what) => { const e = new Error('network access to ' + what + ' is not allowed by permissions.network'); e.code = 'EACCES'; throw e; };
  const net = require('node:net');
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    let o = args[0];
    if (Array.isArray(o)) o = o[0];
    if (typeof o === 'number' || (typeof o === 'string' && /^\d+$/.test(o))) o = { port: Number(o), host: typeof args[1] === 'string' ? args[1] : 'localhost' };
    else if (typeof o === 'string') o = { path: o };
    o = o || {};
    if (o.path) deny('socket ' + o.path);
    const host = o.host || 'localhost';
    if (!ok(host, o.port)) deny(host + ':' + o.port);
    return connect.apply(this, args);
  };
  const dgram = require('node:dgram');
  for (const k of ['send', 'connect', 'bind']) { const f = dgram.Socket.prototype[k]; dgram.Socket.prototype[k] = function () { deny('UDP'); return f; }; }
}
function guardFs(rule) {
  if (!rule) return;
  const path = require('node:path');
  const norm = (ps) => (ps || []).map((p) => path.resolve(p));
  const R = norm([...(rule.read || []), ...(rule.write || [])]), W = norm(rule.write || []);
  const inside = (p, list) => { const a = path.resolve(p instanceof URL ? require('node:url').fileURLToPath(p) : String(p)); return list.some((r) => a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep)); };
  const WRITE = /write|append|unlink|rm|mkdir|rename|copy|cp$|symlink|link|chmod|chown|truncate|utimes|mkdtemp/i;
  const check = (name, args) => {
    const pathish = (v) => typeof v === 'string' || Buffer.isBuffer(v) || v instanceof URL;
    const write = WRITE.test(name) || (/^open/.test(name) && typeof args[1] === 'string' && /[wa+]/.test(args[1])) || name === 'createWriteStream';
    for (const [i, v] of args.slice(0, 2).entries()) {
      if (!pathish(v) || (i === 1 && !/rename|copy|cp|symlink|link/i.test(name))) continue;
      const w = write || i === 1;
      if (!inside(v, w ? W : R)) { const e = new Error((w ? 'write' : 'read') + ' access to ' + String(v) + ' is not allowed by permissions.fs'); e.code = 'EACCES'; throw e; }
    }
  };
  const fs = require('node:fs');
  for (const obj of [fs, fs.promises]) for (const name of Object.keys(obj)) {
    const f = obj[name];
    if (typeof f !== 'function' || /^[A-Z]/.test(name) || name === 'promises') continue;
    obj[name] = function (...args) { check(name, args); return f.apply(this, args); };
  }
}
function lockdown(perms) {
  guardNetwork(perms.network);
  guardFs(perms.fs);
  const refuse = (what) => function () { const e = new Error(what + ' is not available to plugins in an isolated runtime'); e.code = 'EACCES'; throw e; };
  const cp = require('node:child_process');
  for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[k] = refuse('child_process.' + k);
  wt.Worker = refuse('worker_threads.Worker');
  process.binding = refuse('process.binding');
  process._linkedBinding = refuse('process._linkedBinding');
  process.dlopen = refuse('process.dlopen');
  require('node:module').syncBuiltinESMExports();
}
const clone = (v) => { try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v ?? null)); } };
async function init(m) {
  lockdown(m.permissions || {});
  let mod;
  try {
    mod = await import(m.url);
  } catch (e) {
    if (m.url.startsWith('data:') && /resolve|relative|Invalid URL|ERR_UNSUPPORTED_RESOLVE_REQUEST|Cannot find (module|package)|bare specifier/i.test(String(e && (e.code || '') + ' ' + e.message)))
      throw new Error('signed plugins must be self-contained bundles — the signature covers one file, so a signed plugin may only import node: built-ins (' + e.message + ')');
    throw e;
  }
  const exported = mod.default ?? mod.plugin ?? mod;
  const ctx = { options: m.options || {}, logger, gatewayVersion: m.gatewayVersion, apiVersion: m.apiVersion };
  const value = typeof exported === 'function' ? await exported(ctx) : exported;
  if (!value || typeof value !== 'object' || typeof value.name !== 'string') throw new Error('Plugin ' + m.label + ' must export a plugin object with a "name" (or a factory returning one)');
  let options = m.options || {};
  const s = value.configSchema;
  if (s) {
    if (typeof s === 'function') { const errs = s(options) || []; if (errs.length) throw new Error('Plugin "' + value.name + '" options are invalid: ' + errs.join('; ')); }
    else if (typeof s.safeParse === 'function') {
      const r = s.safeParse(options);
      if (!r.success) throw new Error('Plugin "' + value.name + '" options are invalid: ' + ((r.error && r.error.issues) ? r.error.issues.map((i) => ((i.path || []).join('.') || '(options)') + ': ' + i.message).join('; ') : 'invalid'));
      if (r.data && typeof r.data === 'object' && !Array.isArray(r.data)) options = r.data;
    }
  }
  plugin = value;
  base = { plugin: m.name || value.name, logger, gatewayVersion: m.gatewayVersion, apiVersion: m.apiVersion, state: createState() };
  const hooks = ['onRequest', 'onToolCall', 'onResponse', 'onError', 'onConfigChange'].filter((h) => typeof value[h] === 'function');
  return { name: value.name, apiVersion: value.apiVersion, hooks, routes: !!value.routes, options: clone(options) };
}
async function run(m) {
  const ctx = { ...base, ...(m.tenant ? { tenant: m.tenant } : {}), secrets: { names: () => m.secretNames || [], get: (name) => rpc('secret', { call: m.id, name }) } };
  const h = plugin[m.hook];
  if (m.hook === 'onConfigChange') { await h.call(plugin, m.change, ctx); return {}; }
  const call = { ...m.call };
  Object.defineProperty(call, 'state', { value: m.call.state || new Map(), enumerable: true });
  if (m.hook === 'onToolCall') { const out = await h.call(plugin, call, ctx); return { out, arguments: call.arguments, state: call.state }; }
  if (m.hook === 'onResponse') { const out = await h.call(plugin, call, m.result, ctx); return { out, state: call.state }; }
  await h.call(plugin, call, m.error, ctx);
  return { state: call.state };
}
const safeState = (st) => { const o = new Map(); for (const [k, v] of st || []) { try { o.set(k, structuredClone(v)); } catch {} } return o; };
onMsg(async (m) => {
  if (m.type === 'rpc-result') { const p = pending.get(m.id); pending.delete(m.id); if (!p) return; return m.error !== undefined ? p.reject(new Error(m.error)) : p.resolve(m.value); }
  if (m.type === 'init') {
    try { send({ type: 'ready', meta: await init(m) }); } catch (e) { send({ type: 'init-error', error: (e && e.message) || String(e) }); }
    return;
  }
  if (m.type === 'close') {
    try { if (plugin && typeof plugin.close === 'function') await plugin.close(); } catch {}
    send({ type: 'closed' });
    return;
  }
  if (m.type === 'call') {
    try {
      const r = await run(m);
      let out;
      try { out = structuredClone(r.out); } catch { throw new Error(m.hook + ' returned a value that cannot be passed out of the isolated runtime'); }
      send({ type: 'result', id: m.id, out, arguments: r.arguments, state: safeState(r.state) });
    } catch (e) {
      send({ type: 'result', id: m.id, error: (e && e.message) || String(e) });
    }
  }
});
`;

interface Channel {
  post(m: unknown): void;
  kill(): void;
  readonly kind: IsolatedRuntime;
}

export interface IsolatedSpec {
  runtime: IsolatedRuntime;
  /** `data:` URL of the verified bytes, a `file:` URL or a package specifier. */
  url: string;
  label: string;
  /** Config name override. */
  name?: string;
  options: Record<string, unknown>;
  limits: ModulePluginLimits;
  permissions: PluginPermissions;
  secretNames: string[];
  /** Directory of the plugin file (process runtime: readable by default). */
  dir?: string;
  gatewayVersion: string;
  apiVersion: number;
  logger: Logger;
}

export interface IsolatedMeta {
  name: string;
  apiVersion?: number;
  hooks: string[];
  routes: boolean;
  options: Record<string, unknown>;
}

interface Inflight {
  resolve: (v: { out?: unknown; arguments?: Record<string, unknown>; state?: Map<string, unknown> }) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
  ch?: Channel;
  secrets?: { get(name: string): Promise<string> };
}

const recycled = new WeakSet<Channel>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref?.());

/** Parent-side handle of one isolated plugin: spawns / respawns the runtime and runs hook calls over messages. */
export class IsolatedRuntimeHandle {
  private ch?: Channel;
  private starting?: Promise<Channel>;
  private readonly inflight = new Map<number, Inflight>();
  private seq = 0;
  private crashes = 0;
  private closed = false;
  restarts = 0;
  lastCrash?: string;
  meta?: IsolatedMeta;

  constructor(readonly spec: IsolatedSpec) {}

  get timeoutMs(): number {
    return this.spec.limits.timeoutMs ?? 5000;
  }

  /** Start the runtime and load the plugin (throws the load error). */
  async start(): Promise<IsolatedMeta> {
    await this.channel();
    return this.meta!;
  }

  private env(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of this.spec.permissions.env ?? []) if (process.env[k] !== undefined) out[k] = process.env[k]!;
    return out;
  }

  private spawnChannel(onMessage: (m: Record<string, unknown>) => void, onGone: (why: string) => void): Channel {
    const memoryMb = this.spec.limits.memoryMb ?? 128;
    let lastError: string | undefined;
    if (this.spec.runtime === 'worker') {
      const w = new Worker(BOOTSTRAP, {
        eval: true,
        env: this.env(),
        execArgv: [],
        stdout: false,
        stderr: false,
        resourceLimits: { maxOldGenerationSizeMb: memoryMb, maxYoungGenerationSizeMb: Math.max(1, Math.min(16, Math.floor(memoryMb / 4))), stackSizeMb: 4 },
      });
      w.unref();
      w.on('message', onMessage);
      w.on('error', (e: Error & { code?: string }) => {
        lastError = e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? `exceeded its memory limit (limits.memoryMb ${memoryMb}): ${e.message}` : e.message;
      });
      w.on('exit', (code) => onGone(lastError ?? `exited with code ${code}`));
      return { kind: 'worker', post: (m) => w.postMessage(m), kill: () => void w.terminate() };
    }
    const fsRead = [...(this.spec.dir ? [this.spec.dir] : []), ...(this.spec.permissions.fs?.read ?? [])];
    const fsWrite = this.spec.permissions.fs?.write ?? [];
    const args = [`--max-old-space-size=${memoryMb}`, '--permission', ...fsRead.map((p) => `--allow-fs-read=${p}`), ...fsWrite.map((p) => `--allow-fs-write=${p}`), '-e', BOOTSTRAP];
    const cp: ChildProcess = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced', env: this.env() });
    let stderr = '';
    cp.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
    cp.unref();
    (cp.channel as { unref?: () => void } | undefined)?.unref?.();
    cp.on('message', (m) => onMessage(m as Record<string, unknown>));
    cp.on('error', (e) => (lastError = e.message));
    cp.on('exit', (code, signal) => {
      const oom = /heap out of memory|Allocation failed/i.test(stderr) || signal === 'SIGABRT' || code === 134;
      onGone(lastError ?? (oom ? `exceeded its memory limit (limits.memoryMb ${memoryMb})` : `exited with ${signal ? `signal ${signal}` : `code ${code}`}${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`));
    });
    return { kind: 'process', post: (m) => cp.send(m as never), kill: () => void cp.kill('SIGKILL') };
  }

  private channel(): Promise<Channel> {
    if (this.closed) return Promise.reject(new PluginCrash('plugin runtime is closed'));
    if (this.ch) return Promise.resolve(this.ch);
    if (this.starting) return this.starting;
    this.starting = (async () => {
      // exponential backoff after repeated crashes: 0 for the first restart, then 100 ms, 200 ms … up to 30 s
      if (this.crashes > 1) await sleep(Math.min(30_000, 100 * 2 ** (this.crashes - 2)));
      return new Promise<Channel>((resolve, reject) => {
        let ready = false;
        let ch: Channel | undefined = undefined;
        const loadTimer = setTimeout(() => {
          if (!ready) {
            ch?.kill();
            reject(new PluginTimeout(`plugin ${this.spec.label} did not load within ${Math.max(10_000, this.timeoutMs)} ms`));
          }
        }, Math.max(10_000, this.timeoutMs));
        loadTimer.unref?.();
        ch = this.spawnChannel(
          (m) => {
            if (m.type === 'ready') {
              ready = true;
              clearTimeout(loadTimer);
              this.meta = m.meta as IsolatedMeta;
              this.ch = ch;
              resolve(ch!);
            } else if (m.type === 'init-error') {
              ready = true;
              clearTimeout(loadTimer);
              ch!.kill();
              reject(new Error(String(m.error)));
            } else this.onMessage(m);
          },
          (why) => {
            clearTimeout(loadTimer);
            if (this.ch === ch) this.ch = undefined;
            if (recycled.has(ch!)) {
              recycled.delete(ch!);
              return;
            }
            if (!ready) {
              ready = true;
              reject(new PluginCrash(why));
              return;
            }
            if (!this.closed) {
              this.crashes++;
              this.restarts++;
              this.lastCrash = why;
            }
            const err = new PluginCrash(why);
            for (const [id, f] of this.inflight) {
              if (f.ch !== ch) continue;
              this.inflight.delete(id);
              if (f.timer) clearTimeout(f.timer);
              f.reject(err);
            }
          },
        );
        ch.post({ type: 'init', url: this.spec.url, label: this.spec.label, name: this.spec.name, options: this.spec.options, permissions: this.spec.permissions, gatewayVersion: this.spec.gatewayVersion, apiVersion: this.spec.apiVersion });
      });
    })().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private onMessage(m: Record<string, unknown>): void {
    if (m.type === 'log') {
      const lvl = (['debug', 'info', 'warn', 'error'] as const).find((l) => l === m.level) ?? 'info';
      this.spec.logger[lvl](`[plugin ${this.meta?.name ?? this.spec.label}] ${String(m.msg)}`);
      return;
    }
    if (m.type === 'rpc') {
      const f = this.inflight.get(m.call as number);
      const reply = (r: { value?: unknown; error?: string }) => this.ch?.post({ type: 'rpc-result', id: m.id, ...r });
      if (m.op !== 'secret' || !f?.secrets) return reply({ error: 'secrets are not available here' });
      f.secrets.get(String(m.name)).then(
        (value) => reply({ value }),
        (e: Error) => reply({ error: e.message }),
      );
      return;
    }
    if (m.type === 'result') {
      const f = this.inflight.get(m.id as number);
      if (!f) return;
      this.inflight.delete(m.id as number);
      if (f.timer) clearTimeout(f.timer);
      this.crashes = 0;
      if (m.error !== undefined) f.reject(new Error(String(m.error)));
      else f.resolve({ out: m.out, arguments: m.arguments as Record<string, unknown> | undefined, state: m.state as Map<string, unknown> | undefined });
    }
  }

  /** Run one hook in the runtime. */
  async call(hook: HookName, payload: Record<string, unknown>, secrets?: Inflight['secrets']): Promise<{ out?: unknown; arguments?: Record<string, unknown>; state?: Map<string, unknown> }> {
    const max = this.spec.limits.maxConcurrent ?? 16;
    if (this.inflight.size >= max) throw new PluginBusy(`busy: ${max} hook calls in flight (limits.maxConcurrent)`);
    const ch = await this.channel();
    const id = ++this.seq;
    const ms = this.timeoutMs;
    return new Promise((resolve, reject) => {
      const f: Inflight = { resolve, reject, secrets, ch };
      f.timer = setTimeout(() => {
        if (!this.inflight.has(id)) return;
        this.inflight.delete(id);
        reject(new PluginTimeout(`${hook} timed out after ${ms} ms`));
        // the runtime may be stuck (endless loop): recycle it; a fresh one serves the next call
        this.recycle(ch, `terminated: another ${hook} call on this runtime timed out after ${ms} ms`);
      }, ms);
      f.timer.unref?.();
      this.inflight.set(id, f);
      try {
        ch.post({ type: 'call', id, hook, ...payload });
      } catch (e) {
        this.inflight.delete(id);
        clearTimeout(f.timer);
        reject(new Error(`could not pass the call into the isolated runtime: ${(e as Error).message}`));
      }
    });
  }

  /** Terminate a runtime now and detach it (calls still on it fail; the next call starts a fresh one). */
  private recycle(ch: Channel, why: string): void {
    if (this.ch === ch) this.ch = undefined;
    recycled.add(ch);
    this.restarts++;
    this.lastCrash = why;
    for (const [id, f] of this.inflight) {
      if (f.ch !== ch) continue;
      this.inflight.delete(id);
      if (f.timer) clearTimeout(f.timer);
      f.reject(new PluginCrash(why));
    }
    ch.kill();
  }

  stats(): { runtime: IsolatedRuntime; alive: boolean; inFlight: number; restarts: number; lastCrash?: string } {
    return { runtime: this.spec.runtime, alive: !!this.ch, inFlight: this.inflight.size, restarts: this.restarts, ...(this.lastCrash ? { lastCrash: this.lastCrash } : {}) };
  }

  async close(): Promise<void> {
    this.closed = true;
    const ch = this.ch;
    this.ch = undefined;
    if (!ch) return;
    await Promise.race([
      new Promise<void>((resolve) => {
        const prev = this.onMessage.bind(this);
        this.onMessage = (m) => (m.type === 'closed' ? resolve() : prev(m));
        try {
          ch.post({ type: 'close' });
        } catch {
          resolve();
        }
      }),
      sleep(2000),
    ]);
    ch.kill();
  }
}

/** Directory of a file URL (process runtime default read access). */
export function dirOfFileUrl(url: string): string | undefined {
  if (!url.startsWith('file:')) return undefined;
  return dirname(fileURLToPath(url));
}
