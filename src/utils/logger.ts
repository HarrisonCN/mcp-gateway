/**
 * Minimal structured logger for mcp-gateway
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m', // gray
  info: '\x1b[36m',  // cyan
  warn: '\x1b[33m',  // yellow
  error: '\x1b[31m', // red
};

const RESET = '\x1b[0m';

export type { LogLevel };

export class Logger {
  private level: LogLevel = 'info';

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.level]) return;

    const ts = new Date().toISOString();
    const color = process.stdout.isTTY ? COLORS[level] : '';
    const reset = process.stdout.isTTY ? RESET : '';
    const prefix = `${color}[${level.toUpperCase().padEnd(5)}]${reset}`;
    const metaStr = meta ? ` ${safeStringify(meta)}` : '';

    const output = `${ts} ${prefix} ${message}${metaStr}`;

    if (level === 'error' || level === 'warn') {
      process.stderr.write(output + '\n');
    } else {
      process.stdout.write(output + '\n');
    }
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.log('error', message, meta);
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return '[unserializable meta]';
  }
}

export const logger = new Logger();
