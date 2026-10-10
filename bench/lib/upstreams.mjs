/**
 * Controllable upstreams for the reliability harness (13.3.0): `bench/load.mjs` and test/reliability-13-3-0.test.ts.
 *
 *  - startHttpUpstream(): a stateful Streamable-HTTP MCP server (plain node:http, JSON responses) whose behaviour can
 *    be switched at run time: `ok`, `slow` (delayMs), `stall` (accept the request, never answer), `error` (HTTP 503),
 *    `down` (listener closed, sockets destroyed) and back up on the SAME port (sessions are lost → the gateway sees
 *    404 and re-initializes). Counts accepted TCP connections and requests, so the gateway's upstream connection
 *    pool can be observed from the outside.
 *  - startFakeRedis(): RESP2 stand-in (GET / SET PX NX / INCRBY / DEL / PTTL / PING / MULTI / EXEC) with `stall`
 *    (keep sockets, stop answering), `down` and restart on the same port (data kept unless `flush`).
 *  - STDIO_SERVER: path of a line-delimited MCP server; SIGUSR1 toggles stall, SIGUSR2 toggles slow (SLOW_MS).
 *
 * No dependencies beyond Node itself; deterministic (no randomness inside).
 */
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const STDIO_SERVER = join(dirname(fileURLToPath(import.meta.url)), 'stdio-server.mjs');

const TOOLS = [
  { name: 'echo', description: 'Echo the arguments', inputSchema: { type: 'object' } },
  { name: 'slow', description: 'Sleep `ms` then echo', inputSchema: { type: 'object' } },
  { name: 'fail', description: 'Always a JSON-RPC error', inputSchema: { type: 'object' } },
  { name: 'priced', description: 'Echo with a usage block (budgets)', inputSchema: { type: 'object' } },
  { name: 'cached', description: 'Cacheable echo', inputSchema: { type: 'object' } },
];

export function toolResult(name, args, tag) {
  const text = JSON.stringify({ tool: name, args: args ?? {}, upstream: tag });
  if (name === 'priced') return { content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 10 } };
  return { content: [{ type: 'text', text }] };
}

/**
 * @param {{ port?: number, tag?: string, delayMs?: number }} [opts]
 */
export async function startHttpUpstream(opts = {}) {
  const state = {
    mode: 'ok',
    delayMs: opts.delayMs ?? 200,
    tag: opts.tag ?? 'http',
    port: opts.port ?? 0,
    sessions: new Set(),
    connections: 0,
    openSockets: new Set(),
    requests: 0,
    calls: 0,
    stalled: new Set(),
  };
  let nextSession = 1;
  let server;

  const handle = (req, res) => {
    if (req.method === 'DELETE') {
      state.sessions.delete(req.headers['mcp-session-id']);
      res.writeHead(200).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.requests++;
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const sid = req.headers['mcp-session-id'];
      if (msg.method === 'initialize') {
        const id = `s${nextSession++}`;
        state.sessions.add(id);
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': id });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: `up-${state.tag}`, version: '1' } } }));
        return;
      }
      if (!sid || !state.sessions.has(sid)) {
        res.writeHead(404).end();
        return;
      }
      if (msg.id === undefined || msg.id === null) {
        res.writeHead(202).end();
        return;
      }
      const reply = (payload) => {
        if (res.destroyed) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...payload }));
      };
      if (msg.method === 'ping') return reply({ result: {} });
      if (msg.method === 'tools/list') return reply({ result: { tools: TOOLS } });
      if (msg.method !== 'tools/call') return reply({ error: { code: -32601, message: 'unknown method' } });
      state.calls++;
      const { name, arguments: args } = msg.params ?? {};
      if (state.mode === 'stall') {
        state.stalled.add(res);
        res.on('close', () => state.stalled.delete(res));
        return;
      }
      if (state.mode === 'error') {
        res.writeHead(503, { 'content-type': 'text/plain' }).end('upstream unavailable');
        return;
      }
      if (name === 'fail') return reply({ error: { code: -32000, message: 'tool failed' } });
      const delay = state.mode === 'slow' ? state.delayMs : name === 'slow' ? Number(args?.ms ?? 50) : 0;
      if (delay > 0) setTimeout(() => reply({ result: toolResult(name, args, state.tag) }), delay);
      else reply({ result: toolResult(name, args, state.tag) });
    });
  };

  const listen = () =>
    new Promise((resolve, reject) => {
      server = createHttpServer({ keepAliveTimeout: 30_000 }, handle);
      server.on('connection', (s) => {
        state.connections++;
        state.openSockets.add(s);
        s.on('close', () => state.openSockets.delete(s));
      });
      server.once('error', reject);
      server.listen(state.port, '127.0.0.1', () => {
        state.port = server.address().port;
        resolve();
      });
    });
  await listen();

  const down = () =>
    new Promise((resolve) => {
      if (!server) return resolve();
      const s = server;
      server = undefined;
      state.sessions.clear();
      for (const sock of state.openSockets) sock.destroy();
      s.close(() => resolve());
    });

  return {
    get url() {
      return `http://127.0.0.1:${state.port}/mcp`;
    },
    state,
    /** `ok` | `slow` | `stall` | `error`. Leaving `stall` releases nothing: stalled requests stay open until the client gives up. */
    setMode(mode) {
      state.mode = mode;
    },
    down,
    async up() {
      if (!server) await listen();
    },
    async restart() {
      await down();
      await listen();
    },
    /** Drop every session but keep the listener and sockets (session TTL, or a restart behind a proxy). */
    forgetSessions() {
      state.sessions.clear();
    },
    stats() {
      return { connections: state.connections, openSockets: state.openSockets.size, requests: state.requests, calls: state.calls, sessions: state.sessions.size, stalled: state.stalled.size };
    },
    async close() {
      for (const r of state.stalled) r.destroy();
      await down();
    },
  };
}

