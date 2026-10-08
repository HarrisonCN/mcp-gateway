/** 3.3: WASM plugin sandbox with per-tenant isolation (8.0: config entries are v5 components; core ABI only in code). */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'url';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WasmPlugin, loadWasmPlugin } from '../src/plugins/wasm.js';
import { loadConfig, validateConfig } from '../src/config/loader.js';
import { Gateway } from '../src/gateway/index.js';
import type { PluginCall } from '../src/plugins/index.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';
import * as W from './fixtures/wasm-plugins.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));

const plugins: WasmPlugin[] = [];
afterEach(async () => {
  for (const p of plugins.splice(0)) await p.close();
});
const plugin = (bytes: Uint8Array, extra: Partial<ConstructorParameters<typeof WasmPlugin>[0]> = {}) => {
  const p = new WasmPlugin({ name: 'p', bytes, ...extra });
  plugins.push(p);
  return p;
};
const call = (over: Partial<PluginCall> = {}): PluginCall => ({ serverId: 's', name: 't', kind: 'tool', method: 'tools/call', arguments: { a: 1 }, via: 'rest', state: new Map(), ...over });

describe('WasmPlugin', () => {
  it('maps the ABI outputs to plugin outcomes', async () => {
    expect(await plugin(W.rewriteWasm()).onToolCall(call())).toEqual({ arguments: { rewritten: true } });
    expect(await plugin(W.denyWasm()).onToolCall(call())).toEqual({ deny: 'blocked by wasm policy' });
    expect(await plugin(W.respondWasm()).onToolCall(call())).toEqual({ respond: { content: [{ type: 'text', text: 'from wasm' }] } });
    const r = await plugin(W.responseWasm()).onResponse(call(), { success: true, result: { x: 1 }, durationMs: 1 });
    expect(r).toMatchObject({ success: true, result: { content: [{ text: 'filtered by wasm' }] } });
    // on_response never turns a failure into a success.
    expect(await plugin(W.responseWasm()).onResponse(call(), { success: false, error: { code: 1, message: 'x' }, durationMs: 1 })).toBeUndefined();
    // A module without on_tool_call is a no-op for that hook.
    expect(await plugin(W.responseWasm()).onToolCall(call())).toBeUndefined();
  });

  it('isolates instances per tenant (default), per client, or shares one', async () => {
    const t = plugin(W.counterWasm());
    const n = async (p: WasmPlugin, c: Partial<PluginCall>) => ((await p.onToolCall(call(c))) as { arguments: { n: string } }).arguments.n;
    expect(await n(t, { tenant: 'acme', clientId: 'k1' })).toBe('1');
    expect(await n(t, { tenant: 'acme', clientId: 'k2' })).toBe('2');
    expect(await n(t, { tenant: 'globex', clientId: 'k3' })).toBe('1');
    expect(t.stats().map((s) => s.key).sort()).toEqual(['tenant:acme', 'tenant:globex']);
    const c = plugin(W.counterWasm(), { isolation: 'client' });
    expect(await n(c, { tenant: 'acme', clientId: 'k1' })).toBe('1');
    expect(await n(c, { tenant: 'acme', clientId: 'k2' })).toBe('1');
    const s = plugin(W.counterWasm(), { isolation: 'shared' });
    expect(await n(s, { tenant: 'a' })).toBe('1');
    expect(await n(s, { tenant: 'b' })).toBe('2');
  });

  it('fails closed on timeout, trap, memory limit and bad JSON, and recovers with a fresh sandbox', async () => {
    const loop = plugin(W.loopWasm(), { limits: { timeoutMs: 150 } });
    await expect(loop.onToolCall(call())).rejects.toThrow(/timed out after 150ms/);
    await expect(plugin(W.trapWasm()).onToolCall(call())).rejects.toThrow(/trapped/);
    await expect(plugin(W.badJsonWasm()).onToolCall(call())).rejects.toThrow(/invalid JSON/);
    const grow = plugin(W.growWasm(), { limits: { memoryMb: 2 } });
    await expect(grow.onToolCall(call())).rejects.toThrow(/memory limit/);
    // The killed sandbox is replaced on the next call (which fails the same way, but runs).
    await expect(grow.onToolCall(call())).rejects.toThrow(/memory limit/);
    expect(grow.stats()).toHaveLength(1);
    // A counter restarts from scratch after its sandbox died.
    const cnt = plugin(W.counterWasm(), { limits: { maxInstances: 1 } });
    await cnt.onToolCall(call({ tenant: 'a' }));
    await cnt.onToolCall(call({ tenant: 'b' })); // evicts a (maxInstances 1)
    expect(((await cnt.onToolCall(call({ tenant: 'a' }))) as { arguments: { n: string } }).arguments.n).toBe('1');
  });

  it('forwards env.log and rejects modules that are not plugins', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    await plugin(W.logWasm()).onToolCall(call());
    await vi.waitFor(() => expect(info.mock.calls.some((c) => String(c[0]).includes('hello from wasm'))).toBe(true));
    info.mockRestore();
    expect(() => new WasmPlugin({ name: 'x', bytes: new Uint8Array([0, 1, 2]) })).toThrow();
    const noHooks = W.wasmModule({ hooks: [] });
    expect(() => new WasmPlugin({ name: 'x', bytes: noHooks })).toThrow(/neither on_tool_call nor on_response/);
  });

  it('every WASM plugin is plugin API v5 (core ABI still accepted in code)', () => {
    expect(plugin(W.denyWasm()).apiVersion).toBe(5);
    expect(plugin(W.componentCounter(), { abi: 'component' }).apiVersion).toBe(5);
  });

  it('validates plugin entries', () => {
    expect(() => validateConfig({ servers: [], plugins: [{ component: './p.wasm', isolation: 'client', limits: { timeoutMs: 50 } }] })).not.toThrow();
    expect(() => validateConfig({ servers: [], plugins: [{ module: './a.js', component: './p.wasm' }] })).toThrow(/exactly one/);
    expect(() => validateConfig({ servers: [], plugins: [{ wasm: './p.wasm' }] })).toThrow(/plugins.0.wasm: removed in 8.0/);
    expect(() => validateConfig({ servers: [], plugins: [{ name: 'x' }] })).toThrow(/exactly one/);
    expect(() => validateConfig({ servers: [], plugins: [{ module: './a.js', isolation: 'tenant' }] })).toThrow(/WASM component plugins only/);
  });
});

