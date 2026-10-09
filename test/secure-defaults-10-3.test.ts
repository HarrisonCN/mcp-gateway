/** 10.3: secure defaults (no auth on a public bind needs --insecure) and honest labelling of experimental features. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Gateway } from '../src/gateway/index.js';
import { insecureBindError, experimentalFeatureWarnings, securityWarnings } from '../src/security/posture.js';
import { validateConfig } from '../src/config/loader.js';
import { logger } from '../src/utils/logger.js';
import type { GatewayConfig } from '../src/utils/types.js';

logger.setLevel('error');
const base = (extra: Partial<GatewayConfig> = {}): GatewayConfig => ({ port: 0, host: '0.0.0.0', logLevel: 'error', monitor: { requestLog: false }, servers: [], ...extra }) as GatewayConfig;

let gw: Gateway | undefined;
afterEach(async () => {
  await gw?.stop();
  gw = undefined;
  vi.restoreAllMocks();
});

describe('refuse to start without auth on a non-loopback address', () => {
  it('insecureBindError covers bind address, strategy, --insecure and data planes', () => {
    expect(insecureBindError(base())).toMatch(/Refusing to start.*0\.0\.0\.0.*--insecure/);
    expect(insecureBindError(base({ host: undefined as never }))).toMatch(/Refusing/);
    expect(insecureBindError(base({ host: '10.0.0.5', auth: { strategy: 'none' } }))).toMatch(/Refusing/);
    expect(insecureBindError(base({ host: '::' }))).toMatch(/Refusing/);
    expect(insecureBindError(base({ host: '127.0.0.1' }))).toBeUndefined();
    expect(insecureBindError(base({ host: 'localhost' }))).toBeUndefined();
    expect(insecureBindError(base({ host: '::1' }))).toBeUndefined();
    expect(insecureBindError(base({ auth: { strategy: 'api-key', apiKeys: ['k'] } }))).toBeUndefined();
    expect(insecureBindError(base({ security: { insecure: true } }))).toBeUndefined();
    expect(insecureBindError(base({ controlPlane: { role: 'data', url: 'https://cp', token: 't' } as never }))).toBeUndefined();
    expect(validateConfig({ security: { insecure: true } }).security?.insecure).toBe(true);
  });

  it('Gateway.start() throws, and starts with security.insecure or auth', async () => {
    gw = new Gateway(base());
    await expect(gw.start()).rejects.toThrow(/Refusing to start/);
    gw = new Gateway(base({ security: { insecure: true } }));
    await gw.start();
    expect(gw.address()?.port).toBeGreaterThan(0);
    await gw.stop();
    gw = new Gateway(base({ auth: { strategy: 'api-key', apiKeys: ['k-0123456789abcdef0123'] } }));
    await gw.start();
    expect(gw.address()?.port).toBeGreaterThan(0);
  });

  it('a hot reload that switches auth off on a public bind is refused', async () => {
    gw = new Gateway(base({ auth: { strategy: 'api-key', apiKeys: ['k-0123456789abcdef0123'] } }));
    await gw.start();
    await expect(gw.reload(base())).rejects.toThrow(/Refusing to reload/);
    await gw.reload(base({ auth: { strategy: 'api-key', apiKeys: ['k-2'] } }));
  });
});

describe('experimental features are labelled', () => {
  const confidential = { servers: [{ match: 'x', platforms: ['tdx'], measurements: ['a'.repeat(64)], trustedKeys: ['k'], validitySeconds: 60 }], nonceTtlSeconds: 60 };
  it('TEE and post-quantum TLS produce warnings that say what is and is not verified', () => {
    const w = experimentalFeatureWarnings(base({ confidential, postQuantumTls: { mode: 'prefer' } } as never));
    expect(w.map((x) => x.id)).toEqual(['experimental-confidential', 'experimental-pq-tls']);
    expect(w[0]!.message).toMatch(/EXPERIMENTAL.*Verified:.*NOT verified:.*channel binding/s);
    expect(w[1]!.message).toMatch(/EXPERIMENTAL.*Verified:.*NOT covered:.*WebSocket/s);
    expect(w.every((x) => x.level === 'info')).toBe(true); // shown by validate, does not fail --strict
    expect(experimentalFeatureWarnings(base({ postQuantumTls: { mode: 'off' } } as never))).toEqual([]);
    expect(securityWarnings(base({ host: '127.0.0.1', confidential } as never)).map((x) => x.id)).toContain('experimental-confidential');
  });

  it('are logged as warnings at startup', async () => {
    const warn = vi.spyOn(logger, 'warn');
    gw = new Gateway(base({ host: '127.0.0.1', postQuantumTls: { mode: 'prefer' } } as never));
    await gw.start();
    expect(warn.mock.calls.some(([m]) => /Experimental: features\.postQuantumTls is EXPERIMENTAL/.test(String(m)))).toBe(true);
  });
});
