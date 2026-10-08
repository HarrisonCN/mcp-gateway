/** 3.8: developer portal — self-serve keys, usage, interactive tool docs. */
import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PortalStore, exampleArgs, toolSnippets } from '../src/portal/index.js';
import { Gateway } from '../src/gateway/index.js';
import { validateConfig } from '../src/config/loader.js';
import { inlineScriptHashes } from '../src/security/headers.js';
import type { GatewayConfig, PortalConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));

describe('PortalStore', () => {
  it('issues, approves, rotates and revokes keys, persisting only hashes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgw-portal-'));
    let cfg: PortalConfig = { enabled: true, signup: 'approval', keysFile: 'keys.json', defaults: { servers: ['public-*'], rateLimit: { limit: 10, windowSeconds: 60 }, keyTtlDays: 30 } };
    let changes = 0;
    const store = new PortalStore(() => cfg, { baseDir: () => dir, onChange: () => changes++ });
    const { record, key } = store.signup({ name: 'Acme bot', email: 'Dev@Acme.io' });
    expect(record).toMatchObject({ status: 'pending', email: 'dev@acme.io', servers: ['public-*'], rateLimit: { limit: 10, windowSeconds: 60 } });
    expect(key).toMatch(/^mgw_/);
    expect(store.apiKeys()).toEqual([]);
    store.decide(record.id, true);
    const keys = store.apiKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ name: `portal-${record.id}`, servers: ['public-*'] });
    expect(keys[0]!.key).toMatch(/^sha256:[0-9a-f]{64}$/);
    const file = readFileSync(join(dir, 'keys.json'), 'utf8');
    expect(file).not.toContain(key!);
    // A fresh store reads the file.
    expect(new PortalStore(() => cfg, { baseDir: () => dir }).get(record.id)?.status).toBe('active');
    const rot = store.rotate(record.id);
    expect(rot.key).not.toBe(key);
    expect(store.apiKeys()[0]!.key).not.toBe(keys[0]!.key);
    store.revoke(record.id);
    expect(store.apiKeys()).toEqual([]);
    expect(changes).toBe(4);
    expect(store.byClientId(`key:portal-${record.id}`)?.id).toBe(record.id);
    // Signup rules.
    cfg = { ...cfg, allowedEmailDomains: ['acme.io'], maxKeysPerEmail: 1 };
    expect(() => store.signup({ name: 'x', email: 'x@evil.com' })).toThrow(/limited to @acme.io/);
    expect(() => store.signup({ name: '', email: 'x@acme.io' })).toThrow(/name/);
    expect(() => store.signup({ name: 'x', email: 'nope' })).toThrow(/e-mail/);
    store.signup({ name: 'x', email: 'x@acme.io' });
    expect(() => store.signup({ name: 'y', email: 'x@acme.io' })).toThrow(/maximum/);
    cfg = { ...cfg, signup: 'closed' };
    expect(() => store.signup({ name: 'x', email: 'z@acme.io' })).toThrow(/closed/);
  });

  it('builds example arguments and snippets from tool schemas', () => {
    expect(exampleArgs({ type: 'object', properties: { path: { type: 'string', description: 'File path' }, n: { type: 'integer', minimum: 3 }, mode: { enum: ['a', 'b'] }, opt: { type: 'boolean' } }, required: ['path', 'n', 'mode'] })).toEqual({ path: '/path/to/file', n: 3, mode: 'a' });
    expect(exampleArgs({ type: 'array', items: { type: 'number', default: 5 } })).toEqual([5]);
    const s = toolSnippets('https://gw.example', 'fs', 'read', { path: "it's" });
    expect(s.curl).toContain("https://gw.example/api/v1/tools/call");
    expect(s.curl).toContain("it'\\''s");
    expect(s.python).toContain('requests.post');
    expect(s.javascript).toContain('MCP_GATEWAY_KEY');
  });

  it('validates portal config', () => {
    expect(() => validateConfig({ servers: [], auth: { strategy: 'api-key', apiKeys: [{ key: 'k' }] }, portal: { enabled: true, signup: 'open' } })).not.toThrow();
    expect(() => validateConfig({ servers: [], portal: { enabled: true } })).toThrow(/auth.strategy: api-key/);
  });
});

