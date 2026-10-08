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

export interface HookCall {
  serverId: string;
  tool: string;
  clientId?: string;
  /** First tenant of the caller, when tenants are configured. */
  tenant?: string;
  args: Record<string, unknown>;
}

/** `serverId` (7.5) routes the call to another upstream (operator-configured, e.g. a canary). `respond` (7.4) answers the call without the upstream (e.g. a cache hit); later `before` hooks are skipped, `after` hooks still run. */
export type BeforeOutcome = void | { args?: Record<string, unknown>; refuse?: { code: number; message: string; data?: Record<string, unknown> }; respond?: ProxyResponse; serverId?: string };

export interface CallHook {
  id: string;
  before?: (call: HookCall, cfg: GatewayConfig) => BeforeOutcome | Promise<BeforeOutcome>;
  after?: (call: HookCall, result: ProxyResponse, cfg: GatewayConfig) => ProxyResponse | void | Promise<ProxyResponse | void>;
}

const hooks: CallHook[] = [];

/** Register (or replace by id) a call hook. */
export function registerCallHook(h: CallHook): void {
  const i = hooks.findIndex((x) => x.id === h.id);
  if (i >= 0) hooks[i] = h;
  else hooks.push(h);
}

export function callHooks(): readonly CallHook[] {
  return hooks;
}