describe('WASM plugins in the gateway', () => {
  let gw: Gateway | undefined;
  afterEach(async () => {
    await gw?.stop();
    gw = undefined;
  });

  it('loads component entries from the config file and isolates tenants end to end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpgw-wasm-'));
    writeFileSync(join(dir, 'counter.wasm'), W.componentCounter());
    writeFileSync(join(dir, 'legacy.wasm'), W.counterWasm());
    // Embedders may still load a core-ABI module in code; it reports plugin API v5 like every WASM plugin.
    const p = await loadWasmPlugin({ wasm: 'legacy.wasm' }, dir);
    expect(p.name).toBe('legacy');
    expect(p.apiVersion).toBe(5);
    await p.close();
    writeFileSync(
      join(dir, 'mcp-gateway.yml'),
      `servers:
  - { id: fake, name: fake, transport: stdio, command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(fixture)}] }
auth:
  strategy: api-key
  apiKeys: [{ name: a, key: key-a }, { name: b, key: key-b }, { name: ops, key: key-ops }]
tenants:
  - { id: acme, servers: ["*"], members: [{ client: "key:a", role: admin }] }
  - { id: globex, servers: ["*"], members: [{ client: "key:b", role: admin }] }
version: 8
plugins:
  - { component: counter.wasm }
`,
    );
    const cfg = await loadConfig(join(dir, 'mcp-gateway.yml'));
    gw = new Gateway({ ...cfg, port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false } } as GatewayConfig);
    await gw.start();
    const api = `http://127.0.0.1:${gw.address()!.port}/api/v1`;
    const callAs = async (key: string) => {
      const r = await fetch(`${api}/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ tool: 'echo', server: 'fake', arguments: {} }) });
      const body = (await r.json()) as any;
      return JSON.parse(body.result.content[0].text).n as string;
    };
    expect(await callAs('key-a')).toBe('1');
    expect(await callAs('key-a')).toBe('2');
    expect(await callAs('key-b')).toBe('1');
    // 3.3: GET /plugins (operators) lists the sandboxes.
    const list = (await (await fetch(`${api}/plugins`, { headers: { authorization: 'Bearer key-ops' } })).json()) as any;
    expect(list.plugins[0]).toMatchObject({ name: 'counter', kind: 'wasm', isolation: 'tenant', hooks: ['onToolCall', 'onResponse'] });
    expect(list.plugins[0].sandboxes.map((s: { key: string }) => s.key).sort()).toEqual(['tenant:acme', 'tenant:globex']);
    expect((await fetch(`${api}/plugins`, { headers: { authorization: 'Bearer key-a' } })).status).toBe(403);
  });
});
