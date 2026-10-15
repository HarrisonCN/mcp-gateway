/**
 * Plugin hooks.
 *
 * A plugin is a plain object (or a module whose default export is that object
 * or a factory returning it) with any of these hooks:
 *
 *  - `onRequest(req, res, next)` — Express middleware that runs for every HTTP
 *    request after the network guards (IP allowlist, Host check) and before
 *    CORS, auth and the routes;
 *  - `onToolCall(call)` — runs for every upstream call (REST and `/mcp`) BEFORE
 *    the policy rules: it may rewrite `call.arguments`, refuse the call
 *    (`{ deny: 'reason' }`) or answer it without contacting the server
 *    (`{ respond: result }`);
 *  - `onResponse(call, result, ctx)` — runs AFTER the output filter; it may return a
 *    replacement result;
 *  - `onError(call, error, ctx)` (API v2) — observe-only, runs for every failed call after `onResponse`;
 *    exceptions are logged, never fail the call.
 *
 * Plugin API v2 (3.0): every hook receives a {@link PluginHookContext} as its last argument and plugins declare
 * `apiVersion: 2`. Plugin API v1 (no `apiVersion`) was removed in 4.0: such plugins are refused at load.
 *
 * Plugin API v3 (4.0): the hook context also carries `secrets` (resolves the plugin's own `secrets:` mapping from
 * the config through the gateway's secret providers) and `tenant` (id / name / role of the caller's tenant), and the
 * optional `onConfigChange(change, ctx)` hook runs after every applied hot reload. v2 plugins still load, with a
 * deprecation warning; v2 is removed in 5.0.
 *
 * Plugin API v4 (4.9, current in 5.0): v3 plus `ctx.state`, a per-plugin key-value store with optional TTLs that
 * lives as long as the plugin instance (counters, caches, rate windows) — no more module-level globals.
 * 5.0 refuses v2 and deprecates v3 (still loads, with a warning, until 6.0). 8.0 refuses v4: plugin API v5 only.
 *
 * Plugin API v5 (7.9, required in 8.0): hooks may return the outcome shape of the WIT world
 * `mcp-gateway:plugin@5.0.0` (`wit/mcp-gateway-plugin.wit`) — `{ action: 'continue' | 'rewrite' | 'deny' | 'respond' }`
 * from `onToolCall`, `{ action: 'continue' | 'replace', result }` from `onResponse` — the same contract WASM component
 * plugins (`component:`) implement. The v4 return shapes keep working inside v5 plugins. 8.0 refuses `apiVersion: 4`.
 *
 * Plugin API v6 (16.9.0-canary.0, the 17.0 contract — proposal until 17.0.0-rc.1): v5 without the v4 return shapes —
 * hooks return `{ action }` outcomes only (anything else fails the hook, fail closed) — and module plugins run in a
 * worker or a child process only (a v6 module plugin is refused inline, so it has no `onRequest` / `routes`). 16.9 loads
 * v5 and v6; a loaded v5 module plugin, a v4-era outcome from it and HTTP hooks are recorded as 17.0 deprecations
 * (`mcp-gateway plugin migrate --to v6` rewrites a plugin file).
 *
 * 17.0.0-alpha.1: plugin API v6 only. `apiVersion: 5` is refused at load, `runtime: inline` module plugins are refused
 * (before the module is imported), and every hook — programmatic plugins included — must return `{ action }` outcomes.
 *
 * Hooks run in configuration order; the first refusal / short-circuit wins.
 * A hook that throws fails the call (`-32006`) — plugins fail closed.
 *
 * @module plugins
 */

import { emitOpsEvent } from '../gateway/ops-events.js';
import { dirname, isAbsolute, resolve } from 'path';
import { pathToFileURL } from 'url';
import { readFile } from 'fs/promises';
import { PluginTrustSchema, type PluginTrustConfig } from './trust-schema.js';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import type { PluginConfig, ProxyResponse } from '../utils/types.js';
import { logger, type Logger } from '../utils/logger.js';
import { VERSION } from '../utils/version.js';
import { createHash } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { IsolatedRuntimeHandle, PluginBusy, PluginCrash, RUNTIME, RUNTIME_KILL, type HookName, type IsolatedRuntime, type ModulePluginLimits, type PluginPermissions } from './runtime.js';

export { PluginCrash, PluginBusy, PluginTimeout, type PluginPermissions, type ModulePluginLimits } from './runtime.js';

/** Version of the plugin contract implemented by this gateway. */
export const PLUGIN_API_VERSION = 6;

/** Oldest plugin contract still loaded (8.0: v5 only; 16.9.0: v5 – v6; 17.0.0-alpha.1: v6 only). */
export const PLUGIN_API_MIN_VERSION = 6;

/** Call refused (or failed) by a plugin hook. */
export const ERR_PLUGIN_REJECTED = -32006;

export interface PluginCall {
  serverId: string;
  /** Tool / prompt name or resource URI. */
  name: string;
  kind: 'tool' | 'resource' | 'prompt';
  method: string;
  /** Tool arguments (tools) or request params (resources / prompts). Mutable. */
  arguments: Record<string, unknown>;
  clientId?: string;
  /** First tenant (workspace) of the client, when tenants are configured (3.3). */
  tenant?: string;
  via: 'rest' | 'mcp';
  /** Scratch space shared by the hooks of one call. */
  readonly state: Map<string, unknown>;
}

export type ToolCallOutcome =
  | void
  | undefined
  | { arguments?: Record<string, unknown>; deny?: undefined; respond?: undefined }
  | { deny: string }
  | { respond: unknown };

/** Passed as the last argument of every hook (plugin API v2). */
export interface PluginHookContext {
  /** The plugin's own name. */
  plugin: string;
  logger: Logger;
  gatewayVersion: string;
  apiVersion: number;
  /** API v3: the plugin's secrets (names from its `secrets:` config mapping). */
  secrets?: PluginSecrets;
  /** API v3: the caller's tenant, for call hooks when tenants are configured. */
  tenant?: PluginTenant;
  /** API v4: per-plugin key-value state (in memory, survives across calls, cleared when the plugin is unloaded). */
  state?: PluginState;
}

