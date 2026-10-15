/**
 * 16.1.0-canary.1: `subscriptions/listen` (MCP 2026-07-28, basic/patterns/subscriptions) for stateless callers —
 * the replacement for the GET stream and resources/subscribe.
 *
 *  S1 the listen request opens an SSE response; the first message is notifications/subscriptions/acknowledged
 *     carrying `_meta["io.modelcontextprotocol/subscriptionId"]` = the request id and the agreed filter (URIs the
 *     caller cannot reach or whose server cannot subscribe are left out); a client that does not accept
 *     text/event-stream gets 400.
 *  S2 a tools-list change upstream reaches the listener as notifications/tools/list_changed tagged with the
 *     subscription id; notification types the client did not ask for are never sent.
 *  S3 notifications/resources/updated for a subscribed URI (upstream subscribe is shared with sessions).
 *  S4 closing the stream releases the upstream subscription.
 *  S5 scope: a scoped key cannot subscribe to a resource of a server outside its scope.
 *  S6 the listen request goes through header validation (Mcp-Method) like every modern request.
 *  S7 gateway shutdown ends a listener gracefully: a `resultType: "complete"` response with the subscription id.
 *  S8 an auth reload that removes the listener's key ends it the same way (as it ends a session).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Gateway } from '../src/gateway/index.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';
import { fakeServer } from './helpers/feature-gw.js';
import { startStreamableHttpServer, type RemoteServer } from './fixtures/remote-servers.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
logger.setLevel('error');
const V = '2026-07-28';
const SUB = 'io.modelcontextprotocol/subscriptionId';
const meta = { 'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientInfo': { name: 's-test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };

let gw: Gateway;
let base: string;
let config: GatewayConfig;
let shttp: RemoteServer;

beforeAll(async () => {
  shttp = await startStreamableHttpServer();
  config = {
    port: 0,
    host: '127.0.0.1',
    logLevel: 'error',
    monitor: { requestLog: false },
    auth: { strategy: 'api-key', apiKeys: ['op', { key: 'bonly', servers: ['b', 'shttp'] }] },
    mcp: { toolNaming: 'prefix' },
    servers: [fakeServer('a', { FEATURES: '1' }), fakeServer('b'), { id: 'shttp', name: 'shttp', transport: 'streamable-http', url: shttp.url, timeout: 5000 }],
  } as GatewayConfig;
  gw = new Gateway(config);
  await gw.start();
  base = `http://127.0.0.1:${gw.address()!.port}`;
}, 30_000);

afterAll(async () => {
  await gw?.stop();
  await shttp?.close();
});

const headers = (method: string, key = 'op', extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${key}`,
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': V,
  'mcp-method': method,
  ...extra,
});

/** Opens a listener; returns the SSE messages as they arrive plus a close function. */
async function listen(id: number | string, notifications: Record<string, unknown>, o: { key?: string; headers?: Record<string, string> } = {}) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/mcp`, { method: 'POST', signal: ctrl.signal, headers: { ...headers('subscriptions/listen', o.key), ...(o.headers ?? {}) }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'subscriptions/listen', params: { _meta: meta, notifications } }) });
  const messages: any[] = [];
  let ended = false;
  if (res.headers.get('content-type')?.includes('text/event-stream') && res.body) {
    void (async () => {
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const ev = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = ev.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
            if (data) messages.push(JSON.parse(data));
          }
        }
      } catch {
        /* aborted */
      }
      ended = true;
    })();
  }
  const waitFor = async (pred: (m: any) => boolean, ms = 4000) => {
    const end = Date.now() + ms;
    for (;;) {
      const m = messages.find(pred);
      if (m) return m;
      if (Date.now() > end) throw new Error(`timed out; got ${JSON.stringify(messages)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { res, messages, waitFor, close: () => ctrl.abort(), ended: () => ended };
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: headers('tools/call', 'op', { 'mcp-name': name }), body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name, arguments: args, _meta: meta } }) });
  return r.json();
}

