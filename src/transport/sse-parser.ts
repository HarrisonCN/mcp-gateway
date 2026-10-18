/**
 * Incremental `text/event-stream` parser (WHATWG HTML §9.2).
 *
 * Feed it decoded text chunks of any size; it calls `onEvent` for every
 * complete event. Parser state survives chunk boundaries, so events, lines
 * and even CRLF pairs split across TCP chunks are handled.
 *
 * @module transport/sse-parser
 */

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export class SseParser {
  private buffer = '';
  private eventType = '';
  private dataLines: string[] = [];
  private dataChars = 0;
  private lastId: string | undefined;
  private pendingCR = false;

  constructor(
    private readonly onEvent: (event: SseEvent) => void,
    // Bound both a complete / partial line and the joined data of one event, in UTF-16 code units.
    private readonly maxBufferChars = 16 * 1024 * 1024,
  ) {}

  push(chunk: string): void {
    // TextDecoder can emit nothing for a partial UTF-8 sequence. It must not consume a pending CRLF pair.
    if (chunk.length === 0) return;
    if (this.pendingCR && chunk.startsWith('\n')) chunk = chunk.slice(1);
    this.pendingCR = false;
    const offset = this.buffer.length;
    this.buffer += chunk;

    let start = 0;
    // Previously buffered text has already been checked for line endings.
    for (let i = offset; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch !== '\n' && ch !== '\r') continue;
      if (i - start > this.maxBufferChars) this.exceeded('line');
      this.line(this.buffer.slice(start, i));
      if (ch === '\r') {
        if (i + 1 === this.buffer.length) this.pendingCR = true;
        else if (this.buffer[i + 1] === '\n') i++;
      }
      start = i + 1;
    }
    this.buffer = this.buffer.slice(start);
    if (this.buffer.length > this.maxBufferChars) this.exceeded('line');
  }

  private exceeded(kind: 'line' | 'event'): never {
    this.buffer = '';
    this.dataLines = [];
    this.dataChars = 0;
    this.eventType = '';
    this.lastId = undefined;
    this.pendingCR = false;
    throw new Error(`SSE ${kind} exceeded ${this.maxBufferChars} characters`);
  }

  private line(line: string): void {
    if (line === '') {
      this.dispatch();
      return;
    }
    if (line.startsWith(':')) return; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'event':
        this.eventType = value;
        break;
      case 'data':
        this.dataChars += value.length + (this.dataLines.length > 0 ? 1 : 0);
        if (this.dataChars > this.maxBufferChars) this.exceeded('event');
        this.dataLines.push(value);
        break;
      case 'id':
        if (!value.includes('\0')) this.lastId = value;
        break;
      default:
        break; // "retry" and unknown fields are ignored
    }
  }

  private dispatch(): void {
    if (this.dataLines.length === 0) {
      this.eventType = '';
      return;
    }
    const event: SseEvent = { event: this.eventType || 'message', data: this.dataLines.join('\n') };
    if (this.lastId !== undefined) event.id = this.lastId;
    this.eventType = '';
    this.dataLines = [];
    this.dataChars = 0;
    this.onEvent(event);
  }
}

/** Read a fetch() body stream through an SseParser until it ends. */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void,
): Promise<void> {
  const parser = new SseParser(onEvent);
  const decoder = new TextDecoder();
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) parser.push(tail);
  } catch (error) {
    // Unlocking alone leaves the upstream body active after a parser / consumer failure.
    // Cleanup must not replace the original error if the source has already failed too.
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
