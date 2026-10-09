/**
 * OAuth 2.1 resource-server support, following the MCP authorization spec
 * (2025-06-18): the gateway is an OAuth *protected resource*.
 *
 *  - `GET /.well-known/oauth-protected-resource[/<mcp path>]` serves RFC 9728
 *    Protected Resource Metadata (resource, authorization_servers,
 *    scopes_supported, bearer_methods_supported).
 *  - Bearer access tokens are validated either as JWTs against the
 *    authorization server's JWKS (configured `jwksUrl`, or the `jwks_uri`
 *    discovered from RFC 8414 / OpenID metadata of the issuer) or through
 *    RFC 7662 token introspection (opaque tokens). Introspection results are
 *    cached until the token expires (at most `cacheSeconds`).
 *  - The token must be issued for this resource (`aud` contains the resource
 *    URI, RFC 8707) and by one of the configured authorization servers.
 *  - Failures answer with RFC 6750 `WWW-Authenticate` challenges that point
 *    clients at the metadata document: `401` + `error="invalid_token"` for a
 *    missing / invalid token, `403` + `error="insufficient_scope"` when
 *    `requiredScopes` are missing.
 *
 * @module auth/oauth
 */

import { createHash } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { OAuthConfig } from '../utils/types.js';
import { logger } from '../utils/logger.js';
import { scopeFromJwt } from './scopes.js';
import type { AuthedRequest, AuthMiddleware } from './middleware.js';
import { ASYMMETRIC_ALGORITHMS } from './middleware.js';

export const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

export interface TokenInfo {
  subject?: string;
  clientId?: string;
  scopes: string[];
  claims: Record<string, unknown>;
  /** Expiry (epoch seconds) when known. */
  exp?: number;
}

export class TokenError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_token' | 'insufficient_scope' = 'invalid_token',
  ) {
    super(message);
  }
}

const asList = (v: string | string[] | undefined): string[] | undefined =>
  v === undefined ? undefined : Array.isArray(v) ? v : [v];

function assertSecureUrl(raw: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${field} is not a valid URL: ${raw}`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(`${field} must use https:// (http:// is only allowed for localhost)`);
  }
  return url;
}

/** RFC 8414 §3 well-known URLs for an issuer (path-inserted form first, then OpenID Connect). */
export function metadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/$/, '');
  const origin = u.origin;
  const urls = [`${origin}/.well-known/oauth-authorization-server${path}`];
  urls.push(path ? `${origin}${path}/.well-known/openid-configuration` : `${origin}/.well-known/openid-configuration`);
  if (path) urls.push(`${origin}/.well-known/openid-configuration${path}`);
  return urls;
}

/** Space-separated `scope` claim (or `scp` array) of a token. */
export function tokenScopes(claims: Record<string, unknown>): string[] {
  const s = claims.scope ?? claims.scp;
  if (typeof s === 'string') return s.split(/\s+/).filter(Boolean);
  if (Array.isArray(s)) return s.filter((x): x is string => typeof x === 'string');
  return [];
}

/** Escape a value for a quoted-string in a WWW-Authenticate header. */
const quote = (v: string) => `"${v.replace(/["\\]/g, '\\$&')}"`;

export interface OAuthVerifierOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

/** Validates bearer tokens for one protected resource. */
export class OAuthVerifier {
  private jwks?: JWTVerifyGetKey;
  private jwksPromise?: Promise<JWTVerifyGetKey | undefined>;
  private readonly introspectionCache = new Map<string, { info: TokenInfo; until: number }>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(
    readonly config: OAuthConfig,
    options: OAuthVerifierOptions = {},
  ) {
    if (!config.authorizationServers?.length) throw new Error('auth.oauth.authorizationServers must list at least one issuer');
    for (const as of config.authorizationServers) assertSecureUrl(as, 'auth.oauth.authorizationServers');
    if (config.jwksUrl) assertSecureUrl(config.jwksUrl, 'auth.oauth.jwksUrl');
    if (config.introspection) assertSecureUrl(config.introspection.url, 'auth.oauth.introspection.url');
    if (config.resource) assertSecureUrl(config.resource, 'auth.oauth.resource');
    const bad = (config.algorithms ?? []).filter((a) => !ASYMMETRIC_ALGORITHMS.includes(a));
    if (bad.length) throw new Error(`auth.oauth.algorithms: ${bad.join(', ')} not allowed (asymmetric algorithms only)`);
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    if (config.jwksUrl) this.jwks = this.remoteJwks(new URL(config.jwksUrl));
  }

  private remoteJwks(url: URL): JWTVerifyGetKey {
    return createRemoteJWKSet(url, {
      cacheMaxAge: (this.config.jwksCacheSeconds ?? 600) * 1000,
      cooldownDuration: 30_000,
      timeoutDuration: 5_000,
    });
  }

  /** Issuers whose tokens are accepted. */
  issuers(): string[] {
    return asList(this.config.issuer) ?? this.config.authorizationServers;
  }

