/**
 * Multi-region active-active (5.2); consistency boundaries (14.5.0).
 *
 * Every region runs a full gateway. Regions replicate a small shared key-value state and gossip which upstream servers
 * are online, so a call whose upstream is down locally can be failed over to a region that has it.
 *
 * ```yaml
 * regions:
 *   self: eu-west
 *   syncIntervalMs: 5000
 *   consistency: { maxStalenessMs: 30000, maxClockSkewMs: 30000, onStale: deny }   # 14.5.0 (defaults)
 *   peers:
 *     - { id: us-east, url: https://us.gw.example.com, apiKey: ${US_ADMIN_KEY}, priority: 1 }
 * ```
 *
 * 14.5.0 makes the eventual-consistency boundary explicit ({@link CONSISTENCY_BOUNDARIES}):
 *
 * - **Replicated** between regions: revocations (a grow-only set — a revoked client id is never un-revoked by a merge),
 *   the `kv` state (version vectors: a causally newer write always wins, concurrent writes resolve last-writer-wins and
 *   are counted as conflicts; `ifGeneration` fences writers holding a stale generation) and server availability.
 * - **Region-local** (never replicated): sessions, rate-limit / quota counters, policy, the gateway config and its
 *   generations, portal keys and API keys, caches, task runs. Each region keeps these in its own store.
 * - **Bounded staleness, fail closed**: a region is *fresh* while every peer synced within `maxStalenessMs`. A tool
 *   call by a revoked client id is refused (`-32028`); while the region is not fresh it refuses every tool call
 *   (`-32027`) unless `onStale: allow`, because it cannot confirm that no other region revoked the caller.
 * - **Clock skew**: replicated writes stamped more than `maxClockSkewMs` ahead of the local clock are rejected and never
 *   move the hybrid clock (14.4 accepted any timestamp: a peer with a runaway clock won every later conflict).
 * - With a shared store (`store.backend` redis / sqlite / eventlog), the instances of one region share their
 *   revocations through it; a region whose store cannot be read is not fresh.
 *
 * Routes (operators):
 * - `GET  /admin/regions` — this region, peers (health, last sync, servers online), replicated key count.
 * - `GET  /admin/regions/health` — 200 when fresh, 503 when not (for global load balancers) (14.5.0).
 * - `GET  /admin/regions/report` — consistency report: boundaries, freshness and lag per peer, clock skew, conflicts,
 *   rejected entries, revocations, config drift (14.5.0; CLI `mcp-gateway regions report`).
 * - `GET|POST /admin/regions/revocations` — replicated revocations; `POST { clientId, reason? }` (14.5.0).
 * - `POST /admin/regions/sync` — peer exchange `{ region, since, entries, servers, revocations, now, config }`.
 * - `GET|PUT|DELETE /admin/regions/kv/:key` — replicated state (`PUT` body `{ value, ifGeneration? }`).
 * - `GET  /admin/regions/route/:serverId` — where a call to that server should run: `local`, a peer, or none.
 * - `GET  /admin/regions/rollup` — 16.2.0: costs (current UTC day) and the call lineage summary of every region, each
 *   region's own figures carried in the sync exchange, summed; `complete: false` while a region is missing or stale.
 * - `GET  /admin/regions/lineage/:region::requestId` — 16.2.0: one call's lineage by its region-qualified id
 *   (`<region>:<requestId>`, unique across regions); another region's record is fetched from that peer.
 *
 * 16.2.0 also measures **revocation propagation**: when a revocation issued in another region arrives, its latency
 * (issuing region's clock, corrected by that peer's observed clock skew) is compared with
 * `consistency.revocationSloMs` (default `maxStalenessMs`); a slower one is a breach — counted in the report and the
 * metrics and put on the operations timeline (`revocation-slo`).
 *
 * @module features/regions
 */

import { emitOpsEvent, registerOpsSource } from '../gateway/ops-events.js';
import { createHash } from 'crypto';
import { z } from 'zod';
import { registerFeature, badRequest, objectBody, type FeatureContext } from '../gateway/features.js';
import { registerCallHook } from '../gateway/hooks.js';
import { onRevocation, registerRevocationAuthority } from '../gateway/revocations.js';
import { registerMetricSource } from '../monitor/index.js';
import { instanceLocal } from '../kernel/instance.js';
import { MemoryStateStore, type StateStore } from '../state/store.js';
import { logger } from '../utils/logger.js';
import { type RegionsConfig, RegionsSchema } from './schemas/regions.js';
export { type RegionsConfig, RegionsSchema } from './schemas/regions.js';
type Resolved = z.output<typeof RegionsSchema>;

/** Tool call refused: this region cannot confirm it is fresh (partition / peer down beyond `maxStalenessMs`) (14.5.0). */
export const ERR_REGION_STALE = -32027;
/** Tool call refused: the caller's client id was revoked in some region (replicated revocation) (14.5.0). */
export const ERR_REGION_REVOKED = -32028;

/** What multi-region replicates and what stays in each region (14.5.0; also in `GET /admin/regions/report`). */
export const CONSISTENCY_BOUNDARIES = {
  replicated: ['revocations', 'kv', 'server-availability'],
  regionLocal: ['sessions', 'rate-limits', 'quotas', 'budgets', 'policy', 'config', 'config-generations', 'api-keys', 'portal-keys', 'caches', 'task-runs', 'audit'],
} as const;

/** Version vector: per-region write counters of a replicated value (14.5.0). */
export type VersionVector = Record<string, number>;

export interface ReplicatedEntry {
  key: string;
  /** `null` = tombstone (deleted). */
  value: unknown;
  /** Hybrid timestamp: wall-clock ms, bumped to stay monotonic per region. */
  ts: number;
  region: string;
  /** 14.5.0: causal history (absent on entries from 14.4 and older peers: last-writer-wins). */
  vv?: VersionVector;
  /** 14.5.0: generation = sum of the version vector (monotonic along the causal history of the key). */
  gen?: number;
  /** 14.5.0: the winner of a concurrent write (both versions were seen; last-writer-wins picked this one). */
  conflict?: boolean;
}

