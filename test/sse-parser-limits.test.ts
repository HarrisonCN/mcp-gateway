import { describe, expect, it, vi } from 'vitest';
import { readSseStream, SseParser, type SseEvent } from '../src/transport/sse-parser.js';

describe('SSE resource limits and chunk boundaries', () => {
  it.each(['\n', '\r', '\r\n'])('rejects an oversized complete line terminated by %j', (ending) => {
    const receive = vi.fn();
    const parser = new SseParser(receive, 16);
    expect(() => parser.push(`data:${'x'.repeat(12)}${ending}${ending}`)).toThrow(/SSE line exceeded 16/);
    expect(receive).not.toHaveBeenCalled();
  });

  it('rejects an oversized line split before its terminator', () => {
    const parser = new SseParser(vi.fn(), 16);
    parser.push(`data:${'x'.repeat(10)}`);
    expect(() => parser.push('xx\n\n')).toThrow(/SSE line exceeded 16/);
  });

  it('still rejects an oversized unterminated line', () => {
    const parser = new SseParser(vi.fn(), 16);
    expect(() => parser.push('x'.repeat(17))).toThrow(/SSE line exceeded 16/);
  });

  it.each([false, true])('bounds multiline events across pushes (split=%s)', (split) => {
    const receive = vi.fn();
    const parser = new SseParser(receive, 16);
    const lines = ['data:12345678\n', ': heartbeat\n', 'data:12345678\n'];
    expect(() => {
      if (split) lines.forEach((line) => parser.push(line));
      else parser.push(lines.join(''));
    }).toThrow(/SSE event exceeded 16/);
    expect(receive).not.toHaveBeenCalled();
  });

  it('counts separators between empty data lines toward the event limit', () => {
    const parser = new SseParser(vi.fn(), 16);
    expect(() => parser.push('data:\n'.repeat(18))).toThrow(/SSE event exceeded 16/);
  });

  it('accepts exact line and event boundaries, resetting the budget for the next event', () => {
    const events: SseEvent[] = [];
    const parser = new SseParser((event) => events.push(event), 16);
    parser.push(`data:${'x'.repeat(11)}\n\n`);
    parser.push('id:7\ndata:1234567\ndata:12345678\n\ndata:next\n\n');
    expect(events).toEqual([
      { event: 'message', data: 'x'.repeat(11) },
      { event: 'message', data: '1234567\n12345678', id: '7' },
      { event: 'message', data: 'next', id: '7' },
    ]);
  });

  it('allows a large chunk made of independent small events', () => {
    const receive = vi.fn();
    const parser = new SseParser(receive, 16);
    parser.push('data:x\n\n'.repeat(100));
    expect(receive).toHaveBeenCalledTimes(100);
  });

  it('keeps a pending CRLF pair across empty decoded chunks', () => {
    const events: SseEvent[] = [];
    const parser = new SseParser((event) => events.push(event));
    parser.push('data:first\r');
    parser.push('');
    parser.push('\ndata:second\r\n\r\n');
    expect(events).toEqual([{ event: 'message', data: 'first\nsecond' }]);
  });
});

describe('readSseStream cleanup', () => {
  it('cancels the source and releases its lock when an event callback throws', async () => {
    const failure = new Error('consumer failed');
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data:x\n\n')); },
      cancel,
    });
    await expect(readSseStream(body, () => { throw failure; })).rejects.toBe(failure);
    expect(cancel).toHaveBeenCalledWith(failure);
    expect(body.locked).toBe(false);
  });

  it('cancels oversized upstream input without delivering the event', async () => {
    const cancel = vi.fn();
    const receive = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data:${'x'.repeat(16 * 1024 * 1024)}\n\n`));
      },
      cancel,
    });
    await expect(readSseStream(body, receive)).rejects.toThrow(/SSE line exceeded/);
    expect(cancel).toHaveBeenCalledOnce();
    expect(receive).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
  });

  it('preserves the original error even if cancellation rejects', async () => {
    const failure = new Error('original');
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data:x\n\n')); },
      cancel() { return Promise.reject(new Error('cleanup failed')); },
    });
    await expect(readSseStream(body, () => { throw failure; })).rejects.toBe(failure);
    expect(body.locked).toBe(false);
  });

  it('decodes split UTF-8, finishes normally and leaves an incomplete last event undispatched', async () => {
    const encoded = new TextEncoder().encode('data:中文\n\ndata:unfinished');
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
      cancel,
    });
    const events: SseEvent[] = [];
    await readSseStream(body, (event) => events.push(event));
    expect(events).toEqual([{ event: 'message', data: '中文' }]);
    expect(cancel).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
  });
});
