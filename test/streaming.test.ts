/** 4.4: streaming tool results and backpressure. */
import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';
import { SseWriter } from '../src/gateway/stream.js';
import { Gateway } from '../src/gateway/index.js';
import { ERR_SERVER_BUSY } from '../src/proxy/index.js';
import { logger } from '../src/utils/logger.js';
import type { GatewayConfig } from '../src/utils/types.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));

class FakeSink extends EventEmitter {
  chunks: string[] = [];
  writableLength = 0;
  ended = false;
  write(c: string) {
    this.chunks.push(c);
    this.writableLength += c.length;
    return true;
  }
  end() {
    this.ended = true;
  }
}

describe('SseWriter', () => {
  it('coalesces droppable events under backpressure and flushes the latest on drain', () => {
    const sink = new FakeSink();
    const w = new SseWriter(sink, { highWaterBytes: 1024, maxBufferedBytes: 100_000 });
    w.send('progress', { p: 0 }, true);
    sink.writableLength = 5000; // socket backed up
    w.send('progress', { p: 1 }, true);
    w.send('progress', { p: 2 }, true);
    expect(sink.chunks).toHaveLength(1);
    expect(w.stats.coalesced).toBe(1);
    sink.writableLength = 0;
    sink.emit('drain');
    expect(sink.chunks[1]).toContain('"p":2');
    sink.writableLength = 5000;
    w.send('progress', { p: 3 }, true);
    w.send('result', { ok: true }); // control events flush the pending one first and are never dropped
    expect(sink.chunks.slice(-2).map((c) => c.split('\n')[0])).toEqual(['event: progress', 'event: result']);
  });

  it('disconnects a slow consumer', () => {
    const sink = new FakeSink();
    const w = new SseWriter(sink, { highWaterBytes: 1024, maxBufferedBytes: 4096 });
    sink.writableLength = 5000;
    expect(w.send('result', { big: true })).toBe(false);
    expect(w.stats.dropped).toBe(true);
    expect(sink.ended).toBe(true);
    expect(w.send('x', 1)).toBe(false);
  });
});

describe('streaming and load shedding in the gateway', () => {
  let gw: Gateway | undefined;
  afterEach(async () => {
    await gw?.stop();
    gw = undefined;
  });

  it('streams progress, partial chunks and the result over SSE; sheds load with maxQueue', async () => {
    gw = new Gateway({
      port: 0,
      host: '127.0.0.1',
      logLevel: 'error',
      monitor: { requestLog: false },
      servers: [
        { id: 'fake', name: 'fake', transport: 'stdio', command: process.execPath, args: [fixture], env: { FEATURES: '1' }, timeout: 5000 },
        { id: 'tight', name: 'tight', transport: 'stdio', command: process.execPath, args: [fixture], env: { SLOW_MS: '150' }, timeout: 5000, maxConcurrency: 1, maxQueue: 0 },
      ],
    } as GatewayConfig);
    await gw.start();
    const url = `http://127.0.0.1:${gw.address()!.port}/api/v1`;
    const r = await fetch(`${url}/tools/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'progress', server: 'fake', arguments: {} }) });
    expect(r.headers.get('content-type')).toMatch(/text\/event-stream/);
    const events = (await r.text()).trim().split('\n\n').map((b) => ({ event: b.split('\n')[0]!.slice(7), data: JSON.parse(b.split('\n')[1]!.slice(6)) }));
    expect(events.filter((e) => e.event === 'progress').map((e) => e.data.progress)).toEqual([1, 2, 3]);
    expect(events.filter((e) => e.event === 'partial').map((e) => e.data.text)).toEqual(['step 1', 'step 2', 'step 3']);
    const result = events.find((e) => e.event === 'result')!;
    expect(result.data).toMatchObject({ status: 200 });
    expect(events.at(-1)!.event).toBe('end');

    const call = () => fetch(`${url}/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'slow', server: 'tight', arguments: {} }) });
    const [a, b] = await Promise.all([call(), call()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 503]);
    const busy = a.status === 503 ? a : b;
    expect(busy.headers.get('retry-after')).toBe('1');
    expect(await busy.json()).toMatchObject({ code: ERR_SERVER_BUSY });
  }, 30_000);
});
