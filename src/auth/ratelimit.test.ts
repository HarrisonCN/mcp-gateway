import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createRateLimiter } from './ratelimit.js';

function createReq(clientId?: string): Request {
  const req = {
    ip: '127.0.0.1',
  } as Request & { clientId?: string };
  if (clientId) req.clientId = clientId;
  return req as Request;
}

function createRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: unknown;

  const res = {
    set(nameOrHeaders: string | Record<string, string>, value?: string) {
      if (typeof nameOrHeaders === 'string') {
        headers[nameOrHeaders] = value ?? '';
      } else {
        Object.assign(headers, nameOrHeaders);
      }
      return this;
    },
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
  } as unknown as Response;

  return {
    res,
    get statusCode() {
      return statusCode;
    },
    get headers() {
      return headers;
    },
    get body() {
      return body;
    },
  };
}

describe('createRateLimiter', () => {
  it('limits requests and allows again after window cleanup', () => {
    vi.useFakeTimers();
    const limiter = createRateLimiter({ limit: 1, windowSeconds: 1, perKey: true });

    const next = vi.fn();
    const firstRes = createRes();
    limiter(createReq('user-a'), firstRes.res, next);
    expect(next).toHaveBeenCalledTimes(1);

    const secondRes = createRes();
    limiter(createReq('user-a'), secondRes.res, vi.fn());
    expect(secondRes.statusCode).toBe(429);

    vi.advanceTimersByTime(1_100);

    const thirdNext = vi.fn();
    const thirdRes = createRes();
    limiter(createReq('user-a'), thirdRes.res, thirdNext);
    expect(thirdNext).toHaveBeenCalledTimes(1);
    expect(thirdRes.headers['X-RateLimit-Remaining']).toBe('0');

    vi.useRealTimers();
  });
});
