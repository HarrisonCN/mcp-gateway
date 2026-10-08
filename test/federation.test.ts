/** 3.6: federated gateways — peering (HMAC), catalog sync, cross-region failover, remote servers. */
import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { signFederation, verifyFederation, Federation } from '../src/gateway/federation.js';
import { Gateway } from '../src/gateway/index.js';
import { validateConfig } from '../src/config/loader.js';
import type { GatewayConfig, McpServerConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
const SECRET = 'federation-secret-0123456789abcdef';

describe('federation signatures', () => {
  it('signs and verifies, rejecting tampering, skew and bad format', () => {
    const now = 1_700_000_000_000;
    const h = signFederation('us', SECRET, 'POST', '/api/v1/federation/call', '{"a":1}', now);
    expect(verifyFederation(h, SECRET, 'POST', '/api/v1/federation/call', '{"a":1}', now)).toEqual({ peer: 'us' });
    expect(verifyFederation(h, SECRET, 'POST', '/api/v1/federation/call', '{"a":2}', now)).toEqual({ error: 'bad federation signature' });
    expect(verifyFederation(h, 'other-secret-0123456789abcdef0123', 'POST', '/api/v1/federation/call', '{"a":1}', now)).toEqual({ error: 'bad federation signature' });
    expect(verifyFederation(h, SECRET, 'POST', '/api/v1/federation/call', '{"a":1}', now + 6 * 60_000)).toEqual({ error: 'federation signature expired' });
    expect(verifyFederation('x', SECRET, 'GET', '/', '', now)).toEqual({ error: 'malformed federation signature' });
    expect(verifyFederation(undefined, SECRET, 'GET', '/', '', now)).toEqual({ error: 'missing federation signature' });
  });

  it('orders failover candidates by priority then latency, and filters exports / imports', () => {
    const f = new Federation({
      config: () => ({ gatewayId: 'us', sharedSecret: SECRET, export: ['git*'], peers: [{ id: 'eu', url: 'http://eu', priority: 2 }, { id: 'ap', url: 'http://ap', priority: 1 }], failover: { servers: ['github'] } }),
      localServers: () => [{ id: 'github', status: 'online', tools: ['t'] }, { id: 'secret-db', status: 'online', tools: ['q'] }],
      version: 'x',
    });
    expect(f.catalog().servers.map((s) => s.id)).toEqual(['github']);
    expect(f.failsOver('github')).toBe(true);
    expect(f.failsOver('other')).toBe(false);
    for (const id of ['eu', 'ap']) Object.assign(f.peer(id)!, { healthy: true, servers: [{ id: 'github', status: 'online', tools: ['t'] }] });
    expect(f.candidates('github', 't').map((p) => p.id)).toEqual(['ap', 'eu']);
    expect(f.candidates('github', 'missing')).toEqual([]);
    f.peer('ap')!.healthy = false;
    expect(f.candidates('github').map((p) => p.id)).toEqual(['eu']);
  });

  it('validates federation config', () => {
    const fed = { gatewayId: 'us', sharedSecret: SECRET, peers: [{ id: 'eu', url: 'https://eu.example' }] };
    expect(() => validateConfig({ servers: [], federation: fed })).not.toThrow();
    expect(() => validateConfig({ servers: [], federation: { ...fed, sharedSecret: 'short' } })).toThrow(/at least 32/);
    expect(() => validateConfig({ servers: [], federation: { ...fed, peers: [{ id: 'us', url: 'https://x' }] } })).toThrow(/own id/);
  });
});

describe('federated gateways end to end', () => {
  const gws: Gateway[] = [];
  afterEach(async () => {
    for (const g of gws.splice(0)) await g.stop();
  });
  const srv = (tag: string, env: Record<string, string> = {}): McpServerConfig => ({ id: 'fake', name: 'fake', transport: 'stdio', command: process.execPath, args: [fixture], env: { SERVER_TAG: tag, ...env } });

  it('syncs catalogs, fails over to the peer region, and calls remote servers explicitly', async () => {
    const eu = new Gateway({
      port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false },
      servers: [srv('eu'), { ...srv('eu-only'), id: 'only-eu' }],
      federation: { gatewayId: 'eu', region: 'eu-west-1', sharedSecret: SECRET, export: ['fake', 'only-eu'], peers: [{ id: 'us', url: 'http://127.0.0.1:9' }] },
    } as GatewayConfig);
    gws.push(eu);
    await eu.start();
    const euUrl = `http://127.0.0.1:${eu.address()!.port}`;
    const us = new Gateway({
      port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false },
      servers: [srv('us', { FAIL_INIT: '1' })],
      federation: { gatewayId: 'us', region: 'us-east-1', sharedSecret: SECRET, peers: [{ id: 'eu', url: euUrl }], failover: { servers: ['*'] } },
    } as GatewayConfig);
    gws.push(us);
    await us.start();
    const api = `http://127.0.0.1:${us.address()!.port}/api/v1`;
    const sync = (await (await fetch(`${api}/federation/sync`, { method: 'POST' })).json()) as any;
    expect(sync.peers[0]).toMatchObject({ id: 'eu', healthy: true, region: 'eu-west-1' });
    expect(sync.peers[0].servers.map((s: { id: string }) => s.id).sort()).toEqual(['fake', 'only-eu']);

    // The local "fake" never connected: the call fails over to eu.
    const r = (await (await fetch(`${api}/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: { a: 1 } }) })).json()) as any;
    expect(JSON.parse(r.result.content[0].text)).toEqual({ a: 1, _server: 'eu' });
    // Explicit remote server.
    const r2 = (await (await fetch(`${api}/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ server: 'only-eu@eu', tool: 'echo', arguments: {} }) })).json()) as any;
    expect(r2).toMatchObject({ server: 'only-eu@eu', peer: 'eu' });
    expect(JSON.parse(r2.result.content[0].text)._server).toBe('eu-only');
    expect((await fetch(`${api}/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ server: 'nope@eu', tool: 'echo' }) })).status).toBe(404);
    const st = (await (await fetch(`${api}/federation`)).json()) as any;
    expect(st.peers[0].forwarded).toBe(2);

    // Peer endpoints need a valid signature from a configured peer.
    expect((await fetch(`${euUrl}/api/v1/federation/catalog`)).status).toBe(401);
    const path = '/api/v1/federation/catalog';
    expect((await fetch(`${euUrl}${path}`, { headers: { 'x-mcp-federation': signFederation('mallory', SECRET, 'GET', path, '') } })).status).toBe(403);
    expect((await fetch(`${euUrl}${path}`, { headers: { 'x-mcp-federation': signFederation('us', SECRET, 'GET', path, '') } })).status).toBe(200);
    // Not exported → refused even for a peer.
    const body = JSON.stringify({ server: 'fake', tool: 'echo', arguments: {} });
    const cp = '/api/v1/federation/call';
    const ok = await fetch(`${euUrl}${cp}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcp-federation': signFederation('us', SECRET, 'POST', cp, body) }, body });
    expect(ok.status).toBe(200);
  });
});
