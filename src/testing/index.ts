/**
 * `@winstonsayno/mcp-gateway/testing` (15.2.0-canary.1): test helpers for plugin authors. Framework-free — use them
 * from `node:test`, vitest, jest or mocha.
 *
 * - {@link startPluginHarness} loads one `plugins[]` entry exactly like the gateway (signature check against
 *   `pluginTrust`, isolated `worker` / `process` runtime, permissions, limits, failure mode) and drives its hooks;
 *   `update()` / `unload()` behave like a config hot reload, `crash()` kills the runtime as an OOM kill would.
 * - {@link toolCall} / {@link toolResponse} build hook inputs; {@link createTestSigningKey} / {@link signPluginFile}
 *   sign a plugin file and give the matching `pluginTrust`.
 * - The compatibility matrix ({@link pluginApiSupport}) answers which gateway versions load a plugin API version.
 *
 * Additive: a new package export; nothing in the package root or the other entry points changes.
 *
 * ```js
 * import { startPluginHarness } from '@winstonsayno/mcp-gateway/testing';
 * const h = await startPluginHarness({ module: './my-plugin.mjs', runtime: 'worker' }, { baseDir: import.meta.dirname });
 * assert.equal((await h.callTool('rm')).action, 'deny');
 * await h.close();
 * ```
 *
 * @module testing
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { PluginHost, PluginError, pluginRuntimeOf, PLUGIN_API_VERSION, PLUGIN_API_MIN_VERSION, type GatewayPlugin, type PluginCall } from '../plugins/index.js';
import { RUNTIME_KILL } from '../plugins/runtime.js';
import { generateSigningKey, signArtifact, verifyArtifact, verifyReproducible, sha256Hex, type PluginSignature } from '../plugins/trust.js';
import type { PluginTrustConfig } from '../plugins/trust-schema.js';
import type { PluginConfig, ProxyResponse } from '../utils/types.js';

export { PLUGIN_API_VERSION, PLUGIN_API_MIN_VERSION, generateSigningKey, signArtifact, verifyArtifact, verifyReproducible, sha256Hex };
export type { PluginSignature, PluginTrustConfig, PluginConfig, PluginCall, ProxyResponse, GatewayPlugin };
export { PLUGIN_COMPATIBILITY, pluginApiSupport, isPluginApiSupported, compatibilityMarkdown, type PluginCompatRow } from '../plugins/compat.js';

/** A `tools/call` hook input (defaults: server `test`, via `mcp`, empty arguments, fresh state). */
export function toolCall(name: string, args: Record<string, unknown> = {}, over: Partial<Omit<PluginCall, 'state'>> = {}): PluginCall {
  return { serverId: 'test', name, kind: 'tool', method: 'tools/call', arguments: args, via: 'mcp', ...over, state: new Map() };
}

/** An upstream response for `onResponse` (success unless `error` is given). */
export function toolResponse(result: unknown = { content: [] }, error?: { code: number; message: string }): ProxyResponse {
  return error ? { success: false, error, durationMs: 1 } : { success: true, result, durationMs: 1 };
}

/** A throwaway Ed25519 signing key for tests. */
export interface TestSigningKey {
  id: string;
  publicKey: string;
  privateKey: string;
  /** A `pluginTrust` section trusting this key (merge in `requireSigned` etc.). */
  trust(extra?: Partial<Omit<PluginTrustConfig, 'keys'>>): PluginTrustConfig;
}

export function createTestSigningKey(id = 'test-key'): TestSigningKey {
  const k = generateSigningKey();
  return { id, ...k, trust: (extra = {}) => ({ ...extra, keys: [{ id, publicKey: k.publicKey }] }) };
}

/** Sign a plugin file the way `mcp-gateway plugin sign` does (writes `<file>.sig`) and return the signature. */
export function signPluginFile(file: string, key: Pick<TestSigningKey, 'id' | 'privateKey'>): PluginSignature {
  const sig = signArtifact(readFileSync(file), key.privateKey, key.id);
  writeFileSync(`${file}.sig`, JSON.stringify(sig, null, 2) + '\n');
  return sig;
}