// ─── fake Redis ──────────────────────────────────────────────────────────────

class Resp {
  constructor() {
    this.buf = Buffer.alloc(0);
  }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      const r = this.parse(0);
      if (!r) break;
      out.push(r.value);
      this.buf = this.buf.subarray(r.end);
    }
    return out;
  }
  parse(at) {
    if (at >= this.buf.length) return undefined;
    const i = this.buf.indexOf('\r\n', at);
    if (i < 0) return undefined;
    const type = String.fromCharCode(this.buf[at]);
    const text = this.buf.toString('utf8', at + 1, i);
    const end = i + 2;
    if (type === '$') {
      const len = Number(text);
      if (len < 0) return { value: null, end };
      if (this.buf.length < end + len + 2) return undefined;
      return { value: this.buf.toString('utf8', end, end + len), end: end + len + 2 };
    }
    if (type === '*') {
      const items = [];
      let e = end;
      for (let k = 0; k < Number(text); k++) {
        const r = this.parse(e);
        if (!r) return undefined;
        items.push(r.value);
        e = r.end;
      }
      return { value: items, end: e };
    }
    return { value: text, end };
  }
}

/** @param {{ port?: number }} [opts] */
export async function startFakeRedis(opts = {}) {
  const data = new Map();
  const st = { mode: 'ok', port: opts.port ?? 0, commands: 0, connections: 0, sockets: new Set() };
  let server;
  const live = (k) => {
    const e = data.get(k);
    if (e && e.exp !== undefined && e.exp <= Date.now()) {
      data.delete(k);
      return undefined;
    }
    return e;
  };
  const bulk = (v) => (v === undefined ? '$-1\r\n' : `$${Buffer.byteLength(v)}\r\n${v}\r\n`);
  const exec = (a) => {
    const cmd = String(a[0]).toUpperCase();
    switch (cmd) {
      case 'PING':
        return '+PONG\r\n';
      case 'AUTH':
      case 'SELECT':
      case 'QUIT':
        return '+OK\r\n';
      case 'GET':
        return bulk(live(a[1])?.v);
      case 'SET': {
        let exp;
        let nx = false;
        for (let i = 3; i < a.length; i++) {
          const o = String(a[i]).toUpperCase();
          if (o === 'PX') exp = Date.now() + Number(a[++i]);
          else if (o === 'NX') nx = true;
        }
        if (nx && live(a[1])) return '$-1\r\n';
        data.set(a[1], { v: String(a[2]), exp });
        return '+OK\r\n';
      }
      case 'INCRBY': {
        const e = live(a[1]);
        const n = (e ? Number(e.v) : 0) + Number(a[2]);
        data.set(a[1], { v: String(n), exp: e?.exp });
        return `:${n}\r\n`;
      }
      case 'DEL':
        return `:${data.delete(a[1]) ? 1 : 0}\r\n`;
      case 'PTTL': {
        const e = live(a[1]);
        if (!e) return ':-2\r\n';
        return `:${e.exp === undefined ? -1 : Math.max(0, e.exp - Date.now())}\r\n`;
      }
      default:
        return `-ERR unknown command '${cmd}'\r\n`;
    }
  };
  const listen = () =>
    new Promise((resolve, reject) => {
      server = createNetServer((socket) => {
        st.connections++;
        st.sockets.add(socket);
        socket.on('close', () => st.sockets.delete(socket));
        socket.on('error', () => {});
        const parser = new Resp();
        let multi;
        socket.on('data', (chunk) => {
          for (const v of parser.push(chunk)) {
            st.commands++;
            if (st.mode === 'stall') continue; // swallowed: the client must time out
            const cmd = String(v[0]).toUpperCase();
            if (cmd === 'MULTI') {
              multi = [];
              socket.write('+OK\r\n');
            } else if (cmd === 'EXEC') {
              const replies = (multi ?? []).map(exec);
              multi = undefined;
              socket.write(`*${replies.length}\r\n${replies.join('')}`);
            } else if (multi) {
              multi.push(v);
              socket.write('+QUEUED\r\n');
            } else socket.write(exec(v));
          }
        });
      });
      server.once('error', reject);
      server.listen(st.port, '127.0.0.1', () => {
        st.port = server.address().port;
        resolve();
      });
    });
  await listen();
  const down = () =>
    new Promise((resolve) => {
      if (!server) return resolve();
      const s = server;
      server = undefined;
      for (const sock of st.sockets) sock.destroy();
      s.close(() => resolve());
    });
  return {
    get url() {
      return `redis://127.0.0.1:${st.port}`;
    },
    state: st,
    data,
    setMode(m) {
      st.mode = m;
    },
    down,
    async up({ flush = false } = {}) {
      if (flush) data.clear();
      if (!server) await listen();
    },
    async close() {
      await down();
    },
  };
}
