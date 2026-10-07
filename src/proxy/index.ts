/**
 * MCP Proxy
 * Routes tool-call requests to the appropriate MCP server (stdio transport).
 *
 * v0.2.0 bug fixes:
 *  - [BUG-001] Concurrent restart race condition: fixed with per-server Mutex.
 *  - [BUG-002] JSON-RPC id collision: monotonic counter instead of Date.now().
 *  - [BUG-003] Leaked stdio handles on process crash.
 *  - [BUG-004] Silent failures on process spawn error.
 *
 * Audit fixes (hark/audit-fixes):
 *  - A failed `initialize` left the child process running and the session
 *    registered, so the server reported "connected" and leaked a process.
 *  - Re-connecting an existing server id overwrote the old session without
 *    killing its process.
 *  - The exit handler of an old process could delete a *newer* session that
 *    had been registered under the same id.
 *  - `proc.killed` is true as soon as a signal is sent, so the SIGKILL
 *    escalation never ran; disconnect now waits for the real exit.
 *  - Writing to a dead child's stdin emitted an unhandled 'error' (EPIPE) that
 *    crashed the whole gateway.
 *  - stdout chunks were decoded per chunk, corrupting multi-byte UTF-8
 *    characters split across chunk boundaries.
 *  - Server-initiated requests (e.g. `ping`) whose id collided with a pending
 *    gateway request were mistaken for responses; they are now answered.
 *  - `maxConcurrency` was accepted in config but never enforced.
 *  - Timed-out requests are now cancelled upstream (`notifications/cancelled`).
 *  - `tools/list` pagination (`nextCursor`) is followed.
 *  - Unbounded stdout buffer growth is capped.
 *
 * @module proxy
 */

import { spawn, type ChildProcess } from 'child_process';
import type { McpServerConfig, ProxyRequest, ProxyResponse, ToolInfo } from '../utils/types.js';
import { logger } from '../utils/logger.js';
import { Mutex } from '../utils/mutex.js';
import { Semaphore } from '../utils/semaphore.js';
import { VERSION } from '../utils/version.js';

export const MCP_PROTOCOL_VERSION = '2024-11-05';

/** Max bytes of un-terminated stdout we buffer before declaring the server broken. */
const MAX_BUFFER_CHARS = 16 * 1024 * 1024;
const MAX_TOOL_PAGES = 100;
const DEFAULT_TIMEOUT_MS = 30_000;

// JSON-RPC error codes used by the gateway
export const ERR_NOT_CONNECTED = -32000;
export const ERR_TIMEOUT = -32001;

// ── Monotonic ID counter (fix BUG-002) ──────────────────────────────────────
let _idSeq = 0;
function nextId(): number {
  return ++_idSeq;
}

// ─── Stdio Session ────────────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: ProxyResponse) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface StdioSession {
  serverId: string;
  process: ChildProcess;
  pendingRequests: Map<string | number, PendingRequest>;
  buffer: string;
  limiter: Semaphore;
  closed: boolean;
  exited: Promise<void>;
}

export interface ProxyOptions {
  /** Grace period between closing stdin / SIGTERM / SIGKILL on disconnect. */
  killGraceMs?: number;
}

export class McpProxy {
  private sessions = new Map<string, StdioSession>();
  // Per-server spawn mutex (fix BUG-001)
  private spawnLocks = new Map<string, Mutex>();
  private readonly killGraceMs: number;

  constructor(options: ProxyOptions = {}) {
    this.killGraceMs = options.killGraceMs ?? 2_000;
  }

  private getSpawnLock(serverId: string): Mutex {
    let lock = this.spawnLocks.get(serverId);
    if (!lock) {
      lock = new Mutex();
      this.spawnLocks.set(serverId, lock);
    }
    return lock;
  }

  // ─── Connection Management ──────────────────────────────────────────────────

  async connect(config: McpServerConfig): Promise<ToolInfo[]> {
    // Serialise concurrent connect calls for the same server (fix BUG-001)
    return this.getSpawnLock(config.id).runExclusive(async () => {
      if (config.transport !== 'stdio') {
        // The previous "stdio fallback" could never work for URL-based servers
        // (they have no command); fail with an accurate message instead.
        throw new Error(
          `Transport "${config.transport}" is not supported by the proxy yet (server "${config.id}"); only stdio is routable`,
        );
      }
      if (!config.command) {
        throw new Error(`Server "${config.id}" has no command configured`);
      }

      // Replace (and clean up) any existing session for this id.
      if (this.sessions.has(config.id)) {
        await this._disconnectUnlocked(config.id);
      }

      const session = this._spawnSession(config);
      this.sessions.set(config.id, session);

      try {
        return await this._handshake(config);
      } catch (err) {
        await this._disconnectUnlocked(config.id);
        throw err;
      }
    });
  }

