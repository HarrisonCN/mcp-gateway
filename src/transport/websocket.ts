/**
 * WebSocket Transport for MCP servers
 *
 * Connects to MCP servers that expose a WebSocket endpoint,
 * enabling full-duplex communication with lower latency than SSE.
 *
 * Audit fixes:
 *  - Uses the `ws` package (already a dependency). The previous code relied on
 *    a global WebSocket that does not exist on Node 20 (the declared engine)
 *    and whose constructor ignores the `headers` option anyway.
 *  - An intentional disconnect() no longer triggers the auto-reconnect loop.
 *  - Request ids come from a monotonic counter instead of Date.now().
 *  - Pending requests are rejected when the socket closes instead of waiting
 *    for their timeouts.
 *  - Reconnect / ping timers are unref()'d and cleared on disconnect.
 *
 * NOTE: not yet wired into McpProxy — see CONTRIBUTING.md.
 *
 * @module transport/websocket
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type { Logger } from '../utils/logger.js';
import type { MCPRequest, MCPResponse } from '../utils/types.js';

export interface WebSocketTransportOptions {
  url: string;
  headers?: Record<string, string>;
  reconnectIntervalMs?: number;
  maxReconnectAttempts?: number;
  timeoutMs?: number;
  pingIntervalMs?: number;
}

type PendingRequest = {
  resolve: (value: MCPResponse) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};

let _idSeq = 0;

export class WebSocketTransport extends EventEmitter {
  private options: Required<WebSocketTransportOptions>;
  private logger: Logger;
  private ws: WebSocket | null = null;
  private connected = false;
  private closedByUser = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pendingRequests = new Map<string | number, PendingRequest>();
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(options: WebSocketTransportOptions, logger: Logger) {
    super();
    this.options = {
      reconnectIntervalMs: 3000,
      maxReconnectAttempts: 10,
      timeoutMs: 30000,
      headers: {},
      pingIntervalMs: 30000,
      ...options,
    };
    this.logger = logger;
  }

  async connect(): Promise<void> {
    this.closedByUser = false;
    return new Promise((resolve, reject) => {
      this._openSocket(resolve, reject);
    });
  }

  private _openSocket(onConnect?: () => void, onError?: (e: Error) => void): void {
    let settled = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.options.url, { headers: this.options.headers });
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      settled = true;
      this.connected = true;
      this.reconnectAttempts = 0;
      this.logger.info(`WebSocket transport connected to ${this.options.url}`);
      onConnect?.();
      this.emit('connect');
      this._startPing();
    });

    ws.on('message', (raw) => {
      let data: MCPResponse;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        this.logger.debug(`Non-JSON WebSocket message: ${raw.toString()}`);
        return;
      }
      const id = data.id;
      const pending = id !== undefined ? this.pendingRequests.get(id) : undefined;
      if (pending && data.method === undefined) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(id!);
        pending.resolve(data);
      } else {
        this.emit('message', data);
      }
    });

    ws.on('error', (err) => {
      this.logger.error(`WebSocket error: ${err.message}`);
      if (!settled) {
        settled = true;
        onError?.(err);
      }
    });

    ws.on('close', (code, reason) => {
      if (this.ws === ws) this.ws = null;
      this.connected = false;
      this._stopPing();
      this._rejectAll(new Error('WebSocket closed'));
      if (this.closedByUser) return;
      this.logger.warn(`WebSocket closed (code=${code}, reason=${reason.toString() || 'none'})`);
      this._scheduleReconnect();
    });
  }

  private _rejectAll(err: Error): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }

  private _startPing(): void {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
        } catch {
          // ignore ping errors
        }
      }
    }, this.options.pingIntervalMs);
    this.pingTimer.unref();
  }

  private _stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private _scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      this.logger.error(`WebSocket max reconnect attempts (${this.options.maxReconnectAttempts}) reached`);
      this.emit('disconnect');
      return;
    }
    this.reconnectAttempts++;
    const delay = this.options.reconnectIntervalMs * Math.min(this.reconnectAttempts, 5);
    this.logger.info(`WebSocket reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})…`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUser) this._openSocket();
    }, delay);
    this.reconnectTimer.unref();
  }

  async send(request: MCPRequest): Promise<MCPResponse> {
    const ws = this.ws;
    if (!this.connected || !ws) {
      throw new Error('WebSocket transport is not connected');
    }

    return new Promise((resolve, reject) => {
      const id = request.id ?? ++_idSeq;
      const payload = JSON.stringify({ ...request, id });

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`WebSocket request timed out after ${this.options.timeoutMs}ms`));
      }, this.options.timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      ws.send(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }

  disconnect(): void {
    this.closedByUser = true;
    this.connected = false;
    this._stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close(1000, 'Client disconnect');
    this.ws = null;
    this._rejectAll(new Error('WebSocket transport disconnected'));
    this.emit('disconnect');
  }

  isConnected(): boolean {
    return this.connected;
  }
}
