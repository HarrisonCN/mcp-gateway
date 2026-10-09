/** 9.7: post-quantum TLS. */
import { describe, it, expect, afterEach, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';
import { mtlsFixtureDir } from './helpers/mtls-certs.js';
import { validateConfig } from '../src/config/loader.js';
import { effectiveGroups, groupsSupported, probe, pqTlsState, PqTlsSchema } from '../src/features/pq-tls.js';
import { upstreamTlsGroups } from '../src/security/mtls.js';
import type { GatewayConfig } from '../src/utils/types.js';

const PQ = groupsSupported(['X25519MLKEM768']);
let h: FeatureGw | undefined;
const servers: Server[] = [];
beforeEach(() => pqTlsState.reset());
afterEach(async () => {
  await h?.stop();
  h = undefined;
});
afterAll(() => servers.forEach((s) => s.close()));
const https = (ecdhCurve: string) =>
  new Promise<string>((resolve) => {
    const d = mtlsFixtureDir();
    const s = createServer({ key: readFileSync(join(d, 'srv.key')), cert: readFileSync(join(d, 'srv.pem')), ecdhCurve }, (_q, r) => r.end('ok'));
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve(`https://127.0.0.1:${(s.address() as AddressInfo).port}/mcp`));
  });
const cfg = (pq: Record<string, unknown>, list: Array<{ id: string; url: string }> = []) => ({ servers: list, postQuantumTls: pq }) as unknown as GatewayConfig;

describe('post-quantum TLS (9.7)', () => {
  it('validates the config and computes the groups', () => {
    expect(() => validateConfig({ version: 11, servers: [], features: { postQuantumTls: { mode: 'always' } } })).toThrow();
    expect(() => validateConfig({ version: 11, servers: [], features: { postQuantumTls: { groups: ['bad group'] } } })).toThrow();
    expect(groupsSupported(['X25519'])).toBe(true);
    expect(groupsSupported(['NOPE-KEM'])).toBe(false);
    const p = PqTlsSchema.parse({});
    expect(effectiveGroups(p)).toBe(PQ ? 'X25519MLKEM768:X25519:P-256' : 'X25519:P-256');
    expect(effectiveGroups(PqTlsSchema.parse({ mode: 'require' }))).toBe('X25519MLKEM768'); // never downgrades
    expect(effectiveGroups(PqTlsSchema.parse({ mode: 'off' }))).toBeUndefined();
  });

  it('probes upstreams: PQ support, classical handshake and certificate policy', async () => {
    const pqUrl = await https(PQ ? 'X25519MLKEM768:X25519' : 'X25519');
    const classicUrl = await https('X25519:P-256');
    const c = cfg({ mode: 'require', certificatePolicy: { maxValidityDays: 398 } });
    const a = await probe(c, { id: 'pq', url: pqUrl });
    const b = await probe(c, { id: 'classic', url: classicUrl });
    expect(a.pq).toBe(PQ);
    expect(b.pq).toBe(false);
    expect(b.pqError).toBeTruthy();
    expect(b.protocol).toBe('TLSv1.3');
    expect(b.classicalGroup).toBe('X25519');
    expect(b.certificate).toMatchObject({ keyType: 'ec', subject: expect.stringContaining('CN=srv') });
    expect(b.violations).toContain('upstream does not negotiate post-quantum key exchange (mode: require)');
    expect(b.violations.some((v) => /validity \d+ days > 398/.test(v))).toBe(true);
    const ok = await probe(cfg({ mode: 'prefer' }), { id: 'classic', url: classicUrl });
    expect(ok.violations).toEqual([]);
    const down = await probe(c, { id: 'down', url: 'https://127.0.0.1:9/mcp' });
    expect(down.violations.join()).toContain('classical handshake failed');
  });

  it('sets the upstream key-exchange groups and serves the admin API', async () => {
    const url = await https('X25519');
    h = await startFeatureGw({ postQuantumTls: { mode: 'prefer', servers: ['search*'] } } as never);
    expect(upstreamTlsGroups({ id: 'search', url: 'https://x.example/mcp' })).toBe(PQ ? 'X25519MLKEM768:X25519:P-256' : 'X25519:P-256');
    expect(upstreamTlsGroups({ id: 'search', url: 'http://x.example/mcp' })).toBeUndefined();
    expect(upstreamTlsGroups({ id: 'github', url: 'https://x.example/mcp' })).toBeUndefined();
    const g = await h.admin('pq-tls');
    expect(g.body).toMatchObject({ configured: true, mode: 'prefer', supported: PQ, servers: [] });
    expect(g.body.openssl).toBe(process.versions.openssl);
    expect((await h.admin('pq-tls/probe', { server: 'nope' })).status).toBe(404);
    expect((await h.admin('pq-tls/probe', {})).body).toEqual({ probed: 0, pq: 0, results: [] });
    await h.stop();
    h = undefined;
    expect(upstreamTlsGroups({ id: 'search', url: 'https://x.example/mcp' })).toBeUndefined(); // cleared on stop
    expect(url).toMatch(/^https:/);
  });
});