/** API v4: per-plugin key-value store. Values are kept by reference; at most 10 000 keys (oldest evicted). */
export interface PluginState {
  get<T = unknown>(key: string): T | undefined;
  /** Store a value; `ttlMs` expires it. */
  set(key: string, value: unknown, ttlMs?: number): void;
  has(key: string): boolean;
  delete(key: string): boolean;
  /** Live (non-expired) key count. */
  size(): number;
  clear(): void;
}

const STATE_MAX_KEYS = 10_000;

/** In-memory {@link PluginState}. */
export function createPluginState(now: () => number = Date.now): PluginState {
  const m = new Map<string, { v: unknown; exp?: number }>();
  const live = (k: string) => {
    const e = m.get(k);
    if (!e) return undefined;
    if (e.exp !== undefined && e.exp <= now()) {
      m.delete(k);
      return undefined;
    }
    return e;
  };
  return {
    get: <T>(k: string) => live(k)?.v as T | undefined,
    set(k, v, ttlMs) {
      m.delete(k);
      m.set(k, { v, ...(ttlMs !== undefined && ttlMs > 0 ? { exp: now() + ttlMs } : {}) });
      while (m.size > STATE_MAX_KEYS) m.delete(m.keys().next().value as string);
    },
    has: (k) => live(k) !== undefined,
    delete: (k) => m.delete(k),
    size() {
      for (const k of [...m.keys()]) live(k);
      return m.size;
    },
    clear: () => m.clear(),
  };
}

/** API v3: access to the secret references a plugin was granted in config (`plugins[].secrets: { NAME: secret://… }`). */
export interface PluginSecrets {
  /** Resolve a granted secret by its name. Throws for names the plugin was not granted. */
  get(name: string): Promise<string>;
  /** Names granted to this plugin. */
  names(): string[];
}

/** API v3: tenant of the client making the call. */
export interface PluginTenant {
  id: string;
  name?: string;
  role?: string;
}

/** API v3: passed to `onConfigChange` after a hot reload was applied. */
export interface PluginConfigChange {
  /** Areas that changed (`servers`, `auth`, `policy`, `plugins`, …). */
  applied: string[];
  /** Server ids after the reload. */
  servers: string[];
  at: string;
}

/** What the host needs from the gateway for API v3 contexts. */
export interface PluginEnv {
  resolveSecret?: (ref: string, plugin: string) => Promise<string>;
  /** 14.2.0: `serverId` selects the acting tenant (the caller's tenant entitled to the called server). */
  tenantOf?: (clientId: string | undefined, serverId?: string) => PluginTenant | undefined;
}

export interface PluginCallError {
  code?: number;
  message: string;
}

export interface GatewayPlugin {
  name: string;
  /** Plugin contract version the plugin was written for: 5 (required since 8.0). */
  apiVersion?: number;
  onRequest?: (req: Request, res: Response, next: NextFunction, ctx: PluginHookContext) => void | Promise<void>;
  onToolCall?: (call: PluginCall, ctx: PluginHookContext) => ToolCallOutcome | Promise<ToolCallOutcome>;
  onResponse?: (call: PluginCall, result: ProxyResponse, ctx: PluginHookContext) => ProxyResponse | void | Promise<ProxyResponse | void>;
  /** API v2: observe failed calls (after `onResponse`). Never changes the result. */
  onError?: (call: PluginCall, error: PluginCallError, ctx: PluginHookContext) => void | Promise<void>;
  /** API v3: runs after every applied hot reload (errors are logged, never fail the reload). */
  onConfigChange?: (change: PluginConfigChange, ctx: PluginHookContext) => void | Promise<void>;
  /** Called on gateway stop and when the plugin is unloaded by a config reload. */
  close?: () => void | Promise<void>;
  /**
   * Kernel plugin SDK (10.5): validates `plugins[].options` when the plugin loads — a zod schema (anything with
   * `safeParse`) or a function returning error messages. A failure refuses the plugin (startup / reload fails).
   * The parsed value is what route handlers see as `ctx.options`.
   */
  configSchema?: PluginConfigSchema;
  /**
   * Kernel plugin SDK (10.5): HTTP routes, mounted like a built-in feature module — `admin` under
   * `/api/v1/admin/plugins/<name>` (operators only), `client` under `/api/v1/features/plugins/<name>` (any
   * authenticated client). Rebuilt whenever the plugin set changes (hot reload).
   */
  routes?: {
    admin?: (router: Router, ctx: PluginRouteContext) => void;
    client?: (router: Router, ctx: PluginRouteContext) => void;
  };
}

/** 10.5: what a plugin's `configSchema` may be. */
export type PluginConfigSchema =
  | { safeParse: (value: unknown) => { success: boolean; data?: unknown; error?: { issues?: Array<{ path?: Array<string | number>; message: string }>; message?: string } } }
  | ((options: Record<string, unknown>) => string[] | void);

/** 10.5: context handed to a plugin's route builders. */
export interface PluginRouteContext {
  plugin: string;
  /** `plugins[].options` after `configSchema` (as configured when there is none). */
  options: Record<string, unknown>;
  logger: Logger;
  gatewayVersion: string;
  /** The plugin's key-value store (shared with its hooks). */
  state?: PluginState;
  /** Tools the gateway currently serves. */
  tools: () => Array<{ serverId: string; name: string; description?: string }>;
  /**
   * Call a tool through the full pipeline. 11.1: always authorized by the gateway's central authorizer — pass the
   * route's `req` (its caller's scope applies) or a client id (that client's current scope applies; unknown ids may call
   * nothing). Without either the call runs as `system:plugin:<name>` (operator-installed code acting on its own).
   */
  invoke: (serverId: string, tool: string, args: Record<string, unknown>, caller?: string | Request) => Promise<ProxyResponse>;
  /** Client id of the request (`key:<name>`, `jwt:<sub>`, …). */
  clientOf: (req: Request) => string | undefined;
}

/** What the gateway provides to plugin routes (10.5). */
export interface PluginRouteEnv {
  tools: PluginRouteContext['tools'];
  invoke: (serverId: string, tool: string, args: Record<string, unknown>, caller: string | Request | undefined, plugin: string) => Promise<ProxyResponse>;
}

