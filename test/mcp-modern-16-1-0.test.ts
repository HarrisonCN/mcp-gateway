/**
 * 16.1.0-canary.0: dual-era `/mcp` — the stateless MCP 2026-07-28 core next to the handshake revisions.
 * Spec: https://modelcontextprotocol.io/specification/2026-07-28 (versioning, server/discover, Streamable HTTP).
 *
 *  M1 `server/discover` (no session): resultType complete, supportedVersions = 2026-07-28 + the handshake revisions,
 *     capabilities, `_meta` serverInfo, ttlMs / cacheScope; no Mcp-Session-Id is minted.
 *  M2 a modern request (params._meta protocolVersion, no session) is served statelessly: tools/list with resultType,
 *     serverInfo, ttlMs + cacheScope "private", deterministic order; tools/call through the same policy path
 *     (scope still applies); no session is created.
 *  M3 Streamable HTTP server validation → 400 + -32020 HeaderMismatch: missing / different MCP-Protocol-Version,
 *     missing / different Mcp-Method, missing / different Mcp-Name (tools/call, resources/read, prompts/get); the
 *     Base64 sentinel form of Mcp-Name is decoded before comparing.
 *  M4 an unsupported version → 400 + -32022 { supported, requested }; `mcp.protocolVersions` without 2026-07-28 turns
 *     the modern core off (modern requests get -32022 listing the pinned revisions; a bare discover probe keeps the
 *     13.6 "method not found" so dual-era clients fall back to initialize).
 *  M5 methods the 2026-07-28 core removed (ping, logging/setLevel, resources/subscribe|unsubscribe) → 404 + -32601;
 *     a batch body in modern mode → 400 -32600.
 *  M6 resources and prompts statelessly; an unknown resource is -32602 (2026-07-28), list/read results cacheable.
 *  M7 the handshake revisions are unchanged (initialize 2025-11-25 → session; ping works there).
 *  M8 config: `mcp.protocolVersions` accepts 2026-07-28; a list naming only it makes `/mcp` modern-only (initialize
 *     → 400 -32022 naming the supported revision).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Gateway } from '../src/gateway/index.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { VERSION } from '../src/utils/version.js';
import { DOWNSTREAM_PROTOCOL_VERSIONS, MODERN_PROTOCOL_VERSION } from '../src/mcp/endpoint.js';
import { logger } from '../src/utils/logger.js';
import { fakeServer } from './helpers/feature-gw.js';
import { validateConfig } from '../src/config/loader.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
logger.setLevel('error');
const V = '2026-07-28';
const PV = 'io.modelcontextprotocol/protocolVersion';
const SI = 'io.modelcontextprotocol/serverInfo';

let gw: Gateway;
let base: string;
let pinned: Gateway;
let pinnedBase: string;

beforeAll(async () => {
  gw = new Gateway({
    port: 0,
    host: '127.0.0.1',
    logLevel: 'error',
    monitor: { requestLog: false },
    auth: { strategy: 'api-key', apiKeys: ['op', { key: 'scoped', servers: ['a'] }, { key: 'bonly', servers: ['b'] }] },
    mcp: { toolNaming: 'prefix' },
    servers: [fakeServer('a', { FEATURES: '1' }), fakeServer('b')],
  } as GatewayConfig);
  await gw.start();
  base = `http://127.0.0.1:${gw.address()!.port}`;
  pinned = new Gateway({
    port: 0,
    host: '127.0.0.1',
    logLevel: 'error',
    monitor: { requestLog: false },
    auth: { strategy: 'api-key', apiKeys: ['op'] },
    mcp: { protocolVersions: ['2025-11-25'] },
    servers: [],
  } as GatewayConfig);
  await pinned.start();
  pinnedBase = `http://127.0.0.1:${pinned.address()!.port}`;
}, 30_000);

afterAll(async () => {
  await gw?.stop();
  await pinned?.stop();
});

const meta = (version = V) => ({ [PV]: version, 'io.modelcontextprotocol/clientInfo': { name: 'm-test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} });
async function modern(method: string, params: Record<string, unknown> = {}, o: { key?: string; headers?: Record<string, string | undefined>; version?: string; at?: string; id?: number } = {}) {
  const version = o.version ?? V;
  const name = (params.name ?? params.uri) as string | undefined;
  const h: Record<string, string> = {
    authorization: `Bearer ${o.key ?? 'op'}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': version,
    'mcp-method': method,
    ...(name !== undefined && ['tools/call', 'resources/read', 'prompts/get'].includes(method) ? { 'mcp-name': name } : {}),
  };
  for (const [k, v] of Object.entries(o.headers ?? {})) {
    if (v === undefined) delete h[k];
    else h[k] = v;
  }
  const res = await fetch(`${o.at ?? base}/mcp`, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: o.id ?? 1, method, params: { ...params, _meta: { ...meta(version), ...((params._meta as object) ?? {}) } } }) });
  const text = await res.text();
  return { status: res.status, session: res.headers.get('mcp-session-id'), body: text ? JSON.parse(text) : undefined };
}

describe('MCP 2026-07-28 stateless core on /mcp (16.1.0-canary.0)', () => {
  it('M1 server/discover answers without a session', async () => {
    expect(MODERN_PROTOCOL_VERSION).toBe(V);
    const r = await modern('server/discover');
    expect(r.status).toBe(200);
    expect(r.session).toBeNull();
    const res = r.body.result;
    expect(res.resultType).toBe('complete');
    expect(res.supportedVersions).toEqual([V, ...DOWNSTREAM_PROTOCOL_VERSIONS]);
    expect(res.capabilities.tools).toBeDefined();
    expect(res.capabilities.resources).toBeDefined();
    expect(res.capabilities.prompts).toBeDefined();
    expect(res._meta[SI]).toEqual({ name: 'mcp-gateway', version: VERSION });
    expect(typeof res.ttlMs).toBe('number');
    expect(['public', 'private']).toContain(res.cacheScope);
    // a legacy-style probe (no _meta, no headers) still gets the DiscoverResult: dual-era clients stay modern
    const legacy = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'server/discover', params: {} }) });
    expect(legacy.status).toBe(200);
    expect((await legacy.json()).result.supportedVersions[0]).toBe(V);
  });

  it('M2 tools/list and tools/call are served statelessly through the same policy path', async () => {
    const list = await modern('tools/list');
    expect(list.status).toBe(200);
    expect(list.session).toBeNull();
    const r = list.body.result;
    expect(r.resultType).toBe('complete');
    expect(r._meta[SI].name).toBe('mcp-gateway');
    expect(r.cacheScope).toBe('private');
    expect(typeof r.ttlMs).toBe('number');
    const names = r.tools.map((t: any) => t.name);
    expect(names).toEqual([...names].sort());
    expect(names).toEqual(expect.arrayContaining(['a__echo', 'b__echo']));
    const call = await modern('tools/call', { name: 'a__echo', arguments: { hi: 'modern' } });
    expect(call.status).toBe(200);
    expect(call.body.result.resultType).toBe('complete');
    expect(call.body.result._meta[SI].name).toBe('mcp-gateway');
    expect(JSON.stringify(call.body.result.content)).toContain('modern');
    // the scoped key sees only server a, statelessly as with a session
    const scopedList = await modern('tools/list', {}, { key: 'scoped' });
    expect(scopedList.body.result.tools.map((t: any) => t.name).some((n: string) => n.startsWith('b__'))).toBe(false);
    const denied = await modern('tools/call', { name: 'b__echo', arguments: {} }, { key: 'scoped' });
    expect(denied.body.result?.content).toBeUndefined();
    expect(denied.body.error ?? denied.body.result?.isError).toBeTruthy();
  });

  it('M3 header validation: 400 + -32020 HeaderMismatch', async () => {
    const bad = async (p: Promise<{ status: number; body: any }>) => {
      const r = await p;
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe(-32020);
    };
    await bad(modern('tools/list', {}, { headers: { 'mcp-protocol-version': undefined } }));
    await bad(modern('tools/list', {}, { headers: { 'mcp-protocol-version': '2025-11-25' } }));
    await bad(modern('tools/list', {}, { headers: { 'mcp-method': undefined } }));
    await bad(modern('tools/list', {}, { headers: { 'mcp-method': 'prompts/list' } }));
    await bad(modern('tools/call', { name: 'a__echo', arguments: {} }, { headers: { 'mcp-name': undefined } }));
    await bad(modern('tools/call', { name: 'a__echo', arguments: {} }, { headers: { 'mcp-name': 'b__echo' } }));
    await bad(modern('resources/read', { uri: 'live://counter' }, { headers: { 'mcp-name': 'live://other' } }));
    const enc = `=?base64?${Buffer.from('a__echo', 'utf8').toString('base64')}?=`;
    const ok = await modern('tools/call', { name: 'a__echo', arguments: {} }, { headers: { 'mcp-name': enc } });
    expect(ok.status).toBe(200);
    expect(ok.body.result.resultType).toBe('complete');
  });

  it('M4 unsupported versions: -32022 with the supported list; a pin without 2026-07-28 turns the core off', async () => {
    const r = await modern('tools/list', {}, { version: '2099-01-01' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe(-32022);
    expect(r.body.error.data.requested).toBe('2099-01-01');
    expect(r.body.error.data.supported).toEqual([V, ...DOWNSTREAM_PROTOCOL_VERSIONS]);
    const off = await modern('tools/list', {}, { at: pinnedBase });
    expect(off.status).toBe(400);
    expect(off.body.error.code).toBe(-32022);
    expect(off.body.error.data.supported).toEqual(['2025-11-25']);
    const d = await modern('server/discover', {}, { at: pinnedBase });
    expect(d.status).toBe(400);
    expect(d.body.error.code).toBe(-32022);
    // with the core off, a bare probe keeps the 13.6 answer (method not found) so dual-era clients use initialize
    const bare = await fetch(`${pinnedBase}/mcp`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'server/discover', params: {} }) });
    expect((await bare.json()).error.code).toBe(-32601);
  });

  it('M5 removed methods → 404 -32601; batches → 400 -32600', async () => {
    for (const m of ['ping', 'logging/setLevel', 'resources/subscribe', 'resources/unsubscribe']) {
      const r = await modern(m, m.startsWith('resources/') ? { uri: 'live://counter' } : m === 'logging/setLevel' ? { level: 'info' } : {});
      expect(r.status, m).toBe(404);
      expect(r.body.error.code, m).toBe(-32601);
    }
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer op', 'content-type': 'application/json', 'mcp-protocol-version': V, 'mcp-method': 'tools/list' },
      body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta() } }]),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32600);
  });

  it('M6 resources and prompts statelessly; unknown resource is -32602', async () => {
    const rl = await modern('resources/list');
    expect(rl.body.result.resources.map((x: any) => x.uri)).toContain('live://counter');
    expect(rl.body.result.cacheScope).toBe('private');
    const rd = await modern('resources/read', { uri: 'live://counter' });
    expect(rd.body.result.contents[0].text).toBe('v');
    expect(rd.body.result.resultType).toBe('complete');
    expect(typeof rd.body.result.ttlMs).toBe('number');
    const missing = await modern('resources/read', { uri: 'nope://x' }, { key: 'bonly' }); // no resource server in scope
    expect(missing.body.error.code).toBe(-32602);
    const pl = await modern('prompts/list');
    const pname = pl.body.result.prompts[0].name;
    expect(pname).toMatch(/greet/);
    const pg = await modern('prompts/get', { name: pname, arguments: { lang: 'en' } });
    // the fixture has no prompts/get: its own -32601 is forwarded with HTTP 200 (404 is only for methods the gateway lacks)
    expect(pg.status).toBe(200);
    expect(pg.body.error.code).toBe(-32601);
    const unknown = await modern('tools/frobnicate');
    expect(unknown.status).toBe(404);
  });

  it('M7 handshake revisions are unchanged', async () => {
    const init = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer op', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } } }),
    });
    expect(init.status).toBe(200);
    const sid = init.headers.get('mcp-session-id');
    expect(sid).toBeTruthy();
    const body = await init.json();
    expect(body.result.protocolVersion).toBe('2025-11-25');
    expect(body.result.resultType).toBeUndefined();
    const ping = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sid!, 'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) });
    expect((await ping.json()).result).toEqual({});
  });

  it('M8 config accepts 2026-07-28; naming only it makes /mcp modern-only', async () => {
    expect(() => validateConfig({ version: 13, mcp: { protocolVersions: ['2026-07-28', '2025-11-25'] } })).not.toThrow();
    expect(() => validateConfig({ version: 13, mcp: { protocolVersions: ['2099-01-01'] } })).toThrow(/unknown MCP revision/);
    const only = new Gateway({ port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false }, auth: { strategy: 'api-key', apiKeys: ['op'] }, mcp: { protocolVersions: ['2026-07-28'] }, servers: [] } as GatewayConfig);
    await only.start();
    try {
      const at = `http://127.0.0.1:${only.address()!.port}`;
      const d = await modern('server/discover', {}, { at });
      expect(d.body.result.supportedVersions).toEqual([V]);
      const init = await fetch(`${at}/mcp`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } } }) });
      expect(init.status).toBe(400);
      const b = await init.json();
      expect(b.error.code).toBe(-32022);
      expect(b.error.data.supported).toEqual([V]);
    } finally {
      await only.stop();
    }
  });
});
