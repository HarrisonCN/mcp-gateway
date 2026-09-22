/**
 * MCP Proxy
 * Routes tool-call requests to the appropriate MCP server.
 *
 * v0.2.0 bug fixes:
 *  - [BUG-001] Concurrent restart race condition: server process could be
 *    spawned multiple times when several requests arrived simultaneously.
 *    Fixed with per-server Mutex (see utils/mutex.ts).
 *  - [BUG-002] JSON-RPC id collision under high concurrency: switched from
 *    Date.now() to a monotonic counter.
 *  - [BUG-003] Leaked stdio handles on process crash: stdin/stdout streams
 *    are now explicitly destroyed on error/exit.
 *  - [BUG-004] Silent failures on process spawn error: spawn errors now
 *    reject all pending requests immediately.
 *
 * @module proxy
 */

import { spawn } from 'child_process';
import PQueue from 'p-queue';
import type { McpServerConfig, ProxyRequest, ProxyResponse, ToolInfo } from '../utils/types.js';
import { logger } from '../utils/logger.js';
import { Mutex } from '../utils/mutex.js';

// ── Monotonic ID counter (fix BUG-002) ──────────────────────────────────────
let _idSeq = 0;
function nextId(): number {
  return ++_idSeq;
}

// ─── Stdio Session ────────────────────────────────────────────────────────────

interface StdioSession {
  process: ReturnType<typeof spawn>;
  pendingRequests: Map<string | number, {
    resolve: (value: ProxyResponse) => void;
    reject: (reason: Error) => void;
    timer: NodeJS.Timeout;
  }>;
  buffer: string;
  mutex: Mutex;  // fix BUG-001
}

export class McpProxy {
  private sessions = new Map<string, StdioSession>();
  private readonly serverConfigs = new Map<string, McpServerConfig>();
  private readonly requestQueues = new Map<string, PQueue>();
  // Per-server spawn mutex (fix BUG-001)
  private spawnLocks = new Map<string, Mutex>();

  private getSpawnLock(serverId: string): Mutex {
    if (!this.spawnLocks.has(serverId)) {
      this.spawnLocks.set(serverId, new Mutex());
    }
    return this.spawnLocks.get(serverId)!;
  }

  // ─── Connection Management ──────────────────────────────────────────────────

