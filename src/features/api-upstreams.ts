/**
 * GraphQL / gRPC upstreams (6.1): expose GraphQL operations and gRPC methods as tools, without an MCP server.
 *
 * - **GraphQL:** each configured operation (a query or mutation document) becomes a tool; its input schema is derived
 *   from the operation's variable definitions (`$id: ID!` → required string, `Int` → integer, `[String]` → array …).
 *   Calls POST `{ query, variables, operationName }` to the endpoint; GraphQL `errors` turn the call into an error.
 * - **gRPC:** unary methods over the [Connect protocol](https://connectrpc.com/docs/protocol) or gRPC-JSON
 *   transcoding (`POST <url>/<package.Service>/<Method>` with a JSON body) — what Connect, Envoy's transcoder and
 *   gRPC-Gateway serve. Methods carry a JSON Schema for their request message (optional). Non-2xx responses with a
 *   Connect error body (`{ code, message }`) become errors.
 *
 * ```yaml
 * apiUpstreams:
 *   - id: shop
 *     kind: graphql
 *     url: https://shop.example/graphql
 *     headers: { authorization: "Bearer ${SHOP_TOKEN}" }
 *     operations:
 *       - name: product
 *         description: Look up a product
 *         document: "query product($id: ID!, $locale: String) { product(id: $id) { id title price } }"
 *   - id: billing
 *     kind: grpc
 *     url: https://billing.example
 *     methods:
 *       - { name: getInvoice, service: billing.v1.Invoices, method: Get, inputSchema: { type: object, properties: { id: { type: string } } } }
 * ```
 *
 * - `GET  /admin/api-upstreams` — upstreams and their tools (`<upstream>.<operation>`) with input schemas.
 * - `POST /admin/api-upstreams/call` — `{ tool, arguments }` → `{ success, result | error, durationMs }`.
 *
 * @module features/api-upstreams
 */

import { z } from 'zod';
import { registerFeature, objectBody, badRequest } from '../gateway/features.js';
import type { GatewayConfig } from '../utils/types.js';
import { ApiUpstreamsConfig, ApiUpstreamsSchema, Common, GraphqlUpstream, GrpcUpstream, Name } from './schemas/api-upstreams.js';
export { ApiUpstreamsConfig, ApiUpstreamsSchema } from './schemas/api-upstreams.js';
type Upstream = z.output<typeof ApiUpstreamsSchema>[number];

export interface ApiUpstreamTool {
  name: string;
  upstream: string;
  kind: 'graphql' | 'grpc';
  description?: string;
  inputSchema: Record<string, unknown>;
}

const SCALARS: Record<string, Record<string, unknown>> = { ID: { type: 'string' }, String: { type: 'string' }, Int: { type: 'integer' }, Float: { type: 'number' }, Boolean: { type: 'boolean' } };

function gqlType(t: string): { schema: Record<string, unknown>; required: boolean } {
  t = t.trim();
  const required = t.endsWith('!');
  if (required) t = t.slice(0, -1).trim();
  if (t.startsWith('[') && t.endsWith(']')) return { schema: { type: 'array', items: gqlType(t.slice(1, -1)).schema }, required };
  return { schema: SCALARS[t] ?? { description: `GraphQL input type ${t}` }, required };
}

