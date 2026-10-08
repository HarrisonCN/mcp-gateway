import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { IdentitySchema, ScimDirectory, scimFilter, resolveMemberships, verifyIdToken, authorizeUrl } from '../src/features/identity.js';
import { validateConfig } from '../src/config/loader.js';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';

const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

async function keys() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
  const sign = (claims: Record<string, unknown>, o: { iss?: string; aud?: string } = {}) =>
    new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(o.iss ?? 'https://idp.example').setAudience(o.aud ?? 'gw').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  return { jwks: { keys: [jwk] }, sign };
}

describe('enterprise SSO and SCIM (6.4)', () => {
  it('evaluates SCIM filters', () => {
    const u = { userName: 'Ada@Acme.com', active: true, emails: [{ value: 'ada@acme.com' }], name: { familyName: 'Lovelace' } };
    expect(scimFilter('userName eq "ada@acme.com"')(u)).toBe(true);
    expect(scimFilter('emails.value co "acme"')(u)).toBe(true);
    expect(scimFilter('emails co "acme"')(u)).toBe(true);
    expect(scimFilter('name.familyName sw "Love" and active eq true')(u)).toBe(true);
    expect(scimFilter('userName eq "x" or name.familyName ew "lace"')(u)).toBe(true);
    expect(scimFilter('title pr')(u)).toBe(false);
    expect(scimFilter('userName ne "x"')(u)).toBe(true);
    expect(() => scimFilter('userName gt 3')).toThrow(/unsupported filter/);
  });

  it('directory: users, groups, PATCH, uniqueness, persistence', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'scim-')), 'd.json');
    const d = new ScimDirectory(path);
    const ada = d.createUser({ userName: 'ada@acme.com', emails: [{ value: 'ada@acme.com', primary: true }] });
    expect(ada.active).toBe(true);
    expect(() => d.createUser({ userName: 'ADA@acme.com' })).toThrow(/already exists/);
    expect(() => d.createUser({})).toThrow(/userName is required/);
    const g = d.createGroup({ displayName: 'Engineering', members: [{ value: ada.id }] });
    const bob = d.createUser({ userName: 'bob' });
    d.patch('Group', g.id, { schemas: [PATCH], Operations: [{ op: 'add', path: 'members', value: [{ value: bob.id }, { value: ada.id }] }] });
    expect(d.mustGroup(g.id).members.map((m) => m.value)).toEqual([ada.id, bob.id]);
    d.patch('Group', g.id, { schemas: [PATCH], Operations: [{ op: 'remove', path: `members[value eq "${ada.id}"]` }] });
    expect(d.groupsOf(ada.id)).toEqual([]);
    const off = d.patch('User', bob.id, { schemas: [PATCH], Operations: [{ op: 'replace', value: { active: false } }, { op: 'replace', path: 'name.givenName', value: 'Bob' }] }) as any;
    expect(off.active).toBe(false);
    expect(off.name.givenName).toBe('Bob');
    expect(off.meta.version).toBe('W/"2"');
    expect(() => d.patch('User', bob.id, { Operations: [] })).toThrow(/PatchOp/);
    expect(() => d.patch('User', bob.id, { schemas: [PATCH], Operations: [{ op: 'move' }] })).toThrow(/bad op/);
    d.deleteUser(bob.id);
    expect(d.mustGroup(g.id).members).toEqual([]);
    const again = new ScimDirectory(path);
    expect(again.findUser('ADA@ACME.COM')?.id).toBe(ada.id);
    expect(again.groups.size).toBe(1);
    expect(() => again.mustUser('nope')).toThrow(/not found/);
  });

  it('maps groups to tenant roles (highest wins) and verifies ID tokens', async () => {
    const cfg = IdentitySchema.parse({ groupRoles: [{ group: 'Eng', tenant: 'eng', role: 'admin' }, { group: 'Platform', tenant: 'eng', role: 'owner' }, { group: 'Sales', tenant: 'crm' }] });
    expect(resolveMemberships(['eng', 'Platform'], cfg)).toEqual([{ tenant: 'eng', role: 'owner', via: 'Platform' }]);
    expect(resolveMemberships(['Sales'], cfg)).toEqual([{ tenant: 'crm', role: 'viewer', via: 'Sales' }]);
    const k = await keys();
    const oidc = IdentitySchema.parse({ oidc: { issuer: 'https://idp.example', clientId: 'gw', jwks: k.jwks } }).oidc!;
    expect((await verifyIdToken(await k.sign({ sub: 'u1', email: 'a@b.c' }), oidc)).email).toBe('a@b.c');
    await expect(verifyIdToken(await k.sign({ sub: 'u1' }, { aud: 'other' }), oidc)).rejects.toThrow();
    await expect(verifyIdToken(await k.sign({ sub: 'u1' }, { iss: 'https://evil' }), oidc)).rejects.toThrow();
    const a = authorizeUrl({ ...oidc, redirectUri: 'https://gw/cb' }, { state: 's', verifier: 'v'.repeat(43) });
    const u = new URL(a.url);
    expect(u.origin + u.pathname).toBe('https://idp.example/authorize');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ response_type: 'code', client_id: 'gw', redirect_uri: 'https://gw/cb', state: 's', code_challenge_method: 'S256', scope: 'openid email profile groups' });
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(() => validateConfig({ servers: [], identity: { groupRoles: [{ group: 'x', tenant: 't', role: 'god' }] } })).toThrow();
  });

  it('SCIM REST surface and SSO verify through the gateway', async () => {
    const k = await keys();
    h = await startFeatureGw({ identity: { oidc: { issuer: 'https://idp.example', clientId: 'gw', jwks: k.jwks }, groupRoles: [{ group: 'Engineering', tenant: 'eng', role: 'admin' }] } } as never);
    const scim = { authorization: 'Bearer op', 'content-type': 'application/scim+json' };
    const cu = await h.admin('identity/scim/v2/Users', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'ada@acme.com', emails: [{ value: 'ada@acme.com' }] }, 'POST', scim);
    expect(cu.status).toBe(201);
    expect((await h.admin('identity/scim/v2/Users', { userName: 'ada@acme.com' }, 'POST', scim)).body.scimType).toBe('uniqueness');
    const cg = await h.admin('identity/scim/v2/Groups', { displayName: 'Engineering', members: [{ value: cu.body.id }] }, 'POST', scim);
    expect(cg.status).toBe(201);
    const l = await h.admin(`identity/scim/v2/Users?filter=${encodeURIComponent('userName eq "ada@acme.com"')}&count=10`);
    expect(l.body).toMatchObject({ totalResults: 1, startIndex: 1, itemsPerPage: 1 });
    expect((await h.admin('identity/scim/v2/Users?filter=bad')).status).toBe(400);
    expect((await h.admin('identity/scim/v2/ServiceProviderConfig')).body.patch.supported).toBe(true);
    expect((await h.admin('identity/scim/v2/ResourceTypes')).body.totalResults).toBe(2);
    expect((await h.admin('identity/scim/v2/Schemas')).body.totalResults).toBe(2);
    expect((await h.admin('identity/scim/v2/Groups')).body.Resources[0].members).toHaveLength(1);
    expect((await h.admin(`identity/scim/v2/Groups/${cg.body.id}`)).body.displayName).toBe('Engineering');
    expect((await h.admin('identity/memberships?user=ada@acme.com')).body.memberships).toEqual([{ tenant: 'eng', role: 'admin', via: 'Engineering' }]);
    expect((await h.admin('identity/memberships?user=nobody')).status).toBe(404);
    const ok = await h.admin('identity/sso/verify', { idToken: await k.sign({ sub: 'x1', email: 'ada@acme.com', groups: ['Other'] }) });
    expect(ok.body).toMatchObject({ user: 'ada@acme.com', provisioned: true, groups: ['Other', 'Engineering'], memberships: [{ tenant: 'eng', role: 'admin' }], clientId: 'sso:ada@acme.com' });
    expect((await h.admin('identity/sso/verify', { idToken: 'nope' })).status).toBe(401);
    expect((await h.admin('identity/sso/verify', {})).status).toBe(400);
    expect((await h.admin('identity/sso/authorize-url')).body.url).toMatch(/code_challenge=/);
    const pu = await h.admin(`identity/scim/v2/Users/${cu.body.id}`, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'active', value: false }] }, 'PATCH', scim);
    expect(pu.body.active).toBe(false);
    expect((await h.admin('identity/sso/verify', { idToken: await k.sign({ sub: 'x1', email: 'ada@acme.com' }) })).status).toBe(403);
    expect((await h.admin('identity/memberships?user=ada@acme.com')).body.memberships).toEqual([]);
    expect((await h.admin(`identity/scim/v2/Users/${cu.body.id}`, { userName: 'ada2@acme.com' }, 'PUT', scim)).body.userName).toBe('ada2@acme.com');
    expect((await h.admin(`identity/scim/v2/Groups/${cg.body.id}`, { displayName: 'Eng2' }, 'PUT', scim)).body.members).toEqual([]);
    expect((await h.admin(`identity/scim/v2/Groups/${cg.body.id}`, { schemas: [PATCH], Operations: [{ op: 'add', path: 'members', value: [{ value: cu.body.id }] }] }, 'PATCH', scim)).body.members).toHaveLength(1);
    expect((await h.admin(`identity/scim/v2/Users/${cu.body.id}`, undefined, 'DELETE')).status).toBe(204);
    expect((await h.admin(`identity/scim/v2/Users/${cu.body.id}`)).status).toBe(404);
    expect((await h.admin(`identity/scim/v2/Groups/${cg.body.id}`, undefined, 'DELETE')).status).toBe(204);
    expect((await h.admin('identity/scim/v2/Users', '[]', 'POST', scim)).status).toBe(400);
    const st = await h.admin('identity');
    expect(st.body).toMatchObject({ users: 0, groups: 0, scimBase: '/api/v1/admin/identity/scim/v2' });
    expect((await h.admin('identity/scim/v2/Users', undefined, 'GET', { authorization: 'Bearer scoped' })).status).toBe(403);
  });

  it('404s SSO endpoints without oidc', async () => {
    h = await startFeatureGw({});
    expect((await h.admin('identity/sso/authorize-url')).status).toBe(404);
    expect((await h.admin('identity/sso/verify', { idToken: 'x' })).status).toBe(404);
    expect((await h.admin('identity')).body.oidc).toBeNull();
  });
});
