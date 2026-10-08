import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { Gateway } from '../src/gateway/index.js';
import { createApiRouter } from '../src/gateway/api.js';
import { ServerRegistry } from '../src/registry/index.js';
import { McpProxy } from '../src/proxy/index.js';
import { MetricsCollector } from '../src/monitor/index.js';
import type { GatewayConfig, McpServerConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';
import { startStreamableHttpServer, startWebSocketServer, type RemoteServer } from './fixtures/remote-servers.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
const stdio = (id: string, env: Record<string, string> = {}): McpServerConfig => ({
  id,
  name: id,
  transport: 'stdio',
  command: process.execPath,
  args: [fixture],
  env,
  timeout: 2000,
});

const base: GatewayConfig = {
  port: 0,
  host: '127.0.0.1',
  logLevel: 'error',
  monitor: { prometheus: true, requestLog: false },
  reconnect: { initialDelayMs: 30, maxDelayMs: 200, jitter: 0 },
  servers: [],
};

let gw: Gateway | undefined;
let remotes: RemoteServer[] = [];
afterEach(async () => {
  await gw?.stop();
  gw = undefined;
  for (const r of remotes) await r.close();
  remotes = [];
});

async function start(config: GatewayConfig): Promise<string> {
  gw = new Gateway(config);
  await gw.start();
  return `http://127.0.0.1:${gw.address()!.port}`;
}

const waitFor = async (pred: () => Promise<boolean> | boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

const call = (url: string, body: unknown, key?: string) =>
  fetch(`${url}/api/v1/tools/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });

describe('remote transports through the gateway', () => {
  it('routes tool calls to streamable-http and websocket servers', async () => {
    const http = await startStreamableHttpServer();
    const ws = await startWebSocketServer();
    remotes.push(http, ws);
    const url = await start({
      ...base,
      servers: [
        { id: 'h', name: 'HTTP', transport: 'streamable-http', url: http.url, timeout: 3000 },
        { id: 'w', name: 'WS', transport: 'websocket', url: ws.url, timeout: 3000 },
      ],
    });
    const r1 = await call(url, { tool: 'echo', server: 'h', arguments: { msg: 'a' } });
    expect(r1.status).toBe(200);
    expect(JSON.stringify(await r1.json())).toContain('echo:a');
    const r2 = await call(url, { tool: 'echo', server: 'w', arguments: { msg: 'b' } });
    expect(JSON.stringify(await r2.json())).toContain('echo:b');

    const servers: any = await (await fetch(`${url}/api/v1/servers`)).json();
    const h = servers.servers.find((s: any) => s.id === 'h');
    expect(h.session.transport).toBe('streamable-http');
    expect(h.health.status).toBe('online');
  });

  it('reconnects a websocket server after the connection drops', async () => {
    const ws = await startWebSocketServer();
    remotes.push(ws);
    const url = await start({
      ...base,
      servers: [{ id: 'w', name: 'WS', transport: 'websocket', url: ws.url, timeout: 3000 }],
    });
    await ws.dropSessions();
    await waitFor(async () => {
      const s: any = await (await fetch(`${url}/api/v1/servers/w`)).json();
      return s.health.status === 'online' && s.health.reconnect?.reconnects === 1;
    });
    const r = await call(url, { tool: 'echo', server: 'w', arguments: { msg: 'again' } });
    expect(r.status).toBe(200);
  });
});

describe('reconnect visibility', () => {
  it('shows reconnect state in /servers, /health and metrics', async () => {
    const url = await start({ ...base, servers: [stdio('one'), stdio('bad', { FAIL_INIT: '1' })] });

    const health: any = await (await fetch(`${url}/api/v1/health`)).json();
    expect(health.status).toBe('degraded');
    expect(health.servers.reconnecting).toBe(1);

    const bad: any = await (await fetch(`${url}/api/v1/servers/bad`)).json();
    expect(bad.health.status).toBe('reconnecting');
    expect(bad.health.reconnect.attempt).toBeGreaterThanOrEqual(1);
    expect(bad.health.reconnect.lastError).toMatch(/initialize/);

    const r = await call(url, { tool: 'echo', server: 'bad' });
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).status).toBe('reconnecting');

    // crash "one" and wait for it to come back
    await call(url, { tool: 'crash', server: 'one' });
    await waitFor(async () => {
      const s: any = await (await fetch(`${url}/api/v1/servers/one`)).json();
      return s.health.status === 'online' && s.health.reconnect?.reconnects === 1;
    });

    const json: any = await (await fetch(`${url}/api/v1/metrics`, { headers: { accept: 'application/json' } })).json();
    const one = json.servers.find((s: any) => s.id === 'one');
    expect(one).toMatchObject({ up: 1, reconnects: 1, status: 'online' });

    const prom = await (await fetch(`${url}/api/v1/metrics?format=prometheus`)).text();
    expect(prom).toContain('mcp_gateway_server_up{server="one"} 1');
    expect(prom).toContain('mcp_gateway_server_up{server="bad"} 0');
    expect(prom).toContain('mcp_gateway_server_reconnects_total{server="one"} 1');
    expect(prom).toContain('mcp_gateway_server_status{server="bad",status="reconnecting"} 1');
    expect(prom).toMatch(/mcp_gateway_server_reconnect_attempt\{server="bad"\} [1-9]/);
  });

  it('POST /servers/:id/reconnect forces a reconnect', async () => {
    const url = await start({ ...base, reconnect: { enabled: false }, servers: [stdio('one')] });
    await call(url, { tool: 'crash', server: 'one' });
    await waitFor(async () => {
      const s: any = await (await fetch(`${url}/api/v1/servers/one`)).json();
      return s.health.status === 'offline';
    });
    const r = await fetch(`${url}/api/v1/servers/one/reconnect`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).connected).toBe(true);
    expect((await fetch(`${url}/api/v1/servers/nope/reconnect`, { method: 'POST' })).status).toBe(404);
  });
});

describe('optional auth for health, metrics and dashboard', () => {
  const auth = { strategy: 'api-key' as const, apiKeys: ['k1'] };

  it('keeps /health and /metrics public by default', async () => {
    const url = await start({ ...base, auth });
    expect((await fetch(`${url}/api/v1/health`)).status).toBe(200);
    expect((await fetch(`${url}/api/v1/metrics`)).status).toBe(200);
    expect((await fetch(`${url}/api/v1/servers`)).status).toBe(401);
  });

  it('protects /health and /metrics when configured; liveness stays public', async () => {
    const url = await start({ ...base, auth: { ...auth, protect: { health: true, metrics: true } } });
    expect((await fetch(`${url}/api/v1/health`)).status).toBe(401);
    expect((await fetch(`${url}/api/v1/metrics`)).status).toBe(401);
    expect((await fetch(`${url}/api/v1/metrics?format=prometheus`)).status).toBe(401);
    const H = { authorization: 'Bearer k1' };
    expect((await fetch(`${url}/api/v1/health`, { headers: H })).status).toBe(200);
    expect((await fetch(`${url}/api/v1/metrics`, { headers: H })).status).toBe(200);
    const live = await fetch(`${url}/api/v1/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok' });
  });

  it('serves a dashboard that sends an API key, and can be disabled', async () => {
    let url = await start({ ...base, auth });
    const html = await (await fetch(`${url}/dashboard`)).text();
    expect(html).toContain('id="keyInput"');
    expect(html).toContain('Authorization');
    await gw!.stop();
    url = await start({ ...base, controlPlane: { dashboard: false } });
    expect((await fetch(`${url}/dashboard`)).status).toBe(404);
  });
});

