/**
 * Network-level guards: client IP allowlist and `Host` header validation
 * (DNS-rebinding protection).
 *
 * @module security/network
 */

import { BlockList, isIP } from 'net';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { logger } from '../utils/logger.js';
import { isLoopbackHost } from './posture.js';

/** Strip the IPv4-mapped IPv6 prefix (`::ffff:1.2.3.4` → `1.2.3.4`). */
export function normalizeIp(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1]! : ip;
}

/** Parse one allowlist entry (`1.2.3.4`, `10.0.0.0/8`, `::1`, `fd00::/8`); throws on invalid input. */
function addEntry(list: BlockList, entry: string): void {
  const [addrRaw, prefixRaw, ...rest] = entry.trim().split('/');
  const addr = normalizeIp(addrRaw ?? '');
  const family = isIP(addr);
  if (!family || rest.length > 0) throw new Error(`invalid IP / CIDR "${entry}"`);
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (prefixRaw === undefined) {
    list.addAddress(addr, type);
    return;
  }
  const prefix = /^\d{1,3}$/.test(prefixRaw) ? Number(prefixRaw) : NaN;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) {
    throw new Error(`invalid CIDR prefix in "${entry}"`);
  }
  list.addSubnet(addr, prefix, type);
}

/** Validate allowlist entries; returns an error message for the first bad one. */
export function invalidCidr(entries: readonly string[] | undefined): string | undefined {
  const list = new BlockList();
  for (const e of entries ?? []) {
    try {
      addEntry(list, e);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  return undefined;
}

/** A predicate telling whether an IP is in the list. */
export function createIpMatcher(entries: readonly string[]): (ip: string | undefined) => boolean {
  const list = new BlockList();
  for (const e of entries) addEntry(list, e);
  return (ip) => {
    if (!ip) return false;
    const a = normalizeIp(ip);
    const family = isIP(a);
    if (!family) return false;
    return list.check(a, family === 4 ? 'ipv4' : 'ipv6');
  };
}

/** Paths that stay reachable for orchestrator probes regardless of the IP allowlist. */
const PROBE_PATHS = new Set(['/api/v1/health/live', '/api/v1/health/ready']);

/** 403 for clients outside `entries` (probes excepted). */
export function ipAllowlistMiddleware(entries: readonly string[]): RequestHandler {
  const allowed = createIpMatcher(entries);
  return (req: Request, res: Response, next: NextFunction) => {
    if (PROBE_PATHS.has(req.path) || allowed(req.ip ?? req.socket.remoteAddress)) return next();
    logger.warn(`Rejected request from ${req.ip ?? 'unknown'}: not in security.ipAllowlist`);
    res.status(403).json({ error: 'Forbidden', message: 'Client address not allowed' });
  };
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

/** Hosts accepted by default when DNS-rebinding protection is on. */
export function defaultAllowedHosts(bindHost: string): string[] {
  const hosts = new Set(LOOPBACK_HOSTS);
  if (bindHost && bindHost !== '0.0.0.0' && bindHost !== '::') {
    hosts.add(isIP(bindHost) === 6 ? `[${bindHost}]` : bindHost);
  }
  return [...hosts];
}

/** Split a Host header into hostname and port (handles `[v6]:port`). */
export function parseHostHeader(host: string): { hostname: string; port?: string } {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    const hostname = h.slice(0, end + 1);
    const port = h.slice(end + 1).startsWith(':') ? h.slice(end + 2) : undefined;
    return { hostname, port };
  }
  const i = h.lastIndexOf(':');
  // A bare IPv6 address (several colons, no brackets) has no port.
  if (i > 0 && h.indexOf(':') === i) return { hostname: h.slice(0, i), port: h.slice(i + 1) };
  return { hostname: h };
}

/** Whether `host` (a Host header value) matches a list of patterns. */
export function hostAllowed(patterns: readonly string[], host: string | undefined): boolean {
  if (!host) return false;
  const { hostname, port } = parseHostHeader(host);
  for (const raw of patterns) {
    const p = raw.trim().toLowerCase();
    if (p === '*') return true;
    const pp = parseHostHeader(p);
    if (pp.port !== undefined && pp.port !== port) continue;
    if (pp.hostname === hostname) return true;
    if (pp.hostname.startsWith('*.') && hostname.endsWith(pp.hostname.slice(1)) && hostname.length > pp.hostname.length - 1) {
      return true;
    }
  }
  return false;
}

/** 421-style rejection (sent as 403) of requests whose Host header is not allowed. */
export function hostCheckMiddleware(patterns: () => readonly string[] | undefined): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const list = patterns();
    if (!list || PROBE_PATHS.has(req.path) || hostAllowed(list, req.headers.host)) return next();
    logger.warn(`Rejected request with Host "${String(req.headers.host ?? '')}" (not in allowed hosts)`);
    res.status(403).json({ error: 'Forbidden', message: 'Host not allowed' });
  };
}

/** Whether an Origin is a loopback origin (`http://localhost:*`, `http://127.0.0.1:*`, `http://[::1]:*`). */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Whether Origin names the same host the request was sent to. */
export function isSameOrigin(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Effective DNS-rebinding protection (10.2 secure default): an explicit `security.dnsRebindingProtection` wins;
 * when it is unset, protection is on for a gateway bound to a loopback address with authentication off — the setup
 * where any web page the user visits could otherwise drive the gateway through the browser.
 */
export function effectiveRebindingProtection(config: { host?: string; auth?: { strategy?: string }; security?: { dnsRebindingProtection?: boolean } }): boolean {
  const explicit = config.security?.dnsRebindingProtection;
  if (explicit !== undefined) return explicit;
  const authOff = !config.auth?.strategy || config.auth.strategy === 'none';
  return authOff && isLoopbackHost(config.host ?? '0.0.0.0');
}

/** Loopback origins (`http(s)://localhost|127.0.0.1|[::1][:port]`) as a CORS origin pattern. */
export const LOOPBACK_ORIGIN_PATTERN = '/^https?:\\/\\/(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(?::\\d+)?$/';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cross-site request guard (10.2): with DNS-rebinding protection on, a state-changing request (not GET / HEAD /
 * OPTIONS) that carries an `Origin` other than the gateway itself, a loopback origin or an explicitly configured
 * CORS origin is refused. Browsers send "simple" cross-site POSTs without a preflight, so CORS headers alone do
 * not stop them from triggering side effects.
 */
export function crossSiteGuardMiddleware(active: () => boolean, configuredOrigins: () => readonly string[] | undefined): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (!origin || SAFE_METHODS.has(req.method) || !active()) return next();
    const configured = (configuredOrigins() ?? []).filter((o) => o !== '*');
    if (isSameOrigin(origin, req.headers.host) || isLoopbackOrigin(origin) || configured.some((o) => o === origin || (o.startsWith('/') && o.endsWith('/') && o.length > 1 && safeTest(o.slice(1, -1), origin)))) return next();
    logger.warn(`Rejected cross-site ${req.method} ${req.path} from Origin ${origin}`);
    res.status(403).json({ error: 'Forbidden', message: 'Cross-site request not allowed' });
  };
}

function safeTest(re: string, s: string): boolean {
  try {
    return new RegExp(re).test(s);
  } catch {
    return false;
  }
}
