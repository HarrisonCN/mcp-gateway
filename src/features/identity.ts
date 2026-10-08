/**
 * Enterprise SSO and SCIM (6.4).
 *
 * - **SCIM 2.0** (RFC 7643 / 7644): identity providers (Okta, Entra ID, OneLogin, Google …) provision users and
 *   groups into the gateway at `/api/v1/admin/identity/scim/v2` — `Users` and `Groups` with create, read, list (with
 *   `filter`, `startIndex`, `count`), replace (`PUT`), `PATCH` (add / replace / remove, including group members) and
 *   delete, plus `ServiceProviderConfig`, `ResourceTypes` and `Schemas`. Authenticate the IdP with an operator key.
 * - **Group → tenant roles:** `groupRoles` maps IdP group names to tenant memberships; a user's effective memberships
 *   combine SCIM group membership with the `groups` claim of their ID token. Deactivated users have none.
 * - **OIDC SSO:** `POST /admin/identity/sso/verify` verifies an ID token (issuer, audience, signature against the
 *   issuer's JWKS or an inline `jwks`) and returns the user and memberships; `GET /admin/identity/sso/authorize-url`
 *   builds an authorization-code + PKCE (S256) login URL.
 *
 * ```yaml
 * identity:
 *   oidc:
 *     issuer: https://acme.okta.com
 *     clientId: 0oa1example
 *     redirectUri: https://gateway.acme.com/sso/callback
 *     groupsClaim: groups
 *   groupRoles:
 *     - { group: Platform, tenant: platform, role: owner }
 *     - { group: Engineering, tenant: eng, role: admin }
 *   storePath: ./data/scim.json        # optional: persist the directory
 * ```
 *
 * @module features/identity
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import express, { type Request, type Response } from 'express';
import { registerFeature, objectBody, badRequest } from '../gateway/features.js';
import type { GatewayConfig } from '../utils/types.js';

const Role = z.enum(['viewer', 'admin', 'owner']);
export const IdentitySchema = z
  .object({
    oidc: z
      .object({
        issuer: z.string().url(),
        clientId: z.string().min(1),
        redirectUri: z.string().url().optional(),
        scopes: z.array(z.string()).default(['openid', 'email', 'profile', 'groups']),
        groupsClaim: z.string().default('groups'),
        jwksUrl: z.string().url().optional(),
        jwks: z.object({ keys: z.array(z.record(z.unknown())) }).optional(),
        authorizationEndpoint: z.string().url().optional(),
      })
      .strict()
      .optional(),
    groupRoles: z.array(z.object({ group: z.string().min(1), tenant: z.string().min(1), role: Role.default('viewer') }).strict()).default([]),
    storePath: z.string().optional(),
  })
  .strict();
export type IdentityConfig = z.input<typeof IdentitySchema>;
type Cfg = z.output<typeof IdentitySchema>;

const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const PATCHOP = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const ERR = 'urn:ietf:params:scim:api:messages:2.0:Error';

export interface ScimUser {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  name?: { givenName?: string; familyName?: string; formatted?: string };
  displayName?: string;
  emails?: Array<{ value: string; primary?: boolean; type?: string }>;
  active: boolean;
  meta: { resourceType: 'User'; created: string; lastModified: string; version: string };
}
export interface ScimGroup {
  schemas: string[];
  id: string;
  externalId?: string;
  displayName: string;
  members: Array<{ value: string; display?: string }>;
  meta: { resourceType: 'Group'; created: string; lastModified: string; version: string };
}

export class ScimError extends Error {
  constructor(readonly status: number, message: string, readonly scimType?: string) {
    super(message);
  }
}

/** Evaluate a SCIM filter subset: `attr op "value"` joined by `and` / `or`; ops eq, ne, co, sw, ew, pr. */
export function scimFilter(filter: string): (r: Record<string, unknown>) => boolean {
  const get = (r: Record<string, unknown>, path: string): unknown[] => {
    let cur: unknown[] = [r];
    for (const p of path.split('.')) cur = cur.flatMap((c) => (Array.isArray(c) ? c : [c])).map((c) => (c && typeof c === 'object' ? (c as Record<string, unknown>)[Object.keys(c as object).find((k) => k.toLowerCase() === p.toLowerCase()) ?? p] : undefined));
    return cur.flatMap((c) => (Array.isArray(c) ? c : [c])).filter((c) => c !== undefined);
  };
  const terms = filter.split(/\s+or\s+/i).map((alt) =>
    alt.split(/\s+and\s+/i).map((t) => {
      const m = /^\s*([\w.]+)\s+(eq|ne|co|sw|ew|pr)(?:\s+(?:"((?:[^"\\]|\\.)*)"|(true|false)))?\s*$/i.exec(t);
      if (!m) throw new ScimError(400, `unsupported filter: ${t}`, 'invalidFilter');
      const [, attr, op, s, b] = m;
      const want = b !== undefined ? b === 'true' : s;
      return (r: Record<string, unknown>) => {
        const vals = get(r, attr!.replace(/^emails$/i, 'emails.value'));
        const o = op!.toLowerCase();
        if (o === 'pr') return vals.length > 0;
        const norm = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v);
        const w = norm(want);
        const hit = vals.some((v) => {
          const x = norm(v);
          if (o === 'eq') return x === w;
          if (o === 'ne') return x !== w;
          if (typeof x !== 'string' || typeof w !== 'string') return false;
          return o === 'co' ? x.includes(w) : o === 'sw' ? x.startsWith(w) : x.endsWith(w);
        });
        return o === 'ne' ? vals.length === 0 || hit : hit;
      };
    }),
  );
  return (r) => terms.some((and) => and.every((t) => t(r)));
}