/**
 * 10.5: typed helper for writing a kernel plugin (hooks, config schema and routes in one object). Sets
 * `apiVersion: 6` (17.0: the only plugin API) unless given.
 *
 * ```ts
 * import { definePlugin } from '@winstonsayno/mcp-gateway';
 * import { z } from 'zod';
 * export default definePlugin({
 *   name: 'quota-notes',
 *   configSchema: z.object({ maxNotes: z.number().int().positive().default(100) }),
 *   routes: { admin: (r, ctx) => r.get('/', (_req, res) => res.json({ options: ctx.options })) },
 *   onToolCall: (call) => (call.tool === 'rm' ? { action: 'deny', reason: 'no rm' } : { action: 'continue' }),
 * });
 * ```
 */
export function definePlugin<T extends GatewayPlugin>(plugin: T): T & { apiVersion: number } {
  return { ...plugin, apiVersion: plugin.apiVersion ?? PLUGIN_API_VERSION };
}

/** 10.5: validate options against a plugin's `configSchema`; returns the parsed options or throws. */
export function validatePluginOptions(p: GatewayPlugin, options: Record<string, unknown> = {}): Record<string, unknown> {
  const schema = p.configSchema;
  if (!schema) return options;
  if (typeof schema === 'function') {
    const errors = schema(options) ?? [];
    if (errors.length) throw new Error(`Plugin "${p.name}" options are invalid: ${errors.join('; ')}`);
    return options;
  }
  if (typeof schema.safeParse !== 'function') throw new Error(`Plugin "${p.name}": configSchema must be a zod schema (safeParse) or a function`);
  const r = schema.safeParse(options);
  if (!r.success) {
    const issues = r.error?.issues?.map((i) => `${(i.path ?? []).join('.') || '(options)'}: ${i.message}`).join('; ') ?? r.error?.message ?? 'invalid';
    throw new Error(`Plugin "${p.name}" options are invalid: ${issues}`);
  }
  const d = r.data;
  return d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : options;
}

