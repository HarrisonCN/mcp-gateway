/** 9.4: global tool registry. */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';
import { validateConfig } from '../src/config/loader.js';
import { canonicalJson } from '../src/gateway/cache.js';
import { compareVersions, satisfies, toolRegistryState } from '../src/features/tool-registry.js';

const gws: FeatureGw[] = [];
beforeEach(() => toolRegistryState.reset());
afterEach(async () => {
  for (const g of gws.splice(0)) await g.stop();
});
const acme = generateKeyPairSync('ed25519');
const evil = generateKeyPairSync('ed25519');
const pem = acme.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const manifest = (version: string, extra: Record<string, unknown> = {}) => ({ publisher: 'acme', name: 'search', version, description: 'Web search', tools: [{ name: 'web_search' }], server: { transport: 'streamable-http', url: 'https://search.acme.example/mcp' }, ...extra });
const signed = (m: object, key = acme.privateKey) => ({ manifest: m, signature: sign(null, Buffer.from(canonicalJson(m)), key).toString('base64') });

describe('global tool registry (9.4)', () => {
  it('compares versions and matches ranges', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBeLessThan(0);
    expect(satisfies('1.4.2', '^1.2.0')).toBe(true);
    expect(satisfies('2.0.0', '^1.2.0')).toBe(false);
    expect(satisfies('0.3.1', '^0.2.0')).toBe(false);
    expect(satisfies('1.2.9', '~1.2.0')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.0')).toBe(false);
    expect(satisfies('1.2.7', '1.2.x')).toBe(true);
    expect(satisfies('2.0.0-rc.1', '*')).toBe(false);
    expect(satisfies('3.0.0', '>=1.0.0')).toBe(true);
    expect(() => validateConfig({ version: 9, servers: [], toolRegistry: { pins: { 'acme/search': 'one' } } })).toThrow(/invalid version range/);
    expect(() => validateConfig({ version: 9, servers: [], toolRegistry: { trustedPublishers: { acme: 'x' } } })).toThrow(/PEM/);
  });

  it('publishes signed manifests, refuses forgeries and rewrites, searches, resolves pins, persists', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mgw-reg-')), 'registry.json');
    const h = await startFeatureGw({ toolRegistry: { file, trustedPublishers: { acme: pem }, pins: { 'acme/search': '~1.2.0' } } } as never);
    gws.push(h);
    for (const v of ['1.2.0', '1.2.5', '1.3.0', '2.0.0-rc.1']) expect((await h.admin('tool-registry/publish', signed(manifest(v)))).status).toBe(201);
    expect((await h.admin('tool-registry/publish', signed(manifest('1.2.5')))).status).toBe(200); // idempotent
    expect((await h.admin('tool-registry/publish', signed(manifest('1.2.5', { description: 'changed' })))).body.message).toContain('immutable');
    expect((await h.admin('tool-registry/publish', signed(manifest('1.4.0'), evil.privateKey))).body.message).toContain('signature does not verify');
    expect((await h.admin('tool-registry/publish', signed({ ...manifest('1.0.0'), publisher: 'evil' }, evil.privateKey))).body.message).toContain('not trusted');
    expect((await h.admin('tool-registry/publish', signed({ ...manifest('1.0.0'), version: 'v1' }))).body.message).toContain('semver');
    const s = await h.admin('tool-registry?q=web_search');
    expect(s.body.entries).toEqual([expect.objectContaining({ id: 'acme/search', version: '1.3.0', verified: true, origin: 'local' })]);
    expect((await h.admin('tool-registry?q=nothing')).body.count).toBe(0);
    expect((await h.admin('tool-registry/acme/search/resolve')).body.version).toBe('1.2.5'); // pin ~1.2.0
    expect((await h.admin('tool-registry/acme/search/resolve?range=*')).body.version).toBe('1.3.0');
    expect((await h.admin('tool-registry/acme/search/resolve?range=^3.0.0')).status).toBe(404);
    expect((await h.admin('tool-registry/acme/search')).body.versions.map((v: any) => v.version)).toEqual(['1.2.0', '1.2.5', '1.3.0', '2.0.0-rc.1']);
    expect(existsSync(file)).toBe(true);
    toolRegistryState.reset();
    expect((await h.admin('tool-registry')).body.count).toBe(1); // reloaded from file
  });

  it('serves its index and mirrors other registries, re-verifying signatures', async () => {
    const a = await startFeatureGw({ toolRegistry: { trustedPublishers: { acme: pem } } } as never);
    gws.push(a);
    await a.admin('tool-registry/publish', signed(manifest('1.0.0')));
    const idx = await fetch(`${a.base}/api/v1/features/tool-registry/index.json`, { headers: { authorization: 'Bearer scoped' } });
    expect(((await idx.json()) as any).entries).toHaveLength(1);
    await a.stop();
    gws.pop();
    toolRegistryState.reset();
    // a partner registry (served by a plain HTTP server): one good entry, one forged
    const partner = createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer partner') return void res.writeHead(401).end();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ entries: [signed(manifest('2.0.0')), signed(manifest('2.1.0'), evil.privateKey)] }));
    });
    await new Promise<void>((r) => partner.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(partner.address() as AddressInfo).port}/index.json`;
    try {
      const b = await startFeatureGw({ toolRegistry: { trustedPublishers: { acme: pem }, mirrors: [{ url, apiKey: 'partner' }, { url: 'http://127.0.0.1:9/none' }] } } as never);
      gws.push(b);
      const sync = await b.admin('tool-registry/sync', {});
      expect(sync.body.mirrors[0]).toMatchObject({ ok: true, added: 1 });
      expect(sync.body.mirrors[1].ok).toBe(false);
      const list = await b.admin('tool-registry');
      expect(list.body.entries).toEqual([expect.objectContaining({ version: '2.0.0', origin: url })]);
      expect(list.body.mirrors[0]).toMatchObject({ ok: true, added: 1 });
    } finally {
      partner.close();
    }
  });
});
