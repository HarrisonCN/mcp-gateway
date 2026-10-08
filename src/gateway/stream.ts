/**
 * Streaming tool results with backpressure (4.4).
 *
 * `SseWriter` writes Server-Sent Events while respecting the socket's buffer: once more than `highWaterBytes` are
 * queued, droppable events (progress / partial chunks) are coalesced — only the latest one is kept and flushed on
 * `drain` — while control events (result, error) are always written. A consumer that lets more than
 * `maxBufferedBytes` pile up is disconnected (slow-consumer protection).
 *
 * @module gateway/stream
 */

export interface SseSink {
  write(chunk: string): boolean;
  end(): void;
  readonly writableLength: number;
  once(event: 'drain' | 'close', fn: () => void): unknown;
  readonly destroyed?: boolean;
}

export interface StreamLimits {
  /** Coalesce droppable events above this many queued bytes (default 64 KiB). */
  highWaterBytes?: number;
  /** Disconnect the consumer above this many queued bytes (default 8 MiB). */
  maxBufferedBytes?: number;
}

export interface SseStats {
  written: number;
  coalesced: number;
  dropped: boolean;
}

export const DEFAULT_STREAM_LIMITS: Required<StreamLimits> = { highWaterBytes: 64 * 1024, maxBufferedBytes: 8 * 1024 * 1024 };

export class SseWriter {
  private pending?: string;
  private waiting = false;
  private closed = false;
  readonly stats: SseStats = { written: 0, coalesced: 0, dropped: false };
  private readonly limits: Required<StreamLimits>;

  constructor(
    private readonly sink: SseSink,
    limits: StreamLimits = {},
  ) {
    this.limits = { ...DEFAULT_STREAM_LIMITS, ...limits };
    sink.once('close', () => (this.closed = true));
  }

  get isClosed(): boolean {
    return this.closed || !!this.sink.destroyed;
  }

  private frame(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  /** Write an event. `droppable` events may be coalesced under backpressure. Returns false once disconnected. */
  send(event: string, data: unknown, droppable = false): boolean {
    if (this.isClosed) return false;
    const chunk = this.frame(event, data);
    if (droppable && this.sink.writableLength > this.limits.highWaterBytes) {
      if (this.pending) this.stats.coalesced++;
      this.pending = chunk;
      this.waitDrain();
      return true;
    }
    if (!droppable && this.pending) this.flushPending();
    this.sink.write(chunk);
    this.stats.written++;
    if (this.sink.writableLength > this.limits.maxBufferedBytes) {
      this.stats.dropped = true;
      this.close();
      return false;
    }
    return true;
  }

  private waitDrain(): void {
    if (this.waiting) return;
    this.waiting = true;
    this.sink.once('drain', () => {
      this.waiting = false;
      if (this.pending && !this.isClosed) this.flushPending();
    });
  }

  private flushPending(): void {
    const p = this.pending!;
    this.pending = undefined;
    this.sink.write(p);
    this.stats.written++;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sink.end();
  }
}
