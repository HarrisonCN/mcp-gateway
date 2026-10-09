/** 10.1 security baseline: regression tests for the issues found in the spawn / auth / tenant / mTLS audit. */
import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { childEnv, StdioChannel } from '../src/transport/stdio.js';
import { memberGrantError } from '../src/auth/tenants.js';
import { MtlsManager, spiffeIdsOf, splitSan } from '../src/security/mtls.js';
import { resourceWarning } from '../src/auth/oauth.js';
import { Gateway } from '../src/gateway/index.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));

describe('stdio upstream environment (env leakage)', () => {
  it('drops the gateway MCP_GATEWAY_* secrets (12.0: allowlist) and keeps explicit env', () => {
    const env = childEnv({ PATH: '/bin', HOME: '/h', MCP_GATEWAY_ADMIN_KEY: 'adm', MCP_GATEWAY_API_KEYS: 'k1,k2', mcp_gateway_key: 'x', OTHER: 'o' }, { FOO: 'bar', MCP_GATEWAY_URL: 'http://gw' }, [], 'linux');
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', FOO: 'bar', MCP_GATEWAY_URL: 'http://gw' });
  });

  it('a spawned upstream server does not see the admin key', async () => {
    process.env.MCP_GATEWAY_ADMIN_KEY = 'super-secret-admin';
    process.env.MGW_TEST_VISIBLE = 'yes';
    try {
      const script = 'process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"env",params:{admin:process.env.MCP_GATEWAY_ADMIN_KEY??null,visible:process.env.MGW_TEST_VISIBLE??null,arg:process.argv[1]??null}})+"\\n");setTimeout(()=>{},2000)';
      const ch = new StdioChannel({ id: 'envprobe', name: 'envprobe', transport: 'stdio', command: process.execPath, args: ['-e', script, '$(touch /tmp/mgw-pwned); `id`'] } as never, { killGraceMs: 200 } as never);
      const got = new Promise<Record<string, unknown>>((r) => (ch.onmessage = (m) => r((m as { params: Record<string, unknown> }).params)));
      await ch.start();
      const params = await got;
      await ch.close();
      expect(params.admin).toBeNull();
      expect(params.visible).toBeNull(); // 12.0: not on the allowlist
      // Arguments reach the child verbatim (no shell interpretation).
      expect(params.arg).toBe('$(touch /tmp/mgw-pwned); `id`');
    } finally {
      delete process.env.MCP_GATEWAY_ADMIN_KEY;
      delete process.env.MGW_TEST_VISIBLE;
    }
  });
});

describe('tenant member management (privilege escalation / isolation)', () => {
  it('owners must name exact, non-operator client ids', () => {
    expect(memberGrantError('key:*', false)).toMatch(/glob/);
    expect(memberGrantError('*', false)).toMatch(/glob/);
    expect(memberGrantError('jwt:user-?', false)).toMatch(/glob/);
    expect(memberGrantError('key:ops', true)).toMatch(/operator/);
    expect(memberGrantError('key:dave', false)).toBeUndefined();
  });

  let gw: Gateway | undefined;
  afterEach(async () => {
    await gw?.stop();
    gw = undefined;
  });

  it('a tenant owner cannot enrol operators or everyone; operators still can', async () => {
    const srv = (id: string) => ({ id, name: id, transport: 'stdio' as const, command: process.execPath, args: [fixture], timeout: 5000 });
    gw = new Gateway({
      port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false },
      auth: { strategy: 'api-key', apiKeys: [{ key: 'k-ops', name: 'ops' }, { key: 'k-alice', name: 'alice' }, { key: 'k-eve', name: 'eve' }] },
      servers: [srv('acme-db'), srv('labs')],
      tenants: [
        { id: 'acme', servers: ['acme-*'], members: [{ client: 'key:alice', role: 'owner' }] },
        { id: 'labs', servers: ['labs'], members: [{ client: 'key:eve', role: 'owner' }] },
      ],
    });
    await gw.start();
    const url = `http://127.0.0.1:${gw.address()!.port}`;
    const H = (k: string) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json' });
    const put = (k: string, body: unknown) => fetch(`${url}/api/v1/tenants/acme/members`, { method: 'PUT', headers: H(k), body: JSON.stringify(body) });

    expect((await put('k-alice', { client: '*', role: 'viewer' })).status).toBe(403);
    expect((await put('k-alice', { client: 'key:*', role: 'owner' })).status).toBe(403);
    expect((await put('k-alice', { client: 'key:ops', role: 'viewer' })).status).toBe(403);
    // The operator kept full access (was not confined to acme).
    const tools = (await (await fetch(`${url}/api/v1/tools`, { headers: H('k-ops') })).json()) as { tools: Array<{ serverId: string }> };
    expect([...new Set(tools.tools.map((t) => t.serverId))].sort()).toEqual(['acme-db', 'labs']);
    expect(((await (await fetch(`${url}/api/v1/tenants`, { headers: H('k-ops') })).json()) as { operator: boolean }).operator).toBe(true);
    // Exact ids of non-operators (another tenant's member, or an unknown client) are fine.
    expect((await put('k-alice', { client: 'key:eve', role: 'viewer' })).status).toBe(200);
    expect((await put('k-alice', { client: 'key:dave', role: 'viewer' })).status).toBe(200);
    // Operators keep glob support.
    expect((await put('k-ops', { client: 'key:team-*', role: 'viewer' })).status).toBe(200);
  });
});

describe('mTLS (SPIFFE SAN parsing, fail-closed)', () => {
  it('a quoted SAN value cannot smuggle a second SPIFFE ID', () => {
    const forged = 'DNS:x.example, URI:"spiffe://evil.org/a, URI:spiffe://example.org/ns/tools/sa/search"';
    expect(splitSan(forged)).toEqual(['DNS:x.example', 'URI:"spiffe://evil.org/a, URI:spiffe://example.org/ns/tools/sa/search"']);
    expect(spiffeIdsOf({ subjectaltname: forged })).toEqual([]);
    expect(spiffeIdsOf({ subjectaltname: 'URI:spiffe://a.org/x, URI:spiffe://b.org/y' })).toEqual(['spiffe://a.org/x', 'spiffe://b.org/y']);
    expect(splitSan('')).toEqual([]);
  });

  it('refuses to connect when the configured identity cannot be loaded', async () => {
    const m = new MtlsManager(() => ({ identity: { cert: '/nonexistent/cert.pem', key: '/nonexistent/key.pem', bundle: '/nonexistent/ca.pem' }, reloadIntervalSeconds: 0 }));
    m.start();
    const server = { id: 'search', url: 'https://127.0.0.1:1/mcp', tls: { spiffeId: 'spiffe://example.org/ns/tools/*' } };
    expect(m.applies(server)).toBe(true);
    await expect(m.fetchFor(server)(server.url)).rejects.toThrow(/mTLS identity is not loaded/);
    m.stop();
  });
});

describe('OAuth resource / audience', () => {
  it('warns when the audience would be derived from the Host header', () => {
    expect(resourceWarning({ authorizationServers: ['https://as'] } as never)).toMatch(/Host header/);
    expect(resourceWarning({ authorizationServers: ['https://as'], resource: 'https://gw/mcp' } as never)).toBeUndefined();
    expect(resourceWarning({ authorizationServers: ['https://as'], audience: 'api://gw' } as never)).toBeUndefined();
  });
});