describe('hot reload of auth, rate limits and CORS', () => {
  it('applies new API keys and protect flags without a restart', async () => {
    const config: GatewayConfig = { ...base, auth: { strategy: 'api-key', apiKeys: ['old'] } };
    const url = await start(config);
    const get = (key: string) => fetch(`${url}/api/v1/servers`, { headers: { authorization: `Bearer ${key}` } });
    expect((await get('old')).status).toBe(200);

    await gw!.reload({ ...config, auth: { strategy: 'api-key', apiKeys: ['new'], protect: { health: true } } });
    expect((await get('old')).status).toBe(401);
    expect((await get('new')).status).toBe(200);
    expect((await fetch(`${url}/api/v1/health`)).status).toBe(401);

    await gw!.reload({ ...config, auth: { strategy: 'none' } });
    expect((await fetch(`${url}/api/v1/servers`)).status).toBe(200);
  });

  it('applies new rate limits', async () => {
    const config: GatewayConfig = { ...base, servers: [stdio('one')] };
    const url = await start(config);
    for (let i = 0; i < 3; i++) expect((await call(url, { tool: 'echo', server: 'one' })).status).toBe(200);

    await gw!.reload({ ...config, rateLimit: { limit: 1, windowSeconds: 60 } });
    expect((await call(url, { tool: 'echo', server: 'one' })).status).toBe(200);
    expect((await call(url, { tool: 'echo', server: 'one' })).status).toBe(429);

    await gw!.reload({ ...config, rateLimit: undefined });
    expect((await call(url, { tool: 'echo', server: 'one' })).status).toBe(200);
  });

  it('applies new CORS origins', async () => {
    const config: GatewayConfig = { ...base, cors: { origins: ['https://a.example'] } };
    const url = await start(config);
    const origin = async (o: string) =>
      (await fetch(`${url}/api/v1/health`, { headers: { origin: o } })).headers.get('access-control-allow-origin');
    expect(await origin('https://b.example')).toBeNull();
    await gw!.reload({ ...config, cors: { origins: ['https://b.example'] } });
    expect(await origin('https://b.example')).toBe('https://b.example');
  });

  it('keeps the current auth when the new auth config is unusable', () => {
    const cfg: GatewayConfig = { ...base, auth: { strategy: 'api-key', apiKeys: ['k'] } };
    const router = createApiRouter(cfg, new ServerRegistry(), new McpProxy(), new MetricsCollector());
    expect(() => router.update({ ...cfg, auth: { strategy: 'oauth2' } })).not.toThrow();
    router.close();
  });
});