describe('portal page', () => {
  it('is self-contained, CSP-hashable and bilingual', () => {
    const html = readFileSync(fileURLToPath(new URL('../dashboard/portal.html', import.meta.url)), 'utf8');
    expect(inlineScriptHashes(html)).toHaveLength(1);
    expect(html).not.toMatch(/\son[a-z]+="/); // no inline handlers (CSP)
    expect(html).not.toMatch(/<script src="https?:/);
    const keys = (l: string) => [...html.match(new RegExp(`${l}: \\{([^}]*)\\}`))![1]!.matchAll(/(?:^|[{,]\s*)(\w+):\s*'/g)].map((m) => m[1]).sort();
    const en = keys('en');
    const zh = keys('zh');
    expect(en.length).toBeGreaterThan(20);
    expect(zh).toEqual(en);
  });
});

describe('portal in the gateway', () => {
  let gw: Gateway | undefined;
  afterEach(async () => {
    await gw?.stop();
    gw = undefined;
  });

  it('signs up, approves, authenticates, meters and documents tools for a portal key', async () => {
    gw = new Gateway({
      port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: true },
      auth: { strategy: 'api-key', apiKeys: [{ name: 'ops', key: 'key-ops' }] },
      portal: { enabled: true, signup: 'approval', defaults: { servers: ['public'] }, title: 'Acme APIs' },
      servers: [
        { id: 'public', name: 'public', transport: 'stdio', command: process.execPath, args: [fixture] },
        { id: 'internal', name: 'internal', transport: 'stdio', command: process.execPath, args: [fixture] },
      ],
    } as GatewayConfig);
    await gw.start();
    const base = `http://127.0.0.1:${gw.address()!.port}`;
    const api = `${base}/api/v1`;
    const j = (r: Response) => r.json() as Promise<any>;
    expect((await j(await fetch(`${api}/portal/info`))).title).toBe('Acme APIs');
    const page = await fetch(`${base}/portal`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toMatch(/script-src 'sha256-/);

    const su = await fetch(`${api}/portal/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Bot', email: 'bot@example.com' }) });
    expect(su.status).toBe(201);
    const { id, key, status } = await j(su);
    expect(status).toBe('pending');
    const as = (k: string) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json' });
    // Pending keys do not authenticate.
    expect((await fetch(`${api}/portal/me`, { headers: as(key) })).status).toBe(401);
    const pending = await j(await fetch(`${api}/portal/keys?status=pending`, { headers: as('key-ops') }));
    expect(pending.keys.map((k: { id: string }) => k.id)).toEqual([id]);
    expect(JSON.stringify(pending)).not.toContain('hash');
    expect((await fetch(`${api}/portal/keys/${id}/approve`, { method: 'POST', headers: as('key-ops') })).status).toBe(200);

    // Scoped to "public".
    const call = (k: string, server: string) => fetch(`${api}/tools/call`, { method: 'POST', headers: as(k), body: JSON.stringify({ server, tool: 'echo', arguments: { a: 1 } }) });
    expect((await call(key, 'public')).status).toBe(200);
    expect((await call(key, 'internal')).status).toBe(403);
    const me = await j(await fetch(`${api}/portal/me`, { headers: as(key) }));
    expect(me.key).toMatchObject({ id, status: 'active', servers: ['public'] });
    expect(me.usage.calls).toBe(1); // the out-of-scope call is refused before it is metered
    expect(me.usage.byTool[0]).toMatchObject({ calls: 1 });
    const tools = await j(await fetch(`${api}/portal/tools`, { headers: as(key) }));
    expect(new Set(tools.tools.map((t: { server: string }) => t.server))).toEqual(new Set(['public']));
    expect(tools.tools[0].snippets.curl).toContain(`${base}/api/v1/tools/call`);
    // Operators are not portal keys.
    expect((await fetch(`${api}/portal/me`, { headers: as('key-ops') })).status).toBe(403);
    expect((await fetch(`${api}/portal/keys`, { headers: as(key) })).status).toBe(403);

    // Rotate: the old key stops working, the new one works.
    const rot = await j(await fetch(`${api}/portal/me/rotate`, { method: 'POST', headers: as(key) }));
    expect((await call(key, 'public')).status).toBe(401);
    expect((await call(rot.key, 'public')).status).toBe(200);
    expect((await fetch(`${api}/portal/me`, { method: 'DELETE', headers: as(rot.key) })).status).toBe(200);
    expect((await call(rot.key, 'public')).status).toBe(401);
  });
});
