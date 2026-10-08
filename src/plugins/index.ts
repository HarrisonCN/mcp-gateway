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
 * Hooks run in configuration order; the first refusal / short-circuit wins.
 * A hook that throws fails the call (`-32006`) — plugins fail closed.
 *
 * @module plugins
 */

import { isAbsolute, resolve } from 'path';
import { pathToFileURL } from 'url';
import { readFile } from 'fs/promises';
import { PluginTrustSchema, verifyArtifact, type PluginTrustConfig } from './trust.js';
import type { NextFunction, Request, Response } from 'express';
import type { PluginConfig, ProxyResponse } from '../utils/types.js';
import { logger, type Logger } from '../utils/logger.js';
import { VERSION } from '../utils/version.js';

/** Version of the plugin contract implemented by this gateway. */
export const PLUGIN_API_VERSION = 5;

/** Oldest plugin contract still loaded (8.0: v5 only). */
export const PLUGIN_API_MIN_VERSION = 5;

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
  tenantOf?: (clientId: string | undefined) => PluginTenant | undefined;
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
    throw new Error(`Plugin "${value.name}" uses plugin API v1, which was removed in 4.0 — declare \`apiVersion: 5\` (hooks receive a context argument; see docs/guides/migrating-to-v4.md)`);
  }
  if (v === 2) {
    throw new Error(`Plugin "${value.name}" uses plugin API v2, which was removed in 5.0 — declare \`apiVersion: 5\` (see docs/guides/migrating-to-v5.md)`);
  }
  if (v === 3) {
    throw new Error(`Plugin "${value.name}" uses plugin API v3, which was removed in 6.0 — declare \`apiVersion: 5\` (adds ctx.state; see docs/guides/migrating-to-v6.md)`);
  }
  if (v === 4) {
    throw new Error(`Plugin "${value.name}" uses plugin API v4, which was removed in 8.0 — declare \`apiVersion: 5\` (hooks may return \`{ action }\` outcomes; see docs/guides/migrating-to-v8.md)`);
  }
  if (v < PLUGIN_API_MIN_VERSION) throw new Error(`Plugin "${value.name}" declares unsupported plugin API v${v}`);
  return value;
}

