/** 4.2: tool chains and multi-agent orchestration. */
import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { Gateway } from '../src/gateway/index.js';
import { render, readPath, runChain, validateChains, chainToolResult, type ChainInvoke } from '../src/orchestration/chains.js';
import { validateConfig } from '../src/config/loader.js';
import { logger } from '../src/utils/logger.js';
import type { GatewayConfig } from '../src/utils/types.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
const text = (t: unknown) => ({ success: true, durationMs: 1, result: { content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t) }], structuredContent: t } });

describe('templates', () => {
  it('reads paths and renders typed / string templates', () => {
    const scope = { input: { q: 'x', n: 2, list: [{ a: 1 }] } };
    expect(readPath(scope, 'input.list.0.a')).toBe(1);
    expect(render('{{input.n}}', scope)).toBe(2);
    expect(render('q={{ input.q }}&n={{input.n}}&m={{input.missing}}', scope)).toBe('q=x&n=2&m=');
    expect(render({ a: ['{{input.list}}'] }, scope)).toEqual({ a: [[{ a: 1 }]] });
  });

  it('validates chains', () => {
    expect(validateChains({ chains: [{ name: 'a', steps: [{ tool: 'nope' }, { id: 'x', tool: 's/t' }, { id: 'x', parallel: [{ tool: 's/t' }] }, {}] }, { name: 'a', steps: [{ tool: 's/t' }] }] })).toEqual([
      'chains.chains.0.steps.0.tool: must be "server/tool"',
      'chains.chains.0.steps.2.id: duplicate step id "x"',
      'chains.chains.0.steps.3: a step needs exactly one of "tool" or "parallel"',
      'chains.chains.1.name: duplicate chain "a"',
    ]);
    expect(() => validateConfig({ chains: { chains: [{ name: 'c', steps: [{ tool: 'bad' }] }] } })).toThrow(/server\/tool/);
    expect(validateConfig({ chains: { chains: [{ name: 'c', steps: [{ tool: 's/t', args: { a: '{{input.a}}' } }] }] } }).chains!.chains![0]!.name).toBe('c');
  });
});

describe('runChain', () => {
  it('runs sequential, forEach (fan-out), parallel and conditional steps', async () => {
    const calls: string[] = [];
    const invoke: ChainInvoke = async (s, t, a) => {
      calls.push(`${s}/${t}:${JSON.stringify(a)}`);
      if (t === 'list') return text({ items: ['a', 'b', 'c'] });
      return text({ echoed: a });
    };
    const r = await runChain(
      {
        name: 'demo',
        steps: [
          { id: 'l', tool: 'src/list', args: { q: '{{input.q}}' } },
          { id: 'each', forEach: 'steps.l.structuredContent.items', concurrency: 2, tool: 'agent/summarise', args: { item: '{{item}}', i: '{{index}}' } },
          { parallel: [{ id: 'p1', tool: 'x/one' }, { id: 'p2', tool: 'x/two' }] },
          { id: 'skipped', when: 'input.file', tool: 'gh/create' },
          { id: 'neg', when: '!input.file', tool: 'gh/note', args: { n: '{{steps.each.length}}' } },
        ],
        output: { first: '{{steps.each.0.structuredContent.echoed.item}}', count: '{{steps.each.length}}' },
      },
      { q: 'hi' },
      invoke,
    );
    expect(r.success).toBe(true);
    expect(r.output).toEqual({ first: 'a', count: 3 });
    expect(r.steps.map((s) => `${s.id}:${s.status}:${s.calls}`)).toEqual(['l:ok:1', 'each:ok:3', 'p1:ok:1', 'p2:ok:1', 'skipped:skipped:0', 'neg:ok:1']);
    expect(calls[0]).toBe('src/list:{"q":"hi"}');
    expect(calls).toContain('gh/note:{"n":3}');
    expect(chainToolResult(r).structuredContent).toMatchObject({ output: { first: 'a', count: 3 } });
  });

  it('stops on the first failure unless continueOnError', async () => {
    const invoke: ChainInvoke = async (_s, t) => (t === 'bad' ? { success: false, durationMs: 1, error: { code: -1, message: 'boom' } } : text('ok'));
    const stop = await runChain({ name: 'x', steps: [{ id: 'a', tool: 's/bad' }, { id: 'b', tool: 's/good' }] }, {}, invoke);
    expect(stop).toMatchObject({ success: false, error: 'step "a" failed: boom' });
    expect(stop.steps).toHaveLength(1);
    expect(chainToolResult(stop)).toMatchObject({ isError: true });
    const go = await runChain({ name: 'x', steps: [{ id: 'a', tool: 's/bad', continueOnError: true }, { id: 'b', tool: 's/good' }] }, {}, invoke);
    expect(go.success).toBe(true);
    expect(go.output).toMatchObject({ text: 'ok' });
  });
});

