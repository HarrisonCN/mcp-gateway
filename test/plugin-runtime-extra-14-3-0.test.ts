/**
 * 14.3.0 plugin security runtime — capabilities beyond R1-R10:
 *  X1 runtime: process — process.exit / heap blow-up end only the child; Node permission model denies fs outside the
 *     plugin directory; permissions.fs.read opens a path
 *  X2 permissions.network (false / allow-list) and permissions.env in a worker
 *  X3 permissions.hooks, permissions.response: read, child_process / nested workers refused in isolated runtimes
 *  X4 limits.maxConcurrent → busy (failure policy, not counted by the breaker); half-open trial closes the circuit
 *  X5 isolation: worker alias; inline plugins keep working (deprecation note only); onRequest refused in a worker;
 *     per-hook failure policy
 *  X6 a crashing worker plugin inside a running gateway: the gateway keeps serving (/health, other calls)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { Gateway } from '../src/gateway/index.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { writeFileSync, mkdtempSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from 'net';
import { PluginHost, loadPlugin, pluginRuntimeOf } from '../src/plugins/index.js';
import { validateConfig } from '../src/config/loader.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const dir = () => mkdtempSync(join(tmpdir(), 'mgw-143x-'));
const call = (over: Record<string, unknown> = {}) => ({ serverId: 's', name: 't', kind: 'tool' as const, method: 'tools/call', arguments: { a: 1 }, via: 'rest' as const, state: new Map(), ...over });
const write = (d: string, f: string, src: string) => (writeFileSync(join(d, f), src), `./${f}`);
const run = async (cfg: Record<string, unknown>, d: string, c = call()) => {
  const p = await loadPlugin(cfg as never, d);
  const host = new PluginHost();
  await host.set([p]);
  try {
    const r = await host.beforeCall(c).catch((e: Error) => ({ error: e.message }));
    return { r, c, host, p };
  } finally {
    await host.close();
  }
};

describe('X1 runtime: process', () => {
  it('exit and OOM end only the child process; fs is limited by the Node permission model', async () => {
    const d = dir();
    const outside = mkdtempSync(join(tmpdir(), 'mgw-143x-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'top-secret');
    const exit = write(d, 'exit.mjs', `export default { name: 'pexit', apiVersion: 5, onToolCall: () => { process.exit(7); } };`);
    const p = await loadPlugin({ module: exit, runtime: 'process' } as never, d);
    expect(pluginRuntimeOf(p)).toBe('process');
    const host = new PluginHost();
    await host.set([p]);
    await expect(host.beforeCall(call())).rejects.toThrow(/plugin "pexit" crashed: exited with code 7/i);
    await host.close();

    const mem = write(d, 'mem.mjs', `const keep = []; export default { name: 'pmem', apiVersion: 5, onToolCall: () => { for (;;) keep.push(new Array(1e6).fill(Math.random())); } };`);
    const { r: rm } = await run({ module: mem, runtime: 'process', limits: { memoryMb: 48, timeoutMs: 8000 } }, d);
    expect(JSON.stringify(rm)).toMatch(/memory/i);

    const src = `import { readFileSync } from 'node:fs'; export default { name: 'pfs', apiVersion: 5, onToolCall: (c) => { try { c.state.set('r', readFileSync(${JSON.stringify(join(outside, 'secret.txt'))}, 'utf8')); } catch (e) { c.state.set('r', 'denied:' + (e.code || e.message)); } return { action: 'continue' }; } };`;
    const fsm = write(d, 'fs.mjs', src);
    const denied = await run({ module: fsm, runtime: 'process' }, d);
    expect(String(denied.c.state.get('r'))).toMatch(/^denied:ERR_ACCESS_DENIED/);
    const allowed = await run({ module: fsm, runtime: 'process', permissions: { fs: { read: [outside] } } }, d);
    expect(allowed.c.state.get('r')).toBe('top-secret');
  }, 30000);
});

describe('X2 network and env in a worker', () => {
  it('permissions.network false / allow-list and permissions.env', async () => {
    const srv = createServer((s) => s.end('hi'));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    const d = dir();
    const net = write(d, 'net.mjs', `import { connect } from 'node:net'; export default { name: 'net', apiVersion: 5, onToolCall: (c) => new Promise((res) => { try { const s = connect(${port}, '127.0.0.1'); s.on('data', () => { c.state.set('n', 'connected'); s.destroy(); res(); }); s.on('error', (e) => { c.state.set('n', 'error:' + e.message); res(); }); } catch (e) { c.state.set('n', 'denied:' + e.message); res(); } }) };`);
    expect((await run({ module: net, runtime: 'worker' }, d)).c.state.get('n')).toBe('connected');
    expect(String((await run({ module: net, runtime: 'worker', permissions: { network: false } }, d)).c.state.get('n'))).toMatch(/denied:.*permissions\.network/);
    expect(String((await run({ module: net, runtime: 'worker', permissions: { network: ['api.example.com'] } }, d)).c.state.get('n'))).toMatch(/denied/);
    expect((await run({ module: net, runtime: 'worker', permissions: { network: [`127.0.0.1:${port}`] } }, d)).c.state.get('n')).toBe('connected');
    const ft = write(d, 'fetch.mjs', `export default { name: 'fetch', apiVersion: 5, onToolCall: async (c) => { try { await fetch('http://127.0.0.1:${port}/'); c.state.set('f', 'fetched'); } catch (e) { c.state.set('f', 'denied:' + (e.cause?.message ?? e.message)); } } };`);
    expect(String((await run({ module: ft, runtime: 'worker', permissions: { network: false } }, d)).c.state.get('f'))).toMatch(/denied:.*permissions\.network/);
    srv.close();

    process.env.MGW143X_OK = 'visible';
    process.env.MGW143X_HIDDEN = 'hidden';
    const env = write(d, 'env.mjs', `export default { name: 'env', apiVersion: 5, onToolCall: (c) => { c.state.set('ok', process.env.MGW143X_OK ?? null); c.state.set('hidden', process.env.MGW143X_HIDDEN ?? null); } };`);
    const e1 = await run({ module: env, runtime: 'worker', permissions: { env: ['MGW143X_OK'] } }, d);
    expect([e1.c.state.get('ok'), e1.c.state.get('hidden')]).toEqual(['visible', null]);
    const e2 = await run({ module: env, runtime: 'worker' }, d);
    expect([e2.c.state.get('ok'), e2.c.state.get('hidden')]).toEqual([null, null]);
  }, 30000);
});

describe('X3 hooks, response, escape hatches', () => {
  it('permissions.hooks / response: read; child_process and nested workers refused', async () => {
    const d = dir();
    const m = write(d, 'resp.mjs', `export default { name: 'resp', apiVersion: 5, onToolCall: () => ({ action: 'deny', reason: 'tc' }), onResponse: () => ({ action: 'replace', result: 'changed' }) };`);
    const p = await loadPlugin({ module: m, runtime: 'worker', permissions: { hooks: ['onResponse'], response: 'read' } } as never, d);
    const host = new PluginHost();
    await host.set([p]);
    expect(await host.beforeCall(call())).toBeUndefined();
    const res = await host.afterCall(call(), { success: true, result: 'orig' } as never);
    expect((res as { result: unknown }).result).toBe('orig');
    await host.close();
    const w = await run({ module: m, runtime: 'worker', permissions: { response: 'write' } }, d);
    expect(JSON.stringify(w.r)).toMatch(/tc/);

    const esc = write(d, 'esc.mjs', `import { execSync } from 'node:child_process'; import { Worker } from 'node:worker_threads'; export default { name: 'esc', apiVersion: 5, onToolCall: (c) => { for (const [k, f] of [['cp', () => execSync('id')], ['wt', () => new Worker('1', { eval: true })]]) { try { f(); c.state.set(k, 'ran'); } catch (e) { c.state.set(k, 'refused'); } } } };`);
    const e = await run({ module: esc, runtime: 'worker' }, d);
    expect([e.c.state.get('cp'), e.c.state.get('wt')]).toEqual(['refused', 'refused']);
  }, 20000);
});

describe('X4 concurrency and breaker recovery', () => {
  it('maxConcurrent sheds load as "busy"; a successful half-open trial closes the circuit', async () => {
    const d = dir();
    const slow = write(d, 'slow.mjs', `export default { name: 'slow', apiVersion: 5, onToolCall: () => new Promise((r) => setTimeout(r, 300)) };`);
    const p = await loadPlugin({ module: slow, runtime: 'worker', failure: 'closed', limits: { maxConcurrent: 1, maxFailures: 1 } } as never, d);
    const host = new PluginHost();
    await host.set([p]);
    const first = host.beforeCall(call());
    await expect(host.beforeCall(call())).rejects.toThrow(/busy/);
    await expect(first).resolves.toBeUndefined();
    expect(host.status()[0]).toMatchObject({ circuit: 'closed', failures: 0 }); // busy is not a plugin failure
    await host.close();

    const flaky = write(d, 'flaky2.mjs', `export default { name: 'flaky2', apiVersion: 5, onToolCall: (c) => { if (c.arguments.fail) throw new Error('nope'); } };`);
    const f = await loadPlugin({ module: flaky, runtime: 'worker', limits: { maxFailures: 1, cooldownMs: 200 } } as never, d);
    const h = new PluginHost();
    await h.set([f]);
    await expect(h.beforeCall(call({ arguments: { fail: true } }))).rejects.toThrow(/nope/);
    await expect(h.beforeCall(call())).rejects.toThrow(/circuit open/);
    expect(h.status()[0]).toMatchObject({ circuit: 'open', failures: 1, runtime: 'worker' });
    await new Promise((r) => setTimeout(r, 250));
    expect(h.status()[0].circuit).toBe('half-open');
    await expect(h.beforeCall(call())).resolves.toBeUndefined();
    expect(h.status()[0]).toMatchObject({ circuit: 'closed', failures: 0 });
    await h.close();
  }, 20000);
});

describe('X5 compatibility and config', () => {
  it('isolation: worker alias, inline unchanged, onRequest refused in a worker, per-hook failure policy', async () => {
    const d = dir();
    const m = write(d, 'plain.mjs', `export default { name: 'plain', apiVersion: 5, onToolCall: (c) => ({ action: 'rewrite', arguments: { ...c.arguments, x: process.pid } }) };`);
    const iso = await run({ module: m, isolation: 'worker' }, d);
    expect(pluginRuntimeOf(iso.p)).toBe('worker');
    expect((iso.c.arguments as { x: number }).x).toBe(process.pid); // same pid: a thread, not a process
    const inline = await run({ module: m }, d);
    expect(pluginRuntimeOf(inline.p)).toBe('inline');
    expect((inline.c.arguments as { x: number }).x).toBe(process.pid);
    const proc = await run({ module: m, runtime: 'process' }, d);
    expect((proc.c.arguments as { x: number }).x).not.toBe(process.pid);

    const http = write(d, 'http.mjs', `export default { name: 'http', apiVersion: 5, onRequest: (q, s, n) => n() };`);
    await expect(loadPlugin({ module: http, runtime: 'worker' } as never, d)).rejects.toThrow(/onRequest/);

    const both = write(d, 'both.mjs', `export default { name: 'both', apiVersion: 5, onToolCall: () => { throw new Error('tc-fail'); }, onResponse: () => { throw new Error('resp-fail'); } };`);
    const p = await loadPlugin({ module: both, runtime: 'worker', failure: { onToolCall: 'closed', onResponse: 'open' } } as never, d);
    const host = new PluginHost();
    await host.set([p]);
    await expect(host.beforeCall(call())).rejects.toThrow(/tc-fail/);
    await expect(host.afterCall(call(), { success: true, result: 'r' } as never)).resolves.toMatchObject({ result: 'r' });
    await host.close();

    const base = { version: 12, servers: [] } as Record<string, unknown>;
    expect(() => validateConfig({ ...base, plugins: [{ module: './p.mjs', isolation: 'worker', limits: { memoryMb: 64 } }] })).not.toThrow();
    expect(() => validateConfig({ ...base, plugins: [{ module: './p.mjs', isolation: 'tenant' }] })).toThrow(/isolation/);
    expect(() => validateConfig({ ...base, plugins: [{ module: './p.mjs', permissions: { network: false } }] })).toThrow(/isolated runtime/);
    expect(() => validateConfig({ ...base, plugins: [{ module: './p.mjs', limits: { memoryMb: 64 } }] })).toThrow(/worker or process/);
    expect(() => validateConfig({ ...base, plugins: [{ component: './p.wasm', limits: { memoryMb: 16, timeoutMs: 50 } }] })).not.toThrow();
    expect(() => validateConfig({ ...base, plugins: [{ module: './p.mjs', runtime: 'worker', isolation: 'process' }] })).toThrow(/disagree/);
    mkdirSync(join(d, 'sub'));
  }, 30000);
});

describe('X6 inside a running gateway', () => {
  let gw: Gateway | undefined;
  afterEach(async () => {
    await gw?.stop();
    gw = undefined;
  });

  it('a worker plugin that exits / loops / blows its heap never takes the gateway down', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
    const d = dir();
    write(d, 'hostile.mjs', `const keep = []; export default { name: 'hostile', apiVersion: 5, onToolCall: (c) => { const m = c.arguments.mode; if (m === 'exit') process.exit(9); if (m === 'loop') for (;;) {} if (m === 'oom') for (;;) keep.push(new Array(1e6).fill(1)); if (m === 'throw') setTimeout(() => { throw new Error('async'); }); } };`);
    gw = new Gateway({
      port: 0,
      host: '127.0.0.1',
      logLevel: 'error',
      monitor: { requestLog: false },
      auth: { strategy: 'api-key', apiKeys: [{ key: 'op-key', name: 'op' }] },
      servers: [{ id: 'fake', name: 'fake', transport: 'stdio', command: process.execPath, args: [fixture], timeout: 5000 }],
      configDir: d,
      plugins: [{ module: './hostile.mjs', runtime: 'worker', failure: 'closed', limits: { timeoutMs: 300, memoryMb: 32, maxFailures: 100 } }],
    } as GatewayConfig);
    await gw.start();
    const base = `http://127.0.0.1:${gw.address()!.port}`;
    const h = { authorization: 'Bearer op-key', 'content-type': 'application/json' };
    const callTool = (args: Record<string, unknown>) => fetch(`${base}/api/v1/tools/call`, { method: 'POST', headers: h, body: JSON.stringify({ tool: 'echo', arguments: args }) });
    for (const mode of ['exit', 'loop', 'oom', 'throw']) {
      const bad = await callTool({ mode });
      if (mode === 'throw') {
        // the hook itself returned; the runtime dies a tick later — the call already went through
        expect(bad.status, mode).toBe(200);
        await new Promise((r) => setTimeout(r, 100));
      } else {
        expect(bad.status, mode).toBe(403);
        expect(await bad.json()).toMatchObject({ code: -32006 });
      }
      expect((await fetch(`${base}/health`)).status, `health after ${mode}`).toBeLessThan(500);
      expect((await callTool({ mode: 'ok' })).status, `served after ${mode}`).toBe(200);
    }
    const st = (await (await fetch(`${base}/api/v1/plugins`, { headers: h })).json()) as { plugins: Array<Record<string, unknown>> };
    expect(st.plugins[0]).toMatchObject({ name: 'hostile', runtime: 'worker', circuit: 'closed' });
    expect(st.plugins[0].restarts).toBeGreaterThanOrEqual(4);
  }, 40000);
});
