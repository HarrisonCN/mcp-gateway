import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { Gateway } from '../src/gateway/index.js';
import type { GatewayConfig, McpServerConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';
import { hashApiKey } from '../src/auth/middleware.js';
import { configureRedaction, invalidRedactPattern, redactArgs, redactString, redactValue, REDACTED } from '../src/security/redact.js';
import {
  createIpMatcher,
  defaultAllowedHosts,
  hostAllowed,
  invalidCidr,
  isLoopbackOrigin,
  isSameOrigin,
  normalizeIp,
  parseHostHeader,
} from '../src/security/network.js';
import { AuthLockout } from '../src/security/lockout.js';
import { API_CSP, dashboardCsp, inlineScriptHashes } from '../src/security/headers.js';
import { isLoopbackHost, securityWarnings } from '../src/security/posture.js';
import { redactServer } from '../src/gateway/api.js';
import { MetricsCollector } from '../src/monitor/index.js';
import { loadConfig } from '../src/config/loader.js';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

logger.setLevel('error');

// ─── Units ────────────────────────────────────────────────────────────────────

describe('redaction', () => {
  afterEach(() => configureRedaction([]));

  it('masks well-known token shapes in strings', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJl';
    const cases = [
      'Authorization: Bearer abcdefghijklmnop',
      `token ${jwt}`,
      'key sk-ant-REDACTEDREDACTEDREDACTED00',
      'gh ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'aws AKIAABCDEFGHIJKLMNOP',
      'https://user:hunter2@example.com/x',
      'failed: password=hunter2 for user',
      '{"api_key": "abcdef123"}',
      'mgw_abcdefghijklmnopqrstuv',
    ];
    for (const c of cases) {
      const out = redactString(c);
      expect(out, c).toContain(REDACTED);
      expect(out).not.toMatch(/hunter2|abcdefghijklmnop|ghp_a|AKIAABCD|sk-ant|c2lnbmF0dXJl|abcdef123|mgw_abc/);
    }
    expect(redactString('plain message, 42 tools')).toBe('plain message, 42 tools');
  });

  it('masks values under secret-looking keys, deeply', () => {
    const out = redactValue({ a: 1, headers: { Authorization: 'x', 'X-Api-Key': 'y' }, list: [{ password: 'p', ok: 'fine' }], githubToken: 't', maxTokens: 5, when: new Date(0) });
    expect(out).toEqual({ a: 1, headers: { Authorization: REDACTED, 'X-Api-Key': REDACTED }, list: [{ password: REDACTED, ok: 'fine' }], githubToken: REDACTED, maxTokens: 5, when: new Date(0) });
  });

  it('masks secrets in command lines', () => {
    expect(redactArgs(['-y', 'server', '--token', 'abc', '--api-key=xyz', '--verbose', 'Bearer abcdefghij123'])).toEqual([
      '-y', 'server', '--token', REDACTED, `--api-key=${REDACTED}`, '--verbose', `Bearer ${REDACTED}`,
    ]);
  });

  it('applies extra patterns and validates them', () => {
    configureRedaction(['internal-[0-9]{4}']);
    expect(redactString('id internal-1234 ok')).toBe(`id ${REDACTED} ok`);
    expect(invalidRedactPattern(['ok', '('])).toMatch(/^\(:/);
    expect(invalidRedactPattern(['ok'])).toBeUndefined();
  });

  it('redacts error messages recorded as metrics and logged text', () => {
    const m = new MetricsCollector();
    const rec = m.record({ serverId: 's', toolName: 't', durationMs: 1, success: false, errorMessage: 'upstream said token=supersecret' });
    expect(rec.errorMessage).toBe(`upstream said token=${REDACTED}`);
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    logger.setLevel('warn');
    logger.warn('call with Bearer abcdefghijklmnop', { password: 'p' });
    logger.setLevel('error');
    const line = String(write.mock.calls[0]?.[0]);
    write.mockRestore();
    expect(line).toContain(`Bearer ${REDACTED}`);
    expect(line).not.toContain('abcdefghijklmnop');
    expect(line).toContain(`"password":"${REDACTED}"`);
  });

  it('redactServer masks env, headers, URL credentials and args', () => {
    const s: McpServerConfig = {
      id: 'x', name: 'x', transport: 'stdio', command: 'npx', args: ['--token', 'abc'], env: { A: 'b' },
    };
    expect(redactServer(s).args).toEqual(['--token', REDACTED]);
    expect(redactServer(s).env).toEqual({ A: '***' });
  });
});

describe('network guards', () => {
  it('matches IPs and CIDRs (v4, v6, v4-mapped)', () => {
    const m = createIpMatcher(['10.0.0.0/8', '192.168.1.5', 'fd00::/8', '::1']);
    expect(m('10.1.2.3')).toBe(true);
    expect(m('::ffff:10.1.2.3')).toBe(true);
    expect(m('192.168.1.5')).toBe(true);
    expect(m('192.168.1.6')).toBe(false);
    expect(m('fd12::1')).toBe(true);
    expect(m('::1')).toBe(true);
    expect(m('2001:db8::1')).toBe(false);
    expect(m(undefined)).toBe(false);
    expect(m('garbage')).toBe(false);
    expect(normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
  });

  it('validates CIDR entries', () => {
    expect(invalidCidr(['10.0.0.0/8', '::1'])).toBeUndefined();
    expect(invalidCidr(['10.0.0.0/33'])).toMatch(/prefix/);
    expect(invalidCidr(['nope'])).toMatch(/invalid/);
    expect(invalidCidr(['1.2.3.4/8/1'])).toMatch(/invalid/);
  });

  it('parses Host headers and matches host patterns', () => {
    expect(parseHostHeader('Example.com:8080')).toEqual({ hostname: 'example.com', port: '8080' });
    expect(parseHostHeader('[::1]:4000')).toEqual({ hostname: '[::1]', port: '4000' });
    expect(parseHostHeader('[::1]')).toEqual({ hostname: '[::1]', port: undefined });
    expect(parseHostHeader('::1')).toEqual({ hostname: '::1' });
    expect(hostAllowed(['localhost'], 'localhost:4000')).toBe(true);
    expect(hostAllowed(['localhost:4000'], 'localhost:5000')).toBe(false);
    expect(hostAllowed(['*.example.com'], 'api.example.com')).toBe(true);
    expect(hostAllowed(['*.example.com'], 'example.com')).toBe(false);
    expect(hostAllowed(['*.example.com'], 'evilexample.com')).toBe(false);
    expect(hostAllowed(['*'], 'anything')).toBe(true);
    expect(hostAllowed(['localhost'], undefined)).toBe(false);
    expect(defaultAllowedHosts('0.0.0.0')).toEqual(['localhost', '127.0.0.1', '[::1]', '::1']);
    expect(defaultAllowedHosts('10.0.0.5')).toContain('10.0.0.5');
    expect(defaultAllowedHosts('fd00::5')).toContain('[fd00::5]');
  });

  it('classifies origins', () => {
    expect(isLoopbackOrigin('http://localhost:3000')).toBe(true);
    expect(isLoopbackOrigin('http://127.0.0.1')).toBe(true);
    expect(isLoopbackOrigin('https://evil.com')).toBe(false);
    expect(isLoopbackOrigin('null')).toBe(false);
    expect(isSameOrigin('http://gw.example.com:4000', 'gw.example.com:4000')).toBe(true);
    expect(isSameOrigin('http://evil.com', 'gw.example.com')).toBe(false);
    expect(isSameOrigin('http://x', undefined)).toBe(false);
    expect(isSameOrigin('::bad', 'x')).toBe(false);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
  });
});

describe('AuthLockout', () => {
  it('locks after maxFailures within the window, unlocks after lockoutSeconds, resets on success', () => {
    let t = 0;
    const lo = new AuthLockout({ maxFailures: 3, windowSeconds: 60, lockoutSeconds: 120 }, () => t);
    expect(lo.fail('a')).toBe(false);
    expect(lo.fail('a')).toBe(false);
    expect(lo.fail('a')).toBe(true);
    expect(lo.lockedFor('a')).toBe(120);
    expect(lo.fail('a')).toBe(false); // already locked
    expect(lo.status()).toMatchObject({ lockedClients: 1, lockoutsTotal: 1 });
    lo.success('a'); // success while locked does not unlock
    expect(lo.lockedFor('a')).toBe(120);
    t = 121_000;
    expect(lo.lockedFor('a')).toBe(0);

    lo.fail('b');
    lo.fail('b');
    lo.success('b');
    lo.fail('b');
    lo.fail('b');
    expect(lo.lockedFor('b')).toBe(0);
    // Failures outside the window start a new count.
    t += 61_000;
    lo.fail('b');
    expect(lo.lockedFor('b')).toBe(0);
    (lo as any).prune();
    lo.close();
  });
});

describe('security headers', () => {
  it('hashes inline scripts only', () => {
    const html = '<script>alert(1)</script><script src="x.js"></script><script type="module">b()</script>';
    const expected = (s: string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
    expect(inlineScriptHashes(html)).toEqual([expected('alert(1)'), expected('b()')]);
    expect(dashboardCsp('<p>no script</p>')).toContain("script-src 'none'");
  });

  it('the real dashboard has exactly one inline script, no inline handlers and a matching CSP', () => {
    const html = readFileSync(fileURLToPath(new URL('../dashboard/index.html', import.meta.url)), 'utf8');
    expect(inlineScriptHashes(html)).toHaveLength(1);
    expect(html).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
    expect(html).not.toMatch(/\beval\(|new Function\(/);
    const csp = dashboardCsp(html);
    expect(csp).toContain(inlineScriptHashes(html)[0]);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
  });
});

describe('securityWarnings', () => {
  const base: GatewayConfig = { port: 0, host: '127.0.0.1', servers: [] };
  const ids = (c: GatewayConfig) => securityWarnings(c).map((w) => w.id);

  it('flags auth off on a public bind, DNS rebinding and any-origin /mcp', () => {
    expect(ids({ ...base, host: '0.0.0.0' })).toContain('auth-disabled-public-bind');
    // 10.2: protection is on by default for a loopback gateway without auth — warn only when it was switched off.
    expect(ids(base)).not.toContain('dns-rebinding');
    expect(ids(base)).not.toContain('mcp-any-origin');
    const off = { ...base, security: { dnsRebindingProtection: false } };
    expect(ids(off)).toContain('dns-rebinding');
    expect(ids(off)).toContain('mcp-any-origin');
    expect(ids({ ...base, security: { dnsRebindingProtection: true } })).not.toContain('dns-rebinding');
    expect(ids({ ...off, mcp: { allowedOrigins: ['https://app'] } })).not.toContain('mcp-any-origin');
  });

  it('flags key hygiene, JWT settings and other risky switches', () => {
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const w = ids({
      ...base,
      auth: { strategy: 'api-key', apiKeys: ['short', { key: hashApiKey('x'), name: 'soon', expiresAt: soon }] },
      cors: { origins: ['*'] },
      security: { headers: false, exposeErrorDetails: true },
    });
    expect(w).toEqual(expect.arrayContaining(['plaintext-api-keys', 'short-api-keys', 'api-keys-expiring', 'no-auth-lockout', 'headers-disabled', 'error-details', 'cors-wildcard']));
    const j = ids({ ...base, auth: { strategy: 'jwt', jwtSecret: 'x'.repeat(40) }, security: { authLockout: true } });
    expect(j).toEqual(expect.arrayContaining(['jwt-no-issuer-audience', 'jwt-no-exp']));
    expect(j).not.toContain('no-auth-lockout');
    expect(securityWarnings({ ...base, auth: { strategy: 'api-key', apiKeys: ['x'] } }).find((x) => x.id === 'plaintext-api-keys')?.level).toBe('info');
  });
});

describe('config validation (security)', () => {
  const write = (yaml: string) => {
    const d = mkdtempSync(join(tmpdir(), 'mcpgw-sec-'));
    const f = join(d, 'c.yml');
    writeFileSync(f, yaml);
    return f;
  };

  it('accepts a full security block and new auth fields', async () => {
    const c = await loadConfig(
      write(`
auth:
  strategy: api-key
  apiKeys:
    - ${hashApiKey('k')}
    - { key: abc, name: n, expiresAt: "2030-01-01", disabled: false }
security:
  hsts: { maxAgeSeconds: 100, includeSubDomains: true }
  trustProxy: ["10.0.0.0/8"]
  ipAllowlist: ["10.0.0.0/8", "::1"]
  allowedHosts: [gw.example.com]
  dnsRebindingProtection: true
  maxBodyBytes: 2048
  maxToolArgumentsBytes: 1024
  authLockout: { maxFailures: 5 }
  redactPatterns: ["foo[0-9]+"]
`),
    );
    expect(c.security).toMatchObject({ headers: true, maxBodyBytes: 2048, authLockout: { maxFailures: 5 }, exposeErrorDetails: false });
  });

  it('rejects malformed digests, bad CIDRs, bad regexes, bad expiry and unknown keys', async () => {
    const bad = [
      'auth: { strategy: api-key, apiKeys: ["sha256:abc"] }',
      'auth: { strategy: api-key, apiKeys: [{ key: abc, expiresAt: soon }] }',
      'security: { ipAllowlist: ["10.0.0.0/40"] }',
      'security: { redactPatterns: ["("] }',
      'security: { bogus: true }',
      'security: { maxBodyBytes: 10 }',
    ];
    for (const y of bad) await expect(loadConfig(write(y)), y).rejects.toThrow(/Invalid configuration/);
  });

  it('validates JWT key sources and algorithms', async () => {
    await expect(loadConfig(write('auth: { strategy: jwt }'))).rejects.toThrow(/jwtSecret, jwt.publicKey or jwt.jwksUrl/);
    await expect(
      loadConfig(write('auth: { strategy: jwt, jwtSecret: abc, jwt: { jwksUrl: "https://idp/jwks" } }')),
    ).rejects.toThrow(/only one/);
    await expect(
      loadConfig(write('auth: { strategy: jwt, jwt: { jwksUrl: "https://idp/jwks", algorithms: [HS256] } }')),
    ).rejects.toThrow(/algorithm confusion/);
    const ok = await loadConfig(
      write('auth: { strategy: jwt, jwt: { jwksUrl: "https://idp/jwks", issuer: idp, audience: [a, b], requireExp: true } }'),
    );
    expect(ok.auth?.jwt?.audience).toEqual(['a', 'b']);
  });
});

// ─── Gateway integration ──────────────────────────────────────────────────────

const base: GatewayConfig = {
  port: 0,
  host: '127.0.0.1',
  logLevel: 'error',
  monitor: { requestLog: false },
  servers: [],
};

let gw: Gateway | undefined;
afterEach(async () => {
  await gw?.stop();
  gw = undefined;
});

async function start(config: GatewayConfig): Promise<string> {
  gw = new Gateway(config);
  await gw.start();
  return `http://127.0.0.1:${gw.address()!.port}`;
}

describe('gateway security integration', () => {
  it('sends security headers, a dashboard CSP, and none when disabled', async () => {
    const url = await start({ ...base, security: { hsts: true } });
    const r = await fetch(`${url}/api/v1/health`);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('content-security-policy')).toBe(API_CSP);
    expect(r.headers.get('strict-transport-security')).toMatch(/^max-age=\d+/);
    const d = await fetch(`${url}/dashboard`);
    expect(d.status).toBe(200);
    const html = await d.text();
    expect(d.headers.get('content-security-policy')).toBe(dashboardCsp(html));
    await gw!.stop();

    const url2 = await start({ ...base, security: { headers: false } });
    const r2 = await fetch(`${url2}/dashboard`);
    expect(r2.headers.get('x-content-type-options')).toBeNull();
    expect(r2.headers.get('content-security-policy')).toBeNull();
  });

  it('IP allowlist blocks other clients but keeps probes open; trustProxy uses X-Forwarded-For', async () => {
    const url = await start({ ...base, security: { ipAllowlist: ['10.0.0.0/8'] } });
    expect((await fetch(`${url}/api/v1/health`)).status).toBe(403);
    expect((await fetch(`${url}/mcp`, { method: 'POST' })).status).toBe(403);
    expect((await fetch(`${url}/api/v1/health/live`)).status).toBe(200);
    expect((await fetch(`${url}/api/v1/health/ready`)).status).toBe(200);
    // Without trustProxy the header is ignored.
    expect((await fetch(`${url}/api/v1/health`, { headers: { 'x-forwarded-for': '10.1.1.1' } })).status).toBe(403);
    await gw!.stop();

    const url2 = await start({ ...base, security: { ipAllowlist: ['10.0.0.0/8'], trustProxy: ['127.0.0.1'] } });
    expect((await fetch(`${url2}/api/v1/health`, { headers: { 'x-forwarded-for': '10.1.1.1' } })).status).toBe(200);
    expect((await fetch(`${url2}/api/v1/health`, { headers: { 'x-forwarded-for': '8.8.8.8' } })).status).toBe(403);
  });

  it('rejects an invalid trustProxy value at startup', async () => {
    gw = new Gateway({ ...base, security: { trustProxy: ['not-an-ip'] } });
    await expect(gw.start()).rejects.toThrow(/trustProxy/);
  });

  it('DNS-rebinding protection checks Host and /mcp Origin', async () => {
    const url = await start({ ...base, security: { dnsRebindingProtection: true } });
    // fetch() does not allow overriding Host; use node:http.
    const { request } = await import('http');
    const port = gw!.address()!.port;
    const status = (headers: Record<string, string>, path = '/api/v1/health') =>
      new Promise<number>((resolve, reject) => {
        const r = request({ host: '127.0.0.1', port, path, headers }, (res) => {
          res.resume();
          resolve(res.statusCode!);
        });
        r.on('error', reject);
        r.end();
      });
    expect(await status({ host: 'evil.example' })).toBe(403);
    expect(await status({ host: `localhost:${port}` })).toBe(200);
    expect(await status({ host: 'evil.example' }, '/api/v1/health/live')).toBe(200);

    const init = (origin: string) =>
      fetch(`${url}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', origin },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }),
      });
    expect((await init('https://evil.example')).status).toBe(403);
    expect((await init('http://localhost:6274')).status).toBe(200);
    expect((await init(url)).status).toBe(200); // same origin
  });

  it('allowedHosts without DNS-rebinding mode', async () => {
    await start({ ...base, security: { allowedHosts: ['gw.example.com'] } });
    const { request } = await import('http');
    const port = gw!.address()!.port;
    const status = (host: string) =>
      new Promise<number>((resolve) => {
        request({ host: '127.0.0.1', port, path: '/api/v1/health', headers: { host } }, (res) => {
          res.resume();
          resolve(res.statusCode!);
        }).end();
      });
    expect(await status('gw.example.com')).toBe(200);
    expect(await status('localhost')).toBe(403);
  });

  it('enforces maxBodyBytes and maxToolArgumentsBytes on the REST API and /mcp', async () => {
    const url = await start({ ...base, security: { maxBodyBytes: 2048, maxToolArgumentsBytes: 64 } });
    const big = await fetch(`${url}/api/v1/tools/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'x', arguments: { blob: 'x'.repeat(4000) } }),
    });
    expect(big.status).toBe(413);
    const args = await fetch(`${url}/api/v1/tools/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'x', arguments: { blob: 'x'.repeat(200) } }),
    });
    expect(args.status).toBe(413);
    expect(((await args.json()) as any).message).toMatch(/maxToolArgumentsBytes/);
    const prompt = await fetch(`${url}/api/v1/prompts/get`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', arguments: { blob: 'x'.repeat(200) } }),
    });
    expect(prompt.status).toBe(413);
    const mcp = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(4000) } }),
    });
    expect(mcp.status).toBe(413);
  });

  it('locks out an IP after repeated auth failures (REST and /mcp share the counter)', async () => {
    const url = await start({
      ...base,
      auth: { strategy: 'api-key', apiKeys: ['good-key-123456789'] },
      security: { authLockout: { maxFailures: 3, windowSeconds: 60, lockoutSeconds: 60 } },
    });
    const call = (key: string, path = '/api/v1/servers') => fetch(`${url}${path}`, { headers: { 'x-api-key': key } });
    expect((await call('good-key-123456789')).status).toBe(200);
    expect((await call('bad')).status).toBe(401);
    expect((await call('bad')).status).toBe(401);
    expect((await fetch(`${url}/mcp`, { method: 'POST', headers: { 'x-api-key': 'bad', 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    const locked = await call('good-key-123456789');
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    // Probes stay reachable.
    expect((await fetch(`${url}/api/v1/health/live`)).status).toBe(200);
  });

  it('GET /security reports posture without key material; scoped keys are refused', async () => {
    const plain = 'plain-key-abcdefghijklmnop';
    const url = await start({
      ...base,
      auth: {
        strategy: 'api-key',
        apiKeys: [
          plain,
          { key: hashApiKey('hashed-key-abcdefghijk'), name: 'ops', expiresAt: '2999-01-01' },
          { key: 'scoped-key-abcdefghijklm', name: 'scoped', servers: ['a'] },
          { key: 'off-key-abcdefghijklmnop', name: 'off', disabled: true },
        ],
      },
      security: { authLockout: true },
    });
    const r = await fetch(`${url}/api/v1/security`, { headers: { 'x-api-key': plain } });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toContain(plain);
    const body = JSON.parse(text);
    expect(body.authStrategy).toBe('api-key');
    expect(body.apiKeys).toMatchObject({ total: 4, hashed: 1, disabled: 1, expired: 0 });
    expect(body.apiKeys.expiring).toEqual([{ name: 'ops', expiresAt: '2999-01-01T00:00:00.000Z' }]);
    expect(body.settings.authLockout).toEqual({ maxFailures: 10, windowSeconds: 300, lockoutSeconds: 900 });
    expect(body.lockout).toMatchObject({ lockedClients: 0 });
    expect(body.jwt).toBeNull();
    expect(body.warnings.map((w: any) => w.id)).toContain('plaintext-api-keys');
    expect((await fetch(`${url}/api/v1/security`, { headers: { 'x-api-key': 'scoped-key-abcdefghijklm' } })).status).toBe(403);
    expect((await fetch(`${url}/api/v1/security`)).status).toBe(401);
  });

  it('hot reloads security settings', async () => {
    const url = await start({ ...base });
    expect((await fetch(`${url}/api/v1/health`)).status).toBe(200);
    await gw!.reload({ ...base, security: { ipAllowlist: ['10.0.0.0/8'], maxBodyBytes: 4096 } });
    expect((await fetch(`${url}/api/v1/health`)).status).toBe(403);
    await gw!.reload({ ...base, security: { trustProxy: 'loopback', maxBodyBytes: 4096 } });
    expect((await fetch(`${url}/api/v1/health`)).status).toBe(200);
    // An invalid trustProxy on reload is logged and ignored.
    await gw!.reload({ ...base, security: { trustProxy: ['bogus'] } });
    expect((await fetch(`${url}/api/v1/health`)).status).toBe(200);
  });

  it('logs startup warnings', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    await start({ ...base, auth: { strategy: 'api-key', apiKeys: ['k'] } });
    expect(warn.mock.calls.some(([m]) => /Security:/.test(String(m)))).toBe(true);
    expect(info.mock.calls.some(([m]) => /Security hint:/.test(String(m)))).toBe(true);
    warn.mockRestore();
    info.mockRestore();
  });
});
