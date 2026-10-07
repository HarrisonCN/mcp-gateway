import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { Gateway } from '../src/gateway/index.js';
import { computeReadiness } from '../src/gateway/api.js';
import { ServerRegistry } from '../src/registry/index.js';
import type { McpProxy } from '../src/proxy/index.js';
import { logger } from '../src/utils/logger.js';
import type { GatewayConfig, McpServerConfig } from '../src/utils/types.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
const stdio = (id: string, env: Record<string, string> = {}, extra: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id,
  name: id,
  transport: 'stdio',
  command: process.execPath,
  args: [fixture],
  env,
  timeout: 2000,
  ...extra,
});
const config = (servers: McpServerConfig[], extra: Partial<GatewayConfig> = {}): GatewayConfig => ({
  port: 0,
  host: '127.0.0.1',
  logLevel: 'error',
  monitor: { prometheus: false, requestLog: false, retentionHours: 1 },
  reconnect: { enabled: false },
  servers,
  ...extra,
});

let gw: Gateway | undefined;
afterEach(async () => {
  await gw?.stop();
  gw = undefined;
});

async function start(c: GatewayConfig) {
  gw = new Gateway(c);
  await gw.start();
  return `http://127.0.0.1:${gw.address()!.port}/api/v1/health/ready`;
}

const get = async (url: string) => {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as any, headers: res.headers };
};

describe('GET /api/v1/health/ready', () => {
  it('is ready when every enabled server is connected', async () => {
    const url = await start(config([stdio('a'), stdio('b'), stdio('off', {}, { enabled: false })]));
    const r = await get(url);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'ready', servers: { ready: 2, total: 2, required: 2 } });
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('is ready with no servers configured', async () => {
    const r = await get(await start(config([])));
    expect(r.status).toBe(200);
    expect(r.body.servers).toEqual({ ready: 0, total: 0, required: 0 });
  });

  it('answers 503 while a server is down, and ?min= relaxes the requirement', async () => {
    const url = await start(config([stdio('ok'), stdio('broken', { FAIL_INIT: '1' })]));
    const all = await get(url);
    expect(all.status).toBe(503);
    expect(all.body).toEqual({ status: 'not_ready', servers: { ready: 1, total: 2, required: 2 } });

    const one = await get(`${url}?min=1`);
    expect(one.status).toBe(200);
    expect(one.body.servers.required).toBe(1);

    expect((await get(`${url}?min=3`)).status).toBe(503);
    expect((await get(`${url}?min=0`)).status).toBe(200);
  });

  it('rejects a malformed min', async () => {
    const url = await start(config([]));
    for (const bad of ['-1', 'abc', '1.5', '']) {
      const r = await get(`${url}?min=${bad}`);
      expect(r.status).toBe(400);
    }
  });

  it('treats a degraded server as not ready', async () => {
    const url = await start(config([stdio('a')]));
    expect((await get(url)).status).toBe(200);
    gw!.getRegistry().updateHealth('a', 'degraded', undefined, 'health ping failed');
    expect((await get(url)).status).toBe(503);
    gw!.getRegistry().updateHealth('a', 'online', 1);
    expect((await get(url)).status).toBe(200);
  });

  it('stays public when auth is on, even with auth.protect.health', async () => {
    const url = await start(
      config([stdio('a')], { auth: { strategy: 'api-key', apiKeys: ['secret'], protect: { health: true, metrics: true } } }),
    );
    expect((await get(url)).status).toBe(200);
    // ...while /health itself is protected
    expect((await fetch(url.replace('/ready', ''))).status).toBe(401);
  });
});

describe('computeReadiness', () => {
  const registry = new ServerRegistry();
  registry.register({ id: 'a', name: 'a', transport: 'stdio', command: 'x' });
  registry.register({ id: 'b', name: 'b', transport: 'stdio', command: 'x' });
  const proxy = { isConnected: (id: string) => id === 'a' } as unknown as McpProxy;

  it('counts connected servers against the requirement', () => {
    expect(computeReadiness(registry, proxy)).toMatchObject({ ready: false, readyServers: 1, totalServers: 2, required: 2 });
    expect(computeReadiness(registry, proxy, 1).ready).toBe(true);
  });

  it('is never ready while shutting down', () => {
    expect(computeReadiness(registry, proxy, 0, true)).toMatchObject({ ready: false, shuttingDown: true });
  });
});
