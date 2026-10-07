import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { timeoutMiddleware } from '../src/middleware/timeout.js';
import { errorHandler, createErrorHandler, notFoundHandler, GatewayError, ErrorCodes } from '../src/middleware/error-handler.js';
import { requestIdMiddleware } from '../src/middleware/request-id.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function serve(app: express.Express): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function withEnv<T>(key: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const old = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return fn().finally(() => {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  });
}

describe('timeoutMiddleware', () => {
  function app(timeoutMs: number) {
    const a = express();
    a.use(timeoutMiddleware(timeoutMs));
    a.get('/slow', (_req, res) => {
      setTimeout(() => {
        if (!res.headersSent) res.json({ late: true });
      }, 300);
    });
    a.get('/fast', (_req, res) => {
      res.json({ ok: true });
    });
    a.get('/x/stream', (_req, res) => {
      setTimeout(() => res.json({ streamed: true }), 150);
    });
    a.get('/partial', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('a');
      setTimeout(() => res.end('b'), 150);
    });
    a.use(errorHandler);
    return a;
  }

  it('returns 504 with Retry-After when the handler is too slow', async () => {
    const base = await serve(app(50));
    const res = await fetch(`${base}/slow`);
    expect(res.status).toBe(504);
    expect(res.headers.get('retry-after')).toBe('1');
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe(ErrorCodes.TIMEOUT);
    expect(body.error.message).toMatch(/50ms/);
  });

  it('rounds Retry-After up to whole seconds', async () => {
    const a = express();
    a.use(timeoutMiddleware(1500));
    a.get('/never', () => {});
    a.use(errorHandler);
    const base = await serve(a);
    const res = await fetch(`${base}/never`);
    expect(res.status).toBe(504);
    expect(res.headers.get('retry-after')).toBe('2');
  });

  it('lets fast responses through untouched', async () => {
    const base = await serve(app(50));
    const res = await fetch(`${base}/fast`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('skips streaming endpoints', async () => {
    const base = await serve(app(50));
    const res = await fetch(`${base}/x/stream`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ streamed: true });
  });

  it('does not interfere once headers have been sent', async () => {
    const base = await serve(app(50));
    const res = await fetch(`${base}/partial`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ab');
  });
});

describe('errorHandler', () => {
  function app(err: unknown) {
    const a = express();
    a.use(requestIdMiddleware);
    a.use(express.json({ limit: '10b' }));
    a.post('/json', (_req, res) => {
      res.json({ ok: true });
    });
    a.get('/boom', (_req, _res, next) => next(err));
    a.use(notFoundHandler);
    a.use(errorHandler);
    return a;
  }

  it('serialises GatewayError with its status, code and request id', async () => {
    const base = await serve(app(new GatewayError(409, 'CONFLICT', 'ambiguous', { candidates: ['a', 'b'] })));
    const res = await fetch(`${base}/boom`, { headers: { 'x-request-id': 'req-123' } });
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.error).toMatchObject({ code: 'CONFLICT', message: 'ambiguous', requestId: 'req-123' });
    expect(body.error.details).toEqual({ candidates: ['a', 'b'] });
  });

  it('hides GatewayError details and stack traces in production', async () => {
    await withEnv('NODE_ENV', 'production', async () => {
      const base = await serve(app(new GatewayError(400, 'BAD', 'nope', { secret: 1 })));
      const body = (await (await fetch(`${base}/boom`)).json()) as any;
      expect(body.error.details).toBeUndefined();
    });
    await withEnv('NODE_ENV', 'production', async () => {
      const base = await serve(app(new Error('db password is hunter2')));
      const res = await fetch(`${base}/boom`);
      expect(res.status).toBe(500);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe(ErrorCodes.INTERNAL_ERROR);
      expect(body.error.message).toBe('Internal server error');
      expect(body.error.details).toBeUndefined();
    });
  });

  it('includes the message and stack for unknown errors only in development', async () => {
    await withEnv('NODE_ENV', 'development', async () => {
      const base = await serve(app(new Error('kaboom')));
      const body = (await (await fetch(`${base}/boom`)).json()) as any;
      expect(body.error.message).toBe('kaboom');
      expect(String(body.error.details)).toMatch(/kaboom/);
    });
    await withEnv('NODE_ENV', 'test', async () => {
      const base = await serve(app(new Error('db password is hunter2')));
      const body = (await (await fetch(`${base}/boom`)).json()) as any;
      expect(body.error.message).toBe('Internal server error');
      expect(body.error.details).toBeUndefined();
    });
  });

  it('createErrorHandler exposes internals only when asked', async () => {
    await withEnv('NODE_ENV', 'test', async () => {
      for (const expose of [true, false]) {
        const a = express();
        a.get('/boom', (_req, _res, next) => next(new Error('kaboom')));
        a.use(createErrorHandler(() => expose));
        const base = await serve(a);
        const body = (await (await fetch(`${base}/boom`)).json()) as any;
        expect(body.error.message).toBe(expose ? 'kaboom' : 'Internal server error');
      }
    });
  });

  it('maps non-Error throwables to a generic 500', async () => {
    const base = await serve(app('a string'));
    const res = await fetch(`${base}/boom`);
    expect(res.status).toBe(500);
    expect(((await res.json()) as any).error.message).toBe('Internal server error');
  });

  it('keeps 4xx statuses from Express/body-parser errors', async () => {
    const base = await serve(app(null));
    const bad = await fetch(`${base}/json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad',
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.code).toBe(ErrorCodes.BAD_REQUEST);

    const big = await fetch(`${base}/json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 'x'.repeat(100) }),
    });
    expect(big.status).toBe(413);
    expect(((await big.json()) as any).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('honours a numeric statusCode property and ignores 5xx ones', async () => {
    const e1 = Object.assign(new Error('teapot'), { statusCode: 418 });
    let base = await serve(app(e1));
    let res = await fetch(`${base}/boom`);
    expect(res.status).toBe(418);
    expect(((await res.json()) as any).error.code).toBe(ErrorCodes.BAD_REQUEST);

    const e2 = Object.assign(new Error('upstream'), { status: 503 });
    base = await serve(app(e2));
    res = await fetch(`${base}/boom`);
    expect(res.status).toBe(500);
  });

  it('notFoundHandler returns a 404 envelope', async () => {
    const base = await serve(app(null));
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe(ErrorCodes.NOT_FOUND);
    expect(body.error.message).toBe('Route GET /nope not found');
    expect(typeof body.error.requestId).toBe('string');
  });
});