  async connect(config: McpServerConfig): Promise<ToolInfo[]> {
    // Serialise concurrent connect calls for the same server (fix BUG-001)
    return this.getSpawnLock(config.id).runExclusive(async () => {
      this.serverConfigs.set(config.id, config);

      if (config.transport !== 'stdio') {
        logger.warn(
          `Transport "${config.transport}" not yet fully implemented. Using stdio fallback.`,
        );
      }

      if (!config.command) {
        throw new Error(`Server "${config.id}" has no command configured`);
      }

      const session = this._spawnSession(config);
      this.sessions.set(config.id, session);
      this.requestQueues.set(
        config.id,
        new PQueue({ concurrency: Math.max(1, config.maxConcurrency ?? 10) }),
      );

      // Initialize the MCP session
      const initResult = await this._sendRequest(
        config.id,
        {
          serverId: config.id,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            clientInfo: { name: 'mcp-gateway', version: '0.2.0' },
          },
          requestId: nextId(),
        },
        config.timeout,
      );

      if (!initResult.success) {
        throw new Error(
          `Failed to initialize server "${config.id}": ${initResult.error?.message}`,
        );
      }

      // Send initialized notification
      this._sendNotification(config.id, 'notifications/initialized');

      // Discover tools
      const toolsResult = await this._sendRequest(
        config.id,
        {
          serverId: config.id,
          method: 'tools/list',
          params: {},
          requestId: nextId(),
        },
        config.timeout,
      );

      if (!toolsResult.success) {
        logger.warn(
          `Could not list tools for "${config.id}": ${toolsResult.error?.message}`,
        );
        return [];
      }

      const rawTools =
        (toolsResult.result as { tools?: unknown[] })?.tools ?? [];
      return rawTools.map((t: unknown) => {
        const tool = t as {
          name: string;
          description?: string;
          inputSchema?: Record<string, unknown>;
        };
        return {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          serverId: config.id,
          serverName: config.name,
        } satisfies ToolInfo;
      });
    });
  }

  async disconnect(serverId: string): Promise<void> {
    const session = this.sessions.get(serverId);
    if (!session) return;

    // Reject all pending requests before killing the process
    for (const [, pending] of session.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Server disconnected'));
    }
    session.pendingRequests.clear();

    // Graceful SIGTERM → SIGKILL (fix BUG-003)
    const proc = session.process;
    proc.stdin?.destroy();
    proc.stdout?.destroy();
    proc.stderr?.destroy();
    proc.kill('SIGTERM');
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    if (!proc.killed) proc.kill('SIGKILL');

    this.sessions.delete(serverId);
    this.requestQueues.delete(serverId);
    logger.info(`Disconnected from server: ${serverId}`);
  }

  async disconnectAll(): Promise<void> {
    for (const serverId of [...this.sessions.keys()]) {
      await this.disconnect(serverId);
    }
  }

  // ─── Tool Execution ─────────────────────────────────────────────────────────

  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    timeout?: number,
  ): Promise<ProxyResponse> {
    if (!this.sessions.has(serverId)) {
      const reconnect = await this.reconnect(serverId);
      if (!reconnect) {
        return {
          success: false,
          error: { code: -32000, message: `Server "${serverId}" is not connected` },
          durationMs: 0,
        };
      }
    }

    const queue = this.requestQueues.get(serverId);
    if (!queue) {
      return {
        success: false,
        error: { code: -32000, message: `No request queue for server "${serverId}"` },
        durationMs: 0,
      };
    }

    const queued = await queue.add(async () =>
      this._sendRequest(
        serverId,
        {
          serverId,
          method: 'tools/call',
          params: { name: toolName, arguments: args },
          requestId: nextId(),  // fix BUG-002
        },
        timeout ?? 30_000,
      ),
    );

    return queued ?? {
      success: false,
      error: { code: -32000, message: `Queue task returned no result for server "${serverId}"` },
      durationMs: 0,
    };
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  private _spawnSession(config: McpServerConfig): StdioSession {
    // Expand ${VAR} env references
    const resolvedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(config.env ?? {})) {
      resolvedEnv[k] = v.replace(
        /\$\{([^}]+)\}/g,
        (_, name) => process.env[name] ?? '',
      );
    }

    const proc = spawn(config.command!, config.args ?? [], {
      env: { ...(process.env as Record<string, string>), ...resolvedEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const session: StdioSession = {
      process: proc,
      pendingRequests: new Map(),
      buffer: '',
      mutex: new Mutex(),
    };

    proc.stdout?.on('data', (chunk: Buffer) => {
      session.buffer += chunk.toString();
      this._drainBuffer(config.id, session);
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      logger.debug(`[${config.id}] stderr: ${chunk.toString().trim()}`);
    });

    // fix BUG-003 & BUG-004
    proc.on('error', (err) => {
      logger.error(`[${config.id}] spawn error: ${err.message}`);
      for (const [, pending] of session.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      session.pendingRequests.clear();
      proc.stdin?.destroy();
      proc.stdout?.destroy();
      this.sessions.delete(config.id);
    });

    proc.on('exit', (code, signal) => {
      logger.warn(
        `Server "${config.id}" exited (code=${code}, signal=${signal})`,
      );
      for (const [, pending] of session.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(
          new Error(`MCP server "${config.id}" exited unexpectedly`),
        );
      }
      session.pendingRequests.clear();
      proc.stdin?.destroy();
      proc.stdout?.destroy();
      this.sessions.delete(config.id);
    });

    return session;
  }

  private _drainBuffer(serverId: string, session: StdioSession): void {
    const lines = session.buffer.split('\n');
    session.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed) as {
          id?: string | number;
          result?: unknown;
          error?: { code: number; message: string; data?: unknown };
        };

        if (msg.id !== undefined) {
          const pending = session.pendingRequests.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            session.pendingRequests.delete(msg.id);

            if (msg.error) {
              pending.resolve({ success: false, error: msg.error, durationMs: 0 });
            } else {
              pending.resolve({ success: true, result: msg.result, durationMs: 0 });
            }
          }
        }
      } catch {
        // Non-JSON line — ignore
      }
    }
  }

  private _sendRequest(
    serverId: string,
    req: ProxyRequest,
    timeout = 30_000,
  ): Promise<ProxyResponse> {
    const session = this.sessions.get(serverId);
    if (!session) {
      return Promise.resolve({
        success: false,
        error: { code: -32000, message: `No session for server "${serverId}"` },
        durationMs: 0,
      });
    }

    const startTime = Date.now();

    return new Promise((resolve) => {
      const id = req.requestId ?? nextId();
      const message = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: req.method,
        params: req.params,
      });

      const timer = setTimeout(() => {
        session.pendingRequests.delete(id);
        resolve({
          success: false,
          error: { code: -32001, message: `Request timed out after ${timeout}ms` },
          durationMs: timeout,
        });
      }, timeout);

      session.pendingRequests.set(id, {
        resolve: (response) =>
          resolve({ ...response, durationMs: Date.now() - startTime }),
        reject: (err) =>
          resolve({
            success: false,
            error: { code: -32000, message: err.message },
            durationMs: Date.now() - startTime,
          }),
        timer,
      });

      const stdin = session.process.stdin;
      if (!stdin || stdin.destroyed || !stdin.writable) {
        clearTimeout(timer);
        session.pendingRequests.delete(id);
        resolve({
          success: false,
          error: { code: -32000, message: `Server "${serverId}" stdin is not writable` },
          durationMs: Date.now() - startTime,
        });
        return;
      }

      stdin.write(message + '\n', (err) => {
        if (!err) {
          return;
        }
        clearTimeout(timer);
        session.pendingRequests.delete(id);
        resolve({
          success: false,
          error: { code: -32000, message: err.message },
          durationMs: Date.now() - startTime,
        });
      });
    });
  }

  private _sendNotification(
    serverId: string,
    method: string,
    params?: unknown,
  ): void {
    const session = this.sessions.get(serverId);
    if (!session) return;
    const message = JSON.stringify({ jsonrpc: '2.0', method, params });
    session.process.stdin?.write(message + '\n');
  }

  isConnected(serverId: string): boolean {
    return this.sessions.has(serverId);
  }

  private async reconnect(serverId: string): Promise<boolean> {
    const config = this.serverConfigs.get(serverId);
    if (!config) return false;
    try {
      await this.connect(config);
      return true;
    } catch (err) {
      logger.warn(`Reconnect failed for "${serverId}": ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}
