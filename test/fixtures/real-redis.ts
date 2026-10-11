/**
 * 13.7.0: real Redis for the multi-instance reliability tests, plus a TCP fault-injection proxy (toxiproxy-style).
 *
 * `startRealRedis()` spawns a throw-away `redis-server` (no persistence) on a free port when the binary is on PATH
 * (`MGW_REDIS_SERVER` overrides it); CI's "Multi-instance reliability (real Redis)" job installs it. `redisServerAvailable`
 * tells the suite whether it can run — tests that need to kill / restart the server cannot use a shared `REDIS_URL`.
 *
 * `startFaultProxy(target)` forwards TCP to `target` and lets a test inject faults: `latency(ms)`, `blackhole()` (accept
 * and read, never forward or answer: a stalled server / one-way partition), `reset()` (drop every open connection),
 * `refuse()` (drop new connections too: a hard partition) and `heal()`.
 *
 * @module test/fixtures/real-redis
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, connect, type Server, type Socket, type AddressInfo } from 'node:net';

const BIN = process.env.MGW_REDIS_SERVER ?? 'redis-server';
export const redisServerAvailable = spawnSync(BIN, ['--version'], { stdio: 'ignore' }).status === 0;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RealRedis {
  port: number;
  /** `redis://[:password@]127.0.0.1:<port>` (append `/<db>` for a database). */
  url: string;
  /** Run one command on a fresh connection (test-side helper, independent of the gateway's client). */
  cmd(...args: string[]): Promise<string | number | null | unknown[]>;
  /** SIGKILL the server (in-memory data is lost, like a crash without persistence). */
  kill(): Promise<void>;
  /** Start it again on the same port (empty dataset). */
  restart(): Promise<void>;
  close(): Promise<void>;
}

export async function startRealRedis(opts: { password?: string } = {}): Promise<RealRedis> {
  const port = await freePort();
  let child: ChildProcess | undefined;
  const args = ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--protected-mode', 'no', ...(opts.password ? ['--requirepass', opts.password] : [])];
  const up = async () => {
    child = spawn(BIN, args, { stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await rawCmd(port, opts.password, ['PING'])) === 'PONG') return;
      } catch {
        /* not up yet */
      }
      await sleep(50);
    }
    throw new Error('redis-server did not start');
  };
  const down = async () => {
    const c = child;
    child = undefined;
    if (!c || c.exitCode !== null) return;
    await new Promise<void>((r) => {
      c.once('exit', () => r());
      c.kill('SIGKILL');
    });
  };
  await up();
  return {
    port,
    url: `redis://${opts.password ? `:${encodeURIComponent(opts.password)}@` : ''}127.0.0.1:${port}`,
    cmd: (...a) => rawCmd(port, opts.password, a),
    kill: down,
    restart: up,
    close: down,
  };
}

/** Minimal one-shot RESP client (test side). */
function rawCmd(port: number, password: string | undefined, args: string[]): Promise<string | number | null | unknown[]> {
  return new Promise((resolve, reject) => {
    const s = connect({ host: '127.0.0.1', port });
    const cmds = [...(password ? [['AUTH', password]] : []), args];
    let buf = '';
    s.setTimeout(2000, () => s.destroy(new Error('timeout')));
    s.on('error', reject);
    s.on('connect', () => {
      for (const c of cmds) s.write(`*${c.length}\r\n${c.map((x) => `$${Buffer.byteLength(x)}\r\n${x}\r\n`).join('')}`);
    });
    s.on('data', (d) => {
      buf += d.toString('utf8');
      const replies = parseAll(buf);
      if (replies && replies.length >= cmds.length) {
        s.end();
        const r = replies[cmds.length - 1];
        if (r instanceof Error) reject(r);
        else resolve(r as string | number | null | unknown[]);
      }
    });
  });
}

function parseAll(buf: string): unknown[] | undefined {
  const out: unknown[] = [];
  let i = 0;
  const one = (): unknown => {
    const nl = buf.indexOf('\r\n', i);
    if (nl < 0) throw new RangeError();
    const t = buf[i];
    const line = buf.slice(i + 1, nl);
    i = nl + 2;
    if (t === '+') return line;
    if (t === '-') return new Error(line);
    if (t === ':') return Number(line);
    if (t === '$') {
      const n = Number(line);
      if (n < 0) return null;
      if (buf.length < i + n + 2) throw new RangeError();
      const v = buf.slice(i, i + n);
      i += n + 2;
      return v;
    }
    if (t === '*') {
      const n = Number(line);
      const a: unknown[] = [];
      for (let k = 0; k < n; k++) a.push(one());
      return a;
    }
    throw new Error(`bad RESP ${t}`);
  };
  try {
    while (i < buf.length) out.push(one());
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
  }
  return out;
}

export interface FaultProxy {
  port: number;
  /** URL for a Redis client going through the proxy (same credentials as `targetUrl`). */
  url(targetUrl: string): string;
  latency(ms: number): void;
  blackhole(): void;
  reset(): void;
  refuse(): void;
  heal(): void;
  /** Connections accepted so far (reconnect counter). */
  readonly accepted: number;
  close(): Promise<void>;
}

export async function startFaultProxy(targetPort: number): Promise<FaultProxy> {
  let mode: 'ok' | 'blackhole' | 'refuse' = 'ok';
  let delay = 0;
  let accepted = 0;
  const pairs = new Set<[Socket, Socket]>();
  const server: Server = createServer((client) => {
    accepted++;
    if (mode === 'refuse') return void client.destroy();
    const upstream = connect({ host: '127.0.0.1', port: targetPort });
    const pair: [Socket, Socket] = [client, upstream];
    pairs.add(pair);
    const drop = () => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.on('error', drop).on('close', drop);
    upstream.on('error', drop).on('close', drop);
    const pipe = (from: Socket, to: Socket) =>
      from.on('data', (d) => {
        if (mode === 'blackhole') return; // swallowed: the peer never sees it
        if (delay > 0) setTimeout(() => !to.destroyed && to.write(d), delay);
        else if (!to.destroyed) to.write(d);
      });
    pipe(client, upstream);
    pipe(upstream, client);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const resetAll = () => {
    for (const [a, b] of pairs) {
      a.destroy();
      b.destroy();
    }
    pairs.clear();
  };
  return {
    port,
    url: (targetUrl) => {
      const u = new URL(targetUrl);
      u.port = String(port);
      return u.toString().replace(/\/$/, '');
    },
    latency: (ms) => void (delay = ms),
    blackhole: () => void (mode = 'blackhole'),
    reset: resetAll,
    refuse: () => {
      mode = 'refuse';
      resetAll();
    },
    heal: () => {
      mode = 'ok';
      delay = 0;
    },
    get accepted() {
      return accepted;
    },
    close: () =>
      new Promise<void>((r) => {
        resetAll();
        server.close(() => r());
      }),
  };
}
