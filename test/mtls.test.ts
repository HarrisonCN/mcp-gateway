/** 4.5: zero-trust upstream mTLS (SPIFFE, rotation). */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'https';
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync } from 'fs';
import { X509Certificate } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { MtlsManager, spiffeIdsOf, spiffeMatches, loadPem } from '../src/security/mtls.js';
import { validateConfig } from '../src/config/loader.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const dir = fileURLToPath(new URL('./fixtures/mtls/', import.meta.url));
const pem = (f: string) => readFileSync(join(dir, f), 'utf8');

let srv: Server | undefined;
afterEach(() => new Promise<void>((r) => (srv ? srv.close(() => r()) : r())).then(() => (srv = undefined)));

async function upstream(): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = [];
  srv = createServer({ cert: pem('srv.pem'), key: pem('srv.key'), ca: pem('ca.pem'), requestCert: true, rejectUnauthorized: true }, (req, res) => {
    const peer = (req.socket as unknown as { getPeerCertificate(): { subjectaltname?: string; fingerprint256: string } }).getPeerCertificate();
    seen.push(peer.fingerprint256);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ client: spiffeIdsOf(peer) }));
  });
  await new Promise<void>((r) => srv!.listen(0, '127.0.0.1', () => r()));
  return { url: `https://127.0.0.1:${(srv!.address() as { port: number }).port}/mcp`, seen };
}

describe('SPIFFE helpers', () => {
  it('reads SPIFFE IDs and matches globs', () => {
    expect(spiffeIdsOf(new X509Certificate(pem('srv.pem')))).toEqual(['spiffe://example.org/ns/tools/sa/search']);
    expect(spiffeMatches('spiffe://example.org/ns/tools/*', ['spiffe://example.org/ns/tools/sa/search'])).toBe(true);
    expect(spiffeMatches('spiffe://other.org/*', ['spiffe://example.org/ns/tools/sa/search'])).toBe(false);
    expect(loadPem('-----BEGIN X-----', '/')).toBe('-----BEGIN X-----');
  });

  it('validates tls / mtls config', () => {
    expect(validateConfig({ servers: [{ id: 's', name: 's', transport: 'streamable-http', url: 'https://x/mcp', tls: { spiffeId: 'spiffe://example.org/ns/*' } }] }).servers[0]!.tls!.spiffeId).toBe('spiffe://example.org/ns/*');
    expect(() => validateConfig({ servers: [{ id: 's', name: 's', transport: 'streamable-http', url: 'https://x/mcp', tls: { spiffeId: 'https://nope' } }] })).toThrow(/spiffe/);
    expect(validateConfig({ mtls: { identity: { cert: 'a.pem', key: 'a.key' }, reloadIntervalSeconds: 0 } }).mtls!.identity!.cert).toBe('a.pem');
  });
});

describe('MtlsManager', () => {
  it('presents the gateway identity, verifies the peer SPIFFE ID and rotates certificates', async () => {
    const { url, seen } = await upstream();
    const work = mkdtempSync(join(tmpdir(), 'mgw-mtls-'));
    for (const f of ['cli.pem', 'cli.key', 'ca.pem']) copyFileSync(join(dir, f), join(work, f));
    const cfg = { identity: { cert: 'cli.pem', key: 'cli.key', bundle: 'ca.pem' }, reloadIntervalSeconds: 0 };
    const m = new MtlsManager(() => cfg, () => work);
    m.start();
    const server = { id: 'search', url, tls: { spiffeId: 'spiffe://example.org/ns/tools/*' } };
    expect(m.applies(server)).toBe(true);
    expect(m.applies({ id: 'plain', url: 'http://x' })).toBe(false);
    const r = await m.fetchFor(server)(url);
    expect(await r.json()).toEqual({ client: ['spiffe://example.org/ns/gateway/sa/mcp-gateway'] });
    expect(m.status()).toMatchObject({ enabled: true, identity: { spiffeId: 'spiffe://example.org/ns/gateway/sa/mcp-gateway', rotations: 0 }, peers: [{ server: 'search', spiffeIds: ['spiffe://example.org/ns/tools/sa/search'] }] });

    // Wrong peer identity is refused even though the CA is trusted.
    await expect(m.fetchFor({ id: 'other', url, tls: { spiffeId: 'spiffe://example.org/ns/billing/*' } })(url)).rejects.toThrow();

    // Rotation: new files are picked up, new connections use the new certificate.
    writeFileSync(join(work, 'cli.pem'), pem('cli2.pem'));
    writeFileSync(join(work, 'cli.key'), pem('cli2.key'));
    expect(m.reload()).toBe(true);
    expect(m.reload()).toBe(false);
    await (await m.fetchFor(server)(url)).json();
    expect(new Set(seen).size).toBe(2);
    expect(m.status().identity!.rotations).toBe(1);

    // A mismatched key is rejected and the current identity kept.
    writeFileSync(join(work, 'cli.key'), pem('cli.key'));
    expect(m.reload()).toBe(false);
    expect(m.status().identity!.error).toMatch(/does not match/);
    m.stop();
  }, 20_000);
});
