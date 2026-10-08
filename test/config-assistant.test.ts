/** 8.7: natural-language config assistant. */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';
import { validateConfig } from '../src/config/loader.js';
import { parseInstruction, mergePatch, withoutSecrets } from '../src/features/config-assistant.js';

let h: FeatureGw | undefined;
let llm: Server | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
  await new Promise<void>((r) => (llm ? llm.close(() => r()) : r()));
  llm = undefined;
});
const run = (text: string) => {
  const c: Record<string, unknown> = { servers: [] };
  parseInstruction(text)!.apply(c);
  return c;
};

describe('config assistant (8.7)', () => {
  it('phrasebook', () => {
    expect(run('Rate limit to 50 requests per minute.')).toMatchObject({ rateLimit: { limit: 50, windowSeconds: 60 } });
    expect(run('block github/delete_* for key:intern')).toMatchObject({ policy: { rules: [{ effect: 'deny', servers: ['github'], tools: ['delete_*'], clients: ['key:intern'] }] } });
    expect(run('require approval for payments/*')).toMatchObject({ policy: { rules: [{ effect: 'approve', servers: ['payments'], tools: ['*'] }] } });
    expect(run('cache search/query for 5 minutes')).toMatchObject({ cache: { enabled: true, rules: [{ servers: ['search'], tools: ['query'], ttlSeconds: 300 }] } });
    expect(run('add server docs at https://docs.example.com/mcp')).toMatchObject({ servers: [{ id: 'docs', transport: 'streamable-http', url: 'https://docs.example.com/mcp' }] });
    expect(run('enable audit logging')).toMatchObject({ audit: { enabled: true } });
    expect(run('set log level to debug')).toMatchObject({ logLevel: 'debug' });
    expect(parseInstruction('make it faster')).toBeUndefined();
    expect(mergePatch({ a: 1, b: { c: 2, d: 3 } }, { b: { c: null, e: 4 }, f: [1] })).toEqual({ a: 1, b: { d: 3, e: 4 }, f: [1] });
    expect(withoutSecrets({ auth: { apiKeys: [{ key: 'sk-1', name: 'a' }] }, token: 't' })).toEqual({ auth: { apiKeys: [{ key: '<redacted>', name: 'a' }] }, token: '<redacted>' });
    expect(validateConfig({ version: 9, servers: [], configAssistant: { llm: { baseUrl: 'https://x.example/v1', model: 'm' } } }).configAssistant).toBeDefined();
  });

  it('plan (dry run) then apply; stale plans are refused', async () => {
    h = await startFeatureGw({ configAssistant: {} } as never);
    const plan = await h.admin('config-assistant/plan', { text: 'Rate limit to 7 per second. Set log level to warn.\nmake it pretty' });
    expect(plan.body).toMatchObject({ valid: true, unparsed: ['make it pretty'] });
    expect(plan.body.steps.map((s: { summary: string }) => s.summary)).toEqual(['rate limit 7 per 1s per key', 'log level warn']);
    expect(JSON.stringify(plan.body.changes)).toContain('rateLimit');
    expect(h.gw['config'].rateLimit?.limit).not.toBe(7); // dry run
    const bad = await h.admin('config-assistant/plan', { text: 'remove server nope' });
    expect(bad.body).toMatchObject({ valid: false, errors: ['remove server nope: no server "nope"'] });
    const applied = await h.admin('config-assistant/apply', { planId: plan.body.planId });
    expect(applied.body.applied).toBe(true);
    expect(h.gw['config'].rateLimit?.limit).toBe(7);
    expect((await h.admin('config-assistant/apply', { planId: plan.body.planId })).status).toBe(404);
    const p2 = await h.admin('config-assistant/plan', { text: 'set log level to error' });
    await h.admin('config-assistant/apply', { planId: (await h.admin('config-assistant/plan', { text: 'set log level to info' })).body.planId });
    expect((await h.admin('config-assistant/apply', { planId: p2.body.planId })).status).toBe(409);
  });

  it('falls back to an OpenAI-compatible LLM for free text (secrets redacted)', async () => {
    let seen = '';
    llm = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        seen = body;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: '{"monitor":{"prometheus":true}}' } }] }));
      });
    });
    await new Promise<void>((r) => llm!.listen(0, '127.0.0.1', () => r()));
    const port = (llm.address() as { port: number }).port;
    h = await startFeatureGw({ configAssistant: { llm: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'test-model', apiKey: 'llm-key' } } } as never);
    const plan = await h.admin('config-assistant/plan', { text: 'turn on prometheus metrics please' });
    expect(plan.body).toMatchObject({ valid: true, unparsed: [], steps: [{ source: 'llm', summary: 'LLM patch: monitor' }] });
    expect(seen).toContain('test-model');
    expect(seen).not.toContain('"op"'); // the operator API key is not sent
    expect(seen).toContain('<redacted>');
  });
});