/** A replicated revocation (14.5.0). */
export interface Revocation {
  clientId: string;
  /** Earliest revocation time seen (ms, the revoking region's clock). */
  at: number;
  region: string;
  reason?: string;
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
  /** 14.5.0: local time (ms) of the last successful exchange — drives freshness / replication lag. */
  lastSyncAt?: number;
  /** 14.5.0: peer clock minus local clock at the last exchange (ms, includes one-way latency). */
  skewMs?: number;
  /** 14.5.0: the peer's config fingerprint (policy hash + config generation) at the last exchange. */
  config?: { policyHash?: string; generation?: number };
  /** 16.2.0: the peer's own rollup (costs + lineage summary) from its last exchange. */
  rollup?: RegionRollup;
}

/** 16.2.0: cost totals of one rollup row (same shape as the cost ledger rollup). */
export interface RollupCost {
  cost: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}
/** 16.2.0: one region's own figures, carried in its sync exchange. */
export interface RegionRollup {
  region: string;
  asOf: string;
  /** Cost ledger since the start of the current UTC day. */
  costs: { currency: string; since: string; total: RollupCost; byTenant: Array<RollupCost & { key: string }> };
  /** Call lineage kept by the region (operations console traces), by outcome. */
  lineage: { kept: number; ok: number; denied: number; error: number };
}
/** 16.2.0: one row of the cross-region rollup. */
export interface RollupRow {
  region: string;
  status: 'self' | 'fresh' | 'stale' | 'missing';
  asOf: string | null;
  lagMs: number | null;
  costs: RegionRollup['costs'] | null;
  lineage: RegionRollup['lineage'] | null;
}
export interface MergedRollup {
  regions: RollupRow[];
  total: { costs: RollupCost; byTenant: Array<RollupCost & { key: string }>; lineage: RegionRollup['lineage'] };
  /** Every peer's figures are present and fresh. */
  complete: boolean;
}
/** 16.2.0: one measured revocation propagation. */
export interface PropagationSample {
  clientId: string;
  from: string;
  latencyMs: number;
  breached: boolean;
  at: string;
}

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const validCost = (c: unknown): c is RollupCost => !!c && typeof c === 'object' && num((c as RollupCost).cost) && num((c as RollupCost).calls) && num((c as RollupCost).inputTokens) && num((c as RollupCost).outputTokens);
/** 16.2.0: a rollup received from a peer is used only when well formed and about that peer. */
export function validRollup(r: unknown, region: string): r is RegionRollup {
  if (!r || typeof r !== 'object') return false;
  const x = r as RegionRollup;
  if (x.region !== region || typeof x.asOf !== 'string') return false;
  const c = x.costs;
  if (!c || typeof c !== 'object' || typeof c.currency !== 'string' || typeof c.since !== 'string' || !validCost(c.total) || !Array.isArray(c.byTenant) || c.byTenant.length > 1000) return false;
  if (!c.byTenant.every((t) => validCost(t) && typeof (t as { key?: unknown }).key === 'string')) return false;
  const l = x.lineage;
  return !!l && typeof l === 'object' && num(l.kept) && num(l.ok) && num(l.denied) && num(l.error);
}
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const addCost = (a: RollupCost, b: RollupCost): RollupCost => ({ cost: r6(a.cost + b.cost), calls: a.calls + b.calls, inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens });

/**
 * 16.2.0: the cross-region rollup — this region's figures plus each peer's latest, summed. A peer without figures is
 * `missing`, one not synced within `maxStalenessMs` is `stale` (its last figures still count, flagged); `complete`
 * only while every peer is fresh with figures.
 */
export function mergeRollups(self: RegionRollup, peers: Array<{ id: string; rollup?: RegionRollup; fresh: boolean; lagMs: number | null }>): MergedRollup {
  const zero: RollupCost = { cost: 0, calls: 0, inputTokens: 0, outputTokens: 0 };
  const rows: RollupRow[] = [{ region: self.region, status: 'self', asOf: self.asOf, lagMs: 0, costs: self.costs, lineage: self.lineage }];
  for (const p of peers) {
    rows.push(p.rollup
      ? { region: p.id, status: p.fresh ? 'fresh' : 'stale', asOf: p.rollup.asOf, lagMs: p.lagMs, costs: p.rollup.costs, lineage: p.rollup.lineage }
      : { region: p.id, status: 'missing', asOf: null, lagMs: p.lagMs, costs: null, lineage: null });
  }
  let costs = zero;
  const tenants = new Map<string, RollupCost & { key: string }>();
  const lineage = { kept: 0, ok: 0, denied: 0, error: 0 };
  for (const r of rows) {
    if (r.costs) {
      costs = addCost(costs, r.costs.total);
      for (const t of r.costs.byTenant) tenants.set(t.key, { key: t.key, ...addCost(tenants.get(t.key) ?? zero, t) });
    }
    if (r.lineage) for (const k of ['kept', 'ok', 'denied', 'error'] as const) lineage[k] += r.lineage[k];
  }
  return {
    regions: rows,
    total: { costs, byTenant: [...tenants.values()].sort((a, b) => a.key.localeCompare(b.key)), lineage },
    complete: rows.every((r) => r.status === 'self' || r.status === 'fresh'),
  };
}

/** A write that named a stale generation (`ifGeneration`) (14.5.0). */
export class GenerationConflict extends Error {
  constructor(
    readonly key: string,
    readonly expected: number,
    readonly current: number,
  ) {
    super(`generation conflict on "${key}": expected ${expected}, current ${current}`);
  }
}

/**
 * Fault injection for partition / clock-skew tests (14.5.0): `partitioned` holds `"a|b"` region pairs (either order)
 * that cannot reach each other; `clockSkewMs[region]` shifts that region's clock.
 */
export const regionFaults: { partitioned: Set<string>; clockSkewMs: Record<string, number> } = { partitioned: new Set(), clockSkewMs: {} };
export const resetRegionFaults = (): void => {
  regionFaults.partitioned.clear();
  regionFaults.clockSkewMs = {};
};
const partitioned = (x: string, y: string): boolean => regionFaults.partitioned.has(`${x}|${y}`) || regionFaults.partitioned.has(`${y}|${x}`);

/** Last-writer-wins: newer ts wins; equal ts → lexicographically larger region wins. */
export const newer = (a: ReplicatedEntry, b: ReplicatedEntry | undefined): boolean =>
  !b || a.ts > b.ts || (a.ts === b.ts && a.region > b.region);

