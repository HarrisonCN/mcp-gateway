/**
 * SSE (Server-Sent Events) Transport for MCP servers
 *
 * Connects to MCP servers that expose an SSE endpoint, enabling
 * real-time streaming of tool results back to the client.
 *
 * @module transport/sse
 */

import { EventEmitter } from 'events';
import http from 'http';
import https from 'https';
import type { Logger } from '../utils/logger.js';
import type { MCPRequest, MCPResponse } from '../utils/types.js';

let _idSeq = 0;

export interface SSETransportOptions {
  url: string;
  headers?: Record<string, string>;
  reconnectIntervalMs?: number;
  maxReconnectAttempts?: number;
  timeoutMs?: number;
}

type PendingRequest = {
  resolve: (value: MCPResponse) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};

export class SSETransport extends EventEmitter {
  private options: Required<SSETransportOptions>;
  private logger: Logger;
  private connected = false;
  private reconnectAttempts = 0;
  private req: http.ClientRequest | null = null;
  private pendingRequests = new Map<string | number, PendingRequest>();
  private messageEndpoint: string;
  private closedByUser = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(options: SSETransportOptions, logger: Logger) {
    super();
    this.options = {
      reconnectIntervalMs: 3000,
      maxReconnectAttempts: 10,
      timeoutMs: 30000,
      headers: {},
      ...options,
    };
    this.logger = logger;
    // Derive the POST endpoint from the SSE URL (convention: /sse → /message)
    this.messageEndpoint = options.url.replace(/\/sse$/, '/message');
  }

  async connect(): Promise<void> {
    this.closedByUser = false;
    return new Promise((resolve, reject) => {
      this._openStream(resolve, reject);
    });
  }

  private _openStream(
    onConnect?: () => void,
    onError?: (e: Error) => void,
  ): void {
    const url = new URL(this.options.url);
    const lib = url.protocol === 'https:' ? https : http;

    this.req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          ...this.options.headers,
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          const err = new Error(
            `SSE server returned HTTP ${res.statusCode}`,
          );
          onError?.(err);
          // Only emit 'error' when handled: an unhandled 'error' event throws.
          if (this.listenerCount('error') > 0) this.emit('error', err);
          return;
        }

        this.connected = true;
        this.reconnectAttempts = 0;
        this.logger.info(`SSE transport connected to ${this.options.url}`);
        onConnect?.();
        this.emit('connect');

        // Parser state lives outside the 'data' handler: an event split across
        // TCP chunks previously lost its event type / earlier data lines.
        res.setEncoding('utf8');
        let buffer = '';
        let eventType = 'message';
        let dataLines: string[] = [];
        res.on('data', (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const rawLine of lines) {
            const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
            if (line.startsWith(':')) {
              continue; // comment / keep-alive
            } else if (line.startsWith('event:')) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              // Spec: strip a single leading space only
              const v = line.slice(5);
              dataLines.push(v.startsWith(' ') ? v.slice(1) : v);
            } else if (line === '') {
              if (dataLines.length > 0) {
                const raw = dataLines.join('\n');
                this._handleEvent(eventType, raw);
                eventType = 'message';
                dataLines = [];
              }
            }
          }
        });

        res.on('end', () => {
          this.connected = false;
          if (this.closedByUser) return;
          this.logger.warn('SSE stream ended, scheduling reconnect…');
          this._scheduleReconnect();
        });

        res.on('error', (err) => {
          this.connected = false;
          if (this.closedByUser) return;
          this.logger.error(`SSE stream error: ${err.message}`);
          this._scheduleReconnect();
        });
      },
    );

    this.req.on('error', (err) => {
      this.connected = false;
      if (this.closedByUser) return;
      onError?.(err);
      this._scheduleReconnect();
    });

    this.req.end();
  }

  private _handleEvent(type: string, data: string): void {
    // MCP SSE servers announce the POST endpoint (often with a sessionId query)
    // in an `endpoint` event whose data is a plain URL, not JSON.
    if (type === 'endpoint') {
      try {
        this.messageEndpoint = new URL(data.trim(), this.options.url).toString();
        this.logger.debug(`SSE message endpoint: ${this.messageEndpoint}`);
      } catch {
        this.logger.warn(`Ignoring invalid SSE endpoint event: ${data}`);
      }
      return;
    }
    try {
      const parsed: MCPResponse = JSON.parse(data);
      const id = parsed.id;
      if (id !== undefined && this.pendingRequests.has(id)) {
        const pending = this.pendingRequests.get(id)!;
        clearTimeout(pending.timer);
        this.pendingRequests.delete(id);
        pending.resolve(parsed);
      } else {
        this.emit(type, parsed);
      }
    } catch {
      this.logger.debug(`Non-JSON SSE event (${type}): ${data}`);
    }
  }

  private _scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      this.logger.error(
        `SSE max reconnect attempts (${this.options.maxReconnectAttempts}) reached`,
      );
      this.emit('disconnect');
      return;
    }
    this.reconnectAttempts++;
    const delay =
      this.options.reconnectIntervalMs * Math.min(this.reconnectAttempts, 5);
    this.logger.info(
      `SSE reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})…`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUser) this._openStream();
    }, delay);
    this.reconnectTimer.unref();
  }

  async send(request: MCPRequest): Promise<MCPResponse> {
    if (!this.connected) {
      throw new Error('SSE transport is not connected');
    }

    return new Promise((resolve, reject) => {
      const id = request.id ?? ++_idSeq;
      const body = JSON.stringify({ ...request, id });
      const url = new URL(this.messageEndpoint);
      const lib = url.protocol === 'https:' ? https : http;

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`SSE request timed out after ${this.options.timeoutMs}ms`));
      }, this.options.timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search, // keep ?sessionId=…
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            ...this.options.headers,
          },
        },
        (res) => {
          if (res.statusCode !== 202 && res.statusCode !== 200) {
            clearTimeout(timer);
            this.pendingRequests.delete(id);
            reject(new Error(`POST /message returned HTTP ${res.statusCode}`));
          }
          res.resume();
        },
      );

      req.on('error', (err) => {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      });

      req.write(body);
      req.end();
    });
  }

  disconnect(): void {
    this.closedByUser = true;
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.req?.destroy();
    this.req = null;
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('SSE transport disconnected'));
      this.pendingRequests.delete(id);
    }
    this.emit('disconnect');
  }

  isConnected(): boolean {
    return this.connected;
  }
}
