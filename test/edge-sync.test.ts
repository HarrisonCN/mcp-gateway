import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { createEdgeGateway, EdgeSync, memoryStore, configFromEnv, workersHandler } from '../src/edge/entry.js';
import type { EdgeSnapshot, EdgeEvent } from '../src/edge/entry.js';
import { buildEdgeSnapshot } from '../src/gateway/edge-control.js';
import { Gateway } from '../src/gateway/index.js';
import type { GatewayConfig, ToolInfo } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const CP = 'https://cp.example';
const UP = 'https://up.example/mcp';

/** One fetch for both the control plane (snapshot / sync) and a Streamable HTTP upstream that can go down. */
function world(snapshotServers: EdgeSnapshot['config']['servers'] = [{ id: 'a', url: UP, catalog: [{ name: 'read' }, { name: 'notify' }] }]) {
  const state = { down: false, cpDown: false, etag: 'e1', pushed: [] as EdgeEvent[], calls: [] as string[], snapshotHits: 0 };
  let sid = 0;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const h = new Headers(init?.headers);
    if (url.startsWith(CP)) {
      if (state.cpDown) throw new TypeError('fetch failed');
      if (url.includes('/admin/edge/snapshot')) {
        state.snapshotHits++;
        if (h.get('if-none-match') === `"${state.etag}"`) return new Response(null, { status: 304 });
        const snap: EdgeSnapshot = { version: 'test', generatedAt: new Date().toISOString(), etag: state.etag, config: { servers: snapshotServers, apiKeys: [`sha256:${sha('k1')}`], toolNaming: 'auto' } };
        return new Response(JSON.stringify(snap), { headers: { 'content-type': 'application/json', etag: `"${state.etag}"` } });
      }
      if (url.endsWith('/admin/edge/sync')) {
        const b = JSON.parse(String(init?.body)) as { events: EdgeEvent[] };
        state.pushed.push(...b.events);
        return new Response(JSON.stringify({ accepted: b.events.length }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    }
    if (state.down) throw new TypeError('fetch failed');
    const msg = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { name?: string } };
    const reply = (result: unknown, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }), { headers: { 'content-type': 'application/json', ...extra } });
    if (msg.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'up', version: '1' } }, { 'mcp-session-id': `s${++sid}` });
    if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (msg.method === 'tools/list') return reply({ tools: [{ name: 'read', inputSchema: { type: 'object' } }, { name: 'notify', inputSchema: { type: 'object' } }] });
    if (msg.method === 'tools/call') {
      state.calls.push(String(msg.params?.name));
      if (msg.params?.name === 'bad') return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'nope' } }), { headers: { 'content-type': 'application/json' } });
      return reply({ content: [{ type: 'text', text: `did ${msg.params?.name}` }] });
    }
    return reply({});
  }) as unknown as typeof fetch;
  return { f, state };
}

const auth = { authorization: 'Bearer k1', 'content-type': 'application/json' };
const call = (gw: ReturnType<typeof createEdgeGateway>, tool: string) =>
  gw.fetch(new Request('https://edge.example/api/v1/tools/call', { method: 'POST', headers: auth, body: JSON.stringify({ tool, arguments: { x: 1 } }) }));

