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
        'Set auth.strategy (api-key or jwt) or bind to 127.0.0.1.',
    );
  }
  if (strategy === 'none' && loopback && !sec.dnsRebindingProtection && !sec.allowedHosts) {
    add(
      'dns-rebinding',
      'Authentication is disabled and DNS-rebinding protection is off: a malicious web page could reach this local gateway ' +
        'through a rebound DNS name. Enable security.dnsRebindingProtection or configure auth.',
    );
  }
  const mcpOrigins = config.mcp?.allowedOrigins ?? config.corsOrigins;
  if (config.mcp?.enabled !== false && (!mcpOrigins || mcpOrigins.includes('*')) && !sec.dnsRebindingProtection) {
    add(
      'mcp-any-origin',
      'The /mcp endpoint accepts browser requests from any Origin. Set mcp.allowedOrigins (or corsOrigins), ' +
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
  if (strategy !== 'none' && !sec.authLockout) {
    add('no-auth-lockout', 'No brute-force protection: set security.authLockout: true to lock out IPs after repeated failures.', 'info');
  }
  if (sec.headers === false) add('headers-disabled', 'Security headers are disabled (security.headers: false).');
  if (sec.exposeErrorDetails) add('error-details', 'security.exposeErrorDetails is on: internal error messages and stack traces reach clients.');
  if (config.corsOrigins?.includes('*') && strategy !== 'none') {
    add('cors-wildcard', 'corsOrigins contains "*": any web page may call the API with a key it holds. List your dashboard origins instead.');
  }
  return out;
}
