/**
 * Per-instance module state (14.0.0, core architecture v2; fixes 13.4.0 finding F3).
 *
 * Up to 13.x feature modules kept their state in module-level singletons (`export const flowQueue = new FlowQueue()`),
 * shared by every `Gateway` in a process and kept across a module's disable / re-enable. 14.0 gives each gateway an
 * {@link InstanceScope}; module state declared with {@link instanceLocal} lives in the scope of the gateway the code
 * runs for, and the kernel drops a module's state when the module is disabled or disposed.
 *
 * The scope travels with the async context (`AsyncLocalStorage`): the gateway enters it for every HTTP request, its
 * start / reload / stop and the timers its modules start. Code outside any gateway (unit tests, CLI tools, an
 * embedder calling a module helper directly) uses the process scope — the 13.x behaviour.
 *
 * `instanceLocal` returns a proxy, so existing call sites (`flowQueue.list()`, `meters.get(k)`) are unchanged: the
 * v11-compat adapter for module state.
 *
 * @module kernel/instance
 */

import { AsyncLocalStorage } from 'async_hooks';

let seq = 0;

/** The module state of one gateway instance. */
export class InstanceScope {
  private readonly state = new Map<string, Map<string, unknown>>();
  constructor(readonly id: string = `gw-${++seq}`) {}

  /** The value `name` of module `moduleId`, created on first use. */
  get<T>(moduleId: string, name: string, factory: () => T): T {
    let m = this.state.get(moduleId);
    if (!m) this.state.set(moduleId, (m = new Map()));
    if (!m.has(name)) m.set(name, factory());
    return m.get(name) as T;
  }

  /** Forget everything module `moduleId` kept in this instance (disable / dispose). */
  drop(moduleId: string): void {
    this.state.delete(moduleId);
  }

  /** Forget the state of every module (gateway stop). */
  clear(): void {
    this.state.clear();
  }

  /** Module ids holding state (diagnostics, tests). */
  modules(): string[] {
    return [...this.state.keys()];
  }
}

/** Scope used outside any gateway (13.x: process-wide state). */
export const processScope = new InstanceScope('process');

const als = new AsyncLocalStorage<InstanceScope>();

/** The scope of the gateway the current code runs for (else the process scope). */
export const currentScope = (): InstanceScope => als.getStore() ?? processScope;

/** Run `fn` (and everything it schedules) in `scope`. */
export function runInScope<T>(scope: InstanceScope, fn: () => T): T {
  return als.getStore() === scope ? fn() : als.run(scope, fn);
}

/** Enter `scope` for the rest of the current synchronous execution and its async continuations. */
export function enterScope(scope: InstanceScope): void {
  als.enterWith(scope);
}

/**
 * Module state that is kept per gateway instance: `export const flowQueue = instanceLocal('approval-flows', 'queue',
 * () => new FlowQueue())`. Property reads and method calls go to the current instance's object (methods are bound to
 * it, so `Map` / `Set` / class instances work unchanged).
 */
export function instanceLocal<T extends object>(moduleId: string, name: string, factory: () => T): T {
  const real = () => currentScope().get(moduleId, name, factory) as Record<PropertyKey, unknown>;
  return new Proxy({} as T, {
    get(_t, prop) {
      const r = real();
      const v = Reflect.get(r, prop, r);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(r) : v;
    },
    set(_t, prop, value) {
      return Reflect.set(real(), prop, value);
    },
    has(_t, prop) {
      return Reflect.has(real(), prop);
    },
    ownKeys() {
      return Reflect.ownKeys(real());
    },
    getOwnPropertyDescriptor(_t, prop) {
      const d = Reflect.getOwnPropertyDescriptor(real(), prop);
      return d ? { ...d, configurable: true } : undefined;
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(real());
    },
  });
}

/** A per-instance mutable value (replaces a module-level `let`). */
export function instanceValue<T>(moduleId: string, name: string, initial: () => T): { get: () => T; set: (v: T) => void } {
  const box = instanceLocal(moduleId, name, () => ({ v: initial() }));
  return { get: () => box.v, set: (v) => void (box.v = v) };
}