describe('EdgeSync client', () => {
  it('pulls snapshots with ETags and falls back to the cached one offline', async () => {
    const { f, state } = world();
    const store = memoryStore();
    const s = new EdgeSync({ controlPlane: `${CP}/`, apiKey: 'op', fetch: f, store, edgeId: 'e-1' });
    state.cpDown = true;
    expect((await s.pull()).status).toBe('none');
    state.cpDown = false;
    const first = await s.pull();
    expect(first.status).toBe('updated');
    expect(first.snapshot?.config.servers[0]?.id).toBe('a');
    expect((await s.pull()).status).toBe('unchanged');
    state.etag = 'e2';
    expect((await s.pull()).status).toBe('updated');
    state.cpDown = true;
    const off = await s.pull();
    expect(off).toMatchObject({ status: 'offline', snapshot: { etag: 'e2' } });
    // persisted: a new client over the same store sees the snapshot
    expect((await new EdgeSync({ controlPlane: CP, fetch: f, store }).cached())?.etag).toBe('e2');
  });

  it('keeps the outbox until the control plane accepts it, caps queue and outbox', async () => {
    const { f, state } = world();
    const s = new EdgeSync({ controlPlane: CP, fetch: f, maxEvents: 3, maxQueue: 2 });
    for (let i = 0; i < 5; i++) await s.record({ ts: 't', server: 'a', tool: `t${i}`, durationMs: 1, ok: true });
    expect((await s.outbox()).map((e) => e.tool)).toEqual(['t2', 't3', 't4']);
    state.cpDown = true;
    expect(await s.push()).toMatchObject({ sent: 0, offline: true });
    expect(await s.outbox()).toHaveLength(3);
    state.cpDown = false;
    expect(await s.push()).toMatchObject({ sent: 3, offline: false });
    expect(await s.outbox()).toHaveLength(0);
    expect(state.pushed).toHaveLength(3);
    const q = await Promise.all([1, 2, 3].map((n) => s.enqueue({ server: 'a', tool: `n${n}`, arguments: {} })));
    expect((await s.queued()).map((c) => c.tool)).toEqual(['n2', 'n3']);
    await s.settle([q[1]!.id], [q[2]!.id]);
    expect(await s.queued()).toMatchObject([{ tool: 'n3', attempts: 1 }]);
    expect((await s.id()).length).toBeGreaterThan(5);
    expect(() => new EdgeSync({ controlPlane: '' })).toThrow(/controlPlane/);
  });
});

describe('edge gateway offline mode', () => {
  it('boots from the control plane, serves the catalog offline, queues and replays calls', async () => {
    const { f, state } = world();
    const gw = createEdgeGateway({ servers: [], fetch: f, sync: { controlPlane: CP, apiKey: 'op', edgeId: 'edge-a' }, syncIntervalMs: 0, offline: { queueTools: ['notify'] } });
    // API keys came from the snapshot
    expect((await gw.fetch(new Request('https://edge.example/api/v1/tools'))).status).toBe(401);
    const tools = await (await gw.fetch(new Request('https://edge.example/api/v1/tools', { headers: auth }))).json();
    expect(tools.tools.map((t: { name: string }) => t.name)).toEqual(['read', 'notify']);
    expect((await call(gw, 'read')).status).toBe(200);

    state.down = true;
    gw.upstreams.get('a')!['toolsCache' as never] = undefined as never; // force a tools/list while down → catalog
    const listed = await (await gw.fetch(new Request('https://edge.example/mcp', { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }))).json();
    expect(listed.result.tools.map((t: { name: string }) => t.name)).toEqual(['read', 'notify']);
    const queued = await call(gw, 'notify');
    expect(queued.status).toBe(202);
    const qb = await queued.json();
    expect(qb.queued).toMatch(/^q-/);
    expect(qb.result.structuredContent).toEqual({ queued: true, id: qb.queued });
    expect((await call(gw, 'read')).status).toBe(502); // not queueable
    const status = await (await gw.fetch(new Request('https://edge.example/api/v1/edge/status', { headers: auth }))).json();
    expect(status).toMatchObject({ sync: true, edgeId: 'edge-a', etag: 'e1', queued: 1, offlineServers: ['a'] });

    // still down: the queued call stays
    expect(await gw.sync()).toMatchObject({ config: 'unchanged', replayed: 0, pending: 1 });
    state.down = false;
    const report = await (await gw.fetch(new Request('https://edge.example/api/v1/edge/sync', { method: 'POST', headers: auth }))).json();
    expect(report).toMatchObject({ replayed: 1, failed: 0, pending: 0, offline: false });
    expect(state.calls.filter((c) => c === 'notify')).toHaveLength(1);
    expect(state.pushed.map((e) => `${e.tool}:${e.mode}:${e.ok}`)).toEqual(['read:live:true', 'notify:queued:true', 'read:live:false', 'notify:replayed:true']);
    expect((await gw.syncClient!.queued()).length).toBe(0);
  });

  it('drops queued calls the upstream rejects, merges local headers over the snapshot, background-syncs', async () => {
    const { f, state } = world();
    const store = memoryStore();
    const sync = new EdgeSync({ controlPlane: CP, fetch: f, store, edgeId: 'edge-b' });
    await sync.enqueue({ server: 'a', tool: 'bad', arguments: {} });
    // a snapshot cached by an earlier isolate: applied at boot, then a background sync runs
    const cachedSnap: EdgeSnapshot = { version: 'test', generatedAt: 'x', etag: 'e1', config: { servers: [{ id: 'a', url: UP, catalog: [{ name: 'read' }, { name: 'notify' }] }] } };
    await store.put('mgw:snapshot', JSON.stringify(cachedSnap));
    const gw = createEdgeGateway({ servers: [{ id: 'a', url: UP, headers: { 'x-local': '1' } }, { id: 'local-only', url: 'https://other.example/mcp' }], fetch: f, sync, apiKeys: ['k1'] });
    const waits: Promise<unknown>[] = [];
    await gw.fetch(new Request('https://edge.example/api/v1/edge/status', { headers: auth }), (p) => waits.push(p));
    await Promise.all(waits);
    expect(waits).toHaveLength(1);
    expect([...gw.upstreams.keys()]).toEqual(['a', 'local-only']);
    expect(gw.upstreams.get('a')!.cfg.headers).toEqual({ 'x-local': '1' });
    expect(gw.upstreams.get('a')!.cfg.catalog).toHaveLength(2);
    expect(await sync.queued()).toEqual([]);
    expect(state.pushed).toMatchObject([{ tool: 'bad', ok: false, mode: 'replayed', error: 'nope' }]);
    // no sync configured
    expect(await createEdgeGateway({ servers: [] }).sync()).toMatchObject({ config: 'disabled' });
    expect((await createEdgeGateway({ servers: [] }).fetch(new Request('https://e/api/v1/edge/sync', { method: 'POST' }))).status).toBe(404);
  });

  it('configFromEnv wires sync + KV, workersHandler exposes scheduled()', async () => {
    const kv = memoryStore();
    const cfg = configFromEnv({ MCP_GATEWAY_CONTROL_PLANE: CP, MCP_GATEWAY_CONTROL_KEY: 'op', MCP_GATEWAY_EDGE_ID: 'w1', MCP_GATEWAY_QUEUE_TOOLS: 'notify, a__*', MCP_GATEWAY_SYNC_INTERVAL_MS: '0', MCP_GATEWAY_KV: kv });
    expect(cfg).toMatchObject({ servers: [], toolNaming: undefined, sync: { controlPlane: CP, apiKey: 'op', edgeId: 'w1', store: kv }, offline: { queueTools: ['notify', 'a__*'] }, syncIntervalMs: 0 });
    expect(configFromEnv({}).sync).toBeUndefined();
    const { f } = world();
    const h = workersHandler((env) => ({ ...configFromEnv(env), fetch: f }));
    const waits: Promise<unknown>[] = [];
    const report = await h.scheduled({}, { MCP_GATEWAY_CONTROL_PLANE: CP, MCP_GATEWAY_KV: kv }, { waitUntil: (p) => waits.push(p) });
    expect(report).toMatchObject({ config: 'updated', etag: 'e1' });
    expect(waits).toHaveLength(1);
    expect(kv.data.has('mgw:snapshot')).toBe(true);
  });
});

