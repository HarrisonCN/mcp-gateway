/**
 * MCP conformance suite (5.1): black-box checks of a Streamable HTTP MCP endpoint against the protocol revisions
 * the gateway speaks. Used by `mcp-gateway conformance <url>`, `POST /api/v1/admin/conformance/run` (self-test of
 * this gateway's `/mcp`) and the test suite.
 *
 * Every check is independent and reports `pass` / `fail` / `skip` with a reason; the run never throws.
 *
 * @module features/conformance
 */

import { PROTOCOL_VERSIONS } from '../mcp/compat.js';
import { registerFeature } from '../gateway/features.js';

export type CheckStatus = 'pass' | 'fail' | 'skip';
export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  detail?: string;
}
export interface ConformanceReport {
  url: string;
  startedAt: string;
  durationMs: number;
  passed: number;
  failed: number;
  skipped: number;
  checks: CheckResult[];
}
export interface ConformanceOptions {
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  /** Only run these check ids. */
  only?: string[];
}

interface Ctx {
  url: string;
  f: typeof fetch;
  headers: Record<string, string>;
  session?: string;
  version?: string;
}

interface Rpc {
  status: number;
  headers: Headers;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function post(ctx: Ctx, body: unknown, extra: Record<string, string> = {}): Promise<Rpc> {
  const res = await ctx.f(ctx.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...ctx.headers,
      ...(ctx.session ? { 'mcp-session-id': ctx.session } : {}),
      ...(ctx.version ? { 'mcp-protocol-version': ctx.version } : {}),
      ...extra,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('text/event-stream')) {
      const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
      parsed = data.length ? JSON.parse(data[data.length - 1]!) : undefined;
    } else {
      try { parsed = JSON.parse(text); } catch { parsed = text; }
    }
  }
  return { status: res.status, headers: res.headers, body: parsed };
}

const init = (version: string, id: number | string = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'mcp-gateway-conformance', version: '1' } },
});

class Fail extends Error {}
const expect = (cond: unknown, msg: string): void => {
  if (!cond) throw new Fail(msg);
};

interface Check {
  id: string;
  title: string;
  needsSession?: boolean;
  run: (ctx: Ctx) => Promise<string | void>;
}

export const CHECKS: Check[] = [
  {
    id: 'initialize',
    title: 'initialize negotiates the latest revision and returns a session id',
    run: async (ctx) => {
      const r = await post(ctx, init(PROTOCOL_VERSIONS[0]));
      expect(r.status === 200, `HTTP ${r.status}`);
      expect(r.body?.result?.protocolVersion, 'no result.protocolVersion');
      expect(r.body.result.serverInfo?.name, 'no serverInfo.name');
      expect(r.body.result.capabilities && typeof r.body.result.capabilities === 'object', 'no capabilities');
      return `protocol ${r.body.result.protocolVersion}`;
    },
  },
  {
    id: 'version-negotiation',
    title: 'every advertised revision is accepted; an unknown revision gets a supported one',
    run: async (ctx) => {
      const accepted: string[] = [];
      for (const v of PROTOCOL_VERSIONS) {
        const r = await post({ ...ctx, session: undefined, version: undefined }, init(v));
        if (r.body?.result?.protocolVersion === v) accepted.push(v);
      }
      expect(accepted.length > 0, 'no revision accepted');
      const r = await post({ ...ctx, session: undefined, version: undefined }, init('1999-01-01'));
      const got = r.body?.result?.protocolVersion;
      expect(typeof got === 'string' && (PROTOCOL_VERSIONS as readonly string[]).includes(got), `unknown revision answered with ${JSON.stringify(got)}`);
      return `accepted ${accepted.join(', ')}`;
    },
  },
  {
    id: 'parse-error',
    title: 'malformed JSON gets JSON-RPC -32700',
    run: async (ctx) => {
      const r = await post(ctx, '{not json');
      expect(r.body?.error?.code === -32700, `got ${JSON.stringify(r.body?.error ?? r.status)}`);
    },
  },
  {
    id: 'invalid-request',
    title: 'a non-JSON-RPC body gets -32600',
    run: async (ctx) => {
      const r = await post(ctx, { hello: 'world' });
      expect(r.body?.error?.code === -32600, `got ${JSON.stringify(r.body?.error ?? r.status)}`);
    },
  },
  {
    id: 'ping',
    title: 'ping answers with an empty result',
    needsSession: true,
    run: async (ctx) => {
      const r = await post(ctx, { jsonrpc: '2.0', id: 'p', method: 'ping' });
      expect(r.body?.id === 'p' && r.body?.result && typeof r.body.result === 'object', `got ${JSON.stringify(r.body)}`);
    },
  },
  {
    id: 'method-not-found',
    title: 'an unknown method gets -32601',
    needsSession: true,
    run: async (ctx) => {
      const r = await post(ctx, { jsonrpc: '2.0', id: 9, method: 'no/such/method' });
      expect(r.body?.error?.code === -32601, `got ${JSON.stringify(r.body?.error ?? r.body)}`);
    },
  },
  {
    id: 'notification-202',
    title: 'notifications are acknowledged with 202 and no body',
    needsSession: true,
    run: async (ctx) => {
      const r = await post(ctx, { jsonrpc: '2.0', method: 'notifications/initialized' });
      expect(r.status === 202, `HTTP ${r.status}`);
    },
  },
  {
    id: 'tools-list',
    title: 'tools/list returns tools with name and inputSchema',
    needsSession: true,
    run: async (ctx) => {
      const r = await post(ctx, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      const tools = r.body?.result?.tools;
      expect(Array.isArray(tools), `no result.tools: ${JSON.stringify(r.body).slice(0, 200)}`);
      for (const t of tools) expect(typeof t.name === 'string' && t.inputSchema && typeof t.inputSchema === 'object', `bad tool ${JSON.stringify(t).slice(0, 120)}`);
      return `${tools.length} tools`;
    },
  },
  {
    id: 'unknown-tool',
    title: 'calling an unknown tool is an error (JSON-RPC error or isError result)',
    needsSession: true,
    run: async (ctx) => {
      const r = await post(ctx, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: '__conformance_missing__', arguments: {} } });
      expect(r.body?.error || r.body?.result?.isError === true, `got ${JSON.stringify(r.body).slice(0, 200)}`);
    },
  },
  {
    id: 'bad-protocol-header',
    title: 'an unsupported MCP-Protocol-Version header is rejected with 400',
    needsSession: true,
    run: async (ctx) => {
      const r = await post(ctx, { jsonrpc: '2.0', id: 4, method: 'ping' }, { 'mcp-protocol-version': '1999-01-01' });
      expect(r.status === 400, `HTTP ${r.status}`);
    },
  },
  {
    id: 'unknown-session',
    title: 'a request with an unknown session id gets 404',
    run: async (ctx) => {
      const r = await post({ ...ctx, session: 'conformance-unknown-session' }, { jsonrpc: '2.0', id: 5, method: 'ping' });
      expect(r.status === 404, `HTTP ${r.status}`);
    },
  },
];

