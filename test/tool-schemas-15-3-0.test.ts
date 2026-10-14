/**
 * 15.3.0-canary.0: AI generation governance, first step — tool schema governance (TESTS FIRST).
 *
 *  J1–J3 a dependency-free JSON Schema validator (the subset tool schemas use) and a canonical tool schema digest.
 *  O1–O5 `policy.toolSchemas.validateOutput`: `off` (default, unchanged), `audit` (pass through, counted, logged) or
 *        `enforce` (a tool result whose `structuredContent` does not match the tool's `outputSchema` is refused with
 *        -32005 and audited as `output-schema`; nothing of the invalid result reaches the client).
 *  P1–P4 `policy.toolSchemas.pins`: `server/tool` → sha256 of the tool's schemas. A call to a tool whose schema no longer
 *        matches its pin is refused BEFORE the upstream call (`schema-drift`) or, with `onDrift: audit`, passed and
 *        reported; `GET /api/v1/admin/ops/tool-schemas` lists every tool's digest, pin state and violation counts.
 *  V1    config validation of the new keys.
 * Additive only: without `policy.toolSchemas` nothing changes; no frozen route, field or schema key changes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { validateJsonSchema, toolSchemaDigest } from '../src/policy/json-schema.js';
import { validateConfig } from '../src/config/loader.js';
import { startFeatureGw, fakeServer, type FeatureGw } from './helpers/feature-gw.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const WEATHER_OUT = { type: 'object', properties: { tempC: { type: 'number' }, city: { type: 'string' } }, required: ['tempC'], additionalProperties: false };

describe('JSON Schema subset validator (15.3.0-canary.0)', () => {
  it('J1 types, required, properties, additionalProperties, enum / const, arrays, numbers, strings', () => {
    const ok = (s: unknown, v: unknown) => expect(validateJsonSchema(s, v).valid, JSON.stringify({ s, v })).toBe(true);
    const bad = (s: unknown, v: unknown, path?: string) => {
      const r = validateJsonSchema(s, v);
      expect(r.valid, JSON.stringify({ s, v })).toBe(false);
      if (path !== undefined) expect(r.errors.map((e) => e.path)).toContain(path);
    };
    ok(WEATHER_OUT, { tempC: 21.5, city: 'Oslo' });
    bad(WEATHER_OUT, { city: 'Oslo' }, '');
    bad(WEATHER_OUT, { tempC: '21' }, '/tempC');
    bad(WEATHER_OUT, { tempC: 1, wind: 3 }, '/wind');
    ok({ type: 'integer' }, 3);
    bad({ type: 'integer' }, 3.5);
    ok({ type: ['string', 'null'] }, null);
    bad({ type: ['string', 'null'] }, 1);
    ok({ enum: ['a', 'b'] }, 'b');
    bad({ enum: ['a', 'b'] }, 'c');
    ok({ const: { x: [1] } }, { x: [1] });
    bad({ const: { x: [1] } }, { x: [2] });
    ok({ type: 'array', items: { type: 'number' }, minItems: 1, maxItems: 2 }, [1, 2]);
    bad({ type: 'array', items: { type: 'number' } }, [1, 'x'], '/1');
    bad({ type: 'array', minItems: 1 }, []);
    bad({ type: 'array', uniqueItems: true }, [1, 1]);
    ok({ type: 'number', minimum: 0, maximum: 10, exclusiveMaximum: 11, multipleOf: 0.5 }, 9.5);
    bad({ type: 'number', exclusiveMinimum: 0 }, 0);
    bad({ type: 'number', multipleOf: 2 }, 3);
    ok({ type: 'string', minLength: 2, maxLength: 3, pattern: '^[a-z]+$' }, 'abc');
    bad({ type: 'string', pattern: '^[a-z]+$' }, 'ABC');
    bad({ type: 'string', maxLength: 1 }, '你好');
    ok({ type: 'object', propertyNames: { pattern: '^x' }, minProperties: 1, maxProperties: 1 }, { xa: 1 });
    bad({ type: 'object', propertyNames: { pattern: '^x' } }, { y: 1 });
    ok({ type: 'object', additionalProperties: { type: 'number' } }, { a: 1 });
    bad({ type: 'object', additionalProperties: { type: 'number' } }, { a: 'x' }, '/a');
  });

  it('J2 combinators, $ref to local $defs / definitions, boolean schemas, unknown keywords ignored, bounded', () => {
    const s = { $defs: { pos: { type: 'number', minimum: 0 } }, type: 'object', properties: { a: { $ref: '#/$defs/pos' }, b: { $ref: '#/definitions/n' } }, definitions: { n: { type: 'null' } } };
    expect(validateJsonSchema(s, { a: 1, b: null }).valid).toBe(true);
    expect(validateJsonSchema(s, { a: -1 }).valid).toBe(false);
    expect(validateJsonSchema({ anyOf: [{ type: 'string' }, { type: 'number' }] }, true).valid).toBe(false);
    expect(validateJsonSchema({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 1).valid).toBe(false); // both match
    expect(validateJsonSchema({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 1.5).valid).toBe(true);
    expect(validateJsonSchema({ allOf: [{ type: 'number' }, { minimum: 2 }] }, 1).valid).toBe(false);
    expect(validateJsonSchema({ not: { type: 'string' } }, 's').valid).toBe(false);
    expect(validateJsonSchema({ if: { type: 'string' }, then: { minLength: 2 }, else: { type: 'number' } }, 'a').valid).toBe(false);
    expect(validateJsonSchema({ if: { type: 'string' }, then: { minLength: 2 }, else: { type: 'number' } }, 3).valid).toBe(true);
    expect(validateJsonSchema(true, 1).valid).toBe(true);
    expect(validateJsonSchema(false, 1).valid).toBe(false);
    expect(validateJsonSchema({ type: 'string', format: 'email', 'x-vendor': 1, title: 't' }, 'not-an-email').valid).toBe(true); // format: annotation only
    // an unresolvable $ref is a schema error, reported as invalid (never silently valid)
    expect(validateJsonSchema({ $ref: 'https://example.com/s.json' }, 1)).toMatchObject({ valid: false, errors: [{ message: expect.stringMatching(/unsupported \$ref/) }] });
    // a self-referencing schema terminates; at most 20 errors are reported
    const loop = { $defs: { l: { $ref: '#/$defs/l' } }, $ref: '#/$defs/l' };
    expect(validateJsonSchema(loop, 1).valid).toBe(false);
    const many = validateJsonSchema({ type: 'array', items: { type: 'string' } }, Array.from({ length: 100 }, (_, i) => i));
    expect(many.errors.length).toBe(20);
  });

  it('J3 toolSchemaDigest: sha256 over the canonical input + output schemas (key order does not matter)', () => {
    const a = toolSchemaDigest({ inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, outputSchema: WEATHER_OUT });
    const b = toolSchemaDigest({ outputSchema: { additionalProperties: false, required: ['tempC'], properties: { city: { type: 'string' }, tempC: { type: 'number' } }, type: 'object' }, inputSchema: { properties: { q: { type: 'string' } }, type: 'object' } });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
    expect(toolSchemaDigest({ inputSchema: { type: 'object' }, outputSchema: WEATHER_OUT })).not.toBe(a);
    expect(toolSchemaDigest({ inputSchema: { type: 'object', properties: { q: { type: 'string' } } } })).not.toBe(a);
    expect(toolSchemaDigest({})).toMatch(/^[0-9a-f]{64}$/);
  });
});

const K = 'k-op-SECRET';
const hdr = { authorization: `Bearer ${K}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
async function start(toolSchemas?: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  h = await startFeatureGw({
    servers: [fakeServer('wx', { SCHEMA_TOOLS: '1' })],
    auth: { strategy: 'api-key', apiKeys: [{ key: K, name: 'ops' }, { key: 'k-dev', name: 'dev', servers: ['wx'] }] },
    monitor: { requestLog: true },
    ...(toolSchemas ? { policy: { toolSchemas } } : {}),
    ...extra,
  } as never);
  return h;
}
const call = async (tool: string, args: Record<string, unknown> = {}, key = K) => {
  const r = await fetch(`${h!.base}/api/v1/tools/call`, { method: 'POST', headers: { ...hdr, authorization: `Bearer ${key}` }, body: JSON.stringify({ server: 'wx', tool, arguments: args }) });
  return { status: r.status, body: (await r.json()) as any };
};
const schemas = async (key = K) => {
  const r = await fetch(`${h!.base}/api/v1/admin/ops/tool-schemas`, { headers: { ...hdr, authorization: `Bearer ${key}` } });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};
const lineageOf = async (requestId: string) => (await (await fetch(`${h!.base}/api/v1/admin/ops/lineage/${encodeURIComponent(requestId)}`, { headers: hdr })).json()) as any;

describe('policy.toolSchemas.validateOutput (15.3.0-canary.0)', { timeout: 30_000 }, () => {
  it('O1 default (no toolSchemas): an invalid structuredContent passes through unchanged', async () => {
    await start();
    const r = await call('weather', { out: { tempC: 'warm' } });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).toContain('warm');
  });

  it('O2 enforce: a valid result passes; an invalid or missing structuredContent is refused (-32005 → REST 502, output-schema) without leaking it', async () => {
    await start({ validateOutput: 'enforce' });
    const good = await call('weather', { out: { tempC: 3, city: 'Oslo' } });
    expect(good.status).toBe(200);
    expect(JSON.stringify(good.body)).toContain('Oslo');
    const bad = await call('weather', { out: { tempC: 'warm', city: 'SECRET-CITY' } });
    expect(bad.status).toBe(502); // a blocked tool output answers 502 on REST (13.1.2 mapping, same as policy.outputFilter)
    expect(JSON.stringify(bad.body)).toMatch(/-32005/);
    expect(JSON.stringify(bad.body)).toMatch(/outputSchema/);
    expect(JSON.stringify(bad.body)).not.toContain('SECRET-CITY');
    expect(JSON.stringify(bad.body)).toContain('/tempC');
    const missing = await call('weather', { omit: true });
    expect(missing.status).toBe(502);
    expect(JSON.stringify(missing.body)).toMatch(/structuredContent/);
    // a tool without outputSchema and an isError result are not validated
    expect((await call('echo', { a: 1 })).status).toBe(200);
    expect((await call('weather', { isError: true, out: { tempC: 'x' } })).status).toBe(200);
    const s = await schemas();
    const wx = s.body.tools.find((t: any) => t.server === 'wx' && t.tool === 'weather');
    expect(wx.violations).toBe(2);
  });

  it('O3 audit: an invalid result passes through and is counted', async () => {
    await start({ validateOutput: 'audit' });
    const r = await call('weather', { out: { tempC: 'warm' } });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).toContain('warm');
    const s = await schemas();
    expect(s.body.validateOutput).toBe('audit');
    expect(s.body.tools.find((t: any) => t.tool === 'weather').violations).toBe(1);
  });

  it('O4 enforce over /mcp: the client gets an error, not the invalid structuredContent', async () => {
    await start({ validateOutput: 'enforce' });
    const post = (body: unknown, extra: Record<string, string> = {}) => fetch(`${h!.base}/mcp`, { method: 'POST', headers: { ...hdr, ...extra }, body: JSON.stringify(body) });
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    const sid = init.headers.get('mcp-session-id')!;
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': sid });
    const list = JSON.parse(await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': sid })).text());
    const name = list.result.tools.map((t: any) => t.name).find((n: string) => /weather/.test(n));
    const res = JSON.parse(await (await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: { out: { tempC: 'warm', city: 'SECRET-CITY' } } } }, { 'mcp-session-id': sid })).text());
    expect(JSON.stringify(res)).not.toContain('SECRET-CITY');
    expect(res.error?.code === -32005 || res.result?.isError === true).toBe(true);
  });

  it('O5 tools: scopes validation to server/tool globs', async () => {
    await start({ validateOutput: 'enforce', tools: ['other/*'] });
    expect((await call('weather', { out: { tempC: 'warm' } })).status).toBe(200);
  });
});

describe('policy.toolSchemas.pins (15.3.0-canary.0)', { timeout: 30_000 }, () => {
  it('P1 GET /admin/ops/tool-schemas lists each tool digest (operators only); a matching pin lets the call through', async () => {
    await start();
    const s = await schemas();
    expect(s.status).toBe(200);
    const wx = s.body.tools.find((t: any) => t.server === 'wx' && t.tool === 'weather');
    expect(wx).toMatchObject({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/), outputSchema: true, pinned: false, drift: false });
    expect(s.body.tools.find((t: any) => t.tool === 'echo')).toMatchObject({ outputSchema: false });
    expect((await schemas('k-dev')).status).toBe(403);
    await h!.stop();
    await start({ pins: { 'wx/weather': wx.sha256 } });
    expect((await call('weather', { out: { tempC: 1 } })).status).toBe(200);
    expect((await schemas()).body.tools.find((t: any) => t.tool === 'weather')).toMatchObject({ pinned: true, drift: false });
  });

  it('P2 drift (default onDrift: block): the call is refused before the upstream call, audited as schema-drift', async () => {
    await start({ pins: { 'wx/weather': '0'.repeat(64) } });
    const r = await call('weather', { out: { tempC: 1 } });
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).toMatch(/schema-drift|no longer matches its pin/);
    const s = await schemas();
    expect(s.body.tools.find((t: any) => t.tool === 'weather')).toMatchObject({ pinned: true, drift: true });
    // other tools of the server are not affected
    expect((await call('echo', { a: 1 })).status).toBe(200);
    if (r.body.requestId) expect((await lineageOf(r.body.requestId)).upstream ?? null).toBeNull();
  });

  it('P3 onDrift: audit — the drifted call proceeds and is reported', async () => {
    await start({ pins: { 'wx/weather': 'f'.repeat(64) }, onDrift: 'audit' });
    expect((await call('weather', { out: { tempC: 1 } })).status).toBe(200);
    expect((await schemas()).body.tools.find((t: any) => t.tool === 'weather')).toMatchObject({ drift: true, driftCalls: 1 });
  });

  it('P4 a pin for a tool the server does not list is reported as missing', async () => {
    await start({ pins: { 'wx/ghost': 'a'.repeat(64) } });
    const s = await schemas();
    expect(s.body.missing).toEqual(['wx/ghost']);
  });
});

describe('config (15.3.0-canary.0)', () => {
  it('V1 policy.toolSchemas keys are validated', () => {
    const v = (toolSchemas: unknown) => () => validateConfig({ servers: [], policy: { toolSchemas } } as never);
    expect(v({ validateOutput: 'enforce', tools: ['a/*'], pins: { 'a/b': 'c'.repeat(64) }, onDrift: 'audit' })).not.toThrow();
    expect(v({ validateOutput: 'strict' })).toThrow();
    expect(v({ pins: { 'a/b': 'xyz' } })).toThrow();
    expect(v({ pins: { nosep: 'c'.repeat(64) } })).toThrow();
    expect(v({ onDrift: 'ignore' })).toThrow();
    expect(v({ unknown: 1 })).toThrow();
  });
});
