/**
 * Upstream channel abstraction.
 *
 * A channel moves raw JSON-RPC messages between the gateway and one upstream
 * MCP server. It knows nothing about request ids, timeouts or the MCP
 * handshake — that is the job of the session layer in `proxy/index.ts`, which
 * is shared by every transport (stdio, SSE, WebSocket, Streamable HTTP).
 *
 * Lifecycle: `start()` → any number of `send()` → `close()`.
 * `onclose` fires once when the channel goes away *unexpectedly* (process
 * exit, socket close, stream end); it does not fire for `close()`.
 *
 * @module transport/channel
 */

import type { McpServerConfig } from '../utils/types.js';

export type JsonRpcId = string | number;

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface UpstreamChannel {
  /** Short transport name, for logs. */
  readonly kind: string;
  /** Open the connection. Resolves once `send()` may be called. */
  start(): Promise<void>;
  /** Deliver one message. Rejects when the message could not be handed over. */
  send(message: JsonRpcMessage): Promise<void>;
  /** Intentionally close the channel and release every resource. */
  close(): Promise<void>;
  /** Called for every message received from the server. */
  onmessage?: (message: JsonRpcMessage) => void;
  /** Called once when the channel is lost without `close()` being called. */
  onclose?: (error: Error) => void;
  /** Informs HTTP-based channels of the protocol version negotiated in `initialize`. */
  setProtocolVersion?(version: string): void;
  /** Called when a request is abandoned (e.g. timed out) so the channel can free per-request resources. */
  abandon?(id: JsonRpcId): void;
}

/** Expand `${VAR}` references against the gateway's own environment. */
export function expandEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => process.env[name] ?? '');
}

export function expandRecord(record: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record ?? {})) out[k] = expandEnv(v);
  return out;
}

/** Error message including the `cause` (fetch() hides the real reason there). */
export function errMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
  }
  return String(err);
}

/** Parse a JSON value into zero or more JSON-RPC messages (batches are arrays). */
export function toMessages(value: unknown): JsonRpcMessage[] {
  const list = Array.isArray(value) ? value : [value];
  return list.filter(
    (m): m is JsonRpcMessage => !!m && typeof m === 'object' && (m as { jsonrpc?: unknown }).jsonrpc === '2.0',
  );
}

export interface ChannelOptions {
  /** Time allowed for `start()` (connect + handshake prerequisites). */
  connectTimeoutMs: number;
  /** Grace period used by the stdio channel between stdin close / SIGTERM / SIGKILL. */
  killGraceMs: number;
  /** 12.0: gateway-wide stdio env passthrough (`security.stdioEnvPassthrough`). */
  envPassthrough?: string[];
  /** 12.0: base directory for relative `isolation.cwd` (the config file's directory). */
  baseDir?: string;
}

export type ChannelFactory = (config: McpServerConfig, options: ChannelOptions) => UpstreamChannel;
