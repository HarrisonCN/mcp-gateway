/**
 * 13.6.0 MCP interop: client compatibility matrix.
 *
 * Downstream: the official TypeScript SDK client (Streamable HTTP — the only downstream transport the gateway
 * serves) pinned to every revision the gateway speaks, plus the official Python SDK when it is installed
 * (`MGW_PY_MCP=<python with the "mcp" package>`, CI job "MCP compat matrix").
 * Upstream: one server per transport — stdio (fixture), Streamable HTTP and legacy HTTP+SSE (official SDK servers).
 *
 * Per revision: initialize / version negotiation, MCP-Protocol-Version header handling, tools across all three
 * upstream transports, notifications (progress, tools/list_changed), cancellation, client timeouts, session
 * resume (Last-Event-ID) and termination. Results are written to `compat-matrix.json` when
 * `MGW_COMPAT_REPORT` names a file (the CI job uploads it).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { Gateway } from '../src/gateway/index.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { PROTOCOL_VERSIONS } from '../src/mcp/compat.js';
import { logger } from '../src/utils/logger.js';
import { fakeServer } from './helpers/feature-gw.js';
import { startSseServer, startStreamableHttpServer, stats, type RemoteServer } from './fixtures/remote-servers.js';

logger.setLevel('error');

/** Revisions under test: everything the gateway speaks downstream (newest first). */
export const MATRIX_VERSIONS = [...PROTOCOL_VERSIONS];
const report: Record<string, Record<string, 'pass' | 'fail'>> = {};
const mark = (client: string, check: string, ok: boolean) => ((report[client] ??= {})[check] = ok ? 'pass' : 'fail');

let gw: Gateway;
let base: string;
let shttp: RemoteServer;
let sse: RemoteServer;

beforeAll(async () => {
  shttp = await startStreamableHttpServer();
  sse = await startSseServer();
  gw = new Gateway({
    port: 0,
    host: '127.0.0.1',
    logLevel: 'error',
    monitor: { requestLog: false },
    reconnect: { initialDelayMs: 30, maxDelayMs: 200, jitter: 0 },
    auth: { strategy: 'api-key', apiKeys: ['op'] },
    mcp: { toolNaming: 'prefix' },
    servers: [
      { ...fakeServer('stdio', { FEATURES: '1', SLOW_MS: '3000' }) },
      { id: 'shttp', name: 'shttp', transport: 'streamable-http', url: shttp.url, timeout: 5000 },
      { id: 'sse', name: 'sse', transport: 'sse', url: sse.url, timeout: 5000 },
    ],
  } as GatewayConfig);
  await gw.start();
  base = `http://127.0.0.1:${gw.address()!.port}`;
}, 30_000);

afterAll(async () => {
  await gw?.stop();
  await shttp?.close();
  await sse?.close();
  if (process.env.MGW_COMPAT_REPORT) writeFileSync(process.env.MGW_COMPAT_REPORT, JSON.stringify(report, null, 2));
});

/** Transport wrapper that makes the SDK client offer `version` (what an older SDK release would send). */
function pinVersion(inner: Transport, version: string, seen: JSONRPCMessage[] = []): Transport {
  const t: Transport = {
    start: () => inner.start(),
    close: () => inner.close(),
    send: (msg, opts) => {
      const m = msg as { method?: string; params?: Record<string, unknown> };
      if (m.method === 'initialize') m.params = { ...m.params, protocolVersion: version };
      seen.push(msg);
      return inner.send(msg, opts);
    },
    setProtocolVersion: (v: string) => inner.setProtocolVersion?.(v),
    get sessionId() {
      return inner.sessionId;
    },
  };
  inner.onmessage = (m, extra) => t.onmessage?.(m, extra);
  inner.onerror = (e) => t.onerror?.(e);
  inner.onclose = () => t.onclose?.();
  return t;
}

const auth = { requestInit: { headers: { authorization: 'Bearer op' } } };
async function connect(version: string, opts: { sessionId?: string } = {}) {
  const inner = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { ...auth, sessionId: opts.sessionId, reconnectionOptions: { initialReconnectionDelay: 20, maxReconnectionDelay: 100, reconnectionDelayGrowFactor: 1.5, maxRetries: 3 } });
  const client = new Client({ name: `matrix-${version}`, version: '1.0.0' });
  await client.connect(pinVersion(inner, version));
  return { client, inner };
}

const text = (r: unknown) => (r as { content?: Array<{ text?: string }> }).content?.[0]?.text;

