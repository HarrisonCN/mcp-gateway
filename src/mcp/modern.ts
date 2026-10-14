/**
 * 16.1.0-canary.0: the MCP 2026-07-28 ("modern") request envelope on `/mcp` — per-request `_meta` instead of the
 * `initialize` handshake (https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning), Streamable HTTP
 * header validation (…/basic/transports/streamable-http#server-validation) and the result decoration every modern
 * result carries (`resultType`, `_meta` serverInfo, `ttlMs` / `cacheScope` on cacheable results).
 *
 * Pure helpers; the endpoint (mcp/endpoint.ts) decides when a request is modern and serves it statelessly.
 *
 * @module mcp/modern
 */

/** The stateless revision `/mcp` serves next to the handshake revisions. */
export const MODERN_PROTOCOL_VERSION = '2026-07-28';

export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

/** 2026-07-28 error codes (spec-reserved range -32020 … -32099). */
export const ERR_HEADER_MISMATCH = -32020;
export const ERR_MISSING_CLIENT_CAPABILITY = -32021;
export const ERR_UNSUPPORTED_PROTOCOL_VERSION = -32022;
/** 2026-07-28 changed "resource not found" from -32002 to -32602 (Invalid Params). */
export const LEGACY_RESOURCE_NOT_FOUND = -32002;
export const MODERN_RESOURCE_NOT_FOUND = -32602;

/** Methods 2026-07-28 removed from the core (sessions, ping, per-session log level, resource subscriptions). */
export const MODERN_REMOVED_METHODS: ReadonlySet<string> = new Set([
  'initialize',
  'ping',
  'logging/setLevel',
  'resources/subscribe',
  'resources/unsubscribe',
]);

/** Requests `/mcp` serves statelessly (besides `server/discover`); anything else is 404 + -32601. */
export const MODERN_METHODS: ReadonlySet<string> = new Set([
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'prompts/list',
  'prompts/get',
  'completion/complete',
]);

/** Requests whose `Mcp-Name` header mirrors `params.name` / `params.uri`. */
const NAMED: Record<string, 'name' | 'uri'> = { 'tools/call': 'name', 'prompts/get': 'name', 'resources/read': 'uri' };

/** Results that take `ttlMs` + `cacheScope` (CacheableResult). */
export const CACHEABLE_METHODS: ReadonlySet<string> = new Set(['tools/list', 'prompts/list', 'resources/list', 'resources/read', 'resources/templates/list', 'server/discover']);

/**
 * Freshness hint for cacheable results. The gateway's lists change on config reloads and upstream list changes, and
 * 16.1.0-canary.0 has no `subscriptions/listen` yet, so the hint is short.
 */
export const MODERN_TTL_MS = 30_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `params._meta` of a message, if any. */
export function metaOf(params: unknown): Record<string, unknown> | undefined {
  return isObject(params) && isObject(params._meta) ? params._meta : undefined;
}

/** The protocol version a message declares in its `_meta` (modern envelope), if any. */
export function declaredVersion(params: unknown): string | undefined {
  const v = metaOf(params)?.[META_PROTOCOL_VERSION];
  return typeof v === 'string' ? v : undefined;
}

/** Decode the Base64 sentinel form `=?base64?…?=` of a header value (Value Encoding); plain values pass through. */
export function decodeHeaderValue(v: string): string | undefined {
  const m = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(v);
  if (!m) return v.startsWith('=?base64?') && v.endsWith('?=') ? undefined : v;
  try {
    return Buffer.from(m[1]!, 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

/** Visible ASCII, space and tab only (RFC 9110 field values); no leading / trailing whitespace. */
const SAFE_HEADER = /^[\x21-\x7e]([\x20-\x7e\t]*[\x21-\x7e])?$/;

/**
 * Streamable HTTP server validation for a modern request: the mirrored headers must be present and equal the body.
 * Returns the problem (for a -32020 HeaderMismatch) or undefined. The version itself is checked separately (-32022).
 */
export function headerMismatch(headers: Record<string, string | string[] | undefined>, method: string, params: unknown): string | undefined {
  const one = (h: string): string | undefined => {
    const v = headers[h];
    return Array.isArray(v) ? (v.length === 1 ? v[0] : undefined) : v;
  };
  const body = declaredVersion(params);
  const pv = one('mcp-protocol-version');
  if (pv === undefined) return 'MCP-Protocol-Version header is missing';
  if (pv !== body) return `MCP-Protocol-Version header '${pv}' does not match body value '${body ?? '(none)'}'`;
  const mm = one('mcp-method');
  if (mm === undefined) return 'Mcp-Method header is missing';
  if (!SAFE_HEADER.test(mm)) return 'Mcp-Method header contains invalid characters';
  if (mm !== method) return `Mcp-Method header '${mm}' does not match body value '${method}'`;
  const field = NAMED[method];
  if (field) {
    const raw = one('mcp-name');
    if (raw === undefined) return 'Mcp-Name header is missing';
    if (!SAFE_HEADER.test(raw)) return 'Mcp-Name header contains invalid characters';
    const name = decodeHeaderValue(raw);
    if (name === undefined) return 'Mcp-Name header has a malformed Base64 value';
    const value = isObject(params) ? params[field] : undefined;
    if (name !== value) return `Mcp-Name header value '${name}' does not match body value '${typeof value === 'string' ? value : '(none)'}'`;
  }
  return undefined;
}

/** Adds what every 2026-07-28 result carries; cacheable results also get `ttlMs` / `cacheScope` (per-caller lists: private). */
export function decorateModernResult(method: string, result: unknown, serverInfo: { name: string; version: string }): Record<string, unknown> {
  const r: Record<string, unknown> = isObject(result) ? { ...result } : {};
  r.resultType = typeof r.resultType === 'string' ? r.resultType : 'complete';
  r._meta = { ...(isObject(r._meta) ? r._meta : {}), [META_SERVER_INFO]: serverInfo };
  if (CACHEABLE_METHODS.has(method)) {
    if (typeof r.ttlMs !== 'number') r.ttlMs = MODERN_TTL_MS;
    if (r.cacheScope !== 'public' && r.cacheScope !== 'private') r.cacheScope = 'private';
  }
  return r;
}
