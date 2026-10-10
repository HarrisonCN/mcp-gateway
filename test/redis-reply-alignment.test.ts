import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { RedisClient } from '../src/state/redis.js';

/**
 * MGW-2026-012: after a command timeout (or a connection reset) the client must never hand a reply to a command it was
 * not written for. Minimal in-process RESP server with a "stall" switch (commands are read but never answered).
 */
function fakeRedis() {
  const db = new Map<string, string>();
  const sockets = new Set<net.Socket>();
  const state = { stall: false, connections: 0 };
  const bulk = (v?: string) => (v === undefined ? '$-1\r\n' : `$${Buffer.byteLength(v)}\r\n${v}\r\n`);
  const server = net.createServer((sock) => {
    state.connections++;
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => undefined);
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      for (;;) {
        const m = /^\*(\d+)\r\n/.exec(buf);
        if (!m) return;
        let i = m[0].length;
        const args: string[] = [];
        for (let k = 0; k < Number(m[1]); k++) {
          const h = /^\$(\d+)\r\n/.exec(buf.slice(i));
          if (!h) return;
          i += h[0].length;
          args.push(buf.slice(i, i + Number(h[1])));
          i += Number(h[1]) + 2;
        }
        if (i > buf.length) return;
        buf = buf.slice(i);
        if (state.stall) continue;
        const [cmd, key, val] = args;
        if (/^set$/i.test(cmd)) {
          db.set(key, val);
          sock.write('+OK\r\n');
        } else if (/^get$/i.test(cmd)) sock.write(bulk(db.get(key)));
        else if (/^incr$/i.test(cmd)) {
          const n = Number(db.get(key) ?? 0) + 1;
          db.set(key, String(n));
          sock.write(`:${n}\r\n`);
        } else sock.write('+OK\r\n');
      }
    });
  });
  return {
    state,
    async start() {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      return `redis://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    },
    async stop() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f().catch(() => undefined);
});

async function setup() {
  const r = fakeRedis();
  const url = await r.start();
  const c = new RedisClient({ url, commandTimeoutMs: 300 });
  cleanup.push(() => r.stop(), () => c.close());
  return { r, c };
}

describe('Redis client reply alignment after a timeout / reconnect (MGW-2026-012)', () => {
  it('a revoked key still reads as revoked after a command timed out and the client reconnected', async () => {
    const { r, c } = await setup();
    await c.command('SET', 'agent-identity:revoked:jti-REVOKED', '1');
    r.state.stall = true;
    await expect(c.command('GET', 'stalled')).rejects.toThrow(/timed out/);
    r.state.stall = false;
    const a = c.command('GET', 'agent-identity:revoked:jti-valid').catch((e: Error) => `error: ${e.message}`);
    const b = c.command('GET', 'agent-identity:revoked:jti-REVOKED').catch((e: Error) => `error: ${e.message}`);
    // each command gets ITS reply, or an error — never another command's reply
    expect([null, 'error: Redis connection closed']).toContain(await a);
    expect(['1', 'error: Redis connection closed']).toContain(await b);
    for (let i = 0; i < 5; i++) expect(await c.command('GET', 'agent-identity:revoked:jti-REVOKED')).toBe('1');
    expect(await c.command('GET', 'agent-identity:revoked:jti-valid')).toBeNull();
  });

  it('commands written to the new connection are never failed by the old connection closing', async () => {
    const { r, c } = await setup();
    await c.command('SET', 'b', 'B');
    r.state.stall = true;
    await expect(c.command('GET', 'x')).rejects.toThrow(/timed out/);
    r.state.stall = false;
    expect(await c.command('GET', 'b')).toBe('B');
    expect(await c.command('GET', 'nothing')).toBeNull();
    expect(await c.command('GET', 'b')).toBe('B');
  });

  it('rate-limit counters read their own value after a timeout under concurrency', async () => {
    const { r, c } = await setup();
    await c.command('SET', 'rl:alice', '100');
    await c.command('SET', 'rl:bob', '1');
    r.state.stall = true;
    await expect(c.command('GET', 'x')).rejects.toThrow(/timed out/);
    r.state.stall = false;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const k = i % 2 ? 'rl:alice' : 'rl:bob';
        return c.command('GET', k).then(
          (v) => ({ k, v }),
          () => ({ k, v: 'error' }),
        );
      }),
    );
    for (const { k, v } of results) if (v !== 'error') expect(v).toBe(k === 'rl:alice' ? '100' : '1');
    expect(await c.command('INCR', 'rl:bob')).toBe(2);
    expect(await c.command('GET', 'rl:alice')).toBe('100');
  });

  it('a timed-out connection is discarded: its late reply is never delivered to a later command', async () => {
    const { r, c } = await setup();
    await c.command('SET', 'k1', 'one');
    await c.command('SET', 'k2', 'two');
    r.state.stall = true;
    await expect(c.command('GET', 'k1')).rejects.toThrow(/timed out/);
    r.state.stall = false;
    const before = r.state.connections;
    expect(await c.command('GET', 'k2')).toBe('two');
    expect(r.state.connections).toBeGreaterThan(before - 1);
    expect(await c.command('GET', 'k1')).toBe('one');
  });
});