const validVv = (v: unknown): v is VersionVector =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v as object).every((n) => Number.isSafeInteger(n) && (n as number) >= 0);
const vvKeys = (a: VersionVector, b: VersionVector) => new Set([...Object.keys(a), ...Object.keys(b)]);
/** -1: a < b (b dominates), 1: a > b, 0: equal, NaN: concurrent. */
export function compareVv(a: VersionVector, b: VersionVector): number {
  let lt = false;
  let gt = false;
  for (const k of vvKeys(a, b)) {
    const x = a[k] ?? 0;
    const y = b[k] ?? 0;
    if (x < y) lt = true;
    if (x > y) gt = true;
  }
  return lt && gt ? NaN : lt ? -1 : gt ? 1 : 0;
}
const joinVv = (a: VersionVector, b: VersionVector): VersionVector => Object.fromEntries([...vvKeys(a, b)].sort().map((k) => [k, Math.max(a[k] ?? 0, b[k] ?? 0)]));
const genOf = (vv: VersionVector) => Object.values(vv).reduce((s, n) => s + n, 0);

/** What a region adds to its sync exchange besides the replicated state (14.5.0 config fingerprint, 16.2.0 rollup). */
export interface SyncExtra {
  config?: PeerState['config'];
  rollup?: RegionRollup;
}

export interface MeshStats {
  rejected: { clockSkew: number; stale: number; invalid: number };
  conflicts: number;
  /** Tool calls this region refused, by reason. */
  denied: { stale: number; revoked: number };
}

export class RegionMesh {
  private readonly entries = new Map<string, ReplicatedEntry>();
  private readonly peers = new Map<string, PeerState>();
  private readonly revoked = new Map<string, Revocation>();
  /** 16.2.0: recent revocation propagation samples (bounded) and totals. */
  private readonly propagation: PropagationSample[] = [];
  private propagationCount = 0;
  private propagationBreaches = 0;
  private clock = 0;
  private timer?: ReturnType<typeof setInterval>;
  private readonly counters: MeshStats = { rejected: { clockSkew: 0, stale: 0, invalid: 0 }, conflicts: 0, denied: { stale: 0, revoked: 0 } };
  /** 14.5.0: shared region store (siblings in this region) — revocations are exchanged through it. */
  private store?: StateStore;
  private storeOkAt?: number;
  private storeError?: string;

  constructor(private cfg: Resolved, private readonly clockFn?: () => number) {
    this.configure(cfg);
  }

  /** Local wall clock (fault-injected skew applies in tests). */
  now(): number {
    return this.clockFn ? this.clockFn() : Date.now() + (regionFaults.clockSkewMs[this.cfg.self] ?? 0);
  }

  get self(): string {
    return this.cfg.self;
  }

