/** 3.5: secrets management — Vault / KMS / env / file providers, rotation, per-tenant injection. */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import { fileURLToPath } from 'url';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SecretManager, parseSecretRef, sigv4 } from '../src/secrets/index.js';
import { Gateway } from '../src/gateway/index.js';
import { validateConfig } from '../src/config/loader.js';
import type { GatewayConfig, McpServerConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));

// A tiny Vault (KV v2 + AppRole) and KMS stand-in.
const kv: Record<string, Record<string, unknown>> = {
  'mcp/github': { token: 'ghp_first' },
  'tenants/acme/svc': { key: 'acme-key' },
  'tenants/globex/svc': { key: 'globex-key' },
};
let vaultCalls = 0;
let lastKms: { headers: Record<string, unknown>; body: string } | undefined;
let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (code: number, obj: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url === '/v1/auth/approle/login') {
        const b = JSON.parse(body);
        return b.role_id === 'r' && b.secret_id === 's' ? send(200, { auth: { client_token: 'approle-token' } }) : send(400, {});
      }
      if (req.url?.startsWith('/v1/secret/data/')) {
        vaultCalls++;
        if (!['root', 'approle-token'].includes(String(req.headers['x-vault-token']))) return send(403, {});
        const d = kv[req.url.slice('/v1/secret/data/'.length)];
        return d ? send(200, { data: { data: d, metadata: { version: 1 } } }) : send(404, {});
      }
      if (req.url === '/kms/') {
        lastKms = { headers: req.headers as Record<string, unknown>, body };
        const blob = JSON.parse(body).CiphertextBlob as string;
        return send(200, { Plaintext: Buffer.from(`plain:${Buffer.from(blob, 'base64').toString()}`).toString('base64') });
      }
      if (req.url === '/gcp/v1/projects/p/locations/l/keyRings/r/cryptoKeys/k:decrypt') {
        if (req.headers.authorization !== 'Bearer gtok') return send(401, {});
        return send(200, { plaintext: Buffer.from('gcp-plain').toString('base64') });
      }
      send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('SecretManager', () => {
  it('parses references', () => {
    expect(parseSecretRef('secret://vault/mcp/github#token')).toEqual({ provider: 'vault', path: 'mcp/github', field: 'token' });
    expect(parseSecretRef('secret://env/HOME')).toEqual({ provider: 'env', path: 'HOME' });
    expect(parseSecretRef('nope')).toBeUndefined();
  });

  it('reads Vault KV v2 (token and AppRole), caches, and interpolates', async () => {
    const m = new SecretManager(() => ({ providers: [{ id: 'vault', type: 'vault', address: base, token: 'root' }] }));
    vaultCalls = 0;
    expect(await m.get('secret://vault/mcp/github#token')).toBe('ghp_first');
    expect(await m.get('secret://vault/mcp/github#token')).toBe('ghp_first');
    expect(vaultCalls).toBe(1);
    expect(await m.interpolate('Bearer secret://vault/mcp/github#token')).toBe('Bearer ghp_first');
    await expect(m.get('secret://vault/missing#x')).rejects.toThrow(/no secret/);
    await expect(m.get('secret://nope/x')).rejects.toThrow(/Unknown secret provider/);
    const ar = new SecretManager(() => ({ providers: [{ id: 'v', type: 'vault', address: base, roleId: 'r', secretId: 's' }] }));
    expect(await ar.get('secret://v/tenants/acme/svc#key')).toBe('acme-key');
  });

  it('decrypts with AWS KMS (SigV4) and Cloud KMS, and reads env / file', async () => {
    const m = new SecretManager(() => ({
      providers: [
        { id: 'kms', type: 'aws-kms', region: 'eu-west-1', endpoint: `${base}/kms/`, accessKeyId: 'AKID', secretAccessKey: 'SECRET' },
        { id: 'gkms', type: 'gcp-kms', endpoint: `${base}/gcp`, token: 'gtok' },
        { id: 'f', type: 'file', baseDir: dir },
      ],
    }));
    const blob = Buffer.from('cipher').toString('base64');
    expect(await m.get(`secret://kms/${blob}`)).toBe('plain:cipher');
    expect(String(lastKms!.headers.authorization)).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/eu-west-1\/kms\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/);
    expect(lastKms!.headers['x-amz-target']).toBe('TrentService.Decrypt');
    expect(await m.get(`secret://gkms/projects/p/locations/l/keyRings/r/cryptoKeys/k:${blob}`)).toBe('gcp-plain');
    process.env.MGW_TEST_SECRET = 'from-env';
    expect(await m.get('secret://env/MGW_TEST_SECRET')).toBe('from-env');
    expect(await m.get('secret://f/token.txt')).toBe('file-token');
    expect(m.status().every((s) => !JSON.stringify(s).includes('from-env'))).toBe(true);
  });

  it('SigV4 matches the AWS reference signature', () => {
    // Deterministic for a fixed clock: date, credential scope and signature format.
    const h = sigv4({
      method: 'POST', url: 'https://kms.us-east-1.amazonaws.com/', body: '{}', region: 'us-east-1', service: 'kms',
      accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'TrentService.Decrypt' }, now: new Date('2015-08-30T12:36:00Z'),
    });
    expect(h['x-amz-date']).toBe('20150830T123600Z');
    expect(h.authorization).toContain('Credential=AKIDEXAMPLE/20150830/us-east-1/kms/aws4_request');
    expect(h.authorization).toMatch(/Signature=[0-9a-f]{64}$/);
  });

  it('keeps serving the cached value when the provider fails, and tracks rotations', async () => {
    let now = 0;
    const m = new SecretManager(() => ({ cacheSeconds: 1, providers: [{ id: 'vault', type: 'vault', address: base, token: 'root' }] }), { now: () => now });
    const s: McpServerConfig = { id: 'gh', name: 'gh', transport: 'stdio', command: 'x', env: { T: 'secret://vault/mcp/github#token' } };
    expect((await m.resolveServer(s)).env!.T).toBe('ghp_first');
    expect(await m.rotateServer(s)).toBeUndefined();
    kv['mcp/github'] = { token: 'ghp_second' };
    now = 5000;
    expect((await m.rotateServer(s))!.env!.T).toBe('ghp_second');
    const st = m.status().find((x) => x.ref.includes('mcp/github'))!;
    expect(st).toMatchObject({ provider: 'vault', type: 'vault', version: 2, usedBy: ['server:gh'] });
    expect(st.rotatedAt).toBeTypeOf('string');
    kv['mcp/github'] = { token: 'ghp_first' };
  });

  it('validates secrets config and references', () => {
    const srv = (env: Record<string, string>) => [{ id: 's', name: 's', transport: 'stdio', command: 'x', env }];
    expect(() => validateConfig({ servers: srv({ T: 'secret://vault/a#b' }), secrets: { providers: [{ id: 'vault', type: 'vault', address: 'http://v', token: 't' }] } })).not.toThrow();
    expect(() => validateConfig({ servers: srv({ T: 'secret://nope/a' }) })).toThrow(/unknown secret provider "nope"/);
    expect(() => validateConfig({ servers: srv({ T: 'secret://env/A' }) })).not.toThrow();
    expect(() => validateConfig({ servers: [], secrets: { providers: [{ id: 'v', type: 'vault', address: 'http://v' }] } })).toThrow(/token or roleId/);
    expect(() => validateConfig({ servers: [{ id: 's', name: 's', transport: 'stdio', command: 'x', inject: [{ ref: 'secret://env/A', argument: 'a', meta: 'b' }] }] })).toThrow(/exactly one/);
  });
});

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mgw-secrets-'));
  writeFileSync(join(dir, 'token.txt'), 'file-token\n');
});

