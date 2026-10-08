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

/** Minimal pipelining Redis client. */
export class RedisClient {
  private socket?: Socket;
  private connecting?: Promise<Socket>;
  private queue: Pending[] = [];
  private parser = new RespParser();
  private closed = false;
  private readonly url: URL;

  constructor(private readonly options: RedisOptions) {
    this.url = new URL(options.url);
    if (this.url.protocol !== 'redis:' && this.url.protocol !== 'rediss:') {
      throw new Error(`state.redis.url must start with redis:// or rediss:// (got ${this.url.protocol})`);
    }
  }

  private failAll(err: Error): void {
    const q = this.queue;
    this.queue = [];
    for (const p of q) p.reject(err);
  }

  private open(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<Socket>((resolve, reject) => {
      const port = Number(this.url.port || 6379);
      const host = this.url.hostname.replace(/^\[|\]$/g, '');
      const socket =
        this.url.protocol === 'rediss:' ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });
      const timer = setTimeout(() => socket.destroy(new Error('Redis connect timeout')), this.options.connectTimeoutMs ?? 5_000);
      timer.unref();
      this.parser = new RespParser();
      socket.on('data', (chunk: Buffer) => {
        let values: RespValue[];
        try {
          values = this.parser.push(chunk);
        } catch (err) {
          socket.destroy(err as Error);
          return;
        }
        for (const v of values) {
          const p = this.queue.shift();
          if (!p) continue;
          if (v instanceof RespError) p.reject(v);
          else p.resolve(v);
        }
      });
      socket.on('error', (err) => {
        logger.debug(`Redis connection error: ${err.message}`);
      });
      socket.on('close', () => {
        if (this.socket === socket) this.socket = undefined;
        this.failAll(new Error('Redis connection closed'));
      });
      socket.once(this.url.protocol === 'rediss:' ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer);
        this.socket = socket;
        resolve(socket);
      });
      socket.once('close', () => {
        clearTimeout(timer);
        reject(new Error(`Could not connect to Redis at ${host}:${port}`));
      });
    })
      .then(async (socket) => {
        const user = decodeURIComponent(this.url.username);
        const pass = decodeURIComponent(this.url.password);
        try {
          if (pass) await this.raw(socket, user ? ['AUTH', user, pass] : ['AUTH', pass]);
          const db = this.url.pathname.replace(/^\//, '');
          if (db && db !== '0') await this.raw(socket, ['SELECT', db]);
        } catch (err) {
          // Never keep a half-initialised (unauthenticated / wrong-db) connection around: the next
          // command would reuse it and skip AUTH / SELECT.
          if (this.socket === socket) this.socket = undefined;
          socket.destroy();
          throw err;
        }
        if (this.closed) {
          socket.destroy();
          throw new Error('Redis client is closed');
        }
        return socket;
      })
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }

  private raw(socket: Socket, args: Array<string | number>): Promise<RespValue> {
    return new Promise<RespValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Redis command timed out: ${String(args[0])}`));
        socket.destroy();
      }, this.options.commandTimeoutMs ?? 5_000);
      timer.unref();
      this.queue.push({
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      socket.write(encodeCommand(args));
    });
  }

  async command(...args: Array<string | number>): Promise<RespValue> {
    if (this.closed) throw new Error('Redis client is closed');
    const socket = await this.open();
    return this.raw(socket, args);
  }

  /** Run commands inside MULTI / EXEC; resolves with the EXEC reply array. */
  async transaction(commands: Array<Array<string | number>>): Promise<RespValue[]> {
    if (this.closed) throw new Error('Redis client is closed');
    const socket = await this.open();
    const replies = [this.raw(socket, ['MULTI']), ...commands.map((c) => this.raw(socket, c)), this.raw(socket, ['EXEC'])];
    const all = await Promise.all(replies);
    const exec = all[all.length - 1];
    if (!Array.isArray(exec)) throw new Error('Redis transaction aborted');
    for (const v of exec) if (v instanceof RespError) throw v;
    return exec;
  }

  async close(): Promise<void> {
    this.closed = true;
    const s = this.socket;
    this.socket = undefined;
    if (s && !s.destroyed) {
      await new Promise<void>((resolve) => {
        s.once('close', () => resolve());
        s.end(encodeCommand(['QUIT']));
        setTimeout(() => s.destroy(), 500).unref();
      });
    }
    this.failAll(new Error('Redis client is closed'));
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
