/**
 * Request ID Middleware
 *
 * Attaches a unique `X-Request-Id` header to every request and response,
 * enabling end-to-end tracing across logs and downstream systems.
 *
 * Priority order:
 *   1. Honour an existing `X-Request-Id` header sent by the client
 *   2. Honour `X-Correlation-Id` (common in enterprise proxies)
 *   3. Generate a new UUID v4
 *
 * @module middleware/request-id
 */

import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

declare global {
  // Augment Express Request so downstream handlers can read req.requestId
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

// Client-supplied ids are echoed into headers and logs: accept only a safe,
// bounded charset to prevent log forging / oversized headers.
const SAFE_ID = /^[A-Za-z0-9._:\-]{1,128}$/;

function pick(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v && SAFE_ID.test(v) ? v : undefined;
}

export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const id =
    pick(req.headers['x-request-id']) ||
    pick(req.headers['x-correlation-id']) ||
    randomUUID();

  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