/** JSON Schema for a GraphQL operation's variables (`query q($a: Int!, $b: [String])`). */
export function graphqlVariables(document: string): Record<string, unknown> {
  const head = /^\s*(?:query|mutation|subscription)\s*[A-Za-z_]\w*\s*\(([^)]*)\)/.exec(document);
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  if (head) {
    for (const m of head[1]!.matchAll(/\$([A-Za-z_]\w*)\s*:\s*([\w[\]!\s]+?)(?:\s*=\s*[^,$]+)?(?=,|\s*\$|$)/g)) {
      const t = gqlType(m[2]!);
      properties[m[1]!] = t.schema;
      if (t.required && !/=/.test(m[0])) required.push(m[1]!);
    }
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

const upstreams = (cfg: GatewayConfig): Upstream[] => (cfg.apiUpstreams ? ApiUpstreamsSchema.parse(cfg.apiUpstreams) : []);

/** Every tool exposed by the configured upstreams. */
export function apiUpstreamTools(cfg: GatewayConfig): ApiUpstreamTool[] {
  return upstreams(cfg).flatMap((u): ApiUpstreamTool[] =>
    u.kind === 'graphql'
      ? u.operations.map((o) => ({ name: `${u.id}.${o.name}`, upstream: u.id, kind: 'graphql', description: o.description, inputSchema: graphqlVariables(o.document) }))
      : u.methods.map((m) => ({ name: `${u.id}.${m.name}`, upstream: u.id, kind: 'grpc', description: m.description ?? `${m.service}/${m.method}`, inputSchema: m.inputSchema ?? { type: 'object' } })),
  );
}

export type CallOutcome = { success: true; result: unknown; durationMs: number } | { success: false; error: { code: string; message: string; details?: unknown }; durationMs: number };

/** Call `<upstream>.<operation>`; `fetchImpl` is injectable for tests. */
export async function callApiUpstream(cfg: GatewayConfig, tool: string, args: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<CallOutcome | undefined> {
  const dot = tool.indexOf('.');
  const u = upstreams(cfg).find((x) => x.id === tool.slice(0, dot));
  if (!u || dot < 0) return undefined;
  const name = tool.slice(dot + 1);
  const t0 = Date.now();
  const fail = (code: string, message: string, details?: unknown): CallOutcome => ({ success: false, error: { code, message, ...(details === undefined ? {} : { details }) }, durationMs: Date.now() - t0 });
  let url: string;
  let body: unknown;
  if (u.kind === 'graphql') {
    const op = u.operations.find((o) => o.name === name);
    if (!op) return undefined;
    url = u.url;
    body = { query: op.document, variables: args, operationName: /^\s*(?:query|mutation|subscription)\s*([A-Za-z_]\w*)/.exec(op.document)?.[1] };
  } else {
    const m = u.methods.find((x) => x.name === name);
    if (!m) return undefined;
    url = `${u.url.replace(/\/+$/, '')}/${m.service}/${m.method}`;
    body = args;
  }
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(u.kind === 'grpc' ? { 'connect-protocol-version': '1' } : {}), ...u.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(u.timeoutMs),
    });
  } catch (e) {
    return fail('unavailable', `upstream ${u.id} unreachable: ${(e as Error).message}`);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return fail(res.ok ? 'invalid_response' : 'http_' + res.status, `upstream ${u.id} returned ${res.status} without a JSON body`);
  }
  const j = (json ?? {}) as Record<string, unknown>;
  if (u.kind === 'graphql') {
    if (Array.isArray(j.errors) && j.errors.length) return fail('graphql', (j.errors as Array<{ message?: string }>).map((e) => e.message ?? 'error').join('; '), { errors: j.errors, data: j.data ?? null });
    if (!res.ok) return fail('http_' + res.status, `upstream ${u.id} returned ${res.status}`);
    return { success: true, result: j.data ?? null, durationMs: Date.now() - t0 };
  }
  if (!res.ok) return fail(typeof j.code === 'string' ? j.code : 'http_' + res.status, typeof j.message === 'string' ? j.message : `upstream ${u.id} returned ${res.status}`, j.details);
  return { success: true, result: json, durationMs: Date.now() - t0 };
}

registerFeature({
  id: 'api-upstreams',
  since: '6.1.0',
  summary: 'GraphQL and gRPC (Connect / JSON transcoding) upstreams exposed as tools',
  mount: (router, ctx) => {
    router.get('/', (_req, res) => {
      const cfg = ctx.config();
      res.json({ upstreams: upstreams(cfg).map((u) => ({ id: u.id, kind: u.kind, url: u.url })), tools: apiUpstreamTools(cfg) });
    });
    router.post('/call', async (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      if (typeof b.tool !== 'string') return badRequest(res, '"tool" must be "<upstream>.<operation>"');
      if (b.arguments !== undefined && (typeof b.arguments !== 'object' || b.arguments === null || Array.isArray(b.arguments))) return badRequest(res, '"arguments" must be an object');
      const out = await callApiUpstream(ctx.config(), b.tool, (b.arguments as Record<string, unknown>) ?? {});
      if (!out) return void res.status(404).json({ error: 'Not Found', message: `no API upstream tool "${b.tool}"` });
      res.status(out.success ? 200 : 502).json({ tool: b.tool, ...out });
    });
  },
});
