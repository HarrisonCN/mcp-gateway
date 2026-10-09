/**
 * Multi-region active-active (5.2).
 *
 * Every region runs a full gateway. Regions replicate a small shared key-value state (last-writer-wins per key,
 * ties broken by region id) and gossip which upstream servers are online, so a call whose upstream is down locally
 * can be failed over to a region that has it.
 *
 * ```yaml
 * regions:
 *   self: eu-west
 *   syncIntervalMs: 5000
 *   peers:
 *     - { id: us-east, url: https://us.gw.example.com, apiKey: ${US_ADMIN_KEY}, priority: 1 }
 * ```
 *
 * - `GET  /admin/regions` — this region, peers (health, last sync, servers online), replicated key count.
 * - `POST /admin/regions/sync` — peer exchange `{ region, since, entries, servers }` → `{ region, entries, servers }`.
 * - `GET|PUT|DELETE /admin/regions/kv/:key` — replicated state (`PUT` body `{ value }`).
 * - `GET  /admin/regions/route/:serverId` — where a call to that server should run: `local`, a peer, or none.
 *
 * @module features/regions
 */

import { z } from 'zod';
import { registerFeature, badRequest, objectBody, type FeatureContext } from '../gateway/features.js';
import { RegionsConfig, RegionsSchema } from './schemas/regions.js';
export { RegionsConfig, RegionsSchema } from './schemas/regions.js';
type Resolved = z.output<typeof RegionsSchema>;

export interface ReplicatedEntry {
  key: string;
  /** `null` = tombstone (deleted). */
  value: unknown;
  /** Hybrid timestamp: wall-clock ms, bumped to stay monotonic per region. */
  ts: number;
  region: string;
}

export interface PeerState {
  id: string;
  url: string;
  priority: number;
  status: 'unknown' | 'up' | 'down';
  failures: number;
  lastSync?: string;
  lastError?: string;
  /** Highest `ts` received from this peer (sync cursor). */
  cursor: number;
  servers: string[];
}

/** Last-writer-wins: newer ts wins; equal ts → lexicographically larger region wins. */
export const newer = (a: ReplicatedEntry, b: ReplicatedEntry | undefined): boolean =>
  !b || a.ts > b.ts || (a.ts === b.ts && a.region > b.region);

