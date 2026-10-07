import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from 'jose';
import { Gateway } from '../src/gateway/index.js';
import { metadataUrls, tokenScopes } from '../src/auth/oauth.js';
import { loadConfig } from '../src/config/loader.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

logger.setLevel('error');

let privateKey: KeyLike;
let jwk: Record<string, unknown>;
beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  jwk = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
});

interface AuthServer {
  url: string;
  introspections: number;
  opaque: Map<string, Record<string, unknown>>;
  close(): Promise<void>;
}

async function startAuthServer(): Promise<AuthServer> {
  const state = { introspections: 0, opaque: new Map<string, Record<string, unknown>>() };
  let base = '';
  const server: Server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/.well-known/oauth-authorization-server') {
      return send(200, { issuer: base, jwks_uri: `${base}/jwks`, introspection_endpoint: `${base}/introspect` });
    }
    if (req.url === '/jwks') return send(200, { keys: [jwk] });
    if (req.url === '/introspect' && req.method === 'POST') {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        state.introspections++;
        if (req.headers.authorization !== `Basic ${Buffer.from('gw:secret').toString('base64')}`) return send(401, {});
        const token = new URLSearchParams(data).get('token') ?? '';
        send(200, state.opaque.get(token) ?? { active: false });
      });
      return;
    }
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    get introspections() {
      return state.introspections;
    },
    opaque: state.opaque,
    close: () => new Promise((r) => server.close(() => r())),
  } as AuthServer;
}

let gw: Gateway | undefined;
let as: AuthServer | undefined;
afterEach(async () => {
  await gw?.stop();
  gw = undefined;
  await as?.close();
  as = undefined;
});

const base: GatewayConfig = { port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false }, servers: [] };

async function start(oauth: Partial<NonNullable<NonNullable<GatewayConfig['auth']>['oauth']>> = {}) {
  as = await startAuthServer();
  gw = new Gateway({
    ...base,
    auth: { strategy: 'oauth2', oauth: { authorizationServers: [as.url], scopesSupported: ['mcp:tools'], ...oauth } },
  });
  await gw.start();
  const url = `http://127.0.0.1:${gw.address()!.port}`;
  return { url, resource: `${url}/mcp` };
}

const sign = (claims: Record<string, unknown>, opts: { aud: string; iss?: string; exp?: string } ) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? as!.url)
    .setAudience(opts.aud)
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(privateKey);

const init = (url: string, token?: string) =>
  fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
  });

describe('OAuth 2.1 protected resource', () => {
  it('serves RFC 9728 protected resource metadata at both well-known URLs', async () => {
    const { url, resource } = await start({ resourceName: 'Test GW' });
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const r = await fetch(`${url}${path}`);
      expect(r.status).toBe(200);
      const doc = (await r.json()) as Record<string, unknown>;
      expect(doc.resource).toBe(resource);
      expect(doc.authorization_servers).toEqual([as!.url]);
      expect(doc.bearer_methods_supported).toEqual(['header']);
      expect(doc.scopes_supported).toEqual(['mcp:tools']);
      expect(doc.resource_name).toBe('Test GW');
    }
    expect((await fetch(`${url}/.well-known/oauth-protected-resource/other`)).status).toBe(404);
  });

  it('answers 401 with a WWW-Authenticate challenge pointing at the metadata', async () => {
    const { url } = await start();
    const r = await init(url);
    expect(r.status).toBe(401);
    const h = r.headers.get('www-authenticate')!;
    expect(h).toMatch(/^Bearer /);
    expect(h).toContain(`resource_metadata="${url}/.well-known/oauth-protected-resource/mcp"`);
    expect(h).not.toContain('error=');
  });

  it('accepts JWTs signed by the discovered JWKS for this resource', async () => {
    const { url, resource } = await start();
    const token = await sign({ scope: 'mcp:tools' }, { aud: resource });
    const r = await init(url, token);
    expect(r.status).toBe(200);
    expect(r.headers.get('mcp-session-id')).toBeTruthy();
    // REST API shares the auth middleware
    const tools = await fetch(`${url}/api/v1/tools`, { headers: { authorization: `Bearer ${token}` } });
    expect(tools.status).toBe(200);
  });

  it('rejects tokens for another audience or issuer with invalid_token', async () => {
    const { url } = await start();
    for (const token of [
      await sign({}, { aud: 'https://other.example.com/mcp' }),
      await sign({}, { aud: `${url}/mcp`, iss: 'https://evil.example.com' }),
      'not-a-token',
    ]) {
      const r = await init(url, token);
      expect(r.status).toBe(401);
      expect(r.headers.get('www-authenticate')).toContain('error="invalid_token"');
    }
  });

  it('answers 403 insufficient_scope when required scopes are missing', async () => {
    const { url, resource } = await start({ requiredScopes: ['mcp:tools', 'mcp:admin'] });
    const r = await init(url, await sign({ scope: 'mcp:tools' }, { aud: resource }));
    expect(r.status).toBe(403);
    const h = r.headers.get('www-authenticate')!;
    expect(h).toContain('error="insufficient_scope"');
    expect(h).toContain('scope="mcp:tools mcp:admin"');
    const ok = await init(url, await sign({ scope: 'mcp:admin mcp:tools' }, { aud: resource }));
    expect(ok.status).toBe(200);
  });

  it('validates opaque tokens by introspection and caches active results', async () => {
    as = await startAuthServer();
    gw = new Gateway({
      ...base,
      auth: {
        strategy: 'oauth2',
        oauth: { authorizationServers: [as.url], introspection: { url: `${as.url}/introspect`, clientId: 'gw', clientSecret: 'secret' } },
      },
    });
    await gw.start();
    const gwUrl = `http://127.0.0.1:${gw.address()!.port}`;
    as.opaque.set('opaque-123', { active: true, sub: 'svc', aud: `${gwUrl}/mcp`, scope: 'a b', exp: Math.floor(Date.now() / 1000) + 60 });
    as.opaque.set('wrong-aud', { active: true, sub: 'svc', aud: 'https://x/mcp', exp: Math.floor(Date.now() / 1000) + 60 });
    expect((await init(gwUrl, 'opaque-123')).status).toBe(200);
    expect((await init(gwUrl, 'opaque-123')).status).toBe(200);
    expect(as.introspections).toBe(1);
    expect((await init(gwUrl, 'inactive')).status).toBe(401);
    expect((await init(gwUrl, 'wrong-aud')).status).toBe(401);
  });

  it('reports OAuth settings in /api/v1/security', async () => {
    const { url, resource } = await start();
    const token = await sign({}, { aud: resource });
    const r = await fetch(`${url}/api/v1/security`, { headers: { authorization: `Bearer ${token}` } });
    const body = (await r.json()) as { oauth: { validation: string }; warnings: Array<{ id: string }> };
    expect(body.oauth.validation).toBe('jwks-discovery');
    expect(body.warnings.map((w) => w.id)).toContain('oauth-no-resource');
  });
});

