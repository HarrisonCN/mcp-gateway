/**
 * Redis-backed `StateStore` with a small built-in RESP2 client (no extra
 * dependency). Supports `redis://` and `rediss://` (TLS) URLs with optional
 * `user:password@` credentials and a `/db` number. Commands are pipelined on
 * one connection; the connection is re-established lazily after an error.
 *
 * @module state/redis
 */

import { connect as netConnect, type Socket } from 'net';
import { connect as tlsConnect } from 'tls';
import type { StateStore } from './store.js';
import { logger } from '../utils/logger.js';

export type RespValue = string | number | null | RespValue[] | RespError;

export class RespError extends Error {}

interface Pending {
  resolve: (v: RespValue) => void;
  reject: (e: Error) => void;
}

/** Incremental RESP2 parser. Returns parsed values and leaves partial data buffered. */
export class RespParser {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): RespValue[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: RespValue[] = [];
    for (;;) {
      const r = this.parse(0);
      if (!r) break;
      out.push(r.value);
      this.buf = this.buf.subarray(r.end);
    }
    return out;
  }

  private line(from: number): { text: string; end: number } | undefined {
    const i = this.buf.indexOf('\r\n', from);
    if (i < 0) return undefined;
    return { text: this.buf.toString('utf8', from, i), end: i + 2 };
  }

  private parse(at: number): { value: RespValue; end: number } | undefined {
    if (at >= this.buf.length) return undefined;
    const type = String.fromCharCode(this.buf[at]!);
    const l = this.line(at + 1);
    if (!l) return undefined;
    switch (type) {
      case '+':
        return { value: l.text, end: l.end };
      case '-':
        return { value: new RespError(l.text), end: l.end };
      case ':':
        return { value: Number(l.text), end: l.end };
      case '$': {
        const len = Number(l.text);
        if (len < 0) return { value: null, end: l.end };
        if (this.buf.length < l.end + len + 2) return undefined;
        return { value: this.buf.toString('utf8', l.end, l.end + len), end: l.end + len + 2 };
      }
      case '*': {
        const n = Number(l.text);
        if (n < 0) return { value: null, end: l.end };
        const items: RespValue[] = [];
        let end = l.end;
        for (let i = 0; i < n; i++) {
          const r = this.parse(end);
          if (!r) return undefined;
          items.push(r.value);
          end = r.end;
        }
        return { value: items, end };
      }
      default:
        throw new Error(`RESP protocol error: unexpected type byte "${type}"`);
    }
  }
}

export function encodeCommand(args: Array<string | number>): Buffer {
  const parts = [`*${args.length}\r\n`];
  for (const a of args) {
    const s = String(a);
    parts.push(`$${Buffer.byteLength(s)}\r\n${s}\r\n`);
  }
  return Buffer.from(parts.join(''));
}

export interface RedisOptions {
  url: string;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
}

/**
 * Minimal pipelining Redis client.
 *
 * 10.9.7 (MGW-2026-012): every connection owns its reply queue and parser. Replies are matched to commands strictly in the order
 * they were written ON THAT SOCKET, so a connection that dies (command timeout, reset) can only fail the commands it
 * carried — never a command already written to its replacement, and a late reply can never be handed to a later
 * command (before 10.9.7 the queue was shared: after a timeout + reconnect, a reply could be delivered to the wrong
 * command, e.g. `GET a` answered with b's value — MGW-2026-012).
 */
interface Conn {
  socket: Socket;
  queue: Pending[];
  parser: RespParser;
  /** Set once the socket is gone: further writes are refused instead of queued. */
  dead: boolean;
}

export class RedisClient {
  private conn?: Conn;
  private connecting?: Promise<Conn>;
  private closed = false;
  private readonly url: URL;

  constructor(private readonly options: RedisOptions) {
    this.url = new URL(options.url);
    if (this.url.protocol !== 'redis:' && this.url.protocol !== 'rediss:') {
      throw new Error(`state.redis.url must start with redis:// or rediss:// (got ${this.url.protocol})`);
    }
  }

  private static failAll(conn: Conn, err: Error): void {
    conn.dead = true;
    const q = conn.queue;
    conn.queue = [];
    for (const p of q) p.reject(err);
  }

  /** Number of commands waiting for a reply on the current connection (for tests / monitoring). */
  get pending(): number {
    return this.conn?.queue.length ?? 0;
  }

