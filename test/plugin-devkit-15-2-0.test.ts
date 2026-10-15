/**
 * 15.2.0-canary: plugin developer kit — `mcp-gateway plugin init` (a worker-runtime plugin template with declared
 * permissions and limits) and `mcp-gateway plugin doctor` (loads every module plugin of a config the way the gateway
 * does and checks its runtime, permissions, limits, hooks, options and signature against what the config declares).
 * Additive only: two new `plugin` subcommands (no new top-level command) and a new module `plugins/devkit`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import YAML from 'yaml';
import { scaffoldPlugin, doctorPlugins, PLUGIN_NAME_RE } from '../src/plugins/devkit.js';
import { loadPlugin, pluginRuntimeOf } from '../src/plugins/index.js';
import { validateConfig } from '../src/config/loader.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const require = createRequire(import.meta.url);
const TSX = join(require.resolve('tsx/package.json'), '..', 'dist', 'cli.mjs');
const CLI = resolve(__dirname, '..', 'src', 'cli.ts');
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'mgw-devkit-'));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const cli = (args: string[], cwd = tmp()) => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('MCP_GATEWAY_')) delete env[k];
  const r = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, env, encoding: 'utf-8', timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const write = (dir: string, files: Record<string, string>) => {
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
};
const configWith = (dir: string, plugins: unknown[], extra: Record<string, unknown> = {}) => {
  const file = join(dir, 'gateway.yaml');
  writeFileSync(file, YAML.stringify({ servers: [], plugins, ...extra }));
  return file;
};
const check = (r: any, id: string) => r.checks.find((c: any) => c.id === id);

describe('plugin init (15.2)', { timeout: 60_000 }, () => {
  it('P1 the template: a self-contained module plus a config entry that validates — worker runtime, narrow permissions, limits', () => {
    const s = scaffoldPlugin('pii-guard');
    expect(Object.keys(s.files).sort()).toEqual(['pii-guard.config.yaml', 'pii-guard.mjs', 'pii-guard.test.mjs']);
    const mod = s.files['pii-guard.mjs']!;
    expect(mod).not.toMatch(/from ['"](?!node:)/); // no imports except node: built-ins — signable as one file
    expect(mod).toContain('apiVersion: 6');
    const entry = YAML.parse(s.files['pii-guard.config.yaml']!).plugins[0];
    expect(entry).toMatchObject({ module: './pii-guard.mjs', runtime: 'worker', failure: 'closed', permissions: { args: 'read', response: 'read', hooks: ['onToolCall'], network: false, env: [] } });
    expect(entry.limits).toMatchObject({ timeoutMs: expect.any(Number), memoryMb: expect.any(Number), maxConcurrent: expect.any(Number) });
    expect(() => validateConfig({ servers: [], plugins: [entry] })).not.toThrow();
    expect(scaffoldPlugin('p2', { runtime: 'process' }).files['p2.config.yaml']).toContain('runtime: process');
  });

  it('P2 names are checked (no paths, no spaces)', () => {
    for (const bad of ['../x', 'a/b', 'Bad Name', '', '-x', 'x'.repeat(65)]) {
      expect(PLUGIN_NAME_RE.test(bad)).toBe(false);
      expect(() => scaffoldPlugin(bad)).toThrow();
    }
    for (const ok of ['pii-guard', 'audit_tap', 'p2']) expect(PLUGIN_NAME_RE.test(ok)).toBe(true);
  });

  it('P3 the scaffolded plugin loads in a worker and works as declared', async () => {
    const dir = tmp();
    const s = scaffoldPlugin('blocker');
    write(dir, s.files);
    const entry = { ...YAML.parse(s.files['blocker.config.yaml']!).plugins[0], options: { blockedTools: ['rm'] } };
    const p = await loadPlugin(entry, dir);
    try {
      expect(pluginRuntimeOf(p)).toBe('worker');
      const call = (name: string) => ({ serverId: 's', name, kind: 'tool', method: 'tools/call', arguments: {}, clientId: 'key:x', via: 'rest', state: new Map() }) as any;
      const denied = await p.onToolCall!(call('rm'), {} as any);
      expect(JSON.stringify(denied)).toMatch(/deny|reject|rm/);
      const ok = await p.onToolCall!(call('ls'), {} as any);
      expect(ok === undefined || (ok as any).action === 'continue' || JSON.stringify(ok) === '{}').toBe(true);
    } finally {
      await p.close?.();
    }
  });

  it('P4 CLI: plugin init writes the files, refuses to overwrite without --force, refuses a bad name', () => {
    const dir = tmp();
    const r = cli(['plugin', 'init', 'pii-guard', '-d', dir]);
    expect(r.code).toBe(0);
    for (const f of ['pii-guard.mjs', 'pii-guard.config.yaml', 'pii-guard.test.mjs']) expect(existsSync(join(dir, f))).toBe(true);
    expect(r.out).toMatch(/plugin doctor/);
    const again = cli(['plugin', 'init', 'pii-guard', '-d', dir]);
    expect(again.code).toBe(1);
    expect(again.err + again.out).toMatch(/exists|--force/);
    expect(cli(['plugin', 'init', 'pii-guard', '-d', dir, '--force']).code).toBe(0);
    expect(cli(['plugin', 'init', '../evil', '-d', dir]).code).toBe(1);
  });
});

describe('plugin doctor (15.2)', { timeout: 60_000 }, () => {
  it('D1 a freshly scaffolded plugin passes every check', async () => {
    const dir = tmp();
    const s = scaffoldPlugin('pii-guard');
    write(dir, s.files);
    const file = configWith(dir, YAML.parse(s.files['pii-guard.config.yaml']!).plugins);
    const r = await doctorPlugins(file);
    expect(r.ok).toBe(true);
    expect(r.plugins).toHaveLength(1);
    const p = r.plugins[0]!;
    expect(p).toMatchObject({ name: 'pii-guard', runtime: 'worker', apiVersion: 6, hooks: ['onToolCall'] });
    for (const id of ['config', 'load', 'runtime', 'api', 'hooks', 'network', 'limits', 'signature']) expect(check(p, id), id).toBeTruthy();
    expect(p.checks.filter((c: any) => c.status === 'fail')).toEqual([]);
    expect(check(p, 'runtime').status).toBe('pass');
    expect(check(p, 'network').status).toBe('pass');
    expect(check(p, 'hooks').status).toBe('pass');
  });

  it('D2 mismatches between the config and the plugin are reported', async () => {
    const dir = tmp();
    write(dir, {
      'both.mjs': "export default { name: 'both', apiVersion: 6, onToolCall() { return { action: 'continue' }; }, onResponse() { return { action: 'continue' }; } };",
      'boom.mjs': "throw new Error('kaboom at load');",
      'strict.mjs': "export default { name: 'strict', apiVersion: 6, configSchema: (o) => (typeof o.max === 'number' ? [] : ['max must be a number']), onToolCall() {} };",
    });
    const file = configWith(dir, [
      { module: './both.mjs', runtime: 'worker', permissions: { hooks: ['onToolCall', 'onError'] }, limits: { timeoutMs: 500 } },
      { module: './boom.mjs', runtime: 'worker' },
      { module: './strict.mjs', runtime: 'worker', options: { max: 'many' } }, // 17.0: inline is refused by the config (D4)
    ]);
    const r = await doctorPlugins(file);
    expect(r.ok).toBe(false);
    const [both, boom, strict] = r.plugins as any[];
    // declared-but-missing and implemented-but-undeclared hooks
    expect(check(both, 'hooks').status).toBe('warn');
    expect(check(both, 'hooks').detail).toMatch(/onError/);
    expect(check(both, 'hooks').detail).toMatch(/onResponse/);
    // no network declaration in an isolated runtime: unrestricted egress
    expect(check(both, 'network').status).toBe('warn');
    // a load failure fails the plugin, with the error
    expect(check(boom, 'load')).toMatchObject({ status: 'fail' });
    expect(check(boom, 'load').detail).toMatch(/kaboom/);
    // invalid options are a load failure; a worker runtime passes (17.0: inline no longer reaches the runtime check — D4)
    expect(check(strict, 'load').status).toBe('fail');
    expect(check(strict, 'load').detail).toMatch(/max must be a number/);
    expect(check(strict, 'runtime')).toMatchObject({ status: 'pass', detail: 'runtime: worker' });
  });

  it('D3 pluginTrust: an unsigned plugin fails when signatures are required, warns otherwise', async () => {
    const dir = tmp();
    const s = scaffoldPlugin('t1');
    write(dir, s.files);
    const plugins = YAML.parse(s.files['t1.config.yaml']!).plugins;
    const loose = await doctorPlugins(configWith(dir, plugins));
    expect(check(loose.plugins[0], 'signature').status).toBe('warn');
    const strict = await doctorPlugins(configWith(dir, plugins, { features: { pluginTrust: { requireSigned: true } } }));
    expect(strict.ok).toBe(false);
    expect(check(strict.plugins[0], 'signature').status).toBe('fail');
  });

  it('D4 an invalid config is one failed check; a config without module plugins is fine', async () => {
    const dir = tmp();
    const bad = join(dir, 'bad.yaml');
    writeFileSync(bad, YAML.stringify({ servers: [], plugins: [{ module: './x.mjs', runtime: 'worker', permissions: { network: true } }] }));
    const r = await doctorPlugins(bad);
    expect(r.ok).toBe(false);
    expect(r.config).toMatchObject({ status: 'fail' });
    expect(r.config.detail).toMatch(/permissions/);
    // 17.0.0-alpha.1: an inline module plugin is an invalid config (it was a runtime warning in 15.x / 16.x)
    const inline = join(dir, 'inline.yaml');
    writeFileSync(inline, YAML.stringify({ servers: [], plugins: [{ module: './x.mjs', runtime: 'inline' }] }));
    const ri = await doctorPlugins(inline);
    expect(ri.ok).toBe(false);
    expect(ri.config).toMatchObject({ status: 'fail' });
    expect(ri.config.detail).toMatch(/plugins\.0: `runtime: inline` .* was removed in 17\.0/);
    expect(ri.plugins).toEqual([]);
    const none = await doctorPlugins(configWith(dir, []));
    expect(none).toMatchObject({ ok: true, plugins: [] });
  });

  it('D5 CLI: plugin doctor exits 0 / 1 and prints JSON with --json', () => {
    const dir = tmp();
    expect(cli(['plugin', 'init', 'okp', '-d', dir]).code).toBe(0);
    const okFile = configWith(dir, YAML.parse(readFileSync(join(dir, 'okp.config.yaml'), 'utf8')).plugins);
    const ok = cli(['plugin', 'doctor', '-c', okFile, '--json'], dir);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toMatchObject({ ok: true });
    write(dir, { 'boom.mjs': "throw new Error('nope');" });
    const badFile = configWith(dir, [{ module: './boom.mjs', runtime: 'worker' }]);
    const bad = cli(['plugin', 'doctor', '-c', badFile], dir);
    expect(bad.code).toBe(1);
    expect(bad.out + bad.err).toMatch(/nope/);
  });

  it('D6 no new top-level command: init / doctor are plugin subcommands next to keygen / sign / verify', () => {
    const top = cli(['--help']);
    expect(top.out).not.toMatch(/^\s+doctor\b/m);
    const sub = cli(['plugin', '--help']);
    for (const c of ['keygen', 'sign', 'verify', 'init', 'doctor']) expect(sub.out).toMatch(new RegExp(`^\\s+${c}\\b`, 'm'));
  });
});
