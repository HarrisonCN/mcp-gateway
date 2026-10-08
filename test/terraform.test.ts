/** 7.1: Terraform resource API (restapi provider) and HCL export. */
import { describe, it, expect, afterEach } from 'vitest';
import { startFeatureGw, fakeServer, op, scoped, type FeatureGw } from './helpers/feature-gw.js';
import { exportHcl, toHcl } from '../src/features/terraform.js';

let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

describe('terraform (7.1)', () => {
  it('renders HCL values and a main.tf with import blocks and sensitive variables', () => {
    expect(toHcl({ a: 'x${y}', 'b-c': [1, true, null], 'd e': {} })).toBe('{\n  a = "x$${y}"\n  b-c = [\n    1,\n    true,\n    null,\n  ]\n  "d e" = {}\n}');
    const tf = exportHcl({
      servers: [{ id: 'gh', name: 'GitHub', transport: 'streamable-http', url: 'https://x', headers: { Authorization: 'Bearer s3cret' } }],
      tenants: [{ id: 'acme', servers: ['gh'] }],
      auth: { strategy: 'api-key', apiKeys: ['raw', { name: 'ci', key: 'k1', scope: { servers: ['gh'] } }] },
    }, 'https://cp:4000');
    expect(tf).toContain('source = "Mastercard/restapi"');
    expect(tf).toContain('default = "https://cp:4000"');
    expect(tf).toContain('resource "restapi_object" "server_gh" {');
    expect(tf).toContain('Authorization = var.server_gh_headers_Authorization');
    expect(tf).toContain('ignore_changes_to = ["headers"]');
    expect(tf).toContain('id = "/api/v1/admin/terraform/tenants/acme"');
    expect(tf).toContain('resource "restapi_object" "api_key_ci" {');
    expect(tf).toContain('key = var.api_key_ci_key');
    expect(tf).toMatch(/variable "api_key_ci_key" \{\n  type      = string\n  sensitive = true/);
    expect(tf).not.toContain('s3cret');
    expect(tf).not.toContain('k1');
    expect(tf).not.toContain('"raw"');
  });

  it('CRUD on servers, tenants and API keys hot-applies the config', async () => {
    h = await startFeatureGw({ controlPlane: { configApi: true }, auth: { strategy: 'api-key', apiKeys: ['op', { key: 'scoped', servers: ['fake'] }] } });
    const info = await h.admin('terraform');
    expect(info.body.writable).toBe(true);
    expect(info.body.kinds.map((k: { kind: string }) => k.kind)).toEqual(['servers', 'tenants', 'apiKeys']);
    expect((await h.admin('terraform/servers')).body.items.map((s: { id: string }) => s.id)).toEqual(['fake']);

    // create a server (dry run first)
    const { timeout, ...base } = fakeServer('two');
    const srv = { ...base, timeoutMs: timeout, env: { TOKEN: 'abc' } };
    const dry = await h.admin('terraform/servers?dryRun=true', srv);
    expect(dry.body.dryRun).toBe(true);
    expect(dry.body.changes.length).toBeGreaterThan(0);
    expect((await h.admin('terraform/servers')).body.items).toHaveLength(1);
    const created = await h.admin('terraform/servers', srv);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: 'two', env: { TOKEN: '<redacted>' } });
    expect(h.gw['config'].servers.map((s: { id: string }) => s.id)).toEqual(['fake', 'two']);
    expect((await h.admin('terraform/servers', srv)).status).toBe(409);
    expect((await h.admin('terraform/servers', { name: 'x' })).status).toBe(400);
    expect((await h.admin('terraform/servers', { id: 'bad', transport: 'nope' })).status).toBe(400);

    // read with ETag, replace keeping redacted secrets, stale If-Match → 412
    const r = await fetch(`${h.base}/api/v1/admin/terraform/servers/two`, { headers: op });
    const etag = r.headers.get('etag')!;
    const got = (await r.json()) as Record<string, unknown>;
    const upd = await h.admin('terraform/servers/two', { ...got, name: 'Two' }, 'PUT', { ...op, 'if-match': etag });
    expect(upd.status).toBe(200);
    expect(h.gw['config'].servers.find((s: { id: string }) => s.id === 'two')).toMatchObject({ name: 'Two', env: { TOKEN: 'abc' } });
    expect((await h.admin('terraform/servers/two', { ...got }, 'PUT', { ...op, 'if-match': etag })).status).toBe(412);
    expect((await h.admin('terraform/servers/two', { id: 'other' }, 'PUT')).status).toBe(400);
    expect((await h.admin('terraform/servers/nope', {}, 'PUT')).status).toBe(404);

    // tenants and API keys
    expect((await h.admin('terraform/tenants', { id: 'acme', servers: ['two'] })).status).toBe(201);
    expect((await h.admin('terraform/apiKeys', { name: 'ci', key: 'ci-key', scope: { servers: ['two'] } })).status).toBe(201);
    expect((await h.admin('terraform/apiKeys/ci')).body).toMatchObject({ name: 'ci', key: '<redacted>' });
    const viaKey = await fetch(`${h.base}/api/v1/tools`, { headers: { authorization: 'Bearer ci-key' } });
    expect(viaKey.status).toBe(200);

    // export reflects everything
    const tf = await fetch(`${h.base}/api/v1/admin/terraform/export?url=https://cp.example`, { headers: op });
    const text = await tf.text();
    expect(text).toContain('resource "restapi_object" "server_two"');
    expect(text).toContain('resource "restapi_object" "tenant_acme"');
    expect(text).toContain('resource "restapi_object" "api_key_ci"');
    expect(text).toContain('default = "https://cp.example"');
    expect(text).not.toContain('ci-key');
    const json = (await h.admin('terraform/export?format=json')).body;
    expect(json.apiKeys).toEqual([{ name: 'ci', key: '<redacted>', scope: { servers: ['two'] } }]);

    // deletes
    expect((await h.admin('terraform/tenants/acme', undefined, 'DELETE')).status).toBe(204);
    expect((await h.admin('terraform/apiKeys/ci', undefined, 'DELETE')).status).toBe(204);
    expect((await h.admin('terraform/servers/two', undefined, 'DELETE')).status).toBe(204);
    expect(h.gw['config'].tenants).toBeUndefined();
    expect((await h.admin('terraform/servers/two', undefined, 'DELETE')).status).toBe(404);
    expect((await h.admin('terraform/widgets')).status).toBe(404);
    expect((await h.admin('terraform/servers', undefined, 'GET', scoped)).status).toBe(403);
  });

  it('writes need controlPlane.configApi; API keys need api-key auth', async () => {
    h = await startFeatureGw();
    expect((await h.admin('terraform')).body.writable).toBe(false);
    expect((await h.admin('terraform/servers', fakeServer('x'))).status).toBe(403);
    expect((await h.admin('terraform/servers/fake', undefined, 'DELETE')).status).toBe(403);
    await h.stop();
    h = await startFeatureGw({ controlPlane: { configApi: true }, auth: { strategy: 'none' } });
    expect((await h.admin('terraform/apiKeys', { name: 'a', key: 'b' })).status).toBe(409);
  });
});