  /** Discover `jwks_uri` from the first authorization server's metadata (cached). */
  private async discoverJwks(): Promise<JWTVerifyGetKey | undefined> {
    if (this.jwks) return this.jwks;
    this.jwksPromise ??= (async () => {
      for (const issuer of this.config.authorizationServers) {
        for (const url of metadataUrls(issuer)) {
          try {
            const r = await this.fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5_000) });
            if (!r.ok) continue;
            const meta = (await r.json()) as { jwks_uri?: unknown };
            if (typeof meta.jwks_uri === 'string') {
              this.jwks = this.remoteJwks(assertSecureUrl(meta.jwks_uri, 'jwks_uri'));
              return this.jwks;
            }
          } catch (err) {
            logger.debug(`OAuth metadata discovery failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      return undefined;
    })().finally(() => {
      if (!this.jwks) this.jwksPromise = undefined; // retry discovery next time
    });
    return this.jwksPromise;
  }

  /** Validate a bearer token for `resource`. Throws `TokenError`. */
  async verify(token: string, resource: string): Promise<TokenInfo> {
    const isJwt = token.split('.').length === 3;
    let info: TokenInfo;
    if (isJwt && !this.config.introspection?.preferForJwt) {
      const jwks = await this.discoverJwks();
      if (jwks) info = await this.verifyJwt(token, jwks, resource);
      else if (this.config.introspection) info = await this.introspect(token, resource);
      else throw new TokenError('no JWKS available to validate the token');
    } else if (this.config.introspection) {
      info = await this.introspect(token, resource);
    } else {
      throw new TokenError('opaque tokens require auth.oauth.introspection');
    }
    const required = this.config.requiredScopes ?? [];
    const missing = required.filter((s) => !info.scopes.includes(s));
    if (missing.length) throw new TokenError(`missing scope(s): ${missing.join(' ')}`, 'insufficient_scope');
    return info;
  }

  private audiences(resource: string): string[] {
    return asList(this.config.audience) ?? [resource];
  }

  private async verifyJwt(token: string, jwks: JWTVerifyGetKey, resource: string): Promise<TokenInfo> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, jwks, {
        algorithms: this.config.algorithms ?? ASYMMETRIC_ALGORITHMS,
        issuer: this.issuers(),
        audience: this.audiences(resource),
        clockTolerance: this.config.clockToleranceSeconds ?? 0,
        requiredClaims: ['exp'],
      }));
    } catch (err) {
      throw new TokenError(err instanceof Error ? err.message : String(err));
    }
    const claims = payload as Record<string, unknown>;
    return {
      subject: payload.sub,
      clientId: typeof claims.client_id === 'string' ? claims.client_id : typeof claims.azp === 'string' ? claims.azp : undefined,
      scopes: tokenScopes(claims),
      claims,
      exp: payload.exp,
    };
  }

  private async introspect(token: string, resource: string): Promise<TokenInfo> {
    const ic = this.config.introspection!;
    const cacheKey = createHash('sha256').update(token).digest('hex');
    const t = this.now();
    const hit = this.introspectionCache.get(cacheKey);
    if (hit && hit.until > t) return hit.info;
    if (hit) this.introspectionCache.delete(cacheKey);

    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    if (ic.clientId) {
      const basic = Buffer.from(`${encodeURIComponent(ic.clientId)}:${encodeURIComponent(ic.clientSecret ?? '')}`).toString('base64');
      headers.authorization = `Basic ${basic}`;
    }
    let body: Record<string, unknown>;
    try {
      const r = await this.fetchImpl(ic.url, {
        method: 'POST',
        headers,
        body: new URLSearchParams({ token, token_type_hint: 'access_token' }).toString(),
        signal: AbortSignal.timeout(5_000),
      });
      if (!r.ok) throw new Error(`introspection endpoint answered ${r.status}`);
      body = (await r.json()) as Record<string, unknown>;
    } catch (err) {
      logger.warn(`OAuth token introspection failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new TokenError('token introspection failed');
    }
    if (body.active !== true) throw new TokenError('token is not active');
    const exp = typeof body.exp === 'number' ? body.exp : undefined;
    if (exp !== undefined && exp * 1000 <= t) throw new TokenError('token expired');
    if (typeof body.iss === 'string' && !this.issuers().includes(body.iss)) throw new TokenError('unexpected issuer');
    const aud = asList(body.aud as string | string[] | undefined);
    if (aud && !aud.some((a) => this.audiences(resource).includes(a))) {
      throw new TokenError('token was not issued for this resource');
    }
    if (!aud && ic.requireAudience !== false) throw new TokenError('token has no audience');
    const info: TokenInfo = {
      subject: typeof body.sub === 'string' ? body.sub : undefined,
      clientId: typeof body.client_id === 'string' ? body.client_id : undefined,
      scopes: tokenScopes(body),
      claims: body,
      exp,
    };
    const maxMs = (ic.cacheSeconds ?? 60) * 1000;
    const until = Math.min(t + maxMs, exp !== undefined ? exp * 1000 : Infinity);
    if (maxMs > 0) {
      if (this.introspectionCache.size > 10_000) this.introspectionCache.clear();
      this.introspectionCache.set(cacheKey, { info, until });
    }
    return info;
  }
}

/** Public base URL of the request (scheme + host), honouring "trust proxy". */
export function requestOrigin(req: Request): string {
  return `${req.protocol}://${req.get('host') ?? 'localhost'}`;
}

/** Canonical resource URI of the MCP endpoint (RFC 8707). */
export function resourceUri(config: OAuthConfig, req: Request, mcpPath: string): string {
  return config.resource ?? `${requestOrigin(req)}${mcpPath}`;
}

/** URL of the protected-resource metadata document for this resource. */
export function metadataUrl(config: OAuthConfig, req: Request, mcpPath: string): string {
  const resource = new URL(resourceUri(config, req, mcpPath));
  const path = resource.pathname.replace(/\/$/, '');
  return `${resource.origin}${PROTECTED_RESOURCE_METADATA_PATH}${path}`;
}

/** RFC 9728 metadata document. */
export function protectedResourceMetadata(config: OAuthConfig, req: Request, mcpPath: string): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    resource: resourceUri(config, req, mcpPath),
    authorization_servers: config.authorizationServers,
    bearer_methods_supported: ['header'],
    resource_name: config.resourceName ?? 'mcp-gateway',
  };
  if (config.scopesSupported?.length) doc.scopes_supported = config.scopesSupported;
  if (config.documentation) doc.resource_documentation = config.documentation;
  const algs = config.algorithms ?? ASYMMETRIC_ALGORITHMS;
  doc.resource_signing_alg_values_supported = algs;
  return doc;
}

