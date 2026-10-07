import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'url';
import { Gateway } from '../src/gateway/index.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
const server = (id: string, env: Record<string, string> = {}) => ({
  id,
  name: id,
  transport: 'stdio' as const,
  command: process.execPath,
  args: [fixture],
  env,
  timeout: 2000,
});

const config: GatewayConfig = {
  port: 0,
  host: '127.0.0.1',
  logLevel: 'error',
  auth: { strategy: 'api-key', apiKeys: ['test-key'] },
  rateLimit: { limit: 1000, windowSeconds: 60 },
  monitor: { prometheus: true, requestLog: false },
  corsOrigins: ['https://a.example', 'https://b.example'],
  servers: [server('one', { SECRET: 'hunter2' }), server('two')],
};

let gw: Gateway;
let base: string;
const H = { 'content-type': 'application/json', 'x-api-key': 'test-key' };

beforeAll(async () => {
  gw = new Gateway(config);
  await gw.start();
  base = `http://127.0.0.1:${gw.address()!.port}`;
});
afterAll(async () => {
  await gw.stop();
});

describe('Gateway HTTP API', () => {
  it('health is public and reports the package version', async () => {
    const r = await fetch(`${base}/api/v1/health`);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.servers.online).toBe(2);
    expect(b.version).not.toBe('0.1.0');
  });

  it('requires auth on protected routes', async () => {
    expect((await fetch(`${base}/api/v1/servers`)).status).toBe(401);
  });

  it('redacts server env values', async () => {
    const b: any = await (await fetch(`${base}/api/v1/servers/one`, { headers: H })).json();
    expect(b.env.SECRET).toBe('***');
    expect(JSON.stringify(b)).not.toContain('hunter2');
  });

  it('returns 409 for a tool name exposed by several servers', async () => {
    const r = await fetch(`${base}/api/v1/tools/call`, { method: 'POST', headers: H, body: JSON.stringify({ tool: 'echo' }) });
    expect(r.status).toBe(409);
    const ok = await fetch(`${base}/api/v1/tools/call`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ tool: 'echo', server: 'two', arguments: { q: 1 } }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).server).toBe('two');
  });

  it('validates the request body', async () => {
    const bad = await fetch(`${base}/api/v1/tools/call`, { method: 'POST', headers: H, body: JSON.stringify({ tool: 'echo', server: 'one', arguments: [1] }) });
    expect(bad.status).toBe(400);
    const malformed = await fetch(`${base}/api/v1/tools/call`, { method: 'POST', headers: H, body: '{not json' });
    expect(malformed.status).toBe(400);
  });

  it('returns 404 for an unknown server', async () => {
    const r = await fetch(`${base}/api/v1/tools/call`, { method: 'POST', headers: H, body: JSON.stringify({ tool: 'x', server: 'nope' }) });
    expect(r.status).toBe(404);
  });

  it('reflects a single allowed CORS origin (never a comma list)', async () => {
    const r = await fetch(`${base}/api/v1/health`, { headers: { origin: 'https://b.example' } });
    expect(r.headers.get('access-control-allow-origin')).toBe('https://b.example');
    const r2 = await fetch(`${base}/api/v1/health`, { headers: { origin: 'https://evil.example' } });
    expect(r2.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('sets X-Request-Id and rejects unsafe client ids', async () => {
    const r = await fetch(`${base}/api/v1/health`, { headers: { 'x-request-id': 'abc-123' } });
    expect(r.headers.get('x-request-id')).toBe('abc-123');
    const r2 = await fetch(`${base}/api/v1/health`, { headers: { 'x-request-id': 'a'.repeat(500) } });
    expect(r2.headers.get('x-request-id')).not.toBe('a'.repeat(500));
  });

  it('serves JSON metrics to */* and Prometheus text to scrapers', async () => {
    const j = await fetch(`${base}/api/v1/metrics`, { headers: { accept: '*/*' } });
    expect(j.headers.get('content-type')).toContain('application/json');
    const p = await fetch(`${base}/api/v1/metrics`, { headers: { accept: 'text/plain;version=0.0.4' } });
    expect(await p.text()).toContain('# TYPE mcp_gateway_requests_total counter');
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const r = await fetch(`${base}/nope`);
    expect(r.status).toBe(404);
    expect(((await r.json()) as any).error.code).toBe('NOT_FOUND');
  });

  it('hot reload removes and adds servers', async () => {
    await gw.reload({ ...config, servers: [server('two'), server('three')] });
    const b: any = await (await fetch(`${base}/api/v1/servers`, { headers: H })).json();
    expect(b.servers.map((s: any) => s.id).sort()).toEqual(['three', 'two']);
  });
});

describe('Gateway startup', () => {
  it('rejects when the port is in use instead of hanging', async () => {
    const other = new Gateway({ ...config, servers: [], port: gw.address()!.port });
    await expect(other.start()).rejects.toThrow(/EADDRINUSE/);
  });

  it('refuses to start with an unsupported or incomplete auth strategy', async () => {
    const other = new Gateway({ ...config, servers: [], auth: { strategy: 'oauth2' } });
    await expect(other.start()).rejects.toThrow(/auth.oauth is not configured/);
    const bogus = new Gateway({ ...config, servers: [], auth: { strategy: 'kerberos' as never } });
    await expect(bogus.start()).rejects.toThrow(/not supported/);
  });
});
