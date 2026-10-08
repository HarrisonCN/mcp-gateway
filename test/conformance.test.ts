import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import { runConformance, formatReport, CHECKS } from '../src/features/conformance.js';
import { createFeatureRouter, listFeatures, registerFeature, objectBody, badRequest } from '../src/gateway/features.js';
import { startFeatureGw, scoped, type FeatureGw } from './helpers/feature-gw.js';

let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

describe('MCP conformance suite (5.1)', () => {
  it('passes every check against the gateway /mcp endpoint', async () => {
    h = await startFeatureGw({ auth: undefined });
    const r = await runConformance(`${h.base}/mcp`);
    expect(r.checks.filter((c) => c.status !== 'pass')).toEqual([]);
    expect(r.passed).toBe(CHECKS.length);
    expect(formatReport(r)).toContain(`${CHECKS.length} passed, 0 failed`);
  });

  it('runs a subset and skips session checks when initialize fails', async () => {
    const app = express();
    app.post('/mcp', (_req, res) => void res.status(500).send('boom'));
    const srv = app.listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`;
    const r = await runConformance(url, { only: ['ping', 'initialize'] });
    srv.close();
    expect(r.checks.map((c) => [c.id, c.status])).toEqual([['initialize', 'fail'], ['ping', 'skip']]);
    expect(formatReport(r)).toMatch(/✗ initialize/);
  });

  it('reports a transport error as a skip / fail instead of throwing', async () => {
    const f = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    const r = await runConformance('http://x.invalid/mcp', { fetch: f, only: ['parse-error', 'tools-list'] });
    expect(r.checks.find((c) => c.id === 'parse-error')!.status).toBe('fail');
    expect(r.checks.find((c) => c.id === 'tools-list')!.status).toBe('skip');
  });

  it('parses SSE replies', async () => {
    const f = (async (_u: unknown, init?: RequestInit) => {
      const m = JSON.parse(String(init?.body));
      const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', serverInfo: { name: 's' }, capabilities: {} } })}\n\n`;
      return new Response(body, { headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 's1' } });
    }) as typeof fetch;
    const r = await runConformance('http://sse.example/mcp', { fetch: f, only: ['initialize'] });
    expect(r.checks[0]).toMatchObject({ status: 'pass', detail: 'protocol 2025-11-25' });
  });

  it('is exposed as an operator feature module', async () => {
    h = await startFeatureGw();
    const feats = await h.admin('features');
    expect(feats.body.features.map((f: { id: string }) => f.id)).toContain('conformance');
    expect((await h.admin('features', undefined, 'GET', scoped)).status).toBe(403);
    expect((await h.admin('conformance/checks')).body.checks).toHaveLength(CHECKS.length);
    const run = await h.admin('conformance/run', { only: ['initialize', 'tools-list'] });
    expect(run.status).toBe(200);
    expect(run.body.passed).toBe(2);
  });

  it('refuses a self-test when /mcp is disabled', async () => {
    h = await startFeatureGw({ mcp: { enabled: false } });
    expect((await h.admin('conformance/run', {})).status).toBe(409);
  });

  it('feature registry: replace by id, body helpers, 503 when not listening', async () => {
    registerFeature({ id: 'tmp-x', since: '0', summary: 'a', mount: () => {} });
    registerFeature({ id: 'tmp-x', since: '0', summary: 'b', mount: () => {} });
    expect(listFeatures().filter((f) => f.id === 'tmp-x')).toEqual([{ id: 'tmp-x', since: '0', summary: 'b' }]);
    const app = express();
    app.use(express.json());
    app.use(createFeatureRouter({
      authenticate: (_q, _s, n) => n(),
      isOperator: () => true,
      context: { config: () => ({ servers: [] }) as never, tools: () => [], invoke: async () => ({ success: true, durationMs: 0 }), recent: () => [], baseUrl: () => undefined },
      features: [
        { id: 'conf', since: '5.1.0', summary: 's', mount: (r, c) => { r.post('/run', (_q, s) => void (c.baseUrl() ? s.json({}) : s.status(503).json({}))); r.post('/body', (q, s) => { const b = objectBody(q, s); if (b) badRequest(s, 'x'); }); } },
      ],
    }));
    const srv = app.listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/admin`;
    expect((await fetch(`${base}/conf/run`, { method: 'POST' })).status).toBe(503);
    const post = (b: string) => fetch(`${base}/conf/body`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b });
    expect(((await (await post('[1]')).json()) as { message: string }).message).toMatch(/JSON object/);
    expect(((await (await post('{}')).json()) as { message: string }).message).toBe('x');
    srv.close();
  });
});