describe.each(MATRIX_VERSIONS)('TypeScript SDK client @ %s', (version) => {
  const who = `ts-sdk@${version}`;

  it('initialize negotiates the offered revision and later requests carry it', async () => {
    const { client, inner } = await connect(version);
    try {
      const ok = inner.protocolVersion === version && client.getServerCapabilities()?.tools !== undefined;
      mark(who, 'initialize', ok);
      expect(inner.protocolVersion).toBe(version);
      // ping works on every revision
      await expect(client.ping()).resolves.toBeDefined();
    } finally {
      await client.close();
    }
  });

  it('lists and calls tools on stdio, Streamable HTTP and SSE upstreams', async () => {
    const { client } = await connect(version);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(['stdio__echo', 'shttp__echo', 'sse__echo']));
      expect(text(await client.callTool({ name: 'shttp__echo', arguments: { msg: version } }))).toBe(`echo:${version}`);
      expect(text(await client.callTool({ name: 'sse__echo', arguments: { msg: version } }))).toBe(`echo:${version}`);
      expect(text(await client.callTool({ name: 'stdio__echo', arguments: { v: version } }))).toContain(version);
      mark(who, 'tools x3 transports', true);
    } catch (e) {
      mark(who, 'tools x3 transports', false);
      throw e;
    } finally {
      await client.close();
    }
  });

  it('forwards notifications/progress for a tool call with a progress token', async () => {
    const { client } = await connect(version);
    try {
      const seen: number[] = [];
      const r = await client.callTool({ name: 'stdio__progress', arguments: {} }, undefined, { onprogress: (p) => seen.push(p.progress) });
      expect(text(r)).toBe('done');
      expect(seen).toEqual([1, 2, 3]);
      mark(who, 'progress', true);
    } catch (e) {
      mark(who, 'progress', false);
      throw e;
    } finally {
      await client.close();
    }
  });

  it('cancellation reaches the upstream (notifications/cancelled)', async () => {
    const { client } = await connect(version);
    try {
      const before = stats.cancelled;
      const ac = new AbortController();
      const p = client.callTool({ name: 'shttp__slow', arguments: { ms: 4000 } }, undefined, { signal: ac.signal });
      setTimeout(() => ac.abort('user'), 150);
      await expect(p).rejects.toThrow();
      const end = Date.now() + 3000;
      while (stats.cancelled === before && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
      expect(stats.cancelled).toBeGreaterThan(before);
      // the session is still usable afterwards
      expect(text(await client.callTool({ name: 'shttp__echo', arguments: { msg: 'after' } }))).toBe('echo:after');
      mark(who, 'cancellation', true);
    } catch (e) {
      mark(who, 'cancellation', false);
      throw e;
    } finally {
      await client.close();
    }
  });

  it('a client-side timeout fails the call and leaves the session usable', async () => {
    const { client } = await connect(version);
    try {
      await expect(client.callTool({ name: 'sse__slow', arguments: { ms: 2000 } }, undefined, { timeout: 200 })).rejects.toThrow(/timed out|timeout/i);
      expect(text(await client.callTool({ name: 'stdio__echo', arguments: { after: 1 } }))).toContain('after');
      mark(who, 'timeout', true);
    } catch (e) {
      mark(who, 'timeout', false);
      throw e;
    } finally {
      await client.close();
    }
  });

  it('tools/list_changed reaches the client on the GET stream', async () => {
    const { client } = await connect(version);
    try {
      let changed = 0;
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => void changed++);
      // give the standalone GET stream a moment to open
      await new Promise((r) => setTimeout(r, 150));
      await client.callTool({ name: 'shttp__add-tool', arguments: {} });
      const end = Date.now() + 4000;
      while (changed === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
      expect(changed).toBeGreaterThan(0);
      mark(who, 'list_changed', true);
    } catch (e) {
      mark(who, 'list_changed', false);
      throw e;
    } finally {
      await client.close();
    }
  });

  it('a new transport resumes the session by id; DELETE ends it', async () => {
    const first = await connect(version);
    const sid = first.inner.sessionId!;
    expect(sid).toBeTruthy();
    // a second transport re-attaches to the same session (client restart / reconnect)
    const t2 = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { ...auth, sessionId: sid });
    t2.setProtocolVersion(version);
    const replies: JSONRPCMessage[] = [];
    t2.onmessage = (m) => void replies.push(m);
    await t2.start();
    await t2.send({ jsonrpc: '2.0', id: 77, method: 'tools/list', params: {} });
    const end = Date.now() + 3000;
    while (!replies.some((m) => 'id' in m && m.id === 77) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    const ok = replies.some((m) => 'id' in m && m.id === 77 && 'result' in m);
    mark(who, 'session resume', ok);
    expect(ok).toBe(true);
    await first.inner.terminateSession();
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer op', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sid, 'mcp-protocol-version': version },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).toBe(404);
    mark(who, 'terminate', res.status === 404);
    await t2.close();
    await first.client.close();
  });
});