describe('chains in the gateway', () => {
  let gw: Gateway | undefined;
  afterEach(async () => {
    await gw?.stop();
    gw = undefined;
  });

  it('runs over REST and /mcp as the caller, honouring scopes', async () => {
    gw = new Gateway({
      port: 0,
      host: '127.0.0.1',
      logLevel: 'error',
      monitor: { requestLog: false },
      auth: { strategy: 'api-key', apiKeys: ['op', { key: 'other', servers: ['nope'] }] },
      servers: [{ id: 'fake', name: 'fake', transport: 'stdio', command: process.execPath, args: [fixture], timeout: 5000 }],
      chains: { chains: [{ name: 'twice', description: 'echo twice', steps: [{ id: 'a', tool: 'fake/echo', args: { v: '{{input.v}}' } }, { id: 'b', tool: 'fake/echo', args: { prev: '{{steps.a.text}}' } }] }] },
    } as GatewayConfig);
    await gw.start();
    const url = `http://127.0.0.1:${gw.address()!.port}`;
    const h = { authorization: 'Bearer op', 'content-type': 'application/json' };
    const list = (await (await fetch(`${url}/api/v1/chains`, { headers: h })).json()) as { chains: Array<{ tool: string; allowed: boolean }> };
    expect(list.chains).toEqual([expect.objectContaining({ tool: 'chain_twice', allowed: true })]);
    const run = (await (await fetch(`${url}/api/v1/chains/twice/run`, { method: 'POST', headers: h, body: JSON.stringify({ input: { v: 7 } }) })).json()) as { success: boolean; output: { text: string } };
    expect(run.success).toBe(true);
    expect(JSON.parse(run.output.text)).toEqual({ prev: '{"v":7}' });
    expect((await fetch(`${url}/api/v1/chains/none/run`, { method: 'POST', headers: h, body: '{}' })).status).toBe(404);
    expect((await fetch(`${url}/api/v1/chains/twice/run`, { method: 'POST', headers: { ...h, authorization: 'Bearer other' }, body: '{}' })).status).toBe(403);

    // /mcp: the chain is a tool.
    const mh = { ...h, accept: 'application/json, text/event-stream' };
    const init = await fetch(`${url}/mcp`, { method: 'POST', headers: mh, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) });
    const sid = init.headers.get('mcp-session-id')!;
    const sh = { ...mh, 'mcp-session-id': sid };
    await fetch(`${url}/mcp`, { method: 'POST', headers: sh, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    const tools = (await (await fetch(`${url}/mcp`, { method: 'POST', headers: sh, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) })).json()) as { result: { tools: Array<{ name: string }> } };
    expect(tools.result.tools.map((t) => t.name)).toContain('chain_twice');
    const called = (await (await fetch(`${url}/mcp`, { method: 'POST', headers: sh, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'chain_twice', arguments: { v: 1 } } }) })).json()) as { result: { content: Array<{ text: string }>; structuredContent: { steps: unknown[] } } };
    expect(JSON.parse(called.result.content[0]!.text)).toEqual({ prev: '{"v":1}' });
    expect(called.result.structuredContent.steps).toHaveLength(2);
  }, 30_000);
});
