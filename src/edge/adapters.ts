/**
 * Runtime adapters for the edge gateway (`createEdgeGateway`).
 *
 * - Cloudflare Workers: `export default workersHandler((env) => config)`
 * - Deno:  `serveDeno(config, { port: 8000 })`
 * - Bun:   `serveBun(config, { port: 3000 })`
 * - Node:  `serveNode(config, { port })` (uses `node:http` through a dynamic import)
 *
 * Config can also come from environment variables with `configFromEnv(env)`:
 * `MCP_GATEWAY_SERVERS` (JSON array of `{ id, url, headers?, tools? }`),
 * `MCP_GATEWAY_API_KEYS` (comma separated), `MCP_GATEWAY_TOOL_NAMING`,
 * `MCP_GATEWAY_CORS_ORIGINS`.
 *
 * @module edge/adapters
 */

import { createEdgeGateway, type EdgeConfig, type EdgeGateway } from './index.js';

type Env = Record<string, unknown>;

/** Edge config from environment variables / Worker bindings. */
export function configFromEnv(env: Env): EdgeConfig {
  const str = (k: string) => (typeof env[k] === 'string' ? (env[k] as string) : undefined);
  let servers: EdgeConfig['servers'] = [];
  const raw = str('MCP_GATEWAY_SERVERS');
  if (raw) {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error('MCP_GATEWAY_SERVERS must be a JSON array');
    servers = parsed as EdgeConfig['servers'];
  }
  const naming = str('MCP_GATEWAY_TOOL_NAMING');
  return {
    servers,
    apiKeys: str('MCP_GATEWAY_API_KEYS')?.split(',').map((k) => k.trim()).filter(Boolean),
    toolNaming: naming === 'prefix' ? 'prefix' : 'auto',
    corsOrigins: str('MCP_GATEWAY_CORS_ORIGINS')?.split(',').map((o) => o.trim()).filter(Boolean),
  };
}

/** Cloudflare Workers module handler. The gateway (and its upstream sessions) is reused per isolate. */
export function workersHandler(build: (env: Env) => EdgeConfig = configFromEnv) {
  let gw: EdgeGateway | undefined;
  let built: Env | undefined;
  return {
    fetch(request: Request, env: Env = {}): Promise<Response> {
      if (!gw || built !== env) {
        gw = createEdgeGateway(build(env));
        built = env;
      }
      return gw.fetch(request);
    },
  };
}

interface ServeOptions {
  port?: number;
  hostname?: string;
}

/** Deno: `Deno.serve`. */
export function serveDeno(config: EdgeConfig, opts: ServeOptions = {}): unknown {
  const Deno = (globalThis as { Deno?: { serve: (o: unknown, h: (r: Request) => Promise<Response>) => unknown } }).Deno;
  if (!Deno) throw new Error('serveDeno() needs the Deno runtime');
  const gw = createEdgeGateway(config);
  return Deno.serve({ port: opts.port ?? 8000, hostname: opts.hostname ?? '0.0.0.0' }, (r) => gw.fetch(r));
}

/** Bun: `Bun.serve`. */
export function serveBun(config: EdgeConfig, opts: ServeOptions = {}): unknown {
  const Bun = (globalThis as { Bun?: { serve: (o: unknown) => unknown } }).Bun;
  if (!Bun) throw new Error('serveBun() needs the Bun runtime');
  const gw = createEdgeGateway(config);
  return Bun.serve({ port: opts.port ?? 3000, hostname: opts.hostname ?? '0.0.0.0', fetch: (r: Request) => gw.fetch(r) });
}

/** Node: serve the edge handler with `node:http` (handy for local testing of an edge deployment). */
export async function serveNode(config: EdgeConfig, opts: ServeOptions = {}): Promise<{ port: number; close: () => Promise<void> }> {
  const http = await import('node:http');
  const gw = createEdgeGateway(config);
  const server = http.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
      const r = await gw.fetch(new Request(url, { method: req.method, headers, body: body && req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined }));
      res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error', message: err instanceof Error ? err.message : String(err) }));
    }
  });
  await new Promise<void>((resolveListen) => server.listen(opts.port ?? 0, opts.hostname ?? '127.0.0.1', resolveListen));
  const addr = server.address();
  return {
    port: typeof addr === 'object' && addr ? addr.port : 0,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
