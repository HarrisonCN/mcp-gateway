/**
 * Persistent audit log of request records.
 *
 * Optional and off by default. The built-in store uses SQLite through Node's
 * own `node:sqlite` module (Node 22.5+), so the gateway gains no dependency
 * and nothing native is compiled on install. On older Node versions enabling
 * the audit log fails at startup with a clear message; embedders can pass any
 * {@link AuditStore} implementation to `MetricsCollector#setAuditStore`.
 *
 * Only metadata is stored (time, server, tool / URI / prompt, duration,
 * outcome, error message, client id, interface) — never call arguments or
 * results, which may contain secrets.
 *
 * @module monitor/audit
 */

import { createRequire } from 'module';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import type { RequestMetric } from '../utils/types.js';

export interface AuditQuery {
  /** Max records (newest first). */
  limit: number;
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string;
  /** Inclusive lower / exclusive upper time bounds (ms epoch). */
  since?: number;
  until?: number;
  server?: string;
  tool?: string;
  clientId?: string;
  success?: boolean;
  via?: 'rest' | 'mcp';
  kind?: 'tool' | 'resource' | 'prompt';
}

export interface AuditPage {
  requests: RequestMetric[];
  /** Pass as `cursor` to get the next (older) page. */
  nextCursor?: string;
}

export interface AuditStore {
  readonly kind: string;
  append(record: RequestMetric): void;
  query(q: AuditQuery): AuditPage;
  /** Delete records older than `cutoffMs`; returns the number removed. */
  prune(cutoffMs: number): number;
  close(): void;
}

/** Whether a record matches the non-cursor filters of a query. */
export function matchesQuery(m: RequestMetric, q: AuditQuery): boolean {
  const t = m.timestamp.getTime();
  if (q.since !== undefined && t < q.since) return false;
  if (q.until !== undefined && t >= q.until) return false;
  if (q.server !== undefined && m.serverId !== q.server) return false;
  if (q.tool !== undefined && m.toolName !== q.tool) return false;
  if (q.clientId !== undefined && m.clientId !== q.clientId) return false;
  if (q.success !== undefined && m.success !== q.success) return false;
  if (q.via !== undefined && (m.via ?? 'rest') !== q.via) return false;
  if (q.kind !== undefined && (m.kind ?? 'tool') !== q.kind) return false;
  return true;
}

// ─── node:sqlite ──────────────────────────────────────────────────────────────

export interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint };
  all(...params: unknown[]): Array<Record<string, unknown>>;
}
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
export type SqliteModule = { DatabaseSync: new (path: string) => SqliteDatabase };

