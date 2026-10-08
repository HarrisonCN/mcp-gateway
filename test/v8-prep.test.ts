/** 7.9: 8.0 preparation — schema v8 preview, plugin API v5 (WIT outcomes, component ABI), deprecations, migrate --to 8. */
import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse } from 'yaml';
import { validateConfig, loadConfig } from '../src/config/loader.js';
import { migrateConfigText } from '../src/config/migrate.js';
import { configDeprecations, removedConfigKeys, runtimeDeprecations, resetDeprecations, DEPRECATIONS } from '../src/utils/deprecations.js';
import { WasmPlugin } from '../src/plugins/wasm.js';
import { PluginHost, PLUGIN_API_VERSION, normalizeToolCallOutcome, normalizeResponseOutcome, type PluginCall } from '../src/plugins/index.js';
import { Gateway } from '../src/gateway/index.js';
import type { GatewayConfig } from '../src/utils/types.js';
import { logger } from '../src/utils/logger.js';
import * as W from './fixtures/wasm-plugins.js';

logger.setLevel('error');
const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
const call = (over: Partial<PluginCall> = {}): PluginCall => ({ serverId: 's', name: 't', kind: 'tool', method: 'tools/call', arguments: { a: 1 }, via: 'rest', state: new Map(), ...over });
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