export class RegionMesh {
  private readonly entries = new Map<string, ReplicatedEntry>();
  private readonly peers = new Map<string, PeerState>();
  private clock = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private cfg: Resolved, private readonly now: () => number = Date.now) {
    this.configure(cfg);
  }

  get self(): string {
    return this.cfg.self;
  }

  configure(cfg: Resolved): void {
    this.cfg = cfg;
    const keep = new Set(cfg.peers.map((p) => p.id));
    for (const id of [...this.peers.keys()]) if (!keep.has(id)) this.peers.delete(id);
    for (const p of cfg.peers) {
      const cur = this.peers.get(p.id);
      this.peers.set(p.id, cur ? { ...cur, url: p.url, priority: p.priority } : { id: p.id, url: p.url, priority: p.priority, status: 'unknown', failures: 0, cursor: 0, servers: [] });
    }
  }

  private tick(): number {
    this.clock = Math.max(this.clock + 1, this.now());
    return this.clock;
  }

  get(key: string): unknown {
    const e = this.entries.get(key);
    return e && e.value !== null ? e.value : undefined;
  }

  put(key: string, value: unknown): ReplicatedEntry {
    const e: ReplicatedEntry = { key, value: value === undefined ? null : value, ts: this.tick(), region: this.cfg.self };
    this.entries.set(key, e);
    return e;
  }

  delete(key: string): boolean {
    const had = this.get(key) !== undefined;
    this.put(key, null);
    return had;
  }

  size(): number {
    return [...this.entries.values()].filter((e) => e.value !== null).length;
  }

  /** Merge remote entries; returns how many changed local state. */
  merge(entries: ReplicatedEntry[]): number {
    let n = 0;
    for (const e of entries) {
      if (!e || typeof e.key !== 'string' || typeof e.ts !== 'number' || typeof e.region !== 'string') continue;
      if (newer(e, this.entries.get(e.key))) {
        this.entries.set(e.key, { key: e.key, value: e.value ?? null, ts: e.ts, region: e.region });
        n++;
      }
      this.clock = Math.max(this.clock, e.ts);
    }
    return n;
  }

  /** Entries changed after `since` (any origin, so state relays through intermediate regions). */
  delta(since = 0): ReplicatedEntry[] {
    return [...this.entries.values()].filter((e) => e.ts > since).sort((a, b) => a.ts - b.ts);
  }

  peerList(): PeerState[] {
    return [...this.peers.values()].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }

  /** Record a peer's gossip (from an inbound or outbound sync). */
  sawPeer(id: string, servers: unknown, cursor?: number): void {
    const p = this.peers.get(id);
    if (!p) return;
    p.status = 'up';
    p.failures = 0;
    p.lastSync = new Date(this.now()).toISOString();
    delete p.lastError;
    if (Array.isArray(servers)) p.servers = servers.map(String);
    if (typeof cursor === 'number') p.cursor = Math.max(p.cursor, cursor);
  }

  peerFailed(id: string, err: string): void {
    const p = this.peers.get(id);
    if (!p) return;
    p.failures++;
    p.lastError = err;
    if (p.failures >= this.cfg.downAfter) p.status = 'down';
  }

  /** Where a call to `serverId` should run. */
  route(serverId: string, localOnline: string[]): { target: 'local' } | { target: 'peer'; peer: string; url: string } | { target: 'none' } {
    if (localOnline.includes(serverId)) return { target: 'local' };
    const peer = this.peerList().find((p) => p.status === 'up' && p.servers.includes(serverId));
    return peer ? { target: 'peer', peer: peer.id, url: peer.url } : { target: 'none' };
  }

  /** One outbound sync round with every peer. */
  async syncOnce(localOnline: string[], f: typeof fetch = fetch): Promise<void> {
    await Promise.all(
      this.peerList().map(async (p) => {
        const conf = this.cfg.peers.find((x) => x.id === p.id);
        try {
          const res = await f(`${p.url.replace(/\/$/, '')}/api/v1/admin/regions/sync`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(conf?.apiKey ? { authorization: `Bearer ${conf.apiKey}` } : {}) },
            body: JSON.stringify({ region: this.cfg.self, since: p.cursor, entries: this.delta(0), servers: localOnline }),
            signal: AbortSignal.timeout(Math.max(1000, this.cfg.syncIntervalMs)),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = (await res.json()) as { entries?: ReplicatedEntry[]; servers?: string[] };
          const entries = Array.isArray(body.entries) ? body.entries : [];
          this.merge(entries);
          this.sawPeer(p.id, body.servers, entries.reduce((m, e) => Math.max(m, e.ts ?? 0), 0));
        } catch (e) {
          this.peerFailed(p.id, (e as Error).message);
        }
      }),
    );
  }

  start(localOnline: () => string[], f: typeof fetch = fetch): void {
    this.stop();
    if (!this.cfg.peers.length) return;
    this.timer = setInterval(() => void this.syncOnce(localOnline(), f), this.cfg.syncIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  status(): Record<string, unknown> {
    return { self: this.cfg.self, syncIntervalMs: this.cfg.syncIntervalMs, keys: this.size(), peers: this.peerList() };
  }
}

/** Resolve (validate + defaults) a `regions` section. */
export const resolveRegions = (raw: unknown): Resolved => RegionsSchema.parse(raw);

function meshFor(ctx: FeatureContext, state: { mesh?: RegionMesh; key?: string }): RegionMesh | undefined {
  const raw = ctx.config().regions;
  if (!raw) {
    state.mesh?.stop();
    state.mesh = undefined;
    state.key = undefined;
    return undefined;
  }
  const key = JSON.stringify(raw);
  if (state.key !== key) {
    const cfg = resolveRegions(raw);
    if (state.mesh && state.mesh.self === cfg.self) state.mesh.configure(cfg);
    else state.mesh = new RegionMesh(cfg);
    state.key = key;
    state.mesh.start(() => ctx.onlineServers?.() ?? []);
  }
  return state.mesh;
}

registerFeature({
  id: 'regions',
  since: '5.2.0',
  summary: 'Multi-region active-active: replicated state, peer health, cross-region failover routing',
  mount: (router, ctx) => {
    const state: { mesh?: RegionMesh; key?: string } = {};
    ctx.onStop?.(() => state.mesh?.stop());
    // Start syncing as soon as the gateway is up (config may also change later; re-checked on each request).
    setImmediate(() => { try { meshFor(ctx, state); } catch { /* invalid config is reported on request */ } });
    const need = (res: import('express').Response) => {
      const m = meshFor(ctx, state);
      if (!m) res.status(404).json({ error: 'Not Found', message: 'multi-region is not configured (`regions:`)' });
      return m;
    };
    router.get('/', (_req, res) => {
      const m = need(res);
      if (m) res.json(m.status());
    });
    router.post('/sync', (req, res) => {
      const m = need(res);
      if (!m) return;
      const b = objectBody(req, res);
      if (!b) return;
      if (typeof b.region !== 'string') return badRequest(res, '"region" is required');
      if (!m.peerList().some((p) => p.id === b.region)) return void res.status(403).json({ error: 'Forbidden', message: `unknown region "${b.region}"` });
      const entries = Array.isArray(b.entries) ? (b.entries as ReplicatedEntry[]) : [];
      m.merge(entries);
      m.sawPeer(b.region, b.servers, entries.reduce((x, e) => Math.max(x, e?.ts ?? 0), 0));
      res.json({ region: m.self, entries: m.delta(typeof b.since === 'number' ? b.since : 0), servers: ctx.onlineServers?.() ?? [] });
    });
    router.get('/kv/:key', (req, res) => {
      const m = need(res);
      if (!m) return;
      const v = m.get(req.params.key!);
      if (v === undefined) return void res.status(404).json({ error: 'Not Found', message: 'no such key' });
      res.json({ key: req.params.key, value: v });
    });
    router.put('/kv/:key', (req, res) => {
      const m = need(res);
      if (!m) return;
      const b = objectBody(req, res);
      if (!b) return;
      if (!('value' in b) || b.value === null) return badRequest(res, '"value" is required (use DELETE to remove)');
      res.json(m.put(req.params.key!, b.value));
    });
    router.delete('/kv/:key', (req, res) => {
      const m = need(res);
      if (m) res.json({ deleted: m.delete(req.params.key!) });
    });
    router.get('/route/:serverId', (req, res) => {
      const m = need(res);
      if (m) res.json({ serverId: req.params.serverId, ...m.route(req.params.serverId!, ctx.onlineServers?.() ?? []) });
    });
  },
});