  private async _handshake(config: McpServerConfig): Promise<ToolInfo[]> {
    const timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
    const initResult = await this._sendRequest(
      config.id,
      {
        serverId: config.id,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'mcp-gateway', version: VERSION },
        },
        requestId: nextId(),
      },
      timeout,
      false,
    );

    if (!initResult.success) {
      throw new Error(`Failed to initialize server "${config.id}": ${initResult.error?.message}`);
    }

    this._sendNotification(config.id, 'notifications/initialized');

    const tools: ToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const toolsResult = await this._sendRequest(
        config.id,
        {
          serverId: config.id,
          method: 'tools/list',
          params: cursor ? { cursor } : {},
          requestId: nextId(),
        },
        timeout,
        false,
      );

      if (!toolsResult.success) {
        logger.warn(`Could not list tools for "${config.id}": ${toolsResult.error?.message}`);
        break;
      }

      const result = (toolsResult.result ?? {}) as { tools?: unknown[]; nextCursor?: unknown };
      for (const t of result.tools ?? []) {
        const tool = t as { name?: unknown; description?: string; inputSchema?: Record<string, unknown> };
        if (typeof tool?.name !== 'string') continue;
        tools.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          serverId: config.id,
          serverName: config.name,
        });
      }

      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }

    return tools;
  }

  async disconnect(serverId: string): Promise<void> {
    await this.getSpawnLock(serverId).runExclusive(() => this._disconnectUnlocked(serverId));
  }

  private async _disconnectUnlocked(serverId: string): Promise<void> {
    const session = this.sessions.get(serverId);
    if (!session) return;
    this.sessions.delete(serverId);
    session.closed = true;

    this._rejectAll(session, new Error('Server disconnected'));

    // Graceful shutdown per MCP stdio spec: close stdin → SIGTERM → SIGKILL.
    const proc = session.process;
    const isRunning = () => proc.exitCode === null && proc.signalCode === null;
    const waitExit = (ms: number) =>
      Promise.race([session.exited, new Promise<void>((r) => setTimeout(r, ms).unref())]);

    if (isRunning()) {
      proc.stdin?.end();
      await waitExit(Math.min(this.killGraceMs, 500));
    }
    if (isRunning()) {
      proc.kill('SIGTERM');
      await waitExit(this.killGraceMs);
    }
    if (isRunning()) {
      proc.kill('SIGKILL');
      await waitExit(this.killGraceMs);
    }
    proc.stdin?.destroy();
    proc.stdout?.destroy();
    proc.stderr?.destroy();

    logger.info(`Disconnected from server: ${serverId}`);
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.disconnect(id)));
  }

  // ─── Tool Execution ─────────────────────────────────────────────────────────

  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    timeout?: number,
  ): Promise<ProxyResponse> {
    if (!this.sessions.has(serverId)) {
      return {
        success: false,
        error: { code: ERR_NOT_CONNECTED, message: `Server "${serverId}" is not connected` },
        durationMs: 0,
      };
    }

    return this._sendRequest(
      serverId,
      {
        serverId,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
        requestId: nextId(), // fix BUG-002
      },
      timeout ?? DEFAULT_TIMEOUT_MS,
      true,
    );
  }

  isConnected(serverId: string): boolean {
    const s = this.sessions.get(serverId);
    return !!s && !s.closed;
  }

  /** In-flight and queued tool calls for a server (for monitoring). */
  getLoad(serverId: string): { inFlight: number; queued: number } | undefined {
    const s = this.sessions.get(serverId);
    return s ? { inFlight: s.limiter.inFlight, queued: s.limiter.pending } : undefined;
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  private _spawnSession(config: McpServerConfig): StdioSession {
    // Expand ${VAR} env references
    const resolvedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(config.env ?? {})) {
      resolvedEnv[k] = v.replace(/\$\{([^}]+)\}/g, (_, name: string) => process.env[name] ?? '');
    }

    const proc = spawn(config.command!, config.args ?? [], {
      env: { ...process.env, ...resolvedEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let markExited!: () => void;
    const session: StdioSession = {
      serverId: config.id,
      process: proc,
      pendingRequests: new Map(),
      buffer: '',
      limiter: new Semaphore(config.maxConcurrency ?? Infinity),
      closed: false,
      exited: new Promise<void>((r) => (markExited = r)),
    };

    // Decode as a stream so multi-byte chars split across chunks survive.
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      session.buffer += chunk;
      this._drainBuffer(session);
      if (session.buffer.length > MAX_BUFFER_CHARS) {
        logger.error(`[${config.id}] stdout line exceeded ${MAX_BUFFER_CHARS} chars; dropping session`);
        this._failSession(session, new Error('MCP server sent an oversized message'));
        proc.kill('SIGKILL');
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      logger.debug(`[${config.id}] stderr: ${chunk.toString().trim()}`);
    });

    // Stream errors (EPIPE when the child dies mid-write) must never become
    // unhandled 'error' events — those crash the process.
    const onStreamError = (err: Error) => {
      logger.debug(`[${config.id}] stdio stream error: ${err.message}`);
    };
    proc.stdin?.on('error', onStreamError);
    proc.stdout?.on('error', onStreamError);
    proc.stderr?.on('error', onStreamError);

    // fix BUG-003 & BUG-004
    proc.on('error', (err) => {
      logger.error(`[${config.id}] spawn error: ${err.message}`);
      this._failSession(session, err);
      markExited(); // 'exit' may never fire if spawn failed
    });

    proc.on('exit', (code, signal) => {
      if (!session.closed) {
        logger.warn(`Server "${config.id}" exited (code=${code}, signal=${signal})`);
      }
      this._failSession(session, new Error(`MCP server "${config.id}" exited unexpectedly`));
      markExited();
    });

    return session;
  }

  /** Reject everything in flight and drop the session — only if it is still the current one. */
  private _failSession(session: StdioSession, err: Error): void {
    this._rejectAll(session, err);
    session.closed = true;
    if (this.sessions.get(session.serverId) === session) {
      this.sessions.delete(session.serverId);
    }
  }

  private _rejectAll(session: StdioSession, err: Error): void {
    for (const [, pending] of session.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    session.pendingRequests.clear();
  }

  private _drainBuffer(session: StdioSession): void {
    if (!session.buffer.includes('\n')) return;
    const lines = session.buffer.split('\n');
    session.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let msg: {
        id?: string | number | null;
        method?: string;
        result?: unknown;
        error?: { code: number; message: string; data?: unknown };
      };
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue; // Non-JSON line — ignore
      }
      if (!msg || typeof msg !== 'object') continue;

      if (typeof msg.method === 'string') {
        // Server → client request or notification
        if (msg.id !== undefined && msg.id !== null) this._answerServerRequest(session, msg.id, msg.method);
        continue;
      }

      if (msg.id === undefined || msg.id === null) continue;
      const pending = session.pendingRequests.get(msg.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      session.pendingRequests.delete(msg.id);

      if (msg.error) {
        pending.resolve({ success: false, error: msg.error, durationMs: 0 });
      } else {
        pending.resolve({ success: true, result: msg.result, durationMs: 0 });
      }
    }
  }

  private _answerServerRequest(session: StdioSession, id: string | number, method: string): void {
    const reply =
      method === 'ping'
        ? { jsonrpc: '2.0', id, result: {} }
        : { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not supported by gateway: ${method}` } };
    this._write(session, reply);
  }

  private _write(session: StdioSession, payload: unknown): boolean {
    const stdin = session.process.stdin;
    if (session.closed || !stdin || !stdin.writable) return false;
    try {
      stdin.write(JSON.stringify(payload) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  private async _sendRequest(
    serverId: string,
    req: ProxyRequest,
    timeout = DEFAULT_TIMEOUT_MS,
    limited = true,
  ): Promise<ProxyResponse> {
    const session = this.sessions.get(serverId);
    if (!session || session.closed) {
      return {
        success: false,
        error: { code: ERR_NOT_CONNECTED, message: `No session for server "${serverId}"` },
        durationMs: 0,
      };
    }

    const startTime = Date.now();
    const deadline = startTime + timeout;
    const timedOut = (): ProxyResponse => ({
      success: false,
      error: { code: ERR_TIMEOUT, message: `Request timed out after ${timeout}ms` },
      durationMs: Date.now() - startTime,
    });

    // Enforce maxConcurrency; the timeout covers time spent queued.
    let release: (() => void) | undefined;
    if (limited) {
      let queueTimer: NodeJS.Timeout | undefined;
      const slot = session.limiter.acquire();
      const winner = await Promise.race([
        slot.then((r) => ({ release: r })),
        new Promise<null>((r) => (queueTimer = setTimeout(() => r(null), timeout))),
      ]);
      clearTimeout(queueTimer);
      if (!winner) {
        // Give the slot back as soon as it is granted.
        void slot.then((r) => r());
        return timedOut();
      }
      release = winner.release;
    }

    try {
      if (session.closed) {
        return {
          success: false,
          error: { code: ERR_NOT_CONNECTED, message: `Server "${serverId}" disconnected` },
          durationMs: Date.now() - startTime,
        };
      }

      return await new Promise<ProxyResponse>((resolve) => {
        const id = req.requestId ?? nextId();
        const remaining = Math.max(0, deadline - Date.now());

        const timer = setTimeout(() => {
          session.pendingRequests.delete(id);
          // Ask the server to stop working on it.
          this._write(session, {
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId: id, reason: 'timeout' },
          });
          resolve(timedOut());
        }, remaining);

        session.pendingRequests.set(id, {
          resolve: (response) => resolve({ ...response, durationMs: Date.now() - startTime }),
          reject: (err) =>
            resolve({
              success: false,
              error: { code: ERR_NOT_CONNECTED, message: err.message },
              durationMs: Date.now() - startTime,
            }),
          timer,
        });

        const ok = this._write(session, { jsonrpc: '2.0', id, method: req.method, params: req.params });
        if (!ok) {
          clearTimeout(timer);
          session.pendingRequests.delete(id);
          resolve({
            success: false,
            error: { code: ERR_NOT_CONNECTED, message: `Server "${serverId}" is not writable` },
            durationMs: Date.now() - startTime,
          });
        }
      });
    } finally {
      release?.();
    }
  }

  private _sendNotification(serverId: string, method: string, params?: unknown): void {
    const session = this.sessions.get(serverId);
    if (!session) return;
    this._write(session, params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
  }
}
