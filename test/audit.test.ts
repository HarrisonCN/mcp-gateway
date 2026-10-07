import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteAuditStore, sqliteAvailable, matchesQuery } from '../src/monitor/audit.js';
import { MetricsCollector } from '../src/monitor/index.js';
import { Gateway } from '../src/gateway/index.js';
import { loadConfig } from '../src/config/loader.js';
import type { GatewayConfig, McpServerConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';
import { writeFileSync } from 'fs';

logger.setLevel('error');
const hasSqlite = sqliteAvailable();
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'mcpgw-audit-'));
  dirs.push(d);
  return d;
};
let gw: Gateway | undefined;
afterEach(async () => {
  await gw?.stop();
  gw = undefined;
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const rec = (over: Record<string, unknown> = {}) => ({
  serverId: 'a', toolName: 'echo', durationMs: 5, success: true, clientId: 'key:x', via: 'rest' as const, ...over,
});

describe('in-memory request history', () => {
  it('filters and pages newest first', () => {
    const m = new MetricsCollector();
    for (let i = 0; i < 5; i++) m.record(rec({ toolName: `t${i}`, success: i % 2 === 0 }));
    m.record(rec({ serverId: 'b', via: 'mcp', kind: 'resource', toolName: 'docs://x' }));
    const p1 = m.queryRequests({ limit: 2, server: 'a' });
    expect(p1.source).toBe('memory');
    expect(p1.requests.map((r) => r.toolName)).toEqual(['t4', 't3']);
    const p2 = m.queryRequests({ limit: 2, server: 'a', cursor: p1.nextCursor });
    expect(p2.requests.map((r) => r.toolName)).toEqual(['t2', 't1']);
    const p3 = m.queryRequests({ limit: 2, server: 'a', cursor: p2.nextCursor });
    expect(p3.requests.map((r) => r.toolName)).toEqual(['t0']);
    expect(p3.nextCursor).toBeUndefined();
    expect(m.queryRequests({ limit: 10, success: false }).requests).toHaveLength(2);
    expect(m.queryRequests({ limit: 10, via: 'mcp', kind: 'resource' }).requests[0]!.serverId).toBe('b');
    expect(() => m.queryRequests({ limit: 1, cursor: 'mnope' })).toThrow(RangeError);
  });

  it('matchesQuery handles time bounds and defaults', () => {
    const r = { ...rec(), id: '1', timestamp: new Date(1000) } as any;
    expect(matchesQuery(r, { limit: 1, since: 1000, until: 1001 })).toBe(true);
    expect(matchesQuery(r, { limit: 1, until: 1000 })).toBe(false);
    expect(matchesQuery({ ...r, via: undefined }, { limit: 1, via: 'rest', kind: 'tool' })).toBe(true);
  });
});

describe.skipIf(!hasSqlite)('SQLite audit store (node:sqlite)', () => {
  it('persists, queries with filters + cursor, and prunes', () => {
    const file = join(tmp(), 'nested', 'audit.db');
    const m = new MetricsCollector();
    const store = new SqliteAuditStore(file);
    m.setAuditStore(store);
    for (let i = 0; i < 4; i++) m.record(rec({ toolName: `t${i}`, success: i !== 2, errorMessage: i === 2 ? 'boom' : undefined }));
    m.record(rec({ serverId: 'b', clientId: undefined, via: 'mcp', kind: 'prompt', toolName: 'greet' }));
    expect(existsSync(file)).toBe(true);

    const all = m.queryRequests({ limit: 3 });
    expect(all.source).toBe('audit');
    expect(all.requests.map((r) => r.toolName)).toEqual(['greet', 't3', 't2']);
    expect(all.requests[0]).toMatchObject({ serverId: 'b', via: 'mcp', kind: 'prompt' });
    expect(all.requests[0]!.clientId).toBeUndefined();
    expect(all.requests[2]).toMatchObject({ success: false, errorMessage: 'boom' });
    expect(all.requests[0]!.timestamp).toBeInstanceOf(Date);
    const next = m.queryRequests({ limit: 3, cursor: all.nextCursor });
    expect(next.requests.map((r) => r.toolName)).toEqual(['t1', 't0']);
    expect(next.nextCursor).toBeUndefined();
    expect(store.query({ limit: 10, server: 'a', success: false }).requests).toHaveLength(1);
    expect(store.query({ limit: 10, clientId: 'key:x', tool: 't0' }).requests).toHaveLength(1);
    expect(store.query({ limit: 10, via: 'rest', kind: 'tool', since: 0, until: Date.now() + 1000 }).requests).toHaveLength(4);
    expect(() => store.query({ limit: 1, cursor: 'x' })).toThrow(RangeError);

    expect(store.prune(Date.now() + 1000)).toBe(5);
    expect(store.query({ limit: 10 }).requests).toEqual([]);
    m.setAuditStore(undefined);
    store.close();
  });

  it('survives a gateway restart and serves history from GET /requests', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
    const stdio: McpServerConfig = { id: 'one', name: 'one', transport: 'stdio', command: process.execPath, args: [fixture], timeout: 2000 };
    const file = join(tmp(), 'audit.db');
    const cfg: GatewayConfig = {
      port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false }, servers: [stdio],
      audit: { enabled: true, path: file, retentionDays: 30 },
      auth: { strategy: 'api-key', apiKeys: ['admin', { key: 'r', name: 'r', servers: ['one'] }] },
    };
    const start = async () => {
      gw = new Gateway(cfg);
      await gw.start();
      return `http://127.0.0.1:${gw.address()!.port}`;
    };
    const call = (url: string, key: string, args: unknown) =>
      fetch(`${url}/api/v1/tools/call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ tool: 'echo', arguments: args }),
      });
    let url = await start();
    await call(url, 'admin', { n: 1 });
    await call(url, 'r', { n: 2 });
    await gw!.stop();
    url = await start();
    await call(url, 'admin', { n: 3 });
    const get = async (q: string, key = 'admin') =>
      (await fetch(`${url}/api/v1/requests${q}`, { headers: { authorization: `Bearer ${key}` } })).json() as Promise<any>;
    const h = await get('?limit=2');
    expect(h.source).toBe('audit');
    expect(h.requests).toHaveLength(2);
    expect(h.nextCursor).toBeTruthy();
    expect((await get(`?limit=2&cursor=${h.nextCursor}`)).requests).toHaveLength(1);
    expect((await get('?client=key:r')).requests).toHaveLength(1);
    // restricted key: only its own, even when asking for another client
    expect((await get('?client=nobody', 'r')).requests.map((x: any) => x.clientId)).toEqual(['key:r']);
    expect((await get(`?since=${new Date(Date.now() + 60_000).toISOString()}`)).requests).toEqual([]);
  });
});

describe('GET /requests parameters', () => {
  it('validates filters', async () => {
    gw = new Gateway({ port: 0, host: '127.0.0.1', logLevel: 'error', servers: [] });
    await gw.start();
    const url = `http://127.0.0.1:${gw.address()!.port}/api/v1/requests`;
    for (const q of ['?since=yesterday', '?success=maybe', '?via=ws', '?kind=x', '?cursor=bad']) {
      expect((await fetch(url + q)).status, q).toBe(400);
    }
    const ok: any = await (await fetch(`${url}?limit=5&since=0`)).json();
    expect(ok).toEqual({ requests: [], source: 'memory' });
  });
});

describe('audit config', () => {
  it('parses the audit block and fails clearly without node:sqlite', async () => {
    const d = tmp();
    const p = join(d, 'gw.yml');
    writeFileSync(p, 'audit: {enabled: true}\n');
    expect((await loadConfig(p)).audit).toEqual({ enabled: true, path: 'mcp-gateway-audit.db', retentionDays: 30 });
    writeFileSync(p, 'audit: {enabled: true, retentionDays: -1}\n');
    await expect(loadConfig(p)).rejects.toThrow(/audit/);
    if (!hasSqlite) {
      gw = new Gateway({ port: 0, host: '127.0.0.1', logLevel: 'error', servers: [], audit: { enabled: true, path: join(d, 'x.db') } });
      await expect(gw.start()).rejects.toThrow(/node:sqlite/);
      gw = undefined;
    }
  });
});

describe('dashboard history panel', () => {
  it('ships filter controls and cursor paging', async () => {
    gw = new Gateway({ port: 0, host: '127.0.0.1', logLevel: 'error', servers: [] });
    await gw.start();
    const html = await (await fetch(`http://127.0.0.1:${gw.address()!.port}/dashboard`)).text();
    for (const id of ['id="req-filters"', 'id="f-server"', 'id="req-more"', "q.set('cursor'", 'persistent audit log']) {
      expect(html).toContain(id);
    }
  });
});
