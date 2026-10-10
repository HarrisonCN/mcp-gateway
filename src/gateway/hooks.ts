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
import { FEATURE_MANIFEST, failurePolicyOf, hookOwner, manifestEntry, type FailurePolicy } from '../features/manifest.js';
import { loadFailureOf } from './kernel-runtime.js';
import { failureScopeOf, type FailureScope, type ScopeCall } from './failure-scope.js';

export interface HookCall {
  serverId: string;
  tool: string;
  clientId?: string;
  /** First tenant of the caller, when tenants are configured. */
  tenant?: string;
  args: Record<string, unknown>;
  /** Who the call is made for (11.1), already authorized by the central authorizer. */
  principal?: import('../auth/authorizer.js').Principal;
  /**
   * Upstream server the call goes to once routing splits are applied (13.1.1). Caches key on it, so split targets never
   * share entries. Absent outside the invoker (tests, plugins): use `serverId`.
   */
  routedTo?: () => string;
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

const callHooksList: CallHook[] = [];
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
  const i = callHooksList.findIndex((x) => x.id === h.id);
  if (i >= 0) {
    callHooksList[i] = h;
    return;
  }
  if (opts.first) firsts.add(h.id);
  const r = rank(h.id);
  const at = callHooksList.findIndex((x) => rank(x.id) > r);
  if (at < 0) callHooksList.push(h);
  else callHooksList.splice(at, 0, h);
}

/** Failure lookup of one gateway's kernel (runtime or load failure of a module id). */
export type FailureLookup = (id: string) => string | undefined;

/** A failed module and what its failure policy did to the call (13.1). */
export interface FailedHookModule {
  id: string;
  policy: FailurePolicy;
  error: string;
  /**
   * Calls the module would have governed (13.1.1), from its own config (servers / tools / tenants / clients / agent
   * calls). `undefined` = global: every tool call (also when the scope cannot be determined).
   */
  scope?: FailureScope;
}

/** Failed `closed` modules that govern `call` (13.1.1): a module refuses only the calls in its failure scope. */
export function closedFor(plan: CallHookPlan, call: ScopeCall): FailedHookModule[] {
  return plan.closed.filter((m) => !m.scope || m.scope.matches(call));
}

/** What the call pipeline runs under `cfg` (13.1). */
export interface CallHookPlan {
  /** Hooks of active, healthy modules (and unknown hooks, e.g. plugins), in pipeline order. */
  hooks: readonly CallHook[];
  /** Active modules with failure policy `closed` that failed or are not ready: calls in their failure scope are refused (13.1.1). */
  closed: FailedHookModule[];
  /** Active modules with failure policy `degrade` that failed: hooks skipped, results marked degraded. */
  degraded: FailedHookModule[];
  /** Active modules with failure policy `open` that failed: hooks skipped. */
  open: FailedHookModule[];
}

/**
 * The call-hook plan of a gateway under `cfg` (13.1). A hook runs while its module is active (10.9 lazy activation)
 * and healthy. A module that is active but failed — load, init, reconfigure, a failed dependency, or a hook module
 * whose hook never registered — is handled by its failure policy ({@link failurePolicyOf}): security modules are
 * `closed` (the caller refuses the call), analytics `open`, presentation `degrade`. 13.0 skipped every failed
 * module's hooks (fail-open).
 */
export function callHookPlan(cfg: GatewayConfig, failure: FailureLookup = loadFailureOf): CallHookPlan {
  const plan: CallHookPlan = { hooks: [], closed: [], degraded: [], open: [] };
  const add = (id: string, policy: FailurePolicy, error: string) => {
    const list = policy === 'closed' ? plan.closed : policy === 'degrade' ? plan.degraded : plan.open;
    if (list.some((x) => x.id === id)) return;
    const scope = policy === 'closed' ? failureScopeOf(id, cfg) : undefined;
    list.push({ id, policy, error, ...(scope ? { scope } : {}) });
  };
  const hooks: CallHook[] = [];
  for (const h of callHooksList) {
    const owner = hookOwner(h.id) ?? h.id;
    if (!isFeatureActive(cfg, owner)) continue;
    const f = failure(owner);
    if (!f) hooks.push(h);
    else add(owner, failurePolicyOf(owner, cfg, !!h.before), f);
  }
  // Manifest hook modules that are active but whose hook is not registered: the module failed before it could
  // register (load / dependency failure) — never a silent bypass.
  for (const e of FEATURE_MANIFEST) {
    if (!e.hook || !isFeatureActive(cfg, e.id)) continue;
    if (e.hookWhen && cfg[e.hookWhen] === undefined) continue;
    if (callHooksList.some((h) => h.id === e.hook)) continue;
    const f = failure(e.id);
    if (f) add(e.id, failurePolicyOf(e.id, cfg), f);
  }
  plan.hooks = hooks;
  return plan;
}

/** Hooks of active, healthy feature modules under `cfg` (see {@link callHookPlan} for failed modules). */
export function activeCallHooks(cfg: GatewayConfig, failure: FailureLookup = loadFailureOf): readonly CallHook[] {
  return callHookPlan(cfg, failure).hooks;
}

/** Whether a hook id belongs to a security guard module (re-evaluated against the final target after a reroute, 13.1). */
export const isGuardHook = (hookId: string): boolean => {
  const owner = hookOwner(hookId);
  return !!owner && manifestEntry(owner)?.guard === true;
};

export function callHooks(): readonly CallHook[] {
  return callHooksList;
}