/** `WWW-Authenticate` value for a failed request. */
export function bearerChallenge(
  config: OAuthConfig,
  req: Request,
  mcpPath: string,
  err?: TokenError,
): string {
  const parts = [`resource_metadata=${quote(metadataUrl(config, req, mcpPath))}`];
  if (err) {
    parts.push(`error=${quote(err.code)}`);
    parts.push(`error_description=${quote(err.message.replace(/[^\x20-\x7e]/g, ''))}`);
  }
  const scopes = config.requiredScopes?.length ? config.requiredScopes : undefined;
  if (scopes) parts.push(`scope=${quote(scopes.join(' '))}`);
  return `Bearer ${parts.join(', ')}`;
}

/**
 * Startup warning when the token audience is derived from the request's `Host` header (10.1 hardening):
 * without `auth.oauth.resource` (or `audience`) a client chooses the expected audience itself, so a token
 * minted by the same authorization server for another resource could be replayed by sending that
 * resource's host. Set `resource`, or restrict hosts with `security.allowedHosts`.
 */
export function resourceWarning(config: OAuthConfig): string | undefined {
  if (config.resource || config.audience) return undefined;
  return 'auth.oauth.resource is not set: the expected token audience is derived from the request Host header. Set auth.oauth.resource (and security.allowedHosts) so tokens issued for other resources are rejected.';
}

export interface OAuthMiddlewareOptions extends OAuthVerifierOptions {
  /** Path of the MCP endpoint (the protected resource). */
  mcpPath: () => string;
}

/** Express middleware for `auth.strategy: oauth2`. */
export function oauthMiddleware(config: OAuthConfig, options: OAuthMiddlewareOptions): AuthMiddleware & { verifier: OAuthVerifier } {
  const verifier = new OAuthVerifier(config, options);
  const hostWarning = resourceWarning(config);
  if (hostWarning) logger.warn(hostWarning);
  const mw = ((req: Request, res: Response, next: NextFunction) => {
    const path = options.mcpPath();
    const header = req.headers.authorization;
    if (!header || !/^Bearer /i.test(header)) {
      res.set('WWW-Authenticate', bearerChallenge(config, req, path));
      res.status(401).json({ error: 'Unauthorized', message: 'Bearer access token required' });
      return;
    }
    const token = header.slice(7).trim();
    verifier.verify(token, resourceUri(config, req, path)).then(
      (info) => {
        const r = req as AuthedRequest;
        r.jwtPayload = info.claims;
        r.oauth = info;
        r.clientId = `oauth:${info.subject ?? info.clientId ?? 'unknown'}`;
        const scope = scopeFromJwt(info.claims);
        if (scope) r.scope = scope;
        next();
      },
      (err: unknown) => {
        const te = err instanceof TokenError ? err : new TokenError('invalid token');
        logger.warn(`OAuth token rejected from ${req.ip}: ${te.message}`);
        if (res.headersSent) return;
        res.set('WWW-Authenticate', bearerChallenge(config, req, path, te));
        const forbidden = te.code === 'insufficient_scope';
        res.status(forbidden ? 403 : 401).json({
          error: forbidden ? 'Forbidden' : 'Unauthorized',
          message: forbidden ? 'Insufficient scope' : 'Invalid or expired access token',
        });
      },
    );
  }) as AuthMiddleware & { verifier: OAuthVerifier };
  mw.verifier = verifier;
  return mw;
}

/** Decode a JWT's claims without verifying it (diagnostics only). */
export function peekClaims(token: string): Record<string, unknown> | undefined {
  try {
    return decodeJwt(token) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
