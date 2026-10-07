/**
 * Centralized Error Handler Middleware
 *
 * Bug fix (v0.1.0): unhandled errors leaked raw stack traces and returned
 * inconsistent response shapes. This middleware normalises all errors into
 * a single JSON envelope and never exposes internal stack traces in production.
 *
 * @module middleware/error-handler
 */

import { Request, Response, NextFunction } from 'express';

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}

export class GatewayError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

// Well-known error codes
export const ErrorCodes = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  SERVER_NOT_FOUND: 'SERVER_NOT_FOUND',
  SERVER_UNAVAILABLE: 'SERVER_UNAVAILABLE',
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'TIMEOUT',
  BAD_REQUEST: 'BAD_REQUEST',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
} as const;

/**
 * Error middleware. Messages and stack traces of unexpected errors (500s)
 * only reach the client when `exposeDetails()` is true or
 * NODE_ENV=development (they used to be shown whenever NODE_ENV was not
 * "production", i.e. by default). Deliberate `GatewayError` details are
 * still shown outside production.
 */
export function createErrorHandler(exposeDetails: () => boolean = () => false) {
  return (err: unknown, req: Request, res: Response, next: NextFunction): void =>
    handleError(err, req, res, next, exposeDetails() || process.env.NODE_ENV === 'development');
}

/** Error middleware with the default (safe) settings. */
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  handleError(err, req, res, next, process.env.NODE_ENV === 'development');
}

function handleError(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
  exposeInternals: boolean,
): void {
  const isDev = process.env.NODE_ENV !== 'production';

  // Headers already flushed (e.g. a late timeout): let Express close the socket.
  if (res.headersSent) {
    _next(err);
    return;
  }

  if (err instanceof GatewayError) {
    const body: ErrorResponse = {
      error: {
        code: err.code,
        message: err.message,
        requestId: (req as any).requestId,
        ...(isDev && err.details ? { details: err.details } : {}),
      },
    };
    res.status(err.statusCode).json(body);
    return;
  }

  // Client errors raised by Express / body-parser (malformed JSON, payload too
  // large, …) carry a 4xx status and must not be reported as 500s.
  const status = getHttpStatus(err);
  if (status !== undefined && status >= 400 && status < 500) {
    const body: ErrorResponse = {
      error: {
        code: status === 413 ? 'PAYLOAD_TOO_LARGE' : ErrorCodes.BAD_REQUEST,
        message: err instanceof Error ? err.message : 'Bad request',
        requestId: (req as any).requestId,
      },
    };
    res.status(status).json(body);
    return;
  }

  // Unknown / unexpected errors
  const message =
    exposeInternals && err instanceof Error ? err.message : 'Internal server error';

  const body: ErrorResponse = {
    error: {
      code: ErrorCodes.INTERNAL_ERROR,
      message,
      requestId: (req as any).requestId,
      ...(exposeInternals && err instanceof Error ? { details: err.stack } : {}),
    },
  };

  res.status(500).json(body);
}

export function notFoundHandler(req: Request, res: Response): void {
  const body: ErrorResponse = {
    error: {
      code: ErrorCodes.NOT_FOUND,
      message: `Route ${req.method} ${req.path} not found`,
      requestId: (req as any).requestId,
    },
  };
  res.status(404).json(body);
}

function getHttpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { status?: unknown; statusCode?: unknown };
  const s = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : undefined;
  return s !== undefined && Number.isInteger(s) ? s : undefined;
}
