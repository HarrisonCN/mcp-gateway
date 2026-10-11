/**
 * 14.3.0 插件安全运行时 — plugin security runtime (TESTS FIRST; written before the implementation).
 *
 * Config surface under test (JS module plugins; WASM keeps its own sandbox):
 *   plugins[].runtime: 'inline' (default, legacy) | 'worker' (worker_threads) | 'process' (child process)
 *   plugins[].limits: { timeoutMs, memoryMb, maxFailures, cooldownMs }        (worker / process only)
 *   plugins[].failure: 'closed' (default) | 'open'                             (what a crashed / timed-out hook does)
 *   plugins[].permissions: { args?: 'read'|'write', response?: 'read'|'write', secrets?: string[],
 *                            servers?: string[], tools?: string[], network?: false | string[] }
 *   pluginTrust.requireSigned + per-plugin signature (5.4) — verified on the exact bytes the runtime loads.
 *
 *  R1 a worker plugin that calls process.exit() / throws asynchronously never takes the gateway down
 *  R2 an infinite loop in a worker plugin is terminated after limits.timeoutMs; later calls are served
 *  R3 limits.memoryMb: a plugin exceeding its heap is killed; the gateway stays healthy
 *  R4 failure: closed refuses the call, failure: open lets it through (both audited as plugin failures)
 *  R5 circuit breaker: after limits.maxFailures the plugin is skipped/refused for cooldownMs; status in host.status()
 *  R6 permissions.args 'read': an argument rewrite is rejected (upstream gets the original args); 'write' allows it
 *  R7 permissions.secrets: ctx.secrets.get of a name outside the allow-list throws
 *  R8 permissions.servers / tools: the hook only runs for matching calls
 *  R9 signature is checked against the bytes loaded into the worker (a file swapped after verification is refused)
 *  R10 config validation: runtime / limits / permissions / failure (modules only; unknown keys refused)
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PluginHost, loadPlugin } from '../src/plugins/index.js';
import { generateSigningKey, signArtifact } from '../src/plugins/trust.js';
import { validateConfig } from '../src/config/loader.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const dir = () => mkdtempSync(join(tmpdir(), 'mgw-143-'));
const call = (over: Record<string, unknown> = {}) => ({ serverId: 's', name: 't', kind: 'tool' as const, method: 'tools/call', arguments: { a: 1 }, via: 'rest' as const, state: new Map(), ...over });
const write = (d: string, f: string, src: string) => (writeFileSync(join(d, f), src), `./${f}`);

describe('R1-R5 isolation and resource limits (runtime: worker)', () => {
  it('R1 process.exit() inside a worker plugin does not exit the gateway process', async () => {
    const d = dir();
    const m = write(d, 'exit.mjs', `export default { name: 'exit', apiVersion: 5, onToolCall: () => { process.exit(3); } };`);
    const p = await loadPlugin({ module: m, runtime: 'worker', failure: 'closed' } as never, d);
    const host = new PluginHost();
    await host.set([p]);
    const r = await host.beforeCall(call()).catch((e: Error) => ({ error: e.message }));
    expect(JSON.stringify(r)).toMatch(/plugin "exit" (crashed|exited)/i);
    expect(process.exitCode ?? 0).toBe(0);
    await host.close();
  });

  it('R2 an infinite loop is terminated after limits.timeoutMs and the next call is served', async () => {
    const d = dir();
    const m = write(d, 'loop.mjs', `let n = 0; export default { name: 'loop', apiVersion: 5, onToolCall: () => { if (n++ === 0) for (;;) {} return { action: 'continue' }; } };`);
    const p = await loadPlugin({ module: m, runtime: 'worker', limits: { timeoutMs: 100 } } as never, d);
    const host = new PluginHost();
    await host.set([p]);
    const t0 = Date.now();
    await expect(host.beforeCall(call())).rejects.toThrow(/timed out after 100 ms/);
    expect(Date.now() - t0).toBeLessThan(1500);
    // a fresh worker serves the next call (the looping one was terminated)
    await expect(host.beforeCall(call())).resolves.toBeUndefined();
    await host.close();
  });

  it('R3 limits.memoryMb kills a plugin that exceeds its heap', async () => {
    const d = dir();
    const m = write(d, 'mem.mjs', `const keep = []; export default { name: 'mem', apiVersion: 5, onToolCall: () => { for (;;) keep.push(new Array(1e6).fill(Math.random())); } };`);
    const p = await loadPlugin({ module: m, runtime: 'worker', limits: { memoryMb: 32, timeoutMs: 5000 } } as never, d);
    const host = new PluginHost();
    await host.set([p]);
    await expect(host.beforeCall(call())).rejects.toThrow(/memory/i);
    await host.close();
  }, 15000);

  it('R4 failure: open lets the call through after a crash; closed refuses it', async () => {
    const d = dir();
    const m = write(d, 'boom.mjs', `export default { name: 'boom', apiVersion: 5, onToolCall: () => { setTimeout(() => { throw new Error('async boom'); }); return new Promise(() => {}); } };`);
    const open = await loadPlugin({ module: m, name: 'boom-open', runtime: 'worker', failure: 'open', limits: { timeoutMs: 500 } } as never, d);
    const host = new PluginHost();
    await host.set([open]);
    await expect(host.beforeCall(call())).resolves.toBeUndefined();
    await host.close();
    const closed = await loadPlugin({ module: m, name: 'boom-closed', runtime: 'worker', failure: 'closed', limits: { timeoutMs: 500 } } as never, d);
    const h2 = new PluginHost();
    await h2.set([closed]);
    await expect(h2.beforeCall(call())).rejects.toThrow(/boom-closed/);
    await h2.close();
  });

  it('R5 circuit breaker opens after maxFailures and reports it', async () => {
    const d = dir();
    const m = write(d, 'flaky.mjs', `export default { name: 'flaky', apiVersion: 5, onToolCall: () => { throw new Error('nope'); } };`);
    const p = await loadPlugin({ module: m, runtime: 'worker', failure: 'open', limits: { maxFailures: 2, cooldownMs: 60000 } } as never, d);
    const host = new PluginHost();
    await host.set([p]);
    for (let i = 0; i < 3; i++) await host.beforeCall(call());
    const st = (host as unknown as { status(): Array<{ name: string; circuit: string; failures: number }> }).status();
    expect(st.find((s) => s.name === 'flaky')).toMatchObject({ circuit: 'open', failures: 2 });
    await host.close();
  });
});

describe('R6-R8 fine-grained permissions', () => {
  it('R6 args: read rejects an argument rewrite; write allows it', async () => {
    const d = dir();
    const m = write(d, 'rw.mjs', `export default { name: 'rw', apiVersion: 5, onToolCall: (c) => ({ action: 'continue', arguments: { ...c.arguments, a: 2 } }) };`);
    for (const [args, expected] of [['read', 1], ['write', 2]] as const) {
      const p = await loadPlugin({ module: m, runtime: 'worker', permissions: { args } } as never, d);
      const host = new PluginHost();
      await host.set([p]);
      const c = call();
      await host.beforeCall(c).catch(() => undefined);
      expect((c.arguments as { a: number }).a).toBe(expected);
      await host.close();
    }
  });

  it('R7 secrets outside permissions.secrets cannot be read', async () => {
    process.env.MGW143_A = 'a-val';
    process.env.MGW143_B = 'b-val';
    const d = dir();
    const m = write(d, 'sec.mjs', `export default { name: 'sec', apiVersion: 5, onToolCall: async (c, ctx) => { c.state.set('a', await ctx.secrets.get('A')); try { await ctx.secrets.get('B'); c.state.set('b', 'leaked'); } catch (e) { c.state.set('b', 'denied'); } return { action: 'continue' }; } };`);
    const p = await loadPlugin({ module: m, runtime: 'worker', secrets: { A: 'secret://env/MGW143_A', B: 'secret://env/MGW143_B' }, permissions: { secrets: ['A'] } } as never, d);
    const host = new PluginHost({ resolveSecret: async (ref) => process.env[ref.split('/').pop()!] ?? '' });
    await host.set([p]);
    const c = call();
    await host.beforeCall(c);
    expect(c.state.get('a')).toBe('a-val');
    expect(c.state.get('b')).toBe('denied');
    await host.close();
  });

  it('R8 permissions.servers / tools scope which calls the hook sees', async () => {
    const d = dir();
    const m = write(d, 'deny.mjs', `export default { name: 'deny', apiVersion: 5, onToolCall: () => ({ action: 'deny', reason: 'scoped' }) };`);
    const p = await loadPlugin({ module: m, runtime: 'worker', permissions: { servers: ['prod-*'], tools: ['write_*'] } } as never, d);
    const host = new PluginHost();
    await host.set([p]);
    expect(await host.beforeCall(call({ serverId: 'dev-db', name: 'write_x' }))).toBeUndefined();
    expect(await host.beforeCall(call({ serverId: 'prod-db', name: 'read_x' }))).toBeUndefined();
    expect(JSON.stringify(await host.beforeCall(call({ serverId: 'prod-db', name: 'write_x' })))).toMatch(/scoped/);
    await host.close();
  });
});

describe('R9-R10 supply chain and config', () => {
  it('R9 the signature covers the bytes the worker actually loads', async () => {
    const d = dir();
    const m = write(d, 'signed.mjs', `export default { name: 'signed', apiVersion: 5 };`);
    const key = generateSigningKey();
    writeFileSync(join(d, 'signed.mjs.sig'), JSON.stringify(signArtifact(readFileSync(join(d, 'signed.mjs')), key.privateKey, 'k1')));
    const trust = { requireSigned: true, keys: [{ id: 'k1', publicKey: key.publicKey }] };
    const p = await loadPlugin({ module: m, runtime: 'worker' } as never, d, trust as never);
    expect(p.name).toBe('signed');
    // swap the file after signing: refused
    writeFileSync(join(d, 'signed.mjs'), `export default { name: 'signed', apiVersion: 5, onToolCall: () => ({ action: 'continue' }) };`);
    await expect(loadPlugin({ module: m, runtime: 'worker' } as never, d, trust as never)).rejects.toThrow(/signature/i);
  });

  it('R10 config validation of the runtime block', () => {
    const base = { version: 12, servers: [] } as Record<string, unknown>;
    const ok = { module: './p.mjs', runtime: 'worker', failure: 'open', limits: { timeoutMs: 100, memoryMb: 64, maxFailures: 3, cooldownMs: 1000 }, permissions: { args: 'read', response: 'write', secrets: ['A'], servers: ['a-*'], tools: ['t'], network: false } };
    expect(() => validateConfig({ ...base, plugins: [ok] })).not.toThrow();
    expect(() => validateConfig({ ...base, plugins: [{ module: './p.mjs', runtime: 'vm' }] })).toThrow(/runtime/);
    expect(() => validateConfig({ ...base, plugins: [{ module: './p.mjs', permissions: { args: 'admin' } }] })).toThrow(/permissions/);
    expect(() => validateConfig({ ...base, plugins: [{ module: './p.mjs', permissions: { bogus: true } }] })).toThrow(/permissions/);
    expect(() => validateConfig({ ...base, plugins: [{ component: './p.wasm', runtime: 'worker' }] })).toThrow(/runtime/);
  });
});
