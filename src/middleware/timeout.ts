/**
 * Request Timeout Middleware
 *
 * Bug fix (v0.1.0): tool-call requests to slow or unresponsive MCP servers
 * could hang indefinitely, exhausting the Node.js event loop.
 * This middleware enforces a per-request deadline and returns a 504 response.
 *
 * @module middleware/timeout
 */

import { Request, Response, NextFunction } from 'express';
import { GatewayError, ErrorCodes } from './error-handler.js';

export function timeoutMiddleware(timeoutMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip timeout for SSE streaming endpoints
    if (req.path.endsWith('/stream')) {
      next();
      return;
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // The handler may have started streaming; nothing safe to send then.
      if (res.headersSent) return;
      res.set('Retry-After', String(Math.max(1, Math.ceil(timeoutMs / 1000))));
      next(
        new GatewayError(
          504,
          ErrorCodes.TIMEOUT,
          `Request timed out after ${timeoutMs}ms`,
          { path: req.path, method: req.method },
        ),
      );
    }, timeoutMs);

    // Clear the timer once the response is sent
    res.on('finish', () => {
      if (!timedOut) clearTimeout(timer);
    });
    res.on('close', () => {
      if (!timedOut) clearTimeout(timer);
    });

    next();
  };
}