describe('version negotiation edge cases', () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer op', 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(body),
    });
  const init = (protocolVersion: unknown) => ({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 'raw', version: '1' } } });

  it('an unknown (newer) revision is answered with the newest the gateway speaks', async () => {
    const r = await post(init('2099-01-01'));
    expect(r.status).toBe(200);
    expect((await r.json()).result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
  });

  it('a session negotiated on one revision refuses a different MCP-Protocol-Version header', async () => {
    const r = await post(init('2025-03-26'));
    const sid = r.headers.get('mcp-session-id')!;
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': sid, 'mcp-protocol-version': '2025-03-26' });
    const ok = await post({ jsonrpc: '2.0', id: 2, method: 'ping' }, { 'mcp-session-id': sid, 'mcp-protocol-version': '2025-03-26' });
    expect(ok.status).toBe(200);
    const bad = await post({ jsonrpc: '2.0', id: 3, method: 'ping' }, { 'mcp-session-id': sid, 'mcp-protocol-version': '2025-11-25' });
    mark('raw', 'header must match negotiated', bad.status === 400);
    expect(bad.status).toBe(400);
  });

  it('a session without the header (2025-03-26 clients) is accepted', async () => {
    const r = await post(init('2025-03-26'));
    const sid = r.headers.get('mcp-session-id')!;
    const ok = await post({ jsonrpc: '2.0', id: 2, method: 'ping' }, { 'mcp-session-id': sid });
    expect(ok.status).toBe(200);
  });

  it('initialize without protocolVersion stays lenient (newest revision; unchanged since 4.1)', async () => {
    const r = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {}, clientInfo: { name: 'raw', version: '1' } } });
    const body = await r.json();
    mark('raw', 'initialize w/o protocolVersion', body.result?.protocolVersion === PROTOCOL_VERSIONS[0]);
    expect(body.result?.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
  });

  it('server/discover (2026-07-28 probe) is refused so modern clients fall back to initialize', async () => {
    const r = await post({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }, { 'mcp-protocol-version': '2026-07-28' });
    const body = await r.json().catch(() => ({}));
    // Not a session, and a JSON-RPC error the SDK treats as "legacy server": method-not-found or unsupported-version.
    expect(r.headers.get('mcp-session-id')).toBeNull();
    const ok = body.error?.code === -32601 || body.error?.code === -32022;
    mark('raw', 'server/discover fallback', ok);
    expect(ok).toBe(true);
  });
});

const PY = process.env.MGW_PY_MCP;
const PY_SCRIPT = `
import sys, json, anyio
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
import httpx2 as httpx

async def main(url):
    out = {}
    async with httpx.AsyncClient(headers={"Authorization": "Bearer op"}) as http:
        async with streamable_http_client(url, http_client=http) as streams:
            read, write = streams[0], streams[1]
            async with ClientSession(read, write) as s:
                init = await s.initialize()
                out["version"] = init.protocol_version
                tools = await s.list_tools()
                out["tools"] = sorted(t.name for t in tools.tools)
                r = await s.call_tool("sse__echo", {"msg": "py"})
                out["call"] = r.content[0].text
                seen = []
                async def prog(p, total, msg):
                    seen.append(p)
                r = await s.call_tool("stdio__progress", {}, progress_callback=prog)
                out["progress"] = seen
                out["progress_result"] = r.content[0].text
        # mode='auto' (the high-level Client default): probe server/discover (2026-07-28), fall back to initialize
        try:
            from mcp.client._probe import negotiate_auto
        except ImportError:
            negotiate_auto = None
        if negotiate_auto is not None:
            async with streamable_http_client(url, http_client=http) as streams:
                async with ClientSession(streams[0], streams[1]) as s:
                    await negotiate_auto(s)
                    out["auto"] = s.protocol_version
                    out["auto_call"] = (await s.call_tool("shttp__echo", {"msg": "auto"})).content[0].text
    print(json.dumps(out))

anyio.run(main, sys.argv[1])
`;

describe.skipIf(!PY)('Python SDK client (official "mcp" package)', () => {
  it('initialize, tools across transports, progress', async () => {
    const r = await promisify(execFile)(PY!, ['-c', PY_SCRIPT, `${base}/mcp`], { env: { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' }, encoding: 'utf8', timeout: 60_000 }).catch((e) => {
      mark('py-sdk', 'session', false);
      throw e;
    });
    const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(PROTOCOL_VERSIONS as readonly string[]).toContain(out.version);
    expect(out.tools).toEqual(expect.arrayContaining(['stdio__echo', 'shttp__echo', 'sse__echo']));
    expect(out.call).toBe('echo:py');
    expect(out.progress).toEqual([1, 2, 3]);
    if (out.auto !== undefined) {
      expect(PROTOCOL_VERSIONS as readonly string[]).toContain(out.auto);
      expect(out.auto_call).toBe('echo:auto');
      mark(`py-sdk@${out.auto}`, 'auto mode (server/discover fallback)', true);
    }
    mark(`py-sdk@${out.version}`, 'session+tools+progress', true);
  }, 70_000);
});
