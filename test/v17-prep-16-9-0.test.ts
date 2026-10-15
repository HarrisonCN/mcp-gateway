/**
 * 16.9.0-canary.0 (v17 preparation): every removal planned for 17.0.0 (docs/migrating-to-v17.md; proposal until the
 * 17.0 list is frozen in 17.0.0-rc.1) is announced one minor ahead, and plugin API v6 is available early so plugins
 * can move before 17.0:
 *
 *  P1 plugin API v6 loads on 16.9 (v5 still loads); the compatibility table says 16.9 loads v5 – v6.
 *  P2 a v6 plugin may only return `{ action }` outcomes: a v4-era shape (`{ deny }`, `{ respond }`, `{ arguments }`, a
 *     full response from onResponse) fails the hook (fail closed). A v5 plugin returning one still works, recorded as
 *     the runtime deprecation `v17.plugins.<name>.legacy-outcome`.
 *  P3 a v6 module plugin never runs inline (refused at load); v5 inline plugins keep working.
 *  P4 every loaded v5 module plugin is announced (`v17.plugins.<name>.api-v5`); a plugin with HTTP hooks
 *     (onRequest / routes — only possible inline) is announced (`v17.plugins.<name>.http-hooks`).
 *  P5 config: a schema v13 file with an inline module plugin (`allowInline`) lists `v17.plugins.<i>.inline`.
 *  P6 codemod: `migratePluginSource` (CLI `mcp-gateway plugin migrate --to v6 <file> [--in-place]`) bumps
 *     `apiVersion: 5` → 6, rewrites literal v4-era outcomes to `{ action }`, reports what needs a person; idempotent.
 *
 * 17.0.0-alpha.1 removed what 16.9 announced (test/v17-core-17-0-0.test.ts): the v5 / inline halves of P1–P5 now
 * assert the refusal instead of the 16.9 warning; the v6 halves and the codemod (P6) are unchanged.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFileSync, readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PluginHost, loadPlugin, PLUGIN_API_VERSION, PLUGIN_API_MIN_VERSION } from '../src/plugins/index.js';
import { pluginApiSupport, isPluginApiSupported } from '../src/plugins/compat.js';
import { migratePluginSource } from '../src/plugins/migrate-v6.js';
import { v17DeprecationsIn, V17_DEPRECATION_IDS } from '../src/config/v17-deprecations.js';
import { validateConfig } from '../src/config/loader.js';
import { resetDeprecations, runtimeDeprecations } from '../src/utils/deprecations.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const require = createRequire(import.meta.url);
const dir = () => mkdtempSync(join(tmpdir(), 'mgw-169-'));
const write = (d: string, f: string, src: string) => (writeFileSync(join(d, f), src), `./${f}`);
const call = (over: Record<string, unknown> = {}) => ({ serverId: 's', name: 't', kind: 'tool' as const, method: 'tools/call', arguments: { a: 1 }, via: 'rest' as const, state: new Map(), ...over });
const okResult = { success: true, result: { content: [{ type: 'text', text: 'up' }] }, serverId: 's', tool: 't', durationMs: 1 } as never;
const ids = () => runtimeDeprecations().map((d) => d.id).sort();

beforeEach(() => resetDeprecations());

describe('16.9.0 plugin API v6 (P1–P4)', () => {
  it('P1 v6 and v5 load; the table says 16.9 loads v5 – v6 and 17.0 v6 only', async () => {
    expect(PLUGIN_API_VERSION).toBe(6);
    expect(PLUGIN_API_MIN_VERSION).toBe(6); // 17.0.0-alpha.1: v6 only
    const d = dir();
    const v6 = await loadPlugin({ module: write(d, 'six.mjs', `export default { name: 'six', apiVersion: 6, onToolCall: () => ({ action: 'continue' }) };`), runtime: 'worker' } as never, d);
    expect(v6.apiVersion).toBe(6);
    await v6.close?.();
    const v7 = loadPlugin({ module: write(d, 'seven.mjs', `export default { name: 'seven', apiVersion: 7 };`), runtime: 'worker' } as never, d);
    await expect(v7).rejects.toThrow(/plugin API v7/);
    expect(pluginApiSupport('16.9.0')).toMatchObject({ min: 5, max: 6 });
    expect(pluginApiSupport('16.0.0')).toMatchObject({ min: 5, max: 5 });
    expect(isPluginApiSupported(6, '16.9.0')).toBe(true);
    expect(isPluginApiSupported(5, '17.0.0')).toBe(false);
  });

  it('P2 a v6 plugin returning a v4-era outcome fails the hook; a v5 one works and is recorded', async () => {
    const d = dir();
    const legacy = (name: string, v: number) => `export default { name: '${name}', apiVersion: ${v}, onToolCall: (c) => (c.arguments.deny ? { deny: 'nope' } : undefined), onResponse: () => ({ success: true, result: { content: [{ type: 'text', text: 'swapped' }] }, serverId: 's', tool: 't', durationMs: 1 }) };`;
    // 16.9: a v5 plugin's legacy shapes kept working (recorded); 17.0.0-alpha.1 refuses v5 (and inline) at load
    await expect(loadPlugin({ module: write(d, 'l5.mjs', legacy('l5', 5)), runtime: 'inline' } as never, d)).rejects.toThrow(/runtime: inline was removed in 17\.0/);
    await expect(loadPlugin({ module: write(d, 'l5w.mjs', legacy('l5w', 5)), runtime: 'worker' } as never, d)).rejects.toThrow(/plugin API v5, which was removed in 17\.0/);
    expect(ids()).toEqual([]);
    // worker v6: the same shapes fail closed
    const six = await loadPlugin({ module: write(d, 'l6.mjs', legacy('l6', 6)), runtime: 'worker' } as never, d);
    const h6 = new PluginHost();
    await h6.set([six]);
    await expect(h6.beforeCall(call({ arguments: { deny: true } }))).rejects.toThrow(/plugin API v6.*\{ action \}/);
    await expect(h6.afterCall(call(), okResult)).rejects.toThrow(/plugin API v6.*\{ action \}/);
    // v6 with { action } outcomes is fine
    const good = await loadPlugin({ module: write(d, 'g6.mjs', `export default { name: 'g6', apiVersion: 6, onToolCall: (c) => (c.arguments.deny ? { action: 'deny', reason: 'nope' } : { action: 'continue' }), onResponse: () => ({ action: 'replace', result: { content: [{ type: 'text', text: 'swapped' }] } }) };`), runtime: 'worker' } as never, d);
    const hg = new PluginHost();
    await hg.set([good]);
    expect(await hg.beforeCall(call({ arguments: { deny: true } }))).toEqual({ deny: 'nope', plugin: 'g6' });
    expect(JSON.stringify(await hg.afterCall(call(), okResult))).toContain('swapped');
    for (const p of [six, good]) await p.close?.();
  }, 30_000);

  it('P3 a v6 module plugin is refused inline; 17.0.0-alpha.1: so is a v5 one (no inline module plugins)', async () => {
    const d = dir();
    await expect(loadPlugin({ module: write(d, 'i6.mjs', `export default { name: 'i6', apiVersion: 6 };`), runtime: 'inline' } as never, d)).rejects.toThrow(/plugin API v6.*(worker|process)/);
    await expect(loadPlugin({ module: write(d, 'i5.mjs', `export default { name: 'i5', apiVersion: 5 };`), runtime: 'inline' } as never, d)).rejects.toThrow(/runtime: inline was removed in 17\.0/);
  });

  it('P4 16.9 announced v5 module plugins and HTTP hooks at load; 17.0.0-alpha.1 refuses them', async () => {
    const d = dir();
    await expect(loadPlugin({ module: write(d, 'w5.mjs', `export default { name: 'w5', apiVersion: 5, onToolCall: () => undefined };`), runtime: 'worker' } as never, d)).rejects.toThrow(/plugin API v5, which was removed in 17\.0.*plugin migrate --to v6/);
    await expect(loadPlugin({ module: write(d, 'h6.mjs', `export default { name: 'h6', apiVersion: 6, onRequest: (req, res, next) => next() };`), runtime: 'worker' } as never, d)).rejects.toThrow(/onRequest \/ routes.*cannot have HTTP hooks/);
    await loadPlugin({ module: write(d, 'w6.mjs', `export default { name: 'w6', apiVersion: 6 };`), runtime: 'worker' } as never, d).then((p) => p.close?.());
    expect(ids()).toEqual([]);
    // the deprecation texts stay available (v17-deprecations.ts) for the codemod / docs
    const { apiV5 } = await import('../src/config/v17-deprecations.js');
    expect(apiV5('w5').replacement).toMatch(/apiVersion: 6/);
    expect(apiV5('w5').message).toMatch(/plugin migrate --to v6/);
  });
});

describe('16.9.0 config deprecations (P5)', () => {
  it('P5 a v13 file with an inline module plugin lists v17.plugins.<i>.inline; worker plugins and v12 files do not (v16.* covers v12)', () => {
    const v13 = { version: 13, plugins: [{ name: 'a', module: './a.mjs', runtime: 'inline', allowInline: true }, { name: 'b', module: './b.mjs', runtime: 'worker' }, { name: 'w', component: './w.wasm' }] };
    const d = v17DeprecationsIn(v13);
    expect(d.map((x) => x.id)).toEqual(['v17.plugins.0.inline']);
    expect(d[0]).toMatchObject({ removedIn: '17.0.0' });
    expect(d[0]!.replacement).toMatch(/runtime: worker/);
    expect(v17DeprecationsIn({ version: 12, plugins: [{ name: 'a', module: './a.mjs', runtime: 'inline' }] })).toEqual([]);
    expect(v17DeprecationsIn(null)).toEqual([]);
    expect(V17_DEPRECATION_IDS).toEqual(expect.arrayContaining(['v17.plugins.<i>.inline', 'v17.plugins.<name>.api-v5', 'v17.plugins.<name>.legacy-outcome', 'v17.plugins.<name>.http-hooks']));
    // 17.0.0-alpha.1: the announced removal is an error now
    expect(() => validateConfig({ ...v13, servers: [] } as never)).toThrow(/plugins\.0: `runtime: inline`.*removed in 17\.0/);
  });
});

describe('16.9.0 codemod plugin API v5 → v6 (P6)', () => {
  const src = [
    "export default {",
    "  name: 'guard',",
    "  apiVersion: 5,",
    "  onToolCall(call) {",
    "    if (call.name === 'rm') return { deny: 'no rm' };",
    "    if (call.name === 'cached') return { respond: { content: [] } };",
    "    if (call.name === 'fix') return { arguments: { ...call.arguments, safe: true } };",
    "    return undefined;",
    "  },",
    "  onResponse: (call, result) => result,",
    "  onRequest: (req, res, next) => next(),",
    "};",
    "",
  ].join('\n');

  it('rewrites apiVersion and literal outcomes, reports what needs a person, and is idempotent', () => {
    const r = migratePluginSource(src);
    expect(r.output).toContain('apiVersion: 6,');
    expect(r.output).toContain("return { action: 'deny', reason: 'no rm' };");
    expect(r.output).toContain("return { action: 'respond', result: { content: [] } };");
    expect(r.output).toContain("return { action: 'rewrite', arguments: { ...call.arguments, safe: true } };");
    expect(r.changes.map((c) => c.kind).sort()).toEqual(['apiVersion', 'outcome', 'outcome', 'outcome']);
    expect(r.manual.map((m) => m.kind).sort()).toEqual(['http-hooks', 'onResponse']);
    const again = migratePluginSource(r.output);
    expect(again.output).toBe(r.output);
    expect(again.changes).toEqual([]);
    // nothing to do on a v6 plugin; a plugin without apiVersion is reported
    expect(migratePluginSource("export default { name: 'x', apiVersion: 6 };").changes).toEqual([]);
    expect(migratePluginSource("export default { name: 'x' };").manual.map((m) => m.kind)).toEqual(['apiVersion']);
  });

  it('CLI: plugin migrate --to v6 prints a dry run, --in-place writes the file with a backup', () => {
    const d = dir();
    const f = join(d, 'guard.mjs');
    writeFileSync(f, src);
    const TSX = join(require.resolve('tsx/package.json'), '..', 'dist', 'cli.mjs');
    const CLI = resolve(__dirname, '..', 'src', 'cli.ts');
    const run = (args: string[]) => spawnSync(process.execPath, [TSX, CLI, 'plugin', 'migrate', ...args], { encoding: 'utf8', env: { ...process.env, MCP_GATEWAY_PORT: '' } });
    const dry = run(['--to', 'v6', f]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("action: 'deny'");
    expect(dry.stdout).toMatch(/needs a person/i);
    expect(readFileSync(f, 'utf8')).toBe(src);
    const bad = run(['--to', 'v7', f]);
    expect(bad.status).toBe(1);
    const inPlace = run(['--to', 'v6', '--in-place', f]);
    expect(inPlace.status).toBe(0);
    expect(readFileSync(f, 'utf8')).toContain('apiVersion: 6,');
    expect(existsSync(`${f}.bak`)).toBe(true);
    expect(readFileSync(`${f}.bak`, 'utf8')).toBe(src);
  }, 30_000);
});