const now = () => new Date().toISOString();

/** In-memory SCIM directory with optional JSON persistence. */
export class ScimDirectory {
  users = new Map<string, ScimUser>();
  groups = new Map<string, ScimGroup>();
  constructor(private readonly storePath?: string) {
    if (storePath && existsSync(storePath)) {
      const d = JSON.parse(readFileSync(storePath, 'utf8')) as { users?: ScimUser[]; groups?: ScimGroup[] };
      for (const u of d.users ?? []) this.users.set(u.id, u);
      for (const g of d.groups ?? []) this.groups.set(g.id, g);
    }
  }
  private save(): void {
    if (!this.storePath) return;
    mkdirSync(dirname(this.storePath), { recursive: true });
    writeFileSync(this.storePath, JSON.stringify({ users: [...this.users.values()], groups: [...this.groups.values()] }, null, 2));
  }
  private meta<T extends 'User' | 'Group'>(resourceType: T, prev?: { created: string; version: string }) {
    const v = prev ? Number(prev.version.replace(/\D/g, '')) + 1 : 1;
    return { resourceType, created: prev?.created ?? now(), lastModified: now(), version: `W/"${v}"` };
  }
  private userFrom(b: Record<string, unknown>, id: string, prev?: ScimUser): ScimUser {
    if (typeof b.userName !== 'string' || !b.userName) throw new ScimError(400, 'userName is required', 'invalidValue');
    const clash = [...this.users.values()].find((u) => u.id !== id && u.userName.toLowerCase() === (b.userName as string).toLowerCase());
    if (clash) throw new ScimError(409, `userName ${b.userName} already exists`, 'uniqueness');
    return {
      schemas: [USER],
      id,
      ...(typeof b.externalId === 'string' ? { externalId: b.externalId } : {}),
      userName: b.userName,
      ...(b.name && typeof b.name === 'object' ? { name: b.name as ScimUser['name'] } : {}),
      ...(typeof b.displayName === 'string' ? { displayName: b.displayName } : {}),
      ...(Array.isArray(b.emails) ? { emails: b.emails as ScimUser['emails'] } : {}),
      active: b.active !== false,
      meta: this.meta('User', prev?.meta),
    };
  }
  private groupFrom(b: Record<string, unknown>, id: string, prev?: ScimGroup): ScimGroup {
    if (typeof b.displayName !== 'string' || !b.displayName) throw new ScimError(400, 'displayName is required', 'invalidValue');
    const members = Array.isArray(b.members) ? (b.members as Array<{ value?: unknown; display?: unknown }>).filter((m) => typeof m?.value === 'string').map((m) => ({ value: m.value as string, ...(typeof m.display === 'string' ? { display: m.display } : {}) })) : [];
    return { schemas: [GROUP], id, ...(typeof b.externalId === 'string' ? { externalId: b.externalId } : {}), displayName: b.displayName, members, meta: this.meta('Group', prev?.meta) };
  }
  createUser(b: Record<string, unknown>): ScimUser {
    const u = this.userFrom(b, randomUUID());
    this.users.set(u.id, u);
    this.save();
    return u;
  }
  replaceUser(id: string, b: Record<string, unknown>): ScimUser {
    const prev = this.mustUser(id);
    const u = this.userFrom(b, id, prev);
    this.users.set(id, u);
    this.save();
    return u;
  }
  mustUser(id: string): ScimUser {
    const u = this.users.get(id);
    if (!u) throw new ScimError(404, `User ${id} not found`);
    return u;
  }
  mustGroup(id: string): ScimGroup {
    const g = this.groups.get(id);
    if (!g) throw new ScimError(404, `Group ${id} not found`);
    return g;
  }
  deleteUser(id: string): void {
    this.mustUser(id);
    this.users.delete(id);
    for (const g of this.groups.values()) g.members = g.members.filter((m) => m.value !== id);
    this.save();
  }
  createGroup(b: Record<string, unknown>): ScimGroup {
    const g = this.groupFrom(b, randomUUID());
    this.groups.set(g.id, g);
    this.save();
    return g;
  }
  replaceGroup(id: string, b: Record<string, unknown>): ScimGroup {
    const g = this.groupFrom(b, id, this.mustGroup(id));
    this.groups.set(id, g);
    this.save();
    return g;
  }
  deleteGroup(id: string): void {
    this.mustGroup(id);
    this.groups.delete(id);
    this.save();
  }
  /** RFC 7644 §3.5.2 PATCH (the subset IdPs send). */
  patch(kind: 'User' | 'Group', id: string, body: Record<string, unknown>): ScimUser | ScimGroup {
    if (!Array.isArray(body.schemas) || !body.schemas.includes(PATCHOP) || !Array.isArray(body.Operations)) throw new ScimError(400, 'PatchOp body required', 'invalidSyntax');
    const cur = structuredClone(kind === 'User' ? this.mustUser(id) : this.mustGroup(id)) as unknown as Record<string, unknown>;
    for (const raw of body.Operations as Array<Record<string, unknown>>) {
      const op = String(raw.op ?? '').toLowerCase();
      const path = typeof raw.path === 'string' ? raw.path : undefined;
      const value = raw.value;
      if (!['add', 'replace', 'remove'].includes(op)) throw new ScimError(400, `bad op ${String(raw.op)}`, 'invalidSyntax');
      const memberFilter = path && /^members\[value eq "([^"]+)"\]$/i.exec(path);
      if (kind === 'Group' && (path?.toLowerCase() === 'members' || memberFilter)) {
        const members = cur.members as ScimGroup['members'];
        if (op === 'remove') {
          const drop = memberFilter ? [memberFilter[1]] : Array.isArray(value) ? (value as Array<{ value: string }>).map((v) => v.value) : members.map((m) => m.value);
          cur.members = members.filter((m) => !drop.includes(m.value));
        } else {
          const add = (Array.isArray(value) ? value : [value]) as Array<{ value: string; display?: string }>;
          cur.members = op === 'replace' ? add : [...members, ...add.filter((a) => !members.some((m) => m.value === a.value))];
        }
        continue;
      }
      if (op === 'remove') {
        if (!path) throw new ScimError(400, 'remove needs a path', 'noTarget');
        delete cur[path];
      } else if (path) {
        const [a, b] = path.split('.');
        if (b) cur[a!] = { ...((cur[a!] as object) ?? {}), [b]: value };
        else cur[path] = value;
      } else if (value && typeof value === 'object') Object.assign(cur, value);
    }
    return kind === 'User' ? this.replaceUser(id, cur) : this.replaceGroup(id, cur);
  }
  groupsOf(userId: string): ScimGroup[] {
    return [...this.groups.values()].filter((g) => g.members.some((m) => m.value === userId));
  }
  findUser(login: string): ScimUser | undefined {
    const l = login.toLowerCase();
    return [...this.users.values()].find((u) => u.userName.toLowerCase() === l || u.emails?.some((e) => e.value.toLowerCase() === l));
  }
}

