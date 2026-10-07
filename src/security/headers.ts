/**
 * Security response headers (no dependency on helmet).
 *
 *  - every response: `X-Content-Type-Options: nosniff`, `X-Frame-Options:
 *    DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy`,
 *    `Cross-Origin-Resource-Policy`, a locked-down CSP for API responses and
 *    optionally `Strict-Transport-Security`;
 *  - the dashboard page gets its own CSP allowing exactly its inline script
 *    (by SHA-256 hash) and same-origin API calls.
 *
 * @module security/headers
 */

import { createHash } from 'crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { SecurityConfig } from '../utils/types.js';

/** CSP for JSON / SSE API responses: nothing may load, nothing may frame it. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** SHA-256 CSP sources for every inline `<script>` (without `src`) in an HTML document. */
export function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1] && /\bsrc\s*=/.test(m[1])) continue;
    out.push(`'sha256-${createHash('sha256').update(m[2] ?? '', 'utf8').digest('base64')}'`);
  }
  return out;
}

/** Content-Security-Policy for the dashboard page. */
export function dashboardCsp(html: string): string {
  const scripts = inlineScriptHashes(html);
  return [
    "default-src 'none'",
    `script-src ${scripts.length ? scripts.join(' ') : "'none'"}`,
    // The dashboard sets inline styles from script (charts, transitions).
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function hstsValue(hsts: SecurityConfig['hsts']): string | undefined {
  if (!hsts) return undefined;
  const o = typeof hsts === 'object' ? hsts : {};
  const maxAge = o.maxAgeSeconds ?? 15_552_000; // 180 days
  return `max-age=${maxAge}${o.includeSubDomains ? '; includeSubDomains' : ''}`;
}

/** Middleware setting the baseline headers; routes may override `Content-Security-Policy`. */
export function securityHeadersMiddleware(config: () => SecurityConfig | undefined): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction) => {
    const cfg = config();
    if (cfg?.headers === false) return next();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('Content-Security-Policy', API_CSP);
    const hsts = hstsValue(cfg?.hsts);
    if (hsts) res.setHeader('Strict-Transport-Security', hsts);
    next();
  };
}
