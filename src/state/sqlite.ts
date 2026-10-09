/**
 * SQLite state store (11.2): durable, single-node shared state on Node's built-in `node:sqlite` (Node 22.5+), for
 * deployments that need state (e.g. agent-token revocations) to survive restarts without running Redis.
 * Several gateway processes on ONE host may share the file (WAL mode, busy timeout); for several hosts use Redis.
 *
 * ```yaml
 * store: { backend: sqlite, sqlite: { path: .mcp-gateway/state.db } }
 * ```
 *
 * @module state/sqlite
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadSqlite, type SqliteDatabase, type SqliteStatement } from '../monitor/audit.js';
import type { StateStore } from './store.js';

export class SqliteStateStore implements StateStore {
  readonly kind = 'sqlite';
  private readonly db: SqliteDatabase;
  private readonly q: Record<'get' | 'upsert' | 'del' | 'purge' | 'insertNew' | 'add', SqliteStatement>;
  private closed = false;

  constructor(readonly path: string) {
    const mod = loadSqlite();
    if (!mod) throw new Error('store.backend "sqlite" needs Node 22.5+ (node:sqlite)');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new mod.DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER)');
    this.q = {
      get: this.db.prepare('SELECT v, exp FROM kv WHERE k = ?'),
      upsert: this.db.prepare('INSERT INTO kv (k, v, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp'),
      del: this.db.prepare('DELETE FROM kv WHERE k = ?'),
      purge: this.db.prepare('DELETE FROM kv WHERE exp IS NOT NULL AND exp <= ?'),
      insertNew: this.db.prepare('INSERT INTO kv (k, v, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO NOTHING'),
      add: this.db.prepare('UPDATE kv SET v = CAST(CAST(v AS INTEGER) + ? AS TEXT) WHERE k = ?'),
    };
  }

  private live(key: string, now = Date.now()): { v: string; exp: number | null } | undefined {
    this.check();
    const row = this.q.get.all(key)[0] as { v: string; exp: number | null } | undefined;
    if (!row) return undefined;
    if (row.exp !== null && row.exp <= now) {
      this.q.del.run(key);
      return undefined;
    }
    return row;
  }

  private check(): void {
    if (this.closed) throw new Error('sqlite state store is closed');
  }

  async incr(key: string, ttlMs: number, by = 1): Promise<number> {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.live(key, now)) this.q.upsert.run(key, '0', now + ttlMs);
      this.q.add.run(by, key);
      const v = Number(this.live(key, now)!.v);
      this.db.exec('COMMIT');
      return v;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async get(key: string): Promise<string | undefined> {
    return this.live(key)?.v;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.check();
    this.q.upsert.run(key, value, ttlMs === undefined ? null : Date.now() + ttlMs);
  }

  async del(key: string): Promise<void> {
    this.check();
    this.q.del.run(key);
  }

  async pttl(key: string): Promise<number> {
    const r = this.live(key);
    if (!r) return -2;
    return r.exp === null ? -1 : Math.max(0, r.exp - Date.now());
  }

  async ping(): Promise<void> {
    this.check();
    this.q.purge.run(Date.now());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