const RANK = { viewer: 1, admin: 2, owner: 3 } as const;

/** Effective tenant memberships for group names (highest role per tenant). */
export function resolveMemberships(groups: readonly string[], cfg: Cfg): Array<{ tenant: string; role: 'viewer' | 'admin' | 'owner'; via: string }> {
  const out = new Map<string, { tenant: string; role: 'viewer' | 'admin' | 'owner'; via: string }>();
  const lower = new Set(groups.map((g) => g.toLowerCase()));
  for (const r of cfg.groupRoles) {
    if (!lower.has(r.group.toLowerCase())) continue;
    const prev = out.get(r.tenant);
    if (!prev || RANK[r.role] > RANK[prev.role]) out.set(r.tenant, { tenant: r.tenant, role: r.role, via: r.group });
  }
  return [...out.values()];
}

const jwksCache = new Map<string, JWTVerifyGetKey>();
/** Verify an OIDC ID token; returns its claims. */
export async function verifyIdToken(token: string, oidc: NonNullable<Cfg['oidc']>): Promise<Record<string, unknown>> {
  let keys: JWTVerifyGetKey;
  if (oidc.jwks) keys = createLocalJWKSet(oidc.jwks as never);
  else {
    const url = oidc.jwksUrl ?? `${oidc.issuer.replace(/\/+$/, '')}/.well-known/jwks.json`;
    keys = jwksCache.get(url) ?? createRemoteJWKSet(new URL(url));
    jwksCache.set(url, keys);
  }
  const { payload } = await jwtVerify(token, keys, { issuer: oidc.issuer, audience: oidc.clientId });
  return payload as Record<string, unknown>;
}

