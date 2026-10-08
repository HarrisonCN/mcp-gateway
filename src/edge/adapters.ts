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
 * `MCP_GATEWAY_CORS_ORIGINS`; offline / edge sync (4.8): `MCP_GATEWAY_CONTROL_PLANE`,
 * `MCP_GATEWAY_CONTROL_KEY`, `MCP_GATEWAY_EDGE_ID`, `MCP_GATEWAY_QUEUE_TOOLS` (comma separated globs),
 * `MCP_GATEWAY_SYNC_INTERVAL_MS` and a KV namespace bound as `MCP_GATEWAY_KV`.
 *
 * @module edge/adapters
 */

import { createEdgeGateway, type EdgeConfig, type EdgeGateway } from './index.js';
import type { EdgeSyncStore } from './sync.js';

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
  const list = (k: string) => str(k)?.split(',').map((x) => x.trim()).filter(Boolean);
  const cp = str('MCP_GATEWAY_CONTROL_PLANE');
  const kv = env.MCP_GATEWAY_KV as EdgeSyncStore | undefined;
  const interval = Number(str('MCP_GATEWAY_SYNC_INTERVAL_MS'));
  return {
    servers,
    apiKeys: list('MCP_GATEWAY_API_KEYS'),
    // With a control plane, an unset naming comes from the snapshot.
    toolNaming: naming === 'prefix' ? 'prefix' : naming === 'auto' || !cp ? 'auto' : undefined,
    corsOrigins: list('MCP_GATEWAY_CORS_ORIGINS'),
    ...(cp
      ? {
          sync: {
            controlPlane: cp,
            apiKey: str('MCP_GATEWAY_CONTROL_KEY'),
            edgeId: str('MCP_GATEWAY_EDGE_ID'),
            store: kv && typeof kv.get === 'function' ? kv : undefined,
          },
          offline: { queueTools: list('MCP_GATEWAY_QUEUE_TOOLS') },
          ...(Number.isFinite(interval) && str('MCP_GATEWAY_SYNC_INTERVAL_MS') ? { syncIntervalMs: interval } : {}),
        }
      : {}),
  };
}

interface WorkersCtx {
  waitUntil(p: Promise<unknown>): void;
}

/**
 * Cloudflare Workers module handler. The gateway (and its upstream sessions) is reused per isolate.
 * With sync configured, add a Cron Trigger: `scheduled` pulls config, replays queued calls and pushes usage.
 */
export function workersHandler(build: (env: Env) => EdgeConfig = configFromEnv) {
  let gw: EdgeGateway | undefined;
  let built: Env | undefined;
  const get = (env: Env) => {
    if (!gw || built !== env) {
      gw = createEdgeGateway(build(env));
      built = env;
    }
    return gw;
  };
  return {
    fetch(request: Request, env: Env = {}, ctx?: WorkersCtx): Promise<Response> {
      return get(env).fetch(request, ctx ? (p) => ctx.waitUntil(p) : undefined);
    },
    scheduled(_event: unknown, env: Env = {}, ctx?: WorkersCtx): Promise<unknown> {
      const p = get(env).sync();
      ctx?.waitUntil(p);
      return p;
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
