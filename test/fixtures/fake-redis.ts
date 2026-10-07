/**
 * Tiny in-process Redis stand-in speaking RESP2: enough of GET / SET (PX, NX) /
 * INCRBY / DEL / PTTL / PING / AUTH / SELECT / MULTI / EXEC / QUIT for the
 * state-store tests.
 */
import { createServer, type Server, type Socket } from 'net';
import type { AddressInfo } from 'net';
import { RespParser, type RespValue } from '../../src/state/redis.js';

export interface FakeRedis {
  url: string;
  commands: string[][];
  close(): Promise<void>;
}

export async function startFakeRedis(opts: { password?: string } = {}): Promise<FakeRedis> {
  const data = new Map<string, { v: string; exp?: number }>();
  const commands: string[][] = [];
  const sockets = new Set<Socket>();
  const live = (k: string) => {
    const e = data.get(k);
    if (e && e.exp !== undefined && e.exp <= Date.now()) {
      data.delete(k);
      return undefined;
    }
    return e;
  };
  const bulk = (v: string | undefined) => (v === undefined ? '$-1\r\n' : `$${Buffer.byteLength(v)}\r\n${v}\r\n`);
  const exec = (args: string[], authed: { ok: boolean }): string => {
    const cmd = args[0]!.toUpperCase();
    if (opts.password && !authed.ok && cmd !== 'AUTH') return '-NOAUTH Authentication required.\r\n';
    switch (cmd) {
      case 'AUTH':
        if (args[args.length - 1] === opts.password) {
          authed.ok = true;
          return '+OK\r\n';
        }
        return '-WRONGPASS invalid password\r\n';
      case 'PING':
        return '+PONG\r\n';
      case 'SELECT':
      case 'QUIT':
        return '+OK\r\n';
      case 'GET':
        return bulk(live(args[1]!)?.v);
      case 'SET': {
        const [, k, v, ...rest] = args as [string, string, string, ...string[]];
        let exp: number | undefined;
        let nx = false;
        for (let i = 0; i < rest.length; i++) {
          if (rest[i]!.toUpperCase() === 'PX') exp = Date.now() + Number(rest[++i]);
          else if (rest[i]!.toUpperCase() === 'NX') nx = true;
        }
        if (nx && live(k)) return '$-1\r\n';
        data.set(k, { v, exp });
        return '+OK\r\n';
      }
      case 'INCRBY': {
        const e = live(args[1]!);
        const n = (e ? Number(e.v) : 0) + Number(args[2]);
        data.set(args[1]!, { v: String(n), exp: e?.exp });
        return `:${n}\r\n`;
      }
      case 'DEL':
        return `:${data.delete(args[1]!) ? 1 : 0}\r\n`;
      case 'PTTL': {
        const e = live(args[1]!);
        if (!e) return ':-2\r\n';
        return `:${e.exp === undefined ? -1 : Math.max(0, e.exp - Date.now())}\r\n`;
      }
      default:
        return `-ERR unknown command '${cmd}'\r\n`;
    }
  };
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const parser = new RespParser();
    const authed = { ok: false };
    let multi: string[][] | undefined;
    socket.on('data', (chunk) => {
      for (const v of parser.push(chunk) as RespValue[]) {
        const args = (v as RespValue[]).map(String);
        commands.push(args);
        const cmd = args[0]!.toUpperCase();
        if (cmd === 'MULTI') {
          multi = [];
          socket.write('+OK\r\n');
        } else if (cmd === 'EXEC') {
          const replies = (multi ?? []).map((a) => exec(a, authed));
          multi = undefined;
          socket.write(`*${replies.length}\r\n${replies.join('')}`);
        } else if (multi) {
          multi.push(args);
          socket.write('+QUEUED\r\n');
        } else {
          socket.write(exec(args, authed));
          if (cmd === 'QUIT') socket.end();
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `redis://${opts.password ? `:${opts.password}@` : ''}127.0.0.1:${port}`,
    commands,
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}