const until = async (pred: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('subscriptions/listen (16.1.0-canary.1)', () => {
  it('S1 acknowledgment first, with the agreed filter; SSE required', async () => {
    const l = await listen(7, { toolsListChanged: true, resourceSubscriptions: ['live://counter', 'nope://missing'] });
    try {
      expect(l.res.status).toBe(200);
      expect(l.res.headers.get('content-type')).toContain('text/event-stream');
      expect(l.res.headers.get('mcp-session-id')).toBeNull();
      const ack = await l.waitFor(() => true);
      expect(ack.method).toBe('notifications/subscriptions/acknowledged');
      expect(ack.params._meta[SUB]).toBe(7);
      expect(ack.params.notifications).toEqual({ toolsListChanged: true, resourceSubscriptions: ['live://counter'] });
    } finally {
      l.close();
    }
    const noSse = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers('subscriptions/listen'), accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'subscriptions/listen', params: { _meta: meta, notifications: { toolsListChanged: true } } }) });
    expect(noSse.status).toBe(400);
  });

  it('S2 tools/list_changed is delivered tagged; unrequested types are not', async () => {
    const l = await listen('t-1', { toolsListChanged: true });
    const other = await listen('p-1', { promptsListChanged: true });
    try {
      await l.waitFor((m) => m.method === 'notifications/subscriptions/acknowledged');
      await other.waitFor((m) => m.method === 'notifications/subscriptions/acknowledged');
      shttp.servers.at(-1)!.registerTool('late-s2', { description: 'added at runtime' }, async () => ({ content: [{ type: 'text', text: 'late' }] }));
      const n = await l.waitFor((m) => m.method === 'notifications/tools/list_changed');
      expect(n.params._meta[SUB]).toBe('t-1');
      await new Promise((r) => setTimeout(r, 300));
      expect(other.messages.map((m) => m.method)).toEqual(['notifications/subscriptions/acknowledged']);
    } finally {
      l.close();
      other.close();
    }
  });

  it('S3 resources/updated for a subscribed URI; S4 closing releases the upstream subscription', async () => {
    const ep = gw.getMcpEndpoint()!;
    const before = ep.subscriptionCount();
    const l = await listen(11, { resourceSubscriptions: ['live://counter'] });
    await l.waitFor((m) => m.method === 'notifications/subscriptions/acknowledged');
    expect(ep.subscriptionCount()).toBe(before + 1);
    const touched = await call('a__touch');
    expect(JSON.stringify(touched)).toContain('live://counter');
    const n = await l.waitFor((m) => m.method === 'notifications/resources/updated');
    expect(n.params).toEqual({ uri: 'live://counter', _meta: { [SUB]: 11 } });
    l.close();
    await until(() => ep.subscriptionCount() === before);
  });

  it('S5 a scoped key cannot subscribe outside its scope', async () => {
    const l = await listen(12, { resourceSubscriptions: ['live://counter'], toolsListChanged: true }, { key: 'bonly' });
    try {
      const ack = await l.waitFor(() => true);
      expect(ack.params.notifications).toEqual({ toolsListChanged: true });
    } finally {
      l.close();
    }
  });

  it('S6 header validation applies', async () => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: headers('tools/list'), body: JSON.stringify({ jsonrpc: '2.0', id: 13, method: 'subscriptions/listen', params: { _meta: meta, notifications: { toolsListChanged: true } } }) });
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe(-32020);
  });

  it('S8 removing the key that opened a listener ends it gracefully', async () => {
    const l = await listen(15, { toolsListChanged: true }, { key: 'bonly' });
    await l.waitFor((m) => m.method === 'notifications/subscriptions/acknowledged');
    await gw.reload({ ...config, auth: { strategy: 'api-key', apiKeys: ['op'] } } as GatewayConfig);
    const done = await l.waitFor((m) => m.id === 15);
    expect(done.result).toEqual({ resultType: 'complete', _meta: { [SUB]: 15 } });
    await until(() => l.ended());
    expect(gw.getMcpEndpoint()!.listenerCount()).toBe(0);
  });

  it('S7 shutdown ends a listener gracefully', async () => {
    const l = await listen(14, { toolsListChanged: true });
    await l.waitFor((m) => m.method === 'notifications/subscriptions/acknowledged');
    gw.getMcpEndpoint()!.close();
    const done = await l.waitFor((m) => m.id === 14);
    expect(done.result).toEqual({ resultType: 'complete', _meta: { [SUB]: 14 } });
    await until(() => l.ended());
  });
});