/** Authorization-code + PKCE login URL. */
export function authorizeUrl(oidc: NonNullable<Cfg['oidc']>, opts: { state?: string; verifier?: string } = {}): { url: string; state: string; codeVerifier: string } {
  const codeVerifier = opts.verifier ?? randomBytes(32).toString('base64url');
  const state = opts.state ?? randomBytes(16).toString('base64url');
  const u = new URL(oidc.authorizationEndpoint ?? `${oidc.issuer.replace(/\/+$/, '')}/authorize`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', oidc.clientId);
  if (oidc.redirectUri) u.searchParams.set('redirect_uri', oidc.redirectUri);
  u.searchParams.set('scope', oidc.scopes.join(' '));
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', createHash('sha256').update(codeVerifier).digest('base64url'));
  u.searchParams.set('code_challenge_method', 'S256');
  return { url: u.toString(), state, codeVerifier };
}

const settings = (cfg: GatewayConfig): Cfg => IdentitySchema.parse(cfg.identity ?? {});
const directories = new Map<string, ScimDirectory>();
const directoryFor = (cfg: Cfg): ScimDirectory => {
  const k = cfg.storePath ?? '';
  let d = directories.get(k);
  if (!d) directories.set(k, (d = new ScimDirectory(cfg.storePath)));
  return d;
};

registerFeature({
  id: 'identity',
  since: '6.4.0',
  summary: 'Enterprise SSO (OIDC ID tokens) and SCIM 2.0 user / group provisioning mapped to tenant roles',
  mount: (router, ctx) => {
    router.use(express.json({ type: ['application/scim+json'], limit: '1mb' }));
    let own: ScimDirectory | undefined; // per-gateway directory when not persisted
    const dir = () => {
      const c = settings(ctx.config());
      if (c.storePath) return directoryFor(c);
      return (own ??= new ScimDirectory());
    };
    const scim = (res: Response, fn: () => unknown, status = 200) => {
      try {
        const out = fn();
        res.status(status).type('application/scim+json');
        if (out === undefined) return void res.status(204).end();
        res.send(JSON.stringify(out));
      } catch (e) {
        if (!(e instanceof ScimError)) throw e;
        res.status(e.status).type('application/scim+json').send(JSON.stringify({ schemas: [ERR], status: String(e.status), detail: e.message, ...(e.scimType ? { scimType: e.scimType } : {}) }));
      }
    };
    const body = (req: Request) => {
      const b = req.body as unknown;
      if (!b || typeof b !== 'object' || Array.isArray(b)) throw new ScimError(400, 'JSON object body required', 'invalidSyntax');
      return b as Record<string, unknown>;
    };
    const list = (req: Request, all: Array<ScimUser | ScimGroup>) => {
      const f = typeof req.query.filter === 'string' && req.query.filter ? scimFilter(req.query.filter) : () => true;
      const hits = all.filter((r) => f(r as unknown as Record<string, unknown>));
      const start = Math.max(1, Number(req.query.startIndex) || 1);
      const count = Math.min(Math.max(0, req.query.count === undefined ? 100 : Number(req.query.count) || 0), 1000);
      const page = hits.slice(start - 1, start - 1 + count);
      return { schemas: [LIST], totalResults: hits.length, startIndex: start, itemsPerPage: page.length, Resources: page };
    };
    const S = '/scim/v2';
    router.get(`${S}/ServiceProviderConfig`, (_req, res) =>
      scim(res, () => ({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'], patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 }, filter: { supported: true, maxResults: 1000 }, changePassword: { supported: false }, sort: { supported: false }, etag: { supported: true }, authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'Operator API key' }] })),
    );
    router.get(`${S}/ResourceTypes`, (_req, res) =>
      scim(res, () => ({ schemas: [LIST], totalResults: 2, Resources: [{ id: 'User', name: 'User', endpoint: '/Users', schema: USER }, { id: 'Group', name: 'Group', endpoint: '/Groups', schema: GROUP }] })),
    );
    router.get(`${S}/Schemas`, (_req, res) => scim(res, () => ({ schemas: [LIST], totalResults: 2, Resources: [{ id: USER, name: 'User' }, { id: GROUP, name: 'Group' }] })));
    router.get(`${S}/Users`, (req, res) => scim(res, () => list(req, [...dir().users.values()])));
    router.post(`${S}/Users`, (req, res) => scim(res, () => dir().createUser(body(req)), 201));
    router.get(`${S}/Users/:id`, (req, res) => scim(res, () => dir().mustUser(req.params.id)));
    router.put(`${S}/Users/:id`, (req, res) => scim(res, () => dir().replaceUser(req.params.id, body(req))));
    router.patch(`${S}/Users/:id`, (req, res) => scim(res, () => dir().patch('User', req.params.id, body(req))));
    router.delete(`${S}/Users/:id`, (req, res) => scim(res, () => void dir().deleteUser(req.params.id)));
    router.get(`${S}/Groups`, (req, res) => scim(res, () => list(req, [...dir().groups.values()])));
    router.post(`${S}/Groups`, (req, res) => scim(res, () => dir().createGroup(body(req)), 201));
    router.get(`${S}/Groups/:id`, (req, res) => scim(res, () => dir().mustGroup(req.params.id)));
    router.put(`${S}/Groups/:id`, (req, res) => scim(res, () => dir().replaceGroup(req.params.id, body(req))));
    router.patch(`${S}/Groups/:id`, (req, res) => scim(res, () => dir().patch('Group', req.params.id, body(req))));
    router.delete(`${S}/Groups/:id`, (req, res) => scim(res, () => void dir().deleteGroup(req.params.id)));

    router.get('/', (_req, res) => {
      const c = settings(ctx.config());
      const d = dir();
      res.json({ oidc: c.oidc ? { issuer: c.oidc.issuer, clientId: c.oidc.clientId, groupsClaim: c.oidc.groupsClaim } : null, groupRoles: c.groupRoles, users: d.users.size, activeUsers: [...d.users.values()].filter((u) => u.active).length, groups: d.groups.size, scimBase: '/api/v1/admin/identity/scim/v2' });
    });
    router.get('/memberships', (req, res) => {
      const login = String(req.query.user ?? '');
      const u = dir().findUser(login);
      if (!u) return void res.status(404).json({ error: 'Not Found', message: `no SCIM user "${login}"` });
      const groups = dir().groupsOf(u.id).map((g) => g.displayName);
      res.json({ user: u.userName, active: u.active, groups, memberships: u.active ? resolveMemberships(groups, settings(ctx.config())) : [] });
    });
    router.get('/sso/authorize-url', (_req, res) => {
      const c = settings(ctx.config());
      if (!c.oidc) return void res.status(404).json({ error: 'Not Found', message: 'identity.oidc is not configured' });
      res.json(authorizeUrl(c.oidc));
    });
    router.post('/sso/verify', async (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      const c = settings(ctx.config());
      if (!c.oidc) return void res.status(404).json({ error: 'Not Found', message: 'identity.oidc is not configured' });
      if (typeof b.idToken !== 'string') return badRequest(res, '"idToken" is required');
      let claims: Record<string, unknown>;
      try {
        claims = await verifyIdToken(b.idToken, c.oidc);
      } catch (e) {
        return void res.status(401).json({ error: 'Unauthorized', message: `invalid ID token: ${(e as Error).message}` });
      }
      const login = String(claims.email ?? claims.preferred_username ?? claims.sub ?? '');
      const u = dir().findUser(login);
      if (u && !u.active) return void res.status(403).json({ error: 'Forbidden', message: `user ${login} is deactivated` });
      const claimGroups = Array.isArray(claims[c.oidc.groupsClaim]) ? (claims[c.oidc.groupsClaim] as unknown[]).map(String) : [];
      const groups = [...new Set([...claimGroups, ...(u ? dir().groupsOf(u.id).map((g) => g.displayName) : [])])];
      res.json({ subject: claims.sub, user: login, provisioned: !!u, groups, memberships: resolveMemberships(groups, c), clientId: `sso:${login}` });
    });
  },
});
