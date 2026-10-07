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
 * `apiVersion: 2`. Plugins without `apiVersion` (v1) still load with a deprecation warning; v1 is removed in 4.0.
 *
 * Hooks run in configuration order; the first refusal / short-circuit wins.
 * A hook that throws fails the call (`-32006`) — plugins fail closed.
 *
 * @module plugins
 */

import { DEPRECATIONS, deprecate } from '../utils/deprecations.js';
import { isAbsolute, resolve } from 'path';
import { pathToFileURL } from 'url';
import type { NextFunction, Request, Response } from 'express';
import type { PluginConfig, ProxyResponse } from '../utils/types.js';
import { logger, type Logger } from '../utils/logger.js';
import { VERSION } from '../utils/version.js';

/** Version of the plugin contract implemented by this gateway. */
export const PLUGIN_API_VERSION = 2;

/** Oldest plugin contract still loaded (with a deprecation warning). */
export const PLUGIN_API_MIN_VERSION = 1;

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
}

export interface PluginCallError {
  code?: number;
  message: string;
}

export interface GatewayPlugin {
  name: string;
  /** Plugin contract version the plugin was written for (default 1 — deprecated; declare 2). */
  apiVersion?: number;
  onRequest?: (req: Request, res: Response, next: NextFunction, ctx: PluginHookContext) => void | Promise<void>;
  onToolCall?: (call: PluginCall, ctx: PluginHookContext) => ToolCallOutcome | Promise<ToolCallOutcome>;
  onResponse?: (call: PluginCall, result: ProxyResponse, ctx: PluginHookContext) => ProxyResponse | void | Promise<ProxyResponse | void>;
  /** API v2: observe failed calls (after `onResponse`). Never changes the result. */
  onError?: (call: PluginCall, error: PluginCallError, ctx: PluginHookContext) => void | Promise<void>;
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
  if (v < PLUGIN_API_MIN_VERSION) throw new Error(`Plugin "${value.name}" declares unsupported plugin API v${v}`);
  if (v < 2) deprecate(DEPRECATIONS.pluginApiV1, `plugin "${value.name}"`);
  return value;
}

/** Load one configured plugin (`module` is a path relative to `baseDir`, or a package name). */
export async function loadPlugin(cfg: PluginConfig, baseDir = process.cwd()): Promise<GatewayPlugin> {
  const spec = cfg.module;
  const isPath = spec.startsWith('.') || isAbsolute(spec);
  const target = isPath ? pathToFileURL(resolve(baseDir, spec)).href : spec;
  const mod = (await import(target)) as Record<string, unknown>;
  const exported = mod.default ?? mod.plugin ?? mod;
  const plugin = await instantiate(exported, contextFor(cfg), spec);
  return cfg.name ? { ...plugin, name: cfg.name, close: plugin.close?.bind(plugin) } : plugin;
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

const hookCtx = new WeakMap<GatewayPlugin, PluginHookContext>();
function ctxOf(p: GatewayPlugin): PluginHookContext {
  let c = hookCtx.get(p);
  if (!c) {
    c = { plugin: p.name, logger, gatewayVersion: VERSION, apiVersion: PLUGIN_API_VERSION };
    hookCtx.set(p, c);
  }
  return c;
}

/** The ordered set of active plugins and the hook runners. */
export class PluginHost {
  private plugins: GatewayPlugin[] = [];

  /** Replace the active plugins (closes the ones that are dropped). */
  async set(next: GatewayPlugin[]): Promise<void> {
    const old = this.plugins;
    this.plugins = next;
    await Promise.all(old.filter((p) => !next.includes(p)).map((p) => closeQuietly(p)));
  }

  /** Build plugin instances from config entries plus embedder-supplied sources. */
  static async build(configs: PluginConfig[] | undefined, extra: PluginSource[] = [], baseDir?: string): Promise<GatewayPlugin[]> {
    const out: GatewayPlugin[] = [];
    for (const src of extra) out.push(await instantiate(src, contextFor({}), 'option'));
    for (const cfg of configs ?? []) {
      if (cfg.enabled === false) continue;
      out.push(await loadPlugin(cfg, baseDir));
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
          const r = p.onRequest!(req, res, step, ctxOf(p));
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
        out = await p.onToolCall(call, ctxOf(p));
      } catch (err) {
        throw new PluginError(`Plugin "${p.name}" failed: ${err instanceof Error ? err.message : String(err)}`, p.name);
      }
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
        const next = await p.onResponse(call, current, ctxOf(p));
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
          await p.onError(call, error, ctxOf(p));
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
