/**
 * Offline / edge sync for the edge gateway (4.8).
 *
 * An edge deployment pulls a **config snapshot** from a Node gateway acting as its control plane
 * (`GET /api/v1/admin/edge/snapshot`, ETag / `If-None-Match`), keeps the last good snapshot in a
 * key-value store so it keeps serving when the control plane is unreachable, buffers **usage events**
 * in an outbox and pushes them back (`POST /api/v1/admin/edge/sync`), and holds **queued tool calls**
 * (for tools listed in `offline.queueTools`) while an upstream is unreachable, replaying them on the
 * next sync.
 *
 * The store interface is the subset of Cloudflare Workers KV that sync needs (`get` / `put` /
 * `delete` with string values), so a KV namespace binding can be passed as-is. `memoryStore()` is
 * the per-isolate default.
 *
 * This module must not import Node built-ins.
 *
 * @module edge/sync
 */

import type { EdgeServerConfig } from './index.js';

/** String key-value store (Workers KV compatible). */
export interface EdgeSyncStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** In-memory store (per isolate / process). */
export function memoryStore(): EdgeSyncStore & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(k) {
      return data.has(k) ? data.get(k)! : null;
    },
    async put(k, v) {
      data.set(k, v);
    },
    async delete(k) {
      data.delete(k);
    },
  };
}

/** A tool the control plane knows about (lets a cold edge list tools while an upstream is down). */
export interface EdgeCatalogTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}

/** What the control plane hands an edge (`GET /api/v1/admin/edge/snapshot`). */
export interface EdgeSnapshot {
  /** Gateway version that produced the snapshot. */
  version: string;
  generatedAt: string;
  /** Content hash (also the `ETag`). */
  etag: string;
  config: {
    servers: Array<EdgeServerConfig & { catalog?: EdgeCatalogTool[] }>;
    apiKeys?: string[];
    toolNaming?: 'auto' | 'prefix';
    corsOrigins?: string[];
  };
}

/** One tool call seen (or queued / replayed) by the edge. */
export interface EdgeEvent {
  ts: string;
  server: string;
  tool: string;
  durationMs: number;
  ok: boolean;
  /** `queued` while offline, `replayed` when a queued call was delivered later. */
  mode?: 'live' | 'queued' | 'replayed';
  error?: string;
}

/** A tool call held while its upstream was unreachable. */
export interface QueuedCall {
  id: string;
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
  queuedAt: string;
  attempts: number;
}

export interface EdgeSyncOptions {
  /** Base URL of the Node gateway acting as control plane (e.g. `https://gw.example.com`). */
  controlPlane: string;
  /** Operator API key for the control plane (unscoped). */
  apiKey?: string;
  /** Stable id for this edge (default: random per store). */
  edgeId?: string;
  store?: EdgeSyncStore;
  fetch?: typeof fetch;
  /** Ask the control plane for upstream headers too (`?secrets=true`; needs `admin.configApi: true` there). */
  includeSecrets?: boolean;
  /** Outbox / queue caps (oldest dropped first). Default 1000 each. */
  maxEvents?: number;
  maxQueue?: number;
  /** Request timeout for control-plane calls (default 10 s). */
  timeoutMs?: number;
}

export interface PullResult {
  /** `updated` (new snapshot), `unchanged` (304), `offline` (cached snapshot, control plane unreachable), `none` (offline and nothing cached). */
  status: 'updated' | 'unchanged' | 'offline' | 'none';
  snapshot?: EdgeSnapshot;
  error?: string;
}

const K = { snapshot: 'mgw:snapshot', events: 'mgw:outbox', queue: 'mgw:queue', id: 'mgw:edge-id' } as const;

const rid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