/** What the gateway does with a call after the plugin's `onToolCall`. */
export type HookOutcome =
  | { action: 'continue'; arguments: Record<string, unknown> }
  | { action: 'deny'; reason: string }
  | { action: 'respond'; result: unknown }
  /** The hook failed (throw, crash, timeout, open circuit) and `failure: closed` refused the call. */
  | { action: 'refused'; error: string };

export interface HarnessOptions {
  /** Directory relative module paths resolve against (the config file's directory in the gateway). */
  baseDir?: string;
  /** `pluginTrust` the entry is checked against. */
  trust?: PluginTrustConfig;
}

type HostStatus = ReturnType<PluginHost['status']>[number];

/** One plugin entry loaded the way the gateway loads it. */
export interface PluginHarness {
  /** The loaded plugin (undefined after `unload()`). */
  readonly plugin: GatewayPlugin | undefined;
  /** Where it runs: `worker`, `process`, `inline` or `wasm`. */
  readonly runtime: ReturnType<typeof pluginRuntimeOf> | undefined;
  /** Run the `onToolCall` hooks for one tool call. */
  callTool(name: string, args?: Record<string, unknown>, over?: Partial<Omit<PluginCall, 'state'>>): Promise<HookOutcome>;
  /** Run `onResponse` / `onError` for a call and an upstream response; returns what the client would get. */
  respond(call: PluginCall, response: ProxyResponse): Promise<ProxyResponse>;
  /** The gateway's view of the plugin (circuit, failures, restarts, alive …) — `GET /api/v1/plugins`. */
  status(): HostStatus | undefined;
  /**
   * Reload like a config hot reload: re-read and re-verify the module (optionally a changed entry / trust). On failure
   * it throws and the current plugin keeps running — exactly what the gateway does.
   */
  update(next?: { entry?: PluginConfig; trust?: PluginTrustConfig }): Promise<void>;
  /** Remove the plugin (as removing its `plugins[]` entry does); its runtime is closed. */
  unload(): Promise<void>;
  /** Kill the isolated runtime as an OOM kill / segfault would; the next call starts a fresh one. */
  crash(): Promise<void>;
  close(): Promise<void>;
}

/** Load one `plugins[]` entry like the gateway and return a harness around it. */
export async function startPluginHarness(entry: PluginConfig, opts: HarnessOptions = {}): Promise<PluginHarness> {
  const baseDir = opts.baseDir ?? process.cwd();
  let current = { entry, trust: opts.trust };
  const host = new PluginHost();
  // Isolated runtimes are unref'd (they never keep a gateway process alive). A test process has nothing else keeping
  // its event loop running while it waits for a hook reply, so the harness holds it open until close().
  const keepAlive = setInterval(() => {}, 1 << 30);
  try {
    await host.set(await PluginHost.build([entry], [], baseDir, opts.trust));
  } catch (e) {
    clearInterval(keepAlive);
    throw e;
  }
  const only = (): GatewayPlugin | undefined => host.list()[0];
  return {
    get plugin() {
      return only();
    },
    get runtime() {
      const p = only();
      return p ? pluginRuntimeOf(p) : undefined;
    },
    async callTool(name, args = {}, over = {}) {
      const call = toolCall(name, args, over);
      try {
        const r = await host.beforeCall(call);
        if (!r) return { action: 'continue', arguments: call.arguments };
        if ('deny' in r) return { action: 'deny', reason: r.deny };
        return { action: 'respond', result: r.respond };
      } catch (e) {
        if (e instanceof PluginError) return { action: 'refused', error: e.message };
        throw e;
      }
    },
    respond(call, response) {
      return host.afterCall(call, response);
    },
    status() {
      return host.status()[0];
    },
    async update(next = {}) {
      const target = { entry: next.entry ?? current.entry, trust: 'trust' in next ? next.trust : current.trust };
      const built = await PluginHost.build([target.entry], [], baseDir, target.trust);
      await host.set(built);
      current = target;
    },
    async unload() {
      await host.set([]);
    },
    async crash() {
      const p = only() as (GatewayPlugin & { [RUNTIME_KILL]?: () => Promise<void> }) | undefined;
      if (!p?.[RUNTIME_KILL]) throw new Error('crash() needs a plugin in an isolated runtime (runtime: worker | process)');
      await p[RUNTIME_KILL]();
    },
    async close() {
      clearInterval(keepAlive);
      await host.close();
    },
  };
}
