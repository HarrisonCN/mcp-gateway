import { describe, it, expect, vi } from 'vitest';
import { SignJWT } from 'jose';
import { createAuthMiddleware, matchesAnyKey, fingerprint } from '../src/auth/middleware.js';
import { createHash } from 'crypto';

function mockRes() {
  const res: any = { statusCode: 200, body: undefined, headersSent: false };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), (res.headersSent = true), res);
  return res;
}
const req = (headers: Record<string, string | undefined> = {}): any => ({ headers, ip: '127.0.0.1' });

describe('auth middleware', () => {
  it('fails closed for unsupported strategies instead of disabling auth', () => {
    expect(() => createAuthMiddleware({ strategy: 'oauth2' })).toThrow(/auth.oauth is not configured/);
    expect(() => createAuthMiddleware({ strategy: 'bogus' as any })).toThrow();
  });

  it('refuses api-key strategy without keys and jwt without secret', () => {
    expect(() => createAuthMiddleware({ strategy: 'api-key', apiKeys: [] })).toThrow();
    expect(() => createAuthMiddleware({ strategy: 'api-key', apiKeys: [''] })).toThrow();
    expect(() => createAuthMiddleware({ strategy: 'jwt' })).toThrow();
  });

  it('accepts valid api keys via Bearer and x-api-key, rejects others', () => {
    const mw = createAuthMiddleware({ strategy: 'api-key', apiKeys: ['secret-key-1', 'secret-key-2'] });
    for (const headers of [{ authorization: 'Bearer secret-key-2' }, { 'x-api-key': 'secret-key-1' }]) {
      const next = vi.fn();
      const r = req(headers);
      mw(r, mockRes(), next);
      expect(next).toHaveBeenCalledOnce();
      expect(r.clientId).toMatch(/^key:[0-9a-f]{12}$/);
      expect(r.clientId).not.toContain('secret');
    }
    for (const headers of [{}, { authorization: 'Bearer secret-key' }, { 'x-api-key': 'secret-key-10' }]) {
      const next = vi.fn();
      const res = mockRes();
      mw(req(headers), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    }
  });

  it('keys with a shared prefix get distinct client ids', () => {
    expect(fingerprint('abcdefgh-one')).not.toBe(fingerprint('abcdefgh-two'));
  });

  it('matchesAnyKey compares digests', () => {
    const d = (s: string) => createHash('sha256').update(s).digest();
    expect(matchesAnyKey('a', [d('b'), d('a')])).toBe(true);
    expect(matchesAnyKey('c', [d('b'), d('a')])).toBe(false);
  });

  it('verifies HS256 JWTs and rejects bad ones', async () => {
    const secret = 'x'.repeat(40);
    const mw = createAuthMiddleware({ strategy: 'jwt', jwtSecret: secret });
    const token = await new SignJWT({ sub: 'alice' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(secret));

    const ok = await new Promise<any>((resolve) => {
      const r = req({ authorization: `Bearer ${token}` });
      mw(r, mockRes(), () => resolve(r));
    });
    expect(ok.clientId).toBe('jwt:alice');

    const res = mockRes();
    await new Promise<void>((resolve) => {
      res.json = (b: unknown) => ((res.body = b), resolve(), res);
      mw(req({ authorization: `Bearer ${token}x` }), res, () => resolve());
    });
    expect(res.statusCode).toBe(401);
  });
});