describe('edge control plane (Node gateway)', () => {
  let gw: Gateway | undefined;
  afterEach(async () => {
    await gw?.stop();
    gw = undefined;
  });

  it('builds snapshots from streamable-http servers, unscoped keys and the tool catalog', () => {
    const cfg = {
      servers: [
        { id: 'h', name: 'H', transport: 'streamable-http', url: 'https://h/mcp', headers: { Authorization: 'secret' }, timeout: 5000, tools: { deny: ['x'] } },
        { id: 'off', name: 'off', transport: 'streamable-http', url: 'https://o/mcp', enabled: false },
        { id: 's', name: 's', transport: 'stdio', command: 'x' },
      ],
      auth: { strategy: 'api-key', apiKeys: ['plain', `sha256:${'A'.repeat(64)}`, { key: 'scoped', servers: ['h'] }, { key: 'gone', disabled: true }, { key: 'old', expiresAt: '2000-01-01T00:00:00Z' }] },
      mcp: { toolNaming: 'prefix' },
      cors: { origins: ['https://app'] },
    } as unknown as GatewayConfig;
    const tools = [{ name: 'read', serverId: 'h', serverName: 'H', description: 'Read', inputSchema: { type: 'object' } }, { name: 'z', serverId: 's', serverName: 's' }] as ToolInfo[];
    const snap = buildEdgeSnapshot(cfg, tools);
    expect(snap.config).toEqual({
      servers: [{ id: 'h', name: 'H', url: 'https://h/mcp', tools: { deny: ['x'] }, timeoutMs: 5000, catalog: [{ name: 'read', description: 'Read', inputSchema: { type: 'object' } }] }],
      apiKeys: [`sha256:${sha('plain')}`, `sha256:${'a'.repeat(64)}`],
      toolNaming: 'prefix',
      corsOrigins: ['https://app'],
    });
    const withSecrets = buildEdgeSnapshot(cfg, tools, true);
    expect(withSecrets.config.servers[0]?.headers).toEqual({ Authorization: 'secret' });
    expect(withSecrets.etag).not.toBe(snap.etag);
    expect(buildEdgeSnapshot(cfg, tools).etag).toBe(snap.etag);
    expect(buildEdgeSnapshot({ servers: [] } as unknown as GatewayConfig, []).config.apiKeys).toBeUndefined();
  });

  it('serves snapshots and ingests sync batches; an edge gateway syncs against it end to end', async () => {
    gw = new Gateway({ port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false }, servers: [], auth: { strategy: 'api-key', apiKeys: ['op', { key: 'scoped', servers: ['x'] }] } } as GatewayConfig);
    await gw.start();
    const base = `http://127.0.0.1:${gw.address()!.port}`;
    const url = `${base}/api/v1/admin/edge`;
    const op = { authorization: 'Bearer op', 'content-type': 'application/json' };
    expect((await fetch(`${url}/snapshot`)).status).toBe(401);
    expect((await fetch(`${url}/snapshot`, { headers: { authorization: 'Bearer scoped' } })).status).toBe(403);
    expect((await fetch(`${url}/snapshot?secrets=true`, { headers: op })).status).toBe(403);
    const r = await fetch(`${url}/snapshot`, { headers: { ...op, 'x-edge-id': 'n1' } });
    const snap = (await r.json()) as EdgeSnapshot;
    expect(r.headers.get('etag')).toBe(`"${snap.etag}"`);
    expect(snap.config.apiKeys).toEqual([`sha256:${sha('op')}`]);
    expect((await fetch(`${url}/snapshot`, { headers: { ...op, 'if-none-match': `"${snap.etag}"` } })).status).toBe(304);

    expect((await fetch(`${url}/sync`, { method: 'POST', headers: op, body: JSON.stringify({ events: [] }) })).status).toBe(400);
    expect((await fetch(`${url}/sync`, { method: 'POST', headers: op, body: JSON.stringify({ edgeId: 'n1', events: 'x' }) })).status).toBe(400);
    const ev = { ts: 't', server: 'a', tool: 'read', durationMs: 5, ok: false, error: 'down', mode: 'replayed' };
    const ingest = await (await fetch(`${url}/sync`, { method: 'POST', headers: op, body: JSON.stringify({ edgeId: 'n1', events: [ev, { bogus: true }], queued: 2 }) })).json();
    expect(ingest).toEqual({ accepted: 1, dropped: 1 });
    const nodes = await (await fetch(`${url}/nodes`, { headers: op })).json();
    expect(nodes.nodes).toMatchObject([{ edgeId: 'n1', snapshotEtag: snap.etag, events: 1, errors: 1, replayed: 1, queuedCalls: 2 }]);
    const metrics = await (await fetch(`${base}/api/v1/metrics?format=json`, { headers: op })).json();
    expect(JSON.stringify(metrics)).toContain('"read"');

    // a real edge gateway against the real control plane
    const edge = createEdgeGateway({ servers: [], sync: { controlPlane: base, apiKey: 'op', edgeId: 'n2' }, syncIntervalMs: 0 });
    const health = await edge.fetch(new Request('https://edge.example/api/v1/edge/status', { headers: { authorization: 'Bearer op' } }));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ edgeId: 'n2', etag: snap.etag });
    expect((await edge.fetch(new Request('https://edge.example/api/v1/edge/status', { headers: { authorization: 'Bearer nope' } }))).status).toBe(401);
    const rep = await edge.sync();
    expect(rep).toMatchObject({ config: 'unchanged', offline: false });
    const after = await (await fetch(`${url}/nodes`, { headers: op })).json();
    expect(after.nodes.map((n: { edgeId: string }) => n.edgeId).sort()).toEqual(['n1', 'n2']);
  });
});
