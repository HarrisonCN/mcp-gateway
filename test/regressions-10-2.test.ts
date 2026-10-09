/** 10.2 regression tests: DNS rebinding, Host / Origin bypass, oversized bodies and redaction leaks. */
import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { gzipSync } from 'zlib';
import { request } from 'http';
import { Gateway } from '../src/gateway/index.js';
import { effectiveRebindingProtection } from '../src/security/network.js';
import { isLoopbackHost } from '../src/security/posture.js';
import { redactValue } from '../src/security/redact.js';
import { redactConfig, restoreRedacted, urlHasSecret } from '../src/config/diff.js';
import { validateConfig } from '../src/config/loader.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
const srv = (extra: Record<string, unknown> = {}) => ({ id: 's', name: 's', transport: 'stdio' as const, command: process.execPath, args: [fixture], timeout: 5000, ...extra });
const INIT = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });

let gw: Gateway | undefined;
afterEach(async () => {
  await gw?.stop();
  gw = undefined;
});
async function start(cfg: Record<string, unknown>) {
  gw = new Gateway({ port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false }, servers: [srv()], ...cfg } as never);
  await gw.start();
  return { url: `http://127.0.0.1:${gw.address()!.port}`, port: gw.address()!.port };
}
/** Raw HTTP request (fetch forbids overriding Host). */
function raw(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode!, body: b, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('secure default: DNS-rebinding protection for a loopback gateway without auth', () => {
  it('is on only for loopback + auth off, and an explicit setting wins', () => {
    expect(effectiveRebindingProtection({ host: '127.0.0.1' })).toBe(true);
    expect(effectiveRebindingProtection({ host: 'localhost', auth: { strategy: 'none' } })).toBe(true);
    expect(effectiveRebindingProtection({ host: '::1' })).toBe(true);
    expect(effectiveRebindingProtection({ host: '0.0.0.0' })).toBe(false);
    expect(effectiveRebindingProtection({ host: '127.0.0.1', auth: { strategy: 'api-key' } })).toBe(false);
    expect(effectiveRebindingProtection({ host: '127.0.0.1', security: { dnsRebindingProtection: false } })).toBe(false);
    expect(effectiveRebindingProtection({ host: '0.0.0.0', security: { dnsRebindingProtection: true } })).toBe(true);
    expect(isLoopbackHost('127.10.0.1')).toBe(true);
    expect(isLoopbackHost('127.0.0.1.nip.io')).toBe(false);
    expect(validateConfig({}).security?.dnsRebindingProtection).toBeUndefined();
  });

  it('rejects rebinding Hosts on REST and /mcp, accepts loopback Hosts', async () => {
    const { port } = await start({});
    for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1.nip.io:${port}`, `localhost.evil.example:${port}`, `0x7f000001:${port}`]) {
      expect((await raw(port, 'GET', '/api/v1/tools', { host })).status, host).toBe(403);
      expect((await raw(port, 'POST', '/mcp', { host, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, INIT)).status, host).toBe(403);
    }
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, `[::1]:${port}`]) {
      expect((await raw(port, 'GET', '/api/v1/tools', { host })).status, host).toBe(200);
    }
    // Probes stay reachable.
    expect((await raw(port, 'GET', '/api/v1/health/live', { host: 'evil.example' })).status).toBe(200);
  });

  it('refuses cross-site state changes and /mcp calls from foreign Origins; loopback origins still work', async () => {
    const { url, port } = await start({});
    const H = { host: `127.0.0.1:${port}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    for (const origin of ['https://evil.example', 'null', `http://127.0.0.1.evil.example:${port}`, 'http://localhost.evil.example']) {
      expect((await raw(port, 'POST', '/mcp', { ...H, origin }, INIT)).status, origin).toBe(403);
      expect((await raw(port, 'POST', '/api/v1/admin/reload', { ...H, origin }, '{}')).status, origin).toBe(403);
      expect((await raw(port, 'POST', '/api/v1/tools/call', { ...H, origin }, JSON.stringify({ tool: 'echo', server: 's', arguments: {} }))).status, origin).toBe(403);
      // CORS: the foreign origin is not echoed back.
      const pre = await raw(port, 'OPTIONS', '/api/v1/tools/call', { ...H, origin, 'access-control-request-method': 'POST' });
      expect(pre.headers['access-control-allow-origin']).toBeUndefined();
    }
    for (const origin of [`http://127.0.0.1:${port}`, 'http://localhost:5173']) {
      expect((await raw(port, 'POST', '/mcp', { ...H, origin }, INIT)).status, origin).toBe(200);
      const pre = await raw(port, 'OPTIONS', '/api/v1/tools/call', { ...H, origin, 'access-control-request-method': 'POST' });
      expect(pre.headers['access-control-allow-origin']).toBe(origin);
    }
    // Non-browser clients (no Origin) are unaffected.
    expect((await fetch(`${url}/api/v1/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'echo', server: 's', arguments: {} }) })).status).toBe(200);
  });

  it('explicit cors.origins / dnsRebindingProtection: false keep the old behaviour', async () => {
    const { port } = await start({ cors: { origins: ['https://app.example'] } });
    const H = { host: `127.0.0.1:${port}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    expect((await raw(port, 'POST', '/mcp', { ...H, origin: 'https://app.example' }, INIT)).status).toBe(200);
    expect((await raw(port, 'POST', '/mcp', { ...H, origin: 'https://evil.example' }, INIT)).status).toBe(403);
    await gw!.stop();
    const b = await start({ security: { dnsRebindingProtection: false } });
    expect((await raw(b.port, 'GET', '/api/v1/tools', { host: 'evil.example' })).status).toBe(200);
  });

  it('a gateway with auth keeps CORS "*" and no Host check unless configured', async () => {
    const { port } = await start({ auth: { strategy: 'api-key', apiKeys: [{ key: 'k' }] } });
    expect((await raw(port, 'GET', '/api/v1/tools', { host: 'gw.example', authorization: 'Bearer k' })).status).toBe(200);
    const pre = await raw(port, 'OPTIONS', '/api/v1/tools', { host: 'gw.example', origin: 'https://app.example', 'access-control-request-method': 'GET' });
    expect(pre.headers['access-control-allow-origin']).toBe('*');
  });
});

describe('Host / Origin bypass with explicit protection', () => {
  it('allowedHosts are matched exactly (port, suffix and wildcard tricks)', async () => {
    const { port } = await start({ host: '0.0.0.0', security: { insecure: true, dnsRebindingProtection: true, allowedHosts: ['gw.example', '*.corp.example'] } });
    const st = async (host: string) => (await raw(port, 'GET', '/api/v1/tools', { host })).status;
    expect(await st('gw.example')).toBe(200);
    expect(await st('GW.EXAMPLE:443')).toBe(200);
    expect(await st('a.corp.example')).toBe(200);
    expect(await st('corp.example')).toBe(403);
    expect(await st('gw.example.evil.example')).toBe(403);
    expect(await st('evilgw.example')).toBe(403);
    expect(await st('a.corp.example.evil')).toBe(403);
    expect(await st('')).toBe(403);
  });
});

describe('oversized bodies', () => {
  it('REST and /mcp answer 413 above security.maxBodyBytes, including gzip bombs and chunked bodies', async () => {
    const { url, port } = await start({ security: { maxBodyBytes: 64 * 1024 } });
    const big = JSON.stringify({ tool: 'echo', server: 's', arguments: { a: 'x'.repeat(100 * 1024) } });
    expect((await fetch(`${url}/api/v1/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: big })).status).toBe(413);
    const m = await fetch(`${url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: big });
    expect(m.status).toBe(413);
    expect(((await m.json()) as { error: { code: number } }).error.code).toBe(-32600);
    const bomb = gzipSync(Buffer.from(JSON.stringify({ tool: 'echo', server: 's', arguments: { a: 'x'.repeat(5 * 1024 * 1024) } })));
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect((await fetch(`${url}/api/v1/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: bomb })).status).toBe(413);
    // Chunked transfer (no Content-Length) is counted too.
    const chunked = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/api/v1/tools/call', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on('error', () => resolve(413)); // the server may reset the connection mid-upload
      for (let i = 0; i < 100; i++) req.write('x'.repeat(1024));
      req.end();
      void reject;
    });
    expect(chunked).toBe(413);
  });

  it('tool arguments above security.maxToolArgumentsBytes are refused on REST and /mcp (bytes, not characters)', async () => {
    const { url } = await start({ security: { maxToolArgumentsBytes: 100 } });
    const call = (a: unknown) => fetch(`${url}/api/v1/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'echo', server: 's', arguments: a }) });
    expect((await call({ a: 'x'.repeat(50) })).status).toBe(200);
    expect((await call({ a: '€'.repeat(40) })).status).toBe(413); // 40 chars, 120 bytes
  });
});

describe('redaction leaks', () => {
  it('GET /servers redacts replica url credentials, headers, env and args', async () => {
    const { url } = await start({
      auth: { strategy: 'api-key', apiKeys: [{ key: 'k', name: 'u', servers: ['s'] }] },
      servers: [srv({ env: { A: 'secret-env-1' }, replicas: [{ name: 'r2', transport: 'streamable-http', url: 'https://user:pw-secret@up.example/mcp?token=q-secret-1', headers: { Authorization: 'Bearer replica-secret-xyz' }, env: { B: 'replica-env-1' } }, { name: 'r3', command: 'x', args: ['--api-key', 'arg-secret-1'] }] })],
    });
    for (const p of ['/api/v1/servers', '/api/v1/servers/s']) {
      const t = await (await fetch(url + p, { headers: { authorization: 'Bearer k' } })).text();
      for (const secret of ['secret-env-1', 'pw-secret', 'q-secret-1', 'replica-secret-xyz', 'replica-env-1', 'arg-secret-1']) expect(t, `${p} leaks ${secret}`).not.toContain(secret);
    }
  });

  it('GET /admin/config masks URLs with credentials and the round trip restores them', () => {
    const cfg = { servers: [{ id: 's', url: 'https://u:p@x.example/mcp', replicas: [{ url: 'https://y.example/mcp?access_token=abc' }] }, { id: 't', url: 'https://plain.example/mcp?region=eu' }] };
    const red = redactConfig(cfg) as typeof cfg;
    expect(JSON.stringify(red)).not.toMatch(/u:p@|access_token=abc/);
    expect(red.servers[1]!.url).toBe('https://plain.example/mcp?region=eu');
    expect(restoreRedacted(red, cfg)).toEqual(cfg);
    expect(urlHasSecret('https://a.example/?sig=1')).toBe(true);
    expect(urlHasSecret('not a url')).toBe(false);
  });

  it('redactValue never returns secrets nested beyond its depth limit', () => {
    let deep: Record<string, unknown> = { password: 'deep-secret', note: 'Bearer abcdefghijklmnop' };
    for (let i = 0; i < 30; i++) deep = { level: deep };
    expect(JSON.stringify(redactValue(deep))).not.toMatch(/deep-secret|abcdefghijklmnop/);
    let s: unknown = 'token=very-secret-value';
    for (let i = 0; i < 25; i++) s = [s];
    expect(JSON.stringify(redactValue(s))).not.toContain('very-secret-value');
  });
});
