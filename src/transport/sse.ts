/**
 * SSE channel — the MCP "HTTP with SSE" transport (protocol 2024-11-05).
 *
 *  1. `GET <url>` with `Accept: text/event-stream` opens the server→client stream.
 *  2. The server's first event is `endpoint`; its data is the URL (usually with a
 *     `sessionId` query) that client→server messages must be POSTed to.
 *  3. Every JSON-RPC message from the server arrives as a `message` event.
 *
 * Reconnection is *not* done here: an SSE session's server-side state dies with
 * the stream, so the gateway's supervisor re-runs the full MCP handshake
 * instead (see `gateway/supervisor.ts`).
 *
 * Security: the announced endpoint must have the same origin as the SSE URL, so
 * a malicious server cannot make the gateway POST its configured headers
 * (often credentials) to another host. Redirects are not followed for POSTs.
 *
 * @module transport/sse
 */

import type { McpServerConfig } from '../utils/types.js';
import { logger } from '../utils/logger.js';
import { errMessage, expandRecord, type ChannelOptions, type JsonRpcMessage, type UpstreamChannel } from './channel.js';
import { readSseStream } from './sse-parser.js';

export class SseChannel implements UpstreamChannel {
  readonly kind = 'sse';
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: (error: Error) => void;

  private readonly url: URL;
  private readonly headers: Record<string, string>;
  private readonly abort = new AbortController();
  private endpoint?: URL;
  private closed = false;
  private lost = false;

  constructor(
    private readonly config: McpServerConfig,
    private readonly options: ChannelOptions,
  ) {
    if (!config.url) throw new Error(`Server "${config.id}" has no url configured`);
    this.url = new URL(config.url);
    this.headers = expandRecord(config.headers);
  }

  async start(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    let onEndpoint!: () => void;
    let onFail!: (err: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      onEndpoint = resolve;
      onFail = reject;
      timer = setTimeout(
        () => reject(new Error(`SSE server did not announce an endpoint within ${this.options.connectTimeoutMs}ms`)),
        this.options.connectTimeoutMs,
      );
    });

    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'GET',
        headers: { ...this.headers, Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
        signal: this.abort.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new Error(`SSE connect to ${this.url.origin}${this.url.pathname} failed: ${errMessage(err)}`);
    }
    if (!res.ok || !res.body) {
      clearTimeout(timer);
      await res.body?.cancel().catch(() => {});
      throw new Error(`SSE server returned HTTP ${res.status}`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      clearTimeout(timer);
      await res.body.cancel().catch(() => {});
      throw new Error(`SSE server returned unexpected content-type "${contentType}"`);
    }

    // Consume the stream in the background for the lifetime of the channel.
    readSseStream(res.body, (ev) => {
      if (ev.event === 'endpoint') {
        try {
          const endpoint = new URL(ev.data.trim(), this.url);
          if (endpoint.origin !== this.url.origin) {
            throw new Error(`endpoint origin ${endpoint.origin} does not match ${this.url.origin}`);
          }
          this.endpoint = endpoint;
          onEndpoint();
        } catch (err) {
          onFail(new Error(`Invalid SSE endpoint event: ${errMessage(err)}`));
        }
        return;
      }
      if (ev.event !== 'message') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        logger.debug(`[${this.config.id}] ignoring non-JSON SSE message`);
        return;
      }
      if (parsed && typeof parsed === 'object') this.onmessage?.(parsed as JsonRpcMessage);
    }).then(
      () => this.lose(new Error('SSE stream ended'), onFail),
      (err) => this.lose(new Error(`SSE stream error: ${errMessage(err)}`), onFail),
    );

    try {
      await ready;
    } catch (err) {
      this.abort.abort();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private lose(err: Error, failStart: (e: Error) => void): void {
    failStart(err); // no-op once start() settled
    if (this.closed || this.lost) return;
    this.lost = true;
    this.abort.abort();
    this.onclose?.(err);
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed || this.lost || !this.endpoint) throw new Error('SSE channel is not connected');
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      redirect: 'error',
      signal: this.abort.signal,
    });
    // Body is informational ("Accepted"); drain it so the socket is reused.
    await res.text().catch(() => '');
    if (!res.ok) throw new Error(`POST to SSE endpoint returned HTTP ${res.status}`);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abort.abort();
  }
}
