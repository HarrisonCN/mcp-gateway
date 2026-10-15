/**
 * 17.0.0-alpha.1 (breaking; npm `canary` only — docs/migrating-to-v17.md, proposal until 17.0.0-rc.1): the removals
 * announced by 16.9.0-canary.0 take effect.
 *
 *  K1 plugin API v6 only: `PLUGIN_API_MIN_VERSION` is 6; a v5 plugin (programmatic or module) is refused at load with
 *     the codemod hint; the compatibility table says 17.0 loads v6 only.
 *  K2 no inline module plugins: `runtime: inline` (with or without `allowInline`) is a config error, and so is a stray
 *     `allowInline`; `loadPlugin` refuses `runtime: inline`. Programmatic plugin objects (embedding API) still run.
 *  K3 every plugin is held to the v6 outcome contract: a v4-era shape (`{ deny }`, `{ respond }`, `{ arguments }`, a
 *     full response from onResponse) fails the hook (fail closed); `{ action }` outcomes work.
 *  K4 `version: 12` files are refused with the `config migrate --to v13` hint (v11 keeps its own message); the
 *     migration tooling still reads v12 (`validateV12ForMigration`, `config migrate --to v13`).
 *  K5 a file without `version:` is read as schema v13: the v13 rules apply and `schemaVersion` is 13; v11 fields in an
 *     unversioned file keep the v11 refusal.
 *  K6 the codemod targets 17.0: inline module plugins move to `runtime: worker` (reported, since a plugin with HTTP
 *     hooks needs a person), a 16.x v13 file with `allowInline` is rewritten, an unversioned file that is already
 *     valid v13 just gets `version: 13`; the result loads on 17.0.
 *  K7 the 17.0 config deprecations are gone (they are errors now): a valid v13 file reports no deprecations.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { PluginHost, loadPlugin, PLUGIN_API_VERSION, PLUGIN_API_MIN_VERSION } from '../src/plugins/index.js';
import { pluginApiSupport, isPluginApiSupported } from '../src/plugins/compat.js';
import { validateConfig, validateV12ForMigration } from '../src/config/loader.js';
import { planV13 } from '../src/config/v13-prep.js';
import { resetDeprecations } from '../src/utils/deprecations.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const require = createRequire(import.meta.url);
const dir = () => mkdtempSync(join(tmpdir(), 'mgw-1701-'));
const write = (d: string, f: string, src: string) => (writeFileSync(join(d, f), src), `./${f}`);
const call = (over: Record<string, unknown> = {}) => ({ serverId: 's', name: 't', kind: 'tool' as const, method: 'tools/call', arguments: { a: 1 }, via: 'rest' as const, state: new Map(), ...over });
const okResult = { success: true, result: { content: [{ type: 'text', text: 'up' }] }, serverId: 's', tool: 't', durationMs: 1 } as never;
const TSX = join(require.resolve('tsx/package.json'), '..', 'dist', 'cli.mjs');
const CLI = resolve(__dirname, '..', 'src', 'cli.ts');
const cli = (...args: string[]) => spawnSync(process.execPath, [TSX, CLI, ...args], { encoding: 'utf8', env: { ...process.env, MCP_GATEWAY_PORT: '' } });
const loads = (raw: unknown) => {
  try {
    validateConfig(raw as never);
    return 'ok';
  } catch (e) {
    return (e as Error).message;
  }
};

beforeEach(() => resetDeprecations());

describe('17.0.0-alpha.1 plugin API v6 only (K1–K3)', () => {
  it('K1 v5 plugins are refused with the codemod hint; v6 loads; the table says 17.0 = v6 only', async () => {
    expect(PLUGIN_API_VERSION).toBe(6);
    expect(PLUGIN_API_MIN_VERSION).toBe(6);
    await expect(PluginHost.build(undefined, [{ name: 'five', apiVersion: 5 }])).rejects.toThrow(/plugin API v5, which was removed in 17\.0.*plugin migrate --to v6/);
    const d = dir();
    await expect(loadPlugin({ module: write(d, 'w5.mjs', `export default { name: 'w5', apiVersion: 5 };`), runtime: 'worker' } as never, d)).rejects.toThrow(/plugin API v5, which was removed in 17\.0/);
    const six = await loadPlugin({ module: write(d, 'w6.mjs', `export default { name: 'w6', apiVersion: 6, onToolCall: () => ({ action: 'continue' }) };`), runtime: 'worker' } as never, d);
    expect(six.apiVersion).toBe(6);
    await six.close?.();
    const host = new PluginHost();
    await host.set(await PluginHost.build(undefined, [{ name: 'p6', apiVersion: 6 }]));
    await host.close();
    expect(pluginApiSupport('17.0.0')).toMatchObject({ min: 6, max: 6 });
    expect(isPluginApiSupported(5, '17.0.0')).toBe(false);
    expect(isPluginApiSupported(6, '17.0.0')).toBe(true);
    expect(pluginApiSupport('16.9.0')).toMatchObject({ min: 5, max: 6 }); // history row unchanged
  }, 30_000);

  it('K2 inline module plugins are refused in config and at load; programmatic plugins still run', async () => {
    const base = { version: 13, servers: [] };
    expect(loads({ ...base, plugins: [{ module: './a.mjs', runtime: 'inline', allowInline: true }] })).toMatch(/plugins\.0.*inline.*17\.0.*runtime: worker/s);
    expect(loads({ ...base, plugins: [{ module: './a.mjs', runtime: 'inline' }] })).toMatch(/plugins\.0.*inline.*17\.0/s);
    expect(loads({ ...base, plugins: [{ module: './a.mjs', runtime: 'worker', allowInline: false }] })).toMatch(/plugins\.0\.allowInline.*removed in 17\.0/s);
    expect(loads({ ...base, plugins: [{ module: './a.mjs', runtime: 'worker' }, { module: './b.mjs', runtime: 'process' }, { component: './w.wasm', isolation: 'tenant' }] })).toBe('ok');
    const d = dir();
    await expect(loadPlugin({ module: write(d, 'i6.mjs', `export default { name: 'i6', apiVersion: 6 };`), runtime: 'inline' } as never, d)).rejects.toThrow(/inline.*17\.0.*(worker|process)/);
    const seen: string[] = [];
    const host = new PluginHost();
    await host.set(await PluginHost.build(undefined, [{ name: 'embedded', apiVersion: 6, onToolCall: (c) => void seen.push(c.name) }]));
    await host.beforeCall(call());
    expect(seen).toEqual(['t']);
    await host.close();
  });

  it('K3 a v4-era outcome fails the hook for every plugin; { action } outcomes work', async () => {
    const host = new PluginHost();
    await host.set(await PluginHost.build(undefined, [
      { name: 'legacy', apiVersion: 6, onToolCall: (c) => (c.arguments.deny ? ({ deny: 'nope' } as never) : undefined), onResponse: () => okResult },
    ]));
    await expect(host.beforeCall(call({ arguments: { deny: true } }))).rejects.toThrow(/plugin API v6.*\{ action \}/);
    await expect(host.afterCall(call(), okResult)).rejects.toThrow(/plugin API v6.*\{ action \}/);
    const good = new PluginHost();
    await good.set(await PluginHost.build(undefined, [
      { name: 'good', apiVersion: 6, onToolCall: (c) => (c.arguments.deny ? { action: 'deny', reason: 'nope' } : { action: 'continue' }), onResponse: () => ({ action: 'replace', result: { content: [{ type: 'text', text: 'swapped' }] } }) },
    ]));
    expect(await good.beforeCall(call({ arguments: { deny: true } }))).toEqual({ deny: 'nope', plugin: 'good' });
    expect(JSON.stringify(await good.afterCall(call(), okResult))).toContain('swapped');
    await host.close();
    await good.close();
  });
});

describe('17.0.0-alpha.1 config schema v13 only (K4, K5, K7)', () => {
  it('K4 version: 12 is refused with the migrate hint; the migration tooling still reads v12', () => {
    const v12 = { version: 12, servers: [], plugins: [{ module: './a.mjs', isolation: 'worker' }] };
    expect(loads(v12)).toMatch(/version: config schema v12 is no longer read by 17\.0\.0.*config migrate --to v13 --in-place/s);
    expect(loads({ version: 11, servers: [] })).toMatch(/schema v11 is no longer read by 15\.0\.0/);
    const m = validateV12ForMigration(v12 as never) as unknown as { schemaVersion?: number; plugins: Array<{ runtime?: string; isolation?: string }> };
    expect(m.schemaVersion).toBe(12);
    expect(m.plugins[0]!.runtime ?? m.plugins[0]!.isolation).toBe('worker');
    const d = dir();
    const p = join(d, 'gw.yml');
    writeFileSync(p, 'version: 12\nservers: []\n');
    const v = cli('validate', '-c', p);
    expect(v.status).toBe(1);
    expect(v.stdout + v.stderr).toMatch(/config migrate --to v13/);
    const mig = cli('config', 'migrate', '--to', 'v13', '--in-place', '-c', p);
    expect(mig.status, mig.stderr).toBe(0);
    expect(parse(readFileSync(p, 'utf8')).version).toBe(13);
    expect(cli('validate', '-c', p).status).toBe(0);
  }, 60_000);

  it('K5 a file without version: is read as schema v13', () => {
    const c = validateConfig({ servers: [], plugins: [{ module: './a.mjs', runtime: 'worker' }] } as never) as unknown as { schemaVersion?: number };
    expect(c.schemaVersion).toBe(13);
    expect(loads({ servers: [], plugins: [{ module: './a.mjs', isolation: 'worker' }] })).toMatch(/plugins\.0\.isolation.*not part of config schema v13/s);
    expect(loads({ servers: [], mcp: { protocolVersions: ['2025-06-18', '2024-11-05'] } })).toMatch(/2024-11-05/);
    expect(loads({ servers: [], kernel: { modules: {} } })).toMatch(/schema v11 is no longer read/);
    expect(loads({})).toBe('ok');
  });

  it('K7 a valid v13 file has no deprecations (the 17.0 ones are errors now)', () => {
    const c = validateConfig({ version: 13, servers: [], plugins: [{ module: './a.mjs', runtime: 'worker' }] } as never) as unknown as { deprecations?: unknown[] };
    expect(c.deprecations).toBeUndefined();
  });
});

describe('17.0.0-alpha.1 codemod targets 17.0 (K6)', () => {
  it('K6 moves inline plugins to worker (reported), rewrites a 16.x allowInline file, versions an unversioned v13 file', () => {
    const v12 = 'version: 12\nservers: []\nplugins:\n  - module: ./a.mjs   # guard\n    isolation: inline\n  - module: ./b.mjs\n    runtime: worker\n';
    const r = planV13(v12, 'yaml');
    expect(r.ok, r.report.errors.join('\n')).toBe(true);
    expect(r.text).toContain('# guard');
    const out = parse(r.text);
    expect(out.version).toBe(13);
    expect(out.plugins.map((p: { runtime?: string }) => p.runtime)).toEqual(['worker', 'worker']);
    expect(out.plugins[0].allowInline).toBeUndefined();
    expect(r.changes).toContain('plugins[0]: runtime: inline → runtime: worker (17.0 runs module plugins only in a worker or a child process)');
    expect(r.pending.map((p) => p.id)).toEqual(expect.arrayContaining(['v17.plugins.0.inline']));
    expect(loads(out)).toBe('ok');
    // a 16.x v13 file with allowInline
    const v13 = 'version: 13\nservers: []\nplugins:\n  - module: ./a.mjs\n    runtime: inline\n    allowInline: true\n';
    const r13 = planV13(v13, 'yaml');
    expect(r13.ok, r13.report.errors.join('\n')).toBe(true);
    expect(parse(r13.text).plugins[0]).toEqual({ module: './a.mjs', runtime: 'worker' });
    expect(loads(parse(r13.text))).toBe('ok');
    expect(planV13(r13.text, 'yaml').changes).toEqual([]); // idempotent
    // an unversioned file that is already valid v13
    const un = planV13('servers: []\nplugins:\n  - module: ./a.mjs\n    runtime: process\n', 'yaml');
    expect(un.ok, un.report.errors.join('\n')).toBe(true);
    expect(parse(un.text)).toMatchObject({ version: 13, plugins: [{ module: './a.mjs', runtime: 'process' }] });
    // an unversioned 16.x file (read as v12 there) still migrates
    const un12 = planV13('servers: []\nplugins:\n  - module: ./a.mjs\n    isolation: worker\n', 'yaml');
    expect(un12.ok, un12.report.errors.join('\n')).toBe(true);
    expect(parse(un12.text)).toMatchObject({ version: 13, plugins: [{ module: './a.mjs', runtime: 'worker' }] });
  });
});