/** Control-plane sync client for an edge deployment. */
export class EdgeSync {
  readonly store: EdgeSyncStore;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private edgeId?: string;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: EdgeSyncOptions) {
    if (!opts?.controlPlane) throw new TypeError('controlPlane is required');
    this.base = opts.controlPlane.replace(/\/+$/, '');
    this.store = opts.store ?? memoryStore();
    this.fetchImpl = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.edgeId = opts.edgeId;
  }

  /** Serialize read-modify-write on the store within this isolate. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private async readList<T>(key: string): Promise<T[]> {
    const raw = await this.store.get(key);
    if (!raw) return [];
    try {
      const v = JSON.parse(raw) as unknown;
      return Array.isArray(v) ? (v as T[]) : [];
    } catch {
      return [];
    }
  }

  async id(): Promise<string> {
    if (this.edgeId) return this.edgeId;
    const stored = await this.store.get(K.id);
    this.edgeId = stored ?? `edge-${rid()}`;
    if (!stored) await this.store.put(K.id, this.edgeId);
    return this.edgeId;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { accept: 'application/json', ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}), ...extra };
  }

  /** The last snapshot pulled (survives restarts when the store is persistent). */
  async cached(): Promise<EdgeSnapshot | undefined> {
    const raw = await this.store.get(K.snapshot);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as EdgeSnapshot;
    } catch {
      return undefined;
    }
  }

  /** Pull the config snapshot; falls back to the cached one when the control plane is unreachable. */
  async pull(): Promise<PullResult> {
    const cached = await this.cached();
    const url = `${this.base}/api/v1/admin/edge/snapshot${this.opts.includeSecrets ? '?secrets=true' : ''}`;
    try {
      const res = await this.fetchImpl(url, {
        headers: this.headers({ ...(cached ? { 'if-none-match': `"${cached.etag}"` } : {}), 'x-edge-id': await this.id() }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
      if (res.status === 304 && cached) return { status: 'unchanged', snapshot: cached };
      if (!res.ok) throw new Error(`control plane HTTP ${res.status}`);
      const snap = (await res.json()) as EdgeSnapshot;
      if (!snap || !snap.config || !Array.isArray(snap.config.servers)) throw new Error('invalid snapshot');
      await this.store.put(K.snapshot, JSON.stringify(snap));
      return { status: cached?.etag === snap.etag ? 'unchanged' : 'updated', snapshot: snap };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return cached ? { status: 'offline', snapshot: cached, error } : { status: 'none', error };
    }
  }

  /** Append a usage event to the outbox. */
  record(ev: EdgeEvent): Promise<void> {
    return this.exclusive(async () => {
      const list = await this.readList<EdgeEvent>(K.events);
      list.push(ev);
      const max = this.opts.maxEvents ?? 1000;
      await this.store.put(K.events, JSON.stringify(list.slice(Math.max(0, list.length - max))));
    });
  }

  /** Events waiting to be pushed. */
  outbox(): Promise<EdgeEvent[]> {
    return this.readList<EdgeEvent>(K.events);
  }

  /** Hold a tool call for later delivery; returns the queued call. */
  enqueue(call: Omit<QueuedCall, 'id' | 'queuedAt' | 'attempts'>): Promise<QueuedCall> {
    return this.exclusive(async () => {
      const q = await this.readList<QueuedCall>(K.queue);
      const item: QueuedCall = { ...call, id: `q-${rid()}`, queuedAt: new Date().toISOString(), attempts: 0 };
      q.push(item);
      const max = this.opts.maxQueue ?? 1000;
      await this.store.put(K.queue, JSON.stringify(q.slice(Math.max(0, q.length - max))));
      return item;
    });
  }

  /** Queued tool calls, oldest first. */
  queued(): Promise<QueuedCall[]> {
    return this.readList<QueuedCall>(K.queue);
  }

  /** Remove a delivered (or permanently failed) call; bump `attempts` on the others given in `retry`. */
  settle(done: string[], retry: string[] = []): Promise<void> {
    return this.exclusive(async () => {
      const q = (await this.readList<QueuedCall>(K.queue))
        .filter((c) => !done.includes(c.id))
        .map((c) => (retry.includes(c.id) ? { ...c, attempts: c.attempts + 1 } : c));
      if (q.length) await this.store.put(K.queue, JSON.stringify(q));
      else await this.store.delete(K.queue);
    });
  }

  /** Push the outbox to the control plane; events are removed only once accepted. */
  async push(): Promise<{ sent: number; offline: boolean; error?: string }> {
    const events = await this.exclusive(() => this.outbox());
    const queued = (await this.queued()).length;
    try {
      const res = await this.fetchImpl(`${this.base}/api/v1/admin/edge/sync`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ edgeId: await this.id(), events, queued }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
      if (!res.ok) throw new Error(`control plane HTTP ${res.status}`);
      await res.body?.cancel().catch(() => undefined);
      await this.exclusive(async () => {
        // Keep anything recorded while the push was in flight.
        const now = await this.readList<EdgeEvent>(K.events);
        const rest = now.slice(events.length);
        if (rest.length) await this.store.put(K.events, JSON.stringify(rest));
        else await this.store.delete(K.events);
      });
      return { sent: events.length, offline: false };
    } catch (err) {
      return { sent: 0, offline: true, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
