/**
 * 15.2.0-canary.1: plugin ecosystem, second step (TESTS FIRST — written before the implementation).
 *
 *  S1–S3 reproducible signature check: `verifyReproducible()` and `mcp-gateway plugin verify --rebuilt <file>` — a
 *        signed artifact verifies AND an independent rebuild from the same source has exactly the signed digest.
 *  C1–C3 compatibility matrix: plugin API versions × gateway versions as data (`PLUGIN_COMPATIBILITY`,
 *        `pluginApiSupport()`), the guide table generated from it (drift guard) and the running gateway in it.
 *  T1–T3 `@winstonsayno/mcp-gateway/testing`: a new, additive package export with a plugin test harness.
 *  L1–L4 a third-party example plugin (examples/plugins/tool-quota) through install → update → revoke → crash
 *        recovery, in the worker and the process runtime.
 *  M1–M3 MCP `_meta.correlationId` on /mcp requests is the call's correlation id (wins over X-Request-Id).
 * Additive only: no frozen route, field, schema key or library export of the package root changes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as trust from '../src/plugins/trust.js';
import * as compat from '../src/plugins/compat.js';
import * as testing from '../src/testing/index.js';
import { metaCorrelationId } from '../src/middleware/request-id.js';
import { PLUGIN_API_VERSION } from '../src/plugins/index.js';
import { VERSION } from '../src/utils/version.js';
import { logger } from '../src/utils/logger.js';
import { startFeatureGw, fakeServer, type FeatureGw } from './helpers/feature-gw.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
logger.setLevel('error');
const require = createRequire(import.meta.url);
const TSX = join(require.resolve('tsx/package.json'), '..', 'dist', 'cli.mjs');
const ROOT = resolve(__dirname, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'mgw-sdk-'));
  dirs.push(d);
  return d;
};
const harnesses: Array<{ close(): Promise<void> }> = [];
let gw: FeatureGw | undefined;
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
  await gw?.stop();
  gw = undefined;
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
const cli = (args: string[], cwd: string) => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('MCP_GATEWAY_')) delete env[k];
  const r = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, env, encoding: 'utf-8', timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

describe('reproducible signature check (15.2.0-canary.1)', { timeout: 60_000 }, () => {
  const k = trust.generateSigningKey();
  const keys = [{ id: 'acme', publicKey: k.publicKey }];
  const src = 'export default { name: "r", apiVersion: 5 };\n';

  it('S1 verifyReproducible: the signature verifies and every rebuild has the signed digest', () => {
    const sig = trust.signArtifact(src, k.privateKey, 'acme');
    const ok = (trust as any).verifyReproducible(Buffer.from(src), sig, [Buffer.from(src), Buffer.from(src)], keys);
    expect(ok).toMatchObject({ ok: true, keyId: 'acme', sha256: sig.sha256, reproducible: true });
    expect(ok.rebuilds).toEqual([{ sha256: sig.sha256, matches: true }, { sha256: sig.sha256, matches: true }]);
  });

  it('S2 a rebuild that differs (even by one byte) is not reproducible; a bad signature fails before any rebuild is compared', () => {
    const sig = trust.signArtifact(src, k.privateKey, 'acme');
    const bad = (trust as any).verifyReproducible(Buffer.from(src), sig, [Buffer.from(src + ' ')], keys);
    expect(bad.ok).toBe(false);
    expect(bad.reproducible).toBe(false);
    expect(bad.reason).toMatch(/not reproducible/i);
    expect(bad.rebuilds[0].matches).toBe(false);
    const other = trust.generateSigningKey();
    const forged = trust.signArtifact(src, other.privateKey, 'acme');
    const f = (trust as any).verifyReproducible(Buffer.from(src), forged, [Buffer.from(src)], keys);
    expect(f).toMatchObject({ ok: false, reason: 'bad signature' });
    expect((trust as any).verifyReproducible(Buffer.from(src), sig, [], keys)).toMatchObject({ ok: false, reason: expect.stringMatching(/at least one rebuild/i) });
  });

  it('S3 CLI: plugin verify --rebuilt <file> (repeatable) exits 0 only when the rebuilds match the signed digest', () => {
    const d = tmp();
    writeFileSync(join(d, 'k.key'), k.privateKey);
    writeFileSync(join(d, 'k.pub'), k.publicKey);
    writeFileSync(join(d, 'p.mjs'), src);
    writeFileSync(join(d, 'p.mjs.sig'), JSON.stringify(trust.signArtifact(src, k.privateKey, 'acme')));
    writeFileSync(join(d, 'rebuild-a.mjs'), src);
    writeFileSync(join(d, 'rebuild-b.mjs'), src.replace('"r"', '"x"'));
    const good = cli(['plugin', 'verify', 'p.mjs', '-p', 'k.pub', '--key-id', 'acme', '--rebuilt', 'rebuild-a.mjs'], d);
    expect(good.code, good.err).toBe(0);
    expect(good.out).toMatch(/signed by acme/);
    expect(good.out).toMatch(/reproducible/i);
    const bad = cli(['plugin', 'verify', 'p.mjs', '-p', 'k.pub', '--key-id', 'acme', '--rebuilt', 'rebuild-a.mjs', '--rebuilt', 'rebuild-b.mjs'], d);
    expect(bad.code).toBe(1);
    expect(bad.out + bad.err).toMatch(/rebuild-b\.mjs.*(differs|mismatch)|not reproducible/i);
    // without --rebuilt the 5.4 behaviour is unchanged
    expect(cli(['plugin', 'verify', 'p.mjs', '-p', 'k.pub', '--key-id', 'acme'], d).code).toBe(0);
  });
});

describe('compatibility matrix (15.2.0-canary.1)', () => {
  it('C1 pluginApiSupport: the plugin API range each gateway version loads', () => {
    expect(compat.pluginApiSupport('15.2.0-canary.1')).toEqual({ min: 5, max: 5 });
    expect(compat.pluginApiSupport('8.0.0')).toEqual({ min: 5, max: 5 });
    expect(compat.pluginApiSupport('7.9.0')).toEqual({ min: 4, max: 5 });
    expect(compat.pluginApiSupport('6.0.0')).toEqual({ min: 4, max: 4 });
    expect(compat.pluginApiSupport('5.0.0')).toEqual({ min: 3, max: 4 });
    expect(compat.pluginApiSupport('4.9.0')).toEqual({ min: 2, max: 4 });
    expect(compat.pluginApiSupport('4.0.0')).toEqual({ min: 2, max: 3 });
    expect(compat.pluginApiSupport('3.0.0')).toEqual({ min: 1, max: 2 });
    expect(compat.pluginApiSupport('2.0.0')).toEqual({ min: 1, max: 1 });
    expect(compat.pluginApiSupport('1.0.0')).toBeUndefined();
    expect(compat.isPluginApiSupported(5, '14.9.2')).toBe(true);
    expect(compat.isPluginApiSupported(4, '14.9.2')).toBe(false);
  });

  it('C2 the running gateway is in the matrix and matches PLUGIN_API_VERSION / the loader', () => {
    const row = compat.PLUGIN_COMPATIBILITY.find((r) => compat.inRange(VERSION, r));
    if (Number(VERSION.split('.')[0]) >= 16) {
      // 16.0.0-alpha: the 16.0 row stays a proposal until 16.0.0 is released (still plugin API v5)
      expect(compat.pluginApiSupport(VERSION)).toEqual({ min: 5, max: PLUGIN_API_VERSION, proposal: true });
      expect(row?.notes).toMatch(/allowInline/);
      return;
    }
    expect(compat.pluginApiSupport(VERSION)).toEqual({ min: 5, max: PLUGIN_API_VERSION });
    expect(row?.features).toEqual(expect.arrayContaining(['worker / process runtime (14.3)', 'plugin init / doctor (15.2)', '/testing export (15.2)']));
  });

  it('C3 docs/guides/plugin-compatibility.md carries the generated matrix (no drift)', () => {
    const doc = readFileSync(join(ROOT, 'docs', 'guides', 'plugin-compatibility.md'), 'utf8');
    expect(doc).toContain(compat.compatibilityMarkdown());
    expect(doc).toMatch(/plugin API v6.*17\.0.*proposal/is);
  });
});

describe('@winstonsayno/mcp-gateway/testing (15.2.0-canary.1)', { timeout: 60_000 }, () => {
  it('T1 package.json: a new ./testing export; the three existing exports are unchanged', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.exports['./testing']).toEqual({ types: './dist/testing/index.d.ts', import: './dist/testing/index.js' });
    expect(pkg.exports['.']).toEqual({ types: './dist/index.d.ts', import: './dist/index.js' });
    expect(pkg.exports['./gateway']).toEqual({ types: './dist/gateway/public.d.ts', import: './dist/gateway/public.js' });
    expect(pkg.exports['./edge']).toEqual({ types: './dist/edge/entry.d.ts', import: './dist/edge/entry.js' });
    const srcText = readFileSync(join(ROOT, 'src', 'testing', 'index.ts'), 'utf8');
    expect(srcText).not.toMatch(/from ['"](vitest|jest|mocha)/); // framework-free: works under node:test too
  });

  it('T2 toolCall / toolResponse build hook inputs; createTestSigningKey + signPluginFile give a pluginTrust that loads the file', async () => {
    const c = testing.toolCall('rm', { path: '/' }, { clientId: 'key:a' });
    expect(c).toMatchObject({ serverId: 'test', name: 'rm', kind: 'tool', method: 'tools/call', arguments: { path: '/' }, clientId: 'key:a', via: 'mcp' });
    expect(c.state).toBeInstanceOf(Map);
    expect(testing.toolResponse({ ok: 1 })).toMatchObject({ success: true, result: { ok: 1 } });
    const d = tmp();
    writeFileSync(join(d, 'deny.mjs'), `export default { name: 'deny', apiVersion: 5, onToolCall: (c) => c.name === 'rm' ? { action: 'deny', reason: 'no rm' } : { action: 'continue' } };`);
    const key = testing.createTestSigningKey('t1');
    const sig = testing.signPluginFile(join(d, 'deny.mjs'), key);
    expect(existsSync(join(d, 'deny.mjs.sig'))).toBe(true);
    expect(sig.keyId).toBe('t1');
    const h = await testing.startPluginHarness({ module: './deny.mjs', runtime: 'worker' }, { baseDir: d, trust: key.trust({ requireSigned: true }) });
    harnesses.push(h);
    expect(h.runtime).toBe('worker');
    expect(await h.callTool('rm')).toEqual({ action: 'deny', reason: 'no rm' });
    expect(await h.callTool('ls', { a: 1 })).toEqual({ action: 'continue', arguments: { a: 1 } });
  });

  it('T3 the harness reports a failing hook as refused (failure: closed) and exposes host status', async () => {
    const d = tmp();
    writeFileSync(join(d, 'boom.mjs'), `export default { name: 'boom', apiVersion: 5, onToolCall: () => { throw new Error('kaput'); } };`);
    const h = await testing.startPluginHarness({ module: './boom.mjs', runtime: 'worker', failure: 'closed' }, { baseDir: d });
    harnesses.push(h);
    const r = await h.callTool('x');
    expect(r.action).toBe('refused');
    expect((r as any).error).toMatch(/kaput|boom/);
    expect(h.status()).toMatchObject({ name: 'boom', runtime: 'worker', failures: 1 });
  });
});

describe('harness outside a test runner (15.2.0-canary.1)', { timeout: 60_000 }, () => {
  it('T4 plain node (as under node --test): install → call → crash() → call completes; the harness keeps the event loop alive until close()', async () => {
    const d = tmp();
    // bundle the harness to plain JS (no tsx loader in the child: the loader's own worker would hide the bug)
    const out = join(ROOT, 'node_modules', '.mgw-test', `testing-${process.pid}.mjs`);
    const { buildSync } = await import('esbuild');
    buildSync({ entryPoints: [join(ROOT, 'src', 'testing', 'index.ts')], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: out, logLevel: 'error' });
    writeFileSync(join(d, 'p.mjs'), `let n = 0; export default { name: 'p', apiVersion: 5, onToolCall: () => (++n > 1 ? { action: 'deny', reason: 'second' } : { action: 'continue' }) };`);
    writeFileSync(join(d, 'run.mjs'), `import { startPluginHarness } from ${JSON.stringify(pathToFileURL(out).href)};
const h = await startPluginHarness({ module: './p.mjs', runtime: 'worker' }, { baseDir: ${JSON.stringify(d)} });
const a = await h.callTool('x');
await h.crash();
const b = await h.callTool('x');
await h.close();
console.log('OUTCOME ' + JSON.stringify([a.action, b.action]));`);
    try {
      const r = spawnSync(process.execPath, [join(d, 'run.mjs')], { cwd: d, encoding: 'utf-8', timeout: 45_000 });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('OUTCOME ["continue","continue"]');
    } finally {
      rmSync(out, { force: true });
    }
  });
});

describe.each(['worker', 'process'] as const)('third-party example plugin lifecycle — %s runtime (15.2.0-canary.1)', (runtime) => {
  const EX = join(ROOT, 'examples', 'plugins', 'tool-quota');
  const setup = () => {
    const d = tmp();
    copyFileSync(join(EX, 'tool-quota.mjs'), join(d, 'tool-quota.mjs'));
    const key = testing.createTestSigningKey('vendor-2026');
    testing.signPluginFile(join(d, 'tool-quota.mjs'), key);
    const entry = { module: './tool-quota.mjs', runtime, failure: 'closed' as const, options: { limit: 2 }, permissions: { args: 'read' as const, response: 'read' as const, network: false as const, env: [] } };
    return { d, key, entry };
  };

  it('L1 install: the signed example loads isolated (requireSigned) and enforces its quota', { timeout: 60_000 }, async () => {
    expect(existsSync(join(EX, 'README.md'))).toBe(true);
    const { d, key, entry } = setup();
    const h = await testing.startPluginHarness(entry, { baseDir: d, trust: key.trust({ requireSigned: true }) });
    harnesses.push(h);
    expect(h.runtime).toBe(runtime);
    expect((await h.callTool('search', {}, { clientId: 'key:a' })).action).toBe('continue');
    expect((await h.callTool('search', {}, { clientId: 'key:a' })).action).toBe('continue');
    const third = await h.callTool('search', {}, { clientId: 'key:a' });
    expect(third).toEqual({ action: 'deny', reason: expect.stringMatching(/quota of 2 calls.*tool-quota 1\.0\.0/) });
    expect((await h.callTool('search', {}, { clientId: 'key:b' })).action).toBe('continue'); // per client
  });

  it('L2 update: a new signed version replaces the running one (old runtime closed, new code serves)', { timeout: 60_000 }, async () => {
    const { d, key, entry } = setup();
    const h = await testing.startPluginHarness(entry, { baseDir: d, trust: key.trust({ requireSigned: true }) });
    harnesses.push(h);
    const before = h.plugin as any;
    writeFileSync(join(d, 'tool-quota.mjs'), readFileSync(join(d, 'tool-quota.mjs'), 'utf8').replace("const VERSION = '1.0.0'", "const VERSION = '1.1.0'"));
    // an update that is not re-signed is refused and the running version keeps serving
    await expect(h.update()).rejects.toThrow(/sha256 mismatch/);
    expect(h.plugin).toBe(before);
    testing.signPluginFile(join(d, 'tool-quota.mjs'), key);
    await h.update({ entry: { ...entry, options: { limit: 1 } } });
    expect(h.plugin).not.toBe(before);
    expect(before.runtimeStats().alive).toBe(false);
    await h.callTool('search');
    expect(await h.callTool('search')).toEqual({ action: 'deny', reason: expect.stringMatching(/quota of 1 call.*tool-quota 1\.1\.0/) });
  });

  it('L3 revoke: a reload that only drops the key is refused (current plugin keeps running); dropping key + entry unloads it; a restart refuses it', { timeout: 60_000 }, async () => {
    const { d, key, entry } = setup();
    const h = await testing.startPluginHarness(entry, { baseDir: d, trust: key.trust({ requireSigned: true }) });
    harnesses.push(h);
    const running = h.plugin as any;
    const revoked = { requireSigned: true, keys: [] };
    await expect(h.update({ trust: revoked })).rejects.toThrow(/untrusted key "vendor-2026"/);
    expect(h.plugin).toBe(running);
    await h.unload();
    expect(h.plugin).toBeUndefined();
    expect(running.runtimeStats().alive).toBe(false);
    expect(await h.callTool('search')).toEqual({ action: 'continue', arguments: {} });
    await expect(testing.startPluginHarness(entry, { baseDir: d, trust: revoked })).rejects.toThrow(/untrusted key "vendor-2026"/);
  });

  it('L4 crash recovery: a killed runtime is restarted on the next call; in-memory state starts over', { timeout: 60_000 }, async () => {
    const { d, key, entry } = setup();
    const h = await testing.startPluginHarness(entry, { baseDir: d, trust: key.trust({ requireSigned: true }) });
    harnesses.push(h);
    await h.callTool('search');
    await h.callTool('search');
    expect((await h.callTool('search')).action).toBe('deny');
    await h.crash();
    expect(h.status()).toMatchObject({ alive: false, restarts: 1 });
    expect((await h.callTool('search')).action).toBe('continue'); // fresh runtime, quota counter reset
    expect(h.status()).toMatchObject({ alive: true, restarts: 1, circuit: 'closed' });
  });
});

describe('MCP _meta correlation id (15.2.0-canary.1)', { timeout: 60_000 }, () => {
  it('M1 metaCorrelationId reads params._meta.correlationId with the X-Request-Id charset / length rule', () => {
    expect(metaCorrelationId({ _meta: { correlationId: 'edit-7' } })).toBe('edit-7');
    expect(metaCorrelationId({ _meta: { correlationId: 'bad id\n' } })).toBeUndefined();
    expect(metaCorrelationId({ _meta: { correlationId: 'x'.repeat(129) } })).toBeUndefined();
    expect(metaCorrelationId({ _meta: { correlationId: 7 } })).toBeUndefined();
    expect(metaCorrelationId({ _meta: 'x' })).toBeUndefined();
    expect(metaCorrelationId(undefined)).toBeUndefined();
  });

  const K = 'k-meta-SECRET-1';
  const hdr = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${K}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra });
  async function session() {
    gw = await startFeatureGw({ servers: [fakeServer('db')], auth: { strategy: 'api-key', apiKeys: [{ key: K, name: 'ops' }] } } as never);
    const post = (body: unknown, extra: Record<string, string> = {}) => fetch(`${gw!.base}/mcp`, { method: 'POST', headers: hdr(extra), body: JSON.stringify(body) });
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    const sid = init.headers.get('mcp-session-id')!;
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': sid });
    const tools = JSON.parse(await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': sid })).text());
    const echo = (tools.result.tools as Array<{ name: string }>).map((t) => t.name).find((n) => /echo/.test(n))!;
    return { call: (meta: unknown, extra: Record<string, string> = {}, id = 3) => post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: echo, arguments: { text: 'hi' }, ...(meta === undefined ? {} : { _meta: meta }) } }, { 'mcp-session-id': sid, ...extra }) };
  }
  const lineage = async (cid: string) => (await (await fetch(`${gw!.base}/api/v1/admin/ops/lineage?correlationId=${cid}`, { headers: hdr() })).json()) as any;

  it('M2 a tools/call with _meta.correlationId (no header) is found by that id; _meta wins over X-Request-Id', async () => {
    const s = await session();
    expect((await s.call({ correlationId: 'studio-edit-1', progressToken: 'p1' })).status).toBe(200);
    const l = await lineage('studio-edit-1');
    expect(l.total).toBe(1);
    expect(l.lineage[0]).toMatchObject({ correlationId: 'studio-edit-1', target: { via: 'mcp' }, decision: { outcome: 'ok' } });
    await s.call({ correlationId: 'from-meta' }, { 'x-request-id': 'from-header' }, 4);
    expect((await lineage('from-meta')).total).toBe(1);
    expect((await lineage('from-header')).total).toBe(0);
  });

  it('M3 an invalid _meta.correlationId is ignored (the header, if any, is used)', async () => {
    const s = await session();
    await s.call({ correlationId: 'has space' }, { 'x-request-id': 'hdr-ok' });
    expect((await lineage('hdr-ok')).total).toBe(1);
  });
});
