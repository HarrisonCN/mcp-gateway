/** 8.6: data lineage. */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';
import { validateConfig } from '../src/config/loader.js';
import { DataLineageSchema, values, fingerprint, recordCall, recordResult, graphOf, lineageState } from '../src/features/data-lineage.js';

let h: FeatureGw | undefined;
beforeEach(() => lineageState.reset());
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

describe('data lineage (8.6)', () => {
  it('extracts values (nested JSON text too), ignores short ones', () => {
    expect(values({ a: 'short', b: { c: ['customer-42@example.com'] }, d: 1234567890, e: '{"inner":"order-000123"}' }, 8)).toEqual([
      { path: 'b.c[0]', value: 'customer-42@example.com' },
      { path: 'd', value: '1234567890' },
      { path: 'e.inner', value: 'order-000123' },
    ]);
    expect(fingerprint('x')).toHaveLength(24);
    expect(() => validateConfig({ servers: [], dataLineage: { scope: 'planet' } })).toThrow();
    expect(validateConfig({ version: 8, servers: [], dataLineage: {} }).dataLineage).toBeDefined();
  });

  it('links outputs to later inputs within the scope; graph up and down', () => {
    const c = DataLineageSchema.parse({});
    const a = recordCall(c, { tool: 'crm/find', client: 'key:bot', args: { q: 'acme corp' } });
    recordResult(c, a, true, { content: [{ type: 'text', text: '{"customerId":"cus_8f3k2la9"}' }] });
    const b = recordCall(c, { tool: 'billing/invoices', client: 'key:bot', args: { customer: 'cus_8f3k2la9' } });
    recordResult(c, b, true, { invoice: 'inv_2026_000981' });
    const d = recordCall(c, { tool: 'mail/send', client: 'key:bot', args: { body: 'inv_2026_000981' } });
    const other = recordCall(c, { tool: 'mail/send', client: 'key:someone-else', args: { body: 'inv_2026_000981' } });
    expect(lineageState.edges.map((e) => `${e.from === a ? 'a' : 'b'}→${e.to === b ? 'b' : e.to === d ? 'd' : 'x'}:${e.path}`)).toEqual(['a→b:customer', 'b→d:body']);
    expect(graphOf(d, 3).upstream.nodes.map((n) => n.tool)).toEqual(['billing/invoices', 'crm/find']);
    expect(graphOf(a, 1).downstream.nodes.map((n) => n.tool)).toEqual(['billing/invoices']);
    expect(graphOf(other, 3).upstream.nodes).toEqual([]);
    // global scope links across clients
    const g = DataLineageSchema.parse({ scope: 'global' });
    const x = recordCall(g, { tool: 'mail/send', client: 'key:someone-else', args: { body: 'inv_2026_000981' } });
    expect(graphOf(x, 1).upstream.nodes.map((n) => n.tool)).toEqual(['billing/invoices']);
    // failed results produce nothing
    const f = recordCall(c, { tool: 't/fail', client: 'key:bot', args: {} });
    recordResult(c, f, false, { secret: 'not-a-product-value' });
    expect(lineageState.nodes.get(f)!.produced).toEqual([]);
  });

  it('end to end: trace a value, node graph, OpenLineage export', async () => {
    h = await startFeatureGw({ dataLineage: {} } as never);
    const call = (args: Record<string, unknown>) => fetch(`${h!.base}/api/v1/tools/call`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json' }, body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: args }) });
    await call({ token: 'shipment-77821' }); // echo returns its arguments → produces the value
    await call({ ref: 'shipment-77821' }); // consumes it
    const list = (await h.admin('data-lineage')).body;
    expect(list).toMatchObject({ enabled: true, scope: 'client', nodes: 2, edges: 1 });
    const trace = (await h.admin('data-lineage/trace', { value: 'shipment-77821' })).body;
    expect(trace.producedBy).toHaveLength(2);
    expect(trace.consumedBy.map((n: { paths: string[] }) => n.paths[0])).toEqual(['token', 'ref']);
    const second = list.recent[0].id as string;
    const g = (await h.admin(`data-lineage/nodes/${second}`)).body;
    expect(g.upstream.edges[0]).toMatchObject({ to: second, path: 'ref' });
    expect((await h.admin('data-lineage/nodes/nope')).status).toBe(404);
    const ex = (await h.admin('data-lineage/export')).body;
    expect(ex.events[1]).toMatchObject({ eventType: 'COMPLETE', job: { namespace: 'mcp-gateway', name: 'fake/echo' } });
    expect(ex.events[1].inputs).toHaveLength(1);
  });
});
