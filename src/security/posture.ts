/**
 * Secure-defaults check: warnings about risky configurations, logged at
 * startup / reload, printed by `mcp-gateway validate` and returned by
 * `GET /api/v1/security`.
 *
 * @module security/posture
 */

import { isIP } from 'net';
import type { GatewayConfig } from '../utils/types.js';
import { normalizeApiKeys, isHashedKey, keyExpiry } from '../auth/middleware.js';
import { effectiveRebindingProtection } from './network.js';

export interface SecurityWarning {
  /** Stable identifier (for tests, docs and the dashboard). */
  id: string;
  message: string;
  /** `warn`: likely exposure; `info`: hardening recommendation. */
  level: 'warn' | 'info';
}

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  return isIP(h) === 4 && h.startsWith('127.');
}

const DAY = 86_400_000;

/**
 * 10.3 secure default: why the gateway refuses to start (or reload) with this config — authentication off while
 * listening on a non-loopback address — unless `security.insecure` / `start --insecure` acknowledges it.
 * Data planes (`controlPlane.role: data`) are exempt: they take auth from the control plane's config.
 */
export function insecureBindError(config: GatewayConfig): string | undefined {
  const strategy = config.auth?.strategy ?? 'none';
  if (strategy !== 'none' || isLoopbackHost(config.host ?? '0.0.0.0') || config.security?.insecure) return undefined;
  if (config.controlPlane?.role === 'data') return undefined;
  return (
    `Refusing to start: authentication is disabled while listening on ${config.host ?? '0.0.0.0'}, so anyone who can reach ` +
    'this port could call every tool and the admin API. Configure auth (auth.strategy, or MCP_GATEWAY_API_KEYS), bind to ' +
    '127.0.0.1, or — only on a trusted network — start with --insecure (security.insecure: true).'
  );
}

/** Features that are experimental / interface-level (10.3 honest labelling): what is verified and what is not. */
export function experimentalFeatureWarnings(config: GatewayConfig): SecurityWarning[] {
  const out: SecurityWarning[] = [];
  if (config.confidential) {
    out.push({
      id: 'experimental-confidential',
      level: 'info',
      message:
        'features.confidential (TEE attestation) is EXPERIMENTAL. Verified: an Ed25519 / ECDSA / RSA signature by a configured trustedKey ' +
        'over a JSON report, the platform / measurement allowlists, the single-use nonce, issue time and debug flag. NOT verified: ' +
        'native SEV-SNP / TDX / Nitro / SGX evidence and vendor certificate chains (you must run that verifier), and the report is not ' +
        'bound to the upstream connection (no TLS channel binding) — treat it as an interface for an external attestation service.',
    });
  }
  const pq = config.postQuantumTls as { mode?: string } | undefined;
  if (pq && pq.mode !== 'off') {
    out.push({
      id: 'experimental-pq-tls',
      level: 'info',
      message:
        'features.postQuantumTls is EXPERIMENTAL. Verified: the TLS key-exchange groups offered on upstream HTTPS (streamable-http / SSE) ' +
        'connections are set from groups / mode, and POST /admin/pq-tls/probe checks the negotiated group and certificate policy. NOT ' +
        'covered: the gateway\'s own listener, WebSocket upstreams, and certificatePolicy on live connections (probe only); ML-KEM needs ' +
        'OpenSSL 3.5+.',
    });
  }
  return out;
}

export function securityWarnings(config: GatewayConfig, now = Date.now()): SecurityWarning[] {
  const out: SecurityWarning[] = [];
  const add = (id: string, message: string, level: 'warn' | 'info' = 'warn') => out.push({ id, message, level });
  const strategy = config.auth?.strategy ?? 'none';
  const loopback = isLoopbackHost(config.host ?? '0.0.0.0');
  const sec = config.security ?? {};

  if (strategy === 'none' && !loopback) {
    add(
      'auth-disabled-public-bind',
      `Authentication is disabled while listening on ${config.host}: anyone who can reach this port can call every tool. ` +
        'Set auth.strategy (api-key or jwt) or bind to 127.0.0.1. Since 10.3 the gateway refuses to start like this unless --insecure (security.insecure: true) is given.',
    );
  }
  const rebinding = effectiveRebindingProtection(config);
  if (strategy === 'none' && loopback && !rebinding && !sec.allowedHosts) {
    add(
      'dns-rebinding',
      'Authentication is disabled and DNS-rebinding protection is off: a malicious web page could reach this local gateway ' +
        'through a rebound DNS name. Remove security.dnsRebindingProtection: false (it is on by default here) or configure auth.',
    );
  }
  const mcpOrigins = config.mcp?.allowedOrigins ?? config.cors?.origins;
  if (config.mcp?.enabled !== false && (!mcpOrigins || mcpOrigins.includes('*')) && !rebinding) {
    add(
      'mcp-any-origin',
      'The /mcp endpoint accepts browser requests from any Origin. Set mcp.allowedOrigins (or cors.origins), ' +
        'or enable security.dnsRebindingProtection to allow only same-origin and loopback origins.',
    );
  }
  if (strategy === 'api-key') {
    const keys = normalizeApiKeys(config.auth?.apiKeys);
    const plain = keys.filter((k) => !isHashedKey(k.key)).length;
    if (plain > 0) {
      add(
        'plaintext-api-keys',
        `${plain} API key(s) are stored in plain text. Store "sha256:<hex>" digests instead (mcp-gateway hash-key).`,
        'info',
      );
    }
    const soon = keys.filter((k) => {
      const exp = keyExpiry(k);
      return exp !== undefined && exp > now && exp - now < 7 * DAY && !k.disabled;
    });
    if (soon.length > 0) {
      add('api-keys-expiring', `${soon.length} API key(s) expire within 7 days: ${soon.map((k) => k.name ?? 'unnamed').join(', ')}.`);
    }
    const short = keys.filter((k) => !isHashedKey(k.key) && k.key.length < 24).length;
    if (short > 0) add('short-api-keys', `${short} API key(s) are shorter than 24 characters; use mcp-gateway gen-key.`, 'info');
  }
  if (strategy === 'jwt') {
    const jwt = config.auth?.jwt ?? {};
    if (!jwt.issuer || !jwt.audience) {
      add('jwt-no-issuer-audience', 'JWT auth does not check "iss" / "aud": set auth.jwt.issuer and auth.jwt.audience.');
    }
    if (!jwt.requireExp) add('jwt-no-exp', 'JWTs without an "exp" claim are accepted forever: set auth.jwt.requireExp: true.', 'info');
  }
  if (strategy === 'oauth2' && !config.auth?.oauth?.resource) {
    add(
      'oauth-no-resource',
      'auth.oauth.resource is not set: the resource URI is derived from the Host header. Set it to the public /mcp URL.',
      'info',
    );
  }
  if (strategy !== 'none' && !sec.authLockout) {
    add('no-auth-lockout', 'No brute-force protection: set security.authLockout: true to lock out IPs after repeated failures.', 'info');
  }
  if (sec.headers === false) add('headers-disabled', 'Security headers are disabled (security.headers: false).');
  if (sec.exposeErrorDetails) add('error-details', 'security.exposeErrorDetails is on: internal error messages and stack traces reach clients.');
  if (config.cors?.origins?.includes('*') && strategy !== 'none') {
    add('cors-wildcard', 'cors.origins contains "*": any web page may call the API with a key it holds. List your dashboard origins instead.');
  }
  out.push(...experimentalFeatureWarnings(config));
  return out;
}
