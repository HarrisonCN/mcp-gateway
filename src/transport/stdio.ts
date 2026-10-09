/**
 * stdio channel — spawns the MCP server as a child process and exchanges
 * newline-delimited JSON-RPC over its stdin/stdout (MCP stdio transport).
 *
 * Carries over the v0.2 / audit fixes:
 *  - stdout is decoded as a stream so multi-byte UTF-8 split across chunks survives;
 *  - stream errors (EPIPE on a dead child) never become unhandled 'error' events;
 *  - spawn errors and unexpected exits are reported once through `onclose`;
 *  - shutdown follows the MCP spec: close stdin → SIGTERM → SIGKILL, waiting
 *    for the real exit instead of trusting `proc.killed`;
 *  - un-terminated stdout is capped.
 *
 * @module transport/stdio
 */

import { spawn, type ChildProcess } from 'child_process';
import type { McpServerConfig } from '../utils/types.js';
import { logger } from '../utils/logger.js';
import { expandEnv, expandRecord, type ChannelOptions, type JsonRpcMessage, type UpstreamChannel } from './channel.js';
import { childEnv } from './isolation.js';

const MAX_BUFFER_CHARS = 16 * 1024 * 1024;

/**
 * Environment for a stdio upstream: since 10.9.1 an allowlist (see transport/isolation) — the minimal
 * `PATH` / `HOME` / locale / `TMPDIR` set, plus `security.stdioEnvPassthrough` and the server's `envPassthrough`,
 * then its explicit `env`. Upstream MCP servers are third-party code and see none of the gateway's credentials.
 */
export { childEnv } from './isolation.js';

export class StdioChannel implements UpstreamChannel {
  readonly kind = 'stdio';
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: (error: Error) => void;

  private proc?: ChildProcess;
  private buffer = '';
  private closing = false;
  private lost = false;
  private exited!: Promise<void>;

  constructor(
    private readonly config: McpServerConfig,
    private readonly options: ChannelOptions,
  ) {}

  start(): Promise<void> {
    const { config } = this;
    if (!config.command) return Promise.reject(new Error(`Server "${config.id}" has no command configured`));

    // ${VAR} is expanded in args too (the examples pass e.g. ${DATABASE_URL} as an argument).
    const proc = spawn(config.command, (config.args ?? []).map(expandEnv), {
      env: childEnv(process.env, expandRecord(config.env), [...(this.options.envPassthrough ?? []), ...(config.envPassthrough ?? [])]),
      shell: false, // never interpret command / args through a shell
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;

    let markExited!: () => void;
    this.exited = new Promise<void>((r) => (markExited = r));

    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.drain();
      if (this.buffer.length > MAX_BUFFER_CHARS) {
        logger.error(`[${config.id}] stdout line exceeded ${MAX_BUFFER_CHARS} chars; dropping session`);
        this.buffer = '';
        this.lose(new Error('MCP server sent an oversized message'));
        proc.kill('SIGKILL');
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      logger.debug(`[${config.id}] stderr: ${chunk.toString().trim()}`);
    });

    const onStreamError = (err: Error) => logger.debug(`[${config.id}] stdio stream error: ${err.message}`);
    proc.stdin?.on('error', onStreamError);
    proc.stdout?.on('error', onStreamError);
    proc.stderr?.on('error', onStreamError);

    return new Promise<void>((resolve, reject) => {
      let started = false;
      proc.once('spawn', () => {
        started = true;
        resolve();
      });
      proc.on('error', (err) => {
        logger.error(`[${config.id}] spawn error: ${err.message}`);
        markExited(); // 'exit' may never fire if spawn failed
        if (!started) {
          started = true;
          this.lost = true;
          reject(err);
          return;
        }
        this.lose(err);
      });
      proc.on('exit', (code, signal) => {
        markExited();
        if (!this.closing) logger.warn(`Server "${config.id}" exited (code=${code}, signal=${signal})`);
        this.lose(new Error(`MCP server "${config.id}" exited unexpectedly (code=${code}, signal=${signal})`));
      });
    });
  }

  private lose(err: Error): void {
    if (this.lost || this.closing) return;
    this.lost = true;
    this.onclose?.(err);
  }

  private drain(): void {
    if (!this.buffer.includes('\n')) return;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue; // Non-JSON line (some servers log to stdout) — ignore
      }
      if (msg && typeof msg === 'object') this.onmessage?.(msg as JsonRpcMessage);
    }
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const stdin = this.proc?.stdin;
    if (this.lost || this.closing || !stdin || !stdin.writable) {
      throw new Error(`Server "${this.config.id}" is not writable`);
    }
    stdin.write(JSON.stringify(message) + '\n');
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const proc = this.proc;
    if (!proc) return;

    const grace = this.options.killGraceMs;
    const isRunning = () => proc.exitCode === null && proc.signalCode === null && proc.pid !== undefined;
    const waitExit = (ms: number) =>
      Promise.race([this.exited, new Promise<void>((r) => setTimeout(r, ms).unref())]);

    if (isRunning()) {
      proc.stdin?.end();
      await waitExit(Math.min(grace, 500));
    }
    if (isRunning()) {
      proc.kill('SIGTERM');
      await waitExit(grace);
    }
    if (isRunning()) {
      proc.kill('SIGKILL');
      await waitExit(grace);
    }
    proc.stdin?.destroy();
    proc.stdout?.destroy();
    proc.stderr?.destroy();
  }
}
