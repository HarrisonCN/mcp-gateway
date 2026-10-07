import { describe, it, expect, vi, afterEach } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, exportSPKI } from 'jose';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import {
  buildJwtVerifier,
  createAuthMiddleware,
  fingerprint,
  hashApiKey,
  isHashedKey,
  keyInactiveReason,
} from '../src/auth/middleware.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');

function mockRes() {
  const res: any = { statusCode: 200, body: undefined, headersSent: false };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), (res.headersSent = true), res);
  return res;
}
const req = (headers: Record<string, string | undefined> = {}): any => ({ headers, ip: '127.0.0.1' });

/** Run a (possibly async) middleware; resolves with next-called + response. */
function run(mw: any, headers: Record<string, string>): Promise<{ next: boolean; res: any; req: any }> {
  return new Promise((resolve) => {
    const r = req(headers);
    const res = mockRes();
    const origJson = res.json;
    res.json = (b: unknown) => {
      origJson(b);
      resolve({ next: false, res, req: r });
      return res;
    };
    mw(r, res, () => resolve({ next: true, res, req: r }));
  });
}

describe('hashed API keys', () => {
  it('hashApiKey / isHashedKey', () => {
    const h = hashApiKey('test');
    expect(h).toBe('sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
    expect(isHashedKey(h)).toBe(true);
    expect(isHashedKey(h.toUpperCase().replace('SHA256', 'sha256'))).toBe(true);
    expect(isHashedKey('sha256:abc')).toBe(false);
    expect(isHashedKey('test')).toBe(false);
  });

  it('accepts the plain key for a sha256: entry, with the same client id as a plain entry', async () => {
    const key = 'mgw_correct-horse-battery-staple';
    const hashed = createAuthMiddleware({ strategy: 'api-key', apiKeys: [hashApiKey(key)] });
    const plain = createAuthMiddleware({ strategy: 'api-key', apiKeys: [key] });
    const a = await run(hashed, { authorization: `Bearer ${key}` });
    const b = await run(plain, { 'x-api-key': key });
    expect(a.next && b.next).toBe(true);
    expect(a.req.clientId).toBe(b.req.clientId);
    expect(a.req.clientId).toBe(`key:${fingerprint(key)}`);
    expect(fingerprint(hashApiKey(key))).toBe(fingerprint(key));

    // The digest itself is not a valid credential.
    const c = await run(hashed, { authorization: `Bearer ${hashApiKey(key)}` });
    expect(c.next).toBe(false);
    expect(c.res.statusCode).toBe(401);
  });

  it('works for object entries with scopes', async () => {
    const mw = createAuthMiddleware({
      strategy: 'api-key',
      apiKeys: [{ key: hashApiKey('scoped-key-123'), name: 'ci', servers: ['a'] }],
    });
    const r = await run(mw, { 'x-api-key': 'scoped-key-123' });
    expect(r.next).toBe(true);
    expect(r.req.clientId).toBe('key:ci');
    expect(r.req.scope.servers).toEqual(['a']);
  });
});

describe('key expiry and disabled keys', () => {
  it('keyInactiveReason', () => {
    const now = Date.parse('2026-06-01T00:00:00Z');
    expect(keyInactiveReason({ key: 'k' }, now)).toBeUndefined();
    expect(keyInactiveReason({ key: 'k', disabled: true }, now)).toBe('disabled');
    expect(keyInactiveReason({ key: 'k', expiresAt: '2026-05-31' }, now)).toBe('expired');
    expect(keyInactiveReason({ key: 'k', expiresAt: '2026-06-02' }, now)).toBeUndefined();
  });

  it('rejects expired / disabled keys with 401 and reports them unknown', async () => {
    const mw = createAuthMiddleware({
      strategy: 'api-key',
      apiKeys: [
        { key: 'expired-key-xyz', name: 'old', expiresAt: '2001-01-01T00:00:00Z' },
        { key: 'disabled-key-xyz', name: 'off', disabled: true },
        { key: 'active-key-xyz', name: 'on', expiresAt: '2999-01-01' },
      ],
    });
    expect((await run(mw, { 'x-api-key': 'expired-key-xyz' })).res.statusCode).toBe(401);
    expect((await run(mw, { 'x-api-key': 'disabled-key-xyz' })).res.statusCode).toBe(401);
    expect((await run(mw, { 'x-api-key': 'active-key-xyz' })).next).toBe(true);
    expect(mw.resolveClient!('key:old')).toEqual({ known: false });
    expect(mw.resolveClient!('key:off')).toEqual({ known: false });
    expect(mw.resolveClient!('key:on').known).toBe(true);
  });

  it('throws on an unparsable expiresAt', () => {
    expect(() => createAuthMiddleware({ strategy: 'api-key', apiKeys: [{ key: 'abcdefgh', expiresAt: 'soon' }] })).toThrow(
      /invalid expiresAt/,
    );
  });
});

describe('JWT hardening', () => {
  const secret = 'a'.repeat(40);
  const hs = (claims: Record<string, unknown> = {}, opts: { iss?: string; aud?: string; exp?: string | number; iat?: number } = {}) => {
    let j = new SignJWT({ sub: 'alice', ...claims }).setProtectedHeader({ alg: 'HS256' });
    if (opts.iat !== undefined) j = j.setIssuedAt(opts.iat);
    else j = j.setIssuedAt();
    if (opts.iss) j = j.setIssuer(opts.iss);
    if (opts.aud) j = j.setAudience(opts.aud);
    if (opts.exp !== undefined) j = j.setExpirationTime(opts.exp);
    return j.sign(new TextEncoder().encode(secret));
  };

  it('buildJwtVerifier rejects missing / conflicting key sources and algorithm confusion', () => {
    expect(() => buildJwtVerifier({ strategy: 'jwt' })).toThrow(/none of/);
    expect(() => buildJwtVerifier({ strategy: 'jwt', jwtSecret: secret, jwt: { jwksUrl: 'https://x/jwks' } })).toThrow(/only one/);
    expect(() => buildJwtVerifier({ strategy: 'jwt', jwtSecret: secret, jwt: { algorithms: ['RS256'] } })).toThrow(/cannot be used/);
    expect(() => buildJwtVerifier({ strategy: 'jwt', jwt: { jwksUrl: 'https://x/jwks', algorithms: ['HS256'] } })).toThrow(/cannot be used/);
    expect(() => buildJwtVerifier({ strategy: 'jwt', jwtSecret: secret, jwt: { algorithms: [] } })).toThrow(/empty/);
    expect(() => buildJwtVerifier({ strategy: 'jwt', jwt: { jwksUrl: 'http://example.com/jwks' } })).toThrow(/https/);
    expect(() => buildJwtVerifier({ strategy: 'jwt', jwt: { jwksUrl: 'not a url' } })).toThrow(/valid URL/);
    expect(() => buildJwtVerifier({ strategy: 'jwt', jwt: { publicKey: 'nope' } })).toThrow(/PEM/);
    expect(buildJwtVerifier({ strategy: 'jwt', jwt: { jwksUrl: 'http://localhost:1/jwks' } }).options.algorithms).toContain('RS256');
  });

  it('enforces issuer, audience, exp, max age and clock tolerance', async () => {
    const mw = createAuthMiddleware({
      strategy: 'jwt',
      jwtSecret: secret,
      jwt: { issuer: 'https://idp', audience: ['mcp-gateway', 'other'], requireExp: true, maxTokenAgeSeconds: 3600 },
    });
    const good = await hs({}, { iss: 'https://idp', aud: 'mcp-gateway', exp: '10m' });
    expect((await run(mw, { authorization: `Bearer ${good}` })).next).toBe(true);
    for (const bad of [
      await hs({}, { iss: 'https://evil', aud: 'mcp-gateway', exp: '10m' }),
      await hs({}, { iss: 'https://idp', aud: 'nope', exp: '10m' }),
      await hs({}, { iss: 'https://idp', aud: 'mcp-gateway' }), // no exp
      await hs({}, { iss: 'https://idp', aud: 'mcp-gateway', exp: '10m', iat: Math.floor(Date.now() / 1000) - 7200 }),
    ]) {
      const r = await run(mw, { authorization: `Bearer ${bad}` });
      expect(r.next).toBe(false);
      expect(r.res.statusCode).toBe(401);
    }

    const lenient = createAuthMiddleware({ strategy: 'jwt', jwtSecret: secret, jwt: { clockToleranceSeconds: 120 } });
    const strict = createAuthMiddleware({ strategy: 'jwt', jwtSecret: secret });
    const justExpired = await hs({}, { exp: Math.floor(Date.now() / 1000) - 30 });
    expect((await run(lenient, { authorization: `Bearer ${justExpired}` })).next).toBe(true);
    expect((await run(strict, { authorization: `Bearer ${justExpired}` })).next).toBe(false);
  });

  it('verifies RS256 tokens with a PEM public key and refuses HS256 tokens signed with that key (alg confusion)', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const pem = await exportSPKI(publicKey);
    const mw = createAuthMiddleware({ strategy: 'jwt', jwt: { publicKey: pem } });
    const token = await new SignJWT({ sub: 'bob', mcp_servers: ['a'] }).setProtectedHeader({ alg: 'RS256' }).sign(privateKey);
    const ok = await run(mw, { authorization: `Bearer ${token}` });
    expect(ok.next).toBe(true);
    expect(ok.req.clientId).toBe('jwt:bob');
    expect(ok.req.scope.servers).toEqual(['a']);

    // Classic confusion attack: HMAC-sign with the public key bytes.
    const forged = await new SignJWT({ sub: 'mallory' }).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(pem));
    expect((await run(mw, { authorization: `Bearer ${forged}` })).next).toBe(false);
  });

  describe('JWKS', () => {
    let http: Server | undefined;
    afterEach(() => new Promise<void>((r) => (http ? http.close(() => r()) : r())));

    it('fetches keys from jwksUrl and caches them', async () => {
      const { publicKey, privateKey } = await generateKeyPair('ES256');
      const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
      let hits = 0;
      const app = express();
      app.get('/jwks', (_req, res) => {
        hits++;
        res.json({ keys: [jwk] });
      });
      http = createServer(app);
      await new Promise<void>((r) => http!.listen(0, '127.0.0.1', () => r()));
      const port = (http.address() as AddressInfo).port;
      const mw = createAuthMiddleware({
        strategy: 'jwt',
        jwt: { jwksUrl: `http://127.0.0.1:${port}/jwks`, audience: 'gw', issuer: 'idp' },
      });
      const sign = (aud: string) =>
        new SignJWT({ sub: 'carol' }).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuer('idp').setAudience(aud).setExpirationTime('5m').sign(privateKey);
      expect((await run(mw, { authorization: `Bearer ${await sign('gw')}` })).next).toBe(true);
      expect((await run(mw, { authorization: `Bearer ${await sign('gw')}` })).next).toBe(true);
      expect((await run(mw, { authorization: `Bearer ${await sign('other')}` })).next).toBe(false);
      expect(hits).toBe(1);
    });
  });

  it('logs failures without the token', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const mw = createAuthMiddleware({ strategy: 'jwt', jwtSecret: secret });
    await run(mw, { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bad' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
