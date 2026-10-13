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

/**
 * 15.1.0: the correlation id the client sent (`X-Request-Id`, else `X-Correlation-Id`), when it passes the same
 * charset / length rule — undefined when the gateway generated the request id itself. Kept in the call lineage so
 * another system can join its own records (`GET /api/v1/admin/ops/lineage?correlationId=`).
 */
export function clientCorrelationId(req: { headers: Record<string, string | string[] | undefined> }): string | undefined {
  return pick(req.headers['x-request-id']) || pick(req.headers['x-correlation-id']);
}

/** 15.1.0: whether a value is an acceptable correlation id (same rule as the `X-Request-Id` header). */
export function isCorrelationId(v: unknown): v is string {
  return typeof v === 'string' && SAFE_ID.test(v);
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