  private open(): Promise<Conn> {
    if (this.conn && !this.conn.dead && !this.conn.socket.destroyed) return Promise.resolve(this.conn);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<Conn>((resolve, reject) => {
      const port = Number(this.url.port || 6379);
      const host = this.url.hostname.replace(/^\[|\]$/g, '');
      const socket =
        this.url.protocol === 'rediss:' ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });
      const timer = setTimeout(() => socket.destroy(new Error('Redis connect timeout')), this.options.connectTimeoutMs ?? 5_000);
      timer.unref();
      const conn: Conn = { socket, queue: [], parser: new RespParser(), dead: false };
      socket.on('data', (chunk: Buffer) => {
        let values: RespValue[];
        try {
          values = conn.parser.push(chunk);
        } catch (err) {
          socket.destroy(err as Error);
          return;
        }
        for (const v of values) {
          const p = conn.queue.shift();
          if (!p) {
            // A reply nobody waits for means this connection's stream is out of step: never trust it again.
            socket.destroy();
            return;
          }
          if (v instanceof RespError) p.reject(v);
          else p.resolve(v);
        }
      });
      socket.on('error', (err) => {
        logger.debug(`Redis connection error: ${err.message}`);
      });
      socket.on('close', () => {
        if (this.conn === conn) this.conn = undefined;
        RedisClient.failAll(conn, new Error('Redis connection closed'));
      });
      socket.once(this.url.protocol === 'rediss:' ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer);
        this.conn = conn;
        resolve(conn);
      });
      socket.once('close', () => {
        clearTimeout(timer);
        reject(new Error(`Could not connect to Redis at ${host}:${port}`));
      });
    })
      .then(async (conn) => {
        const user = decodeURIComponent(this.url.username);
        const pass = decodeURIComponent(this.url.password);
        try {
          if (pass) await this.raw(conn, user ? ['AUTH', user, pass] : ['AUTH', pass]);
          const db = this.url.pathname.replace(/^\//, '');
          if (db && db !== '0') await this.raw(conn, ['SELECT', db]);
        } catch (err) {
          // Never keep a half-initialised (unauthenticated / wrong-db) connection around: the next
          // command would reuse it and skip AUTH / SELECT.
          if (this.conn === conn) this.conn = undefined;
          conn.socket.destroy();
          throw err;
        }
        if (this.closed) {
          conn.socket.destroy();
          throw new Error('Redis client is closed');
        }
        return conn;
      })
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }

  private raw(conn: Conn, args: Array<string | number>): Promise<RespValue> {
    return new Promise<RespValue>((resolve, reject) => {
      if (conn.dead || conn.socket.destroyed) {
        reject(new Error('Redis connection closed'));
        return;
      }
      const timer = setTimeout(() => {
        reject(new Error(`Redis command timed out: ${String(args[0])}`));
        // The reply may still arrive later: the whole connection is discarded so it can never be matched to
        // another command (its other pending commands fail with "connection closed").
        if (this.conn === conn) this.conn = undefined;
        conn.dead = true;
        conn.socket.destroy();
      }, this.options.commandTimeoutMs ?? 5_000);
      timer.unref();
      conn.queue.push({
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      conn.socket.write(encodeCommand(args));
    });
  }

  async command(...args: Array<string | number>): Promise<RespValue> {
    if (this.closed) throw new Error('Redis client is closed');
    const conn = await this.open();
    return this.raw(conn, args);
  }

  /** Run commands inside MULTI / EXEC; resolves with the EXEC reply array. */
  async transaction(commands: Array<Array<string | number>>): Promise<RespValue[]> {
    if (this.closed) throw new Error('Redis client is closed');
    const conn = await this.open();
    const replies = [this.raw(conn, ['MULTI']), ...commands.map((c) => this.raw(conn, c)), this.raw(conn, ['EXEC'])];
    const all = await Promise.all(replies);
    const exec = all[all.length - 1];
    if (!Array.isArray(exec)) throw new Error('Redis transaction aborted');
    for (const v of exec) if (v instanceof RespError) throw v;
    return exec;
  }

  async close(): Promise<void> {
    this.closed = true;
    const c = this.conn;
    this.conn = undefined;
    if (c && !c.socket.destroyed) {
      await new Promise<void>((resolve) => {
        c.socket.once('close', () => resolve());
        c.socket.end(encodeCommand(['QUIT']));
        setTimeout(() => c.socket.destroy(), 500).unref();
      });
    }
    if (c) RedisClient.failAll(c, new Error('Redis client is closed'));
  }
}

export class RedisStateStore implements StateStore {
  readonly kind = 'redis';
  readonly client: RedisClient;

  constructor(options: RedisOptions) {
    this.client = new RedisClient(options);
  }

  async incr(key: string, ttlMs: number, by = 1): Promise<number> {
    const ttl = Math.max(1, Math.ceil(ttlMs));
    const replies = await this.client.transaction([
      ['SET', key, '0', 'PX', ttl, 'NX'],
      ['INCRBY', key, by],
    ]);
    return Number(replies[1]);
  }

  async get(key: string): Promise<string | undefined> {
    const v = await this.client.command('GET', key);
    return v === null ? undefined : String(v);
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    if (ttlMs && ttlMs > 0) await this.client.command('SET', key, value, 'PX', Math.ceil(ttlMs));
    else await this.client.command('SET', key, value);
  }

  async del(key: string): Promise<void> {
    await this.client.command('DEL', key);
  }

  async pttl(key: string): Promise<number> {
    return Number(await this.client.command('PTTL', key));
  }

  async ping(): Promise<void> {
    await this.client.command('PING');
  }

  close(): Promise<void> {
    return this.client.close();
  }
}