/** 10.5: run a hook with an optional time limit (`plugins[].timeoutMs`). */
async function withTimeout<T>(p: GatewayPlugin, hook: string, ms: number | undefined, run: () => T | Promise<T>): Promise<T> {
  if (!ms) return run();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${hook} timed out after ${ms} ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface PluginContext {
  options: Record<string, unknown>;
  logger: Logger;
  gatewayVersion: string;
  apiVersion: number;
}

export type PluginFactory = (ctx: PluginContext) => GatewayPlugin | Promise<GatewayPlugin>;

export type PluginSource = GatewayPlugin | PluginFactory;

function isPlugin(v: unknown): v is GatewayPlugin {
  return typeof v === 'object' && v !== null && typeof (v as GatewayPlugin).name === 'string';
}

async function instantiate(src: unknown, ctx: PluginContext, label: string): Promise<GatewayPlugin> {
  const value = typeof src === 'function' ? await (src as PluginFactory)(ctx) : src;
  if (!isPlugin(value)) throw new Error(`Plugin ${label} must export a plugin object with a "name" (or a factory returning one)`);
  const v = value.apiVersion ?? 1;
  if (v > PLUGIN_API_VERSION) {
    throw new Error(`Plugin "${value.name}" needs plugin API v${v}; this gateway implements v${PLUGIN_API_VERSION}`);
  }
  if (v === 1) {
    throw new Error(`Plugin "${value.name}" uses plugin API v1, which was removed in 4.0 — declare \`apiVersion: 6\` (hooks receive a context argument; see docs/guides/migrating-to-v4.md)`);
  }
  if (v === 2) {
    throw new Error(`Plugin "${value.name}" uses plugin API v2, which was removed in 5.0 — declare \`apiVersion: 6\` (see docs/guides/migrating-to-v5.md)`);
  }
  if (v === 3) {
    throw new Error(`Plugin "${value.name}" uses plugin API v3, which was removed in 6.0 — declare \`apiVersion: 6\` (adds ctx.state; see docs/guides/migrating-to-v6.md)`);
  }
  if (v === 4) {
    throw new Error(`Plugin "${value.name}" uses plugin API v4, which was removed in 8.0 — declare \`apiVersion: 6\` (hooks may return \`{ action }\` outcomes; see docs/guides/migrating-to-v8.md)`);
  }
  if (v === 5) {
    throw new Error(`Plugin "${value.name}" uses plugin API v5, which was removed in 17.0 — declare \`apiVersion: 6\` (hooks return { action } outcomes only; run \`mcp-gateway plugin migrate --to v6 <file>\`, see docs/migrating-to-v17.md)`);
  }
  if (v < PLUGIN_API_MIN_VERSION) throw new Error(`Plugin "${value.name}" declares unsupported plugin API v${v}`);
  return value;
}

/** 5.4: verify a plugin's `.sig` against `pluginTrust` (throws when it must not load). */
export async function checkSignature(cfg: PluginConfig, baseDir: string, trust?: PluginTrustConfig): Promise<string | undefined> {
  return (await verifySignature(cfg, baseDir, trust))?.keyId;
}

/** What a successful signature check verified: the exact bytes, which are the only bytes that may be loaded. */
export interface VerifiedArtifact {
  keyId: string;
  file: string;
  bytes: Buffer;
  sha256: string;
}

/**
 * 14.3.0 (MGW-2026-016): verify the signature and return the verified bytes. The loader runs exactly these bytes and
 * refuses the plugin when the file on disk no longer matches them (changed after verification).
 */
export async function verifySignature(cfg: PluginConfig, baseDir: string, trust?: PluginTrustConfig): Promise<VerifiedArtifact | undefined> {
  const t = PluginTrustSchema.parse(trust ?? {});
  const spec = cfg.component ?? cfg.module;
  if (!spec || (!t.keys.length && !t.requireSigned)) return undefined;
  const label = cfg.name ?? spec;
  const isPath = !!cfg.component || spec.startsWith('.') || isAbsolute(spec);
  if (!isPath) {
    if (t.requireSigned) throw new Error(`Plugin "${label}": pluginTrust.requireSigned refuses package-name modules — install a signed file (mcp-gateway plugin verify)`);
    return undefined;
  }
  const file = resolve(baseDir, spec);
  const sigFile = cfg.signature ? resolve(baseDir, cfg.signature) : `${file}.sig`;
  let sig: unknown;
  try {
    sig = JSON.parse(await readFile(sigFile, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Plugin "${label}": unreadable signature ${sigFile}: ${(e as Error).message}`);
    if (t.requireSigned) throw new Error(`Plugin "${label}" is not signed (no ${sigFile}) and pluginTrust.requireSigned is on`);
    return undefined;
  }
  // 13.3.0: loaded only when a signature is actually checked (keeps @noble/* out of the default startup)
  const { verifyArtifact } = await import('./trust.js');
  const bytes = await readFile(file);
  const r = verifyArtifact(bytes, sig, t.keys, { requirePostQuantum: t.requirePostQuantum });
  if (!r.ok) throw new Error(`Plugin "${label}" failed signature verification: ${r.reason}`);
  return { keyId: r.keyId, file, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** 14.3.0 (MGW-2026-016): the file must still hold the verified bytes when it is loaded (they are loaded, not the file). */
async function assertUnchanged(v: VerifiedArtifact, label: string): Promise<void> {
  let now: string;
  try {
    now = createHash('sha256').update(await readFile(v.file)).digest('hex');
  } catch (e) {
    throw new Error(`Plugin "${label}" changed after signature verification (${(e as Error).message}); refusing to load`);
  }
  if (now !== v.sha256) throw new Error(`Plugin "${label}" changed after signature verification (sha256 ${now.slice(0, 12)}…, verified ${v.sha256.slice(0, 12)}…); refusing to load`);
}

const dataUrl = (bytes: Buffer) => `data:text/javascript;base64,${bytes.toString('base64')}`;

/** 14.3.0: which runtime a module plugin entry asks for (`runtime`, or the `isolation: worker|process|inline` alias); 15.0.0: `worker` when it names none. */
export function runtimeOfConfig(cfg: PluginConfig): 'inline' | IsolatedRuntime {
  const iso = cfg.isolation as string | undefined;
  return cfg.runtime ?? (iso === 'inline' || iso === 'worker' || iso === 'process' ? iso : undefined) ?? 'worker'; // 15.0.0: worker by default
}

/** 14.3.0: where a loaded plugin runs — `inline` (in the gateway process), `worker`, `process` or `wasm`. */
export function pluginRuntimeOf(p: unknown): 'inline' | IsolatedRuntime | 'wasm' {
  const rt = (p as Record<symbol, unknown> | null)?.[RUNTIME];
  if (rt === 'worker' || rt === 'process') return rt;
  return typeof (p as { stats?: unknown })?.stats === 'function' ? 'wasm' : 'inline';
}


/**
 * 16.9.0: a hook outcome in a v4-era shape (anything but `{ action }` / nothing) fails a v6 plugin's hook. 17.0.0-alpha.1:
 * plugin API v6 only, so every plugin — module, isolated or programmatic — is held to it (fail closed).
 */
function checkOutcome(_p: GatewayPlugin, hook: 'onToolCall' | 'onResponse', out: unknown): void {
  if (!out || typeof out !== 'object' || 'action' in out) return;
  throw new Error(`plugin API v6 accepts only { action } outcomes from ${hook} (got ${Object.keys(out).slice(0, 4).join(', ') || 'an object'}); see docs/migrating-to-v17.md`);
}

/** Plugin API v5 outcome (`{ action }`) → the internal shape; v4 shapes pass through. */
export function normalizeToolCallOutcome(out: unknown): ToolCallOutcome {
  if (!out || typeof out !== 'object' || !('action' in out)) return out as ToolCallOutcome;
  const o = out as { action: unknown; arguments?: unknown; reason?: unknown; result?: unknown };
  switch (o.action) {
    case 'continue':
      return undefined;
    case 'rewrite':
      if (!o.arguments || typeof o.arguments !== 'object' || Array.isArray(o.arguments)) throw new Error('"rewrite" needs an "arguments" object');
      return { arguments: o.arguments as Record<string, unknown> };
    case 'deny':
      return { deny: typeof o.reason === 'string' && o.reason ? o.reason : 'denied by plugin' };
    case 'respond':
      return { respond: o.result };
    default:
      throw new Error(`unknown outcome action ${JSON.stringify(o.action)}`);
  }
}

/** Plugin API v5 `onResponse` outcome (`{ action: 'continue' | 'replace', result }`) → replacement or undefined. */
export function normalizeResponseOutcome(out: unknown, current: ProxyResponse): ProxyResponse | undefined {
  if (!out || typeof out !== 'object') return undefined;
  if (!('action' in out)) return out as ProxyResponse;
  const o = out as { action: unknown; result?: unknown };
  if (o.action === 'continue') return undefined;
  if (o.action === 'replace') return current.success ? { ...current, result: o.result } : undefined;
  throw new Error(`unknown outcome action ${JSON.stringify(o.action)}`);
}

/** Load one configured plugin (`module` is a path relative to `baseDir`, or a package name). */
export async function loadPlugin(cfg: PluginConfig, baseDir = process.cwd(), trust?: PluginTrustConfig): Promise<GatewayPlugin> {
  const verified = await verifySignature(cfg, baseDir, trust);
  const label = cfg.name ?? cfg.component ?? cfg.module ?? 'plugin';
  if (cfg.component) {
    if (verified) await assertUnchanged(verified, label);
    const { loadWasmPlugin } = await import('./wasm.js');
    const iso = cfg.isolation as 'tenant' | 'client' | 'shared' | undefined;
    return loadWasmPlugin({ wasm: cfg.component, name: cfg.name, isolation: iso, limits: cfg.limits as never, abi: 'component', bytes: verified?.bytes }, baseDir);
  }
  if ((cfg as { wasm?: unknown }).wasm !== undefined) throw new Error('`plugins[].wasm` was removed in 8.0 — rebuild the plugin as a plugin API v5 component and load it with `component`');
  if (!cfg.module) throw new Error('A plugin needs "module" or "component"');
  const spec = cfg.module;
  const isPath = spec.startsWith('.') || isAbsolute(spec);
  const runtime = runtimeOfConfig(cfg);
  // 14.3.0 (MGW-2026-016): a signed plugin runs the verified bytes — never a second read of the file
  if (verified) await assertUnchanged(verified, label);
  const target = verified ? dataUrl(verified.bytes) : isPath ? pathToFileURL(resolve(baseDir, spec)).href : spec;
  if (runtime === 'worker' || runtime === 'process') return loadIsolated(cfg, runtime, target, isPath ? dirname(resolve(baseDir, spec)) : undefined);
  // 17.0.0-alpha.1 (plugin API v6): module plugins never run in the gateway process — refused before the module is imported
  throw new Error(`Plugin "${label}": runtime: inline was removed in 17.0 — plugin API v6 module plugins run in a worker or a child process only; use runtime: worker (or process), see docs/migrating-to-v17.md`);
}

/** 14.3.0: a module plugin in a worker / child process — the returned object only proxies hook calls. */
async function loadIsolated(cfg: PluginConfig, runtime: IsolatedRuntime, url: string, dir: string | undefined): Promise<GatewayPlugin> {
  const limits = { ...((cfg.limits ?? {}) as ModulePluginLimits), ...(cfg.timeoutMs && !(cfg.limits as ModulePluginLimits | undefined)?.timeoutMs ? { timeoutMs: cfg.timeoutMs } : {}) };
  const permissions = (cfg.permissions ?? {}) as PluginPermissions;
  const handle = new IsolatedRuntimeHandle({
    runtime,
    url,
    label: cfg.name ?? cfg.module ?? 'plugin',
    name: cfg.name,
    options: cfg.options ?? {},
    limits,
    permissions,
    secretNames: Object.keys(cfg.secrets ?? {}),
    dir,
    gatewayVersion: VERSION,
    apiVersion: PLUGIN_API_VERSION,
    logger,
  });
  let meta;
  try {
    meta = await handle.start();
    await instantiate({ name: meta.name, apiVersion: meta.apiVersion }, contextFor(cfg), cfg.module ?? 'plugin');
    if (meta.hooks.includes('onRequest') || meta.routes) throw new Error(`Plugin "${meta.name}" has onRequest / routes, which run in the gateway process — plugin API v6 module plugins cannot have HTTP hooks (17.0 removed inline module plugins; see docs/migrating-to-v17.md)`);
  } catch (err) {
    await handle.close();
    throw err;
  }
  const name = cfg.name ?? meta.name;
  const plugin: GatewayPlugin & { [RUNTIME]: IsolatedRuntime; [RUNTIME_KILL]: () => Promise<void>; runtimeStats: () => ReturnType<IsolatedRuntimeHandle['stats']> } = {
    name,
    apiVersion: meta.apiVersion,
    [RUNTIME]: runtime,
    [RUNTIME_KILL]: () => handle.kill(),
    runtimeStats: () => handle.stats(),
    close: () => handle.close(),
  };
  const callPayload = (call: PluginCall) => ({
    serverId: call.serverId,
    name: call.name,
    kind: call.kind,
    method: call.method,
    arguments: call.arguments,
    clientId: call.clientId,
    tenant: call.tenant,
    via: call.via,
    state: cloneableState(call.state),
  });
  const syncState = (call: PluginCall, st?: Map<string, unknown>) => {
    if (!st) return;
    for (const [k, v] of st) call.state.set(k, v);
  };
  const tenantOf = (ctx: PluginHookContext) => (ctx.tenant ? { ...ctx.tenant } : undefined);
  if (meta.hooks.includes('onToolCall')) {
    plugin.onToolCall = async (call, ctx) => {
      const before = call.arguments;
      const r = await handle.call('onToolCall', { call: callPayload(call), tenant: tenantOf(ctx), secretNames: ctx.secrets?.names() ?? [] }, ctx.secrets);
      syncState(call, r.state);
      checkOutcome(plugin, 'onToolCall', r.out);
      const out = normalizeToolCallOutcome(r.out);
      // an in-place change of `call.arguments` inside the runtime is a rewrite
      if (!out && r.arguments && !isDeepStrictEqual(r.arguments, before)) return { arguments: r.arguments };
      return out;
    };
  }
  if (meta.hooks.includes('onResponse')) {
    plugin.onResponse = async (call, result, ctx) => {
      const r = await handle.call('onResponse', { call: callPayload(call), result, tenant: tenantOf(ctx), secretNames: ctx.secrets?.names() ?? [] }, ctx.secrets);
      syncState(call, r.state);
      checkOutcome(plugin, 'onResponse', r.out);
      return r.out as ProxyResponse | void;
    };
  }
  if (meta.hooks.includes('onError')) {
    plugin.onError = async (call, error, ctx) => {
      const r = await handle.call('onError', { call: callPayload(call), error, tenant: tenantOf(ctx), secretNames: ctx.secrets?.names() ?? [] }, ctx.secrets);
      syncState(call, r.state);
    };
  }
  if (meta.hooks.includes('onConfigChange')) {
    plugin.onConfigChange = async (change, ctx) => {
      await handle.call('onConfigChange', { change, secretNames: ctx.secrets?.names() ?? [] }, ctx.secrets);
    };
  }
  if (cfg.secrets) grants.set(plugin, { ...cfg.secrets });
  parsedOptions.set(plugin, meta.options);
  setPolicy(plugin, cfg, runtime);
  return plugin;
}

function cloneableState(st: Map<string, unknown>): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [k, v] of st) {
    try {
      out.set(k, structuredClone(v));
    } catch {
      /* not transferable into the isolated runtime */
    }
  }
  return out;
}

/** 14.3.0: permissions, failure policy and circuit-breaker settings per plugin instance. */
interface PluginPolicy {
  runtime: 'inline' | IsolatedRuntime;
  permissions?: PluginPermissions;
  failure: Partial<Record<HookName, 'open' | 'closed'>> & { default: 'open' | 'closed' };
  /** Circuit breaker (undefined = none: inline plugins without limits.maxFailures). */
  breaker?: { maxFailures: number; cooldownMs: number };
}
const policies = new WeakMap<GatewayPlugin, PluginPolicy>();

function setPolicy(p: GatewayPlugin, cfg: PluginConfig, runtime: 'inline' | IsolatedRuntime): void {
  const lim = (cfg.limits ?? {}) as ModulePluginLimits;
  const f = cfg.failure;
  const failure = typeof f === 'string' || f === undefined ? { default: f ?? 'closed' } : { default: f.default ?? 'closed', ...f };
  const breaker = runtime !== 'inline' || lim.maxFailures !== undefined ? { maxFailures: lim.maxFailures ?? 5, cooldownMs: lim.cooldownMs ?? 30_000 } : undefined;
  policies.set(p, { runtime, permissions: cfg.permissions as PluginPermissions | undefined, failure: failure as PluginPolicy['failure'], breaker });
}

const globRe = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
const matchesAny = (v: string, globs?: string[]) => !globs || globs.some((g) => globRe(g).test(v));

/** 10.5: options after `configSchema`, per plugin instance. */
const parsedOptions = new WeakMap<GatewayPlugin, Record<string, unknown>>();
/** 10.5: `plugins[].timeoutMs`, per plugin instance. */
const hookTimeouts = new WeakMap<GatewayPlugin, number>();

function contextFor(cfg: Partial<PluginConfig>): PluginContext {
  return { options: cfg.options ?? {}, logger, gatewayVersion: VERSION, apiVersion: PLUGIN_API_VERSION };
}

export class PluginError extends Error {
  constructor(
    message: string,
    readonly plugin: string,
  ) {
    super(message);
    this.name = 'PluginError';
  }
}

/** Secret grants per plugin instance (`plugins[].secrets`). */
const grants = new WeakMap<GatewayPlugin, Record<string, string>>();

/** Grant secrets to a plugin supplied in code (API v3). */
export function grantSecrets(p: GatewayPlugin, secrets: Record<string, string>): GatewayPlugin {
  grants.set(p, { ...secrets });
  return p;
}

/** The ordered set of active plugins and the hook runners. */
export class PluginHost {
  private plugins: GatewayPlugin[] = [];
  private readonly hookCtx = new WeakMap<GatewayPlugin, PluginHookContext>();

  private adminRouters = new Map<string, Router>();
  private clientRouters = new Map<string, Router>();
  private routeEnv?: PluginRouteEnv;

  constructor(private readonly env: PluginEnv = {}) {}

  /** 10.5: what plugin routes may use; (re)builds the routers. */
  setRouteEnv(env: PluginRouteEnv): void {
    this.routeEnv = env;
    this.buildRouters();
  }

  private buildRouters(): void {
    const admin = new Map<string, Router>();
    const client = new Map<string, Router>();
    const env = this.routeEnv;
    if (env) {
      for (const p of this.plugins) {
        if (!p.routes) continue;
        const ctx: PluginRouteContext = {
          plugin: p.name,
          options: parsedOptions.get(p) ?? {},
          logger,
          gatewayVersion: VERSION,
          state: this.ctxOf(p).state,
          tools: env.tools,
          invoke: (s, t, a, caller) => env.invoke(s, t, a, caller, p.name),
          clientOf: (req) => (req as Request & { clientId?: string }).clientId,
        };
        for (const [kind, build, map] of [['admin', p.routes.admin, admin], ['client', p.routes.client, client]] as const) {
          if (!build) continue;
          const r = express.Router();
          r.use(express.json({ limit: '1mb' }));
          try {
            build(r, ctx);
            map.set(p.name, r);
          } catch (err) {
            logger.error(`Plugin "${p.name}" ${kind} routes failed to build: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }
    this.adminRouters = admin;
    this.clientRouters = client;
  }

  /** 10.5: Express handler dispatching `/<plugin>/...` to that plugin's admin or client router. */
  routeHandler(kind: 'admin' | 'client') {
    return (req: Request, res: Response, next: NextFunction): void => {
      const name = req.params.plugin ?? '';
      const r = (kind === 'admin' ? this.adminRouters : this.clientRouters).get(name);
      if (!r) return void res.status(404).json({ error: 'Not Found', message: `No ${kind} routes for plugin "${name}"` });
      r(req, res, (err?: unknown) => (err ? next(err) : res.headersSent ? undefined : void res.status(404).json({ error: 'Not Found', message: `Plugin "${name}" has no route ${req.method} ${req.path}` })));
    };
  }

  /** 10.5: names of plugins with admin / client routes. */
  routeNames(): { admin: string[]; client: string[] } {
    return { admin: [...this.adminRouters.keys()], client: [...this.clientRouters.keys()] };
  }

  private ctxOf(p: GatewayPlugin, call?: PluginCall): PluginHookContext {
    let c = this.hookCtx.get(p);
    if (!c) {
      // 16.9.0: hooks see the contract the plugin declared (a v5 plugin keeps seeing 5)
      c = { plugin: p.name, logger, gatewayVersion: VERSION, apiVersion: Math.min(p.apiVersion ?? PLUGIN_API_VERSION, PLUGIN_API_VERSION) };
      if ((p.apiVersion ?? 1) >= 3) {
        const granted = grants.get(p) ?? {};
        const resolve = this.env.resolveSecret;
        c.secrets = {
          names: () => Object.keys(granted),
          get: async (name: string) => {
            const ref = granted[name];
            if (!ref) throw new Error(`Plugin "${p.name}" was not granted secret "${name}"`);
            // 14.3.0: permissions.secrets narrows the granted names
            const allowed = policies.get(p)?.permissions?.secrets;
            if (allowed && !allowed.includes(name)) throw new Error(`Plugin "${p.name}" may not read secret "${name}" (permissions.secrets)`);
            if (!resolve) throw new Error('No secret providers are available');
            return resolve(ref, p.name);
          },
        };
      }
      if ((p.apiVersion ?? 1) >= 4) c.state = createPluginState();
      this.hookCtx.set(p, c);
    }
    if (!call || (p.apiVersion ?? 1) < 3) return c;
    const tenant = this.env.tenantOf?.(call.clientId, (call as { serverId?: string }).serverId) ?? (call.tenant ? { id: call.tenant } : undefined);
    return tenant ? { ...c, tenant } : c;
  }

  /** API v3: tell every plugin a hot reload was applied. */
  async configChanged(change: PluginConfigChange): Promise<void> {
    for (const p of this.plugins) {
      if (!p.onConfigChange || !this.hookAllowed(p, 'onConfigChange')) continue;
      try {
        await p.onConfigChange(change, this.ctxOf(p));
      } catch (err) {
        logger.warn(`Plugin "${p.name}" onConfigChange failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Replace the active plugins. The dropped ones are closed — unless `close: false` (13.2.0 hot reload: calls pinned
   * to the previous config generation may still run their hooks; the gateway closes them when it retires) — and
   * returned.
   */
  async set(next: readonly GatewayPlugin[], opts: { close?: boolean } = {}): Promise<GatewayPlugin[]> {
    const old = this.plugins;
    this.plugins = [...next];
    this.buildRouters();
    const dropped = old.filter((p) => !next.includes(p));
    if (opts.close !== false) await Promise.all(dropped.map((p) => closeQuietly(p)));
    return dropped;
  }

  /** Close plugin instances that are no longer active (13.2.0: after their config generation retired). */
  static async closeAll(list: readonly GatewayPlugin[]): Promise<void> {
    await Promise.all(list.map((p) => closeQuietly(p)));
  }

  /** Build plugin instances from config entries plus embedder-supplied sources. */
  static async build(configs: PluginConfig[] | undefined, extra: PluginSource[] = [], baseDir?: string, trust?: PluginTrustConfig): Promise<GatewayPlugin[]> {
    const out: GatewayPlugin[] = [];
    try {
      for (const src of extra) {
        const p = await instantiate(src, contextFor({}), 'option');
        out.push(p);
        parsedOptions.set(p, validatePluginOptions(p, {}));
      }
      for (const cfg of configs ?? []) {
        if (cfg.enabled === false) continue;
        out.push(await loadPlugin(cfg, baseDir, trust));
      }
      const names = new Set<string>();
      for (const p of out) {
        if (names.has(p.name)) throw new Error(`Duplicate plugin name "${p.name}"`);
        names.add(p.name);
      }
    } catch (err) {
      // 13.2.0: a failed build leaves nothing running — instances built before the failure are closed.
      await Promise.all(out.map((p) => closeQuietly(p)));
      throw err;
    }
    return out;
  }

  list(): readonly GatewayPlugin[] {
    return this.plugins;
  }

  get size(): number {
    return this.plugins.length;
  }

  /** Express middleware chaining every plugin's `onRequest`. */
  middleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      const chain = this.plugins.filter((p) => p.onRequest);
      let i = 0;
      const step = (err?: unknown): void => {
        if (err) return next(err);
        const p = chain[i++];
        if (!p) return next();
        try {
          const r = p.onRequest!(req, res, step, this.ctxOf(p));
          if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(step);
        } catch (e) {
          step(e);
        }
      };
      step();
    };
  }

  // ─── 14.3.0: permissions, failure policy, circuit breaker ─────────────────
  private readonly circuits = new WeakMap<GatewayPlugin, { failures: number; state: 'closed' | 'open' | 'half-open'; openedAt?: number; lastError?: string; failOpenPasses: number; refusals: number }>();

  private circuit(p: GatewayPlugin) {
    let c = this.circuits.get(p);
    if (!c) this.circuits.set(p, (c = { failures: 0, state: 'closed', failOpenPasses: 0, refusals: 0 }));
    return c;
  }

  private hookAllowed(p: GatewayPlugin, hook: HookName): boolean {
    const hooks = policies.get(p)?.permissions?.hooks;
    return !hooks || hooks.includes(hook);
  }

  private inScope(p: GatewayPlugin, call: PluginCall): boolean {
    const perm = policies.get(p)?.permissions;
    return !perm || (matchesAny(call.serverId, perm.servers) && matchesAny(call.name, perm.tools));
  }

  /** Whether the breaker lets this call reach the plugin (`half-open` lets one trial through). */
  private admit(p: GatewayPlugin): boolean {
    const b = policies.get(p)?.breaker;
    if (!b) return true;
    const c = this.circuit(p);
    if (c.state === 'closed') return true;
    if (c.state === 'open' && Date.now() - (c.openedAt ?? 0) >= b.cooldownMs) {
      c.state = 'half-open';
      return true;
    }
    return false;
  }

  private succeeded(p: GatewayPlugin): void {
    const c = this.circuits.get(p);
    if (c && (c.failures || c.state !== 'closed')) {
      if (c.state !== 'closed') logger.info(`Plugin "${p.name}" circuit closed`);
      c.failures = 0;
      c.state = 'closed';
    }
  }

  /**
   * A hook failed (threw, crashed, timed out, hit its memory limit, was busy). Applies the breaker and the failure
   * policy: `closed` → the PluginError to throw; `open` → undefined (the call proceeds without this plugin).
   */
  private failed(p: GatewayPlugin, hook: HookName, err: unknown): PluginError | undefined {
    const msg = err instanceof Error ? err.message : String(err);
    const pol = policies.get(p);
    const c = this.circuit(p);
    c.lastError = msg;
    if (pol?.breaker && !(err instanceof PluginBusy)) {
      c.failures++;
      if (c.state === 'half-open' || c.failures >= pol.breaker.maxFailures) {
        if (c.state !== 'open') {
          logger.warn(`Plugin "${p.name}" circuit opened after ${c.failures} consecutive failure(s); retrying in ${pol.breaker.cooldownMs} ms`);
          emitOpsEvent({ kind: 'circuit-open', severity: 'error', subject: p.name, detail: `plugin circuit opened after ${c.failures} consecutive failure(s) in ${hook}: ${msg}`, source: 'plugins' });
        }
        c.state = 'open';
        c.openedAt = Date.now();
      }
    }
    const verb = err instanceof PluginCrash ? 'crashed' : 'failed';
    const policy = pol?.failure[hook] ?? pol?.failure.default ?? 'closed';
    if (policy === 'open') {
      c.failOpenPasses++;
      logger.warn(`Plugin "${p.name}" ${verb} in ${hook} (failure: open — the call proceeds without it): ${msg}`);
      return undefined;
    }
    c.refusals++;
    return new PluginError(`Plugin "${p.name}" ${verb}: ${msg}`, p.name);
  }

  /** The breaker is open: `closed` policy refuses, `open` skips the plugin. */
  private circuitOpen(p: GatewayPlugin, hook: HookName): PluginError | undefined {
    const pol = policies.get(p);
    const c = this.circuit(p);
    if ((pol?.failure[hook] ?? pol?.failure.default ?? 'closed') === 'open') {
      c.failOpenPasses++;
      return undefined;
    }
    c.refusals++;
    return new PluginError(`Plugin "${p.name}" is unavailable: circuit open after ${c.failures} consecutive failure(s) (last: ${c.lastError ?? 'unknown'})`, p.name);
  }

  /** 14.3.0: runtime, breaker and permission state of every active plugin (`GET /api/v1/plugins`). */
  status(): Array<{ name: string; runtime: string; circuit: 'closed' | 'open' | 'half-open'; failures: number; failure: string; lastError?: string; failOpenPasses: number; refusals: number; restarts?: number; alive?: boolean; inFlight?: number; lastCrash?: string; permissions?: PluginPermissions }> {
    return this.plugins.map((p) => {
      const pol = policies.get(p);
      const c = this.circuits.get(p);
      let circuit = c?.state ?? 'closed';
      if (circuit === 'open' && pol?.breaker && Date.now() - (c?.openedAt ?? 0) >= pol.breaker.cooldownMs) circuit = 'half-open';
      const rs = (p as { runtimeStats?: () => { restarts: number; alive: boolean; inFlight: number; lastCrash?: string } }).runtimeStats?.();
      const f = pol?.failure;
      return {
        name: p.name,
        runtime: pluginRuntimeOf(p),
        circuit,
        failures: c?.failures ?? 0,
        failure: !f ? 'closed' : Object.keys(f).length > 1 ? JSON.stringify(f) : f.default,
        ...(c?.lastError ? { lastError: c.lastError } : {}),
        failOpenPasses: c?.failOpenPasses ?? 0,
        refusals: c?.refusals ?? 0,
        ...(rs ? { restarts: rs.restarts, alive: rs.alive, inFlight: rs.inFlight, ...(rs.lastCrash ? { lastCrash: rs.lastCrash } : {}) } : {}),
        ...(pol?.permissions ? { permissions: pol.permissions } : {}),
      };
    });
  }

  /** Run `onToolCall` hooks. Returns a refusal / short-circuit or undefined to proceed. */
  async beforeCall(call: PluginCall, plugins: readonly GatewayPlugin[] = this.plugins): Promise<{ deny: string; plugin: string } | { respond: unknown; plugin: string } | undefined> {
    for (const p of plugins) {
      if (!p.onToolCall || !this.hookAllowed(p, 'onToolCall') || !this.inScope(p, call)) continue;
      if (!this.admit(p)) {
        const e = this.circuitOpen(p, 'onToolCall');
        if (e) throw e;
        continue;
      }
      const readOnly = policies.get(p)?.permissions?.args === 'read';
      const snapshot = readOnly ? structuredCloneSafe(call.arguments) : undefined;
      let out: ToolCallOutcome;
      try {
        const raw = await withTimeout(p, 'onToolCall', hookTimeouts.get(p), () => p.onToolCall!(call, this.ctxOf(p, call)));
        if (pluginRuntimeOf(p) === 'inline') checkOutcome(p, 'onToolCall', raw); // isolated plugins are checked in their proxy
        out = normalizeToolCallOutcome(raw);
        this.succeeded(p);
      } catch (err) {
        if (snapshot) call.arguments = snapshot;
        const e = this.failed(p, 'onToolCall', err);
        if (e) throw e;
        continue;
      }
      if (snapshot && !isDeepStrictEqual(call.arguments, snapshot)) {
        logger.warn(`Plugin "${p.name}" changed the arguments in place but has permissions.args: read — change dropped`);
        call.arguments = snapshot;
      }
      if (!out) continue;
      if ('deny' in out && typeof out.deny === 'string') return { deny: out.deny, plugin: p.name };
      if ('respond' in out && out.respond !== undefined) return { respond: out.respond, plugin: p.name };
      if ('arguments' in out && out.arguments) {
        if (readOnly) logger.warn(`Plugin "${p.name}" tried to rewrite the arguments of ${call.serverId}/${call.name} but has permissions.args: read — rewrite dropped`);
        else call.arguments = out.arguments;
      }
    }
    return undefined;
  }

  /** Run `onResponse` hooks (in order, each sees the previous result). */
  async afterCall(call: PluginCall, result: ProxyResponse, plugins: readonly GatewayPlugin[] = this.plugins): Promise<ProxyResponse> {
    let current = result;
    for (const p of plugins) {
      if (!p.onResponse || !this.hookAllowed(p, 'onResponse') || !this.inScope(p, call)) continue;
      if (!this.admit(p)) {
        const e = this.circuitOpen(p, 'onResponse');
        if (e) throw e;
        continue;
      }
      let next: ProxyResponse | undefined;
      try {
        const raw = await withTimeout(p, 'onResponse', hookTimeouts.get(p), () => p.onResponse!(call, current, this.ctxOf(p, call)));
        if (pluginRuntimeOf(p) === 'inline') checkOutcome(p, 'onResponse', raw);
        next = normalizeResponseOutcome(raw, current);
        this.succeeded(p);
      } catch (err) {
        const e = this.failed(p, 'onResponse', err);
        if (e) throw e;
        continue;
      }
      if (next && policies.get(p)?.permissions?.response === 'read') {
        logger.warn(`Plugin "${p.name}" tried to replace the result of ${call.serverId}/${call.name} but has permissions.response: read — replacement dropped`);
        continue;
      }
      if (next) current = next;
    }
    if (!current.success) {
      const error = { code: current.error?.code, message: current.error?.message ?? 'Call failed' };
      for (const p of plugins) {
        if (!p.onError || !this.hookAllowed(p, 'onError') || !this.inScope(p, call) || !this.admit(p)) continue;
        try {
          await p.onError(call, error, this.ctxOf(p, call));
        } catch (err) {
          logger.warn(`Plugin "${p.name}" onError failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return current;
  }

  async close(): Promise<void> {
    const old = this.plugins;
    this.plugins = [];
    this.buildRouters();
    await Promise.all(old.map((p) => closeQuietly(p)));
  }
}

function structuredCloneSafe<T>(v: T): T {
  try {
    return structuredClone(v);
  } catch {
    return JSON.parse(JSON.stringify(v)) as T;
  }
}

async function closeQuietly(p: GatewayPlugin): Promise<void> {
  try {
    await p.close?.();
  } catch (err) {
    logger.warn(`Plugin "${p.name}" close failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