describe('8.0 preparation (7.9)', () => {
  it('deprecates schema v7, plugins[].wasm and plugin API v4; schema v8 preview', () => {
    expect(Object.values(DEPRECATIONS).map((d) => `${d.id}@${d.removedIn}`)).toEqual(['schema-v7@8.0.0', 'plugin-wasm-core@8.0.0', 'plugin-api-v4@8.0.0']);
    expect(configDeprecations({ version: 7, plugins: [{ module: './a.mjs' }, { wasm: './b.wasm' }] }).map((d) => `${d.id}:${d.detail}`)).toEqual(['schema-v7:version: 7', 'plugin-wasm-core:plugins.1.wasm']);
    expect(configDeprecations({ version: 8, plugins: [{ component: './b.wasm' }] })).toEqual([]);
    const v8 = validateConfig({ version: 8, servers: [], plugins: [{ component: './p.wasm', isolation: 'client' }] });
    expect(v8.version).toBe(8);
    expect(v8.deprecations).toBeUndefined();
    expect(() => validateConfig({ version: 8, servers: [], plugins: [{ wasm: './p.wasm' }] })).toThrow(/plugins.0.wasm: not part of config schema v8 — rebuild against wit\/mcp-gateway-plugin.wit and use `component`/);
    expect(() => validateConfig({ servers: [], plugins: [{ wasm: './a.wasm', component: './b.wasm' }] })).toThrow(/exactly one of "module", "component" or "wasm"/);
    expect(() => validateConfig({ servers: [], plugins: [{ module: './a.mjs', limits: { timeoutMs: 5 } }] })).toThrow(/apply to WASM plugins only/);
    expect(() => validateConfig({ version: 9, servers: [] })).toThrow(/7.9 reads `version: 7` or `version: 8`/);
    expect(removedConfigKeys({ version: 8 })).toEqual([]);
    expect(PLUGIN_API_VERSION).toBe(5);
  });

  it('plugin API v5 outcomes', () => {
    expect(normalizeToolCallOutcome({ action: 'continue' })).toBeUndefined();
    expect(normalizeToolCallOutcome({ action: 'rewrite', arguments: { b: 2 } })).toEqual({ arguments: { b: 2 } });
    expect(normalizeToolCallOutcome({ action: 'deny', reason: 'no' })).toEqual({ deny: 'no' });
    expect(normalizeToolCallOutcome({ action: 'deny' })).toEqual({ deny: 'denied by plugin' });
    expect(normalizeToolCallOutcome({ action: 'respond', result: { x: 1 } })).toEqual({ respond: { x: 1 } });
    expect(normalizeToolCallOutcome({ deny: 'v4' })).toEqual({ deny: 'v4' });
    expect(() => normalizeToolCallOutcome({ action: 'rewrite' })).toThrow(/arguments/);
    expect(() => normalizeToolCallOutcome({ action: 'explode' })).toThrow(/unknown outcome/);
    const ok = { success: true, result: { a: 1 }, durationMs: 1 };
    expect(normalizeResponseOutcome({ action: 'replace', result: { b: 2 } }, ok)).toEqual({ ...ok, result: { b: 2 } });
    expect(normalizeResponseOutcome({ action: 'continue' }, ok)).toBeUndefined();
    expect(normalizeResponseOutcome({ action: 'replace', result: 1 }, { success: false, durationMs: 1 })).toBeUndefined();
    expect(normalizeResponseOutcome(undefined, ok)).toBeUndefined();
  });

  it('component ABI: canonical option<string> returns, none, post-return, validation', async () => {
    const mk = (bytes: Uint8Array) => {
      const p = new WasmPlugin({ name: 'c', bytes, abi: 'component' });
      closers.push(() => p.close());
      return p;
    };
    expect(mk(W.componentModule('on_tool_call', '{"action":"rewrite","arguments":{"v5":true}}')).apiVersion).toBe(5);
    expect(await mk(W.componentModule('on_tool_call', '{"action":"rewrite","arguments":{"v5":true}}')).onToolCall(call())).toEqual({ arguments: { v5: true } });
    expect(await mk(W.componentModule('on_tool_call', '{"action":"deny","reason":"component says no"}', { post: true })).onToolCall(call())).toEqual({ deny: 'component says no' });
    expect(await mk(W.componentModule('on_tool_call', undefined)).onToolCall(call())).toBeUndefined();
    const r = await mk(W.componentModule('on_response', '{"action":"replace","result":{"content":[]}}')).onResponse(call(), { success: true, result: { x: 1 }, durationMs: 1 });
    expect(r).toMatchObject({ result: { content: [] } });
    // a core-ABI module is not a component, and a component binary must be unbundled first
    expect(() => new WasmPlugin({ name: 'x', bytes: W.denyWasm(), abi: 'component' })).toThrow(/must export "cabi_realloc"/);
    expect(() => new WasmPlugin({ name: 'x', bytes: new Uint8Array([0, 0x61, 0x73, 0x6d, 0x0d, 0, 1, 0]), abi: 'component' })).toThrow(/is a component binary/);
  });

  it('JS v4 plugins and core WASM plugins load with deprecation warnings; v5 does not warn', async () => {
    resetDeprecations();
    const host = new PluginHost();
    await host.set(await PluginHost.build(undefined, [{ name: 'v4', apiVersion: 4 }, { name: 'v5', apiVersion: 5, onToolCall: () => ({ action: 'deny', reason: 'v5 deny' }) as never }]));
    closers.push(() => host.close());
    expect(runtimeDeprecations().map((d) => `${d.id}:${d.detail}`)).toEqual(['plugin-api-v4:v4']);
    expect(await host.beforeCall(call())).toEqual({ deny: 'v5 deny', plugin: 'v5' });
  });

  it('gateway: a component plugin from the config file (schema v8) runs end to end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpgw-v8-'));
    writeFileSync(join(dir, 'policy.wasm'), W.componentModule('on_tool_call', '{"action":"respond","result":{"content":[{"type":"text","text":"from component"}]}}'));
    writeFileSync(join(dir, 'mcp-gateway.yml'), `version: 8\nservers:\n  - { id: fake, name: fake, transport: stdio, command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(fixture)}] }\nplugins:\n  - { component: policy.wasm, isolation: shared }\n`);
    const cfg = await loadConfig(join(dir, 'mcp-gateway.yml'));
    const gw = new Gateway({ ...cfg, port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false } } as GatewayConfig);
    await gw.start();
    closers.push(() => gw.stop());
    const r = await fetch(`http://127.0.0.1:${gw.address()!.port}/api/v1/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ server: 'fake', tool: 'echo', arguments: {} }) });
    expect(JSON.stringify(await r.json())).toContain('from component');
  });

  it('migrate --to 8 (default): version 8, notes for wasm and JS plugins, keeps comments', () => {
    const src = '# gw\nversion: 7\nplugins:\n  - { wasm: ./old.wasm, name: legacy }\n  - { module: ./p.mjs }\nservers: []\n';
    const r = migrateConfigText(src);
    expect(r.changes).toEqual(['version: 7 → 8']);
    expect(r.text).toContain('# gw');
    expect(r.notes.join('\n')).toMatch(/plugins\[0\] \(legacy\): core-ABI WASM plugins are not part of schema v8/);
    expect(r.notes.join('\n')).toMatch(/declare `apiVersion: 5`/);
    expect(parse(r.text).version).toBe(8);
    expect(migrateConfigText('version: 8\nservers: []\n').changed).toBe(false);
    expect(() => migrateConfigText('version: 8\n', 'yaml', 7)).toThrow(/already on schema v8/);
    const v6 = migrateConfigText('version: 6\nadmin: { configApi: true }\nservers: []\n');
    expect(v6.changes).toEqual(['version: 6 → 8', 'admin.configApi → controlPlane.configApi']);
    expect(readFileSync(new URL('../wit/mcp-gateway-plugin.wit', import.meta.url), 'utf8')).toContain('package mcp-gateway:plugin@5.0.0;');
  });
});