describe('OAuth helpers and config', () => {
  it('builds RFC 8414 metadata URLs', () => {
    expect(metadataUrls('https://as.example.com')).toEqual([
      'https://as.example.com/.well-known/oauth-authorization-server',
      'https://as.example.com/.well-known/openid-configuration',
    ]);
    expect(metadataUrls('https://as.example.com/tenant1')[0]).toBe('https://as.example.com/.well-known/oauth-authorization-server/tenant1');
  });

  it('parses scope claims', () => {
    expect(tokenScopes({ scope: 'a  b' })).toEqual(['a', 'b']);
    expect(tokenScopes({ scp: ['x', 1] })).toEqual(['x']);
    expect(tokenScopes({})).toEqual([]);
  });

  it('rejects insecure authorization server URLs', async () => {
    const g = new Gateway({ ...base, auth: { strategy: 'oauth2', oauth: { authorizationServers: ['http://as.example.com'] } } });
    await expect(g.start()).rejects.toThrow(/https/);
  });

  it('loads auth.oauth from a config file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgw-oauth-'));
    const f = join(dir, 'c.yml');
    writeFileSync(f, 'auth:\n  strategy: oauth2\n  oauth:\n    authorizationServers: [https://as.example.com]\n    requiredScopes: [mcp]\n');
    const c = await loadConfig(f);
    expect(c.auth?.oauth?.authorizationServers).toEqual(['https://as.example.com']);
    writeFileSync(f, 'auth:\n  strategy: oauth2\n  oauth:\n    authorizationServers: []\n');
    await expect(loadConfig(f)).rejects.toThrow(/authorizationServers/);
  });
});

describe('Streamable HTTP resumability', () => {
  it('replays missed events after Last-Event-ID, including events sent while no stream was open', async () => {
    gw = new Gateway({ ...base, mcp: { eventBufferSize: 3 } });
    await gw.start();
    const url = `http://127.0.0.1:${gw.address()!.port}`;
    const r = await init(url);
    const sid = r.headers.get('mcp-session-id')!;
    const ep = gw.getMcpEndpoint() as unknown as { sessions: Map<string, unknown>; send(s: unknown, m: unknown): boolean };
    const session = ep.sessions.get(sid);
    for (let i = 1; i <= 4; i++) ep.send(session, { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: `e${i}` } });

    const readUntil = async (lastId: string, needle: string) => {
      const ac = new AbortController();
      const res = await fetch(`${url}/mcp`, {
        headers: { accept: 'text/event-stream', 'mcp-session-id': sid, 'last-event-id': lastId },
        signal: ac.signal,
      });
      const reader = res.body!.getReader();
      let text = '';
      const end = Date.now() + 3000;
      while (!text.includes(needle) && Date.now() < end) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      ac.abort();
      return text;
    };
    // buffer holds the last 3 events (2, 3, 4)
    const all = await readUntil('0', '"e4"');
    expect(all).not.toContain('"e1"');
    expect(all).toMatch(/id: 2\n[\s\S]*"e2"[\s\S]*id: 4\n[\s\S]*"e4"/);
    const tail = await readUntil('3', '"e4"');
    expect(tail).not.toContain('"e3"');
    expect(tail).toContain('id: 4');
  });
});
