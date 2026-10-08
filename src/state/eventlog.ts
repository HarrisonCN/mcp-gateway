/**
 * Event-sourced state store (9.0, `store.backend: eventlog`).
 *
 * Every mutation (`set`, `incr`, `del`) is appended to `<dir>/events.log` as one JSON line with **absolute**
 * expiry times, then applied to an in-memory map. On start the store loads `<dir>/snapshot.json` and replays the
 * log on top of it, so rate-limit windows, lockouts, MCP session metadata and feature runtime state survive a
 * restart of a single-instance gateway. Every `snapshotEvery` events the live (unexpired) state is written to a new
 * snapshot (atomically: temp file + rename) and the log is truncated (compaction). `fsync: true` flushes each append
 * to disk (durable, slower).
 *
 * @module state/eventlog
 */

import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StateStore } from './store.js';
import { logger } from '../utils/logger.js';

export interface EventLogOptions {
  dir: string;
  /** Compact after this many appended events (default 10 000). */
  snapshotEvery?: number;
  /** fsync every append (default false). */
  fsync?: boolean;
  now?: () => number;
}

type Event = { op: 'set'; k: string; v: string; exp?: number } | { op: 'incr'; k: string; by: number; exp?: number } | { op: 'del'; k: string };
interface Entry {
  value: string;
  expiresAt?: number;
}

export interface EventLogStats {
  kind: 'eventlog';
  dir: string;
  keys: number;
  eventsSinceSnapshot: number;
  totalEvents: number;
  snapshots: number;
  lastSnapshotAt?: string;
  replayed: number;
}

export class EventLogStateStore implements StateStore {
  readonly kind = 'eventlog';
  private readonly data = new Map<string, Entry>();
  private readonly logPath: string;
  private readonly snapPath: string;
  private readonly every: number;
  private readonly now: () => number;
  private fd: number;
  private sinceSnapshot = 0;
  private total = 0;
  private snapshots = 0;
  private lastSnapshotAt?: number;
  private replayed = 0;
  private closed = false;

  constructor(private readonly opts: EventLogOptions) {
    this.now = opts.now ?? Date.now;
    this.every = Math.max(1, opts.snapshotEvery ?? 10_000);
    mkdirSync(opts.dir, { recursive: true });
    this.logPath = join(opts.dir, 'events.log');
    this.snapPath = join(opts.dir, 'snapshot.json');
    this.load();
    this.fd = openSync(this.logPath, 'a');
  }

  private load(): void {
    const t = this.now();
    if (existsSync(this.snapPath)) {
      try {
        const snap = JSON.parse(readFileSync(this.snapPath, 'utf8')) as { at?: number; entries: Array<[string, Entry]> };
        for (const [k, e] of snap.entries) if (e.expiresAt === undefined || e.expiresAt > t) this.data.set(k, e);
        this.lastSnapshotAt = snap.at;
      } catch (err) {
        logger.error(`eventlog: ignoring unreadable snapshot ${this.snapPath}: ${(err as Error).message}`);
      }
    }
    if (existsSync(this.logPath)) {
      const lines = readFileSync(this.logPath, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.apply(JSON.parse(line) as Event);
          this.replayed++;
        } catch {
          // A torn last line (crash mid-write) is skipped.
        }
      }
      this.sinceSnapshot = this.replayed;
    }
  }

  private apply(e: Event): number | undefined {
    if (e.op === 'del') {
      this.data.delete(e.k);
      return undefined;
    }
    if (e.op === 'set') {
      this.data.set(e.k, { value: e.v, expiresAt: e.exp });
      return undefined;
    }
    const cur = this.live(e.k);
    if (!cur) {
      this.data.set(e.k, { value: String(e.by), expiresAt: e.exp });
      return e.by;
    }
    const n = (Number.parseInt(cur.value, 10) || 0) + e.by;
    cur.value = String(n);
    return n;
  }

  private live(key: string): Entry | undefined {
    const e = this.data.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== undefined && e.expiresAt <= this.now()) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }

  private append(e: Event): void {
    if (this.closed) throw new Error('eventlog store is closed');
    appendFileSync(this.fd, JSON.stringify(e) + '\n');
    if (this.opts.fsync) fsyncSync(this.fd);
    this.total++;
    if (++this.sinceSnapshot >= this.every) this.compact();
  }

  /** Write a snapshot of the live state and truncate the log. */
  compact(): void {
    const t = this.now();
    const entries = [...this.data].filter(([, e]) => e.expiresAt === undefined || e.expiresAt > t);
    const tmp = `${this.snapPath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ at: t, entries }));
    renameSync(tmp, this.snapPath);
    closeSync(this.fd);
    writeFileSync(this.logPath, '');
    this.fd = openSync(this.logPath, 'a');
    this.sinceSnapshot = 0;
    this.snapshots++;
    this.lastSnapshotAt = t;
  }

  async incr(key: string, ttlMs: number, by = 1): Promise<number> {
    const exists = !!this.live(key);
    const exp = exists ? this.data.get(key)!.expiresAt : ttlMs > 0 ? this.now() + ttlMs : undefined;
    const e: Event = { op: 'incr', k: key, by, ...(exp !== undefined ? { exp } : {}) };
    this.append(e);
    return this.apply(e)!;
  }

  async get(key: string): Promise<string | undefined> {
    return this.live(key)?.value;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    const e: Event = { op: 'set', k: key, v: value, ...(ttlMs && ttlMs > 0 ? { exp: this.now() + ttlMs } : {}) };
    this.append(e);
    this.apply(e);
  }

  async del(key: string): Promise<void> {
    if (!this.data.has(key)) return;
    const e: Event = { op: 'del', k: key };
    this.append(e);
    this.apply(e);
  }

  async pttl(key: string): Promise<number> {
    const e = this.live(key);
    if (!e) return -2;
    return e.expiresAt === undefined ? -1 : Math.max(0, e.expiresAt - this.now());
  }

  async ping(): Promise<void> {
    if (this.closed) throw new Error('eventlog store is closed');
  }

  stats(): EventLogStats {
    return { kind: 'eventlog', dir: this.opts.dir, keys: this.data.size, eventsSinceSnapshot: this.sinceSnapshot, totalEvents: this.total, snapshots: this.snapshots, lastSnapshotAt: this.lastSnapshotAt ? new Date(this.lastSnapshotAt).toISOString() : undefined, replayed: this.replayed };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.compact();
    closeSync(this.fd);
    this.closed = true;
  }
}
