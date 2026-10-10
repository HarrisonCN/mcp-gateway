/**
 * Versioned, immutable configuration generations (13.2.0).
 *
 * Every committed configuration is a numbered generation: a deep-frozen snapshot of the config, the server configs
 * it registers (by id, replicas expanded), and the plugin instances that were active when it was committed. A hot
 * reload that fails never publishes a generation, so the generation number only moves on a full commit.
 *
 * Calls are pinned: the invoker acquires the current generation when a call starts and every config read of that
 * call (policy, tenants, server config, injected credentials, routing, hooks, plugins, upstream session) resolves
 * against it — never against a generation committed while the call was in flight. A generation that is no longer
 * current is retired once its last pinned call ends; its retire hooks (close drained upstream sessions, close
 * replaced plugin instances) run then.
 *
 * @module gateway/generation
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { GatewayConfig, McpServerConfig } from '../utils/types.js';
import type { GatewayPlugin } from '../plugins/index.js';
import { logger } from '../utils/logger.js';

export interface ConfigGeneration {
  /** 1 for the config the gateway started with, +1 for every committed reload / server install. */
  readonly id: number;
  /** Deep-frozen snapshot of the committed config. */
  readonly config: Readonly<GatewayConfig>;
  /** Enabled server configs registered under this generation (replicas and catalog installs included), by id. */
  readonly servers: ReadonlyMap<string, Readonly<McpServerConfig>>;
  /** Plugin instances active in this generation (hook order). */
  readonly plugins: readonly GatewayPlugin[];
  readonly committedAt: string;
}

/** Identity of a server config: the session of a pinned call must have been opened with exactly this config. */
export function serverKey(s: McpServerConfig | undefined): string | undefined {
  return s ? JSON.stringify(s) : undefined;
}

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object') return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};

/**
 * Deep copy of plain objects / arrays, frozen. Anything else (class instances, functions, RegExps) is shared by
 * reference and left as is.
 */
export function frozenCopy<T>(v: T): T {
  if (Array.isArray(v)) return Object.freeze(v.map((x) => frozenCopy(x))) as unknown as T;
  if (isPlain(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = frozenCopy(x);
    return Object.freeze(out) as T;
  }
  return v;
}

interface Slot {
  gen: ConfigGeneration;
  refs: number;
  hooks: Array<() => void | Promise<void>>;
  retired: boolean;
}

/** A pinned generation; `release()` exactly once when the call ends. */
export interface GenerationPin {
  readonly generation: ConfigGeneration;
  release(): void;
}

/** In-flight call → its pinned generation. */
export const callGeneration = new AsyncLocalStorage<ConfigGeneration>();

export class Generations {
  private cur: Slot;
  private readonly slots = new Map<number, Slot>();
  /** Committed generations since start (the first counts). */
  committed = 1;

  constructor(first: Omit<ConfigGeneration, 'id' | 'committedAt'>) {
    this.cur = this.slot({ ...first, id: 1, committedAt: new Date().toISOString() });
  }

  private slot(gen: ConfigGeneration): Slot {
    const s: Slot = { gen: Object.freeze(gen), refs: 0, hooks: [], retired: false };
    this.slots.set(gen.id, s);
    return s;
  }

  get current(): ConfigGeneration {
    return this.cur.gen;
  }

  /** The generation of the call running in this async context, else the current one. */
  view(): ConfigGeneration {
    return callGeneration.getStore() ?? this.cur.gen;
  }

  /** The pinned generation of the running call (undefined outside of a call). */
  pinned(): ConfigGeneration | undefined {
    return callGeneration.getStore();
  }

  /** Pin the current generation for one call. */
  acquire(): GenerationPin {
    const s = this.cur;
    s.refs++;
    let done = false;
    return {
      generation: s.gen,
      release: () => {
        if (done) return;
        done = true;
        s.refs--;
        this.maybeRetire(s);
      },
    };
  }

  /**
   * Publish the next generation (the commit point of a reload). The previous one is retired as soon as no call
   * pins it.
   */
  publish(next: Omit<ConfigGeneration, 'id' | 'committedAt'>): ConfigGeneration {
    const prev = this.cur;
    this.cur = this.slot({ ...next, id: prev.gen.id + 1, committedAt: new Date().toISOString() });
    this.committed++;
    this.maybeRetire(prev);
    return this.cur.gen;
  }

  /**
   * Run `fn` once generation `id` is retired (not current and no pinned call left) — immediately when it already
   * is. Used for resources that pinned calls may still need: replaced upstream sessions, replaced plugins.
   */
  onRetire(id: number, fn: () => void | Promise<void>): void {
    const s = this.slots.get(id);
    if (!s || s.retired) {
      void Promise.resolve().then(fn).catch((err) => logger.warn(`retire hook failed: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    s.hooks.push(fn);
  }

  private maybeRetire(s: Slot): void {
    if (s === this.cur || s.refs > 0 || s.retired) return;
    s.retired = true;
    this.slots.delete(s.gen.id);
    const hooks = s.hooks.splice(0);
    for (const fn of hooks) {
      void Promise.resolve()
        .then(fn)
        .catch((err) => logger.warn(`generation ${s.gen.id} retire hook failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  /** Generations still alive (the current one plus any pinned by in-flight calls) and their pinned call counts. */
  stats(): { current: number; alive: number; pinned: Record<string, number> } {
    const pinned: Record<string, number> = {};
    for (const s of this.slots.values()) if (s.refs > 0) pinned[String(s.gen.id)] = s.refs;
    return { current: this.cur.gen.id, alive: this.slots.size, pinned };
  }

  /** Gateway stop: retire everything now (pending hooks run; in-flight calls are being cancelled anyway). */
  async drainAll(): Promise<void> {
    const hooks: Array<() => void | Promise<void>> = [];
    for (const s of this.slots.values()) {
      if (s === this.cur) continue;
      s.retired = true;
      hooks.push(...s.hooks.splice(0));
      this.slots.delete(s.gen.id);
    }
    await Promise.all(hooks.map((fn) => Promise.resolve().then(fn).catch(() => undefined)));
  }
}
