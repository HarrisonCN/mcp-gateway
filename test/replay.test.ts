/** 3.2: request capture, replay and diffs. */
import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { Gateway } from '../src/gateway/index.js';
import { ReplayRecorder, jsonDiff } from '../src/gateway/replay.js';
import { validateConfig } from '../src/config/loader.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
const base = (extra: Partial<GatewayConfig> = {}): GatewayConfig => ({
  port: 0,
  host: '127.0.0.1',
  logLevel: 'error',
  monitor: { requestLog: false },
  servers: [{ id: 'fake', name: 'fake', transport: 'stdio', command: process.execPath, args: [fixture], timeout: 5000 }],
  ...extra,
});

describe('jsonDiff', () => {
  it('reports added, removed and changed paths', () => {
    expect(jsonDiff({ a: 1, b: [1, 2], c: { d: 'x' } }, { a: 2, b: [1], c: { d: 'x', e: true } })).toEqual([
      { path: 'a', change: 'changed', before: 1, after: 2 },
      { path: 'b[1]', change: 'removed', before: 2 },
      { path: 'c.e', change: 'added', after: true },
    ]);
    expect(jsonDiff({ x: [1] }, { x: [1] })).toEqual([]);
    expect(jsonDiff('a', 'b')).toEqual([{ path: '', change: 'changed', before: 'a', after: 'b' }]);
    expect(jsonDiff({}, Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i])), 3)).toHaveLength(3);
  });
});

describe('ReplayRecorder', () => {
  const call = (id: string, args: unknown = { q: 1 }) => ({ id, timestamp: new Date().toISOString(), serverId: 's', tool: 't', kind: 'tool' as const, via: 'rest' as const, durationMs: 1, success: true, arguments: args, result: { ok: true } });
  it('is off by default and bounded when on', () => {
    let cfg: GatewayConfig['replay'] = undefined;
    const r = new ReplayRecorder(() => cfg);
    r.capture(call('a'));
    expect(r.size).toBe(0);
    cfg = { enabled: true, maxEntries: 2 };
    r.capture(call('a'));
    r.capture(call('b'));
    r.capture(call('c'));
    expect(r.get('a')).toBeUndefined();
    expect(r.get('c')?.arguments).toEqual({ q: 1 });
  });

  it('redacts secrets and drops oversize payloads', () => {
    const r = new ReplayRecorder(() => ({ enabled: true, maxBytes: 64, results: false }));
    r.capture(call('a', { password: 'hunter22', q: 'x' }));
    expect(r.get('a')?.arguments).toEqual({ password: '***', q: 'x' });
    expect(r.get('a')?.result).toBeUndefined();
    r.capture(call('b', { blob: 'x'.repeat(200) }));
    expect(r.get('b')?.truncated).toBe(true);
    expect(r.get('b')?.arguments).toBeUndefined();
  });

  it('validates the replay config block', () => {
    expect(() => validateConfig({ servers: [], replay: { enabled: true, maxEntries: 10 } })).not.toThrow();
    expect(() => validateConfig({ servers: [], replay: { nope: 1 } })).toThrow();
  });
});

describe('/api/v1/requests/:id + replay', () => {
  let gw: Gateway | undefined;
  afterEach(async () => {
    await gw?.stop();
    gw = undefined;
  });
  const start = async (cfg: GatewayConfig) => {
    gw = new Gateway(cfg);
    await gw.start();
    return `http://127.0.0.1:${gw.address()!.port}/api/v1`;
  };
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('captures a call, shows it and replays it with the same or edited arguments', async () => {
    const api = await start(base({ replay: { enabled: true } }));
    const r = (await (await post(`${api}/tools/call`, { tool: 'echo', server: 'fake', arguments: { hello: 'world', token: 'ghp_abcdefghijklmnopqrstuvwxyz0123' } })).json()) as any;
    expect(r.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const c = (await (await fetch(`${api}/requests/${r.requestId}`)).json()) as any;
    expect(c).toMatchObject({ serverId: 'fake', tool: 'echo', success: true, arguments: { hello: 'world', token: '***' } });
    expect(c.result.content[0].text).toContain('world');

    const same = (await (await post(`${api}/requests/${r.requestId}/replay`, {})).json()) as any;
    expect(same.replay.status).toBe(200);
    expect(same.replay.requestId).not.toBe(r.requestId);
    // Captured arguments and result are both redacted, so a same-argument replay matches.
    expect(same.identical).toBe(true);
    expect(same.diff).toEqual([]);
    const edited = (await (await post(`${api}/requests/${r.requestId}/replay`, { arguments: { hello: 'there' } })).json()) as any;
    expect(edited.diff).toEqual([{ path: 'content[0].text', change: 'changed', before: expect.stringContaining('world'), after: '{"hello":"there"}' }]);
    // The replay itself is captured and points back at the original.
    const rc = (await (await fetch(`${api}/requests/${edited.replay.requestId}`)).json()) as any;
    expect(rc.replayOf).toBe(r.requestId);
    const again = (await (await post(`${api}/requests/${edited.replay.requestId}/replay`, {})).json()) as any;
    expect(again.identical).toBe(true);
  });

  it('is 404 when capture is off, for unknown ids, and for other clients\' calls', async () => {
    let api = await start(base());
    const r = (await (await post(`${api}/tools/call`, { tool: 'echo', server: 'fake', arguments: {} })).json()) as any;
    expect((await fetch(`${api}/requests/${r.requestId}`)).status).toBe(404);
    await gw!.stop();
    api = await start(
      base({
        replay: { enabled: true },
        auth: { strategy: 'api-key', apiKeys: ['admin-key', { name: 'a', key: 'key-a', servers: ['fake'] }, { name: 'b', key: 'key-b', servers: ['fake'] }] },
      }),
    );
    const A = { authorization: 'Bearer key-a' };
    const B = { authorization: 'Bearer key-b' };
    const ra = (await (await post(`${api}/tools/call`, { tool: 'echo', server: 'fake', arguments: { x: 1 } }, A)).json()) as any;
    expect((await fetch(`${api}/requests/${ra.requestId}`, { headers: A })).status).toBe(200);
    expect((await fetch(`${api}/requests/${ra.requestId}`, { headers: B })).status).toBe(404);
    expect((await post(`${api}/requests/${ra.requestId}/replay`, {}, B)).status).toBe(404);
    expect((await fetch(`${api}/requests/${ra.requestId}`, { headers: { authorization: 'Bearer admin-key' } })).status).toBe(200);
    expect((await fetch(`${api}/requests/00000000-0000-0000-0000-000000000000`, { headers: A })).status).toBe(404);
    expect((await post(`${api}/requests/${ra.requestId}/replay`, { arguments: [1] }, A)).status).toBe(400);
  });
});
