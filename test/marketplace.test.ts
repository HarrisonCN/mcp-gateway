import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { generateSigningKey, signArtifact, verifyArtifact, sha256Hex } from '../src/plugins/trust.js';
import { checkSignature, PluginHost } from '../src/plugins/index.js';
import { parseIndex, compareVersions, fetchIndexes, installEntry } from '../src/features/marketplace.js';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';

const key = generateSigningKey();
const other = generateSigningKey();
const keys = [{ id: 'k1', publicKey: key.publicKey }];
const PLUGIN = "export default { name: 'mp-demo', apiVersion: 5 };\n";
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'mgw-mp-')); dirs.push(d); return d; };
let h: FeatureGw | undefined;
let srv: Server | undefined;
afterEach(async () => {
  await h?.stop();
  srv?.close();
  h = undefined;
  srv = undefined;
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

describe('signed plugins (5.4)', () => {
  it('signs and verifies; detects tampering, unknown keys and bad keys', () => {
    const sig = signArtifact(PLUGIN, key.privateKey, 'k1');
    expect(verifyArtifact(PLUGIN, sig, keys)).toEqual({ ok: true, keyId: 'k1' });
    expect(verifyArtifact(PLUGIN + ' ', sig, keys)).toMatchObject({ ok: false, reason: expect.stringMatching(/sha256 mismatch/) });
    expect(verifyArtifact(PLUGIN, { ...sig, keyId: 'zz' }, keys)).toMatchObject({ reason: 'untrusted key "zz"' });
    expect(verifyArtifact(PLUGIN, signArtifact(PLUGIN, other.privateKey, 'k1'), keys)).toMatchObject({ reason: 'bad signature' });
    expect(verifyArtifact(PLUGIN, sig, [{ id: 'k1', publicKey: 'nope' }])).toMatchObject({ reason: expect.stringMatching(/invalid key/) });
    expect(verifyArtifact(PLUGIN, null, keys)).toMatchObject({ reason: 'malformed signature file' });
  });

  it('loads signed plugins and refuses unsigned / tampered ones per pluginTrust', async () => {
    const d = tmp();
    writeFileSync(join(d, 'p.mjs'), PLUGIN);
    writeFileSync(join(d, 'p.mjs.sig'), JSON.stringify(signArtifact(PLUGIN, key.privateKey, 'k1')));
    writeFileSync(join(d, 'u.mjs'), PLUGIN.replace('mp-demo', 'mp-u'));
    expect(await checkSignature({ module: './p.mjs' }, d, { keys })).toBe('k1');
    expect(await checkSignature({ module: './u.mjs' }, d, { keys })).toBeUndefined();
    expect(await checkSignature({ module: './u.mjs' }, d, undefined)).toBeUndefined();
    await expect(checkSignature({ module: './u.mjs' }, d, { keys, requireSigned: true })).rejects.toThrow(/not signed/);
    await expect(checkSignature({ module: 'some-package' }, d, { requireSigned: true })).rejects.toThrow(/package-name/);
    expect(await checkSignature({ module: 'some-package' }, d, { keys })).toBeUndefined();
    writeFileSync(join(d, 'bad.sig'), '{oops');
    await expect(checkSignature({ module: './p.mjs', signature: './bad.sig' }, d, { keys })).rejects.toThrow(/unreadable signature/);
    writeFileSync(join(d, 'p.mjs'), PLUGIN + '//x');
    await expect(PluginHost.build([{ module: './p.mjs' }], [], d, { keys })).rejects.toThrow(/failed signature verification: sha256 mismatch/);
    const ok = await PluginHost.build([{ module: './u.mjs' }], [], d, { keys });
    expect(ok[0]!.name).toBe('mp-u');
  });

  it('CLI keygen / sign / verify', () => {
    const d = tmp();
    const require = createRequire(import.meta.url);
    const TSX = join(require.resolve('tsx/package.json'), '..', 'dist', 'cli.mjs');
    const CLI = resolve(__dirname, '..', 'src', 'cli.ts');
    const run = (...a: string[]) => spawnSync(process.execPath, [TSX, CLI, ...a], { cwd: d, encoding: 'utf-8', timeout: 30_000 });
    writeFileSync(join(d, 'p.mjs'), PLUGIN);
    expect(run('plugin', 'keygen', '-o', 'k').status).toBe(0);
    expect(run('plugin', 'sign', 'p.mjs', '-k', 'k.key', '--key-id', 'acme').stdout).toMatch(/Signed p\.mjs/);
    expect(run('plugin', 'verify', 'p.mjs', '-p', 'k.pub', '--key-id', 'acme').stdout).toMatch(/✓ p\.mjs signed by acme/);
    writeFileSync(join(d, 'p.mjs'), PLUGIN + ' ');
    expect(run('plugin', 'verify', 'p.mjs', '-p', 'k.pub', '--key-id', 'acme').status).toBe(1);
    expect(run('plugin', 'verify', 'p.mjs', '-p', 'k.pub', '--key-id', 'acme', '-s', 'none.sig').status).toBe(1);
  }, 60_000);
});

describe('plugin marketplace (5.4)', () => {
  const entry = (over: Record<string, unknown> = {}) => {
    const s = signArtifact(PLUGIN, key.privateKey, 'k1');
    return { name: 'mp-demo', version: '1.0.0', url: 'https://x.example/mp.mjs', sha256: s.sha256, signature: s.signature, keyId: 'k1', ...over };
  };

  it('parses indexes and compares versions', () => {
    expect(parseIndex({ plugins: [entry(), entry({ name: 'Bad Name' }), entry({ sha256: 'x' }), entry({ kind: 'zip' }), null] })).toHaveLength(1);
    expect(parseIndex(null)).toEqual([]);
    expect(['1.0.0', '1.2.0', '1.10.0', '1.2.0-beta.1', '1.2.0-alpha'].sort(compareVersions)).toEqual(['1.0.0', '1.2.0-alpha', '1.2.0-beta.1', '1.2.0', '1.10.0']);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('install refuses size, hash and signature failures', async () => {
    const d = tmp();
    const f = (async () => new Response(PLUGIN)) as unknown as typeof fetch;
    await expect(installEntry(entry(), { dir: d, keys, maxBytes: 4, fetch: f })).rejects.toThrow(/max 4/);
    await expect(installEntry(entry({ sha256: sha256Hex('other') }), { dir: d, keys, maxBytes: 1e6, fetch: f })).rejects.toThrow(/sha256 mismatch/);
    await expect(installEntry(entry({ keyId: 'zz' }), { dir: d, keys, maxBytes: 1e6, fetch: f })).rejects.toThrow(/untrusted key/);
    await expect(installEntry(entry(), { dir: d, keys, maxBytes: 1e6, fetch: (async () => new Response('', { status: 404 })) as unknown as typeof fetch })).rejects.toThrow(/HTTP 404/);
    const r = await installEntry(entry({ url: 'https://x.example/p.wasm' }), { dir: d, keys, maxBytes: 1e6, fetch: f });
    expect(r.plugin).toEqual({ component: join(d, 'mp-demo-1.0.0.wasm'), name: 'mp-demo' });
    const idx = await fetchIndexes(['https://i.example/a.json'], (async () => new Response('x', { status: 500 })) as unknown as typeof fetch);
    expect(idx.errors['https://i.example/a.json']).toBe('HTTP 500');
  });

  it('browses and installs through the admin API; the installed plugin loads signed', async () => {
    const app = express();
    let base = '';
    app.get('/index.json', (_q, s) => void s.json({ plugins: [entry({ url: `${base}/mp.mjs` }), entry({ version: '0.9.0', url: `${base}/mp.mjs` }), entry({ name: 'evil', keyId: 'unknown', url: `${base}/mp.mjs` })] }));
    app.get('/mp.mjs', (_q, s) => void s.type('text/javascript').send(PLUGIN));
    srv = app.listen(0, '127.0.0.1');
    await new Promise((r) => srv!.once('listening', r));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const d = tmp();
    h = await startFeatureGw({ configDir: d, marketplace: { dir: 'plugins', indexes: [`${base}/index.json`, 'http://127.0.0.1:1/x.json'] }, pluginTrust: { keys } } as never);
    const list = await h.admin('marketplace');
    expect(list.body.plugins.map((p: any) => [p.name, p.version, p.trusted])).toEqual([['mp-demo', '1.0.0', true], ['mp-demo', '0.9.0', true], ['evil', '1.0.0', false]]);
    expect(Object.keys(list.body.errors)).toHaveLength(1);
    const inst = await h.admin('marketplace/install', { name: 'mp-demo' });
    expect(inst.status).toBe(200);
    expect(inst.body).toMatchObject({ version: '1.0.0', keyId: 'k1', plugin: { module: './plugins/mp-demo-1.0.0.mjs', name: 'mp-demo' } });
    expect(existsSync(join(d, 'plugins', 'mp-demo-1.0.0.mjs.sig'))).toBe(true);
    expect(readFileSync(join(d, 'plugins', 'mp-demo-1.0.0.mjs'), 'utf8')).toBe(PLUGIN);
    const loaded = await PluginHost.build([inst.body.plugin], [], d, { keys, requireSigned: true });
    expect(loaded[0]!.name).toBe('mp-demo');
    expect((await h.admin('marketplace/install', { name: 'evil' })).status).toBe(422);
    expect((await h.admin('marketplace/install', { name: 'mp-demo', version: '9.9.9' })).status).toBe(404);
    expect((await h.admin('marketplace/install', {})).status).toBe(400);
  });

  it('install needs indexes and trusted keys', async () => {
    h = await startFeatureGw({ kernel: { modules: 'eager' } } as never); // 11.0: eager, so the unconfigured module is mounted
    expect((await h.admin('marketplace')).body.plugins).toEqual([]);
    expect((await h.admin('marketplace/install', { name: 'x' })).status).toBe(404);
    await h.gw.reload({ ...(h.gw as any).config, marketplace: { indexes: ['https://i.example/x.json'] } });
    expect((await h.admin('marketplace/install', { name: 'x' })).status).toBe(409);
  });
});