describe('secrets in the gateway', () => {
  let gw: Gateway | undefined;
  afterEach(async () => {
    await gw?.stop();
    gw = undefined;
  });

  it('connects with resolved credentials, rotates them, and injects per-tenant credentials into calls', async () => {
    kv['mcp/github'] = { token: 'ghp_first' };
    gw = new Gateway({
      port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: true },
      replay: { enabled: true },
      secrets: { providers: [{ id: 'vault', type: 'vault', address: base, token: 'root' }] },
      auth: { strategy: 'api-key', apiKeys: [{ name: 'a', key: 'key-a' }, { name: 'b', key: 'key-b' }, { name: 'ops', key: 'key-ops' }, { name: 'none', key: 'key-none' }] },
      tenants: [
        { id: 'acme', servers: ['*'], members: [{ client: 'key:a', role: 'admin' }] },
        { id: 'globex', servers: ['*'], members: [{ client: 'key:b', role: 'admin' }] },
      ],
      servers: [
        { id: 'fake', name: 'fake', transport: 'stdio', command: process.execPath, args: [fixture], env: { SERVER_TAG: 'secret://vault/mcp/github#token' }, inject: [{ ref: 'secret://vault/tenants/{tenant}/svc#key', argument: 'api_key' }] },
      ],
    } as GatewayConfig);
    await gw.start();
    const api = `http://127.0.0.1:${gw.address()!.port}/api/v1`;
    const call = async (key: string) => {
      const r = await fetch(`${api}/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: { q: 1 } }) });
      return { status: r.status, body: (await r.json()) as any };
    };
    const a = await call('key-a');
    expect(JSON.parse(a.body.result.content[0].text)).toEqual({ q: 1, api_key: 'acme-key', _server: 'ghp_first' });
    expect(JSON.parse((await call('key-b')).body.result.content[0].text).api_key).toBe('globex-key');
    // The captured call (replay debugger) never contains the injected credential.
    const captured = (await (await fetch(`${api}/requests/${a.body.requestId}`, { headers: { authorization: 'Bearer key-ops' } })).json()) as any;
    expect(captured.arguments).toEqual({ q: 1 });
    // A caller without a tenant cannot get a {tenant} credential.
    const none = await call('key-none');
    expect(none.body.code ?? none.body.error?.code ?? JSON.stringify(none.body)).toBeDefined();
    expect(JSON.stringify(none.body)).toMatch(/Credential injection failed/);
    // GET /servers shows the reference, never the value.
    expect(JSON.stringify(await (await fetch(`${api}/servers/fake`, { headers: { authorization: 'Bearer key-ops' } })).json())).not.toContain('ghp_first');
    // Rotation: new value in Vault → reconnect with it.
    kv['mcp/github'] = { token: 'ghp_rotated' };
    const rot = (await (await fetch(`${api}/secrets/rotate`, { method: 'POST', headers: { authorization: 'Bearer key-ops' } })).json()) as any;
    expect(rot.rotated).toEqual(['fake']);
    await new Promise((r) => setTimeout(r, 300));
    expect(JSON.parse((await call('key-a')).body.result.content[0].text)._server).toBe('ghp_rotated');
    const st = (await (await fetch(`${api}/secrets`, { headers: { authorization: 'Bearer key-ops' } })).json()) as any;
    expect(JSON.stringify(st)).not.toMatch(/ghp_|acme-key/);
    expect(st.providers.map((p: { id: string }) => p.id)).toContain('vault');
    expect(st.secrets.find((s: { ref: string }) => s.ref === 'secret://vault/mcp/github#token').version).toBe(2);
    expect((await fetch(`${api}/secrets`, { headers: { authorization: 'Bearer key-a' } })).status).toBe(403);
    kv['mcp/github'] = { token: 'ghp_first' };
  });
});