/** Run the suite against a Streamable HTTP MCP endpoint. */
export async function runConformance(url: string, opts: ConformanceOptions = {}): Promise<ConformanceReport> {
  const started = Date.now();
  const ctx: Ctx = { url, f: opts.fetch ?? fetch, headers: opts.headers ?? {} };
  const checks: CheckResult[] = [];
  const selected = CHECKS.filter((c) => !opts.only?.length || opts.only.includes(c.id));
  let sessionError: string | undefined;
  if (selected.some((c) => c.needsSession)) {
    try {
      const r = await post(ctx, init(PROTOCOL_VERSIONS[0]));
      ctx.session = r.headers.get('mcp-session-id') ?? undefined;
      ctx.version = r.body?.result?.protocolVersion;
      if (!ctx.version) sessionError = `initialize failed (HTTP ${r.status})`;
      else await post(ctx, { jsonrpc: '2.0', method: 'notifications/initialized' });
    } catch (e) {
      sessionError = `initialize failed: ${(e as Error).message}`;
    }
  }
  for (const c of selected) {
    if (c.needsSession && sessionError) {
      checks.push({ id: c.id, title: c.title, status: 'skip', detail: sessionError });
      continue;
    }
    try {
      const detail = await c.run(ctx);
      checks.push({ id: c.id, title: c.title, status: 'pass', ...(detail ? { detail } : {}) });
    } catch (e) {
      checks.push({ id: c.id, title: c.title, status: 'fail', detail: (e as Error).message });
    }
  }
  const n = (s: CheckStatus) => checks.filter((c) => c.status === s).length;
  return { url, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, passed: n('pass'), failed: n('fail'), skipped: n('skip'), checks };
}

/** Plain-text rendering for the CLI. */
export function formatReport(r: ConformanceReport): string {
  const mark = { pass: '✓', fail: '✗', skip: '-' } as const;
  return [
    `MCP conformance — ${r.url}`,
    ...r.checks.map((c) => `  ${mark[c.status]} ${c.id}: ${c.title}${c.detail ? ` (${c.detail})` : ''}`),
    `${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped in ${r.durationMs} ms`,
  ].join('\n');
}

registerFeature({
  id: 'conformance',
  since: '5.1.0',
  summary: 'MCP conformance self-test of this gateway\'s /mcp endpoint',
  mount: (router, ctx) => {
    router.get('/checks', (_req, res) => void res.json({ checks: CHECKS.map(({ id, title }) => ({ id, title })) }));
    router.post('/run', async (req, res) => {
      const base = ctx.baseUrl();
      if (!base) return void res.status(503).json({ error: 'Service Unavailable', message: 'gateway is not listening' });
      if (ctx.config().mcp?.enabled === false) return void res.status(409).json({ error: 'Conflict', message: 'the MCP endpoint is disabled (mcp.enabled: false)' });
      const only = Array.isArray((req.body as { only?: unknown })?.only) ? ((req.body as { only: unknown[] }).only.map(String)) : undefined;
      const headers: Record<string, string> = {};
      for (const h of ['authorization', 'x-api-key']) if (req.headers[h]) headers[h] = String(req.headers[h]);
      res.json(await runConformance(base + (ctx.config().mcp?.path ?? '/mcp'), { only, headers }));
    });
  },
});
