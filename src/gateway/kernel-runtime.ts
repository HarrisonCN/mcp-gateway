/**
 * Kernel module loader (13.0): evaluates feature modules on demand through the manifest's `import()` thunks, in
 * dependency order, and remembers which ones failed so the rest of the gateway keeps running (failure isolation).
 *
 * Evaluation is process-wide (an ES module is evaluated once): the process keeps only the immutable manifest and
 * this load cache. Activation, lifecycle, health and runtime failures are per gateway (13.1: {@link ModuleFailures},
 * owned by each {@link ./features.ts createFeatureRouter}), so a module that fails in one gateway does not affect
 * another gateway in the same process.
 *
 * - {@link loadFeature} — evaluate a module after its declared dependencies; resolves `false` (never throws) on failure.
 * - {@link requireDependency} — what a module uses instead of importing another feature module: only declared
 *   `dependsOn` modules can be obtained, and they are evaluated first.
 * - {@link dependencyOrder} — topological order (dependencies first, manifest order otherwise); rejects cycles.
 *
 * @module gateway/kernel-runtime
 */

import { FEATURE_MANIFEST, manifestEntry } from '../features/manifest.js';

export interface LoadRecord {
  id: string;
  status: 'loading' | 'loaded' | 'failed';
  /** Wall time of the `import()` (ms). */
  loadMs?: number;
  error?: string;
}

const records = new Map<string, LoadRecord>();
const namespaces = new Map<string, Record<string, unknown>>();
const pending = new Map<string, Promise<boolean>>();

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Dependencies first; ties keep manifest order. Throws on an unknown id or a dependency cycle. */
export function dependencyOrder(ids: Iterable<string>): string[] {
  const out: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, path: string[]) => {
    const s = state.get(id);
    if (s === 'done') return;
    if (s === 'visiting') throw new Error(`feature dependency cycle: ${[...path, id].join(' → ')}`);
    const e = manifestEntry(id);
    state.set(id, 'visiting');
    for (const d of e?.dependsOn ?? []) {
      if (!manifestEntry(d)) throw new Error(`feature module "${id}" depends on unknown module "${d}"`);
      visit(d, [...path, id]);
    }
    state.set(id, 'done');
    out.push(id);
  };
  const order = new Map(FEATURE_MANIFEST.map((e, i) => [e.id, i]));
  for (const id of [...new Set(ids)].sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9))) visit(id, []);
  return out;
}

/** Every module `id` needs, transitively (excluding `id`). */
export function dependenciesOf(id: string): string[] {
  return dependencyOrder([id]).filter((x) => x !== id);
}

/** Modules that (transitively) depend on `id`. */
export function dependentsOf(id: string): string[] {
  return FEATURE_MANIFEST.filter((e) => e.id !== id && dependenciesOf(e.id).includes(id)).map((e) => e.id);
}

/**
 * Evaluate a manifest module (dependencies first). Resolves `true` when it is evaluated, `false` when it or a
 * dependency failed — the error is in {@link loadRecord}. Modules that are not in the manifest (registered at
 * runtime, e.g. by tests or plugins) resolve `true`.
 */
export function loadFeature(id: string): Promise<boolean> {
  const e = manifestEntry(id);
  if (!e) return Promise.resolve(true);
  const r = records.get(id);
  if (r?.status === 'loaded') return Promise.resolve(true);
  if (r?.status === 'failed') return Promise.resolve(false);
  let p = pending.get(id);
  if (!p) {
    p = (async () => {
      for (const d of e.dependsOn ?? []) {
        if (!(await loadFeature(d))) {
          records.set(id, { id, status: 'failed', error: `dependency "${d}" failed: ${records.get(d)?.error ?? 'unknown error'}` });
          return false;
        }
      }
      records.set(id, { id, status: 'loading' });
      const t0 = performance.now();
      try {
        const ns = (await e.load()) as Record<string, unknown>;
        namespaces.set(id, ns);
        records.set(id, { id, status: 'loaded', loadMs: Math.round((performance.now() - t0) * 10) / 10 });
        return true;
      } catch (err) {
        records.set(id, { id, status: 'failed', loadMs: Math.round((performance.now() - t0) * 10) / 10, error: errText(err) });
        return false;
      }
    })();
    pending.set(id, p);
    void p.finally(() => pending.delete(id));
  }
  return p;
}

/**
 * The exports of a module `from` declared in its manifest `dependsOn` (evaluated first if needed). Feature modules
 * use this (with top-level `await`) instead of importing another feature module, so every cross-module edge is
 * declared, ordered and visible in `GET /admin/kernel`.
 */
export async function requireDependency<T>(from: string, dep: string): Promise<T> {
  const e = manifestEntry(from);
  if (!e?.dependsOn?.includes(dep)) throw new Error(`feature module "${from}" uses "${dep}" without declaring it in dependsOn`);
  if (!(await loadFeature(dep))) throw new Error(`feature module "${from}": dependency "${dep}" failed to load: ${records.get(dep)?.error}`);
  return namespaces.get(dep) as T;
}

/** Load record of a manifest module (undefined: never requested). */
export const loadRecord = (id: string): LoadRecord | undefined => records.get(id);

/** Ids of manifest modules evaluated so far (through the kernel). */
export const loadedFeatures = (): string[] => [...records.values()].filter((r) => r.status === 'loaded').map((r) => r.id);

/**
 * Runtime failures of one gateway's kernel (13.1; was a process-wide map in 13.0): modules whose init / reconfigure /
 * disable threw or whose dependency failed. Their call hooks are handled by their failure policy (see
 * {@link ../gateway/hooks.ts callHookPlan}).
 */
export class ModuleFailures {
  private readonly failed = new Map<string, string>();
  /** Mark a module failed. */
  mark(id: string, error: string): void {
    this.failed.set(id, error);
  }
  /** Clear one failure (successful re-init) or all of them (gateway stop). */
  clear(id?: string): void {
    if (id === undefined) this.failed.clear();
    else this.failed.delete(id);
  }
  get(id: string): string | undefined {
    return this.failed.get(id);
  }
  ids(): string[] {
    return [...this.failed.keys()];
  }
}

/** Load failure of a module (process-wide: an ES module that failed to evaluate is failed for every gateway). */
export const loadFailureOf = (id: string): string | undefined => (records.get(id)?.status === 'failed' ? records.get(id)!.error : undefined);

/** Runtime failure (of the given gateway's kernel) or load failure of a module, if any. */
export function failureOf(id: string, failures?: ModuleFailures): string | undefined {
  return failures?.get(id) ?? loadFailureOf(id);
}
