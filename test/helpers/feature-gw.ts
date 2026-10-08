/** Shared harness for feature-module tests (5.1+): a gateway with one fake stdio server and operator / scoped keys. */
import { fileURLToPath } from 'url';
import { Gateway } from '../../src/gateway/index.js';
import type { GatewayConfig } from '../../src/utils/types.js';
import { logger } from '../../src/utils/logger.js';

logger.setLevel('error');
export const fixture = fileURLToPath(new URL('../fixtures/fake-mcp-server.mjs', import.meta.url));
export const fakeServer = (id: string, env: Record<string, string> = {}) => ({ id, name: id, transport: 'stdio' as const, command: process.execPath, args: [fixture], env, timeout: 5000 });
export const op = { authorization: 'Bearer op', 'content-type': 'application/json' };
export const scoped = { authorization: 'Bearer scoped', 'content-type': 'application/json' };

export interface FeatureGw {
  gw: Gateway;
  base: string;
  /** fetch `/api/v1/admin/<path>` as the operator (JSON body when given). */
  admin: (path: string, body?: unknown, method?: string, headers?: Record<string, string>) => Promise<{ status: number; body: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any
  stop: () => Promise<void>;
}

export async function startFeatureGw(extra: Partial<GatewayConfig> = {}): Promise<FeatureGw> {
  const gw = new Gateway({
    port: 0,
    host: '127.0.0.1',
    logLevel: 'error',
    monitor: { requestLog: false },
    servers: [fakeServer('fake')],
    auth: { strategy: 'api-key', apiKeys: ['op', { key: 'scoped', servers: ['fake'] }] },
    ...extra,
  } as GatewayConfig);
  await gw.start();
  const base = `http://127.0.0.1:${gw.address()!.port}`;
  const admin: FeatureGw['admin'] = async (path, body, method, headers = op) => {
    const res = await fetch(`${base}/api/v1/admin/${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const t = await res.text();
    let b: unknown = t;
    try { b = JSON.parse(t); } catch { /* text */ }
    return { status: res.status, body: b };
  };
  return { gw, base, admin, stop: () => gw.stop() };
}