/** 5.4: verify a plugin's `.sig` against `pluginTrust` (throws when it must not load). */
export async function checkSignature(cfg: PluginConfig, baseDir: string, trust?: PluginTrustConfig): Promise<string | undefined> {
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
  const r = verifyArtifact(await readFile(file), sig, t.keys);
  if (!r.ok) throw new Error(`Plugin "${label}" failed signature verification: ${r.reason}`);
  return r.keyId;
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
  await checkSignature(cfg, baseDir, trust);
  if (cfg.component) {
    const { loadWasmPlugin } = await import('./wasm.js');
    return loadWasmPlugin({ wasm: cfg.component, name: cfg.name, isolation: cfg.isolation, limits: cfg.limits, abi: 'component' }, baseDir);
  }
  if ((cfg as { wasm?: unknown }).wasm !== undefined) throw new Error('`plugins[].wasm` was removed in 8.0 — rebuild the plugin as a plugin API v5 component and load it with `component`');
  if (!cfg.module) throw new Error('A plugin needs "module" or "component"');
  const spec = cfg.module;
  const isPath = spec.startsWith('.') || isAbsolute(spec);
  const target = isPath ? pathToFileURL(resolve(baseDir, spec)).href : spec;
  const mod = (await import(target)) as Record<string, unknown>;
  const exported = mod.default ?? mod.plugin ?? mod;
  const plugin = await instantiate(exported, contextFor(cfg), spec);
  const out = cfg.name ? { ...plugin, name: cfg.name, close: plugin.close?.bind(plugin) } : plugin;
  if (cfg.secrets) grants.set(out, { ...cfg.secrets });
  return out;
}

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

  constructor(private readonly env: PluginEnv = {}) {}

  private ctxOf(p: GatewayPlugin, call?: PluginCall): PluginHookContext {
    let c = this.hookCtx.get(p);
    if (!c) {
      c = { plugin: p.name, logger, gatewayVersion: VERSION, apiVersion: PLUGIN_API_VERSION };
      if ((p.apiVersion ?? 1) >= 3) {
        const granted = grants.get(p) ?? {};
        const resolve = this.env.resolveSecret;
        c.secrets = {
          names: () => Object.keys(granted),
          get: async (name: string) => {
            const ref = granted[name];
            if (!ref) throw new Error(`Plugin "${p.name}" was not granted secret "${name}"`);
            if (!resolve) throw new Error('No secret providers are available');
            return resolve(ref, p.name);
          },
        };
      }
      if ((p.apiVersion ?? 1) >= 4) c.state = createPluginState();
      this.hookCtx.set(p, c);
    }
    if (!call || (p.apiVersion ?? 1) < 3) return c;
    const tenant = this.env.tenantOf?.(call.clientId) ?? (call.tenant ? { id: call.tenant } : undefined);
    return tenant ? { ...c, tenant } : c;
  }

  /** API v3: tell every plugin a hot reload was applied. */
  async configChanged(change: PluginConfigChange): Promise<void> {
    for (const p of this.plugins) {
      if (!p.onConfigChange) continue;
      try {
        await p.onConfigChange(change, this.ctxOf(p));
      } catch (err) {
        logger.warn(`Plugin "${p.name}" onConfigChange failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Replace the active plugins (closes the ones that are dropped). */
  async set(next: GatewayPlugin[]): Promise<void> {
    const old = this.plugins;
    this.plugins = next;
    await Promise.all(old.filter((p) => !next.includes(p)).map((p) => closeQuietly(p)));
  }

  /** Build plugin instances from config entries plus embedder-supplied sources. */
  static async build(configs: PluginConfig[] | undefined, extra: PluginSource[] = [], baseDir?: string, trust?: PluginTrustConfig): Promise<GatewayPlugin[]> {
    const out: GatewayPlugin[] = [];
    for (const src of extra) out.push(await instantiate(src, contextFor({}), 'option'));
    for (const cfg of configs ?? []) {
      if (cfg.enabled === false) continue;
      out.push(await loadPlugin(cfg, baseDir, trust));
    }
    const names = new Set<string>();
    for (const p of out) {
      if (names.has(p.name)) throw new Error(`Duplicate plugin name "${p.name}"`);
      names.add(p.name);
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

  /** Run `onToolCall` hooks. Returns a refusal / short-circuit or undefined to proceed. */
  async beforeCall(call: PluginCall): Promise<{ deny: string; plugin: string } | { respond: unknown; plugin: string } | undefined> {
    for (const p of this.plugins) {
      if (!p.onToolCall) continue;
      let out: ToolCallOutcome;
      try {
        out = await p.onToolCall(call, this.ctxOf(p, call));
      } catch (err) {
        throw new PluginError(`Plugin "${p.name}" failed: ${err instanceof Error ? err.message : String(err)}`, p.name);
      }
      out = normalizeToolCallOutcome(out);
      if (!out) continue;
      if ('deny' in out && typeof out.deny === 'string') return { deny: out.deny, plugin: p.name };
      if ('respond' in out && out.respond !== undefined) return { respond: out.respond, plugin: p.name };
      if ('arguments' in out && out.arguments) call.arguments = out.arguments;
    }
    return undefined;
  }

  /** Run `onResponse` hooks (in order, each sees the previous result). */
  async afterCall(call: PluginCall, result: ProxyResponse): Promise<ProxyResponse> {
    let current = result;
    for (const p of this.plugins) {
      if (!p.onResponse) continue;
      try {
        const next = normalizeResponseOutcome(await p.onResponse(call, current, this.ctxOf(p, call)), current);
        if (next) current = next;
      } catch (err) {
        throw new PluginError(`Plugin "${p.name}" failed: ${err instanceof Error ? err.message : String(err)}`, p.name);
      }
    }
    if (!current.success) {
      const error = { code: current.error?.code, message: current.error?.message ?? 'Call failed' };
      for (const p of this.plugins) {
        if (!p.onError) continue;
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
    await Promise.all(old.map((p) => closeQuietly(p)));
  }
}

async function closeQuietly(p: GatewayPlugin): Promise<void> {
  try {
    await p.close?.();
  } catch (err) {
    logger.warn(`Plugin "${p.name}" close failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