  get settings(): Resolved {
    return this.cfg;
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

  /** The full replicated entry of a key (tombstones included) (14.5.0). */
  entry(key: string): ReplicatedEntry | undefined {
    const e = this.entries.get(key);
    return e ? { ...e, ...(e.vv ? { vv: { ...e.vv } } : {}) } : undefined;
  }

  /** Current generation of a key (0 = never written) (14.5.0). */
  generation(key: string): number {
    const e = this.entries.get(key);
    return e?.vv ? genOf(e.vv) : e ? 1 : 0;
  }

  /** Write a key. 14.5.0: `ifGeneration` refuses the write unless the key is still at that generation (0 = absent). */
  put(key: string, value: unknown, opts: { ifGeneration?: number } = {}): ReplicatedEntry {
    const cur = this.entries.get(key);
    if (opts.ifGeneration !== undefined) {
      const g = this.generation(key);
      if (g !== opts.ifGeneration) throw new GenerationConflict(key, opts.ifGeneration, g);
    }
    const vv: VersionVector = { ...(cur?.vv ?? {}) };
    vv[this.cfg.self] = (vv[this.cfg.self] ?? 0) + 1;
    const e: ReplicatedEntry = { key, value: value === undefined ? null : value, ts: this.tick(), region: this.cfg.self, vv, gen: genOf(vv) };
    this.entries.set(key, e);
    return { ...e, vv: { ...vv } };
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
    const horizon = this.now() + this.cfg.consistency.maxClockSkewMs;
    for (const e of entries) {
      if (!e || typeof e.key !== 'string' || typeof e.ts !== 'number' || typeof e.region !== 'string') continue;
      if (!Number.isFinite(e.ts) || (e.vv !== undefined && !validVv(e.vv))) {
        this.counters.rejected.invalid++;
        continue;
      }
      // 14.5.0: a write stamped beyond the skew horizon is refused — it would win every later conflict
      if (e.ts > horizon) {
        this.counters.rejected.clockSkew++;
        continue;
      }
      const cur = this.entries.get(e.key);
      const incoming: ReplicatedEntry = { key: e.key, value: e.value ?? null, ts: e.ts, region: e.region, ...(e.vv ? { vv: { ...e.vv }, gen: genOf(e.vv) } : {}) };
      const same = (a: ReplicatedEntry, b: ReplicatedEntry) => a.ts === b.ts && a.region === b.region && JSON.stringify(a.value) === JSON.stringify(b.value);
      if (!cur) {
        this.entries.set(e.key, incoming);
        n++;
      } else if (cur.vv && incoming.vv) {
        const c = compareVv(incoming.vv, cur.vv);
        if (c === 1) {
          if (!same(incoming, cur)) n++;
          this.entries.set(e.key, incoming);
        } else if (c === -1) {
          this.counters.rejected.stale++; // causally older: a delayed or replayed version
          continue;
        } else if (c === 0) {
          continue;
        } else {
          // concurrent: deterministic winner, joined history — both sides converge on the same entry
          this.counters.conflicts++;
          const vv = joinVv(cur.vv, incoming.vv);
          const win = newer(incoming, cur) ? incoming : cur;
          if (win === incoming) n++;
          this.entries.set(e.key, { ...win, vv, gen: genOf(vv), conflict: true });
        }
      } else if (newer(incoming, cur)) {
        // 14.4 peers (no version vector): last-writer-wins
        this.entries.set(e.key, incoming);
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

  // ─── revocations (14.5.0) ────────────────────────────────────────────────────

  /** Revoke a client id in every region (grow-only: there is no un-revoke). */
  revoke(clientId: string, reason?: string): Revocation {
    const cur = this.revoked.get(clientId);
    if (cur) return { ...cur };
    const r: Revocation = { clientId, at: this.now(), region: this.cfg.self, ...(reason ? { reason: reason.slice(0, 200) } : {}) };
    this.revoked.set(clientId, r);
    void this.pushStore();
    return { ...r };
  }

  isRevoked(clientId: string | undefined): boolean {
    return clientId !== undefined && this.revoked.has(clientId);
  }

  revocationList(): Revocation[] {
    return [...this.revoked.values()].map((r) => ({ ...r })).sort((a, b) => a.at - b.at || a.clientId.localeCompare(b.clientId));
  }

  /** Union with remote revocations; returns how many client ids were newly revoked here. */
  mergeRevocations(list: unknown): number {
    if (!Array.isArray(list)) return 0;
    let n = 0;
    for (const r of list as Revocation[]) {
      if (!r || typeof r.clientId !== 'string' || !r.clientId || r.clientId.length > 512 || typeof r.at !== 'number' || !Number.isFinite(r.at) || typeof r.region !== 'string') continue;
      const v: Revocation = { clientId: r.clientId, at: r.at, region: r.region, ...(typeof r.reason === 'string' && r.reason ? { reason: r.reason.slice(0, 200) } : {}) };
      const cur = this.revoked.get(v.clientId);
      if (!cur) {
        this.revoked.set(v.clientId, v);
        n++;
        if (v.region !== this.cfg.self) this.samplePropagation(v);
      } else if (v.at < cur.at) this.revoked.set(v.clientId, v); // keep the earliest notice
    }
    return n;
  }

  /** 16.2.0: the configured (or default) revocation propagation SLO. */
  get revocationSloMs(): number {
    return this.cfg.consistency.revocationSloMs ?? this.cfg.consistency.maxStalenessMs;
  }

  /** 16.2.0: latency of a revocation first seen here, from the issuing region's clock (corrected by its skew). */
  private samplePropagation(r: Revocation): void {
    const now = this.now();
    const skew = this.peers.get(r.region)?.skewMs ?? 0;
    const latencyMs = Math.max(0, Math.round(now - (r.at - skew)));
    const slo = this.revocationSloMs;
    const breached = latencyMs > slo;
    this.propagationCount++;
    if (breached) this.propagationBreaches++;
    this.propagation.push({ clientId: r.clientId, from: r.region, latencyMs, breached, at: new Date(now).toISOString() });
    if (this.propagation.length > 200) this.propagation.splice(0, this.propagation.length - 200);
    if (breached)
      emitOpsEvent({ kind: 'revocation-slo', severity: 'warning', subject: r.clientId, detail: `revocation of ${r.clientId} from region ${r.region} reached ${this.cfg.self} after ${latencyMs} ms (SLO ${slo} ms)`, source: 'regions' });
  }

  /** 16.2.0: revocation propagation against the SLO (quantiles over the last 200 samples; nearest rank). */
  revocationPropagation(): { sloMs: number; samples: number; breaches: number; p50Ms: number | null; p99Ms: number | null; maxMs: number | null; recent: PropagationSample[] } {
    const sorted = this.propagation.map((x) => x.latencyMs).sort((a, b) => a - b);
    const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]! : null);
    return {
      sloMs: this.revocationSloMs,
      samples: this.propagationCount,
      breaches: this.propagationBreaches,
      p50Ms: q(0.5),
      p99Ms: q(0.99),
      maxMs: sorted.length ? sorted[sorted.length - 1]! : null,
      recent: this.propagation.slice(-20).reverse().map((x) => ({ ...x })),
    };
  }

  // ─── region store: share revocations with the other instances of this region (14.5.0) ──────────

  /** Attach this region's shared store (a `MemoryStateStore` is private to the instance and ignored). */
  attachStore(store: StateStore | undefined): void {
    this.store = store && !(store instanceof MemoryStateStore) ? store : undefined;
    if (!this.store) {
      this.storeOkAt = undefined;
      this.storeError = undefined;
    }
  }

  /** Whether a shared region store is attached (14.6.0). */
  hasStore(): boolean {
    return !!this.store;
  }

  private storeKey(): string {
    return `regions:${this.cfg.self}:revocations`;
  }

  /** Union this instance's revocations with the region store's (both ways). */
  async pushStore(): Promise<void> {
    const s = this.store;
    if (!s) return;
    try {
      const raw = await s.get(this.storeKey());
      let stored: Revocation[] = [];
      try {
        stored = raw ? (JSON.parse(raw) as Revocation[]) : [];
      } catch {
        stored = [];
      }
      this.mergeRevocations(stored);
      const known = new Set(Array.isArray(stored) ? stored.map((r) => r?.clientId) : []);
      if (this.revocationList().some((r) => !known.has(r.clientId))) await s.set(this.storeKey(), JSON.stringify(this.revocationList()));
      this.storeOkAt = this.now();
      this.storeError = undefined;
    } catch (e) {
      this.storeError = (e as Error).message;
    }
  }

  // ─── peers, freshness ──────────────────────────────────────────────────────

  peerList(): PeerState[] {
    return [...this.peers.values()].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }

  /** Record a peer's gossip (from an inbound or outbound sync). */
  sawPeer(id: string, servers: unknown, cursor?: number, meta: { now?: unknown; config?: unknown; rollup?: unknown } = {}): void {
    const p = this.peers.get(id);
    if (!p) return;
    const now = this.now();
    p.status = 'up';
    p.failures = 0;
    p.lastSync = new Date(now).toISOString();
    p.lastSyncAt = now;
    delete p.lastError;
    if (Array.isArray(servers)) p.servers = servers.map(String);
    if (typeof cursor === 'number' && Number.isFinite(cursor)) p.cursor = Math.max(p.cursor, Math.min(cursor, now + this.cfg.consistency.maxClockSkewMs));
    if (typeof meta.now === 'number' && Number.isFinite(meta.now)) p.skewMs = Math.round(meta.now - now);
    const c = meta.config as { policyHash?: unknown; generation?: unknown } | undefined;
    if (c && typeof c === 'object') p.config = { ...(typeof c.policyHash === 'string' ? { policyHash: c.policyHash } : {}), ...(typeof c.generation === 'number' ? { generation: c.generation } : {}) };
    if (meta.rollup !== undefined && validRollup(meta.rollup, id)) p.rollup = meta.rollup;
  }

  /** 16.2.0: each peer's latest rollup with its freshness. */
  peerRollups(): Array<{ id: string; rollup?: RegionRollup; fresh: boolean; lagMs: number | null }> {
    const now = this.now();
    const f = this.freshness();
    return this.peerList().map((p) => ({ id: p.id, ...(p.rollup ? { rollup: p.rollup } : {}), fresh: !f.stale.includes(p.id), lagMs: this.lagOf(p, now) }));
  }

  peerFailed(id: string, err: string): void {
    const p = this.peers.get(id);
    if (!p) return;
    p.failures++;
    p.lastError = err;
    if (p.failures >= this.cfg.downAfter) p.status = 'down';
  }

  /** 14.8.0: last freshness seen by {@link freshness} (timeline transitions). */
  private lastFresh: boolean | undefined;

  private lagOf(p: PeerState, now: number): number | null {
    return p.lastSyncAt === undefined ? null : Math.max(0, now - p.lastSyncAt);
  }

  /**
   * Bounded staleness (14.5.0): fresh while every peer exchanged state within `maxStalenessMs` (and, with a shared
   * region store, the store was read within it). A region with no peers is always fresh.
   */
  freshness(): { fresh: boolean; stale: string[]; maxLagMs: number | null; store?: 'ok' | 'stale' } {
    const now = this.now();
    const max = this.cfg.consistency.maxStalenessMs;
    const stale: string[] = [];
    let maxLag: number | null = 0;
    for (const p of this.peerList()) {
      const lag = this.lagOf(p, now);
      if (lag === null || lag > max) stale.push(p.id);
      maxLag = lag === null || maxLag === null ? null : Math.max(maxLag, lag);
    }
    let store: 'ok' | 'stale' | undefined;
    if (this.store) store = this.storeOkAt !== undefined && now - this.storeOkAt <= max ? 'ok' : 'stale';
    const fresh = stale.length === 0 && store !== 'stale';
    // 14.8.0: freshness transitions are incidents on the operations console timeline
    if (this.lastFresh !== undefined && this.lastFresh !== fresh) {
      emitOpsEvent(fresh
        ? { kind: 'region-fresh', severity: 'info', subject: this.cfg.self, detail: 'region is fresh again: every peer synced within maxStalenessMs', source: 'regions' }
        : { kind: 'region-stale', severity: 'error', subject: this.cfg.self, detail: `region is stale (fail closed): ${stale.length ? `peers ${stale.join(', ')}` : 'region store'} behind maxStalenessMs (${max} ms)`, source: 'regions' });
    }
    this.lastFresh = fresh;
    return { fresh, stale, maxLagMs: maxLag, ...(store ? { store } : {}) };
  }

  /** Count a refused tool call (metrics / report). */
  denied(reason: 'stale' | 'revoked'): void {
    this.counters.denied[reason]++;
  }

  stats(): MeshStats {
    return { rejected: { ...this.counters.rejected }, conflicts: this.counters.conflicts, denied: { ...this.counters.denied } };
  }

  /** Where a call to `serverId` should run. */
  route(serverId: string, localOnline: string[]): { target: 'local' } | { target: 'peer'; peer: string; url: string } | { target: 'none' } {
    if (localOnline.includes(serverId)) return { target: 'local' };
    const peer = this.peerList().find((p) => p.status === 'up' && p.servers.includes(serverId));
    return peer ? { target: 'peer', peer: peer.id, url: peer.url } : { target: 'none' };
  }

  /** The payload this region sends in a sync exchange (14.5.0 adds revocations, clock and config fingerprint). */
  exchange(localOnline: string[], extra: SyncExtra = {}): Record<string, unknown> {
    return { region: this.cfg.self, entries: this.delta(0), servers: localOnline, revocations: this.revocationList(), now: this.now(), ...(extra.config ? { config: extra.config } : {}), ...(extra.rollup ? { rollup: extra.rollup } : {}) };
  }

  /** One outbound sync round with every peer. */
  async syncOnce(localOnline: string[], f: typeof fetch = fetch, extra: SyncExtra = {}): Promise<void> {
    await this.pushStore();
    await Promise.all(
      this.peerList().map(async (p) => {
        const conf = this.cfg.peers.find((x) => x.id === p.id);
        try {
          if (partitioned(this.cfg.self, p.id)) throw new Error('partitioned (fault injection)');
          const res = await f(`${p.url.replace(/\/$/, '')}/api/v1/admin/regions/sync`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(conf?.apiKey ? { authorization: `Bearer ${conf.apiKey}` } : {}) },
            body: JSON.stringify({ ...this.exchange(localOnline, extra), since: p.cursor }),
            signal: AbortSignal.timeout(Math.max(1000, this.cfg.syncIntervalMs)),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = (await res.json()) as { entries?: ReplicatedEntry[]; servers?: string[]; revocations?: unknown; now?: unknown; config?: unknown; rollup?: unknown };
          const entries = Array.isArray(body.entries) ? body.entries : [];
          this.merge(entries);
          // 16.2.0: the peer's clock skew is known before its revocations are timed
          this.sawPeer(p.id, body.servers, entries.reduce((m, e) => Math.max(m, typeof e?.ts === 'number' ? e.ts : 0), 0), { now: body.now, config: body.config, rollup: body.rollup });
          if (this.mergeRevocations(body.revocations)) void this.pushStore();
        } catch (e) {
          this.peerFailed(p.id, (e as Error).message);
        }
      }),
    );
  }

  start(localOnline: () => string[], f: typeof fetch = fetch, extra: () => SyncExtra = () => ({})): void {
    this.stop();
    if (!this.cfg.peers.length && !this.store) return;
    this.timer = setInterval(() => void this.syncOnce(localOnline(), f, extra()), this.cfg.syncIntervalMs);
    this.timer.unref?.();
    // first round right away: a region refuses tool calls until it has confirmed it is fresh
    setImmediate(() => void this.syncOnce(localOnline(), f, extra()));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  status(): Record<string, unknown> {
    return { self: this.cfg.self, syncIntervalMs: this.cfg.syncIntervalMs, keys: this.size(), peers: this.peerList(), fresh: this.freshness().fresh, revocations: this.revoked.size };
  }

  /** Consistency report (14.5.0): what `GET /admin/regions/report` and `mcp-gateway regions report` show. */
  report(local: { config?: PeerState['config'] } = {}): Record<string, unknown> {
    const now = this.now();
    const f = this.freshness();
    const c = this.cfg.consistency;
    const conflicted = [...this.entries.values()].filter((e) => e.conflict).map((e) => e.key);
    return {
      self: this.cfg.self,
      fresh: f.fresh,
      onStale: c.onStale,
      maxStalenessMs: c.maxStalenessMs,
      maxClockSkewMs: c.maxClockSkewMs,
      syncIntervalMs: this.cfg.syncIntervalMs,
      maxLagMs: f.maxLagMs,
      ...(f.store ? { store: { status: f.store, ...(this.storeError ? { error: this.storeError } : {}) } } : {}),
      boundaries: { replicated: [...CONSISTENCY_BOUNDARIES.replicated], regionLocal: [...CONSISTENCY_BOUNDARIES.regionLocal] },
      config: local.config ?? {},
      peers: this.peerList().map((p) => {
        const lag = this.lagOf(p, now);
        const drift = !!(local.config?.policyHash && p.config?.policyHash && local.config.policyHash !== p.config.policyHash);
        return {
          id: p.id,
          url: p.url,
          status: p.status,
          fresh: !f.stale.includes(p.id),
          lagMs: lag,
          lastSync: p.lastSync ?? null,
          failures: p.failures,
          ...(p.lastError ? { lastError: p.lastError } : {}),
          skewMs: p.skewMs ?? null,
          clockSkew: p.skewMs === undefined ? 'unknown' : Math.abs(p.skewMs) > c.maxClockSkewMs ? 'exceeded' : 'ok',
          config: p.config ?? null,
          policyDrift: drift,
          servers: p.servers,
        };
      }),
      keys: this.size(),
      conflicts: this.counters.conflicts,
      conflictedKeys: conflicted,
      rejected: { ...this.counters.rejected },
      revocations: this.revoked.size,
      revocationPropagation: this.revocationPropagation(),
      denied: { ...this.counters.denied },
    };
  }

  /** Prometheus lines (14.5.0). */
  prometheus(): string[] {
    const now = this.now();
    const f = this.freshness();
    const out: string[] = [
      '# HELP mcp_gateway_region_fresh 1 while every peer synced within consistency.maxStalenessMs (14.5.0)',
      '# TYPE mcp_gateway_region_fresh gauge',
      `mcp_gateway_region_fresh ${f.fresh ? 1 : 0}`,
      '# HELP mcp_gateway_region_replication_lag_seconds Time since the last successful exchange with each peer',
      '# TYPE mcp_gateway_region_replication_lag_seconds gauge',
    ];
    const peers = this.peerList();
    for (const p of peers) {
      const lag = this.lagOf(p, now);
      out.push(`mcp_gateway_region_replication_lag_seconds{peer="${p.id}"} ${lag === null ? 'NaN' : (lag / 1000).toFixed(3)}`);
    }
    out.push('# HELP mcp_gateway_region_peer_up 1 when the peer answered its last syncs', '# TYPE mcp_gateway_region_peer_up gauge');
    for (const p of peers) out.push(`mcp_gateway_region_peer_up{peer="${p.id}"} ${p.status === 'up' ? 1 : 0}`);
    out.push('# HELP mcp_gateway_region_clock_skew_seconds Peer clock minus local clock at the last exchange', '# TYPE mcp_gateway_region_clock_skew_seconds gauge');
    for (const p of peers) if (p.skewMs !== undefined) out.push(`mcp_gateway_region_clock_skew_seconds{peer="${p.id}"} ${(p.skewMs / 1000).toFixed(3)}`);
    out.push('# HELP mcp_gateway_region_denied_total Tool calls refused by multi-region consistency, by reason', '# TYPE mcp_gateway_region_denied_total counter');
    out.push(`mcp_gateway_region_denied_total{reason="stale"} ${this.counters.denied.stale}`, `mcp_gateway_region_denied_total{reason="revoked"} ${this.counters.denied.revoked}`);
    out.push('# HELP mcp_gateway_region_rejected_entries_total Replicated entries refused, by reason', '# TYPE mcp_gateway_region_rejected_entries_total counter');
    for (const [r, n] of Object.entries(this.counters.rejected)) out.push(`mcp_gateway_region_rejected_entries_total{reason="${r === 'clockSkew' ? 'clock_skew' : r}"} ${n}`);
    out.push('# TYPE mcp_gateway_region_conflicts_total counter', `mcp_gateway_region_conflicts_total ${this.counters.conflicts}`);
    out.push('# TYPE mcp_gateway_region_revocations gauge', `mcp_gateway_region_revocations ${this.revoked.size}`);
    // 16.2.0: revocation propagation SLO
    const rp = this.revocationPropagation();
    const sec = (ms: number | null) => (ms === null ? 'NaN' : (ms / 1000).toFixed(3));
    out.push('# HELP mcp_gateway_region_revocation_slo_seconds Revocation propagation SLO (consistency.revocationSloMs) (16.2.0)', '# TYPE mcp_gateway_region_revocation_slo_seconds gauge', `mcp_gateway_region_revocation_slo_seconds ${sec(rp.sloMs)}`);
    out.push('# HELP mcp_gateway_region_revocation_propagation_seconds Latency of revocations issued in other regions (last 200)', '# TYPE mcp_gateway_region_revocation_propagation_seconds summary');
    out.push(`mcp_gateway_region_revocation_propagation_seconds{quantile="0.5"} ${sec(rp.p50Ms)}`, `mcp_gateway_region_revocation_propagation_seconds{quantile="0.99"} ${sec(rp.p99Ms)}`, `mcp_gateway_region_revocation_propagation_seconds_count ${rp.samples}`);
    out.push('# HELP mcp_gateway_region_revocation_slo_breaches_total Revocations that arrived later than the SLO', '# TYPE mcp_gateway_region_revocation_slo_breaches_total counter', `mcp_gateway_region_revocation_slo_breaches_total ${rp.breaches}`);
    return out;
  }
}

/** Resolve (validate + defaults) a `regions` section. */
export const resolveRegions = (raw: unknown): Resolved => RegionsSchema.parse(raw);

// ─── module wiring ─────────────────────────────────────────────────────────────

interface RegionState {
  mesh?: RegionMesh;
  key?: string;
  ctx?: FeatureContext;
  unsubscribe?: () => void;
  /** 14.6.0: unregisters this module as a revocation authority. */
  unauthority?: () => void;
}
/** 14.5.0: per gateway instance (the call hook finds the mesh of the gateway it runs for). */
const regionState = instanceLocal('regions', 'state', (): RegionState => ({}));

/** Fingerprint of what each region must agree on but keeps locally (policy) plus its config generation. */
function configPrint(ctx: FeatureContext): PeerState['config'] {
  const c = ctx.config() as unknown as Record<string, unknown>;
  const policy = { policies: c.policies ?? null, policy: c.policy ?? null, policyEngine: c.policyEngine ?? null };
  const policyHash = createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16);
  const generation = ctx.reloadState?.().generation;
  return { policyHash, ...(typeof generation === 'number' ? { generation } : {}) };
}

/** 16.2.0: this region's own rollup — cost ledger since the start of the UTC day, kept call lineage by outcome. */
export function rollupOf(ctx: FeatureContext, region: string, now = Date.now()): RegionRollup {
  const d = new Date(now);
  const since = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const c = ctx.costRollup?.(since);
  const zero = { cost: 0, calls: 0, inputTokens: 0, outputTokens: 0 };
  return {
    region,
    asOf: new Date(now).toISOString(),
    costs: { currency: c?.currency ?? (ctx.config() as { costs?: { currency?: string } }).costs?.currency ?? 'USD', since: new Date(since).toISOString(), total: c?.total ?? zero, byTenant: c?.byTenant ?? [] },
    lineage: ctx.lineageSummary?.() ?? { kept: 0, ok: 0, denied: 0, error: 0 },
  };
}

function syncExtra(ctx: FeatureContext, region: string): SyncExtra {
  let rollup: RegionRollup | undefined;
  try {
    rollup = rollupOf(ctx, region);
  } catch {
    rollup = undefined; // a rollup source failing never stops replication
  }
  return { config: configPrint(ctx), ...(rollup ? { rollup } : {}) };
}

function meshFor(state: RegionState): RegionMesh | undefined {
  const ctx = state.ctx;
  if (!ctx) return state.mesh;
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
    else {
      state.mesh?.stop(); // 14.5.0: a renamed region no longer syncs under its old identity
      state.mesh = new RegionMesh(cfg);
    }
    state.key = key;
    try {
      state.mesh.attachStore(ctx.store?.());
    } catch {
      state.mesh.attachStore(undefined);
    }
    const mesh = state.mesh;
    mesh.start(() => ctx.onlineServers?.() ?? [], fetch, () => syncExtra(ctx, mesh.self));
  }
  return state.mesh;
}

registerCallHook({
  id: 'regions',
  before: (call) => {
    const st = regionState;
    const m = meshFor(st);
    if (!m) return;
    const who = call.clientId ?? call.principal?.id;
    if (m.isRevoked(who) || (call.principal?.id && m.isRevoked(call.principal.id))) {
      m.denied('revoked');
      return { refuse: { code: ERR_REGION_REVOKED, message: `Client "${who}" was revoked (replicated multi-region revocation)`, data: { decision: 'region-revoked', region: m.self } } };
    }
    if (m.settings.consistency.onStale === 'deny') {
      const f = m.freshness();
      if (!f.fresh) {
        m.denied('stale');
        return {
          refuse: {
            code: ERR_REGION_STALE,
            message: `Region "${m.self}" cannot confirm its replicated state is fresh (peers ${f.stale.join(', ') || '—'} not synced within ${m.settings.consistency.maxStalenessMs} ms${f.store === 'stale' ? '; region store unreachable' : ''}); refusing (fail closed)`,
            data: { decision: 'region-stale', region: m.self, stale: f.stale, maxLagMs: f.maxLagMs },
          },
        };
      }
    }
  },
});

registerFeature({
  id: 'regions',
  since: '5.2.0',
  summary: 'Multi-region active-active: replicated state and revocations, bounded staleness (fail closed), peer health, cross-region failover routing',
  mount: (router, ctx) => {
    const state = regionState;
    state.ctx = ctx;
    state.unsubscribe?.();
    state.unsubscribe = onRevocation((clientId, reason) => {
      const m = meshFor(state);
      if (m) {
        m.revoke(clientId, reason);
        logger.info(`regions: revocation of ${clientId} recorded for replication`);
      }
    });
    registerMetricSource('regions', () => meshFor(state)?.prometheus() ?? []);
    // 14.8.0: regions health / replication lag on the operations console cluster view
    registerOpsSource('regions', () => {
      const m = meshFor(state);
      if (!m) return null;
      const f = m.freshness();
      const now = m.now();
      return {
        self: m.settings.self,
        fresh: f.fresh,
        stale: f.stale,
        maxLagMs: f.maxLagMs,
        ...(f.store ? { store: f.store } : {}),
        peers: m.peerList().map((p) => ({ id: p.id, status: p.status, lagMs: p.lastSyncAt === undefined ? null : Math.max(0, now - p.lastSyncAt), ...(p.lastError ? { lastError: p.lastError } : {}) })),
        // 16.2.0: region view — every region's costs / lineage summary and the revocation propagation SLO
        rollup: mergeRollups(rollupOf(ctx, m.self), m.peerRollups()),
        revocationPropagation: (({ recent: _r, ...rest }) => rest)(m.revocationPropagation()),
      };
    });
    // 14.6.0: replicated revocations are an authority for deferred work (edge outbox replays on reconnect).
    state.unauthority?.();
    state.unauthority = registerRevocationAuthority('regions', {
      isRevoked: (clientId) => meshFor(state)?.isRevoked(clientId) ?? false,
      confirm: async () => {
        const m = meshFor(state);
        if (!m || (!m.settings.peers.length && !m.hasStore())) return { fresh: true };
        const t0 = m.now();
        await m.syncOnce(ctx.onlineServers?.() ?? [], fetch, syncExtra(ctx, m.self));
        const behind = m.peerList().filter((p) => p.lastSyncAt === undefined || p.lastSyncAt < t0).map((p) => p.id);
        const f = m.freshness();
        if (behind.length) return { fresh: false, detail: `peers not reached since reconnect: ${behind.join(', ')}` };
        if (f.store === 'stale') return { fresh: false, detail: 'region store unreachable' };
        return { fresh: true };
      },
    });
    ctx.onStop?.(() => {
      state.mesh?.stop();
      state.unsubscribe?.();
      state.unsubscribe = undefined;
      state.unauthority?.();
      state.unauthority = undefined;
    });
    // Start syncing as soon as the gateway is up (config may also change later; re-checked on each request).
    setImmediate(() => { try { meshFor(state); } catch { /* invalid config is reported on request */ } });
    const need = (res: import('express').Response) => {
      const m = meshFor(state);
      if (!m) res.status(404).json({ error: 'Not Found', message: 'multi-region is not configured (`regions:`)' });
      return m;
    };
    router.get('/', (_req, res) => {
      const m = need(res);
      if (m) res.json(m.status());
    });
    router.get('/health', (_req, res) => {
      const m = need(res);
      if (!m) return;
      const f = m.freshness();
      res.status(f.fresh ? 200 : 503).json({ region: m.self, ...f, onStale: m.settings.consistency.onStale });
    });
    router.get('/report', (_req, res) => {
      const m = need(res);
      if (m) res.json(m.report({ config: configPrint(ctx) }));
    });
    router.get('/revocations', (_req, res) => {
      const m = need(res);
      if (m) res.json({ region: m.self, revocations: m.revocationList() });
    });
    router.post('/revocations', (req, res) => {
      const m = need(res);
      if (!m) return;
      const b = objectBody(req, res);
      if (!b) return;
      if (typeof b.clientId !== 'string' || !b.clientId || b.clientId.length > 512) return badRequest(res, '"clientId" is required (e.g. "key:ci-bot")');
      if (b.reason !== undefined && typeof b.reason !== 'string') return badRequest(res, '"reason" must be a string');
      const r = m.revoke(b.clientId, b.reason as string | undefined);
      logger.warn(`regions: ${b.clientId} revoked in region ${m.self}${b.reason ? ` (${String(b.reason)})` : ''}`);
      res.json(r);
    });
    router.post('/sync', (req, res) => {
      const m = need(res);
      if (!m) return;
      const b = objectBody(req, res);
      if (!b) return;
      if (typeof b.region !== 'string') return badRequest(res, '"region" is required');
      if (!m.peerList().some((p) => p.id === b.region)) return void res.status(403).json({ error: 'Forbidden', message: `unknown region "${b.region}"` });
      if (partitioned(m.self, b.region)) return void res.status(503).json({ error: 'Service Unavailable', message: 'partitioned (fault injection)' });
      const entries = Array.isArray(b.entries) ? (b.entries as ReplicatedEntry[]) : [];
      m.merge(entries);
      m.sawPeer(b.region, b.servers, entries.reduce((x, e) => Math.max(x, typeof e?.ts === 'number' ? e.ts : 0), 0), { now: b.now, config: b.config, rollup: b.rollup });
      if (m.mergeRevocations(b.revocations)) void m.pushStore();
      const out = m.exchange(ctx.onlineServers?.() ?? [], syncExtra(ctx, m.self));
      res.json({ ...out, entries: m.delta(typeof b.since === 'number' ? b.since : 0) });
    });
    router.get('/kv/:key', (req, res) => {
      const m = need(res);
      if (!m) return;
      const v = m.get(req.params.key!);
      if (v === undefined) return void res.status(404).json({ error: 'Not Found', message: 'no such key' });
      const e = m.entry(req.params.key!)!;
      res.json({ key: req.params.key, value: v, gen: m.generation(req.params.key!), ...(e.vv ? { vv: e.vv } : {}), region: e.region, ...(e.conflict ? { conflict: true } : {}) });
    });
    router.put('/kv/:key', (req, res) => {
      const m = need(res);
      if (!m) return;
      const b = objectBody(req, res);
      if (!b) return;
      if (!('value' in b) || b.value === null) return badRequest(res, '"value" is required (use DELETE to remove)');
      if (b.ifGeneration !== undefined && !(Number.isSafeInteger(b.ifGeneration) && (b.ifGeneration as number) >= 0)) return badRequest(res, '"ifGeneration" must be a non-negative integer');
      try {
        res.json(m.put(req.params.key!, b.value, { ifGeneration: b.ifGeneration as number | undefined }));
      } catch (e) {
        if (!(e instanceof GenerationConflict)) throw e;
        res.status(409).json({ error: 'Conflict', message: e.message, key: e.key, expectedGeneration: e.expected, currentGeneration: e.current });
      }
    });
    router.delete('/kv/:key', (req, res) => {
      const m = need(res);
      if (m) res.json({ deleted: m.delete(req.params.key!) });
    });
    // 16.2.0: cross-region rollup
    router.get('/rollup', (_req, res) => {
      const m = need(res);
      if (!m) return;
      const self = rollupOf(ctx, m.self);
      res.json({ self: m.self, currency: self.costs.currency, ...mergeRollups(self, m.peerRollups()) });
    });
    // 16.2.0: lineage by region-qualified id — this region's own record, or the peer's (fetched with its sync key)
    router.get('/lineage/:globalId', async (req, res) => {
      const m = need(res);
      if (!m) return;
      const g = /^([a-z0-9][a-z0-9-]*):(.{1,200})$/.exec(req.params.globalId ?? '');
      if (!g) return badRequest(res, 'give a region-qualified id: <region>:<requestId> (e.g. eu-west:4f1c…)');
      const [, region, requestId] = g as unknown as [string, string, string];
      const qualify = (l: Record<string, unknown>) => ({ ...l, region, globalId: `${region}:${requestId}` });
      if (region === m.self) {
        const l = ctx.lineage?.(requestId);
        if (!l) return void res.status(404).json({ error: 'Not Found', message: `no call ${requestId} kept in region ${region}` });
        return void res.json(qualify(l as Record<string, unknown>));
      }
      const peer = m.settings.peers.find((p) => p.id === region);
      if (!peer) return void res.status(404).json({ error: 'Not Found', message: `unknown region "${region}"` });
      if (partitioned(m.self, region)) return void res.status(503).json({ error: 'Service Unavailable', message: 'partitioned (fault injection)' });
      try {
        const r = await fetch(`${peer.url.replace(/\/$/, '')}/api/v1/admin/ops/lineage/${encodeURIComponent(requestId)}`, {
          headers: peer.apiKey ? { authorization: `Bearer ${peer.apiKey}` } : {},
          signal: AbortSignal.timeout(Math.max(1000, m.settings.syncIntervalMs)),
        });
        if (r.status === 404) return void res.status(404).json({ error: 'Not Found', message: `no call ${requestId} kept in region ${region}` });
        if (!r.ok) return void res.status(502).json({ error: 'Bad Gateway', message: `region ${region} answered HTTP ${r.status}` });
        res.json(qualify((await r.json()) as Record<string, unknown>));
      } catch (e) {
        res.status(502).json({ error: 'Bad Gateway', message: `region ${region} unreachable: ${(e as Error).message}` });
      }
    });
    router.get('/route/:serverId', (req, res) => {
      const m = need(res);
      if (m) res.json({ serverId: req.params.serverId, ...m.route(req.params.serverId!, ctx.onlineServers?.() ?? []) });
    });
  },
});
