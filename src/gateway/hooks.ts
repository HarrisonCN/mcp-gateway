/**
 * Call hooks (5.6): feature modules that inspect or transform tool calls inside the invoker pipeline.
 *
 * `before` runs after policy / residency / PII-on-arguments and may rewrite the arguments or refuse the call;
 * `after` runs on the upstream result after the output filter and PII-on-results and may rewrite it or turn it
 * into an error. Hooks run in registration order; each sees the gateway config.
 *
 * @module gateway/hooks
 */

import type { GatewayConfig, ProxyResponse } from '../utils/types.js';
import { isFeatureActive } from './features.js';
import { FEATURE_MANIFEST, hookOwner } from '../features/manifest.js';
import { failureOf } from './kernel-runtime.js';

export interface HookCall {
  serverId: string;
  tool: string;
  clientId?: string;
  /** First tenant of the caller, when tenants are configured. */
  tenant?: string;
  args: Record<string, unknown>;
  /** Who the call is made for (11.1), already authorized by the central authorizer. */
  principal?: import('../auth/authorizer.js').Principal;
}

/** `serverId` (7.5) routes the call to another upstream (operator-configured, e.g. a canary). `respond` (7.4) answers the call without the upstream (e.g. a cache hit); later `before` hooks are skipped, `after` hooks still run. */
export type BeforeOutcome = void | { args?: Record<string, unknown>; refuse?: { code: number; message: string; data?: Record<string, unknown> }; respond?: ProxyResponse; serverId?: string };

export interface CallHook {
  id: string;
  before?: (call: HookCall, cfg: GatewayConfig) => BeforeOutcome | Promise<BeforeOutcome>;
  after?: (call: HookCall, result: ProxyResponse, cfg: GatewayConfig) => ProxyResponse | void | Promise<ProxyResponse | void>;
  /** Observe a tool call the gateway refused without contacting the upstream (policy, quota, budget, hook refusal) (10.6). Must not throw. */
  refused?: (call: HookCall, error: { code: number; message: string; data?: Record<string, unknown> }, cfg: GatewayConfig) => void;
}

const hooks: CallHook[] = [];
const firsts = new Set<string>();

/**
 * Pipeline position of a hook (13.0): modules are evaluated on demand, so registration order no longer says anything;
 * built-in hooks run in manifest order, `first` hooks ahead of them, unknown hooks (plugins, tests) after them in
 * registration order.
 */
const rank = (id: string): number => {
  if (firsts.has(id)) return -1;
  const owner = hookOwner(id);
  const i = owner ? FEATURE_MANIFEST.findIndex((e) => e.id === owner) : -1;
  return i >= 0 ? i : FEATURE_MANIFEST.length;
};

/** Register (or replace by id) a call hook. `first` puts a new hook ahead of the others (10.7: edge autonomy). */
export function registerCallHook(h: CallHook, opts: { first?: boolean } = {}): void {
  const i = hooks.findIndex((x) => x.id === h.id);
  if (i >= 0) {
    hooks[i] = h;
    return;
  }
  if (opts.first) firsts.add(h.id);
  const r = rank(h.id);
  const at = hooks.findIndex((x) => rank(x.id) > r);
  if (at < 0) hooks.push(h);
  else hooks.splice(at, 0, h);
}

/**
 * Hooks of active feature modules under `cfg` (10.9 lazy activation; hooks of unknown ids, e.g. plugins, always
 * run). 13.0: hooks of a module that failed (load, init, reconfigure or a failed dependency) are skipped.
 */
export function activeCallHooks(cfg: GatewayConfig): readonly CallHook[] {
  return hooks.filter((h) => {
    const owner = hookOwner(h.id) ?? h.id;
    return isFeatureActive(cfg, owner) && !failureOf(owner);
  });
}

export function callHooks(): readonly CallHook[] {
  return hooks;
}
