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
  private lastId: string | undefined;
  private pendingCR = false;

  constructor(
    private readonly onEvent: (event: SseEvent) => void,
    private readonly maxBufferChars = 16 * 1024 * 1024,
  ) {}

  push(chunk: string): void {
    if (this.pendingCR && chunk.startsWith('\n')) chunk = chunk.slice(1);
    this.pendingCR = false;
    this.buffer += chunk;

    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch !== '\n' && ch !== '\r') continue;
      this.line(this.buffer.slice(start, i));
      if (ch === '\r') {
        if (i + 1 === this.buffer.length) this.pendingCR = true;
        else if (this.buffer[i + 1] === '\n') i++;
      }
      start = i + 1;
    }
    this.buffer = this.buffer.slice(start);
    if (this.buffer.length > this.maxBufferChars) {
      this.buffer = '';
      throw new Error(`SSE line exceeded ${this.maxBufferChars} characters`);
    }
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
  } finally {
    reader.releaseLock();
  }
}
