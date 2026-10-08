import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { ApiUpstreamsSchema, apiUpstreamTools, callApiUpstream, graphqlVariables } from '../src/features/api-upstreams.js';
import { validateConfig } from '../src/config/loader.js';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';

let srv: Server;
let url = '';
const seen: Array<{ path: string; headers: Record<string, unknown>; body: any }> = [];
beforeAll(async () => {
  srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ path: req.url!, headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/graphql') {
        if (body.variables.id === 'bad') return void res.end(JSON.stringify({ errors: [{ message: 'not found' }], data: null }));
        return void res.end(JSON.stringify({ data: { product: { id: body.variables.id, title: 'Mug' } } }));
      }
      if (req.url === '/billing.v1.Invoices/Get') {
        if (body.id === 'x') return void ((res.statusCode = 404), res.end(JSON.stringify({ code: 'not_found', message: 'no invoice x' })));
        return void res.end(JSON.stringify({ id: body.id, total: 42 }));
      }
      res.statusCode = 500;
      res.end('oops');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => srv.close(() => r())));

const cfg = () => ({
  servers: [],
  apiUpstreams: [
    { id: 'shop', kind: 'graphql', url: `${url}/graphql`, headers: { 'x-key': 'k' }, operations: [{ name: 'product', document: 'query product($id: ID!, $tags: [String!], $n: Int = 3) { product(id: $id) { id title } }' }] },
    { id: 'billing', kind: 'grpc', url: url + '/', methods: [{ name: 'getInvoice', service: 'billing.v1.Invoices', method: 'Get' }, { name: 'broken', service: 'x.Y', method: 'Z' }] },
  ],
}) as any;

let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

describe('GraphQL / gRPC upstreams (6.1)', () => {
  it('derives input schemas from GraphQL variable definitions', () => {
    expect(graphqlVariables('query q($id: ID!, $tags: [String!], $n: Int = 3, $f: Float, $b: Boolean!, $in: ProductInput) { x }')).toEqual({
      type: 'object',
      properties: { id: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, n: { type: 'integer' }, f: { type: 'number' }, b: { type: 'boolean' }, in: { description: 'GraphQL input type ProductInput' } },
      required: ['id', 'b'],
      additionalProperties: false,
    });
    expect(graphqlVariables('{ ping }')).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    const tools = apiUpstreamTools(cfg());
    expect(tools.map((t) => `${t.kind}:${t.name}`)).toEqual(['graphql:shop.product', 'grpc:billing.getInvoice', 'grpc:billing.broken']);
    expect(tools[1]!.description).toBe('billing.v1.Invoices/Get');
  });

  it('calls GraphQL and Connect / transcoded gRPC endpoints, mapping errors', async () => {
    const ok = await callApiUpstream(cfg(), 'shop.product', { id: 'p1' });
    expect(ok).toMatchObject({ success: true, result: { product: { id: 'p1', title: 'Mug' } } });
    const g = seen.find((s) => s.path === '/graphql')!;
    expect(g.body.operationName).toBe('product');
    expect(g.headers['x-key']).toBe('k');
    expect(await callApiUpstream(cfg(), 'shop.product', { id: 'bad' })).toMatchObject({ success: false, error: { code: 'graphql', message: 'not found' } });
    expect(await callApiUpstream(cfg(), 'billing.getInvoice', { id: 'i9' })).toMatchObject({ success: true, result: { id: 'i9', total: 42 } });
    expect(seen.find((s) => s.path === '/billing.v1.Invoices/Get')!.headers['connect-protocol-version']).toBe('1');
    expect(await callApiUpstream(cfg(), 'billing.getInvoice', { id: 'x' })).toMatchObject({ success: false, error: { code: 'not_found', message: 'no invoice x' } });
    expect(await callApiUpstream(cfg(), 'billing.broken', {})).toMatchObject({ success: false, error: { code: 'http_500' } });
    expect(await callApiUpstream(cfg(), 'billing.nope', {})).toBeUndefined();
    expect(await callApiUpstream(cfg(), 'nodot', {})).toBeUndefined();
    const down = await callApiUpstream(cfg(), 'shop.product', { id: 'p' }, (async () => { throw new Error('ECONNREFUSED'); }) as never);
    expect(down).toMatchObject({ success: false, error: { code: 'unavailable' } });
  });

  it('validates config (kinds, duplicates, names)', () => {
    expect(() => validateConfig(cfg())).not.toThrow();
    expect(() => ApiUpstreamsSchema.parse([{ id: 'a', kind: 'soap', url: 'http://x' }])).toThrow();
    expect(() => ApiUpstreamsSchema.parse([{ id: 'a', kind: 'grpc', url: 'http://x', methods: [{ name: 'm', service: 's', method: 'M' }] }, { id: 'a', kind: 'grpc', url: 'http://x', methods: [{ name: 'm', service: 's', method: 'M' }] }])).toThrow(/duplicate upstream id/);
    expect(() => ApiUpstreamsSchema.parse([{ id: 'a b', kind: 'graphql', url: 'http://x', operations: [{ name: 'q', document: '{ x }' }] }])).toThrow();
  });

  it('admin API: list and call', async () => {
    h = await startFeatureGw({ apiUpstreams: cfg().apiUpstreams } as never);
    const l = await h.admin('api-upstreams');
    expect(l.body.tools).toHaveLength(3);
    expect(l.body.upstreams[0]).toEqual({ id: 'shop', kind: 'graphql', url: `${url}/graphql` });
    const c = await h.admin('api-upstreams/call', { tool: 'shop.product', arguments: { id: 'z' } });
    expect(c.status).toBe(200);
    expect(c.body.result.product.id).toBe('z');
    expect((await h.admin('api-upstreams/call', { tool: 'billing.getInvoice', arguments: { id: 'x' } })).status).toBe(502);
    expect((await h.admin('api-upstreams/call', { tool: 'nope.x' })).status).toBe(404);
    expect((await h.admin('api-upstreams/call', { tool: 1 })).status).toBe(400);
    expect((await h.admin('api-upstreams/call', { tool: 'shop.product', arguments: [] })).status).toBe(400);
    expect((await h.admin('api-upstreams/call', [])).status).toBe(400);
    expect((await h.admin('api-upstreams', undefined, 'GET', { authorization: 'Bearer scoped' })).status).toBe(403);
  });
});
