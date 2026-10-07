/**
 * Remote MCP servers for transport tests, built on the official
 * @modelcontextprotocol/sdk server so the gateway's client channels are
 * verified against the reference implementation:
 *  - Streamable HTTP (StreamableHTTPServerTransport, stateful sessions)
 *  - HTTP+SSE (SSEServerTransport, protocol 2024-11-05)
 *  - WebSocket (a minimal SDK Transport adapter over `ws`, "mcp" subprotocol)
 */

import express from 'express';
import { createServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export interface RemoteServer {
  url: string;
  close(): Promise<void>;
  /** Live MCP server instances (one per session). */
  servers: McpServer[];
  /** Headers seen on incoming HTTP requests / upgrades. */
  seenHeaders: Array<Record<string, string | string[] | undefined>>;
  /** Drop every session server-side (simulates a restart that loses state). */
  dropSessions(): Promise<void>;
}

/** Number of `slow` calls the client cancelled (via notifications/cancelled). */
export const stats = { cancelled: 0 };

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'sdk-test-server', version: '1.0.0' });
  server.registerTool(
    'echo',
    { description: 'Echo the message', inputSchema: { msg: z.string() } },
    async ({ msg }) => ({ content: [{ type: 'text', text: `echo:${msg}` }] }),
  );
  server.registerTool(
    'slow',
    { description: 'Sleep', inputSchema: { ms: z.number() } },
    async ({ ms }, extra) => {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        extra.signal.addEventListener('abort', () => {
          stats.cancelled++;
          clearTimeout(t);
          resolve();
        });
      });
      return { content: [{ type: 'text', text: 'done' }] };
    },
  );
  server.registerTool('add-tool', { description: 'Registers another tool' }, async () => {
    server.registerTool('late', { description: 'Added at runtime' }, async () => ({
      content: [{ type: 'text', text: 'late' }],
    }));
    return { content: [{ type: 'text', text: 'added' }] };
  });
  return server;
}

function listen(http: HttpServer): Promise<number> {
  return new Promise((resolve) => http.listen(0, '127.0.0.1', () => resolve((http.address() as AddressInfo).port)));
}

function closeHttp(http: HttpServer): Promise<void> {
  http.closeAllConnections?.();
  return new Promise((resolve) => http.close(() => resolve()));
}

// ─── Streamable HTTP ──────────────────────────────────────────────────────────

export async function startStreamableHttpServer(opts: { requireHeader?: [string, string] } = {}): Promise<RemoteServer> {
  const app = express();
  app.use(express.json());
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const servers: McpServer[] = [];
  const seenHeaders: RemoteServer['seenHeaders'] = [];

  app.all('/mcp', async (req, res) => {
    seenHeaders.push({ ...req.headers });
    if (opts.requireHeader && req.headers[opts.requireHeader[0]] !== opts.requireHeader[1]) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const sid = req.headers['mcp-session-id'];
    if (typeof sid === 'string') {
      const t = transports.get(sid);
      if (!t) {
        res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
        return;
      }
      await t.handleRequest(req, res, req.body);
      return;
    }
    // New session: must be initialize
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };
    const server = buildMcpServer();
    servers.push(server);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const http = createServer(app);
  const port = await listen(http);
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    servers,
    seenHeaders,
    async dropSessions() {
      for (const t of transports.values()) await t.close();
      transports.clear();
    },
    async close() {
      for (const s of servers) await s.close().catch(() => {});
      await closeHttp(http);
    },
  };
}

// ─── HTTP + SSE (legacy) ─────────────────────────────────────────────────────

export async function startSseServer(opts: { endpointOverride?: string } = {}): Promise<RemoteServer> {
  const app = express();
  const transports = new Map<string, SSEServerTransport>();
  const servers: McpServer[] = [];
  const seenHeaders: RemoteServer['seenHeaders'] = [];

  app.get('/sse', async (req, res) => {
    seenHeaders.push({ ...req.headers });
    if (opts.endpointOverride) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(`event: endpoint\ndata: ${opts.endpointOverride}\n\n`);
      return;
    }
    const transport = new SSEServerTransport('/messages', res);
    transports.set(transport.sessionId, transport);
    res.on('close', () => transports.delete(transport.sessionId));
    const server = buildMcpServer();
    servers.push(server);
    await server.connect(transport);
  });

  app.post('/messages', express.json(), async (req, res) => {
    const t = transports.get(String(req.query.sessionId));
    if (!t) {
      res.status(404).send('unknown session');
      return;
    }
    await t.handlePostMessage(req, res, req.body);
  });

  const http = createServer(app);
  const port = await listen(http);
  return {
    url: `http://127.0.0.1:${port}/sse`,
    servers,
    seenHeaders,
    async dropSessions() {
      for (const t of transports.values()) await t.close();
      transports.clear();
    },
    async close() {
      for (const s of servers) await s.close().catch(() => {});
      await closeHttp(http);
    },
  };
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

class WsServerTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private queue: JSONRPCMessage[] | null = [];
  constructor(private readonly ws: WebSocket) {
    // Buffer frames that arrive before start() so nothing is lost.
    ws.on('message', (raw) => {
      let msg: JSONRPCMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        this.onerror?.(err as Error);
        return;
      }
      if (this.queue) this.queue.push(msg);
      else this.onmessage?.(msg);
    });
    ws.on('close', () => this.onclose?.());
  }
  async start(): Promise<void> {
    const q = this.queue ?? [];
    this.queue = null;
    for (const m of q) this.onmessage?.(m);
  }
  async send(message: JSONRPCMessage): Promise<void> {
    this.ws.send(JSON.stringify(message));
  }
  async close(): Promise<void> {
    this.ws.close();
  }
}

export async function startWebSocketServer(): Promise<RemoteServer & { sockets: Set<WebSocket> }> {
  const http = createServer();
  const servers: McpServer[] = [];
  const seenHeaders: RemoteServer['seenHeaders'] = [];
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({
    server: http,
    handleProtocols: (protocols) => (protocols.has('mcp') ? 'mcp' : false),
  });
  wss.on('connection', async (ws, req) => {
    seenHeaders.push({ ...req.headers });
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    const server = buildMcpServer();
    servers.push(server);
    await server.connect(new WsServerTransport(ws));
  });
  const port = await listen(http);
  return {
    url: `ws://127.0.0.1:${port}`,
    servers,
    seenHeaders,
    sockets,
    async dropSessions() {
      for (const ws of sockets) ws.terminate();
    },
    async close() {
      for (const ws of sockets) ws.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await closeHttp(http);
    },
  };
}
