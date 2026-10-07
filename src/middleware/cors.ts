/**
 * CORS Middleware
 *
 * Configurable Cross-Origin Resource Sharing headers.
 * Supports wildcard, specific origins list, and regex patterns.
 *
 * @module middleware/cors
 */

import { Request, Response, NextFunction } from 'express';

export interface CORSOptions {
  origins: string[];          // '*' | 'https://example.com' | regex string
  methods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
}

const DEFAULT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const DEFAULT_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-API-Key',
  'X-Request-Id',
];

export function corsMiddleware(options: CORSOptions) {
  const {
    origins,
    methods = DEFAULT_METHODS,
    allowedHeaders = DEFAULT_HEADERS,
    exposedHeaders = ['X-Request-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
    credentials = false,
    maxAge = 86400,
  } = options;

  const isAllowed = (origin: string): boolean => {
    for (const o of origins) {
      if (o === '*') return true;
      if (o === origin) return true;
      // Support regex patterns wrapped in /…/
      if (o.startsWith('/') && o.endsWith('/')) {
        try {
          if (new RegExp(o.slice(1, -1)).test(origin)) return true;
        } catch {
          // invalid regex — skip
        }
      }
    }
    return false;
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin ?? '';

    const wildcard = origins.includes('*');
    if (wildcard && !credentials) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else {
      // Response depends on Origin: tell caches so (even when disallowed).
      res.vary('Origin');
      // Browsers reject "*" together with credentials, so reflect the origin.
      if (origin && isAllowed(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
    }

    if (credentials) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    res.setHeader('Access-Control-Expose-Headers', exposedHeaders.join(', '));

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', methods.join(', '));
      res.setHeader('Access-Control-Allow-Headers', allowedHeaders.join(', '));
      res.setHeader('Access-Control-Max-Age', String(maxAge));
      res.status(204).end();
      return;
    }

    next();
  };
}
