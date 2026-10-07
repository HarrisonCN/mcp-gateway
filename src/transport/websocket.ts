/**
 * WebSocket channel — one JSON-RPC message per text frame, using the `mcp`
 * subprotocol by default (the same convention as the official SDK's
 * `WebSocketClientTransport`; override per server with `subprotocol`). Uses the `ws` package so custom headers work
 * and Node 20 (no global WebSocket) is supported.
 *
 * Keep-alive pings detect half-open connections: if a pong does not arrive
 * before the next ping, the socket is terminated and reported as lost.
 * Reconnection is handled by the gateway supervisor, which re-runs the MCP
 * handshake on a fresh socket.
 *
 * @module transport/websocket
 */

import WebSocket from 'ws';
import type { McpServerConfig } from '../utils/types.js';
import { logger } from '../utils/logger.js';
import { expandRecord, type ChannelOptions, type JsonRpcMessage, type UpstreamChannel } from './channel.js';

const SUBPROTOCOL = 'mcp';
const MAX_PAYLOAD = 16 * 1024 * 1024;

export interface WebSocketChannelOptions extends ChannelOptions {
  pingIntervalMs?: number;
}

export class WebSocketChannel implements UpstreamChannel {
  readonly kind = 'websocket';
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: (error: Error) => void;

  private ws?: WebSocket;
  private closed = false;
  private lost = false;
  private pingTimer?: NodeJS.Timeout;
  private awaitingPong = false;

  constructor(
    private readonly config: McpServerConfig,
    private readonly options: WebSocketChannelOptions,
  ) {
    if (!config.url) throw new Error(`Server "${config.id}" has no url configured`);
  }

  start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      // `subprotocol: ""` connects without requesting one (for servers that reject it).
      const sub = this.config.subprotocol ?? SUBPROTOCOL;
      const ws = new WebSocket(this.config.url!, sub ? [sub] : [], {
        headers: expandRecord(this.config.headers),
        handshakeTimeout: this.options.connectTimeoutMs,
        maxPayload: MAX_PAYLOAD,
      });
      this.ws = ws;

      ws.on('open', () => {
        settled = true;
        this.startPing();
        resolve();
      });

      ws.on('unexpected-response', (_req, res) => {
        res.resume();
        const err = new Error(`WebSocket upgrade rejected with HTTP ${res.statusCode}`);
        ws.terminate();
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      ws.on('message', (raw, isBinary) => {
        if (isBinary) return;
        let msg: unknown;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          logger.debug(`[${this.config.id}] ignoring non-JSON WebSocket frame`);
          return;
        }
        // Batches are arrays of messages.
        for (const m of Array.isArray(msg) ? msg : [msg]) {
          if (m && typeof m === 'object') this.onmessage?.(m as JsonRpcMessage);
        }
      });

      ws.on('pong', () => {
        this.awaitingPong = false;
      });

      ws.on('error', (err) => {
        logger.debug(`[${this.config.id}] WebSocket error: ${err.message}`);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      ws.on('close', (code, reason) => {
        this.stopPing();
        if (!settled) {
          settled = true;
          reject(new Error(`WebSocket closed during connect (code=${code})`));
          return;
        }
        this.lose(new Error(`WebSocket closed (code=${code}, reason=${reason.toString() || 'none'})`));
      });
    });
  }

  private lose(err: Error): void {
    if (this.closed || this.lost) return;
    this.lost = true;
    logger.warn(`[${this.config.id}] ${err.message}`);
    this.onclose?.(err);
  }

  private startPing(): void {
    const interval = this.options.pingIntervalMs ?? 30_000;
    if (!(interval > 0)) return;
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (this.awaitingPong) {
        // No pong since the last ping: the connection is dead.
        ws.terminate();
        return;
      }
      this.awaitingPong = true;
      try {
        ws.ping();
      } catch {
        // ignore — 'close' will follow
      }
    }, interval);
    this.pingTimer.unref();
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  send(message: JsonRpcMessage): Promise<void> {
    const ws = this.ws;
    if (this.closed || this.lost || !ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket channel is not connected'));
    }
    return new Promise<void>((resolve, reject) => {
      ws.send(JSON.stringify(message), (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopPing();
    const ws = this.ws;
    if (!ws) return;
    if (ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        ws.terminate();
        resolve();
      }, this.options.killGraceMs);
      force.unref();
      ws.once('close', () => {
        clearTimeout(force);
        resolve();
      });
      try {
        ws.close(1000, 'Client disconnect');
      } catch {
        ws.terminate();
      }
    });
  }
}
