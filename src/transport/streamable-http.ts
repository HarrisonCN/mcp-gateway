/**
 * Streamable HTTP channel — the current MCP HTTP transport (protocol 2025-03-26+).
 *
 *  - Every client→server message is a `POST <url>` with
 *    `Accept: application/json, text/event-stream`.
 *  - The server answers `202 Accepted` (notifications / responses), a single
 *    `application/json` body, or a `text/event-stream` that carries the
 *    response (plus any server requests/notifications sent before it).
 *  - A session id returned in `Mcp-Session-Id` on `initialize` is echoed on
 *    every later request; the negotiated version goes in `MCP-Protocol-Version`.
 *  - `close()` ends the session with `DELETE` (best effort).
 *
 * Not implemented: the optional standalone `GET` stream for unsolicited server
 * notifications, and SSE stream resumption. Neither is needed for tool calls.
 *
 * @module transport/streamable-http
 */

import type { McpServerConfig } from '../utils/types.js';
import { logger } from '../utils/logger.js';
import {
  errMessage,
  expandRecord,
  toMessages,
  type ChannelOptions,
  type JsonRpcId,
  type JsonRpcMessage,
  type UpstreamChannel,
} from './channel.js';
import { readSseStream } from './sse-parser.js';

export class StreamableHttpChannel implements UpstreamChannel {
  readonly kind = 'streamable-http';
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: (error: Error) => void;

  private readonly url: URL;
  private readonly headers: Record<string, string>;
  private sessionId?: string;
  private protocolVersion?: string;
  private closed = false;
  private lost = false;
  /** Open POST requests, keyed by JSON-RPC request id when they carry one. */
  private readonly inflight = new Map<JsonRpcId | symbol, AbortController>();

  constructor(
    private readonly config: McpServerConfig,
    private readonly options: ChannelOptions,
  ) {
    if (!config.url) throw new Error(`Server "${config.id}" has no url configured`);
    this.url = new URL(config.url);
    this.headers = expandRecord(config.headers);
  }

  async start(): Promise<void> {
    // Nothing to open: the session starts with the `initialize` POST.
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  private requestHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...this.headers, ...extra };
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    if (this.protocolVersion) h['mcp-protocol-version'] = this.protocolVersion;
    return h;
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed || this.lost) throw new Error('Streamable HTTP channel is closed');

    const key: JsonRpcId | symbol =
      message.method !== undefined && message.id !== undefined && message.id !== null ? message.id : Symbol('post');
    const abort = new AbortController();
    this.inflight.set(key, abort);
    const done = () => {
      if (this.inflight.get(key) === abort) this.inflight.delete(key);
    };

    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: this.requestHeaders({
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        }),
        body: JSON.stringify(message),
        redirect: 'error',
        signal: abort.signal,
      });
    } catch (err) {
      done();
      if (abort.signal.aborted) throw new Error('Request aborted');
      // The server is unreachable: whatever session it held is gone.
      const e = new Error(`POST ${this.url.origin}${this.url.pathname} failed: ${errMessage(err)}`);
      this.lose(e);
      throw e;
    }

    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    if (res.status === 404 && this.sessionId && message.method !== 'initialize') {
      done();
      await res.body?.cancel().catch(() => {});
      const e = new Error('MCP session expired (HTTP 404)');
      this.lose(e);
      throw e;
    }
    if (!res.ok) {
      done();
      const text = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`MCP server returned HTTP ${res.status}${text ? `: ${text}` : ''}`);
    }
    if (res.status === 202 || !res.body) {
      done();
      await res.body?.cancel().catch(() => {});
      return;
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      // Deliver events as they arrive; keep the stream open in the background.
      void readSseStream(res.body, (ev) => {
        if (ev.event !== 'message' || !ev.data) return;
        this.deliver(ev.data);
      })
        .catch((err) => {
          if (!abort.signal.aborted) logger.debug(`[${this.config.id}] response stream error: ${errMessage(err)}`);
        })
        .finally(done);
      return;
    }

    try {
      const text = await res.text();
      if (text.trim()) this.deliver(text);
    } finally {
      done();
    }
  }

  private deliver(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      logger.debug(`[${this.config.id}] ignoring non-JSON message`);
      return;
    }
    for (const m of toMessages(parsed)) this.onmessage?.(m);
  }

  abandon(id: JsonRpcId): void {
    this.inflight.get(id)?.abort();
    this.inflight.delete(id);
  }

  private lose(err: Error): void {
    if (this.closed || this.lost) return;
    this.lost = true;
    this.abortAll();
    this.onclose?.(err);
  }

  private abortAll(): void {
    for (const c of this.inflight.values()) c.abort();
    this.inflight.clear();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abortAll();
    if (!this.sessionId || this.lost) return;
    // Politely end the session; servers may answer 405 if they do not support it.
    try {
      const res = await fetch(this.url, {
        method: 'DELETE',
        headers: this.requestHeaders(),
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.killGraceMs),
      });
      await res.body?.cancel().catch(() => {});
    } catch {
      // best effort
    }
  }
}