export function loadSqlite(): SqliteModule | undefined {
  try {
    const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    const mod = getBuiltin ? getBuiltin('node:sqlite') : createRequire(import.meta.url)('node:sqlite');
    return mod && typeof (mod as SqliteModule).DatabaseSync === 'function' ? (mod as SqliteModule) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the built-in SQLite store can be used on this Node version. */
export function sqliteAvailable(): boolean {
  return loadSqlite() !== undefined;
}

export class SqliteAuditStore implements AuditStore {
  readonly kind = 'sqlite';
  private readonly db: SqliteDatabase;
  private readonly insert: SqliteStatement;

  constructor(readonly path: string) {
    const sqlite = loadSqlite();
    if (!sqlite) {
      throw new Error(
        `audit.enabled requires the built-in node:sqlite module (Node.js 22.5 or newer); this is Node ${process.versions.node}`,
      );
    }
    const file = path === ':memory:' ? path : resolve(path);
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new sqlite.DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS requests (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        ts INTEGER NOT NULL,
        server TEXT NOT NULL,
        tool TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'tool',
        duration_ms INTEGER NOT NULL,
        success INTEGER NOT NULL,
        error TEXT,
        client_id TEXT,
        via TEXT
      );
      CREATE INDEX IF NOT EXISTS requests_ts ON requests (ts);
      CREATE INDEX IF NOT EXISTS requests_server ON requests (server, ts);
      CREATE INDEX IF NOT EXISTS requests_client ON requests (client_id, ts);
    `);
    // 13.1.2: delegation chain columns (added to databases created by older versions).
    const cols = new Set((this.db.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>).map((c) => String(c.name)));
    if (!cols.has('actor')) this.db.exec('ALTER TABLE requests ADD COLUMN actor TEXT');
    if (!cols.has('chain')) this.db.exec('ALTER TABLE requests ADD COLUMN chain TEXT');
    // 13.1.3: traceable refusal reason + error code.
    if (!cols.has('decision')) this.db.exec('ALTER TABLE requests ADD COLUMN decision TEXT');
    if (!cols.has('error_code')) this.db.exec('ALTER TABLE requests ADD COLUMN error_code INTEGER');
    this.insert = this.db.prepare(
      'INSERT OR IGNORE INTO requests (id, ts, server, tool, kind, duration_ms, success, error, client_id, via, actor, chain, decision, error_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
  }

  append(m: RequestMetric): void {
    this.insert.run(
      m.id,
      m.timestamp.getTime(),
      m.serverId,
      m.toolName,
      m.kind ?? 'tool',
      Math.round(m.durationMs),
      m.success ? 1 : 0,
      m.errorMessage ?? null,
      m.clientId ?? null,
      m.via ?? null,
      m.actor ?? null,
      m.chain?.length ? JSON.stringify(m.chain) : null,
      m.decision ?? null,
      m.errorCode ?? null,
    );
  }

  query(q: AuditQuery): AuditPage {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      where.push(sql);
      params.push(v);
    };
    if (q.cursor !== undefined) {
      const seq = /^s(\d+)$/.exec(q.cursor);
      if (!seq) throw new RangeError('invalid cursor');
      add('seq < ?', Number(seq[1]));
    }
    if (q.since !== undefined) add('ts >= ?', q.since);
    if (q.until !== undefined) add('ts < ?', q.until);
    if (q.server !== undefined) add('server = ?', q.server);
    if (q.tool !== undefined) add('tool = ?', q.tool);
    if (q.clientId !== undefined) add('client_id = ?', q.clientId);
    if (q.success !== undefined) add('success = ?', q.success ? 1 : 0);
    if (q.via !== undefined) add("COALESCE(via, 'rest') = ?", q.via);
    if (q.kind !== undefined) add('kind = ?', q.kind);
    const sql =
      'SELECT * FROM requests' + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ' ORDER BY seq DESC LIMIT ?';
    const rows = this.db.prepare(sql).all(...params, q.limit + 1);
    const page = rows.slice(0, q.limit);
    const requests = page.map((r) => {
      const m: RequestMetric = {
        id: String(r.id),
        timestamp: new Date(Number(r.ts)),
        serverId: String(r.server),
        toolName: String(r.tool),
        durationMs: Number(r.duration_ms),
        success: Number(r.success) === 1,
      };
      if (r.error !== null && r.error !== undefined) m.errorMessage = String(r.error);
      if (r.client_id !== null && r.client_id !== undefined) m.clientId = String(r.client_id);
      if (r.via !== null && r.via !== undefined) m.via = r.via as RequestMetric['via'];
      if (r.kind && r.kind !== 'tool') m.kind = r.kind as RequestMetric['kind'];
      if (r.actor !== null && r.actor !== undefined) m.actor = String(r.actor);
      if (r.decision !== null && r.decision !== undefined) m.decision = String(r.decision);
      if (r.error_code !== null && r.error_code !== undefined) m.errorCode = Number(r.error_code);
      if (typeof r.chain === 'string') {
        try {
          m.chain = JSON.parse(r.chain) as string[];
        } catch {
          /* ignore a damaged row */
        }
      }
      return m;
    });
    const last = page[page.length - 1];
    return rows.length > q.limit && last ? { requests, nextCursor: `s${String(last.seq)}` } : { requests };
  }

  prune(cutoffMs: number): number {
    return Number(this.db.prepare('DELETE FROM requests WHERE ts < ?').run(cutoffMs).changes);
  }

  close(): void {
    this.db.close();
  }
}
